import { appendAuditLog, recordExportEvent, requestAuditMeta, requireExportBusinessReason } from "../audit/audit-service.mjs";
import { boundedQueryLimit } from "../../lib/pagination.mjs";
import { requirePermission } from "../iam/route-guards.mjs";
import {
  createBusinessWorkflowInstance,
  findActiveWorkflowDefinition,
  findWorkflowInstanceByIdempotencyKey,
  findOrCreateWorkflowDepartment,
  isWorkflowSubmitIdempotencyUniqueError,
  workflowSubmissionIdempotencyKey,
  workflowTemplateMeta
} from "../workflow/workflow-instance-factory.mjs";

const statusToLabel = {
  PENDING_REVIEW: "待复核",
  PUBLISHED: "已发布",
  ARCHIVED: "已归档",
  CANCELLED: "已取消"
};

const financeRequestTypeMap = {
  EXPENSE: {
    label: "费用报销",
    definitionCode: "FIN-EXPENSE",
    templateId: "expense",
    auditType: "expense",
    prefix: "EXP"
  },
  PAYMENT: {
    label: "付款申请",
    definitionCode: "FIN-PAYMENT",
    templateId: "payment",
    auditType: "payment",
    prefix: "PAY"
  }
};

const financeRequestStatusToLabel = {
  PENDING_APPROVAL: "待审批",
  APPROVED: "已通过",
  REJECTED: "已拒绝",
  WITHDRAWN: "已撤回",
  PAID: "已付款",
  CANCELLED: "已取消"
};

const workflowStatusToRequestStatus = {
  APPROVED: "APPROVED",
  REJECTED: "REJECTED",
  WITHDRAWN: "WITHDRAWN",
  CANCELLED: "CANCELLED"
};

const financeRequestExportColumns = Object.freeze([
  ["id", "单据编号"],
  ["typeLabel", "单据类型"],
  ["title", "标题"],
  ["applicant", "申请人"],
  ["department", "部门"],
  ["amount", "金额"],
  ["currency", "币种"],
  ["vendor", "收款方/商户"],
  ["paymentMethod", "支付方式"],
  ["status", "单据状态"],
  ["workflowInstanceId", "审批编号"],
  ["workflowStatus", "审批状态"],
  ["createdAt", "创建时间"]
]);

function serializePayroll(row) {
  return {
    id: row.batchNo,
    dbId: row.id,
    cycle: row.cycle,
    scope: row.scope,
    owner: row.owner,
    status: statusToLabel[row.status] || row.status,
    workflowInstanceId: row.workflowInstanceId || "",
    workflowStatus: row.workflowInstance?.status || row.metadata?.workflowStatus || "",
    publishedAt: row.publishedAt ? new Date(row.publishedAt).toLocaleString("sv-SE", { hour12: false }).replace("T", " ").slice(0, 16) : "",
    reviewer: row.reviewer?.name || row.metadata?.reviewer || ""
  };
}

function amountToNumber(value) {
  if (value === null || value === undefined) return 0;
  if (typeof value === "number") return value;
  if (typeof value.toNumber === "function") return value.toNumber();
  return Number(value);
}

function timestampToken() {
  return new Date().toISOString().replaceAll(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function csvCell(value) {
  const text = value === null || value === undefined ? "" : String(value);
  const safeText = /^[\s]*[=+\-@]/.test(text) ? `'${text}` : text;
  return `"${safeText.replaceAll("\"", "\"\"").replace(/\r?\n/g, " ")}"`;
}

function toFinanceRequestCsv(rows) {
  const headers = financeRequestExportColumns.map(([, label]) => label);
  const lines = [
    headers.map(csvCell).join(","),
    ...rows.map((row) => financeRequestExportColumns.map(([key]) => csvCell(row[key])).join(","))
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

function serializeFinanceRequest(row) {
  const workflowStatus = row.workflowInstance?.status || row.metadata?.workflowStatus || "";
  const derivedStatus = workflowStatusToRequestStatus[workflowStatus] || row.status;
  return {
    id: row.requestNo,
    dbId: row.id,
    type: row.requestType,
    typeLabel: financeRequestTypeMap[row.requestType]?.label || row.requestType,
    title: row.title,
    applicant: row.applicant?.name || row.metadata?.applicant || "",
    department: row.department,
    amount: amountToNumber(row.amount),
    currency: row.currency || "CNY",
    vendor: row.vendor || "",
    paymentMethod: row.paymentMethod || "",
    status: financeRequestStatusToLabel[derivedStatus] || derivedStatus,
    workflowInstanceId: row.workflowInstanceId || "",
    workflowStatus,
    createdAt: row.createdAt ? new Date(row.createdAt).toLocaleString("sv-SE", { hour12: false }).replace("T", " ").slice(0, 16) : ""
  };
}

function normalizeExportFilters(input = {}) {
  const filters = {};
  ["type", "requestType", "status", "keyword", "scope"].forEach((key) => {
    const value = input[key];
    if (typeof value === "string" && value.trim()) filters[key] = value.trim();
  });
  return filters;
}

function financeRequestWhere(tenantId, filters = {}) {
  const where = { tenantId };
  const requestType = normalizeFinanceRequestType(filters.type || filters.requestType || "");
  if (requestType) where.requestType = requestType;
  if (filters.status) where.status = filters.status;
  if (filters.keyword) {
    where.OR = [
      { requestNo: { contains: filters.keyword } },
      { title: { contains: filters.keyword } },
      { department: { contains: filters.keyword } },
      { vendor: { contains: filters.keyword } }
    ];
  }
  return where;
}

async function appendFinanceAudit(prisma, request, payload) {
  return appendAuditLog(prisma, {
    tenantId: request.user.tenantId,
    actorUserId: request.user.sub,
    objectType: "payroll_batch",
    ...payload,
    ...requestAuditMeta(request)
  });
}

function normalizeFinanceRequestType(value) {
  const text = String(value || "").trim().toUpperCase();
  if (["EXPENSE", "REIMBURSEMENT", "报销", "费用报销"].includes(text)) return "EXPENSE";
  if (["PAYMENT", "付款", "付款申请"].includes(text)) return "PAYMENT";
  return "";
}

function normalizeFinanceRequestBody(body = {}) {
  const requestType = normalizeFinanceRequestType(body.type || body.requestType || body.definitionId || body.templateId);
  const config = financeRequestTypeMap[requestType];
  const amount = Number.parseFloat(String(body.amount || "0"));
  return {
    requestNo: String(body.requestNo || body.id || "").trim(),
    requestType,
    config,
    title: String(body.title || config?.label || "").trim(),
    department: String(body.department || "财务中心").trim() || "财务中心",
    amount,
    currency: String(body.currency || "CNY").trim().toUpperCase() || "CNY",
    vendor: String(body.vendor || body.payee || "").trim(),
    paymentMethod: String(body.paymentMethod || "").trim(),
    purpose: String(body.purpose || body.reason || body.comment || "").trim(),
    expenseType: String(body.expenseType || body.category || "").trim(),
    invoiceNo: String(body.invoiceNo || "").trim()
  };
}

async function nextFinanceRequestNo(prisma, tenantId, requestType) {
  const config = financeRequestTypeMap[requestType];
  const date = new Date();
  const dateToken = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}${String(date.getDate()).padStart(2, "0")}`;
  const startsWith = `${config.prefix}-${dateToken}-`;
  const count = await prisma.financeRequest.count({
    where: {
      tenantId,
      requestNo: { startsWith }
    }
  });
  return `${startsWith}${String(count + 1).padStart(4, "0")}`;
}

function normalizePayrollCreateBody(body = {}) {
  return {
    batchNo: String(body.batchNo || body.id || "").trim(),
    cycle: String(body.cycle || "").trim(),
    scope: String(body.scope || "").trim(),
    owner: String(body.owner || "财务中心").trim() || "财务中心",
    department: String(body.department || "财务中心").trim() || "财务中心",
    headcount: Number.parseInt(String(body.headcount || "0"), 10),
    totalAmount: Number.parseFloat(String(body.totalAmount || body.amount || "0")),
    comment: String(body.comment || "").trim()
  };
}

export async function registerFinanceRoutes(app) {
  app.get("/api/finance/requests", { preHandler: app.authenticate }, async (request) => {
    await requirePermission(app, request, { module: "finance", action: "read" });
    const where = financeRequestWhere(request.user.tenantId, request.query || {});
    const financeRequests = await app.prisma.financeRequest.findMany({
      where,
      include: { applicant: true, workflowInstance: true },
      orderBy: { createdAt: "desc" },
      take: boundedQueryLimit(request.query?.limit, { fallback: 100, max: 500 })
    });
    return { financeRequests: financeRequests.map(serializeFinanceRequest) };
  });

  app.post("/api/finance/requests/export", { preHandler: app.authenticate }, async (request, reply) => {
    await requirePermission(app, request, { module: "finance", action: "export" });
    const filters = normalizeExportFilters(request.body?.filters || request.body || {});
    const rows = await app.prisma.financeRequest.findMany({
      where: financeRequestWhere(request.user.tenantId, filters),
      include: { applicant: true, workflowInstance: true },
      orderBy: { createdAt: "desc" },
      take: boundedQueryLimit(request.body?.limit || filters.limit, { fallback: 500, max: 2000 })
    });
    const serializedRows = rows.map(serializeFinanceRequest);
    const scope = String(request.body?.scope || filters.scope || "财务单据台账").trim() || "财务单据台账";
    const businessReason = requireExportBusinessReason(request.body || {});
    const filename = `finance-request-export-${timestampToken()}.csv`;
    await recordExportEvent(app.prisma, {
      tenantId: request.user.tenantId,
      actorUserId: request.user.sub,
      action: "finance.request.export",
      module: "finance",
      objectType: "finance_request",
      fileName: filename,
      scope,
      businessReason,
      rowCount: serializedRows.length,
      filters,
      summary: `导出${scope}，后端生成付款报销台账`,
      metadata: {
        filters,
        format: "csv",
        rowCount: serializedRows.length,
        result: "成功",
        scope
      },
      ...requestAuditMeta(request)
    });
    return replyCsv(reply, toFinanceRequestCsv(serializedRows), filename, serializedRows.length);
  });

  app.post("/api/finance/requests", { preHandler: app.authenticate }, async (request, reply) => {
    await requirePermission(app, request, { module: "finance", action: "write" });
    const body = normalizeFinanceRequestBody(request.body || {});
    if (!body.config) {
      return reply.code(400).send({ error: "invalid_finance_request_type", message: "财务单据类型必须是费用报销或付款申请。" });
    }
    if (!Number.isFinite(body.amount) || body.amount <= 0) {
      return reply.code(400).send({ error: "finance_request_invalid_amount", message: "财务单据金额必须大于 0。" });
    }

    const idempotencyKey = workflowSubmissionIdempotencyKey(request, request.body || {});
    const submittedWorkflow = await findWorkflowInstanceByIdempotencyKey(app.prisma, request.user.tenantId, idempotencyKey);
    if (submittedWorkflow) {
      const submittedRequest = await app.prisma.financeRequest.findFirst({
        where: { tenantId: request.user.tenantId, workflowInstanceId: submittedWorkflow.id },
        include: { applicant: true, workflowInstance: true }
      });
      if (submittedRequest) {
        return reply.code(200).send({ financeRequest: serializeFinanceRequest(submittedRequest), alreadySubmitted: true });
      }
      return reply.code(409).send({ error: "idempotency_key_reused", message: "该幂等键已用于其他审批流程。" });
    }

    const requestNo = body.requestNo || await nextFinanceRequestNo(app.prisma, request.user.tenantId, body.requestType);
    const existing = await app.prisma.financeRequest.findFirst({
      where: { tenantId: request.user.tenantId, requestNo },
      include: { applicant: true, workflowInstance: true }
    });
    if (existing) {
      await appendFinanceAudit(app.prisma, request, {
        action: `finance.${body.config.auditType}.create.denied`,
        objectId: existing.id,
        objectType: "finance_request",
        summary: `${requestNo} 财务单据编号已存在`,
        metadata: { requestNo, result: "失败", reason: "duplicate_request_no" }
      });
      return reply.code(409).send({ error: "finance_request_exists", financeRequest: serializeFinanceRequest(existing) });
    }

    const definition = await findActiveWorkflowDefinition(app.prisma, request.user.tenantId, { definitionCode: body.config.definitionCode });
    if (!definition) {
      return reply.code(409).send({ error: "finance_workflow_definition_missing", message: `${body.config.label}流程未启用，无法创建单据。` });
    }

    try {
      const financeRequest = await app.prisma.$transaction(async (tx) => {
        const department = await findOrCreateWorkflowDepartment(tx, request.user.tenantId, body.department);
        const title = body.title || `${body.config.label} ${requestNo}`;
        const workflow = await createBusinessWorkflowInstance(tx, request, {
          definition,
          department,
          templateId: body.config.templateId,
          title,
          auditAction: `finance.${body.config.auditType}.workflow.submit`,
          auditSummary: `提交${body.config.label}审批流程`,
          formData: {
            requestNo,
            requestType: body.requestType,
            title,
            department: department.name,
            amount: body.amount,
            currency: body.currency,
            vendor: body.vendor,
            paymentMethod: body.paymentMethod,
            expenseType: body.expenseType,
            invoiceNo: body.invoiceNo,
            purpose: body.purpose
          },
          metadata: {
            requestNo,
            requestType: body.requestType,
            amount: body.amount,
            currency: body.currency
          },
          idempotencyKey
        });
        const created = await tx.financeRequest.create({
          data: {
            tenantId: request.user.tenantId,
            requestNo,
            requestType: body.requestType,
            title,
            applicantUserId: request.user.sub,
            department: department.name,
            amount: body.amount,
            currency: body.currency,
            vendor: body.vendor || null,
            paymentMethod: body.paymentMethod || null,
            status: "PENDING_APPROVAL",
            workflowInstanceId: workflow.id,
            metadata: {
              workflowInstanceId: workflow.id,
              workflowStatus: workflow.status,
              applicant: request.user.name || request.user.email || "系统用户",
              expenseType: body.expenseType || null,
              invoiceNo: body.invoiceNo || null,
              purpose: body.purpose || null,
              source: "oa_finance_request"
            }
          },
          include: { applicant: true, workflowInstance: true }
        });
        await appendFinanceAudit(tx, request, {
          action: `finance.${body.config.auditType}.create`,
          objectId: created.id,
          objectType: "finance_request",
          summary: `${created.requestNo} ${body.config.label}创建并提交审批`,
          metadata: {
            requestNo: created.requestNo,
            requestType: created.requestType,
            amount: amountToNumber(created.amount),
            currency: created.currency,
            workflowInstanceId: workflow.id,
            result: "成功"
          }
        });
        return created;
      });
      return reply.code(201).send({ financeRequest: serializeFinanceRequest(financeRequest) });
    } catch (error) {
      if (idempotencyKey && isWorkflowSubmitIdempotencyUniqueError(error)) {
        const submittedWorkflow = await findWorkflowInstanceByIdempotencyKey(app.prisma, request.user.tenantId, idempotencyKey);
        const submittedRequest = submittedWorkflow ? await app.prisma.financeRequest.findFirst({
          where: { tenantId: request.user.tenantId, workflowInstanceId: submittedWorkflow.id },
          include: { applicant: true, workflowInstance: true }
        }) : null;
        if (submittedRequest) {
          return reply.code(200).send({ financeRequest: serializeFinanceRequest(submittedRequest), alreadySubmitted: true });
        }
      }
      throw error;
    }
  });

  app.get("/api/finance/payrolls", { preHandler: app.authenticate }, async (request) => {
    await requirePermission(app, request, { module: "finance", action: "read" });
    const payrolls = await app.prisma.payrollBatch.findMany({
      where: { tenantId: request.user.tenantId },
      include: { reviewer: true, workflowInstance: true },
      orderBy: { createdAt: "desc" },
      take: boundedQueryLimit(request.query?.limit, { fallback: 100, max: 500 })
    });
    return { payrolls: payrolls.map(serializePayroll) };
  });

  app.post("/api/finance/payrolls", { preHandler: app.authenticate }, async (request, reply) => {
    await requirePermission(app, request, {
      module: "finance",
      action: "write",
      fields: ["payroll", "salary"]
    });
    const body = normalizePayrollCreateBody(request.body || {});
    if (!body.batchNo || !body.cycle || !body.scope) {
      return reply.code(400).send({ error: "payroll_required_fields", message: "工资单必须填写批次号、周期和人员范围。" });
    }
    if (!Number.isFinite(body.headcount) || body.headcount <= 0) {
      return reply.code(400).send({ error: "payroll_invalid_headcount", message: "发薪人数必须大于 0。" });
    }
    if (!Number.isFinite(body.totalAmount) || body.totalAmount <= 0) {
      return reply.code(400).send({ error: "payroll_invalid_amount", message: "工资总额必须大于 0。" });
    }
    const idempotencyKey = workflowSubmissionIdempotencyKey(request, request.body || {});
    const submittedWorkflow = await findWorkflowInstanceByIdempotencyKey(app.prisma, request.user.tenantId, idempotencyKey);
    if (submittedWorkflow) {
      const submittedPayroll = await app.prisma.payrollBatch.findFirst({
        where: { tenantId: request.user.tenantId, workflowInstanceId: submittedWorkflow.id },
        include: { reviewer: true, workflowInstance: true }
      });
      if (submittedPayroll) {
        return reply.code(200).send({ payroll: serializePayroll(submittedPayroll), alreadySubmitted: true });
      }
      return reply.code(409).send({ error: "idempotency_key_reused", message: "该幂等键已用于其他审批流程。" });
    }
    const existing = await app.prisma.payrollBatch.findFirst({
      where: { tenantId: request.user.tenantId, batchNo: body.batchNo },
      include: { reviewer: true, workflowInstance: true }
    });
    if (existing) {
      await appendFinanceAudit(app.prisma, request, {
        action: "finance.payroll.create.denied",
        objectId: existing.id,
        summary: `${body.batchNo} 工资单批次已存在`,
        metadata: { batchNo: body.batchNo, result: "失败", reason: "duplicate_batch" }
      });
      return reply.code(409).send({ error: "payroll_batch_exists", payroll: serializePayroll(existing) });
    }

    const definition = await findActiveWorkflowDefinition(app.prisma, request.user.tenantId, { definitionCode: "FIN-PAYROLL" });
    if (!definition) {
      return reply.code(409).send({ error: "payroll_workflow_definition_missing", message: "工资单复核流程未启用，无法创建批次。" });
    }

    try {
      const payroll = await app.prisma.$transaction(async (tx) => {
        const department = await findOrCreateWorkflowDepartment(tx, request.user.tenantId, body.department);
        const workflow = await createBusinessWorkflowInstance(tx, request, {
          definition,
          department,
          templateId: workflowTemplateMeta["FIN-PAYROLL"].templateId,
          title: `${body.cycle}工资单复核`,
          auditAction: "finance.payroll.workflow.submit",
          auditSummary: "提交工资单复核流程",
          formData: {
            batchNo: body.batchNo,
            cycle: body.cycle,
            scope: body.scope,
            owner: body.owner,
            department: department.name,
            headcount: body.headcount,
            totalAmount: body.totalAmount,
            comment: body.comment
          },
          metadata: {
            batchNo: body.batchNo,
            cycle: body.cycle,
            scope: body.scope,
            headcount: body.headcount,
            totalAmount: body.totalAmount
          },
          idempotencyKey
        });
        const created = await tx.payrollBatch.create({
          data: {
            tenantId: request.user.tenantId,
            batchNo: body.batchNo,
            cycle: body.cycle,
            scope: body.scope,
            owner: body.owner,
            status: "PENDING_REVIEW",
            workflowInstanceId: workflow.id,
            metadata: {
              workflowInstanceId: workflow.id,
              workflowStatus: workflow.status,
              department: department.name,
              headcount: body.headcount,
              totalAmount: body.totalAmount,
              source: "oa_finance"
            }
          },
          include: { reviewer: true, workflowInstance: true }
        });
        await appendFinanceAudit(tx, request, {
          action: "finance.payroll.create",
          objectId: created.id,
          summary: `${created.batchNo} 工资单创建并提交复核`,
          metadata: {
            batchNo: created.batchNo,
            cycle: created.cycle,
            scope: created.scope,
            workflowInstanceId: workflow.id,
            result: "成功"
          }
        });
        return created;
      });
      return reply.code(201).send({ payroll: serializePayroll(payroll) });
    } catch (error) {
      if (idempotencyKey && isWorkflowSubmitIdempotencyUniqueError(error)) {
        const submittedWorkflow = await findWorkflowInstanceByIdempotencyKey(app.prisma, request.user.tenantId, idempotencyKey);
        const submittedPayroll = submittedWorkflow ? await app.prisma.payrollBatch.findFirst({
          where: { tenantId: request.user.tenantId, workflowInstanceId: submittedWorkflow.id },
          include: { reviewer: true, workflowInstance: true }
        }) : null;
        if (submittedPayroll) {
          return reply.code(200).send({ payroll: serializePayroll(submittedPayroll), alreadySubmitted: true });
        }
      }
      throw error;
    }
  });

  app.post("/api/finance/payrolls/:id/review", { preHandler: app.authenticate }, async (request, reply) => {
    await requirePermission(app, request, {
      module: "finance",
      action: "write",
      fields: ["payroll", "salary"]
    });
    const result = await app.prisma.$transaction(async (tx) => {
      const payroll = await tx.payrollBatch.findFirst({
        where: { tenantId: request.user.tenantId, batchNo: request.params.id },
        include: { workflowInstance: true }
      });
      if (!payroll) return null;
      if (payroll.status === "PUBLISHED") {
        await appendFinanceAudit(tx, request, {
          action: "finance.payroll.review.noop",
          objectId: payroll.id,
          summary: `${payroll.batchNo} 已发布，跳过重复复核`,
          metadata: { batchNo: payroll.batchNo, result: "成功", alreadyPublished: true }
        });
        return { payroll, alreadyPublished: true };
      }
      if (payroll.status !== "PENDING_REVIEW") {
        await appendFinanceAudit(tx, request, {
          action: "finance.payroll.review.denied",
          objectId: payroll.id,
          summary: `${payroll.batchNo} 当前状态不允许发布`,
          metadata: { batchNo: payroll.batchNo, status: payroll.status, result: "失败" }
        });
        return { invalidStatus: true, payroll };
      }
      if (payroll.workflowInstanceId && payroll.workflowInstance?.status !== "APPROVED") {
        await appendFinanceAudit(tx, request, {
          action: "finance.payroll.review.denied",
          objectId: payroll.id,
          summary: `${payroll.batchNo} 审批未全部通过，不能发布工资单`,
          metadata: {
            batchNo: payroll.batchNo,
            workflowInstanceId: payroll.workflowInstanceId,
            workflowStatus: payroll.workflowInstance?.status || "UNKNOWN",
            result: "失败"
          }
        });
        return { workflowNotApproved: true, payroll };
      }
      const published = await tx.payrollBatch.update({
        where: { tenantId_batchNo: { tenantId: request.user.tenantId, batchNo: request.params.id } },
        data: {
          status: "PUBLISHED",
          reviewerUserId: request.user.sub,
          publishedAt: new Date(),
          metadata: {
            ...(payroll.metadata || {}),
            reviewer: request.user.name || request.user.email || "系统用户",
            workflowInstanceId: payroll.workflowInstanceId || null,
            reviewComment: String(request.body?.comment || "复核通过").trim()
          }
        },
        include: { reviewer: true, workflowInstance: true }
      });
      await appendFinanceAudit(tx, request, {
        action: "finance.payroll.review",
        objectId: published.id,
        summary: `${published.batchNo} 工资单复核发布`,
        metadata: {
          batchNo: published.batchNo,
          cycle: published.cycle,
          scope: published.scope,
          status: published.status,
          workflowInstanceId: published.workflowInstanceId || null,
          result: "成功"
        }
      });
      return { payroll: published };
    });

    if (!result) return reply.code(404).send({ error: "payroll_not_found" });
    if (result.invalidStatus) {
      return reply.code(409).send({
        error: "invalid_payroll_status",
        message: "只有待复核工资单可以发布。",
        payroll: serializePayroll(result.payroll)
      });
    }
    if (result.workflowNotApproved) {
      return reply.code(409).send({
        error: "payroll_workflow_not_approved",
        message: "工资单审批未全部通过，不能发布。",
        payroll: serializePayroll(result.payroll)
      });
    }
    return { payroll: serializePayroll(result.payroll), alreadyPublished: Boolean(result.alreadyPublished) };
  });
}
