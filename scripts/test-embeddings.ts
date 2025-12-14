// scripts/test-embeddings.ts
//
// Smoke test for KE-Origin embedding pipeline.
// - Verifies config + OpenAI key are wired correctly.
// - Calls embedText and embedBatch.
// - Prints model info, vector lengths, and sample values.
//
// Run with:
//   npx ts-node scripts/test-embeddings.ts

import { config, isDev } from "../config/env";
import {
  embedText,
  embedBatch,
  embeddingModelInfo,
} from "../lib/embeddings";

async function main() {
  // Basic config overview
  console.log("====================================");
  console.log("KE-Origin Embeddings Smoke Test");
  console.log("====================================");
  console.log("NODE_ENV:", process.env.NODE_ENV ?? "<undefined>");
  console.log("isDev:", isDev);
  console.log("Project ID:", config.google.projectId);
  console.log("Embedding model info:", embeddingModelInfo);
  console.log("");

  // ---- Test 1: Single text embedding -------------------------------------
  const sampleText = "Hello from KE-Origin embeddings test.";
  console.log("Test 1: embedText(sampleText)");
  console.log("Sample text:", sampleText);

  const singleVector = await embedText(sampleText);

  console.log("Single vector length:", singleVector.length);
  console.log("First 8 values:", singleVector.slice(0, 8));
  console.log("");

  // ---- Test 2: Batch embedding -------------------------------------------
  const queries = [
    "How do I rebuild the KE-Origin index?",
    "What is the core doctrine of KE-Origin?",
    "Summarize the purpose of the Knowledge Engine.",
  ];

  console.log("Test 2: embedBatch(queries)");
  console.log("Batch size:", queries.length);

  const batchVectors = await embedBatch(queries);

  console.log("Got", batchVectors.length, "vectors back.");
  batchVectors.forEach((vec, idx) => {
    console.log(
      `  [${idx}] length=${vec.length}, first 5 values=${vec
        .slice(0, 5)
        .join(", ")}`
    );
  });

  console.log("");
  console.log("✅ Embeddings test completed successfully.");
}

main().catch((err) => {
  console.error("");
  console.error("❌ Embeddings test FAILED.");
  console.error("Error:", err instanceof Error ? err.message : err);
  if (err && typeof err === "object") {
    console.error("Raw error object:", err);
  }
  process.exit(1);
});
