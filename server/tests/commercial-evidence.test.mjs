import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import {
  buildEvidenceReport,
  buildEvidenceCliResult,
  buildTargetProfile,
  collectArtifacts,
  extractJsonObject,
  parseEvidenceArgs,
  parseKnownGapRegister,
  redactEvidenceText,
  resolveCommercialEvidencePath,
  runCheck,
  runGapReportCheck,
  selectedEvidenceChecks,
  strictReadinessFailedForReport,
  summarizeEvidence,
  writeEvidenceReport,
  writeCommercialEvidence
} from "../../scripts/commercial-evidence.mjs";

test("commercial evidence parser reads known gap rows", () => {
  const markdown = `
| ID | Status | Owner | Target Date | Gap | Exit Criteria |
| --- | --- | --- | --- | --- | --- |
| GAP-001 | Open | Deployment lead | 2026-06-03 | PostgreSQL is not reachable in local evidence run. | Target PostgreSQL smoke evidence is archived. |
| GAP-002 | Closed | DevOps lead | 2026-06-05 | Docker drill evidence was missing. | Drill output and restore logs are archived. |
`;
  const gaps = parseKnownGapRegister(markdown);

  assert.equal(gaps.length, 2);
  assert.equal(gaps[0].id, "GAP-001");
  assert.equal(gaps[0].status, "Open");
  assert.equal(gaps[1].status, "Closed");
});

test("commercial evidence extracts JSON from command output wrappers", () => {
  const parsed = extractJsonObject("prefix\n{\"ok\":true,\"checks\":[1]}\nsuffix");

  assert.deepEqual(parsed, { ok: true, checks: [1] });
});

test("commercial evidence selects heavy and e2e checks from flags", () => {
  const quickOptions = parseEvidenceArgs(["--quick"]);
  const fullOptions = parseEvidenceArgs(["--full", "--e2e"]);
  const quick = selectedEvidenceChecks(quickOptions).map((check) => check.id);
  const fullWithE2e = selectedEvidenceChecks(fullOptions).map((check) => check.id);

  assert.equal(quickOptions.evidenceMode, "quick");
  assert.equal(fullOptions.evidenceMode, "full");
  assert.equal(quick.includes("test-server"), false);
  assert.equal(quick.includes("build"), false);
  assert.equal(quick.includes("production-env"), true);
  assert.equal(quick.includes("migrations"), true);
  assert.equal(quick.includes("supply-chain"), true);
  assert.equal(quick.includes("sbom"), true);
  assert.equal(quick.includes("hr-review-prep"), true);
  assert.equal(quick.includes("cloudflare-backend"), true);
  assert.equal(quick.includes("cloudflare-deployment"), true);
  assert.equal(quick.includes("no-domain-public"), true);
  assert.equal(quick.includes("secrets-signoff"), true);
  assert.equal(quick.includes("hr-signoff"), true);
  assert.equal(quick.includes("storage-signoff"), true);
  assert.equal(quick.includes("drill-evidence"), true);
  assert.equal(quick.includes("local-recovery-evidence"), true);
  assert.equal(quick.includes("doctor"), true);
  assert.equal(fullWithE2e.includes("production-env"), true);
  assert.equal(fullWithE2e.includes("migrations"), true);
  assert.equal(fullWithE2e.includes("supply-chain"), true);
  assert.equal(fullWithE2e.includes("sbom"), true);
  assert.equal(fullWithE2e.includes("hr-review-prep"), true);
  assert.equal(fullWithE2e.includes("cloudflare-backend"), true);
  assert.equal(fullWithE2e.includes("cloudflare-deployment"), true);
  assert.equal(fullWithE2e.includes("no-domain-public"), true);
  assert.equal(fullWithE2e.includes("secrets-signoff"), true);
  assert.equal(fullWithE2e.includes("hr-signoff"), true);
  assert.equal(fullWithE2e.includes("storage-signoff"), true);
  assert.equal(fullWithE2e.includes("drill-evidence"), true);
  assert.equal(fullWithE2e.includes("local-recovery-evidence"), true);
  assert.equal(fullWithE2e.includes("test-server"), true);
  assert.equal(fullWithE2e.includes("build"), true);
  assert.equal(fullWithE2e.includes("e2e"), true);
});

test("commercial evidence summary keeps doctor blockers visible without failing required gates", () => {
  const report = buildEvidenceReport({
    artifacts: { migrations: [], files: {} },
    checks: [
      { id: "preflight", required: true, exitCode: 0 },
      { id: "migrations", required: true, exitCode: 0 },
      { id: "supply-chain", required: true, exitCode: 0 },
      { id: "sbom", required: true, exitCode: 0 },
      { id: "hr-review-prep", required: true, exitCode: 0 },
      { id: "production-env", required: false, exitCode: 1 },
      { id: "cloudflare-backend", required: false, exitCode: 1 },
      { id: "cloudflare-deployment", required: false, exitCode: 1 },
      { id: "no-domain-public", required: false, exitCode: 1 },
      { id: "secrets-signoff", required: false, exitCode: 1 },
      { id: "hr-signoff", required: false, exitCode: 1 },
      { id: "storage-signoff", required: false, exitCode: 1 },
      { id: "drill-evidence", required: false, exitCode: 1 },
      { id: "local-recovery-evidence", required: false, diagnostic: true, exitCode: 66 },
      {
        id: "doctor",
        required: false,
        exitCode: 1,
        parsedJson: {
          readiness: {
            canRunDockerDrill: false,
            canReachPostgres: false,
            canVerifyDatabaseIntegrity: false,
            hardBlockers: [{ name: "docker", message: "Docker missing" }]
          }
        }
      }
    ],
    commandLine: "node scripts/commercial-evidence.mjs --quick",
    knownGaps: [
      { id: "GAP-001", status: "Open" },
      { id: "GAP-002", status: "Closed" }
    ],
    rootDir: "/tmp/project",
    startedAt: "2026-05-30T00:00:00.000Z",
    finishedAt: "2026-05-30T00:00:01.000Z"
  });

  assert.equal(report.evidenceMode, "quick");
  assert.equal(report.summary.evidenceMode, "quick");
  assert.equal(report.summary.ok, true);
  assert.equal(report.summary.releaseCandidateReady, false);
  assert.equal(report.summary.e2eIncluded, false);
  assert(report.summary.releaseBlockers.some((blocker) => blocker.includes("Evidence mode must be full")));
  assert(report.summary.releaseBlockers.some((blocker) => blocker.includes("E2E evidence is missing")));
  assert(report.summary.releaseBlockers.some((blocker) => blocker.includes("canRunDockerDrill")));
  assert.deepEqual(report.summary.warningChecks.map((check) => check.id), ["production-env", "cloudflare-backend", "cloudflare-deployment", "no-domain-public", "secrets-signoff", "hr-signoff", "storage-signoff", "drill-evidence", "doctor"]);
  assert.deepEqual(report.summary.diagnosticChecks, [{ id: "local-recovery-evidence", exitCode: 66 }]);
  assert.equal(report.summary.openGapCount, 1);
  assert.equal(report.summary.readiness.canRunDockerDrill, false);
});

test("commercial evidence target profile distinguishes local CI from production release evidence", () => {
  const env = {
    API_BASE_URL: "http://127.0.0.1:8788",
    APP_ENV: "ci",
    DATABASE_URL: "postgresql://oa:local-db-password@127.0.0.1:55432/oa_commercial?schema=public",
    NODE_ENV: "test",
    VITE_DEMO_FALLBACK: "0",
    VITE_REQUIRE_API: "1"
  };
  const checks = [
    { id: "production-env", exitCode: 1 },
    { id: "cloudflare-backend", exitCode: 1 },
    { id: "secrets-signoff", exitCode: 1 },
    { id: "storage-signoff", exitCode: 1 },
    { id: "hr-signoff", exitCode: 1 },
    { id: "drill-evidence", exitCode: 66 },
    { id: "e2e", exitCode: 0 }
  ];
  const profile = buildTargetProfile({ checks, env, rootDir: "/tmp/project" });

  assert.equal(profile.evidenceClass, "local-or-ci-validation");
  assert.equal(profile.database.host, "127.0.0.1");
  assert.equal(profile.database.isLocal, true);
  assert.equal(profile.e2eIncluded, true);
  assert.equal(profile.productionEvidenceReady, false);
  assert(profile.warnings.some((warning) => warning.includes("local PostgreSQL")));
  assert.doesNotMatch(JSON.stringify(profile), /local-db-password/);
});

test("commercial evidence target profile reads project-local PostgreSQL env when DATABASE_URL is unset", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "oa-commercial-target-profile-"));
  try {
    await mkdir(join(rootDir, ".local-postgres"), { recursive: true });
    await writeFile(
      join(rootDir, ".local-postgres", ".env.local-postgres"),
      [
        "# Local development only",
        "DATABASE_URL=\"postgresql://oa:local-db-password@127.0.0.1:55432/oa_commercial?schema=public\"",
        "API_BASE_URL=\"http://127.0.0.1:8787\"",
        "VITE_REQUIRE_API=\"1\"",
        "VITE_DEMO_FALLBACK=\"0\"",
        ""
      ].join("\n")
    );

    const profile = buildTargetProfile({
      checks: [
        { id: "production-env", exitCode: 1 },
        { id: "cloudflare-backend", exitCode: 1 },
        { id: "secrets-signoff", exitCode: 1 },
        { id: "storage-signoff", exitCode: 1 },
        { id: "hr-signoff", exitCode: 1 },
        { id: "drill-evidence", exitCode: 66 }
      ],
      env: {
        APP_ENV: "development",
        VITE_DEMO_FALLBACK: "0",
        VITE_REQUIRE_API: "1"
      },
      rootDir
    });

    assert.equal(profile.evidenceClass, "local-or-ci-validation");
    assert.equal(profile.database.configured, true);
    assert.equal(profile.database.host, "127.0.0.1");
    assert.equal(profile.database.port, "55432");
    assert.equal(profile.database.source, "local-postgres-env");
    assert.equal(profile.database.isLocal, true);
    assert.equal(profile.apiBaseUrl, "http://127.0.0.1:8787");
    assert.equal(profile.viteRequireApi, "1");
    assert.equal(profile.viteDemoFallback, "0");
    assert(profile.warnings.some((warning) => warning.includes("local PostgreSQL")));
    assert.doesNotMatch(JSON.stringify(profile), /local-db-password/);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("commercial evidence target profile marks production release evidence only when signoff checks are green", () => {
  const env = {
    APP_ENV: "production",
    DATABASE_URL: "postgresql://oa:prod-db-password@db.internal.example:5432/oa_commercial?schema=public",
    NODE_ENV: "production",
    VITE_DEMO_FALLBACK: "0",
    VITE_REQUIRE_API: "1"
  };
  const checks = [
    { id: "production-env", exitCode: 0 },
    { id: "cloudflare-backend", exitCode: 0 },
    { id: "secrets-signoff", exitCode: 0 },
    { id: "storage-signoff", exitCode: 0 },
    { id: "hr-signoff", exitCode: 0 },
    { id: "drill-evidence", exitCode: 0 }
  ];
  const profile = buildTargetProfile({ checks, env, rootDir: "/tmp/project" });

  assert.equal(profile.evidenceClass, "production-release-evidence");
  assert.equal(profile.database.isLocal, false);
  assert.equal(profile.productionEvidenceReady, true);
  assert.deepEqual(profile.warnings, []);
  assert.doesNotMatch(JSON.stringify(profile), /prod-db-password/);
});

test("commercial evidence target profile accepts native Worker D1 as production persistence", () => {
  const checks = [
    {
      id: "cloudflare-deployment",
      exitCode: 0,
      parsedJson: {
        deploymentMode: "native-worker",
        summary: {
          d1PersistenceReady: true,
          nativeWorkerReady: true
        }
      }
    },
    {
      id: "no-domain-public",
      exitCode: 0,
      parsedJson: {
        ok: true,
        checks: [
          { name: "worker-health", level: "pass" },
          { name: "worker-d1", level: "pass" },
          { name: "worker-cors", level: "pass" }
        ]
      }
    },
    { id: "secrets-signoff", exitCode: 0 },
    { id: "storage-signoff", exitCode: 0 },
    { id: "hr-signoff", exitCode: 0 },
    { id: "drill-evidence", exitCode: 0 }
  ];
  const profile = buildTargetProfile({
    checks,
    env: {
      APP_ENV: "production",
      NODE_ENV: "production",
      VITE_DEMO_FALLBACK: "0",
      VITE_REQUIRE_API: "1"
    },
    rootDir: "/tmp/project"
  });

  assert.equal(profile.backendMode, "native-worker");
  assert.equal(profile.database.target, "cloudflare-d1");
  assert.equal(profile.database.d1Configured, true);
  assert.equal(profile.productionEvidenceReady, true);
  assert.equal(profile.evidenceClass, "production-release-evidence");
});

test("commercial evidence native Worker release is not blocked by Fastify env doctor or Docker drill", () => {
  const checks = [
    { id: "preflight", required: true, exitCode: 0 },
    { id: "migrations", required: true, exitCode: 0 },
    { id: "supply-chain", required: true, exitCode: 0 },
    { id: "sbom", required: true, exitCode: 0 },
    { id: "brand", required: true, exitCode: 0 },
    { id: "contract", required: true, exitCode: 0 },
    { id: "hr-review-prep", required: true, exitCode: 0 },
    { id: "production-env", required: false, exitCode: 1 },
    { id: "cloudflare-backend", required: false, exitCode: 1 },
    {
      id: "cloudflare-deployment",
      required: false,
      exitCode: 0,
      parsedJson: {
        deploymentMode: "native-worker",
        summary: {
          d1PersistenceReady: true,
          nativeWorkerReady: true
        }
      }
    },
    {
      id: "no-domain-public",
      required: false,
      exitCode: 0,
      parsedJson: {
        ok: true,
        checks: [
          { name: "worker-health", level: "pass" },
          { name: "worker-d1", level: "pass" },
          { name: "worker-cors", level: "pass" }
        ]
      }
    },
    { id: "secrets-signoff", required: false, exitCode: 0 },
    { id: "hr-signoff", required: false, exitCode: 0 },
    { id: "storage-signoff", required: false, exitCode: 0 },
    { id: "drill-evidence", required: false, exitCode: 66 },
    {
      id: "doctor",
      required: false,
      exitCode: 1,
      parsedJson: {
        readiness: {
          canRunDockerDrill: false,
          canReachPostgres: false,
          canVerifyDatabaseIntegrity: false,
          canRunApiSmoke: false,
          canRunFrontendApiSmoke: false,
          hardBlockers: [{ name: "docker" }]
        }
      }
    },
    { id: "db-generate", required: true, exitCode: 0 },
    { id: "test-server", required: true, exitCode: 0 },
    { id: "build", required: true, exitCode: 0 },
    { id: "e2e", required: true, exitCode: 0 }
  ];
  const report = buildEvidenceReport({
    artifacts: { migrations: [], files: {} },
    checks,
    commandLine: "node scripts/commercial-evidence.mjs --full --e2e --strict-readiness",
    env: {
      APP_ENV: "production",
      CLOUDFLARE_BACKEND_MODE: "native-worker",
      NODE_ENV: "production",
      VITE_DEMO_FALLBACK: "0",
      VITE_REQUIRE_API: "1"
    },
    knownGaps: [
      { id: "GAP-001", status: "Closed" },
      { id: "GAP-002", status: "Mitigated" },
      { id: "GAP-003", status: "Closed" },
      { id: "GAP-004", status: "Closed" },
      { id: "GAP-005", status: "Closed" }
    ],
    rootDir: "/tmp/project",
    startedAt: "2026-05-30T00:00:00.000Z",
    finishedAt: "2026-05-30T00:00:01.000Z"
  });

  assert.equal(report.targetProfile.backendMode, "native-worker");
  assert.equal(report.summary.releaseCandidateReady, true);
  assert.equal(strictReadinessFailedForReport(report), false);
  assert.equal(report.summary.warningChecks.some((check) => check.id === "drill-evidence"), true);
  assert.deepEqual(report.summary.releaseBlockers, []);
});

test("commercial evidence summary marks release candidate ready only for full production e2e evidence", () => {
  const checks = [
    { id: "preflight", required: true, exitCode: 0 },
    { id: "migrations", required: true, exitCode: 0 },
    { id: "supply-chain", required: true, exitCode: 0 },
    { id: "sbom", required: true, exitCode: 0 },
    { id: "brand", required: true, exitCode: 0 },
    { id: "contract", required: true, exitCode: 0 },
      { id: "hr-review-prep", required: true, exitCode: 0 },
      { id: "production-env", required: false, exitCode: 0 },
      { id: "cloudflare-backend", required: false, exitCode: 0 },
      { id: "cloudflare-deployment", required: false, exitCode: 0 },
      { id: "no-domain-public", required: false, exitCode: 0 },
      { id: "secrets-signoff", required: false, exitCode: 0 },
    { id: "hr-signoff", required: false, exitCode: 0 },
    { id: "storage-signoff", required: false, exitCode: 0 },
    { id: "drill-evidence", required: false, exitCode: 0 },
    {
      id: "doctor",
      required: false,
      exitCode: 0,
      parsedJson: {
        readiness: {
          canRunDockerDrill: true,
          canReachPostgres: true,
          canVerifyDatabaseIntegrity: true,
          canRunApiSmoke: true,
          canRunFrontendApiSmoke: true,
          hardBlockers: []
        }
      }
    },
    { id: "db-generate", required: true, exitCode: 0 },
    { id: "test-server", required: true, exitCode: 0 },
    { id: "build", required: true, exitCode: 0 },
    { id: "e2e", required: true, exitCode: 0 }
  ];
  const report = buildEvidenceReport({
    artifacts: { migrations: [], files: {} },
    checks,
    commandLine: "node scripts/commercial-evidence.mjs --full --e2e",
    env: {
      APP_ENV: "production",
      DATABASE_URL: "postgresql://oa:prod-db-password@db.internal.example:5432/oa_commercial?schema=public",
      NODE_ENV: "production",
      VITE_DEMO_FALLBACK: "0",
      VITE_REQUIRE_API: "1"
    },
    knownGaps: [
      { id: "GAP-001", status: "Closed" },
      { id: "GAP-002", status: "Closed" },
      { id: "GAP-003", status: "Closed" },
      { id: "GAP-004", status: "Closed" },
      { id: "GAP-005", status: "Closed" }
    ],
    rootDir: "/tmp/project",
    startedAt: "2026-05-30T00:00:00.000Z",
    finishedAt: "2026-05-30T00:00:01.000Z"
  });

  assert.equal(report.summary.ok, true);
  assert.equal(report.summary.e2eIncluded, true);
  assert.equal(report.summary.releaseCandidateReady, true);
  assert.deepEqual(report.summary.releaseBlockers, []);
  assert.equal(report.targetProfile.evidenceClass, "production-release-evidence");
  assert.doesNotMatch(JSON.stringify(report.summary), /prod-db-password|db\.internal\.example|oa_commercial/);
});

test("commercial evidence summary fails when required checks fail", () => {
  const summary = summarizeEvidence({
    evidenceMode: "full",
    knownGaps: [],
    checks: [
      { id: "preflight", required: true, exitCode: 1 },
      { id: "hr-review-prep", required: true, exitCode: 0 },
      { id: "production-env", required: false, exitCode: 1 },
      { id: "cloudflare-backend", required: false, exitCode: 1 },
      { id: "cloudflare-deployment", required: false, exitCode: 1 },
      { id: "no-domain-public", required: false, exitCode: 1 },
      { id: "secrets-signoff", required: false, exitCode: 1 },
      { id: "hr-signoff", required: false, exitCode: 1 },
      { id: "storage-signoff", required: false, exitCode: 1 },
      { id: "drill-evidence", required: false, exitCode: 1 },
      { id: "local-recovery-evidence", required: false, diagnostic: true, exitCode: 66 },
      { id: "doctor", required: false, exitCode: 1, parsedJson: null }
    ]
  });

  assert.equal(summary.evidenceMode, "full");
  assert.equal(summary.ok, false);
  assert.equal(summary.releaseCandidateReady, false);
  assert(summary.releaseBlockers.some((blocker) => blocker.includes("Required check failed: preflight")));
  assert.deepEqual(summary.requiredFailed, [{ id: "preflight", exitCode: 1 }]);
  assert.deepEqual(summary.warningChecks.map((check) => check.id), ["production-env", "cloudflare-backend", "cloudflare-deployment", "no-domain-public", "secrets-signoff", "hr-signoff", "storage-signoff", "drill-evidence", "doctor"]);
  assert.deepEqual(summary.diagnosticChecks, [{ id: "local-recovery-evidence", exitCode: 66 }]);
});

test("commercial evidence report redacts project paths and environment secrets", () => {
  const rootDir = "/tmp/oa-commercial-project";
  const env = {
    JWT_SECRET: "jwt-super-secret-value-20260530",
    DATABASE_URL: "postgresql://oa:db-secret-password@127.0.0.1:5432/oa_commercial?schema=public",
    POSTGRES_PASSWORD: "db-secret-password"
  };
  const report = buildEvidenceReport({
    artifacts: { migrations: [], files: {} },
    checks: [{
      id: "production-env",
      required: false,
      exitCode: 1,
      command: `node ${rootDir}/scripts/validate-production-env.mjs`,
      stdout: `Production env failed at ${rootDir}/.env.production JWT_SECRET=jwt-super-secret-value-20260530`,
      stderr: "DATABASE_URL=postgresql://oa:db-secret-password@127.0.0.1:5432/oa_commercial?schema=public",
      parsedJson: {
        path: `${rootDir}/.env.production`,
        databaseUrl: "postgresql://oa:db-secret-password@127.0.0.1:5432/oa_commercial?schema=public",
        jwtSecret: "jwt-super-secret-value-20260530"
      }
    }],
    commandLine: `node ${rootDir}/scripts/commercial-evidence.mjs --quick`,
    env,
    knownGaps: [],
    rootDir,
    startedAt: "2026-05-30T00:00:00.000Z",
    finishedAt: "2026-05-30T00:00:01.000Z"
  });
  const serialized = JSON.stringify(report);

  assert.equal(report.projectRoot, "[PROJECT_ROOT]");
  assert.equal(report.checks[0].parsedJson.path, "[PROJECT_ROOT]/.env.production");
  assert.equal(report.checks[0].stderr, "DATABASE_URL=[REDACTED]");
  assert.doesNotMatch(serialized, /\/tmp\/oa-commercial-project|jwt-super-secret-value|db-secret-password/);
  assert.match(serialized, /\[PROJECT_ROOT\]/);
  assert.match(serialized, /\[REDACTED\]|\*\*\*/);
});

test("commercial evidence report redacts HR review preparation paths", () => {
  const rootDir = "/tmp/oa-commercial-project";
  const report = buildEvidenceReport({
    artifacts: { migrations: [], files: {} },
    checks: [{
      id: "hr-review-prep",
      required: true,
      exitCode: 0,
      stdout: `{"ok":true,"outputDir":"${rootDir}/reports/commercial-evidence/hr-data-review/hr-data-review-20260530T000000Z","files":{"manifest":"${rootDir}/reports/commercial-evidence/hr-data-review/hr-data-review-20260530T000000Z/manifest.json"}}`,
      stderr: "",
      parsedJson: {
        ok: true,
        outputDir: `${rootDir}/reports/commercial-evidence/hr-data-review/hr-data-review-20260530T000000Z`,
        files: {
          manifest: `${rootDir}/reports/commercial-evidence/hr-data-review/hr-data-review-20260530T000000Z/manifest.json`
        }
      }
    }],
    commandLine: `node ${rootDir}/scripts/commercial-evidence.mjs --quick`,
    knownGaps: [],
    rootDir,
    startedAt: "2026-05-30T00:00:00.000Z",
    finishedAt: "2026-05-30T00:00:01.000Z"
  });
  const serialized = JSON.stringify(report);

  assert.equal(report.checks[0].parsedJson.outputDir, "[PROJECT_ROOT]/reports/commercial-evidence/hr-data-review/hr-data-review-20260530T000000Z");
  assert.equal(report.checks[0].parsedJson.files.manifest, "[PROJECT_ROOT]/reports/commercial-evidence/hr-data-review/hr-data-review-20260530T000000Z/manifest.json");
  assert.doesNotMatch(serialized, /\/tmp\/oa-commercial-project/);
});

test("commercial evidence CLI result redacts absolute output path", () => {
  const rootDir = "/tmp/oa-commercial-project";
  const result = buildEvidenceCliResult({
    outputPath: `${rootDir}/reports/commercial-evidence/commercial-evidence-20260530T010203Z.json`,
    report: {
      summary: {
        ok: true,
        readiness: {
          nextSteps: [`Review ${rootDir}/reports/commercial-evidence/latest.json`]
        }
      }
    },
    rootDir
  });
  const serialized = JSON.stringify(result);

  assert.equal(result.ok, true);
  assert.equal(result.output, "[PROJECT_ROOT]/reports/commercial-evidence/commercial-evidence-20260530T010203Z.json");
  assert.equal(result.summary.readiness.nextSteps[0], "Review [PROJECT_ROOT]/reports/commercial-evidence/latest.json");
  assert.doesNotMatch(serialized, /\/tmp\/oa-commercial-project/);
});

test("commercial evidence text redaction masks env assignment secrets", () => {
  const redacted = redactEvidenceText(
    "OBJECT_STORAGE_SECRET_ACCESS_KEY=minio-secret-value POSTGRES_PASSWORD=db-secret-password plain",
    {
      env: {
        OBJECT_STORAGE_SECRET_ACCESS_KEY: "minio-secret-value",
        POSTGRES_PASSWORD: "db-secret-password"
      },
      rootDir: "/tmp/project"
    }
  );

  assert.equal(redacted.includes("minio-secret-value"), false);
  assert.equal(redacted.includes("db-secret-password"), false);
  assert.match(redacted, /OBJECT_STORAGE_SECRET_ACCESS_KEY=\[REDACTED\]/);
  assert.match(redacted, /POSTGRES_PASSWORD=\[REDACTED\]/);
});

test("commercial evidence text redaction masks database URL password fragments", () => {
  const redacted = redactEvidenceText(
    "spawn failed with password candidate-db-secret while connecting to PostgreSQL",
    {
      env: {
        DATABASE_URL: "postgresql://oa:candidate-db-secret@127.0.0.1:5432/oa_commercial?schema=public"
      },
      rootDir: "/tmp/project"
    }
  );

  assert.equal(redacted.includes("candidate-db-secret"), false);
  assert.match(redacted, /\[REDACTED\]/);
});

test("commercial evidence runCheck captures large command output without buffer failure", () => {
  const result = runCheck({
    id: "large-output",
    command: process.execPath,
    args: ["-e", "process.stdout.write('x'.repeat(1200000))"],
    required: true
  }, {
    env: {
      ...process.env,
      COMMERCIAL_EVIDENCE_MAX_BUFFER_BYTES: String(2 * 1024 * 1024)
    }
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.ok, true);
  assert.equal(result.spawnError, null);
  assert.match(result.stdout, /\[truncated/);
});

test("commercial evidence runCheck records spawn errors in archived stderr", () => {
  const result = runCheck({
    id: "missing-command",
    command: "oa-commercial-command-that-does-not-exist",
    args: [],
    required: true
  });

  assert.equal(result.exitCode, 1);
  assert.equal(result.ok, false);
  assert.match(result.stderr, /ENOENT|spawnSync/);
  assert.match(result.spawnError, /ENOENT|spawnSync/);
});

test("commercial evidence artifact inventory tracks release automation scripts", () => {
  const artifacts = collectArtifacts(process.cwd());

  [
    "scripts/commercial-evidence.mjs",
    "scripts/commercial-gap-report.mjs",
    "scripts/commercial-readiness-audit.mjs",
    "scripts/commercial-release-candidate.mjs",
    "scripts/commercial-release-dossier.mjs",
    "scripts/commercial-release-gate.mjs",
    "scripts/generate-sbom.mjs",
    "scripts/generate-signoff-drafts.mjs",
    "scripts/materialize-release-inputs.mjs",
    "scripts/no-domain-public-smoke.mjs",
    "scripts/prepare-hr-data-review.mjs",
    "scripts/validate-cloudflare-backend.mjs",
    "scripts/validate-evidence-permissions.mjs",
    "scripts/validate-local-recovery-drill.mjs"
  ].forEach((path) => {
    assert.equal(artifacts.files[path].exists, true);
    assert.match(artifacts.files[path].sha256, /^[a-f0-9]{64}$/);
  });
  assert.equal(artifacts.files["scripts/validate-migrations.mjs"].exists, true);
  assert.match(artifacts.files["scripts/validate-migrations.mjs"].sha256, /^[a-f0-9]{64}$/);
  assert.equal(artifacts.files["prisma/migrations/migration-lock.json"].exists, true);
  assert.match(artifacts.files["prisma/migrations/migration-lock.json"].sha256, /^[a-f0-9]{64}$/);
  assert("reports/commercial-evidence/hr-data-review/latest-manifest.json" in artifacts.files);
  assert("reports/commercial-evidence/production-env-prep/latest-manifest.json" in artifacts.files);
  assert("reports/commercial-evidence/signoff-drafts/latest-manifest.json" in artifacts.files);
  assert("reports/commercial-evidence/signoff-validation/release-inputs.json" in artifacts.files);
  assert("reports/commercial-evidence/signoff-validation/production-env.json" in artifacts.files);
  assert("reports/commercial-evidence/signoff-validation/cloudflare-backend.json" in artifacts.files);
  assert("reports/commercial-evidence/signoff-validation/secrets-signoff.json" in artifacts.files);
  assert("reports/commercial-evidence/signoff-validation/hr-signoff.json" in artifacts.files);
  assert("reports/commercial-evidence/signoff-validation/storage-signoff.json" in artifacts.files);
  assert("docker-compose.cloudflare.yml" in artifacts.files);
  assert("cloudflare/worker.js" in artifacts.files);
  assert(".github/workflows/cloudflare-deploy.yml" in artifacts.files);
  assert(".github/workflows/github-pages.yml" in artifacts.files);
  assert("reports/commercial-evidence/sbom/latest-spdx.json" in artifacts.files);
  assert("reports/commercial-evidence/latest-gap-report.json" in artifacts.files);
  assert("reports/commercial-evidence/latest-gap-report.md" in artifacts.files);
  assert("reports/commercial-evidence/latest-owner-handoff-manifest.json" in artifacts.files);
  assert("reports/commercial-evidence/latest-owner-handoff.md" in artifacts.files);
  assert("commercial-evidence/latest-local-recovery-drill-summary.json" in artifacts.files);
  assert(".github/workflows/commercial-ci.yml" in artifacts.files);
  assert(".github/workflows/commercial-drill.yml" in artifacts.files);
  assert(".github/workflows/commercial-signoff.yml" in artifacts.files);
});

test("commercial evidence post-writes current gap action report", async () => {
  const dir = await mkdtemp(join(tmpdir(), "oa-commercial-gap-evidence-"));
  try {
    const evidencePath = join(dir, "evidence.json");
    await writeFile(evidencePath, JSON.stringify({
      schemaVersion: 1,
      generatedAt: "2026-05-30T00:00:00.000Z",
      knownGaps: [
        { id: "GAP-001", status: "Open", owner: "Deployment lead", targetDate: "2026-06-03" }
      ],
      checks: [
        { id: "doctor", required: false, exitCode: 1 },
        { id: "db-generate", required: true, exitCode: 0 },
        { id: "test-server", required: true, exitCode: 0 },
        { id: "build", required: true, exitCode: 0 }
      ],
      summary: {
        ok: true,
        requiredFailed: [],
        warningChecks: [{ id: "doctor", exitCode: 1 }],
        openGaps: ["GAP-001"],
        readiness: {
          canRunDockerDrill: false,
          canReachPostgres: false,
          canVerifyDatabaseIntegrity: false,
          canRunApiSmoke: false,
          canRunFrontendApiSmoke: false,
          hardBlockers: [{ name: "docker" }],
          warnings: [],
          nextSteps: ["Start PostgreSQL."]
        }
      }
    }), "utf8");

    const result = runGapReportCheck({
      evidencePath,
      outputDir: dir,
      cwd: process.cwd()
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.ok, true);
    assert.equal(result.parsedJson.ok, true);
    assert.equal(result.parsedJson.summary.openGapCount >= 1, true);
    assert.equal(basename(result.parsedJson.latest), "latest-gap-report.json");
    assert.equal(basename(result.parsedJson.ownerHandoff.latestManifestPath), "latest-owner-handoff-manifest.json");
    assert.match(await readFile(join(dir, "latest-gap-report.md"), "utf8"), /Commercial Gap Action Report/);
    assert.match(await readFile(join(dir, "latest-owner-handoff.md"), "utf8"), /Commercial Gap Owner Handoff Index/);
    assert.equal((await stat(join(dir, "latest-gap-report.json"))).mode & 0o777, 0o600);
    assert.equal((await stat(join(dir, "latest-owner-handoff-manifest.json"))).mode & 0o777, 0o600);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("commercial evidence writer returns empty path when smoke evidence output is not requested", () => {
  const written = writeCommercialEvidence({
    kind: "commercial-smoke",
    payload: { ok: true },
    env: {}
  });
  assert.equal(written, "");
});

test("commercial evidence writer writes explicit smoke evidence file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "oa-commercial-evidence-"));
  const target = join(dir, "smoke.json");
  try {
    const written = writeCommercialEvidence({
      kind: "commercial-smoke",
      payload: { ok: true, runId: "explicit-run" },
      explicitPath: target,
      env: {}
    });
    assert.equal(written, target);
    const payload = JSON.parse(await readFile(target, "utf8"));
    assert.equal(payload.ok, true);
    assert.equal(payload.runId, "explicit-run");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("commercial evidence report writer stores timestamped and latest files as private", async () => {
  const dir = await mkdtemp(join(tmpdir(), "oa-commercial-report-"));
  try {
    const outputPath = writeEvidenceReport({
      schemaVersion: 1,
      generatedAt: "2026-05-30T01:02:03.000Z",
      checks: [],
      knownGaps: [],
      summary: { ok: true }
    }, dir);
    const latestPath = join(dir, "latest.json");

	    assert.equal(basename(outputPath), "commercial-evidence-20260530T010203Z.json");
	    assert.equal((await stat(dir)).mode & 0o777, 0o700);
	    assert.equal((await stat(outputPath)).mode & 0o777, 0o600);
	    assert.equal((await stat(latestPath)).mode & 0o777, 0o600);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("commercial evidence writer creates safe timestamped smoke files under evidence directory", async () => {
  const dir = await mkdtemp(join(tmpdir(), "oa-commercial-evidence-"));
  try {
    const now = new Date("2026-05-30T12:34:56.000Z");
    const resolved = resolveCommercialEvidencePath({
      kind: "commercial smoke",
      payload: { runId: "run/with spaces" },
      evidenceDir: dir,
      now
    });
    assert.equal(basename(resolved), "commercial-smoke-20260530T123456Z-run-with-spaces.json");

    const written = writeCommercialEvidence({
      kind: "commercial smoke",
      payload: { ok: true, runId: "run/with spaces" },
      env: { COMMERCIAL_EVIDENCE_DIR: dir },
      now
    });
	    assert.equal(written, resolved);
	    const payload = JSON.parse(await readFile(written, "utf8"));
	    assert.equal(payload.ok, true);
	    assert.equal((await stat(dir)).mode & 0o777, 0o700);
	    assert.equal((await stat(written)).mode & 0o777, 0o600);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
