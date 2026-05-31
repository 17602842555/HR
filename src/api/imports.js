import { apiRequest } from "./client.js";

function safeFileName(fileName) {
  return String(fileName || "people-source.html").replace(/[\\/:*?"<>|]/g, "_").slice(0, 120) || "people-source.html";
}

function downloadBlob(blob, fileName) {
  if (
    typeof document === "undefined"
    || typeof URL === "undefined"
    || typeof URL.createObjectURL !== "function"
  ) {
    return;
  }
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = safeFileName(fileName);
  link.style.display = "none";
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function listImportRuns(query) {
  return apiRequest("/imports", { query });
}

export function importDashboardHtml(payload) {
  return apiRequest("/imports/dashboard-html", {
    body: payload,
    method: "POST",
    timeoutMs: 30000
  });
}

export async function downloadImportSource(run) {
  const blob = await apiRequest(`/imports/${encodeURIComponent(run.id)}/source`, {
    headers: { accept: "application/octet-stream" },
    responseType: "blob"
  });
  downloadBlob(blob, run.metadata?.sourceArtifact?.fileName || run.sourceName || "people-source.html");
  return blob;
}
