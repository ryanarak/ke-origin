/**
 * scripts/test-health.ts
 *
 * KE-Origin CLI Truth Oracle — deterministic health probe for:
 * 1) config
 * 2) Drive connectivity + folder resolution
 * 3) index load / auto-heal
 * 4) OpenAI embeddings smoke test
 * 5) optional index write/read round trip (explicit flag)
 *
 * Exit codes:
 * 0 = ok
 * 2 = degraded
 * 1 = error
 */

type HealthStatus = "ok" | "degraded" | "error";

type CheckResult = {
  name: string;
  status: HealthStatus;
  ms: number;
  summary: string;
  details?: Record<string, unknown>;
  remediation?: string;
};

type HealthReport = {
  status: HealthStatus;
  startedAt: string;
  finishedAt: string;
  totalMs: number;
  checks: CheckResult[];
};

type CliOptions = {
  json: boolean;
  verbose: boolean;
  writeTest: boolean;
  noOpenAI: boolean;
  timeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 30_000;

/** -----------------------------
 * CLI parsing (minimal + safe)
 * ----------------------------- */
function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    json: false,
    verbose: false,
    writeTest: false,
    noOpenAI: false,
    timeoutMs: undefined,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") opts.json = true;
    else if (a === "--verbose") opts.verbose = true;
    else if (a === "--write-test") opts.writeTest = true;
    else if (a === "--no-openai") opts.noOpenAI = true;
    else if (a === "--timeout-ms") {
      const v = argv[i + 1];
      if (!v || Number.isNaN(Number(v))) {
        throw new Error("Invalid --timeout-ms value. Example: --timeout-ms 30000");
      }
      opts.timeoutMs = Number(v);
      i++;
    } else if (a === "--help" || a === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown arg: ${a}. Use --help for options.`);
    }
  }

  return opts;
}

function printHelp() {
  // Intentionally short and terminal-friendly.
  console.log(`
KE-Origin — test-health (CLI Truth Oracle)

Usage:
  npx ts-node scripts/test-health.ts [options]

Options:
  --json         Print machine-readable JSON report
  --verbose      Include more diagnostics + stack traces
  --write-test   Perform index write/read round trip (reversible)
  --no-openai    Skip OpenAI embedding check (offline / rate limit)
  --timeout-ms N Global timeout (default ${DEFAULT_TIMEOUT_MS})
  --help         Show help
`.trim());
}

/** -----------------------------
 * Utility: timers + formatting
 * ----------------------------- */
function nowIso(): string {
  return new Date().toISOString();
}

function msSince(start: bigint): number {
  const diff = process.hrtime.bigint() - start;
  return Number(diff / 1_000_000n);
}

function padRight(s: string, n: number): string {
  if (s.length >= n) return s;
  return s + " ".repeat(n - s.length);
}

function safeString(x: unknown): string {
  try {
    if (typeof x === "string") return x;
    return JSON.stringify(x);
  } catch {
    return String(x);
  }
}

/** -----------------------------
 * Utility: secret redaction
 * ----------------------------- */
function redactIfSecret(key: string, value: unknown): unknown {
  const k = key.toLowerCase();
  if (
    k.includes("key") ||
    k.includes("secret") ||
    k.includes("token") ||
    k.includes("private") ||
    k.includes("password")
  ) {
    return "[REDACTED]";
  }
  return value;
}

function deepRedact(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj;
  if (Array.isArray(obj)) return obj.map(deepRedact);
  if (typeof obj === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      out[k] = deepRedact(redactIfSecret(k, v));
    }
    return out;
  }
  return obj;
}

function summarizeConfigForPrint(config: any): Record<string, unknown> {
  // Defensive: treat config shape as unknown; only surface safe, high-signal fields.
  const env = config?.env ?? {};
  const openai = config?.openai ?? {};
  const drive = config?.drive ?? config?.keOrigin ?? {};
  const google = config?.google ?? {};

  const clientEmail =
    google?.serviceAccount?.client_email ||
    google?.serviceAccount?.clientEmail ||
    google?.clientEmail;

  const rootFolderId =
    drive?.rootFolderId || drive?.driveRootFolderId || config?.keOrigin?.driveRootFolderId;

  const sharedDriveId = drive?.sharedDriveId || drive?.driveSharedId || config?.drive?.sharedDriveId;

  const model = openai?.embeddingModel || openai?.model || openai?.embeddingsModel;

  return deepRedact({
    nodeEnv: env?.nodeEnv || env?.NODE_ENV || process.env.NODE_ENV || "unknown",
    openai: { model: model || "unknown", apiKey: "[REDACTED]" },
    drive: {
      rootFolderIdTail: typeof rootFolderId === "string" ? rootFolderId.slice(-6) : "unknown",
      sharedDriveIdTail: typeof sharedDriveId === "string" ? sharedDriveId.slice(-6) : undefined,
    },
    google: {
      serviceAccountEmail: typeof clientEmail === "string" ? clientEmail : "unknown",
    },
  }) as Record<string, unknown>;
}

/** -----------------------------
 * Orchestrator: run checks
 * ----------------------------- */
async function runCheck(
  name: string,
  fn: () => Promise<Omit<CheckResult, "name" | "ms">>,
  opts: CliOptions
): Promise<CheckResult> {
  const start = process.hrtime.bigint();
  try {
    const partial = await fn();
    return {
      name,
      ms: msSince(start),
      ...partial,
    };
  } catch (err: any) {
    const ms = msSince(start);
    const message = err?.message ? String(err.message) : "Unknown error";
    const result: CheckResult = {
      name,
      status: "error",
      ms,
      summary: message,
      remediation:
        "Re-run with --verbose for stack trace. Validate config/env.ts and permissions.",
      details: opts.verbose
        ? { stack: err?.stack ? String(err.stack) : undefined, raw: safeString(err) }
        : undefined,
    };
    return result;
  }
}

function computeOverallStatus(checks: CheckResult[]): HealthStatus {
  if (checks.some((c) => c.status === "error")) return "error";
  if (checks.some((c) => c.status === "degraded")) return "degraded";
  return "ok";
}

/** -----------------------------
 * Imports (mutation-ready)
 * We use dynamic imports and “duck typing” so small refactors
 * in module exports don’t break this script unnecessarily.
 * ----------------------------- */
async function loadModules() {
  const [{ config }, driveMod, indexMod, embMod] = await Promise.all([
    import("../config/env"),
    import("../lib/driveClient"),
    import("../lib/indexStore"),
    import("../lib/embeddings"),
  ]);

  const driveClient = (driveMod as any).driveClient ?? (driveMod as any).default ?? driveMod;
  const indexStore = (indexMod as any).indexStore ?? (indexMod as any).default ?? indexMod;
  const embeddings = (embMod as any).embeddings ?? (embMod as any).default ?? embMod;

  return { config, driveClient, indexStore, embeddings };
}

/** -----------------------------
 * Checks
 * ----------------------------- */
async function checkConfig(mods: Awaited<ReturnType<typeof loadModules>>, opts: CliOptions) {
  // If config/env.ts is invalid, importing it typically throws before we get here.
  const safeSummary = summarizeConfigForPrint(mods.config);

  return {
    status: "ok" as const,
    summary: "Config loaded and validated (sanitized output)",
    details: opts.verbose ? safeSummary : undefined,
    remediation: undefined,
  };
}

async function checkDrive(mods: Awaited<ReturnType<typeof loadModules>>) {
  const dc: any = mods.driveClient;

  // Prefer a dedicated ping, otherwise attempt a lightweight read/resolve.
  if (typeof dc.pingDrive === "function") {
    const res = await dc.pingDrive();
    return {
      status: "ok" as const,
      summary: "Drive ping OK",
      details: res && typeof res === "object" ? deepRedact(res) as Record<string, unknown> : undefined,
    };
  }

  // Fallback: attempt folder resolution if exposed
  if (typeof dc.resolveOrCreateKeOriginFolders === "function") {
    const folders = await dc.resolveOrCreateKeOriginFolders();
    return {
      status: "ok" as const,
      summary: "Drive folders resolved/created",
      details: folders && typeof folders === "object" ? deepRedact(folders) as Record<string, unknown> : undefined,
      remediation: undefined,
    };
  }

  return {
    status: "degraded" as const,
    summary: "Drive client loaded, but no pingDrive()/folder resolver found",
    remediation:
      "Expose driveClient.pingDrive() (recommended) or a folder resolver from lib/driveClient.ts for stronger checks.",
    details: { exportedKeys: Object.keys(dc ?? {}) },
  };
}

async function checkIndexLoad(mods: Awaited<ReturnType<typeof loadModules>>) {
  const is: any = mods.indexStore;

  if (typeof is.loadIndex === "function") {
    const records = await is.loadIndex();
    const count = Array.isArray(records) ? records.length : undefined;

    if (count === 0) {
      return {
        status: "degraded" as const,
        summary: "Index loaded (empty) — degraded is normal on fresh install",
        details: { recordCount: count },
        remediation: "Create a node or run scripts/rebuild-index.ts to populate the index.",
      };
    }

    return {
      status: "ok" as const,
      summary: "Index loaded",
      details: { recordCount: count },
      remediation: undefined,
    };
  }

  return {
    status: "error" as const,
    summary: "indexStore.loadIndex() not found",
    remediation: "Ensure lib/indexStore.ts exports loadIndex().",
    details: { exportedKeys: Object.keys(is ?? {}) },
  };
}

async function checkOpenAIEmbeddings(mods: Awaited<ReturnType<typeof loadModules>>) {
  const e: any = mods.embeddings;
  const embedFn =
    (typeof e.embedText === "function" && e.embedText.bind(e)) ||
    (typeof e.embed === "function" && e.embed.bind(e)) ||
    null;

  if (!embedFn) {
    return {
      status: "error" as const,
      summary: "No embedText()/embed() function found in lib/embeddings.ts",
      remediation: "Export embedText(text: string): Promise<number[]> from lib/embeddings.ts.",
      details: { exportedKeys: Object.keys(e ?? {}) },
    };
  }

  const vec: unknown = await embedFn("hello");
  if (!Array.isArray(vec)) {
    return {
      status: "error" as const,
      summary: "Embedding result is not an array",
      remediation: "Ensure embeddings wrapper returns number[].",
    };
  }

  const length = vec.length;
  const allFinite = vec.every((n) => typeof n === "number" && Number.isFinite(n));

  if (!allFinite) {
    return {
      status: "error" as const,
      summary: "Embedding vector contains non-finite values (NaN/Infinity)",
      remediation: "Inspect embedding response parsing; ensure numeric conversion is correct.",
      details: { length },
    };
  }

  // MVP expectation (text-embedding-3-small) is 1536, but we won't hard fail on change.
  const expected = 1536;
  const status: HealthStatus = length === expected ? "ok" : "degraded";

  return {
    status,
    summary:
      status === "ok"
        ? `OpenAI embeddings OK (vector length ${length})`
        : `OpenAI embeddings OK but unexpected vector length ${length} (expected ${expected})`,
    remediation:
      status === "degraded"
        ? "If you changed embedding model, update expectations where relevant (index rebuild, tests)."
        : undefined,
    details: { length },
  };
}

function makeTempEmbeddingRecord() {
  const id = `healthcheck-temp-${Date.now()}`;
  const createdAt = nowIso();
  // Minimal meta shape; your real schema may include more.
  return {
    id,
    schemaVersion: 1,
    sourceType: "healthcheck",
    sourceId: id,
    vector: [0, 0, 0], // placeholder if needed; many stores require length match—script may override below
    createdAt,
    meta: {
      model: "healthcheck",
      nodeType: "healthcheck",
      sourceRef: "healthcheck-temp.json",
    },
  };
}

async function checkIndexRoundTrip(
  mods: Awaited<ReturnType<typeof loadModules>>,
  opts: CliOptions
) {
  if (!opts.writeTest) {
    return {
      status: "ok" as const,
      summary: "Index round-trip skipped (enable with --write-test)",
      details: undefined,
      remediation: undefined,
    };
  }

  const is: any = mods.indexStore;
  const e: any = mods.embeddings;

  const embedFn =
    (typeof e.embedText === "function" && e.embedText.bind(e)) ||
    (typeof e.embed === "function" && e.embed.bind(e)) ||
    null;

  if (!embedFn) {
    return {
      status: "error" as const,
      summary: "Cannot run write-test: embeddings function not found",
      remediation: "Export embedText() from lib/embeddings.ts.",
    };
  }

  // Try to use indexStore's canonical method.
  const addFn =
    (typeof is.addEmbedding === "function" && is.addEmbedding.bind(is)) ||
    (typeof is.addOrReplaceEmbedding === "function" && is.addOrReplaceEmbedding.bind(is)) ||
    (typeof is.upsertEmbedding === "function" && is.upsertEmbedding.bind(is)) ||
    null;

  const saveFn = typeof is.saveIndex === "function" ? is.saveIndex.bind(is) : null;
  const loadFn = typeof is.loadIndex === "function" ? is.loadIndex.bind(is) : null;

  if (!loadFn) {
    return {
      status: "error" as const,
      summary: "Cannot run write-test: indexStore.loadIndex() not found",
      remediation: "Ensure lib/indexStore.ts exports loadIndex().",
    };
  }

  const before = await loadFn();
  const beforeCount = Array.isArray(before) ? before.length : 0;

  // Build a temp record that matches vector length for your active embedding model.
  const vec = await embedFn("healthcheck round trip");
  const record = makeTempEmbeddingRecord();
  (record as any).vector = vec;

  // Step 1: add
  if (addFn) {
    await addFn(record);
  } else if (saveFn && Array.isArray(before)) {
    // Fallback: append and save entire index if supported
    await saveFn([...before, record]);
  } else {
    return {
      status: "degraded" as const,
      summary: "Index write-test not supported by current indexStore exports",
      remediation:
        "Expose addEmbedding()/upsertEmbedding() or saveIndex() to enable full write/read round-trip.",
      details: { exportedKeys: Object.keys(is ?? {}) },
    };
  }

  // Step 2: reload and confirm presence
  const mid = await loadFn();
  const midCount = Array.isArray(mid) ? mid.length : undefined;
  const found = Array.isArray(mid) && mid.some((r: any) => r?.id === (record as any).id);

  if (!found) {
    return {
      status: "error" as const,
      summary: "Index write-test failed: temp record not found after reload",
      remediation: "Inspect indexStore persistence to Drive (Index/embeddings-metadata.json).",
      details: { beforeCount, afterCount: midCount, tempId: (record as any).id },
    };
  }

  // Step 3: cleanup (best effort)
  if (saveFn && Array.isArray(mid)) {
    const cleaned = mid.filter((r: any) => r?.id !== (record as any).id);
    await saveFn(cleaned);
    const after = await loadFn();
    const afterCount = Array.isArray(after) ? after.length : undefined;

    return {
      status: "ok" as const,
      summary: "Index write/read round-trip OK (temp record added and cleaned)",
      details: { beforeCount, midCount, afterCount, tempId: (record as any).id },
      remediation: undefined,
    };
  }

  // If we can’t cleanup due to missing saveIndex, we degrade (no silent pollution).
  return {
    status: "degraded" as const,
    summary: "Index write/read OK but cleanup not supported (temp record may remain)",
    remediation:
      "Expose indexStore.saveIndex() to enable cleanup, or run scripts/rebuild-index.ts to remove temp record.",
    details: { tempId: (record as any).id },
  };
}

/** -----------------------------
 * Timeout guard
 * ----------------------------- */
function withTimeout<T>(p: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let t: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, rej) => {
    t = setTimeout(() => rej(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([p, timeout]).finally(() => {
    if (t) clearTimeout(t);
  }) as Promise<T>;
}

/** -----------------------------
 * Reporting
 * ----------------------------- */
function printHuman(report: HealthReport) {
  const nameWidth = Math.max(...report.checks.map((c) => c.name.length), 10) + 2;

  const symbol = (s: HealthStatus) => (s === "ok" ? "OK" : s === "degraded" ? "DEGRADED" : "ERROR");

  console.log("");
  console.log(`KE-Origin Health Report — ${report.status.toUpperCase()}`);
  console.log(`Started: ${report.startedAt}`);
  console.log(`Finished: ${report.finishedAt}`);
  console.log(`Total: ${report.totalMs}ms`);
  console.log("");

  for (const c of report.checks) {
    const line =
      `[${symbol(c.status)}] ` +
      padRight(c.name, nameWidth) +
      ` ${c.summary} (${c.ms}ms)`;
    console.log(line);
    if (c.remediation) console.log(`  ↳ Fix: ${c.remediation}`);
  }

  console.log("");
  console.log("Exit codes: 0=ok, 2=degraded, 1=error");
  console.log("");
}

async function main() {
  const startedAt = nowIso();
  const start = process.hrtime.bigint();

  let opts: CliOptions;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err: any) {
    console.error(`[ERROR] ${err?.message || String(err)}`);
    printHelp();
    process.exit(1);
    return;
  }

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const checks: CheckResult[] = [];

  // Load modules under timeout, because config/env.ts may fail-fast.
  const mods = await withTimeout(loadModules(), timeoutMs, "Module loading");

  // Check 1: Config
  checks.push(
    await runCheck(
      "Config",
      async () => await checkConfig(mods, opts),
      opts
    )
  );

  // Print sanitized config summary in non-JSON mode (always safe).
  if (!opts.json) {
    const safeCfg = summarizeConfigForPrint(mods.config);
    console.log("Config (sanitized):", safeCfg);
  }

  // Check 2: Drive
  checks.push(
    await runCheck(
      "Drive",
      async () => await checkDrive(mods),
      opts
    )
  );

  // Check 3: Index
  checks.push(
    await runCheck(
      "Index",
      async () => await checkIndexLoad(mods),
      opts
    )
  );

  // Check 4: OpenAI
  if (opts.noOpenAI) {
    checks.push({
      name: "OpenAI Embeddings",
      status: "degraded",
      ms: 0,
      summary: "Skipped (--no-openai)",
      remediation: "Remove --no-openai to validate OpenAI connectivity and embedding correctness.",
    });
  } else {
    checks.push(
      await runCheck(
        "OpenAI Embeddings",
        async () => await checkOpenAIEmbeddings(mods),
        opts
      )
    );
  }

  // Check 5: Optional round-trip
  checks.push(
    await runCheck(
      "Index Round Trip",
      async () => await checkIndexRoundTrip(mods, opts),
      opts
    )
  );

  const finishedAt = nowIso();
  const report: HealthReport = {
    status: computeOverallStatus(checks),
    startedAt,
    finishedAt,
    totalMs: msSince(start),
    checks,
  };

  // Output
  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printHuman(report);
  }

  // Exit code contract
  if (report.status === "ok") process.exitCode = 0;
  else if (report.status === "degraded") process.exitCode = 2;
  else process.exitCode = 1;
}

// Entrypoint (guard)
main().catch((err: any) => {
  console.error("[FATAL] Unhandled error in test-health.ts");
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
