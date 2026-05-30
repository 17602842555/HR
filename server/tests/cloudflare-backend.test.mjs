import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseCloudflareBackendArgs,
  validateCloudflareBackendEnv,
  validateCloudflareBackendFile
} from "../../scripts/validate-cloudflare-backend.mjs";

const validEnv = Object.freeze({
  API_ORIGIN: "https://api.oa.example.cn",
  CLOUDFLARE_DEPLOYMENT_URL: "https://oa.example.cn",
  CLOUDFLARE_TUNNEL_TOKEN: "eyJhIjoiY2xvdWRmbGFyZS10dW5uZWwtdG9rZW4tZm9yLXRlc3RzIn0",
  DEFAULT_ADMIN_PASSWORD: "S3cure-admin-password-for-prod",
  RUN_DB_SEED: "1",
  TRUST_PROXY: "1",
  WEB_ORIGIN: "https://oa.example.cn"
});

test("cloudflare backend validator accepts tunnel origin deployment origin and web origin", () => {
  const report = validateCloudflareBackendEnv(validEnv);

  assert.equal(report.ok, true);
  assert.deepEqual(report.errors, []);
  assert.equal(report.summary.apiOriginConfigured, true);
  assert.equal(report.summary.deploymentUrlConfigured, true);
  assert.equal(report.summary.tunnelTokenConfigured, true);
});

test("cloudflare backend validator rejects missing token local origins and same-origin loops", () => {
  const report = validateCloudflareBackendEnv({
    API_ORIGIN: "https://oa.example.cn",
    CLOUDFLARE_DEPLOYMENT_URL: "https://oa.example.cn",
    CLOUDFLARE_TUNNEL_TOKEN: "",
    TRUST_PROXY: "0",
    WEB_ORIGIN: "https://wrong.example.cn"
  });

  assert.equal(report.ok, false);
  assert.equal(report.errors.some((error) => error.includes("CLOUDFLARE_TUNNEL_TOKEN")), true);
  assert.equal(report.errors.some((error) => error.includes("not the same origin")), true);
  assert.equal(report.errors.some((error) => error.includes("WEB_ORIGIN")), true);
  assert.equal(report.warnings.some((warning) => warning.includes("TRUST_PROXY=1")), true);
});

test("cloudflare backend validator rejects local non-https production URLs", () => {
  const report = validateCloudflareBackendEnv({
    ...validEnv,
    API_ORIGIN: "http://127.0.0.1:8787"
  });

  assert.equal(report.ok, false);
  assert.equal(report.errors.some((error) => error.includes("API_ORIGIN")), true);
});

test("cloudflare backend validator reads dotenv files", () => {
  const dir = mkdtempSync(join(tmpdir(), "oa-cloudflare-backend-"));
  const envPath = join(dir, ".env.production");
  try {
    writeFileSync(envPath, Object.entries(validEnv).map(([key, value]) => `${key}="${value}"`).join("\n"));
    const report = validateCloudflareBackendFile(envPath);
    assert.equal(report.ok, true);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("cloudflare backend validator CLI parser supports env and json flags", () => {
  assert.deepEqual(parseCloudflareBackendArgs(["--env", ".env.production.cloudflare", "--json"]), {
    envPath: ".env.production.cloudflare",
    json: true
  });
  assert.throws(() => parseCloudflareBackendArgs(["--bad"]), /Unknown cloudflare backend validation argument/);
});
