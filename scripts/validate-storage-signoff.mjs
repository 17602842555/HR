import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";

export const requiredApprovalRoles = Object.freeze(["Infrastructure owner", "Security reviewer"]);
export const supportedStorageTypes = Object.freeze(["object-storage", "backed-persistent-volume"]);

const placeholderFragments = Object.freeze([
  "example",
  "placeholder",
  "replace",
  "todo",
  "待填写",
  "示例"
]);

function isBlank(value) {
  return String(value ?? "").trim() === "";
}

function hasPlaceholder(value) {
  const text = String(value ?? "").trim().toLowerCase();
  return !text || placeholderFragments.some((fragment) => text.includes(fragment.toLowerCase()));
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeChecksum(value) {
  return String(value || "").trim().replace(/^sha256:/i, "").toLowerCase();
}

function isIsoDateTime(value) {
  if (typeof value !== "string" || !value.trim()) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && /\d{4}-\d{2}-\d{2}T/.test(value);
}

function positiveNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
}

function isUnsafeLocalStoragePath(value) {
  const text = String(value || "").trim();
  if (!text) return true;
  if (["/", ".", ".local-files", "/tmp", "/var/tmp"].includes(text)) return true;
  return text.startsWith("/tmp/") || text.startsWith("/var/tmp/");
}

export function sha256Text(text) {
  return createHash("sha256").update(String(text || "")).digest("hex");
}

export function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function validateStorageSignoff(signoff, {
  allowExample = false,
  expectedFileStorageDir = "",
  expectedEnvironment = ""
} = {}) {
  const errors = [];
  const warnings = [];
  const storage = signoff?.storage || {};
  const runtime = signoff?.runtime || {};
  const backupPolicy = signoff?.backupPolicy || {};
  const restoreDrill = signoff?.restoreDrill || {};
  const backupArtifact = restoreDrill.backupArtifact || {};
  const smoke = restoreDrill.downloadedAttachmentSmoke || {};
  const approvals = list(signoff?.approvals);
  const exceptions = list(signoff?.openExceptions);
  const permitPlaceholders = allowExample && signoff?.example === true;

  if (!signoff || typeof signoff !== "object" || Array.isArray(signoff)) {
    return { ok: false, errors: ["Storage signoff payload must be a JSON object."], warnings, summary: {} };
  }

  if (signoff.schemaVersion !== 1) errors.push("schemaVersion must be 1.");
  if (signoff.example === true && !allowExample) errors.push("Example storage signoff files cannot be used as release evidence.");
  if (!permitPlaceholders && hasPlaceholder(signoff.documentId)) errors.push("documentId must be a real non-placeholder identifier.");
  if (!["staging", "production"].includes(String(signoff.environment || ""))) {
    errors.push("environment must be staging or production.");
  }
  if (expectedEnvironment && signoff.environment !== expectedEnvironment) {
    errors.push(`environment must match ${expectedEnvironment}.`);
  }
  if (!isIsoDateTime(signoff.signedAt)) errors.push("signedAt must be an ISO datetime.");

  if (!supportedStorageTypes.includes(storage.storageType)) {
    errors.push(`storage.storageType must be one of ${supportedStorageTypes.join(", ")}.`);
  }
  ["provider", "location", "region", "backupOwner"].forEach((key) => {
    if (!permitPlaceholders && hasPlaceholder(storage[key])) errors.push(`storage.${key} must be reviewed and non-placeholder.`);
  });
  if (storage.encryptionAtRest !== true) errors.push("storage.encryptionAtRest must be true.");
  if (storage.privateAccess !== true) errors.push("storage.privateAccess must be true.");
  if (storage.independentBackup !== true) errors.push("storage.independentBackup must be true.");
  if (storage.storageType === "backed-persistent-volume" && runtime.backedByPersistentVolume !== true) {
    errors.push("runtime.backedByPersistentVolume must be true for backed-persistent-volume storage.");
  }
  const runtimeDriver = String(runtime.fileStorageDriver || (storage.storageType === "object-storage" ? "s3" : "local"));
  if (!["local", "s3"].includes(runtimeDriver)) {
    errors.push("runtime.fileStorageDriver must be local or s3.");
  }
  if (storage.storageType === "object-storage" && runtimeDriver !== "s3") {
    errors.push("runtime.fileStorageDriver must be s3 for object-storage.");
  }
  if (storage.storageType === "object-storage" && runtime.objectStorageConfigured !== true) {
    errors.push("runtime.objectStorageConfigured must be true for object-storage.");
  }
  if (storage.storageType === "object-storage" && !storage.bucketVersioning) {
    warnings.push("Object storage bucket versioning is recommended for attachment recovery.");
  }
  if (storage.storageType === "backed-persistent-volume") {
    warnings.push("Object storage is preferred for production attachments; persistent volumes must be backed and restore-tested independently.");
  }

  if (runtimeDriver === "local" || storage.storageType === "backed-persistent-volume") {
    if (!isAbsolute(String(runtime.fileStorageDir || ""))) {
      errors.push("runtime.fileStorageDir must be an absolute path.");
    } else if (isUnsafeLocalStoragePath(runtime.fileStorageDir)) {
      errors.push("runtime.fileStorageDir must not use temporary or local demo storage.");
    }
  } else if (runtime.fileStorageDir && !isAbsolute(String(runtime.fileStorageDir || ""))) {
    errors.push("runtime.fileStorageDir must be absolute when supplied.");
  }
  if (expectedFileStorageDir && runtimeDriver === "local" && runtime.fileStorageDir !== expectedFileStorageDir) {
    errors.push("runtime.fileStorageDir must match the production FILE_STORAGE_DIR.");
  }
  if (runtime.noEphemeralContainerStorage !== true) errors.push("runtime.noEphemeralContainerStorage must be true.");

  const rpoHours = positiveNumber(backupPolicy.rpoHours);
  const rtoHours = positiveNumber(backupPolicy.rtoHours);
  if (!rpoHours || rpoHours > 24) errors.push("backupPolicy.rpoHours must be > 0 and <= 24.");
  if (!rtoHours || rtoHours > 4) errors.push("backupPolicy.rtoHours must be > 0 and <= 4.");
  if (backupPolicy.offHostCopy !== true) errors.push("backupPolicy.offHostCopy must be true.");
  ["schedule", "retention", "restoreRunbook"].forEach((key) => {
    if (!permitPlaceholders && hasPlaceholder(backupPolicy[key])) errors.push(`backupPolicy.${key} must be reviewed and non-placeholder.`);
  });

  if (!permitPlaceholders && hasPlaceholder(restoreDrill.drillId)) errors.push("restoreDrill.drillId must be real and non-placeholder.");
  if (!isIsoDateTime(restoreDrill.completedAt)) errors.push("restoreDrill.completedAt must be an ISO datetime.");
  if (!["staging", "dr", "production"].includes(String(restoreDrill.restoredTo || ""))) {
    errors.push("restoreDrill.restoredTo must be staging, dr, or production.");
  }
  if (restoreDrill.restoredTo === "production") {
    warnings.push("Production restore drills should usually be replaced with staging or DR restore evidence.");
  }
  if (!permitPlaceholders && hasPlaceholder(restoreDrill.evidencePath)) errors.push("restoreDrill.evidencePath must be reviewed and non-placeholder.");
  const restoreMethod = String(restoreDrill.restoreMethod || "");
  const usesFileRestoreEntry =
    restoreMethod.includes("npm run restore:files") ||
    restoreMethod.includes("scripts/restore-files.sh") ||
    /platform restore tooling/i.test(restoreMethod);
  if (!usesFileRestoreEntry) {
    errors.push("restoreDrill.restoreMethod must reference npm run restore:files or platform restore tooling.");
  }

  if (!permitPlaceholders && hasPlaceholder(backupArtifact.path)) errors.push("restoreDrill.backupArtifact.path must be reviewed and non-placeholder.");
  if (!permitPlaceholders && hasPlaceholder(backupArtifact.metadataPath)) errors.push("restoreDrill.backupArtifact.metadataPath must be reviewed and non-placeholder.");
  const backupChecksum = normalizeChecksum(backupArtifact.sha256);
  if (!/^[a-f0-9]{64}$/.test(backupChecksum)) {
    errors.push("restoreDrill.backupArtifact.sha256 must be a SHA-256 hex digest.");
  }
  if (!positiveInteger(backupArtifact.sizeBytes)) errors.push("restoreDrill.backupArtifact.sizeBytes must be a positive integer.");
  if (!positiveInteger(backupArtifact.fileCount)) errors.push("restoreDrill.backupArtifact.fileCount must be a positive integer.");

  if (smoke.passed !== true) errors.push("restoreDrill.downloadedAttachmentSmoke.passed must be true.");
  if (!permitPlaceholders && hasPlaceholder(smoke.fileId)) errors.push("restoreDrill.downloadedAttachmentSmoke.fileId must be reviewed and non-placeholder.");
  if (!isIsoDateTime(smoke.downloadedAt)) errors.push("restoreDrill.downloadedAttachmentSmoke.downloadedAt must be an ISO datetime.");
  const expectedChecksum = normalizeChecksum(smoke.expectedChecksum);
  const actualChecksum = normalizeChecksum(smoke.actualChecksum);
  if (!/^[a-f0-9]{64}$/.test(expectedChecksum)) {
    errors.push("restoreDrill.downloadedAttachmentSmoke.expectedChecksum must be a SHA-256 hex digest.");
  }
  if (actualChecksum && (!/^[a-f0-9]{64}$/.test(actualChecksum) || actualChecksum !== expectedChecksum)) {
    errors.push("restoreDrill.downloadedAttachmentSmoke.actualChecksum must match expectedChecksum when provided.");
  }

  const auditEventIds = list(restoreDrill.auditEventIds);
  if (auditEventIds.length < 2) errors.push("restoreDrill.auditEventIds must include backup and restore audit event ids.");
  auditEventIds.forEach((id, index) => {
    if (!permitPlaceholders && hasPlaceholder(id)) errors.push(`restoreDrill.auditEventIds[${index}] must be non-placeholder.`);
  });

  requiredApprovalRoles.forEach((role) => {
    const approval = approvals.find((item) => item.role === role && item.decision === "approved");
    if (!approval) {
      errors.push(`approvals must include an approved ${role}.`);
      return;
    }
    if (!permitPlaceholders && (hasPlaceholder(approval.name) || hasPlaceholder(approval.email))) {
      errors.push(`${role} approval must include a real name and email.`);
    }
    if (!isIsoDateTime(approval.approvedAt)) errors.push(`${role} approval must include an ISO approvedAt.`);
  });

  if (signoff.environment === "production" && exceptions.length > 0) {
    errors.push("production storage signoff must not contain openExceptions.");
  }
  exceptions.forEach((item, index) => {
    if (!permitPlaceholders && (hasPlaceholder(item.owner) || hasPlaceholder(item.exitCriteria))) {
      errors.push(`openExceptions[${index}] must include owner and exitCriteria.`);
    }
  });

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    summary: {
      documentId: signoff.documentId || null,
      environment: signoff.environment || null,
      storageType: storage.storageType || null,
      provider: storage.provider || null,
      location: storage.location || null,
      fileStorageDriver: runtimeDriver,
      fileStorageDir: runtime.fileStorageDir || null,
      rpoHours: backupPolicy.rpoHours ?? null,
      rtoHours: backupPolicy.rtoHours ?? null,
      restoreDrillId: restoreDrill.drillId || null,
      auditEventCount: auditEventIds.length,
      approvalRoles: approvals.map((item) => item.role).filter(Boolean),
      openExceptionCount: exceptions.length
    }
  };
}

export function loadStorageSignoff(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function resolvePath(path) {
  return isAbsolute(path) ? path : resolve(process.cwd(), path);
}

export function parseStorageSignoffArgs(argv = []) {
  const options = {
    signoffPath: "docs/file-storage-signoff.json",
    json: argv.includes("--json"),
    allowExample: argv.includes("--allow-example"),
    expectedFileStorageDir: "",
    expectedEnvironment: ""
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--file-storage-dir") {
      options.expectedFileStorageDir = argv[index + 1] || options.expectedFileStorageDir;
      index += 1;
    } else if (arg === "--environment") {
      options.expectedEnvironment = argv[index + 1] || options.expectedEnvironment;
      index += 1;
    } else if (!arg.startsWith("--")) {
      options.signoffPath = arg;
    }
  }
  return options;
}

async function main(argv = process.argv.slice(2)) {
  const options = parseStorageSignoffArgs(argv);
  const signoffPath = resolvePath(options.signoffPath);

  try {
    if (!existsSync(signoffPath)) throw new Error(`Storage signoff file does not exist: ${signoffPath}`);
    const result = validateStorageSignoff(loadStorageSignoff(signoffPath), {
      allowExample: options.allowExample,
      expectedFileStorageDir: options.expectedFileStorageDir,
      expectedEnvironment: options.expectedEnvironment
    });
    const payload = { path: signoffPath, fileName: basename(signoffPath), ...result };
    if (options.json) {
      console.log(JSON.stringify(payload, null, 2));
    } else if (result.ok) {
      console.log(`Storage signoff validation passed: ${signoffPath}`);
      result.warnings.forEach((warning) => console.warn(`Warning: ${warning}`));
    } else {
      console.error(`Storage signoff validation failed: ${signoffPath}`);
      result.errors.forEach((error) => console.error(`- ${error}`));
      result.warnings.forEach((warning) => console.warn(`Warning: ${warning}`));
    }
    process.exitCode = result.ok ? 0 : 1;
  } catch (error) {
    if (options.json) {
      console.log(JSON.stringify({ ok: false, errors: [error.message], warnings: [] }, null, 2));
    } else {
      console.error(error.message);
    }
    process.exitCode = 1;
  }
}

if (import.meta.url === new URL(process.argv[1], "file:").href) {
  main();
}
