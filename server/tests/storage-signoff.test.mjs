import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  loadStorageSignoff,
  parseStorageSignoffArgs,
  requiredApprovalRoles,
  supportedStorageTypes,
  validateStorageSignoff
} from "../../scripts/validate-storage-signoff.mjs";

function validStorageSignoff(overrides = {}) {
  return {
    schemaVersion: 1,
    documentId: "FILE-STORAGE-SIGNOFF-20260530-PROD",
    environment: "production",
    signedAt: "2026-05-30T12:00:00.000Z",
    storage: {
      storageType: "object-storage",
      provider: "Company Managed OSS",
      location: "oa-prod-attachments",
      region: "cn-east-1",
      backupOwner: "Infrastructure Platform Team",
      encryptionAtRest: true,
      privateAccess: true,
      independentBackup: true,
      bucketVersioning: true
    },
    runtime: {
      fileStorageDriver: "s3",
      fileStorageDir: "/app/storage/files",
      objectStorageConfigured: true,
      backedByPersistentVolume: false,
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
      drillId: "FILE-DRILL-20260530-PROD",
      completedAt: "2026-05-30T13:00:00.000Z",
      restoredTo: "staging",
      restoreMethod: "platform restore tooling restored object storage into staging.",
      evidencePath: "reports/commercial-evidence/file-storage-drill-prod.json",
      backupArtifact: {
        path: "s3://oa-prod-attachments-backup/2026-05-30.tar.gz",
        metadataPath: "s3://oa-prod-attachments-backup/2026-05-30.tar.gz.meta",
        sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        sizeBytes: 4096,
        fileCount: 2
      },
      downloadedAttachmentSmoke: {
        passed: true,
        fileId: "file-prod-0001",
        downloadedAt: "2026-05-30T13:15:00.000Z",
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
        approvedAt: "2026-05-30T13:30:00.000Z"
      },
      {
        role: "Security reviewer",
        name: "Security Reviewer",
        email: "security.reviewer@company.test",
        decision: "approved",
        approvedAt: "2026-05-30T13:35:00.000Z"
      }
    ],
    openExceptions: [],
    ...overrides
  };
}

test("storage signoff validator accepts reviewed storage controls and restore drill evidence", () => {
  const result = validateStorageSignoff(validStorageSignoff(), {
    expectedFileStorageDir: "/app/storage/files",
    expectedEnvironment: "production"
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
  assert.equal(result.summary.storageType, "object-storage");
  assert.equal(result.summary.fileStorageDriver, "s3");
  assert.equal(result.summary.auditEventCount, 2);
  assert.deepEqual(requiredApprovalRoles, ["Infrastructure owner", "Security reviewer"]);
  assert(supportedStorageTypes.includes("backed-persistent-volume"));
});

test("storage signoff validator accepts npm file restore entrypoint for local volumes", () => {
  const result = validateStorageSignoff(validStorageSignoff({
    storage: {
      storageType: "backed-persistent-volume",
      provider: "Company Managed PV",
      location: "pv-oa-prod-files",
      region: "cn-east-1",
      backupOwner: "Infrastructure Platform Team",
      encryptionAtRest: true,
      privateAccess: true,
      independentBackup: true,
      bucketVersioning: false
    },
    runtime: {
      fileStorageDriver: "local",
      fileStorageDir: "/app/storage/files",
      objectStorageConfigured: false,
      backedByPersistentVolume: true,
      noEphemeralContainerStorage: true
    },
    restoreDrill: {
      ...validStorageSignoff().restoreDrill,
      restoreMethod: "npm run restore:files -- file-storage-production-20260530.tar.gz --yes"
    }
  }), {
    expectedFileStorageDir: "/app/storage/files",
    expectedEnvironment: "production"
  });

  assert.equal(result.ok, true);
  assert.equal(result.summary.fileStorageDriver, "local");
});

test("storage signoff validator rejects example release evidence and production exceptions", () => {
  const result = validateStorageSignoff(validStorageSignoff({
    example: true,
    documentId: "FILE-STORAGE-SIGNOFF-EXAMPLE",
    openExceptions: [{ owner: "TODO", exitCriteria: "TODO" }]
  }));

  assert.equal(result.ok, false);
  assert(result.errors.some((error) => error.includes("Example storage signoff")));
  assert(result.errors.some((error) => error.includes("documentId")));
  assert(result.errors.some((error) => error.includes("production storage signoff")));
});

test("storage signoff validator rejects missing storage controls and mismatched runtime directory", () => {
  const result = validateStorageSignoff(validStorageSignoff({
    storage: {
      storageType: "backed-persistent-volume",
      provider: "Company SAN",
      location: "pv-prod",
      region: "cn-east-1",
      backupOwner: "Infra",
      encryptionAtRest: false,
      privateAccess: false,
      independentBackup: false
    },
    runtime: {
      fileStorageDriver: "local",
      fileStorageDir: ".local-files",
      backedByPersistentVolume: false,
      noEphemeralContainerStorage: false
    }
  }), { expectedFileStorageDir: "/app/storage/files" });

  assert.equal(result.ok, false);
  assert(result.errors.some((error) => error.includes("encryptionAtRest")));
  assert(result.errors.some((error) => error.includes("privateAccess")));
  assert(result.errors.some((error) => error.includes("independentBackup")));
  assert(result.errors.some((error) => error.includes("backedByPersistentVolume")));
  assert(result.errors.some((error) => error.includes("fileStorageDir must be an absolute")));
  assert(result.errors.some((error) => error.includes("match the production FILE_STORAGE_DIR")));
});

test("storage signoff validator accepts object storage without local file-storage dir", () => {
  const result = validateStorageSignoff(validStorageSignoff({
    runtime: {
      fileStorageDriver: "s3",
      objectStorageConfigured: true,
      noEphemeralContainerStorage: true
    }
  }), { expectedEnvironment: "production" });

  assert.equal(result.ok, true);
  assert.equal(result.summary.fileStorageDriver, "s3");
  assert.equal(result.summary.fileStorageDir, null);
});

test("storage signoff validator rejects incomplete restore drill and checksum mismatch", () => {
  const result = validateStorageSignoff(validStorageSignoff({
    backupPolicy: {
      schedule: "Nightly",
      retention: "7 daily",
      rpoHours: 48,
      rtoHours: 6,
      offHostCopy: false,
      restoreRunbook: "docs/DEPLOYMENT.md"
    },
    restoreDrill: {
      drillId: "FILE-DRILL-20260530-PROD",
      completedAt: "2026-05-30T13:00:00.000Z",
      restoredTo: "staging",
      restoreMethod: "manual copy",
      evidencePath: "reports/commercial-evidence/file-storage-drill-prod.json",
      backupArtifact: {
        path: "s3://oa-prod-attachments-backup/2026-05-30.tar.gz",
        metadataPath: "s3://oa-prod-attachments-backup/2026-05-30.tar.gz.meta",
        sha256: "not-a-sha",
        sizeBytes: 0,
        fileCount: 0
      },
      downloadedAttachmentSmoke: {
        passed: false,
        fileId: "file-prod-0001",
        downloadedAt: "2026-05-30T13:15:00.000Z",
        expectedChecksum: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
        actualChecksum: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
      },
      auditEventIds: ["audit-backup-prod-0001"]
    }
  }));

  assert.equal(result.ok, false);
  assert(result.errors.some((error) => error.includes("rpoHours")));
  assert(result.errors.some((error) => error.includes("rtoHours")));
  assert(result.errors.some((error) => error.includes("offHostCopy")));
  assert(result.errors.some((error) => error.includes("restoreMethod")));
  assert(result.errors.some((error) => error.includes("backupArtifact.sha256")));
  assert(result.errors.some((error) => error.includes("downloadedAttachmentSmoke.passed")));
  assert(result.errors.some((error) => error.includes("actualChecksum must match")));
  assert(result.errors.some((error) => error.includes("auditEventIds")));
});

test("storage signoff example template validates only when example mode is allowed", async () => {
  const example = loadStorageSignoff(new URL("../../docs/file-storage-signoff.example.json", import.meta.url));

  const rejected = validateStorageSignoff(example);
  assert.equal(rejected.ok, false);
  assert(rejected.errors.some((error) => error.includes("Example storage signoff")));

  const accepted = validateStorageSignoff(example, { allowExample: true, expectedFileStorageDir: "/app/storage/files" });
  assert.equal(accepted.ok, true);
  assert.equal(accepted.summary.restoreDrillId, "FILE-DRILL-20260530-EXAMPLE");
});

test("storage signoff CLI parser reads path, storage dir, environment, and example flags", async () => {
  const dir = await mkdtemp(join(tmpdir(), "oa-storage-signoff-"));
  try {
    const target = join(dir, "storage-signoff.json");
    await writeFile(target, JSON.stringify(validStorageSignoff(), null, 2));

    const parsed = parseStorageSignoffArgs([
      target,
      "--file-storage-dir",
      "/app/storage/files",
      "--environment",
      "production",
      "--allow-example",
      "--json"
    ]);
    assert.equal(parsed.signoffPath, target);
    assert.equal(parsed.expectedFileStorageDir, "/app/storage/files");
    assert.equal(parsed.expectedEnvironment, "production");
    assert.equal(parsed.allowExample, true);
    assert.equal(parsed.json, true);

    const loaded = JSON.parse(await readFile(target, "utf8"));
    assert.equal(validateStorageSignoff(loaded, {
      expectedFileStorageDir: parsed.expectedFileStorageDir,
      expectedEnvironment: parsed.expectedEnvironment
    }).ok, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
