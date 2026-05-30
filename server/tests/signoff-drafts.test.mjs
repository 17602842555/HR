import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  generateSignoffDrafts,
  parseSignoffDraftArgs
} from "../../scripts/generate-signoff-drafts.mjs";

function modeOf(stats) {
  return stats.mode & 0o777;
}

function validEnvText(overrides = {}) {
  const env = {
    APP_ENV: "production",
    NODE_ENV: "production",
    POSTGRES_DB: "oa_commercial",
    POSTGRES_USER: "oa",
    POSTGRES_PASSWORD: "pg_real_random_secret_value_2026",
    JWT_SECRET: "jwt_real_random_secret_value_2026_with_length",
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
  return Object.entries(env).map(([key, value]) => `${key}=${value}`).join("\n");
}

test("signoff draft generator writes non-release drafts from current source data", async () => {
  const dir = await mkdtemp(join(tmpdir(), "oa-signoff-drafts-"));
  const envPath = join(dir, ".env.production");
  const envText = validEnvText();
  await writeFile(envPath, envText);

  try {
    const result = generateSignoffDrafts({
      rootDir: process.cwd(),
      outputDir: dir,
      envPath,
      now: new Date("2026-05-30T12:34:56.000Z")
    });
    const hr = JSON.parse(await readFile(result.files.hr, "utf8"));
    const secretsText = await readFile(result.files.secrets, "utf8");
    const secrets = JSON.parse(secretsText);
    const storage = JSON.parse(await readFile(result.files.storage, "utf8"));
    const manifest = JSON.parse(await readFile(result.files.manifest, "utf8"));
    const latestManifest = join(dir, "latest-manifest.json");

    assert.equal(hr.draft, true);
    assert.equal(hr.source.counts.activeEmployees, 72);
    assert.equal(hr.source.counts.leavers, 162);
    assert.match(hr.source.sourceChecksum, /^[a-f0-9]{64}$/);
    assert.equal(hr.approvals.some((approval) => approval.decision === "pending"), true);
    assert.equal(hr.openExceptions.length, 1);

    assert.equal(secrets.draft, true);
    assert.equal(secrets.environmentFile.validationSummary.ok, true);
    assert.match(secrets.environmentFile.sha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(secrets.originPolicy.approvedOrigins, ["https://oa.company.test"]);
    assert.equal(secretsText.includes("pg_real_random_secret_value_2026"), false);
    assert.equal(secretsText.includes("jwt_real_random_secret_value_2026_with_length"), false);
    assert.deepEqual(secrets.secretStore.managedSecrets, [
      "POSTGRES_PASSWORD",
      "JWT_SECRET",
      "CLOUDFLARE_API_TOKEN",
      "CLOUDFLARE_TUNNEL_TOKEN"
    ]);

    assert.equal(storage.draft, true);
    assert.equal(storage.storage.storageType, "backed-persistent-volume");
    assert.equal(storage.runtime.fileStorageDriver, "local");
    assert.equal(storage.runtime.fileStorageDir, "/app/storage/files");
    assert.equal(storage.runtime.backupDir, "/backups/postgres");
    assert.equal(storage.runtime.fileBackupDir, "/backups/files");
    assert.equal(storage.runtime.objectStorageBucket, "");
    assert.match(storage.restoreDrill.restoreMethod, /npm run restore:files/);
    assert.equal(storage.restoreDrill.downloadedAttachmentSmoke.passed, false);
    assert.equal(storage.openExceptions.length, 1);

    assert.equal(manifest.draft, true);
    assert.equal(manifest.source.fileStorageDriver, "local");
    assert.equal(manifest.source.fileStorageDir, "/app/storage/files");
    assert.equal(manifest.source.backupDir, "/backups/postgres");
    assert.equal(manifest.source.fileBackupDir, "/backups/files");
    assert.equal(manifest.nextCommands.some((command) => command.includes("validate:hr-signoff")), true);
    assert.equal(manifest.signoffReadiness.releaseEvidence, false);
    assert.equal(manifest.signoffReadiness.status, "draft-review-required");
    assert.equal(manifest.signoffReadiness.itemCount, 3);
    assert.equal(manifest.signoffReadiness.totalPendingApprovalCount, 7);
    assert.equal(manifest.signoffReadiness.totalOpenExceptionCount, 3);
    assert.deepEqual(
      manifest.signoffReadiness.items.map((item) => item.gapId).sort(),
      ["GAP-003", "GAP-004", "GAP-005"]
    );
    assert.equal(manifest.signoffReadiness.items.some((item) => item.validatorCommand.includes("validate:secrets-signoff")), true);
    assert.equal(manifest.signoffReadiness.items.some((item) => item.validatorCommand.includes("validate:storage-signoff")), true);
    assert.equal(manifest.signoffReadiness.items.some((item) => item.validatorCommand.includes("validate:hr-signoff")), true);
    assert.equal(manifest.signoffReadiness.items.every((item) => item.requiredActions.length >= 3), true);
    assert.equal(manifest.releaseUse.includes("Do not attach these draft files as release evidence"), true);
    assert.equal(modeOf(await stat(dir)), 0o700);
    assert.equal(modeOf(await stat(result.outputDir)), 0o700);
    assert.equal(modeOf(await stat(result.files.hr)), 0o600);
    assert.equal(modeOf(await stat(result.files.secrets)), 0o600);
    assert.equal(modeOf(await stat(result.files.storage)), 0o600);
    assert.equal(modeOf(await stat(result.files.manifest)), 0o600);
    assert.equal(modeOf(await stat(latestManifest)), 0o600);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("signoff draft generator carries S3 object storage runtime shape", async () => {
  const dir = await mkdtemp(join(tmpdir(), "oa-signoff-drafts-s3-"));
  const envPath = join(dir, ".env.production");
  await writeFile(envPath, validEnvText({
    FILE_STORAGE_DRIVER: "s3",
    FILE_STORAGE_DIR: "",
    OBJECT_STORAGE_ENDPOINT: "https://s3.company.test",
    OBJECT_STORAGE_BUCKET: "oa-prod-files",
    OBJECT_STORAGE_REGION: "cn-east-1",
    OBJECT_STORAGE_ACCESS_KEY_ID: "AKIAREALACCESS",
    OBJECT_STORAGE_SECRET_ACCESS_KEY: "object-secret-at-least-16"
  }));

  try {
    const result = generateSignoffDrafts({
      rootDir: process.cwd(),
      outputDir: dir,
      envPath,
      now: new Date("2026-05-30T12:34:56.000Z")
    });
    const storageText = await readFile(result.files.storage, "utf8");
    const storage = JSON.parse(storageText);
    const manifest = JSON.parse(await readFile(result.files.manifest, "utf8"));
    assert.equal(storage.storage.storageType, "object-storage");
    assert.equal(storage.storage.location, "oa-prod-files");
    assert.equal(storage.storage.region, "cn-east-1");
    assert.equal(storage.runtime.fileStorageDriver, "s3");
    assert.equal(storage.runtime.fileStorageDir, "");
    assert.equal(storage.runtime.backupDir, "/backups/postgres");
    assert.equal(storage.runtime.fileBackupDir, "");
    assert.equal(storage.runtime.objectStorageConfigured, true);
    assert.equal(storage.runtime.objectStorageEndpointHost, "s3.company.test");
    assert.equal(storage.runtime.objectStorageBucket, "oa-prod-files");
    assert.equal(storage.runtime.objectStorageRegion, "cn-east-1");
    assert.match(storage.restoreDrill.restoreMethod, /object-storage restore/);
    assert.equal(storageText.includes("object-secret-at-least-16"), false);
    assert.equal(manifest.source.fileStorageDriver, "s3");
    assert.equal(manifest.source.fileStorageDir, "");
    assert.equal(manifest.source.backupDir, "/backups/postgres");
    assert.equal(manifest.source.fileBackupDir, "");
    assert.equal(manifest.source.objectStorageBucket, "oa-prod-files");
    assert.equal(manifest.source.objectStorageEndpointHost, "s3.company.test");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("signoff draft generator exposes missing production env as a draft exception", async () => {
  const dir = await mkdtemp(join(tmpdir(), "oa-signoff-drafts-missing-env-"));
  try {
    const result = generateSignoffDrafts({
      rootDir: process.cwd(),
      outputDir: dir,
      envPath: join(dir, ".env.production"),
      now: new Date("2026-05-30T12:34:56.000Z")
    });
    const secrets = JSON.parse(await readFile(result.files.secrets, "utf8"));

    assert.equal(secrets.environmentFile.sha256, "");
    assert.equal(secrets.environmentFile.validationSummary.ok, false);
    assert.equal(secrets.openExceptions[0].id, "PRODUCTION-ENV-MISSING");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("signoff draft CLI parser reads source env storage output and json flags", () => {
  const parsed = parseSignoffDraftArgs([
    "--output",
    "reports/drafts",
    "--source",
    "oa-dashboard.html",
    "--env",
    ".env.production",
    "--file-storage-dir",
    "/app/storage/files",
    "--json"
  ]);

  assert.equal(parsed.outputDir, "reports/drafts");
  assert.equal(parsed.sourcePath, "oa-dashboard.html");
  assert.equal(parsed.envPath, ".env.production");
  assert.equal(parsed.fileStorageDir, "/app/storage/files");
  assert.equal(parsed.json, true);
});
