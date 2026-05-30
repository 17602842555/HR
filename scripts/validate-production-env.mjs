import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { parse } from "dotenv";

const placeholderFragments = [
  "admin123456",
  "changeme",
  "change-me",
  "change_before",
  "dev-only-change-me",
  "example",
  "local-commercial-demo-secret",
  "oa_dev_password",
  "placeholder",
  "replace-with",
  "todo"
];

export const requiredProductionEnvKeys = Object.freeze([
  "APP_ENV",
  "NODE_ENV",
  "POSTGRES_DB",
  "POSTGRES_USER",
  "POSTGRES_PASSWORD",
  "JWT_SECRET",
  "COOKIE_MAX_AGE_SECONDS",
  "AUTH_FAILED_LOGIN_LIMIT",
  "AUTH_FAILED_LOGIN_WINDOW_MS",
  "AUTH_FAILED_LOGIN_MAX_KEYS",
  "FILE_STORAGE_DRIVER",
  "BACKUP_DIR",
  "FILE_MAX_UPLOAD_BYTES",
  "IMPORT_MAX_HTML_BYTES",
  "API_BODY_LIMIT_BYTES",
  "WEB_ORIGIN",
  "RUN_DB_SEED",
  "VITE_REQUIRE_API",
  "VITE_DEMO_FALLBACK"
]);

function boolValue(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

function isBlank(value) {
  return String(value ?? "").trim() === "";
}

function hasPlaceholder(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return true;
  return placeholderFragments.some((fragment) => normalized.includes(fragment));
}

function positiveInteger(env, key, errors) {
  const value = String(env[key] ?? "").trim();
  if (!/^\d+$/.test(value) || Number.parseInt(value, 10) <= 0) {
    errors.push(`${key} must be a positive integer.`);
    return 0;
  }
  return Number.parseInt(value, 10);
}

function requiredBodyLimit(fileMaxUploadBytes, importMaxHtmlBytes) {
  return Math.max(
    1024 * 1024,
    Math.ceil(fileMaxUploadBytes * 1.5) + 64 * 1024,
    importMaxHtmlBytes + 64 * 1024
  );
}

function parseOrigins(value) {
  return String(value || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function validateHttpsEndpoint(value, label, errors) {
  let parsed = null;
  try {
    parsed = new URL(String(value || ""));
  } catch {
    errors.push(`${label} must be a valid HTTPS URL.`);
    return null;
  }
  if (parsed.protocol !== "https:") {
    errors.push(label === "OBJECT_STORAGE_ENDPOINT" ? "OBJECT_STORAGE_ENDPOINT must use https in production." : `${label} must use https in production.`);
  }
  if (["localhost", "127.0.0.1", "0.0.0.0"].includes(parsed.hostname)) {
    errors.push(`${label} must not point at local development hosts.`);
  }
  if (parsed.hostname === "example.com" || parsed.hostname.endsWith(".example.com")) {
    errors.push(`${label} must not use example.com template hosts.`);
  }
  return parsed;
}

function validateDurableBackupPath(env, key, errors) {
  const value = String(env[key] || "").trim();
  if (isBlank(value)) {
    errors.push(`${key} is required for production backup and recovery.`);
    return;
  }
  if (!isAbsolute(value)) {
    errors.push(`${key} must be an absolute off-app durable backup path.`);
    return;
  }
  if (value === "/tmp" || value.startsWith("/tmp/") || value === "/var/tmp" || value.startsWith("/var/tmp/")) {
    errors.push(`${key} must not use temporary storage.`);
  }
  if (value === "/app" || value.startsWith("/app/")) {
    errors.push(`${key} must not point inside the application container directory.`);
  }
}

export function parseProductionEnvText(text) {
  return parse(String(text || ""));
}

export function validateProductionEnv(env) {
  const errors = [];
  const warnings = [];

  requiredProductionEnvKeys.forEach((key) => {
    if (isBlank(env[key])) errors.push(`${key} is required.`);
  });

  if (env.APP_ENV !== "production") errors.push("APP_ENV must be production.");
  if (env.NODE_ENV !== "production") errors.push("NODE_ENV must be production.");

  if (hasPlaceholder(env.POSTGRES_PASSWORD) || String(env.POSTGRES_PASSWORD || "").length < 16) {
    errors.push("POSTGRES_PASSWORD must be a non-placeholder secret with at least 16 characters.");
  }
  if (hasPlaceholder(env.JWT_SECRET) || String(env.JWT_SECRET || "").length < 32) {
    errors.push("JWT_SECRET must be a non-placeholder secret with at least 32 characters.");
  }

  const origins = parseOrigins(env.WEB_ORIGIN);
  if (origins.length === 0) {
    errors.push("WEB_ORIGIN must list at least one explicit HTTPS origin.");
  }
  origins.forEach((origin) => {
    let parsed = null;
    try {
      parsed = new URL(origin);
    } catch {
      errors.push(`WEB_ORIGIN contains an invalid URL: ${origin}`);
      return;
    }
    if (parsed.protocol !== "https:") errors.push(`WEB_ORIGIN must use https in production: ${origin}`);
    if (["localhost", "127.0.0.1", "0.0.0.0"].includes(parsed.hostname)) {
      errors.push(`WEB_ORIGIN must not point at local development hosts in production: ${origin}`);
    }
    if (parsed.hostname === "oa.example.com" || parsed.hostname.endsWith(".example.com")) {
      errors.push(`WEB_ORIGIN must not use example.com template hosts: ${origin}`);
    }
    if (origin.includes("*")) errors.push("WEB_ORIGIN must not contain wildcards.");
  });

  const fileStorageDriver = String(env.FILE_STORAGE_DRIVER || "local").trim() || "local";
  if (!["local", "s3"].includes(fileStorageDriver)) {
    errors.push("FILE_STORAGE_DRIVER must be local or s3.");
  }
  if (fileStorageDriver === "local") {
    if (isBlank(env.FILE_STORAGE_DIR)) errors.push("FILE_STORAGE_DIR is required when FILE_STORAGE_DRIVER=local.");
    if (!isAbsolute(String(env.FILE_STORAGE_DIR || ""))) {
      errors.push("FILE_STORAGE_DIR must be an absolute path backed by production storage.");
    }
    if ([".local-files", "/tmp", "/var/tmp"].includes(String(env.FILE_STORAGE_DIR || "").trim())) {
      errors.push("FILE_STORAGE_DIR must not use temporary or local demo storage.");
    }
    validateDurableBackupPath(env, "FILE_BACKUP_DIR", errors);
  }
  if (fileStorageDriver === "s3") {
    ["OBJECT_STORAGE_ENDPOINT", "OBJECT_STORAGE_BUCKET", "OBJECT_STORAGE_REGION", "OBJECT_STORAGE_ACCESS_KEY_ID", "OBJECT_STORAGE_SECRET_ACCESS_KEY"].forEach((key) => {
      if (isBlank(env[key])) errors.push(`${key} is required when FILE_STORAGE_DRIVER=s3.`);
    });
    if (!isBlank(env.OBJECT_STORAGE_ENDPOINT)) validateHttpsEndpoint(env.OBJECT_STORAGE_ENDPOINT, "OBJECT_STORAGE_ENDPOINT", errors);
    ["OBJECT_STORAGE_BUCKET", "OBJECT_STORAGE_REGION", "OBJECT_STORAGE_ACCESS_KEY_ID", "OBJECT_STORAGE_SECRET_ACCESS_KEY"].forEach((key) => {
      if (hasPlaceholder(env[key])) errors.push(`${key} must be non-placeholder for object storage.`);
    });
    if (!isBlank(env.OBJECT_STORAGE_SECRET_ACCESS_KEY) && String(env.OBJECT_STORAGE_SECRET_ACCESS_KEY).length < 16) {
      errors.push("OBJECT_STORAGE_SECRET_ACCESS_KEY must be at least 16 characters.");
    }
  }
  validateDurableBackupPath(env, "BACKUP_DIR", errors);

  const fileMaxUploadBytes = positiveInteger(env, "FILE_MAX_UPLOAD_BYTES", errors);
  const importMaxHtmlBytes = positiveInteger(env, "IMPORT_MAX_HTML_BYTES", errors);
  const apiBodyLimitBytes = positiveInteger(env, "API_BODY_LIMIT_BYTES", errors);
  positiveInteger(env, "COOKIE_MAX_AGE_SECONDS", errors);
  positiveInteger(env, "AUTH_FAILED_LOGIN_LIMIT", errors);
  positiveInteger(env, "AUTH_FAILED_LOGIN_WINDOW_MS", errors);
  positiveInteger(env, "AUTH_FAILED_LOGIN_MAX_KEYS", errors);

  const minimumBodyLimit = requiredBodyLimit(fileMaxUploadBytes, importMaxHtmlBytes);
  if (apiBodyLimitBytes > 0 && apiBodyLimitBytes < minimumBodyLimit) {
    errors.push(`API_BODY_LIMIT_BYTES must be at least ${minimumBodyLimit} for configured upload/import limits.`);
  }

  if (String(env.VITE_REQUIRE_API || "").trim() !== "1") {
    errors.push("VITE_REQUIRE_API must be 1 for production builds.");
  }
  if (String(env.VITE_DEMO_FALLBACK || "").trim() !== "0") {
    errors.push("VITE_DEMO_FALLBACK must be 0 for production builds.");
  }

  const runDbSeed = boolValue(env.RUN_DB_SEED);
  if (runDbSeed && !boolValue(env.ALLOW_PRODUCTION_SEED)) {
    errors.push("RUN_DB_SEED=1 requires ALLOW_PRODUCTION_SEED=1 after an explicit production bootstrap approval.");
  }
  if (runDbSeed && (hasPlaceholder(env.DEFAULT_ADMIN_PASSWORD) || String(env.DEFAULT_ADMIN_PASSWORD || "").length < 12)) {
    errors.push("DEFAULT_ADMIN_PASSWORD must be a non-placeholder password with at least 12 characters when RUN_DB_SEED=1.");
  }
  if (!isBlank(env.DEFAULT_ADMIN_PASSWORD) && hasPlaceholder(env.DEFAULT_ADMIN_PASSWORD)) {
    errors.push("DEFAULT_ADMIN_PASSWORD must not contain default or placeholder values.");
  }

  if (String(env.TRUST_PROXY || "0").trim() === "1") {
    warnings.push("TRUST_PROXY=1 is valid only behind a trusted reverse proxy that overwrites forwarded headers.");
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    summary: {
      origins,
      runDbSeed,
      fileStorageDriver,
      fileStorageDir: env.FILE_STORAGE_DIR || "",
      backupDir: env.BACKUP_DIR || "",
      fileBackupDir: env.FILE_BACKUP_DIR || "",
      objectStorageBucket: fileStorageDriver === "s3" ? env.OBJECT_STORAGE_BUCKET || "" : "",
      apiBodyLimitBytes,
      minimumBodyLimit
    }
  };
}

export function loadProductionEnvFile(path = ".env.production") {
  const envPath = resolve(process.cwd(), path);
  if (!existsSync(envPath)) {
    throw new Error(`Production env file does not exist: ${envPath}`);
  }
  return {
    path: envPath,
    env: parseProductionEnvText(readFileSync(envPath, "utf8"))
  };
}

async function main(argv = process.argv.slice(2)) {
  const envFile = argv.find((arg) => !arg.startsWith("--")) || ".env.production";
  const json = argv.includes("--json");

  try {
    const loaded = loadProductionEnvFile(envFile);
    const result = validateProductionEnv(loaded.env);
    const payload = { path: loaded.path, ...result };
    if (json) {
      console.log(JSON.stringify(payload, null, 2));
    } else if (result.ok) {
      console.log(`Production env validation passed: ${loaded.path}`);
      result.warnings.forEach((warning) => console.warn(`Warning: ${warning}`));
    } else {
      console.error(`Production env validation failed: ${loaded.path}`);
      result.errors.forEach((error) => console.error(`- ${error}`));
      result.warnings.forEach((warning) => console.warn(`Warning: ${warning}`));
    }
    process.exitCode = result.ok ? 0 : 1;
  } catch (error) {
    if (json) {
      console.log(JSON.stringify({ ok: false, errors: [error.message], warnings: [] }, null, 2));
    } else {
      console.error(error.message);
    }
    process.exitCode = 1;
  }
}

if (import.meta.url === new URL(process.argv[1], "file:").href) {
  main();
}
