import bcrypt from "bcryptjs";
import { createHash, randomBytes } from "node:crypto";
import { appendAuditLog, requestAuditMeta } from "../audit/audit-service.mjs";
import { validateNewPassword } from "../auth/password-policy.mjs";
import { rolePermissionCreateData } from "./policy-defaults.mjs";
import { requirePermission } from "./route-guards.mjs";

const passwordHashRounds = 12;

function serializePermission(permission, link = {}) {
  return {
    id: permission.id,
    code: permission.code,
    name: permission.name,
    module: permission.module,
    description: permission.description || "",
    dataScope: link.dataScope || null,
    fieldPolicy: link.fieldPolicy || null,
    allowExport: Boolean(link.allowExport)
  };
}

function permissionRows(role) {
  return (role.permissions || []).map((item) => item.permission).filter(Boolean);
}

function permissionLinks(role) {
  return (role.permissions || []).filter((item) => item.permission);
}

function serializeRole(role) {
  const permissions = permissionLinks(role).map((link) => serializePermission(link.permission, link));
  return {
    id: role.id,
    code: role.code,
    name: role.name,
    description: role.description || "",
    userCount: (role.users || []).length,
    users: (role.users || []).map((item) => ({
      id: item.user?.id,
      name: item.user?.name,
      email: item.user?.email
    })).filter((item) => item.id),
    permissionCodes: permissions.map((permission) => permission.code),
    permissions
  };
}

function serializeUser(user) {
  return {
    id: user.id,
    email: user.email,
    mustChangePassword: Boolean(user.mustChangePassword),
    name: user.name,
    status: user.status,
    employee: user.employee ? {
      id: user.employee.id,
      employeeNo: user.employee.employeeNo,
      department: user.employee.department?.name || "",
      departmentId: user.employee.departmentId || null,
      name: user.employee.name,
      roleTitle: user.employee.roleTitle
    } : null,
    roleCodes: (user.roles || []).map((item) => item.role?.code).filter(Boolean),
    roles: (user.roles || []).map((item) => ({
      id: item.role?.id,
      code: item.role?.code,
      name: item.role?.name
    })).filter((item) => item.id)
  };
}

function serializeEmployeeAccount(employee) {
  const user = employee.user || null;
  return {
    id: employee.id,
    employeeId: employee.id,
    employeeNo: employee.employeeNo,
    employeeName: employee.name,
    employeeStatus: employee.status,
    department: employee.department?.name || "",
    departmentId: employee.departmentId || null,
    roleTitle: employee.roleTitle || "",
    email: employee.email || "",
    account: user ? serializeUser(user) : null,
    accountEmail: user?.email || "",
    accountId: user?.id || null,
    accountMustChangePassword: Boolean(user?.mustChangePassword),
    accountStatus: user?.status || "UNASSIGNED",
    roleCodes: user ? (user.roles || []).map((item) => item.role?.code).filter(Boolean) : [],
    roleNames: user ? (user.roles || []).map((item) => item.role?.name).filter(Boolean) : []
  };
}

function accountStats(accounts) {
  const activeEmployees = accounts.filter((item) => item.employeeStatus === "ACTIVE");
  const assignedAccounts = accounts.filter((item) => item.accountId);
  const activeAssigned = activeEmployees.filter((item) => item.accountId);
  return {
    totalEmployees: accounts.length,
    activeEmployees: activeEmployees.length,
    assignedAccounts: assignedAccounts.length,
    activeAssignedAccounts: activeAssigned.length,
    missingAccounts: activeEmployees.length - activeAssigned.length,
    disabledAccounts: assignedAccounts.filter((item) => item.accountStatus === "DISABLED").length,
    coverageRate: activeEmployees.length ? Math.round((activeAssigned.length / activeEmployees.length) * 100) : 100
  };
}

async function loadIamOverview(prisma, tenantId) {
  const [permissions, roles, users, employees] = await Promise.all([
    prisma.permission.findMany({
      where: { tenantId },
      orderBy: [{ module: "asc" }, { code: "asc" }]
    }),
    prisma.role.findMany({
      where: { tenantId },
      include: {
        permissions: { include: { permission: true } },
        users: { include: { user: true } }
      },
      orderBy: { code: "asc" }
    }),
    prisma.user.findMany({
      where: { tenantId },
      include: {
        employee: { include: { department: true } },
        roles: { include: { role: true } }
      },
      orderBy: { email: "asc" }
    }),
    prisma.employee.findMany({
      where: { tenantId },
      include: {
        department: true,
        user: {
          include: {
            roles: { include: { role: true } }
          }
        }
      },
      orderBy: [{ status: "asc" }, { employeeNo: "asc" }]
    })
  ]);
  const accounts = employees.map(serializeEmployeeAccount);

  return {
    accountStats: accountStats(accounts),
    accounts,
    permissions: permissions.map(serializePermission),
    roles: roles.map(serializeRole),
    users: users.map(serializeUser)
  };
}

function normalizePermissionCodes(input) {
  const values = Array.isArray(input) ? input : [];
  return [...new Set(values.map((item) => String(item || "").trim()).filter(Boolean))];
}

function normalizeRoleCodes(input) {
  const values = Array.isArray(input) ? input : [];
  return [...new Set(values.map((item) => String(item || "").trim()).filter(Boolean))];
}

function normalizeEmail(input) {
  return String(input || "").trim().toLowerCase();
}

function requestLoginIdentifier(body = {}) {
  return normalizeEmail(body.login || body.phone || body.email);
}

function normalizePhoneLogin(input) {
  const value = String(input || "").replace(/\D+/g, "");
  return /^1[3-9]\d{9}$/.test(value) ? value : "";
}

function validLoginIdentifier(input) {
  const value = normalizeEmail(input);
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) || /^1[3-9]\d{9}$/.test(value);
}

function normalizeUserStatus(input) {
  const status = String(input || "").trim().toUpperCase();
  return ["ACTIVE", "DISABLED"].includes(status) ? status : "";
}

function sanitizeEmailLocalPart(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, ".")
    .replace(/^[._-]+|[._-]+$/g, "")
    .slice(0, 48);
  return normalized || "employee";
}

function normalizeEmailDomain(input) {
  const domain = String(input || "oa.local").trim().toLowerCase().replace(/^@+/, "");
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain) ? domain : "oa.local";
}

function generatedEmployeeFallbackEmail(employee, domain, suffix = "") {
  const source = employee.employeeNo || employee.email || employee.name || employee.id;
  const localPart = `${sanitizeEmailLocalPart(source)}${suffix ? `-${suffix}` : ""}`;
  return `${localPart}@${domain}`;
}

function generatedEmployeeLoginIdentifier(employee, domain) {
  const phone = normalizePhoneLogin(employee.phone || employee.mobile || employee.telephone || employee.contactPhone);
  if (phone) return phone;
  const directEmail = normalizeEmail(employee.email);
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(directEmail)) return directEmail;
  return generatedEmployeeFallbackEmail(employee, domain);
}

function generatedTemporaryPassword() {
  return `Tmp9-${randomBytes(9).toString("base64url")}`;
}

function generatedActivationCode() {
  const raw = randomBytes(6).toString("hex").toUpperCase();
  return `OA-${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;
}

function normalizeActivationCode(input) {
  return String(input || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function activationCodeHash(input) {
  return createHash("sha256").update(normalizeActivationCode(input)).digest("hex");
}

function activationExpiry(days = 7) {
  const boundedDays = Math.min(Math.max(Number(days) || 7, 1), 30);
  return new Date(Date.now() + boundedDays * 24 * 60 * 60 * 1000);
}

function serializeAccountActivation(activation, activationCode = "") {
  return {
    activationCode,
    createdAt: activation.createdAt,
    employee: activation.employee ? serializeEmployeeAccount(activation.employee) : null,
    employeeId: activation.employeeId,
    expiresAt: activation.expiresAt,
    id: activation.id,
    roleCodes: Array.isArray(activation.roleCodes) ? activation.roleCodes : [],
    status: activation.status,
    usedAt: activation.usedAt || null
  };
}

export async function registerIamRoutes(app) {
  app.get("/api/iam", { preHandler: app.authenticate }, async (request) => {
    await requirePermission(app, request, { module: "iam", action: "read" });
    const iam = await loadIamOverview(app.prisma, request.user.tenantId);
    return { iam, ...iam };
  });

  app.post("/api/iam/accounts/sync-employees", { preHandler: app.authenticate }, async (request, reply) => {
    await requirePermission(app, request, { module: "iam", action: "write" });
    const roleCodes = normalizeRoleCodes(request.body?.roleCodes || ["employee-self-service"]);
    const includeLeavers = request.body?.includeLeavers === true;
    const emailDomain = normalizeEmailDomain(request.body?.emailDomain);
    const requestedStatus = request.body?.status === undefined ? "ACTIVE" : normalizeUserStatus(request.body?.status);

    if (!roleCodes.length) {
      return reply.code(400).send({ error: "user_roles_required", message: "员工账号至少需要保留一个角色。" });
    }
    if (!requestedStatus) {
      return reply.code(400).send({ error: "invalid_user_status", message: "账号状态必须是 ACTIVE 或 DISABLED。" });
    }

    const roles = await app.prisma.role.findMany({
      where: {
        tenantId: request.user.tenantId,
        code: { in: roleCodes }
      }
    });
    const foundCodes = new Set(roles.map((role) => role.code));
    const missingCodes = roleCodes.filter((code) => !foundCodes.has(code));
    if (missingCodes.length) return reply.code(400).send({ error: "unknown_role_codes", missingCodes });

    const employees = await app.prisma.employee.findMany({
      where: {
        tenantId: request.user.tenantId,
        ...(includeLeavers ? {} : { status: "ACTIVE" })
      },
      include: { user: true },
      orderBy: { employeeNo: "asc" }
    });
    const missingAccountEmployees = employees.filter((employee) => !employee.user);
    const credentials = [];

    await app.prisma.$transaction(async (tx) => {
      for (const employee of missingAccountEmployees) {
        let email = generatedEmployeeLoginIdentifier(employee, emailDomain);
        let suffix = 2;
        // Phone is the primary login identifier. If a phone/email imported from
        // the employee source collides, fall back to a deterministic temporary
        // account so the employee can set their phone number on first login.
        while (await tx.user.findUnique({ where: { tenantId_email: { tenantId: request.user.tenantId, email } } })) {
          email = generatedEmployeeFallbackEmail(employee, emailDomain, suffix);
          suffix += 1;
        }

        const temporaryPassword = generatedTemporaryPassword();
        const passwordHash = await bcrypt.hash(temporaryPassword, passwordHashRounds);
        const user = await tx.user.create({
          data: {
            email,
            mustChangePassword: true,
            name: employee.name,
            passwordHash,
            status: requestedStatus,
            tenantId: request.user.tenantId,
            employeeId: employee.id
          }
        });
        await tx.userRole.createMany({
          data: roles.map((role) => ({
            tenantId: request.user.tenantId,
            userId: user.id,
            roleId: role.id
          })),
          skipDuplicates: true
        });
        credentials.push({
          employeeId: employee.id,
          employeeNo: employee.employeeNo,
          name: employee.name,
          email,
          temporaryPassword,
          roleCodes: [...roleCodes].sort()
        });
      }

      await appendAuditLog(tx, {
        tenantId: request.user.tenantId,
        actorUserId: request.user.sub,
        action: "iam.employee_accounts.sync",
        objectType: "user",
        objectId: "employee-account-library",
        summary: `批量生成员工账号 ${credentials.length} 个`,
        metadata: {
          createdCount: credentials.length,
          skippedCount: employees.length - missingAccountEmployees.length,
          includeLeavers,
          roleCodes: [...roleCodes].sort(),
          status: requestedStatus
        },
        ...requestAuditMeta(request)
      });
    });

    const overview = await loadIamOverview(app.prisma, request.user.tenantId);
    return reply.code(201).send({
      accountStats: overview.accountStats,
      credentials,
      createdCount: credentials.length,
      skippedCount: employees.length - missingAccountEmployees.length
    });
  });

  app.post("/api/iam/account-activations", { preHandler: app.authenticate }, async (request, reply) => {
    await requirePermission(app, request, { module: "iam", action: "write" });
    const employeeId = String(request.body?.employeeId || "").trim();
    const roleCodes = normalizeRoleCodes(request.body?.roleCodes || ["employee-self-service"]);
    const expiresInDays = request.body?.expiresInDays ?? 7;

    if (!employeeId) {
      return reply.code(400).send({ error: "employee_id_required", message: "请选择需要开户注册的员工。" });
    }
    if (!roleCodes.length) {
      return reply.code(400).send({ error: "user_roles_required", message: "激活账号至少需要保留一个角色。" });
    }

    const employee = await app.prisma.employee.findFirst({
      where: { id: employeeId, tenantId: request.user.tenantId },
      include: { department: true, user: true }
    });
    if (!employee) return reply.code(404).send({ error: "employee_not_found", message: "员工不存在。" });
    if (employee.status !== "ACTIVE") {
      return reply.code(400).send({ error: "employee_not_active", message: "只能给在职员工生成账号激活码。" });
    }
    if (employee.user) {
      return reply.code(409).send({ error: "employee_account_exists", message: "该员工已经有关联账号。" });
    }

    const roles = await app.prisma.role.findMany({
      where: {
        tenantId: request.user.tenantId,
        code: { in: roleCodes }
      }
    });
    const foundCodes = new Set(roles.map((role) => role.code));
    const missingCodes = roleCodes.filter((code) => !foundCodes.has(code));
    if (missingCodes.length) return reply.code(400).send({ error: "unknown_role_codes", missingCodes });

    let activation;
    let activationCode = "";
    await app.prisma.$transaction(async (tx) => {
      await tx.accountActivation.updateMany({
        where: {
          employeeId,
          status: "PENDING",
          tenantId: request.user.tenantId
        },
        data: { status: "REVOKED" }
      });

      activationCode = generatedActivationCode();
      activation = await tx.accountActivation.create({
        data: {
          createdByUserId: request.user.sub,
          employeeId,
          expiresAt: activationExpiry(expiresInDays),
          roleCodes: [...roleCodes].sort(),
          tenantId: request.user.tenantId,
          tokenHash: activationCodeHash(activationCode)
        },
        include: { employee: { include: { department: true } } }
      });

      await appendAuditLog(tx, {
        tenantId: request.user.tenantId,
        actorUserId: request.user.sub,
        action: "iam.account_activation.create",
        objectType: "account_activation",
        objectId: activation.id,
        summary: `生成员工 ${employee.name} 账号激活码`,
        metadata: {
          employeeId,
          employeeNo: employee.employeeNo,
          expiresAt: activation.expiresAt,
          roleCodes: [...roleCodes].sort()
        },
        ...requestAuditMeta(request)
      });
    });

    return reply.code(201).send({ activation: serializeAccountActivation(activation, activationCode) });
  });

  app.post("/api/iam/users", { preHandler: app.authenticate }, async (request, reply) => {
    await requirePermission(app, request, { module: "iam", action: "write" });
    const email = requestLoginIdentifier(request.body);
    const name = String(request.body?.name || "").trim();
    const newPassword = String(request.body?.newPassword || "");
    const roleCodes = normalizeRoleCodes(request.body?.roleCodes);
    const requestedStatus = request.body?.status === undefined ? "ACTIVE" : normalizeUserStatus(request.body?.status);

    if (!validLoginIdentifier(email)) {
      return reply.code(400).send({ error: "invalid_login_identifier", message: "登录账号需要使用手机号；历史邮箱账号仍可兼容登录。" });
    }
    if (!name) {
      return reply.code(400).send({ error: "user_name_required", message: "账号姓名必填。" });
    }
    if (!roleCodes.length) {
      return reply.code(400).send({ error: "user_roles_required", message: "用户至少需要保留一个角色。" });
    }
    if (!requestedStatus) {
      return reply.code(400).send({ error: "invalid_user_status", message: "账号状态必须是 ACTIVE 或 DISABLED。" });
    }

    const validation = validateNewPassword(newPassword);
    if (!validation.ok) {
      return reply.code(400).send({
        error: "password_policy_failed",
        message: validation.message,
        details: { reasons: validation.reasons }
      });
    }

    const existing = await app.prisma.user.findUnique({
      where: { tenantId_email: { tenantId: request.user.tenantId, email } }
    });
    if (existing) {
      return reply.code(409).send({ error: "user_email_exists", message: "该登录账号已存在。" });
    }

    const roles = await app.prisma.role.findMany({
      where: {
        tenantId: request.user.tenantId,
        code: { in: roleCodes }
      }
    });
    const foundCodes = new Set(roles.map((role) => role.code));
    const missingCodes = roleCodes.filter((code) => !foundCodes.has(code));
    if (missingCodes.length) return reply.code(400).send({ error: "unknown_role_codes", missingCodes });

    const passwordHash = await bcrypt.hash(newPassword, passwordHashRounds);
    let created;
    try {
      await app.prisma.$transaction(async (tx) => {
        const user = await tx.user.create({
          data: {
            email,
            mustChangePassword: request.body?.mustChangePassword === false ? false : true,
            name,
            passwordHash,
            status: requestedStatus,
            tenantId: request.user.tenantId
          }
        });
        await tx.userRole.createMany({
          data: roles.map((role) => ({
            tenantId: request.user.tenantId,
            userId: user.id,
            roleId: role.id
          })),
          skipDuplicates: true
        });
        await appendAuditLog(tx, {
          tenantId: request.user.tenantId,
          actorUserId: request.user.sub,
          action: "iam.user.create",
          objectType: "user",
          objectId: user.id,
          summary: `创建账号 ${name}`,
          metadata: {
            email,
            roleCodes: [...roleCodes].sort(),
            status: requestedStatus
          },
          ...requestAuditMeta(request)
        });
        created = user;
      });
    } catch (error) {
      if (error?.code === "P2002") {
        return reply.code(409).send({ error: "user_email_exists", message: "该登录账号已存在。" });
      }
      throw error;
    }

    const user = await app.prisma.user.findFirst({
      where: { id: created.id, tenantId: request.user.tenantId },
      include: {
        employee: true,
        roles: { include: { role: true } }
      }
    });
    return reply.code(201).send({ user: serializeUser(user) });
  });

  app.put("/api/iam/roles/:id/permissions", { preHandler: app.authenticate }, async (request, reply) => {
    await requirePermission(app, request, { module: "iam", action: "write" });
    const permissionCodes = normalizePermissionCodes(request.body?.permissionCodes);
    const role = await app.prisma.role.findFirst({
      where: { id: request.params.id, tenantId: request.user.tenantId },
      include: { permissions: { include: { permission: true } } }
    });
    if (!role) return reply.code(404).send({ error: "role_not_found" });

    if (role.code === "admin" && (!permissionCodes.includes("system.admin") || !permissionCodes.includes("iam.write"))) {
      return reply.code(400).send({ error: "admin_role_guard_required", message: "系统管理员角色必须保留 system.admin 和 iam.write。" });
    }

    const permissions = await app.prisma.permission.findMany({
      where: {
        tenantId: request.user.tenantId,
        code: { in: permissionCodes }
      }
    });
    const foundCodes = new Set(permissions.map((permission) => permission.code));
    const missingCodes = permissionCodes.filter((code) => !foundCodes.has(code));
    if (missingCodes.length) {
      return reply.code(400).send({ error: "unknown_permission_codes", missingCodes });
    }

    const beforeCodes = permissionRows(role).map((permission) => permission.code).sort();
    const afterCodes = [...permissionCodes].sort();
    await app.prisma.$transaction(async (tx) => {
      await tx.rolePermission.deleteMany({
        where: { tenantId: request.user.tenantId, roleId: role.id }
      });
      if (permissions.length) {
        await tx.rolePermission.createMany({
          data: permissions.map((permission) => rolePermissionCreateData({
            tenantId: request.user.tenantId,
            role,
            permission
          })),
          skipDuplicates: true
        });
      }
      await appendAuditLog(tx, {
        tenantId: request.user.tenantId,
        actorUserId: request.user.sub,
        action: "iam.role_permissions.update",
        objectType: "role",
        objectId: role.id,
        summary: `更新角色 ${role.name} 权限`,
        metadata: {
          roleCode: role.code,
          beforeCodes,
          afterCodes
        },
        ...requestAuditMeta(request)
      });
    });

    const updated = await app.prisma.role.findFirst({
      where: { id: role.id, tenantId: request.user.tenantId },
      include: {
        permissions: { include: { permission: true } },
        users: { include: { user: true } }
      }
    });
    return { role: serializeRole(updated) };
  });

  app.put("/api/iam/users/:id/roles", { preHandler: app.authenticate }, async (request, reply) => {
    await requirePermission(app, request, { module: "iam", action: "write" });
    const roleCodes = normalizeRoleCodes(request.body?.roleCodes);
    if (!roleCodes.length) {
      return reply.code(400).send({ error: "user_roles_required", message: "用户至少需要保留一个角色。" });
    }

    const user = await app.prisma.user.findFirst({
      where: { id: request.params.id, tenantId: request.user.tenantId },
      include: { roles: { include: { role: true } } }
    });
    if (!user) return reply.code(404).send({ error: "user_not_found" });

    const roles = await app.prisma.role.findMany({
      where: {
        tenantId: request.user.tenantId,
        code: { in: roleCodes }
      }
    });
    const foundCodes = new Set(roles.map((role) => role.code));
    const missingCodes = roleCodes.filter((code) => !foundCodes.has(code));
    if (missingCodes.length) return reply.code(400).send({ error: "unknown_role_codes", missingCodes });

    const beforeCodes = (user.roles || []).map((item) => item.role?.code).filter(Boolean).sort();
    const afterCodes = [...roleCodes].sort();
    if (user.id === request.user.sub && beforeCodes.includes("admin") && !afterCodes.includes("admin")) {
      return reply.code(400).send({ error: "admin_self_role_guard_required", message: "不能移除当前管理员自己的 admin 角色。" });
    }

    await app.prisma.$transaction(async (tx) => {
      await tx.userRole.deleteMany({
        where: { tenantId: request.user.tenantId, userId: user.id }
      });
      await tx.userRole.createMany({
        data: roles.map((role) => ({
          tenantId: request.user.tenantId,
          userId: user.id,
          roleId: role.id
        })),
        skipDuplicates: true
      });
      await appendAuditLog(tx, {
        tenantId: request.user.tenantId,
        actorUserId: request.user.sub,
        action: "iam.user_roles.update",
        objectType: "user",
        objectId: user.id,
        summary: `更新账号 ${user.name} 角色`,
        metadata: {
          email: user.email,
          beforeCodes,
          afterCodes
        },
        ...requestAuditMeta(request)
      });
    });

    const updated = await app.prisma.user.findFirst({
      where: { id: user.id, tenantId: request.user.tenantId },
      include: {
        employee: true,
        roles: { include: { role: true } }
      }
    });
    return { user: serializeUser(updated) };
  });

  app.put("/api/iam/users/:id/status", { preHandler: app.authenticate }, async (request, reply) => {
    await requirePermission(app, request, { module: "iam", action: "write" });
    const status = normalizeUserStatus(request.body?.status);
    if (!status) {
      return reply.code(400).send({ error: "invalid_user_status", message: "账号状态必须是 ACTIVE 或 DISABLED。" });
    }

    const user = await app.prisma.user.findFirst({
      where: { id: request.params.id, tenantId: request.user.tenantId },
      include: {
        employee: true,
        roles: { include: { role: true } }
      }
    });
    if (!user) return reply.code(404).send({ error: "user_not_found" });

    if (user.id === request.user.sub && status === "DISABLED") {
      return reply.code(400).send({ error: "admin_self_status_guard_required", message: "不能停用当前登录账号。" });
    }

    const beforeStatus = user.status;
    let updated;
    await app.prisma.$transaction(async (tx) => {
      updated = await tx.user.update({
        where: { id: user.id },
        data: {
          status,
          ...(status === "DISABLED" && beforeStatus !== "DISABLED"
            ? { sessionVersion: { increment: 1 } }
            : {})
        },
        include: {
          employee: true,
          roles: { include: { role: true } }
        }
      });
      await appendAuditLog(tx, {
        tenantId: request.user.tenantId,
        actorUserId: request.user.sub,
        action: "iam.user_status.update",
        objectType: "user",
        objectId: user.id,
        summary: `更新账号 ${user.name} 状态`,
        metadata: {
          afterStatus: status,
          beforeStatus,
          email: user.email,
          sessionRevoked: status === "DISABLED" && beforeStatus !== "DISABLED"
        },
        ...requestAuditMeta(request)
      });
    });

    return { user: serializeUser(updated) };
  });

  app.put("/api/iam/users/:id/password", { preHandler: app.authenticate }, async (request, reply) => {
    await requirePermission(app, request, { module: "iam", action: "write" });
    const newPassword = String(request.body?.newPassword || "");
    const validation = validateNewPassword(newPassword);
    if (!validation.ok) {
      return reply.code(400).send({
        error: "password_policy_failed",
        message: validation.message,
        details: { reasons: validation.reasons }
      });
    }

    const user = await app.prisma.user.findFirst({
      where: { id: request.params.id, tenantId: request.user.tenantId },
      include: {
        employee: true,
        roles: { include: { role: true } }
      }
    });
    if (!user) return reply.code(404).send({ error: "user_not_found" });

    if (user.id === request.user.sub) {
      return reply.code(400).send({
        error: "admin_self_password_reset_guard_required",
        message: "管理员不能在账号管理中重置自己的密码，请使用个人改密。"
      });
    }

    const passwordHash = await bcrypt.hash(newPassword, passwordHashRounds);
    let updated;
    await app.prisma.$transaction(async (tx) => {
      updated = await tx.user.update({
        where: { id: user.id },
        data: {
          passwordHash,
          mustChangePassword: true,
          sessionVersion: { increment: 1 }
        },
        include: {
          employee: true,
          roles: { include: { role: true } }
        }
      });
      await appendAuditLog(tx, {
        tenantId: request.user.tenantId,
        actorUserId: request.user.sub,
        action: "iam.user_password.reset",
        objectType: "user",
        objectId: user.id,
        summary: `重置账号 ${user.name} 密码`,
        metadata: {
          email: user.email,
          sessionRevoked: true
        },
        ...requestAuditMeta(request)
      });
    });

    return { user: serializeUser(updated) };
  });
}
