import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildCommercialReleaseStatus,
  buildGhRunListArgs,
  buildGhRunViewArgs,
  parseReleaseStatusArgs,
  summarizeCloudflareDeploy
} from "../../scripts/commercial-release-status.mjs";
import {
  requiredBackendRepositorySecrets,
  requiredReleaseEnvironmentSecrets
} from "../../scripts/configure-backend-server.mjs";

function tempRoot() {
  return mkdtempSync(join(tmpdir(), "oa-commercial-release-status-test-"));
}

function ok(stdout = "") {
  return { ok: true, status: 0, stdout, stderr: "", output: stdout };
}

function secretList(names) {
  return `${names.map((name) => `${name}\t2026-05-31T00:00:00Z`).join("\n")}\n`;
}

function runList(currentSha = "abc123") {
  return JSON.stringify([
    {
      conclusion: "success",
      createdAt: "2026-05-31T00:00:00Z",
      databaseId: 1001,
      event: "push",
      headSha: currentSha,
      status: "completed",
      url: "https://github.com/acme/hr/actions/runs/1001",
      workflowName: "commercial-ci"
    },
    {
      conclusion: "success",
      createdAt: "2026-05-31T00:01:00Z",
      databaseId: 1002,
      event: "push",
      headSha: currentSha,
      status: "completed",
      url: "https://github.com/acme/hr/actions/runs/1002",
      workflowName: "Deploy HR OA to Cloudflare"
    }
  ]);
}

function deployView({ deployConclusion = "skipped", smokeConclusion = "skipped" } = {}) {
  return JSON.stringify({
    conclusion: "success",
    databaseId: 1002,
    headSha: "abc123",
    jobs: [
      {
        name: "deploy",
        steps: [
          { conclusion: "success", name: "Verify frontend build" },
          { conclusion: deployConclusion, name: "Deploy Worker with assets and API origin secret" },
          { conclusion: smokeConclusion, name: "Smoke deployed backend gateway" },
          { conclusion: deployConclusion === "skipped" ? "success" : "skipped", name: "Cloudflare secrets not configured" }
        ]
      }
    ],
    status: "completed",
    url: "https://github.com/acme/hr/actions/runs/1002"
  });
}

function releaseGatePayload({ okValue = false } = {}) {
  return JSON.stringify({
    ok: okValue,
    failures: okValue ? [] : ["Release gap remains open: GAP-003 (Security lead)."],
    warnings: [],
    summary: {
      evidenceAgeHours: 1,
      evidenceMode: "full",
      openGapCount: okValue ? 0 : 3,
      targetProfile: {
        evidenceClass: okValue ? "production-release-evidence" : "local-or-ci-validation",
        productionRuntime: okValue,
        productionEvidenceReady: okValue
      }
    }
  });
}

test("commercial release status parser defaults to production repository status", () => {
  const options = parseReleaseStatusArgs(["--json"], {});

  assert.equal(options.repo, "17602842555/HR");
  assert.equal(options.branch, "main");
  assert.equal(options.environment, "production");
  assert.equal(options.json, true);
});

test("commercial release status parser validates identifiers", () => {
  assert.throws(
    () => parseReleaseStatusArgs(["--repo", "17602842555/HR;rm"]),
    /GitHub repository contains unsupported characters/
  );
  assert.throws(
    () => parseReleaseStatusArgs(["--environment", "../production"]),
    /environment name contains unsupported characters/
  );
});

test("commercial release status GitHub command builders use repo branch and run id", () => {
  assert.deepEqual(buildGhRunListArgs({
    branch: "main",
    repo: "17602842555/HR",
    runLimit: 8
  }), [
    "run", "list",
    "--repo", "17602842555/HR",
    "--branch", "main",
    "--limit", "8",
    "--json", "databaseId,headSha,createdAt,status,conclusion,displayTitle,workflowName,url,event"
  ]);
  assert.deepEqual(buildGhRunViewArgs({ repo: "17602842555/HR", runId: "1002" }), [
    "run", "view", "1002",
    "--repo", "17602842555/HR",
    "--json", "databaseId,headSha,status,conclusion,url,jobs"
  ]);
});

test("commercial release status summarizes Cloudflare actual deployment versus build-only", () => {
  assert.deepEqual(summarizeCloudflareDeploy(JSON.parse(deployView())), {
    actualDeployment: false,
    apiOriginMissing: false,
    buildSucceeded: true,
    deployConclusion: "skipped",
    missingSecretsNotice: true,
    smokeConclusion: "skipped",
    smokePassed: false,
    workerDeployStepPresent: true
  });
  assert.equal(summarizeCloudflareDeploy(JSON.parse(deployView({
    deployConclusion: "success",
    smokeConclusion: "success"
  }))).actualDeployment, true);
});

test("commercial release status blocks missing secrets release gate and build-only Cloudflare", async () => {
  const root = tempRoot();
  try {
    const options = parseReleaseStatusArgs(["--output", "reports/status-test", "--json"], {});
    const commandRunner = (command, args) => {
      if (command === "git") return ok("abc123\n");
      if (command === "gh" && args[0] === "secret" && !args.includes("--env")) return ok(secretList(["CLOUDFLARE_ACCOUNT_ID"]));
      if (command === "gh" && args[0] === "secret" && args.includes("--env")) return ok("");
      if (command === "npm" && args.includes("release:gate")) return ok(releaseGatePayload({ okValue: false }));
      if (command === "gh" && args[0] === "run" && args[1] === "list") return ok(runList());
      if (command === "gh" && args[0] === "run" && args[1] === "view") return ok(deployView());
      throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
    };

    const status = await buildCommercialReleaseStatus(options, { commandRunner, rootDir: root });

    assert.equal(status.ok, false);
    assert(status.blockers.some((item) => item.includes("CLOUDFLARE_API_TOKEN")));
    assert(status.blockers.includes("Release gate is not accepted."));
    assert(status.blockers.includes("Cloudflare Worker has not been deployed for the current SHA."));
    assert.equal(status.github.cloudflareDeploy.actualDeployment, false);
    assert.equal(existsSync(join(root, "reports", "status-test", "latest-status.json")), true);
    assert.equal(statSync(join(root, "reports", "status-test", "latest-status.json")).mode & 0o777, 0o600);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("commercial release status passes only with green secrets gate CI deploy and smoke", async () => {
  const root = tempRoot();
  try {
    const options = parseReleaseStatusArgs(["--output", "reports/status-test", "--json"], {});
    const commandRunner = (command, args) => {
      if (command === "git") return ok("abc123\n");
      if (command === "gh" && args[0] === "secret" && !args.includes("--env")) return ok(secretList(requiredBackendRepositorySecrets));
      if (command === "gh" && args[0] === "secret" && args.includes("--env")) return ok(secretList(requiredReleaseEnvironmentSecrets));
      if (command === "npm" && args.includes("release:gate")) return ok(releaseGatePayload({ okValue: true }));
      if (command === "gh" && args[0] === "run" && args[1] === "list") return ok(runList());
      if (command === "gh" && args[0] === "run" && args[1] === "view") {
        return ok(deployView({ deployConclusion: "success", smokeConclusion: "success" }));
      }
      throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
    };

    const status = await buildCommercialReleaseStatus(options, { commandRunner, rootDir: root });

    assert.equal(status.ok, true);
    assert.equal(status.blockers.length, 0);
    assert.equal(status.releaseGate.ok, true);
    assert.equal(status.github.cloudflareDeploy.smokePassed, true);
    assert.equal(JSON.parse(readFileSync(join(root, "reports", "status-test", "latest-status.json"), "utf8")).ok, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
