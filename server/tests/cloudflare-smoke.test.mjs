import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeDeploymentUrl,
  parseCloudflareSmokeArgs,
  runCloudflareSmoke
} from "../../scripts/cloudflare-smoke.mjs";

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(payload)
  };
}

function mockFetch(routes) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    const result = routes[String(url)];
    if (result instanceof Error) throw result;
    return result || jsonResponse({ error: "not_found" }, 404);
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

test("cloudflare smoke args support deployment URL env and strict backend checks", () => {
  const args = parseCloudflareSmokeArgs(["--json", "--timeout-ms", "3000"], {
    CLOUDFLARE_DEPLOYMENT_URL: "https://deep-oa-hr.example.workers.dev",
    CLOUDFLARE_SMOKE_RETRIES: "5",
    CLOUDFLARE_SMOKE_RETRY_DELAY_MS: "100"
  });

  assert.equal(args.url, "https://deep-oa-hr.example.workers.dev");
  assert.equal(args.json, true);
  assert.equal(args.requireApiOrigin, true);
  assert.equal(args.retries, 5);
  assert.equal(args.retryDelayMs, 100);
  assert.equal(args.timeoutMs, 3000);
});

test("cloudflare deployment URL normalization rejects non-https production URLs", () => {
  assert.equal(
    normalizeDeploymentUrl("https://deep-oa-hr.example.workers.dev///"),
    "https://deep-oa-hr.example.workers.dev"
  );
  assert.throws(
    () => normalizeDeploymentUrl("http://127.0.0.1:8788"),
    /https outside local smoke mode/
  );
  assert.equal(
    normalizeDeploymentUrl("http://127.0.0.1:8788/", { allowLocal: true }),
    "http://127.0.0.1:8788"
  );
});

test("cloudflare smoke passes when edge health backend health and OpenAPI are reachable", async () => {
  const fetchImpl = mockFetch({
    "https://deep-oa-hr.example.workers.dev/api/edge/health": jsonResponse({
      apiOriginConfigured: true,
      ok: true,
      service: "deep-oa-cloudflare-edge"
    }),
    "https://deep-oa-hr.example.workers.dev/api/health": jsonResponse({
      ok: true,
      service: "deep-oa-api"
    }),
    "https://deep-oa-hr.example.workers.dev/api/openapi.json": jsonResponse({
      info: { title: "集团人事行政 OA Commercial API" },
      paths: { "/iam": {}, "/auth/login": {} }
    })
  });

  const report = await runCloudflareSmoke({
    fetchImpl,
    retryDelayMs: 1,
    url: "https://deep-oa-hr.example.workers.dev"
  });

  assert.equal(report.ok, true);
  assert.deepEqual(report.checks.map((check) => [check.name, check.level]), [
    ["edge-health", "pass"],
    ["backend-health", "pass"],
    ["openapi-contract", "pass"]
  ]);
  assert.equal(fetchImpl.calls.length, 3);
});

test("cloudflare smoke fails closed when API_ORIGIN is missing", async () => {
  const report = await runCloudflareSmoke({
    fetchImpl: mockFetch({
      "https://deep-oa-hr.example.workers.dev/api/edge/health": jsonResponse({
        apiOriginConfigured: false,
        ok: true,
        service: "deep-oa-cloudflare-edge"
      })
    }),
    retryDelayMs: 1,
    url: "https://deep-oa-hr.example.workers.dev"
  });

  assert.equal(report.ok, false);
  assert.equal(report.hardBlockers.some((check) => check.name === "edge-api-origin"), true);
  assert.equal(report.hardBlockers.some((check) => check.name === "backend-health"), true);
});

test("cloudflare smoke fails when backend proxy does not return the OA API", async () => {
  const report = await runCloudflareSmoke({
    fetchImpl: mockFetch({
      "https://deep-oa-hr.example.workers.dev/api/edge/health": jsonResponse({
        apiOriginConfigured: true,
        ok: true,
        service: "deep-oa-cloudflare-edge"
      }),
      "https://deep-oa-hr.example.workers.dev/api/health": jsonResponse({
        ok: true,
        service: "other-api"
      }),
      "https://deep-oa-hr.example.workers.dev/api/openapi.json": jsonResponse({
        info: { title: "Other API" },
        paths: {}
      })
    }),
    retryDelayMs: 1,
    url: "https://deep-oa-hr.example.workers.dev"
  });

  assert.equal(report.ok, false);
  assert.equal(report.hardBlockers.some((check) => check.name === "backend-health"), true);
  assert.equal(report.hardBlockers.some((check) => check.name === "openapi-contract"), true);
});
