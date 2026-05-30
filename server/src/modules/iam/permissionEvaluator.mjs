import { PermissionDeniedError } from "../../lib/domainErrors.mjs";

export const DataScopeType = Object.freeze({
  ALL: "all",
  DEPARTMENT: "department",
  OWN: "own",
  CUSTOM: "custom",
  NONE: "none"
});

function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function parsePermissionCode(code) {
  const [modulePart, actionPart = "*"] = String(code).split(/[:.]/, 2);
  return {
    code,
    module: modulePart || "*",
    actions: [actionPart || "*"],
    fields: ["*"],
    export: actionPart === "export",
    dataScope: DataScopeType.ALL
  };
}

function normalizePermission(permission) {
  if (typeof permission === "string") return parsePermissionCode(permission);
  if (permission?.code && !permission.module && !permission.modules && !permission.action && !permission.actions) {
    return { ...parsePermissionCode(permission.code), ...permission };
  }
  return permission;
}

function normalizePermissionList(principal = {}) {
  const directPermissions = asArray(principal.permissions);
  const rolePermissions = asArray(principal.roles).flatMap((role) => asArray(role.permissions));
  return [...directPermissions, ...rolePermissions].filter(Boolean).map(normalizePermission);
}

function matchesPattern(pattern, value) {
  if (pattern === "*" || pattern === value) return true;
  if (typeof pattern !== "string" || typeof value !== "string") return false;
  if (pattern.endsWith(".*")) {
    const prefix = pattern.slice(0, -2);
    return value === prefix || value.startsWith(`${prefix}.`);
  }
  return false;
}

function matchesModule(permission, moduleName) {
  return asArray(permission.modules ?? permission.module).some((pattern) => matchesPattern(pattern, moduleName));
}

function matchesAction(permission, action) {
  return asArray(permission.actions ?? permission.action).some((pattern) => matchesPattern(pattern, action));
}

function normalizeFieldRule(fields) {
  if (!fields) return { allow: ["*"], deny: [] };
  if (Array.isArray(fields)) return { allow: fields, deny: [] };
  return {
    allow: asArray(fields.allow ?? fields.allowed ?? fields.read ?? "*"),
    deny: asArray(fields.deny ?? fields.denied)
  };
}

function fieldAllowedByPermission(permission, field) {
  const rule = normalizeFieldRule(permission.fields);
  const denied = rule.deny.some((pattern) => matchesPattern(pattern, field));
  if (denied) return false;
  return rule.allow.some((pattern) => matchesPattern(pattern, field));
}

function scopeType(scope) {
  if (!scope) return DataScopeType.ALL;
  return typeof scope === "string" ? scope : scope.type;
}

function idsContain(list, value) {
  return value !== undefined && value !== null && asArray(list).map(String).includes(String(value));
}

function idsOverlap(left, right) {
  const rightIds = new Set(asArray(right).filter((value) => value !== undefined && value !== null).map(String));
  return asArray(left).some((value) => value !== undefined && value !== null && rightIds.has(String(value)));
}

export function isDataScopeAllowed({ permission, principal = {}, resource = {}, context = {} }) {
  const scope = permission.dataScope ?? permission.scope ?? DataScopeType.ALL;
  const type = scopeType(scope);
  const scopeConfig = typeof scope === "string" ? {} : scope;
  const principalIds = [principal.id, principal.userId, principal.employeeId].filter(Boolean);
  const departmentId = principal.departmentId ?? principal.department?.id;
  const resourceOwnerIds = [
    resource.ownerId,
    resource.applicantId,
    resource.createdById,
    resource.userId,
    resource.employeeId
  ].filter(Boolean);
  const resourceDepartmentId = resource.departmentId ?? resource.department?.id;

  if (type === DataScopeType.ALL) return true;
  if (type === DataScopeType.NONE) return false;
  if (type === DataScopeType.OWN) return idsOverlap(principalIds, resourceOwnerIds);
  if (type === DataScopeType.DEPARTMENT) {
    const departments = scopeConfig.departmentIds ?? context.departmentIds ?? departmentId;
    return idsContain(departments, resourceDepartmentId);
  }
  if (type === DataScopeType.CUSTOM) {
    if (typeof scopeConfig.predicate === "function") {
      return Boolean(scopeConfig.predicate({ principal, resource, context }));
    }
    const ownerAllowed = resourceOwnerIds.some((ownerId) => idsContain(scopeConfig.ownerIds, ownerId));
    const resourceAllowed = idsContain(scopeConfig.resourceIds, resource.id);
    const departmentAllowed = idsContain(scopeConfig.departmentIds, resourceDepartmentId);
    return ownerAllowed || resourceAllowed || departmentAllowed;
  }
  return false;
}

export function evaluatePermission({
  principal,
  module,
  action,
  fields = [],
  exportRequested = false,
  resource = {},
  context = {}
}) {
  const permissions = normalizePermissionList(principal);
  const matched = permissions.filter((permission) => matchesModule(permission, module) && matchesAction(permission, action));
  const requestedFields = [...new Set(asArray(fields).filter(Boolean))];

  if (matched.length === 0) {
    return {
      allowed: false,
      reason: "module_action_denied",
      module,
      action,
      allowedFields: [],
      deniedFields: requestedFields,
      exportAllowed: false,
      dataScopeAllowed: false,
      matchedPermissions: []
    };
  }

  const exportAllowed = !exportRequested || matched.some((permission) => {
    if (permission.export === true || permission.canExport === true) return true;
    return matchesAction(permission, "export");
  });

  const allowedFields = requestedFields.filter((field) => matched.some((permission) => fieldAllowedByPermission(permission, field)));
  const deniedFields = requestedFields.filter((field) => !allowedFields.includes(field));
  const dataScopeAllowed = matched.some((permission) => isDataScopeAllowed({ permission, principal, resource, context }));

  const allowed = exportAllowed && deniedFields.length === 0 && dataScopeAllowed;
  const reason = allowed
    ? "allowed"
    : !exportAllowed
      ? "export_denied"
      : deniedFields.length > 0
        ? "field_denied"
        : "data_scope_denied";

  return {
    allowed,
    reason,
    module,
    action,
    allowedFields,
    deniedFields,
    exportAllowed,
    dataScopeAllowed,
    matchedPermissions: matched
  };
}

export function assertPermission(decision) {
  if (!decision.allowed) {
    throw new PermissionDeniedError("Permission evaluation denied the requested operation.", {
      reason: decision.reason,
      module: decision.module,
      action: decision.action,
      deniedFields: decision.deniedFields,
      exportAllowed: decision.exportAllowed,
      dataScopeAllowed: decision.dataScopeAllowed
    });
  }
  return decision;
}
