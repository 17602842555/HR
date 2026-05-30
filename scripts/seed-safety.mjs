import { isAbsolute } from "node:path";
import { validateNewPassword } from "../server/src/modules/auth/password-policy.mjs";

export const defaultSeedAdminPassword = "admin123456";
const localHostnames = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1"]);
const placeholderFragments = Object.freeze([
  "changeme",
  "change-me",
  "example",
  "placeholder",
  "replace-with",
  "todo"
]);

function isProductionEnv(env = process.env) {
  return env.NODE_ENV === "production" || env.APP_ENV === "production";
}

function hasPlaceholder(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return !normalized || placeholderFragments.some((fragment) => normalized.includes(fragment));
}

function isTemporaryPath(path = "") {
  const normalized = String(path || "").trim();
  return normalized === "/tmp"
    || normalized.startsWith("/tmp/")
    || normalized === "/var/tmp"
    || normalized.startsWith("/var/tmp/");
}

function assertProductionObjectStorageSeedConfig(env) {
  ["OBJECT_STORAGE_ENDPOINT", "OBJECT_STORAGE_BUCKET", "OBJECT_STORAGE_REGION", "OBJECT_STORAGE_ACCESS_KEY_ID", "OBJECT_STORAGE_SECRET_ACCESS_KEY"].forEach((key) => {
    if (!String(env[key] || "").trim()) {
      throw new Error(`Production seed requires ${key} when FILE_STORAGE_DRIVER=s3.`);
    }
    if (key !== "OBJECT_STORAGE_ENDPOINT" && hasPlaceholder(env[key])) {
      throw new Error(`Production seed requires non-placeholder ${key} when FILE_STORAGE_DRIVER=s3.`);
    }
  });

  let endpoint = null;
  try {
    endpoint = new URL(String(env.OBJECT_STORAGE_ENDPOINT || ""));
  } catch {
    throw new Error("Production seed OBJECT_STORAGE_ENDPOINT must be a valid HTTPS URL.");
  }
  if (endpoint.protocol !== "https:") {
    throw new Error("Production seed OBJECT_STORAGE_ENDPOINT must use https.");
  }
  if (localHostnames.has(endpoint.hostname)) {
    throw new Error("Production seed OBJECT_STORAGE_ENDPOINT must not point at local development hosts.");
  }
  if (endpoint.hostname === "example.com" || endpoint.hostname.endsWith(".example.com")) {
    throw new Error("Production seed OBJECT_STORAGE_ENDPOINT must not use example.com template hosts.");
  }
  if (String(env.OBJECT_STORAGE_SECRET_ACCESS_KEY || "").length < 16) {
    throw new Error("Production seed OBJECT_STORAGE_SECRET_ACCESS_KEY must be at least 16 characters.");
  }
}

export function assertSeedSafety(env = process.env) {
  if (!isProductionEnv(env)) {
    return { ok: true, production: false };
  }

  if (env.ALLOW_PRODUCTION_SEED !== "1") {
    throw new Error("Production database seed is blocked. Set ALLOW_PRODUCTION_SEED=1 only after reviewed bootstrap approval.");
  }

  const adminPassword = env.DEFAULT_ADMIN_PASSWORD || defaultSeedAdminPassword;
  if (!env.DEFAULT_ADMIN_PASSWORD || adminPassword === defaultSeedAdminPassword) {
    throw new Error("Production seed requires explicit non-default DEFAULT_ADMIN_PASSWORD.");
  }

  const passwordPolicy = validateNewPassword(adminPassword);
  if (!passwordPolicy.ok) {
    throw new Error(`Production seed DEFAULT_ADMIN_PASSWORD must satisfy password policy: ${passwordPolicy.reasons.join(",")}`);
  }

  const fileStorageDriver = String(env.FILE_STORAGE_DRIVER || "local").trim() || "local";
  if (fileStorageDriver === "s3") {
    assertProductionObjectStorageSeedConfig(env);
    return { ok: true, production: true };
  }

  if (!env.FILE_STORAGE_DIR || !isAbsolute(env.FILE_STORAGE_DIR)) {
    throw new Error("Production seed requires explicit absolute FILE_STORAGE_DIR.");
  }
  if (isTemporaryPath(env.FILE_STORAGE_DIR)) {
    throw new Error("Production seed FILE_STORAGE_DIR must not use temporary storage.");
  }

  return { ok: true, production: true };
}
