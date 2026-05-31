import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";
import { parseProductionEnvText, validateProductionEnv } from "./validate-production-env.mjs";

export const requiredApprovalRoles = Object.freeze(["Security owner", "Deployment owner"]);
export const requiredNativeManagedSecrets = Object.freeze([
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_BOOTSTRAP_ADMIN_PASSWORD"
]);
export const requiredTunnelManagedSecrets = Object.freeze([
  "POSTGRES_PASSWORD",
  "JWT_SECRET",
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_TUNNEL_TOKEN"
]);
export const requiredManagedSecrets = Object.freeze([
  "POSTGRES_PASSWORD",
  "JWT_SECRET",
  "CLOUDFLARE_API_TOKEN"
]);

const placeholderFragments = Object.freeze([
  "example",
  "placeholder",
  "replace",
  "todo",
  "待填写",
  "示例"
]);

function isBlank(value) {
  return String(value ?? "").trim() === "";
}

function hasPlaceholder(value) {
  const text = String(value ?? "").trim().toLowerCase();
  return !text || placeholderFragments.some((fragment) => text.includes(fragment.toLowerCase()));
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeChecksum(value) {
  return String(value || "").trim().replace(/^sha256:/i, "").toLowerCase();
}

function isIsoDateTime(value) {
  if (typeof value !== "string" || !value.trim()) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && /\d{4}-\d{2}-\d{2}T/.test(value);
}

function isAfter(left, right) {
  if (!isIsoDateTime(left) || !isIsoDateTime(right)) return false;
  return new Date(left).getTime() > new Date(right).getTime();
}

function sorted(values) {
  return [...values].sort((a, b) => String(a).localeCompare(String(b)));
}

function sameStringSet(left, right) {
  const a = sorted(list(left).map(String));
  const b = sorted(list(right).map(String));
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

export function normalizeSecretsBackendMode(value) {
  const mode = String(value || "native-worker").trim().toLowerCase();
  if (["native", "native-worker", "worker", "cloudflare-native"].includes(mode)) return "native-worker";
  if (["tunnel", "cloudflare-tunnel", "proxy"].includes(mode)) return "tunnel";
  throw new Error("secrets signoff backend mode must be native-worker or tunnel.");
}

export function managedSecretsForMode(mode = "native-worker") {
  return normalizeSecretsBackendMode(mode) === "tunnel"
    ? [...requiredTunnelManagedSecrets]
    : [...requiredNativeManagedSecrets];
}

export function sha256Text(text) {
  return createHash("sha256").update(String(text || "")).digest("hex");
}

export function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function findPlaintextSecretFields(value, path = []) {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => findPlaintextSecretFields(item, [...path, String(index)]));
  }

  const findings = [];
  Object.entries(value).forEach(([key, child]) => {
    const normalized = key.toLowerCase().replaceAll(/[^a-z0-9]+/g, "");
    if ([
      "secretvalues",
      "plaintextsecrets",
      "postgrespassword",
      "jwtsecret",
      "defaultadminpassword",
      "cloudflareapitoken",
      "cloudflarebootstrapadminpassword",
      "cloudflaretunneltoken",
      "apitoken",
      "tokenvalue",
      "passwordvalue"
    ].includes(normalized)) {
      findings.push([...path, key].join("."));
    }
    findings.push(...findPlaintextSecretFields(child, [...path, key]));
  });
  return findings;
}

export function validateSecretsSignoff(signoff, {
  allowExample = false,
  env = null,
  envChecksum = "",
  envPath = ".env.production",
  mode = ""
} = {}) {
  const errors = [];
  const warnings = [];
  const environmentFile = signoff?.environmentFile || {};
  const secretStore = signoff?.secretStore || {};
  const originPolicy = signoff?.originPolicy || {};
  const bootstrapSeedPolicy = signoff?.bootstrapSeedPolicy || {};
  const approvals = list(signoff?.approvals);
  const exceptions = list(signoff?.openExceptions);
  const permitPlaceholders = allowExample && signoff?.example === true;
  const envResult = env ? validateProductionEnv(env) : null;
  const envSummary = envResult?.summary || {};
  const explicitMode = mode || signoff?.backendMode || signoff?.deployment?.mode || env?.CLOUDFLARE_BACKEND_MODE || env?.OA_API_MODE || "";
  let backendMode = "native-worker";
  try {
    backendMode = normalizeSecretsBackendMode(explicitMode);
  } catch (error) {
    errors.push(error.message);
  }
  const requiredSecrets = managedSecretsForMode(backendMode);
  const nativeWorkerWithoutProductionEnv = backendMode === "native-worker" && !env && !isBlank(explicitMode);

  if (!signoff || typeof signoff !== "object" || Array.isArray(signoff)) {
    return { ok: false, errors: ["Secrets signoff payload must be a JSON object."], warnings, summary: {} };
  }

  if (signoff.schemaVersion !== 1) errors.push("schemaVersion must be 1.");
  if (signoff.example === true && !allowExample) errors.push("Example secrets signoff files cannot be used as release evidence.");
  if (!permitPlaceholders && hasPlaceholder(signoff.documentId)) errors.push("documentId must be a real non-placeholder identifier.");
  if (!["staging", "production"].includes(String(signoff.environment || ""))) {
    errors.push("environment must be staging or production.");
  }
  if (!isIsoDateTime(signoff.signedAt)) errors.push("signedAt must be an ISO datetime.");

  const plaintextFindings = findPlaintextSecretFields(signoff);
  if (plaintextFindings.length > 0) {
    errors.push(`signoff must not contain plaintext secret fields: ${plaintextFindings.join(", ")}.`);
  }

  if (!env && !permitPlaceholders && !nativeWorkerWithoutProductionEnv) {
    errors.push("A real production env file must be provided for secrets signoff validation.");
  }
  if (envResult && !envResult.ok) {
    errors.push(...envResult.errors.map((error) => `production env validation failed: ${error}`));
  }

  const signedEnvChecksum = normalizeChecksum(environmentFile.sha256);
  const actualEnvChecksum = normalizeChecksum(envChecksum);
  if (!nativeWorkerWithoutProductionEnv) {
    if (!/^[a-f0-9]{64}$/.test(signedEnvChecksum)) {
      errors.push("environmentFile.sha256 must be a SHA-256 hex digest.");
    } else if (actualEnvChecksum && signedEnvChecksum !== actualEnvChecksum) {
      errors.push("environmentFile.sha256 does not match the production env file.");
    }
    if (!permitPlaceholders && hasPlaceholder(environmentFile.path)) {
      errors.push("environmentFile.path must be reviewed and non-placeholder.");
    }
    if (envPath && environmentFile.path && basename(environmentFile.path) !== basename(envPath)) {
      errors.push("environmentFile.path must identify the validated production env file.");
    }
    if (!String(environmentFile.validatedWith || "").includes("validate:production-env")) {
      errors.push("environmentFile.validatedWith must reference npm run validate:production-env.");
    }
  } else if (environmentFile.required === true) {
    errors.push("environmentFile.required must not be true when native-worker signoff intentionally has no .env.production.");
  }

  ["provider", "namespace", "rotationOwner", "rotationRunbook", "emergencyRollback"].forEach((key) => {
    if (!permitPlaceholders && hasPlaceholder(secretStore[key])) errors.push(`secretStore.${key} must be reviewed and non-placeholder.`);
  });
  if (secretStore.injectedAtRuntime !== true) errors.push("secretStore.injectedAtRuntime must be true.");
  if (secretStore.noPlaintextInRepo !== true) errors.push("secretStore.noPlaintextInRepo must be true.");
  if (secretStore.accessRestricted !== true) errors.push("secretStore.accessRestricted must be true.");
  if (!isIsoDateTime(secretStore.lastRotatedAt)) errors.push("secretStore.lastRotatedAt must be an ISO datetime.");
  if (!isIsoDateTime(secretStore.nextRotationDueAt)) errors.push("secretStore.nextRotationDueAt must be an ISO datetime.");
  if (isIsoDateTime(secretStore.lastRotatedAt) && isIsoDateTime(secretStore.nextRotationDueAt)
    && !isAfter(secretStore.nextRotationDueAt, secretStore.lastRotatedAt)) {
    errors.push("secretStore.nextRotationDueAt must be after lastRotatedAt.");
  }
  const managedSecrets = list(secretStore.managedSecrets);
  requiredSecrets.forEach((secretName) => {
    if (!managedSecrets.includes(secretName)) errors.push(`secretStore.managedSecrets must include ${secretName}.`);
  });
  if (backendMode === "native-worker" && managedSecrets.includes("CLOUDFLARE_TUNNEL_TOKEN")) {
    warnings.push("CLOUDFLARE_TUNNEL_TOKEN is not required for native-worker mode; keep it only for a future Tunnel deployment.");
  }
  if (env && envResult?.summary?.runDbSeed && !managedSecrets.includes("DEFAULT_ADMIN_PASSWORD")) {
    errors.push("secretStore.managedSecrets must include DEFAULT_ADMIN_PASSWORD when RUN_DB_SEED=1.");
  }

  if (originPolicy.httpsOnly !== true) errors.push("originPolicy.httpsOnly must be true.");
  if (originPolicy.noWildcard !== true) errors.push("originPolicy.noWildcard must be true.");
  if (!permitPlaceholders && hasPlaceholder(originPolicy.owner)) errors.push("originPolicy.owner must be reviewed and non-placeholder.");
  const approvedOrigins = list(originPolicy.approvedOrigins);
  if (approvedOrigins.length === 0) errors.push("originPolicy.approvedOrigins must list at least one origin.");
  if (env && !sameStringSet(approvedOrigins, envSummary.origins || [])) {
    errors.push("originPolicy.approvedOrigins must match WEB_ORIGIN from the production env file.");
  }
  approvedOrigins.forEach((origin) => {
    try {
      const parsed = new URL(origin);
      if (parsed.protocol !== "https:") errors.push(`originPolicy.approvedOrigins must use https: ${origin}`);
      if (origin.includes("*")) errors.push("originPolicy.approvedOrigins must not contain wildcards.");
    } catch {
      errors.push(`originPolicy.approvedOrigins contains an invalid URL: ${origin}`);
    }
  });

  if (typeof bootstrapSeedPolicy.runDbSeed !== "boolean") errors.push("bootstrapSeedPolicy.runDbSeed must be boolean.");
  if (env && Boolean(bootstrapSeedPolicy.runDbSeed) !== Boolean(envSummary.runDbSeed)) {
    errors.push("bootstrapSeedPolicy.runDbSeed must match RUN_DB_SEED from the production env file.");
  }
  if (nativeWorkerWithoutProductionEnv && bootstrapSeedPolicy.runDbSeed === true) {
    errors.push("bootstrapSeedPolicy.runDbSeed must be false when native-worker signoff has no Fastify production env.");
  }
  if (bootstrapSeedPolicy.runDbSeed === true && bootstrapSeedPolicy.defaultAdminPasswordManaged !== true) {
    errors.push("bootstrapSeedPolicy.defaultAdminPasswordManaged must be true when runDbSeed is true.");
  }
  if (!permitPlaceholders && hasPlaceholder(bootstrapSeedPolicy.approvalReference)) {
    errors.push("bootstrapSeedPolicy.approvalReference must be reviewed and non-placeholder.");
  }

  requiredApprovalRoles.forEach((role) => {
    const approval = approvals.find((item) => item.role === role && item.decision === "approved");
    if (!approval) {
      errors.push(`approvals must include an approved ${role}.`);
      return;
    }
    if (!permitPlaceholders && (hasPlaceholder(approval.name) || hasPlaceholder(approval.email))) {
      errors.push(`${role} approval must include a real name and email.`);
    }
    if (!isIsoDateTime(approval.approvedAt)) errors.push(`${role} approval must include an ISO approvedAt.`);
  });

  if (signoff.environment === "production" && exceptions.length > 0) {
    errors.push("production secrets signoff must not contain openExceptions.");
  }
  exceptions.forEach((item, index) => {
    if (!permitPlaceholders && (hasPlaceholder(item.owner) || hasPlaceholder(item.exitCriteria))) {
      errors.push(`openExceptions[${index}] must include owner and exitCriteria.`);
    }
  });

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    summary: {
      documentId: signoff.documentId || null,
      environment: signoff.environment || null,
      envPath: environmentFile.path || null,
      secretProvider: secretStore.provider || null,
      managedSecrets,
      approvedOrigins,
      backendMode,
      runDbSeed: bootstrapSeedPolicy.runDbSeed ?? null,
      requiredManagedSecrets: requiredSecrets,
      approvalRoles: approvals.map((item) => item.role).filter(Boolean),
      openExceptionCount: exceptions.length,
      productionEnvValidated: Boolean(envResult?.ok)
    }
  };
}

export function loadSecretsSignoff(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function resolvePath(path) {
  return isAbsolute(path) ? path : resolve(process.cwd(), path);
}

export function parseSecretsSignoffArgs(argv = []) {
  const options = {
    signoffPath: "docs/production-secrets-signoff.json",
    envPath: ".env.production",
    json: argv.includes("--json"),
    allowExample: argv.includes("--allow-example"),
    mode: ""
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--env") {
      options.envPath = argv[index + 1] || options.envPath;
      index += 1;
    } else if (arg === "--mode") {
      options.mode = normalizeSecretsBackendMode(argv[index + 1] || "");
      index += 1;
    } else if (!arg.startsWith("--")) {
      options.signoffPath = arg;
    }
  }
  return options;
}

async function main(argv = process.argv.slice(2)) {
  const options = parseSecretsSignoffArgs(argv);
  const signoffPath = resolvePath(options.signoffPath);
  const envPath = resolvePath(options.envPath);

  try {
    if (!existsSync(signoffPath)) throw new Error(`Secrets signoff file does not exist: ${signoffPath}`);
    const envText = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
    if (!envText && !(options.allowExample && loadSecretsSignoff(signoffPath)?.example === true)) {
      throw new Error(`Production env file does not exist: ${envPath}`);
    }
    const result = validateSecretsSignoff(loadSecretsSignoff(signoffPath), {
      allowExample: options.allowExample,
      env: envText ? parseProductionEnvText(envText) : null,
      envChecksum: envText ? sha256Text(envText) : "",
      envPath,
      mode: options.mode
    });
    const payload = { path: signoffPath, envPath, ...result };
    if (options.json) {
      console.log(JSON.stringify(payload, null, 2));
    } else if (result.ok) {
      console.log(`Secrets signoff validation passed: ${signoffPath}`);
      result.warnings.forEach((warning) => console.warn(`Warning: ${warning}`));
    } else {
      console.error(`Secrets signoff validation failed: ${signoffPath}`);
      result.errors.forEach((error) => console.error(`- ${error}`));
      result.warnings.forEach((warning) => console.warn(`Warning: ${warning}`));
    }
    process.exitCode = result.ok ? 0 : 1;
  } catch (error) {
    if (options.json) {
      console.log(JSON.stringify({ ok: false, errors: [error.message], warnings: [] }, null, 2));
    } else {
      console.error(error.message);
    }
    process.exitCode = 1;
  }
}

if (import.meta.url === new URL(process.argv[1], "file:").href) {
  main();
}
