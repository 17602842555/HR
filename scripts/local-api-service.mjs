import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parse as parseDotenv } from "dotenv";
import {
  redactCommercialDevManifestText,
  redactCommercialDevPath
} from "./dev-commercial-core.mjs";

const DEFAULT_SESSION_NAME = "deep-oa-api";
const DEFAULT_ENV_FILES = Object.freeze([
  ".env.example",
  ".env",
  ".local-postgres/.env.local-postgres"
]);
const DEFAULT_HEALTH_PATH = "/api/ready";
const DEFAULT_MANIFEST_PATH = "reports/commercial-evidence/local-api-service.json";
const DEFAULT_LOG_PATH = ".local-files/api-local-service.log";
const DEFAULT_PID_PATH = ".local-files/api-local-service.pid";
const DEFAULT_START_TIMEOUT_MS = 8_000;

function boolFlag(args, name) {
  return args.includes(name);
}

function valueFlag(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return null;
  return args[index + 1] || "";
}

function intFlag(args, name, fallback) {
  const value = valueFlag(args, name);
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

function normalizeEnvFiles(value) {
  const raw = Array.isArray(value)
    ? value
    : String(value || "").split(",");
  return raw.map((item) => item.trim()).filter(Boolean);
}

function safeScreenSessionName(value) {
  const name = String(value || "").trim();
  if (!/^[A-Za-z0-9_.-]{3,80}$/.test(name)) {
    throw new Error("Screen session name must be 3-80 characters and use only letters, numbers, dot, underscore, or hyphen.");
  }
  return name;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\"'\"'")}'`;
}

function redactPathList(paths, context) {
  return paths.map((path) => redactCommercialDevPath(path, context));
}

function resolveMaybe(rootDir, value) {
  return isAbsolute(value) ? value : resolve(rootDir, value);
}

function readEnvFile(path) {
  if (!existsSync(path)) return {};
  return parseDotenv(readFileSync(path));
}

export function parseLocalApiServiceArgs(argv = []) {
  const args = [...argv];
  const action = args.find((item) => !item.startsWith("-")) || "status";
  if (!["start", "stop", "restart", "status"].includes(action)) {
    throw new Error(`Unknown local API service action: ${action}. Use start, stop, restart, or status.`);
  }
  return {
    action,
    envFiles: valueFlag(args, "--env-files"),
    healthUrl: valueFlag(args, "--health-url"),
    json: boolFlag(args, "--json"),
    logPath: valueFlag(args, "--log"),
    manifestPath: valueFlag(args, "--manifest"),
    pidPath: valueFlag(args, "--pid"),
    sessionName: valueFlag(args, "--session"),
    timeoutMs: intFlag(args, "--timeout-ms", DEFAULT_START_TIMEOUT_MS)
  };
}

export function buildLocalApiServiceConfig(env = process.env, rootDir = process.cwd(), options = {}) {
  const envFiles = normalizeEnvFiles(
    options.envFiles
      || env.LOCAL_API_ENV_FILES
      || DEFAULT_ENV_FILES
  );
  const resolvedEnvFiles = envFiles.map((path) => resolveMaybe(rootDir, path));
  const fileEnv = resolvedEnvFiles.reduce((acc, path) => ({ ...acc, ...readEnvFile(path) }), {});
  const runtimeEnv = { ...env, ...fileEnv };
  const apiBaseUrl = runtimeEnv.API_BASE_URL
    || `http://${runtimeEnv.SERVER_HOST || "127.0.0.1"}:${runtimeEnv.SERVER_PORT || "8787"}`;
  const healthUrl = String(options.healthUrl || env.LOCAL_API_HEALTH_URL || `${apiBaseUrl}${DEFAULT_HEALTH_PATH}`);
  const logPath = resolveMaybe(rootDir, options.logPath || env.LOCAL_API_LOG || DEFAULT_LOG_PATH);
  const manifestPath = resolveMaybe(rootDir, options.manifestPath || env.LOCAL_API_MANIFEST || DEFAULT_MANIFEST_PATH);
  const pidPath = resolveMaybe(rootDir, options.pidPath || env.LOCAL_API_PID || DEFAULT_PID_PATH);

  return {
    envFiles,
    healthUrl,
    logPath,
    manifestPath,
    pidPath,
    rootDir,
    screenBinary: env.SCREEN_BINARY || "screen",
    sessionName: safeScreenSessionName(options.sessionName || env.LOCAL_API_SCREEN_NAME || DEFAULT_SESSION_NAME),
    shellBinary: env.SHELL || "zsh",
    timeoutMs: options.timeoutMs || DEFAULT_START_TIMEOUT_MS
  };
}

export function renderLocalApiScreenCommand(config) {
  const envFiles = config.envFiles.map((path) => shellQuote(path)).join(" ");
  return [
    `cd ${shellQuote(config.rootDir)}`,
    "set -a",
    `for env_file in ${envFiles}; do [ -f \"$env_file\" ] && . \"$env_file\"; done`,
    "set +a",
    `mkdir -p ${shellQuote(dirname(relative(config.rootDir, config.logPath) || DEFAULT_LOG_PATH))} ${shellQuote(dirname(relative(config.rootDir, config.pidPath) || DEFAULT_PID_PATH))}`,
    `: > ${shellQuote(relative(config.rootDir, config.logPath) || DEFAULT_LOG_PATH)}`,
    `chmod 600 ${shellQuote(relative(config.rootDir, config.logPath) || DEFAULT_LOG_PATH)}`,
    `echo $$ > ${shellQuote(relative(config.rootDir, config.pidPath) || DEFAULT_PID_PATH)}`,
    `chmod 600 ${shellQuote(relative(config.rootDir, config.pidPath) || DEFAULT_PID_PATH)}`,
    `exec node server/src/index.mjs >> ${shellQuote(relative(config.rootDir, config.logPath) || DEFAULT_LOG_PATH)} 2>&1`
  ].join("; ");
}

export function parseScreenList(output = "", sessionName = DEFAULT_SESSION_NAME) {
  const escaped = String(sessionName).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`\\d+\\.${escaped}(?:\\s|\\t|$)`);
  return pattern.test(String(output || ""));
}

export function buildLocalApiServiceManifest(report, config, context = {}) {
  const now = report.checkedAt || new Date().toISOString();
  return {
    action: report.action,
    envFiles: redactPathList(config.envFiles, { rootDir: config.rootDir, ...context }),
    health: report.health || null,
    healthUrl: report.healthUrl,
    kind: "local-api-service",
    logPath: redactCommercialDevPath(config.logPath, { rootDir: config.rootDir, ...context }),
    manifestPath: redactCommercialDevPath(config.manifestPath, { rootDir: config.rootDir, ...context }),
    managedPid: report.managedPid || null,
    pidPath: redactCommercialDevPath(config.pidPath, { rootDir: config.rootDir, ...context }),
    root: ".",
    screenSession: report.screenSession,
    sessionName: config.sessionName,
    status: report.status,
    updatedAt: now
  };
}

function writeManifest(path, manifest, context = {}) {
  mkdirSync(dirname(path), { recursive: true });
  const text = redactCommercialDevManifestText(`${JSON.stringify(manifest, null, 2)}\n`, context);
  writeFileSync(path, text, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function runCommand(binary, args, options = {}) {
  return spawnSync(binary, args, {
    cwd: options.cwd,
    encoding: "utf8",
    env: options.env || process.env,
    shell: false,
    stdio: options.stdio || "pipe"
  });
}

function screenList(config) {
  const result = runCommand(config.screenBinary, ["-ls"]);
  if (result.error?.code === "ENOENT") {
    return { available: false, output: "", screenSession: false };
  }
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
  return {
    available: true,
    output,
    screenSession: parseScreenList(output, config.sessionName)
  };
}

function readManagedPid(config) {
  if (!existsSync(config.pidPath)) return null;
  const value = Number.parseInt(readFileSync(config.pidPath, "utf8").trim(), 10);
  return Number.isInteger(value) && value > 0 ? value : null;
}

function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function probeHealth(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1200);
  try {
    const response = await fetch(url, { signal: controller.signal });
    const text = await response.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    return {
      ok: response.ok && (body?.ok === undefined || body.ok === true),
      statusCode: response.status,
      service: body?.service || null
    };
  } catch (error) {
    return {
      ok: false,
      error: error.name === "AbortError" ? "health_check_timeout" : error.message
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function waitForHealth(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let latest = await probeHealth(url);
  while (!latest.ok && Date.now() < deadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
    latest = await probeHealth(url);
  }
  return latest;
}

function statusFrom({ health, managedProcess, screenSession }) {
  if (health.ok && managedProcess) return "running";
  if (health.ok && screenSession) return "running-screen";
  if (health.ok) return "running-unmanaged";
  if (managedProcess || screenSession) return "starting-or-unhealthy";
  return "stopped";
}

function nextStepsFor(report) {
  if (report.ok) return [];
  if (!report.screenAvailable) {
    return [
      "Install or enable the macOS screen command, or run npm run dev:server in a terminal.",
      "After PostgreSQL is running, rerun npm run api:local -- start --json."
    ];
  }
  if (report.status === "running-unmanaged") {
    return [
      "The API health endpoint is up but it is not managed by this screen session.",
      "Use lsof -nP -iTCP:8787 -sTCP:LISTEN to find the owner, or stop it manually."
    ];
  }
  return [
    "Run npm run postgres:local -- start, then npm run db:deploy && npm run db:seed.",
    "Check reports/commercial-evidence/local-api-service.json and the screen session with screen -ls."
  ];
}

async function buildStatusReport(config, action = "status") {
  const screen = screenList(config);
  const managedPid = readManagedPid(config);
  const managedProcess = pidAlive(managedPid);
  const health = await probeHealth(config.healthUrl);
  const status = statusFrom({ health, managedProcess, screenSession: screen.screenSession });
  const report = {
    action,
    checkedAt: new Date().toISOString(),
    health,
    healthUrl: config.healthUrl,
    ok: health.ok,
    managedPid,
    managedProcess,
    screenAvailable: screen.available,
    screenSession: screen.screenSession,
    sessionName: config.sessionName,
    status
  };
  report.nextSteps = nextStepsFor(report);
  return report;
}

async function startService(config) {
  const before = await buildStatusReport(config, "start");
  if (before.health.ok) {
    return { ...before, alreadyRunning: true };
  }
  if (!before.screenAvailable) return before;
  if (!before.screenSession) {
    const command = renderLocalApiScreenCommand(config);
    const result = runCommand(config.screenBinary, [
      "-S",
      config.sessionName,
      "-dm",
      config.shellBinary,
      "-lc",
      command
    ], { cwd: config.rootDir });
    if (result.status !== 0) {
      const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
      return {
        ...before,
        error: output || `screen exited with status ${result.status}`,
        nextSteps: nextStepsFor(before),
        ok: false
      };
    }
  }

  const health = await waitForHealth(config.healthUrl, config.timeoutMs);
  const screen = screenList(config);
  const managedPid = readManagedPid(config);
  const managedProcess = pidAlive(managedPid);
  const status = statusFrom({ health, managedProcess, screenSession: screen.screenSession });
  const report = {
    action: "start",
    checkedAt: new Date().toISOString(),
    health,
    healthUrl: config.healthUrl,
    ok: health.ok,
    managedPid,
    managedProcess,
    screenAvailable: screen.available,
    screenSession: screen.screenSession,
    sessionName: config.sessionName,
    status
  };
  report.nextSteps = nextStepsFor(report);
  return report;
}

async function stopService(config) {
  const before = await buildStatusReport(config, "stop");
  if (!before.screenSession && !before.managedProcess) {
    const report = {
      ...before,
      ok: !before.health.ok,
      stopped: !before.health.ok,
      status: before.health.ok ? "running-unmanaged" : "stopped"
    };
    report.nextSteps = nextStepsFor(report);
    return report;
  }

  if (before.managedPid && before.managedProcess) {
    try {
      process.kill(before.managedPid, "SIGTERM");
    } catch {
      // A stale pid file is handled by the follow-up health/status probe.
    }
  }
  if (before.screenSession) {
    runCommand(config.screenBinary, ["-S", config.sessionName, "-X", "quit"]);
  }
  await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  const after = await buildStatusReport(config, "stop");
  return {
    ...after,
    ok: !after.health.ok && !after.screenSession,
    stopped: !after.health.ok && !after.screenSession
  };
}

async function runAction(config, action) {
  if (action === "status") return buildStatusReport(config);
  if (action === "start") return startService(config);
  if (action === "stop") return stopService(config);
  if (action === "restart") {
    await stopService(config);
    return startService(config);
  }
  throw new Error(`Unknown local API service action: ${action}.`);
}

function printReport(report, jsonMode) {
  if (jsonMode) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(`${report.ok ? "OK" : "NOT READY"}: local API ${report.action}`);
  console.log(`Status: ${report.status}`);
  console.log(`Health: ${report.healthUrl}`);
  if (report.nextSteps?.length) {
    console.log("Next steps:");
    report.nextSteps.forEach((step) => console.log(`- ${step}`));
  }
}

export async function runLocalApiServiceCli(argv = process.argv.slice(2), env = process.env, rootDir = process.cwd()) {
  const parsed = parseLocalApiServiceArgs(argv);
  const config = buildLocalApiServiceConfig(env, rootDir, parsed);
  const report = await runAction(config, parsed.action);
  const manifest = buildLocalApiServiceManifest(report, config);
  writeManifest(config.manifestPath, manifest, { rootDir });
  printReport({
    ...report,
    manifestPath: redactCommercialDevPath(config.manifestPath, { rootDir })
  }, parsed.json);
  return report.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = await runLocalApiServiceCli();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
