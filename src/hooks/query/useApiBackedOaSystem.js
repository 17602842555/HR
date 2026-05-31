import { useCallback, useEffect, useMemo, useState } from "react";
import * as analyticsApi from "../../api/analytics.js";
import * as approvalApi from "../../api/approvals.js";
import * as assetApi from "../../api/assets.js";
import * as attendanceApi from "../../api/attendance.js";
import * as auditApi from "../../api/audit.js";
import * as authApi from "../../api/auth.js";
import * as financeApi from "../../api/finance.js";
import * as fileApi from "../../api/files.js";
import * as iamApi from "../../api/iam.js";
import * as importApi from "../../api/imports.js";
import { ApiError } from "../../api/client.js";
import * as peopleApi from "../../api/people.js";
import * as resourceApi from "../../api/resources.js";
import * as systemApi from "../../api/system.js";
import { apiUnavailableStatus, resolveApiPolicy } from "../../config/apiPolicy.mjs";
import { apiActionErrorStatus, canFallbackToLocalAction } from "../../services/apiFallbackPolicy.mjs";
import { fallbackUser, mergeApiState, normalizeApiStatePayload, normalizeCurrentUser } from "../../services/apiState.js";
import { useOaSystem } from "../useOaSystem.js";

const DOMAIN_LOADERS = {
  analytics: [
    ["analytics", analyticsApi.getAnalyticsOverview]
  ],
  people: [
    ["people", peopleApi.getPeopleOverview]
  ],
  iam: [
    ["iamOverview", iamApi.getIamOverview]
  ],
  approvals: [
    ["workflowDefinitions", approvalApi.listApprovalDefinitions],
    ["approvals", approvalApi.listApprovals],
    ["approvalRules", approvalApi.listApprovalRules],
    ["approvalRuleCoverage", approvalApi.listApprovalRuleCoverage]
  ],
  assets: [
    ["assets", assetApi.listAssets],
    ["assetEvents", assetApi.listAssetEvents]
  ],
  attendance: [
    ["attendanceRecords", attendanceApi.listAttendanceRecords],
    ["leaves", attendanceApi.listLeaves]
  ],
  finance: [
    ["financeRequests", financeApi.listFinanceRequests],
    ["payrolls", financeApi.listPayrolls]
  ],
  files: [
    ["files", fileApi.listFiles]
  ],
  imports: [
    ["importRuns", importApi.listImportRuns]
  ],
  resources: [
    ["resources", resourceApi.listResources],
    ["resourceBookings", resourceApi.listResourceBookings]
  ],
  audit: [
    ["auditLogs", auditApi.listAuditLogs],
    ["auditIntegrity", auditApi.getAuditIntegrity]
  ],
  system: [
    ["systemReadiness", systemApi.getSystemReadiness, { optionalForbidden: true }]
  ]
};

const ALL_DOMAINS = Object.keys(DOMAIN_LOADERS);

const DOMAIN_READ_PERMISSIONS = {
  analytics: ["analytics.read"],
  approvals: ["workflow.read"],
  assets: ["asset.read"],
  attendance: ["attendance.read"],
  audit: ["audit.read"],
  files: ["file.read"],
  finance: ["finance.read"],
  iam: ["iam.read"],
  imports: ["import.read"],
  people: ["employee.read"],
  resources: ["resource.read"],
  system: ["system.admin"]
};

function domainsForUser(user) {
  if (!Array.isArray(user?.permissions)) return ALL_DOMAINS;
  const permissions = new Set(user.permissions);
  if (permissions.has("system.admin")) return ALL_DOMAINS;
  return ALL_DOMAINS.filter((domain) => (
    (DOMAIN_READ_PERMISSIONS[domain] || []).some((permission) => permissions.has(permission))
  ));
}

function loadersFor(domains = ALL_DOMAINS) {
  return domains.flatMap((domain) => (
    (DOMAIN_LOADERS[domain] || []).map(([key, load, options]) => ({ key, load, ...(options || {}) }))
  ));
}

async function fetchDomainState(fallbackState, domains) {
  const loaders = loadersFor(domains);
  const settled = await Promise.allSettled(loaders.map(({ load }) => load()));
  const payloads = {};
  const errors = [];

  settled.forEach((result, index) => {
    const loader = loaders[index];
    const key = loader.key;
    if (result.status === "fulfilled") {
      payloads[key] = result.value;
      return;
    }
    if (loader.optionalForbidden && result.reason instanceof ApiError && result.reason.status === 403) {
      return;
    }
    errors.push(result.reason);
  });

  const state = normalizeApiStatePayload(payloads, fallbackState);
  return {
    errors,
    state,
    totalCalls: loaders.length
  };
}

function calculateMetrics(state) {
  const employees = state.people.employees.length;
  const leavers = state.people.leavers.length;
  const femaleEmployees = state.people.femaleEmployees.length || state.people.employees.filter((item) => item.gender === "女").length;
  const monthLeavers = state.people.monthLeavers.length;
  const pendingApprovals = state.approvals.filter((item) => item.status.includes("待") || item.status.includes("超时")).length;
  const activeAssets = state.assets.filter((item) => item.status.includes("用") || item.status.includes("借")).length;
  const resourceConflicts = state.resources.filter((item) => item.slots.some((slot) => slot >= item.total)).length;
  return {
    activeAssets,
    assetUseRate: Math.round((activeAssets / Math.max(state.assets.length, 1)) * 100),
    auditToday: state.auditLogs.length,
    employees,
    femaleEmployees,
    leavers,
    monthLeavers,
    pendingApprovals,
    resourceConflicts,
    totalPeople: employees + leavers
  };
}

function actionErrorMessage(error) {
  return error?.message || "API action failed";
}

function isUnauthorized(error) {
  return error instanceof ApiError && error.status === 401;
}

function assetActionForStatus(status) {
  return {
    借用中: "borrow",
    空闲: "return",
    维修中: "repair",
    已退役: "retire"
  }[status] || "";
}

export function useApiBackedOaSystem() {
  const fallback = useOaSystem();
  const apiPolicy = useMemo(() => resolveApiPolicy(import.meta.env), []);
  const [apiState, setApiState] = useState(null);
  const [currentUser, setCurrentUser] = useState(() => fallbackUser());
  const [authBusy, setAuthBusy] = useState(false);
  const [localOverrideDomains, setLocalOverrideDomains] = useState(() => new Set());
  const [apiStatus, setApiStatus] = useState({
    error: "",
    mode: "loading",
    source: "mock"
  });

  useEffect(() => {
    let cancelled = false;

    async function bootstrap() {
      try {
        const authPayload = await authApi.getCurrentUser();
        if (cancelled) return;
        const user = normalizeCurrentUser(authPayload);
        if (user.source !== "api") {
          setApiStatus({ error: "会话无效", mode: "unauthenticated", source: "api" });
          return;
        }
        if (user.mustChangePassword) {
          setCurrentUser(user);
          setApiStatus({ error: "请先完成首次登录设置", mode: "first_login_required", source: "api" });
          return;
        }
        const domainResult = await fetchDomainState(fallback.state, domainsForUser(user));
        if (cancelled) return;
        setCurrentUser(user);
        setApiState(domainResult.state);
        setApiStatus({
          error: domainResult.errors[0]?.message || "",
          mode: domainResult.errors.length ? "degraded" : "ready",
          source: "api"
        });
      } catch (error) {
        if (cancelled) return;
        if (isUnauthorized(error)) {
          setCurrentUser(fallbackUser());
          setApiStatus({ error: "请登录后访问后端数据", mode: "unauthenticated", source: "api" });
          return;
        }
        setCurrentUser(fallbackUser());
        setApiStatus(apiUnavailableStatus(error, import.meta.env));
      }
    }

    bootstrap();
    return () => {
      cancelled = true;
    };
  }, []);

  const markLocalOverride = useCallback((domains) => {
    setLocalOverrideDomains((current) => {
      const next = new Set(current);
      domains.forEach((domain) => next.add(domain));
      return next;
    });
  }, []);

  const reloadDomains = useCallback(async (domains) => {
    const result = await fetchDomainState(fallback.state, domains);
    const loadedKeys = Object.keys(result.state);
    if (loadedKeys.length > 0) {
      setApiState((current) => ({ ...(current || {}), ...result.state }));
      setLocalOverrideDomains((current) => {
        const next = new Set(current);
        domains.forEach((domain) => next.delete(domain));
        return next;
      });
      setApiStatus({
        error: result.errors[0]?.message || "",
        mode: result.errors.length ? "degraded" : "ready",
        source: "mixed"
      });
    }
    return result;
  }, [fallback.state]);

  const state = useMemo(
    () => mergeApiState(fallback.state, apiState, localOverrideDomains),
    [apiState, fallback.state, localOverrideDomains]
  );
  const metrics = useMemo(() => calculateMetrics(state), [state]);
  const shouldUseApi = apiStatus.source !== "mock" && !["api_required", "fallback", "first_login_required", "unauthenticated"].includes(apiStatus.mode);
  const currentUserName = currentUser?.name || fallbackUser().name;

  const auth = useMemo(() => ({
    busy: authBusy,
    async login(credentials) {
      setAuthBusy(true);
      try {
        const payload = await authApi.login(credentials);
        const user = normalizeCurrentUser(payload);
        if (user.mustChangePassword) {
          setCurrentUser(user);
          setApiState(null);
          setLocalOverrideDomains(new Set());
          setApiStatus({ error: "请先完成首次登录设置", mode: "first_login_required", source: "api" });
          return { ok: true, firstLoginRequired: true };
        }
        const domainResult = await fetchDomainState(fallback.state, domainsForUser(user));
        setCurrentUser(user);
        setApiState(domainResult.state);
        setLocalOverrideDomains(new Set());
        setApiStatus({
          error: domainResult.errors[0]?.message || "",
          mode: domainResult.errors.length ? "degraded" : "ready",
          source: "api"
        });
        return { ok: true };
      } catch (error) {
        const apiReturnedBusinessError = Number(error?.status || 0) > 0;
        setApiStatus({
          error: actionErrorMessage(error),
          mode: isUnauthorized(error) || apiReturnedBusinessError ? "unauthenticated" : apiPolicy.requireApi ? "api_required" : "fallback",
          source: isUnauthorized(error) || apiReturnedBusinessError || apiPolicy.requireApi ? "api" : "mock"
        });
        return { ok: false, error };
      } finally {
        setAuthBusy(false);
      }
    },
    async changePassword(payload) {
      if (!shouldUseApi) {
        return { ok: false, error: new Error("后端未连接，无法修改登录密码。") };
      }
      setAuthBusy(true);
      try {
        const session = await authApi.changePassword(payload);
        setCurrentUser(normalizeCurrentUser(session));
        await reloadDomains(["audit"]);
        setApiStatus({ error: "", mode: "ready", source: "api" });
        return { ok: true };
      } catch (error) {
        setApiStatus(apiActionErrorStatus(error, apiPolicy));
        return { ok: false, error };
      } finally {
        setAuthBusy(false);
      }
    },
    async completeFirstLogin(payload) {
      setAuthBusy(true);
      try {
        const session = await authApi.completeFirstLogin(payload);
        const user = normalizeCurrentUser(session);
        const domainResult = await fetchDomainState(fallback.state, domainsForUser(user));
        setCurrentUser(user);
        setApiState(domainResult.state);
        setLocalOverrideDomains(new Set());
        setApiStatus({
          error: domainResult.errors[0]?.message || "",
          mode: domainResult.errors.length ? "degraded" : "ready",
          source: "api"
        });
        return { ok: true };
      } catch (error) {
        setApiStatus({ error: actionErrorMessage(error), mode: "first_login_required", source: "api" });
        return { ok: false, error };
      } finally {
        setAuthBusy(false);
      }
    },
    async logout() {
      setAuthBusy(true);
      try {
        if (shouldUseApi || apiStatus.mode === "first_login_required") await authApi.logout();
      } catch {
        // Logging out should clear the local session view even if the API is already unavailable.
      } finally {
        setApiState(null);
        setCurrentUser(fallbackUser());
        setLocalOverrideDomains(new Set());
        setApiStatus({ error: "已退出登录", mode: "unauthenticated", source: "api" });
        setAuthBusy(false);
      }
    }
  }), [apiPolicy, apiStatus.mode, authBusy, fallback.state, reloadDomains, shouldUseApi]);

  const actions = useMemo(() => {
    const localOnly = (domains, localAction) => (...args) => {
      markLocalOverride(domains);
      localAction(...args);
    };

    const apiBacked = (domains, apiCall, localAction) => (...args) => {
      if (!shouldUseApi) {
        markLocalOverride(domains);
        localAction(...args);
        return;
      }

      void (async () => {
        try {
          await apiCall(...args);
          await reloadDomains(domains);
        } catch (error) {
          if (canFallbackToLocalAction(error, apiPolicy)) {
            markLocalOverride(domains);
            localAction(...args);
          }
          setApiStatus(apiActionErrorStatus(error, apiPolicy));
        }
      })();
    };

    const toggleSensitive = () => {
      const enabled = !state.revealSensitive;
      if (!shouldUseApi) {
        markLocalOverride(["people", "audit"]);
        fallback.actions.toggleSensitive();
        return;
      }

      void (async () => {
        try {
          await auditApi.setSensitiveAccess(enabled);
          const [peoplePayload, auditPayload, auditIntegrityPayload] = await Promise.all([
            peopleApi.getPeopleOverview(enabled ? { revealSensitive: "true" } : {}),
            auditApi.listAuditLogs(),
            auditApi.getAuditIntegrity()
          ]);
          const nextState = normalizeApiStatePayload({
            auditLogs: auditPayload,
            auditIntegrity: auditIntegrityPayload,
            people: peoplePayload
          }, fallback.state);
          setApiState((current) => ({
            ...(current || {}),
            ...nextState,
            revealSensitive: enabled
          }));
          setLocalOverrideDomains((current) => {
            const next = new Set(current);
            next.delete("people");
            next.delete("audit");
            return next;
          });
          setApiStatus({ error: "", mode: "ready", source: "api" });
        } catch (error) {
          if (canFallbackToLocalAction(error, apiPolicy)) {
            markLocalOverride(["people", "audit"]);
            fallback.actions.toggleSensitive();
          }
          setApiStatus(apiActionErrorStatus(error, apiPolicy));
        }
      })();
    };

    return {
      ...fallback.actions,
      addApprovalComment: apiBacked(
        ["approvals", "audit"],
        (id, content) => approvalApi.addApprovalComment(id, { content }),
        fallback.actions.addApprovalComment
      ),
      createApproval: apiBacked(
        ["approvals", "audit"],
        (template, overrides = {}) => approvalApi.createApproval({
          ...overrides,
          definitionId: template.id,
          template
        }),
        fallback.actions.createApproval
      ),
      updateEmployee: apiBacked(
        ["people", "audit"],
        (id, payload) => peopleApi.updateEmployee(id, payload),
        fallback.actions.updateEmployee
      ),
      exportPeople: apiBacked(
        ["audit"],
        (filters) => peopleApi.exportPeople(filters),
        fallback.actions.exportPeople
      ),
      exportAssets: apiBacked(
        ["audit"],
        (filters) => assetApi.exportAssets(filters),
        fallback.actions.exportAssets
      ),
      importDashboardHtml: apiBacked(
        ["people", "imports", "audit"],
        (payload) => importApi.importDashboardHtml(payload),
        fallback.actions.importDashboardHtml
      ),
      downloadImportSource: apiBacked(
        ["imports", "audit"],
        (run) => importApi.downloadImportSource(run),
        fallback.actions.downloadImportSource
      ),
      createAsset: apiBacked(
        ["assets", "audit"],
        (entry) => assetApi.createAsset(entry),
        fallback.actions.createAsset
      ),
      createLeave: apiBacked(
        ["attendance", "audit"],
        (entry) => attendanceApi.createLeave(entry),
        fallback.actions.createLeave
      ),
      createAttendanceRecord: apiBacked(
        ["attendance", "audit"],
        (entry) => attendanceApi.createAttendanceRecord(entry),
        fallback.actions.createAttendanceRecord
      ),
      exportAttendanceRecords: apiBacked(
        ["audit"],
        (filters) => attendanceApi.exportAttendanceRecords(filters),
        fallback.actions.exportAttendanceRecords
      ),
      async createPayroll(payload) {
        if (!shouldUseApi) {
          markLocalOverride(["finance", "approvals", "audit"]);
          return fallback.actions.createPayroll(payload);
        }

        try {
          const result = await financeApi.createPayroll(payload);
          await reloadDomains(["finance", "approvals", "audit"]);
          setApiStatus({ error: "", mode: "ready", source: "api" });
          return result;
        } catch (error) {
          if (canFallbackToLocalAction(error, apiPolicy)) {
            markLocalOverride(["finance", "approvals", "audit"]);
            return fallback.actions.createPayroll(payload);
          }
          setApiStatus(apiActionErrorStatus(error, apiPolicy));
          throw error;
        }
      },
      createFinanceRequest: apiBacked(
        ["finance", "approvals", "audit"],
        (payload) => financeApi.createFinanceRequest(payload),
        fallback.actions.createFinanceRequest
      ),
      exportFinanceRequests: apiBacked(
        ["audit"],
        (filters) => financeApi.exportFinanceRequests(filters),
        fallback.actions.exportFinanceRequests
      ),
      decideApproval: apiBacked(
        ["approvals", "audit"],
        (id, decision, approverName) => approvalApi.decideApproval(id, { approverName, decision }),
        fallback.actions.decideApproval
      ),
      exportApprovals: apiBacked(
        ["audit"],
        (filters) => approvalApi.exportApprovals(filters),
        fallback.actions.exportApprovals
      ),
      exportAudit: apiBacked(
        ["audit"],
        (scope, filters) => auditApi.exportAudit(scope, filters),
        fallback.actions.exportAudit
      ),
      uploadFile: apiBacked(
        ["files", "audit"],
        (file, options) => fileApi.uploadFile(file, options),
        fallback.actions.uploadFile
      ),
      downloadFile: apiBacked(
        ["files", "audit"],
        (file) => fileApi.downloadFile(file),
        fallback.actions.downloadFile
      ),
      replaceQr: apiBacked(
        ["assets", "audit"],
        (id) => assetApi.replaceAssetQr(id),
        fallback.actions.replaceQr
      ),
      inventoryAsset: apiBacked(
        ["assets", "audit"],
        (id, result = "正常") => assetApi.runAssetAction(id, { action: "inventory", result }),
        fallback.actions.inventoryAsset
      ),
      reserveResource: apiBacked(
        ["resources", "audit"],
        (name, dayIndex, payload = {}) => resourceApi.reserveResource({ ...payload, dayIndex, resourceName: name }),
        fallback.actions.reserveResource
      ),
      cancelResourceBooking: apiBacked(
        ["resources", "audit"],
        (id, reason) => resourceApi.cancelResourceBooking(id, { reason }),
        fallback.actions.cancelResourceBooking
      ),
      exportResourceBookings: apiBacked(
        ["audit"],
        (filters) => resourceApi.exportResourceBookings(filters),
        fallback.actions.exportResourceBookings
      ),
      exportAnalyticsSnapshot: apiBacked(
        ["audit"],
        (filters) => analyticsApi.exportAnalyticsSnapshot(filters),
        fallback.actions.exportAnalyticsSnapshot
      ),
      reset() {
        fallback.actions.reset();
        setApiState(null);
        setLocalOverrideDomains(new Set());
        setCurrentUser(fallbackUser());
        setApiStatus(apiPolicy.allowDemoFallback
          ? { error: "", mode: "fallback", source: "mock" }
          : { error: "生产模式不允许重置为本地演示数据", mode: "api_required", source: "api" });
      },
      reviewPayroll: apiBacked(
        ["finance", "audit"],
        (id) => financeApi.reviewPayroll(id, { comment: "复核通过" }),
        fallback.actions.reviewPayroll
      ),
      async createUserAccount(payload) {
        if (!shouldUseApi) {
          markLocalOverride(["iam", "audit"]);
          return fallback.actions.createUserAccount(payload);
        }
        try {
          const result = await iamApi.createUser(payload);
          await reloadDomains(["iam", "audit"]);
          setApiStatus({ error: "", mode: "ready", source: "api" });
          return result;
        } catch (error) {
          if (canFallbackToLocalAction(error, apiPolicy)) {
            markLocalOverride(["iam", "audit"]);
            return fallback.actions.createUserAccount(payload);
          }
          setApiStatus(apiActionErrorStatus(error, apiPolicy));
          return { ok: false, error };
        }
      },
      async syncEmployeeAccounts(payload) {
        if (!shouldUseApi) {
          markLocalOverride(["iam", "audit"]);
          return fallback.actions.syncEmployeeAccounts(payload);
        }
        try {
          const result = await iamApi.syncEmployeeAccounts(payload);
          await reloadDomains(["iam", "audit"]);
          setApiStatus({ error: "", mode: "ready", source: "api" });
          return result;
        } catch (error) {
          if (canFallbackToLocalAction(error, apiPolicy)) {
            markLocalOverride(["iam", "audit"]);
            return fallback.actions.syncEmployeeAccounts(payload);
          }
          setApiStatus(apiActionErrorStatus(error, apiPolicy));
          return { ok: false, error };
        }
      },
      updateRolePermissions: apiBacked(
        ["iam", "audit"],
        (roleId, permissionCodes) => iamApi.updateRolePermissions(roleId, permissionCodes),
        fallback.actions.updateRolePermissions
      ),
      updateUserRoles: apiBacked(
        ["iam", "audit"],
        (userId, roleCodes) => iamApi.updateUserRoles(userId, roleCodes),
        fallback.actions.updateUserRoles
      ),
      updateUserStatus: apiBacked(
        ["iam", "audit"],
        (userId, status) => iamApi.updateUserStatus(userId, status),
        fallback.actions.updateUserStatus
      ),
      async resetUserPassword(userId, newPassword) {
        if (!shouldUseApi) {
          markLocalOverride(["audit"]);
          fallback.actions.resetUserPassword(userId, newPassword);
          return { ok: true };
        }
        try {
          await iamApi.resetUserPassword(userId, newPassword);
          await reloadDomains(["iam", "audit"]);
          setApiStatus({ error: "", mode: "ready", source: "api" });
          return { ok: true };
        } catch (error) {
          if (canFallbackToLocalAction(error, apiPolicy)) {
            markLocalOverride(["audit"]);
            fallback.actions.resetUserPassword(userId, newPassword);
          }
          setApiStatus(apiActionErrorStatus(error, apiPolicy));
          return { ok: false, error };
        }
      },
      saveApprovalRule: apiBacked(
        ["approvals", "audit"],
        (rule) => approvalApi.saveApprovalRule(rule),
        fallback.actions.saveApprovalRule
      ),
      deleteApprovalRule: apiBacked(
        ["approvals", "audit"],
        (id) => approvalApi.deleteApprovalRule(id),
        fallback.actions.deleteApprovalRule
      ),
      async previewApprovalRule(query) {
        if (!shouldUseApi) return fallback.actions.previewApprovalRule(query);
        try {
          const payload = await approvalApi.previewApprovalRule(query);
          await reloadDomains(["audit"]);
          setApiStatus({ error: "", mode: "ready", source: "api" });
          return payload;
        } catch (error) {
          if (canFallbackToLocalAction(error, apiPolicy)) {
            markLocalOverride(["approvals"]);
            return fallback.actions.previewApprovalRule(query);
          }
          setApiStatus(apiActionErrorStatus(error, apiPolicy));
          throw error;
        }
      },
      toggleSensitive,
      transferApproval: apiBacked(
        ["approvals", "audit"],
        (id, target, sourceApproverName) => approvalApi.transferApproval(id, { target, sourceApproverName }),
        fallback.actions.transferApproval
      ),
      updateAsset: apiBacked(
        ["assets", "audit"],
        (id, status, owner) => {
          const action = assetActionForStatus(status);
          return action
            ? assetApi.runAssetAction(id, { action, owner: owner || currentUserName })
            : assetApi.updateAsset(id, { owner, status });
        },
        fallback.actions.updateAsset
      ),
      withdrawApproval: apiBacked(
        ["approvals", "audit"],
        (id) => approvalApi.withdrawApproval(id),
        fallback.actions.withdrawApproval
      )
    };
  }, [apiPolicy.allowDemoFallback, apiPolicy.requireApi, currentUserName, fallback.actions, markLocalOverride, reloadDomains, shouldUseApi, state.revealSensitive]);

  return {
    actions,
    auth,
    apiStatus,
    currentUser,
    metrics,
    state
  };
}
