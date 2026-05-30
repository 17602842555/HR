import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  parseReleaseCandidateArgs,
  releaseCandidateSteps,
  runCandidateStepCommand,
  runReleaseCandidate,
  summarizeCandidate,
  writeCandidateReport
} from "../../scripts/commercial-release-candidate.mjs";

test("commercial release candidate default steps require e2e strict readiness and release gate", () => {
  const steps = releaseCandidateSteps();

  assert.deepEqual(steps.map((step) => step.id), ["evidence", "readiness-audit", "release-dossier", "release-gate"]);
  assert.deepEqual(steps[0].args, ["run", "evidence:commercial", "--", "--full", "--e2e", "--strict-readiness"]);
  assert.equal(steps[1].args.includes("--allow-missing-e2e"), false);
  assert.equal(steps[2].args.includes("--allow-missing-e2e"), false);
  assert.equal(steps[3].args.includes("--allow-missing-e2e"), false);
});

test("commercial release candidate diagnostic steps cannot be confused with release evidence", () => {
  const steps = releaseCandidateSteps({ diagnostic: true, evidencePath: "reports/diagnostic.json" });

  assert.deepEqual(steps[0].args, ["run", "evidence:commercial", "--", "--full"]);
  assert(steps[1].args.includes("--allow-missing-e2e"));
  assert(steps[2].args.includes("--allow-missing-e2e"));
  assert(steps[3].args.includes("--allow-missing-e2e"));
  assert(steps.slice(1).every((step) => step.args.includes("reports/diagnostic.json")));
});

test("commercial release candidate passes only when all release steps pass", () => {
  const report = runReleaseCandidate({
    startedAt: "2026-05-30T00:00:00.000Z",
    runner: () => ({ exitCode: 0, stdout: "{\"ok\":true}", stderr: "" })
  });

  assert.equal(report.mode, "release");
  assert.equal(report.summary.ok, true);
  assert.equal(report.summary.releaseReady, true);
  assert.equal(report.steps.length, 4);
});

test("commercial release candidate records every step after failures for handoff", () => {
  const report = runReleaseCandidate({
    runner: (step) => ({
      exitCode: step.id === "evidence" ? 1 : 0,
      stdout: `${step.id} stdout`,
      stderr: `${step.id} stderr`
    })
  });

  assert.equal(report.summary.ok, false);
  assert.deepEqual(report.summary.failedSteps, [{ id: "evidence", exitCode: 1 }]);
  assert.deepEqual(report.steps.map((step) => step.id), ["evidence", "readiness-audit", "release-dossier", "release-gate"]);
  assert.match(report.steps[0].stderr, /evidence stderr/);
});

test("commercial release candidate redacts local paths and secrets from archived step output", () => {
  const cwd = "/tmp/oa-commercial-project";
  const env = {
    JWT_SECRET: "candidate-jwt-secret-value-20260530",
    DATABASE_URL: "postgresql://oa:candidate-db-secret@127.0.0.1:5432/oa_commercial?schema=public"
  };
  const report = runReleaseCandidate({
    cwd,
    env,
    evidencePath: `${cwd}/reports/commercial-evidence/latest.json`,
    startedAt: "2026-05-30T00:00:00.000Z",
    runner: (step) => ({
      exitCode: step.id === "release-gate" ? 1 : 0,
      stdout: `${step.id} wrote ${cwd}/reports/commercial-evidence/latest.json JWT_SECRET=candidate-jwt-secret-value-20260530`,
      stderr: `${step.id} error at ${cwd}/server/src/index.mjs DATABASE_URL=postgresql://oa:candidate-db-secret@127.0.0.1:5432/oa_commercial?schema=public`,
      spawnError: `ENOENT: ${cwd}/bin/tool candidate-db-secret`
    })
  });
  const serialized = JSON.stringify(report);

  assert.equal(report.evidencePath, "[PROJECT_ROOT]/reports/commercial-evidence/latest.json");
  assert.match(report.steps[1].command, /\[PROJECT_ROOT\]\/reports\/commercial-evidence\/latest\.json/);
  assert.match(serialized, /\[PROJECT_ROOT\]\/reports\/commercial-evidence\/latest\.json/);
  assert.doesNotMatch(serialized, /\/tmp\/oa-commercial-project/);
  assert.doesNotMatch(serialized, /candidate-jwt-secret-value-20260530|candidate-db-secret/);
  assert.match(serialized, /\[REDACTED\]|\*\*\*/);
});

test("commercial release candidate step runner captures large command output without buffer failure", () => {
  const result = runCandidateStepCommand({
    command: process.execPath,
    args: ["-e", "process.stdout.write('x'.repeat(1200000))"]
  }, {
    env: {
      ...process.env,
      COMMERCIAL_RELEASE_CANDIDATE_MAX_BUFFER_BYTES: String(2 * 1024 * 1024)
    }
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.spawnError, null);
  assert.equal(result.stdout.length, 1200000);
});

test("commercial release candidate step runner records spawn errors", () => {
  const result = runCandidateStepCommand({
    command: "oa-commercial-candidate-command-that-does-not-exist",
    args: []
  });

  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /ENOENT|spawnSync/);
  assert.match(result.spawnError, /ENOENT|spawnSync/);
});

test("commercial release candidate diagnostic mode always fails closed", () => {
  const report = runReleaseCandidate({
    diagnostic: true,
    runner: () => ({ exitCode: 0, stdout: "", stderr: "" })
  });

  assert.equal(report.mode, "diagnostic");
  assert.equal(report.summary.ok, false);
  assert.equal(report.summary.releaseReady, false);
  assert.equal(report.summary.diagnosticOnly, true);
});

test("commercial release candidate summary blocks failed steps", () => {
  const summary = summarizeCandidate({
    results: [
      { id: "evidence", exitCode: 0 },
      { id: "release-gate", exitCode: 1 }
    ]
  });

  assert.equal(summary.ok, false);
  assert.deepEqual(summary.failedSteps, [{ id: "release-gate", exitCode: 1 }]);
});

test("commercial release candidate writes timestamped and latest reports", async () => {
  const dir = await mkdtemp(join(tmpdir(), "oa-commercial-candidate-"));
  try {
    const report = runReleaseCandidate({
      startedAt: "2026-05-30T00:00:00.000Z",
      runner: () => ({ exitCode: 0, stdout: "", stderr: "" })
    });
    const written = writeCandidateReport({
      ...report,
      generatedAt: "2026-05-30T01:02:03.000Z"
    }, dir);

    assert.equal(basename(written.outputPath), "commercial-release-candidate-20260530T010203Z.json");
    assert.equal(basename(written.latestPath), "latest-candidate.json");
    assert.equal((await stat(dir)).mode & 0o777, 0o700);
    assert.equal((await stat(written.outputPath)).mode & 0o777, 0o600);
    assert.equal((await stat(written.latestPath)).mode & 0o777, 0o600);
    assert.equal(JSON.parse(await readFile(written.latestPath, "utf8")).summary.releaseReady, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("commercial release candidate parses flags", () => {
  const parsed = parseReleaseCandidateArgs([
    "--diagnostic",
    "--evidence",
    "reports/evidence.json",
    "--output",
    "reports/out",
    "--stdout",
    "--json"
  ]);

  assert.equal(parsed.diagnostic, true);
  assert.equal(parsed.evidencePath, "reports/evidence.json");
  assert.equal(parsed.outputDir, "reports/out");
  assert.equal(parsed.write, false);
  assert.equal(parsed.json, true);
});
