import { apiRequest } from "./client.js";

function timestampToken() {
  return new Date().toISOString().replaceAll(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function filenameToken(scope) {
  return String(scope || "approvals")
    .trim()
    .replace(/[^\w\u4e00-\u9fa5-]+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 40) || "approvals";
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
  link.download = `approval-export-${filenameToken(scope)}-${timestampToken()}.csv`;
  link.style.display = "none";
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function listApprovals(query) {
  return apiRequest("/approvals", { query });
}

export function listApprovalDefinitions(query) {
  return apiRequest("/approvals/definitions", { query });
}

export function getApproval(id) {
  return apiRequest(`/approvals/${encodeURIComponent(id)}`);
}

export function createApproval(payload) {
  return apiRequest("/approvals", {
    body: payload,
    method: "POST"
  });
}

export async function exportApprovals(filters = {}) {
  const scope = filters.scope || "审批列表";
  const csv = await apiRequest("/approvals/export", {
    body: { businessReason: filters.businessReason || `导出${scope}用于流程复核`, filters, scope },
    headers: { accept: "text/csv" },
    method: "POST"
  });
  downloadCsv(csv, scope);
  return csv;
}

export function decideApproval(id, payload) {
  return apiRequest(`/approvals/${encodeURIComponent(id)}/decision`, {
    body: payload,
    method: "POST"
  });
}

export function transferApproval(id, payload) {
  return apiRequest(`/approvals/${encodeURIComponent(id)}/transfer`, {
    body: payload,
    method: "POST"
  });
}

export function withdrawApproval(id, payload = {}) {
  return apiRequest(`/approvals/${encodeURIComponent(id)}/withdraw`, {
    body: payload,
    method: "POST"
  });
}

export function addApprovalComment(id, payload) {
  return apiRequest(`/approvals/${encodeURIComponent(id)}/comments`, {
    body: payload,
    method: "POST"
  });
}

export function listApprovalRules(query) {
  return apiRequest("/approvals/rules", { query });
}

export function listApprovalRuleCoverage(query) {
  return apiRequest("/approvals/rules/coverage", { query });
}

export function previewApprovalRule(query) {
  return apiRequest("/approvals/rules/preview", { query });
}

export function saveApprovalRule(rule) {
  const path = rule?.id ? `/approvals/rules/${encodeURIComponent(rule.id)}` : "/approvals/rules";
  return apiRequest(path, {
    body: rule,
    method: rule?.id ? "PUT" : "POST"
  });
}

export function deleteApprovalRule(id) {
  return apiRequest(`/approvals/rules/${encodeURIComponent(id)}`, {
    method: "DELETE"
  });
}
