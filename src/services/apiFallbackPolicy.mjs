const LOCAL_FALLBACK_ERROR_CODES = new Set(["NETWORK_ERROR", "API_TIMEOUT"]);

export function canFallbackToLocalAction(error, policy = {}) {
  if (policy.requireApi || !policy.allowDemoFallback) return false;
  const status = Number(error?.status || 0);
  const code = String(error?.code || "");
  return status === 0 && LOCAL_FALLBACK_ERROR_CODES.has(code);
}

export function apiActionErrorStatus(error, policy = {}) {
  const status = Number(error?.status || 0);
  if (canFallbackToLocalAction(error, policy)) {
    return {
      error: error?.message || "API action failed",
      mode: "degraded",
      source: "mixed"
    };
  }
  if (status > 0) {
    return {
      error: error?.message || "API action failed",
      mode: "degraded",
      source: "api"
    };
  }
  return {
    error: error?.message || "API action failed",
    mode: policy.requireApi ? "api_required" : "degraded",
    source: "api"
  };
}
