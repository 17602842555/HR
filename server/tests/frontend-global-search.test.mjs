import assert from "node:assert/strict";
import test from "node:test";
import { flowTemplates } from "../../src/data/seed.js";
import { buildGlobalSearchResults } from "../../src/services/globalSearch.js";

const searchState = {
  people: {
    employees: [
      {
        employeeNo: "E-001",
        name: "张三",
        department: "行政部",
        role: "行政主管",
        phone: "13900001111",
        address: "敏感住址"
      }
    ],
    leavers: []
  },
  approvals: [
    {
      id: "APP-1",
      title: "差旅费用报销",
      applicant: "张三",
      department: "行政部",
      node: "财务复核",
      status: "审批中"
    }
  ],
  assets: [
    {
      id: "AST-1",
      name: "直播间补光灯",
      category: "直播设备",
      owner: "设备库",
      status: "空闲",
      location: "三楼设备库"
    }
  ],
  resources: [
    {
      id: "RES-1",
      name: "一号会议室",
      type: "会议室",
      total: 1
    }
  ],
  resourceBookings: [
    {
      id: "BOOK-1",
      resourceName: "一号会议室",
      period: "09:00-10:00",
      purpose: "周例会",
      status: "已预约"
    }
  ],
  auditLogs: [
    {
      id: "AUD-1",
      type: "导出记录",
      content: "导出员工名册",
      time: "10:00"
    }
  ]
};

test("frontend global search finds modules apps workflows and business records", () => {
  const transferResults = buildGlobalSearchResults({
    query: "调岗",
    state: searchState,
    workflowTemplates: flowTemplates
  });
  const transfer = transferResults.find((item) => item.title === "调岗申请");

  assert.equal(transfer?.action, "flow");
  assert.equal(transfer?.templateId, "transfer");

  const resourceResults = buildGlobalSearchResults({
    query: "一号会议室",
    state: searchState,
    workflowTemplates: flowTemplates
  });
  assert(resourceResults.some((item) => item.type === "资源" && item.module === "resources"));
  assert(resourceResults.some((item) => item.type === "预约" && item.module === "resources"));

  const auditResults = buildGlobalSearchResults({
    query: "权限审计",
    state: searchState,
    workflowTemplates: flowTemplates
  });
  assert.equal(auditResults[0].title, "权限审计");
  assert.equal(auditResults[0].module, "audit");
});

test("frontend global search uses safe personnel fields and does not expose sensitive lookups", () => {
  const nameResults = buildGlobalSearchResults({
    query: "张三",
    state: searchState,
    workflowTemplates: flowTemplates
  });
  assert(nameResults.some((item) => item.type === "人员" && item.title === "张三"));

  const phoneResults = buildGlobalSearchResults({
    query: "13900001111",
    state: searchState,
    workflowTemplates: flowTemplates
  });
  assert.equal(phoneResults.some((item) => item.type === "人员"), false);

  const serialized = JSON.stringify(nameResults);
  assert(!serialized.includes("13900001111"));
  assert(!serialized.includes("敏感住址"));
});
