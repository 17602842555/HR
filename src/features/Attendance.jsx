import React, { useState } from "react";
import { DataTable, MetricCard, Panel, StatusPill } from "../components/Primitives.jsx";

function defaultRecordForm() {
  const today = new Date().toISOString().slice(0, 10);
  return {
    employee: "当前员工",
    department: "行政部",
    workDate: today,
    checkIn: `${today} 09:00`,
    checkOut: `${today} 18:00`,
    status: "正常",
    minutesLate: 0,
    source: "手动补录",
    reason: ""
  };
}

export function Attendance({ actions, onOpenLeave, state }) {
  const [recordForm, setRecordForm] = useState(defaultRecordForm);
  const [recordMessage, setRecordMessage] = useState("");
  const attendanceRecords = state.attendanceRecords || [];
  const abnormalRecords = attendanceRecords.filter((item) => !["正常", "请假"].includes(item.status));
  const columns = [
    { key: "employee", label: "员工" },
    { key: "type", label: "类型" },
    { key: "dates", label: "日期" },
    { key: "days", label: "天数" },
    { key: "status", label: "状态", render: (row) => <StatusPill value={row.status} /> }
  ];
  const recordColumns = [
    { key: "workDate", label: "考勤日期" },
    { key: "employee", label: "员工" },
    { key: "department", label: "部门" },
    { key: "checkIn", label: "上班打卡" },
    { key: "checkOut", label: "下班打卡" },
    { key: "minutesLate", label: "迟到分钟" },
    { key: "source", label: "来源" },
    { key: "status", label: "状态", render: (row) => <StatusPill value={row.status} /> }
  ];
  const updateRecordForm = (field, value) => {
    setRecordForm((current) => ({ ...current, [field]: value }));
  };
  const submitRecord = async (event) => {
    event.preventDefault();
    setRecordMessage("正在保存考勤记录...");
    try {
      const result = await actions.createAttendanceRecord({ ...recordForm, minutesLate: Number(recordForm.minutesLate || 0) });
      if (result?.ok === false) throw result.error || new Error("考勤记录保存失败。");
      setRecordMessage("考勤记录已保存，并写入审计日志。");
      setRecordForm(defaultRecordForm());
    } catch (error) {
      setRecordMessage(error?.message || "考勤记录保存失败，请检查权限和日期格式。");
    }
  };

  return (
    <div className="module-layout">
      <section className="module-title">
        <div>
          <h1>假勤</h1>
          <p>请假、年假、病假和考勤记录，假勤流程也进入 OA 审批与审计。</p>
        </div>
        <button className="primary" type="button" onClick={onOpenLeave}>发起请假</button>
      </section>
      <section className="kpi-strip">
        <MetricCard label="请假记录" value={`${state.leaves.length} 条`} />
        <MetricCard label="待审批" tone="orange" value={`${state.leaves.filter((item) => item.status.includes("待")).length} 条`} />
        <MetricCard label="已通过" tone="green" value={`${state.leaves.filter((item) => item.status.includes("通过")).length} 条`} />
        <MetricCard label="本月考勤异常" tone="red" value={`${abnormalRecords.length} 条`} />
      </section>
      <Panel title="假勤申请">
        <DataTable columns={columns} rows={state.leaves} />
      </Panel>
      <Panel title="考勤记录" actions={(
        <>
          <button type="button" onClick={() => actions.exportAttendanceRecords({ scope: "考勤记录台账" })}>导出考勤记录</button>
          <span className="soft-text">记录来源：门禁同步 / 手动补录 / 外勤</span>
        </>
      )}>
        <form className="payroll-form" onSubmit={submitRecord}>
          <label>员工
            <input value={recordForm.employee} onChange={(event) => updateRecordForm("employee", event.target.value)} />
          </label>
          <label>部门
            <input value={recordForm.department} onChange={(event) => updateRecordForm("department", event.target.value)} />
          </label>
          <label>考勤日期
            <input type="date" value={recordForm.workDate} onChange={(event) => updateRecordForm("workDate", event.target.value)} />
          </label>
          <label>上班打卡
            <input value={recordForm.checkIn} onChange={(event) => updateRecordForm("checkIn", event.target.value)} />
          </label>
          <label>下班打卡
            <input value={recordForm.checkOut} onChange={(event) => updateRecordForm("checkOut", event.target.value)} />
          </label>
          <label>状态
            <select value={recordForm.status} onChange={(event) => updateRecordForm("status", event.target.value)}>
              <option>正常</option>
              <option>迟到</option>
              <option>早退</option>
              <option>缺卡</option>
              <option>请假</option>
              <option>外勤</option>
            </select>
          </label>
          <label>迟到分钟
            <input min="0" type="number" value={recordForm.minutesLate} onChange={(event) => updateRecordForm("minutesLate", event.target.value)} />
          </label>
          <label>异常说明
            <input value={recordForm.reason} onChange={(event) => updateRecordForm("reason", event.target.value)} />
          </label>
          <button className="primary" type="submit">保存考勤记录</button>
          <p>{recordMessage || "补录、异常说明和外勤记录会进入后端考勤表并留下审计记录。"}</p>
        </form>
        <DataTable columns={recordColumns} rows={attendanceRecords} />
      </Panel>
      <Panel title="打卡与假期规则">
        <div className="rule-grid">
          <div><strong>定位打卡</strong><span>支持外勤、补卡和异常说明</span></div>
          <div><strong>年假额度</strong><span>按入职日期和工龄自动计算</span></div>
          <div><strong>病假材料</strong><span>可上传证明，审批后进入人事档案</span></div>
          <div><strong>离职联动</strong><span>离职人员不再生成新考勤周期</span></div>
        </div>
      </Panel>
    </div>
  );
}
