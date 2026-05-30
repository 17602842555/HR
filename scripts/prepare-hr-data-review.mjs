import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadDashboardPeople } from "./dashboard-data.mjs";
import { dashboardSignoffCounts, requiredMaskedFields, sha256File } from "./validate-hr-signoff.mjs";

const defaultOutputDir = "reports/commercial-evidence/hr-data-review";
const reviewColumns = Object.freeze([
  "reviewKey",
  "status",
  "maskedName",
  "gender",
  "org",
  "department",
  "role",
  "entryDate",
  "regularDate",
  "leaveDate",
  "femaleRosterMatched",
  "currentMonthLeaverMatched",
  "sourceDataset"
]);
const forbiddenHeaderFragments = Object.freeze([
  ...requiredMaskedFields,
  "id",
  "card",
  "bank",
  "phone",
  "address",
  "salary"
]);

function nowIso(now = new Date()) {
  return now.toISOString();
}

function slugTimestamp(value) {
  return String(value || nowIso()).replaceAll(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function resolveFromRoot(rootDir, path) {
  if (!path) return rootDir;
  return isAbsolute(path) ? path : resolve(rootDir, path);
}

function sha256Text(text) {
  return createHash("sha256").update(String(text || "")).digest("hex");
}

function ensurePrivateDir(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

function writePrivateTextFile(path, text) {
  ensurePrivateDir(dirname(path));
  writeFileSync(path, text, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function reviewKeyForPerson(person) {
  const raw = [
    person.status,
    person.name,
    person.org,
    person.department,
    person.role,
    person.entryDate,
    person.leaveDate
  ].map((value) => String(value || "").trim()).join("|");
  return sha256Text(raw).slice(0, 16);
}

function maskName(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  const chars = Array.from(text);
  if (chars.length === 1) return "*";
  return `${chars[0]}${"*".repeat(Math.min(chars.length - 1, 2))}`;
}

export function escapeCsvCell(value) {
  const raw = String(value ?? "");
  const escapedFormula = /^[\s]*[=+\-@]/.test(raw) ? `'${raw}` : raw;
  return escapedFormula;
}

function csvCell(value) {
  const escaped = escapeCsvCell(value);
  if (/[",\n\r]/.test(escaped)) return `"${escaped.replaceAll("\"", "\"\"")}"`;
  return escaped;
}

function assertNoSensitiveReviewFields() {
  const lowerHeaders = reviewColumns.map((column) => column.toLowerCase());
  const offenders = forbiddenHeaderFragments.filter((fragment) => (
    lowerHeaders.some((header) => header.includes(String(fragment).toLowerCase()))
  ));
  if (offenders.length > 0) {
    throw new Error(`HR review CSV includes forbidden sensitive fields: ${offenders.join(", ")}`);
  }
}

export function buildHrReviewRows(people) {
  const femaleKeys = new Set(people.femaleEmployees.map(reviewKeyForPerson));
  const monthLeaverKeys = new Set(people.monthLeavers.map(reviewKeyForPerson));
  return [
    ...people.employees.map((person) => ({ person, sourceDataset: "active-employees" })),
    ...people.leavers.map((person) => ({ person, sourceDataset: "leavers" }))
  ].map(({ person, sourceDataset }) => {
    const reviewKey = reviewKeyForPerson(person);
    return {
      reviewKey,
      status: person.status || "",
      maskedName: maskName(person.name),
      gender: person.gender || "",
      org: person.org || "",
      department: person.department || "",
      role: person.role || "",
      entryDate: person.entryDate || "",
      regularDate: person.regularDate || "",
      leaveDate: person.leaveDate || "",
      femaleRosterMatched: femaleKeys.has(reviewKey) ? "yes" : "no",
      currentMonthLeaverMatched: monthLeaverKeys.has(reviewKey) ? "yes" : "no",
      sourceDataset
    };
  });
}

function serializeReviewCsv(rows) {
  assertNoSensitiveReviewFields();
  return [
    reviewColumns.join(","),
    ...rows.map((row) => reviewColumns.map((column) => csvCell(row[column])).join(","))
  ].join("\n") + "\n";
}

function buildSummary({ generatedAt, sourcePath, rows, counts, csvText }) {
  const departments = [...new Set(rows.map((row) => row.department).filter(Boolean))].sort();
  const orgs = [...new Set(rows.map((row) => row.org).filter(Boolean))].sort();
  return {
    schemaVersion: 1,
    draft: true,
    kind: "hr-data-review-preparation",
    generatedAt,
    source: {
      sourceName: basename(sourcePath),
      sourceChecksum: sha256File(sourcePath),
      counts: {
        ...counts,
        totalReviewRows: rows.length
      }
    },
    reviewPolicy: {
      noSensitiveFields: true,
      maskedIdentityFields: ["name"],
      excludedSensitiveFields: [...requiredMaskedFields],
      exportUse: "Reviewer preparation package only. It is not release evidence until a real HR/Product signoff passes validation.",
      nextValidator: "npm run validate:hr-signoff -- <hr-data-signoff.json> --source oa-dashboard.html --json"
    },
    reviewCsv: {
      rowCount: rows.length,
      columns: [...reviewColumns],
      sha256: sha256Text(csvText)
    },
    distributions: {
      departmentCount: departments.length,
      orgCount: orgs.length,
      departments,
      orgs
    }
  };
}

function readmeText({ generatedAt, sourcePath }) {
  return [
    "# HR Data Review Preparation",
    "",
    `Generated at: ${generatedAt}`,
    `Source: ${basename(sourcePath)}`,
    "",
    "This directory is a reviewer preparation package only. It is not release evidence.",
    "",
    "No sensitive fields are included in `people-review.csv`. Names are masked and the CSV excludes identity-card, bank, phone, address, salary, education, hukou, school, major, and age fields.",
    "",
    "Use `summary.json` to confirm the current source checksum and imported counts. After HR/Product review, create a real non-example signoff and run:",
    "",
    "```bash",
    "npm run validate:hr-signoff -- <hr-data-signoff.json> --source oa-dashboard.html --json",
    "```",
    ""
  ].join("\n");
}

function buildManifest({ generatedAt, rootDir, outputDir, sourcePath, files, summary }) {
  return {
    schemaVersion: 1,
    draft: true,
    kind: "hr-data-review-preparation",
    generatedAt,
    outputDir: relative(rootDir, outputDir) || ".",
    source: {
      dashboardHtml: relative(rootDir, sourcePath),
      sourceChecksum: summary.source.sourceChecksum,
      counts: summary.source.counts
    },
    noSensitiveFields: true,
    files: Object.fromEntries(Object.entries(files).map(([key, filePath]) => [key, relative(rootDir, filePath)])),
    releaseUse: "Preparation package only. It is not release evidence until a reviewed non-example HR/Product signoff passes validate:hr-signoff.",
    nextCommands: [
      "npm run validate:hr-signoff -- <hr-data-signoff.json> --source oa-dashboard.html --json",
      "npm run evidence:commercial -- --full --strict-readiness"
    ]
  };
}

export function prepareHrDataReview(options = {}) {
  const rootDir = resolve(options.rootDir || process.cwd());
  const now = options.now || new Date();
  const generatedAt = nowIso(now);
  const sourcePath = resolveFromRoot(rootDir, options.sourcePath || "oa-dashboard.html");
  if (!existsSync(sourcePath)) {
    throw new Error(`Dashboard source file does not exist: ${sourcePath}`);
  }
  const baseOutputDir = resolveFromRoot(rootDir, options.outputDir || defaultOutputDir);
  const runDir = join(baseOutputDir, `hr-data-review-${slugTimestamp(generatedAt)}`);
  const files = {
    peopleReviewCsv: join(runDir, "people-review.csv"),
    summary: join(runDir, "summary.json"),
    readme: join(runDir, "README.md"),
    manifest: join(runDir, "manifest.json")
  };
  const people = loadDashboardPeople(sourcePath);
  const rows = buildHrReviewRows(people);
  const csvText = serializeReviewCsv(rows);
  const summary = buildSummary({
    generatedAt,
    sourcePath,
    rows,
    counts: dashboardSignoffCounts(sourcePath),
    csvText
  });
  const manifest = buildManifest({
    generatedAt,
    rootDir,
    outputDir: runDir,
    sourcePath,
    files,
    summary
  });

  ensurePrivateDir(baseOutputDir);
  ensurePrivateDir(runDir);
  writePrivateTextFile(files.peopleReviewCsv, csvText);
  writePrivateTextFile(files.summary, `${JSON.stringify(summary, null, 2)}\n`);
  writePrivateTextFile(files.readme, readmeText({ generatedAt, sourcePath }));
  writePrivateTextFile(files.manifest, `${JSON.stringify(manifest, null, 2)}\n`);
  writePrivateTextFile(join(baseOutputDir, "latest-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  return { generatedAt, outputDir: runDir, files, manifest, summary, rows };
}

export function parseHrDataReviewArgs(argv = []) {
  const options = {
    outputDir: defaultOutputDir,
    sourcePath: "oa-dashboard.html",
    json: argv.includes("--json")
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--output") {
      options.outputDir = argv[index + 1] || options.outputDir;
      index += 1;
    } else if (arg === "--source") {
      options.sourcePath = argv[index + 1] || options.sourcePath;
      index += 1;
    }
  }
  return options;
}

async function main(argv = process.argv.slice(2)) {
  const options = parseHrDataReviewArgs(argv);
  try {
    const result = prepareHrDataReview(options);
    const payload = {
      ok: true,
      outputDir: result.outputDir,
      files: result.files,
      noSensitiveFields: result.manifest.noSensitiveFields,
      counts: result.summary.source.counts,
      nextCommands: result.manifest.nextCommands
    };
    if (options.json) {
      console.log(JSON.stringify(payload, null, 2));
    } else {
      console.log(`HR data review package generated: ${result.outputDir}`);
      Object.values(result.files).forEach((filePath) => console.log(`- ${filePath}`));
      console.log("No sensitive fields were generated. This package is reviewer preparation only, not release evidence.");
    }
  } catch (error) {
    if (options.json) {
      console.log(JSON.stringify({ ok: false, errors: [error.message] }, null, 2));
    } else {
      console.error(error.message);
    }
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main();
}
