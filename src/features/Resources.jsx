import React, { useMemo, useState } from "react";
import { dayLabels } from "../data/seed.js";
import { DataTable, MetricCard, Panel, StatusPill } from "../components/Primitives.jsx";

const periods = ["09:00-10:00", "10:00-12:00", "14:00-16:00", "16:00-18:00", "19:00-21:00"];

function todayToken() {
  return new Date().toISOString().slice(0, 10);
}

function addDaysToken(dateToken, dayOffset) {
  const date = new Date(`${dateToken}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + Number(dayOffset || 0));
  return date.toISOString().slice(0, 10);
}

function dayIndexForDate(dateToken, baseToken = todayToken()) {
  const date = new Date(`${dateToken}T00:00:00.000Z`);
  const base = new Date(`${baseToken}T00:00:00.000Z`);
  const diff = Math.floor((date.getTime() - base.getTime()) / 86_400_000);
  return diff >= 0 && diff <= 6 ? diff : -1;
}

function labelForDate(dateToken) {
  const date = new Date(`${dateToken}T00:00:00.000Z`);
  const weekdays = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
  return `${weekdays[date.getUTCDay()]} ${dateToken.slice(5)}`;
}

export function Resources({ actions, currentUser, state }) {
  const currentUserName = currentUser?.name || "当前用户";
  const windowStart = state.resourceWindowStart || todayToken();
  const [form, setForm] = useState({
    resourceName: state.resources[0]?.name || "",
    bookingDate: windowStart,
    dayIndex: 0,
    period: periods[0],
    applicant: currentUserName,
    purpose: "部门协作会议"
  });
  const [notice, setNotice] = useState("");

  const selectedResource = state.resources.find((item) => item.name === form.resourceName) || state.resources[0];
  const windowDayLabels = dayLabels.map((_, index) => labelForDate(addDaysToken(windowStart, index)));
  const formDayIndex = dayIndexForDate(form.bookingDate, windowStart);
  const calendarDayIndex = formDayIndex >= 0 ? formDayIndex : Number(form.dayIndex || 0);
  const isFull = selectedResource && formDayIndex >= 0 ? selectedResource.slots[calendarDayIndex] >= selectedResource.total : false;
  const duplicate = state.resourceBookings.some((item) => (
    item.resourceName === form.resourceName
    && (item.date ? item.date === form.bookingDate : item.dayIndex === calendarDayIndex)
    && item.period === form.period
    && item.status === "已预约"
  ));
  const canBook = selectedResource && !isFull && !duplicate;

  const bookingRows = useMemo(() => state.resourceBookings.map((item) => ({
    ...item,
    day: item.date || windowDayLabels[item.dayIndex] || "-"
  })), [state.resourceBookings, windowDayLabels]);

  const columns = [
    { key: "type", label: "类型" },
    { key: "name", label: "资源名称" },
    { key: "capacity", label: "容量/数量" },
    ...windowDayLabels.map((day, index) => ({
      key: day,
      label: day,
      render: (row) => {
        const used = row.slots[index];
        const full = used >= row.total;
        return (
          <button
            className={full ? "slot full" : used ? "slot booked" : "slot free"}
            type="button"
            onClick={() => {
              setForm((current) => ({ ...current, resourceName: row.name, dayIndex: index, bookingDate: addDaysToken(windowStart, index) }));
              setNotice(full ? "该日期容量已满，可切换其他日期或资源。" : "已带入预约表单，请选择具体时段后提交。");
            }}
          >
            {used ? `${used}/${row.total}` : "空闲"}
          </button>
        );
      }
    }))
  ];

  const bookingColumns = [
    { key: "resourceName", label: "资源" },
    { key: "type", label: "类型" },
    { key: "day", label: "日期" },
    { key: "period", label: "时段" },
    { key: "applicant", label: "申请人" },
    { key: "purpose", label: "用途" },
    { key: "status", label: "状态", render: (row) => <StatusPill value={row.status} /> },
    {
      key: "actions",
      label: "操作",
      render: (row) => (
        row.status === "已预约"
          ? <button className="ghost" type="button" onClick={() => actions.cancelResourceBooking(row.id, "用户取消预约")}>取消</button>
          : <span className="muted">-</span>
      )
    }
  ];

  const submit = () => {
    if (!canBook) {
      setNotice(isFull ? "冲突：该资源当天容量已满，系统已阻止提交。" : "冲突：该资源同时段已有预约，系统已阻止提交。");
      return;
    }
    actions.reserveResource(form.resourceName, Number(form.dayIndex), form);
    setNotice("预约已提交，资源占用数和审计日志已同步更新。");
  };

  return (
    <div className="module-layout">
      <section className="module-title">
        <div>
          <h1>资源预约</h1>
          <p>会议室、车辆、工位和设备预约，支持日期/时段冲突检查、占用反馈和审计留痕。</p>
        </div>
      </section>
      <section className="kpi-strip">
        <MetricCard label="资源类型" value="4 类" />
        <MetricCard label="资源数量" value={`${state.resources.length} 个`} />
        <MetricCard label="冲突预警" tone="orange" value={`${state.resources.filter((item) => item.slots.some((slot) => slot >= item.total)).length} 条`} />
        <MetricCard label="预约记录" tone="green" value={`${state.resourceBookings.length} 条`} />
      </section>

      <div className="split-view">
        <Panel title="预约表单">
          <div className="form-stack inline-form">
            <label>资源
              <select value={form.resourceName} onChange={(event) => setForm({ ...form, resourceName: event.target.value })}>
                {state.resources.map((resource) => <option key={resource.name}>{resource.name}</option>)}
              </select>
            </label>
            <label>预约日期
              <input
                type="date"
                value={form.bookingDate}
                onChange={(event) => {
                  const nextDate = event.target.value;
                  const nextIndex = dayIndexForDate(nextDate, windowStart);
                  setForm({ ...form, bookingDate: nextDate, dayIndex: nextIndex >= 0 ? nextIndex : form.dayIndex });
                }}
              />
            </label>
            <label>快捷日期
              <select
                value={calendarDayIndex}
                onChange={(event) => {
                  const index = Number(event.target.value);
                  setForm({ ...form, dayIndex: index, bookingDate: addDaysToken(windowStart, index) });
                }}
              >
                {windowDayLabels.map((day, index) => <option key={day} value={index}>{day}</option>)}
              </select>
            </label>
            <label>时段
              <select value={form.period} onChange={(event) => setForm({ ...form, period: event.target.value })}>
                {periods.map((period) => <option key={period}>{period}</option>)}
              </select>
            </label>
            <label>申请人<input value={form.applicant} onChange={(event) => setForm({ ...form, applicant: event.target.value })} /></label>
            <label>用途<textarea value={form.purpose} onChange={(event) => setForm({ ...form, purpose: event.target.value })} /></label>
            <div className={`conflict-card ${canBook ? "ok" : "warn"}`}>
              <strong>{canBook ? "可预约" : "存在冲突"}</strong>
              <span>{canBook ? "当前日期、资源和时段可用，提交后会写入预约记录。" : isFull ? "该日期容量已满。" : "该时段已经被预约。"}</span>
            </div>
            <button className="primary" type="button" onClick={submit}>提交预约</button>
            {notice ? <p className="notice-text">{notice}</p> : null}
          </div>
        </Panel>

        <Panel title="预约记录" actions={<button type="button" onClick={() => actions.exportResourceBookings({ scope: "资源预约台账" })}>导出预约台账</button>}>
          <DataTable columns={bookingColumns} rows={bookingRows} />
        </Panel>
      </div>

      <Panel title="预约日历">
        <DataTable columns={columns} rows={state.resources} rowKey={(row) => row.name} />
      </Panel>
    </div>
  );
}
