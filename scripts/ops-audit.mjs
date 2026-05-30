import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { PrismaClient } from "@prisma/client";
import { appendAuditLog } from "../server/src/modules/audit/audit-service.mjs";

export const OPS_AUDIT_ACTIONS = new Set(["ops.backup", "ops.restore", "ops.backup_prune"]);

export function parseMetadataFile(path) {
  if (!path) return {};
  return Object.fromEntries(
    readFileSync(path, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const index = line.indexOf("=");
        return index === -1 ? [line, ""] : [line.slice(0, index), line.slice(index + 1)];
      })
  );
}

function usage() {
  return "Usage: node scripts/ops-audit.mjs ops.backup|ops.restore|ops.backup_prune <metadata-file>";
}

export function opsAuditObjectType(metadata = {}) {
  if (metadata.artifact_type === "backup_retention") return "ops_backup_retention";
  if (metadata.artifact_type === "file_storage") return "ops_file_storage";
  return "ops_database";
}

export function opsAuditSummary(action, metadata = {}) {
  const isFileStorage = metadata.artifact_type === "file_storage";
  if (action === "ops.backup_prune") return "备份保留清理完成";
  if (action === "ops.backup") return isFileStorage ? "文件存储备份完成" : "数据库备份完成";
  if (action === "ops.restore") return isFileStorage ? "文件存储恢复完成" : "数据库恢复完成";
  return "运维审计事件";
}

export function buildOpsAuditInput({ action, tenant, actor, metadata = {} }) {
  if (!OPS_AUDIT_ACTIONS.has(action)) {
    throw new Error(`Unsupported ops audit action: ${action}`);
  }
  if (!tenant?.id) {
    throw new Error("Tenant is required for ops audit.");
  }
  return {
    tenantId: tenant.id,
    actorUserId: actor?.id || null,
    action,
    objectType: opsAuditObjectType(metadata),
    objectId: metadata.backup_file || metadata.restore_file || null,
    summary: opsAuditSummary(action, metadata),
    metadata,
    ipAddress: "127.0.0.1",
    userAgent: "scripts/ops-audit.mjs"
  };
}

export async function recordOpsAudit({
  prisma,
  action,
  metadataPath,
  tenantCode = "default",
  adminEmail = "admin@oa.local"
}) {
  const metadata = parseMetadataFile(metadataPath);
  const tenant = await prisma.tenant.findUnique({ where: { code: tenantCode } });
  if (!tenant) throw new Error(`Tenant not found: ${tenantCode}`);
  const actor = await prisma.user.findUnique({
    where: { tenantId_email: { tenantId: tenant.id, email: adminEmail } }
  }).catch(() => null);

  return appendAuditLog(prisma, buildOpsAuditInput({ action, tenant, actor, metadata }));
}

export async function main({
  argv = process.argv,
  env = process.env,
  prisma = new PrismaClient(),
  log = console.log,
  error = console.error
} = {}) {
  const action = argv[2] || "";
  const metadataPath = argv[3] || "";
  if (!OPS_AUDIT_ACTIONS.has(action)) {
    error(usage());
    return 64;
  }
  await recordOpsAudit({
    prisma,
    action,
    metadataPath,
    tenantCode: env.DEFAULT_TENANT_CODE || "default",
    adminEmail: env.DEFAULT_ADMIN_EMAIL || "admin@oa.local"
  });
  log(`Recorded audit event: ${action}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const prisma = new PrismaClient();
  try {
    process.exitCode = await main({ prisma });
  } finally {
    await prisma.$disconnect();
  }
}
