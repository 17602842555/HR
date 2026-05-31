import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  loadSecretsSignoff,
  managedSecretsForMode,
  parseSecretsSignoffArgs,
  requiredApprovalRoles,
  requiredManagedSecrets,
  requiredTunnelManagedSecrets,
  sha256Text,
  validateSecretsSignoff
} from "../../scripts/validate-secrets-signoff.mjs";
import { parseProductionEnvText } from "../../scripts/validate-production-env.mjs";

function validEnvText(overrides = {}) {
  const env = {
    APP_ENV: "production",
    NODE_ENV: "production",
    POSTGRES_DB: "oa_commercial",
    POSTGRES_USER: "oa",
    POSTGRES_PASSWORD: "pg_2026_real_random_value_32_chars",
    JWT_SECRET: "jwt_2026_real_random_value_at_least_32_chars",
    COOKIE_MAX_AGE_SECONDS: "28800",
    AUTH_FAILED_LOGIN_LIMIT: "5",
    AUTH_FAILED_LOGIN_WINDOW_MS: "600000",
    AUTH_FAILED_LOGIN_MAX_KEYS: "10000",
    FILE_STORAGE_DRIVER: "local",
    FILE_STORAGE_DIR: "/app/storage/files",
    BACKUP_DIR: "/backups/postgres",
    FILE_BACKUP_DIR: "/backups/files",
    FILE_MAX_UPLOAD_BYTES: "5242880",
    IMPORT_MAX_HTML_BYTES: "10485760",
    API_BODY_LIMIT_BYTES: "10551296",
    WEB_ORIGIN: "https://oa.company.test",
    TRUST_PROXY: "0",
    DEFAULT_ADMIN_PASSWORD: "",
    RUN_DB_SEED: "0",
    ALLOW_PRODUCTION_SEED: "0",
    VITE_REQUIRE_API: "1",
    VITE_DEMO_FALLBACK: "0",
    ...overrides
  };
  return Object.entries(env).map(([key, value]) => `${key}=${value}`).join("\n");
}

function validSecretsSignoff(overrides = {}, envText = validEnvText()) {
  return {
    schemaVersion: 1,
    documentId: "PROD-SECRETS-SIGNOFF-20260530",
    environment: "production",
    signedAt: "2026-05-30T12:00:00.000Z",
    environmentFile: {
      path: ".env.production",
      sha256: sha256Text(envText),
      validatedWith: "npm run validate:production-env -- .env.production --json"
    },
    secretStore: {
      provider: "Company Secret Manager",
      namespace: "oa/production",
      managedSecrets: ["POSTGRES_PASSWORD", "JWT_SECRET", "CLOUDFLARE_API_TOKEN"],
      injectedAtRuntime: true,
      noPlaintextInRepo: true,
      accessRestricted: true,
      rotationOwner: "Security Platform Team",
      lastRotatedAt: "2026-05-30T10:00:00.000Z",
      nextRotationDueAt: "2026-08-30T10:00:00.000Z",
      rotationRunbook: "Security runbook SEC-OA-SECRET-ROTATION",
      emergencyRollback: "Use previous managed secret version after incident approval."
    },
    originPolicy: {
      approvedOrigins: ["https://oa.company.test"],
      httpsOnly: true,
      noWildcard: true,
      owner: "Security Platform Team"
    },
    bootstrapSeedPolicy: {
      runDbSeed: false,
      defaultAdminPasswordManaged: false,
      approvalReference: "No production seed for this release."
    },
    approvals: [
      {
        role: "Security owner",
        name: "Security Owner",
        email: "security.owner@company.test",
        decision: "approved",
        approvedAt: "2026-05-30T13:00:00.000Z"
      },
      {
        role: "Deployment owner",
        name: "Deployment Owner",
        email: "deployment.owner@company.test",
        decision: "approved",
        approvedAt: "2026-05-30T13:05:00.000Z"
      }
    ],
    openExceptions: [],
    ...overrides
  };
}

test("secrets signoff validator accepts reviewed secret store and origin evidence", () => {
  const envText = validEnvText();
  const result = validateSecretsSignoff(validSecretsSignoff({}, envText), {
    env: parseProductionEnvText(envText),
    envChecksum: sha256Text(envText),
    envPath: ".env.production"
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
  assert.equal(result.summary.productionEnvValidated, true);
  assert.equal(result.summary.backendMode, "native-worker");
  assert.deepEqual(result.summary.approvedOrigins, ["https://oa.company.test"]);
  assert.deepEqual(requiredManagedSecrets, ["POSTGRES_PASSWORD", "JWT_SECRET", "CLOUDFLARE_API_TOKEN"]);
  assert.deepEqual(requiredTunnelManagedSecrets, ["POSTGRES_PASSWORD", "JWT_SECRET", "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_TUNNEL_TOKEN"]);
  assert.deepEqual(managedSecretsForMode("tunnel"), requiredTunnelManagedSecrets);
  assert.deepEqual(requiredApprovalRoles, ["Security owner", "Deployment owner"]);
});

test("secrets signoff validator requires tunnel token only in tunnel mode", () => {
  const envText = validEnvText({ CLOUDFLARE_BACKEND_MODE: "tunnel" });
  const result = validateSecretsSignoff(validSecretsSignoff({}, envText), {
    env: parseProductionEnvText(envText),
    envChecksum: sha256Text(envText),
    envPath: ".env.production"
  });

  assert.equal(result.ok, false);
  assert.equal(result.summary.backendMode, "tunnel");
  assert(result.errors.some((error) => error.includes("CLOUDFLARE_TUNNEL_TOKEN")));

  const accepted = validateSecretsSignoff(validSecretsSignoff({
    secretStore: {
      ...validSecretsSignoff({}, envText).secretStore,
      managedSecrets: requiredTunnelManagedSecrets
    }
  }, envText), {
    env: parseProductionEnvText(envText),
    envChecksum: sha256Text(envText),
    envPath: ".env.production"
  });
  assert.equal(accepted.ok, true);
});

test("secrets signoff validator rejects example release evidence and production exceptions", () => {
  const envText = validEnvText();
  const result = validateSecretsSignoff(validSecretsSignoff({
    example: true,
    documentId: "PROD-SECRETS-EXAMPLE",
    openExceptions: [{ owner: "TODO", exitCriteria: "TODO" }]
  }, envText), {
    env: parseProductionEnvText(envText),
    envChecksum: sha256Text(envText),
    envPath: ".env.production"
  });

  assert.equal(result.ok, false);
  assert(result.errors.some((error) => error.includes("Example secrets signoff")));
  assert(result.errors.some((error) => error.includes("documentId")));
  assert(result.errors.some((error) => error.includes("production secrets signoff")));
});

test("secrets signoff validator rejects invalid env checksum origin and secret store controls", () => {
  const envText = validEnvText();
  const result = validateSecretsSignoff(validSecretsSignoff({
    environmentFile: {
      path: ".env.production",
      sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      validatedWith: "manual review"
    },
    secretStore: {
      provider: "Company Secret Manager",
      namespace: "oa/production",
      managedSecrets: ["POSTGRES_PASSWORD", "CLOUDFLARE_API_TOKEN"],
      injectedAtRuntime: false,
      noPlaintextInRepo: false,
      accessRestricted: false,
      rotationOwner: "Security Platform Team",
      lastRotatedAt: "2026-05-30T10:00:00.000Z",
      nextRotationDueAt: "2026-05-29T10:00:00.000Z",
      rotationRunbook: "Security runbook",
      emergencyRollback: "Managed secret rollback"
    },
    originPolicy: {
      approvedOrigins: ["http://oa.company.test"],
      httpsOnly: false,
      noWildcard: false,
      owner: "Security Platform Team"
    }
  }, envText), {
    env: parseProductionEnvText(envText),
    envChecksum: sha256Text(envText),
    envPath: ".env.production"
  });

  assert.equal(result.ok, false);
  assert(result.errors.some((error) => error.includes("sha256 does not match")));
  assert(result.errors.some((error) => error.includes("validatedWith")));
  assert(result.errors.some((error) => error.includes("injectedAtRuntime")));
  assert(result.errors.some((error) => error.includes("noPlaintextInRepo")));
  assert(result.errors.some((error) => error.includes("accessRestricted")));
  assert(result.errors.some((error) => error.includes("nextRotationDueAt")));
  assert(result.errors.some((error) => error.includes("JWT_SECRET")));
  assert(result.errors.some((error) => error.includes("approvedOrigins must match")));
  assert(result.errors.some((error) => error.includes("approvedOrigins must use https")));
});

test("secrets signoff validator rejects plaintext secret fields and missing seed secret", () => {
  const envText = validEnvText({
    RUN_DB_SEED: "1",
    ALLOW_PRODUCTION_SEED: "1",
    DEFAULT_ADMIN_PASSWORD: "BootstrapPass2026!"
  });
  const result = validateSecretsSignoff(validSecretsSignoff({
    secretValues: {
      JWT_SECRET: "should-not-be-here"
    },
    cloudflareApiToken: "cf-token-should-not-be-here",
    bootstrapSeedPolicy: {
      runDbSeed: true,
      defaultAdminPasswordManaged: false,
      approvalReference: "SEC-BOOTSTRAP-20260530"
    }
  }, envText), {
    env: parseProductionEnvText(envText),
    envChecksum: sha256Text(envText),
    envPath: ".env.production"
  });

  assert.equal(result.ok, false);
  assert(result.errors.some((error) => error.includes("plaintext secret fields")));
  assert(result.errors.some((error) => error.includes("DEFAULT_ADMIN_PASSWORD")));
  assert(result.errors.some((error) => error.includes("defaultAdminPasswordManaged")));
});

test("secrets signoff example validates only when example mode is allowed without env file", () => {
  const example = loadSecretsSignoff(new URL("../../docs/production-secrets-signoff.example.json", import.meta.url));

  const rejected = validateSecretsSignoff(example);
  assert.equal(rejected.ok, false);
  assert(rejected.errors.some((error) => error.includes("Example secrets signoff")));

  const accepted = validateSecretsSignoff(example, { allowExample: true });
  assert.equal(accepted.ok, true);
  assert.equal(accepted.summary.secretProvider, "Company Secret Manager");
});

test("secrets signoff CLI parser reads path env and output flags", async () => {
  const dir = await mkdtemp(join(tmpdir(), "oa-secrets-signoff-"));
  try {
    const envPath = join(dir, ".env.production");
    const signoffPath = join(dir, "production-secrets-signoff.json");
    const envText = validEnvText();
    await writeFile(envPath, envText);
    await writeFile(signoffPath, JSON.stringify(validSecretsSignoff({}, envText), null, 2));

    const parsed = parseSecretsSignoffArgs([signoffPath, "--env", envPath, "--mode", "native-worker", "--allow-example", "--json"]);
    assert.equal(parsed.signoffPath, signoffPath);
    assert.equal(parsed.envPath, envPath);
    assert.equal(parsed.allowExample, true);
    assert.equal(parsed.json, true);
    assert.equal(parsed.mode, "native-worker");

    const loaded = JSON.parse(await readFile(signoffPath, "utf8"));
    assert.equal(validateSecretsSignoff(loaded, {
      env: parseProductionEnvText(envText),
      envChecksum: sha256Text(envText),
      envPath
    }).ok, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
