// config/env.ts
//
// Centralized environment configuration for KE-Origin.
// - Reads all required environment variables
// - Validates them with Zod
// - Parses the Google service account JSON
// - Exposes a typed `config` singleton + helpers (`isProd`, `isDev`)
//
// All other modules must import from here and NEVER use `process.env` directly.

import dotenv from "dotenv";

// Load .env and OVERRIDE any existing process.env vars.
// This makes the KE-Origin .env file the single source of truth
// even if the OS/user has conflicting values set (e.g., OPENAI_API_KEY).
dotenv.config({
  override: true,
});

import { z } from "zod";

/**
 * Allowed NODE_ENV values for KE-Origin.
 */
const NodeEnvSchema = z.enum(["development", "production", "test"]);

/**
 * Raw environment variables as read from process.env.
 * Everything is a string at this stage.
 */
const RawEnvSchema = z.object({
  NODE_ENV: NodeEnvSchema.default("development"),

  OPENAI_API_KEY: z
    .string()
    .min(1, "Config error: OPENAI_API_KEY is missing. Set it in your environment."),

  GOOGLE_SERVICE_ACCOUNT_JSON: z
    .string()
    .min(
      1,
      "Config error: GOOGLE_SERVICE_ACCOUNT_JSON is missing. Paste your full service account JSON into this environment variable."
    ),

  KEORIGIN_SHARED_SECRET: z
    .string()
    .min(
      16,
      "Config error: KEORIGIN_SHARED_SECRET is missing or too short. Generate a reasonably long random string and set it."
    ),

  KEORIGIN_DRIVE_ROOT_FOLDER_ID: z
    .string()
    .min(
      1,
      "Config error: KEORIGIN_DRIVE_ROOT_FOLDER_ID is missing. Set it to the Google Drive folder ID of your KE-Origin root."
    ),
});

type RawEnv = z.infer<typeof RawEnvSchema>;

/**
 * Google service account JSON structure.
 * This is the shape we expect when parsing GOOGLE_SERVICE_ACCOUNT_JSON.
 */
const GoogleServiceAccountSchema = z.object({
  type: z.literal("service_account"),
  project_id: z.string(),
  private_key: z.string(),
  client_email: z.string(),
  // We allow additional fields, but we don't require them explicitly.
});

export type GoogleServiceAccount = z.infer<typeof GoogleServiceAccountSchema>;

/**
 * High-level, normalized Config type used across the KE-Origin codebase.
 */
export interface Config {
  openai: {
    apiKey: string;
  };
  google: {
    serviceAccount: GoogleServiceAccount;
    projectId: string;
  };
  keOrigin: {
    sharedSecret: string;
    driveRootFolderId: string;
  };
  env: {
    nodeEnv: z.infer<typeof NodeEnvSchema>;
    isProd: boolean;
    isDev: boolean;
    isTest: boolean;
  };
}

/**
 * Load and validate raw environment variables.
 * Throws a ZodError with a clear, human-readable message if invalid.
 */
function loadRawEnv(): RawEnv {
  const parsed = RawEnvSchema.safeParse({
    NODE_ENV: process.env.NODE_ENV,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    GOOGLE_SERVICE_ACCOUNT_JSON: process.env.GOOGLE_SERVICE_ACCOUNT_JSON,
    KEORIGIN_SHARED_SECRET: process.env.KEORIGIN_SHARED_SECRET,
    KEORIGIN_DRIVE_ROOT_FOLDER_ID: process.env.KEORIGIN_DRIVE_ROOT_FOLDER_ID,
  });

  if (!parsed.success) {
    // Build a readable error message from Zod issues.
    const issues = parsed.error.issues
      .map((issue) => `- ${issue.message}`)
      .join("\n");

    throw new Error(
      [
        "KE-Origin configuration error: one or more required environment variables are invalid or missing.",
        "Fix the following issues:",
        issues,
      ].join("\n")
    );
  }

  return parsed.data;
}

/**
 * Safely parse the GOOGLE_SERVICE_ACCOUNT_JSON env var into a typed object.
 */
function parseServiceAccountJson(rawJson: string): GoogleServiceAccount {
  let parsed: unknown;

  try {
    parsed = JSON.parse(rawJson);
  } catch (err) {
    throw new Error(
      [
        "Config error: GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON.",
        "Ensure you pasted the full service account JSON into the environment variable.",
        `Original error: ${(err as Error).message}`,
      ].join(" ")
    );
  }

  const result = GoogleServiceAccountSchema.safeParse(parsed);

  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `- ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");

    throw new Error(
      [
        "Config error: GOOGLE_SERVICE_ACCOUNT_JSON is missing required fields or has the wrong shape.",
        "Expected fields include: type='service_account', project_id, private_key, client_email.",
        "Details:",
        issues,
      ].join("\n")
    );
  }

  return result.data;
}

/**
 * Build the fully normalized Config object from raw environment variables.
 * This function is executed once at module import time to fail fast if misconfigured.
 */
function buildConfig(): Config {
  const raw = loadRawEnv();

  const serviceAccount = parseServiceAccountJson(raw.GOOGLE_SERVICE_ACCOUNT_JSON);

  const nodeEnv = raw.NODE_ENV;
  const isProd = nodeEnv === "production";
  const isDev = nodeEnv === "development";
  const isTest = nodeEnv === "test";

  const config: Config = {
    openai: {
      apiKey: raw.OPENAI_API_KEY,
    },
    google: {
      serviceAccount,
      projectId: serviceAccount.project_id,
    },
    keOrigin: {
      sharedSecret: raw.KEORIGIN_SHARED_SECRET,
      driveRootFolderId: raw.KEORIGIN_DRIVE_ROOT_FOLDER_ID,
    },
    env: {
      nodeEnv,
      isProd,
      isDev,
      isTest,
    },
  };

  // Optional: minimal, safe logging in development.
  if (isDev) {
    // IMPORTANT: do NOT log secrets.
    // Only log non-sensitive configuration state.
    // eslint-disable-next-line no-console
    console.log(
      "[KE-Origin] Config loaded in development mode.",
      `projectId=${config.google.projectId}`,
      `env=${nodeEnv}`
    );
  }

  return config;
}

/**
 * The singleton Config object, built once when the module is loaded.
 * If configuration is invalid, the process will throw here and fail fast.
 */
export const config: Config = buildConfig();

/**
 * Convenience helpers for environment checks.
 */
export const isProd: boolean = config.env.isProd;
export const isDev: boolean = config.env.isDev;
export const isTest: boolean = config.env.isTest;
