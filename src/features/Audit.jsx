import React, { useMemo, useRef, useState } from "react";
import { DataTable, MetricCard, Panel, StatusPill } from "../components/Primitives.jsx";

const moduleLabels = {
  analytics: "管理看板",
  asset: "行政资产",
  attendance: "假勤",
  audit: "权限审计",
  file: "文件附件",
  finance: "财务行政",
  iam: "角色权限",
  import: "数据导入",
  people: "组织人事",
  resource: "资源预约",
  system: "系统管理",
  workflow: "OA审批"
};

function rolePermissionCodes(role) {
  return role?.permissionCodes || (role?.permissions || []).map((permission) => permission.code);
}

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function visibilityLabel(value) {
  return {
    PRIVATE: "仅本人",
    PUBLIC: "公开",
    TENANT: "租户内"
  }[value] || value || "仅本人";
}

function fileCreatedAt(file) {
  if (!file.createdAt) return "-";
  return String(file.createdAt).replace("T", " ").slice(0, 19);
}

function userStatusLabel(status) {
  if (status === "UNASSIGNED") return "未开户";
  if (status === "FIRST_LOGIN_REQUIRED") return "待首次设置";
  return status === "DISABLED" ? "已停用" : "启用";
}

function isActiveEmployeeStatus(status) {
  return ["ACTIVE", "在职"].includes(String(status || "ACTIVE"));
}

function fallbackAccountLibrary(people = {}, iam = {}) {
  const users = iam.users || [];
  const byEmployeeId = new Map(users.filter((user) => user.employee?.id).map((user) => [user.employee.id, user]));
  const accounts = (people.employees || []).map((employee) => {
    const employeeId = employee.id || `employee-${employee.employeeNo || employee.seq || employee.name}`;
    const user = byEmployeeId.get(employeeId) || null;
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
      accountMustChangePassword: Boolean(user?.mustChangePassword),
      accountStatus: user?.status || "UNASSIGNED",
      roleCodes: user?.roleCodes || user?.roles?.map((role) => role.code).filter(Boolean) || [],
      roleNames: user?.roles?.map((role) => role.name).filter(Boolean) || []
    };
  });
  const activeAccounts = accounts.filter((item) => isActiveEmployeeStatus(item.employeeStatus));
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

function readinessTime(value) {
  if (!value) return "-";
  return String(value).replace("T", " ").slice(0, 19);
}

function dependencyLabel(value) {
  return value === "ok" ? "已通过" : value === "unverified" ? "未连接" : "不可用";
}

function controlStatus(row) {
  return row.ok ? "已通过" : "已阻断";
}

function evidenceStatus(value) {
  return value === "pass" ? "已通过" : value === "missing" ? "缺失" : "未通过";
}

function evidenceTargetLabel(value) {
  return {
    "local-postgresql": "本地 PostgreSQL",
    "non-local-postgresql": "非本地 PostgreSQL",
    unconfigured: "未配置"
  }[value] || value || "未配置";
}

function shortHash(value) {
  return value ? `${String(value).slice(0, 12)}...` : "-";
}

function auditIntegrityStatus(auditIntegrity) {
  const summary = auditIntegrity.summary || {};
  const signedRows = Number(summary.signedRows || 0);
  const unsignedRows = Number(summary.unsignedRows || 0);
  const hasHash = Boolean(summary.lastHash);
  const warningCount = auditIntegrity.warnings?.length || 0;

  if (!signedRows || !hasHash) return { label: "未连接", pill: "本地未签名", tone: "red" };
  if (!auditIntegrity.ok) return { label: "阻断", pill: "哈希链阻断", tone: "red" };
  if (unsignedRows > 0 || warningCount > 0) return { label: "需复核", pill: "哈希链需复核", tone: "orange" };
  return { label: "完整", pill: "哈希链通过", tone: "green" };
}

export function Audit({ actions, state }) {
  const iam = state.iam || { permissions: [], roles: [], users: [] };
  const roles = iam.roles || [];
  const permissions = iam.permissions || [];
  const accountLibrary = useMemo(() => {
    if (Array.isArray(iam.accounts) && iam.accounts.length) {
      return {
        accounts: iam.accounts,
        accountStats: iam.accountStats || fallbackAccountLibrary(state.people, iam).accountStats
      };
    }
    return fallbackAccountLibrary(state.people, iam);
  }, [iam, state.people]);
  const accountRows = accountLibrary.accounts || [];
  const accountStats = accountLibrary.accountStats || {};
  const files = state.files || [];
  const exportRecords = state.exportRecords || [];
  const auditIntegrity = state.auditIntegrity || {
    ok: false,
    errors: [],
    warnings: ["未加载审计完整性校验"],
    summary: {}
  };
  const systemReadiness = state.systemReadiness || {};
  const releaseGate = systemReadiness.releaseGate || { blockers: [], openGapCount: 0, releaseReady: false, warnings: [] };
  const dependencies = systemReadiness.dependencies || {};
  const knownGaps = systemReadiness.knownGaps || [];
  const closurePlan = systemReadiness.closurePlan || [];
  const ownerEvidenceChecklist = systemReadiness.ownerEvidenceChecklist || [];
  const signoffDrafts = systemReadiness.signoffDrafts || {
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
  };
  const hrDataReview = systemReadiness.hrDataReview || {
    available: false,
    counts: {},
    generatedAt: null,
    nextCommandCount: 0,
    noSensitiveFields: false,
    releaseEvidence: false,
    rowCount: 0,
    status: "missing"
  };
  const gapActionReport = systemReadiness.gapActionReport || {
    available: false,
    blockedGapCount: 0,
    generatedAt: null,
    ownerCount: 0,
    owners: [],
    releaseEvidence: false,
    releaseReady: false,
    status: "missing",
    warningCheckCount: 0
  };
  const latestEvidence = systemReadiness.latestEvidence || {
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
  };
  const artifactSummary = latestEvidence.artifactSummary || {
    available: false,
    itemCount: 0,
    items: [],
    migrationCount: 0,
    missingReleaseArtifactCount: 0,
    presentFileCount: 0,
    releaseRequiredCount: 0,
    trackedFileCount: 0
  };
  const [selectedRoleId, setSelectedRoleId] = useState(roles[0]?.id || "");
  const [selectedUserId, setSelectedUserId] = useState(iam.users?.[0]?.id || "");
  const [selectedFile, setSelectedFile] = useState(null);
  const [accountDraft, setAccountDraft] = useState({
    email: "new.user@oa.local",
    mustChangePassword: true,
    name: "新账号",
    newPassword: "NewUserPass123",
    roleCodes: ["auditor"],
    status: "ACTIVE"
  });
  const [accountMessage, setAccountMessage] = useState("");
  const [syncCredentials, setSyncCredentials] = useState([]);
  const [activationResults, setActivationResults] = useState([]);
  const [syncMessage, setSyncMessage] = useState("");
  const [syncRoleCodes, setSyncRoleCodes] = useState(["employee-self-service"]);
  const [passwordDraft, setPasswordDraft] = useState("");
  const [passwordMessage, setPasswordMessage] = useState("");
  const [iamBusyKey, setIamBusyKey] = useState("");
  const [iamMessage, setIamMessage] = useState("");
  const [visibility, setVisibility] = useState("PRIVATE");
  const [attachmentMessage, setAttachmentMessage] = useState("");
  const fileInputRef = useRef(null);
  const selectedRole = roles.find((role) => role.id === selectedRoleId) || roles[0] || null;
  const selectedUser = (iam.users || []).find((user) => user.id === selectedUserId) || iam.users?.[0] || null;
  const selectedPermissionCodes = new Set(rolePermissionCodes(selectedRole));
  const selectedUserRoleCodes = new Set(selectedUser?.roleCodes || selectedUser?.roles?.map((role) => role.code) || []);
  const auditIntegritySummary = auditIntegrity.summary || {};
  const auditIntegrityView = auditIntegrityStatus(auditIntegrity);
  const groupedPermissions = useMemo(() => permissions.reduce((groups, permission) => {
    const key = permission.module || "other";
    return {
      ...groups,
      [key]: [...(groups[key] || []), permission]
    };
  }, {}), [permissions]);
  const exportCount = exportRecords.length || state.auditLogs.filter((item) => item.type === "导出" || item.content.includes("导出")).length;
  const attachmentCount = files.length;
  const runIamChange = async (busyKey, successMessage, change) => {
    setIamBusyKey(busyKey);
    setIamMessage("正在保存权限变更...");
    try {
      const result = await change();
      if (result?.ok === false) {
        setIamMessage(result.error?.message || "权限变更失败。");
        return;
      }
      setIamMessage(successMessage);
    } catch (error) {
      setIamMessage(error?.message || "权限变更失败。");
    } finally {
      setIamBusyKey("");
    }
  };
  const togglePermission = (permissionCode, enabled) => {
    if (!selectedRole) return;
    const nextCodes = new Set(selectedPermissionCodes);
    if (enabled) {
      nextCodes.add(permissionCode);
    } else {
      nextCodes.delete(permissionCode);
    }
    void runIamChange(
      `role-permission:${selectedRole.id}:${permissionCode}`,
      `已更新 ${selectedRole.name} 的权限。`,
      () => actions.updateRolePermissions(selectedRole.id, [...nextCodes])
    );
  };
  const toggleUserRole = (roleCode, enabled) => {
    if (!selectedUser) return;
    const nextCodes = new Set(selectedUserRoleCodes);
    if (enabled) {
      nextCodes.add(roleCode);
    } else {
      nextCodes.delete(roleCode);
    }
    void runIamChange(
      `user-role:${selectedUser.id}:${roleCode}`,
      `已更新 ${selectedUser.name} 的角色。`,
      () => actions.updateUserRoles(selectedUser.id, [...nextCodes])
    );
  };
  const toggleAccountRole = (roleCode, enabled) => {
    const nextCodes = new Set(accountDraft.roleCodes);
    if (enabled) {
      nextCodes.add(roleCode);
    } else {
      nextCodes.delete(roleCode);
    }
    setAccountDraft({ ...accountDraft, roleCodes: [...nextCodes] });
  };
  const toggleSyncRole = (roleCode, enabled) => {
    const nextCodes = new Set(syncRoleCodes);
    if (enabled) {
      nextCodes.add(roleCode);
    } else {
      nextCodes.delete(roleCode);
    }
    setSyncRoleCodes([...nextCodes]);
  };
  const submitAttachment = async (event) => {
    event.preventDefault();
    if (!selectedFile) return;
    setAttachmentMessage("正在上传附件...");
    const result = await actions.uploadFile(selectedFile, { visibility });
    if (result?.ok === false) {
      setAttachmentMessage(result.error?.message || "附件上传失败。");
      return;
    }
    setSelectedFile(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
    setAttachmentMessage("附件已上传，并写入访问审计。");
  };
  const submitAccountCreate = async (event) => {
    event.preventDefault();
    setAccountMessage("");
    const result = await actions.createUserAccount(accountDraft);
    if (result?.ok === false) {
      setAccountMessage(result.error?.message || "账号创建失败");
      return;
    }
    if (result?.user?.id) setSelectedUserId(result.user.id);
    setAccountDraft({
      ...accountDraft,
      email: "",
      name: "",
      newPassword: ""
    });
    setAccountMessage("账号已创建，临时密码不会写入审计日志。");
  };
  const submitPasswordReset = async () => {
    if (!selectedUser || !passwordDraft) return;
    setPasswordMessage("");
    const result = await actions.resetUserPassword(selectedUser.id, passwordDraft);
    if (result?.ok === false) {
      setPasswordMessage(result.error?.message || "密码重置失败");
      return;
    }
    setPasswordDraft("");
    setPasswordMessage("已重置密码，审计日志不会记录明文密码。");
  };
  const syncEmployeeAccounts = async () => {
    setSyncMessage("");
    setSyncCredentials([]);
    const result = await actions.syncEmployeeAccounts({
      emailDomain: "oa.local",
      roleCodes: syncRoleCodes,
      status: "ACTIVE"
    });
    if (result?.ok === false) {
      setSyncMessage(result.error?.message || "员工账号生成失败");
      return;
    }
    setSyncCredentials(result?.credentials || []);
    setSyncMessage(`已生成 ${result?.createdCount || 0} 个账号，跳过 ${result?.skippedCount || 0} 个已有账号。`);
  };

  const generateActivationCode = async (row) => {
    setSyncMessage("");
    if (!actions.createAccountActivation) {
      setSyncMessage("当前运行模式不支持员工自助激活码。");
      return;
    }
    const result = await actions.createAccountActivation({
      employeeId: row.employeeId,
      roleCodes: syncRoleCodes.length ? syncRoleCodes : ["employee-self-service"]
    });
    if (result?.ok === false) {
      setSyncMessage(result.error?.message || "激活码生成失败。");
      return;
    }
    if (result?.activation) {
      setActivationResults((current) => [result.activation, ...current].slice(0, 20));
      setSyncMessage(`已为 ${row.employeeName} 生成一次性激活码。`);
    }
  };

  const columns = [
    { key: "time", label: "操作时间" },
    { key: "operator", label: "操作人" },
    { key: "type", label: "类型" },
    { key: "object", label: "对象" },
    { key: "content", label: "操作内容" },
    { key: "result", label: "结果", render: (row) => <StatusPill value={row.result} /> },
    { key: "ip", label: "IP地址" }
  ];
  const fileColumns = [
    { key: "fileName", label: "文件名" },
    { key: "mimeType", label: "类型" },
    { key: "sizeBytes", label: "大小", render: (row) => formatBytes(row.sizeBytes) },
    { key: "visibility", label: "可见性", render: (row) => <StatusPill value={visibilityLabel(row.visibility)} /> },
    { key: "uploader", label: "上传人", render: (row) => row.uploader?.name || "-" },
    { key: "createdAt", label: "上传时间", render: fileCreatedAt },
    {
      key: "action",
      label: "操作",
      render: (row) => <button type="button" onClick={() => actions.downloadFile(row)}>下载</button>
    }
  ];
  const exportColumns = [
    { key: "time", label: "导出时间" },
    { key: "operator", label: "导出人" },
    { key: "module", label: "模块" },
    { key: "scope", label: "范围" },
    { key: "businessReason", label: "业务用途" },
    { key: "fileName", label: "文件名" },
    { key: "rowCount", label: "行数" },
    { key: "ip", label: "IP地址" },
    { key: "requestId", label: "请求ID" }
  ];
  const accountColumns = [
    { key: "employeeNo", label: "工号" },
    { key: "employeeName", label: "员工" },
    { key: "department", label: "部门" },
    { key: "roleTitle", label: "岗位" },
    {
      key: "accountEmail",
      label: "登录账号",
      render: (row) => row.accountEmail || <span className="soft-text">未开户</span>
    },
    {
      key: "accountStatus",
      label: "状态",
      render: (row) => <StatusPill value={userStatusLabel(row.accountMustChangePassword ? "FIRST_LOGIN_REQUIRED" : row.accountStatus)} />
    },
    {
      key: "roleCodes",
      label: "角色",
      render: (row) => (row.roleNames?.length ? row.roleNames.join("、") : row.roleCodes?.join("、") || "-")
    },
    {
      key: "manage",
      label: "权限",
      render: (row) => row.accountId ? (
        <button type="button" onClick={() => setSelectedUserId(row.accountId)}>管理权限</button>
      ) : <button type="button" onClick={() => generateActivationCode(row)}>生成激活码</button>
    }
  ];
  const credentialColumns = [
    { key: "employeeNo", label: "工号" },
    { key: "name", label: "员工" },
    { key: "email", label: "登录账号" },
    { key: "temporaryPassword", label: "一次性临时密码" },
    { key: "roleCodes", label: "角色", render: (row) => (row.roleCodes || []).join("、") }
  ];
  const activationColumns = [
    { key: "employeeNo", label: "工号", render: (row) => row.employee?.employeeNo || "-" },
    { key: "employeeName", label: "员工", render: (row) => row.employee?.employeeName || "-" },
    { key: "activationCode", label: "一次性激活码" },
    { key: "expiresAt", label: "过期时间", render: (row) => readinessTime(row.expiresAt) },
    { key: "roleCodes", label: "默认角色", render: (row) => (row.roleCodes || []).join("、") }
  ];
  const dependencyColumns = [
    { key: "name", label: "检查项" },
    { key: "status", label: "状态", render: (row) => <StatusPill value={dependencyLabel(row.status)} /> },
    { key: "detail", label: "说明" }
  ];
  const controlColumns = [
    { key: "label", label: "保护项" },
    { key: "status", label: "状态", render: (row) => <StatusPill value={controlStatus(row)} /> },
    { key: "runtimeStatus", label: "当前值", render: (row) => row.status },
    { key: "detail", label: "说明" }
  ];
  const gapColumns = [
    { key: "id", label: "缺口" },
    { key: "status", label: "状态", render: (row) => <StatusPill value={row.status === "Open" ? "已阻断" : "已通过"} /> },
    { key: "owner", label: "负责人" },
    { key: "targetDate", label: "目标日期" },
    { key: "gap", label: "说明" }
  ];
  const signoffColumns = [
    { key: "label", label: "签署项" },
    { key: "status", label: "状态", render: (row) => <StatusPill value={row.status} /> },
    { key: "pendingApprovalCount", label: "待审批" },
    { key: "openExceptionCount", label: "待清理异常" },
    { key: "draft", label: "发布证据", render: (row) => (row.draft ? "否，仅草稿" : "可验证") }
  ];
  const gapOwnerColumns = [
    { key: "owner", label: "责任人" },
    { key: "gapIds", label: "缺口", render: (row) => (row.gapIds || []).join("、") || "-" },
    { key: "targetDates", label: "目标日期", render: (row) => (row.targetDates || []).join("、") || "-" },
    { key: "status", label: "状态", render: (row) => <StatusPill value={row.status || "待闭环"} /> },
    { key: "validationCommandCount", label: "验证命令" },
    { key: "blockerCount", label: "阻塞项" }
  ];
  const closurePlanColumns = [
    { key: "id", label: "缺口" },
    { key: "category", label: "闭环类型" },
    { key: "owner", label: "责任人" },
    { key: "targetDate", label: "目标日期" },
    { key: "evidenceStatus", label: "证据状态", render: (row) => <StatusPill value={row.evidenceStatus} /> },
    { key: "failedCheckCount", label: "失败检查" },
    { key: "relatedCheckIds", label: "相关检查", render: (row) => (row.relatedCheckIds || []).join("、") || "-" },
    { key: "nextAction", label: "下一步动作" }
  ];
  const evidenceCheckColumns = [
    { key: "id", label: "检查" },
    { key: "status", label: "状态", render: (row) => <StatusPill value={evidenceStatus(row.status)} /> },
    { key: "required", label: "门禁", render: (row) => (row.required ? "必需" : "签署/环境") },
    { key: "exitCode", label: "退出码", render: (row) => row.exitCode ?? "-" }
  ];
  const artifactColumns = [
    { key: "label", label: "工件" },
    { key: "phase", label: "阶段" },
    { key: "status", label: "状态", render: (row) => <StatusPill value={row.status} /> },
    { key: "releaseRequired", label: "发布必需", render: (row) => (row.releaseRequired ? "是" : "否") }
  ];
  const ownerEvidenceColumns = [
    { key: "id", label: "缺口" },
    { key: "category", label: "证据包" },
    { key: "owner", label: "责任人" },
    { key: "targetDate", label: "目标日期" },
    { key: "evidenceStatus", label: "证据状态", render: (row) => <StatusPill value={row.evidenceStatus} /> },
    { key: "artifactCount", label: "工件", render: (row) => `${row.presentArtifactCount || 0}/${row.artifactCount || 0}` },
    {
      key: "missingArtifactCount",
      label: "缺失发布工件",
      render: (row) => {
        const missing = (row.artifacts || []).filter((artifact) => artifact.releaseRequired && !artifact.present);
        return missing.length ? missing.map((artifact) => artifact.label).join("、") : "无";
      }
    },
    { key: "nextAction", label: "下一步动作" }
  ];
  const auditIntegrityColumns = [
    { key: "label", label: "校验项" },
    { key: "value", label: "数量/值" },
    { key: "status", label: "状态", render: (row) => <StatusPill value={row.status} /> }
  ];
  const dependencyRows = [
    { id: "database", name: "数据库", status: dependencies.database, detail: "Prisma 查询探活" },
    { id: "databaseIntegrity", name: "数据库完整性", status: dependencies.databaseIntegrity, detail: "审计/导入/导出 append-only 触发器" },
    { id: "fileStorage", name: "文件存储", status: dependencies.fileStorage, detail: "写入并删除探针文件" }
  ];
  const auditIntegrityRows = [
    {
      id: "total",
      label: "校验范围",
      value: auditIntegritySummary.totalRows ?? state.auditLogs.length,
      status: auditIntegrityView.pill
    },
    {
      id: "signed",
      label: "已签名审计行",
      value: auditIntegritySummary.signedRows ?? 0,
      status: (auditIntegritySummary.signedRows || 0) > 0 && auditIntegrity.ok ? "已通过" : "未连接"
    },
    {
      id: "unsigned",
      label: "未签名遗留行",
      value: auditIntegritySummary.unsignedRows ?? 0,
      status: (auditIntegritySummary.unsignedRows || 0) > 0 ? "需复核" : "已通过"
    },
    {
      id: "lastSequence",
      label: "最后序号",
      value: auditIntegritySummary.lastSequence ?? "-",
      status: auditIntegritySummary.lastSequence ? (auditIntegrity.ok ? "连续" : "已阻断") : "未连接"
    },
    {
      id: "lastHash",
      label: "末端哈希",
      value: shortHash(auditIntegritySummary.lastHash),
      status: auditIntegritySummary.lastHash ? "已记录" : "未连接"
    }
  ];
  return (
    <div className="module-layout">
      <section className="module-title">
        <div>
          <h1>权限审计</h1>
          <p>角色权限、操作日志、敏感字段隐藏和导出记录。所有关键流程都会写入这里。</p>
        </div>
        <button className="primary" type="button" onClick={() => actions.toggleSensitive()}>
          {state.revealSensitive ? "关闭敏感字段" : "授权敏感字段"}
        </button>
      </section>
      <section className="kpi-strip">
        <MetricCard label="审计日志" value={`${state.auditLogs.length} 条`} />
        <MetricCard label="角色权限" value={`${roles.length} 组`} />
        <MetricCard label="员工账号" tone={accountStats.missingAccounts ? "orange" : "green"} value={`${accountStats.activeAssignedAccounts || 0}/${accountStats.activeEmployees || 0}`} />
        <MetricCard label="开户覆盖" tone={accountStats.missingAccounts ? "orange" : "green"} value={`${accountStats.coverageRate || 0}%`} />
        <MetricCard label="敏感字段" tone={state.revealSensitive ? "red" : "green"} value={state.revealSensitive ? "已授权" : "默认隐藏"} />
        <MetricCard label="导出记录" value={`${exportCount} 次`} />
        <MetricCard label="附件记录" value={`${attachmentCount} 个`} />
        <MetricCard label="审计链" tone={auditIntegrityView.tone} value={auditIntegrityView.label} />
        <MetricCard label="发布门禁" tone={releaseGate.releaseReady ? "green" : "red"} value={releaseGate.releaseReady ? "可发布" : "阻断中"} />
        <MetricCard label="最新证据" tone={latestEvidence.releaseEvidence ? "green" : "red"} value={latestEvidence.releaseEvidence ? "生产证据" : "不可发布"} />
        <MetricCard label="证据模式" tone={latestEvidence.evidenceMode === "full" ? "green" : "red"} value={latestEvidence.evidenceMode || "missing"} />
        <MetricCard label="候选证据" tone={latestEvidence.releaseCandidateReady ? "green" : "red"} value={latestEvidence.releaseCandidateReady ? "已就绪" : `${latestEvidence.releaseBlockerCount || 0} 阻断`} />
        <MetricCard label="证据工件" tone={artifactSummary.missingReleaseArtifactCount ? "red" : "green"} value={`${artifactSummary.presentFileCount || 0}/${artifactSummary.trackedFileCount || 0}`} />
        <MetricCard label="证据责任" tone={ownerEvidenceChecklist.some((item) => item.releaseBlocking) ? "red" : "green"} value={`${ownerEvidenceChecklist.filter((item) => item.missingArtifactCount > 0).length}/${ownerEvidenceChecklist.length || 0}`} />
      </section>
      <Panel
        title="商用发布状态"
        actions={<span className="soft-text">生成时间：{readinessTime(systemReadiness.generatedAt)}</span>}
      >
        <div className="readiness-summary">
          <div>
            <span>运行环境</span>
            <strong>{systemReadiness.runtime?.environment || "未验证"}</strong>
            <em>{systemReadiness.runtime?.service || "未连接"}</em>
          </div>
          <div>
            <span>开放缺口</span>
            <strong>{releaseGate.openGapCount || 0}</strong>
            <em>{systemReadiness.knownGapSourceAvailable ? "来自 docs/KNOWN_GAPS.md" : "缺口台账未读取"}</em>
          </div>
          <div>
            <span>门禁结论</span>
            <strong>{releaseGate.releaseReady ? "可发布" : "不可发布"}</strong>
            <em>{releaseGate.blockers?.[0] || "所有发布阻断项已清理"}</em>
          </div>
          <div>
            <span>签署草稿</span>
            <strong>{signoffDrafts.available ? `${signoffDrafts.draftCount} 份` : "未生成"}</strong>
            <em>
              {signoffDrafts.available
                ? `${signoffDrafts.pendingApprovalCount || 0} 个待审批 · ${signoffDrafts.openExceptionCount || 0} 个异常`
                : "先运行 npm run signoff:drafts"}
            </em>
          </div>
          <div>
            <span>HR审阅包</span>
            <strong>{hrDataReview.available ? `${hrDataReview.rowCount || hrDataReview.counts?.totalReviewRows || 0} 行` : "未生成"}</strong>
            <em>
              {hrDataReview.available
                ? `${hrDataReview.counts?.activeEmployees || 0} 在职 · ${hrDataReview.counts?.leavers || 0} 离职`
                : "等待脱敏审阅包"}
            </em>
          </div>
          <div>
            <span>责任闭环</span>
            <strong>{gapActionReport.available ? `${gapActionReport.ownerCount || 0} 组` : "未生成"}</strong>
            <em>
              {gapActionReport.available
                ? `${gapActionReport.blockedGapCount || 0} 个阻断 · ${gapActionReport.warningCheckCount || 0} 个警告`
                : "等待 gap report"}
            </em>
          </div>
          <div>
            <span>最新证据</span>
            <strong>{latestEvidence.available ? (latestEvidence.releaseCandidateReady ? "候选就绪" : latestEvidence.status) : "未生成"}</strong>
            <em>
              {latestEvidence.available
                ? `${latestEvidence.evidenceMode || "missing"} · E2E ${latestEvidence.e2eIncluded ? "已包含" : "缺失"} · ${latestEvidence.releaseBlockerCount || 0} 个阻断 · ${evidenceTargetLabel(latestEvidence.targetProfile?.database?.target)}`
                : "等待 evidence:commercial"}
            </em>
          </div>
        </div>
        {releaseGate.blockers?.length ? (
          <div className="blocker-list">
            {releaseGate.blockers.slice(0, 6).map((item) => <span key={item}>{item}</span>)}
          </div>
        ) : null}
        <div className="two-col readiness-tables">
          <DataTable columns={dependencyColumns} rows={dependencyRows} rowKey={(row) => row.id} />
          <DataTable columns={controlColumns} rows={systemReadiness.controls || []} rowKey={(row) => row.id} />
        </div>
        <div className="signoff-readiness">
          <div>
            <strong>签署准备</strong>
            <span>
              {signoffDrafts.available
                ? `草稿生成时间：${readinessTime(signoffDrafts.generatedAt)} · 责任项 ${signoffDrafts.handoffItemCount || 0} 个 · 责任缺口 ${(signoffDrafts.relatedGapIds || []).join(" / ") || "未识别"} · 待办 ${signoffDrafts.requiredActionCount || 0} 项`
                : "尚未生成签署草稿"}
            </span>
          </div>
          <StatusPill value={signoffDrafts.releaseEvidence ? "可作为发布证据" : "非发布证据"} />
        </div>
        <div className="signoff-readiness">
          <div>
            <strong>HR 数据审阅包</strong>
            <span>
              {hrDataReview.available
                ? `生成时间：${readinessTime(hrDataReview.generatedAt)} · ${hrDataReview.noSensitiveFields ? "无敏感字段" : "需复核字段"} · 后续验证命令 ${hrDataReview.nextCommandCount || 0} 条`
                : "尚未生成脱敏审阅包"}
            </span>
          </div>
          <StatusPill value={hrDataReview.releaseEvidence ? "可作为发布证据" : "非发布证据"} />
        </div>
        <div className="signoff-readiness">
          <div>
            <strong>责任人闭环报告</strong>
            <span>
              {gapActionReport.available
                ? `生成时间：${readinessTime(gapActionReport.generatedAt)} · ${gapActionReport.ownerCount || 0} 组责任人 · ${gapActionReport.status || "待闭环"}`
                : "尚未生成责任人闭环报告"}
            </span>
          </div>
          <StatusPill value={gapActionReport.releaseEvidence ? "可作为发布证据" : "动作分派"} />
        </div>
        <div className="signoff-readiness">
          <div>
            <strong>最新商业证据</strong>
            <span>
              {latestEvidence.available
                ? `生成时间：${readinessTime(latestEvidence.generatedAt)} · ${latestEvidence.checkCount || 0} 个检查 · ${latestEvidence.evidenceMode || "missing"} 模式 · E2E ${latestEvidence.e2eIncluded ? "已包含" : "缺失"} · ${latestEvidence.releaseBlockerCount || 0} 个阻断 · ${latestEvidence.targetProfile?.evidenceClass || "missing"}`
                : "尚未生成最新商业证据包"}
            </span>
          </div>
          <StatusPill value={latestEvidence.releaseCandidateReady ? "候选证据已就绪" : "候选证据未就绪"} />
        </div>
        <div className="signoff-readiness">
          <div>
            <strong>证据工件清单</strong>
            <span>
              {artifactSummary.available
                ? `${artifactSummary.migrationCount || 0} 个迁移 · ${artifactSummary.presentFileCount || 0}/${artifactSummary.trackedFileCount || 0} 个工件已归档 · ${artifactSummary.missingReleaseArtifactCount || 0} 个发布必需工件缺失`
                : "尚未读取证据工件清单"}
            </span>
          </div>
          <StatusPill value={artifactSummary.missingReleaseArtifactCount ? "工件缺失" : "工件齐全"} />
        </div>
        <div className="signoff-readiness">
          <div>
            <strong>目标环境画像</strong>
            <span>
              {`${latestEvidence.targetProfile?.productionRuntime ? "生产运行" : "非生产运行"} · ${latestEvidence.targetProfile?.productionEvidenceReady ? "签署齐全" : "签署未齐"} · API ${latestEvidence.targetProfile?.viteRequireApi || "unset"} · Demo ${latestEvidence.targetProfile?.viteDemoFallback || "unset"}`}
            </span>
          </div>
          <StatusPill value={evidenceTargetLabel(latestEvidence.targetProfile?.database?.target)} />
        </div>
        <DataTable
          columns={evidenceCheckColumns}
          empty="暂无商业证据检查摘要"
          rows={latestEvidence.checks || []}
          rowKey={(row) => row.id}
        />
        <DataTable
          columns={artifactColumns}
          empty="暂无证据工件清单"
          rows={artifactSummary.items || []}
          rowKey={(row) => row.id}
        />
        <div className="signoff-readiness">
          <div>
            <strong>责任人证据清单</strong>
            <span>
              {ownerEvidenceChecklist.length
                ? `${ownerEvidenceChecklist.filter((item) => item.releaseBlocking).length} 个责任项仍阻断 · ${ownerEvidenceChecklist.reduce((sum, item) => sum + (item.missingArtifactCount || 0), 0)} 个发布工件缺失`
                : "暂无责任人证据清单"}
            </span>
          </div>
          <StatusPill value={ownerEvidenceChecklist.some((item) => item.releaseBlocking) ? "待补证据" : "证据齐全"} />
        </div>
        <DataTable
          columns={ownerEvidenceColumns}
          empty="暂无责任人证据清单"
          rows={ownerEvidenceChecklist}
          rowKey={(row) => row.id}
        />
        <div className="signoff-readiness">
          <div>
            <strong>发布闭环清单</strong>
            <span>
              {closurePlan.length
                ? `${closurePlan.filter((item) => item.releaseBlocking).length} 个仍阻断 · ${closurePlan.filter((item) => item.evidenceStatus === "可复核关闭").length} 个可复核`
                : "暂无闭环清单"}
            </span>
          </div>
          <StatusPill value={closurePlan.some((item) => item.releaseBlocking) ? "待闭环" : "已闭环"} />
        </div>
        <DataTable
          columns={closurePlanColumns}
          empty="暂无发布闭环清单"
          rows={closurePlan}
          rowKey={(row) => row.id}
        />
        <DataTable
          columns={gapOwnerColumns}
          empty="暂无责任人闭环摘要"
          rows={gapActionReport.owners || []}
          rowKey={(row) => `${row.owner}-${(row.gapIds || []).join("-")}`}
        />
        <DataTable
          columns={signoffColumns}
          empty="暂无签署草稿摘要"
          rows={signoffDrafts.kinds || []}
          rowKey={(row) => row.id}
        />
        <DataTable columns={gapColumns} empty="暂无开放商用缺口" rows={knownGaps} rowKey={(row) => row.id} />
      </Panel>
      <Panel title="角色权限" actions={<span className="soft-text">{permissions.length} 个权限点 · {iam.users?.length || 0} 个账号</span>}>
        <div className="role-grid">
          {roles.map((role) => (
            <button
              className={selectedRole?.id === role.id ? "role-card active" : "role-card"}
              key={role.id}
              type="button"
              onClick={() => setSelectedRoleId(role.id)}
            >
              <strong>{role.name}</strong>
              <span>{role.userCount || 0} 人 · {role.permissionCodes?.length || role.permissions?.length || 0} 个权限</span>
              <em>{role.description}</em>
              <StatusPill value="启用" />
            </button>
          ))}
        </div>
        {selectedRole ? (
          <div className="permission-editor">
            <div className="permission-editor-head">
              <div>
                <strong>{selectedRole.name}</strong>
                <span>{selectedRole.code} · 权限变更会写入审计日志</span>
              </div>
              <StatusPill value={`${selectedPermissionCodes.size} 个权限`} />
            </div>
            <div className="permission-matrix">
              {Object.entries(groupedPermissions).map(([module, items]) => (
                <section key={module}>
                  <h3>{moduleLabels[module] || module}</h3>
                  {items.map((permission) => {
                    const checked = selectedPermissionCodes.has(permission.code);
                    const protectedAdminPermission = selectedRole.code === "admin" && ["system.admin", "iam.write"].includes(permission.code);
                    return (
                      <label key={permission.code}>
                        <input
                          checked={checked}
                          disabled={protectedAdminPermission || Boolean(iamBusyKey)}
                          type="checkbox"
                          onChange={(event) => togglePermission(permission.code, event.target.checked)}
                        />
                        <span>{permission.name}</span>
                        <em>{permission.code}</em>
                      </label>
                    );
                  })}
                </section>
              ))}
            </div>
            {iamMessage ? <p className="iam-change-message">{iamMessage}</p> : null}
          </div>
        ) : null}
      </Panel>
      <Panel
        title="员工账号库"
        actions={<span className="soft-text">在职开户 {accountStats.activeAssignedAccounts || 0}/{accountStats.activeEmployees || 0} · 缺口 {accountStats.missingAccounts || 0}</span>}
      >
        <div className="account-library-toolbar">
          <div>
            <strong>批量给未开户员工生成登录账号</strong>
            <span>默认只处理在职员工；员工首次登录必须修改登录账号和密码。</span>
          </div>
          <div className="account-role-options">
            {roles.map((role) => (
              <label key={`sync-${role.code}`}>
                <input
                  checked={syncRoleCodes.includes(role.code)}
                  type="checkbox"
                  onChange={(event) => toggleSyncRole(role.code, event.target.checked)}
                />
                <span>{role.name}</span>
              </label>
            ))}
          </div>
          <button className="primary" disabled={!syncRoleCodes.length || !(accountStats.missingAccounts > 0)} type="button" onClick={syncEmployeeAccounts}>
            生成缺失账号
          </button>
        </div>
        {syncMessage ? <p className="account-sync-message">{syncMessage}</p> : null}
        {syncCredentials.length ? (
          <div className="credential-result">
            <div>
              <strong>本次临时密码</strong>
              <span>交付给员工后只能用于首次登录，员工完成设置后临时密码立即失效；刷新后不会再次展示。</span>
            </div>
            <DataTable columns={credentialColumns} rows={syncCredentials} rowKey={(row) => row.employeeId} />
          </div>
        ) : null}
        {activationResults.length ? (
          <div className="credential-result">
            <div>
              <strong>本次激活码</strong>
              <span>员工在登录页选择“员工激活”，输入激活码、工号和姓名后自行设置账号密码；刷新后不会再次展示。</span>
            </div>
            <DataTable columns={activationColumns} rows={activationResults} rowKey={(row) => row.id} />
          </div>
        ) : null}
        <DataTable columns={accountColumns} empty="暂无员工账号数据" rows={accountRows} rowKey={(row) => row.employeeId} />
      </Panel>
      <Panel title="账号角色分配" actions={<span className="soft-text">账号角色变更会刷新后端权限判定</span>}>
        <form className="account-create-form" onSubmit={submitAccountCreate}>
          <label>
            <span>姓名</span>
            <input
              value={accountDraft.name}
              onChange={(event) => setAccountDraft({ ...accountDraft, name: event.target.value })}
            />
          </label>
          <label>
            <span>临时登录账号（邮箱/手机号）</span>
            <input
              autoComplete="off"
              value={accountDraft.email}
              onChange={(event) => setAccountDraft({ ...accountDraft, email: event.target.value })}
            />
          </label>
          <label>
            <span>临时密码</span>
            <input
              autoComplete="new-password"
              placeholder="至少 12 位，含字母和数字"
              type="password"
              value={accountDraft.newPassword}
              onChange={(event) => setAccountDraft({ ...accountDraft, newPassword: event.target.value })}
            />
          </label>
          <label>
            <span>状态</span>
            <select
              value={accountDraft.status}
              onChange={(event) => setAccountDraft({ ...accountDraft, status: event.target.value })}
            >
              <option value="ACTIVE">启用</option>
              <option value="DISABLED">停用</option>
            </select>
          </label>
          <div className="account-role-options">
            {roles.map((role) => (
              <label key={`create-${role.code}`}>
                <input
                  checked={accountDraft.roleCodes.includes(role.code)}
                  type="checkbox"
                  onChange={(event) => toggleAccountRole(role.code, event.target.checked)}
                />
                <span>{role.name}</span>
              </label>
            ))}
          </div>
          <button
            className="primary"
            disabled={!accountDraft.email || !accountDraft.name || accountDraft.newPassword.length < 12 || !accountDraft.roleCodes.length}
            type="submit"
          >
            创建账号
          </button>
          {accountMessage ? <p>{accountMessage}</p> : <p className="soft-text">创建后默认要求员工首次登录改登录账号和密码。</p>}
        </form>
        <div className="user-role-layout">
          <div className="user-list">
            {(iam.users || []).map((user) => (
              <button
                className={selectedUser?.id === user.id ? "active" : ""}
                key={user.id}
                type="button"
                onClick={() => setSelectedUserId(user.id)}
              >
                <strong>{user.name}</strong>
                <span>{user.email}</span>
                <em>{(user.roleCodes || user.roles?.map((role) => role.code) || []).join(" / ") || "未分配角色"}</em>
                <StatusPill value={userStatusLabel(user.mustChangePassword ? "FIRST_LOGIN_REQUIRED" : user.status)} />
              </button>
            ))}
          </div>
          {selectedUser ? (
            <div className="user-role-editor">
              <div>
                <strong>{selectedUser.name}</strong>
                <span>{selectedUser.employee?.roleTitle || selectedUser.email}</span>
                <StatusPill value={userStatusLabel(selectedUser.mustChangePassword ? "FIRST_LOGIN_REQUIRED" : selectedUser.status)} />
              </div>
              <div className="role-check-list">
                {roles.map((role) => {
                  const checked = selectedUserRoleCodes.has(role.code);
                  const lastRole = checked && selectedUserRoleCodes.size <= 1;
                  return (
                    <label key={`${selectedUser.id}-${role.code}`}>
                      <input
                        checked={checked}
                        disabled={lastRole || Boolean(iamBusyKey)}
                        type="checkbox"
                        onChange={(event) => toggleUserRole(role.code, event.target.checked)}
                      />
                      <span>{role.name}</span>
                      <em>{role.code}</em>
                    </label>
                  );
                })}
              </div>
              <div className="action-row">
                <button
                  disabled={Boolean(iamBusyKey)}
                  type="button"
                  onClick={() => {
                    const nextStatus = selectedUser.status === "DISABLED" ? "ACTIVE" : "DISABLED";
                    void runIamChange(
                      `user-status:${selectedUser.id}`,
                      `已${nextStatus === "ACTIVE" ? "恢复" : "停用"} ${selectedUser.name} 的账号。`,
                      () => actions.updateUserStatus(selectedUser.id, nextStatus)
                    );
                  }}
                >
                  {selectedUser.status === "DISABLED" ? "恢复账号" : "停用账号"}
                </button>
              </div>
              {iamMessage ? <p className="iam-change-message">{iamMessage}</p> : null}
              <div className="password-reset-row">
                <label>
                  <span>临时密码</span>
                  <input
                    autoComplete="new-password"
                    placeholder="至少 12 位，含字母和数字"
                    type="password"
                    value={passwordDraft}
                    onChange={(event) => setPasswordDraft(event.target.value)}
                  />
                </label>
                <button disabled={passwordDraft.length < 12} type="button" onClick={submitPasswordReset}>重置密码</button>
              </div>
              {passwordMessage ? <p className="password-reset-message">{passwordMessage}</p> : <p className="soft-text">重置后员工需要用临时密码完成首次登录设置。</p>}
            </div>
          ) : null}
        </div>
      </Panel>
      <Panel title="附件中心" actions={<span className="soft-text">上传、下载和附件访问都会写入审计</span>}>
        <form className="attachment-form" onSubmit={submitAttachment}>
          <label>
            <span>选择附件</span>
            <input
              ref={fileInputRef}
              type="file"
              onChange={(event) => setSelectedFile(event.target.files?.[0] || null)}
            />
          </label>
          <label>
            <span>可见性</span>
            <select value={visibility} onChange={(event) => setVisibility(event.target.value)}>
              <option value="PRIVATE">仅本人</option>
              <option value="TENANT">租户内</option>
            </select>
          </label>
          <button className="primary" disabled={!selectedFile} type="submit">上传附件</button>
          <p>{attachmentMessage || (selectedFile ? `${selectedFile.name} · ${formatBytes(selectedFile.size)}` : "未选择文件")}</p>
        </form>
        <DataTable columns={fileColumns} empty="暂无附件" rows={files} />
      </Panel>
      <Panel title="导出记录" actions={<span className="soft-text">后端记录导出人、范围、筛选条件和行数</span>}>
        <DataTable columns={exportColumns} empty="暂无导出记录" rows={exportRecords} />
      </Panel>
      <Panel
        title="审计完整性"
        actions={<StatusPill value={auditIntegrityView.pill} />}
      >
        <div className="signoff-readiness">
          <div>
            <strong>租户审计哈希链</strong>
            <span>
              {auditIntegritySummary.lastHash
                ? `后端校验至序号 ${auditIntegritySummary.lastSequence || "-"}，末端哈希 ${shortHash(auditIntegritySummary.lastHash)}`
                : "本地演示审计记录未签名，不能作为发布证据。"}
            </span>
          </div>
          <StatusPill value={auditIntegrityView.pill} />
        </div>
        <DataTable columns={auditIntegrityColumns} rows={auditIntegrityRows} rowKey={(row) => row.id} />
        {auditIntegrity.errors?.length ? (
          <div className="blocker-list">
            {auditIntegrity.errors.slice(0, 6).map((item) => <span key={item}>{item}</span>)}
          </div>
        ) : null}
        {auditIntegrity.warnings?.length ? (
          <div className="blocker-list">
            {auditIntegrity.warnings.slice(0, 6).map((item) => <span key={item}>{item}</span>)}
          </div>
        ) : null}
      </Panel>
      <Panel title="操作日志" actions={<button type="button" onClick={() => actions.exportAudit("操作日志")}>导出日志</button>}>
        <DataTable columns={columns} rows={state.auditLogs} />
      </Panel>
    </div>
  );
}
