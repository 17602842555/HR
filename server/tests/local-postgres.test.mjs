import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildCheckReport,
  buildDatabaseUrl,
  buildLocalPostgresConfig,
  parseLocalPostgresArgs,
  renderLocalPostgresEnv,
  resolvePostgresBinaries,
  runLocalPostgresCli
} from "../../scripts/local-postgres.mjs";

function tempRoot() {
  return mkdtempSync(join(tmpdir(), "oa-local-postgres-test-"));
}

test("local postgres config builds a project-local PostgreSQL URL without changing provider", () => {
  const root = tempRoot();
  try {
    const config = buildLocalPostgresConfig({
      LOCAL_POSTGRES_DB: "oa_commercial_local",
      LOCAL_POSTGRES_PASSWORD: "dev-password",
      LOCAL_POSTGRES_PORT: "55433",
      LOCAL_POSTGRES_USER: "oa_user",
      PATH: ""
    }, root);

    assert.equal(config.port, 55433);
    assert.equal(config.database, "oa_commercial_local");
    assert.equal(config.user, "oa_user");
    assert.equal(
      buildDatabaseUrl(config),
      "postgresql://oa_user:dev-password@127.0.0.1:55433/oa_commercial_local?schema=public"
    );
    assert.match(config.dataDir, /\.local-postgres\/data$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("local postgres config rejects unsafe database identifiers", () => {
  const root = tempRoot();
  try {
    assert.throws(
      () => buildLocalPostgresConfig({ LOCAL_POSTGRES_DB: "oa;drop", PATH: "" }, root),
      /LOCAL_POSTGRES_DB must be a safe PostgreSQL identifier/
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("local postgres binary resolver accepts explicit binary directory", () => {
  const root = tempRoot();
  const binDir = join(root, "bin");
  try {
    mkdirSync(binDir, { recursive: true });
    for (const name of ["pg_ctl", "initdb", "psql", "createdb"]) {
      writeFileSync(join(binDir, name), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      chmodSync(join(binDir, name), 0o755);
    }
    const resolved = resolvePostgresBinaries({ LOCAL_POSTGRES_BIN_DIR: binDir, PATH: "" });
    assert.deepEqual(resolved.missing, []);
    assert.equal(resolved.binaries.pg_ctl, join(binDir, "pg_ctl"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("local postgres check reports actionable missing binary next steps", () => {
  const root = tempRoot();
  try {
    const config = buildLocalPostgresConfig({ PATH: "" }, root);
    const report = buildCheckReport({
      config,
      resolved: {
        binaries: {},
        missing: ["pg_ctl", "initdb", "psql", "createdb"],
        searchDirs: [join(root, "empty-bin")]
      }
    });
    assert.equal(report.ok, false);
    assert.deepEqual(report.missingBinaries, ["pg_ctl", "initdb", "psql", "createdb"]);
    assert(report.nextSteps.some((step) => step.includes("brew install postgresql@16")));
    assert.equal(report.databaseUrl.includes("oa_dev_password"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("local postgres write-env creates API-required dotenv without plaintext production claims", () => {
  const root = tempRoot();
  const originalLog = console.log;
  try {
    console.log = () => {};
    const exitCode = runLocalPostgresCli(["write-env", "--json"], {
      LOCAL_POSTGRES_DIR: root,
      LOCAL_POSTGRES_PASSWORD: "dev-password",
      PATH: ""
    }, root);
    assert.equal(exitCode, 0);
    const dotenv = readFileSync(join(root, ".env.local-postgres"), "utf8");
    assert.match(dotenv, /DATABASE_URL="postgresql:\/\/oa:dev-password@127\.0\.0\.1:55432\/oa_commercial\?schema=public"/);
    assert.match(dotenv, /VITE_REQUIRE_API="1"/);
    assert.match(dotenv, /VITE_DEMO_FALLBACK="0"/);
    assert.match(dotenv, /Local development only/);
  } finally {
    console.log = originalLog;
    rmSync(root, { recursive: true, force: true });
  }
});

test("local postgres CLI parser defaults to check and supports json flag", () => {
  assert.deepEqual(parseLocalPostgresArgs(["--json"]), { action: "check", json: true });
  assert.deepEqual(parseLocalPostgresArgs(["status"]), { action: "status", json: false });
});

test("local postgres dotenv renderer keeps generated values quoted", () => {
  const root = tempRoot();
  try {
    const config = buildLocalPostgresConfig({
      LOCAL_POSTGRES_PASSWORD: "quoted\"password",
      PATH: ""
    }, root);
    const dotenv = renderLocalPostgresEnv(config);
    assert.match(dotenv, /POSTGRES_PASSWORD="quoted\\"password"/);
    assert.match(dotenv, /SERVER_PORT="8787"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
