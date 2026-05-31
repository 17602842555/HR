const { expect, test } = require("@playwright/test");

const storageKey = "oa-enterprise-system-v1";
const apiRequired = process.env.VITE_REQUIRE_API === "1";
const tenantCode = process.env.DEFAULT_TENANT_CODE || "default";
const adminEmail = process.env.DEFAULT_ADMIN_EMAIL || "admin@oa.local";
const adminPassword = process.env.DEFAULT_ADMIN_PASSWORD || "admin123456";

async function loginIfBackendRequired(page) {
  const loginTitle = page.getByText("商业版后台登录");
  const apiReady = page.locator(".api-status").filter({ hasText: "后端已连接" });

  const firstVisibleState = await Promise.race([
    apiReady.waitFor({ state: "visible", timeout: 10000 }).then(() => "ready"),
    loginTitle.waitFor({ state: "visible", timeout: 10000 }).then(() => "login")
  ]).catch(() => null);

  if (firstVisibleState === "ready") {
    await expect(page.getByRole("navigation", { name: "主导航" })).toBeVisible();
    return;
  }

  await expect(loginTitle).toBeVisible({ timeout: 10000 });

  await page.getByLabel("租户").fill(tenantCode);
  await page.getByLabel("邮箱").fill(adminEmail);
  await page.getByLabel("密码").fill(adminPassword);
  await page.getByRole("button", { name: /登录系统/ }).click();
  await expect(page.getByRole("navigation", { name: "主导航" })).toBeVisible();
  await expect(page.locator(".api-status")).toContainText("后端已连接");
}

test.beforeEach(async ({ page }, testInfo) => {
  if (!apiRequired && !testInfo.title.includes("backend 401")) {
    await page.route("**/api/auth/me", async (route) => route.abort("failed"));
  }
  await page.goto("/");
  await page.evaluate((key) => window.localStorage.removeItem(key), storageKey);
  await page.reload();
  if (apiRequired && !testInfo.title.includes("backend 401")) {
    await loginIfBackendRequired(page);
  }
});

test("backend 401 shows commercial login form", async ({ page }) => {
  await page.route("**/api/auth/me", async (route) => {
    await route.fulfill({
      status: 401,
      contentType: "application/json",
      body: JSON.stringify({ error: "unauthorized" })
    });
  });

  await page.goto("/");
  await expect(page.getByText("商业版后台登录")).toBeVisible();
  await expect(page.getByLabel("租户")).toHaveValue("default");
  await expect(page.getByLabel("邮箱")).toHaveValue("admin@oa.local");
  await expect(page.getByRole("button", { name: /登录系统/ })).toBeVisible();
});

test("app loads and shows the OA workbench", async ({ page }) => {
  await expect(page).toHaveTitle(/集团人事行政 OA Demo/);
  await expect(page.getByRole("navigation", { name: "主导航" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "全部应用" })).toBeVisible();
  await expect(page.getByPlaceholder("搜索菜单、流程、文档、人员等")).toBeVisible();
  await expect(page.getByText("当前组织：")).toBeVisible();
});

test("API-required frontend logs in and stays on backend data source", async ({ page }) => {
  test.skip(!apiRequired, "API-required browser smoke runs only in commercial CI.");

  await expect(page.locator(".api-status")).toContainText("后端已连接");
  await expect(page.locator(".api-status")).not.toContainText("本地演示模式");
  await expect(page.getByRole("button", { name: /退出登录/ })).toBeVisible();

  await page.getByRole("button", { name: "组织人事", exact: true }).click();
  await expect(page.getByRole("heading", { name: "数据导入记录" })).toBeVisible();
  await expect(page.getByRole("cell", { name: "oa-dashboard.html", exact: true })).toBeVisible();

  await page.getByRole("button", { name: "OA审批", exact: true }).click();
  await expect(page.getByRole("heading", { name: "OA审批" })).toBeVisible();
  await expect(page.locator(".approval-detail")).toBeVisible();

  await page.getByRole("button", { name: "权限审计", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "权限审计" })).toBeVisible();
});

test("API-required frontend submits an expense workflow through the backend", async ({ page }) => {
  test.skip(!apiRequired, "API-required browser smoke runs only in commercial CI.");

  const suffix = String(Date.now()).slice(-6);
  const financeRequestNo = `EXP-API-E2E-${suffix}`;
  const financeRequestTitle = `API费用报销-${suffix}`;

  await page.getByRole("button", { name: "财务行政", exact: true }).click();
  await page.getByLabel("单据编号", { exact: true }).fill(financeRequestNo);
  await page.getByLabel("标题", { exact: true }).fill(financeRequestTitle);
  await page.getByLabel("金额", { exact: true }).fill("1299.50");
  await page.getByLabel("收款方/商户", { exact: true }).fill("API验收商户");
  await page.getByLabel("事由", { exact: true }).fill("API-required Playwright 验收");
  await page.getByRole("button", { name: "提交财务单据", exact: true }).click();
  await expect(page.getByText("财务单据已创建，并进入审批链路。")).toBeVisible();

  const financeRequestRow = page.locator("tr").filter({ hasText: financeRequestNo });
  await expect(financeRequestRow).toContainText("待审批");

  await page.getByRole("button", { name: "OA审批", exact: true }).click();
  await expect(page.getByRole("cell", { name: financeRequestTitle, exact: true })).toBeVisible();
});

test.describe("local demo workflow coverage", () => {
  test.skip(apiRequired, "Commercial CI uses API-required browser smoke tests plus backend commercial smoke.");

test("management dashboard exports an auditable analytics snapshot", async ({ page }) => {
  await page.getByRole("button", { name: "管理看板", exact: true }).click();
  await expect(page.getByRole("heading", { name: "管理看板" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "行政成本构成" })).toBeVisible();
  await page.getByRole("button", { name: "导出看板快照" }).click();
  await page.getByRole("button", { name: "权限审计", exact: true }).click();
  await expect(page.getByRole("heading", { name: "商用发布状态" })).toBeVisible();
  await expect(page.getByText("发布门禁")).toBeVisible();
  await expect(page.getByText("HR审阅包")).toBeVisible();
  await expect(page.getByText("责任闭环")).toBeVisible();
  await expect(page.getByText("签署准备")).toBeVisible();
  await expect(page.getByText("HR 数据审阅包")).toBeVisible();
  await expect(page.getByText("责任人闭环报告", { exact: true })).toBeVisible();
  await expect(page.getByText("最新商业证据", { exact: true })).toBeVisible();
  await expect(page.getByText("候选证据", { exact: true })).toBeVisible();
  await expect(page.getByText("候选证据未就绪")).toBeVisible();
  await expect(page.getByText("证据工件清单", { exact: true })).toBeVisible();
  await expect(page.getByText("责任人证据清单", { exact: true })).toBeVisible();
  await expect(page.getByText("发布闭环清单", { exact: true })).toBeVisible();
  await expect(page.getByText("目标环境画像")).toBeVisible();
  await expect(page.getByText("非发布证据")).toHaveCount(2);
  await expect(page.getByText("动作分派")).toBeVisible();
  await expect(page.getByText("导出管理看板快照，本地演示仅记录导出动作")).toBeVisible();
});

test("workbench categories launch concrete lifecycle workflows", async ({ page }) => {
  const appCenter = page.locator(".app-center");
  await page.getByRole("button", { name: "人事管理", exact: true }).click();
  await expect(appCenter.getByRole("button", { name: /入职办理/ })).toBeVisible();
  await appCenter.getByRole("button", { name: /调岗申请/ }).click();
  const flowDialog = page.getByRole("dialog", { name: "发起申请" });
  await expect(flowDialog).toBeVisible();
  await expect(flowDialog.getByLabel("流程类型")).toHaveValue("transfer");
  await flowDialog.getByLabel("申请标题").fill("浏览器调岗流程验收");
  await flowDialog.getByRole("button", { name: "提交申请" }).click();

  await page.getByRole("button", { name: "OA审批", exact: true }).click();
  await expect(page.getByRole("cell", { name: "浏览器调岗流程验收" })).toBeVisible();
  await expect(page.locator(".approval-detail").getByText("调出部门审批").first()).toBeVisible();

  await page.getByRole("button", { name: "工作台", exact: true }).click();
  await page.getByRole("button", { name: "客户服务", exact: true }).click();
  await expect(appCenter.getByRole("button", { name: /客户接待申请/ })).toBeVisible();
});

test("global search launches workflows and navigates business modules", async ({ page }) => {
  const search = page.getByPlaceholder("搜索菜单、流程、文档、人员等");
  await search.fill("调岗");
  const searchPanel = page.locator(".global-search-results");
  const transferEntry = searchPanel.getByRole("button", { name: /调岗申请/ }).first();
  await expect(transferEntry).toBeVisible();
  await transferEntry.click();
  const flowDialog = page.getByRole("dialog", { name: "发起申请" });
  await expect(flowDialog).toBeVisible();
  await expect(flowDialog.getByLabel("流程类型")).toHaveValue("transfer");
  await flowDialog.getByRole("button", { name: "取消" }).click();

  await search.fill("一号会议室");
  await expect(searchPanel.getByRole("button", { name: /一号会议室/ }).first()).toBeVisible();
  await searchPanel.getByRole("button", { name: /一号会议室/ }).first().click();
  await expect(page.getByRole("heading", { name: "资源预约" })).toBeVisible();

  await search.fill("权限审计");
  await searchPanel.getByRole("button", { name: /权限审计/ }).first().click();
  await expect(page.getByRole("heading", { level: 1, name: "权限审计" })).toBeVisible();
});

test("login skeleton exposes current user and profile affordances", async ({ page }) => {
  await expect(page.getByRole("button", { name: "个人中心" })).toBeVisible();
  await expect(page.getByRole("button", { name: /张三 · 行政部/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "通知" })).toBeVisible();
});

test("people module shows dashboard import lineage", async ({ page }) => {
  await page.getByRole("button", { name: "组织人事", exact: true }).click();
  await expect(page.getByRole("heading", { name: "组织人事" })).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "最近人事流程" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "数据导入记录" })).toBeVisible();
  await expect(page.getByRole("cell", { name: "oa-dashboard.html", exact: true })).toBeVisible();
  await expect(page.getByText(/234 行/)).toBeVisible();
  await page.getByLabel("导入 HTML 数据源").setInputFiles({
    name: "runtime-e2e.html",
    mimeType: "text/html",
    buffer: Buffer.from(`
      <section>
        <h2>在职员工详细信息</h2>
        <table>
          <tbody><tr><td>9901</td><td>集团总部</td><td>浏览器导入员工</td><td>女</td><td>浏览器导入部</td><td>导入岗</td><td>2026-05-29</td><td></td><td>2026-06-29</td><td>26.0</td><td>广东/城镇</td><td>本科</td><td>浏览器大学</td><td>行政管理</td></tr></tbody>
        </table>
      </section>`)
  });
  await page.getByRole("button", { name: "导入人员数据" }).click();
  await expect(page.getByText("已提交导入：runtime-e2e.html")).toBeVisible();
  await expect(page.getByRole("cell", { name: "runtime-e2e.html", exact: true })).toBeVisible();
  await expect(page.getByRole("cell", { name: "浏览器导入员工", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "维护" }).first().click();
  await page.getByLabel("岗位").fill("行政经理");
  await page.getByRole("button", { name: "保存员工档案" }).click();
  await expect(page.getByRole("cell", { name: "行政经理", exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: "导出名册" }).click();
  await page.getByRole("button", { name: "权限审计", exact: true }).click();
  await expect(page.getByText(/更新员工 .* 档案/).first()).toBeVisible();
  await expect(page.getByText("导出在职员工，本地演示仅记录导出动作")).toBeVisible();
});

test("AND-sign approval requires both approvers before advancing", async ({ page }) => {
  await page.getByRole("button", { name: "OA审批", exact: true }).click();
  await expect(page.getByRole("heading", { name: "OA审批" })).toBeVisible();
  await page.getByRole("button", { name: "导出审批" }).click();

  const detail = page.locator(".approval-detail");
  await expect(detail.getByText("当前会签要求")).toBeVisible();
  await expect(detail.getByText(/当前节点还需/)).toBeVisible();

  await detail.getByRole("button", { name: /^同意：/ }).first().click();
  await expect(detail.getByText(/1\/2 已同意/)).toBeVisible();
  await expect(detail.getByText(/系统不会进入下一流程/)).toBeVisible();

  await detail.getByRole("button", { name: /^同意：/ }).first().click();
  await expect(detail.getByText("已通过").first()).toBeVisible();
  await expect(detail.getByText("归档与通知")).toBeVisible();

  await page.getByRole("button", { name: "权限审计", exact: true }).click();
  await expect(page.getByText("导出审批列表，本地演示仅记录导出动作")).toBeVisible();
});

test("finance payroll creation starts approval and blocks early publish", async ({ page }) => {
  await page.getByRole("button", { name: "财务行政", exact: true }).click();
  await expect(page.getByRole("heading", { name: "财务行政", exact: true })).toBeVisible();

  const suffix = String(Date.now()).slice(-5);
  const financeRequestNo = `EXP-E2E-${suffix}`;
  const financeRequestTitle = `E2E差旅报销-${suffix}`;
  await page.getByLabel("单据编号", { exact: true }).fill(financeRequestNo);
  await page.getByLabel("标题", { exact: true }).fill(financeRequestTitle);
  await page.getByLabel("金额", { exact: true }).fill("3290.75");
  await page.getByLabel("收款方/商户", { exact: true }).fill("携程商旅");
  await page.getByLabel("事由", { exact: true }).fill("E2E财务单据");
  await page.getByRole("button", { name: "提交财务单据", exact: true }).click();
  await expect(page.getByText("财务单据已创建，并进入审批链路。")).toBeVisible();
  const financeRequestRow = page.locator("tr").filter({ hasText: financeRequestNo });
  await expect(financeRequestRow).toContainText("费用报销");
  await expect(financeRequestRow).toContainText("待审批");
  await page.getByRole("button", { name: "导出财务单据", exact: true }).click();
  await page.getByRole("button", { name: "权限审计", exact: true }).click();
  await expect(page.getByText("导出财务单据台账，本地演示仅记录导出动作")).toBeVisible();
  await page.getByRole("button", { name: "财务行政", exact: true }).click();

  const scope = `E2E工资范围-${suffix}`;
  await page.getByLabel("批次号", { exact: true }).fill(`PAYROLL-E2E-${suffix}`);
  await page.getByLabel("工资周期", { exact: true }).fill("2026年7月");
  await page.getByLabel("人员范围", { exact: true }).fill(scope);
  await page.getByLabel("发薪人数", { exact: true }).fill("72");
  await page.getByLabel("工资总额", { exact: true }).fill("680000");
  await page.getByLabel("备注", { exact: true }).fill("E2E创建工资单");
  await page.getByRole("button", { name: "创建工资单", exact: true }).click();

  await expect(page.getByText("工资单已创建，并进入审批链路。")).toBeVisible();
  const payrollRow = page.locator("tr").filter({ hasText: scope });
  await expect(payrollRow).toContainText("待复核");
  await expect(payrollRow).toContainText("待审批");

  await payrollRow.getByRole("button", { name: "复核发布", exact: true }).click();
  await expect(payrollRow).toContainText("待复核");

  await page.getByRole("button", { name: "OA审批", exact: true }).click();
  await expect(page.locator(".approval-detail").getByRole("heading", { name: "2026年7月工资单复核", exact: true })).toBeVisible();
  await expect(page.locator(".approval-detail").getByText(scope)).toBeVisible();
  await expect(page.locator(".approval-detail").getByText("当前会签要求")).toBeVisible();
});

test("asset ledger export action is wired from the asset module", async ({ page }) => {
  await page.getByRole("button", { name: "行政资产", exact: true }).click();
  await expect(page.getByRole("heading", { name: "行政资产" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "资产台账" })).toBeVisible();
  await expect(page.getByRole("img", { name: /资产二维码/ })).toHaveAttribute("src", /^data:image\/png;base64,/);
  await page.getByRole("button", { name: "导出台账" }).click();

  await page.getByRole("button", { name: "权限审计", exact: true }).click();
  await expect(page.getByText("导出资产台账，本地演示仅记录导出动作")).toBeVisible();
});

test("attendance module records clock exceptions and audit entries", async ({ page }) => {
  await page.getByRole("button", { name: "假勤", exact: true }).click();
  await expect(page.getByRole("heading", { name: "假勤", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "考勤记录" })).toBeVisible();
  await expect(page.getByText("本月考勤异常")).toBeVisible();

  const employee = `E2E考勤-${Date.now().toString().slice(-5)}`;
  await page.getByLabel("员工", { exact: true }).fill(employee);
  await page.getByLabel("部门", { exact: true }).fill("行政部");
  await page.getByLabel("考勤日期", { exact: true }).fill("2026-06-18");
  await page.getByRole("combobox", { name: "状态", exact: true }).selectOption({ label: "缺卡" });
  await page.getByLabel("异常说明", { exact: true }).fill("E2E补录缺卡");
  await page.getByRole("button", { name: "保存考勤记录" }).click();
  await expect(page.getByText("考勤记录已保存，并写入审计日志。")).toBeVisible();
  await expect(page.getByRole("cell", { name: employee, exact: true })).toBeVisible();
  await page.getByRole("button", { name: "导出考勤记录" }).click();

  await page.getByRole("button", { name: "权限审计", exact: true }).click();
  await expect(page.getByText(`录入${employee} 2026-06-18 考勤记录`)).toBeVisible();
  await expect(page.getByText("导出考勤记录台账，本地演示仅记录导出动作")).toBeVisible();
});

test("resource booking cancellation releases the slot for rebooking", async ({ page }) => {
  await page.getByRole("button", { name: "资源预约", exact: true }).click();
  await expect(page.getByRole("heading", { name: "资源预约" })).toBeVisible();

  const purpose = `E2E资源取消重约-${Date.now().toString().slice(-5)}`;
  await page.getByLabel("资源").selectOption("一号会议室");
  await page.getByLabel("快捷日期").selectOption("2");
  await page.getByLabel("时段").selectOption("16:00-18:00");
  await page.getByLabel("用途").fill(purpose);
  await expect(page.getByText("可预约").first()).toBeVisible();
  await page.getByRole("button", { name: "提交预约" }).click();
  await expect(page.getByText("预约已提交，资源占用数和审计日志已同步更新。")).toBeVisible();

  const bookingPanel = page.locator(".panel").filter({ hasText: "预约记录" });
  const bookingRow = bookingPanel.locator("tr").filter({ hasText: purpose }).first();
  await expect(bookingRow).toContainText("已预约");
  await bookingRow.getByRole("button", { name: "取消" }).click();
  await expect(bookingRow).toContainText("已取消");
  await expect(page.getByText("可预约").first()).toBeVisible();

  await page.getByRole("button", { name: "提交预约" }).click();
  await expect(page.getByText("预约已提交，资源占用数和审计日志已同步更新。")).toBeVisible();
  const bookingRows = bookingPanel.locator("tr").filter({ hasText: purpose });
  await expect(bookingRows).toHaveCount(2);
  await expect(bookingRows.filter({ hasText: "已预约" }).first()).toBeVisible();
  await expect(bookingRows.filter({ hasText: "已取消" }).first()).toBeVisible();
  await page.getByRole("button", { name: "导出预约台账" }).click();

  await page.getByRole("button", { name: "权限审计", exact: true }).click();
  await expect(page.getByText(/取消一号会议室 .*16:00-18:00/)).toBeVisible();
  await expect(page.getByText("导出资源预约台账，本地演示仅记录导出动作")).toBeVisible();
});

test("approval transfer creates a replacement pending approver", async ({ page }) => {
  await page.getByRole("button", { name: "OA审批", exact: true }).click();
  await expect(page.getByRole("heading", { name: "OA审批" })).toBeVisible();

  const detail = page.locator(".approval-detail");
  await detail.getByLabel("转交审批人").fill("王五");
  await detail.getByRole("button", { name: "转交" }).click();

  await expect(detail.getByText("已转交").first()).toBeVisible();
  await expect(detail.getByRole("button", { name: "同意：王五" })).toBeVisible();
  await expect(detail.getByText(/王五 同意/)).toBeVisible();
});

test("department approval rule editor changes the next submitted approval snapshot", async ({ page }) => {
  await page.getByRole("button", { name: "OA审批", exact: true }).click();
  await expect(page.getByRole("heading", { name: "OA审批" })).toBeVisible();

  const editor = page.locator(".rule-editor");
  await expect(editor.getByText("每个节点固定为会签")).toBeVisible();
  await editor.getByLabel("部门").selectOption("行政部");
  await editor.getByLabel("流程").selectOption("expense");
  await editor.locator(".rule-node-card").first().getByLabel("审批人，逗号分隔").fill("甲主管，乙主管");
  await editor.getByRole("button", { name: "保存配置" }).click();
  await editor.getByRole("button", { name: "后端预览" }).click();
  await expect(editor.getByText("后端确认：部门规则")).toBeVisible();
  await expect(editor.getByText(/甲主管、乙主管/)).toBeVisible();

  await page.getByRole("button", { name: "发起申请" }).click();
  await page.getByLabel("申请标题").fill("规则快照测试");
  await page.getByRole("button", { name: "提交申请" }).click();

  const firstRow = page.locator(".approval-workspace .data-table tbody tr").first();
  await expect(firstRow).toContainText("规则快照测试");
  await firstRow.getByRole("button", { name: "打开" }).click();

  const detail = page.locator(".approval-detail");
  await expect(detail.getByRole("button", { name: "同意：甲主管" })).toBeVisible();
  await expect(detail.getByRole("button", { name: "同意：乙主管" })).toBeVisible();
  await expect(detail.getByText(/当前节点还需 甲主管、乙主管 同意/)).toBeVisible();
});

test("audit screen records sensitive-field reveal and export actions", async ({ page }) => {
  await page.getByRole("button", { name: "权限审计", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "权限审计" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "审计完整性" })).toBeVisible();
  await expect(page.getByText("未签名遗留行")).toBeVisible();
  await expect(page.getByText("默认隐藏")).toBeVisible();
  await expect(page.getByText(/\d+ 个权限点/)).toBeVisible();

  await page.getByRole("button", { name: /审计查看员/ }).click();
  await expect(page.locator(".permission-editor").getByText("audit-viewer")).toBeVisible();
  await page.locator(".permission-editor").getByRole("checkbox", { name: "查看员工 employee.read" }).check();
  await expect(page.getByText("更新 审计查看员 权限范围")).toBeVisible();

  await expect(page.getByRole("heading", { name: "账号角色分配" })).toBeVisible();
  const accountForm = page.locator(".account-create-form");
  await accountForm.getByLabel("姓名").fill("E2E新账号");
  await accountForm.getByLabel("邮箱").fill("e2e.account@oa.local");
  await accountForm.getByLabel("临时密码").fill("E2EAccountPass123");
  await accountForm.getByRole("button", { name: "创建账号" }).click();
  await expect(page.getByText("创建账号 E2E新账号")).toBeVisible();
  await expect(page.getByText("E2EAccountPass123")).toHaveCount(0);

  await page.getByRole("button", { name: /李四/ }).click();
  await page.locator(".user-role-editor").getByRole("checkbox", { name: /审计查看员/ }).check();
  await expect(page.getByText("更新 李四 账号角色")).toBeVisible();
  await page.locator(".user-role-editor").getByRole("button", { name: "停用账号" }).click();
  await expect(page.getByText("更新 李四 账号状态：停用")).toBeVisible();
  await expect(page.locator(".user-role-editor").getByText("已停用")).toBeVisible();
  await page.locator(".user-role-editor").getByRole("button", { name: "恢复账号" }).click();
  await expect(page.getByText("更新 李四 账号状态：启用")).toBeVisible();
  await page.locator(".user-role-editor").getByLabel("临时密码").fill("TemporaryPass123");
  await page.locator(".user-role-editor").getByRole("button", { name: "重置密码" }).click();
  await expect(page.getByText("重置账号 李四 密码，本地演示不保存明文密码")).toBeVisible();
  await expect(page.getByText("TemporaryPass123")).toHaveCount(0);

  await page.getByRole("button", { name: "授权敏感字段" }).click();
  await expect(page.getByText("已授权")).toBeVisible();
  await expect(page.getByText("开启敏感字段查看")).toBeVisible();

  await page.getByLabel("选择附件").setInputFiles({
    name: "commercial-e2e.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("commercial attachment")
  });
  await page.getByRole("button", { name: "上传附件" }).click();
  await expect(page.getByRole("cell", { name: "commercial-e2e.txt", exact: true })).toBeVisible();
  await expect(page.getByText("上传附件 commercial-e2e.txt")).toBeVisible();
  await page.getByRole("button", { name: "下载" }).first().click();
  await expect(page.getByText("下载附件 commercial-e2e.txt")).toBeVisible();

  await page.getByRole("button", { name: "导出日志" }).click();
  await expect(page.getByText("导出操作日志，自动记录导出人和时间")).toBeVisible();
  await expect(page.getByRole("cell", { name: "操作日志" }).first()).toBeVisible();
});
});
