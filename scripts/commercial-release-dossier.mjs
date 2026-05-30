import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { auditCommercialReadiness } from "./commercial-readiness-audit.mjs";
import { redactEvidenceText, writePrivateTextFile } from "./commercial-evidence.mjs";

const defaultEvidencePath = "reports/commercial-evidence/latest.json";
const defaultOutputDir = "reports/commercial-evidence";

function resolvePath(path) {
  return isAbsolute(path) ? path : resolve(process.cwd(), path);
}

function slugTimestamp(value = new Date().toISOString()) {
  return value.replaceAll(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function ensurePrivateDir(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

function escapeTableCell(value) {
  return String(value ?? "")
    .replaceAll("\n", "<br>")
    .replaceAll("|", "\\|")
    .trim();
}

function statusLabel(ok) {
  return ok ? "PASS" : "BLOCKED";
}

function checkStatus(check) {
  if (!check) return "MISSING";
  if (check.exitCode === 0) return "PASS";
  return check.required ? "FAIL" : "WARNING";
}

function topItems(items, max = 12) {
  const values = Array.isArray(items) ? items : [];
  if (values.length <= max) return values;
  return [...values.slice(0, max), `... ${values.length - max} more`];
}

function redactDossierCommand(command, redactionContext) {
  return redactEvidenceText(command, redactionContext)
    .replace(/(--[^\s=]*(?:secret|password|token|credential|private|key)[^\s=]*=)([^\s]+)/gi, "$1[REDACTED]")
    .replace(/(--[^\s=]*(?:secret|password|token|credential|private|key)[^\s=]*\s+)([^\s]+)/gi, "$1[REDACTED]");
}

function checkRows(report, redactionContext) {
  return (Array.isArray(report?.checks) ? report.checks : []).map((check) => (
    `| ${escapeTableCell(check.id)} | ${check.required ? "yes" : "no"} | ${check.exitCode} | ${checkStatus(check)} | ${escapeTableCell(redactDossierCommand(check.command || "", redactionContext))} |`
  ));
}

function gapRows(readinessAudit) {
  return (Array.isArray(readinessAudit?.gaps) ? readinessAudit.gaps : []).map((gap) => {
    const blockers = gap.blockers?.length ? gap.blockers.join("<br>") : "-";
    return `| ${escapeTableCell(gap.id)} | ${escapeTableCell(gap.status)} | ${escapeTableCell(gap.owner || "-")} | ${gap.evidenceReady ? "yes" : "no"} | ${gap.ok ? "PASS" : "BLOCKED"} | ${escapeTableCell(blockers)} |`;
  });
}

function nextActionLines({ report, readinessAudit }) {
  const actions = [];
  const warningChecks = (report?.summary?.warningChecks || []).map((check) => `Fix evidence check \`${check.id}\` exitCode=${check.exitCode}.`);
  const requiredFailed = (report?.summary?.requiredFailed || []).map((check) => `Fix required check \`${check.id}\` exitCode=${check.exitCode}.`);
  const gapActions = (readinessAudit?.gaps || [])
    .filter((gap) => !gap.ok)
    .map((gap) => `Close ${gap.id} only after: ${gap.blockers.join("; ")}.`);
  const doctorActions = report?.summary?.readiness?.nextSteps || [];

  actions.push(...requiredFailed, ...warningChecks, ...gapActions, ...doctorActions);
  return [...new Set(actions)].map((action) => `- ${action}`);
}

function readinessLines(readiness) {
  if (!readiness) return ["- Doctor readiness: missing"];
  return [
    `- canRunDockerDrill: ${statusLabel(readiness.canRunDockerDrill === true)}`,
    `- canReachPostgres: ${statusLabel(readiness.canReachPostgres === true)}`,
    `- canVerifyDatabaseIntegrity: ${statusLabel(readiness.canVerifyDatabaseIntegrity === true)}`,
    `- canRunApiSmoke: ${statusLabel(readiness.canRunApiSmoke === true)}`,
    `- canRunFrontendApiSmoke: ${statusLabel(readiness.canRunFrontendApiSmoke === true)}`,
    `- hardBlockers: ${(readiness.hardBlockers || []).map((item) => item.name || item.message).join(", ") || "none"}`,
    `- warnings: ${(readiness.warnings || []).map((item) => item.name || item.message).join(", ") || "none"}`
  ];
}

function targetProfileLines(profile) {
  if (!profile) return ["- Target profile: missing"];
  const database = profile.database || {};
  const databaseTarget = database.configured !== true
    ? "unconfigured"
    : database.isLocal === true
      ? "local-postgresql"
      : "non-local-postgresql";
  const warningCount = Array.isArray(profile.warnings) ? profile.warnings.length : 0;
  return [
    `- evidenceClass: ${profile.evidenceClass || "unknown"}`,
    `- appEnv/nodeEnv: ${profile.appEnv || "unset"} / ${profile.nodeEnv || "unset"}`,
    `- productionRuntime: ${profile.productionRuntime === true ? "yes" : "no"}`,
    `- productionEvidenceReady: ${profile.productionEvidenceReady === true ? "yes" : "no"}`,
    `- databaseTarget: ${databaseTarget}`,
    `- databaseConfigured: ${database.configured === true ? "yes" : "no"}`,
    `- databaseIsLocal: ${database.isLocal === true ? "yes" : "no"}`,
    `- API base URL configured: ${profile.apiBaseUrl ? "yes" : "no"}`,
    `- E2E included: ${profile.e2eIncluded === true ? "yes" : "no"}`,
    `- API-required frontend: ${profile.viteRequireApi === "1" ? "yes" : "no"}`,
    `- demo fallback: ${profile.viteDemoFallback === "1" ? "enabled" : "disabled"}`,
    `- profile warning count: ${warningCount}`
  ];
}

export function buildReleaseDossier(report, {
  evidencePath = defaultEvidencePath,
  generatedAt = new Date().toISOString(),
  rootDir = process.cwd(),
  env = process.env,
  requireE2e = true
} = {}) {
  const readinessAudit = auditCommercialReadiness(report, { requireE2e });
  const requiredFailed = report?.summary?.requiredFailed || [];
  const warningChecks = report?.summary?.warningChecks || [];
  const openGaps = report?.summary?.openGaps || [];
  const diagnosticOnly = requireE2e === false;
  const evidenceReady = report?.summary?.ok === true && warningChecks.length === 0 && readinessAudit.ok;
  const releaseReady = !diagnosticOnly && evidenceReady;
  const releaseStatus = diagnosticOnly ? "DIAGNOSTIC_ONLY" : releaseReady ? "ACCEPTED" : "BLOCKED";
  const migrations = report?.artifacts?.migrations || [];
  const nextActions = nextActionLines({ report, readinessAudit });
  const redactionContext = { rootDir, env };
  const redactedEvidencePath = redactEvidenceText(evidencePath, redactionContext);
  if (diagnosticOnly) {
    nextActions.unshift("- Rerun without `--allow-missing-e2e`; diagnostic dossiers are not release acceptance evidence.");
  }

  const markdown = [
    "# Commercial Release Dossier",
    "",
    `Generated at: ${generatedAt}`,
    `Evidence file: ${redactedEvidencePath}`,
    `Evidence generated at: ${report?.generatedAt || "unknown"}`,
    `Release status: ${releaseStatus}`,
    `E2E required: ${requireE2e ? "yes" : "no"}`,
    "",
    "## Summary",
    "",
    `- Required check failures: ${requiredFailed.length}`,
    `- Warning check failures: ${warningChecks.length}`,
    `- Open known gaps: ${openGaps.length}`,
    `- Readiness audit blocked gaps: ${readinessAudit.summary.blockedGapCount}`,
    `- Ready-to-close gaps: ${readinessAudit.summary.readyToClose.join(", ") || "none"}`,
    "",
    "## Doctor Readiness",
    "",
    ...readinessLines(report?.summary?.readiness || null),
    "",
    "## Target Profile",
    "",
    ...targetProfileLines(report?.targetProfile || null),
    "",
    "## Evidence Checks",
    "",
    "| Check | Required | Exit Code | Status | Command |",
    "| --- | --- | --- | --- | --- |",
    ...checkRows(report, redactionContext),
    "",
    "## Gap Closure Audit",
    "",
    "| Gap | Status | Owner | Evidence Ready | Result | Blockers |",
    "| --- | --- | --- | --- | --- | --- |",
    ...gapRows(readinessAudit),
    "",
    "## Next Actions",
    "",
    ...(nextActions.length ? topItems(nextActions, 24) : ["- No release blockers were detected by the dossier generator."]),
    "",
    "## Artifact Snapshot",
    "",
    `- Migration count: ${migrations.length}`,
    `- Latest migration: ${migrations.at(-1) || "none"}`,
    `- Full checksum inventory: ${basename(evidencePath)}`,
    "",
    "## Release Rule",
    "",
    "Do not accept this release unless `npm run release:gate -- reports/commercial-evidence/latest.json --json` passes without `--allow-missing-e2e`."
  ].join("\n");

  return {
    releaseReady,
    readinessAudit,
    markdown,
    summary: {
      generatedAt,
      evidenceGeneratedAt: report?.generatedAt || null,
      releaseReady,
      releaseStatus,
      diagnosticOnly,
      requiredFailedCount: requiredFailed.length,
      warningCheckCount: warningChecks.length,
      openGapCount: openGaps.length,
      readinessBlockedGapCount: readinessAudit.summary.blockedGapCount,
      readyToClose: readinessAudit.summary.readyToClose
    }
  };
}

export function loadEvidence(path = defaultEvidencePath) {
  const evidencePath = resolvePath(path);
  if (!existsSync(evidencePath)) {
    throw new Error(`Commercial evidence file does not exist: ${evidencePath}`);
  }
  return {
    path: evidencePath,
    report: JSON.parse(readFileSync(evidencePath, "utf8"))
  };
}

export function writeReleaseDossier(markdown, {
  outputDir = defaultOutputDir,
  generatedAt = new Date().toISOString()
} = {}) {
  const resolvedOutputDir = resolvePath(outputDir);
  ensurePrivateDir(resolvedOutputDir);
  const outputPath = join(resolvedOutputDir, `commercial-release-dossier-${slugTimestamp(generatedAt)}.md`);
  const latestPath = join(resolvedOutputDir, "latest-dossier.md");
  writePrivateTextFile(outputPath, `${markdown}\n`);
  writePrivateTextFile(latestPath, `${markdown}\n`);
  return { outputPath, latestPath };
}

export function parseReleaseDossierArgs(argv = []) {
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
  const options = parseReleaseDossierArgs(argv);
  try {
    const { path, report } = loadEvidence(options.evidencePath);
    const generatedAt = new Date().toISOString();
    const dossier = buildReleaseDossier(report, {
      evidencePath: path,
      generatedAt,
      requireE2e: options.requireE2e
    });
    const written = options.write
      ? writeReleaseDossier(dossier.markdown, { outputDir: options.outputDir, generatedAt })
      : { outputPath: "", latestPath: "" };

    if (options.json) {
      console.log(JSON.stringify({
        ok: true,
        releaseReady: dossier.releaseReady,
        output: written.outputPath,
        latest: written.latestPath,
        summary: dossier.summary
      }, null, 2));
    } else if (options.write) {
      console.log(`Commercial release dossier written: ${written.outputPath}`);
      console.log(`Latest dossier: ${written.latestPath}`);
      console.log(`Release status: ${dossier.releaseReady ? "ACCEPTED" : "BLOCKED"}`);
    } else {
      console.log(dossier.markdown);
    }
  } catch (error) {
    if (options.json) {
      console.log(JSON.stringify({ ok: false, error: error.message }, null, 2));
    } else {
      console.error(error.message);
    }
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main();
}
