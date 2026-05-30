import { spawnSync } from "node:child_process";
import path from "node:path";

function normalizeEntryName(name) {
  let value = String(name || "").trim();
  while (value.startsWith("./")) value = value.slice(2);
  return value || ".";
}

export function isSafeTarEntryPath(name) {
  const raw = String(name || "");
  if (!raw.trim()) return false;
  if (raw.includes("\0")) return false;
  if (raw.startsWith("/") || raw.startsWith("\\") || raw.startsWith("//")) return false;
  if (/^[A-Za-z]:[\\/]/.test(raw)) return false;

  const normalizedName = normalizeEntryName(raw);
  if (normalizedName === "." || normalizedName === "./") return true;

  const normalized = path.posix.normalize(normalizedName.replaceAll("\\", "/"));
  if (normalized === "." || normalized === "./") return true;
  if (normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) return false;
  if (normalized.startsWith("/") || normalized.startsWith("//")) return false;
  return true;
}

export function validateTarEntries(entries) {
  const errors = [];
  const normalizedEntries = [];

  for (const entry of entries) {
    const name = String(entry || "").trim();
    if (!name) continue;
    normalizedEntries.push(name);
    if (!isSafeTarEntryPath(name)) {
      errors.push(`Unsafe tar entry path: ${name}`);
    }
  }

  if (normalizedEntries.length === 0) {
    errors.push("File backup archive has no entries.");
  }

  return {
    ok: errors.length === 0,
    errors,
    entryCount: normalizedEntries.length
  };
}

export function listTarArchive(archivePath) {
  const result = spawnSync("tar", ["-tzf", archivePath], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`Unable to list file backup archive: ${String(result.stderr || result.stdout || "").trim()}`);
  }
  return String(result.stdout || "").split("\n");
}

export function validateTarArchive(archivePath) {
  return validateTarEntries(listTarArchive(archivePath));
}

async function main(argv = process.argv.slice(2)) {
  const json = argv.includes("--json");
  const archivePath = argv.find((arg) => !arg.startsWith("--"));
  if (!archivePath || archivePath === "-h" || archivePath === "--help") {
    const payload = {
      ok: false,
      errors: ["Usage: node scripts/validate-file-backup.mjs <file-storage-backup.tar.gz> [--json]"]
    };
    if (json) console.log(JSON.stringify(payload, null, 2));
    else console.error(payload.errors[0]);
    process.exitCode = 64;
    return;
  }

  try {
    const result = validateTarArchive(archivePath);
    const payload = { archivePath, ...result };
    if (json) {
      console.log(JSON.stringify(payload, null, 2));
    } else if (result.ok) {
      console.log(`File backup archive validation passed: ${archivePath} (${result.entryCount} entries)`);
    } else {
      console.error(`File backup archive validation failed: ${archivePath}`);
      result.errors.forEach((error) => console.error(`- ${error}`));
    }
    process.exitCode = result.ok ? 0 : 66;
  } catch (error) {
    if (json) {
      console.log(JSON.stringify({ archivePath, ok: false, errors: [error.message], entryCount: 0 }, null, 2));
    } else {
      console.error(error.message);
    }
    process.exitCode = 66;
  }
}

if (import.meta.url === new URL(process.argv[1], "file:").href) {
  main();
}
