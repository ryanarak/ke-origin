// lib/indexStore.ts
//
// JSON-backed vector index for KE-Origin.
// - Stores EmbeddingRecord[] in Google Drive under /Index/embeddings-metadata.json
// - Provides addEmbedding, loadIndex, saveIndex, search (cosine similarity)
// - Uses Drive as backing store, with an in-memory cache per process
//
// Everything that wants “find relevant knowledge” should go through this module.

import { z } from "zod";
import { isDev } from "../config/env";
import { nowIso } from "./utils";
import { readJson, saveJson } from "./driveClient";
import { EmbeddingRecord, zEmbeddingRecord } from "./schemas";

/**
 * File name for the JSON index inside the "Index" Drive folder.
 */
const EMBEDDING_INDEX_FILENAME = "embeddings-metadata.json";

/**
 * Current schema version for the embeddings index file format.
 * Bump this if you change the structure of the index file in a breaking way.
 */
const EMBEDDING_INDEX_SCHEMA_VERSION = 1;

/**
 * Dev-only logger for index operations.
 */
function logDev(...args: unknown[]) {
  if (isDev) {
    // eslint-disable-next-line no-console
    console.log("[IndexStore]", ...args);
  }
}

/**
 * Base shape of the index file metadata as stored in Drive.
 * We treat `records` as unknown[] so we can validate each record with zEmbeddingRecord
 * and skip malformed ones without discarding the entire file.
 */
const zEmbeddingIndexMeta = z.object({
  schemaVersion: z.number().int().min(1),
  createdAt: z.string(),
  updatedAt: z.string(),
  records: z.array(z.unknown()),
});

type EmbeddingIndexMeta = z.infer<typeof zEmbeddingIndexMeta>;

/**
 * Complete in-memory representation of the index file:
 * meta + fully-validated EmbeddingRecord[].
 */
export interface EmbeddingIndexFile {
  schemaVersion: number;
  createdAt: string;
  updatedAt: string;
  records: EmbeddingRecord[];
}

/**
 * Internal cached embedding with precomputed norm for fast cosine similarity.
 */
interface CachedEmbedding {
  record: EmbeddingRecord;
  norm: number; // ||vector||
}

/**
 * In-memory cache for the index for this process lifetime.
 */
let indexCache:
  | {
      fileMeta: {
        schemaVersion: number;
        createdAt: string;
        updatedAt: string;
      };
      embeddings: CachedEmbedding[];
    }
  | null = null;

/**
 * Public search result type: EmbeddingRecord + cosine similarity score.
 */
export interface SearchResult {
  record: EmbeddingRecord;
  score: number; // cosine similarity, higher = more relevant
}

/**
 * Compute Euclidean norm of a vector.
 * Returns 0 for empty vectors (or vectors of all zeros).
 */
function computeNorm(vec: number[]): number {
  let sumSq = 0;
  for (let i = 0; i < vec.length; i += 1) {
    const v = vec[i];
    sumSq += v * v;
  }
  return Math.sqrt(sumSq);
}

/**
 * Compute dot product of two vectors of equal length.
 * Assumes lengths are equal; caller is responsible for checking.
 */
function dotProduct(a: number[], b: number[]): number {
  let acc = 0;
  const len = a.length;
  for (let i = 0; i < len; i += 1) {
    acc += a[i] * b[i];
  }
  return acc;
}

/**
 * Load the raw index file from Drive (if any).
 * - Returns null if the file does not exist.
 * - Validates the meta fields and then validates each record individually.
 * - Skips malformed records with warnings in dev mode.
 * - Throws if the overall structure is invalid.
 */
async function loadIndexFileFromDrive(): Promise<EmbeddingIndexFile | null> {
  const raw = await readJson<unknown>("index", EMBEDDING_INDEX_FILENAME);

  if (raw == null) {
    // File does not exist yet.
    logDev("No embeddings index file found in Drive; will initialize new index.");
    return null;
  }

  const metaParsed = zEmbeddingIndexMeta.safeParse(raw);
  if (!metaParsed.success) {
    const issues = metaParsed.error.issues
      .map((issue) => `- ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");

    throw new Error(
      [
        `indexStore.loadIndexFileFromDrive: embeddings index file '${EMBEDDING_INDEX_FILENAME}' is invalid.`,
        "Meta validation failed with:",
        issues,
      ].join("\n")
    );
  }

  const meta = metaParsed.data;
  const rawRecords = meta.records;
  const records: EmbeddingRecord[] = [];
  let skipped = 0;

  for (const r of rawRecords) {
    const result = zEmbeddingRecord.safeParse(r);
    if (!result.success) {
      skipped += 1;
      if (isDev) {
        const issues = result.error.issues
          .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
          .join("\n");
        // eslint-disable-next-line no-console
        console.warn(
          "[IndexStore] Skipping malformed EmbeddingRecord from index file:",
          `\n${issues}`
        );
      }
      continue;
    }
    records.push(result.data);
  }

  if (isDev) {
    logDev(
      "Loaded embeddings index file from Drive.",
      `schemaVersion=${meta.schemaVersion}`,
      `totalRawRecords=${rawRecords.length}`,
      `validRecords=${records.length}`,
      `skippedMalformed=${skipped}`
    );
  }

  return {
    schemaVersion: meta.schemaVersion,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    records,
  };
}

/**
 * Write the complete index file (meta + records) to Drive.
 * Updates the `updatedAt` timestamp before saving.
 */
async function saveIndexFileToDrive(file: EmbeddingIndexFile): Promise<void> {
  const updatedAt = nowIso();
  const toWrite: EmbeddingIndexMeta & { records: EmbeddingRecord[] } = {
    schemaVersion: file.schemaVersion,
    createdAt: file.createdAt,
    updatedAt,
    records: file.records,
  };

  await saveJson("index", EMBEDDING_INDEX_FILENAME, toWrite);

  if (isDev) {
    logDev(
      "Saved embeddings index file to Drive.",
      `schemaVersion=${toWrite.schemaVersion}`,
      `records=${toWrite.records.length}`
    );
  }
}

/**
 * Internal helper: construct CachedEmbedding[] from EmbeddingRecord[].
 */
function buildCachedEmbeddings(records: EmbeddingRecord[]): CachedEmbedding[] {
  return records.map((record) => {
    const vec = record.vector;
    if (!Array.isArray(vec) || vec.length === 0) {
      throw new Error(
        `indexStore.buildCachedEmbeddings: EmbeddingRecord '${record.id}' has invalid or empty vector.`
      );
    }
    const norm = computeNorm(vec);
    return { record, norm };
  });
}

/**
 * Ensure the in-memory index cache is loaded.
 * - Reads index file from Drive if not already loaded.
 * - If no file exists, initializes an empty index and saves it.
 */
async function ensureIndexLoaded(): Promise<void> {
  if (indexCache) {
    return;
  }

  const loaded = await loadIndexFileFromDrive();
  if (!loaded) {
    const now = nowIso();
    const empty: EmbeddingIndexFile = {
      schemaVersion: EMBEDDING_INDEX_SCHEMA_VERSION,
      createdAt: now,
      updatedAt: now,
      records: [],
    };

    await saveIndexFileToDrive(empty);

    indexCache = {
      fileMeta: {
        schemaVersion: empty.schemaVersion,
        createdAt: empty.createdAt,
        updatedAt: empty.updatedAt,
      },
      embeddings: [],
    };

    if (isDev) {
      logDev("Initialized new empty embeddings index (0 records).");
    }
    return;
  }

  // Build cached embeddings with norms.
  const embeddings = buildCachedEmbeddings(loaded.records);

  indexCache = {
    fileMeta: {
      schemaVersion: loaded.schemaVersion,
      createdAt: loaded.createdAt,
      updatedAt: loaded.updatedAt,
    },
    embeddings,
  };

  if (isDev) {
    logDev(
      "Index cache initialized from Drive.",
      `records=${embeddings.length}`,
      `schemaVersion=${loaded.schemaVersion}`
    );
  }
}

/**
 * Public: load the current index as an array of EmbeddingRecord.
 * This always uses the in-memory cache, loading from Drive if needed.
 */
export async function loadIndex(): Promise<EmbeddingRecord[]> {
  await ensureIndexLoaded();
  if (!indexCache) {
    // Should never happen due to ensureIndexLoaded.
    throw new Error("indexStore.loadIndex: index cache not initialized.");
  }

  return indexCache.embeddings.map((entry) => entry.record);
}

/**
 * Public: bulk-save a full set of EmbeddingRecords as the entire index.
 * Intended primarily for rebuild-index scripts or major migrations.
 */
export async function saveIndex(records: EmbeddingRecord[]): Promise<void> {
  await ensureIndexLoaded();
  if (!indexCache) {
    throw new Error("indexStore.saveIndex: index cache not initialized.");
  }

  const createdAt = indexCache.fileMeta.createdAt || nowIso();
  const file: EmbeddingIndexFile = {
    schemaVersion: EMBEDDING_INDEX_SCHEMA_VERSION,
    createdAt,
    updatedAt: nowIso(),
    records,
  };

  // Validate records individually before writing.
  const validatedRecords: EmbeddingRecord[] = [];
  for (const r of records) {
    const parsed = zEmbeddingRecord.safeParse(r);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((issue) => `- ${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("\n");
      throw new Error(
        [
          "indexStore.saveIndex: invalid EmbeddingRecord encountered.",
          "Details:",
          issues,
        ].join("\n")
      );
    }
    validatedRecords.push(parsed.data);
  }

  file.records = validatedRecords;

  await saveIndexFileToDrive(file);

  // Update index cache.
  const embeddings = buildCachedEmbeddings(validatedRecords);
  indexCache = {
    fileMeta: {
      schemaVersion: file.schemaVersion,
      createdAt: file.createdAt,
      updatedAt: file.updatedAt,
    },
    embeddings,
  };

  if (isDev) {
    logDev("Index fully replaced via saveIndex.", `records=${embeddings.length}`);
  }
}

/**
 * Public: add or update a single EmbeddingRecord in the index.
 * - If an entry with the same id OR the same (sourceType, sourceId) exists, it is replaced.
 * - Otherwise, the record is appended.
 */
export async function addEmbedding(record: EmbeddingRecord): Promise<void> {
  await ensureIndexLoaded();
  if (!indexCache) {
    throw new Error("indexStore.addEmbedding: index cache not initialized.");
  }

  // Validate the incoming record.
  const parsed = zEmbeddingRecord.safeParse(record);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `- ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new Error(
      ["indexStore.addEmbedding: invalid EmbeddingRecord provided.", "Details:", issues].join(
        "\n"
      )
    );
  }
  const validRecord = parsed.data;

  const currentEmbeddings = indexCache.embeddings;
  const records = currentEmbeddings.map((entry) => entry.record);

  const { id, sourceType, sourceId } = validRecord;

  let replaced = false;
  for (let i = 0; i < records.length; i += 1) {
    const r = records[i];
    if (r.id === id || (r.sourceType === sourceType && r.sourceId === sourceId)) {
      records[i] = validRecord;
      replaced = true;
      break;
    }
  }

  if (!replaced) {
    records.push(validRecord);
  }

  if (isDev) {
    logDev(
      "addEmbedding:",
      `id=${validRecord.id}`,
      `sourceType=${validRecord.sourceType}`,
      `sourceId=${validRecord.sourceId}`,
      replaced ? "action=updated" : "action=added",
      `totalRecords=${records.length}`
    );
  }

  // Persist the updated index via bulk save.
  await saveIndex(records);
}

/**
 * Public: search the index using cosine similarity.
 *
 * - queryVector: embedding of the query text.
 * - topK: maximum number of results to return.
 *
 * Returns an array of { record, score }, sorted by descending score.
 */
export async function search(
  queryVector: number[],
  topK: number
): Promise<SearchResult[]> {
  await ensureIndexLoaded();
  if (!indexCache) {
    throw new Error("indexStore.search: index cache not initialized.");
  }

  const { embeddings } = indexCache;

  if (!Array.isArray(queryVector) || queryVector.length === 0) {
    throw new Error("indexStore.search: invalid queryVector (must be non-empty number array).");
  }

  if (embeddings.length === 0) {
    if (isDev) {
      logDev("search: index is empty; returning no results.");
    }
    return [];
  }

  // Ensure vector dimension consistency.
  const dim = embeddings[0].record.vector.length;
  if (queryVector.length !== dim) {
    throw new Error(
      `indexStore.search: queryVector dimension (${queryVector.length}) does not match index dimension (${dim}).`
    );
  }

  const queryNorm = computeNorm(queryVector);
  if (queryNorm === 0) {
    throw new Error("indexStore.search: queryVector has zero norm (all zeros).");
  }

  // Compute cosine similarity for each embedding.
  const scored: SearchResult[] = [];

  for (const entry of embeddings) {
    const vec = entry.record.vector;
    const norm = entry.norm;

    if (norm === 0) {
      // Skip or give score 0; zero-norm vectors are not useful.
      continue;
    }

    const score = dotProduct(queryVector, vec) / (queryNorm * norm);
    scored.push({ record: entry.record, score });
  }

  // Sort by descending score.
  scored.sort((a, b) => b.score - a.score);

  const limited = scored.slice(0, Math.max(0, topK));

  if (isDev) {
    const best = limited[0];
    logDev(
      "search:",
      `scanned=${embeddings.length}`,
      `topK=${topK}`,
      `returned=${limited.length}`,
      best ? `bestScore=${best.score.toFixed(4)}` : "bestScore=N/A"
    );
  }

  return limited;
}

/**
 * Optional: self-test entry point when running this file directly with ts-node.
 *
 * Example:
 *   npx ts-node lib/indexStore.ts
 */
async function mainSelfTest() {
  // eslint-disable-next-line no-console
  console.log("=== KE-Origin IndexStore Self-Test ===");

  try {
    const recordsBefore = await loadIndex();
    // eslint-disable-next-line no-console
    console.log(
      "Index loaded.",
      `records=${recordsBefore.length}`,
      `(index file: ${EMBEDDING_INDEX_FILENAME})`
    );
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("IndexStore self-test FAILED:", (err as Error).message);
    return;
  }

  // eslint-disable-next-line no-console
  console.log("IndexStore self-test completed without fatal errors.");
}

// This check works under ts-node/CommonJS.
declare const require: NodeRequire;
declare const module: NodeModule;

if (typeof require !== "undefined" && require.main === module) {
  // Run the self-test when executed directly.
  // eslint-disable-next-line @typescript-eslint/no-floating-promises
  mainSelfTest();
}
