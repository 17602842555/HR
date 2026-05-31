import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const migrationLockPath = resolve(process.cwd(), "prisma", "migrations", "migration-lock.json");

function readMigrationLock(path = migrationLockPath) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function expectedMigrationNames(lock = readMigrationLock()) {
  return (Array.isArray(lock?.migrations) ? lock.migrations : [])
    .map((migration) => String(migration?.name || "").trim())
    .filter(Boolean);
}

export function latestExpectedMigrationName(lock = readMigrationLock()) {
  const names = expectedMigrationNames(lock);
  return names[names.length - 1] || "";
}

function normalizedMigrationRows(rows = []) {
  return (Array.isArray(rows) ? rows : [])
    .map((row) => ({
      finishedAt: row?.finished_at || row?.finishedAt || null,
      migrationName: String(row?.migration_name || row?.migrationName || "").trim(),
      rolledBackAt: row?.rolled_back_at || row?.rolledBackAt || null
    }))
    .filter((row) => row.migrationName);
}

export async function checkPrismaMigrationReadiness(prisma, {
  expectedNames = expectedMigrationNames()
} = {}) {
  const rows = normalizedMigrationRows(await prisma.$queryRawUnsafe(`
    SELECT migration_name, finished_at, rolled_back_at
    FROM "_prisma_migrations"
    ORDER BY migration_name ASC
  `));
  const expectedSet = new Set(expectedNames);
  const appliedRows = rows.filter((row) => row.finishedAt && !row.rolledBackAt);
  const appliedNames = appliedRows.map((row) => row.migrationName);
  const appliedSet = new Set(appliedNames);
  const rolledBack = rows
    .filter((row) => expectedSet.has(row.migrationName) && row.rolledBackAt)
    .map((row) => row.migrationName);
  const missing = expectedNames.filter((name) => !appliedSet.has(name));
  const extra = appliedNames.filter((name) => !expectedSet.has(name));

  return {
    appliedCount: appliedNames.length,
    expectedCount: expectedNames.length,
    extra,
    latestApplied: appliedNames[appliedNames.length - 1] || "",
    latestExpected: expectedNames[expectedNames.length - 1] || "",
    missing,
    ok: missing.length === 0 && rolledBack.length === 0,
    rolledBack
  };
}
