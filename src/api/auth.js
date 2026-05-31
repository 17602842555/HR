import { apiRequest } from "./client.js";

export function getCurrentUser() {
  return apiRequest("/auth/me");
}

export function login(credentials) {
  const login = credentials?.login || credentials?.phone || credentials?.email || "";
  return apiRequest("/auth/login", {
    body: { ...credentials, email: login, login },
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
  const login = payload?.login || payload?.phone || payload?.email || "";
  return apiRequest("/auth/complete-first-login", {
    body: { ...payload, email: login, login },
    method: "POST"
  });
}

export function activateAccount(payload) {
  const login = payload?.login || payload?.phone || payload?.email || "";
  return apiRequest("/auth/activate-account", {
    body: { ...payload, email: login, login },
    method: "POST"
  });
}

export function logout() {
  return apiRequest("/auth/logout", {
    method: "POST"
  });
}
