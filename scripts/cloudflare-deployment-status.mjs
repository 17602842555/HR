import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { runCloudflareSmoke } from "./cloudflare-smoke.mjs";

export const requiredCloudflareGithubSecrets = Object.freeze([
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_ACCOUNT_ID",
  "API_ORIGIN",
  "CLOUDFLARE_DEPLOYMENT_URL",
  "CLOUDFLARE_TUNNEL_TOKEN",
  "CLOUDFLARE_BACKEND_WEB_ORIGIN"
]);

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

function sanitizeMessage(value = "") {
  return String(value || "")
    .replaceAll(/(token|secret|password|key)=\S+/gi, "$1=[REDACTED]")
    .replaceAll(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .slice(0, 300);
}

export function parseCloudflareDeploymentStatusArgs(argv = process.argv.slice(2), env = process.env) {
  const options = {
    allowMissingApiOrigin: boolFlag(env.CLOUDFLARE_STATUS_ALLOW_MISSING_API_ORIGIN),
    json: boolFlag(env.CLOUDFLARE_STATUS_JSON),
    repo: env.GITHUB_REPOSITORY || "",
    retries: parsePositiveInt(env.CLOUDFLARE_SMOKE_RETRIES, 2),
    retryDelayMs: parsePositiveInt(env.CLOUDFLARE_SMOKE_RETRY_DELAY_MS, 1000),
    timeoutMs: parsePositiveInt(env.CLOUDFLARE_SMOKE_TIMEOUT_MS, 8000),
    tunnel: env.CLOUDFLARE_TUNNEL_ID || env.CLOUDFLARE_TUNNEL_NAME || "",
    url: env.CLOUDFLARE_DEPLOYMENT_URL || ""
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--allow-missing-api-origin") {
      options.allowMissingApiOrigin = true;
    } else if (arg === "--repo") {
      options.repo = argv[index + 1] || "";
      index += 1;
    } else if (arg === "--tunnel") {
      options.tunnel = argv[index + 1] || "";
      index += 1;
    } else if (arg === "--url") {
      options.url = argv[index + 1] || "";
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

export function buildCloudflareDeploymentStatus({
  requiredSecrets = requiredCloudflareGithubSecrets,
  secretNames = null,
  secretRead = null,
  smokeReport = null,
  tunnelRead = null
} = {}) {
  const checks = [];
  const warnings = [];

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
    const missing = requiredSecrets.filter((name) => !present.has(name));
    checks.push(status(
      missing.length === 0 ? "pass" : "fail",
      "github-secrets",
      missing.length === 0
        ? "All required Cloudflare GitHub repository secrets are present."
        : "Cloudflare GitHub repository secrets are incomplete.",
      {
        missing,
        presentCount: requiredSecrets.length - missing.length,
        requiredCount: requiredSecrets.length
      }
    ));
  }

  if (!tunnelRead?.checked) {
    checks.push(status("fail", "tunnel-status", "Cloudflare Tunnel status could not be inspected.", {
      error: sanitizeMessage(tunnelRead?.error || "Cloudflare Tunnel was not inspected.")
    }));
  } else {
    const tunnelStatus = String(tunnelRead.tunnel?.status || "").toLowerCase();
    checks.push(status(
      tunnelStatus === "active" ? "pass" : "fail",
      "tunnel-status",
      tunnelStatus === "active"
        ? "Cloudflare Tunnel is active."
        : "Cloudflare Tunnel is not active.",
      {
        id: tunnelRead.tunnel?.id || "",
        name: tunnelRead.tunnel?.name || "",
        status: tunnelRead.tunnel?.status || ""
      }
    ));
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

  const hardBlockers = checks.filter((check) => check.level === "fail");
  return {
    checks,
    hardBlockers,
    ok: hardBlockers.length === 0,
    requiredGithubSecrets: requiredSecrets,
    service: "cloudflare-deployment-status",
    summary: {
      cloudflareSmokeReady: Boolean(smokeReport?.ok),
      githubSecretsReady: checks.find((check) => check.name === "github-secrets")?.level === "pass",
      tunnelReady: checks.find((check) => check.name === "tunnel-status")?.level === "pass"
    },
    warnings
  };
}

export async function runCloudflareDeploymentStatus({
  allowMissingApiOrigin = false,
  fetchImpl = globalThis.fetch,
  repo,
  retries,
  retryDelayMs,
  runner = spawnSync,
  timeoutMs,
  tunnel,
  url
} = {}) {
  const secretRead = readGithubSecretNames({ repo, runner });
  const tunnelRead = readCloudflareTunnelInfo({ runner, tunnel });
  let smokeReport = null;
  if (String(url || "").trim()) {
    smokeReport = await runCloudflareSmoke({
      fetchImpl,
      requireApiOrigin: !allowMissingApiOrigin,
      retries,
      retryDelayMs,
      timeoutMs,
      url
    });
  }
  return buildCloudflareDeploymentStatus({ secretRead, smokeReport, tunnelRead });
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
