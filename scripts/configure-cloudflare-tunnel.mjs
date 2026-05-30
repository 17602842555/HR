import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseDotenvText } from "./commercial-doctor-core.mjs";
import { normalizeDeploymentUrl } from "./cloudflare-smoke.mjs";

const cloudflareTunnelConfigBaseUrl = "https://api.cloudflare.com/client/v4/accounts";
const defaultBackendServiceUrl = "http://api:8787";
const cloudflareTunnelConfigEndpoint = "PUT /accounts/{account_id}/cfd_tunnel/{tunnel_id}/configurations";

const placeholderFragments = Object.freeze([
  "changeme",
  "change-me",
  "example.com",
  "placeholder",
  "replace-with",
  "todo"
]);

function boolFlag(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").toLowerCase());
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function isPresent(value) {
  return Boolean(String(value || "").trim());
}

function isPlaceholder(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return !normalized
    || normalized.includes("<")
    || placeholderFragments.some((fragment) => normalized.includes(fragment));
}

function sanitizeCloudflareMessage(value = "") {
  return String(value || "")
    .replaceAll(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replaceAll(/(token|secret|password|key)=\S+/gi, "$1=[REDACTED]")
    .slice(0, 260);
}

function loadEnvFile(envPath) {
  if (!envPath || !existsSync(envPath)) return {};
  return parseDotenvText(readFileSync(envPath, "utf8"));
}

function mergeEnv(fileEnv = {}, runtimeEnv = {}) {
  return {
    ...fileEnv,
    ...Object.fromEntries(
      Object.entries({
        API_ORIGIN: runtimeEnv.API_ORIGIN,
        CLOUDFLARE_ACCOUNT_ID: runtimeEnv.CLOUDFLARE_ACCOUNT_ID,
        CLOUDFLARE_API_TOKEN: runtimeEnv.CLOUDFLARE_API_TOKEN,
        CLOUDFLARE_BACKEND_SERVICE_URL: runtimeEnv.CLOUDFLARE_BACKEND_SERVICE_URL,
        CLOUDFLARE_TUNNEL_ID: runtimeEnv.CLOUDFLARE_TUNNEL_ID,
        CLOUDFLARE_TUNNEL_NAME: runtimeEnv.CLOUDFLARE_TUNNEL_NAME
      }).filter(([, value]) => isPresent(value))
    )
  };
}

function normalizeService(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function apiOriginHostname(value) {
  const normalized = normalizeDeploymentUrl(value);
  return new URL(normalized).hostname.toLowerCase();
}

function safeIngressRule(rule = {}) {
  const output = {};
  if (isPresent(rule.hostname)) output.hostname = String(rule.hostname).trim().toLowerCase();
  if (isPresent(rule.path)) output.path = String(rule.path).trim();
  if (isPresent(rule.service)) output.service = normalizeService(rule.service);
  if (rule.originRequest && typeof rule.originRequest === "object" && !Array.isArray(rule.originRequest)) {
    output.originRequest = rule.originRequest;
  }
  return output;
}

function isCatchAllRule(rule = {}) {
  return !isPresent(rule.hostname) && normalizeService(rule.service).toLowerCase().startsWith("http_status:");
}

function buildEndpoint(accountId, tunnel) {
  return `${cloudflareTunnelConfigBaseUrl}/${encodeURIComponent(accountId)}/cfd_tunnel/${encodeURIComponent(tunnel)}/configurations`;
}

function readCloudflareApiErrors(payload, fallback) {
  const errors = Array.isArray(payload?.errors) ? payload.errors : [];
  const messages = errors
    .map((error) => error?.message)
    .filter(Boolean)
    .map((message) => sanitizeCloudflareMessage(message));
  return messages.length ? messages : [fallback];
}

export function parseCloudflareTunnelConfigArgs(argv = process.argv.slice(2), env = process.env) {
  const options = {
    accountId: env.CLOUDFLARE_ACCOUNT_ID || "",
    apiOrigin: env.API_ORIGIN || "",
    apiToken: env.CLOUDFLARE_API_TOKEN || "",
    apply: boolFlag(env.CLOUDFLARE_TUNNEL_CONFIG_APPLY),
    backendService: env.CLOUDFLARE_BACKEND_SERVICE_URL || defaultBackendServiceUrl,
    envPath: ".env.production",
    json: boolFlag(env.CLOUDFLARE_TUNNEL_CONFIG_JSON),
    timeoutMs: parsePositiveInt(env.CLOUDFLARE_TUNNEL_CONFIG_TIMEOUT_MS, 8000),
    tunnel: env.CLOUDFLARE_TUNNEL_ID || env.CLOUDFLARE_TUNNEL_NAME || ""
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--apply") {
      options.apply = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--account-id") {
      options.accountId = argv[index + 1] || "";
      index += 1;
    } else if (arg === "--api-origin") {
      options.apiOrigin = argv[index + 1] || "";
      index += 1;
    } else if (arg === "--backend-service") {
      options.backendService = argv[index + 1] || "";
      index += 1;
    } else if (arg === "--env") {
      options.envPath = argv[index + 1] || "";
      index += 1;
    } else if (arg === "--timeout-ms") {
      options.timeoutMs = parsePositiveInt(argv[index + 1], options.timeoutMs);
      index += 1;
    } else if (arg === "--tunnel") {
      options.tunnel = argv[index + 1] || "";
      index += 1;
    } else {
      throw new Error(`Unknown Cloudflare Tunnel configuration argument: ${arg}`);
    }
  }
  return options;
}

export function buildCloudflareTunnelIngressPlan({
  accountId = "",
  apiOrigin = "",
  apiToken = "",
  apply = false,
  backendService = defaultBackendServiceUrl,
  currentIngress = [],
  currentInspected = false,
  tunnel = ""
} = {}) {
  const errors = [];
  const warnings = [];
  let hostname = "";
  const service = normalizeService(backendService || defaultBackendServiceUrl);

  try {
    hostname = apiOriginHostname(apiOrigin);
  } catch (error) {
    errors.push(`API_ORIGIN: ${error?.message || "must be a valid HTTPS origin."}`);
  }
  if (isPlaceholder(apiOrigin)) errors.push("API_ORIGIN must be a real backend Tunnel public hostname, not a placeholder.");
  if (!/^https?:\/\/[^/\s]+(?::\d+)?$/i.test(service)) {
    errors.push("Cloudflare backend service must be a simple service URL such as http://api:8787.");
  }
  if (service.toLowerCase() !== defaultBackendServiceUrl) {
    warnings.push(`Backend service override is ${service}; production compose defaults to ${defaultBackendServiceUrl}.`);
  }
  if (apply) {
    if (!/^[a-f0-9]{32}$/i.test(String(accountId || "").trim())) {
      errors.push("CLOUDFLARE_ACCOUNT_ID is required and must be the 32-character account id before applying Tunnel configuration.");
    }
    if (!isPresent(tunnel)) {
      errors.push("Cloudflare tunnel UUID is required before applying Tunnel configuration.");
    }
    if (isPlaceholder(apiToken) || String(apiToken || "").trim().length < 20) {
      errors.push("CLOUDFLARE_API_TOKEN with Cloudflare Tunnel Write permission is required before applying Tunnel configuration.");
    }
    if (!currentInspected) {
      errors.push("Existing Tunnel configuration must be inspected before applying changes.");
    }
  } else if (!currentInspected) {
    warnings.push("Dry run did not inspect existing Tunnel configuration; apply mode will preserve unrelated hostnames after reading Cloudflare.");
  }

  const normalizedRules = Array.isArray(currentIngress) ? currentIngress.map(safeIngressRule) : [];
  const preservedRules = normalizedRules
    .filter((rule) => !isCatchAllRule(rule))
    .filter((rule) => rule.hostname !== hostname)
    .filter((rule) => isPresent(rule.service));
  const desiredIngress = hostname
    ? [
      { hostname, service },
      ...preservedRules,
      { service: "http_status:404" }
    ]
    : [
      ...preservedRules,
      { service: "http_status:404" }
    ];

  return {
    apply,
    desiredConfig: {
      config: {
        ingress: desiredIngress
      }
    },
    endpoint: cloudflareTunnelConfigEndpoint,
    errors,
    ok: errors.length === 0,
    summary: {
      accountIdPresent: isPresent(accountId),
      apiOriginConfigured: Boolean(hostname),
      backendService: service,
      catchAllConfigured: desiredIngress.at(-1)?.service === "http_status:404",
      currentInspected,
      desiredIngressCount: desiredIngress.length,
      preservedIngressCount: preservedRules.length,
      publicHostname: hostname,
      tunnelConfigured: isPresent(tunnel)
    },
    warnings
  };
}

export async function readCloudflareTunnelConfigurationRaw({
  accountId,
  apiToken,
  fetchImpl = globalThis.fetch,
  timeoutMs = 8000,
  tunnel
} = {}) {
  if (!isPresent(accountId) || !isPresent(apiToken) || !isPresent(tunnel)) {
    return {
      checked: false,
      config: null,
      errors: ["CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, and tunnel id are required to inspect Tunnel configuration."]
    };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(buildEndpoint(accountId, tunnel), {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${apiToken}`
      },
      method: "GET",
      signal: controller.signal
    });
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    if (!response.ok || payload?.success !== true) {
      return {
        checked: false,
        config: null,
        errors: readCloudflareApiErrors(payload, `Cloudflare Tunnel configuration read returned HTTP ${response.status}.`)
      };
    }
    return {
      checked: true,
      config: payload?.result?.config || { ingress: [] },
      errors: []
    };
  } catch (error) {
    return {
      checked: false,
      config: null,
      errors: [sanitizeCloudflareMessage(error?.message || "Cloudflare Tunnel configuration read failed.")]
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function applyCloudflareTunnelIngressPlan(plan, {
  accountId,
  apiToken,
  fetchImpl = globalThis.fetch,
  timeoutMs = 8000,
  tunnel
} = {}) {
  if (!plan?.ok) {
    return {
      applied: false,
      errors: ["Cloudflare Tunnel ingress plan is not valid; refusing to apply."],
      ok: false
    };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(buildEndpoint(accountId, tunnel), {
      body: JSON.stringify(plan.desiredConfig),
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "application/json"
      },
      method: "PUT",
      signal: controller.signal
    });
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    if (!response.ok || payload?.success !== true) {
      return {
        applied: false,
        errors: readCloudflareApiErrors(payload, `Cloudflare Tunnel configuration update returned HTTP ${response.status}.`),
        ok: false
      };
    }
    return {
      applied: true,
      errors: [],
      ok: true,
      summary: {
        ingressCount: Array.isArray(payload?.result?.config?.ingress)
          ? payload.result.config.ingress.length
          : plan.desiredConfig.config.ingress.length
      }
    };
  } catch (error) {
    return {
      applied: false,
      errors: [sanitizeCloudflareMessage(error?.message || "Cloudflare Tunnel configuration update failed.")],
      ok: false
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function runCloudflareTunnelConfig({
  accountId,
  apiOrigin,
  apiToken,
  apply = false,
  backendService,
  envPath,
  fetchImpl = globalThis.fetch,
  runtimeEnv = process.env,
  timeoutMs,
  tunnel
} = {}) {
  const fileEnv = loadEnvFile(envPath || ".env.production");
  const merged = mergeEnv(fileEnv, runtimeEnv);
  const effective = {
    accountId: accountId || merged.CLOUDFLARE_ACCOUNT_ID || "",
    apiOrigin: apiOrigin || merged.API_ORIGIN || "",
    apiToken: apiToken || merged.CLOUDFLARE_API_TOKEN || "",
    backendService: backendService || merged.CLOUDFLARE_BACKEND_SERVICE_URL || defaultBackendServiceUrl,
    tunnel: tunnel || merged.CLOUDFLARE_TUNNEL_ID || merged.CLOUDFLARE_TUNNEL_NAME || ""
  };

  let currentRead = {
    checked: false,
    config: null,
    errors: []
  };
  if (isPresent(effective.accountId) && isPresent(effective.apiToken) && isPresent(effective.tunnel)) {
    currentRead = await readCloudflareTunnelConfigurationRaw({
      accountId: effective.accountId,
      apiToken: effective.apiToken,
      fetchImpl,
      timeoutMs,
      tunnel: effective.tunnel
    });
  }

  const plan = buildCloudflareTunnelIngressPlan({
    accountId: effective.accountId,
    apiOrigin: effective.apiOrigin,
    apiToken: effective.apiToken,
    apply,
    backendService: effective.backendService,
    currentIngress: currentRead.config?.ingress || [],
    currentInspected: currentRead.checked,
    tunnel: effective.tunnel
  });
  if (currentRead.errors.length) {
    if (apply) plan.errors.push(...currentRead.errors);
    else plan.warnings.push(...currentRead.errors);
    plan.ok = plan.errors.length === 0;
  }

  const applyResult = apply && plan.ok
    ? await applyCloudflareTunnelIngressPlan(plan, {
      accountId: effective.accountId,
      apiToken: effective.apiToken,
      fetchImpl,
      timeoutMs,
      tunnel: effective.tunnel
    })
    : null;

  return {
    ...plan,
    applyResult,
    ok: plan.ok && (!apply || applyResult?.ok === true),
    service: "cloudflare-tunnel-config"
  };
}

function printHumanReport(report) {
  report.errors.forEach((error) => console.error(`FAIL ${error}`));
  report.warnings.forEach((warning) => console.warn(`WARN ${warning}`));
  if (report.applyResult?.errors?.length) {
    report.applyResult.errors.forEach((error) => console.error(`FAIL ${error}`));
  }
  if (report.ok) {
    console.log(report.apply ? "Cloudflare Tunnel configuration applied." : "Cloudflare Tunnel configuration plan is valid.");
  } else {
    console.error("Cloudflare Tunnel configuration is not ready.");
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  let options;
  try {
    options = parseCloudflareTunnelConfigArgs();
    const report = await runCloudflareTunnelConfig(options);
    if (options.json) console.log(JSON.stringify(report, null, 2));
    else printHumanReport(report);
    process.exitCode = report.ok ? 0 : 1;
  } catch (error) {
    const report = {
      errors: [sanitizeCloudflareMessage(error?.message || "Cloudflare Tunnel configuration failed.")],
      ok: false,
      service: "cloudflare-tunnel-config",
      warnings: []
    };
    if (options?.json || process.argv.includes("--json")) console.log(JSON.stringify(report, null, 2));
    else console.error(report.errors[0]);
    process.exitCode = 1;
  }
}
