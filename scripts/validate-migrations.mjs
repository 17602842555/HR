import { createHash } from "node:crypto";
import { chmodSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const defaultMigrationsDir = "prisma/migrations";
const defaultLockPath = "prisma/migrations/migration-lock.json";
const migrationNamePattern = /^\d{14}_[A-Za-z0-9_]+$/;

function resolvePath(path, rootDir = process.cwd()) {
  return isAbsolute(path) ? path : resolve(rootDir, path);
}

function sha256Text(text) {
  return createHash("sha256").update(text).digest("hex");
}

function readJson(path, rootDir = process.cwd()) {
  return JSON.parse(readFileSync(resolvePath(path, rootDir), "utf8"));
}

function stableLockPayload(lock) {
  return {
    schemaVersion: lock?.schemaVersion || 1,
    migrations: Array.isArray(lock?.migrations) ? lock.migrations : []
  };
}

export function summarizeMigrationLock(lock = {}) {
  const payload = `${JSON.stringify(stableLockPayload(lock), null, 2)}\n`;
  return {
    migrationCount: Array.isArray(lock.migrations) ? lock.migrations.length : 0,
    stableSha256: sha256Text(payload),
    sha256: sha256Text(payload)
  };
}

export function collectMigrationEntries({
  migrationsDir = defaultMigrationsDir,
  rootDir = process.cwd()
} = {}) {
  const absoluteDir = resolvePath(migrationsDir, rootDir);
  if (!existsSync(absoluteDir)) return [];

  return readdirSync(absoluteDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .map((name) => {
      const absoluteSqlPath = join(absoluteDir, name, "migration.sql");
      const content = existsSync(absoluteSqlPath) ? readFileSync(absoluteSqlPath, "utf8") : "";
      const path = relative(rootDir, absoluteSqlPath).replaceAll("\\", "/");
      return {
        name,
        path,
        bytes: existsSync(absoluteSqlPath) ? statSync(absoluteSqlPath).size : 0,
        sha256: existsSync(absoluteSqlPath) ? sha256Text(content) : null,
        statementCount: content.split(";").map((part) => part.trim()).filter(Boolean).length
      };
    });
}

export function buildMigrationLockData({
  migrationsDir = defaultMigrationsDir,
  rootDir = process.cwd(),
  generatedAt = new Date().toISOString()
} = {}) {
  const migrations = collectMigrationEntries({ migrationsDir, rootDir });
  const lock = {
    schemaVersion: 1,
    generatedAt,
    migrations
  };
  return {
    ...lock,
    summary: summarizeMigrationLock(lock)
  };
}

function duplicateNames(entries) {
  const seen = new Set();
  const duplicates = new Set();
  entries.forEach((entry) => {
    if (seen.has(entry.name)) duplicates.add(entry.name);
    seen.add(entry.name);
  });
  return [...duplicates].sort();
}

export function validateMigrationLockData({
  actual,
  lock
} = {}) {
  const errors = [];
  const warnings = [];
  const actualEntries = Array.isArray(actual?.migrations) ? actual.migrations : [];
  const lockedEntries = Array.isArray(lock?.migrations) ? lock.migrations : [];

  if (!lock || typeof lock !== "object" || Array.isArray(lock)) errors.push("migration lock file is missing or invalid.");
  if (lock?.schemaVersion !== 1) errors.push("migration lock schemaVersion must be 1.");
  if (actualEntries.length === 0) errors.push("no Prisma migrations were found.");

  duplicateNames(actualEntries).forEach((name) => errors.push(`duplicate migration directory found: ${name}.`));
  duplicateNames(lockedEntries).forEach((name) => errors.push(`duplicate migration lock entry found: ${name}.`));

  actualEntries.forEach((entry, index) => {
    if (!migrationNamePattern.test(entry.name)) errors.push(`migration ${entry.name} must use YYYYMMDDHHMMSS_name format.`);
    if (!entry.path.endsWith("/migration.sql")) errors.push(`migration ${entry.name} must point to migration.sql.`);
    if (!entry.sha256) errors.push(`migration ${entry.name} is missing migration.sql.`);
    if (!entry.bytes) errors.push(`migration ${entry.name} migration.sql is empty.`);
    if (index > 0 && actualEntries[index - 1].name >= entry.name) {
      errors.push(`migration ${entry.name} is not in strict chronological order.`);
    }
  });

  const lockedByName = new Map(lockedEntries.map((entry) => [entry.name, entry]));
  const actualByName = new Map(actualEntries.map((entry) => [entry.name, entry]));

  actualEntries.forEach((entry) => {
    const locked = lockedByName.get(entry.name);
    if (!locked) {
      errors.push(`migration ${entry.name} is missing from migration-lock.json.`);
      return;
    }
    if (locked.path !== entry.path) errors.push(`migration ${entry.name} path changed from ${locked.path} to ${entry.path}.`);
    if (locked.bytes !== entry.bytes) errors.push(`migration ${entry.name} byte size changed.`);
    if (locked.sha256 !== entry.sha256) errors.push(`migration ${entry.name} checksum changed.`);
  });

  lockedEntries.forEach((entry) => {
    if (!actualByName.has(entry.name)) errors.push(`locked migration ${entry.name} no longer exists on disk.`);
  });

  if (lockedEntries.length !== actualEntries.length) {
    errors.push(`migration lock count ${lockedEntries.length} does not match migration directory count ${actualEntries.length}.`);
  }

  const actualOrder = actualEntries.map((entry) => entry.name).join("\n");
  const lockedOrder = lockedEntries.map((entry) => entry.name).join("\n");
  if (actualOrder !== lockedOrder) errors.push("migration-lock.json order does not match migration directory order.");

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    summary: {
      ...summarizeMigrationLock(lock || {}),
      actualMigrationCount: actualEntries.length,
      lockedMigrationCount: lockedEntries.length
    }
  };
}

export function parseMigrationLockArgs(argv = process.argv.slice(2)) {
  const args = {
    json: false,
    lockPath: defaultLockPath,
    migrationsDir: defaultMigrationsDir,
    write: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") args.json = true;
    else if (arg === "--write") args.write = true;
    else if (arg === "--lock") args.lockPath = argv[++index] || args.lockPath;
    else if (arg === "--migrations-dir") args.migrationsDir = argv[++index] || args.migrationsDir;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function printHelp() {
  console.log("Usage: node scripts/validate-migrations.mjs [--json] [--write] [--lock prisma/migrations/migration-lock.json] [--migrations-dir prisma/migrations]");
}

async function main(argv = process.argv.slice(2)) {
  const args = parseMigrationLockArgs(argv);
  if (args.help) {
    printHelp();
    return;
  }

  const rootDir = process.cwd();
  const actual = buildMigrationLockData({ migrationsDir: args.migrationsDir, rootDir });
  const lockPath = resolvePath(args.lockPath, rootDir);

  if (args.write) {
    writeFileSync(lockPath, `${JSON.stringify(actual, null, 2)}\n`, { mode: 0o644 });
    chmodSync(lockPath, 0o644);
    const payload = { ok: true, path: relative(rootDir, lockPath), summary: actual.summary };
    if (args.json) console.log(JSON.stringify(payload, null, 2));
    else console.log(`Migration lock written: ${payload.path} (${actual.summary.migrationCount} migrations).`);
    return;
  }

  const lock = readJson(lockPath, rootDir);
  const result = validateMigrationLockData({ actual, lock });
  const payload = {
    path: relative(rootDir, lockPath),
    ...result
  };

  if (args.json) {
    console.log(JSON.stringify(payload, null, 2));
  } else if (result.ok) {
    console.log(`Migration lock validation passed for ${result.summary.lockedMigrationCount} migrations.`);
  } else {
    console.error("Migration lock validation failed:");
    result.errors.forEach((error) => console.error(`- ${error}`));
  }
  if (!result.ok) process.exit(1);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
