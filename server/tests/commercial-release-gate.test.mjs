import assert from "node:assert/strict";
import test from "node:test";
import {
  buildReleaseGateCliPayload,
  evaluateReleaseGate,
  parseReleaseGateArgs
} from "../../scripts/commercial-release-gate.mjs";

const gateNow = new Date("2026-05-30T01:00:00.000Z");

function releaseGate(evidence, options = {}) {
  return evaluateReleaseGate(evidence, { now: gateNow, ...options });
}

function passingEvidence(overrides = {}) {
  const checks = [
    { id: "preflight", required: true, exitCode: 0 },
    { id: "migrations", required: true, exitCode: 0 },
    { id: "supply-chain", required: true, exitCode: 0 },
    { id: "sbom", required: true, exitCode: 0 },
    { id: "brand", required: true, exitCode: 0 },
    { id: "contract", required: true, exitCode: 0 },
    { id: "hr-review-prep", required: true, exitCode: 0 },
    { id: "evidence-permissions", required: true, exitCode: 0 },
    { id: "production-env", required: false, exitCode: 0 },
    { id: "cloudflare-backend", required: false, exitCode: 0 },
    { id: "secrets-signoff", required: false, exitCode: 0 },
    { id: "hr-signoff", required: false, exitCode: 0 },
    { id: "storage-signoff", required: false, exitCode: 0 },
    { id: "drill-evidence", required: false, exitCode: 0 },
    { id: "local-recovery-evidence", required: false, diagnostic: true, exitCode: 66 },
    { id: "doctor", required: false, exitCode: 0 },
    { id: "db-generate", required: true, exitCode: 0 },
    { id: "test-server", required: true, exitCode: 0 },
    { id: "build", required: true, exitCode: 0 },
    { id: "e2e", required: true, exitCode: 0 }
  ];

  return {
    schemaVersion: 1,
    evidenceMode: "full",
    generatedAt: "2026-05-30T00:00:00.000Z",
    targetProfile: {
      appEnv: "production",
      apiBaseUrl: "https://oa.company.test",
      database: {
        configured: true,
        database: "oa_commercial",
        host: "postgres.internal.company.test",
        isLocal: false,
        port: "5432",
        schema: "public",
        url: "postgresql://oa:***@postgres.internal.company.test:5432/oa_commercial?schema=public"
      },
      evidenceClass: "production-release-evidence",
      e2eIncluded: true,
      nodeEnv: "production",
      productionEvidenceReady: true,
      productionRuntime: true,
      signoffChecks: {
        cloudflareBackend: true,
        drillEvidence: true,
        hr: true,
        productionEnv: true,
        secrets: true,
        storage: true
      },
      viteDemoFallback: "0",
      viteRequireApi: "1",
      warnings: []
    },
    knownGaps: [
      { id: "GAP-001", status: "Closed", owner: "Deployment lead" },
      { id: "GAP-002", status: "Closed", owner: "DevOps lead" },
      { id: "GAP-003", status: "Closed", owner: "Security lead" },
      { id: "GAP-004", status: "Closed", owner: "Infrastructure lead" },
      { id: "GAP-005", status: "Closed", owner: "Product lead" }
    ],
    checks,
    summary: {
      ok: true,
      readiness: {
        canRunDockerDrill: true,
        canReachPostgres: true,
        canVerifyDatabaseIntegrity: true,
        canRunApiSmoke: true,
        canRunFrontendApiSmoke: true,
        hardBlockers: [],
        warnings: []
      }
    },
    ...overrides
  };
}

test("commercial release gate passes fully green release evidence", () => {
  const result = releaseGate(passingEvidence());

  assert.equal(result.ok, true);
  assert.deepEqual(result.failures, []);
  assert.equal(result.summary.checkCount, 20);
  assert.equal(result.summary.openGapCount, 0);
  assert.equal(result.summary.evidenceMode, "full");
  assert.equal(result.summary.maxEvidenceAgeHours, 24);
  assert.equal(result.summary.evidenceAgeHours, 1);
});

test("commercial release gate blocks quick or missing evidence mode", () => {
  const quick = releaseGate(passingEvidence({ evidenceMode: "quick" }));
  assert.equal(quick.ok, false);
  assert(quick.failures.some((failure) => failure.includes("evidenceMode must be full")));

  const missing = passingEvidence();
  delete missing.evidenceMode;
  const result = releaseGate(missing);
  assert.equal(result.ok, false);
  assert(result.failures.some((failure) => failure.includes("evidenceMode must be full")));
});

test("commercial release gate blocks missing or failing migration integrity evidence", () => {
  const missing = releaseGate({
    ...passingEvidence(),
    checks: passingEvidence().checks.filter((check) => check.id !== "migrations")
  });
  assert.equal(missing.ok, false);
  assert(missing.failures.some((failure) => failure.includes("missing required release check: migrations")));

  const failing = releaseGate({
    ...passingEvidence(),
    checks: passingEvidence().checks.map((check) => (
      check.id === "migrations" ? { ...check, exitCode: 1 } : check
    ))
  });
  assert.equal(failing.ok, false);
  assert(failing.failures.some((failure) => failure.includes("Required evidence check failed: migrations")));
});

test("commercial release gate blocks missing or failing supply-chain evidence", () => {
  const missing = releaseGate({
    ...passingEvidence(),
    checks: passingEvidence().checks.filter((check) => check.id !== "supply-chain")
  });
  assert.equal(missing.ok, false);
  assert(missing.failures.some((failure) => failure.includes("missing required release check: supply-chain")));

  const failing = releaseGate({
    ...passingEvidence(),
    checks: passingEvidence().checks.map((check) => (
      check.id === "supply-chain" ? { ...check, exitCode: 1 } : check
    ))
  });
  assert.equal(failing.ok, false);
  assert(failing.failures.some((failure) => failure.includes("Required evidence check failed: supply-chain")));
});

test("commercial release gate blocks missing or failing SBOM evidence", () => {
  const missing = releaseGate({
    ...passingEvidence(),
    checks: passingEvidence().checks.filter((check) => check.id !== "sbom")
  });
  assert.equal(missing.ok, false);
  assert(missing.failures.some((failure) => failure.includes("missing required release check: sbom")));

  const failing = releaseGate({
    ...passingEvidence(),
    checks: passingEvidence().checks.map((check) => (
      check.id === "sbom" ? { ...check, exitCode: 1 } : check
    ))
  });
  assert.equal(failing.ok, false);
  assert(failing.failures.some((failure) => failure.includes("Required evidence check failed: sbom")));
});

test("commercial release gate blocks open gaps doctor blockers and missing e2e", () => {
  const evidence = passingEvidence({
    checks: [
      { id: "preflight", required: true, exitCode: 0 },
      { id: "migrations", required: true, exitCode: 0 },
      { id: "supply-chain", required: true, exitCode: 0 },
      { id: "sbom", required: true, exitCode: 0 },
      { id: "brand", required: true, exitCode: 0 },
      { id: "contract", required: true, exitCode: 0 },
      { id: "hr-review-prep", required: true, exitCode: 0 },
      { id: "evidence-permissions", required: true, exitCode: 0 },
      { id: "production-env", required: false, exitCode: 0 },
      { id: "cloudflare-backend", required: false, exitCode: 0 },
      { id: "secrets-signoff", required: false, exitCode: 0 },
      { id: "hr-signoff", required: false, exitCode: 0 },
      { id: "storage-signoff", required: false, exitCode: 0 },
      { id: "drill-evidence", required: false, exitCode: 0 },
      { id: "doctor", required: false, exitCode: 1 },
      { id: "db-generate", required: true, exitCode: 0 },
      { id: "test-server", required: true, exitCode: 0 },
      { id: "build", required: true, exitCode: 0 }
    ],
    knownGaps: [
      { id: "GAP-001", status: "Open", owner: "Deployment lead" }
    ],
    summary: {
      ok: true,
      readiness: {
        canRunDockerDrill: false,
        canReachPostgres: false,
        canVerifyDatabaseIntegrity: false,
        canRunApiSmoke: false,
        canRunFrontendApiSmoke: false,
        hardBlockers: [{ name: "docker", message: "Docker CLI missing" }],
        warnings: [{ name: "api-port", message: "API missing" }]
      }
    }
  });
  const result = releaseGate(evidence);

  assert.equal(result.ok, false);
  assert(result.failures.some((failure) => failure.includes("missing required release check: e2e")));
  assert(result.failures.some((failure) => failure.includes("Release gap remains open: GAP-001")));
  assert(result.failures.some((failure) => failure.includes("warning check is failing: doctor")));
  assert(result.failures.some((failure) => failure.includes("canRunDockerDrill")));
  assert(result.failures.some((failure) => failure.includes("canVerifyDatabaseIntegrity")));
  assert(result.failures.some((failure) => failure.includes("hard blockers: docker")));
  assert(result.warnings.some((warning) => warning.includes("api-port")));
});

test("commercial release gate blocks missing or non-production target profile", () => {
  const missing = releaseGate({
    ...passingEvidence(),
    targetProfile: undefined
  });
  assert.equal(missing.ok, false);
  assert(missing.failures.some((failure) => failure.includes("targetProfile is required")));

  const localCi = releaseGate(passingEvidence({
    targetProfile: {
      ...passingEvidence().targetProfile,
      evidenceClass: "local-or-ci-validation",
      productionRuntime: false,
      productionEvidenceReady: false
    }
  }));
  assert.equal(localCi.ok, false);
  assert(localCi.failures.some((failure) => failure.includes("targetProfile.evidenceClass must be production-release-evidence")));
  assert(localCi.failures.some((failure) => failure.includes("targetProfile.productionRuntime must be true")));
  assert(localCi.failures.some((failure) => failure.includes("targetProfile.productionEvidenceReady must be true")));
});

test("commercial release gate blocks local database and frontend fallback target profile", () => {
  const result = releaseGate(passingEvidence({
    targetProfile: {
      ...passingEvidence().targetProfile,
      database: {
        ...passingEvidence().targetProfile.database,
        host: "127.0.0.1",
        isLocal: true
      },
      viteDemoFallback: "1",
      viteRequireApi: "0",
      warnings: ["DATABASE_URL points at a local PostgreSQL host; this is not production database evidence."]
    }
  }));

  assert.equal(result.ok, false);
  assert(result.failures.some((failure) => failure.includes("targetProfile.database.isLocal must be false")));
  assert(result.failures.some((failure) => failure.includes("targetProfile.viteRequireApi must be 1")));
  assert(result.failures.some((failure) => failure.includes("targetProfile.viteDemoFallback must be 0")));
  assert(result.warnings.some((warning) => warning.includes("targetProfile has warnings")));
});

test("commercial release gate blocks missing or failing production env evidence", () => {
  const missing = releaseGate(passingEvidence({
    checks: passingEvidence().checks.filter((check) => check.id !== "production-env")
  }));
  assert.equal(missing.ok, false);
  assert(missing.failures.some((failure) => failure.includes("missing required release check: production-env")));

  const failing = releaseGate(passingEvidence({
    checks: passingEvidence().checks.map((check) => (
      check.id === "production-env" ? { ...check, exitCode: 1 } : check
    ))
  }));
  assert.equal(failing.ok, false);
  assert(failing.failures.some((failure) => failure.includes("warning check is failing: production-env")));
});

test("commercial release gate blocks missing or failing Cloudflare backend evidence", () => {
  const missing = releaseGate(passingEvidence({
    checks: passingEvidence().checks.filter((check) => check.id !== "cloudflare-backend")
  }));
  assert.equal(missing.ok, false);
  assert(missing.failures.some((failure) => failure.includes("missing required release check: cloudflare-backend")));

  const failing = releaseGate(passingEvidence({
    checks: passingEvidence().checks.map((check) => (
      check.id === "cloudflare-backend" ? { ...check, exitCode: 1 } : check
    ))
  }));
  assert.equal(failing.ok, false);
  assert(failing.failures.some((failure) => failure.includes("warning check is failing: cloudflare-backend")));
});

test("commercial release gate blocks missing or failing HR review preparation evidence", () => {
  const missing = releaseGate(passingEvidence({
    checks: passingEvidence().checks.filter((check) => check.id !== "hr-review-prep")
  }));
  assert.equal(missing.ok, false);
  assert(missing.failures.some((failure) => failure.includes("missing required release check: hr-review-prep")));

  const failing = releaseGate(passingEvidence({
    checks: passingEvidence().checks.map((check) => (
      check.id === "hr-review-prep" ? { ...check, exitCode: 1 } : check
    ))
  }));
  assert.equal(failing.ok, false);
  assert(failing.failures.some((failure) => failure.includes("Required evidence check failed: hr-review-prep")));
});

test("commercial release gate blocks missing or failing evidence permission audit", () => {
  const missing = releaseGate(passingEvidence({
    checks: passingEvidence().checks.filter((check) => check.id !== "evidence-permissions")
  }));
  assert.equal(missing.ok, false);
  assert(missing.failures.some((failure) => failure.includes("missing required release check: evidence-permissions")));

  const failing = releaseGate(passingEvidence({
    checks: passingEvidence().checks.map((check) => (
      check.id === "evidence-permissions" ? { ...check, exitCode: 1 } : check
    ))
  }));
  assert.equal(failing.ok, false);
  assert(failing.failures.some((failure) => failure.includes("Required evidence check failed: evidence-permissions")));
});

test("commercial release gate blocks missing or failing secrets signoff evidence", () => {
  const missing = releaseGate(passingEvidence({
    checks: passingEvidence().checks.filter((check) => check.id !== "secrets-signoff")
  }));
  assert.equal(missing.ok, false);
  assert(missing.failures.some((failure) => failure.includes("missing required release check: secrets-signoff")));

  const failing = releaseGate(passingEvidence({
    checks: passingEvidence().checks.map((check) => (
      check.id === "secrets-signoff" ? { ...check, exitCode: 1 } : check
    ))
  }));
  assert.equal(failing.ok, false);
  assert(failing.failures.some((failure) => failure.includes("warning check is failing: secrets-signoff")));
});

test("commercial release gate blocks missing or failing HR signoff evidence", () => {
  const missing = releaseGate(passingEvidence({
    checks: passingEvidence().checks.filter((check) => check.id !== "hr-signoff")
  }));
  assert.equal(missing.ok, false);
  assert(missing.failures.some((failure) => failure.includes("missing required release check: hr-signoff")));

  const failing = releaseGate(passingEvidence({
    checks: passingEvidence().checks.map((check) => (
      check.id === "hr-signoff" ? { ...check, exitCode: 1 } : check
    ))
  }));
  assert.equal(failing.ok, false);
  assert(failing.failures.some((failure) => failure.includes("warning check is failing: hr-signoff")));
});

test("commercial release gate blocks missing or failing storage signoff evidence", () => {
  const missing = releaseGate(passingEvidence({
    checks: passingEvidence().checks.filter((check) => check.id !== "storage-signoff")
  }));
  assert.equal(missing.ok, false);
  assert(missing.failures.some((failure) => failure.includes("missing required release check: storage-signoff")));

  const failing = releaseGate(passingEvidence({
    checks: passingEvidence().checks.map((check) => (
      check.id === "storage-signoff" ? { ...check, exitCode: 1 } : check
    ))
  }));
  assert.equal(failing.ok, false);
  assert(failing.failures.some((failure) => failure.includes("warning check is failing: storage-signoff")));
});

test("commercial release gate blocks missing or failing drill evidence", () => {
  const missing = releaseGate(passingEvidence({
    checks: passingEvidence().checks.filter((check) => check.id !== "drill-evidence")
  }));
  assert.equal(missing.ok, false);
  assert(missing.failures.some((failure) => failure.includes("missing required release check: drill-evidence")));

  const failing = releaseGate(passingEvidence({
    checks: passingEvidence().checks.map((check) => (
      check.id === "drill-evidence" ? { ...check, exitCode: 1 } : check
    ))
  }));
  assert.equal(failing.ok, false);
  assert(failing.failures.some((failure) => failure.includes("warning check is failing: drill-evidence")));
});

test("commercial release gate blocks closed gaps that fail readiness audit", () => {
  const result = releaseGate(passingEvidence({
    checks: passingEvidence().checks.map((check) => (
      check.id === "hr-signoff" ? { ...check, exitCode: 1 } : check
    ))
  }));

  assert.equal(result.ok, false);
  assert(result.failures.some((failure) => failure.includes("Readiness audit failed: GAP-005")));
  assert(result.failures.some((failure) => failure.includes("marked Closed but closure evidence is not green")));
});

test("commercial release gate can allow missing e2e for narrow diagnostics only", () => {
  const evidence = passingEvidence({
    checks: passingEvidence().checks.filter((check) => check.id !== "e2e")
  });
  const result = releaseGate(evidence, { requireE2e: false });

  assert.equal(result.ok, true);
  assert.equal(result.summary.requiredChecks.includes("e2e"), false);
});

test("commercial release gate blocks stale or future-dated evidence", () => {
  const stale = releaseGate(passingEvidence({
    generatedAt: "2026-05-28T00:00:00.000Z"
  }));
  assert.equal(stale.ok, false);
  assert(stale.failures.some((failure) => failure.includes("Evidence report is stale")));

  const future = releaseGate(passingEvidence({
    generatedAt: "2026-05-30T02:00:00.000Z"
  }));
  assert.equal(future.ok, false);
  assert(future.failures.some((failure) => failure.includes("generatedAt is in the future")));

  const customWindow = releaseGate(passingEvidence({
    generatedAt: "2026-05-29T00:30:00.000Z"
  }), { maxEvidenceAgeHours: 25 });
  assert.equal(customWindow.ok, true);
});

test("commercial release gate parses evidence path and e2e option", () => {
  const parsed = parseReleaseGateArgs([
    "--evidence",
    "reports/evidence.json",
    "--allow-missing-e2e",
    "--max-evidence-age-hours",
    "12",
    "--json"
  ]);

  assert.equal(parsed.evidencePath, "reports/evidence.json");
  assert.equal(parsed.json, true);
  assert.equal(parsed.maxEvidenceAgeHours, 12);
  assert.equal(parsed.requireE2e, false);
});

test("commercial release gate CLI payload redacts local evidence paths", () => {
  const rootDir = "/tmp/oa-commercial-project";
  const secret = "release-token-value";
  const payload = buildReleaseGateCliPayload({
    env: {
      RELEASE_TOKEN: secret
    },
    rootDir,
    path: `${rootDir}/reports/commercial-evidence/latest.json`,
    result: {
      ok: false,
      failures: [`Evidence failed in ${rootDir}/reports/commercial-evidence/latest.json`],
      warnings: [`TOKEN=${secret}`],
      summary: {
        targetProfile: {
          ...passingEvidence().targetProfile,
          database: {
            ...passingEvidence().targetProfile.database,
            host: "postgres.internal.company.test",
            database: "oa_commercial",
            url: "postgresql://oa:***@postgres.internal.company.test:5432/oa_commercial?schema=public"
          }
        },
        readiness: {
          nextSteps: [
            `Review ${rootDir}/reports/commercial-evidence/latest-gap-report.md`
          ]
        }
      }
    }
  });
  const serialized = JSON.stringify(payload);

  assert.equal(payload.path, "[PROJECT_ROOT]/reports/commercial-evidence/latest.json");
  assert(!serialized.includes(rootDir));
  assert(!serialized.includes(secret));
  assert.equal(payload.summary.targetProfile.database.target, "non-local-postgresql");
  assert.equal(payload.summary.targetProfile.database.source, "");
  assert(!serialized.includes("postgres.internal.company.test"));
  assert(!serialized.includes("oa_commercial"));
  assert(serialized.includes("[PROJECT_ROOT]/reports/commercial-evidence/latest-gap-report.md"));
  assert(serialized.includes("TOKEN=[REDACTED]"));
});
