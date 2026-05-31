import { apiRequest } from "./client.js";

export function getCurrentUser() {
  return apiRequest("/auth/me");
}

export function login(credentials) {
  return apiRequest("/auth/login", {
    body: credentials,
    method: "POST"
  });
}

export function changePassword(payload) {
  return apiRequest("/auth/change-password", {
    body: payload,
    method: "POST"
  });
}

export function completeFirstLogin(payload) {
  return apiRequest("/auth/complete-first-login", {
    body: payload,
    method: "POST"
  });
}

export function activateAccount(payload) {
  return apiRequest("/auth/activate-account", {
    body: payload,
    method: "POST"
  });
}

export function logout() {
  return apiRequest("/auth/logout", {
    method: "POST"
  });
}
