import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildOpsAuditInput,
  opsAuditObjectType,
  opsAuditSummary,
  parseMetadataFile,
  recordOpsAudit
} from "../../scripts/ops-audit.mjs";

test("ops audit metadata parser keeps sidecar values intact", async () => {
  const dir = await mkdtemp(join(tmpdir(), "oa-ops-audit-"));
  const metadataPath = join(dir, "backup.meta");
  try {
    await writeFile(metadataPath, [
      "artifact_type=file_storage",
      "backup_file=/secure/backups/file-storage.tar.gz",
      "checksum=sha256-demo",
      "line_without_equals"
    ].join("\n"));

    const metadata = parseMetadataFile(metadataPath);
    assert.equal(metadata.artifact_type, "file_storage");
    assert.equal(metadata.backup_file, "/secure/backups/file-storage.tar.gz");
    assert.equal(metadata.checksum, "sha256-demo");
    assert.equal(metadata.line_without_equals, "");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ops audit input classifies backup restore and retention events", () => {
  assert.equal(opsAuditObjectType({ artifact_type: "file_storage" }), "ops_file_storage");
  assert.equal(opsAuditObjectType({ artifact_type: "backup_retention" }), "ops_backup_retention");
  assert.equal(opsAuditObjectType({}), "ops_database");
  assert.equal(opsAuditSummary("ops.backup", {}), "数据库备份完成");
  assert.equal(opsAuditSummary("ops.restore", { artifact_type: "file_storage" }), "文件存储恢复完成");
  assert.equal(opsAuditSummary("ops.backup_prune", { artifact_type: "backup_retention" }), "备份保留清理完成");

  const input = buildOpsAuditInput({
    action: "ops.backup",
    tenant: { id: "tenant-1" },
    actor: { id: "user-1" },
    metadata: { backup_file: "/secure/backups/db.dump" }
  });
  assert.equal(input.objectType, "ops_database");
  assert.equal(input.objectId, "/secure/backups/db.dump");
  assert.equal(input.userAgent, "scripts/ops-audit.mjs");
});

test("recordOpsAudit uses unified appendAuditLog redaction path", async () => {
  const dir = await mkdtemp(join(tmpdir(), "oa-ops-audit-"));
  const metadataPath = join(dir, "restore.meta");
  const createdRows = [];
  const prisma = {
    tenant: {
      findUnique: async ({ where }) => ({ id: "tenant-1", code: where.code })
    },
    user: {
      findUnique: async ({ where }) => ({ id: "user-1", email: where.tenantId_email.email })
    },
    auditLog: {
      create: async ({ data }) => {
        createdRows.push(data);
        return data;
      }
    }
  };

  try {
    await writeFile(metadataPath, [
      "artifact_type=file_storage",
      "restore_file=/secure/backups/file-storage.tar.gz",
      "objectKey=private/hr/invoice.pdf",
      "token=secret-token"
    ].join("\n"));

    const row = await recordOpsAudit({
      prisma,
      action: "ops.restore",
      metadataPath,
      tenantCode: "default",
      adminEmail: "admin@oa.local"
    });

    assert.equal(createdRows.length, 1);
    assert.equal(row.action, "ops.restore");
    assert.equal(row.objectType, "ops_file_storage");
    assert.equal(row.objectId, "/secure/backups/file-storage.tar.gz");
    assert.equal(row.metadata.objectKey, "[REDACTED:attachment-object-key]");
    assert.equal(row.metadata.token, "[REDACTED:secret]");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
