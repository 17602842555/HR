import assert from "node:assert/strict";
import test from "node:test";
import {
  checkPrismaMigrationReadiness,
  expectedMigrationNames,
  latestExpectedMigrationName
} from "../src/modules/system/migration-readiness.mjs";

test("migration readiness accepts all locked migrations applied", async () => {
  const expectedNames = ["20260529120000_init", "20260529160000_followup"];
  const report = await checkPrismaMigrationReadiness({
    $queryRawUnsafe: async () => expectedNames.map((migrationName) => ({
      migration_name: migrationName,
      finished_at: new Date("2026-05-30T10:00:00.000Z"),
      rolled_back_at: null
    }))
  }, { expectedNames });

  assert.equal(report.ok, true);
  assert.equal(report.expectedCount, 2);
  assert.equal(report.appliedCount, 2);
  assert.equal(report.latestExpected, "20260529160000_followup");
  assert.equal(report.latestApplied, "20260529160000_followup");
  assert.deepEqual(report.missing, []);
  assert.deepEqual(report.rolledBack, []);
});

test("migration readiness fails closed on missing or rolled back locked migrations", async () => {
  const expectedNames = ["20260529120000_init", "20260529160000_followup", "20260529170000_audit"];
  const report = await checkPrismaMigrationReadiness({
    $queryRawUnsafe: async () => [
      {
        migration_name: "20260529120000_init",
        finished_at: new Date("2026-05-30T10:00:00.000Z"),
        rolled_back_at: null
      },
      {
        migration_name: "20260529160000_followup",
        finished_at: new Date("2026-05-30T10:00:00.000Z"),
        rolled_back_at: new Date("2026-05-30T11:00:00.000Z")
      }
    ]
  }, { expectedNames });

  assert.equal(report.ok, false);
  assert.deepEqual(report.missing, ["20260529160000_followup", "20260529170000_audit"]);
  assert.deepEqual(report.rolledBack, ["20260529160000_followup"]);
});

test("migration lock helpers expose the current locked migration tail", () => {
  const names = expectedMigrationNames();
  assert.equal(names.length >= 1, true);
  assert.equal(latestExpectedMigrationName(), names[names.length - 1]);
});
