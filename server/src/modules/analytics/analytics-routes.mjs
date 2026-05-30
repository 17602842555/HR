import { requirePermission } from "../iam/route-guards.mjs";
import { recordExportEvent, requestAuditMeta, requireExportBusinessReason } from "../audit/audit-service.mjs";

const snapshotColumns = Object.freeze(["板块", "指标", "数值", "说明"]);

function countBy(rows, pick) {
  return rows.reduce((acc, row) => {
    const label = pick(row) || "未填写";
    acc[label] = (acc[label] || 0) + 1;
    return acc;
  }, {});
}

function topCounts(rows, pick, limit = 8) {
  return Object.entries(countBy(rows, pick))
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([label, value]) => ({ label, value }));
}

function statusLabel(value) {
  return {
    ACTIVE: "在职",
    LEAVED: "离职",
    SUSPENDED: "停用",
    PENDING: "待审批",
    APPROVED: "已通过",
    REJECTED: "已驳回",
    WITHDRAWN: "已撤回",
    CANCELLED: "已取消",
    AVAILABLE: "空闲",
    BORROWED: "借用中",
    IN_USE: "使用中",
    REPAIRING: "维修中",
    RETIRED: "已退役"
  }[value] || value || "未知";
}

function monthKey(value) {
  if (!value) return "";
  return new Date(value).toISOString().slice(0, 7);
}

function numberFrom(value) {
  const number = Number(String(value ?? "").replace(/[^\d.-]/g, ""));
  return Number.isFinite(number) ? number : 0;
}

function workflowAmount(instance) {
  const formData = instance.formData || {};
  return numberFrom(formData.amount) || numberFrom(formData.totalAmount);
}

function isFinanceWorkflow(instance) {
  return String(instance.definitionCode || "").startsWith("FIN-")
    || instance.definition?.category === "财务行政";
}

function currentNode(instance) {
  return (instance.nodes || []).find((node) => node.id === instance.currentNodeId)
    || (instance.nodes || []).find((node) => node.status === "ACTIVE")
    || (instance.nodes || [])[0]
    || null;
}

function workflowRiskRows(instances) {
  return instances
    .filter((instance) => instance.status === "PENDING")
    .slice(0, 20)
    .map((instance) => {
      const node = currentNode(instance);
      const ageHours = instance.submittedAt
        ? Math.max(0, Math.round((Date.now() - new Date(instance.submittedAt).getTime()) / 36e5))
        : 0;
      return {
        id: instance.id,
        title: instance.title,
        node: node?.name || "待处理节点",
        sla: ageHours > 48 ? "超时" : `${ageHours}h`,
        status: statusLabel(instance.status)
      };
    });
}

function approvalEfficiency(instances) {
  const approved = instances.filter((item) => item.status === "APPROVED").length;
  const rejected = instances.filter((item) => item.status === "REJECTED").length;
  const pending = instances.filter((item) => item.status === "PENDING").length;
  const completed = approved + rejected;
  return {
    approved,
    completed,
    passRate: Math.round((approved / Math.max(completed, 1)) * 100),
    pending,
    rejected
  };
}

function payrollCost(payrolls) {
  return payrolls.reduce((sum, payroll) => (
    sum + numberFrom(payroll.metadata?.totalAmount || payroll.metadata?.amount)
  ), 0);
}

function financeWorkflowCost(instances) {
  return instances
    .filter(isFinanceWorkflow)
    .reduce((sum, instance) => sum + workflowAmount(instance), 0);
}

function csvCell(value) {
  const text = value === null || value === undefined ? "" : String(value);
  const safeText = /^[\s]*[=+\-@]/.test(text) ? `'${text}` : text;
  return `"${safeText.replaceAll("\"", "\"\"").replace(/\r?\n/g, " ")}"`;
}

function timestampToken() {
  return new Date().toISOString().replaceAll(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function replyCsv(reply, csv, filename, rowCount) {
  return reply
    .header("Content-Type", "text/csv; charset=utf-8")
    .header("Content-Disposition", `attachment; filename="${filename}"`)
    .header("X-Row-Count", String(rowCount))
    .header("Cache-Control", "no-store")
    .send(csv);
}

function analyticsSnapshotRows(analytics) {
  const cards = analytics.cards || {};
  const efficiency = analytics.approvalEfficiency || {};
  return [
    ["概览指标", "人员总量", cards.totalPeople, "导入与后端员工表合计"],
    ["概览指标", "在职人数", cards.employees, "状态为在职的员工"],
    ["概览指标", "当月离职", cards.monthLeavers, "按离职日期归属当前月份"],
    ["概览指标", "待办流程", cards.pendingApprovals, "状态为待审批的流程"],
    ["概览指标", "资产使用率", `${cards.assetUseRate || 0}%`, "借用中/使用中资产占比"],
    ["概览指标", "行政费用", cards.administrativeCost, "工资单、财务流程和资产在用成本合计"],
    ["审批效率", "已通过", efficiency.approved, "审批实例状态统计"],
    ["审批效率", "已完成", efficiency.completed, "已通过与已驳回合计"],
    ["审批效率", "待处理", efficiency.pending, "待审批实例数"],
    ["审批效率", "驳回", efficiency.rejected, "已驳回实例数"],
    ["审批效率", "通过率", `${efficiency.passRate || 0}%`, "已通过 / 已完成"],
    ...((analytics.peopleByDepartment || []).map((item) => ["人员部门分布", item.label, item.value, "在职员工"])),
    ...((analytics.leaversByDepartment || []).map((item) => ["离职部门分布", item.label, item.value, "离职员工"])),
    ...((analytics.assetByStatus || []).map((item) => ["资产状态", item.label, item.value, "资产台账"])),
    ...((analytics.costBreakdown || []).map((item) => ["行政成本构成", item.label, item.value, "后端聚合"])),
    ["资源预约", "已确认", analytics.resourceBookings?.confirmed || 0, "确认预约数"],
    ["资源预约", "待处理", analytics.resourceBookings?.pending || 0, "待处理预约数"],
    ...((analytics.riskApprovals || []).map((item) => [
      "流程效率与风险",
      item.title,
      item.status,
      `${item.node || "待处理节点"} · ${item.sla || ""}`
    ]))
  ];
}

function analyticsSnapshotCsv(analytics) {
  const rows = analyticsSnapshotRows(analytics);
  const lines = [
    snapshotColumns.map(csvCell).join(","),
    ...rows.map((row) => row.map(csvCell).join(","))
  ];
  return {
    csv: `\uFEFF${lines.join("\n")}\n`,
    rowCount: rows.length
  };
}

async function buildManagementAnalytics(app, tenantId) {
  const [
    employees,
    workflowInstances,
    assets,
    payrolls,
    bookings,
    auditLogs
  ] = await Promise.all([
    app.prisma.employee.findMany({ where: { tenantId }, include: { department: true } }),
    app.prisma.workflowInstance.findMany({ where: { tenantId }, include: { definition: true, nodes: { include: { approvers: true } } } }),
    app.prisma.asset.findMany({ where: { tenantId } }),
    app.prisma.payrollBatch.findMany({ where: { tenantId } }),
    app.prisma.booking.findMany({ where: { tenantId } }),
    app.prisma.auditLog.findMany({
      where: {
        tenantId,
        createdAt: { gte: new Date(new Date().toISOString().slice(0, 10)) }
      },
      take: 500
    })
  ]);

  const activeEmployees = employees.filter((item) => item.status === "ACTIVE");
  const leavers = employees.filter((item) => item.status === "LEAVED");
  const month = new Date().toISOString().slice(0, 7);
  const monthLeavers = leavers.filter((item) => monthKey(item.leaveDate) === month);
  const activeAssets = assets.filter((item) => ["BORROWED", "IN_USE"].includes(item.status));
  const costBreakdown = [
    { label: "工资单", value: payrollCost(payrolls) },
    { label: "财务流程", value: financeWorkflowCost(workflowInstances) },
    { label: "资产在用", value: activeAssets.length }
  ];
  const administrativeCost = costBreakdown.reduce((sum, item) => sum + item.value, 0);
  const efficiency = approvalEfficiency(workflowInstances);

  return {
    generatedAt: new Date().toISOString(),
    cards: {
      activeAssets: activeAssets.length,
      administrativeCost,
      approvalPassRate: efficiency.passRate,
      assetUseRate: Math.round((activeAssets.length / Math.max(assets.length, 1)) * 100),
      auditToday: auditLogs.length,
      employees: activeEmployees.length,
      leavers: leavers.length,
      monthLeavers: monthLeavers.length,
      pendingApprovals: efficiency.pending,
      totalPeople: employees.length
    },
    approvalEfficiency: efficiency,
    assetByStatus: topCounts(assets, (item) => statusLabel(item.status)),
    costBreakdown,
    leaversByDepartment: topCounts(leavers, (item) => item.department?.name),
    peopleByDepartment: topCounts(activeEmployees, (item) => item.department?.name),
    resourceBookings: {
      confirmed: bookings.filter((item) => item.status === "CONFIRMED").length,
      pending: bookings.filter((item) => item.status === "PENDING").length
    },
    riskApprovals: workflowRiskRows(workflowInstances)
  };
}

export async function registerAnalyticsRoutes(app) {
  app.get("/api/analytics/overview", { preHandler: app.authenticate }, async (request) => {
    await requirePermission(app, request, { module: "analytics", action: "read" });
    return {
      analytics: await buildManagementAnalytics(app, request.user.tenantId)
    };
  });

  app.post("/api/analytics/export", { preHandler: app.authenticate }, async (request, reply) => {
    await requirePermission(app, request, { module: "analytics", action: "export" });
    const scope = request.body?.scope || request.body?.filters?.scope || "管理看板快照";
    const businessReason = requireExportBusinessReason(request.body || {});
    const analytics = await buildManagementAnalytics(app, request.user.tenantId);
    const { csv, rowCount } = analyticsSnapshotCsv(analytics);
    const filename = `analytics-snapshot-${timestampToken()}.csv`;

    await recordExportEvent(app.prisma, {
      tenantId: request.user.tenantId,
      actorUserId: request.user.sub,
      action: "analytics.export",
      module: "analytics",
      objectType: "analytics_snapshot",
      fileName: filename,
      scope,
      businessReason,
      rowCount,
      summary: `导出${scope}，后端生成管理看板快照`,
      metadata: {
        scope,
        format: "csv",
        rowCount,
        generatedAt: analytics.generatedAt,
        cards: analytics.cards
      },
      ...requestAuditMeta(request)
    });

    return replyCsv(reply, csv, filename, rowCount);
  });
}
