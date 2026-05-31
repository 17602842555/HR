import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import worker, { validateApiOrigin } from "../../cloudflare/worker.js";

const ADMIN_PASSWORD = "AdminBootstrapPass123";
const TEST_ENV = {
  CLOUDFLARE_BOOTSTRAP_ADMIN_FORCE_CHANGE: "0",
  CLOUDFLARE_BOOTSTRAP_ADMIN_PASSWORD: ADMIN_PASSWORD
};

async function responseJson(response) {
  return JSON.parse(await response.text());
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
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
      body: JSON.stringify({ email: "admin@oa.local", password: ADMIN_PASSWORD }),
      headers: { "content-type": "application/json" },
      method: "POST"
    }),
    TEST_ENV
  );
  const loginPayload = await responseJson(loginResponse);
  const cookie = loginResponse.headers.get("set-cookie");

  assert.equal(loginResponse.status, 200);
  assert.equal(loginPayload.user.email, "admin@oa.local");
  assert.match(cookie, /oa_cf_session=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
  assert.equal(cookie.includes("mock-user"), false);

  const forgedResponse = await worker.fetch(
    new Request("https://deep-oa-hr.example.workers.dev/api/people", {
      headers: { cookie: "oa_cf_session=mock-user" }
    }),
    TEST_ENV
  );
  assert.equal(forgedResponse.status, 401);

  const peopleResponse = await worker.fetch(
    new Request("https://deep-oa-hr.example.workers.dev/api/people", {
      headers: { cookie }
    }),
    TEST_ENV
  );
  const peoplePayload = await responseJson(peopleResponse);

  assert.equal(peopleResponse.status, 200);
  assert.equal(peoplePayload.people.employees.length, 72);
  assert.equal(peoplePayload.people.leavers.length, 162);
  assert.equal(peoplePayload.people.femaleEmployees.length, 43);
  assert.equal(peoplePayload.people.monthLeavers.length, 4);
  assert.equal(peoplePayload.people.employees.some((employee) => String(employee.school || employee.hukou || employee.major || "").includes("***")), true);

  const openapiResponse = await worker.fetch(
    new Request("https://deep-oa-hr.example.workers.dev/api/openapi.json"),
    TEST_ENV
  );
  const openapiPayload = await responseJson(openapiResponse);
  ["/auth/change-password", "/files/{id}/download", "/audit/integrity", "/iam/users/{id}/status", "/resources/bookings/{id}/cancel", "/workflows/definitions"]
    .forEach((path) => assert.ok(openapiPayload.paths[path], `Worker OpenAPI path missing: ${path}`));
});

test("cloudflare worker allows GitHub Pages frontend to call native API with credentials", async () => {
  const preflightResponse = await worker.fetch(
    new Request("https://deep-oa-hr.example.workers.dev/api/auth/login", {
      headers: {
        "Access-Control-Request-Headers": "content-type",
        Origin: "https://17602842555.github.io"
      },
      method: "OPTIONS"
    }),
    TEST_ENV
  );

  assert.equal(preflightResponse.status, 204);
  assert.equal(preflightResponse.headers.get("access-control-allow-origin"), "https://17602842555.github.io");
  assert.equal(preflightResponse.headers.get("access-control-allow-credentials"), "true");

  const loginResponse = await worker.fetch(
    new Request("https://deep-oa-hr.example.workers.dev/api/auth/login", {
      body: JSON.stringify({ email: "admin@oa.local", password: ADMIN_PASSWORD }),
      headers: {
        "content-type": "application/json",
        Origin: "https://17602842555.github.io"
      },
      method: "POST"
    }),
    TEST_ENV
  );
  const cookie = loginResponse.headers.get("set-cookie");

  assert.equal(loginResponse.status, 200);
  assert.equal(loginResponse.headers.get("access-control-allow-origin"), "https://17602842555.github.io");
  assert.equal(loginResponse.headers.get("access-control-allow-credentials"), "true");
  assert.match(cookie, /SameSite=None/);
  assert.match(cookie, /Secure/);

  const csrfDenied = await worker.fetch(
    new Request("https://deep-oa-hr.example.workers.dev/api/people/export", {
      headers: {
        cookie,
        Origin: "https://evil.example.test"
      },
      method: "POST"
    }),
    TEST_ENV
  );
  const csrfPayload = await responseJson(csrfDenied);
  assert.equal(csrfDenied.status, 403);
  assert.equal(csrfPayload.error, "csrf_origin_denied");
});

test("cloudflare worker IAM guards prevent admin lockout and revoke target sessions", async () => {
  const loginResponse = await worker.fetch(
    new Request("https://deep-oa-hr.example.workers.dev/api/auth/login", {
      body: JSON.stringify({ email: "admin@oa.local", password: ADMIN_PASSWORD }),
      headers: { "content-type": "application/json" },
      method: "POST"
    }),
    TEST_ENV
  );
  const cookie = loginResponse.headers.get("set-cookie");
  const iamResponse = await worker.fetch(
    new Request("https://deep-oa-hr.example.workers.dev/api/iam", { headers: { cookie } }),
    TEST_ENV
  );
  const iam = (await responseJson(iamResponse)).iam;
  const adminRole = iam.roles.find((role) => role.code === "admin");
  const adminUser = iam.users.find((user) => user.email === "admin@oa.local");

  const weakenAdminRole = await worker.fetch(
    new Request(`https://deep-oa-hr.example.workers.dev/api/iam/roles/${adminRole.id}/permissions`, {
      body: JSON.stringify({ permissionCodes: ["iam.read"] }),
      headers: { "content-type": "application/json", cookie },
      method: "PUT"
    }),
    TEST_ENV
  );
  assert.equal(weakenAdminRole.status, 400);

  const selfDisable = await worker.fetch(
    new Request(`https://deep-oa-hr.example.workers.dev/api/iam/users/${adminUser.id}/status`, {
      body: JSON.stringify({ status: "DISABLED" }),
      headers: { "content-type": "application/json", cookie },
      method: "PUT"
    }),
    TEST_ENV
  );
  assert.equal(selfDisable.status, 400);

  const createUser = await worker.fetch(
    new Request("https://deep-oa-hr.example.workers.dev/api/iam/users", {
      body: JSON.stringify({
        email: `session-revoke-${Date.now()}@oa.local`,
        name: "会话吊销员工",
        newPassword: "TempPass12345",
        roleCodes: ["employee-self-service"]
      }),
      headers: { "content-type": "application/json", cookie },
      method: "POST"
    }),
    TEST_ENV
  );
  const created = await responseJson(createUser);
  const employeeLogin = await worker.fetch(
    new Request("https://deep-oa-hr.example.workers.dev/api/auth/login", {
      body: JSON.stringify({ email: created.user.email, password: "TempPass12345" }),
      headers: { "content-type": "application/json" },
      method: "POST"
    }),
    TEST_ENV
  );
  const employeeCookie = employeeLogin.headers.get("set-cookie");
  const resetPassword = await worker.fetch(
    new Request(`https://deep-oa-hr.example.workers.dev/api/iam/users/${created.user.id}/password`, {
      body: JSON.stringify({ newPassword: "ResetPass12345" }),
      headers: { "content-type": "application/json", cookie },
      method: "PUT"
    }),
    TEST_ENV
  );
  assert.equal(resetPassword.status, 200);

  const oldSession = await worker.fetch(
    new Request("https://deep-oa-hr.example.workers.dev/api/auth/me", {
      headers: { cookie: employeeCookie }
    }),
    TEST_ENV
  );
  assert.equal(oldSession.status, 401);
});

test("cloudflare worker native exports require business reason and record trusted export metadata", async () => {
  const loginResponse = await worker.fetch(
    new Request("https://deep-oa-hr.example.workers.dev/api/auth/login", {
      body: JSON.stringify({ email: "admin@oa.local", password: ADMIN_PASSWORD }),
      headers: { "content-type": "application/json" },
      method: "POST"
    }),
    TEST_ENV
  );
  const cookie = loginResponse.headers.get("set-cookie");

  const missingReason = await worker.fetch(
    new Request("https://deep-oa-hr.example.workers.dev/api/people/export", {
      headers: { "content-type": "application/json", cookie },
      method: "POST"
    }),
    TEST_ENV
  );
  const missingPayload = await responseJson(missingReason);
  assert.equal(missingReason.status, 400);
  assert.match(missingPayload.message, /业务用途/);

  const exportResponse = await worker.fetch(
    new Request("https://deep-oa-hr.example.workers.dev/api/people/export", {
      body: JSON.stringify({
        businessReason: "人事月度核对",
        filters: { scope: "active" },
        scope: "在职员工"
      }),
      headers: { "content-type": "application/json", cookie },
      method: "POST"
    }),
    TEST_ENV
  );
  assert.equal(exportResponse.status, 200);
  assert.equal(exportResponse.headers.get("content-disposition"), 'attachment; filename="people-export.csv"');

  const recordsResponse = await worker.fetch(
    new Request("https://deep-oa-hr.example.workers.dev/api/audit/export-records", { headers: { cookie } }),
    TEST_ENV
  );
  const records = (await responseJson(recordsResponse)).exportRecords;
  const record = records.find((item) => item.fileName === "people-export.csv");
  assert.ok(record);
  assert.equal(record.businessReason, "人事月度核对");
  assert.equal(record.operator, "张三");
  assert.equal(record.rowCount, 72);
  assert.deepEqual(record.filters, { scope: "active" });
});

test("cloudflare worker audit integrity returns a real signed hash chain", async () => {
  const loginResponse = await worker.fetch(
    new Request("https://deep-oa-hr.example.workers.dev/api/auth/login", {
      body: JSON.stringify({ email: "admin@oa.local", password: ADMIN_PASSWORD }),
      headers: { "content-type": "application/json" },
      method: "POST"
    }),
    TEST_ENV
  );
  const cookie = loginResponse.headers.get("set-cookie");
  const integrityResponse = await worker.fetch(
    new Request("https://deep-oa-hr.example.workers.dev/api/audit/integrity", { headers: { cookie } }),
    TEST_ENV
  );
  const payload = await responseJson(integrityResponse);

  assert.equal(integrityResponse.status, 200);
  assert.equal(payload.auditIntegrity.ok, true);
  assert.match(payload.auditIntegrity.latestHash, /^[a-f0-9]{64}$/);
  assert.equal(payload.auditIntegrity.summary.signedRows > 0, true);
  assert.equal(payload.auditIntegrity.summary.unsignedRows, 0);
});

test("cloudflare worker file upload and download use real checksum guards", async () => {
  const loginResponse = await worker.fetch(
    new Request("https://deep-oa-hr.example.workers.dev/api/auth/login", {
      body: JSON.stringify({ email: "admin@oa.local", password: ADMIN_PASSWORD }),
      headers: { "content-type": "application/json" },
      method: "POST"
    }),
    TEST_ENV
  );
  const cookie = loginResponse.headers.get("set-cookie");
  const invalidUpload = await worker.fetch(
    new Request("https://deep-oa-hr.example.workers.dev/api/files", {
      body: JSON.stringify({ contentBase64: "not-valid-%%%base64", fileName: "bad.txt" }),
      headers: { "content-type": "application/json", cookie },
      method: "POST"
    }),
    TEST_ENV
  );
  assert.equal(invalidUpload.status, 400);

  const content = Buffer.from("worker attachment integrity", "utf8");
  const uploadResponse = await worker.fetch(
    new Request("https://deep-oa-hr.example.workers.dev/api/files", {
      body: JSON.stringify({
        contentBase64: content.toString("base64"),
        fileName: "integrity.txt",
        mimeType: "text/plain"
      }),
      headers: { "content-type": "application/json", cookie },
      method: "POST"
    }),
    TEST_ENV
  );
  const uploadPayload = await responseJson(uploadResponse);
  assert.equal(uploadResponse.status, 200);
  assert.equal(uploadPayload.file.sizeBytes, content.length);
  assert.equal(uploadPayload.file.checksum, sha256(content));

  const downloadResponse = await worker.fetch(
    new Request(`https://deep-oa-hr.example.workers.dev/api/files/${uploadPayload.file.id}/download`, {
      headers: { cookie }
    }),
    TEST_ENV
  );
  assert.equal(downloadResponse.status, 200);
  assert.equal(await downloadResponse.text(), "worker attachment integrity");
});

test("cloudflare worker dashboard import stores source checksum blocks duplicates and downloads source", async () => {
  const loginResponse = await worker.fetch(
    new Request("https://deep-oa-hr.example.workers.dev/api/auth/login", {
      body: JSON.stringify({ email: "admin@oa.local", password: ADMIN_PASSWORD }),
      headers: { "content-type": "application/json" },
      method: "POST"
    }),
    TEST_ENV
  );
  const cookie = loginResponse.headers.get("set-cookie");
  const sourceName = `worker-source-${Date.now()}.html`;
  const html = `<html><body>OA ${Date.now()}</body></html>`;
  const importResponse = await worker.fetch(
    new Request("https://deep-oa-hr.example.workers.dev/api/imports/dashboard-html", {
      body: JSON.stringify({ html, sourceName }),
      headers: { "content-type": "application/json", cookie },
      method: "POST"
    }),
    TEST_ENV
  );
  const importPayload = await responseJson(importResponse);
  assert.equal(importResponse.status, 200);
  assert.equal(importPayload.importRun.sourceChecksum, sha256(html));
  assert.equal(importPayload.importRun.sourceSizeBytes, Buffer.byteLength(html));

  const sourceResponse = await worker.fetch(
    new Request(`https://deep-oa-hr.example.workers.dev/api/imports/${importPayload.importRun.id}/source`, {
      headers: { cookie }
    }),
    TEST_ENV
  );
  assert.equal(sourceResponse.status, 200);
  assert.equal(await sourceResponse.text(), html);

  const duplicateResponse = await worker.fetch(
    new Request("https://deep-oa-hr.example.workers.dev/api/imports/dashboard-html", {
      body: JSON.stringify({ html, sourceName }),
      headers: { "content-type": "application/json", cookie },
      method: "POST"
    }),
    TEST_ENV
  );
  const duplicatePayload = await responseJson(duplicateResponse);
  assert.equal(duplicateResponse.status, 409);
  assert.equal(duplicatePayload.error, "duplicate_import");
  assert.equal(duplicatePayload.duplicateImportId, importPayload.importRun.id);
});

test("cloudflare worker forces generated employee accounts through first login setup", async () => {
  const adminLogin = await worker.fetch(
    new Request("https://deep-oa-hr.example.workers.dev/api/auth/login", {
      body: JSON.stringify({ email: "admin@oa.local", password: ADMIN_PASSWORD }),
      headers: { "content-type": "application/json" },
      method: "POST"
    }),
    TEST_ENV
  );
  const adminCookie = adminLogin.headers.get("set-cookie");
  const createdResponse = await worker.fetch(
    new Request("https://deep-oa-hr.example.workers.dev/api/iam/users", {
      body: JSON.stringify({
        email: `first-login-${Date.now()}@oa.local`,
        name: "首次登录员工",
        newPassword: "TempPass12345",
        roleCodes: ["employee-self-service"]
      }),
      headers: { "content-type": "application/json", cookie: adminCookie },
      method: "POST"
    }),
    TEST_ENV
  );
  const createdPayload = await responseJson(createdResponse);
  const loginResponse = await worker.fetch(
    new Request("https://deep-oa-hr.example.workers.dev/api/auth/login", {
      body: JSON.stringify({ email: createdPayload.user.email, password: "TempPass12345" }),
      headers: { "content-type": "application/json" },
      method: "POST"
    }),
    TEST_ENV
  );
  const loginPayload = await responseJson(loginResponse);
  const employeeCookie = loginResponse.headers.get("set-cookie");

  assert.equal(loginResponse.status, 200);
  assert.equal(loginPayload.user.mustChangePassword, true);

  const blockedResponse = await worker.fetch(
    new Request("https://deep-oa-hr.example.workers.dev/api/people", {
      headers: { cookie: employeeCookie }
    }),
    TEST_ENV
  );
  const blockedPayload = await responseJson(blockedResponse);
  assert.equal(blockedResponse.status, 403);
  assert.equal(blockedPayload.error, "first_login_required");

  const passwordOnlyBypass = await worker.fetch(
    new Request("https://deep-oa-hr.example.workers.dev/api/auth/change-password", {
      body: JSON.stringify({
        currentPassword: "TempPass12345",
        newPassword: "PasswordOnlyBypass123"
      }),
      headers: { "content-type": "application/json", cookie: employeeCookie },
      method: "POST"
    }),
    TEST_ENV
  );
  const bypassPayload = await responseJson(passwordOnlyBypass);
  assert.equal(passwordOnlyBypass.status, 403);
  assert.equal(bypassPayload.error, "first_login_required");

  const newEmail = `renamed-${Date.now()}@oa.local`;
  const setupResponse = await worker.fetch(
    new Request("https://deep-oa-hr.example.workers.dev/api/auth/complete-first-login", {
      body: JSON.stringify({
        currentPassword: "TempPass12345",
        email: newEmail,
        name: "员工自定义姓名",
        newPassword: "NewPass123456"
      }),
      headers: { "content-type": "application/json", cookie: employeeCookie },
      method: "POST"
    }),
    TEST_ENV
  );
  const setupPayload = await responseJson(setupResponse);
  assert.equal(setupResponse.status, 200);
  assert.equal(setupPayload.user.email, newEmail);
  assert.equal(setupPayload.user.mustChangePassword, false);
  assert.equal(setupPayload.user.permissions.includes("resource.book"), true);
  assert.equal(setupPayload.user.permissions.includes("iam.read"), false);

  const relogin = await worker.fetch(
    new Request("https://deep-oa-hr.example.workers.dev/api/auth/login", {
      body: JSON.stringify({ email: newEmail, password: "NewPass123456" }),
      headers: { "content-type": "application/json" },
      method: "POST"
    }),
    TEST_ENV
  );
  assert.equal(relogin.status, 200);
  const readyEmployeeCookie = relogin.headers.get("set-cookie");

  const iamDenied = await worker.fetch(
    new Request("https://deep-oa-hr.example.workers.dev/api/iam", {
      headers: { cookie: readyEmployeeCookie }
    }),
    TEST_ENV
  );
  const iamDeniedPayload = await responseJson(iamDenied);
  assert.equal(iamDenied.status, 403);
  assert.equal(iamDeniedPayload.error, "permission_denied");

  const auditExportDenied = await worker.fetch(
    new Request("https://deep-oa-hr.example.workers.dev/api/audit/export", {
      headers: { cookie: readyEmployeeCookie },
      method: "POST"
    }),
    TEST_ENV
  );
  assert.equal(auditExportDenied.status, 403);

  const bookingResponse = await worker.fetch(
    new Request("https://deep-oa-hr.example.workers.dev/api/resources/bookings", {
      body: JSON.stringify({
        applicant: "董事长",
        dayIndex: 6,
        period: "11:00-12:00",
        purpose: "员工自助预约",
        resourceName: "一号会议室",
        type: "会议室"
      }),
      headers: { "content-type": "application/json", cookie: readyEmployeeCookie },
      method: "POST"
    }),
    TEST_ENV
  );
  const bookingPayload = await responseJson(bookingResponse);
  assert.equal(bookingResponse.status, 200);
  assert.equal(bookingPayload.booking.applicant, "员工自定义姓名");
});

test("cloudflare worker native approval decisions require every current approver before next node", async () => {
  const loginResponse = await worker.fetch(
    new Request("https://deep-oa-hr.example.workers.dev/api/auth/login", {
      body: JSON.stringify({ email: "admin@oa.local", password: ADMIN_PASSWORD }),
      headers: { "content-type": "application/json" },
      method: "POST"
    }),
    TEST_ENV
  );
  const cookie = loginResponse.headers.get("set-cookie");
  const createdResponse = await worker.fetch(
    new Request("https://deep-oa-hr.example.workers.dev/api/approvals", {
      body: JSON.stringify({ definitionId: "expense", formData: { amount: "800" } }),
      headers: { "content-type": "application/json", cookie },
      method: "POST"
    }),
    TEST_ENV
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
    TEST_ENV
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
    TEST_ENV
  );
  const secondDecisionPayload = await responseJson(secondDecisionResponse);
  assert.equal(secondDecisionPayload.approval.currentNodeIndex, approval.currentNodeIndex + 1);
});

test("cloudflare worker approval decisions reject non-admin approver impersonation", async () => {
  const adminLogin = await worker.fetch(
    new Request("https://deep-oa-hr.example.workers.dev/api/auth/login", {
      body: JSON.stringify({ email: "admin@oa.local", password: ADMIN_PASSWORD }),
      headers: { "content-type": "application/json" },
      method: "POST"
    }),
    TEST_ENV
  );
  const adminCookie = adminLogin.headers.get("set-cookie");
  const createUser = await worker.fetch(
    new Request("https://deep-oa-hr.example.workers.dev/api/iam/users", {
      body: JSON.stringify({
        email: `fake-approver-${Date.now()}@oa.local`,
        mustChangePassword: false,
        name: "伪审批经理",
        newPassword: "FakePass12345",
        roleCodes: ["department-manager"]
      }),
      headers: { "content-type": "application/json", cookie: adminCookie },
      method: "POST"
    }),
    TEST_ENV
  );
  const createdUser = (await responseJson(createUser)).user;
  const approvalResponse = await worker.fetch(
    new Request("https://deep-oa-hr.example.workers.dev/api/approvals", {
      body: JSON.stringify({ definitionId: "expense", formData: { amount: "1200" } }),
      headers: { "content-type": "application/json", cookie: adminCookie },
      method: "POST"
    }),
    TEST_ENV
  );
  const approval = (await responseJson(approvalResponse)).approval;
  const firstApprover = approval.approvalNodes[approval.currentNodeIndex].decisions[0].approver;
  const managerLogin = await worker.fetch(
    new Request("https://deep-oa-hr.example.workers.dev/api/auth/login", {
      body: JSON.stringify({ email: createdUser.email, password: "FakePass12345" }),
      headers: { "content-type": "application/json" },
      method: "POST"
    }),
    TEST_ENV
  );
  const managerCookie = managerLogin.headers.get("set-cookie");

  const decisionResponse = await worker.fetch(
    new Request(`https://deep-oa-hr.example.workers.dev/api/approvals/${approval.id}/decision`, {
      body: JSON.stringify({ approverName: firstApprover, decision: "pass" }),
      headers: { "content-type": "application/json", cookie: managerCookie },
      method: "POST"
    }),
    TEST_ENV
  );
  const decisionPayload = await responseJson(decisionResponse);
  assert.equal(decisionResponse.status, 403);
  assert.equal(decisionPayload.error, "permission_denied");
});
