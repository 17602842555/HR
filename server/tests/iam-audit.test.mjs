import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { redactAuditPayload } from "../src/modules/audit/redaction.mjs";
import { assertPermission, evaluatePermission } from "../src/modules/iam/permissionEvaluator.mjs";
import { getPrincipal } from "../src/modules/iam/route-guards.mjs";

const commercialPermissionCodes = [
  "system.admin",
  "analytics.read",
  "analytics.export",
  "iam.read",
  "iam.write",
  "employee.read",
  "employee.sensitive.read",
  "employee.write",
  "employee.export",
  "workflow.read",
  "workflow.write",
  "workflow.approve",
  "workflow.export",
  "attendance.read",
  "attendance.write",
  "attendance.export",
  "finance.read",
  "finance.write",
  "finance.export",
  "asset.read",
  "asset.write",
  "asset.export",
  "import.read",
  "import.write",
  "resource.read",
  "resource.book",
  "resource.export",
  "audit.read",
  "audit.export",
  "file.read",
  "file.upload"
];

function extractBackendPermissionCodes(seedText) {
  const section = seedText.match(/const permissions = \[([\s\S]*?)\];/);
  assert.ok(section, "backend permission seed section missing");
  return [...section[1].matchAll(/\["([^"]+)"/g)].map((match) => match[1]).sort();
}

function extractFrontendPermissionCodes(seedText) {
  const section = seedText.match(/export const permissionCatalog = \[([\s\S]*?)\];/);
  assert.ok(section, "frontend permission catalog section missing");
  return [...section[1].matchAll(/code: "([^"]+)"/g)].map((match) => match[1]).sort();
}

function walkMjsFiles(dirUrl) {
  return readdirSync(dirUrl, { withFileTypes: true }).flatMap((entry) => {
    const childUrl = new URL(entry.name, dirUrl);
    if (entry.isDirectory()) return walkMjsFiles(new URL(`${entry.name}/`, dirUrl));
    return statSync(childUrl).isFile() && entry.name.endsWith(".mjs") ? [childUrl] : [];
  });
}

function extractRoutePermissionRequirements() {
  return walkMjsFiles(new URL("../src/modules/", import.meta.url)).flatMap((fileUrl) => {
    const source = readFileSync(fileUrl, "utf8");
    return [...source.matchAll(/requirePermission\(app,\s*request,\s*\{[\s\S]*?module:\s*"([^"]+)"[\s\S]*?action:\s*"([^"]+)"/g)]
      .map((match) => ({ file: fileUrl.pathname, module: match[1], action: match[2] }));
  });
}

function permissionCodeCoversRoute(code, required) {
  return code === `${required.module}.${required.action}` || code.startsWith(`${required.module}.${required.action}.`);
}

test("permission evaluator rejects fields outside the role field allow-list", () => {
  const principal = {
    id: "hr-1",
    departmentId: "dept-hr",
    roles: [
      {
        id: "hr-specialist",
        permissions: [
          {
            module: "employee",
            actions: ["read", "update"],
            fields: {
              allow: ["name", "phone", "departmentId"],
              deny: ["salary", "idCard", "bankAccount"]
            },
            export: false,
            dataScope: { type: "department" }
          }
        ]
      }
    ]
  };

  const decision = evaluatePermission({
    principal,
    module: "employee",
    action: "read",
    fields: ["name", "salary"],
    resource: { id: "emp-1", ownerId: "emp-1", departmentId: "dept-hr" }
  });

  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, "field_denied");
  assert.deepEqual(decision.allowedFields, ["name"]);
  assert.deepEqual(decision.deniedFields, ["salary"]);
  assert.throws(() => assertPermission(decision), /Permission evaluation denied/);
});

test("permission evaluator enforces export and dataScope separately", () => {
  const principal = {
    id: "manager-1",
    departmentId: "dept-a",
    permissions: [
      {
        module: "employee",
        actions: ["read"],
        fields: ["name"],
        export: false,
        dataScope: "department"
      }
    ]
  };

  const exportDecision = evaluatePermission({
    principal,
    module: "employee",
    action: "read",
    fields: ["name"],
    exportRequested: true,
    resource: { id: "emp-1", departmentId: "dept-a" }
  });
  assert.equal(exportDecision.allowed, false);
  assert.equal(exportDecision.reason, "export_denied");

  const scopeDecision = evaluatePermission({
    principal,
    module: "employee",
    action: "read",
    fields: ["name"],
    resource: { id: "emp-2", departmentId: "dept-b" }
  });
  assert.equal(scopeDecision.allowed, false);
  assert.equal(scopeDecision.reason, "data_scope_denied");
});

test("route guard principal lookup is scoped to the authenticated tenant", async () => {
  let capturedWhere = null;
  const app = {
    prisma: {
      user: {
        findFirst: async ({ where } = {}) => {
          capturedWhere = where;
          return {
            id: "user-1",
            tenantId: "tenant-a",
            email: "user@example.test",
            name: "租户用户",
            status: "ACTIVE",
            employee: { id: "emp-1", name: "租户员工", departmentId: "dept-a" },
            roles: []
          };
        }
      }
    }
  };

  const principal = await getPrincipal(app, {
    user: {
      sub: "user-1",
      tenantId: "tenant-a"
    }
  });

  assert.deepEqual(capturedWhere, { id: "user-1", tenantId: "tenant-a" });
  assert.equal(principal.id, "user-1");
  assert.equal(principal.departmentId, "dept-a");
});

test("frontend IAM permission catalog stays aligned with backend seed permissions", () => {
  const frontendSeed = readFileSync(new URL("../../src/data/seed.js", import.meta.url), "utf8");
  const backendSeed = readFileSync(new URL("../../scripts/seed.mjs", import.meta.url), "utf8");
  const auditFeature = readFileSync(new URL("../../src/features/Audit.jsx", import.meta.url), "utf8");
  const backendCodes = extractBackendPermissionCodes(backendSeed);
  const frontendCodes = extractFrontendPermissionCodes(frontendSeed);
  const expectedCodes = [...commercialPermissionCodes].sort();

  assert.deepEqual(backendCodes, expectedCodes, "backend seed permission catalog drifted from the commercial baseline");
  assert.deepEqual(frontendCodes, backendCodes, "frontend permission catalog must exactly mirror backend seed permissions");

  for (const code of commercialPermissionCodes) {
    assert.ok(frontendSeed.includes(`code: "${code}"`), `frontend permission catalog missing ${code}`);
    assert.ok(backendSeed.includes(`["${code}"`), `backend seed permissions missing ${code}`);
  }

  for (const requirement of extractRoutePermissionRequirements()) {
    assert.ok(
      backendCodes.some((code) => permissionCodeCoversRoute(code, requirement)),
      `backend seed permissions do not cover route ${requirement.module}.${requirement.action} in ${requirement.file}`
    );
    assert.ok(
      frontendCodes.some((code) => permissionCodeCoversRoute(code, requirement)),
      `frontend permissions do not cover route ${requirement.module}.${requirement.action} in ${requirement.file}`
    );
  }

  [
    "analytics: \"管理看板\"",
    "attendance: \"假勤\"",
    "finance: \"财务行政\"",
    "import: \"数据导入\"",
    "file: \"文件附件\""
  ].forEach((label) => {
    assert.ok(auditFeature.includes(label), `Audit permission editor missing module label ${label}`);
  });
});

test("redactAuditPayload masks phone address idCard bank salary and attachment objectKey", () => {
  const payload = {
    employee: {
      name: "张三",
      phone: "13800138000",
      address: "上海市徐汇区示例路 1 号",
      idCard: "310101199001011234",
      bankAccount: "6222020202020202020",
      salary: 28000
    },
    attachments: [
      {
        fileName: "invoice.pdf",
        objectKey: "private/hr/invoice.pdf",
        size: 1024
      }
    ],
    comment: "普通审计备注"
  };

  const redacted = redactAuditPayload(payload);

  assert.equal(redacted.employee.name, "张三");
  assert.equal(redacted.employee.phone, "[REDACTED:phone]");
  assert.equal(redacted.employee.address, "[REDACTED:address]");
  assert.equal(redacted.employee.idCard, "[REDACTED:id-card]");
  assert.equal(redacted.employee.bankAccount, "[REDACTED:bank]");
  assert.equal(redacted.employee.salary, "[REDACTED:salary]");
  assert.equal(redacted.attachments[0].objectKey, "[REDACTED:attachment-object-key]");
  assert.equal(redacted.attachments[0].fileName, "invoice.pdf");
  assert.equal(redacted.comment, "普通审计备注");

  assert.equal(payload.employee.phone, "13800138000");
  assert.equal(payload.attachments[0].objectKey, "private/hr/invoice.pdf");
});

test("initial migration enforces append-only audit logs with update and delete triggers", () => {
  const migration = readFileSync(
    new URL("../../prisma/migrations/20260529120000_init_commercial_oa/migration.sql", import.meta.url),
    "utf8"
  );

  assert.match(migration, /CREATE OR REPLACE FUNCTION prevent_audit_log_mutation/);
  assert.match(migration, /BEFORE UPDATE ON "audit_logs"/);
  assert.match(migration, /BEFORE DELETE ON "audit_logs"/);
  assert.match(migration, /audit_logs are append-only/);
});

test("initial migration prevents overlapping confirmed resource bookings", () => {
  const migration = readFileSync(
    new URL("../../prisma/migrations/20260529120000_init_commercial_oa/migration.sql", import.meta.url),
    "utf8"
  );

  assert.match(migration, /CREATE EXTENSION IF NOT EXISTS "btree_gist"/);
  assert.match(migration, /CONSTRAINT "bookings_valid_time_range" CHECK \("ends_at" > "starts_at"\)/);
  assert.match(migration, /CONSTRAINT "bookings_no_confirmed_overlap"/);
  assert.match(migration, /EXCLUDE USING gist/);
  assert.ok(migration.includes("tsrange(\"starts_at\", \"ends_at\", '[)') WITH &&"));
  assert.match(migration, /WHERE \("status" = 'CONFIRMED'\)/);
});

test("finance attendance migration creates durable leave and payroll tables", () => {
  const migration = readFileSync(
    new URL("../../prisma/migrations/20260529160000_finance_attendance/migration.sql", import.meta.url),
    "utf8"
  );

  assert.match(migration, /CREATE TABLE "leave_requests"/);
  assert.match(migration, /CREATE TABLE "payroll_batches"/);
  assert.match(migration, /"leave_requests_tenant_id_status_idx"/);
  assert.match(migration, /"payroll_batches_tenant_id_status_idx"/);
  assert.match(migration, /"payroll_batches_tenant_id_batch_no_key"/);
});

test("business workflow link migration connects leave and payroll records to approval instances", () => {
  const migration = readFileSync(
    new URL("../../prisma/migrations/20260529163000_business_workflow_links/migration.sql", import.meta.url),
    "utf8"
  );

  assert.match(migration, /ALTER TABLE "payroll_batches" ADD COLUMN "workflow_instance_id"/);
  assert.match(migration, /"leave_requests_tenant_id_workflow_instance_id_idx"/);
  assert.match(migration, /"payroll_batches_tenant_id_workflow_instance_id_idx"/);
  assert.match(migration, /"leave_requests_workflow_instance_id_fkey"/);
  assert.match(migration, /"payroll_batches_workflow_instance_id_fkey"/);
});

test("finance request migration creates durable payment and expense ledger", () => {
  const migration = readFileSync(
    new URL("../../prisma/migrations/20260530190000_finance_requests/migration.sql", import.meta.url),
    "utf8"
  );

  assert.match(migration, /CREATE TABLE "finance_requests"/);
  assert.match(migration, /"finance_requests_tenant_id_request_no_key"/);
  assert.match(migration, /"finance_requests_tenant_id_request_type_idx"/);
  assert.match(migration, /"finance_requests_tenant_id_status_idx"/);
  assert.match(migration, /"finance_requests_workflow_instance_id_fkey"/);
});

test("data import migration records source checksum and imported row counts", () => {
  const migration = readFileSync(
    new URL("../../prisma/migrations/20260529172000_data_import_runs/migration.sql", import.meta.url),
    "utf8"
  );

  assert.match(migration, /CREATE TABLE "data_import_runs"/);
  assert.match(migration, /"source_checksum" TEXT NOT NULL/);
  assert.match(migration, /"record_counts" JSONB NOT NULL DEFAULT '\{\}'/);
  assert.match(migration, /"data_import_runs_tenant_id_source_name_source_checksum_idx"/);
  assert.match(migration, /"data_import_runs_actor_user_id_fkey"/);
});

test("data import success migration prevents duplicate successful source checksums", () => {
  const migration = readFileSync(
    new URL("../../prisma/migrations/20260530090000_data_import_success_unique/migration.sql", import.meta.url),
    "utf8"
  );

  assert.match(migration, /CREATE UNIQUE INDEX "data_import_runs_success_unique"/);
  assert.match(migration, /ON "data_import_runs"\("tenant_id", "source_name", "source_checksum"\)/);
  assert.match(migration, /WHERE "status" = 'SUCCESS'/);
});

test("data import run append-only migration prevents lineage mutation", () => {
  const migration = readFileSync(
    new URL("../../prisma/migrations/20260530234000_data_import_runs_append_only/migration.sql", import.meta.url),
    "utf8"
  );
  const seed = readFileSync(new URL("../../scripts/seed.mjs", import.meta.url), "utf8");

  assert.match(migration, /CREATE OR REPLACE FUNCTION prevent_data_import_run_mutation/);
  assert.match(migration, /BEFORE UPDATE ON "data_import_runs"/);
  assert.match(migration, /BEFORE DELETE ON "data_import_runs"/);
  assert.match(migration, /data_import_runs are append-only/);
  assert.match(seed, /Import lineage is append-only/);
  assert.doesNotMatch(seed, /prisma\.dataImportRun\.update\(/);
});

test("workflow submit idempotency migration prevents duplicate submitted instances", () => {
  const migration = readFileSync(
    new URL("../../prisma/migrations/20260530113000_workflow_submit_idempotency/migration.sql", import.meta.url),
    "utf8"
  );

  assert.match(migration, /ALTER TABLE "workflow_instances" ADD COLUMN "idempotency_key" TEXT/);
  assert.match(migration, /CREATE UNIQUE INDEX "workflow_instances_tenant_id_idempotency_key_key"/);
  assert.match(migration, /ON "workflow_instances"\("tenant_id", "idempotency_key"\)/);
});

test("role permission policy migration persists data scopes field policies and export flags", () => {
  const migration = readFileSync(
    new URL("../../prisma/migrations/20260530143000_role_permission_policies/migration.sql", import.meta.url),
    "utf8"
  );

  assert.match(migration, /ALTER TABLE "role_permissions"/);
  assert.match(migration, /ADD COLUMN "data_scope" JSONB/);
  assert.match(migration, /ADD COLUMN "field_policy" JSONB/);
  assert.match(migration, /ADD COLUMN "allow_export" BOOLEAN NOT NULL DEFAULT false/);
});

test("export record migration persists auditable export metadata", () => {
  const migration = readFileSync(
    new URL("../../prisma/migrations/20260530213000_export_records/migration.sql", import.meta.url),
    "utf8"
  );

  assert.match(migration, /CREATE TABLE "export_records"/);
  assert.match(migration, /"row_count" INTEGER NOT NULL DEFAULT 0/);
  assert.match(migration, /"filters" JSONB NOT NULL DEFAULT '\{\}'/);
  assert.match(migration, /"request_id" TEXT/);
  assert.match(migration, /CREATE INDEX "export_records_tenant_id_created_at_idx"/);
  assert.match(migration, /FOREIGN KEY \("actor_user_id"\) REFERENCES "users"\("id"\) ON DELETE SET NULL/);
  const reasonMigration = readFileSync(
    new URL("../../prisma/migrations/20260530231500_export_business_reason/migration.sql", import.meta.url),
    "utf8"
  );
  assert.match(reasonMigration, /ADD COLUMN "business_reason" TEXT/);
});

test("export record append-only migration prevents update and delete mutation", () => {
  const migration = readFileSync(
    new URL("../../prisma/migrations/20260530233000_export_records_append_only/migration.sql", import.meta.url),
    "utf8"
  );

  assert.match(migration, /CREATE OR REPLACE FUNCTION prevent_export_record_mutation/);
  assert.match(migration, /BEFORE UPDATE ON "export_records"/);
  assert.match(migration, /BEFORE DELETE ON "export_records"/);
  assert.match(migration, /export_records are append-only/);
});
