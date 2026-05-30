import { apiRequest } from "./client.js";

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      const value = String(reader.result || "");
      resolve(value.includes(",") ? value.slice(value.indexOf(",") + 1) : value);
    });
    reader.addEventListener("error", () => reject(reader.error || new Error("Unable to read file")));
    reader.readAsDataURL(file);
  });
}

function safeFileName(fileName) {
  return String(fileName || "attachment.bin").replace(/[\\/:*?"<>|]/g, "_").slice(0, 120) || "attachment.bin";
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

export function listFiles(query) {
  return apiRequest("/files", { query });
}

export async function uploadFile(file, options = {}) {
  const contentBase64 = await readFileAsBase64(file);
  return apiRequest("/files", {
    body: {
      assetId: options.assetId || null,
      contentBase64,
      fileName: file.name || options.fileName,
      mimeType: file.type || options.mimeType || "application/octet-stream",
      visibility: options.visibility || "PRIVATE",
      workflowInstanceId: options.workflowInstanceId || null
    },
    method: "POST"
  });
}

export async function downloadFile(file) {
  const blob = await apiRequest(`/files/${encodeURIComponent(file.id)}/download`, {
    headers: { accept: file.mimeType || "application/octet-stream" },
    responseType: "blob"
  });
  downloadBlob(blob, file.fileName);
  return blob;
}
