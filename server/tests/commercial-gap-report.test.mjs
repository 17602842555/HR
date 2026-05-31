import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import {
  buildCommercialGapReport,
  parseGapReportArgs,
  renderCommercialGapReportMarkdown,
  writeCommercialGapReport
} from "../../scripts/commercial-gap-report.mjs";

function evidence(overrides = {}) {
  return {
    schemaVersion: 1,
    generatedAt: "2026-05-30T00:00:00.000Z",
    knownGaps: [
      {
        id: "GAP-001",
        status: "Open",
        owner: "Deployment lead",
        targetDate: "2026-06-03",
        gap: "PostgreSQL and API smoke are not ready.",
        exitCriteria: "Run npm run ci:commercial and archive evidence."
      },
      {
        id: "GAP-002",
        status: "Open",
        owner: "DevOps lead",
        targetDate: "2026-06-05",
        gap: "Docker drill has not run.",
        exitCriteria: "Run npm run drill:commercial."
      },
      {
        id: "GAP-003",
        status: "Open",
        owner: "Security lead",
        targetDate: "2026-06-05",
        gap: "Production secrets are templates.",
        exitCriteria: "Validate production env and secrets signoff."
      },
      {
        id: "GAP-004",
        status: "Open",
        owner: "Infrastructure lead",
        targetDate: "2026-06-07",
        gap: "Production file storage is not signed off.",
        exitCriteria: "Validate storage signoff."
      },
      {
        id: "GAP-005",
        status: "Open",
        owner: "Product lead",
        targetDate: "2026-06-07",
        gap: "HR/Product source data is not signed off.",
        exitCriteria: "Validate HR signoff."
      }
    ],
    checks: [
      { id: "preflight", required: true, exitCode: 0, command: "node scripts/commercial-preflight.mjs" },
      { id: "production-env", required: false, exitCode: 1, command: "npm run validate:production-env -- .env.production --json" },
      { id: "cloudflare-deployment", required: false, exitCode: 1, command: "npm run doctor:cloudflare -- --repo 17602842555/HR --url https://deep-oa-hr.2445776963.workers.dev --json" },
      { id: "no-domain-public", required: false, exitCode: 1, command: "npm run smoke:no-domain-public -- --json" },
      { id: "secrets-signoff", required: false, exitCode: 1, command: "npm run validate:secrets-signoff -- --json" },
      { id: "hr-signoff", required: false, exitCode: 1, command: "npm run validate:hr-signoff -- --json" },
      { id: "storage-signoff", required: false, exitCode: 1, command: "npm run validate:storage-signoff -- --json" },
      { id: "drill-evidence", required: false, exitCode: 66, command: "npm run validate:drill-evidence -- --json" },
      { id: "doctor", required: false, exitCode: 1, command: "node scripts/commercial-doctor.mjs --json" },
      { id: "db-generate", required: true, exitCode: 0, command: "npm run db:generate" },
      { id: "test-server", required: true, exitCode: 0, command: "npm run test:server" },
      { id: "build", required: true, exitCode: 0, command: "npm run build" }
    ],
    targetProfile: {
      evidenceClass: "local-or-ci-validation",
      productionRuntime: false,
      productionEvidenceReady: false,
      e2eIncluded: true,
      apiBaseUrl: "http://127.0.0.1:8787",
      viteRequireApi: "1",
      viteDemoFallback: "0",
      database: {
        configured: true,
        host: "127.0.0.1",
        isLocal: true,
        source: "local-postgres-env",
        url: "postgresql://oa:***@127.0.0.1:55432/oa_commercial?schema=public"
      },
      signoffChecks: {
        productionEnv: false,
        secrets: false,
        hr: false,
        storage: false,
        drillEvidence: false
      },
      warnings: [
        "DATABASE_URL points at a local PostgreSQL host; this is not production database evidence."
      ]
    },
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

test("commercial gap report groups release blockers by owner with commands", () => {
  const report = buildCommercialGapReport(evidence(), {
    evidencePath: "reports/commercial-evidence/latest.json",
    generatedAt: "2026-05-30T01:00:00.000Z",
    requireE2e: false
  });

  assert.equal(report.releaseReady, false);
  assert.equal(report.summary.openGapCount, 5);
  assert.equal(report.summary.blockedGapCount, 5);
  assert.equal(report.summary.ownerCount, 5);
  assert.equal(report.summary.targetProfileEvidenceClass, "local-or-ci-validation");
  assert.equal(report.summary.targetProfileDatabaseTarget, "local-postgresql");
  assert.equal(report.targetProfile.database.target, "local-postgresql");
  assert.equal(report.targetProfile.database.source, "local-postgres-env");
  assert.equal("host" in report.targetProfile.database, false);
  assert(report.owners.some((owner) => (
    owner.owner === "Security lead"
    && owner.validationCommands.includes("npm run smoke:cloudflare -- --url https://deep-oa-hr.2445776963.workers.dev --json")
    && owner.validationCommands.includes("npm run doctor:cloudflare -- --repo 17602842555/HR --url https://deep-oa-hr.2445776963.workers.dev --json")
    && owner.validationCommands.includes("npm run smoke:no-domain-public -- --json")
  )));
  assert(report.gaps.find((gap) => gap.id === "GAP-004").validationCommands.includes("npm run restore:files -- <file-storage-backup.tar.gz> --yes"));
});

test("commercial gap report markdown is an action handoff and redacts local evidence path", () => {
  const rootDir = "/tmp/oa-commercial-project";
  const report = buildCommercialGapReport(evidence(), {
    evidencePath: `${rootDir}/reports/commercial-evidence/latest.json`,
    generatedAt: "2026-05-30T01:00:00.000Z",
    rootDir,
    requireE2e: false
  });
  const markdown = renderCommercialGapReportMarkdown(report);

  assert.match(markdown, /Commercial Gap Action Report/);
  assert.match(markdown, /\[PROJECT_ROOT\]\/reports\/commercial-evidence\/latest\.json/);
  assert.doesNotMatch(markdown, /\/tmp\/oa-commercial-project/);
  assert.match(markdown, /Owner Actions/);
  assert.match(markdown, /Target Profile/);
  assert.match(markdown, /Evidence class: local-or-ci-validation/);
  assert.match(markdown, /Database target: local-postgresql/);
  assert.match(markdown, /Warning: production-env exitCode=1/);
  assert.match(markdown, /npm run candidate:commercial -- --json/);
  assert.match(markdown, /Install\/start Docker Desktop/);
});

test("commercial gap report writes private timestamped and latest artifacts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "oa-commercial-gap-report-"));
  try {
    const report = buildCommercialGapReport(evidence(), {
      evidencePath: "reports/commercial-evidence/latest.json",
      generatedAt: "2026-05-30T01:00:00.000Z",
      requireE2e: false
    });
    const markdown = renderCommercialGapReportMarkdown(report);
    const written = writeCommercialGapReport(report, markdown, {
      outputDir: dir,
      generatedAt: "2026-05-30T01:00:00.000Z"
    });

    assert.equal(basename(written.jsonPath), "commercial-gap-report-20260530T010000Z.json");
    assert.equal(basename(written.markdownPath), "commercial-gap-report-20260530T010000Z.md");
    assert.equal(basename(written.latestJsonPath), "latest-gap-report.json");
    assert.equal(basename(written.latestMarkdownPath), "latest-gap-report.md");
    assert.equal(basename(written.ownerHandoff.latestManifestPath), "latest-owner-handoff-manifest.json");
    assert.equal(basename(written.ownerHandoff.latestIndexPath), "latest-owner-handoff.md");
	    assert.equal((await stat(written.jsonPath)).mode & 0o777, 0o600);
	    assert.equal((await stat(written.markdownPath)).mode & 0o777, 0o600);
	    assert.equal((await stat(dir)).mode & 0o777, 0o700);
	    assert.equal((await stat(written.ownerHandoff.directoryPath)).mode & 0o777, 0o700);
	    assert.equal((await stat(written.ownerHandoff.latestManifestPath)).mode & 0o777, 0o600);
    assert.equal((await stat(written.ownerHandoff.ownerFiles[0].path)).mode & 0o777, 0o600);
    assert.match(await readFile(written.latestMarkdownPath, "utf8"), /Commercial Gap Action Report/);
    assert.match(await readFile(written.ownerHandoff.latestIndexPath, "utf8"), /Commercial Gap Owner Handoff Index/);
    assert.equal(JSON.parse(await readFile(written.latestJsonPath, "utf8")).summary.openGapCount, 5);
    const manifest = JSON.parse(await readFile(written.ownerHandoff.latestManifestPath, "utf8"));
    assert.equal(manifest.releaseEvidence, false);
    assert.equal(manifest.ownerCount, 5);
    assert.equal(manifest.targetProfile.database.target, "local-postgresql");
    assert.deepEqual(manifest.warningChecks.map((check) => check.id), ["production-env", "doctor"]);
    const securityFile = written.ownerHandoff.ownerFiles.find((file) => file.owner === "Security lead");
    const securityText = await readFile(securityFile.path, "utf8");
    assert.match(securityText, /smoke:no-domain-public/);
    assert.match(securityText, /Current Target Profile/);
    assert.match(securityText, /VITE_REQUIRE_API=1, VITE_DEMO_FALLBACK=0/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("commercial gap report parser reads evidence output json and diagnostic flags", () => {
  const parsed = parseGapReportArgs([
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
