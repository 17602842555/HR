import { useEffect, useMemo, useState } from "react";
import { loadDashboardPeople, loadDashboardPeopleFromHtml } from "../data/dashboardSource.js";
import {
  assetEventSeed,
  attendanceRecordSeed,
  auditSeed,
  fieldValueLabel,
  flowTemplates,
  formDefaults,
  initialAssets,
  makeDepartmentApprovalRules,
  makeInitialApprovals,
  nextAssetId,
  permissionCatalog,
  roleSeed,
  resourceBookingSeed,
  resourceSeed
} from "../data/seed.js";
import { clearStoredState, readStoredState, writeStoredState } from "../services/storage.js";

function stamp() {
  return new Date().toLocaleString("sv-SE", { hour12: false }).replace("T", " ");
}

function todayToken() {
  return new Date().toISOString().slice(0, 10);
}

function dayIndexForDate(dateToken, baseToken = todayToken()) {
  if (!dateToken) return -1;
  const date = new Date(`${dateToken}T00:00:00.000Z`);
  const base = new Date(`${baseToken}T00:00:00.000Z`);
  const diff = Math.floor((date.getTime() - base.getTime()) / 86_400_000);
  return diff >= 0 && diff <= 6 ? diff : -1;
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    if (typeof FileReader === "undefined") {
      resolve("");
      return;
    }
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result || "")));
    reader.addEventListener("error", () => reject(reader.error || new Error("Unable to read file")));
    reader.readAsDataURL(file);
  });
}

function downloadLocalFile(file) {
  if (
    !file?.contentDataUrl
    || typeof document === "undefined"
    || typeof URL === "undefined"
  ) {
    return;
  }
  const link = document.createElement("a");
  link.href = file.contentDataUrl;
  link.download = file.fileName || "attachment.bin";
  link.style.display = "none";
  document.body.append(link);
  link.click();
  link.remove();
}

function localAuditIntegrity(logs = []) {
  return {
    ok: false,
    errors: [],
    warnings: ["当前为本地演示审计日志，未连接后端哈希链校验。"],
    summary: {
      totalRows: logs.length,
      signedRows: 0,
      unsignedRows: logs.length,
      firstSequence: null,
      lastSequence: null,
      lastHash: null
    }
  };
}

function accountLocalPart(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, ".")
    .replace(/^[._-]+|[._-]+$/g, "")
    .slice(0, 48) || "employee";
}

function employeeAccountEmail(employee, domain = "oa.local") {
  const directEmail = String(employee.email || "").trim().toLowerCase();
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(directEmail)) return directEmail;
  return `${accountLocalPart(employee.email || employee.employeeNo || employee.seq || employee.name || employee.id)}@${domain}`;
}

function isActiveEmployee(employee) {
  return ["ACTIVE", "在职"].includes(String(employee.status || "ACTIVE"));
}

function buildAccountLibrary(people, iam) {
  const users = iam.users || [];
  const accountByEmployeeId = new Map(users
    .filter((user) => user.employee?.id)
    .map((user) => [user.employee.id, user]));
  const accounts = (people.employees || []).map((employee) => {
    const employeeId = employee.id || `employee-${employee.employeeNo || employee.seq || employee.name}`;
    const user = accountByEmployeeId.get(employeeId) || users.find((item) => item.name === employee.name && item.employee?.name === employee.name) || null;
    return {
      id: employeeId,
      employeeId,
      employeeNo: employee.employeeNo || employee.seq || "-",
      employeeName: employee.name,
      employeeStatus: employee.status || "在职",
      department: employee.department || "",
      roleTitle: employee.roleTitle || employee.role || "",
      email: employee.email || "",
      account: user,
      accountEmail: user?.email || "",
      accountId: user?.id || null,
      accountStatus: user?.status || "UNASSIGNED",
      roleCodes: user?.roleCodes || user?.roles?.map((role) => role.code).filter(Boolean) || [],
      roleNames: user?.roles?.map((role) => role.name).filter(Boolean) || []
    };
  });
  const activeAccounts = accounts.filter((item) => isActiveEmployee({ status: item.employeeStatus }));
  const assignedAccounts = accounts.filter((item) => item.accountId);
  const activeAssignedAccounts = activeAccounts.filter((item) => item.accountId);
  return {
    accounts,
    accountStats: {
      totalEmployees: accounts.length,
      activeEmployees: activeAccounts.length,
      assignedAccounts: assignedAccounts.length,
      activeAssignedAccounts: activeAssignedAccounts.length,
      missingAccounts: activeAccounts.length - activeAssignedAccounts.length,
      disabledAccounts: assignedAccounts.filter((item) => item.accountStatus === "DISABLED").length,
      coverageRate: activeAccounts.length ? Math.round((activeAssignedAccounts.length / activeAccounts.length) * 100) : 100
    }
  };
}

function createInitialState() {
  const people = loadDashboardPeople();
  const approvalRules = makeDepartmentApprovalRules(people.departmentStats.map((item) => item.label));
  const initialIamUsers = [
    { id: "mock-user", name: "张三", email: "zhangsan@oa.local", status: "ACTIVE", roleCodes: ["admin"] },
    { id: "mock-hr", name: "李四", email: "lisi@oa.local", status: "ACTIVE", roleCodes: ["hr-specialist"] }
  ];
  const initialIam = {
    permissions: permissionCatalog,
    roles: roleSeed,
    users: initialIamUsers
  };
  const accountLibrary = buildAccountLibrary(people, initialIam);
  return {
    people,
    workflowDefinitions: flowTemplates.map((template) => ({
      code: template.serviceKey,
      templateId: template.id,
      name: template.name,
      category: template.category,
      fields: template.fields,
      nodes: template.nodes
    })),
    approvalRules,
    approvals: normalizeApprovals(makeInitialApprovals(), approvalRules),
    assets: initialAssets,
    assetEvents: assetEventSeed,
    resourceWindowStart: todayToken(),
    resources: resourceSeed,
    resourceBookings: resourceBookingSeed,
    attendanceRecords: attendanceRecordSeed,
    leaves: [
      { id: "LEAVE-1", employee: "张三", type: "年假", dates: "2026-05-30 ~ 2026-05-31", days: 2, status: "待审批" },
      { id: "LEAVE-2", employee: "戴慧敏", type: "病假", dates: "2026-05-27", days: 1, status: "已通过" }
    ],
    financeRequests: [
      { id: "EXP-202605-0001", type: "EXPENSE", typeLabel: "费用报销", title: "办公室耗材报销", applicant: "张三", department: "行政部", amount: 2680, currency: "CNY", vendor: "京东企业购", paymentMethod: "银行转账", status: "待审批", workflowStatus: "PENDING" },
      { id: "PAY-202605-0001", type: "PAYMENT", typeLabel: "付款申请", title: "物业服务费付款", applicant: "李四", department: "财务中心", amount: 18000, currency: "CNY", vendor: "园区物业", paymentMethod: "对公转账", status: "已通过", workflowStatus: "APPROVED" }
    ],
    payrolls: [
      { id: "PAYROLL-202605", cycle: "2026年5月", scope: "在职、转正、入离职、异动人员", status: "待复核", owner: "财务中心" },
      { id: "PAYROLL-202604", cycle: "2026年4月", scope: "全员", status: "已归档", owner: "财务中心" }
    ],
    files: [
      {
        id: "FILE-DEMO-1",
        fileName: "制度说明.txt",
        mimeType: "text/plain",
        sizeBytes: 128,
        checksum: "demo-seed",
        visibility: "TENANT",
        uploader: { name: "系统管理员" },
        createdAt: "2026-05-29T10:00:00.000Z",
        contentDataUrl: "data:text/plain;base64,5Yi25bqm6K+05piO"
      }
    ],
    importRuns: [
      {
        id: "IMPORT-DEMO-1",
        sourceType: "html-dashboard",
        sourceName: "oa-dashboard.html",
        sourceChecksum: "local-demo",
        status: "SUCCESS",
        recordCounts: {
          activeEmployees: people.employees.length,
          femaleEmployees: people.femaleEmployees.length,
          leavers: people.leavers.length,
          monthLeavers: people.monthLeavers.length,
          totalRows: people.employees.length + people.leavers.length
        },
        actor: { name: "系统管理员" },
        startedAt: "2026-05-29T10:00:00.000Z",
        finishedAt: "2026-05-29T10:01:00.000Z"
      }
    ],
    auditLogs: auditSeed,
    auditIntegrity: localAuditIntegrity(auditSeed),
    exportRecords: auditSeed
      .filter((item) => item.type === "导出" || String(item.content || "").includes("导出"))
      .map((item) => ({
        id: `EXP-${item.id}`,
        time: item.time,
        operator: item.operator,
        module: item.object,
        action: "local.export",
        scope: item.object,
        fileName: "-",
        format: "csv",
        rowCount: 0,
        result: item.result || "成功",
        ip: item.ip || "10.10.2.88",
        requestId: "-"
      })),
    iam: {
      ...initialIam,
      ...accountLibrary
    },
    systemReadiness: {
      closurePlan: [],
      controls: [
        { id: "local-demo", label: "商业后端连接", ok: false, status: "未连接", detail: "当前使用本地演示数据，不能作为发布证据" }
      ],
      dependencies: { database: "unverified", databaseIntegrity: "unverified", fileStorage: "unverified", ok: false, service: "local-demo" },
      generatedAt: new Date().toISOString(),
      knownGapSourceAvailable: false,
      knownGaps: [],
      ownerEvidenceChecklist: [],
      releaseGate: {
        blockers: ["当前为本地演示模式，未连接商业后端"],
        openGapCount: 0,
        releaseReady: false,
        warnings: []
      },
      gapActionReport: {
        available: false,
        blockedGapCount: 0,
        generatedAt: null,
        ownerCount: 0,
        owners: [],
        releaseEvidence: false,
        releaseReady: false,
        status: "missing",
        warningCheckCount: 0
      },
      latestEvidence: {
        artifactSummary: {
          available: false,
          itemCount: 0,
          items: [],
          migrationCount: 0,
          missingFileCount: 0,
          missingReleaseArtifactCount: 0,
          presentFileCount: 0,
          releaseRequiredCount: 0,
          trackedFileCount: 0
        },
        available: false,
        checkCount: 0,
        checks: [],
        e2eIncluded: false,
        evidenceMode: "missing",
        generatedAt: null,
        openGapCount: 0,
        releaseBlockerCount: 0,
        releaseCandidateReady: false,
        releaseEvidence: false,
        requiredFailedCount: 0,
        status: "missing",
        targetProfile: {
          database: { configured: false, target: "unconfigured" },
          e2eIncluded: false,
          evidenceClass: "missing",
          productionEvidenceReady: false,
          productionRuntime: false,
          signoffChecks: {},
          viteDemoFallback: "unset",
          viteRequireApi: "unset",
          warningCount: 0
        },
        warningCheckCount: 0
      },
      runtime: {
        environment: "local-demo",
        isProduction: false,
        service: "local-demo"
      },
      hrDataReview: {
        available: false,
        counts: {},
        generatedAt: null,
        nextCommandCount: 0,
        noSensitiveFields: false,
        releaseEvidence: false,
        rowCount: 0,
        status: "missing"
      },
      signoffDrafts: {
        available: false,
        draftCount: 0,
        generatedAt: null,
        handoffItemCount: 0,
        kinds: [],
        nextCommandCount: 0,
        openExceptionCount: 0,
        pendingApprovalCount: 0,
        relatedGapIds: [],
        releaseEvidence: false,
        requiredActionCount: 0,
        signoffReadinessStatus: "missing",
        status: "missing"
      }
    },
    revealSensitive: false
  };
}

function templateFor(item) {
  return flowTemplates.find((template) => template.id === item.definitionId || template.id === item.id || template.id === item.templateId) || flowTemplates[0];
}

function findApprovalRule(rules, department, templateId) {
  const activeRules = rules.filter((rule) => rule.enabled !== false);
  return activeRules.find((rule) => rule.department === department && rule.templateId === templateId)
    || activeRules.find((rule) => rule.templateId === templateId)
    || null;
}

function buildApprovalNodes(rule, template) {
  const ruleNodes = rule?.nodes?.length ? rule.nodes : (template.nodes || [])
    .filter((node) => !node.includes("申请人提交") && !node.includes("归档"))
    .map((node, index) => ({
      id: `${template.id}-${index + 1}`,
      name: node,
      mode: "AND",
      approvers: index === 0 ? [`${template.department}负责人`, "张三"] : [template.node]
    }));
  return ruleNodes.map((node, index) => ({
    id: node.id || `${template.id}-${index + 1}`,
    name: node.name || `审批节点 ${index + 1}`,
    mode: "AND",
    approvers: (node.approvers || []).filter(Boolean),
    decisions: (node.decisions?.length ? node.decisions : (node.approvers || []).filter(Boolean).map((approver) => ({
      approver,
      status: "待审批",
      time: "",
      comment: ""
    })))
  }));
}

function normalizeApprovals(approvals, approvalRules = []) {
  return approvals.map((approval, index) => {
    const template = templateFor(approval);
    const formData = approval.formData || formDefaults(template);
    const rule = findApprovalRule(approvalRules, approval.department || template.department, template.id);
    const approvalNodes = approval.approvalNodes?.length ? approval.approvalNodes : buildApprovalNodes(rule, template);
    const currentNodeIndex = Number.isFinite(approval.currentNodeIndex)
      ? Math.min(approval.currentNodeIndex, approvalNodes.length - 1)
      : 0;
    const currentNode = approvalNodes[currentNodeIndex];
    return {
      ...template,
      ...approval,
      id: approval.id || `FLOW-${index + 1}`,
      definitionId: approval.definitionId || template.id,
      definitionCode: approval.definitionCode || template.serviceKey,
      formData,
      amount: approval.amount || fieldValueLabel(template, formData),
      steps: approval.steps?.length ? approval.steps : ["申请人提交", ...approvalNodes.map((node) => node.name), "归档与通知"],
      approvalNodes,
      currentNodeIndex,
      node: approval.node || currentNode?.name || template.node,
      dueAt: approval.dueAt || approval.submittedAt,
      approvers: currentNode?.approvers || approval.approvers || [],
      comments: approval.comments || [],
      timeline: approval.timeline?.length ? approval.timeline : [
        { id: `TL-${approval.id || index}-1`, time: approval.submittedAt || stamp(), actor: approval.applicant || template.owner, action: "提交申请", node: "申请人提交" },
        { id: `TL-${approval.id || index}-2`, time: stamp(), actor: "系统", action: "创建审批任务", node: template.nodes?.[currentNodeIndex] || template.node }
      ]
    };
  });
}

function addTimeline(approval, payload) {
  return {
    ...approval,
    timeline: [
      { id: `TL-${Date.now()}`, time: stamp(), actor: "张三", ...payload },
      ...(approval.timeline || [])
    ]
  };
}

function ruleSnapshot(current, template, department) {
  const rule = findApprovalRule(current.approvalRules, department, template.id);
  return {
    rule,
    nodes: buildApprovalNodes(rule, template)
  };
}

function localApprovalRulePreview(rules, { department, templateId, definitionId } = {}) {
  const template = flowTemplates.find((item) => item.id === (templateId || definitionId)) || flowTemplates[0];
  const targetDepartment = department || template.department || "行政部";
  const rule = findApprovalRule(rules, targetDepartment, template.id);
  const nodes = buildApprovalNodes(rule, template).map((node, index) => ({
    id: node.id,
    name: node.name,
    mode: "AND",
    stepOrder: index + 1,
    approvers: node.approvers,
    approverCount: node.approvers.length
  }));
  return {
    preview: {
      department: targetDepartment,
      definitionCode: template.serviceKey,
      templateId: template.id,
      templateName: rule?.templateName || template.name,
      source: rule ? "department_rule" : "workflow_definition",
      ruleId: rule?.id || null,
      enabled: Boolean(rule),
      nodeCount: nodes.length,
      approverChain: nodes.map((node) => `${node.name}(${node.approvers.join("、")})`).join(" -> "),
      nodes
    }
  };
}

function nextOpenNodeIndex(nodes, currentIndex) {
  for (let index = currentIndex + 1; index < nodes.length; index += 1) {
    if (nodes[index].decisions.some((item) => item.status === "待审批")) return index;
  }
  return nodes.length;
}

function addAssetEvent(state, payload) {
  return {
    ...state,
    assetEvents: [
      { id: `AE-${Date.now()}`, time: stamp(), operator: "张三", ...payload },
      ...(state.assetEvents || [])
    ]
  };
}

function addAuditLog(state, payload) {
  const time = stamp();
  const auditLog = {
    id: `AUD-${Date.now()}`,
    time,
    operator: "张三",
    result: "成功",
    ip: "10.10.2.88",
    ...payload
  };
  const exportRecord = auditLog.type === "导出"
    ? {
      id: `EXP-${Date.now()}`,
      time,
      operator: auditLog.operator,
      module: payload.module || payload.object || "local",
      action: payload.action || "local.export",
      scope: payload.scope || payload.object || "本地导出",
      businessReason: payload.businessReason || `本地演示导出${payload.scope || payload.object || "数据"}`,
      fileName: payload.fileName || "-",
      format: payload.format || "csv",
      rowCount: Number(payload.rowCount || 0),
      result: auditLog.result,
      ip: auditLog.ip,
      requestId: "-"
    }
    : null;
  const auditLogs = [
    auditLog,
    ...state.auditLogs
  ];
  return {
    ...state,
    auditLogs,
    auditIntegrity: localAuditIntegrity(auditLogs),
    exportRecords: exportRecord ? [exportRecord, ...(state.exportRecords || [])] : (state.exportRecords || [])
  };
}

function normalizePayrollDraft(payload = {}) {
  return {
    batchNo: String(payload.batchNo || payload.id || "").trim(),
    cycle: String(payload.cycle || "").trim(),
    scope: String(payload.scope || "").trim(),
    owner: String(payload.owner || "财务中心").trim() || "财务中心",
    department: String(payload.department || "财务中心").trim() || "财务中心",
    headcount: Number.parseInt(String(payload.headcount || "0"), 10),
    totalAmount: Number.parseFloat(String(payload.totalAmount || payload.amount || "0")),
    comment: String(payload.comment || "").trim()
  };
}

function normalizeFinanceRequestDraft(payload = {}) {
  const rawType = String(payload.type || payload.requestType || "EXPENSE").trim().toUpperCase();
  const requestType = rawType === "PAYMENT" || rawType === "付款" || rawType === "付款申请" ? "PAYMENT" : "EXPENSE";
  return {
    requestNo: String(payload.requestNo || payload.id || `${requestType === "PAYMENT" ? "PAY" : "EXP"}-${Date.now()}`).trim(),
    requestType,
    title: String(payload.title || (requestType === "PAYMENT" ? "付款申请" : "费用报销")).trim(),
    department: String(payload.department || "财务中心").trim() || "财务中心",
    amount: Number.parseFloat(String(payload.amount || "0")),
    vendor: String(payload.vendor || payload.payee || "").trim(),
    paymentMethod: String(payload.paymentMethod || "").trim(),
    purpose: String(payload.purpose || payload.reason || payload.comment || "").trim(),
    expenseType: String(payload.expenseType || payload.category || "").trim()
  };
}

function countBy(rows, key) {
  return rows.reduce((acc, row) => {
    const value = row[key] || "未填写";
    acc[value] = (acc[value] || 0) + 1;
    return acc;
  }, {});
}

function topCounts(rows, key, limit = 8) {
  return Object.entries(countBy(rows, key))
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([label, value]) => ({ label, value }));
}

function localStatusLabel(value, fallback = "在职") {
  return {
    ACTIVE: "在职",
    LEAVED: "离职",
    SUSPENDED: "停用",
    在职: "在职",
    离职: "离职",
    停用: "停用"
  }[value] || fallback;
}

function rebuildPeople(people, updatedEmployee) {
  const rows = [
    ...(people.employees || []),
    ...(people.inactiveEmployees || []),
    ...(people.leavers || [])
  ].map((row) => (
    row.id === updatedEmployee.id ? { ...row, ...updatedEmployee } : row
  ));
  const employees = rows.filter((row) => row.status === "在职");
  const inactiveEmployees = rows.filter((row) => row.status === "停用");
  const leavers = rows.filter((row) => row.status === "离职");
  return {
    ...people,
    employees,
    inactiveEmployees,
    leavers,
    femaleEmployees: employees.filter((row) => row.gender === "女"),
    monthLeavers: leavers.filter((row) => String(row.leaveDate || "").startsWith("2026-05")),
    orgStats: topCounts(employees, "org"),
    departmentStats: topCounts(employees, "department"),
    leaverDepartmentStats: topCounts(leavers, "department")
  };
}

function importRecordCounts(people) {
  return {
    activeEmployees: people.employees.length,
    femaleEmployees: people.femaleEmployees.length,
    leavers: people.leavers.length,
    monthLeavers: people.monthLeavers.length,
    totalRows: people.employees.length + people.leavers.length
  };
}

export function useOaSystem() {
  const [state, setState] = useState(() => {
    const initialState = createInitialState();
    const storedState = readStoredState();
    if (!storedState) return initialState;
    return {
      ...initialState,
      ...storedState,
      approvalRules: storedState.approvalRules || initialState.approvalRules,
      approvals: normalizeApprovals(storedState.approvals || initialState.approvals, storedState.approvalRules || initialState.approvalRules),
      assetEvents: storedState.assetEvents || initialState.assetEvents,
      resourceWindowStart: storedState.resourceWindowStart || initialState.resourceWindowStart,
      resourceBookings: storedState.resourceBookings || initialState.resourceBookings,
      iam: storedState.iam || initialState.iam,
      exportRecords: storedState.exportRecords || initialState.exportRecords,
      people: storedState.people || initialState.people
    };
  });

  useEffect(() => {
    writeStoredState({
      approvals: state.approvals,
      approvalRules: state.approvalRules,
      assets: state.assets,
      assetEvents: state.assetEvents,
      resources: state.resources,
      resourceWindowStart: state.resourceWindowStart,
      resourceBookings: state.resourceBookings,
      people: state.people,
      leaves: state.leaves,
      financeRequests: state.financeRequests,
      payrolls: state.payrolls,
      files: state.files,
      importRuns: state.importRuns,
      iam: state.iam,
      auditLogs: state.auditLogs,
      exportRecords: state.exportRecords,
      revealSensitive: state.revealSensitive
    });
  }, [state]);

  const metrics = useMemo(() => {
    const employees = state.people.employees.length;
    const leavers = state.people.leavers.length;
    const femaleEmployees = state.people.femaleEmployees.length || state.people.employees.filter((item) => item.gender === "女").length;
    const monthLeavers = state.people.monthLeavers.length;
    const pendingApprovals = state.approvals.filter((item) => item.status.includes("待") || item.status.includes("超时")).length;
    const activeAssets = state.assets.filter((item) => item.status.includes("用") || item.status.includes("借")).length;
    const resourceConflicts = state.resources.filter((item) => item.slots.some((slot) => slot >= item.total)).length;
    return {
      employees,
      leavers,
      femaleEmployees,
      monthLeavers,
      pendingApprovals,
      activeAssets,
      resourceConflicts,
      assetUseRate: Math.round((activeAssets / Math.max(state.assets.length, 1)) * 100),
      auditToday: state.auditLogs.length,
      totalPeople: employees + leavers
    };
  }, [state]);

  const actions = useMemo(() => ({
    createApproval(template, overrides = {}) {
      setState((current) => {
        const formData = { ...formDefaults(template), ...(overrides.formData || {}) };
        const amount = fieldValueLabel(template, formData);
        const department = overrides.department || template.department;
        const { rule, nodes } = ruleSnapshot(current, template, department);
        const currentNode = nodes[0];
        const approval = {
          ...template,
          ...overrides,
          id: `FLOW-${Date.now()}`,
          definitionId: template.id,
          definitionCode: template.serviceKey,
          ruleId: rule?.id || "",
          title: overrides.title || template.name,
          applicant: overrides.applicant || template.owner || "张三",
          department,
          amount,
          status: "待审批",
          formData,
          approvalNodes: nodes,
          currentNodeIndex: 0,
          submittedAt: stamp(),
          dueAt: stamp(),
          steps: ["申请人提交", ...nodes.map((node) => node.name), "归档与通知"],
          node: currentNode?.name || template.node,
          approvers: currentNode?.approvers || [],
          comments: [],
          timeline: [
            { id: `TL-${Date.now()}-1`, time: stamp(), actor: overrides.applicant || template.owner || "张三", action: "提交申请", node: "申请人提交" },
            { id: `TL-${Date.now()}-2`, time: stamp(), actor: "系统", action: "创建会签任务", node: currentNode?.name || template.node, content: `${(currentNode?.approvers || []).join("、")} 需全部同意` }
          ]
        };
        return addAuditLog(
          { ...current, approvals: [approval, ...current.approvals] },
          { type: "提交审批", object: approval.title, content: `发起${approval.title}流程` }
        );
      });
    },
    updateEmployee(id, payload = {}) {
      setState((current) => {
        const employee = [
          ...current.people.employees,
          ...(current.people.inactiveEmployees || []),
          ...current.people.leavers
        ].find((item) => item.id === id);
        if (!employee) return current;
        const nextStatus = localStatusLabel(payload.status, employee.status);
        const nextEmployee = {
          ...employee,
          department: payload.department ?? payload.departmentName ?? employee.department,
          role: payload.role ?? payload.roleTitle ?? employee.role,
          status: nextStatus,
          leaveDate: nextStatus === "离职" ? (payload.leaveDate || employee.leaveDate || new Date().toISOString().slice(0, 10)) : ""
        };
        return addAuditLog({
          ...current,
          people: rebuildPeople(current.people, nextEmployee)
        }, {
          type: "更新",
          object: "员工档案",
          content: `更新员工 ${employee.name} 档案`
        });
      });
    },
    importDashboardHtml(payload = {}) {
      const html = String(payload.html || "");
      if (!html.trim()) return;
      const sourceName = payload.sourceName || "oa-dashboard.html";
      const people = loadDashboardPeopleFromHtml(html);
      const recordCounts = importRecordCounts(people);
      if (recordCounts.totalRows === 0) return;
      setState((current) => addAuditLog({
        ...current,
        people,
        importRuns: [
          {
            id: `IMPORT-${Date.now()}`,
            sourceType: "html-dashboard",
            sourceName,
            sourceChecksum: "local-runtime-import",
            status: "SUCCESS",
            recordCounts,
            metadata: { runtimeImport: true, sourceArtifact: { downloadAvailable: false, fileName: sourceName, sizeBytes: html.length } },
            actor: { name: "张三" },
            startedAt: new Date().toISOString(),
            finishedAt: new Date().toISOString()
          },
          ...(current.importRuns || [])
        ]
      }, {
        type: "导入",
        object: "人员数据",
        content: `导入人员数据 ${sourceName}，共 ${recordCounts.totalRows} 行`
      }));
    },
    downloadImportSource(run) {
      setState((current) => addAuditLog(current, {
        type: "下载",
        object: "数据导入",
        content: `查看导入源文件 ${run?.sourceName || "oa-dashboard.html"}`
      }));
    },
    decideApproval(id, decision, approverName = "张三") {
      setState((current) => {
        const approval = current.approvals.find((item) => item.id === id);
        if (!approval) return current;
        const nodeIndex = approval.currentNodeIndex || 0;
        const currentNode = approval.approvalNodes?.[nodeIndex];
        if (!currentNode) return current;
        const nextNodes = (approval.approvalNodes || []).map((node, index) => {
          if (index !== nodeIndex || decision !== "pass") return node;
          let consumed = false;
          return {
            ...node,
            decisions: node.decisions.map((item) => {
              if (item.status === "已同意") return item;
              if (item.approver === approverName || !consumed) {
                consumed = true;
                return { ...item, status: "已同意", time: stamp(), comment: "同意" };
              }
              return item;
            })
          };
        });
        const allAgreed = decision === "pass"
          && nextNodes[nodeIndex].decisions.some((item) => item.status === "已同意")
          && !nextNodes[nodeIndex].decisions.some((item) => item.status === "待审批");
        const nextIndex = allAgreed ? nextOpenNodeIndex(nextNodes, nodeIndex) : nodeIndex;
        const isFinalPass = decision === "pass" && allAgreed && nextIndex >= nextNodes.length;
        const nextStatus = decision === "reject" ? "已驳回" : isFinalPass ? "已通过" : "待审批";
        const nextNode = nextNodes[nextIndex] || null;
        const pendingCount = nextNodes[nodeIndex].decisions.filter((item) => item.status !== "已同意").length;
        return addAuditLog(
          {
            ...current,
            approvals: current.approvals.map((item) => (
              item.id === id ? addTimeline({
                ...item,
                status: nextStatus,
                approvalNodes: nextNodes,
                currentNodeIndex: decision === "pass" && allAgreed ? Math.min(nextIndex, nextNodes.length - 1) : item.currentNodeIndex,
                node: decision === "pass" ? (nextNode?.name || "归档与通知") : item.node,
                approvers: nextNode?.approvers || []
              }, {
                action: decision === "pass" ? "同意审批" : "驳回审批",
                node: item.node,
                actor: approverName,
                content: decision === "pass"
                  ? allAgreed
                    ? "当前节点全部同意，自动进入下一流程"
                    : `${approverName} 已同意，当前节点还需 ${pendingCount} 人同意`
                  : "审批退回申请人补充材料"
              }) : item
            ))
          },
          { type: "审批", object: approval.title, content: decision === "pass" ? `${approverName} 同意审批` : "驳回审批并退回申请人" }
        );
      });
    },
    saveApprovalRule(rule) {
      const normalizedRule = {
        ...rule,
        id: rule.id || `RULE-${Date.now()}`,
        createdAt: rule.createdAt || stamp(),
        updatedAt: stamp(),
        nodes: (rule.nodes || []).map((node, index) => ({
          ...node,
          id: node.id || `${rule.templateId}-${index + 1}`,
          mode: "AND"
        }))
      };
      setState((current) => addAuditLog({
        ...current,
        approvalRules: current.approvalRules.some((item) => (
          item.id === normalizedRule.id
          || (item.department === normalizedRule.department && item.templateId === normalizedRule.templateId)
        ))
          ? current.approvalRules.map((item) => (
            item.id === normalizedRule.id
            || (item.department === normalizedRule.department && item.templateId === normalizedRule.templateId)
              ? { ...item, ...normalizedRule }
              : item
          ))
          : [normalizedRule, ...current.approvalRules]
      }, {
        type: "更新",
        object: "部门审批规则",
        content: `更新 ${normalizedRule.department} · ${normalizedRule.templateName} 审批人配置`
      }));
    },
    deleteApprovalRule(id) {
      setState((current) => {
        const rule = current.approvalRules.find((item) => item.id === id);
        if (!rule) return current;
        return addAuditLog({
          ...current,
          approvalRules: current.approvalRules.filter((item) => item.id !== id)
        }, {
          type: "删除",
          object: "部门审批规则",
          content: `删除 ${rule.department} · ${rule.templateName} 审批人配置`
        });
      });
    },
    previewApprovalRule(query) {
      return localApprovalRulePreview(state.approvalRules, query);
    },
    transferApproval(id, target = "财务负责人", sourceApproverName = "") {
      setState((current) => {
        const approval = current.approvals.find((item) => item.id === id);
        if (!approval) return current;
        const nodeIndex = approval.currentNodeIndex || 0;
        const currentNode = approval.approvalNodes?.[nodeIndex];
        const sourceDecision = sourceApproverName
          ? currentNode?.decisions.find((item) => item.approver === sourceApproverName && item.status === "待审批")
          : currentNode?.decisions.find((item) => item.status === "待审批");
        const normalizedTarget = String(target || "财务负责人").trim();
        if (!currentNode || !sourceDecision || !normalizedTarget) return current;
        const nextNodes = approval.approvalNodes.map((node, index) => {
          if (index !== nodeIndex) return node;
          const hasTarget = node.decisions.some((item) => item.approver === normalizedTarget && item.status === "待审批");
          return {
            ...node,
            approvers: [...new Set([...node.approvers, normalizedTarget])],
            decisions: [
              ...node.decisions.map((item) => (
                item.approver === sourceDecision.approver && item.status === "待审批"
                  ? { ...item, status: "已转交", time: stamp(), comment: `转交给 ${normalizedTarget}` }
                  : item
              )),
              ...(hasTarget ? [] : [{ approver: normalizedTarget, status: "待审批", time: "", comment: `由 ${sourceDecision.approver} 转交` }])
            ]
          };
        });
        return addAuditLog(
          {
            ...current,
            approvals: current.approvals.map((item) => (
              item.id === id ? addTimeline({
                ...item,
                status: "待审批",
                approvalNodes: nextNodes,
                approvers: nextNodes[nodeIndex]?.decisions
                  .filter((decision) => decision.status === "待审批")
                  .map((decision) => decision.approver) || []
              }, {
                actor: "张三",
                action: "转交审批",
                node: item.node,
                content: `${sourceDecision.approver} 转交给 ${normalizedTarget}`
              }) : item
            ))
          },
          { type: "审批", object: approval.title, content: `审批任务由 ${sourceDecision.approver} 转交给 ${normalizedTarget}` }
        );
      });
    },
    withdrawApproval(id) {
      setState((current) => {
        const approval = current.approvals.find((item) => item.id === id);
        if (!approval) return current;
        return addAuditLog(
          {
            ...current,
            approvals: current.approvals.map((item) => (
              item.id === id ? addTimeline({ ...item, status: "已撤回", node: "申请人撤回" }, {
                action: "撤回审批",
                node: item.node,
                content: "申请人撤回审批实例"
              }) : item
            ))
          },
          { type: "审批", object: approval.title, content: "撤回审批实例" }
        );
      });
    },
    addApprovalComment(id, content) {
      if (!content.trim()) return;
      setState((current) => {
        const approval = current.approvals.find((item) => item.id === id);
        if (!approval) return current;
        return addAuditLog({
          ...current,
          approvals: current.approvals.map((item) => (
            item.id === id ? addTimeline({
            ...item,
            comments: [
              { id: `CMT-${Date.now()}`, author: "张三", time: stamp(), content: content.trim() },
              ...(item.comments || [])
            ]
            }, {
              action: "添加评论",
              node: item.node,
              content: content.trim()
            }) : item
          ))
        }, { type: "评论", object: approval.title, content: content.trim() });
      });
    },
    updateRolePermissions(roleId, permissionCodes) {
      const normalizedCodes = [...new Set((permissionCodes || []).filter(Boolean))];
      setState((current) => addAuditLog({
        ...current,
        iam: {
          ...current.iam,
          roles: current.iam.roles.map((role) => (
            role.id === roleId
              ? {
                  ...role,
                  permissionCodes: normalizedCodes,
                  permissions: current.iam.permissions.filter((permission) => normalizedCodes.includes(permission.code))
                }
              : role
          ))
        }
      }, {
        type: "权限",
        object: "角色权限",
        content: `更新 ${current.iam.roles.find((role) => role.id === roleId)?.name || "角色"} 权限范围`
      }));
    },
    updateUserRoles(userId, roleCodes) {
      const normalizedCodes = [...new Set((roleCodes || []).filter(Boolean))];
      setState((current) => {
        const targetUser = current.iam.users.find((user) => user.id === userId);
        if (!targetUser || normalizedCodes.length === 0) return current;
        const roleByCode = new Map(current.iam.roles.map((role) => [role.code, role]));
        const nextUsers = current.iam.users.map((user) => (
          user.id === userId
            ? {
                ...user,
                roleCodes: normalizedCodes,
                roles: normalizedCodes.map((code) => roleByCode.get(code)).filter(Boolean).map((role) => ({
                  id: role.id,
                  code: role.code,
                  name: role.name
                }))
              }
            : user
        ));
        const nextRoles = current.iam.roles.map((role) => {
          const usersForRole = nextUsers.filter((user) => (user.roleCodes || []).includes(role.code));
          return {
            ...role,
            userCount: usersForRole.length,
            users: usersForRole.map((user) => ({ id: user.id, name: user.name, email: user.email }))
          };
        });
        return addAuditLog({
          ...current,
          iam: {
            ...current.iam,
            roles: nextRoles,
            users: nextUsers
          }
        }, {
          type: "权限",
          object: "账号角色",
          content: `更新 ${targetUser.name} 账号角色：${normalizedCodes.join("、")}`
        });
      });
    },
    updateUserStatus(userId, status) {
      const normalizedStatus = ["ACTIVE", "DISABLED"].includes(String(status || "").toUpperCase())
        ? String(status).toUpperCase()
        : "";
      if (!normalizedStatus) return;
      setState((current) => {
        const targetUser = current.iam.users.find((user) => user.id === userId);
        if (!targetUser) return current;
        return addAuditLog({
          ...current,
          iam: {
            ...current.iam,
            users: current.iam.users.map((user) => (
              user.id === userId ? { ...user, status: normalizedStatus } : user
            ))
          }
        }, {
          type: "权限",
          object: "账号状态",
          content: `更新 ${targetUser.name} 账号状态：${normalizedStatus === "DISABLED" ? "停用" : "启用"}`
        });
      });
    },
    createUserAccount(payload = {}) {
      const email = String(payload.email || "").trim().toLowerCase();
      const name = String(payload.name || "").trim();
      const roleCodes = Array.isArray(payload.roleCodes)
        ? [...new Set(payload.roleCodes.map((code) => String(code || "").trim()).filter(Boolean))]
        : [];
      const status = ["ACTIVE", "DISABLED"].includes(String(payload.status || "ACTIVE").toUpperCase())
        ? String(payload.status || "ACTIVE").toUpperCase()
        : "ACTIVE";
      if (!email || !name || !roleCodes.length) return { ok: false, error: new Error("账号姓名、邮箱和角色必填。") };
      const newUser = {
        email,
        employee: null,
        id: `local-user-${Date.now()}`,
        name,
        roleCodes,
        roles: [],
        status
      };
      setState((current) => {
        const roleByCode = new Map(current.iam.roles.map((role) => [role.code, role]));
        const user = {
          ...newUser,
          roles: roleCodes.map((code) => roleByCode.get(code)).filter(Boolean).map((role) => ({
            code: role.code,
            id: role.id,
            name: role.name
          }))
        };
        const nextUsers = [user, ...current.iam.users];
        const nextRoles = current.iam.roles.map((role) => {
          const usersForRole = nextUsers.filter((item) => (item.roleCodes || []).includes(role.code));
          return {
            ...role,
            userCount: usersForRole.length,
            users: usersForRole.map((item) => ({ email: item.email, id: item.id, name: item.name }))
          };
        });
        return addAuditLog({
          ...current,
          iam: {
            ...current.iam,
            roles: nextRoles,
            users: nextUsers
          }
        }, {
          type: "权限",
          object: "账号创建",
          content: `创建账号 ${name}，角色：${roleCodes.join("、")}，本地演示不保存明文密码`
        });
      });
      return { user: newUser };
    },
    syncEmployeeAccounts(payload = {}) {
      const roleCodes = Array.isArray(payload.roleCodes) && payload.roleCodes.length
        ? [...new Set(payload.roleCodes.map((code) => String(code || "").trim()).filter(Boolean))]
        : ["employee-self-service"];
      const emailDomain = String(payload.emailDomain || "oa.local").trim().replace(/^@+/, "") || "oa.local";
      const status = ["ACTIVE", "DISABLED"].includes(String(payload.status || "ACTIVE").toUpperCase())
        ? String(payload.status || "ACTIVE").toUpperCase()
        : "ACTIVE";
      let result = { createdCount: 0, skippedCount: 0, credentials: [] };
      setState((current) => {
        const currentLibrary = buildAccountLibrary(current.people, current.iam);
        const roleByCode = new Map(current.iam.roles.map((role) => [role.code, role]));
        const missingEmployees = (current.people.employees || [])
          .filter(isActiveEmployee)
          .filter((employee) => !currentLibrary.accounts.some((account) => (
            account.employeeId === (employee.id || `employee-${employee.employeeNo || employee.seq || employee.name}`)
            && account.accountId
          )));
        const existingEmails = new Set(current.iam.users.map((user) => user.email));
        const createdUsers = missingEmployees.map((employee, index) => {
          const employeeId = employee.id || `employee-${employee.employeeNo || employee.seq || employee.name}`;
          let email = employeeAccountEmail(employee, emailDomain);
          let suffix = 2;
          while (existingEmails.has(email)) {
            email = `${accountLocalPart(employee.employeeNo || employee.seq || employeeId)}-${suffix}@${emailDomain}`;
            suffix += 1;
          }
          existingEmails.add(email);
          const temporaryPassword = `LocalTmp9${String(Date.now()).slice(-6)}${String(index + 1).padStart(2, "0")}`;
          return {
            email,
            employee: {
              id: employeeId,
              employeeNo: employee.employeeNo || employee.seq || "-",
              name: employee.name,
              department: employee.department || "",
              roleTitle: employee.roleTitle || employee.role || ""
            },
            id: `local-employee-user-${employeeId}`,
            name: employee.name,
            roleCodes,
            roles: roleCodes.map((code) => roleByCode.get(code)).filter(Boolean).map((role) => ({
              code: role.code,
              id: role.id,
              name: role.name
            })),
            status,
            temporaryPassword
          };
        });
        const nextUsers = [...createdUsers.map(({ temporaryPassword, ...user }) => user), ...current.iam.users];
        const nextRoles = current.iam.roles.map((role) => {
          const usersForRole = nextUsers.filter((user) => (user.roleCodes || []).includes(role.code));
          return {
            ...role,
            userCount: usersForRole.length,
            users: usersForRole.map((user) => ({ email: user.email, id: user.id, name: user.name }))
          };
        });
        const nextIamBase = {
          ...current.iam,
          roles: nextRoles,
          users: nextUsers
        };
        const nextLibrary = buildAccountLibrary(current.people, nextIamBase);
        result = {
          accountStats: nextLibrary.accountStats,
          createdCount: createdUsers.length,
          credentials: createdUsers.map((user) => ({
            employeeId: user.employee.id,
            employeeNo: user.employee.employeeNo,
            name: user.name,
            email: user.email,
            temporaryPassword: user.temporaryPassword,
            roleCodes: [...roleCodes]
          })),
          skippedCount: currentLibrary.accounts.filter((account) => account.accountId).length
        };
        return addAuditLog({
          ...current,
          iam: {
            ...nextIamBase,
            ...nextLibrary
          }
        }, {
          type: "权限",
          object: "员工账号库",
          content: `批量生成员工账号 ${createdUsers.length} 个，本地演示只在本次结果显示临时密码`
        });
      });
      return result;
    },
    resetUserPassword(userId) {
      setState((current) => {
        const targetUser = current.iam.users.find((user) => user.id === userId);
        if (!targetUser) return current;
        return addAuditLog(current, {
          type: "权限",
          object: "账号密码",
          content: `重置账号 ${targetUser.name} 密码，本地演示不保存明文密码`
        });
      });
    },
    createAsset(entry) {
      setState((current) => {
        const asset = {
          id: nextAssetId(entry.category, current.assets),
          qrVersion: 1,
          status: "空闲",
          owner: "设备库",
          location: "设备库",
          ...entry
        };
        return addAuditLog(
          addAssetEvent({ ...current, assets: [asset, ...current.assets] }, {
            assetId: asset.id,
            type: "录入",
            content: `录入资产 ${asset.name}，二维码版本 V1`
          }),
          { type: "新增", object: "行政资产", content: `录入资产 ${asset.name} 并生成二维码` }
        );
      });
    },
    updateAsset(id, status, owner = "张三") {
      setState((current) => {
        const asset = current.assets.find((item) => item.id === id);
        if (!asset) return current;
        const location = status === "空闲" ? "集团总部 · 设备库" : status === "维修中" ? "IT维修区" : asset.location;
        return addAuditLog(
          addAssetEvent({
            ...current,
            assets: current.assets.map((item) => (
              item.id === id ? { ...item, status, owner: status === "空闲" ? "设备库" : owner, location } : item
            ))
          }, {
            assetId: id,
            type: status,
            content: `${asset.name} 状态变更为 ${status}`
          }),
          { type: "更新", object: "行政资产", content: `${asset.name} 状态变更为 ${status}` }
        );
      });
    },
    inventoryAsset(id, result = "正常") {
      setState((current) => {
        const asset = current.assets.find((item) => item.id === id);
        if (!asset) return current;
        return addAuditLog(
          addAssetEvent(current, {
            assetId: id,
            type: "盘点",
            content: `${asset.name} 盘点完成，结果：${result}`
          }),
          { type: "更新", object: "行政资产", content: `${asset.name} 盘点完成，结果：${result}` }
        );
      });
    },
    replaceQr(id) {
      setState((current) => {
        const asset = current.assets.find((item) => item.id === id);
        if (!asset) return current;
        return addAuditLog(
          addAssetEvent({
            ...current,
            assets: current.assets.map((item) => (item.id === id ? { ...item, qrVersion: item.qrVersion + 1 } : item))
          }, {
            assetId: id,
            type: "二维码",
            content: `重新生成二维码 V${asset.qrVersion + 1}`
          }),
          { type: "更新", object: "行政资产", content: `重新生成 ${asset.name} 二维码` }
        );
      });
    },
    reserveResource(name, dayIndex, payload = {}) {
      setState((current) => {
        const target = current.resources.find((item) => item.name === name);
        if (!target) return current;
        const requestedPeriod = payload.period || "09:00-10:00";
        const requestedDate = payload.bookingDate || payload.date || "";
        const resolvedDayIndex = requestedDate
          ? dayIndexForDate(requestedDate, current.resourceWindowStart)
          : Number(dayIndex || 0);
        const slotIndex = resolvedDayIndex >= 0 ? resolvedDayIndex : Number(dayIndex || 0);
        const conflict = (resolvedDayIndex >= 0 && target.slots[slotIndex] >= target.total) || current.resourceBookings.some((item) => (
          item.resourceName === name
          && (item.date ? item.date === requestedDate : item.dayIndex === slotIndex)
          && item.period === requestedPeriod
          && item.status === "已预约"
        ));
        if (conflict) {
          return addAuditLog(current, {
            type: "预约冲突",
            object: `${target.type}预约`,
            content: `${name} ${requestedDate ? `${requestedDate} ` : ""}${requestedPeriod} 已被占用`,
            result: "失败"
          });
        }
        const booking = {
          id: `BOOK-${Date.now()}`,
          resourceName: name,
          type: target.type,
          date: requestedDate,
          dayIndex: slotIndex,
          period: requestedPeriod,
          applicant: payload.applicant || "张三",
          purpose: payload.purpose || "内部协作",
          status: "已预约"
        };
        return addAuditLog(
          {
            ...current,
            resourceBookings: [booking, ...current.resourceBookings],
            resources: current.resources.map((item) => (
              item.name === name && resolvedDayIndex >= 0
                ? { ...item, slots: item.slots.map((slot, index) => (index === slotIndex ? slot + 1 : slot)) }
                : item
            ))
          },
          { type: "新增", object: `${target.type}预约`, content: `预约${name} ${booking.date ? `${booking.date} ` : ""}${booking.period}` }
        );
      });
    },
    cancelResourceBooking(id, reason = "用户取消预约") {
      setState((current) => {
        const booking = current.resourceBookings.find((item) => item.id === id);
        if (!booking) return current;
        if (booking.status === "已取消") {
          return addAuditLog(current, {
            type: "更新",
            object: `${booking.type}预约`,
            content: `重复取消${booking.resourceName} ${booking.period}，状态未变更`
          });
        }
        return addAuditLog(
          {
            ...current,
            resourceBookings: current.resourceBookings.map((item) => (
              item.id === id ? { ...item, status: "已取消", cancelReason: reason } : item
            )),
            resources: current.resources.map((item) => (
              item.name === booking.resourceName
                ? {
                  ...item,
                  slots: item.slots.map((slot, index) => {
                    const bookingDayIndex = booking.date ? dayIndexForDate(booking.date, current.resourceWindowStart) : booking.dayIndex;
                    return index === bookingDayIndex ? Math.max(0, slot - 1) : slot;
                  })
                }
                : item
            ))
          },
          { type: "更新", object: `${booking.type}预约`, content: `取消${booking.resourceName} ${booking.date ? `${booking.date} ` : ""}${booking.period}` }
        );
      });
    },
    exportResourceBookings(filters = {}) {
      const scope = filters.scope || "资源预约台账";
      setState((current) => addAuditLog(current, {
        action: "resource.booking.export",
        module: "resource",
        scope,
        businessReason: filters.businessReason || `导出${scope}用于行政资源核对`,
        rowCount: current.resourceBookings.length,
        type: "导出",
        object: "resource_booking",
        content: `导出${scope}，本地演示仅记录导出动作`
      }));
    },
    createAttendanceRecord(entry = {}) {
      setState((current) => {
        const record = {
          id: `ATT-${Date.now()}`,
          employee: entry.employee || entry.employeeName || "未填写",
          department: entry.department || "行政部",
          workDate: entry.workDate || entry.date || new Date().toISOString().slice(0, 10),
          checkIn: entry.checkIn || entry.checkInAt || "",
          checkOut: entry.checkOut || entry.checkOutAt || "",
          status: entry.status || "正常",
          minutesLate: Number(entry.minutesLate || 0),
          source: entry.source || "手动补录",
          reason: entry.reason || ""
        };
        return addAuditLog(
          { ...current, attendanceRecords: [record, ...(current.attendanceRecords || [])] },
          { type: "新增", object: "考勤记录", content: `录入${record.employee} ${record.workDate} 考勤记录` }
        );
      });
    },
    exportAttendanceRecords(filters = {}) {
      const scope = filters.scope || "考勤记录台账";
      const content = scope === "考勤记录台账"
        ? "导出考勤记录台账，本地演示仅记录导出动作"
        : `导出${scope}，本地演示仅记录导出动作`;
      setState((current) => addAuditLog(current, {
        action: "attendance.record.export",
        module: "attendance",
        scope,
        businessReason: filters.businessReason || `导出${scope}用于考勤核对`,
        rowCount: current.attendanceRecords.length,
        type: "导出",
        object: "attendance_record",
        content
      }));
    },
    createLeave(entry) {
      setState((current) => {
        const leave = { id: `LEAVE-${Date.now()}`, status: "待审批", ...entry };
        return addAuditLog(
          { ...current, leaves: [leave, ...current.leaves] },
          { type: "提交审批", object: "请假申请", content: `${leave.employee} 提交 ${leave.type}` }
        );
      });
    },
    createFinanceRequest(payload = {}) {
      const draft = normalizeFinanceRequestDraft(payload);
      let createdRequest = null;
      setState((current) => {
        if (!draft.requestNo || !draft.title || !Number.isFinite(draft.amount) || draft.amount <= 0) {
          return addAuditLog(current, {
            type: "新增",
            object: "财务单据",
            content: "财务单据创建失败：编号、标题和金额为必填",
            result: "失败"
          });
        }
        const existing = (current.financeRequests || []).find((item) => item.id === draft.requestNo);
        if (existing) {
          createdRequest = existing;
          return addAuditLog(current, {
            type: "新增",
            object: "财务单据",
            content: `${draft.requestNo} 财务单据编号已存在`,
            result: "失败"
          });
        }

        const templateId = draft.requestType === "PAYMENT" ? "payment" : "expense";
        const template = flowTemplates.find((item) => item.id === templateId) || flowTemplates[0];
        const formData = {
          ...formDefaults(template),
          requestNo: draft.requestNo,
          amount: String(draft.amount),
          department: draft.department,
          vendor: draft.vendor,
          paymentMethod: draft.paymentMethod,
          expenseType: draft.expenseType,
          purpose: draft.purpose
        };
        const { rule, nodes } = ruleSnapshot(current, template, draft.department);
        const currentNode = nodes[0];
        const workflowId = `FLOW-FIN-${Date.now()}`;
        const approval = {
          ...template,
          id: workflowId,
          definitionId: template.id,
          definitionCode: template.serviceKey,
          ruleId: rule?.id || "",
          title: draft.title,
          applicant: "张三",
          department: draft.department,
          amount: `¥${draft.amount.toLocaleString("zh-CN")}`,
          status: "待审批",
          formData,
          approvalNodes: nodes,
          currentNodeIndex: 0,
          submittedAt: stamp(),
          dueAt: stamp(),
          steps: ["申请人提交", ...nodes.map((node) => node.name), "归档与通知"],
          node: currentNode?.name || template.node,
          approvers: currentNode?.approvers || [],
          comments: [],
          timeline: [
            { id: `TL-${Date.now()}-1`, time: stamp(), actor: "张三", action: "提交申请", node: "申请人提交" },
            { id: `TL-${Date.now()}-2`, time: stamp(), actor: "系统", action: "创建财务审批任务", node: currentNode?.name || template.node, content: `${(currentNode?.approvers || []).join("、")} 需全部同意` }
          ]
        };
        createdRequest = {
          id: draft.requestNo,
          type: draft.requestType,
          typeLabel: draft.requestType === "PAYMENT" ? "付款申请" : "费用报销",
          title: draft.title,
          applicant: "张三",
          department: draft.department,
          amount: draft.amount,
          currency: "CNY",
          vendor: draft.vendor,
          paymentMethod: draft.paymentMethod,
          status: "待审批",
          workflowInstanceId: workflowId,
          workflowStatus: "PENDING"
        };
        return addAuditLog(addAuditLog({
          ...current,
          approvals: [approval, ...current.approvals],
          financeRequests: [createdRequest, ...(current.financeRequests || [])]
        }, {
          type: "提交审批",
          object: approval.title,
          content: `提交${createdRequest.typeLabel}审批流程`
        }), {
          type: "新增",
          object: "财务单据",
          content: `${createdRequest.id} ${createdRequest.typeLabel}创建并提交审批`
        });
      });
      return { financeRequest: createdRequest };
    },
    createPayroll(payload = {}) {
      const draft = normalizePayrollDraft(payload);
      let createdPayroll = null;
      setState((current) => {
        if (!draft.batchNo || !draft.cycle || !draft.scope || draft.headcount <= 0 || draft.totalAmount <= 0) {
          return addAuditLog(current, {
            type: "新增",
            object: "工资单",
            content: "工资单创建失败：批次、周期、人员范围、人数和金额为必填",
            result: "失败"
          });
        }
        const existing = current.payrolls.find((item) => item.id === draft.batchNo);
        if (existing) {
          createdPayroll = existing;
          return addAuditLog(current, {
            type: "新增",
            object: "工资单",
            content: `${draft.batchNo} 工资单批次已存在`,
            result: "失败"
          });
        }

        const template = flowTemplates.find((item) => item.id === "payroll") || flowTemplates[0];
        const formData = {
          ...formDefaults(template),
          batchNo: draft.batchNo,
          cycle: draft.cycle,
          scope: draft.scope,
          owner: draft.owner,
          department: draft.department,
          headcount: String(draft.headcount),
          totalAmount: String(draft.totalAmount),
          comment: draft.comment
        };
        const { rule, nodes } = ruleSnapshot(current, template, draft.department);
        const currentNode = nodes[0];
        const workflowId = `FLOW-PAYROLL-${Date.now()}`;
        const approval = {
          ...template,
          id: workflowId,
          definitionId: template.id,
          definitionCode: template.serviceKey,
          ruleId: rule?.id || "",
          title: `${draft.cycle}工资单复核`,
          applicant: "张三",
          department: draft.department,
          amount: `${draft.headcount}人 · ¥${draft.totalAmount.toLocaleString("zh-CN")}`,
          status: "待审批",
          formData,
          approvalNodes: nodes,
          currentNodeIndex: 0,
          submittedAt: stamp(),
          dueAt: stamp(),
          steps: ["申请人提交", ...nodes.map((node) => node.name), "归档与通知"],
          node: currentNode?.name || template.node,
          approvers: currentNode?.approvers || [],
          comments: [],
          timeline: [
            { id: `TL-${Date.now()}-1`, time: stamp(), actor: "张三", action: "提交申请", node: "申请人提交" },
            { id: `TL-${Date.now()}-2`, time: stamp(), actor: "系统", action: "创建工资单复核任务", node: currentNode?.name || template.node, content: `${(currentNode?.approvers || []).join("、")} 需全部同意` }
          ]
        };
        createdPayroll = {
          id: draft.batchNo,
          cycle: draft.cycle,
          scope: draft.scope,
          owner: draft.owner,
          status: "待复核",
          workflowInstanceId: workflowId,
          workflowStatus: "PENDING",
          headcount: draft.headcount,
          totalAmount: draft.totalAmount
        };
        return addAuditLog(addAuditLog({
          ...current,
          approvals: [approval, ...current.approvals],
          payrolls: [createdPayroll, ...current.payrolls]
        }, {
          type: "提交审批",
          object: approval.title,
          content: "提交工资单复核流程"
        }), {
          type: "新增",
          object: "工资单",
          content: `${createdPayroll.id} 工资单创建并提交复核`
        });
      });
      return { payroll: createdPayroll };
    },
    reviewPayroll(id) {
      setState((current) => {
        const payroll = current.payrolls.find((item) => item.id === id);
        if (!payroll) return current;
        if (!payroll.status.includes("待复核")) {
          return addAuditLog(current, {
            type: "审批",
            object: "工资单",
            content: `${id} 当前状态不允许发布`,
            result: "失败"
          });
        }
        const linkedApproval = payroll.workflowInstanceId
          ? current.approvals.find((item) => item.id === payroll.workflowInstanceId)
          : null;
        if (linkedApproval && linkedApproval.status !== "已通过") {
          return addAuditLog(current, {
            type: "审批",
            object: "工资单",
            content: `${id} 审批未全部通过，不能发布工资单`,
            result: "失败"
          });
        }
        return addAuditLog(
          {
            ...current,
            payrolls: current.payrolls.map((item) => (item.id === id ? { ...item, status: "已发布", workflowStatus: linkedApproval?.status || item.workflowStatus } : item))
          },
          { type: "审批", object: "工资单", content: `${id} 工资单复核发布` }
        );
      });
    },
    async uploadFile(file, options = {}) {
      if (!file) return;
      const contentDataUrl = await fileToDataUrl(file);
      setState((current) => {
        const record = {
          id: `FILE-${Date.now()}`,
          checksum: "local-demo",
          contentDataUrl,
          createdAt: new Date().toISOString(),
          fileName: file.name || "attachment.bin",
          mimeType: file.type || "application/octet-stream",
          sizeBytes: file.size || 0,
          uploader: { name: "张三" },
          visibility: options.visibility || "PRIVATE"
        };
        return addAuditLog(
          { ...current, files: [record, ...(current.files || [])] },
          { type: "新增", object: "文件附件", content: `上传附件 ${record.fileName}` }
        );
      });
    },
    downloadFile(file) {
      downloadLocalFile(file);
      setState((current) => addAuditLog(current, {
        type: "下载",
        object: "文件附件",
        content: `下载附件 ${file?.fileName || "附件"}`
      }));
    },
    toggleSensitive() {
      setState((current) => addAuditLog(
        { ...current, revealSensitive: !current.revealSensitive },
        { type: "更新", object: "权限审计", content: current.revealSensitive ? "关闭敏感字段查看" : "开启敏感字段查看" }
      ));
    },
    exportAudit(scope = "审计日志") {
      setState((current) => addAuditLog(current, {
        action: "audit.export",
        module: "audit",
        scope,
        businessReason: `导出${scope}用于审计复核`,
        rowCount: current.auditLogs.length,
        type: "导出",
        object: scope,
        content: `导出${scope}，自动记录导出人和时间`
      }));
    },
    exportPeople(filters = {}) {
      const scope = filters.scope || "人员名册";
      setState((current) => addAuditLog(current, {
        action: "employee.export",
        module: "people",
        scope,
        businessReason: filters.businessReason || `导出${scope}用于人事核对`,
        rowCount: current.people.employees.length + current.people.leavers.length,
        type: "导出",
        object: "employee",
        content: `导出${scope}，本地演示仅记录导出动作`
      }));
    },
    exportApprovals(filters = {}) {
      const scope = filters.scope || "审批列表";
      setState((current) => addAuditLog(current, {
        action: "workflow.export",
        module: "workflow",
        scope,
        businessReason: filters.businessReason || `导出${scope}用于流程复核`,
        rowCount: current.approvals.length,
        type: "导出",
        object: "workflow",
        content: `导出${scope}，本地演示仅记录导出动作`
      }));
    },
    exportAssets(filters = {}) {
      const scope = filters.scope || "资产台账";
      setState((current) => addAuditLog(current, {
        action: "asset.export",
        module: "asset",
        scope,
        businessReason: filters.businessReason || `导出${scope}用于资产盘点`,
        rowCount: current.assets.length,
        type: "导出",
        object: "asset",
        content: `导出${scope}，本地演示仅记录导出动作`
      }));
    },
    exportFinanceRequests(filters = {}) {
      const scope = filters.scope || "财务单据台账";
      setState((current) => addAuditLog(current, {
        action: "finance.request.export",
        module: "finance",
        scope,
        businessReason: filters.businessReason || `导出${scope}用于财务复核`,
        rowCount: current.financeRequests.length,
        type: "导出",
        object: "finance_request",
        content: `导出${scope}，本地演示仅记录导出动作`
      }));
    },
    exportAnalyticsSnapshot(filters = {}) {
      const scope = filters.scope || "管理看板快照";
      setState((current) => addAuditLog(current, {
        action: "analytics.export",
        module: "analytics",
        scope,
        businessReason: filters.businessReason || `导出${scope}用于管理复盘`,
        rowCount: 1,
        type: "导出",
        object: "analytics_snapshot",
        content: `导出${scope}，本地演示仅记录导出动作`
      }));
    },
    reset() {
      clearStoredState();
      setState(createInitialState());
    }
  }), [state.approvalRules]);

  return { state, metrics, actions };
}
