// api/ingest-document.ts
//
// KE-Origin — Document Ingestion (MVP+)
// - Resolves a file from Drive Uploads/ (by driveFileId or filename)
// - MVP supports text/plain only
// - Downloads text, clamps size, writes a SourceDocument record to Index/
// - Optionally creates a summary KnowledgeNode via createNodeInternal()
//   (which embeds + indexes through existing pipeline)
//
// HTTP behavior:
// - POST only
// - Auth via x-keorigin-secret
//
// CLI self-test:
//   npx ts-node api/ingest-document.ts
//   (optionally set KEORIGIN_INGEST_TEST_FILENAME or KEORIGIN_INGEST_TEST_DRIVE_FILE_ID)

import { z } from "zod";
import { google } from "googleapis";

import { config, isDev } from "../config/env";
import { saveJson } from "../lib/driveClient";
import { generateId, nowIso } from "../lib/utils";
import type { KnowledgeNode } from "../lib/schemas";
import { zKnowledgeNode } from "../lib/schemas";
import { createNodeInternal } from "./create-node";

/** -----------------------------
 * Types & Schemas (local, MVP-safe)
 * ------------------------------*/

const SUPPORTED_MIME_TYPES = ["text/plain"] as const;

const zIngestDocumentRequest = z
  .object({
    driveFileId: z.string().min(1).optional(),
    filename: z.string().min(1).optional(),

    title: z.string().min(1).optional(),
    domains: z.array(z.string().min(1)).optional(),
    tags: z.array(z.string().min(1)).optional(),

    createSummaryNode: z.boolean().optional().default(true),
    summaryOverride: z.string().min(1).optional(),

    maxChars: z.number().int().min(1).max(2_000_000).optional().default(80_000),
    nodeType: z
      .enum(["note", "summary", "principle", "spec", "log", "other"])
      .optional()
      .default("summary"),
  })
  .refine((v) => !!v.driveFileId || !!v.filename, {
    message: "Provide either driveFileId or filename.",
    path: ["driveFileId"],
  });

type IngestDocumentRequest = z.infer<typeof zIngestDocumentRequest>;

type IngestStatus = "ok" | "degraded";
type SummaryStatus = "created" | "skipped" | "error";
type IndexStatus = "embedded" | "skipped" | "error";

type IngestDocumentResponse = {
  status: IngestStatus;
  timestamp: string;
  document: {
    id: string;
    name: string;
    mimeType: string;
    size?: number;
    sourceRef: {
      driveFileId: string;
      uploadsFilename?: string;
    };
  };
  sourceDocumentFilename?: string;
  summaryNode?: KnowledgeNode;
  summaryStatus?: SummaryStatus;
  indexStatus?: IndexStatus;
  warnings?: string[];
};

type MinimalReq = {
  method?: string;
  headers?: Record<string, string | string[] | undefined>;
  body?: unknown;
};

type MinimalRes = {
  status: (code: number) => MinimalRes;
  json: (payload: unknown) => void;
  setHeader?: (name: string, value: string) => void;
};

/** -----------------------------
 * Google Drive (direct, read-only for uploads download)
 * We still use lib/driveClient.ts for JSON writes (saveJson).
 * ------------------------------*/

let driveSingleton: ReturnType<typeof google.drive> | null = null;

function getDrive() {
  if (driveSingleton) return driveSingleton;

  const sa = config.google.serviceAccount;

  const auth = new google.auth.JWT({
    email: sa.client_email,
    key: sa.private_key,
    scopes: ["https://www.googleapis.com/auth/drive"],
  });

  driveSingleton = google.drive({ version: "v3", auth });

  if (isDev) {
    // eslint-disable-next-line no-console
    console.log(
      "[IngestDocument] Initialized Google Drive client (direct) for Uploads download."
    );
  }

  return driveSingleton;
}

const UPLOADS_FOLDER_NAME = "Uploads";
const INDEX_FOLDER_KEY = "index"; // known in your system
const SOURCE_DOC_SCHEMA_VERSION = 1;

let uploadsFolderIdCache: string | null = null;

function getSharedDriveIdFromEnv(): string | undefined {
  const v = process.env.KEORIGIN_DRIVE_SHARED_ID;
  return v && v.trim().length > 0 ? v.trim() : undefined;
}

async function resolveUploadsFolderId(): Promise<string> {
  if (uploadsFolderIdCache) return uploadsFolderIdCache;

  const drive = getDrive();
  const rootId = config.keOrigin.driveRootFolderId;
  const sharedDriveId = getSharedDriveIdFromEnv();

  const q = [
    `'${rootId}' in parents`,
    `name='${UPLOADS_FOLDER_NAME.replace(/'/g, "\\'")}'`,
    `mimeType='application/vnd.google-apps.folder'`,
    "trashed=false",
  ].join(" and ");

  const list = await drive.files.list({
    q,
    fields: "files(id,name,mimeType)",
    pageSize: 10,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
    ...(sharedDriveId
      ? { corpora: "drive", driveId: sharedDriveId }
      : { corpora: "allDrives" }),
  });

  const folder = list.data.files?.[0];
  if (!folder?.id) {
    throw new Error(
      `Drive error: could not find '${UPLOADS_FOLDER_NAME}' folder under root folder id=${rootId}.`
    );
  }

  uploadsFolderIdCache = folder.id;

  if (isDev) {
    // eslint-disable-next-line no-console
    console.log(
      `[IngestDocument] Resolved Uploads folder id=${uploadsFolderIdCache} (sharedDrive=${sharedDriveId ?? "n/a"})`
    );
  }

  return uploadsFolderIdCache;
}

type DriveFileMeta = {
  id: string;
  name: string;
  mimeType: string;
  size?: number;
};

async function getFileMetadata(fileId: string): Promise<DriveFileMeta> {
  const drive = getDrive();
  const resp = await drive.files.get({
    fileId,
    fields: "id,name,mimeType,size",
    supportsAllDrives: true,
  });

  const f = resp.data;
  if (!f.id || !f.name || !f.mimeType) {
    throw new Error(`Drive error: incomplete metadata for fileId=${fileId}.`);
  }

  return {
    id: f.id,
    name: f.name,
    mimeType: f.mimeType,
    size: f.size ? Number(f.size) : undefined,
  };
}

async function findUploadByFilename(filename: string): Promise<DriveFileMeta> {
  const drive = getDrive();
  const uploadsFolderId = await resolveUploadsFolderId();
  const sharedDriveId = getSharedDriveIdFromEnv();

  const safeName = filename.replace(/'/g, "\\'");
  const q = [`'${uploadsFolderId}' in parents`, `name='${safeName}'`, "trashed=false"].join(
    " and "
  );

  const list = await drive.files.list({
    q,
    fields: "files(id,name,mimeType,size)",
    pageSize: 10,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
    ...(sharedDriveId
      ? { corpora: "drive", driveId: sharedDriveId }
      : { corpora: "allDrives" }),
  });

  const files = list.data.files ?? [];
  if (files.length === 0) {
    throw new Error(`File not found in Uploads/: filename='${filename}'.`);
  }
  if (files.length > 1) {
    throw new Error(
      `Ambiguous Uploads match: found ${files.length} files named '${filename}'. Use driveFileId instead.`
    );
  }

  const f = files[0];
  if (!f.id || !f.name || !f.mimeType) {
    throw new Error(`Drive error: incomplete search result for '${filename}'.`);
  }

  return {
    id: f.id,
    name: f.name,
    mimeType: f.mimeType,
    size: f.size ? Number(f.size) : undefined,
  };
}

async function downloadTextFile(fileId: string): Promise<string> {
  const drive = getDrive();

  const resp = await drive.files.get(
    { fileId, alt: "media", supportsAllDrives: true },
    { responseType: "arraybuffer" }
  );

  const buf = Buffer.from(resp.data as ArrayBuffer);
  return buf.toString("utf8");
}

/** -----------------------------
 * SourceDocument record (stored as JSON in Index/)
 * ------------------------------*/

type SourceDocumentRecord = {
  id: string;
  schemaVersion: number;
  driveFileId: string;
  uploadsFilename?: string;
  mimeType: string;
  title?: string;
  createdAt: string;
  ingestedAt: string;
  meta?: {
    size?: number;
  };
};

function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function buildSourceDocumentFilename(createdAtIso: string, title: string, id: string): string {
  const day = createdAtIso.slice(0, 10);
  const slug = slugify(title || "document");
  const short = id.replace(/-/g, "").slice(0, 8);
  return `${day}-doc-${slug}-${short}.json`;
}

/** -----------------------------
 * Deterministic MVP summarizer (no LLM)
 * ------------------------------*/
function deterministicSummaryFromText(text: string, maxLines = 12): string {
  const clean = text.replace(/\r/g, "").trim();
  const lines = clean.split("\n").map((l) => l.trim()).filter(Boolean);

  const head = lines.slice(0, maxLines).join("\n");
  const charCount = clean.length;

  return [
    "MVP Summary (no LLM):",
    "This summary is a deterministic digest. Provide summaryOverride or add lib/llm.ts later for better summaries.",
    "",
    `Document size: ${charCount} chars`,
    "",
    "Preview:",
    head.length > 0 ? head : "(empty document)",
  ].join("\n");
}

/** -----------------------------
 * Core internal ingestion logic
 * ------------------------------*/
async function ingestDocumentInternal(req: IngestDocumentRequest): Promise<IngestDocumentResponse> {
  const warnings: string[] = [];
  const timestamp = nowIso();

  // 1) Resolve file
  const fileMeta = req.driveFileId
    ? await getFileMetadata(req.driveFileId)
    : await findUploadByFilename(req.filename!);

  // 2) MIME check
  if (!SUPPORTED_MIME_TYPES.includes(fileMeta.mimeType as any)) {
    throw new Error(
      `Unsupported MIME type: ${fileMeta.mimeType}. MVP supports: ${SUPPORTED_MIME_TYPES.join(", ")}`
    );
  }

  // 3) Download
  let text = await downloadTextFile(fileMeta.id);

  // 4) Clamp
  const maxChars = req.maxChars ?? 80_000;
  if (text.length > maxChars) {
    warnings.push(`Document text truncated from ${text.length} to ${maxChars} chars (maxChars).`);
    text = text.slice(0, maxChars);
  }

  // 5) Write SourceDocument record to Index/
  const sourceDocId = generateId();
  const createdAt = nowIso();
  const recordTitle = req.title ?? fileMeta.name;

  const sourceDoc: SourceDocumentRecord = {
    id: sourceDocId,
    schemaVersion: SOURCE_DOC_SCHEMA_VERSION,
    driveFileId: fileMeta.id,
    uploadsFilename: req.filename ?? fileMeta.name,
    mimeType: fileMeta.mimeType,
    title: req.title ?? fileMeta.name,
    createdAt,
    ingestedAt: createdAt,
    meta: { size: fileMeta.size },
  };

  const sourceDocumentFilename = buildSourceDocumentFilename(createdAt, recordTitle, sourceDocId);

  await saveJson(INDEX_FOLDER_KEY as any, sourceDocumentFilename, sourceDoc);

  if (isDev) {
    // eslint-disable-next-line no-console
    console.log(
      `[IngestDocument] Saved SourceDocument record to Index/: ${sourceDocumentFilename}`
    );
  }

  // 6) Optional summary node via createNodeInternal (which embeds + indexes)
  let summaryNode: KnowledgeNode | undefined;
  let summaryStatus: SummaryStatus = req.createSummaryNode === false ? "skipped" : "created";
  let indexStatus: IndexStatus = req.createSummaryNode === false ? "skipped" : "embedded";
  let overallStatus: IngestStatus = "ok";

  if (req.createSummaryNode !== false) {
    try {
      const summaryText = req.summaryOverride ?? deterministicSummaryFromText(text);
      const nodeTitle = req.title ?? fileMeta.name;

      const created = await createNodeInternal({
        content: summaryText,
        title: nodeTitle,
        type: req.nodeType ?? "summary",
        sourceType: "document",
        sourceRef: sourceDocumentFilename,
        tags: req.tags,
        domains: req.domains,
      } as any);

      summaryNode = zKnowledgeNode.parse(created.node);

      // IMPORTANT:
      // Your CreateNodeInternalResult type may not declare indexStatus.
      // So we safely read it as optional runtime metadata.
      const maybeIndexStatus = (created as any).indexStatus as IndexStatus | undefined;
      indexStatus = maybeIndexStatus ?? "embedded";

      summaryStatus = "created";
    } catch (err) {
      summaryStatus = "error";
      indexStatus = "error";
      overallStatus = "degraded";
      warnings.push(`Summary node creation/indexing failed: ${(err as Error).message}`);
    }
  }

  return {
    status: overallStatus,
    timestamp,
    document: {
      id: fileMeta.id,
      name: fileMeta.name,
      mimeType: fileMeta.mimeType,
      size: fileMeta.size,
      sourceRef: {
        driveFileId: fileMeta.id,
        uploadsFilename: req.filename ?? fileMeta.name,
      },
    },
    sourceDocumentFilename,
    summaryNode,
    summaryStatus,
    indexStatus,
    ...(warnings.length ? { warnings } : {}),
  };
}

/** -----------------------------
 * HTTP handler
 * ------------------------------*/
export default async function handler(req: MinimalReq, res: MinimalRes) {
  try {
    if (req.method !== "POST") {
      res.setHeader?.("Allow", "POST");
      res.status(405).json({
        error: "method_not_allowed",
        allowed: ["POST"],
      });
      return;
    }

    const secretHeader =
      req.headers?.["x-keorigin-secret"] ??
      req.headers?.["X-KEORIGIN-SECRET"] ??
      req.headers?.["X-Keorigin-Secret"];

    const secret = Array.isArray(secretHeader) ? secretHeader[0] : secretHeader;

    if (!secret || secret !== config.keOrigin.sharedSecret) {
      res.status(401).json({
        error: "unauthorized",
        message: "Invalid or missing KE-Origin shared secret.",
      });
      return;
    }

    const parsed = zIngestDocumentRequest.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "invalid_payload",
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      });
      return;
    }

    const payload = await ingestDocumentInternal(parsed.data);
    res.status(200).json(payload);
  } catch (err) {
    res.status(500).json({
      error: "internal_error",
      message: (err as Error).message,
    });
  }
}

/** -----------------------------
 * CLI self-test
 * ------------------------------*/
async function runCliSelfTest() {
  // eslint-disable-next-line no-console
  console.log("Running api/ingest-document.ts as a CLI self-test...");
  // eslint-disable-next-line no-console
  console.log("====================================");
  // eslint-disable-next-line no-console
  console.log(" KE-Origin IngestDocument Self-Test");
  // eslint-disable-next-line no-console
  console.log("====================================");
  // eslint-disable-next-line no-console
  console.log("NODE_ENV:", config.env.nodeEnv);
  // eslint-disable-next-line no-console
  console.log("Project ID:", config.google.projectId);

  const testDriveFileId = process.env.KEORIGIN_INGEST_TEST_DRIVE_FILE_ID;
  const testFilename = process.env.KEORIGIN_INGEST_TEST_FILENAME;

  const req: IngestDocumentRequest = zIngestDocumentRequest.parse({
    driveFileId: testDriveFileId && testDriveFileId.trim().length ? testDriveFileId.trim() : undefined,
    filename: (!testDriveFileId || testDriveFileId.trim().length === 0) ? (testFilename ?? "example.txt") : undefined,
    title: "CLI Ingest Test Document",
    createSummaryNode: true,
    maxChars: 80_000,
    nodeType: "summary",
    tags: ["ingest-test", "ke-origin"],
    domains: ["ke-origin"],
  });

  // eslint-disable-next-line no-console
  console.log("\nPayload:", {
    driveFileId: req.driveFileId ?? null,
    filename: req.filename ?? null,
    createSummaryNode: req.createSummaryNode,
    maxChars: req.maxChars,
  });

  const result = await ingestDocumentInternal(req);

  // eslint-disable-next-line no-console
  console.log("\nResult payload:", JSON.stringify(result, null, 2));

  // eslint-disable-next-line no-console
  console.log("\n====================================");
  // eslint-disable-next-line no-console
  console.log(" IngestDocument Self-Test Complete");
  // eslint-disable-next-line no-console
  console.log("====================================");
}

if (require.main === module) {
  runCliSelfTest().catch((err) => {
    // eslint-disable-next-line no-console
    console.error("IngestDocument self-test FAILED:", err);
    process.exit(1);
  });
}
