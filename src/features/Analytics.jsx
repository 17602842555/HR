import React from "react";
import { DataTable, MetricCard, Panel, StatusPill } from "../components/Primitives.jsx";

function numberFrom(value) {
  const number = Number(String(value ?? "").replace(/[^\d.-]/g, ""));
  return Number.isFinite(number) ? number : 0;
}

function currency(value) {
  return `¥${Math.round(value || 0).toLocaleString("zh-CN")}`;
}

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

function localAnalytics(state, metrics) {
  const riskApprovals = state.approvals
    .filter((item) => item.status.includes("待") || item.status.includes("超时"))
    .map((item) => ({
      id: item.id,
      node: item.node,
      sla: item.sla || item.dueAt || "待处理",
      status: item.status,
      title: item.title
    }));
  const approved = state.approvals.filter((item) => item.status.includes("通过")).length;
  const rejected = state.approvals.filter((item) => item.status.includes("驳回")).length;
  const financeWorkflowCost = state.approvals.reduce((sum, item) => (
    sum + numberFrom(item.formData?.amount || item.formData?.totalAmount || item.amount)
  ), 0);
  const costBreakdown = [
    { label: "财务流程", value: financeWorkflowCost },
    { label: "工资单", value: state.payrolls.filter((item) => item.status.includes("发布")).length },
    { label: "资产在用", value: metrics.activeAssets }
  ];
  return {
    approvalEfficiency: {
      approved,
      completed: approved + rejected,
      passRate: Math.round((approved / Math.max(approved + rejected, 1)) * 100),
      pending: metrics.pendingApprovals,
      rejected
    },
    assetByStatus: topCounts(state.assets, (item) => item.status),
    cards: {
      administrativeCost: costBreakdown.reduce((sum, item) => sum + item.value, 0),
      approvalPassRate: Math.round((approved / Math.max(approved + rejected, 1)) * 100),
      assetUseRate: metrics.assetUseRate,
      auditToday: metrics.auditToday,
      employees: metrics.employees,
      monthLeavers: metrics.monthLeavers,
      pendingApprovals: metrics.pendingApprovals,
      totalPeople: metrics.totalPeople
    },
    costBreakdown,
    leaversByDepartment: state.people.leaverDepartmentStats,
    peopleByDepartment: state.people.departmentStats,
    riskApprovals
  };
}

export function Analytics({ actions, metrics, state }) {
  const analytics = state.analytics || localAnalytics(state, metrics);
  const cards = analytics.cards || {};
  const riskRows = analytics.riskApprovals || [];
  const approvalColumns = [
    { key: "title", label: "风险流程" },
    { key: "node", label: "当前节点" },
    { key: "sla", label: "SLA" },
    { key: "status", label: "状态", render: (row) => <StatusPill value={row.status} /> }
  ];
  const breakdownColumns = [
    { key: "label", label: "成本项" },
    { key: "value", label: "金额/计数", render: (row) => row.label === "资产在用" ? `${row.value} 件` : currency(row.value) }
  ];

  return (
    <div className="module-layout">
      <section className="module-title">
        <div>
          <h1>管理看板</h1>
          <p>人员结构、离职统计、审批效率、资产状态和行政成本总览。</p>
        </div>
        <button className="primary" type="button" onClick={() => actions.exportAnalyticsSnapshot({ scope: "管理看板快照" })}>导出看板快照</button>
      </section>
      <section className="kpi-strip">
        <MetricCard label="人员总量" value={`${cards.totalPeople ?? metrics.totalPeople} 人`} />
        <MetricCard label="在职人数" value={`${cards.employees ?? metrics.employees} 人`} />
        <MetricCard label="当月离职" tone="orange" value={`${cards.monthLeavers ?? metrics.monthLeavers} 人`} />
        <MetricCard label="待办流程" tone="red" value={`${cards.pendingApprovals ?? metrics.pendingApprovals} 项`} />
        <MetricCard label="资产使用率" value={`${cards.assetUseRate ?? metrics.assetUseRate}%`} />
        <MetricCard label="行政费用" value={currency(cards.administrativeCost)} />
      </section>
      <div className="two-col">
        <Panel title="人员部门分布">
          <div className="bar-list">
            {(analytics.peopleByDepartment || []).map((item) => (
              <div className="mini-bar" key={item.label}>
                <span>{item.label}</span>
                <i><b style={{ width: `${Math.min(100, item.value * 8)}%` }} /></i>
                <em>{item.value}</em>
              </div>
            ))}
          </div>
        </Panel>
        <Panel title="离职部门分布">
          <div className="bar-list">
            {(analytics.leaversByDepartment || []).map((item) => (
              <div className="mini-bar orange" key={item.label}>
                <span>{item.label}</span>
                <i><b style={{ width: `${Math.min(100, item.value * 3)}%` }} /></i>
                <em>{item.value}</em>
              </div>
            ))}
          </div>
        </Panel>
      </div>
      <div className="two-col">
        <Panel title="审批效率">
          <div className="kpi-strip compact-kpis">
            <MetricCard label="通过率" value={`${analytics.approvalEfficiency?.passRate ?? 0}%`} />
            <MetricCard label="已完成" value={`${analytics.approvalEfficiency?.completed ?? 0} 项`} />
            <MetricCard label="待处理" tone="orange" value={`${analytics.approvalEfficiency?.pending ?? 0} 项`} />
          </div>
        </Panel>
        <Panel title="资产状态">
          <div className="bar-list">
            {(analytics.assetByStatus || []).map((item) => (
              <div className="mini-bar" key={item.label}>
                <span>{item.label}</span>
                <i><b style={{ width: `${Math.min(100, item.value * 18)}%` }} /></i>
                <em>{item.value}</em>
              </div>
            ))}
          </div>
        </Panel>
      </div>
      <Panel title="行政成本构成">
        <DataTable columns={breakdownColumns} rows={analytics.costBreakdown || []} />
      </Panel>
      <Panel title="流程效率与风险">
        <DataTable columns={approvalColumns} rows={riskRows} />
      </Panel>
    </div>
  );
}
