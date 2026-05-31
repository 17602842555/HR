import bcrypt from "bcryptjs";
import { appendAuditLog, requestAuditMeta } from "../audit/audit-service.mjs";
import { serializeUser, userWithAccessInclude } from "../iam/permissions.mjs";
import { validateNewPassword } from "./password-policy.mjs";

const passwordHashRounds = 12;

function tokenPayload(user) {
  return {
    sub: user.id,
    tenantId: user.tenantId,
    email: user.email,
    sessionVersion: user.sessionVersion
  };
}

function loginFailureKey(request, tenantCode, email) {
  return [request.ip || "unknown", tenantCode, email].join("|").toLowerCase();
}

function retryAfterSeconds(entry, now) {
  return Math.max(1, Math.ceil((entry.expiresAt - now) / 1000));
}

function pruneExpiredLoginFailures(store, now) {
  for (const [key, entry] of store.entries()) {
    if (!entry || entry.expiresAt <= now) {
      store.delete(key);
    }
  }
}

function enforceLoginFailureStoreLimit(store, config, now) {
  if (!Number.isInteger(config.authFailedLoginMaxKeys) || config.authFailedLoginMaxKeys <= 0) return;
  if (store.size < config.authFailedLoginMaxKeys) return;

  pruneExpiredLoginFailures(store, now);

  while (store.size >= config.authFailedLoginMaxKeys) {
    const oldestKey = store.keys().next().value;
    if (!oldestKey) return;
    store.delete(oldestKey);
  }
}

function loginLimitState(store, key, config, now = Date.now()) {
  if (config.authFailedLoginLimit <= 0) return { blocked: false, remaining: Infinity };
  const entry = store.get(key);
  if (!entry || entry.expiresAt <= now) {
    if (entry) store.delete(key);
    return { blocked: false, remaining: config.authFailedLoginLimit };
  }
  if (entry.count >= config.authFailedLoginLimit) {
    return {
      blocked: true,
      count: entry.count,
      retryAfterSeconds: retryAfterSeconds(entry, now)
    };
  }
  return { blocked: false, count: entry.count, remaining: config.authFailedLoginLimit - entry.count };
}

function recordLoginFailure(store, key, config, now = Date.now()) {
  if (config.authFailedLoginLimit <= 0) return { count: 0, retryAfterSeconds: 0 };
  const current = store.get(key);
  if (!current || current.expiresAt <= now) {
    if (current) store.delete(key);
    enforceLoginFailureStoreLimit(store, config, now);
  }
  const entry = current && current.expiresAt > now
    ? current
    : { count: 0, expiresAt: now + config.authFailedLoginWindowMs };
  entry.count += 1;
  store.set(key, entry);
  return {
    count: entry.count,
    retryAfterSeconds: retryAfterSeconds(entry, now)
  };
}

function clearLoginFailures(store, key) {
  store.delete(key);
}

function authCookieOptions(config) {
  return {
    httpOnly: true,
    maxAge: config.cookieMaxAgeSeconds,
    path: "/",
    sameSite: "lax",
    secure: config.isProduction
  };
}

function authenticatedUserWhere(request) {
  return { id: request.user.sub, tenantId: request.user.tenantId };
}

function normalizeEmail(input) {
  return String(input || "").trim().toLowerCase();
}

async function auditLoginFailure(app, request, {
  action = "auth.login_failed",
  email,
  tenant,
  tenantCode,
  user = null,
  reason,
  failureCount,
  retryAfterSeconds: retryAfter
}) {
  if (!tenant) return;
  await appendAuditLog(app.prisma, {
    tenantId: tenant.id,
    actorUserId: user?.id || null,
    action,
    objectType: "user",
    objectId: user?.id || null,
    summary: action === "auth.login_blocked" ? "登录失败次数过多，已临时限制" : "用户登录失败",
    metadata: {
      email,
      failureCount,
      reason,
      retryAfterSeconds: retryAfter,
      tenantCode
    },
    ...requestAuditMeta(request)
  });
}

export async function registerAuthRoutes(app) {
  const loginFailures = new Map();

  app.post("/api/auth/login", async (request, reply) => {
    const body = request.body || {};
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    const tenantCode = String(body.tenantCode || app.config.defaultTenantCode);

    if (!email || !password) {
      return reply.code(400).send({ error: "email_and_password_required" });
    }

    const failureKey = loginFailureKey(request, tenantCode, email);
    const tenant = await app.prisma.tenant.findUnique({ where: { code: tenantCode } });
    if (!tenant) {
      recordLoginFailure(loginFailures, failureKey, app.config);
      return reply.code(401).send({ error: "invalid_credentials" });
    }

    const limit = loginLimitState(loginFailures, failureKey, app.config);
    if (limit.blocked) {
      await auditLoginFailure(app, request, {
        action: "auth.login_blocked",
        email,
        tenant,
        tenantCode,
        failureCount: limit.count,
        reason: "too_many_failed_attempts",
        retryAfterSeconds: limit.retryAfterSeconds
      });
      return reply
        .code(429)
        .header("Retry-After", String(limit.retryAfterSeconds))
        .send({ error: "too_many_login_attempts", retryAfterSeconds: limit.retryAfterSeconds });
    }

    const user = await app.prisma.user.findUnique({
      where: { tenantId_email: { tenantId: tenant.id, email } },
      include: userWithAccessInclude
    });

    if (!user || user.status !== "ACTIVE") {
      const failure = recordLoginFailure(loginFailures, failureKey, app.config);
      await auditLoginFailure(app, request, {
        email,
        tenant,
        tenantCode,
        user,
        failureCount: failure.count,
        reason: user ? "inactive_user" : "unknown_user",
        retryAfterSeconds: failure.retryAfterSeconds
      });
      return reply.code(401).send({ error: "invalid_credentials" });
    }

    const validPassword = await bcrypt.compare(password, user.passwordHash);
    if (!validPassword) {
      const failure = recordLoginFailure(loginFailures, failureKey, app.config);
      await auditLoginFailure(app, request, {
        email,
        tenant,
        tenantCode,
        user,
        failureCount: failure.count,
        reason: "bad_password",
        retryAfterSeconds: failure.retryAfterSeconds
      });
      return reply.code(401).send({ error: "invalid_credentials" });
    }

    clearLoginFailures(loginFailures, failureKey);
    const token = app.jwt.sign(tokenPayload(user));
    await app.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() }
    });

    await appendAuditLog(app.prisma, {
      tenantId: user.tenantId,
      actorUserId: user.id,
      action: "auth.login",
      objectType: "user",
      objectId: user.id,
      summary: "用户登录",
      metadata: { email, tenantCode },
      ...requestAuditMeta(request)
    });

    reply.setCookie(app.config.cookieName, token, authCookieOptions(app.config));

    return reply.send({ token, user: serializeUser(user) });
  });

  app.get("/api/auth/me", { preHandler: app.authenticate }, async (request) => {
    const user = await app.prisma.user.findFirst({
      where: authenticatedUserWhere(request),
      include: userWithAccessInclude
    });

    if (!user || user.status !== "ACTIVE") {
      return { user: null };
    }

    return { user: serializeUser(user) };
  });

  app.post("/api/auth/change-password", { preHandler: app.authenticate }, async (request, reply) => {
    const currentPassword = String(request.body?.currentPassword || "");
    const newPassword = String(request.body?.newPassword || "");

    if (!currentPassword || !newPassword) {
      return reply.code(400).send({ error: "password_change_fields_required", message: "当前密码和新密码必填。" });
    }

    const validation = validateNewPassword(newPassword);
    if (!validation.ok) {
      return reply.code(400).send({
        error: "password_policy_failed",
        message: validation.message,
        details: { reasons: validation.reasons }
      });
    }

    const user = await app.prisma.user.findFirst({
      where: authenticatedUserWhere(request),
      include: userWithAccessInclude
    });
    if (!user || user.status !== "ACTIVE") {
      return reply.code(401).send({ error: "unauthorized" });
    }

    const validCurrentPassword = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!validCurrentPassword) {
      await appendAuditLog(app.prisma, {
        tenantId: user.tenantId,
        actorUserId: user.id,
        action: "auth.password_change_denied",
        objectType: "user",
        objectId: user.id,
        summary: "用户修改密码失败",
        metadata: { email: user.email, reason: "bad_current_password" },
        ...requestAuditMeta(request)
      });
      return reply.code(401).send({ error: "current_password_invalid", message: "当前密码不正确。" });
    }

    const passwordReused = await bcrypt.compare(newPassword, user.passwordHash);
    if (passwordReused) {
      await appendAuditLog(app.prisma, {
        tenantId: user.tenantId,
        actorUserId: user.id,
        action: "auth.password_change_denied",
        objectType: "user",
        objectId: user.id,
        summary: "用户修改密码失败",
        metadata: { email: user.email, reason: "password_reuse" },
        ...requestAuditMeta(request)
      });
      return reply.code(400).send({ error: "password_reuse_denied", message: "新密码不能与当前密码相同。" });
    }

    const passwordHash = await bcrypt.hash(newPassword, passwordHashRounds);
    let updated;
    await app.prisma.$transaction(async (tx) => {
      updated = await tx.user.update({
        where: { id: user.id },
        data: {
          mustChangePassword: false,
          passwordHash,
          sessionVersion: { increment: 1 }
        },
        include: userWithAccessInclude
      });
      await appendAuditLog(tx, {
        tenantId: user.tenantId,
        actorUserId: user.id,
        action: "auth.password_change",
        objectType: "user",
        objectId: user.id,
        summary: "用户修改密码",
        metadata: { email: user.email, sessionRevoked: true },
        ...requestAuditMeta(request)
      });
    });

    const token = app.jwt.sign(tokenPayload(updated));
    reply.setCookie(app.config.cookieName, token, authCookieOptions(app.config));
    return reply.send({ token, user: serializeUser(updated) });
  });

  app.post("/api/auth/complete-first-login", { preHandler: app.authenticate }, async (request, reply) => {
    const currentPassword = String(request.body?.currentPassword || "");
    const newPassword = String(request.body?.newPassword || "");
    const email = normalizeEmail(request.body?.email);
    const name = String(request.body?.name || "").trim();

    if (!currentPassword || !newPassword || !email || !name) {
      return reply.code(400).send({
        error: "first_login_fields_required",
        message: "当前密码、新密码、登录账号和姓名必填。"
      });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return reply.code(400).send({ error: "invalid_user_email", message: "登录账号需要使用有效邮箱格式。" });
    }

    const validation = validateNewPassword(newPassword);
    if (!validation.ok) {
      return reply.code(400).send({
        error: "password_policy_failed",
        message: validation.message,
        details: { reasons: validation.reasons }
      });
    }

    const user = await app.prisma.user.findFirst({
      where: authenticatedUserWhere(request),
      include: userWithAccessInclude
    });
    if (!user || user.status !== "ACTIVE") {
      return reply.code(401).send({ error: "unauthorized" });
    }
    if (!user.mustChangePassword) {
      return reply.code(400).send({
        error: "first_login_not_required",
        message: "当前账号已完成首次登录设置。"
      });
    }

    const validCurrentPassword = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!validCurrentPassword) {
      await appendAuditLog(app.prisma, {
        tenantId: user.tenantId,
        actorUserId: user.id,
        action: "auth.first_login_denied",
        objectType: "user",
        objectId: user.id,
        summary: "首次登录设置失败",
        metadata: { email: user.email, reason: "bad_current_password" },
        ...requestAuditMeta(request)
      });
      return reply.code(401).send({ error: "current_password_invalid", message: "当前密码不正确。" });
    }

    const passwordReused = await bcrypt.compare(newPassword, user.passwordHash);
    if (passwordReused) {
      return reply.code(400).send({ error: "password_reuse_denied", message: "新密码不能与当前临时密码相同。" });
    }

    const existing = await app.prisma.user.findUnique({
      where: { tenantId_email: { tenantId: user.tenantId, email } }
    });
    if (existing && existing.id !== user.id) {
      return reply.code(409).send({ error: "user_email_exists", message: "该登录账号已被其他员工使用。" });
    }

    const passwordHash = await bcrypt.hash(newPassword, passwordHashRounds);
    let updated;
    await app.prisma.$transaction(async (tx) => {
      updated = await tx.user.update({
        where: { id: user.id },
        data: {
          email,
          mustChangePassword: false,
          name,
          passwordHash,
          sessionVersion: { increment: 1 }
        },
        include: userWithAccessInclude
      });
      await appendAuditLog(tx, {
        tenantId: user.tenantId,
        actorUserId: user.id,
        action: "auth.first_login_complete",
        objectType: "user",
        objectId: user.id,
        summary: "员工完成首次登录设置",
        metadata: {
          emailAfter: email,
          emailBefore: user.email,
          nameAfter: name,
          nameBefore: user.name,
          sessionRevoked: true
        },
        ...requestAuditMeta(request)
      });
    });

    const token = app.jwt.sign(tokenPayload(updated));
    reply.setCookie(app.config.cookieName, token, authCookieOptions(app.config));
    return reply.send({ token, user: serializeUser(updated) });
  });

  app.post("/api/auth/logout", { preHandler: app.authenticate }, async (request, reply) => {
    const user = await app.prisma.user.findFirst({
      where: authenticatedUserWhere(request)
    });
    if (!user || user.status !== "ACTIVE") {
      return reply.code(401).send({ error: "unauthorized" });
    }

    await appendAuditLog(app.prisma, {
      tenantId: user.tenantId,
      actorUserId: user.id,
      action: "auth.logout",
      objectType: "user",
      objectId: user.id,
      summary: "用户退出登录",
      metadata: {},
      ...requestAuditMeta(request)
    });

    await app.prisma.user.update({
      where: { id: user.id },
      data: { sessionVersion: { increment: 1 } }
    });

    reply.clearCookie(app.config.cookieName, authCookieOptions(app.config));
    return reply.send({ ok: true });
  });
}
