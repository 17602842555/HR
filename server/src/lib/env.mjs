import "dotenv/config";
import { isAbsolute, resolve } from "node:path";

const DEV_JWT_SECRET = "dev-only-change-me";
const PLACEHOLDER_JWT_SECRET = "replace-with-a-long-random-secret-before-deployment";
const DEFAULT_ADMIN_PASSWORD = "admin123456";
const DEFAULT_COOKIE_MAX_AGE_SECONDS = 8 * 60 * 60;
const DEFAULT_FILE_STORAGE_DIR = resolve(process.cwd(), ".local-files");
const SUPPORTED_FILE_STORAGE_DRIVERS = new Set(["local", "s3"]);
const MINIMUM_API_BODY_LIMIT_BYTES = 1024 * 1024;
const PLACEHOLDER_SECRET_FRAGMENTS = Object.freeze([
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
]);
const LOCAL_HOSTNAMES = new Set([
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "::1",
  "[::1]",
  "::ffff:7f00:1",
  "[::ffff:7f00:1]",
  "::ffff:127.0.0.1",
  "[::ffff:127.0.0.1]"
]);

function intFromEnv(name, fallback) {
  const value = Number.parseInt(process.env[name] || "", 10);
  return Number.isFinite(value) ? value : fallback;
}

function strictIntFromEnv(name, fallback) {
  const rawValue = process.env[name];
  if (rawValue === undefined || String(rawValue).trim() === "") return fallback;
  const value = String(rawValue).trim();
  if (!/^\d+$/.test(value)) return Number.NaN;
  return Number.parseInt(value, 10);
}

function optionalIntFromEnv(name) {
  const rawValue = process.env[name];
  if (rawValue === undefined || String(rawValue).trim() === "") return null;
  const value = String(rawValue).trim();
  if (!/^\d+$/.test(value)) return Number.NaN;
  return Number.parseInt(value, 10);
}

function requiredApiBodyLimitBytes(config) {
  return Math.max(
    MINIMUM_API_BODY_LIMIT_BYTES,
    Math.ceil(config.fileMaxUploadBytes * 1.5) + 64 * 1024,
    config.importMaxHtmlBytes + 64 * 1024
  );
}

function originsFromEnv() {
  if (!process.env.WEB_ORIGIN) return ["http://127.0.0.1:5173", "http://127.0.0.1:5174"];
  return process.env.WEB_ORIGIN.split(",").map((item) => item.trim()).filter(Boolean);
}

function boolFromEnv(name, fallback = false) {
  const value = String(process.env[name] || "").trim().toLowerCase();
  if (!value) return fallback;
  return ["1", "true", "yes", "on"].includes(value);
}

function isProductionEnv() {
  return process.env.NODE_ENV === "production" || process.env.APP_ENV === "production";
}

function isTemplateHostname(hostname = "") {
  const normalized = String(hostname || "").trim().toLowerCase();
  return normalized === "example.com" || normalized.endsWith(".example.com");
}

function isLocalHostname(hostname = "") {
  return LOCAL_HOSTNAMES.has(String(hostname || "").trim().toLowerCase());
}

function hasPlaceholder(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return !normalized || PLACEHOLDER_SECRET_FRAGMENTS.some((fragment) => normalized.includes(fragment));
}

function isTemporaryPath(path = "") {
  const normalized = String(path || "").trim();
  return normalized === "/tmp"
    || normalized.startsWith("/tmp/")
    || normalized === "/var/tmp"
    || normalized.startsWith("/var/tmp/");
}

function parseRuntimeUrl(value, label) {
  try {
    return new URL(String(value || ""));
  } catch {
    throw new Error(`${label} must be a valid URL.`);
  }
}

function validateProductionWebOrigins(config) {
  if (!Array.isArray(config.webOrigin) || config.webOrigin.length === 0) {
    throw new Error("Production WEB_ORIGIN must list at least one explicit HTTPS origin.");
  }
  config.webOrigin.forEach((origin) => {
    if (String(origin || "").includes("*")) {
      throw new Error("Production WEB_ORIGIN must list explicit origins; wildcard origin is not allowed.");
    }
    const parsed = parseRuntimeUrl(origin, "Production WEB_ORIGIN");
    if (parsed.protocol !== "https:") {
      throw new Error(`Production WEB_ORIGIN must use https: ${origin}`);
    }
    if (isLocalHostname(parsed.hostname)) {
      throw new Error(`Production WEB_ORIGIN must not point at local development hosts: ${origin}`);
    }
    if (isTemplateHostname(parsed.hostname)) {
      throw new Error(`Production WEB_ORIGIN must not use example.com template hosts: ${origin}`);
    }
  });
}

function validateProductionObjectStorage(config) {
  if (config.fileStorageDriver !== "s3") return;
  const objectStorage = config.objectStorage || {};
  const parsed = parseRuntimeUrl(config.objectStorage?.endpoint, "Production OBJECT_STORAGE_ENDPOINT");
  if (parsed.protocol !== "https:") {
    throw new Error("Production OBJECT_STORAGE_ENDPOINT must use https.");
  }
  if (isLocalHostname(parsed.hostname)) {
    throw new Error("Production OBJECT_STORAGE_ENDPOINT must not point at local development hosts.");
  }
  if (isTemplateHostname(parsed.hostname)) {
    throw new Error("Production OBJECT_STORAGE_ENDPOINT must not use example.com template hosts.");
  }
  [
    ["bucket", "BUCKET"],
    ["region", "REGION"],
    ["accessKeyId", "ACCESS_KEY_ID"],
    ["secretAccessKey", "SECRET_ACCESS_KEY"]
  ].forEach(([key, envKey]) => {
    if (hasPlaceholder(objectStorage[key])) {
      throw new Error(`Production OBJECT_STORAGE_${envKey} must be non-placeholder.`);
    }
  });
  if (String(objectStorage.secretAccessKey || "").length < 16) {
    throw new Error("Production OBJECT_STORAGE_SECRET_ACCESS_KEY must be at least 16 characters.");
  }
}

function validateRuntimeConfig(config) {
  if (!Number.isInteger(config.fileMaxUploadBytes) || config.fileMaxUploadBytes <= 0) {
    throw new Error("FILE_MAX_UPLOAD_BYTES must be a positive integer.");
  }
  if (!Number.isInteger(config.importMaxHtmlBytes) || config.importMaxHtmlBytes <= 0) {
    throw new Error("IMPORT_MAX_HTML_BYTES must be a positive integer.");
  }

  const requiredBodyLimit = requiredApiBodyLimitBytes(config);
  if (!Number.isInteger(config.apiBodyLimitBytes) || config.apiBodyLimitBytes <= 0) {
    throw new Error("API_BODY_LIMIT_BYTES must be a positive integer.");
  }
  if (config.apiBodyLimitBytes < requiredBodyLimit) {
    throw new Error(`API_BODY_LIMIT_BYTES must be at least ${requiredBodyLimit} bytes for configured upload/import limits.`);
  }

  if (!Number.isInteger(config.cookieMaxAgeSeconds) || config.cookieMaxAgeSeconds <= 0) {
    throw new Error("COOKIE_MAX_AGE_SECONDS must be a positive integer.");
  }
  if (!Number.isInteger(config.authFailedLoginLimit) || config.authFailedLoginLimit <= 0) {
    throw new Error("AUTH_FAILED_LOGIN_LIMIT must be a positive integer.");
  }
  if (!Number.isInteger(config.authFailedLoginWindowMs) || config.authFailedLoginWindowMs <= 0) {
    throw new Error("AUTH_FAILED_LOGIN_WINDOW_MS must be a positive integer.");
  }
  if (!Number.isInteger(config.authFailedLoginMaxKeys) || config.authFailedLoginMaxKeys <= 0) {
    throw new Error("AUTH_FAILED_LOGIN_MAX_KEYS must be a positive integer.");
  }
  if (!SUPPORTED_FILE_STORAGE_DRIVERS.has(config.fileStorageDriver)) {
    throw new Error("FILE_STORAGE_DRIVER must be local or s3.");
  }
  if (config.fileStorageDriver === "s3") {
    const objectStorage = config.objectStorage || {};
    if (!objectStorage.endpoint || !/^https?:\/\//.test(objectStorage.endpoint)) {
      throw new Error("OBJECT_STORAGE_ENDPOINT must be an HTTP(S) URL when FILE_STORAGE_DRIVER=s3.");
    }
    ["bucket", "region", "accessKeyId", "secretAccessKey"].forEach((key) => {
      if (!String(objectStorage[key] || "").trim()) {
        throw new Error(`OBJECT_STORAGE_${key === "accessKeyId" ? "ACCESS_KEY_ID" : key === "secretAccessKey" ? "SECRET_ACCESS_KEY" : key.toUpperCase()} is required when FILE_STORAGE_DRIVER=s3.`);
      }
    });
  }

  if (!config.isProduction) return;

  if (
    !config.jwtSecret
    || config.jwtSecret.length < 32
    || [DEV_JWT_SECRET, PLACEHOLDER_JWT_SECRET].includes(config.jwtSecret)
  ) {
    throw new Error("Production JWT_SECRET must be a non-placeholder secret with at least 32 characters.");
  }

  validateProductionWebOrigins(config);
  validateProductionObjectStorage(config);

  if (config.runDbSeed && config.defaultAdminPassword === DEFAULT_ADMIN_PASSWORD) {
    throw new Error("Production seed cannot use the default admin password.");
  }

  if (config.fileStorageDriver === "s3") return;

  if (!config.fileStorageDirExplicit) {
    throw new Error("Production FILE_STORAGE_DIR must be explicitly configured to a backed persistent volume path.");
  }
  if (!isAbsolute(config.fileStorageDir)) {
    throw new Error("Production FILE_STORAGE_DIR must be an absolute backed persistent volume path.");
  }
  if (isTemporaryPath(config.fileStorageDir)) {
    throw new Error("Production FILE_STORAGE_DIR must not use temporary storage.");
  }
}

export function loadEnv(overrides = {}) {
  const fileStorageDirExplicit = Boolean(String(process.env.FILE_STORAGE_DIR || "").trim())
    || Object.hasOwn(overrides, "fileStorageDir");
  const config = {
    apiBodyLimitBytes: optionalIntFromEnv("API_BODY_LIMIT_BYTES"),
    host: process.env.SERVER_HOST || "127.0.0.1",
    port: intFromEnv("SERVER_PORT", 8787),
    jwtSecret: process.env.JWT_SECRET || DEV_JWT_SECRET,
    jwtExpiresIn: process.env.JWT_EXPIRES_IN || "8h",
    cookieName: process.env.COOKIE_NAME || "oa_session",
    cookieMaxAgeSeconds: strictIntFromEnv("COOKIE_MAX_AGE_SECONDS", DEFAULT_COOKIE_MAX_AGE_SECONDS),
    authFailedLoginLimit: strictIntFromEnv("AUTH_FAILED_LOGIN_LIMIT", 5),
    authFailedLoginWindowMs: strictIntFromEnv("AUTH_FAILED_LOGIN_WINDOW_MS", 10 * 60 * 1000),
    authFailedLoginMaxKeys: strictIntFromEnv("AUTH_FAILED_LOGIN_MAX_KEYS", 10_000),
    defaultTenantCode: process.env.DEFAULT_TENANT_CODE || "default",
    defaultAdminPassword: process.env.DEFAULT_ADMIN_PASSWORD || DEFAULT_ADMIN_PASSWORD,
    importMaxHtmlBytes: strictIntFromEnv("IMPORT_MAX_HTML_BYTES", 10 * 1024 * 1024),
    fileMaxUploadBytes: strictIntFromEnv("FILE_MAX_UPLOAD_BYTES", 5 * 1024 * 1024),
    fileStorageDriver: process.env.FILE_STORAGE_DRIVER || "local",
    fileStorageDir: process.env.FILE_STORAGE_DIR || DEFAULT_FILE_STORAGE_DIR,
    fileStorageDirExplicit,
    objectStorage: {
      accessKeyId: process.env.OBJECT_STORAGE_ACCESS_KEY_ID || "",
      bucket: process.env.OBJECT_STORAGE_BUCKET || "",
      endpoint: process.env.OBJECT_STORAGE_ENDPOINT || "",
      forcePathStyle: boolFromEnv("OBJECT_STORAGE_FORCE_PATH_STYLE", true),
      prefix: process.env.OBJECT_STORAGE_PREFIX || "",
      region: process.env.OBJECT_STORAGE_REGION || "",
      secretAccessKey: process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY || ""
    },
    webOrigin: originsFromEnv(),
    trustProxy: boolFromEnv("TRUST_PROXY", false),
    runDbSeed: boolFromEnv("RUN_DB_SEED", false),
    isProduction: isProductionEnv(),
    ...overrides
  };
  if (config.apiBodyLimitBytes === null || config.apiBodyLimitBytes === undefined) {
    config.apiBodyLimitBytes = requiredApiBodyLimitBytes(config);
  }
  validateRuntimeConfig(config);
  return config;
}

export const runtimeConfigDefaults = {
  defaultAdminPassword: DEFAULT_ADMIN_PASSWORD,
  defaultCookieMaxAgeSeconds: DEFAULT_COOKIE_MAX_AGE_SECONDS,
  devJwtSecret: DEV_JWT_SECRET,
  requiredApiBodyLimitBytes,
  placeholderJwtSecret: PLACEHOLDER_JWT_SECRET
};
