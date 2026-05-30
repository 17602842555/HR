import { apiRequest } from "./client.js";

export function getIamOverview() {
  return apiRequest("/iam");
}

export function createUser(payload) {
  return apiRequest("/iam/users", {
    body: payload,
    method: "POST"
  });
}

export function syncEmployeeAccounts(payload) {
  return apiRequest("/iam/accounts/sync-employees", {
    body: payload,
    method: "POST"
  });
}

export function updateRolePermissions(roleId, permissionCodes) {
  return apiRequest(`/iam/roles/${encodeURIComponent(roleId)}/permissions`, {
    body: { permissionCodes },
    method: "PUT"
  });
}

export function updateUserRoles(userId, roleCodes) {
  return apiRequest(`/iam/users/${encodeURIComponent(userId)}/roles`, {
    body: { roleCodes },
    method: "PUT"
  });
}

export function updateUserStatus(userId, status) {
  return apiRequest(`/iam/users/${encodeURIComponent(userId)}/status`, {
    body: { status },
    method: "PUT"
  });
}

export function resetUserPassword(userId, newPassword) {
  return apiRequest(`/iam/users/${encodeURIComponent(userId)}/password`, {
    body: { newPassword },
    method: "PUT"
  });
}
