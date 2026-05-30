import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildLocalApiServiceConfig,
  buildLocalApiServiceManifest,
  parseLocalApiServiceArgs,
  parseScreenList,
  renderLocalApiScreenCommand
} from "../../scripts/local-api-service.mjs";

function tempRoot() {
  return mkdtempSync(join(tmpdir(), "oa-local-api-service-test-"));
}

test("local API service config reads project-local PostgreSQL API base URL last", () => {
  const root = tempRoot();
  try {
    mkdirSync(join(root, ".local-postgres"), { recursive: true });
    writeFileSync(join(root, ".env.example"), "API_BASE_URL=http://127.0.0.1:8787\nSERVER_PORT=8787\n");
    writeFileSync(join(root, ".env"), "API_BASE_URL=http://127.0.0.1:9999\nSERVER_PORT=9999\n");
    writeFileSync(join(root, ".local-postgres", ".env.local-postgres"), "API_BASE_URL=http://127.0.0.1:8788\nSERVER_PORT=8788\n");

    const config = buildLocalApiServiceConfig({ PATH: "" }, root);

    assert.equal(config.healthUrl, "http://127.0.0.1:8788/api/ready");
    assert.deepEqual(config.envFiles, [".env.example", ".env", ".local-postgres/.env.local-postgres"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("local API service command sources env files before starting Fastify API", () => {
  const root = tempRoot();
  try {
    const config = buildLocalApiServiceConfig({
      LOCAL_API_ENV_FILES: ".env.example,.local-postgres/.env.local-postgres",
      SHELL: "zsh"
    }, root);

    const command = renderLocalApiScreenCommand(config);

    assert.match(command, /cd '/);
    assert.match(command, /set -a/);
    assert.match(command, /\.env\.example/);
    assert.match(command, /\.local-postgres\/\.env\.local-postgres/);
    assert.match(command, /exec node server\/src\/index\.mjs/);
    assert.doesNotMatch(command, /admin123456|oa_dev_password|JWT_SECRET/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("local API service parser supports actions and operational flags", () => {
  assert.deepEqual(parseLocalApiServiceArgs(["--json"]), {
    action: "status",
    envFiles: null,
    healthUrl: null,
    json: true,
    logPath: null,
    manifestPath: null,
    pidPath: null,
    sessionName: null,
    timeoutMs: 8000
  });
  assert.deepEqual(parseLocalApiServiceArgs(["start", "--session", "oa-api", "--timeout-ms", "12000"]).action, "start");
  assert.throws(() => parseLocalApiServiceArgs(["deploy"]), /Unknown local API service action/);
  assert.throws(() => parseLocalApiServiceArgs(["start", "--timeout-ms", "0"]), /must be a positive integer/);
});

test("local API service rejects unsafe screen session names", () => {
  const root = tempRoot();
  try {
    assert.throws(
      () => buildLocalApiServiceConfig({ LOCAL_API_SCREEN_NAME: "bad;rm -rf" }, root),
      /Screen session name/
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("screen list parser detects exact detached API session", () => {
  const output = [
    "There is a screen on:",
    "\t77408.deep-oa-api\t(Detached)",
    "1 Socket in /tmp/.screen."
  ].join("\n");

  assert.equal(parseScreenList(output, "deep-oa-api"), true);
  assert.equal(parseScreenList(output, "deep-oa"), false);
});

test("local API service manifest redacts project paths and excludes command text", () => {
  const root = tempRoot();
  try {
    const manifestPath = join(root, "reports", "commercial-evidence", "local-api-service.json");
    const config = buildLocalApiServiceConfig({
      LOCAL_API_MANIFEST: manifestPath,
      PATH: ""
    }, root);
    const manifest = buildLocalApiServiceManifest({
      action: "status",
      checkedAt: "2026-05-31T00:00:00.000Z",
      health: { ok: true, statusCode: 200, service: "deep-oa-api" },
      healthUrl: "http://127.0.0.1:8787/api/ready",
      screenSession: true,
      status: "running"
    }, config);

    assert.equal(manifest.manifestPath, "[PROJECT_ROOT]/reports/commercial-evidence/local-api-service.json");
    assert.equal(manifest.logPath, "[PROJECT_ROOT]/.local-files/api-local-service.log");
    assert.equal(manifest.pidPath, "[PROJECT_ROOT]/.local-files/api-local-service.pid");
    assert.equal(manifest.root, ".");
    assert.equal(Object.hasOwn(manifest, "command"), false);
    assert.equal(JSON.stringify(manifest).includes(root), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
