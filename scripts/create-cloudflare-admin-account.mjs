#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";

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

function wranglerD1List() {
  const stdout = runWrangler(["d1", "list", "--json"]);
  return JSON.parse(String(stdout || "[]").trim());
}

function resolveDatabaseId(databaseName) {
  const direct = process.env.CLOUDFLARE_D1_DATABASE_ID || argValue("--database-id", "");
  if (direct) return direct;
  const databases = wranglerD1List();
  const database = databases.find((item) => item.name === databaseName || item.uuid === databaseName || item.id === databaseName);
  if (!database) throw new Error(`Could not resolve D1 database id for ${databaseName}.`);
  return database.uuid || database.id;
}

async function d1Query(databaseId, sql, params = []) {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !token) throw new Error("CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required.");
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`, {
    body: JSON.stringify({ params, sql }),
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json"
    },
    method: "POST"
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.success || payload?.result?.some((item) => item.success === false)) {
    throw new Error(JSON.stringify(payload || { status: response.status }));
  }
  return payload.result;
}

async function writeRemoteState(databaseId, state, auditEvent) {
  await d1Query(
    databaseId,
    "INSERT OR REPLACE INTO kv_store (key, value, updated_at) VALUES (?, ?, ?)",
    [STATE_KEY, JSON.stringify(state), nowIso()]
  );
  await d1Query(
    databaseId,
    "INSERT INTO audit_events (id, action, actor, object_type, object_id, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [auditEvent.id, auditEvent.action, auditEvent.actor, auditEvent.object, auditEvent.objectId, JSON.stringify(auditEvent), nowIso()]
  );
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
const databaseId = resolveDatabaseId(databaseName);
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
await writeRemoteState(databaseId, state, auditEvent);

console.log(JSON.stringify({
  account: account.email,
  created,
  mustChangePassword: account.mustChangePassword,
  ok: true,
  roleCodes: account.roleCodes
}, null, 2));
