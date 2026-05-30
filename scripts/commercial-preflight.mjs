import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);

function readText(path) {
  return readFileSync(resolve(root, path), "utf8");
}

function readJson(path) {
  return JSON.parse(readText(path));
}

function assert(condition, message, details = {}) {
  if (!condition) {
    const error = new Error(message);
    error.details = details;
    throw error;
  }
}

function assertFile(path) {
  assert(existsSync(resolve(root, path)), `Required commercial artifact is missing: ${path}`);
}

function assertIncludes(text, needle, label) {
  assert(text.includes(needle), `${label} is missing required content`, { needle });
}

function assertNotIncludes(text, needle, label) {
  assert(!text.includes(needle), `${label} still contains forbidden placeholder content`, { needle });
}

function countMatches(text, pattern) {
  return [...text.matchAll(pattern)].length;
}

function extractBackendPermissionCodes(seedText) {
  const section = seedText.match(/const permissions = \[([\s\S]*?)\];/);
  assert(section, "scripts/seed.mjs missing backend permission seed section");
  return [...section[1].matchAll(/\["([^"]+)"/g)].map((match) => match[1]).sort();
}

function extractFrontendPermissionCodes(seedText) {
  const section = seedText.match(/export const permissionCatalog = \[([\s\S]*?)\];/);
  assert(section, "src/data/seed.js missing frontend permission catalog section");
  return [...section[1].matchAll(/code: "([^"]+)"/g)].map((match) => match[1]).sort();
}

function walkMjsFiles(dirPath) {
  return readdirSync(resolve(root, dirPath), { withFileTypes: true }).flatMap((entry) => {
    const child = `${dirPath}/${entry.name}`;
    if (entry.isDirectory()) return walkMjsFiles(child);
    return statSync(resolve(root, child)).isFile() && entry.name.endsWith(".mjs") ? [child] : [];
  });
}

function extractRoutePermissionRequirements() {
  return walkMjsFiles("server/src/modules").flatMap((path) => {
    const source = readText(path);
    return [...source.matchAll(/requirePermission\(app,\s*request,\s*\{[\s\S]*?module:\s*"([^"]+)"[\s\S]*?action:\s*"([^"]+)"/g)]
      .map((match) => ({ path, module: match[1], action: match[2] }));
  });
}

function extractAuthenticatedRoutes() {
  return [...walkMjsFiles("server/src/modules"), "server/src/app.mjs"].flatMap((path) => {
    const source = readText(path);
    const matches = [...source.matchAll(/app\.(get|post|put|patch|delete)\(\s*"([^"]+)"\s*,\s*\{\s*preHandler:\s*app\.authenticate\s*\}\s*,/g)];
    return matches.map((match, index) => {
      const next = matches[index + 1];
      return {
        path,
        method: match[1].toUpperCase(),
        route: match[2],
        body: source.slice(match.index, next?.index ?? source.length)
      };
    });
  });
}

function routeKey(route) {
  return `${route.method} ${route.route}`;
}

const authenticatedRouteIamExceptions = new Set([
  "GET /api/auth/me",
  "POST /api/auth/change-password",
  "POST /api/auth/logout",
  "GET /api/protected/ping"
]);

const customAuthenticatedRouteGuards = new Map([
  ["GET /api/people", ["employeeScopeWhere(principal, \"read\")"]],
  ["GET /api/people/employees", ["employeeScopeWhere(principal, \"read\")"]],
  ["GET /api/people/leavers", ["employeeScopeWhere(principal, \"read\")"]],
  [
    "POST /api/people/export",
    ["employeeScopeWhere(principal, \"export\")", "requireEmployeeAccess(principal, \"export\""]
  ],
  ["PATCH /api/people/employees/:id", ["requireEmployeeAccess(principal, \"write\""]]
]);

function routeHasRecognizedIamGuard(route) {
  if (route.body.includes("requirePermission(app, request")) return true;
  const customGuardNeedles = customAuthenticatedRouteGuards.get(routeKey(route));
  return Boolean(customGuardNeedles?.every((needle) => route.body.includes(needle)));
}

function permissionCodeCoversRoute(code, required) {
  return code === `${required.module}.${required.action}` || code.startsWith(`${required.module}.${required.action}.`);
}

function checkPackageScripts() {
  const pkg = readJson("package.json");
  const requiredScripts = [
    "backup:files",
    "brand:check",
    "build",
    "candidate:commercial",
    "ci:commercial",
    "configure:cloudflare",
    "contract:api",
    "db:deploy",
    "db:generate",
    "db:seed",
    "dev",
    "dev:commercial",
    "dev:server",
    "drill:commercial",
    "drill:local-recovery",
    "doctor:cloudflare",
    "doctor:commercial",
    "evidence:commercial",
    "gap:report",
    "prepare:production-env",
    "audit:readiness",
    "backup:postgres",
    "dossier:commercial",
    "prune:backups",
    "release:gate",
    "restore:postgres",
    "restore:files",
    "sbom:generate",
    "signoff:drafts",
    "smoke:commercial",
    "test:e2e",
    "test:server",
    "validate:file-backup",
    "validate:cloudflare-backend",
    "validate:hr-signoff",
    "validate:production-env",
    "validate:secrets-signoff",
    "validate:storage-signoff",
    "validate:drill-evidence",
    "validate:local-recovery-drill",
    "validate:migrations",
    "validate:supply-chain",
    "migrations:lock",
    "postgres:local",
    "prepare:release-inputs",
    "prepare:hr-review",
    "verify"
  ];
  requiredScripts.forEach((scriptName) => {
    assert(pkg.scripts?.[scriptName], `package.json missing script: ${scriptName}`);
  });
  assertIncludes(pkg.scripts.verify, "npm run brand:check", "package.json verify script");
  assertIncludes(pkg.scripts.verify, "npm run validate:migrations", "package.json verify script");
  assertIncludes(pkg.scripts.verify, "npm run validate:supply-chain", "package.json verify script");
  assertIncludes(pkg.scripts.verify, "npm run sbom:generate -- --check --json", "package.json verify script");
  assertIncludes(pkg.scripts["backup:postgres"], "scripts/backup-postgres.sh", "package.json backup:postgres script");
  assertIncludes(pkg.scripts["restore:postgres"], "scripts/restore-postgres.sh", "package.json restore:postgres script");
}

function checkDeploymentArtifacts() {
  [
    ".env.example",
    ".env.production.example",
    ".dockerignore",
    ".github/workflows/commercial-ci.yml",
    ".github/workflows/commercial-drill.yml",
    ".github/workflows/commercial-signoff.yml",
    "Dockerfile.api",
    "Dockerfile.web",
    "docs/API_CONTRACT.md",
    "docs/file-storage-signoff.example.json",
    "docs/KNOWN_GAPS.md",
    "docs/hr-data-signoff.example.json",
    "docs/openapi.json",
    "docs/production-secrets-signoff.example.json",
    "docker-compose.yml",
    "docker-compose.prod.yml",
    "docker/nginx.conf",
    "scripts/backup-files.sh",
    "scripts/backup-postgres.sh",
    "scripts/brand-check.mjs",
    "scripts/ci-commercial.sh",
    "scripts/commercial-drill.sh",
    "scripts/commercial-doctor-core.mjs",
    "scripts/commercial-doctor.mjs",
    "scripts/commercial-evidence.mjs",
    "scripts/commercial-gap-report.mjs",
    "scripts/commercial-readiness-audit.mjs",
    "scripts/commercial-release-candidate.mjs",
    "scripts/commercial-release-dossier.mjs",
    "scripts/commercial-release-gate.mjs",
    "scripts/commercial-smoke.mjs",
    "scripts/configure-cloudflare-secrets.mjs",
    "scripts/dev-commercial-core.mjs",
    "scripts/dev-commercial.mjs",
    "scripts/docker-api-entrypoint.sh",
    "scripts/export-openapi.mjs",
    "scripts/generate-sbom.mjs",
    "scripts/generate-signoff-drafts.mjs",
    "scripts/local-postgres.mjs",
    "scripts/materialize-release-inputs.mjs",
    "scripts/prepare-hr-data-review.mjs",
    "scripts/prune-backups.sh",
    "scripts/prepare-production-env.mjs",
    "scripts/restore-files.sh",
    "scripts/restore-postgres.sh",
    "scripts/seed-safety.mjs",
    "scripts/validate-file-backup.mjs",
    "scripts/validate-hr-signoff.mjs",
    "scripts/validate-migrations.mjs",
    "scripts/validate-production-env.mjs",
    "scripts/validate-secrets-signoff.mjs",
    "scripts/validate-storage-signoff.mjs",
    "scripts/validate-drill-evidence.mjs",
    "scripts/validate-local-recovery-drill.mjs",
    "scripts/validate-supply-chain.mjs",
    "prisma/migrations/migration-lock.json",
    "server/src/modules/audit/audit-integrity.mjs",
    "server/tests/audit-integrity.test.mjs",
    "server/tests/cloudflare-secrets.test.mjs",
    "server/tests/commercial-script-security.test.mjs",
    "server/tests/local-postgres.test.mjs",
    "server/tests/materialize-release-inputs.test.mjs",
    "server/tests/migration-lock.test.mjs",
    "server/tests/sbom.test.mjs",
    "server/tests/supply-chain.test.mjs"
  ].forEach(assertFile);

  const compose = readText("docker-compose.yml");
  assertIncludes(compose, "postgres:", "docker-compose.yml");
  assertIncludes(compose, "api:", "docker-compose.yml");
  assertIncludes(compose, "web:", "docker-compose.yml");
  assertIncludes(compose, "VITE_REQUIRE_API: \"1\"", "docker-compose.yml");
  assertIncludes(compose, "VITE_DEMO_FALLBACK: \"0\"", "docker-compose.yml");
  assertIncludes(compose, "/ready", "docker-compose.yml");
  assertIncludes(compose, "postgres-data:", "docker-compose.yml");
  assertIncludes(compose, "file-storage:", "docker-compose.yml");
  assertIncludes(compose, "AUTH_FAILED_LOGIN_MAX_KEYS", "docker-compose.yml");
  assertIncludes(compose, "FILE_STORAGE_DRIVER", "docker-compose.yml");
  assertIncludes(compose, "FILE_STORAGE_DIR", "docker-compose.yml");
  assertIncludes(compose, "OBJECT_STORAGE_ENDPOINT", "docker-compose.yml");
  assertIncludes(compose, "OBJECT_STORAGE_SECRET_ACCESS_KEY", "docker-compose.yml");
  assertIncludes(compose, "IMPORT_MAX_HTML_BYTES", "docker-compose.yml");
  assertIncludes(compose, "API_BODY_LIMIT_BYTES", "docker-compose.yml");

  const productionCompose = readText("docker-compose.prod.yml");
  [
    "APP_ENV: production",
    "NODE_ENV: production",
    "${JWT_SECRET:?JWT_SECRET is required}",
    "${WEB_ORIGIN:?WEB_ORIGIN is required}",
    "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required}",
    "AUTH_FAILED_LOGIN_MAX_KEYS: ${AUTH_FAILED_LOGIN_MAX_KEYS:-10000}",
    "TRUST_PROXY: ${TRUST_PROXY:-0}",
    "RUN_DB_SEED: ${RUN_DB_SEED:-0}",
    "ALLOW_PRODUCTION_SEED: ${ALLOW_PRODUCTION_SEED:-0}",
    "VITE_REQUIRE_API: \"1\"",
    "VITE_DEMO_FALLBACK: \"0\"",
    "FILE_STORAGE_DRIVER: ${FILE_STORAGE_DRIVER:-local}",
    "FILE_STORAGE_DIR: ${FILE_STORAGE_DIR:?FILE_STORAGE_DIR is required}",
    "OBJECT_STORAGE_ENDPOINT: ${OBJECT_STORAGE_ENDPOINT:-}",
    "OBJECT_STORAGE_SECRET_ACCESS_KEY: ${OBJECT_STORAGE_SECRET_ACCESS_KEY:-}",
    "file-storage:${FILE_STORAGE_DIR:?FILE_STORAGE_DIR is required}"
  ].forEach((needle) => assertIncludes(productionCompose, needle, "docker-compose.prod.yml"));
  [
    "- \"5432:5432\"",
    "oa_dev_password",
    "admin123456",
    "replace-with-a-long-random-secret-before-deployment"
  ].forEach((needle) => assertNotIncludes(productionCompose, needle, "docker-compose.prod.yml"));

  const webDockerfile = readText("Dockerfile.web");
  [
    "ARG VITE_REQUIRE_API=1",
    "ARG VITE_DEMO_FALLBACK=0",
    "ENV VITE_REQUIRE_API=${VITE_REQUIRE_API}",
    "ENV VITE_DEMO_FALLBACK=${VITE_DEMO_FALLBACK}",
    "RUN npm run build"
  ].forEach((needle) => assertIncludes(webDockerfile, needle, "Dockerfile.web"));

  const nginxConfig = readText("docker/nginx.conf");
  [
    "client_max_body_size 11m;",
    "proxy_pass http://api:8787/api/;",
    "X-Forwarded-For"
  ].forEach((needle) => assertIncludes(nginxConfig, needle, "docker/nginx.conf"));

  const env = readText(".env.example");
  [
    "APP_ENV=",
    "AUTH_FAILED_LOGIN_LIMIT=",
    "AUTH_FAILED_LOGIN_WINDOW_MS=",
    "AUTH_FAILED_LOGIN_MAX_KEYS=",
    "API_BODY_LIMIT_BYTES=",
    "DATABASE_URL=",
	    "FILE_BACKUP_DIR=",
	    "BACKUP_DIR=",
	    "FILE_BACKUP_USE_LOCAL=",
    "FILE_MAX_UPLOAD_BYTES=",
    "IMPORT_MAX_HTML_BYTES=",
    "FILE_STORAGE_DRIVER=",
    "FILE_STORAGE_DIR=",
    "OBJECT_STORAGE_ENDPOINT=",
    "OBJECT_STORAGE_SECRET_ACCESS_KEY=",
    "JWT_SECRET=",
    "COOKIE_MAX_AGE_SECONDS=",
    "WEB_ORIGIN=",
    "TRUST_PROXY=",
    "DEFAULT_ADMIN_EMAIL=",
    "DEFAULT_ADMIN_PASSWORD=",
    "POSTGRES_DB=",
    "POSTGRES_USER=",
    "POSTGRES_PASSWORD=",
    "PRUNE_DATABASE_KEEP=",
    "PRUNE_FILE_KEEP=",
    "VITE_DEMO_FALLBACK=",
    "VITE_REQUIRE_API="
  ].forEach((key) => assertIncludes(env, key, ".env.example"));
  [
    "WEB_ORIGIN=\"http://127.0.0.1:8080,http://localhost:8080",
    "TRUST_PROXY=\"0\"",
    "VITE_REQUIRE_API=\"1\"",
    "VITE_DEMO_FALLBACK=\"0\"",
    "JWT_SECRET=\"local-commercial-demo-secret-change-before-production"
  ].forEach((needle) => assertIncludes(env, needle, ".env.example"));
  [
    "JWT_SECRET=\"replace-with-a-long-random-secret-before-deployment\"",
    "VITE_REQUIRE_API=\"0\"",
    "WEB_ORIGIN=\"http://127.0.0.1:5173,http://127.0.0.1:5174\""
  ].forEach((needle) => assertNotIncludes(env, needle, ".env.example"));

  const productionEnv = readText(".env.production.example");
  [
    "APP_ENV=production",
    "NODE_ENV=production",
    "POSTGRES_PASSWORD=",
    "JWT_SECRET=",
    "AUTH_FAILED_LOGIN_MAX_KEYS=10000",
	    "FILE_STORAGE_DRIVER=local",
	    "FILE_STORAGE_DIR=/app/storage/files",
	    "BACKUP_DIR=/backups/postgres",
	    "FILE_BACKUP_DIR=/backups/files",
    "OBJECT_STORAGE_ENDPOINT=",
    "OBJECT_STORAGE_SECRET_ACCESS_KEY=",
    "WEB_ORIGIN=https://oa.example.com",
    "TRUST_PROXY=0",
    "RUN_DB_SEED=0",
    "ALLOW_PRODUCTION_SEED=0",
    "VITE_REQUIRE_API=1",
    "VITE_DEMO_FALLBACK=0"
  ].forEach((needle) => assertIncludes(productionEnv, needle, ".env.production.example"));
  [
    "oa_dev_password",
    "admin123456",
    "local-commercial-demo-secret",
    "replace-with-a-long-random-secret-before-deployment",
    "RUN_DB_SEED=1",
    "VITE_DEMO_FALLBACK=1"
  ].forEach((needle) => assertNotIncludes(productionEnv, needle, ".env.production.example"));

  const dockerIgnore = readText(".dockerignore");
  [
    ".local-postgres",
    ".env.*",
    "!.env.example",
    "!.env.production.example"
  ].forEach((needle) => assertIncludes(dockerIgnore, needle, ".dockerignore"));

  const ciScript = readText("scripts/ci-commercial.sh");
  [
    "DATABASE_URL is required for commercial CI",
    "npm run validate:migrations",
    "npm run validate:supply-chain",
    "npm run sbom:generate -- --check --json",
    "npm run brand:check",
    "npm run contract:api",
    "npm run db:deploy",
    "npm run db:seed",
    "NODE_ENV=production npm run build",
    "node server/src/index.mjs",
    "${API_BASE_URL}/ready",
    "npm run smoke:commercial",
    "RUN_E2E",
    "npm run test:e2e -- --project=chromium",
    "AUTH_FAILED_LOGIN_MAX_KEYS",
    "VITE_API_PROXY_TARGET",
    "COMMERCIAL_EVIDENCE_DIR",
    "COMMERCIAL_SMOKE_EVIDENCE_FILE",
    "commercial-smoke.json",
    "ready.json",
    "umask 077",
    "chmod 700 \"${COMMERCIAL_EVIDENCE_DIR}\"",
    "chmod 600 \"${API_LOG}\"",
    "chmod 600 \"${COMMERCIAL_EVIDENCE_DIR}/ready.json\""
  ].forEach((needle) => assertIncludes(ciScript, needle, "scripts/ci-commercial.sh"));

  const drillWorkflow = readText(".github/workflows/commercial-drill.yml");
  [
    "name: commercial-drill",
    "workflow_dispatch:",
    "FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: \"true\"",
    "runs-on: ubuntu-latest",
    "cp .env.example .env",
    "FILE_STORAGE_DIR=\"/app/storage/files\"",
    "FILE_BACKUP_USE_LOCAL=\"0\"",
    "npm run drill:commercial",
    "npm run validate:drill-evidence -- commercial-evidence/latest-drill-summary.json --json",
    "npm run evidence:commercial -- --full",
    "docker compose down -v --remove-orphans",
    "actions/checkout@v6",
    "actions/setup-node@v6",
    "actions/upload-artifact@v7",
    "commercial-drill-evidence"
  ].forEach((needle) => assertIncludes(drillWorkflow, needle, ".github/workflows/commercial-drill.yml"));

  const signoffWorkflow = readText(".github/workflows/commercial-signoff.yml");
  [
    "name: commercial-signoff",
    "workflow_dispatch:",
    "FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: \"true\"",
    "environment: ${{ inputs.target_environment }}",
    "PRODUCTION_ENV_B64: ${{ secrets.PRODUCTION_ENV_B64 }}",
    "PRODUCTION_SECRETS_SIGNOFF_B64: ${{ secrets.PRODUCTION_SECRETS_SIGNOFF_B64 }}",
    "HR_DATA_SIGNOFF_B64: ${{ secrets.HR_DATA_SIGNOFF_B64 }}",
    "FILE_STORAGE_SIGNOFF_B64: ${{ secrets.FILE_STORAGE_SIGNOFF_B64 }}",
    "umask 077",
    "npm run prepare:release-inputs -- --json --output reports/commercial-evidence/signoff-validation/release-inputs.json",
    "npm run validate:production-env -- .env.production --json",
    "npm run validate:cloudflare-backend -- --env .env.production --json",
    "npm run validate:secrets-signoff -- docs/production-secrets-signoff.json --env .env.production --json",
    "npm run validate:hr-signoff -- docs/hr-data-signoff.json --source oa-dashboard.html --json",
    "npm run validate:storage-signoff -- \"${args[@]}\"",
    "actions/checkout@v6",
    "actions/setup-node@v6",
    "actions/upload-artifact@v7",
    "commercial-signoff-validation"
  ].forEach((needle) => assertIncludes(signoffWorkflow, needle, ".github/workflows/commercial-signoff.yml"));
  assert(
    countMatches(signoffWorkflow, /umask 077/g) === 6,
    ".github/workflows/commercial-signoff.yml must set private umask before each release-input and validator output"
  );
  assert(
    countMatches(signoffWorkflow, /set -euo pipefail/g) === 6,
    ".github/workflows/commercial-signoff.yml must fail closed for each release-input and validator step"
  );
  assertNotIncludes(signoffWorkflow, "path: .env.production", ".github/workflows/commercial-signoff.yml");

  const materializeReleaseInputs = readText("scripts/materialize-release-inputs.mjs");
  [
    "PRODUCTION_ENV_B64",
    "PRODUCTION_SECRETS_SIGNOFF_B64",
    "HR_DATA_SIGNOFF_B64",
    "FILE_STORAGE_SIGNOFF_B64",
    "0o600",
    "0o700",
    "parseDotenv",
    "decodedInputs",
    "writeMaterializeReleaseInputsResult",
    "outputPath",
    "does not round-trip cleanly as UTF-8",
    "invalid characters or padding",
    "Release input target path escapes project root"
  ].forEach((needle) => assertIncludes(materializeReleaseInputs, needle, "scripts/materialize-release-inputs.mjs"));

  const scriptSecurityTests = readText("server/tests/commercial-script-security.test.mjs");
  [
    "commercial CI evidence artifacts are private by default",
    "commercial drill evidence artifacts are private by default",
    "commercial drill workflow runs Docker drill and uploads evidence",
    "commercial signoff workflow materializes release inputs without uploading secrets",
    "commercial GitHub workflows use Node 24 action runtime",
    "umask 077",
    "chmod 600",
    "chmod 700"
  ].forEach((needle) => assertIncludes(scriptSecurityTests, needle, "server/tests/commercial-script-security.test.mjs"));

  const cloudflareSecretConfig = readText("scripts/configure-cloudflare-secrets.mjs");
  [
    "parseCloudflareSecretArgs",
    "buildCloudflareSecretPlan",
    "applyCloudflareSecretPlan",
    "validateCloudflareBackendEnv",
    "\"gh\", [\"secret\", \"set\"",
    "input: value",
    "secretValues"
  ].forEach((needle) => assertIncludes(cloudflareSecretConfig, needle, "scripts/configure-cloudflare-secrets.mjs"));

  const cloudflareSecretTests = readText("server/tests/cloudflare-secrets.test.mjs");
  [
    "cloudflare secret plan validates backend values and redacts secret material",
    "cloudflare secret apply writes GitHub secrets through stdin",
    "cloudflare secret plan rejects unsafe production configuration",
    "CLOUDFLARE_ACCOUNT_ID",
    "CLOUDFLARE_API_TOKEN"
  ].forEach((needle) => assertIncludes(cloudflareSecretTests, needle, "server/tests/cloudflare-secrets.test.mjs"));

  const cloudflareDeploymentStatus = readText("scripts/cloudflare-deployment-status.mjs");
  [
    "parseCloudflareDeploymentStatusArgs",
    "buildCloudflareDeploymentStatus",
    "runCloudflareDeploymentStatus",
    "requiredCloudflareGithubSecrets",
    "runCloudflareSmoke",
    "github-secrets",
    "tunnel-status",
    "cloudflare-smoke",
    "CLOUDFLARE_API_TOKEN",
    "API_ORIGIN"
  ].forEach((needle) => assertIncludes(cloudflareDeploymentStatus, needle, "scripts/cloudflare-deployment-status.mjs"));

  const cloudflareDeploymentStatusTests = readText("server/tests/cloudflare-deployment-status.test.mjs");
  [
    "cloudflare deployment status parser supports repo tunnel url and json flags",
    "cloudflare deployment status passes only when secrets tunnel and smoke are ready",
    "cloudflare deployment status reports current partial backend configuration blockers",
    "cloudflare deployment status reads GitHub secret names without values",
    "cloudflare deployment status parses wrangler tunnel info output"
  ].forEach((needle) => assertIncludes(cloudflareDeploymentStatusTests, needle, "server/tests/cloudflare-deployment-status.test.mjs"));

  const materializeReleaseInputsTests = readText("server/tests/materialize-release-inputs.test.mjs");
  [
    "release input materializer writes only approved private files",
    "release input materializer writes private validation manifest",
    "release input materializer CLI writes private output without shell redirection",
    "release input materializer rejects missing and malformed release secrets",
    "release input materializer does not write partial files when validation fails",
    "release input materializer accepts unpadded base64 but rejects invalid utf8",
    "release input materializer parser supports json flag"
  ].forEach((needle) => assertIncludes(materializeReleaseInputsTests, needle, "server/tests/materialize-release-inputs.test.mjs"));

  const supplyChain = readText("scripts/validate-supply-chain.mjs");
  [
    "validatePackageLockData",
    "lockfileVersion >= 3",
    "https://registry.npmjs.org/",
    "missing integrity",
    "unapproved license",
    "allowedLicenses"
  ].forEach((needle) => assertIncludes(supplyChain, needle, "scripts/validate-supply-chain.mjs"));

  const supplyChainTests = readText("server/tests/supply-chain.test.mjs");
  [
    "supply-chain validator accepts locked registry packages with approved licenses",
    "supply-chain validator rejects missing integrity non-registry sources and unapproved licenses",
    "supply-chain validator rejects declared dependencies missing from lock root",
    "supply-chain CLI parser reads custom paths and JSON flag"
  ].forEach((needle) => assertIncludes(supplyChainTests, needle, "server/tests/supply-chain.test.mjs"));

  const migrations = readText("scripts/validate-migrations.mjs");
  [
    "validateMigrationLockData",
    "migration-lock.json",
    "checksum changed",
    "migration lock count",
    "strict chronological order",
    "stableSha256"
  ].forEach((needle) => assertIncludes(migrations, needle, "scripts/validate-migrations.mjs"));

  const migrationLock = readText("prisma/migrations/migration-lock.json");
  [
    "\"schemaVersion\": 1",
    "\"migrations\"",
    "\"sha256\"",
    "\"statementCount\""
  ].forEach((needle) => assertIncludes(migrationLock, needle, "prisma/migrations/migration-lock.json"));

  const migrationTests = readText("server/tests/migration-lock.test.mjs");
  [
    "migration lock builder records ordered migration checksums and stable summary",
    "migration lock validator accepts matching locked migrations",
    "migration lock validator rejects checksum drift missing and extra migrations",
    "migration lock CLI writes and validates a migration lock file",
    "migration lock CLI parser supports custom paths and write mode"
  ].forEach((needle) => assertIncludes(migrationTests, needle, "server/tests/migration-lock.test.mjs"));

  const sbom = readText("scripts/generate-sbom.mjs");
  [
    "generateSpdxSbomData",
    "SPDX-2.3",
    "PACKAGE-MANAGER",
    "pkg:npm/",
    "stableSha256",
    "documentSha256",
    "latest-spdx.json",
    "writePrivateJson"
  ].forEach((needle) => assertIncludes(sbom, needle, "scripts/generate-sbom.mjs"));

  const sbomTests = readText("server/tests/sbom.test.mjs");
  [
    "SBOM generator creates SPDX 2.3 packages relationships checksums and purl refs",
    "SBOM summary keeps a stable source hash across generation timestamps",
    "SBOM CLI parser supports custom paths check mode and JSON output",
    "SBOM CLI writes private SPDX output by default"
  ].forEach((needle) => assertIncludes(sbomTests, needle, "server/tests/sbom.test.mjs"));

  const ciWorkflow = readText(".github/workflows/commercial-ci.yml");
  [
    "name: commercial-ci",
    "FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: \"true\"",
    "postgres:16-alpine",
    "oa_ci_password",
    "DATABASE_URL: postgresql://oa:oa_ci_password@127.0.0.1:5432/oa_commercial?schema=public",
    "node-version: 22",
    "npm ci",
    "npx playwright install --with-deps chromium",
    "npm run ci:commercial",
    "VITE_REQUIRE_API: \"1\"",
    "VITE_DEMO_FALLBACK: \"0\"",
    "actions/checkout@v6",
    "actions/setup-node@v6",
    "actions/upload-artifact@v7",
    "if: always()",
    "commercial-ci-artifacts",
    "commercial-evidence"
  ].forEach((needle) => assertIncludes(ciWorkflow, needle, ".github/workflows/commercial-ci.yml"));

  const doctor = readText("scripts/commercial-doctor.mjs");
  [
    "dotenv/config",
    "buildCommercialDoctorReport",
    "parseDotenvText",
    "printCommercialDoctorHuman",
    "selectDoctorPorts",
    "selectPostgresTarget",
    "checkAppendOnlyTriggers",
    "readCommercialDevManifest",
    "readLocalPostgresEnv",
    ".local-postgres/.env.local-postgres",
    "COMMERCIAL_DEV_MANIFEST",
    "resolvePostgresBinaries",
    "commercial-dev-stack",
    "apiHealth",
    "webHealth",
    "databaseIntegrity"
  ].forEach((needle) => assertIncludes(doctor, needle, "scripts/commercial-doctor.mjs"));

  const doctorCore = readText("scripts/commercial-doctor-core.mjs");
  [
    "buildCommercialDoctorReport",
    "buildReadinessSummary",
    "parseDotenvText",
    "selectDoctorPorts",
    "selectPostgresTarget",
    "parsePostgresTargetFromEnv",
    "DATABASE_URL",
    "POSTGRES_HOST",
    "canRunDockerDrill",
    "canReachPostgres",
    "canVerifyDatabaseIntegrity",
    "database-append-only-triggers",
    "commercial-dev-manifest",
    "portSource",
    "devManifest",
    "PostgreSQL TCP",
    "Database integrity",
    "postgresTarget",
    "local-postgres-bootstrap",
    "nextSteps",
    "Vite is listening",
    "no OA API listener",
    "Port 127.0.0.1:${apiPort} is not the OA API",
    "Vite /api proxy does not reach the OA API"
  ].forEach((needle) => assertIncludes(doctorCore, needle, "scripts/commercial-doctor-core.mjs"));

  const doctorTests = readText("server/tests/commercial-doctor.test.mjs");
  [
    "commercial doctor warns when Vite is running but the OA API is absent",
    "commercial doctor fails when the API port is occupied by another service",
    "commercial doctor passes API and Vite proxy checks when both report the OA API service",
    "commercial doctor selects fresh commercial dev manifest ports when env ports are unset",
    "commercial doctor selects fresh commercial dev manifest PostgreSQL target when env database is unset",
    "commercial doctor falls back to project-local PostgreSQL env when no running dev manifest exists",
    "commercial doctor ignores stale dev manifest when explicit env ports are provided",
    "commercial doctor reports DATABASE_URL PostgreSQL target readiness",
    "commercial doctor fails when live database append-only triggers are missing",
    "commercial doctor surfaces Docker-free local PostgreSQL bootstrap guidance",
    "commercial dev blocked manifest is actionable and contains no database secret",
    "commercial dev manifests redact local project and home paths",
    "commercial dev manifest writer uses private mode and redacts path and database password text",
    "commercial doctor reports Docker as the hard drill blocker"
  ].forEach((needle) => assertIncludes(doctorTests, needle, "server/tests/commercial-doctor.test.mjs"));

  const devCommercialCore = readText("scripts/dev-commercial-core.mjs");
  [
    "buildCommercialDevBlockedManifest",
    "buildCommercialDevRunningManifest",
    "commercialDevPostgresNextSteps",
    "redactCommercialDevPath",
    "writeCommercialDevManifest",
    "chmodSync",
    "[PROJECT_ROOT]",
    "status: \"blocked\"",
    "status: \"running\"",
    "postgresTarget",
    "postgres-tcp",
    "docker compose up -d postgres",
    "npm run postgres:local -- start",
    "npm run doctor:commercial -- --json"
  ].forEach((needle) => assertIncludes(devCommercialCore, needle, "scripts/dev-commercial-core.mjs"));

  const devCommercial = readText("scripts/dev-commercial.mjs");
  [
    "dotenv/config",
    "COMMERCIAL_DEV_MANIFEST",
    "reports/commercial-evidence/dev-stack.json",
    "buildCommercialDevBlockedManifest",
    "buildCommercialDevRunningManifest",
    "postgresTarget",
    "writeCommercialDevManifest",
    "SKIP_COMMERCIAL_DEV_PREFLIGHT",
    "PostgreSQL target",
    "Doctor manifest",
    "doctor will auto-detect these ports"
  ].forEach((needle) => assertIncludes(devCommercial, needle, "scripts/dev-commercial.mjs"));

  const appRoutes = readText("server/src/app.mjs");
  [
    "openApiDocument",
    "app.get(\"/api/openapi.json\""
  ].forEach((needle) => assertIncludes(appRoutes, needle, "server/src/app.mjs"));

  const workflowRoutes = readText("server/src/modules/workflow/workflow-routes.mjs");
  [
    "requirePermission",
    "module: \"workflow\"",
    "action: \"read\"",
    "/api/workflows/definitions"
  ].forEach((needle) => assertIncludes(workflowRoutes, needle, "server/src/modules/workflow/workflow-routes.mjs"));

  const openApiSource = readText("server/src/openapi.mjs");
  [
    "openapi: \"3.1.0\"",
    "集团人事行政 OA Commercial API",
    "ExportRequest",
    "required: [\"businessReason\"]",
    "\"/auth/change-password\"",
    "\"/resources/bookings/{id}/cancel\"",
    "bookingDate",
    "resourceName",
    "\"/iam/users\"",
    "\"/iam/users/{id}/password\"",
    "\"/iam/users/{id}/status\"",
    "\"/approvals/{id}/decision\"",
    "\"/attendance/records/export\"",
    "\"/finance/requests/export\"",
    "\"/resources/bookings/export\"",
    "\"/analytics/export\"",
    "\"/audit/integrity\"",
    "AuditIntegrityResponse",
    "auditIntegrityLimitParam",
    "\"/audit/export\"",
    "bearerAuth",
    "sessionCookie"
  ].forEach((needle) => assertIncludes(openApiSource, needle, "server/src/openapi.mjs"));

  const openApiDocs = readText("docs/openapi.json");
  [
    "\"openapi\": \"3.1.0\"",
    "\"ExportRequest\"",
    "\"businessReason\"",
    "\"/auth/change-password\"",
    "\"/imports/dashboard-html\"",
    "\"/iam/users\"",
    "\"/iam/users/{id}/password\"",
    "\"/iam/users/{id}/status\"",
    "\"/attendance/records/export\"",
    "\"/finance/requests/export\"",
    "\"/resources/bookings/export\"",
    "\"/analytics/export\"",
    "\"/audit/integrity\"",
    "\"AuditIntegrityResponse\"",
    "\"lastHash\"",
    "\"maximum\": 5000",
    "\"/files/{id}/download\"",
    "\"ResourceBooking\"",
    "\"bookingDate\"",
    "\"resourceName\""
  ].forEach((needle) => assertIncludes(openApiDocs, needle, "docs/openapi.json"));

  const openApiExporter = readText("scripts/export-openapi.mjs");
  [
    "--check",
    "--write",
    "docs/openapi.json is not in sync"
  ].forEach((needle) => assertIncludes(openApiExporter, needle, "scripts/export-openapi.mjs"));

  const openApiTests = readText("server/tests/app.test.mjs");
  [
    "openapi contract is public and covers commercial modules",
    "/api/openapi.json",
    "OpenAPI path missing",
    "AuditIntegrityResponse",
    "maximum, 5000"
  ].forEach((needle) => assertIncludes(openApiTests, needle, "server/tests/app.test.mjs"));

  const apiPolicy = readText("src/config/apiPolicy.mjs");
  [
    "VITE_REQUIRE_API",
    "VITE_DEMO_FALLBACK",
    "api_required",
    "allowDemoFallback"
  ].forEach((needle) => assertIncludes(apiPolicy, needle, "src/config/apiPolicy.mjs"));

  const apiFallbackPolicy = readText("src/services/apiFallbackPolicy.mjs");
  [
    "canFallbackToLocalAction",
    "NETWORK_ERROR",
    "API_TIMEOUT",
    "status === 0",
    "policy.requireApi",
    "source: \"api\""
  ].forEach((needle) => assertIncludes(apiFallbackPolicy, needle, "src/services/apiFallbackPolicy.mjs"));

  const authRoutes = readText("server/src/modules/auth/auth-routes.mjs");
  [
    "auth.login_failed",
    "auth.login_blocked",
    "authCookieOptions",
    "cookieMaxAgeSeconds",
    "maxAge:",
    "sameSite: \"lax\"",
    "secure: config.isProduction",
    "too_many_login_attempts",
    "Retry-After",
    "COOKIE_MAX_AGE_SECONDS",
    "AUTH_FAILED_LOGIN_LIMIT",
    "AUTH_FAILED_LOGIN_MAX_KEYS",
    "authFailedLoginMaxKeys",
    "pruneExpiredLoginFailures",
    "authenticatedUserWhere",
    "where: authenticatedUserWhere(request)"
  ].forEach((needle) => assertIncludes(authRoutes + readText("server/src/lib/env.mjs"), needle, "server auth runtime"));

  const appRuntime = readText("server/src/app.mjs");
  const readinessRuntime = readText("server/src/modules/system/runtime-readiness.mjs");
  [
    "bodyLimit: config.apiBodyLimitBytes",
    "X-Request-Id",
    "X-Content-Type-Options",
    "X-Frame-Options",
    "Referrer-Policy",
    "Permissions-Policy",
    "Cache-Control",
    "Strict-Transport-Security",
    "applyOperationalHeaders",
    "tokenTenantId",
    "findFirst({",
    "tenantId: tokenTenantId"
  ].forEach((needle) => assertIncludes(appRuntime, needle, "server/src/app.mjs"));
  [
    "readinessPayload",
    "checkFileStorageWritable",
    "checkAppendOnlyDatabaseTriggers",
    "fileStorage: \"ok\"",
    "databaseIntegrity: \"ok\"",
    "status.databaseIntegrity = \"unavailable\"",
    "fileStorage = \"unavailable\""
  ].forEach((needle) => assertIncludes(readinessRuntime, needle, "server/src/modules/system/runtime-readiness.mjs"));

  const envRuntime = readText("server/src/lib/env.mjs");
  [
    "API_BODY_LIMIT_BYTES",
    "FILE_MAX_UPLOAD_BYTES must be a positive integer",
    "IMPORT_MAX_HTML_BYTES must be a positive integer",
    "AUTH_FAILED_LOGIN_LIMIT must be a positive integer",
    "AUTH_FAILED_LOGIN_WINDOW_MS must be a positive integer",
    "AUTH_FAILED_LOGIN_MAX_KEYS must be a positive integer",
    "FILE_STORAGE_DRIVER must be local or s3",
    "OBJECT_STORAGE_ENDPOINT must be an HTTP(S) URL",
    "Production FILE_STORAGE_DIR must be explicitly configured",
    "Production FILE_STORAGE_DIR must be an absolute",
    "apiBodyLimitBytes",
    "requiredApiBodyLimitBytes",
    "strictIntFromEnv",
    "fileMaxUploadBytes * 1.5",
    "importMaxHtmlBytes + 64 * 1024"
  ].forEach((needle) => assertIncludes(envRuntime, needle, "server/src/lib/env.mjs"));

  const envTests = readText("server/tests/env.test.mjs");
  [
    "runtime rejects invalid cookie max age",
    "runtime rejects invalid login protection limits",
    "runtime computes API body limit from upload and import limits",
    "runtime rejects invalid file upload size limit",
    "runtime rejects invalid import html size limit",
    "production runtime accepts S3 object storage without local volume signoff",
    "S3 object storage driver requires complete object storage config",
    "production runtime requires explicit absolute file storage path",
    "runtime rejects API body limit below upload and import requirements",
    "runtime rejects nonnumeric API body limit from environment"
  ].forEach((needle) => assertIncludes(envTests, needle, "server/tests/env.test.mjs"));

  const appTests = readText("server/tests/app.test.mjs");
  assertIncludes(appTests, "fastify request body limit follows runtime config", "server/tests/app.test.mjs");
  assertIncludes(appTests, "auth rejects signed tokens whose tenant does not match the user record", "server/tests/app.test.mjs");

  const deploymentRunbook = readText("docs/DEPLOYMENT.md");
  [
    "API_BODY_LIMIT_BYTES=10551296",
    "FILE_MAX_UPLOAD_BYTES`, `IMPORT_MAX_HTML_BYTES`, or `API_BODY_LIMIT_BYTES`",
    "nginx `client_max_body_size`",
    "Fastify must not reject valid business requests before route-level validation and audit logging run",
    "docker-compose.prod.yml",
    "POSTGRES_PASSWORD",
    "JWT_SECRET",
    "FILE_STORAGE_DIR=/app/storage/files",
    "FILE_BACKUP_DIR=/backups/files",
    "WEB_ORIGIN",
    "RUN_DB_SEED=0",
    "ALLOW_PRODUCTION_SEED=0",
    "reviewed bootstrap seed is intentionally part of the cutover",
    "The seed script refuses production seeding",
    ".dockerignore` excludes `.env.*`",
    "Commercial CI gate",
    "npm run ci:commercial",
    "Migration integrity validation",
    "validate:migrations",
    "migration-lock.json",
    "validate:supply-chain",
    "sbom:generate",
    "SPDX SBOM",
    "offline supply-chain validation",
    "runs this gate on pull requests and pushes to `main`",
    "Set `RUN_E2E=0` only for a narrow backend-only diagnosis run",
    "COMMERCIAL_EVIDENCE_DIR",
    "COMMERCIAL_SMOKE_EVIDENCE_FILE",
    "drill-summary.json"
  ].forEach((needle) => assertIncludes(deploymentRunbook, needle, "docs/DEPLOYMENT.md"));

  const commercializationPlan = readText("docs/COMMERCIALIZATION_PLAN.md");
  [
    "Request size limits",
    "Fastify and nginx request body limits must be high enough",
    "Production deployment guard",
    "Migration integrity",
    "validate:migrations",
    "migration-lock.json",
    "Supply-chain validation",
    "SBOM generation",
    "validate:supply-chain",
    "sbom:generate",
    "Commercial CI",
    "PostgreSQL-backed commercial CI gate",
    "commercial-evidence",
    "Target Profile classification",
    "drill-summary.json"
  ].forEach((needle) => assertIncludes(commercializationPlan, needle, "docs/COMMERCIALIZATION_PLAN.md"));

  const auditService = readText("server/src/modules/audit/audit-service.mjs");
  [
    "requestId: request.id",
    "input.requestId"
  ].forEach((needle) => assertIncludes(auditService, needle, "server/src/modules/audit/audit-service.mjs"));
}

function checkLocalPostgresBootstrap() {
  const pkg = readJson("package.json");
  assertIncludes(pkg.scripts["postgres:local"], "scripts/local-postgres.mjs", "package.json postgres:local script");

  const localPostgres = readText("scripts/local-postgres.mjs");
  [
    "buildLocalPostgresConfig",
    "resolvePostgresBinaries",
    "renderLocalPostgresEnv",
    "runLocalPostgresCli",
    "LOCAL_POSTGRES_BIN_DIR",
    "postgresql@16",
    "VITE_REQUIRE_API",
    "VITE_DEMO_FALLBACK",
    ".local-postgres",
    "Local development only"
  ].forEach((needle) => assertIncludes(localPostgres, needle, "scripts/local-postgres.mjs"));

  const tests = readText("server/tests/local-postgres.test.mjs");
  [
    "local postgres config builds a project-local PostgreSQL URL without changing provider",
    "local postgres binary resolver accepts explicit binary directory",
    "local postgres check reports actionable missing binary next steps",
    "local postgres write-env creates API-required dotenv without plaintext production claims"
  ].forEach((needle) => assertIncludes(tests, needle, "server/tests/local-postgres.test.mjs"));

  const deployment = readText("docs/DEPLOYMENT.md");
  [
    "Docker-free local PostgreSQL path",
    "npm run postgres:local -- check --json",
    "npm run postgres:local -- start",
    "not production evidence"
  ].forEach((needle) => assertIncludes(deployment, needle, "docs/DEPLOYMENT.md"));

  const plan = readText("docs/COMMERCIALIZATION_PLAN.md");
  [
    "Docker-free local PostgreSQL bootstrap",
    "project-local PostgreSQL data under `.local-postgres/`",
    "does not replace release Docker restore-drill evidence"
  ].forEach((needle) => assertIncludes(plan, needle, "docs/COMMERCIALIZATION_PLAN.md"));
}

function checkKnownGapRegister() {
  const gaps = readText("docs/KNOWN_GAPS.md");
  [
    "# Known Commercial Gaps",
    "Exit Criteria",
    "GAP-001",
    "GAP-002",
    "GAP-003",
    "GAP-004",
    "GAP-005",
    "npm run ci:commercial",
    "npm run drill:commercial",
    "npm run doctor:commercial -- --json",
    "npm run restore:files"
  ].forEach((needle) => assertIncludes(gaps, needle, "docs/KNOWN_GAPS.md"));
  ["TBD", "TODO", "unknown", "待定"].forEach((needle) => assertNotIncludes(gaps, needle, "docs/KNOWN_GAPS.md"));

  const rows = gaps.split("\n").filter((line) => line.startsWith("| GAP-"));
  assert(rows.length >= 5, "docs/KNOWN_GAPS.md must include at least five tracked commercial gaps");
  rows.forEach((line) => {
    const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
    assert(cells.length === 6, "known gap row must have six columns", { line });
    const [id, statusValue, owner, targetDate, gap, exitCriteria] = cells;
    assert(/^GAP-\d{3}$/.test(id), "known gap row must use GAP-### id", { line });
    assert(["Open", "Mitigated", "Closed"].includes(statusValue), "known gap status must be Open, Mitigated, or Closed", { line });
    assert(owner.length >= 6 && !/owner/i.test(owner), "known gap owner must be concrete", { line });
    assert(/^\d{4}-\d{2}-\d{2}$/.test(targetDate) && !Number.isNaN(Date.parse(`${targetDate}T00:00:00Z`)), "known gap target date must be ISO YYYY-MM-DD", { line });
    assert(gap.length >= 30, "known gap description is too thin", { line });
    assert(exitCriteria.length >= 40, "known gap exit criteria must be evidence-based", { line });
  });

  const qaChecklist = readText("docs/QA_ACCEPTANCE_CHECKLIST.md");
  [
    "Known commercial gaps",
    "docs/KNOWN_GAPS.md",
    "preflight check",
    "release evidence review"
  ].forEach((needle) => assertIncludes(qaChecklist, needle, "docs/QA_ACCEPTANCE_CHECKLIST.md"));

  const commercializationPlan = readText("docs/COMMERCIALIZATION_PLAN.md");
  [
    "docs/KNOWN_GAPS.md",
    "owner, target date, and exit criteria"
  ].forEach((needle) => assertIncludes(commercializationPlan, needle, "docs/COMMERCIALIZATION_PLAN.md"));
}

function checkCommercialEvidenceAutomation() {
  const pkg = readJson("package.json");
  assertIncludes(pkg.scripts["evidence:commercial"], "scripts/commercial-evidence.mjs", "package.json evidence:commercial script");
  assertIncludes(pkg.scripts["audit:evidence-permissions"], "scripts/validate-evidence-permissions.mjs", "package.json audit:evidence-permissions script");

  const evidence = readText("scripts/commercial-evidence.mjs");
  [
    "commercialEvidenceChecks",
    "parseKnownGapRegister",
    "collectArtifacts",
    "runCheck",
    "runGapReportCheck",
    "runEvidencePermissionCheck",
    "summarizeEvidence",
    "writeEvidenceReport",
    "writePrivateTextFile",
    "buildEvidenceCliResult",
    "evidenceMode",
    "inferEvidenceMode",
    "ensurePrivateDir",
    "chmodSync",
    "0o700",
    "redactEvidenceText",
    "evidenceSecretValues",
    "databaseUrlSecretValues",
    "COMMERCIAL_EVIDENCE_MAX_BUFFER_BYTES",
    "maxBuffer",
    "spawnError",
    "projectRoot: \"[PROJECT_ROOT]\"",
    "environmentSecrets: \"redacted from command output and parsed JSON\"",
    "reports/commercial-evidence",
    "scripts/commercial-doctor.mjs",
    "scripts/commercial-preflight.mjs",
    "scripts/commercial-gap-report.mjs",
    "scripts/validate-migrations.mjs",
    "scripts/validate-supply-chain.mjs",
    "scripts/commercial-readiness-audit.mjs",
    "scripts/commercial-release-candidate.mjs",
    "scripts/commercial-release-dossier.mjs",
    "scripts/generate-sbom.mjs",
    "scripts/materialize-release-inputs.mjs",
    "scripts/export-openapi.mjs",
    "scripts/prepare-hr-data-review.mjs",
    "scripts/validate-cloudflare-backend.mjs",
    "scripts/validate-evidence-permissions.mjs",
    "prisma/migrations/migration-lock.json",
    "reports/commercial-evidence/hr-data-review/latest-manifest.json",
    "reports/commercial-evidence/sbom/latest-spdx.json",
    "reports/commercial-evidence/production-env-prep/latest-manifest.json",
    "reports/commercial-evidence/signoff-drafts/latest-manifest.json",
    "reports/commercial-evidence/signoff-validation/release-inputs.json",
    "reports/commercial-evidence/signoff-validation/production-env.json",
    "reports/commercial-evidence/signoff-validation/cloudflare-backend.json",
    "reports/commercial-evidence/signoff-validation/secrets-signoff.json",
    "reports/commercial-evidence/signoff-validation/hr-signoff.json",
    "reports/commercial-evidence/signoff-validation/storage-signoff.json",
    "reports/commercial-evidence/latest-gap-report.json",
    "reports/commercial-evidence/latest-gap-report.md",
    ".github/workflows/commercial-ci.yml",
    ".github/workflows/commercial-drill.yml",
    ".github/workflows/commercial-signoff.yml",
    "gap-report",
    "gap:report",
    "evidence-permissions",
    "audit:evidence-permissions",
    "hr-review-prep",
    "prepare:hr-review",
    "migrations",
    "validate:migrations",
    "supply-chain",
    "validate:supply-chain",
    "sbom",
    "sbom:generate",
    "production-env",
    "cloudflare-backend",
    "validate:production-env",
    "validate:cloudflare-backend",
    "validate:secrets-signoff",
    "validate:hr-signoff",
    "validate:storage-signoff",
    "validate:drill-evidence",
    "validate:local-recovery-drill",
    "secrets-signoff",
    "hr-signoff",
    "storage-signoff",
    "drill-evidence",
    "local-recovery-evidence",
    "diagnosticChecks",
    "releaseCandidateReady",
    "releaseBlockers",
    "e2eIncluded",
    "E2E evidence is missing",
    "parseDotenvText",
    "readLocalPostgresEnv",
    "effectiveTargetEnv",
    ".local-postgres/.env.local-postgres",
    "local-postgres-env",
    "commercial-evidence/latest-local-recovery-drill-summary.json"
  ].forEach((needle) => assertIncludes(evidence, needle, "scripts/commercial-evidence.mjs"));

  const evidencePermissions = readText("scripts/validate-evidence-permissions.mjs");
  [
    "auditEvidencePermissions",
    "parseEvidencePermissionArgs",
    "requiredEvidenceFiles",
    "optionalEvidenceFiles",
    "latest-owner-handoff-manifest.json",
    "hr-data-review/latest-manifest.json",
    "production-env-prep/latest-manifest.json",
    "signoff-drafts/latest-manifest.json",
    "0o700",
    "0o600",
    "escapes project root"
  ].forEach((needle) => assertIncludes(evidencePermissions, needle, "scripts/validate-evidence-permissions.mjs"));

  const evidenceTests = readText("server/tests/commercial-evidence.test.mjs");
  [
    "commercial evidence parser reads known gap rows",
    "commercial evidence selects heavy and e2e checks from flags",
    "quickOptions.evidenceMode",
    "commercial evidence summary keeps doctor blockers visible",
    "local-recovery-evidence",
    "diagnosticChecks",
    "commercial evidence target profile reads project-local PostgreSQL env when DATABASE_URL is unset",
    "commercial evidence summary marks release candidate ready only for full production e2e evidence",
    "releaseCandidateReady",
    "releaseBlockers",
    "commercial evidence summary fails when required checks fail",
    "commercial evidence report redacts project paths and environment secrets",
    "commercial evidence report redacts HR review preparation paths",
    "commercial evidence CLI result redacts absolute output path",
    "commercial evidence text redaction masks env assignment secrets",
    "commercial evidence text redaction masks database URL password fragments",
    "commercial evidence runCheck captures large command output without buffer failure",
    "commercial evidence runCheck records spawn errors in archived stderr",
    "commercial evidence post-writes current gap action report",
    "commercial evidence report writer stores timestamped and latest files as private",
    "commercial evidence artifact inventory tracks release automation scripts"
  ].forEach((needle) => assertIncludes(evidenceTests, needle, "server/tests/commercial-evidence.test.mjs"));

  const evidencePermissionTests = readText("server/tests/evidence-permissions.test.mjs");
  [
    "commercial evidence permission audit accepts private latest evidence packages",
    "commercial evidence permission audit rejects group-readable latest files",
    "commercial evidence permission audit rejects manifest paths outside project root",
    "commercial evidence permission parser reads evidence dir and json flags"
  ].forEach((needle) => assertIncludes(evidencePermissionTests, needle, "server/tests/evidence-permissions.test.mjs"));

  const deployment = readText("docs/DEPLOYMENT.md");
  [
    "npm run evidence:commercial",
    "reports/commercial-evidence/latest.json",
    "--strict-readiness",
    "npm run audit:evidence-permissions",
    "evidence-permissions"
  ].forEach((needle) => assertIncludes(deployment, needle, "docs/DEPLOYMENT.md"));

  const qa = readText("docs/QA_ACCEPTANCE_CHECKLIST.md");
  [
    "Commercial evidence package",
    "Migration integrity lock",
    "validate:migrations",
    "Dependency supply chain",
    "SBOM artifact",
    "validate:supply-chain",
    "sbom:generate",
    "reports/commercial-evidence/latest.json",
    "npm run evidence:commercial",
    "Commercial evidence permissions",
    "audit:evidence-permissions"
  ].forEach((needle) => assertIncludes(qa, needle, "docs/QA_ACCEPTANCE_CHECKLIST.md"));

  const plan = readText("docs/COMMERCIALIZATION_PLAN.md");
  [
    "Evidence permission audit",
    "audit:evidence-permissions"
  ].forEach((needle) => assertIncludes(plan, needle, "docs/COMMERCIALIZATION_PLAN.md"));
}

function checkCommercialReleaseGateAutomation() {
  const pkg = readJson("package.json");
  assertIncludes(pkg.scripts["release:gate"], "scripts/commercial-release-gate.mjs", "package.json release:gate script");
  assertIncludes(pkg.scripts["audit:readiness"], "scripts/commercial-readiness-audit.mjs", "package.json audit:readiness script");
  assertIncludes(pkg.scripts["dossier:commercial"], "scripts/commercial-release-dossier.mjs", "package.json dossier:commercial script");
  assertIncludes(pkg.scripts["candidate:commercial"], "scripts/commercial-release-candidate.mjs", "package.json candidate:commercial script");

  const audit = readText("scripts/commercial-readiness-audit.mjs");
  [
    "auditCommercialReadiness",
    "gapClosureRules",
    "GAP-001",
    "GAP-002",
    "GAP-003",
    "GAP-004",
    "GAP-005",
    "cloudflare-backend",
    "canRunDockerDrill",
    "canReachPostgres",
    "canVerifyDatabaseIntegrity",
    "canRunApiSmoke",
    "canRunFrontendApiSmoke",
    "missing from docs/KNOWN_GAPS.md",
    "--allow-missing-e2e"
  ].forEach((needle) => assertIncludes(audit, needle, "scripts/commercial-readiness-audit.mjs"));

  const gate = readText("scripts/commercial-release-gate.mjs");
  [
    "evaluateReleaseGate",
    "loadReleaseEvidence",
    "parseReleaseGateArgs",
    "buildReleaseGateCliPayload",
    "summarizeTargetProfileForCli",
    "auditCommercialReadiness",
    "redactEvidenceText",
    "reports/commercial-evidence/latest.json",
    "missing required release check: ${id}",
    "Release gap remains open",
    "Readiness audit failed",
    "Evidence report is stale",
    "validateTargetProfile",
    "evidenceMode must be full",
    "production-release-evidence",
    "targetProfile.database.isLocal must be false",
    "targetProfile.viteRequireApi must be 1",
    "targetProfile.viteDemoFallback must be 0",
    "--max-evidence-age-hours",
    "defaultMaxEvidenceAgeHours",
    "evidenceAgeHours",
    "Doctor readiness flag is not green",
    "migrations",
    "hr-review-prep",
    "sbom",
    "evidence-permissions",
    "production-env",
    "cloudflare-backend",
    "secrets-signoff",
    "hr-signoff",
    "storage-signoff",
    "drill-evidence",
    "check.diagnostic",
    "canRunDockerDrill",
    "canReachPostgres",
    "canVerifyDatabaseIntegrity",
    "canRunApiSmoke",
    "canRunFrontendApiSmoke",
    "--allow-missing-e2e"
  ].forEach((needle) => assertIncludes(gate, needle, "scripts/commercial-release-gate.mjs"));

  const gateTests = readText("server/tests/commercial-release-gate.test.mjs");
  [
    "commercial release gate passes fully green release evidence",
    "commercial release gate blocks quick or missing evidence mode",
    "commercial release gate blocks missing or failing migration integrity evidence",
    "commercial release gate blocks missing or failing supply-chain evidence",
    "commercial release gate blocks missing or failing SBOM evidence",
    "commercial release gate blocks open gaps doctor blockers and missing e2e",
    "commercial release gate blocks missing or non-production target profile",
    "commercial release gate blocks local database and frontend fallback target profile",
    "commercial release gate blocks missing or failing HR review preparation evidence",
    "commercial release gate blocks missing or failing evidence permission audit",
    "commercial release gate blocks missing or failing production env evidence",
    "commercial release gate blocks missing or failing Cloudflare backend evidence",
    "commercial release gate blocks missing or failing secrets signoff evidence",
    "commercial release gate blocks missing or failing HR signoff evidence",
    "commercial release gate blocks missing or failing storage signoff evidence",
    "commercial release gate blocks missing or failing drill evidence",
    "commercial release gate blocks closed gaps that fail readiness audit",
    "commercial release gate can allow missing e2e for narrow diagnostics only",
    "commercial release gate blocks stale or future-dated evidence",
    "commercial release gate parses evidence path and e2e option",
    "commercial release gate CLI payload redacts local evidence paths",
    "non-local-postgresql"
  ].forEach((needle) => assertIncludes(gateTests, needle, "server/tests/commercial-release-gate.test.mjs"));

  const auditTests = readText("server/tests/commercial-readiness-audit.test.mjs");
  [
    "commercial readiness audit passes fully closed gaps with green evidence",
    "commercial readiness audit blocks open gaps even when evidence is green",
    "commercial readiness audit blocks closed gaps with failing evidence",
    "commercial readiness audit blocks removed gap rows before evidence is green",
    "commercial readiness audit can skip e2e only for diagnostic mode"
  ].forEach((needle) => assertIncludes(auditTests, needle, "server/tests/commercial-readiness-audit.test.mjs"));

  const dossier = readText("scripts/commercial-release-dossier.mjs");
  [
    "buildReleaseDossier",
    "writeReleaseDossier",
    "Commercial Release Dossier",
    "Release status",
    "DIAGNOSTIC_ONLY",
    "Gap Closure Audit",
    "Next Actions",
    "diagnostic dossiers are not release acceptance evidence",
    "latest-dossier.md",
    "release:gate",
    "writePrivateTextFile",
    "ensurePrivateDir",
    "chmodSync",
    "0o700"
  ].forEach((needle) => assertIncludes(dossier, needle, "scripts/commercial-release-dossier.mjs"));

  const dossierTests = readText("server/tests/commercial-release-dossier.test.mjs");
  [
    "commercial release dossier renders blockers next actions and artifact snapshot",
    "commercial release dossier can render an accepted release package",
    "commercial release dossier never accepts diagnostic runs without e2e",
    "commercial release dossier writes timestamped and latest markdown files",
    "commercial release dossier parses evidence output json and diagnostic flags"
  ].forEach((needle) => assertIncludes(dossierTests, needle, "server/tests/commercial-release-dossier.test.mjs"));

  const candidate = readText("scripts/commercial-release-candidate.mjs");
  [
    "releaseCandidateSteps",
    "runCandidateStepCommand",
    "runReleaseCandidate",
    "writeCandidateReport",
    "writePrivateTextFile",
    "redactEvidenceText",
    "COMMERCIAL_RELEASE_CANDIDATE_MAX_BUFFER_BYTES",
    "spawnError",
    "latest-candidate.json",
    "ensurePrivateDir",
    "chmodSync",
    "0o700",
    "--e2e",
    "--strict-readiness",
    "--diagnostic",
    "--allow-missing-e2e",
    "diagnostic mode is not release acceptance evidence"
  ].forEach((needle) => assertIncludes(candidate, needle, "scripts/commercial-release-candidate.mjs"));

  const candidateTests = readText("server/tests/commercial-release-candidate.test.mjs");
  [
    "commercial release candidate default steps require e2e strict readiness and release gate",
    "commercial release candidate diagnostic steps cannot be confused with release evidence",
    "commercial release candidate diagnostic mode always fails closed",
    "commercial release candidate redacts local paths and secrets from archived step output",
    "commercial release candidate step runner captures large command output without buffer failure",
    "commercial release candidate step runner records spawn errors",
    "commercial release candidate writes timestamped and latest reports"
  ].forEach((needle) => assertIncludes(candidateTests, needle, "server/tests/commercial-release-candidate.test.mjs"));

  const deployment = readText("docs/DEPLOYMENT.md");
  [
    "npm run candidate:commercial -- --json",
    "npm run audit:readiness -- reports/commercial-evidence/latest.json --json",
    "npm run dossier:commercial -- reports/commercial-evidence/latest.json --json",
    "npm run release:gate -- reports/commercial-evidence/latest.json --json",
    "requires `evidenceMode=full`, migration integrity evidence, supply-chain evidence, SBOM evidence, evidence permission audit evidence, E2E evidence, HR review preparation evidence, production env evidence, Cloudflare backend evidence, secrets signoff evidence, HR data signoff evidence, File storage signoff evidence, commercial drill evidence, readiness audit, zero open gaps, green doctor readiness, and evidence generated within the accepted evidence freshness window",
    "when the evidence mode is quick/partial/missing",
    "generated within the accepted evidence freshness window",
    "warning check such as `production-env`, `cloudflare-backend`, `secrets-signoff`, `hr-signoff`, `storage-signoff`, `drill-evidence`, or `doctor`",
    "--allow-missing-e2e"
  ].forEach((needle) => assertIncludes(deployment, needle, "docs/DEPLOYMENT.md"));

  const qa = readText("docs/QA_ACCEPTANCE_CHECKLIST.md");
  [
    "Commercial readiness audit",
    "Commercial release candidate",
    "npm run candidate:commercial -- --json",
    "npm run audit:readiness -- reports/commercial-evidence/latest.json --json",
    "Commercial release dossier",
    "npm run dossier:commercial -- reports/commercial-evidence/latest.json --json",
    "Commercial release gate",
    "npm run release:gate -- reports/commercial-evidence/latest.json --json",
    "migration integrity evidence present",
    "evidence permission audit evidence present",
    "production env evidence present",
    "HR review preparation evidence present",
    "secrets signoff evidence present",
    "HR data signoff evidence present",
    "File storage signoff evidence present",
    "commercial drill evidence present",
    "generated within the accepted evidence freshness window",
    "zero Open known gaps"
  ].forEach((needle) => assertIncludes(qa, needle, "docs/QA_ACCEPTANCE_CHECKLIST.md"));
}

function checkCommercialGapReportAutomation() {
  const pkg = readJson("package.json");
  assertIncludes(pkg.scripts["gap:report"], "scripts/commercial-gap-report.mjs", "package.json gap:report script");

  const report = readText("scripts/commercial-gap-report.mjs");
  [
    "buildCommercialGapReport",
    "renderCommercialGapReportMarkdown",
    "renderOwnerHandoffMarkdown",
    "writeCommercialOwnerHandoff",
    "buildOwnerHandoffManifest",
    "sanitizeTargetProfile",
    "targetProfileLines",
    "Target Profile",
    "Evidence Check Failures",
    "writeCommercialGapReport",
    "Commercial Gap Action Report",
    "Commercial Gap Owner Handoff",
    "Owner Actions",
    "gapActionCatalog",
    "npm run validate:production-env -- .env.production --json",
    "npm run restore:files -- <file-storage-backup.tar.gz> --yes",
    "latest-gap-report.json",
    "latest-gap-report.md",
    "latest-owner-handoff-manifest.json",
	    "latest-owner-handoff.md",
	    "writePrivateTextFile",
	    "ensurePrivateDir",
	    "chmodSync",
	    "0o700",
	    "--allow-missing-e2e"
	  ].forEach((needle) => assertIncludes(report, needle, "scripts/commercial-gap-report.mjs"));

  const tests = readText("server/tests/commercial-gap-report.test.mjs");
  [
    "commercial gap report groups release blockers by owner with commands",
    "commercial gap report markdown is an action handoff and redacts local evidence path",
    "targetProfileEvidenceClass",
    "Current Target Profile",
    "commercial gap report writes private timestamped and latest artifacts",
    "latest-owner-handoff-manifest.json",
	    "0o700",
	    "commercial gap report parser reads evidence output json and diagnostic flags"
	  ].forEach((needle) => assertIncludes(tests, needle, "server/tests/commercial-gap-report.test.mjs"));

  const docs = readText("docs/DEPLOYMENT.md")
    + readText("docs/QA_ACCEPTANCE_CHECKLIST.md")
    + readText("docs/COMMERCIALIZATION_PLAN.md");
  [
    "npm run gap:report -- --json",
    "reports/commercial-evidence/latest-gap-report.json",
    "reports/commercial-evidence/latest-owner-handoff-manifest.json",
    "Commercial gap action report",
    "action handoff only"
  ].forEach((needle) => assertIncludes(docs, needle, "commercial gap report docs"));

  const evidence = readText("scripts/commercial-evidence.mjs");
  [
    "scripts/commercial-gap-report.mjs",
    "reports/commercial-evidence/latest-gap-report.json",
    "reports/commercial-evidence/latest-gap-report.md",
    "reports/commercial-evidence/latest-owner-handoff-manifest.json",
    "reports/commercial-evidence/latest-owner-handoff.md"
  ].forEach((needle) => assertIncludes(evidence, needle, "scripts/commercial-evidence.mjs"));
}

function checkProductionEnvValidation() {
  const pkg = readJson("package.json");
  assertIncludes(pkg.scripts["validate:production-env"], "scripts/validate-production-env.mjs", "package.json validate:production-env script");

  const validator = readText("scripts/validate-production-env.mjs");
  [
    "validateProductionEnv",
    "parseProductionEnvText",
    "loadProductionEnvFile",
    "APP_ENV must be production",
    "POSTGRES_PASSWORD must be a non-placeholder secret",
    "JWT_SECRET must be a non-placeholder secret",
    "WEB_ORIGIN must not use example.com",
    "FILE_STORAGE_DRIVER must be local or s3",
    "FILE_STORAGE_DIR must be an absolute path",
    "BACKUP_DIR",
    "FILE_BACKUP_DIR",
    "must be an absolute off-app durable backup path",
    "must not use temporary storage",
    "must not point inside the application container directory",
    "OBJECT_STORAGE_ENDPOINT must use https",
    "OBJECT_STORAGE_SECRET_ACCESS_KEY must be at least 16 characters",
    "VITE_REQUIRE_API must be 1",
    "VITE_DEMO_FALLBACK must be 0",
    "ALLOW_PRODUCTION_SEED=1",
    "API_BODY_LIMIT_BYTES must be at least"
  ].forEach((needle) => assertIncludes(validator, needle, "scripts/validate-production-env.mjs"));

  const validatorTests = readText("server/tests/production-env.test.mjs");
  [
    "production env validator accepts hardened production values",
    "production env validator accepts S3 object storage config",
    "production env validator rejects incomplete S3 object storage config",
    "production env validator rejects template secrets example origins and demo fallback",
    "production env validator rejects app-local durable backup paths",
    "production env validator checks body limit and production seed approval",
    "production env parser reads dotenv syntax"
  ].forEach((needle) => assertIncludes(validatorTests, needle, "server/tests/production-env.test.mjs"));

  const deployment = readText("docs/DEPLOYMENT.md");
  [
    "npm run validate:production-env -- .env.production --json",
    "rejects blank secrets, template domains, local origins, relative local-volume storage, unsafe backup directories, incomplete S3-compatible object storage settings",
    "run before `docker compose -f docker-compose.prod.yml up`"
  ].forEach((needle) => assertIncludes(deployment, needle, "docs/DEPLOYMENT.md"));

  const qa = readText("docs/QA_ACCEPTANCE_CHECKLIST.md");
  [
    "Production env file validation",
    "npm run validate:production-env -- .env.production --json",
    "template secrets, example domains, local origins, relative local-volume paths, unsafe backup directories"
  ].forEach((needle) => assertIncludes(qa, needle, "docs/QA_ACCEPTANCE_CHECKLIST.md"));

  const plan = readText("docs/COMMERCIALIZATION_PLAN.md");
  [
    "Production environment validation",
    "validate:production-env",
    "unsafe backup directories"
  ].forEach((needle) => assertIncludes(plan, needle, "docs/COMMERCIALIZATION_PLAN.md"));
}

function checkProductionEnvPreparation() {
  const pkg = readJson("package.json");
  assertIncludes(pkg.scripts["prepare:production-env"], "scripts/prepare-production-env.mjs", "package.json prepare:production-env script");

  const script = readText("scripts/prepare-production-env.mjs");
  [
    "prepareProductionEnv",
    "production-env-preparation",
    "production-secret-store-checklist",
    ".env.production.template",
    "secret-store-checklist.json",
    "noPlaintextSecretValues",
	    "requiredProductionEnvKeys",
	    "BACKUP_DIR",
		    "validate:production-env",
	    "validate:secrets-signoff",
	    "OBJECT_STORAGE_SECRET_ACCESS_KEY",
	    "writePrivateTextFile",
	    "chmodSync",
	    "0o700",
	    "0o600"
	  ].forEach((needle) => assertIncludes(script, needle, "scripts/prepare-production-env.mjs"));

  const tests = readText("server/tests/production-env-prep.test.mjs");
  [
    "production env prep writes a no-plaintext local storage package",
    "BACKUP_DIR",
	    "production env prep includes object storage managed secret checklist for s3",
	    "production env prep parser reads output env storage driver and json flags",
	    "validateProductionEnv(parseProductionEnvText(envTemplate))",
	    "modeOf",
	    "0o700",
	    "0o600"
	  ].forEach((needle) => assertIncludes(tests, needle, "server/tests/production-env-prep.test.mjs"));

  const docs = readText("docs/DEPLOYMENT.md")
    + readText("docs/QA_ACCEPTANCE_CHECKLIST.md")
    + readText("docs/COMMERCIALIZATION_PLAN.md");
  [
	    "npm run prepare:production-env",
	    "reports/commercial-evidence/production-env-prep",
	    "No plaintext secret values",
	    "private `0700`",
	    "private `0600`",
	    "preparation package only"
	  ].forEach((needle) => assertIncludes(docs, needle, "production env preparation docs"));
}

function checkSecretsSignoffValidation() {
  const pkg = readJson("package.json");
  assertIncludes(pkg.scripts["validate:secrets-signoff"], "scripts/validate-secrets-signoff.mjs", "package.json validate:secrets-signoff script");

  const validator = readText("scripts/validate-secrets-signoff.mjs");
  [
    "validateSecretsSignoff",
    "requiredApprovalRoles",
    "requiredManagedSecrets",
    "parseProductionEnvText",
    "validateProductionEnv",
    "secretStore.injectedAtRuntime must be true",
    "secretStore.noPlaintextInRepo must be true",
    "secretStore.managedSecrets must include",
    "JWT_SECRET",
    "originPolicy.approvedOrigins must match WEB_ORIGIN",
    "production secrets signoff must not contain openExceptions"
  ].forEach((needle) => assertIncludes(validator, needle, "scripts/validate-secrets-signoff.mjs"));

  const example = readText("docs/production-secrets-signoff.example.json");
  [
    "\"schemaVersion\": 1",
    "\"example\": true",
    "\"validatedWith\": \"npm run validate:production-env -- .env.production --json\"",
    "\"managedSecrets\"",
    "\"POSTGRES_PASSWORD\"",
    "\"JWT_SECRET\"",
    "\"injectedAtRuntime\": true",
    "\"noPlaintextInRepo\": true",
    "\"approvedOrigins\"",
    "\"Security owner\"",
    "\"Deployment owner\""
  ].forEach((needle) => assertIncludes(example, needle, "docs/production-secrets-signoff.example.json"));

  const tests = readText("server/tests/secrets-signoff.test.mjs");
  [
    "secrets signoff validator accepts reviewed secret store and origin evidence",
    "secrets signoff validator rejects example release evidence and production exceptions",
    "secrets signoff validator rejects invalid env checksum origin and secret store controls",
    "secrets signoff validator rejects plaintext secret fields and missing seed secret",
    "secrets signoff example validates only when example mode is allowed without env file",
    "secrets signoff CLI parser reads path env and output flags"
  ].forEach((needle) => assertIncludes(tests, needle, "server/tests/secrets-signoff.test.mjs"));

  const docs = readText("docs/KNOWN_GAPS.md")
    + readText("docs/QA_ACCEPTANCE_CHECKLIST.md")
    + readText("docs/DEPLOYMENT.md")
    + readText("docs/COMMERCIALIZATION_PLAN.md");
  [
    "npm run validate:secrets-signoff",
    "docs/production-secrets-signoff.example.json",
    "secrets signoff"
  ].forEach((needle) => assertIncludes(docs, needle, "secrets signoff docs"));
}

function checkHrDataSignoffValidation() {
  const pkg = readJson("package.json");
  assertIncludes(pkg.scripts["validate:hr-signoff"], "scripts/validate-hr-signoff.mjs", "package.json validate:hr-signoff script");

  const validator = readText("scripts/validate-hr-signoff.mjs");
  [
    "validateHrDataSignoff",
    "dashboardSignoffCounts",
    "requiredMaskedFields",
    "requiredApprovalRoles",
    "source.sourceChecksum does not match the current source file",
    "dataPolicy.exportPolicy.allowsSensitiveExport must be false",
    "production signoff must not contain openExceptions",
    "employee.sensitive.read"
  ].forEach((needle) => assertIncludes(validator, needle, "scripts/validate-hr-signoff.mjs"));

  const example = readText("docs/hr-data-signoff.example.json");
  [
    "\"schemaVersion\": 1",
    "\"example\": true",
    "\"sourceName\": \"oa-dashboard.html\"",
    "\"activeEmployees\": 72",
    "\"leavers\": 162",
    "\"femaleEmployees\": 43",
    "\"monthLeavers\": 4",
    "\"departments\": 10",
    "\"orgs\": 8",
    "\"allowsSensitiveExport\": false",
    "\"recordsExportLedger\": true",
    "\"HR owner\"",
    "\"Product owner\""
  ].forEach((needle) => assertIncludes(example, needle, "docs/hr-data-signoff.example.json"));

  const tests = readText("server/tests/hr-signoff.test.mjs");
  [
    "HR data signoff validator accepts reviewed source counts and data policy",
    "HR data signoff validator rejects stale source counts and checksum",
    "HR data signoff validator rejects sensitive export and missing approvals",
    "HR data signoff validator blocks example and production exceptions",
    "dashboard signoff counts are derived from the current oa-dashboard source",
    "HR data signoff CLI parser reads custom source json and example flags"
  ].forEach((needle) => assertIncludes(tests, needle, "server/tests/hr-signoff.test.mjs"));

  const docs = readText("docs/KNOWN_GAPS.md")
    + readText("docs/QA_ACCEPTANCE_CHECKLIST.md")
    + readText("docs/DEPLOYMENT.md")
    + readText("docs/COMMERCIALIZATION_PLAN.md");
  [
    "npm run validate:hr-signoff",
    "docs/hr-data-signoff.example.json",
    "HR data signoff"
  ].forEach((needle) => assertIncludes(docs, needle, "HR data signoff docs"));
}

function checkHrDataReviewPreparation() {
  const pkg = readJson("package.json");
  assertIncludes(pkg.scripts["prepare:hr-review"], "scripts/prepare-hr-data-review.mjs", "package.json prepare:hr-review script");

  const script = readText("scripts/prepare-hr-data-review.mjs");
  [
    "prepareHrDataReview",
    "hr-data-review-preparation",
    "reports/commercial-evidence/hr-data-review",
    "people-review.csv",
    "summary.json",
    "noSensitiveFields",
	    "requiredMaskedFields",
	    "maskedName",
	    "escapeCsvCell",
	    "validate:hr-signoff",
	    "writePrivateTextFile",
	    "chmodSync",
	    "0o700",
	    "0o600"
	  ].forEach((needle) => assertIncludes(script, needle, "scripts/prepare-hr-data-review.mjs"));

  const tests = readText("server/tests/hr-data-review-prep.test.mjs");
  [
    "HR data review prep writes masked reviewer package from dashboard source",
    "HR data review prep keeps sensitive fields out of the CSV contract",
	    "HR data review prep parser and CSV escaping are explicit",
	    "totalReviewRows, 234",
	    "validate:hr-signoff",
	    "modeOf",
	    "0o700",
	    "0o600"
	  ].forEach((needle) => assertIncludes(tests, needle, "server/tests/hr-data-review-prep.test.mjs"));

  const docs = readText("docs/QA_ACCEPTANCE_CHECKLIST.md")
    + readText("docs/DEPLOYMENT.md")
    + readText("docs/COMMERCIALIZATION_PLAN.md");
  [
    "npm run prepare:hr-review",
	    "reports/commercial-evidence/hr-data-review",
	    "people-review.csv",
	    "no sensitive fields",
	    "private `0700`",
	    "private `0600`",
	    "not release evidence"
	  ].forEach((needle) => assertIncludes(docs, needle, "HR data review preparation docs"));
}

function checkStorageSignoffValidation() {
  const pkg = readJson("package.json");
  assertIncludes(pkg.scripts["validate:storage-signoff"], "scripts/validate-storage-signoff.mjs", "package.json validate:storage-signoff script");

  const validator = readText("scripts/validate-storage-signoff.mjs");
  [
    "validateStorageSignoff",
    "requiredApprovalRoles",
    "supportedStorageTypes",
    "object-storage",
    "backed-persistent-volume",
    "runtime.fileStorageDriver must be local or s3",
    "runtime.objectStorageConfigured must be true for object-storage",
    "storage.independentBackup must be true",
    "backupPolicy.rpoHours must be > 0 and <= 24",
    "backupPolicy.rtoHours must be > 0 and <= 4",
    "restoreDrill.downloadedAttachmentSmoke.passed must be true",
    "restoreDrill.auditEventIds must include backup and restore audit event ids",
    "production storage signoff must not contain openExceptions"
  ].forEach((needle) => assertIncludes(validator, needle, "scripts/validate-storage-signoff.mjs"));

  const example = readText("docs/file-storage-signoff.example.json");
  [
    "\"schemaVersion\": 1",
    "\"example\": true",
    "\"storageType\": \"backed-persistent-volume\"",
    "\"fileStorageDriver\": \"local\"",
    "\"objectStorageConfigured\": false",
    "\"fileStorageDir\": \"/app/storage/files\"",
    "\"independentBackup\": true",
    "\"rpoHours\": 24",
    "\"rtoHours\": 4",
    "\"downloadedAttachmentSmoke\"",
    "\"passed\": true",
    "\"Infrastructure owner\"",
    "\"Security reviewer\""
  ].forEach((needle) => assertIncludes(example, needle, "docs/file-storage-signoff.example.json"));

  const tests = readText("server/tests/storage-signoff.test.mjs");
  [
    "storage signoff validator accepts reviewed storage controls and restore drill evidence",
    "storage signoff validator accepts object storage without local file-storage dir",
    "storage signoff validator rejects example release evidence and production exceptions",
    "storage signoff validator rejects missing storage controls and mismatched runtime directory",
    "storage signoff validator rejects incomplete restore drill and checksum mismatch",
    "storage signoff example template validates only when example mode is allowed",
    "storage signoff CLI parser reads path, storage dir, environment, and example flags"
  ].forEach((needle) => assertIncludes(tests, needle, "server/tests/storage-signoff.test.mjs"));

  const docs = readText("docs/KNOWN_GAPS.md")
    + readText("docs/QA_ACCEPTANCE_CHECKLIST.md")
    + readText("docs/DEPLOYMENT.md")
    + readText("docs/COMMERCIALIZATION_PLAN.md");
  [
    "npm run validate:storage-signoff",
    "docs/file-storage-signoff.example.json",
    "File storage signoff"
  ].forEach((needle) => assertIncludes(docs, needle, "File storage signoff docs"));
}

function checkSignoffDraftGeneration() {
  const pkg = readJson("package.json");
  assertIncludes(pkg.scripts["signoff:drafts"], "scripts/generate-signoff-drafts.mjs", "package.json signoff:drafts script");

  const generator = readText("scripts/generate-signoff-drafts.mjs");
  [
    "generateSignoffDrafts",
    "buildHrDataSignoffDraft",
    "buildSecretsSignoffDraft",
    "buildStorageSignoffDraft",
    "reports/commercial-evidence/signoff-drafts",
    "draftNotice",
    "Do not attach these draft files as release evidence",
    "sourceChecksum: sha256File(sourcePath)",
    "validationSummary",
    "requiredManagedSecrets",
    "DEFAULT_ADMIN_PASSWORD",
    "downloadedAttachmentSmoke",
	    "backupDir",
	    "fileBackupDir",
	    "objectStorageEndpointHost",
	    "Provider-native object-storage restore or platform restore tooling",
	    "parseSignoffDraftArgs",
	    "writePrivateTextFile",
	    "chmodSync",
	    "0o700",
	    "0o600"
	  ].forEach((needle) => assertIncludes(generator, needle, "scripts/generate-signoff-drafts.mjs"));

  const tests = readText("server/tests/signoff-drafts.test.mjs");
  [
    "signoff draft generator writes non-release drafts from current source data",
    "signoff draft generator carries S3 object storage runtime shape",
    "signoff draft generator exposes missing production env as a draft exception",
    "signoff draft CLI parser reads source env storage output and json flags",
    "pg_real_random_secret_value_2026",
    "assert.equal(secretsText.includes",
	    "object-secret-at-least-16",
	    "backupDir",
	    "fileBackupDir",
	    "objectStorageEndpointHost",
	    "modeOf",
	    "0o700",
	    "0o600"
	  ].forEach((needle) => assertIncludes(tests, needle, "server/tests/signoff-drafts.test.mjs"));

  const docs = readText("docs/QA_ACCEPTANCE_CHECKLIST.md")
    + readText("docs/DEPLOYMENT.md")
    + readText("docs/COMMERCIALIZATION_PLAN.md");
  [
	    "npm run signoff:drafts",
	    "reports/commercial-evidence/signoff-drafts",
	    "private `0700`",
	    "private `0600`",
	    "draft files are not release evidence",
	    "S3-compatible storage drafts include only non-secret object-storage metadata"
	  ].forEach((needle) => assertIncludes(docs, needle, "signoff draft docs"));

  const evidence = readText("scripts/commercial-evidence.mjs");
  assertIncludes(evidence, "scripts/generate-signoff-drafts.mjs", "scripts/commercial-evidence.mjs");
}

function checkCommercialDrillEvidenceValidation() {
  const pkg = readJson("package.json");
  assertIncludes(pkg.scripts["validate:drill-evidence"], "scripts/validate-drill-evidence.mjs", "package.json validate:drill-evidence script");
  assertIncludes(pkg.scripts["drill:local-recovery"], "scripts/local-recovery-drill.sh", "package.json drill:local-recovery script");
  assertIncludes(pkg.scripts["validate:local-recovery-drill"], "scripts/validate-local-recovery-drill.mjs", "package.json validate:local-recovery-drill script");

  const validator = readText("scripts/validate-drill-evidence.mjs");
  [
    "validateCommercialDrillEvidence",
    "inferEvidenceRoot",
    "remapKnownArtifactPath",
	    "parseDrillEvidenceArgs",
	    "allowedKinds = [\"commercial-drill\"]",
	    "commercial-evidence/latest-drill-summary.json",
	    "drill summary databaseUrl must mask the password",
	    "drill summary startedAt",
	    "backup age exceeds RPO target",
	    "drill duration exceeds RTO target",
	    "metadata.rpo_target",
	    "artifact checksum mismatch",
    "file storage readiness must be ok",
    "validateTarArchive",
    "preRestoreReadyEvidence",
    "postRestoreReadyEvidence",
    "preRestoreSmokeEvidence",
    "postRestoreSmokeEvidence"
  ].forEach((needle) => assertIncludes(validator, needle, "scripts/validate-drill-evidence.mjs"));

  const localValidator = readText("scripts/validate-local-recovery-drill.mjs");
  [
    "validateLocalRecoveryDrillEvidence",
    "commercial-evidence/latest-local-recovery-drill-summary.json",
    "commercial-local-recovery-drill",
    "local-postgres",
    "does not replace Docker compose release drill evidence"
  ].forEach((needle) => assertIncludes(localValidator, needle, "scripts/validate-local-recovery-drill.mjs"));

  const tests = readText("server/tests/drill-evidence.test.mjs");
  [
    "commercial drill evidence validator accepts a complete restore drill package",
    "commercial drill evidence validator accepts downloaded GitHub artifact layout",
    "commercial drill evidence validator rejects unmasked database passwords",
	    "commercial drill evidence validator rejects checksum mismatches and missing files",
	    "commercial drill evidence validator rejects failed readiness and smoke evidence",
	    "commercial drill evidence validator enforces RPO and RTO timing",
	    "commercial drill evidence validator rejects weak or malformed recovery targets",
	    "commercial drill evidence validator rejects local recovery summaries by default",
	    "local recovery drill validator accepts local diagnostic evidence",
	    "commercial drill evidence parser and metadata parser read expected values"
	  ].forEach((needle) => assertIncludes(tests, needle, "server/tests/drill-evidence.test.mjs"));

  const drill = readText("scripts/commercial-drill.sh");
  [
    "relative_to_root",
	    "preRestoreReadyEvidence",
	    "postRestoreReadyEvidence",
	    "startedAt",
	    "latest-drill-summary.json",
    "LATEST_DRILL_SUMMARY",
    "umask 077",
    "chmod 700 \"$COMMERCIAL_EVIDENCE_DIR\"",
    "chmod 600 \"$COMMERCIAL_EVIDENCE_DIR/drill-summary.json\""
  ].forEach((needle) => assertIncludes(drill, needle, "scripts/commercial-drill.sh"));

  const localDrill = readText("scripts/local-recovery-drill.sh");
  [
    "ALLOW_LOCAL_RECOVERY_DRILL",
    "BACKUP_USE_LOCAL_PG_DUMP=1",
    "BACKUP_USE_LOCAL_PG_RESTORE=1",
    "FILE_BACKUP_USE_LOCAL=1",
    "commercial-local-recovery-drill",
    "executionMode",
    "latest-local-recovery-drill-summary.json",
    "LATEST_LOCAL_RECOVERY_DRILL_SUMMARY",
    "umask 077",
    "chmod 700 \"$COMMERCIAL_EVIDENCE_DIR\"",
    "chmod 600 \"$COMMERCIAL_EVIDENCE_DIR/local-recovery-drill-summary.json\""
  ].forEach((needle) => assertIncludes(localDrill, needle, "scripts/local-recovery-drill.sh"));

  const evidence = readText("scripts/commercial-evidence.mjs");
  [
    "drill-evidence",
    "validate:drill-evidence",
    "commercial-evidence/latest-drill-summary.json"
  ].forEach((needle) => assertIncludes(evidence, needle, "scripts/commercial-evidence.mjs"));

  const gate = readText("scripts/commercial-release-gate.mjs");
  assertIncludes(gate, "drill-evidence", "scripts/commercial-release-gate.mjs");

  const docs = readText("docs/KNOWN_GAPS.md")
    + readText("docs/QA_ACCEPTANCE_CHECKLIST.md")
    + readText("docs/DEPLOYMENT.md")
    + readText("docs/COMMERCIALIZATION_PLAN.md");
  [
    "npm run validate:drill-evidence",
    "npm run drill:local-recovery",
    "npm run validate:local-recovery-drill",
    "commercial-evidence/latest-drill-summary.json",
    "commercial-evidence/latest-local-recovery-drill-summary.json",
    "commercial-local-recovery-drill",
    "drill-evidence"
  ].forEach((needle) => assertIncludes(docs, needle, "commercial drill evidence docs"));
}

function checkProductionSeedSafetyImplementation() {
  const seedSafety = readText("scripts/seed-safety.mjs");
  [
    "export function assertSeedSafety",
    "env.NODE_ENV === \"production\" || env.APP_ENV === \"production\"",
    "env.ALLOW_PRODUCTION_SEED !== \"1\"",
    "Production database seed is blocked",
    "Production seed requires explicit non-default DEFAULT_ADMIN_PASSWORD",
    "validateNewPassword(adminPassword)",
    "Production seed DEFAULT_ADMIN_PASSWORD must satisfy password policy",
    "isAbsolute(env.FILE_STORAGE_DIR)",
    "Production seed requires explicit absolute FILE_STORAGE_DIR"
  ].forEach((needle) => assertIncludes(seedSafety, needle, "scripts/seed-safety.mjs"));

  const seedScript = readText("scripts/seed.mjs");
  [
    "import { assertSeedSafety } from \"./seed-safety.mjs\";",
    "assertSeedSafety();",
    "Seeded tenant \"${tenant.code}\" with admin ${adminEmail}"
  ].forEach((needle) => assertIncludes(seedScript, needle, "scripts/seed.mjs"));
  assert(
    seedScript.indexOf("assertSeedSafety();") < seedScript.indexOf("const prisma = new PrismaClient();"),
    "scripts/seed.mjs must run seed safety before opening Prisma"
  );
  const seedConsoleLogs = [...seedScript.matchAll(/console\.log\(([\s\S]*?)\);/g)].map((match) => match[1]).join("\n");
  assertNotIncludes(seedConsoleLogs, "adminPassword", "scripts/seed.mjs console output");

  const seedTests = readText("server/tests/seed-safety.test.mjs");
  [
    "seed safety allows non-production demo bootstrap",
    "seed safety blocks production seed without explicit approval",
    "seed safety blocks production default or missing admin password",
    "seed safety applies password policy to production bootstrap password",
    "seed safety requires absolute production file storage path",
    "seed safety accepts reviewed production seed inputs"
  ].forEach((needle) => assertIncludes(seedTests, needle, "server/tests/seed-safety.test.mjs"));

  const productionCompose = readText("docker-compose.prod.yml");
  assertIncludes(productionCompose, "ALLOW_PRODUCTION_SEED: ${ALLOW_PRODUCTION_SEED:-0}", "docker-compose.prod.yml");

  const productionEnv = readText(".env.production.example");
  assertIncludes(productionEnv, "ALLOW_PRODUCTION_SEED=0", ".env.production.example");

  const deployment = readText("docs/DEPLOYMENT.md");
  [
    "ALLOW_PRODUCTION_SEED=0",
    "reviewed bootstrap seed is intentionally part of the cutover",
    "The seed script refuses production seeding"
  ].forEach((needle) => assertIncludes(deployment, needle, "docs/DEPLOYMENT.md"));

  const qa = readText("docs/QA_ACCEPTANCE_CHECKLIST.md");
  [
    "unapproved production seed runs",
    "scripts/seed.mjs` now refuses production seeding unless `ALLOW_PRODUCTION_SEED=1`",
    "it no longer prints the bootstrap password"
  ].forEach((needle) => assertIncludes(qa, needle, "docs/QA_ACCEPTANCE_CHECKLIST.md"));
}

function checkMigrationInvariants() {
  const migrationPath = "prisma/migrations/20260529120000_init_commercial_oa/migration.sql";
  assertFile(migrationPath);
  const migration = readText(migrationPath);
  [
    "CREATE OR REPLACE FUNCTION prevent_audit_log_mutation",
    "BEFORE UPDATE ON \"audit_logs\"",
    "BEFORE DELETE ON \"audit_logs\"",
    "CREATE EXTENSION IF NOT EXISTS \"btree_gist\"",
    "CONSTRAINT \"bookings_valid_time_range\"",
    "CONSTRAINT \"bookings_no_confirmed_overlap\"",
    "EXCLUDE USING gist",
    "WHERE (\"status\" = 'CONFIRMED')"
  ].forEach((needle) => assertIncludes(migration, needle, migrationPath));

  const financeAttendanceMigrationPath = "prisma/migrations/20260529160000_finance_attendance/migration.sql";
  assertFile(financeAttendanceMigrationPath);
  const financeAttendanceMigration = readText(financeAttendanceMigrationPath);
  [
    "CREATE TABLE \"leave_requests\"",
    "CREATE TABLE \"payroll_batches\"",
    "payroll_batches_tenant_id_batch_no_key",
    "leave_requests_tenant_id_status_idx",
    "payroll_batches_tenant_id_status_idx"
  ].forEach((needle) => assertIncludes(financeAttendanceMigration, needle, financeAttendanceMigrationPath));

  const attendanceRecordsMigrationPath = "prisma/migrations/20260530172000_attendance_records/migration.sql";
  assertFile(attendanceRecordsMigrationPath);
  const attendanceRecordsMigration = readText(attendanceRecordsMigrationPath);
  [
    "CREATE TABLE \"attendance_records\"",
    "attendance_records_tenant_id_work_date_idx",
    "attendance_records_tenant_id_status_idx",
    "attendance_records_tenant_id_fkey"
  ].forEach((needle) => assertIncludes(attendanceRecordsMigration, needle, attendanceRecordsMigrationPath));

  const financeRequestsMigrationPath = "prisma/migrations/20260530190000_finance_requests/migration.sql";
  assertFile(financeRequestsMigrationPath);
  const financeRequestsMigration = readText(financeRequestsMigrationPath);
  [
    "CREATE TABLE \"finance_requests\"",
    "finance_requests_tenant_id_request_no_key",
    "finance_requests_tenant_id_request_type_idx",
    "finance_requests_workflow_instance_id_fkey"
  ].forEach((needle) => assertIncludes(financeRequestsMigration, needle, financeRequestsMigrationPath));

  const businessWorkflowLinksMigrationPath = "prisma/migrations/20260529163000_business_workflow_links/migration.sql";
  assertFile(businessWorkflowLinksMigrationPath);
  const businessWorkflowLinksMigration = readText(businessWorkflowLinksMigrationPath);
  [
    "ALTER TABLE \"payroll_batches\" ADD COLUMN \"workflow_instance_id\"",
    "leave_requests_workflow_instance_id_fkey",
    "payroll_batches_workflow_instance_id_fkey",
    "leave_requests_tenant_id_workflow_instance_id_idx",
    "payroll_batches_tenant_id_workflow_instance_id_idx"
  ].forEach((needle) => assertIncludes(businessWorkflowLinksMigration, needle, businessWorkflowLinksMigrationPath));

  const dataImportMigrationPath = "prisma/migrations/20260529172000_data_import_runs/migration.sql";
  assertFile(dataImportMigrationPath);
  const dataImportMigration = readText(dataImportMigrationPath);
  [
    "CREATE TABLE \"data_import_runs\"",
    "\"source_checksum\" TEXT NOT NULL",
    "\"record_counts\" JSONB NOT NULL DEFAULT '{}'",
    "data_import_runs_tenant_id_source_name_source_checksum_idx",
    "data_import_runs_actor_user_id_fkey"
  ].forEach((needle) => assertIncludes(dataImportMigration, needle, dataImportMigrationPath));

  const dataImportUniquePath = "prisma/migrations/20260530090000_data_import_success_unique/migration.sql";
  assertFile(dataImportUniquePath);
  const dataImportUniqueMigration = readText(dataImportUniquePath);
  [
    "CREATE UNIQUE INDEX \"data_import_runs_success_unique\"",
    "ON \"data_import_runs\"(\"tenant_id\", \"source_name\", \"source_checksum\")",
    "WHERE \"status\" = 'SUCCESS'"
  ].forEach((needle) => assertIncludes(dataImportUniqueMigration, needle, dataImportUniquePath));

  const dataImportAppendOnlyPath = "prisma/migrations/20260530234000_data_import_runs_append_only/migration.sql";
  assertFile(dataImportAppendOnlyPath);
  const dataImportAppendOnlyMigration = readText(dataImportAppendOnlyPath);
  [
    "CREATE OR REPLACE FUNCTION prevent_data_import_run_mutation",
    "BEFORE UPDATE ON \"data_import_runs\"",
    "BEFORE DELETE ON \"data_import_runs\"",
    "data_import_runs are append-only"
  ].forEach((needle) => assertIncludes(dataImportAppendOnlyMigration, needle, dataImportAppendOnlyPath));

  const seed = readText("scripts/seed.mjs");
  assertIncludes(seed, "Import lineage is append-only", "scripts/seed.mjs");
  assertNotIncludes(seed, "prisma.dataImportRun.update(", "scripts/seed.mjs");

  const workflowSubmitIdempotencyPath = "prisma/migrations/20260530113000_workflow_submit_idempotency/migration.sql";
  assertFile(workflowSubmitIdempotencyPath);
  const workflowSubmitIdempotencyMigration = readText(workflowSubmitIdempotencyPath);
  [
    "ALTER TABLE \"workflow_instances\" ADD COLUMN \"idempotency_key\" TEXT",
    "CREATE UNIQUE INDEX \"workflow_instances_tenant_id_idempotency_key_key\"",
    "ON \"workflow_instances\"(\"tenant_id\", \"idempotency_key\")"
  ].forEach((needle) => assertIncludes(workflowSubmitIdempotencyMigration, needle, workflowSubmitIdempotencyPath));

  const sessionMigrationPath = "prisma/migrations/20260529184000_user_session_version/migration.sql";
  assertFile(sessionMigrationPath);
  assertIncludes(readText(sessionMigrationPath), "\"session_version\" INTEGER NOT NULL DEFAULT 1", sessionMigrationPath);

  const rolePermissionPolicyPath = "prisma/migrations/20260530143000_role_permission_policies/migration.sql";
  assertFile(rolePermissionPolicyPath);
  const rolePermissionPolicyMigration = readText(rolePermissionPolicyPath);
  [
    "ALTER TABLE \"role_permissions\"",
    "ADD COLUMN \"data_scope\" JSONB",
    "ADD COLUMN \"field_policy\" JSONB",
    "ADD COLUMN \"allow_export\" BOOLEAN NOT NULL DEFAULT false"
  ].forEach((needle) => assertIncludes(rolePermissionPolicyMigration, needle, rolePermissionPolicyPath));

  const exportRecordMigrationPath = "prisma/migrations/20260530213000_export_records/migration.sql";
  assertFile(exportRecordMigrationPath);
  const exportRecordMigration = readText(exportRecordMigrationPath);
  [
    "CREATE TABLE \"export_records\"",
    "\"row_count\" INTEGER NOT NULL DEFAULT 0",
    "\"filters\" JSONB NOT NULL DEFAULT '{}'",
    "\"request_id\" TEXT",
    "export_records_tenant_id_created_at_idx",
    "export_records_actor_user_id_fkey"
  ].forEach((needle) => assertIncludes(exportRecordMigration, needle, exportRecordMigrationPath));

  const exportReasonMigrationPath = "prisma/migrations/20260530231500_export_business_reason/migration.sql";
  assertFile(exportReasonMigrationPath);
  assertIncludes(readText(exportReasonMigrationPath), "ALTER TABLE \"export_records\" ADD COLUMN \"business_reason\" TEXT", exportReasonMigrationPath);

  const exportRecordAppendOnlyMigrationPath = "prisma/migrations/20260530233000_export_records_append_only/migration.sql";
  assertFile(exportRecordAppendOnlyMigrationPath);
  const exportRecordAppendOnlyMigration = readText(exportRecordAppendOnlyMigrationPath);
  [
    "CREATE OR REPLACE FUNCTION prevent_export_record_mutation",
    "BEFORE UPDATE ON \"export_records\"",
    "BEFORE DELETE ON \"export_records\"",
    "export_records are append-only"
  ].forEach((needle) => assertIncludes(exportRecordAppendOnlyMigration, needle, exportRecordAppendOnlyMigrationPath));
}

function checkCommercialSmokeCoverage() {
  const smoke = readText("scripts/commercial-smoke.mjs");
  [
    "writeCommercialEvidence",
    "COMMERCIAL_SMOKE_EVIDENCE_FILE",
    "kind: \"commercial-smoke\"",
    "details: error.details",
    "/api/auth/login",
    "Readiness endpoint did not confirm database and file storage",
    "Failed login did not return generic invalid credentials",
    "Failed login audit event missing",
    "/api/people",
    "/api/analytics/overview",
    "/api/analytics/export",
    "Analytics did not include imported people totals",
    "Analytics export content-disposition header missing",
    "Analytics export structured record missing",
    "Analytics export business reason missing",
    "Analytics export audit event missing",
    "/api/people/employees/",
    "Employee maintenance was not persisted",
    "Employee maintenance audit event missing",
    "/api/imports",
    "/api/imports/dashboard-html",
    "Empty dashboard import was not rejected",
    "Empty import denial audit event missing",
    "Runtime dashboard import did not persist imported employee",
    "Runtime import audit event missing",
    "Dashboard import checksum missing",
    "Dashboard import row count missing",
    "/api/attendance/leaves",
    "/api/attendance/records",
    "/api/attendance/records/export",
    "Attendance record list did not return records",
    "Attendance record export content-disposition header missing",
    "Attendance record export audit event missing",
    "Attendance record audit event missing",
    "Attendance record audit did not use authenticated operator",
    "Leave workflow applicant did not use authenticated user",
    "Repeated leave submit did not return idempotent replay flag",
    "Repeated leave submit created a duplicate leave request",
    "Repeated leave submit wrote a duplicate audit event",
    "/api/finance/requests",
    "Finance request creation did not return requested number",
    "Finance request did not create a workflow instance",
    "Repeated finance request submit did not return idempotent replay flag",
    "Finance request export content-disposition header missing",
    "Finance request export audit event missing",
    "Finance request create audit event missing",
    "/api/finance/payrolls",
    "workflowInstanceId",
    "Payroll batch is not linked to an approved workflow",
    "PAYROLL-SMOKE-",
    "Payroll creation did not create a workflow instance",
    "Repeated payroll submit did not return idempotent replay flag",
    "Unapproved payroll publish did not return workflow_not_approved",
    "Unapproved payroll publish denial audit event missing",
    "Repeated payroll submit wrote a duplicate audit event",
    "Payroll reviewer did not use authenticated user",
    "Archived payroll review did not return invalid status",
    "/api/approvals/rules",
    "/api/approvals/rules/coverage",
    "/api/approvals/rules/preview",
    "Approval rule coverage did not include the saved department rule",
    "Approval rule coverage did not flag unresolved smoke approvers",
    "Approval rule preview did not use active department rule",
    "Disabled approval rule was still used by preview",
    "Disabled approval rule approver leaked into preview",
    "Deleted approval rule still returned",
    "/api/approvals/definitions",
    "HR lifecycle definition missing",
    "HR-SALARY",
    "HR transfer workflow did not use lifecycle definition",
    "HR onboarding workflow did not use lifecycle definition",
    "Approved HR onboarding workflow did not create an employee profile",
    "HR regularization workflow did not use lifecycle definition",
    "HR salary workflow did not use lifecycle definition",
    "Approved HR salary workflow did not update safe lifecycle summary",
    "Salary amount leaked into people lifecycle summary",
    "HR exception workflow did not use lifecycle definition",
    "Approved HR exception workflow did not move employee to inactive status",
    "Exception action plan leaked into people lifecycle summary",
    "HR offboarding workflow did not use lifecycle definition",
    "Approved HR offboarding workflow did not move employee to leavers",
    "/api/approvals",
    "/withdraw",
    "Applicant/admin withdraw did not succeed",
    "Withdrawn approval did not move to withdrawn status",
    "Approval withdraw audit event missing",
    "Approval comment author did not use authenticated user",
    "Approval comment audit did not use authenticated operator",
    "Repeated approval submit did not return idempotent replay flag",
    "Repeated approval submit created a duplicate workflow",
    "/api/approvals/export",
    "Approval export content-disposition header missing",
    "Approval export CSV did not include created approval",
    "/transfer",
    "Transfer did not create a replacement pending approver",
    "/api/assets",
    "/actions",
    "Asset inventory event did not use authenticated operator",
    "Asset inventory audit did not use authenticated operator",
    "Duplicate asset borrow did not return invalid transition",
    "/api/assets/export",
    "Asset export content-disposition header missing",
    "Asset export CSV did not include created asset",
    "/api/resources/bookings",
    "Resource booking did not use authenticated applicant",
    "Resource booking audit did not use authenticated operator",
    "Resource booking conflict audit event missing",
    "Resource booking export content-disposition header missing",
    "Resource booking export audit event missing",
    "Duplicate resource booking did not return conflict",
    "/api/files",
    "File API leaked storageKey",
    "Unsafe attachment upload was not rejected",
    "Unsafe attachment upload denial audit event missing",
    "Downloaded file content does not match upload",
    "/api/audit/export",
    "Audit export CSV header missing",
    "Audit export structured record missing",
    "Audit export business reason missing",
    "content-disposition",
    "x-row-count",
    "/api/auth/logout",
    "Logout left the old token usable"
  ].forEach((needle) => assertIncludes(smoke, needle, "scripts/commercial-smoke.mjs"));

  const drill = readText("scripts/commercial-drill.sh");
  [
    "Running pre-drill static commercial gates.",
    "npm run preflight:commercial",
    "npm run brand:check",
    "npm run contract:api",
    "docker compose up --build -d",
    "COMMERCIAL_EVIDENCE_DIR",
    "pre-restore-smoke.json",
    "post-restore-smoke.json",
    "drill-summary.json",
    "masked_database_url",
    "npm run smoke:commercial",
    "backup-postgres.sh",
    "backup-files.sh",
    "restore-postgres.sh",
    "restore-files.sh",
    "npm run db:deploy"
  ].forEach((needle) => assertIncludes(drill, needle, "scripts/commercial-drill.sh"));

  const e2e = readText("tests/e2e/commercial-smoke.spec.js");
  [
    "apiRequired",
    "loginIfBackendRequired",
    "API-required frontend logs in and stays on backend data source",
    "API-required frontend submits an expense workflow through the backend",
    "后端已连接",
    "本地演示模式",
    "Commercial CI uses API-required browser smoke tests plus backend commercial smoke"
  ].forEach((needle) => assertIncludes(e2e, needle, "tests/e2e/commercial-smoke.spec.js"));
}

function checkAuthSessionRevocationImplementation() {
  const schema = readText("prisma/schema.prisma");
  assertIncludes(schema, "sessionVersion Int", "prisma/schema.prisma");

  const app = readText("server/src/app.mjs");
  [
    "request.user.sessionVersion",
    "user.sessionVersion !== tokenSessionVersion",
    "user.status !== \"ACTIVE\""
  ].forEach((needle) => assertIncludes(app, needle, "server/src/app.mjs"));

  const authRoutes = readText("server/src/modules/auth/auth-routes.mjs");
  [
    "/api/auth/change-password",
    "sessionVersion: user.sessionVersion",
    "sessionVersion: { increment: 1 }",
    "/api/auth/logout",
    "auth.password_change",
    "validateNewPassword"
  ].forEach((needle) => assertIncludes(authRoutes, needle, "server/src/modules/auth/auth-routes.mjs"));
}

function checkCsrfOriginGuardImplementation() {
  const app = readText("server/src/app.mjs");
  [
    "SAFE_METHODS",
    "trustProxy: config.trustProxy",
    "firstHeaderValue",
    "config.trustProxy ? firstHeaderValue(request.headers[\"x-forwarded-host\"])",
    "requestSourceOrigin",
    "allowedRequestOrigins",
    "csrf_origin_denied",
    "blocked cross-site mutating request"
  ].forEach((needle) => assertIncludes(app, needle, "server/src/app.mjs"));

  const tests = readText("server/tests/app.test.mjs");
  [
    "csrf origin guard rejects cross-site mutating requests",
    "forwardedHostSpoofing",
    "trustedProxyAllowed",
    "https://evil.example",
    "https://oa.example.com",
    "csrf_origin_denied"
  ].forEach((needle) => assertIncludes(tests, needle, "server/tests/app.test.mjs"));

  const envRuntime = readText("server/src/lib/env.mjs");
  [
    "TRUST_PROXY",
    "trustProxy: boolFromEnv(\"TRUST_PROXY\", false)"
  ].forEach((needle) => assertIncludes(envRuntime, needle, "server/src/lib/env.mjs"));
}

function checkIamUserRoleImplementation() {
  const iamRoutes = readText("server/src/modules/iam/iam-routes.mjs");
  [
    "/api/iam/users",
    "/api/iam/users/:id/roles",
    "/api/iam/users/:id/status",
    "/api/iam/users/:id/password",
    "iam.user.create",
    "user_email_exists",
    "roleCodes",
    "normalizeUserStatus",
    "validateNewPassword",
    "sessionVersion: { increment: 1 }",
    "userRole.deleteMany",
    "userRole.createMany",
    "iam.user_roles.update",
    "iam.user_status.update",
    "iam.user_password.reset",
    "admin_self_password_reset_guard_required",
    "admin_self_status_guard_required",
    "admin_self_role_guard_required"
  ].forEach((needle) => assertIncludes(iamRoutes, needle, "server/src/modules/iam/iam-routes.mjs"));

  const iamApi = readText("src/api/iam.js");
  [
    "createUser",
    "updateUserRoles",
    "updateUserStatus",
    "resetUserPassword",
    "/iam/users/"
  ].forEach((needle) => assertIncludes(iamApi, needle, "src/api/iam.js"));

  const apiHook = readText("src/hooks/query/useApiBackedOaSystem.js");
  assertIncludes(apiHook, "iamApi.createUser", "src/hooks/query/useApiBackedOaSystem.js");
  assertIncludes(apiHook, "iamApi.updateUserRoles", "src/hooks/query/useApiBackedOaSystem.js");
  assertIncludes(apiHook, "iamApi.updateUserStatus", "src/hooks/query/useApiBackedOaSystem.js");
  assertIncludes(apiHook, "iamApi.resetUserPassword", "src/hooks/query/useApiBackedOaSystem.js");
  assertIncludes(apiHook, "authApi.changePassword", "src/hooks/query/useApiBackedOaSystem.js");

  const localHook = readText("src/hooks/useOaSystem.js");
  assertIncludes(localHook, "createUserAccount(payload", "src/hooks/useOaSystem.js");
  assertIncludes(localHook, "updateUserRoles(userId, roleCodes)", "src/hooks/useOaSystem.js");
  assertIncludes(localHook, "updateUserStatus(userId, status)", "src/hooks/useOaSystem.js");
  assertIncludes(localHook, "resetUserPassword(userId)", "src/hooks/useOaSystem.js");

  const seed = readText("scripts/seed.mjs");
  [
    "hr-specialist",
    "asset-admin",
    "finance-approver",
    "audit-viewer"
  ].forEach((needle) => assertIncludes(seed, needle, "scripts/seed.mjs"));

  const auditFeature = readText("src/features/Audit.jsx");
  [
    "账号角色分配",
    "创建账号",
    "toggleUserRole",
    "toggleAccountRole",
    "actions.createUserAccount",
    "actions.updateUserRoles",
    "actions.updateUserStatus",
    "actions.resetUserPassword",
    "停用账号",
    "恢复账号",
    "重置密码"
  ].forEach((needle) => assertIncludes(auditFeature, needle, "src/features/Audit.jsx"));

  const tests = readText("server/tests/app.test.mjs");
  [
    "iam user creation creates login-capable accounts assigns roles and audits without secrets",
    "iam user status update disables accounts revokes sessions and audits",
    "iam admin password reset revokes target sessions and audits without exposing secrets",
    "auth change password validates current password revokes old session and audits",
    "admin_self_status_guard_required",
    "admin_self_password_reset_guard_required",
    "user_email_exists",
    "invalid_user_status",
    "/api/iam/users",
    "/api/iam/users/user-ops/password",
    "/api/iam/users/user-ops/status"
  ].forEach((needle) => assertIncludes(tests, needle, "server/tests/app.test.mjs"));
}

function checkAnalyticsImplementation() {
  const app = readText("server/src/app.mjs");
  assertIncludes(app, "registerAnalyticsRoutes", "server/src/app.mjs");

  const analyticsRoutes = readText("server/src/modules/analytics/analytics-routes.mjs");
  [
    "/api/analytics/overview",
    "/api/analytics/export",
    "module: \"analytics\", action: \"read\"",
    "module: \"analytics\", action: \"export\"",
    "analytics.export",
    "analyticsSnapshotCsv",
    "Content-Disposition",
    "X-Row-Count",
    "/^[\\s]*[=+\\-@]/",
    "peopleByDepartment",
    "approvalEfficiency",
    "assetByStatus",
    "administrativeCost",
    "riskApprovals"
  ].forEach((needle) => assertIncludes(analyticsRoutes, needle, "server/src/modules/analytics/analytics-routes.mjs"));

  const analyticsApi = readText("src/api/analytics.js");
  [
    "getAnalyticsOverview",
    "exportAnalyticsSnapshot",
    "/analytics/export",
    "downloadCsv"
  ].forEach((needle) => assertIncludes(analyticsApi, needle, "src/api/analytics.js"));

  const apiHook = readText("src/hooks/query/useApiBackedOaSystem.js");
  [
    "analyticsApi.getAnalyticsOverview",
    "[\"analytics\", analyticsApi.getAnalyticsOverview]",
    "analyticsApi.exportAnalyticsSnapshot",
    "fallback.actions.exportAnalyticsSnapshot"
  ].forEach((needle) => assertIncludes(apiHook, needle, "src/hooks/query/useApiBackedOaSystem.js"));

  const apiState = readText("src/services/apiState.js");
  assertIncludes(apiState, "normalizeAnalyticsPayload", "src/services/apiState.js");

  const localHook = readText("src/hooks/useOaSystem.js");
  [
    "exportAnalyticsSnapshot(filters = {})",
    "analytics_snapshot",
    "管理看板快照"
  ].forEach((needle) => assertIncludes(localHook, needle, "src/hooks/useOaSystem.js"));

  const analyticsFeature = readText("src/features/Analytics.jsx");
  [
    "state.analytics",
    "actions.exportAnalyticsSnapshot",
    "导出看板快照",
    "行政成本构成",
    "审批效率",
    "资产状态",
    "currency(cards.administrativeCost)"
  ].forEach((needle) => assertIncludes(analyticsFeature, needle, "src/features/Analytics.jsx"));

  const seed = readText("scripts/seed.mjs");
  [
    "\"analytics.read\"",
    "\"analytics.export\"",
    "导出管理看板"
  ].forEach((needle) => assertIncludes(seed, needle, "scripts/seed.mjs"));

  const tests = readText("server/tests/app.test.mjs");
  [
    "/api/analytics/export",
    "analytics export returns backend CSV with formula escaping and audit row",
    "analytics export requires explicit export permission"
  ].forEach((needle) => assertIncludes(tests, needle, "server/tests/app.test.mjs"));

  const e2e = readText("tests/e2e/commercial-smoke.spec.js");
  [
    "management dashboard exports an auditable analytics snapshot",
    "导出看板快照",
    "导出管理看板快照，本地演示仅记录导出动作"
  ].forEach((needle) => assertIncludes(e2e, needle, "tests/e2e/commercial-smoke.spec.js"));
}

function checkWorkflowTransferImplementation() {
  const approvalRoutes = readText("server/src/modules/approvals/approval-routes.mjs");
  [
    "/api/approvals/:id/transfer",
    "sourceApproverName",
    "targetApproverName",
    "status: \"TRANSFERRED\"",
    "workflowApprover.create",
    "workflow.transfer.denied",
    "principalCanActAs",
    "principalCanWithdraw",
    "workflow.identity.denied",
    "workflow.transfer.identity_denied",
    "workflow.withdraw.denied",
    "withdraw_identity_denied",
    "FOR UPDATE",
    "findDecisionIdempotency",
    "isWorkflowIdempotencyUniqueError"
  ].forEach((needle) => assertIncludes(approvalRoutes, needle, "server/src/modules/approvals/approval-routes.mjs"));

  const routeGuards = readText("server/src/modules/iam/route-guards.mjs");
  [
    "findFirst({",
    "tenantId: request.user.tenantId",
    "name: user.name",
    "employeeName: user.employee?.name"
  ].forEach((needle) => assertIncludes(routeGuards, needle, "server/src/modules/iam/route-guards.mjs"));

  const approvalsFeature = readText("src/features/Approvals.jsx");
  [
    "转交审批人",
    "status === \"待审批\"",
    "actions.transferApproval"
  ].forEach((needle) => assertIncludes(approvalsFeature, needle, "src/features/Approvals.jsx"));

  const localHook = readText("src/hooks/useOaSystem.js");
  [
    "status: \"已转交\"",
    "sourceApproverName",
    "转交给"
  ].forEach((needle) => assertIncludes(localHook, needle, "src/hooks/useOaSystem.js"));

  const tests = readText("server/tests/app.test.mjs");
  [
    "approval withdraw is limited to applicant or admin and audits denied attempts",
    "approval withdraw allows the applicant",
    "approval decision locks the workflow instance before mutating approver state",
    "approval decision rechecks idempotency after acquiring the workflow lock"
  ].forEach((needle) => assertIncludes(tests, needle, "server/tests/app.test.mjs"));
}

function checkApproverUserBindingImplementation() {
  const resolver = readText("server/src/modules/workflow/approver-resolution.mjs");
  [
    "loadApproverUserMap",
    "enrichRuleNodesFromPrisma",
    "approverUserIdForName",
    "approverResolutionSummary",
    "status: \"ACTIVE\""
  ].forEach((needle) => assertIncludes(resolver, needle, "server/src/modules/workflow/approver-resolution.mjs"));

  const approvalRoutes = readText("server/src/modules/approvals/approval-routes.mjs");
  [
    "enrichRuleNodesFromPrisma",
    "approverUserIdForName(node, approverName)",
    "approverResolution: approverResolutionSummary(ruleNodes)",
    "approverResolutionSummary(nodes)"
  ].forEach((needle) => assertIncludes(approvalRoutes, needle, "server/src/modules/approvals/approval-routes.mjs"));

  const workflowFactory = readText("server/src/modules/workflow/workflow-instance-factory.mjs");
  [
    "enrichRuleNodesFromPrisma",
    "userId: approverUserIdForName(node, approverName)",
    "approverResolution: approverResolutionSummary(ruleNodes)"
  ].forEach((needle) => assertIncludes(workflowFactory, needle, "server/src/modules/workflow/workflow-instance-factory.mjs"));

  const frontend = readText("src/features/Approvals.jsx");
  [
    "approverBindingText",
    "实名账号",
    "unresolvedApprovers"
  ].forEach((needle) => assertIncludes(frontend, needle, "src/features/Approvals.jsx"));

  const openApi = readText("server/src/openapi.mjs");
  [
    "approverUsers",
    "Backend-resolved active user bindings",
    "userId"
  ].forEach((needle) => assertIncludes(openApi, needle, "server/src/openapi.mjs"));

  const tests = readText("server/tests/app.test.mjs");
  [
    "user-wang",
    "approverUsers.map((item) => item.userId)",
    "workflow.nodes[0].approvers.map((item) => item.userId)"
  ].forEach((needle) => assertIncludes(tests, needle, "server/tests/app.test.mjs"));

  const qa = readText("docs/QA_ACCEPTANCE_CHECKLIST.md");
  [
    "Approval approver binding",
    "workflow_approvers.user_id"
  ].forEach((needle) => assertIncludes(qa, needle, "docs/QA_ACCEPTANCE_CHECKLIST.md"));
}

function checkWorkflowSubmitIdempotencyImplementation() {
  const schema = readText("prisma/schema.prisma");
  [
    "idempotencyKey        String?                @map(\"idempotency_key\")",
    "@@unique([tenantId, idempotencyKey])"
  ].forEach((needle) => assertIncludes(schema, needle, "prisma/schema.prisma"));

  const approvalRoutes = readText("server/src/modules/approvals/approval-routes.mjs");
  [
    "requestIdempotencyKey",
    "findSubmittedWorkflowByIdempotency",
    "alreadySubmitted: true",
    "idempotencyKey: idempotencyKey || null"
  ].forEach((needle) => assertIncludes(approvalRoutes, needle, "server/src/modules/approvals/approval-routes.mjs"));

  const workflowFactory = readText("server/src/modules/workflow/workflow-instance-factory.mjs");
  [
    "workflowSubmissionIdempotencyKey",
    "findWorkflowInstanceByIdempotencyKey",
    "isWorkflowSubmitIdempotencyUniqueError",
    "idempotencyKey: idempotencyKey || null"
  ].forEach((needle) => assertIncludes(workflowFactory, needle, "server/src/modules/workflow/workflow-instance-factory.mjs"));

  const attendanceRoutes = readText("server/src/modules/attendance/attendance-routes.mjs");
  [
    "workflowSubmissionIdempotencyKey",
    "alreadySubmitted: true",
    "idempotency_key_reused"
  ].forEach((needle) => assertIncludes(attendanceRoutes, needle, "server/src/modules/attendance/attendance-routes.mjs"));

  const tests = readText("server/tests/app.test.mjs") + readText("server/tests/iam-audit.test.mjs");
  [
    "workflow submission is idempotent by idempotency key",
    "leave-submit-idempotent",
    "workflow submit idempotency migration prevents duplicate submitted instances"
  ].forEach((needle) => assertIncludes(tests, needle, "server workflow submit idempotency tests"));
}

function checkHrLifecycleWorkflowCoverage() {
  const approvalRoutes = readText("server/src/modules/approvals/approval-routes.mjs");
  [
    "/api/approvals/definitions",
    "app.get(\"/api/approvals/rules/preview\"",
    "app.get(\"/api/approvals/rules/coverage\"",
    "app.delete(\"/api/approvals/rules/:id\"",
    "buildApprovalRuleCoverage",
    "workflow.rule.preview",
    "workflow.rule.delete",
    "serializeRulePreview",
    "source: preview.source",
    "serializeWorkflowDefinition",
    "applyHrLifecycleEffect",
    "nextLifecycleEmployeeNo",
    "employee.lifecycle.onboard",
    "employee.lifecycle.transfer",
    "employee.lifecycle.offboard",
    "HR-ONBOARD",
    "HR-REGULAR",
    "HR-TRANSFER",
    "HR-OFFBOARD",
    "HR-EXCEPTION",
    "HR-SALARY"
  ].forEach((needle) => assertIncludes(approvalRoutes, needle, "server/src/modules/approvals/approval-routes.mjs"));

  const workflowFactory = readText("server/src/modules/workflow/workflow-instance-factory.mjs");
  [
    "\"HR-ONBOARD\": { templateId: \"onboarding\"",
    "\"HR-REGULAR\": { templateId: \"regularization\"",
    "\"HR-TRANSFER\": { templateId: \"transfer\"",
    "\"HR-OFFBOARD\": { templateId: \"offboarding\"",
    "\"HR-EXCEPTION\": { templateId: \"exception\""
  ].forEach((needle) => assertIncludes(workflowFactory, needle, "server/src/modules/workflow/workflow-instance-factory.mjs"));

  const seed = readText("scripts/seed.mjs");
  [
    "code: \"HR-ONBOARD\"",
    "code: \"HR-REGULAR\"",
    "code: \"HR-TRANSFER\"",
    "code: \"HR-OFFBOARD\"",
    "code: \"HR-EXCEPTION\"",
    "\"HR-TRANSFER\": \"transfer\""
  ].forEach((needle) => assertIncludes(seed, needle, "scripts/seed.mjs"));

  const frontendSeed = readText("src/data/seed.js");
  [
    "workflowDefinitionToTemplate",
    "templatesFromDefinitions",
    "入职办理",
    "转正申请",
    "调岗申请",
    "离职交接",
    "状态异常人员报备",
    "客户接待申请",
    "文化活动申请",
    "培训申请",
    "templateId: \"transfer\""
  ].forEach((needle) => assertIncludes(frontendSeed, needle, "src/data/seed.js"));
  assertNotIncludes(frontendSeed, "meta: \"占位\"", "src/data/seed.js");

  const home = readText("src/features/Home.jsx");
  [
    "workflowTemplates",
    "item.templateId",
    "onOpenFlow(template)"
  ].forEach((needle) => assertIncludes(home, needle, "src/features/Home.jsx"));

  const globalSearch = readText("src/services/globalSearch.js");
  [
    "buildGlobalSearchResults",
    "appCatalog",
    "sideNav",
    "personResults",
    "state.resourceBookings"
  ].forEach((needle) => assertIncludes(globalSearch, needle, "src/services/globalSearch.js"));
  [
    "item.phone",
    "item.address",
    "item.idCard",
    "item.bank"
  ].forEach((needle) => assertNotIncludes(globalSearch, needle, "src/services/globalSearch.js"));

  const globalSearchTests = readText("server/tests/frontend-global-search.test.mjs");
  [
    "frontend global search finds modules apps workflows and business records",
    "frontend global search uses safe personnel fields and does not expose sensitive lookups"
  ].forEach((needle) => assertIncludes(globalSearchTests, needle, "server/tests/frontend-global-search.test.mjs"));

  const appShell = readText("src/components/AppShell.jsx");
  [
    "global-search-results",
    "onSearchResultClick",
    "searchResults.length"
  ].forEach((needle) => assertIncludes(appShell, needle, "src/components/AppShell.jsx"));

  const app = readText("src/App.jsx");
  [
    "buildGlobalSearchResults",
    "handleSearchResultClick",
    "templatesFromDefinitions(state.workflowDefinitions)",
    "workflowTemplates={workflowTemplates}",
    "templateOptions"
  ].forEach((needle) => assertIncludes(app, needle, "src/App.jsx"));

  const e2e = readText("tests/e2e/commercial-smoke.spec.js");
  [
    "global search launches workflows and navigates business modules",
    "getByPlaceholder(\"搜索菜单、流程、文档、人员等\")"
  ].forEach((needle) => assertIncludes(e2e, needle, "tests/e2e/commercial-smoke.spec.js"));

  const approvalsFeature = readText("src/features/Approvals.jsx");
  [
    "workflowTemplates",
    "templates={templateOptions}",
    "templateOptions.map",
    "coverageState",
    "后端覆盖矩阵",
    "rule-flow-preview",
    "rule-server-preview",
    "后端预览",
    "actions.previewApprovalRule",
    "moveNode",
    "删除配置"
  ].forEach((needle) => assertIncludes(approvalsFeature, needle, "src/features/Approvals.jsx"));

  const approvalApi = readText("src/api/approvals.js");
  [
    "listApprovalDefinitions",
    "listApprovalRuleCoverage",
    "previewApprovalRule",
    "deleteApprovalRule"
  ].forEach((needle) => assertIncludes(approvalApi, needle, "src/api/approvals.js"));

  const apiHook = readText("src/hooks/query/useApiBackedOaSystem.js");
  [
    "approvalApi.listApprovalRuleCoverage",
    "deleteApprovalRule",
    "previewApprovalRule(query)",
    "approvalApi.previewApprovalRule(query)",
    "await reloadDomains([\"audit\"])"
  ].forEach((needle) => assertIncludes(apiHook, needle, "src/hooks/query/useApiBackedOaSystem.js"));

  const localHook = readText("src/hooks/useOaSystem.js");
  [
    "deleteApprovalRule(id)",
    "previewApprovalRule(query)",
    "localApprovalRulePreview",
    "rule.enabled !== false",
    "[normalizedRule, ...current.approvalRules]"
  ].forEach((needle) => assertIncludes(localHook, needle, "src/hooks/useOaSystem.js"));

  const apiState = readText("src/services/apiState.js");
  [
    "workflowDefinitions",
    "approvalRuleCoverage",
    "pickArray(payloads.workflowDefinitions"
  ].forEach((needle) => assertIncludes(apiState, needle, "src/services/apiState.js"));

  const appTests = readText("server/tests/app.test.mjs");
  [
    "approved HR transfer workflow updates employee department and audits lifecycle sync",
    "approved HR onboarding workflow creates employee profile without exposing sensitive fields",
    "approved HR regularization offboarding exception and salary workflows sync employee profiles",
    "employee.lifecycle.transfer",
    "employee.lifecycle.onboard",
    "employee.lifecycle.regularization",
    "employee.lifecycle.offboard",
    "employee.lifecycle.exception",
    "employee.lifecycle.salary",
    "approval rule preview resolves active department rule and audits the preview",
    "approval rule coverage reports department workflow matrix and approver binding gaps",
    "disabled approval rules are ignored by preview and new workflow snapshots",
    "workflow_definition",
    "definitionSnapshot.ruleId, null"
  ].forEach((needle) => assertIncludes(appTests, needle, "server/tests/app.test.mjs"));

  const e2eRulePreview = readText("tests/e2e/commercial-smoke.spec.js");
  [
    "后端预览",
    "后端确认：部门规则",
    "甲主管、乙主管"
  ].forEach((needle) => assertIncludes(e2eRulePreview, needle, "tests/e2e/commercial-smoke.spec.js"));
}

function checkDataImportImplementation() {
  const app = readText("server/src/app.mjs");
  assertIncludes(app, "registerImportRoutes", "server/src/app.mjs");

  const importRoutes = readText("server/src/modules/imports/import-routes.mjs");
  [
    "module: \"import\", action: \"read\"",
    "module: \"import\", action: \"write\"",
    "/api/imports/:id/source",
    "/api/imports/dashboard-html",
    "loadDashboardPeopleFromHtml",
    "app.config.importMaxHtmlBytes",
    "employee.upsert",
    "department.upsert",
    "import.dashboard_html",
    "import.dashboard_html.denied",
    "import.dashboard_html.duplicate",
    "import.dashboard_html.source_download",
    "sourceArtifact",
    "app.fileStorage.put(storageKey",
    "app.fileStorage.get(artifact.storageKey)",
    "app.fileStorage.delete(sourceArtifact.storageKey)",
    "downloadAvailable",
    "import_content_too_large",
    "dashboard_import_empty",
    "duplicate_import",
    "source_artifact_checksum_mismatch",
    "application/octet-stream",
    "isDuplicateImportConstraintError",
    "data_import_runs_success_unique",
    "status: \"SUCCESS\"",
    "sourceChecksum",
    "recordCounts",
    "/api/imports"
  ].forEach((needle) => assertIncludes(importRoutes, needle, "server/src/modules/imports/import-routes.mjs"));

  const seed = readText("scripts/seed.mjs");
  [
    "\"import.read\"",
    "\"import.write\"",
    "dataImportRun",
    "dashboardChecksum",
    "sourceChecksum",
    "recordCounts"
  ].forEach((needle) => assertIncludes(seed, needle, "scripts/seed.mjs"));

  const peopleFeature = readText("src/features/People.jsx");
  [
    "数据导入记录",
    "导入 HTML 数据源",
    "导入人员数据",
    "下载源文件",
    "sourceChecksum",
    "recordCounts"
  ].forEach((needle) => assertIncludes(peopleFeature, needle, "src/features/People.jsx"));

  const importApi = readText("src/api/imports.js");
  assertIncludes(importApi, "importDashboardHtml", "src/api/imports.js");
  assertIncludes(importApi, "downloadImportSource", "src/api/imports.js");

  const apiHook = readText("src/hooks/query/useApiBackedOaSystem.js");
  assertIncludes(apiHook, "importApi.importDashboardHtml", "src/hooks/query/useApiBackedOaSystem.js");
  assertIncludes(apiHook, "importApi.downloadImportSource", "src/hooks/query/useApiBackedOaSystem.js");

  const env = readText("server/src/lib/env.mjs");
  [
    "IMPORT_MAX_HTML_BYTES",
    "importMaxHtmlBytes"
  ].forEach((needle) => assertIncludes(env, needle, "server/src/lib/env.mjs"));

  const tests = readText("server/tests/app.test.mjs");
  [
    "下载导入源文件 runtime-dashboard.html",
    "source_artifact_checksum_mismatch",
    "dashboard html import rejects oversized or empty content and writes denial audit rows",
    "import_content_too_large",
    "拒绝导入人员数据 empty-dashboard.html"
  ].forEach((needle) => assertIncludes(tests, needle, "server/tests/app.test.mjs"));

  const smoke = readText("scripts/commercial-smoke.mjs");
  [
    "Runtime dashboard import did not preserve source artifact",
    "Runtime dashboard import leaked source storage key",
    "Runtime source download body did not match imported HTML"
  ].forEach((needle) => assertIncludes(smoke, needle, "scripts/commercial-smoke.mjs"));
}

function checkEmployeeMaintenanceImplementation() {
  const peopleRoutes = readText("server/src/modules/people/people-routes.mjs");
  [
    "/api/people/employees/:id",
    "/api/people/export",
    "employeeDecision(principal, action",
    "requireEmployeeAccess(principal, \"write\"",
    "employeeScopeWhere",
    "requireEmployeeAccess",
    "employee.export.denied",
    "employee_sensitive_export_denied",
    "replyCsv(reply, csv, filename, rows.length)",
    "rowCount: rows.length",
    "employee.findFirst",
    "employee.update",
    "employee.update",
    "department_not_found",
    "invalid_employee_date",
    "inactiveEmployees",
    "employee.sensitive.denied",
    "employee.sensitive.reveal",
    "employee_sensitive_denied",
    "serializeLifecycleSummary",
    "lifecycleActionLabels",
    "lifecycleSummary"
  ].forEach((needle) => assertIncludes(peopleRoutes, needle, "server/src/modules/people/people-routes.mjs"));

  const permissionTests = readText("server/tests/app.test.mjs") + readText("server/tests/iam-audit.test.mjs");
  [
    "people APIs enforce role permission department data scope",
    "data_scope_denied",
    "permission evaluator enforces export and dataScope separately"
  ].forEach((needle) => assertIncludes(permissionTests, needle, "employee permission data-scope tests"));

  const peopleApi = readText("src/api/people.js");
  [
    "updateEmployee",
    "exportPeople",
    "PATCH",
    "/people/employees/",
    "/people/export"
  ].forEach((needle) => assertIncludes(peopleApi, needle, "src/api/people.js"));

  const apiHook = readText("src/hooks/query/useApiBackedOaSystem.js");
  [
    "peopleApi.updateEmployee",
    "peopleApi.exportPeople",
    "peopleApi.getPeopleOverview(enabled ? { revealSensitive: \"true\" } : {})",
    "setApiState((current) => ({",
    "revealSensitive: enabled"
  ].forEach((needle) => assertIncludes(apiHook, needle, "src/hooks/query/useApiBackedOaSystem.js"));

  const localHook = readText("src/hooks/useOaSystem.js");
  [
    "updateEmployee(id, payload = {})",
    "exportPeople(filters = {})",
    "rebuildPeople",
    "people: state.people",
    "inactiveEmployees"
  ].forEach((needle) => assertIncludes(localHook, needle, "src/hooks/useOaSystem.js"));

  const peopleFeature = readText("src/features/People.jsx");
  [
    "员工档案维护",
    "保存员工档案",
    "导出名册",
    "停用人员",
    "actions.updateEmployee",
    "最近人事流程",
    "LifecycleSummary",
    "lifecycleLine"
  ].forEach((needle) => assertIncludes(peopleFeature, needle, "src/features/People.jsx"));

  const tests = readText("server/tests/app.test.mjs");
  [
    "people sensitive reveal requires permission and audits denied attempts",
    "people sensitive reveal returns unmasked fields only after permission and writes audit",
    "people lifecycle summary exposes safe status without sensitive metadata",
    "people APIs enforce role permission department data scope",
    "people export returns backend CSV with safe fields and audit row",
    "people export requires export permission and enforces department data scope",
    "data_scope_denied"
  ].forEach((needle) => assertIncludes(tests, needle, "server/tests/app.test.mjs"));
}

function checkPermissionCatalogConsistency() {
  const frontendSeed = readText("src/data/seed.js");
  const backendSeed = readText("scripts/seed.mjs");
  const auditFeature = readText("src/features/Audit.jsx");
  const tests = readText("server/tests/iam-audit.test.mjs");
  const permissionCodes = [
    "system.admin",
    "analytics.read",
    "analytics.export",
    "iam.read",
    "iam.write",
    "employee.read",
    "employee.sensitive.read",
    "employee.write",
    "employee.export",
    "workflow.read",
    "workflow.write",
    "workflow.approve",
    "workflow.export",
    "attendance.read",
    "attendance.write",
    "attendance.export",
    "finance.read",
    "finance.write",
    "finance.export",
    "asset.read",
    "asset.write",
    "asset.export",
    "import.read",
    "import.write",
    "resource.read",
    "resource.book",
    "resource.export",
    "audit.read",
    "audit.export",
    "file.read",
    "file.upload"
  ];
  const frontendCodes = extractFrontendPermissionCodes(frontendSeed);
  const backendCodes = extractBackendPermissionCodes(backendSeed);
  assert(
    JSON.stringify(frontendCodes) === JSON.stringify(backendCodes),
    "frontend and backend permission catalogs are not identical",
    { frontendCodes, backendCodes }
  );
  assert(
    JSON.stringify(backendCodes) === JSON.stringify([...permissionCodes].sort()),
    "commercial permission baseline is not synchronized with backend seed",
    { permissionCodes, backendCodes }
  );
  permissionCodes.forEach((code) => {
    assertIncludes(frontendSeed, `code: "${code}"`, "src/data/seed.js");
    assertIncludes(backendSeed, `["${code}"`, "scripts/seed.mjs");
    assertIncludes(tests, `"${code}"`, "server/tests/iam-audit.test.mjs");
  });
  extractRoutePermissionRequirements().forEach((requirement) => {
    assert(
      backendCodes.some((code) => permissionCodeCoversRoute(code, requirement)),
      "backend seed permissions do not cover a route-level IAM requirement",
      requirement
    );
    assert(
      frontendCodes.some((code) => permissionCodeCoversRoute(code, requirement)),
      "frontend seed permissions do not cover a route-level IAM requirement",
      requirement
    );
  });
  [
    "analytics: \"管理看板\"",
    "attendance: \"假勤\"",
    "finance: \"财务行政\"",
    "import: \"数据导入\"",
    "file: \"文件附件\""
  ].forEach((needle) => assertIncludes(auditFeature, needle, "src/features/Audit.jsx"));
  assertIncludes(tests, "frontend IAM permission catalog stays aligned with backend seed permissions", "server/tests/iam-audit.test.mjs");
  assertIncludes(tests, "route guard principal lookup is scoped to the authenticated tenant", "server/tests/iam-audit.test.mjs");
}

function checkAuthenticatedBusinessRouteIamCoverage() {
  const routes = extractAuthenticatedRoutes();
  const unguardedBusinessRoutes = routes
    .filter((route) => !authenticatedRouteIamExceptions.has(routeKey(route)))
    .filter((route) => !routeHasRecognizedIamGuard(route))
    .map((route) => ({
      path: route.path,
      method: route.method,
      route: route.route
    }));

  assert(
    unguardedBusinessRoutes.length === 0,
    "authenticated business routes must enforce IAM permissions",
    { unguardedBusinessRoutes }
  );

  [
    "GET /api/people",
    "GET /api/people/employees",
    "GET /api/people/leavers",
    "POST /api/people/export",
    "PATCH /api/people/employees/:id"
  ].forEach((key) => {
    assert(
      routes.some((route) => routeKey(route) === key && routeHasRecognizedIamGuard(route)),
      "custom people route IAM guard is missing",
      { route: key }
    );
  });
}

function checkFileImplementation() {
  const app = readText("server/src/app.mjs");
  assertIncludes(app, "registerFileRoutes", "server/src/app.mjs");
  assertIncludes(app, "createFileStorage(config)", "server/src/app.mjs");

  const storage = readText("server/src/lib/file-storage.mjs");
  [
    "export function createLocalFileStorage",
    "export function createS3ObjectStorage",
    "AWS4-HMAC-SHA256",
    "object_storage_unavailable",
    "assertSafeStorageKey",
    "unsafe_file_storage_key",
    "probe()"
  ].forEach((needle) => assertIncludes(storage, needle, "server/src/lib/file-storage.mjs"));

  const fileRoutes = readText("server/src/modules/files/file-routes.mjs");
  [
    "module: \"file\", action: \"read\"",
    "module: \"file\", action: \"upload\"",
    "contentBase64",
    "BLOCKED_FILE_EXTENSIONS",
    "BLOCKED_MIME_TYPES",
    "sanitizeMimeType",
    "file.upload.denied",
    "file.download.denied",
    "file_type_not_allowed",
    "fileMaxUploadBytes",
    "storageKeyFor",
    "unsafe_storage_key",
    "file_checksum_mismatch",
    "checksum_mismatch",
    "actualChecksum",
    "expectedChecksum",
    "checksum(content)",
    "app.fileStorage.put(storageKey, content)",
    "app.fileStorage.get(file.storageKey)",
    "app.fileStorage.delete(storageKey)",
    "file.upload",
    "file.download",
    "storageKey"
  ].forEach((needle) => assertIncludes(fileRoutes, needle, "server/src/modules/files/file-routes.mjs"));

  const seed = readText("scripts/seed.mjs");
  [
    "\"file.read\"",
    "\"file.upload\"",
    "seedFileChecksum",
    "fileStorage.delete(seedStorageKey)",
    "fileStorage.put(seedStorageKey, seedContent)"
  ].forEach((needle) => assertIncludes(seed, needle, "scripts/seed.mjs"));

  const fileApi = readText("src/api/files.js");
  [
    "/files",
    "uploadFile",
    "downloadFile",
    "responseType: \"blob\"",
    "FileReader"
  ].forEach((needle) => assertIncludes(fileApi, needle, "src/api/files.js"));

  const apiHook = readText("src/hooks/query/useApiBackedOaSystem.js");
  [
    "fileApi.listFiles",
    "fileApi.uploadFile",
    "fileApi.downloadFile"
  ].forEach((needle) => assertIncludes(apiHook, needle, "src/hooks/query/useApiBackedOaSystem.js"));

  const auditFeature = readText("src/features/Audit.jsx");
  [
    "附件中心",
    "选择附件",
    "上传附件",
    "actions.downloadFile"
  ].forEach((needle) => assertIncludes(auditFeature, needle, "src/features/Audit.jsx"));

  const tests = readText("server/tests/app.test.mjs");
  [
    "ready endpoint verifies configured object storage adapter",
    "file_type_not_allowed",
    "拒绝上传高风险附件 unsafe.html",
    "blockedAudit.result, \"失败\""
  ].forEach((needle) => assertIncludes(tests, needle, "server/tests/app.test.mjs"));

  const fileStorageTests = readText("server/tests/file-storage.test.mjs");
  [
    "S3 object storage signs path-style requests without exposing the secret",
    "createFileStorage selects S3 driver",
    "local file storage writes reads deletes and rejects unsafe keys"
  ].forEach((needle) => assertIncludes(fileStorageTests, needle, "server/tests/file-storage.test.mjs"));
}

function checkReadinessFileStorageCoverage() {
  const tests = readText("server/tests/app.test.mjs");
  [
    "ready endpoint verifies database connectivity",
    "ready endpoint verifies configured object storage adapter",
    "ready endpoint returns 503 when append-only trigger integrity is missing",
    "ready endpoint returns 503 when file storage is not writable",
    "databaseIntegrity, \"ok\"",
    "databaseIntegrity, \"unavailable\"",
    "fileStorage, \"ok\"",
    "fileStorage, \"unavailable\""
  ].forEach((needle) => assertIncludes(tests, needle, "server/tests/app.test.mjs"));

  const docs = readText("docs/QA_ACCEPTANCE_CHECKLIST.md") + readText("docs/DEPLOYMENT.md");
  [
    "file-storage readiness",
    "PostgreSQL connectivity, live append-only database triggers"
  ].forEach((needle) => assertIncludes(docs, needle, "runtime readiness docs"));
}

function checkFileBackupRestoreImplementation() {
  const backupPostgres = readText("scripts/backup-postgres.sh");
	  [
	    "backup_file=\"$BACKUP_DIR/${safe_db}-${timestamp}.dump\"",
	    "timestamp=\"$(date -u +%Y%m%d-%H%M%S)\"",
	    "metadata_file=\"$backup_file.meta\"",
	    "Production BACKUP_DIR must be explicitly configured for database backups",
	    "Production BACKUP_DIR must be durable off-app storage",
	    "database_url_for_pg_cli",
	    "[\"schema\", \"connection_limit\", \"pool_timeout\"]",
	    "artifact_type=database",
    "sha256=$checksum",
    "chmod 600 \"$backup_file\" \"$metadata_file\"",
    "ops.backup"
  ].forEach((needle) => assertIncludes(backupPostgres, needle, "scripts/backup-postgres.sh"));

  const restorePostgres = readText("scripts/restore-postgres.sh");
  [
    "metadata_sidecar=\"$backup_file.meta\"",
    "expected_sha=\"$(metadata_value \"$metadata_sidecar\" sha256 || true)\"",
    "Database backup checksum mismatch",
    "metadata_artifact_type=\"$(metadata_value \"$metadata_sidecar\" artifact_type || true)\"",
    "Database backup metadata artifact_type mismatch",
    "Database backup metadata database mismatch",
    "ALLOW_RESTORE_DATABASE_MISMATCH",
    "Database backup metadata app_env mismatch",
    "ALLOW_RESTORE_ENV_MISMATCH",
    "database_url_for_pg_cli",
    "[\"schema\", \"connection_limit\", \"pool_timeout\"]",
    "restored_at=$(date -u +%Y%m%d-%H%M%S)",
    "sha256=${expected_sha:-$(sha256_file \"$backup_file\")}",
    "ops.restore"
  ].forEach((needle) => assertIncludes(restorePostgres, needle, "scripts/restore-postgres.sh"));

  const backupFiles = readText("scripts/backup-files.sh");
  [
    "FILE_BACKUP_DIR",
    "FILE_BACKUP_USE_LOCAL",
	    "assert_file_storage_backup_supported",
	    "FILE_STORAGE_DRIVER=s3 uses object storage",
	    "Production FILE_STORAGE_DIR must be explicitly configured for file storage backup",
	    "Production FILE_BACKUP_DIR must be explicitly configured for file storage backups",
	    "Production FILE_BACKUP_DIR must be durable off-app storage",
	    "timestamp=\"$(date -u +%Y%m%d-%H%M%S)\"",
	    "artifact_type=file_storage",
    "tar -czf",
    "sha256",
    "ops.backup",
    "chmod 600"
  ].forEach((needle) => assertIncludes(backupFiles, needle, "scripts/backup-files.sh"));

  const restoreFiles = readText("scripts/restore-files.sh");
  [
    "ALLOW_PRODUCTION_FILE_RESTORE",
    "assert_file_storage_restore_supported",
    "FILE_STORAGE_DRIVER=s3 uses object storage",
    "Production FILE_STORAGE_DIR must be explicitly configured for file storage restore",
    "Backup checksum mismatch",
    "metadata_artifact_type=\"$(metadata_value \"$metadata_sidecar\" artifact_type || true)\"",
    "File storage backup metadata artifact_type mismatch",
    "File storage backup metadata app_env mismatch",
    "ALLOW_RESTORE_ENV_MISMATCH",
    "validate-file-backup.mjs",
    "restored_at=$(date -u +%Y%m%d-%H%M%S)",
    "find \"$FILE_STORAGE_DIR\" -mindepth 1 -maxdepth 1 -exec rm -rf {} +",
    "tar -xzf",
    "artifact_type=file_storage",
    "ops.restore"
  ].forEach((needle) => assertIncludes(restoreFiles, needle, "scripts/restore-files.sh"));

  const fileBackupValidator = readText("scripts/validate-file-backup.mjs");
  [
    "isSafeTarEntryPath",
    "validateTarEntries",
    "validateTarArchive",
    "Unsafe tar entry path",
    "File backup archive has no entries",
    "tar\", [\"-tzf\""
  ].forEach((needle) => assertIncludes(fileBackupValidator, needle, "scripts/validate-file-backup.mjs"));

  const fileBackupTests = readText("server/tests/file-backup.test.mjs");
  [
    "file backup validator accepts normal tar entry paths",
    "file backup validator rejects path traversal and absolute paths",
    "file backup validator rejects empty archives",
    "file backup validator can inspect a generated safe tarball"
  ].forEach((needle) => assertIncludes(fileBackupTests, needle, "server/tests/file-backup.test.mjs"));

  const restoreScriptTests = readText("server/tests/restore-scripts.test.mjs");
  [
    "database restore blocks backup metadata database mismatch before pg_restore",
    "database restore can explicitly allow cross-database recovery and then reaches restore command",
    "file storage restore blocks backup metadata environment mismatch before tar validation",
	    "file storage restore blocks database artifacts before destructive local restore",
	    "file storage backup refuses S3 object storage tar backup",
	    "file storage backup requires explicit absolute production directory",
	    "database backup requires explicit durable production backup directory",
	    "database backup refuses project-local production backup directory",
	    "file storage backup refuses project-local production backup directory",
	    "production backup prune apply requires durable backup directories",
	    "file storage restore refuses S3 object storage tar restore before artifact lookup",
    "file storage restore requires explicit absolute production directory before artifact lookup"
  ].forEach((needle) => assertIncludes(restoreScriptTests, needle, "server/tests/restore-scripts.test.mjs"));

  const restoreDocs = readText("docs/DEPLOYMENT.md") + readText("docs/QA_ACCEPTANCE_CHECKLIST.md") + readText("docs/COMMERCIALIZATION_PLAN.md");
  [
	    "npm run backup:postgres",
	    "npm run restore:postgres",
	    "npm run backup:files",
	    "npm run restore:files",
	    "npm run validate:file-backup",
	    "fail closed for S3 object storage",
	    "Production local-volume file backup and restore require an explicit absolute FILE_STORAGE_DIR",
	    "Production database and file-storage backup output directories require explicit absolute off-app durable paths",
	    "validates file-storage tar entry paths before destructive restore",
    "rejects empty archives",
    "path-traversal tar entries"
  ].forEach((needle) => assertIncludes(restoreDocs, needle, "file backup restore docs"));

  const opsAudit = readText("scripts/ops-audit.mjs");
  [
    "appendAuditLog",
    "buildOpsAuditInput",
    "recordOpsAudit",
    "ops_file_storage",
    "文件存储备份完成",
    "文件存储恢复完成",
    "metadata.artifact_type === \"file_storage\""
  ].forEach((needle) => assertIncludes(opsAudit, needle, "scripts/ops-audit.mjs"));
  assertNotIncludes(opsAudit, "prisma.auditLog.create", "scripts/ops-audit.mjs");

  const opsAuditTests = readText("server/tests/ops-audit.test.mjs");
  [
    "recordOpsAudit uses unified appendAuditLog redaction path",
    "[REDACTED:attachment-object-key]",
    "[REDACTED:secret]"
  ].forEach((needle) => assertIncludes(opsAuditTests, needle, "server/tests/ops-audit.test.mjs"));
}

function checkBackupRetentionImplementation() {
  const pruneBackups = readText("scripts/prune-backups.sh");
  [
    "PRUNE_APPLY",
	    "ALLOW_PRODUCTION_PRUNE",
	    "PRUNE_DATABASE_KEEP",
	    "PRUNE_FILE_KEEP",
	    "safe_production_prune_dir",
	    "must be explicitly configured before backup retention pruning",
	    "*.dump",
    "file-storage-*.tar.gz",
    "ops.backup_prune",
    "Backup prune dry-run complete"
  ].forEach((needle) => assertIncludes(pruneBackups, needle, "scripts/prune-backups.sh"));

  const opsAudit = readText("scripts/ops-audit.mjs");
  [
    "ops.backup_prune",
    "ops_backup_retention",
    "备份保留清理完成"
  ].forEach((needle) => assertIncludes(opsAudit, needle, "scripts/ops-audit.mjs"));
}

function checkAuditExportImplementation() {
  const auditRoutes = readText("server/src/modules/audit/audit-routes.mjs");
  [
    "app.get(\"/api/audit\"",
    "app.get(\"/api/audit/integrity\"",
    "verifyAuditIntegrityChain(logs)",
    "function listLimit",
    "normalizeExportFilters(request.query || {})",
    "take: listLimit(request.query?.limit)",
    "text/csv; charset=utf-8",
    "Content-Disposition",
    "X-Row-Count",
    "rowCount: rows.length",
    "/^[\\s]*[=+\\-@]/",
    "where.metadata = { path: [\"result\"], equals: filters.result }",
    "row.result === filters.result",
    "auditRowsForCsv",
    "exportWhere"
  ].forEach((needle) => assertIncludes(auditRoutes, needle, "server/src/modules/audit/audit-routes.mjs"));

  const auditService = readText("server/src/modules/audit/audit-service.mjs");
  [
    "result: \"成功\"",
    "attachAuditIntegrity",
    "const signedRow = await attachAuditIntegrity"
  ].forEach((needle) => assertIncludes(auditService, needle, "server/src/modules/audit/audit-service.mjs"));

  const auditIntegrity = readText("server/src/modules/audit/audit-integrity.mjs");
  [
    "auditIntegrityAlgorithm = \"sha256-v1\"",
    "computeAuditRecordHash",
    "buildAuditIntegrityMetadata",
    "attachAuditIntegrity",
    "verifyAuditIntegrityChain",
    "previousHash does not match prior recordHash",
    "legacy audit-log rows are unsigned"
  ].forEach((needle) => assertIncludes(auditIntegrity, needle, "server/src/modules/audit/audit-integrity.mjs"));

  const appTests = readText("server/tests/app.test.mjs");
  [
    "audit list clamps limits and applies query filters",
    "audit integrity endpoint returns tenant hash-chain summary",
    "filteredCall.where.tenantId",
    "filteredCall.where.metadata"
  ].forEach((needle) => assertIncludes(appTests, needle, "server/tests/app.test.mjs"));

  const auditIntegrityTests = readText("server/tests/audit-integrity.test.mjs");
  [
    "audit integrity metadata signs sanitized audit rows and strips caller integrity",
    "appendAuditLog creates a contiguous tenant audit hash chain",
    "audit integrity verifier detects tampered payloads broken links and unsigned legacy rows"
  ].forEach((needle) => assertIncludes(auditIntegrityTests, needle, "server/tests/audit-integrity.test.mjs"));

  const auditApi = readText("src/api/audit.js");
  [
    "text/csv",
    "getAuditIntegrity",
    "/audit/integrity",
    "downloadCsv",
    "URL.createObjectURL",
    "audit-export-"
  ].forEach((needle) => assertIncludes(auditApi, needle, "src/api/audit.js"));

  const apiHook = readText("src/hooks/query/useApiBackedOaSystem.js");
  [
    "[\"auditIntegrity\", auditApi.getAuditIntegrity]",
    "auditIntegrityPayload",
    "auditApi.getAuditIntegrity()"
  ].forEach((needle) => assertIncludes(apiHook, needle, "src/hooks/query/useApiBackedOaSystem.js"));

  const apiState = readText("src/services/apiState.js");
  [
    "const auditIntegrity = pickObject",
    "nextState.auditIntegrity = auditIntegrity",
    "apiState.auditIntegrity"
  ].forEach((needle) => assertIncludes(apiState, needle, "src/services/apiState.js"));

  const localHook = readText("src/hooks/useOaSystem.js");
  [
    "localAuditIntegrity",
    "本地演示审计日志，未连接后端哈希链校验",
    "auditIntegrity: localAuditIntegrity"
  ].forEach((needle) => assertIncludes(localHook, needle, "src/hooks/useOaSystem.js"));

  const auditFeature = readText("src/features/Audit.jsx");
  [
    "const auditIntegrity = state.auditIntegrity",
    "auditIntegrityStatus",
    "审计链",
    "title=\"审计完整性\"",
    "哈希链通过",
    "哈希链需复核",
    "已签名审计行",
    "未签名遗留行",
    "末端哈希",
    "本地演示审计记录未签名"
  ].forEach((needle) => assertIncludes(auditFeature, needle, "src/features/Audit.jsx"));

  const frontendStateTests = readText("server/tests/frontend-api-state.test.mjs");
  [
    "frontend API state normalizes audit integrity payload",
    "frontend API state merges audit integrity with audit domain override guard"
  ].forEach((needle) => assertIncludes(frontendStateTests, needle, "server/tests/frontend-api-state.test.mjs"));
}

function checkExportRecordImplementation() {
  const schema = readText("prisma/schema.prisma");
  [
    "model ExportRecord",
    "@@map(\"export_records\")",
    "rowCount    Int",
    "businessReason String?",
    "requestId   String?",
    "exportRecords       ExportRecord[]",
    "exportRecords ExportRecord[] @relation(\"ExportActor\")"
  ].forEach((needle) => assertIncludes(schema, needle, "prisma/schema.prisma"));

  const auditService = readText("server/src/modules/audit/audit-service.mjs");
  [
    "export async function recordExportEvent",
    "export function requireExportBusinessReason",
    "EXPORT_BUSINESS_REASON_REQUIRED",
    "tx.exportRecord.create",
    "businessReason: businessReason || null",
    "requestId: input.requestId || null",
    "exportRecordId: exportRecord.id",
    "return prisma.$transaction(writeRecords)"
  ].forEach((needle) => assertIncludes(auditService, needle, "server/src/modules/audit/audit-service.mjs"));

  const auditRoutes = readText("server/src/modules/audit/audit-routes.mjs");
  [
    "function serializeExportRecord",
    "businessReason: record.businessReason || \"-\"",
    "app.get(\"/api/audit/export-records\"",
    "exportRecords: exportRecords.map(serializeExportRecord)",
    "recordExportEvent(app.prisma"
  ].forEach((needle) => assertIncludes(auditRoutes, needle, "server/src/modules/audit/audit-routes.mjs"));

  [
    "server/src/modules/analytics/analytics-routes.mjs",
    "server/src/modules/audit/audit-routes.mjs",
    "server/src/modules/people/people-routes.mjs",
    "server/src/modules/approvals/approval-routes.mjs",
    "server/src/modules/assets/asset-routes.mjs",
    "server/src/modules/attendance/attendance-routes.mjs",
    "server/src/modules/finance/finance-routes.mjs",
    "server/src/modules/resources/resource-routes.mjs"
  ].forEach((path) => {
    const routeText = readText(path);
    assertIncludes(routeText, "recordExportEvent(app.prisma", path);
    assertIncludes(routeText, "requireExportBusinessReason(request.body || {})", path);
    assertIncludes(routeText, "businessReason,", path);
  });

  const frontendState = readText("src/services/apiState.js");
  [
    "exportRecords = pickArray",
    "nextState.exportRecords = exportRecords",
    "apiState.exportRecords"
  ].forEach((needle) => assertIncludes(frontendState, needle, "src/services/apiState.js"));

  const auditFeature = readText("src/features/Audit.jsx");
  [
    "const exportRecords = state.exportRecords || []",
    "Panel title=\"导出记录\"",
    "业务用途",
    "requestId"
  ].forEach((needle) => assertIncludes(auditFeature, needle, "src/features/Audit.jsx"));

  const openApi = readText("server/src/openapi.mjs");
  assertIncludes(openApi, "\"/audit/export-records\"", "server/src/openapi.mjs");
  assertIncludes(openApi, "\"/audit/integrity\"", "server/src/openapi.mjs");
  assertIncludes(openApi, "ExportRequest", "server/src/openapi.mjs");

  const tests = readText("server/tests/app.test.mjs") + readText("server/tests/iam-audit.test.mjs");
  [
    "audit.json().exportRecords.length",
    "CSV exports require a business reason before generating files",
    "EXPORT_BUSINESS_REASON_REQUIRED",
    "export record migration persists auditable export metadata",
    "ADD COLUMN \"business_reason\" TEXT",
    "CREATE TABLE \"export_records\""
  ].forEach((needle) => assertIncludes(tests, needle, "export record tests"));

  const docs = readText("docs/COMMERCIALIZATION_PLAN.md") + readText("docs/QA_ACCEPTANCE_CHECKLIST.md") + readText("docs/API_CONTRACT.md");
  [
    "tamper-evident hash chain",
    "/api/audit/integrity",
    "structured `export_records`",
    "business reason",
    "Export records",
    "structured export-record lookup"
  ].forEach((needle) => assertIncludes(docs, needle, "export record docs"));
}

function checkApprovalExportImplementation() {
  const approvalRoutes = readText("server/src/modules/approvals/approval-routes.mjs");
  [
    "app.post(\"/api/approvals/export\"",
    "requirePermission(app, request, { module: \"workflow\", action: \"export\" })",
    "matchesExportFilters",
    "text/csv; charset=utf-8",
    "Content-Disposition",
    "X-Row-Count",
    "/^[\\s]*[=+\\-@]/",
    "action: \"workflow.export\"",
    "rowCount: rows.length"
  ].forEach((needle) => assertIncludes(approvalRoutes, needle, "server/src/modules/approvals/approval-routes.mjs"));

  const approvalApi = readText("src/api/approvals.js");
  [
    "exportApprovals",
    "/approvals/export",
    "text/csv",
    "downloadCsv",
    "approval-export-"
  ].forEach((needle) => assertIncludes(approvalApi, needle, "src/api/approvals.js"));

  const apiHook = readText("src/hooks/query/useApiBackedOaSystem.js");
  [
    "approvalApi.exportApprovals",
    "fallback.actions.exportApprovals"
  ].forEach((needle) => assertIncludes(apiHook, needle, "src/hooks/query/useApiBackedOaSystem.js"));

  const localHook = readText("src/hooks/useOaSystem.js");
  assertIncludes(localHook, "exportApprovals(filters = {})", "src/hooks/useOaSystem.js");

  const approvalsFeature = readText("src/features/Approvals.jsx");
  assertIncludes(approvalsFeature, "actions.exportApprovals({ scope: \"审批列表\" })", "src/features/Approvals.jsx");

  const seed = readText("scripts/seed.mjs") + readText("src/data/seed.js");
  [
    "workflow.export",
    "导出审批列表"
  ].forEach((needle) => assertIncludes(seed, needle, "approval export seed data"));

  const tests = readText("server/tests/app.test.mjs");
  [
    "approval export returns backend CSV with formula escaping and audit row",
    "approval export requires explicit export permission",
    "/api/approvals/export"
  ].forEach((needle) => assertIncludes(tests, needle, "server/tests/app.test.mjs"));
}

function checkAssetExportImplementation() {
  const assetRoutes = readText("server/src/modules/assets/asset-routes.mjs");
  [
    "app.post(\"/api/assets/export\"",
    "requirePermission(app, request, { module: \"asset\", action: \"export\" })",
    "assetExportWhere",
    "text/csv; charset=utf-8",
    "Content-Disposition",
    "X-Row-Count",
    "/^[\\s]*[=+\\-@]/",
    "action: \"asset.export\"",
    "rowCount: rows.length"
  ].forEach((needle) => assertIncludes(assetRoutes, needle, "server/src/modules/assets/asset-routes.mjs"));

  const assetApi = readText("src/api/assets.js");
  [
    "exportAssets",
    "/assets/export",
    "text/csv",
    "downloadCsv",
    "asset-ledger-"
  ].forEach((needle) => assertIncludes(assetApi, needle, "src/api/assets.js"));

  const apiHook = readText("src/hooks/query/useApiBackedOaSystem.js");
  [
    "assetApi.exportAssets",
    "fallback.actions.exportAssets"
  ].forEach((needle) => assertIncludes(apiHook, needle, "src/hooks/query/useApiBackedOaSystem.js"));

  const localHook = readText("src/hooks/useOaSystem.js");
  assertIncludes(localHook, "exportAssets(filters = {})", "src/hooks/useOaSystem.js");

  const assetsFeature = readText("src/features/Assets.jsx");
  assertIncludes(assetsFeature, "actions.exportAssets({ scope: \"资产台账\" })", "src/features/Assets.jsx");

  const seed = readText("scripts/seed.mjs") + readText("src/data/seed.js");
  [
    "asset.export",
    "导出资产台账"
  ].forEach((needle) => assertIncludes(seed, needle, "asset export seed data"));

  const tests = readText("server/tests/app.test.mjs");
  [
    "asset export returns backend CSV with formula escaping and audit row",
    "asset export requires explicit export permission",
    "/api/assets/export"
  ].forEach((needle) => assertIncludes(tests, needle, "server/tests/app.test.mjs"));
}

function checkAssetQrImplementation() {
  const packageJson = JSON.parse(readText("package.json"));
  assert(packageJson.dependencies?.qrcode, "package.json must include qrcode for generated asset QR images");

  const assetRoutes = readText("server/src/modules/assets/asset-routes.mjs");
  [
    "import QRCode from \"qrcode\"",
    "assetQrPayload",
    "serializeAssetWithQr",
    "QRCode.toDataURL",
    "qrImage",
    "lastQrReplacedAt",
    "lastQrReplacedBy",
    "qrPayload: assetQrPayload(asset)"
  ].forEach((needle) => assertIncludes(assetRoutes, needle, "server/src/modules/assets/asset-routes.mjs"));

  const openapi = readText("server/src/openapi.mjs");
  [
    "Regenerate asset QR version and image",
    "qrPayload",
    "qrImage",
    "AssetResponse"
  ].forEach((needle) => assertIncludes(openapi, needle, "server/src/openapi.mjs"));

  const assetQrComponent = readText("src/components/AssetQr.jsx");
  [
    "QRCode.toDataURL",
    "qrPayload(asset)",
    "asset.qrImage",
    "资产二维码"
  ].forEach((needle) => assertIncludes(assetQrComponent, needle, "src/components/AssetQr.jsx"));

  const assetsFeature = readText("src/features/Assets.jsx");
  [
    "import { AssetQr }",
    "<AssetQr asset={current} />"
  ].forEach((needle) => assertIncludes(assetsFeature, needle, "src/features/Assets.jsx"));

  const serverTests = readText("server/tests/app.test.mjs");
  [
    "data:image\\/png;base64,",
    "qrPayload",
    "qrVersion, 2"
  ].forEach((needle) => assertIncludes(serverTests, needle, "server/tests/app.test.mjs"));

  const smoke = readText("scripts/commercial-smoke.mjs");
  [
    "QR replacement did not return a generated QR image",
    "QR payload does not identify the asset"
  ].forEach((needle) => assertIncludes(smoke, needle, "scripts/commercial-smoke.mjs"));

  const e2e = readText("tests/e2e/commercial-smoke.spec.js");
  assertIncludes(e2e, "资产二维码", "tests/e2e/commercial-smoke.spec.js");
}

function checkFinanceRequestImplementation() {
  const schema = readText("prisma/schema.prisma");
  [
    "model FinanceRequest",
    "@@map(\"finance_requests\")",
    "financeRequests     FinanceRequest[]",
    "financeRequests FinanceRequest[] @relation(\"FinanceRequester\")",
    "financeRequests       FinanceRequest[]       @relation(\"FinanceWorkflowInstance\")"
  ].forEach((needle) => assertIncludes(schema, needle, "prisma/schema.prisma"));

  const financeRoutes = readText("server/src/modules/finance/finance-routes.mjs");
  const approvalRoutes = readText("server/src/modules/approvals/approval-routes.mjs");
  [
    "app.get(\"/api/finance/requests\"",
    "app.post(\"/api/finance/requests/export\"",
    "app.post(\"/api/finance/requests\"",
    "requirePermission(app, request, { module: \"finance\", action: \"export\" })",
    "finance.request.export",
    "toFinanceRequestCsv",
    "Content-Disposition",
    "X-Row-Count",
    "/^[\\s]*[=+\\-@]/",
    "financeRequest.findMany",
    "financeRequest.create",
    "finance.${body.config.auditType}.create",
    "auditType: \"payment\"",
    "finance_workflow_definition_missing",
    "workflowSubmissionIdempotencyKey"
  ].forEach((needle) => assertIncludes(financeRoutes, needle, "server/src/modules/finance/finance-routes.mjs"));
  [
    "tx.financeRequest.updateMany",
    "FIN-EXPENSE",
    "FIN-PAYMENT",
    "await syncLinkedBusinessStatus(tx, request, instance, \"WITHDRAWN\")"
  ].forEach((needle) => assertIncludes(approvalRoutes, needle, "server/src/modules/approvals/approval-routes.mjs"));

  const financeApi = readText("src/api/finance.js");
  [
    "listFinanceRequests",
    "createFinanceRequest",
    "exportFinanceRequests",
    "/finance/requests/export",
    "downloadCsv",
    "/finance/requests"
  ].forEach((needle) => assertIncludes(financeApi, needle, "src/api/finance.js"));

  const apiHook = readText("src/hooks/query/useApiBackedOaSystem.js");
  [
    "financeApi.listFinanceRequests",
    "financeApi.createFinanceRequest",
    "financeApi.exportFinanceRequests",
    "fallback.actions.createFinanceRequest"
  ].forEach((needle) => assertIncludes(apiHook, needle, "src/hooks/query/useApiBackedOaSystem.js"));

  const apiState = readText("src/services/apiState.js");
  [
    "financeRequests",
    "apiState.financeRequests"
  ].forEach((needle) => assertIncludes(apiState, needle, "src/services/apiState.js"));

  const localHook = readText("src/hooks/useOaSystem.js");
  [
    "createFinanceRequest(payload = {})",
    "exportFinanceRequests(filters = {})",
    "financeRequests",
    "财务单据创建失败"
  ].forEach((needle) => assertIncludes(localHook, needle, "src/hooks/useOaSystem.js"));

  const financeFeature = readText("src/features/Finance.jsx");
  [
    "提交财务单据",
    "导出财务单据",
    "state.financeRequests",
    "actions.createFinanceRequest"
  ].forEach((needle) => assertIncludes(financeFeature, needle, "src/features/Finance.jsx"));

  const seed = readText("scripts/seed.mjs");
  [
    "financeRequest.upsert",
    "finance.export",
    "导出财务单据",
    "EXP-202605-0001",
    "PAY-202605-0001"
  ].forEach((needle) => assertIncludes(seed, needle, "scripts/seed.mjs"));

  const serverTests = readText("server/tests/app.test.mjs");
  [
    "/api/finance/requests",
    "/api/finance/requests/export",
    "finance request export returns backend CSV with formula escaping and audit row",
    "finance request export requires explicit export permission",
    "EXP-202606-0001",
    "pendingFinanceRequest.status, \"PENDING_APPROVAL\"",
    "approvedFinanceRequest.status, \"APPROVED\"",
    "finance_request_invalid_amount"
  ].forEach((needle) => assertIncludes(serverTests, needle, "server/tests/app.test.mjs"));
  assertIncludes(
    readText("server/tests/iam-audit.test.mjs"),
    "finance request migration creates durable payment and expense ledger",
    "server/tests/iam-audit.test.mjs"
  );

  const e2e = readText("tests/e2e/commercial-smoke.spec.js");
  assertIncludes(e2e, "提交财务单据", "tests/e2e/commercial-smoke.spec.js");
  assertIncludes(e2e, "导出财务单据台账，本地演示仅记录导出动作", "tests/e2e/commercial-smoke.spec.js");

  const docs = readText("docs/COMMERCIALIZATION_PLAN.md") + readText("docs/QA_ACCEPTANCE_CHECKLIST.md");
  [
    "finance ledger status stays pending after partial",
    "terminal decision"
  ].forEach((needle) => assertIncludes(docs, needle, "finance request workflow status docs"));
}

function checkBoundedQueryLimitImplementation() {
  const pagination = readText("server/src/lib/pagination.mjs");
  [
    "boundedQueryLimit",
    "Number.isFinite(parsed)",
    "Math.min(Math.floor(parsed), max)"
  ].forEach((needle) => assertIncludes(pagination, needle, "server/src/lib/pagination.mjs"));

  [
    ["server/src/modules/audit/audit-routes.mjs", "boundedQueryLimit(value, { fallback: 200, max: 500 })"],
    ["server/src/modules/attendance/attendance-routes.mjs", "boundedQueryLimit(request.query?.limit, { fallback: 100, max: 500 })"],
    ["server/src/modules/finance/finance-routes.mjs", "boundedQueryLimit(request.query?.limit, { fallback: 100, max: 500 })"],
    ["server/src/modules/files/file-routes.mjs", "boundedQueryLimit(request.query?.limit, { fallback: 100, max: 500 })"],
    ["server/src/modules/imports/import-routes.mjs", "boundedQueryLimit(request.query?.limit, { fallback: 50, max: 200 })"]
  ].forEach(([path, needle]) => assertIncludes(readText(path), needle, path));

  const tests = readText("server/tests/pagination.test.mjs");
  [
    "boundedQueryLimit falls back for invalid or nonpositive limits",
    "boundedQueryLimit clamps oversized limits"
  ].forEach((needle) => assertIncludes(tests, needle, "server/tests/pagination.test.mjs"));
}

function checkAuthenticatedActorPropagationImplementation() {
  const appRuntime = readText("server/src/app.mjs");
  [
    "email: user.email",
    "name: user.name",
    "sessionVersion: user.sessionVersion"
  ].forEach((needle) => assertIncludes(appRuntime, needle, "server/src/app.mjs"));

  const approvalRoutes = readText("server/src/modules/approvals/approval-routes.mjs");
  [
    "author: request.user.name || request.user.email || \"系统用户\"",
    "workflow.comment"
  ].forEach((needle) => assertIncludes(approvalRoutes, needle, "server/src/modules/approvals/approval-routes.mjs"));

  const assetRoutes = readText("server/src/modules/assets/asset-routes.mjs");
  [
    "const operator = String(request.user.name || request.user.email || \"系统用户\").trim()",
    "validAssetStatuses",
    "invalid_asset_status",
    "asset_not_found",
    "operator,",
    "metadata.lastInventoryOperator = operator",
    "operator: log.metadata?.operator || log.actor?.name || \"系统用户\""
  ].forEach((needle) => assertIncludes(assetRoutes, needle, "server/src/modules/assets/asset-routes.mjs"));

  const financeRoutes = readText("server/src/modules/finance/finance-routes.mjs");
  [
    "reviewerUserId: request.user.sub",
    "reviewer: request.user.name || request.user.email || \"系统用户\""
  ].forEach((needle) => assertIncludes(financeRoutes, needle, "server/src/modules/finance/finance-routes.mjs"));

  const resourceRoutes = readText("server/src/modules/resources/resource-routes.mjs");
  [
    "const applicantName = String(body.applicant || request.user.name || request.user.email || \"系统用户\").trim()",
    "metadata: { applicant: applicantName",
    "applicant: booking.metadata?.applicant || booking.applicant?.name || \"系统用户\""
  ].forEach((needle) => assertIncludes(resourceRoutes, needle, "server/src/modules/resources/resource-routes.mjs"));

  const resourceApi = readText("src/api/resources.js");
  [
    "cancelResourceBooking",
    "/resources/bookings/${encodeURIComponent(id)}/cancel"
  ].forEach((needle) => assertIncludes(resourceApi, needle, "src/api/resources.js"));

  const attendanceRoutes = readText("server/src/modules/attendance/attendance-routes.mjs");
  [
    "const applicantName = String(body.applicant || request.user.name || request.user.email || employeeName).trim()",
    "applicant: applicantName",
    "metadata: { applicant: applicantName"
  ].forEach((needle) => assertIncludes(attendanceRoutes, needle, "server/src/modules/attendance/attendance-routes.mjs"));

  const apiHook = readText("src/hooks/query/useApiBackedOaSystem.js");
  [
    "const currentUserName = currentUser?.name || fallbackUser().name",
    "assetApi.runAssetAction(id, { action: \"inventory\", result })",
    "owner: owner || currentUserName",
    "resourceApi.cancelResourceBooking(id, { reason })"
  ].forEach((needle) => assertIncludes(apiHook, needle, "src/hooks/query/useApiBackedOaSystem.js"));

  const appShell = readText("src/App.jsx");
  [
    "currentUser={currentUser}",
    "<Approvals actions={actions} currentUser={currentUser}",
    "<Resources actions={actions} currentUser={currentUser}"
  ].forEach((needle) => assertIncludes(appShell, needle, "src/App.jsx"));

  const tests = readText("server/tests/app.test.mjs");
  [
    "asset actions default operator to the authenticated user",
    "asset actions ignore client supplied operator identity",
    "asset write routes return business errors for invalid status and missing records",
    "leave workflow defaults applicant to the authenticated user",
    "approval comments use the authenticated actor name",
    "resource bookings default applicant to the authenticated user"
  ].forEach((needle) => assertIncludes(tests, needle, "server/tests/app.test.mjs"));

  const resourcesFeature = readText("src/features/Resources.jsx");
  [
    "actions.cancelResourceBooking",
    "row.status === \"已预约\""
  ].forEach((needle) => assertIncludes(resourcesFeature, needle, "src/features/Resources.jsx"));
}

function checkAttendanceRecordsImplementation() {
  const schema = readText("prisma/schema.prisma");
  [
    "model AttendanceRecord",
    "@@map(\"attendance_records\")",
    "attendanceRecords   AttendanceRecord[]"
  ].forEach((needle) => assertIncludes(schema, needle, "prisma/schema.prisma"));

	  const attendanceRoutes = readText("server/src/modules/attendance/attendance-routes.mjs");
	  [
	    "app.get(\"/api/attendance/records\"",
	    "app.post(\"/api/attendance/records/export\"",
	    "app.post(\"/api/attendance/records\"",
	    "requirePermission(app, request, { module: \"attendance\", action: \"export\" })",
	    "attendanceRecord.findMany",
	    "attendanceRecord.create",
	    "attendance.record.export",
	    "attendance.record.create",
	    "toAttendanceRecordCsv",
	    "Content-Disposition",
	    "X-Row-Count",
	    "/^[\\s]*[=+\\-@]/",
	    "recordStatusToLabel",
	    "invalid_attendance_status",
	    "boundedQueryLimit(request.query?.limit, { fallback: 100, max: 500 })"
	  ].forEach((needle) => assertIncludes(attendanceRoutes, needle, "server/src/modules/attendance/attendance-routes.mjs"));

  const attendanceApi = readText("src/api/attendance.js");
	  [
	    "listAttendanceRecords",
	    "createAttendanceRecord",
	    "exportAttendanceRecords",
	    "/attendance/records/export",
	    "downloadCsv",
	    "/attendance/records"
	  ].forEach((needle) => assertIncludes(attendanceApi, needle, "src/api/attendance.js"));

  const apiHook = readText("src/hooks/query/useApiBackedOaSystem.js");
	  [
	    "attendanceApi.listAttendanceRecords",
	    "attendanceApi.createAttendanceRecord",
	    "attendanceApi.exportAttendanceRecords",
	    "fallback.actions.createAttendanceRecord"
	  ].forEach((needle) => assertIncludes(apiHook, needle, "src/hooks/query/useApiBackedOaSystem.js"));

	  const localHook = readText("src/hooks/useOaSystem.js");
	  [
	    "exportAttendanceRecords(filters = {})",
	    "考勤记录台账"
	  ].forEach((needle) => assertIncludes(localHook, needle, "src/hooks/useOaSystem.js"));

  const apiState = readText("src/services/apiState.js");
  [
    "attendanceRecords",
    "apiState.attendanceRecords"
  ].forEach((needle) => assertIncludes(apiState, needle, "src/services/apiState.js"));

  const feature = readText("src/features/Attendance.jsx");
	  [
	    "考勤记录",
	    "actions.createAttendanceRecord",
	    "actions.exportAttendanceRecords",
	    "导出考勤记录",
	    "本月考勤异常",
	    "保存考勤记录"
	  ].forEach((needle) => assertIncludes(feature, needle, "src/features/Attendance.jsx"));

  const seed = readText("scripts/seed.mjs") + readText("src/data/seed.js");
	  [
	    "attendanceRecord",
	    "attendanceRecordSeed",
	    "attendance.export",
	    "导出考勤记录",
	    "门禁同步"
	  ].forEach((needle) => assertIncludes(seed, needle, "attendance record seed data"));

  const tests = readText("server/tests/app.test.mjs");
	  [
	    "/api/attendance/records?status=LATE",
	    "/api/attendance/records/export",
	    "attendance record export returns backend CSV with formula escaping and audit row",
	    "attendance record export requires explicit export permission",
	    "录入赵六 2026-06-01 考勤记录"
	  ].forEach((needle) => assertIncludes(tests, needle, "server/tests/app.test.mjs"));

  const e2e = readText("tests/e2e/commercial-smoke.spec.js");
	  [
	    "attendance module records clock exceptions and audit entries",
	    "保存考勤记录",
	    "导出考勤记录台账，本地演示仅记录导出动作",
	    "E2E补录缺卡"
	  ].forEach((needle) => assertIncludes(e2e, needle, "tests/e2e/commercial-smoke.spec.js"));
}

function checkResourceConflictAuditCoverage() {
  const resourceRoutes = readText("server/src/modules/resources/resource-routes.mjs");
  [
    "app.post(\"/api/resources/bookings/export\"",
    "requirePermission(app, request, { module: \"resource\", action: \"export\" })",
    "resource.booking.export",
    "toBookingCsv",
    "Content-Disposition",
    "X-Row-Count",
    "/^[\\s]*[=+\\-@]/",
    "action: \"resource.booking.conflict\"",
    "app.post(\"/api/resources/bookings/:id/cancel\"",
    "resource.booking.cancel",
    "bookingRangeFromBody",
    "bookingDate",
    "findBookingResource",
    "booking_not_found",
    "invalid_booking_status",
    "result: \"失败\"",
    "source: \"database_constraint\"",
    "booking_conflict"
  ].forEach((needle) => assertIncludes(resourceRoutes, needle, "server/src/modules/resources/resource-routes.mjs"));

  const resourceApi = readText("src/api/resources.js");
  [
    "exportResourceBookings",
    "/resources/bookings/export",
    "downloadCsv"
  ].forEach((needle) => assertIncludes(resourceApi, needle, "src/api/resources.js"));

  const apiHook = readText("src/hooks/query/useApiBackedOaSystem.js");
  [
    "resourceApi.exportResourceBookings",
    "fallback.actions.exportResourceBookings"
  ].forEach((needle) => assertIncludes(apiHook, needle, "src/hooks/query/useApiBackedOaSystem.js"));

  const resourcesFeature = readText("src/features/Resources.jsx");
  [
    "actions.exportResourceBookings",
    "导出预约台账"
  ].forEach((needle) => assertIncludes(resourcesFeature, needle, "src/features/Resources.jsx"));

  const seed = readText("scripts/seed.mjs") + readText("src/data/seed.js");
  [
    "resource.export",
    "导出资源预约"
  ].forEach((needle) => assertIncludes(seed, needle, "resource export seed data"));

  const tests = readText("server/tests/app.test.mjs");
  [
    "/api/resources/bookings/export",
    "resource booking export returns backend CSV with formula escaping and audit row",
    "resource booking export requires explicit export permission",
    "conflictAudit.type, \"预约冲突\"",
    "conflictAudit.result, \"失败\"",
    "bookingDate: \"2026-06-22\"",
    "startsAt: \"2026-06-23T09:00:00.000Z\"",
    "resource booking cancellation releases slot and writes audit rows"
  ].forEach((needle) => assertIncludes(tests, needle, "server/tests/app.test.mjs"));

  const smoke = readText("scripts/commercial-smoke.mjs");
  [
    "Resource booking conflict audit event missing",
    "Resource booking export content-disposition header missing",
    "Resource booking export audit event missing",
    "Resource booking cancellation failed",
    "Resource booking cancellation did not release slot",
    "item.type === \"预约冲突\"",
    "item.result === \"失败\""
  ].forEach((needle) => assertIncludes(smoke, needle, "scripts/commercial-smoke.mjs"));

  const localHook = readText("src/hooks/useOaSystem.js");
  [
    "exportResourceBookings(filters = {})",
    "资源预约台账",
    "item.status === \"已预约\"",
    "requestedDate",
    "重复取消"
  ].forEach((needle) => assertIncludes(localHook, needle, "src/hooks/useOaSystem.js"));

  const e2e = readText("tests/e2e/commercial-smoke.spec.js");
  [
    "resource booking cancellation releases the slot for rebooking",
    "快捷日期",
    "导出资源预约台账，本地演示仅记录导出动作",
    "取消一号会议室 .*16:00-18:00"
  ].forEach((needle) => assertIncludes(e2e, needle, "tests/e2e/commercial-smoke.spec.js"));
}

function checkTenantScopedLookupCoverage() {
  const approvalRoutes = readText("server/src/modules/approvals/approval-routes.mjs");
  [
    "async function approvalLookups(prisma, tenantId, instances)",
    "where: { tenantId, id: { in: userIds } }",
    "where: { tenantId, id: { in: departmentIds } }",
    "approvalLookups(app.prisma, request.user.tenantId"
  ].forEach((needle) => assertIncludes(approvalRoutes, needle, "server/src/modules/approvals/approval-routes.mjs"));

  const tests = readText("server/tests/app.test.mjs");
  [
    "approval list lookup is tenant-scoped for applicant and department names",
    "onUserFindMany",
    "onDepartmentFindMany",
    "applicantLookup?.where?.tenantId"
  ].forEach((needle) => assertIncludes(tests, needle, "server/tests/app.test.mjs"));
}

function checkPayrollCreationWorkflowGate() {
  const financeRoutes = readText("server/src/modules/finance/finance-routes.mjs");
  [
    "app.post(\"/api/finance/payrolls\"",
    "workflowSubmissionIdempotencyKey",
    "findWorkflowInstanceByIdempotencyKey",
    "findActiveWorkflowDefinition",
    "finance.payroll.workflow.submit",
    "finance.payroll.create",
    "finance.payroll.create.denied",
    "payroll_batch_exists",
    "payroll_workflow_definition_missing",
    "payroll_workflow_not_approved"
  ].forEach((needle) => assertIncludes(financeRoutes, needle, "server/src/modules/finance/finance-routes.mjs"));

  const financeApi = readText("src/api/finance.js");
  [
    "createPayroll",
    "method: \"POST\"",
    "/finance/payrolls"
  ].forEach((needle) => assertIncludes(financeApi, needle, "src/api/finance.js"));

  const apiHook = readText("src/hooks/query/useApiBackedOaSystem.js");
  [
    "async createPayroll(payload)",
    "financeApi.createPayroll(payload)",
    "reloadDomains([\"finance\", \"approvals\", \"audit\"])",
    "fallback.actions.createPayroll(payload)"
  ].forEach((needle) => assertIncludes(apiHook, needle, "src/hooks/query/useApiBackedOaSystem.js"));

  const localHook = readText("src/hooks/useOaSystem.js");
  [
    "createPayroll(payload = {})",
    "normalizePayrollDraft",
    "提交工资单复核流程",
    "审批未全部通过，不能发布工资单",
    "工资单复核发布"
  ].forEach((needle) => assertIncludes(localHook, needle, "src/hooks/useOaSystem.js"));

  const financeFeature = readText("src/features/Finance.jsx");
  [
    "创建工资单",
    "actions.createPayroll(payload)",
    "工资单已创建，并进入审批链路",
    "创建后需审批全通过才可发布"
  ].forEach((needle) => assertIncludes(financeFeature, needle, "src/features/Finance.jsx"));

  const tests = readText("server/tests/app.test.mjs");
  [
    "payroll-submit-idempotent",
    "payroll_workflow_not_approved",
    "工资单创建并提交复核"
  ].forEach((needle) => assertIncludes(tests, needle, "server/tests/app.test.mjs"));

  const e2e = readText("tests/e2e/commercial-smoke.spec.js");
  [
    "finance payroll creation starts approval and blocks early publish",
    "创建工资单",
    "工资单已创建，并进入审批链路。",
    "复核发布",
    "2026年7月工资单复核",
    "当前会签要求"
  ].forEach((needle) => assertIncludes(e2e, needle, "tests/e2e/commercial-smoke.spec.js"));
}

function checkBrandBoundaryImplementation() {
  const brandCheck = readText("scripts/brand-check.mjs");
  [
    "findForbiddenBrandReferences",
    "runBrandCheck",
    "defaultIncludePaths",
    "Forbidden third-party brand references found in deployable paths"
  ].forEach((needle) => assertIncludes(brandCheck, needle, "scripts/brand-check.mjs"));

  const tests = readText("server/tests/brand-check.test.mjs");
  [
    "brand check passes original OA deployable copy",
    "brand check flags forbidden third-party brand copy",
    "brand check flags forbidden third-party brand asset filenames"
  ].forEach((needle) => assertIncludes(tests, needle, "server/tests/brand-check.test.mjs"));

  const qa = readText("docs/QA_ACCEPTANCE_CHECKLIST.md");
  [
    "npm run brand:check",
    "automated deployable-source brand check"
  ].forEach((needle) => assertIncludes(qa, needle, "docs/QA_ACCEPTANCE_CHECKLIST.md"));
}

function checkSystemReadinessImplementation() {
  const app = readText("server/src/app.mjs");
  [
    "registerSystemRoutes",
    "readinessPayload"
  ].forEach((needle) => assertIncludes(app, needle, "server/src/app.mjs"));

  const runtimeReadiness = readText("server/src/modules/system/runtime-readiness.mjs");
  [
    "checkFileStorageWritable",
    "checkAppendOnlyDatabaseTriggers",
    "app.prisma.$queryRaw",
    "status.databaseIntegrity = \"unavailable\"",
    "appOrConfig.fileStorage.probe()",
    "status.fileStorage = \"unavailable\"",
    "status.database = \"unavailable\""
  ].forEach((needle) => assertIncludes(runtimeReadiness, needle, "server/src/modules/system/runtime-readiness.mjs"));

  const systemRoutes = readText("server/src/modules/system/system-routes.mjs");
  [
    "/api/system/readiness",
    "requirePermission(app, request, { module: \"system\", action: \"admin\" })",
    "parseKnownGaps",
    "docs\", \"KNOWN_GAPS.md\"",
    "safeRelativeFile",
    "loadSignoffDrafts",
    "loadHrDataReview",
    "loadGapActionReport",
    "loadLatestCommercialEvidence",
    "buildReleaseClosurePlan",
    "closurePlan",
    "artifactSummary",
    "summarizeArtifactInventory",
    "evidenceArtifactCatalog",
    "SPDX SBOM",
    "生产密钥正式签署",
    "Docker 恢复演练",
    "HR/Product 数据签署",
    "manifest?.files",
    "hrDataReview",
    "latestEvidence",
    "releaseCandidateReady",
    "releaseBlockerCount",
    "e2eIncluded",
    "最新商业证据摘要未达到 releaseCandidateReady",
    "最新商业证据缺少 E2E 检查",
    "最新商业证据摘要列出",
    "最新商业证据包不是 full 模式，不能作为发布候选证据",
    "最新商业证据包不是可接受的生产发布证据",
    "HR 脱敏审阅包仅用于签收前复核",
    "signoffDrafts",
    "gapActionReport",
    "GAP 责任人闭环报告",
    "releaseEvidence: false",
    "签署草稿仅用于复核准备",
    "releaseGateSummary",
    "runtimeSummary",
    "fileStorageDriver: config.fileStorageDriver",
    "controlSummary"
  ].forEach((needle) => assertIncludes(systemRoutes, needle, "server/src/modules/system/system-routes.mjs"));
  assertNotIncludes(systemRoutes, "jwtSecret", "server/src/modules/system/system-routes.mjs");
  assertNotIncludes(systemRoutes, "defaultAdminPassword", "server/src/modules/system/system-routes.mjs");

  const systemApi = readText("src/api/system.js");
  assertIncludes(systemApi, "getSystemReadiness", "src/api/system.js");

  const apiHook = readText("src/hooks/query/useApiBackedOaSystem.js");
  [
    "systemApi.getSystemReadiness",
    "[\"systemReadiness\", systemApi.getSystemReadiness, { optionalForbidden: true }]",
    "loader.optionalForbidden"
  ].forEach((needle) => assertIncludes(apiHook, needle, "src/hooks/query/useApiBackedOaSystem.js"));

  const apiState = readText("src/services/apiState.js");
  [
    "normalizeSystemReadinessPayload",
    "nextState.systemReadiness",
    "apiState.systemReadiness"
  ].forEach((needle) => assertIncludes(apiState, needle, "src/services/apiState.js"));

  const localHook = readText("src/hooks/useOaSystem.js");
  [
    "systemReadiness",
    "closurePlan",
    "releaseCandidateReady",
    "releaseBlockerCount",
    "e2eIncluded",
    "artifactSummary",
    "当前为本地演示模式，未连接商业后端"
  ].forEach((needle) => assertIncludes(localHook, needle, "src/hooks/useOaSystem.js"));

  const auditFeature = readText("src/features/Audit.jsx");
  [
    "商用发布状态",
    "releaseGate.releaseReady",
    "closurePlan",
    "发布闭环清单",
    "knownGaps",
    "signoffDrafts",
    "hrDataReview",
    "latestEvidence",
    "证据模式",
    "候选证据",
    "releaseCandidateReady",
    "releaseBlockerCount",
    "E2E",
    "证据工件清单",
    "artifactSummary",
    "gapActionReport",
    "HR 数据审阅包",
    "最新商业证据",
    "目标环境画像",
    "责任闭环",
    "责任人闭环报告",
    "签署准备",
    "非发布证据",
    "dependencyRows",
    "controlColumns"
  ].forEach((needle) => assertIncludes(auditFeature, needle, "src/features/Audit.jsx"));

  const openapi = readText("server/src/openapi.mjs");
  [
    "\"/system/readiness\"",
    "SystemReadinessResponse",
    "closurePlan",
    "artifactSummary",
    "gapActionReport",
    "hrDataReview",
    "latestEvidence",
    "releaseCandidateReady",
    "releaseBlockerCount",
    "e2eIncluded",
    "signoffDrafts"
  ].forEach((needle) => assertIncludes(openapi, needle, "server/src/openapi.mjs"));

  const tests = readText("server/tests/app.test.mjs");
  [
    "system readiness API requires admin permission and redacts runtime secrets",
    "system readiness API rejects accounts without system admin permission",
    "readiness.closurePlan",
    "readiness.hrDataReview.releaseEvidence",
    "readiness.signoffDrafts.releaseEvidence",
    "readiness.gapActionReport.releaseEvidence",
    "readiness.latestEvidence.releaseEvidence",
    "readiness.latestEvidence.releaseCandidateReady",
    "readiness.latestEvidence.releaseBlockerCount",
    "readiness.latestEvidence.e2eIncluded",
    "readiness.latestEvidence.artifactSummary",
    "readiness.latestEvidence.evidenceMode",
    "/api/system/readiness"
  ].forEach((needle) => assertIncludes(tests, needle, "server/tests/app.test.mjs"));

  const systemReadinessTests = readText("server/tests/system-readiness.test.mjs");
  [
    "signoff draft readiness summarizes manifest files without leaking paths",
    "signoff draft readiness rejects absolute and traversal manifest file paths",
    "HR data review readiness summarizes safe package without leaking paths",
    "HR data review readiness flags unsafe manifest paths",
    "gap action report readiness summarizes owners without leaking evidence paths",
    "gap action report readiness returns missing summary when report is unavailable",
    "latest commercial evidence readiness summarizes target profile without leaking paths or secrets",
    "latest commercial evidence readiness marks local or failing evidence as non-release",
    "quick-diagnostic-evidence",
    "latest commercial evidence readiness returns missing summary when report is unavailable",
    "release closure plan maps open gaps to safe owner actions without leaking commands or paths",
    "buildReleaseClosurePlan",
    "artifactSummary.missingReleaseArtifactCount",
    "production-secrets-signoff",
    "Cloudflare 后端验证输出",
    "summary.releaseCandidateReady",
    "summary.releaseBlockerCount",
    "summary.e2eIncluded",
    "loadGapActionReport",
    "loadHrDataReview",
    "loadLatestCommercialEvidence",
    "loadSignoffDrafts",
    "doesNotMatch"
  ].forEach((needle) => assertIncludes(systemReadinessTests, needle, "server/tests/system-readiness.test.mjs"));

  const smoke = readText("scripts/commercial-smoke.mjs");
  [
    "/api/system/readiness",
    "System readiness database dependency is not green",
    "System readiness leaked a runtime secret",
    "System readiness leaked signoff, HR review, GAP report, or latest evidence private details",
    "hrDataReview",
    "gapActionReport",
    "latestEvidence",
    "releaseCandidateReady",
    "releaseBlockerCount",
    "e2eIncluded",
    "latest evidence mode",
    "signoffDrafts"
  ].forEach((needle) => assertIncludes(smoke, needle, "scripts/commercial-smoke.mjs"));

  const e2e = readText("tests/e2e/commercial-smoke.spec.js");
  [
    "商用发布状态",
    "HR审阅包",
    "HR 数据审阅包",
    "发布门禁",
    "责任闭环",
    "责任人闭环报告",
    "签署准备",
    "最新商业证据",
    "候选证据",
    "证据工件清单",
    "发布闭环清单",
    "目标环境画像",
    "非发布证据"
  ].forEach((needle) => assertIncludes(e2e, needle, "tests/e2e/commercial-smoke.spec.js"));

  const plan = readText("docs/COMMERCIALIZATION_PLAN.md");
  [
    "latest commercial evidence summary",
    "Target Profile classification",
    "latest evidence paths",
    "command output",
    "database URLs",
    "hostnames",
    "database names"
  ].forEach((needle) => assertIncludes(plan, needle, "docs/COMMERCIALIZATION_PLAN.md"));
}

function main() {
  checkPackageScripts();
  checkDeploymentArtifacts();
  checkLocalPostgresBootstrap();
  checkKnownGapRegister();
  checkCommercialEvidenceAutomation();
  checkCommercialReleaseGateAutomation();
  checkCommercialGapReportAutomation();
  checkProductionEnvValidation();
  checkProductionEnvPreparation();
  checkSecretsSignoffValidation();
  checkHrDataSignoffValidation();
  checkHrDataReviewPreparation();
  checkStorageSignoffValidation();
  checkSignoffDraftGeneration();
  checkCommercialDrillEvidenceValidation();
  checkProductionSeedSafetyImplementation();
  checkMigrationInvariants();
  checkCommercialSmokeCoverage();
  checkAuthSessionRevocationImplementation();
  checkCsrfOriginGuardImplementation();
  checkIamUserRoleImplementation();
  checkAnalyticsImplementation();
  checkWorkflowTransferImplementation();
  checkApproverUserBindingImplementation();
  checkWorkflowSubmitIdempotencyImplementation();
  checkHrLifecycleWorkflowCoverage();
  checkDataImportImplementation();
  checkEmployeeMaintenanceImplementation();
  checkPermissionCatalogConsistency();
  checkAuthenticatedBusinessRouteIamCoverage();
  checkFileImplementation();
  checkReadinessFileStorageCoverage();
  checkFileBackupRestoreImplementation();
  checkBackupRetentionImplementation();
  checkAuditExportImplementation();
  checkExportRecordImplementation();
  checkApprovalExportImplementation();
  checkAssetExportImplementation();
  checkAssetQrImplementation();
  checkFinanceRequestImplementation();
  checkBoundedQueryLimitImplementation();
  checkAuthenticatedActorPropagationImplementation();
  checkAttendanceRecordsImplementation();
  checkResourceConflictAuditCoverage();
  checkTenantScopedLookupCoverage();
  checkPayrollCreationWorkflowGate();
  checkBrandBoundaryImplementation();
  checkSystemReadinessImplementation();
  console.log(JSON.stringify({
    ok: true,
    checked: [
      "package scripts",
      "Docker/deploy artifacts",
      "Docker-free local PostgreSQL bootstrap",
      "known commercial gap register",
      "commercial evidence package automation",
      "commercial readiness audit automation",
      "commercial release candidate automation",
      "commercial release dossier automation",
      "commercial release gate automation",
      "commercial gap action report automation",
      "commercial evidence permission audit",
      "production env file validation",
      "production env preparation package",
      "secrets signoff validation",
      "HR data signoff validation",
      "HR data review preparation package",
      "File storage signoff validation",
      "signoff draft generation",
      "commercial drill evidence validation",
      "file backup archive safety validation",
      "commercial env example",
      "production compose secret gates",
      "production seed safety guard",
      "commercial CI pipeline",
      "commercial Docker drill workflow",
      "commercial signoff validation workflow",
      "commercial OpenAPI contract",
      "commercial doctor diagnostics",
      "Cloudflare deployment status doctor",
      "Docker nginx body/proxy settings",
      "Docker web API-required build args",
      "deployable brand boundary check",
      "append-only audit migration",
      "tamper-evident audit hash chain",
      "finance and attendance persistence migration",
      "attendance records migration",
      "finance request ledger migration",
      "business workflow link migration",
      "data import lineage migration",
      "data import duplicate success constraint",
      "session revocation migration",
      "role permission policy migration",
      "export record ledger migration",
      "resource booking overlap migration",
      "workflow submission idempotency migration",
      "commercial smoke coverage",
      "auth session revocation",
      "auth cookie hardening",
      "auth rate-limit config validation",
      "API body limit alignment",
      "request size limit runtime validation",
      "CSRF origin guard with explicit proxy trust",
      "API security and trace headers",
      "IAM user lifecycle, role, status, and password controls",
      "frontend/backend IAM permission catalog consistency",
      "authenticated business route IAM coverage",
      "management analytics API",
      "backend generated analytics CSV export",
      "HR lifecycle workflow definitions",
      "HR lifecycle employee profile sync",
      "approval rule management CRUD",
      "approval rule preview and disabled fallback",
      "workflow transfer replacement task",
      "approval approver user binding",
      "workflow submit idempotency guard",
      "approval withdraw identity guard",
      "approver identity guard",
      "transactional approval lock coverage",
      "approval idempotency replay guard",
      "dashboard data import lineage API",
      "dashboard import rejection audit guard",
      "audited employee maintenance",
      "department-scoped employee data access",
      "backend generated people CSV export",
      "sensitive employee reveal guard",
      "failed login audit and rate limit",
      "bounded login failure store",
      "local file attachment API and frontend attachment center",
      "unsafe attachment upload guard",
      "unsafe attachment storage-key guard",
      "attachment checksum integrity guard",
      "file storage readiness guard",
      "file storage backup/restore coverage",
      "database restore checksum guard",
      "unified ops-audit redaction coverage",
      "backup retention prune coverage",
      "backend generated audit CSV export",
      "audit CSV formula injection guard",
      "structured export record ledger",
      "backend generated approval CSV export",
      "backend generated asset CSV export",
      "backend generated attendance CSV export",
      "backend generated finance request CSV export",
      "backend generated resource booking CSV export",
      "generated asset QR code",
      "finance request workflow ledger",
      "finance request workflow terminal status sync",
      "audit tenant/result query guard",
      "bounded query limit guard",
      "authenticated actor propagation",
      "attendance record persistence",
      "asset write validation guard",
      "resource conflict audit coverage",
      "resource cancellation release coverage",
      "tenant-scoped approval lookups",
      "payroll creation workflow gate",
      "production API fallback guard",
      "system commercial readiness panel",
      "backup/restore drill coverage"
    ]
  }, null, 2));
}

try {
  main();
} catch (error) {
  console.error(error.message);
  if (error.details) console.error(JSON.stringify(error.details, null, 2));
  process.exitCode = 1;
}
