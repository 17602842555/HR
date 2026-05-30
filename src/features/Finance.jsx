import React, { useState } from "react";
import { DataTable, MetricCard, Panel, StatusPill } from "../components/Primitives.jsx";
import { flowTemplates } from "../data/seed.js";

function defaultPayrollForm(state) {
  const now = new Date();
  const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const batchMonth = `${nextMonth.getFullYear()}${String(nextMonth.getMonth() + 1).padStart(2, "0")}`;
  const headcount = state.people?.employees?.length || 72;
  return {
    batchNo: `PAYROLL-${batchMonth}-${String(Date.now()).slice(-4)}`,
    cycle: `${nextMonth.getFullYear()}年${nextMonth.getMonth() + 1}月`,
    scope: "在职、转正、入离职、异动人员",
    owner: "财务中心",
    department: "财务中心",
    headcount,
    totalAmount: Math.max(headcount * 6800, 1),
    comment: ""
  };
}

function defaultFinanceRequestForm(type = "EXPENSE") {
  const prefix = type === "PAYMENT" ? "PAY" : "EXP";
  return {
    type,
    requestNo: `${prefix}-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${String(Date.now()).slice(-4)}`,
    title: type === "PAYMENT" ? "供应商付款申请" : "费用报销申请",
    department: type === "PAYMENT" ? "财务中心" : "行政部",
    amount: type === "PAYMENT" ? 12000 : 980,
    vendor: type === "PAYMENT" ? "供应商名称" : "报销商户",
    paymentMethod: type === "PAYMENT" ? "对公转账" : "员工垫付",
    purpose: ""
  };
}

export function Finance({ actions, onOpenFlow, state, workflowTemplates }) {
  const templateOptions = workflowTemplates?.length ? workflowTemplates : flowTemplates;
  const expenseTemplate = templateOptions.find((item) => item.id === "expense") || flowTemplates.find((item) => item.id === "expense") || flowTemplates[0];
  const paymentTemplate = templateOptions.find((item) => item.id === "payment") || flowTemplates.find((item) => item.id === "payment") || flowTemplates[1];
  const financeFlows = state.approvals.filter((item) => item.category === "财务行政");
  const [payrollForm, setPayrollForm] = useState(() => defaultPayrollForm(state));
  const [payrollMessage, setPayrollMessage] = useState("");
  const [submittingPayroll, setSubmittingPayroll] = useState(false);
  const [requestForm, setRequestForm] = useState(() => defaultFinanceRequestForm("EXPENSE"));
  const [requestMessage, setRequestMessage] = useState("");
  const [submittingRequest, setSubmittingRequest] = useState(false);
  const updateRequestForm = (field, value) => {
    setRequestForm((current) => {
      if (field === "type") return defaultFinanceRequestForm(value);
      return { ...current, [field]: value };
    });
  };
  const updatePayrollForm = (field, value) => {
    setPayrollForm((current) => ({ ...current, [field]: value }));
  };
  const submitFinanceRequest = async (event) => {
    event.preventDefault();
    setSubmittingRequest(true);
    setRequestMessage("正在创建财务单据并提交审批...");
    try {
      const payload = {
        ...requestForm,
        amount: Number(requestForm.amount),
        idempotencyKey: `finance-request-ui-${requestForm.requestNo}-${Date.now()}`
      };
      const result = await actions.createFinanceRequest(payload);
      setRequestMessage(result?.alreadySubmitted ? "已识别重复提交，已返回原财务单据。" : "财务单据已创建，并进入审批链路。");
      setRequestForm(defaultFinanceRequestForm(requestForm.type));
    } catch (error) {
      setRequestMessage(error?.message || "财务单据创建失败，请检查权限、金额和流程配置。");
    } finally {
      setSubmittingRequest(false);
    }
  };
  const submitPayroll = async (event) => {
    event.preventDefault();
    setSubmittingPayroll(true);
    setPayrollMessage("正在创建工资单复核流程...");
    try {
      const payload = {
        ...payrollForm,
        headcount: Number(payrollForm.headcount),
        totalAmount: Number(payrollForm.totalAmount),
        idempotencyKey: `payroll-ui-${payrollForm.batchNo}-${Date.now()}`
      };
      const result = await actions.createPayroll(payload);
      setPayrollMessage(result?.alreadySubmitted ? "已识别重复提交，已返回原工资单流程。" : "工资单已创建，并进入审批链路。");
      setPayrollForm(defaultPayrollForm(state));
    } catch (error) {
      setPayrollMessage(error?.message || "工资单创建失败，请检查权限、流程配置和批次号。");
    } finally {
      setSubmittingPayroll(false);
    }
  };
  const columns = [
    { key: "title", label: "审批标题" },
    { key: "applicant", label: "申请人" },
    { key: "amount", label: "金额" },
    { key: "node", label: "当前节点" },
    { key: "status", label: "状态", render: (row) => <StatusPill value={row.status} /> }
  ];
  const requestColumns = [
    { key: "id", label: "单据编号" },
    { key: "typeLabel", label: "类型" },
    { key: "title", label: "标题" },
    { key: "department", label: "部门" },
    { key: "amount", label: "金额", render: (row) => `¥${Number(row.amount || 0).toLocaleString("zh-CN")}` },
    { key: "vendor", label: "收款方/商户" },
    { key: "status", label: "状态", render: (row) => <StatusPill value={row.status} /> }
  ];
  const payrollColumns = [
    { key: "cycle", label: "工资周期" },
    { key: "scope", label: "人员范围" },
    { key: "owner", label: "负责人" },
    {
      key: "workflowStatus",
      label: "审批链路",
      render: (row) => row.workflowInstanceId
        ? <StatusPill value={row.workflowStatus === "APPROVED" || row.workflowStatus === "已通过" ? "已通过" : "待审批"} />
        : <span className="muted">未绑定</span>
    },
    { key: "status", label: "状态", render: (row) => <StatusPill value={row.status} /> },
    { key: "action", label: "操作", render: (row) => <button type="button" onClick={() => actions.reviewPayroll(row.id)}>复核发布</button> }
  ];

  return (
    <div className="module-layout">
      <section className="module-title">
        <div>
          <h1>财务行政</h1>
          <p>付款申请、费用报销、工资单核算与发布，连接审批流和审计日志。</p>
        </div>
        <button className="primary" type="button" onClick={() => onOpenFlow(expenseTemplate)}>新建报销</button>
      </section>
      <section className="kpi-strip">
        <MetricCard label="财务单据" value={`${state.financeRequests?.length || 0} 单`} />
        <MetricCard label="待复核" tone="orange" value={`${financeFlows.filter((item) => item.status.includes("待")).length} 单`} />
        <MetricCard label="工资单" value={`${state.payrolls.length} 批`} />
        <MetricCard label="本月行政费用" value="¥42,680" />
      </section>
      <Panel title="付款与报销流程" actions={(
        <>
          <button type="button" onClick={() => actions.exportFinanceRequests({ scope: "财务单据台账" })}>导出财务单据</button>
          <button type="button" onClick={() => onOpenFlow(paymentTemplate)}>付款申请</button>
        </>
      )}>
        <form className="payroll-form" onSubmit={submitFinanceRequest}>
          <label>单据类型
            <select value={requestForm.type} onChange={(event) => updateRequestForm("type", event.target.value)}>
              <option value="EXPENSE">费用报销</option>
              <option value="PAYMENT">付款申请</option>
            </select>
          </label>
          <label>单据编号
            <input value={requestForm.requestNo} onChange={(event) => updateRequestForm("requestNo", event.target.value)} />
          </label>
          <label>标题
            <input value={requestForm.title} onChange={(event) => updateRequestForm("title", event.target.value)} />
          </label>
          <label>部门
            <input value={requestForm.department} onChange={(event) => updateRequestForm("department", event.target.value)} />
          </label>
          <label>金额
            <input min="0.01" step="0.01" type="number" value={requestForm.amount} onChange={(event) => updateRequestForm("amount", event.target.value)} />
          </label>
          <label>收款方/商户
            <input value={requestForm.vendor} onChange={(event) => updateRequestForm("vendor", event.target.value)} />
          </label>
          <label>支付方式
            <input value={requestForm.paymentMethod} onChange={(event) => updateRequestForm("paymentMethod", event.target.value)} />
          </label>
          <label>事由
            <input value={requestForm.purpose} onChange={(event) => updateRequestForm("purpose", event.target.value)} />
          </label>
          <button className="primary" disabled={submittingRequest} type="submit">提交财务单据</button>
          <p>{requestMessage || "付款和报销会生成财务单据、审批实例与审计日志。"}</p>
        </form>
        <DataTable columns={requestColumns} rows={state.financeRequests || []} />
        <div className="detail-subhead">审批流转记录</div>
        <DataTable columns={columns} rows={financeFlows} />
      </Panel>
      <Panel title="工资单流程" actions={<span className="soft-text">创建后需审批全通过才可发布</span>}>
        <form className="payroll-form" onSubmit={submitPayroll}>
          <label>批次号
            <input value={payrollForm.batchNo} onChange={(event) => updatePayrollForm("batchNo", event.target.value)} />
          </label>
          <label>工资周期
            <input value={payrollForm.cycle} onChange={(event) => updatePayrollForm("cycle", event.target.value)} />
          </label>
          <label>人员范围
            <input value={payrollForm.scope} onChange={(event) => updatePayrollForm("scope", event.target.value)} />
          </label>
          <label>发薪人数
            <input min="1" type="number" value={payrollForm.headcount} onChange={(event) => updatePayrollForm("headcount", event.target.value)} />
          </label>
          <label>工资总额
            <input min="0.01" step="0.01" type="number" value={payrollForm.totalAmount} onChange={(event) => updatePayrollForm("totalAmount", event.target.value)} />
          </label>
          <label>备注
            <input value={payrollForm.comment} onChange={(event) => updatePayrollForm("comment", event.target.value)} />
          </label>
          <button className="primary" disabled={submittingPayroll} type="submit">创建工资单</button>
          <p>{payrollMessage || "工资单会自动生成复核审批流，并记录审计日志。"}</p>
        </form>
        <DataTable columns={payrollColumns} rows={state.payrolls} />
      </Panel>
    </div>
  );
}
