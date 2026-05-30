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
  PENDING: "待审批",
  APPROVED: "已通过",
  REJECTED: "已驳回",
  CANCELLED: "已取消"
};

const recordStatusToLabel = {
  NORMAL: "正常",
  LATE: "迟到",
  EARLY_LEAVE: "早退",
  MISSING: "缺卡",
  LEAVE: "请假",
  OUTSIDE: "外勤"
};

const labelToRecordStatus = {
  正常: "NORMAL",
  迟到: "LATE",
  早退: "EARLY_LEAVE",
  缺卡: "MISSING",
  请假: "LEAVE",
  外勤: "OUTSIDE",
  NORMAL: "NORMAL",
  LATE: "LATE",
  EARLY_LEAVE: "EARLY_LEAVE",
  MISSING: "MISSING",
  LEAVE: "LEAVE",
  OUTSIDE: "OUTSIDE"
};

const attendanceRecordExportColumns = Object.freeze([
  ["workDate", "考勤日期"],
  ["employee", "员工"],
  ["department", "部门"],
  ["checkIn", "上班打卡"],
  ["checkOut", "下班打卡"],
  ["minutesLate", "迟到分钟"],
  ["source", "来源"],
  ["status", "状态"],
  ["reason", "异常说明"],
  ["createdAt", "创建时间"]
]);

function normalizeDays(value) {
  const days = Number(value || 0);
  return Number.isFinite(days) && days > 0 ? days : 1;
}

function formatDate(value) {
  if (!value) return "";
  return new Date(value).toISOString().slice(0, 10);
}

function formatDateTime(value) {
  if (!value) return "";
  return new Date(value).toLocaleString("sv-SE", { hour12: false }).replace("T", " ").slice(0, 16);
}

function parseDate(value) {
  if (!value) return { value: null };
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return { error: "invalid_attendance_date" };
  return { value: parsed };
}

function normalizeRecordStatus(value, fallback = "NORMAL") {
  const text = String(value ?? "").trim();
  if (!text) return fallback;
  return labelToRecordStatus[text] || "";
}

function timestampToken() {
  return new Date().toISOString().replaceAll(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function csvCell(value) {
  const text = value === null || value === undefined ? "" : String(value);
  const safeText = /^[\s]*[=+\-@]/.test(text) ? `'${text}` : text;
  return `"${safeText.replaceAll("\"", "\"\"").replace(/\r?\n/g, " ")}"`;
}

function toAttendanceRecordCsv(rows) {
  const headers = attendanceRecordExportColumns.map(([, label]) => label);
  const lines = [
    headers.map(csvCell).join(","),
    ...rows.map((row) => attendanceRecordExportColumns.map(([key]) => csvCell(row[key])).join(","))
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

function normalizeRecordFilters(input = {}) {
  const filters = {};
  ["status", "employee", "department", "from", "to", "scope"].forEach((key) => {
    const value = input[key];
    if (typeof value === "string" && value.trim()) filters[key] = value.trim();
  });
  return filters;
}

function attendanceRecordWhere(tenantId, filters = {}) {
  const where = { tenantId };
  const status = normalizeRecordStatus(filters.status, "");
  if (status) where.status = status;
  if (typeof filters.employee === "string" && filters.employee.trim()) where.employeeName = { contains: filters.employee.trim() };
  if (typeof filters.department === "string" && filters.department.trim()) where.department = filters.department.trim();
  const from = parseDate(filters.from);
  const to = parseDate(filters.to);
  if (from.value || to.value) {
    where.workDate = {};
    if (from.value) where.workDate.gte = from.value;
    if (to.value) where.workDate.lte = to.value;
  }
  return where;
}

function serializeLeave(row) {
  return {
    id: row.id,
    employee: row.employeeName,
    type: row.leaveType,
    dates: row.dateRange,
    days: row.days,
    status: statusToLabel[row.status] || row.status,
    workflowInstanceId: row.workflowInstanceId || "",
    handover: row.metadata?.handover || "",
    submittedAt: row.createdAt ? new Date(row.createdAt).toLocaleString("sv-SE", { hour12: false }).replace("T", " ").slice(0, 16) : ""
  };
}

function serializeAttendanceRecord(row) {
  return {
    id: row.id,
    employee: row.employeeName,
    department: row.department,
    workDate: formatDate(row.workDate),
    checkIn: formatDateTime(row.checkInAt),
    checkOut: formatDateTime(row.checkOutAt),
    status: recordStatusToLabel[row.status] || row.status,
    minutesLate: row.minutesLate,
    source: row.source,
    reason: row.metadata?.reason || "",
    createdAt: formatDateTime(row.createdAt)
  };
}

async function appendAttendanceAudit(prisma, request, payload) {
  return appendAuditLog(prisma, {
    tenantId: request.user.tenantId,
    actorUserId: request.user.sub,
    objectType: "leave_request",
    ...payload,
    ...requestAuditMeta(request)
  });
}

export async function registerAttendanceRoutes(app) {
  app.get("/api/attendance/records", { preHandler: app.authenticate }, async (request) => {
    await requirePermission(app, request, { module: "attendance", action: "read" });
    const where = attendanceRecordWhere(request.user.tenantId, request.query || {});
    const records = await app.prisma.attendanceRecord.findMany({
      where,
      orderBy: { workDate: "desc" },
      take: boundedQueryLimit(request.query?.limit, { fallback: 100, max: 500 })
    });
    return { attendanceRecords: records.map(serializeAttendanceRecord) };
  });

  app.post("/api/attendance/records/export", { preHandler: app.authenticate }, async (request, reply) => {
    await requirePermission(app, request, { module: "attendance", action: "export" });
    const filters = normalizeRecordFilters(request.body?.filters || request.body || {});
    const records = await app.prisma.attendanceRecord.findMany({
      where: attendanceRecordWhere(request.user.tenantId, filters),
      orderBy: { workDate: "desc" },
      take: boundedQueryLimit(request.body?.limit, { fallback: 500, max: 2000 })
    });
    const serializedRecords = records.map(serializeAttendanceRecord);
    const scope = String(request.body?.scope || filters.scope || "考勤记录台账").trim() || "考勤记录台账";
    const businessReason = requireExportBusinessReason(request.body || {});
    const filename = `attendance-record-export-${timestampToken()}.csv`;
    await recordExportEvent(app.prisma, {
      tenantId: request.user.tenantId,
      actorUserId: request.user.sub,
      action: "attendance.record.export",
      module: "attendance",
      objectType: "attendance_record",
      fileName: filename,
      scope,
      businessReason,
      rowCount: serializedRecords.length,
      filters,
      summary: `导出${scope}，后端生成考勤记录台账`,
      metadata: {
        filters,
        format: "csv",
        rowCount: serializedRecords.length,
        result: "成功",
        scope
      },
      ...requestAuditMeta(request)
    });
    return replyCsv(reply, toAttendanceRecordCsv(serializedRecords), filename, serializedRecords.length);
  });

  app.post("/api/attendance/records", { preHandler: app.authenticate }, async (request, reply) => {
    await requirePermission(app, request, { module: "attendance", action: "write" });
    const body = request.body || {};
    const employeeName = String(body.employee || body.employeeName || "").trim();
    const department = String(body.department || "").trim();
    const workDate = parseDate(body.workDate || body.date);
    const checkInAt = parseDate(body.checkInAt || body.checkIn);
    const checkOutAt = parseDate(body.checkOutAt || body.checkOut);
    const status = normalizeRecordStatus(body.status);
    const minutesLate = Number.parseInt(String(body.minutesLate || "0"), 10);

    if (!employeeName || !department || !workDate.value) {
      return reply.code(400).send({ error: "attendance_record_required_fields", message: "考勤记录必须填写员工、部门和考勤日期。" });
    }
    if (workDate.error || checkInAt.error || checkOutAt.error) {
      return reply.code(400).send({ error: "invalid_attendance_date", message: "考勤日期或打卡时间格式无效。" });
    }
    if (!status) {
      return reply.code(400).send({ error: "invalid_attendance_status", message: "考勤状态必须是正常、迟到、早退、缺卡、请假或外勤。" });
    }
    if (!Number.isFinite(minutesLate) || minutesLate < 0) {
      return reply.code(400).send({ error: "invalid_attendance_minutes_late", message: "迟到分钟数不能小于 0。" });
    }

    const record = await app.prisma.attendanceRecord.create({
      data: {
        tenantId: request.user.tenantId,
        employeeName,
        department,
        workDate: workDate.value,
        checkInAt: checkInAt.value,
        checkOutAt: checkOutAt.value,
        status,
        minutesLate,
        source: String(body.source || "manual").trim() || "manual",
        metadata: {
          reason: String(body.reason || "").trim(),
          operator: request.user.name || request.user.email || "系统用户"
        }
      }
    });
    await appendAttendanceAudit(app.prisma, request, {
      action: "attendance.record.create",
      objectId: record.id,
      summary: `录入${employeeName} ${formatDate(record.workDate)} 考勤记录`,
      metadata: {
        employeeName,
        department,
        workDate: formatDate(record.workDate),
        status: recordStatusToLabel[record.status] || record.status,
        minutesLate: record.minutesLate,
        result: "成功"
      }
    });
    return reply.code(201).send({ attendanceRecord: serializeAttendanceRecord(record) });
  });

  app.get("/api/attendance/leaves", { preHandler: app.authenticate }, async (request) => {
    await requirePermission(app, request, { module: "attendance", action: "read" });
    const leaves = await app.prisma.leaveRequest.findMany({
      where: { tenantId: request.user.tenantId },
      orderBy: { createdAt: "desc" },
      take: boundedQueryLimit(request.query?.limit, { fallback: 100, max: 500 })
    });
    return { leaves: leaves.map(serializeLeave) };
  });

  app.post("/api/attendance/leaves", { preHandler: app.authenticate }, async (request, reply) => {
    await requirePermission(app, request, { module: "attendance", action: "write" });
    const body = request.body || {};
    const idempotencyKey = workflowSubmissionIdempotencyKey(request, body);
    const submittedWorkflow = await findWorkflowInstanceByIdempotencyKey(app.prisma, request.user.tenantId, idempotencyKey);
    if (submittedWorkflow) {
      const submittedLeave = await app.prisma.leaveRequest.findFirst({
        where: { tenantId: request.user.tenantId, workflowInstanceId: submittedWorkflow.id }
      });
      if (submittedLeave) {
        return reply.code(200).send({ leave: serializeLeave(submittedLeave), alreadySubmitted: true });
      }
      return reply.code(409).send({ error: "idempotency_key_reused", message: "该幂等键已用于其他审批流程。" });
    }
    const employeeName = String(body.employee || body.employeeName || "").trim();
    const applicantName = String(body.applicant || request.user.name || request.user.email || employeeName).trim();
    const leaveType = String(body.type || body.leaveType || "").trim();
    const dateRange = String(body.dates || body.dateRange || "").trim();
    if (!employeeName || !leaveType || !dateRange) {
      return reply.code(400).send({ error: "leave_required_fields", message: "请假申请必须填写员工、假勤类型和日期。" });
    }
    const definition = await findActiveWorkflowDefinition(app.prisma, request.user.tenantId, { definitionCode: "ATT-LEAVE" });
    if (!definition) {
      return reply.code(409).send({ error: "leave_workflow_definition_missing", message: "请假流程未启用，无法提交假勤申请。" });
    }

    let leave;
    try {
      leave = await app.prisma.$transaction(async (tx) => {
        const department = await findOrCreateWorkflowDepartment(tx, request.user.tenantId, body.department || "行政部");
        const days = normalizeDays(body.days);
        const workflow = await createBusinessWorkflowInstance(tx, request, {
          definition,
          department,
          templateId: workflowTemplateMeta["ATT-LEAVE"].templateId,
          title: `${employeeName}${leaveType}申请`,
          auditAction: "attendance.leave.workflow.submit",
          auditSummary: "提交请假审批流程",
          formData: {
            employee: employeeName,
            applicant: applicantName,
            department: department.name,
            leaveType,
            dateRange,
            days,
            handover: String(body.handover || "").trim(),
            reason: String(body.reason || "").trim()
          },
          metadata: { applicant: applicantName, employeeName, leaveType, dateRange, days },
          idempotencyKey
        });
        const created = await tx.leaveRequest.create({
          data: {
            tenantId: request.user.tenantId,
            applicantUserId: request.user.sub,
            workflowInstanceId: workflow.id,
            employeeName,
            leaveType,
            dateRange,
            days,
            status: "PENDING",
            metadata: {
              handover: String(body.handover || "").trim(),
              reason: String(body.reason || "").trim(),
              source: "oa_attendance"
            }
          }
        });
        await appendAttendanceAudit(tx, request, {
          action: "attendance.leave.submit",
          objectId: created.id,
          summary: `${employeeName} 提交${leaveType}申请`,
          metadata: {
            employeeName,
            leaveType,
            dateRange,
            days: created.days,
            workflowInstanceId: workflow.id,
            result: "成功"
          }
        });
        return created;
      });
    } catch (error) {
      if (idempotencyKey && isWorkflowSubmitIdempotencyUniqueError(error)) {
        const submittedWorkflow = await findWorkflowInstanceByIdempotencyKey(app.prisma, request.user.tenantId, idempotencyKey);
        if (submittedWorkflow) {
          const submittedLeave = await app.prisma.leaveRequest.findFirst({
            where: { tenantId: request.user.tenantId, workflowInstanceId: submittedWorkflow.id }
          });
          if (submittedLeave) {
            return reply.code(200).send({ leave: serializeLeave(submittedLeave), alreadySubmitted: true });
          }
        }
      }
      throw error;
    }

    return reply.code(201).send({ leave: serializeLeave(leave) });
  });
}
