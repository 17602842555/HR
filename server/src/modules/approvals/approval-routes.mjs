import { appendAuditLog, recordExportEvent, requestAuditMeta, requireExportBusinessReason } from "../audit/audit-service.mjs";
import { requirePermission } from "../iam/route-guards.mjs";
import {
  approvalRuleBindingError,
  approverResolutionSummary,
  approverUserIdForName,
  enrichRuleNodesFromPrisma,
  loadApproverUserMap
} from "../workflow/approver-resolution.mjs";

const templateMeta = {
  "FIN-EXPENSE": { templateId: "expense", sla: "24h", owner: "张三", amountField: "amount" },
  "FIN-PAYMENT": { templateId: "payment", sla: "48h", owner: "王五", amountField: "amount" },
  "FIN-PAYROLL": { templateId: "payroll", sla: "24h", owner: "财务中心", amountField: "headcount" },
  "HR-RECRUIT": { templateId: "recruit", sla: "72h", owner: "李四", amountField: "headcount" },
  "HR-SALARY": { templateId: "salary", sla: "72h", owner: "周八", amountField: "adjustAmount" },
  "HR-ONBOARD": { templateId: "onboarding", sla: "48h", owner: "李四", amountField: "employee" },
  "HR-REGULAR": { templateId: "regularization", sla: "48h", owner: "李四", amountField: "employee" },
  "HR-TRANSFER": { templateId: "transfer", sla: "72h", owner: "李四", amountField: "employee" },
  "HR-OFFBOARD": { templateId: "offboarding", sla: "72h", owner: "李四", amountField: "employee" },
  "HR-EXCEPTION": { templateId: "exception", sla: "24h", owner: "张三", amountField: "employee" },
  "ATT-LEAVE": { templateId: "leave", sla: "24h", owner: "赵六", amountField: "days" },
  "ADM-ITEM": { templateId: "item", sla: "24h", owner: "张三", amountField: "itemName" },
  "OPS-REPORT": { templateId: "weekly_report", sla: "24h", owner: "张三", amountField: "period" },
  "CRM-SERVICE": { templateId: "client_request", sla: "24h", owner: "王五", amountField: "clientName" },
  "CULTURE-EVENT": { templateId: "culture_event", sla: "48h", owner: "李四", amountField: "budget" },
  "TRAIN-REQUEST": { templateId: "training_request", sla: "48h", owner: "李四", amountField: "cost" }
};

const codeByTemplate = Object.fromEntries(
  Object.entries(templateMeta).map(([code, meta]) => [meta.templateId, code])
);

const exportColumns = Object.freeze([
  ["id", "审批编号"],
  ["title", "流程名称"],
  ["applicant", "申请人"],
  ["department", "部门"],
  ["category", "分类"],
  ["node", "当前节点"],
  ["status", "状态"],
  ["amount", "金额/数量"],
  ["submittedAt", "提交时间"],
  ["dueAt", "到期时间"]
]);

function formatDateTime(value) {
  if (!value) return "";
  return new Date(value).toLocaleString("sv-SE", { hour12: false }).replace("T", " ").slice(0, 16);
}

function timestampToken() {
  return new Date().toISOString().replaceAll(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function csvCell(value) {
  const text = value === null || value === undefined ? "" : String(value);
  const safeText = /^[\s]*[=+\-@]/.test(text) ? `'${text}` : text;
  return `"${safeText.replaceAll("\"", "\"\"").replace(/\r?\n/g, " ")}"`;
}

function toCsv(rows) {
  const headers = exportColumns.map(([, label]) => label);
  const lines = [
    headers.map(csvCell).join(","),
    ...rows.map((row) => exportColumns.map(([key]) => csvCell(row[key])).join(","))
  ];
  return `\uFEFF${lines.join("\n")}\n`;
}

function replyCsv(reply, csv, filename, rowCount) {
  return reply
    .header("Content-Type", "text/csv; charset=utf-8")
    .header("Content-Disposition", `attachment; filename="${filename}"`)
    .header("X-Row-Count", String(rowCount))
    .header("Cache-Control", "no-store")
    .send(csv);
}

function normalizeExportFilters(input = {}) {
  const filters = {};
  ["status", "category", "keyword", "templateId", "definitionCode", "scope"].forEach((key) => {
    const value = input[key];
    if (typeof value === "string" && value.trim()) filters[key] = value.trim();
  });
  return filters;
}

function matchesExportFilters(row, filters = {}) {
  if (filters.status && row.status !== filters.status) return false;
  if (filters.category && row.category !== filters.category) return false;
  if (filters.templateId && row.definitionId !== filters.templateId) return false;
  if (filters.definitionCode && row.definitionCode !== filters.definitionCode) return false;
  if (filters.keyword) {
    const haystack = [
      row.id,
      row.title,
      row.applicant,
      row.department,
      row.category,
      row.node,
      row.status
    ].join(" ");
    if (!haystack.includes(filters.keyword)) return false;
  }
  return true;
}

function statusLabel(status) {
  return {
    PENDING: "待审批",
    APPROVED: "已通过",
    REJECTED: "已驳回",
    WITHDRAWN: "已撤回",
    CANCELLED: "已取消",
    DRAFT: "草稿"
  }[status] || status;
}

function decisionLabel(status) {
  return {
    PENDING: "待审批",
    APPROVED: "已同意",
    REJECTED: "已驳回",
    TRANSFERRED: "已转交"
  }[status] || status;
}

function amountLabel(definitionCode, formData = {}) {
  const field = templateMeta[definitionCode]?.amountField || "amount";
  const value = formData[field] ?? "";
  if (["amount", "adjustAmount", "budget", "cost"].includes(field)) {
    return `¥${Number(value || 0).toLocaleString("zh-CN")}`;
  }
  return String(value || "-");
}

function activeNodeIndex(nodes, currentNodeId, workflowStatus) {
  if (!nodes.length) return 0;
  if (workflowStatus === "APPROVED") return nodes.length - 1;
  const byCurrent = nodes.findIndex((node) => node.id === currentNodeId);
  if (byCurrent >= 0) return byCurrent;
  const active = nodes.findIndex((node) => node.status === "ACTIVE");
  return active >= 0 ? active : 0;
}

function serializeApproval(instance, lookups = {}) {
  const nodes = [...(instance.nodes || [])].sort((a, b) => a.stepOrder - b.stepOrder);
  const index = activeNodeIndex(nodes, instance.currentNodeId, instance.status);
  const currentNode = nodes[index];
  const definition = instance.definition || {};
  const meta = templateMeta[instance.definitionCode] || {};
  const applicant = lookups.users?.get(instance.applicantUserId)?.name || instance.formData?.applicant || meta.owner || "张三";
  const department = lookups.departments?.get(instance.departmentId)?.name || instance.formData?.department || "行政部";
  const approvalNodes = nodes.map((node) => ({
    id: node.id,
    name: node.name,
    mode: node.approvalMode || "AND",
    approvers: (node.approvers || []).map((item) => item.approverName),
    decisions: (node.approvers || []).map((item) => ({
      approver: item.approverName,
      status: decisionLabel(item.status),
      time: formatDateTime(item.decidedAt),
      comment: item.comment || ""
    }))
  }));
  const comments = Array.isArray(instance.formData?.comments) ? instance.formData.comments : [];
  const timeline = [
    {
      id: `${instance.id}-submitted`,
      time: formatDateTime(instance.submittedAt || instance.createdAt),
      actor: applicant,
      action: "提交申请",
      node: "申请人提交"
    },
    ...approvalNodes.flatMap((node) => node.decisions
      .filter((decision) => decision.status !== "待审批")
      .map((decision) => ({
        id: `${instance.id}-${node.id}-${decision.approver}`,
        time: decision.time,
        actor: decision.approver,
        action: decision.status === "已同意" ? "同意审批" : decision.status,
        node: node.name
      })))
  ];

  return {
    id: instance.id,
    definitionId: meta.templateId || instance.definitionCode,
    definitionCode: instance.definitionCode,
    title: instance.title,
    applicant,
    department,
    category: definition.category || "OA审批",
    node: currentNode?.name || (instance.status === "APPROVED" ? "归档与通知" : "待分配"),
    status: statusLabel(instance.status),
    formData: instance.formData || {},
    amount: amountLabel(instance.definitionCode, instance.formData),
    fields: definition.formSchema?.fields || [],
    currentNodeIndex: index,
    approvalNodes,
    approvers: approvalNodes[index]?.approvers || [],
    comments,
    condition: "按部门审批规则流转",
    dueAt: formatDateTime(instance.submittedAt || instance.createdAt),
    sla: meta.sla || "24h",
    submittedAt: formatDateTime(instance.submittedAt || instance.createdAt),
    steps: ["申请人提交", ...approvalNodes.map((node) => node.name), "归档与通知"],
    timeline
  };
}

function serializeWorkflowDefinition(definition) {
  const meta = templateMeta[definition.code] || {};
  const nodes = [...(definition.nodes || [])].sort((a, b) => a.stepOrder - b.stepOrder);
  return {
    id: definition.id,
    code: definition.code,
    templateId: meta.templateId || definition.code,
    name: definition.name,
    category: definition.category || "OA审批",
    version: definition.version,
    status: definition.status,
    sla: meta.sla || "24h",
    owner: meta.owner || "",
    amountField: meta.amountField || "amount",
    fields: definition.formSchema?.fields || [],
    nodes: nodes.map((node) => ({
      id: node.id,
      name: node.name,
      stepOrder: node.stepOrder,
      approvalMode: node.approvalMode || "AND",
      approvers: node.approverRule?.approvers || []
    }))
  };
}

async function approvalLookups(prisma, tenantId, instances) {
  const userIds = [...new Set(instances.map((item) => item.applicantUserId).filter(Boolean))];
  const departmentIds = [...new Set(instances.map((item) => item.departmentId).filter(Boolean))];
  const [users, departments] = await Promise.all([
    userIds.length ? prisma.user.findMany({ where: { tenantId, id: { in: userIds } } }) : [],
    departmentIds.length ? prisma.department.findMany({ where: { tenantId, id: { in: departmentIds } } }) : []
  ]);
  return {
    users: new Map(users.map((item) => [item.id, item])),
    departments: new Map(departments.map((item) => [item.id, item]))
  };
}

async function findDefinition(app, tenantId, body = {}) {
  const code = body.definitionCode
    || body.template?.serviceKey
    || codeByTemplate[body.templateId]
    || codeByTemplate[body.definitionId]
    || codeByTemplate[body.template?.id]
    || body.definitionId;
  return app.prisma.workflowDefinition.findFirst({
    where: {
      tenantId,
      status: "ACTIVE",
      OR: [
        { id: body.definitionId || "" },
        { code: code || "" }
      ]
    },
    include: { nodes: { orderBy: { stepOrder: "asc" } } }
  });
}

async function findDepartment(app, tenantId, name) {
  const existing = await app.prisma.department.findFirst({ where: { tenantId, name } });
  if (existing) return existing;
  return app.prisma.department.create({
    data: {
      tenantId,
      code: `DYN-${Date.now()}`,
      name: name || "未填写部门"
    }
  });
}

function normalizeRuleNodes(rule, definition) {
  if (rule?.nodes && Array.isArray(rule.nodes) && rule.nodes.length) return rule.nodes;
  return (definition.nodes || [])
    .filter((node) => !node.name.includes("归档"))
    .map((node, index) => ({
      id: `${definition.code}-${index + 1}`,
      name: node.name,
      mode: node.approvalMode || "AND",
      approvers: node.approverRule?.approvers || ["系统管理员"]
    }));
}

async function appendWorkflowAudit(prisma, request, payload) {
  return appendAuditLog(prisma, {
    tenantId: request.user.tenantId,
    actorUserId: request.user.sub,
    ...payload,
    ...requestAuditMeta(request)
  });
}

function appendLifecycleHistory(sensitiveInfo = {}, event = {}) {
  const current = Array.isArray(sensitiveInfo.lifecycleHistory) ? sensitiveInfo.lifecycleHistory : [];
  return [event, ...current].slice(0, 20);
}

function trimField(source = {}, ...keys) {
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined && value !== null && String(value).trim()) return String(value).trim();
  }
  return "";
}

function parseBusinessDate(value) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

async function findOrCreateLifecycleDepartment(tx, tenantId, name) {
  const departmentName = String(name || "未分配部门").trim() || "未分配部门";
  const existing = await tx.department.findFirst({ where: { tenantId, name: departmentName } });
  if (existing) return existing;
  return tx.department.create({
    data: {
      tenantId,
      code: `LIFE-${Date.now()}`,
      name: departmentName
    }
  });
}

async function workflowDepartmentName(tx, instance) {
  if (!instance?.departmentId) return "";
  const department = await tx.department.findFirst({
    where: { tenantId: instance.tenantId, id: instance.departmentId }
  });
  return department?.name || "";
}

async function findLifecycleEmployee(tx, tenantId, employeeName) {
  const name = String(employeeName || "").trim();
  if (!name) return null;
  return tx.employee.findFirst({ where: { tenantId, name }, include: { department: true } });
}

async function nextLifecycleEmployeeNo(tx, tenantId) {
  const year = new Date().getFullYear();
  const prefix = `EMP-${year}-`;
  const count = await tx.employee.count({
    where: {
      tenantId,
      employeeNo: { startsWith: prefix }
    }
  });
  return `${prefix}${String(count + 1).padStart(5, "0")}`;
}

async function applyHrLifecycleEffect(tx, request, instance) {
  const formData = instance?.formData || {};
  const tenantId = instance.tenantId;
  const workflowDepartment = await workflowDepartmentName(tx, instance);
  const employeeName = trimField(formData, "employee", "employeeName", "name");
  const effectiveDate = trimField(formData, "effectiveDate", "entryDate", "leaveDate", "discoveredAt") || new Date().toISOString().slice(0, 10);
  const lifecycleEvent = {
    definitionCode: instance.definitionCode,
    workflowInstanceId: instance.id,
    approvedAt: new Date().toISOString(),
    effectiveDate
  };

  if (instance.definitionCode === "HR-ONBOARD") {
    if (!employeeName) return null;
    const department = await findOrCreateLifecycleDepartment(tx, tenantId, trimField(formData, "department", "toDepartment") || workflowDepartment);
    const existing = await findLifecycleEmployee(tx, tenantId, employeeName);
    const sensitiveInfo = existing?.sensitiveInfo || {};
    const data = {
      departmentId: department.id,
      roleTitle: trimField(formData, "position", "role", "roleTitle") || existing?.roleTitle || null,
      status: "ACTIVE",
      entryDate: parseBusinessDate(formData.entryDate),
      leaveDate: null,
      sensitiveInfo: {
        ...sensitiveInfo,
        probationMonths: trimField(formData, "probationMonths"),
        equipmentNeed: trimField(formData, "equipmentNeed"),
        lifecycleHistory: appendLifecycleHistory(sensitiveInfo, {
          ...lifecycleEvent,
          action: existing ? "onboard_update" : "onboard_create",
          department: department.name
        })
      }
    };
    const employee = existing
      ? await tx.employee.update({ where: { id: existing.id }, data })
      : await tx.employee.create({
          data: {
            tenantId,
            employeeNo: await nextLifecycleEmployeeNo(tx, tenantId),
            name: employeeName,
            gender: trimField(formData, "gender") || null,
            ...data
          }
        });
    await appendWorkflowAudit(tx, request, {
      action: "employee.lifecycle.onboard",
      objectType: "employee",
      objectId: employee.id,
      summary: `${employee.name} 入职审批通过，已写入员工档案`,
      metadata: {
        workflowInstanceId: instance.id,
        employeeNo: employee.employeeNo,
        department: department.name,
        result: "成功"
      }
    });
    return employee;
  }

  const employee = await findLifecycleEmployee(tx, tenantId, employeeName);
  if (!employee) {
    if (["HR-REGULAR", "HR-TRANSFER", "HR-OFFBOARD", "HR-EXCEPTION", "HR-SALARY"].includes(instance.definitionCode)) {
      await appendWorkflowAudit(tx, request, {
        action: "employee.lifecycle.sync.skipped",
        objectType: "employee",
        summary: `${employeeName || "未填写员工"} 生命周期审批通过，但未匹配到员工档案`,
        metadata: {
          workflowInstanceId: instance.id,
          definitionCode: instance.definitionCode,
          employeeName,
          result: "跳过",
          reason: "employee_not_found"
        }
      });
    }
    return null;
  }

  const sensitiveInfo = employee.sensitiveInfo || {};
  if (instance.definitionCode === "HR-TRANSFER") {
    const department = await findOrCreateLifecycleDepartment(tx, tenantId, trimField(formData, "toDepartment", "department") || workflowDepartment || employee.department?.name);
    const updated = await tx.employee.update({
      where: { id: employee.id },
      data: {
        departmentId: department.id,
        sensitiveInfo: {
          ...sensitiveInfo,
          previousDepartment: trimField(formData, "fromDepartment") || employee.department?.name || "",
          transferEffectiveDate: effectiveDate,
          handover: trimField(formData, "handover"),
          lifecycleHistory: appendLifecycleHistory(sensitiveInfo, {
            ...lifecycleEvent,
            action: "transfer",
            fromDepartment: trimField(formData, "fromDepartment") || employee.department?.name || "",
            toDepartment: department.name
          })
        }
      }
    });
    await appendWorkflowAudit(tx, request, {
      action: "employee.lifecycle.transfer",
      objectType: "employee",
      objectId: updated.id,
      summary: `${updated.name} 调岗审批通过，已更新部门为 ${department.name}`,
      metadata: {
        workflowInstanceId: instance.id,
        employeeNo: updated.employeeNo,
        fromDepartment: trimField(formData, "fromDepartment") || employee.department?.name || "",
        toDepartment: department.name,
        result: "成功"
      }
    });
    return updated;
  }

  if (instance.definitionCode === "HR-OFFBOARD") {
    const updated = await tx.employee.update({
      where: { id: employee.id },
      data: {
        status: "LEAVED",
        leaveDate: parseBusinessDate(formData.leaveDate) || new Date(),
        sensitiveInfo: {
          ...sensitiveInfo,
          leaveReasonType: trimField(formData, "reasonType"),
          handover: trimField(formData, "handover"),
          assetReturn: trimField(formData, "assetReturn"),
          lifecycleHistory: appendLifecycleHistory(sensitiveInfo, {
            ...lifecycleEvent,
            action: "offboard",
            reasonType: trimField(formData, "reasonType")
          })
        }
      }
    });
    await appendWorkflowAudit(tx, request, {
      action: "employee.lifecycle.offboard",
      objectType: "employee",
      objectId: updated.id,
      summary: `${updated.name} 离职交接审批通过，已更新为离职`,
      metadata: {
        workflowInstanceId: instance.id,
        employeeNo: updated.employeeNo,
        leaveDate: trimField(formData, "leaveDate"),
        result: "成功"
      }
    });
    return updated;
  }

  if (instance.definitionCode === "HR-REGULAR") {
    const updated = await tx.employee.update({
      where: { id: employee.id },
      data: {
        status: "ACTIVE",
        sensitiveInfo: {
          ...sensitiveInfo,
          regularDate: effectiveDate,
          probationResult: trimField(formData, "probationResult"),
          regularizationReviewer: trimField(formData, "reviewer"),
          lifecycleHistory: appendLifecycleHistory(sensitiveInfo, {
            ...lifecycleEvent,
            action: "regularization",
            probationResult: trimField(formData, "probationResult")
          })
        }
      }
    });
    await appendWorkflowAudit(tx, request, {
      action: "employee.lifecycle.regularization",
      objectType: "employee",
      objectId: updated.id,
      summary: `${updated.name} 转正审批通过，已更新转正信息`,
      metadata: {
        workflowInstanceId: instance.id,
        employeeNo: updated.employeeNo,
        result: "成功"
      }
    });
    return updated;
  }

  if (instance.definitionCode === "HR-EXCEPTION") {
    const updated = await tx.employee.update({
      where: { id: employee.id },
      data: {
        status: "SUSPENDED",
        sensitiveInfo: {
          ...sensitiveInfo,
          exceptionType: trimField(formData, "exceptionType"),
          exceptionReason: trimField(formData, "reason", "description", "actionPlan"),
          exceptionEffectiveDate: effectiveDate,
          lifecycleHistory: appendLifecycleHistory(sensitiveInfo, {
            ...lifecycleEvent,
            action: "exception",
            exceptionType: trimField(formData, "exceptionType")
          })
        }
      }
    });
    await appendWorkflowAudit(tx, request, {
      action: "employee.lifecycle.exception",
      objectType: "employee",
      objectId: updated.id,
      summary: `${updated.name} 状态异常报备审批通过，已更新为停用`,
      metadata: {
        workflowInstanceId: instance.id,
        employeeNo: updated.employeeNo,
        result: "成功"
      }
    });
    return updated;
  }

  if (instance.definitionCode === "HR-SALARY") {
    const updated = await tx.employee.update({
      where: { id: employee.id },
      data: {
        sensitiveInfo: {
          ...sensitiveInfo,
          salaryAdjustment: {
            effectiveDate,
            reasonType: trimField(formData, "reasonType"),
            hasAmount: Boolean(trimField(formData, "adjustAmount"))
          },
          lifecycleHistory: appendLifecycleHistory(sensitiveInfo, {
            ...lifecycleEvent,
            action: "salary_adjustment",
            reasonType: trimField(formData, "reasonType")
          })
        }
      }
    });
    await appendWorkflowAudit(tx, request, {
      action: "employee.lifecycle.salary",
      objectType: "employee",
      objectId: updated.id,
      summary: `${updated.name} 调薪审批通过，已记录薪酬异动`,
      metadata: {
        workflowInstanceId: instance.id,
        employeeNo: updated.employeeNo,
        effectiveDate,
        result: "成功"
      }
    });
    return updated;
  }

  return null;
}

async function syncLinkedBusinessStatus(tx, request, instance, status) {
  if (instance?.definitionCode === "ATT-LEAVE") {
    await tx.leaveRequest.updateMany({
      where: { tenantId: instance.tenantId, workflowInstanceId: instance.id },
      data: { status: status === "WITHDRAWN" ? "CANCELLED" : status }
    });
  }
  if (["FIN-EXPENSE", "FIN-PAYMENT"].includes(instance?.definitionCode)) {
    await tx.financeRequest.updateMany({
      where: { tenantId: instance.tenantId, workflowInstanceId: instance.id },
      data: { status }
    });
  }
  if (status === "APPROVED") {
    await applyHrLifecycleEffect(tx, request, instance);
  }
}

function normalizeApproverNames(value) {
  const source = Array.isArray(value)
    ? value
    : String(value || "").split(/[，,]/);
  return [...new Set(source.map((item) => String(item || "").trim()).filter(Boolean))];
}

function principalCanActAs(principal, approver) {
  if (!principal || !approver?.userId) return false;
  if (principalIsAdmin(principal)) return true;
  return approver.userId === principal.userId;
}

function principalIsAdmin(principal) {
  const permissionCodes = [
    ...(principal?.permissions || []),
    ...(principal?.roles || []).flatMap((role) => role.permissions || [])
  ];
  const roleCodes = (principal?.roles || []).map((role) => role.code);
  return permissionCodes.includes("system.admin") || roleCodes.includes("admin");
}

function principalCanWithdraw(principal, instance) {
  if (principalIsAdmin(principal)) return true;
  return Boolean(instance?.applicantUserId && principal?.userId && instance.applicantUserId === principal.userId);
}

function pickPendingApprover(pending, sourceApproverName, principal) {
  if (sourceApproverName) {
    return pending.find((item) => item.approverName === sourceApproverName);
  }
  if (principalIsAdmin(principal)) {
    return pending[0];
  }
  return pending.find((item) => principalCanActAs(principal, item));
}

async function resolveActiveApproverUser(prisma, tenantId, approverName) {
  const name = String(approverName || "").trim();
  if (!name) return null;
  const approverUserMap = await loadApproverUserMap(prisma, tenantId, [name]);
  return approverUserMap.get(name) || null;
}

function isWorkflowIdempotencyUniqueError(error) {
  const target = Array.isArray(error?.meta?.target)
    ? error.meta.target.join(",")
    : String(error?.meta?.target || "");
  return error?.code === "P2002" && /idempotency/i.test(`${target} ${error.message || ""}`);
}

function requestIdempotencyKey(request) {
  const value = request.body?.idempotencyKey || request.headers["idempotency-key"] || "";
  return String(value || "").trim().slice(0, 160);
}

function workflowInstanceInclude() {
  return {
    definition: true,
    nodes: {
      include: { approvers: { orderBy: { createdAt: "asc" } } },
      orderBy: { stepOrder: "asc" }
    }
  };
}

async function findDecisionIdempotency(tx, tenantId, idempotencyKey) {
  if (!idempotencyKey) return null;
  return tx.workflowApprover.findUnique({
    where: { tenantId_idempotencyKey: { tenantId, idempotencyKey } }
  });
}

async function findSubmittedWorkflowByIdempotency(prisma, tenantId, idempotencyKey) {
  if (!idempotencyKey) return null;
  return prisma.workflowInstance.findFirst({
    where: { tenantId, idempotencyKey },
    include: workflowInstanceInclude()
  });
}

function normalizeApprovalRuleInput(rule = {}, existing = null) {
  const department = String(rule.department ?? existing?.department ?? "").trim();
  const templateId = String(rule.templateId ?? existing?.templateId ?? "").trim();
  const templateName = String(rule.templateName ?? existing?.templateName ?? templateId).trim();
  const nodes = Array.isArray(rule.nodes) ? rule.nodes : [];

  if (!department || !templateId) {
    return { error: "department_and_template_required" };
  }
  if (!nodes.length) {
    return { error: "approval_rule_nodes_required" };
  }

  const normalizedNodes = [];
  for (const [index, node] of nodes.entries()) {
    const name = String(node?.name || "").trim();
    const approvers = normalizeApproverNames(node?.approvers);
    if (!name) {
      return { error: "approval_rule_node_name_required", details: { nodeIndex: index } };
    }
    if (!approvers.length) {
      return { error: "approval_rule_approvers_required", details: { nodeIndex: index, nodeName: name } };
    }
    normalizedNodes.push({
      id: String(node?.id || `${templateId}-${index + 1}`).trim(),
      name,
      mode: "AND",
      approvers
    });
  }

  return {
    data: {
      department,
      templateId,
      templateName: templateName || templateId,
      enabled: rule.enabled !== false,
      nodes: normalizedNodes
    }
  };
}

function normalizeApprovalRulePreviewQuery(query = {}) {
  const department = String(query.department || "").trim();
  const templateId = String(query.templateId || query.definitionId || "").trim();
  const definitionCode = String(query.definitionCode || codeByTemplate[templateId] || "").trim();

  if (!department) return { error: "department_required" };
  if (!templateId && !definitionCode) return { error: "template_required" };

  return { data: { department, definitionCode, templateId } };
}

function serializeRulePreview({ department, definition, rule, templateId, nodes: resolvedNodes }) {
  const nodes = resolvedNodes.map((node, index) => ({
    id: String(node.id || `${templateId}-${index + 1}`),
    name: node.name,
    mode: "AND",
    stepOrder: index + 1,
    approvers: node.approvers || [],
    approverUsers: node.approverUsers || [],
    approverCount: (node.approvers || []).length
  }));
  const source = rule ? "department_rule" : "workflow_definition";
  const resolution = approverResolutionSummary(nodes);

  return {
    department,
    definitionCode: definition.code,
    templateId,
    templateName: rule?.templateName || definition.name,
    source,
    ruleId: rule?.id || null,
    enabled: Boolean(rule),
    nodeCount: nodes.length,
    approverChain: nodes.map((node) => `${node.name}(${node.approvers.join("、")})`).join(" -> "),
    ...resolution,
    nodes
  };
}

function approvalRuleKey(department, templateId) {
  return `${department}::${templateId}`;
}

function serializeCoverageNode(node, index, templateId) {
  return {
    id: String(node.id || `${templateId}-${index + 1}`),
    name: node.name,
    mode: "AND",
    stepOrder: index + 1,
    approvers: node.approvers || [],
    approverUsers: node.approverUsers || [],
    approverCount: (node.approvers || []).length
  };
}

async function buildApprovalRuleCoverage(prisma, tenantId) {
  const [departments, definitions, rules] = await Promise.all([
    prisma.department.findMany({
      where: { tenantId },
      orderBy: { name: "asc" }
    }),
    prisma.workflowDefinition.findMany({
      where: { tenantId, status: "ACTIVE" },
      include: { nodes: { orderBy: { stepOrder: "asc" } } },
      orderBy: [
        { category: "asc" },
        { code: "asc" }
      ]
    }),
    prisma.approvalRule.findMany({
      where: { tenantId },
      orderBy: [
        { department: "asc" },
        { templateId: "asc" }
      ]
    })
  ]);

  const rulesByKey = new Map();
  rules.forEach((rule) => {
    const key = approvalRuleKey(rule.department, rule.templateId);
    const bucket = rulesByKey.get(key) || [];
    bucket.push(rule);
    rulesByKey.set(key, bucket);
  });
  const departmentsByName = new Map(departments.map((department) => [department.name, department]));
  rules.forEach((rule) => {
    if (!departmentsByName.has(rule.department)) {
      departmentsByName.set(rule.department, {
        id: `rule-department-${Buffer.from(rule.department).toString("hex").slice(0, 24)}`,
        tenantId,
        code: "RULE",
        name: rule.department
      });
    }
  });
  const coverageDepartments = [...departmentsByName.values()].sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));

  const templates = definitions.map((definition) => ({
    definitionCode: definition.code,
    templateId: templateMeta[definition.code]?.templateId || definition.code,
    templateName: definition.name,
    category: definition.category || "OA审批"
  }));
  const rows = [];

  for (const department of coverageDepartments) {
    for (const definition of definitions) {
      const templateId = templateMeta[definition.code]?.templateId || definition.code;
      const matchingRules = rulesByKey.get(approvalRuleKey(department.name, templateId)) || [];
      const activeRule = matchingRules.find((rule) => rule.enabled !== false) || null;
      const disabledRule = matchingRules.find((rule) => rule.enabled === false) || null;
      const source = activeRule ? "department_rule" : "workflow_definition";
      const resolvedNodes = await enrichRuleNodesFromPrisma(
        prisma,
        tenantId,
        normalizeRuleNodes(activeRule, definition)
      );
      const nodes = resolvedNodes.map((node, index) => serializeCoverageNode(node, index, templateId));
      const resolution = approverResolutionSummary(nodes);
      const unresolvedApprovers = resolution.unresolvedApprovers || [];

      rows.push({
        id: `${department.id}-${templateId}`,
        departmentId: department.id,
        department: department.name,
        definitionCode: definition.code,
        templateId,
        templateName: activeRule?.templateName || definition.name,
        category: definition.category || "OA审批",
        source,
        status: source === "department_rule"
          ? unresolvedApprovers.length ? "needs_binding" : "configured"
          : "fallback",
        ruleId: activeRule?.id || null,
        disabledRuleId: disabledRule?.id || null,
        enabled: Boolean(activeRule),
        nodeCount: nodes.length,
        approverChain: nodes.map((node) => `${node.name}(${node.approvers.join("、")})`).join(" -> "),
        hasUnresolvedApprovers: unresolvedApprovers.length > 0,
        ...resolution,
        nodes
      });
    }
  }

  return {
    departments: coverageDepartments.map((department) => ({ id: department.id, name: department.name, code: department.code })),
    templates,
    rows,
    summary: {
      departmentCount: coverageDepartments.length,
      templateCount: templates.length,
      totalCells: rows.length,
      configuredCount: rows.filter((row) => row.source === "department_rule").length,
      fallbackCount: rows.filter((row) => row.source === "workflow_definition").length,
      needsBindingCount: rows.filter((row) => row.hasUnresolvedApprovers).length,
      unresolvedApproverCount: rows.reduce((sum, row) => sum + (row.unresolvedApprovers || []).length, 0)
    }
  };
}

async function enrichApprovalRuleForResponse(prisma, tenantId, rule) {
  return {
    ...rule,
    nodes: await enrichRuleNodesFromPrisma(prisma, tenantId, rule.nodes || [])
  };
}

export async function registerApprovalRoutes(app) {
  app.get("/api/approvals/definitions", { preHandler: app.authenticate }, async (request) => {
    await requirePermission(app, request, { module: "workflow", action: "read" });
    const definitions = await app.prisma.workflowDefinition.findMany({
      where: { tenantId: request.user.tenantId, status: "ACTIVE" },
      include: { nodes: { orderBy: { stepOrder: "asc" } } },
      orderBy: [
        { category: "asc" },
        { code: "asc" }
      ]
    });
    return { workflowDefinitions: definitions.map(serializeWorkflowDefinition) };
  });

  app.get("/api/approvals", { preHandler: app.authenticate }, async (request) => {
    await requirePermission(app, request, { module: "workflow", action: "read" });
    const instances = await app.prisma.workflowInstance.findMany({
      where: { tenantId: request.user.tenantId },
      include: workflowInstanceInclude(),
      orderBy: { createdAt: "desc" },
      take: 100
    });
    const lookups = await approvalLookups(app.prisma, request.user.tenantId, instances);
    return { approvals: instances.map((item) => serializeApproval(item, lookups)) };
  });

  app.post("/api/approvals/export", { preHandler: app.authenticate }, async (request, reply) => {
    await requirePermission(app, request, { module: "workflow", action: "export" });
    const filters = normalizeExportFilters(request.body?.filters || {});
    const scope = request.body?.scope || filters.scope || "审批列表";
    const instances = await app.prisma.workflowInstance.findMany({
      where: { tenantId: request.user.tenantId },
      include: workflowInstanceInclude(),
      orderBy: { createdAt: "desc" },
      take: 5000
    });
    const lookups = await approvalLookups(app.prisma, request.user.tenantId, instances);
    const rows = instances
      .map((item) => serializeApproval(item, lookups))
      .filter((row) => matchesExportFilters(row, filters));
    const csv = toCsv(rows);
    const businessReason = requireExportBusinessReason(request.body || {});
    const filename = `approval-export-${timestampToken()}.csv`;

    await recordExportEvent(app.prisma, {
      tenantId: request.user.tenantId,
      actorUserId: request.user.sub,
      action: "workflow.export",
      module: "workflow",
      objectType: "workflow",
      fileName: filename,
      scope,
      businessReason,
      rowCount: rows.length,
      filters,
      summary: `导出${scope}，后端生成审批列表`,
      metadata: {
        scope,
        filters,
        format: "csv",
        rowCount: rows.length
      },
      ...requestAuditMeta(request)
    });

    return replyCsv(reply, csv, filename, rows.length);
  });

  app.post("/api/approvals", { preHandler: app.authenticate }, async (request, reply) => {
    await requirePermission(app, request, { module: "workflow", action: "write" });
    const body = request.body || {};
    const idempotencyKey = requestIdempotencyKey(request);
    const submitted = await findSubmittedWorkflowByIdempotency(app.prisma, request.user.tenantId, idempotencyKey);
    if (submitted) {
      const lookups = await approvalLookups(app.prisma, request.user.tenantId, [submitted]);
      return reply.code(200).send({
        approval: serializeApproval(submitted, lookups),
        alreadySubmitted: true
      });
    }
    const definition = await findDefinition(app, request.user.tenantId, body);
    if (!definition) return reply.code(404).send({ error: "workflow_definition_not_found" });
    const department = await findDepartment(app, request.user.tenantId, body.department || body.template?.department || "行政部");
    const templateId = templateMeta[definition.code]?.templateId || body.definitionId || definition.code;
    const rule = await app.prisma.approvalRule.findFirst({
      where: {
        tenantId: request.user.tenantId,
        department: department.name,
        templateId,
        enabled: true
      }
    });
    const ruleNodes = await enrichRuleNodesFromPrisma(app.prisma, request.user.tenantId, normalizeRuleNodes(rule, definition));
    let created;
    try {
      created = await app.prisma.$transaction(async (tx) => {
        const instance = await tx.workflowInstance.create({
          data: {
            tenantId: request.user.tenantId,
            definitionId: definition.id,
            definitionCode: definition.code,
            definitionVersion: definition.version,
            title: body.title || definition.name,
            status: "PENDING",
            applicantUserId: request.user.sub,
            departmentId: department.id,
            formData: body.formData || {},
            idempotencyKey: idempotencyKey || null,
            definitionSnapshot: {
              id: definition.id,
              code: definition.code,
              version: definition.version,
              ruleId: rule?.id || null,
              nodes: ruleNodes
            },
            submittedAt: new Date()
          }
        });
        let currentNodeId = null;
        for (const [index, node] of ruleNodes.entries()) {
          const createdNode = await tx.workflowInstanceNode.create({
            data: {
              tenantId: request.user.tenantId,
              instanceId: instance.id,
              name: node.name,
              stepOrder: index + 1,
              approvalMode: "AND",
              status: index === 0 ? "ACTIVE" : "PENDING",
              startedAt: index === 0 ? new Date() : null
            }
          });
          currentNodeId = currentNodeId || createdNode.id;
          await tx.workflowApprover.createMany({
            data: (node.approvers || ["系统管理员"]).map((approverName) => ({
              tenantId: request.user.tenantId,
              nodeId: createdNode.id,
              userId: approverUserIdForName(node, approverName),
              approverName,
              status: "PENDING"
            }))
          });
        }
        const updated = await tx.workflowInstance.update({
          where: { id: instance.id },
          data: { currentNodeId },
          include: workflowInstanceInclude()
        });
        await appendWorkflowAudit(tx, request, {
          action: "workflow.submit",
          objectType: "workflow",
          objectId: updated.id,
          summary: "提交审批申请",
          metadata: {
            title: updated.title,
            definitionCode: updated.definitionCode,
            department: department.name,
            approverResolution: approverResolutionSummary(ruleNodes)
          }
        });
        return updated;
      });
    } catch (error) {
      if (idempotencyKey && isWorkflowIdempotencyUniqueError(error)) {
        const submitted = await findSubmittedWorkflowByIdempotency(app.prisma, request.user.tenantId, idempotencyKey);
        if (submitted) {
          const lookups = await approvalLookups(app.prisma, request.user.tenantId, [submitted]);
          return reply.code(200).send({
            approval: serializeApproval(submitted, lookups),
            alreadySubmitted: true
          });
        }
      }
      throw error;
    }
    const lookups = await approvalLookups(app.prisma, request.user.tenantId, [created]);
    return reply.code(201).send({ approval: serializeApproval(created, lookups) });
  });

  app.post("/api/approvals/:id/decision", { preHandler: app.authenticate }, async (request, reply) => {
    const { principal } = await requirePermission(app, request, { module: "workflow", action: "approve" });
    const idempotencyKey = request.body?.idempotencyKey || request.headers["idempotency-key"] || "";
    const requestedApproverName = String(request.body?.approverName || "").trim();
    if (!requestedApproverName) {
      return reply.code(400).send({ error: "approver_name_required", message: "必须指定当前节点待审批人。" });
    }
    const result = await app.prisma.$transaction(async (tx) => {
      if (await findDecisionIdempotency(tx, request.user.tenantId, idempotencyKey)) {
        return { alreadyProcessed: true };
      }

      await tx.$queryRaw`SELECT id FROM workflow_instances WHERE id = ${request.params.id} AND tenant_id = ${request.user.tenantId} FOR UPDATE`;
      if (await findDecisionIdempotency(tx, request.user.tenantId, idempotencyKey)) {
        return { alreadyProcessed: true };
      }
      const instance = await tx.workflowInstance.findFirst({
        where: { id: request.params.id, tenantId: request.user.tenantId },
        include: {
          nodes: {
            include: { approvers: { orderBy: { createdAt: "asc" } } },
            orderBy: { stepOrder: "asc" }
          }
        }
      });
      if (!instance || instance.status !== "PENDING") return null;
      const currentNode = instance.nodes.find((node) => node.id === instance.currentNodeId)
        || instance.nodes.find((node) => node.status === "ACTIVE");
      if (!currentNode) return null;
      const decision = request.body?.decision === "reject" ? "reject" : "pass";
      const pending = currentNode.approvers.filter((item) => item.status === "PENDING");
      const approver = pending.find((item) => item.approverName === requestedApproverName);
      if (!approver) {
        await appendWorkflowAudit(tx, request, {
          action: "workflow.decision.denied",
          objectType: "workflow",
          objectId: instance.id,
          summary: "审批人不在当前节点待处理人内",
          metadata: {
            requestedApproverName,
            nodeName: currentNode.name,
            pendingApprovers: pending.map((item) => item.approverName),
            result: "失败"
          }
        });
        return { approverNotAssigned: true };
      }
      if (!approver.userId) {
        await appendWorkflowAudit(tx, request, {
          action: "workflow.identity.unbound",
          objectType: "workflow",
          objectId: instance.id,
          summary: "审批身份未绑定真实账号，不能处理",
          metadata: {
            approverName: approver.approverName,
            approverRecordId: approver.id,
            nodeName: currentNode.name,
            principalUserId: principal?.userId,
            result: "失败"
          }
        });
        return { approverUnbound: true };
      }
      if (!principalCanActAs(principal, approver)) {
        await appendWorkflowAudit(tx, request, {
          action: "workflow.identity.denied",
          objectType: "workflow",
          objectId: instance.id,
          summary: "审批身份校验失败，不能代替该审批人处理",
          metadata: {
            approverRecordId: approver.id,
            requestedApproverName,
            approverUserId: approver.userId,
            nodeName: currentNode.name,
            principalUserId: principal?.userId,
            principalName: principal?.name,
            result: "失败"
          }
        });
        return { approverIdentityDenied: true };
      }

      if (decision === "reject") {
        await tx.workflowApprover.update({
          where: { id: approver.id },
          data: {
            status: "REJECTED",
            decision: "reject",
            comment: request.body?.comment || "驳回",
            decidedAt: new Date(),
            idempotencyKey: idempotencyKey || null
          }
        });
        await tx.workflowInstanceNode.update({
          where: { id: currentNode.id },
          data: { status: "REJECTED", completedAt: new Date() }
        });
        const rejected = await tx.workflowInstance.update({
          where: { id: instance.id },
          data: { status: "REJECTED", completedAt: new Date(), currentNodeId: null }
        });
        await syncLinkedBusinessStatus(tx, request, instance, "REJECTED");
        await appendWorkflowAudit(tx, request, {
          action: "workflow.reject",
          objectType: "workflow",
          objectId: instance.id,
          summary: "驳回审批",
          metadata: { approverName: approver.approverName, approverRecordId: approver.id, approverUserId: approver.userId, nodeName: currentNode.name, principalUserId: principal?.userId }
        });
        return rejected;
      }

      await tx.workflowApprover.update({
        where: { id: approver.id },
        data: {
          status: "APPROVED",
          decision: "pass",
          comment: request.body?.comment || "同意",
          decidedAt: new Date(),
          idempotencyKey: idempotencyKey || null
        }
      });
      const remaining = pending.filter((item) => item.id !== approver.id);
      if (remaining.length > 0) {
        await appendWorkflowAudit(tx, request, {
          action: "workflow.approve.partial",
          objectType: "workflow",
          objectId: instance.id,
          summary: "审批节点部分同意",
          metadata: { approverName: approver.approverName, approverRecordId: approver.id, approverUserId: approver.userId, nodeName: currentNode.name, principalUserId: principal?.userId, remaining: remaining.length }
        });
        return instance;
      }

      await tx.workflowInstanceNode.update({
        where: { id: currentNode.id },
        data: { status: "APPROVED", completedAt: new Date() }
      });
      const nextNode = instance.nodes.find((node) => node.stepOrder > currentNode.stepOrder && node.status === "PENDING");
      let updated;
      if (nextNode) {
        await tx.workflowInstanceNode.update({
          where: { id: nextNode.id },
          data: { status: "ACTIVE", startedAt: new Date() }
        });
        updated = await tx.workflowInstance.update({
          where: { id: instance.id },
          data: { currentNodeId: nextNode.id }
        });
      } else {
        updated = await tx.workflowInstance.update({
          where: { id: instance.id },
          data: { status: "APPROVED", completedAt: new Date(), currentNodeId: null }
        });
        await syncLinkedBusinessStatus(tx, request, instance, "APPROVED");
      }
      await appendWorkflowAudit(tx, request, {
        action: "workflow.approve",
        objectType: "workflow",
        objectId: instance.id,
        summary: "审批节点全部同意",
        metadata: { approverName: approver.approverName, approverRecordId: approver.id, approverUserId: approver.userId, nodeName: currentNode.name, nextNodeName: nextNode?.name || "归档与通知", principalUserId: principal?.userId }
      });
      return updated;
    }).catch((error) => {
      if (isWorkflowIdempotencyUniqueError(error)) {
        return { alreadyProcessed: true };
      }
      throw error;
    });
    if (!result) return reply.code(404).send({ error: "approval_not_found_or_not_pending" });
    if (result.approverNotAssigned) {
      return reply.code(403).send({ error: "approver_not_assigned", message: "该审批人不在当前节点待处理人内。" });
    }
    if (result.approverUnbound) {
      return reply.code(403).send({ error: "approver_identity_unbound", message: "该审批任务未绑定真实账号，不能处理。" });
    }
    if (result.approverIdentityDenied) {
      return reply.code(403).send({ error: "approver_identity_denied", message: "当前登录用户不能代替该审批人处理。" });
    }
    return { ok: true, alreadyProcessed: Boolean(result.alreadyProcessed) };
  });

  app.post("/api/approvals/:id/transfer", { preHandler: app.authenticate }, async (request, reply) => {
    const { principal } = await requirePermission(app, request, { module: "workflow", action: "approve" });
    const targetApproverName = String(request.body?.targetApproverName || request.body?.target || "").trim();
    const sourceApproverName = String(request.body?.sourceApproverName || request.body?.source || "").trim();
    if (!targetApproverName) {
      return reply.code(400).send({ error: "target_approver_required", message: "必须指定转交后的审批人。" });
    }
    const result = await app.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM workflow_instances WHERE id = ${request.params.id} AND tenant_id = ${request.user.tenantId} FOR UPDATE`;
      const instance = await tx.workflowInstance.findFirst({
        where: { id: request.params.id, tenantId: request.user.tenantId },
        include: {
          nodes: {
            include: { approvers: { orderBy: { createdAt: "asc" } } },
            orderBy: { stepOrder: "asc" }
          }
        }
      });
      if (!instance || instance.status !== "PENDING") return null;
      const currentNode = instance?.nodes.find((node) => node.id === instance.currentNodeId);
      if (!currentNode) return null;
      const pending = currentNode.approvers.filter((item) => item.status === "PENDING");
      const approver = pickPendingApprover(pending, sourceApproverName, principal);
      if (!approver) {
        await appendWorkflowAudit(tx, request, {
          action: "workflow.transfer.denied",
          objectType: "workflow",
          objectId: instance.id,
          summary: "转交审批失败，原审批人不在当前待处理人内",
          metadata: {
            requestedSourceApproverName: sourceApproverName,
            targetApproverName,
            nodeName: currentNode.name,
            pendingApprovers: pending.map((item) => item.approverName),
            result: "失败"
          }
        });
        return { sourceNotPending: true };
      }
      if (!approver.userId) {
        await appendWorkflowAudit(tx, request, {
          action: "workflow.transfer.identity_unbound",
          objectType: "workflow",
          objectId: instance.id,
          summary: "转交审批失败，原审批人未绑定真实账号",
          metadata: {
            requestedSourceApproverName: approver.approverName,
            approverRecordId: approver.id,
            targetApproverName,
            nodeName: currentNode.name,
            principalUserId: principal?.userId,
            result: "失败"
          }
        });
        return { sourceUnbound: true };
      }
      if (!principalCanActAs(principal, approver)) {
        await appendWorkflowAudit(tx, request, {
          action: "workflow.transfer.identity_denied",
          objectType: "workflow",
          objectId: instance.id,
          summary: "转交审批失败，不能代替该审批人转交",
          metadata: {
            requestedSourceApproverName: approver.approverName,
            approverRecordId: approver.id,
            approverUserId: approver.userId,
            targetApproverName,
            nodeName: currentNode.name,
            principalUserId: principal?.userId,
            principalName: principal?.name,
            result: "失败"
          }
        });
        return { sourceIdentityDenied: true };
      }
      if (pending.some((item) => item.approverName === targetApproverName)) {
        return { duplicateTarget: true };
      }
      const targetApproverUser = await resolveActiveApproverUser(tx, request.user.tenantId, targetApproverName);
      if (!targetApproverUser) {
        await appendWorkflowAudit(tx, request, {
          action: "workflow.transfer.target_unbound",
          objectType: "workflow",
          objectId: instance.id,
          summary: "转交审批失败，目标审批人未绑定真实账号",
          metadata: {
            sourceApproverName: approver.approverName,
            targetApproverName,
            nodeName: currentNode.name,
            principalUserId: principal?.userId,
            result: "失败"
          }
        });
        return { targetUnbound: true };
      }
      await tx.workflowApprover.update({
        where: { id: approver.id },
        data: {
          status: "TRANSFERRED",
          decision: "transfer",
          comment: request.body?.comment || `转交给 ${targetApproverName}`,
          decidedAt: new Date()
        }
      });
      await tx.workflowApprover.create({
        data: {
          tenantId: request.user.tenantId,
          nodeId: currentNode.id,
          approverName: targetApproverName,
          userId: targetApproverUser.id,
          status: "PENDING"
        }
      });
      await appendWorkflowAudit(tx, request, {
        action: "workflow.transfer",
        objectType: "workflow",
        objectId: request.params.id,
        summary: "转交审批任务",
        metadata: {
          sourceApproverName: approver.approverName,
          sourceApproverUserId: approver.userId,
          targetApproverName,
          targetApproverUserId: targetApproverUser.id,
          nodeName: currentNode.name
        }
      });
      return { transferred: true };
    });
    if (!result) return reply.code(404).send({ error: "approval_not_found_or_not_pending" });
    if (result.sourceNotPending) return reply.code(403).send({ error: "source_approver_not_pending" });
    if (result.sourceUnbound) return reply.code(403).send({ error: "source_approver_identity_unbound" });
    if (result.sourceIdentityDenied) return reply.code(403).send({ error: "source_approver_identity_denied" });
    if (result.targetUnbound) return reply.code(400).send({ error: "target_approver_unbound", message: "转交目标未绑定真实账号。" });
    if (result.duplicateTarget) return reply.code(409).send({ error: "target_approver_already_pending" });
    return { ok: true };
  });

  app.post("/api/approvals/:id/withdraw", { preHandler: app.authenticate }, async (request, reply) => {
    const { principal } = await requirePermission(app, request, { module: "workflow", action: "write" });
    const result = await app.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM workflow_instances WHERE id = ${request.params.id} AND tenant_id = ${request.user.tenantId} FOR UPDATE`;
      const instance = await tx.workflowInstance.findFirst({
        where: { id: request.params.id, tenantId: request.user.tenantId, status: "PENDING" }
      });
      if (!instance) return null;
      if (!principalCanWithdraw(principal, instance)) {
        await appendWorkflowAudit(tx, request, {
          action: "workflow.withdraw.denied",
          objectType: "workflow",
          objectId: instance.id,
          summary: "撤回审批失败，当前用户不是申请人或管理员",
          metadata: {
            applicantUserId: instance.applicantUserId,
            principalUserId: principal?.userId,
            principalName: principal?.name,
            result: "失败"
          }
        });
        return { withdrawDenied: true };
      }
      const withdrawn = await tx.workflowInstance.update({
        where: { id: instance.id },
        data: { status: "WITHDRAWN", completedAt: new Date(), currentNodeId: null }
      });
      await syncLinkedBusinessStatus(tx, request, instance, "WITHDRAWN");
      await appendWorkflowAudit(tx, request, {
        action: "workflow.withdraw",
        objectType: "workflow",
        objectId: request.params.id,
        summary: "撤回审批实例",
        metadata: {}
      });
      return { withdrawn };
    });
    if (!result) return reply.code(404).send({ error: "approval_not_found_or_not_pending" });
    if (result.withdrawDenied) {
      return reply.code(403).send({ error: "withdraw_identity_denied", message: "只有申请人本人或系统管理员可以撤回审批。" });
    }
    return { ok: true };
  });

  app.post("/api/approvals/:id/comments", { preHandler: app.authenticate }, async (request) => {
    await requirePermission(app, request, { module: "workflow", action: "write" });
    const instance = await app.prisma.workflowInstance.findFirst({
      where: { id: request.params.id, tenantId: request.user.tenantId }
    });
    if (!instance) return { ok: false };
    const comments = Array.isArray(instance.formData?.comments) ? instance.formData.comments : [];
    const comment = {
      id: `CMT-${Date.now()}`,
      author: request.user.name || request.user.email || "系统用户",
      time: formatDateTime(new Date()),
      content: String(request.body?.content || "").trim()
    };
    await app.prisma.workflowInstance.update({
      where: { id: instance.id },
      data: { formData: { ...(instance.formData || {}), comments: [comment, ...comments] } }
    });
    await appendWorkflowAudit(app.prisma, request, {
      action: "workflow.comment",
      objectType: "workflow",
      objectId: instance.id,
      summary: "添加审批评论",
      metadata: { content: comment.content }
    });
    return { ok: true, comment };
  });

  app.get("/api/approvals/rules", { preHandler: app.authenticate }, async (request) => {
    await requirePermission(app, request, { module: "workflow", action: "read" });
    const rules = await app.prisma.approvalRule.findMany({
      where: { tenantId: request.user.tenantId },
      orderBy: [
        { department: "asc" },
        { templateId: "asc" }
      ]
    });
    const approvalRules = await Promise.all(
      rules.map((rule) => enrichApprovalRuleForResponse(app.prisma, request.user.tenantId, rule))
    );
    return { approvalRules };
  });

  app.get("/api/approvals/rules/coverage", { preHandler: app.authenticate }, async (request) => {
    await requirePermission(app, request, { module: "workflow", action: "read" });
    const approvalRuleCoverage = await buildApprovalRuleCoverage(app.prisma, request.user.tenantId);
    return { approvalRuleCoverage };
  });

  app.get("/api/approvals/rules/preview", { preHandler: app.authenticate }, async (request, reply) => {
    await requirePermission(app, request, { module: "workflow", action: "read" });
    const normalized = normalizeApprovalRulePreviewQuery(request.query || {});
    if (normalized.error) return reply.code(400).send(normalized);

    const { department, definitionCode, templateId } = normalized.data;
    const definition = await findDefinition(app, request.user.tenantId, {
      definitionCode,
      templateId,
      template: { id: templateId }
    });
    if (!definition) return reply.code(404).send({ error: "workflow_definition_not_found" });

    const resolvedTemplateId = templateId || templateMeta[definition.code]?.templateId || definition.code;
    const rule = await app.prisma.approvalRule.findFirst({
      where: {
        tenantId: request.user.tenantId,
        department,
        templateId: resolvedTemplateId,
        enabled: true
      }
    });
    const resolvedNodes = await enrichRuleNodesFromPrisma(
      app.prisma,
      request.user.tenantId,
      normalizeRuleNodes(rule, definition)
    );
    const preview = serializeRulePreview({
      department,
      definition,
      rule,
      templateId: resolvedTemplateId,
      nodes: resolvedNodes
    });

    await appendWorkflowAudit(app.prisma, request, {
      action: "workflow.rule.preview",
      objectType: rule ? "approval_rule" : "workflow_definition",
      objectId: rule?.id || definition.id,
      summary: "预览部门审批规则",
      metadata: {
        department,
        templateId: resolvedTemplateId,
        source: preview.source,
        nodeCount: preview.nodeCount
      }
    });

    return { preview };
  });

  app.post("/api/approvals/rules", { preHandler: app.authenticate }, async (request, reply) => {
    await requirePermission(app, request, { module: "workflow", action: "write" });
    const normalized = normalizeApprovalRuleInput(request.body || {});
    if (normalized.error) return reply.code(400).send(normalized);
    const rule = {
      ...normalized.data,
      nodes: await enrichRuleNodesFromPrisma(app.prisma, request.user.tenantId, normalized.data.nodes)
    };
    const bindingError = approvalRuleBindingError(rule.nodes, { enabled: rule.enabled });
    if (bindingError) return reply.code(400).send(bindingError);
    const saved = await app.prisma.approvalRule.upsert({
      where: {
        tenantId_department_templateId: {
          tenantId: request.user.tenantId,
          department: rule.department,
          templateId: rule.templateId
        }
      },
      update: {
        templateName: rule.templateName || rule.templateId,
        enabled: rule.enabled !== false,
        nodes: rule.nodes || []
      },
      create: {
        tenantId: request.user.tenantId,
        department: rule.department,
        templateId: rule.templateId,
        templateName: rule.templateName || rule.templateId,
        enabled: rule.enabled !== false,
        nodes: rule.nodes || []
      }
    });
    await appendWorkflowAudit(app.prisma, request, {
      action: "workflow.rule.save",
      objectType: "approval_rule",
      objectId: saved.id,
      summary: "保存部门审批规则",
      metadata: { department: saved.department, templateId: saved.templateId, nodes: saved.nodes }
    });
    return reply.code(201).send(saved);
  });

  app.put("/api/approvals/rules/:id", { preHandler: app.authenticate }, async (request, reply) => {
    await requirePermission(app, request, { module: "workflow", action: "write" });
    const existing = await app.prisma.approvalRule.findFirst({
      where: { id: request.params.id, tenantId: request.user.tenantId }
    });
    if (!existing) {
      return reply.code(404).send({ error: "approval_rule_not_found" });
    }
    const normalized = normalizeApprovalRuleInput(request.body || {}, existing);
    if (normalized.error) {
      return reply.code(400).send(normalized);
    }
    const rule = {
      ...normalized.data,
      nodes: await enrichRuleNodesFromPrisma(app.prisma, request.user.tenantId, normalized.data.nodes)
    };
    const bindingError = approvalRuleBindingError(rule.nodes, { enabled: rule.enabled });
    if (bindingError) return reply.code(400).send(bindingError);
    const saved = await app.prisma.approvalRule.update({
      where: { id: request.params.id },
      data: {
        department: rule.department,
        templateName: rule.templateName,
        enabled: rule.enabled !== false,
        nodes: rule.nodes || []
      }
    });
    await appendWorkflowAudit(app.prisma, request, {
      action: "workflow.rule.save",
      objectType: "approval_rule",
      objectId: saved.id,
      summary: "更新部门审批规则",
      metadata: { department: saved.department, templateId: saved.templateId, nodes: saved.nodes }
    });
    return saved;
  });

  app.delete("/api/approvals/rules/:id", { preHandler: app.authenticate }, async (request, reply) => {
    await requirePermission(app, request, { module: "workflow", action: "write" });
    const existing = await app.prisma.approvalRule.findFirst({
      where: { id: request.params.id, tenantId: request.user.tenantId }
    });
    if (!existing) {
      return reply.code(404).send({ error: "approval_rule_not_found" });
    }
    await app.prisma.approvalRule.delete({ where: { id: existing.id } });
    await appendWorkflowAudit(app.prisma, request, {
      action: "workflow.rule.delete",
      objectType: "approval_rule",
      objectId: existing.id,
      summary: "删除部门审批规则",
      metadata: {
        department: existing.department,
        templateId: existing.templateId,
        templateName: existing.templateName
      }
    });
    return reply.code(204).send();
  });
}
