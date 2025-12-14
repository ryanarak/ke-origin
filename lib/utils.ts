// lib/utils.ts
//
// Small, sharp helpers for KE-Origin.
//
// - ID & timestamp helpers
// - Slug generation
// - Date → filename helpers
// - Safe JSON helpers
// - Exhaustiveness guard
//
// Pure, stateless, and dependency-light. This file should
// not import anything from KE-Origin (config, drive, schemas, etc.).
// It sits at the bottom of the dependency graph.

import { v4 as uuidv4 } from "uuid";

/**
 * Generate a globally unique ID (UUID v4).
 * Used for KnowledgeNodes, ConversationLogs, EmbeddingRecords, etc.
 */
export function generateId(): string {
  return uuidv4();
}

/**
 * Return the current timestamp as an ISO-8601 string in UTC.
 * Example: "2025-12-11T23:28:57.318Z"
 */
export function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Convert a Date object to an ISO-8601 string.
 * Convenience wrapper for consistency.
 */
export function toIso(date: Date): string {
  return date.toISOString();
}

/**
 * Produce a simple, filesystem-safe slug from an input string.
 *
 * Rules:
 * - Trim whitespace
 * - Lowercase
 * - Replace any sequence of non-alphanumeric chars with a single '-'
 * - Remove leading/trailing '-'
 * - Truncate to maxLength characters
 * - Fallback to "untitled" if empty
 */
export function slugify(input: string, maxLength = 80): string {
  const trimmed = input.trim().toLowerCase();

  // Replace any sequence of non alphanumeric characters with a single dash
  const replaced = trimmed.replace(/[^a-z0-9]+/g, "-");

  // Remove leading/trailing dashes
  let slug = replaced.replace(/^-+|-+$/g, "");

  if (!slug) {
    slug = "untitled";
  }

  if (slug.length > maxLength) {
    slug = slug.slice(0, maxLength);
    // If we ended on a dash, trim it
    slug = slug.replace(/-+$/g, "");
  }

  return slug;
}

/**
 * Internal helper: normalize a Date | string into a valid Date, or throw
 * with a clear message if invalid.
 */
function normalizeDateInput(dateOrIso: Date | string): Date {
  if (dateOrIso instanceof Date) {
    const time = dateOrIso.getTime();
    if (Number.isNaN(time)) {
      throw new Error(
        `utils.formatDateForFilename: received invalid Date instance`
      );
    }
    return dateOrIso;
  }

  const date = new Date(dateOrIso);
  const time = date.getTime();
  if (Number.isNaN(time)) {
    throw new Error(
      `utils.formatDateForFilename: invalid date value: "${String(
        dateOrIso
      )}"`
    );
  }

  return date;
}

/**
 * Format a Date or ISO string as YYYY-MM-DD for filenames.
 *
 * Throws a descriptive error if the input cannot be parsed as a valid date.
 */
export function formatDateForFilename(dateOrIso: Date | string): string {
  const date = normalizeDateInput(dateOrIso);

  const year = date.getUTCFullYear();
  const month = (date.getUTCMonth() + 1).toString().padStart(2, "0");
  const day = date.getUTCDate().toString().padStart(2, "0");

  return `${year}-${month}-${day}`;
}

/**
 * Take an ID (e.g., UUID) and return a short prefix variant for filenames.
 * Default length is 8 characters.
 */
export function shortId(id: string, length = 8): string {
  if (!id) {
    throw new Error(`utils.shortId: id must be a non-empty string`);
  }

  if (length <= 0) {
    throw new Error(`utils.shortId: length must be > 0`);
  }

  return id.slice(0, length);
}

/**
 * Build a canonical filename for a KnowledgeNode JSON file.
 *
 * Convention (MVP):
 *   YYYY-MM-DD-node-<slug>-<shortId>.json
 *
 * - date part comes from createdAt (ISO)
 * - slug comes from title or "node"
 * - shortId is the first N chars of the id
 */
export function buildNodeFilename(input: {
  createdAt: string;
  id: string;
  title?: string | null;
}): string {
  const { createdAt, id, title } = input;

  const datePart = formatDateForFilename(createdAt);
  const slugPart = slugify(title ?? "node");
  const idPart = shortId(id);

  return `${datePart}-node-${slugPart}-${idPart}.json`;
}

/**
 * Build a canonical filename for a ConversationLog JSON file.
 *
 * Convention (MVP):
 *   YYYY-MM-DD-convo-<slug>-<shortId>.json
 */
export function buildConversationFilename(input: {
  createdAt: string;
  id: string;
  title?: string | null;
}): string {
  const { createdAt, id, title } = input;

  const datePart = formatDateForFilename(createdAt);
  const slugPart = slugify(title ?? "conversation");
  const idPart = shortId(id);

  return `${datePart}-convo-${slugPart}-${idPart}.json`;
}

/**
 * Build a canonical filename for a SourceDocument JSON record.
 *
 * Convention (MVP):
 *   YYYY-MM-DD-doc-<slug>-<shortId>.json
 *
 * This is primarily for future use when we persist document metadata
 * or ingestion summaries separately.
 */
export function buildSourceDocumentFilename(input: {
  createdAt: string;
  id: string;
  title?: string | null;
}): string {
  const { createdAt, id, title } = input;

  const datePart = formatDateForFilename(createdAt);
  const slugPart = slugify(title ?? "document");
  const idPart = shortId(id);

  return `${datePart}-doc-${slugPart}-${idPart}.json`;
}

/**
 * Safely parse a JSON string.
 * - On success: returns the parsed value typed as T.
 * - On failure: returns null (does not throw).
 */
export function safeJsonParse<T>(input: string): T | null {
  try {
    return JSON.parse(input) as T;
  } catch {
    return null;
  }
}

/**
 * Safely stringify a value as JSON with configurable spacing.
 * - On success: returns a JSON string.
 * - On failure (e.g., circular refs): throws with a descriptive message.
 */
export function safeJsonStringify(value: unknown, space = 2): string {
  try {
    return JSON.stringify(value, null, space);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : String(err ?? "unknown error");
    throw new Error(
      `utils.safeJsonStringify: failed to stringify value. Original error: ${message}`
    );
  }
}

/**
 * Exhaustiveness guard for discriminated unions.
 *
 * Use in switch statements to ensure all cases are handled:
 *
 *   switch (node.type) {
 *     case "note":
 *     case "summary":
 *       // ...
 *       break;
 *     default:
 *       assertNever(node.type, "Unhandled KnowledgeNodeType");
 *   }
 */
export function assertNever(x: never, message?: string): never {
  const base = `utils.assertNever: reached impossible code path`;
  if (message) {
    throw new Error(`${base}. ${message}. Value: ${JSON.stringify(x)}`);
  }
  throw new Error(`${base}. Value: ${JSON.stringify(x)}`);
}
