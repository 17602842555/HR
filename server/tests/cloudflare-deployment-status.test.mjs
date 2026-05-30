import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCloudflareDeploymentStatus,
  parseCloudflareDeploymentStatusArgs,
  readCloudflareTunnelConfigurationFromApi,
  readCloudflareTunnelInfo,
  readCloudflareTunnelInfoFromApi,
  readGithubSecretNames,
  requiredCloudflareGithubSecrets,
  runCloudflareDeploymentStatus
} from "../../scripts/cloudflare-deployment-status.mjs";

test("cloudflare deployment status parser supports repo tunnel url and json flags", () => {
  assert.deepEqual(
    parseCloudflareDeploymentStatusArgs([
      "--repo",
      "17602842555/HR",
      "--tunnel",
      "399ce110-a343-43b5-81cd-333f5f86212c",
      "--account-id",
      "0123456789abcdef0123456789abcdef",
      "--api-origin",
      "https://api.oa.example.cn",
      "--backend-service",
      "http://api:8787",
      "--url",
      "https://deep-oa-hr.example.workers.dev",
      "--allow-missing-api-origin",
      "--json"
    ]),
    {
      accountId: "0123456789abcdef0123456789abcdef",
      allowMissingApiOrigin: true,
      apiOrigin: "https://api.oa.example.cn",
      apiToken: "",
      backendService: "http://api:8787",
      json: true,
      repo: "17602842555/HR",
      retries: 2,
      retryDelayMs: 1000,
      timeoutMs: 8000,
      tunnel: "399ce110-a343-43b5-81cd-333f5f86212c",
      url: "https://deep-oa-hr.example.workers.dev"
    }
  );
  assert.throws(() => parseCloudflareDeploymentStatusArgs(["--bad"]), /Unknown cloudflare deployment status argument/);
});

test("cloudflare deployment status passes only when secrets tunnel and smoke are ready", () => {
  const report = buildCloudflareDeploymentStatus({
    apiOrigin: "https://api.oa.example.cn",
    secretNames: requiredCloudflareGithubSecrets,
    smokeReport: {
      hardBlockers: [],
      ok: true,
      url: "https://deep-oa-hr.example.workers.dev",
      warnings: []
    },
    tunnelRead: {
      checked: true,
      source: "cloudflare-api",
      tunnel: {
        configSource: "cloudflare",
        connsActiveAt: "2026-05-30T00:00:00Z",
        id: "399ce110-a343-43b5-81cd-333f5f86212c",
        name: "deep-oa-hr-api",
        status: "healthy"
      }
    },
    tunnelConfigRead: {
      checked: true,
      ingress: [
        { hostname: "api.oa.example.cn", service: "http://api:8787" },
        { hostname: "", service: "http_status:404" }
      ],
      source: "cloudflare-api"
    }
  });

  assert.equal(report.ok, true);
  assert.equal(report.summary.githubSecretsReady, true);
  assert.equal(report.summary.tunnelReady, true);
  assert.equal(report.summary.tunnelIngressReady, true);
  assert.equal(report.summary.cloudflareSmokeReady, true);
});

test("cloudflare deployment status reports current partial backend configuration blockers", () => {
  const report = buildCloudflareDeploymentStatus({
    secretNames: [
      "CLOUDFLARE_ACCOUNT_ID",
      "CLOUDFLARE_BACKEND_WEB_ORIGIN",
      "CLOUDFLARE_DEPLOYMENT_URL",
      "CLOUDFLARE_TUNNEL_TOKEN"
    ],
    smokeReport: {
      hardBlockers: [
        { name: "edge-api-origin", message: "API_ORIGIN is missing." },
        { name: "backend-health", message: "Backend checks skipped." }
      ],
      ok: false,
      url: "https://deep-oa-hr.2445776963.workers.dev",
      warnings: []
    },
    tunnelRead: {
      checked: true,
      tunnel: {
        id: "399ce110-a343-43b5-81cd-333f5f86212c",
        name: "deep-oa-hr-api",
        status: "inactive"
      }
    }
  });

  assert.equal(report.ok, false);
  assert(report.hardBlockers.some((check) => check.name === "github-secrets"));
  assert(report.hardBlockers.some((check) => check.name === "tunnel-status"));
  assert(report.hardBlockers.some((check) => check.name === "tunnel-ingress"));
  assert(report.hardBlockers.some((check) => check.name === "cloudflare-smoke"));
  assert.deepEqual(
    report.checks.find((check) => check.name === "github-secrets").details.missing,
    ["CLOUDFLARE_API_TOKEN", "API_ORIGIN"]
  );
  assert.equal(JSON.stringify(report).includes("eyJ"), false);
});

test("cloudflare deployment status requires API origin ingress mapping to backend service", () => {
  const missingIngress = buildCloudflareDeploymentStatus({
    apiOrigin: "https://api.oa.example.cn",
    secretNames: requiredCloudflareGithubSecrets,
    smokeReport: { hardBlockers: [], ok: true, url: "https://oa.example.cn", warnings: [] },
    tunnelConfigRead: {
      checked: true,
      ingress: [
        { hostname: "wrong.oa.example.cn", service: "http://api:8787" },
        { hostname: "", service: "http_status:404" }
      ],
      source: "cloudflare-api"
    },
    tunnelRead: {
      checked: true,
      source: "cloudflare-api",
      tunnel: { id: "399ce110-a343-43b5-81cd-333f5f86212c", name: "deep-oa-hr-api", status: "healthy" }
    }
  });
  const missingCheck = missingIngress.checks.find((check) => check.name === "tunnel-ingress");
  assert.equal(missingIngress.ok, false);
  assert.equal(missingCheck.level, "fail");
  assert.match(missingCheck.message, /does not map API_ORIGIN/);

  const missingCatchAll = buildCloudflareDeploymentStatus({
    apiOrigin: "https://api.oa.example.cn",
    secretNames: requiredCloudflareGithubSecrets,
    smokeReport: { hardBlockers: [], ok: true, url: "https://oa.example.cn", warnings: [] },
    tunnelConfigRead: {
      checked: true,
      ingress: [{ hostname: "api.oa.example.cn", service: "http://api:8787" }],
      source: "cloudflare-api"
    },
    tunnelRead: {
      checked: true,
      source: "cloudflare-api",
      tunnel: { id: "399ce110-a343-43b5-81cd-333f5f86212c", name: "deep-oa-hr-api", status: "healthy" }
    }
  });
  const catchAllCheck = missingCatchAll.checks.find((check) => check.name === "tunnel-ingress");
  assert.equal(missingCatchAll.ok, false);
  assert.equal(catchAllCheck.level, "fail");
  assert.match(catchAllCheck.message, /catch-all/);
});

test("cloudflare deployment status reads GitHub secret names without values", () => {
  const result = readGithubSecretNames({
    repo: "17602842555/HR",
    runner: (command, args) => {
      assert.equal(command, "gh");
      assert.deepEqual(args, ["secret", "list", "--repo", "17602842555/HR", "--json", "name"]);
      return {
        status: 0,
        stdout: JSON.stringify([{ name: "CLOUDFLARE_API_TOKEN" }, { name: "API_ORIGIN" }])
      };
    }
  });

  assert.deepEqual(result.names, ["API_ORIGIN", "CLOUDFLARE_API_TOKEN"]);
  assert.equal(result.checked, true);
});

test("cloudflare deployment status sanitizes CLI errors for JSON evidence", () => {
  const result = readCloudflareTunnelInfo({
    tunnel: "deep-oa-hr-api",
    runner: () => ({
      status: 1,
      stderr: "\u001B[31mERROR\u001B[0m token=super-secret Bearer abc.def.ghi password=123"
    })
  });

  assert.equal(result.checked, false);
  assert.equal(result.error.includes("\u001B["), false);
  assert.equal(result.error.includes("super-secret"), false);
  assert.equal(result.error.includes("abc.def.ghi"), false);
  assert.equal(result.error.includes("123"), false);
  assert.match(result.error, /token=\[REDACTED\]/);
  assert.match(result.error, /Bearer \[REDACTED\]/);
  assert.match(result.error, /password=\[REDACTED\]/);
});

test("cloudflare deployment status parses wrangler tunnel info output", () => {
  const result = readCloudflareTunnelInfo({
    tunnel: "deep-oa-hr-api",
    runner: (command, args) => {
      assert.equal(command, "npx");
      assert.deepEqual(args, ["wrangler", "tunnel", "info", "deep-oa-hr-api"]);
      return {
        status: 0,
        stdout: [
          "Tunnel Information:",
          "  ID: 399ce110-a343-43b5-81cd-333f5f86212c",
          "  Name: deep-oa-hr-api",
          "  Status: active",
          "  Type: cfd_tunnel"
        ].join("\n")
      };
    }
  });

  assert.equal(result.checked, true);
  assert.equal(result.tunnel.status, "active");
  assert.equal(result.tunnel.name, "deep-oa-hr-api");
});

test("cloudflare deployment status reads tunnel status through Cloudflare API without leaking token", async () => {
  const result = await readCloudflareTunnelInfoFromApi({
    accountId: "0123456789abcdef0123456789abcdef",
    apiToken: "secret-cloudflare-api-token",
    tunnel: "399ce110-a343-43b5-81cd-333f5f86212c",
    fetchImpl: async (url, options) => {
      assert.equal(
        url,
        "https://api.cloudflare.com/client/v4/accounts/0123456789abcdef0123456789abcdef/cfd_tunnel/399ce110-a343-43b5-81cd-333f5f86212c"
      );
      assert.equal(options.method, "GET");
      assert.equal(options.headers.Authorization, "Bearer secret-cloudflare-api-token");
      return {
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          result: {
            config_src: "cloudflare",
            conns_active_at: "2026-05-30T00:00:00Z",
            conns_inactive_at: null,
            created_at: "2026-05-29T00:00:00Z",
            id: "399ce110-a343-43b5-81cd-333f5f86212c",
            name: "deep-oa-hr-api",
            status: "healthy",
            tun_type: "cfd_tunnel"
          }
        })
      };
    }
  });

  assert.equal(result.checked, true);
  assert.equal(result.source, "cloudflare-api");
  assert.equal(result.tunnel.status, "healthy");
  assert.equal(result.tunnel.configSource, "cloudflare");
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes("secret-cloudflare-api-token"), false);
  assert.equal(serialized.includes("0123456789abcdef0123456789abcdef"), false);
});

test("cloudflare deployment status API tunnel read fails closed and sanitizes token errors", async () => {
  const result = await readCloudflareTunnelInfoFromApi({
    accountId: "0123456789abcdef0123456789abcdef",
    apiToken: "secret-cloudflare-api-token",
    tunnel: "399ce110-a343-43b5-81cd-333f5f86212c",
    fetchImpl: async () => ({
      ok: false,
      status: 403,
      json: async () => ({
        success: false,
        errors: [{ message: "Bearer secret-cloudflare-api-token token=secret-cloudflare-api-token password=123" }]
      })
    })
  });

  assert.equal(result.checked, false);
  assert.equal(result.source, "cloudflare-api");
  assert.equal(result.tunnel, null);
  assert.equal(result.error.includes("secret-cloudflare-api-token"), false);
  assert.equal(result.error.includes("123"), false);
  assert.match(result.error, /Bearer \[REDACTED\]/);
  assert.match(result.error, /token=\[REDACTED\]/);
  assert.match(result.error, /password=\[REDACTED\]/);
});

test("cloudflare deployment status reads tunnel configuration through Cloudflare API without leaking token", async () => {
  const result = await readCloudflareTunnelConfigurationFromApi({
    accountId: "0123456789abcdef0123456789abcdef",
    apiToken: "secret-cloudflare-api-token",
    tunnel: "399ce110-a343-43b5-81cd-333f5f86212c",
    fetchImpl: async (url, options) => {
      assert.equal(
        url,
        "https://api.cloudflare.com/client/v4/accounts/0123456789abcdef0123456789abcdef/cfd_tunnel/399ce110-a343-43b5-81cd-333f5f86212c/configurations"
      );
      assert.equal(options.method, "GET");
      assert.equal(options.headers.Authorization, "Bearer secret-cloudflare-api-token");
      return {
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          result: {
            account_id: "0123456789abcdef0123456789abcdef",
            config: {
              ingress: [
                { hostname: "API.OA.EXAMPLE.CN", service: "http://api:8787" },
                { service: "http_status:404" }
              ]
            }
          }
        })
      };
    }
  });

  assert.equal(result.checked, true);
  assert.equal(result.source, "cloudflare-api");
  assert.deepEqual(result.ingress, [
    { hostname: "api.oa.example.cn", path: "", service: "http://api:8787" },
    { hostname: "", path: "", service: "http_status:404" }
  ]);
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes("secret-cloudflare-api-token"), false);
  assert.equal(serialized.includes("0123456789abcdef0123456789abcdef"), false);
});

test("cloudflare deployment status API tunnel configuration read fails closed and sanitizes token errors", async () => {
  const result = await readCloudflareTunnelConfigurationFromApi({
    accountId: "0123456789abcdef0123456789abcdef",
    apiToken: "secret-cloudflare-api-token",
    tunnel: "399ce110-a343-43b5-81cd-333f5f86212c",
    fetchImpl: async () => ({
      ok: false,
      status: 403,
      json: async () => ({
        success: false,
        errors: [{ message: "Bearer secret-cloudflare-api-token token=secret-cloudflare-api-token password=123" }]
      })
    })
  });

  assert.equal(result.checked, false);
  assert.equal(result.source, "cloudflare-api");
  assert.deepEqual(result.ingress, []);
  assert.equal(result.error.includes("secret-cloudflare-api-token"), false);
  assert.equal(result.error.includes("123"), false);
  assert.match(result.error, /Bearer \[REDACTED\]/);
  assert.match(result.error, /token=\[REDACTED\]/);
  assert.match(result.error, /password=\[REDACTED\]/);
});

test("cloudflare deployment status uses API inspection when account id is provided but token is missing", async () => {
  let wranglerCalled = false;
  const report = await runCloudflareDeploymentStatus({
    accountId: "0123456789abcdef0123456789abcdef",
    apiOrigin: "https://api.oa.example.cn",
    apiToken: "",
    repo: "17602842555/HR",
    tunnel: "399ce110-a343-43b5-81cd-333f5f86212c",
    runner: (command) => {
      if (command === "npx") {
        wranglerCalled = true;
        return { status: 1, stderr: "wrangler should not be called" };
      }
      return {
        status: 0,
        stdout: JSON.stringify(requiredCloudflareGithubSecrets.map((name) => ({ name })))
      };
    }
  });

  const tunnelCheck = report.checks.find((check) => check.name === "tunnel-status");
  const ingressCheck = report.checks.find((check) => check.name === "tunnel-ingress");
  assert.equal(wranglerCalled, false);
  assert.equal(tunnelCheck.level, "fail");
  assert.match(tunnelCheck.details.error, /CLOUDFLARE_API_TOKEN is required/);
  assert.equal(ingressCheck.level, "fail");
  assert.match(ingressCheck.details.error, /CLOUDFLARE_API_TOKEN is required/);
});
