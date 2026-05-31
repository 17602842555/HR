import { maskPerson } from "./personMask.js";

const dashboardHtml = typeof __LOCAL_DASHBOARD_HTML__ === "string" ? __LOCAL_DASHBOARD_HTML__ : "";

const personColumns = [
  "seq",
  "org",
  "name",
  "gender",
  "department",
  "role",
  "entryDate",
  "leaveDate",
  "regularDate",
  "age",
  "hukou",
  "education",
  "school",
  "major"
];

function cellText(cell) {
  return cell?.textContent?.replace(/\s+/g, " ").trim() || "";
}

function readSectionTable(doc, title) {
  const heading = [...doc.querySelectorAll("h2")].find((item) => item.textContent.includes(title));
  const table = heading?.closest("section")?.querySelector("table");
  if (!table) return [];
  return [...table.querySelectorAll("tbody tr")]
    .map((row) => [...row.children].map(cellText))
    .filter((row) => row.some(Boolean));
}

function normalizePerson(row, status) {
  const record = Object.fromEntries(personColumns.map((key, index) => [key, row[index] || ""]));
  return {
    ...record,
    id: `${status}-${record.seq || record.name}-${record.entryDate || record.leaveDate}`,
    status,
    org: record.org || "未分配组织",
    department: record.department || "未填写部门",
    role: record.role || "未填写岗位",
    displayAge: /^\d{1,2}(\.0)?$/.test(record.age) ? record.age.replace(".0", "") : "待核验"
  };
}

function countBy(rows, key) {
  return rows.reduce((acc, item) => {
    const value = item[key] || "未填写";
    acc[value] = (acc[value] || 0) + 1;
    return acc;
  }, {});
}

function topCounts(rows, key, limit = 6) {
  return Object.entries(countBy(rows, key))
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([label, value]) => ({ label, value }));
}

export function loadDashboardPeopleFromHtml(html) {
  if (typeof DOMParser === "undefined") {
    return {
      employees: [],
      inactiveEmployees: [],
      leavers: [],
      femaleEmployees: [],
      monthLeavers: [],
      orgStats: [],
      departmentStats: [],
      leaverDepartmentStats: []
    };
  }

  const doc = new DOMParser().parseFromString(html, "text/html");
  const employees = readSectionTable(doc, "在职员工详细信息").map((row) => normalizePerson(row, "在职"));
  const leavers = readSectionTable(doc, "离职人员详细信息").map((row) => normalizePerson(row, "离职"));
  const femaleEmployees = readSectionTable(doc, "女性员工详细信息").map((row) => normalizePerson(row, "在职"));
  const monthLeavers = readSectionTable(doc, "当月离职管理").map((row) => normalizePerson(row, "离职"));

  return {
    employees,
    inactiveEmployees: [],
    leavers,
    femaleEmployees,
    monthLeavers,
    orgStats: topCounts(employees, "org", 8),
    departmentStats: topCounts(employees, "department", 8),
    leaverDepartmentStats: topCounts(leavers, "department", 8)
  };
}

export function loadDashboardPeople() {
  return loadDashboardPeopleFromHtml(dashboardHtml);
}

export { maskPerson };
