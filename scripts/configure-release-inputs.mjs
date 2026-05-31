import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ensureGithubEnvironment } from "./configure-backend-server.mjs";
import { validateCloudflareBackendEnv } from "./validate-cloudflare-backend.mjs";
import { dashboardSignoffCounts, sha256File as sha256HrSourceFile, validateHrDataSignoff } from "./validate-hr-signoff.mjs";
import { parseProductionEnvText, validateProductionEnv } from "./validate-production-env.mjs";
import { sha256Text, validateSecretsSignoff } from "./validate-secrets-signoff.mjs";
import { validateStorageSignoff } from "./validate-storage-signoff.mjs";

const defaultOutputDir = "reports/commercial-evidence/release-input-upload";
const defaultRepo = "17602842555/HR";
const releaseInputFiles = Object.freeze([
  Object.freeze({
    envName: "PRODUCTION_ENV_B64",
    kind: "dotenv",
    optionKey: "envPath"
  }),
  Object.freeze({
    envName: "PRODUCTION_SECRETS_SIGNOFF_B64",
    kind: "json",
    optionKey: "secretsSignoffPath"
  }),
  Object.freeze({
    envName: "HR_DATA_SIGNOFF_B64",
    kind: "json",
    optionKey: "hrSignoffPath"
  }),
  Object.freeze({
    envName: "FILE_STORAGE_SIGNOFF_B64",
    kind: "json",
    optionKey: "storageSignoffPath"
  })
]);

function nowIso(now = new Date()) {
  return now.toISOString();
}

function slugTimestamp(value) {
  return String(value || nowIso()).replaceAll(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function resolveFromRoot(rootDir, path) {
  if (!path) return rootDir;
  return isAbsolute(path) ? path : resolve(rootDir, path);
}

function relativeFromRoot(rootDir, path) {
  return relative(rootDir, path) || ".";
}

function ensurePrivateDir(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

function writePrivateJson(path, payload) {
  ensurePrivateDir(dirname(path));
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function redactMessage(value = "") {
  return String(value || "")
    .replaceAll(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replaceAll(/(password|secret|token|key)=\S+/gi, "$1=[REDACTED]")
    .replaceAll(/[A-Za-z0-9_./+=:-]{64,}/g, "[REDACTED]");
}

function summarizeReport(report = {}) {
  return {
    ok: Boolean(report.ok),
    errorCount: Array.isArray(report.errors) ? report.errors.length : 0,
    warningCount: Array.isArray(report.warnings) ? report.warnings.length : 0,
    errors: Array.isArray(report.errors) ? report.errors.map(redactMessage) : [],
    warnings: Array.isArray(report.warnings) ? report.warnings.map(redactMessage) : [],
    summary: report.summary || {}
  };
}

function readRequiredText(path, label) {
  if (!existsSync(path)) throw new Error(`${label} file does not exist: ${path}`);
  const text = readFileSync(path, "utf8");
  if (!text.trim()) throw new Error(`${label} file is empty: ${path}`);
  return text.endsWith("\n") ? text : `${text}\n`;
}

function readRequiredJson(path, label) {
  const text = readRequiredText(path, label);
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("top-level JSON must be an object");
    }
    return { parsed, text };
  } catch (error) {
    throw new Error(`${label} file is not valid JSON: ${error.message}`);
  }
}

function b64(text) {
  return Buffer.from(String(text || ""), "utf8").toString("base64");
}

function sha256ForText(text) {
  return sha256Text(text);
}

function normalizeReleaseBackendMode(value = "native-worker") {
  const mode = String(value || "native-worker").trim().toLowerCase();
  if (["native", "native-worker", "worker", "cloudflare-native"].includes(mode)) return "native-worker";
  if (["tunnel", "cloudflare-tunnel", "proxy", "fastify-postgres", "postgres"].includes(mode)) return "tunnel";
  throw new Error("Release input backend mode must be native-worker or tunnel.");
}

function readAndValidateInputs({
  backendMode = "native-worker",
  environment,
  envPath,
  hrSignoffPath,
  rootDir,
  secretsSignoffPath,
  sourcePath,
  storageSignoffPath
}) {
  const resolvedBackendMode = normalizeReleaseBackendMode(backendMode);
  const absoluteEnvPath = resolveFromRoot(rootDir, envPath);
  const absoluteSecretsPath = resolveFromRoot(rootDir, secretsSignoffPath);
  const absoluteHrPath = resolveFromRoot(rootDir, hrSignoffPath);
  const absoluteStoragePath = resolveFromRoot(rootDir, storageSignoffPath);
  const absoluteSourcePath = resolveFromRoot(rootDir, sourcePath);

  const envRequired = resolvedBackendMode !== "native-worker";
  const envText = existsSync(absoluteEnvPath)
    ? readRequiredText(absoluteEnvPath, "Production env")
    : "";
  if (envRequired && !envText) throw new Error(`Production env file does not exist: ${absoluteEnvPath}`);
  const env = envText ? parseProductionEnvText(envText) : {};
  const productionEnvReport = envText
    ? validateProductionEnv(env)
    : { ok: true, errors: [], warnings: [], summary: { skipped: true, mode: resolvedBackendMode } };
  const cloudflareBackendReport = envText
    ? validateCloudflareBackendEnv(env, { mode: resolvedBackendMode })
    : { ok: true, errors: [], warnings: [], summary: { skipped: true, mode: resolvedBackendMode } };

  const secrets = readRequiredJson(absoluteSecretsPath, "Production secrets signoff");
  const hr = readRequiredJson(absoluteHrPath, "HR data signoff");
  const storage = readRequiredJson(absoluteStoragePath, "File storage signoff");

  if (!existsSync(absoluteSourcePath)) throw new Error(`Dashboard source file does not exist: ${absoluteSourcePath}`);
  const secretsReport = validateSecretsSignoff(secrets.parsed, {
    env: envText ? env : null,
    envChecksum: envText ? sha256ForText(envText) : "",
    envPath: absoluteEnvPath,
    mode: resolvedBackendMode
  });
  const hrReport = validateHrDataSignoff(hr.parsed, {
    expectedCounts: dashboardSignoffCounts(absoluteSourcePath),
    expectedChecksum: sha256HrSourceFile(absoluteSourcePath),
    sourceName: basename(absoluteSourcePath)
  });
  const storageReport = validateStorageSignoff(storage.parsed, {
    expectedEnvironment: environment,
    expectedFileStorageDir: envText && env.FILE_STORAGE_DRIVER === "local" ? env.FILE_STORAGE_DIR : ""
  });

  const payloadInputs = [
    ...(envText ? [{
      envName: "PRODUCTION_ENV_B64",
      kind: "dotenv",
      path: absoluteEnvPath,
      text: envText
    }] : []),
    {
      envName: "PRODUCTION_SECRETS_SIGNOFF_B64",
      kind: "json",
      path: absoluteSecretsPath,
      text: secrets.text
    },
    {
      envName: "HR_DATA_SIGNOFF_B64",
      kind: "json",
      path: absoluteHrPath,
      text: hr.text
    },
    {
      envName: "FILE_STORAGE_SIGNOFF_B64",
      kind: "json",
      path: absoluteStoragePath,
      text: storage.text
    }
  ];
  const payloads = payloadInputs.map((item) => ({
    ...item,
    base64: b64(item.text),
    bytes: Buffer.byteLength(item.text),
    path: relativeFromRoot(rootDir, item.path),
    sha256: sha256ForText(item.text)
  }));

  const validation = {
    cloudflareBackend: summarizeReport(cloudflareBackendReport),
    hrSignoff: summarizeReport(hrReport),
    productionEnv: summarizeReport(productionEnvReport),
    secretsSignoff: summarizeReport(secretsReport),
    storageSignoff: summarizeReport(storageReport)
  };
  const ok = Object.values(validation).every((item) => item.ok);
  return { env, ok, payloads, validation };
}

export function uploadReleaseInputSecrets({
  environment = "production",
  payloads = [],
  repo = defaultRepo,
  runner = spawnSync
} = {}) {
  const uploads = [];
  const errors = [];
  for (const payload of payloads) {
    const result = runner("gh", ["secret", "set", payload.envName, "--repo", repo, "--env", environment], {
      encoding: "utf8",
      input: payload.base64,
      maxBuffer: 1024 * 1024
    });
    const item = {
      envName: payload.envName,
      ok: result.status === 0,
      scope: "environment",
      status: result.status ?? 1
    };
    if (result.status !== 0) {
      item.error = redactMessage(result.stderr || result.stdout || "gh secret set failed.");
      errors.push(`${payload.envName}: ${item.error}`);
    }
    uploads.push(item);
  }
  return {
    errors,
    ok: errors.length === 0,
    uploads
  };
}

function publicPayloadSummary(payloads) {
  return payloads.map(({ base64: _base64, text: _text, ...item }) => item);
}

export function configureReleaseInputs(options = {}) {
  const rootDir = resolve(options.rootDir || process.cwd());
  const now = options.now || new Date();
  const generatedAt = nowIso(now);
  const environment = String(options.environment || "production").trim() || "production";
  const backendMode = normalizeReleaseBackendMode(options.backendMode || "native-worker");
  const repo = String(options.repo || defaultRepo).trim() || defaultRepo;
  const outputDir = resolveFromRoot(rootDir, options.outputDir || defaultOutputDir);
  const runOutputPath = join(outputDir, `release-input-upload-${slugTimestamp(generatedAt)}.json`);
  const ensureReport = options.ensureGithubEnvironment
    ? ensureGithubEnvironment({ environment, repo, runner: options.runner || spawnSync })
    : { environment, errors: [], ok: false, repo, skipped: true };
  let inputReport = null;
  let uploadReport = { errors: [], ok: true, uploads: [] };
  let errors = [];
  if (options.ensureGithubEnvironment && !ensureReport.ok) {
    errors.push(...(ensureReport.errors || ["GitHub environment could not be prepared."]));
  }

  try {
    inputReport = readAndValidateInputs({
      backendMode,
      environment,
      envPath: options.envPath || ".env.production",
      hrSignoffPath: options.hrSignoffPath || "docs/hr-data-signoff.json",
      rootDir,
      secretsSignoffPath: options.secretsSignoffPath || "docs/production-secrets-signoff.json",
      sourcePath: options.sourcePath || "oa-dashboard.html",
      storageSignoffPath: options.storageSignoffPath || "docs/file-storage-signoff.json"
    });
    if (!inputReport.ok) {
      errors.push("Release input validation failed; no GitHub secrets were written.");
    }
    if (inputReport.ok && options.apply && (!options.ensureGithubEnvironment || ensureReport.ok)) {
      uploadReport = uploadReleaseInputSecrets({
        environment,
        payloads: inputReport.payloads,
        repo,
        runner: options.runner || spawnSync
      });
      errors.push(...uploadReport.errors);
    }
  } catch (error) {
    errors.push(redactMessage(error.message));
  }

  const manifest = {
    schemaVersion: 1,
    kind: "release-input-upload",
    generatedAt,
    apply: Boolean(options.apply),
    environment,
    backendMode,
    repo,
    noPlaintextSecretValues: true,
    githubEnvironment: {
      environment: ensureReport.environment,
      errorCount: Array.isArray(ensureReport.errors) ? ensureReport.errors.length : 0,
      ok: ensureReport.ok,
      skipped: Boolean(ensureReport.skipped)
    },
    inputs: inputReport ? publicPayloadSummary(inputReport.payloads) : [],
    validation: inputReport ? inputReport.validation : {},
    uploads: uploadReport.uploads,
    readyToUpload: Boolean(inputReport?.ok),
    ok: errors.length === 0 && Boolean(inputReport?.ok) && (!options.apply || uploadReport.ok),
    errors,
    releaseUse: "Uploader evidence only. Release acceptance still requires commercial-signoff, full commercial evidence, and release:gate."
  };

  ensurePrivateDir(outputDir);
  writePrivateJson(runOutputPath, manifest);
  writePrivateJson(join(outputDir, "latest-manifest.json"), manifest);
  return { manifest, outputPath: runOutputPath };
}

export function parseConfigureReleaseInputsArgs(argv = []) {
  const options = {
    apply: argv.includes("--apply"),
    backendMode: "native-worker",
    ensureGithubEnvironment: argv.includes("--ensure-github-environment"),
    environment: "production",
    envPath: ".env.production",
    hrSignoffPath: "docs/hr-data-signoff.json",
    json: argv.includes("--json"),
    outputDir: defaultOutputDir,
    repo: defaultRepo,
    secretsSignoffPath: "docs/production-secrets-signoff.json",
    sourcePath: "oa-dashboard.html",
    storageSignoffPath: "docs/file-storage-signoff.json"
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--apply" || arg === "--ensure-github-environment" || arg === "--json") {
      // Already handled by includes().
    } else if (arg === "--environment") {
      options.environment = argv[index + 1] || options.environment;
      index += 1;
    } else if (arg === "--mode") {
      options.backendMode = normalizeReleaseBackendMode(argv[index + 1] || "");
      index += 1;
    } else if (arg === "--env") {
      options.envPath = argv[index + 1] || options.envPath;
      index += 1;
    } else if (arg === "--hr-signoff") {
      options.hrSignoffPath = argv[index + 1] || options.hrSignoffPath;
      index += 1;
    } else if (arg === "--output") {
      options.outputDir = argv[index + 1] || options.outputDir;
      index += 1;
    } else if (arg === "--repo") {
      options.repo = argv[index + 1] || options.repo;
      index += 1;
    } else if (arg === "--secrets-signoff") {
      options.secretsSignoffPath = argv[index + 1] || options.secretsSignoffPath;
      index += 1;
    } else if (arg === "--source") {
      options.sourcePath = argv[index + 1] || options.sourcePath;
      index += 1;
    } else if (arg === "--storage-signoff") {
      options.storageSignoffPath = argv[index + 1] || options.storageSignoffPath;
      index += 1;
    } else {
      throw new Error(`Unknown release input configuration argument: ${arg}`);
    }
  }
  return options;
}

async function main(argv = process.argv.slice(2)) {
  const options = parseConfigureReleaseInputsArgs(argv);
  try {
    const result = configureReleaseInputs(options);
    const payload = {
      ok: result.manifest.ok,
      apply: result.manifest.apply,
      readyToUpload: result.manifest.readyToUpload,
      outputPath: result.outputPath,
      inputs: result.manifest.inputs,
      uploads: result.manifest.uploads,
      errors: result.manifest.errors
    };
    if (options.json) {
      console.log(JSON.stringify(payload, null, 2));
    } else if (result.manifest.ok) {
      console.log(options.apply ? "Release input secrets uploaded." : "Release input files are validated and ready to upload.");
      console.log(`Manifest: ${result.outputPath}`);
    } else {
      console.error("Release input configuration failed.");
      result.manifest.errors.forEach((error) => console.error(`- ${error}`));
      console.error(`Manifest: ${result.outputPath}`);
    }
    process.exitCode = result.manifest.ok ? 0 : 1;
  } catch (error) {
    if (options.json) console.log(JSON.stringify({ ok: false, errors: [redactMessage(error.message)] }, null, 2));
    else console.error(redactMessage(error.message));
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main();
}

export { releaseInputFiles };
