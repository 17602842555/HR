import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  buildReleaseDossier,
  parseReleaseDossierArgs,
  writeReleaseDossier
} from "../../scripts/commercial-release-dossier.mjs";

function evidence(overrides = {}) {
  return {
    schemaVersion: 1,
    generatedAt: "2026-05-30T00:00:00.000Z",
    knownGaps: [
      { id: "GAP-001", status: "Open", owner: "Deployment lead", targetDate: "2026-06-03" },
      { id: "GAP-002", status: "Open", owner: "DevOps lead", targetDate: "2026-06-05" },
      { id: "GAP-003", status: "Open", owner: "Security lead", targetDate: "2026-06-05" },
      { id: "GAP-004", status: "Open", owner: "Infrastructure lead", targetDate: "2026-06-07" },
      { id: "GAP-005", status: "Open", owner: "Product lead", targetDate: "2026-06-07" }
    ],
    artifacts: {
      migrations: ["20260529120000_init_commercial_oa", "20260530190000_finance_requests"]
    },
    checks: [
      { id: "preflight", required: true, exitCode: 0, command: "node scripts/commercial-preflight.mjs" },
      { id: "production-env", required: false, exitCode: 1, command: "npm run validate:production-env -- .env.production --json" },
      { id: "secrets-signoff", required: false, exitCode: 1, command: "npm run validate:secrets-signoff -- --json" },
      { id: "hr-signoff", required: false, exitCode: 1, command: "npm run validate:hr-signoff -- --json" },
      { id: "storage-signoff", required: false, exitCode: 1, command: "npm run validate:storage-signoff -- --json" },
      { id: "drill-evidence", required: false, exitCode: 66, command: "npm run validate:drill-evidence -- --json" },
      { id: "doctor", required: false, exitCode: 1, command: "node scripts/commercial-doctor.mjs --json" },
      { id: "db-generate", required: true, exitCode: 0, command: "npm run db:generate" },
      { id: "test-server", required: true, exitCode: 0, command: "npm run test:server" },
      { id: "build", required: true, exitCode: 0, command: "npm run build" }
    ],
    summary: {
      ok: true,
      requiredFailed: [],
      warningChecks: [
        { id: "production-env", exitCode: 1 },
        { id: "doctor", exitCode: 1 }
      ],
      openGaps: ["GAP-001", "GAP-002", "GAP-003", "GAP-004", "GAP-005"],
      readiness: {
        canRunDockerDrill: false,
        canReachPostgres: false,
        canVerifyDatabaseIntegrity: false,
        canRunApiSmoke: false,
        canRunFrontendApiSmoke: false,
        hardBlockers: [{ name: "docker", message: "Docker CLI missing" }],
        warnings: [{ name: "api-port", message: "API missing" }],
        nextSteps: ["Install/start Docker Desktop, then rerun npm run drill:commercial."]
      }
    },
    ...overrides
  };
}

test("commercial release dossier renders blockers next actions and artifact snapshot", () => {
  const dossier = buildReleaseDossier(evidence(), {
    evidencePath: "reports/commercial-evidence/latest.json",
    generatedAt: "2026-05-30T01:00:00.000Z",
    requireE2e: false
  });

  assert.equal(dossier.releaseReady, false);
  assert.equal(dossier.summary.openGapCount, 5);
  assert.equal(dossier.summary.releaseStatus, "DIAGNOSTIC_ONLY");
  assert.match(dossier.markdown, /Release status: DIAGNOSTIC_ONLY/);
  assert.match(dossier.markdown, /GAP-001/);
  assert.match(dossier.markdown, /diagnostic dossiers are not release acceptance evidence/);
  assert.match(dossier.markdown, /Fix evidence check `production-env` exitCode=1/);
  assert.match(dossier.markdown, /Install\/start Docker Desktop/);
  assert.match(dossier.markdown, /Latest migration: 20260530190000_finance_requests/);
});

test("commercial release dossier renders target profile so local CI evidence is not mistaken for production", () => {
  const report = evidence({
    targetProfile: {
      apiBaseUrl: "http://127.0.0.1:8788",
      appEnv: "ci",
      database: {
        configured: true,
        database: "oa_commercial",
        host: "127.0.0.1",
        isLocal: true,
        port: "55432"
      },
      evidenceClass: "local-or-ci-validation",
      e2eIncluded: true,
      nodeEnv: "test",
      productionEvidenceReady: false,
      productionRuntime: false,
      viteDemoFallback: "0",
      viteRequireApi: "1",
      warnings: ["DATABASE_URL points at a local PostgreSQL host; this is not production database evidence."]
    }
  });
  const dossier = buildReleaseDossier(report, {
    evidencePath: "reports/commercial-evidence/latest.json",
    generatedAt: "2026-05-30T01:00:00.000Z",
    requireE2e: false
  });

  assert.match(dossier.markdown, /## Target Profile/);
  assert.match(dossier.markdown, /evidenceClass: local-or-ci-validation/);
  assert.match(dossier.markdown, /databaseTarget: local-postgresql/);
  assert.match(dossier.markdown, /databaseIsLocal: yes/);
  assert.match(dossier.markdown, /profile warning count: 1/);
  assert.doesNotMatch(dossier.markdown, /127\.0\.0\.1|55432|8788|oa_commercial|not production database evidence/);
});

test("commercial release dossier can render an accepted release package", () => {
  const checks = evidence().checks.map((check) => ({ ...check, exitCode: 0 }));
  const report = evidence({
    knownGaps: evidence().knownGaps.map((gap) => ({ ...gap, status: "Closed" })),
    checks: [...checks, { id: "e2e", required: true, exitCode: 0, command: "npm run test:e2e" }],
    summary: {
      ok: true,
      requiredFailed: [],
      warningChecks: [],
      openGaps: [],
      readiness: {
        canRunDockerDrill: true,
        canReachPostgres: true,
        canVerifyDatabaseIntegrity: true,
        canRunApiSmoke: true,
        canRunFrontendApiSmoke: true,
        hardBlockers: [],
        warnings: [],
        nextSteps: []
      }
    }
  });

  const dossier = buildReleaseDossier(report, {
    evidencePath: "reports/commercial-evidence/latest.json",
    generatedAt: "2026-05-30T01:00:00.000Z"
  });

  assert.equal(dossier.releaseReady, true);
  assert.equal(dossier.summary.releaseStatus, "ACCEPTED");
  assert.match(dossier.markdown, /Release status: ACCEPTED/);
  assert.match(dossier.markdown, /No release blockers were detected/);
});

test("commercial release dossier never accepts diagnostic runs without e2e", () => {
  const checks = evidence().checks.map((check) => ({ ...check, exitCode: 0 }));
  const report = evidence({
    knownGaps: evidence().knownGaps.map((gap) => ({ ...gap, status: "Closed" })),
    checks,
    summary: {
      ok: true,
      requiredFailed: [],
      warningChecks: [],
      openGaps: [],
      readiness: {
        canRunDockerDrill: true,
        canReachPostgres: true,
        canVerifyDatabaseIntegrity: true,
        canRunApiSmoke: true,
        canRunFrontendApiSmoke: true,
        hardBlockers: [],
        warnings: [],
        nextSteps: []
      }
    }
  });

  const dossier = buildReleaseDossier(report, {
    evidencePath: "reports/commercial-evidence/latest.json",
    generatedAt: "2026-05-30T01:00:00.000Z",
    requireE2e: false
  });

  assert.equal(dossier.releaseReady, false);
  assert.equal(dossier.summary.releaseStatus, "DIAGNOSTIC_ONLY");
  assert.match(dossier.markdown, /Rerun without `--allow-missing-e2e`/);
});

test("commercial release dossier redacts local evidence paths", () => {
  const rootDir = "/tmp/oa-commercial-project";
  const dossier = buildReleaseDossier(evidence(), {
    evidencePath: `${rootDir}/reports/commercial-evidence/latest.json`,
    generatedAt: "2026-05-30T01:00:00.000Z",
    rootDir,
    requireE2e: false
  });

  assert.match(dossier.markdown, /Evidence file: \[PROJECT_ROOT\]\/reports\/commercial-evidence\/latest\.json/);
  assert.doesNotMatch(dossier.markdown, /\/tmp\/oa-commercial-project/);
});

test("commercial release dossier redacts target endpoints and secret command flags", () => {
  const rootDir = "/tmp/oa-commercial-project";
  const report = evidence({
    checks: [
      {
        id: "preflight",
        required: true,
        exitCode: 0,
        command: `${rootDir}/scripts/commercial-preflight.mjs --secret=plain-secret --token top-secret-token`
      }
    ],
    targetProfile: {
      apiBaseUrl: "https://oa.example.internal",
      appEnv: "production",
      database: {
        configured: true,
        database: "oa_prod",
        host: "postgres.internal",
        isLocal: false,
        port: "5432"
      },
      evidenceClass: "production-release-evidence",
      e2eIncluded: true,
      nodeEnv: "production",
      productionEvidenceReady: true,
      productionRuntime: true,
      viteDemoFallback: "0",
      viteRequireApi: "1",
      warnings: ["production target details are private"]
    }
  });
  const dossier = buildReleaseDossier(report, {
    evidencePath: `${rootDir}/reports/commercial-evidence/latest.json`,
    generatedAt: "2026-05-30T01:00:00.000Z",
    rootDir,
    requireE2e: false
  });

  assert.match(dossier.markdown, /databaseTarget: non-local-postgresql/);
  assert.match(dossier.markdown, /API base URL configured: yes/);
  assert.match(dossier.markdown, /--secret=\[REDACTED\]/);
  assert.match(dossier.markdown, /--token \[REDACTED\]/);
  assert.doesNotMatch(
    dossier.markdown,
    /\/tmp\/oa-commercial-project|postgres\.internal|oa_prod|oa\.example\.internal|plain-secret|top-secret-token/
  );
});

test("commercial release dossier writes timestamped and latest markdown files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "oa-commercial-dossier-"));
  try {
    const dossier = buildReleaseDossier(evidence(), {
      evidencePath: "reports/commercial-evidence/latest.json",
      generatedAt: "2026-05-30T01:00:00.000Z",
      requireE2e: false
    });
    const written = writeReleaseDossier(dossier.markdown, {
      outputDir: dir,
      generatedAt: "2026-05-30T01:00:00.000Z"
    });

    assert.equal(basename(written.outputPath), "commercial-release-dossier-20260530T010000Z.md");
    assert.equal(basename(written.latestPath), "latest-dossier.md");
    assert.equal((await stat(dir)).mode & 0o777, 0o700);
    assert.equal((await stat(written.outputPath)).mode & 0o777, 0o600);
    assert.equal((await stat(written.latestPath)).mode & 0o777, 0o600);
    assert.match(await readFile(written.outputPath, "utf8"), /Commercial Release Dossier/);
    assert.match(await readFile(written.latestPath, "utf8"), /Release status: DIAGNOSTIC_ONLY/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("commercial release dossier parses evidence output json and diagnostic flags", () => {
  const parsed = parseReleaseDossierArgs([
    "--evidence",
    "reports/evidence.json",
    "--output",
    "reports/out",
    "--allow-missing-e2e",
    "--stdout",
    "--json"
  ]);

  assert.equal(parsed.evidencePath, "reports/evidence.json");
  assert.equal(parsed.outputDir, "reports/out");
  assert.equal(parsed.requireE2e, false);
  assert.equal(parsed.write, false);
  assert.equal(parsed.json, true);
});
