import { apiRequest } from "./client.js";

function timestampToken() {
  return new Date().toISOString().replaceAll(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function downloadCsv(csv, scope = "资源预约台账") {
  if (
    typeof csv !== "string"
    || typeof document === "undefined"
    || typeof Blob === "undefined"
    || typeof URL === "undefined"
    || typeof URL.createObjectURL !== "function"
  ) {
    return;
  }

  const safeScope = String(scope || "资源预约台账")
    .trim()
    .replace(/[^\w\u4e00-\u9fa5-]+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 40) || "resource-bookings";
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `resource-bookings-${safeScope}-${timestampToken()}.csv`;
  link.style.display = "none";
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function listResources(query) {
  return apiRequest("/resources", { query });
}

export function reserveResource(payload) {
  return apiRequest("/resources/bookings", {
    body: payload,
    method: "POST"
  });
}

export function cancelResourceBooking(id, payload = {}) {
  return apiRequest(`/resources/bookings/${encodeURIComponent(id)}/cancel`, {
    body: payload,
    method: "POST"
  });
}

export function listResourceBookings(query) {
  return apiRequest("/resources/bookings", { query });
}

export async function exportResourceBookings(filters = {}) {
  const scope = filters.scope || "资源预约台账";
  const csv = await apiRequest("/resources/bookings/export", {
    body: { businessReason: filters.businessReason || `导出${scope}用于行政资源核对`, filters, scope },
    headers: { accept: "text/csv" },
    method: "POST"
  });
  downloadCsv(csv, scope);
  return csv;
}
