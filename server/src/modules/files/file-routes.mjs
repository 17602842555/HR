import { createHash, randomUUID } from "node:crypto";
import { basename, extname } from "node:path";
import { appendAuditLog, requestAuditMeta } from "../audit/audit-service.mjs";
import { boundedQueryLimit } from "../../lib/pagination.mjs";
import { isUnsafeStorageKeyError } from "../../lib/file-storage.mjs";
import { requirePermission } from "../iam/route-guards.mjs";

const ALLOWED_VISIBILITY = new Set(["PRIVATE", "TENANT", "PUBLIC"]);
const BLOCKED_FILE_EXTENSIONS = new Set([".bat", ".cmd", ".cjs", ".exe", ".hta", ".htm", ".html", ".jar", ".js", ".mjs", ".php", ".ps1", ".sh", ".svg", ".vbs", ".wsf"]);
const BLOCKED_MIME_TYPES = new Set([
  "application/ecmascript",
  "application/javascript",
  "application/x-msdownload",
  "application/x-sh",
  "image/svg+xml",
  "text/ecmascript",
  "text/html",
  "text/javascript"
]);

function sanitizeFileName(fileName) {
  const name = basename(String(fileName || "attachment.bin")).replace(/[^\w.\-\u4e00-\u9fa5]/g, "_");
  return name.slice(0, 120) || "attachment.bin";
}

function contentDisposition(fileName) {
  const safeName = sanitizeFileName(fileName);
  const asciiFallback = safeName.replace(/[^\x20-\x7E]/g, "_").replaceAll("\"", "_") || "attachment.bin";
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(safeName)}`;
}

function sanitizeMimeType(value) {
  const raw = String(value || "application/octet-stream").split(";")[0].trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(raw)) {
    return "application/octet-stream";
  }
  return raw.slice(0, 160);
}

function isBlockedFileType(fileName, mimeType) {
  return BLOCKED_FILE_EXTENSIONS.has(extname(fileName).toLowerCase()) || BLOCKED_MIME_TYPES.has(sanitizeMimeType(mimeType));
}

function decodeContentBase64(value) {
  const raw = String(value || "");
  const normalized = raw.includes(",") ? raw.slice(raw.indexOf(",") + 1) : raw;
  if (!normalized.trim()) return null;
  return Buffer.from(normalized, "base64");
}

function checksum(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function storageKeyFor(tenantId) {
  const date = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  return `${tenantId}/${date}/${randomUUID()}`;
}

function serializeFile(file) {
  return {
    id: file.id,
    fileName: file.fileName,
    mimeType: file.mimeType,
    sizeBytes: Number(file.sizeBytes || 0),
    checksum: file.checksum || "",
    visibility: file.visibility,
    workflowInstanceId: file.workflowInstanceId || null,
    assetId: file.assetId || null,
    uploader: file.uploader ? {
      id: file.uploader.id,
      name: file.uploader.name,
      email: file.uploader.email
    } : null,
    createdAt: file.createdAt ? new Date(file.createdAt).toISOString() : ""
  };
}

async function assertLinkedRecords(app, request, reply, body) {
  if (body.workflowInstanceId) {
    const workflow = await app.prisma.workflowInstance.findFirst({
      where: { id: body.workflowInstanceId, tenantId: request.user.tenantId }
    });
    if (!workflow) {
      reply.code(404).send({ error: "workflow_not_found" });
      return false;
    }
  }

  if (body.assetId) {
    const asset = await app.prisma.asset.findFirst({
      where: { id: body.assetId, tenantId: request.user.tenantId }
    });
    if (!asset) {
      reply.code(404).send({ error: "asset_not_found" });
      return false;
    }
  }

  return true;
}

async function loadFileForTenant(app, request, reply) {
  const file = await app.prisma.fileObject.findFirst({
    where: { id: request.params.id, tenantId: request.user.tenantId },
    include: { uploader: true }
  });
  if (!file) {
    reply.code(404).send({ error: "file_not_found" });
    return null;
  }
  return file;
}

async function appendFileUploadDeniedAudit(app, request, { fileName, mimeType, reason }) {
  return appendAuditLog(app.prisma, {
    tenantId: request.user.tenantId,
    actorUserId: request.user.sub,
    action: "file.upload.denied",
    objectType: "file",
    summary: `拒绝上传高风险附件 ${fileName}`,
    metadata: {
      fileName,
      mimeType,
      reason,
      result: "失败"
    },
    ...requestAuditMeta(request)
  });
}

async function appendFileDownloadDeniedAudit(app, request, { file, reason, metadata = {} }) {
  return appendAuditLog(app.prisma, {
    tenantId: request.user.tenantId,
    actorUserId: request.user.sub,
    action: "file.download.denied",
    objectType: "file",
    objectId: file?.id || null,
    summary: `拒绝下载异常附件 ${file?.fileName || ""}`.trim(),
    metadata: {
      fileName: file?.fileName,
      reason,
      result: "失败",
      ...metadata
    },
    ...requestAuditMeta(request)
  });
}

export async function registerFileRoutes(app) {
  app.get("/api/files", { preHandler: app.authenticate }, async (request) => {
    await requirePermission(app, request, { module: "file", action: "read" });
    const files = await app.prisma.fileObject.findMany({
      where: { tenantId: request.user.tenantId },
      include: { uploader: true },
      orderBy: { createdAt: "desc" },
      take: boundedQueryLimit(request.query?.limit, { fallback: 100, max: 500 })
    });
    return { files: files.map(serializeFile) };
  });

  app.post("/api/files", { preHandler: app.authenticate }, async (request, reply) => {
    await requirePermission(app, request, { module: "file", action: "upload" });
    const body = request.body || {};
    const fileName = sanitizeFileName(body.fileName);
    const mimeType = sanitizeMimeType(body.mimeType);
    const visibility = ALLOWED_VISIBILITY.has(body.visibility) ? body.visibility : "PRIVATE";
    const content = decodeContentBase64(body.contentBase64);

    if (!content) {
      return reply.code(400).send({ error: "file_content_required" });
    }
    if (isBlockedFileType(fileName, mimeType)) {
      await appendFileUploadDeniedAudit(app, request, {
        fileName,
        mimeType,
        reason: "blocked_file_type"
      });
      return reply.code(415).send({ error: "file_type_not_allowed", message: "该附件类型不允许上传。" });
    }
    if (content.length > app.config.fileMaxUploadBytes) {
      return reply.code(413).send({
        error: "file_too_large",
        maxBytes: app.config.fileMaxUploadBytes
      });
    }
    if (!(await assertLinkedRecords(app, request, reply, body))) return reply;

    const storageKey = storageKeyFor(request.user.tenantId);
    await app.fileStorage.put(storageKey, content);

    let file;
    try {
      file = await app.prisma.$transaction(async (tx) => {
        const created = await tx.fileObject.create({
          data: {
            tenantId: request.user.tenantId,
            uploaderUserId: request.user.sub,
            workflowInstanceId: body.workflowInstanceId || null,
            assetId: body.assetId || null,
            fileName,
            mimeType,
            storageKey,
            sizeBytes: BigInt(content.length),
            checksum: checksum(content),
            visibility
          },
          include: { uploader: true }
        });

        await appendAuditLog(tx, {
          tenantId: request.user.tenantId,
          actorUserId: request.user.sub,
          action: "file.upload",
          objectType: "file",
          objectId: created.id,
          summary: `上传附件 ${created.fileName}`,
          metadata: {
            assetId: created.assetId,
            checksum: created.checksum,
            fileName: created.fileName,
            mimeType: created.mimeType,
            sizeBytes: Number(created.sizeBytes),
            visibility: created.visibility,
            workflowInstanceId: created.workflowInstanceId
          },
          ...requestAuditMeta(request)
        });

        return created;
      });
    } catch (error) {
      await app.fileStorage.delete(storageKey).catch(() => {});
      throw error;
    }

    return reply.code(201).send({ file: serializeFile(file) });
  });

  app.get("/api/files/:id/download", { preHandler: app.authenticate }, async (request, reply) => {
    await requirePermission(app, request, { module: "file", action: "read" });
    const file = await loadFileForTenant(app, request, reply);
    if (!file) return reply;

    let content;
    try {
      content = await app.fileStorage.get(file.storageKey);
    } catch (error) {
      if (!isUnsafeStorageKeyError(error)) {
        return reply.code(404).send({ error: "file_content_missing" });
      }
      await appendFileDownloadDeniedAudit(app, request, { file, reason: "unsafe_storage_key" });
      return reply.code(404).send({ error: "file_content_missing" });
    }

    const actualChecksum = checksum(content);
    if (file.checksum && actualChecksum !== file.checksum) {
      await appendFileDownloadDeniedAudit(app, request, {
        file,
        reason: "checksum_mismatch",
        metadata: {
          actualChecksum,
          expectedChecksum: file.checksum
        }
      });
      return reply.code(409).send({ error: "file_checksum_mismatch" });
    }

    await appendAuditLog(app.prisma, {
      tenantId: request.user.tenantId,
      actorUserId: request.user.sub,
      action: "file.download",
      objectType: "file",
      objectId: file.id,
      summary: `下载附件 ${file.fileName}`,
      metadata: {
        checksum: file.checksum,
        fileName: file.fileName,
        mimeType: file.mimeType,
        sizeBytes: Number(file.sizeBytes),
        visibility: file.visibility
      },
      ...requestAuditMeta(request)
    });

    return reply
      .header("Content-Type", file.mimeType)
      .header("Content-Disposition", contentDisposition(file.fileName))
      .header("Cache-Control", "no-store")
      .send(content);
  });
}
