import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

const defaultIncludePaths = [
  ".env.example",
  ".env.production.example",
  "Dockerfile.api",
  "Dockerfile.web",
  "docker",
  "index.html",
  "package.json",
  "prisma",
  "public",
  "server/src",
  "src"
];

const textExtensions = new Set([
  ".cjs",
  ".css",
  ".html",
  ".js",
  ".json",
  ".jsx",
  ".mjs",
  ".prisma",
  ".sql",
  ".svg",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".yaml",
  ".yml"
]);

const alwaysTextFiles = new Set([
  ".env.example",
  ".env.production.example",
  "Dockerfile.api",
  "Dockerfile.web",
  "package.json"
]);

const forbiddenBrandPatterns = [
  { label: "Feishu Chinese brand", pattern: /飞书/iu },
  { label: "Feishu Latin brand", pattern: /feishu/iu },
  { label: "LarkSuite brand", pattern: /larksuite/iu },
  { label: "Lark OA brand", pattern: /\black\b/iu },
  { label: "ByteDance Chinese brand", pattern: /字节跳动/iu },
  { label: "ByteDance Latin brand", pattern: /bytedance/iu }
];

function isTextFile(path, relativePath) {
  return alwaysTextFiles.has(relativePath) || textExtensions.has(extname(path).toLowerCase());
}

function shouldSkipDirectory(name) {
  return [
    ".git",
    ".vite",
    "coverage",
    "dist",
    "node_modules",
    "playwright-report",
    "test-results"
  ].includes(name);
}

function lineAndColumn(text, index) {
  const before = text.slice(0, index);
  const lines = before.split(/\r?\n/);
  return {
    column: lines[lines.length - 1].length + 1,
    line: lines.length
  };
}

function collectFiles(rootDir, includePaths = defaultIncludePaths) {
  const files = [];

  function walk(path) {
    const stats = statSync(path);
    const relativePath = relative(rootDir, path) || basename(path);
    if (stats.isDirectory()) {
      if (shouldSkipDirectory(basename(path))) return;
      for (const entry of readdirSync(path)) {
        walk(join(path, entry));
      }
      return;
    }
    if (!stats.isFile()) return;
    if (!isTextFile(path, relativePath)) {
      // Binary assets are checked by filename below; reading image bytes would create noisy false positives.
      files.push({ binary: true, path, relativePath });
      return;
    }
    files.push({ binary: false, path, relativePath });
  }

  for (const includePath of includePaths) {
    const absolutePath = resolve(rootDir, includePath);
    try {
      walk(absolutePath);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  return files;
}

function scanFileName(relativePath) {
  return forbiddenBrandPatterns.flatMap((rule) => {
    const match = rule.pattern.exec(relativePath);
    if (!match) return [];
    return [{
      column: match.index + 1,
      label: rule.label,
      line: 1,
      match: match[0],
      path: relativePath,
      target: "filename"
    }];
  });
}

function scanFileContent(file) {
  if (file.binary) return [];
  const text = readFileSync(file.path, "utf8");
  return forbiddenBrandPatterns.flatMap((rule) => {
    const match = rule.pattern.exec(text);
    if (!match) return [];
    return [{
      ...lineAndColumn(text, match.index),
      label: rule.label,
      match: match[0],
      path: file.relativePath,
      target: "content"
    }];
  });
}

export function findForbiddenBrandReferences(options = {}) {
  const rootDir = resolve(options.rootDir || repoRoot);
  const includePaths = options.includePaths || defaultIncludePaths;
  return collectFiles(rootDir, includePaths).flatMap((file) => ([
    ...scanFileName(file.relativePath),
    ...scanFileContent(file)
  ]));
}

function formatViolations(violations) {
  return violations.map((item) => (
    `${item.path}:${item.line}:${item.column} ${item.label} (${item.target}) -> ${item.match}`
  )).join("\n");
}

export function runBrandCheck(options = {}) {
  const violations = findForbiddenBrandReferences(options);
  return {
    checkedPaths: options.includePaths || defaultIncludePaths,
    ok: violations.length === 0,
    violations
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const json = process.argv.includes("--json");
  const result = runBrandCheck();
  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (result.ok) {
    console.log(`Brand check passed across deployable paths: ${result.checkedPaths.join(", ")}`);
  } else {
    console.error("Forbidden third-party brand references found in deployable paths:");
    console.error(formatViolations(result.violations));
  }
  process.exit(result.ok ? 0 : 1);
}
