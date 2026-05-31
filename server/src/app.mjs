import Fastify from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
import { loadEnv } from "./lib/env.mjs";
import { createFileStorage } from "./lib/file-storage.mjs";
import { DomainError, PermissionDeniedError } from "./lib/domainErrors.mjs";
import { prisma as defaultPrisma } from "./lib/prisma.mjs";
import { openApiDocument } from "./openapi.mjs";
import { registerAnalyticsRoutes } from "./modules/analytics/analytics-routes.mjs";
import { registerApprovalRoutes } from "./modules/approvals/approval-routes.mjs";
import { registerAssetRoutes } from "./modules/assets/asset-routes.mjs";
import { registerAuditRoutes } from "./modules/audit/audit-routes.mjs";
import { registerAuthRoutes } from "./modules/auth/auth-routes.mjs";
import { registerAttendanceRoutes } from "./modules/attendance/attendance-routes.mjs";
import { registerFinanceRoutes } from "./modules/finance/finance-routes.mjs";
import { registerFileRoutes } from "./modules/files/file-routes.mjs";
import { registerIamRoutes } from "./modules/iam/iam-routes.mjs";
import { registerImportRoutes } from "./modules/imports/import-routes.mjs";
import { registerPeopleRoutes } from "./modules/people/people-routes.mjs";
import { registerResourceRoutes } from "./modules/resources/resource-routes.mjs";
import { readinessPayload } from "./modules/system/runtime-readiness.mjs";
import { registerSystemRoutes } from "./modules/system/system-routes.mjs";
import { registerWorkflowRoutes } from "./modules/workflow/workflow-routes.mjs";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const FIRST_LOGIN_ALLOWED_PATHS = new Set([
  "/api/auth/complete-first-login",
  "/api/auth/logout",
  "/api/auth/me"
]);
const SECURITY_HEADERS = Object.freeze({
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Cross-Origin-Resource-Policy": "same-site",
  "X-Permitted-Cross-Domain-Policies": "none"
});

function normalizeOrigin(value) {
  if (!value) return "";
  try {
    return new URL(String(value)).origin;
  } catch {
    return "";
  }
}

function firstHeaderValue(value) {
  const raw = Array.isArray(value) ? value[0] : value;
  return String(raw || "").split(",")[0].trim();
}

function requestHostOrigin(config, request) {
  const forwardedHost = config.trustProxy ? firstHeaderValue(request.headers["x-forwarded-host"]) : "";
  const host = forwardedHost || firstHeaderValue(request.headers.host);
  if (!host) return "";
  const forwardedProto = config.trustProxy ? firstHeaderValue(request.headers["x-forwarded-proto"]) : "";
  const proto = forwardedProto || request.protocol || "http";
  return normalizeOrigin(`${proto}://${host}`);
}

function requestSourceOrigin(request) {
  const origin = String(request.headers.origin || "").trim();
  if (origin) return origin === "null" ? "null" : normalizeOrigin(origin);
  return normalizeOrigin(request.headers.referer);
}

function allowedRequestOrigins(config, request) {
  return new Set([
    ...(config.webOrigin || []).map(normalizeOrigin).filter(Boolean),
    requestHostOrigin(config, request)
  ].filter(Boolean));
}

function isAllowedSourceOrigin(config, request) {
  const sourceOrigin = requestSourceOrigin(request);
  if (!sourceOrigin) return true;
  return allowedRequestOrigins(config, request).has(sourceOrigin);
}

function applyOperationalHeaders(config, request, reply) {
  Object.entries(SECURITY_HEADERS).forEach(([name, value]) => reply.header(name, value));
  reply.header("X-Request-Id", request.id);
  if (request.url === "/api" || request.url.startsWith("/api/")) {
    reply.header("Cache-Control", "no-store");
  }
  if (config.isProduction) {
    reply.header("Strict-Transport-Security", "max-age=15552000; includeSubDomains");
  }
}

export async function buildApp(options = {}) {
  const config = loadEnv(options.config || {});
  const app = Fastify({
    bodyLimit: config.apiBodyLimitBytes,
    trustProxy: config.trustProxy,
    logger: options.logger ?? {
      level: process.env.LOG_LEVEL || "info"
    }
  });

  app.decorate("config", config);
  app.decorate("prisma", options.prisma || defaultPrisma);
  app.decorate("fileStorage", options.fileStorage || createFileStorage(config));

  await app.register(cors, {
    origin: config.webOrigin,
    credentials: true
  });

  await app.register(cookie);
  await app.register(jwt, {
    secret: config.jwtSecret,
    sign: { expiresIn: config.jwtExpiresIn },
    cookie: {
      cookieName: config.cookieName,
      signed: false
    }
  });

  app.addHook("onRequest", async (request, reply) => {
    applyOperationalHeaders(app.config, request, reply);
  });

  app.addHook("preHandler", async (request, reply) => {
    if (SAFE_METHODS.has(request.method)) return;
    if (isAllowedSourceOrigin(app.config, request)) return;
    request.log.warn({
      origin: request.headers.origin || "",
      referer: request.headers.referer || "",
      route: request.url
    }, "blocked cross-site mutating request");
    return reply.code(403).send({ error: "csrf_origin_denied" });
  });

  app.decorate("authenticate", async (request, reply) => {
    try {
      await request.jwtVerify();
      const tokenTenantId = typeof request.user.tenantId === "string" ? request.user.tenantId : "";
      if (!request.user.sub || !tokenTenantId) {
        return reply.code(401).send({ error: "unauthorized" });
      }
      const user = await app.prisma.user.findFirst({
        where: { id: request.user.sub, tenantId: tokenTenantId }
      });
      const tokenSessionVersion = Number(request.user.sessionVersion);
      if (
        !user
        || user.status !== "ACTIVE"
        || !Number.isInteger(tokenSessionVersion)
        || user.sessionVersion !== tokenSessionVersion
      ) {
        return reply.code(401).send({ error: "unauthorized" });
      }
      request.user = {
        ...request.user,
        email: user.email,
        mustChangePassword: Boolean(user.mustChangePassword),
        name: user.name,
        sessionVersion: user.sessionVersion,
        tenantId: user.tenantId
      };
      const pathname = request.url.split("?")[0];
      if (user.mustChangePassword && !FIRST_LOGIN_ALLOWED_PATHS.has(pathname)) {
        return reply.code(403).send({
          error: "first_login_required",
          message: "首次登录必须先设置登录账号和新密码。"
        });
      }
    } catch {
      return reply.code(401).send({ error: "unauthorized" });
    }
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof PermissionDeniedError) {
      return reply.code(403).send({ error: error.code, message: error.message, details: error.details });
    }
    if (error instanceof DomainError) {
      return reply.code(400).send({ error: error.code, message: error.message, details: error.details });
    }
    request.log.error(error);
    return reply.code(500).send({ error: "internal_server_error" });
  });

  app.get("/health", async () => ({ ok: true, service: "deep-oa-api" }));
  app.get("/api/health", async () => ({ ok: true, service: "deep-oa-api" }));
  app.get("/api/openapi.json", async () => openApiDocument);
  app.get("/ready", async (request, reply) => {
    const status = await readinessPayload(app, request);
    if (!status.ok) return reply.code(503).send(status);
    return status;
  });
  app.get("/api/ready", async (request, reply) => {
    const status = await readinessPayload(app, request);
    if (!status.ok) return reply.code(503).send(status);
    return status;
  });

  await registerAuthRoutes(app);
  await registerAnalyticsRoutes(app);
  await registerPeopleRoutes(app);
  await registerIamRoutes(app);
  await registerApprovalRoutes(app);
  await registerAttendanceRoutes(app);
  await registerAssetRoutes(app);
  await registerFinanceRoutes(app);
  await registerFileRoutes(app);
  await registerImportRoutes(app);
  await registerResourceRoutes(app);
  await registerAuditRoutes(app);
  await registerSystemRoutes(app);
  await registerWorkflowRoutes(app);

  app.get("/api/protected/ping", { preHandler: app.authenticate }, async (request) => ({
    ok: true,
    tenantId: request.user.tenantId,
    userId: request.user.sub
  }));

  return app;
}
