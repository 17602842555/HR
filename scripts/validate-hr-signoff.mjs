import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";
import { loadDashboardPeople } from "./dashboard-data.mjs";

export const requiredMaskedFields = Object.freeze([
  "idCard",
  "bankAccount",
  "phone",
  "address",
  "salary",
  "hukou",
  "school",
  "major",
  "age"
]);

export const requiredApprovalRoles = Object.freeze(["HR owner", "Product owner"]);

const placeholderFragments = Object.freeze([
  "example",
  "placeholder",
  "replace",
  "todo",
  "待填写",
  "示例"
]);

function isBlank(value) {
  return String(value ?? "").trim() === "";
}

function hasPlaceholder(value) {
  const text = String(value ?? "").trim().toLowerCase();
  return !text || placeholderFragments.some((fragment) => text.includes(fragment.toLowerCase()));
}

function normalizeChecksum(value) {
  return String(value || "").trim().replace(/^sha256:/i, "").toLowerCase();
}

function isIsoDateTime(value) {
  if (typeof value !== "string" || !value.trim()) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && /\d{4}-\d{2}-\d{2}T/.test(value);
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

export function sha256Text(text) {
  return createHash("sha256").update(String(text || "")).digest("hex");
}

export function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function dashboardSignoffCounts(sourcePath = new URL("../oa-dashboard.html", import.meta.url)) {
  const people = loadDashboardPeople(sourcePath);
  return {
    activeEmployees: people.employees.length,
    leavers: people.leavers.length,
    femaleEmployees: people.femaleEmployees.length,
    monthLeavers: people.monthLeavers.length,
    departments: new Set(people.employees.map((item) => item.department).filter(Boolean)).size,
    orgs: new Set(people.employees.map((item) => item.org).filter(Boolean)).size
  };
}

export function validateHrDataSignoff(signoff, {
  allowExample = false,
  expectedCounts = {},
  expectedChecksum = "",
  sourceName = "oa-dashboard.html"
} = {}) {
  const errors = [];
  const warnings = [];
  const source = signoff?.source || {};
  const counts = source.counts || {};
  const dataPolicy = signoff?.dataPolicy || {};
  const fieldPolicy = dataPolicy.fieldPolicy || {};
  const exportPolicy = dataPolicy.exportPolicy || {};
  const retention = dataPolicy.retention || {};
  const approvals = list(signoff?.approvals);
  const exceptions = list(signoff?.openExceptions);
  const permitPlaceholders = allowExample && signoff?.example === true;

  if (!signoff || typeof signoff !== "object" || Array.isArray(signoff)) {
    return { ok: false, errors: ["Signoff payload must be a JSON object."], warnings, summary: {} };
  }
  if (signoff.schemaVersion !== 1) errors.push("schemaVersion must be 1.");
  if (signoff.example === true && !allowExample) errors.push("Example signoff files cannot be used as release evidence.");
  if (!permitPlaceholders && hasPlaceholder(signoff.documentId)) errors.push("documentId must be a real non-placeholder identifier.");
  if (!["staging", "production"].includes(String(signoff.environment || ""))) {
    errors.push("environment must be staging or production.");
  }
  if (!isIsoDateTime(signoff.signedAt)) errors.push("signedAt must be an ISO datetime.");

  if (source.sourceName !== sourceName && basename(source.sourceName || "") !== sourceName) {
    errors.push(`source.sourceName must identify ${sourceName}.`);
  }
  const actualChecksum = normalizeChecksum(expectedChecksum);
  const signedChecksum = normalizeChecksum(source.sourceChecksum);
  if (!/^[a-f0-9]{64}$/.test(signedChecksum)) {
    errors.push("source.sourceChecksum must be a SHA-256 hex digest.");
  } else if (actualChecksum && signedChecksum !== actualChecksum) {
    errors.push("source.sourceChecksum does not match the current source file.");
  }
  if (!isIsoDateTime(source.importedAt)) errors.push("source.importedAt must be an ISO datetime.");

  Object.entries(expectedCounts).forEach(([key, expected]) => {
    if (Number(counts[key]) !== Number(expected)) {
      errors.push(`source.counts.${key} must be ${expected}.`);
    }
  });

  if (fieldPolicy.defaultMasked !== true) errors.push("dataPolicy.fieldPolicy.defaultMasked must be true.");
  if (fieldPolicy.revealPermission !== "employee.sensitive.read") {
    errors.push("dataPolicy.fieldPolicy.revealPermission must be employee.sensitive.read.");
  }
  const maskedFields = list(fieldPolicy.maskedFields);
  requiredMaskedFields.forEach((field) => {
    if (!maskedFields.includes(field)) errors.push(`dataPolicy.fieldPolicy.maskedFields must include ${field}.`);
  });

  if (exportPolicy.requiresPermission !== true) errors.push("dataPolicy.exportPolicy.requiresPermission must be true.");
  if (exportPolicy.allowsSensitiveExport !== false) errors.push("dataPolicy.exportPolicy.allowsSensitiveExport must be false.");
  if (exportPolicy.recordsExportLedger !== true) errors.push("dataPolicy.exportPolicy.recordsExportLedger must be true.");
  if (exportPolicy.requiresBusinessReason !== true) errors.push("dataPolicy.exportPolicy.requiresBusinessReason must be true.");

  ["employeeRecords", "leaverRecords", "auditLogs", "exportFiles"].forEach((key) => {
    if (!permitPlaceholders && hasPlaceholder(retention[key])) errors.push(`dataPolicy.retention.${key} must be reviewed and non-placeholder.`);
  });

  requiredApprovalRoles.forEach((role) => {
    const approval = approvals.find((item) => item.role === role && item.decision === "approved");
    if (!approval) {
      errors.push(`approvals must include an approved ${role}.`);
      return;
    }
    if (!permitPlaceholders && (hasPlaceholder(approval.name) || hasPlaceholder(approval.email))) {
      errors.push(`${role} approval must include a real name and email.`);
    }
    if (!isIsoDateTime(approval.approvedAt)) errors.push(`${role} approval must include an ISO approvedAt.`);
  });
  if (!approvals.some((item) => item.role === "Security reviewer" && item.decision === "approved")) {
    warnings.push("Security reviewer approval is recommended for production data cuts.");
  }

  if (signoff.environment === "production" && exceptions.length > 0) {
    errors.push("production signoff must not contain openExceptions.");
  }
  exceptions.forEach((item, index) => {
    if (!permitPlaceholders && (hasPlaceholder(item.owner) || hasPlaceholder(item.exitCriteria))) {
      errors.push(`openExceptions[${index}] must include owner and exitCriteria.`);
    }
  });

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    summary: {
      documentId: signoff.documentId || null,
      environment: signoff.environment || null,
      sourceName: source.sourceName || null,
      counts,
      expectedCounts,
      approvalRoles: approvals.map((item) => item.role).filter(Boolean),
      openExceptionCount: exceptions.length
    }
  };
}

export function loadHrSignoff(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function resolvePath(path) {
  return isAbsolute(path) ? path : resolve(process.cwd(), path);
}

export function parseHrSignoffArgs(argv = []) {
  const options = {
    signoffPath: "docs/hr-data-signoff.json",
    sourcePath: "oa-dashboard.html",
    json: argv.includes("--json"),
    allowExample: argv.includes("--allow-example")
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--source") {
      options.sourcePath = argv[index + 1] || options.sourcePath;
      index += 1;
    } else if (!arg.startsWith("--")) {
      options.signoffPath = arg;
    }
  }
  return options;
}

async function main(argv = process.argv.slice(2)) {
  const options = parseHrSignoffArgs(argv);
  const signoffPath = resolvePath(options.signoffPath);
  const sourcePath = resolvePath(options.sourcePath);

  try {
    if (!existsSync(signoffPath)) throw new Error(`HR data signoff file does not exist: ${signoffPath}`);
    if (!existsSync(sourcePath)) throw new Error(`Dashboard source file does not exist: ${sourcePath}`);
    const result = validateHrDataSignoff(loadHrSignoff(signoffPath), {
      allowExample: options.allowExample,
      expectedCounts: dashboardSignoffCounts(sourcePath),
      expectedChecksum: sha256File(sourcePath),
      sourceName: basename(sourcePath)
    });
    const payload = { path: signoffPath, sourcePath, ...result };
    if (options.json) {
      console.log(JSON.stringify(payload, null, 2));
    } else if (result.ok) {
      console.log(`HR data signoff validation passed: ${signoffPath}`);
      result.warnings.forEach((warning) => console.warn(`Warning: ${warning}`));
    } else {
      console.error(`HR data signoff validation failed: ${signoffPath}`);
      result.errors.forEach((error) => console.error(`- ${error}`));
      result.warnings.forEach((warning) => console.warn(`Warning: ${warning}`));
    }
    process.exitCode = result.ok ? 0 : 1;
  } catch (error) {
    if (options.json) {
      console.log(JSON.stringify({ ok: false, errors: [error.message], warnings: [] }, null, 2));
    } else {
      console.error(error.message);
    }
    process.exitCode = 1;
  }
}

if (import.meta.url === new URL(process.argv[1], "file:").href) {
  main();
}
