// scripts/list-uploads.ts
//
// Lists files inside Drive folder: KE-Origin/Uploads
// Uses config/env.ts for credentials + Drive root/shared IDs.
//
// Run:
//   npx ts-node scripts/list-uploads.ts
//   npx ts-node scripts/list-uploads.ts --limit 50

import { google, drive_v3 } from "googleapis";
import { config } from "../config/env";

type DriveFileLite = {
  id?: string | null;
  name?: string | null;
  mimeType?: string | null;
  size?: string | null;
  modifiedTime?: string | null;
};

function parseArgInt(flag: string, fallback: number): number {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return fallback;
  const raw = process.argv[idx + 1];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function getDriveClient(): drive_v3.Drive {
  const sa = config.google.serviceAccount;

  const auth = new google.auth.JWT({
    email: sa.client_email,
    key: sa.private_key,
    scopes: ["https://www.googleapis.com/auth/drive"],
  });

  return google.drive({ version: "v3", auth });
}

async function findChildFolderIdByName(params: {
  drive: drive_v3.Drive;
  parentId: string;
  name: string;
  sharedDriveId?: string;
}): Promise<string> {
  const { drive, parentId, name, sharedDriveId } = params;

  // Query for a folder named `name` directly under `parentId`.
  const q = [
    `'${parentId}' in parents`,
    `name = '${name.replace(/'/g, "\\'")}'`,
    `mimeType = 'application/vnd.google-apps.folder'`,
    "trashed = false",
  ].join(" and ");

  const resp = await drive.files.list({
    q,
    fields: "files(id,name)",
    pageSize: 10,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
    corpora: sharedDriveId ? "drive" : "allDrives",
    driveId: sharedDriveId,
  });

  const files = resp.data.files ?? [];
  const match = files[0];

  if (!match?.id) {
    throw new Error(
      `Uploads folder not found. Expected folder named "${name}" under root folderId="${parentId}".`
    );
  }

  return match.id;
}

async function listUploads(limit: number): Promise<DriveFileLite[]> {
  const drive = getDriveClient();

  // You already have ROOT folder id in config.
  const rootFolderId = config.keOrigin.driveRootFolderId;

  // Optional shared drive id: some projects store this in env.ts, some don't.
  // If your env.ts doesn't include it, this will just be undefined.
  const sharedDriveId =
    (config as unknown as { keOrigin?: { driveSharedId?: string } }).keOrigin
      ?.driveSharedId ?? undefined;

  const uploadsFolderId = await findChildFolderIdByName({
    drive,
    parentId: rootFolderId,
    name: "Uploads",
    sharedDriveId,
  });

  const resp = await drive.files.list({
    q: `'${uploadsFolderId}' in parents and trashed = false`,
    fields: "files(id,name,mimeType,size,modifiedTime)",
    pageSize: limit,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
    corpora: sharedDriveId ? "drive" : "allDrives",
    driveId: sharedDriveId,
    orderBy: "modifiedTime desc",
  });

  return (resp.data.files ?? []) as DriveFileLite[];
}

async function main(): Promise<void> {
  const limit = parseArgInt("--limit", 25);

  console.log("====================================");
  console.log(" KE-Origin Uploads Folder Listing");
  console.log("====================================");
  console.log("NODE_ENV:", config.env.nodeEnv);
  console.log("Project ID:", config.google.projectId);
  console.log("Root Folder ID:", config.keOrigin.driveRootFolderId);
  console.log("Limit:", limit);
  console.log("");

  const files = await listUploads(limit);

  if (files.length === 0) {
    console.log("Uploads/ is empty (no visible files).");
    return;
  }

  console.log(`Found ${files.length} file(s) in Uploads/ (most recent first):\n`);

  for (const f of files) {
    console.log(
      [
        `- name: ${f.name ?? "(no name)"}`,
        `  id: ${f.id ?? "(no id)"}`,
        `  mimeType: ${f.mimeType ?? "(unknown)"}`,
        `  size: ${f.size ?? "(n/a)"}`,
        `  modifiedTime: ${f.modifiedTime ?? "(n/a)"}`,
      ].join("\n")
    );
  }

  console.log("\nTip:");
  console.log(
    "Use a file name from this list (or the id) as input to api/ingest-document.ts."
  );
}

if (require.main === module) {
  main().catch((err) => {
    console.error("list-uploads FAILED:", (err as Error).message);
    process.exit(1);
  });
}
