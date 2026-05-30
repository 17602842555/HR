import { apiRequest } from "./client.js";

function filenameToken(scope) {
  return String(scope || "audit")
    .trim()
    .replace(/[^\w\u4e00-\u9fa5-]+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 40) || "audit";
}

function timestampToken() {
  return new Date().toISOString().replaceAll(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function downloadCsv(csv, scope) {
  if (
    typeof csv !== "string"
    || typeof document === "undefined"
    || typeof Blob === "undefined"
    || typeof URL === "undefined"
    || typeof URL.createObjectURL !== "function"
  ) {
    return;
  }

  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `audit-export-${filenameToken(scope)}-${timestampToken()}.csv`;
  link.style.display = "none";
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function listAuditLogs(query) {
  return apiRequest("/audit", { query });
}

export function listExportRecords(query) {
  return apiRequest("/audit/export-records", { query });
}

export function getAuditIntegrity(query) {
  return apiRequest("/audit/integrity", { query });
}

export async function exportAudit(scope, filters = {}) {
  const csv = await apiRequest("/audit/export", {
    body: { businessReason: filters.businessReason || `导出${scope || "审计日志"}用于审计复核`, filters, scope },
    headers: { accept: "text/csv" },
    method: "POST"
  });
  downloadCsv(csv, scope);
  return csv;
}

export function setSensitiveAccess(enabled) {
  return apiRequest("/audit/sensitive-access", {
    body: { enabled },
    method: "POST"
  });
}
