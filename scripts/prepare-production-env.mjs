import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { requiredManagedSecrets } from "./validate-secrets-signoff.mjs";
import { requiredProductionEnvKeys, validateProductionEnv } from "./validate-production-env.mjs";
import { validateCloudflareBackendEnv } from "./validate-cloudflare-backend.mjs";

const defaultOutputDir = "reports/commercial-evidence/production-env-prep";
const supportedStorageDrivers = new Set(["local", "s3"]);

function nowIso(now = new Date()) {
  return now.toISOString();
}

function slugTimestamp(value) {
  return String(value || nowIso()).replaceAll(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function resolveFromRoot(rootDir, path) {
  return isAbsolute(path) ? path : resolve(rootDir, path);
}

function renderEnvLine(key, value = "") {
  return `${key}=${String(value).replaceAll("\n", "")}`;
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

function productionEnvTemplate(storageDriver) {
  const values = {
    APP_ENV: "production",
    NODE_ENV: "production",
    POSTGRES_DB: "oa_commercial",
    POSTGRES_USER: "oa",
    POSTGRES_PASSWORD: "",
    JWT_SECRET: "",
    JWT_EXPIRES_IN: "8h",
    COOKIE_NAME: "oa_session",
    COOKIE_MAX_AGE_SECONDS: "28800",
    AUTH_FAILED_LOGIN_LIMIT: "5",
    AUTH_FAILED_LOGIN_WINDOW_MS: "600000",
    AUTH_FAILED_LOGIN_MAX_KEYS: "10000",
    FILE_MAX_UPLOAD_BYTES: "5242880",
    FILE_STORAGE_DRIVER: storageDriver,
    BACKUP_DIR: "",
    FILE_STORAGE_DIR: storageDriver === "local" ? "" : "",
    FILE_BACKUP_DIR: storageDriver === "local" ? "" : "",
    OBJECT_STORAGE_ENDPOINT: "",
    OBJECT_STORAGE_BUCKET: "",
    OBJECT_STORAGE_REGION: "",
    OBJECT_STORAGE_ACCESS_KEY_ID: "",
    OBJECT_STORAGE_SECRET_ACCESS_KEY: "",
    OBJECT_STORAGE_PREFIX: "",
    OBJECT_STORAGE_FORCE_PATH_STYLE: "1",
    IMPORT_MAX_HTML_BYTES: "10485760",
    API_BODY_LIMIT_BYTES: "10551296",
    DEFAULT_TENANT_CODE: "default",
    DEFAULT_ADMIN_EMAIL: "",
    DEFAULT_ADMIN_PASSWORD: "",
    RUN_DB_SEED: "0",
    ALLOW_PRODUCTION_SEED: "0",
    WEB_ORIGIN: "",
    TRUST_PROXY: "0",
    WEB_PORT: "8080",
    VITE_REQUIRE_API: "1",
    VITE_DEMO_FALLBACK: "0",
    CLOUDFLARE_ACCOUNT_ID: "",
    CLOUDFLARE_API_TOKEN: "",
    CLOUDFLARE_TUNNEL_TOKEN: "",
    API_ORIGIN: "",
    CLOUDFLARE_DEPLOYMENT_URL: "",
    CLOUDFLARE_BACKEND_WEB_ORIGIN: ""
  };

  return [
    "# Generated production env preparation template. Not release evidence.",
    "# Fill blank values from the production secret manager and approved deployment settings.",
    "# Do not commit a completed .env.production file.",
    "",
    "# Runtime",
    renderEnvLine("APP_ENV", values.APP_ENV),
    renderEnvLine("NODE_ENV", values.NODE_ENV),
    "",
    "# Database. POSTGRES_PASSWORD must be injected from the managed secret store.",
    renderEnvLine("POSTGRES_DB", values.POSTGRES_DB),
    renderEnvLine("POSTGRES_USER", values.POSTGRES_USER),
    renderEnvLine("POSTGRES_PASSWORD", values.POSTGRES_PASSWORD),
    "",
    "# Auth/session. JWT_SECRET must be injected from the managed secret store.",
    renderEnvLine("JWT_SECRET", values.JWT_SECRET),
    renderEnvLine("JWT_EXPIRES_IN", values.JWT_EXPIRES_IN),
    renderEnvLine("COOKIE_NAME", values.COOKIE_NAME),
    renderEnvLine("COOKIE_MAX_AGE_SECONDS", values.COOKIE_MAX_AGE_SECONDS),
    renderEnvLine("AUTH_FAILED_LOGIN_LIMIT", values.AUTH_FAILED_LOGIN_LIMIT),
    renderEnvLine("AUTH_FAILED_LOGIN_WINDOW_MS", values.AUTH_FAILED_LOGIN_WINDOW_MS),
    renderEnvLine("AUTH_FAILED_LOGIN_MAX_KEYS", values.AUTH_FAILED_LOGIN_MAX_KEYS),
    "",
    "# File and import limits",
    renderEnvLine("FILE_MAX_UPLOAD_BYTES", values.FILE_MAX_UPLOAD_BYTES),
    renderEnvLine("IMPORT_MAX_HTML_BYTES", values.IMPORT_MAX_HTML_BYTES),
    renderEnvLine("API_BODY_LIMIT_BYTES", values.API_BODY_LIMIT_BYTES),
    "",
    "# File storage. Use local for a backed persistent volume, or s3 for object storage.",
    renderEnvLine("FILE_STORAGE_DRIVER", values.FILE_STORAGE_DRIVER),
    renderEnvLine("BACKUP_DIR", values.BACKUP_DIR),
    renderEnvLine("FILE_STORAGE_DIR", values.FILE_STORAGE_DIR),
    renderEnvLine("FILE_BACKUP_DIR", values.FILE_BACKUP_DIR),
    renderEnvLine("OBJECT_STORAGE_ENDPOINT", values.OBJECT_STORAGE_ENDPOINT),
    renderEnvLine("OBJECT_STORAGE_BUCKET", values.OBJECT_STORAGE_BUCKET),
    renderEnvLine("OBJECT_STORAGE_REGION", values.OBJECT_STORAGE_REGION),
    renderEnvLine("OBJECT_STORAGE_ACCESS_KEY_ID", values.OBJECT_STORAGE_ACCESS_KEY_ID),
    renderEnvLine("OBJECT_STORAGE_SECRET_ACCESS_KEY", values.OBJECT_STORAGE_SECRET_ACCESS_KEY),
    renderEnvLine("OBJECT_STORAGE_PREFIX", values.OBJECT_STORAGE_PREFIX),
    renderEnvLine("OBJECT_STORAGE_FORCE_PATH_STYLE", values.OBJECT_STORAGE_FORCE_PATH_STYLE),
    "",
    "# Optional production bootstrap. Keep RUN_DB_SEED=0 unless a reviewed bootstrap seed is approved.",
    renderEnvLine("DEFAULT_TENANT_CODE", values.DEFAULT_TENANT_CODE),
    renderEnvLine("DEFAULT_ADMIN_EMAIL", values.DEFAULT_ADMIN_EMAIL),
    renderEnvLine("DEFAULT_ADMIN_PASSWORD", values.DEFAULT_ADMIN_PASSWORD),
    renderEnvLine("RUN_DB_SEED", values.RUN_DB_SEED),
    renderEnvLine("ALLOW_PRODUCTION_SEED", values.ALLOW_PRODUCTION_SEED),
    "",
    "# Public runtime boundary",
    renderEnvLine("WEB_ORIGIN", values.WEB_ORIGIN),
    renderEnvLine("TRUST_PROXY", values.TRUST_PROXY),
    renderEnvLine("WEB_PORT", values.WEB_PORT),
    renderEnvLine("VITE_REQUIRE_API", values.VITE_REQUIRE_API),
    renderEnvLine("VITE_DEMO_FALLBACK", values.VITE_DEMO_FALLBACK),
    "",
    "# Cloudflare deployment. Keep token values in the managed secret store and GitHub repository secrets.",
    renderEnvLine("CLOUDFLARE_ACCOUNT_ID", values.CLOUDFLARE_ACCOUNT_ID),
    renderEnvLine("CLOUDFLARE_API_TOKEN", values.CLOUDFLARE_API_TOKEN),
    renderEnvLine("CLOUDFLARE_TUNNEL_TOKEN", values.CLOUDFLARE_TUNNEL_TOKEN),
    renderEnvLine("API_ORIGIN", values.API_ORIGIN),
    renderEnvLine("CLOUDFLARE_DEPLOYMENT_URL", values.CLOUDFLARE_DEPLOYMENT_URL),
    renderEnvLine("CLOUDFLARE_BACKEND_WEB_ORIGIN", values.CLOUDFLARE_BACKEND_WEB_ORIGIN),
    ""
  ].join("\n");
}

function secretChecklist(storageDriver, generatedAt) {
  const managedSecrets = [
    ...requiredManagedSecrets,
    ...(storageDriver === "s3" ? ["OBJECT_STORAGE_ACCESS_KEY_ID", "OBJECT_STORAGE_SECRET_ACCESS_KEY"] : [])
  ];
  const cloudflareRepositorySecrets = [
    "CLOUDFLARE_API_TOKEN",
    "CLOUDFLARE_ACCOUNT_ID",
    "API_ORIGIN",
    "CLOUDFLARE_DEPLOYMENT_URL",
    "CLOUDFLARE_TUNNEL_TOKEN",
    "CLOUDFLARE_BACKEND_WEB_ORIGIN"
  ];
  return {
    schemaVersion: 1,
    draft: true,
    kind: "production-secret-store-checklist",
    generatedAt,
    noPlaintextSecretValues: true,
    managedSecrets: managedSecrets.map((key) => ({
      key,
      required: true,
      injectAtRuntime: true,
      neverCommit: true,
      rotationRequired: true
    })),
    conditionalSecrets: [
      {
        key: "DEFAULT_ADMIN_PASSWORD",
        condition: "Required only when RUN_DB_SEED=1 and ALLOW_PRODUCTION_SEED=1 after reviewed bootstrap approval.",
        injectAtRuntime: true,
        neverCommit: true
      }
    ],
    cloudflareRepositorySecrets: cloudflareRepositorySecrets.map((key) => ({
      key,
      requiredForCloudflareDeploy: true,
      writeWith: "npm run configure:cloudflare -- --env .env.production --repo 17602842555/HR --apply --json",
      neverPrintValue: key.includes("TOKEN")
    })),
    originControls: {
      key: "WEB_ORIGIN",
      requiresHttps: true,
      noWildcard: true,
      noExampleDomain: true,
      approvalRequired: true
    },
    nextCommands: [
      "npm run validate:production-env -- .env.production --json",
      "npm run validate:cloudflare-backend -- --env .env.production --json",
      "npm run configure:cloudflare -- --env .env.production --repo 17602842555/HR --json",
      "npm run configure:cloudflare-tunnel -- --env .env.production --tunnel <tunnel-uuid> --json",
      "npm run signoff:drafts -- --env .env.production --json",
      "npm run validate:secrets-signoff -- <production-secrets-signoff.json> --env .env.production --json"
    ]
  };
}

function readmeText({ generatedAt, storageDriver, targetEnvPath }) {
  return [
    "# Production Env Preparation",
    "",
    `Generated at: ${generatedAt}`,
    `Target env file: ${targetEnvPath}`,
    `Storage driver: ${storageDriver}`,
    "",
    "This directory is a preparation package only. It is not release evidence and it does not contain plaintext secret values.",
    "",
    "Use `.env.production.template` as the field checklist for the deployment secret store. Fill the real `.env.production` through the approved secret-management process, then run:",
    "",
    "```bash",
    "npm run validate:production-env -- .env.production --json",
    "npm run validate:cloudflare-backend -- --env .env.production --json",
    "npm run configure:cloudflare -- --env .env.production --repo 17602842555/HR --json",
    "npm run configure:cloudflare-tunnel -- --env .env.production --tunnel <tunnel-uuid> --json",
    "npm run signoff:drafts -- --env .env.production --json",
    "npm run validate:secrets-signoff -- <production-secrets-signoff.json> --env .env.production --json",
    "```",
    "",
    "Do not commit completed production env files or reviewer signoff files that contain operational paths not intended for source control.",
    ""
  ].join("\n");
}

function buildManifest({ cloudflareBackendValidation, files, generatedAt, outputDir, rootDir, storageDriver, targetEnvPath, templateValidation }) {
  return {
    schemaVersion: 1,
    draft: true,
    kind: "production-env-preparation",
    generatedAt,
    outputDir: relative(rootDir, outputDir) || ".",
    targetEnvPath,
    storageDriver,
    requiredEnvKeys: [...requiredProductionEnvKeys],
    noPlaintextSecretValues: true,
    templateValidationSummary: {
      ok: templateValidation.ok,
      expectedToFailUntilFilled: true,
      errorCount: templateValidation.errors.length,
      warnings: templateValidation.warnings
    },
    cloudflareBackendValidationSummary: {
      ok: cloudflareBackendValidation.ok,
      expectedToFailUntilFilled: true,
      errorCount: cloudflareBackendValidation.errors.length,
      warnings: cloudflareBackendValidation.warnings
    },
    files: Object.fromEntries(Object.entries(files).map(([key, filePath]) => [key, relative(rootDir, filePath)])),
    releaseUse: "Preparation package only. It is not release evidence until a real .env.production and reviewed signoff files pass validators.",
    nextCommands: [
      "npm run validate:production-env -- .env.production --json",
      "npm run validate:cloudflare-backend -- --env .env.production --json",
      "npm run configure:cloudflare -- --env .env.production --repo 17602842555/HR --json",
      "npm run validate:secrets-signoff -- <production-secrets-signoff.json> --env .env.production --json",
      "npm run evidence:commercial -- --full --strict-readiness"
    ]
  };
}

export function prepareProductionEnv(options = {}) {
  const rootDir = resolve(options.rootDir || process.cwd());
  const now = options.now || new Date();
  const generatedAt = nowIso(now);
  const storageDriver = String(options.storageDriver || "local").trim() || "local";
  if (!supportedStorageDrivers.has(storageDriver)) {
    throw new Error("storage driver must be local or s3.");
  }
  const targetEnvPath = options.targetEnvPath || ".env.production";
  const baseOutputDir = resolveFromRoot(rootDir, options.outputDir || defaultOutputDir);
  const runDir = join(baseOutputDir, `production-env-prep-${slugTimestamp(generatedAt)}`);
  const files = {
    envTemplate: join(runDir, ".env.production.template"),
    checklist: join(runDir, "secret-store-checklist.json"),
    readme: join(runDir, "README.md"),
    manifest: join(runDir, "manifest.json")
  };
  const template = productionEnvTemplate(storageDriver);
  const checklist = secretChecklist(storageDriver, generatedAt);
  const templateEnv = Object.fromEntries(template
    .split("\n")
    .filter((line) => line && !line.startsWith("#") && line.includes("="))
    .map((line) => {
      const index = line.indexOf("=");
      return [line.slice(0, index), line.slice(index + 1)];
    }));
  const templateValidation = validateProductionEnv(templateEnv);
  const cloudflareBackendValidation = validateCloudflareBackendEnv(templateEnv);
  const manifest = buildManifest({
    cloudflareBackendValidation,
    files,
    generatedAt,
    outputDir: runDir,
    rootDir,
    storageDriver,
    targetEnvPath,
    templateValidation
  });

  ensurePrivateDir(baseOutputDir);
  ensurePrivateDir(runDir);
  writePrivateTextFile(files.envTemplate, template);
  writePrivateTextFile(files.checklist, `${JSON.stringify(checklist, null, 2)}\n`);
  writePrivateTextFile(files.readme, readmeText({ generatedAt, storageDriver, targetEnvPath }));
  writePrivateTextFile(files.manifest, `${JSON.stringify(manifest, null, 2)}\n`);
  writePrivateTextFile(join(baseOutputDir, "latest-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  return { generatedAt, outputDir: runDir, files, manifest, checklist };
}

export function parseProductionEnvPrepArgs(argv = []) {
  const options = {
    outputDir: defaultOutputDir,
    storageDriver: "local",
    targetEnvPath: ".env.production",
    json: argv.includes("--json")
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--output") {
      options.outputDir = argv[index + 1] || options.outputDir;
      index += 1;
    } else if (arg === "--storage-driver") {
      options.storageDriver = argv[index + 1] || options.storageDriver;
      index += 1;
    } else if (arg === "--env") {
      options.targetEnvPath = argv[index + 1] || options.targetEnvPath;
      index += 1;
    }
  }
  return options;
}

async function main(argv = process.argv.slice(2)) {
  const options = parseProductionEnvPrepArgs(argv);
  try {
    const result = prepareProductionEnv(options);
    const payload = {
      ok: true,
      outputDir: result.outputDir,
      files: result.files,
      noPlaintextSecretValues: result.manifest.noPlaintextSecretValues,
      nextCommands: result.manifest.nextCommands
    };
    if (options.json) {
      console.log(JSON.stringify(payload, null, 2));
    } else {
      console.log(`Production env preparation package generated: ${result.outputDir}`);
      Object.values(result.files).forEach((filePath) => console.log(`- ${filePath}`));
      console.log("No plaintext secret values were generated. Fill the real .env.production through the secret-store process.");
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

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main();
}
