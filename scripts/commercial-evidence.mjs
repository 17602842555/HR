import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseDotenvText } from "./commercial-doctor-core.mjs";

const defaultOutputDir = "reports/commercial-evidence";
const defaultEvidencePath = "reports/commercial-evidence/latest.json";
const defaultCommandMaxBufferBytes = 32 * 1024 * 1024;

export const commercialEvidenceChecks = Object.freeze([
  { id: "preflight", command: "node", args: ["scripts/commercial-preflight.mjs"], required: true },
  { id: "migrations", command: "npm", args: ["run", "validate:migrations", "--", "--json"], required: true, parseJson: true },
  { id: "supply-chain", command: "npm", args: ["run", "validate:supply-chain", "--", "--json"], required: true, parseJson: true },
  { id: "sbom", command: "npm", args: ["run", "sbom:generate", "--", "--json"], required: true, parseJson: true },
  { id: "brand", command: "node", args: ["scripts/brand-check.mjs"], required: true },
  { id: "contract", command: "node", args: ["scripts/export-openapi.mjs", "--check"], required: true },
  { id: "hr-review-prep", command: "npm", args: ["run", "prepare:hr-review", "--", "--json"], required: true, parseJson: true },
  { id: "production-env", command: "npm", args: ["run", "validate:production-env", "--", ".env.production", "--json"], required: false, allowFailure: true, parseJson: true },
  { id: "cloudflare-backend", command: "npm", args: ["run", "validate:cloudflare-backend", "--", "--json"], required: false, allowFailure: true, parseJson: true },
  { id: "secrets-signoff", command: "npm", args: ["run", "validate:secrets-signoff", "--", "--json"], required: false, allowFailure: true, parseJson: true },
  { id: "hr-signoff", command: "npm", args: ["run", "validate:hr-signoff", "--", "--json"], required: false, allowFailure: true, parseJson: true },
  { id: "storage-signoff", command: "npm", args: ["run", "validate:storage-signoff", "--", "--json"], required: false, allowFailure: true, parseJson: true },
  { id: "drill-evidence", command: "npm", args: ["run", "validate:drill-evidence", "--", "--json"], required: false, allowFailure: true, parseJson: true },
  { id: "local-recovery-evidence", command: "npm", args: ["run", "validate:local-recovery-drill", "--", "--json"], required: false, allowFailure: true, parseJson: true, diagnostic: true },
  { id: "doctor", command: "node", args: ["scripts/commercial-doctor.mjs", "--json"], required: false, allowFailure: true, parseJson: true },
  { id: "db-generate", command: "npm", args: ["run", "db:generate"], required: true, heavy: true },
  { id: "test-server", command: "npm", args: ["run", "test:server"], required: true, heavy: true },
  { id: "build", command: "npm", args: ["run", "build"], required: true, heavy: true },
  { id: "e2e", command: "npm", args: ["run", "test:e2e", "--", "--project=chromium", "--reporter=line"], required: true, heavy: true, optional: true }
]);

function nowIso() {
  return new Date().toISOString();
}

function slugTimestamp(value = nowIso()) {
  return value.replaceAll(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function safeFileSegment(value) {
  return String(value || "")
    .trim()
    .replace(/[^A-Za-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "run";
}

function resolveOutputPath(rootDir, path) {
  return isAbsolute(path) ? path : resolve(rootDir, path);
}

function parseBooleanEnv(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").toLowerCase());
}

function trimOutput(text, maxLength = 20000) {
  const value = String(text || "");
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}\n...[truncated ${value.length - maxLength} chars]`;
}

export function writePrivateTextFile(path, text) {
  writeFileSync(path, text, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function ensurePrivateDir(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

function commandMaxBufferBytes(env = process.env) {
  const parsed = Number.parseInt(env.COMMERCIAL_EVIDENCE_MAX_BUFFER_BYTES || "", 10);
  if (Number.isFinite(parsed) && parsed >= 1024 * 1024) return parsed;
  return defaultCommandMaxBufferBytes;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function databaseUrlSecretValues(env = process.env) {
  return Object.entries(env)
    .filter(([key, value]) => /DATABASE_URL/i.test(key) && String(value || "").length > 0)
    .flatMap(([, value]) => {
      try {
        const url = new URL(String(value));
        return [url.password, decodeURIComponent(url.password || "")];
      } catch {
        return [];
      }
    })
    .filter((value) => String(value || "").length >= 8);
}

function evidenceSecretValues(env = process.env) {
  return [
    ...Object.entries(env)
    .filter(([key, value]) => (
      /PASSWORD|SECRET|TOKEN|PRIVATE|CREDENTIAL|DATABASE_URL|ACCESS_KEY/i.test(key)
      && String(value || "").length >= 8
    ))
    .map(([, value]) => String(value))
    .filter(Boolean),
    ...databaseUrlSecretValues(env)
  ].sort((a, b) => b.length - a.length);
}

export function redactEvidenceText(text, {
  env = process.env,
  rootDir = process.cwd()
} = {}) {
  let value = String(text || "");
  const normalizedRoot = String(rootDir || "");
  if (normalizedRoot) {
    value = value.replaceAll(normalizedRoot, "[PROJECT_ROOT]");
  }
  value = value.replace(/(postgres(?:ql)?:\/\/[^:\s/]+:)([^@\s/]+)(@)/gi, "$1***$3");
  value = value.replace(/((?:PASSWORD|SECRET|TOKEN|PRIVATE|CREDENTIAL|DATABASE_URL|ACCESS_KEY)[A-Z0-9_]*\s*[=:]\s*)([^\s"'`]+)/gi, "$1[REDACTED]");
  evidenceSecretValues(env).forEach((secret) => {
    value = value.replace(new RegExp(escapeRegExp(secret), "g"), "[REDACTED]");
  });
  return value;
}

function redactEvidencePayload(payload, context = {}) {
  if (typeof payload === "string") return redactEvidenceText(payload, context);
  if (!payload || typeof payload !== "object") return payload;
  if (Array.isArray(payload)) return payload.map((item) => redactEvidencePayload(item, context));
  return Object.fromEntries(Object.entries(payload).map(([key, value]) => [
    key,
    redactEvidencePayload(value, context)
  ]));
}

export function parseKnownGapRegister(markdown) {
  return String(markdown || "")
    .split("\n")
    .filter((line) => line.startsWith("| GAP-"))
    .map((line) => {
      const [id, status, owner, targetDate, gap, exitCriteria] = line
        .split("|")
        .slice(1, -1)
        .map((cell) => cell.trim());
      return { id, status, owner, targetDate, gap, exitCriteria };
    });
}

export function extractJsonObject(text) {
  const source = String(text || "");
  const start = source.indexOf("{");
  const end = source.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(source.slice(start, end + 1));
  } catch {
    return null;
  }
}

export function sha256File(path) {
  if (!existsSync(path)) return null;
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function parseDatabaseTarget(databaseUrl = "", source = "DATABASE_URL") {
  if (!databaseUrl) return { configured: false };
  try {
    const parsed = new URL(String(databaseUrl));
    if (!["postgres:", "postgresql:"].includes(parsed.protocol)) return { configured: false };
    const host = parsed.hostname.replace(/^\[(.*)\]$/, "$1") || "";
    const localHosts = new Set(["127.0.0.1", "localhost", "::1"]);
    return {
      configured: true,
      database: decodeURIComponent(parsed.pathname.replace(/^\//, "")),
      host,
      isLocal: localHosts.has(host),
      port: parsed.port || "5432",
      schema: parsed.searchParams.get("schema") || "public",
      source,
      url: parsed.href.replace(/(postgres(?:ql)?:\/\/[^:\s/]+:)([^@\s/]+)(@)/i, "$1***$3")
    };
  } catch {
    return { configured: false };
  }
}

function readLocalPostgresEnv(env = process.env, rootDir = process.cwd()) {
  const configured = env.LOCAL_POSTGRES_ENV || ".local-postgres/.env.local-postgres";
  const envPath = isAbsolute(configured) ? configured : resolve(rootDir, configured);
  try {
    return parseDotenvText(readFileSync(envPath, "utf8"));
  } catch {
    return {};
  }
}

function effectiveTargetEnv(env = process.env, rootDir = process.cwd()) {
  return {
    ...readLocalPostgresEnv(env, rootDir),
    ...env
  };
}

function resolveTargetDatabase(env = process.env, rootDir = process.cwd()) {
  if (env.DATABASE_URL) return parseDatabaseTarget(env.DATABASE_URL, "DATABASE_URL");
  const localEnv = readLocalPostgresEnv(env, rootDir);
  if (localEnv.DATABASE_URL) return parseDatabaseTarget(localEnv.DATABASE_URL, "local-postgres-env");
  return parseDatabaseTarget("");
}

function checkPassed(checks = [], id) {
  return checks.some((check) => check.id === id && check.exitCode === 0);
}

export function buildTargetProfile({
  checks = [],
  env = process.env,
  rootDir = process.cwd()
} = {}) {
  const targetEnv = effectiveTargetEnv(env, rootDir);
  const database = resolveTargetDatabase(env, rootDir);
  const appEnv = String(targetEnv.APP_ENV || "").trim() || "";
  const nodeEnv = String(targetEnv.NODE_ENV || "").trim() || "";
  const isProductionRuntime = appEnv === "production" || nodeEnv === "production";
  const productionEvidenceReady = ["production-env", "cloudflare-backend", "secrets-signoff", "storage-signoff", "hr-signoff", "drill-evidence"]
    .every((id) => checkPassed(checks, id));
  const evidenceClass = isProductionRuntime && productionEvidenceReady ? "production-release-evidence" : "local-or-ci-validation";
  const warnings = [];

  if (database.isLocal) warnings.push("DATABASE_URL points at a local PostgreSQL host; this is not production database evidence.");
  if (!productionEvidenceReady) warnings.push("Production env, Cloudflare backend, signoff, storage, HR, or drill evidence is not fully green.");
  if (targetEnv.VITE_DEMO_FALLBACK === "1") warnings.push("VITE_DEMO_FALLBACK is enabled; production frontend evidence requires it disabled.");

  return {
    appEnv: appEnv || "unset",
    apiBaseUrl: redactEvidenceText(targetEnv.API_BASE_URL || "", { env: targetEnv, rootDir }),
    database,
    evidenceClass,
    e2eIncluded: checks.some((check) => check.id === "e2e"),
    nodeEnv: nodeEnv || "unset",
    productionEvidenceReady,
    productionRuntime: isProductionRuntime,
    signoffChecks: {
      cloudflareBackend: checkPassed(checks, "cloudflare-backend"),
      drillEvidence: checkPassed(checks, "drill-evidence"),
      hr: checkPassed(checks, "hr-signoff"),
      productionEnv: checkPassed(checks, "production-env"),
      secrets: checkPassed(checks, "secrets-signoff"),
      storage: checkPassed(checks, "storage-signoff")
    },
    viteDemoFallback: String(targetEnv.VITE_DEMO_FALLBACK || "unset"),
    viteRequireApi: String(targetEnv.VITE_REQUIRE_API || "unset"),
    warnings
  };
}

export function collectArtifacts(rootDir = process.cwd()) {
  const fromRoot = (path) => resolve(rootDir, path);
  const migrationDir = fromRoot("prisma/migrations");
  const migrations = existsSync(migrationDir)
    ? readdirSync(migrationDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
    : [];

  const trackedFiles = [
    "package.json",
    "prisma/schema.prisma",
    "server/src/openapi.mjs",
    "scripts/commercial-evidence.mjs",
    "scripts/commercial-gap-report.mjs",
    "scripts/commercial-readiness-audit.mjs",
    "scripts/commercial-release-candidate.mjs",
    "scripts/commercial-release-dossier.mjs",
    "scripts/commercial-release-gate.mjs",
    "scripts/configure-backend-server.mjs",
    "scripts/materialize-release-inputs.mjs",
    "scripts/generate-signoff-drafts.mjs",
    "scripts/generate-sbom.mjs",
    "scripts/github-drill-evidence.mjs",
    "scripts/prepare-hr-data-review.mjs",
    "scripts/validate-evidence-permissions.mjs",
    "scripts/validate-file-backup.mjs",
    "scripts/validate-cloudflare-backend.mjs",
    "scripts/validate-hr-signoff.mjs",
    "scripts/validate-storage-signoff.mjs",
    "scripts/validate-drill-evidence.mjs",
    "scripts/validate-local-recovery-drill.mjs",
    "scripts/validate-migrations.mjs",
    "scripts/validate-production-env.mjs",
    "scripts/validate-secrets-signoff.mjs",
    "scripts/validate-supply-chain.mjs",
    "reports/commercial-evidence/sbom/latest-spdx.json",
    "reports/commercial-evidence/production-env-prep/latest-manifest.json",
    "reports/commercial-evidence/signoff-drafts/latest-manifest.json",
    "reports/commercial-evidence/backend-server-config/latest-manifest.json",
    "reports/commercial-evidence/backend-server-config/latest-index.md",
    "docs/openapi.json",
    "prisma/migrations/migration-lock.json",
    "docs/KNOWN_GAPS.md",
    "docs/production-secrets-signoff.json",
    "docs/production-secrets-signoff.example.json",
    "docs/hr-data-signoff.json",
    "docs/hr-data-signoff.example.json",
    "docs/file-storage-signoff.json",
    "docs/file-storage-signoff.example.json",
    "commercial-evidence/latest-drill-summary.json",
    "commercial-evidence/latest-local-recovery-drill-summary.json",
    "reports/commercial-evidence/latest-github-drill-evidence.json",
    "reports/commercial-evidence/hr-data-review/latest-manifest.json",
    "reports/commercial-evidence/latest-gap-report.json",
    "reports/commercial-evidence/latest-gap-report.md",
    "reports/commercial-evidence/latest-owner-handoff-manifest.json",
    "reports/commercial-evidence/latest-owner-handoff.md",
    "reports/commercial-evidence/signoff-validation/release-inputs.json",
    "reports/commercial-evidence/signoff-validation/production-env.json",
    "reports/commercial-evidence/signoff-validation/cloudflare-backend.json",
    "reports/commercial-evidence/signoff-validation/secrets-signoff.json",
    "reports/commercial-evidence/signoff-validation/hr-signoff.json",
    "reports/commercial-evidence/signoff-validation/storage-signoff.json",
    "docs/QA_ACCEPTANCE_CHECKLIST.md",
    ".github/workflows/commercial-ci.yml",
    ".github/workflows/commercial-drill.yml",
    ".github/workflows/commercial-signoff.yml",
    ".github/workflows/cloudflare-deploy.yml",
    "cloudflare/worker.js",
    "docker-compose.cloudflare.yml",
    "wrangler.toml",
    ".env.production.example",
    "docker-compose.yml",
    "docker-compose.prod.yml",
    "Dockerfile.api",
    "Dockerfile.web",
    "docker/nginx.conf",
    ".env.example",
    ".env.production.example"
  ];

  return {
    migrations,
    files: Object.fromEntries(trackedFiles.map((file) => [file, {
      exists: existsSync(fromRoot(file)),
      sha256: sha256File(fromRoot(file))
    }]))
  };
}

export function runCheck(check, { cwd = process.cwd(), env = process.env } = {}) {
  const startedAt = nowIso();
  const startNs = process.hrtime.bigint();
  const result = spawnSync(check.command, check.args || [], {
    cwd,
    encoding: "utf8",
    env,
    maxBuffer: commandMaxBufferBytes(env),
    shell: false,
    stdio: ["ignore", "pipe", "pipe"]
  });
  const durationMs = Number((process.hrtime.bigint() - startNs) / 1000000n);
  const exitCode = typeof result.status === "number" ? result.status : 1;
  const ok = exitCode === 0 || Boolean(check.allowFailure);
  const spawnError = result.error
    ? `${result.error.code || result.error.name || "spawn-error"}: ${result.error.message}`
    : "";
  const stderr = [result.stderr, spawnError].filter(Boolean).join("\n");

  return {
    id: check.id,
    command: [check.command, ...(check.args || [])].join(" "),
    required: Boolean(check.required),
    allowFailure: Boolean(check.allowFailure),
    diagnostic: Boolean(check.diagnostic),
    exitCode,
    ok,
    startedAt,
    finishedAt: nowIso(),
    durationMs,
    stdout: trimOutput(result.stdout),
    stderr: trimOutput(stderr),
    spawnError: spawnError || null,
    parsedJson: check.parseJson ? extractJsonObject(result.stdout) : null
  };
}

export function summarizeEvidence(report) {
  const requiredFailed = report.checks.filter((check) => check.required && check.exitCode !== 0);
  const warningChecks = report.checks.filter((check) => !check.required && !check.diagnostic && check.exitCode !== 0);
  const diagnosticChecks = report.checks.filter((check) => check.diagnostic);
  const openGaps = report.knownGaps.filter((gap) => gap.status === "Open");
  const doctor = report.checks.find((check) => check.id === "doctor")?.parsedJson || null;
  const e2eCheck = report.checks.find((check) => check.id === "e2e") || null;
  const targetProfile = report.targetProfile || null;
  const readiness = doctor?.readiness || null;
  const releaseBlockers = [];

  if (report.evidenceMode !== "full") releaseBlockers.push(`Evidence mode must be full; got ${report.evidenceMode || "unknown"}.`);
  if (!e2eCheck) releaseBlockers.push("E2E evidence is missing.");
  if (e2eCheck && e2eCheck.exitCode !== 0) releaseBlockers.push(`E2E evidence failed: exitCode=${e2eCheck.exitCode}.`);
  requiredFailed.forEach((check) => releaseBlockers.push(`Required check failed: ${check.id} exitCode=${check.exitCode}.`));
  warningChecks.forEach((check) => releaseBlockers.push(`Release-blocking warning check failed: ${check.id} exitCode=${check.exitCode}.`));
  openGaps.forEach((gap) => releaseBlockers.push(`Known commercial gap remains open: ${gap.id}.`));

  if (readiness) {
    [
      "canRunDockerDrill",
      "canReachPostgres",
      "canVerifyDatabaseIntegrity",
      "canRunApiSmoke",
      "canRunFrontendApiSmoke"
    ].forEach((flag) => {
      if (readiness[flag] !== true) releaseBlockers.push(`Doctor readiness flag is not green: ${flag}.`);
    });
    (readiness.hardBlockers || []).forEach((blocker) => {
      releaseBlockers.push(`Doctor hard blocker remains: ${blocker.name || blocker.message || "unknown"}.`);
    });
  } else {
    releaseBlockers.push("Doctor readiness summary is missing.");
  }

  if (!targetProfile) {
    releaseBlockers.push("Target Profile is missing.");
  } else {
    if (targetProfile.evidenceClass !== "production-release-evidence") {
      releaseBlockers.push(`Target Profile evidence class is ${targetProfile.evidenceClass || "unknown"}.`);
    }
    if (targetProfile.productionRuntime !== true) releaseBlockers.push("Target Profile is not production runtime.");
    if (targetProfile.productionEvidenceReady !== true) releaseBlockers.push("Production signoff/drill evidence is not fully green.");
    if (targetProfile.viteRequireApi !== "1") releaseBlockers.push("Frontend is not in API-required mode.");
    if (targetProfile.viteDemoFallback !== "0") releaseBlockers.push("Frontend demo fallback is not disabled.");
    if (targetProfile.database?.configured !== true) releaseBlockers.push("Target database is not configured.");
    if (targetProfile.database?.isLocal === true) releaseBlockers.push("Target database is local PostgreSQL, not production evidence.");
  }

  return {
    evidenceMode: report.evidenceMode || "unknown",
    ok: requiredFailed.length === 0,
    releaseCandidateReady: releaseBlockers.length === 0,
    releaseBlockers,
    e2eIncluded: Boolean(e2eCheck),
    requiredFailed: requiredFailed.map((check) => ({ id: check.id, exitCode: check.exitCode })),
    warningChecks: warningChecks.map((check) => ({ id: check.id, exitCode: check.exitCode })),
    diagnosticChecks: diagnosticChecks.map((check) => ({ id: check.id, exitCode: check.exitCode })),
    openGapCount: openGaps.length,
    openGaps: openGaps.map((gap) => gap.id),
    readiness
  };
}

function inferEvidenceMode({ checks = [], commandLine = "" } = {}) {
  const command = String(commandLine || "");
  if (/\s--quick(?:\s|$)/.test(command)) return "quick";
  if (/\s--full(?:\s|$)/.test(command)) return "full";

  const checkIds = new Set(checks.map((check) => check.id));
  return ["db-generate", "test-server", "build"].every((id) => checkIds.has(id))
    ? "full"
    : "partial";
}

export function buildEvidenceReport({
  artifacts,
  checks,
  commandLine,
  evidenceMode,
  env = process.env,
  knownGaps,
  rootDir,
  startedAt,
  finishedAt
}) {
  const redactionContext = { env, rootDir };
  const resolvedEvidenceMode = evidenceMode || inferEvidenceMode({ checks, commandLine });
  const report = {
    schemaVersion: 1,
    evidenceMode: resolvedEvidenceMode,
    generatedAt: finishedAt,
    startedAt,
    finishedAt,
    projectRoot: "[PROJECT_ROOT]",
    commandLine: redactEvidenceText(commandLine, redactionContext),
    redaction: {
      projectRoot: "[PROJECT_ROOT]",
      environmentSecrets: "redacted from command output and parsed JSON"
    },
    runtime: {
      node: process.version,
      platform: process.platform,
      arch: process.arch
    },
    targetProfile: buildTargetProfile({ checks, env, rootDir }),
    knownGaps,
    artifacts,
    checks: checks.map((check) => ({
      ...check,
      command: redactEvidenceText(check.command, redactionContext),
      stdout: redactEvidenceText(check.stdout, redactionContext),
      stderr: redactEvidenceText(check.stderr, redactionContext),
      spawnError: check.spawnError ? redactEvidenceText(check.spawnError, redactionContext) : null,
      parsedJson: redactEvidencePayload(check.parsedJson, redactionContext)
    }))
  };
  return {
    ...report,
    summary: summarizeEvidence(report)
  };
}

export function parseEvidenceArgs(argv = []) {
  const options = {
    full: true,
    evidenceMode: "full",
    outputDir: defaultOutputDir,
    runE2e: parseBooleanEnv(process.env.EVIDENCE_RUN_E2E),
    strictReadiness: argv.includes("--strict-readiness")
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--quick") {
      options.full = false;
      options.evidenceMode = "quick";
    }
    if (arg === "--full") {
      options.full = true;
      options.evidenceMode = "full";
    }
    if (arg === "--e2e") options.runE2e = true;
    if (arg === "--output") {
      options.outputDir = argv[index + 1] || options.outputDir;
      index += 1;
    }
  }
  return options;
}

export function selectedEvidenceChecks(options = {}) {
  return commercialEvidenceChecks.filter((check) => {
    if (check.optional && check.id === "e2e") return Boolean(options.runE2e);
    if (check.heavy && options.full === false) return false;
    return true;
  });
}

export function writeEvidenceReport(report, outputDir = defaultOutputDir) {
  ensurePrivateDir(outputDir);
  const filename = `commercial-evidence-${slugTimestamp(report.generatedAt)}.json`;
  const outputPath = join(outputDir, filename);
  const payload = `${JSON.stringify(report, null, 2)}\n`;
  writePrivateTextFile(outputPath, payload);
  writePrivateTextFile(join(outputDir, "latest.json"), payload);
  return outputPath;
}

export function runGapReportCheck({
  evidencePath,
  outputDir = defaultOutputDir,
  cwd = process.cwd(),
  env = process.env
} = {}) {
  return runCheck({
    id: "gap-report",
    command: "npm",
    args: ["run", "gap:report", "--", evidencePath || defaultEvidencePath, "--output", outputDir, "--json"],
    required: true,
    parseJson: true
  }, { cwd, env });
}

export function runEvidencePermissionCheck({
  outputDir = defaultOutputDir,
  cwd = process.cwd(),
  env = process.env
} = {}) {
  return runCheck({
    id: "evidence-permissions",
    command: "npm",
    args: ["run", "audit:evidence-permissions", "--", "--evidence-dir", outputDir, "--json"],
    required: true,
    parseJson: true
  }, { cwd, env });
}

export function resolveCommercialEvidencePath({
  kind,
  payload = {},
  explicitPath = "",
  evidenceDir = "",
  now = new Date(),
  rootDir = process.cwd()
}) {
  if (explicitPath) return resolveOutputPath(rootDir, explicitPath);
  if (!evidenceDir) return "";

  const runId = safeFileSegment(payload.runId || payload.id || randomUUID());
  const fileName = `${safeFileSegment(kind)}-${slugTimestamp(now.toISOString())}-${runId}.json`;
  return join(resolveOutputPath(rootDir, evidenceDir), fileName);
}

export function writeCommercialEvidence({
  kind,
  payload,
  env = process.env,
  explicitPath,
  explicitPathEnv = "COMMERCIAL_EVIDENCE_FILE",
  now = new Date(),
  rootDir = process.cwd()
}) {
  const targetPath = resolveCommercialEvidencePath({
    kind,
    payload,
    explicitPath: explicitPath || env[explicitPathEnv] || env.COMMERCIAL_EVIDENCE_FILE || "",
    evidenceDir: env.COMMERCIAL_EVIDENCE_DIR || "",
    now,
    rootDir
  });

  if (!targetPath) return "";

  ensurePrivateDir(dirname(targetPath));
  writePrivateTextFile(targetPath, `${JSON.stringify(payload, null, 2)}\n`);
  return targetPath;
}

export function buildEvidenceCliResult({
  env = process.env,
  outputPath,
  report,
  rootDir = process.cwd(),
  strictReadinessFailed = false
} = {}) {
  const redactionContext = { env, rootDir };
  return {
    ok: Boolean(report?.summary?.ok) && !strictReadinessFailed,
    evidenceMode: report?.evidenceMode || report?.summary?.evidenceMode || "unknown",
    output: redactEvidenceText(outputPath || "", redactionContext),
    summary: redactEvidencePayload(report?.summary || {}, redactionContext)
  };
}

async function main(argv = process.argv.slice(2)) {
  const rootDir = process.cwd();
  const options = parseEvidenceArgs(argv);
  const startedAt = nowIso();
  const knownGapsPath = resolve(rootDir, "docs/KNOWN_GAPS.md");
  const knownGaps = existsSync(knownGapsPath)
    ? parseKnownGapRegister(readFileSync(knownGapsPath, "utf8"))
    : [];
  const checks = selectedEvidenceChecks(options).map((check) => runCheck(check, { cwd: rootDir }));
  const finishedAt = nowIso();
  const initialReport = buildEvidenceReport({
    artifacts: collectArtifacts(rootDir),
    checks,
    commandLine: ["node", relative(rootDir, fileURLToPath(import.meta.url)), ...argv].join(" "),
    evidenceMode: options.evidenceMode,
    knownGaps,
    rootDir,
    startedAt,
    finishedAt
  });
  const outputDir = resolve(rootDir, options.outputDir);
  const outputPath = writeEvidenceReport(initialReport, outputDir);
	  const gapReportCheck = runGapReportCheck({
	    evidencePath: outputPath,
	    outputDir,
	    cwd: rootDir
	  });
	  const evidencePermissionCheck = runEvidencePermissionCheck({
	    outputDir,
	    cwd: rootDir
	  });
	  const report = buildEvidenceReport({
	    artifacts: collectArtifacts(rootDir),
	    checks: [...checks, gapReportCheck, evidencePermissionCheck],
    commandLine: ["node", relative(rootDir, fileURLToPath(import.meta.url)), ...argv].join(" "),
    evidenceMode: options.evidenceMode,
    knownGaps,
    rootDir,
    startedAt,
    finishedAt
  });
  writeEvidenceReport(report, outputDir);
  const strictReadinessFailed = options.strictReadiness && report.summary.readiness && (
    !report.summary.readiness.canRunDockerDrill
    || !report.summary.readiness.canReachPostgres
    || !report.summary.readiness.canVerifyDatabaseIntegrity
    || !report.summary.readiness.canRunApiSmoke
    || !report.summary.readiness.canRunFrontendApiSmoke
  );

  console.log(JSON.stringify(buildEvidenceCliResult({
    outputPath,
    report,
    rootDir,
    strictReadinessFailed
  }), null, 2));

  if (!report.summary.ok || strictReadinessFailed) {
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || basename(import.meta.url)).href) {
  main();
}
