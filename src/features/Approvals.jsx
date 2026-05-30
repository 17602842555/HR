import React, { useEffect, useMemo, useState } from "react";
import { Clock3, GitBranch, MessageSquareText, SendHorizontal } from "lucide-react";
import { DataTable, MetricCard, Panel, StatusPill } from "../components/Primitives.jsx";
import { flowTemplates } from "../data/seed.js";

const approvalTabs = [
  { id: "todo", label: "待我审批" },
  { id: "mine", label: "我发起的" },
  { id: "done", label: "已完成" },
  { id: "all", label: "全部" }
];

function visibleRows(rows, tab, currentUserName = "张三") {
  if (tab === "todo") return rows.filter((item) => item.status.includes("待") || item.status.includes("超时") || item.status.includes("付款"));
  if (tab === "mine") return rows.filter((item) => item.applicant === currentUserName);
  if (tab === "done") return rows.filter((item) => ["已通过", "已驳回", "已撤回"].includes(item.status));
  return rows;
}

function TemplateCenter({ onOpenFlow, templates }) {
  return (
    <div className="template-grid">
      {templates.map((template) => (
        <button key={template.id} type="button" onClick={() => onOpenFlow(template)}>
          <span>{template.category}</span>
          <strong>{template.name}</strong>
          <em>{template.fields.length} 个控件 · {template.approvalMode}</em>
        </button>
      ))}
    </div>
  );
}

function cloneRule(rule) {
  return JSON.parse(JSON.stringify(rule));
}

function fallbackApprovers(template, department, nodeName, index) {
  const departmentOwner = `${department}负责人`;
  if (index === 0) return [departmentOwner, "张三"];
  if (template.category === "财务行政") return nodeName.includes("付款") ? ["出纳", "财务负责人"] : ["财务负责人", "财务专员"];
  if (template.category === "组织人事") return ["人事负责人", "HRBP"];
  if (template.category === "行政资产") return ["行政资产管理员", departmentOwner];
  if (template.category === "假勤") return ["人事专员", departmentOwner];
  return [departmentOwner];
}

function buildDefaultRule(department, template) {
  return {
    id: "",
    department,
    templateId: template.id,
    templateName: template.name,
    enabled: true,
    nodes: (template.nodes || [])
      .filter((node) => !node.includes("申请人提交") && !node.includes("归档"))
      .map((node, index) => ({
        id: `${template.id}-${index + 1}`,
        name: node,
        mode: "AND",
        approvers: fallbackApprovers(template, department, node, index)
      }))
  };
}

function validateRule(rule) {
  if (!rule?.department || !rule?.templateId) return ["请选择部门和流程"];
  if (!rule.nodes?.length) return ["至少保留一个审批节点"];
  return rule.nodes.flatMap((node, index) => {
    const errors = [];
    if (!node.name?.trim()) errors.push(`节点 ${index + 1} 缺少名称`);
    if (!node.approvers?.length) errors.push(`节点 ${index + 1} 缺少审批人`);
    return errors;
  });
}

function configuredState(rules, department, templateId) {
  const rule = rules.find((item) => item.department === department && item.templateId === templateId);
  if (!rule) return "待配置";
  return rule.enabled === false ? "已停用" : "已配置";
}

function coverageState(coverageRows, rules, department, templateId) {
  const coverage = coverageRows.find((item) => item.department === department && item.templateId === templateId);
  if (!coverage) return configuredState(rules, department, templateId);
  if (coverage.disabledRuleId && coverage.source !== "department_rule") return "已停用";
  if (coverage.status === "needs_binding") return "需绑定";
  if (coverage.source === "department_rule") return "已配置";
  return "默认流程";
}

function approverBindingText(node) {
  const total = node?.approvers?.length || 0;
  const bound = (node?.approverUsers || []).filter((item) => item.userId).length;
  if (!total) return "未选择审批人";
  return `实名账号 ${bound}/${total}`;
}

function ApprovalRuleEditor({ actions, state, templates }) {
  const departments = useMemo(() => [...new Set([
    ...(state.people?.departmentStats || []).map((item) => item.label),
    ...state.approvalRules.map((rule) => rule.department),
    "行政部",
    "人力资源部",
    "财务中心",
    "直播事业部",
    "采购部",
    "仓储部"
  ].filter(Boolean))], [state.approvalRules, state.people?.departmentStats]);
  const [department, setDepartment] = useState(departments[0] || "行政部");
  const [templateId, setTemplateId] = useState("expense");
  const [rulePreview, setRulePreview] = useState(null);
  const [previewStatus, setPreviewStatus] = useState("");
  const templateOptions = templates?.length ? templates : flowTemplates;
  const coverageRows = state.approvalRuleCoverage?.rows || [];
  const coverageSummary = state.approvalRuleCoverage?.summary || null;
  const template = templateOptions.find((item) => item.id === templateId) || templateOptions[0] || flowTemplates[0];
  const activeRule = useMemo(() => (
    state.approvalRules.find((rule) => rule.department === department && rule.templateId === templateId)
    || buildDefaultRule(department, template)
  ), [department, state.approvalRules, template, templateId]);
  const [draft, setDraft] = useState(() => cloneRule(activeRule));
  const errors = validateRule(draft);

  useEffect(() => {
    setDraft(cloneRule(activeRule));
    setRulePreview(null);
    setPreviewStatus("");
  }, [activeRule]);

  if (!draft) return null;

  const updateNode = (nodeIndex, patch) => {
    setDraft((current) => ({
      ...current,
      nodes: current.nodes.map((node, index) => (index === nodeIndex ? { ...node, ...patch } : node))
    }));
  };

  const removeNode = (nodeIndex) => {
    setDraft((current) => ({
      ...current,
      nodes: current.nodes.filter((_, index) => index !== nodeIndex)
    }));
  };

  const moveNode = (nodeIndex, direction) => {
    setDraft((current) => {
      const targetIndex = nodeIndex + direction;
      if (targetIndex < 0 || targetIndex >= current.nodes.length) return current;
      const nodes = [...current.nodes];
      const [node] = nodes.splice(nodeIndex, 1);
      nodes.splice(targetIndex, 0, node);
      return { ...current, nodes };
    });
  };

  const saveDraft = () => {
    if (errors.length) return;
    actions.saveApprovalRule({
      ...draft,
      templateName: template.name,
      nodes: draft.nodes.map((node, index) => ({
        ...node,
        id: node.id || `${draft.templateId}-${index + 1}`,
        mode: "AND"
      }))
    });
  };

  const resetDraft = () => {
    setDraft(cloneRule(buildDefaultRule(department, template)));
  };

  const deleteDraft = () => {
    if (!draft.id) {
      resetDraft();
      return;
    }
    actions.deleteApprovalRule?.(draft.id);
    resetDraft();
  };

  const previewRule = async () => {
    setPreviewStatus("正在校验");
    try {
      const result = await actions.previewApprovalRule?.({
        department,
        definitionId: template.id,
        templateId: template.id
      });
      const preview = result?.preview || result || null;
      setRulePreview(preview);
      setPreviewStatus(preview?.source === "department_rule" ? "后端确认：部门规则" : "后端确认：默认流程");
    } catch (error) {
      setPreviewStatus(error?.message || "预览失败");
      setRulePreview(null);
    }
  };

  return (
    <div className="rule-editor">
      <div className="rule-editor-head">
        <label>部门
          <select value={department} onChange={(event) => setDepartment(event.target.value)}>
            {departments.map((item) => <option key={item}>{item}</option>)}
          </select>
        </label>
        <label>流程
          <select value={templateId} onChange={(event) => setTemplateId(event.target.value)}>
              {templateOptions.map((template) => <option key={template.id} value={template.id}>{template.name}</option>)}
          </select>
        </label>
        <label>状态
          <select value={draft.enabled === false ? "disabled" : "enabled"} onChange={(event) => setDraft((current) => ({ ...current, enabled: event.target.value === "enabled" }))}>
            <option value="enabled">启用</option>
            <option value="disabled">停用</option>
          </select>
        </label>
        <button className="primary" disabled={errors.length > 0} type="button" onClick={saveDraft}>保存配置</button>
      </div>

      <div className="rule-editor-actions">
        <button type="button" onClick={resetDraft}>恢复默认节点</button>
        <button type="button" onClick={previewRule}>后端预览</button>
        <button className="danger" type="button" disabled={!draft.id} onClick={deleteDraft}>删除配置</button>
        <span>{draft.id ? "当前为已保存规则" : "当前为默认规则草案，保存后对新审批生效"}</span>
      </div>

      {coverageSummary ? (
        <div className="rule-editor-notice">
          <strong>后端覆盖矩阵</strong>
          <span>
            {coverageSummary.departmentCount} 个部门 · {coverageSummary.templateCount} 类流程 ·
            已配置 {coverageSummary.configuredCount}/{coverageSummary.totalCells} ·
            默认流程 {coverageSummary.fallbackCount} ·
            待实名绑定 {coverageSummary.needsBindingCount}
          </span>
        </div>
      ) : null}

      <div className="rule-matrix">
        {departments.map((dept) => (
          <div className="rule-matrix-row" key={dept}>
            <strong>{dept}</strong>
            <div>
              {templateOptions.map((item) => {
                const status = coverageState(coverageRows, state.approvalRules, dept, item.id);
                const active = dept === department && item.id === templateId;
                return (
                  <button
                    className={active ? "active" : ""}
                    key={`${dept}-${item.id}`}
                    type="button"
                    onClick={() => {
                      setDepartment(dept);
                      setTemplateId(item.id);
                    }}
                  >
                    {item.name}
                    <em>{status}</em>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      <div className="rule-editor-notice">
        <strong>{draft.department} · {draft.templateName}</strong>
        <span>每个节点固定为会签，同节点审批人全部同意后才进入下一流程。新发起的审批会保存当前规则快照，后续改规则不影响已提交流程。</span>
        {errors.length ? <em>{errors.join("；")}</em> : null}
      </div>

      <div className="rule-flow-preview">
        <span>申请人提交</span>
        {draft.nodes.map((node, index) => (
          <React.Fragment key={`${node.id || node.name}-${index}`}>
            <i>→</i>
            <span>{node.name || `节点 ${index + 1}`} · {node.approvers.length} 人会签</span>
          </React.Fragment>
        ))}
        <i>→</i>
        <span>归档与通知</span>
      </div>

      {previewStatus ? (
        <div className="rule-server-preview" aria-live="polite">
          <strong>{previewStatus}</strong>
          {rulePreview ? (
            <>
              <span>{rulePreview.templateName} · {rulePreview.department} · {rulePreview.nodeCount} 个节点</span>
              <em>{rulePreview.approverChain}</em>
              <small>
                实名账号 {rulePreview.resolvedApproverCount || 0}/{rulePreview.totalApproverCount || 0}
                {(rulePreview.unresolvedApprovers || []).length ? ` · 未绑定：${rulePreview.unresolvedApprovers.join("、")}` : ""}
              </small>
            </>
          ) : null}
        </div>
      ) : null}

      <div className="rule-node-list">
        {draft.nodes.map((node, index) => (
          <div className="rule-node-card" key={node.id || index}>
            <div className="rule-node-card-head">
              <span>节点 {index + 1} · 会签</span>
              <div className="rule-node-actions">
                <button type="button" disabled={index === 0} onClick={() => moveNode(index, -1)}>上移</button>
                <button type="button" disabled={index === draft.nodes.length - 1} onClick={() => moveNode(index, 1)}>下移</button>
                <button type="button" onClick={() => removeNode(index)}>删除</button>
              </div>
            </div>
            <label>节点名称
              <input value={node.name} onChange={(event) => updateNode(index, { name: event.target.value })} />
            </label>
            <label>审批人，逗号分隔
              <input
                value={node.approvers.join("，")}
                onChange={(event) => updateNode(index, {
                  approvers: event.target.value.split(/[，,]/).map((item) => item.trim()).filter(Boolean),
                  approverUsers: []
                })}
              />
            </label>
            <em>必须 {node.approvers.length} 人全部同意后才进入下一节点 · {approverBindingText(node)}</em>
          </div>
        ))}
      </div>
      <button type="button" onClick={() => setDraft((current) => ({
        ...current,
        nodes: [
          ...current.nodes,
          { id: `${current.templateId}-${Date.now()}`, name: "新增会签节点", mode: "AND", approvers: [`${current.department}负责人`, "审批人B"] }
        ]
      }))}>新增会签节点</button>
    </div>
  );
}

function ApprovalDetail({ actions, approval }) {
  const [comment, setComment] = useState("");
  const [transferTarget, setTransferTarget] = useState("财务负责人");
  if (!approval) return <p className="empty">暂无审批</p>;
  const formRows = (approval.fields || []).map((field) => ({
    id: field.id,
    label: field.label,
    value: approval.formData?.[field.id] || field.value || "-"
  }));
  const currentStep = Number.isFinite(approval.currentNodeIndex) ? approval.currentNodeIndex : 0;
  const currentNode = approval.approvalNodes?.[currentStep];
  const pendingApprovers = (currentNode?.decisions || []).filter((item) => item.status === "待审批");

  return (
    <div className="approval-detail">
      <div className="approval-title-block">
        <div>
          <span>{approval.definitionCode}</span>
          <h3>{approval.title}</h3>
          <p>{approval.reason || approval.condition}</p>
        </div>
        <StatusPill value={approval.status} />
      </div>

      <dl className="detail-grid">
        <div><dt>申请人</dt><dd>{approval.applicant}</dd></div>
        <div><dt>所属部门</dt><dd>{approval.department}</dd></div>
        <div><dt>当前节点</dt><dd>{approval.node}</dd></div>
        <div><dt>SLA</dt><dd>{approval.sla}</dd></div>
        <div><dt>金额/事项</dt><dd>{approval.amount}</dd></div>
        <div><dt>到期时间</dt><dd>{approval.dueAt}</dd></div>
      </dl>

      <div className="detail-subhead"><GitBranch size={16} /> 审批流转</div>
      <div className="flow-steps rich">
        {(approval.approvalNodes || []).map((node, index) => {
          const pendingCount = node.decisions.filter((item) => item.status === "待审批").length;
          const approvedCount = node.decisions.filter((item) => item.status === "已同意").length;
          const finished = node.decisions.length > 0 && pendingCount === 0 && (index < currentStep || approval.status !== "待审批");
          const active = index === currentStep && approval.status === "待审批";
          return (
          <div className={finished ? "done" : active ? "current" : ""} key={`${approval.id}-${node.id}`}>
            <i>{index + 1}</i>
            <span>{node.name}</span>
            <em>{finished ? "已完成" : active ? `${approvedCount}/${node.decisions.length} 已同意` : "等待"}</em>
          </div>
          );
        })}
      </div>

      <div className="detail-subhead">当前会签要求</div>
      <div className="approver-grid">
        {(currentNode?.decisions || []).map((decision) => (
          <div className={decision.status === "已同意" ? "approved" : ""} key={`${currentNode.id}-${decision.approver}`}>
            <strong>{decision.approver}</strong>
            <StatusPill value={decision.status} />
            <span>{decision.time || "等待处理"}</span>
            {decision.status === "待审批" && approval.status === "待审批" ? (
              <button type="button" onClick={() => actions.decideApproval(approval.id, "pass", decision.approver)}>同意：{decision.approver}</button>
            ) : null}
          </div>
        ))}
      </div>
      <p className="rule-hint">
        {pendingApprovers.length
          ? `当前节点还需 ${pendingApprovers.map((item) => item.approver).join("、")} 同意，系统不会进入下一流程。`
          : "当前节点已全部同意，系统会自动进入下一流程。"}
      </p>

      <div className="detail-subhead"><Clock3 size={16} /> 表单数据</div>
      <div className="field-preview">
        {formRows.map((row) => (
          <div key={row.id}><span>{row.label}</span><strong>{row.value}</strong></div>
        ))}
      </div>

      <div className="detail-subhead"><Clock3 size={16} /> 流转记录</div>
      <ul className="timeline-list">
        {(approval.timeline || []).map((item) => (
          <li key={item.id}>
            <i />
            <div><strong>{item.action}</strong><span>{item.actor} · {item.node}</span><em>{item.time}</em></div>
          </li>
        ))}
      </ul>

      <div className="detail-subhead"><MessageSquareText size={16} /> 评论与协作</div>
      <div className="comment-box">
        <input value={comment} placeholder="添加审批意见、补充说明或@协作者" onChange={(event) => setComment(event.target.value)} />
        <button type="button" onClick={() => {
          actions.addApprovalComment(approval.id, comment);
          setComment("");
        }}><SendHorizontal size={15} /> 发送</button>
      </div>
      <ul className="comment-list">
        {(approval.comments || []).map((item) => (
          <li key={item.id}><strong>{item.author}</strong><span>{item.content}</span><em>{item.time}</em></li>
        ))}
        {(approval.comments || []).length === 0 ? <li><span>暂无评论</span></li> : null}
      </ul>

      <div className="action-row">
        <button type="button" onClick={() => actions.withdrawApproval(approval.id)}>撤回</button>
        <input
          aria-label="转交审批人"
          value={transferTarget}
          placeholder="转交审批人"
          onChange={(event) => setTransferTarget(event.target.value)}
        />
        <button
          type="button"
          onClick={() => actions.transferApproval(approval.id, transferTarget || "财务负责人", pendingApprovers[0]?.approver)}
        >
          转交
        </button>
        <button type="button" onClick={() => actions.decideApproval(approval.id, "reject", pendingApprovers[0]?.approver || "张三")}>驳回</button>
        <button className="primary" type="button" onClick={() => actions.decideApproval(approval.id, "pass", pendingApprovers[0]?.approver || "张三")}>同意下一个待处理人</button>
      </div>
    </div>
  );
}

export function Approvals({ actions, currentUser, onOpenFlow, state, workflowTemplates }) {
  const templateOptions = workflowTemplates?.length ? workflowTemplates : flowTemplates;
  const [selected, setSelected] = useState(state.approvals[0]?.id || "");
  const [tab, setTab] = useState("todo");
  const currentUserName = currentUser?.name || "张三";
  const rows = useMemo(() => visibleRows(state.approvals, tab, currentUserName), [currentUserName, state.approvals, tab]);
  const current = state.approvals.find((item) => item.id === selected) || rows[0] || state.approvals[0];
  const definitionCount = templateOptions.length;
  const columns = [
    { key: "title", label: "流程名称" },
    { key: "applicant", label: "申请人" },
    { key: "category", label: "分类" },
    { key: "node", label: "当前节点" },
    { key: "submittedAt", label: "提交时间" },
    { key: "dueAt", label: "到期" },
    { key: "status", label: "状态", render: (row) => <StatusPill value={row.status} /> },
    { key: "action", label: "操作", render: (row) => <button type="button" onClick={() => setSelected(row.id)}>打开</button> }
  ];

  return (
    <div className="module-layout">
      <section className="module-title">
        <div>
          <h1>OA审批</h1>
          <p>按审批定义、表单控件、流程节点、任务流转和审批动态组织，支持部门会签规则、规则快照和审计留痕。</p>
        </div>
        <button className="primary" type="button" onClick={onOpenFlow}>发起申请</button>
      </section>

      <section className="kpi-strip">
        <MetricCard label="全部流程" value={`${state.approvals.length} 项`} />
        <MetricCard label="待处理" tone="orange" value={`${state.approvals.filter((item) => item.status.includes("待") || item.status.includes("付款")).length} 项`} />
        <MetricCard label="超时风险" tone="red" value={`${state.approvals.filter((item) => item.status.includes("超时")).length} 项`} />
        <MetricCard label="审批定义" value={`${definitionCount} 个`} />
      </section>

      <Panel title="发起中心" actions={<button type="button" onClick={() => actions.exportApprovals({ scope: "审批列表" })}>导出审批</button>}>
        <TemplateCenter onOpenFlow={onOpenFlow} templates={templateOptions} />
      </Panel>

      <Panel title="部门审批流程管理" actions={<span className="soft-text">会签模式：同节点所有人同意后才进入下一流程</span>}>
        <ApprovalRuleEditor actions={actions} state={state} templates={templateOptions} />
      </Panel>

      <div className="split-view approval-workspace">
        <Panel title="审批任务">
          <div className="panel-toolbar">
            <div className="tabs compact">
              {approvalTabs.map((item) => (
                <button className={tab === item.id ? "active" : ""} key={item.id} type="button" onClick={() => setTab(item.id)}>{item.label}</button>
              ))}
            </div>
          </div>
          <DataTable columns={columns} rows={rows} />
        </Panel>
        <Panel title="审批详情">
          <ApprovalDetail actions={actions} approval={current} />
        </Panel>
      </div>
    </div>
  );
}
