import "dotenv/config";
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import net from "node:net";
import { isAbsolute, resolve } from "node:path";
import { parsePostgresTargetFromEnv } from "./commercial-doctor-core.mjs";
import {
  buildCommercialDevBlockedManifest,
  buildCommercialDevRunningManifest,
  writeCommercialDevManifest
} from "./dev-commercial-core.mjs";

const root = resolve(new URL("..", import.meta.url).pathname);

function commercialDevManifestPath() {
  const configured = process.env.COMMERCIAL_DEV_MANIFEST || "reports/commercial-evidence/dev-stack.json";
  return isAbsolute(configured) ? configured : resolve(root, configured);
}

const manifestPath = commercialDevManifestPath();

function isPortFree(port, host = "127.0.0.1") {
  return new Promise((resolvePort) => {
    const server = net.createServer();
    server.once("error", () => resolvePort(false));
    server.once("listening", () => {
      server.close(() => resolvePort(true));
    });
    server.listen(port, host);
  });
}

async function findFreePort(startPort) {
  for (let port = startPort; port < startPort + 50; port += 1) {
    if (await isPortFree(port)) return port;
  }
  throw new Error(`No free port found from ${startPort} to ${startPort + 49}.`);
}

function tcpOpen(port, host = "127.0.0.1") {
  return new Promise((resolvePort) => {
    const socket = net.createConnection({ host, port });
    socket.setTimeout(1200);
    socket.once("connect", () => {
      socket.destroy();
      resolvePort(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolvePort(false);
    });
    socket.once("error", () => resolvePort(false));
  });
}

function run(name, args, env) {
  const child = spawn("npm", args, {
    cwd: root,
    env,
    shell: false,
    stdio: "inherit"
  });
  child.on("exit", (code, signal) => {
    if (signal) return;
    if (code && !shuttingDown) {
      console.error(`${name} exited with code ${code}.`);
      shutdown(code);
    }
  });
  return child;
}

let shuttingDown = false;
const children = [];

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  rmSync(manifestPath, { force: true });
  for (const child of children) {
    if (!child.killed) child.kill("SIGTERM");
  }
  setTimeout(() => process.exit(code), 300);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

const requestedApiPort = Number.parseInt(process.env.SERVER_PORT || "8787", 10);
const requestedWebPort = Number.parseInt(process.env.WEB_PORT || "5174", 10);
const apiPort = await findFreePort(Number.isFinite(requestedApiPort) ? requestedApiPort : 8787);
const webPort = await findFreePort(Number.isFinite(requestedWebPort) ? requestedWebPort : 5174);
const postgresTarget = parsePostgresTargetFromEnv(process.env);
const skipPreflight = process.env.SKIP_COMMERCIAL_DEV_PREFLIGHT === "1";
if (!skipPreflight && !(await tcpOpen(postgresTarget.port, postgresTarget.host))) {
  const startedAt = new Date().toISOString();
  const blockedManifest = buildCommercialDevBlockedManifest({
    apiPort,
    manifestPath,
    postgresTarget,
    rootDir: root,
    startedAt,
    webPort
  });
  writeCommercialDevManifest(manifestPath, blockedManifest, { rootDir: root });
  console.error(`Commercial dev stack blocked: PostgreSQL target ${postgresTarget.host}:${postgresTarget.port} is not reachable (${postgresTarget.source}).`);
  blockedManifest.nextSteps.forEach((step) => console.error(`- ${step}`));
  console.error("Set SKIP_COMMERCIAL_DEV_PREFLIGHT=1 only when the API will reach PostgreSQL through another network path.");
  process.exit(1);
}
const env = {
  ...process.env,
  SERVER_PORT: String(apiPort),
  VITE_API_PROXY_TARGET: `http://127.0.0.1:${apiPort}`
};

console.log(`Starting commercial dev stack:`);
console.log(`- API: http://127.0.0.1:${apiPort}`);
console.log(`- Web: http://127.0.0.1:${webPort}`);
console.log(`- Vite API proxy target: ${env.VITE_API_PROXY_TARGET}`);
console.log(`- Doctor manifest: ${manifestPath}`);
console.log(`Run npm run doctor:commercial in another terminal if the UI still reports local demo mode. The doctor will auto-detect these ports from the manifest; SERVER_PORT=${apiPort} WEB_PORT=${webPort} still overrides it explicitly.`);

children.push(run("api", ["run", "dev:server"], env));
children.push(run("web", ["run", "dev", "--", "--port", String(webPort), "--strictPort"], env));

const startedAt = new Date().toISOString();
writeCommercialDevManifest(manifestPath, buildCommercialDevRunningManifest({
  apiPid: children[0]?.pid || null,
  apiPort,
  manifestPath,
  parentPid: process.pid,
  postgresTarget,
  proxyTarget: env.VITE_API_PROXY_TARGET,
  rootDir: root,
  startedAt,
  webPid: children[1]?.pid || null,
  webPort
}), { rootDir: root });
