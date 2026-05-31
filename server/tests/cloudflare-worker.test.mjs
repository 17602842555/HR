import test from "node:test";
import assert from "node:assert/strict";
import worker, { validateApiOrigin } from "../../cloudflare/worker.js";

async function responseJson(response) {
  return JSON.parse(await response.text());
}

test("cloudflare worker API origin validator accepts only safe HTTPS backend origins", () => {
  assert.equal(
    validateApiOrigin("https://api.oa.example.cn", "https://oa.example.cn/api/health").ok,
    true
  );

  assert.equal(
    validateApiOrigin("http://api.oa.example.cn", "https://oa.example.cn/api/health").code,
    "api_origin_invalid"
  );
  assert.equal(
    validateApiOrigin("https://127.0.0.1:8787", "https://oa.example.cn/api/health").code,
    "api_origin_unsafe"
  );
  assert.equal(
    validateApiOrigin("https://oa.example.cn", "https://oa.example.cn/api/health").code,
    "api_origin_loop"
  );
});

test("cloudflare worker reports invalid API origin without leaking backend value", async () => {
  const response = await worker.fetch(
    new Request("https://oa.example.cn/api/edge/health"),
    { API_ORIGIN: "https://127.0.0.1:8787" }
  );
  const text = await response.text();
  const payload = JSON.parse(text);

  assert.equal(response.status, 200);
  assert.equal(payload.apiOriginConfigured, true);
  assert.equal(payload.apiOriginValid, false);
  assert.equal(payload.apiOriginError, "api_origin_unsafe");
  assert.equal(text.includes("127.0.0.1"), false);
});

test("cloudflare worker rejects same-origin API proxy loops before fetching backend", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("backend fetch should not be called");
  };
  try {
    const response = await worker.fetch(
      new Request("https://oa.example.cn/api/health"),
      { API_ORIGIN: "https://oa.example.cn", OA_API_MODE: "proxy" }
    );
    const payload = await responseJson(response);

    assert.equal(response.status, 503);
    assert.equal(payload.error, "api_origin_loop");
    assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("cloudflare worker proxies valid backend origin with security headers", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ options, url: String(url) });
    return new Response(JSON.stringify({ ok: true, service: "deep-oa-api" }), {
      headers: { "content-type": "application/json" },
      status: 200
    });
  };
  try {
    const response = await worker.fetch(
      new Request("https://oa.example.cn/api/health?probe=1", {
        headers: { cookie: "oa_session=test" }
      }),
      { API_ORIGIN: "https://api.oa.example.cn", OA_API_MODE: "proxy" }
    );
    const payload = await responseJson(response);

    assert.equal(response.status, 200);
    assert.equal(payload.service, "deep-oa-api");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://api.oa.example.cn/api/health?probe=1");
    assert.equal(calls[0].options.headers.get("X-Forwarded-Host"), "oa.example.cn");
    assert.equal(calls[0].options.headers.get("X-Forwarded-Proto"), "https");
    assert.equal(calls[0].options.headers.get("X-Request-Source"), "cloudflare-worker");
    assert.equal(response.headers.get("X-Frame-Options"), "DENY");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("cloudflare worker serves native API without API_ORIGIN", async () => {
  const loginResponse = await worker.fetch(
    new Request("https://deep-oa-hr.example.workers.dev/api/auth/login", {
      body: JSON.stringify({ email: "admin@oa.local", password: "admin123456" }),
      headers: { "content-type": "application/json" },
      method: "POST"
    }),
    {}
  );
  const loginPayload = await responseJson(loginResponse);
  const cookie = loginResponse.headers.get("set-cookie");

  assert.equal(loginResponse.status, 200);
  assert.equal(loginPayload.user.email, undefined);
  assert.match(cookie, /oa_cf_session=admin/);

  const peopleResponse = await worker.fetch(
    new Request("https://deep-oa-hr.example.workers.dev/api/people", {
      headers: { cookie }
    }),
    {}
  );
  const peoplePayload = await responseJson(peopleResponse);

  assert.equal(peopleResponse.status, 200);
  assert.equal(peoplePayload.people.employees.length, 72);
  assert.equal(peoplePayload.people.leavers.length, 162);
  assert.equal(peoplePayload.people.femaleEmployees.length, 43);
  assert.equal(peoplePayload.people.monthLeavers.length, 4);
  assert.equal(peoplePayload.people.employees.some((employee) => String(employee.school || employee.hukou || employee.major || "").includes("***")), true);
});

test("cloudflare worker native approval decisions require every current approver before next node", async () => {
  const loginResponse = await worker.fetch(
    new Request("https://deep-oa-hr.example.workers.dev/api/auth/login", {
      body: JSON.stringify({ email: "admin@oa.local", password: "admin123456" }),
      headers: { "content-type": "application/json" },
      method: "POST"
    }),
    {}
  );
  const cookie = loginResponse.headers.get("set-cookie");
  const createdResponse = await worker.fetch(
    new Request("https://deep-oa-hr.example.workers.dev/api/approvals", {
      body: JSON.stringify({ definitionId: "expense", formData: { amount: "800" } }),
      headers: { "content-type": "application/json", cookie },
      method: "POST"
    }),
    {}
  );
  const createdPayload = await responseJson(createdResponse);
  const approval = createdPayload.approval;
  const firstNode = approval.approvalNodes[approval.currentNodeIndex];

  assert.equal(firstNode.decisions.length > 1, true);

  const firstDecisionResponse = await worker.fetch(
    new Request(`https://deep-oa-hr.example.workers.dev/api/approvals/${approval.id}/decision`, {
      body: JSON.stringify({ approverName: firstNode.decisions[0].approver, decision: "pass" }),
      headers: { "content-type": "application/json", cookie },
      method: "POST"
    }),
    {}
  );
  const firstDecisionPayload = await responseJson(firstDecisionResponse);
  assert.equal(firstDecisionPayload.approval.currentNodeIndex, approval.currentNodeIndex);
  assert.equal(firstDecisionPayload.approval.status, "待审批");

  const secondDecisionResponse = await worker.fetch(
    new Request(`https://deep-oa-hr.example.workers.dev/api/approvals/${approval.id}/decision`, {
      body: JSON.stringify({ approverName: firstNode.decisions[1].approver, decision: "pass" }),
      headers: { "content-type": "application/json", cookie },
      method: "POST"
    }),
    {}
  );
  const secondDecisionPayload = await responseJson(secondDecisionResponse);
  assert.equal(secondDecisionPayload.approval.currentNodeIndex, approval.currentNodeIndex + 1);
});
