function boolEnv(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

export function resolveApiPolicy(env = {}) {
  const requireApi = boolEnv(env.VITE_REQUIRE_API) || Boolean(env.PROD);
  const allowDemoFallback = !requireApi && (Boolean(env.DEV) || boolEnv(env.VITE_DEMO_FALLBACK));
  return {
    allowDemoFallback,
    requireApi
  };
}

export function apiUnavailableStatus(error, env = {}) {
  const policy = resolveApiPolicy(env);
  if (policy.allowDemoFallback) {
    return {
      error: "后端未连接，当前使用本地演示数据",
      mode: "fallback",
      source: "mock"
    };
  }
  return {
    error: error?.message || "后端不可用，请检查 API、数据库和部署配置。",
    mode: "api_required",
    source: "api"
  };
}
