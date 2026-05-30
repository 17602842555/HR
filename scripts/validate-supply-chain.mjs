import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

const defaultAllowedLicenses = Object.freeze([
  "0BSD",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "CC-BY-4.0",
  "ISC",
  "MIT"
]);

function resolvePath(path) {
  return isAbsolute(path) ? path : resolve(process.cwd(), path);
}

function readJson(path) {
  return JSON.parse(readFileSync(resolvePath(path), "utf8"));
}

function licenseTokens(license) {
  return String(license || "")
    .replace(/[()]/g, " ")
    .split(/\s+(?:AND|OR|WITH)\s+|\s+/i)
    .map((item) => item.trim())
    .filter(Boolean);
}

function lockPackageName(path, entry) {
  if (entry?.name) return entry.name;
  return String(path || "").replace(/^node_modules\//, "");
}

export function validatePackageLockData({
  allowedLicenses = defaultAllowedLicenses,
  lock,
  packageJson
} = {}) {
  const errors = [];
  const warnings = [];
  const allowed = new Set(allowedLicenses);
  const rootPackage = lock?.packages?.[""] || {};
  const packages = Object.entries(lock?.packages || {}).filter(([path]) => path);

  if (!lock || typeof lock !== "object") errors.push("package-lock.json is missing or invalid.");
  if (!packageJson || typeof packageJson !== "object") errors.push("package.json is missing or invalid.");
  if (!Number.isInteger(lock?.lockfileVersion) || lock.lockfileVersion < 3) {
    errors.push("package-lock.json must use lockfileVersion >= 3.");
  }
  if (!lock?.packages?.[""]) errors.push("package-lock.json must contain a root packages[''] entry.");

  const declared = {
    ...packageJson?.dependencies,
    ...packageJson?.devDependencies
  };
  const lockedRoot = {
    ...rootPackage.dependencies,
    ...rootPackage.devDependencies
  };

  Object.keys(declared).sort().forEach((name) => {
    if (!lockedRoot[name]) errors.push(`package-lock root entry is missing declared dependency: ${name}.`);
  });

  packages.forEach(([path, entry]) => {
    const name = lockPackageName(path, entry);
    if (entry?.link) return;
    if (!entry?.integrity) errors.push(`${name} is missing integrity in package-lock.json.`);
    if (!entry?.resolved) {
      warnings.push(`${name} has no resolved registry URL.`);
    } else if (!String(entry.resolved).startsWith("https://registry.npmjs.org/")) {
      errors.push(`${name} must resolve from https://registry.npmjs.org/.`);
    }
    if (!entry?.license) {
      errors.push(`${name} is missing license metadata.`);
    } else {
      const unknownTokens = licenseTokens(entry.license).filter((token) => !allowed.has(token));
      if (unknownTokens.length) errors.push(`${name} uses unapproved license: ${entry.license}.`);
    }
  });

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    summary: {
      allowedLicenses: [...allowed].sort(),
      declaredDependencyCount: Object.keys(packageJson?.dependencies || {}).length,
      declaredDevDependencyCount: Object.keys(packageJson?.devDependencies || {}).length,
      lockfileVersion: lock?.lockfileVersion || null,
      packageCount: packages.length
    }
  };
}

export function parseSupplyChainArgs(argv = process.argv.slice(2)) {
  const args = {
    json: false,
    lockPath: "package-lock.json",
    packagePath: "package.json"
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") args.json = true;
    else if (arg === "--lock") args.lockPath = argv[++index] || args.lockPath;
    else if (arg === "--package") args.packagePath = argv[++index] || args.packagePath;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/validate-supply-chain.mjs [--json] [--lock package-lock.json] [--package package.json]`);
}

async function main() {
  const args = parseSupplyChainArgs();
  if (args.help) {
    printHelp();
    return;
  }
  const result = validatePackageLockData({
    lock: readJson(args.lockPath),
    packageJson: readJson(args.packagePath)
  });
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (result.ok) {
    console.log(`Supply-chain validation passed for ${result.summary.packageCount} locked packages.`);
  } else {
    console.error("Supply-chain validation failed:");
    result.errors.forEach((error) => console.error(`- ${error}`));
  }
  if (!result.ok) process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
