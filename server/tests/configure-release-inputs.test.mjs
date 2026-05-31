import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  configureReleaseInputs,
  parseConfigureReleaseInputsArgs,
  uploadReleaseInputSecrets
} from "../../scripts/configure-release-inputs.mjs";
import { requiredMaskedFields } from "../../scripts/validate-hr-signoff.mjs";
import { sha256File as sha256HrFile } from "../../scripts/validate-hr-signoff.mjs";
import { sha256Text } from "../../scripts/validate-secrets-signoff.mjs";

function modeOf(stats) {
  return stats.mode & 0o777;
}

function validEnvText() {
  return [
    "APP_ENV=production",
    "NODE_ENV=production",
    "POSTGRES_DB=oa_commercial",
    "POSTGRES_USER=oa",
    "POSTGRES_PASSWORD=pg_real_random_secret_20260531",
    "JWT_SECRET=jwt_real_random_secret_20260531_minimum_32_chars",
    "COOKIE_MAX_AGE_SECONDS=28800",
    "AUTH_FAILED_LOGIN_LIMIT=5",
    "AUTH_FAILED_LOGIN_WINDOW_MS=600000",
    "AUTH_FAILED_LOGIN_MAX_KEYS=10000",
    "FILE_STORAGE_DRIVER=s3",
    "BACKUP_DIR=/backups/postgres",
    "OBJECT_STORAGE_ENDPOINT=https://s3.company.test",
    "OBJECT_STORAGE_BUCKET=oa-prod-files",
    "OBJECT_STORAGE_REGION=cn-east-1",
    "OBJECT_STORAGE_ACCESS_KEY_ID=AKIAREALACCESS20260531",
    "OBJECT_STORAGE_SECRET_ACCESS_KEY=object-secret-at-least-16",
    "FILE_MAX_UPLOAD_BYTES=5242880",
    "IMPORT_MAX_HTML_BYTES=10485760",
    "API_BODY_LIMIT_BYTES=10551296",
    "WEB_ORIGIN=https://oa.company.test",
    "TRUST_PROXY=1",
    "RUN_DB_SEED=0",
    "ALLOW_PRODUCTION_SEED=0",
    "VITE_REQUIRE_API=1",
    "VITE_DEMO_FALLBACK=0",
    "CLOUDFLARE_TUNNEL_TOKEN=cloudflare-tunnel-token-real-20260531",
    "API_ORIGIN=https://api.oa.company.test",
    "CLOUDFLARE_DEPLOYMENT_URL=https://oa.company.test",
    ""
  ].join("\n");
}

function validSecretsSignoff(envText) {
  return {
    schemaVersion: 1,
    documentId: "PROD-SECRETS-SIGNOFF-20260531",
    environment: "production",
    signedAt: "2026-05-31T06:00:00.000Z",
    environmentFile: {
      path: ".env.production",
      sha256: sha256Text(envText),
      validatedWith: "npm run validate:production-env -- .env.production --json"
    },
    secretStore: {
      provider: "Company Secret Manager",
      namespace: "oa/production",
      managedSecrets: ["POSTGRES_PASSWORD", "JWT_SECRET", "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_TUNNEL_TOKEN"],
      injectedAtRuntime: true,
      noPlaintextInRepo: true,
      accessRestricted: true,
      rotationOwner: "Security Platform Team",
      lastRotatedAt: "2026-05-31T05:00:00.000Z",
      nextRotationDueAt: "2026-08-31T05:00:00.000Z",
      rotationRunbook: "Security runbook SEC-OA-SECRET-ROTATION",
      emergencyRollback: "Use previous managed secret version after incident approval."
    },
    originPolicy: {
      approvedOrigins: ["https://oa.company.test"],
      httpsOnly: true,
      noWildcard: true,
      owner: "Security Platform Team"
    },
    bootstrapSeedPolicy: {
      runDbSeed: false,
      defaultAdminPasswordManaged: false,
      approvalReference: "No production seed for this release."
    },
    approvals: [
      {
        role: "Security owner",
        name: "Security Owner",
        email: "security.owner@company.test",
        decision: "approved",
        approvedAt: "2026-05-31T06:05:00.000Z"
      },
      {
        role: "Deployment owner",
        name: "Deployment Owner",
        email: "deployment.owner@company.test",
        decision: "approved",
        approvedAt: "2026-05-31T06:06:00.000Z"
      }
    ],
    openExceptions: []
  };
}

function validHrSignoff(sourcePath) {
  return {
    schemaVersion: 1,
    documentId: "HR-SIGNOFF-20260531-PROD",
    environment: "production",
    signedAt: "2026-05-31T06:00:00.000Z",
    source: {
      sourceName: "oa-dashboard.html",
      sourceChecksum: sha256HrFile(sourcePath),
      importedAt: "2026-05-31T06:01:00.000Z",
      counts: {
        activeEmployees: 72,
        leavers: 162,
        femaleEmployees: 43,
        monthLeavers: 4,
        departments: 10,
        orgs: 8
      }
    },
    dataPolicy: {
      fieldPolicy: {
        defaultMasked: true,
        revealPermission: "employee.sensitive.read",
        maskedFields: [...requiredMaskedFields]
      },
      exportPolicy: {
        requiresPermission: true,
        allowsSensitiveExport: false,
        recordsExportLedger: true,
        requiresBusinessReason: true
      },
      retention: {
        employeeRecords: "Keep personnel records for the approved statutory HR retention period.",
        leaverRecords: "Keep leaver records for the approved statutory HR retention period.",
        auditLogs: "Keep audit logs for the approved compliance evidence retention period.",
        exportFiles: "Keep export files only in approved release evidence storage."
      }
    },
    approvals: [
      {
        role: "HR owner",
        name: "HR Owner",
        email: "hr.owner@company.test",
        decision: "approved",
        approvedAt: "2026-05-31T06:10:00.000Z"
      },
      {
        role: "Product owner",
        name: "Product Owner",
        email: "product.owner@company.test",
        decision: "approved",
        approvedAt: "2026-05-31T06:11:00.000Z"
      },
      {
        role: "Security reviewer",
        name: "Security Reviewer",
        email: "security.reviewer@company.test",
        decision: "approved",
        approvedAt: "2026-05-31T06:12:00.000Z"
      }
    ],
    openExceptions: []
  };
}

function validStorageSignoff() {
  return {
    schemaVersion: 1,
    documentId: "FILE-STORAGE-SIGNOFF-20260531-PROD",
    environment: "production",
    signedAt: "2026-05-31T06:00:00.000Z",
    storage: {
      storageType: "object-storage",
      provider: "Company Managed OSS",
      location: "oa-prod-files",
      region: "cn-east-1",
      backupOwner: "Infrastructure Platform Team",
      encryptionAtRest: true,
      privateAccess: true,
      independentBackup: true,
      bucketVersioning: true
    },
    runtime: {
      fileStorageDriver: "s3",
      objectStorageConfigured: true,
      noEphemeralContainerStorage: true
    },
    backupPolicy: {
      schedule: "Nightly object replication and manual backup before migrations.",
      retention: "Keep 7 daily, 4 weekly, and 3 monthly immutable copies.",
      rpoHours: 24,
      rtoHours: 4,
      offHostCopy: true,
      restoreRunbook: "docs/DEPLOYMENT.md storage restore section."
    },
    restoreDrill: {
      drillId: "FILE-DRILL-20260531-PROD",
      completedAt: "2026-05-31T06:20:00.000Z",
      restoredTo: "staging",
      restoreMethod: "platform restore tooling restored object storage into staging.",
      evidencePath: "reports/commercial-evidence/file-storage-drill-prod.json",
      backupArtifact: {
        path: "s3://oa-prod-files-backup/2026-05-31.tar.gz",
        metadataPath: "s3://oa-prod-files-backup/2026-05-31.tar.gz.meta",
        sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        sizeBytes: 4096,
        fileCount: 2
      },
      downloadedAttachmentSmoke: {
        passed: true,
        fileId: "file-prod-0001",
        downloadedAt: "2026-05-31T06:25:00.000Z",
        expectedChecksum: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
        actualChecksum: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789"
      },
      auditEventIds: ["audit-backup-prod-0001", "audit-restore-prod-0001"]
    },
    approvals: [
      {
        role: "Infrastructure owner",
        name: "Infra Owner",
        email: "infra.owner@company.test",
        decision: "approved",
        approvedAt: "2026-05-31T06:30:00.000Z"
      },
      {
        role: "Security reviewer",
        name: "Security Reviewer",
        email: "security.reviewer@company.test",
        decision: "approved",
        approvedAt: "2026-05-31T06:31:00.000Z"
      }
    ],
    openExceptions: []
  };
}

async function writeFixtureFiles(dir) {
  const envText = validEnvText();
  const paths = {
    envPath: join(dir, ".env.production"),
    hrSignoffPath: join(dir, "hr-data-signoff.json"),
    secretsSignoffPath: join(dir, "production-secrets-signoff.json"),
    storageSignoffPath: join(dir, "file-storage-signoff.json")
  };
  await writeFile(paths.envPath, envText);
  await writeFile(paths.secretsSignoffPath, JSON.stringify(validSecretsSignoff(envText), null, 2));
  await writeFile(paths.hrSignoffPath, JSON.stringify(validHrSignoff(join(process.cwd(), "oa-dashboard.html")), null, 2));
  await writeFile(paths.storageSignoffPath, JSON.stringify(validStorageSignoff(), null, 2));
  return paths;
}

test("release input configurator validates files and writes private dry-run manifest", async () => {
  const dir = await mkdtemp(join(tmpdir(), "oa-release-input-config-"));
  try {
    const paths = await writeFixtureFiles(dir);
    const result = configureReleaseInputs({
      rootDir: process.cwd(),
      outputDir: dir,
      ...paths,
      backendMode: "tunnel",
      now: new Date("2026-05-31T06:40:00.000Z")
    });

    assert.equal(result.manifest.ok, true);
    assert.equal(result.manifest.readyToUpload, true);
    assert.equal(result.manifest.apply, false);
    assert.equal(result.manifest.inputs.length, 4);
    assert.equal(result.manifest.inputs.every((item) => /^[a-f0-9]{64}$/.test(item.sha256)), true);
    assert.equal(result.manifest.validation.productionEnv.ok, true);
    assert.equal(result.manifest.validation.cloudflareBackend.ok, true);
    assert.equal(result.manifest.validation.secretsSignoff.ok, true);
    assert.equal(result.manifest.validation.hrSignoff.ok, true);
    assert.equal(result.manifest.validation.storageSignoff.ok, true);
    assert.equal(JSON.stringify(result.manifest).includes("pg_real_random_secret"), false);
    assert.equal(JSON.stringify(result.manifest).includes("jwt_real_random_secret"), false);
    assert.equal(modeOf(await stat(dir)), 0o700);
    assert.equal(modeOf(await stat(result.outputPath)), 0o600);
    assert.equal(modeOf(await stat(join(dir, "latest-manifest.json"))), 0o600);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("release input configurator applies GitHub environment secrets through stdin only after validation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "oa-release-input-apply-"));
  const calls = [];
  const runner = (command, args, options = {}) => {
    calls.push({ args, command, input: options.input });
    if (args[0] === "api") return { status: 0, stdout: "{\"name\":\"production\"}", stderr: "" };
    return { status: 0, stdout: "", stderr: "" };
  };

  try {
    const paths = await writeFixtureFiles(dir);
    const result = configureReleaseInputs({
      rootDir: process.cwd(),
      outputDir: dir,
      ...paths,
      apply: true,
      backendMode: "tunnel",
      ensureGithubEnvironment: true,
      runner,
      now: new Date("2026-05-31T06:40:00.000Z")
    });

    const secretCalls = calls.filter((call) => call.args[0] === "secret" && call.args[1] === "set");
    assert.equal(result.manifest.ok, true);
    assert.equal(result.manifest.githubEnvironment.ok, true);
    assert.equal(secretCalls.length, 4);
    assert.deepEqual(secretCalls.map((call) => call.args[2]).sort(), [
      "FILE_STORAGE_SIGNOFF_B64",
      "HR_DATA_SIGNOFF_B64",
      "PRODUCTION_ENV_B64",
      "PRODUCTION_SECRETS_SIGNOFF_B64"
    ]);
    assert.equal(secretCalls.every((call) => call.args.includes("--env") && call.args.includes("production")), true);
    assert.equal(secretCalls.some((call) => String(call.input || "").includes("pg_real_random_secret")), false);
    assert.equal(secretCalls.every((call) => /^[A-Za-z0-9+/=]+$/.test(String(call.input || ""))), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("release input configurator blocks uploads when validation fails", async () => {
  const dir = await mkdtemp(join(tmpdir(), "oa-release-input-invalid-"));
  const calls = [];
  try {
    const paths = await writeFixtureFiles(dir);
    await writeFile(paths.envPath, "APP_ENV=production\nNODE_ENV=production\nWEB_ORIGIN=http://127.0.0.1:5174\n");
    const result = configureReleaseInputs({
      rootDir: process.cwd(),
      outputDir: dir,
      ...paths,
      apply: true,
      backendMode: "tunnel",
      runner: (command, args, options = {}) => {
        calls.push({ args, command, input: options.input });
        return { status: 0, stdout: "", stderr: "" };
      },
      now: new Date("2026-05-31T06:40:00.000Z")
    });

    assert.equal(result.manifest.ok, false);
    assert.equal(result.manifest.readyToUpload, false);
    assert.equal(calls.length, 0);
    assert(result.manifest.errors.some((error) => error.includes("validation failed")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("release input upload helper redacts failed gh output", () => {
  const result = uploadReleaseInputSecrets({
    payloads: [{ envName: "PRODUCTION_ENV_B64", base64: "c2VjcmV0Cg==" }],
    runner: () => ({ status: 1, stdout: "", stderr: "token=super-secret-token failed" })
  });

  assert.equal(result.ok, false);
  assert.equal(JSON.stringify(result).includes("super-secret-token"), false);
  assert.equal(result.errors.some((error) => error.includes("token=[REDACTED]")), true);
});

test("release input configurator parser reads file paths apply and environment flags", () => {
  const parsed = parseConfigureReleaseInputsArgs([
    "--apply",
    "--ensure-github-environment",
    "--mode",
    "tunnel",
    "--environment",
    "staging",
    "--env",
    "release/.env.production",
    "--secrets-signoff",
    "release/secrets.json",
    "--hr-signoff",
    "release/hr.json",
    "--storage-signoff",
    "release/storage.json",
    "--source",
    "oa-dashboard.html",
    "--output",
    "reports/release-inputs",
    "--repo",
    "owner/repo",
    "--json"
  ]);

  assert.equal(parsed.apply, true);
  assert.equal(parsed.ensureGithubEnvironment, true);
  assert.equal(parsed.backendMode, "tunnel");
  assert.equal(parsed.environment, "staging");
  assert.equal(parsed.envPath, "release/.env.production");
  assert.equal(parsed.secretsSignoffPath, "release/secrets.json");
  assert.equal(parsed.hrSignoffPath, "release/hr.json");
  assert.equal(parsed.storageSignoffPath, "release/storage.json");
  assert.equal(parsed.outputDir, "reports/release-inputs");
  assert.equal(parsed.repo, "owner/repo");
  assert.equal(parsed.json, true);
});
