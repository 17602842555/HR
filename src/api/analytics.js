import { apiRequest } from "./client.js";

function timestampToken() {
  return new Date().toISOString().replaceAll(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function filenameToken(scope) {
  return String(scope || "analytics")
    .trim()
    .replace(/[^\w\u4e00-\u9fa5-]+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 40) || "analytics";
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
  link.download = `analytics-snapshot-${filenameToken(scope)}-${timestampToken()}.csv`;
  link.style.display = "none";
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function getAnalyticsOverview(query) {
  return apiRequest("/analytics/overview", { query });
}

export async function exportAnalyticsSnapshot(filters = {}) {
  const scope = filters.scope || "管理看板快照";
  const csv = await apiRequest("/analytics/export", {
    body: { businessReason: filters.businessReason || `导出${scope}用于管理复盘`, filters, scope },
    headers: { accept: "text/csv" },
    method: "POST"
  });
  downloadCsv(csv, scope);
  return csv;
}
