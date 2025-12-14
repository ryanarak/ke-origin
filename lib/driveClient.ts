// lib/driveClient.ts
//
// Google Drive I/O backbone for KE-Origin.
// - Authenticates using the service account from config/env.ts
// - Resolves / creates core KE-Origin subfolders under the root
// - Provides high-level JSON helpers: saveJson, readJson, listJsonFiles, etc.
// - All other modules should use this instead of touching googleapis directly.

import { google, drive_v3 } from "googleapis";
import { config, isDev } from "../config/env";

export type DriveFolderKey =
  | "knowledgeNodes"
  | "conversationLogs"
  | "uploads"
  | "index";

export interface DriveFileMetadata {
  id: string;
  name: string;
  mimeType: string;
  createdTime?: string;
  modifiedTime?: string;
}

// Optional shared drive ID (for logging / debugging only).
const SHARED_DRIVE_ID = process.env.KEORIGIN_DRIVE_SHARED_ID;

// Logical folder names -> actual subfolder names in Drive
const DRIVE_SUBFOLDERS: Record<DriveFolderKey, string> = {
  knowledgeNodes: "KnowledgeNodes",
  conversationLogs: "ConversationLogs",
  uploads: "Uploads",
  index: "Index",
};

// In-memory cache of subfolder IDs for this process lifetime
const folderIdCache: Partial<Record<DriveFolderKey, string>> = {};

// Singleton Google Drive client
let driveClientSingleton: drive_v3.Drive | null = null;

function getDriveClient(): drive_v3.Drive {
  if (driveClientSingleton) return driveClientSingleton;

  const { serviceAccount } = config.google;

  // Modern JWT constructor: use options object
  const auth = new google.auth.JWT({
    email: serviceAccount.client_email,
    key: serviceAccount.private_key,
    scopes: ["https://www.googleapis.com/auth/drive"],
  });

  driveClientSingleton = google.drive({ version: "v3", auth });
  return driveClientSingleton;
}

/**
 * Simple dev-only logger for Drive operations.
 */
function logDev(...args: unknown[]) {
  if (isDev) {
    // eslint-disable-next-line no-console
    console.log("[DriveClient]", ...args);
  }
}

/**
 * Extract and format raw Drive API error details for debugging.
 */
function formatDriveError(err: unknown): string {
  const anyErr = err as any;
  const parts: string[] = [];

  if (anyErr?.message) {
    parts.push(`message=${anyErr.message}`);
  }

  const responseData = anyErr?.response?.data;
  if (responseData) {
    try {
      parts.push(`responseData=${JSON.stringify(responseData)}`);
    } catch {
      // ignore JSON issues
    }
  }

  if (anyErr?.errors) {
    try {
      parts.push(`errors=${JSON.stringify(anyErr.errors)}`);
    } catch {
      // ignore
    }
  }

  const code = anyErr?.code ?? anyErr?.response?.status;
  if (code) {
    parts.push(`code=${code}`);
  }

  return parts.join(" | ");
}

// Common options for list calls that work with shared drives.
const DRIVE_LIST_BASE = {
  supportsAllDrives: true,
  includeItemsFromAllDrives: true,
  corpora: "allDrives" as const,
};

/**
 * Ensure that a subfolder with the given logical key exists under the KE-Origin root folder.
 * Returns the subfolder's Drive ID, using an in-memory cache for subsequent calls.
 */
async function ensureSubfolderId(folderKey: DriveFolderKey): Promise<string> {
  if (folderIdCache[folderKey]) {
    return folderIdCache[folderKey] as string;
  }

  const drive = getDriveClient();
  const rootFolderId = config.keOrigin.driveRootFolderId;
  const subfolderName = DRIVE_SUBFOLDERS[folderKey];

  const query = [
    `'${rootFolderId}' in parents`,
    `name = '${subfolderName}'`,
    "mimeType = 'application/vnd.google-apps.folder'",
    "trashed = false",
  ].join(" and ");

  try {
    const res = await drive.files.list({
      ...DRIVE_LIST_BASE,
      q: query,
      fields: "files(id, name)",
      pageSize: 1,
    });

    const files = res.data.files || [];
    if (files.length > 0 && files[0].id) {
      const foundId = files[0].id;
      folderIdCache[folderKey] = foundId;
      logDev(
        "Resolved existing folder:",
        folderKey,
        subfolderName,
        foundId,
        "(sharedDrive:",
        SHARED_DRIVE_ID,
        ")"
      );
      return foundId;
    }
  } catch (err) {
    throw new Error(
      [
        `Drive error: failed to search for subfolder '${subfolderName}' under root '${rootFolderId}'.`,
        `Shared drive (if set): '${SHARED_DRIVE_ID}'.`,
        `Raw error: ${formatDriveError(err)}`,
      ].join(" ")
    );
  }

  // Folder not found -> create it (MVP behavior).
  try {
    const createRes = await drive.files.create({
      requestBody: {
        name: subfolderName,
        parents: [rootFolderId],
        mimeType: "application/vnd.google-apps.folder",
      },
      fields: "id, name",
      supportsAllDrives: true,
    });

    const newId = createRes.data.id;
    if (!newId) {
      throw new Error(
        `Drive error: created subfolder '${subfolderName}' but no ID was returned.`
      );
    }

    folderIdCache[folderKey] = newId;
    logDev(
      "Created new folder:",
      folderKey,
      subfolderName,
      newId,
      "(sharedDrive:",
      SHARED_DRIVE_ID,
      ")"
    );
    return newId;
  } catch (err) {
    throw new Error(
      [
        `Drive error: failed to create subfolder '${subfolderName}' under root '${rootFolderId}'.`,
        `Ensure the service account has Manager access to the KE-Origin shared drive and that KEORIGIN_DRIVE_ROOT_FOLDER_ID is the inner 'KE-Origin' folder ID.`,
        `Raw error: ${formatDriveError(err)}`,
      ].join(" ")
    );
  }
}

/**
 * Find a file by name inside a specific folder.
 * Returns the file metadata if found, otherwise null.
 */
async function findFileInFolderByName(
  folderId: string,
  filename: string
): Promise<DriveFileMetadata | null> {
  const drive = getDriveClient();

  const query = [
    `'${folderId}' in parents`,
    `name = '${filename}'`,
    "trashed = false",
  ].join(" and ");

  try {
    const res = await drive.files.list({
      ...DRIVE_LIST_BASE,
      q: query,
      fields: "files(id, name, mimeType, createdTime, modifiedTime)",
      pageSize: 1,
    });

    const file = res.data.files?.[0];
    if (!file || !file.id || !file.name || !file.mimeType) {
      return null;
    }

    return {
      id: file.id,
      name: file.name,
      mimeType: file.mimeType,
      createdTime: file.createdTime ?? undefined,
      modifiedTime: file.modifiedTime ?? undefined,
    };
  } catch (err) {
    throw new Error(
      [
        `Drive error: failed to search for file '${filename}' in folder '${folderId}'.`,
        `Raw error: ${formatDriveError(err)}`,
      ].join(" ")
    );
  }
}

/**
 * Create or update a JSON file with the given name in a folder.
 */
async function createOrUpdateJsonFile(
  folderId: string,
  filename: string,
  data: unknown
): Promise<void> {
  const drive = getDriveClient();
  const jsonString = JSON.stringify(data, null, 2);
  const mimeType = "application/json";

  // Check if the file already exists
  const existing = await findFileInFolderByName(folderId, filename);

  if (existing) {
    logDev("Updating JSON file in Drive:", filename, "folder:", folderId);
    try {
      await drive.files.update({
        fileId: existing.id,
        media: {
          mimeType,
          body: jsonString,
        },
        supportsAllDrives: true,
      });
      return;
    } catch (err) {
      throw new Error(
        [
          `Drive error: failed to update JSON file '${filename}' (id: ${existing.id}).`,
          `Raw error: ${formatDriveError(err)}`,
        ].join(" ")
      );
    }
  }

  // Otherwise, create a new file
  logDev("Creating new JSON file in Drive:", filename, "folder:", folderId);
  try {
    await drive.files.create({
      requestBody: {
        name: filename,
        parents: [folderId],
        mimeType,
      },
      media: {
        mimeType,
        body: jsonString,
      },
      supportsAllDrives: true,
    });
  } catch (err) {
    throw new Error(
      [
        `Drive error: failed to create JSON file '${filename}' in folder '${folderId}'.`,
        `Raw error: ${formatDriveError(err)}`,
      ].join(" ")
    );
  }
}

/**
 * Download and parse a JSON file by name from a folder.
 * Returns the parsed JSON object or null if the file does not exist.
 */
async function downloadJsonFile<T>(
  folderId: string,
  filename: string
): Promise<T | null> {
  const drive = getDriveClient();

  const metadata = await findFileInFolderByName(folderId, filename);
  if (!metadata) {
    logDev("JSON file not found in Drive:", filename, "folder:", folderId);
    return null;
  }

  logDev("Downloading JSON file from Drive:", filename, "folder:", folderId);

  try {
    const res = await drive.files.get(
      {
        fileId: metadata.id,
        alt: "media",
        supportsAllDrives: true,
      },
      { responseType: "json" }
    );

    const data = res.data as unknown;

    if (typeof data === "string") {
      return JSON.parse(data) as T;
    }

    return data as T;
  } catch (err) {
    throw new Error(
      [
        `Drive error: failed to download JSON file '${filename}' (id: ${metadata.id}).`,
        `Raw error: ${formatDriveError(err)}`,
      ].join(" ")
    );
  }
}

/**
 * Public API: Save JSON data into a logical KE-Origin folder with the given filename.
 */
export async function saveJson(
  folder: DriveFolderKey,
  filename: string,
  data: unknown
): Promise<void> {
  const folderId = await ensureSubfolderId(folder);
  await createOrUpdateJsonFile(folderId, filename, data);
}

/**
 * Public API: Read JSON data from a logical KE-Origin folder with the given filename.
 * Returns the parsed JSON typed as T, or null if file does not exist.
 */
export async function readJson<T>(
  folder: DriveFolderKey,
  filename: string
): Promise<T | null> {
  const folderId = await ensureSubfolderId(folder);
  const result = await downloadJsonFile<T>(folderId, filename);
  return result;
}

/**
 * Public API: List JSON files in a logical KE-Origin folder.
 */
export async function listJsonFiles(
  folder: DriveFolderKey
): Promise<DriveFileMetadata[]> {
  const drive = getDriveClient();
  const folderId = await ensureSubfolderId(folder);

  const query = [
    `'${folderId}' in parents`,
    "mimeType = 'application/json'",
    "trashed = false",
  ].join(" and ");

  try {
    const res = await drive.files.list({
      ...DRIVE_LIST_BASE,
      q: query,
      fields: "files(id, name, mimeType, createdTime, modifiedTime)",
      pageSize: 1000,
    });

    const files = res.data.files || [];
    return files
      .filter((f) => f.id && f.name && f.mimeType)
      .map((f) => ({
        id: f.id as string,
        name: f.name as string,
        mimeType: f.mimeType as string,
        createdTime: f.createdTime ?? undefined,
        modifiedTime: f.modifiedTime ?? undefined,
      }));
  } catch (err) {
    throw new Error(
      [
        `Drive error: failed to list JSON files in folder '${folderId}' (logical: ${folder}).`,
        `Raw error: ${formatDriveError(err)}`,
      ].join(" ")
    );
  }
}

/**
 * Public API: Get metadata for a file by name in a logical KE-Origin folder.
 */
export async function getFileMetadataByName(
  folder: DriveFolderKey,
  filename: string
): Promise<DriveFileMetadata | null> {
  const folderId = await ensureSubfolderId(folder);
  const metadata = await findFileInFolderByName(folderId, filename);
  return metadata;
}

/**
 * Convenience wrapper specifically for the Uploads folder.
 */
export async function getUploadFileMetadataByName(
  filename: string
): Promise<DriveFileMetadata | null> {
  return getFileMetadataByName("uploads", filename);
}

/**
 * Optional ping function to verify Drive connectivity and root folder access.
 * Shared-drive safe: uses the Index subfolder resolution.
 */
export async function pingDrive(): Promise<boolean> {
  try {
    const indexFolderId = await ensureSubfolderId("index");
    logDev(
      "Drive ping successful via Index folder:",
      indexFolderId,
      "(sharedDrive:",
      SHARED_DRIVE_ID,
      ")"
    );
    return true;
  } catch (err) {
    throw new Error(
      [
        "Drive error: pingDrive failed. Check KEORIGIN_DRIVE_SHARED_ID, KEORIGIN_DRIVE_ROOT_FOLDER_ID and service account permissions.",
        `Raw error: ${formatDriveError(err)}`,
      ].join(" ")
    );
  }
}
