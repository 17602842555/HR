import assert from "node:assert/strict";
import test from "node:test";
import {
  attachAuditIntegrity,
  auditIntegrityAlgorithm,
  computeAuditRecordHash,
  stripAuditIntegrity,
  verifyAuditIntegrityChain
} from "../src/modules/audit/audit-integrity.mjs";
import { appendAuditLog } from "../src/modules/audit/audit-service.mjs";

function auditInput(overrides = {}) {
  return {
    tenantId: "tenant-1",
    actorUserId: "user-1",
    action: "workflow.submit",
    objectType: "workflow_instance",
    objectId: "wf-1",
    summary: "提交费用报销审批流程",
    metadata: { result: "成功", amount: 128 },
    ipAddress: "127.0.0.1",
    userAgent: "node:test",
    ...overrides
  };
}

function prismaMock() {
  const rows = [];
  return {
    rows,
    auditLog: {
      findMany: async ({ where } = {}) => rows.filter((row) => !where?.tenantId || row.tenantId === where.tenantId),
      create: async ({ data }) => {
        const record = {
          id: `audit-${rows.length + 1}`,
          createdAt: new Date(`2026-05-30T00:00:0${rows.length}.000Z`),
          ...data
        };
        rows.unshift(record);
        return record;
      }
    }
  };
}

test("audit integrity metadata signs sanitized audit rows and strips caller integrity", async () => {
  const prisma = prismaMock();
  const signed = await attachAuditIntegrity(prisma, auditInput({
    metadata: {
      result: "成功",
      phone: "13800138000",
      integrity: { recordHash: "caller-controlled" }
    }
  }));

  assert.equal(signed.metadata.phone, "13800138000");
  assert.equal(signed.metadata.integrity.algorithm, auditIntegrityAlgorithm);
  assert.equal(signed.metadata.integrity.sequence, 1);
  assert.equal(signed.metadata.integrity.previousHash, null);
  assert.match(signed.metadata.integrity.recordHash, /^[a-f0-9]{64}$/);
  assert.equal(stripAuditIntegrity(signed.metadata).integrity, undefined);
  assert.equal(signed.metadata.integrity.recordHash, computeAuditRecordHash(signed, {
    previousHash: null,
    sequence: 1
  }));
});

test("appendAuditLog creates a contiguous tenant audit hash chain", async () => {
  const prisma = prismaMock();
  const first = await appendAuditLog(prisma, auditInput({ objectId: "wf-1" }));
  const second = await appendAuditLog(prisma, auditInput({ objectId: "wf-2", summary: "审批通过费用报销" }));
  const firstIntegrity = first.metadata.integrity;
  const secondIntegrity = second.metadata.integrity;

  assert.equal(firstIntegrity.sequence, 1);
  assert.equal(secondIntegrity.sequence, 2);
  assert.equal(secondIntegrity.previousHash, firstIntegrity.recordHash);
  assert.equal(secondIntegrity.recordHash, computeAuditRecordHash(second, {
    previousHash: firstIntegrity.recordHash,
    sequence: 2
  }));

  const result = verifyAuditIntegrityChain(prisma.rows);
  assert.equal(result.ok, true);
  assert.equal(result.summary.signedRows, 2);
  assert.equal(result.summary.unsignedRows, 0);
  assert.equal(result.summary.lastHash, secondIntegrity.recordHash);
});

test("audit integrity verifier detects tampered payloads broken links and unsigned legacy rows", async () => {
  const prisma = prismaMock();
  const first = await appendAuditLog(prisma, auditInput({ objectId: "wf-1" }));
  const second = await appendAuditLog(prisma, auditInput({ objectId: "wf-2", summary: "审批通过费用报销" }));
  const legacy = { ...auditInput({ objectId: "legacy" }), id: "legacy", metadata: { result: "成功" } };

  const tamperedPayload = [
    { ...second, summary: "被篡改的审批摘要" },
    first,
    legacy
  ];
  const tamperResult = verifyAuditIntegrityChain(tamperedPayload);
  assert.equal(tamperResult.ok, false);
  assert(tamperResult.errors.some((error) => error.includes("recordHash does not match payload")));
  assert(tamperResult.warnings.some((warning) => warning.includes("legacy audit-log rows are unsigned")));

  const brokenLink = [
    { ...second, metadata: { ...second.metadata, integrity: { ...second.metadata.integrity, previousHash: "0".repeat(64) } } },
    first
  ];
  const brokenResult = verifyAuditIntegrityChain(brokenLink);
  assert.equal(brokenResult.ok, false);
  assert(brokenResult.errors.some((error) => error.includes("previousHash does not match")));
});
