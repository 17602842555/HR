import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { redactCommercialDevPath } from "./dev-commercial-core.mjs";
import { validateCommercialDrillEvidence } from "./validate-drill-evidence.mjs";

const DEFAULT_REPO = "17602842555/HR";
const DEFAULT_BRANCH = "main";
const DEFAULT_WORKFLOW = "commercial-drill.yml";
const DEFAULT_ARTIFACT = "commercial-drill-evidence";
const DEFAULT_DOWNLOAD_DIR = "reports/commercial-evidence/github-drill-artifact";
const DEFAULT_MANIFEST_PATH = "reports/commercial-evidence/latest-github-drill-evidence.json";
const DEFAULT_SUMMARY_PATH = "commercial-evidence/latest-drill-summary.json";

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

export function parseGithubDrillEvidenceArgs(argv = [], env = process.env) {
  const args = [...argv];
  const runId = valueFlag(args, "--run") || valueFlag(args, "--run-id") || "";
  return {
    artifact: safeId(valueFlag(args, "--artifact") || env.GITHUB_DRILL_ARTIFACT || DEFAULT_ARTIFACT, "Artifact name"),
    branch: safeId(valueFlag(args, "--branch") || env.GITHUB_DRILL_BRANCH || DEFAULT_BRANCH, "Branch"),
    clean: !boolFlag(args, "--no-clean"),
    downloadDir: valueFlag(args, "--dir") || env.GITHUB_DRILL_DOWNLOAD_DIR || DEFAULT_DOWNLOAD_DIR,
    json: boolFlag(args, "--json"),
    manifestPath: valueFlag(args, "--manifest") || env.GITHUB_DRILL_MANIFEST || DEFAULT_MANIFEST_PATH,
    promote: boolFlag(args, "--promote"),
    repo: safeId(valueFlag(args, "--repo") || env.GITHUB_REPOSITORY || DEFAULT_REPO, "GitHub repository"),
    requireCurrentSha: boolFlag(args, "--require-current-sha"),
    runId: runId ? safeRunId(runId) : "",
    summaryPath: valueFlag(args, "--summary") || DEFAULT_SUMMARY_PATH,
    workflow: safeId(valueFlag(args, "--workflow") || env.GITHUB_DRILL_WORKFLOW || DEFAULT_WORKFLOW, "Workflow")
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
    throw new Error(`${label} failed: ${String(result.output || result.error?.message || "unknown").slice(0, 500)}`);
  }
  try {
    return JSON.parse(result.stdout || "null");
  } catch (error) {
    throw new Error(`${label} did not return valid JSON: ${error.message}`);
  }
}

function selectedRunFromList(payload) {
  if (!Array.isArray(payload) || payload.length === 0) {
    throw new Error("No successful commercial-drill workflow run was found.");
  }
  return payload[0];
}

function normalizeRun(payload) {
  const run = Array.isArray(payload) ? selectedRunFromList(payload) : payload;
  const runId = String(run?.databaseId || "");
  if (!/^\d+$/.test(runId)) throw new Error("GitHub drill run metadata is missing databaseId.");
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

function currentGitSha(rootDir) {
  const result = runCommand("git", ["rev-parse", "HEAD"], { cwd: rootDir });
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

function promoteArtifact(downloadDir, rootDir) {
  const copied = [];
  for (const name of ["commercial-evidence", "backups"]) {
    const source = join(downloadDir, name);
    if (!existsSync(source)) continue;
    const target = join(rootDir, name);
    cpSync(source, target, { recursive: true, force: true });
    chmodRecursive(target);
    copied.push(redactCommercialDevPath(target, { rootDir }));
  }
  return copied;
}

export function buildGithubDrillEvidenceManifest({
  copied = [],
  downloadDir,
  manifestPath,
  options,
  rootDir,
  run,
  validation
}) {
  return {
    artifact: options.artifact,
    copied: copied.map((path) => redactCommercialDevPath(path, { rootDir })),
    downloadDir: redactCommercialDevPath(downloadDir, { rootDir }),
    kind: "github-commercial-drill-evidence",
    manifestPath: redactCommercialDevPath(manifestPath, { rootDir }),
    ok: validation.ok,
    promoted: Boolean(options.promote),
    repository: options.repo,
    run,
    summaryPath: validation.summaryPath
      ? redactCommercialDevPath(validation.summaryPath, { rootDir })
      : "",
    validation: {
      errors: validation.errors || [],
      evidence: validation.evidence
        ? {
            backupFile: redactCommercialDevPath(validation.evidence.backupFile || "", { rootDir }),
            fileBackup: redactCommercialDevPath(validation.evidence.fileBackup || "", { rootDir }),
            finishedAt: validation.evidence.finishedAt || null,
            postRestoreSmokeEvidence: redactCommercialDevPath(validation.evidence.postRestoreSmokeEvidence || "", { rootDir }),
            preRestoreSmokeEvidence: redactCommercialDevPath(validation.evidence.preRestoreSmokeEvidence || "", { rootDir })
          }
        : null,
      warnings: validation.warnings || []
    },
    workflow: options.workflow
  };
}

export async function fetchGithubDrillEvidence(options, {
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
    const expectedSha = currentGitSha(rootDir);
    if (run.headSha !== expectedSha) {
      throw new Error(`Latest commercial-drill run SHA ${run.headSha || "unknown"} does not match current HEAD ${expectedSha}.`);
    }
  }

  if (options.clean) rmSync(downloadDir, { recursive: true, force: true });
  ensurePrivateDir(downloadDir);

  const downloadOptions = { ...options, runId: run.runId };
  const download = commandRunner("gh", buildGhDownloadArgs(downloadOptions, downloadDir), { cwd: rootDir });
  if (!download.ok) {
    throw new Error(`gh run download failed: ${String(download.output || download.error?.message || "unknown").slice(0, 500)}`);
  }
  chmodRecursive(downloadDir);

  const summaryPath = join(downloadDir, options.summaryPath);
  const validation = validateCommercialDrillEvidence(summaryPath, { rootDir: downloadDir });
  const copied = validation.ok && options.promote ? promoteArtifact(downloadDir, rootDir) : [];
  const manifest = buildGithubDrillEvidenceManifest({
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
  console.log(`${report.ok ? "OK" : "NOT READY"}: GitHub commercial drill evidence`);
  console.log(`Run: ${report.run.runId} ${report.run.url}`);
  console.log(`Summary: ${report.summaryPath}`);
  if (report.validation.errors?.length) {
    console.log("Errors:");
    report.validation.errors.forEach((error) => console.log(`- ${error}`));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = parseGithubDrillEvidenceArgs(process.argv.slice(2));
    const report = await fetchGithubDrillEvidence(options);
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
