import { DomainError } from "../../lib/domainErrors.mjs";
import { attachAuditIntegrity } from "./audit-integrity.mjs";
import { redactAuditPayload } from "./redaction.mjs";

export { redactAuditPayload } from "./redaction.mjs";

export async function appendAuditLog(prisma, input) {
  const metadata = redactAuditPayload({
    result: "成功",
    ...(input.metadata || {}),
    ...(input.requestId ? { requestId: input.requestId } : {})
  });
  const unsignedRow = {
    tenantId: input.tenantId,
    actorUserId: input.actorUserId || null,
    action: input.action,
    objectType: input.objectType,
    objectId: input.objectId || null,
    summary: input.summary,
    metadata,
    ipAddress: input.ipAddress || null,
    userAgent: input.userAgent || null
  };
  const signedRow = await attachAuditIntegrity(prisma, unsignedRow);

  // Audit logs are append-only by service contract. Do not add normal update/delete
  // paths for audit_logs; corrections must be represented by a new compensating row.
  return prisma.auditLog.create({
    data: signedRow
  });
}

function moduleFromAction(action = "") {
  const [module] = String(action).split(".");
  return module || "system";
}

export function normalizeExportBusinessReason(input = {}) {
  return String(
    input.businessReason
    || input.exportReason
    || input.reason
    || input.filters?.businessReason
    || input.metadata?.businessReason
    || ""
  ).trim().slice(0, 240);
}

export function requireExportBusinessReason(input = {}) {
  const businessReason = normalizeExportBusinessReason(input);
  if (businessReason.length < 4) {
    throw new DomainError(
      "EXPORT_BUSINESS_REASON_REQUIRED",
      "导出需填写至少 4 个字符的业务用途说明。",
      { field: "businessReason" }
    );
  }
  return businessReason;
}

export async function recordExportEvent(prisma, input) {
  const filters = redactAuditPayload(input.filters || input.metadata?.filters || {});
  const businessReason = normalizeExportBusinessReason(input);
  const rowCount = Number.isFinite(Number(input.rowCount ?? input.metadata?.rowCount))
    ? Number(input.rowCount ?? input.metadata?.rowCount)
    : 0;
  const format = input.format || input.metadata?.format || "csv";
  const status = input.status || input.metadata?.result || "成功";
  const normalizedStatus = status === "成功" ? "SUCCESS" : String(status || "SUCCESS").toUpperCase();

  const writeRecords = async (tx) => {
    const exportRecord = await tx.exportRecord.create({
      data: {
        tenantId: input.tenantId,
        actorUserId: input.actorUserId || null,
        action: input.action,
        module: input.module || moduleFromAction(input.action),
        scope: input.scope || input.metadata?.scope || input.summary,
        businessReason: businessReason || null,
        fileName: input.fileName || null,
        format,
        rowCount,
        filters,
        status: normalizedStatus,
        ipAddress: input.ipAddress || null,
        userAgent: input.userAgent || null,
        requestId: input.requestId || null
      }
    });

    const auditLog = await appendAuditLog(tx, {
      ...input,
      objectId: input.objectId || exportRecord.id,
      metadata: {
        ...(input.metadata || {}),
        exportRecordId: exportRecord.id,
        businessReason,
        fileName: input.fileName,
        filters,
        format,
        rowCount
      }
    });

    return { auditLog, exportRecord };
  };

  if (prisma.exportRecord?.create && typeof prisma.$transaction === "function") {
    return prisma.$transaction(writeRecords);
  }

  if (prisma.exportRecord?.create) return writeRecords(prisma);
  return { auditLog: await appendAuditLog(prisma, input), exportRecord: null };
}

export function requestAuditMeta(request) {
  return {
    ipAddress: request.ip,
    requestId: request.id,
    userAgent: request.headers["user-agent"] || ""
  };
}
