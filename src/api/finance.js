import { apiRequest } from "./client.js";

function timestampToken() {
  return new Date().toISOString().replaceAll(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function downloadCsv(csv, scope = "财务单据台账") {
  if (
    typeof csv !== "string"
    || typeof document === "undefined"
    || typeof Blob === "undefined"
    || typeof URL === "undefined"
    || typeof URL.createObjectURL !== "function"
  ) {
    return;
  }

  const safeScope = String(scope || "财务单据台账")
    .trim()
    .replace(/[^\w\u4e00-\u9fa5-]+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 40) || "finance-requests";
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `finance-requests-${safeScope}-${timestampToken()}.csv`;
  link.style.display = "none";
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function listFinanceRequests(query) {
  return apiRequest("/finance/requests", { query });
}

export function createFinanceRequest(payload = {}) {
  return apiRequest("/finance/requests", {
    body: payload,
    method: "POST"
  });
}

export async function exportFinanceRequests(filters = {}) {
  const scope = filters.scope || "财务单据台账";
  const csv = await apiRequest("/finance/requests/export", {
    body: { businessReason: filters.businessReason || `导出${scope}用于财务复核`, filters, scope },
    headers: { accept: "text/csv" },
    method: "POST"
  });
  downloadCsv(csv, scope);
  return csv;
}

export function listPayrolls(query) {
  return apiRequest("/finance/payrolls", { query });
}

export function createPayroll(payload = {}) {
  return apiRequest("/finance/payrolls", {
    body: payload,
    method: "POST"
  });
}

export function reviewPayroll(id, payload = {}) {
  return apiRequest(`/finance/payrolls/${encodeURIComponent(id)}/review`, {
    body: payload,
    method: "POST"
  });
}
