// lib/schemas.ts
//
// Canonical data models and API DTO schemas for KE-Origin.
// - Defines how core entities look on disk (JSON in Drive).
// - Defines how API payloads look over HTTP.
// - Provides Zod schemas + TypeScript types for runtime + compile-time safety.
// - No environment access. No side effects.

import { z } from "zod";

/**
 * Schema version constants for persisted models.
 * bump these when you make backward-incompatible changes.
 */
export const KNOWLEDGE_NODE_SCHEMA_VERSION = 1;
export const CONVERSATION_LOG_SCHEMA_VERSION = 1;
export const EMBEDDING_RECORD_SCHEMA_VERSION = 1;
export const SOURCE_DOCUMENT_SCHEMA_VERSION = 1;

/**
 * Primitive enums / literals.
 */

export const NodeSourceTypeLiteral = [
  "manual",
  "conversation",
  "document",
  "system",
  "other",
] as const;
export type NodeSourceType = (typeof NodeSourceTypeLiteral)[number];

export const KnowledgeNodeTypeLiteral = [
  "note",
  "summary",
  "principle",
  "spec",
  "log",
  "other",
] as const;
export type KnowledgeNodeType = (typeof KnowledgeNodeTypeLiteral)[number];

export const ConversationRoleLiteral = ["user", "assistant", "system"] as const;
export type ConversationRole = (typeof ConversationRoleLiteral)[number];

export const EmbeddingSourceTypeLiteral = [
  "knowledgeNode",
  "conversationLog",
  "documentChunk",
] as const;
export type EmbeddingSourceType =
  (typeof EmbeddingSourceTypeLiteral)[number];

/**
 * Common primitives.
 */

export const zIsoDateString = z.string().datetime({
  message: "Expected ISO 8601 datetime string",
});

/**
 * CORE PERSISTENT MODELS
 * ----------------------
 */

/**
 * KnowledgeNode
 *
 * Represents a single structured chunk of knowledge.
 */
export const zKnowledgeNode = z.object({
  id: z.string().min(1, "id is required"),
  schemaVersion: z
    .number()
    .int()
    .nonnegative()
    .default(KNOWLEDGE_NODE_SCHEMA_VERSION),

  type: z.enum(KnowledgeNodeTypeLiteral).default("note"),
  title: z.string().min(1, "title cannot be empty").transform((s) => s.trim()),
  content: z.string().min(1, "content cannot be empty"),

  sourceType: z.enum(NodeSourceTypeLiteral).default("manual"),
  sourceRef: z.string().min(1).optional(),

  createdAt: zIsoDateString,
  updatedAt: zIsoDateString,

  tags: z.array(z.string().min(1)).optional(),
  domains: z.array(z.string().min(1)).optional(),

  embeddingRef: z.string().min(1).optional(),
});

export type KnowledgeNode = z.infer<typeof zKnowledgeNode>;

/**
 * ConversationMessage
 */
export const zConversationMessage = z.object({
  id: z.string().min(1, "message id is required"),
  role: z.enum(ConversationRoleLiteral),
  content: z.string().min(1, "message content cannot be empty"),
  timestamp: zIsoDateString,
});

export type ConversationMessage = z.infer<typeof zConversationMessage>;

/**
 * ConversationLog
 *
 * Represents a full conversation session (e.g., a ChatGPT chat).
 */
export const zConversationLog = z.object({
  id: z.string().min(1, "id is required"),
  schemaVersion: z
    .number()
    .int()
    .nonnegative()
    .default(CONVERSATION_LOG_SCHEMA_VERSION),

  title: z.string().min(1).optional(),
  sessionId: z.string().min(1, "sessionId is required"),

  createdAt: zIsoDateString,
  updatedAt: zIsoDateString,

  messages: z
    .array(zConversationMessage)
    .min(1, "conversation must have at least one message"),

  summaryNodeId: z.string().min(1).optional(),

  meta: z
    .object({
      model: z.string().min(1).optional(),
      tags: z.array(z.string().min(1)).optional(),
    })
    .optional(),
});

export type ConversationLog = z.infer<typeof zConversationLog>;

/**
 * EmbeddingRecord
 *
 * Minimal vector index entry mapping a semantic vector to some source.
 */
export const zEmbeddingRecord = z.object({
  id: z.string().min(1, "embedding id is required"),
  schemaVersion: z
    .number()
    .int()
    .nonnegative()
    .default(EMBEDDING_RECORD_SCHEMA_VERSION),

  sourceType: z.enum(EmbeddingSourceTypeLiteral),
  sourceId: z.string().min(1, "sourceId is required"),

  vector: z
    .array(z.number())
    .min(1, "embedding vector must have at least one dimension"),

  createdAt: zIsoDateString,

  meta: z
    .object({
      model: z.string().min(1).optional(),
      nodeType: z.enum(KnowledgeNodeTypeLiteral).optional(),
      sourceRef: z.string().min(1).optional(),
    })
    .optional(),
});

export type EmbeddingRecord = z.infer<typeof zEmbeddingRecord>;

/**
 * SourceDocument (for document ingestion).
 */
export const zSourceDocument = z.object({
  id: z.string().min(1, "id is required"),
  schemaVersion: z
    .number()
    .int()
    .nonnegative()
    .default(SOURCE_DOCUMENT_SCHEMA_VERSION),

  title: z.string().min(1, "title is required"),
  driveFileId: z.string().min(1, "driveFileId is required"),
  mimeType: z.string().min(1).optional(),

  createdAt: zIsoDateString,
  updatedAt: zIsoDateString,

  meta: z
    .object({
      pages: z.number().int().nonnegative().optional(),
      sizeBytes: z.number().int().nonnegative().optional(),
    })
    .optional(),
});

export type SourceDocument = z.infer<typeof zSourceDocument>;

/**
 * API DTO SCHEMAS
 * ---------------
 *
 * These define the request / response shapes for the KE-Origin API routes.
 */

/**
 * Create Node
 */

export const zCreateNodeRequest = z.object({
  content: z.string().min(1, "content is required"),
  title: z.string().min(1).optional(),
  type: z.enum(KnowledgeNodeTypeLiteral).optional(),
  sourceType: z.enum(NodeSourceTypeLiteral).optional(),
  sourceRef: z.string().min(1).optional(),
  tags: z.array(z.string().min(1)).optional(),
  domains: z.array(z.string().min(1)).optional(),
});

export type CreateNodeRequest = z.infer<typeof zCreateNodeRequest>;

export const zCreateNodeResponse = z.object({
  node: zKnowledgeNode,
});

export type CreateNodeResponse = z.infer<typeof zCreateNodeResponse>;

/**
 * Log Conversation
 */

export const zLogConversationRequest = z.object({
  sessionId: z.string().min(1, "sessionId is required"),
  title: z.string().min(1).optional(),
  messages: z
    .array(
      z.object({
        role: z.enum(ConversationRoleLiteral),
        content: z.string().min(1),
        timestamp: zIsoDateString.optional(),
      })
    )
    .min(1, "messages array cannot be empty"),
  createSummaryNode: z.boolean().optional(),
});

export type LogConversationRequest = z.infer<typeof zLogConversationRequest>;

export const zLogConversationResponse = z.object({
  log: zConversationLog,
  summaryNode: zKnowledgeNode.optional(),
});

export type LogConversationResponse = z.infer<typeof zLogConversationResponse>;

/**
 * Retrieve Knowledge
 */

export const zRetrieveKnowledgeRequest = z.object({
  query: z.string().min(1, "query is required"),
  topK: z.number().int().positive().max(50).optional(),
  // future: filters (sourceTypes, domains, etc.)
});

export type RetrieveKnowledgeRequest = z.infer<
  typeof zRetrieveKnowledgeRequest
>;

export const zRetrievedKnowledgeItem = z.object({
  node: zKnowledgeNode,
  score: z.number(), // similarity score
});

export type RetrievedKnowledgeItem = z.infer<
  typeof zRetrievedKnowledgeItem
>;

export const zRetrieveKnowledgeResponse = z.object({
  items: z.array(zRetrievedKnowledgeItem),
});

export type RetrieveKnowledgeResponse = z.infer<
  typeof zRetrieveKnowledgeResponse
>;

/**
 * Health
 */

export const zSystemHealthStatus = z.enum(["ok", "degraded", "error"]);
export type SystemHealthStatus = z.infer<typeof zSystemHealthStatus>;

export const zSubsystemHealthStatus = z.enum(["ok", "empty", "error"]);
export type SubsystemHealthStatus = z.infer<typeof zSubsystemHealthStatus>;

export const zHealthDetails = z.object({
  config: zSystemHealthStatus,
  drive: zSystemHealthStatus,
  index: zSubsystemHealthStatus,
  openai: zSystemHealthStatus.optional(),
});

export type HealthDetails = z.infer<typeof zHealthDetails>;

export const zHealthResponse = z.object({
  status: zSystemHealthStatus,
  details: zHealthDetails,
  timestamp: zIsoDateString,
});

export type HealthResponse = z.infer<typeof zHealthResponse>;

/**
 * Convenience export groupings
 */

export const Schemas = {
  // core models
  KnowledgeNode: zKnowledgeNode,
  ConversationLog: zConversationLog,
  EmbeddingRecord: zEmbeddingRecord,
  SourceDocument: zSourceDocument,

  // API DTOs
  CreateNodeRequest: zCreateNodeRequest,
  CreateNodeResponse: zCreateNodeResponse,
  LogConversationRequest: zLogConversationRequest,
  LogConversationResponse: zLogConversationResponse,
  RetrieveKnowledgeRequest: zRetrieveKnowledgeRequest,
  RetrieveKnowledgeResponse: zRetrieveKnowledgeResponse,

  // health
  HealthResponse: zHealthResponse,
};
