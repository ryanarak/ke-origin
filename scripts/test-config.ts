// scripts/test-config.ts
import { config, isProd, isDev, isTest } from "../config/env";

function main() {
  console.log("KE-Origin config loaded successfully.");
  console.log("Environment:", config.env.nodeEnv);
  console.log("isProd:", isProd, "isDev:", isDev, "isTest:", isTest);
  console.log("Drive root folder ID is set:", !!config.keOrigin.driveRootFolderId);
  console.log("Google project ID:", config.google.projectId);
  console.log("OpenAI API key length:", config.openai.apiKey.length > 0 ? "OK" : "MISSING");
}

main();
