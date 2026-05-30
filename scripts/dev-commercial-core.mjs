import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, relative } from "node:path";

export function commercialDevPostgresNextSteps() {
  return [
    "Start a reachable PostgreSQL before launching the commercial dev stack.",
    "For Docker Compose, run: docker compose up -d postgres",
    "Without Docker, run: npm run postgres:local -- check --json, then npm run postgres:local -- start",
    "Or set DATABASE_URL to a reachable PostgreSQL connection string.",
    "Then rerun: npm run dev:commercial",
    "For diagnostics, run: npm run doctor:commercial -- --json"
  ];
}

function normalizeManifestPath(value) {
  return String(value || "").replaceAll("\\", "/");
}

function isWithinPath(parent, child) {
  if (!parent || !child) return false;
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function redactCommercialDevPath(value, {
  homeDir = process.env.HOME || "",
  rootDir = process.cwd()
} = {}) {
  const path = String(value || "");
  if (!path) return "";
  if (!isAbsolute(path)) return normalizeManifestPath(path);

  if (rootDir && isWithinPath(rootDir, path)) {
    const rel = normalizeManifestPath(relative(rootDir, path));
    return rel ? `[PROJECT_ROOT]/${rel}` : "[PROJECT_ROOT]";
  }

  if (homeDir && isWithinPath(homeDir, path)) {
    const rel = normalizeManifestPath(relative(homeDir, path));
    return rel ? `[HOME]/${rel}` : "[HOME]";
  }

  return `[ABSOLUTE_PATH]/${basename(path)}`;
}

export function redactCommercialDevManifestText(text, {
  homeDir = process.env.HOME || "",
  rootDir = process.cwd()
} = {}) {
  let value = String(text || "");
  if (rootDir) value = value.replaceAll(String(rootDir), "[PROJECT_ROOT]");
  if (homeDir && homeDir !== rootDir) value = value.replaceAll(String(homeDir), "[HOME]");
  return value.replace(/(postgres(?:ql)?:\/\/[^:\s/]+:)([^@\s/]+)(@)/gi, "$1***$3");
}

export function writeCommercialDevManifest(path, manifest, context = {}) {
  mkdirSync(dirname(path), { recursive: true });
  const text = redactCommercialDevManifestText(`${JSON.stringify(manifest, null, 2)}\n`, context);
  writeFileSync(path, text, { mode: 0o600 });
  chmodSync(path, 0o600);
}

export function buildCommercialDevBlockedManifest({
  apiPort,
  homeDir,
  manifestPath = "",
  postgresTarget = {},
  rootDir,
  startedAt = new Date().toISOString(),
  webPort
} = {}) {
  const target = {
    host: postgresTarget.host || "127.0.0.1",
    port: postgresTarget.port || 5432,
    source: postgresTarget.source || "POSTGRES_PORT/default"
  };
  return {
    apiPort,
    blockers: [
      {
        name: "postgres-tcp",
        message: `${target.host}:${target.port} is closed.`,
        source: target.source
      }
    ],
    kind: "commercial-dev-stack",
    manifestPath: redactCommercialDevPath(manifestPath, { homeDir, rootDir }),
    nextSteps: commercialDevPostgresNextSteps(),
    postgresTarget: target,
    root: ".",
    startedAt,
    status: "blocked",
    updatedAt: startedAt,
    webPort
  };
}

export function buildCommercialDevRunningManifest({
  apiPid = null,
  apiPort,
  homeDir,
  manifestPath = "",
  parentPid = null,
  postgresTarget = {},
  proxyTarget = "",
  rootDir,
  startedAt = new Date().toISOString(),
  webPid = null,
  webPort
} = {}) {
  return {
    apiPid,
    apiPort,
    kind: "commercial-dev-stack",
    manifestPath: redactCommercialDevPath(manifestPath, { homeDir, rootDir }),
    parentPid,
    postgresTarget: {
      host: postgresTarget.host || "127.0.0.1",
      port: postgresTarget.port || 5432,
      source: postgresTarget.source || "POSTGRES_PORT/default"
    },
    proxyTarget,
    root: ".",
    startedAt,
    status: "running",
    updatedAt: startedAt,
    webPid,
    webPort
  };
}
