import "dotenv/config";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import net from "node:net";
import { isAbsolute, resolve } from "node:path";
import { PrismaClient } from "@prisma/client";
import { requiredAppendOnlyTriggers } from "../server/src/modules/system/database-integrity.mjs";
import {
  buildCommercialDoctorReport,
  parseDotenvText,
  printCommercialDoctorHuman,
  selectDoctorPorts,
  selectPostgresTarget
} from "./commercial-doctor-core.mjs";
import { resolvePostgresBinaries } from "./local-postgres.mjs";

const root = resolve(new URL("..", import.meta.url).pathname);

function commercialDevManifestPath(env = process.env) {
  const configured = env.COMMERCIAL_DEV_MANIFEST || "reports/commercial-evidence/dev-stack.json";
  return isAbsolute(configured) ? configured : resolve(root, configured);
}

function pidIsAlive(pid) {
  const parsed = Number.parseInt(pid, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return false;
  try {
    process.kill(parsed, 0);
    return true;
  } catch {
    return false;
  }
}

function readCommercialDevManifest(env = process.env) {
  const manifestPath = commercialDevManifestPath(env);
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (manifest?.kind !== "commercial-dev-stack") return null;
    if (manifest.parentPid && !pidIsAlive(manifest.parentPid)) return null;
    return manifest;
  } catch {
    return null;
  }
}

function localPostgresEnvPath(env = process.env) {
  const configured = env.LOCAL_POSTGRES_ENV || ".local-postgres/.env.local-postgres";
  return isAbsolute(configured) ? configured : resolve(root, configured);
}

function readLocalPostgresEnv(env = process.env) {
  try {
    return parseDotenvText(readFileSync(localPostgresEnvPath(env), "utf8"));
  } catch {
    return null;
  }
}

function commandCheck(command, args = ["--version"]) {
  try {
    const output = execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { ok: true, output: output.trim().split("\n")[0] || "ok" };
  } catch (error) {
    return { ok: false, output: error.code === "ENOENT" ? "command not found" : String(error.message || error) };
  }
}

function listenerInfo(port) {
  try {
    const output = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
    return output || "";
  } catch {
    return "";
  }
}

function tcpOpen(port, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    socket.setTimeout(1200);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => resolve(false));
  });
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2500);
  try {
    const response = await fetch(url, { signal: controller.signal });
    const text = await response.text();
    let payload = text;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = text.slice(0, 160);
    }
    return { ok: response.ok, status: response.status, payload };
  } catch (error) {
    return { ok: false, status: 0, payload: error.name === "AbortError" ? "request timed out" : error.message };
  } finally {
    clearTimeout(timeout);
  }
}

function redactErrorText(value = "") {
  return String(value)
    .replaceAll(/:\/\/([^:\s/@]+):([^@\s]+)@/g, "://$1:***@")
    .replaceAll(process.cwd(), "[PROJECT_ROOT]")
    .slice(0, 240);
}

function selectedDatabaseUrl({ env = process.env, localPostgresEnv = null } = {}) {
  return env.DATABASE_URL || localPostgresEnv?.DATABASE_URL || "";
}

async function checkAppendOnlyTriggers(databaseUrl) {
  if (!databaseUrl) {
    return {
      checked: false,
      message: "Append-only trigger check skipped because DATABASE_URL is unavailable."
    };
  }

  const triggerListSql = requiredAppendOnlyTriggers.map((name) => `'${name}'`).join(", ");
  const prisma = new PrismaClient({
    datasources: { db: { url: databaseUrl } },
    log: []
  });

  try {
    const rows = await prisma.$queryRawUnsafe(`
      SELECT tgname
      FROM pg_trigger
      WHERE NOT tgisinternal
        AND tgname IN (${triggerListSql})
      ORDER BY tgname
    `);
    const found = rows.map((row) => row.tgname).sort();
    const missing = requiredAppendOnlyTriggers.filter((name) => !found.includes(name));
    return {
      checked: true,
      ok: missing.length === 0,
      found,
      missing,
      required: requiredAppendOnlyTriggers
    };
  } catch (error) {
    return {
      checked: true,
      ok: false,
      found: [],
      missing: requiredAppendOnlyTriggers,
      required: requiredAppendOnlyTriggers,
      error: redactErrorText(error?.message || error)
    };
  } finally {
    await prisma.$disconnect().catch(() => {});
  }
}

const node = commandCheck("node", ["--version"]);

const docker = commandCheck("docker", ["--version"]);

const psql = commandCheck("psql", ["--version"]);

const pgDump = commandCheck("pg_dump", ["--version"]);
const localPostgresBinaries = resolvePostgresBinaries(process.env);
const localPostgres = {
  ok: localPostgresBinaries.missing.length === 0,
  missing: localPostgresBinaries.missing,
  output: localPostgresBinaries.missing.length === 0
    ? "project-local PostgreSQL binaries available"
    : `missing ${localPostgresBinaries.missing.join(", ")}`
};

const devManifest = readCommercialDevManifest();
const localPostgresEnv = readLocalPostgresEnv();
const postgresTarget = selectPostgresTarget({
  env: process.env,
  localPostgresEnv,
  manifest: devManifest
});
const postgresOpen = await tcpOpen(postgresTarget.port, postgresTarget.host);
const databaseIntegrity = postgresOpen
  ? await checkAppendOnlyTriggers(selectedDatabaseUrl({ env: process.env, localPostgresEnv }))
  : { checked: false };
const selectedPorts = selectDoctorPorts({
  env: process.env,
  manifest: devManifest
});

const apiOpen = await tcpOpen(selectedPorts.api);
const apiListener = listenerInfo(selectedPorts.api);
const apiHealth = apiOpen ? await fetchJson(`http://127.0.0.1:${selectedPorts.api}/api/health`) : null;

const webOpen = await tcpOpen(selectedPorts.web);
const webHealth = webOpen ? await fetchJson(`http://127.0.0.1:${selectedPorts.web}/api/health`) : null;

const report = buildCommercialDoctorReport({
  database: postgresTarget,
  ports: {
    ...selectedPorts,
    postgres: postgresTarget.port,
    web: selectedPorts.web
  },
  tools: {
    node,
    docker,
    localPostgres,
    psql,
    pgDump
  },
  network: {
    postgresOpen,
    databaseIntegrity,
    apiOpen,
    apiListener,
    apiHealth,
    webOpen,
    webHealth
  }
});

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(report, null, 2));
} else {
  printCommercialDoctorHuman(report);
}

if (report.failures > 0) process.exitCode = 1;
