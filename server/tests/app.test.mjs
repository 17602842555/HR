import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import bcrypt from "bcryptjs";
import { buildApp } from "../src/app.mjs";

const productionFileStorageDir = "/var/lib/oa/files";

const defaultPermissionCodes = [
  "system.admin",
  "analytics.read",
  "analytics.export",
  "employee.read",
  "employee.export",
  "workflow.read",
  "workflow.export",
  "attendance.read",
  "attendance.export",
  "finance.read",
  "finance.export",
  "asset.read",
  "asset.export",
  "import.read",
  "import.write",
  "resource.read",
  "resource.export",
  "audit.read",
  "file.read",
  "file.upload"
];

const permissionDefinitions = [
  ["system.admin", "系统管理", "system"],
  ["analytics.read", "查看管理看板", "analytics"],
  ["analytics.export", "导出管理看板", "analytics"],
  ["iam.read", "查看用户角色", "iam"],
  ["iam.write", "管理用户角色", "iam"],
  ["employee.read", "查看员工", "people"],
  ["employee.sensitive.read", "查看员工敏感字段", "people"],
  ["employee.write", "管理员工", "people"],
  ["employee.export", "导出员工名册", "people"],
  ["workflow.read", "查看审批", "workflow"],
  ["workflow.write", "配置审批", "workflow"],
  ["workflow.approve", "处理审批", "workflow"],
  ["workflow.export", "导出审批列表", "workflow"],
  ["attendance.read", "查看假勤", "attendance"],
  ["attendance.write", "管理假勤", "attendance"],
  ["attendance.export", "导出考勤记录", "attendance"],
  ["finance.read", "查看财务", "finance"],
  ["finance.write", "管理财务", "finance"],
  ["finance.export", "导出财务单据", "finance"],
  ["asset.read", "查看资产", "asset"],
  ["asset.write", "管理资产", "asset"],
  ["asset.export", "导出资产台账", "asset"],
  ["import.read", "查看数据导入记录", "import"],
  ["import.write", "导入人员数据", "import"],
  ["resource.read", "查看资源", "resource"],
  ["resource.book", "预约资源", "resource"],
  ["resource.export", "导出资源预约", "resource"],
  ["audit.read", "查看审计日志", "audit"],
  ["audit.export", "导出审计日志", "audit"],
  ["file.read", "查看文件附件", "file"],
  ["file.upload", "上传文件", "file"]
];

function rolePermissionLink(code, policy = {}) {
  return {
    permission: { code },
    dataScope: policy.dataScope || null,
    fieldPolicy: policy.fieldPolicy || null,
    allowExport: Boolean(policy.allowExport)
  };
}

function accessGraph(permissionCodes = defaultPermissionCodes, permissionPolicies = {}) {
  return {
    employee: {
      id: "emp-admin",
      employeeNo: "EMP-ADMIN-001",
      name: "系统管理员",
      departmentId: "dept-admin",
      roleTitle: "OA系统管理员"
    },
    roles: [
      {
        role: {
          code: "admin",
          name: "系统管理员",
          permissions: permissionCodes.map((code) => rolePermissionLink(code, permissionPolicies[code]))
        }
      }
    ]
  };
}

async function makePrismaMock(options = {}) {
  const tenantId = "tenant-default";
  const user = {
    id: "user-admin",
    tenantId,
    email: "admin@oa.local",
    name: "系统管理员",
    status: "ACTIVE",
    sessionVersion: 1,
    passwordHash: await bcrypt.hash("admin123456", 4),
    ...accessGraph(options.permissionCodes, options.permissionPolicies || {})
  };
  if (options.userName) {
    user.name = options.userName;
    if (user.employee) user.employee.name = options.employeeName || options.userName;
  }
  if (options.roleCode || options.roleName) {
    user.roles[0].role.code = options.roleCode || user.roles[0].role.code;
    user.roles[0].role.name = options.roleName || user.roles[0].role.name;
  }
  const approvalRules = new Map([
    ["tenant-default:行政部:expense", {
      id: "rule-1",
      tenantId: "tenant-default",
      department: "行政部",
      templateId: "expense",
      templateName: "费用报销",
      enabled: true,
      nodes: [{ id: "expense-1", name: "直属负责人审批", mode: "AND", approvers: ["张三", "李四"] }]
    }],
    ["tenant-default:行政部:leave", {
      id: "rule-leave",
      tenantId: "tenant-default",
      department: "行政部",
      templateId: "leave",
      templateName: "请假申请",
      enabled: true,
      nodes: [
        { id: "leave-1", name: "直属负责人审批", mode: "AND", approvers: ["张三", "李四"] },
        { id: "leave-2", name: "人事备案", mode: "AND", approvers: ["人事专员"] }
      ]
    }],
    ["tenant-default:行政部:transfer", {
      id: "rule-transfer",
      tenantId: "tenant-default",
      department: "行政部",
      templateId: "transfer",
      templateName: "调岗申请",
      enabled: true,
      nodes: [
        { id: "transfer-1", name: "调出部门审批", mode: "AND", approvers: ["张三", "李四"] },
        { id: "transfer-2", name: "调入部门审批", mode: "AND", approvers: ["王五"] },
        { id: "transfer-3", name: "人事复核", mode: "AND", approvers: ["HRBP"] }
      ]
    }]
  ]);
  const ruleKey = (tenantId, department, templateId) => `${tenantId}:${department}:${templateId}`;
  const permissions = new Map(permissionDefinitions.map(([code, name, module], index) => [code, {
    id: `permission-${index + 1}`,
    tenantId,
    code,
    name,
    module,
    description: `${module} module permission`
  }]));
  const roles = new Map([
    ["role-admin", {
      id: "role-admin",
      tenantId,
      code: "admin",
      name: "系统管理员",
      description: "拥有全部权限"
    }],
    ["role-auditor", {
      id: "role-auditor",
      tenantId,
      code: "auditor",
      name: "审计查看员",
      description: "查看审计日志和导出记录"
    }],
    ["role-employee", {
      id: "role-employee",
      tenantId,
      code: "employee-self-service",
      name: "员工自助",
      description: "员工个人办公自助入口"
    }]
  ]);
  if (options.roleCode && !["admin", "auditor"].includes(options.roleCode)) {
    roles.set("role-current", {
      id: "role-current",
      tenantId,
      code: options.roleCode,
      name: options.roleName || options.roleCode,
      description: "当前测试用户角色"
    });
  }
  const rolePermissions = new Map([
    ["role-admin", new Set(options.permissionCodes || defaultPermissionCodes)],
    ["role-auditor", new Set(["audit.read"])],
    ["role-employee", new Set(["workflow.read", "workflow.write", "attendance.read", "attendance.write", "resource.read", "resource.book", "file.read", "file.upload"])],
    ...(roles.has("role-current") ? [["role-current", new Set(options.permissionCodes || defaultPermissionCodes)]] : [])
  ]);
  const rolePermissionPolicies = new Map();
  const setRolePermissionPolicy = (roleId, code, policy = {}) => {
    const rolePolicies = rolePermissionPolicies.get(roleId) || new Map();
    rolePolicies.set(code, {
      dataScope: policy.dataScope || null,
      fieldPolicy: policy.fieldPolicy || null,
      allowExport: Boolean(policy.allowExport)
    });
    rolePermissionPolicies.set(roleId, rolePolicies);
  };
  for (const roleId of rolePermissions.keys()) {
    for (const code of rolePermissions.get(roleId)) {
      setRolePermissionPolicy(roleId, code, options.permissionPolicies?.[code] || {
        allowExport: code.endsWith(".export")
      });
    }
  }
  const userRoleIds = new Map([[user.id, new Set([roles.has("role-current") ? "role-current" : "role-admin"])]]);
  const users = new Map([[user.id, user]]);
  for (const [index, extraUser] of (options.extraUsers || []).entries()) {
    const record = {
      id: extraUser.id || `user-extra-${index + 1}`,
      tenantId,
      email: extraUser.email || `extra-${index + 1}@oa.local`,
      name: extraUser.name || `扩展账号${index + 1}`,
      status: extraUser.status || "ACTIVE",
      sessionVersion: extraUser.sessionVersion || 1,
      passwordHash: await bcrypt.hash(extraUser.password || "extra-password", 4),
      employee: extraUser.employee || null
    };
    users.set(record.id, record);
    const roleIds = extraUser.roleIds || (extraUser.roleCodes || []).map((code) => (
      [...roles.values()].find((role) => role.code === code)?.id
    )).filter(Boolean);
    userRoleIds.set(record.id, new Set(roleIds.length ? roleIds : ["role-auditor"]));
  }
  const auditLogs = [
    {
      id: "audit-failed-upload",
      tenantId,
      action: "file.upload.denied",
      objectType: "file_object",
      summary: "拒绝上传高风险附件 unsafe.html",
      metadata: { result: "失败" },
      ipAddress: "127.0.0.1",
      createdAt: new Date("2026-05-29T10:02:00.000Z"),
      actor: { name: "系统管理员" }
    },
    {
      id: "audit-csv-risk",
      tenantId,
      action: "manual.note",
      objectType: "csv_risk",
      summary: "=HYPERLINK(\"https://example.invalid\",\"open\")",
      metadata: {},
      ipAddress: "127.0.0.1",
      createdAt: new Date("2026-05-29T10:01:00.000Z"),
      actor: { name: "系统管理员" }
    },
    {
      id: "audit-1",
      tenantId,
      action: "seed.bootstrap",
      objectType: "system",
      summary: "初始化测试数据",
      metadata: {},
      ipAddress: "127.0.0.1",
      createdAt: new Date("2026-05-29T10:00:00.000Z"),
      actor: { name: "系统管理员" }
    }
  ];
  const exportRecords = [];
  const roleWithPermissions = (role) => ({
    ...role,
    permissions: [...(rolePermissions.get(role.id) || [])]
      .map((code) => permissions.get(code))
      .filter(Boolean)
      .map((permission) => ({
        permission,
        ...(rolePermissionPolicies.get(role.id)?.get(permission.code) || {})
      }))
  });
  const userWithIncludes = (record) => ({
    ...record,
    roles: [...(userRoleIds.get(record.id) || [])]
      .map((roleId) => roles.get(roleId))
      .filter(Boolean)
      .map((role) => ({ role: roleWithPermissions(role) }))
  });
  const roleWithIncludes = (role) => ({
    ...roleWithPermissions(role),
    users: [...userRoleIds.entries()]
      .filter(([, roleIds]) => roleIds.has(role.id))
      .map(([userId]) => (users.has(userId) ? { user: userWithIncludes(users.get(userId)) } : null))
      .filter(Boolean)
  });
  const resources = [
    {
      id: "resource-1",
      tenantId,
      code: "ROOM-001",
      type: "会议室",
      name: "一号会议室",
      capacity: 10,
      metadata: {}
    }
  ];
  const bookings = [];
  const assets = new Map([
    ["IT-2024-000123", {
      id: "asset-1",
      tenantId,
      assetNo: "IT-2024-000123",
      name: "联想 ThinkPad X1 Carbon",
      category: "办公电脑",
      owner: "张三",
      status: "BORROWED",
      location: "集团总部",
      qrVersion: 1,
      metadata: {},
      createdAt: new Date("2026-05-29T10:00:00.000Z"),
      updatedAt: new Date("2026-05-29T10:00:00.000Z")
    }]
  ]);
  const leaveRequests = new Map([
    ["leave-1", {
      id: "leave-1",
      tenantId,
      applicantUserId: user.id,
      workflowInstanceId: null,
      employeeName: "张三",
      leaveType: "年假",
      dateRange: "2026-05-30 ~ 2026-05-31",
      days: 2,
      status: "PENDING",
      metadata: { handover: "李四" },
      createdAt: new Date("2026-05-29T10:00:00.000Z"),
      updatedAt: new Date("2026-05-29T10:00:00.000Z")
    }]
  ]);
  const attendanceRecords = new Map([
    ["attendance-1", {
      id: "attendance-1",
      tenantId,
      employeeName: "张三",
      department: "行政部",
      workDate: new Date("2026-05-29T00:00:00.000Z"),
      checkInAt: new Date("2026-05-29T08:58:00.000Z"),
      checkOutAt: new Date("2026-05-29T18:05:00.000Z"),
      status: "NORMAL",
      minutesLate: 0,
      source: "access_control",
      metadata: { reason: "" },
      createdAt: new Date("2026-05-29T10:00:00.000Z"),
      updatedAt: new Date("2026-05-29T10:00:00.000Z")
    }],
    ["attendance-2", {
      id: "attendance-2",
      tenantId,
      employeeName: "李四",
      department: "人事部",
      workDate: new Date("2026-05-29T00:00:00.000Z"),
      checkInAt: new Date("2026-05-29T09:18:00.000Z"),
      checkOutAt: new Date("2026-05-29T18:10:00.000Z"),
      status: "LATE",
      minutesLate: 18,
      source: "access_control",
      metadata: { reason: "地铁延误" },
      createdAt: new Date("2026-05-29T10:00:00.000Z"),
      updatedAt: new Date("2026-05-29T10:00:00.000Z")
    }]
  ]);
  const payrollBatches = new Map([
    ["PAYROLL-202605", {
      id: "payroll-1",
      tenantId,
      batchNo: "PAYROLL-202605",
      cycle: "2026年5月",
      scope: "在职、转正、入离职、异动人员",
      owner: "财务中心",
      status: "PENDING_REVIEW",
      reviewerUserId: null,
      workflowInstanceId: "wf-payroll-approved",
      publishedAt: null,
      metadata: {},
      createdAt: new Date("2026-05-29T10:00:00.000Z"),
      updatedAt: new Date("2026-05-29T10:00:00.000Z")
    }],
    ["PAYROLL-202604", {
      id: "payroll-2",
      tenantId,
      batchNo: "PAYROLL-202604",
      cycle: "2026年4月",
      scope: "全员",
      owner: "财务中心",
      status: "ARCHIVED",
      reviewerUserId: null,
      publishedAt: null,
      metadata: {},
      createdAt: new Date("2026-05-28T10:00:00.000Z"),
      updatedAt: new Date("2026-05-28T10:00:00.000Z")
    }]
  ]);
  const financeRequests = new Map([
    ["EXP-202605-0001", {
      id: "finance-request-1",
      tenantId,
      requestNo: "EXP-202605-0001",
      requestType: "EXPENSE",
      title: "办公室耗材报销",
      applicantUserId: user.id,
      department: "行政部",
      amount: 2680,
      currency: "CNY",
      vendor: "京东企业购",
      paymentMethod: "员工垫付",
      status: "PENDING_APPROVAL",
      workflowInstanceId: "wf-expense",
      metadata: { purpose: "办公耗材" },
      createdAt: new Date("2026-05-29T10:00:00.000Z"),
      updatedAt: new Date("2026-05-29T10:00:00.000Z")
    }]
  ]);
  const fileObjects = new Map();
  const dataImportRuns = [
    {
      id: "import-1",
      tenantId,
      actorUserId: user.id,
      sourceType: "html-dashboard",
      sourceName: "oa-dashboard.html",
      sourceChecksum: "sha256-demo",
      status: "SUCCESS",
      recordCounts: {
        activeEmployees: 72,
        femaleEmployees: 43,
        leavers: 162,
        monthLeavers: 4,
        totalRows: 234
      },
      metadata: { parser: "scripts/dashboard-data.mjs" },
      startedAt: new Date("2026-05-29T10:00:00.000Z"),
      finishedAt: new Date("2026-05-29T10:01:00.000Z"),
      actor: user
    }
  ];
  const departments = [
    { id: "dept-admin", tenantId, code: "ADMIN", name: "行政部" },
    ...(options.departments || [])
  ];
  const departmentFor = (departmentId) => departments.find((department) => department.id === departmentId) || null;
  const employees = new Map([
    ["emp-1", {
      id: "emp-1",
      tenantId,
      employeeNo: "EMP-1",
      name: "张三",
      gender: "男",
      departmentId: "dept-admin",
      roleTitle: "行政主管",
      status: "ACTIVE",
      entryDate: new Date("2026-05-01T00:00:00.000Z"),
      leaveDate: null,
      sensitiveInfo: { org: "集团总部", age: "30.0", hukou: "广东/城镇", education: "本科", school: "示例大学", major: "行政管理" }
    }],
    ...(options.employees || []).map((employee) => [employee.id, {
      tenantId,
      gender: "未设置",
      status: "ACTIVE",
      entryDate: null,
      leaveDate: null,
      sensitiveInfo: {},
      ...employee
    }])
  ]);
  const employeeWithIncludes = (employee) => {
    if (!employee) return null;
    const linkedUser = [...users.values()].find((item) => item.employeeId === employee.id);
    return {
      ...employee,
      department: departmentFor(employee.departmentId),
      user: linkedUser ? userWithIncludes(linkedUser) : null
    };
  };
  const matchesScalarOrIn = (value, filter) => {
    if (filter === undefined || filter === null) return true;
    if (typeof filter === "object" && filter.in) return filter.in.includes(value);
    return value === filter;
  };
  const findAssetByWhere = (where = {}) => {
    const compound = where.tenantId_assetNo;
    return [...assets.values()].find((asset) => (
      (!where.id || asset.id === where.id)
      && (!where.tenantId || asset.tenantId === where.tenantId)
      && (!compound || (asset.tenantId === compound.tenantId && asset.assetNo === compound.assetNo))
    )) || null;
  };
  const matchesBookingWhere = (booking, where = {}) => (
    (!where.id || booking.id === where.id)
    && (!where.tenantId || booking.tenantId === where.tenantId)
    && (!where.resourceId || booking.resourceId === where.resourceId)
    && (!where.status || booking.status === where.status)
    && (!where.startsAt?.lt || booking.startsAt < where.startsAt.lt)
    && (!where.endsAt?.gt || booking.endsAt > where.endsAt.gt)
  );
  const workflowDefinitions = new Map([
    ["wf-expense", {
      id: "wf-expense",
      tenantId,
      code: "FIN-EXPENSE",
      name: "费用报销",
      category: "财务行政",
      status: "ACTIVE",
      version: 1,
      formSchema: { fields: [] },
      nodes: []
    }],
    ["wf-leave", {
      id: "wf-leave",
      tenantId,
      code: "ATT-LEAVE",
      name: "请假申请",
      category: "假勤",
      status: "ACTIVE",
      version: 1,
      formSchema: { fields: [] },
      nodes: [
        { id: "leave-def-1", name: "直属负责人审批", stepOrder: 1, approvalMode: "AND", approverRule: { approvers: ["张三", "李四"] } },
        { id: "leave-def-2", name: "人事备案", stepOrder: 2, approvalMode: "AND", approverRule: { approvers: ["人事专员"] } }
      ]
    }],
    ["wf-payroll", {
      id: "wf-payroll",
      tenantId,
      code: "FIN-PAYROLL",
      name: "工资单复核",
      category: "财务行政",
      status: "ACTIVE",
      version: 1,
      formSchema: { fields: [] },
      nodes: [
        { id: "payroll-def-1", name: "薪资专员复核", stepOrder: 1, approvalMode: "AND", approverRule: { approvers: ["薪资专员", "财务专员"] } },
        { id: "payroll-def-2", name: "财务负责人审批", stepOrder: 2, approvalMode: "AND", approverRule: { approvers: ["财务负责人"] } }
      ]
    }],
    ["wf-transfer", {
      id: "wf-transfer",
      tenantId,
      code: "HR-TRANSFER",
      name: "调岗申请",
      category: "组织人事",
      status: "ACTIVE",
      version: 1,
      formSchema: {
        fields: [
          { id: "employee", label: "调岗员工", type: "input" },
          { id: "fromDepartment", label: "调出部门", type: "input" },
          { id: "toDepartment", label: "调入部门", type: "input" }
        ]
      },
      nodes: [
        { id: "transfer-def-1", name: "调出部门审批", stepOrder: 1, approvalMode: "AND", approverRule: { approvers: ["张三", "李四"] } },
        { id: "transfer-def-2", name: "调入部门审批", stepOrder: 2, approvalMode: "AND", approverRule: { approvers: ["王五"] } },
        { id: "transfer-def-3", name: "人事复核", stepOrder: 3, approvalMode: "AND", approverRule: { approvers: ["HRBP"] } }
      ]
    }]
  ]);
  for (const definition of options.workflowDefinitions || []) {
    workflowDefinitions.set(definition.id, {
      tenantId,
      status: "ACTIVE",
      version: 1,
      formSchema: { fields: [] },
      nodes: [],
      ...definition
    });
  }
  const workflowInstances = new Map([
    ["wf-pending", {
      id: "wf-pending",
      tenantId,
      definitionId: "wf-expense",
      definitionCode: "FIN-EXPENSE",
      definitionVersion: 1,
      title: "待审批费用报销",
      status: "PENDING",
      applicantUserId: options.workflowApplicantUserId || user.id,
      departmentId: "dept-admin",
      formData: { amount: 100 },
      currentNodeId: "node-manager",
      submittedAt: new Date("2026-05-29T10:00:00.000Z"),
      createdAt: new Date("2026-05-29T10:00:00.000Z")
    }],
    ["wf-payroll-approved", {
      id: "wf-payroll-approved",
      tenantId,
      definitionId: "wf-payroll",
      definitionCode: "FIN-PAYROLL",
      definitionVersion: 1,
      title: "2026年5月工资单复核",
      status: "APPROVED",
      applicantUserId: user.id,
      departmentId: "dept-admin",
      formData: { cycle: "2026年5月", headcount: 72 },
      currentNodeId: null,
      submittedAt: new Date("2026-05-29T08:00:00.000Z"),
      completedAt: new Date("2026-05-29T09:00:00.000Z"),
      createdAt: new Date("2026-05-29T08:00:00.000Z")
    }]
  ]);
  const workflowNodes = new Map([
    ["node-manager", {
      id: "node-manager",
      tenantId,
      instanceId: "wf-pending",
      name: "部门会签",
      stepOrder: 1,
      approvalMode: "AND",
      status: "ACTIVE"
    }],
    ["node-finance", {
      id: "node-finance",
      tenantId,
      instanceId: "wf-pending",
      name: "财务复核",
      stepOrder: 2,
      approvalMode: "AND",
      status: "PENDING"
    }]
  ]);
  const workflowApprovers = new Map([
    ["approver-zhang", {
      id: "approver-zhang",
      tenantId,
      nodeId: "node-manager",
      approverName: "张三",
      status: "PENDING"
    }],
    ["approver-li", {
      id: "approver-li",
      tenantId,
      nodeId: "node-manager",
      approverName: "李四",
      status: "PENDING"
    }],
    ["approver-finance", {
      id: "approver-finance",
      tenantId,
      nodeId: "node-finance",
      approverName: "财务负责人",
      status: "PENDING"
    }]
  ]);
  const workflowInstanceWithIncludes = (instance) => {
    if (!instance) return null;
    return {
      ...instance,
      definition: workflowDefinitions.get(instance.definitionId),
      nodes: [...workflowNodes.values()]
        .filter((node) => node.instanceId === instance.id)
        .sort((a, b) => a.stepOrder - b.stepOrder)
        .map((node) => ({
          ...node,
          approvers: [...workflowApprovers.values()]
            .filter((approver) => approver.nodeId === node.id)
            .map((approver) => ({ ...approver }))
        }))
    };
  };

  const prisma = {
    tenant: {
      findUnique: async ({ where }) => (where.code === "default"
        ? { id: tenantId, code: "default", name: "默认租户" }
        : null)
    },
    user: {
      findUnique: async ({ where }) => {
        if (where.id && users.has(where.id)) return userWithIncludes(users.get(where.id));
        if (where.tenantId_email?.tenantId) {
          const found = [...users.values()].find((item) => (
            item.tenantId === where.tenantId_email.tenantId && item.email === where.tenantId_email.email
          ));
          if (found) return userWithIncludes(found);
        }
        return null;
      },
      findFirst: async ({ where } = {}) => {
        const found = [...users.values()].find((item) => (
          (!where?.id || where.id === item.id)
          && (!where?.tenantId || where.tenantId === item.tenantId)
          && (!where?.status || where.status === item.status)
        ));
        return found ? userWithIncludes(found) : null;
      },
      findMany: async ({ where } = {}) => {
        options.onUserFindMany?.({ where });
        const ids = where?.id?.in;
        const matchesOr = (item) => {
          if (!where?.OR?.length) return true;
          return where.OR.some((condition) => {
            if (condition.name?.in) return condition.name.in.includes(item.name);
            if (condition.email?.in) return condition.email.in.includes(item.email);
            if (condition.employee?.is?.name?.in) return condition.employee.is.name.in.includes(item.employee?.name);
            if (condition.employee?.is?.email?.in) return condition.employee.is.email.in.includes(item.employee?.email);
            return false;
          });
        };
        return [...users.values()]
          .filter((item) => (
            (!where?.tenantId || where.tenantId === item.tenantId)
            && (!ids || ids.includes(item.id))
            && (!where?.status || where.status === item.status)
            && matchesOr(item)
          ))
          .map(userWithIncludes);
      },
      create: async ({ data } = {}) => {
        const duplicate = [...users.values()].find((item) => (
          item.tenantId === data.tenantId && item.email === data.email
        ));
        if (duplicate) {
          const error = new Error("unique constraint failed");
          error.code = "P2002";
          throw error;
        }
        const record = {
          id: data.id || `user-created-${users.size + 1}`,
          sessionVersion: data.sessionVersion || 1,
          status: data.status || "ACTIVE",
          ...data,
          employee: data.employeeId ? { ...(employees.get(data.employeeId) || null) } : null
        };
        users.set(record.id, record);
        userRoleIds.set(record.id, new Set());
        return userWithIncludes(record);
      },
      update: async ({ where = {}, data } = {}) => {
        const existing = users.get(where.id || user.id);
        if (!existing) {
          const error = new Error("user not found");
          error.code = "P2025";
          throw error;
        }
        if (data?.lastLoginAt !== undefined) existing.lastLoginAt = data.lastLoginAt;
        if (data?.passwordHash !== undefined) existing.passwordHash = data.passwordHash;
        if (data?.status !== undefined) existing.status = data.status;
        if (data?.sessionVersion?.increment) existing.sessionVersion += data.sessionVersion.increment;
        if (Number.isInteger(data?.sessionVersion)) existing.sessionVersion = data.sessionVersion;
        users.set(existing.id, existing);
        return userWithIncludes(existing);
      }
    },
    role: {
      findMany: async ({ where } = {}) => ([...roles.values()]
        .filter((role) => (
          (!where?.tenantId || role.tenantId === where.tenantId)
          && (!where?.code?.in || where.code.in.includes(role.code))
        ))
        .map(roleWithIncludes)),
      findFirst: async ({ where } = {}) => {
        const role = [...roles.values()].find((item) => (
          (!where?.id || item.id === where.id)
          && (!where?.tenantId || item.tenantId === where.tenantId)
          && (!where?.code || item.code === where.code)
        ));
        return role ? roleWithIncludes(role) : null;
      }
    },
    permission: {
      findMany: async ({ where } = {}) => ([...permissions.values()]
        .filter((permission) => (
          (!where?.tenantId || permission.tenantId === where.tenantId)
          && (!where?.code?.in || where.code.in.includes(permission.code))
        )))
    },
    rolePermission: {
      deleteMany: async ({ where }) => {
        if (where?.roleId) rolePermissions.set(where.roleId, new Set());
        if (where?.roleId) rolePermissionPolicies.set(where.roleId, new Map());
        return { count: 1 };
      },
      createMany: async ({ data }) => {
        for (const entry of data || []) {
          const permission = [...permissions.values()].find((item) => item.id === entry.permissionId);
          if (!permission) continue;
          const current = rolePermissions.get(entry.roleId) || new Set();
          current.add(permission.code);
          rolePermissions.set(entry.roleId, current);
          setRolePermissionPolicy(entry.roleId, permission.code, {
            dataScope: entry.dataScope || null,
            fieldPolicy: entry.fieldPolicy || null,
            allowExport: Boolean(entry.allowExport)
          });
        }
        return { count: data?.length || 0 };
      }
    },
    userRole: {
      deleteMany: async ({ where }) => {
        if (where?.userId) userRoleIds.set(where.userId, new Set());
        return { count: 1 };
      },
      createMany: async ({ data }) => {
        for (const entry of data || []) {
          const current = userRoleIds.get(entry.userId) || new Set();
          current.add(entry.roleId);
          userRoleIds.set(entry.userId, current);
        }
        return { count: data?.length || 0 };
      }
    },
    auditLog: {
      create: async ({ data }) => {
        const record = {
          id: `audit-${auditLogs.length + 1}`,
          createdAt: new Date("2026-05-29T10:00:00.000Z"),
          actor: { name: user.name },
          ...data
        };
        auditLogs.unshift(record);
        return record;
      },
      findMany: async ({ where, take } = {}) => {
        options.onAuditFindMany?.({ where, take });
        const metadataPath = where?.metadata?.path?.[0];
        const filtered = auditLogs.filter((item) => (
          (!where?.tenantId || item.tenantId === where.tenantId)
          && (!where?.action || item.action === where.action)
          && (!where?.objectType || item.objectType === where.objectType)
          && (!metadataPath || item.metadata?.[metadataPath] === where.metadata.equals)
          && (!where?.createdAt?.gte || item.createdAt >= where.createdAt.gte)
          && (!where?.createdAt?.lte || item.createdAt <= where.createdAt.lte)
        ));
        return typeof take === "number" ? filtered.slice(0, take) : filtered;
      }
    },
    exportRecord: {
      create: async ({ data }) => {
        const record = {
          id: `export-${exportRecords.length + 1}`,
          createdAt: new Date("2026-05-29T10:00:00.000Z"),
          actor: data.actorUserId ? { name: user.name } : null,
          ...data
        };
        exportRecords.unshift(record);
        return record;
      },
      findMany: async ({ where, take } = {}) => {
        options.onExportRecordFindMany?.({ where, take });
        const filtered = exportRecords.filter((item) => (
          (!where?.tenantId || item.tenantId === where.tenantId)
          && (!where?.action || item.action === where.action)
          && (!where?.actorUserId || item.actorUserId === where.actorUserId)
          && (!where?.createdAt?.gte || item.createdAt >= where.createdAt.gte)
          && (!where?.createdAt?.lte || item.createdAt <= where.createdAt.lte)
        ));
        return typeof take === "number" ? filtered.slice(0, take) : filtered;
      }
    },
    employee: {
      findMany: async ({ where } = {}) => [...employees.values()]
        .filter((employee) => (
          matchesScalarOrIn(employee.id, where?.id)
          && (!where?.tenantId || employee.tenantId === where.tenantId)
          && matchesScalarOrIn(employee.departmentId, where?.departmentId)
          && (!where?.status || employee.status === where.status)
        ))
        .map(employeeWithIncludes),
      findFirst: async ({ where } = {}) => employeeWithIncludes([...employees.values()].find((employee) => (
        matchesScalarOrIn(employee.id, where?.id)
        && (!where?.tenantId || employee.tenantId === where.tenantId)
        && matchesScalarOrIn(employee.departmentId, where?.departmentId)
        && (!where?.name || employee.name === where.name)
      )) || null),
      count: async ({ where } = {}) => [...employees.values()].filter((employee) => (
        (!where?.tenantId || employee.tenantId === where.tenantId)
        && (!where?.employeeNo?.startsWith || employee.employeeNo.startsWith(where.employeeNo.startsWith))
      )).length,
      create: async ({ data } = {}) => {
        const record = {
          id: data.id || `emp-${employees.size + 1}`,
          gender: null,
          status: "ACTIVE",
          entryDate: null,
          leaveDate: null,
          sensitiveInfo: {},
          ...data
        };
        employees.set(record.id, record);
        return employeeWithIncludes(record);
      },
      update: async ({ where, data } = {}) => {
        const existing = employees.get(where.id);
        if (!existing) {
          const error = new Error("employee not found");
          error.code = "P2025";
          throw error;
        }
        const next = {
          ...existing,
          ...(data.departmentId !== undefined ? { departmentId: data.departmentId } : {}),
          ...(data.roleTitle !== undefined ? { roleTitle: data.roleTitle } : {}),
          ...(data.status !== undefined ? { status: data.status } : {}),
          ...(data.entryDate !== undefined ? { entryDate: data.entryDate } : {}),
          ...(data.leaveDate !== undefined ? { leaveDate: data.leaveDate } : {}),
          ...(data.sensitiveInfo !== undefined ? { sensitiveInfo: data.sensitiveInfo } : {})
        };
        employees.set(next.id, next);
        return employeeWithIncludes(next);
      },
      upsert: async ({ where, update, create } = {}) => {
        const identity = where.tenantId_employeeNo;
        const existing = [...employees.values()].find((employee) => (
          employee.tenantId === identity.tenantId && employee.employeeNo === identity.employeeNo
        ));
        if (existing) {
          const next = { ...existing, ...update };
          employees.set(next.id, next);
          return employeeWithIncludes(next);
        }
        const record = {
          id: `emp-${employees.size + 1}`,
          ...create
        };
        employees.set(record.id, record);
        return employeeWithIncludes(record);
      }
    },
    department: {
      findMany: async ({ where } = {}) => {
        options.onDepartmentFindMany?.({ where });
        const ids = where?.id?.in;
        return departments.filter((department) => (
          (!where?.tenantId || department.tenantId === where.tenantId)
          && (!ids || ids.includes(department.id))
        ));
      },
      findFirst: async ({ where } = {}) => {
        return departments.find((department) => (
          (!where?.tenantId || department.tenantId === where.tenantId)
          && (!where?.name || department.name === where.name)
          && (!where?.id || department.id === where.id)
        )) || null;
      },
      upsert: async ({ where, update, create }) => {
        const identity = where.tenantId_code;
        const existing = departments.find((department) => (
          department.tenantId === identity.tenantId && department.code === identity.code
        ));
        if (existing) {
          Object.assign(existing, update);
          return { ...existing };
        }
        const record = {
          id: `dept-${departments.length + 1}`,
          ...create
        };
        departments.push(record);
        return { ...record };
      },
      create: async ({ data }) => {
        const record = {
          id: `dept-${departments.length + 1}`,
          ...data
        };
        departments.push(record);
        return { ...record };
      }
    },
    approvalRule: {
      findMany: async ({ where } = {}) => ([...approvalRules.values()]
        .filter((item) => !where?.tenantId || item.tenantId === where.tenantId)),
      findFirst: async ({ where } = {}) => ([...approvalRules.values()]
        .find((item) => (
          (!where?.id || item.id === where.id)
          && (!where?.tenantId || item.tenantId === where.tenantId)
          && (!where?.department || item.department === where.department)
          && (!where?.templateId || item.templateId === where.templateId)
          && (where?.enabled === undefined || item.enabled === where.enabled)
        )) || null),
      upsert: async ({ where, update, create }) => {
        const identity = where.tenantId_department_templateId;
        const key = ruleKey(identity.tenantId, identity.department, identity.templateId);
        const existing = approvalRules.get(key);
        const next = {
          ...(existing || {
            id: `rule-${approvalRules.size + 1}`,
            tenantId: identity.tenantId,
            department: identity.department,
            templateId: identity.templateId
          }),
          ...(existing ? update : create)
        };
        approvalRules.set(key, next);
        return next;
      },
      update: async ({ where, data }) => {
        const existing = [...approvalRules.values()].find((item) => item.id === where.id);
        const next = { ...existing, ...data };
        approvalRules.delete(ruleKey(existing.tenantId, existing.department, existing.templateId));
        approvalRules.set(ruleKey(next.tenantId, next.department, next.templateId), next);
        return next;
      },
      delete: async ({ where }) => {
        const existing = [...approvalRules.values()].find((item) => item.id === where.id);
        if (!existing) return null;
        approvalRules.delete(ruleKey(existing.tenantId, existing.department, existing.templateId));
        return existing;
      }
    },
    workflowInstance: {
      findMany: async ({ where } = {}) => [...workflowInstances.values()]
        .filter((instance) => !where?.tenantId || instance.tenantId === where.tenantId)
        .map(workflowInstanceWithIncludes),
      findFirst: async ({ where } = {}) => {
        const instance = [...workflowInstances.values()].find((item) => (
          (!where?.id || item.id === where.id)
          && (!where?.tenantId || item.tenantId === where.tenantId)
          && (!where?.idempotencyKey || item.idempotencyKey === where.idempotencyKey)
          && (!where?.status || item.status === where.status)
        ));
        return workflowInstanceWithIncludes(instance);
      },
      update: async ({ where, data }) => {
        const existing = workflowInstances.get(where.id);
        const next = { ...existing, ...data };
        workflowInstances.set(where.id, next);
        return workflowInstanceWithIncludes(next);
      },
      create: async ({ data }) => {
        if (data.idempotencyKey && [...workflowInstances.values()].some((item) => (
          item.tenantId === data.tenantId && item.idempotencyKey === data.idempotencyKey
        ))) {
          const error = new Error("Unique constraint failed on workflow_instances_tenant_id_idempotency_key_key");
          error.code = "P2002";
          error.meta = { target: "workflow_instances_tenant_id_idempotency_key_key" };
          throw error;
        }
        const record = {
          id: `wf-${workflowInstances.size + 1}`,
          createdAt: new Date("2026-05-29T10:00:00.000Z"),
          updatedAt: new Date("2026-05-29T10:00:00.000Z"),
          ...data
        };
        workflowInstances.set(record.id, record);
        return { ...record };
      },
      updateMany: async ({ where, data }) => {
        let count = 0;
        for (const [id, instance] of workflowInstances.entries()) {
          if ((!where?.id || instance.id === where.id) && (!where?.tenantId || instance.tenantId === where.tenantId) && (!where?.status || instance.status === where.status)) {
            workflowInstances.set(id, { ...instance, ...data });
            count += 1;
          }
        }
        return { count };
      }
    },
    workflowInstanceNode: {
      create: async ({ data }) => {
        const record = {
          id: `node-${workflowNodes.size + 1}`,
          createdAt: new Date("2026-05-29T10:00:00.000Z"),
          updatedAt: new Date("2026-05-29T10:00:00.000Z"),
          ...data
        };
        workflowNodes.set(record.id, record);
        return { ...record };
      },
      update: async ({ where, data }) => {
        const existing = workflowNodes.get(where.id);
        const next = { ...existing, ...data };
        workflowNodes.set(where.id, next);
        return next;
      }
    },
    workflowApprover: {
      findUnique: async ({ where } = {}) => {
        const key = where?.tenantId_idempotencyKey;
        if (!key?.idempotencyKey) return null;
        return [...workflowApprovers.values()].find((item) => (
          item.tenantId === key.tenantId && item.idempotencyKey === key.idempotencyKey
        )) || null;
      },
      update: async ({ where, data }) => {
        const existing = workflowApprovers.get(where.id);
        const next = { ...existing, ...data };
        workflowApprovers.set(where.id, next);
        return next;
      },
      create: async ({ data }) => {
        const record = {
          id: `approver-${workflowApprovers.size + 1}`,
          createdAt: new Date("2026-05-29T10:00:00.000Z"),
          updatedAt: new Date("2026-05-29T10:00:00.000Z"),
          ...data
        };
        workflowApprovers.set(record.id, record);
        return record;
      },
      createMany: async ({ data }) => {
        for (const entry of data || []) {
          const record = {
            id: `approver-${workflowApprovers.size + 1}`,
            createdAt: new Date("2026-05-29T10:00:00.000Z"),
            updatedAt: new Date("2026-05-29T10:00:00.000Z"),
            ...entry
          };
          workflowApprovers.set(record.id, record);
        }
        return { count: data?.length || 0 };
      }
    },
    asset: {
      findMany: async ({ where } = {}) => [...assets.values()]
        .filter((asset) => !where?.tenantId || asset.tenantId === where.tenantId)
        .map((asset) => ({ ...asset })),
      findFirst: async ({ where } = {}) => {
        const asset = findAssetByWhere(where);
        return asset ? { ...asset } : null;
      },
      findUnique: async ({ where } = {}) => {
        const asset = findAssetByWhere(where);
        return asset ? { ...asset } : null;
      },
      count: async ({ where } = {}) => [...assets.values()].filter((asset) => (
        (!where?.tenantId || asset.tenantId === where.tenantId)
        && (!where?.assetNo?.startsWith || asset.assetNo.startsWith(where.assetNo.startsWith))
      )).length,
      create: async ({ data }) => {
        const record = {
          id: `asset-${assets.size + 1}`,
          qrVersion: 1,
          metadata: {},
          createdAt: new Date("2026-05-29T10:00:00.000Z"),
          updatedAt: new Date("2026-05-29T10:00:00.000Z"),
          ...data
        };
        assets.set(record.assetNo, record);
        return { ...record };
      },
      update: async ({ where, data }) => {
        const existing = findAssetByWhere(where);
        if (!existing) {
          const error = new Error("asset not found");
          error.code = "P2025";
          throw error;
        }
        const next = {
          ...existing,
          ...(data.owner !== undefined ? { owner: data.owner } : {}),
          ...(data.status !== undefined ? { status: data.status } : {}),
          ...(data.location !== undefined ? { location: data.location } : {}),
          ...(data.metadata !== undefined ? { metadata: data.metadata } : {}),
          ...(data.qrVersion?.increment ? { qrVersion: existing.qrVersion + data.qrVersion.increment } : {}),
          ...(data.qrVersion !== undefined && !data.qrVersion?.increment ? { qrVersion: data.qrVersion } : {}),
          updatedAt: new Date("2026-05-29T10:00:00.000Z")
        };
        assets.set(next.assetNo, next);
        return { ...next };
      }
    },
    fileObject: {
      findMany: async ({ where, take } = {}) => {
        const files = [...fileObjects.values()]
          .filter((file) => (
            (!where?.tenantId || file.tenantId === where.tenantId)
            && (!where?.workflowInstanceId || file.workflowInstanceId === where.workflowInstanceId)
            && (!where?.assetId || file.assetId === where.assetId)
          ))
          .map((file) => ({ ...file, uploader: file.uploaderUserId ? user : null }));
        return typeof take === "number" ? files.slice(0, take) : files;
      },
      findFirst: async ({ where } = {}) => {
        const file = [...fileObjects.values()].find((item) => (
          (!where?.id || item.id === where.id)
          && (!where?.tenantId || item.tenantId === where.tenantId)
          && (!where?.storageKey || item.storageKey === where.storageKey)
        )) || null;
        return file ? { ...file, uploader: file.uploaderUserId ? user : null } : null;
      },
      create: async ({ data }) => {
        const record = {
          id: `file-${fileObjects.size + 1}`,
          createdAt: new Date("2026-05-29T10:00:00.000Z"),
          ...data,
          uploader: data.uploaderUserId ? user : null
        };
        fileObjects.set(record.id, record);
        return { ...record };
      }
    },
    dataImportRun: {
      findMany: async ({ where, take } = {}) => {
        const rows = dataImportRuns
          .filter((run) => !where?.tenantId || run.tenantId === where.tenantId)
          .map((run) => ({ ...run, actor: run.actorUserId ? user : null }));
        return typeof take === "number" ? rows.slice(0, take) : rows;
      },
      findFirst: async ({ where } = {}) => dataImportRuns.find((run) => (
        (!where?.tenantId || run.tenantId === where.tenantId)
        && (!where?.id || run.id === where.id)
        && (!where?.sourceName || run.sourceName === where.sourceName)
        && (!where?.sourceChecksum || run.sourceChecksum === where.sourceChecksum)
        && (!where?.status || run.status === where.status)
      )) || null,
      create: async ({ data }) => {
        const record = {
          id: `import-${dataImportRuns.length + 1}`,
          createdAt: new Date("2026-05-29T10:00:00.000Z"),
          startedAt: new Date("2026-05-29T10:00:00.000Z"),
          ...data,
          actor: data.actorUserId ? user : null
        };
        dataImportRuns.unshift(record);
        return { ...record };
      },
      update: async ({ where, data }) => {
        const index = dataImportRuns.findIndex((run) => run.id === where.id);
        const next = { ...dataImportRuns[index], ...data };
        dataImportRuns[index] = next;
        return { ...next };
      }
    },
    leaveRequest: {
      findMany: async ({ where } = {}) => [...leaveRequests.values()]
        .filter((leave) => (
          (!where?.tenantId || leave.tenantId === where.tenantId)
          && (!where?.status || leave.status === where.status)
        ))
        .map((leave) => ({ ...leave })),
      findFirst: async ({ where } = {}) => [...leaveRequests.values()].find((leave) => (
        (!where?.tenantId || leave.tenantId === where.tenantId)
        && (!where?.employeeName || leave.employeeName === where.employeeName)
        && (!where?.leaveType || leave.leaveType === where.leaveType)
        && (!where?.dateRange || leave.dateRange === where.dateRange)
        && (!where?.workflowInstanceId || leave.workflowInstanceId === where.workflowInstanceId)
      )) || null,
      create: async ({ data }) => {
        const record = {
          id: `leave-${leaveRequests.size + 1}`,
          createdAt: new Date("2026-05-29T10:00:00.000Z"),
          updatedAt: new Date("2026-05-29T10:00:00.000Z"),
          ...data
        };
        leaveRequests.set(record.id, record);
        return { ...record };
      },
      updateMany: async ({ where, data }) => {
        let count = 0;
        for (const [id, leave] of leaveRequests.entries()) {
          if ((!where?.tenantId || leave.tenantId === where.tenantId) && (!where?.workflowInstanceId || leave.workflowInstanceId === where.workflowInstanceId) && (!where?.status || leave.status === where.status)) {
            leaveRequests.set(id, { ...leave, ...data });
            count += 1;
          }
        }
        return { count };
      }
    },
    attendanceRecord: {
      findMany: async ({ where, take } = {}) => {
        const rows = [...attendanceRecords.values()]
          .filter((record) => (
            (!where?.tenantId || record.tenantId === where.tenantId)
            && (!where?.status || record.status === where.status)
            && (!where?.department || record.department === where.department)
            && (!where?.employeeName?.contains || record.employeeName.includes(where.employeeName.contains))
            && (!where?.workDate?.gte || record.workDate >= where.workDate.gte)
            && (!where?.workDate?.lte || record.workDate <= where.workDate.lte)
          ))
          .sort((a, b) => b.workDate - a.workDate)
          .map((record) => ({ ...record }));
        return typeof take === "number" ? rows.slice(0, take) : rows;
      },
      create: async ({ data }) => {
        const record = {
          id: `attendance-${attendanceRecords.size + 1}`,
          minutesLate: 0,
          source: "manual",
          metadata: {},
          createdAt: new Date("2026-05-29T10:00:00.000Z"),
          updatedAt: new Date("2026-05-29T10:00:00.000Z"),
          ...data
        };
        attendanceRecords.set(record.id, record);
        return { ...record };
      }
    },
    financeRequest: {
      count: async ({ where } = {}) => [...financeRequests.values()].filter((request) => (
        (!where?.tenantId || request.tenantId === where.tenantId)
        && (!where?.requestNo?.startsWith || request.requestNo.startsWith(where.requestNo.startsWith))
      )).length,
      findMany: async ({ where, take } = {}) => {
        const rows = [...financeRequests.values()]
          .filter((request) => (
            (!where?.tenantId || request.tenantId === where.tenantId)
            && (!where?.requestType || request.requestType === where.requestType)
            && (!where?.status || request.status === where.status)
          ))
          .sort((a, b) => b.createdAt - a.createdAt)
          .map((request) => ({
            ...request,
            applicant: request.applicantUserId ? user : null,
            workflowInstance: request.workflowInstanceId ? workflowInstances.get(request.workflowInstanceId) : null
          }));
        return typeof take === "number" ? rows.slice(0, take) : rows;
      },
      findFirst: async ({ where } = {}) => {
        const request = [...financeRequests.values()].find((item) => (
          (!where?.tenantId || item.tenantId === where.tenantId)
          && (!where?.requestNo || item.requestNo === where.requestNo)
          && (!where?.workflowInstanceId || item.workflowInstanceId === where.workflowInstanceId)
        )) || null;
        return request ? {
          ...request,
          applicant: request.applicantUserId ? user : null,
          workflowInstance: request.workflowInstanceId ? workflowInstances.get(request.workflowInstanceId) : null
        } : null;
      },
      create: async ({ data, include } = {}) => {
        const record = {
          id: `finance-request-${financeRequests.size + 1}`,
          currency: "CNY",
          metadata: {},
          createdAt: new Date("2026-05-29T10:00:00.000Z"),
          updatedAt: new Date("2026-05-29T10:00:00.000Z"),
          ...data
        };
        financeRequests.set(record.requestNo, record);
        return {
          ...record,
          ...(include?.applicant ? { applicant: record.applicantUserId ? user : null } : {}),
          ...(include?.workflowInstance ? { workflowInstance: record.workflowInstanceId ? workflowInstances.get(record.workflowInstanceId) : null } : {})
        };
      },
      updateMany: async ({ where, data }) => {
        let count = 0;
        for (const [requestNo, request] of financeRequests.entries()) {
          if ((!where?.tenantId || request.tenantId === where.tenantId) && (!where?.workflowInstanceId || request.workflowInstanceId === where.workflowInstanceId)) {
            financeRequests.set(requestNo, { ...request, ...data, updatedAt: new Date("2026-05-29T10:00:00.000Z") });
            count += 1;
          }
        }
        return { count };
      }
    },
    payrollBatch: {
      findMany: async ({ where } = {}) => [...payrollBatches.values()]
        .filter((payroll) => !where?.tenantId || payroll.tenantId === where.tenantId)
        .map((payroll) => ({ ...payroll, reviewer: payroll.reviewerUserId ? user : null, workflowInstance: payroll.workflowInstanceId ? workflowInstances.get(payroll.workflowInstanceId) : null })),
      findFirst: async ({ where } = {}) => {
        const payroll = [...payrollBatches.values()].find((item) => (
          (!where?.tenantId || item.tenantId === where.tenantId)
          && (!where?.batchNo || item.batchNo === where.batchNo)
          && (!where?.workflowInstanceId || item.workflowInstanceId === where.workflowInstanceId)
        )) || null;
        return payroll ? { ...payroll, workflowInstance: payroll.workflowInstanceId ? workflowInstances.get(payroll.workflowInstanceId) : null } : null;
      },
      create: async ({ data, include } = {}) => {
        const record = {
          id: `payroll-${payrollBatches.size + 1}`,
          createdAt: new Date("2026-05-29T10:00:00.000Z"),
          updatedAt: new Date("2026-05-29T10:00:00.000Z"),
          ...data
        };
        payrollBatches.set(record.batchNo, record);
        return {
          ...record,
          ...(include?.reviewer ? { reviewer: record.reviewerUserId ? user : null } : {}),
          ...(include?.workflowInstance ? { workflowInstance: record.workflowInstanceId ? workflowInstances.get(record.workflowInstanceId) : null } : {})
        };
      },
      upsert: async ({ where, update, create }) => {
        const key = where.tenantId_batchNo.batchNo;
        const existing = payrollBatches.get(key);
        const record = {
          ...(existing || { id: `payroll-${payrollBatches.size + 1}`, tenantId: where.tenantId_batchNo.tenantId, batchNo: key }),
          ...(existing ? update : create)
        };
        payrollBatches.set(key, record);
        return { ...record };
      },
      update: async ({ where, data, include } = {}) => {
        const key = where.tenantId_batchNo.batchNo;
        const existing = payrollBatches.get(key);
        const record = { ...existing, ...data, updatedAt: new Date("2026-05-29T10:00:00.000Z") };
        payrollBatches.set(key, record);
        return {
          ...record,
          ...(include?.reviewer ? { reviewer: record.reviewerUserId ? user : null } : {}),
          ...(include?.workflowInstance ? { workflowInstance: record.workflowInstanceId ? workflowInstances.get(record.workflowInstanceId) : null } : {})
        };
      }
    },
    resource: {
      findMany: async ({ where } = {}) => resources.filter((resource) => !where?.tenantId || resource.tenantId === where.tenantId),
      findFirst: async ({ where } = {}) => resources.find((resource) => (
        (!where?.tenantId || resource.tenantId === where.tenantId)
        && (!where?.name || resource.name === where.name)
        && (!where?.id || resource.id === where.id)
      )) || null
    },
    booking: {
      findMany: async ({ where } = {}) => bookings
        .filter((booking) => matchesBookingWhere(booking, where))
        .map((booking) => ({ ...booking, resource: resources.find((resource) => resource.id === booking.resourceId) })),
      findFirst: async ({ where } = {}) => bookings.find((booking) => matchesBookingWhere(booking, where)) || null,
      create: async ({ data, include } = {}) => {
        const booking = {
          id: `booking-${bookings.length + 1}`,
          createdAt: new Date("2026-05-29T10:00:00.000Z"),
          updatedAt: new Date("2026-05-29T10:00:00.000Z"),
          ...data
        };
        bookings.unshift(booking);
        return include?.resource
          ? { ...booking, resource: resources.find((resource) => resource.id === booking.resourceId) }
          : booking;
      },
      update: async ({ where, data, include } = {}) => {
        const index = bookings.findIndex((booking) => booking.id === where.id);
        if (index < 0) {
          const error = new Error("booking not found");
          error.code = "P2025";
          throw error;
        }
        const next = {
          ...bookings[index],
          ...(data.status !== undefined ? { status: data.status } : {}),
          ...(data.metadata !== undefined ? { metadata: data.metadata } : {}),
          updatedAt: new Date("2026-05-29T10:00:00.000Z")
        };
        bookings[index] = next;
        return include?.resource
          ? { ...next, resource: resources.find((resource) => resource.id === next.resourceId) }
          : { ...next };
      }
    },
    workflowDefinition: {
      findMany: async () => [...workflowDefinitions.values()],
      findFirst: async ({ where } = {}) => [...workflowDefinitions.values()].find((definition) => (
        (!where?.tenantId || definition.tenantId === where.tenantId)
        && (!where?.status || definition.status === where.status)
        && (!where?.OR || where.OR.some((item) => item.id === definition.id || item.code === definition.code))
      )) || null
    },
    $queryRaw: async () => [{ "?column?": 1 }],
    $queryRawUnsafe: async (query) => {
      if (String(query).includes("pg_trigger")) {
        return (options.appendOnlyTriggers || [
          "audit_logs_prevent_delete",
          "audit_logs_prevent_update",
          "data_import_runs_prevent_delete",
          "data_import_runs_prevent_update",
          "export_records_prevent_delete",
          "export_records_prevent_update"
        ]).map((tgname) => ({ tgname }));
      }
      return [{ "?column?": 1 }];
    },
    $executeRaw: async () => 1,
    $transaction: async (work) => work(prisma),
    $disconnect: async () => {}
  };
  return prisma;
}

async function loginHeaders(app) {
  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: {
      tenantCode: "default",
      email: "admin@oa.local",
      password: "admin123456"
    }
  });
  return { authorization: `Bearer ${login.json().token}` };
}

async function approveWorkflow(app, headers, workflowId, approvers, prefix = "approve") {
  for (const [index, approverName] of approvers.entries()) {
    const response = await app.inject({
      method: "POST",
      url: `/api/approvals/${workflowId}/decision`,
      headers,
      payload: {
        approverName,
        decision: "pass",
        idempotencyKey: `${prefix}-${workflowId}-${index + 1}`
      }
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().ok, true);
  }
}

function oneStepLifecycleDefinition(id, code, name) {
  return {
    id,
    code,
    name,
    category: "组织人事",
    formSchema: { fields: [] },
    nodes: [
      { id: `${id}-node-1`, name: `${name}审批`, stepOrder: 1, approvalMode: "AND", approverRule: { approvers: ["张三"] } }
    ]
  };
}

test("health endpoint is public", async () => {
  const app = await buildApp({
    logger: false,
    prisma: await makePrismaMock(),
    config: { jwtSecret: "test-secret" }
  });

  const response = await app.inject({ method: "GET", url: "/health" });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().ok, true);

  await app.close();
});

test("openapi contract is public and covers commercial modules", async () => {
  const app = await buildApp({
    logger: false,
    prisma: await makePrismaMock(),
    config: { jwtSecret: "test-secret" }
  });

  const response = await app.inject({ method: "GET", url: "/api/openapi.json" });
  assert.equal(response.statusCode, 200);
  const doc = response.json();
  assert.equal(doc.openapi, "3.1.0");
  assert.equal(doc.info.title, "集团人事行政 OA Commercial API");
  assert.ok(doc.components.securitySchemes.bearerAuth);
  assert.ok(doc.components.securitySchemes.sessionCookie);
  [
    "/auth/login",
    "/auth/change-password",
    "/people",
    "/people/employees/{id}",
    "/approvals",
    "/approvals/{id}/decision",
    "/approvals/rules/preview",
    "/attendance/leaves",
    "/attendance/records/export",
    "/finance/requests/export",
    "/finance/payrolls",
    "/assets/{id}/actions",
    "/resources/bookings/export",
    "/resources/bookings/{id}/cancel",
    "/files/{id}/download",
    "/imports/dashboard-html",
    "/iam",
    "/iam/users",
    "/iam/users/{id}/password",
    "/iam/users/{id}/status",
    "/audit/export",
    "/audit/integrity",
    "/analytics/overview",
    "/analytics/export",
    "/system/readiness"
  ].forEach((path) => assert.ok(doc.paths[path], `OpenAPI path missing: ${path}`));
  assert.equal(doc.paths["/auth/login"].post.security, undefined);
  assert.deepEqual(doc.paths["/people"].get.security, [{ bearerAuth: [] }, { sessionCookie: [] }]);
  assert.equal(
    doc.paths["/audit/integrity"].get.responses["200"].content["application/json"].schema.$ref,
    "#/components/schemas/AuditIntegrityResponse"
  );
  assert.equal(doc.paths["/audit/integrity"].get.parameters[0].schema.maximum, 5000);
  assert.deepEqual(
    doc.components.schemas.AuditIntegrityResponse.required,
    ["ok", "errors", "warnings", "summary"]
  );
  assert.equal(doc.components.schemas.AuditIntegrityResponse.properties.summary.properties.lastHash.pattern, "^[a-f0-9]{64}$");

  await app.close();
});

test("api responses include commercial security and trace headers", async () => {
  const app = await buildApp({
    logger: false,
    prisma: await makePrismaMock(),
    config: {
      isProduction: true,
      jwtSecret: "test-secret-with-at-least-32-characters",
      webOrigin: ["https://oa.company.cn"],
      fileStorageDir: productionFileStorageDir
    }
  });

  const response = await app.inject({ method: "GET", url: "/api/health" });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["x-content-type-options"], "nosniff");
  assert.equal(response.headers["x-frame-options"], "DENY");
  assert.equal(response.headers["referrer-policy"], "no-referrer");
  assert.equal(response.headers["permissions-policy"], "camera=(), microphone=(), geolocation=()");
  assert.equal(response.headers["cross-origin-resource-policy"], "same-site");
  assert.equal(response.headers["x-permitted-cross-domain-policies"], "none");
  assert.equal(response.headers["cache-control"], "no-store");
  assert.match(response.headers["strict-transport-security"], /max-age=15552000/);
  assert.match(response.headers["x-request-id"], /req-/);

  await app.close();
});

test("fastify request body limit follows runtime config", async () => {
  const app = await buildApp({
    logger: false,
    prisma: await makePrismaMock(),
    config: {
      apiBodyLimitBytes: 2 * 1024 * 1024,
      fileMaxUploadBytes: 512 * 1024,
      importMaxHtmlBytes: 512 * 1024,
      jwtSecret: "test-secret"
    }
  });

  assert.equal(app.initialConfig.bodyLimit, 2 * 1024 * 1024);

  await app.close();
});

test("ready endpoint verifies database connectivity", async () => {
  const fileStorageDir = await mkdtemp(join(tmpdir(), "deep-oa-ready-files-"));
  const app = await buildApp({
    logger: false,
    prisma: await makePrismaMock(),
    config: { fileStorageDir, jwtSecret: "test-secret" }
  });

  try {
    const response = await app.inject({ method: "GET", url: "/ready" });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().database, "ok");
    assert.equal(response.json().databaseIntegrity, "ok");
    assert.equal(response.json().fileStorage, "ok");
  } finally {
    await app.close();
    await rm(fileStorageDir, { recursive: true, force: true });
  }
});

test("ready endpoint verifies configured object storage adapter", async () => {
  let probeCount = 0;
  const app = await buildApp({
    logger: false,
    prisma: await makePrismaMock(),
    config: {
      fileStorageDriver: "s3",
      jwtSecret: "test-secret",
      objectStorage: {
        accessKeyId: "AKIAREALACCESS",
        bucket: "oa-prod-files",
        endpoint: "https://s3.company.test",
        prefix: "test",
        region: "cn-east-1",
        secretAccessKey: "object-secret-at-least-16"
      }
    },
    fileStorage: {
      driver: "s3",
      describe: () => ({ driver: "s3", bucket: "oa-prod-files" }),
      probe: async () => {
        probeCount += 1;
      }
    }
  });

  const response = await app.inject({ method: "GET", url: "/ready" });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().databaseIntegrity, "ok");
  assert.equal(response.json().fileStorage, "ok");
  assert.equal(probeCount, 1);

  await app.close();
});

test("ready endpoint returns 503 when file storage is not writable", async () => {
  const root = await mkdtemp(join(tmpdir(), "deep-oa-ready-files-"));
  const fileStorageDir = join(root, "not-a-directory");
  await writeFile(fileStorageDir, "blocks mkdir");
  const app = await buildApp({
    logger: false,
    prisma: await makePrismaMock(),
    config: { fileStorageDir, jwtSecret: "test-secret" }
  });

  try {
    const response = await app.inject({ method: "GET", url: "/ready" });
    assert.equal(response.statusCode, 503);
    assert.equal(response.json().database, "ok");
    assert.equal(response.json().databaseIntegrity, "ok");
    assert.equal(response.json().fileStorage, "unavailable");
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("ready endpoint returns 503 when database check fails", async () => {
  const fileStorageDir = await mkdtemp(join(tmpdir(), "deep-oa-ready-files-"));
  const prisma = await makePrismaMock();
  prisma.$queryRaw = async () => {
    throw new Error("database down");
  };
  const app = await buildApp({
    logger: false,
    prisma,
    config: { fileStorageDir, jwtSecret: "test-secret" }
  });

  try {
    const response = await app.inject({ method: "GET", url: "/ready" });
    assert.equal(response.statusCode, 503);
    assert.equal(response.json().database, "unavailable");
    assert.equal(response.json().databaseIntegrity, "unavailable");
    assert.equal(response.json().fileStorage, "ok");
  } finally {
    await app.close();
    await rm(fileStorageDir, { recursive: true, force: true });
  }
});

test("ready endpoint returns 503 when append-only trigger integrity is missing", async () => {
  const fileStorageDir = await mkdtemp(join(tmpdir(), "deep-oa-ready-files-"));
  const app = await buildApp({
    logger: false,
    prisma: await makePrismaMock({
      appendOnlyTriggers: [
        "audit_logs_prevent_delete",
        "audit_logs_prevent_update",
        "export_records_prevent_delete",
        "export_records_prevent_update"
      ]
    }),
    config: { fileStorageDir, jwtSecret: "test-secret" }
  });

  try {
    const response = await app.inject({ method: "GET", url: "/ready" });
    assert.equal(response.statusCode, 503);
    assert.equal(response.json().database, "ok");
    assert.equal(response.json().databaseIntegrity, "unavailable");
    assert.equal(response.json().fileStorage, "ok");
  } finally {
    await app.close();
    await rm(fileStorageDir, { recursive: true, force: true });
  }
});

test("system readiness API requires admin permission and redacts runtime secrets", async () => {
  const fileStorageDir = await mkdtemp(join(tmpdir(), "deep-oa-system-ready-files-"));
  const app = await buildApp({
    logger: false,
    prisma: await makePrismaMock(),
    config: {
      fileStorageDir,
      jwtSecret: "test-secret",
      webOrigin: ["https://oa.example.com"]
    }
  });
  const headers = await loginHeaders(app);

  try {
    const response = await app.inject({ method: "GET", url: "/api/system/readiness", headers });
    assert.equal(response.statusCode, 200);
    const readiness = response.json().systemReadiness;
    assert.equal(readiness.dependencies.database, "ok");
    assert.equal(readiness.dependencies.databaseIntegrity, "ok");
    assert.equal(readiness.dependencies.fileStorage, "ok");
    assert.equal(readiness.runtime.webOriginCount, 1);
    assert.equal(readiness.runtime.fileStorageConfigured, true);
    assert.equal(readiness.releaseGate.releaseReady, false);
    assert.ok(readiness.releaseGate.blockers.includes("当前不是 production 运行环境"));
    assert.ok(readiness.knownGaps.some((gap) => gap.id === "GAP-001" && gap.status === "Mitigated"));
    assert.equal(Array.isArray(readiness.closurePlan), true);
    assert.ok(readiness.closurePlan.some((item) => item.id === "GAP-002" && item.category === "Docker 恢复演练"));
    assert.equal(typeof readiness.closurePlan.find((item) => item.id === "GAP-002")?.releaseBlocking, "boolean");
    assert.equal(Array.isArray(readiness.ownerEvidenceChecklist), true);
    assert.ok(readiness.ownerEvidenceChecklist.some((item) => item.id === "GAP-003" && item.owner === "Security lead"));
    assert.equal(typeof readiness.ownerEvidenceChecklist.find((item) => item.id === "GAP-003")?.missingArtifactCount, "number");
    assert.equal(typeof readiness.latestEvidence.available, "boolean");
    assert.equal(typeof readiness.latestEvidence.evidenceMode, "string");
    assert.equal(typeof readiness.latestEvidence.e2eIncluded, "boolean");
    assert.equal(typeof readiness.latestEvidence.releaseBlockerCount, "number");
    assert.equal(typeof readiness.latestEvidence.releaseCandidateReady, "boolean");
    assert.equal(typeof readiness.latestEvidence.artifactSummary.missingReleaseArtifactCount, "number");
    assert.equal(Array.isArray(readiness.latestEvidence.artifactSummary.items), true);
    assert.equal(readiness.latestEvidence.releaseEvidence, false);
    assert.equal(Array.isArray(readiness.latestEvidence.checks), true);
    assert.equal(typeof readiness.latestEvidence.targetProfile.evidenceClass, "string");
    assert.equal(typeof readiness.gapActionReport.available, "boolean");
    assert.equal(readiness.gapActionReport.releaseEvidence, false);
    assert.equal(Array.isArray(readiness.gapActionReport.owners), true);
    if (readiness.gapActionReport.available) {
      assert.equal(readiness.gapActionReport.blockedGapCount >= 0, true);
      assert.equal(readiness.gapActionReport.ownerCount >= 0, true);
      assert.ok(readiness.releaseGate.warnings.some((warning) => warning.includes("GAP 责任人闭环报告仅用于动作分派")));
    }
    assert.equal(typeof readiness.hrDataReview.available, "boolean");
    assert.equal(readiness.hrDataReview.releaseEvidence, false);
    assert.equal(typeof readiness.hrDataReview.noSensitiveFields, "boolean");
    if (readiness.hrDataReview.available) {
      assert.equal(readiness.hrDataReview.counts.activeEmployees, 72);
      assert.equal(readiness.hrDataReview.counts.leavers, 162);
      assert.equal(readiness.hrDataReview.rowCount, 234);
      assert.ok(readiness.releaseGate.warnings.some((warning) => warning.includes("HR 脱敏审阅包仅用于签收前复核")));
    }
    assert.equal(typeof readiness.signoffDrafts.available, "boolean");
    assert.equal(readiness.signoffDrafts.releaseEvidence, false);
    assert.equal(Array.isArray(readiness.signoffDrafts.kinds), true);
    if (readiness.signoffDrafts.available) {
      assert.equal(readiness.signoffDrafts.draftCount, 3);
      assert.ok(readiness.signoffDrafts.kinds.some((item) => item.id === "hr"));
      assert.ok(readiness.releaseGate.warnings.some((warning) => warning.includes("签署草稿仅用于复核准备")));
    }
    assert.doesNotMatch(
      JSON.stringify(readiness),
      /test-secret|admin123456|oa\.example\.com|deep-oa-system-ready-files|reports\/commercial-evidence|latest\.json|latest-gap-report|signoff-drafts|hr-data-review|people-review|summary\.json|manifest\.json|\.draft\.json|postgresql:\/\/|DATABASE_URL/
    );
  } finally {
    await app.close();
    await rm(fileStorageDir, { recursive: true, force: true });
  }
});

test("system readiness API rejects accounts without system admin permission", async () => {
  const app = await buildApp({
    logger: false,
    prisma: await makePrismaMock({ permissionCodes: ["employee.read"] }),
    config: { jwtSecret: "test-secret" }
  });
  const headers = await loginHeaders(app);

  const response = await app.inject({ method: "GET", url: "/api/system/readiness", headers });
  assert.equal(response.statusCode, 403);
  assert.equal(response.json().error, "PERMISSION_DENIED");

  await app.close();
});

test("authenticated business APIs expose people approvals assets resources and audit payloads", async () => {
  const app = await buildApp({
    logger: false,
    prisma: await makePrismaMock(),
    config: { jwtSecret: "test-secret" }
  });

  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: {
      tenantCode: "default",
      email: "admin@oa.local",
      password: "admin123456"
    }
  });
  const headers = { authorization: `Bearer ${login.json().token}` };

  const people = await app.inject({ method: "GET", url: "/api/people", headers });
  assert.equal(people.statusCode, 200);
  assert.equal(people.json().people.employees.length, 1);
  assert.equal(people.json().people.employees[0].school, "示例***");

  const analytics = await app.inject({ method: "GET", url: "/api/analytics/overview", headers });
  assert.equal(analytics.statusCode, 200);
  assert.equal(analytics.json().analytics.cards.totalPeople, 1);
  assert.equal(analytics.json().analytics.peopleByDepartment[0].label, "行政部");
  assert.equal(analytics.json().analytics.riskApprovals[0].title, "待审批费用报销");

  const definitions = await app.inject({ method: "GET", url: "/api/approvals/definitions", headers });
  assert.equal(definitions.statusCode, 200);
  assert.equal(definitions.json().workflowDefinitions.some((item) => item.code === "HR-TRANSFER" && item.templateId === "transfer"), true);

  const rules = await app.inject({ method: "GET", url: "/api/approvals/rules", headers });
  assert.equal(rules.statusCode, 200);
  assert.equal(rules.json().approvalRules[0].nodes[0].approvers.length, 2);

  const assets = await app.inject({ method: "GET", url: "/api/assets", headers });
  assert.equal(assets.statusCode, 200);
  assert.equal(assets.json().assets[0].status, "借用中");
  assert.match(assets.json().assets[0].qrImage, /^data:image\/png;base64,/);
  assert.equal(JSON.parse(assets.json().assets[0].qrPayload).assetNo, "IT-2024-000123");

  const resources = await app.inject({ method: "GET", url: "/api/resources", headers });
  assert.equal(resources.statusCode, 200);
  assert.equal(resources.json().resources[0].name, "一号会议室");

  const imports = await app.inject({ method: "GET", url: "/api/imports", headers });
  assert.equal(imports.statusCode, 200);
  assert.equal(imports.json().importRuns[0].sourceName, "oa-dashboard.html");
  assert.equal(imports.json().importRuns[0].recordCounts.totalRows, 234);
  assert.ok(imports.json().importRuns[0].sourceChecksum);

  const audit = await app.inject({ method: "GET", url: "/api/audit", headers });
  assert.equal(audit.statusCode, 200);
  assert.equal(audit.json().auditLogs[0].operator, "系统管理员");

  await app.close();
});

test("approval list lookup is tenant-scoped for applicant and department names", async () => {
  const userLookupCalls = [];
  const departmentLookupCalls = [];
  const app = await buildApp({
    logger: false,
    prisma: await makePrismaMock({
      onUserFindMany: (call) => userLookupCalls.push(call),
      onDepartmentFindMany: (call) => departmentLookupCalls.push(call)
    }),
    config: { jwtSecret: "test-secret" }
  });
  const headers = await loginHeaders(app);

  const response = await app.inject({ method: "GET", url: "/api/approvals", headers });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().approvals[0].applicant, "系统管理员");

  const applicantLookup = userLookupCalls.find((call) => call.where?.id?.in?.includes("user-admin"));
  const departmentLookup = departmentLookupCalls.find((call) => call.where?.id?.in?.includes("dept-admin"));
  assert.equal(applicantLookup?.where?.tenantId, "tenant-default");
  assert.equal(departmentLookup?.where?.tenantId, "tenant-default");

  await app.close();
});

test("analytics export returns backend CSV with formula escaping and audit row", async () => {
  const app = await buildApp({
    logger: false,
    prisma: await makePrismaMock({
      permissionCodes: ["analytics.read", "analytics.export", "audit.read"],
      departments: [
        { id: "dept-risk", tenantId: "tenant-default", code: "RISK", name: " =HYPERLINK(\"https://example.invalid\",\"open\")" }
      ],
      employees: [
        {
          id: "emp-risk",
          employeeNo: "EMP-RISK",
          name: "风险部门员工",
          departmentId: "dept-risk",
          status: "ACTIVE"
        }
      ]
    }),
    config: { jwtSecret: "test-secret" }
  });
  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: {
      tenantCode: "default",
      email: "admin@oa.local",
      password: "admin123456"
    }
  });
  const headers = { authorization: `Bearer ${login.json().token}` };

  const response = await app.inject({
    method: "POST",
    url: "/api/analytics/export",
    headers,
    payload: { businessReason: "管理层月度复盘", scope: "管理看板快照" }
  });

  assert.equal(response.statusCode, 200);
  assert.match(response.headers["content-type"], /text\/csv/);
  assert.match(response.headers["content-disposition"], /analytics-snapshot-/);
  assert.ok(Number(response.headers["x-row-count"]) > 10);
  assert.match(response.body, /"板块","指标","数值","说明"/);
  assert.match(response.body, /"概览指标","人员总量","2","导入与后端员工表合计"/);
  assert.match(response.body, /"人员部门分布","' =HYPERLINK\(""https:\/\/example.invalid"",""open""\)","1","在职员工"/);

  const audit = await app.inject({ method: "GET", url: "/api/audit?action=analytics.export", headers });
  assert.equal(audit.statusCode, 200);
  assert.equal(audit.json().auditLogs[0].content, "导出管理看板快照，后端生成管理看板快照");
  assert.equal(audit.json().auditLogs[0].object, "analytics_snapshot");
  assert.equal(audit.json().exportRecords.some((item) => item.action === "analytics.export" && item.businessReason === "管理层月度复盘"), true);

  await app.close();
});

test("CSV exports require a business reason before generating files", async () => {
  const app = await buildApp({
    logger: false,
    prisma: await makePrismaMock({ permissionCodes: ["analytics.read", "analytics.export"] }),
    config: { jwtSecret: "test-secret" }
  });
  const headers = await loginHeaders(app);

  const response = await app.inject({
    method: "POST",
    url: "/api/analytics/export",
    headers,
    payload: { scope: "管理看板快照" }
  });

  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error, "EXPORT_BUSINESS_REASON_REQUIRED");

  await app.close();
});

test("analytics export requires explicit export permission", async () => {
  const app = await buildApp({
    logger: false,
    prisma: await makePrismaMock({ permissionCodes: ["analytics.read"] }),
    config: { jwtSecret: "test-secret" }
  });
  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: {
      tenantCode: "default",
      email: "admin@oa.local",
      password: "admin123456"
    }
  });
  const headers = { authorization: `Bearer ${login.json().token}` };

  const response = await app.inject({
    method: "POST",
    url: "/api/analytics/export",
    headers,
    payload: { businessReason: "管理层月度复盘", scope: "管理看板快照" }
  });

  assert.equal(response.statusCode, 403);
  await app.close();
});

test("people sensitive reveal requires permission and audits denied attempts", async () => {
  const app = await buildApp({
    logger: false,
    prisma: await makePrismaMock({ permissionCodes: ["employee.read", "audit.read"] }),
    config: { jwtSecret: "test-secret" }
  });
  const headers = await loginHeaders(app);

  const response = await app.inject({
    method: "GET",
    url: "/api/people?revealSensitive=true",
    headers
  });
  assert.equal(response.statusCode, 403);
  assert.equal(response.json().error, "employee_sensitive_denied");

  const audit = await app.inject({ method: "GET", url: "/api/audit", headers });
  assert.equal(audit.json().auditLogs.some((item) => item.content.includes("敏感字段查看被拒绝")), true);

  await app.close();
});

test("people sensitive reveal returns unmasked fields only after permission and writes audit", async () => {
  const app = await buildApp({
    logger: false,
    prisma: await makePrismaMock({ permissionCodes: ["employee.read", "employee.sensitive.read", "audit.read"] }),
    config: { jwtSecret: "test-secret" }
  });
  const headers = await loginHeaders(app);

  const response = await app.inject({
    method: "GET",
    url: "/api/people?revealSensitive=true",
    headers
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().people.employees[0].school, "示例大学");
  assert.equal(response.json().people.employees[0].hukou, "广东/城镇");

  const logs = await app.prisma.auditLog.findMany({
    where: { action: "employee.sensitive.reveal" },
    take: 1
  });
  assert.equal(logs[0].summary, "查看人员敏感字段");
  assert.equal(logs[0].metadata.returnedRows, 1);

  await app.close();
});

test("people lifecycle summary exposes safe status without sensitive metadata", async () => {
  const app = await buildApp({
    logger: false,
    prisma: await makePrismaMock({
      permissionCodes: ["employee.read", "employee.sensitive.read", "audit.read"],
      employees: [{
        id: "emp-1",
        tenantId: "tenant-default",
        employeeNo: "EMP-1",
        name: "张三",
        gender: "男",
        departmentId: "dept-admin",
        roleTitle: "行政主管",
        status: "ACTIVE",
        entryDate: new Date("2026-05-01T00:00:00.000Z"),
        leaveDate: null,
        sensitiveInfo: {
          org: "集团总部",
          age: "30.0",
          hukou: "广东/城镇",
          education: "本科",
          school: "示例大学",
          major: "行政管理",
          salaryAdjustment: {
            effectiveDate: "2026-07-01",
            reasonType: "晋升",
            hasAmount: true,
            adjustAmount: "5000"
          },
          lifecycleHistory: [{
            action: "salary_adjustment",
            definitionCode: "HR-SALARY",
            workflowInstanceId: "wf-salary-1",
            effectiveDate: "2026-07-01",
            approvedAt: "2026-06-20T08:00:00.000Z",
            reasonType: "晋升",
            adjustAmount: "5000",
            bankCard: "6222000000000000"
          }]
        }
      }]
    }),
    config: { jwtSecret: "test-secret" }
  });
  const headers = await loginHeaders(app);

  const response = await app.inject({
    method: "GET",
    url: "/api/people?revealSensitive=true",
    headers
  });

  assert.equal(response.statusCode, 200);
  const employee = response.json().people.employees.find((item) => item.name === "张三");
  assert.deepEqual(employee.lifecycleSummary, {
    action: "salary_adjustment",
    label: "调薪",
    definitionCode: "HR-SALARY",
    effectiveDate: "2026-07-01",
    approvedAt: "2026-06-20T08:00:00.000Z",
    detail: "调薪原因：晋升",
    status: "已同步"
  });
  assert.doesNotMatch(JSON.stringify(employee), /5000|6222000000000000|adjustAmount|bankCard/);

  await app.close();
});

test("HR lifecycle transfer workflow submits with department rule snapshot", async () => {
  const app = await buildApp({
    logger: false,
    prisma: await makePrismaMock({ permissionCodes: ["workflow.read", "workflow.write", "audit.read"] }),
    config: { jwtSecret: "test-secret" }
  });
  const headers = await loginHeaders(app);

  const response = await app.inject({
    method: "POST",
    url: "/api/approvals",
    headers,
    payload: {
      definitionId: "transfer",
      title: "周八调岗申请",
      department: "行政部",
      formData: {
        employee: "周八",
        fromDepartment: "直播事业部",
        toDepartment: "运营中心"
      }
    }
  });

  assert.equal(response.statusCode, 201);
  assert.equal(response.json().approval.definitionCode, "HR-TRANSFER");
  assert.equal(response.json().approval.definitionId, "transfer");
  assert.equal(response.json().approval.amount, "周八");
  assert.equal(response.json().approval.node, "调出部门审批");
  assert.deepEqual(
    response.json().approval.approvalNodes[0].decisions.map((item) => item.approver),
    ["张三", "李四"]
  );
  assert.equal(response.json().approval.approvalNodes[2].name, "人事复核");

  const audit = await app.inject({ method: "GET", url: "/api/audit", headers });
  assert.equal(audit.json().auditLogs.some((item) => item.content.includes("提交审批申请")), true);

  await app.close();
});

test("approved HR transfer workflow updates employee department and audits lifecycle sync", async () => {
  const app = await buildApp({
    logger: false,
    prisma: await makePrismaMock({
      permissionCodes: ["system.admin", "workflow.read", "workflow.write", "workflow.approve", "employee.read", "audit.read"],
      departments: [{ id: "dept-finance", tenantId: "tenant-default", code: "FIN", name: "财务中心" }]
    }),
    config: { jwtSecret: "test-secret" }
  });
  const headers = await loginHeaders(app);

  const created = await app.inject({
    method: "POST",
    url: "/api/approvals",
    headers,
    payload: {
      definitionId: "transfer",
      title: "张三调岗到财务中心",
      department: "行政部",
      formData: {
        employee: "张三",
        fromDepartment: "行政部",
        toDepartment: "财务中心",
        effectiveDate: "2026-06-10",
        handover: "完成行政项目交接"
      }
    }
  });
  assert.equal(created.statusCode, 201);

  await approveWorkflow(app, headers, created.json().approval.id, ["张三", "李四", "王五", "HRBP"], "hr-transfer-sync");

  const employee = await app.prisma.employee.findFirst({ where: { tenantId: "tenant-default", name: "张三" }, include: { department: true } });
  assert.equal(employee.department.name, "财务中心");
  assert.equal(employee.sensitiveInfo.previousDepartment, "行政部");
  assert.equal(employee.sensitiveInfo.transferEffectiveDate, "2026-06-10");
  assert.equal(employee.sensitiveInfo.lifecycleHistory[0].action, "transfer");

  const approval = await app.inject({ method: "GET", url: "/api/approvals", headers });
  assert.equal(approval.json().approvals.find((item) => item.id === created.json().approval.id).status, "已通过");

  const audit = await app.prisma.auditLog.findMany({ where: { action: "employee.lifecycle.transfer" } });
  assert.equal(audit.some((item) => item.summary.includes("已更新部门为 财务中心")), true);

  const people = await app.inject({ method: "GET", url: "/api/people", headers });
  const syncedPerson = people.json().people.employees.find((item) => item.name === "张三");
  assert.equal(syncedPerson.lifecycleSummary.label, "调岗");
  assert.equal(syncedPerson.lifecycleSummary.detail, "行政部 -> 财务中心");
  assert.doesNotMatch(JSON.stringify(syncedPerson), /完成行政项目交接/);

  await app.close();
});

test("approved HR onboarding workflow creates employee profile without exposing sensitive fields", async () => {
  const app = await buildApp({
    logger: false,
    prisma: await makePrismaMock({
      permissionCodes: ["system.admin", "workflow.read", "workflow.write", "workflow.approve", "employee.read", "audit.read"],
      workflowDefinitions: [{
        id: "wf-onboard",
        code: "HR-ONBOARD",
        name: "入职办理",
        category: "组织人事",
        formSchema: {
          fields: [
            { id: "employee", label: "入职员工", type: "input" },
            { id: "position", label: "入职岗位", type: "input" },
            { id: "entryDate", label: "入职日期", type: "date" }
          ]
        },
        nodes: [
          { id: "onboard-def-1", name: "人事资料复核", stepOrder: 1, approvalMode: "AND", approverRule: { approvers: ["张三"] } }
        ]
      }]
    }),
    config: { jwtSecret: "test-secret" }
  });
  const headers = await loginHeaders(app);

  const created = await app.inject({
    method: "POST",
    url: "/api/approvals",
    headers,
    payload: {
      definitionId: "onboarding",
      title: "新员工A入职办理",
      department: "行政部",
      formData: {
        employee: "新员工A",
        position: "运营专员",
        entryDate: "2026-06-03",
        probationMonths: "3",
        equipmentNeed: "电脑+工位"
      }
    }
  });
  assert.equal(created.statusCode, 201);

  await approveWorkflow(app, headers, created.json().approval.id, ["张三"], "hr-onboard-sync");

  const employee = await app.prisma.employee.findFirst({ where: { tenantId: "tenant-default", name: "新员工A" }, include: { department: true } });
  assert.ok(employee);
  assert.match(employee.employeeNo, /^EMP-\d{4}-\d{5}$/);
  assert.equal(employee.department.name, "行政部");
  assert.equal(employee.roleTitle, "运营专员");
  assert.equal(employee.status, "ACTIVE");
  assert.equal(employee.entryDate.toISOString().slice(0, 10), "2026-06-03");
  assert.equal(employee.sensitiveInfo.equipmentNeed, "电脑+工位");
  assert.equal(employee.sensitiveInfo.lifecycleHistory[0].action, "onboard_create");

  const people = await app.inject({ method: "GET", url: "/api/people", headers });
  const createdPerson = people.json().people.employees.find((item) => item.name === "新员工A");
  assert.equal(createdPerson.role, "运营专员");
  assert.equal(createdPerson.school, "");
  assert.equal(createdPerson.major, "");
  assert.equal(createdPerson.lifecycleSummary.label, "入职");
  assert.equal(createdPerson.lifecycleSummary.detail, "入职部门：行政部");

  const audit = await app.prisma.auditLog.findMany({ where: { action: "employee.lifecycle.onboard" } });
  assert.equal(audit.some((item) => item.summary.includes("已写入员工档案")), true);

  await app.close();
});

test("approved HR regularization offboarding exception and salary workflows sync employee profiles", async () => {
  const app = await buildApp({
    logger: false,
    prisma: await makePrismaMock({
      permissionCodes: ["system.admin", "workflow.read", "workflow.write", "workflow.approve", "employee.read", "audit.read"],
      workflowDefinitions: [
        oneStepLifecycleDefinition("wf-regular", "HR-REGULAR", "转正申请"),
        oneStepLifecycleDefinition("wf-offboard", "HR-OFFBOARD", "离职交接"),
        oneStepLifecycleDefinition("wf-exception", "HR-EXCEPTION", "状态异常人员报备"),
        oneStepLifecycleDefinition("wf-salary", "HR-SALARY", "调薪申请")
      ],
      employees: [
        { id: "emp-regular", employeeNo: "EMP-REGULAR", name: "转正员工", departmentId: "dept-admin", roleTitle: "运营专员" },
        { id: "emp-offboard", employeeNo: "EMP-OFFBOARD", name: "离职员工", departmentId: "dept-admin", roleTitle: "客服专员" },
        { id: "emp-exception", employeeNo: "EMP-EXCEPTION", name: "异常员工", departmentId: "dept-admin", roleTitle: "行政专员" },
        { id: "emp-salary", employeeNo: "EMP-SALARY", name: "调薪员工", departmentId: "dept-admin", roleTitle: "直播运营" }
      ]
    }),
    config: { jwtSecret: "test-secret" }
  });
  const headers = await loginHeaders(app);

  async function submitAndApprove(definitionId, title, formData) {
    const response = await app.inject({
      method: "POST",
      url: "/api/approvals",
      headers,
      payload: {
        definitionId,
        title,
        department: "行政部",
        formData
      }
    });
    assert.equal(response.statusCode, 201);
    await approveWorkflow(app, headers, response.json().approval.id, ["张三"], `hr-${definitionId}`);
    return response.json().approval.id;
  }

  const regularWorkflowId = await submitAndApprove("regularization", "转正员工转正申请", {
    employee: "转正员工",
    probationResult: "按期转正",
    effectiveDate: "2026-07-01",
    reviewer: "部门负责人"
  });
  const offboardWorkflowId = await submitAndApprove("offboarding", "离职员工离职交接", {
    employee: "离职员工",
    leaveDate: "2026-07-10",
    reasonType: "个人原因",
    handover: "张三",
    assetReturn: "已归还"
  });
  const exceptionWorkflowId = await submitAndApprove("exception", "异常员工状态报备", {
    employee: "异常员工",
    exceptionType: "权限异常",
    discoveredAt: "2026-07-03",
    actionPlan: "锁定账号并复核权限"
  });
  const salaryWorkflowId = await submitAndApprove("salary", "调薪员工调薪申请", {
    employee: "调薪员工",
    adjustAmount: "5200",
    effectiveDate: "2026-08-01",
    reasonType: "岗位调整"
  });

  const regularEmployee = await app.prisma.employee.findFirst({ where: { tenantId: "tenant-default", name: "转正员工" } });
  assert.equal(regularEmployee.status, "ACTIVE");
  assert.equal(regularEmployee.sensitiveInfo.regularDate, "2026-07-01");
  assert.equal(regularEmployee.sensitiveInfo.probationResult, "按期转正");
  assert.equal(regularEmployee.sensitiveInfo.lifecycleHistory[0].action, "regularization");

  const offboardEmployee = await app.prisma.employee.findFirst({ where: { tenantId: "tenant-default", name: "离职员工" } });
  assert.equal(offboardEmployee.status, "LEAVED");
  assert.equal(offboardEmployee.leaveDate.toISOString().slice(0, 10), "2026-07-10");
  assert.equal(offboardEmployee.sensitiveInfo.assetReturn, "已归还");
  assert.equal(offboardEmployee.sensitiveInfo.lifecycleHistory[0].action, "offboard");

  const exceptionEmployee = await app.prisma.employee.findFirst({ where: { tenantId: "tenant-default", name: "异常员工" } });
  assert.equal(exceptionEmployee.status, "SUSPENDED");
  assert.equal(exceptionEmployee.sensitiveInfo.exceptionType, "权限异常");
  assert.equal(exceptionEmployee.sensitiveInfo.exceptionReason, "锁定账号并复核权限");
  assert.equal(exceptionEmployee.sensitiveInfo.exceptionEffectiveDate, "2026-07-03");
  assert.equal(exceptionEmployee.sensitiveInfo.lifecycleHistory[0].action, "exception");

  const salaryEmployee = await app.prisma.employee.findFirst({ where: { tenantId: "tenant-default", name: "调薪员工" } });
  assert.equal(salaryEmployee.status, "ACTIVE");
  assert.deepEqual(salaryEmployee.sensitiveInfo.salaryAdjustment, {
    effectiveDate: "2026-08-01",
    reasonType: "岗位调整",
    hasAmount: true
  });
  assert.equal(salaryEmployee.sensitiveInfo.lifecycleHistory[0].action, "salary_adjustment");

  const people = await app.inject({ method: "GET", url: "/api/people", headers });
  const payloadText = JSON.stringify(people.json());
  assert.doesNotMatch(payloadText, /5200|adjustAmount|锁定账号并复核权限/);
  const regularPerson = people.json().people.employees.find((item) => item.name === "转正员工");
  const salaryPerson = people.json().people.employees.find((item) => item.name === "调薪员工");
  const offboardPerson = people.json().people.leavers.find((item) => item.name === "离职员工");
  const exceptionPerson = people.json().people.inactiveEmployees.find((item) => item.name === "异常员工");
  assert.equal(regularPerson.lifecycleSummary.detail, "转正结果：按期转正");
  assert.equal(salaryPerson.lifecycleSummary.detail, "调薪原因：岗位调整");
  assert.equal(offboardPerson.lifecycleSummary.detail, "离职类型：个人原因");
  assert.equal(exceptionPerson.lifecycleSummary.detail, "异常类型：权限异常");

  for (const [action, workflowId] of [
    ["employee.lifecycle.regularization", regularWorkflowId],
    ["employee.lifecycle.offboard", offboardWorkflowId],
    ["employee.lifecycle.exception", exceptionWorkflowId],
    ["employee.lifecycle.salary", salaryWorkflowId]
  ]) {
    const logs = await app.prisma.auditLog.findMany({ where: { action } });
    assert.equal(logs.some((item) => item.metadata.workflowInstanceId === workflowId && item.metadata.result === "成功"), true);
  }

  await app.close();
});

test("workflow submission is idempotent by idempotency key", async () => {
  const app = await buildApp({
    logger: false,
    prisma: await makePrismaMock({ permissionCodes: ["workflow.read", "workflow.write", "audit.read"] }),
    config: { jwtSecret: "test-secret" }
  });
  const headers = await loginHeaders(app);
  const payload = {
    definitionId: "expense",
    title: "幂等报销 A",
    department: "行政部",
    idempotencyKey: "submit-expense-idempotent",
    formData: { amount: 88, reason: "商务接待" }
  };

  const first = await app.inject({
    method: "POST",
    url: "/api/approvals",
    headers,
    payload
  });
  assert.equal(first.statusCode, 201);

  const repeated = await app.inject({
    method: "POST",
    url: "/api/approvals",
    headers,
    payload: { ...payload, title: "幂等报销 B", formData: { amount: 999 } }
  });
  assert.equal(repeated.statusCode, 200);
  assert.equal(repeated.json().alreadySubmitted, true);
  assert.equal(repeated.json().approval.id, first.json().approval.id);
  assert.equal(repeated.json().approval.title, "幂等报销 A");

  const approvals = await app.inject({ method: "GET", url: "/api/approvals", headers });
  assert.equal(approvals.json().approvals.filter((item) => item.title === "幂等报销 A").length, 1);
  assert.equal(approvals.json().approvals.some((item) => item.title === "幂等报销 B"), false);

  const submitLogs = await app.prisma.auditLog.findMany({ where: { action: "workflow.submit" } });
  assert.equal(submitLogs.filter((item) => item.metadata?.title === "幂等报销 A").length, 1);
  assert.equal(submitLogs.some((item) => item.metadata?.title === "幂等报销 B"), false);

  await app.close();
});

test("dashboard html import upserts people departments lineage and audit", async () => {
  const fileStorageDir = await mkdtemp(join(tmpdir(), "deep-oa-import-source-"));
  const app = await buildApp({
    logger: false,
    prisma: await makePrismaMock(),
    config: { fileStorageDir, jwtSecret: "test-secret" }
  });
  const headers = await loginHeaders(app);
  const html = `
    <section>
      <h2>在职员工详细信息</h2>
      <table>
        <thead><tr><th>序号</th><th>组织</th><th>姓名</th><th>性别</th><th>部门</th><th>岗位</th><th>入职日期</th><th>转正日期</th><th>年龄</th><th>户口</th><th>学历</th><th>学校</th><th>专业</th></tr></thead>
        <tbody><tr><td>9001</td><td>集团总部</td><td>赵导入</td><td>女</td><td>导入测试部</td><td>导入专员</td><td>2026-05-10</td><td>2026-06-10</td><td>28.0</td><td>广东/城镇</td><td>本科</td><td>导入大学</td><td>行政管理</td></tr></tbody>
      </table>
    </section>
    <section>
      <h2>离职人员详细信息</h2>
      <table>
        <thead><tr><th>姓名</th><th>组织</th><th>部门</th><th>岗位</th><th>入职日期</th><th>离职日期</th></tr></thead>
        <tbody><tr><td>钱导入</td><td>集团总部</td><td>导入测试部</td><td>行政助理</td><td>2025-12-01</td><td>2026-05-29</td></tr></tbody>
      </table>
    </section>`;

  const response = await app.inject({
    method: "POST",
    url: "/api/imports/dashboard-html",
    headers,
    payload: { sourceName: "runtime-dashboard.html", html }
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().people.totalRows, 2);
  assert.equal(response.json().people.activeEmployees, 1);
  assert.equal(response.json().importRun.sourceName, "runtime-dashboard.html");
  assert.ok(response.json().importRun.sourceChecksum.length >= 32);
  assert.equal(response.json().importRun.metadata.sourceArtifact.downloadAvailable, true);
  assert.equal(response.json().importRun.metadata.sourceArtifact.fileName, "runtime-dashboard.html");
  assert.equal(response.json().importRun.metadata.sourceArtifact.storageKey, undefined);

  const people = await app.inject({ method: "GET", url: "/api/people", headers });
  assert.ok(people.json().people.employees.some((employee) => employee.name === "赵导入" && employee.department === "导入测试部"));
  assert.ok(people.json().people.leavers.some((employee) => employee.name === "钱导入" && employee.department === "导入测试部"));

  const imports = await app.inject({ method: "GET", url: "/api/imports", headers });
  assert.equal(imports.json().importRuns[0].sourceName, "runtime-dashboard.html");
  assert.equal(imports.json().importRuns[0].recordCounts.totalRows, 2);
  assert.equal(imports.json().importRuns[0].metadata.sourceArtifact.downloadAvailable, true);
  assert.equal(imports.json().importRuns[0].metadata.sourceArtifact.storageKey, undefined);

  const sourceDownload = await app.inject({
    method: "GET",
    url: `/api/imports/${encodeURIComponent(response.json().importRun.id)}/source`,
    headers
  });
  assert.equal(sourceDownload.statusCode, 200);
  assert.match(sourceDownload.headers["content-type"], /application\/octet-stream/);
  assert.match(sourceDownload.headers["content-disposition"], /runtime-dashboard\.html/);
  assert.match(sourceDownload.body, /赵导入/);

  const rawImportRun = await app.prisma.dataImportRun.findFirst({ where: { id: response.json().importRun.id } });
  await writeFile(join(fileStorageDir, rawImportRun.metadata.sourceArtifact.storageKey), "tampered import source");
  const tamperedSourceDownload = await app.inject({
    method: "GET",
    url: `/api/imports/${encodeURIComponent(response.json().importRun.id)}/source`,
    headers
  });
  assert.equal(tamperedSourceDownload.statusCode, 409);
  assert.equal(tamperedSourceDownload.json().error, "source_artifact_checksum_mismatch");

  const duplicate = await app.inject({
    method: "POST",
    url: "/api/imports/dashboard-html",
    headers,
    payload: { sourceName: "runtime-dashboard.html", html }
  });
  assert.equal(duplicate.statusCode, 409);
  assert.equal(duplicate.json().error, "duplicate_import");
  assert.equal(duplicate.json().importRun.sourceName, "runtime-dashboard.html");

  const importsAfterDuplicate = await app.inject({ method: "GET", url: "/api/imports", headers });
  assert.equal(importsAfterDuplicate.json().importRuns.filter((run) => run.sourceName === "runtime-dashboard.html").length, 1);

  const audit = await app.inject({ method: "GET", url: "/api/audit", headers });
  assert.ok(audit.json().auditLogs.some((log) => log.content === "导入人员数据 runtime-dashboard.html，共 2 行"));
  assert.ok(audit.json().auditLogs.some((log) => log.content === "下载导入源文件 runtime-dashboard.html"));
  assert.ok(audit.json().auditLogs.some((log) => log.content === "拒绝下载导入源文件 runtime-dashboard.html"));
  assert.ok(audit.json().auditLogs.some((log) => log.content === "拒绝重复导入 runtime-dashboard.html"));

  await app.close();
  await rm(fileStorageDir, { recursive: true, force: true });
});

test("dashboard html import maps database unique races to duplicate import response", async () => {
  const prisma = await makePrismaMock();
  const originalFindFirst = prisma.dataImportRun.findFirst;
  const originalCreate = prisma.dataImportRun.create;
  let importFindCount = 0;

  prisma.dataImportRun.findFirst = async (args = {}) => {
    if (args.where?.sourceName === "racing-dashboard.html" && args.where?.sourceChecksum) {
      importFindCount += 1;
      if (importFindCount === 1) return null;
      return {
        id: "import-race-existing",
        tenantId: args.where.tenantId,
        actorUserId: "user-admin",
        sourceType: "html-dashboard",
        sourceName: args.where.sourceName,
        sourceChecksum: args.where.sourceChecksum,
        status: "SUCCESS",
        recordCounts: { activeEmployees: 1, femaleEmployees: 1, leavers: 0, monthLeavers: 0, totalRows: 1 },
        metadata: { parser: "scripts/dashboard-data.mjs" },
        startedAt: new Date("2026-05-29T10:00:00.000Z"),
        finishedAt: new Date("2026-05-29T10:01:00.000Z"),
        actor: { id: "user-admin", name: "系统管理员", email: "admin@oa.local" }
      };
    }
    return originalFindFirst(args);
  };
  prisma.dataImportRun.create = async (args = {}) => {
    if (args.data?.sourceName === "racing-dashboard.html") {
      const error = new Error("Unique constraint failed on data_import_runs_success_unique");
      error.code = "P2002";
      error.meta = { target: "data_import_runs_success_unique" };
      throw error;
    }
    return originalCreate(args);
  };

  const app = await buildApp({
    logger: false,
    prisma,
    config: { jwtSecret: "test-secret" }
  });
  const headers = await loginHeaders(app);
  const html = `
    <section>
      <h2>在职员工详细信息</h2>
      <table>
        <thead><tr><th>序号</th><th>组织</th><th>姓名</th><th>性别</th><th>部门</th><th>岗位</th><th>入职日期</th></tr></thead>
        <tbody><tr><td>9010</td><td>集团总部</td><td>并发导入</td><td>女</td><td>导入测试部</td><td>导入专员</td><td>2026-05-10</td></tr></tbody>
      </table>
    </section>`;

  const response = await app.inject({
    method: "POST",
    url: "/api/imports/dashboard-html",
    headers,
    payload: { sourceName: "racing-dashboard.html", html }
  });

  assert.equal(response.statusCode, 409);
  assert.equal(response.json().error, "duplicate_import");
  assert.equal(response.json().importRun.id, "import-race-existing");

  const audit = await app.inject({ method: "GET", url: "/api/audit", headers });
  assert.ok(audit.json().auditLogs.some((log) => log.content === "拒绝重复导入 racing-dashboard.html"));

  await app.close();
});

test("dashboard html import rejects oversized or empty content and writes denial audit rows", async () => {
  const app = await buildApp({
    logger: false,
    prisma: await makePrismaMock(),
    config: { importMaxHtmlBytes: 128, jwtSecret: "test-secret" }
  });
  const headers = await loginHeaders(app);

  const oversized = await app.inject({
    method: "POST",
    url: "/api/imports/dashboard-html",
    headers,
    payload: {
      sourceName: "oversized-dashboard.html",
      html: `<section>${"x".repeat(256)}</section>`
    }
  });
  assert.equal(oversized.statusCode, 413);
  assert.equal(oversized.json().error, "import_content_too_large");

  const empty = await app.inject({
    method: "POST",
    url: "/api/imports/dashboard-html",
    headers,
    payload: {
      sourceName: "empty-dashboard.html",
      html: "<section><h2>空导入</h2><table><tbody></tbody></table></section>"
    }
  });
  assert.equal(empty.statusCode, 400);
  assert.equal(empty.json().error, "dashboard_import_empty");

  const imports = await app.inject({ method: "GET", url: "/api/imports", headers });
  assert.equal(imports.json().importRuns.some((run) => ["oversized-dashboard.html", "empty-dashboard.html"].includes(run.sourceName)), false);

  const audit = await app.inject({ method: "GET", url: "/api/audit", headers });
  const oversizedAudit = audit.json().auditLogs.find((log) => log.content === "拒绝导入人员数据 oversized-dashboard.html");
  const emptyAudit = audit.json().auditLogs.find((log) => log.content === "拒绝导入人员数据 empty-dashboard.html");
  assert.equal(oversizedAudit?.result, "失败");
  assert.equal(emptyAudit?.result, "失败");

  await app.close();
});

test("employee maintenance updates allowed fields and writes audit log", async () => {
  const app = await buildApp({
    logger: false,
    prisma: await makePrismaMock({ permissionCodes: [...defaultPermissionCodes, "employee.write"] }),
    config: { jwtSecret: "test-secret" }
  });
  const headers = await loginHeaders(app);

  const response = await app.inject({
    method: "PATCH",
    url: "/api/people/employees/emp-1",
    headers,
    payload: {
      department: "行政部",
      role: "人事行政经理",
      status: "离职",
      leaveDate: "2026-05-29"
    }
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.json().employee.role, "人事行政经理");
  assert.equal(response.json().employee.status, "离职");
  assert.equal(response.json().employee.leaveDate, "2026-05-29");

  const people = await app.inject({ method: "GET", url: "/api/people", headers });
  assert.equal(people.json().people.employees.length, 0);
  assert.equal(people.json().people.leavers[0].name, "张三");

  const audit = await app.inject({ method: "GET", url: "/api/audit", headers });
  assert.equal(audit.json().auditLogs[0].object, "employee");
  assert.equal(audit.json().auditLogs[0].content, "更新员工 张三 档案");

  await app.close();
});

test("employee maintenance requires write permission and valid department", async () => {
  const unauthorizedApp = await buildApp({
    logger: false,
    prisma: await makePrismaMock({ permissionCodes: ["employee.read", "audit.read"] }),
    config: { jwtSecret: "test-secret" }
  });
  const unauthorizedHeaders = await loginHeaders(unauthorizedApp);
  const denied = await unauthorizedApp.inject({
    method: "PATCH",
    url: "/api/people/employees/emp-1",
    headers: unauthorizedHeaders,
    payload: { role: "行政经理" }
  });
  assert.equal(denied.statusCode, 403);
  await unauthorizedApp.close();

  const app = await buildApp({
    logger: false,
    prisma: await makePrismaMock({ permissionCodes: [...defaultPermissionCodes, "employee.write"] }),
    config: { jwtSecret: "test-secret" }
  });
  const headers = await loginHeaders(app);
  const response = await app.inject({
    method: "PATCH",
    url: "/api/people/employees/emp-1",
    headers,
    payload: { department: "不存在部门" }
  });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error, "department_not_found");

  await app.close();
});

test("people APIs enforce role permission department data scope", async () => {
  const app = await buildApp({
    logger: false,
    prisma: await makePrismaMock({
      permissionCodes: ["employee.read", "employee.write", "audit.read"],
      permissionPolicies: {
        "employee.read": { dataScope: { type: "department" } },
        "employee.write": { dataScope: { type: "department" } }
      },
      departments: [{ id: "dept-finance", tenantId: "tenant-default", code: "FIN", name: "财务中心" }],
      employees: [{
        id: "emp-finance",
        employeeNo: "EMP-FIN-001",
        name: "王五",
        gender: "男",
        departmentId: "dept-finance",
        roleTitle: "财务专员",
        status: "ACTIVE",
        entryDate: new Date("2026-05-02T00:00:00.000Z"),
        sensitiveInfo: { org: "集团总部", school: "财务大学", hukou: "上海/城镇" }
      }]
    }),
    config: { jwtSecret: "test-secret" }
  });
  const headers = await loginHeaders(app);

  const people = await app.inject({ method: "GET", url: "/api/people", headers });
  assert.equal(people.statusCode, 200);
  assert.deepEqual(people.json().people.employees.map((employee) => employee.name), ["张三"]);

  const ownDepartmentUpdate = await app.inject({
    method: "PATCH",
    url: "/api/people/employees/emp-1",
    headers,
    payload: { role: "行政经理" }
  });
  assert.equal(ownDepartmentUpdate.statusCode, 200);
  assert.equal(ownDepartmentUpdate.json().employee.role, "行政经理");

  const otherDepartmentUpdate = await app.inject({
    method: "PATCH",
    url: "/api/people/employees/emp-finance",
    headers,
    payload: { role: "财务经理" }
  });
  assert.equal(otherDepartmentUpdate.statusCode, 403);
  assert.equal(otherDepartmentUpdate.json().details.reason, "data_scope_denied");

  await app.close();
});

test("people export returns backend CSV with safe fields and audit row", async () => {
  const app = await buildApp({
    logger: false,
    prisma: await makePrismaMock({ permissionCodes: ["employee.read", "employee.export", "audit.read"] }),
    config: { jwtSecret: "test-secret" }
  });
  const headers = await loginHeaders(app);

  const response = await app.inject({
    method: "POST",
    url: "/api/people/export",
    headers,
    payload: { businessReason: "人事月度核对", filters: { status: "ACTIVE", scope: "在职员工" } }
  });

  assert.equal(response.statusCode, 200);
  assert.match(response.headers["content-type"], /text\/csv/);
  assert.match(response.headers["content-disposition"], /attachment; filename="people-export-/);
  assert.equal(response.headers["x-row-count"], "1");
  assert.match(response.body, /姓名/);
  assert.match(response.body, /张三/);
  assert.match(response.body, /行政主管/);
  assert.doesNotMatch(response.body, /示例大学/);
  assert.doesNotMatch(response.body, /广东\/城镇/);

  const audit = await app.inject({ method: "GET", url: "/api/audit", headers });
  assert.equal(audit.json().auditLogs.some((item) => item.content.includes("导出在职员工，后端生成脱敏人员名册")), true);

  await app.close();
});

test("people export requires export permission and enforces department data scope", async () => {
  const deniedApp = await buildApp({
    logger: false,
    prisma: await makePrismaMock({ permissionCodes: ["employee.read", "audit.read"] }),
    config: { jwtSecret: "test-secret" }
  });
  const deniedHeaders = await loginHeaders(deniedApp);
  const denied = await deniedApp.inject({
    method: "POST",
    url: "/api/people/export",
    headers: deniedHeaders,
    payload: { businessReason: "人事月度核对", filters: { status: "ACTIVE" } }
  });
  assert.equal(denied.statusCode, 403);
  await deniedApp.close();

  const scopedApp = await buildApp({
    logger: false,
    prisma: await makePrismaMock({
      permissionCodes: ["employee.read", "employee.export", "audit.read"],
      permissionPolicies: {
        "employee.read": { dataScope: { type: "department" } },
        "employee.export": { dataScope: { type: "department" } }
      },
      departments: [{ id: "dept-finance", tenantId: "tenant-default", code: "FIN", name: "财务中心" }],
      employees: [{
        id: "emp-finance",
        employeeNo: "EMP-FIN-001",
        name: "王五",
        gender: "男",
        departmentId: "dept-finance",
        roleTitle: "财务专员",
        status: "ACTIVE",
        entryDate: new Date("2026-05-02T00:00:00.000Z"),
        sensitiveInfo: { org: "集团总部", school: "财务大学", hukou: "上海/城镇" }
      }]
    }),
    config: { jwtSecret: "test-secret" }
  });
  const scopedHeaders = await loginHeaders(scopedApp);
  const scoped = await scopedApp.inject({
    method: "POST",
    url: "/api/people/export",
    headers: scopedHeaders,
    payload: { businessReason: "部门人员核对", filters: { status: "ACTIVE", scope: "部门在职员工" } }
  });
  assert.equal(scoped.statusCode, 200);
  assert.equal(scoped.headers["x-row-count"], "1");
  assert.match(scoped.body, /张三/);
  assert.doesNotMatch(scoped.body, /王五/);

  await scopedApp.close();
});

test("approval export returns backend CSV with formula escaping and audit row", async () => {
  const app = await buildApp({
    logger: false,
    prisma: await makePrismaMock({ permissionCodes: ["workflow.read", "workflow.export", "audit.read"] }),
    config: { jwtSecret: "test-secret" }
  });
  const headers = await loginHeaders(app);

  await app.prisma.workflowInstance.create({
    data: {
      tenantId: "tenant-default",
      definitionId: "wf-expense",
      definitionCode: "FIN-EXPENSE",
      definitionVersion: 1,
      title: " =HYPERLINK(\"https://example.invalid\",\"open\")",
      status: "PENDING",
      applicantUserId: "user-admin",
      departmentId: "dept-admin",
      formData: { amount: 123 },
      currentNodeId: null,
      submittedAt: new Date("2026-05-29T12:00:00.000Z")
    }
  });

  const response = await app.inject({
    method: "POST",
    url: "/api/approvals/export",
    headers,
    payload: { businessReason: "流程审计抽查", scope: "审批列表", filters: { keyword: "HYPERLINK" } }
  });

  assert.equal(response.statusCode, 200);
  assert.match(response.headers["content-type"], /text\/csv/);
  assert.match(response.headers["content-disposition"], /attachment; filename="approval-export-/);
  assert.equal(response.headers["x-row-count"], "1");
  assert.match(response.body, /流程名称/);
  assert.match(response.body, /"' =HYPERLINK/);
  assert.doesNotMatch(response.body, /comments/);

  const audit = await app.inject({ method: "GET", url: "/api/audit", headers });
  assert.equal(audit.statusCode, 200);
  assert.equal(audit.json().auditLogs.some((item) => item.content.includes("导出审批列表，后端生成审批列表")), true);

  await app.close();
});

test("approval export requires explicit export permission", async () => {
  const app = await buildApp({
    logger: false,
    prisma: await makePrismaMock({ permissionCodes: ["workflow.read"] }),
    config: { jwtSecret: "test-secret" }
  });
  const headers = await loginHeaders(app);

  const response = await app.inject({
    method: "POST",
    url: "/api/approvals/export",
    headers,
    payload: { businessReason: "流程审计抽查", scope: "审批列表" }
  });

  assert.equal(response.statusCode, 403);

  await app.close();
});

test("audit export returns backend-generated CSV and records export event", async () => {
  const app = await buildApp({
    logger: false,
    prisma: await makePrismaMock({ permissionCodes: ["audit.read", "audit.export"] }),
    config: { jwtSecret: "test-secret" }
  });
  const headers = await loginHeaders(app);

  const response = await app.inject({
    method: "POST",
    url: "/api/audit/export",
    headers,
    payload: {
      scope: "操作日志",
      businessReason: "审计日志抽查",
      filters: { objectType: "csv_risk", result: "成功" },
      rowCount: 9999
    }
  });

  assert.equal(response.statusCode, 200);
  assert.match(response.headers["content-type"], /text\/csv/);
  assert.match(response.headers["content-disposition"], /attachment; filename="audit-export-/);
  assert.equal(response.headers["x-row-count"], "1");
  assert.match(response.body, /操作时间/);
  assert.match(response.body, /"'=HYPERLINK/);

  await app.prisma.auditLog.create({
    data: {
      tenantId: "tenant-default",
      actorUserId: "user-admin",
      action: "manual.note",
      objectType: "csv_risk_spaced",
      summary: "  =HYPERLINK(\"https://example.invalid\",\"open\")",
      metadata: {},
      ipAddress: "127.0.0.1"
    }
  });

  const spacedFormula = await app.inject({
    method: "POST",
    url: "/api/audit/export",
    headers,
    payload: {
      scope: "操作日志",
      businessReason: "审计日志抽查",
      filters: { objectType: "csv_risk_spaced", result: "成功" }
    }
  });
  assert.equal(spacedFormula.statusCode, 200);
  assert.equal(spacedFormula.headers["x-row-count"], "1");
  assert.match(spacedFormula.body, /"'  =HYPERLINK/);

  const audit = await app.inject({ method: "GET", url: "/api/audit", headers });
  assert.equal(audit.statusCode, 200);
  assert.equal(audit.json().auditLogs.some((item) => item.content.includes("导出操作日志")), true);
  assert.equal(audit.json().exportRecords.length, 2);
  assert.equal(audit.json().exportRecords.some((item) => item.action === "audit.export" && item.scope === "操作日志"), true);
  assert.equal(audit.json().exportRecords.some((item) => item.rowCount === 1 && item.fileName.includes("audit-export-")), true);

  const exportRecords = await app.inject({ method: "GET", url: "/api/audit/export-records", headers });
  assert.equal(exportRecords.statusCode, 200);
  assert.equal(exportRecords.json().exportRecords.length, 2);
  assert.equal(exportRecords.json().exportRecords.every((item) => item.businessReason === "审计日志抽查"), true);

  await app.close();
});

test("audit export requires explicit export permission", async () => {
  const app = await buildApp({
    logger: false,
    prisma: await makePrismaMock({ permissionCodes: ["audit.read"] }),
    config: { jwtSecret: "test-secret" }
  });
  const headers = await loginHeaders(app);

  const response = await app.inject({
    method: "POST",
    url: "/api/audit/export",
    headers,
    payload: { businessReason: "审计日志抽查", scope: "操作日志" }
  });

  assert.equal(response.statusCode, 403);

  await app.close();
});

test("audit list clamps limits and applies query filters", async () => {
  const auditFindManyCalls = [];
  const app = await buildApp({
    logger: false,
    prisma: await makePrismaMock({
      permissionCodes: ["audit.read"],
      onAuditFindMany: (args) => auditFindManyCalls.push(args)
    }),
    config: { jwtSecret: "test-secret" }
  });
  const headers = await loginHeaders(app);

  const filtered = await app.inject({
    method: "GET",
    url: "/api/audit?limit=999999&objectType=file_object&result=%E5%A4%B1%E8%B4%A5&from=2026-05-29T00:00:00.000Z&to=2026-05-30T00:00:00.000Z",
    headers
  });
  assert.equal(filtered.statusCode, 200);
  assert.ok(filtered.json().auditLogs.every((item) => item.result === "失败"));
  const filteredCall = auditFindManyCalls.at(-1);
  assert.equal(filteredCall.take, 500);
  assert.equal(filteredCall.where.tenantId, "tenant-default");
  assert.equal(filteredCall.where.objectType, "file_object");
  assert.deepEqual(filteredCall.where.metadata, { path: ["result"], equals: "失败" });
  assert.ok(filteredCall.where.createdAt.gte instanceof Date);
  assert.ok(filteredCall.where.createdAt.lte instanceof Date);

  const invalidLimit = await app.inject({
    method: "GET",
    url: "/api/audit?limit=not-a-number",
    headers
  });
  assert.equal(invalidLimit.statusCode, 200);
  assert.equal(auditFindManyCalls.at(-1).take, 200);

  await app.close();
});

test("audit integrity endpoint returns tenant hash-chain summary", async () => {
  const auditFindManyCalls = [];
  const app = await buildApp({
    logger: false,
    prisma: await makePrismaMock({
      permissionCodes: ["audit.read"],
      onAuditFindMany: (args) => auditFindManyCalls.push(args)
    }),
    config: { jwtSecret: "test-secret" }
  });
  const headers = await loginHeaders(app);

  const response = await app.inject({
    method: "GET",
    url: "/api/audit/integrity?limit=999999",
    headers
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.json().ok, true);
  assert.equal(response.json().summary.totalRows, 4);
  assert.equal(response.json().summary.signedRows, 1);
  assert.equal(response.json().summary.unsignedRows, 3);
  assert.equal(response.json().summary.lastSequence, 1);
  assert(response.json().warnings.some((item) => item.includes("unsigned") || item.includes("no signed")));
  assert.equal(auditFindManyCalls.at(-1).where.tenantId, "tenant-default");
  assert.equal(auditFindManyCalls.at(-1).take, 5000);

  await app.close();
});

test("file upload stores content, hides storage key, downloads by id, and writes audit rows", async () => {
  const fileStorageDir = await mkdtemp(join(tmpdir(), "deep-oa-files-"));
  const app = await buildApp({
    logger: false,
    prisma: await makePrismaMock({ permissionCodes: ["file.read", "file.upload", "audit.read"] }),
    config: { fileMaxUploadBytes: 1024, fileStorageDir, jwtSecret: "test-secret" }
  });
  const headers = await loginHeaders(app);

  try {
    const upload = await app.inject({
      method: "POST",
      url: "/api/files",
      headers,
      payload: {
        fileName: "../审批凭证.txt",
        mimeType: "text/plain",
        contentBase64: Buffer.from("commercial attachment").toString("base64"),
        visibility: "TENANT"
      }
    });

    assert.equal(upload.statusCode, 201);
    assert.equal(upload.json().file.fileName, "审批凭证.txt");
    assert.equal(upload.json().file.sizeBytes, 21);
    assert.equal(upload.json().file.visibility, "TENANT");
    assert.equal(Object.hasOwn(upload.json().file, "storageKey"), false);
    const storedFile = await app.prisma.fileObject.findFirst({ where: { id: upload.json().file.id, tenantId: "tenant-default" } });
    assert.equal(storedFile.storageKey.includes("审批凭证"), false);
    assert.match(storedFile.storageKey, /^tenant-default\/\d{8}\/[0-9a-f-]{36}$/);

    const files = await app.inject({ method: "GET", url: "/api/files", headers });
    assert.equal(files.statusCode, 200);
    assert.equal(files.json().files.some((item) => item.id === upload.json().file.id), true);

    const download = await app.inject({
      method: "GET",
      url: `/api/files/${upload.json().file.id}/download`,
      headers
    });
    assert.equal(download.statusCode, 200);
    assert.match(download.headers["content-disposition"], /attachment; filename=/);
    assert.equal(download.body, "commercial attachment");

    const audit = await app.inject({ method: "GET", url: "/api/audit", headers });
    assert.equal(audit.json().auditLogs.some((item) => item.content.includes("上传附件 审批凭证.txt")), true);
    assert.equal(audit.json().auditLogs.some((item) => item.content.includes("下载附件 审批凭证.txt")), true);

    await writeFile(join(fileStorageDir, storedFile.storageKey), "tampered attachment");
    const tamperedDownload = await app.inject({
      method: "GET",
      url: `/api/files/${upload.json().file.id}/download`,
      headers
    });
    assert.equal(tamperedDownload.statusCode, 409);
    assert.equal(tamperedDownload.json().error, "file_checksum_mismatch");
    const auditAfterTamper = await app.inject({ method: "GET", url: "/api/audit", headers });
    const tamperAudit = auditAfterTamper.json().auditLogs.find((item) => item.content.includes("拒绝下载异常附件 审批凭证.txt"));
    assert.equal(Boolean(tamperAudit), true);
    assert.equal(tamperAudit.result, "失败");

    const blocked = await app.inject({
      method: "POST",
      url: "/api/files",
      headers,
      payload: {
        fileName: "unsafe.html",
        mimeType: "text/html",
        contentBase64: Buffer.from("<script>alert(1)</script>").toString("base64"),
        visibility: "TENANT"
      }
    });
    assert.equal(blocked.statusCode, 415);
    assert.equal(blocked.json().error, "file_type_not_allowed");

    const auditAfterBlocked = await app.inject({ method: "GET", url: "/api/audit", headers });
    const blockedAudit = auditAfterBlocked.json().auditLogs.find((item) => item.content.includes("拒绝上传高风险附件 unsafe.html"));
    assert.equal(Boolean(blockedAudit), true);
    assert.equal(blockedAudit.result, "失败");

    const filesAfterBlocked = await app.inject({ method: "GET", url: "/api/files", headers });
    assert.equal(filesAfterBlocked.json().files.some((item) => item.fileName === "unsafe.html"), false);
  } finally {
    await app.close();
    await rm(fileStorageDir, { recursive: true, force: true });
  }
});

test("file download rejects unsafe storage keys even if the database row is tampered", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "deep-oa-file-path-"));
  const fileStorageDir = join(rootDir, "storage");
  await writeFile(join(rootDir, "outside.txt"), "outside secret");
  const app = await buildApp({
    logger: false,
    prisma: await makePrismaMock({ permissionCodes: ["file.read", "audit.read"] }),
    config: { fileStorageDir, jwtSecret: "test-secret" }
  });
  const headers = await loginHeaders(app);

  try {
    const tamperedFile = await app.prisma.fileObject.create({
      data: {
        tenantId: "tenant-default",
        uploaderUserId: "user-admin",
        fileName: "outside.txt",
        mimeType: "text/plain",
        storageKey: "../outside.txt",
        sizeBytes: BigInt(14),
        checksum: "tampered",
        visibility: "PRIVATE"
      }
    });

    const download = await app.inject({
      method: "GET",
      url: `/api/files/${tamperedFile.id}/download`,
      headers
    });
    assert.equal(download.statusCode, 404);
    assert.notEqual(download.body, "outside secret");

    const audit = await app.inject({ method: "GET", url: "/api/audit", headers });
    const deniedAudit = audit.json().auditLogs.find((item) => item.content.includes("拒绝下载异常附件 outside.txt"));
    assert.equal(Boolean(deniedAudit), true);
    assert.equal(deniedAudit.result, "失败");
  } finally {
    await app.close();
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("file upload rejects oversized content and unauthorized upload permission", async () => {
  const fileStorageDir = await mkdtemp(join(tmpdir(), "deep-oa-files-"));
  const uploadApp = await buildApp({
    logger: false,
    prisma: await makePrismaMock({ permissionCodes: ["file.upload"] }),
    config: { fileMaxUploadBytes: 4, fileStorageDir, jwtSecret: "test-secret" }
  });
  const uploadHeaders = await loginHeaders(uploadApp);

  try {
    const oversized = await uploadApp.inject({
      method: "POST",
      url: "/api/files",
      headers: uploadHeaders,
      payload: {
        fileName: "too-large.txt",
        mimeType: "text/plain",
        contentBase64: Buffer.from("12345").toString("base64")
      }
    });
    assert.equal(oversized.statusCode, 413);
    assert.equal(oversized.json().error, "file_too_large");
  } finally {
    await uploadApp.close();
  }

  const noPermissionApp = await buildApp({
    logger: false,
    prisma: await makePrismaMock({ permissionCodes: ["file.read"] }),
    config: { fileMaxUploadBytes: 1024, fileStorageDir, jwtSecret: "test-secret" }
  });
  const noPermissionHeaders = await loginHeaders(noPermissionApp);

  try {
    const denied = await noPermissionApp.inject({
      method: "POST",
      url: "/api/files",
      headers: noPermissionHeaders,
      payload: {
        fileName: "denied.txt",
        mimeType: "text/plain",
        contentBase64: Buffer.from("denied").toString("base64")
      }
    });
    assert.equal(denied.statusCode, 403);
  } finally {
    await noPermissionApp.close();
    await rm(fileStorageDir, { recursive: true, force: true });
  }
});

test("asset lifecycle actions enforce transitions and audit every operation", async () => {
  const app = await buildApp({
    logger: false,
    prisma: await makePrismaMock({ permissionCodes: ["asset.read", "asset.write", "audit.read"] }),
    config: { jwtSecret: "test-secret" }
  });
  const headers = await loginHeaders(app);

  const returned = await app.inject({
    method: "POST",
    url: "/api/assets/IT-2024-000123/actions",
    headers,
    payload: { action: "return", operator: "资产管理员" }
  });
  assert.equal(returned.statusCode, 200);
  assert.equal(returned.json().asset.status, "空闲");
  assert.equal(returned.json().asset.owner, "设备库");

  const borrowed = await app.inject({
    method: "POST",
    url: "/api/assets/IT-2024-000123/actions",
    headers,
    payload: { action: "borrow", owner: "李四", operator: "李四" }
  });
  assert.equal(borrowed.statusCode, 200);
  assert.equal(borrowed.json().asset.status, "借用中");
  assert.equal(borrowed.json().asset.owner, "李四");

  const duplicateBorrow = await app.inject({
    method: "POST",
    url: "/api/assets/IT-2024-000123/actions",
    headers,
    payload: { action: "borrow", owner: "王五", operator: "王五" }
  });
  assert.equal(duplicateBorrow.statusCode, 409);
  assert.equal(duplicateBorrow.json().error, "invalid_asset_transition");

  const repairing = await app.inject({
    method: "POST",
    url: "/api/assets/IT-2024-000123/actions",
    headers,
    payload: { action: "repair", operator: "IT维修员" }
  });
  assert.equal(repairing.statusCode, 200);
  assert.equal(repairing.json().asset.status, "维修中");

  const inventory = await app.inject({
    method: "POST",
    url: "/api/assets/IT-2024-000123/actions",
    headers,
    payload: { action: "inventory", operator: "资产管理员", result: "正常" }
  });
  assert.equal(inventory.statusCode, 200);
  assert.equal(inventory.json().asset.status, "维修中");
  assert.equal(inventory.json().asset.inventoryResult, "正常");

  const audit = await app.inject({ method: "GET", url: "/api/audit", headers });
  assert.equal(audit.json().auditLogs.some((item) => item.content.includes("当前状态不允许借用")), true);
  assert.equal(audit.json().auditLogs.some((item) => item.content.includes("完成盘点")), true);

  await app.close();
});

test("asset export returns backend CSV with formula escaping and audit row", async () => {
  const app = await buildApp({
    logger: false,
    prisma: await makePrismaMock({ permissionCodes: ["asset.read", "asset.export", "audit.read"] }),
    config: { jwtSecret: "test-secret" }
  });
  const headers = await loginHeaders(app);

  await app.prisma.asset.create({
    data: {
      id: "asset-formula",
      tenantId: "tenant-default",
      assetNo: "ADM-2026-000999",
      name: " =HYPERLINK(\"https://example.invalid\",\"open\")",
      category: "行政固定资产",
      owner: "设备库",
      status: "AVAILABLE",
      location: "集团总部 · 设备库",
      qrVersion: 2,
      metadata: {
        lastInventoryAt: "2026-05-29T12:00:00.000Z",
        lastInventoryResult: "正常"
      }
    }
  });

  const response = await app.inject({
    method: "POST",
    url: "/api/assets/export",
    headers,
    payload: { businessReason: "资产盘点核对", scope: "资产台账" }
  });

  assert.equal(response.statusCode, 200);
  assert.match(response.headers["content-type"], /text\/csv/);
  assert.match(response.headers["content-disposition"], /attachment; filename="asset-ledger-export-/);
  assert.equal(response.headers["x-row-count"], "2");
  assert.match(response.body, /资产编号/);
  assert.match(response.body, /IT-2024-000123/);
  assert.match(response.body, /"' =HYPERLINK/);

  const audit = await app.inject({ method: "GET", url: "/api/audit", headers });
  assert.equal(audit.statusCode, 200);
  assert.equal(audit.json().auditLogs.some((item) => item.content.includes("导出资产台账，后端生成资产台账")), true);

  await app.close();
});

test("asset export requires explicit export permission", async () => {
  const app = await buildApp({
    logger: false,
    prisma: await makePrismaMock({ permissionCodes: ["asset.read"] }),
    config: { jwtSecret: "test-secret" }
  });
  const headers = await loginHeaders(app);

  const response = await app.inject({
    method: "POST",
    url: "/api/assets/export",
    headers,
    payload: { businessReason: "资产盘点核对", scope: "资产台账" }
  });

  assert.equal(response.statusCode, 403);

  await app.close();
});

test("asset write routes return business errors for invalid status and missing records", async () => {
  const app = await buildApp({
    logger: false,
    prisma: await makePrismaMock({ permissionCodes: ["asset.read", "asset.write"] }),
    config: { jwtSecret: "test-secret" }
  });
  const headers = await loginHeaders(app);

  const invalidCreateStatus = await app.inject({
    method: "POST",
    url: "/api/assets",
    headers,
    payload: { name: "状态异常设备", category: "办公电脑", status: "损坏中" }
  });
  assert.equal(invalidCreateStatus.statusCode, 400);
  assert.equal(invalidCreateStatus.json().error, "invalid_asset_status");

  const missingPatch = await app.inject({
    method: "PATCH",
    url: "/api/assets/NO-SUCH-ASSET",
    headers,
    payload: { status: "空闲" }
  });
  assert.equal(missingPatch.statusCode, 404);
  assert.equal(missingPatch.json().error, "asset_not_found");

  const invalidPatchStatus = await app.inject({
    method: "PATCH",
    url: "/api/assets/IT-2024-000123",
    headers,
    payload: { status: "损坏中" }
  });
  assert.equal(invalidPatchStatus.statusCode, 400);
  assert.equal(invalidPatchStatus.json().error, "invalid_asset_status");

  const missingQr = await app.inject({
    method: "POST",
    url: "/api/assets/NO-SUCH-ASSET/qr",
    headers
  });
  assert.equal(missingQr.statusCode, 404);
  assert.equal(missingQr.json().error, "asset_not_found");

  const validPatch = await app.inject({
    method: "PATCH",
    url: "/api/assets/IT-2024-000123",
    headers,
    payload: { status: "空闲", owner: "设备库" }
  });
  assert.equal(validPatch.statusCode, 200);
  assert.equal(validPatch.json().asset.status, "空闲");

  const qr = await app.inject({
    method: "POST",
    url: "/api/assets/IT-2024-000123/qr",
    headers
  });
  assert.equal(qr.statusCode, 200);
  assert.equal(qr.json().asset.qrVersion, 2);
  assert.match(qr.json().asset.qrImage, /^data:image\/png;base64,/);
  assert.equal(JSON.parse(qr.json().asset.qrPayload).qrVersion, 2);

  await app.close();
});

test("asset actions default operator to the authenticated user", async () => {
  const app = await buildApp({
    logger: false,
    prisma: await makePrismaMock({
      permissionCodes: ["asset.read", "asset.write", "audit.read"],
      userName: "资产主管"
    }),
    config: { jwtSecret: "test-secret" }
  });
  const headers = await loginHeaders(app);

  const response = await app.inject({
    method: "POST",
    url: "/api/assets/IT-2024-000123/actions",
    headers,
    payload: { action: "inventory", result: "正常" }
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().asset.inventoryResult, "正常");

  const logs = await app.prisma.auditLog.findMany({ where: { action: "asset.inventory" }, take: 1 });
  assert.equal(logs[0].metadata.operator, "资产主管");

  const events = await app.inject({ method: "GET", url: "/api/assets/events", headers });
  assert.equal(events.statusCode, 200);
  assert.equal(events.json().assetEvents[0].operator, "资产主管");

  await app.close();
});

test("asset actions ignore client supplied operator identity", async () => {
  const app = await buildApp({
    logger: false,
    prisma: await makePrismaMock({
      permissionCodes: ["asset.read", "asset.write", "audit.read"],
      userName: "真实资产主管"
    }),
    config: { jwtSecret: "test-secret" }
  });
  const headers = await loginHeaders(app);

  const response = await app.inject({
    method: "POST",
    url: "/api/assets/IT-2024-000123/actions",
    headers,
    payload: { action: "inventory", operator: "伪造操作人", result: "正常" }
  });
  assert.equal(response.statusCode, 200);

  const logs = await app.prisma.auditLog.findMany({ where: { action: "asset.inventory" }, take: 1 });
  assert.equal(logs[0].metadata.operator, "真实资产主管");

  const events = await app.inject({ method: "GET", url: "/api/assets/events", headers });
  assert.equal(events.json().assetEvents[0].operator, "真实资产主管");

  await app.close();
});

test("attendance finance request and payroll APIs persist business records and write audit rows", async () => {
  const app = await buildApp({
    logger: false,
    prisma: await makePrismaMock({
      permissionCodes: ["attendance.read", "attendance.write", "finance.read", "finance.write", "workflow.approve", "audit.read"]
    }),
    config: { jwtSecret: "test-secret" }
  });
  const headers = await loginHeaders(app);

  const leaveList = await app.inject({ method: "GET", url: "/api/attendance/leaves", headers });
  assert.equal(leaveList.statusCode, 200);
  assert.equal(leaveList.json().leaves[0].status, "待审批");

  const records = await app.inject({ method: "GET", url: "/api/attendance/records?status=LATE", headers });
  assert.equal(records.statusCode, 200);
  assert.equal(records.json().attendanceRecords.length, 1);
  assert.equal(records.json().attendanceRecords[0].status, "迟到");
  assert.equal(records.json().attendanceRecords[0].minutesLate, 18);

  const createdRecord = await app.inject({
    method: "POST",
    url: "/api/attendance/records",
    headers,
    payload: {
      employee: "赵六",
      department: "行政部",
      workDate: "2026-06-01",
      checkIn: "2026-06-01 09:12",
      checkOut: "2026-06-01 18:01",
      status: "迟到",
      minutesLate: 12,
      reason: "交通拥堵"
    }
  });
  assert.equal(createdRecord.statusCode, 201);
  assert.equal(createdRecord.json().attendanceRecord.employee, "赵六");
  assert.equal(createdRecord.json().attendanceRecord.status, "迟到");

  const createdLeave = await app.inject({
    method: "POST",
    url: "/api/attendance/leaves",
    headers,
    payload: {
      employee: "赵六",
      type: "病假",
      dates: "2026-06-01",
      days: 1,
      handover: "李四",
      idempotencyKey: "leave-submit-idempotent"
    }
  });
  assert.equal(createdLeave.statusCode, 201);
  assert.equal(createdLeave.json().leave.employee, "赵六");
  assert.equal(createdLeave.json().leave.status, "待审批");
  assert.ok(createdLeave.json().leave.workflowInstanceId);

  const repeatedLeave = await app.inject({
    method: "POST",
    url: "/api/attendance/leaves",
    headers,
    payload: {
      employee: "赵六重复",
      type: "病假",
      dates: "2026-06-02",
      days: 2,
      idempotencyKey: "leave-submit-idempotent"
    }
  });
  assert.equal(repeatedLeave.statusCode, 200);
  assert.equal(repeatedLeave.json().alreadySubmitted, true);
  assert.equal(repeatedLeave.json().leave.workflowInstanceId, createdLeave.json().leave.workflowInstanceId);
  assert.equal(repeatedLeave.json().leave.employee, "赵六");

  const payrolls = await app.inject({ method: "GET", url: "/api/finance/payrolls", headers });
  assert.equal(payrolls.statusCode, 200);
  assert.equal(payrolls.json().payrolls.some((item) => item.id === "PAYROLL-202605"), true);

  const financeRequests = await app.inject({ method: "GET", url: "/api/finance/requests?type=EXPENSE", headers });
  assert.equal(financeRequests.statusCode, 200);
  assert.equal(financeRequests.json().financeRequests.some((item) => item.id === "EXP-202605-0001"), true);

  const createdFinanceRequest = await app.inject({
    method: "POST",
    url: "/api/finance/requests",
    headers,
    payload: {
      requestNo: "EXP-202606-0001",
      type: "EXPENSE",
      title: "2026年6月差旅报销",
      department: "行政部",
      amount: 3280.5,
      vendor: "携程商旅",
      paymentMethod: "员工垫付",
      purpose: "外地招聘面试",
      idempotencyKey: "finance-request-submit-idempotent"
    }
  });
  assert.equal(createdFinanceRequest.statusCode, 201);
  assert.equal(createdFinanceRequest.json().financeRequest.id, "EXP-202606-0001");
  assert.equal(createdFinanceRequest.json().financeRequest.typeLabel, "费用报销");
  assert.equal(createdFinanceRequest.json().financeRequest.status, "待审批");
  assert.ok(createdFinanceRequest.json().financeRequest.workflowInstanceId);

  const repeatedFinanceRequest = await app.inject({
    method: "POST",
    url: "/api/finance/requests",
    headers,
    payload: {
      requestNo: "EXP-202606-RETRY",
      type: "EXPENSE",
      title: "不应创建的重复报销",
      department: "行政部",
      amount: 1,
      idempotencyKey: "finance-request-submit-idempotent"
    }
  });
  assert.equal(repeatedFinanceRequest.statusCode, 200);
  assert.equal(repeatedFinanceRequest.json().alreadySubmitted, true);
  assert.equal(repeatedFinanceRequest.json().financeRequest.id, "EXP-202606-0001");

  const firstFinanceApproval = await app.inject({
    method: "POST",
    url: `/api/approvals/${createdFinanceRequest.json().financeRequest.workflowInstanceId}/decision`,
    headers,
    payload: {
      decision: "pass",
      approverName: "张三",
      idempotencyKey: "finance-request-approve-zhang"
    }
  });
  assert.equal(firstFinanceApproval.statusCode, 200);
  const pendingFinanceRequest = await app.prisma.financeRequest.findFirst({
    where: { tenantId: "tenant-default", requestNo: "EXP-202606-0001" }
  });
  assert.equal(pendingFinanceRequest.status, "PENDING_APPROVAL");

  const finalFinanceApproval = await app.inject({
    method: "POST",
    url: `/api/approvals/${createdFinanceRequest.json().financeRequest.workflowInstanceId}/decision`,
    headers,
    payload: {
      decision: "pass",
      approverName: "李四",
      idempotencyKey: "finance-request-approve-li"
    }
  });
  assert.equal(finalFinanceApproval.statusCode, 200);
  const approvedFinanceRequest = await app.prisma.financeRequest.findFirst({
    where: { tenantId: "tenant-default", requestNo: "EXP-202606-0001" }
  });
  assert.equal(approvedFinanceRequest.status, "APPROVED");
  const approvedFinanceRequests = await app.inject({ method: "GET", url: "/api/finance/requests?type=EXPENSE", headers });
  assert.equal(approvedFinanceRequests.json().financeRequests.find((item) => item.id === "EXP-202606-0001").status, "已通过");

  const invalidFinanceRequest = await app.inject({
    method: "POST",
    url: "/api/finance/requests",
    headers,
    payload: { type: "PAYMENT", title: "金额错误付款申请", amount: 0 }
  });
  assert.equal(invalidFinanceRequest.statusCode, 400);
  assert.equal(invalidFinanceRequest.json().error, "finance_request_invalid_amount");

  const createdPayroll = await app.inject({
    method: "POST",
    url: "/api/finance/payrolls",
    headers,
    payload: {
      batchNo: "PAYROLL-202606",
      cycle: "2026年6月",
      scope: "全员",
      headcount: 72,
      totalAmount: 680000,
      idempotencyKey: "payroll-submit-idempotent"
    }
  });
  assert.equal(createdPayroll.statusCode, 201);
  assert.equal(createdPayroll.json().payroll.id, "PAYROLL-202606");
  assert.equal(createdPayroll.json().payroll.status, "待复核");
  assert.equal(createdPayroll.json().payroll.workflowStatus, "PENDING");
  assert.ok(createdPayroll.json().payroll.workflowInstanceId);

  const repeatedPayroll = await app.inject({
    method: "POST",
    url: "/api/finance/payrolls",
    headers,
    payload: {
      batchNo: "PAYROLL-202606-RETRY",
      cycle: "2026年6月重复",
      scope: "不应创建",
      headcount: 1,
      totalAmount: 1,
      idempotencyKey: "payroll-submit-idempotent"
    }
  });
  assert.equal(repeatedPayroll.statusCode, 200);
  assert.equal(repeatedPayroll.json().alreadySubmitted, true);
  assert.equal(repeatedPayroll.json().payroll.id, "PAYROLL-202606");

  const blockedPayrollPublish = await app.inject({
    method: "POST",
    url: "/api/finance/payrolls/PAYROLL-202606/review",
    headers,
    payload: { comment: "审批未通过前不允许发布" }
  });
  assert.equal(blockedPayrollPublish.statusCode, 409);
  assert.equal(blockedPayrollPublish.json().error, "payroll_workflow_not_approved");

  const reviewed = await app.inject({
    method: "POST",
    url: "/api/finance/payrolls/PAYROLL-202605/review",
    headers,
    payload: { comment: "复核通过" }
  });
  assert.equal(reviewed.statusCode, 200);
  assert.equal(reviewed.json().payroll.status, "已发布");

  const invalid = await app.inject({
    method: "POST",
    url: "/api/finance/payrolls/PAYROLL-202604/review",
    headers,
    payload: { comment: "归档批次不允许发布" }
  });
  assert.equal(invalid.statusCode, 409);
  assert.equal(invalid.json().error, "invalid_payroll_status");

  const audit = await app.inject({ method: "GET", url: "/api/audit", headers });
  assert.equal(audit.json().auditLogs.some((item) => item.content.includes("录入赵六 2026-06-01 考勤记录")), true);
  assert.equal(audit.json().auditLogs.some((item) => item.content.includes("提交请假审批流程")), true);
  assert.equal(audit.json().auditLogs.some((item) => item.content.includes("提交病假申请")), true);
  assert.equal(audit.json().auditLogs.some((item) => item.content.includes("提交工资单复核流程")), true);
  assert.equal(audit.json().auditLogs.some((item) => item.content.includes("提交费用报销审批流程")), true);
  assert.equal(audit.json().auditLogs.some((item) => item.content.includes("EXP-202606-0001 费用报销创建并提交审批")), true);
  assert.equal(audit.json().auditLogs.some((item) => item.content.includes("工资单创建并提交复核")), true);
  assert.equal(audit.json().auditLogs.some((item) => item.content.includes("审批未全部通过，不能发布工资单")), true);
  assert.equal(audit.json().auditLogs.some((item) => item.content.includes("工资单复核发布")), true);
  assert.equal(audit.json().auditLogs.some((item) => item.content.includes("当前状态不允许发布")), true);

  await app.close();
});

test("attendance record export returns backend CSV with formula escaping and audit row", async () => {
  const app = await buildApp({
    logger: false,
    prisma: await makePrismaMock({ permissionCodes: ["attendance.read", "attendance.export", "audit.read"] }),
    config: { jwtSecret: "test-secret" }
  });
  const headers = await loginHeaders(app);

  await app.prisma.attendanceRecord.create({
    data: {
      tenantId: "tenant-default",
      employeeName: " =HYPERLINK(\"https://example.invalid\",\"open\")",
      department: "行政部",
      workDate: new Date("2026-06-03T00:00:00.000Z"),
      checkInAt: new Date("2026-06-03T09:22:00.000Z"),
      checkOutAt: new Date("2026-06-03T18:05:00.000Z"),
      status: "LATE",
      minutesLate: 22,
      source: " =cmd|' /C calc'!A0",
      metadata: { reason: "formula guard" }
    }
  });

  const response = await app.inject({
    method: "POST",
    url: "/api/attendance/records/export",
    headers,
    payload: { businessReason: "考勤异常核对", scope: "考勤记录台账", filters: { status: "LATE" } }
  });

  assert.equal(response.statusCode, 200);
  assert.match(response.headers["content-type"], /text\/csv/);
  assert.match(response.headers["content-disposition"], /attachment; filename="attendance-record-export-/);
  assert.equal(response.headers["x-row-count"], "2");
  assert.match(response.body, /考勤日期/);
  assert.match(response.body, /李四/);
  assert.match(response.body, /"' =HYPERLINK/);
  assert.match(response.body, /"' =cmd/);

  const audit = await app.inject({ method: "GET", url: "/api/audit", headers });
  assert.equal(audit.statusCode, 200);
  assert.equal(audit.json().auditLogs.some((item) => item.content.includes("导出考勤记录台账，后端生成考勤记录台账")), true);

  await app.close();
});

test("attendance record export requires explicit export permission", async () => {
  const app = await buildApp({
    logger: false,
    prisma: await makePrismaMock({ permissionCodes: ["attendance.read", "audit.read"] }),
    config: { jwtSecret: "test-secret" }
  });
  const headers = await loginHeaders(app);

  const response = await app.inject({
    method: "POST",
    url: "/api/attendance/records/export",
    headers,
    payload: { businessReason: "考勤异常核对", scope: "考勤记录台账" }
  });

  assert.equal(response.statusCode, 403);

  await app.close();
});

test("finance request export returns backend CSV with formula escaping and audit row", async () => {
  const app = await buildApp({
    logger: false,
    prisma: await makePrismaMock({ permissionCodes: ["finance.read", "finance.export", "audit.read"] }),
    config: { jwtSecret: "test-secret" }
  });
  const headers = await loginHeaders(app);

  await app.prisma.financeRequest.create({
    data: {
      id: "finance-request-formula",
      tenantId: "tenant-default",
      requestNo: "EXP-202606-FORMULA",
      requestType: "EXPENSE",
      title: " =HYPERLINK(\"https://example.invalid\",\"open\")",
      applicantUserId: "user-admin",
      department: "行政部",
      amount: 99.9,
      currency: "CNY",
      vendor: " =cmd|' /C calc'!A0",
      paymentMethod: "员工垫付",
      status: "PENDING_APPROVAL",
      workflowInstanceId: "wf-expense",
      metadata: { purpose: "formula guard" }
    }
  });

  const response = await app.inject({
    method: "POST",
    url: "/api/finance/requests/export",
    headers,
    payload: { businessReason: "财务月度复核", scope: "财务单据台账", filters: { type: "EXPENSE" } }
  });

  assert.equal(response.statusCode, 200);
  assert.match(response.headers["content-type"], /text\/csv/);
  assert.match(response.headers["content-disposition"], /attachment; filename="finance-request-export-/);
  assert.equal(response.headers["x-row-count"], "2");
  assert.match(response.body, /单据编号/);
  assert.match(response.body, /EXP-202605-0001/);
  assert.match(response.body, /"' =HYPERLINK/);
  assert.match(response.body, /"' =cmd/);

  const audit = await app.inject({ method: "GET", url: "/api/audit", headers });
  assert.equal(audit.statusCode, 200);
  assert.equal(audit.json().auditLogs.some((item) => item.content.includes("导出财务单据台账，后端生成付款报销台账")), true);

  await app.close();
});

test("finance request export requires explicit export permission", async () => {
  const app = await buildApp({
    logger: false,
    prisma: await makePrismaMock({ permissionCodes: ["finance.read", "audit.read"] }),
    config: { jwtSecret: "test-secret" }
  });
  const headers = await loginHeaders(app);

  const response = await app.inject({
    method: "POST",
    url: "/api/finance/requests/export",
    headers,
    payload: { businessReason: "财务月度复核", scope: "财务单据台账" }
  });

  assert.equal(response.statusCode, 403);

  await app.close();
});

test("leave workflow defaults applicant to the authenticated user", async () => {
  const app = await buildApp({
    logger: false,
    prisma: await makePrismaMock({
      permissionCodes: ["attendance.read", "attendance.write", "audit.read"],
      userName: "请假申请人"
    }),
    config: { jwtSecret: "test-secret" }
  });
  const headers = await loginHeaders(app);

  const response = await app.inject({
    method: "POST",
    url: "/api/attendance/leaves",
    headers,
    payload: {
      employee: "赵六",
      type: "年假",
      dates: "2026-06-02",
      days: 1,
      handover: "李四"
    }
  });
  assert.equal(response.statusCode, 201);

  const workflow = await app.prisma.workflowInstance.findFirst({
    where: { id: response.json().leave.workflowInstanceId }
  });
  assert.equal(workflow.formData.applicant, "请假申请人");

  await app.close();
});

test("approval rule save normalizes department approvers as AND-sign nodes", async () => {
  const app = await buildApp({
    logger: false,
    prisma: await makePrismaMock({
      permissionCodes: ["workflow.read", "workflow.write"],
      extraUsers: [
        { id: "user-wang", name: "王五", email: "wangwu@oa.local" },
        { id: "user-li", name: "李四", email: "lisi@oa.local" },
        { id: "user-finance", name: "财务负责人", email: "finance-lead@oa.local" }
      ]
    }),
    config: { jwtSecret: "test-secret" }
  });
  const headers = await loginHeaders(app);

  const response = await app.inject({
    method: "POST",
    url: "/api/approvals/rules",
    headers,
    payload: {
      department: "  财务中心  ",
      templateId: "expense",
      templateName: "费用报销",
      nodes: [
        { id: "manager", name: "  部门会签  ", mode: "OR", approvers: ["王五", " 王五 ", "李四"] },
        { id: "finance", name: "财务复核", approvers: "财务负责人，财务专员" }
      ]
    }
  });

  assert.equal(response.statusCode, 201);
  assert.equal(response.json().department, "财务中心");
  assert.equal(response.json().nodes[0].mode, "AND");
  assert.deepEqual(response.json().nodes[0].approvers, ["王五", "李四"]);
  assert.deepEqual(response.json().nodes[0].approverUsers.map((item) => item.userId), ["user-wang", "user-li"]);
  assert.deepEqual(response.json().nodes[1].approvers, ["财务负责人", "财务专员"]);
  assert.deepEqual(response.json().nodes[1].approverUsers.map((item) => item.userId), ["user-finance", null]);

  const created = await app.inject({
    method: "POST",
    url: "/api/approvals",
    headers,
    payload: {
      definitionId: "expense",
      title: "实名审批人绑定验证",
      department: "财务中心",
      formData: { amount: 128, reason: "商用审批配置验收" }
    }
  });
  assert.equal(created.statusCode, 201);
  const workflow = await app.prisma.workflowInstance.findFirst({ where: { id: created.json().approval.id } });
  assert.deepEqual(workflow.nodes[0].approvers.map((item) => item.userId), ["user-wang", "user-li"]);

  await app.close();
});

test("approval rule preview resolves active department rule and audits the preview", async () => {
  const app = await buildApp({
    logger: false,
    prisma: await makePrismaMock({ permissionCodes: ["workflow.read", "audit.read"] }),
    config: { jwtSecret: "test-secret" }
  });
  const headers = await loginHeaders(app);

  const response = await app.inject({
    method: "GET",
    url: `/api/approvals/rules/preview?department=${encodeURIComponent("行政部")}&templateId=expense`,
    headers
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.json().preview.source, "department_rule");
  assert.equal(response.json().preview.ruleId, "rule-1");
  assert.equal(response.json().preview.nodes[0].mode, "AND");
  assert.deepEqual(response.json().preview.nodes[0].approvers, ["张三", "李四"]);

  const audit = await app.inject({ method: "GET", url: "/api/audit", headers });
  assert.equal(audit.json().auditLogs.some((item) => item.content.includes("预览部门审批规则")), true);

  await app.close();
});

test("approval rule coverage reports department workflow matrix and approver binding gaps", async () => {
  const app = await buildApp({
    logger: false,
    prisma: await makePrismaMock({
      permissionCodes: ["workflow.read"],
      departments: [{ id: "dept-finance", tenantId: "tenant-default", code: "FIN", name: "财务中心" }],
      extraUsers: [
        { id: "user-zhang", name: "张三", email: "zhangsan@oa.local" },
        { id: "user-li", name: "李四", email: "lisi@oa.local" }
      ]
    }),
    config: { jwtSecret: "test-secret" }
  });
  const headers = await loginHeaders(app);

  const response = await app.inject({
    method: "GET",
    url: "/api/approvals/rules/coverage",
    headers
  });

  assert.equal(response.statusCode, 200);
  const coverage = response.json().approvalRuleCoverage;
  assert.equal(coverage.summary.departmentCount, 2);
  assert.equal(coverage.summary.templateCount, 4);
  assert.equal(coverage.summary.totalCells, 8);
  assert(coverage.summary.configuredCount >= 3);
  assert(coverage.summary.fallbackCount >= 1);

  const expenseAdmin = coverage.rows.find((row) => row.department === "行政部" && row.templateId === "expense");
  assert.equal(expenseAdmin.source, "department_rule");
  assert.equal(expenseAdmin.status, "configured");
  assert.equal(expenseAdmin.ruleId, "rule-1");
  assert.equal(expenseAdmin.totalApproverCount, 2);
  assert.equal(expenseAdmin.resolvedApproverCount, 2);
  assert.deepEqual(expenseAdmin.unresolvedApprovers, []);

  const financeExpense = coverage.rows.find((row) => row.department === "财务中心" && row.templateId === "expense");
  assert.equal(financeExpense.source, "workflow_definition");
  assert.equal(financeExpense.status, "fallback");
  assert.equal(financeExpense.ruleId, null);

  const transferAdmin = coverage.rows.find((row) => row.department === "行政部" && row.templateId === "transfer");
  assert.equal(transferAdmin.source, "department_rule");
  assert.equal(transferAdmin.hasUnresolvedApprovers, true);
  assert(transferAdmin.unresolvedApprovers.includes("王五"));
  assert(transferAdmin.unresolvedApprovers.includes("HRBP"));

  await app.close();
});

test("disabled approval rules are ignored by preview and new workflow snapshots", async () => {
  const app = await buildApp({
    logger: false,
    prisma: await makePrismaMock({ permissionCodes: ["workflow.read", "workflow.write"] }),
    config: { jwtSecret: "test-secret" }
  });
  const headers = await loginHeaders(app);

  const disabled = await app.inject({
    method: "PUT",
    url: "/api/approvals/rules/rule-leave",
    headers,
    payload: {
      department: "行政部",
      templateId: "leave",
      templateName: "请假申请",
      enabled: false,
      nodes: [{ id: "wrong", name: "停用后不应出现", approvers: ["错误审批人"] }]
    }
  });
  assert.equal(disabled.statusCode, 200);
  assert.equal(disabled.json().enabled, false);

  const preview = await app.inject({
    method: "GET",
    url: `/api/approvals/rules/preview?department=${encodeURIComponent("行政部")}&templateId=leave`,
    headers
  });
  assert.equal(preview.statusCode, 200);
  assert.equal(preview.json().preview.source, "workflow_definition");
  assert.equal(preview.json().preview.ruleId, null);
  assert.equal(preview.json().preview.nodes[0].name, "直属负责人审批");
  assert.equal(preview.json().preview.nodes.some((node) => node.approvers.includes("错误审批人")), false);

  const created = await app.inject({
    method: "POST",
    url: "/api/approvals",
    headers,
    payload: {
      definitionId: "leave",
      department: "行政部",
      title: "停用规则回退验收",
      formData: { applicant: "请假申请人", days: 1 }
    }
  });
  assert.equal(created.statusCode, 201);
  assert.equal(created.json().approval.approvalNodes[0].name, "直属负责人审批");
  assert.equal(created.json().approval.approvers.includes("错误审批人"), false);

  const workflow = await app.prisma.workflowInstance.findFirst({
    where: { id: created.json().approval.id }
  });
  assert.equal(workflow.definitionSnapshot.ruleId, null);
  assert.equal(workflow.definitionSnapshot.nodes[0].name, "直属负责人审批");

  await app.close();
});

test("approval rule save rejects empty nodes and approvers", async () => {
  const app = await buildApp({
    logger: false,
    prisma: await makePrismaMock({ permissionCodes: ["workflow.read", "workflow.write"] }),
    config: { jwtSecret: "test-secret" }
  });
  const headers = await loginHeaders(app);

  const noNodes = await app.inject({
    method: "POST",
    url: "/api/approvals/rules",
    headers,
    payload: { department: "行政部", templateId: "expense", nodes: [] }
  });
  assert.equal(noNodes.statusCode, 400);
  assert.equal(noNodes.json().error, "approval_rule_nodes_required");

  const noApprovers = await app.inject({
    method: "POST",
    url: "/api/approvals/rules",
    headers,
    payload: {
      department: "行政部",
      templateId: "expense",
      nodes: [{ id: "manager", name: "部门会签", approvers: [] }]
    }
  });
  assert.equal(noApprovers.statusCode, 400);
  assert.equal(noApprovers.json().error, "approval_rule_approvers_required");

  await app.close();
});

test("approval rule update is scoped to the authenticated tenant", async () => {
  const app = await buildApp({
    logger: false,
    prisma: await makePrismaMock({ permissionCodes: ["workflow.read", "workflow.write"] }),
    config: { jwtSecret: "test-secret" }
  });
  const headers = await loginHeaders(app);

  const response = await app.inject({
    method: "PUT",
    url: "/api/approvals/rules/rule-from-other-tenant",
    headers,
    payload: {
      department: "行政部",
      templateId: "expense",
      templateName: "费用报销",
      nodes: [{ id: "manager", name: "部门会签", approvers: ["张三"] }]
    }
  });

  assert.equal(response.statusCode, 404);
  assert.equal(response.json().error, "approval_rule_not_found");

  await app.close();
});

test("approval rule delete is scoped and audit logged", async () => {
  const app = await buildApp({
    logger: false,
    prisma: await makePrismaMock({ permissionCodes: ["workflow.read", "workflow.write", "audit.read"] }),
    config: { jwtSecret: "test-secret" }
  });
  const headers = await loginHeaders(app);

  const deleted = await app.inject({
    method: "DELETE",
    url: "/api/approvals/rules/rule-1",
    headers
  });
  assert.equal(deleted.statusCode, 204);

  const rules = await app.inject({ method: "GET", url: "/api/approvals/rules", headers });
  assert.equal(rules.statusCode, 200);
  assert.equal(rules.json().approvalRules.some((rule) => rule.id === "rule-1"), false);

  const missing = await app.inject({
    method: "DELETE",
    url: "/api/approvals/rules/rule-from-other-tenant",
    headers
  });
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.json().error, "approval_rule_not_found");

  const audit = await app.inject({ method: "GET", url: "/api/audit", headers });
  assert.equal(audit.json().auditLogs.some((item) => item.content.includes("删除部门审批规则")), true);

  await app.close();
});

test("approval comments use the authenticated actor name", async () => {
  const app = await buildApp({
    logger: false,
    prisma: await makePrismaMock({
      permissionCodes: ["workflow.read", "workflow.write", "audit.read"],
      userName: "审批评论员"
    }),
    config: { jwtSecret: "test-secret" }
  });
  const headers = await loginHeaders(app);

  const response = await app.inject({
    method: "POST",
    url: "/api/approvals/wf-pending/comments",
    headers,
    payload: { content: "请补充发票" }
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().comment.author, "审批评论员");

  const approvals = await app.inject({ method: "GET", url: "/api/approvals", headers });
  const approval = approvals.json().approvals.find((item) => item.id === "wf-pending");
  assert.equal(approval.comments.some((item) => item.author === "审批评论员" && item.content === "请补充发票"), true);

  await app.close();
});

test("approval withdraw is limited to applicant or admin and audits denied attempts", async () => {
  const app = await buildApp({
    logger: false,
    prisma: await makePrismaMock({
      permissionCodes: ["workflow.read", "workflow.write", "audit.read"],
      roleCode: "workflow-writer",
      roleName: "流程经办人",
      userName: "流程经办人",
      workflowApplicantUserId: "other-user"
    }),
    config: { jwtSecret: "test-secret" }
  });
  const headers = await loginHeaders(app);

  const denied = await app.inject({
    method: "POST",
    url: "/api/approvals/wf-pending/withdraw",
    headers
  });
  assert.equal(denied.statusCode, 403);
  assert.equal(denied.json().error, "withdraw_identity_denied");

  const approvals = await app.inject({ method: "GET", url: "/api/approvals", headers });
  const approval = approvals.json().approvals.find((item) => item.id === "wf-pending");
  assert.equal(approval.status, "待审批");

  const audit = await app.inject({ method: "GET", url: "/api/audit", headers });
  assert.equal(audit.json().auditLogs.some((item) => item.content.includes("当前用户不是申请人或管理员")), true);

  await app.close();
});

test("approval withdraw allows the applicant", async () => {
  const app = await buildApp({
    logger: false,
    prisma: await makePrismaMock({
      permissionCodes: ["workflow.read", "workflow.write", "audit.read"],
      roleCode: "workflow-applicant",
      roleName: "流程申请人",
      userName: "流程申请人"
    }),
    config: { jwtSecret: "test-secret" }
  });
  const headers = await loginHeaders(app);

  const response = await app.inject({
    method: "POST",
    url: "/api/approvals/wf-pending/withdraw",
    headers
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().ok, true);

  const approvals = await app.inject({ method: "GET", url: "/api/approvals", headers });
  const approval = approvals.json().approvals.find((item) => item.id === "wf-pending");
  assert.equal(approval.status, "已撤回");

  const audit = await app.inject({ method: "GET", url: "/api/audit", headers });
  assert.equal(audit.json().auditLogs.some((item) => item.content.includes("撤回审批实例")), true);

  await app.close();
});

test("approval decision rejects approvers outside the current pending node", async () => {
  const app = await buildApp({
    logger: false,
    prisma: await makePrismaMock({ permissionCodes: ["system.admin", "workflow.read", "workflow.approve", "audit.read"] }),
    config: { jwtSecret: "test-secret" }
  });
  const headers = await loginHeaders(app);

  const denied = await app.inject({
    method: "POST",
    url: "/api/approvals/wf-pending/decision",
    headers,
    payload: {
      approverName: "陌生审批人",
      decision: "pass",
      idempotencyKey: "denied-approver"
    }
  });
  assert.equal(denied.statusCode, 403);
  assert.equal(denied.json().error, "approver_not_assigned");

  const allowed = await app.inject({
    method: "POST",
    url: "/api/approvals/wf-pending/decision",
    headers,
    payload: {
      approverName: "张三",
      decision: "pass",
      idempotencyKey: "allowed-zhang"
    }
  });
  assert.equal(allowed.statusCode, 200);
  assert.equal(allowed.json().ok, true);

  const approvals = await app.inject({ method: "GET", url: "/api/approvals", headers });
  const approval = approvals.json().approvals.find((item) => item.id === "wf-pending");
  assert.equal(approval.approvalNodes[0].decisions.find((item) => item.approver === "张三").status, "已同意");
  assert.equal(approval.approvalNodes[0].decisions.find((item) => item.approver === "李四").status, "待审批");

  const audit = await app.inject({ method: "GET", url: "/api/audit", headers });
  assert.equal(audit.json().auditLogs.some((item) => item.content.includes("审批人不在当前节点待处理人内")), true);

  await app.close();
});

test("approval decision locks the workflow instance before mutating approver state", async () => {
  const prisma = await makePrismaMock({ permissionCodes: ["system.admin", "workflow.read", "workflow.approve", "audit.read"] });
  const rawCalls = [];
  const originalQueryRaw = prisma.$queryRaw;
  prisma.$queryRaw = async (strings, ...values) => {
    rawCalls.push({ sql: Array.from(strings).join("?"), values });
    return originalQueryRaw(strings, ...values);
  };
  const app = await buildApp({
    logger: false,
    prisma,
    config: { jwtSecret: "test-secret" }
  });
  const headers = await loginHeaders(app);

  const response = await app.inject({
    method: "POST",
    url: "/api/approvals/wf-pending/decision",
    headers,
    payload: {
      approverName: "张三",
      decision: "pass",
      idempotencyKey: "lock-check-zhang"
    }
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().ok, true);
  assert.equal(rawCalls.some((call) => (
    call.sql.includes("FROM workflow_instances")
    && call.sql.includes("FOR UPDATE")
    && call.values.includes("wf-pending")
    && call.values.includes("tenant-default")
  )), true);

  await app.close();
});

test("approval decision rechecks idempotency after acquiring the workflow lock", async () => {
  const prisma = await makePrismaMock({ permissionCodes: ["system.admin", "workflow.read", "workflow.approve", "audit.read"] });
  const app = await buildApp({
    logger: false,
    prisma,
    config: { jwtSecret: "test-secret" }
  });
  const headers = await loginHeaders(app);

  const first = await app.inject({
    method: "POST",
    url: "/api/approvals/wf-pending/decision",
    headers,
    payload: {
      approverName: "张三",
      decision: "pass",
      idempotencyKey: "repeat-after-lock"
    }
  });
  assert.equal(first.statusCode, 200);
  assert.equal(first.json().ok, true);

  const originalFindUnique = prisma.workflowApprover.findUnique;
  let idempotencyReads = 0;
  prisma.workflowApprover.findUnique = async (args) => {
    const key = args?.where?.tenantId_idempotencyKey?.idempotencyKey;
    if (key === "repeat-after-lock") {
      idempotencyReads += 1;
      if (idempotencyReads === 1) return null;
    }
    return originalFindUnique(args);
  };

  const repeated = await app.inject({
    method: "POST",
    url: "/api/approvals/wf-pending/decision",
    headers,
    payload: {
      approverName: "张三",
      decision: "pass",
      idempotencyKey: "repeat-after-lock"
    }
  });
  assert.equal(repeated.statusCode, 200);
  assert.equal(repeated.json().ok, true);
  assert.equal(repeated.json().alreadyProcessed, true);
  assert.equal(idempotencyReads, 2);

  const audit = await app.inject({ method: "GET", url: "/api/audit", headers });
  assert.equal(audit.json().auditLogs.some((item) => item.content.includes("审批人不在当前节点待处理人内")), false);

  await app.close();
});

test("approval transfer creates a replacement pending approver and keeps the workflow movable", async () => {
  const app = await buildApp({
    logger: false,
    prisma: await makePrismaMock({ permissionCodes: ["system.admin", "workflow.read", "workflow.approve", "audit.read"] }),
    config: { jwtSecret: "test-secret" }
  });
  const headers = await loginHeaders(app);

  const transferred = await app.inject({
    method: "POST",
    url: "/api/approvals/wf-pending/transfer",
    headers,
    payload: {
      sourceApproverName: "张三",
      target: "王五",
      comment: "张三请假，转交王五处理"
    }
  });
  assert.equal(transferred.statusCode, 200);
  assert.equal(transferred.json().ok, true);

  let approvals = await app.inject({ method: "GET", url: "/api/approvals", headers });
  let approval = approvals.json().approvals.find((item) => item.id === "wf-pending");
  assert.equal(approval.approvalNodes[0].decisions.find((item) => item.approver === "张三").status, "已转交");
  assert.equal(approval.approvalNodes[0].decisions.find((item) => item.approver === "王五").status, "待审批");

  const targetDecision = await app.inject({
    method: "POST",
    url: "/api/approvals/wf-pending/decision",
    headers,
    payload: {
      approverName: "王五",
      decision: "pass",
      idempotencyKey: "transfer-target-pass"
    }
  });
  assert.equal(targetDecision.statusCode, 200);

  approvals = await app.inject({ method: "GET", url: "/api/approvals", headers });
  approval = approvals.json().approvals.find((item) => item.id === "wf-pending");
  assert.equal(approval.node, "部门会签");
  assert.equal(approval.approvalNodes[0].decisions.find((item) => item.approver === "王五").status, "已同意");
  assert.equal(approval.approvalNodes[0].decisions.find((item) => item.approver === "李四").status, "待审批");

  const finalNodeDecision = await app.inject({
    method: "POST",
    url: "/api/approvals/wf-pending/decision",
    headers,
    payload: {
      approverName: "李四",
      decision: "pass",
      idempotencyKey: "transfer-final-node-pass"
    }
  });
  assert.equal(finalNodeDecision.statusCode, 200);

  approvals = await app.inject({ method: "GET", url: "/api/approvals", headers });
  approval = approvals.json().approvals.find((item) => item.id === "wf-pending");
  assert.equal(approval.node, "财务复核");
  assert.equal(approval.status, "待审批");

  const audit = await app.inject({ method: "GET", url: "/api/audit", headers });
  assert.equal(audit.json().auditLogs.some((item) => item.content.includes("转交审批任务")), true);

  await app.close();
});

test("approval action denies non-admin approver impersonation but allows self approval", async () => {
  const app = await buildApp({
    logger: false,
    prisma: await makePrismaMock({
      permissionCodes: ["workflow.read", "workflow.approve", "audit.read"],
      roleCode: "approver",
      roleName: "普通审批人",
      userName: "张三"
    }),
    config: { jwtSecret: "test-secret" }
  });
  const headers = await loginHeaders(app);

  const impersonated = await app.inject({
    method: "POST",
    url: "/api/approvals/wf-pending/decision",
    headers,
    payload: {
      approverName: "李四",
      decision: "pass",
      idempotencyKey: "impersonate-li"
    }
  });
  assert.equal(impersonated.statusCode, 403);
  assert.equal(impersonated.json().error, "approver_identity_denied");

  const selfApproved = await app.inject({
    method: "POST",
    url: "/api/approvals/wf-pending/decision",
    headers,
    payload: {
      approverName: "张三",
      decision: "pass",
      idempotencyKey: "self-zhang"
    }
  });
  assert.equal(selfApproved.statusCode, 200);

  const deniedTransfer = await app.inject({
    method: "POST",
    url: "/api/approvals/wf-pending/transfer",
    headers,
    payload: {
      sourceApproverName: "李四",
      target: "王五"
    }
  });
  assert.equal(deniedTransfer.statusCode, 403);
  assert.equal(deniedTransfer.json().error, "source_approver_identity_denied");

  const audit = await app.inject({ method: "GET", url: "/api/audit", headers });
  assert.equal(audit.json().auditLogs.some((item) => item.content.includes("审批身份校验失败")), true);
  assert.equal(audit.json().auditLogs.some((item) => item.content.includes("不能代替该审批人转交")), true);

  await app.close();
});

test("approval decision requires explicit current approver name", async () => {
  const app = await buildApp({
    logger: false,
    prisma: await makePrismaMock({ permissionCodes: ["workflow.approve"] }),
    config: { jwtSecret: "test-secret" }
  });
  const headers = await loginHeaders(app);

  const response = await app.inject({
    method: "POST",
    url: "/api/approvals/wf-pending/decision",
    headers,
    payload: { decision: "pass" }
  });

  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error, "approver_name_required");

  await app.close();
});

test("iam overview exposes roles permissions and users for authorized admins", async () => {
  const app = await buildApp({
    logger: false,
    prisma: await makePrismaMock({ permissionCodes: ["system.admin", "iam.read", "audit.read"] }),
    config: { jwtSecret: "test-secret" }
  });
  const headers = await loginHeaders(app);

  const response = await app.inject({ method: "GET", url: "/api/iam", headers });

  assert.equal(response.statusCode, 200);
  assert.equal(response.json().roles.some((role) => role.code === "admin"), true);
  assert.equal(response.json().permissions.some((permission) => permission.code === "iam.read"), true);
  assert.equal(response.json().users[0].email, "admin@oa.local");
  assert.equal(response.json().accounts.some((account) => account.employeeNo === "EMP-1"), true);
  assert.equal(Number.isInteger(response.json().accountStats.missingAccounts), true);

  await app.close();
});

test("iam employee account library sync creates one account per active employee and audits without secrets", async () => {
  const prisma = await makePrismaMock({
    employees: [
      {
        id: "emp-active-missing",
        employeeNo: "EMP-2",
        name: "李四",
        email: "lisi@oa.local",
        departmentId: "dept-admin",
        roleTitle: "HRBP",
        status: "ACTIVE"
      },
      {
        id: "emp-leaved-missing",
        employeeNo: "EMP-3",
        name: "离职员工",
        email: "leaver@oa.local",
        departmentId: "dept-admin",
        roleTitle: "离职人员",
        status: "LEAVED"
      }
    ],
    permissionCodes: ["system.admin", "iam.read", "iam.write", "audit.read"]
  });
  const app = await buildApp({
    logger: false,
    prisma,
    config: { jwtSecret: "test-secret" }
  });
  const headers = await loginHeaders(app);

  const synced = await app.inject({
    method: "POST",
    url: "/api/iam/accounts/sync-employees",
    headers,
    payload: { emailDomain: "oa.local" }
  });
  assert.equal(synced.statusCode, 201);
  assert.equal(synced.json().createdCount, 2);
  assert.equal(synced.json().credentials.some((item) => item.employeeNo === "EMP-3"), false);
  assert.equal(synced.json().credentials.every((item) => item.roleCodes.includes("employee-self-service")), true);
  assert.equal(synced.json().credentials.every((item) => item.temporaryPassword.length >= 12), true);

  const credential = synced.json().credentials.find((item) => item.email === "lisi@oa.local");
  assert.ok(credential);
  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: {
      tenantCode: "default",
      email: credential.email,
      password: credential.temporaryPassword
    }
  });
  assert.equal(login.statusCode, 200);

  const overview = await app.inject({ method: "GET", url: "/api/iam", headers });
  const account = overview.json().accounts.find((item) => item.employeeNo === "EMP-2");
  assert.equal(account.accountEmail, "lisi@oa.local");
  assert.deepEqual(account.roleCodes, ["employee-self-service"]);
  assert.equal(overview.json().accountStats.missingAccounts, 0);

  const audit = await app.inject({ method: "GET", url: "/api/audit", headers });
  const syncLog = audit.json().auditLogs.find((item) => item.content.includes("批量生成员工账号 2 个"));
  assert.ok(syncLog);
  assert.equal(JSON.stringify(syncLog).includes(credential.temporaryPassword), false);

  await app.close();
});

test("iam role permission update is audited and keeps admin guard permissions", async () => {
  const app = await buildApp({
    logger: false,
    prisma: await makePrismaMock({ permissionCodes: ["system.admin", "iam.read", "iam.write", "audit.read"] }),
    config: { jwtSecret: "test-secret" }
  });
  const headers = await loginHeaders(app);

  const response = await app.inject({
    method: "PUT",
    url: "/api/iam/roles/role-admin/permissions",
    headers,
    payload: { permissionCodes: ["system.admin", "iam.read", "iam.write", "audit.read"] }
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual([...response.json().role.permissionCodes].sort(), ["audit.read", "iam.read", "iam.write", "system.admin"]);

  const audit = await app.inject({ method: "GET", url: "/api/audit", headers });
  assert.equal(audit.statusCode, 200);
  assert.equal(audit.json().auditLogs.some((item) => item.content.includes("更新角色 系统管理员 权限")), true);

  await app.close();
});

test("iam role permission update rejects unknown permissions and admin lockout", async () => {
  const app = await buildApp({
    logger: false,
    prisma: await makePrismaMock({ permissionCodes: ["system.admin", "iam.read", "iam.write"] }),
    config: { jwtSecret: "test-secret" }
  });
  const headers = await loginHeaders(app);

  const missing = await app.inject({
    method: "PUT",
    url: "/api/iam/roles/role-admin/permissions",
    headers,
    payload: { permissionCodes: ["system.admin", "iam.write", "not.real"] }
  });
  assert.equal(missing.statusCode, 400);
  assert.equal(missing.json().error, "unknown_permission_codes");

  const lockout = await app.inject({
    method: "PUT",
    url: "/api/iam/roles/role-admin/permissions",
    headers,
    payload: { permissionCodes: ["iam.read"] }
  });
  assert.equal(lockout.statusCode, 400);
  assert.equal(lockout.json().error, "admin_role_guard_required");

  await app.close();
});

test("iam user role assignment updates role memberships and prevents self admin lockout", async () => {
  const app = await buildApp({
    logger: false,
    prisma: await makePrismaMock({ permissionCodes: ["system.admin", "iam.read", "iam.write", "audit.read"] }),
    config: { jwtSecret: "test-secret" }
  });
  const headers = await loginHeaders(app);

  const updated = await app.inject({
    method: "PUT",
    url: "/api/iam/users/user-admin/roles",
    headers,
    payload: { roleCodes: ["admin", "auditor"] }
  });
  assert.equal(updated.statusCode, 200);
  assert.deepEqual([...updated.json().user.roleCodes].sort(), ["admin", "auditor"]);

  const overview = await app.inject({ method: "GET", url: "/api/iam", headers });
  const auditorRole = overview.json().roles.find((role) => role.code === "auditor");
  assert.equal(auditorRole.users.some((user) => user.id === "user-admin"), true);

  const lockout = await app.inject({
    method: "PUT",
    url: "/api/iam/users/user-admin/roles",
    headers,
    payload: { roleCodes: ["auditor"] }
  });
  assert.equal(lockout.statusCode, 400);
  assert.equal(lockout.json().error, "admin_self_role_guard_required");

  const audit = await app.inject({ method: "GET", url: "/api/audit", headers });
  assert.equal(audit.json().auditLogs.some((item) => item.content.includes("更新账号 系统管理员 角色")), true);

  await app.close();
});

test("iam user creation creates login-capable accounts assigns roles and audits without secrets", async () => {
  const prisma = await makePrismaMock({ permissionCodes: ["system.admin", "iam.read", "iam.write", "audit.read"] });
  const app = await buildApp({
    logger: false,
    prisma,
    config: { jwtSecret: "test-secret" }
  });
  const headers = await loginHeaders(app);

  const created = await app.inject({
    method: "POST",
    url: "/api/iam/users",
    headers,
    payload: {
      email: "New.HR@OA.Local",
      name: "新人事账号",
      newPassword: "NewAccountPass123",
      roleCodes: ["auditor"],
      status: "ACTIVE"
    }
  });
  assert.equal(created.statusCode, 201);
  assert.equal(created.json().user.email, "new.hr@oa.local");
  assert.deepEqual(created.json().user.roleCodes, ["auditor"]);
  assert.equal(Object.hasOwn(created.json().user, "passwordHash"), false);

  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: {
      tenantCode: "default",
      email: "new.hr@oa.local",
      password: "NewAccountPass123"
    }
  });
  assert.equal(login.statusCode, 200);

  const overview = await app.inject({ method: "GET", url: "/api/iam", headers });
  const auditorRole = overview.json().roles.find((role) => role.code === "auditor");
  assert.equal(auditorRole.users.some((user) => user.email === "new.hr@oa.local"), true);

  const duplicate = await app.inject({
    method: "POST",
    url: "/api/iam/users",
    headers,
    payload: {
      email: "new.hr@oa.local",
      name: "重复账号",
      newPassword: "NewAccountPass123",
      roleCodes: ["auditor"]
    }
  });
  assert.equal(duplicate.statusCode, 409);
  assert.equal(duplicate.json().error, "user_email_exists");

  const weak = await app.inject({
    method: "POST",
    url: "/api/iam/users",
    headers,
    payload: {
      email: "weak@oa.local",
      name: "弱密码账号",
      newPassword: "short1",
      roleCodes: ["auditor"]
    }
  });
  assert.equal(weak.statusCode, 400);
  assert.equal(weak.json().error, "password_policy_failed");

  const missingRole = await app.inject({
    method: "POST",
    url: "/api/iam/users",
    headers,
    payload: {
      email: "role@oa.local",
      name: "角色错误账号",
      newPassword: "RoleAccountPass123",
      roleCodes: ["not-real"]
    }
  });
  assert.equal(missingRole.statusCode, 400);
  assert.equal(missingRole.json().error, "unknown_role_codes");

  const audit = await app.inject({ method: "GET", url: "/api/audit", headers });
  const createLog = audit.json().auditLogs.find((item) => item.content.includes("创建账号 新人事账号"));
  assert.ok(createLog);
  assert.equal(JSON.stringify(createLog).includes("NewAccountPass123"), false);

  await app.close();
});

test("iam user status update disables accounts revokes sessions and audits", async () => {
  const prisma = await makePrismaMock({
    extraUsers: [{ id: "user-ops", email: "ops@oa.local", name: "运营账号", roleIds: ["role-auditor"] }],
    permissionCodes: ["system.admin", "iam.read", "iam.write", "audit.read"]
  });
  const app = await buildApp({
    logger: false,
    prisma,
    config: { jwtSecret: "test-secret" }
  });
  const headers = await loginHeaders(app);
  const staleToken = app.jwt.sign({
    email: "ops@oa.local",
    sessionVersion: 1,
    sub: "user-ops",
    tenantId: "tenant-default"
  });

  const disabled = await app.inject({
    method: "PUT",
    url: "/api/iam/users/user-ops/status",
    headers,
    payload: { status: "DISABLED" }
  });
  assert.equal(disabled.statusCode, 200);
  assert.equal(disabled.json().user.status, "DISABLED");

  const disabledUser = await prisma.user.findUnique({ where: { id: "user-ops" } });
  assert.equal(disabledUser.status, "DISABLED");
  assert.equal(disabledUser.sessionVersion, 2);

  const staleSession = await app.inject({
    method: "GET",
    url: "/api/protected/ping",
    headers: { authorization: `Bearer ${staleToken}` }
  });
  assert.equal(staleSession.statusCode, 401);

  const restored = await app.inject({
    method: "PUT",
    url: "/api/iam/users/user-ops/status",
    headers,
    payload: { status: "ACTIVE" }
  });
  assert.equal(restored.statusCode, 200);
  assert.equal(restored.json().user.status, "ACTIVE");

  const selfDisable = await app.inject({
    method: "PUT",
    url: "/api/iam/users/user-admin/status",
    headers,
    payload: { status: "DISABLED" }
  });
  assert.equal(selfDisable.statusCode, 400);
  assert.equal(selfDisable.json().error, "admin_self_status_guard_required");

  const invalid = await app.inject({
    method: "PUT",
    url: "/api/iam/users/user-ops/status",
    headers,
    payload: { status: "LOCKED" }
  });
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.json().error, "invalid_user_status");

  const audit = await app.inject({ method: "GET", url: "/api/audit", headers });
  assert.equal(audit.json().auditLogs.some((item) => item.content.includes("更新账号 运营账号 状态")), true);

  await app.close();
});

test("iam admin password reset revokes target sessions and audits without exposing secrets", async () => {
  const prisma = await makePrismaMock({
    extraUsers: [{
      id: "user-ops",
      email: "ops@oa.local",
      name: "运营账号",
      password: "OpsOldPassword123",
      roleIds: ["role-auditor"]
    }],
    permissionCodes: ["system.admin", "iam.read", "iam.write", "audit.read"]
  });
  const app = await buildApp({
    logger: false,
    prisma,
    config: { jwtSecret: "test-secret" }
  });
  const headers = await loginHeaders(app);

  const opsLogin = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: {
      tenantCode: "default",
      email: "ops@oa.local",
      password: "OpsOldPassword123"
    }
  });
  assert.equal(opsLogin.statusCode, 200);
  const staleOpsToken = opsLogin.json().token;

  const invalid = await app.inject({
    method: "PUT",
    url: "/api/iam/users/user-ops/password",
    headers,
    payload: { newPassword: "short1" }
  });
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.json().error, "password_policy_failed");

  const selfReset = await app.inject({
    method: "PUT",
    url: "/api/iam/users/user-admin/password",
    headers,
    payload: { newPassword: "AdminResetPassword123" }
  });
  assert.equal(selfReset.statusCode, 400);
  assert.equal(selfReset.json().error, "admin_self_password_reset_guard_required");

  const reset = await app.inject({
    method: "PUT",
    url: "/api/iam/users/user-ops/password",
    headers,
    payload: { newPassword: "OpsResetPassword123" }
  });
  assert.equal(reset.statusCode, 200);
  assert.equal(reset.json().user.id, "user-ops");

  const opsUser = await prisma.user.findUnique({ where: { id: "user-ops" } });
  assert.equal(opsUser.sessionVersion, 2);
  assert.equal(await bcrypt.compare("OpsResetPassword123", opsUser.passwordHash), true);

  const staleSession = await app.inject({
    method: "GET",
    url: "/api/protected/ping",
    headers: { authorization: `Bearer ${staleOpsToken}` }
  });
  assert.equal(staleSession.statusCode, 401);

  const oldPasswordLogin = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: {
      tenantCode: "default",
      email: "ops@oa.local",
      password: "OpsOldPassword123"
    }
  });
  assert.equal(oldPasswordLogin.statusCode, 401);

  const newPasswordLogin = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: {
      tenantCode: "default",
      email: "ops@oa.local",
      password: "OpsResetPassword123"
    }
  });
  assert.equal(newPasswordLogin.statusCode, 200);

  const audit = await app.inject({ method: "GET", url: "/api/audit", headers });
  const resetLog = audit.json().auditLogs.find((item) => item.content.includes("重置账号 运营账号 密码"));
  assert.ok(resetLog);
  assert.equal(JSON.stringify(resetLog).includes("OpsResetPassword123"), false);

  await app.close();
});

test("resource booking uses transaction lock and rejects overlapping slots", async () => {
  const prisma = await makePrismaMock({ permissionCodes: ["resource.read", "resource.book", "audit.read"] });
  let transactionCalls = 0;
  let lockCalls = 0;
  const originalTransaction = prisma.$transaction;
  prisma.$transaction = async (work) => {
    transactionCalls += 1;
    return originalTransaction(work);
  };
  prisma.$executeRaw = async (strings, ...values) => {
    if (Array.isArray(strings) && String(strings[0]).includes("pg_advisory_xact_lock")) {
      lockCalls += 1;
    }
    return 1;
  };
  prisma.$queryRaw = async () => {
    throw new Error("resource booking lock must use executeRaw to avoid deserializing PostgreSQL void lock results");
  };
  const app = await buildApp({
    logger: false,
    prisma,
    config: { jwtSecret: "test-secret" }
  });
  const headers = await loginHeaders(app);

  const first = await app.inject({
    method: "POST",
    url: "/api/resources/bookings",
    headers,
    payload: {
      resourceName: "一号会议室",
      bookingDate: "2026-06-22",
      period: "09:00-10:00",
      applicant: "张三",
      purpose: "周会"
    }
  });
  assert.equal(first.statusCode, 201);
  assert.equal(first.json().booking.status, "已预约");
  assert.equal(first.json().booking.date, "2026-06-22");

  const overlap = await app.inject({
    method: "POST",
    url: "/api/resources/bookings",
    headers,
    payload: {
      resourceName: "一号会议室",
      bookingDate: "2026-06-22",
      period: "09:30-10:30",
      applicant: "李四",
      purpose: "冲突会议"
    }
  });
  assert.equal(overlap.statusCode, 409);
  assert.equal(overlap.json().error, "booking_conflict");
  assert.equal(transactionCalls, 2);
  assert.equal(lockCalls, 2);

  const audit = await app.inject({ method: "GET", url: "/api/audit", headers });
  const conflictAudit = audit.json().auditLogs.find((item) => item.content.includes("已被占用"));
  assert.equal(Boolean(conflictAudit), true);
  assert.equal(conflictAudit.type, "预约冲突");
  assert.equal(conflictAudit.result, "失败");

  await app.close();
});

test("resource bookings default applicant to the authenticated user", async () => {
  const app = await buildApp({
    logger: false,
    prisma: await makePrismaMock({
      permissionCodes: ["resource.read", "resource.book", "audit.read"],
      userName: "资源管理员"
    }),
    config: { jwtSecret: "test-secret" }
  });
  const headers = await loginHeaders(app);

  const response = await app.inject({
    method: "POST",
    url: "/api/resources/bookings",
    headers,
    payload: {
      resourceId: "resource-1",
      startsAt: "2026-06-23T09:00:00.000Z",
      endsAt: "2026-06-23T10:00:00.000Z",
      purpose: "项目例会"
    }
  });
  assert.equal(response.statusCode, 201);
  assert.equal(response.json().booking.applicant, "资源管理员");
  assert.equal(response.json().booking.date, "2026-06-23");

  const logs = await app.prisma.auditLog.findMany({ where: { action: "resource.booking.create" }, take: 1 });
  assert.equal(logs[0].metadata.applicant, "资源管理员");

  await app.close();
});

test("resource booking export returns backend CSV with formula escaping and audit row", async () => {
  const app = await buildApp({
    logger: false,
    prisma: await makePrismaMock({ permissionCodes: ["resource.read", "resource.export", "audit.read"] }),
    config: { jwtSecret: "test-secret" }
  });
  const headers = await loginHeaders(app);

  await app.prisma.booking.create({
    data: {
      tenantId: "tenant-default",
      resourceId: "resource-1",
      applicantId: "user-admin",
      purpose: " =HYPERLINK(\"https://example.invalid\",\"open\")",
      status: "CONFIRMED",
      startsAt: new Date("2026-06-24T09:00:00.000Z"),
      endsAt: new Date("2026-06-24T10:00:00.000Z"),
      metadata: { applicant: " =cmd|' /C calc'!A0" }
    }
  });

  const response = await app.inject({
    method: "POST",
    url: "/api/resources/bookings/export",
    headers,
    payload: { businessReason: "行政资源占用复核", scope: "资源预约台账", filters: { status: "CONFIRMED" } }
  });

  assert.equal(response.statusCode, 200);
  assert.match(response.headers["content-type"], /text\/csv/);
  assert.match(response.headers["content-disposition"], /attachment; filename="resource-booking-export-/);
  assert.equal(response.headers["x-row-count"], "1");
  assert.match(response.body, /资源/);
  assert.match(response.body, /一号会议室/);
  assert.match(response.body, /"' =HYPERLINK/);
  assert.match(response.body, /"' =cmd/);

  const audit = await app.inject({ method: "GET", url: "/api/audit", headers });
  assert.equal(audit.statusCode, 200);
  assert.equal(audit.json().auditLogs.some((item) => item.content.includes("导出资源预约台账，后端生成资源预约台账")), true);

  await app.close();
});

test("resource booking export requires explicit export permission", async () => {
  const app = await buildApp({
    logger: false,
    prisma: await makePrismaMock({ permissionCodes: ["resource.read", "audit.read"] }),
    config: { jwtSecret: "test-secret" }
  });
  const headers = await loginHeaders(app);

  const response = await app.inject({
    method: "POST",
    url: "/api/resources/bookings/export",
    headers,
    payload: { businessReason: "行政资源占用复核", scope: "资源预约台账" }
  });

  assert.equal(response.statusCode, 403);

  await app.close();
});

test("resource booking cancellation releases slot and writes audit rows", async () => {
  const app = await buildApp({
    logger: false,
    prisma: await makePrismaMock({ permissionCodes: ["resource.read", "resource.book", "audit.read"] }),
    config: { jwtSecret: "test-secret" }
  });
  const headers = await loginHeaders(app);

  const first = await app.inject({
    method: "POST",
    url: "/api/resources/bookings",
    headers,
    payload: {
      resourceName: "一号会议室",
      dayIndex: 2,
      period: "14:00-16:00",
      purpose: "项目会"
    }
  });
  assert.equal(first.statusCode, 201);

  const cancel = await app.inject({
    method: "POST",
    url: `/api/resources/bookings/${first.json().booking.id}/cancel`,
    headers,
    payload: { reason: "会议取消" }
  });
  assert.equal(cancel.statusCode, 200);
  assert.equal(cancel.json().booking.status, "已取消");

  const repeatedCancel = await app.inject({
    method: "POST",
    url: `/api/resources/bookings/${first.json().booking.id}/cancel`,
    headers
  });
  assert.equal(repeatedCancel.statusCode, 200);
  assert.equal(repeatedCancel.json().alreadyCancelled, true);

  const reusedSlot = await app.inject({
    method: "POST",
    url: "/api/resources/bookings",
    headers,
    payload: {
      resourceName: "一号会议室",
      dayIndex: 2,
      period: "14:00-16:00",
      purpose: "重新预约"
    }
  });
  assert.equal(reusedSlot.statusCode, 201);
  assert.notEqual(reusedSlot.json().booking.id, first.json().booking.id);

  const missingCancel = await app.inject({
    method: "POST",
    url: "/api/resources/bookings/booking-missing/cancel",
    headers
  });
  assert.equal(missingCancel.statusCode, 404);
  assert.equal(missingCancel.json().error, "booking_not_found");

  const audit = await app.inject({ method: "GET", url: "/api/audit", headers });
  assert.equal(audit.json().auditLogs.some((item) => item.content.includes("取消一号会议室 14:00-16:00")), true);
  assert.equal(audit.json().auditLogs.some((item) => item.content.includes("已取消，跳过重复取消")), true);

  await app.close();
});

test("resource booking rejects invalid time ranges before writing", async () => {
  const app = await buildApp({
    logger: false,
    prisma: await makePrismaMock({ permissionCodes: ["resource.book"] }),
    config: { jwtSecret: "test-secret" }
  });
  const headers = await loginHeaders(app);

  const response = await app.inject({
    method: "POST",
    url: "/api/resources/bookings",
    headers,
    payload: {
      resourceName: "一号会议室",
      dayIndex: 0,
      period: "18:00-09:00",
      applicant: "张三",
      purpose: "非法时段"
    }
  });

  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error, "invalid_booking_period");

  await app.close();
});

test("route-level IAM rejects people API without employee read permission", async () => {
  const app = await buildApp({
    logger: false,
    prisma: await makePrismaMock({ permissionCodes: ["workflow.read"] }),
    config: { jwtSecret: "test-secret" }
  });

  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: {
      tenantCode: "default",
      email: "admin@oa.local",
      password: "admin123456"
    }
  });
  const response = await app.inject({
    method: "GET",
    url: "/api/people",
    headers: { authorization: `Bearer ${login.json().token}` }
  });

  assert.equal(response.statusCode, 403);
  assert.equal(response.json().error, "PERMISSION_DENIED");

  await app.close();
});

test("route-level IAM rejects people employee and leaver lists without employee read permission", async () => {
  const app = await buildApp({
    logger: false,
    prisma: await makePrismaMock({ permissionCodes: ["workflow.read"] }),
    config: { jwtSecret: "test-secret" }
  });

  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: {
      tenantCode: "default",
      email: "admin@oa.local",
      password: "admin123456"
    }
  });
  const headers = { authorization: `Bearer ${login.json().token}` };

  for (const url of ["/api/people/employees", "/api/people/leavers"]) {
    const response = await app.inject({ method: "GET", url, headers });
    assert.equal(response.statusCode, 403);
    assert.equal(response.json().error, "PERMISSION_DENIED");
  }

  await app.close();
});

test("route-level IAM rejects workflow definitions without workflow read permission", async () => {
  const app = await buildApp({
    logger: false,
    prisma: await makePrismaMock({ permissionCodes: ["employee.read"] }),
    config: { jwtSecret: "test-secret" }
  });
  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: {
      tenantCode: "default",
      email: "admin@oa.local",
      password: "admin123456"
    }
  });
  const response = await app.inject({
    method: "GET",
    url: "/api/workflows/definitions",
    headers: { authorization: `Bearer ${login.json().token}` }
  });

  assert.equal(response.statusCode, 403);
  assert.equal(response.json().error, "PERMISSION_DENIED");

  await app.close();
});

test("protected endpoint rejects anonymous requests", async () => {
  const app = await buildApp({
    logger: false,
    prisma: await makePrismaMock(),
    config: { jwtSecret: "test-secret" }
  });

  const response = await app.inject({ method: "GET", url: "/api/protected/ping" });
  assert.equal(response.statusCode, 401);
  assert.equal(response.json().error, "unauthorized");

  await app.close();
});

test("auth rejects signed tokens whose tenant does not match the user record", async () => {
  const app = await buildApp({
    logger: false,
    prisma: await makePrismaMock(),
    config: { jwtSecret: "test-secret" }
  });

  const mismatchedTenantToken = app.jwt.sign({
    sub: "user-admin",
    tenantId: "tenant-other",
    email: "admin@oa.local",
    sessionVersion: 1
  });

  const protectedResponse = await app.inject({
    method: "GET",
    url: "/api/protected/ping",
    headers: { authorization: `Bearer ${mismatchedTenantToken}` }
  });
  assert.equal(protectedResponse.statusCode, 401);
  assert.equal(protectedResponse.json().error, "unauthorized");

  const me = await app.inject({
    method: "GET",
    url: "/api/auth/me",
    headers: { authorization: `Bearer ${mismatchedTenantToken}` }
  });
  assert.equal(me.statusCode, 401);
  assert.equal(me.json().error, "unauthorized");

  await app.close();
});

test("csrf origin guard rejects cross-site mutating requests", async () => {
  const app = await buildApp({
    logger: false,
    prisma: await makePrismaMock(),
    config: {
      jwtSecret: "test-secret",
      webOrigin: ["https://oa.example.com"]
    }
  });

  const denied = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    headers: { origin: "https://evil.example" },
    payload: {
      tenantCode: "default",
      email: "admin@oa.local",
      password: "admin123456"
    }
  });
  assert.equal(denied.statusCode, 403);
  assert.equal(denied.json().error, "csrf_origin_denied");

  const forwardedHostSpoofing = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    headers: {
      origin: "https://evil.example",
      host: "oa.example.com",
      "x-forwarded-host": "evil.example",
      "x-forwarded-proto": "https"
    },
    payload: {
      tenantCode: "default",
      email: "admin@oa.local",
      password: "admin123456"
    }
  });
  assert.equal(forwardedHostSpoofing.statusCode, 403);
  assert.equal(forwardedHostSpoofing.json().error, "csrf_origin_denied");

  const allowed = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    headers: { origin: "https://oa.example.com" },
    payload: {
      tenantCode: "default",
      email: "admin@oa.local",
      password: "admin123456"
    }
  });
  assert.equal(allowed.statusCode, 200);

  const sameHost = await app.inject({
    method: "POST",
    url: "/api/auth/logout",
    headers: {
      authorization: `Bearer ${allowed.json().token}`,
      origin: "http://localhost:80",
      host: "localhost:80"
    }
  });
  assert.equal(sameHost.statusCode, 200);

  const safeRead = await app.inject({
    method: "GET",
    url: "/api/health",
    headers: { origin: "https://evil.example" }
  });
  assert.equal(safeRead.statusCode, 200);

  await app.close();

  const trustedProxyApp = await buildApp({
    logger: false,
    prisma: await makePrismaMock(),
    config: {
      jwtSecret: "test-secret",
      trustProxy: true,
      webOrigin: ["https://oa.example.com"]
    }
  });

  const trustedProxyAllowed = await trustedProxyApp.inject({
    method: "POST",
    url: "/api/auth/login",
    headers: {
      origin: "https://proxy.example.com",
      host: "internal-api:8787",
      "x-forwarded-host": "proxy.example.com",
      "x-forwarded-proto": "https"
    },
    payload: {
      tenantCode: "default",
      email: "admin@oa.local",
      password: "admin123456"
    }
  });
  assert.equal(trustedProxyAllowed.statusCode, 200);

  await trustedProxyApp.close();
});

test("audit metadata includes request id for operational traceability", async () => {
  const app = await buildApp({
    logger: false,
    prisma: await makePrismaMock({ permissionCodes: [...defaultPermissionCodes, "employee.sensitive.read"] }),
    config: { jwtSecret: "test-secret" }
  });
  const headers = await loginHeaders(app);

  const response = await app.inject({
    method: "POST",
    url: "/api/audit/sensitive-access",
    headers,
    payload: { enabled: true }
  });
  assert.equal(response.statusCode, 200);
  assert.match(response.headers["x-request-id"], /req-/);

  const logs = await app.prisma.auditLog.findMany({
    where: { action: "audit.sensitive_access" },
    take: 1
  });
  assert.equal(logs[0].metadata.requestId, response.headers["x-request-id"]);

  await app.close();
});

test("failed login is audited without revealing which credential failed", async () => {
  const app = await buildApp({
    logger: false,
    prisma: await makePrismaMock({ permissionCodes: ["audit.read"] }),
    config: { authFailedLoginLimit: 5, jwtSecret: "test-secret" }
  });

  const failed = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: {
      tenantCode: "default",
      email: "admin@oa.local",
      password: "wrong-password"
    }
  });
  assert.equal(failed.statusCode, 401);
  assert.equal(failed.json().error, "invalid_credentials");

  const auditToken = app.jwt.sign({
    sub: "user-admin",
    tenantId: "tenant-default",
    email: "admin@oa.local",
    sessionVersion: 1
  });
  const audit = await app.inject({
    method: "GET",
    url: "/api/audit",
    headers: { authorization: `Bearer ${auditToken}` }
  });
  assert.equal(audit.statusCode, 200);
  assert.equal(audit.json().auditLogs.some((item) => item.content.includes("用户登录失败")), true);

  await app.close();
});

test("login rate limit returns 429 after repeated failed attempts", async () => {
  const app = await buildApp({
    logger: false,
    prisma: await makePrismaMock({ permissionCodes: ["audit.read"] }),
    config: { authFailedLoginLimit: 2, authFailedLoginWindowMs: 60_000, jwtSecret: "test-secret" }
  });

  for (let index = 0; index < 2; index += 1) {
    const failed = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: {
        tenantCode: "default",
        email: "admin@oa.local",
        password: `wrong-password-${index}`
      }
    });
    assert.equal(failed.statusCode, 401);
  }

  const blocked = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: {
      tenantCode: "default",
      email: "admin@oa.local",
      password: "admin123456"
    }
  });
  assert.equal(blocked.statusCode, 429);
  assert.equal(blocked.json().error, "too_many_login_attempts");
  assert.ok(Number(blocked.headers["retry-after"]) > 0);

  const auditToken = app.jwt.sign({
    sub: "user-admin",
    tenantId: "tenant-default",
    email: "admin@oa.local",
    sessionVersion: 1
  });
  const audit = await app.inject({
    method: "GET",
    url: "/api/audit",
    headers: { authorization: `Bearer ${auditToken}` }
  });
  assert.equal(audit.json().auditLogs.some((item) => item.content.includes("登录失败次数过多")), true);

  await app.close();
});

test("login failure store evicts old keys to avoid unbounded memory growth", async () => {
  const app = await buildApp({
    logger: false,
    prisma: await makePrismaMock({ permissionCodes: ["audit.read"] }),
    config: {
      authFailedLoginLimit: 1,
      authFailedLoginWindowMs: 60_000,
      authFailedLoginMaxKeys: 1,
      jwtSecret: "test-secret"
    }
  });

  const firstFailure = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: {
      tenantCode: "default",
      email: "admin@oa.local",
      password: "wrong-password"
    }
  });
  assert.equal(firstFailure.statusCode, 401);

  const evictionFailure = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: {
      tenantCode: "default",
      email: "spray@oa.local",
      password: "wrong-password"
    }
  });
  assert.equal(evictionFailure.statusCode, 401);

  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: {
      tenantCode: "default",
      email: "admin@oa.local",
      password: "admin123456"
    }
  });
  assert.equal(login.statusCode, 200);
  assert.ok(login.json().token);

  await app.close();
});

test("login returns token and authenticated routes can use it", async () => {
  const app = await buildApp({
    logger: false,
    prisma: await makePrismaMock(),
    config: { jwtSecret: "test-secret" }
  });

  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: {
      tenantCode: "default",
      email: "admin@oa.local",
      password: "admin123456"
    }
  });

  assert.equal(login.statusCode, 200);
  assert.match(login.headers["set-cookie"], /oa_session=/);
  assert.match(login.headers["set-cookie"], /HttpOnly/);
  assert.match(login.headers["set-cookie"], /SameSite=Lax/);
  assert.match(login.headers["set-cookie"], /Max-Age=28800/);
  const token = login.json().token;
  assert.ok(token);
  assert.equal(login.json().user.permissions.includes("system.admin"), true);

  const me = await app.inject({
    method: "GET",
    url: "/api/auth/me",
    headers: { authorization: `Bearer ${token}` }
  });
  assert.equal(me.statusCode, 200);
  assert.equal(me.json().user.email, "admin@oa.local");

  const protectedResponse = await app.inject({
    method: "GET",
    url: "/api/protected/ping",
    headers: { authorization: `Bearer ${token}` }
  });
  assert.equal(protectedResponse.statusCode, 200);
  assert.equal(protectedResponse.json().tenantId, "tenant-default");

  const definitions = await app.inject({
    method: "GET",
    url: "/api/workflows/definitions",
    headers: { authorization: `Bearer ${token}` }
  });
  assert.equal(definitions.statusCode, 200);
  assert.equal(definitions.json().definitions[0].code, "FIN-EXPENSE");

  const logout = await app.inject({
    method: "POST",
    url: "/api/auth/logout",
    headers: { authorization: `Bearer ${token}` }
  });
  assert.equal(logout.statusCode, 200);
  assert.match(logout.headers["set-cookie"], /oa_session=/);
  assert.match(logout.headers["set-cookie"], /Max-Age=0/);
  assert.match(logout.headers["set-cookie"], /SameSite=Lax/);

  const revoked = await app.inject({
    method: "GET",
    url: "/api/protected/ping",
    headers: { authorization: `Bearer ${token}` }
  });
  assert.equal(revoked.statusCode, 401);
  assert.equal(revoked.json().error, "unauthorized");

  await app.close();
});

test("auth change password validates current password revokes old session and audits", async () => {
  const app = await buildApp({
    logger: false,
    prisma: await makePrismaMock(),
    config: { jwtSecret: "test-secret" }
  });

  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: {
      tenantCode: "default",
      email: "admin@oa.local",
      password: "admin123456"
    }
  });
  assert.equal(login.statusCode, 200);
  const oldToken = login.json().token;

  const wrongCurrent = await app.inject({
    method: "POST",
    url: "/api/auth/change-password",
    headers: { authorization: `Bearer ${oldToken}` },
    payload: {
      currentPassword: "wrong-password",
      newPassword: "UpdatedPassword123"
    }
  });
  assert.equal(wrongCurrent.statusCode, 401);
  assert.equal(wrongCurrent.json().error, "current_password_invalid");

  const weakPassword = await app.inject({
    method: "POST",
    url: "/api/auth/change-password",
    headers: { authorization: `Bearer ${oldToken}` },
    payload: {
      currentPassword: "admin123456",
      newPassword: "short1"
    }
  });
  assert.equal(weakPassword.statusCode, 400);
  assert.equal(weakPassword.json().error, "password_policy_failed");

  const changed = await app.inject({
    method: "POST",
    url: "/api/auth/change-password",
    headers: { authorization: `Bearer ${oldToken}` },
    payload: {
      currentPassword: "admin123456",
      newPassword: "UpdatedPassword123"
    }
  });
  assert.equal(changed.statusCode, 200);
  assert.match(changed.headers["set-cookie"], /oa_session=/);
  const newToken = changed.json().token;
  assert.ok(newToken);

  const revokedOldSession = await app.inject({
    method: "GET",
    url: "/api/protected/ping",
    headers: { authorization: `Bearer ${oldToken}` }
  });
  assert.equal(revokedOldSession.statusCode, 401);

  const refreshedSession = await app.inject({
    method: "GET",
    url: "/api/protected/ping",
    headers: { authorization: `Bearer ${newToken}` }
  });
  assert.equal(refreshedSession.statusCode, 200);

  const oldPasswordLogin = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: {
      tenantCode: "default",
      email: "admin@oa.local",
      password: "admin123456"
    }
  });
  assert.equal(oldPasswordLogin.statusCode, 401);

  const newPasswordLogin = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: {
      tenantCode: "default",
      email: "admin@oa.local",
      password: "UpdatedPassword123"
    }
  });
  assert.equal(newPasswordLogin.statusCode, 200);

  const audit = await app.inject({
    method: "GET",
    url: "/api/audit",
    headers: { authorization: `Bearer ${newToken}` }
  });
  assert.equal(audit.json().auditLogs.some((item) => item.content.includes("用户修改密码")), true);
  assert.equal(audit.json().auditLogs.some((item) => item.content.includes("用户修改密码失败")), true);

  await app.close();
});

test("production login cookie is secure and has explicit max age", async () => {
  const app = await buildApp({
    logger: false,
    prisma: await makePrismaMock(),
    config: {
      cookieMaxAgeSeconds: 3600,
      isProduction: true,
      jwtSecret: "test-secret-with-at-least-32-characters",
      webOrigin: ["https://oa.company.cn"],
      fileStorageDir: productionFileStorageDir
    }
  });

  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    headers: { origin: "https://oa.company.cn" },
    payload: {
      tenantCode: "default",
      email: "admin@oa.local",
      password: "admin123456"
    }
  });

  assert.equal(login.statusCode, 200);
  assert.match(login.headers["set-cookie"], /Secure/);
  assert.match(login.headers["set-cookie"], /HttpOnly/);
  assert.match(login.headers["set-cookie"], /SameSite=Lax/);
  assert.match(login.headers["set-cookie"], /Max-Age=3600/);

  await app.close();
});
