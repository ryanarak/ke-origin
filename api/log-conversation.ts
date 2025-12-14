// api/log-conversation.ts
//
// KE-Origin — Conversation Log + Optional Summary
//
// - POST /api/log-conversation
// - Auth via x-keorigin-secret (KEORIGIN_SHARED_SECRET)
// - Validates payload via Zod
// - Saves ConversationLog JSON to Drive: ConversationLogs/<filename>
// - Optionally creates a summary KnowledgeNode (via createNodeInternal)
// - CLI self-test supported: npx ts-node api/log-conversation.ts
//
// NOTE: This file intentionally avoids importing "@vercel/node" to keep local ts-node happy
//       without extra dependencies. The exported default handler works fine for Vercel/Next.

import { z } from "zod";

import { config, isDev } from "../config/env";
import { saveJson } from "../lib/driveClient";
import { buildConversationFilename, generateId, nowIso } from "../lib/utils";

// We reuse your create-node internal logic (no HTTP) to create summary KnowledgeNodes.
// Ensure api/create-node.ts exports createNodeInternal.
// If your export name differs, adjust the import below.
import { createNodeInternal } from "./create-node";

import type { CreateNodeRequest, KnowledgeNode } from "../lib/schemas";

// -----------------------------
// Schemas (local, minimal, stable)
// -----------------------------

const zConversationMessage = z.object({
  role: z.enum(["user", "assistant", "system"]),
  content: z.string().min(1, "Message content cannot be empty."),
  timestamp: z.string().optional(),
});

export type ConversationMessage = z.infer<typeof zConversationMessage>;

const zLogConversationRequest = z.object({
  sessionId: z.string().min(1, "sessionId is required."),
  messages: z.array(zConversationMessage).min(1, "messages must contain at least 1 item."),
  title: z.string().optional(),
  createSummaryNode: z.boolean().optional().default(true),
  summaryOverride: z.string().optional(),
  // Optional metadata about how this was triggered
  sourceType: z.enum(["manual", "api", "action", "other"]).optional().default("action"),
});

export type LogConversationRequest = z.infer<typeof zLogConversationRequest>;

const zConversationLog = z.object({
  id: z.string(),
  schemaVersion: z.literal(1),
  sessionId: z.string(),
  title: z.string().optional(),
  messages: z.array(
    z.object({
      role: z.enum(["user", "assistant", "system"]),
      content: z.string(),
      timestamp: z.string(),
    })
  ),
  createdAt: z.string(),
  updatedAt: z.string(),
  meta: z
    .object({
      sourceType: z.enum(["manual", "api", "action", "other"]).optional(),
      summaryNodeId: z.string().optional(),
    })
    .optional(),
});

export type ConversationLog = z.infer<typeof zConversationLog>;

const zLogConversationResponse = z.object({
  log: zConversationLog,
  filename: z.string(),
  summaryNode: z.any().optional(), // typed in TS below; runtime kept permissive
  summaryStatus: z.enum(["created", "skipped", "error"]).optional(),
  summaryError: z.string().optional(),
});

export type LogConversationResponse = {
  log: ConversationLog;
  filename: string;
  summaryNode?: KnowledgeNode;
  summaryStatus?: "created" | "skipped" | "error";
  summaryError?: string;
};

// -----------------------------
// Helpers
// -----------------------------

function getHeader(req: any, name: string): string | undefined {
  const raw =
    req?.headers?.[name] ??
    req?.headers?.[name.toLowerCase()] ??
    (typeof req?.getHeader === "function" ? req.getHeader(name) : undefined);

  if (Array.isArray(raw)) return raw[0];
  if (typeof raw === "string") return raw;
  return undefined;
}

async function parseJsonBody(req: any): Promise<unknown> {
  // If the runtime already parsed it (common in Next/Vercel), use it.
  if (req?.body !== undefined) return req.body;

  // Otherwise, read raw stream (Node/undici style)
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve());
    req.on("error", (err: Error) => reject(err));
  });

  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};

  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`log-conversation: request body is not valid JSON. ${(err as Error).message}`);
  }
}

function sendJson(res: any, status: number, payload: unknown) {
  if (typeof res.status === "function" && typeof res.json === "function") {
    res.status(status).json(payload);
    return;
  }

  // Fallback for basic Node res
  res.statusCode = status;
  res.setHeader?.("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload, null, 2));
}

/**
 * MVP fallback summarizer (no LLM yet).
 * - If summaryOverride provided, we use that instead.
 * - Otherwise: builds a compact human-readable digest from first few turns.
 */
function summarizeConversationFallback(messages: ConversationMessage[], maxChars = 1200): string {
  const lines: string[] = [];
  const take = Math.min(messages.length, 12);

  for (let i = 0; i < take; i++) {
    const m = messages[i];
    const who = m.role === "assistant" ? "Assistant" : m.role === "user" ? "User" : "System";
    const content = m.content.replace(/\s+/g, " ").trim();
    if (!content) continue;
    lines.push(`${who}: ${content}`);
  }

  let summary = lines.join("\n");
  if (messages.length > take) summary += `\n… (${messages.length - take} more message(s) omitted)`;

  if (summary.length > maxChars) summary = summary.slice(0, maxChars - 3) + "...";

  return [
    "MVP Summary (no LLM):",
    "This summary is a deterministic digest. Provide summaryOverride or add lib/llm.ts later for better summaries.",
    "",
    summary,
  ].join("\n");
}

// -----------------------------
// Core internal logic (reusable by HTTP + CLI)
// -----------------------------

export async function logConversationInternal(
  input: LogConversationRequest
): Promise<LogConversationResponse> {
  const parsed = zLogConversationRequest.parse(input);

  const id = generateId();
  const createdAt = nowIso();

  const messageTimestampFallback = createdAt;

  const normalizedMessages = parsed.messages.map((m) => ({
    role: m.role,
    content: m.content.trim(),
    timestamp: m.timestamp ?? messageTimestampFallback,
  }));

  const baseLog: ConversationLog = {
    id,
    schemaVersion: 1,
    sessionId: parsed.sessionId,
    title: parsed.title,
    messages: normalizedMessages,
    createdAt,
    updatedAt: createdAt,
    meta: {
      sourceType: parsed.sourceType,
    },
  };

  const log = zConversationLog.parse(baseLog);

  const filename = buildConversationFilename({
    createdAt: log.createdAt,
    id: log.id,
    title: log.title ?? `Session ${log.sessionId}`,
  });

  if (isDev) {
    // eslint-disable-next-line no-console
    console.log(
      `[LogConversation] Saving ConversationLog: id=${log.id} sessionId=${log.sessionId} messages=${log.messages.length} filename=${filename}`
    );
  }

  // Primary invariant: saving the conversation log must succeed.
  await saveJson("conversationLogs", filename, log);

  let summaryNode: KnowledgeNode | undefined;
  let summaryStatus: "created" | "skipped" | "error" | undefined;
  let summaryError: string | undefined;

  const shouldSummarize = parsed.createSummaryNode ?? true;

  if (!shouldSummarize) {
    summaryStatus = "skipped";
  } else {
    try {
      const summaryText =
        parsed.summaryOverride ??
        summarizeConversationFallback(parsed.messages);

      const summaryTitle = parsed.title ?? `Summary of session ${parsed.sessionId}`;

      const summaryPayload: CreateNodeRequest = {
        content: summaryText,
        title: summaryTitle,
        type: "summary",
        sourceType: "conversation",
        sourceRef: log.id,
        tags: ["conversation-summary"],
        domains: ["ke-origin"],
      };

      const result = await createNodeInternal(summaryPayload);
      summaryNode = result.node as KnowledgeNode;
      summaryStatus = "created";

      // Link the summary node back into the conversation log, then resave
      const updatedLog: ConversationLog = zConversationLog.parse({
        ...log,
        meta: {
          ...(log.meta ?? {}),
          summaryNodeId: summaryNode.id,
        },
        updatedAt: nowIso(),
      });

      await saveJson("conversationLogs", filename, updatedLog);

      if (isDev) {
        // eslint-disable-next-line no-console
        console.log(
          `[LogConversation] Summary node created: nodeId=${summaryNode.id} convoId=${log.id}`
        );
      }
    } catch (err) {
      summaryStatus = "error";
      summaryError = (err as Error).message;

      // Do NOT fail the request; log is already stored.
      // eslint-disable-next-line no-console
      console.warn(
        `[LogConversation] Summary creation failed for convoId=${log.id}: ${summaryError}`
      );
    }
  }

  const response: LogConversationResponse = {
    log,
    filename,
    ...(summaryNode ? { summaryNode } : {}),
    ...(summaryStatus ? { summaryStatus } : {}),
    ...(summaryError ? { summaryError } : {}),
  };

  // Runtime validation (keeps response contract honest)
  zLogConversationResponse.parse(response);

  return response;
}

// -----------------------------
// HTTP Handler (Vercel/Next compatible, no @vercel/node import)
// -----------------------------

export default async function handler(req: any, res: any) {
  try {
    if (req?.method && req.method !== "POST") {
      sendJson(res, 405, { error: "method_not_allowed", allowed: ["POST"] });
      return;
    }

    const secret = getHeader(req, "x-keorigin-secret");
    if (!secret || secret !== config.keOrigin.sharedSecret) {
      sendJson(res, 401, {
        error: "unauthorized",
        message: "Invalid or missing KE-Origin shared secret.",
      });
      return;
    }

    const body = await parseJsonBody(req);
    const response = await logConversationInternal(body as LogConversationRequest);

    sendJson(res, 200, response);
  } catch (err) {
    // Zod validation errors -> 400 with issues
    if (err instanceof z.ZodError) {
      sendJson(res, 400, {
        error: "invalid_payload",
        issues: err.issues,
      });
      return;
    }

    const message = (err as Error).message ?? String(err);
    // eslint-disable-next-line no-console
    console.error("[LogConversation] Fatal error:", message);

    sendJson(res, 500, {
      error: "internal_error",
      message: "Unexpected server error.",
      detail: isDev ? message : undefined,
    });
  }
}

// -----------------------------
// CLI Self-Test
// -----------------------------

async function runCliSelfTest() {
  // eslint-disable-next-line no-console
  console.log("Running api/log-conversation.ts as a CLI self-test...");
  // eslint-disable-next-line no-console
  console.log("====================================");
  // eslint-disable-next-line no-console
  console.log(" KE-Origin LogConversation Self-Test ");
  // eslint-disable-next-line no-console
  console.log("====================================");
  // eslint-disable-next-line no-console
  console.log("NODE_ENV:", config.env.nodeEnv);
  // eslint-disable-next-line no-console
  console.log("Project ID:", config.google.projectId);
  // eslint-disable-next-line no-console
  console.log("");

  const sample: LogConversationRequest = {
    sessionId: `cli-test-${Date.now()}`,
    title: "CLI Test Conversation",
    createSummaryNode: true, // set false if you only want to store the log
    // You can also pass summaryOverride to avoid the fallback summarizer.
    // summaryOverride: "Short summary written by caller...",
    sourceType: "manual",
    messages: [
      { role: "user", content: "Hi Randall, please store this conversation." },
      { role: "assistant", content: "Understood. I will store it in KE-Origin." },
      { role: "user", content: "Also create a summary node linked back to it." },
      { role: "assistant", content: "Got it. I will store the summary as a KnowledgeNode." },
    ],
  };

  // eslint-disable-next-line no-console
  console.log("Payload:", {
    sessionId: sample.sessionId,
    title: sample.title,
    createSummaryNode: sample.createSummaryNode,
    messages: sample.messages.length,
  });

  const result = await logConversationInternal(sample);

  // eslint-disable-next-line no-console
  console.log("");
  // eslint-disable-next-line no-console
  console.log("✅ Log saved.");
  // eslint-disable-next-line no-console
  console.log("ConversationLog ID:", result.log.id);
  // eslint-disable-next-line no-console
  console.log("Filename:", result.filename);
  // eslint-disable-next-line no-console
  console.log("Messages:", result.log.messages.length);

  if (result.summaryStatus) {
    // eslint-disable-next-line no-console
    console.log("Summary status:", result.summaryStatus);
  }
  if (result.summaryNode) {
    // eslint-disable-next-line no-console
    console.log("Summary node ID:", result.summaryNode.id);
  }
  if (result.summaryError) {
    // eslint-disable-next-line no-console
    console.log("Summary error:", result.summaryError);
  }

  // eslint-disable-next-line no-console
  console.log("");
  // eslint-disable-next-line no-console
  console.log("====================================");
  // eslint-disable-next-line no-console
  console.log(" LogConversation Self-Test Complete ");
  // eslint-disable-next-line no-console
  console.log("====================================");
}

if (require.main === module) {
  runCliSelfTest().catch((err) => {
    // eslint-disable-next-line no-console
    console.error("LogConversation self-test FAILED:", err);
    process.exit(1);
  });
}
