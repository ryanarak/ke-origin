// scripts/debug-drive-root.ts
//
// Low-level diagnostic script to see what the service account can actually see.

import { google } from "googleapis";
import { config } from "../config/env";

async function main() {
  console.log("=== Debug Drive Root ===");
  console.log("projectId:", config.google.projectId);
  console.log("serviceAccount:", config.google.serviceAccount.client_email);
  console.log("KEORIGIN_DRIVE_ROOT_FOLDER_ID:", config.keOrigin.driveRootFolderId);
  console.log("KEORIGIN_DRIVE_SHARED_ID:", process.env.KEORIGIN_DRIVE_SHARED_ID || "<not set>");

  const auth = new google.auth.JWT({
    email: config.google.serviceAccount.client_email,
    key: config.google.serviceAccount.private_key,
    scopes: ["https://www.googleapis.com/auth/drive"],
  });

  const drive = google.drive({ version: "v3", auth });

  // 1) List first 10 files visible to the service account
  console.log("\n[1] Listing first 10 visible files (all drives)...");
  try {
    const res = await drive.files.list({
      pageSize: 10,
      fields: "files(id, name, parents)",
      corpora: "allDrives",
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
    });
    console.log("Visible files:");
    console.log(JSON.stringify(res.data.files, null, 2));
  } catch (err: any) {
    console.error("files.list(allDrives) failed:");
    console.error(err.response?.data || err);
  }

  // 2) Try to GET the supposed root folder directly
  console.log("\n[2] Trying files.get on KEORIGIN_DRIVE_ROOT_FOLDER_ID...");
  try {
    const res = await drive.files.get({
      fileId: config.keOrigin.driveRootFolderId,
      supportsAllDrives: true,
      fields: "id, name, parents, driveId, mimeType",
    });
    console.log("Root folder info:");
    console.log(JSON.stringify(res.data, null, 2));
  } catch (err: any) {
    console.error("files.get(rootFolderId) FAILED:");
    console.error(err.response?.data || err);
  }

  // 3) Try to list children of the KE-Origin shared drive itself (using shared drive ID)
  if (process.env.KEORIGIN_DRIVE_SHARED_ID) {
    console.log("\n[3] Listing top-level of shared drive KEORIGIN_DRIVE_SHARED_ID...");
    try {
      const res = await drive.files.list({
        pageSize: 10,
        fields: "files(id, name, parents)",
        corpora: "drive",
        driveId: process.env.KEORIGIN_DRIVE_SHARED_ID,
        includeItemsFromAllDrives: true,
        supportsAllDrives: true,
        q: "trashed = false",
      });
      console.log("Shared drive top-level files:");
      console.log(JSON.stringify(res.data.files, null, 2));
    } catch (err: any) {
      console.error("files.list in shared drive FAILED:");
      console.error(err.response?.data || err);
    }
  } else {
    console.log("\n[3] KEORIGIN_DRIVE_SHARED_ID not set, skipping shared-drive listing.");
  }

  console.log("\n=== Debug complete ===");
}

main().catch((err) => {
  console.error("UNCAUGHT ERROR in debug-drive-root.ts:");
  console.error(err);
  process.exit(1);
});
