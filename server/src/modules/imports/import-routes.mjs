import { createHash, randomUUID } from "node:crypto";
import { basename } from "node:path";
import { loadDashboardPeopleFromHtml } from "../../../../scripts/dashboard-data.mjs";
import { appendAuditLog, requestAuditMeta } from "../audit/audit-service.mjs";
import { boundedQueryLimit } from "../../lib/pagination.mjs";
import { requirePermission } from "../iam/route-guards.mjs";

function sanitizeFileName(fileName) {
  const name = basename(String(fileName || "oa-dashboard.html")).replace(/[^\w.\-\u4e00-\u9fa5]/g, "_");
  return name.slice(0, 120) || "oa-dashboard.html";
}

function contentDisposition(fileName) {
  const safeName = sanitizeFileName(fileName);
  const asciiFallback = safeName.replace(/[^\x20-\x7E]/g, "_").replaceAll("\"", "_") || "oa-dashboard.html";
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(safeName)}`;
}

function serializeImportMetadata(metadata = {}) {
  const sourceArtifact = metadata?.sourceArtifact && typeof metadata.sourceArtifact === "object"
    ? metadata.sourceArtifact
    : null;
  if (!sourceArtifact) return metadata || {};
  return {
    ...metadata,
    sourceArtifact: {
      checksum: sourceArtifact.checksum || "",
      downloadAvailable: Boolean(sourceArtifact.storageKey),
      fileName: sourceArtifact.fileName || "",
      mimeType: sourceArtifact.mimeType || "text/html",
      sizeBytes: Number(sourceArtifact.sizeBytes || 0),
      storedAt: sourceArtifact.storedAt || ""
    }
  };
}

function serializeImportRun(run) {
  return {
    id: run.id,
    sourceType: run.sourceType,
    sourceName: run.sourceName,
    sourceChecksum: run.sourceChecksum,
    status: run.status,
    recordCounts: run.recordCounts || {},
    metadata: serializeImportMetadata(run.metadata || {}),
    startedAt: run.startedAt ? new Date(run.startedAt).toISOString() : "",
    finishedAt: run.finishedAt ? new Date(run.finishedAt).toISOString() : "",
    actor: run.actor ? {
      id: run.actor.id,
      name: run.actor.name,
      email: run.actor.email
    } : null
  };
}

function decodeHtmlPayload(body = {}) {
  if (typeof body.html === "string" && body.html.trim()) return { html: body.html };
  if (typeof body.contentBase64 === "string" && body.contentBase64.trim()) {
    try {
      return { html: Buffer.from(body.contentBase64, "base64").toString("utf8") };
    } catch {
      return { error: "invalid_import_content" };
    }
  }
  return { error: "import_content_required" };
}

function normalizeSourceName(value) {
  const name = sanitizeFileName(String(value || "oa-dashboard.html").trim());
  return name.endsWith(".html") ? name : `${name}.html`;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function importSourceStorageKey(tenantId) {
  const date = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  return `${tenantId}/imports/${date}/${randomUUID()}.html-source`;
}

async function preserveImportSourceArtifact(app, request, { html, sourceName, sourceChecksum, sizeBytes }) {
  const storageKey = importSourceStorageKey(request.user.tenantId);
  await app.fileStorage.put(storageKey, Buffer.from(html, "utf8"));
  return {
    checksum: sourceChecksum,
    fileName: sourceName,
    mimeType: "text/html",
    sizeBytes,
    storageKey,
    storedAt: new Date().toISOString()
  };
}

function isDuplicateImportConstraintError(error) {
  const text = `${error?.message || ""} ${JSON.stringify(error?.meta || {})}`;
  return error?.code === "P2002" || text.includes("data_import_runs_success_unique");
}

function findSuccessfulImport(prisma, tenantId, sourceName, sourceChecksum) {
  return prisma.dataImportRun.findFirst({
    where: {
      tenantId,
      sourceName,
      sourceChecksum,
      status: "SUCCESS"
    },
    include: { actor: true }
  });
}

async function sendDuplicateImportResponse(prisma, request, reply, existingImport, sourceName, sourceChecksum) {
  await appendAuditLog(prisma, {
    tenantId: request.user.tenantId,
    actorUserId: request.user.sub,
    action: "import.dashboard_html.duplicate",
    objectType: "data_import",
    objectId: existingImport.id,
    summary: `拒绝重复导入 ${sourceName}`,
    metadata: {
      duplicateOf: existingImport.id,
      sourceName,
      sourceChecksum
    },
    ...requestAuditMeta(request)
  });
  return reply.code(409).send({
    error: "duplicate_import",
    importRun: serializeImportRun(existingImport),
    people: existingImport.recordCounts || {}
  });
}

async function appendImportDeniedAudit(prisma, request, { sourceName, reason, sizeBytes }) {
  return appendAuditLog(prisma, {
    tenantId: request.user.tenantId,
    actorUserId: request.user.sub,
    action: "import.dashboard_html.denied",
    objectType: "data_import",
    summary: `拒绝导入人员数据 ${sourceName}`,
    metadata: {
      reason,
      result: "失败",
      sizeBytes,
      sourceName
    },
    ...requestAuditMeta(request)
  });
}

async function appendImportSourceDeniedAudit(prisma, request, { run, reason, metadata = {} }) {
  return appendAuditLog(prisma, {
    tenantId: request.user.tenantId,
    actorUserId: request.user.sub,
    action: "import.dashboard_html.source_download.denied",
    objectType: "data_import",
    objectId: run?.id || null,
    summary: `拒绝下载导入源文件 ${run?.sourceName || ""}`.trim(),
    metadata: {
      reason,
      result: "失败",
      sourceName: run?.sourceName,
      sourceChecksum: run?.sourceChecksum,
      ...metadata
    },
    ...requestAuditMeta(request)
  });
}

function dateOrNull(value) {
  if (!value) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function dashboardDepartmentCode(name) {
  return `DASH-${Buffer.from(name).toString("hex").slice(0, 18).toUpperCase()}`;
}

function sourcePrefix(sourceName) {
  if (sourceName === "oa-dashboard.html") return "DASH";
  return `IMP-${sha256(sourceName).slice(0, 8).toUpperCase()}`;
}

function employeeNoFor(person, status, index, sourceName) {
  const prefix = sourcePrefix(sourceName);
  if (status === "ACTIVE") {
    return `EMP-${prefix}-${String(person.seq || index + 1).padStart(4, "0")}`;
  }
  return `LEV-${prefix}-${String(index + 1).padStart(4, "0")}`;
}

function recordCountsFor(people) {
  return {
    activeEmployees: people.employees.length,
    femaleEmployees: people.femaleEmployees.length,
    leavers: people.leavers.length,
    monthLeavers: people.monthLeavers.length,
    totalRows: people.employees.length + people.leavers.length
  };
}

async function ensureDashboardDepartments(tx, tenantId, people) {
  const names = [...new Set([
    ...people.employees.map((item) => item.department),
    ...people.leavers.map((item) => item.department)
  ].filter(Boolean))];
  const existing = await tx.department.findMany({ where: { tenantId } });
  const byName = new Map(existing.map((department) => [department.name, department]));

  let sortOrder = existing.length + 1;
  for (const name of names) {
    if (byName.has(name)) continue;
    const department = await tx.department.upsert({
      where: { tenantId_code: { tenantId, code: dashboardDepartmentCode(name) } },
      update: { name, sortOrder },
      create: { tenantId, code: dashboardDepartmentCode(name), name, sortOrder }
    });
    byName.set(name, department);
    sortOrder += 1;
  }
  return byName;
}

async function upsertImportedEmployees(tx, tenantId, people, departmentsByName, sourceName) {
  const rows = [
    ...people.employees.map((person, index) => ({
      employeeNo: employeeNoFor(person, "ACTIVE", index, sourceName),
      person,
      status: "ACTIVE"
    })),
    ...people.leavers.map((person, index) => ({
      employeeNo: employeeNoFor(person, "LEAVED", index, sourceName),
      person,
      status: "LEAVED"
    }))
  ];

  for (const row of rows) {
    const departmentId = departmentsByName.get(row.person.department)?.id || null;
    const data = {
      name: row.person.name,
      gender: row.person.gender || null,
      roleTitle: row.person.role || null,
      departmentId,
      status: row.status,
      entryDate: dateOrNull(row.person.entryDate),
      leaveDate: dateOrNull(row.person.leaveDate),
      sensitiveInfo: {
        org: row.person.org,
        seq: row.person.seq,
        regularDate: row.person.regularDate,
        age: row.person.age,
        hukou: row.person.hukou,
        education: row.person.education,
        school: row.person.school,
        major: row.person.major,
        source: sourceName
      }
    };
    await tx.employee.upsert({
      where: { tenantId_employeeNo: { tenantId, employeeNo: row.employeeNo } },
      update: data,
      create: { tenantId, employeeNo: row.employeeNo, ...data }
    });
  }
}

export async function registerImportRoutes(app) {
  app.get("/api/imports", { preHandler: app.authenticate }, async (request) => {
    await requirePermission(app, request, { module: "import", action: "read" });
    const importRuns = await app.prisma.dataImportRun.findMany({
      where: { tenantId: request.user.tenantId },
      include: { actor: true },
      orderBy: { startedAt: "desc" },
      take: boundedQueryLimit(request.query?.limit, { fallback: 50, max: 200 })
    });
    return { importRuns: importRuns.map(serializeImportRun) };
  });

  app.get("/api/imports/:id/source", { preHandler: app.authenticate }, async (request, reply) => {
    await requirePermission(app, request, { module: "import", action: "read" });
    const run = await app.prisma.dataImportRun.findFirst({
      where: { id: request.params.id, tenantId: request.user.tenantId },
      include: { actor: true }
    });
    if (!run) return reply.code(404).send({ error: "import_run_not_found" });

    const artifact = run.metadata?.sourceArtifact;
    if (!artifact?.storageKey) {
      await appendImportSourceDeniedAudit(app.prisma, request, { run, reason: "source_artifact_missing" });
      return reply.code(404).send({ error: "source_artifact_missing" });
    }

    let content;
    try {
      content = await app.fileStorage.get(artifact.storageKey);
    } catch {
      await appendImportSourceDeniedAudit(app.prisma, request, { run, reason: "source_artifact_missing_on_disk" });
      return reply.code(404).send({ error: "source_artifact_missing" });
    }

    const actualChecksum = sha256(content);
    const expectedChecksum = artifact.checksum || run.sourceChecksum;
    if (expectedChecksum && actualChecksum !== expectedChecksum) {
      await appendImportSourceDeniedAudit(app.prisma, request, {
        run,
        reason: "source_artifact_checksum_mismatch",
        metadata: { actualChecksum, expectedChecksum }
      });
      return reply.code(409).send({ error: "source_artifact_checksum_mismatch" });
    }

    await appendAuditLog(app.prisma, {
      tenantId: request.user.tenantId,
      actorUserId: request.user.sub,
      action: "import.dashboard_html.source_download",
      objectType: "data_import",
      objectId: run.id,
      summary: `下载导入源文件 ${run.sourceName}`,
      metadata: {
        sourceName: run.sourceName,
        sourceChecksum: run.sourceChecksum,
        sizeBytes: Number(artifact.sizeBytes || content.length)
      },
      ...requestAuditMeta(request)
    });

    return reply
      .header("Content-Type", "application/octet-stream")
      .header("Content-Disposition", contentDisposition(artifact.fileName || run.sourceName))
      .header("Cache-Control", "no-store")
      .send(content);
  });

  app.post("/api/imports/dashboard-html", { preHandler: app.authenticate }, async (request, reply) => {
    await requirePermission(app, request, { module: "import", action: "write" });
    const sourceName = normalizeSourceName(request.body?.sourceName);
    const decoded = decodeHtmlPayload(request.body || {});
    if (decoded.error) {
      await appendImportDeniedAudit(app.prisma, request, { sourceName, reason: decoded.error, sizeBytes: 0 });
      return reply.code(400).send({ error: decoded.error });
    }

    const html = decoded.html;
    const sizeBytes = Buffer.byteLength(html, "utf8");
    if (sizeBytes > app.config.importMaxHtmlBytes) {
      await appendImportDeniedAudit(app.prisma, request, { sourceName, reason: "import_content_too_large", sizeBytes });
      return reply.code(413).send({ error: "import_content_too_large" });
    }

    const sourceChecksum = sha256(html);
    const existingImport = await findSuccessfulImport(app.prisma, request.user.tenantId, sourceName, sourceChecksum);
    if (existingImport) {
      return sendDuplicateImportResponse(app.prisma, request, reply, existingImport, sourceName, sourceChecksum);
    }

    const people = loadDashboardPeopleFromHtml(html);
    const recordCounts = recordCountsFor(people);
    if (recordCounts.totalRows === 0) {
      await appendImportDeniedAudit(app.prisma, request, { sourceName, reason: "dashboard_import_empty", sizeBytes });
      return reply.code(400).send({ error: "dashboard_import_empty" });
    }

    const sourceArtifact = await preserveImportSourceArtifact(app, request, { html, sourceName, sourceChecksum, sizeBytes });
    let importRun;
    try {
      importRun = await app.prisma.$transaction(async (tx) => {
        const departmentsByName = await ensureDashboardDepartments(tx, request.user.tenantId, people);
        await upsertImportedEmployees(tx, request.user.tenantId, people, departmentsByName, sourceName);

        const data = {
          actorUserId: request.user.sub,
          sourceType: "html-dashboard",
          sourceName,
          sourceChecksum,
          status: "SUCCESS",
          recordCounts,
          metadata: {
            importedTables: ["employees", "departments"],
            parser: "scripts/dashboard-data.mjs",
            runtimeImport: true,
            sourceArtifact
          },
          finishedAt: new Date()
        };
        const run = await tx.dataImportRun.create({ data: { tenantId: request.user.tenantId, ...data } });

        await appendAuditLog(tx, {
          tenantId: request.user.tenantId,
          actorUserId: request.user.sub,
          action: "import.dashboard_html",
          objectType: "data_import",
          objectId: run.id,
          summary: `导入人员数据 ${sourceName}，共 ${recordCounts.totalRows} 行`,
          metadata: {
            sourceName,
            sourceChecksum,
            recordCounts,
            sourceArtifact: serializeImportMetadata({ sourceArtifact }).sourceArtifact
          },
          ...requestAuditMeta(request)
        });
        return run;
      });
    } catch (error) {
      await app.fileStorage.delete(sourceArtifact.storageKey).catch(() => {});
      if (isDuplicateImportConstraintError(error)) {
        const racedImport = await findSuccessfulImport(app.prisma, request.user.tenantId, sourceName, sourceChecksum);
        if (racedImport) {
          return sendDuplicateImportResponse(app.prisma, request, reply, racedImport, sourceName, sourceChecksum);
        }
      }
      throw error;
    }

    return {
      importRun: serializeImportRun(importRun),
      people: recordCounts
    };
  });
}
