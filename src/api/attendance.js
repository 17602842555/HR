import { apiRequest } from "./client.js";

function timestampToken() {
  return new Date().toISOString().replaceAll(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function downloadCsv(csv, scope = "考勤记录台账") {
  if (
    typeof csv !== "string"
    || typeof document === "undefined"
    || typeof Blob === "undefined"
    || typeof URL === "undefined"
    || typeof URL.createObjectURL !== "function"
  ) {
    return;
  }

  const safeScope = String(scope || "考勤记录台账")
    .trim()
    .replace(/[^\w\u4e00-\u9fa5-]+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 40) || "attendance-records";
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `attendance-records-${safeScope}-${timestampToken()}.csv`;
  link.style.display = "none";
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function listLeaves(query) {
  return apiRequest("/attendance/leaves", { query });
}

export function listAttendanceRecords(query) {
  return apiRequest("/attendance/records", { query });
}

export function createAttendanceRecord(payload) {
  return apiRequest("/attendance/records", {
    body: payload,
    method: "POST"
  });
}

export async function exportAttendanceRecords(filters = {}) {
  const scope = filters.scope || "考勤记录台账";
  const csv = await apiRequest("/attendance/records/export", {
    body: { businessReason: filters.businessReason || `导出${scope}用于考勤核对`, filters, scope },
    headers: { accept: "text/csv" },
    method: "POST"
  });
  downloadCsv(csv, scope);
  return csv;
}

export function createLeave(payload) {
  return apiRequest("/attendance/leaves", {
    body: payload,
    method: "POST"
  });
}
