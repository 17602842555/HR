import { apiRequest } from "./client.js";

function timestampToken() {
  return new Date().toISOString().replaceAll(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function downloadCsv(csv, scope = "资产台账") {
  if (
    typeof csv !== "string"
    || typeof document === "undefined"
    || typeof Blob === "undefined"
    || typeof URL === "undefined"
    || typeof URL.createObjectURL !== "function"
  ) {
    return;
  }

  const safeScope = String(scope || "资产台账")
    .trim()
    .replace(/[^\w\u4e00-\u9fa5-]+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 40) || "asset-ledger";
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `asset-ledger-${safeScope}-${timestampToken()}.csv`;
  link.style.display = "none";
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function listAssets(query) {
  return apiRequest("/assets", { query });
}

export function createAsset(payload) {
  return apiRequest("/assets", {
    body: payload,
    method: "POST"
  });
}

export function updateAsset(id, payload) {
  return apiRequest(`/assets/${encodeURIComponent(id)}`, {
    body: payload,
    method: "PATCH"
  });
}

export function runAssetAction(id, payload) {
  return apiRequest(`/assets/${encodeURIComponent(id)}/actions`, {
    body: payload,
    method: "POST"
  });
}

export function replaceAssetQr(id) {
  return apiRequest(`/assets/${encodeURIComponent(id)}/qr`, {
    method: "POST"
  });
}

export function listAssetEvents(query) {
  return apiRequest("/assets/events", { query });
}

export async function exportAssets(filters = {}) {
  const scope = filters.scope || "资产台账";
  const csv = await apiRequest("/assets/export", {
    body: { businessReason: filters.businessReason || `导出${scope}用于资产盘点`, filters, scope },
    headers: { accept: "text/csv" },
    method: "POST"
  });
  downloadCsv(csv, scope);
  return csv;
}
