import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { validateTarArchive } from "./validate-file-backup.mjs";

export const defaultDrillSummaryPath = "commercial-evidence/latest-drill-summary.json";

const knownSecretFragments = [
  "oa_dev_password",
  "admin123456",
  "local-commercial-demo-secret",
  "replace-with-a-long-random-secret-before-deployment"
];

const maxRpoHours = 24;
const maxRtoHours = 4;
const futureClockSkewMinutes = 5;

function resolvePath(path, rootDir = process.cwd()) {
  return isAbsolute(path) ? path : resolve(rootDir, path);
}

function addError(errors, message, details = {}) {
  errors.push(Object.keys(details).length ? `${message}: ${JSON.stringify(details)}` : message);
}

export function parseDrillEvidenceArgs(argv = []) {
  const options = {
    summaryPath: defaultDrillSummaryPath,
    json: argv.includes("--json")
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--summary") {
      options.summaryPath = argv[index + 1] || options.summaryPath;
      index += 1;
    } else if (!arg.startsWith("--")) {
      options.summaryPath = arg;
    }
  }

  return options;
}

export function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function loadJsonFile(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function parseMetadataText(text) {
  return Object.fromEntries(
    String(text || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => {
        const index = line.indexOf("=");
        return index === -1 ? [line, ""] : [line.slice(0, index), line.slice(index + 1)];
      })
  );
}

function loadMetadata(path, errors, label) {
  if (!existsSync(path)) {
    addError(errors, `${label} metadata file is missing`, { path });
    return {};
  }
  return parseMetadataText(readFileSync(path, "utf8"));
}

function positiveInteger(value) {
  return /^\d+$/.test(String(value || "")) && Number(value) > 0;
}

function nonNegativeInteger(value) {
  return /^\d+$/.test(String(value ?? ""));
}

function parseTargetHours(value) {
  const text = String(value || "").trim().toLowerCase();
  const match = text.match(/^(\d+(?:\.\d+)?)\s*(h|hour|hours)$/);
  if (!match) return null;
  const hours = Number(match[1]);
  return Number.isFinite(hours) && hours > 0 ? hours : null;
}

function parseEvidenceTimestamp(value) {
  const text = String(value || "").trim();
  const compact = text.match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/);
  if (compact) {
    return new Date(`${compact[1]}-${compact[2]}-${compact[3]}T${compact[4]}:${compact[5]}:${compact[6]}.000Z`);
  }
  return new Date(text);
}

function validateTimestamp(value, errors, label) {
  const parsed = parseEvidenceTimestamp(value);
  if (!value || Number.isNaN(parsed.getTime())) {
    addError(errors, `${label} must be a valid timestamp`, { value: value || null });
    return null;
  }
  return parsed;
}

function validateTargetHours(value, errors, label, maximumHours) {
  const hours = parseTargetHours(value);
  if (hours === null) {
    addError(errors, `${label} must be an hour target such as ${maximumHours}h`, { value: value || null });
    return null;
  }
  if (hours > maximumHours) {
    addError(errors, `${label} exceeds commercial maximum`, { value, maximumHours });
  }
  return hours;
}

function validateBackupTiming({ metadata, errors, label, finishedAt }) {
  const createdAt = validateTimestamp(metadata.created_at, errors, `${label} metadata created_at`);
  const rpoHours = validateTargetHours(metadata.rpo_target, errors, `${label} metadata rpo_target`, maxRpoHours);
  const rtoHours = validateTargetHours(metadata.rto_target, errors, `${label} metadata rto_target`, maxRtoHours);
  if (createdAt && finishedAt) {
    const skewMinutes = (createdAt.getTime() - finishedAt.getTime()) / 60000;
    if (skewMinutes > futureClockSkewMinutes) {
      addError(errors, `${label} metadata created_at is in the future beyond clock skew`, {
        created_at: metadata.created_at,
        finishedAt: finishedAt.toISOString()
      });
    }
    if (rpoHours !== null) {
      const ageHours = (finishedAt.getTime() - createdAt.getTime()) / 3600000;
      if (ageHours > rpoHours) {
        addError(errors, `${label} backup age exceeds RPO target`, {
          ageHours: Number(ageHours.toFixed(3)),
          rpoTargetHours: rpoHours
        });
      }
    }
  }
  return { createdAt, rpoHours, rtoHours };
}

function validateDrillTiming({ startedAt, finishedAt, targetHours, errors }) {
  if (!startedAt || !finishedAt || targetHours === null) return;
  const durationHours = (finishedAt.getTime() - startedAt.getTime()) / 3600000;
  if (durationHours < 0) {
    errors.push("drill summary startedAt must be before finishedAt.");
  } else if (durationHours > targetHours) {
    addError(errors, "drill duration exceeds RTO target", {
      durationHours: Number(durationHours.toFixed(3)),
      rtoTargetHours: targetHours
    });
  }
}

function validateMaskedDatabaseUrl(value, errors) {
  const databaseUrl = String(value || "");
  if (!databaseUrl) {
    errors.push("drill summary databaseUrl is required.");
    return;
  }
  knownSecretFragments.forEach((secret) => {
    if (databaseUrl.includes(secret)) {
      addError(errors, "drill summary databaseUrl exposes a known secret fragment", { secret });
    }
  });
  try {
    const parsed = new URL(databaseUrl);
    if (parsed.password && parsed.password !== "***") {
      errors.push("drill summary databaseUrl must mask the password as ***.");
    }
  } catch {
    errors.push("drill summary databaseUrl must be a valid URL.");
  }
}

function validateBackupArtifact({
  artifactPath,
  metadataPath,
  metadata,
  expectedArtifactType,
  errors,
  label,
  inspectTar = false
}) {
  if (!existsSync(artifactPath)) {
    addError(errors, `${label} artifact file is missing`, { path: artifactPath });
    return;
  }
  const stat = statSync(artifactPath);
  if (!stat.isFile() || stat.size <= 0) {
    addError(errors, `${label} artifact must be a non-empty file`, { path: artifactPath, size: stat.size });
  }

  if (metadata.artifact_type !== expectedArtifactType) {
    addError(errors, `${label} metadata artifact_type mismatch`, {
      expected: expectedArtifactType,
      actual: metadata.artifact_type || null,
      metadataPath
    });
  }
  if (!positiveInteger(metadata.size_bytes)) {
    addError(errors, `${label} metadata size_bytes must be a positive integer`, { metadataPath });
  } else if (Number(metadata.size_bytes) !== stat.size) {
    addError(errors, `${label} metadata size_bytes does not match artifact size`, {
      expected: Number(metadata.size_bytes),
      actual: stat.size
    });
  }
  if (!/^[a-f0-9]{64}$/i.test(String(metadata.sha256 || ""))) {
    addError(errors, `${label} metadata sha256 is missing or invalid`, { metadataPath });
  } else {
    const actualSha = sha256File(artifactPath);
    if (actualSha.toLowerCase() !== metadata.sha256.toLowerCase()) {
      addError(errors, `${label} artifact checksum mismatch`, {
        expected: metadata.sha256,
        actual: actualSha
      });
    }
  }
  if (metadata.backup_file && resolvePath(metadata.backup_file) !== artifactPath) {
    addError(errors, `${label} metadata backup_file does not match summary artifact`, {
      metadataBackupFile: metadata.backup_file,
      summaryArtifact: artifactPath
    });
  }

  if (inspectTar) {
    try {
      const result = validateTarArchive(artifactPath);
      if (!result.ok) {
        result.errors.forEach((error) => addError(errors, `${label} archive validation failed`, { error }));
      }
    } catch (error) {
      addError(errors, `${label} archive validation failed`, { error: error.message });
    }
  }
}

function validateReadyEvidence(payload, errors, label) {
  if (!payload || typeof payload !== "object") {
    addError(errors, `${label} readiness evidence is not a JSON object`);
    return;
  }
  if (payload.kind !== "api-readiness") addError(errors, `${label} kind must be api-readiness`);
  if (payload.ok !== true) addError(errors, `${label} HTTP readiness request was not ok`);
  if (payload.status !== 200) addError(errors, `${label} readiness status must be 200`, { status: payload.status });
  if (!payload.payload || typeof payload.payload !== "object") {
    addError(errors, `${label} readiness payload is missing`);
    return;
  }
  if (payload.payload.ok !== true) addError(errors, `${label} readiness payload ok must be true`);
  if (payload.payload.database !== "ok") addError(errors, `${label} database readiness must be ok`, { database: payload.payload.database });
  if (payload.payload.fileStorage !== "ok") addError(errors, `${label} file storage readiness must be ok`, { fileStorage: payload.payload.fileStorage });
}

function validateSmokeEvidence(payload, errors, label) {
  if (!payload || typeof payload !== "object") {
    addError(errors, `${label} smoke evidence is not a JSON object`);
    return;
  }
  if (payload.kind !== "commercial-smoke") addError(errors, `${label} kind must be commercial-smoke`);
  if (payload.ok !== true) addError(errors, `${label} smoke evidence did not pass`);
  if (!payload.finishedAt || Number.isNaN(Date.parse(payload.finishedAt))) {
    addError(errors, `${label} smoke evidence finishedAt must be an ISO timestamp`);
  }
}

function readEvidenceFile(path, errors, label, validator) {
  if (!existsSync(path)) {
    addError(errors, `${label} evidence file is missing`, { path });
    return null;
  }
  try {
    const payload = loadJsonFile(path);
    validator(payload, errors, label);
    return payload;
  } catch (error) {
    addError(errors, `${label} evidence file is not valid JSON`, { path, error: error.message });
    return null;
  }
}

export function validateCommercialDrillEvidence(summaryPath = defaultDrillSummaryPath, { rootDir = process.cwd(), allowedKinds = ["commercial-drill"] } = {}) {
  const errors = [];
  const warnings = [];
  const resolvedSummaryPath = resolvePath(summaryPath, rootDir);

  if (!existsSync(resolvedSummaryPath)) {
    return {
      ok: false,
      summaryPath: resolvedSummaryPath,
      errors: [`Commercial drill summary does not exist: ${resolvedSummaryPath}`],
      warnings,
      evidence: null
    };
  }

  let summary = null;
  try {
    summary = loadJsonFile(resolvedSummaryPath);
  } catch (error) {
    return {
      ok: false,
      summaryPath: resolvedSummaryPath,
      errors: [`Commercial drill summary is not valid JSON: ${error.message}`],
      warnings,
      evidence: null
    };
  }

  if (summary.ok !== true) errors.push("drill summary ok must be true.");
  if (!allowedKinds.includes(summary.kind)) {
    errors.push(`drill summary kind must be ${allowedKinds.join(" or ")}.`);
  }
  const startedAt = validateTimestamp(summary.startedAt, errors, "drill summary startedAt");
  const finishedAt = validateTimestamp(summary.finishedAt, errors, "drill summary finishedAt");
  try {
    new URL(String(summary.apiBaseUrl || ""));
  } catch {
    errors.push("drill summary apiBaseUrl must be a valid URL.");
  }
  validateMaskedDatabaseUrl(summary.databaseUrl, errors);

  const requiredPathFields = [
    "backupFile",
    "backupMeta",
    "fileBackup",
    "fileBackupMeta",
    "preRestoreReadyEvidence",
    "postRestoreReadyEvidence",
    "preRestoreSmokeEvidence",
    "postRestoreSmokeEvidence"
  ];
  const paths = {};
  requiredPathFields.forEach((field) => {
    if (!summary[field]) {
      addError(errors, `drill summary is missing ${field}`);
    } else {
      paths[field] = resolvePath(summary[field], rootDir);
    }
  });

  if (paths.backupMeta && paths.backupFile) {
    const dbMetadata = loadMetadata(paths.backupMeta, errors, "database backup");
    validateBackupArtifact({
      artifactPath: paths.backupFile,
      metadataPath: paths.backupMeta,
      metadata: dbMetadata,
      expectedArtifactType: "database",
      errors,
      label: "database backup"
    });
    const timing = validateBackupTiming({ metadata: dbMetadata, errors, label: "database backup", finishedAt });
    validateDrillTiming({ startedAt, finishedAt, targetHours: timing.rtoHours, errors });
  }

  if (paths.fileBackupMeta && paths.fileBackup) {
    const fileMetadata = loadMetadata(paths.fileBackupMeta, errors, "file storage backup");
    validateBackupArtifact({
      artifactPath: paths.fileBackup,
      metadataPath: paths.fileBackupMeta,
      metadata: fileMetadata,
      expectedArtifactType: "file_storage",
      errors,
      label: "file storage backup",
      inspectTar: true
    });
    if (!nonNegativeInteger(fileMetadata.file_count)) {
      addError(errors, "file storage backup metadata file_count must be a non-negative integer", {
        file_count: fileMetadata.file_count || null
      });
    }
    const timing = validateBackupTiming({ metadata: fileMetadata, errors, label: "file storage backup", finishedAt });
    validateDrillTiming({ startedAt, finishedAt, targetHours: timing.rtoHours, errors });
  }

  if (paths.preRestoreReadyEvidence) readEvidenceFile(paths.preRestoreReadyEvidence, errors, "pre-restore", validateReadyEvidence);
  if (paths.postRestoreReadyEvidence) readEvidenceFile(paths.postRestoreReadyEvidence, errors, "post-restore", validateReadyEvidence);
  if (paths.preRestoreSmokeEvidence) readEvidenceFile(paths.preRestoreSmokeEvidence, errors, "pre-restore", validateSmokeEvidence);
  if (paths.postRestoreSmokeEvidence) readEvidenceFile(paths.postRestoreSmokeEvidence, errors, "post-restore", validateSmokeEvidence);

  return {
    ok: errors.length === 0,
    summaryPath: resolvedSummaryPath,
    errors,
    warnings,
    evidence: summary
      ? {
        finishedAt: summary.finishedAt || null,
        apiBaseUrl: summary.apiBaseUrl || null,
        backupFile: paths.backupFile || null,
        fileBackup: paths.fileBackup || null,
        preRestoreSmokeEvidence: paths.preRestoreSmokeEvidence || null,
        postRestoreSmokeEvidence: paths.postRestoreSmokeEvidence || null
      }
      : null
  };
}

async function main(argv = process.argv.slice(2)) {
  const options = parseDrillEvidenceArgs(argv);
  const result = validateCommercialDrillEvidence(options.summaryPath);
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (result.ok) {
    console.log(`Commercial drill evidence validation passed: ${result.summaryPath}`);
  } else {
    console.error(`Commercial drill evidence validation failed: ${result.summaryPath}`);
    result.errors.forEach((error) => console.error(`- ${error}`));
  }
  process.exitCode = result.ok ? 0 : 66;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
