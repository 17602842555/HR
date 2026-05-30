import { appCatalog, sideNav } from "../data/seed.js";

const moduleLabelById = new Map(sideNav.map((item) => [item.id, item.label]));

function normalize(value) {
  return String(value || "").trim().toLowerCase();
}

function compact(values) {
  return values
    .flatMap((value) => Array.isArray(value) ? value : [value])
    .filter((value) => value !== undefined && value !== null && String(value).trim() !== "");
}

function matches(values, query) {
  const haystack = compact(values).join(" ").toLowerCase();
  return haystack.includes(query);
}

function scoreResult(result, query) {
  const title = normalize(result.title);
  if (title === query) return 0;
  if (title.startsWith(query)) return 1;
  if (title.includes(query)) return 2;
  return 3;
}

function pushUnique(results, result, query) {
  if (!matches([result.title, result.subtitle, result.keywords], query)) return;
  if (results.some((item) => item.id === result.id)) return;
  results.push(result);
}

function appSubtitle(item, metrics = {}) {
  if (item.metricKey) {
    const value = metrics[item.metricKey] ?? 0;
    return `${moduleLabelById.get(item.module) || item.category || "应用"} · ${value}${item.id === "pending" ? "项" : "人"}`;
  }
  return `${moduleLabelById.get(item.module) || item.category || "应用"} · ${item.meta || "可用"}`;
}

function personResults(people = {}) {
  return [
    ...(people.employees || []).map((item) => ({
      id: `person-active-${item.employeeNo || item.id || item.name}`,
      title: item.name,
      subtitle: `${item.department || "未分配部门"} · ${item.role || "未设置岗位"} · 在职员工`,
      type: "人员",
      module: "people",
      action: "navigate",
      priority: 40,
      keywords: [item.employeeNo, item.department, item.role, item.company, "在职员工", "组织人事"]
    })),
    ...(people.leavers || []).map((item) => ({
      id: `person-leaver-${item.employeeNo || item.id || item.name}`,
      title: item.name,
      subtitle: `${item.department || "未分配部门"} · ${item.role || "未设置岗位"} · 离职人员`,
      type: "人员",
      module: "people",
      action: "navigate",
      priority: 45,
      keywords: [item.employeeNo, item.department, item.role, item.company, "离职人员", "组织人事"]
    }))
  ];
}

export function buildGlobalSearchResults({
  maxResults = 10,
  metrics = {},
  query,
  state = {},
  workflowTemplates = []
} = {}) {
  const normalizedQuery = normalize(query);
  if (!normalizedQuery) return [];

  const results = [];
  sideNav.forEach((item) => pushUnique(results, {
    id: `menu-${item.id}`,
    title: item.label,
    subtitle: "主导航入口",
    type: "菜单",
    module: item.id,
    action: "navigate",
    priority: 10,
    keywords: [item.id, "菜单", "导航"]
  }, normalizedQuery));

  appCatalog.forEach((item) => pushUnique(results, {
    id: `app-${item.id}`,
    title: item.title,
    subtitle: appSubtitle(item, metrics),
    type: item.templateId ? "流程" : "应用",
    module: item.module,
    action: item.templateId ? "flow" : "navigate",
    templateId: item.templateId,
    priority: item.templateId ? 25 : 20,
    keywords: [item.category, item.meta, item.module, item.templateId]
  }, normalizedQuery));

  workflowTemplates.forEach((item) => pushUnique(results, {
    id: `workflow-${item.id || item.serviceKey || item.name}`,
    title: item.name,
    subtitle: `${item.category || "审批流程"} · ${item.department || "通用部门"} · ${item.approvalMode || "审批"}`,
    type: "流程",
    module: "approvals",
    action: "flow",
    templateId: item.id,
    serviceKey: item.serviceKey,
    priority: 30,
    keywords: [item.id, item.serviceKey, item.condition, item.node, item.owner, item.department]
  }, normalizedQuery));

  personResults(state.people).forEach((item) => pushUnique(results, item, normalizedQuery));

  (state.approvals || []).forEach((item) => pushUnique(results, {
    id: `approval-${item.id}`,
    title: item.title,
    subtitle: `${item.applicant || "申请人"} · ${item.department || "部门"} · ${item.node || item.status || "审批中"}`,
    type: "审批",
    module: "approvals",
    action: "navigate",
    priority: 50,
    keywords: [item.id, item.status, item.workflowName, item.templateId, item.serviceKey]
  }, normalizedQuery));

  (state.assets || []).forEach((item) => pushUnique(results, {
    id: `asset-${item.id}`,
    title: item.name,
    subtitle: `${item.category || "资产"} · ${item.owner || "未分配"} · ${item.status || "状态未定"}`,
    type: "资产",
    module: "assets",
    action: "navigate",
    priority: 60,
    keywords: [item.id, item.category, item.owner, item.status, item.location]
  }, normalizedQuery));

  (state.resources || []).forEach((item) => pushUnique(results, {
    id: `resource-${item.id || item.name}`,
    title: item.name,
    subtitle: `${item.type || "资源"} · ${item.total || 0} 个可预约资源`,
    type: "资源",
    module: "resources",
    action: "navigate",
    priority: 65,
    keywords: [item.id, item.type, item.status, "会议室", "车辆", "工位", "设备预约"]
  }, normalizedQuery));

  (state.resourceBookings || []).forEach((item) => pushUnique(results, {
    id: `resource-booking-${item.id}`,
    title: item.purpose || item.resourceName,
    subtitle: `${item.resourceName || "资源预约"} · ${item.period || "时段"} · ${item.status || "状态未定"}`,
    type: "预约",
    module: "resources",
    action: "navigate",
    priority: 70,
    keywords: [item.id, item.resourceName, item.type, item.applicant, item.status]
  }, normalizedQuery));

  (state.auditLogs || []).forEach((item) => pushUnique(results, {
    id: `audit-${item.id}`,
    title: item.type,
    subtitle: `${item.content || "审计日志"} · ${item.time || ""}`,
    type: "审计",
    module: "audit",
    action: "navigate",
    priority: 80,
    keywords: [item.id, item.result, item.objectType, "操作日志", "导出记录"]
  }, normalizedQuery));

  return results
    .sort((left, right) => (
      scoreResult(left, normalizedQuery) - scoreResult(right, normalizedQuery)
      || left.priority - right.priority
      || String(left.title).localeCompare(String(right.title), "zh-Hans-CN")
    ))
    .slice(0, Math.max(1, Number(maxResults) || 10));
}
