import { appendAuditLog, recordExportEvent, requestAuditMeta, requireExportBusinessReason } from "../audit/audit-service.mjs";
import { getPrincipal, hasPermission } from "../iam/route-guards.mjs";
import { assertPermission, evaluatePermission } from "../iam/permissionEvaluator.mjs";

const employeeStatusByLabel = {
  在职: "ACTIVE",
  离职: "LEAVED",
  停用: "SUSPENDED",
  ACTIVE: "ACTIVE",
  LEAVED: "LEAVED",
  SUSPENDED: "SUSPENDED"
};

const exportColumns = Object.freeze([
  ["seq", "序号"],
  ["name", "姓名"],
  ["gender", "性别"],
  ["org", "组织"],
  ["department", "部门"],
  ["role", "岗位"],
  ["entryDate", "入职日期"],
  ["regularDate", "转正日期"],
  ["leaveDate", "离职日期"],
  ["status", "状态"],
  ["education", "学历"]
]);

const exportFieldKeys = exportColumns.map(([key]) => key);

const lifecycleActionLabels = Object.freeze({
  onboard_create: "入职",
  onboard_update: "入职更新",
  transfer: "调岗",
  offboard: "离职",
  regularization: "转正",
  exception: "异常状态",
  salary_adjustment: "调薪"
});

function formatDate(value) {
  if (!value) return "";
  return new Date(value).toISOString().slice(0, 10);
}

function parseDate(value) {
  if (!value) return { value: null };
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return { error: "invalid_employee_date" };
  return { value: date };
}

function maskText(value) {
  if (!value) return "";
  const text = String(value);
  return text.length <= 2 ? `${text[0] || ""}***` : `${text.slice(0, 2)}***`;
}

function countBy(rows, key) {
  return rows.reduce((acc, item) => {
    const value = item[key] || "未填写";
    acc[value] = (acc[value] || 0) + 1;
    return acc;
  }, {});
}

function topCounts(rows, key, limit = 8) {
  return Object.entries(countBy(rows, key))
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([label, value]) => ({ label, value }));
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

function timestampToken() {
  return new Date().toISOString().replaceAll(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function replyCsv(reply, csv, filename, rowCount) {
  return reply
    .header("Content-Type", "text/csv; charset=utf-8")
    .header("Content-Disposition", `attachment; filename="${filename}"`)
    .header("X-Row-Count", String(rowCount))
    .header("Cache-Control", "no-store")
    .send(csv);
}

function employeeResource(row = {}) {
  return {
    id: row.id,
    employeeId: row.id,
    userId: row.user?.id || null,
    departmentId: row.departmentId
  };
}

function employeeDecision(principal, action, resource, fields = []) {
  return evaluatePermission({
    principal,
    module: "employee",
    action,
    fields,
    resource,
    context: { departmentIds: [principal?.departmentId].filter(Boolean) }
  });
}

function requireEmployeeAccess(principal, action, resource, fields = []) {
  const decision = employeeDecision(principal, action, resource, fields);
  assertPermission(decision);
  return decision;
}

function employeeScopeWhere(principal, action) {
  const allProbe = employeeDecision(principal, action, {
    employeeId: "__other_employee__",
    userId: "__other_user__",
    departmentId: "__other_department__"
  });
  if (allProbe.allowed) return {};

  const departmentProbe = principal?.departmentId
    ? employeeDecision(principal, action, {
        employeeId: "__other_employee__",
        userId: "__other_user__",
        departmentId: principal.departmentId
      })
    : null;
  if (departmentProbe?.allowed) return { departmentId: principal.departmentId };

  const ownProbe = principal?.employeeId
    ? employeeDecision(principal, action, {
        employeeId: principal.employeeId,
        userId: principal.userId,
        departmentId: principal.departmentId
      })
    : null;
  if (ownProbe?.allowed) return { id: principal.employeeId };

  assertPermission(ownProbe || departmentProbe || allProbe);
  return {};
}

function lifecycleDetail(event = {}) {
  if (event.action === "transfer") {
    const from = event.fromDepartment || "原部门";
    const to = event.toDepartment || "目标部门";
    return `${from} -> ${to}`;
  }
  if (event.action === "onboard_create" || event.action === "onboard_update") {
    return event.department ? `入职部门：${event.department}` : "入职资料已同步";
  }
  if (event.action === "offboard") {
    return event.reasonType ? `离职类型：${event.reasonType}` : "离职交接已同步";
  }
  if (event.action === "regularization") {
    return event.probationResult ? `转正结果：${event.probationResult}` : "转正信息已同步";
  }
  if (event.action === "exception") {
    return event.exceptionType ? `异常类型：${event.exceptionType}` : "异常状态已同步";
  }
  if (event.action === "salary_adjustment") {
    return event.reasonType ? `调薪原因：${event.reasonType}` : "薪酬异动已同步";
  }
  return "";
}

function serializeLifecycleSummary(sensitiveInfo = {}) {
  const history = Array.isArray(sensitiveInfo.lifecycleHistory) ? sensitiveInfo.lifecycleHistory : [];
  const latest = history.find((item) => item && typeof item === "object");
  if (!latest) return null;
  const action = String(latest.action || "");
  return {
    action,
    label: lifecycleActionLabels[action] || "人事流程",
    definitionCode: latest.definitionCode || "",
    effectiveDate: latest.effectiveDate || "",
    approvedAt: latest.approvedAt || "",
    detail: lifecycleDetail(latest),
    status: "已同步"
  };
}

function serializeEmployee(row, revealSensitive = false) {
  const sensitive = row.sensitiveInfo || {};
  const school = sensitive.school || "";
  const major = sensitive.major || "";
  const hukou = sensitive.hukou || "";
  const age = sensitive.age || "";

  return {
    id: row.id,
    seq: sensitive.seq || row.employeeNo,
    org: sensitive.org || "未分配组织",
    name: row.name,
    gender: row.gender || "",
    department: row.department?.name || "未填写部门",
    role: row.roleTitle || "未填写岗位",
    entryDate: formatDate(row.entryDate),
    leaveDate: formatDate(row.leaveDate),
    regularDate: sensitive.regularDate || "",
    age,
    displayAge: /^\d{1,2}(\.0)?$/.test(String(age)) ? String(age).replace(".0", "") : "待核验",
    hukou: revealSensitive ? hukou : maskText(hukou),
    education: sensitive.education || "",
    school: revealSensitive ? school : maskText(school),
    major: revealSensitive ? major : maskText(major),
    lifecycleSummary: serializeLifecycleSummary(sensitive),
    status: row.status === "LEAVED" ? "离职" : row.status === "SUSPENDED" ? "停用" : "在职"
  };
}

function normalizeEmployeePatch(body = {}) {
  const patch = {};
  if (body.role !== undefined || body.roleTitle !== undefined) {
    patch.roleTitle = String(body.roleTitle ?? body.role ?? "").trim() || null;
  }
  if (body.status !== undefined) {
    const normalizedStatus = employeeStatusByLabel[String(body.status || "").trim()];
    if (!normalizedStatus) return { error: "invalid_employee_status" };
    patch.status = normalizedStatus;
    if (normalizedStatus === "LEAVED") {
      const parsed = parseDate(body.leaveDate || new Date().toISOString());
      if (parsed.error) return { error: parsed.error };
      patch.leaveDate = parsed.value;
    } else if (body.leaveDate !== undefined || normalizedStatus !== "LEAVED") {
      patch.leaveDate = null;
    }
  }
  if (body.leaveDate !== undefined && patch.status === undefined) {
    const parsed = parseDate(body.leaveDate);
    if (parsed.error) return { error: parsed.error };
    patch.leaveDate = parsed.value;
  }
  return { patch };
}

async function loadPeople(app, tenantId, revealSensitive, scopeWhere = {}) {
  const rows = await app.prisma.employee.findMany({
    where: { tenantId, ...scopeWhere },
    include: { department: true, user: true },
    orderBy: [
      { status: "asc" },
      { employeeNo: "asc" }
    ]
  });
  const serialized = rows.map((row) => serializeEmployee(row, revealSensitive));
  const employees = serialized.filter((row) => row.status === "在职");
  const inactiveEmployees = serialized.filter((row) => row.status === "停用");
  const leavers = serialized.filter((row) => row.status === "离职");
  const femaleEmployees = employees.filter((row) => row.gender === "女");
  const monthLeavers = leavers.filter((row) => row.leaveDate.startsWith("2026-05"));

  return {
    employees,
    inactiveEmployees,
    leavers,
    femaleEmployees,
    monthLeavers,
    orgStats: topCounts(employees, "org"),
    departmentStats: topCounts(employees, "department"),
    leaverDepartmentStats: topCounts(leavers, "department")
  };
}

function normalizeExportFilters(input = {}) {
  const filters = {};
  const status = employeeStatusByLabel[String(input.status || "").trim()];
  if (status) filters.status = status;
  ["department", "keyword", "month", "scope"].forEach((key) => {
    const value = input[key];
    if (typeof value === "string" && value.trim()) filters[key] = value.trim();
  });
  return filters;
}

function filterExportRows(rows, filters) {
  return rows.filter((row) => {
    if (filters.department && row.department !== filters.department) return false;
    if (filters.status && employeeStatusByLabel[row.status] !== filters.status) return false;
    if (filters.month && !String(row.leaveDate || "").startsWith(filters.month)) return false;
    if (filters.keyword && !Object.values(row).join(" ").includes(filters.keyword)) return false;
    return true;
  });
}

export async function registerPeopleRoutes(app) {
  app.get("/api/people", { preHandler: app.authenticate }, async (request, reply) => {
    const principal = await getPrincipal(app, request);
    const scopeWhere = employeeScopeWhere(principal, "read");
    const requestedRevealSensitive = request.query?.revealSensitive === "true";
    const revealSensitive = requestedRevealSensitive && hasPermission(principal, "employee", "sensitive");
    if (requestedRevealSensitive && !revealSensitive) {
      await appendAuditLog(app.prisma, {
        tenantId: request.user.tenantId,
        actorUserId: request.user.sub,
        action: "employee.sensitive.denied",
        objectType: "employee",
        summary: "敏感字段查看被拒绝",
        metadata: { result: "失败", reason: "permission_denied", fields: ["hukou", "school", "major"] },
        ...requestAuditMeta(request)
      });
      return reply.code(403).send({ error: "employee_sensitive_denied", message: "当前账号无权查看人员敏感字段。" });
    }
    const people = await loadPeople(app, request.user.tenantId, revealSensitive, scopeWhere);
    if (revealSensitive) {
      await appendAuditLog(app.prisma, {
        tenantId: request.user.tenantId,
        actorUserId: request.user.sub,
        action: "employee.sensitive.reveal",
        objectType: "employee",
        summary: "查看人员敏感字段",
        metadata: {
          result: "成功",
          fields: ["hukou", "school", "major"],
          returnedRows: people.employees.length + people.inactiveEmployees.length + people.leavers.length
        },
        ...requestAuditMeta(request)
      });
    }
    return { people };
  });

  app.get("/api/people/employees", { preHandler: app.authenticate }, async (request) => {
    const principal = await getPrincipal(app, request);
    const people = await loadPeople(app, request.user.tenantId, false, employeeScopeWhere(principal, "read"));
    return { employees: people.employees };
  });

  app.get("/api/people/leavers", { preHandler: app.authenticate }, async (request) => {
    const principal = await getPrincipal(app, request);
    const people = await loadPeople(app, request.user.tenantId, false, employeeScopeWhere(principal, "read"));
    return { leavers: people.leavers };
  });

  app.post("/api/people/export", { preHandler: app.authenticate }, async (request, reply) => {
    const principal = await getPrincipal(app, request);
    const filters = normalizeExportFilters(request.body?.filters || {});
    if (request.body?.includeSensitive) {
      await appendAuditLog(app.prisma, {
        tenantId: request.user.tenantId,
        actorUserId: request.user.sub,
        action: "employee.export.denied",
        objectType: "employee",
        summary: "拒绝导出人员敏感字段",
        metadata: { result: "失败", reason: "sensitive_export_disabled", filters },
        ...requestAuditMeta(request)
      });
      return reply.code(403).send({ error: "employee_sensitive_export_denied", message: "人员敏感字段不允许通过名册导出。" });
    }

    const scopeWhere = employeeScopeWhere(principal, "export");
    requireEmployeeAccess(principal, "export", {
      employeeId: principal.employeeId || "__export_probe_employee__",
      userId: principal.userId || "__export_probe_user__",
      departmentId: scopeWhere.departmentId || principal.departmentId || "__export_probe_department__"
    }, exportFieldKeys);
    const people = await loadPeople(app, request.user.tenantId, false, scopeWhere);
    const rows = filterExportRows([
      ...people.employees,
      ...people.inactiveEmployees,
      ...people.leavers
    ], filters);
    const csv = toCsv(rows);
    const scope = filters.scope || request.body?.scope || "人员名册";
    const businessReason = requireExportBusinessReason(request.body || {});
    const filename = `people-export-${timestampToken()}.csv`;

    await recordExportEvent(app.prisma, {
      tenantId: request.user.tenantId,
      actorUserId: request.user.sub,
      action: "employee.export",
      module: "people",
      objectType: "employee",
      fileName: filename,
      scope,
      businessReason,
      rowCount: rows.length,
      filters,
      summary: `导出${scope}，后端生成脱敏人员名册`,
      metadata: {
        scope,
        filters,
        fields: exportFieldKeys,
        format: "csv",
        rowCount: rows.length
      },
      ...requestAuditMeta(request)
    });

    return replyCsv(reply, csv, filename, rows.length);
  });

  app.patch("/api/people/employees/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const principal = await getPrincipal(app, request);
    const existing = await app.prisma.employee.findFirst({
      where: { id: request.params.id, tenantId: request.user.tenantId },
      include: { department: true, user: true }
    });
    if (!existing) return reply.code(404).send({ error: "employee_not_found" });

    const normalized = normalizeEmployeePatch(request.body || {});
    if (normalized.error) return reply.code(400).send({ error: normalized.error });
    const patch = normalized.patch || {};
    const requestedPatchFields = new Set(Object.keys(patch));
    if (request.body?.department !== undefined || request.body?.departmentName !== undefined) {
      requestedPatchFields.add("departmentId");
    }
    if (requestedPatchFields.size > 0) {
      requireEmployeeAccess(principal, "write", employeeResource(existing), [...requestedPatchFields]);
    }
    if (request.body?.department !== undefined || request.body?.departmentName !== undefined) {
      const departmentName = String(request.body.departmentName ?? request.body.department ?? "").trim();
      if (!departmentName) {
        patch.departmentId = null;
      } else {
        const department = await app.prisma.department.findFirst({
          where: { tenantId: request.user.tenantId, name: departmentName }
        });
        if (!department) return reply.code(400).send({ error: "department_not_found" });
        patch.departmentId = department.id;
      }
    }
    if (Object.keys(patch).length === 0) return reply.code(400).send({ error: "employee_patch_empty" });

    const updated = await app.prisma.$transaction(async (tx) => {
      const row = await tx.employee.update({
        where: { id: existing.id },
        data: patch,
        include: { department: true }
      });
      await appendAuditLog(tx, {
        tenantId: request.user.tenantId,
        actorUserId: request.user.sub,
        action: "employee.update",
        objectType: "employee",
        objectId: existing.id,
        summary: `更新员工 ${existing.name} 档案`,
        metadata: {
          employeeNo: existing.employeeNo,
          before: {
            department: existing.department?.name || "",
            roleTitle: existing.roleTitle || "",
            status: existing.status,
            leaveDate: formatDate(existing.leaveDate)
          },
          after: {
            department: row.department?.name || "",
            roleTitle: row.roleTitle || "",
            status: row.status,
            leaveDate: formatDate(row.leaveDate)
          }
        },
        ...requestAuditMeta(request)
      });
      return row;
    });

    return { employee: serializeEmployee(updated, false) };
  });
}
