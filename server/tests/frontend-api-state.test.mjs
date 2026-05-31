import assert from "node:assert/strict";
import test from "node:test";
import { apiRequiredBaselineState, mergeApiState, normalizeApiStatePayload } from "../../src/services/apiState.js";

const fallbackState = {
  auditIntegrity: {
    ok: false,
    errors: [],
    warnings: ["local fallback"],
    summary: { totalRows: 1, signedRows: 0, unsignedRows: 1 }
  },
  auditLogs: [],
  exportRecords: [],
  revealSensitive: false
};

test("frontend API state normalizes audit integrity payload", () => {
  const normalized = normalizeApiStatePayload({
    auditIntegrity: {
      ok: true,
      errors: [],
      warnings: [],
      summary: {
        totalRows: 12,
        signedRows: 12,
        unsignedRows: 0,
        firstSequence: 1,
        lastSequence: 12,
        lastHash: "abc123"
      }
    }
  }, fallbackState);

  assert.equal(normalized.auditIntegrity.ok, true);
  assert.equal(normalized.auditIntegrity.summary.signedRows, 12);
  assert.equal(normalized.auditIntegrity.summary.lastHash, "abc123");
});

test("frontend API state merges audit integrity with audit domain override guard", () => {
  const apiState = {
    auditIntegrity: {
      ok: true,
      errors: [],
      warnings: [],
      summary: { totalRows: 5, signedRows: 5, unsignedRows: 0 }
    },
    auditLogs: [{ id: "api-audit" }]
  };

  const merged = mergeApiState(fallbackState, apiState, new Set());
  assert.equal(merged.auditIntegrity.ok, true);
  assert.equal(merged.auditLogs[0].id, "api-audit");

  const locallyOverridden = mergeApiState(fallbackState, apiState, new Set(["audit"]));
  assert.equal(locallyOverridden.auditIntegrity.ok, false);
  assert.equal(locallyOverridden.auditLogs.length, 0);
});

test("frontend API-required baseline strips local HR and business demo records", () => {
  const baseline = apiRequiredBaselineState({
    approvals: [{ id: "local-approval" }],
    people: {
      employees: [{ id: "local-employee" }],
      femaleEmployees: [{ id: "local-female" }],
      leavers: [{ id: "local-leaver" }],
      monthLeavers: [{ id: "local-month-leaver" }]
    },
    iam: {
      permissions: [{ code: "employee.read" }],
      roles: [{ code: "admin" }],
      users: [{ id: "local-user" }]
    }
  });

  assert.deepEqual(baseline.people.employees, []);
  assert.deepEqual(baseline.people.leavers, []);
  assert.deepEqual(baseline.approvals, []);
  assert.deepEqual(baseline.iam.roles, []);
  assert.deepEqual(baseline.iam.users, []);
  assert.deepEqual(baseline.iam.permissions, [{ code: "employee.read" }]);
});

test("frontend API state defensively strips leaked sensitive backend fields", () => {
  const safeFallback = apiRequiredBaselineState(fallbackState);
  const normalized = normalizeApiStatePayload({
    auditLogs: {
      auditLogs: [{ id: "audit-1", metadata: { tokenHash: "secret-token", requestId: "req-1" } }]
    },
    files: {
      files: [{ id: "file-1", fileName: "contract.pdf", contentBase64: "secret-content", storageKey: "private/key" }]
    },
    iamOverview: {
      iam: {
        roles: [],
        users: [{ id: "user-1", name: "员工", passwordHash: "secret-hash", sessionSecret: "secret-session" }]
      }
    },
    importRuns: {
      importRuns: [{ id: "import-1", sourceContentBase64: "source-html", sourceName: "oa-dashboard.html" }]
    },
    people: {
      people: {
        employees: [{
          id: "emp-1",
          name: "员工",
          phone: "13800138000",
          salary: "999999",
          idCard: "440000000000000000",
          department: "行政部"
        }]
      }
    }
  }, safeFallback);

  assert.equal(normalized.people.employees[0].department, "行政部");
  assert.equal(Object.hasOwn(normalized.people.employees[0], "phone"), false);
  assert.equal(Object.hasOwn(normalized.people.employees[0], "salary"), false);
  assert.equal(Object.hasOwn(normalized.people.employees[0], "idCard"), false);
  assert.equal(Object.hasOwn(normalized.iam.users[0], "passwordHash"), false);
  assert.equal(Object.hasOwn(normalized.iam.users[0], "sessionSecret"), false);
  assert.equal(Object.hasOwn(normalized.files[0], "contentBase64"), false);
  assert.equal(Object.hasOwn(normalized.files[0], "storageKey"), false);
  assert.equal(Object.hasOwn(normalized.importRuns[0], "sourceContentBase64"), false);
  assert.equal(Object.hasOwn(normalized.auditLogs[0].metadata, "tokenHash"), false);
  assert.equal(normalized.auditLogs[0].metadata.requestId, "req-1");
});
