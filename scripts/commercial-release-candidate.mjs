import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { redactEvidenceText, writePrivateTextFile } from "./commercial-evidence.mjs";

const defaultEvidencePath = "reports/commercial-evidence/latest.json";
const defaultOutputDir = "reports/commercial-evidence";
const defaultCommandMaxBufferBytes = 32 * 1024 * 1024;

function nowIso() {
  return new Date().toISOString();
}

function slugTimestamp(value = nowIso()) {
  return value.replaceAll(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function resolvePath(path) {
  return isAbsolute(path) ? path : resolve(process.cwd(), path);
}

function trimOutput(text, maxLength = 12000) {
  const value = String(text || "");
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}\n...[truncated ${value.length - maxLength} chars]`;
}

function commandMaxBufferBytes(env = process.env) {
  const parsed = Number.parseInt(env.COMMERCIAL_RELEASE_CANDIDATE_MAX_BUFFER_BYTES || env.COMMERCIAL_EVIDENCE_MAX_BUFFER_BYTES || "", 10);
  if (Number.isFinite(parsed) && parsed >= 1024 * 1024) return parsed;
  return defaultCommandMaxBufferBytes;
}

function commandLine(command, args = []) {
  return [command, ...args].join(" ");
}

function ensurePrivateDir(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

export function releaseCandidateSteps({
  diagnostic = false,
  evidencePath = defaultEvidencePath
} = {}) {
  const e2eArgs = diagnostic ? [] : ["--e2e", "--strict-readiness"];
  const diagnosticArgs = diagnostic ? ["--allow-missing-e2e"] : [];

  return [
    {
      id: "evidence",
      command: "npm",
      args: ["run", "evidence:commercial", "--", "--full", ...e2eArgs],
      continueAfterFailure: true
    },
    {
      id: "readiness-audit",
      command: "npm",
      args: ["run", "audit:readiness", "--", evidencePath, "--json", ...diagnosticArgs],
      continueAfterFailure: true
    },
    {
      id: "release-dossier",
      command: "npm",
      args: ["run", "dossier:commercial", "--", evidencePath, "--json", ...diagnosticArgs],
      continueAfterFailure: true
    },
    {
      id: "release-gate",
      command: "npm",
      args: ["run", "release:gate", "--", evidencePath, "--json", ...diagnosticArgs],
      continueAfterFailure: true
    }
  ];
}

export function runCandidateStepCommand(step, { cwd = process.cwd(), env = process.env } = {}) {
  const result = spawnSync(step.command, step.args || [], {
    cwd,
    encoding: "utf8",
    env,
    maxBuffer: commandMaxBufferBytes(env),
    shell: false,
    stdio: ["ignore", "pipe", "pipe"]
  });
  const spawnError = result.error
    ? `${result.error.code || result.error.name || "spawn-error"}: ${result.error.message}`
    : "";
  return {
    exitCode: typeof result.status === "number" ? result.status : 1,
    stdout: result.stdout || "",
    stderr: [result.stderr, spawnError].filter(Boolean).join("\n"),
    spawnError: spawnError || null
  };
}

export function summarizeCandidate({ diagnostic = false, results = [] } = {}) {
  const failedSteps = results.filter((step) => step.exitCode !== 0).map((step) => ({
    id: step.id,
    exitCode: step.exitCode
  }));
  return {
    ok: !diagnostic && failedSteps.length === 0,
    releaseReady: !diagnostic && failedSteps.length === 0,
    diagnosticOnly: Boolean(diagnostic),
    failedSteps,
    stepCount: results.length
  };
}

export function runReleaseCandidate({
  cwd = process.cwd(),
  env = process.env,
  diagnostic = false,
  evidencePath = defaultEvidencePath,
  runner = runCandidateStepCommand,
  startedAt = nowIso()
} = {}) {
  const steps = releaseCandidateSteps({ diagnostic, evidencePath });
  const results = [];
  const redactionContext = { env, rootDir: cwd };

  for (const step of steps) {
    const stepStartedAt = nowIso();
    const startNs = process.hrtime.bigint();
    const result = runner(step, { cwd, env });
    const durationMs = Number((process.hrtime.bigint() - startNs) / 1000000n);
    const exitCode = typeof result.exitCode === "number" ? result.exitCode : 1;
    results.push({
      id: step.id,
      command: redactEvidenceText(commandLine(step.command, step.args), redactionContext),
      exitCode,
      startedAt: stepStartedAt,
      finishedAt: nowIso(),
      durationMs,
      stdout: trimOutput(redactEvidenceText(result.stdout, redactionContext)),
      stderr: trimOutput(redactEvidenceText(result.stderr, redactionContext)),
      spawnError: result.spawnError ? redactEvidenceText(result.spawnError, redactionContext) : null
    });
    if (exitCode !== 0 && step.continueAfterFailure !== true) break;
  }

  const finishedAt = nowIso();
  return {
    schemaVersion: 1,
    generatedAt: finishedAt,
    startedAt,
    finishedAt,
    mode: diagnostic ? "diagnostic" : "release",
    evidencePath: redactEvidenceText(evidencePath, redactionContext),
    steps: results,
    summary: summarizeCandidate({ diagnostic, results })
  };
}

export function writeCandidateReport(report, outputDir = defaultOutputDir) {
  const resolvedOutputDir = resolvePath(outputDir);
  ensurePrivateDir(resolvedOutputDir);
  const outputPath = join(resolvedOutputDir, `commercial-release-candidate-${slugTimestamp(report.generatedAt)}.json`);
  const latestPath = join(resolvedOutputDir, "latest-candidate.json");
  const payload = `${JSON.stringify(report, null, 2)}\n`;
  writePrivateTextFile(outputPath, payload);
  writePrivateTextFile(latestPath, payload);
  return { outputPath, latestPath };
}

export function parseReleaseCandidateArgs(argv = []) {
  const options = {
    diagnostic: argv.includes("--diagnostic"),
    evidencePath: defaultEvidencePath,
    outputDir: defaultOutputDir,
    json: argv.includes("--json"),
    write: !argv.includes("--stdout")
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--evidence") {
      options.evidencePath = argv[index + 1] || options.evidencePath;
      index += 1;
    } else if (arg === "--output") {
      options.outputDir = argv[index + 1] || options.outputDir;
      index += 1;
    } else if (!arg.startsWith("--")) {
      options.evidencePath = arg;
    }
  }
  return options;
}

async function main(argv = process.argv.slice(2)) {
  const options = parseReleaseCandidateArgs(argv);
  const report = runReleaseCandidate({
    diagnostic: options.diagnostic,
    evidencePath: options.evidencePath
  });
  const written = options.write
    ? writeCandidateReport(report, options.outputDir)
    : { outputPath: "", latestPath: "" };

  if (options.json) {
    console.log(JSON.stringify({
      ok: report.summary.ok,
      releaseReady: report.summary.releaseReady,
      diagnosticOnly: report.summary.diagnosticOnly,
      output: written.outputPath,
      latest: written.latestPath,
      summary: report.summary
    }, null, 2));
  } else if (report.summary.releaseReady) {
    console.log(`Commercial release candidate accepted: ${written.outputPath || "(stdout)"}`);
  } else {
    console.error(`Commercial release candidate blocked: ${written.outputPath || "(stdout)"}`);
    report.summary.failedSteps.forEach((step) => {
      console.error(`- ${step.id} exitCode=${step.exitCode}`);
    });
    if (report.summary.diagnosticOnly) {
      console.error("- diagnostic mode is not release acceptance evidence");
    }
  }

  process.exitCode = report.summary.ok ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main();
}
