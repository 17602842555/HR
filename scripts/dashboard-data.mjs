import { readFileSync } from "node:fs";

const personColumns = [
  "seq",
  "org",
  "name",
  "gender",
  "department",
  "role",
  "entryDate",
  "regularDate",
  "age",
  "hukou",
  "education",
  "school",
  "major"
];

const leaverColumns = [
  "name",
  "org",
  "department",
  "role",
  "entryDate",
  "leaveDate"
];

function decodeHtml(value) {
  return String(value || "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'");
}

function cellText(value) {
  return decodeHtml(value.replace(/<[^>]*>/g, ""))
    .replace(/\s+/g, " ")
    .trim();
}

function parseRows(tableHtml) {
  return [...tableHtml.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)]
    .map(([, rowHtml]) => [...rowHtml.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(([, cellHtml]) => cellText(cellHtml)))
    .filter((row) => row.length && row.some(Boolean))
    .filter((row) => !row.some((cell) => ["序号", "姓名", "流程名称"].includes(cell)));
}

function readSectionTable(html, title) {
  const headingIndex = html.search(new RegExp(`<h2[^>]*>\\s*${title}\\s*<\\/h2>`, "i"));
  if (headingIndex === -1) return [];
  const sectionStart = html.lastIndexOf("<section", headingIndex);
  const sectionEnd = html.indexOf("</section>", headingIndex);
  const sectionHtml = html.slice(Math.max(sectionStart, 0), sectionEnd === -1 ? html.length : sectionEnd);
  const tableMatch = sectionHtml.match(/<table[^>]*>([\s\S]*?)<\/table>/i);
  return tableMatch ? parseRows(tableMatch[0]) : [];
}

function normalizePerson(row, status) {
  const columns = row.length >= personColumns.length ? personColumns : leaverColumns;
  const record = Object.fromEntries(columns.map((key, index) => [key, row[index] || ""]));
  return {
    ...record,
    id: `${status}-${record.seq || record.name}-${record.entryDate || record.leaveDate}`,
    status,
    org: record.org || "未分配组织",
    department: record.department || "未填写部门",
    role: record.role || "未填写岗位",
    displayAge: /^\d{1,2}(\.0)?$/.test(record.age || "") ? record.age.replace(".0", "") : "待核验"
  };
}

function countBy(rows, key) {
  return rows.reduce((acc, item) => {
    const value = item[key] || "未填写";
    acc[value] = (acc[value] || 0) + 1;
    return acc;
  }, {});
}

function topCounts(rows, key, limit = 8) {
  return Object.entries(countBy(rows, key))
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([label, value]) => ({ label, value }));
}

export function loadDashboardPeopleFromHtml(html) {
  const employees = readSectionTable(html, "在职员工详细信息").map((row) => normalizePerson(row, "在职"));
  const leavers = readSectionTable(html, "离职人员详细信息").map((row) => normalizePerson(row, "离职"));
  const femaleEmployees = readSectionTable(html, "女性员工详细信息").map((row) => normalizePerson(row, "在职"));
  const monthLeavers = readSectionTable(html, "当月离职管理").map((row) => normalizePerson(row, "离职"));

  return {
    employees,
    leavers,
    femaleEmployees,
    monthLeavers,
    orgStats: topCounts(employees, "org"),
    departmentStats: topCounts(employees, "department"),
    leaverDepartmentStats: topCounts(leavers, "department")
  };
}

export function loadDashboardPeople(filePath = new URL("../oa-dashboard.html", import.meta.url)) {
  return loadDashboardPeopleFromHtml(readFileSync(filePath, "utf8"));
}
