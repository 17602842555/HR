export const initialAssets = [
  { id: "IT-2024-000123", name: "联想 ThinkPad X1 Carbon", category: "办公电脑", owner: "张三", status: "借用中", location: "集团总部 · 行政部", qrVersion: 1 },
  { id: "LIVE-2024-000088", name: "索尼直播相机 A7M4", category: "直播设备", owner: "直播间A", status: "使用中", location: "三楼直播间", qrVersion: 1 },
  { id: "LIVE-2024-000120", name: "神牛补光灯 SL150", category: "直播设备", owner: "设备库", status: "空闲", location: "三楼设备库", qrVersion: 1 },
  { id: "ADM-2023-000061", name: "会议平板 75寸", category: "会议设备", owner: "二号会议室", status: "固定资产", location: "二号会议室", qrVersion: 1 },
  { id: "IT-2025-000018", name: "MacBook Pro 14", category: "办公电脑", owner: "剪辑组", status: "维修中", location: "IT维修区", qrVersion: 2 }
];

export const assetEventSeed = [
  { id: "AE-1", assetId: "IT-2024-000123", time: "2026-05-28 11:20:00", type: "借用", operator: "张三", content: "借用给行政部，预计 7 天后归还" },
  { id: "AE-2", assetId: "LIVE-2024-000088", time: "2026-05-27 15:18:00", type: "领用", operator: "直播间A", content: "固定用于三楼直播间" },
  { id: "AE-3", assetId: "IT-2025-000018", time: "2026-05-26 09:12:00", type: "维修", operator: "IT服务台", content: "电池健康异常，进入维修区" }
];

export const resourceSeed = [
  { type: "会议室", name: "一号会议室", capacity: "10人", slots: [3, 2, 0, 4, 0, 1, 0], total: 4 },
  { type: "会议室", name: "二号会议室", capacity: "20人", slots: [5, 0, 2, 0, 0, 3, 1], total: 8 },
  { type: "车辆", name: "商务车A", capacity: "7座", slots: [1, 0, 2, 0, 0, 1, 0], total: 2 },
  { type: "工位", name: "直播一区", capacity: "12位", slots: [8, 9, 0, 12, 0, 7, 0], total: 12 },
  { type: "设备", name: "补光灯组", capacity: "8套", slots: [5, 0, 2, 0, 0, 3, 1], total: 8 }
];

export const resourceBookingSeed = [
  { id: "BOOK-1", resourceName: "一号会议室", type: "会议室", dayIndex: 0, period: "09:00-10:00", applicant: "张三", purpose: "周例会", status: "已预约" },
  { id: "BOOK-2", resourceName: "商务车A", type: "车辆", dayIndex: 2, period: "14:00-18:00", applicant: "王五", purpose: "供应商拜访", status: "已预约" }
];

export const attendanceRecordSeed = [
  { id: "ATT-1", employee: "张三", department: "行政部", workDate: "2026-05-29", checkIn: "2026-05-29 08:58", checkOut: "2026-05-29 18:05", status: "正常", minutesLate: 0, source: "门禁同步", reason: "" },
  { id: "ATT-2", employee: "李四", department: "人事部", workDate: "2026-05-29", checkIn: "2026-05-29 09:18", checkOut: "2026-05-29 18:10", status: "迟到", minutesLate: 18, source: "门禁同步", reason: "地铁延误" },
  { id: "ATT-3", employee: "王五", department: "财务中心", workDate: "2026-05-29", checkIn: "", checkOut: "2026-05-29 18:02", status: "缺卡", minutesLate: 0, source: "手动补录", reason: "早卡缺失" }
];

export const auditSeed = [
  { id: "AUD-1", time: "2026-05-29 09:45:12", operator: "张三", type: "更新", object: "员工档案", content: "更新了联系方式，敏感字段已脱敏", result: "成功", ip: "10.10.2.15" },
  { id: "AUD-2", time: "2026-05-29 09:30:21", operator: "李四", type: "新增", object: "员工入职", content: "新增员工入职信息", result: "成功", ip: "10.10.2.16" },
  { id: "AUD-3", time: "2026-05-29 09:12:05", operator: "王五", type: "提交审批", object: "办公用品申领", content: "提交办公用品申领单", result: "成功", ip: "10.10.2.17" }
];
