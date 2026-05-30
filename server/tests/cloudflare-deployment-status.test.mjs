import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCloudflareDeploymentStatus,
  parseCloudflareDeploymentStatusArgs,
  readCloudflareTunnelInfo,
  readGithubSecretNames,
  requiredCloudflareGithubSecrets
} from "../../scripts/cloudflare-deployment-status.mjs";

test("cloudflare deployment status parser supports repo tunnel url and json flags", () => {
  assert.deepEqual(
    parseCloudflareDeploymentStatusArgs([
      "--repo",
      "17602842555/HR",
      "--tunnel",
      "399ce110-a343-43b5-81cd-333f5f86212c",
      "--url",
      "https://deep-oa-hr.example.workers.dev",
      "--allow-missing-api-origin",
      "--json"
    ]),
    {
      allowMissingApiOrigin: true,
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
    secretNames: requiredCloudflareGithubSecrets,
    smokeReport: {
      hardBlockers: [],
      ok: true,
      url: "https://deep-oa-hr.example.workers.dev",
      warnings: []
    },
    tunnelRead: {
      checked: true,
      tunnel: {
        id: "399ce110-a343-43b5-81cd-333f5f86212c",
        name: "deep-oa-hr-api",
        status: "active"
      }
    }
  });

  assert.equal(report.ok, true);
  assert.equal(report.summary.githubSecretsReady, true);
  assert.equal(report.summary.tunnelReady, true);
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
  assert(report.hardBlockers.some((check) => check.name === "cloudflare-smoke"));
  assert.deepEqual(
    report.checks.find((check) => check.name === "github-secrets").details.missing,
    ["CLOUDFLARE_API_TOKEN", "API_ORIGIN"]
  );
  assert.equal(JSON.stringify(report).includes("eyJ"), false);
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
