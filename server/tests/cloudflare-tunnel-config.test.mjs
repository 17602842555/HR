import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyCloudflareTunnelIngressPlan,
  buildCloudflareTunnelIngressPlan,
  parseCloudflareTunnelConfigArgs,
  readCloudflareTunnelConfigurationRaw,
  runCloudflareTunnelConfig
} from "../../scripts/configure-cloudflare-tunnel.mjs";

const validInput = Object.freeze({
  accountId: "0123456789abcdef0123456789abcdef",
  apiOrigin: "https://api.oa.example.cn",
  apiToken: "cf-tunnel-write-token-for-tests-20260530",
  backendService: "http://api:8787",
  tunnel: "399ce110-a343-43b5-81cd-333f5f86212c"
});

test("cloudflare tunnel config parser supports env api origin backend service apply and json flags", () => {
  assert.deepEqual(
    parseCloudflareTunnelConfigArgs([
      "--env",
      ".env.production",
      "--tunnel",
      validInput.tunnel,
      "--account-id",
      validInput.accountId,
      "--api-origin",
      validInput.apiOrigin,
      "--backend-service",
      validInput.backendService,
      "--timeout-ms",
      "5000",
      "--apply",
      "--json"
    ], {}),
    {
      accountId: validInput.accountId,
      apiOrigin: validInput.apiOrigin,
      apiToken: "",
      apply: true,
      backendService: validInput.backendService,
      envPath: ".env.production",
      json: true,
      timeoutMs: 5000,
      tunnel: validInput.tunnel
    }
  );
  assert.throws(() => parseCloudflareTunnelConfigArgs(["--bad"], {}), /Unknown Cloudflare Tunnel configuration argument/);
});

test("cloudflare tunnel config plan upserts API hostname preserves other routes and adds catch all", () => {
  const plan = buildCloudflareTunnelIngressPlan({
    ...validInput,
    apply: true,
    currentInspected: true,
    currentIngress: [
      { hostname: "old.oa.example.cn", service: "http://legacy:8080" },
      { hostname: "api.oa.example.cn", service: "http://wrong:8787" },
      { service: "http_status:404" }
    ]
  });

  assert.equal(plan.ok, true);
  assert.deepEqual(plan.desiredConfig.config.ingress, [
    { hostname: "api.oa.example.cn", service: "http://api:8787" },
    { hostname: "old.oa.example.cn", service: "http://legacy:8080" },
    { service: "http_status:404" }
  ]);
  assert.equal(plan.summary.preservedIngressCount, 1);
  assert.equal(JSON.stringify(plan).includes(validInput.apiToken), false);
  assert.equal(JSON.stringify(plan).includes(validInput.accountId), false);
});

test("cloudflare tunnel config plan refuses unsafe placeholders and apply without inspected config", () => {
  const plan = buildCloudflareTunnelIngressPlan({
    accountId: "bad-account",
    apiOrigin: "https://api.example.com",
    apiToken: "placeholder-token-that-is-long-enough",
    apply: true,
    backendService: "http://api:8787",
    currentInspected: false,
    tunnel: ""
  });

  assert.equal(plan.ok, false);
  assert(plan.errors.some((error) => error.includes("API_ORIGIN")));
  assert(plan.errors.some((error) => error.includes("CLOUDFLARE_ACCOUNT_ID")));
  assert(plan.errors.some((error) => error.includes("tunnel UUID")));
  assert(plan.errors.some((error) => error.includes("CLOUDFLARE_API_TOKEN")));
  assert(plan.errors.some((error) => error.includes("Existing Tunnel configuration")));
});

test("cloudflare tunnel config dry run can produce a minimal plan without Cloudflare credentials", () => {
  const plan = buildCloudflareTunnelIngressPlan({
    apiOrigin: validInput.apiOrigin,
    backendService: validInput.backendService
  });

  assert.equal(plan.ok, true);
  assert.equal(plan.apply, false);
  assert.deepEqual(plan.desiredConfig.config.ingress, [
    { hostname: "api.oa.example.cn", service: "http://api:8787" },
    { service: "http_status:404" }
  ]);
  assert(plan.warnings.some((warning) => warning.includes("Dry run did not inspect")));
});

test("cloudflare tunnel config reads existing configuration without leaking token", async () => {
  const result = await readCloudflareTunnelConfigurationRaw({
    ...validInput,
    fetchImpl: async (url, options) => {
      assert.equal(
        url,
        `https://api.cloudflare.com/client/v4/accounts/${validInput.accountId}/cfd_tunnel/${validInput.tunnel}/configurations`
      );
      assert.equal(options.method, "GET");
      assert.equal(options.headers.Authorization, `Bearer ${validInput.apiToken}`);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          result: {
            config: {
              ingress: [
                { hostname: "api.oa.example.cn", service: "http://api:8787" },
                { service: "http_status:404" }
              ]
            }
          }
        })
      };
    }
  });

  assert.equal(result.checked, true);
  assert.equal(result.config.ingress.length, 2);
  assert.equal(JSON.stringify(result).includes(validInput.apiToken), false);
});

test("cloudflare tunnel config read fails closed and sanitizes token errors", async () => {
  const result = await readCloudflareTunnelConfigurationRaw({
    ...validInput,
    fetchImpl: async () => ({
      ok: false,
      status: 403,
      json: async () => ({
        success: false,
        errors: [{ message: `Bearer ${validInput.apiToken} token=${validInput.apiToken} password=123` }]
      })
    })
  });

  assert.equal(result.checked, false);
  assert.equal(result.config, null);
  assert.equal(JSON.stringify(result).includes(validInput.apiToken), false);
  assert.equal(JSON.stringify(result).includes("123"), false);
  assert.match(result.errors[0], /Bearer \[REDACTED\]/);
  assert.match(result.errors[0], /token=\[REDACTED\]/);
});

test("cloudflare tunnel config apply sends PUT body without leaking token into report", async () => {
  const plan = buildCloudflareTunnelIngressPlan({
    ...validInput,
    apply: true,
    currentInspected: true,
    currentIngress: []
  });
  const result = await applyCloudflareTunnelIngressPlan(plan, {
    ...validInput,
    fetchImpl: async (url, options) => {
      assert.equal(
        url,
        `https://api.cloudflare.com/client/v4/accounts/${validInput.accountId}/cfd_tunnel/${validInput.tunnel}/configurations`
      );
      assert.equal(options.method, "PUT");
      assert.equal(options.headers.Authorization, `Bearer ${validInput.apiToken}`);
      assert.deepEqual(JSON.parse(options.body), plan.desiredConfig);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          result: plan.desiredConfig
        })
      };
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.applied, true);
  assert.equal(result.summary.ingressCount, 2);
  assert.equal(JSON.stringify(result).includes(validInput.apiToken), false);
});

test("cloudflare tunnel config run reads env file, preserves existing config, and dry-runs by default", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oa-cloudflare-tunnel-config-"));
  const envPath = join(dir, ".env.production");
  try {
    writeFileSync(envPath, [
      `API_ORIGIN="${validInput.apiOrigin}"`,
      `CLOUDFLARE_ACCOUNT_ID="${validInput.accountId}"`,
      `CLOUDFLARE_API_TOKEN="${validInput.apiToken}"`,
      `CLOUDFLARE_TUNNEL_ID="${validInput.tunnel}"`
    ].join("\n"));
    const report = await runCloudflareTunnelConfig({
      envPath,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          result: {
            config: {
              ingress: [
                { hostname: "reports.oa.example.cn", service: "http://reports:8080" },
                { service: "http_status:404" }
              ]
            }
          }
        })
      }),
      runtimeEnv: {}
    });

    assert.equal(report.ok, true);
    assert.equal(report.apply, false);
    assert.equal(report.applyResult, null);
    assert.deepEqual(report.desiredConfig.config.ingress, [
      { hostname: "api.oa.example.cn", service: "http://api:8787" },
      { hostname: "reports.oa.example.cn", service: "http://reports:8080" },
      { service: "http_status:404" }
    ]);
    assert.equal(JSON.stringify(report).includes(validInput.apiToken), false);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});
