import assert from "node:assert/strict";
import test from "node:test";
import { mergeApiState, normalizeApiStatePayload } from "../../src/services/apiState.js";

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
