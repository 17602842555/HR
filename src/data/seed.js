import {
  BarChart3,
  BriefcaseBusiness,
  CalendarDays,
  ClipboardCheck,
  ClipboardList,
  FileText,
  Landmark,
  LayoutDashboard,
  MonitorCog,
  PackageCheck,
  ShieldCheck,
  UsersRound,
  WalletCards
} from "lucide-react";

export const sideNav = [
  { id: "workbench", label: "工作台", icon: LayoutDashboard },
  { id: "people", label: "组织人事", icon: UsersRound },
  { id: "assets", label: "行政资产", icon: BriefcaseBusiness },
  { id: "approvals", label: "OA审批", icon: ClipboardList },
  { id: "finance", label: "财务行政", icon: WalletCards },
  { id: "attendance", label: "假勤", icon: ClipboardCheck },
  { id: "resources", label: "资源预约", icon: CalendarDays },
  { id: "analytics", label: "管理看板", icon: MonitorCog },
  { id: "audit", label: "权限审计", icon: ShieldCheck }
];

export const appCatalog = [
  { id: "enterprise", title: "企业管理", icon: "企", meta: "完成", module: "people", category: "最近使用" },
  { id: "employees", title: "在职员工", icon: "人", metricKey: "employees", module: "people", category: "人事管理" },
  { id: "women", title: "女性员工", icon: "女", metricKey: "femaleEmployees", module: "people", category: "人事管理" },
  { id: "leavers", title: "离职人员", icon: "离", metricKey: "leavers", module: "people", category: "人事管理" },
  { id: "monthLeave", title: "当月离职", icon: "月", metricKey: "monthLeavers", module: "people", category: "数据分析" },
  { id: "pending", title: "待办审批", icon: "审", metricKey: "pendingApprovals", module: "approvals", category: "审批工具" },
  { id: "onboarding", title: "入职办理", icon: "入", meta: "流程", module: "approvals", category: "人事管理", templateId: "onboarding" },
  { id: "regularization", title: "转正申请", icon: "转", meta: "流程", module: "approvals", category: "人事管理", templateId: "regularization" },
  { id: "transfer", title: "调岗申请", icon: "调", meta: "流程", module: "approvals", category: "人事管理", templateId: "transfer" },
  { id: "offboarding", title: "离职交接", icon: "交", meta: "流程", module: "approvals", category: "人事管理", templateId: "offboarding" },
  { id: "payroll", title: "工资单", icon: "资", meta: "流程", module: "finance", category: "财务行政", templateId: "payroll" },
  { id: "attendance", title: "假勤", icon: "假", meta: "流程", module: "attendance", category: "人事管理", templateId: "leave" },
  { id: "exception", title: "状态异常人员报备", icon: "报", meta: "流程", module: "approvals", category: "审批工具", templateId: "exception" },
  { id: "items", title: "物品领用", icon: "领", meta: "流程", module: "assets", category: "行政资产", templateId: "item" },
  { id: "report", title: "工作汇报", icon: "汇", meta: "流程", module: "approvals", category: "数据分析", templateId: "weekly_report" },
  { id: "board", title: "看板", icon: "板", meta: "完成", module: "analytics", category: "数据分析" },
  { id: "client-service", title: "客户接待申请", icon: "客", meta: "流程", module: "approvals", category: "客户服务", templateId: "client_request" },
  { id: "culture-event", title: "文化活动申请", icon: "文", meta: "流程", module: "approvals", category: "企业文化", templateId: "culture_event" },
  { id: "training-request", title: "培训申请", icon: "培", meta: "流程", module: "approvals", category: "培训学习", templateId: "training_request" },
  { id: "resource-calendar", title: "资源日历", icon: "预", meta: "可预约", module: "resources", category: "更多" },
  { id: "audit-export", title: "导出记录", icon: "导", meta: "审计", module: "audit", category: "更多" }
];

export const flowTemplates = [
  {
    id: "expense",
    name: "费用报销",
    owner: "申请人",
    department: "行政部",
    amount: "¥980.00",
    node: "财务复核",
    category: "财务行政",
    sla: "24h",
    serviceKey: "FIN-EXPENSE",
    condition: "金额 ≥ 500 元时进入财务复核",
    approvalMode: "或签",
    fields: [
      { id: "expenseType", label: "报销类型", type: "select", value: "办公采购", options: ["办公采购", "差旅交通", "招待费", "直播耗材"] },
      { id: "amount", label: "报销金额", type: "amount", value: "980" },
      { id: "invoice", label: "发票张数", type: "number", value: "2" },
      { id: "occurredAt", label: "发生日期", type: "date", value: "2026-05-29" }
    ],
    nodes: ["申请人提交", "直属负责人审批", "财务复核", "归档与通知"]
  },
  {
    id: "payment",
    name: "付款申请",
    owner: "采购申请人",
    department: "采购部",
    amount: "¥8,950.00",
    node: "出纳付款",
    category: "财务行政",
    sla: "48h",
    serviceKey: "FIN-PAYMENT",
    condition: "金额 ≥ 5000 元增加负责人会签",
    approvalMode: "会签",
    fields: [
      { id: "supplier", label: "收款方", type: "input", value: "供应商 A" },
      { id: "amount", label: "付款金额", type: "amount", value: "8950" },
      { id: "bankAccount", label: "收款账号", type: "input", value: "" },
      { id: "payDate", label: "期望付款日", type: "date", value: "2026-05-31" }
    ],
    nodes: ["申请人提交", "采购负责人审批", "财务复核", "出纳付款", "归档与通知"]
  },
  {
    id: "payroll",
    name: "工资单复核",
    owner: "财务中心",
    department: "财务中心",
    amount: "72人",
    node: "财务负责人审批",
    category: "财务行政",
    sla: "24h",
    serviceKey: "FIN-PAYROLL",
    condition: "工资单需薪资、财务、人事全部确认后发布",
    approvalMode: "会签",
    fields: [
      { id: "cycle", label: "工资周期", type: "input", value: "2026年5月" },
      { id: "scope", label: "人员范围", type: "input", value: "在职、转正、入离职、异动人员" },
      { id: "headcount", label: "发薪人数", type: "number", value: "72" },
      { id: "totalAmount", label: "工资总额", type: "amount", value: "486000" }
    ],
    nodes: ["申请人提交", "薪资专员复核", "财务负责人审批", "人事负责人确认", "归档与通知"]
  },
  {
    id: "recruit",
    name: "招聘需求",
    owner: "招聘申请人",
    department: "人力资源部",
    amount: "2人",
    node: "编制复核",
    category: "组织人事",
    sla: "72h",
    serviceKey: "HR-RECRUIT",
    condition: "新增编制需人事与部门负责人会签",
    approvalMode: "会签",
    fields: [
      { id: "position", label: "招聘岗位", type: "input", value: "短视频运营" },
      { id: "headcount", label: "需求人数", type: "number", value: "2" },
      { id: "level", label: "岗位级别", type: "select", value: "P2", options: ["P1", "P2", "P3", "主管"] },
      { id: "targetDate", label: "到岗日期", type: "date", value: "2026-06-15" }
    ],
    nodes: ["申请人提交", "部门负责人审批", "编制复核", "HRBP 归档"]
  },
  {
    id: "salary",
    name: "调薪申请",
    owner: "部门申请人",
    department: "直播事业部",
    amount: "¥1,200.00",
    node: "薪酬审批",
    category: "组织人事",
    sla: "72h",
    serviceKey: "HR-SALARY",
    condition: "调薪比例 > 15% 时增加总经理审批",
    approvalMode: "顺序审批",
    fields: [
      { id: "employee", label: "调薪员工", type: "input", value: "员工姓名" },
      { id: "adjustAmount", label: "调整金额", type: "amount", value: "1200" },
      { id: "effectiveDate", label: "生效日期", type: "date", value: "2026-06-01" },
      { id: "reasonType", label: "调薪原因", type: "select", value: "岗位调整", options: ["岗位调整", "绩效激励", "转正调薪", "留才调薪"] }
    ],
    nodes: ["申请人提交", "直属负责人审批", "薪酬审批", "总经理审批", "归档与通知"]
  },
  {
    id: "onboarding",
    name: "入职办理",
    owner: "人事专员",
    department: "人力资源部",
    amount: "入职",
    node: "资料复核",
    category: "组织人事",
    sla: "48h",
    serviceKey: "HR-ONBOARD",
    condition: "新员工入职需部门、人事、行政资产同步确认",
    approvalMode: "会签",
    fields: [
      { id: "employee", label: "入职员工", type: "input", value: "新员工" },
      { id: "position", label: "入职岗位", type: "input", value: "运营专员" },
      { id: "entryDate", label: "入职日期", type: "date", value: "2026-06-03" },
      { id: "probationMonths", label: "试用期（月）", type: "number", value: "3" },
      { id: "equipmentNeed", label: "设备需求", type: "select", value: "电脑+工位", options: ["电脑+工位", "工位", "直播设备", "无需设备"] }
    ],
    nodes: ["申请人提交", "部门负责人确认", "人事资料复核", "行政资产准备", "归档与通知"]
  },
  {
    id: "regularization",
    name: "转正申请",
    owner: "人事专员",
    department: "人力资源部",
    amount: "转正",
    node: "绩效确认",
    category: "组织人事",
    sla: "48h",
    serviceKey: "HR-REGULAR",
    condition: "试用期转正需部门评价与人事归档",
    approvalMode: "会签",
    fields: [
      { id: "employee", label: "转正员工", type: "input", value: "员工姓名" },
      { id: "probationResult", label: "试用期结论", type: "select", value: "按期转正", options: ["按期转正", "提前转正", "延期转正", "不予转正"] },
      { id: "effectiveDate", label: "生效日期", type: "date", value: "2026-06-01" },
      { id: "reviewer", label: "评估负责人", type: "input", value: "部门负责人" }
    ],
    nodes: ["申请人提交", "直属负责人评价", "人事复核", "归档与通知"]
  },
  {
    id: "transfer",
    name: "调岗申请",
    owner: "人事专员",
    department: "人力资源部",
    amount: "调岗",
    node: "调出调入会签",
    category: "组织人事",
    sla: "72h",
    serviceKey: "HR-TRANSFER",
    condition: "调岗需原部门、接收部门、人事全部同意",
    approvalMode: "会签",
    fields: [
      { id: "employee", label: "调岗员工", type: "input", value: "员工姓名" },
      { id: "fromDepartment", label: "调出部门", type: "input", value: "直播事业部" },
      { id: "toDepartment", label: "调入部门", type: "input", value: "运营中心" },
      { id: "effectiveDate", label: "生效日期", type: "date", value: "2026-06-10" },
      { id: "handover", label: "交接安排", type: "textarea", value: "完成账号、资产、客户和项目交接。" }
    ],
    nodes: ["申请人提交", "调出部门审批", "调入部门审批", "人事复核", "归档与通知"]
  },
  {
    id: "offboarding",
    name: "离职交接",
    owner: "人事专员",
    department: "人力资源部",
    amount: "离职",
    node: "交接确认",
    category: "组织人事",
    sla: "72h",
    serviceKey: "HR-OFFBOARD",
    condition: "离职需工作交接、资产归还、财务结算全部完成",
    approvalMode: "会签",
    fields: [
      { id: "employee", label: "离职员工", type: "input", value: "员工姓名" },
      { id: "leaveDate", label: "最后工作日", type: "date", value: "2026-06-15" },
      { id: "reasonType", label: "离职类型", type: "select", value: "个人原因", options: ["个人原因", "合同到期", "组织调整", "绩效原因"] },
      { id: "handover", label: "交接人", type: "input", value: "交接人" },
      { id: "assetReturn", label: "资产归还", type: "select", value: "待确认", options: ["已归还", "待确认", "无需归还"] }
    ],
    nodes: ["申请人提交", "直属负责人交接确认", "行政资产核验", "财务结算", "人事归档"]
  },
  {
    id: "exception",
    name: "状态异常人员报备",
    owner: "异常发现人",
    department: "行政部",
    amount: "异常报备",
    node: "人事核验",
    category: "组织人事",
    sla: "24h",
    serviceKey: "HR-EXCEPTION",
    condition: "人员状态、考勤、合同或权限异常需人事与审计留痕",
    approvalMode: "会签",
    fields: [
      { id: "employee", label: "异常人员", type: "input", value: "待核验员工" },
      { id: "exceptionType", label: "异常类型", type: "select", value: "状态不一致", options: ["状态不一致", "考勤异常", "合同异常", "权限异常"] },
      { id: "discoveredAt", label: "发现日期", type: "date", value: "2026-05-29" },
      { id: "actionPlan", label: "处理方案", type: "textarea", value: "由人事核验事实，必要时同步权限审计。" }
    ],
    nodes: ["申请人提交", "直属负责人确认", "人事核验", "权限审计留痕", "归档与通知"]
  },
  {
    id: "weekly_report",
    name: "工作汇报",
    owner: "汇报人",
    department: "行政部",
    amount: "汇报",
    node: "负责人阅示",
    category: "数据分析",
    sla: "24h",
    serviceKey: "OPS-REPORT",
    condition: "部门工作汇报需负责人阅示并进入管理看板风险池",
    approvalMode: "顺序审批",
    fields: [
      { id: "period", label: "汇报周期", type: "input", value: "2026年第22周" },
      { id: "summary", label: "本期进展", type: "textarea", value: "完成 OA 流程梳理和数据导入核对。" },
      { id: "risk", label: "风险事项", type: "textarea", value: "后端数据库环境待部署。" },
      { id: "nextPlan", label: "下期计划", type: "textarea", value: "完成真实数据库冒烟和恢复演练。" }
    ],
    nodes: ["申请人提交", "直属负责人阅示", "管理看板归档"]
  },
  {
    id: "client_request",
    name: "客户接待申请",
    owner: "客户负责人",
    department: "客户服务部",
    amount: "客户接待",
    node: "客服负责人确认",
    category: "客户服务",
    sla: "24h",
    serviceKey: "CRM-SERVICE",
    condition: "客户到访需客服、行政资源和接待负责人同步确认",
    approvalMode: "会签",
    fields: [
      { id: "clientName", label: "客户名称", type: "input", value: "重点客户" },
      { id: "visitDate", label: "到访日期", type: "date", value: "2026-06-05" },
      { id: "visitorCount", label: "来访人数", type: "number", value: "3" },
      { id: "resourceNeed", label: "资源需求", type: "input", value: "会议室、车辆、茶歇" }
    ],
    nodes: ["申请人提交", "客服负责人确认", "行政资源安排", "归档与通知"]
  },
  {
    id: "culture_event",
    name: "文化活动申请",
    owner: "活动申请人",
    department: "人力资源部",
    amount: "活动",
    node: "预算确认",
    category: "企业文化",
    sla: "48h",
    serviceKey: "CULTURE-EVENT",
    condition: "企业文化活动需人事、财务和行政资源确认",
    approvalMode: "会签",
    fields: [
      { id: "eventName", label: "活动名称", type: "input", value: "月度员工活动" },
      { id: "budget", label: "活动预算", type: "amount", value: "3000" },
      { id: "eventDate", label: "活动日期", type: "date", value: "2026-06-12" },
      { id: "participants", label: "参与范围", type: "input", value: "集团总部全员" }
    ],
    nodes: ["申请人提交", "人事负责人审批", "财务预算确认", "行政资源安排", "归档与通知"]
  },
  {
    id: "training_request",
    name: "培训申请",
    owner: "培训申请人",
    department: "人力资源部",
    amount: "培训",
    node: "培训负责人审批",
    category: "培训学习",
    sla: "48h",
    serviceKey: "TRAIN-REQUEST",
    condition: "培训报名或外部课程需负责人和培训管理员确认",
    approvalMode: "会签",
    fields: [
      { id: "courseName", label: "课程名称", type: "input", value: "OA 管理员培训" },
      { id: "trainee", label: "参训人员", type: "input", value: "参训人员" },
      { id: "trainingDate", label: "培训日期", type: "date", value: "2026-06-08" },
      { id: "cost", label: "培训费用", type: "amount", value: "1200" }
    ],
    nodes: ["申请人提交", "直属负责人审批", "培训负责人确认", "归档与通知"]
  },
  {
    id: "leave",
    name: "请假申请",
    owner: "请假申请人",
    department: "仓储部",
    amount: "2天",
    node: "直属负责人审批",
    category: "假勤",
    sla: "24h",
    serviceKey: "ATT-LEAVE",
    condition: "请假 ≥ 3 天时增加人事备案",
    approvalMode: "顺序审批",
    fields: [
      { id: "leaveType", label: "假期类型", type: "select", value: "年假", options: ["年假", "病假", "事假", "调休"] },
      { id: "dateRange", label: "请假日期", type: "input", value: "2026-05-30 ~ 2026-05-31" },
      { id: "days", label: "请假时长", type: "number", value: "2" },
      { id: "handover", label: "工作交接人", type: "input", value: "交接人" }
    ],
    nodes: ["申请人提交", "直属负责人审批", "人事备案", "归档与通知"]
  },
  {
    id: "item",
    name: "物品领用",
    owner: "领用申请人",
    department: "行政部",
    amount: "直播耗材",
    node: "行政出库",
    category: "行政资产",
    sla: "24h",
    serviceKey: "ADM-ITEM",
    condition: "高值物品需行政资产管理员确认",
    approvalMode: "或签",
    fields: [
      { id: "itemName", label: "领用品类", type: "input", value: "直播耗材" },
      { id: "quantity", label: "数量", type: "number", value: "1" },
      { id: "useScene", label: "使用场景", type: "select", value: "直播间", options: ["直播间", "办公室", "仓库", "会议室"] },
      { id: "returnable", label: "是否归还", type: "select", value: "否", options: ["是", "否"] }
    ],
    nodes: ["申请人提交", "行政审批", "行政出库", "归档与通知"]
  }
];

export const moduleCards = [
  { title: "组织人事工作区", desc: "人员、组织、编制与流程总览", icon: UsersRound },
  { title: "人员组织架构", desc: "公司、部门、岗位、成员展开", icon: BarChart3 },
  { title: "在职人员名册", desc: "员工详细信息与敏感字段脱敏", icon: FileText },
  { title: "离职人员管理", desc: "离职统计、明细和当月口径", icon: ClipboardCheck },
  { title: "当月离职", desc: "2026 年 5 月离职 4 人", icon: CalendarDays },
  { title: "招聘需求流程", desc: "编制、面试、Offer 与入职", icon: ClipboardList },
  { title: "调薪申请流程", desc: "薪酬调整审批与生效归档", icon: Landmark },
  { title: "假勤流程", desc: "定位打卡、请假、年假、病假", icon: CalendarDays }
];

export const permissionCatalog = [
  { id: "PERM-system.admin", code: "system.admin", name: "系统管理", module: "system" },
  { id: "PERM-analytics.read", code: "analytics.read", name: "查看管理看板", module: "analytics" },
  { id: "PERM-analytics.export", code: "analytics.export", name: "导出管理看板", module: "analytics" },
  { id: "PERM-iam.read", code: "iam.read", name: "查看用户角色", module: "iam" },
  { id: "PERM-iam.write", code: "iam.write", name: "管理用户角色", module: "iam" },
  { id: "PERM-employee.read", code: "employee.read", name: "查看员工", module: "people" },
  { id: "PERM-employee.sensitive.read", code: "employee.sensitive.read", name: "查看员工敏感字段", module: "people" },
  { id: "PERM-employee.write", code: "employee.write", name: "管理员工", module: "people" },
  { id: "PERM-employee.export", code: "employee.export", name: "导出员工名册", module: "people" },
  { id: "PERM-workflow.read", code: "workflow.read", name: "查看审批", module: "workflow" },
  { id: "PERM-workflow.write", code: "workflow.write", name: "配置审批", module: "workflow" },
  { id: "PERM-workflow.approve", code: "workflow.approve", name: "处理审批", module: "workflow" },
  { id: "PERM-workflow.export", code: "workflow.export", name: "导出审批列表", module: "workflow" },
  { id: "PERM-attendance.read", code: "attendance.read", name: "查看假勤", module: "attendance" },
  { id: "PERM-attendance.write", code: "attendance.write", name: "管理假勤", module: "attendance" },
  { id: "PERM-attendance.export", code: "attendance.export", name: "导出考勤记录", module: "attendance" },
  { id: "PERM-finance.read", code: "finance.read", name: "查看财务", module: "finance" },
  { id: "PERM-finance.write", code: "finance.write", name: "管理财务", module: "finance" },
  { id: "PERM-finance.export", code: "finance.export", name: "导出财务单据", module: "finance" },
  { id: "PERM-asset.read", code: "asset.read", name: "查看资产", module: "asset" },
  { id: "PERM-asset.write", code: "asset.write", name: "管理资产", module: "asset" },
  { id: "PERM-asset.export", code: "asset.export", name: "导出资产台账", module: "asset" },
  { id: "PERM-import.read", code: "import.read", name: "查看数据导入记录", module: "import" },
  { id: "PERM-import.write", code: "import.write", name: "导入人员数据", module: "import" },
  { id: "PERM-resource.read", code: "resource.read", name: "查看资源", module: "resource" },
  { id: "PERM-resource.book", code: "resource.book", name: "预约资源", module: "resource" },
  { id: "PERM-resource.export", code: "resource.export", name: "导出资源预约", module: "resource" },
  { id: "PERM-audit.read", code: "audit.read", name: "查看审计日志", module: "audit" },
  { id: "PERM-audit.export", code: "audit.export", name: "导出审计日志", module: "audit" },
  { id: "PERM-file.read", code: "file.read", name: "查看文件附件", module: "file" },
  { id: "PERM-file.upload", code: "file.upload", name: "上传文件", module: "file" }
];

function permissionsByCode(codes) {
  const codeSet = new Set(codes);
  return permissionCatalog.filter((permission) => codeSet.has(permission.code));
}

export const roleSeed = [
  {
    id: "ROLE-admin",
    code: "admin",
    name: "系统管理员",
    description: "拥有系统配置、审批、审计与数据管理权限",
    userCount: 2,
    permissionCodes: permissionCatalog.map((permission) => permission.code),
    permissions: permissionCatalog
  },
  {
    id: "ROLE-employee",
    code: "employee-self-service",
    name: "员工自助",
    description: "员工个人工作台、审批发起、假勤、资源预约和附件上传权限",
    userCount: 0,
    permissionCodes: ["workflow.read", "workflow.write", "attendance.read", "attendance.write", "resource.read", "resource.book", "file.read", "file.upload", "finance.read", "finance.write"],
    permissions: permissionsByCode(["workflow.read", "workflow.write", "attendance.read", "attendance.write", "resource.read", "resource.book", "file.read", "file.upload", "finance.read", "finance.write"])
  },
  {
    id: "ROLE-hr",
    code: "hr-specialist",
    name: "人事专员",
    description: "维护人员档案、入转调离和假勤流程",
    userCount: 4,
    permissionCodes: ["employee.read", "employee.write", "employee.export", "attendance.read", "attendance.write", "attendance.export", "workflow.read", "workflow.write", "workflow.approve", "import.read", "import.write"],
    permissions: permissionsByCode(["employee.read", "employee.write", "employee.export", "attendance.read", "attendance.write", "attendance.export", "workflow.read", "workflow.write", "workflow.approve", "import.read", "import.write"])
  },
  {
    id: "ROLE-department-manager",
    code: "department-manager",
    name: "部门负责人",
    description: "按所属部门查看人员，并处理本部门审批",
    userCount: 6,
    permissionCodes: ["employee.read", "employee.export", "attendance.read", "workflow.read", "workflow.approve"],
    permissions: permissionsByCode(["employee.read", "employee.export", "attendance.read", "workflow.read", "workflow.approve"])
  },
  {
    id: "ROLE-asset",
    code: "asset-admin",
    name: "行政资产管理员",
    description: "管理资产台账、二维码、借还和盘点",
    userCount: 3,
    permissionCodes: ["asset.read", "asset.write", "asset.export", "resource.read", "resource.book", "resource.export", "workflow.read", "workflow.approve"],
    permissions: permissionsByCode(["asset.read", "asset.write", "asset.export", "resource.read", "resource.book", "resource.export", "workflow.read", "workflow.approve"])
  },
  {
    id: "ROLE-finance",
    code: "finance-approver",
    name: "财务审批人",
    description: "处理付款、报销和工资单流程",
    userCount: 5,
    permissionCodes: ["finance.read", "finance.write", "finance.export", "workflow.read", "workflow.approve", "audit.read"],
    permissions: permissionsByCode(["finance.read", "finance.write", "finance.export", "workflow.read", "workflow.approve", "audit.read"])
  },
  {
    id: "ROLE-auditor",
    code: "audit-viewer",
    name: "审计查看员",
    description: "查看操作日志、导出记录和敏感字段访问记录",
    userCount: 1,
    permissionCodes: ["analytics.read", "analytics.export", "audit.read", "audit.export"],
    permissions: permissionsByCode(["analytics.read", "analytics.export", "audit.read", "audit.export"])
  }
];

export const dayLabels = ["周三 05-21", "周四 05-22", "周五 05-23", "周六 05-24", "周日 05-25", "周一 05-26", "周二 05-27"];

export function formDefaults(template) {
  return Object.fromEntries((template.fields || []).map((field) => [field.id, field.value || ""]));
}

export function workflowDefinitionToTemplate(definition = {}) {
  const fallback = flowTemplates.find((template) => (
    template.id === definition.templateId
    || template.serviceKey === definition.code
    || template.id === definition.id
  )) || {};
  const fallbackFields = new Map((fallback.fields || []).map((field) => [field.id, field]));
  const rawNodes = (definition.nodes || []).map((node) => (
    typeof node === "string" ? node : node.name
  )).filter(Boolean);
  const nodes = [
    "申请人提交",
    ...rawNodes,
    ...(rawNodes.some((node) => node.includes("归档")) ? [] : ["归档与通知"])
  ];
  const fields = (definition.fields || fallback.fields || []).map((field) => ({
    ...(fallbackFields.get(field.id) || {}),
    ...field,
    value: field.value ?? fallbackFields.get(field.id)?.value ?? ""
  }));

  return {
    ...fallback,
    id: definition.templateId || fallback.id || definition.id || definition.code,
    name: definition.name || fallback.name || definition.code,
    owner: definition.owner || fallback.owner || "申请人",
    department: fallback.department || "行政部",
    amount: fallback.amount || "-",
    node: rawNodes.find((node) => !node.includes("归档")) || fallback.node || "待分配",
    category: definition.category || fallback.category || "OA审批",
    sla: definition.sla || fallback.sla || "24h",
    serviceKey: definition.code || fallback.serviceKey || definition.id,
    condition: fallback.condition || "按后端审批定义和部门规则流转",
    approvalMode: fallback.approvalMode || "会签",
    fields,
    nodes
  };
}

export function templatesFromDefinitions(definitions = []) {
  if (!definitions?.length) return flowTemplates;
  return definitions.map(workflowDefinitionToTemplate);
}

export function fieldValueLabel(template, formData = {}) {
  const amountField = (template.fields || []).find((field) => [
    "amount",
    "adjustAmount",
    "budget",
    "cost",
    "days",
    "employee",
    "headcount",
    "itemName",
    "period",
    "quantity"
  ].includes(field.id));
  if (!amountField) return template.amount;
  const value = formData[amountField.id] || amountField.value || template.amount;
  return amountField.type === "amount" ? `¥${Number(value || 0).toLocaleString("zh-CN")}` : String(value);
}

function approversFor(template, department, nodeName, index) {
  const owner = `${department}负责人`;
  if (index === 0) return [owner, "直属负责人"];
  if (template.category === "财务行政") return nodeName.includes("付款") ? ["出纳", "财务负责人"] : ["财务负责人", "财务专员"];
  if (template.category === "组织人事") return ["人事负责人", "HRBP"];
  if (template.category === "行政资产") return ["行政资产管理员", owner];
  if (template.category === "假勤") return ["人事专员", owner];
  return [owner];
}

export function makeDepartmentApprovalRules(departments = []) {
  const fallbackDepartments = ["行政部", "人力资源部", "财务中心", "直播事业部", "采购部", "仓储部"];
  const uniqueDepartments = [...new Set([...departments, ...fallbackDepartments])]
    .filter(Boolean);
  return uniqueDepartments.flatMap((department) => flowTemplates.map((template) => ({
    id: `RULE-${department}-${template.id}`,
    department,
    templateId: template.id,
    templateName: template.name,
    enabled: true,
    updatedAt: "2026-05-29 09:00:00",
    nodes: (template.nodes || [])
      .filter((node) => !node.includes("申请人提交") && !node.includes("归档"))
      .map((node, index) => ({
        id: `${template.id}-${index + 1}`,
        name: node,
        mode: "AND",
        approvers: approversFor(template, department, node, index)
      }))
  })));
}

export function makeInitialApprovals() {
  return Array.from({ length: 18 }, (_, index) => {
    const template = flowTemplates[index % flowTemplates.length];
    const round = Math.floor(index / flowTemplates.length);
    const formData = formDefaults(template);
    const nodeIndex = index === 3 ? 2 : 1;
    return {
      ...template,
      id: `FLOW-${index + 1}`,
      definitionId: template.id,
      definitionCode: template.serviceKey,
      title: round ? `${template.name} ${round + 1}` : template.name,
      applicant: template.owner,
      status: index === 1 ? "待付款" : index === 3 ? "已超时" : "待审批",
      formData,
      currentNodeIndex: nodeIndex,
      submittedAt: `2026-05-${String(20 + (index % 9)).padStart(2, "0")} ${String(9 + (index % 10)).padStart(2, "0")}:30`,
      dueAt: `2026-05-${String(21 + (index % 9)).padStart(2, "0")} ${String(15 + (index % 5)).padStart(2, "0")}:30`,
      steps: template.nodes,
      approvers: ["直属负责人", template.node, "系统归档"],
      comments: index % 4 === 0 ? [{ id: `CMT-${index}`, author: "直属负责人", time: "2026-05-29 10:10:00", content: "请补充业务背景，财务复核前确认预算口径。" }] : [],
      timeline: [
        { id: `TL-${index}-1`, time: `2026-05-${String(20 + (index % 9)).padStart(2, "0")} 09:30`, actor: template.owner, action: "提交申请", node: "申请人提交" },
        { id: `TL-${index}-2`, time: `2026-05-${String(20 + (index % 9)).padStart(2, "0")} 10:00`, actor: "系统", action: "创建审批任务", node: template.nodes?.[nodeIndex] || template.node }
      ]
    };
  });
}

export function assetPrefix(category) {
  if (category.includes("直播")) return "LIVE";
  if (category.includes("电脑") || category.includes("IT")) return "IT";
  return "ADM";
}

export function nextAssetId(category, assets) {
  const prefix = assetPrefix(category);
  const year = new Date().getFullYear();
  const maxNo = assets.reduce((max, item) => {
    const match = String(item.id).match(new RegExp(`^${prefix}-${year}-(\\d+)$`));
    return match ? Math.max(max, Number(match[1])) : max;
  }, 0);
  return `${prefix}-${year}-${String(maxNo + 1).padStart(6, "0")}`;
}
