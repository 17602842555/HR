import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  parseProductionEnvPrepArgs,
  prepareProductionEnv
} from "../../scripts/prepare-production-env.mjs";
import { parseProductionEnvText, validateProductionEnv } from "../../scripts/validate-production-env.mjs";

function modeOf(stats) {
  return stats.mode & 0o777;
}

test("production env prep writes a no-plaintext local storage package", async () => {
  const dir = await mkdtemp(join(tmpdir(), "oa-prod-env-prep-"));

  try {
    const result = prepareProductionEnv({
      rootDir: process.cwd(),
      outputDir: dir,
      now: new Date("2026-05-30T12:34:56.000Z")
    });

    const envTemplate = await readFile(result.files.envTemplate, "utf8");
    const checklist = JSON.parse(await readFile(result.files.checklist, "utf8"));
    const manifest = JSON.parse(await readFile(result.files.manifest, "utf8"));
    const readme = await readFile(result.files.readme, "utf8");
    const latestManifest = join(dir, "latest-manifest.json");

    assert.equal(envTemplate.includes("pg_2026_real_random_value"), false);
    assert.equal(envTemplate.includes("jwt_2026_real_random_value"), false);
    assert.match(envTemplate, /^POSTGRES_PASSWORD=$/m);
    assert.match(envTemplate, /^JWT_SECRET=$/m);
    assert.match(envTemplate, /^WEB_ORIGIN=$/m);
    assert.match(envTemplate, /^FILE_STORAGE_DRIVER=local$/m);
    assert.match(envTemplate, /^BACKUP_DIR=$/m);
    assert.match(envTemplate, /^FILE_STORAGE_DIR=$/m);
    assert.match(envTemplate, /^FILE_BACKUP_DIR=$/m);
    assert.match(envTemplate, /^CLOUDFLARE_ACCOUNT_ID=$/m);
    assert.match(envTemplate, /^CLOUDFLARE_API_TOKEN=$/m);
    assert.match(envTemplate, /^CLOUDFLARE_TUNNEL_TOKEN=$/m);
    assert.match(envTemplate, /^API_ORIGIN=$/m);
    assert.match(envTemplate, /^CLOUDFLARE_DEPLOYMENT_URL=$/m);
    assert.match(envTemplate, /^CLOUDFLARE_BACKEND_WEB_ORIGIN=$/m);

    assert.equal(checklist.noPlaintextSecretValues, true);
    assert.deepEqual(checklist.managedSecrets.map((item) => item.key), [
      "POSTGRES_PASSWORD",
      "JWT_SECRET",
      "CLOUDFLARE_API_TOKEN"
    ]);
    assert.equal(checklist.conditionalSecrets[0].key, "DEFAULT_ADMIN_PASSWORD");
    assert.equal(checklist.cloudflareRepositorySecrets.find((item) => item.key === "API_ORIGIN").requiredForNativeWorkerDeploy, false);
    assert.equal(checklist.cloudflareRepositorySecrets.find((item) => item.key === "CLOUDFLARE_TUNNEL_TOKEN").requiredForTunnelDeploy, true);
    assert.equal(checklist.cloudflareRepositorySecrets.find((item) => item.key === "CLOUDFLARE_API_TOKEN").neverPrintValue, true);
    assert.equal(checklist.nextCommands.some((command) => command.includes("validate:cloudflare-backend")), true);
    assert.equal(checklist.nextCommands.some((command) => command.includes("configure:cloudflare")), true);
    assert.equal(checklist.nextCommands.some((command) => command.includes("Optional future tunnel mode only")), true);
    assert.equal(checklist.nextCommands.some((command) => command.includes("validate:secrets-signoff")), true);

    assert.equal(manifest.kind, "production-env-preparation");
    assert.equal(manifest.noPlaintextSecretValues, true);
    assert.equal(manifest.storageDriver, "local");
    assert.equal(manifest.templateValidationSummary.ok, false);
    assert.equal(manifest.templateValidationSummary.expectedToFailUntilFilled, true);
    assert.equal(manifest.cloudflareBackendValidationSummary.ok, false);
    assert.equal(manifest.cloudflareBackendValidationSummary.expectedToFailUntilFilled, true);
    assert.equal(manifest.requiredEnvKeys.includes("POSTGRES_PASSWORD"), true);
    assert.equal(manifest.requiredEnvKeys.includes("BACKUP_DIR"), true);
    assert.equal(manifest.files.envTemplate.endsWith(".env.production.template"), true);
    assert.match(readme, /not release evidence/i);
    assert.match(readme, /validate:cloudflare-backend/);
    assert.match(readme, /configure:cloudflare/);
    assert.match(readme, /native Worker\/D1 release path does not require `API_ORIGIN`/);

    const validation = validateProductionEnv(parseProductionEnvText(envTemplate));
    assert.equal(validation.ok, false);
    assert(validation.errors.some((error) => error.includes("POSTGRES_PASSWORD")));
    assert(validation.errors.some((error) => error.includes("WEB_ORIGIN")));
    assert.equal(modeOf(await stat(dir)), 0o700);
    assert.equal(modeOf(await stat(result.outputDir)), 0o700);
    assert.equal(modeOf(await stat(result.files.envTemplate)), 0o600);
    assert.equal(modeOf(await stat(result.files.manifest)), 0o600);
    assert.equal(modeOf(await stat(latestManifest)), 0o600);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("production env prep includes object storage managed secret checklist for s3", async () => {
  const dir = await mkdtemp(join(tmpdir(), "oa-prod-env-prep-s3-"));

  try {
    const result = prepareProductionEnv({
      rootDir: process.cwd(),
      outputDir: dir,
      storageDriver: "s3",
      now: new Date("2026-05-30T12:34:56.000Z")
    });

    const envTemplate = await readFile(result.files.envTemplate, "utf8");
    const checklist = JSON.parse(await readFile(result.files.checklist, "utf8"));
    const manifest = JSON.parse(await readFile(result.files.manifest, "utf8"));
    const managedKeys = checklist.managedSecrets.map((item) => item.key);

    assert.match(envTemplate, /^FILE_STORAGE_DRIVER=s3$/m);
    assert.match(envTemplate, /^OBJECT_STORAGE_ENDPOINT=$/m);
    assert.match(envTemplate, /^OBJECT_STORAGE_ACCESS_KEY_ID=$/m);
    assert.match(envTemplate, /^OBJECT_STORAGE_SECRET_ACCESS_KEY=$/m);
    assert.equal(managedKeys.includes("OBJECT_STORAGE_ACCESS_KEY_ID"), true);
    assert.equal(managedKeys.includes("OBJECT_STORAGE_SECRET_ACCESS_KEY"), true);
    assert.equal(manifest.storageDriver, "s3");
    assert.equal(manifest.nextCommands.some((command) => command.includes("evidence:commercial")), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("production env prep parser reads output env storage driver and json flags", () => {
  const parsed = parseProductionEnvPrepArgs([
    "--output",
    "reports/prep",
    "--env",
    "release/.env.production",
    "--storage-driver",
    "s3",
    "--json"
  ]);

  assert.equal(parsed.outputDir, "reports/prep");
  assert.equal(parsed.targetEnvPath, "release/.env.production");
  assert.equal(parsed.storageDriver, "s3");
  assert.equal(parsed.json, true);
});
