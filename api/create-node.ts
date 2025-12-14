// api/create-node.ts
//
// Core Knowledge Storage Endpoint for KE-Origin.
//
// Responsibilities:
// - Auth via KEORIGIN_SHARED_SECRET header (x-keorigin-secret)
// - Validate input against CreateNodeRequest schema
// - Build and persist a KnowledgeNode JSON file in Google Drive
// - Generate an embedding for node.content
// - Add EmbeddingRecord to JSON-backed index via indexStore
// - Return a structured response (CreateNodeResponse-like)
//
// This file also includes a CLI self-test when executed directly:
//   npx ts-node api/create-node.ts

import { ZodError } from "zod";

import { config, isDev } from "../config/env";
import {
  zCreateNodeRequest,
  zKnowledgeNode,
  zEmbeddingRecord,
  type KnowledgeNode,
  type EmbeddingRecord,
} from "../lib/schemas";
import {
  generateId,
  nowIso,
  buildNodeFilename,
} from "../lib/utils";
import { saveJson } from "../lib/driveClient";
import {
  embedText,
  embeddingModelInfo,
} from "../lib/embeddings";
import {
  addEmbedding,
} from "../lib/indexStore";

/**
 * Type used by this module for describing the internal result
 * of the create-node operation.
 */
interface CreateNodeInternalResult {
  node: KnowledgeNode;
  filename: string;
  embeddingStatus: "embedded" | "skipped" | "error";
  embeddingError?: string;
}

/**
 * Safely extract a header from a generic request object.
 * Works for Node/Next/Vercel-like environments.
 */
function getHeader(req: any, name: string): string | undefined {
  if (!req || !req.headers) return undefined;

  const lcName = name.toLowerCase();
  const raw = (req.headers as Record<string, string | string[] | undefined>)[lcName];

  if (Array.isArray(raw)) return raw[0];
  return typeof raw === "string" ? raw : undefined;
}

/**
 * Parse JSON body from a generic request object.
 * In most frameworks (Next.js / Vercel), req.body will already be an object.
 */
async function parseJsonBody(req: any): Promise<unknown> {
  const body = req?.body;

  if (body == null) {
    throw new Error("Request body is missing. Ensure JSON body parsing is enabled.");
  }

  if (typeof body === "string") {
    try {
      return JSON.parse(body);
    } catch (err) {
      throw new Error(
        `Request body is not valid JSON: ${(err as Error).message}`
      );
    }
  }

  // Assume it's already a parsed JSON object
  return body;
}

/**
 * Core logic to create a KnowledgeNode and (optionally) index it.
 * This function is used by both the HTTP handler and the CLI self-test.
 */
export async function createNodeInternal(
  rawInput: unknown
): Promise<CreateNodeInternalResult> {
  // 1) Validate incoming payload against CreateNodeRequest schema
  const input = zCreateNodeRequest.parse(rawInput);

  const rawContent = input.content ?? "";
  const content = rawContent.trim();
  if (!content) {
    throw new Error("CreateNodeRequest.content must be a non-empty string.");
  }

  const now = nowIso();
  const nodeId = generateId();

  const title =
    (input.title && input.title.trim()) ||
    content.slice(0, 80) ||
    `Untitled node ${nodeId.slice(0, 8)}`;

  const nodeType = input.type ?? "note";
  const sourceType = input.sourceType ?? "manual";

  // 2) Build a KnowledgeNode candidate and validate with zKnowledgeNode
  const nodeCandidate: any = {
    id: nodeId,
    schemaVersion: 1,
    type: nodeType,
    title,
    content,
    sourceType,
    createdAt: now,
    updatedAt: now,
  };

  if (input.sourceRef) {
    nodeCandidate.sourceRef = input.sourceRef;
  }
  if (input.tags && input.tags.length > 0) {
    nodeCandidate.tags = input.tags;
  }
  if (input.domains && input.domains.length > 0) {
    nodeCandidate.domains = input.domains;
  }

  const node: KnowledgeNode = zKnowledgeNode.parse(nodeCandidate);

  // 3) Derive filename for Drive
  const filename = buildNodeFilename({
    createdAt: node.createdAt,
    id: node.id,
    title: node.title,
  });

  if (isDev) {
    // eslint-disable-next-line no-console
    console.log(
      "[CreateNode] Creating knowledge node:",
      `id=${node.id}`,
      `title="${node.title}"`,
      `type=${node.type}`,
      `sourceType=${node.sourceType}`,
      `filename=${filename}`
    );
  }

  // 4) Persist the node JSON to Drive
  try {
    await saveJson("knowledgeNodes", filename, node);
    if (isDev) {
      // eslint-disable-next-line no-console
      console.log(
        "[CreateNode] Saved KnowledgeNode to Drive folder 'KnowledgeNodes' with filename:",
        filename
      );
    }
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    throw new Error(
      `Drive error while saving KnowledgeNode: ${message}`
    );
  }

  // 5) Generate embedding + index record
  let embeddingStatus: CreateNodeInternalResult["embeddingStatus"] = "skipped";
  let embeddingError: string | undefined;

  try {
    const vector = await embedText(node.content);
    const embeddingId = generateId();
    const embeddingCreatedAt = nowIso();

    const embeddingRecordCandidate: EmbeddingRecord = {
      id: embeddingId,
      schemaVersion: 1,
      sourceType: "knowledgeNode",
      sourceId: node.id,
      vector,
      createdAt: embeddingCreatedAt,
      meta: {
        model: embeddingModelInfo.model,
        nodeType: node.type,
        sourceRef: filename,
      },
    };

    // Validate embedding record structure
    const embeddingRecord = zEmbeddingRecord.parse(
      embeddingRecordCandidate
    );

    await addEmbedding(embeddingRecord);

    embeddingStatus = "embedded";

    if (isDev) {
      // eslint-disable-next-line no-console
      console.log(
        "[CreateNode] Embedded + indexed KnowledgeNode",
        `nodeId=${node.id}`,
        `embeddingId=${embeddingRecord.id}`,
        `vectorLength=${vector.length}`
      );
    }
  } catch (err) {
    embeddingStatus = "error";
    embeddingError = (err as Error).message ?? String(err);

    // IMPORTANT:
    // We do NOT throw here. The node has already been saved to Drive.
    // Indexing failure is a degraded state, not a total failure.
    // eslint-disable-next-line no-console
    console.warn(
      "[CreateNode] Embedding/indexing failed for node",
      node.id,
      "error:",
      embeddingError
    );
  }

  return {
    node,
    filename,
    embeddingStatus,
    embeddingError,
  };
}

/**
 * HTTP handler (generic, type-light) compatible with Vercel/Next-like runtimes.
 *
 * When called as an API route:
 *   - Accepts POST JSON body matching CreateNodeRequest.
 *   - Auth via x-keorigin-secret header.
 *   - Returns a JSON payload with node + indexing status.
 */
export default async function handler(req: any, res: any) {
  // Method guard
  const method = (req?.method || "GET").toUpperCase();
  if (method !== "POST") {
    if (res) {
      res.statusCode = 405;
      if (typeof res.setHeader === "function") {
        res.setHeader("Allow", "POST");
      }
      res.end(
        JSON.stringify({
          error: "method_not_allowed",
          allowed: ["POST"],
        })
      );
    }
    return;
  }

  // Auth check via shared secret
  const secretHeader = getHeader(req, "x-keorigin-secret");
  if (!secretHeader || secretHeader !== config.keOrigin.sharedSecret) {
    if (res) {
      res.statusCode = 401;
      res.end(
        JSON.stringify({
          error: "unauthorized",
          message:
            "Invalid or missing KE-Origin shared secret.",
        })
      );
    }
    return;
  }

  // Parse body
  let body: unknown;
  try {
    body = await parseJsonBody(req);
  } catch (err) {
    if (res) {
      res.statusCode = 400;
      res.end(
        JSON.stringify({
          error: "invalid_json",
          message: (err as Error).message ?? String(err),
        })
      );
    }
    return;
  }

  // Validate request payload & create node
  try {
    const result = await createNodeInternal(body);

    const responsePayload: any = {
      node: result.node,
      filename: result.filename,
      indexStatus:
        result.embeddingStatus === "embedded"
          ? "embedded"
          : result.embeddingStatus === "skipped"
          ? "skipped"
          : "error",
    };

    if (result.embeddingStatus === "error" && result.embeddingError) {
      responsePayload.indexError = result.embeddingError;
    }

    if (res) {
      res.statusCode = 200;
      if (typeof res.setHeader === "function") {
        res.setHeader("Content-Type", "application/json");
      }
      res.end(JSON.stringify(responsePayload));
    }
  } catch (err) {
    if (err instanceof ZodError) {
      const issues = err.issues?.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      }));
      if (res) {
        res.statusCode = 400;
        res.end(
          JSON.stringify({
            error: "invalid_payload",
            message:
              "Request body did not match CreateNodeRequest schema.",
            issues,
          })
        );
      }
      return;
    }

    // Unexpected error
    const message = (err as Error).message ?? String(err);
    // eslint-disable-next-line no-console
    console.error("[CreateNode] Internal error:", message);

    if (res) {
      res.statusCode = 500;
      res.end(
        JSON.stringify({
          error: "internal_error",
          message: "Unexpected server error.",
        })
      );
    }
  }
}

/**
 * CLI self-test:
 * Allows you to run this file directly with ts-node to verify:
 * - Config is valid
 * - Drive is reachable for KnowledgeNodes
 * - Embeddings + indexStore are working
 *
 * Usage:
 *   npx ts-node api/create-node.ts
 */
async function runCliSelfTest() {
  // eslint-disable-next-line no-console
  console.log("====================================");
  // eslint-disable-next-line no-console
  console.log(" KE-Origin CreateNode Self-Test");
  // eslint-disable-next-line no-console
  console.log("====================================");
  // eslint-disable-next-line no-console
  console.log("NODE_ENV:", config.env.nodeEnv);
  // eslint-disable-next-line no-console
  console.log("Project ID:", config.google.projectId);
  // eslint-disable-next-line no-console
  console.log("Embedding model:", embeddingModelInfo.model);
  // eslint-disable-next-line no-console
  console.log();

  const sampleContent =
    "This is a test KnowledgeNode created via api/create-node.ts CLI self-test.";
  const sampleTitle = "CLI Test KnowledgeNode";

  // eslint-disable-next-line no-console
  console.log("Step 1: Building sample CreateNodeRequest payload...");
  const payload = {
    content: sampleContent,
    title: sampleTitle,
    type: "note",
    sourceType: "manual",
    tags: ["cli-test", "ke-origin"],
    domains: ["ke-origin"],
  };

  // eslint-disable-next-line no-console
  console.log("Payload:", payload);
  // eslint-disable-next-line no-console
  console.log();

  // 2) Call core logic
  try {
    // eslint-disable-next-line no-console
    console.log("Step 2: Creating KnowledgeNode via createNodeInternal...");
    const result = await createNodeInternal(payload);

    // eslint-disable-next-line no-console
    console.log("  ✓ Node created and saved to Drive.");
    // eslint-disable-next-line no-console
    console.log("  Node ID:", result.node.id);
    // eslint-disable-next-line no-console
    console.log("  Filename:", result.filename);
    // eslint-disable-next-line no-console
    console.log("  CreatedAt:", result.node.createdAt);

    if (result.embeddingStatus === "embedded") {
      // eslint-disable-next-line no-console
      console.log(
        "  ✓ Embedding created and added to index (status=embedded)."
      );
    } else if (result.embeddingStatus === "error") {
      // eslint-disable-next-line no-console
      console.warn(
        "  ⚠ Node stored, but embedding/indexing failed:",
        result.embeddingError
      );
    } else {
      // skipped
      // eslint-disable-next-line no-console
      console.log(
        "  ℹ Embedding step skipped (status=skipped)."
      );
    }

    // eslint-disable-next-line no-console
    console.log();
    // eslint-disable-next-line no-console
    console.log("====================================");
    // eslint-disable-next-line no-console
    console.log(" CreateNode Self-Test Complete");
    // eslint-disable-next-line no-console
    console.log("====================================");
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("❌ CreateNode self-test FAILED.");
    // eslint-disable-next-line no-console
    console.error("Error:", err);
    process.exitCode = 1;
  }
}

// Run CLI self-test when executed directly
if (require.main === module) {
  // eslint-disable-next-line no-console
  console.log("Running api/create-node.ts as a CLI self-test...");
  runCliSelfTest().catch((err) => {
    // eslint-disable-next-line no-console
    console.error("Unhandled error in CreateNode self-test:", err);
    process.exit(1);
  });
}
