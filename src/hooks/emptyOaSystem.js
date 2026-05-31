import { useMemo } from "react";

const emptyPeople = {
  departmentStats: [],
  employees: [],
  femaleEmployees: [],
  inactiveEmployees: [],
  leaverDepartmentStats: [],
  leavers: [],
  monthLeavers: [],
  orgStats: []
};

const emptyState = {
  analytics: null,
  approvalRuleCoverage: null,
  approvalRules: [],
  approvals: [],
  assetEvents: [],
  assets: [],
  attendanceRecords: [],
  auditIntegrity: {
    ok: false,
    errors: [],
    warnings: ["商业构建不包含本地演示审计数据。"],
    summary: { totalRows: 0, signedRows: 0, unsignedRows: 0 }
  },
  auditLogs: [],
  exportRecords: [],
  files: [],
  financeRequests: [],
  iam: {
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
    permissions: [],
    roles: [],
    users: []
  },
  importRuns: [],
  leaves: [],
  payrolls: [],
  people: emptyPeople,
  resourceBookings: [],
  resourceWindowStart: new Date().toISOString().slice(0, 10),
  resources: [],
  systemReadiness: {},
  workflowDefinitions: []
};

function disabledLocalAction() {
  return { ok: false, error: new Error("商业构建已禁用本地演示动作，请连接后端 API。") };
}

export function useOaSystem() {
  const actions = useMemo(() => new Proxy({
    reset: disabledLocalAction
  }, {
    get(target, key) {
      if (key in target) return target[key];
      return disabledLocalAction;
    }
  }), []);

  return {
    actions,
    metrics: {
      activeAssets: 0,
      assetUseRate: 0,
      auditToday: 0,
      employees: 0,
      femaleEmployees: 0,
      leavers: 0,
      monthLeavers: 0,
      pendingApprovals: 0,
      resourceConflicts: 0,
      totalPeople: 0
    },
    state: emptyState
  };
}
