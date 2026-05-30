import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import bcrypt from "bcryptjs";
import { PrismaClient } from "@prisma/client";
import { loadDashboardPeople } from "./dashboard-data.mjs";
import { assertSeedSafety } from "./seed-safety.mjs";
import { loadEnv } from "../server/src/lib/env.mjs";
import { createFileStorage } from "../server/src/lib/file-storage.mjs";
import { rolePermissionCreateData } from "../server/src/modules/iam/policy-defaults.mjs";

assertSeedSafety();

const prisma = new PrismaClient();
const fileStorage = createFileStorage(loadEnv());

const tenantCode = process.env.DEFAULT_TENANT_CODE || "default";
const adminEmail = process.env.DEFAULT_ADMIN_EMAIL || "admin@oa.local";
const adminPassword = process.env.DEFAULT_ADMIN_PASSWORD || "admin123456";

const permissions = [
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

const departments = [
  ["HQ", "集团总部"],
  ["ADMIN", "行政部"],
  ["HR", "人力资源部"],
  ["FIN", "财务中心"],
  ["LIVE", "直播事业部"],
  ["PURCHASE", "采购部"],
  ["WAREHOUSE", "仓储部"]
];

const workflowDefinitions = [
  {
    code: "FIN-EXPENSE",
    name: "费用报销",
    category: "财务行政",
    formSchema: {
      fields: [
        { id: "expenseType", label: "报销类型", type: "select" },
        { id: "amount", label: "报销金额", type: "amount" },
        { id: "invoice", label: "发票张数", type: "number" },
        { id: "occurredAt", label: "发生日期", type: "date" }
      ]
    },
    nodes: [
      { name: "直属负责人审批", approvers: ["行政部负责人", "张三"] },
      { name: "财务复核", approvers: ["财务负责人", "财务专员"] },
      { name: "归档与通知", approvers: ["系统归档"] }
    ]
  },
  {
    code: "FIN-PAYMENT",
    name: "付款申请",
    category: "财务行政",
    formSchema: {
      fields: [
        { id: "supplier", label: "收款方", type: "input" },
        { id: "amount", label: "付款金额", type: "amount" },
        { id: "bankAccount", label: "收款账号", type: "input" },
        { id: "payDate", label: "期望付款日", type: "date" }
      ]
    },
    nodes: [
      { name: "采购负责人审批", approvers: ["采购负责人", "张三"] },
      { name: "财务复核", approvers: ["财务负责人", "财务专员"] },
      { name: "出纳付款", approvers: ["出纳"] },
      { name: "归档与通知", approvers: ["系统归档"] }
    ]
  },
  {
    code: "FIN-PAYROLL",
    name: "工资单复核",
    category: "财务行政",
    formSchema: {
      fields: [
        { id: "cycle", label: "工资周期", type: "input" },
        { id: "scope", label: "人员范围", type: "input" },
        { id: "headcount", label: "发薪人数", type: "number" },
        { id: "totalAmount", label: "工资总额", type: "amount" }
      ]
    },
    nodes: [
      { name: "薪资专员复核", approvers: ["薪资专员", "财务专员"] },
      { name: "财务负责人审批", approvers: ["财务负责人"] },
      { name: "人事负责人确认", approvers: ["人事负责人"] },
      { name: "归档与通知", approvers: ["系统归档"] }
    ]
  },
  {
    code: "HR-RECRUIT",
    name: "招聘需求",
    category: "组织人事",
    formSchema: {
      fields: [
        { id: "position", label: "招聘岗位", type: "input" },
        { id: "headcount", label: "需求人数", type: "number" },
        { id: "targetDate", label: "到岗日期", type: "date" }
      ]
    },
    nodes: [
      { name: "部门负责人审批", approvers: ["直播事业部负责人"] },
      { name: "编制复核", approvers: ["人事负责人", "HRBP"] },
      { name: "HRBP 归档", approvers: ["HRBP"] }
    ]
  },
  {
    code: "HR-SALARY",
    name: "调薪申请",
    category: "组织人事",
    formSchema: {
      fields: [
        { id: "employee", label: "调薪员工", type: "input" },
        { id: "adjustAmount", label: "调整金额", type: "amount" },
        { id: "effectiveDate", label: "生效日期", type: "date" },
        { id: "reasonType", label: "调薪原因", type: "select" }
      ]
    },
    nodes: [
      { name: "直属负责人审批", approvers: ["部门负责人", "张三"] },
      { name: "薪酬审批", approvers: ["人事负责人", "薪酬专员"] },
      { name: "总经理审批", approvers: ["总经理"] },
      { name: "归档与通知", approvers: ["系统归档"] }
    ]
  },
  {
    code: "HR-ONBOARD",
    name: "入职办理",
    category: "组织人事",
    formSchema: {
      fields: [
        { id: "employee", label: "入职员工", type: "input" },
        { id: "position", label: "入职岗位", type: "input" },
        { id: "entryDate", label: "入职日期", type: "date" },
        { id: "probationMonths", label: "试用期（月）", type: "number" },
        { id: "equipmentNeed", label: "设备需求", type: "select" }
      ]
    },
    nodes: [
      { name: "部门负责人确认", approvers: ["部门负责人", "张三"] },
      { name: "人事资料复核", approvers: ["人事负责人", "HRBP"] },
      { name: "行政资产准备", approvers: ["行政资产管理员"] },
      { name: "归档与通知", approvers: ["系统归档"] }
    ]
  },
  {
    code: "HR-REGULAR",
    name: "转正申请",
    category: "组织人事",
    formSchema: {
      fields: [
        { id: "employee", label: "转正员工", type: "input" },
        { id: "probationResult", label: "试用期结论", type: "select" },
        { id: "effectiveDate", label: "生效日期", type: "date" },
        { id: "reviewer", label: "评估负责人", type: "input" }
      ]
    },
    nodes: [
      { name: "直属负责人评价", approvers: ["部门负责人", "张三"] },
      { name: "人事复核", approvers: ["人事负责人", "HRBP"] },
      { name: "归档与通知", approvers: ["系统归档"] }
    ]
  },
  {
    code: "HR-TRANSFER",
    name: "调岗申请",
    category: "组织人事",
    formSchema: {
      fields: [
        { id: "employee", label: "调岗员工", type: "input" },
        { id: "fromDepartment", label: "调出部门", type: "input" },
        { id: "toDepartment", label: "调入部门", type: "input" },
        { id: "effectiveDate", label: "生效日期", type: "date" },
        { id: "handover", label: "交接安排", type: "textarea" }
      ]
    },
    nodes: [
      { name: "调出部门审批", approvers: ["原部门负责人"] },
      { name: "调入部门审批", approvers: ["接收部门负责人"] },
      { name: "人事复核", approvers: ["人事负责人", "HRBP"] },
      { name: "归档与通知", approvers: ["系统归档"] }
    ]
  },
  {
    code: "HR-OFFBOARD",
    name: "离职交接",
    category: "组织人事",
    formSchema: {
      fields: [
        { id: "employee", label: "离职员工", type: "input" },
        { id: "leaveDate", label: "最后工作日", type: "date" },
        { id: "reasonType", label: "离职类型", type: "select" },
        { id: "handover", label: "交接人", type: "input" },
        { id: "assetReturn", label: "资产归还", type: "select" }
      ]
    },
    nodes: [
      { name: "直属负责人交接确认", approvers: ["部门负责人", "张三"] },
      { name: "行政资产核验", approvers: ["行政资产管理员"] },
      { name: "财务结算", approvers: ["财务负责人"] },
      { name: "人事归档", approvers: ["人事负责人"] }
    ]
  },
  {
    code: "HR-EXCEPTION",
    name: "状态异常人员报备",
    category: "组织人事",
    formSchema: {
      fields: [
        { id: "employee", label: "异常人员", type: "input" },
        { id: "exceptionType", label: "异常类型", type: "select" },
        { id: "discoveredAt", label: "发现日期", type: "date" },
        { id: "actionPlan", label: "处理方案", type: "textarea" }
      ]
    },
    nodes: [
      { name: "直属负责人确认", approvers: ["部门负责人", "张三"] },
      { name: "人事核验", approvers: ["人事负责人", "HRBP"] },
      { name: "权限审计留痕", approvers: ["审计管理员"] },
      { name: "归档与通知", approvers: ["系统归档"] }
    ]
  },
  {
    code: "ATT-LEAVE",
    name: "请假申请",
    category: "假勤",
    formSchema: {
      fields: [
        { id: "leaveType", label: "假期类型", type: "select" },
        { id: "dateRange", label: "请假日期", type: "input" },
        { id: "days", label: "请假时长", type: "number" },
        { id: "handover", label: "工作交接人", type: "input" }
      ]
    },
    nodes: [
      { name: "直属负责人审批", approvers: ["部门负责人", "张三"] },
      { name: "人事备案", approvers: ["人事专员"] },
      { name: "归档与通知", approvers: ["系统归档"] }
    ]
  },
  {
    code: "ADM-ITEM",
    name: "物品领用",
    category: "行政资产",
    formSchema: {
      fields: [
        { id: "itemName", label: "领用品类", type: "input" },
        { id: "quantity", label: "数量", type: "number" },
        { id: "useScene", label: "使用场景", type: "select" }
      ]
    },
    nodes: [
      { name: "行政审批", approvers: ["行政资产管理员", "行政部负责人"] },
      { name: "行政出库", approvers: ["行政资产管理员"] },
      { name: "归档与通知", approvers: ["系统归档"] }
    ]
  },
  {
    code: "OPS-REPORT",
    name: "工作汇报",
    category: "数据分析",
    formSchema: {
      fields: [
        { id: "period", label: "汇报周期", type: "input" },
        { id: "summary", label: "本期进展", type: "textarea" },
        { id: "risk", label: "风险事项", type: "textarea" },
        { id: "nextPlan", label: "下期计划", type: "textarea" }
      ]
    },
    nodes: [
      { name: "直属负责人阅示", approvers: ["部门负责人", "张三"] },
      { name: "管理看板归档", approvers: ["数据管理员"] }
    ]
  },
  {
    code: "CRM-SERVICE",
    name: "客户接待申请",
    category: "客户服务",
    formSchema: {
      fields: [
        { id: "clientName", label: "客户名称", type: "input" },
        { id: "visitDate", label: "到访日期", type: "date" },
        { id: "visitorCount", label: "来访人数", type: "number" },
        { id: "resourceNeed", label: "资源需求", type: "input" }
      ]
    },
    nodes: [
      { name: "客服负责人确认", approvers: ["客服负责人", "张三"] },
      { name: "行政资源安排", approvers: ["行政资产管理员"] },
      { name: "归档与通知", approvers: ["系统归档"] }
    ]
  },
  {
    code: "CULTURE-EVENT",
    name: "文化活动申请",
    category: "企业文化",
    formSchema: {
      fields: [
        { id: "eventName", label: "活动名称", type: "input" },
        { id: "budget", label: "活动预算", type: "amount" },
        { id: "eventDate", label: "活动日期", type: "date" },
        { id: "participants", label: "参与范围", type: "input" }
      ]
    },
    nodes: [
      { name: "人事负责人审批", approvers: ["人事负责人"] },
      { name: "财务预算确认", approvers: ["财务负责人"] },
      { name: "行政资源安排", approvers: ["行政资产管理员"] },
      { name: "归档与通知", approvers: ["系统归档"] }
    ]
  },
  {
    code: "TRAIN-REQUEST",
    name: "培训申请",
    category: "培训学习",
    formSchema: {
      fields: [
        { id: "courseName", label: "课程名称", type: "input" },
        { id: "trainee", label: "参训人员", type: "input" },
        { id: "trainingDate", label: "培训日期", type: "date" },
        { id: "cost", label: "培训费用", type: "amount" }
      ]
    },
    nodes: [
      { name: "直属负责人审批", approvers: ["部门负责人", "张三"] },
      { name: "培训负责人确认", approvers: ["培训管理员"] },
      { name: "归档与通知", approvers: ["系统归档"] }
    ]
  }
];

const templateByCode = {
  "FIN-EXPENSE": "expense",
  "FIN-PAYMENT": "payment",
  "FIN-PAYROLL": "payroll",
  "HR-RECRUIT": "recruit",
  "HR-SALARY": "salary",
  "HR-ONBOARD": "onboarding",
  "HR-REGULAR": "regularization",
  "HR-TRANSFER": "transfer",
  "HR-OFFBOARD": "offboarding",
  "HR-EXCEPTION": "exception",
  "ATT-LEAVE": "leave",
  "ADM-ITEM": "item",
  "OPS-REPORT": "weekly_report",
  "CRM-SERVICE": "client_request",
  "CULTURE-EVENT": "culture_event",
  "TRAIN-REQUEST": "training_request"
};

const dashboardSourcePath = new URL("../oa-dashboard.html", import.meta.url);

function dashboardChecksum() {
  return createHash("sha256").update(readFileSync(dashboardSourcePath)).digest("hex");
}

function dateOrNull(value) {
  if (!value) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

async function seedTenant() {
  return prisma.tenant.upsert({
    where: { code: tenantCode },
    update: { name: "默认租户" },
    create: { code: tenantCode, name: "默认租户" }
  });
}

async function seedPermissions(tenantId) {
  await prisma.permission.createMany({
    data: permissions.map(([code, name, module]) => ({
      tenantId,
      code,
      name,
      module,
      description: `${module} module permission`
    })),
    skipDuplicates: true
  });
}

async function seedRole(tenantId) {
  const allPermissions = await prisma.permission.findMany({ where: { tenantId } });
  const permissionByCode = new Map(allPermissions.map((permission) => [permission.code, permission]));
  const roleCatalog = [
    {
      code: "admin",
      name: "系统管理员",
      description: "拥有商业 OA 原型全部权限",
      permissionCodes: allPermissions.map((permission) => permission.code)
    },
    {
      code: "employee-self-service",
      name: "员工自助",
      description: "员工个人工作台、审批发起、假勤、资源预约和附件上传权限",
      permissionCodes: ["workflow.read", "workflow.write", "attendance.read", "attendance.write", "resource.read", "resource.book", "file.read", "file.upload", "finance.read", "finance.write"]
    },
    {
      code: "hr-specialist",
      name: "人事专员",
      description: "维护人员档案、入转调离和假勤流程",
      permissionCodes: ["employee.read", "employee.write", "employee.export", "attendance.read", "attendance.write", "attendance.export", "workflow.read", "workflow.write", "workflow.approve", "import.read", "import.write"]
    },
    {
      code: "department-manager",
      name: "部门负责人",
      description: "查看本部门人员和处理本部门审批，人员数据默认按所属部门隔离",
      permissionCodes: ["employee.read", "employee.export", "attendance.read", "workflow.read", "workflow.approve"]
    },
    {
      code: "asset-admin",
      name: "行政资产管理员",
      description: "管理资产台账、二维码、借还和盘点",
      permissionCodes: ["asset.read", "asset.write", "asset.export", "resource.read", "resource.book", "resource.export", "workflow.read", "workflow.approve"]
    },
    {
      code: "finance-approver",
      name: "财务审批人",
      description: "处理付款、报销和工资单流程",
      permissionCodes: ["finance.read", "finance.write", "finance.export", "workflow.read", "workflow.approve", "audit.read"]
    },
    {
      code: "audit-viewer",
      name: "审计查看员",
      description: "查看操作日志、导出记录和敏感字段访问记录",
      permissionCodes: ["analytics.read", "analytics.export", "audit.read", "audit.export"]
    }
  ];

  let adminRole = null;
  for (const entry of roleCatalog) {
    const role = await prisma.role.upsert({
      where: { tenantId_code: { tenantId, code: entry.code } },
      update: { name: entry.name, description: entry.description },
      create: { tenantId, code: entry.code, name: entry.name, description: entry.description }
    });
    if (entry.code === "admin") adminRole = role;

    const permissionsForRole = entry.permissionCodes.map((code) => permissionByCode.get(code)).filter(Boolean);
    await prisma.rolePermission.deleteMany({ where: { tenantId, roleId: role.id } });
    await prisma.rolePermission.createMany({
      data: permissionsForRole.map((permission) => rolePermissionCreateData({ tenantId, role, permission })),
      skipDuplicates: true
    });
  }

  return adminRole;
}

async function seedDepartments(tenantId) {
  const parent = await prisma.department.upsert({
    where: { tenantId_code: { tenantId, code: "HQ" } },
    update: { name: "集团总部", sortOrder: 0 },
    create: { tenantId, code: "HQ", name: "集团总部", sortOrder: 0 }
  });

  const created = new Map([["HQ", parent]]);
  for (const [index, [code, name]] of departments.slice(1).entries()) {
    const department = await prisma.department.upsert({
      where: { tenantId_code: { tenantId, code } },
      update: { name, parentId: parent.id, sortOrder: index + 1 },
      create: { tenantId, code, name, parentId: parent.id, sortOrder: index + 1 }
    });
    created.set(code, department);
  }
  return created;
}

async function seedDashboardDepartments(tenantId, departmentsByCode, people) {
  const existing = new Set([...departmentsByCode.values()].map((item) => item.name));
  const dashboardDepartments = [...new Set([
    ...people.employees.map((item) => item.department),
    ...people.leavers.map((item) => item.department)
  ].filter(Boolean))];

  let sortOrder = departmentsByCode.size + 1;
  for (const departmentName of dashboardDepartments) {
    if (existing.has(departmentName)) continue;
    const code = `DASH-${Buffer.from(departmentName).toString("hex").slice(0, 18).toUpperCase()}`;
    const department = await prisma.department.upsert({
      where: { tenantId_code: { tenantId, code } },
      update: { name: departmentName, sortOrder },
      create: { tenantId, code, name: departmentName, sortOrder }
    });
    departmentsByCode.set(code, department);
    existing.add(departmentName);
    sortOrder += 1;
  }
}

async function seedAdmin(tenantId, role, department) {
  const employee = await prisma.employee.upsert({
    where: { tenantId_employeeNo: { tenantId, employeeNo: "EMP-ADMIN-001" } },
    update: {
      name: "系统管理员",
      departmentId: department.id,
      roleTitle: "OA系统管理员",
      status: "ACTIVE"
    },
    create: {
      tenantId,
      employeeNo: "EMP-ADMIN-001",
      name: "系统管理员",
      gender: "未设置",
      departmentId: department.id,
      roleTitle: "OA系统管理员",
      status: "ACTIVE",
      entryDate: new Date("2026-05-01T00:00:00.000Z"),
      email: adminEmail
    }
  });

  const passwordHash = await bcrypt.hash(adminPassword, 12);
  const user = await prisma.user.upsert({
    where: { tenantId_email: { tenantId, email: adminEmail } },
    update: {
      name: "系统管理员",
      passwordHash,
      employeeId: employee.id,
      status: "ACTIVE"
    },
    create: {
      tenantId,
      email: adminEmail,
      name: "系统管理员",
      passwordHash,
      employeeId: employee.id,
      status: "ACTIVE"
    }
  });

  await prisma.userRole.createMany({
    data: [{ tenantId, userId: user.id, roleId: role.id }],
    skipDuplicates: true
  });

  return user;
}

function departmentIdByName(departmentsByCode, name) {
  return [...departmentsByCode.values()].find((department) => department.name === name)?.id || null;
}

async function seedEmployees(tenantId, departmentsByCode, people) {
  const fallbackRows = [
    {
      employeeNo: "EMP-2026-0001",
      name: "张三",
      gender: "男",
      department: "行政部",
      role: "行政主管",
      email: "zhangsan@oa.local",
      status: "ACTIVE"
    },
    {
      employeeNo: "EMP-2026-0002",
      name: "李四",
      gender: "女",
      department: "人力资源部",
      role: "HRBP",
      email: "lisi@oa.local",
      status: "ACTIVE"
    },
    {
      employeeNo: "EMP-2026-0003",
      name: "王五",
      gender: "男",
      department: "财务中心",
      role: "财务专员",
      email: "wangwu@oa.local",
      status: "ACTIVE"
    }
  ];
  const dashboardRows = people.employees.length
    ? [
        ...people.employees.map((person, index) => ({
          ...person,
          employeeNo: `EMP-DASH-${String(person.seq || index + 1).padStart(4, "0")}`,
          status: "ACTIVE"
        })),
        ...people.leavers.map((person, index) => ({
          ...person,
          employeeNo: `LEV-DASH-${String(index + 1).padStart(4, "0")}`,
          status: "LEAVED"
        }))
      ]
    : fallbackRows;

  for (const row of dashboardRows) {
    await prisma.employee.upsert({
      where: { tenantId_employeeNo: { tenantId, employeeNo: row.employeeNo } },
      update: {
        name: row.name,
        gender: row.gender,
        roleTitle: row.role,
        email: row.email || null,
        departmentId: departmentIdByName(departmentsByCode, row.department),
        status: row.status,
        entryDate: dateOrNull(row.entryDate),
        leaveDate: dateOrNull(row.leaveDate),
        sensitiveInfo: {
          org: row.org,
          seq: row.seq,
          regularDate: row.regularDate,
          age: row.age,
          hukou: row.hukou,
          education: row.education,
          school: row.school,
          major: row.major,
          source: "oa-dashboard.html"
        }
      },
      create: {
        tenantId,
        employeeNo: row.employeeNo,
        name: row.name,
        gender: row.gender,
        roleTitle: row.role,
        email: row.email || null,
        departmentId: departmentIdByName(departmentsByCode, row.department),
        status: row.status,
        entryDate: dateOrNull(row.entryDate),
        leaveDate: dateOrNull(row.leaveDate),
        sensitiveInfo: {
          org: row.org,
          seq: row.seq,
          regularDate: row.regularDate,
          age: row.age,
          hukou: row.hukou,
          education: row.education,
          school: row.school,
          major: row.major,
          source: "oa-dashboard.html"
        }
      }
    });
  }
}

async function seedDataImportRun(tenantId, adminUser, people) {
  const sourceName = "oa-dashboard.html";
  const sourceChecksum = dashboardChecksum();
  const recordCounts = {
    activeEmployees: people.employees.length,
    femaleEmployees: people.femaleEmployees.length,
    leavers: people.leavers.length,
    monthLeavers: people.monthLeavers.length,
    totalRows: people.employees.length + people.leavers.length
  };
  const existing = await prisma.dataImportRun.findFirst({
    where: { tenantId, sourceName, sourceChecksum }
  });
  const data = {
    actorUserId: adminUser.id,
    sourceType: "html-dashboard",
    sourceName,
    sourceChecksum,
    status: "SUCCESS",
    recordCounts,
    metadata: {
      importedTables: ["employees", "departments"],
      parser: "scripts/dashboard-data.mjs",
      sourcePath: sourceName
    },
    finishedAt: new Date()
  };

  if (existing) {
    // Import lineage is append-only; rerunning seed must not mutate historical
    // source checksum evidence after it has been recorded.
    return;
  }

  await prisma.dataImportRun.create({
    data: { tenantId, ...data }
  });
}

async function seedWorkflowDefinitions(tenantId) {
  const created = [];
  for (const definition of workflowDefinitions) {
    const record = await prisma.workflowDefinition.upsert({
      where: { tenantId_code_version: { tenantId, code: definition.code, version: 1 } },
      update: {
        name: definition.name,
        category: definition.category,
        status: "ACTIVE",
        formSchema: definition.formSchema,
        ruleSnapshot: { nodes: definition.nodes }
      },
      create: {
        tenantId,
        code: definition.code,
        name: definition.name,
        category: definition.category,
        version: 1,
        status: "ACTIVE",
        formSchema: definition.formSchema,
        ruleSnapshot: { nodes: definition.nodes }
      }
    });

    await prisma.workflowDefinitionNode.deleteMany({ where: { definitionId: record.id } });
    await prisma.workflowDefinitionNode.createMany({
      data: definition.nodes.map((node, index) => ({
        tenantId,
        definitionId: record.id,
        name: node.name,
        stepOrder: index + 1,
        approvalMode: "AND",
        approverRule: { approvers: node.approvers }
      }))
    });

    created.push(record);
  }
  return created;
}

async function seedApprovalRules(tenantId, people, definitions) {
  const dashboardDepartments = people.departmentStats.map((item) => item.label);
  const fallbackDepartments = ["行政部", "人力资源部", "财务中心", "直播事业部", "采购部", "仓储部"];
  const ruleDepartments = [...new Set([...dashboardDepartments, ...fallbackDepartments].filter(Boolean))];

  for (const department of ruleDepartments) {
    for (const definition of workflowDefinitions) {
      const templateId = templateByCode[definition.code] || definition.code;
      const nodes = definition.nodes
        .filter((node) => !node.name.includes("归档"))
        .map((node, index) => ({
          id: `${templateId}-${index + 1}`,
          name: node.name,
          mode: "AND",
          approvers: index === 0
            ? [`${department}负责人`, "张三"]
            : node.approvers
        }));
      await prisma.approvalRule.upsert({
        where: {
          tenantId_department_templateId: {
            tenantId,
            department,
            templateId
          }
        },
        update: {
          templateName: definition.name,
          enabled: true,
          nodes
        },
        create: {
          tenantId,
          department,
          templateId,
          templateName: definition.name,
          enabled: true,
          nodes
        }
      });
    }
  }

  return definitions;
}

async function seedDemoWorkflowInstance(tenantId, definitions, adminUser, department) {
  const definition = definitions.find((item) => item.code === "FIN-EXPENSE");
  if (!definition) return;

  const existing = await prisma.workflowInstance.findFirst({
    where: { tenantId, definitionCode: definition.code, title: "演示费用报销" }
  });
  if (existing) return;

  const nodes = await prisma.workflowDefinitionNode.findMany({
    where: { definitionId: definition.id },
    orderBy: { stepOrder: "asc" }
  });

  const instance = await prisma.workflowInstance.create({
    data: {
      tenantId,
      definitionId: definition.id,
      definitionCode: definition.code,
      definitionVersion: definition.version,
      title: "演示费用报销",
      status: "PENDING",
      applicantUserId: adminUser.id,
      departmentId: department.id,
      submittedAt: new Date("2026-05-29T09:30:00.000Z"),
      formData: {
        expenseType: "办公采购",
        amount: 980,
        invoice: 2,
        occurredAt: "2026-05-29"
      },
      definitionSnapshot: {
        id: definition.id,
        code: definition.code,
        version: definition.version,
        nodes: nodes.map((node) => ({
          name: node.name,
          stepOrder: node.stepOrder,
          approvalMode: node.approvalMode,
          approverRule: node.approverRule
        }))
      }
    }
  });

  let firstNodeId = null;
  for (const node of nodes) {
    const createdNode = await prisma.workflowInstanceNode.create({
      data: {
        tenantId,
        instanceId: instance.id,
        name: node.name,
        stepOrder: node.stepOrder,
        approvalMode: node.approvalMode,
        status: node.stepOrder === 1 ? "ACTIVE" : "PENDING",
        startedAt: node.stepOrder === 1 ? new Date("2026-05-29T09:30:00.000Z") : null
      }
    });
    firstNodeId = firstNodeId || createdNode.id;

    const approvers = node.approverRule?.approvers || ["系统管理员"];
    await prisma.workflowApprover.createMany({
      data: approvers.map((approverName) => ({
        tenantId,
        nodeId: createdNode.id,
        userId: approverName === "张三" ? adminUser.id : null,
        approverName,
        status: "PENDING"
      }))
    });
  }

  await prisma.workflowInstance.update({
    where: { id: instance.id },
    data: { currentNodeId: firstNodeId }
  });
}

async function createSeedWorkflowInstance({
  tenantId,
  definition,
  adminUser,
  department,
  title,
  formData,
  status = "PENDING",
  submittedAt = new Date("2026-05-29T09:30:00.000Z")
}) {
  if (!definition || !department) return null;
  const existing = await prisma.workflowInstance.findFirst({
    where: { tenantId, definitionCode: definition.code, title }
  });
  if (existing) return existing;

  const nodes = await prisma.workflowDefinitionNode.findMany({
    where: { definitionId: definition.id },
    orderBy: { stepOrder: "asc" }
  });
  const approved = status === "APPROVED";
  const instance = await prisma.workflowInstance.create({
    data: {
      tenantId,
      definitionId: definition.id,
      definitionCode: definition.code,
      definitionVersion: definition.version,
      title,
      status,
      applicantUserId: adminUser.id,
      departmentId: department.id,
      submittedAt,
      completedAt: approved ? submittedAt : null,
      formData,
      definitionSnapshot: {
        id: definition.id,
        code: definition.code,
        version: definition.version,
        nodes: nodes.map((node) => ({
          name: node.name,
          stepOrder: node.stepOrder,
          approvalMode: node.approvalMode,
          approverRule: node.approverRule
        }))
      }
    }
  });

  let firstNodeId = null;
  for (const node of nodes) {
    const createdNode = await prisma.workflowInstanceNode.create({
      data: {
        tenantId,
        instanceId: instance.id,
        name: node.name,
        stepOrder: node.stepOrder,
        approvalMode: node.approvalMode,
        status: approved ? "APPROVED" : node.stepOrder === 1 ? "ACTIVE" : "PENDING",
        startedAt: submittedAt,
        completedAt: approved ? submittedAt : null
      }
    });
    if (!approved) firstNodeId = firstNodeId || createdNode.id;

    const approvers = node.approverRule?.approvers || ["系统管理员"];
    await prisma.workflowApprover.createMany({
      data: approvers.map((approverName) => ({
        tenantId,
        nodeId: createdNode.id,
        userId: approverName === "张三" || approverName === "财务负责人" ? adminUser.id : null,
        approverName,
        status: approved ? "APPROVED" : "PENDING",
        decision: approved ? "pass" : null,
        comment: approved ? "种子数据审批通过" : null,
        decidedAt: approved ? submittedAt : null
      }))
    });
  }

  if (firstNodeId) {
    return prisma.workflowInstance.update({
      where: { id: instance.id },
      data: { currentNodeId: firstNodeId }
    });
  }
  return instance;
}

async function seedAssetsResourcesFiles(tenantId, adminUser) {
  await prisma.asset.upsert({
    where: { tenantId_assetNo: { tenantId, assetNo: "IT-2024-000123" } },
    update: { name: "联想 ThinkPad X1 Carbon", status: "BORROWED", owner: "张三" },
    create: {
      tenantId,
      assetNo: "IT-2024-000123",
      name: "联想 ThinkPad X1 Carbon",
      category: "办公电脑",
      status: "BORROWED",
      owner: "张三",
      location: "集团总部 · 行政部"
    }
  });

  const resource = await prisma.resource.upsert({
    where: { tenantId_code: { tenantId, code: "ROOM-001" } },
    update: { name: "一号会议室", type: "会议室", capacity: 10, status: "AVAILABLE" },
    create: {
      tenantId,
      code: "ROOM-001",
      type: "会议室",
      name: "一号会议室",
      capacity: 10,
      status: "AVAILABLE",
      location: "集团总部 3F"
    }
  });

  const existingBooking = await prisma.booking.findFirst({
    where: {
      tenantId,
      resourceId: resource.id,
      startsAt: new Date("2026-05-30T09:00:00.000Z")
    }
  });
  if (!existingBooking) {
    await prisma.booking.create({
      data: {
        tenantId,
        resourceId: resource.id,
        applicantId: adminUser.id,
        purpose: "周例会",
        status: "CONFIRMED",
        startsAt: new Date("2026-05-30T09:00:00.000Z"),
        endsAt: new Date("2026-05-30T10:00:00.000Z"),
        metadata: { applicant: "系统管理员", source: "scripts/seed.mjs" }
      }
    });
  }

  const seedStorageKey = "seed/readme.txt";
  const seedContent = Buffer.from("Deep OA commercial seed attachment.\n", "utf8");
  const seedFileChecksum = createHash("sha256").update(seedContent).digest("hex");
  await fileStorage.delete(seedStorageKey).catch(() => {});
  await fileStorage.put(seedStorageKey, seedContent);

  const existingFile = await prisma.fileObject.findFirst({
    where: { tenantId, storageKey: seedStorageKey }
  });
  if (!existingFile) {
    await prisma.fileObject.create({
      data: {
        tenantId,
        uploaderUserId: adminUser.id,
        fileName: "readme.txt",
        mimeType: "text/plain",
        storageKey: seedStorageKey,
        sizeBytes: BigInt(seedContent.length),
        checksum: seedFileChecksum,
        visibility: "TENANT"
      }
    });
  } else if (existingFile.checksum !== seedFileChecksum || existingFile.sizeBytes !== BigInt(seedContent.length)) {
    await prisma.fileObject.update({
      where: { id: existingFile.id },
      data: {
        checksum: seedFileChecksum,
        sizeBytes: BigInt(seedContent.length)
      }
    });
  }
}

async function seedAuditLogs(tenantId, adminUser) {
  const exists = await prisma.auditLog.findFirst({
    where: { tenantId, action: "seed.bootstrap", objectType: "system" }
  });
  if (exists) return;

  await prisma.auditLog.createMany({
    data: [
      {
        tenantId,
        actorUserId: adminUser.id,
        action: "seed.bootstrap",
        objectType: "system",
        summary: "初始化商业 OA 后端演示数据",
        metadata: { result: "成功", source: "scripts/seed.mjs" },
        ipAddress: "127.0.0.1"
      },
      {
        tenantId,
        actorUserId: adminUser.id,
        action: "auth.login",
        objectType: "user",
        objectId: adminUser.id,
        summary: "演示管理员登录审计样例",
        metadata: { demo: true, result: "成功" },
        ipAddress: "127.0.0.1"
      }
    ]
  });
}

async function seedFinanceAttendance(tenantId, adminUser, definitions, departmentsByCode) {
  const leaveDefinition = definitions.find((item) => item.code === "ATT-LEAVE");
  const expenseDefinition = definitions.find((item) => item.code === "FIN-EXPENSE");
  const paymentDefinition = definitions.find((item) => item.code === "FIN-PAYMENT");
  const payrollDefinition = definitions.find((item) => item.code === "FIN-PAYROLL");
  const adminDepartment = departmentsByCode.get("ADMIN");
  const financeDepartment = departmentsByCode.get("FIN");

  const pendingLeaveWorkflow = await createSeedWorkflowInstance({
    tenantId,
    definition: leaveDefinition,
    adminUser,
    department: adminDepartment,
    title: "张三年假申请",
    formData: {
      employee: "张三",
      applicant: "张三",
      department: "行政部",
      leaveType: "年假",
      dateRange: "2026-05-30 ~ 2026-05-31",
      days: 2,
      handover: "李四"
    },
    status: "PENDING",
    submittedAt: new Date("2026-05-29T09:10:00.000Z")
  });
  const existingLeave = await prisma.leaveRequest.findFirst({
    where: { tenantId, employeeName: "张三", leaveType: "年假", dateRange: "2026-05-30 ~ 2026-05-31" }
  });
  if (!existingLeave) {
    await prisma.leaveRequest.create({
      data: {
        tenantId,
        applicantUserId: adminUser.id,
        workflowInstanceId: pendingLeaveWorkflow?.id || null,
        employeeName: "张三",
        leaveType: "年假",
        dateRange: "2026-05-30 ~ 2026-05-31",
        days: 2,
        status: "PENDING",
        metadata: { handover: "李四", source: "scripts/seed.mjs" }
      }
    });
  } else if (!existingLeave.workflowInstanceId && pendingLeaveWorkflow?.id) {
    await prisma.leaveRequest.update({
      where: { id: existingLeave.id },
      data: { workflowInstanceId: pendingLeaveWorkflow.id }
    });
  }

  const approvedLeaveWorkflow = await createSeedWorkflowInstance({
    tenantId,
    definition: leaveDefinition,
    adminUser,
    department: adminDepartment,
    title: "戴慧敏病假申请",
    formData: {
      employee: "戴慧敏",
      applicant: "戴慧敏",
      department: "行政部",
      leaveType: "病假",
      dateRange: "2026-05-27",
      days: 1
    },
    status: "APPROVED",
    submittedAt: new Date("2026-05-27T09:00:00.000Z")
  });
  const existingApprovedLeave = await prisma.leaveRequest.findFirst({
    where: { tenantId, employeeName: "戴慧敏", leaveType: "病假", dateRange: "2026-05-27" }
  });
  if (!existingApprovedLeave) {
    await prisma.leaveRequest.create({
      data: {
        tenantId,
        applicantUserId: adminUser.id,
        workflowInstanceId: approvedLeaveWorkflow?.id || null,
        employeeName: "戴慧敏",
        leaveType: "病假",
        dateRange: "2026-05-27",
        days: 1,
        status: "APPROVED",
        metadata: { source: "scripts/seed.mjs" }
      }
    });
  } else if (!existingApprovedLeave.workflowInstanceId && approvedLeaveWorkflow?.id) {
    await prisma.leaveRequest.update({
      where: { id: existingApprovedLeave.id },
      data: { workflowInstanceId: approvedLeaveWorkflow.id }
    });
  }

  const attendanceRecords = [
    {
      employeeName: "张三",
      department: "行政部",
      workDate: new Date("2026-05-29T00:00:00.000Z"),
      checkInAt: new Date("2026-05-29T08:58:00.000Z"),
      checkOutAt: new Date("2026-05-29T18:05:00.000Z"),
      status: "NORMAL",
      minutesLate: 0,
      source: "access_control",
      metadata: { sourceName: "门禁同步" }
    },
    {
      employeeName: "李四",
      department: "人事部",
      workDate: new Date("2026-05-29T00:00:00.000Z"),
      checkInAt: new Date("2026-05-29T09:18:00.000Z"),
      checkOutAt: new Date("2026-05-29T18:10:00.000Z"),
      status: "LATE",
      minutesLate: 18,
      source: "access_control",
      metadata: { sourceName: "门禁同步", reason: "地铁延误" }
    },
    {
      employeeName: "王五",
      department: "财务中心",
      workDate: new Date("2026-05-29T00:00:00.000Z"),
      checkInAt: null,
      checkOutAt: new Date("2026-05-29T18:02:00.000Z"),
      status: "MISSING",
      minutesLate: 0,
      source: "manual",
      metadata: { sourceName: "手动补录", reason: "早卡缺失" }
    }
  ];
  for (const record of attendanceRecords) {
    const existingRecord = await prisma.attendanceRecord.findFirst({
      where: { tenantId, employeeName: record.employeeName, workDate: record.workDate }
    });
    if (!existingRecord) {
      await prisma.attendanceRecord.create({ data: { tenantId, ...record } });
    }
  }

  const financeRequestSeeds = [
    {
      requestNo: "EXP-202605-0001",
      requestType: "EXPENSE",
      title: "办公室耗材报销",
      department: adminDepartment,
      definition: expenseDefinition,
      amount: 2680,
      vendor: "京东企业购",
      paymentMethod: "员工垫付",
      status: "PENDING_APPROVAL",
      workflowStatus: "PENDING",
      metadata: { expenseType: "办公采购", purpose: "行政办公耗材补充", source: "scripts/seed.mjs" }
    },
    {
      requestNo: "PAY-202605-0001",
      requestType: "PAYMENT",
      title: "物业服务费付款",
      department: financeDepartment,
      definition: paymentDefinition,
      amount: 18000,
      vendor: "园区物业",
      paymentMethod: "对公转账",
      status: "APPROVED",
      workflowStatus: "APPROVED",
      metadata: { purpose: "5月物业管理服务费", source: "scripts/seed.mjs" }
    }
  ];
  for (const seed of financeRequestSeeds) {
    const workflow = await createSeedWorkflowInstance({
      tenantId,
      definition: seed.definition,
      adminUser,
      department: seed.department,
      title: seed.title,
      formData: {
        requestNo: seed.requestNo,
        requestType: seed.requestType,
        amount: seed.amount,
        vendor: seed.vendor,
        paymentMethod: seed.paymentMethod,
        purpose: seed.metadata.purpose
      },
      status: seed.workflowStatus,
      submittedAt: new Date("2026-05-29T09:30:00.000Z")
    });
    await prisma.financeRequest.upsert({
      where: { tenantId_requestNo: { tenantId, requestNo: seed.requestNo } },
      update: {
        title: seed.title,
        requestType: seed.requestType,
        department: seed.department?.name || "财务中心",
        amount: seed.amount,
        vendor: seed.vendor,
        paymentMethod: seed.paymentMethod,
        status: seed.status,
        workflowInstanceId: workflow?.id || null,
        metadata: {
          ...seed.metadata,
          workflowInstanceId: workflow?.id || null,
          workflowStatus: workflow?.status || seed.workflowStatus,
          applicant: adminUser.name
        }
      },
      create: {
        tenantId,
        requestNo: seed.requestNo,
        requestType: seed.requestType,
        title: seed.title,
        applicantUserId: adminUser.id,
        department: seed.department?.name || "财务中心",
        amount: seed.amount,
        currency: "CNY",
        vendor: seed.vendor,
        paymentMethod: seed.paymentMethod,
        status: seed.status,
        workflowInstanceId: workflow?.id || null,
        metadata: {
          ...seed.metadata,
          workflowInstanceId: workflow?.id || null,
          workflowStatus: workflow?.status || seed.workflowStatus,
          applicant: adminUser.name
        }
      }
    });
  }

  const payrollWorkflow = await createSeedWorkflowInstance({
    tenantId,
    definition: payrollDefinition,
    adminUser,
    department: financeDepartment,
    title: "2026年5月工资单复核",
    formData: {
      cycle: "2026年5月",
      scope: "在职、转正、入离职、异动人员",
      headcount: 72,
      totalAmount: 486000
    },
    status: "APPROVED",
    submittedAt: new Date("2026-05-29T08:30:00.000Z")
  });
  const payrolls = [
    { batchNo: "PAYROLL-202605", cycle: "2026年5月", scope: "在职、转正、入离职、异动人员", status: "PENDING_REVIEW", workflowInstanceId: payrollWorkflow?.id || null },
    { batchNo: "PAYROLL-202604", cycle: "2026年4月", scope: "全员", status: "ARCHIVED", workflowInstanceId: null }
  ];
  for (const payroll of payrolls) {
    await prisma.payrollBatch.upsert({
      where: { tenantId_batchNo: { tenantId, batchNo: payroll.batchNo } },
      update: {
        cycle: payroll.cycle,
        scope: payroll.scope,
        owner: "财务中心",
        status: payroll.status,
        workflowInstanceId: payroll.workflowInstanceId
      },
      create: {
        tenantId,
        batchNo: payroll.batchNo,
        cycle: payroll.cycle,
        scope: payroll.scope,
        owner: "财务中心",
        status: payroll.status,
        workflowInstanceId: payroll.workflowInstanceId,
        metadata: { source: "scripts/seed.mjs" }
      }
    });
  }
}

async function main() {
  const people = loadDashboardPeople();
  const tenant = await seedTenant();
  await seedPermissions(tenant.id);
  const role = await seedRole(tenant.id);
  const departmentsByCode = await seedDepartments(tenant.id);
  await seedDashboardDepartments(tenant.id, departmentsByCode, people);
  const adminUser = await seedAdmin(tenant.id, role, departmentsByCode.get("ADMIN"));
  await seedEmployees(tenant.id, departmentsByCode, people);
  await seedDataImportRun(tenant.id, adminUser, people);
  const definitions = await seedWorkflowDefinitions(tenant.id);
  await seedApprovalRules(tenant.id, people, definitions);
  await seedDemoWorkflowInstance(tenant.id, definitions, adminUser, departmentsByCode.get("ADMIN"));
  await seedAssetsResourcesFiles(tenant.id, adminUser);
  await seedFinanceAttendance(tenant.id, adminUser, definitions, departmentsByCode);
  await seedAuditLogs(tenant.id, adminUser);

  console.log(`Seeded tenant "${tenant.code}" with admin ${adminEmail}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
