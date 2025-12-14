// scripts/print-openai-key.ts
//
// Prints the OPENAI_API_KEY prefix as *seen by KE-Origin config*.
// This goes through config/env.ts, so .env + override=true apply.

import { config } from "../config/env";

function main() {
  const full = config.openai.apiKey;
  const prefix = full.slice(0, 10);
  const suffix = full.slice(-4);

  console.log("KE-Origin OpenAI key (sanitized):");
  console.log(`  prefix: ${prefix}...${suffix}`);
}

main();
