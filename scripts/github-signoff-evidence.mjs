import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { redactCommercialDevPath } from "./dev-commercial-core.mjs";
import { redactEvidenceText } from "./commercial-evidence.mjs";

const DEFAULT_REPO = "17602842555/HR";
const DEFAULT_BRANCH = "main";
const DEFAULT_WORKFLOW = "commercial-signoff.yml";
const DEFAULT_ARTIFACT = "commercial-signoff-validation";
const DEFAULT_DOWNLOAD_DIR = "reports/commercial-evidence/github-signoff-artifact";
const DEFAULT_MANIFEST_PATH = "reports/commercial-evidence/latest-github-signoff-evidence.json";
const DEFAULT_PROMOTE_DIR = "reports/commercial-evidence/signoff-validation";

export const requiredSignoffValidationFiles = Object.freeze([
  "release-inputs.json",
  "production-env.json",
  "cloudflare-backend.json",
  "secrets-signoff.json",
  "hr-signoff.json",
  "storage-signoff.json"
]);

const expectedReleaseInputPaths = Object.freeze([
  ".env.production",
  "docs/file-storage-signoff.json",
  "docs/hr-data-signoff.json",
  "docs/production-secrets-signoff.json"
]);

const unsafeSecretPatterns = Object.freeze([
  /(?:POSTGRES_PASSWORD|JWT_SECRET|CLOUDFLARE_API_TOKEN|CLOUDFLARE_TUNNEL_TOKEN|DEFAULT_ADMIN_PASSWORD|OBJECT_STORAGE_SECRET_ACCESS_KEY)\s*=/i,
  /postgres(?:ql)?:\/\/[^:\s"']+:((?!\*\*\*|\[REDACTED\])[^@\s"']{8,})@/i,
  /Bearer\s+[A-Za-z0-9._~+/=-]{16,}/i
]);

function valueFlag(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return null;
  return args[index + 1] || "";
}

function boolFlag(args, name) {
  return args.includes(name);
}

function resolveMaybe(rootDir, path) {
  return isAbsolute(path) ? path : resolve(rootDir, path);
}

function normalizePath(path) {
  return String(path || "").replaceAll("\\", "/");
}

function isWithin(parent, child) {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function assertSafeOutputDir(rootDir, outputDir) {
  const resolved = resolveMaybe(rootDir, outputDir);
  if (!isWithin(rootDir, resolved)) {
    throw new Error("Download directory must stay inside the project root.");
  }
  const rel = normalizePath(relative(rootDir, resolved));
  if (!rel || rel === "." || rel === "src" || rel === "server" || rel === "scripts") {
    throw new Error("Download directory is too broad or points at source code.");
  }
  return resolved;
}

function safeId(value, label) {
  const text = String(value || "").trim();
  if (!/^[A-Za-z0-9_.:/-]+$/.test(text)) {
    throw new Error(`${label} contains unsupported characters.`);
  }
  return text;
}

function safeRunId(value) {
  const text = String(value || "").trim();
  if (!/^\d+$/.test(text)) {
    throw new Error("GitHub run id must be numeric.");
  }
  return text;
}

function sha256Text(text) {
  return createHash("sha256").update(String(text || "")).digest("hex");
}

export function parseGithubSignoffEvidenceArgs(argv = [], env = process.env) {
  const args = [...argv];
  const runId = valueFlag(args, "--run") || valueFlag(args, "--run-id") || "";
  return {
    artifact: safeId(valueFlag(args, "--artifact") || env.GITHUB_SIGNOFF_ARTIFACT || DEFAULT_ARTIFACT, "Artifact name"),
    branch: safeId(valueFlag(args, "--branch") || env.GITHUB_SIGNOFF_BRANCH || DEFAULT_BRANCH, "Branch"),
    clean: !boolFlag(args, "--no-clean"),
    downloadDir: valueFlag(args, "--dir") || env.GITHUB_SIGNOFF_DOWNLOAD_DIR || DEFAULT_DOWNLOAD_DIR,
    json: boolFlag(args, "--json"),
    manifestPath: valueFlag(args, "--manifest") || env.GITHUB_SIGNOFF_MANIFEST || DEFAULT_MANIFEST_PATH,
    promote: boolFlag(args, "--promote"),
    promoteDir: valueFlag(args, "--promote-dir") || DEFAULT_PROMOTE_DIR,
    repo: safeId(valueFlag(args, "--repo") || env.GITHUB_REPOSITORY || DEFAULT_REPO, "GitHub repository"),
    requireCurrentSha: boolFlag(args, "--require-current-sha"),
    runId: runId ? safeRunId(runId) : "",
    workflow: safeId(valueFlag(args, "--workflow") || env.GITHUB_SIGNOFF_WORKFLOW || DEFAULT_WORKFLOW, "Workflow")
  };
}

export function buildGhRunListArgs(options) {
  return [
    "run",
    "list",
    "--repo", options.repo,
    "--workflow", options.workflow,
    "--branch", options.branch,
    "--status", "success",
    "--limit", "1",
    "--json", "databaseId,headSha,createdAt,status,conclusion,displayTitle,workflowName,url,event"
  ];
}

export function buildGhRunViewArgs(options) {
  return [
    "run",
    "view",
    options.runId,
    "--repo", options.repo,
    "--json", "databaseId,headSha,createdAt,status,conclusion,displayTitle,workflowName,url,event"
  ];
}

export function buildGhDownloadArgs(options, downloadDir) {
  return [
    "run",
    "download",
    options.runId,
    "--repo", options.repo,
    "--name", options.artifact,
    "--dir", downloadDir
  ];
}

function runCommand(command, args, { cwd = process.cwd(), maxBuffer = 16 * 1024 * 1024 } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer,
    stdio: ["ignore", "pipe", "pipe"]
  });
  return {
    ...result,
    ok: result.status === 0 && !result.error,
    output: [result.stdout, result.stderr].filter(Boolean).join("\n").trim()
  };
}

function parseJsonOutput(result, label) {
  if (!result.ok) {
    throw new Error(`${label} failed: ${redactEvidenceText(String(result.output || result.error?.message || "unknown").slice(0, 500))}`);
  }
  try {
    return JSON.parse(result.stdout || "null");
  } catch (error) {
    throw new Error(`${label} did not return valid JSON: ${error.message}`);
  }
}

function selectedRunFromList(payload) {
  if (!Array.isArray(payload) || payload.length === 0) {
    throw new Error("No successful commercial-signoff workflow run was found.");
  }
  return payload[0];
}

function normalizeRun(payload) {
  const run = Array.isArray(payload) ? selectedRunFromList(payload) : payload;
  const runId = String(run?.databaseId || "");
  if (!/^\d+$/.test(runId)) throw new Error("GitHub signoff run metadata is missing databaseId.");
  return {
    conclusion: run.conclusion || "",
    createdAt: run.createdAt || "",
    displayTitle: run.displayTitle || "",
    event: run.event || "",
    headSha: run.headSha || "",
    runId,
    status: run.status || "",
    url: run.url || "",
    workflowName: run.workflowName || ""
  };
}

function currentGitSha(rootDir, commandRunner) {
  const result = commandRunner("git", ["rev-parse", "HEAD"], { cwd: rootDir });
  if (!result.ok) throw new Error("Could not read current git SHA.");
  return result.stdout.trim();
}

function chmodRecursive(path) {
  if (!existsSync(path)) return;
  const stat = statSyncSafe(path);
  if (!stat) return;
  chmodSync(path, stat.isDirectory() ? 0o700 : 0o600);
  if (!stat.isDirectory()) return;
  for (const { name } of readdirSafe(path)) {
    chmodRecursive(join(path, name));
  }
}

function readdirSafe(path) {
  try {
    return readdirSync(path, { withFileTypes: true });
  } catch {
    return [];
  }
}

function statSyncSafe(path) {
  try {
    return statSync(path);
  } catch {
    return null;
  }
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

function walkFiles(rootDir) {
  const files = [];
  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of readdirSafe(current)) {
      const child = join(current, entry.name);
      if (entry.isDirectory()) stack.push(child);
      else if (entry.isFile()) files.push(child);
    }
  }
  return files.sort();
}

function locateSignoffValidationDir(downloadDir) {
  const candidates = [
    downloadDir,
    join(downloadDir, "reports", "commercial-evidence", "signoff-validation"),
    join(downloadDir, "signoff-validation")
  ];
  for (const candidate of candidates) {
    if (requiredSignoffValidationFiles.every((file) => existsSync(join(candidate, file)))) return candidate;
  }

  const dirs = new Set(walkFiles(downloadDir).map((file) => dirname(file)));
  for (const dir of dirs) {
    if (requiredSignoffValidationFiles.every((file) => existsSync(join(dir, file)))) return dir;
  }
  return "";
}

function readJsonFile(path, errors, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    errors.push(`${label} is not valid JSON: ${error.message}`);
    return null;
  }
}

function assertNoUnsafeSecretText({ downloadDir, errors, rootDir }) {
  const unsafeNames = new Set([
    ".env.production",
    "file-storage-signoff.json",
    "hr-data-signoff.json",
    "production-secrets-signoff.json"
  ]);
  for (const file of walkFiles(downloadDir)) {
    const rel = normalizePath(relative(downloadDir, file));
    const base = rel.split("/").pop();
    if (unsafeNames.has(base) && !requiredSignoffValidationFiles.includes(base)) {
      errors.push(`Artifact unexpectedly contains secret-bearing release input file: ${rel}`);
    }
    const text = readFileSync(file, "utf8");
    const unsafePattern = unsafeSecretPatterns.find((pattern) => pattern.test(text));
    if (unsafePattern) {
      errors.push(`Artifact contains unsafe secret-like text in ${redactCommercialDevPath(file, { rootDir })}.`);
    }
  }
}

function validateReleaseInputManifest(payload, errors) {
  const written = Array.isArray(payload?.written) ? payload.written : [];
  const paths = written.map((item) => normalizePath(item?.path)).sort();
  for (const expectedPath of expectedReleaseInputPaths) {
    if (!paths.includes(expectedPath)) {
      errors.push(`release-inputs.json missing written release input path: ${expectedPath}`);
    }
  }
  for (const item of written) {
    if (!/^[a-f0-9]{64}$/.test(String(item?.sha256 || ""))) {
      errors.push(`release-inputs.json written item ${item?.path || "unknown"} is missing a SHA-256 digest.`);
    }
    if (!Number.isFinite(item?.bytes) || item.bytes <= 0) {
      errors.push(`release-inputs.json written item ${item?.path || "unknown"} has invalid byte size.`);
    }
  }
}

export function validateGithubSignoffArtifact(downloadDir, {
  rootDir = downloadDir
} = {}) {
  const resolvedDownloadDir = resolve(downloadDir);
  const errors = [];
  const warnings = [];
  const files = {};
  const validationDir = locateSignoffValidationDir(resolvedDownloadDir);
  if (!validationDir) {
    return {
      ok: false,
      errors: ["commercial-signoff-validation artifact is missing the required validation JSON files."],
      files,
      validationDir: "",
      warnings
    };
  }

  assertNoUnsafeSecretText({ downloadDir: resolvedDownloadDir, errors, rootDir });

  for (const fileName of requiredSignoffValidationFiles) {
    const filePath = join(validationDir, fileName);
    const text = readFileSync(filePath, "utf8");
    const parsed = readJsonFile(filePath, errors, fileName);
    const ok = parsed?.ok === true;
    files[fileName] = {
      bytes: Buffer.byteLength(text),
      ok,
      path: redactCommercialDevPath(filePath, { rootDir }),
      sha256: sha256Text(text)
    };
    if (!ok) errors.push(`${fileName} must contain ok:true.`);
    if (fileName === "release-inputs.json" && parsed) validateReleaseInputManifest(parsed, errors);
  }

  return {
    ok: errors.length === 0,
    errors,
    files,
    validationDir,
    warnings
  };
}

function promoteArtifact(validationDir, rootDir, promoteDir) {
  const targetDir = resolveMaybe(rootDir, promoteDir);
  if (!isWithin(rootDir, targetDir)) {
    throw new Error("Promote directory must stay inside the project root.");
  }
  ensurePrivateDir(targetDir);
  const copied = [];
  for (const fileName of requiredSignoffValidationFiles) {
    const source = join(validationDir, fileName);
    const target = join(targetDir, fileName);
    cpSync(source, target, { force: true });
    chmodSync(target, 0o600);
    copied.push(redactCommercialDevPath(target, { rootDir }));
  }
  return copied;
}

export function buildGithubSignoffEvidenceManifest({
  copied = [],
  downloadDir,
  manifestPath,
  options,
  rootDir,
  run,
  validation
}) {
  const files = Object.fromEntries(Object.entries(validation.files || {}).map(([name, file]) => [
    name,
    {
      ...file,
      path: redactCommercialDevPath(file?.path || "", { rootDir })
    }
  ]));
  return {
    artifact: options.artifact,
    copied: copied.map((path) => redactCommercialDevPath(path, { rootDir })),
    downloadDir: redactCommercialDevPath(downloadDir, { rootDir }),
    kind: "github-commercial-signoff-evidence",
    manifestPath: redactCommercialDevPath(manifestPath, { rootDir }),
    ok: validation.ok,
    promoted: Boolean(options.promote),
    repository: options.repo,
    run,
    validation: {
      errors: validation.errors || [],
      files,
      validationDir: validation.validationDir
        ? redactCommercialDevPath(validation.validationDir, { rootDir })
        : "",
      warnings: validation.warnings || []
    },
    workflow: options.workflow
  };
}

export async function fetchGithubSignoffEvidence(options, {
  commandRunner = runCommand,
  rootDir = process.cwd()
} = {}) {
  const downloadDir = assertSafeOutputDir(rootDir, options.downloadDir);
  const manifestPath = resolveMaybe(rootDir, options.manifestPath);
  const runPayload = options.runId
    ? parseJsonOutput(commandRunner("gh", buildGhRunViewArgs(options), { cwd: rootDir }), "gh run view")
    : selectedRunFromList(parseJsonOutput(commandRunner("gh", buildGhRunListArgs(options), { cwd: rootDir }), "gh run list"));
  const run = normalizeRun(runPayload);

  if (options.requireCurrentSha) {
    const expectedSha = currentGitSha(rootDir, commandRunner);
    if (run.headSha !== expectedSha) {
      throw new Error(`Latest commercial-signoff run SHA ${run.headSha || "unknown"} does not match current HEAD ${expectedSha}.`);
    }
  }

  if (options.clean) rmSync(downloadDir, { recursive: true, force: true });
  ensurePrivateDir(downloadDir);

  const downloadOptions = { ...options, runId: run.runId };
  const download = commandRunner("gh", buildGhDownloadArgs(downloadOptions, downloadDir), { cwd: rootDir });
  if (!download.ok) {
    throw new Error(`gh run download failed: ${redactEvidenceText(String(download.output || download.error?.message || "unknown").slice(0, 500))}`);
  }
  chmodRecursive(downloadDir);

  const validation = validateGithubSignoffArtifact(downloadDir, { rootDir });
  const copied = validation.ok && options.promote ? promoteArtifact(validation.validationDir, rootDir, options.promoteDir) : [];
  const manifest = buildGithubSignoffEvidenceManifest({
    copied,
    downloadDir,
    manifestPath,
    options,
    rootDir,
    run,
    validation
  });
  writePrivateJson(manifestPath, manifest);
  return manifest;
}

function printReport(report, jsonMode) {
  if (jsonMode) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(`${report.ok ? "OK" : "NOT READY"}: GitHub commercial signoff evidence`);
  console.log(`Run: ${report.run.runId} ${report.run.url}`);
  console.log(`Validation dir: ${report.validation.validationDir}`);
  if (report.validation.errors?.length) {
    console.log("Errors:");
    report.validation.errors.forEach((error) => console.log(`- ${error}`));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = parseGithubSignoffEvidenceArgs(process.argv.slice(2));
    const report = await fetchGithubSignoffEvidence(options);
    printReport(report, options.json);
    process.exitCode = report.ok ? 0 : 66;
  } catch (error) {
    if (process.argv.includes("--json")) {
      console.log(JSON.stringify({ ok: false, error: error.message }, null, 2));
    } else {
      console.error(error.message);
    }
    process.exitCode = 1;
  }
}
