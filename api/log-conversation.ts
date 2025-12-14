// api/log-conversation.ts
//
// KE-Origin — Conversation Log + Summary (Clean Build)
//
// Compatible with: Node, Vercel, ts-node
// Stores conversations, generates deterministic summaries, and links to KnowledgeNodes.

import { z } from "zod";
import { saveJson } from "../lib/driveClient";
import { buildConversationFilename, generateId, nowIso } from "../lib/utils";
import { createNodeInternal } from "./create-node";
import type { CreateNodeRequest } from "../lib/schemas";

// -----------------------------
// Zod Schemas
// -----------------------------
const zConversationMessage = z.object({
  role: z.enum(["user", "assistant", "system"]),
  content: z.string().min(1),
  timestamp: z.string().optional(),
});

export type ConversationMessage = z.infer<typeof zConversationMessage>;

const zLogConversationRequest = z.object({
  sessionId: z.string(),
  messages: z.array(zConversationMessage).min(1),
  title: z.string().optional(),
  createSummaryNode: z.boolean().optional().default(true),
  summaryOverride: z.string().optional(),
  sourceType: z.enum(["manual", "api", "action", "other"]).optional().default("action"),
});

export type LogConversationRequest = z.infer<typeof zLogConversationRequest>;

// -----------------------------
// Interfaces
// -----------------------------
interface ConversationMeta {
  sourceType?: "manual" | "api" | "action" | "other";
  summaryNodeId?: string;
  keywords?: string[];
  wordCount?: number;
  tokenEstimate?: number;
}

interface ConversationLog {
  id: string;
  schemaVersion: number;
  sessionId: string;
  title?: string;
  messages: ConversationMessage[];
  fullText?: string;
  createdAt: string;
  updatedAt: string;
  meta?: ConversationMeta;
}

// -----------------------------
// Helpers
// -----------------------------
function flattenTranscript(messages: ConversationMessage[]): string {
  return messages
    .map(
      (m) =>
        `[${m.role.toUpperCase()} @ ${m.timestamp ?? new Date().toISOString()}]\n${m.content}`
    )
    .join("\n\n");
}

function summarizeConversationFallback(messages: ConversationMessage[]): string {
  return messages
    .slice(0, 10)
    .map((m) => `${m.role}: ${m.content}`)
    .join("\n");
}

// -----------------------------
// Main Logic
// -----------------------------
export async function logConversationInternal(
  input: LogConversationRequest
): Promise<any> {
  const parsed = zLogConversationRequest.parse(input);
  const id = generateId();
  const createdAt = nowIso();
  const normalizedMessages = parsed.messages.map((m) => ({
    ...m,
    timestamp: m.timestamp ?? createdAt,
  }));

  const fullText = flattenTranscript(normalizedMessages);
  const wordCount = fullText.split(/\s+/).length;
  const tokenEstimate = Math.round(wordCount * 1.3);

  const log: ConversationLog = {
    id,
    schemaVersion: 1,
    sessionId: parsed.sessionId,
    title: parsed.title,
    messages: normalizedMessages,
    fullText,
    createdAt,
    updatedAt: createdAt,
    meta: {
      sourceType: parsed.sourceType,
      wordCount,
      tokenEstimate,
    },
  };

  const filename = buildConversationFilename({
    createdAt,
    id,
    title: parsed.title ?? parsed.sessionId,
  });

  await saveJson("conversationLogs", filename, log);

  if (parsed.createSummaryNode) {
    try {
      const summaryText =
        parsed.summaryOverride ?? summarizeConversationFallback(parsed.messages);
      const summaryPayload: CreateNodeRequest = {
        content: summaryText,
        title: parsed.title ?? `Summary of ${parsed.sessionId}`,
        type: "summary",
        sourceType: "conversation",
        sourceRef: log.id,
        tags: ["conversation-summary"],
        domains: ["ke-origin"],
      };
      const result = await createNodeInternal(summaryPayload);
      log.meta!.summaryNodeId = result.node.id;
      await saveJson("conversationLogs", filename, log);
    } catch (err) {
      console.warn("Summary node creation failed:", (err as Error).message);
    }
  }

  return { log, filename };
}

// -----------------------------
// CLI Self-Test
// -----------------------------
if (require.main === module) {
  (async () => {
    const sample: LogConversationRequest = {
      sessionId: `cli-test-${Date.now()}`,
      title: "CLI Test",
      sourceType: "manual",
      createSummaryNode: true,
      messages: [
        { role: "user", content: "Test message 1" },
        { role: "assistant", content: "Test response 1" },
      ],
    };
    const result = await logConversationInternal(sample);
    console.log("✅ Log saved:", result.filename);
  })();
}
