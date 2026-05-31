import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const defaultEvidencePath = "reports/commercial-evidence/latest.json";

const closedStatuses = new Set(["Closed", "Mitigated"]);
const knownStatuses = new Set(["Open", ...closedStatuses]);

export const gapClosureRules = Object.freeze({
  "GAP-001": Object.freeze({
    label: "PostgreSQL, API, frontend smoke readiness",
    checks: Object.freeze(["db-generate", "test-server", "build"]),
    e2eChecks: Object.freeze(["e2e"]),
    readinessFlags: Object.freeze(["canReachPostgres", "canVerifyDatabaseIntegrity", "canRunApiSmoke", "canRunFrontendApiSmoke"])
  }),
  "GAP-002": Object.freeze({
    label: "Docker compose recovery drill",
    checks: Object.freeze(["drill-evidence"]),
    readinessFlags: Object.freeze(["canRunDockerDrill"])
  }),
  "GAP-003": Object.freeze({
    label: "No-domain GitHub Pages and Cloudflare native Worker/D1 deployment",
    checks: Object.freeze(["cloudflare-deployment", "no-domain-public"]),
    readinessFlags: Object.freeze([])
  }),
  "GAP-004": Object.freeze({
    label: "Production file storage signoff",
    checks: Object.freeze(["storage-signoff", "drill-evidence"]),
    readinessFlags: Object.freeze([])
  }),
  "GAP-005": Object.freeze({
    label: "HR/Product personnel data signoff",
    checks: Object.freeze(["hr-signoff"]),
    readinessFlags: Object.freeze([])
  })
});

function resolvePath(path) {
  return isAbsolute(path) ? path : resolve(process.cwd(), path);
}

function checkMap(report) {
  return new Map((Array.isArray(report?.checks) ? report.checks : []).map((check) => [check.id, check]));
}

function ruleChecks(rule, options = {}) {
  return [
    ...(rule.checks || []),
    ...(options.requireE2e === false ? [] : (rule.e2eChecks || []))
  ];
}

function evaluateRuleEvidence({ id, rule, report, options = {} }) {
  const checks = checkMap(report);
  const readiness = report?.summary?.readiness || null;
  const blockers = [];
  const evidence = [];

  ruleChecks(rule, options).forEach((checkId) => {
    const check = checks.get(checkId);
    if (!check) {
      blockers.push(`missing evidence check: ${checkId}`);
      return;
    }
    if (check.exitCode !== 0) {
      blockers.push(`evidence check failed: ${checkId} exitCode=${check.exitCode}`);
      return;
    }
    evidence.push({ type: "check", id: checkId });
  });

  const readinessFlags = options.backendMode === "native-worker" ? [] : (rule.readinessFlags || []);
  readinessFlags.forEach((flag) => {
    if (!readiness) {
      blockers.push(`missing doctor readiness flag: ${flag}`);
      return;
    }
    if (readiness[flag] !== true) {
      blockers.push(`doctor readiness flag is not green: ${flag}`);
      return;
    }
    evidence.push({ type: "readiness", id: flag });
  });

  return {
    id,
    label: rule.label,
    evidenceReady: blockers.length === 0,
    evidence,
    blockers
  };
}

export function auditCommercialReadiness(report, options = {}) {
  const failures = [];
  const warnings = [];
  const gaps = Array.isArray(report?.knownGaps) ? report.knownGaps : [];
  const gapById = new Map(gaps.map((gap) => [gap.id, gap]));
  const ruleIds = Object.keys(gapClosureRules);
  const auditedIds = new Set([...ruleIds, ...gaps.map((gap) => gap.id)].sort());
  const gapsAudit = [];

  if (!report || report.schemaVersion !== 1) {
    failures.push("Evidence report must use schemaVersion 1 before readiness audit can run.");
  }

  auditedIds.forEach((id) => {
    const gap = gapById.get(id) || null;
    const rule = gapClosureRules[id] || null;
    const status = gap?.status || "Missing";
    const blockers = [];
    const itemWarnings = [];
    const evidenceResult = rule
      ? evaluateRuleEvidence({ id, rule, report, options })
      : { id, label: "Unmapped commercial gap", evidenceReady: false, evidence: [], blockers: [`no closure rule configured for ${id}`] };

    blockers.push(...evidenceResult.blockers);

    if (!gap) {
      if (!evidenceResult.evidenceReady) {
        blockers.push(`${id} is missing from docs/KNOWN_GAPS.md before its closure evidence is green`);
      } else {
        itemWarnings.push(`${id} is not listed in docs/KNOWN_GAPS.md; keep archived owner approval with this green evidence`);
      }
    } else if (!knownStatuses.has(status)) {
      blockers.push(`${id} has unsupported status: ${status}`);
    } else if (status === "Open") {
      blockers.push(`${id} remains Open`);
      if (evidenceResult.evidenceReady) {
        itemWarnings.push(`${id} has green closure evidence and is ready for owner review`);
      }
    } else if (closedStatuses.has(status) && !evidenceResult.evidenceReady) {
      blockers.push(`${id} is marked ${status} but closure evidence is not green`);
    }

    if (!rule) blockers.push(`no closure rule configured for ${id}`);

    const auditItem = {
      id,
      status,
      owner: gap?.owner || "",
      targetDate: gap?.targetDate || "",
      label: evidenceResult.label,
      evidenceReady: evidenceResult.evidenceReady,
      canClose: evidenceResult.evidenceReady,
      ok: blockers.length === 0,
      blockers: [...new Set(blockers)],
      warnings: itemWarnings,
      evidence: evidenceResult.evidence
    };
    gapsAudit.push(auditItem);
    auditItem.blockers.forEach((blocker) => failures.push(`${id}: ${blocker}`));
    itemWarnings.forEach((warning) => warnings.push(warning));
  });

  return {
    ok: failures.length === 0,
    failures,
    warnings,
    summary: {
      generatedAt: report?.generatedAt || null,
      auditedGapCount: gapsAudit.length,
      openGapCount: gapsAudit.filter((gap) => gap.status === "Open").length,
      blockedGapCount: gapsAudit.filter((gap) => !gap.ok).length,
      readyToClose: gapsAudit.filter((gap) => gap.status === "Open" && gap.evidenceReady).map((gap) => gap.id)
    },
    gaps: gapsAudit
  };
}

export function loadReadinessEvidence(path = defaultEvidencePath) {
  const evidencePath = resolvePath(path);
  if (!existsSync(evidencePath)) {
    throw new Error(`Commercial evidence file does not exist: ${evidencePath}`);
  }
  return {
    path: evidencePath,
    report: JSON.parse(readFileSync(evidencePath, "utf8"))
  };
}

export function parseReadinessAuditArgs(argv = []) {
  const options = {
    evidencePath: defaultEvidencePath,
    json: argv.includes("--json"),
    requireE2e: !argv.includes("--allow-missing-e2e")
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--evidence") {
      options.evidencePath = argv[index + 1] || options.evidencePath;
      index += 1;
    } else if (!arg.startsWith("--")) {
      options.evidencePath = arg;
    }
  }
  return options;
}

async function main(argv = process.argv.slice(2)) {
  const options = parseReadinessAuditArgs(argv);
  try {
    const { path, report } = loadReadinessEvidence(options.evidencePath);
    const result = auditCommercialReadiness(report, { requireE2e: options.requireE2e });
    const payload = { path, ...result };

    if (options.json) {
      console.log(JSON.stringify(payload, null, 2));
    } else if (result.ok) {
      console.log(`Commercial readiness audit passed: ${path}`);
      result.warnings.forEach((warning) => console.warn(`Warning: ${warning}`));
    } else {
      console.error(`Commercial readiness audit failed: ${path}`);
      result.failures.forEach((failure) => console.error(`- ${failure}`));
      result.warnings.forEach((warning) => console.warn(`Warning: ${warning}`));
    }
    process.exitCode = result.ok ? 0 : 1;
  } catch (error) {
    if (options.json) {
      console.log(JSON.stringify({ ok: false, failures: [error.message], warnings: [] }, null, 2));
    } else {
      console.error(error.message);
    }
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main();
}
