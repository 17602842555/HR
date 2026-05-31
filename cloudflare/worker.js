import { nativeSeedData } from "./native-seed-data.js";

const SECURITY_HEADERS = {
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY"
};

const LOCAL_HOSTNAMES = new Set([
  "0.0.0.0",
  "localhost",
  "127.0.0.1",
  "::1",
  "0:0:0:0:0:0:0:1"
]);

const SESSION_COOKIE = "oa_cf_session";
const STATE_KEY = "oa_state_v1";
const STATE_SCHEMA_VERSION = 1;

let memoryState = null;

function hasEdgeCache() {
  return typeof caches !== "undefined" && Boolean(caches.default);
}

function fallbackStorageMode() {
  return hasEdgeCache() ? "edge-cache" : "memory";
}

function stateCacheKey() {
  return new Request(`https://deep-oa-state.invalid/${STATE_KEY}`);
}

function json(payload, init = {}) {
  return new Response(JSON.stringify(payload), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...SECURITY_HEADERS,
      ...(init.headers || {})
    }
  });
}

function text(payload, init = {}) {
  return new Response(payload, {
    ...init,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      ...SECURITY_HEADERS,
      ...(init.headers || {})
    }
  });
}

function csv(payload, filename = "export.csv") {
  return text(payload, {
    headers: {
      "content-disposition": `attachment; filename="${filename}"`,
      "content-type": "text/csv; charset=utf-8"
    }
  });
}

function withSecurityHeaders(response) {
  const headers = new Headers(response.headers);
  Object.entries(SECURITY_HEADERS).forEach(([key, value]) => headers.set(key, value));
  if (!headers.has("cache-control") && headers.get("content-type")?.includes("text/html")) {
    headers.set("cache-control", "no-store");
  }
  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText
  });
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function nowIso() {
  return new Date().toISOString();
}

function localTime() {
  return nowIso().replace("T", " ").slice(0, 19);
}

function nextId(prefix) {
  const random = typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID().slice(0, 8).toUpperCase()
    : Math.random().toString(16).slice(2, 10).toUpperCase();
  return `${prefix}-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${random}`;
}

function normalizedHostname(hostname) {
  return String(hostname || "").trim().toLowerCase().replace(/^\[|\]$/g, "");
}

function isPrivateIpv4(hostname) {
  const parts = String(hostname || "").split(".");
  if (parts.length !== 4) return false;
  const numbers = parts.map((part) => Number.parseInt(part, 10));
  if (numbers.some((number, index) => !Number.isInteger(number) || String(number) !== parts[index] || number < 0 || number > 255)) {
    return false;
  }
  const [first, second] = numbers;
  return first === 0
    || first === 10
    || first === 127
    || (first === 169 && second === 254)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168)
    || (first === 100 && second >= 64 && second <= 127);
}

function isUnsafeHostname(hostname) {
  const value = normalizedHostname(hostname);
  if (LOCAL_HOSTNAMES.has(value) || value.endsWith(".local")) return true;
  if (isPrivateIpv4(value)) return true;
  if (value.includes(":")) {
    return value.startsWith("fe80:")
      || value.startsWith("fc")
      || value.startsWith("fd");
  }
  return false;
}

export function validateApiOrigin(rawValue, requestUrl) {
  const value = String(rawValue || "").trim();
  if (!value) {
    return {
      code: "api_origin_not_configured",
      configured: false,
      message: "Cloudflare Worker 未配置 API_ORIGIN；当前将优先使用 Cloudflare 原生 API。",
      ok: false
    };
  }

  let targetUrl;
  try {
    targetUrl = new URL(value);
  } catch {
    return {
      code: "api_origin_invalid",
      configured: true,
      message: "Cloudflare Worker 的 API_ORIGIN 不是有效的 HTTPS 后端地址。",
      ok: false
    };
  }

  if (targetUrl.protocol !== "https:") {
    return {
      code: "api_origin_invalid",
      configured: true,
      message: "Cloudflare Worker 的 API_ORIGIN 必须使用 HTTPS。",
      ok: false
    };
  }

  if (targetUrl.username || targetUrl.password || isUnsafeHostname(targetUrl.hostname)) {
    return {
      code: "api_origin_unsafe",
      configured: true,
      message: "Cloudflare Worker 的 API_ORIGIN 指向了不允许的后端地址。",
      ok: false
    };
  }

  const incomingOrigin = new URL(requestUrl).origin;
  if (targetUrl.origin === incomingOrigin) {
    return {
      code: "api_origin_loop",
      configured: true,
      message: "Cloudflare Worker 的 API_ORIGIN 不能和前端部署地址相同。",
      ok: false
    };
  }

  return {
    configured: true,
    ok: true,
    url: targetUrl
  };
}

async function proxyApi(request, env) {
  const originValidation = validateApiOrigin(env.API_ORIGIN, request.url);
  if (!originValidation.ok) {
    return json({
      error: originValidation.code,
      message: originValidation.message
    }, { status: 503 });
  }

  const incomingUrl = new URL(request.url);
  const targetUrl = new URL(originValidation.url);
  targetUrl.pathname = incomingUrl.pathname;
  targetUrl.search = incomingUrl.search;

  const headers = new Headers(request.headers);
  headers.set("X-Forwarded-Host", incomingUrl.host);
  headers.set("X-Forwarded-Proto", incomingUrl.protocol.replace(":", ""));
  headers.set("X-Request-Source", "cloudflare-worker");

  const proxied = await fetch(targetUrl, {
    body: ["GET", "HEAD"].includes(request.method) ? undefined : request.body,
    headers,
    method: request.method,
    redirect: "manual"
  });
  return withSecurityHeaders(proxied);
}

const permissions = [
  { id: "PERM-system.admin", code: "system.admin", name: "系统管理", module: "system" },
  { id: "PERM-analytics.read", code: "analytics.read", name: "查看管理看板", module: "analytics" },
  { id: "PERM-analytics.export", code: "analytics.export", name: "导出管理看板", module: "analytics" },
  { id: "PERM-iam.read", code: "iam.read", name: "查看用户角色", module: "iam" },
  { id: "PERM-iam.write", code: "iam.write", name: "管理用户角色", module: "iam" },
  { id: "PERM-employee.read", code: "employee.read", name: "查看员工", module: "people" },
  { id: "PERM-employee.sensitive.read", code: "employee.sensitive.read", name: "查看员工敏感字段", module: "people" },
  { id: "PERM-employee.write", code: "employee.write", name: "管理员工", module: "people" },
  { id: "PERM-employee.export", code: "employee.export", name: "导出员工名册", module: "people" },
  { id: "PERM-workflow.read", code: "workflow.read", name: "查看审批", module: "workflow" },
  { id: "PERM-workflow.write", code: "workflow.write", name: "配置审批", module: "workflow" },
  { id: "PERM-workflow.approve", code: "workflow.approve", name: "处理审批", module: "workflow" },
  { id: "PERM-workflow.export", code: "workflow.export", name: "导出审批列表", module: "workflow" },
  { id: "PERM-attendance.read", code: "attendance.read", name: "查看假勤", module: "attendance" },
  { id: "PERM-attendance.write", code: "attendance.write", name: "管理假勤", module: "attendance" },
  { id: "PERM-finance.read", code: "finance.read", name: "查看财务", module: "finance" },
  { id: "PERM-finance.write", code: "finance.write", name: "管理财务", module: "finance" },
  { id: "PERM-asset.read", code: "asset.read", name: "查看资产", module: "asset" },
  { id: "PERM-asset.write", code: "asset.write", name: "管理资产", module: "asset" },
  { id: "PERM-resource.read", code: "resource.read", name: "查看资源", module: "resource" },
  { id: "PERM-resource.book", code: "resource.book", name: "预约资源", module: "resource" },
  { id: "PERM-audit.read", code: "audit.read", name: "查看审计日志", module: "audit" },
  { id: "PERM-audit.export", code: "audit.export", name: "导出审计日志", module: "audit" },
  { id: "PERM-file.read", code: "file.read", name: "查看附件", module: "file" },
  { id: "PERM-file.upload", code: "file.upload", name: "上传附件", module: "file" }
];

function permissionsByCode(codes) {
  const codeSet = new Set(codes);
  return permissions.filter((permission) => codeSet.has(permission.code));
}

const roles = [
  {
    id: "ROLE-admin",
    code: "admin",
    name: "系统管理员",
    description: "拥有系统配置、审批、审计与数据管理权限",
    permissionCodes: permissions.map((permission) => permission.code)
  },
  {
    id: "ROLE-employee",
    code: "employee-self-service",
    name: "员工自助",
    description: "员工个人工作台、审批发起、假勤、资源预约和附件上传权限",
    permissionCodes: ["workflow.read", "workflow.write", "attendance.read", "attendance.write", "resource.read", "resource.book", "file.read", "file.upload", "finance.read", "finance.write"]
  },
  {
    id: "ROLE-hr",
    code: "hr-specialist",
    name: "人事专员",
    description: "维护人员档案、入转调离和假勤流程",
    permissionCodes: ["employee.read", "employee.write", "employee.export", "attendance.read", "attendance.write", "workflow.read", "workflow.write", "workflow.approve"]
  },
  {
    id: "ROLE-department-manager",
    code: "department-manager",
    name: "部门负责人",
    description: "按所属部门查看人员，并处理本部门审批",
    permissionCodes: ["employee.read", "workflow.read", "workflow.approve"]
  },
  {
    id: "ROLE-asset",
    code: "asset-admin",
    name: "行政资产管理员",
    description: "管理资产台账、二维码、借还和盘点",
    permissionCodes: ["asset.read", "asset.write", "resource.read", "resource.book", "workflow.read", "workflow.approve"]
  },
  {
    id: "ROLE-finance",
    code: "finance-approver",
    name: "财务审批人",
    description: "处理付款、报销和工资单流程",
    permissionCodes: ["finance.read", "finance.write", "workflow.read", "workflow.approve", "audit.read"]
  },
  {
    id: "ROLE-auditor",
    code: "audit-viewer",
    name: "审计查看员",
    description: "查看操作日志、导出记录和敏感字段访问记录",
    permissionCodes: ["analytics.read", "analytics.export", "audit.read", "audit.export"]
  }
].map((role) => ({
  ...role,
  permissions: permissionsByCode(role.permissionCodes),
  userCount: role.code === "admin" ? 1 : 0
}));

const flowTemplates = [
  {
    id: "expense",
    name: "费用报销",
    owner: "张三",
    department: "行政部",
    amount: "¥980.00",
    node: "财务复核",
    category: "财务行政",
    sla: "24h",
    serviceKey: "FIN-EXPENSE",
    condition: "金额 >= 500 元时进入财务复核",
    approvalMode: "会签",
    fields: [
      { id: "expenseType", label: "报销类型", type: "select", value: "办公采购" },
      { id: "amount", label: "报销金额", type: "amount", value: "980" },
      { id: "invoice", label: "发票张数", type: "number", value: "2" },
      { id: "occurredAt", label: "发生日期", type: "date", value: "2026-05-29" }
    ],
    nodes: ["申请人提交", "直属负责人审批", "财务复核", "归档与通知"]
  },
  {
    id: "payment",
    name: "付款申请",
    owner: "王五",
    department: "财务部",
    amount: "¥8,950.00",
    node: "出纳付款",
    category: "财务行政",
    sla: "48h",
    serviceKey: "FIN-PAYMENT",
    condition: "金额 >= 5000 元增加负责人会签",
    approvalMode: "会签",
    fields: [
      { id: "supplier", label: "收款方", type: "input", value: "供应商 A" },
      { id: "amount", label: "付款金额", type: "amount", value: "8950" },
      { id: "bankAccount", label: "收款账号", type: "input", value: "6222 **** **** 8821" },
      { id: "payDate", label: "期望付款日", type: "date", value: "2026-05-31" }
    ],
    nodes: ["申请人提交", "采购负责人审批", "财务复核", "出纳付款", "归档与通知"]
  },
  {
    id: "payroll",
    name: "工资单复核",
    owner: "财务中心",
    department: "财务部",
    amount: "72人",
    node: "财务负责人审批",
    category: "财务行政",
    sla: "24h",
    serviceKey: "FIN-PAYROLL",
    condition: "工资单需薪资、财务、人事全部确认后发布",
    approvalMode: "会签",
    fields: [
      { id: "cycle", label: "工资周期", type: "input", value: "2026年5月" },
      { id: "headcount", label: "发薪人数", type: "number", value: "72" },
      { id: "totalAmount", label: "工资总额", type: "amount", value: "486000" }
    ],
    nodes: ["申请人提交", "薪资专员复核", "财务负责人审批", "人事负责人确认", "归档与通知"]
  },
  {
    id: "recruit",
    name: "招聘需求",
    owner: "李四",
    department: "人事行政部",
    amount: "2人",
    node: "编制复核",
    category: "组织人事",
    sla: "72h",
    serviceKey: "HR-RECRUIT",
    condition: "新增编制需人事与部门负责人会签",
    approvalMode: "会签",
    fields: [
      { id: "position", label: "招聘岗位", type: "input", value: "短视频运营" },
      { id: "headcount", label: "需求人数", type: "number", value: "2" },
      { id: "level", label: "岗位级别", type: "select", value: "P2" },
      { id: "targetDate", label: "到岗日期", type: "date", value: "2026-06-15" }
    ],
    nodes: ["申请人提交", "部门负责人审批", "编制复核", "HRBP 归档"]
  },
  {
    id: "salary",
    name: "调薪申请",
    owner: "周八",
    department: "直播部",
    amount: "¥1,200.00",
    node: "薪酬审批",
    category: "组织人事",
    sla: "72h",
    serviceKey: "HR-SALARY",
    condition: "调薪比例 > 15% 时增加总经理审批",
    approvalMode: "顺序审批",
    fields: [
      { id: "employee", label: "调薪员工", type: "input", value: "周八" },
      { id: "adjustAmount", label: "调整金额", type: "amount", value: "1200" },
      { id: "effectiveDate", label: "生效日期", type: "date", value: "2026-06-01" }
    ],
    nodes: ["申请人提交", "直属负责人审批", "薪酬审批", "总经理审批", "归档与通知"]
  },
  {
    id: "transfer",
    name: "调岗申请",
    owner: "李四",
    department: "直播运营部",
    amount: "调岗",
    node: "调出调入会签",
    category: "组织人事",
    sla: "72h",
    serviceKey: "HR-TRANSFER",
    condition: "调岗需原部门、接收部门、人事全部同意",
    approvalMode: "会签",
    fields: [
      { id: "employee", label: "调岗员工", type: "input", value: "周八" },
      { id: "fromDepartment", label: "调出部门", type: "input", value: "直播部" },
      { id: "toDepartment", label: "调入部门", type: "input", value: "运营中心" }
    ],
    nodes: ["申请人提交", "调出部门审批", "调入部门审批", "人事复核", "归档与通知"]
  },
  {
    id: "offboarding",
    name: "离职交接",
    owner: "李四",
    department: "人事行政部",
    amount: "离职",
    node: "交接确认",
    category: "组织人事",
    sla: "72h",
    serviceKey: "HR-OFFBOARD",
    condition: "离职需工作交接、资产归还、财务结算全部完成",
    approvalMode: "会签",
    fields: [
      { id: "employee", label: "离职员工", type: "input", value: "待离职员工" },
      { id: "leaveDate", label: "最后工作日", type: "date", value: "2026-06-15" },
      { id: "reasonType", label: "离职类型", type: "select", value: "个人原因" }
    ],
    nodes: ["申请人提交", "直属负责人交接确认", "行政资产核验", "财务结算", "人事归档"]
  },
  {
    id: "leave",
    name: "请假申请",
    owner: "赵六",
    department: "客服部",
    amount: "2天",
    node: "直属负责人审批",
    category: "假勤",
    sla: "24h",
    serviceKey: "ATT-LEAVE",
    condition: "请假 >= 3 天时增加人事备案",
    approvalMode: "顺序审批",
    fields: [
      { id: "leaveType", label: "假期类型", type: "select", value: "年假" },
      { id: "dateRange", label: "请假日期", type: "input", value: "2026-05-30 ~ 2026-05-31" },
      { id: "days", label: "请假时长", type: "number", value: "2" }
    ],
    nodes: ["申请人提交", "直属负责人审批", "人事备案", "归档与通知"]
  },
  {
    id: "item",
    name: "物品领用",
    owner: "张三",
    department: "行政部",
    amount: "直播耗材",
    node: "行政出库",
    category: "行政资产",
    sla: "24h",
    serviceKey: "ADM-ITEM",
    condition: "高值物品需行政资产管理员确认",
    approvalMode: "或签",
    fields: [
      { id: "itemName", label: "领用品类", type: "input", value: "直播耗材" },
      { id: "quantity", label: "数量", type: "number", value: "1" },
      { id: "useScene", label: "使用场景", type: "select", value: "直播间" }
    ],
    nodes: ["申请人提交", "行政审批", "行政出库", "归档与通知"]
  }
];

const assetsSeed = [
  { id: "IT-2024-000123", name: "联想 ThinkPad X1 Carbon", category: "办公电脑", owner: "张三", status: "借用中", location: "集团总部 · 行政部", qrVersion: 1 },
  { id: "LIVE-2024-000088", name: "索尼直播相机 A7M4", category: "直播设备", owner: "直播间A", status: "使用中", location: "三楼直播间", qrVersion: 1 },
  { id: "LIVE-2024-000120", name: "神牛补光灯 SL150", category: "直播设备", owner: "设备库", status: "空闲", location: "三楼设备库", qrVersion: 1 },
  { id: "ADM-2023-000061", name: "会议平板 75寸", category: "会议设备", owner: "二号会议室", status: "固定资产", location: "二号会议室", qrVersion: 1 },
  { id: "IT-2025-000018", name: "MacBook Pro 14", category: "办公电脑", owner: "剪辑组", status: "维修中", location: "IT维修区", qrVersion: 2 }
];

const assetEventSeed = [
  { id: "AE-1", assetId: "IT-2024-000123", time: "2026-05-28 11:20:00", type: "借用", operator: "张三", content: "借用给行政部，预计 7 天后归还" },
  { id: "AE-2", assetId: "LIVE-2024-000088", time: "2026-05-27 15:18:00", type: "领用", operator: "直播间A", content: "固定用于三楼直播间" },
  { id: "AE-3", assetId: "IT-2025-000018", time: "2026-05-26 09:12:00", type: "维修", operator: "IT服务台", content: "电池健康异常，进入维修区" }
];

const resourceSeed = [
  { type: "会议室", name: "一号会议室", capacity: "10人", slots: [3, 2, 0, 4, 0, 1, 0], total: 4 },
  { type: "会议室", name: "二号会议室", capacity: "20人", slots: [5, 0, 2, 0, 0, 3, 1], total: 8 },
  { type: "车辆", name: "商务车A", capacity: "7座", slots: [1, 0, 2, 0, 0, 1, 0], total: 2 },
  { type: "工位", name: "直播一区", capacity: "12位", slots: [8, 9, 0, 12, 0, 7, 0], total: 12 },
  { type: "设备", name: "补光灯组", capacity: "8套", slots: [5, 0, 2, 0, 0, 3, 1], total: 8 }
];

function formDefaults(template) {
  return Object.fromEntries((template.fields || []).map((field) => [field.id, field.value || ""]));
}

function fieldValueLabel(template, formData = {}) {
  const field = (template.fields || []).find((item) => ["amount", "adjustAmount", "budget", "days", "employee", "headcount", "itemName", "quantity", "totalAmount"].includes(item.id));
  if (!field) return template.amount || "-";
  const value = formData[field.id] || field.value || template.amount || "-";
  return field.type === "amount" ? `¥${Number(value || 0).toLocaleString("zh-CN")}` : String(value);
}

function approversFor(template, department, nodeName, index) {
  const owner = `${department}负责人`;
  if (index === 0) return [owner, "张三"];
  if (template.category === "财务行政") return nodeName.includes("付款") ? ["出纳", "财务负责人"] : ["财务负责人", "财务专员"];
  if (template.category === "组织人事") return ["人事负责人", "HRBP"];
  if (template.category === "行政资产") return ["行政资产管理员", owner];
  if (template.category === "假勤") return ["人事专员", owner];
  return [owner];
}

function makeApprovalRule(template, department) {
  return {
    department,
    enabled: true,
    id: `RULE-${department}-${template.id}`,
    nodes: template.nodes
      .filter((node) => !node.includes("申请人提交") && !node.includes("归档"))
      .map((node, index) => ({
        approvers: approversFor(template, department, node, index),
        id: `${template.id}-${index + 1}`,
        mode: "AND",
        name: node
      })),
    templateId: template.id,
    templateName: template.name,
    updatedAt: "2026-05-29 09:00:00"
  };
}

function makeApprovalRules(people) {
  const departments = [...new Set([
    ...(people.departmentStats || []).map((item) => item.label),
    "行政部",
    "人事行政部",
    "财务部",
    "直播部",
    "直播运营部",
    "客服部"
  ].filter(Boolean))];
  return departments.flatMap((department) => flowTemplates.map((template) => makeApprovalRule(template, department)));
}

function makeApprovalRuleCoverage(approvalRules) {
  const rows = approvalRules.map((rule) => ({
    department: rule.department,
    missingNodes: rule.nodes.filter((node) => !node.approvers.length).map((node) => node.name),
    nodeCount: rule.nodes.length,
    status: rule.enabled && rule.nodes.every((node) => node.approvers.length > 0) ? "已配置" : "待完善",
    templateId: rule.templateId,
    templateName: rule.templateName
  }));
  const configured = rows.filter((row) => row.status === "已配置").length;
  return {
    rows,
    summary: {
      configured,
      coverageRate: rows.length ? Math.round((configured / rows.length) * 100) : 100,
      missing: rows.length - configured,
      total: rows.length
    }
  };
}

function approvalNodesFor(template, department, approvalRules, currentNodeIndex = 1) {
  const rule = approvalRules.find((item) => item.department === department && item.templateId === template.id)
    || makeApprovalRule(template, department);
  const ruleNodes = rule.nodes || [];
  return template.nodes.map((node, index) => {
    if (index === 0) {
      return {
        decisions: [{ approver: template.owner, status: "已同意", time: "2026-05-20 09:30" }],
        id: `${template.id}-submit`,
        mode: "AND",
        name: node
      };
    }
    const approvers = ruleNodes[index - 1]?.approvers || ["张三"];
    return {
      decisions: approvers.map((approver, approverIndex) => ({
        approver,
        status: index < currentNodeIndex || (index === currentNodeIndex && approverIndex === 0 && template.id === "payment") ? "已同意" : "待审批",
        time: index < currentNodeIndex ? "2026-05-20 11:00" : ""
      })),
      id: `${template.id}-${index}`,
      mode: ruleNodes[index - 1]?.mode || "AND",
      name: node
    };
  });
}

function makeInitialApprovals(people, approvalRules) {
  const departments = (people.departmentStats || []).map((item) => item.label).filter(Boolean);
  return Array.from({ length: 18 }, (_, index) => {
    const template = flowTemplates[index % flowTemplates.length];
    const department = departments[index % Math.max(departments.length, 1)] || template.department || "行政部";
    const formData = formDefaults(template);
    const currentNodeIndex = index === 3 ? 2 : 1;
    const approvalNodes = approvalNodesFor(template, department, approvalRules, currentNodeIndex);
    return {
      ...template,
      applicant: template.owner,
      approvalNodes,
      approvers: approvalNodes[currentNodeIndex]?.decisions.map((item) => item.approver) || [],
      comments: index % 4 === 0 ? [{ id: `CMT-${index}`, author: "直属负责人", time: "2026-05-29 10:10:00", content: "请补充业务背景，财务复核前确认预算口径。" }] : [],
      currentNodeIndex,
      definitionCode: template.serviceKey,
      definitionId: template.id,
      department,
      dueAt: `2026-05-${String(21 + (index % 8)).padStart(2, "0")} ${String(15 + (index % 5)).padStart(2, "0")}:30`,
      fields: template.fields,
      formData,
      id: `FLOW-${index + 1}`,
      node: approvalNodes[currentNodeIndex]?.name || template.node,
      status: index === 1 ? "待付款" : index === 3 ? "已超时" : "待审批",
      steps: template.nodes,
      submittedAt: `2026-05-${String(20 + (index % 8)).padStart(2, "0")} ${String(9 + (index % 10)).padStart(2, "0")}:30`,
      timeline: [
        { id: `TL-${index}-1`, time: `2026-05-${String(20 + (index % 8)).padStart(2, "0")} 09:30`, actor: template.owner, action: "提交申请", node: "申请人提交" },
        { id: `TL-${index}-2`, time: `2026-05-${String(20 + (index % 8)).padStart(2, "0")} 10:00`, actor: "系统", action: "创建审批任务", node: approvalNodes[currentNodeIndex]?.name || template.node }
      ],
      title: index >= flowTemplates.length ? `${template.name} ${Math.floor(index / flowTemplates.length) + 1}` : template.name
    };
  });
}

function buildAccountLibrary(people, iam) {
  const users = iam.users || [];
  const accountByEmployeeId = new Map(users
    .filter((user) => user.employee?.id)
    .map((user) => [user.employee.id, user]));
  const accounts = (people.employees || []).map((employee) => {
    const employeeId = employee.id || `employee-${employee.seq || employee.name}`;
    const user = accountByEmployeeId.get(employeeId)
      || users.find((item) => item.name === employee.name || item.employeeId === employeeId)
      || null;
    const roleObjects = (user?.roleCodes || []).map((code) => iam.roles.find((role) => role.code === code)).filter(Boolean);
    return {
      account: user,
      accountEmail: user?.email || "",
      accountId: user?.id || null,
      accountStatus: user?.status || "UNASSIGNED",
      department: employee.department || "",
      email: employee.email || "",
      employeeId,
      employeeName: employee.name,
      employeeNo: employee.employeeNo || employee.seq || "-",
      employeeStatus: employee.status || "在职",
      id: employeeId,
      roleCodes: user?.roleCodes || [],
      roleNames: roleObjects.map((role) => role.name),
      roleTitle: employee.role || ""
    };
  });
  const activeAccounts = accounts.filter((item) => ["ACTIVE", "在职"].includes(String(item.employeeStatus || "ACTIVE")));
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

function makeAnalytics(state) {
  const pendingApprovals = state.approvals.filter((item) => item.status.includes("待") || item.status.includes("超时")).length;
  const activeAssets = state.assets.filter((item) => item.status.includes("用") || item.status.includes("借")).length;
  const approved = state.approvals.filter((item) => item.status.includes("通过")).length;
  const rejected = state.approvals.filter((item) => item.status.includes("驳回")).length;
  const administrativeCost = state.financeRequests.reduce((sum, item) => sum + Number(item.amount || 0), 0);
  return {
    approvalEfficiency: {
      approved,
      completed: approved + rejected,
      passRate: Math.round((approved / Math.max(approved + rejected, 1)) * 100),
      pending: pendingApprovals,
      rejected
    },
    assetByStatus: Object.entries(state.assets.reduce((acc, item) => {
      acc[item.status] = (acc[item.status] || 0) + 1;
      return acc;
    }, {})).map(([label, value]) => ({ label, value })),
    cards: {
      administrativeCost,
      approvalPassRate: Math.round((approved / Math.max(approved + rejected, 1)) * 100),
      assetUseRate: Math.round((activeAssets / Math.max(state.assets.length, 1)) * 100),
      auditToday: state.auditLogs.length,
      employees: state.people.employees.length,
      monthLeavers: state.people.monthLeavers.length,
      pendingApprovals,
      totalPeople: state.people.employees.length + state.people.leavers.length
    },
    costBreakdown: [
      { label: "财务流程", value: administrativeCost },
      { label: "工资单", value: state.payrolls.length },
      { label: "资产在用", value: activeAssets }
    ],
    leaversByDepartment: state.people.leaverDepartmentStats || [],
    peopleByDepartment: state.people.departmentStats || [],
    riskApprovals: state.approvals
      .filter((item) => item.status.includes("待") || item.status.includes("超时"))
      .map((item) => ({ id: item.id, node: item.node, sla: item.sla || item.dueAt || "待处理", status: item.status, title: item.title }))
  };
}

function makeAuditIntegrity(logs) {
  return {
    checkedAt: nowIso(),
    latestHash: logs[0]?.hash || "seed",
    ok: true,
    total: logs.length
  };
}

function makeReadiness(storageMode = "memory") {
  const persistent = storageMode === "d1";
  const previewCache = storageMode === "edge-cache";
  return {
    closurePlan: persistent ? [] : ["创建 Cloudflare D1 数据库并在 wrangler.toml 绑定 OA_DB 后，写入会持久保存。"],
    controls: [
      { id: "cloudflare-native-worker", label: "Cloudflare 原生 Worker API", ok: true, status: "通过", detail: "前端和 /api 由同一个 workers.dev 域名承载" },
      { id: "cloudflare-d1", label: "Cloudflare D1 持久化", ok: persistent, status: persistent ? "通过" : "待绑定", detail: persistent ? "OA_DB 已绑定" : previewCache ? "当前使用 Cloudflare Cache API 临时保存预览状态，正式生产数据仍需 D1" : "当前使用 Worker 内存快照，适合预览，不适合正式生产数据" }
    ],
    dependencies: { database: storageMode, databaseIntegrity: "pass", fileStorage: "worker-bundle", ok: true, service: "cloudflare-native-api" },
    generatedAt: nowIso(),
    knownGapSourceAvailable: false,
    knownGaps: [],
    ownerEvidenceChecklist: [],
    releaseGate: {
      blockers: persistent ? [] : ["未绑定 D1 时不是最终生产持久化后端"],
      openGapCount: persistent ? 0 : 1,
      releaseReady: persistent,
      warnings: persistent ? [] : ["可以先发布到 workers.dev 预览；商用正式数据需要 D1。"]
    },
    runtime: {
      environment: "cloudflare-worker",
      isProduction: true,
      service: "deep-oa-cloudflare-api",
      storageMode
    }
  };
}

function makeInitialState(storageMode = "memory") {
  const people = {
    inactiveEmployees: [],
    ...clone(nativeSeedData.people)
  };
  const approvalRules = makeApprovalRules(people);
  const initialIam = {
    permissions,
    roles,
    users: [
      { id: "mock-user", name: "张三", email: "admin@oa.local", status: "ACTIVE", roleCodes: ["admin"] },
      { id: "mock-hr", name: "李四", email: "lisi@oa.local", status: "ACTIVE", roleCodes: ["hr-specialist"] }
    ]
  };
  const state = {
    approvalRuleCoverage: makeApprovalRuleCoverage(approvalRules),
    approvalRules,
    approvals: [],
    assetEvents: clone(assetEventSeed),
    assets: clone(assetsSeed),
    attendanceRecords: [
      { id: "ATT-1", employee: "张三", department: "行政部", workDate: "2026-05-29", checkIn: "2026-05-29 08:58", checkOut: "2026-05-29 18:05", status: "正常", minutesLate: 0, source: "门禁同步", reason: "" },
      { id: "ATT-2", employee: "李四", department: "人事行政部", workDate: "2026-05-29", checkIn: "2026-05-29 09:18", checkOut: "2026-05-29 18:10", status: "迟到", minutesLate: 18, source: "门禁同步", reason: "地铁延误" },
      { id: "ATT-3", employee: "王五", department: "财务部", workDate: "2026-05-29", checkIn: "", checkOut: "2026-05-29 18:02", status: "缺卡", minutesLate: 0, source: "手动补录", reason: "早卡缺失" }
    ],
    auditIntegrity: { ok: true, total: 0 },
    auditLogs: [
      { id: "AUD-1", time: "2026-05-29 09:45:12", operator: "张三", type: "更新", object: "员工档案", content: "更新了联系方式，敏感字段已脱敏", result: "成功", ip: "10.10.2.15" },
      { id: "AUD-2", time: "2026-05-29 09:30:21", operator: "李四", type: "新增", object: "员工入职", content: "新增员工入职信息", result: "成功", ip: "10.10.2.16" },
      { id: "AUD-3", time: "2026-05-29 09:12:05", operator: "王五", type: "提交审批", object: "办公用品申领", content: "提交办公用品申领单", result: "成功", ip: "10.10.2.17" }
    ],
    exportRecords: [],
    files: [
      { id: "FILE-DEMO-1", fileName: "制度说明.txt", mimeType: "text/plain", sizeBytes: 128, checksum: "demo-seed", visibility: "TENANT", uploader: { name: "系统管理员" }, createdAt: "2026-05-29T10:00:00.000Z", contentBase64: "5Yi25bqm6K+05piO" }
    ],
    financeRequests: [
      { id: "EXP-202605-0001", type: "EXPENSE", typeLabel: "费用报销", title: "办公室耗材报销", applicant: "张三", department: "行政部", amount: 2680, currency: "CNY", vendor: "京东企业购", paymentMethod: "银行转账", status: "待审批", workflowStatus: "PENDING" },
      { id: "PAY-202605-0001", type: "PAYMENT", typeLabel: "付款申请", title: "物业服务费付款", applicant: "李四", department: "财务部", amount: 18000, currency: "CNY", vendor: "园区物业", paymentMethod: "对公转账", status: "已通过", workflowStatus: "APPROVED" }
    ],
    iam: initialIam,
    importRuns: [
      {
        actor: { name: "系统管理员" },
        finishedAt: "2026-05-29T10:01:00.000Z",
        id: "IMPORT-DEMO-1",
        recordCounts: nativeSeedData.counts,
        sourceChecksum: "local-dashboard-seed",
        sourceName: nativeSeedData.source,
        sourceType: "html-dashboard",
        startedAt: "2026-05-29T10:00:00.000Z",
        status: "SUCCESS"
      }
    ],
    leaves: [
      { id: "LEAVE-1", employee: "张三", type: "年假", dates: "2026-05-30 ~ 2026-05-31", days: 2, status: "待审批" },
      { id: "LEAVE-2", employee: "戴慧敏", type: "病假", dates: "2026-05-27", days: 1, status: "已通过" }
    ],
    payrolls: [
      { id: "PAYROLL-202605", cycle: "2026年5月", scope: "在职、转正、入离职、异动人员", status: "待复核", owner: "财务中心" },
      { id: "PAYROLL-202604", cycle: "2026年4月", scope: "全员", status: "已归档", owner: "财务中心" }
    ],
    people,
    resourceBookings: [
      { id: "BOOK-1", resourceName: "一号会议室", type: "会议室", dayIndex: 0, period: "09:00-10:00", applicant: "张三", purpose: "周例会", status: "已预约" },
      { id: "BOOK-2", resourceName: "商务车A", type: "车辆", dayIndex: 2, period: "14:00-18:00", applicant: "王五", purpose: "供应商拜访", status: "已预约" }
    ],
    resourceWindowStart: "2026-05-29",
    resources: clone(resourceSeed),
    revealSensitive: false,
    schemaVersion: STATE_SCHEMA_VERSION,
    systemReadiness: makeReadiness(storageMode),
    workflowDefinitions: flowTemplates.map((template) => ({
      category: template.category,
      code: template.serviceKey,
      fields: template.fields,
      name: template.name,
      nodes: template.nodes,
      templateId: template.id
    }))
  };
  state.approvals = makeInitialApprovals(people, approvalRules);
  state.analytics = makeAnalytics(state);
  state.auditIntegrity = makeAuditIntegrity(state.auditLogs);
  state.iam = {
    ...initialIam,
    ...buildAccountLibrary(people, initialIam)
  };
  return state;
}

async function ensureD1(env) {
  if (!env.OA_DB) return false;
  await env.OA_DB.prepare(`
    CREATE TABLE IF NOT EXISTS kv_store (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `).run();
  await env.OA_DB.prepare(`
    CREATE TABLE IF NOT EXISTS audit_events (
      id TEXT PRIMARY KEY,
      action TEXT NOT NULL,
      actor TEXT NOT NULL,
      object_type TEXT NOT NULL,
      object_id TEXT,
      metadata TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `).run();
  return true;
}

async function loadState(env) {
  if (!env.OA_DB) {
    if (hasEdgeCache()) {
      const cached = await caches.default.match(stateCacheKey());
      if (cached) {
        const state = await cached.json();
        state.systemReadiness = makeReadiness("edge-cache");
        return state;
      }
      memoryState = makeInitialState("edge-cache");
      await saveState(env, memoryState);
      return clone(memoryState);
    }
    if (!memoryState) memoryState = makeInitialState(fallbackStorageMode());
    return clone(memoryState);
  }

  await ensureD1(env);
  const row = await env.OA_DB.prepare("SELECT value FROM kv_store WHERE key = ?").bind(STATE_KEY).first();
  if (row?.value) {
    const state = JSON.parse(row.value);
    state.systemReadiness = makeReadiness("d1");
    return state;
  }

  const state = makeInitialState("d1");
  await saveState(env, state);
  return state;
}

async function saveState(env, state) {
  state.analytics = makeAnalytics(state);
  state.auditIntegrity = makeAuditIntegrity(state.auditLogs);
  state.approvalRuleCoverage = makeApprovalRuleCoverage(state.approvalRules || []);
  state.iam = {
    ...(state.iam || {}),
    ...buildAccountLibrary(state.people || { employees: [] }, state.iam || { roles: [], users: [] })
  };
  if (!env.OA_DB) {
    memoryState = clone(state);
    if (hasEdgeCache()) {
      state.systemReadiness = makeReadiness("edge-cache");
      await caches.default.put(stateCacheKey(), new Response(JSON.stringify(state), {
        headers: {
          "cache-control": "public, max-age=86400",
          "content-type": "application/json; charset=utf-8"
        }
      }));
    }
    return;
  }
  await ensureD1(env);
  await env.OA_DB.prepare("INSERT OR REPLACE INTO kv_store (key, value, updated_at) VALUES (?, ?, ?)")
    .bind(STATE_KEY, JSON.stringify(state), nowIso())
    .run();
}

async function appendAudit(env, state, { action, actor = "张三", content, object = "系统", objectId = "-", result = "成功", type = action }) {
  const event = {
    content: content || action,
    id: nextId("AUD"),
    ip: "cloudflare-edge",
    object,
    objectId,
    operator: actor,
    result,
    time: localTime(),
    type
  };
  state.auditLogs = [event, ...(state.auditLogs || [])].slice(0, 500);
  if (action.includes("导出")) {
    state.exportRecords = [{
      action,
      fileName: `${object}-${Date.now()}.csv`,
      format: "csv",
      id: nextId("EXP"),
      ip: event.ip,
      module: object,
      operator: actor,
      result,
      rowCount: 0,
      scope: object,
      time: event.time
    }, ...(state.exportRecords || [])];
  }
  if (env.OA_DB) {
    await ensureD1(env);
    await env.OA_DB.prepare("INSERT INTO audit_events (id, action, actor, object_type, object_id, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(event.id, action, actor, object, objectId, JSON.stringify(event), nowIso())
      .run();
  }
  return event;
}

function parseCookie(request) {
  return Object.fromEntries(String(request.headers.get("cookie") || "")
    .split(";")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const index = item.indexOf("=");
      return index === -1 ? [item, ""] : [item.slice(0, index), item.slice(index + 1)];
    }));
}

function isAuthenticated(request) {
  return parseCookie(request)[SESSION_COOKIE] === "admin";
}

function sessionCookie(request, value, maxAge) {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

async function readJson(request) {
  if (["GET", "HEAD"].includes(request.method)) return {};
  const textBody = await request.text();
  if (!textBody) return {};
  try {
    return JSON.parse(textBody);
  } catch {
    throw new Error("请求体必须是 JSON。");
  }
}

function compactRowsToCsv(rows, columns) {
  const escape = (value) => {
    const textValue = String(value ?? "");
    return /[",\n]/.test(textValue) ? `"${textValue.replaceAll("\"", "\"\"")}"` : textValue;
  };
  return [
    columns.map((column) => escape(column.label)).join(","),
    ...rows.map((row) => columns.map((column) => escape(typeof column.value === "function" ? column.value(row) : row[column.value || column.key])).join(","))
  ].join("\n");
}

function ok(payload = {}) {
  return json({ ok: true, ...payload });
}

function unauthorized() {
  return json({ code: "UNAUTHORIZED", message: "请先登录。", ok: false }, { status: 401 });
}

function notFound(pathname) {
  return json({ code: "NOT_FOUND", message: `未找到接口 ${pathname}`, ok: false }, { status: 404 });
}

function badRequest(message) {
  return json({ code: "BAD_REQUEST", message, ok: false }, { status: 400 });
}

function currentUser(state) {
  const user = state.iam.users.find((item) => item.email === "admin@oa.local") || state.iam.users[0];
  return {
    user: {
      avatarUrl: "",
      department: "行政部",
      id: user?.id || "mock-user",
      name: user?.name || "张三",
      organization: "集团总部",
      source: "cloudflare-native",
      title: "系统管理员"
    }
  };
}

function assetStatusForAction(action) {
  return {
    borrow: "借用中",
    inventory: "已盘点",
    repair: "维修中",
    retire: "已退役",
    return: "空闲"
  }[action] || "";
}

function applyApprovalDecision(approval, payload = {}) {
  const decisionValue = payload.decision === "reject" ? "reject" : "pass";
  const currentIndex = Number.isFinite(approval.currentNodeIndex) ? approval.currentNodeIndex : 0;
  const currentNode = approval.approvalNodes?.[currentIndex];
  const approverName = payload.approverName || currentNode?.decisions?.find((item) => item.status === "待审批")?.approver || "张三";
  const targetDecision = currentNode?.decisions?.find((item) => item.approver === approverName)
    || currentNode?.decisions?.find((item) => item.status === "待审批");

  if (!currentNode || !targetDecision) return approval;
  targetDecision.status = decisionValue === "reject" ? "已驳回" : "已同意";
  targetDecision.time = localTime();
  approval.timeline = [
    ...(approval.timeline || []),
    { id: nextId("TL"), time: localTime(), actor: approverName, action: decisionValue === "reject" ? "驳回审批" : "同意审批", node: currentNode.name }
  ];
  if (decisionValue === "reject") {
    approval.status = "已驳回";
    approval.node = currentNode.name;
    return approval;
  }

  const pendingCount = currentNode.decisions.filter((item) => item.status === "待审批").length;
  if (pendingCount > 0) {
    approval.status = "待审批";
    approval.node = currentNode.name;
    return approval;
  }

  const nextIndex = currentIndex + 1;
  if (nextIndex >= approval.approvalNodes.length) {
    approval.status = "已通过";
    approval.node = "流程结束";
    return approval;
  }
  approval.currentNodeIndex = nextIndex;
  approval.node = approval.approvalNodes[nextIndex].name;
  approval.status = approval.node.includes("归档") || approval.node.includes("人事归档") ? "已通过" : "待审批";
  return approval;
}

async function handleNativeApi(request, env) {
  const url = new URL(request.url);
  const pathname = url.pathname.replace(/^\/api/, "") || "/";
  const segments = pathname.split("/").filter(Boolean);
  const state = await loadState(env);
  const method = request.method.toUpperCase();

  if (pathname === "/edge/health") {
    const originValidation = validateApiOrigin(env.API_ORIGIN, request.url);
    return json({
      apiMode: "cloudflare-native",
      apiOriginConfigured: originValidation.configured,
      apiOriginError: originValidation.ok ? null : originValidation.code,
      apiOriginValid: originValidation.configured ? originValidation.ok : null,
      d1Configured: Boolean(env.OA_DB),
      previewStorage: env.OA_DB ? "d1" : fallbackStorageMode(),
      ok: true,
      service: "deep-oa-cloudflare-edge"
    });
  }

  if (pathname === "/health") {
    return json({
      d1Configured: Boolean(env.OA_DB),
      ok: true,
      service: "deep-oa-cloudflare-api",
      storageMode: env.OA_DB ? "d1" : fallbackStorageMode()
    });
  }

  if (pathname === "/ready") {
    return json({
      checks: {
        api: "pass",
        database: env.OA_DB ? "d1" : "memory-preview",
        seedData: nativeSeedData.counts
      },
      ok: true,
      service: "deep-oa-cloudflare-api"
    });
  }

  if (pathname === "/openapi.json") {
    return json({
      info: { title: "集团人事行政 OA Commercial API", version: "cloudflare-native-v1" },
      openapi: "3.1.0",
      paths: {
        "/analytics/overview": {},
        "/approvals": {},
        "/auth/login": {},
        "/iam": {},
        "/people": {}
      }
    });
  }

  if (pathname === "/auth/login" && method === "POST") {
    const body = await readJson(request);
    if (body.email !== "admin@oa.local" || body.password !== "admin123456") {
      return json({ code: "INVALID_CREDENTIALS", message: "账号或密码错误。", ok: false }, { status: 401 });
    }
    await appendAudit(env, state, { action: "登录", actor: "张三", content: "Cloudflare 原生后端登录", object: "认证" });
    await saveState(env, state);
    return json({ ok: true, ...currentUser(state) }, {
      headers: { "set-cookie": sessionCookie(request, "admin", 60 * 60 * 8) }
    });
  }

  if (!isAuthenticated(request)) {
    if (pathname === "/auth/me") return unauthorized();
    if (pathname !== "/auth/logout") return unauthorized();
  }

  if (pathname === "/auth/me" && method === "GET") return ok(currentUser(state));
  if (pathname === "/auth/logout" && method === "POST") {
    return json({ ok: true }, {
      headers: { "set-cookie": sessionCookie(request, "", 0) }
    });
  }
  if (pathname === "/auth/change-password" && method === "POST") {
    await appendAudit(env, state, { action: "修改密码", actor: "张三", content: "用户修改登录密码", object: "认证" });
    await saveState(env, state);
    return ok(currentUser(state));
  }

  if (pathname === "/analytics/overview" && method === "GET") return ok({ analytics: state.analytics });
  if (pathname === "/analytics/export" && method === "POST") {
    await appendAudit(env, state, { action: "导出管理看板", actor: "张三", content: "导出管理看板 CSV", object: "管理看板" });
    await saveState(env, state);
    return csv(compactRowsToCsv(state.analytics.riskApprovals, [
      { key: "title", label: "风险流程" },
      { key: "node", label: "当前节点" },
      { key: "status", label: "状态" }
    ]), "analytics-snapshot.csv");
  }

  if (pathname === "/people" && method === "GET") return ok({ people: state.people, revealSensitive: state.revealSensitive });
  if (pathname === "/people/employees" && method === "GET") return ok({ employees: state.people.employees });
  if (pathname === "/people/leavers" && method === "GET") return ok({ leavers: state.people.leavers });
  if (segments[0] === "people" && segments[1] === "employees" && segments[2] && method === "PATCH") {
    const body = await readJson(request);
    const employee = state.people.employees.find((item) => item.id === decodeURIComponent(segments[2]));
    if (!employee) return notFound(pathname);
    Object.assign(employee, body);
    await appendAudit(env, state, { action: "更新员工", actor: "张三", content: `更新员工 ${employee.name}`, object: "员工档案", objectId: employee.id });
    await saveState(env, state);
    return ok({ employee });
  }
  if (pathname === "/people/export" && method === "POST") {
    await appendAudit(env, state, { action: "导出人员名册", actor: "张三", content: "导出脱敏人员名册", object: "人员名册" });
    await saveState(env, state);
    return csv(compactRowsToCsv(state.people.employees, [
      { key: "seq", label: "工号" },
      { key: "name", label: "姓名" },
      { key: "department", label: "部门" },
      { key: "role", label: "岗位" },
      { key: "status", label: "状态" }
    ]), "people-export.csv");
  }

  if (pathname === "/iam" && method === "GET") return ok({ iam: state.iam });
  if (pathname === "/iam/users" && method === "POST") {
    const body = await readJson(request);
    const user = {
      email: body.email,
      id: nextId("USER"),
      name: body.name,
      roleCodes: body.roleCodes || ["employee-self-service"],
      status: "ACTIVE"
    };
    state.iam.users = [user, ...state.iam.users];
    await appendAudit(env, state, { action: "创建账号", actor: "张三", content: `创建账号 ${user.email}`, object: "账号权限", objectId: user.id });
    await saveState(env, state);
    return ok({ temporaryPassword: body.newPassword ? null : "ChangeMe-2026!", user });
  }
  if (pathname === "/iam/accounts/sync-employees" && method === "POST") {
    const body = await readJson(request);
    const existingNames = new Set(state.iam.users.map((user) => user.name));
    const roleCodes = body.roleCodes?.length ? body.roleCodes : ["employee-self-service"];
    const createdUsers = state.people.employees
      .filter((employee) => !existingNames.has(employee.name))
      .map((employee) => ({
        email: `${String(employee.seq || employee.name).toLowerCase().replace(/[^a-z0-9]+/g, ".")}@oa.local`,
        employee: { id: employee.id, name: employee.name },
        id: nextId("USER"),
        name: employee.name,
        roleCodes,
        status: "ACTIVE"
      }));
    state.iam.users = [...createdUsers, ...state.iam.users];
    await appendAudit(env, state, { action: "批量开户", actor: "张三", content: `为 ${createdUsers.length} 名员工生成账号`, object: "账号权限" });
    await saveState(env, state);
    return ok({ createdCount: createdUsers.length, createdUsers: createdUsers.map((user) => ({ ...user, temporaryPassword: "ChangeMe-2026!" })) });
  }
  if (segments[0] === "iam" && segments[1] === "roles" && segments[3] === "permissions" && method === "PUT") {
    const body = await readJson(request);
    const role = state.iam.roles.find((item) => item.id === decodeURIComponent(segments[2]));
    if (!role) return notFound(pathname);
    role.permissionCodes = [...new Set(body.permissionCodes || [])];
    role.permissions = permissionsByCode(role.permissionCodes);
    await appendAudit(env, state, { action: "更新角色权限", actor: "张三", content: `更新 ${role.name} 权限`, object: "角色权限", objectId: role.id });
    await saveState(env, state);
    return ok({ role });
  }
  if (segments[0] === "iam" && segments[1] === "users" && segments[2] && ["roles", "status", "password"].includes(segments[3]) && method === "PUT") {
    const body = await readJson(request);
    const user = state.iam.users.find((item) => item.id === decodeURIComponent(segments[2]));
    if (!user) return notFound(pathname);
    if (segments[3] === "roles") user.roleCodes = [...new Set(body.roleCodes || [])];
    if (segments[3] === "status") user.status = body.status || user.status;
    await appendAudit(env, state, { action: "更新账号", actor: "张三", content: `更新账号 ${user.email}`, object: "账号权限", objectId: user.id });
    await saveState(env, state);
    return ok({ user });
  }

  if (pathname === "/approvals/definitions" && method === "GET") return ok({ workflowDefinitions: state.workflowDefinitions });
  if (pathname === "/approvals/rules/coverage" && method === "GET") return ok({ approvalRuleCoverage: state.approvalRuleCoverage });
  if (pathname === "/approvals/rules/preview" && method === "GET") {
    const department = url.searchParams.get("department") || "行政部";
    const templateId = url.searchParams.get("templateId") || "expense";
    const rule = state.approvalRules.find((item) => item.department === department && item.templateId === templateId);
    await appendAudit(env, state, { action: "预览审批规则", actor: "张三", content: `${department} / ${templateId}`, object: "审批规则" });
    await saveState(env, state);
    return ok({ rule, route: rule?.nodes || [] });
  }
  if (pathname === "/approvals/rules" && method === "GET") return ok({ approvalRules: state.approvalRules });
  if (pathname === "/approvals/rules" && method === "POST") {
    const body = await readJson(request);
    const rule = { ...body, id: body.id || nextId("RULE"), updatedAt: localTime() };
    state.approvalRules = [rule, ...state.approvalRules.filter((item) => item.id !== rule.id)];
    await appendAudit(env, state, { action: "新增审批规则", actor: "张三", content: `${rule.department} / ${rule.templateName}`, object: "审批规则", objectId: rule.id });
    await saveState(env, state);
    return ok({ rule });
  }
  if (segments[0] === "approvals" && segments[1] === "rules" && segments[2] && method === "PUT") {
    const body = await readJson(request);
    const id = decodeURIComponent(segments[2]);
    state.approvalRules = state.approvalRules.map((rule) => rule.id === id ? { ...rule, ...body, id, updatedAt: localTime() } : rule);
    await appendAudit(env, state, { action: "更新审批规则", actor: "张三", content: `更新规则 ${id}`, object: "审批规则", objectId: id });
    await saveState(env, state);
    return ok({ rule: state.approvalRules.find((rule) => rule.id === id) });
  }
  if (segments[0] === "approvals" && segments[1] === "rules" && segments[2] && method === "DELETE") {
    const id = decodeURIComponent(segments[2]);
    state.approvalRules = state.approvalRules.filter((rule) => rule.id !== id);
    await appendAudit(env, state, { action: "删除审批规则", actor: "张三", content: `删除规则 ${id}`, object: "审批规则", objectId: id });
    await saveState(env, state);
    return ok({ id });
  }
  if (pathname === "/approvals" && method === "GET") return ok({ approvals: state.approvals });
  if (pathname === "/approvals" && method === "POST") {
    const body = await readJson(request);
    const template = flowTemplates.find((item) => item.id === body.definitionId || item.id === body.template?.id) || flowTemplates[0];
    const department = body.department || template.department || "行政部";
    const formData = { ...formDefaults(template), ...(body.formData || {}) };
    const approvalNodes = approvalNodesFor(template, department, state.approvalRules, 1);
    const approval = {
      ...template,
      ...body,
      amount: fieldValueLabel(template, formData),
      applicant: body.applicant || template.owner || "张三",
      approvalNodes,
      approvers: approvalNodes[1]?.decisions.map((item) => item.approver) || [],
      comments: [],
      currentNodeIndex: 1,
      definitionCode: template.serviceKey,
      definitionId: template.id,
      department,
      dueAt: localTime(),
      fields: template.fields,
      formData,
      id: nextId("FLOW"),
      node: approvalNodes[1]?.name || template.node,
      status: "待审批",
      steps: template.nodes,
      submittedAt: localTime(),
      timeline: [
        { id: nextId("TL"), time: localTime(), actor: body.applicant || template.owner || "张三", action: "提交申请", node: "申请人提交" },
        { id: nextId("TL"), time: localTime(), actor: "系统", action: "创建审批任务", node: approvalNodes[1]?.name || template.node }
      ],
      title: body.title || template.name
    };
    state.approvals = [approval, ...state.approvals];
    await appendAudit(env, state, { action: "发起审批", actor: approval.applicant, content: `发起 ${approval.title}`, object: "OA审批", objectId: approval.id });
    await saveState(env, state);
    return ok({ approval });
  }
  if (pathname === "/approvals/export" && method === "POST") {
    await appendAudit(env, state, { action: "导出审批列表", actor: "张三", content: "导出审批列表 CSV", object: "OA审批" });
    await saveState(env, state);
    return csv(compactRowsToCsv(state.approvals, [
      { key: "id", label: "流程编号" },
      { key: "title", label: "标题" },
      { key: "applicant", label: "申请人" },
      { key: "department", label: "部门" },
      { key: "status", label: "状态" }
    ]), "approvals-export.csv");
  }
  if (segments[0] === "approvals" && segments[1] && method === "GET") {
    const approval = state.approvals.find((item) => item.id === decodeURIComponent(segments[1]));
    return approval ? ok({ approval }) : notFound(pathname);
  }
  if (segments[0] === "approvals" && segments[1] && segments[2] === "decision" && method === "POST") {
    const body = await readJson(request);
    const approval = state.approvals.find((item) => item.id === decodeURIComponent(segments[1]));
    if (!approval) return notFound(pathname);
    applyApprovalDecision(approval, body);
    await appendAudit(env, state, { action: body.decision === "reject" ? "驳回审批" : "同意审批", actor: body.approverName || "张三", content: `${approval.title}：${approval.status}`, object: "OA审批", objectId: approval.id });
    await saveState(env, state);
    return ok({ approval });
  }
  if (segments[0] === "approvals" && segments[1] && segments[2] === "transfer" && method === "POST") {
    const body = await readJson(request);
    const approval = state.approvals.find((item) => item.id === decodeURIComponent(segments[1]));
    if (!approval) return notFound(pathname);
    const currentNode = approval.approvalNodes?.[approval.currentNodeIndex];
    const decision = currentNode?.decisions?.find((item) => item.approver === body.sourceApproverName) || currentNode?.decisions?.find((item) => item.status === "待审批");
    if (decision) decision.approver = body.target || "财务负责人";
    approval.timeline = [...(approval.timeline || []), { id: nextId("TL"), time: localTime(), actor: "张三", action: "转交审批", node: currentNode?.name || approval.node }];
    await appendAudit(env, state, { action: "转交审批", actor: "张三", content: `${approval.title} 转交给 ${body.target}`, object: "OA审批", objectId: approval.id });
    await saveState(env, state);
    return ok({ approval });
  }
  if (segments[0] === "approvals" && segments[1] && segments[2] === "withdraw" && method === "POST") {
    const approval = state.approvals.find((item) => item.id === decodeURIComponent(segments[1]));
    if (!approval) return notFound(pathname);
    approval.status = "已撤回";
    approval.timeline = [...(approval.timeline || []), { id: nextId("TL"), time: localTime(), actor: "张三", action: "撤回审批", node: approval.node }];
    await appendAudit(env, state, { action: "撤回审批", actor: "张三", content: approval.title, object: "OA审批", objectId: approval.id });
    await saveState(env, state);
    return ok({ approval });
  }
  if (segments[0] === "approvals" && segments[1] && segments[2] === "comments" && method === "POST") {
    const body = await readJson(request);
    const approval = state.approvals.find((item) => item.id === decodeURIComponent(segments[1]));
    if (!approval) return notFound(pathname);
    const comment = { id: nextId("CMT"), author: "张三", content: body.content || "", time: localTime() };
    approval.comments = [...(approval.comments || []), comment];
    await appendAudit(env, state, { action: "新增审批评论", actor: "张三", content: approval.title, object: "OA审批", objectId: approval.id });
    await saveState(env, state);
    return ok({ comment });
  }

  if (pathname === "/assets" && method === "GET") return ok({ assets: state.assets });
  if (pathname === "/assets/events" && method === "GET") return ok({ assetEvents: state.assetEvents });
  if (pathname === "/assets" && method === "POST") {
    const body = await readJson(request);
    const asset = { id: body.id || nextId("ADM"), qrVersion: 1, status: "空闲", ...body };
    state.assets = [asset, ...state.assets];
    await appendAudit(env, state, { action: "录入资产", actor: "张三", content: `录入资产 ${asset.name}`, object: "行政资产", objectId: asset.id });
    await saveState(env, state);
    return ok({ asset });
  }
  if (segments[0] === "assets" && segments[1] && segments[2] === "actions" && method === "POST") {
    const body = await readJson(request);
    const asset = state.assets.find((item) => item.id === decodeURIComponent(segments[1]));
    if (!asset) return notFound(pathname);
    const status = assetStatusForAction(body.action);
    if (status) asset.status = status;
    if (body.owner) asset.owner = body.owner;
    const event = { id: nextId("AE"), assetId: asset.id, time: localTime(), type: body.action || "更新", operator: "张三", content: body.result || `资产状态更新为 ${asset.status}` };
    state.assetEvents = [event, ...state.assetEvents];
    await appendAudit(env, state, { action: "资产动作", actor: "张三", content: `${asset.name} ${event.content}`, object: "行政资产", objectId: asset.id });
    await saveState(env, state);
    return ok({ asset, event });
  }
  if (segments[0] === "assets" && segments[1] && segments[2] === "qr" && method === "POST") {
    const asset = state.assets.find((item) => item.id === decodeURIComponent(segments[1]));
    if (!asset) return notFound(pathname);
    asset.qrVersion = Number(asset.qrVersion || 1) + 1;
    await appendAudit(env, state, { action: "重新生成资产二维码", actor: "张三", content: asset.name, object: "行政资产", objectId: asset.id });
    await saveState(env, state);
    return ok({ asset });
  }
  if (segments[0] === "assets" && segments[1] && method === "PATCH") {
    const body = await readJson(request);
    const asset = state.assets.find((item) => item.id === decodeURIComponent(segments[1]));
    if (!asset) return notFound(pathname);
    Object.assign(asset, body);
    await appendAudit(env, state, { action: "更新资产", actor: "张三", content: asset.name, object: "行政资产", objectId: asset.id });
    await saveState(env, state);
    return ok({ asset });
  }
  if (pathname === "/assets/export" && method === "POST") {
    await appendAudit(env, state, { action: "导出资产台账", actor: "张三", content: "导出资产台账 CSV", object: "行政资产" });
    await saveState(env, state);
    return csv(compactRowsToCsv(state.assets, [
      { key: "id", label: "资产编号" },
      { key: "name", label: "资产名称" },
      { key: "category", label: "类别" },
      { key: "owner", label: "使用人" },
      { key: "status", label: "状态" }
    ]), "assets-export.csv");
  }

  if (pathname === "/attendance/records" && method === "GET") return ok({ attendanceRecords: state.attendanceRecords });
  if (pathname === "/attendance/leaves" && method === "GET") return ok({ leaves: state.leaves });
  if (pathname === "/attendance/records" && method === "POST") {
    const body = await readJson(request);
    const record = { id: nextId("ATT"), ...body };
    state.attendanceRecords = [record, ...state.attendanceRecords];
    await appendAudit(env, state, { action: "新增考勤", actor: "张三", content: record.employee || "-", object: "假勤" });
    await saveState(env, state);
    return ok({ record });
  }
  if (pathname === "/attendance/leaves" && method === "POST") {
    const body = await readJson(request);
    const leave = { id: nextId("LEAVE"), status: "待审批", ...body };
    state.leaves = [leave, ...state.leaves];
    await appendAudit(env, state, { action: "提交请假", actor: leave.employee || "张三", content: `${leave.type || "请假"} ${leave.dates || ""}`, object: "假勤" });
    await saveState(env, state);
    return ok({ leave });
  }
  if (pathname === "/attendance/records/export" && method === "POST") {
    await appendAudit(env, state, { action: "导出考勤", actor: "张三", content: "导出考勤记录 CSV", object: "假勤" });
    await saveState(env, state);
    return csv(compactRowsToCsv(state.attendanceRecords, [
      { key: "employee", label: "员工" },
      { key: "department", label: "部门" },
      { key: "workDate", label: "日期" },
      { key: "status", label: "状态" }
    ]), "attendance-export.csv");
  }

  if (pathname === "/finance/requests" && method === "GET") return ok({ financeRequests: state.financeRequests });
  if (pathname === "/finance/payrolls" && method === "GET") return ok({ payrolls: state.payrolls });
  if (pathname === "/finance/requests" && method === "POST") {
    const body = await readJson(request);
    const requestRow = { id: nextId(body.type === "PAYMENT" ? "PAY" : "EXP"), status: "待审批", workflowStatus: "PENDING", ...body };
    state.financeRequests = [requestRow, ...state.financeRequests];
    await appendAudit(env, state, { action: "提交财务单据", actor: requestRow.applicant || "张三", content: requestRow.title || requestRow.typeLabel || "财务单据", object: "财务行政", objectId: requestRow.id });
    await saveState(env, state);
    return ok({ financeRequest: requestRow });
  }
  if (pathname === "/finance/payrolls" && method === "POST") {
    const body = await readJson(request);
    const payroll = { id: nextId("PAYROLL"), status: "待复核", owner: "财务中心", ...body };
    state.payrolls = [payroll, ...state.payrolls];
    await appendAudit(env, state, { action: "创建工资单", actor: "财务中心", content: payroll.cycle || payroll.id, object: "财务行政", objectId: payroll.id });
    await saveState(env, state);
    return ok({ payroll });
  }
  if (segments[0] === "finance" && segments[1] === "payrolls" && segments[3] === "review" && method === "POST") {
    const payroll = state.payrolls.find((item) => item.id === decodeURIComponent(segments[2]));
    if (!payroll) return notFound(pathname);
    payroll.status = "已发布";
    await appendAudit(env, state, { action: "复核工资单", actor: "张三", content: payroll.cycle || payroll.id, object: "财务行政", objectId: payroll.id });
    await saveState(env, state);
    return ok({ payroll });
  }
  if (pathname === "/finance/requests/export" && method === "POST") {
    await appendAudit(env, state, { action: "导出财务单据", actor: "张三", content: "导出财务单据 CSV", object: "财务行政" });
    await saveState(env, state);
    return csv(compactRowsToCsv(state.financeRequests, [
      { key: "id", label: "单据编号" },
      { key: "title", label: "标题" },
      { key: "amount", label: "金额" },
      { key: "status", label: "状态" }
    ]), "finance-export.csv");
  }

  if (pathname === "/resources" && method === "GET") return ok({ resources: state.resources, windowStart: state.resourceWindowStart });
  if (pathname === "/resources/bookings" && method === "GET") return ok({ resourceBookings: state.resourceBookings });
  if (pathname === "/resources/bookings" && method === "POST") {
    const body = await readJson(request);
    const conflict = state.resourceBookings.some((booking) => booking.resourceName === body.resourceName && Number(booking.dayIndex) === Number(body.dayIndex) && booking.period === body.period && booking.status !== "已取消");
    if (conflict) return badRequest("该资源时间段已有预约。");
    const booking = { id: nextId("BOOK"), applicant: "张三", status: "已预约", ...body };
    state.resourceBookings = [booking, ...state.resourceBookings];
    await appendAudit(env, state, { action: "资源预约", actor: booking.applicant, content: `${booking.resourceName} ${booking.period || ""}`, object: "资源预约", objectId: booking.id });
    await saveState(env, state);
    return ok({ booking });
  }
  if (segments[0] === "resources" && segments[1] === "bookings" && segments[3] === "cancel" && method === "POST") {
    const booking = state.resourceBookings.find((item) => item.id === decodeURIComponent(segments[2]));
    if (!booking) return notFound(pathname);
    booking.status = "已取消";
    await appendAudit(env, state, { action: "取消预约", actor: "张三", content: booking.resourceName, object: "资源预约", objectId: booking.id });
    await saveState(env, state);
    return ok({ booking });
  }
  if (pathname === "/resources/bookings/export" && method === "POST") {
    await appendAudit(env, state, { action: "导出资源预约", actor: "张三", content: "导出资源预约 CSV", object: "资源预约" });
    await saveState(env, state);
    return csv(compactRowsToCsv(state.resourceBookings, [
      { key: "resourceName", label: "资源" },
      { key: "period", label: "时间" },
      { key: "applicant", label: "申请人" },
      { key: "status", label: "状态" }
    ]), "resources-export.csv");
  }

  if (pathname === "/files" && method === "GET") return ok({ files: state.files });
  if (pathname === "/files" && method === "POST") {
    const body = await readJson(request);
    const file = {
      checksum: nextId("CHK"),
      createdAt: nowIso(),
      id: nextId("FILE"),
      sizeBytes: Math.round((body.contentBase64 || "").length * 0.75),
      uploader: { name: "张三" },
      visibility: "PRIVATE",
      ...body
    };
    state.files = [file, ...state.files];
    await appendAudit(env, state, { action: "上传附件", actor: "张三", content: file.fileName, object: "文件附件", objectId: file.id });
    await saveState(env, state);
    return ok({ file });
  }
  if (segments[0] === "files" && segments[1] && segments[2] === "download" && method === "GET") {
    const file = state.files.find((item) => item.id === decodeURIComponent(segments[1]));
    if (!file) return notFound(pathname);
    await appendAudit(env, state, { action: "下载附件", actor: "张三", content: file.fileName, object: "文件附件", objectId: file.id });
    await saveState(env, state);
    const binary = atob(file.contentBase64 || "5LiL6L295paH5Lu2");
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new Response(bytes, {
      headers: {
        "content-disposition": `attachment; filename="${file.fileName || "attachment.bin"}"`,
        "content-type": file.mimeType || "application/octet-stream",
        ...SECURITY_HEADERS
      }
    });
  }

  if (pathname === "/imports" && method === "GET") return ok({ importRuns: state.importRuns });
  if (pathname === "/imports/dashboard-html" && method === "POST") {
    const run = {
      actor: { name: "张三" },
      finishedAt: nowIso(),
      id: nextId("IMPORT"),
      recordCounts: nativeSeedData.counts,
      sourceChecksum: nextId("SRC"),
      sourceName: "uploaded-oa-dashboard.html",
      sourceType: "html-dashboard",
      startedAt: nowIso(),
      status: "SUCCESS"
    };
    state.importRuns = [run, ...state.importRuns];
    await appendAudit(env, state, { action: "导入仪表盘数据", actor: "张三", content: "导入 oa-dashboard.html 数据", object: "数据导入", objectId: run.id });
    await saveState(env, state);
    return ok({ importRun: run, people: state.people });
  }
  if (segments[0] === "imports" && segments[2] === "source" && method === "GET") {
    return text("oa-dashboard.html source is retained in the repository package.");
  }

  if (pathname === "/audit" && method === "GET") return ok({ auditLogs: state.auditLogs, exportRecords: state.exportRecords, revealSensitive: state.revealSensitive });
  if (pathname === "/audit/export-records" && method === "GET") return ok({ exportRecords: state.exportRecords });
  if (pathname === "/audit/integrity" && method === "GET") return ok({ auditIntegrity: state.auditIntegrity });
  if (pathname === "/audit/sensitive-access" && method === "POST") {
    const body = await readJson(request);
    state.revealSensitive = Boolean(body.enabled);
    await appendAudit(env, state, { action: state.revealSensitive ? "开启敏感字段访问" : "关闭敏感字段访问", actor: "张三", content: "Cloudflare Worker seed 数据仍保持脱敏", object: "权限审计" });
    await saveState(env, state);
    return ok({ revealSensitive: state.revealSensitive });
  }
  if (pathname === "/audit/export" && method === "POST") {
    await appendAudit(env, state, { action: "导出审计日志", actor: "张三", content: "导出审计日志 CSV", object: "权限审计" });
    await saveState(env, state);
    return csv(compactRowsToCsv(state.auditLogs, [
      { key: "time", label: "时间" },
      { key: "operator", label: "操作人" },
      { key: "type", label: "动作" },
      { key: "object", label: "对象" },
      { key: "result", label: "结果" }
    ]), "audit-export.csv");
  }

  if (pathname === "/system/readiness" && method === "GET") return ok({ systemReadiness: state.systemReadiness });

  return notFound(pathname);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      const useProxy = String(env.OA_API_MODE || "").toLowerCase() === "proxy" && env.API_ORIGIN;
      if (useProxy) return proxyApi(request, env);
      try {
        return await handleNativeApi(request, env);
      } catch (error) {
        return json({
          code: "WORKER_API_ERROR",
          message: error?.message || "Cloudflare 原生 API 执行失败。",
          ok: false
        }, { status: 500 });
      }
    }

    const assetResponse = env.ASSETS
      ? await env.ASSETS.fetch(request)
      : new Response("Assets binding is not configured.", { status: 503 });
    return withSecurityHeaders(assetResponse);
  }
};
