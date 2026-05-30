import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { validateCommercialDrillEvidence } from "./validate-drill-evidence.mjs";

export const defaultLocalRecoveryDrillSummaryPath = "commercial-evidence/latest-local-recovery-drill-summary.json";

function resolvePath(path, rootDir = process.cwd()) {
  return isAbsolute(path) ? path : resolve(rootDir, path);
}

export function parseLocalRecoveryDrillArgs(argv = []) {
  const options = {
    summaryPath: defaultLocalRecoveryDrillSummaryPath,
    json: argv.includes("--json")
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--summary") {
      options.summaryPath = argv[index + 1] || options.summaryPath;
      index += 1;
    } else if (!arg.startsWith("--")) {
      options.summaryPath = arg;
    }
  }

  return options;
}

export function validateLocalRecoveryDrillEvidence(summaryPath = defaultLocalRecoveryDrillSummaryPath, { rootDir = process.cwd() } = {}) {
  const result = validateCommercialDrillEvidence(summaryPath, {
    rootDir,
    allowedKinds: ["commercial-local-recovery-drill"]
  });
  const resolvedSummaryPath = resolvePath(summaryPath, rootDir);
  const warnings = [...result.warnings];

  if (result.ok && existsSync(resolvedSummaryPath)) {
    const summary = JSON.parse(readFileSync(resolvedSummaryPath, "utf8"));
    if (summary.executionMode !== "local-postgres") {
      return {
        ...result,
        ok: false,
        errors: [...result.errors, "local recovery drill executionMode must be local-postgres."],
        warnings
      };
    }
    warnings.push("Local recovery drill is diagnostic evidence only; it does not replace Docker compose release drill evidence.");
  }

  return { ...result, warnings };
}

async function main(argv = process.argv.slice(2)) {
  const options = parseLocalRecoveryDrillArgs(argv);
  const result = validateLocalRecoveryDrillEvidence(options.summaryPath);
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (result.ok) {
    console.log(`Local recovery drill evidence validation passed: ${result.summaryPath}`);
    result.warnings.forEach((warning) => console.warn(`Warning: ${warning}`));
  } else {
    console.error(`Local recovery drill evidence validation failed: ${result.summaryPath}`);
    result.errors.forEach((error) => console.error(`- ${error}`));
  }
  process.exitCode = result.ok ? 0 : 66;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
