import { appendAuditLog, requestAuditMeta } from "../audit/audit-service.mjs";
import {
  approverResolutionSummary,
  approverUserIdForName,
  enrichRuleNodesFromPrisma
} from "./approver-resolution.mjs";

export const workflowTemplateMeta = {
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

export const workflowCodeByTemplate = Object.fromEntries(
  Object.entries(workflowTemplateMeta).map(([code, meta]) => [meta.templateId, code])
);

export async function findActiveWorkflowDefinition(prisma, tenantId, body = {}) {
  const code = body.definitionCode
    || body.serviceKey
    || workflowCodeByTemplate[body.definitionId]
    || workflowCodeByTemplate[body.templateId]
    || body.definitionId;
  return prisma.workflowDefinition.findFirst({
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

export async function findOrCreateWorkflowDepartment(prisma, tenantId, name) {
  const departmentName = String(name || "行政部").trim() || "行政部";
  const existing = await prisma.department.findFirst({ where: { tenantId, name: departmentName } });
  if (existing) return existing;
  return prisma.department.create({
    data: {
      tenantId,
      code: `DYN-${Date.now()}`,
      name: departmentName
    }
  });
}

export function workflowSubmissionIdempotencyKey(request, body = request.body || {}) {
  const value = body.idempotencyKey || request.headers["idempotency-key"] || "";
  return String(value || "").trim().slice(0, 160);
}

export function isWorkflowSubmitIdempotencyUniqueError(error) {
  const target = Array.isArray(error?.meta?.target)
    ? error.meta.target.join(",")
    : String(error?.meta?.target || "");
  return error?.code === "P2002" && /workflow_instances.*idempotency|idempotency/i.test(`${target} ${error.message || ""}`);
}

export async function findWorkflowInstanceByIdempotencyKey(prisma, tenantId, idempotencyKey) {
  if (!idempotencyKey) return null;
  return prisma.workflowInstance.findFirst({
    where: { tenantId, idempotencyKey }
  });
}

export function normalizeWorkflowRuleNodes(rule, definition) {
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

export async function createBusinessWorkflowInstance(prisma, request, {
  definition,
  department,
  templateId = workflowTemplateMeta[definition?.code]?.templateId || definition?.code,
  title,
  formData = {},
  auditAction = "workflow.submit",
  auditSummary = "提交审批申请",
  metadata = {},
  idempotencyKey = ""
}) {
  const rule = await prisma.approvalRule.findFirst({
    where: {
      tenantId: request.user.tenantId,
      department: department.name,
      templateId,
      enabled: true
    }
  });
  const ruleNodes = await enrichRuleNodesFromPrisma(prisma, request.user.tenantId, normalizeWorkflowRuleNodes(rule, definition));
  const instance = await prisma.workflowInstance.create({
    data: {
      tenantId: request.user.tenantId,
      definitionId: definition.id,
      definitionCode: definition.code,
      definitionVersion: definition.version,
      title: title || definition.name,
      status: "PENDING",
      applicantUserId: request.user.sub,
      departmentId: department.id,
      formData,
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
    const createdNode = await prisma.workflowInstanceNode.create({
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
    await prisma.workflowApprover.createMany({
    data: (node.approvers || ["系统管理员"]).map((approverName) => ({
      tenantId: request.user.tenantId,
      nodeId: createdNode.id,
      userId: approverUserIdForName(node, approverName),
      approverName,
      status: "PENDING"
    }))
    });
  }

  const updated = await prisma.workflowInstance.update({
    where: { id: instance.id },
    data: { currentNodeId }
  });

  await appendAuditLog(prisma, {
    tenantId: request.user.tenantId,
    actorUserId: request.user.sub,
    action: auditAction,
    objectType: "workflow",
    objectId: updated.id,
    summary: auditSummary,
    metadata: {
      title: updated.title,
      definitionCode: updated.definitionCode,
      department: department.name,
      approverResolution: approverResolutionSummary(ruleNodes),
      ...metadata
    },
    ...requestAuditMeta(request)
  });

  return updated;
}
