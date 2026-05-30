export const EMPLOYEE_SAFE_READ_FIELDS = Object.freeze([
  "id",
  "seq",
  "org",
  "name",
  "gender",
  "department",
  "departmentId",
  "role",
  "roleTitle",
  "entryDate",
  "leaveDate",
  "regularDate",
  "education",
  "status"
]);

export const EMPLOYEE_SENSITIVE_FIELDS = Object.freeze([
  "phone",
  "address",
  "idCard",
  "bankAccount",
  "salary",
  "hukou",
  "school",
  "major"
]);

const DEPARTMENT_SCOPED_ROLES = new Set(["department-manager"]);

function isExportPermission(permissionCode) {
  return String(permissionCode || "").endsWith(".export");
}

function isEmployeePermission(permissionCode) {
  return String(permissionCode || "").startsWith("employee.");
}

export function defaultRolePermissionPolicy(roleCode, permissionCode) {
  const policy = {
    allowExport: isExportPermission(permissionCode)
  };

  if (isEmployeePermission(permissionCode)) {
    policy.dataScope = DEPARTMENT_SCOPED_ROLES.has(roleCode)
      ? { type: "department" }
      : { type: "all" };
  }

  if (permissionCode === "employee.read") {
    policy.fieldPolicy = {
      allow: EMPLOYEE_SAFE_READ_FIELDS,
      deny: EMPLOYEE_SENSITIVE_FIELDS
    };
  }

  if (permissionCode === "employee.export") {
    policy.fieldPolicy = {
      allow: EMPLOYEE_SAFE_READ_FIELDS,
      deny: EMPLOYEE_SENSITIVE_FIELDS
    };
  }

  if (permissionCode === "employee.write") {
    policy.fieldPolicy = {
      allow: ["departmentId", "roleTitle", "status", "leaveDate"],
      deny: EMPLOYEE_SENSITIVE_FIELDS
    };
  }

  if (permissionCode === "employee.sensitive.read") {
    policy.fieldPolicy = {
      allow: ["hukou", "school", "major"],
      deny: ["idCard", "bankAccount", "salary", "phone", "address"]
    };
  }

  return policy;
}

export function rolePermissionCreateData({ tenantId, role, permission }) {
  const policy = defaultRolePermissionPolicy(role.code, permission.code);
  return {
    tenantId,
    roleId: role.id,
    permissionId: permission.id,
    dataScope: policy.dataScope || null,
    fieldPolicy: policy.fieldPolicy || null,
    allowExport: Boolean(policy.allowExport)
  };
}
