import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { normalizeDeploymentUrl, runCloudflareSmoke } from "./cloudflare-smoke.mjs";

const cloudflareTunnelApiBaseUrl = "https://api.cloudflare.com/client/v4/accounts";
const defaultBackendServiceUrl = "http://api:8787";

export const requiredNativeCloudflareGithubSecrets = Object.freeze([
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_DEPLOYMENT_URL"
]);

export const requiredTunnelCloudflareGithubSecrets = Object.freeze([
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_ACCOUNT_ID",
  "API_ORIGIN",
  "CLOUDFLARE_DEPLOYMENT_URL",
  "CLOUDFLARE_TUNNEL_TOKEN",
  "CLOUDFLARE_BACKEND_WEB_ORIGIN"
]);

export const requiredCloudflareGithubSecrets = requiredNativeCloudflareGithubSecrets;

function boolFlag(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").toLowerCase());
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function status(level, name, message, details = {}) {
  return { details, level, message, name };
}

function stripAnsi(value = "") {
  return String(value || "").replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "");
}

function sanitizeMessage(value = "") {
  return stripAnsi(value)
    .replaceAll(/(token|secret|password|key)=\S+/gi, "$1=[REDACTED]")
    .replaceAll(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .slice(0, 300);
}

export function parseCloudflareDeploymentStatusArgs(argv = process.argv.slice(2), env = process.env) {
  const options = {
    accountId: env.CLOUDFLARE_ACCOUNT_ID || "",
    allowMissingApiOrigin: boolFlag(env.CLOUDFLARE_STATUS_ALLOW_MISSING_API_ORIGIN),
    apiOrigin: env.API_ORIGIN || "",
    apiToken: env.CLOUDFLARE_API_TOKEN || "",
    backendService: env.CLOUDFLARE_BACKEND_SERVICE_URL || defaultBackendServiceUrl,
    json: boolFlag(env.CLOUDFLARE_STATUS_JSON),
    repo: env.GITHUB_REPOSITORY || "",
    retries: parsePositiveInt(env.CLOUDFLARE_SMOKE_RETRIES, 2),
    retryDelayMs: parsePositiveInt(env.CLOUDFLARE_SMOKE_RETRY_DELAY_MS, 1000),
    timeoutMs: parsePositiveInt(env.CLOUDFLARE_SMOKE_TIMEOUT_MS, 8000),
    tunnel: env.CLOUDFLARE_TUNNEL_ID || env.CLOUDFLARE_TUNNEL_NAME || "",
    url: env.CLOUDFLARE_DEPLOYMENT_URL || "",
    mode: env.CLOUDFLARE_STATUS_MODE || "auto"
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--allow-missing-api-origin") {
      options.allowMissingApiOrigin = true;
    } else if (arg === "--account-id") {
      options.accountId = argv[index + 1] || "";
      index += 1;
    } else if (arg === "--api-origin") {
      options.apiOrigin = argv[index + 1] || "";
      index += 1;
    } else if (arg === "--backend-service") {
      options.backendService = argv[index + 1] || "";
      index += 1;
    } else if (arg === "--repo") {
      options.repo = argv[index + 1] || "";
      index += 1;
    } else if (arg === "--tunnel") {
      options.tunnel = argv[index + 1] || "";
      index += 1;
    } else if (arg === "--url") {
      options.url = argv[index + 1] || "";
      index += 1;
    } else if (arg === "--mode") {
      options.mode = argv[index + 1] || "";
      index += 1;
    } else if (arg === "--timeout-ms") {
      options.timeoutMs = parsePositiveInt(argv[index + 1], options.timeoutMs);
      index += 1;
    } else if (arg === "--retries") {
      options.retries = parsePositiveInt(argv[index + 1], options.retries);
      index += 1;
    } else if (arg === "--retry-delay-ms") {
      options.retryDelayMs = parsePositiveInt(argv[index + 1], options.retryDelayMs);
      index += 1;
    } else {
      throw new Error(`Unknown cloudflare deployment status argument: ${arg}`);
    }
  }

  return options;
}

function normalizeDeploymentMode(mode, { apiOrigin = "", tunnel = "" } = {}) {
  const value = String(mode || "auto").trim().toLowerCase();
  if (["native", "native-worker", "worker", "cloudflare-native"].includes(value)) return "native-worker";
  if (["tunnel", "cloudflare-tunnel", "proxy"].includes(value)) return "tunnel";
  if (value && value !== "auto") {
    throw new Error("Cloudflare deployment status mode must be auto, native-worker, or tunnel.");
  }
  return String(apiOrigin || "").trim() || String(tunnel || "").trim() ? "tunnel" : "native-worker";
}

export function readGithubSecretNames({ repo, runner = spawnSync } = {}) {
  const repoName = String(repo || "").trim();
  if (!repoName) {
    return {
      checked: false,
      error: "GitHub repo is required to inspect repository secret names.",
      names: []
    };
  }
  const result = runner("gh", ["secret", "list", "--repo", repoName, "--json", "name"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  const exitStatus = typeof result?.status === "number" ? result.status : 1;
  if (result?.error || exitStatus !== 0) {
    return {
      checked: false,
      error: sanitizeMessage(result?.error?.message || result?.stderr || result?.stdout || "gh secret list failed"),
      names: []
    };
  }
  try {
    const rows = JSON.parse(result.stdout || "[]");
    return {
      checked: true,
      error: "",
      names: rows.map((row) => row.name).filter(Boolean).sort()
    };
  } catch (error) {
    return {
      checked: false,
      error: sanitizeMessage(error?.message || "Unable to parse GitHub secret list output."),
      names: []
    };
  }
}

function parseTunnelInfoOutput(output = "") {
  const statusMatch = String(output).match(/^\s*Status:\s*(.+)$/m);
  const idMatch = String(output).match(/^\s*ID:\s*(.+)$/m);
  const nameMatch = String(output).match(/^\s*Name:\s*(.+)$/m);
  const typeMatch = String(output).match(/^\s*Type:\s*(.+)$/m);
  return {
    id: idMatch?.[1]?.trim() || "",
    name: nameMatch?.[1]?.trim() || "",
    status: statusMatch?.[1]?.trim() || "",
    type: typeMatch?.[1]?.trim() || ""
  };
}

export function readCloudflareTunnelInfo({ runner = spawnSync, tunnel } = {}) {
  const tunnelRef = String(tunnel || "").trim();
  if (!tunnelRef) {
    return {
      checked: false,
      error: "Cloudflare tunnel id or name is required.",
      tunnel: null
    };
  }
  const result = runner("npx", ["wrangler", "tunnel", "info", tunnelRef], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  const exitStatus = typeof result?.status === "number" ? result.status : 1;
  if (result?.error || exitStatus !== 0) {
    return {
      checked: false,
      error: sanitizeMessage(result?.error?.message || result?.stderr || result?.stdout || "wrangler tunnel info failed"),
      tunnel: null
    };
  }
  return {
    checked: true,
    error: "",
    tunnel: parseTunnelInfoOutput(result.stdout || "")
  };
}

function readCloudflareApiErrors(payload, fallback) {
  const errors = Array.isArray(payload?.errors) ? payload.errors : [];
  const messages = errors
    .map((error) => error?.message)
    .filter(Boolean)
    .map((message) => sanitizeMessage(message));
  return messages.length ? messages.join("; ") : fallback;
}

function normalizeCloudflareApiTunnel(result = {}) {
  return {
    configSource: result.config_src || "",
    connsActiveAt: result.conns_active_at || "",
    connsInactiveAt: result.conns_inactive_at || "",
    createdAt: result.created_at || "",
    deletedAt: result.deleted_at || "",
    id: result.id || "",
    name: result.name || "",
    status: result.status || "",
    type: result.tun_type || "cfd_tunnel"
  };
}

function normalizeCloudflareIngressRules(result = {}) {
  const ingress = Array.isArray(result?.config?.ingress) ? result.config.ingress : [];
  return ingress.map((rule) => ({
    hostname: String(rule?.hostname || "").trim().toLowerCase(),
    path: String(rule?.path || "").trim(),
    service: String(rule?.service || "").trim()
  }));
}

export async function readCloudflareTunnelInfoFromApi({
  accountId,
  apiToken,
  fetchImpl = globalThis.fetch,
  timeoutMs = 8000,
  tunnel
} = {}) {
  const accountRef = String(accountId || "").trim();
  const tokenValue = String(apiToken || "").trim();
  const tunnelRef = String(tunnel || "").trim();
  if (!accountRef) {
    return {
      checked: false,
      error: "CLOUDFLARE_ACCOUNT_ID is required for Cloudflare API tunnel inspection.",
      source: "cloudflare-api",
      tunnel: null
    };
  }
  if (!tokenValue) {
    return {
      checked: false,
      error: "CLOUDFLARE_API_TOKEN is required for Cloudflare API tunnel inspection.",
      source: "cloudflare-api",
      tunnel: null
    };
  }
  if (!tunnelRef) {
    return {
      checked: false,
      error: "Cloudflare tunnel UUID is required for Cloudflare API tunnel inspection.",
      source: "cloudflare-api",
      tunnel: null
    };
  }
  if (typeof fetchImpl !== "function") {
    return {
      checked: false,
      error: "Fetch API is not available for Cloudflare API tunnel inspection.",
      source: "cloudflare-api",
      tunnel: null
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const endpoint = `${cloudflareTunnelApiBaseUrl}/${encodeURIComponent(accountRef)}/cfd_tunnel/${encodeURIComponent(tunnelRef)}`;
  try {
    const response = await fetchImpl(endpoint, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${tokenValue}`
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
        error: sanitizeMessage(readCloudflareApiErrors(payload, `Cloudflare tunnel API returned HTTP ${response.status}.`)),
        source: "cloudflare-api",
        tunnel: null
      };
    }
    return {
      checked: true,
      error: "",
      source: "cloudflare-api",
      tunnel: normalizeCloudflareApiTunnel(payload?.result || {})
    };
  } catch (error) {
    return {
      checked: false,
      error: sanitizeMessage(error?.message || "Cloudflare tunnel API request failed."),
      source: "cloudflare-api",
      tunnel: null
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function readCloudflareTunnelConfigurationFromApi({
  accountId,
  apiToken,
  fetchImpl = globalThis.fetch,
  timeoutMs = 8000,
  tunnel
} = {}) {
  const accountRef = String(accountId || "").trim();
  const tokenValue = String(apiToken || "").trim();
  const tunnelRef = String(tunnel || "").trim();
  if (!accountRef) {
    return {
      checked: false,
      error: "CLOUDFLARE_ACCOUNT_ID is required for Cloudflare Tunnel configuration inspection.",
      ingress: [],
      source: "cloudflare-api"
    };
  }
  if (!tokenValue) {
    return {
      checked: false,
      error: "CLOUDFLARE_API_TOKEN is required for Cloudflare Tunnel configuration inspection.",
      ingress: [],
      source: "cloudflare-api"
    };
  }
  if (!tunnelRef) {
    return {
      checked: false,
      error: "Cloudflare tunnel UUID is required for Cloudflare Tunnel configuration inspection.",
      ingress: [],
      source: "cloudflare-api"
    };
  }
  if (typeof fetchImpl !== "function") {
    return {
      checked: false,
      error: "Fetch API is not available for Cloudflare Tunnel configuration inspection.",
      ingress: [],
      source: "cloudflare-api"
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const endpoint = `${cloudflareTunnelApiBaseUrl}/${encodeURIComponent(accountRef)}/cfd_tunnel/${encodeURIComponent(tunnelRef)}/configurations`;
  try {
    const response = await fetchImpl(endpoint, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${tokenValue}`
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
        error: sanitizeMessage(readCloudflareApiErrors(payload, `Cloudflare tunnel configuration API returned HTTP ${response.status}.`)),
        ingress: [],
        source: "cloudflare-api"
      };
    }
    return {
      checked: true,
      error: "",
      ingress: normalizeCloudflareIngressRules(payload?.result || {}),
      source: "cloudflare-api"
    };
  } catch (error) {
    return {
      checked: false,
      error: sanitizeMessage(error?.message || "Cloudflare tunnel configuration API request failed."),
      ingress: [],
      source: "cloudflare-api"
    };
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeServiceTarget(value) {
  return String(value || "").trim().replace(/\/+$/, "").toLowerCase();
}

function tunnelIngressStatus({ apiOrigin, backendService, tunnelConfigRead }) {
  const apiOriginValue = String(apiOrigin || "").trim();
  if (!apiOriginValue) {
    return status("fail", "tunnel-ingress", "API_ORIGIN is required to validate the Cloudflare Tunnel public hostname.", {
      expectedService: backendService || defaultBackendServiceUrl
    });
  }

  let apiHostname = "";
  try {
    apiHostname = new URL(normalizeDeploymentUrl(apiOriginValue)).hostname.toLowerCase();
  } catch (error) {
    return status("fail", "tunnel-ingress", "API_ORIGIN is not a valid production HTTPS origin.", {
      error: sanitizeMessage(error?.message || "Invalid API_ORIGIN."),
      expectedService: backendService || defaultBackendServiceUrl
    });
  }

  if (!tunnelConfigRead?.checked) {
    return status("fail", "tunnel-ingress", "Cloudflare Tunnel public hostname configuration could not be inspected.", {
      error: sanitizeMessage(tunnelConfigRead?.error || "Cloudflare Tunnel configuration was not inspected."),
      expectedService: backendService || defaultBackendServiceUrl
    });
  }

  const ingress = tunnelConfigRead.ingress || [];
  const expectedService = normalizeServiceTarget(backendService || defaultBackendServiceUrl);
  const hostnameRules = ingress.filter((rule) => rule.hostname === apiHostname);
  const matchedRule = hostnameRules.find((rule) => normalizeServiceTarget(rule.service) === expectedService);
  const catchAllRule = ingress[ingress.length - 1] || null;
  const catchAllConfigured = Boolean(
    catchAllRule
    && !catchAllRule.hostname
    && normalizeServiceTarget(catchAllRule.service) === "http_status:404"
  );

  const details = {
    catchAllConfigured,
    expectedService: backendService || defaultBackendServiceUrl,
    matchedHostname: matchedRule?.hostname || "",
    matchedService: matchedRule?.service || "",
    publicHostnameCount: ingress.filter((rule) => rule.hostname).length,
    source: tunnelConfigRead.source || "cloudflare-api"
  };

  if (!matchedRule) {
    return status("fail", "tunnel-ingress", "Cloudflare Tunnel does not map API_ORIGIN to the expected backend service.", details);
  }
  if (!catchAllConfigured) {
    return status("fail", "tunnel-ingress", "Cloudflare Tunnel ingress is missing the required final http_status:404 catch-all rule.", details);
  }
  return status("pass", "tunnel-ingress", "Cloudflare Tunnel maps API_ORIGIN to the backend API service.", details);
}

export function buildCloudflareDeploymentStatus({
  apiOrigin = "",
  backendService = defaultBackendServiceUrl,
  mode = "native-worker",
  requiredSecrets = null,
  secretNames = null,
  secretRead = null,
  smokeReport = null,
  tunnelConfigRead = null,
  tunnelRead = null
} = {}) {
  const checks = [];
  const warnings = [];
  const deploymentMode = normalizeDeploymentMode(mode, { apiOrigin });
  const effectiveRequiredSecrets = requiredSecrets || (
    deploymentMode === "tunnel" ? requiredTunnelCloudflareGithubSecrets : requiredNativeCloudflareGithubSecrets
  );

  const secretSource = secretRead || {
    checked: Array.isArray(secretNames),
    names: secretNames || [],
    error: Array.isArray(secretNames) ? "" : "GitHub repository secrets were not inspected."
  };
  if (!secretSource.checked) {
    checks.push(status("fail", "github-secrets", "GitHub repository secret names could not be inspected.", {
      error: sanitizeMessage(secretSource.error)
    }));
  } else {
    const present = new Set(secretSource.names || []);
    const missing = effectiveRequiredSecrets.filter((name) => !present.has(name));
    checks.push(status(
      missing.length === 0 ? "pass" : "fail",
      "github-secrets",
      missing.length === 0
        ? "All required Cloudflare GitHub repository secrets are present."
        : "Cloudflare GitHub repository secrets are incomplete.",
      {
        missing,
        presentCount: effectiveRequiredSecrets.length - missing.length,
        requiredCount: effectiveRequiredSecrets.length
      }
    ));
  }

  if (deploymentMode === "tunnel") {
    if (!tunnelRead?.checked) {
      checks.push(status("fail", "tunnel-status", "Cloudflare Tunnel status could not be inspected.", {
        error: sanitizeMessage(tunnelRead?.error || "Cloudflare Tunnel was not inspected.")
      }));
    } else {
      const tunnelStatus = String(tunnelRead.tunnel?.status || "").toLowerCase();
      const tunnelReady = ["active", "healthy"].includes(tunnelStatus);
      checks.push(status(
        tunnelReady ? "pass" : "fail",
        "tunnel-status",
        tunnelReady
          ? "Cloudflare Tunnel is active."
          : "Cloudflare Tunnel is not active.",
        {
          configSource: tunnelRead.tunnel?.configSource || "",
          connsActiveAt: tunnelRead.tunnel?.connsActiveAt || "",
          connsInactiveAt: tunnelRead.tunnel?.connsInactiveAt || "",
          id: tunnelRead.tunnel?.id || "",
          name: tunnelRead.tunnel?.name || "",
          source: tunnelRead.source || "wrangler",
          status: tunnelRead.tunnel?.status || ""
        }
      ));
    }

    checks.push(tunnelIngressStatus({ apiOrigin, backendService, tunnelConfigRead }));
  } else {
    checks.push(status("pass", "native-worker", "Cloudflare native Worker mode does not require a custom domain, Tunnel, or API_ORIGIN.", {
      assetsAndApiSameOrigin: true,
      deploymentMode
    }));
  }

  if (!smokeReport) {
    checks.push(status("fail", "cloudflare-smoke", "Cloudflare Worker smoke was not run.", {
      error: "CLOUDFLARE_DEPLOYMENT_URL or --url is required."
    }));
  } else if (smokeReport.ok) {
    checks.push(status("pass", "cloudflare-smoke", "Cloudflare Worker and backend proxy smoke passed.", {
      url: smokeReport.url || ""
    }));
    smokeReport.warnings?.forEach((warning) => warnings.push(warning));
  } else {
    checks.push(status("fail", "cloudflare-smoke", "Cloudflare Worker/backend smoke is not production-ready.", {
      blockers: (smokeReport.hardBlockers || []).map((item) => item.name),
      url: smokeReport.url || ""
    }));
    smokeReport.warnings?.forEach((warning) => warnings.push(warning));
  }

  if (deploymentMode === "native-worker") {
    const edgeHealth = smokeReport?.checks?.find((check) => check.name === "edge-health");
    const nativeMode = edgeHealth?.details?.apiMode === "cloudflare-native";
    const d1Configured = edgeHealth?.details?.d1Configured === true;
    checks.push(status(
      nativeMode && d1Configured ? "pass" : "fail",
      "d1-persistence",
      nativeMode && d1Configured
        ? "Cloudflare native Worker reports D1 persistence is bound."
        : "Cloudflare native Worker must report D1 persistence before commercial use.",
      {
        apiMode: edgeHealth?.details?.apiMode || "",
        d1Configured
      }
    ));
  }

  const hardBlockers = checks.filter((check) => check.level === "fail");
  return {
    checks,
    deploymentMode,
    hardBlockers,
    ok: hardBlockers.length === 0,
    requiredGithubSecrets: effectiveRequiredSecrets,
    service: "cloudflare-deployment-status",
    summary: {
      cloudflareSmokeReady: Boolean(smokeReport?.ok),
      d1PersistenceReady: checks.find((check) => check.name === "d1-persistence")?.level === "pass",
      githubSecretsReady: checks.find((check) => check.name === "github-secrets")?.level === "pass",
      nativeWorkerReady: checks.find((check) => check.name === "native-worker")?.level === "pass",
      tunnelIngressReady: checks.find((check) => check.name === "tunnel-ingress")?.level === "pass",
      tunnelReady: checks.find((check) => check.name === "tunnel-status")?.level === "pass"
    },
    warnings
  };
}

export async function runCloudflareDeploymentStatus({
  accountId,
  allowMissingApiOrigin = false,
  apiOrigin,
  apiToken,
  backendService,
  fetchImpl = globalThis.fetch,
  mode = "auto",
  repo,
  retries,
  retryDelayMs,
  runner = spawnSync,
  timeoutMs,
  tunnel,
  url
} = {}) {
  const secretRead = readGithubSecretNames({ repo, runner });
  const deploymentMode = normalizeDeploymentMode(mode, { apiOrigin, tunnel });
  let tunnelRead = null;
  let tunnelConfigRead = null;
  if (deploymentMode === "tunnel") {
    if (String(accountId || "").trim() || String(apiToken || "").trim()) {
      tunnelRead = await readCloudflareTunnelInfoFromApi({
        accountId,
        apiToken,
        fetchImpl,
        timeoutMs,
        tunnel
      });
      tunnelConfigRead = await readCloudflareTunnelConfigurationFromApi({
        accountId,
        apiToken,
        fetchImpl,
        timeoutMs,
        tunnel
      });
    } else {
      tunnelRead = readCloudflareTunnelInfo({ runner, tunnel });
      if (!tunnelRead.checked) {
        const apiHint = "Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN to inspect the tunnel through the Cloudflare API without relying on Wrangler login state.";
        tunnelRead = {
          ...tunnelRead,
          error: sanitizeMessage(`${tunnelRead.error || "Wrangler tunnel inspection failed."} ${apiHint}`),
          source: "wrangler"
        };
      } else {
        tunnelRead = { ...tunnelRead, source: "wrangler" };
      }
      tunnelConfigRead = {
        checked: false,
        error: "Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN to inspect Cloudflare Tunnel public hostname configuration.",
        ingress: [],
        source: "wrangler"
      };
    }
  }
  let smokeReport = null;
  if (String(url || "").trim()) {
    smokeReport = await runCloudflareSmoke({
      fetchImpl,
      requireApiOrigin: deploymentMode === "tunnel" && !allowMissingApiOrigin,
      retries,
      retryDelayMs,
      timeoutMs,
      url
    });
  }
  return buildCloudflareDeploymentStatus({
    apiOrigin,
    backendService,
    mode: deploymentMode,
    secretRead,
    smokeReport,
    tunnelConfigRead,
    tunnelRead
  });
}

function printHumanReport(report) {
  report.checks.forEach((check) => {
    const prefix = check.level === "pass" ? "PASS" : "FAIL";
    console.log(`${prefix} ${check.name}: ${check.message}`);
  });
  report.warnings.forEach((warning) => console.warn(`WARN ${warning.name}: ${warning.message}`));
  console.log(report.ok ? "Cloudflare deployment status passed." : "Cloudflare deployment status failed.");
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  let options;
  try {
    options = parseCloudflareDeploymentStatusArgs();
    const report = await runCloudflareDeploymentStatus(options);
    if (options.json) console.log(JSON.stringify(report, null, 2));
    else printHumanReport(report);
    process.exitCode = report.ok ? 0 : 1;
  } catch (error) {
    const message = sanitizeMessage(error?.message || "Cloudflare deployment status failed.");
    const report = {
      checks: [status("fail", "cloudflare-deployment-status", message)],
      hardBlockers: [{ name: "cloudflare-deployment-status", message }],
      ok: false,
      service: "cloudflare-deployment-status"
    };
    if (options?.json || process.argv.includes("--json")) console.log(JSON.stringify(report, null, 2));
    else console.error(message);
    process.exitCode = 1;
  }
}
