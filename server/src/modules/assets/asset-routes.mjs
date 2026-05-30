import { appendAuditLog, recordExportEvent, requestAuditMeta, requireExportBusinessReason } from "../audit/audit-service.mjs";
import { requirePermission } from "../iam/route-guards.mjs";
import QRCode from "qrcode";

const statusToLabel = {
  AVAILABLE: "空闲",
  BORROWED: "借用中",
  IN_USE: "使用中",
  REPAIRING: "维修中",
  RETIRED: "已退役"
};

const labelToStatus = {
  空闲: "AVAILABLE",
  借用中: "BORROWED",
  使用中: "IN_USE",
  维修中: "REPAIRING",
  固定资产: "IN_USE",
  已退役: "RETIRED"
};
const validAssetStatuses = new Set(Object.keys(statusToLabel));

const exportColumns = Object.freeze([
  ["id", "资产编号"],
  ["name", "资产名称"],
  ["category", "类别"],
  ["owner", "使用人/区域"],
  ["status", "状态"],
  ["location", "位置"],
  ["qrVersion", "二维码版本"],
  ["lastInventoryAt", "最近盘点时间"],
  ["inventoryResult", "最近盘点结果"]
]);

const assetActionAliases = {
  borrow: "borrow",
  return: "return",
  repair: "repair",
  inventory: "inventory",
  retire: "retire",
  借用: "borrow",
  归还: "return",
  维修: "repair",
  盘点: "inventory",
  退役: "retire"
};

const assetLifecycleActions = {
  borrow: {
    auditType: "borrow",
    label: "借用",
    targetStatus: "BORROWED",
    allowedFrom: ["AVAILABLE"],
    defaultOwner: "张三",
    defaultLocation: "使用人保管"
  },
  return: {
    auditType: "return",
    label: "归还",
    targetStatus: "AVAILABLE",
    allowedFrom: ["BORROWED", "IN_USE", "REPAIRING"],
    defaultOwner: "设备库",
    defaultLocation: "集团总部 · 设备库"
  },
  repair: {
    auditType: "repair",
    label: "维修",
    targetStatus: "REPAIRING",
    allowedFrom: ["AVAILABLE", "BORROWED", "IN_USE"],
    defaultLocation: "IT维修区"
  },
  inventory: {
    auditType: "inventory",
    label: "盘点",
    targetStatus: null,
    allowedFrom: ["AVAILABLE", "BORROWED", "IN_USE", "REPAIRING"]
  },
  retire: {
    auditType: "retire",
    label: "退役",
    targetStatus: "RETIRED",
    allowedFrom: ["AVAILABLE", "REPAIRING"],
    defaultOwner: "设备库",
    defaultLocation: "资产处置区"
  }
};

function assetPrefix(category = "") {
  if (category.includes("直播")) return "LIVE";
  if (category.includes("电脑") || category.includes("IT")) return "IT";
  return "ADM";
}

function formatDateTime(value) {
  if (!value) return "";
  return new Date(value).toLocaleString("sv-SE", { hour12: false }).replace("T", " ").slice(0, 19);
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
  ["category", "status", "keyword", "scope"].forEach((key) => {
    const value = input[key];
    if (typeof value === "string" && value.trim()) filters[key] = value.trim();
  });
  return filters;
}

function assetExportWhere(tenantId, filters = {}) {
  const where = { tenantId };
  const status = normalizeAssetStatus(filters.status, "");
  if (status) where.status = status;
  if (filters.category) where.category = filters.category;
  if (filters.keyword) {
    where.OR = [
      { assetNo: { contains: filters.keyword } },
      { name: { contains: filters.keyword } },
      { owner: { contains: filters.keyword } },
      { location: { contains: filters.keyword } }
    ];
  }
  return where;
}

function serializeAsset(asset) {
  return {
    id: asset.assetNo,
    dbId: asset.id,
    name: asset.name,
    category: asset.category,
    owner: asset.owner || "设备库",
    status: statusToLabel[asset.status] || asset.status,
    location: asset.location || "设备库",
    qrVersion: asset.qrVersion,
    qrPayload: assetQrPayload(asset),
    lastInventoryAt: asset.metadata?.lastInventoryAt ? formatDateTime(asset.metadata.lastInventoryAt) : "",
    inventoryResult: asset.metadata?.lastInventoryResult || ""
  };
}

function assetQrPayload(asset) {
  return JSON.stringify({
    type: "oa.asset",
    assetNo: asset.assetNo,
    name: asset.name,
    category: asset.category,
    qrVersion: asset.qrVersion
  });
}

async function serializeAssetWithQr(asset) {
  const payload = assetQrPayload(asset);
  const qrImage = await QRCode.toDataURL(payload, {
    color: {
      dark: "#0f172a",
      light: "#ffffff"
    },
    errorCorrectionLevel: "M",
    margin: 1,
    width: 160
  });
  return {
    ...serializeAsset(asset),
    qrImage
  };
}

async function nextAssetNo(prisma, tenantId, category) {
  const prefix = assetPrefix(category);
  const year = new Date().getFullYear();
  const count = await prisma.asset.count({
    where: {
      tenantId,
      assetNo: { startsWith: `${prefix}-${year}-` }
    }
  });
  return `${prefix}-${year}-${String(count + 1).padStart(6, "0")}`;
}

async function appendAssetAudit(prisma, request, asset, type, content, result = "成功", metadata = {}) {
  return appendAuditLog(prisma, {
    tenantId: request.user.tenantId,
    actorUserId: request.user.sub,
    action: `asset.${type}`,
    objectType: "asset",
    objectId: asset.id,
    summary: content,
    metadata: {
      assetId: asset.assetNo,
      type,
      result,
      name: asset.name,
      status: statusToLabel[asset.status] || asset.status,
      ...metadata
    },
    ...requestAuditMeta(request)
  });
}

function normalizeAssetAction(value) {
  return assetActionAliases[String(value || "").trim()] || "";
}

function normalizeAssetStatus(value, fallback = "AVAILABLE") {
  const text = String(value ?? "").trim();
  if (!text) return fallback;
  const status = labelToStatus[text] || text;
  return validAssetStatuses.has(status) ? status : "";
}

function assetWhere(tenantId, assetNo) {
  return { tenantId_assetNo: { tenantId, assetNo } };
}

function assetHistory(asset, event) {
  const current = Array.isArray(asset.metadata?.history) ? asset.metadata.history : [];
  return [event, ...current].slice(0, 50);
}

export async function registerAssetRoutes(app) {
  app.get("/api/assets", { preHandler: app.authenticate }, async (request) => {
    await requirePermission(app, request, { module: "asset", action: "read" });
    const assets = await app.prisma.asset.findMany({
      where: { tenantId: request.user.tenantId },
      orderBy: { createdAt: "desc" }
    });
    return { assets: await Promise.all(assets.map(serializeAssetWithQr)) };
  });

  app.post("/api/assets", { preHandler: app.authenticate }, async (request, reply) => {
    await requirePermission(app, request, { module: "asset", action: "write" });
    const body = request.body || {};
    const status = normalizeAssetStatus(body.status);
    if (!status) {
      return reply.code(400).send({ error: "invalid_asset_status", message: "资产状态必须是空闲、借用中、使用中、维修中或已退役。" });
    }
    const assetNo = await nextAssetNo(app.prisma, request.user.tenantId, body.category || "行政固定资产");
    const asset = await app.prisma.asset.create({
      data: {
        tenantId: request.user.tenantId,
        assetNo,
        name: body.name || "未命名资产",
        category: body.category || "行政固定资产",
        owner: body.owner || "设备库",
        location: body.location || "设备库",
        status,
        metadata: body.metadata || {}
      }
    });
    await appendAssetAudit(app.prisma, request, asset, "create", `录入资产 ${asset.name} 并生成二维码`);
    return reply.code(201).send({ asset: await serializeAssetWithQr(asset) });
  });

  app.post("/api/assets/export", { preHandler: app.authenticate }, async (request, reply) => {
    await requirePermission(app, request, { module: "asset", action: "export" });
    const filters = normalizeExportFilters(request.body?.filters || {});
    const scope = request.body?.scope || filters.scope || "资产台账";
    const assets = await app.prisma.asset.findMany({
      where: assetExportWhere(request.user.tenantId, filters),
      orderBy: { createdAt: "desc" },
      take: 5000
    });
    const rows = assets.map(serializeAsset);
    const csv = toCsv(rows);
    const businessReason = requireExportBusinessReason(request.body || {});
    const filename = `asset-ledger-export-${timestampToken()}.csv`;

    await recordExportEvent(app.prisma, {
      tenantId: request.user.tenantId,
      actorUserId: request.user.sub,
      action: "asset.export",
      module: "asset",
      objectType: "asset",
      fileName: filename,
      scope,
      businessReason,
      rowCount: rows.length,
      filters,
      summary: `导出${scope}，后端生成资产台账`,
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

  app.patch("/api/assets/:id", { preHandler: app.authenticate }, async (request, reply) => {
    await requirePermission(app, request, { module: "asset", action: "write" });
    const body = request.body || {};
    const current = await app.prisma.asset.findUnique({ where: assetWhere(request.user.tenantId, request.params.id) });
    if (!current) return reply.code(404).send({ error: "asset_not_found" });
    const hasStatus = Object.prototype.hasOwnProperty.call(body, "status");
    const status = hasStatus ? normalizeAssetStatus(body.status, "") : undefined;
    if (hasStatus && !status) {
      return reply.code(400).send({
        error: "invalid_asset_status",
        message: "资产状态必须是空闲、借用中、使用中、维修中或已退役。"
      });
    }
    const asset = await app.prisma.asset.update({
      where: assetWhere(request.user.tenantId, request.params.id),
      data: {
        owner: body.owner,
        status,
        location: body.status === "空闲" ? "集团总部 · 设备库" : body.status === "维修中" ? "IT维修区" : undefined
      }
    });
    await appendAssetAudit(app.prisma, request, asset, "update", `${asset.name} 状态变更为 ${statusToLabel[asset.status] || asset.status}`);
    return { asset: await serializeAssetWithQr(asset) };
  });

  app.post("/api/assets/:id/actions", { preHandler: app.authenticate }, async (request, reply) => {
    await requirePermission(app, request, { module: "asset", action: "write" });
    const body = request.body || {};
    const normalizedAction = normalizeAssetAction(body.action);
    const config = assetLifecycleActions[normalizedAction];
    if (!config) {
      return reply.code(400).send({ error: "invalid_asset_action", message: "资产动作必须是 borrow/return/repair/inventory/retire。" });
    }

    const result = await app.prisma.$transaction(async (tx) => {
      const asset = await tx.asset.findUnique({ where: assetWhere(request.user.tenantId, request.params.id) });
      if (!asset) return null;
      const operator = String(request.user.name || request.user.email || "系统用户").trim();

      if (!config.allowedFrom.includes(asset.status)) {
        await appendAssetAudit(tx, request, asset, config.auditType, `${asset.name} 当前状态不允许${config.label}`, "失败", {
          action: normalizedAction,
          operator,
          fromStatus: statusToLabel[asset.status] || asset.status,
          allowedFrom: config.allowedFrom.map((status) => statusToLabel[status] || status)
        });
        return { invalidTransition: true, asset };
      }

      const operatedAt = new Date();
      const event = {
        action: normalizedAction,
        label: config.label,
        operator,
        at: operatedAt.toISOString(),
        fromStatus: statusToLabel[asset.status] || asset.status,
        toStatus: config.targetStatus ? statusToLabel[config.targetStatus] || config.targetStatus : statusToLabel[asset.status] || asset.status,
        note: String(body.note || body.result || "").trim()
      };
      const metadata = {
        ...(asset.metadata || {}),
        history: assetHistory(asset, event)
      };
      if (normalizedAction === "inventory") {
        metadata.lastInventoryAt = operatedAt.toISOString();
        metadata.lastInventoryResult = String(body.result || "正常").trim();
        metadata.lastInventoryOperator = operator;
      }

      const updateData = { metadata };
      if (config.targetStatus) updateData.status = config.targetStatus;
      if (Object.prototype.hasOwnProperty.call(config, "defaultOwner")) {
        updateData.owner = body.owner || (normalizedAction === "borrow" ? (request.user.name || request.user.email) : null) || config.defaultOwner;
      } else if (body.owner) {
        updateData.owner = body.owner;
      }
      if (Object.prototype.hasOwnProperty.call(config, "defaultLocation")) {
        updateData.location = body.location || config.defaultLocation;
      } else if (body.location) {
        updateData.location = body.location;
      }

      const updated = await tx.asset.update({
        where: assetWhere(request.user.tenantId, request.params.id),
        data: updateData
      });
      await appendAssetAudit(tx, request, updated, config.auditType, `${updated.name} 完成${config.label}`, "成功", {
        action: normalizedAction,
        operator,
        fromStatus: event.fromStatus,
        toStatus: event.toStatus,
        note: event.note || undefined,
        inventoryResult: metadata.lastInventoryResult || undefined
      });
      return { asset: updated };
    });

    if (!result) return reply.code(404).send({ error: "asset_not_found" });
    if (result.invalidTransition) {
      return reply.code(409).send({
        error: "invalid_asset_transition",
        message: `当前状态 ${statusToLabel[result.asset.status] || result.asset.status} 不允许执行${config.label}。`,
        asset: await serializeAssetWithQr(result.asset)
      });
    }
    return { asset: await serializeAssetWithQr(result.asset) };
  });

  app.post("/api/assets/:id/qr", { preHandler: app.authenticate }, async (request, reply) => {
    await requirePermission(app, request, { module: "asset", action: "write" });
    const current = await app.prisma.asset.findUnique({ where: assetWhere(request.user.tenantId, request.params.id) });
    if (!current) return reply.code(404).send({ error: "asset_not_found" });
    const operator = String(request.user.name || request.user.email || "系统用户").trim();
    const replacedAt = new Date();
    const nextVersion = current.qrVersion + 1;
    const event = {
      action: "qr",
      label: "更换二维码",
      operator,
      at: replacedAt.toISOString(),
      fromStatus: statusToLabel[current.status] || current.status,
      toStatus: statusToLabel[current.status] || current.status,
      note: `V${current.qrVersion} -> V${nextVersion}`
    };
    const asset = await app.prisma.asset.update({
      where: assetWhere(request.user.tenantId, request.params.id),
      data: {
        qrVersion: { increment: 1 },
        metadata: {
          ...(current.metadata || {}),
          history: assetHistory(current, event),
          lastQrReplacedAt: replacedAt.toISOString(),
          lastQrReplacedBy: operator
        }
      }
    });
    await appendAssetAudit(app.prisma, request, asset, "qr", `重新生成 ${asset.name} 二维码 V${asset.qrVersion}`, "成功", {
      operator,
      qrPayload: assetQrPayload(asset)
    });
    return { asset: await serializeAssetWithQr(asset) };
  });

  app.get("/api/assets/events", { preHandler: app.authenticate }, async (request) => {
    await requirePermission(app, request, { module: "asset", action: "read" });
    const logs = await app.prisma.auditLog.findMany({
      where: { tenantId: request.user.tenantId, objectType: "asset" },
      orderBy: { createdAt: "desc" },
      take: 100
    });
    return {
      assetEvents: logs.map((log) => ({
        id: log.id,
        assetId: log.metadata?.assetId || log.objectId,
        time: formatDateTime(log.createdAt),
        type: log.metadata?.type || log.action,
        operator: log.metadata?.operator || log.actor?.name || "系统用户",
        content: log.summary
      }))
    };
  });
}
