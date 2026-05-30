import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildMigrationLockData,
  parseMigrationLockArgs,
  validateMigrationLockData
} from "../../scripts/validate-migrations.mjs";

async function writeMigration(root, name, sql) {
  const dir = join(root, "prisma", "migrations", name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "migration.sql"), sql, "utf8");
}

async function sampleMigrationRoot() {
  const root = await mkdtemp(join(tmpdir(), "oa-migrations-"));
  await writeMigration(root, "20260530000000_init", "CREATE TABLE one (id TEXT PRIMARY KEY);\n");
  await writeMigration(root, "20260530010000_add_people", "ALTER TABLE one ADD COLUMN name TEXT;\nCREATE INDEX one_name_idx ON one(name);\n");
  return root;
}

test("migration lock builder records ordered migration checksums and stable summary", async () => {
  const root = await sampleMigrationRoot();
  try {
    const lock = buildMigrationLockData({
      rootDir: root,
      migrationsDir: "prisma/migrations",
      generatedAt: "2026-05-30T00:00:00.000Z"
    });

    assert.equal(lock.schemaVersion, 1);
    assert.equal(lock.migrations.length, 2);
    assert.deepEqual(lock.migrations.map((entry) => entry.name), [
      "20260530000000_init",
      "20260530010000_add_people"
    ]);
    assert.equal(lock.migrations[0].path, "prisma/migrations/20260530000000_init/migration.sql");
    assert.match(lock.migrations[0].sha256, /^[a-f0-9]{64}$/);
    assert.equal(lock.migrations[1].statementCount, 2);
    assert.match(lock.summary.stableSha256, /^[a-f0-9]{64}$/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("migration lock validator accepts matching locked migrations", async () => {
  const root = await sampleMigrationRoot();
  try {
    const actual = buildMigrationLockData({ rootDir: root, migrationsDir: "prisma/migrations" });
    const result = validateMigrationLockData({ actual, lock: actual });

    assert.equal(result.ok, true);
    assert.deepEqual(result.errors, []);
    assert.equal(result.summary.actualMigrationCount, 2);
    assert.equal(result.summary.lockedMigrationCount, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("migration lock validator rejects checksum drift missing and extra migrations", async () => {
  const root = await sampleMigrationRoot();
  try {
    const locked = buildMigrationLockData({ rootDir: root, migrationsDir: "prisma/migrations" });
    await writeMigration(root, "20260530010000_add_people", "ALTER TABLE one ADD COLUMN name TEXT;\n-- modified after lock\n");
    await writeMigration(root, "20260530020000_extra", "CREATE TABLE extra (id TEXT PRIMARY KEY);\n");
    const actual = buildMigrationLockData({ rootDir: root, migrationsDir: "prisma/migrations" });
    const result = validateMigrationLockData({ actual, lock: locked });

    assert.equal(result.ok, false);
    assert(result.errors.some((error) => error.includes("20260530010000_add_people checksum changed")));
    assert(result.errors.some((error) => error.includes("20260530020000_extra is missing from migration-lock.json")));
    assert(result.errors.some((error) => error.includes("migration lock count 2 does not match migration directory count 3")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("migration lock CLI writes and validates a migration lock file", async () => {
  const root = await sampleMigrationRoot();
  try {
    const { spawnSync } = await import("node:child_process");
    const previousUmask = process.umask(0o077);
    const writeResult = spawnSync(process.execPath, [
      "scripts/validate-migrations.mjs",
      "--write",
      "--json",
      "--migrations-dir",
      join(root, "prisma", "migrations"),
      "--lock",
      join(root, "prisma", "migrations", "migration-lock.json")
    ], { cwd: process.cwd(), encoding: "utf8" });
    process.umask(previousUmask);

    assert.equal(writeResult.status, 0, writeResult.stderr);
    const writtenPayload = JSON.parse(writeResult.stdout);
    assert.equal(writtenPayload.ok, true);
    const lockPath = join(root, "prisma", "migrations", "migration-lock.json");
    assert.equal((await stat(lockPath)).mode & 0o777, 0o644);
    assert.equal(JSON.parse(await readFile(lockPath, "utf8")).migrations.length, 2);

    const validateResult = spawnSync(process.execPath, [
      "scripts/validate-migrations.mjs",
      "--json",
      "--migrations-dir",
      join(root, "prisma", "migrations"),
      "--lock",
      lockPath
    ], { cwd: process.cwd(), encoding: "utf8" });

    assert.equal(validateResult.status, 0, validateResult.stderr);
    const payload = JSON.parse(validateResult.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.summary.lockedMigrationCount, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("migration lock CLI parser supports custom paths and write mode", () => {
  const args = parseMigrationLockArgs([
    "--write",
    "--json",
    "--migrations-dir",
    "db/migrations",
    "--lock",
    "db/migration-lock.json"
  ]);

  assert.equal(args.write, true);
  assert.equal(args.json, true);
  assert.equal(args.migrationsDir, "db/migrations");
  assert.equal(args.lockPath, "db/migration-lock.json");
});
