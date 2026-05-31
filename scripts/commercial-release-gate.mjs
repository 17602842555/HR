import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { auditCommercialReadiness } from "./commercial-readiness-audit.mjs";
import { redactEvidenceText } from "./commercial-evidence.mjs";

const defaultEvidencePath = "reports/commercial-evidence/latest.json";

const baseRequiredChecks = [
  "preflight",
  "migrations",
  "supply-chain",
  "sbom",
  "brand",
  "contract",
  "hr-review-prep",
  "evidence-permissions",
  "production-env",
  "cloudflare-backend",
  "cloudflare-deployment",
  "no-domain-public",
  "secrets-signoff",
  "hr-signoff",
  "storage-signoff",
  "drill-evidence",
  "doctor",
  "db-generate",
  "test-server",
  "build"
];

const readinessFlags = [
  "canRunDockerDrill",
  "canReachPostgres",
  "canVerifyDatabaseIntegrity",
  "canRunApiSmoke",
  "canRunFrontendApiSmoke"
];

const defaultMaxEvidenceAgeHours = 24;
const futureClockSkewMinutes = 5;

function resolvePath(path) {
  return isAbsolute(path) ? path : resolve(process.cwd(), path);
}

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function evidenceAge(report, now = new Date()) {
  const generatedAt = report?.generatedAt ? new Date(report.generatedAt) : null;
  const nowDate = new Date(now);
  if (!generatedAt || Number.isNaN(generatedAt.getTime())) {
    return { valid: false, ageHours: null, futureSkewMinutes: null };
  }
  const ageMs = nowDate.getTime() - generatedAt.getTime();
  return {
    valid: true,
    ageHours: ageMs / 3600000,
    futureSkewMinutes: ageMs < 0 ? Math.abs(ageMs) / 60000 : 0
  };
}

function validateTargetProfile(profile) {
  const failures = [];
  const warnings = [];

  if (!profile || typeof profile !== "object") {
    failures.push("Evidence targetProfile is required for release.");
    return { failures, warnings };
  }

  if (profile.evidenceClass !== "production-release-evidence") {
    failures.push(`Evidence targetProfile.evidenceClass must be production-release-evidence; got ${profile.evidenceClass || "missing"}.`);
  }
  if (profile.productionRuntime !== true) {
    failures.push("Evidence targetProfile.productionRuntime must be true.");
  }
  if (profile.productionEvidenceReady !== true) {
    failures.push("Evidence targetProfile.productionEvidenceReady must be true.");
  }
  if (profile.viteRequireApi !== "1") {
    failures.push("Evidence targetProfile.viteRequireApi must be 1.");
  }
  if (profile.viteDemoFallback !== "0") {
    failures.push("Evidence targetProfile.viteDemoFallback must be 0.");
  }

  const database = profile.database || {};
  if (profile.backendMode === "native-worker") {
    if (database.target !== "cloudflare-d1") {
      failures.push("Evidence targetProfile.database.target must be cloudflare-d1 for native Worker release evidence.");
    }
    if (database.d1Configured !== true) {
      failures.push("Evidence targetProfile.database.d1Configured must be true for native Worker release evidence.");
    }
  } else {
    if (database.configured !== true) {
      failures.push("Evidence targetProfile.database.configured must be true.");
    }
    if (database.isLocal === true) {
      failures.push("Evidence targetProfile.database.isLocal must be false for release evidence.");
    }
    if (!database.host) {
      failures.push("Evidence targetProfile.database.host is required.");
    }
  }

  if (Array.isArray(profile.warnings) && profile.warnings.length > 0) {
    warnings.push(`Evidence targetProfile has warnings: ${profile.warnings.join("; ")}`);
  }

  return { failures, warnings };
}

function releaseRequiredChecks(profile, requireE2e) {
  const nativeWorker = profile?.backendMode === "native-worker";
  const ids = baseRequiredChecks.filter((id) => {
    if (nativeWorker) return !["production-env", "cloudflare-backend", "doctor", "drill-evidence"].includes(id);
    return !["cloudflare-deployment", "no-domain-public"].includes(id);
  });
  return requireE2e ? [...ids, "e2e"] : ids;
}

function releaseBlockingWarningCheck(check, profile) {
  if (profile?.backendMode === "native-worker") {
    return !["production-env", "cloudflare-backend", "doctor", "drill-evidence"].includes(check.id);
  }
  return !["cloudflare-deployment", "no-domain-public"].includes(check.id);
}

export function loadReleaseEvidence(path = defaultEvidencePath) {
  const evidencePath = resolvePath(path);
  if (!existsSync(evidencePath)) {
    throw new Error(`Commercial evidence file does not exist: ${evidencePath}`);
  }
  return {
    path: evidencePath,
    report: JSON.parse(readFileSync(evidencePath, "utf8"))
  };
}

export function evaluateReleaseGate(report, options = {}) {
  const requireE2e = options.requireE2e !== false;
  const maxEvidenceAgeHours = positiveNumber(options.maxEvidenceAgeHours, defaultMaxEvidenceAgeHours);
  const age = evidenceAge(report, options.now || new Date());
  const failures = [];
  const warnings = [];
  const checks = Array.isArray(report?.checks) ? report.checks : [];
  const knownGaps = Array.isArray(report?.knownGaps) ? report.knownGaps : [];
  const checkById = new Map(checks.map((check) => [check.id, check]));
  const targetProfileResult = validateTargetProfile(report?.targetProfile);
  const requiredChecks = releaseRequiredChecks(report?.targetProfile, requireE2e);

  if (!report || report.schemaVersion !== 1) {
    failures.push("Evidence report must use schemaVersion 1.");
  }
  if (report?.evidenceMode !== "full") {
    failures.push(`Evidence report evidenceMode must be full for release; got ${report?.evidenceMode || "missing"}.`);
  }
  if (!report?.generatedAt) {
    failures.push("Evidence report is missing generatedAt.");
  }
  if (!age.valid) {
    failures.push("Evidence report generatedAt must be a valid ISO timestamp.");
  } else {
    if (age.futureSkewMinutes > futureClockSkewMinutes) {
      failures.push(`Evidence report generatedAt is in the future by ${age.futureSkewMinutes.toFixed(2)} minutes.`);
    }
    if (age.ageHours > maxEvidenceAgeHours) {
      failures.push(`Evidence report is stale: age ${age.ageHours.toFixed(2)}h exceeds ${maxEvidenceAgeHours}h.`);
    }
  }

  requiredChecks.forEach((id) => {
    if (!checkById.has(id)) failures.push(`Evidence report is missing required release check: ${id}.`);
  });

  const requiredFailed = checks.filter((check) => check.required && check.exitCode !== 0);
  requiredFailed.forEach((check) => {
    failures.push(`Required evidence check failed: ${check.id} exitCode=${check.exitCode}.`);
  });

  const warningChecks = checks.filter((check) => (
    !check.required
    && !check.diagnostic
    && check.exitCode !== 0
    && releaseBlockingWarningCheck(check, report?.targetProfile)
  ));
  warningChecks.forEach((check) => {
    failures.push(`Release cannot proceed while warning check is failing: ${check.id} exitCode=${check.exitCode}.`);
  });

  const openGaps = knownGaps.filter((gap) => gap.status === "Open");
  openGaps.forEach((gap) => {
    failures.push(`Release gap remains open: ${gap.id} (${gap.owner || "unowned"}).`);
  });

  const readiness = report?.summary?.readiness;
  if (report?.targetProfile?.backendMode === "native-worker") {
    const cloudflareDeployment = checkById.get("cloudflare-deployment")?.parsedJson || {};
    const noDomainPublic = checkById.get("no-domain-public")?.parsedJson || {};
    if (cloudflareDeployment.summary?.nativeWorkerReady !== true) {
      failures.push("Cloudflare deployment evidence must report nativeWorkerReady=true.");
    }
    if (cloudflareDeployment.summary?.d1PersistenceReady !== true) {
      failures.push("Cloudflare deployment evidence must report d1PersistenceReady=true.");
    }
    if (noDomainPublic.ok !== true) {
      failures.push("No-domain public smoke evidence must pass.");
    }
    if (noDomainPublic.summary?.browserSessionReady !== true) {
      failures.push("No-domain public smoke evidence must prove a real browser login session against the Worker.");
    }
    if (noDomainPublic.options?.expectedSha && noDomainPublic.summary?.frontendShaReady !== true) {
      failures.push("No-domain public smoke evidence must prove GitHub Pages is serving the expected frontend release SHA.");
    }
  } else if (!readiness) {
    failures.push("Doctor readiness summary is required for release.");
  } else {
    readinessFlags.forEach((flag) => {
      if (readiness[flag] !== true) failures.push(`Doctor readiness flag is not green: ${flag}.`);
    });
    if (Array.isArray(readiness.hardBlockers) && readiness.hardBlockers.length > 0) {
      failures.push(`Doctor readiness has hard blockers: ${readiness.hardBlockers.map((item) => item.name || item.message).join(", ")}.`);
    }
    if (Array.isArray(readiness.warnings) && readiness.warnings.length > 0) {
      warnings.push(`Doctor readiness has warnings: ${readiness.warnings.map((item) => item.name || item.message).join(", ")}.`);
    }
  }

  if (report?.summary?.ok !== true) {
    failures.push("Evidence summary is not ok.");
  }

  targetProfileResult.failures.forEach((failure) => failures.push(failure));
  targetProfileResult.warnings.forEach((warning) => warnings.push(warning));

  const readinessAudit = auditCommercialReadiness(report, {
    backendMode: report?.targetProfile?.backendMode,
    requireE2e
  });
  readinessAudit.failures.forEach((failure) => {
    failures.push(`Readiness audit failed: ${failure}`);
  });
  readinessAudit.warnings.forEach((warning) => {
    warnings.push(`Readiness audit warning: ${warning}`);
  });

  return {
    ok: failures.length === 0,
    failures,
    warnings,
    summary: {
      evidenceMode: report?.evidenceMode || null,
      generatedAt: report?.generatedAt || null,
      evidenceAgeHours: age.ageHours,
      maxEvidenceAgeHours,
      requiredChecks,
      checkCount: checks.length,
      openGapCount: openGaps.length,
      targetProfile: report?.targetProfile || null,
      readiness: readiness || null,
      readinessAudit: readinessAudit.summary
    }
  };
}

export function parseReleaseGateArgs(argv = []) {
  const options = {
    evidencePath: defaultEvidencePath,
    json: argv.includes("--json"),
    maxEvidenceAgeHours: defaultMaxEvidenceAgeHours,
    requireE2e: !argv.includes("--allow-missing-e2e")
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--evidence") {
      options.evidencePath = argv[index + 1] || options.evidencePath;
      index += 1;
    } else if (arg === "--max-evidence-age-hours") {
      options.maxEvidenceAgeHours = positiveNumber(argv[index + 1], options.maxEvidenceAgeHours);
      index += 1;
    } else if (!arg.startsWith("--")) {
      options.evidencePath = arg;
    }
  }
  return options;
}

function redactReleaseGatePayload(payload, context = {}) {
  if (typeof payload === "string") return redactEvidenceText(payload, context);
  if (!payload || typeof payload !== "object") return payload;
  if (Array.isArray(payload)) return payload.map((item) => redactReleaseGatePayload(item, context));
  return Object.fromEntries(Object.entries(payload).map(([key, value]) => [
    key,
    redactReleaseGatePayload(value, context)
  ]));
}

function summarizeTargetProfileForCli(profile) {
  if (!profile || typeof profile !== "object") return profile || null;
  const database = profile.database || {};
  const databaseTarget = database.configured !== true
    ? "unconfigured"
    : database.isLocal === true
      ? "local-postgresql"
      : "non-local-postgresql";
  const warnings = Array.isArray(profile.warnings) ? profile.warnings.filter(Boolean) : [];

  return {
    evidenceClass: profile.evidenceClass || "unknown",
    productionRuntime: profile.productionRuntime === true,
    productionEvidenceReady: profile.productionEvidenceReady === true,
    e2eIncluded: profile.e2eIncluded === true,
    database: {
      configured: database.configured === true,
      isLocal: database.isLocal === true,
      source: database.source || "",
      target: databaseTarget
    },
    signoffChecks: profile.signoffChecks || {},
    viteRequireApi: String(profile.viteRequireApi || "unset"),
    viteDemoFallback: String(profile.viteDemoFallback || "unset"),
    warningCount: warnings.length,
    warnings
  };
}

export function buildReleaseGateCliPayload({
  env = process.env,
  path,
  result,
  rootDir = process.cwd()
} = {}) {
  const redactionContext = { env, rootDir };
  const redactedResult = redactReleaseGatePayload(result || {}, redactionContext);
  if (redactedResult?.summary?.targetProfile) {
    redactedResult.summary.targetProfile = summarizeTargetProfileForCli(redactedResult.summary.targetProfile);
  }
  return {
    path: redactEvidenceText(path || "", redactionContext),
    ...redactedResult
  };
}

async function main(argv = process.argv.slice(2)) {
  const options = parseReleaseGateArgs(argv);
  try {
    const { path, report } = loadReleaseEvidence(options.evidencePath);
    const result = evaluateReleaseGate(report, {
      maxEvidenceAgeHours: options.maxEvidenceAgeHours,
      requireE2e: options.requireE2e
    });
    const payload = buildReleaseGateCliPayload({ path, result });

    if (options.json) {
      console.log(JSON.stringify(payload, null, 2));
    } else if (result.ok) {
      console.log(`Commercial release gate passed: ${payload.path}`);
      payload.warnings.forEach((warning) => console.warn(`Warning: ${warning}`));
    } else {
      console.error(`Commercial release gate failed: ${payload.path}`);
      payload.failures.forEach((failure) => console.error(`- ${failure}`));
      payload.warnings.forEach((warning) => console.warn(`Warning: ${warning}`));
    }
    process.exitCode = result.ok ? 0 : 1;
  } catch (error) {
    const message = redactEvidenceText(error.message, { rootDir: process.cwd(), env: process.env });
    if (options.json) {
      console.log(JSON.stringify({ ok: false, failures: [message], warnings: [] }, null, 2));
    } else {
      console.error(message);
    }
    process.exitCode = 1;
  }
}

if (import.meta.url === new URL(process.argv[1], "file:").href) {
  main();
}
