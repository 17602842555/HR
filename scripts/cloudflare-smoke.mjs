import { pathToFileURL } from "node:url";

const DEFAULT_TIMEOUT_MS = 10000;

function boolFlag(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").toLowerCase());
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function isLocalHostname(hostname) {
  return ["localhost", "127.0.0.1", "::1"].includes(String(hostname || "").toLowerCase());
}

export function normalizeDeploymentUrl(rawValue, { allowLocal = false } = {}) {
  const value = String(rawValue || "").trim();
  if (!value) throw new Error("Cloudflare deployment URL is required.");
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Cloudflare deployment URL must be a valid absolute URL.");
  }
  if (!["https:", "http:"].includes(parsed.protocol)) {
    throw new Error("Cloudflare deployment URL must use http or https.");
  }
  if (!allowLocal && parsed.protocol !== "https:") {
    throw new Error("Cloudflare deployment URL must use https outside local smoke mode.");
  }
  if (!allowLocal && isLocalHostname(parsed.hostname)) {
    throw new Error("Cloudflare deployment URL must not be a local host outside local smoke mode.");
  }
  parsed.hash = "";
  parsed.search = "";
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  return parsed.toString().replace(/\/+$/, "");
}

export function parseCloudflareSmokeArgs(argv = process.argv.slice(2), env = process.env) {
  const options = {
    allowLocal: boolFlag(env.CLOUDFLARE_SMOKE_ALLOW_LOCAL),
    json: boolFlag(env.CLOUDFLARE_SMOKE_JSON),
    requireApiOrigin: !boolFlag(env.CLOUDFLARE_SMOKE_ALLOW_MISSING_API_ORIGIN),
    retries: parsePositiveInt(env.CLOUDFLARE_SMOKE_RETRIES, 3),
    retryDelayMs: parsePositiveInt(env.CLOUDFLARE_SMOKE_RETRY_DELAY_MS, 2000),
    timeoutMs: parsePositiveInt(env.CLOUDFLARE_SMOKE_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    url: env.CLOUDFLARE_DEPLOYMENT_URL || ""
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--allow-local") {
      options.allowLocal = true;
    } else if (arg === "--allow-missing-api-origin") {
      options.requireApiOrigin = false;
    } else if (arg === "--timeout-ms") {
      options.timeoutMs = parsePositiveInt(argv[index + 1], options.timeoutMs);
      index += 1;
    } else if (arg === "--retries") {
      options.retries = parsePositiveInt(argv[index + 1], options.retries);
      index += 1;
    } else if (arg === "--retry-delay-ms") {
      options.retryDelayMs = parsePositiveInt(argv[index + 1], options.retryDelayMs);
      index += 1;
    } else if (arg === "--url") {
      options.url = argv[index + 1] || "";
      index += 1;
    } else {
      throw new Error(`Unknown cloudflare smoke argument: ${arg}`);
    }
  }

  return options;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function status(level, name, message, details = {}) {
  return { details, level, message, name };
}

function buildFetchSignal(timeoutMs) {
  return typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
    ? AbortSignal.timeout(timeoutMs)
    : undefined;
}

async function fetchJson(fetchImpl, url, { timeoutMs }) {
  let response;
  try {
    response = await fetchImpl(url, {
      headers: { accept: "application/json" },
      signal: buildFetchSignal(timeoutMs)
    });
  } catch (error) {
    return {
      ok: false,
      status: 0,
      error: error?.name === "AbortError" || error?.name === "TimeoutError"
        ? "timeout"
        : error?.message || "request_failed"
    };
  }

  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    return {
      ok: false,
      status: response.status,
      error: "invalid_json",
      preview: text.slice(0, 200)
    };
  }

  return {
    ok: response.ok,
    payload,
    status: response.status
  };
}

async function fetchJsonWithRetries(fetchImpl, url, { retries, retryDelayMs, timeoutMs }) {
  let result = null;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    result = await fetchJson(fetchImpl, url, { timeoutMs });
    if (result.ok) return { ...result, attempts: attempt };
    if (attempt < retries) await sleep(retryDelayMs);
  }
  return { ...(result || { ok: false, status: 0, error: "request_failed" }), attempts: retries };
}

function edgeHealthCheck(result, requireApiOrigin) {
  if (!result.ok) {
    return status("fail", "edge-health", "Cloudflare Worker edge health endpoint is not reachable.", {
      error: result.error || "",
      status: result.status
    });
  }
  const payload = result.payload || {};
  if (payload.ok !== true || payload.service !== "deep-oa-cloudflare-edge") {
    return status("fail", "edge-health", "Cloudflare Worker edge health payload is not the OA edge gateway.", {
      service: payload.service || "",
      status: result.status
    });
  }
  if (requireApiOrigin && payload.apiOriginConfigured !== true) {
    return status("fail", "edge-api-origin", "Cloudflare Worker is deployed but API_ORIGIN is not configured.", {
      apiOriginConfigured: payload.apiOriginConfigured === true
    });
  }
  if (payload.apiOriginConfigured !== true) {
    return status("warn", "edge-api-origin", "Cloudflare Worker is deployed without API_ORIGIN; backend proxy smoke was skipped.", {
      apiOriginConfigured: false
    });
  }
  return status("pass", "edge-health", "Cloudflare Worker edge health is reachable and configured.", {
    apiOriginConfigured: true
  });
}

function backendHealthCheck(result) {
  if (!result.ok) {
    return status("fail", "backend-health", "Cloudflare Worker cannot reach the OA backend health endpoint.", {
      error: result.error || "",
      status: result.status
    });
  }
  if (result.payload?.service !== "deep-oa-api") {
    return status("fail", "backend-health", "Cloudflare Worker backend proxy did not return the OA API service.", {
      service: result.payload?.service || "",
      status: result.status
    });
  }
  return status("pass", "backend-health", "Cloudflare Worker backend proxy reaches the OA API.", {
    status: result.status
  });
}

function openApiCheck(result) {
  if (!result.ok) {
    return status("fail", "openapi-contract", "Cloudflare Worker cannot reach the backend OpenAPI contract.", {
      error: result.error || "",
      status: result.status
    });
  }
  const doc = result.payload || {};
  if (doc.info?.title !== "集团人事行政 OA Commercial API" || !doc.paths?.["/iam"]) {
    return status("fail", "openapi-contract", "Backend OpenAPI contract behind Cloudflare is not the commercial OA contract.", {
      status: result.status,
      title: doc.info?.title || ""
    });
  }
  return status("pass", "openapi-contract", "Backend OpenAPI contract is reachable behind Cloudflare.", {
    pathCount: Object.keys(doc.paths || {}).length,
    status: result.status
  });
}

export async function runCloudflareSmoke({
  allowLocal = false,
  fetchImpl = globalThis.fetch,
  requireApiOrigin = true,
  retries = 3,
  retryDelayMs = 2000,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  url
} = {}) {
  if (typeof fetchImpl !== "function") throw new Error("A fetch implementation is required.");
  const deploymentUrl = normalizeDeploymentUrl(url, { allowLocal });
  const checks = [];

  const edgeResult = await fetchJsonWithRetries(fetchImpl, `${deploymentUrl}/api/edge/health`, {
    retries,
    retryDelayMs,
    timeoutMs
  });
  const edgeCheck = edgeHealthCheck(edgeResult, requireApiOrigin);
  checks.push(edgeCheck);

  const shouldCheckBackend = edgeResult.ok && edgeResult.payload?.apiOriginConfigured === true;
  if (shouldCheckBackend) {
    checks.push(backendHealthCheck(await fetchJsonWithRetries(fetchImpl, `${deploymentUrl}/api/health`, {
      retries,
      retryDelayMs,
      timeoutMs
    })));
    checks.push(openApiCheck(await fetchJsonWithRetries(fetchImpl, `${deploymentUrl}/api/openapi.json`, {
      retries,
      retryDelayMs,
      timeoutMs
    })));
  } else if (requireApiOrigin) {
    checks.push(status("fail", "backend-health", "Backend proxy checks require API_ORIGIN to be configured."));
    checks.push(status("fail", "openapi-contract", "OpenAPI proxy check requires API_ORIGIN to be configured."));
  }

  const hardBlockers = checks.filter((check) => check.level === "fail");
  const warnings = checks.filter((check) => check.level === "warn");
  return {
    checks,
    hardBlockers,
    ok: hardBlockers.length === 0,
    service: "cloudflare-smoke",
    url: deploymentUrl,
    warnings
  };
}

function printHumanReport(report) {
  report.checks.forEach((check) => {
    const prefix = check.level === "pass" ? "PASS" : check.level === "warn" ? "WARN" : "FAIL";
    console.log(`${prefix} ${check.name}: ${check.message}`);
  });
  console.log(report.ok ? "Cloudflare smoke passed." : "Cloudflare smoke failed.");
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = parseCloudflareSmokeArgs();
    const report = await runCloudflareSmoke({
      allowLocal: options.allowLocal,
      requireApiOrigin: options.requireApiOrigin,
      retries: options.retries,
      retryDelayMs: options.retryDelayMs,
      timeoutMs: options.timeoutMs,
      url: options.url
    });
    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      printHumanReport(report);
    }
    process.exitCode = report.ok ? 0 : 1;
  } catch (error) {
    const payload = {
      checks: [status("fail", "cloudflare-smoke", error?.message || "Cloudflare smoke failed.")],
      hardBlockers: [{ name: "cloudflare-smoke", message: error?.message || "Cloudflare smoke failed." }],
      ok: false,
      service: "cloudflare-smoke"
    };
    if (process.argv.includes("--json")) {
      console.log(JSON.stringify(payload, null, 2));
    } else {
      console.error(error?.message || error);
    }
    process.exitCode = 1;
  }
}
