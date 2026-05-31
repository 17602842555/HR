#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const STATE_KEY = "oa_state_v1";

function argValue(name, fallback = "") {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  return process.argv[index + 1] || fallback;
}

function nowIso() {
  return new Date().toISOString();
}

function localTime() {
  return nowIso().replace("T", " ").slice(0, 19);
}

function sqlString(value) {
  return `'${String(value ?? "").replaceAll("'", "''")}'`;
}

function nativePasswordHash(password, salt = randomUUID()) {
  const digest = createHash("sha256").update(`${salt}:${password}`).digest("hex");
  return `sha256:${salt}:${digest}`;
}

function parseWranglerJson(stdout) {
  const text = String(stdout || "").trim();
  const jsonStart = text.indexOf("[");
  if (jsonStart === -1) throw new Error("Wrangler D1 JSON output was empty.");
  return JSON.parse(text.slice(jsonStart));
}

function runWrangler(args, options = {}) {
  const result = spawnSync("npx", ["wrangler", ...args], {
    encoding: "utf8",
    stdio: options.stdio || ["ignore", "pipe", "pipe"]
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `wrangler exited with ${result.status}`);
  }
  return result.stdout;
}

function readRemoteState(databaseName) {
  const stdout = runWrangler([
    "d1",
    "execute",
    databaseName,
    "--remote",
    "--command",
    `SELECT value FROM kv_store WHERE key = '${STATE_KEY}'`,
    "--json"
  ]);
  const payload = parseWranglerJson(stdout);
  const value = payload?.[0]?.results?.[0]?.value;
  if (!value) throw new Error(`No ${STATE_KEY} row found in ${databaseName}.`);
  return JSON.parse(value);
}

function writeRemoteState(databaseName, state, auditEvent) {
  const dir = mkdtempSync(join(tmpdir(), "oa-d1-admin-"));
  const file = join(dir, "update-state.sql");
  const sql = [
    `INSERT OR REPLACE INTO kv_store (key, value, updated_at) VALUES (${sqlString(STATE_KEY)}, ${sqlString(JSON.stringify(state))}, ${sqlString(nowIso())});`,
    `INSERT INTO audit_events (id, action, actor, object_type, object_id, metadata, created_at) VALUES (${sqlString(auditEvent.id)}, ${sqlString(auditEvent.action)}, ${sqlString(auditEvent.actor)}, ${sqlString(auditEvent.object)}, ${sqlString(auditEvent.objectId)}, ${sqlString(JSON.stringify(auditEvent))}, ${sqlString(nowIso())});`
  ].join("\n");
  writeFileSync(file, sql);
  try {
    runWrangler(["d1", "execute", databaseName, "--remote", "--file", file], { stdio: "inherit" });
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
}

function ensureAdminAccount(state, {
  login,
  mustChangePassword,
  name,
  password,
  roleCodes
}) {
  if (!state?.iam?.users || !Array.isArray(state.iam.users)) {
    throw new Error("Remote OA state does not contain iam.users.");
  }
  const normalizedLogin = String(login || "").trim();
  if (!normalizedLogin) throw new Error("ADMIN_LOGIN is required.");
  if (!password) throw new Error("ADMIN_PASSWORD is required.");
  const roles = roleCodes.length ? roleCodes : ["admin"];
  const existing = state.iam.users.find((user) => String(user.email || "").trim().toLowerCase() === normalizedLogin.toLowerCase());
  const passwordHash = nativePasswordHash(password);
  const account = existing || {
    id: `USER-${nowIso().slice(0, 10).replaceAll("-", "")}-${randomUUID().slice(0, 8).toUpperCase()}`,
    sessionVersion: 0
  };
  account.email = normalizedLogin;
  account.mustChangePassword = mustChangePassword;
  account.name = name || normalizedLogin;
  account.passwordHash = passwordHash;
  account.roleCodes = roles;
  account.sessionVersion = Number(account.sessionVersion || 0) + 1;
  account.status = "ACTIVE";
  if (!existing) state.iam.users = [account, ...state.iam.users];
  return { account, created: !existing };
}

const databaseName = argValue("--database", process.env.D1_DATABASE_NAME || "deep-oa-hr");
const login = argValue("--login", process.env.ADMIN_LOGIN || "");
const mustChangePassword = argValue("--must-change-password", process.env.ADMIN_MUST_CHANGE_PASSWORD || "true") !== "false";
const name = argValue("--name", process.env.ADMIN_NAME || "管理员");
const password = process.env.ADMIN_PASSWORD || "";
const roleCodes = String(argValue("--roles", process.env.ADMIN_ROLE_CODES || "admin"))
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);

const state = readRemoteState(databaseName);
const { account, created } = ensureAdminAccount(state, { login, mustChangePassword, name, password, roleCodes });
const auditEvent = {
  action: created ? "创建管理员账号" : "更新管理员账号",
  actor: "GitHub Actions",
  content: `${created ? "创建" : "更新"}管理员账号 ${account.email}`,
  id: `AUD-${nowIso().slice(0, 10).replaceAll("-", "")}-${randomUUID().slice(0, 8).toUpperCase()}`,
  ip: "github-actions",
  object: "账号权限",
  objectId: account.id,
  operator: "GitHub Actions",
  requestId: `github-${randomUUID()}`,
  result: "成功",
  time: localTime(),
  type: created ? "新增" : "更新",
  userAgent: "github-actions"
};
state.auditLogs = [auditEvent, ...(state.auditLogs || [])].slice(0, 500);
writeRemoteState(databaseName, state, auditEvent);

console.log(JSON.stringify({
  account: account.email,
  created,
  mustChangePassword: account.mustChangePassword,
  ok: true,
  roleCodes: account.roleCodes
}, null, 2));
