import React, { useMemo, useState } from "react";
import { DataTable, MetricCard, Panel, StatusPill } from "../components/Primitives.jsx";
import { maskPerson } from "../data/dashboardSource.js";

function formatImportTime(value) {
  if (!value) return "-";
  return String(value).replace("T", " ").slice(0, 19);
}

function importCountText(row) {
  const counts = row.recordCounts || {};
  return `${counts.totalRows || 0} 行 · 在职 ${counts.activeEmployees || 0} · 离职 ${counts.leavers || 0}`;
}

function tabExportStatus(tab) {
  return {
    employees: "ACTIVE",
    inactive: "SUSPENDED",
    leavers: "LEAVED",
    month: "LEAVED",
    women: "ACTIVE"
  }[tab] || "";
}

function tabExportScope(tab) {
  return {
    employees: "在职员工",
    inactive: "停用人员",
    leavers: "离职人员",
    month: "当月离职",
    women: "女性员工"
  }[tab] || "人员名册";
}

function tabExportMonth(tab) {
  return tab === "month" ? "2026-05" : "";
}

function lifecycleLine(summary) {
  if (!summary) return "暂无流程同步";
  return [summary.label, summary.detail, summary.effectiveDate].filter(Boolean).join(" · ");
}

function LifecycleSummary({ summary }) {
  if (!summary) return <span className="soft-text">-</span>;
  return (
    <span className="lifecycle-summary">
      <strong>{summary.label || "人事流程"}</strong>
      <span>{summary.effectiveDate || summary.status || "已同步"}</span>
    </span>
  );
}

export function People({ actions, state }) {
  const [tab, setTab] = useState("employees");
  const [keyword, setKeyword] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [draft, setDraft] = useState({ department: "", role: "", status: "在职", leaveDate: "" });
  const [importStatus, setImportStatus] = useState("");
  const sourceRows = tab === "leavers"
    ? state.people.leavers
    : tab === "month"
      ? state.people.monthLeavers
      : tab === "inactive"
        ? (state.people.inactiveEmployees || [])
        : tab === "women"
          ? state.people.femaleEmployees
          : state.people.employees;
  const rows = useMemo(() => sourceRows
    .map((item) => maskPerson(item, state.revealSensitive))
    .filter((item) => !keyword || Object.values(item).join(" ").includes(keyword))
    .slice(0, 80), [keyword, sourceRows, state.revealSensitive]);
  const departmentOptions = useMemo(() => (
    [...new Set([
      ...(state.people.departmentStats || []).map((item) => item.label),
      ...(state.people.leaverDepartmentStats || []).map((item) => item.label),
      ...rows.map((row) => row.department)
    ].filter(Boolean))]
  ), [rows, state.people.departmentStats, state.people.leaverDepartmentStats]);
  const selected = rows.find((row) => row.id === selectedId) || rows[0] || null;
  React.useEffect(() => {
    if (!selected) return;
    setSelectedId(selected.id);
    setDraft({
      department: selected.department || "",
      role: selected.role || "",
      status: selected.status || "在职",
      leaveDate: selected.leaveDate || ""
    });
  }, [selected?.id]);
  const personColumns = [
    { key: "name", label: "姓名" },
    { key: "gender", label: "性别" },
    { key: "org", label: "组织" },
    { key: "department", label: "部门" },
    { key: "role", label: "岗位" },
    { key: "entryDate", label: "入职日期" },
    { key: "regularDate", label: "转正/离职日期", render: (row) => row.status === "离职" ? row.leaveDate : row.regularDate },
    { key: "lifecycleSummary", label: "最近人事流程", render: (row) => <LifecycleSummary summary={row.lifecycleSummary} /> },
    { key: "status", label: "状态", render: (row) => <StatusPill value={row.status} /> },
    { key: "education", label: "学历" },
    { key: "school", label: "毕业学校" },
    { key: "action", label: "维护", render: (row) => <button type="button" onClick={() => setSelectedId(row.id)}>维护</button> }
  ];
  const importColumns = [
    { key: "sourceName", label: "来源文件" },
    { key: "sourceType", label: "类型" },
    { key: "recordCounts", label: "导入数量", render: importCountText },
    { key: "sourceChecksum", label: "源校验", render: (row) => String(row.sourceChecksum || "").slice(0, 12) || "-" },
    { key: "sourceArtifact", label: "源文件", render: (row) => (
      row.metadata?.sourceArtifact?.downloadAvailable
        ? <button type="button" onClick={() => actions.downloadImportSource(row)}>下载源文件</button>
        : <span className="soft-text">未保存</span>
    ) },
    { key: "status", label: "状态", render: (row) => <StatusPill value={row.status === "SUCCESS" ? "成功" : row.status} /> },
    { key: "actor", label: "操作人", render: (row) => row.actor?.name || "-" },
    { key: "finishedAt", label: "完成时间", render: (row) => formatImportTime(row.finishedAt || row.startedAt) }
  ];

  return (
    <div className="module-layout">
      <section className="module-title">
        <div>
          <h1>组织人事</h1>
          <p>从 `oa-dashboard.html` 解析在职、离职、女性员工、当月离职和组织结构数据，默认隐藏敏感字段。</p>
        </div>
        <button className="primary" type="button" onClick={() => actions.toggleSensitive()}>
          {state.revealSensitive ? "关闭敏感字段" : "授权查看敏感字段"}
        </button>
      </section>

      <section className="kpi-strip">
        <MetricCard label="在职员工" value={`${state.people.employees.length} 人`} />
        <MetricCard label="女性员工" tone="green" value={`${state.people.femaleEmployees.length} 人`} />
        <MetricCard label="累计离职" tone="orange" value={`${state.people.leavers.length} 人`} />
        <MetricCard label="当月离职" value={`${state.people.monthLeavers.length} 人`} />
      </section>

      <Panel title="人员名册" actions={<button type="button" onClick={() => actions.exportPeople({
        keyword,
        month: tabExportMonth(tab),
        scope: tabExportScope(tab),
        status: tabExportStatus(tab)
      })}>导出名册</button>}>
        <div className="panel-toolbar">
          <div className="tabs compact">
            {[
              ["employees", "在职员工"],
              ["women", "女性员工"],
              ["inactive", "停用人员"],
              ["leavers", "离职人员"],
              ["month", "当月离职"]
            ].map(([key, label]) => (
              <button className={tab === key ? "active" : ""} key={key} type="button" onClick={() => setTab(key)}>{label}</button>
            ))}
          </div>
          <input value={keyword} placeholder="筛选姓名、部门、岗位" onChange={(event) => setKeyword(event.target.value)} />
        </div>
        <DataTable columns={personColumns} rows={rows} rowKey={(row) => row.id} />
      </Panel>

      <Panel title="员工档案维护" actions={<span className="soft-text">仅维护岗位、部门和状态；敏感字段不在此处编辑</span>}>
        {selected ? (
          <form className="employee-editor" onSubmit={(event) => {
            event.preventDefault();
            actions.updateEmployee(selected.id, draft);
          }}>
            <div>
              <strong>{selected.name}</strong>
              <span>{selected.seq} · {selected.gender} · {selected.org}</span>
              <em>{lifecycleLine(selected.lifecycleSummary)}</em>
            </div>
            <label>部门
              <select value={draft.department} onChange={(event) => setDraft((current) => ({ ...current, department: event.target.value }))}>
                {departmentOptions.map((department) => <option key={department} value={department}>{department}</option>)}
              </select>
            </label>
            <label>岗位
              <input value={draft.role} onChange={(event) => setDraft((current) => ({ ...current, role: event.target.value }))} />
            </label>
            <label>状态
              <select value={draft.status} onChange={(event) => setDraft((current) => ({ ...current, status: event.target.value }))}>
                <option value="在职">在职</option>
                <option value="离职">离职</option>
                <option value="停用">停用</option>
              </select>
            </label>
            <label>离职日期
              <input
                disabled={draft.status !== "离职"}
                type="date"
                value={draft.leaveDate || ""}
                onChange={(event) => setDraft((current) => ({ ...current, leaveDate: event.target.value }))}
              />
            </label>
            <button className="primary" type="submit">保存员工档案</button>
          </form>
        ) : <p className="empty">暂无可维护员工</p>}
      </Panel>

      <Panel title="数据导入记录" actions={<span className="soft-text">来源、校验和、导入行数用于交付验收</span>}>
        <form className="import-form" onSubmit={async (event) => {
          event.preventDefault();
          const file = event.currentTarget.dashboardFile.files?.[0];
          if (!file) {
            setImportStatus("请选择 oa-dashboard.html 文件");
            return;
          }
          const html = await file.text();
          actions.importDashboardHtml({ sourceName: file.name, html });
          setImportStatus(`已提交导入：${file.name}`);
          event.currentTarget.reset();
        }}>
          <label>导入 HTML 数据源
            <input accept=".html,text/html" name="dashboardFile" type="file" />
          </label>
          <button className="primary" type="submit">导入人员数据</button>
          <p>{importStatus || "支持重新导入 oa-dashboard.html，系统会记录来源、校验和、导入行数和审计日志。"}</p>
        </form>
        <DataTable columns={importColumns} empty="暂无导入记录" rows={state.importRuns || []} />
      </Panel>

      <div className="two-col">
        <Panel title="部门结构">
          <div className="bar-list">
            {state.people.departmentStats.map((item) => (
              <div className="mini-bar" key={item.label}>
                <span>{item.label}</span>
                <i><b style={{ width: `${Math.min(100, item.value * 8)}%` }} /></i>
                <em>{item.value}</em>
              </div>
            ))}
          </div>
        </Panel>
        <Panel title="离职部门分析">
          <div className="bar-list">
            {state.people.leaverDepartmentStats.map((item) => (
              <div className="mini-bar orange" key={item.label}>
                <span>{item.label}</span>
                <i><b style={{ width: `${Math.min(100, item.value * 3)}%` }} /></i>
                <em>{item.value}</em>
              </div>
            ))}
          </div>
        </Panel>
      </div>
    </div>
  );
}
