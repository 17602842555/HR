import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyCloudflareSecretPlan,
  buildCloudflareSecretPlan,
  loadCloudflareSecretEnv,
  parseCloudflareSecretArgs,
  repoFromGitRemote
} from "../../scripts/configure-cloudflare-secrets.mjs";

const validEnv = Object.freeze({
  API_ORIGIN: "https://api.oa.example.cn",
  CLOUDFLARE_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
  CLOUDFLARE_API_TOKEN: "cf-workers-deploy-token-for-tests-20260530",
  CLOUDFLARE_DEPLOYMENT_URL: "https://oa.example.cn",
  CLOUDFLARE_TUNNEL_TOKEN: "eyJhIjoiY2xvdWRmbGFyZS10dW5uZWwtdG9rZW4tZm9yLXRlc3RzIn0",
  TRUST_PROXY: "1"
});

test("cloudflare secret parser supports env repo apply and json flags", () => {
  assert.deepEqual(parseCloudflareSecretArgs(["--env", ".env.production", "--repo", "17602842555/HR", "--apply", "--json"]), {
    apply: true,
    envPath: ".env.production",
    json: true,
    repo: "17602842555/HR"
  });
  assert.throws(() => parseCloudflareSecretArgs(["--bad"]), /Unknown cloudflare secret configuration argument/);
});

test("cloudflare secret repo parser supports GitHub remotes", () => {
  assert.equal(repoFromGitRemote("https://github.com/17602842555/HR.git"), "17602842555/HR");
  assert.equal(repoFromGitRemote("git@github.com:17602842555/HR.git"), "17602842555/HR");
  assert.equal(repoFromGitRemote("https://example.com/not-github/repo.git"), "");
});

test("cloudflare secret plan validates backend values and redacts secret material", () => {
  const plan = buildCloudflareSecretPlan({
    fileEnv: validEnv,
    repo: "17602842555/HR"
  });

  assert.equal(plan.ok, true);
  assert.equal(plan.repo, "17602842555/HR");
  assert.equal(plan.secrets.length, 6);
  assert.equal(plan.secrets.every((secret) => secret.configured), true);
  assert.equal(plan.secrets.find((secret) => secret.name === "CLOUDFLARE_BACKEND_WEB_ORIGIN").source, "computed");
  assert.equal(plan.backend.apiOriginConfigured, true);

  const serialized = JSON.stringify(plan);
  assert.equal(serialized.includes(validEnv.CLOUDFLARE_API_TOKEN), false);
  assert.equal(serialized.includes(validEnv.CLOUDFLARE_TUNNEL_TOKEN), false);
  assert.equal(serialized.includes(validEnv.CLOUDFLARE_ACCOUNT_ID), false);
});

test("cloudflare secret plan accepts runtime overrides without leaking values", () => {
  const plan = buildCloudflareSecretPlan({
    fileEnv: {
      ...validEnv,
      CLOUDFLARE_API_TOKEN: "placeholder",
      WEB_ORIGIN: "https://oa.example.cn"
    },
    repo: "17602842555/HR",
    runtimeEnv: {
      CLOUDFLARE_API_TOKEN: "cf-runtime-token-for-workers-deploy-tests"
    }
  });

  assert.equal(plan.ok, true);
  assert.equal(plan.secrets.find((secret) => secret.name === "CLOUDFLARE_API_TOKEN").source, "process.env");
  assert.equal(JSON.stringify(plan).includes("cf-runtime-token"), false);
});

test("cloudflare secret plan rejects unsafe production configuration", () => {
  const plan = buildCloudflareSecretPlan({
    fileEnv: {
      ...validEnv,
      API_ORIGIN: "https://oa.example.cn",
      CLOUDFLARE_ACCOUNT_ID: "bad-account",
      CLOUDFLARE_API_TOKEN: "todo"
    },
    repo: ""
  });

  assert.equal(plan.ok, false);
  assert.equal(plan.errors.some((error) => error.includes("GitHub repo")), true);
  assert.equal(plan.errors.some((error) => error.includes("not the same origin")), true);
  assert.equal(plan.errors.some((error) => error.includes("CLOUDFLARE_ACCOUNT_ID")), true);
  assert.equal(plan.errors.some((error) => error.includes("CLOUDFLARE_API_TOKEN")), true);
});

test("cloudflare secret plan rejects placeholder deploy token fragments", () => {
  const plan = buildCloudflareSecretPlan({
    fileEnv: {
      ...validEnv,
      CLOUDFLARE_API_TOKEN: "placeholder-cloudflare-workers-token-that-is-long-enough"
    },
    repo: "17602842555/HR"
  });

  assert.equal(plan.ok, false);
  assert.equal(plan.errors.some((error) => error.includes("CLOUDFLARE_API_TOKEN")), true);
});

test("cloudflare secret apply writes GitHub secrets through stdin", () => {
  const plan = buildCloudflareSecretPlan({
    fileEnv: validEnv,
    repo: "17602842555/HR"
  });
  const calls = [];
  const result = applyCloudflareSecretPlan(plan, {
    runner: (command, args, options) => {
      calls.push({ args, command, input: options.input });
      return { status: 0, stdout: "" };
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.applied.length, 6);
  assert.equal(calls.every((call) => call.command === "gh"), true);
  assert.equal(calls.every((call) => call.args[0] === "secret" && call.args[1] === "set"), true);
  assert.equal(calls.every((call) => call.args.includes("--repo") && call.args.includes("17602842555/HR")), true);
  assert.equal(calls.some((call) => call.input === validEnv.CLOUDFLARE_API_TOKEN), true);
  assert.equal(calls.some((call) => call.args.includes(validEnv.CLOUDFLARE_API_TOKEN)), false);
  assert.equal(calls.some((call) => call.args.includes(validEnv.CLOUDFLARE_TUNNEL_TOKEN)), false);
});

test("cloudflare secret apply refuses invalid plans", () => {
  const plan = buildCloudflareSecretPlan({
    fileEnv: {},
    repo: "17602842555/HR"
  });
  const result = applyCloudflareSecretPlan(plan, {
    runner: () => {
      throw new Error("runner should not be called");
    }
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.applied, []);
});

test("cloudflare secret env loader reads dotenv and reports missing files", () => {
  const dir = mkdtempSync(join(tmpdir(), "oa-cloudflare-secrets-"));
  const envPath = join(dir, ".env.production");
  try {
    writeFileSync(envPath, "CLOUDFLARE_ACCOUNT_ID=\"0123456789abcdef0123456789abcdef\"\n");
    assert.equal(loadCloudflareSecretEnv(envPath).env.CLOUDFLARE_ACCOUNT_ID, "0123456789abcdef0123456789abcdef");
    const missing = loadCloudflareSecretEnv(join(dir, "missing.env"));
    assert.deepEqual(missing.env, {});
    assert.equal(missing.warnings.length, 1);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});
