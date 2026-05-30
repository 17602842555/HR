import React, { useMemo, useState } from "react";
import { ShieldCheck } from "lucide-react";
import { AppTile, DataTable, MetricCard, Panel, StatusPill } from "../components/Primitives.jsx";
import { appCatalog, flowTemplates, moduleCards } from "../data/seed.js";

function tileMeta(item, metrics) {
  if (item.metricKey) {
    const value = metrics[item.metricKey] ?? 0;
    return `${value} ${item.id === "pending" ? "项" : "人"}`;
  }
  return item.meta;
}

export function Home({ metrics, onNavigate, onOpenFlow, state, workflowTemplates }) {
  const templateOptions = workflowTemplates?.length ? workflowTemplates : flowTemplates;
  const [activeCategory, setActiveCategory] = useState("最近使用");
  const categories = ["最近使用", "人事管理", "审批工具", "数据分析", "客户服务", "企业文化", "培训学习", "更多"];
  const filteredApps = useMemo(() => {
    if (activeCategory === "最近使用") return appCatalog;
    return appCatalog.filter((item) => item.category === activeCategory);
  }, [activeCategory]);
  const openApp = (item) => {
    if (item.templateId) {
      const template = templateOptions.find((entry) => entry.id === item.templateId);
      if (template) {
        onOpenFlow(template);
        return;
      }
    }
    onNavigate(item.module);
  };

  const approvalColumns = [
    { key: "title", label: "流程名称" },
    { key: "applicant", label: "申请人" },
    { key: "node", label: "当前节点" },
    { key: "submittedAt", label: "提交时间" },
    { key: "status", label: "状态", render: (row) => <StatusPill value={row.status} /> }
  ];

  return (
    <div className="home-layout">
      <section className="app-center">
        <div className="app-center-head">
          <div>
            <span>工作台</span>
            <h1>全部应用</h1>
          </div>
          <div className="head-links">
            <button type="button">应用中心</button>
            <button type="button" onClick={onOpenFlow}>创建应用</button>
            <button type="button" onClick={() => onNavigate("audit")}>设置</button>
          </div>
        </div>
        <div className="tabs">
          {categories.map((item) => (
            <button
              className={activeCategory === item ? "active" : ""}
              key={item}
              type="button"
              onClick={() => setActiveCategory(item)}
            >
              {item}
            </button>
          ))}
        </div>
        <div className="app-grid">
          {filteredApps.map((item) => (
            <AppTile item={item} key={item.id} meta={tileMeta(item, metrics)} onClick={() => openApp(item)} />
          ))}
          {filteredApps.length === 0 ? (
            <div className="empty-apps">
              <strong>{activeCategory}</strong>
              <span>当前分类暂无应用，可从应用中心配置到这个分组。</span>
            </div>
          ) : null}
        </div>
      </section>

      <Panel
        className="hr-complete"
        title="人事管理完成模块"
        actions={<span className="soft-text">已完成搭建 · 8 个核心模块</span>}
      >
        <div className="hr-complete-body">
          <div className="hr-summary">
            <span className="done-chip">完成态</span>
            <MetricCard label="已完成人事模块" value="8 个" />
            <MetricCard label="已接入人员数据" value={`${metrics.totalPeople} 人`} />
            <p>覆盖组织架构、在职/离职、假勤、薪资、招聘与调薪流程。</p>
          </div>
          <div className="module-card-grid">
            {moduleCards.map(({ title, desc, icon: Icon }) => (
              <button key={title} type="button" onClick={() => onNavigate(title.includes("假勤") ? "attendance" : "people")}>
                <Icon size={18} />
                <strong>{title}</strong>
                <span>{desc}</span>
                <em>完成</em>
              </button>
            ))}
          </div>
        </div>
      </Panel>

      <Panel title="常用审批快捷发起" actions={<button type="button" onClick={() => onNavigate("approvals")}>进入审批中心</button>}>
        <div className="quick-flow-grid">
          {templateOptions.slice(0, 6).map((template) => (
            <button key={template.id} type="button" onClick={() => onOpenFlow(template)}>
              <strong>{template.name}</strong>
              <span>{template.category} · {template.fields.length} 个控件 · {template.approvalMode}</span>
            </button>
          ))}
        </div>
      </Panel>

      <section className="kpi-strip">
        <MetricCard label="在职员工" value={`${metrics.employees} 人`} />
        <MetricCard label="女性员工" tone="green" value={`${metrics.femaleEmployees} 人`} />
        <MetricCard label="累计离职" tone="orange" value={`${metrics.leavers} 人`} />
        <MetricCard label="当月离职" value={`${metrics.monthLeavers} 人`} />
        <MetricCard label="待办审批" tone="red" value={`${metrics.pendingApprovals} 项`} />
        <MetricCard label="资产利用率" value={`${metrics.assetUseRate}%`} />
      </section>

      <Panel title="待办与流程风险" actions={<button type="button" onClick={() => onNavigate("approvals")}>全部审批</button>}>
        <DataTable columns={approvalColumns} rows={state.approvals.slice(0, 6)} />
      </Panel>

      <div className="two-col">
        <Panel title="人员数据口径" actions={<button type="button" onClick={() => onNavigate("people")}>进入人事</button>}>
          <div className="bar-list">
            {state.people.departmentStats.slice(0, 6).map((item) => (
              <div className="mini-bar" key={item.label}>
                <span>{item.label}</span>
                <i><b style={{ width: `${Math.min(100, item.value * 8)}%` }} /></i>
                <em>{item.value}</em>
              </div>
            ))}
          </div>
        </Panel>
        <Panel title="合规留痕" actions={<ShieldCheck size={18} />}>
          <ul className="audit-feed">
            {state.auditLogs.slice(0, 5).map((item) => (
              <li key={item.id}><strong>{item.type}</strong><span>{item.content}</span><em>{item.time}</em></li>
            ))}
          </ul>
        </Panel>
      </div>
    </div>
  );
}
