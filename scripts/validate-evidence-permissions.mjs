import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const defaultEvidenceDir = "reports/commercial-evidence";
const requiredEvidenceFiles = Object.freeze([
  "latest.json",
  "latest-gap-report.json",
  "latest-gap-report.md",
  "latest-owner-handoff-manifest.json",
  "latest-owner-handoff.md",
  "sbom/latest-spdx.json",
  "hr-data-review/latest-manifest.json"
]);
const optionalEvidenceFiles = Object.freeze([
  "latest-candidate.json",
  "latest-dossier.md",
  "production-env-prep/latest-manifest.json",
  "signoff-drafts/latest-manifest.json"
]);

function modeOctal(path) {
  return statSync(path).mode & 0o777;
}

function modeLabel(mode) {
  return `0${mode.toString(8)}`;
}

function resolveUnderRoot(rootDir, path, failures, label) {
  if (!path || typeof path !== "string") {
    failures.push(`${label} is missing a relative path.`);
    return "";
  }
  if (isAbsolute(path)) {
    failures.push(`${label} must be relative, got absolute path.`);
    return "";
  }
  const resolved = resolve(rootDir, path);
  const relativePath = relative(rootDir, resolved);
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    failures.push(`${label} escapes project root.`);
    return "";
  }
  return resolved;
}

function safeReadJson(path, failures, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    failures.push(`${label} is not readable JSON: ${error.message}`);
    return null;
  }
}

function checkMode({ path, expectedMode, label, missingRequired = true }, state) {
  if (!path) return;
  if (!existsSync(path)) {
    const message = `${label} is missing.`;
    if (missingRequired) state.failures.push(message);
    else state.warnings.push(message);
    return;
  }
  const actual = modeOctal(path);
  const ok = actual === expectedMode;
  state.checked.push({
    label,
    path: relative(state.rootDir, path) || ".",
    expectedMode: modeLabel(expectedMode),
    actualMode: modeLabel(actual),
    ok
  });
  if (!ok) {
    state.failures.push(`${label} mode ${modeLabel(actual)} must be ${modeLabel(expectedMode)}.`);
  }
}

function checkManifestPackage(manifestPath, state, {
  label,
  optional = false
}) {
  if (!existsSync(manifestPath)) {
    const message = `${label} latest manifest is missing.`;
    if (optional) state.warnings.push(message);
    else state.failures.push(message);
    return;
  }
  checkMode({ path: manifestPath, expectedMode: 0o600, label: `${label} latest manifest` }, state);
  const manifest = safeReadJson(manifestPath, state.failures, `${label} latest manifest`);
  if (!manifest) return;
  const outputDir = resolveUnderRoot(state.rootDir, manifest.outputDir, state.failures, `${label} outputDir`);
  checkMode({ path: outputDir, expectedMode: 0o700, label: `${label} package directory` }, state);
  Object.entries(manifest.files || {}).forEach(([key, relativePath]) => {
    const filePath = resolveUnderRoot(state.rootDir, relativePath, state.failures, `${label} file ${key}`);
    checkMode({ path: filePath, expectedMode: 0o600, label: `${label} file ${key}` }, state);
  });
}

function checkOwnerHandoff(evidenceDir, state) {
  const manifestPath = join(evidenceDir, "latest-owner-handoff-manifest.json");
  if (!existsSync(manifestPath)) {
    state.failures.push("owner handoff manifest is missing.");
    return;
  }
  checkMode({ path: manifestPath, expectedMode: 0o600, label: "owner handoff latest manifest" }, state);
  const manifest = safeReadJson(manifestPath, state.failures, "owner handoff latest manifest");
  if (!manifest) return;
  const directoryName = String(manifest.directoryName || "");
  if (!/^[A-Za-z0-9_.-]+$/.test(directoryName)) {
    state.failures.push("owner handoff directoryName must be a safe directory segment.");
    return;
  }
  const handoffDir = join(evidenceDir, directoryName);
  checkMode({ path: handoffDir, expectedMode: 0o700, label: "owner handoff directory" }, state);
  checkMode({ path: join(handoffDir, "index.md"), expectedMode: 0o600, label: "owner handoff index" }, state);
  checkMode({ path: join(handoffDir, "manifest.json"), expectedMode: 0o600, label: "owner handoff run manifest" }, state);
  (manifest.owners || []).forEach((owner, index) => {
    const file = String(owner?.file || "");
    if (!/^[A-Za-z0-9_.-]+\.md$/.test(file)) {
      state.failures.push(`owner handoff owner file ${index + 1} must be a safe markdown filename.`);
      return;
    }
    checkMode({ path: join(handoffDir, file), expectedMode: 0o600, label: `owner handoff file ${file}` }, state);
  });
}

export function auditEvidencePermissions(options = {}) {
  const rootDir = resolve(options.rootDir || process.cwd());
  const evidenceDir = isAbsolute(options.evidenceDir || "")
    ? resolve(options.evidenceDir)
    : resolve(rootDir, options.evidenceDir || defaultEvidenceDir);
  const state = {
    rootDir,
    evidenceDir,
    checked: [],
    failures: [],
    warnings: []
  };

  checkMode({ path: evidenceDir, expectedMode: 0o700, label: "commercial evidence directory" }, state);
  requiredEvidenceFiles.forEach((file) => {
    checkMode({ path: join(evidenceDir, file), expectedMode: 0o600, label: `commercial evidence ${file}` }, state);
  });
  optionalEvidenceFiles.forEach((file) => {
    const path = join(evidenceDir, file);
    if (existsSync(path)) {
      checkMode({ path, expectedMode: 0o600, label: `commercial evidence ${file}` }, state);
    } else {
      state.warnings.push(`optional commercial evidence ${file} is missing.`);
    }
  });

  checkOwnerHandoff(evidenceDir, state);
  checkManifestPackage(join(evidenceDir, "hr-data-review/latest-manifest.json"), state, { label: "HR data review" });
  checkManifestPackage(join(evidenceDir, "production-env-prep/latest-manifest.json"), state, { label: "production env prep", optional: true });
  checkManifestPackage(join(evidenceDir, "signoff-drafts/latest-manifest.json"), state, { label: "signoff drafts", optional: true });

  return {
    ok: state.failures.length === 0,
    evidenceDir: relative(rootDir, evidenceDir) || ".",
    summary: {
      checkedCount: state.checked.length,
      failureCount: state.failures.length,
      warningCount: state.warnings.length
    },
    checked: state.checked,
    failures: state.failures,
    warnings: state.warnings
  };
}

export function parseEvidencePermissionArgs(argv = []) {
  const options = {
    evidenceDir: defaultEvidenceDir,
    json: argv.includes("--json")
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--evidence-dir") {
      options.evidenceDir = argv[index + 1] || options.evidenceDir;
      index += 1;
    } else if (arg === "--json") {
      options.json = true;
    }
  }
  return options;
}

async function main(argv = process.argv.slice(2)) {
  const options = parseEvidencePermissionArgs(argv);
  const result = auditEvidencePermissions(options);
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (result.ok) {
    console.log(`Commercial evidence permission audit passed: ${result.summary.checkedCount} paths checked.`);
  } else {
    console.error("Commercial evidence permission audit failed:");
    result.failures.forEach((failure) => console.error(`- ${failure}`));
  }
  if (!result.ok) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] || basename(import.meta.url)).href) {
  main();
}
