import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parse as parseDotenv } from "dotenv";
import { redactEvidenceText } from "./commercial-evidence.mjs";
import { parseProductionEnvText, validateProductionEnv } from "./validate-production-env.mjs";

const defaultInputSpecs = Object.freeze([
  Object.freeze({
    envName: "PRODUCTION_ENV_B64",
    kind: "dotenv",
    outputPath: ".env.production",
    requiredModes: Object.freeze(["tunnel"]),
    validateProduction: true
  }),
  Object.freeze({
    envName: "PRODUCTION_SECRETS_SIGNOFF_B64",
    forbidExample: true,
    kind: "json",
    outputPath: "docs/production-secrets-signoff.json",
    required: true
  }),
  Object.freeze({
    envName: "HR_DATA_SIGNOFF_B64",
    forbidExample: true,
    kind: "json",
    outputPath: "docs/hr-data-signoff.json",
    required: true
  }),
  Object.freeze({
    envName: "FILE_STORAGE_SIGNOFF_B64",
    forbidExample: true,
    kind: "json",
    outputPath: "docs/file-storage-signoff.json",
    required: true
  })
]);
const defaultFsOps = Object.freeze({
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
});

function resolveInsideRoot(rootDir, targetPath) {
  const resolvedRoot = resolve(rootDir);
  const resolvedTarget = isAbsolute(targetPath) ? resolve(targetPath) : resolve(resolvedRoot, targetPath);
  const rel = relative(resolvedRoot, resolvedTarget);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`Release input target path escapes project root: ${targetPath}`);
  }
  return resolvedTarget;
}

function sha256Text(text) {
  return createHash("sha256").update(String(text || "")).digest("hex");
}

function normalizeReleaseBackendMode(value = "native-worker") {
  const mode = String(value || "native-worker").trim().toLowerCase();
  if (["native", "native-worker", "worker", "cloudflare-native"].includes(mode)) return "native-worker";
  if (["tunnel", "cloudflare-tunnel", "proxy", "fastify-postgres", "postgres"].includes(mode)) return "tunnel";
  throw new Error("Release input backend mode must be native-worker or tunnel.");
}

function releaseBackendModeFromEnv(env = process.env, fallback = "") {
  return normalizeReleaseBackendMode(fallback || env.RELEASE_BACKEND_MODE || env.CLOUDFLARE_BACKEND_MODE || env.OA_API_MODE || "native-worker");
}

function specRequiredForMode(spec, backendMode) {
  if (Array.isArray(spec.requiredModes)) return spec.requiredModes.includes(backendMode);
  return spec.required !== false;
}

function decodeBase64Env(env, envName) {
  const raw = String(env[envName] || "").trim();
  if (!raw) throw new Error(`${envName} is required and must contain base64-encoded release input content.`);

  const compact = raw.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(compact) || compact.length % 4 === 1) {
    throw new Error(`${envName} is not valid base64: invalid characters or padding.`);
  }
  const padded = compact.padEnd(Math.ceil(compact.length / 4) * 4, "=");
  let text = "";
  try {
    text = Buffer.from(padded, "base64").toString("utf8");
  } catch (error) {
    throw new Error(`${envName} is not valid base64: ${error.message}`);
  }
  const canonicalInput = compact.replace(/=+$/, "");
  const canonicalDecoded = Buffer.from(text, "utf8").toString("base64").replace(/=+$/, "");
  if (canonicalInput !== canonicalDecoded) {
    throw new Error(`${envName} is not valid base64: decoded content does not round-trip cleanly as UTF-8.`);
  }

  if (!text.trim()) throw new Error(`${envName} decoded to an empty file.`);
  if (text.includes("\u0000")) throw new Error(`${envName} decoded content contains NUL bytes.`);
  return text.endsWith("\n") ? text : `${text}\n`;
}

function validateDecodedContent({ envName, forbidExample = false, kind, text, validateProduction = false }) {
  if (kind === "json") {
    try {
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("top-level JSON must be an object");
      }
      if (forbidExample && parsed.example === true) {
        throw new Error("example release inputs cannot be materialized");
      }
    } catch (error) {
      throw new Error(`${envName} decoded content is not a valid JSON object: ${error.message}`);
    }
  } else if (kind === "dotenv") {
    try {
      const parsed = parseDotenv(text);
      if (!parsed || typeof parsed !== "object" || Object.keys(parsed).length === 0) {
        throw new Error("dotenv file has no keys");
      }
    } catch (error) {
      throw new Error(`${envName} decoded content is not a valid dotenv file: ${error.message}`);
    }
    if (validateProduction) {
      const report = validateProductionEnv(parseProductionEnvText(text));
      if (!report.ok) {
        throw new Error(`${envName} production env validation failed: ${report.errors.join("; ")}`);
      }
    }
  } else {
    throw new Error(`Unsupported release input kind: ${kind}`);
  }
}

function ensurePrivateDir(path, fsOps = defaultFsOps) {
  fsOps.mkdirSync(path, { recursive: true, mode: 0o700 });
  fsOps.chmodSync(path, 0o700);
}

function writePrivateTextFile(path, text, fsOps = defaultFsOps) {
  fsOps.writeFileSync(path, text, { mode: 0o600 });
  fsOps.chmodSync(path, 0o600);
}

function releaseInputTempPath(outputPath) {
  return resolve(dirname(outputPath), `.${basename(outputPath)}.${process.pid}.${randomUUID()}.tmp`);
}

function safeUnlink(path, fsOps = defaultFsOps) {
  if (!path) return;
  try {
    fsOps.unlinkSync(path);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function snapshotExistingFile(outputPath, fsOps = defaultFsOps) {
  if (!fsOps.existsSync(outputPath)) {
    return { content: null, existed: false, outputPath };
  }
  const stat = fsOps.statSync(outputPath);
  if (!stat.isFile()) {
    throw new Error(`Release input target path already exists and is not a file: ${outputPath}`);
  }
  return {
    content: fsOps.readFileSync(outputPath),
    existed: true,
    outputPath
  };
}

function rollbackMaterializedFiles({ errors, fsOps = defaultFsOps, snapshots, stagedFiles }) {
  for (const staged of stagedFiles) {
    if (!staged.moved) {
      try {
        safeUnlink(staged.tempPath, fsOps);
      } catch (error) {
        errors.push(`Failed to remove release input temp file during rollback: ${error.message}`);
      }
    }
  }

  for (const snapshot of [...snapshots].reverse()) {
    try {
      if (snapshot.existed) {
        writePrivateTextFile(snapshot.outputPath, snapshot.content, fsOps);
      } else {
        safeUnlink(snapshot.outputPath, fsOps);
      }
    } catch (error) {
      errors.push(`Failed to roll back release input target: ${error.message}`);
    }
  }
}

export function materializeReleaseInputs({
  backendMode = "",
  env = process.env,
  fsOps = defaultFsOps,
  inputSpecs = defaultInputSpecs,
  rootDir = process.cwd()
} = {}) {
  const resolvedBackendMode = releaseBackendModeFromEnv(env, backendMode);
  const decodedInputs = [];
  const stagedFiles = [];
  const written = [];
  const errors = [];

  for (const spec of inputSpecs) {
    const required = specRequiredForMode(spec, resolvedBackendMode);
    const hasValue = Boolean(String(env[spec.envName] || "").trim());
    if (!hasValue && !required) continue;
    try {
      const text = decodeBase64Env(env, spec.envName);
      validateDecodedContent({
        envName: spec.envName,
        forbidExample: spec.forbidExample,
        kind: spec.kind,
        text,
        validateProduction: spec.validateProduction
      });
      const outputPath = resolveInsideRoot(rootDir, spec.outputPath);
      decodedInputs.push({ spec, text, outputPath });
    } catch (error) {
      if (required || hasValue) {
        errors.push(error.message);
      }
    }
  }

  if (errors.length > 0) {
    return {
      backendMode: resolvedBackendMode,
      ok: false,
      errors,
      written: []
    };
  }

  for (const item of decodedInputs) {
    try {
      ensurePrivateDir(dirname(item.outputPath), fsOps);
      const tempPath = releaseInputTempPath(item.outputPath);
      writePrivateTextFile(tempPath, item.text, fsOps);
      stagedFiles.push({ ...item, moved: false, tempPath });
    } catch (error) {
      errors.push(error.message);
    }
  }
  if (errors.length > 0) {
    rollbackMaterializedFiles({ errors, fsOps, snapshots: [], stagedFiles });
    return {
      backendMode: resolvedBackendMode,
      ok: false,
      errors,
      written: []
    };
  }

  const snapshots = [];
  try {
    for (const staged of stagedFiles) {
      snapshots.push(snapshotExistingFile(staged.outputPath, fsOps));
    }

    for (const staged of stagedFiles) {
      fsOps.renameSync(staged.tempPath, staged.outputPath);
      staged.moved = true;
      fsOps.chmodSync(staged.outputPath, 0o600);
      written.push({
        envName: staged.spec.envName,
        kind: staged.spec.kind,
        path: relative(resolve(rootDir), staged.outputPath),
        bytes: Buffer.byteLength(staged.text),
        sha256: sha256Text(staged.text)
      });
    }
  } catch (error) {
    errors.push(`Release input materialization failed during commit: ${error.message}`);
    rollbackMaterializedFiles({ errors, fsOps, snapshots, stagedFiles });
    return {
      backendMode: resolvedBackendMode,
      ok: false,
      errors,
      written: []
    };
  }

  return {
    backendMode: resolvedBackendMode,
    ok: errors.length === 0,
    errors,
    written
  };
}

export function parseMaterializeReleaseInputsArgs(argv = []) {
  const options = {
    backendMode: "",
    json: argv.includes("--json"),
    outputPath: ""
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--output") {
      options.outputPath = argv[index + 1] || "";
      index += 1;
    } else if (arg === "--mode") {
      options.backendMode = normalizeReleaseBackendMode(argv[index + 1] || "");
      index += 1;
    }
  }
  return options;
}

export function writeMaterializeReleaseInputsResult(result, {
  outputPath = "",
  rootDir = process.cwd()
} = {}) {
  if (!outputPath) return "";
  const resolvedPath = resolveInsideRoot(rootDir, outputPath);
  ensurePrivateDir(dirname(resolvedPath));
  writePrivateTextFile(resolvedPath, `${JSON.stringify(result, null, 2)}\n`);
  return relative(resolve(rootDir), resolvedPath);
}

async function main(argv = process.argv.slice(2)) {
  const options = parseMaterializeReleaseInputsArgs(argv);
  const result = materializeReleaseInputs({ backendMode: options.backendMode });
  const redacted = {
    ...result,
    errors: result.errors.map((error) => redactEvidenceText(error))
  };
  const writtenOutputPath = writeMaterializeReleaseInputsResult(redacted, {
    outputPath: options.outputPath
  });
  const output = writtenOutputPath ? { ...redacted, outputPath: writtenOutputPath } : redacted;

  if (options.json) {
    console.log(JSON.stringify(output, null, 2));
  } else if (result.ok) {
    console.log("Release input files materialized with private permissions.");
    result.written.forEach((item) => {
      console.log(`- ${item.path} (${item.kind}, ${item.bytes} bytes, sha256=${item.sha256})`);
    });
    if (writtenOutputPath) console.log(`Validation manifest: ${writtenOutputPath}`);
  } else {
    console.error("Release input materialization failed.");
    result.errors.forEach((error) => console.error(`- ${redactEvidenceText(error)}`));
    if (writtenOutputPath) console.error(`Validation manifest: ${writtenOutputPath}`);
  }

  process.exitCode = result.ok ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main();
}
