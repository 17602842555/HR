function permissionCodeParts(code) {
  const [modulePart, actionPart = "*"] = String(code || "").split(/[:.]/, 2);
  return {
    module: modulePart || "*",
    action: actionPart || "*"
  };
}

export function rolePermissionCode(link) {
  return link?.permission?.code || "";
}

export function rolePermissionAccess(link) {
  const permission = link?.permission;
  if (!permission?.code) return null;
  const parts = permissionCodeParts(permission.code);
  return {
    code: permission.code,
    name: permission.name,
    module: parts.module,
    actions: [parts.action],
    fields: link.fieldPolicy || ["*"],
    dataScope: link.dataScope || "all",
    export: Boolean(link.allowExport) || parts.action === "export"
  };
}

export function rolePermissionCodes(role) {
  return (role.permissions || []).map(rolePermissionCode).filter(Boolean);
}

export function rolePermissionAccessList(role) {
  return (role.permissions || []).map(rolePermissionAccess).filter(Boolean);
}

export function serializeUser(user) {
  const roles = (user.roles || []).map((item) => item.role).filter(Boolean);
  const permissions = roles.flatMap(rolePermissionCodes);

  return {
    id: user.id,
    tenantId: user.tenantId,
    email: user.email,
    name: user.name,
    status: user.status,
    employee: user.employee ? {
      id: user.employee.id,
      employeeNo: user.employee.employeeNo,
      name: user.employee.name,
      departmentId: user.employee.departmentId,
      roleTitle: user.employee.roleTitle
    } : null,
    roles: roles.map((role) => ({ code: role.code, name: role.name })),
    permissions: [...new Set(permissions)]
  };
}

export const userWithAccessInclude = {
  employee: true,
  roles: {
    include: {
      role: {
        include: {
          permissions: {
            include: {
              permission: true
            }
          }
        }
      }
    }
  }
};
