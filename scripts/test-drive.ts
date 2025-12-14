// scripts/test-drive.ts
//
// Diagnostic script for KE-Origin Google Drive integration.
// - Verifies config
// - Pings Drive via pingDrive()
// - Writes a test JSON file into Index
// - Reads it back
// - Lists JSON files in Index
// - Logs rich diagnostic info on any failure

import { pingDrive, saveJson, readJson, listJsonFiles } from "../lib/driveClient";
import { config } from "../config/env";

function logSection(title: string) {
  console.log("\n==============================");
  console.log(title);
  console.log("==============================");
}

async function main() {
  logSection("KE-Origin Config Overview");
  console.log("NODE_ENV:", config.env.nodeEnv);
  console.log("isProd:", config.env.isProd, "isDev:", config.env.isDev);
  console.log("Google projectId:", config.google.projectId);
  console.log(
    "Drive root folder ID:",
    config.keOrigin.driveRootFolderId || "<not set>"
  );
  console.log(
    "Shared drive ID (optional):",
    process.env.KEORIGIN_DRIVE_SHARED_ID || "<not set>"
  );
  console.log(
    "Service account email:",
    config.google.serviceAccount.client_email
  );

  logSection("Step 1: Ping Drive (via pingDrive -> ensureSubfolderId('index'))");
  try {
    const ok = await pingDrive();
    console.log("pingDrive() returned:", ok);
  } catch (err) {
    console.error("pingDrive() FAILED with error:");
    console.error(err);
    console.error(
      "\nIf you see messages about 'File not found', double-check:\n" +
        "1) KEORIGIN_DRIVE_ROOT_FOLDER_ID is the inner 'KE-Origin' folder ID inside the shared drive.\n" +
        "2) The service account email has Manager access to the KE-Origin shared drive.\n" +
        "3) KEORIGIN_DRIVE_SHARED_ID (if set) matches the shared drive ID from the URL.\n"
    );
    process.exit(1);
  }

  logSection("Step 2: Write test JSON into Index folder");
  const testFilename = "test-drive-client.json";
  const payload = {
    message: "Hello from KE-Origin drive test",
    timestamp: new Date().toISOString(),
    env: config.env.nodeEnv,
  };

  try {
    await saveJson("index", testFilename, payload);
    console.log("Successfully wrote JSON to Index:", testFilename);
  } catch (err) {
    console.error("saveJson('index', ...) FAILED with error:");
    console.error(err);
    process.exit(1);
  }

  logSection("Step 3: Read back test JSON from Index");
  try {
    const readBack = await readJson<typeof payload>("index", testFilename);
    console.log("Read back value:", readBack);
  } catch (err) {
    console.error("readJson('index', ...) FAILED with error:");
    console.error(err);
    process.exit(1);
  }

  logSection("Step 4: List JSON files in Index");
  try {
    const files = await listJsonFiles("index");
    console.log("Index JSON files count:", files.length);
    console.log(
      "Sample file names:",
      files.slice(0, 10).map((f) => f.name)
    );
  } catch (err) {
    console.error("listJsonFiles('index') FAILED with error:");
    console.error(err);
    process.exit(1);
  }

  logSection("Drive Test Completed");
  console.log("✅ KE-Origin Drive integration looks healthy.");
}

main().catch((err) => {
  console.error("\nUNCAUGHT ERROR in test-drive.ts:");
  console.error(err);
  process.exit(1);
});
