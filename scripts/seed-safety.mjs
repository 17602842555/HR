import { isAbsolute } from "node:path";
import { validateNewPassword } from "../server/src/modules/auth/password-policy.mjs";

export const defaultSeedAdminPassword = "admin123456";

function isProductionEnv(env = process.env) {
  return env.NODE_ENV === "production" || env.APP_ENV === "production";
}

export function assertSeedSafety(env = process.env) {
  if (!isProductionEnv(env)) {
    return { ok: true, production: false };
  }

  if (env.ALLOW_PRODUCTION_SEED !== "1") {
    throw new Error("Production database seed is blocked. Set ALLOW_PRODUCTION_SEED=1 only after reviewed bootstrap approval.");
  }

  const adminPassword = env.DEFAULT_ADMIN_PASSWORD || defaultSeedAdminPassword;
  if (!env.DEFAULT_ADMIN_PASSWORD || adminPassword === defaultSeedAdminPassword) {
    throw new Error("Production seed requires explicit non-default DEFAULT_ADMIN_PASSWORD.");
  }

  const passwordPolicy = validateNewPassword(adminPassword);
  if (!passwordPolicy.ok) {
    throw new Error(`Production seed DEFAULT_ADMIN_PASSWORD must satisfy password policy: ${passwordPolicy.reasons.join(",")}`);
  }

  const fileStorageDriver = String(env.FILE_STORAGE_DRIVER || "local").trim() || "local";
  if (fileStorageDriver === "s3") {
    ["OBJECT_STORAGE_ENDPOINT", "OBJECT_STORAGE_BUCKET", "OBJECT_STORAGE_REGION", "OBJECT_STORAGE_ACCESS_KEY_ID", "OBJECT_STORAGE_SECRET_ACCESS_KEY"].forEach((key) => {
      if (!String(env[key] || "").trim()) {
        throw new Error(`Production seed requires ${key} when FILE_STORAGE_DRIVER=s3.`);
      }
    });
    return { ok: true, production: true };
  }

  if (!env.FILE_STORAGE_DIR || !isAbsolute(env.FILE_STORAGE_DIR)) {
    throw new Error("Production seed requires explicit absolute FILE_STORAGE_DIR.");
  }

  return { ok: true, production: true };
}
