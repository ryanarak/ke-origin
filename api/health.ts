// api/health.ts
//
// KE-Origin System Health Probe
// - Verifies configuration, Drive connectivity, embeddings index, and OpenAI embeddings.
// - Responds with a structured HealthResponse JSON object.
// - Read-only, safe, and suitable for monitoring + diagnostics.

import { config, isDev } from "../config/env";
import { pingDrive } from "../lib/driveClient";
import { loadIndex } from "../lib/indexStore";
import { embedText, embeddingModelInfo } from "../lib/embeddings";
import { zHealthResponse, type HealthResponse } from "../lib/schemas";

// ------------------------------
// Minimal request/response types
// ------------------------------
//
// We avoid importing @vercel/node so ts-node can run this file without extra deps.
// Vercel's real req/res objects are structurally compatible with these.

type HealthRequest = {
  method?: string;
};

type HealthResponseLike = {
  status(code: number): HealthResponseLike;
  json(body: unknown): void;
  setHeader(name: string, value: string): void;
};

// ------------------------------
// Local Types & Constants
// ------------------------------

/**
 * Overall health status.
 * Matches HealthResponse["status"] in lib/schemas.ts.
 */
type HealthStatusOverall = "ok" | "degraded" | "error";

/**
 * Component-level status for config, drive, and openai.
 * Matches zSystemHealthStatus: "ok" | "error" | "degraded".
 */
type CoreHealthStatus = "ok" | "error" | "degraded";

/**
 * Component-level status for the index.
 * Matches zIndexHealthStatus: "ok" | "empty" | "error".
 */
type IndexHealthStatus = "ok" | "empty" | "error";

// Toggle this if you ever want to disable the OpenAI check.
const ENABLE_OPENAI_CHECK = true;

/**
 * Simple dev-only logger to avoid sprinkling console.log everywhere.
 */
function logDev(...args: unknown[]) {
  if (!isDev) return;
  // eslint-disable-next-line no-console
  console.log("[Health]", ...args);
}

// ------------------------------
// Component Health Checks
// ------------------------------

/**
 * Config check.
 * If this file is executing, config has already been loaded and validated
 * at import-time (config/env.ts throws on misconfig).
 */
async function checkConfig(): Promise<CoreHealthStatus> {
  logDev("Config check:", {
    nodeEnv: config.env.nodeEnv,
    projectId: config.google.projectId,
  });

  // If misconfigured, we would never reach here because config/env.ts would throw.
  return "ok";
}

/**
 * Drive check using pingDrive() from lib/driveClient.
 * Confirms the service account can see the KE-Origin root / Index folder.
 */
async function checkDrive(): Promise<CoreHealthStatus> {
  try {
    logDev("Running Drive check via pingDrive...");
    const ok = await pingDrive();
    if (ok) {
      logDev("Drive check: ok");
      return "ok";
    }
    logDev("Drive check: pingDrive returned false (treating as error)");
    return "error";
  } catch (err) {
    logDev("Drive check failed:", (err as Error).message);
    return "error";
  }
}

/**
 * Index check using loadIndex() from lib/indexStore.
 * - If index loads and has records -> "ok"
 * - If index loads but records are empty -> "empty"
 * - If index load fails -> "error"
 */
async function checkIndex(): Promise<IndexHealthStatus> {
  try {
    logDev("Running index check via loadIndex...");
    const records = await loadIndex();
    const count = records.length;
    logDev("Index check: records count =", count);

    if (count > 0) {
      return "ok";
    }
    return "empty";
  } catch (err) {
    logDev("Index check failed:", (err as Error).message);
    return "error";
  }
}

/**
 * Optional OpenAI embeddings check using embedText().
 * Verifies that the embeddings model is reachable and functioning.
 */
async function checkOpenAI(): Promise<CoreHealthStatus> {
  if (!ENABLE_OPENAI_CHECK) {
    logDev("OpenAI check disabled via ENABLE_OPENAI_CHECK=false.");
    return "ok";
  }

  try {
    logDev(
      "Running OpenAI embeddings check...",
      "(model:",
      embeddingModelInfo.model,
      ")"
    );

    const vector = await embedText("KE-Origin health-check");
    logDev(
      "OpenAI check: got vector length=",
      vector.length,
      "model=",
      embeddingModelInfo.model
    );
    return "ok";
  } catch (err) {
    const e = err as Error;
    logDev("OpenAI check failed:", e.message);
    // For now we just treat it as a simple error; the aggregator will decide
    // whether this yields "degraded" or "error" overall.
    return "error";
  }
}

// ------------------------------
// Status Aggregation
// ------------------------------

/**
 * Determine the overall health status from component details.
 *
 * Rules:
 * - If config === "error" or drive === "error" or index === "error" -> "error"
 * - Else if openai === "error" or index === "empty" -> "degraded"
 * - Else -> "ok"
 */
function determineOverallStatus(details: HealthResponse["details"]): HealthStatusOverall {
  if (details.config === "error" || details.drive === "error" || details.index === "error") {
    return "error";
  }

  if (details.index === "empty" || details.openai === "error") {
    return "degraded";
  }

  return "ok";
}

// ------------------------------
// Main Handler
// ------------------------------

export default async function handler(
  req: HealthRequest,
  res: HealthResponseLike
): Promise<void> {
  // We’re health-only; allow GET and HEAD but still respond with JSON.
  if (req.method && !["GET", "HEAD"].includes(req.method.toUpperCase())) {
    res.setHeader("Allow", "GET, HEAD");
    res.status(405).json({
      status: "error",
      timestamp: new Date().toISOString(),
      details: {
        config: "ok",
        drive: "error",
        index: "error",
        openai: "error",
      },
    });
    return;
  }

  logDev("=== /api/health request received ===");

  // Defaults assume config is ok (since we got this far), others pessimistic.
  const details: HealthResponse["details"] = {
    config: "ok",
    drive: "error",
    index: "error",
    openai: "error",
  };

  try {
    // Run checks sequentially for clarity (parallelization is easy later).

    // 1) Config (import-time already validated).
    details.config = await checkConfig();

    // 2) Drive (root + Index folder).
    details.drive = await checkDrive();

    // 3) Index (embeddings-metadata.json).
    details.index = await checkIndex();

    // 4) OpenAI (embeddings).
    details.openai = await checkOpenAI();

    const overallStatus: HealthStatusOverall = determineOverallStatus(details);
    const response: HealthResponse = {
      status: overallStatus,
      timestamp: new Date().toISOString(),
      details,
    };

    // Optional: sanity-validate the outgoing shape with Zod.
    try {
      zHealthResponse.parse(response);
    } catch (validationErr) {
      logDev(
        "HealthResponse validation failed (this should not happen):",
        (validationErr as Error).message
      );
      // We still proceed, but this hints that schemas.ts and this endpoint are out of sync.
    }

    const httpStatus = overallStatus === "error" ? 500 : 200;

    logDev("Health summary:", {
      status: overallStatus,
      details,
      httpStatus,
      embeddingModel: embeddingModelInfo.model,
      nodeEnv: config.env.nodeEnv,
    });

    res.status(httpStatus).json(response);
  } catch (err) {
    // Absolute fallback: unexpected error in the handler itself.
    const e = err as Error;
    logDev("Unexpected /api/health handler error:", e.message);

    const fallback: HealthResponse = {
      status: "error",
      timestamp: new Date().toISOString(),
      details: {
        config: "ok", // we got this far, so config likely loaded
        drive: "error",
        index: "error",
        openai: "error",
      },
    };

    res.status(500).json(fallback);
  }
}

// ------------------------------
// Optional: CLI Self-Test
// ------------------------------
//
// Allows you to run this file directly with ts-node for a quick health snapshot:
//
//   npx ts-node api/health.ts
//
// This does NOT run in Vercel; it’s purely for local diagnostics.

if (require.main === module) {
  (async () => {
    // eslint-disable-next-line no-console
    console.log("=== KE-Origin /api/health CLI self-test ===");
    // eslint-disable-next-line no-console
    console.log("NODE_ENV:", config.env.nodeEnv);
    // eslint-disable-next-line no-console
    console.log("Project ID:", config.google.projectId);
    // eslint-disable-next-line no-console
    console.log("Embedding model:", embeddingModelInfo.model);

    const configStatus = await checkConfig();
    const driveStatus = await checkDrive();
    const indexStatus = await checkIndex();
    const openaiStatus = await checkOpenAI();

    const details: HealthResponse["details"] = {
      config: configStatus,
      drive: driveStatus,
      index: indexStatus,
      openai: openaiStatus,
    };

    const overall = determineOverallStatus(details);
    const payload: HealthResponse = {
      status: overall,
      timestamp: new Date().toISOString(),
      details,
    };

    // eslint-disable-next-line no-console
    console.log("Health payload:", JSON.stringify(payload, null, 2));

    if (overall === "error") {
      // eslint-disable-next-line no-console
      console.error("Health self-test: status=error (non-zero exit code).");
      process.exitCode = 1;
    } else {
      // eslint-disable-next-line no-console
      console.log("Health self-test: status=", overall);
    }
  })().catch((err) => {
    // eslint-disable-next-line no-console
    console.error("Health self-test crashed:", err);
    process.exitCode = 1;
  });
}
