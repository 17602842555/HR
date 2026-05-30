import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseDotenvText } from "./commercial-doctor-core.mjs";
import { validateCloudflareBackendEnv } from "./validate-cloudflare-backend.mjs";

const secretSpecs = Object.freeze([
  Object.freeze({ name: "CLOUDFLARE_API_TOKEN", sourceKey: "CLOUDFLARE_API_TOKEN" }),
  Object.freeze({ name: "CLOUDFLARE_ACCOUNT_ID", sourceKey: "CLOUDFLARE_ACCOUNT_ID" }),
  Object.freeze({ name: "API_ORIGIN", sourceKey: "API_ORIGIN" }),
  Object.freeze({ name: "CLOUDFLARE_DEPLOYMENT_URL", sourceKey: "CLOUDFLARE_DEPLOYMENT_URL" }),
  Object.freeze({ name: "CLOUDFLARE_TUNNEL_TOKEN", sourceKey: "CLOUDFLARE_TUNNEL_TOKEN" }),
  Object.freeze({ name: "CLOUDFLARE_BACKEND_WEB_ORIGIN", sourceKey: "CLOUDFLARE_BACKEND_WEB_ORIGIN" })
]);

const runtimeOverrideKeys = Object.freeze([
  "API_ORIGIN",
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_BACKEND_WEB_ORIGIN",
  "CLOUDFLARE_DEPLOYMENT_URL",
  "CLOUDFLARE_TUNNEL_TOKEN",
  "DEFAULT_ADMIN_PASSWORD",
  "RUN_DB_SEED",
  "TRUST_PROXY",
  "WEB_ORIGIN"
]);

const cloudflareTokenVerifyUrl = "https://api.cloudflare.com/client/v4/user/tokens/verify";

const placeholderFragments = Object.freeze([
  "admin123456",
  "changeme",
  "change-me",
  "change_before",
  "dev-only-change-me",
  "example",
  "local-commercial-demo-secret",
  "oa_dev_password",
  "placeholder",
  "replace-with",
  "todo"
]);

function isPresent(value) {
  return Boolean(String(value || "").trim());
}

function isPlaceholder(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return !normalized
    || placeholderFragments.some((fragment) => normalized.includes(fragment))
    || normalized.includes("<")
    || normalized.includes("example.com");
}

function sanitizeCloudflareMessage(value = "") {
  return String(value || "")
    .replaceAll(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replaceAll(/(token|secret|password|key)=\S+/gi, "$1=[REDACTED]")
    .slice(0, 240);
}

function publicOrigin(value) {
  try {
    return new URL(value).origin;
  } catch {
    return "";
  }
}

function valueSource(key, fileEnv, runtimeEnv, computedKeys = new Set()) {
  if (isPresent(runtimeEnv[key])) return "process.env";
  if (isPresent(fileEnv[key])) return "env-file";
  if (computedKeys.has(key)) return "computed";
  return "missing";
}

function mergeCloudflareEnv(fileEnv = {}, runtimeEnv = {}) {
  const merged = { ...fileEnv };
  runtimeOverrideKeys.forEach((key) => {
    if (isPresent(runtimeEnv[key])) merged[key] = runtimeEnv[key];
  });
  return merged;
}

export function parseCloudflareSecretArgs(argv = process.argv.slice(2)) {
  const options = {
    apply: false,
    envPath: ".env.production",
    json: false,
    repo: "",
    verifyToken: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--apply") {
      options.apply = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--verify-token") {
      options.verifyToken = true;
    } else if (arg === "--env") {
      options.envPath = argv[index + 1] || "";
      index += 1;
    } else if (arg === "--repo") {
      options.repo = argv[index + 1] || "";
      index += 1;
    } else {
      throw new Error(`Unknown cloudflare secret configuration argument: ${arg}`);
    }
  }
  return options;
}

export async function verifyCloudflareApiToken({
  fetchImpl = globalThis.fetch,
  timeoutMs = 8000,
  token
} = {}) {
  const value = String(token || "").trim();
  if (isPlaceholder(value) || value.length < 20) {
    return {
      checked: false,
      errors: ["CLOUDFLARE_API_TOKEN is missing, placeholder, or too short for online verification."],
      ok: false,
      status: "invalid-input"
    };
  }
  if (typeof fetchImpl !== "function") {
    return {
      checked: false,
      errors: ["Fetch API is not available for Cloudflare token verification."],
      ok: false,
      status: "unavailable"
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(cloudflareTokenVerifyUrl, {
      headers: {
        Authorization: `Bearer ${value}`,
        Accept: "application/json"
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
    const apiErrors = Array.isArray(payload?.errors)
      ? payload.errors.map((error) => sanitizeCloudflareMessage(error?.message || "Cloudflare API token verification failed."))
      : [];
    const status = String(payload?.result?.status || (response.ok ? "unknown" : `http-${response.status}`)).slice(0, 40);
    const ok = response.ok && payload?.success === true && status === "active";
    return {
      checked: true,
      errors: ok ? [] : apiErrors.length ? apiErrors : [`Cloudflare API token verification returned ${status}.`],
      ok,
      status,
      tokenIdPresent: Boolean(payload?.result?.id)
    };
  } catch (error) {
    return {
      checked: true,
      errors: [sanitizeCloudflareMessage(error?.message || "Cloudflare API token verification request failed.")],
      ok: false,
      status: "request-failed"
    };
  } finally {
    clearTimeout(timeout);
  }
}

export function repoFromGitRemote(remoteUrl = "") {
  const value = String(remoteUrl || "").trim();
  const httpsMatch = value.match(/^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i);
  if (httpsMatch) return `${httpsMatch[1]}/${httpsMatch[2]}`;
  const sshMatch = value.match(/^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i);
  if (sshMatch) return `${sshMatch[1]}/${sshMatch[2]}`;
  return "";
}

export function loadCloudflareSecretEnv(envPath = ".env.production", fsOps = { existsSync, readFileSync }) {
  if (!envPath || !fsOps.existsSync(envPath)) {
    return {
      env: {},
      warnings: [`Cloudflare secret env file was not found: ${envPath || ".env.production"}`]
    };
  }
  return {
    env: parseDotenvText(fsOps.readFileSync(envPath, "utf8")),
    warnings: []
  };
}

export function buildCloudflareSecretPlan({
  fileEnv = {},
  gitRemoteUrl = "",
  repo = "",
  runtimeEnv = {}
} = {}) {
  const errors = [];
  const warnings = [];
  const computedKeys = new Set();
  const merged = mergeCloudflareEnv(fileEnv, runtimeEnv);
  const repoName = String(repo || repoFromGitRemote(gitRemoteUrl) || "").trim();

  if (!repoName || !/^[^/\s]+\/[^/\s]+$/.test(repoName)) {
    errors.push("GitHub repo must be provided as owner/name with --repo or resolvable from origin remote.");
  }

  if (!isPresent(merged.CLOUDFLARE_BACKEND_WEB_ORIGIN)) {
    const deploymentOrigin = publicOrigin(merged.CLOUDFLARE_DEPLOYMENT_URL);
    if (deploymentOrigin) {
      merged.CLOUDFLARE_BACKEND_WEB_ORIGIN = deploymentOrigin;
      computedKeys.add("CLOUDFLARE_BACKEND_WEB_ORIGIN");
    }
  }

  const backendEnv = {
    ...merged,
    WEB_ORIGIN: merged.WEB_ORIGIN || merged.CLOUDFLARE_BACKEND_WEB_ORIGIN || merged.CLOUDFLARE_DEPLOYMENT_URL
  };
  const backendReport = validateCloudflareBackendEnv(backendEnv);
  backendReport.errors.forEach((error) => errors.push(error));
  backendReport.warnings.forEach((warning) => warnings.push(warning));

  if (isPlaceholder(merged.CLOUDFLARE_API_TOKEN) || String(merged.CLOUDFLARE_API_TOKEN || "").trim().length < 20) {
    errors.push("CLOUDFLARE_API_TOKEN must be a real Cloudflare API token with Workers deploy permission.");
  }

  if (!/^[a-f0-9]{32}$/i.test(String(merged.CLOUDFLARE_ACCOUNT_ID || "").trim())) {
    errors.push("CLOUDFLARE_ACCOUNT_ID must be the 32-character Cloudflare account id.");
  }

  const secretValues = new Map();
  const secrets = secretSpecs.map((spec) => {
    const value = String(merged[spec.sourceKey] || "").trim();
    if (value) secretValues.set(spec.name, value);
    return {
      configured: Boolean(value),
      name: spec.name,
      scope: "repository",
      source: valueSource(spec.sourceKey, fileEnv, runtimeEnv, computedKeys)
    };
  });

  secrets
    .filter((item) => !item.configured)
    .forEach((item) => errors.push(`${item.name} is required for the Cloudflare deployment workflow.`));

  const plan = {
    ok: errors.length === 0,
    repo: repoName || null,
    backend: backendReport.summary,
    errors,
    secrets,
    warnings
  };
  Object.defineProperty(plan, "secretValues", {
    enumerable: false,
    value: secretValues
  });
  return plan;
}

export function applyCloudflareSecretPlan(plan, { runner = spawnSync } = {}) {
  if (!plan?.ok) {
    return {
      applied: [],
      errors: ["Cloudflare secret plan is not valid; refusing to write GitHub secrets."],
      ok: false
    };
  }

  const applied = [];
  const errors = [];
  for (const secret of plan.secrets) {
    const value = plan.secretValues.get(secret.name);
    const result = runner("gh", ["secret", "set", secret.name, "--repo", plan.repo], {
      encoding: "utf8",
      input: value
    });
    if (result?.error) {
      errors.push(`${secret.name}: ${result.error.message}`);
      continue;
    }
    if (Number(result?.status || 0) !== 0) {
      errors.push(`${secret.name}: ${String(result?.stderr || result?.stdout || "gh secret set failed").trim()}`);
      continue;
    }
    applied.push(secret.name);
  }

  return {
    applied,
    errors,
    ok: errors.length === 0
  };
}

function readGitRemote(runner = spawnSync) {
  const result = runner("git", ["remote", "get-url", "origin"], { encoding: "utf8" });
  if (Number(result?.status || 0) !== 0) return "";
  return String(result.stdout || "").trim();
}

function printHumanReport(plan, applyResult) {
  if (plan.ok) {
    console.log(`Cloudflare GitHub secret plan is valid for ${plan.repo}.`);
  } else {
    console.error("Cloudflare GitHub secret plan is not valid.");
  }
  plan.secrets.forEach((secret) => {
    const marker = secret.configured ? "ready" : "missing";
    console.log(`${marker} ${secret.name} (${secret.source})`);
  });
  plan.warnings.forEach((warning) => console.warn(`WARN ${warning}`));
  plan.errors.forEach((error) => console.error(`FAIL ${error}`));
  if (plan.tokenVerification) {
    const marker = plan.tokenVerification.ok ? "PASS" : "FAIL";
    console.log(`${marker} cloudflare-token-verify: status=${plan.tokenVerification.status}`);
    plan.tokenVerification.errors?.forEach((error) => console.error(`FAIL ${error}`));
  }
  if (applyResult) {
    applyResult.applied.forEach((name) => console.log(`applied ${name}`));
    applyResult.errors.forEach((error) => console.error(`FAIL ${error}`));
  } else if (plan.ok) {
    console.log("Dry run only. Re-run with --apply to write GitHub repository secrets.");
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  let options;
  try {
    options = parseCloudflareSecretArgs();
    const loaded = loadCloudflareSecretEnv(options.envPath);
    const gitRemoteUrl = options.repo ? "" : readGitRemote();
    const plan = buildCloudflareSecretPlan({
      fileEnv: loaded.env,
      gitRemoteUrl,
      repo: options.repo,
      runtimeEnv: process.env
    });
    loaded.warnings.forEach((warning) => plan.warnings.push(warning));
    if (options.verifyToken) {
      plan.tokenVerification = await verifyCloudflareApiToken({
        token: plan.secretValues.get("CLOUDFLARE_API_TOKEN")
      });
      if (!plan.tokenVerification.ok) {
        plan.errors.push("Cloudflare API token online verification failed.");
        plan.ok = false;
      }
    }
    const applyResult = options.apply ? applyCloudflareSecretPlan(plan) : null;
    const report = {
      ...plan,
      apply: options.apply ? applyResult : null
    };
    if (options.json) console.log(JSON.stringify(report, null, 2));
    else printHumanReport(plan, applyResult);
    process.exitCode = plan.ok && (!applyResult || applyResult.ok) ? 0 : 1;
  } catch (error) {
    const report = {
      ok: false,
      errors: [error?.message || "Cloudflare secret configuration failed."],
      warnings: []
    };
    if (options?.json || process.argv.includes("--json")) console.log(JSON.stringify(report, null, 2));
    else console.error(report.errors[0]);
    process.exitCode = 1;
  }
}
