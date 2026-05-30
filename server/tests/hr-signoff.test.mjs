import assert from "node:assert/strict";
import test from "node:test";
import {
  dashboardSignoffCounts,
  parseHrSignoffArgs,
  requiredMaskedFields,
  validateHrDataSignoff
} from "../../scripts/validate-hr-signoff.mjs";

const validChecksum = "a".repeat(64);

function validSignoff(overrides = {}) {
  return {
    schemaVersion: 1,
    documentId: "HR-SIGNOFF-20260530-PROD",
    environment: "production",
    signedAt: "2026-05-30T12:00:00.000Z",
    source: {
      sourceName: "oa-dashboard.html",
      sourceChecksum: validChecksum,
      importedAt: "2026-05-30T12:01:00.000Z",
      counts: {
        activeEmployees: 72,
        leavers: 162,
        femaleEmployees: 43,
        monthLeavers: 4,
        departments: 10,
        orgs: 8
      }
    },
    dataPolicy: {
      fieldPolicy: {
        defaultMasked: true,
        revealPermission: "employee.sensitive.read",
        maskedFields: [...requiredMaskedFields]
      },
      exportPolicy: {
        requiresPermission: true,
        allowsSensitiveExport: false,
        recordsExportLedger: true,
        requiresBusinessReason: true
      },
      retention: {
        employeeRecords: "Keep personnel records for the approved statutory HR retention period.",
        leaverRecords: "Keep leaver records for the approved statutory HR retention period.",
        auditLogs: "Keep audit logs for the approved compliance evidence retention period.",
        exportFiles: "Keep export files only in approved release evidence storage."
      }
    },
    approvals: [
      {
        role: "HR owner",
        name: "王人事",
        email: "hr.owner@company.internal",
        decision: "approved",
        approvedAt: "2026-05-30T12:10:00.000Z"
      },
      {
        role: "Product owner",
        name: "赵产品",
        email: "product.owner@company.internal",
        decision: "approved",
        approvedAt: "2026-05-30T12:20:00.000Z"
      },
      {
        role: "Security reviewer",
        name: "周安全",
        email: "security.reviewer@company.internal",
        decision: "approved",
        approvedAt: "2026-05-30T12:30:00.000Z"
      }
    ],
    openExceptions: [],
    ...overrides
  };
}

test("HR data signoff validator accepts reviewed source counts and data policy", () => {
  const result = validateHrDataSignoff(validSignoff(), {
    expectedChecksum: validChecksum,
    expectedCounts: {
      activeEmployees: 72,
      leavers: 162,
      femaleEmployees: 43,
      monthLeavers: 4,
      departments: 10,
      orgs: 8
    }
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
  assert.equal(result.summary.openExceptionCount, 0);
});

test("HR data signoff validator rejects stale source counts and checksum", () => {
  const result = validateHrDataSignoff(validSignoff({
    source: {
      ...validSignoff().source,
      sourceChecksum: "b".repeat(64),
      counts: { ...validSignoff().source.counts, activeEmployees: 71 }
    }
  }), {
    expectedChecksum: validChecksum,
    expectedCounts: {
      activeEmployees: 72,
      leavers: 162,
      femaleEmployees: 43,
      monthLeavers: 4,
      departments: 10,
      orgs: 8
    }
  });

  assert.equal(result.ok, false);
  assert(result.errors.some((error) => error.includes("source.sourceChecksum does not match")));
  assert(result.errors.some((error) => error.includes("source.counts.activeEmployees must be 72")));
});

test("HR data signoff validator rejects sensitive export and missing approvals", () => {
  const result = validateHrDataSignoff(validSignoff({
    dataPolicy: {
      ...validSignoff().dataPolicy,
      fieldPolicy: {
        ...validSignoff().dataPolicy.fieldPolicy,
        maskedFields: requiredMaskedFields.filter((field) => field !== "salary")
      },
      exportPolicy: {
        ...validSignoff().dataPolicy.exportPolicy,
        allowsSensitiveExport: true
      }
    },
    approvals: validSignoff().approvals.slice(0, 1)
  }), {
    expectedChecksum: validChecksum,
    expectedCounts: {
      activeEmployees: 72,
      leavers: 162,
      femaleEmployees: 43,
      monthLeavers: 4,
      departments: 10,
      orgs: 8
    }
  });

  assert.equal(result.ok, false);
  assert(result.errors.some((error) => error.includes("maskedFields must include salary")));
  assert(result.errors.some((error) => error.includes("allowsSensitiveExport must be false")));
  assert(result.errors.some((error) => error.includes("Product owner")));
});

test("HR data signoff validator blocks example and production exceptions", () => {
  const result = validateHrDataSignoff(validSignoff({
    example: true,
    documentId: "EXAMPLE-TODO",
    openExceptions: [
      {
        owner: "HR治理负责人",
        exitCriteria: "Attach the final written approval before the release candidate is accepted."
      }
    ]
  }), {
    expectedChecksum: validChecksum,
    expectedCounts: validSignoff().source.counts
  });

  assert.equal(result.ok, false);
  assert(result.errors.some((error) => error.includes("Example signoff files cannot be used")));
  assert(result.errors.some((error) => error.includes("documentId")));
  assert(result.errors.some((error) => error.includes("production signoff must not contain openExceptions")));
});

test("dashboard signoff counts are derived from the current oa-dashboard source", () => {
  const counts = dashboardSignoffCounts();

  assert.equal(counts.activeEmployees, 72);
  assert.equal(counts.leavers, 162);
  assert.equal(counts.femaleEmployees, 43);
  assert.equal(counts.monthLeavers, 4);
  assert.equal(counts.orgs, 8);
});

test("HR data signoff CLI parser reads custom source json and example flags", () => {
  const parsed = parseHrSignoffArgs([
    "docs/custom-signoff.json",
    "--source",
    "oa-dashboard.html",
    "--json",
    "--allow-example"
  ]);

  assert.equal(parsed.signoffPath, "docs/custom-signoff.json");
  assert.equal(parsed.sourcePath, "oa-dashboard.html");
  assert.equal(parsed.json, true);
  assert.equal(parsed.allowExample, true);
});
