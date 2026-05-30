import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const rootDir = resolve(new URL("../..", import.meta.url).pathname);

function sha256Text(text) {
  return createHash("sha256").update(text).digest("hex");
}

async function writeBackupWithMeta(dir, name, content, metadata) {
  const backupPath = join(dir, name);
  await writeFile(backupPath, content);
  await writeFile(
    `${backupPath}.meta`,
    `${Object.entries({
      ...metadata,
      backup_file: backupPath,
      sha256: sha256Text(content)
    }).map(([key, value]) => `${key}=${value}`).join("\n")}\n`
  );
  return backupPath;
}

function testEnv(overrides = {}) {
  return {
    ...process.env,
    ENV_FILE: join(rootDir, ".env.test-does-not-exist"),
    SKIP_OPS_AUDIT: "1",
    ...overrides
  };
}

function runScript(script, backupPath, env = {}) {
  return spawnSync("bash", [join(rootDir, "scripts", script), backupPath, "--yes"], {
    cwd: rootDir,
    env: testEnv(env),
    encoding: "utf8"
  });
}

function runFileBackup(env = {}) {
  return spawnSync("bash", [join(rootDir, "scripts", "backup-files.sh")], {
    cwd: rootDir,
    env: testEnv(env),
    encoding: "utf8"
  });
}

function runDatabaseBackup(env = {}) {
  return spawnSync("bash", [join(rootDir, "scripts", "backup-postgres.sh")], {
    cwd: rootDir,
    env: testEnv(env),
    encoding: "utf8"
  });
}

function runPruneBackups(env = {}) {
  return spawnSync("bash", [join(rootDir, "scripts", "prune-backups.sh")], {
    cwd: rootDir,
    env: testEnv(env),
    encoding: "utf8"
  });
}

test("database restore blocks backup metadata database mismatch before pg_restore", async () => {
  const dir = await mkdtemp(join(tmpdir(), "oa-restore-db-meta-"));
  try {
    const backupPath = await writeBackupWithMeta(dir, "backup.dump", "not-a-real-dump", {
      artifact_type: "database",
      app_env: "development",
      database: "source_db",
      service: "postgres"
    });

    const result = runScript("restore-postgres.sh", backupPath, {
      APP_ENV: "development",
      POSTGRES_DB: "target_db",
      BACKUP_USE_LOCAL_PG_RESTORE: "1",
      DATABASE_URL: "postgres://postgres:change-me@127.0.0.1:5432/target_db"
    });

    assert.equal(result.status, 66);
    assert.match(result.stderr, /metadata database mismatch/);
    assert.doesNotMatch(result.stderr, /Missing required command: pg_restore/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("database restore can explicitly allow cross-database recovery and then reaches restore command", async () => {
  const dir = await mkdtemp(join(tmpdir(), "oa-restore-db-override-"));
  try {
    const backupPath = await writeBackupWithMeta(dir, "backup.dump", "not-a-real-dump", {
      artifact_type: "database",
      app_env: "development",
      database: "source_db",
      service: "postgres"
    });

    const result = runScript("restore-postgres.sh", backupPath, {
      ALLOW_RESTORE_DATABASE_MISMATCH: "1",
      APP_ENV: "development",
      POSTGRES_DB: "target_db",
      BACKUP_USE_LOCAL_PG_RESTORE: "1",
      DATABASE_URL: "postgres://postgres:change-me@127.0.0.1:5432/target_db"
    });

    assert.notEqual(result.status, 66);
    assert.match(result.stdout, /Restoring '.*backup\.dump' into database 'target_db' in 'development'/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("file storage restore blocks backup metadata environment mismatch before tar validation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "oa-restore-file-meta-"));
  try {
    const backupPath = await writeBackupWithMeta(dir, "files.tar.gz", "not-a-real-tar", {
      artifact_type: "file_storage",
      app_env: "staging",
      storage_mode: "local",
      file_count: "1"
    });

    const result = runScript("restore-files.sh", backupPath, {
      APP_ENV: "production",
      ALLOW_PRODUCTION_FILE_RESTORE: "1",
      FILE_BACKUP_USE_LOCAL: "1",
      FILE_STORAGE_DIR: join(dir, "restore-target")
    });

    assert.equal(result.status, 66);
    assert.match(result.stderr, /metadata app_env mismatch/);
    assert.doesNotMatch(result.stderr, /Unable to list file backup archive/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("file storage restore blocks database artifacts before destructive local restore", async () => {
  const dir = await mkdtemp(join(tmpdir(), "oa-restore-file-artifact-"));
  try {
    const backupPath = await writeBackupWithMeta(dir, "files.tar.gz", "not-a-real-tar", {
      artifact_type: "database",
      app_env: "development",
      storage_mode: "local",
      file_count: "1"
    });

    const result = runScript("restore-files.sh", backupPath, {
      APP_ENV: "development",
      FILE_BACKUP_USE_LOCAL: "1",
      FILE_STORAGE_DIR: join(dir, "restore-target")
    });

    assert.equal(result.status, 66);
    assert.match(result.stderr, /metadata artifact_type mismatch/);
    assert.doesNotMatch(result.stderr, /Unable to list file backup archive/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("file storage backup refuses S3 object storage tar backup", () => {
  const result = runFileBackup({
    APP_ENV: "production",
    FILE_STORAGE_DRIVER: "s3",
    FILE_STORAGE_DIR: "/app/storage/files",
    FILE_BACKUP_USE_LOCAL: "1"
  });

  assert.equal(result.status, 64);
  assert.match(result.stderr, /FILE_STORAGE_DRIVER=s3 uses object storage/);
  assert.doesNotMatch(result.stderr, /Missing required command: docker/);
});

test("file storage backup requires explicit absolute production directory", () => {
  const result = runFileBackup({
    APP_ENV: "production",
    FILE_STORAGE_DRIVER: "local",
    FILE_STORAGE_DIR: "",
    FILE_BACKUP_USE_LOCAL: "1"
  });

  assert.equal(result.status, 66);
  assert.match(result.stderr, /Production FILE_STORAGE_DIR must be explicitly configured/);
  assert.doesNotMatch(result.stderr, /Starting file storage backup/);
});

test("database backup requires explicit durable production backup directory", () => {
  const result = runDatabaseBackup({
    APP_ENV: "production",
    BACKUP_DIR: "",
    BACKUP_USE_LOCAL_PG_DUMP: "1",
    DATABASE_URL: "postgres://postgres:change-me@127.0.0.1:5432/target_db"
  });

  assert.equal(result.status, 66);
  assert.match(result.stderr, /Production BACKUP_DIR must be explicitly configured/);
  assert.doesNotMatch(result.stderr, /Missing required command: pg_dump/);
});

test("database backup refuses project-local production backup directory", () => {
  const result = runDatabaseBackup({
    APP_ENV: "production",
    BACKUP_DIR: join(rootDir, "backups", "postgres"),
    BACKUP_USE_LOCAL_PG_DUMP: "1",
    DATABASE_URL: "postgres://postgres:change-me@127.0.0.1:5432/target_db"
  });

  assert.equal(result.status, 66);
  assert.match(result.stderr, /Production BACKUP_DIR must be durable off-app storage/);
  assert.doesNotMatch(result.stderr, /Starting Postgres backup/);
});

test("database backup strips Prisma-only DATABASE_URL params before local pg_dump", async () => {
  const dir = await mkdtemp(join(tmpdir(), "oa-backup-pg-url-"));
  try {
    const binDir = join(dir, "bin");
    const argsFile = join(dir, "pg-dump-args.txt");
    await mkdir(binDir, { recursive: true });
    await writeFile(join(binDir, "pg_dump"), `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$@" > "$MOCK_ARGS_FILE"
output=""
for arg in "$@"; do
  case "$arg" in
    --file=*) output="\${arg#--file=}" ;;
  esac
done
printf 'mock custom dump' > "$output"
`);
    await chmod(join(binDir, "pg_dump"), 0o755);

    const result = runDatabaseBackup({
      APP_ENV: "development",
      BACKUP_DIR: join(dir, "backups"),
      BACKUP_USE_LOCAL_PG_DUMP: "1",
      DATABASE_URL: "postgresql://oa:secret@127.0.0.1:55432/oa_commercial?schema=public&connection_limit=1&sslmode=require",
      MOCK_ARGS_FILE: argsFile,
      PATH: `${binDir}:${process.env.PATH}`
    });

    assert.equal(result.status, 0, result.stderr);
    const args = await readFile(argsFile, "utf8");
    assert.match(args, /--dbname=postgresql:\/\/oa:secret@127\.0\.0\.1:55432\/oa_commercial\?sslmode=require/);
    assert.doesNotMatch(args, /schema=public/);
    assert.doesNotMatch(args, /connection_limit=1/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("database restore strips Prisma-only DATABASE_URL params before local pg_restore", async () => {
  const dir = await mkdtemp(join(tmpdir(), "oa-restore-pg-url-"));
  try {
    const binDir = join(dir, "bin");
    const argsFile = join(dir, "pg-restore-args.txt");
    const backupPath = await writeBackupWithMeta(dir, "backup.dump", "mock custom dump", {
      artifact_type: "database",
      app_env: "development",
      database: "target_db",
      service: "postgres"
    });
    await mkdir(binDir, { recursive: true });
    await writeFile(join(binDir, "pg_restore"), `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$@" > "$MOCK_ARGS_FILE"
`);
    await chmod(join(binDir, "pg_restore"), 0o755);

    const result = runScript("restore-postgres.sh", backupPath, {
      APP_ENV: "development",
      POSTGRES_DB: "target_db",
      BACKUP_USE_LOCAL_PG_RESTORE: "1",
      DATABASE_URL: "postgresql://oa:secret@127.0.0.1:55432/target_db?schema=public&pool_timeout=10&sslmode=require",
      MOCK_ARGS_FILE: argsFile,
      PATH: `${binDir}:${process.env.PATH}`
    });

    assert.equal(result.status, 0, result.stderr);
    const args = await readFile(argsFile, "utf8");
    assert.match(args, /--dbname=postgresql:\/\/oa:secret@127\.0\.0\.1:55432\/target_db\?sslmode=require/);
    assert.doesNotMatch(args, /schema=public/);
    assert.doesNotMatch(args, /pool_timeout=10/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("file storage backup refuses project-local production backup directory", () => {
  const result = runFileBackup({
    APP_ENV: "production",
    FILE_STORAGE_DRIVER: "local",
    FILE_STORAGE_DIR: "/srv/oa/files",
    FILE_BACKUP_DIR: join(rootDir, "backups", "files"),
    FILE_BACKUP_USE_LOCAL: "1"
  });

  assert.equal(result.status, 66);
  assert.match(result.stderr, /Production FILE_BACKUP_DIR must be durable off-app storage/);
  assert.doesNotMatch(result.stderr, /Starting file storage backup/);
});

test("production backup prune apply requires durable backup directories", () => {
  const result = runPruneBackups({
    APP_ENV: "production",
    ALLOW_PRODUCTION_PRUNE: "1",
    PRUNE_APPLY: "1",
    BACKUP_DIR: join(rootDir, "backups", "postgres"),
    FILE_BACKUP_DIR: "/backups/files"
  });

  assert.equal(result.status, 66);
  assert.match(result.stderr, /Production BACKUP_DIR must be durable off-app storage/);
  assert.doesNotMatch(result.stdout, /Backup prune complete/);
});

test("file storage restore refuses S3 object storage tar restore before artifact lookup", () => {
  const result = runScript("restore-files.sh", "missing.tar.gz", {
    APP_ENV: "development",
    FILE_STORAGE_DRIVER: "s3"
  });

  assert.equal(result.status, 64);
  assert.match(result.stderr, /FILE_STORAGE_DRIVER=s3 uses object storage/);
  assert.doesNotMatch(result.stderr, /File storage backup not found/);
});

test("file storage restore requires explicit absolute production directory before artifact lookup", () => {
  const result = runScript("restore-files.sh", "missing.tar.gz", {
    APP_ENV: "production",
    ALLOW_PRODUCTION_FILE_RESTORE: "1",
    FILE_STORAGE_DRIVER: "local",
    FILE_STORAGE_DIR: ""
  });

  assert.equal(result.status, 66);
  assert.match(result.stderr, /Production FILE_STORAGE_DIR must be explicitly configured/);
  assert.doesNotMatch(result.stderr, /File storage backup not found/);
});
