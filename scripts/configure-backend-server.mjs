import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseDotenvText } from "./commercial-doctor-core.mjs";
import { generateSignoffDrafts } from "./generate-signoff-drafts.mjs";
import { prepareHrDataReview } from "./prepare-hr-data-review.mjs";
import { prepareProductionEnv } from "./prepare-production-env.mjs";
import { validateCloudflareBackendEnv } from "./validate-cloudflare-backend.mjs";
import { validateProductionEnv } from "./validate-production-env.mjs";

const defaultOutputDir = "reports/commercial-evidence/backend-server-config";
const defaultRepo = "17602842555/HR";
const defaultTunnel = "399ce110-a343-43b5-81cd-333f5f86212c";

export const requiredBackendRepositorySecrets = Object.freeze([
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_DEPLOYMENT_URL"
]);

export const requiredReleaseEnvironmentSecrets = Object.freeze([
  "PRODUCTION_ENV_B64",
  "PRODUCTION_SECRETS_SIGNOFF_B64",
  "HR_DATA_SIGNOFF_B64",
  "FILE_STORAGE_SIGNOFF_B64"
]);

function nowIso(now = new Date()) {
  return now.toISOString();
}

function slugTimestamp(value) {
  return String(value || nowIso()).replaceAll(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function resolveFromRoot(rootDir, path) {
  if (!path) return rootDir;
  return isAbsolute(path) ? path : resolve(rootDir, path);
}

function pathForManifest(rootDir, path) {
  const value = relative(rootDir, path);
  return value || ".";
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

function writePrivateJsonFile(path, payload) {
  writePrivateTextFile(path, `${JSON.stringify(payload, null, 2)}\n`);
}

function redactMessage(value = "") {
  return String(value || "")
    .replaceAll(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replaceAll(/(password|secret|token|key)=\S+/gi, "$1=[REDACTED]")
    .replaceAll(/[A-Za-z0-9_./+=:-]{64,}/g, "[REDACTED]");
}

function summarizeValidation(report = {}) {
  return {
    ok: Boolean(report.ok),
    errorCount: Array.isArray(report.errors) ? report.errors.length : 0,
    warningCount: Array.isArray(report.warnings) ? report.warnings.length : 0,
    errors: Array.isArray(report.errors) ? report.errors.map(redactMessage) : [],
    warnings: Array.isArray(report.warnings) ? report.warnings.map(redactMessage) : []
  };
}

export function parseGithubSecretList(text = "") {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split(/\s+/)[0])
    .filter((name) => /^[A-Z0-9_]+$/.test(name));
}

export function listGithubSecrets({
  environment = "",
  repo = defaultRepo,
  runner = spawnSync
} = {}) {
  const args = ["secret", "list", "--repo", repo];
  if (environment) args.push("--env", environment);
  const result = runner("gh", args, {
    encoding: "utf8",
    maxBuffer: 1024 * 1024
  });
  if (result.status !== 0) {
    return {
      environment: environment || null,
      errors: [redactMessage(result.stderr || result.stdout || "gh secret list failed.")],
      names: [],
      ok: false,
      status: result.status ?? 1
    };
  }
  return {
    environment: environment || null,
    errors: [],
    names: parseGithubSecretList(result.stdout),
    ok: true,
    status: 0
  };
}

function githubRepoApiPath(repo) {
  const value = String(repo || "").trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) {
    throw new Error("GitHub repo must be provided as owner/name.");
  }
  return `repos/${value}`;
}

function githubEnvironmentName(environment) {
  const value = String(environment || "").trim();
  if (!value || !/^[A-Za-z0-9_.-]+$/.test(value)) {
    throw new Error("GitHub environment name must contain only letters, numbers, dots, dashes, or underscores.");
  }
  return value;
}

export function ensureGithubEnvironment({
  environment = "production",
  repo = defaultRepo,
  runner = spawnSync
} = {}) {
  const normalizedEnvironment = githubEnvironmentName(environment);
  const endpoint = `${githubRepoApiPath(repo)}/environments/${encodeURIComponent(normalizedEnvironment)}`;
  const body = `${JSON.stringify({
    deployment_branch_policy: null,
    wait_timer: 0
  })}\n`;
  const result = runner("gh", ["api", "-X", "PUT", endpoint, "--input", "-"], {
    encoding: "utf8",
    input: body,
    maxBuffer: 1024 * 1024
  });

  if (result.status !== 0) {
    return {
      environment: normalizedEnvironment,
      errors: [redactMessage(result.stderr || result.stdout || "gh environment create/update failed.")],
      ok: false,
      repo,
      status: result.status ?? 1
    };
  }

  let parsed = {};
  try {
    parsed = JSON.parse(result.stdout || "{}");
  } catch {
    parsed = {};
  }
  return {
    environment: normalizedEnvironment,
    errors: [],
    ok: true,
    repo,
    status: 0,
    urlPresent: Boolean(parsed.url || parsed.html_url)
  };
}

function buildSecretStatus({ environmentSecretNames = [], repositorySecretNames = [] } = {}) {
  const repoSet = new Set(repositorySecretNames);
  const envSet = new Set(environmentSecretNames);
  const repositorySecrets = requiredBackendRepositorySecrets.map((name) => ({
    configured: repoSet.has(name),
    name,
    scope: "repository"
  }));
  const environmentSecrets = requiredReleaseEnvironmentSecrets.map((name) => ({
    configured: envSet.has(name),
    name,
    scope: "environment"
  }));
  return {
    environmentSecrets,
    missingEnvironmentSecrets: environmentSecrets.filter((item) => !item.configured).map((item) => item.name),
    missingRepositorySecrets: repositorySecrets.filter((item) => !item.configured).map((item) => item.name),
    repositorySecrets
  };
}

function inspectProductionEnv({ envPath, rootDir }) {
  const absolutePath = resolveFromRoot(rootDir, envPath);
  const relativePath = pathForManifest(rootDir, absolutePath);
  if (!existsSync(absolutePath)) {
    const missing = {
      errors: [`Production env file does not exist: ${relativePath}`],
      ok: false,
      warnings: []
    };
    return {
      exists: false,
      path: relativePath,
      productionEnv: summarizeValidation(missing),
      cloudflareBackend: summarizeValidation(missing)
    };
  }

  const env = parseDotenvText(readFileSync(absolutePath, "utf8"));
  return {
    exists: true,
    path: relativePath,
    productionEnv: summarizeValidation(validateProductionEnv(env)),
    cloudflareBackend: summarizeValidation(validateCloudflareBackendEnv(env))
  };
}

function base64SecretCommands({ environment, repo }) {
  return [
    {
      name: "PRODUCTION_ENV_B64",
      command: `base64 < .env.production | tr -d '\\n' | gh secret set PRODUCTION_ENV_B64 --repo ${repo} --env ${environment}`
    },
    {
      name: "PRODUCTION_SECRETS_SIGNOFF_B64",
      command: `base64 < docs/production-secrets-signoff.json | tr -d '\\n' | gh secret set PRODUCTION_SECRETS_SIGNOFF_B64 --repo ${repo} --env ${environment}`
    },
    {
      name: "HR_DATA_SIGNOFF_B64",
      command: `base64 < docs/hr-data-signoff.json | tr -d '\\n' | gh secret set HR_DATA_SIGNOFF_B64 --repo ${repo} --env ${environment}`
    },
    {
      name: "FILE_STORAGE_SIGNOFF_B64",
      command: `base64 < docs/file-storage-signoff.json | tr -d '\\n' | gh secret set FILE_STORAGE_SIGNOFF_B64 --repo ${repo} --env ${environment}`
    }
  ];
}

function buildOwnerInputs({
  environment,
  repo,
  storageDriver,
  tunnel
}) {
  return {
    schemaVersion: 1,
    kind: "backend-server-owner-inputs",
    noPlaintextSecretValues: true,
    ownerGroups: [
      {
        id: "security",
        gapIds: ["GAP-003"],
        requiredInputs: [
          "Real .env.production from the approved secret manager.",
          "Cloudflare API token with Workers deploy and Tunnel write permissions.",
          "Approved HTTPS API_ORIGIN for the backend Tunnel hostname.",
          "Reviewed production secrets signoff."
        ],
        validationCommands: [
          "npm run validate:production-env -- .env.production --json",
          "npm run validate:cloudflare-backend -- --env .env.production --json",
          `npm run configure:cloudflare -- --env .env.production --repo ${repo} --verify-token --json`,
          `npm run configure:cloudflare-tunnel -- --env .env.production --tunnel ${tunnel || "<tunnel-uuid>"} --json`,
          `npm run configure:release-inputs -- --ensure-github-environment --repo ${repo} --environment ${environment} --json`,
          "npm run validate:secrets-signoff -- docs/production-secrets-signoff.json --env .env.production --json"
        ]
      },
      {
        id: "infrastructure",
        gapIds: ["GAP-004"],
        requiredInputs: [
          storageDriver === "s3"
            ? "Production S3-compatible attachment bucket, access policy, backup or replication policy, and restore evidence."
            : "Production backed persistent volume path for FILE_STORAGE_DIR plus independent file backup and restore evidence.",
          "Reviewed file storage signoff with restore drill and attachment download smoke."
        ],
        validationCommands: [
          "npm run validate:storage-signoff -- docs/file-storage-signoff.json --environment production --json",
          "npm run validate:drill-evidence -- --json"
        ]
      },
      {
        id: "product-hr",
        gapIds: ["GAP-005"],
        requiredInputs: [
          "HR/Product review of masked personnel counts from oa-dashboard.html.",
          "Reviewed HR data signoff covering retention, export policy, and sensitive-field masking."
        ],
        validationCommands: [
          "npm run prepare:hr-review -- --json",
          "npm run validate:hr-signoff -- docs/hr-data-signoff.json --source oa-dashboard.html --json"
        ]
      },
      {
        id: "release",
        gapIds: ["GAP-003", "GAP-004", "GAP-005"],
        requiredInputs: [
          `GitHub ${environment} environment secrets for base64 release inputs.`,
          "Full evidence package generated against production or approved staging."
        ],
        validationCommands: [
          `npm run configure:release-inputs -- --ensure-github-environment --repo ${repo} --environment ${environment} --apply --json`,
          `gh workflow run commercial-signoff.yml --repo ${repo} -f target_environment=${environment}`,
          "EVIDENCE_RUN_E2E=1 npm run evidence:commercial -- --full --strict-readiness",
          "npm run release:gate -- reports/commercial-evidence/latest.json --json"
        ]
      }
    ],
    requiredRepositorySecrets: [...requiredBackendRepositorySecrets],
    requiredEnvironmentSecrets: [...requiredReleaseEnvironmentSecrets],
    safeBase64SecretCommands: base64SecretCommands({ environment, repo })
  };
}

function renderList(items, fallback = "- None") {
  if (!items?.length) return fallback;
  return items.map((item) => `- ${item}`).join("\n");
}

function renderSecretRows(items) {
  return items.map((item) => `| ${item.name} | ${item.scope} | ${item.configured ? "yes" : "no"} |`).join("\n");
}

function renderIndexMarkdown({ generatedAt, manifest }) {
  const repoMissing = manifest.githubSecrets.missingRepositorySecrets;
  const envMissing = manifest.githubSecrets.missingEnvironmentSecrets;
  return [
    "# Backend Server Configuration Packet",
    "",
    `Generated at: ${generatedAt}`,
    `Repository: ${manifest.repo}`,
    `GitHub environment: ${manifest.environment}`,
    `Storage driver: ${manifest.storageDriver}`,
    "",
    "This packet prepares the backend server deployment path. It contains no plaintext secret values and is not release evidence.",
    "",
    "## Current Status",
    "",
    `- Production env file present: ${manifest.production.exists ? "yes" : "no"}`,
    `- Production env validation: ${manifest.production.productionEnv.ok ? "pass" : "blocked"}`,
    `- Cloudflare backend validation: ${manifest.production.cloudflareBackend.ok ? "pass" : "blocked"}`,
    `- Missing repository secrets: ${repoMissing.length}`,
    `- Missing environment secrets: ${envMissing.length}`,
    "",
    "## Missing Repository Secrets",
    "",
    renderList(repoMissing),
    "",
    "## Missing Environment Secrets",
    "",
    renderList(envMissing),
    "",
    "## Generated Inputs",
    "",
    `- Production env preparation: ${manifest.generated.productionEnvPreparation.manifest}`,
    `- Signoff drafts: ${manifest.generated.signoffDrafts.manifest}`,
    `- HR review packet: ${manifest.generated.hrReview.manifest}`,
    "",
    "## Next Commands",
    "",
    "```bash",
    "npm run validate:production-env -- .env.production --json",
    "npm run validate:cloudflare-backend -- --env .env.production --json",
    `npm run configure:cloudflare -- --env .env.production --repo ${manifest.repo} --verify-token --json`,
    `npm run configure:cloudflare-tunnel -- --env .env.production --tunnel ${manifest.tunnel || "<tunnel-uuid>"} --json`,
    `npm run configure:release-inputs -- --ensure-github-environment --repo ${manifest.repo} --environment ${manifest.environment} --apply --json`,
    `gh workflow run commercial-signoff.yml --repo ${manifest.repo} -f target_environment=${manifest.environment}`,
    "EVIDENCE_RUN_E2E=1 npm run evidence:commercial -- --full --strict-readiness",
    "npm run release:gate -- reports/commercial-evidence/latest.json --json",
    "```",
    ""
  ].join("\n");
}

function renderGithubSecretsMarkdown({ environment, repo, secretStatus }) {
  return [
    "# GitHub And Cloudflare Secret Handoff",
    "",
    "Do not paste secret values into issue comments, commits, screenshots, or command-line arguments. Use stdin or the GitHub web UI.",
    "",
    "## Repository Secrets",
    "",
    "| Name | Scope | Configured |",
    "| --- | --- | --- |",
    renderSecretRows(secretStatus.repositorySecrets),
    "",
    "## Environment Secrets",
    "",
    `Environment: ${environment}`,
    "",
    "| Name | Scope | Configured |",
    "| --- | --- | --- |",
    renderSecretRows(secretStatus.environmentSecrets),
    "",
    "## Safe Base64 Commands",
    "",
    "These commands read file content from stdin and do not place secret values in shell arguments:",
    "",
    "```bash",
    ...base64SecretCommands({ environment, repo }).map((item) => item.command),
    "```",
    "",
    "After the repository Cloudflare secrets are present, dry-run before applying:",
    "",
    "```bash",
    `npm run configure:cloudflare -- --env .env.production --repo ${repo} --verify-token --json`,
    `npm run configure:cloudflare -- --env .env.production --repo ${repo} --verify-token --apply --json`,
    "```",
    ""
  ].join("\n");
}

function renderServerRunbookMarkdown({ repo, tunnel }) {
  return [
    "# Backend Server Runbook",
    "",
    "The backend remains Fastify + Prisma + PostgreSQL. Cloudflare Worker is the edge gateway, and Cloudflare Tunnel exposes the API without opening an inbound API port.",
    "",
    "## 1. Fill Production Env",
    "",
    "```bash",
    "npm run prepare:production-env -- --json",
    "npm run validate:production-env -- .env.production --json",
    "npm run validate:cloudflare-backend -- --env .env.production --json",
    "```",
    "",
    "## 2. Configure Cloudflare Repository Secrets",
    "",
    "```bash",
    `npm run configure:cloudflare -- --env .env.production --repo ${repo} --verify-token --json`,
    `npm run configure:cloudflare -- --env .env.production --repo ${repo} --verify-token --apply --json`,
    "```",
    "",
    "## 3. Configure Tunnel Public Hostname",
    "",
    "```bash",
    `npm run configure:cloudflare-tunnel -- --env .env.production --tunnel ${tunnel || "<tunnel-uuid>"} --json`,
    `npm run configure:cloudflare-tunnel -- --env .env.production --tunnel ${tunnel || "<tunnel-uuid>"} --apply --json`,
    "```",
    "",
    "The expected Tunnel service target is `http://api:8787` with a final `http_status:404` catch-all rule.",
    "",
    "## 4. Start Backend Server",
    "",
    "```bash",
    "docker compose -f docker-compose.prod.yml -f docker-compose.cloudflare.yml --env-file .env.production up -d --build postgres api cloudflared",
    "```",
    "",
    "## 5. Verify Public Gateway",
    "",
    "```bash",
    `npm run doctor:cloudflare -- --repo ${repo} --tunnel ${tunnel || "<tunnel-uuid>"} --json`,
    "npm run smoke:cloudflare -- --url \"$CLOUDFLARE_DEPLOYMENT_URL\" --json",
    "```",
    ""
  ].join("\n");
}

function makeGeneratedSummary(rootDir, result) {
  return {
    outputDir: pathForManifest(rootDir, result.outputDir),
    manifest: pathForManifest(rootDir, result.files.manifest)
  };
}

export function configureBackendServerPackage(options = {}) {
  const rootDir = resolve(options.rootDir || process.cwd());
  const now = options.now || new Date();
  const generatedAt = nowIso(now);
  const outputDir = resolveFromRoot(rootDir, options.outputDir || defaultOutputDir);
  const runDir = join(outputDir, `backend-server-config-${slugTimestamp(generatedAt)}`);
  const environment = String(options.environment || "production").trim() || "production";
  const repo = String(options.repo || defaultRepo).trim() || defaultRepo;
  const sourcePath = options.sourcePath || "oa-dashboard.html";
  const storageDriver = String(options.storageDriver || "local").trim() || "local";
  const targetEnvPath = options.envPath || ".env.production";
  const tunnel = String(options.tunnel || defaultTunnel).trim();

  ensurePrivateDir(outputDir);
  ensurePrivateDir(runDir);

  const productionEnvPreparation = prepareProductionEnv({
    rootDir,
    outputDir: join(runDir, "production-env-prep"),
    storageDriver,
    targetEnvPath,
    now
  });
  const signoffDrafts = generateSignoffDrafts({
    rootDir,
    outputDir: join(runDir, "signoff-drafts"),
    sourcePath,
    envPath: targetEnvPath,
    fileStorageDir: options.fileStorageDir || "",
    now
  });
  const hrReview = prepareHrDataReview({
    rootDir,
    outputDir: join(runDir, "hr-data-review"),
    sourcePath,
    now
  });

  const environmentEnsure = options.ensureGithubEnvironment
    ? ensureGithubEnvironment({
      environment,
      repo,
      runner: options.runner || spawnSync
    })
    : {
      environment,
      errors: [],
      ok: false,
      repo,
      skipped: true,
      status: null
    };

  let repositorySecretInspection = {
    environment: null,
    errors: [],
    names: options.repositorySecretNames || [],
    ok: true,
    status: 0
  };
  let environmentSecretInspection = {
    environment,
    errors: [],
    names: options.environmentSecretNames || [],
    ok: true,
    status: 0
  };

  if (options.inspectGithubSecrets) {
    repositorySecretInspection = listGithubSecrets({
      repo,
      runner: options.runner || spawnSync
    });
    environmentSecretInspection = listGithubSecrets({
      environment,
      repo,
      runner: options.runner || spawnSync
    });
  }

  const secretStatus = buildSecretStatus({
    repositorySecretNames: repositorySecretInspection.names,
    environmentSecretNames: environmentSecretInspection.names
  });
  const production = inspectProductionEnv({ envPath: targetEnvPath, rootDir });
  const ownerInputs = buildOwnerInputs({
    environment,
    repo,
    storageDriver,
    tunnel
  });
  const files = {
    githubSecrets: join(runDir, "github-secrets.md"),
    index: join(runDir, "README.md"),
    manifest: join(runDir, "manifest.json"),
    ownerInputs: join(runDir, "owner-inputs.json"),
    serverRunbook: join(runDir, "server-runbook.md")
  };

  const manifest = {
    schemaVersion: 1,
    kind: "backend-server-configuration",
    generatedAt,
    environment,
    repo,
    tunnel,
    storageDriver,
    noPlaintextSecretValues: true,
    outputDir: pathForManifest(rootDir, runDir),
    production,
    githubInspection: {
      environmentEnsure: {
        environment: environmentEnsure.environment,
        errorCount: Array.isArray(environmentEnsure.errors) ? environmentEnsure.errors.length : 0,
        ok: environmentEnsure.ok,
        skipped: Boolean(environmentEnsure.skipped)
      },
      environment: {
        environment: environmentSecretInspection.environment,
        errorCount: environmentSecretInspection.errors.length,
        ok: environmentSecretInspection.ok
      },
      repository: {
        errorCount: repositorySecretInspection.errors.length,
        ok: repositorySecretInspection.ok
      }
    },
    githubSecrets: secretStatus,
    generated: {
      hrReview: makeGeneratedSummary(rootDir, hrReview),
      productionEnvPreparation: makeGeneratedSummary(rootDir, productionEnvPreparation),
      signoffDrafts: makeGeneratedSummary(rootDir, signoffDrafts)
    },
    files: Object.fromEntries(Object.entries(files).map(([key, filePath]) => [key, pathForManifest(rootDir, filePath)])),
    releaseUse: "Configuration handoff only. Release acceptance still requires reviewed non-example signoffs, production evidence, and release:gate.",
    nextCommands: [
      "npm run validate:production-env -- .env.production --json",
      "npm run validate:cloudflare-backend -- --env .env.production --json",
      `npm run configure:cloudflare -- --env .env.production --repo ${repo} --verify-token --json`,
      `npm run configure:cloudflare-tunnel -- --env .env.production --tunnel ${tunnel || "<tunnel-uuid>"} --json`,
      `npm run configure:release-inputs -- --ensure-github-environment --repo ${repo} --environment ${environment} --apply --json`,
      `gh workflow run commercial-signoff.yml --repo ${repo} -f target_environment=${environment}`,
      "EVIDENCE_RUN_E2E=1 npm run evidence:commercial -- --full --strict-readiness",
      "npm run release:gate -- reports/commercial-evidence/latest.json --json"
    ]
  };

  writePrivateJsonFile(files.ownerInputs, ownerInputs);
  writePrivateTextFile(files.githubSecrets, renderGithubSecretsMarkdown({ environment, repo, secretStatus }));
  writePrivateTextFile(files.serverRunbook, renderServerRunbookMarkdown({ repo, tunnel }));
  writePrivateJsonFile(files.manifest, manifest);
  writePrivateTextFile(files.index, renderIndexMarkdown({ generatedAt, manifest }));
  writePrivateJsonFile(join(outputDir, "latest-manifest.json"), manifest);
  writePrivateTextFile(join(outputDir, "latest-index.md"), renderIndexMarkdown({ generatedAt, manifest }));

  const ready = production.productionEnv.ok
    && production.cloudflareBackend.ok
    && secretStatus.missingRepositorySecrets.length === 0
    && secretStatus.missingEnvironmentSecrets.length === 0;

  return {
    environment,
    files,
    generatedAt,
    manifest,
    outputDir: runDir,
    ready,
    repo
  };
}

export function parseBackendServerConfigArgs(argv = []) {
  const options = {
    environment: "production",
    envPath: ".env.production",
    ensureGithubEnvironment: argv.includes("--ensure-github-environment"),
    fileStorageDir: "",
    inspectGithubSecrets: argv.includes("--inspect-github-secrets"),
    json: argv.includes("--json"),
    outputDir: defaultOutputDir,
    repo: defaultRepo,
    sourcePath: "oa-dashboard.html",
    storageDriver: "local",
    tunnel: defaultTunnel
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--environment") {
      options.environment = argv[index + 1] || options.environment;
      index += 1;
    } else if (arg === "--ensure-github-environment") {
      // Already handled by includes().
    } else if (arg === "--env") {
      options.envPath = argv[index + 1] || options.envPath;
      index += 1;
    } else if (arg === "--file-storage-dir") {
      options.fileStorageDir = argv[index + 1] || options.fileStorageDir;
      index += 1;
    } else if (arg === "--inspect-github-secrets" || arg === "--json") {
      // Already handled by includes().
    } else if (arg === "--output") {
      options.outputDir = argv[index + 1] || options.outputDir;
      index += 1;
    } else if (arg === "--repo") {
      options.repo = argv[index + 1] || options.repo;
      index += 1;
    } else if (arg === "--source") {
      options.sourcePath = argv[index + 1] || options.sourcePath;
      index += 1;
    } else if (arg === "--storage-driver") {
      options.storageDriver = argv[index + 1] || options.storageDriver;
      index += 1;
    } else if (arg === "--tunnel") {
      options.tunnel = argv[index + 1] || options.tunnel;
      index += 1;
    } else {
      throw new Error(`Unknown backend server configuration argument: ${arg}`);
    }
  }
  return options;
}

async function main(argv = process.argv.slice(2)) {
  const options = parseBackendServerConfigArgs(argv);
  try {
    const result = configureBackendServerPackage(options);
    const payload = {
      ok: true,
      ready: result.ready,
      outputDir: result.outputDir,
      files: result.files,
      missingRepositorySecrets: result.manifest.githubSecrets.missingRepositorySecrets,
      missingEnvironmentSecrets: result.manifest.githubSecrets.missingEnvironmentSecrets,
      productionEnvReady: result.manifest.production.productionEnv.ok,
      cloudflareBackendReady: result.manifest.production.cloudflareBackend.ok,
      nextCommands: result.manifest.nextCommands
    };
    if (options.json) {
      console.log(JSON.stringify(payload, null, 2));
    } else {
      console.log(`Backend server configuration packet generated: ${result.outputDir}`);
      console.log(`Ready for release validation: ${result.ready ? "yes" : "no"}`);
      Object.values(result.files).forEach((filePath) => console.log(`- ${filePath}`));
      if (!result.ready) {
        console.log("Open inputs remain. See README.md and owner-inputs.json in the packet.");
      }
    }
  } catch (error) {
    if (options.json) {
      console.log(JSON.stringify({ ok: false, errors: [redactMessage(error.message)] }, null, 2));
    } else {
      console.error(redactMessage(error.message));
    }
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main();
}
