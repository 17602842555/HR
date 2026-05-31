const FALLBACK_USER = {
  id: "anonymous-user",
  name: "未登录用户",
  department: "行政部",
  organization: "集团总部",
  title: "行政负责人",
  source: "mock"
};

function isPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function unwrapPayload(payload) {
  let current = payload;
  for (let index = 0; index < 3; index += 1) {
    if (!isPlainObject(current)) return current;
    const nextKey = ["data", "result", "payload"].find((key) => current[key] !== undefined);
    if (!nextKey) return current;
    current = current[nextKey];
  }
  return current;
}

function payloadRoots(payload) {
  const unwrapped = unwrapPayload(payload);
  return [payload, unwrapped, unwrapped?.state].filter(Boolean);
}

export function pickArray(payload, keys = []) {
  const candidates = [...keys, "items", "rows", "records", "list"];
  for (const root of payloadRoots(payload)) {
    if (Array.isArray(root)) return root;
    if (!isPlainObject(root)) continue;
    for (const key of candidates) {
      if (Array.isArray(root[key])) return root[key];
    }
  }
  return undefined;
}

function pickObject(payload, keys = []) {
  for (const root of payloadRoots(payload)) {
    if (!isPlainObject(root)) continue;
    for (const key of keys) {
      if (isPlainObject(root[key])) return root[key];
    }
  }
  const unwrapped = unwrapPayload(payload);
  return isPlainObject(unwrapped) ? unwrapped : undefined;
}

function pickStateValue(payload, key) {
  for (const root of payloadRoots(payload)) {
    if (isPlainObject(root) && root[key] !== undefined) return root[key];
  }
  return undefined;
}

export function normalizeCurrentUser(payload) {
  const user = pickObject(payload, ["user", "currentUser", "profile", "account"]);
  if (!user) return FALLBACK_USER;
  return {
    id: user.id || user.userId || user.uid || FALLBACK_USER.id,
    name: user.name || user.displayName || user.realName || user.username || FALLBACK_USER.name,
    department: user.department || user.departmentName || user.orgName || FALLBACK_USER.department,
    organization: user.organization || user.organizationName || user.company || FALLBACK_USER.organization,
    title: user.title || user.roleName || user.position || FALLBACK_USER.title,
    avatarUrl: user.avatarUrl || user.avatar || "",
    email: user.email || user.login || "",
    mustChangePassword: Boolean(user.mustChangePassword || user.firstLoginRequired),
    permissions: Array.isArray(user.permissions) ? user.permissions : null,
    roles: Array.isArray(user.roles) ? user.roles : [],
    source: "api"
  };
}

function emptyPeopleState(fallbackPeople = {}) {
  return {
    ...fallbackPeople,
    departmentStats: [],
    employees: [],
    femaleEmployees: [],
    inactiveEmployees: [],
    leaverDepartmentStats: [],
    leavers: [],
    monthLeavers: [],
    orgStats: []
  };
}

function emptyIamState(fallbackIam = {}) {
  return {
    ...fallbackIam,
    accountStats: {
      activeAssignedAccounts: 0,
      activeEmployees: 0,
      assignedAccounts: 0,
      coverageRate: 0,
      disabledAccounts: 0,
      missingAccounts: 0,
      totalEmployees: 0
    },
    accounts: [],
    roles: [],
    users: []
  };
}

export function apiRequiredBaselineState(fallbackState = {}) {
  return {
    ...fallbackState,
    analytics: null,
    approvalRuleCoverage: null,
    approvalRules: [],
    approvals: [],
    assetEvents: [],
    assets: [],
    attendanceRecords: [],
    auditLogs: [],
    exportRecords: [],
    files: [],
    financeRequests: [],
    iam: emptyIamState(fallbackState.iam),
    importRuns: [],
    leaves: [],
    payrolls: [],
    people: emptyPeopleState(fallbackState.people),
    resourceBookings: [],
    resources: [],
    systemReadiness: fallbackState.systemReadiness || {},
    workflowDefinitions: []
  };
}

export function normalizePeoplePayload(payload, fallbackPeople) {
  const people = pickObject(payload, ["people", "overview"]) || {};
  const employees = pickArray(payload, ["employees"]) || pickArray(people, ["employees"]);
  const inactiveEmployees = pickArray(payload, ["inactiveEmployees", "suspendedEmployees"])
    || pickArray(people, ["inactiveEmployees", "suspendedEmployees"]);
  const leavers = pickArray(payload, ["leavers"]) || pickArray(people, ["leavers"]);
  const femaleEmployees = pickArray(payload, ["femaleEmployees", "womenEmployees"]) || pickArray(people, ["femaleEmployees", "womenEmployees"]);
  const monthLeavers = pickArray(payload, ["monthLeavers"]) || pickArray(people, ["monthLeavers"]);
  const departmentStats = pickArray(payload, ["departmentStats", "departments"]) || pickArray(people, ["departmentStats", "departments"]);
  const leaverDepartmentStats = pickArray(payload, ["leaverDepartmentStats"]) || pickArray(people, ["leaverDepartmentStats"]);

  if (!employees && !leavers && !departmentStats) return null;
  return {
    ...fallbackPeople,
    ...people,
    employees: employees || fallbackPeople.employees,
    inactiveEmployees: inactiveEmployees || fallbackPeople.inactiveEmployees || [],
    leavers: leavers || fallbackPeople.leavers,
    femaleEmployees: femaleEmployees || fallbackPeople.femaleEmployees,
    monthLeavers: monthLeavers || fallbackPeople.monthLeavers,
    departmentStats: departmentStats || fallbackPeople.departmentStats,
    leaverDepartmentStats: leaverDepartmentStats || fallbackPeople.leaverDepartmentStats
  };
}

function normalizeIamPayload(payload, fallbackIam = {}) {
  const iam = pickObject(payload, ["iam", "overview"]) || {};
  const roles = pickArray(payload, ["roles"]) || pickArray(iam, ["roles"]);
  const permissions = pickArray(payload, ["permissions"]) || pickArray(iam, ["permissions"]);
  const users = pickArray(payload, ["users"]) || pickArray(iam, ["users"]);

  if (!roles && !permissions && !users) return null;
  return {
    ...fallbackIam,
    ...iam,
    roles: roles || fallbackIam.roles || [],
    permissions: permissions || fallbackIam.permissions || [],
    users: users || fallbackIam.users || []
  };
}

function normalizeAnalyticsPayload(payload) {
  const analytics = pickObject(payload, ["analytics", "overview"]);
  return analytics || null;
}

function normalizeSystemReadinessPayload(payload, fallbackSystemReadiness = {}) {
  const systemReadiness = pickObject(payload, ["systemReadiness", "readiness"]);
  if (!systemReadiness) return null;
  return {
    ...fallbackSystemReadiness,
    ...systemReadiness
  };
}

export function normalizeApiStatePayload(payloads, fallbackState) {
  const nextState = {};
  const analytics = normalizeAnalyticsPayload(payloads.analytics);
  const people = normalizePeoplePayload(payloads.people, fallbackState.people);
  const iam = normalizeIamPayload(payloads.iamOverview, fallbackState.iam);
  const systemReadiness = normalizeSystemReadinessPayload(payloads.systemReadiness, fallbackState.systemReadiness);
  const approvals = pickArray(payloads.approvals, ["approvals"]);
  const workflowDefinitions = pickArray(payloads.workflowDefinitions, ["workflowDefinitions", "definitions"]);
  const approvalRules = pickArray(payloads.approvalRules, ["approvalRules", "rules"])
    || pickArray(payloads.approvals, ["approvalRules", "rules"]);
  const approvalRuleCoverage = pickObject(payloads.approvalRuleCoverage, ["approvalRuleCoverage", "coverage"]);
  const assets = pickArray(payloads.assets, ["assets"]);
  const assetEvents = pickArray(payloads.assetEvents, ["assetEvents", "events"])
    || pickArray(payloads.assets, ["assetEvents", "events"]);
  const resources = pickArray(payloads.resources, ["resources"]);
  const resourceWindowStart = pickStateValue(payloads.resources, "windowStart");
  const resourceBookings = pickArray(payloads.resourceBookings, ["resourceBookings", "bookings"])
    || pickArray(payloads.resources, ["resourceBookings", "bookings"]);
  const leaves = pickArray(payloads.leaves, ["leaves", "leaveRequests"]);
  const attendanceRecords = pickArray(payloads.attendanceRecords, ["attendanceRecords", "records"]);
  const financeRequests = pickArray(payloads.financeRequests, ["financeRequests", "requests"]);
  const payrolls = pickArray(payloads.payrolls, ["payrolls", "payrollBatches"]);
  const auditLogs = pickArray(payloads.auditLogs, ["auditLogs", "logs", "audit"]);
  const exportRecords = pickArray(payloads.auditLogs, ["exportRecords", "exports"]);
  const auditIntegrity = pickObject(payloads.auditIntegrity, ["auditIntegrity", "integrity"]);
  const files = pickArray(payloads.files, ["files", "attachments"]);
  const importRuns = pickArray(payloads.importRuns, ["importRuns", "imports"]);
  const revealSensitive = pickStateValue(payloads.auditLogs, "revealSensitive");

  if (analytics) nextState.analytics = analytics;
  if (people) nextState.people = people;
  if (iam) nextState.iam = iam;
  if (systemReadiness) nextState.systemReadiness = systemReadiness;
  if (approvals) nextState.approvals = approvals;
  if (workflowDefinitions) nextState.workflowDefinitions = workflowDefinitions;
  if (approvalRules) nextState.approvalRules = approvalRules;
  if (approvalRuleCoverage) nextState.approvalRuleCoverage = approvalRuleCoverage;
  if (assets) nextState.assets = assets;
  if (assetEvents) nextState.assetEvents = assetEvents;
  if (resources) nextState.resources = resources;
  if (resourceWindowStart) nextState.resourceWindowStart = resourceWindowStart;
  if (resourceBookings) nextState.resourceBookings = resourceBookings;
  if (leaves) nextState.leaves = leaves;
  if (attendanceRecords) nextState.attendanceRecords = attendanceRecords;
  if (financeRequests) nextState.financeRequests = financeRequests;
  if (payrolls) nextState.payrolls = payrolls;
  if (auditLogs) nextState.auditLogs = auditLogs;
  if (exportRecords) nextState.exportRecords = exportRecords;
  if (auditIntegrity) nextState.auditIntegrity = auditIntegrity;
  if (files) nextState.files = files;
  if (importRuns) nextState.importRuns = importRuns;
  if (typeof revealSensitive === "boolean") nextState.revealSensitive = revealSensitive;

  return nextState;
}

export function mergeApiState(fallbackState, apiState, localOverrideDomains = new Set()) {
  if (!apiState) return fallbackState;
  const nextState = { ...fallbackState };
  if (!localOverrideDomains.has("people") && apiState.people) nextState.people = apiState.people;
  if (!localOverrideDomains.has("analytics") && apiState.analytics) nextState.analytics = apiState.analytics;
  if (!localOverrideDomains.has("iam") && apiState.iam) nextState.iam = apiState.iam;
  if (!localOverrideDomains.has("approvals")) {
    if (apiState.approvals) nextState.approvals = apiState.approvals;
    if (apiState.workflowDefinitions) nextState.workflowDefinitions = apiState.workflowDefinitions;
    if (apiState.approvalRules) nextState.approvalRules = apiState.approvalRules;
    if (apiState.approvalRuleCoverage) nextState.approvalRuleCoverage = apiState.approvalRuleCoverage;
  }
  if (!localOverrideDomains.has("assets")) {
    if (apiState.assets) nextState.assets = apiState.assets;
    if (apiState.assetEvents) nextState.assetEvents = apiState.assetEvents;
  }
  if (!localOverrideDomains.has("resources")) {
    if (apiState.resources) nextState.resources = apiState.resources;
    if (apiState.resourceWindowStart) nextState.resourceWindowStart = apiState.resourceWindowStart;
    if (apiState.resourceBookings) nextState.resourceBookings = apiState.resourceBookings;
  }
  if (!localOverrideDomains.has("attendance")) {
    if (apiState.leaves) nextState.leaves = apiState.leaves;
    if (apiState.attendanceRecords) nextState.attendanceRecords = apiState.attendanceRecords;
  }
  if (!localOverrideDomains.has("finance")) {
    if (apiState.financeRequests) nextState.financeRequests = apiState.financeRequests;
    if (apiState.payrolls) nextState.payrolls = apiState.payrolls;
  }
  if (!localOverrideDomains.has("audit")) {
    if (apiState.auditLogs) nextState.auditLogs = apiState.auditLogs;
    if (apiState.exportRecords) nextState.exportRecords = apiState.exportRecords;
    if (apiState.auditIntegrity) nextState.auditIntegrity = apiState.auditIntegrity;
    if (typeof apiState.revealSensitive === "boolean") nextState.revealSensitive = apiState.revealSensitive;
  }
  if (!localOverrideDomains.has("files") && apiState.files) nextState.files = apiState.files;
  if (!localOverrideDomains.has("imports") && apiState.importRuns) nextState.importRuns = apiState.importRuns;
  if (!localOverrideDomains.has("system") && apiState.systemReadiness) nextState.systemReadiness = apiState.systemReadiness;
  return nextState;
}

export function fallbackUser() {
  return FALLBACK_USER;
}
