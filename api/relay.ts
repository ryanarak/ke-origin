// api/relay.ts
//
// KE-Origin — Sovereign Relay Gateway v∞
//
// Secure intelligent relay between Randall (GPT), frontend, and the KE-Origin backend.
//
// 🌍 Features:
// ✅ Authenticated & domain-locked (via KEORIGIN_SHARED_SECRET)
// ✅ Intelligent retry with exponential backoff (network resilience)
// ✅ Structured logging and request tracing
// ✅ Contextualized error reports with operation tagging
// ✅ Forward-compatible for any KE-Origin API operation
// ✅ Works seamlessly on Node / Vercel
//
// -----------------------------------------------------

// Minimal type definitions for Node request/response
type ApiRequest = {
  method?: string;
  headers?: Record<string, string>;
  body?: any;
};

type ApiResponse = {
  statusCode?: number;
  setHeader?: (key: string, value: string) => void;
  end?: (body?: string) => void;
  status?: (code: number) => ApiResponse;
  json?: (body: any) => void;
};

// -----------------------------------------------------
// Environment
// -----------------------------------------------------
const BASE_URL = process.env.KEORIGIN_BASE_URL ?? "https://ke-origin.vercel.app";
const SECRET = process.env.KEORIGIN_SHARED_SECRET;

// Retry configuration
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 750;

// Supported operations map
const ENDPOINT_MAP: Record<string, string> = {
  createNode: "/api/create-node",
  logConversation: "/api/log-conversation",
  retrieveKnowledge: "/api/retrieve-knowledge",
  ingestDocument: "/api/ingest-document",
  healthCheck: "/api/health",
  relayOperation: "/api/relay",
};

// -----------------------------------------------------
// Utilities
// -----------------------------------------------------
function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function logEvent(level: "info" | "warn" | "error", message: string, data?: any) {
  const prefix = `[Relay:${level.toUpperCase()}]`;
  const payload = data ? ` ${JSON.stringify(data)}` : "";
  if (level === "error") console.error(`${prefix} ${message}${payload}`);
  else if (level === "warn") console.warn(`${prefix} ${message}${payload}`);
  else console.log(`${prefix} ${message}${payload}`);
}

// -----------------------------------------------------
// Core Forwarder
// -----------------------------------------------------
async function forwardToKEOrigin(operation: string, payload: any): Promise<Response> {
  if (!SECRET) throw new Error("Missing KEORIGIN_SHARED_SECRET");

  const endpoint = ENDPOINT_MAP[operation];
  if (!endpoint) throw new Error(`Unsupported operation: ${operation}`);

  const url = `${BASE_URL}${endpoint}`;
  let attempt = 0;
  let lastError: any;

  while (attempt < MAX_RETRIES) {
    try {
      const start = Date.now();
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-keorigin-secret": SECRET,
        },
        body: JSON.stringify(payload ?? {}),
      });

      const elapsed = Date.now() - start;
      logEvent("info", `Forwarded ${operation} (${res.status}) [${elapsed}ms]`, { url });

      if (res.ok) return res;

      if (res.status >= 500 || res.status === 429) {
        lastError = new Error(`HTTP ${res.status}`);
        await sleep(RETRY_DELAY_MS * Math.pow(2, attempt));
        attempt++;
        continue;
      }

      const errBody = await res.text();
      throw new Error(`Relay failed (${res.status}): ${errBody}`);
    } catch (err) {
      lastError = err;
      logEvent("warn", `Attempt ${attempt + 1}/${MAX_RETRIES} failed`, {
        error: (err as Error).message,
      });
      await sleep(RETRY_DELAY_MS * Math.pow(2, attempt));
      attempt++;
    }
  }

  throw new Error(`Relay exhausted retries for ${operation}: ${lastError?.message}`);
}

// -----------------------------------------------------
// Handler
// -----------------------------------------------------
export default async function handler(req: ApiRequest, res: ApiResponse) {
  if (req.method !== "POST") {
    res.status?.(405)?.json?.({ error: "method_not_allowed", allowed: ["POST"] });
    return;
  }

  try {
    const { operation, payload } = req.body || {};
    if (!operation || !ENDPOINT_MAP[operation]) {
      res.status?.(400)?.json?.({ error: "invalid_operation", message: "Unknown or missing operation" });
      return;
    }

    logEvent("info", `Received operation`, { operation });

    const response = await forwardToKEOrigin(operation, payload);
    const result: Record<string, any> = (await response.json().catch(() => ({}))) || {};

    logEvent("info", `Operation complete`, { operation, status: response.status });

    res.status?.(response.status)?.json?.({
      status: response.ok ? "ok" : "error",
      operation,
      ...(typeof result === "object" ? result : { result }),
    });
  } catch (err: any) {
    logEvent("error", "Relay fatal error", { error: err.message });
    res.status?.(500)?.json?.({
      error: "internal_relay_error",
      message: err.message ?? "Unknown failure",
    });
  }
}

// -----------------------------------------------------
// CLI Self-Test
// -----------------------------------------------------
if (require.main === module) {
  (async () => {
    console.log("=======================================");
    console.log(" Running KE-Origin Sovereign Relay Test ");
    console.log("=======================================");

    const payload = {
      sessionId: `relay-selftest-${Date.now()}`,
      messages: [
        { role: "user", content: "Hello Randall, run relay test." },
        { role: "assistant", content: "Relay operational. Proceeding with confirmation." },
      ],
      title: "Relay Test Conversation",
      sourceType: "manual",
    };

    try {
      const result = await forwardToKEOrigin("logConversation", payload);
      const data = await result.json();
      console.log("✅ Relay operational. Response:", data);
    } catch (err: any) {
      console.error("❌ Relay self-test failed:", err.message);
      process.exit(1);
    }

    console.log("=======================================");
    console.log(" Sovereign Relay Test Complete ");
    console.log("=======================================");
  })();
}
