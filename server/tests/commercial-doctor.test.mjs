import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildCommercialDoctorReport,
  parseDotenvText,
  parsePostgresTargetFromEnv,
  selectDoctorPorts,
  selectPostgresTarget
} from "../../scripts/commercial-doctor-core.mjs";
import {
  buildCommercialDevBlockedManifest,
  buildCommercialDevRunningManifest,
  commercialDevPostgresNextSteps,
  redactCommercialDevPath,
  writeCommercialDevManifest
} from "../../scripts/dev-commercial-core.mjs";

const okTools = {
  docker: { ok: true, output: "Docker version 26.0.0" },
  localPostgres: { ok: true, output: "project-local PostgreSQL binaries available" },
  node: { ok: true, output: "v22.22.0" },
  pgDump: { ok: false, output: "command not found" },
  psql: { ok: false, output: "command not found" }
};

const okDatabaseIntegrity = {
  checked: true,
  ok: true,
  found: [
    "audit_logs_prevent_delete",
    "audit_logs_prevent_update",
    "data_import_runs_prevent_delete",
    "data_import_runs_prevent_update",
    "export_records_prevent_delete",
    "export_records_prevent_update"
  ],
  missing: [],
  required: [
    "audit_logs_prevent_delete",
    "audit_logs_prevent_update",
    "data_import_runs_prevent_delete",
    "data_import_runs_prevent_update",
    "export_records_prevent_delete",
    "export_records_prevent_update"
  ]
};

function check(report, name) {
  return report.checks.find((item) => item.name === name);
}

test("commercial doctor warns when Vite is running but the OA API is absent", () => {
  const report = buildCommercialDoctorReport({
    tools: okTools,
    network: {
      apiOpen: false,
      postgresOpen: false,
      webOpen: true,
      webHealth: { ok: false, status: 502, payload: "connect ECONNREFUSED 127.0.0.1:8787" }
    }
  });

  assert.equal(report.failures, 0);
  assert.equal(check(report, "api-port").level, "warn");
  assert.equal(check(report, "vite-api-proxy").level, "warn");
  assert.equal(report.readiness.canRunDockerDrill, true);
  assert.equal(report.readiness.canRunApiSmoke, false);
  assert.equal(report.readiness.nextSteps.some((step) => step.includes("npm run dev:commercial")), true);
  assert.match(check(report, "vite-api-proxy").message, /no OA API listener/i);
  assert.match(check(report, "vite-api-proxy").details.hint, /npm run dev:commercial/);
});

test("commercial doctor fails when the API port is occupied by another service", () => {
  const report = buildCommercialDoctorReport({
    tools: okTools,
    network: {
      apiOpen: true,
      apiHealth: { ok: true, status: 200, payload: { service: "other-api" } },
      postgresOpen: true,
      webOpen: true,
      webHealth: { ok: true, status: 200, payload: { service: "other-api" } }
    }
  });

  assert.equal(check(report, "api-port").level, "fail");
  assert.equal(check(report, "vite-api-proxy").level, "fail");
  assert.equal(report.readiness.canRunDockerDrill, false);
  assert.equal(report.readiness.hardBlockers.some((item) => item.name === "api-port"), true);
  assert.match(check(report, "api-port").message, /not the OA API/);
});

test("commercial doctor passes API and Vite proxy checks when both report the OA API service", () => {
  const report = buildCommercialDoctorReport({
    tools: okTools,
    network: {
      apiOpen: true,
      apiHealth: { ok: true, status: 200, payload: { service: "deep-oa-api" } },
      databaseIntegrity: okDatabaseIntegrity,
      postgresOpen: true,
      webOpen: true,
      webHealth: { ok: true, status: 200, payload: { service: "deep-oa-api" } }
    }
  });

  assert.equal(check(report, "api-port").level, "pass");
  assert.equal(check(report, "vite-api-proxy").level, "pass");
  assert.equal(check(report, "database-append-only-triggers").level, "pass");
  assert.equal(report.readiness.canRunDockerDrill, true);
  assert.equal(report.readiness.canReachPostgres, true);
  assert.equal(report.readiness.canVerifyDatabaseIntegrity, true);
  assert.equal(report.readiness.canRunApiSmoke, true);
  assert.equal(report.readiness.canRunFrontendApiSmoke, true);
});

test("commercial doctor fails when live database append-only triggers are missing", () => {
  const report = buildCommercialDoctorReport({
    tools: okTools,
    network: {
      apiOpen: true,
      apiHealth: { ok: true, status: 200, payload: { service: "deep-oa-api" } },
      databaseIntegrity: {
        checked: true,
        ok: false,
        found: ["audit_logs_prevent_update"],
        missing: ["data_import_runs_prevent_delete"],
        required: okDatabaseIntegrity.required
      },
      postgresOpen: true,
      webOpen: true,
      webHealth: { ok: true, status: 200, payload: { service: "deep-oa-api" } }
    }
  });

  assert.equal(check(report, "database-append-only-triggers").level, "fail");
  assert.match(check(report, "database-append-only-triggers").message, /data_import_runs_prevent_delete/);
  assert.equal(report.readiness.canVerifyDatabaseIntegrity, false);
  assert.equal(report.readiness.hardBlockers.some((item) => item.name === "database-append-only-triggers"), true);
});

test("commercial doctor selects fresh commercial dev manifest ports when env ports are unset", () => {
  const now = Date.parse("2026-05-29T10:00:00.000Z");
  const ports = selectDoctorPorts({
    env: {},
    manifest: {
      apiPort: 8792,
      kind: "commercial-dev-stack",
      parentPid: 12345,
      startedAt: "2026-05-29T09:59:00.000Z",
      status: "running",
      updatedAt: "2026-05-29T09:59:30.000Z",
      webPort: 5182
    },
    now
  });

  assert.equal(ports.api, 8792);
  assert.equal(ports.web, 5182);
  assert.equal(ports.source, "commercial-dev-manifest");
  assert.equal(ports.devManifest.parentPid, 12345);

  const report = buildCommercialDoctorReport({
    ports,
    tools: okTools,
    network: {
      apiOpen: true,
      apiHealth: { ok: true, status: 200, payload: { service: "deep-oa-api" } },
      postgresOpen: true,
      webOpen: true,
      webHealth: { ok: true, status: 200, payload: { service: "deep-oa-api" } }
    }
  });

  assert.match(check(report, "api-port").message, /8792/);
  assert.match(check(report, "vite-api-proxy").details.portSource, /commercial-dev-manifest/);
  assert.equal(report.readiness.canRunApiSmoke, true);
});

test("commercial doctor selects fresh commercial dev manifest PostgreSQL target when env database is unset", () => {
  const now = Date.parse("2026-05-29T10:00:00.000Z");
  const target = selectPostgresTarget({
    env: {},
    manifest: {
      kind: "commercial-dev-stack",
      postgresTarget: {
        host: "127.0.0.1",
        port: 55432,
        source: "DATABASE_URL"
      },
      status: "running",
      updatedAt: "2026-05-29T09:59:30.000Z"
    },
    now
  });

  assert.deepEqual(target, {
    host: "127.0.0.1",
    port: 55432,
    source: "commercial-dev-manifest"
  });

  const envTarget = selectPostgresTarget({
    env: { DATABASE_URL: "postgresql://oa:secret@db.internal:6543/oa_commercial?schema=public" },
    manifest: {
      kind: "commercial-dev-stack",
      postgresTarget: { host: "127.0.0.1", port: 55432 },
      status: "running",
      updatedAt: "2026-05-29T09:59:30.000Z"
    },
    now
  });

  assert.equal(envTarget.host, "db.internal");
  assert.equal(envTarget.port, 6543);
  assert.equal(envTarget.source, "DATABASE_URL");
});

test("commercial doctor falls back to project-local PostgreSQL env when no running dev manifest exists", () => {
  const now = Date.parse("2026-05-29T10:00:00.000Z");
  const localPostgresEnv = parseDotenvText([
    "# generated local development file",
    "DATABASE_URL=\"postgresql://oa:oa_dev_password@127.0.0.1:55432/oa_commercial?schema=public\"",
    "POSTGRES_HOST=\"127.0.0.1\"",
    "POSTGRES_PORT=\"55432\""
  ].join("\n"));

  const target = selectPostgresTarget({
    env: {},
    localPostgresEnv,
    manifest: {
      kind: "commercial-dev-stack",
      postgresTarget: {
        host: "127.0.0.1",
        port: 5432,
        source: "POSTGRES_PORT/default"
      },
      status: "blocked",
      updatedAt: "2026-05-29T09:59:30.000Z"
    },
    now
  });

  assert.deepEqual(target, {
    host: "127.0.0.1",
    port: 55432,
    source: "local-postgres-env"
  });
});

test("commercial doctor ignores stale dev manifest when explicit env ports are provided", () => {
  const ports = selectDoctorPorts({
    env: {
      SERVER_PORT: "8800",
      WEB_PORT: "5190"
    },
    manifest: {
      apiPort: 8792,
      kind: "commercial-dev-stack",
      status: "running",
      updatedAt: "2026-05-28T09:59:30.000Z",
      webPort: 5182
    },
    now: Date.parse("2026-05-29T10:00:00.000Z")
  });

  assert.equal(ports.api, 8800);
  assert.equal(ports.web, 5190);
  assert.equal(ports.source, "environment");
  assert.equal(ports.devManifest, null);
});

test("commercial doctor reports DATABASE_URL PostgreSQL target readiness", () => {
  const target = parsePostgresTargetFromEnv({
    DATABASE_URL: "postgresql://oa:secret@db.internal:6543/oa_commercial?schema=public"
  });
  assert.deepEqual(target, {
    host: "db.internal",
    port: 6543,
    source: "DATABASE_URL"
  });

  const report = buildCommercialDoctorReport({
    database: target,
    tools: {
      ...okTools,
      docker: { ok: false, output: "command not found" }
    },
    network: {
      apiOpen: false,
      postgresOpen: true,
      webOpen: false
    }
  });

  assert.equal(check(report, "docker").level, "fail");
  assert.equal(check(report, "postgres-tcp").level, "pass");
  assert.match(check(report, "postgres-tcp").message, /db\.internal:6543 accepts TCP connections/);
  assert.equal(check(report, "postgres-tcp").details.source, "DATABASE_URL");
  assert.equal(check(report, "local-postgres-bootstrap").level, "pass");
  assert.equal(report.readiness.canRunDockerDrill, false);
  assert.equal(report.readiness.canReachPostgres, true);
});

test("commercial dev blocked manifest is actionable and contains no database secret", () => {
  const manifest = buildCommercialDevBlockedManifest({
    apiPort: 8787,
    manifestPath: "reports/commercial-evidence/dev-stack.json",
    postgresTarget: parsePostgresTargetFromEnv({
      DATABASE_URL: "postgresql://oa:super-secret-password@127.0.0.1:5432/oa_commercial?schema=public"
    }),
    startedAt: "2026-05-30T12:00:00.000Z",
    webPort: 5174
  });

  assert.equal(manifest.kind, "commercial-dev-stack");
  assert.equal(manifest.status, "blocked");
  assert.equal(manifest.manifestPath, "reports/commercial-evidence/dev-stack.json");
  assert.equal(manifest.postgresTarget.host, "127.0.0.1");
  assert.equal(manifest.postgresTarget.port, 5432);
  assert.equal(manifest.postgresTarget.source, "DATABASE_URL");
  assert.equal(manifest.blockers[0].name, "postgres-tcp");
  assert.equal(manifest.nextSteps.some((step) => step.includes("docker compose up -d postgres")), true);
  assert.equal(manifest.nextSteps.some((step) => step.includes("npm run postgres:local -- start")), true);
  assert.deepEqual(manifest.nextSteps, commercialDevPostgresNextSteps());
  assert.doesNotMatch(JSON.stringify(manifest), /super-secret-password|DATABASE_URL=/);
});

test("commercial doctor surfaces Docker-free local PostgreSQL bootstrap guidance", () => {
  const report = buildCommercialDoctorReport({
    tools: {
      ...okTools,
      localPostgres: { ok: false, output: "missing pg_ctl, initdb", missing: ["pg_ctl", "initdb"] }
    },
    network: {
      apiOpen: false,
      postgresOpen: false,
      webOpen: false
    }
  });

  assert.equal(check(report, "local-postgres-bootstrap").level, "warn");
  assert.match(check(report, "local-postgres-bootstrap").message, /missing pg_ctl, initdb/);
  assert.match(check(report, "local-postgres-bootstrap").details.hint, /LOCAL_POSTGRES_BIN_DIR/);
  assert.equal(report.readiness.nextSteps.some((step) => step.includes("postgres:local -- check")), true);
  assert.equal(report.readiness.nextSteps.some((step) => step.includes("postgres:local -- start")), true);
  assert.match(check(report, "postgres-tcp").details.hint, /postgres:local -- start/);
});

test("commercial dev manifests redact local project and home paths", () => {
  const homeDir = "/Users/lizirui";
  const rootDir = "/Users/lizirui/Projects/deep-oa";
  const manifestPath = `${rootDir}/reports/commercial-evidence/dev-stack.json`;
  const blocked = buildCommercialDevBlockedManifest({
    apiPort: 8787,
    homeDir,
    manifestPath,
    postgresTarget: { host: "127.0.0.1", port: 5432, source: "POSTGRES_PORT/default" },
    rootDir,
    startedAt: "2026-05-30T12:00:00.000Z",
    webPort: 5174
  });
  const running = buildCommercialDevRunningManifest({
    apiPid: 123,
    apiPort: 8787,
    homeDir,
    manifestPath,
    parentPid: 999,
    postgresTarget: { host: "127.0.0.1", port: 55432, source: "DATABASE_URL" },
    proxyTarget: "http://127.0.0.1:8787",
    rootDir,
    startedAt: "2026-05-30T12:00:00.000Z",
    webPid: 456,
    webPort: 5174
  });
  const serialized = JSON.stringify({ blocked, running });

  assert.equal(blocked.manifestPath, "[PROJECT_ROOT]/reports/commercial-evidence/dev-stack.json");
  assert.equal(running.manifestPath, "[PROJECT_ROOT]/reports/commercial-evidence/dev-stack.json");
  assert.deepEqual(running.postgresTarget, { host: "127.0.0.1", port: 55432, source: "DATABASE_URL" });
  assert.equal(redactCommercialDevPath("/Users/lizirui/Desktop/dev-stack.json", { homeDir, rootDir }), "[HOME]/Desktop/dev-stack.json");
  assert.doesNotMatch(serialized, /\/Users\/lizirui|\/Users\/lizirui\/Projects\/deep-oa/);
});

test("commercial dev manifest writer uses private mode and redacts path and database password text", () => {
  const dir = mkdtempSync(join(tmpdir(), "commercial-dev-manifest-"));
  try {
    const path = join(dir, "dev-stack.json");
    const rootDir = join(dir, "project");
    writeCommercialDevManifest(path, {
      databaseUrl: "postgresql://oa:super-secret-password@127.0.0.1:5432/oa_commercial",
      kind: "commercial-dev-stack",
      manifestPath: `${rootDir}/reports/commercial-evidence/dev-stack.json`,
      status: "running",
      trace: `${rootDir}/server.log`
    }, { homeDir: dir, rootDir });

    const text = readFileSync(path, "utf8");
    assert.equal((statSync(path).mode & 0o777).toString(8), "600");
    assert.match(text, /\[PROJECT_ROOT\]/);
    assert.doesNotMatch(text, new RegExp(rootDir.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(text, /super-secret-password/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("commercial doctor reports Docker as the hard drill blocker", () => {
  const report = buildCommercialDoctorReport({
    tools: {
      ...okTools,
      docker: { ok: false, output: "command not found" }
    },
    network: {
      apiOpen: false,
      postgresOpen: false,
      webOpen: false
    }
  });

  assert.equal(check(report, "docker").level, "fail");
  assert.equal(report.readiness.canRunDockerDrill, false);
  assert.equal(report.readiness.hardBlockers.some((item) => item.name === "docker"), true);
  assert.equal(report.readiness.nextSteps.some((step) => step.includes("Docker Desktop")), true);
});

test("commercial doctor accepts validated GitHub drill evidence when local Docker is unavailable", () => {
  const report = buildCommercialDoctorReport({
    tools: {
      ...okTools,
      docker: { ok: false, output: "command not found" },
      drillEvidence: {
        ok: true,
        summaryPath: "/project/commercial-evidence/latest-drill-summary.json",
        errors: [],
        warnings: []
      }
    },
    network: {
      apiOpen: false,
      postgresOpen: false,
      webOpen: false
    }
  });

  assert.equal(check(report, "docker").level, "warn");
  assert.equal(check(report, "docker-drill-evidence").level, "pass");
  assert.equal(report.failures, 0);
  assert.equal(report.readiness.canRunDockerDrill, true);
  assert.equal(report.readiness.hardBlockers.some((item) => item.name === "docker"), false);
});
