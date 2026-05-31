#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

const STATE_KEY = "oa_state_v1";
const CONFIRMATION = "DELETE_NON_ADMIN_ACCOUNTS";

function argValue(name, fallback = "") {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  return process.argv[index + 1] || fallback;
}

function booleanArg(name, fallback = false) {
  const value = String(argValue(name, String(fallback))).trim().toLowerCase();
  return ["1", "true", "yes", "y"].includes(value);
}

function normalizeLogin(input) {
  return String(input || "").trim().toLowerCase();
}

function nowIso() {
  return new Date().toISOString();
}

function localTime() {
  return nowIso().replace("T", " ").slice(0, 19);
}

function isAdminAccount(user = {}) {
  return Array.isArray(user.roleCodes) && user.roleCodes.includes("admin");
}

function isActiveEmployeeStatus(status) {
  return ["ACTIVE", "在职"].includes(String(status || "ACTIVE"));
}

function publicAccountUserRecord(user = {}, iam = {}) {
  const roles = Array.isArray(iam.roles) ? iam.roles : [];
  const roleCodes = Array.isArray(user.roleCodes) ? user.roleCodes : [];
  const roleObjects = roleCodes
    .map((code) => roles.find((role) => role.code === code))
    .filter(Boolean)
    .map((role) => ({
      code: role.code,
      id: role.id,
      name: role.name
    }));

  return {
    email: user.email || "",
    employee: user.employee || null,
    id: user.id,
    mustChangePassword: Boolean(user.mustChangePassword),
    name: user.name || "",
    roleCodes,
    roles: roleObjects,
    status: user.status || "ACTIVE"
  };
}

function buildAccountLibrary(people = {}, iam = {}) {
  const users = Array.isArray(iam.users) ? iam.users : [];
  const roles = Array.isArray(iam.roles) ? iam.roles : [];
  const accountByEmployeeId = new Map(users
    .filter((user) => user.employee?.id)
    .map((user) => [user.employee.id, user]));
  const accounts = (people.employees || []).map((employee) => {
    const employeeId = employee.id || `employee-${employee.employeeNo || employee.seq || employee.name}`;
    const user = accountByEmployeeId.get(employeeId)
      || users.find((item) => item.name === employee.name && item.employee?.name === employee.name)
      || null;
    const roleCodes = Array.isArray(user?.roleCodes) ? user.roleCodes : [];
    const roleNames = roleCodes
      .map((code) => roles.find((role) => role.code === code)?.name)
      .filter(Boolean);
    return {
      account: user ? publicAccountUserRecord(user, iam) : null,
      accountEmail: user?.email || "",
      accountId: user?.id || null,
      accountMustChangePassword: Boolean(user?.mustChangePassword),
      accountStatus: user?.status || "UNASSIGNED",
      department: employee.department || "",
      email: employee.email || "",
      employeeId,
      employeeName: employee.name,
      employeeNo: employee.employeeNo || employee.seq || "-",
      employeeStatus: employee.status || "在职",
      id: employeeId,
      roleCodes,
      roleNames,
      roleTitle: employee.roleTitle || employee.role || ""
    };
  });
  const activeAccounts = accounts.filter((item) => isActiveEmployeeStatus(item.employeeStatus));
  const assignedAccounts = accounts.filter((item) => item.accountId);
  const activeAssignedAccounts = activeAccounts.filter((item) => item.accountId);
  return {
    accounts,
    accountStats: {
      activeAssignedAccounts: activeAssignedAccounts.length,
      activeEmployees: activeAccounts.length,
      assignedAccounts: assignedAccounts.length,
      coverageRate: activeAccounts.length ? Math.round((activeAssignedAccounts.length / activeAccounts.length) * 100) : 100,
      disabledAccounts: assignedAccounts.filter((item) => item.accountStatus === "DISABLED").length,
      missingAccounts: activeAccounts.length - activeAssignedAccounts.length,
      totalEmployees: accounts.length
    }
  };
}

function resolveDatabaseId(databaseName) {
  const direct = process.env.CLOUDFLARE_D1_DATABASE_ID || argValue("--database-id", "");
  if (direct) return direct;
  const wranglerToml = readFileSync("wrangler.toml", "utf8");
  const blocks = wranglerToml.split(/\n(?=\[\[d1_databases\]\])/);
  for (const block of blocks) {
    if (!block.includes("[[d1_databases]]")) continue;
    const name = block.match(/database_name\s*=\s*"([^"]+)"/)?.[1];
    const id = block.match(/database_id\s*=\s*"([^"]+)"/)?.[1];
    if (id && (!databaseName || name === databaseName || id === databaseName)) return id;
  }
  throw new Error(`Could not resolve D1 database id for ${databaseName || "default database"}.`);
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

async function readRemoteState(databaseId) {
  const result = await d1Query(databaseId, "SELECT value FROM kv_store WHERE key = ? ORDER BY updated_at DESC LIMIT 1", [STATE_KEY]);
  const value = result?.[0]?.results?.[0]?.value;
  if (!value) throw new Error(`No ${STATE_KEY} row found in D1.`);
  return JSON.parse(value);
}

async function writeRemoteState(databaseId, state, auditEvent) {
  await d1Query(
    databaseId,
    "UPDATE kv_store SET value = ?, updated_at = ? WHERE key = ?",
    [JSON.stringify(state), nowIso(), STATE_KEY]
  );
  await d1Query(
    databaseId,
    "INSERT OR IGNORE INTO kv_store (key, value, updated_at) VALUES (?, ?, ?)",
    [STATE_KEY, JSON.stringify(state), nowIso()]
  );
  await d1Query(
    databaseId,
    "INSERT INTO audit_events (id, action, actor, object_type, object_id, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [auditEvent.id, auditEvent.action, auditEvent.actor, auditEvent.object, auditEvent.objectId, JSON.stringify(auditEvent), nowIso()]
  );
}

function recomputeRoleCounts(iam = {}) {
  const users = Array.isArray(iam.users) ? iam.users : [];
  iam.roles = (iam.roles || []).map((role) => ({
    ...role,
    userCount: users.filter((user) => Array.isArray(user.roleCodes) && user.roleCodes.includes(role.code)).length
  }));
}

function pruneAccounts(state, { keepLogin = "", revokePendingActivations = true } = {}) {
  if (!Array.isArray(state?.iam?.users)) throw new Error("Remote OA state does not contain iam.users.");
  const users = state.iam.users;
  const adminUsers = users.filter(isAdminAccount);
  if (!adminUsers.length) {
    throw new Error("Prune aborted: no admin account was found.");
  }
  const normalizedKeepLogin = normalizeLogin(keepLogin);
  if (normalizedKeepLogin && !adminUsers.some((user) => normalizeLogin(user.email) === normalizedKeepLogin)) {
    throw new Error("Prune aborted: keep login is not an existing admin account.");
  }
  const removedUsers = users.filter((user) => !isAdminAccount(user));
  state.iam.users = adminUsers;
  state.systemSettings = {
    ...(state.systemSettings || {}),
    autoSeedApprovalUsers: false
  };

  let revokedActivationCount = 0;
  if (revokePendingActivations) {
    state.accountActivations = (state.accountActivations || []).map((activation) => {
      if (activation.status !== "PENDING") return activation;
      revokedActivationCount += 1;
      return {
        ...activation,
        revokedAt: nowIso(),
        revokedReason: "清理非管理员账号时撤销待激活码",
        status: "REVOKED"
      };
    });
  }

  recomputeRoleCounts(state.iam);
  state.iam = {
    ...(state.iam || {}),
    ...buildAccountLibrary(state.people || { employees: [] }, state.iam || { roles: [], users: [] })
  };
  return {
    keptAdminCount: adminUsers.length,
    removedUserCount: removedUsers.length,
    revokedActivationCount,
    totalBefore: users.length,
    totalAfter: state.iam.users.length
  };
}

const confirm = argValue("--confirm", process.env.PRUNE_ACCOUNTS_CONFIRM || "");
if (confirm !== CONFIRMATION) {
  throw new Error(`Refusing to prune accounts. Pass --confirm ${CONFIRMATION}.`);
}

const databaseName = argValue("--database", process.env.D1_DATABASE_NAME || "deep-oa-hr");
const databaseId = resolveDatabaseId(databaseName);
const keepLogin = argValue("--keep-login", process.env.KEEP_ADMIN_LOGIN || "");
const revokePendingActivations = booleanArg("--revoke-pending-activations", true);
const dryRun = booleanArg("--dry-run", false);

const state = await readRemoteState(databaseId);
const summary = pruneAccounts(state, { keepLogin, revokePendingActivations });
const auditEvent = {
  action: "清理非管理员账号",
  actor: "GitHub Actions",
  content: `删除非管理员账号 ${summary.removedUserCount} 个，保留管理员账号 ${summary.keptAdminCount} 个，撤销待激活码 ${summary.revokedActivationCount} 个`,
  id: `AUD-${nowIso().slice(0, 10).replaceAll("-", "")}-${randomUUID().slice(0, 8).toUpperCase()}`,
  ip: "github-actions",
  metadata: summary,
  object: "账号权限",
  objectId: "iam.users",
  operator: "GitHub Actions",
  requestId: `github-${randomUUID()}`,
  result: "成功",
  time: localTime(),
  type: "删除",
  userAgent: "github-actions"
};
if (!dryRun) {
  state.auditLogs = [auditEvent, ...(state.auditLogs || [])].slice(0, 500);
  await writeRemoteState(databaseId, state, auditEvent);
}

console.log(JSON.stringify({
  dryRun,
  ok: true,
  summary
}, null, 2));
