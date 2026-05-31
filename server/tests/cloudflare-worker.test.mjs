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
  const iamText = await iamResponse.text();
  assert.equal(iamText.includes("passwordHash"), false);
  assert.equal(iamText.includes("sessionSecret"), false);
  const iam = JSON.parse(iamText).iam;
  const adminRole = iam.roles.find((role) => role.code === "admin");
  const adminUser = iam.users.find((user) => user.email === "admin@oa.local");
  assert.equal(Object.hasOwn(adminUser, "passwordHash"), false);
  assert.equal(iam.accounts.some((account) => account.account && Object.hasOwn(account.account, "passwordHash")), false);

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
  assert.equal(JSON.stringify(created).includes("passwordHash"), false);
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
  assert.equal(uploadResponse.headers.get("cache-control"), "no-store, private");
  assert.equal("contentBase64" in uploadPayload.file, false);
  assert.equal("storageKey" in uploadPayload.file, false);
  assert.equal("passwordHash" in uploadPayload.file, false);
  assert.equal(uploadPayload.file.downloadAvailable, true);

  const listResponse = await worker.fetch(
    new Request("https://deep-oa-hr.example.workers.dev/api/files", {
      headers: { cookie }
    }),
    TEST_ENV
  );
  const listPayload = await responseJson(listResponse);
  const listedFile = listPayload.files.find((item) => item.id === uploadPayload.file.id);
  assert.equal(listResponse.status, 200);
  assert.equal(Boolean(listedFile), true);
  assert.equal("contentBase64" in listedFile, false);
  assert.equal("storageKey" in listedFile, false);
  assert.equal("passwordHash" in listedFile, false);
  assert.equal(listedFile.downloadAvailable, true);

  const downloadResponse = await worker.fetch(
    new Request(`https://deep-oa-hr.example.workers.dev/api/files/${uploadPayload.file.id}/download`, {
      headers: { cookie }
    }),
    TEST_ENV
  );
  assert.equal(downloadResponse.status, 200);
  assert.equal(downloadResponse.headers.get("cache-control"), "no-store, private");
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
  assert.equal("sourceContentBase64" in importPayload.importRun, false);
  assert.equal("people" in importPayload, false);
  assert.equal(importResponse.headers.get("cache-control"), "no-store, private");
  assert.equal(importPayload.importRun.metadata.sourceArtifact.downloadAvailable, true);

  const importsResponse = await worker.fetch(
    new Request("https://deep-oa-hr.example.workers.dev/api/imports", {
      headers: { cookie }
    }),
    TEST_ENV
  );
  const importsPayload = await responseJson(importsResponse);
  const listedImport = importsPayload.importRuns.find((item) => item.id === importPayload.importRun.id);
  assert.equal(importsResponse.status, 200);
  assert.equal(Boolean(listedImport), true);
  assert.equal("sourceContentBase64" in listedImport, false);
  assert.equal(listedImport.metadata.sourceArtifact.downloadAvailable, true);

  const sourceResponse = await worker.fetch(
    new Request(`https://deep-oa-hr.example.workers.dev/api/imports/${importPayload.importRun.id}/source`, {
      headers: { cookie }
    }),
    TEST_ENV
  );
  assert.equal(sourceResponse.status, 200);
  assert.equal(sourceResponse.headers.get("cache-control"), "no-store, private");
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

test("cloudflare worker iam.write without system admin cannot grant privileged access", async () => {
  const adminLogin = await worker.fetch(
    new Request("https://deep-oa-hr.example.workers.dev/api/auth/login", {
      body: JSON.stringify({ email: "admin@oa.local", password: ADMIN_PASSWORD }),
      headers: { "content-type": "application/json" },
      method: "POST"
    }),
    TEST_ENV
  );
  const adminCookie = adminLogin.headers.get("set-cookie");

  const delegateRole = await worker.fetch(
    new Request("https://deep-oa-hr.example.workers.dev/api/iam/roles/ROLE-auditor/permissions", {
      body: JSON.stringify({ permissionCodes: ["audit.read", "iam.read", "iam.write"] }),
      headers: { "content-type": "application/json", cookie: adminCookie },
      method: "PUT"
    }),
    TEST_ENV
  );
  assert.equal(delegateRole.status, 200);

  const delegatePassword = "DelegatePass123";
  const delegateUser = await worker.fetch(
    new Request("https://deep-oa-hr.example.workers.dev/api/iam/users", {
      body: JSON.stringify({
        email: `iam-delegate-${Date.now()}@oa.local`,
        mustChangePassword: false,
        name: "权限专员",
        newPassword: delegatePassword,
        roleCodes: ["audit-viewer"]
      }),
      headers: { "content-type": "application/json", cookie: adminCookie },
      method: "POST"
    }),
    TEST_ENV
  );
  const delegatePayload = await responseJson(delegateUser);
  const delegateLogin = await worker.fetch(
    new Request("https://deep-oa-hr.example.workers.dev/api/auth/login", {
      body: JSON.stringify({ email: delegatePayload.user.email, password: delegatePassword }),
      headers: { "content-type": "application/json" },
      method: "POST"
    }),
    TEST_ENV
  );
  const delegateCookie = delegateLogin.headers.get("set-cookie");

  const createAdmin = await worker.fetch(
    new Request("https://deep-oa-hr.example.workers.dev/api/iam/users", {
      body: JSON.stringify({
        email: `blocked-admin-${Date.now()}@oa.local`,
        name: "越权管理员",
        newPassword: "BlockedAdminPass123",
        roleCodes: ["admin"]
      }),
      headers: { "content-type": "application/json", cookie: delegateCookie },
      method: "POST"
    }),
    TEST_ENV
  );
  const createAdminPayload = await responseJson(createAdmin);
  assert.equal(createAdmin.status, 403);
  assert.equal(createAdminPayload.error, "system_admin_required");

  const grantSystemAdmin = await worker.fetch(
    new Request("https://deep-oa-hr.example.workers.dev/api/iam/roles/ROLE-auditor/permissions", {
      body: JSON.stringify({ permissionCodes: ["audit.read", "iam.read", "iam.write", "system.admin"] }),
      headers: { "content-type": "application/json", cookie: delegateCookie },
      method: "PUT"
    }),
    TEST_ENV
  );
  const grantPayload = await responseJson(grantSystemAdmin);
  assert.equal(grantSystemAdmin.status, 403);
  assert.equal(grantPayload.error, "system_admin_required");
});

test("cloudflare worker supports employee activation with phone-number login", async () => {
  const adminLogin = await worker.fetch(
    new Request("https://deep-oa-hr.example.workers.dev/api/auth/login", {
      body: JSON.stringify({ email: "admin@oa.local", password: ADMIN_PASSWORD }),
      headers: { "content-type": "application/json" },
      method: "POST"
    }),
    TEST_ENV
  );
  const adminCookie = adminLogin.headers.get("set-cookie");
  const iamResponse = await worker.fetch(
    new Request("https://deep-oa-hr.example.workers.dev/api/iam", {
      headers: { cookie: adminCookie }
    }),
    TEST_ENV
  );
  const iam = (await responseJson(iamResponse)).iam;
  const missingAccount = iam.accounts.find((account) => !account.accountId);
  assert.ok(missingAccount);

  const issueResponse = await worker.fetch(
    new Request("https://deep-oa-hr.example.workers.dev/api/iam/account-activations", {
      body: JSON.stringify({
        employeeId: missingAccount.employeeId,
        roleCodes: ["employee-self-service"]
      }),
      headers: { "content-type": "application/json", cookie: adminCookie },
      method: "POST"
    }),
    TEST_ENV
  );
  const issuePayload = await responseJson(issueResponse);
  assert.equal(issueResponse.status, 201);
  assert.match(issuePayload.activation.activationCode, /^OA-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);

  const phone = `176${String(Date.now()).slice(-8)}`;
  const activateResponse = await worker.fetch(
    new Request("https://deep-oa-hr.example.workers.dev/api/auth/activate-account", {
      body: JSON.stringify({
        activationCode: issuePayload.activation.activationCode,
        login: phone,
        employeeNo: missingAccount.employeeNo,
        name: missingAccount.employeeName,
        password: "PhoneLoginPass123"
      }),
      headers: { "content-type": "application/json" },
      method: "POST"
    }),
    TEST_ENV
  );
  const activatePayload = await responseJson(activateResponse);
  assert.equal(activateResponse.status, 201);
  assert.equal(activatePayload.user.email, phone);
  assert.equal(activatePayload.user.mustChangePassword, false);
  assert.equal(activatePayload.user.permissions.includes("resource.book"), true);

  const relogin = await worker.fetch(
    new Request("https://deep-oa-hr.example.workers.dev/api/auth/login", {
      body: JSON.stringify({ login: phone, password: "PhoneLoginPass123" }),
      headers: { "content-type": "application/json" },
      method: "POST"
    }),
    TEST_ENV
  );
  assert.equal(relogin.status, 200);

  const reuse = await worker.fetch(
    new Request("https://deep-oa-hr.example.workers.dev/api/auth/activate-account", {
      body: JSON.stringify({
        activationCode: issuePayload.activation.activationCode,
        email: `177${String(Date.now()).slice(-8)}`,
        employeeNo: missingAccount.employeeNo,
        name: missingAccount.employeeName,
        password: "PhoneLoginPass123"
      }),
      headers: { "content-type": "application/json" },
      method: "POST"
    }),
    TEST_ENV
  );
  assert.equal(reuse.status, 404);

  const auditResponse = await worker.fetch(
    new Request("https://deep-oa-hr.example.workers.dev/api/audit", {
      headers: { cookie: adminCookie }
    }),
    TEST_ENV
  );
  const auditText = await auditResponse.text();
  assert.equal(auditText.includes(issuePayload.activation.activationCode), false);
  assert.equal(auditText.includes("PhoneLoginPass123"), false);
});

test("cloudflare worker people API redacts sensitive fields and rejects sensitive PATCH", async () => {
  const adminLogin = await worker.fetch(
    new Request("https://deep-oa-hr.example.workers.dev/api/auth/login", {
      body: JSON.stringify({ email: "admin@oa.local", password: ADMIN_PASSWORD }),
      headers: { "content-type": "application/json" },
      method: "POST"
    }),
    TEST_ENV
  );
  const adminCookie = adminLogin.headers.get("set-cookie");
  const iamResponse = await worker.fetch(
    new Request("https://deep-oa-hr.example.workers.dev/api/iam", {
      headers: { cookie: adminCookie }
    }),
    TEST_ENV
  );
  const missingAccount = (await responseJson(iamResponse)).iam.accounts.find((account) => !account.accountId);
  assert.ok(missingAccount);

  const phone = `177${String(Date.now()).slice(-8)}`;
  const rejectedPatch = await worker.fetch(
    new Request(`https://deep-oa-hr.example.workers.dev/api/people/employees/${encodeURIComponent(missingAccount.employeeId)}`, {
      body: JSON.stringify({ passwordHash: "leak", phone, salary: "999999" }),
      headers: { "content-type": "application/json", cookie: adminCookie },
      method: "PATCH"
    }),
    TEST_ENV
  );
  const rejectedPayload = await responseJson(rejectedPatch);
  assert.equal(rejectedPatch.status, 400);
  assert.equal(rejectedPayload.error, "employee_field_not_editable");
  assert.deepEqual(rejectedPayload.fields, ["passwordHash", "phone", "salary"]);

  const allowedPatch = await worker.fetch(
    new Request(`https://deep-oa-hr.example.workers.dev/api/people/employees/${encodeURIComponent(missingAccount.employeeId)}`, {
      body: JSON.stringify({ role: "安全合规专员", status: "在职" }),
      headers: { "content-type": "application/json", cookie: adminCookie },
      method: "PATCH"
    }),
    TEST_ENV
  );
  const allowedPayload = await responseJson(allowedPatch);
  assert.equal(allowedPatch.status, 200);
  assert.equal(allowedPayload.employee.role, "安全合规专员");
  assert.equal(Object.hasOwn(allowedPayload.employee, "phone"), false);
  assert.equal(Object.hasOwn(allowedPayload.employee, "passwordHash"), false);

  const peopleResponse = await worker.fetch(
    new Request("https://deep-oa-hr.example.workers.dev/api/people", {
      headers: { cookie: adminCookie }
    }),
    TEST_ENV
  );
  const peopleText = await peopleResponse.text();
  assert.equal(peopleResponse.status, 200);
  assert.equal(peopleText.includes(phone), false);
  assert.equal(peopleText.includes("passwordHash"), false);
  assert.equal(peopleText.includes("salary"), false);
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

test("cloudflare worker approval rules require approvers bound to real active accounts", async () => {
  const loginResponse = await worker.fetch(
    new Request("https://deep-oa-hr.example.workers.dev/api/auth/login", {
      body: JSON.stringify({ email: "admin@oa.local", password: ADMIN_PASSWORD }),
      headers: { "content-type": "application/json" },
      method: "POST"
    }),
    TEST_ENV
  );
  const cookie = loginResponse.headers.get("set-cookie");
  const unboundRule = {
    department: "行政部",
    enabled: true,
    nodes: [{ id: "expense-unbound-1", name: "直属负责人审批", mode: "AND", approvers: ["未开户审批人"] }],
    templateId: "expense",
    templateName: "费用报销"
  };

  const rejected = await worker.fetch(
    new Request("https://deep-oa-hr.example.workers.dev/api/approvals/rules", {
      body: JSON.stringify(unboundRule),
      headers: { "content-type": "application/json", cookie },
      method: "POST"
    }),
    TEST_ENV
  );
  const rejectedPayload = await responseJson(rejected);
  assert.equal(rejected.status, 400);
  assert.equal(rejectedPayload.error, "approval_rule_approvers_unresolved");
  assert.deepEqual(rejectedPayload.details.unresolvedApprovers, ["未开户审批人"]);

  const createdUser = await worker.fetch(
    new Request("https://deep-oa-hr.example.workers.dev/api/iam/users", {
      body: JSON.stringify({
        email: `approver-${Date.now()}@oa.local`,
        mustChangePassword: false,
        name: "未开户审批人",
        newPassword: "ApproverPass123",
        roleCodes: ["department-manager"]
      }),
      headers: { "content-type": "application/json", cookie },
      method: "POST"
    }),
    TEST_ENV
  );
  const user = (await responseJson(createdUser)).user;
  const saved = await worker.fetch(
    new Request("https://deep-oa-hr.example.workers.dev/api/approvals/rules", {
      body: JSON.stringify(unboundRule),
      headers: { "content-type": "application/json", cookie },
      method: "POST"
    }),
    TEST_ENV
  );
  const savedPayload = await responseJson(saved);

  assert.equal(saved.status, 200);
  assert.equal(savedPayload.rule.nodes[0].approverUsers[0].userId, user.id);
  assert.equal(savedPayload.rule.nodes[0].mode, "AND");
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

test("cloudflare worker bootstrap admin can use phone-number login", async () => {
  const phoneLogin = "17602842555";
  const response = await worker.fetch(
    new Request("https://deep-oa-hr.example.workers.dev/api/auth/login", {
      body: JSON.stringify({ login: phoneLogin, password: ADMIN_PASSWORD }),
      headers: { "content-type": "application/json" },
      method: "POST"
    }),
    {
      ...TEST_ENV,
      CLOUDFLARE_BOOTSTRAP_ADMIN_LOGIN: phoneLogin
    }
  );
  const payload = await responseJson(response);

  assert.equal(response.status, 200);
  assert.equal(payload.user.email, phoneLogin);
  assert.equal(payload.user.roles.some((role) => role.code === "admin"), true);
});
