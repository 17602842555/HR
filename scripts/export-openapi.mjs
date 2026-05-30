import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { openApiDocument } from "../server/src/openapi.mjs";

const root = resolve(new URL("..", import.meta.url).pathname);
const target = resolve(root, "docs/openapi.json");
const serialized = `${JSON.stringify(openApiDocument, null, 2)}\n`;

if (process.argv.includes("--write")) {
  await writeFile(target, serialized, "utf8");
} else if (process.argv.includes("--check")) {
  const existing = await readFile(target, "utf8");
  if (existing !== serialized) {
    console.error("docs/openapi.json is not in sync. Run: node scripts/export-openapi.mjs --write");
    process.exitCode = 1;
  }
} else {
  process.stdout.write(serialized);
}
