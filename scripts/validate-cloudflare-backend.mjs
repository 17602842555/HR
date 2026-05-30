import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseDotenvText } from "./commercial-doctor-core.mjs";
import { normalizeDeploymentUrl } from "./cloudflare-smoke.mjs";

function isPlaceholder(value) {
  return !String(value || "").trim()
    || /^(changeme|change-me|example|placeholder|todo|test|demo)$/i.test(String(value || "").trim())
    || String(value || "").includes("<")
    || String(value || "").includes("example.com");
}

function originOf(value) {
  try {
    return new URL(value).origin;
  } catch {
    return "";
  }
}

function isExampleComOrigin(value) {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return hostname === "example.com" || hostname.endsWith(".example.com");
  } catch {
    return false;
  }
}

function originsFromWebOrigin(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => originOf(item) || item);
}

export function validateCloudflareBackendEnv(env = {}) {
  const errors = [];
  const warnings = [];

  if (isPlaceholder(env.CLOUDFLARE_TUNNEL_TOKEN) || String(env.CLOUDFLARE_TUNNEL_TOKEN || "").length < 20) {
    errors.push("CLOUDFLARE_TUNNEL_TOKEN must be a real remotely-managed Cloudflare Tunnel token.");
  }

  let apiOrigin = "";
  let deploymentUrl = "";
  try {
    apiOrigin = normalizeDeploymentUrl(env.API_ORIGIN);
  } catch (error) {
    errors.push(`API_ORIGIN: ${error.message}`);
  }
  try {
    deploymentUrl = normalizeDeploymentUrl(env.CLOUDFLARE_DEPLOYMENT_URL);
  } catch (error) {
    errors.push(`CLOUDFLARE_DEPLOYMENT_URL: ${error.message}`);
  }

  if (apiOrigin && deploymentUrl && originOf(apiOrigin) === originOf(deploymentUrl)) {
    errors.push("API_ORIGIN must be the backend tunnel origin, not the same origin as CLOUDFLARE_DEPLOYMENT_URL.");
  }
  if (apiOrigin && isExampleComOrigin(apiOrigin)) {
    errors.push("API_ORIGIN must not use example.com template hosts.");
  }
  if (deploymentUrl && isExampleComOrigin(deploymentUrl)) {
    errors.push("CLOUDFLARE_DEPLOYMENT_URL must not use example.com template hosts.");
  }

  const allowedOrigins = originsFromWebOrigin(env.WEB_ORIGIN);
  const deploymentOrigin = originOf(deploymentUrl);
  if (!deploymentOrigin || !allowedOrigins.includes(deploymentOrigin)) {
    errors.push("WEB_ORIGIN must include the Cloudflare frontend deployment origin.");
  }
  if (allowedOrigins.includes("*")) {
    errors.push("WEB_ORIGIN must not include wildcard origins.");
  }
  if (allowedOrigins.some((origin) => isExampleComOrigin(origin))) {
    errors.push("WEB_ORIGIN must not use example.com template hosts.");
  }

  if (String(env.TRUST_PROXY || "0").trim() !== "1") {
    warnings.push("Set TRUST_PROXY=1 only after the API is reachable exclusively through Cloudflare Tunnel or another trusted proxy that rewrites forwarded headers.");
  }

  if (String(env.RUN_DB_SEED || "0").trim() === "1" && isPlaceholder(env.DEFAULT_ADMIN_PASSWORD)) {
    errors.push("RUN_DB_SEED=1 requires a real DEFAULT_ADMIN_PASSWORD.");
  }

  return {
    errors,
    ok: errors.length === 0,
    summary: {
      apiOriginConfigured: Boolean(apiOrigin),
      deploymentUrlConfigured: Boolean(deploymentUrl),
      tunnelTokenConfigured: !isPlaceholder(env.CLOUDFLARE_TUNNEL_TOKEN),
      webOriginCount: allowedOrigins.length
    },
    warnings
  };
}

export function parseCloudflareBackendArgs(argv = process.argv.slice(2)) {
  const options = {
    envPath: ".env.production",
    json: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--env") {
      options.envPath = argv[index + 1] || "";
      index += 1;
    } else {
      throw new Error(`Unknown cloudflare backend validation argument: ${arg}`);
    }
  }
  return options;
}

export function validateCloudflareBackendFile(envPath) {
  const absolutePath = resolve(envPath || ".env.production");
  if (!existsSync(absolutePath)) {
    return {
      errors: [`Cloudflare backend env file does not exist: ${envPath}`],
      ok: false,
      summary: {
        apiOriginConfigured: false,
        deploymentUrlConfigured: false,
        tunnelTokenConfigured: false,
        webOriginCount: 0
      },
      warnings: []
    };
  }
  const env = parseDotenvText(readFileSync(absolutePath, "utf8"));
  return validateCloudflareBackendEnv(env);
}

function printHumanReport(report) {
  report.errors.forEach((error) => console.error(`FAIL ${error}`));
  report.warnings.forEach((warning) => console.warn(`WARN ${warning}`));
  if (report.ok) console.log("Cloudflare backend env validation passed.");
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = parseCloudflareBackendArgs();
    const report = validateCloudflareBackendFile(options.envPath);
    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      printHumanReport(report);
    }
    process.exitCode = report.ok ? 0 : 1;
  } catch (error) {
    const report = {
      errors: [error?.message || "Cloudflare backend validation failed."],
      ok: false,
      summary: {
        apiOriginConfigured: false,
        deploymentUrlConfigured: false,
        tunnelTokenConfigured: false,
        webOriginCount: 0
      },
      warnings: []
    };
    if (process.argv.includes("--json")) console.log(JSON.stringify(report, null, 2));
    else console.error(report.errors[0]);
    process.exitCode = 1;
  }
}
