/**
 * scripts/rebuild-index.ts
 *
 * KE-Origin — Index Sovereignty Failsafe
 *
 * Rebuilds the semantic index from canonical KnowledgeNodes stored on Drive.
 * Source of truth: /KnowledgeNodes/*.json
 * Target:          /Index/embeddings-metadata.json (atomic overwrite)
 */

import "../config/env";

import { listJsonFiles, readJson } from "../lib/driveClient";
import { embedText } from "../lib/embeddings";
import { saveIndex } from "../lib/indexStore";

/* -------------------------------------------------
 * Structural Types (aligned to real schemas)
 * ------------------------------------------------- */
type KnowledgeNode = {
  id: string;
  type: "note" | "summary" | "principle" | "spec" | "log" | "other";
  content: string;
};

type EmbeddingRecord = {
  id: string;
  schemaVersion: number;
  sourceType: "knowledgeNode";
  sourceId: string;
  vector: number[];
  createdAt: string;
  meta: {
    model: string;
    nodeType: KnowledgeNode["type"];
    sourceRef: string;
  };
};

/* -------------------------------------------------
 * Utilities
 * ------------------------------------------------- */
function nowIso(): string {
  return new Date().toISOString();
}

function isFiniteVector(vec: unknown): vec is number[] {
  return (
    Array.isArray(vec) &&
    vec.length > 0 &&
    vec.every((n) => typeof n === "number" && Number.isFinite(n))
  );
}

/* -------------------------------------------------
 * Main
 * ------------------------------------------------- */
async function main() {
  const startedAt = nowIso();
  const t0 = Date.now();

  console.log("KE-Origin — Rebuild Index");
  console.log("Source: /KnowledgeNodes");
  console.log("Target: /Index/embeddings-metadata.json");
  console.log("Started:", startedAt);
  console.log("");

  /* ---------------------------------------------
   * 1. Discover KnowledgeNodes
   * --------------------------------------------- */
  const files = await listJsonFiles("knowledgeNodes");

  if (files.length === 0) {
    console.warn("[WARN] No KnowledgeNodes found. Index will be empty.");
  }

  // Deterministic order
  files.sort((a, b) => a.name.localeCompare(b.name));

  const records: EmbeddingRecord[] = [];
  let skipped = 0;

  /* ---------------------------------------------
   * 2. Validate → Embed → Build Records
   * --------------------------------------------- */
  for (const file of files) {
    const filename = file.name;

    try {
      const raw = await readJson<unknown>("knowledgeNodes", filename);
      if (!raw) {
        console.warn(`[SKIP] File disappeared during read: ${filename}`);
        skipped++;
        continue;
      }

      // Minimal structural validation (intentionally no Zod coupling)
      if (
        typeof (raw as any).id !== "string" ||
        typeof (raw as any).type !== "string" ||
        typeof (raw as any).content !== "string"
      ) {
        console.warn(`[SKIP] Invalid KnowledgeNode structure: ${filename}`);
        skipped++;
        continue;
      }

      const node = raw as KnowledgeNode;

      const vector = await embedText(node.content);
      if (!isFiniteVector(vector)) {
        throw new Error(`Embedding returned invalid vector for ${filename}`);
      }

      const record: EmbeddingRecord = {
        id: node.id,
        schemaVersion: 1,
        sourceType: "knowledgeNode",
        sourceId: node.id,
        vector,
        createdAt: nowIso(),
        meta: {
          model: "text-embedding-3-small",
          nodeType: node.type,
          sourceRef: filename,
        },
      };

      records.push(record);
    } catch (err: any) {
      console.error(`[ERROR] Failed processing ${filename}`);
      console.error(err?.message || err);
      console.error("Aborting rebuild to prevent partial index.");
      process.exit(1);
    }
  }

  /* ---------------------------------------------
   * 3. Atomic Index Replacement
   * --------------------------------------------- */
  console.log("");
  console.log(`[WRITE] Replacing index with ${records.length} records...`);
  await saveIndex(records);

  /* ---------------------------------------------
   * 4. Report
   * --------------------------------------------- */
  const finishedAt = nowIso();
  const totalMs = Date.now() - t0;

  console.log("");
  console.log("Rebuild complete.");
  console.log(`Files scanned: ${files.length}`);
  console.log(`Indexed:       ${records.length}`);
  console.log(`Skipped:       ${skipped}`);
  console.log(`Total time:    ${totalMs}ms`);
  console.log(`Finished:      ${finishedAt}`);
}

/* -------------------------------------------------
 * Entrypoint
 * ------------------------------------------------- */
main().catch((err) => {
  console.error("[FATAL] Unhandled error during index rebuild.");
  console.error(err?.stack || err);
  process.exit(1);
});
