import assert from "node:assert/strict";
import test from "node:test";
import { auditCommercialReadiness, parseReadinessAuditArgs } from "../../scripts/commercial-readiness-audit.mjs";

function greenChecks() {
  return [
    { id: "preflight", required: true, exitCode: 0 },
    { id: "brand", required: true, exitCode: 0 },
    { id: "contract", required: true, exitCode: 0 },
    { id: "production-env", required: false, exitCode: 0 },
    { id: "cloudflare-backend", required: false, exitCode: 0 },
    { id: "cloudflare-deployment", required: false, exitCode: 0 },
    { id: "no-domain-public", required: false, exitCode: 0 },
    { id: "secrets-signoff", required: false, exitCode: 0 },
    { id: "hr-signoff", required: false, exitCode: 0 },
    { id: "storage-signoff", required: false, exitCode: 0 },
    { id: "drill-evidence", required: false, exitCode: 0 },
    { id: "doctor", required: false, exitCode: 0 },
    { id: "db-generate", required: true, exitCode: 0 },
    { id: "test-server", required: true, exitCode: 0 },
    { id: "build", required: true, exitCode: 0 },
    { id: "e2e", required: true, exitCode: 0 }
  ];
}

function closedGaps() {
  return [
    { id: "GAP-001", status: "Closed", owner: "Deployment lead", targetDate: "2026-06-03" },
    { id: "GAP-002", status: "Closed", owner: "DevOps lead", targetDate: "2026-06-05" },
    { id: "GAP-003", status: "Closed", owner: "Security lead", targetDate: "2026-06-05" },
    { id: "GAP-004", status: "Closed", owner: "Infrastructure lead", targetDate: "2026-06-07" },
    { id: "GAP-005", status: "Closed", owner: "Product lead", targetDate: "2026-06-07" }
  ];
}

function greenEvidence(overrides = {}) {
  return {
    schemaVersion: 1,
    generatedAt: "2026-05-30T00:00:00.000Z",
    knownGaps: closedGaps(),
    checks: greenChecks(),
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

test("commercial readiness audit passes fully closed gaps with green evidence", () => {
  const result = auditCommercialReadiness(greenEvidence());

  assert.equal(result.ok, true);
  assert.equal(result.summary.auditedGapCount, 5);
  assert.equal(result.summary.blockedGapCount, 0);
  assert.deepEqual(result.failures, []);
});

test("commercial readiness audit blocks open gaps even when evidence is green", () => {
  const result = auditCommercialReadiness(greenEvidence({
    knownGaps: closedGaps().map((gap) => (
      gap.id === "GAP-005" ? { ...gap, status: "Open" } : gap
    ))
  }));

  assert.equal(result.ok, false);
  assert(result.failures.some((failure) => failure.includes("GAP-005 remains Open")));
  assert.deepEqual(result.summary.readyToClose, ["GAP-005"]);
  assert(result.warnings.some((warning) => warning.includes("GAP-005 has green closure evidence")));
});

test("commercial readiness audit blocks closed gaps with failing evidence", () => {
  const result = auditCommercialReadiness(greenEvidence({
    checks: greenChecks().map((check) => (
      check.id === "no-domain-public" ? { ...check, exitCode: 1 } : check
    ))
  }));

  assert.equal(result.ok, false);
  assert(result.failures.some((failure) => failure.includes("GAP-003")));
  assert(result.failures.some((failure) => failure.includes("no-domain-public exitCode=1")));
  assert(result.failures.some((failure) => failure.includes("marked Closed but closure evidence is not green")));
});

test("commercial readiness audit does not assign Docker-only doctor failure to deployment or secrets gaps", () => {
  const result = auditCommercialReadiness(greenEvidence({
    checks: greenChecks().map((check) => (
      check.id === "doctor" ? { ...check, exitCode: 1 } : check
    )),
    summary: {
      ok: true,
      readiness: {
        canRunDockerDrill: false,
        canReachPostgres: true,
        canVerifyDatabaseIntegrity: true,
        canRunApiSmoke: true,
        canRunFrontendApiSmoke: true,
        hardBlockers: [{ name: "docker" }],
        warnings: []
      }
    }
  }));

  assert.equal(result.gaps.find((gap) => gap.id === "GAP-001").ok, true);
  assert.equal(result.gaps.find((gap) => gap.id === "GAP-003").ok, true);
  assert(result.failures.some((failure) => failure.includes("GAP-002")));
  assert(!result.failures.some((failure) => failure.includes("GAP-001: evidence check failed: doctor")));
  assert(!result.failures.some((failure) => failure.includes("GAP-003: evidence check failed: doctor")));
});

test("commercial readiness audit blocks removed gap rows before evidence is green", () => {
  const result = auditCommercialReadiness(greenEvidence({
    knownGaps: closedGaps().filter((gap) => gap.id !== "GAP-002"),
    checks: greenChecks().map((check) => (
      check.id === "drill-evidence" ? { ...check, exitCode: 66 } : check
    )),
    summary: {
      ok: true,
      readiness: {
        canRunDockerDrill: false,
        canReachPostgres: true,
        canVerifyDatabaseIntegrity: true,
        canRunApiSmoke: true,
        canRunFrontendApiSmoke: true,
        hardBlockers: [{ name: "docker" }],
        warnings: []
      }
    }
  }));

  assert.equal(result.ok, false);
  assert(result.failures.some((failure) => failure.includes("GAP-002 is missing from docs/KNOWN_GAPS.md")));
  assert(result.failures.some((failure) => failure.includes("canRunDockerDrill")));
});

test("commercial readiness audit can skip e2e only for diagnostic mode", () => {
  const evidence = greenEvidence({
    checks: greenChecks().filter((check) => check.id !== "e2e")
  });

  const releaseMode = auditCommercialReadiness(evidence);
  const diagnosticMode = auditCommercialReadiness(evidence, { requireE2e: false });

  assert.equal(releaseMode.ok, false);
  assert(releaseMode.failures.some((failure) => failure.includes("missing evidence check: e2e")));
  assert.equal(diagnosticMode.ok, true);
});

test("commercial readiness audit parses evidence path and e2e option", () => {
  const parsed = parseReadinessAuditArgs(["--evidence", "reports/evidence.json", "--allow-missing-e2e", "--json"]);

  assert.equal(parsed.evidencePath, "reports/evidence.json");
  assert.equal(parsed.requireE2e, false);
  assert.equal(parsed.json, true);
});
