import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildGithubReleasePlan,
  buildRunListArgs,
  buildRunWatchArgs,
  buildWorkflowRunArgs,
  parseGithubReleaseArgs,
  releaseEnvironmentSecretsForMode,
  runGithubReleaseOrchestration
} from "../../scripts/github-release-orchestrator.mjs";
import {
  requiredBackendRepositorySecrets,
  requiredReleaseEnvironmentSecrets
} from "../../scripts/configure-backend-server.mjs";

function tempRoot() {
  return mkdtempSync(join(tmpdir(), "oa-github-release-orchestrator-test-"));
}

function ok(stdout = "") {
  return { ok: true, status: 0, stdout, stderr: "", output: stdout };
}

function fail(output = "failed") {
  return { ok: false, status: 1, stdout: "", stderr: output, output };
}

function secretList(names) {
  return `${names.map((name) => `${name}\t2026-05-31T00:00:00Z`).join("\n")}\n`;
}

test("GitHub release orchestrator parser defaults to dry-run production release plan", () => {
  const options = parseGithubReleaseArgs(["--json"], {});

  assert.equal(options.repo, "17602842555/HR");
  assert.equal(options.branch, "main");
  assert.equal(options.environment, "production");
  assert.equal(options.backendMode, "native-worker");
  assert.equal(options.apply, false);
  assert.equal(options.wait, true);
  assert.equal(options.promoteEvidence, true);
});

test("GitHub release orchestrator parser validates identifiers", () => {
  assert.throws(
    () => parseGithubReleaseArgs(["--repo", "17602842555/HR;rm"]),
    /GitHub repository contains unsupported characters/
  );
  assert.throws(
    () => parseGithubReleaseArgs(["--environment", "../production"]),
    /environment name contains unsupported characters/
  );
});

test("GitHub release workflow commands require signoff drill and forced Cloudflare deploy", () => {
  assert.deepEqual(buildWorkflowRunArgs({
    branch: "main",
    inputs: { target_environment: "production" },
    repo: "17602842555/HR",
    workflow: "commercial-signoff.yml"
  }), [
    "workflow", "run", "commercial-signoff.yml",
    "--repo", "17602842555/HR",
    "--ref", "main",
    "-f", "target_environment=production"
  ]);

  assert.deepEqual(buildWorkflowRunArgs({
    branch: "main",
    inputs: { require_deploy: "true" },
    repo: "17602842555/HR",
    workflow: "cloudflare-deploy.yml"
  }), [
    "workflow", "run", "cloudflare-deploy.yml",
    "--repo", "17602842555/HR",
    "--ref", "main",
    "-f", "require_deploy=true"
  ]);

  assert.deepEqual(buildRunListArgs({
    branch: "main",
    repo: "17602842555/HR",
    workflow: "commercial-signoff.yml"
  }), [
    "run", "list",
    "--repo", "17602842555/HR",
    "--workflow", "commercial-signoff.yml",
    "--branch", "main",
    "--limit", "20",
    "--json", "databaseId,headSha,createdAt,status,conclusion,displayTitle,workflowName,url,event"
  ]);
  assert.deepEqual(buildRunWatchArgs({ repo: "17602842555/HR", runId: "12345" }), [
    "run", "watch", "12345", "--repo", "17602842555/HR", "--exit-status"
  ]);
});

test("GitHub release plan blocks missing repository and environment secrets", () => {
  const options = parseGithubReleaseArgs([], {});
  const plan = buildGithubReleasePlan({
    currentSha: "abc",
    environmentSecretNames: ["PRODUCTION_ENV_B64"],
    generatedAt: "2026-05-31T00:00:00.000Z",
    options,
    repositorySecretNames: ["CLOUDFLARE_ACCOUNT_ID"]
  });

  assert.equal(plan.ok, false);
  assert(plan.blockers.some((item) => item.includes("CLOUDFLARE_API_TOKEN")));
  assert.equal(plan.blockers.some((item) => item.includes("PRODUCTION_ENV_B64")), false);
  assert(plan.blockers.some((item) => item.includes("HR_DATA_SIGNOFF_B64")));
  assert.equal(plan.steps.find((step) => step.id === "cloudflare-deploy").command.includes("require_deploy=true"), true);
  assert.equal(plan.steps.some((step) => step.id === "commercial-drill"), false);
  assert.deepEqual(releaseEnvironmentSecretsForMode("native-worker"), [
    "PRODUCTION_SECRETS_SIGNOFF_B64",
    "HR_DATA_SIGNOFF_B64",
    "FILE_STORAGE_SIGNOFF_B64"
  ]);
});

test("GitHub release plan keeps production env and drill requirements for tunnel mode", () => {
  const options = parseGithubReleaseArgs(["--backend-mode", "tunnel"], {});
  const plan = buildGithubReleasePlan({
    currentSha: "abc",
    environmentSecretNames: [
      "PRODUCTION_SECRETS_SIGNOFF_B64",
      "HR_DATA_SIGNOFF_B64",
      "FILE_STORAGE_SIGNOFF_B64"
    ],
    generatedAt: "2026-05-31T00:00:00.000Z",
    options,
    repositorySecretNames: requiredBackendRepositorySecrets
  });

  assert.equal(plan.ok, false);
  assert(plan.blockers.some((item) => item.includes("PRODUCTION_ENV_B64")));
  assert.equal(plan.steps.some((step) => step.id === "commercial-drill"), true);
  assert.deepEqual(releaseEnvironmentSecretsForMode("tunnel"), requiredReleaseEnvironmentSecrets);
});

test("GitHub release dry-run writes a private manifest and does not trigger workflows", async () => {
  const root = tempRoot();
  const calls = [];
  try {
    const options = parseGithubReleaseArgs(["--output", "reports/release-test", "--json"], {});
    const commandRunner = (command, args) => {
      calls.push([command, ...args].join(" "));
      if (command === "git") return ok("abc123\n");
      if (command === "gh" && args[0] === "secret" && !args.includes("--env")) {
        return ok(secretList(requiredBackendRepositorySecrets));
      }
      if (command === "gh" && args[0] === "secret" && args.includes("--env")) {
        return ok(secretList(requiredReleaseEnvironmentSecrets));
      }
      throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
    };

    const report = await runGithubReleaseOrchestration(options, { commandRunner, rootDir: root });

    assert.equal(report.ok, true);
    assert.equal(report.apply, false);
    assert.equal(report.execution.skipped, true);
    assert.equal(calls.some((call) => call.includes("workflow run")), false);
    assert.equal(existsSync(join(root, "reports", "release-test", "latest-manifest.json")), true);
    assert.equal(statSync(join(root, "reports", "release-test", "latest-manifest.json")).mode & 0o777, 0o600);
    assert.equal(JSON.parse(readFileSync(join(root, "reports", "release-test", "latest-manifest.json"), "utf8")).currentSha, "abc123");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("GitHub release apply fails closed before workflow triggers when secrets are missing", async () => {
  const root = tempRoot();
  const calls = [];
  try {
    const options = parseGithubReleaseArgs(["--apply", "--output", "reports/release-test", "--json"], {});
    const commandRunner = (command, args) => {
      calls.push([command, ...args].join(" "));
      if (command === "git") return ok("abc123\n");
      if (command === "gh" && args[0] === "secret") return ok("");
      throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
    };

    const report = await runGithubReleaseOrchestration(options, { commandRunner, rootDir: root });

    assert.equal(report.ok, false);
    assert.equal(report.execution.skipped, true);
    assert.equal(report.execution.skipReason, "Release orchestration prerequisites are not complete.");
    assert.equal(calls.some((call) => call.includes("workflow run")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("GitHub release apply triggers native signoff and deploy without Docker drill", async () => {
  const root = tempRoot();
  const calls = [];
  try {
    const options = parseGithubReleaseArgs(["--apply", "--no-wait", "--output", "reports/release-test", "--json"], {});
    const commandRunner = (command, args) => {
      calls.push([command, ...args].join(" "));
      if (command === "git") return ok("abc123\n");
      if (command === "gh" && args[0] === "secret" && !args.includes("--env")) {
        return ok(secretList(requiredBackendRepositorySecrets));
      }
      if (command === "gh" && args[0] === "secret" && args.includes("--env")) {
        return ok(secretList(requiredReleaseEnvironmentSecrets));
      }
      if (command === "gh" && args[0] === "workflow" && args[1] === "run") return ok("");
      throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
    };

    const report = await runGithubReleaseOrchestration(options, { commandRunner, rootDir: root });

    assert.equal(report.ok, true);
    assert.equal(report.execution.results.length, 2);
    assert.equal(calls.some((call) => call.includes("commercial-signoff.yml")), true);
    assert.equal(calls.some((call) => call.includes("commercial-drill.yml")), false);
    assert.equal(calls.some((call) => call.includes("cloudflare-deploy.yml") && call.includes("require_deploy=true")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("GitHub release apply can trigger tunnel drill workflow without waiting", async () => {
  const root = tempRoot();
  const calls = [];
  try {
    const options = parseGithubReleaseArgs(["--backend-mode", "tunnel", "--apply", "--no-wait", "--output", "reports/release-test", "--json"], {});
    const commandRunner = (command, args) => {
      calls.push([command, ...args].join(" "));
      if (command === "git") return ok("abc123\n");
      if (command === "gh" && args[0] === "secret" && !args.includes("--env")) {
        return ok(secretList(requiredBackendRepositorySecrets));
      }
      if (command === "gh" && args[0] === "secret" && args.includes("--env")) {
        return ok(secretList(requiredReleaseEnvironmentSecrets));
      }
      if (command === "gh" && args[0] === "workflow" && args[1] === "run") return ok("");
      throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
    };

    const report = await runGithubReleaseOrchestration(options, { commandRunner, rootDir: root });

    assert.equal(report.ok, true);
    assert.equal(report.execution.results.length, 3);
    assert.equal(calls.some((call) => call.includes("commercial-drill.yml")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
