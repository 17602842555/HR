import { apiRequest } from "./client.js";

function timestampToken() {
  return new Date().toISOString().replaceAll(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function filenameToken(scope) {
  return String(scope || "people")
    .trim()
    .replace(/[^\w\u4e00-\u9fa5-]+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 40) || "people";
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
  link.download = `people-export-${filenameToken(scope)}-${timestampToken()}.csv`;
  link.style.display = "none";
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function getPeopleOverview(query) {
  return apiRequest("/people", { query });
}

export function listEmployees(query) {
  return apiRequest("/people/employees", { query });
}

export function listLeavers(query) {
  return apiRequest("/people/leavers", { query });
}

export function updateEmployee(id, payload) {
  return apiRequest(`/people/employees/${encodeURIComponent(id)}`, {
    body: payload,
    method: "PATCH"
  });
}

export async function exportPeople(filters = {}) {
  const scope = filters.scope || "人员名册";
  const csv = await apiRequest("/people/export", {
    body: { businessReason: filters.businessReason || `导出${scope}用于人事核对`, filters, scope },
    headers: { accept: "text/csv" },
    method: "POST"
  });
  downloadCsv(csv, scope);
  return csv;
}
