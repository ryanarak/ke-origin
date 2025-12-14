// api/retrieve-knowledge.ts
//
// KE-Origin Semantic Retrieval Endpoint
// - Auth-gated via KEORIGIN_SHARED_SECRET
// - Validates input (query required, topK optional)
// - embedText(query) -> queryVector
// - indexStore.search(queryVector, topK) -> top hits
// - Hydrates KnowledgeNodes from Drive using EmbeddingRecord.meta.sourceRef (filename)
// - Returns ranked results WITHOUT vectors
//
// Placement:
//   KE-Origin/
//     api/
//       retrieve-knowledge.ts

import { z } from "zod";
import { config, isDev } from "../config/env";
import { nowIso } from "../lib/utils";
import { embedText, embeddingModelInfo } from "../lib/embeddings";
import { search } from "../lib/indexStore";
import { readJson } from "../lib/driveClient";

// Adjust these imports if your schemas export names differ.
import type { EmbeddingRecord, KnowledgeNode } from "../lib/schemas";
import { zKnowledgeNode } from "../lib/schemas";

/**
 * Request schema (MVP)
 */
const zRetrieveKnowledgeRequest = z.object({
  query: z.string().min(1, "query is required"),
  topK: z.number().int().min(1).max(20).optional(),
});

/**
 * Response shaping (MVP)
 */
type RetrieveKnowledgeStatus = "ok" | "degraded";

export type RetrieveKnowledgeResult = {
  score: number;
  sourceType: EmbeddingRecord["sourceType"] | string;
  sourceId: string;
  node?: KnowledgeNode;
  ref?: {
    filename?: string;
  };
};

export type RetrieveKnowledgeResponse = {
  status: RetrieveKnowledgeStatus;
  timestamp: string;
  query: string;
  topK: number;
  results: RetrieveKnowledgeResult[];
  warnings?: string[];
};

/**
 * Minimal "req/res" typing to avoid @vercel/node dependency.
 */
type AnyReq = {
  method?: string;
  headers?: Record<string, unknown>;
  body?: unknown;
  on?: (event: string, cb: (chunk: any) => void) => void;
};

type AnyRes = {
  statusCode?: number;
  setHeader?: (name: string, value: string) => void;
  end?: (body?: any) => void;

  // Express-like / Vercel-like
  status?: (code: number) => AnyRes;
  json?: (payload: unknown) => void;
};

/**
 * Read header value safely (string | undefined).
 */
function getHeader(req: AnyReq, name: string): string | undefined {
  const headers = (req.headers ?? {}) as Record<string, unknown>;
  const raw = headers[name] ?? headers[name.toLowerCase()];
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw) && typeof raw[0] === "string") return raw[0];
  return undefined;
}

/**
 * Parse JSON body for runtimes that don't pre-parse req.body.
 */
async function parseJsonBody(req: AnyReq): Promise<unknown> {
  if (typeof req.body !== "undefined") return req.body;
  if (typeof req.on !== "function") return undefined;

  const chunks: Buffer[] = [];
  return await new Promise((resolve, reject) => {
    try {
      req.on!("data", (c: Buffer) => chunks.push(Buffer.from(c)));
      req.on!("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8").trim();
        if (!raw) return resolve(undefined);
        try {
          resolve(JSON.parse(raw));
        } catch (err) {
          reject(err);
        }
      });
      req.on!("error", reject);
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Respond helper that works in multiple runtimes.
 * (Patched to satisfy TS strictness.)
 */
function sendJson(res: AnyRes, statusCode: number, payload: unknown): void {
  const statusFn = res.status;
  const jsonFn = res.json;

  // Express/Vercel style: res.status(200).json(payload)
  if (typeof statusFn === "function" && typeof jsonFn === "function") {
    const chained = statusFn.call(res, statusCode);
    // Some runtimes return res, some return a wrapper; we still prefer the known jsonFn.
    jsonFn.call(chained ?? res, payload);
    return;
  }

  // If there's a json() but no status(), set statusCode then json()
  if (typeof jsonFn === "function") {
    res.statusCode = statusCode;
    jsonFn.call(res, payload);
    return;
  }

  // Raw Node response fallback
  if (typeof res.setHeader === "function") {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
  }
  res.statusCode = statusCode;
  if (typeof res.end === "function") {
    res.end(JSON.stringify(payload, null, 2));
  }
}

/**
 * Auth check using shared secret.
 */
function assertAuthorized(req: AnyReq): void {
  const provided = getHeader(req, "x-keorigin-secret");
  if (!provided || provided !== config.keOrigin.sharedSecret) {
    throw new Error("unauthorized");
  }
}

/**
 * Clamp topK to safe range.
 */
function normalizeTopK(topK?: number): number {
  const value = typeof topK === "number" ? topK : 5;
  return Math.max(1, Math.min(20, value));
}

/**
 * Hydrate a KnowledgeNode for a search hit (MVP: uses meta.sourceRef filename).
 */
async function hydrateKnowledgeNode(
  record: EmbeddingRecord
): Promise<{ node?: KnowledgeNode; filename?: string; warning?: string }> {
  if (record.sourceType !== "knowledgeNode") return {};

  const filename = record.meta?.sourceRef;
  if (!filename || typeof filename !== "string") {
    return {
      warning:
        `Missing meta.sourceRef (filename) for knowledgeNode sourceId=${record.sourceId}. ` +
        `Hydration skipped.`,
    };
  }

  try {
    const raw = await readJson<unknown>("knowledgeNodes", filename);
    const parsed = zKnowledgeNode.safeParse(raw);
    if (!parsed.success) {
      return {
        filename,
        warning:
          `Failed to validate KnowledgeNode JSON for filename=${filename}. ` +
          `Hydration skipped.`,
      };
    }
    return { node: parsed.data, filename };
  } catch (err) {
    return {
      filename,
      warning:
        `Failed to read KnowledgeNode from Drive filename=${filename}: ` +
        `${(err as Error).message}`,
    };
  }
}

/**
 * Core retrieval logic (shared by HTTP handler + CLI self-test).
 */
export async function retrieveKnowledgeInternal(input: {
  query: string;
  topK?: number;
}): Promise<RetrieveKnowledgeResponse> {
  const startedAt = Date.now();
  const warnings: string[] = [];

  const query = input.query.trim();
  const topK = normalizeTopK(input.topK);

  if (isDev) {
    console.log(
      `[RetrieveKnowledge] start: queryLen=${query.length} topK=${topK} model=${embeddingModelInfo.model}`
    );
  }

  // 1) Embed query (degraded-safe)
  let queryVector: number[];
  try {
    queryVector = await embedText(query);
  } catch (err) {
    warnings.push(
      `OpenAI embedding failed; returning empty results. Error: ${(err as Error).message}`
    );

    const payload: RetrieveKnowledgeResponse = {
      status: "degraded",
      timestamp: nowIso(),
      query,
      topK,
      results: [],
      warnings,
    };

    if (isDev) {
      console.log(
        `[RetrieveKnowledge] degraded: embed failed in ${Date.now() - startedAt}ms`
      );
    }

    return payload;
  }

  // 2) Search index
  const hits = await search(queryVector, topK);

  if (isDev) {
    console.log(`[RetrieveKnowledge] search: hits=${hits.length} topK=${topK}`);
  }

  // 3) Hydrate sources (KnowledgeNodes only for MVP)
  const results: RetrieveKnowledgeResult[] = [];

  for (const hit of hits) {
    const record = hit.record as EmbeddingRecord;

    const result: RetrieveKnowledgeResult = {
      score: hit.score,
      sourceType: record.sourceType,
      sourceId: record.sourceId,
    };

    if (record.sourceType === "knowledgeNode") {
      const hydrated = await hydrateKnowledgeNode(record);
      if (hydrated.node) result.node = hydrated.node;
      if (hydrated.filename) result.ref = { filename: hydrated.filename };
      if (hydrated.warning) warnings.push(hydrated.warning);
    }

    results.push(result);
  }

  const status: RetrieveKnowledgeStatus =
    warnings.length > 0 ? "degraded" : "ok";

  const payload: RetrieveKnowledgeResponse = {
    status,
    timestamp: nowIso(),
    query,
    topK,
    results,
    ...(warnings.length ? { warnings } : {}),
  };

  if (isDev) {
    console.log(
      `[RetrieveKnowledge] done: status=${status} results=${results.length} warnings=${warnings.length} durationMs=${Date.now() - startedAt}`
    );
  }

  return payload;
}

/**
 * Serverless HTTP handler
 */
export default async function handler(req: AnyReq, res: AnyRes): Promise<void> {
  const method = (req.method ?? "GET").toUpperCase();

  if (method !== "POST") {
    sendJson(res, 405, { error: "method_not_allowed", allowed: ["POST"] });
    return;
  }

  // Auth
  try {
    assertAuthorized(req);
  } catch {
    sendJson(res, 401, {
      error: "unauthorized",
      message: "Invalid or missing KE-Origin shared secret.",
    });
    return;
  }

  // Parse + validate body
  let body: unknown;
  try {
    body = await parseJsonBody(req);
  } catch (err) {
    sendJson(res, 400, {
      error: "invalid_json",
      message: `Request body is not valid JSON: ${(err as Error).message}`,
    });
    return;
  }

  const parsed = zRetrieveKnowledgeRequest.safeParse(body);
  if (!parsed.success) {
    sendJson(res, 400, {
      error: "invalid_payload",
      issues: parsed.error.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      })),
    });
    return;
  }

  try {
    const payload = await retrieveKnowledgeInternal(parsed.data);
    sendJson(res, 200, payload);
  } catch (err) {
    sendJson(res, 500, {
      error: "internal_error",
      message: "RetrieveKnowledge failed unexpectedly.",
      detail: (err as Error).message,
      timestamp: nowIso(),
    });
  }
}

/**
 * CLI Self-Test
 * Run:
 *   npx ts-node api/retrieve-knowledge.ts
 */
async function runCliSelfTest(): Promise<void> {
  console.log("Running api/retrieve-knowledge.ts as a CLI self-test...");
  console.log("====================================");
  console.log(" KE-Origin RetrieveKnowledge Self-Test");
  console.log("====================================");
  console.log("NODE_ENV:", config.env.nodeEnv);
  console.log("Project ID:", config.google.projectId);
  console.log("Embedding model:", embeddingModelInfo.model);
  console.log("");

  // Query something you've stored already (you have "CLI Test KnowledgeNode")
  const query = "CLI Test KnowledgeNode";
  const topK = 5;

  console.log("Query:", query);
  console.log("topK:", topK);
  console.log("");

  const payload = await retrieveKnowledgeInternal({ query, topK });
  console.log("Payload:", JSON.stringify(payload, null, 2));

  if (payload.results.length) {
    const top = payload.results[0];
    console.log("");
    console.log("Top hit:");
    console.log("  score:", top.score);
    console.log("  sourceType:", top.sourceType);
    console.log("  sourceId:", top.sourceId);
    if (top.node) {
      console.log("  node.title:", (top.node as any).title);
      console.log("  node.id:", (top.node as any).id);
    } else {
      console.log("  node: (not hydrated)");
    }
  } else {
    console.log("");
    console.log("No results returned. (Index might be empty or query doesn't match.)");
  }

  console.log("");
  console.log("====================================");
  console.log(" RetrieveKnowledge Self-Test Complete");
  console.log("====================================");
}

if (require.main === module) {
  runCliSelfTest().catch((err) => {
    console.error("RetrieveKnowledge self-test FAILED:", err);
    process.exit(1);
  });
}
