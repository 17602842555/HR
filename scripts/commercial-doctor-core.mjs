export const DEFAULT_DOCTOR_PORTS = Object.freeze({
  api: 8787,
  postgres: 5432,
  web: 5174
});

export const DEV_MANIFEST_MAX_AGE_MS = 12 * 60 * 60 * 1000;

export function status(level, name, message, details = {}) {
  return { level, name, message, details };
}

export function levelFromTool(required, check) {
  if (check?.ok) return "pass";
  return required ? "fail" : "warn";
}

function isOaApi(health) {
  return Boolean(health?.payload?.service === "deep-oa-api");
}

function parsePortValue(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 && parsed < 65536 ? parsed : null;
}

export function parsePostgresTargetFromEnv(env = {}) {
  const defaultPort = parsePortValue(env.POSTGRES_PORT) ?? DEFAULT_DOCTOR_PORTS.postgres;
  const rawUrl = env.DATABASE_URL;
  if (rawUrl) {
    try {
      const parsed = new URL(rawUrl);
      if (["postgres:", "postgresql:"].includes(parsed.protocol)) {
        return {
          host: parsed.hostname.replace(/^\[(.*)\]$/, "$1") || "127.0.0.1",
          port: parsePortValue(parsed.port) ?? DEFAULT_DOCTOR_PORTS.postgres,
          source: "DATABASE_URL"
        };
      }
    } catch {
      return {
        host: "127.0.0.1",
        port: defaultPort,
        source: "POSTGRES_PORT/default"
      };
    }
  }
  return {
    host: env.POSTGRES_HOST || "127.0.0.1",
    port: defaultPort,
    source: env.POSTGRES_HOST ? "POSTGRES_HOST/POSTGRES_PORT" : "POSTGRES_PORT/default"
  };
}

export function parseDotenvText(text = "") {
  return String(text).split(/\r?\n/).reduce((acc, line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return acc;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) return acc;
    let value = match[2].trim();
    if (
      (value.startsWith("\"") && value.endsWith("\""))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    acc[match[1]] = value.replaceAll("\\\"", "\"").replaceAll("\\\\", "\\");
    return acc;
  }, {});
}

function manifestIsFresh(manifest, now, maxAgeMs) {
  const rawUpdatedAt = manifest?.updatedAt || manifest?.startedAt || "";
  const updatedAt = Date.parse(rawUpdatedAt);
  return Number.isFinite(updatedAt) && now - updatedAt >= 0 && now - updatedAt <= maxAgeMs;
}

function envHasPostgresTarget(env = {}) {
  return Boolean(env.DATABASE_URL || env.POSTGRES_HOST || env.POSTGRES_PORT);
}

export function selectPostgresTarget({
  env = {},
  localPostgresEnv = null,
  manifest = null,
  now = Date.now(),
  maxAgeMs = DEV_MANIFEST_MAX_AGE_MS
} = {}) {
  const envTarget = parsePostgresTargetFromEnv(env);
  if (envHasPostgresTarget(env)) return envTarget;

  const manifestValid = manifest?.kind === "commercial-dev-stack"
    && manifest?.status === "running"
    && manifestIsFresh(manifest, now, maxAgeMs);
  const manifestTarget = manifestValid ? manifest.postgresTarget : null;
  const manifestPort = parsePortValue(manifestTarget?.port);
  const manifestHost = String(manifestTarget?.host || "").trim();
  if (manifestHost && manifestPort) {
    return {
      host: manifestHost.replace(/^\[(.*)\]$/, "$1"),
      port: manifestPort,
      source: "commercial-dev-manifest"
    };
  }

  if (localPostgresEnv && envHasPostgresTarget(localPostgresEnv)) {
    const localTarget = parsePostgresTargetFromEnv(localPostgresEnv);
    return {
      ...localTarget,
      source: "local-postgres-env"
    };
  }

  return envTarget;
}

export function selectDoctorPorts({
  env = {},
  manifest = null,
  now = Date.now(),
  maxAgeMs = DEV_MANIFEST_MAX_AGE_MS
} = {}) {
  const envApi = parsePortValue(env.SERVER_PORT);
  const envWeb = parsePortValue(env.WEB_PORT);
  const manifestValid = manifest?.kind === "commercial-dev-stack"
    && manifest?.status === "running"
    && manifestIsFresh(manifest, now, maxAgeMs);
  const manifestApi = manifestValid ? parsePortValue(manifest.apiPort) : null;
  const manifestWeb = manifestValid ? parsePortValue(manifest.webPort) : null;

  const apiUsesManifest = envApi == null && manifestApi != null;
  const webUsesManifest = envWeb == null && manifestWeb != null;
  const sources = [];
  if (envApi != null || envWeb != null) sources.push("environment");
  if (apiUsesManifest || webUsesManifest) sources.push("commercial-dev-manifest");

  const api = envApi ?? manifestApi ?? DEFAULT_DOCTOR_PORTS.api;
  const web = envWeb ?? manifestWeb ?? DEFAULT_DOCTOR_PORTS.web;
  if (sources.length === 0) sources.push("default");
  if ((envApi == null && manifestApi == null) || (envWeb == null && manifestWeb == null)) sources.push("default");

  return {
    api,
    postgres: parsePortValue(env.POSTGRES_PORT) ?? DEFAULT_DOCTOR_PORTS.postgres,
    web,
    source: [...new Set(sources)].join("+"),
    devManifest: apiUsesManifest || webUsesManifest
      ? {
          apiPort: manifestApi,
          parentPid: manifest.parentPid || null,
          startedAt: manifest.startedAt || "",
          updatedAt: manifest.updatedAt || "",
          webPort: manifestWeb
        }
      : null
  };
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function buildReadinessSummary(checks) {
  const byName = new Map(checks.map((item) => [item.name, item]));
  const checkLevel = (name) => byName.get(name)?.level || "warn";
  const hardBlockers = checks
    .filter((item) => item.level === "fail")
    .map((item) => ({ name: item.name, message: item.message }));
  const warnings = checks
    .filter((item) => item.level === "warn")
    .map((item) => ({ name: item.name, message: item.message }));
  const nextSteps = unique(checks
    .filter((item) => item.level !== "pass")
    .map((item) => item.details?.hint));

  return {
    canRunDockerDrill: checkLevel("node") === "pass" && checkLevel("docker") === "pass" && hardBlockers.length === 0,
    canReachPostgres: checkLevel("postgres-tcp") === "pass",
    canVerifyDatabaseIntegrity: checkLevel("database-append-only-triggers") === "pass",
    canRunApiSmoke: checkLevel("api-port") === "pass",
    canRunFrontendApiSmoke: checkLevel("vite-api-proxy") === "pass",
    hardBlockers,
    warnings,
    nextSteps
  };
}

export function buildCommercialDoctorReport({
  database = {},
  ports = DEFAULT_DOCTOR_PORTS,
  tools = {},
  network = {}
} = {}) {
  const apiPort = ports.api || DEFAULT_DOCTOR_PORTS.api;
  const portSource = ports.source || "default";
  const devManifest = ports.devManifest || null;
  const postgresHost = database.host || "127.0.0.1";
  const postgresPort = database.port || ports.postgres || DEFAULT_DOCTOR_PORTS.postgres;
  const postgresSource = database.source || "POSTGRES_PORT/default";
  const webPort = ports.web || DEFAULT_DOCTOR_PORTS.web;
  const checks = [];

  const node = tools.node || { ok: false, output: "command not checked" };
  checks.push(status(levelFromTool(true, node), "node", node.output));

  const docker = tools.docker || { ok: false, output: "command not checked" };
  checks.push(status(levelFromTool(true, docker), "docker", docker.ok ? docker.output : "Docker CLI is required for docker-compose commercial drill.", {
    hint: docker.ok ? "" : "Install/start Docker Desktop, then rerun npm run drill:commercial."
  }));

  const psql = tools.psql || { ok: false, output: "command not checked" };
  checks.push(status(levelFromTool(false, psql), "psql", psql.ok ? psql.output : "psql is useful for local database inspection but not required when using Docker exec."));

  const pgDump = tools.pgDump || { ok: false, output: "command not checked" };
  checks.push(status(levelFromTool(false, pgDump), "pg_dump", pgDump.ok ? pgDump.output : "pg_dump is optional locally; backup script can use Docker exec."));

  const localPostgres = tools.localPostgres || { ok: false, output: "command not checked", missing: [] };
  checks.push(status(levelFromTool(false, localPostgres), "local-postgres-bootstrap", localPostgres.ok
    ? "Project-local PostgreSQL bootstrap binaries are available."
    : `Project-local PostgreSQL bootstrap is unavailable${localPostgres.missing?.length ? `; missing ${localPostgres.missing.join(", ")}.` : "."}`, {
    hint: localPostgres.ok
      ? "Run npm run postgres:local -- start, then rerun npm run dev:commercial."
      : "Install PostgreSQL 16 or set LOCAL_POSTGRES_BIN_DIR, then run npm run postgres:local -- check --json."
  }));

  const postgresOpen = Boolean(network.postgresOpen);
  const postgresTarget = `${postgresHost}:${postgresPort}`;
  checks.push(status(postgresOpen ? "pass" : "warn", "postgres-tcp", postgresOpen
    ? `${postgresTarget} accepts TCP connections.`
    : `${postgresTarget} is closed.`, {
    host: postgresHost,
    port: postgresPort,
    source: postgresSource,
    hint: postgresOpen ? "" : "Start Docker Compose Postgres, run npm run postgres:local -- start, or point DATABASE_URL at a reachable PostgreSQL."
  }));

  const databaseIntegrity = network.databaseIntegrity || null;
  if (!postgresOpen) {
    checks.push(status("warn", "database-append-only-triggers", "Append-only trigger check skipped because PostgreSQL TCP is unavailable.", {
      hint: "Start PostgreSQL and rerun npm run doctor:commercial -- --json."
    }));
  } else if (!databaseIntegrity?.checked) {
    checks.push(status("warn", "database-append-only-triggers", databaseIntegrity?.message || "Append-only trigger check skipped because DATABASE_URL is unavailable.", {
      hint: "Set DATABASE_URL so doctor can verify audit, export, and import append-only triggers in the live database."
    }));
  } else {
    const missing = databaseIntegrity.missing || [];
    checks.push(status(databaseIntegrity.ok ? "pass" : "fail", "database-append-only-triggers", databaseIntegrity.ok
      ? "Required audit, export, and import append-only triggers exist in the live database."
      : `Missing append-only database triggers: ${missing.join(", ")}.`, {
      found: databaseIntegrity.found || [],
      missing,
      required: databaseIntegrity.required || [],
      error: databaseIntegrity.error || ""
    }));
  }

  const apiOpen = Boolean(network.apiOpen);
  const apiHealth = network.apiHealth || null;
  const apiIsOa = isOaApi(apiHealth);
  checks.push(status(!apiOpen ? "warn" : apiIsOa ? "pass" : "fail", "api-port", !apiOpen
    ? `No API listener on 127.0.0.1:${apiPort}.`
    : apiIsOa
      ? `OA API is listening on 127.0.0.1:${apiPort}.`
      : `Port 127.0.0.1:${apiPort} is not the OA API.`, {
    listener: network.apiListener || "",
    health: apiHealth,
    portSource,
    devManifest,
    hint: apiIsOa ? "" : "Use npm run dev:commercial so the OA API picks a free port and Vite points at it."
  }));

  const webOpen = Boolean(network.webOpen);
  const webHealth = network.webHealth || null;
  const webProxyIsOa = isOaApi(webHealth);
  let webProxyLevel = "warn";
  let webProxyMessage = `No Vite listener on 127.0.0.1:${webPort}.`;
  let webProxyHint = "Start the frontend with npm run dev:commercial or npm run dev.";

  if (webOpen && webProxyIsOa) {
    webProxyLevel = "pass";
    webProxyMessage = "Vite /api proxy reaches the OA API.";
    webProxyHint = "";
  } else if (webOpen && !apiOpen) {
    webProxyLevel = "warn";
    webProxyMessage = `Vite is listening on 127.0.0.1:${webPort}, but no OA API listener is running on 127.0.0.1:${apiPort}.`;
    webProxyHint = "Start both services with npm run dev:commercial so Vite points at the selected API port.";
  } else if (webOpen) {
    webProxyLevel = "fail";
    webProxyMessage = "Vite /api proxy does not reach the OA API.";
    webProxyHint = apiIsOa
      ? "Restart the web dev server with VITE_API_PROXY_TARGET set to the OA API port."
      : "Free the API port or run npm run dev:commercial so the OA API picks a free port and Vite points at it.";
  }

  checks.push(status(webProxyLevel, "vite-api-proxy", webProxyMessage, {
    health: webHealth,
    portSource,
    devManifest,
    hint: webProxyHint
  }));

  const failures = checks.filter((item) => item.level === "fail").length;
  const warnings = checks.filter((item) => item.level === "warn").length;
  return {
    ok: failures === 0,
    failures,
    warnings,
    checks,
    readiness: buildReadinessSummary(checks)
  };
}

export function printCommercialDoctorHuman(report) {
  for (const item of report.checks) {
    const mark = item.level === "pass" ? "PASS" : item.level === "warn" ? "WARN" : "FAIL";
    console.log(`[${mark}] ${item.name}: ${item.message}`);
    if (item.details?.hint) console.log(`       ${item.details.hint}`);
  }
  console.log("\nReadiness:");
  console.log(`  Docker drill: ${report.readiness.canRunDockerDrill ? "ready" : "not ready"}`);
  console.log(`  PostgreSQL TCP: ${report.readiness.canReachPostgres ? "ready" : "not ready"}`);
  console.log(`  Database integrity: ${report.readiness.canVerifyDatabaseIntegrity ? "ready" : "not ready"}`);
  console.log(`  API smoke: ${report.readiness.canRunApiSmoke ? "ready" : "not ready"}`);
  console.log(`  Frontend API smoke: ${report.readiness.canRunFrontendApiSmoke ? "ready" : "not ready"}`);
  if (report.readiness.nextSteps.length) {
    console.log("  Next steps:");
    report.readiness.nextSteps.forEach((step) => console.log(`    - ${step}`));
  }
  console.log(`\nSummary: ${report.failures} failure(s), ${report.warnings} warning(s).`);
}
