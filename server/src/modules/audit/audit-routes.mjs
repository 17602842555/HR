import { appendAuditLog, recordExportEvent, requestAuditMeta, requireExportBusinessReason } from "./audit-service.mjs";
import { verifyAuditIntegrityChain } from "./audit-integrity.mjs";
import { boundedQueryLimit } from "../../lib/pagination.mjs";
import { requirePermission } from "../iam/route-guards.mjs";

function formatDateTime(value) {
  if (!value) return "";
  return new Date(value).toLocaleString("sv-SE", { hour12: false }).replace("T", " ").slice(0, 19);
}

function typeLabel(action) {
  if (action.includes("export")) return "导出";
  if (action.includes("login")) return "登录";
  if (action.includes("approve")) return "审批";
  if (action.includes("reject")) return "审批";
  if (action.includes("create") || action.includes("submit")) return "新增";
  if (action.includes("conflict")) return "预约冲突";
  if (action.includes("sensitive")) return "更新";
  return "更新";
}

function serializeAudit(log) {
  return {
    id: log.id,
    time: formatDateTime(log.createdAt),
    operator: log.actor?.name || "系统",
    type: typeLabel(log.action),
    object: log.objectType,
    content: log.summary,
    result: log.metadata?.result || "成功",
    ip: log.ipAddress || "-"
  };
}

function serializeExportRecord(record) {
  return {
    id: record.id,
    time: formatDateTime(record.createdAt),
    operator: record.actor?.name || "系统",
    module: record.module,
    action: record.action,
    scope: record.scope,
    businessReason: record.businessReason || "-",
    fileName: record.fileName || "-",
    format: record.format,
    rowCount: record.rowCount,
    result: record.status === "SUCCESS" ? "成功" : record.status,
    ip: record.ipAddress || "-",
    requestId: record.requestId || "-",
    filters: record.filters || {}
  };
}

function validDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function normalizeExportFilters(input = {}) {
  const filters = {};
  ["action", "objectType", "result"].forEach((key) => {
    const value = input[key];
    if (typeof value === "string" && value.trim()) filters[key] = value.trim();
  });
  const from = validDate(input.from);
  const to = validDate(input.to);
  if (from) filters.from = from.toISOString();
  if (to) filters.to = to.toISOString();
  return filters;
}

function exportWhere(tenantId, filters) {
  const where = { tenantId };
  if (filters.action) where.action = filters.action;
  if (filters.objectType) where.objectType = filters.objectType;
  if (filters.result && filters.result !== "成功") where.metadata = { path: ["result"], equals: filters.result };
  if (filters.from || filters.to) {
    where.createdAt = {};
    if (filters.from) where.createdAt.gte = new Date(filters.from);
    if (filters.to) where.createdAt.lte = new Date(filters.to);
  }
  return where;
}

function csvCell(value) {
  const text = value === null || value === undefined ? "" : String(value);
  const safeText = /^[\s]*[=+\-@]/.test(text) ? `'${text}` : text;
  return `"${safeText.replaceAll("\"", "\"\"").replaceAll(/\r?\n/g, " ")}"`;
}

function auditRowsForCsv(logs, resultFilter) {
  return logs
    .map(serializeAudit)
    .filter((row) => !resultFilter || row.result === resultFilter)
    .map((row) => ({
      操作时间: row.time,
      操作人: row.operator,
      类型: row.type,
      对象: row.object,
      操作内容: row.content,
      结果: row.result,
      IP地址: row.ip
    }));
}

function toCsv(rows) {
  const headers = ["操作时间", "操作人", "类型", "对象", "操作内容", "结果", "IP地址"];
  const lines = [
    headers.map(csvCell).join(","),
    ...rows.map((row) => headers.map((header) => csvCell(row[header])).join(","))
  ];
  return `\uFEFF${lines.join("\n")}\n`;
}

function listLimit(value) {
  return boundedQueryLimit(value, { fallback: 200, max: 500 });
}

function exportLimit(value) {
  return boundedQueryLimit(value, { fallback: 1000, max: 5000 });
}

export async function registerAuditRoutes(app) {
  app.get("/api/audit", { preHandler: app.authenticate }, async (request) => {
    await requirePermission(app, request, { module: "audit", action: "read" });
    const filters = normalizeExportFilters(request.query || {});
    const [logs, exportRecords] = await Promise.all([
      app.prisma.auditLog.findMany({
        where: exportWhere(request.user.tenantId, filters),
        include: { actor: true },
        orderBy: { createdAt: "desc" },
        take: listLimit(request.query?.limit)
      }),
      app.prisma.exportRecord.findMany({
        where: { tenantId: request.user.tenantId },
        include: { actor: true },
        orderBy: { createdAt: "desc" },
        take: listLimit(request.query?.exportLimit || request.query?.limit)
      })
    ]);
    const rows = logs.map(serializeAudit).filter((row) => !filters.result || row.result === filters.result);
    return { auditLogs: rows, exportRecords: exportRecords.map(serializeExportRecord), revealSensitive: false };
  });

  app.get("/api/audit/export-records", { preHandler: app.authenticate }, async (request) => {
    await requirePermission(app, request, { module: "audit", action: "read" });
    const records = await app.prisma.exportRecord.findMany({
      where: { tenantId: request.user.tenantId },
      include: { actor: true },
      orderBy: { createdAt: "desc" },
      take: listLimit(request.query?.limit)
    });
    return { exportRecords: records.map(serializeExportRecord) };
  });

  app.get("/api/audit/integrity", { preHandler: app.authenticate }, async (request) => {
    await requirePermission(app, request, { module: "audit", action: "read" });
    const logs = await app.prisma.auditLog.findMany({
      where: { tenantId: request.user.tenantId },
      orderBy: [{ createdAt: "asc" }],
      take: exportLimit(request.query?.limit)
    });
    return verifyAuditIntegrityChain(logs);
  });

  app.post("/api/audit/export", { preHandler: app.authenticate }, async (request, reply) => {
    await requirePermission(app, request, { module: "audit", action: "export" });
    const scope = request.body?.scope || "审计日志";
    const filters = normalizeExportFilters(request.body?.filters || {});
    const logs = await app.prisma.auditLog.findMany({
      where: exportWhere(request.user.tenantId, filters),
      include: { actor: true },
      orderBy: { createdAt: "desc" },
      take: exportLimit(request.body?.limit)
    });
    const rows = auditRowsForCsv(logs, filters.result);
    const csv = toCsv(rows);
    const businessReason = requireExportBusinessReason(request.body || {});
    const timestamp = new Date().toISOString().replaceAll(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
    const filename = `audit-export-${timestamp}.csv`;

    await recordExportEvent(app.prisma, {
      tenantId: request.user.tenantId,
      actorUserId: request.user.sub,
      action: "audit.export",
      module: "audit",
      objectType: "audit_log",
      fileName: filename,
      scope,
      businessReason,
      rowCount: rows.length,
      filters,
      summary: `导出${scope}，自动记录导出人和时间`,
      metadata: {
        scope,
        filters,
        format: "csv",
        rowCount: rows.length
      },
      ...requestAuditMeta(request)
    });

    return replyCsv(reply, csv, filename, rows.length);
  });

  app.post("/api/audit/sensitive-access", { preHandler: app.authenticate }, async (request) => {
    await requirePermission(app, request, { module: "employee", action: "sensitive" });
    const enabled = Boolean(request.body?.enabled);
    await appendAuditLog(app.prisma, {
      tenantId: request.user.tenantId,
      actorUserId: request.user.sub,
      action: "audit.sensitive_access",
      objectType: "permission",
      summary: enabled ? "开启敏感字段查看" : "关闭敏感字段查看",
      metadata: { enabled },
      ...requestAuditMeta(request)
    });
    return { ok: true, revealSensitive: enabled };
  });
}

function replyCsv(reply, csv, filename, rowCount) {
  return reply
    .header("Content-Type", "text/csv; charset=utf-8")
    .header("Content-Disposition", `attachment; filename="${filename}"`)
    .header("X-Row-Count", String(rowCount))
    .header("Cache-Control", "no-store")
    .send(csv);
}
