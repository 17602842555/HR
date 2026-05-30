import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const defaultOutputPath = "reports/commercial-evidence/sbom/latest-spdx.json";
const defaultNamespaceBase = "https://oa.local/spdx/group-oa";

function resolvePath(path, rootDir = process.cwd()) {
  return isAbsolute(path) ? path : resolve(rootDir, path);
}

function readJson(path, rootDir = process.cwd()) {
  return JSON.parse(readFileSync(resolvePath(path, rootDir), "utf8"));
}

function writePrivateJson(path, payload) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(dirname(path), 0o700);
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function sha256Text(text) {
  return createHash("sha256").update(text).digest("hex");
}

function spdxId(value) {
  return `SPDXRef-${String(value || "package")
    .replace(/^@/, "")
    .replace(/[^A-Za-z0-9.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "package"}`;
}

function lockPackageName(path, entry) {
  if (entry?.name) return entry.name;
  return String(path || "").replace(/^node_modules\//, "");
}

function purlName(name) {
  const value = String(name || "");
  if (value.startsWith("@")) {
    const [scope, packageName] = value.split("/");
    return `${encodeURIComponent(scope)}/${encodeURIComponent(packageName || "")}`;
  }
  return encodeURIComponent(value);
}

function integrityChecksum(integrity) {
  const first = String(integrity || "").split(/\s+/).find(Boolean);
  const match = first?.match(/^(sha\d+)-(.+)$/i);
  if (!match) return null;
  try {
    return {
      algorithm: match[1].toUpperCase(),
      checksumValue: Buffer.from(match[2], "base64").toString("hex")
    };
  } catch {
    return null;
  }
}

function packageExternalRefs(name, version) {
  if (!name || !version) return [];
  return [{
    referenceCategory: "PACKAGE-MANAGER",
    referenceType: "purl",
    referenceLocator: `pkg:npm/${purlName(name)}@${encodeURIComponent(version)}`
  }];
}

function rootPackage(packageJson, documentName) {
  const name = packageJson?.name || documentName || "group-oa";
  const version = packageJson?.version || "0.0.0";
  return {
    name,
    versionInfo: version,
    SPDXID: spdxId(`root-${name}`),
    downloadLocation: "NOASSERTION",
    filesAnalyzed: false,
    licenseConcluded: packageJson?.license || "NOASSERTION",
    licenseDeclared: packageJson?.license || "NOASSERTION",
    copyrightText: "NOASSERTION",
    externalRefs: packageExternalRefs(name, version)
  };
}

function lockPackages(lock = {}) {
  return Object.entries(lock.packages || {})
    .filter(([path, entry]) => path && !entry?.link)
    .map(([path, entry]) => {
      const name = lockPackageName(path, entry);
      const version = entry?.version || "0.0.0";
      const checksum = integrityChecksum(entry?.integrity);
      return {
        name,
        versionInfo: version,
        SPDXID: spdxId(`${name}-${version}-${sha256Text(path).slice(0, 8)}`),
        downloadLocation: entry?.resolved || "NOASSERTION",
        filesAnalyzed: false,
        licenseConcluded: entry?.license || "NOASSERTION",
        licenseDeclared: entry?.license || "NOASSERTION",
        copyrightText: "NOASSERTION",
        ...(checksum ? { checksums: [checksum] } : {}),
        externalRefs: packageExternalRefs(name, version)
      };
    })
    .sort((a, b) => `${a.name}@${a.versionInfo}`.localeCompare(`${b.name}@${b.versionInfo}`));
}

function packageNameIndex(packages) {
  const map = new Map();
  packages.forEach((pkg) => {
    if (!map.has(pkg.name)) map.set(pkg.name, pkg.SPDXID);
  });
  return map;
}

function dependencyRelationships(root, packageJson, lock, packageIndex) {
  const relationships = [{
    spdxElementId: "SPDXRef-DOCUMENT",
    relationshipType: "DESCRIBES",
    relatedSpdxElement: root.SPDXID
  }];

  packageIndex.forEach((spdxIdValue) => {
    relationships.push({
      spdxElementId: "SPDXRef-DOCUMENT",
      relationshipType: "DESCRIBES",
      relatedSpdxElement: spdxIdValue
    });
  });

  const declared = {
    ...packageJson?.dependencies,
    ...packageJson?.devDependencies
  };
  Object.keys(declared).sort().forEach((name) => {
    const target = packageIndex.get(name);
    if (target) relationships.push({ spdxElementId: root.SPDXID, relationshipType: "DEPENDS_ON", relatedSpdxElement: target });
  });

  Object.entries(lock?.packages || {}).forEach(([path, entry]) => {
    if (!path || entry?.link || !entry?.dependencies) return;
    const source = packageIndex.get(lockPackageName(path, entry));
    if (!source) return;
    Object.keys(entry.dependencies).sort().forEach((name) => {
      const target = packageIndex.get(name);
      if (target && target !== source) relationships.push({ spdxElementId: source, relationshipType: "DEPENDS_ON", relatedSpdxElement: target });
    });
  });

  return relationships;
}

export function generateSpdxSbomData({
  lock,
  packageJson,
  createdAt = new Date().toISOString(),
  namespaceBase = defaultNamespaceBase
} = {}) {
  const root = rootPackage(packageJson, "group-oa");
  const packages = lockPackages(lock);
  const index = packageNameIndex(packages);
  const allPackages = [root, ...packages];
  const lockHash = sha256Text(JSON.stringify(lock || {}));

  return {
    spdxVersion: "SPDX-2.3",
    dataLicense: "CC0-1.0",
    SPDXID: "SPDXRef-DOCUMENT",
    name: `${root.name}-sbom`,
    documentNamespace: `${namespaceBase}/${lockHash.slice(0, 24)}`,
    creationInfo: {
      created: createdAt,
      creators: ["Tool: group-oa-sbom-generator"]
    },
    packages: allPackages,
    relationships: dependencyRelationships(root, packageJson, lock, index)
  };
}

export function summarizeSbom(sbom, outputPath = "") {
  const serialized = `${JSON.stringify(sbom, null, 2)}\n`;
  const stableSbom = {
    ...sbom,
    creationInfo: {
      ...sbom.creationInfo,
      created: "[GENERATED_AT]"
    }
  };
  const stableSerialized = `${JSON.stringify(stableSbom, null, 2)}\n`;
  const stableSha256 = sha256Text(stableSerialized);
  return {
    spdxVersion: sbom.spdxVersion,
    packageCount: Array.isArray(sbom.packages) ? sbom.packages.length : 0,
    relationshipCount: Array.isArray(sbom.relationships) ? sbom.relationships.length : 0,
    sha256: stableSha256,
    stableSha256,
    documentSha256: sha256Text(serialized),
    output: outputPath
  };
}

export function parseSbomArgs(argv = process.argv.slice(2)) {
  const args = {
    check: false,
    json: false,
    lockPath: "package-lock.json",
    outputPath: defaultOutputPath,
    packagePath: "package.json",
    stdout: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--check") args.check = true;
    else if (arg === "--json") args.json = true;
    else if (arg === "--stdout") args.stdout = true;
    else if (arg === "--lock") args.lockPath = argv[++index] || args.lockPath;
    else if (arg === "--package") args.packagePath = argv[++index] || args.packagePath;
    else if (arg === "--output") args.outputPath = argv[++index] || args.outputPath;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function printHelp() {
  console.log("Usage: node scripts/generate-sbom.mjs [--json] [--check] [--stdout] [--lock package-lock.json] [--package package.json] [--output reports/commercial-evidence/sbom/latest-spdx.json]");
}

async function main(argv = process.argv.slice(2)) {
  const args = parseSbomArgs(argv);
  if (args.help) {
    printHelp();
    return;
  }

  const rootDir = process.cwd();
  const sbom = generateSpdxSbomData({
    lock: readJson(args.lockPath, rootDir),
    packageJson: readJson(args.packagePath, rootDir)
  });
  const resolvedOutput = resolvePath(args.outputPath, rootDir);
  const outputLabel = relative(rootDir, resolvedOutput) || args.outputPath;

  if (!args.check && !args.stdout) writePrivateJson(resolvedOutput, sbom);
  const summary = summarizeSbom(sbom, args.check || args.stdout ? "" : outputLabel);
  const payload = { ok: true, summary };

  if (args.json) console.log(JSON.stringify(payload, null, 2));
  else if (args.stdout) console.log(JSON.stringify(sbom, null, 2));
  else if (args.check) console.log(`SBOM generation check passed for ${summary.packageCount} SPDX packages.`);
  else console.log(`SBOM written to ${outputLabel} with ${summary.packageCount} SPDX packages.`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
