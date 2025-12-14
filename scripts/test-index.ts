// scripts/test-index.ts
//
// This script seeds the KE-Origin embeddings index with one sample
// EmbeddingRecord, then performs a search to ensure everything works.
//
// After running this, /api/health should report:
//   "index": "ok"
//   "status": "ok"
//
// Run with:
//   npx ts-node scripts/test-index.ts

import { config } from "../config/env";
import { embedText, embeddingModelInfo } from "../lib/embeddings";
import { addEmbedding, search, loadIndex } from "../lib/indexStore";
import { generateId, nowIso } from "../lib/utils";
import { zEmbeddingRecord, EmbeddingRecord } from "../lib/schemas";

async function main() {
  console.log("====================================");
  console.log(" KE-Origin IndexStore Test Script");
  console.log("====================================");
  console.log(`NODE_ENV: ${config.env.nodeEnv}`);
  console.log(`Project ID: ${config.google.projectId}`);
  console.log(`Embedding model: ${embeddingModelInfo.model}`);
  console.log("");

  // 1. Create some dummy text to embed.
  const sampleText = "This is a test embedding for KE-Origin indexing.";
  console.log("Step 1: Embedding sample text:");
  console.log("  Text:", sampleText);

  const vector = await embedText(sampleText);
  console.log("  → Vector length:", vector.length);
  console.log("");

  // 2. Build a valid EmbeddingRecord.
  const recordId = generateId();
  const createdAt = nowIso();

  const embeddingRecord: EmbeddingRecord = {
    id: recordId,
    schemaVersion: 1,
    sourceType: "knowledgeNode", // arbitrary for this test
    sourceId: "test-node-" + recordId.slice(0, 8),
    vector,
    createdAt,
    meta: {
      model: embeddingModelInfo.model,
      // optional extras that match schema:
      nodeType: "note",
      sourceRef: "test-index-seed",
    },
  };

  // Validate using Zod to maintain strict integrity.
  zEmbeddingRecord.parse(embeddingRecord);

  console.log("Step 2: Created EmbeddingRecord:");
  console.log(JSON.stringify(embeddingRecord, null, 2));
  console.log("");

  // 3. Save to index.
  console.log("Step 3: Saving embedding to Drive index via addEmbedding...");
  await addEmbedding(embeddingRecord);
  console.log("  ✔ Saved successfully.");
  console.log("");

  // 4. Load the index to confirm record count.
  console.log("Step 4: Loading entire index...");
  const allRecords = await loadIndex();
  console.log(`  Total records in index now: ${allRecords.length}`);
  console.log("");

  // 5. Run a search against the index.
  console.log("Step 5: Running search(queryVector, topK=5)...");
  const results = await search(vector, 5);

  console.log(`  Got ${results.length} search results.`);
  if (results.length > 0) {
    const first = results[0];
    console.log("  Top result:", {
      id: first.record.id,
      sourceId: first.record.sourceId,
      score: first.score,
    });
  } else {
    console.log("  No results returned (this would be unexpected if index has at least one record).");
  }
  console.log("");

  console.log("====================================");
  console.log(" IndexStore Test Complete");
  console.log("====================================");

  console.log("\nNext: Run /api/health again → it should now show:");
  console.log(`  "index": "ok"`);
  console.log(`  "status": "ok"`);
}

// Run main
main().catch((err) => {
  console.error("❌ test-index FAILED.");
  console.error(err);
  process.exit(1);
});
