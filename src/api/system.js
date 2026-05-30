import { apiRequest } from "./client.js";

export function getSystemReadiness() {
  return apiRequest("/system/readiness");
}
