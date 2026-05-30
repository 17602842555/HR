import { appendAuditLog, recordExportEvent, requestAuditMeta, requireExportBusinessReason } from "../audit/audit-service.mjs";
import { boundedQueryLimit } from "../../lib/pagination.mjs";
import { requirePermission } from "../iam/route-guards.mjs";

const bookingStatusLabels = {
  CONFIRMED: "已预约",
  CANCELLED: "已取消",
  PENDING: "待确认",
  REJECTED: "已拒绝"
};

const bookingExportColumns = Object.freeze([
  ["resourceName", "资源"],
  ["type", "类型"],
  ["date", "日期"],
  ["period", "时段"],
  ["applicant", "申请人"],
  ["purpose", "用途"],
  ["status", "状态"],
  ["cancelReason", "取消原因"],
  ["createdAt", "创建时间"]
]);

function startOfUtcDate(value = new Date()) {
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return new Date(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth(), parsed.getUTCDate()));
}

function addDays(value, days) {
  const next = new Date(value);
  next.setUTCDate(next.getUTCDate() + Number(days || 0));
  return next;
}

function resourceWindowStart(query = {}) {
  return startOfUtcDate(query.from || query.windowStart) || startOfUtcDate();
}

function dayIndexFromDate(value, windowStart) {
  const start = windowStart || startOfUtcDate();
  const diff = startOfUtcDate(value)?.getTime() - start.getTime();
  if (!Number.isFinite(diff)) return 0;
  const index = Math.floor(diff / 86_400_000);
  return index >= 0 && index <= 6 ? index : 0;
}

function normalizeTime(value) {
  const text = String(value || "").trim();
  return /^\d{2}:\d{2}$/.test(text) ? text : "";
}

function parseDateTime(value) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function parseExportBoundary(value, { endExclusive = false } = {}) {
  if (!value) return null;
  const text = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const date = startOfUtcDate(text);
    return endExclusive && date ? addDays(date, 1) : date;
  }
  return parseDateTime(text);
}

function formatDateTime(value) {
  if (!value) return "";
  return new Date(value).toLocaleString("sv-SE", { hour12: false }).replace("T", " ").slice(0, 16);
}

function dateForDayIndex(dayIndex, period = "09:00-10:00", windowStart = startOfUtcDate()) {
  const [start, end] = String(period).split("-");
  return dateForExplicitDate(addDays(windowStart, Number(dayIndex || 0)).toISOString().slice(0, 10), start, end);
}

function dateForExplicitDate(dateValue, start, end) {
  const date = startOfUtcDate(dateValue);
  if (!date) throw new Error("invalid_booking_period");
  if (!/^\d{2}:\d{2}$/.test(start || "") || !/^\d{2}:\d{2}$/.test(end || "")) {
    throw new Error("invalid_booking_period");
  }
  const [startHour, startMinute] = start.split(":").map(Number);
  const [endHour, endMinute] = end.split(":").map(Number);
  if (![startHour, startMinute, endHour, endMinute].every(Number.isFinite)) {
    throw new Error("invalid_booking_period");
  }
  const startsAt = new Date(date);
  startsAt.setUTCHours(startHour, startMinute, 0, 0);
  const endsAt = new Date(date);
  endsAt.setUTCHours(endHour, endMinute, 0, 0);
  if (endsAt <= startsAt) throw new Error("invalid_booking_period");
  return { startsAt, endsAt };
}

function bookingRangeFromBody(body = {}, windowStart = startOfUtcDate()) {
  const explicitStartsAt = parseDateTime(body.startsAt);
  const explicitEndsAt = parseDateTime(body.endsAt);
  if (explicitStartsAt || explicitEndsAt) {
    if (!explicitStartsAt || !explicitEndsAt || explicitEndsAt <= explicitStartsAt) {
      throw new Error("invalid_booking_period");
    }
    return { startsAt: explicitStartsAt, endsAt: explicitEndsAt };
  }
  const periodText = String(body.period || "").trim();
  const [periodStart, periodEnd] = periodText.split("-");
  const startTime = normalizeTime(body.startTime) || normalizeTime(periodStart);
  const endTime = normalizeTime(body.endTime) || normalizeTime(periodEnd);
  if (body.bookingDate || body.date) {
    return dateForExplicitDate(body.bookingDate || body.date, startTime, endTime);
  }
  return dateForDayIndex(body.dayIndex, `${startTime}-${endTime}`, windowStart);
}

function periodFromBooking(booking) {
  const start = new Date(booking.startsAt).toISOString().slice(11, 16);
  const end = new Date(booking.endsAt).toISOString().slice(11, 16);
  return `${start}-${end}`;
}

function dateFromBooking(booking) {
  return new Date(booking.startsAt).toISOString().slice(0, 10);
}

function totalSlots(resource) {
  if (Number(resource.metadata?.slotTotal)) return Number(resource.metadata.slotTotal);
  if (resource.type === "会议室") return resource.capacity >= 20 ? 8 : 4;
  if (resource.type === "车辆") return 2;
  if (resource.type === "工位") return resource.capacity || 12;
  return resource.capacity || 8;
}

function capacityLabel(resource) {
  if (!resource.capacity) return "-";
  if (resource.type === "车辆") return `${resource.capacity}座`;
  if (resource.type === "工位") return `${resource.capacity}位`;
  if (resource.type === "设备") return `${resource.capacity}套`;
  return `${resource.capacity}人`;
}

function serializeResource(resource, bookings = [], windowStart = startOfUtcDate()) {
  const slots = Array.from({ length: 7 }, () => 0);
  bookings.forEach((booking) => {
    slots[dayIndexFromDate(booking.startsAt, windowStart)] += 1;
  });
  return {
    type: resource.type,
    name: resource.name,
    capacity: capacityLabel(resource),
    slots,
    total: totalSlots(resource)
  };
}

function serializeBooking(booking, windowStart = startOfUtcDate()) {
  return {
    id: booking.id,
    resourceName: booking.resource?.name || booking.resourceName,
    type: booking.resource?.type || "",
    date: dateFromBooking(booking),
    dayIndex: dayIndexFromDate(booking.startsAt, windowStart),
    period: periodFromBooking(booking),
    applicant: booking.metadata?.applicant || booking.applicant?.name || "系统用户",
    purpose: booking.purpose,
    status: bookingStatusLabels[booking.status] || booking.status,
    cancelReason: booking.metadata?.cancelReason || "",
    createdAt: formatDateTime(booking.createdAt)
  };
}

function timestampToken() {
  return new Date().toISOString().replaceAll(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function csvCell(value) {
  const text = value === null || value === undefined ? "" : String(value);
  const safeText = /^[\s]*[=+\-@]/.test(text) ? `'${text}` : text;
  return `"${safeText.replaceAll("\"", "\"\"").replace(/\r?\n/g, " ")}"`;
}

function toBookingCsv(rows) {
  const headers = bookingExportColumns.map(([, label]) => label);
  const lines = [
    headers.map(csvCell).join(","),
    ...rows.map((row) => bookingExportColumns.map(([key]) => csvCell(row[key])).join(","))
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

function normalizeBookingExportFilters(input = {}) {
  const filters = {};
  ["status", "resourceName", "type", "from", "to", "scope"].forEach((key) => {
    const value = input[key];
    if (typeof value === "string" && value.trim()) filters[key] = value.trim();
  });
  return filters;
}

function bookingWhere(tenantId, filters = {}) {
  const where = { tenantId };
  const status = String(filters.status || "").trim();
  if (status) {
    const statusEntry = Object.entries(bookingStatusLabels).find(([, label]) => label === status);
    where.status = statusEntry?.[0] || status;
  }
  const from = parseExportBoundary(filters.from);
  const to = parseExportBoundary(filters.to, { endExclusive: true });
  if (from) where.endsAt = { gt: from };
  if (to) where.startsAt = { lt: to };
  return where;
}

function filterSerializedBookings(rows, filters = {}) {
  return rows.filter((row) => (
    (!filters.resourceName || row.resourceName.includes(filters.resourceName))
    && (!filters.type || row.type === filters.type)
  ));
}

async function appendBookingAudit(prisma, request, payload) {
  return appendAuditLog(prisma, {
    tenantId: request.user.tenantId,
    actorUserId: request.user.sub,
    objectType: "resource_booking",
    ...payload,
    ...requestAuditMeta(request)
  });
}

async function findBookingResource(prisma, tenantId, body = {}) {
  const resourceId = String(body.resourceId || "").trim();
  if (resourceId) {
    return prisma.resource.findFirst({ where: { tenantId, id: resourceId } });
  }
  const code = String(body.resourceCode || "").trim();
  if (code) {
    return prisma.resource.findFirst({ where: { tenantId, code } });
  }
  const name = String(body.resourceName || body.name || "").trim();
  if (!name) return null;
  return prisma.resource.findFirst({ where: { tenantId, name } });
}

async function acquireResourceBookingLock(tx, tenantId, resourceId) {
  if (typeof tx.$executeRaw === "function") {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${tenantId}), hashtext(${resourceId}))`;
    return;
  }
  if (typeof tx.$queryRaw === "function") {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${tenantId}), hashtext(${resourceId}))`;
  }
}

function isDatabaseBookingConflict(error) {
  const message = String(error?.message || "");
  return error?.code === "P2002"
    || error?.code === "P2004"
    || error?.meta?.code === "23P01"
    || message.includes("bookings_no_confirmed_overlap")
    || message.includes("exclusion constraint");
}

export async function registerResourceRoutes(app) {
  app.get("/api/resources", { preHandler: app.authenticate }, async (request) => {
    await requirePermission(app, request, { module: "resource", action: "read" });
    const windowStart = resourceWindowStart(request.query || {});
    const windowEnd = addDays(windowStart, 7);
    const [resources, bookings] = await Promise.all([
      app.prisma.resource.findMany({ where: { tenantId: request.user.tenantId }, orderBy: { code: "asc" } }),
      app.prisma.booking.findMany({
        where: {
          tenantId: request.user.tenantId,
          status: "CONFIRMED",
          startsAt: { lt: windowEnd },
          endsAt: { gt: windowStart }
        },
        include: { resource: true }
      })
    ]);
    return {
      windowStart: windowStart.toISOString().slice(0, 10),
      resources: resources.map((resource) => serializeResource(
        resource,
        bookings.filter((booking) => booking.resourceId === resource.id),
        windowStart
      ))
    };
  });

  app.get("/api/resources/bookings", { preHandler: app.authenticate }, async (request) => {
    await requirePermission(app, request, { module: "resource", action: "read" });
    const where = bookingWhere(request.user.tenantId, request.query || {});
    const windowStart = resourceWindowStart(request.query || {});
    const bookings = await app.prisma.booking.findMany({
      where,
      include: { resource: true },
      orderBy: { createdAt: "desc" },
      take: boundedQueryLimit(request.query?.limit, { fallback: 100, max: 500 })
    });
    return { resourceBookings: bookings.map((booking) => serializeBooking(booking, windowStart)) };
  });

  app.post("/api/resources/bookings/export", { preHandler: app.authenticate }, async (request, reply) => {
    await requirePermission(app, request, { module: "resource", action: "export" });
    const filters = normalizeBookingExportFilters(request.body?.filters || request.body || {});
    const bookings = await app.prisma.booking.findMany({
      where: bookingWhere(request.user.tenantId, filters),
      include: { resource: true },
      orderBy: { createdAt: "desc" },
      take: boundedQueryLimit(request.body?.limit, { fallback: 500, max: 2000 })
    });
    const serializedBookings = filterSerializedBookings(bookings.map((booking) => serializeBooking(booking)), filters);
    const scope = String(request.body?.scope || filters.scope || "资源预约台账").trim() || "资源预约台账";
    const businessReason = requireExportBusinessReason(request.body || {});
    const filename = `resource-booking-export-${timestampToken()}.csv`;
    await recordExportEvent(app.prisma, {
      tenantId: request.user.tenantId,
      actorUserId: request.user.sub,
      action: "resource.booking.export",
      module: "resource",
      objectType: "resource_booking",
      fileName: filename,
      scope,
      businessReason,
      rowCount: serializedBookings.length,
      filters,
      summary: `导出${scope}，后端生成资源预约台账`,
      metadata: {
        filters,
        format: "csv",
        rowCount: serializedBookings.length,
        result: "成功",
        scope
      },
      ...requestAuditMeta(request)
    });
    return replyCsv(reply, toBookingCsv(serializedBookings), filename, serializedBookings.length);
  });

  app.post("/api/resources/bookings", { preHandler: app.authenticate }, async (request, reply) => {
    await requirePermission(app, request, { module: "resource", action: "book" });
    const body = request.body || {};
    const applicantName = String(body.applicant || request.user.name || request.user.email || "系统用户").trim();
    const resource = await findBookingResource(app.prisma, request.user.tenantId, body);
    if (!resource) return reply.code(404).send({ error: "resource_not_found" });
    let startsAt;
    let endsAt;
    try {
      ({ startsAt, endsAt } = bookingRangeFromBody(body, resourceWindowStart(body)));
    } catch {
      return reply.code(400).send({ error: "invalid_booking_period", message: "预约时段格式必须为 HH:mm-HH:mm，且结束时间晚于开始时间。" });
    }

    try {
      const result = await app.prisma.$transaction(async (tx) => {
        await acquireResourceBookingLock(tx, request.user.tenantId, resource.id);
        const conflict = await tx.booking.findFirst({
          where: {
            tenantId: request.user.tenantId,
            resourceId: resource.id,
            status: "CONFIRMED",
            startsAt: { lt: endsAt },
            endsAt: { gt: startsAt }
          }
        });
        if (conflict) {
          await appendBookingAudit(tx, request, {
            action: "resource.booking.conflict",
            objectId: resource.id,
            summary: `${resource.name} ${body.period || periodFromBooking({ startsAt, endsAt })} 已被占用`,
            metadata: { resourceName: resource.name, date: dateFromBooking({ startsAt }), period: body.period || periodFromBooking({ startsAt, endsAt }), result: "失败" }
          });
          return { conflict: true };
        }
        const booking = await tx.booking.create({
          data: {
            tenantId: request.user.tenantId,
            resourceId: resource.id,
            applicantId: request.user.sub,
            purpose: body.purpose || "内部协作",
            status: "CONFIRMED",
            startsAt,
            endsAt,
            metadata: { applicant: applicantName, date: dateFromBooking({ startsAt }), dayIndex: body.dayIndex, period: periodFromBooking({ startsAt, endsAt }) }
          },
          include: { resource: true }
        });
        await appendBookingAudit(tx, request, {
          action: "resource.booking.create",
          objectId: resource.id,
          summary: `预约${resource.name} ${body.period || periodFromBooking(booking)}`,
          metadata: { resourceName: resource.name, date: dateFromBooking(booking), period: periodFromBooking(booking), applicant: applicantName }
        });
        return { booking };
      });

      if (result.conflict) {
        return reply.code(409).send({ error: "booking_conflict", message: "该资源同时段已有预约" });
      }
      return reply.code(201).send({ booking: serializeBooking(result.booking) });
    } catch (error) {
      if (isDatabaseBookingConflict(error)) {
        await appendBookingAudit(app.prisma, request, {
          action: "resource.booking.conflict",
          objectId: resource.id,
          summary: `${resource.name} ${body.period || periodFromBooking({ startsAt, endsAt })} 已被数据库约束阻止`,
          metadata: { resourceName: resource.name, date: dateFromBooking({ startsAt }), period: body.period || periodFromBooking({ startsAt, endsAt }), result: "失败", source: "database_constraint" }
        });
        return reply.code(409).send({ error: "booking_conflict", message: "该资源同时段已有预约" });
      }
      throw error;
    }
  });

  app.post("/api/resources/bookings/:id/cancel", { preHandler: app.authenticate }, async (request, reply) => {
    await requirePermission(app, request, { module: "resource", action: "book" });
    const result = await app.prisma.$transaction(async (tx) => {
      const booking = await tx.booking.findFirst({
        where: { id: request.params.id, tenantId: request.user.tenantId },
        include: { resource: true }
      });
      if (!booking) return null;
      if (booking.status === "CANCELLED") {
        await appendBookingAudit(tx, request, {
          action: "resource.booking.cancel.noop",
          objectId: booking.resourceId,
          summary: `${booking.resource?.name || "资源"} ${periodFromBooking(booking)} 已取消，跳过重复取消`,
          metadata: {
            bookingId: booking.id,
            resourceName: booking.resource?.name || "",
            period: periodFromBooking(booking),
            alreadyCancelled: true
          }
        });
        return { booking, alreadyCancelled: true };
      }
      if (booking.status !== "CONFIRMED") {
        await appendBookingAudit(tx, request, {
          action: "resource.booking.cancel.denied",
          objectId: booking.resourceId,
          summary: `${booking.resource?.name || "资源"} ${periodFromBooking(booking)} 当前状态不允许取消`,
          metadata: {
            bookingId: booking.id,
            resourceName: booking.resource?.name || "",
            period: periodFromBooking(booking),
            status: booking.status,
            result: "失败"
          }
        });
        return { invalidStatus: true, booking };
      }

      const operator = String(request.user.name || request.user.email || "系统用户").trim();
      const cancelled = await tx.booking.update({
        where: { id: booking.id },
        data: {
          status: "CANCELLED",
          metadata: {
            ...(booking.metadata || {}),
            cancelledAt: new Date().toISOString(),
            cancelledBy: operator,
            cancelReason: String(request.body?.reason || "用户取消预约").trim()
          }
        },
        include: { resource: true }
      });
      await appendBookingAudit(tx, request, {
        action: "resource.booking.cancel",
        objectId: cancelled.resourceId,
        summary: `取消${cancelled.resource?.name || "资源"} ${periodFromBooking(cancelled)}`,
        metadata: {
          bookingId: cancelled.id,
          resourceName: cancelled.resource?.name || "",
          period: periodFromBooking(cancelled),
          operator
        }
      });
      return { booking: cancelled };
    });

    if (!result) return reply.code(404).send({ error: "booking_not_found" });
    if (result.invalidStatus) {
      return reply.code(409).send({
        error: "invalid_booking_status",
        message: "只有已预约记录可以取消。",
        booking: serializeBooking(result.booking)
      });
    }
    return {
      booking: serializeBooking(result.booking, resourceWindowStart(request.query || {})),
      alreadyCancelled: Boolean(result.alreadyCancelled)
    };
  });
}
