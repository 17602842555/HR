import assert from "node:assert/strict";
import test from "node:test";
import { parseProductionEnvText, validateProductionEnv } from "../../scripts/validate-production-env.mjs";

function validProductionEnv(overrides = {}) {
  return {
    APP_ENV: "production",
    NODE_ENV: "production",
    POSTGRES_DB: "oa_commercial",
    POSTGRES_USER: "oa",
    POSTGRES_PASSWORD: "pg_2026_real_random_value_32_chars",
    JWT_SECRET: "jwt_2026_real_random_value_at_least_32_chars",
    COOKIE_MAX_AGE_SECONDS: "28800",
    AUTH_FAILED_LOGIN_LIMIT: "5",
    AUTH_FAILED_LOGIN_WINDOW_MS: "600000",
    AUTH_FAILED_LOGIN_MAX_KEYS: "10000",
    FILE_STORAGE_DRIVER: "local",
    FILE_STORAGE_DIR: "/app/storage/files",
    BACKUP_DIR: "/backups/postgres",
    FILE_BACKUP_DIR: "/backups/files",
    FILE_MAX_UPLOAD_BYTES: "5242880",
    IMPORT_MAX_HTML_BYTES: "10485760",
    API_BODY_LIMIT_BYTES: "10551296",
    WEB_ORIGIN: "https://oa.company.test",
    TRUST_PROXY: "0",
    DEFAULT_ADMIN_PASSWORD: "",
    RUN_DB_SEED: "0",
    ALLOW_PRODUCTION_SEED: "0",
    VITE_REQUIRE_API: "1",
    VITE_DEMO_FALLBACK: "0",
    ...overrides
  };
}

test("production env validator accepts hardened production values", () => {
  const result = validateProductionEnv(validProductionEnv());

  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
  assert.equal(result.summary.runDbSeed, false);
  assert.equal(result.summary.fileStorageDriver, "local");
  assert.equal(result.summary.backupDir, "/backups/postgres");
  assert.equal(result.summary.fileBackupDir, "/backups/files");
  assert.deepEqual(result.summary.origins, ["https://oa.company.test"]);
});

test("production env validator accepts S3 object storage config", () => {
  const result = validateProductionEnv(validProductionEnv({
    FILE_STORAGE_DRIVER: "s3",
    FILE_STORAGE_DIR: "",
    OBJECT_STORAGE_ENDPOINT: "https://s3.company.test",
    OBJECT_STORAGE_BUCKET: "oa-prod-files",
    OBJECT_STORAGE_REGION: "cn-east-1",
    OBJECT_STORAGE_ACCESS_KEY_ID: "AKIAREALACCESS",
    OBJECT_STORAGE_SECRET_ACCESS_KEY: "object-secret-at-least-16",
    OBJECT_STORAGE_PREFIX: "prod"
  }));

  assert.equal(result.ok, true);
  assert.equal(result.summary.fileStorageDriver, "s3");
  assert.equal(result.summary.objectStorageBucket, "oa-prod-files");
});

test("production env validator rejects incomplete S3 object storage config", () => {
  const result = validateProductionEnv(validProductionEnv({
    FILE_STORAGE_DRIVER: "s3",
    FILE_STORAGE_DIR: "",
    OBJECT_STORAGE_ENDPOINT: "https://s3.example.com",
    OBJECT_STORAGE_BUCKET: "",
    OBJECT_STORAGE_REGION: "",
    OBJECT_STORAGE_ACCESS_KEY_ID: "placeholder-access",
    OBJECT_STORAGE_SECRET_ACCESS_KEY: "short"
  }));

  assert.equal(result.ok, false);
  assert(result.errors.some((error) => error.includes("OBJECT_STORAGE_REGION")));
  assert(result.errors.some((error) => error.includes("OBJECT_STORAGE_ENDPOINT")));
  assert(result.errors.some((error) => error.includes("OBJECT_STORAGE_BUCKET")));
  assert(result.errors.some((error) => error.includes("OBJECT_STORAGE_ACCESS_KEY_ID")));
  assert(result.errors.some((error) => error.includes("OBJECT_STORAGE_SECRET_ACCESS_KEY")));
});

test("production env validator rejects template secrets example origins and demo fallback", () => {
  const result = validateProductionEnv(validProductionEnv({
    POSTGRES_PASSWORD: "",
    JWT_SECRET: "local-commercial-demo-secret-change-before-production-20260530",
    WEB_ORIGIN: "https://oa.example.com,http://127.0.0.1:5174,https://[::1]:5174",
    FILE_STORAGE_DIR: ".local-files",
    BACKUP_DIR: "backups/postgres",
    FILE_BACKUP_DIR: "/tmp/oa-files",
    DEFAULT_ADMIN_PASSWORD: "admin123456",
    VITE_REQUIRE_API: "0",
    VITE_DEMO_FALLBACK: "1"
  }));

  assert.equal(result.ok, false);
  assert(result.errors.some((error) => error.includes("POSTGRES_PASSWORD")));
  assert(result.errors.some((error) => error.includes("JWT_SECRET")));
  assert(result.errors.some((error) => error.includes("example.com")));
  assert(result.errors.some((error) => error.includes("local development hosts")));
  assert(result.errors.some((error) => error.includes("FILE_STORAGE_DIR")));
  assert(result.errors.some((error) => error.includes("BACKUP_DIR")));
  assert(result.errors.some((error) => error.includes("FILE_BACKUP_DIR")));
  assert(result.errors.some((error) => error.includes("DEFAULT_ADMIN_PASSWORD")));
  assert(result.errors.some((error) => error.includes("VITE_REQUIRE_API")));
  assert(result.errors.some((error) => error.includes("VITE_DEMO_FALLBACK")));
});

test("production env validator rejects IPv6 loopback object storage endpoints", () => {
  const result = validateProductionEnv(validProductionEnv({
    FILE_STORAGE_DRIVER: "s3",
    FILE_STORAGE_DIR: "",
    OBJECT_STORAGE_ENDPOINT: "https://[::1]:9000",
    OBJECT_STORAGE_BUCKET: "oa-prod-files",
    OBJECT_STORAGE_REGION: "cn-east-1",
    OBJECT_STORAGE_ACCESS_KEY_ID: "AKIAREALACCESS",
    OBJECT_STORAGE_SECRET_ACCESS_KEY: "object-secret-at-least-16"
  }));

  assert.equal(result.ok, false);
  assert(result.errors.some((error) => error.includes("local development hosts")));
});

test("production env validator rejects app-local durable backup paths", () => {
  const result = validateProductionEnv(validProductionEnv({
    BACKUP_DIR: "/app/backups/postgres",
    FILE_BACKUP_DIR: "/app/backups/files"
  }));

  assert.equal(result.ok, false);
  assert(result.errors.some((error) => error.includes("BACKUP_DIR must not point inside the application container directory")));
  assert(result.errors.some((error) => error.includes("FILE_BACKUP_DIR must not point inside the application container directory")));
});

test("production env validator checks body limit and production seed approval", () => {
  const result = validateProductionEnv(validProductionEnv({
    API_BODY_LIMIT_BYTES: "1024",
    RUN_DB_SEED: "1",
    ALLOW_PRODUCTION_SEED: "0",
    DEFAULT_ADMIN_PASSWORD: "BootstrapPass2026"
  }));

  assert.equal(result.ok, false);
  assert(result.errors.some((error) => error.includes("API_BODY_LIMIT_BYTES")));
  assert(result.errors.some((error) => error.includes("ALLOW_PRODUCTION_SEED")));
});

test("production env validator rejects weak production seed password", () => {
  const result = validateProductionEnv(validProductionEnv({
    RUN_DB_SEED: "1",
    ALLOW_PRODUCTION_SEED: "1",
    DEFAULT_ADMIN_PASSWORD: "NoDigitsAtAll"
  }));

  assert.equal(result.ok, false);
  assert(result.errors.some((error) => error.includes("DEFAULT_ADMIN_PASSWORD")));
});

test("production env parser reads dotenv syntax without mutating process env", () => {
  const parsed = parseProductionEnvText(`
APP_ENV=production
WEB_ORIGIN="https://oa.company.test,https://oa-backup.company.test"
JWT_SECRET=jwt_2026_real_random_value_at_least_32_chars
`);

  assert.equal(parsed.APP_ENV, "production");
  assert.equal(parsed.WEB_ORIGIN, "https://oa.company.test,https://oa-backup.company.test");
  assert.equal(parsed.JWT_SECRET, "jwt_2026_real_random_value_at_least_32_chars");
});
