import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  requiredBackendRepositorySecrets,
  requiredReleaseEnvironmentSecrets
} from "./configure-backend-server.mjs";
import { redactCommercialDevPath } from "./dev-commercial-core.mjs";
import { redactEvidenceText } from "./commercial-evidence.mjs";

const defaultRepo = "17602842555/HR";
const defaultBranch = "main";
const defaultEnvironment = "production";
const defaultOutputDir = "reports/commercial-evidence/github-release-orchestration";
const workflowNames = Object.freeze({
  deploy: "cloudflare-deploy.yml",
  drill: "commercial-drill.yml",
  signoff: "commercial-signoff.yml"
});

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

function safeRunId(value) {
  const text = String(value || "").trim();
  if (!/^\d+$/.test(text)) {
    throw new Error("GitHub run id must be numeric.");
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
  maxBuffer = 16 * 1024 * 1024
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

function commandResultError(result, label, rootDir) {
  return `${label} failed: ${redactEvidenceText(String(result.output || result.error?.message || "unknown").slice(0, 800), { rootDir })}`;
}

function parseJsonOutput(result, label, rootDir) {
  if (!result.ok) throw new Error(commandResultError(result, label, rootDir));
  try {
    return JSON.parse(result.stdout || "null");
  } catch (error) {
    throw new Error(`${label} did not return valid JSON: ${error.message}`);
  }
}

function parseSecretNames(text = "") {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split(/\s+/)[0])
    .filter((name) => /^[A-Z0-9_]+$/.test(name));
}

function secretStatus(required, configured, scope) {
  const set = new Set(configured || []);
  return required.map((name) => ({
    configured: set.has(name),
    name,
    scope
  }));
}

function formatCommand(command, args = []) {
  return [command, ...args].join(" ");
}

export function parseGithubReleaseArgs(argv = [], env = process.env) {
  const args = [...argv];
  return {
    apply: boolFlag(args, "--apply"),
    branch: safeId(valueFlag(args, "--branch") || env.GITHUB_RELEASE_BRANCH || defaultBranch, "Branch"),
    deployWorkflow: safeId(valueFlag(args, "--deploy-workflow") || workflowNames.deploy, "Deploy workflow"),
    drillWorkflow: safeId(valueFlag(args, "--drill-workflow") || workflowNames.drill, "Drill workflow"),
    environment: safeEnvironment(valueFlag(args, "--environment") || env.GITHUB_RELEASE_ENVIRONMENT || defaultEnvironment),
    json: boolFlag(args, "--json"),
    localGate: boolFlag(args, "--local-gate"),
    outputDir: valueFlag(args, "--output") || defaultOutputDir,
    promoteEvidence: !boolFlag(args, "--no-promote"),
    repo: safeId(valueFlag(args, "--repo") || env.GITHUB_REPOSITORY || defaultRepo, "GitHub repository"),
    signoffWorkflow: safeId(valueFlag(args, "--signoff-workflow") || workflowNames.signoff, "Signoff workflow"),
    wait: !boolFlag(args, "--no-wait")
  };
}

export function buildWorkflowRunArgs({ branch, inputs = {}, repo, workflow }) {
  const args = ["workflow", "run", workflow, "--repo", repo, "--ref", branch];
  Object.entries(inputs).forEach(([key, value]) => {
    args.push("-f", `${key}=${value}`);
  });
  return args;
}

export function buildRunListArgs({ branch, repo, workflow }) {
  return [
    "run",
    "list",
    "--repo", repo,
    "--workflow", workflow,
    "--branch", branch,
    "--limit", "20",
    "--json", "databaseId,headSha,createdAt,status,conclusion,displayTitle,workflowName,url,event"
  ];
}

export function buildRunWatchArgs({ repo, runId }) {
  return ["run", "watch", safeRunId(runId), "--repo", repo, "--exit-status"];
}

function buildSecretListArgs({ environment = "", repo }) {
  const args = ["secret", "list", "--repo", repo];
  if (environment) args.push("--env", environment);
  return args;
}

function currentGitSha(rootDir, commandRunner) {
  const result = commandRunner("git", ["rev-parse", "HEAD"], { cwd: rootDir });
  if (!result.ok) throw new Error("Could not read current git SHA.");
  return result.stdout.trim();
}

function listSecretNames({ environment = "", options, rootDir, commandRunner }) {
  const result = commandRunner("gh", buildSecretListArgs({ environment, repo: options.repo }), { cwd: rootDir });
  if (!result.ok) {
    return {
      errors: [commandResultError(result, environment ? `gh secret list --env ${environment}` : "gh secret list", rootDir)],
      names: [],
      ok: false
    };
  }
  return {
    errors: [],
    names: parseSecretNames(result.stdout),
    ok: true
  };
}

function workflowPlanSteps(options) {
  return [
    {
      id: "commercial-signoff",
      command: formatCommand("gh", buildWorkflowRunArgs({
        branch: options.branch,
        inputs: { target_environment: options.environment },
        repo: options.repo,
        workflow: options.signoffWorkflow
      })),
      evidenceCommand: formatCommand("npm", [
        "run", "evidence:github-signoff", "--",
        "--promote",
        "--require-current-sha",
        "--json"
      ]),
      required: true,
      workflow: options.signoffWorkflow
    },
    {
      id: "commercial-drill",
      command: formatCommand("gh", buildWorkflowRunArgs({
        branch: options.branch,
        inputs: { run_release_evidence: "false" },
        repo: options.repo,
        workflow: options.drillWorkflow
      })),
      evidenceCommand: formatCommand("npm", [
        "run", "evidence:github-drill", "--",
        "--promote",
        "--require-current-sha",
        "--json"
      ]),
      required: true,
      workflow: options.drillWorkflow
    },
    {
      id: "cloudflare-deploy",
      command: formatCommand("gh", buildWorkflowRunArgs({
        branch: options.branch,
        inputs: { require_deploy: "true" },
        repo: options.repo,
        workflow: options.deployWorkflow
      })),
      required: true,
      workflow: options.deployWorkflow
    }
  ];
}

export function buildGithubReleasePlan({
  currentSha = "",
  environmentSecretNames = [],
  environmentSecretErrors = [],
  generatedAt = nowIso(),
  options,
  repositorySecretNames = [],
  repositorySecretErrors = []
}) {
  const repositorySecrets = secretStatus(requiredBackendRepositorySecrets, repositorySecretNames, "repository");
  const environmentSecrets = secretStatus(requiredReleaseEnvironmentSecrets, environmentSecretNames, "environment");
  const missingRepositorySecrets = repositorySecrets.filter((item) => !item.configured).map((item) => item.name);
  const missingEnvironmentSecrets = environmentSecrets.filter((item) => !item.configured).map((item) => item.name);
  const blockers = [
    ...repositorySecretErrors,
    ...environmentSecretErrors,
    ...missingRepositorySecrets.map((name) => `Missing GitHub repository secret: ${name}`),
    ...missingEnvironmentSecrets.map((name) => `Missing GitHub ${options.environment} environment secret: ${name}`)
  ];

  return {
    apply: Boolean(options.apply),
    blockers,
    branch: options.branch,
    currentSha,
    environment: options.environment,
    environmentSecrets,
    generatedAt,
    kind: "github-commercial-release-orchestration",
    ok: blockers.length === 0,
    promoteEvidence: Boolean(options.promoteEvidence),
    repository: options.repo,
    repositorySecrets,
    steps: workflowPlanSteps(options),
    wait: Boolean(options.wait)
  };
}

function findLatestWorkflowRun({ commandRunner, currentSha, options, rootDir, workflow }) {
  const payload = parseJsonOutput(
    commandRunner("gh", buildRunListArgs({ branch: options.branch, repo: options.repo, workflow }), { cwd: rootDir }),
    `gh run list ${workflow}`,
    rootDir
  );
  const run = (Array.isArray(payload) ? payload : [])
    .find((item) => String(item?.headSha || "") === currentSha && String(item?.event || "") === "workflow_dispatch")
    || (Array.isArray(payload) ? payload : []).find((item) => String(item?.headSha || "") === currentSha);
  if (!run?.databaseId) {
    throw new Error(`Could not locate a ${workflow} run for current SHA ${currentSha}.`);
  }
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

function runNpmEvidence({ args, commandRunner, rootDir }) {
  const result = commandRunner("npm", args, { cwd: rootDir, maxBuffer: 32 * 1024 * 1024 });
  return {
    command: formatCommand("npm", args),
    ok: result.ok,
    output: redactEvidenceText(String(result.output || "").slice(0, 2000), { rootDir }),
    status: result.status ?? 1
  };
}

function executeWorkflowStep({ commandRunner, currentSha, options, rootDir, step }) {
  const startedAt = nowIso();
  const triggerArgs = step.id === "commercial-signoff"
    ? buildWorkflowRunArgs({
      branch: options.branch,
      inputs: { target_environment: options.environment },
      repo: options.repo,
      workflow: step.workflow
    })
    : step.id === "commercial-drill"
      ? buildWorkflowRunArgs({
        branch: options.branch,
        inputs: { run_release_evidence: "false" },
        repo: options.repo,
        workflow: step.workflow
      })
      : buildWorkflowRunArgs({
        branch: options.branch,
        inputs: { require_deploy: "true" },
        repo: options.repo,
        workflow: step.workflow
      });
  const trigger = commandRunner("gh", triggerArgs, { cwd: rootDir });
  const result = {
    command: formatCommand("gh", triggerArgs),
    evidence: null,
    finishedAt: "",
    ok: trigger.ok,
    run: null,
    startedAt,
    status: trigger.status ?? 1,
    stepId: step.id,
    triggerOutput: redactEvidenceText(trigger.output || "", { rootDir }),
    watch: null
  };
  if (!trigger.ok) {
    result.finishedAt = nowIso();
    return result;
  }
  if (!options.wait) {
    result.finishedAt = nowIso();
    return result;
  }

  const run = findLatestWorkflowRun({ commandRunner, currentSha, options, rootDir, workflow: step.workflow });
  result.run = run;
  const watch = commandRunner("gh", buildRunWatchArgs({ repo: options.repo, runId: run.runId }), { cwd: rootDir, maxBuffer: 32 * 1024 * 1024 });
  result.watch = {
    command: formatCommand("gh", buildRunWatchArgs({ repo: options.repo, runId: run.runId })),
    ok: watch.ok,
    output: redactEvidenceText(String(watch.output || "").slice(0, 2000), { rootDir }),
    status: watch.status ?? 1
  };
  result.ok = result.ok && watch.ok;

  if (result.ok && options.promoteEvidence && step.id === "commercial-signoff") {
    result.evidence = runNpmEvidence({
      args: ["run", "evidence:github-signoff", "--", "--run", run.runId, "--promote", "--require-current-sha", "--json"],
      commandRunner,
      rootDir
    });
    result.ok = result.evidence.ok;
  }
  if (result.ok && options.promoteEvidence && step.id === "commercial-drill") {
    result.evidence = runNpmEvidence({
      args: ["run", "evidence:github-drill", "--", "--run", run.runId, "--promote", "--require-current-sha", "--json"],
      commandRunner,
      rootDir
    });
    result.ok = result.evidence.ok;
  }
  result.finishedAt = nowIso();
  return result;
}

function executeLocalReleaseGate({ commandRunner, rootDir }) {
  const result = commandRunner("npm", ["run", "release:gate", "--", "--json"], { cwd: rootDir, maxBuffer: 32 * 1024 * 1024 });
  return {
    command: "npm run release:gate -- --json",
    ok: result.ok,
    output: redactEvidenceText(String(result.output || "").slice(0, 4000), { rootDir }),
    status: result.status ?? 1
  };
}

export async function runGithubReleaseOrchestration(options, {
  commandRunner = runCommand,
  rootDir = process.cwd()
} = {}) {
  const generatedAt = nowIso();
  const outputDir = resolveFromRoot(rootDir, options.outputDir);
  const outputPath = join(outputDir, `github-release-orchestration-${slugTimestamp(generatedAt)}.json`);
  const latestPath = join(outputDir, "latest-manifest.json");
  const currentSha = currentGitSha(rootDir, commandRunner);
  const repositorySecrets = listSecretNames({ commandRunner, options, rootDir });
  const environmentSecrets = listSecretNames({ commandRunner, environment: options.environment, options, rootDir });
  const plan = buildGithubReleasePlan({
    currentSha,
    environmentSecretErrors: environmentSecrets.errors,
    environmentSecretNames: environmentSecrets.names,
    generatedAt,
    options,
    repositorySecretErrors: repositorySecrets.errors,
    repositorySecretNames: repositorySecrets.names
  });
  const report = {
    ...plan,
    execution: {
      localGate: null,
      results: [],
      skipped: !options.apply
    },
    output: redactCommercialDevPath(outputPath, { rootDir })
  };

  if (options.apply) {
    if (!plan.ok) {
      report.execution.skipped = true;
      report.execution.skipReason = "Release orchestration prerequisites are not complete.";
    } else {
      report.execution.skipped = false;
      for (const step of plan.steps) {
        const result = executeWorkflowStep({ commandRunner, currentSha, options, rootDir, step });
        report.execution.results.push(result);
        if (!result.ok) break;
      }
      if (options.localGate && report.execution.results.every((item) => item.ok)) {
        report.execution.localGate = executeLocalReleaseGate({ commandRunner, rootDir });
      }
      report.ok = plan.ok && report.execution.results.every((item) => item.ok) && (!report.execution.localGate || report.execution.localGate.ok);
    }
  }

  writePrivateJson(outputPath, report);
  writePrivateJson(latestPath, report);
  return {
    ...report,
    latest: redactCommercialDevPath(latestPath, { rootDir }),
    output: redactCommercialDevPath(outputPath, { rootDir })
  };
}

function printReport(report, jsonMode) {
  if (jsonMode) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(`${report.ok ? "OK" : "NOT READY"}: GitHub commercial release orchestration`);
  console.log(`Repository: ${report.repository}`);
  console.log(`Environment: ${report.environment}`);
  console.log(`Current SHA: ${report.currentSha}`);
  if (report.blockers.length) {
    console.log("Blockers:");
    report.blockers.forEach((blocker) => console.log(`- ${blocker}`));
  }
  console.log(`Manifest: ${report.latest || report.output}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = parseGithubReleaseArgs(process.argv.slice(2));
    const report = await runGithubReleaseOrchestration(options);
    printReport(report, options.json);
    process.exitCode = report.ok ? 0 : (options.apply ? 66 : 0);
  } catch (error) {
    if (process.argv.includes("--json")) {
      console.log(JSON.stringify({ ok: false, error: error.message }, null, 2));
    } else {
      console.error(error.message);
    }
    process.exitCode = 1;
  }
}
