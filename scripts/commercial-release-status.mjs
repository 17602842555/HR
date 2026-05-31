import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { redactCommercialDevPath } from "./dev-commercial-core.mjs";
import { redactEvidenceText, extractJsonObject } from "./commercial-evidence.mjs";
import { parseGithubReleaseArgs, runGithubReleaseOrchestration } from "./github-release-orchestrator.mjs";

const defaultRepo = "17602842555/HR";
const defaultBranch = "main";
const defaultEnvironment = "production";
const defaultOutputDir = "reports/commercial-evidence/release-status";
const workflowNames = Object.freeze([
  "commercial-ci",
  "Deploy HR OA to Cloudflare",
  "commercial-signoff",
  "commercial-drill"
]);

function nowIso(now = new Date()) {
  return now.toISOString();
}

function slugTimestamp(value) {
  return String(value || nowIso()).replaceAll(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function valueFlag(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return null;
  return args[index + 1] || "";
}

function boolFlag(args, name) {
  return args.includes(name);
}

function safeId(value, label) {
  const text = String(value || "").trim();
  if (!/^[A-Za-z0-9_.:/-]+$/.test(text)) {
    throw new Error(`${label} contains unsupported characters.`);
  }
  return text;
}

function safeEnvironment(value) {
  const text = String(value || "").trim();
  if (!/^[A-Za-z0-9_.-]+$/.test(text)) {
    throw new Error("GitHub environment name contains unsupported characters.");
  }
  return text;
}

function resolveFromRoot(rootDir, path) {
  return isAbsolute(path) ? path : resolve(rootDir, path);
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

function runCommand(command, args, {
  cwd = process.cwd(),
  maxBuffer = 32 * 1024 * 1024
} = {}) {
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

function currentGitSha(rootDir, commandRunner) {
  const result = commandRunner("git", ["rev-parse", "HEAD"], { cwd: rootDir });
  if (!result.ok) throw new Error("Could not read current git SHA.");
  return result.stdout.trim();
}

function parseJsonResult(result, fallback = null) {
  if (!result.stdout && !result.output) return fallback;
  const text = result.stdout || result.output;
  try {
    return JSON.parse(text);
  } catch {
    return extractJsonObject(text) || fallback;
  }
}

export function parseReleaseStatusArgs(argv = [], env = process.env) {
  const args = [...argv];
  return {
    branch: safeId(valueFlag(args, "--branch") || env.GITHUB_RELEASE_BRANCH || defaultBranch, "Branch"),
    environment: safeEnvironment(valueFlag(args, "--environment") || env.GITHUB_RELEASE_ENVIRONMENT || defaultEnvironment),
    json: boolFlag(args, "--json"),
    outputDir: valueFlag(args, "--output") || defaultOutputDir,
    repo: safeId(valueFlag(args, "--repo") || env.GITHUB_REPOSITORY || defaultRepo, "GitHub repository"),
    runLimit: Number.parseInt(valueFlag(args, "--run-limit") || "12", 10) || 12
  };
}

export function buildGhRunListArgs({ branch, repo, runLimit }) {
  return [
    "run",
    "list",
    "--repo", repo,
    "--branch", branch,
    "--limit", String(runLimit),
    "--json", "databaseId,headSha,createdAt,status,conclusion,displayTitle,workflowName,url,event"
  ];
}

export function buildGhRunViewArgs({ repo, runId }) {
  return [
    "run",
    "view",
    String(runId),
    "--repo", repo,
    "--json", "databaseId,headSha,status,conclusion,url,jobs"
  ];
}

function normalizeRun(run = {}) {
  if (!run?.databaseId) return null;
  return {
    conclusion: run.conclusion || "",
    createdAt: run.createdAt || "",
    event: run.event || "",
    headSha: run.headSha || "",
    runId: String(run.databaseId),
    status: run.status || "",
    url: run.url || "",
    workflowName: run.workflowName || ""
  };
}

function latestRun(runs = [], workflowName, currentSha = "") {
  const matching = runs
    .filter((run) => run.workflowName === workflowName)
    .map(normalizeRun)
    .filter(Boolean);
  return matching.find((run) => run.headSha === currentSha) || matching[0] || null;
}

function stepByName(view = {}, name) {
  return (view.jobs || [])
    .flatMap((job) => job.steps || [])
    .find((step) => step.name === name) || null;
}

function stepByAnyName(view = {}, names) {
  return names.map((name) => stepByName(view, name)).find(Boolean) || null;
}

export function summarizeCloudflareDeploy(view = {}) {
  const verifyBuild = stepByName(view, "Verify frontend build");
  const deploy = stepByAnyName(view, [
    "Deploy Worker with assets and native API",
    "Deploy Worker with assets and API origin secret"
  ]);
  const smoke = stepByName(view, "Smoke deployed backend gateway");
  const missingSecrets = stepByName(view, "Cloudflare secrets not configured");
  const apiOriginMissing = stepByName(view, "Cloudflare API origin not configured");

  return {
    actualDeployment: deploy?.conclusion === "success",
    apiOriginMissing: apiOriginMissing?.conclusion === "success",
    buildSucceeded: verifyBuild?.conclusion === "success",
    deployConclusion: deploy?.conclusion || "missing",
    missingSecretsNotice: missingSecrets?.conclusion === "success",
    smokeConclusion: smoke?.conclusion || "missing",
    smokePassed: smoke?.conclusion === "success",
    workerDeployStepName: deploy?.name || "",
    workerDeployStepPresent: Boolean(deploy)
  };
}

function releaseGateSummary(payload = {}) {
  return {
    evidenceAgeHours: payload.summary?.evidenceAgeHours ?? null,
    evidenceMode: payload.summary?.evidenceMode || "",
    failures: Array.isArray(payload.failures) ? payload.failures : [],
    ok: Boolean(payload.ok),
    openGapCount: payload.summary?.openGapCount ?? null,
    targetProfile: payload.summary?.targetProfile || null,
    warnings: Array.isArray(payload.warnings) ? payload.warnings : []
  };
}

function nextActions({ cloudflareDeploy, githubPlan, releaseGate }) {
  const actions = [];
  (githubPlan.blockers || []).forEach((blocker) => actions.push(blocker));
  if (!releaseGate.ok) {
    releaseGate.failures.slice(0, 8).forEach((failure) => actions.push(failure));
    if (releaseGate.failures.length > 8) actions.push(`${releaseGate.failures.length - 8} additional release gate failures remain.`);
  }
  if (cloudflareDeploy && !cloudflareDeploy.actualDeployment) {
    actions.push("Cloudflare workflow is still build-only; configure Cloudflare native Worker secrets and rerun with require_deploy=true.");
  }
  return [...new Set(actions)];
}

export async function buildCommercialReleaseStatus(options, {
  commandRunner = runCommand,
  rootDir = process.cwd()
} = {}) {
  const generatedAt = nowIso();
  const outputDir = resolveFromRoot(rootDir, options.outputDir);
  const outputPath = join(outputDir, `commercial-release-status-${slugTimestamp(generatedAt)}.json`);
  const latestPath = join(outputDir, "latest-status.json");
  const currentSha = currentGitSha(rootDir, commandRunner);
  const githubPlan = await runGithubReleaseOrchestration(parseGithubReleaseArgs([
    "--repo", options.repo,
    "--branch", options.branch,
    "--environment", options.environment,
    "--output", "reports/commercial-evidence/github-release-orchestration"
  ]), { commandRunner, rootDir });

  const gateResult = commandRunner("npm", ["run", "release:gate", "--", "--json"], {
    cwd: rootDir,
    maxBuffer: 32 * 1024 * 1024
  });
  const gatePayload = parseJsonResult(gateResult, { ok: false, failures: [gateResult.output || "release gate did not return JSON"] });
  const releaseGate = releaseGateSummary(gatePayload);

  const runListResult = commandRunner("gh", buildGhRunListArgs(options), { cwd: rootDir });
  const runs = runListResult.ok ? parseJsonResult(runListResult, []) : [];
  const latestRuns = Object.fromEntries(workflowNames.map((workflowName) => [
    workflowName,
    latestRun(Array.isArray(runs) ? runs : [], workflowName, currentSha)
  ]));

  let cloudflareDeploy = null;
  const cloudflareRun = latestRuns["Deploy HR OA to Cloudflare"];
  if (cloudflareRun?.runId) {
    const viewResult = commandRunner("gh", buildGhRunViewArgs({ repo: options.repo, runId: cloudflareRun.runId }), { cwd: rootDir });
    const viewPayload = viewResult.ok ? parseJsonResult(viewResult, {}) : {};
    cloudflareDeploy = {
      run: cloudflareRun,
      ...summarizeCloudflareDeploy(viewPayload)
    };
  }

  const commercialCi = latestRuns["commercial-ci"];
  const blockers = [];
  if (!githubPlan.ok) blockers.push(...(githubPlan.blockers || []));
  if (!releaseGate.ok) blockers.push("Release gate is not accepted.");
  if (!commercialCi || commercialCi.conclusion !== "success" || commercialCi.headSha !== currentSha) {
    blockers.push("Latest commercial-ci run for current SHA is not successful.");
  }
  if (!cloudflareDeploy?.actualDeployment) {
    blockers.push("Cloudflare Worker has not been deployed for the current SHA.");
  }
  if (cloudflareDeploy && !cloudflareDeploy.smokePassed) {
    blockers.push("Cloudflare deployed backend smoke has not passed for the current SHA.");
  }

  const status = {
    blockers: [...new Set(blockers)],
    branch: options.branch,
    currentSha,
    environment: options.environment,
    generatedAt,
    github: {
      cloudflareDeploy,
      latestRuns,
      releasePlan: {
        blockers: githubPlan.blockers || [],
        ok: githubPlan.ok,
        repositorySecrets: githubPlan.repositorySecrets,
        environmentSecrets: githubPlan.environmentSecrets,
        steps: githubPlan.steps
      },
      runList: {
        ok: runListResult.ok,
        error: runListResult.ok ? "" : redactEvidenceText(runListResult.output || "", { rootDir })
      }
    },
    kind: "commercial-release-status",
    ok: false,
    output: redactCommercialDevPath(outputPath, { rootDir }),
    releaseGate,
    repository: options.repo
  };
  status.nextActions = nextActions({ cloudflareDeploy, githubPlan, releaseGate });
  status.ok = status.blockers.length === 0;

  writePrivateJson(outputPath, status);
  writePrivateJson(latestPath, status);
  return {
    ...status,
    latest: redactCommercialDevPath(latestPath, { rootDir }),
    output: redactCommercialDevPath(outputPath, { rootDir })
  };
}

function printReport(report, jsonMode) {
  if (jsonMode) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(`${report.ok ? "OK" : "NOT READY"}: commercial release status`);
  console.log(`Repository: ${report.repository}`);
  console.log(`Current SHA: ${report.currentSha}`);
  if (report.blockers.length) {
    console.log("Blockers:");
    report.blockers.forEach((blocker) => console.log(`- ${blocker}`));
  }
  console.log(`Status: ${report.latest || report.output}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = parseReleaseStatusArgs(process.argv.slice(2));
    const report = await buildCommercialReleaseStatus(options);
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
