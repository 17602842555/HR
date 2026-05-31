import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadDashboardPeople } from "./dashboard-data.mjs";
import { parseProductionEnvText, validateProductionEnv } from "./validate-production-env.mjs";
import { requiredMaskedFields, sha256File } from "./validate-hr-signoff.mjs";
import { requiredManagedSecrets } from "./validate-secrets-signoff.mjs";

const defaultOutputDir = "reports/commercial-evidence/signoff-drafts";
const productionSecretChecklist = Object.freeze([...requiredManagedSecrets, "DEFAULT_ADMIN_PASSWORD"]);

function nowIso(now = new Date()) {
  return now.toISOString();
}

function slugTimestamp(value) {
  return String(value || nowIso()).replaceAll(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function resolveFromRoot(rootDir, path) {
  if (!path) return "";
  return isAbsolute(path) ? path : resolve(rootDir, path);
}

function sha256Text(text) {
  return createHash("sha256").update(String(text || "")).digest("hex");
}

function ensurePrivateDir(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

function writePrivateTextFile(path, text) {
  ensurePrivateDir(dirname(path));
  writeFileSync(path, text, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function boolValue(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

function parseOrigins(value) {
  return String(value || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function urlHost(value) {
  try {
    return new URL(String(value || "")).host;
  } catch {
    return "";
  }
}

function addDays(date, days) {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function pendingApproval(role, index) {
  return {
    role,
    name: `Pending ${role}`,
    email: `pending-${index}@company.internal`,
    decision: "pending",
    approvedAt: null
  };
}

function signoffNotice() {
  return "Generated draft only. It is not release evidence until pending approvals are replaced, openExceptions is empty, and the matching validation command passes.";
}

function dashboardCounts(sourcePath) {
  const people = loadDashboardPeople(sourcePath);
  return {
    activeEmployees: people.employees.length,
    leavers: people.leavers.length,
    femaleEmployees: people.femaleEmployees.length,
    monthLeavers: people.monthLeavers.length,
    departments: new Set(people.employees.map((item) => item.department).filter(Boolean)).size,
    orgs: new Set(people.employees.map((item) => item.org).filter(Boolean)).size
  };
}

export function buildHrDataSignoffDraft({
  sourcePath = resolve("oa-dashboard.html"),
  now = new Date()
} = {}) {
  const generatedAt = nowIso(now);
  return {
    schemaVersion: 1,
    draft: true,
    draftNotice: signoffNotice(),
    documentId: `HR-SIGNOFF-DRAFT-${slugTimestamp(generatedAt)}`,
    environment: "production",
    signedAt: generatedAt,
    source: {
      sourceName: basename(sourcePath),
      sourceChecksum: sha256File(sourcePath),
      importedAt: generatedAt,
      counts: dashboardCounts(sourcePath)
    },
    dataPolicy: {
      fieldPolicy: {
        defaultMasked: true,
        revealPermission: "employee.sensitive.read",
        maskedFields: [...requiredMaskedFields]
      },
      exportPolicy: {
        requiresPermission: true,
        allowsSensitiveExport: false,
        recordsExportLedger: true,
        requiresBusinessReason: true,
        allowedExportPermissions: ["employee.export", "audit.export"]
      },
      retention: {
        employeeRecords: "Review and confirm the statutory HR personnel-record retention period before release.",
        leaverRecords: "Review and confirm the statutory leaver-record retention period before release.",
        auditLogs: "Review and confirm the compliance audit-log retention period before release.",
        exportFiles: "Review and confirm export-file retention and workstation cleanup requirements before release."
      }
    },
    approvals: [
      pendingApproval("HR owner", 1),
      pendingApproval("Product owner", 2),
      pendingApproval("Security reviewer", 3)
    ],
    openExceptions: [
      {
        id: "HR-SIGNOFF-APPROVALS",
        owner: "HR owner and Product owner",
        createdAt: generatedAt,
        exitCriteria: "Replace pending approvals with approved reviewer names/emails, clear this exception, and archive npm run validate:hr-signoff output."
      }
    ]
  };
}

export function buildSecretsSignoffDraft({
  envPath = resolve(".env.production"),
  now = new Date()
} = {}) {
  const generatedAt = nowIso(now);
  const envExists = existsSync(envPath);
  const envText = envExists ? readFileSync(envPath, "utf8") : "";
  const env = envText ? parseProductionEnvText(envText) : {};
  const validation = envText ? validateProductionEnv(env) : { ok: false, errors: ["Production env file is missing."], warnings: [] };
  const origins = parseOrigins(env.WEB_ORIGIN);
  const lastRotatedAt = generatedAt;
  const nextRotationDueAt = nowIso(addDays(now, 90));
  const managedSecrets = boolValue(env.RUN_DB_SEED)
    ? [...requiredManagedSecrets, "DEFAULT_ADMIN_PASSWORD"]
    : [...requiredManagedSecrets];

  return {
    schemaVersion: 1,
    draft: true,
    draftNotice: signoffNotice(),
    documentId: `PROD-SECRETS-SIGNOFF-DRAFT-${slugTimestamp(generatedAt)}`,
    backendMode: String(env.CLOUDFLARE_BACKEND_MODE || env.OA_API_MODE || "native-worker"),
    environment: "production",
    signedAt: generatedAt,
    environmentFile: {
      path: basename(envPath),
      sha256: envText ? sha256Text(envText) : "",
      validatedWith: "npm run validate:production-env -- .env.production --json",
      validationSummary: {
        ok: validation.ok,
        errorCount: validation.errors.length,
        warningCount: validation.warnings.length
      }
    },
    secretStore: {
      provider: "Pending production secret manager",
      namespace: "oa/production",
      managedSecrets,
      injectedAtRuntime: true,
      noPlaintextInRepo: true,
      accessRestricted: true,
      rotationOwner: "Security Platform Team",
      lastRotatedAt,
      nextRotationDueAt,
      rotationRunbook: "Security runbook for OA production secret rotation.",
      emergencyRollback: "Use the previous managed secret version after incident approval."
    },
    originPolicy: {
      approvedOrigins: origins.length > 0 ? origins : [],
      httpsOnly: true,
      noWildcard: true,
      owner: "Security Platform Team"
    },
    bootstrapSeedPolicy: {
      runDbSeed: boolValue(env.RUN_DB_SEED),
      defaultAdminPasswordManaged: boolValue(env.RUN_DB_SEED),
      approvalReference: boolValue(env.RUN_DB_SEED)
        ? "Attach the reviewed production bootstrap-seed approval reference."
        : "No production seed for this release."
    },
    approvals: [
      pendingApproval("Security owner", 1),
      pendingApproval("Deployment owner", 2)
    ],
    openExceptions: [
      {
        id: envExists ? "SECRETS-SIGNOFF-APPROVALS" : "PRODUCTION-ENV-MISSING",
        owner: envExists ? "Security owner and Deployment owner" : "Deployment owner",
        createdAt: generatedAt,
        exitCriteria: envExists
          ? "Replace pending approvals with approved reviewer names/emails, clear this exception, and archive npm run validate:secrets-signoff output."
          : "Create the real .env.production through the secret-store process, regenerate this draft, then validate production env and secrets signoff."
      }
    ]
  };
}

export function buildStorageSignoffDraft({
  envPath = resolve(".env.production"),
  fileStorageDir = "",
  now = new Date()
} = {}) {
  const generatedAt = nowIso(now);
  const env = existsSync(envPath) ? parseProductionEnvText(readFileSync(envPath, "utf8")) : {};
  const fileStorageDriver = String(env.FILE_STORAGE_DRIVER || "local").trim() || "local";
  const objectStorage = fileStorageDriver === "s3";
  const runtimeFileStorageDir = objectStorage ? "" : fileStorageDir || env.FILE_STORAGE_DIR || "/app/storage/files";
  const backupDir = String(env.BACKUP_DIR || "").trim();
  const fileBackupDir = objectStorage ? "" : String(env.FILE_BACKUP_DIR || "").trim();
  const objectStorageBucket = objectStorage ? String(env.OBJECT_STORAGE_BUCKET || "").trim() : "";
  const objectStorageRegion = objectStorage ? String(env.OBJECT_STORAGE_REGION || "").trim() : "";
  const objectStorageEndpointHost = objectStorage ? urlHost(env.OBJECT_STORAGE_ENDPOINT) : "";

  return {
    schemaVersion: 1,
    draft: true,
    draftNotice: signoffNotice(),
    documentId: `FILE-STORAGE-SIGNOFF-DRAFT-${slugTimestamp(generatedAt)}`,
    environment: "production",
    signedAt: generatedAt,
    storage: {
      storageType: objectStorage ? "object-storage" : "backed-persistent-volume",
      provider: "Pending production attachment storage",
      location: objectStorageBucket || "pending-production-attachment-location",
      region: objectStorageRegion || "pending-production-region",
      backupOwner: "Infrastructure Platform Team",
      encryptionAtRest: true,
      privateAccess: true,
      independentBackup: true,
      bucketVersioning: true
    },
    runtime: {
      fileStorageDriver,
      fileStorageDir: runtimeFileStorageDir,
      backupDir,
      fileBackupDir,
      objectStorageConfigured: objectStorage,
      objectStorageEndpointHost,
      objectStorageBucket,
      objectStorageRegion,
      backedByPersistentVolume: !objectStorage,
      noEphemeralContainerStorage: true
    },
    backupPolicy: {
      schedule: "Confirm nightly attachment backup or object replication before release.",
      retention: "Confirm at least 7 daily, 4 weekly, and 3 monthly off-host copies before release.",
      rpoHours: 24,
      rtoHours: 4,
      offHostCopy: true,
      restoreRunbook: "docs/DEPLOYMENT.md file storage backup and restore runbook."
    },
    restoreDrill: {
      drillId: `FILE-DRILL-DRAFT-${slugTimestamp(generatedAt)}`,
      completedAt: null,
      restoredTo: "staging",
      restoreMethod: objectStorage
        ? "Provider-native object-storage restore or platform restore tooling must be exercised before release."
        : "npm run restore:files -- <file-storage-backup.tar.gz> --yes or platform restore tooling must be exercised before release.",
      evidencePath: "",
      backupArtifact: {
        path: "",
        metadataPath: "",
        sha256: "",
        sizeBytes: 0,
        fileCount: 0
      },
      downloadedAttachmentSmoke: {
        passed: false,
        fileId: "",
        downloadedAt: null,
        expectedChecksum: "",
        actualChecksum: ""
      },
      auditEventIds: []
    },
    approvals: [
      pendingApproval("Infrastructure owner", 1),
      pendingApproval("Security reviewer", 2)
    ],
    openExceptions: [
      {
        id: "FILE-STORAGE-RESTORE-DRILL",
        owner: "Infrastructure owner",
        createdAt: generatedAt,
        exitCriteria: "Attach restore drill evidence, restored attachment smoke, backup/restore audit IDs, approved reviewers, clear this exception, and archive npm run validate:storage-signoff output."
      }
    ]
  };
}

function draftFiles() {
  return {
    hr: "hr-data-signoff.draft.json",
    secrets: "production-secrets-signoff.draft.json",
    storage: "file-storage-signoff.draft.json"
  };
}

function countPendingApprovals(draft = {}) {
  const approvals = Array.isArray(draft?.approvals) ? draft.approvals : [];
  return approvals.filter((approval) => approval?.decision !== "approved").length;
}

function countOpenExceptions(draft = {}) {
  return Array.isArray(draft?.openExceptions) ? draft.openExceptions.length : 0;
}

function buildDraftReviewItems({ drafts, files, rootDir }) {
  const definitions = [
    {
      id: "secrets",
      gapId: "GAP-003",
      owner: "Security lead",
      title: "Production secrets and Cloudflare backend origin signoff",
      validatorCommand: "npm run validate:secrets-signoff -- <production-secrets-signoff.json> --env .env.production --json",
      requiredActions: [
        "Provide real production environment values through the approved secret store.",
        "Archive `npm run validate:cloudflare-backend -- --env .env.production --json` native-worker output; configure Tunnel/API_ORIGIN evidence only if a future tunnel mode is selected.",
        "Replace pending Security/Deployment approvals and clear all production-secret exceptions."
      ]
    },
    {
      id: "storage",
      gapId: "GAP-004",
      owner: "Infrastructure lead",
      title: "Attachment storage and restore-drill signoff",
      validatorCommand: "npm run validate:storage-signoff -- <file-storage-signoff.json> --file-storage-dir <FILE_STORAGE_DIR> --environment production --json",
      requiredActions: [
        "Provision production attachment storage with independent backup or object replication.",
        "Complete a restore drill and restored-attachment download smoke.",
        "Replace pending Infrastructure/Security approvals and clear all storage exceptions."
      ]
    },
    {
      id: "hr",
      gapId: "GAP-005",
      owner: "Product lead",
      title: "HR/Product personnel data signoff",
      validatorCommand: "npm run validate:hr-signoff -- <hr-data-signoff.json> --source oa-dashboard.html --json",
      requiredActions: [
        "Confirm imported personnel counts and sensitive-field masking policy.",
        "Confirm export ledger, export permission, and retention policies.",
        "Replace pending HR/Product/Security approvals and clear all HR data exceptions."
      ]
    }
  ];

  return definitions.map((definition) => {
    const draft = drafts?.[definition.id] || {};
    return {
      id: definition.id,
      gapId: definition.gapId,
      owner: definition.owner,
      title: definition.title,
      draftFile: relative(rootDir, files[definition.id]),
      validatorCommand: definition.validatorCommand,
      pendingApprovalCount: countPendingApprovals(draft),
      openExceptionCount: countOpenExceptions(draft),
      releaseEvidence: false,
      requiredActions: definition.requiredActions
    };
  });
}

export function buildSignoffDraftManifest({
  drafts,
  files,
  outputDir,
  rootDir,
  sourcePath,
  envPath,
  fileStorageDriver,
  fileStorageDir,
  backupDir = "",
  fileBackupDir = "",
  objectStorageBucket = "",
  objectStorageEndpointHost = "",
  objectStorageRegion = "",
  generatedAt
}) {
  const reviewItems = buildDraftReviewItems({ drafts, files, rootDir });
  const totalPendingApprovalCount = reviewItems.reduce((sum, item) => sum + item.pendingApprovalCount, 0);
  const totalOpenExceptionCount = reviewItems.reduce((sum, item) => sum + item.openExceptionCount, 0);
  return {
    schemaVersion: 1,
    draft: true,
    generatedAt,
    outputDir: relative(rootDir, outputDir) || ".",
    source: {
      dashboardHtml: relative(rootDir, sourcePath),
      productionEnv: relative(rootDir, envPath),
      fileStorageDriver,
      fileStorageDir,
      backupDir,
      fileBackupDir,
      objectStorageBucket,
      objectStorageEndpointHost,
      objectStorageRegion
    },
    requiredSecretNames: productionSecretChecklist,
    files: Object.fromEntries(Object.entries(files).map(([key, filePath]) => [key, relative(rootDir, filePath)])),
    signoffReadiness: {
      releaseEvidence: false,
      status: "draft-review-required",
      totalOpenExceptionCount,
      totalPendingApprovalCount,
      itemCount: reviewItems.length,
      items: reviewItems
    },
    nextCommands: [
      "npm run validate:production-env -- .env.production --json",
      "npm run validate:secrets-signoff -- <production-secrets-signoff.json> --env .env.production --json",
      "npm run validate:hr-signoff -- <hr-data-signoff.json> --source oa-dashboard.html --json",
      "npm run validate:storage-signoff -- <file-storage-signoff.json> --file-storage-dir <FILE_STORAGE_DIR> --environment production --json"
    ],
    releaseUse: "Do not attach these draft files as release evidence. Copy reviewed versions into docs/*.json or release evidence storage only after owners approve and validators pass."
  };
}

export function generateSignoffDrafts(options = {}) {
  const rootDir = resolve(options.rootDir || process.cwd());
  const now = options.now || new Date();
  const generatedAt = nowIso(now);
  const sourcePath = resolveFromRoot(rootDir, options.sourcePath || "oa-dashboard.html");
  const envPath = resolveFromRoot(rootDir, options.envPath || ".env.production");
  const baseOutputDir = resolveFromRoot(rootDir, options.outputDir || defaultOutputDir);
  const runDir = join(baseOutputDir, `signoff-drafts-${slugTimestamp(generatedAt)}`);
  const fileNames = draftFiles();
  const files = {
    hr: join(runDir, fileNames.hr),
    secrets: join(runDir, fileNames.secrets),
    storage: join(runDir, fileNames.storage),
    manifest: join(runDir, "manifest.json")
  };

  if (!existsSync(sourcePath)) {
    throw new Error(`Dashboard source file does not exist: ${sourcePath}`);
  }

  const drafts = {
    hr: buildHrDataSignoffDraft({ sourcePath, now }),
    secrets: buildSecretsSignoffDraft({ envPath, now }),
    storage: buildStorageSignoffDraft({ envPath, fileStorageDir: options.fileStorageDir || "", now })
  };
  const manifest = buildSignoffDraftManifest({
    drafts,
    files,
    outputDir: runDir,
    rootDir,
    sourcePath,
    envPath,
    fileStorageDriver: drafts.storage.runtime.fileStorageDriver,
    fileStorageDir: drafts.storage.runtime.fileStorageDir,
    backupDir: drafts.storage.runtime.backupDir,
    fileBackupDir: drafts.storage.runtime.fileBackupDir,
    objectStorageBucket: drafts.storage.runtime.objectStorageBucket,
    objectStorageEndpointHost: drafts.storage.runtime.objectStorageEndpointHost,
    objectStorageRegion: drafts.storage.runtime.objectStorageRegion,
    generatedAt
  });

  ensurePrivateDir(baseOutputDir);
  ensurePrivateDir(runDir);
  Object.entries(drafts).forEach(([key, payload]) => {
    writePrivateTextFile(files[key], `${JSON.stringify(payload, null, 2)}\n`);
  });
  writePrivateTextFile(files.manifest, `${JSON.stringify(manifest, null, 2)}\n`);
  writePrivateTextFile(join(baseOutputDir, "latest-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  return { generatedAt, outputDir: runDir, files, manifest, drafts };
}

export function parseSignoffDraftArgs(argv = []) {
  const options = {
    outputDir: defaultOutputDir,
    sourcePath: "oa-dashboard.html",
    envPath: ".env.production",
    fileStorageDir: "",
    json: argv.includes("--json")
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--output") {
      options.outputDir = argv[index + 1] || options.outputDir;
      index += 1;
    } else if (arg === "--source") {
      options.sourcePath = argv[index + 1] || options.sourcePath;
      index += 1;
    } else if (arg === "--env") {
      options.envPath = argv[index + 1] || options.envPath;
      index += 1;
    } else if (arg === "--file-storage-dir") {
      options.fileStorageDir = argv[index + 1] || options.fileStorageDir;
      index += 1;
    }
  }
  return options;
}

async function main(argv = process.argv.slice(2)) {
  const options = parseSignoffDraftArgs(argv);
  try {
    const result = generateSignoffDrafts(options);
    const payload = {
      ok: true,
      outputDir: result.outputDir,
      files: result.files,
      nextCommands: result.manifest.nextCommands
    };
    if (options.json) {
      console.log(JSON.stringify(payload, null, 2));
    } else {
      console.log(`Signoff drafts generated: ${result.outputDir}`);
      Object.values(result.files).forEach((filePath) => console.log(`- ${filePath}`));
      console.log("These files are drafts only; release validators must pass on reviewed non-draft signoffs.");
    }
  } catch (error) {
    if (options.json) {
      console.log(JSON.stringify({ ok: false, errors: [error.message] }, null, 2));
    } else {
      console.error(error.message);
    }
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || basename(import.meta.url)).href) {
  main();
}
