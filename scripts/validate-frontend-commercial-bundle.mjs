import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";

const rootDir = resolve(new URL("..", import.meta.url).pathname);
const distDir = resolve(rootDir, "dist");
const textExtensions = new Set([".css", ".html", ".js", ".json", ".mjs", ".txt"]);

const forbiddenNeedles = [
  ["在职员工详细信息", "local personnel HTML parser heading"],
  ["离职人员详细信息", "local personnel HTML parser heading"],
  ["女性员工详细信息", "local personnel HTML parser heading"],
  ["当月离职管理", "local personnel HTML parser heading"],
  ["oa-dashboard.html", "local source file name"],
  ["__LOCAL_DASHBOARD_HTML__", "local source HTML define"],
  ["admin123456", "default development password"],
  ["admin@oa.local", "default development login"],
  ["mock-user", "local mock user id"],
  ["local-demo", "local demo runtime marker"],
  ["戴慧敏", "real personnel seed name"],
  ["张三", "demo personnel seed name"],
  ["6222 ****", "demo bank account value"],
  ["sourceContentBase64", "import source content field"],
  ["nativeSeedData", "Cloudflare native seed marker"]
];

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) return walk(path);
    return [path];
  });
}

if (!existsSync(distDir)) {
  console.error("dist directory is missing. Run `npm run build` before validate:frontend-bundle.");
  process.exit(1);
}

const findings = [];
for (const file of walk(distDir)) {
  if (!textExtensions.has(extname(file))) continue;
  const text = readFileSync(file, "utf8");
  forbiddenNeedles.forEach(([needle, reason]) => {
    if (text.includes(needle)) {
      findings.push({ file: relative(rootDir, file), needle, reason });
    }
  });
}

if (findings.length) {
  console.error("Commercial frontend bundle contains forbidden local/demo/sensitive markers:");
  findings.forEach((finding) => {
    console.error(`- ${finding.file}: ${finding.needle} (${finding.reason})`);
  });
  process.exit(1);
}

console.log(`Commercial frontend bundle check passed (${distDir}).`);
