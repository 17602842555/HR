import { assertPermission, evaluatePermission } from "./permissionEvaluator.mjs";
import { rolePermissionAccessList, rolePermissionCodes, userWithAccessInclude } from "./permissions.mjs";

function principalFromUser(user) {
  const roles = (user.roles || []).map((item) => item.role).filter(Boolean);
  const permissions = roles.flatMap(rolePermissionAccessList);

  return {
    id: user.id,
    userId: user.id,
    name: user.name,
    email: user.email,
    employeeId: user.employee?.id || null,
    employeeName: user.employee?.name || null,
    departmentId: user.employee?.departmentId || null,
    roles: roles.map((role) => ({
      id: role.id,
      code: role.code,
      name: role.name,
      permissions: rolePermissionAccessList(role),
      permissionCodes: rolePermissionCodes(role)
    })),
    permissions
  };
}

export async function getPrincipal(app, request) {
  const user = await app.prisma.user.findFirst({
    where: { id: request.user.sub, tenantId: request.user.tenantId },
    include: userWithAccessInclude
  });
  if (!user || user.status !== "ACTIVE") return null;
  return principalFromUser(user);
}

export async function requirePermission(app, request, options) {
  const principal = await getPrincipal(app, request);
  const decision = evaluatePermission({
    principal: principal || {},
    module: options.module,
    action: options.action,
    fields: options.fields || [],
    exportRequested: Boolean(options.exportRequested),
    resource: options.resource || {},
    context: options.context || {}
  });
  assertPermission(decision);
  return { principal, decision };
}

export function hasPermission(principal, module, action) {
  return evaluatePermission({
    principal: principal || {},
    module,
    action
  }).allowed;
}
