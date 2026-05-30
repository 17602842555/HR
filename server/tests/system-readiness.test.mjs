import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildOwnerEvidenceChecklist,
  buildReleaseClosurePlan,
  loadGapActionReport,
  loadHrDataReview,
  loadLatestCommercialEvidence,
  loadSignoffDrafts
} from "../src/modules/system/system-routes.mjs";

function draftPayload({ approvals = [], openExceptions = [] } = {}) {
  return {
    schemaVersion: 1,
    draft: true,
    approvals,
    openExceptions
  };
}

async function writeJson(path, payload) {
  await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`);
}

test("signoff draft readiness summarizes manifest files without leaking paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "oa-system-signoff-ready-"));
  const baseDir = join(root, "reports", "commercial-evidence", "signoff-drafts");
  const runDir = join(baseDir, "signoff-drafts-test");
  await mkdir(runDir, { recursive: true });

  try {
    await writeJson(join(runDir, "hr-data-signoff.draft.json"), draftPayload({
      approvals: [{ decision: "pending" }],
      openExceptions: [{ id: "HR-REVIEW" }]
    }));
    await writeJson(join(runDir, "production-secrets-signoff.draft.json"), draftPayload({
      approvals: [{ decision: "approved" }],
      openExceptions: []
    }));
    await writeJson(join(runDir, "file-storage-signoff.draft.json"), draftPayload({
      approvals: [{ decision: "pending" }, { decision: "approved" }],
      openExceptions: [{ id: "STORAGE-DRILL" }, { id: "STORAGE-OWNER" }]
    }));
    await writeJson(join(baseDir, "latest-manifest.json"), {
      schemaVersion: 1,
      draft: true,
      generatedAt: "2026-05-30T08:00:00.000Z",
      files: {
        hr: "reports/commercial-evidence/signoff-drafts/signoff-drafts-test/hr-data-signoff.draft.json",
        secrets: "reports/commercial-evidence/signoff-drafts/signoff-drafts-test/production-secrets-signoff.draft.json",
        storage: "reports/commercial-evidence/signoff-drafts/signoff-drafts-test/file-storage-signoff.draft.json"
      },
      nextCommands: ["npm run validate:hr-signoff -- reviewed.json --json"]
    });

    const summary = await loadSignoffDrafts(root);
    assert.equal(summary.available, true);
    assert.equal(summary.draftCount, 3);
    assert.equal(summary.generatedAt, "2026-05-30T08:00:00.000Z");
    assert.equal(summary.nextCommandCount, 1);
    assert.equal(summary.openExceptionCount, 3);
    assert.equal(summary.pendingApprovalCount, 2);
    assert.equal(summary.releaseEvidence, false);
    assert.deepEqual(summary.kinds.map((item) => item.id), ["hr", "secrets", "storage"]);
    assert.equal(summary.kinds.find((item) => item.id === "secrets").status, "草稿待复核");
    assert.doesNotMatch(
      JSON.stringify(summary),
      /reports\/commercial-evidence|signoff-drafts-test|\.draft\.json|\/tmp\//
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("signoff draft readiness rejects absolute and traversal manifest file paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "oa-system-signoff-paths-"));
  const baseDir = join(root, "reports", "commercial-evidence", "signoff-drafts");
  await mkdir(baseDir, { recursive: true });

  try {
    await writeJson(join(baseDir, "latest-manifest.json"), {
      schemaVersion: 1,
      draft: true,
      generatedAt: "2026-05-30T08:00:00.000Z",
      files: {
        hr: "/tmp/hr-data-signoff.draft.json",
        secrets: "reports/commercial-evidence/signoff-drafts/../production-secrets-signoff.draft.json",
        storage: "../file-storage-signoff.draft.json"
      },
      nextCommands: []
    });

    const summary = await loadSignoffDrafts(root);
    assert.equal(summary.available, true);
    assert.equal(summary.draftCount, 3);
    assert.equal(summary.openExceptionCount, 3);
    assert.equal(summary.pendingApprovalCount, 0);
    assert.equal(summary.kinds.every((item) => item.status === "草稿缺失"), true);
    assert.doesNotMatch(
      JSON.stringify(summary),
      /\/tmp\/|reports\/commercial-evidence|file-storage-signoff|production-secrets-signoff|\.draft\.json/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("HR data review readiness summarizes safe package without leaking paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "oa-system-hr-review-ready-"));
  const baseDir = join(root, "reports", "commercial-evidence", "hr-data-review");
  const runDir = join(baseDir, "hr-data-review-test");
  await mkdir(runDir, { recursive: true });

  try {
    await writeJson(join(runDir, "summary.json"), {
      schemaVersion: 1,
      kind: "hr-data-review-preparation",
      generatedAt: "2026-05-30T08:00:00.000Z",
      source: {
        counts: {
          activeEmployees: 72,
          leavers: 162,
          femaleEmployees: 43,
          monthLeavers: 4,
          departments: 10,
          orgs: 8,
          totalReviewRows: 234
        }
      },
      reviewPolicy: { noSensitiveFields: true },
      reviewCsv: { rowCount: 234 }
    });
    await writeFile(join(runDir, "people-review.csv"), "reviewKey,status,maskedName\n");
    await writeFile(join(runDir, "README.md"), "review package only\n");
    await writeJson(join(baseDir, "latest-manifest.json"), {
      schemaVersion: 1,
      draft: true,
      kind: "hr-data-review-preparation",
      generatedAt: "2026-05-30T08:00:00.000Z",
      noSensitiveFields: true,
      files: {
        peopleReviewCsv: "reports/commercial-evidence/hr-data-review/hr-data-review-test/people-review.csv",
        summary: "reports/commercial-evidence/hr-data-review/hr-data-review-test/summary.json",
        readme: "reports/commercial-evidence/hr-data-review/hr-data-review-test/README.md",
        manifest: "reports/commercial-evidence/hr-data-review/hr-data-review-test/manifest.json"
      },
      nextCommands: ["npm run validate:hr-signoff -- reviewed.json --json"]
    });
    await writeJson(join(runDir, "manifest.json"), { ok: true });

    const summary = await loadHrDataReview(root);
    assert.equal(summary.available, true);
    assert.equal(summary.noSensitiveFields, true);
    assert.equal(summary.releaseEvidence, false);
    assert.equal(summary.rowCount, 234);
    assert.equal(summary.counts.activeEmployees, 72);
    assert.equal(summary.counts.leavers, 162);
    assert.equal(summary.counts.totalReviewRows, 234);
    assert.equal(summary.nextCommandCount, 1);
    assert.equal(summary.status, "已生成");
    assert.doesNotMatch(
      JSON.stringify(summary),
      /reports\/commercial-evidence|hr-data-review-test|people-review|summary\.json|manifest\.json|\/tmp\//
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("HR data review readiness flags unsafe manifest paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "oa-system-hr-review-paths-"));
  const baseDir = join(root, "reports", "commercial-evidence", "hr-data-review");
  await mkdir(baseDir, { recursive: true });

  try {
    await writeJson(join(baseDir, "latest-manifest.json"), {
      schemaVersion: 1,
      draft: true,
      kind: "hr-data-review-preparation",
      generatedAt: "2026-05-30T08:00:00.000Z",
      noSensitiveFields: true,
      files: {
        peopleReviewCsv: "/tmp/people-review.csv",
        summary: "../summary.json",
        readme: "reports/commercial-evidence/hr-data-review/../README.md",
        manifest: "reports/commercial-evidence/hr-data-review/hr-data-review-test/manifest.json"
      },
      nextCommands: []
    });

    const summary = await loadHrDataReview(root);
    assert.equal(summary.available, true);
    assert.equal(summary.noSensitiveFields, false);
    assert.equal(summary.status, "清单路径异常");
    assert.equal(summary.unsafeFileCount, 3);
    assert.doesNotMatch(
      JSON.stringify(summary),
      /\/tmp\/|people-review|summary\.json|manifest\.json|reports\/commercial-evidence/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("gap action report readiness summarizes owners without leaking evidence paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "oa-system-gap-report-"));
  const baseDir = join(root, "reports", "commercial-evidence");
  await mkdir(baseDir, { recursive: true });

  try {
    await writeJson(join(baseDir, "latest-gap-report.json"), {
      schemaVersion: 1,
      generatedAt: "2026-05-30T08:00:00.000Z",
      evidencePath: `${root}/reports/commercial-evidence/latest.json`,
      releaseReady: false,
      summary: {
        generatedAt: "2026-05-30T08:00:00.000Z",
        evidenceGeneratedAt: "2026-05-30T07:59:00.000Z",
        evidencePath: `${root}/reports/commercial-evidence/latest.json`,
        blockedGapCount: 2,
        ownerCount: 2,
        warningCheckCount: 6
      },
      owners: [
        {
          owner: "Deployment lead",
          gapIds: ["GAP-001"],
          targetDates: ["2026-06-03"],
          validationCommands: ["npm run ci:commercial"],
          blockers: ["GAP-001: missing evidence check: e2e"]
        },
        {
          owner: "Security lead",
          gapIds: ["GAP-003", "../secret"],
          targetDates: ["2026-06-05", "not-a-date"],
          validationCommands: ["npm run validate:production-env -- .env.production --json"],
          blockers: []
        }
      ]
    });

    const summary = await loadGapActionReport(root);
    assert.equal(summary.available, true);
    assert.equal(summary.releaseEvidence, false);
    assert.equal(summary.blockedGapCount, 2);
    assert.equal(summary.ownerCount, 2);
    assert.equal(summary.warningCheckCount, 6);
    assert.equal(summary.owners[0].owner, "Deployment lead");
    assert.equal(summary.owners[0].blockerCount, 1);
    assert.equal(summary.owners[0].validationCommandCount, 1);
    assert.deepEqual(summary.owners[1].gapIds, ["GAP-003"]);
    assert.deepEqual(summary.owners[1].targetDates, ["2026-06-05"]);
    assert.doesNotMatch(
      JSON.stringify(summary),
      /reports\/commercial-evidence|latest\.json|\/tmp\/|validate:production-env|missing evidence/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("gap action report readiness returns missing summary when report is unavailable", async () => {
  const root = await mkdtemp(join(tmpdir(), "oa-system-gap-report-missing-"));
  try {
    const summary = await loadGapActionReport(root);
    assert.equal(summary.available, false);
    assert.equal(summary.releaseReady, false);
    assert.equal(summary.ownerCount, 0);
    assert.deepEqual(summary.owners, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("latest commercial evidence readiness summarizes target profile without leaking paths or secrets", async () => {
  const root = await mkdtemp(join(tmpdir(), "oa-system-latest-evidence-"));
  const baseDir = join(root, "reports", "commercial-evidence");
  await mkdir(baseDir, { recursive: true });

  try {
    await writeJson(join(baseDir, "latest.json"), {
      schemaVersion: 1,
      evidenceMode: "full",
      generatedAt: "2026-05-30T08:00:00.000Z",
      projectRoot: root,
      commandLine: ["npm", "run", "evidence:commercial", "--", "--full", "--secret=plain"],
      targetProfile: {
        appEnv: "production",
        nodeEnv: "production",
        apiBaseUrl: "https://oa.example.internal",
        database: {
          configured: true,
          database: "oa_prod",
          host: "postgres.internal",
          isLocal: false,
          port: "5432",
          schema: "public",
          url: "postgresql://oa:super-secret-password@postgres.internal/oa_prod?schema=public"
        },
        evidenceClass: "production-release-evidence",
        e2eIncluded: true,
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
      checks: [
        { id: "preflight", required: true, exitCode: 0, command: `${root}/scripts/commercial-preflight.mjs` },
        { id: "cloudflare-backend", required: false, exitCode: 0, command: "npm run validate:cloudflare-backend -- --env .env.production --json" },
        { id: "secrets-signoff", required: false, exitCode: 0, command: "npm run validate:secrets-signoff -- docs/production-secrets-signoff.json" }
      ],
      artifacts: {
        migrations: ["20260529120000_init_commercial_oa"],
        files: {
          "prisma/migrations/migration-lock.json": { exists: true, sha256: "a".repeat(64) },
          "docs/openapi.json": { exists: true, sha256: "b".repeat(64) },
          "reports/commercial-evidence/sbom/latest-spdx.json": { exists: true, sha256: "c".repeat(64) },
          "reports/commercial-evidence/hr-data-review/latest-manifest.json": { exists: true, sha256: "d".repeat(64) },
          "docs/production-secrets-signoff.json": { exists: true, sha256: "e".repeat(64) },
          "reports/commercial-evidence/signoff-validation/cloudflare-backend.json": { exists: true, sha256: "5".repeat(64) },
          "docs/hr-data-signoff.json": { exists: true, sha256: "f".repeat(64) },
          "docs/file-storage-signoff.json": { exists: true, sha256: "1".repeat(64) },
          "commercial-evidence/latest-drill-summary.json": { exists: true, sha256: "2".repeat(64) },
          "reports/commercial-evidence/latest-gap-report.json": { exists: true, sha256: "3".repeat(64) },
          "reports/commercial-evidence/signoff-validation/release-inputs.json": { exists: true, sha256: "4".repeat(64) }
        }
      },
      summary: {
        e2eIncluded: true,
        ok: true,
        openGapCount: 0,
        releaseBlockers: [],
        releaseCandidateReady: true,
        requiredFailed: [],
        warningChecks: []
      }
    });

    const summary = await loadLatestCommercialEvidence(root);
    assert.equal(summary.available, true);
    assert.equal(summary.evidenceMode, "full");
    assert.equal(summary.releaseEvidence, true);
    assert.equal(summary.releaseCandidateReady, true);
    assert.equal(summary.releaseBlockerCount, 0);
    assert.equal(summary.e2eIncluded, true);
    assert.equal(summary.status, "production-release-evidence");
    assert.equal(summary.targetProfile.database.target, "non-local-postgresql");
    assert.equal(summary.targetProfile.viteRequireApi, "1");
    assert.equal(summary.targetProfile.viteDemoFallback, "0");
    assert.equal(summary.artifactSummary.migrationCount, 1);
    assert.equal(summary.artifactSummary.missingReleaseArtifactCount, 0);
    assert.equal(summary.artifactSummary.items.some((item) => item.label === "Docker 恢复演练证据" && item.present), true);
    assert.deepEqual(summary.checks.map((check) => check.id), ["preflight", "cloudflare-backend", "secrets-signoff"]);
    assert.doesNotMatch(
      JSON.stringify(summary),
      /\/tmp\/|reports\/commercial-evidence|commercial-preflight|production-secrets-signoff|latest-drill-summary|super-secret-password|postgres\.internal|oa_prod|oa\.example\.internal|--secret|[a-f0-9]{64}/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("latest commercial evidence readiness marks local or failing evidence as non-release", async () => {
  const root = await mkdtemp(join(tmpdir(), "oa-system-latest-evidence-local-"));
  const baseDir = join(root, "reports", "commercial-evidence");
  await mkdir(baseDir, { recursive: true });

  try {
    await writeJson(join(baseDir, "latest.json"), {
      schemaVersion: 1,
      evidenceMode: "quick",
      generatedAt: "2026-05-30T08:00:00.000Z",
      targetProfile: {
        database: { configured: true, host: "127.0.0.1", isLocal: true },
        evidenceClass: "local-or-ci-validation",
        e2eIncluded: true,
        productionEvidenceReady: false,
        productionRuntime: false,
        signoffChecks: {},
        viteDemoFallback: "1",
        viteRequireApi: "unset",
        warnings: ["local database"]
      },
      checks: [
        { id: "preflight", required: true, exitCode: 0 },
        { id: "doctor", required: false, exitCode: 1 }
      ],
      artifacts: {
        migrations: [],
        files: {
          "prisma/migrations/migration-lock.json": { exists: true, sha256: "a".repeat(64) },
          "docs/openapi.json": { exists: true, sha256: "b".repeat(64) },
          "docs/production-secrets-signoff.json": { exists: false, sha256: null },
          "docs/hr-data-signoff.json": { exists: false, sha256: null },
          "docs/file-storage-signoff.json": { exists: false, sha256: null },
          "commercial-evidence/latest-drill-summary.json": { exists: false, sha256: null }
        }
      },
      summary: {
        e2eIncluded: true,
        ok: true,
        openGapCount: 4,
        releaseBlockers: [
          "Target Profile evidence class is local-or-ci-validation.",
          "Target database is local PostgreSQL, not production evidence."
        ],
        releaseCandidateReady: false,
        requiredFailed: [],
        warningChecks: [{ id: "doctor", exitCode: 1 }]
      }
    });

    const summary = await loadLatestCommercialEvidence(root);
    assert.equal(summary.available, true);
    assert.equal(summary.evidenceMode, "quick");
    assert.equal(summary.releaseEvidence, false);
    assert.equal(summary.releaseCandidateReady, false);
    assert.equal(summary.releaseBlockerCount, 2);
    assert.equal(summary.e2eIncluded, true);
    assert.equal(summary.status, "quick-diagnostic-evidence");
    assert.equal(summary.openGapCount, 4);
    assert.equal(summary.warningCheckCount, 1);
    assert.equal(summary.artifactSummary.missingReleaseArtifactCount > 0, true);
    assert.equal(summary.artifactSummary.items.some((item) => item.label === "生产密钥正式签署" && item.status === "缺失"), true);
    assert.equal(summary.targetProfile.database.target, "local-postgresql");
    assert.equal(summary.targetProfile.warningCount, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("latest commercial evidence readiness returns missing summary when report is unavailable", async () => {
  const root = await mkdtemp(join(tmpdir(), "oa-system-latest-evidence-missing-"));
  try {
    const summary = await loadLatestCommercialEvidence(root);
    assert.equal(summary.available, false);
    assert.equal(summary.evidenceMode, "missing");
    assert.equal(summary.releaseEvidence, false);
    assert.equal(summary.status, "missing");
    assert.deepEqual(summary.checks, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("release closure plan maps open gaps to safe owner actions without leaking commands or paths", () => {
  const plan = buildReleaseClosurePlan([
    { id: "GAP-001", status: "Mitigated", owner: "Deployment lead", targetDate: "2026-05-30" },
    { id: "GAP-002", status: "Open", owner: "DevOps lead", targetDate: "2026-06-05" },
    { id: "GAP-003", status: "Open", owner: "Security lead", targetDate: "2026-06-05" },
    { id: "GAP-005", status: "Open", owner: "Product lead", targetDate: "2026-06-07" }
  ], {
    checks: [
      { id: "drill-evidence", status: "failed" },
      { id: "doctor", status: "failed" },
      { id: "production-env", status: "failed" },
      { id: "cloudflare-backend", status: "failed" },
      { id: "secrets-signoff", status: "failed" },
      { id: "hr-signoff", status: "failed" },
      { id: "e2e", status: "pass" }
    ]
  });

  assert.deepEqual(plan.map((item) => item.id), ["GAP-001", "GAP-002", "GAP-003", "GAP-005"]);
  assert.equal(plan.find((item) => item.id === "GAP-001").releaseBlocking, false);
  assert.equal(plan.find((item) => item.id === "GAP-002").category, "Docker 恢复演练");
  assert.equal(plan.find((item) => item.id === "GAP-002").failedCheckCount, 2);
  assert.equal(plan.find((item) => item.id === "GAP-003").relatedCheckIds.includes("cloudflare-backend"), true);
  assert.equal(plan.find((item) => item.id === "GAP-003").relatedCheckIds.includes("secrets-signoff"), true);
  assert.equal(plan.find((item) => item.id === "GAP-005").evidenceStatus, "证据未通过");
  assert.doesNotMatch(
    JSON.stringify(plan),
    /npm run|reports\/commercial-evidence|latest\.json|postgresql:\/\/|DATABASE_URL|<signoff|<file-storage|127\.0\.0\.1/
  );
});

test("owner evidence checklist maps release artifacts to responsible gaps without leaking private evidence", () => {
  const gaps = [
    { id: "GAP-002", status: "Open", owner: "DevOps lead", targetDate: "2026-06-05" },
    { id: "GAP-003", status: "Open", owner: "Security lead", targetDate: "2026-06-05" },
    { id: "GAP-005", status: "Open", owner: "Product lead", targetDate: "2026-06-07" }
  ];
  const closurePlan = buildReleaseClosurePlan(gaps, {
    checks: [
      { id: "drill-evidence", status: "failed" },
      { id: "doctor", status: "failed" },
      { id: "production-env", status: "failed" },
      { id: "cloudflare-backend", status: "failed" },
      { id: "secrets-signoff", status: "failed" },
      { id: "hr-signoff", status: "failed" }
    ]
  });
  const checklist = buildOwnerEvidenceChecklist(gaps, closurePlan, {
    artifactSummary: {
      items: [
        { label: "HR 脱敏审阅包", present: true, releaseRequired: true, status: "已归档" },
        { label: "生产密钥正式签署", present: false, releaseRequired: true, status: "缺失" },
        { label: "Cloudflare 后端验证输出", present: false, releaseRequired: true, status: "缺失" },
        { label: "HR/Product 正式签署", present: false, releaseRequired: true, status: "缺失" },
        { label: "Docker 恢复演练证据", present: false, releaseRequired: true, status: "缺失" },
        { label: "受保护签署验证输出", present: false, releaseRequired: true, status: "缺失" }
      ]
    }
  });

  assert.deepEqual(checklist.map((item) => item.id), ["GAP-002", "GAP-003", "GAP-005"]);
  assert.equal(checklist.find((item) => item.id === "GAP-002").missingArtifactCount, 1);
  assert.equal(checklist.find((item) => item.id === "GAP-003").missingArtifactCount, 3);
  assert.equal(checklist.find((item) => item.id === "GAP-005").presentArtifactCount, 1);
  assert.equal(checklist.find((item) => item.id === "GAP-005").releaseBlocking, true);
  assert.equal(
    checklist.find((item) => item.id === "GAP-003").artifacts.some((artifact) => artifact.label === "生产密钥正式签署" && artifact.status === "缺失"),
    true
  );
  assert.equal(
    checklist.find((item) => item.id === "GAP-003").artifacts.some((artifact) => artifact.label === "Cloudflare 后端验证输出" && artifact.status === "缺失"),
    true
  );
  assert.doesNotMatch(
    JSON.stringify(checklist),
    /npm run|reports\/commercial-evidence|latest\.json|postgresql:\/\/|DATABASE_URL|[a-f0-9]{64}|\/tmp\/|commercial-drill/
  );
});
