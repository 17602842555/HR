import React from "react";
import { ChevronRight } from "lucide-react";

export function Panel({ actions, children, className = "", title }) {
  return (
    <section className={`panel ${className}`}>
      <div className="panel-head">
        <h2>{title}</h2>
        <div>{actions}</div>
      </div>
      {children}
    </section>
  );
}

export function MetricCard({ label, tone = "blue", value }) {
  return (
    <div className={`metric-card ${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

export function StatusPill({ value }) {
  const tone = String(value).includes("超时") || String(value).includes("驳回")
    || String(value).includes("失败") || String(value).includes("不可用")
    || String(value).includes("未连接") || String(value).includes("阻断")
    ? "red"
    : String(value).includes("通过") || String(value).includes("完成") || String(value).includes("归档") || String(value).includes("发布")
      ? "green"
      : "orange";
  return <span className={`status-pill ${tone}`}>{value}</span>;
}

export function DataTable({ columns, empty = "暂无数据", rows, rowKey }) {
  return (
    <div className="table-wrap">
      <table className="data-table">
        <thead>
          <tr>{columns.map((column) => <th key={column.key}>{column.label}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={rowKey ? rowKey(row) : row.id || index}>
              {columns.map((column) => <td key={column.key}>{column.render ? column.render(row) : row[column.key]}</td>)}
            </tr>
          ))}
          {rows.length === 0 ? (
            <tr><td colSpan={columns.length}>{empty}</td></tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}

export function AppTile({ item, meta, onClick }) {
  return (
    <button className="app-tile" type="button" onClick={onClick}>
      <span className="tile-icon">{item.icon}</span>
      <strong>{item.title}</strong>
      <em>{meta}</em>
      <ChevronRight className="tile-arrow" size={15} />
    </button>
  );
}
