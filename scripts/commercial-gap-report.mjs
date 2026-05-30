import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { auditCommercialReadiness } from "./commercial-readiness-audit.mjs";
import { redactEvidenceText, writePrivateTextFile } from "./commercial-evidence.mjs";

const defaultEvidencePath = "reports/commercial-evidence/latest.json";
const defaultOutputDir = "reports/commercial-evidence";

function ensurePrivateDir(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

export const gapActionCatalog = Object.freeze({
  "GAP-001": Object.freeze({
    primaryActions: Object.freeze([
      "Point DATABASE_URL at reachable PostgreSQL and run migrations/seed in the target environment.",
      "Run the API and frontend in API-required mode, then archive commercial smoke and Playwright evidence."
    ]),
    validationCommands: Object.freeze([
      "npm run ci:commercial",
      "npm run doctor:commercial -- --json",
      "npm run evidence:commercial -- --full"
    ])
  }),
  "GAP-002": Object.freeze({
    primaryActions: Object.freeze([
      "Run the Docker compose backup/restore drill on a host with Docker Desktop or CI Docker.",
      "Archive database backup, file-storage backup, restore logs, checksums, and pre/post smoke evidence."
    ]),
    validationCommands: Object.freeze([
      "npm run drill:commercial",
      "npm run validate:drill-evidence -- commercial-evidence/latest-drill-summary.json --json",
      "npm run evidence:commercial -- --full"
    ])
  }),
  "GAP-003": Object.freeze({
    primaryActions: Object.freeze([
      "Create a real .env.production through the approved secret store.",
      "Replace example secrets/origins and collect Security plus Deployment approvals."
    ]),
    validationCommands: Object.freeze([
      "npm run validate:production-env -- .env.production --json",
      "npm run validate:secrets-signoff -- <signoff.json> --env .env.production --json",
      "npm run doctor:commercial -- --json"
    ])
  }),
  "GAP-004": Object.freeze({
    primaryActions: Object.freeze([
      "Provision production file storage on S3-compatible object storage or a separately backed persistent volume.",
      "Run a restore drill and prove restored attachment download smoke before owner signoff."
    ]),
    validationCommands: Object.freeze([
      "npm run backup:files",
      "npm run restore:files -- <file-storage-backup.tar.gz> --yes",
      "npm run validate:storage-signoff -- <signoff.json> --environment production --json"
    ])
  }),
  "GAP-005": Object.freeze({
    primaryActions: Object.freeze([
      "Have HR/Product review the masked personnel package and source counts.",
      "Replace the example HR signoff with a reviewed non-example signoff covering retention, export, and sensitive-field policy."
    ]),
    validationCommands: Object.freeze([
      "npm run prepare:hr-review -- --json",
      "npm run validate:hr-signoff -- <signoff.json> --source oa-dashboard.html --json",
      "npm run evidence:commercial -- --full"
    ])
  })
});

function resolvePath(path) {
  return isAbsolute(path) ? path : resolve(process.cwd(), path);
}

function slugTimestamp(value = new Date().toISOString()) {
  return value.replaceAll(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function escapeTableCell(value) {
  return String(value ?? "")
    .replaceAll("\n", "<br>")
    .replaceAll("|", "\\|")
    .trim();
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function checkMap(report) {
  return new Map((Array.isArray(report?.checks) ? report.checks : []).map((check) => [check.id, check]));
}

function checkStatus(check) {
  if (!check) return "missing";
  return check.exitCode === 0 ? "pass" : "failed";
}

function knownGapMap(report) {
  return new Map((Array.isArray(report?.knownGaps) ? report.knownGaps : []).map((gap) => [gap.id, gap]));
}

function sanitizeTargetProfile(profile) {
  if (!profile || typeof profile !== "object") return null;
  const database = profile.database || {};
  const databaseTarget = database.configured !== true
    ? "unconfigured"
    : database.isLocal === true
      ? "local-postgresql"
      : "non-local-postgresql";
  const signoffChecks = profile.signoffChecks && typeof profile.signoffChecks === "object"
    ? profile.signoffChecks
    : {};
  const warnings = Array.isArray(profile.warnings) ? profile.warnings.filter(Boolean) : [];

  return {
    evidenceClass: profile.evidenceClass || "unknown",
    productionRuntime: profile.productionRuntime === true,
    productionEvidenceReady: profile.productionEvidenceReady === true,
    e2eIncluded: profile.e2eIncluded === true,
    apiBaseUrl: profile.apiBaseUrl || "",
    viteRequireApi: String(profile.viteRequireApi || "unset"),
    viteDemoFallback: String(profile.viteDemoFallback || "unset"),
    database: {
      configured: database.configured === true,
      isLocal: database.isLocal === true,
      source: database.source || "",
      target: databaseTarget
    },
    signoffChecks: {
      cloudflareBackend: signoffChecks.cloudflareBackend === true,
      productionEnv: signoffChecks.productionEnv === true,
      secrets: signoffChecks.secrets === true,
      hr: signoffChecks.hr === true,
      storage: signoffChecks.storage === true,
      drillEvidence: signoffChecks.drillEvidence === true
    },
    warningCount: warnings.length,
    warnings
  };
}

function gapCatalog(id) {
  return gapActionCatalog[id] || { primaryActions: [], validationCommands: [] };
}

function normalizeGap({ auditGap, sourceGap, checks }) {
  const catalog = gapCatalog(auditGap.id);
  const relatedCheckIds = unique([
    ...(auditGap.evidence || []).filter((item) => item.type === "check").map((item) => item.id),
    ...auditGap.blockers
      .map((blocker) => String(blocker).match(/evidence check failed: ([^ ]+)/)?.[1] || String(blocker).match(/missing evidence check: ([^ ]+)/)?.[1])
  ]);

  return {
    id: auditGap.id,
    status: auditGap.status,
    owner: auditGap.owner || sourceGap?.owner || "",
    targetDate: auditGap.targetDate || sourceGap?.targetDate || "",
    label: auditGap.label,
    gap: sourceGap?.gap || "",
    exitCriteria: sourceGap?.exitCriteria || "",
    evidenceReady: auditGap.evidenceReady,
    canClose: auditGap.canClose,
    ok: auditGap.ok,
    blockers: auditGap.blockers || [],
    warnings: auditGap.warnings || [],
    primaryActions: [...catalog.primaryActions],
    validationCommands: [...catalog.validationCommands],
    relatedChecks: relatedCheckIds.map((id) => ({
      id,
      status: checkStatus(checks.get(id)),
      exitCode: checks.get(id)?.exitCode ?? null
    }))
  };
}

function groupByOwner(gaps) {
  const groups = new Map();
  gaps.forEach((gap) => {
    const owner = gap.owner || "Unassigned";
    const current = groups.get(owner) || {
      owner,
      gapIds: [],
      targetDates: [],
      primaryActions: [],
      validationCommands: [],
      blockers: []
    };
    current.gapIds.push(gap.id);
    current.targetDates.push(gap.targetDate);
    current.primaryActions.push(...gap.primaryActions);
    current.validationCommands.push(...gap.validationCommands);
    current.blockers.push(...gap.blockers.map((blocker) => `${gap.id}: ${blocker}`));
    groups.set(owner, current);
  });

  return [...groups.values()]
    .map((group) => ({
      ...group,
      gapIds: unique(group.gapIds),
      targetDates: unique(group.targetDates).sort(),
      primaryActions: unique(group.primaryActions),
      validationCommands: unique(group.validationCommands),
      blockers: unique(group.blockers)
    }))
    .sort((a, b) => a.owner.localeCompare(b.owner));
}

function markdownList(values, fallback = "-") {
  const items = Array.isArray(values) ? values.filter(Boolean) : [];
  if (!items.length) return [fallback];
  return items.map((item) => `- ${item}`);
}

function boolText(value) {
  if (value === true) return "yes";
  if (value === false) return "no";
  return "unknown";
}

function targetProfileLines(profile) {
  if (!profile) return ["- Target Profile: missing"];
  const signoffChecks = profile.signoffChecks || {};
  const signoffText = [
    `cloudflare-backend=${boolText(signoffChecks.cloudflareBackend)}`,
    `production-env=${boolText(signoffChecks.productionEnv)}`,
    `secrets=${boolText(signoffChecks.secrets)}`,
    `hr=${boolText(signoffChecks.hr)}`,
    `storage=${boolText(signoffChecks.storage)}`,
    `drill=${boolText(signoffChecks.drillEvidence)}`
  ].join(", ");

  return [
    `- Evidence class: ${profile.evidenceClass || "unknown"}`,
    `- Production runtime: ${boolText(profile.productionRuntime)}`,
    `- Production evidence ready: ${boolText(profile.productionEvidenceReady)}`,
    `- E2E included: ${boolText(profile.e2eIncluded)}`,
    `- Database target: ${profile.database?.target || "unknown"}${profile.database?.source ? ` (${profile.database.source})` : ""}`,
    `- API mode: VITE_REQUIRE_API=${profile.viteRequireApi || "unset"}, VITE_DEMO_FALLBACK=${profile.viteDemoFallback || "unset"}`,
    `- Signoff checks: ${signoffText}`,
    `- Warnings: ${profile.warningCount > 0 ? profile.warnings.join("; ") : "none"}`
  ];
}

function slugOwner(value, index = 0) {
  const slug = String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
  return slug || `owner-${index + 1}`;
}

function ownerHandoffFileName(owner, index) {
  return `${String(index + 1).padStart(2, "0")}-${slugOwner(owner.owner, index)}.md`;
}

function ownerGaps(report, owner) {
  const ids = new Set(owner.gapIds || []);
  return (report.gaps || []).filter((gap) => ids.has(gap.id));
}

function ownerRows(owners) {
  return owners.map((owner) => [
    "|",
    escapeTableCell(owner.owner),
    "|",
    escapeTableCell(owner.gapIds.join(", ")),
    "|",
    escapeTableCell(owner.targetDates.join(", ") || "-"),
    "|",
    escapeTableCell(owner.primaryActions.slice(0, 3).join("<br>") || "-"),
    "|",
    escapeTableCell(owner.validationCommands.slice(0, 4).join("<br>") || "-"),
    "|"
  ].join(" "));
}

function gapRows(gaps) {
  return gaps.map((gap) => [
    "|",
    escapeTableCell(gap.id),
    "|",
    escapeTableCell(gap.status),
    "|",
    escapeTableCell(gap.owner || "-"),
    "|",
    gap.evidenceReady ? "yes" : "no",
    "|",
    escapeTableCell(gap.blockers.join("<br>") || "-"),
    "|",
    escapeTableCell(gap.validationCommands.join("<br>") || "-"),
    "|"
  ].join(" "));
}

export function buildCommercialGapReport(report, {
  evidencePath = defaultEvidencePath,
  generatedAt = new Date().toISOString(),
  rootDir = process.cwd(),
  env = process.env,
  requireE2e = true
} = {}) {
  const readinessAudit = auditCommercialReadiness(report, { requireE2e });
  const sourceGaps = knownGapMap(report);
  const checks = checkMap(report);
  const gaps = (readinessAudit.gaps || [])
    .map((auditGap) => normalizeGap({ auditGap, sourceGap: sourceGaps.get(auditGap.id), checks }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const blockedGaps = gaps.filter((gap) => !gap.ok);
  const owners = groupByOwner(blockedGaps.length ? blockedGaps : gaps);
  const requiredFailed = report?.summary?.requiredFailed || [];
  const warningChecks = report?.summary?.warningChecks || [];
  const redactedEvidencePath = redactEvidenceText(evidencePath, { rootDir, env });
  const targetProfile = sanitizeTargetProfile(report?.targetProfile);
  const releaseReady = report?.summary?.ok === true
    && warningChecks.length === 0
    && requiredFailed.length === 0
    && readinessAudit.ok;

  const summary = {
    generatedAt,
    evidenceGeneratedAt: report?.generatedAt || null,
    evidencePath: redactedEvidencePath,
    releaseReady,
    openGapCount: gaps.filter((gap) => gap.status === "Open").length,
    blockedGapCount: blockedGaps.length,
    warningCheckCount: warningChecks.length,
    requiredFailedCount: requiredFailed.length,
    ownerCount: owners.length,
    readyToClose: readinessAudit.summary.readyToClose,
    targetProfileEvidenceClass: targetProfile?.evidenceClass || "missing",
    targetProfileDatabaseTarget: targetProfile?.database?.target || "missing",
    targetProfileWarningCount: targetProfile?.warningCount || 0
  };

  return {
    schemaVersion: 1,
    generatedAt,
    evidenceGeneratedAt: report?.generatedAt || null,
    evidencePath: redactedEvidencePath,
    releaseReady,
    summary,
    owners,
    gaps,
    targetProfile,
    readiness: report?.summary?.readiness || null,
    warningChecks,
    requiredFailed
  };
}

export function renderCommercialGapReportMarkdown(report) {
  const markdown = [
    "# Commercial Gap Action Report",
    "",
    `Generated at: ${report.generatedAt}`,
    `Evidence file: ${report.evidencePath}`,
    `Evidence generated at: ${report.evidenceGeneratedAt || "unknown"}`,
    `Release ready: ${report.releaseReady ? "yes" : "no"}`,
    "",
    "## Summary",
    "",
    `- Open gaps: ${report.summary.openGapCount}`,
    `- Blocked gaps: ${report.summary.blockedGapCount}`,
    `- Warning checks: ${report.summary.warningCheckCount}`,
    `- Required check failures: ${report.summary.requiredFailedCount}`,
    `- Responsible owner groups: ${report.summary.ownerCount}`,
    `- Ready to close after owner review: ${report.summary.readyToClose.join(", ") || "none"}`,
    "",
    "## Target Profile",
    "",
    ...targetProfileLines(report.targetProfile),
    "",
    "## Evidence Check Failures",
    "",
    ...markdownList(report.requiredFailed.map((check) => `Required: ${check.id} exitCode=${check.exitCode}`), "- Required checks: none"),
    ...markdownList(report.warningChecks.map((check) => `Warning: ${check.id} exitCode=${check.exitCode}`), "- Warning checks: none"),
    "",
    "## Owner Actions",
    "",
    "| Owner | Gaps | Target Dates | Primary Actions | Validation Commands |",
    "| --- | --- | --- | --- | --- |",
    ...ownerRows(report.owners),
    "",
    "## Gap Details",
    "",
    "| Gap | Status | Owner | Evidence Ready | Blockers | Validation Commands |",
    "| --- | --- | --- | --- | --- | --- |",
    ...gapRows(report.gaps),
    "",
    "## Doctor Next Steps",
    "",
    ...markdownList(report.readiness?.nextSteps || []),
    "",
    "## Release Rule",
    "",
    "This report is an action handoff only. Accept a release only when `npm run candidate:commercial -- --json` and `npm run release:gate -- reports/commercial-evidence/latest.json --json` pass without diagnostic flags."
  ];
  return `${markdown.join("\n")}\n`;
}

export function buildOwnerHandoffManifest(report, {
  directoryName = "",
  ownerFiles = []
} = {}) {
  return {
    schemaVersion: 1,
    kind: "commercial-gap-owner-handoff",
    generatedAt: report.generatedAt,
    evidenceGeneratedAt: report.evidenceGeneratedAt || null,
    releaseReady: report.releaseReady === true,
    releaseEvidence: false,
    releaseUse: "Action handoff only. It is not release evidence and cannot replace release gate output.",
    targetProfile: report.targetProfile || null,
    warningChecks: report.warningChecks.map((check) => ({ id: check.id, exitCode: check.exitCode })),
    requiredFailed: report.requiredFailed.map((check) => ({ id: check.id, exitCode: check.exitCode })),
    directoryName,
    ownerCount: report.owners.length,
    owners: report.owners.map((owner, index) => ({
      owner: owner.owner,
      file: ownerFiles[index]?.fileName || ownerHandoffFileName(owner, index),
      gapIds: owner.gapIds,
      targetDates: owner.targetDates,
      blockerCount: owner.blockers.length,
      validationCommandCount: owner.validationCommands.length
    }))
  };
}

export function renderOwnerHandoffMarkdown(report, owner) {
  const gaps = ownerGaps(report, owner);
  const markdown = [
    "# Commercial Gap Owner Handoff",
    "",
    `Owner: ${owner.owner}`,
    `Generated at: ${report.generatedAt}`,
    `Evidence generated at: ${report.evidenceGeneratedAt || "unknown"}`,
    `Release ready: ${report.releaseReady ? "yes" : "no"}`,
    "Release evidence: no, action handoff only",
    "",
    "## Scope",
    "",
    `- Gap IDs: ${owner.gapIds.join(", ") || "-"}`,
    `- Target dates: ${owner.targetDates.join(", ") || "-"}`,
    `- Blockers: ${owner.blockers.length}`,
    `- Validation commands: ${owner.validationCommands.length}`,
    "",
    "## Current Target Profile",
    "",
    ...targetProfileLines(report.targetProfile),
    "",
    "## Current Evidence Check Failures",
    "",
    ...markdownList(report.requiredFailed.map((check) => `Required: ${check.id} exitCode=${check.exitCode}`), "- Required checks: none"),
    ...markdownList(report.warningChecks.map((check) => `Warning: ${check.id} exitCode=${check.exitCode}`), "- Warning checks: none"),
    "",
    "## Primary Actions",
    "",
    ...markdownList(owner.primaryActions, "- No owner actions are currently listed."),
    "",
    "## Validation Commands",
    "",
    ...markdownList(owner.validationCommands, "- No validation command is currently listed."),
    "",
    "## Current Blockers",
    "",
    ...markdownList(owner.blockers, "- No current blockers."),
    "",
    "## Gap Details",
    "",
    "| Gap | Status | Target Date | Evidence Ready | Exit Criteria |",
    "| --- | --- | --- | --- | --- |",
    ...gaps.map((gap) => [
      "|",
      escapeTableCell(gap.id),
      "|",
      escapeTableCell(gap.status),
      "|",
      escapeTableCell(gap.targetDate || "-"),
      "|",
      gap.evidenceReady ? "yes" : "no",
      "|",
      escapeTableCell(gap.exitCriteria || "-"),
      "|"
    ].join(" ")),
    "",
    "## Release Rule",
    "",
    "This owner handoff is for closure work only. Accept a release only when `npm run candidate:commercial -- --json` and `npm run release:gate -- reports/commercial-evidence/latest.json --json` pass without diagnostic flags."
  ];
  return `${markdown.join("\n")}\n`;
}

export function renderOwnerHandoffIndexMarkdown(manifest) {
  const markdown = [
    "# Commercial Gap Owner Handoff Index",
    "",
    `Generated at: ${manifest.generatedAt}`,
    `Evidence generated at: ${manifest.evidenceGeneratedAt || "unknown"}`,
    `Release ready: ${manifest.releaseReady ? "yes" : "no"}`,
    "Release evidence: no, action handoff only",
    "",
    "## Target Profile",
    "",
    ...targetProfileLines(manifest.targetProfile),
    "",
    "| Owner | File | Gaps | Target Dates | Blockers | Validation Commands |",
    "| --- | --- | --- | --- | --- | --- |",
    ...manifest.owners.map((owner) => [
      "|",
      escapeTableCell(owner.owner),
      "|",
      escapeTableCell(owner.file),
      "|",
      escapeTableCell((owner.gapIds || []).join(", ") || "-"),
      "|",
      escapeTableCell((owner.targetDates || []).join(", ") || "-"),
      "|",
      owner.blockerCount,
      "|",
      owner.validationCommandCount,
      "|"
    ].join(" ")),
    "",
    "This index is an action handoff only. It is not release evidence."
  ];
  return `${markdown.join("\n")}\n`;
}

export function loadGapReportEvidence(path = defaultEvidencePath) {
  const evidencePath = resolvePath(path);
  if (!existsSync(evidencePath)) {
    throw new Error(`Commercial evidence file does not exist: ${evidencePath}`);
  }
  return {
    path: evidencePath,
    report: JSON.parse(readFileSync(evidencePath, "utf8"))
  };
}

export function writeCommercialGapReport(report, markdown, {
  outputDir = defaultOutputDir,
  generatedAt = report.generatedAt || new Date().toISOString()
} = {}) {
	  const resolvedOutputDir = resolvePath(outputDir);
	  ensurePrivateDir(resolvedOutputDir);
  const stamp = slugTimestamp(generatedAt);
  const jsonPath = join(resolvedOutputDir, `commercial-gap-report-${stamp}.json`);
  const markdownPath = join(resolvedOutputDir, `commercial-gap-report-${stamp}.md`);
  const latestJsonPath = join(resolvedOutputDir, "latest-gap-report.json");
  const latestMarkdownPath = join(resolvedOutputDir, "latest-gap-report.md");
  writePrivateTextFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  writePrivateTextFile(markdownPath, markdown);
  writePrivateTextFile(latestJsonPath, `${JSON.stringify(report, null, 2)}\n`);
  writePrivateTextFile(latestMarkdownPath, markdown);
  const ownerHandoff = writeCommercialOwnerHandoff(report, { outputDir, generatedAt });
  return { jsonPath, markdownPath, latestJsonPath, latestMarkdownPath, ownerHandoff };
}

export function writeCommercialOwnerHandoff(report, {
  outputDir = defaultOutputDir,
  generatedAt = report.generatedAt || new Date().toISOString()
} = {}) {
	  const resolvedOutputDir = resolvePath(outputDir);
	  ensurePrivateDir(resolvedOutputDir);
	  const stamp = slugTimestamp(generatedAt);
	  const directoryName = `commercial-owner-handoff-${stamp}`;
	  const directoryPath = join(resolvedOutputDir, directoryName);
	  ensurePrivateDir(directoryPath);

  const ownerFiles = report.owners.map((owner, index) => {
    const fileName = ownerHandoffFileName(owner, index);
    const filePath = join(directoryPath, fileName);
    writePrivateTextFile(filePath, renderOwnerHandoffMarkdown(report, owner));
    return { owner: owner.owner, fileName, path: filePath };
  });
  const manifest = buildOwnerHandoffManifest(report, { directoryName, ownerFiles });
  const indexMarkdown = renderOwnerHandoffIndexMarkdown(manifest);
  const manifestPath = join(directoryPath, "manifest.json");
  const indexPath = join(directoryPath, "index.md");
  const latestManifestPath = join(resolvedOutputDir, "latest-owner-handoff-manifest.json");
  const latestIndexPath = join(resolvedOutputDir, "latest-owner-handoff.md");
  writePrivateTextFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  writePrivateTextFile(indexPath, indexMarkdown);
  writePrivateTextFile(latestManifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  writePrivateTextFile(latestIndexPath, indexMarkdown);
  return { directoryPath, indexPath, latestIndexPath, latestManifestPath, manifestPath, ownerFiles };
}

export function parseGapReportArgs(argv = []) {
  const options = {
    evidencePath: defaultEvidencePath,
    outputDir: defaultOutputDir,
    json: argv.includes("--json"),
    write: !argv.includes("--stdout"),
    requireE2e: !argv.includes("--allow-missing-e2e")
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
  const options = parseGapReportArgs(argv);
  try {
    const { path, report: evidence } = loadGapReportEvidence(options.evidencePath);
    const generatedAt = new Date().toISOString();
    const report = buildCommercialGapReport(evidence, {
      evidencePath: path,
      generatedAt,
      requireE2e: options.requireE2e
    });
    const markdown = renderCommercialGapReportMarkdown(report);
    const written = options.write
      ? writeCommercialGapReport(report, markdown, { outputDir: options.outputDir, generatedAt })
      : { jsonPath: "", markdownPath: "", latestJsonPath: "", latestMarkdownPath: "" };

    if (options.json) {
      console.log(JSON.stringify({
        ok: true,
        releaseReady: report.releaseReady,
        output: written.jsonPath,
        markdown: written.markdownPath,
        latest: written.latestJsonPath,
        latestMarkdown: written.latestMarkdownPath,
        ownerHandoff: written.ownerHandoff,
        summary: report.summary
      }, null, 2));
    } else if (options.write) {
      console.log(`Commercial gap report written: ${written.jsonPath}`);
      console.log(`Markdown handoff written: ${written.markdownPath}`);
    } else {
      process.stdout.write(markdown);
    }
    process.exitCode = 0;
  } catch (error) {
    if (options.json) {
      console.log(JSON.stringify({ ok: false, error: error.message }, null, 2));
    } else {
      console.error(error.message);
    }
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
