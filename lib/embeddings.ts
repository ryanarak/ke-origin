// lib/embeddings.ts
//
// KE-Origin OpenAI Embedding Wrapper
// ----------------------------------
// - Single, stable interface for text → vector operations
// - Hides OpenAI SDK details, model names, retries, and batch logic
// - All other modules should import from here instead of using OpenAI directly

import OpenAI from "openai";
import { config, isDev } from "../config/env";

// ----- Types & Public Model Info -------------------------------------------

export interface EmbeddingModelInfo {
  provider: "openai";
  model: string;
  dimensions?: number; // optional; can be filled in later if needed
}

// NOTE: Centralized model choice for the whole system.
// Change this in *one place* if you ever swap models.
// You can later wire this to an env var if desired.
const EMBEDDING_MODEL = "text-embedding-3-small";

export const embeddingModelInfo: EmbeddingModelInfo = {
  provider: "openai",
  model: EMBEDDING_MODEL,
  // dimensions: 1536, // optional – fill in if you want to assert length
};

// Batch / retry tuning
const MAX_BATCH_SIZE = 128;
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 200;

// ----- Internal: OpenAI client singleton -----------------------------------

let openaiClientSingleton: OpenAI | null = null;

function getOpenAIClient(): OpenAI {
  if (openaiClientSingleton) return openaiClientSingleton;

  // config.env.ts already validated that the API key exists.
  openaiClientSingleton = new OpenAI({
    apiKey: config.openai.apiKey,
  });

  logDev(
    "Initialized OpenAI client for embeddings with model:",
    EMBEDDING_MODEL
  );

  return openaiClientSingleton;
}

// ----- Internal: Dev logger ------------------------------------------------

function logDev(...args: unknown[]) {
  if (!isDev) return;
  // eslint-disable-next-line no-console
  console.log("[Embeddings]", ...args);
}

// ----- Internal: Retry helper ----------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRetries<T>(
  fn: () => Promise<T>,
  operationName: string
): Promise<T> {
  let attempt = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      if (attempt > 0) {
        logDev(
          `${operationName}: retry attempt ${attempt} of ${MAX_RETRIES}`
        );
      }

      const result = await fn();
      return result;
    } catch (err) {
      attempt += 1;

      const anyErr = err as any;
      const status = anyErr?.status ?? anyErr?.code;
      const message = anyErr?.message ?? String(err);

      const isRetryable =
        status === 429 ||
        (typeof status === "number" && status >= 500 && status < 600) ||
        anyErr?.cause?.code === "ETIMEDOUT";

      if (!isRetryable || attempt > MAX_RETRIES) {
        throw new Error(
          [
            `${operationName} failed after ${attempt} attempt(s).`,
            `Retryable=${isRetryable}.`,
            `Model=${EMBEDDING_MODEL}.`,
            `Root error: ${message}`,
          ].join(" ")
        );
      }

      const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
      logDev(
        `${operationName}: transient error (status=${status}). ` +
          `Backing off for ${delay}ms before retry.`
      );
      await sleep(delay);
    }
  }
}

// ----- Internal: OpenAI embeddings call ------------------------------------

async function callOpenAIEmbeddings(
  inputs: string[]
): Promise<number[][]> {
  if (inputs.length === 0) {
    throw new Error("callOpenAIEmbeddings: inputs array is empty.");
  }

  const client = getOpenAIClient();

  return withRetries(async () => {
    logDev(
      "Calling OpenAI embeddings",
      `count=${inputs.length}`,
      `model=${EMBEDDING_MODEL}`
    );

    const response = await client.embeddings.create({
      model: EMBEDDING_MODEL,
      input: inputs,
    });

    if (!response.data || response.data.length !== inputs.length) {
      throw new Error(
        [
          "Embedding response length mismatch.",
          `Expected=${inputs.length} Actual=${response.data?.length ?? 0}.`,
        ].join(" ")
      );
    }

    const vectors = response.data.map((item, idx) => {
      if (!item.embedding || !Array.isArray(item.embedding)) {
        throw new Error(
          `Embedding response missing embedding array for index ${idx}.`
        );
      }
      return item.embedding as number[];
    });

    return vectors;
  }, `embedBatch(model=${EMBEDDING_MODEL}, count=${inputs.length})`);
}

// ----- Public API: embedText -----------------------------------------------

/**
 * Compute a single embedding vector for a piece of text.
 *
 * Usage:
 *   const vector = await embedText("Hello KE-Origin");
 */
export async function embedText(text: string): Promise<number[]> {
  const trimmed = text?.trim();
  if (!trimmed) {
    throw new Error("embedText: input text is empty or whitespace-only.");
  }

  const [vector] = await embedBatch([trimmed]);
  return vector;
}

// ----- Public API: embedBatch ----------------------------------------------

/**
 * Compute embeddings for a batch of texts.
 *
 * The returned array is guaranteed to:
 * - have the same length as `texts`
 * - be in the same order as `texts`
 */
export async function embedBatch(
  texts: string[]
): Promise<number[][]> {
  if (!Array.isArray(texts) || texts.length === 0) {
    throw new Error("embedBatch: texts array is empty.");
  }

  // Normalize and validate
  const normalized = texts.map((t, idx) => {
    const trimmed = (t ?? "").trim();
    if (!trimmed) {
      throw new Error(
        `embedBatch: text at index ${idx} is empty or whitespace-only.`
      );
    }
    return trimmed;
  });

  // If small enough, one shot
  if (normalized.length <= MAX_BATCH_SIZE) {
    return callOpenAIEmbeddings(normalized);
  }

  // Otherwise, chunk into batches
  const results: number[][] = [];
  for (let i = 0; i < normalized.length; i += MAX_BATCH_SIZE) {
    const chunk = normalized.slice(i, i + MAX_BATCH_SIZE);
    logDev(
      `embedBatch: processing chunk ${i / MAX_BATCH_SIZE + 1} ` +
        `(${chunk.length} items)`
    );

    const chunkVectors = await callOpenAIEmbeddings(chunk);
    results.push(...chunkVectors);
  }

  if (results.length !== normalized.length) {
    throw new Error(
      [
        "embedBatch: final output length mismatch.",
        `Expected=${normalized.length} Actual=${results.length}`,
      ].join(" ")
    );
  }

  return results;
}

// ----- Optional helper: quick self-test runner -----------------------------
// This is NOT executed automatically; it's here for manual debugging.
// You can run it via ts-node if you want a quick smoke test.
//
// Example:
//   npx ts-node lib/embeddings.ts
//
async function mainSelfTest() {
  if (!isDev) {
    // Avoid accidental production runs.
    return;
  }

  // eslint-disable-next-line no-console
  console.log("Running embeddings self-test in development mode...");

  const sample = "Hello from KE-Origin embeddings self-test.";
  const vec = await embedText(sample);

  // eslint-disable-next-line no-console
  console.log(
    "Model:",
    embeddingModelInfo,
    "Vector length:",
    vec.length,
    "First 5 values:",
    vec.slice(0, 5)
  );
}

// Only run self-test when invoked directly: `ts-node lib/embeddings.ts`
if (require.main === module) {
  // eslint-disable-next-line @typescript-eslint/no-floating-promises
  mainSelfTest();
}
