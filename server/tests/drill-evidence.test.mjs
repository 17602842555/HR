import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  parseDrillEvidenceArgs,
  parseMetadataText,
  validateCommercialDrillEvidence
} from "../../scripts/validate-drill-evidence.mjs";
import {
  parseLocalRecoveryDrillArgs,
  validateLocalRecoveryDrillEvidence
} from "../../scripts/validate-local-recovery-drill.mjs";

async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function writeJson(path, payload) {
  await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`);
}

async function writeMetadata(path, entries) {
  await writeFile(path, `${Object.entries(entries).map(([key, value]) => `${key}=${value}`).join("\n")}\n`);
}

async function createValidDrillFixture(overrides = {}) {
  const dir = await mkdtemp(join(tmpdir(), "oa-drill-evidence-"));
  const storageDir = join(dir, "storage");
  await mkdir(storageDir, { recursive: true });
  await writeFile(join(storageDir, "attachment.txt"), "restored attachment");

  const dbBackup = join(dir, "oa_commercial-20260530-120000.dump");
  await writeFile(dbBackup, "custom postgres dump bytes");
  const dbStats = await stat(dbBackup);
  const dbMeta = `${dbBackup}.meta`;
  await writeMetadata(dbMeta, {
    created_at: "20260530-120000",
    app_env: "development",
    artifact_type: "database",
    database: "oa_commercial",
    service: "postgres",
    backup_file: dbBackup,
    size_bytes: dbStats.size,
    sha256: await sha256(dbBackup),
    rpo_target: "24h",
    rto_target: "4h"
  });

  const fileBackup = join(dir, "file-storage-development-20260530-120000.tar.gz");
  const tar = spawnSync("tar", ["-czf", fileBackup, "-C", storageDir, "."], { encoding: "utf8" });
  assert.equal(tar.status, 0, tar.stderr);
  const fileStats = await stat(fileBackup);
  const fileMeta = `${fileBackup}.meta`;
  await writeMetadata(fileMeta, {
    created_at: "20260530-120000",
    app_env: "development",
    artifact_type: "file_storage",
    storage_mode: "local",
    api_service: "api",
    file_storage_dir: storageDir,
    backup_file: fileBackup,
    file_count: 1,
    size_bytes: fileStats.size,
    sha256: await sha256(fileBackup),
    rpo_target: "24h",
    rto_target: "4h"
  });

  const readyPayload = {
    kind: "api-readiness",
    capturedAt: "2026-05-30T12:00:00.000Z",
    baseUrl: "http://127.0.0.1:8787",
    status: 200,
    ok: true,
    payload: { ok: true, service: "oa-api", database: "ok", fileStorage: "ok" }
  };
  const smokePayload = {
    ok: true,
    kind: "commercial-smoke",
    runId: "test-run",
    baseUrl: "http://127.0.0.1:8787",
    tenantCode: "default",
    startedAt: "2026-05-30T12:00:00.000Z",
    finishedAt: "2026-05-30T12:02:00.000Z",
    evidence: { auditRows: 10 }
  };

  const preReady = join(dir, "pre-restore-ready.json");
  const postReady = join(dir, "post-restore-ready.json");
  const preSmoke = join(dir, "pre-restore-smoke.json");
  const postSmoke = join(dir, "post-restore-smoke.json");
  await writeJson(preReady, readyPayload);
  await writeJson(postReady, readyPayload);
  await writeJson(preSmoke, smokePayload);
  await writeJson(postSmoke, smokePayload);

  const summaryPath = join(dir, "drill-summary.json");
  await writeJson(summaryPath, {
    ok: true,
    kind: "commercial-drill",
    startedAt: "2026-05-30T12:00:00Z",
    finishedAt: "2026-05-30T12:03:00Z",
    apiBaseUrl: "http://127.0.0.1:8787",
    databaseUrl: "postgresql://oa:***@127.0.0.1:5432/oa_commercial?schema=public",
    backupFile: dbBackup,
    backupMeta: dbMeta,
    fileBackup,
    fileBackupMeta: fileMeta,
    preRestoreReadyEvidence: preReady,
    postRestoreReadyEvidence: postReady,
    preRestoreSmokeEvidence: preSmoke,
    postRestoreSmokeEvidence: postSmoke,
    ...overrides.summary
  });

  return {
    dir,
    summaryPath,
    dbBackup,
    dbMeta,
    fileBackup,
    fileMeta,
    preReady,
    postReady,
    preSmoke,
    postSmoke
  };
}

test("commercial drill evidence validator accepts a complete restore drill package", async () => {
  const fixture = await createValidDrillFixture();
  try {
    const result = validateCommercialDrillEvidence(fixture.summaryPath);

    assert.equal(result.ok, true);
    assert.deepEqual(result.errors, []);
    assert.equal(result.evidence.apiBaseUrl, "http://127.0.0.1:8787");
  } finally {
    await rm(fixture.dir, { recursive: true, force: true });
  }
});

test("commercial drill evidence validator rejects unmasked database passwords", async () => {
  const fixture = await createValidDrillFixture({
    summary: { databaseUrl: "postgresql://oa:oa_dev_password@127.0.0.1:5432/oa_commercial?schema=public" }
  });
  try {
    const result = validateCommercialDrillEvidence(fixture.summaryPath);

    assert.equal(result.ok, false);
    assert(result.errors.some((error) => error.includes("databaseUrl exposes a known secret fragment")));
    assert(result.errors.some((error) => error.includes("must mask the password")));
  } finally {
    await rm(fixture.dir, { recursive: true, force: true });
  }
});

test("commercial drill evidence validator rejects checksum mismatches and missing files", async () => {
  const fixture = await createValidDrillFixture({
    summary: { postRestoreSmokeEvidence: "/tmp/oa-missing-post-smoke.json" }
  });
  try {
    await writeMetadata(fixture.dbMeta, {
      artifact_type: "database",
      backup_file: fixture.dbBackup,
      size_bytes: (await stat(fixture.dbBackup)).size,
      sha256: "0".repeat(64)
    });

    const result = validateCommercialDrillEvidence(fixture.summaryPath);

    assert.equal(result.ok, false);
    assert(result.errors.some((error) => error.includes("database backup artifact checksum mismatch")));
    assert(result.errors.some((error) => error.includes("post-restore evidence file is missing")));
  } finally {
    await rm(fixture.dir, { recursive: true, force: true });
  }
});

test("commercial drill evidence validator rejects failed readiness and smoke evidence", async () => {
  const fixture = await createValidDrillFixture();
  try {
    await writeJson(fixture.postReady, {
      kind: "api-readiness",
      status: 200,
      ok: true,
      payload: { ok: true, database: "ok", fileStorage: "unavailable" }
    });
    await writeJson(fixture.postSmoke, {
      ok: false,
      kind: "commercial-smoke",
      finishedAt: "2026-05-30T12:02:00.000Z"
    });

    const result = validateCommercialDrillEvidence(fixture.summaryPath);

    assert.equal(result.ok, false);
    assert(result.errors.some((error) => error.includes("file storage readiness must be ok")));
    assert(result.errors.some((error) => error.includes("smoke evidence did not pass")));
  } finally {
    await rm(fixture.dir, { recursive: true, force: true });
  }
});

test("commercial drill evidence validator enforces RPO and RTO timing", async () => {
  const fixture = await createValidDrillFixture({
    summary: {
      startedAt: "2026-05-30T07:00:00Z",
      finishedAt: "2026-05-30T12:03:00Z"
    }
  });
  try {
    await writeMetadata(fixture.dbMeta, {
      created_at: "20260529-060000",
      app_env: "development",
      artifact_type: "database",
      database: "oa_commercial",
      service: "postgres",
      backup_file: fixture.dbBackup,
      size_bytes: (await stat(fixture.dbBackup)).size,
      sha256: await sha256(fixture.dbBackup),
      rpo_target: "24h",
      rto_target: "4h"
    });

    const result = validateCommercialDrillEvidence(fixture.summaryPath);

    assert.equal(result.ok, false);
    assert(result.errors.some((error) => error.includes("database backup backup age exceeds RPO target")));
    assert(result.errors.some((error) => error.includes("drill duration exceeds RTO target")));
  } finally {
    await rm(fixture.dir, { recursive: true, force: true });
  }
});

test("commercial drill evidence validator rejects weak or malformed recovery targets", async () => {
  const fixture = await createValidDrillFixture();
  try {
    await writeMetadata(fixture.fileMeta, {
      created_at: "not-a-date",
      app_env: "development",
      artifact_type: "file_storage",
      storage_mode: "local",
      api_service: "api",
      file_storage_dir: fixture.dir,
      backup_file: fixture.fileBackup,
      file_count: 1,
      size_bytes: (await stat(fixture.fileBackup)).size,
      sha256: await sha256(fixture.fileBackup),
      rpo_target: "48h",
      rto_target: "tomorrow"
    });

    const result = validateCommercialDrillEvidence(fixture.summaryPath);

    assert.equal(result.ok, false);
    assert(result.errors.some((error) => error.includes("file storage backup metadata created_at must be a valid timestamp")));
    assert(result.errors.some((error) => error.includes("file storage backup metadata rpo_target exceeds commercial maximum")));
    assert(result.errors.some((error) => error.includes("file storage backup metadata rto_target must be an hour target")));
  } finally {
    await rm(fixture.dir, { recursive: true, force: true });
  }
});

test("commercial drill evidence validator rejects local recovery summaries by default", async () => {
  const fixture = await createValidDrillFixture({
    summary: {
      kind: "commercial-local-recovery-drill",
      executionMode: "local-postgres"
    }
  });
  try {
    const result = validateCommercialDrillEvidence(fixture.summaryPath);

    assert.equal(result.ok, false);
    assert(result.errors.some((error) => error.includes("drill summary kind must be commercial-drill")));
  } finally {
    await rm(fixture.dir, { recursive: true, force: true });
  }
});

test("local recovery drill validator accepts local diagnostic evidence", async () => {
  const fixture = await createValidDrillFixture({
    summary: {
      kind: "commercial-local-recovery-drill",
      executionMode: "local-postgres"
    }
  });
  try {
    const result = validateLocalRecoveryDrillEvidence(fixture.summaryPath);

    assert.equal(result.ok, true);
    assert.deepEqual(result.errors, []);
    assert(result.warnings.some((warning) => warning.includes("does not replace Docker compose release drill evidence")));
  } finally {
    await rm(fixture.dir, { recursive: true, force: true });
  }
});

test("commercial drill evidence parser and metadata parser read expected values", () => {
  assert.deepEqual(parseDrillEvidenceArgs(["--summary", "custom.json", "--json"]), {
    summaryPath: "custom.json",
    json: true
  });
  assert.deepEqual(parseLocalRecoveryDrillArgs(["local.json", "--json"]), {
    summaryPath: "local.json",
    json: true
  });
  assert.deepEqual(parseDrillEvidenceArgs(["custom.json"]), {
    summaryPath: "custom.json",
    json: false
  });
  assert.deepEqual(parseMetadataText("artifact_type=database\nsha256=abc\n"), {
    artifact_type: "database",
    sha256: "abc"
  });
});
