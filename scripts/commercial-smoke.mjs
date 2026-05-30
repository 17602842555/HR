import { writeCommercialEvidence } from "./commercial-evidence.mjs";

const baseUrl = (process.env.API_BASE_URL || "http://127.0.0.1:8787").replace(/\/+$/, "");
const tenantCode = process.env.DEFAULT_TENANT_CODE || "default";
const email = process.env.DEFAULT_ADMIN_EMAIL || "admin@oa.local";
const password = process.env.DEFAULT_ADMIN_PASSWORD || "admin123456";
const smokeRunId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const startedAt = new Date().toISOString();
const evidence = {};

function assert(condition, message, details = {}) {
  if (!condition) {
    const error = new Error(message);
    error.details = details;
    throw error;
  }
}

async function request(path, options = {}) {
  const { responseType, ...fetchOptions } = options;
  const response = await fetch(`${baseUrl}${path}`, {
    ...fetchOptions,
    headers: {
      accept: "application/json",
      ...(fetchOptions.body ? { "content-type": "application/json" } : {}),
      ...(fetchOptions.headers || {})
    },
    body: fetchOptions.body && typeof fetchOptions.body !== "string" ? JSON.stringify(fetchOptions.body) : fetchOptions.body
  });
  const text = await response.text();
  const contentType = response.headers.get("content-type") || "";
  const payload = text && contentType.includes("application/json") ? JSON.parse(text) : text || null;
  if (!response.ok) {
    const error = new Error(`${fetchOptions.method || "GET"} ${path} failed with ${response.status}`);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  if (responseType === "text") {
    return {
      headers: Object.fromEntries(response.headers),
      status: response.status,
      text: payload || ""
    };
  }
  return payload;
}

function authHeaders(token) {
  return { authorization: `Bearer ${token}` };
}

function findAuditLog(audit, predicate) {
  return (audit.auditLogs || []).find(predicate);
}

async function approveToTerminal(token, approvalId) {
  let latest = null;
  for (let index = 0; index < 10; index += 1) {
    const approvalsPayload = await request("/api/approvals", { headers: authHeaders(token) });
    latest = approvalsPayload.approvals.find((item) => item.id === approvalId);
    assert(latest, "Created approval disappeared", { approvalId });
    if (latest.status !== "待审批") return latest;

    const node = latest.approvalNodes[latest.currentNodeIndex];
    const nextDecision = node?.decisions?.find((item) => item.status === "待审批");
    assert(nextDecision, "Pending approval has no pending approver", { approvalId, node });
    await request(`/api/approvals/${encodeURIComponent(approvalId)}/decision`, {
      method: "POST",
      headers: authHeaders(token),
      body: {
        approverName: nextDecision.approver,
        decision: "pass",
        idempotencyKey: `smoke-${approvalId}-${index}-${Date.now()}`
      }
    });
  }
  throw new Error(`Approval did not reach terminal status: ${latest?.status || "unknown"}`);
}

async function transferFirstPendingApproval(token, approvalId) {
  const beforePayload = await request("/api/approvals", { headers: authHeaders(token) });
  const before = beforePayload.approvals.find((item) => item.id === approvalId);
  assert(before?.status === "待审批", "Approval is not pending before transfer check", before);
  const node = before.approvalNodes[before.currentNodeIndex];
  const source = node?.decisions?.find((item) => item.status === "待审批");
  assert(source, "Approval has no pending source approver to transfer", { approvalId, node });
  const target = `商业转交审批人-${Date.now()}`;

  await request(`/api/approvals/${encodeURIComponent(approvalId)}/transfer`, {
    method: "POST",
    headers: authHeaders(token),
    body: {
      sourceApproverName: source.approver,
      target,
      comment: "商业冒烟验证转交闭环"
    }
  });

  const afterPayload = await request("/api/approvals", { headers: authHeaders(token) });
  const after = afterPayload.approvals.find((item) => item.id === approvalId);
  const afterNode = after?.approvalNodes?.[after.currentNodeIndex];
  assert(
    afterNode?.decisions?.some((item) => item.approver === source.approver && item.status === "已转交"),
    "Transfer did not mark the source approver as transferred",
    { source, afterNode }
  );
  assert(
    afterNode?.decisions?.some((item) => item.approver === target && item.status === "待审批"),
    "Transfer did not create a replacement pending approver",
    { target, afterNode }
  );
  return { source: source.approver, target };
}

async function assertInvalidApproverDenied(token, approvalId) {
  const beforePayload = await request("/api/approvals", { headers: authHeaders(token) });
  const before = beforePayload.approvals.find((item) => item.id === approvalId);
  assert(before?.status === "待审批", "Approval is not pending before invalid approver check", before);

  try {
    await request(`/api/approvals/${encodeURIComponent(approvalId)}/decision`, {
      method: "POST",
      headers: authHeaders(token),
      body: {
        approverName: "商业冒烟非授权审批人",
        decision: "pass",
        idempotencyKey: `smoke-invalid-${approvalId}-${Date.now()}`
      }
    });
  } catch (error) {
    assert(error.status === 403 && error.payload?.error === "approver_not_assigned", "Invalid approver was not rejected", {
      status: error.status,
      payload: error.payload
    });
    const afterPayload = await request("/api/approvals", { headers: authHeaders(token) });
    const after = afterPayload.approvals.find((item) => item.id === approvalId);
    assert(after?.status === "待审批", "Invalid approver changed approval status", after);
    assert(
      JSON.stringify(after.approvalNodes) === JSON.stringify(before.approvalNodes),
      "Invalid approver changed approval node decisions",
      { before: before.approvalNodes, after: after.approvalNodes }
    );
    return;
  }
  throw new Error("Invalid approver unexpectedly approved workflow");
}

async function reserveFirstAvailableResource(token, resources) {
  const periods = ["09:00-10:00", "10:00-12:00", "14:00-16:00", "16:00-18:00", "19:00-21:00"];
  for (const resource of resources) {
    for (let dayIndex = 0; dayIndex < 7; dayIndex += 1) {
      if (resource.slots[dayIndex] >= resource.total) continue;
      for (const period of periods) {
        try {
          return await request("/api/resources/bookings", {
            method: "POST",
            headers: authHeaders(token),
            body: {
              resourceName: resource.name,
              dayIndex,
              period,
              purpose: `商业验收冒烟 ${Date.now()}`
            }
          });
        } catch (error) {
          if (error.status !== 409) throw error;
        }
      }
    }
  }
  throw new Error("No available resource slot for smoke booking");
}

async function assertBookingConflict(token, booking) {
  try {
    await request("/api/resources/bookings", {
      method: "POST",
      headers: authHeaders(token),
      body: {
        resourceName: booking.resourceName,
        dayIndex: booking.dayIndex,
        period: booking.period,
        purpose: `重复预约冲突 ${Date.now()}`
      }
    });
  } catch (error) {
    assert(error.status === 409, "Duplicate resource booking did not return conflict", {
      status: error.status,
      payload: error.payload
    });
    return;
  }
  throw new Error("Duplicate resource booking unexpectedly succeeded");
}

async function assertInvalidAssetTransition(token, assetId) {
  try {
    await request(`/api/assets/${encodeURIComponent(assetId)}/actions`, {
      method: "POST",
      headers: authHeaders(token),
      body: { action: "borrow", owner: "重复借用人" }
    });
  } catch (error) {
    assert(error.status === 409 && error.payload?.error === "invalid_asset_transition", "Duplicate asset borrow did not return invalid transition", {
      status: error.status,
      payload: error.payload
    });
    return;
  }
  throw new Error("Duplicate asset borrow unexpectedly succeeded");
}

async function main() {
  const health = await request("/health");
  assert(health.ok, "Health endpoint did not return ok", health);
  evidence.health = health;
  const ready = await request("/ready");
  assert(ready.ok && ready.database === "ok" && ready.fileStorage === "ok", "Readiness endpoint did not confirm database and file storage", ready);
  evidence.ready = ready;

  const login = await request("/api/auth/login", {
    method: "POST",
    body: { tenantCode, email, password }
  });
  assert(login.token, "Login did not return token");
  const token = login.token;
  evidence.loginUser = login.user?.email || email;

  const me = await request("/api/auth/me", { headers: authHeaders(token) });
  assert(me.user?.email === email, "Session user mismatch", me);
  const currentUserName = me.user.name || me.user.email || email;
  evidence.currentUserName = currentUserName;

  const systemReadiness = await request("/api/system/readiness", { headers: authHeaders(token) });
  assert(systemReadiness.systemReadiness?.dependencies?.database === "ok", "System readiness database dependency is not green", systemReadiness);
  assert(systemReadiness.systemReadiness?.dependencies?.fileStorage === "ok", "System readiness file storage dependency is not green", systemReadiness);
  assert(Array.isArray(systemReadiness.systemReadiness?.knownGaps), "System readiness did not return known gap list", systemReadiness);
  assert(systemReadiness.systemReadiness?.hrDataReview?.releaseEvidence === false, "System readiness HR review package summary must stay non-release evidence", systemReadiness);
  assert(typeof systemReadiness.systemReadiness?.hrDataReview?.noSensitiveFields === "boolean", "System readiness did not return HR review safety summary", systemReadiness);
  assert(systemReadiness.systemReadiness?.signoffDrafts?.releaseEvidence === false, "System readiness signoff draft summary must stay non-release evidence", systemReadiness);
  assert(Array.isArray(systemReadiness.systemReadiness?.signoffDrafts?.kinds), "System readiness did not return signoff draft summary", systemReadiness);
  assert(systemReadiness.systemReadiness?.gapActionReport?.releaseEvidence === false, "System readiness GAP action summary must stay non-release evidence", systemReadiness);
  assert(Array.isArray(systemReadiness.systemReadiness?.gapActionReport?.owners), "System readiness did not return GAP owner handoff summary", systemReadiness);
  assert(typeof systemReadiness.systemReadiness?.latestEvidence?.releaseEvidence === "boolean", "System readiness did not return latest evidence release flag", systemReadiness);
  assert(typeof systemReadiness.systemReadiness?.latestEvidence?.releaseCandidateReady === "boolean", "System readiness did not return latest evidence release candidate flag", systemReadiness);
  assert(typeof systemReadiness.systemReadiness?.latestEvidence?.releaseBlockerCount === "number", "System readiness did not return latest evidence release blocker count", systemReadiness);
  assert(typeof systemReadiness.systemReadiness?.latestEvidence?.e2eIncluded === "boolean", "System readiness did not return latest evidence E2E inclusion flag", systemReadiness);
  assert(typeof systemReadiness.systemReadiness?.latestEvidence?.evidenceMode === "string", "System readiness did not return latest evidence mode", systemReadiness);
  assert(Array.isArray(systemReadiness.systemReadiness?.latestEvidence?.checks), "System readiness did not return latest evidence check summary", systemReadiness);
  assert(typeof systemReadiness.systemReadiness?.latestEvidence?.targetProfile?.evidenceClass === "string", "System readiness did not return latest evidence target profile", systemReadiness);
  assert(
    !JSON.stringify(systemReadiness).includes(password),
    "System readiness leaked a runtime secret",
    { readiness: systemReadiness.systemReadiness }
  );
  assert(
    !/reports\/commercial-evidence|latest\.json|latest-gap-report|signoff-drafts|hr-data-review|people-review|summary\.json|manifest\.json|\.draft\.json|postgres(?:ql)?:\/\/|DATABASE_URL/.test(JSON.stringify(systemReadiness.systemReadiness)),
    "System readiness leaked signoff, HR review, GAP report, or latest evidence private details",
    { readiness: systemReadiness.systemReadiness }
  );
  evidence.systemReadiness = {
    releaseReady: systemReadiness.systemReadiness.releaseGate.releaseReady,
    openGapCount: systemReadiness.systemReadiness.releaseGate.openGapCount,
    signoffDrafts: {
      available: systemReadiness.systemReadiness.signoffDrafts.available,
      draftCount: systemReadiness.systemReadiness.signoffDrafts.draftCount,
      openExceptionCount: systemReadiness.systemReadiness.signoffDrafts.openExceptionCount,
      pendingApprovalCount: systemReadiness.systemReadiness.signoffDrafts.pendingApprovalCount
    },
    hrDataReview: {
      available: systemReadiness.systemReadiness.hrDataReview.available,
      noSensitiveFields: systemReadiness.systemReadiness.hrDataReview.noSensitiveFields,
      rowCount: systemReadiness.systemReadiness.hrDataReview.rowCount
    },
    gapActionReport: {
      available: systemReadiness.systemReadiness.gapActionReport.available,
      blockedGapCount: systemReadiness.systemReadiness.gapActionReport.blockedGapCount,
      ownerCount: systemReadiness.systemReadiness.gapActionReport.ownerCount
    },
    latestEvidence: {
      available: systemReadiness.systemReadiness.latestEvidence.available,
      e2eIncluded: systemReadiness.systemReadiness.latestEvidence.e2eIncluded,
      evidenceMode: systemReadiness.systemReadiness.latestEvidence.evidenceMode,
      releaseBlockerCount: systemReadiness.systemReadiness.latestEvidence.releaseBlockerCount,
      releaseCandidateReady: systemReadiness.systemReadiness.latestEvidence.releaseCandidateReady,
      releaseEvidence: systemReadiness.systemReadiness.latestEvidence.releaseEvidence,
      status: systemReadiness.systemReadiness.latestEvidence.status,
      warningCheckCount: systemReadiness.systemReadiness.latestEvidence.warningCheckCount
    }
  };

  const people = await request("/api/people", { headers: authHeaders(token) });
  assert(people.people?.employees?.length >= 72, "Expected imported active employees", people.people);
  assert(people.people?.leavers?.length >= 162, "Expected imported leavers", people.people);
  const employeeForMaintenance = people.people.employees[0];
  assert(employeeForMaintenance?.id, "No employee available for maintenance smoke check", people.people);
  const maskedEmployee = people.people.employees.find((item) => (
    String(item.school || "").includes("***")
    || String(item.major || "").includes("***")
    || String(item.hukou || "").includes("***")
  ));
  assert(maskedEmployee, "Employee sensitive fields should be masked by default when source values exist", people.people.employees.slice(0, 5));
  evidence.people = {
    employees: people.people.employees.length,
    leavers: people.people.leavers.length,
    femaleEmployees: people.people.femaleEmployees.length,
    monthLeavers: people.people.monthLeavers.length
  };

  const smokeRole = `商业冒烟岗位-${Date.now()}`;
  const updatedEmployee = await request(`/api/people/employees/${encodeURIComponent(employeeForMaintenance.id)}`, {
    method: "PATCH",
    headers: authHeaders(token),
    body: {
      department: employeeForMaintenance.department,
      role: smokeRole
    }
  });
  assert(updatedEmployee.employee?.role === smokeRole, "Employee maintenance did not return updated role", updatedEmployee);
  const peopleAfterEmployeeUpdate = await request("/api/people", { headers: authHeaders(token) });
  const maintainedEmployee = peopleAfterEmployeeUpdate.people?.employees?.find((item) => item.id === employeeForMaintenance.id);
  assert(maintainedEmployee?.role === smokeRole, "Employee maintenance was not persisted", {
    employeeId: employeeForMaintenance.id,
    maintainedEmployee
  });
  evidence.employeeMaintenance = {
    employeeId: employeeForMaintenance.id,
    employeeName: employeeForMaintenance.name,
    role: smokeRole
  };

  const analytics = await request("/api/analytics/overview", { headers: authHeaders(token) });
  assert(analytics.analytics?.cards?.totalPeople >= 234, "Analytics did not include imported people totals", analytics);
  assert(Array.isArray(analytics.analytics.peopleByDepartment) && analytics.analytics.peopleByDepartment.length > 0, "Analytics people distribution missing", analytics);
  assert(Array.isArray(analytics.analytics.assetByStatus), "Analytics asset status breakdown missing", analytics);
  const analyticsExport = await request("/api/analytics/export", {
    body: { businessReason: "商业冒烟管理复盘", scope: "管理看板快照" },
    headers: authHeaders(token),
    method: "POST",
    responseType: "text"
  });
  assert(String(analyticsExport.headers["content-type"] || "").includes("text/csv"), "Analytics export content-type missing", analyticsExport);
  assert(String(analyticsExport.headers["content-disposition"] || "").includes("analytics-snapshot-"), "Analytics export content-disposition header missing", analyticsExport);
  assert(String(analyticsExport.text || "").includes("人员总量"), "Analytics export body missing overview rows", analyticsExport);
  evidence.analytics = {
    totalPeople: analytics.analytics.cards.totalPeople,
    pendingApprovals: analytics.analytics.cards.pendingApprovals,
    assetUseRate: analytics.analytics.cards.assetUseRate,
    exportRows: Number(analyticsExport.headers["x-row-count"] || 0)
  };

  const imports = await request("/api/imports", { headers: authHeaders(token) });
  const dashboardImport = imports.importRuns?.find((run) => (
    run.sourceName === "oa-dashboard.html"
    && Number(run.recordCounts?.totalRows || 0) >= 234
  ));
  assert(dashboardImport, "Dashboard import source record missing", imports);
  assert(dashboardImport.sourceChecksum?.length >= 32, "Dashboard import checksum missing", dashboardImport);
  assert(dashboardImport.recordCounts?.totalRows >= 234, "Dashboard import row count missing", dashboardImport);
  evidence.importRun = {
    sourceName: dashboardImport.sourceName,
    totalRows: dashboardImport.recordCounts.totalRows
  };

  const runtimeImportHtml = `
    <section>
      <h2>在职员工详细信息</h2>
      <table>
        <thead><tr><th>序号</th><th>组织</th><th>姓名</th><th>性别</th><th>部门</th><th>岗位</th><th>入职日期</th><th>转正日期</th><th>年龄</th><th>户口</th><th>学历</th><th>学校</th><th>专业</th></tr></thead>
        <tbody><tr><td>9900</td><td>集团总部</td><td>商业冒烟导入员工-${smokeRunId}</td><td>女</td><td>商业冒烟导入部</td><td>导入验证岗</td><td>2026-05-29</td><td>2026-06-29</td><td>27.0</td><td>广东/城镇</td><td>本科</td><td>商业大学</td><td>行政管理</td></tr></tbody>
      </table>
    </section>`;
  const runtimeImport = await request("/api/imports/dashboard-html", {
    method: "POST",
    headers: authHeaders(token),
    body: {
      sourceName: `commercial-smoke-dashboard-${smokeRunId}.html`,
      html: runtimeImportHtml
    }
  });
  assert(runtimeImport.people?.totalRows === 1, "Runtime dashboard import did not count rows", runtimeImport);
  assert(runtimeImport.importRun?.metadata?.sourceArtifact?.downloadAvailable === true, "Runtime dashboard import did not preserve source artifact", runtimeImport);
  assert(!runtimeImport.importRun?.metadata?.sourceArtifact?.storageKey, "Runtime dashboard import leaked source storage key", runtimeImport.importRun?.metadata);
  const runtimeSourceDownload = await request(`/api/imports/${encodeURIComponent(runtimeImport.importRun.id)}/source`, {
    headers: authHeaders(token),
    responseType: "text"
  });
  assert(String(runtimeSourceDownload.headers["content-type"] || "").includes("application/octet-stream"), "Runtime source download content-type missing", runtimeSourceDownload);
  assert(String(runtimeSourceDownload.headers["content-disposition"] || "").includes(".html"), "Runtime source download filename missing", runtimeSourceDownload);
  assert(String(runtimeSourceDownload.text || "").includes(`商业冒烟导入员工-${smokeRunId}`), "Runtime source download body did not match imported HTML", runtimeSourceDownload);
  const peopleAfterRuntimeImport = await request("/api/people", { headers: authHeaders(token) });
  assert(
    peopleAfterRuntimeImport.people?.employees?.some((item) => item.name === `商业冒烟导入员工-${smokeRunId}` && item.department === "商业冒烟导入部"),
    "Runtime dashboard import did not persist imported employee",
    peopleAfterRuntimeImport.people
  );
  evidence.runtimeImport = {
    artifactDownloadable: runtimeImport.importRun.metadata.sourceArtifact.downloadAvailable,
    sourceName: runtimeImport.importRun.sourceName,
    totalRows: runtimeImport.people.totalRows
  };
  try {
    await request("/api/imports/dashboard-html", {
      method: "POST",
      headers: authHeaders(token),
      body: {
        sourceName: `commercial-smoke-empty-${smokeRunId}.html`,
        html: "<section><h2>空导入</h2><table><tbody></tbody></table></section>"
      }
    });
  } catch (error) {
    assert(error.status === 400 && error.payload?.error === "dashboard_import_empty", "Empty dashboard import was not rejected", {
      status: error.status,
      payload: error.payload
    });
    evidence.emptyImportRejected = true;
  }
  assert(evidence.emptyImportRejected, "Empty dashboard import unexpectedly succeeded");

  const leaves = await request("/api/attendance/leaves?limit=500", { headers: authHeaders(token) });
  assert(Array.isArray(leaves.leaves), "Leave list did not return records", leaves);
  const attendanceRecords = await request("/api/attendance/records?limit=500", { headers: authHeaders(token) });
  assert(Array.isArray(attendanceRecords.attendanceRecords), "Attendance record list did not return records", attendanceRecords);
  const createdAttendanceRecord = await request("/api/attendance/records", {
    method: "POST",
    headers: authHeaders(token),
    body: {
      employee: "商业冒烟员工",
      department: "行政部",
      workDate: "2026-06-15",
      checkIn: "2026-06-15 09:16",
      checkOut: "2026-06-15 18:03",
      status: "迟到",
      minutesLate: 16,
      reason: "商业冒烟补录"
    }
  });
  assert(createdAttendanceRecord.attendanceRecord?.status === "迟到", "Attendance record create did not persist status", createdAttendanceRecord);
  assert(createdAttendanceRecord.attendanceRecord?.minutesLate === 16, "Attendance record create did not persist late minutes", createdAttendanceRecord);
  const attendanceRecordExport = await request("/api/attendance/records/export", {
    method: "POST",
    responseType: "text",
    headers: authHeaders(token),
    body: {
      scope: "考勤记录台账",
      businessReason: "商业冒烟考勤核对",
      filters: { status: "迟到" }
    }
  });
  assert(attendanceRecordExport.headers["content-type"]?.includes("text/csv"), "Attendance record export did not return CSV", attendanceRecordExport.headers);
  assert(attendanceRecordExport.headers["content-disposition"]?.includes("attendance-record-export-"), "Attendance record export content-disposition header missing", attendanceRecordExport.headers);
  assert(attendanceRecordExport.text.includes("商业冒烟员工"), "Attendance record export CSV did not include created record", attendanceRecordExport.text.slice(0, 500));
  const leaveIdempotencyKey = `commercial-smoke-leave-submit-${smokeRunId}`;
  const createdLeave = await request("/api/attendance/leaves", {
    method: "POST",
    headers: authHeaders(token),
    body: {
      employee: "商业冒烟员工",
      type: "年假",
      dates: `2026-06-${String((Date.now() % 20) + 1).padStart(2, "0")}`,
      days: 1,
      handover: "张三",
      idempotencyKey: leaveIdempotencyKey
    }
  });
  assert(createdLeave.leave?.status === "待审批", "Leave creation did not return pending status", createdLeave);
  assert(createdLeave.leave?.workflowInstanceId, "Leave creation did not create a workflow instance", createdLeave);
  const repeatedLeave = await request("/api/attendance/leaves", {
    method: "POST",
    headers: authHeaders(token),
    body: {
      employee: "不应创建的重复请假员工",
      type: "病假",
      dates: "2026-07-01",
      days: 3,
      handover: "不应保存",
      idempotencyKey: leaveIdempotencyKey
    }
  });
  assert(repeatedLeave.alreadySubmitted === true, "Repeated leave submit did not return idempotent replay flag", repeatedLeave);
  assert(repeatedLeave.leave?.id === createdLeave.leave.id, "Repeated leave submit returned a different leave request", {
    created: createdLeave.leave,
    repeated: repeatedLeave.leave
  });
  assert(repeatedLeave.leave?.workflowInstanceId === createdLeave.leave.workflowInstanceId, "Repeated leave submit returned a different workflow instance", {
    created: createdLeave.leave,
    repeated: repeatedLeave.leave
  });
  assert(repeatedLeave.leave?.employee === "商业冒烟员工", "Repeated leave submit mutated the original leave payload", repeatedLeave.leave);
  const leavesAfterIdempotencyReplay = await request("/api/attendance/leaves?limit=500", { headers: authHeaders(token) });
  assert(
    leavesAfterIdempotencyReplay.leaves.length === leaves.leaves.length + 1,
    "Repeated leave submit created a duplicate leave request",
    { before: leaves.leaves.length, after: leavesAfterIdempotencyReplay.leaves.length }
  );
  const approvalsAfterLeave = await request("/api/approvals", { headers: authHeaders(token) });
  const leaveWorkflow = approvalsAfterLeave.approvals?.find((item) => item.id === createdLeave.leave.workflowInstanceId);
  assert(leaveWorkflow?.formData?.applicant === currentUserName, "Leave workflow applicant did not use authenticated user", {
    expected: currentUserName,
    workflow: leaveWorkflow
  });
  evidence.attendance = {
    records: attendanceRecords.attendanceRecords.length + 1,
    leaves: leavesAfterIdempotencyReplay.leaves.length,
    attendanceRecordId: createdAttendanceRecord.attendanceRecord.id,
    created: createdLeave.leave.id,
    workflowInstanceId: createdLeave.leave.workflowInstanceId,
    idempotentReplay: repeatedLeave.alreadySubmitted === true
  };

  const financeRequests = await request("/api/finance/requests", { headers: authHeaders(token) });
  assert(financeRequests.financeRequests?.length > 0, "No finance requests returned", financeRequests);
  const financeRequestNo = `EXP-SMOKE-${smokeRunId}`;
  const financeRequestIdempotencyKey = `commercial-smoke-finance-request-${smokeRunId}`;
  const createdFinanceRequest = await request("/api/finance/requests", {
    method: "POST",
    headers: authHeaders(token),
    body: {
      requestNo: financeRequestNo,
      type: "EXPENSE",
      title: `商业冒烟费用报销单 ${smokeRunId}`,
      department: "行政部",
      amount: 3290,
      vendor: "商旅平台",
      paymentMethod: "员工垫付",
      purpose: "商业冒烟差旅报销",
      idempotencyKey: financeRequestIdempotencyKey
    }
  });
  assert(createdFinanceRequest.financeRequest?.id === financeRequestNo, "Finance request creation did not return requested number", createdFinanceRequest);
  assert(createdFinanceRequest.financeRequest?.workflowInstanceId, "Finance request did not create a workflow instance", createdFinanceRequest);
  assert(createdFinanceRequest.financeRequest?.status === "待审批", "Finance request did not return pending status", createdFinanceRequest);
  const repeatedFinanceRequest = await request("/api/finance/requests", {
    method: "POST",
    headers: authHeaders(token),
    body: {
      requestNo: `${financeRequestNo}-RETRY`,
      type: "EXPENSE",
      title: "不应创建的重复费用报销单",
      department: "行政部",
      amount: 1,
      idempotencyKey: financeRequestIdempotencyKey
    }
  });
  assert(repeatedFinanceRequest.alreadySubmitted === true, "Repeated finance request submit did not return idempotent replay flag", repeatedFinanceRequest);
  assert(repeatedFinanceRequest.financeRequest?.id === financeRequestNo, "Repeated finance request submit returned a different request", {
    created: createdFinanceRequest.financeRequest,
    repeated: repeatedFinanceRequest.financeRequest
  });
  const financeRequestExport = await request("/api/finance/requests/export", {
    method: "POST",
    headers: authHeaders(token),
    responseType: "text",
    body: {
      scope: "财务单据台账",
      businessReason: "商业冒烟财务复核",
      filters: { type: "EXPENSE" }
    }
  });
  assert(financeRequestExport.headers["content-type"]?.includes("text/csv"), "Finance request export did not return CSV", financeRequestExport.headers);
  assert(financeRequestExport.headers["content-disposition"]?.includes("finance-request-export-"), "Finance request export content-disposition header missing", financeRequestExport.headers);
  assert(financeRequestExport.text.includes(financeRequestNo), "Finance request export CSV did not include created request", financeRequestExport.text.slice(0, 500));

  const payrolls = await request("/api/finance/payrolls", { headers: authHeaders(token) });
  assert(payrolls.payrolls?.length > 0, "No payroll batches returned", payrolls);
  const mayPayroll = payrolls.payrolls.find((item) => item.id === "PAYROLL-202605");
  assert(mayPayroll?.workflowInstanceId && mayPayroll?.workflowStatus === "APPROVED", "Payroll batch is not linked to an approved workflow", mayPayroll);
  const newPayrollBatchNo = `PAYROLL-SMOKE-${smokeRunId}`;
  const payrollIdempotencyKey = `commercial-smoke-payroll-submit-${smokeRunId}`;
  const createdPayroll = await request("/api/finance/payrolls", {
    method: "POST",
    headers: authHeaders(token),
    body: {
      batchNo: newPayrollBatchNo,
      cycle: "2026年6月",
      scope: "商业冒烟工资范围",
      owner: "财务中心",
      department: "财务中心",
      headcount: 72,
      totalAmount: 680000,
      comment: "商业冒烟创建工资单",
      idempotencyKey: payrollIdempotencyKey
    }
  });
  assert(createdPayroll.payroll?.id === newPayrollBatchNo, "Payroll creation did not return the requested batch", createdPayroll);
  assert(createdPayroll.payroll?.status === "待复核", "Payroll creation did not return pending review status", createdPayroll);
  assert(createdPayroll.payroll?.workflowInstanceId, "Payroll creation did not create a workflow instance", createdPayroll);
  assert(createdPayroll.payroll?.workflowStatus === "PENDING", "Payroll creation did not link a pending workflow", createdPayroll);
  const repeatedPayroll = await request("/api/finance/payrolls", {
    method: "POST",
    headers: authHeaders(token),
    body: {
      batchNo: `${newPayrollBatchNo}-RETRY`,
      cycle: "不应创建的重复工资周期",
      scope: "不应创建",
      headcount: 1,
      totalAmount: 1,
      idempotencyKey: payrollIdempotencyKey
    }
  });
  assert(repeatedPayroll.alreadySubmitted === true, "Repeated payroll submit did not return idempotent replay flag", repeatedPayroll);
  assert(repeatedPayroll.payroll?.id === newPayrollBatchNo, "Repeated payroll submit returned a different payroll batch", {
    created: createdPayroll.payroll,
    repeated: repeatedPayroll.payroll
  });
  try {
    await request(`/api/finance/payrolls/${encodeURIComponent(newPayrollBatchNo)}/review`, {
      method: "POST",
      headers: authHeaders(token),
      body: { comment: "审批未全部通过前不允许发布" }
    });
    throw new Error("Unapproved payroll publish unexpectedly succeeded");
  } catch (error) {
    assert(error.status === 409 && error.payload?.error === "payroll_workflow_not_approved", "Unapproved payroll publish did not return workflow_not_approved", {
      status: error.status,
      payload: error.payload
    });
  }
  const reviewedPayroll = await request("/api/finance/payrolls/PAYROLL-202605/review", {
    method: "POST",
    headers: authHeaders(token),
    body: { comment: "商业冒烟复核" }
  });
  assert(reviewedPayroll.payroll?.status === "已发布", "Payroll review did not publish the batch", reviewedPayroll);
  assert(reviewedPayroll.payroll?.reviewer === currentUserName, "Payroll reviewer did not use authenticated user", {
    expected: currentUserName,
    payroll: reviewedPayroll.payroll
  });
  try {
    await request("/api/finance/payrolls/PAYROLL-202604/review", {
      method: "POST",
      headers: authHeaders(token),
      body: { comment: "归档批次负向校验" }
    });
    throw new Error("Archived payroll review unexpectedly succeeded");
  } catch (error) {
    assert(error.status === 409 && error.payload?.error === "invalid_payroll_status", "Archived payroll review did not return invalid status", {
      status: error.status,
      payload: error.payload
    });
  }
  evidence.finance = {
    financeRequests: financeRequests.financeRequests.length + 1,
    financeRequestNo,
    financeRequestWorkflowInstanceId: createdFinanceRequest.financeRequest.workflowInstanceId,
    financeRequestIdempotentReplay: repeatedFinanceRequest.alreadySubmitted === true,
    payrolls: payrolls.payrolls.length,
    created: createdPayroll.payroll.id,
    createdWorkflowInstanceId: createdPayroll.payroll.workflowInstanceId,
    idempotentReplay: repeatedPayroll.alreadySubmitted === true,
    reviewed: reviewedPayroll.payroll.id,
    workflowInstanceId: reviewedPayroll.payroll.workflowInstanceId
  };

  const rules = await request("/api/approvals/rules", { headers: authHeaders(token) });
  assert(rules.approvalRules?.length > 0, "No approval rules returned");
  const smokeRule = await request("/api/approvals/rules", {
    method: "POST",
    headers: authHeaders(token),
    body: {
      department: `商业冒烟部门-${Date.now()}`,
      templateId: "expense",
      templateName: "费用报销",
      nodes: [
        { id: "manager", name: "部门负责人会签", approvers: ["商业主管A", "商业主管B"] },
        { id: "finance", name: "财务复核", approvers: "财务负责人，出纳" }
      ]
    }
  });
  assert(smokeRule.id, "Approval rule create did not return an id", smokeRule);
  assert(smokeRule.nodes?.[0]?.mode === "AND", "Approval rule did not normalize node mode to AND", smokeRule);
  const activeRulePreview = await request(`/api/approvals/rules/preview?department=${encodeURIComponent(smokeRule.department)}&templateId=expense`, {
    headers: authHeaders(token)
  });
  assert(activeRulePreview.preview?.source === "department_rule", "Approval rule preview did not use active department rule", activeRulePreview);
  assert(activeRulePreview.preview?.nodes?.[0]?.approvers?.includes("商业主管A"), "Approval rule preview missing active approver", activeRulePreview);
  const ruleCoverage = await request("/api/approvals/rules/coverage", { headers: authHeaders(token) });
  const smokeCoverageRow = ruleCoverage.approvalRuleCoverage?.rows?.find((row) => (
    row.department === smokeRule.department && row.templateId === "expense"
  ));
  assert(smokeCoverageRow?.source === "department_rule", "Approval rule coverage did not include the saved department rule", ruleCoverage);
  assert(smokeCoverageRow?.status === "needs_binding", "Approval rule coverage did not flag unresolved smoke approvers", smokeCoverageRow);
  assert(smokeCoverageRow?.unresolvedApprovers?.includes("商业主管A"), "Approval rule coverage missing unresolved approver details", smokeCoverageRow);

  await request(`/api/approvals/rules/${encodeURIComponent(smokeRule.id)}`, {
    method: "PUT",
    headers: authHeaders(token),
    body: {
      ...smokeRule,
      enabled: false,
      nodes: [{ id: "disabled", name: "停用后不应出现", approvers: ["停用审批人"] }]
    }
  });
  const disabledRulePreview = await request(`/api/approvals/rules/preview?department=${encodeURIComponent(smokeRule.department)}&templateId=expense`, {
    headers: authHeaders(token)
  });
  assert(disabledRulePreview.preview?.source === "workflow_definition", "Disabled approval rule was still used by preview", disabledRulePreview);
  assert(
    !disabledRulePreview.preview?.nodes?.some((node) => node.approvers?.includes("停用审批人")),
    "Disabled approval rule approver leaked into preview",
    disabledRulePreview
  );
  const disabledRuleCoverage = await request("/api/approvals/rules/coverage", { headers: authHeaders(token) });
  const disabledCoverageRow = disabledRuleCoverage.approvalRuleCoverage?.rows?.find((row) => (
    row.department === smokeRule.department && row.templateId === "expense"
  ));
  assert(disabledCoverageRow?.source === "workflow_definition", "Disabled approval rule coverage did not fall back to workflow definition", disabledCoverageRow);
  assert(disabledCoverageRow?.disabledRuleId === smokeRule.id, "Disabled approval rule coverage did not retain disabled rule reference", disabledCoverageRow);
  await request(`/api/approvals/rules/${encodeURIComponent(smokeRule.id)}`, {
    method: "DELETE",
    headers: authHeaders(token)
  });
  const rulesAfterDelete = await request("/api/approvals/rules", { headers: authHeaders(token) });
  assert(
    !rulesAfterDelete.approvalRules?.some((item) => item.id === smokeRule.id),
    "Deleted approval rule still returned",
    rulesAfterDelete
  );
  evidence.approvalRules = {
    total: rules.approvalRules.length,
    coverageCells: ruleCoverage.approvalRuleCoverage?.summary?.totalCells || 0,
    crud: "create-preview-disable-delete-ok"
  };

  const definitions = await request("/api/approvals/definitions", { headers: authHeaders(token) });
  const requiredLifecycleCodes = ["HR-ONBOARD", "HR-REGULAR", "HR-TRANSFER", "HR-OFFBOARD", "HR-EXCEPTION", "HR-SALARY"];
  for (const code of requiredLifecycleCodes) {
    assert(definitions.workflowDefinitions?.some((item) => item.code === code), `HR lifecycle definition missing: ${code}`, definitions);
  }
  const transferRule = rules.approvalRules.find((item) => item.templateId === "transfer") || rules.approvalRules[0];
  const transferWorkflow = await request("/api/approvals", {
    method: "POST",
    headers: authHeaders(token),
    body: {
      definitionId: "transfer",
      title: `商业冒烟调岗申请 ${Date.now()}`,
      applicant: "张三",
      department: transferRule.department,
      formData: {
        employee: "周八",
        fromDepartment: "直播事业部",
        toDepartment: "运营中心",
        effectiveDate: "2026-06-10"
      }
    }
  });
  assert(transferWorkflow.approval?.definitionCode === "HR-TRANSFER", "HR transfer workflow did not use lifecycle definition", transferWorkflow);
  assert(transferWorkflow.approval?.approvalNodes?.length >= 2, "HR transfer workflow did not create approval nodes", transferWorkflow);
  const onboardingEmployeeName = `商业冒烟入职-${smokeRunId}`;
  const onboardingWorkflow = await request("/api/approvals", {
    method: "POST",
    headers: authHeaders(token),
    body: {
      definitionId: "onboarding",
      title: `${onboardingEmployeeName} 入职办理`,
      department: "人力资源部",
      formData: {
        employee: onboardingEmployeeName,
        position: "商业冒烟专员",
        entryDate: "2026-06-03",
        probationMonths: "3",
        equipmentNeed: "电脑+工位"
      }
    }
  });
  assert(onboardingWorkflow.approval?.definitionCode === "HR-ONBOARD", "HR onboarding workflow did not use lifecycle definition", onboardingWorkflow);
  const approvedOnboarding = await approveToTerminal(token, onboardingWorkflow.approval.id);
  assert(approvedOnboarding.status === "已通过", "HR onboarding workflow did not reach approved status", approvedOnboarding);
  const peopleAfterOnboarding = await request("/api/people", { headers: authHeaders(token) });
  assert(
    peopleAfterOnboarding.people?.employees?.some((item) => item.name === onboardingEmployeeName && item.role === "商业冒烟专员"),
    "Approved HR onboarding workflow did not create an employee profile",
    peopleAfterOnboarding.people
  );
  const regularizationWorkflow = await request("/api/approvals", {
    method: "POST",
    headers: authHeaders(token),
    body: {
      definitionId: "regularization",
      title: `${onboardingEmployeeName} 转正申请`,
      department: "人力资源部",
      formData: {
        employee: onboardingEmployeeName,
        probationResult: "按期转正",
        effectiveDate: "2026-07-01",
        reviewer: "商业冒烟主管"
      }
    }
  });
  assert(regularizationWorkflow.approval?.definitionCode === "HR-REGULAR", "HR regularization workflow did not use lifecycle definition", regularizationWorkflow);
  const approvedRegularization = await approveToTerminal(token, regularizationWorkflow.approval.id);
  assert(approvedRegularization.status === "已通过", "HR regularization workflow did not reach approved status", approvedRegularization);

  const salaryWorkflow = await request("/api/approvals", {
    method: "POST",
    headers: authHeaders(token),
    body: {
      definitionId: "salary",
      title: `${onboardingEmployeeName} 调薪申请`,
      department: "人力资源部",
      formData: {
        employee: onboardingEmployeeName,
        adjustAmount: "8800",
        effectiveDate: "2026-08-01",
        reasonType: "岗位调整"
      }
    }
  });
  assert(salaryWorkflow.approval?.definitionCode === "HR-SALARY", "HR salary workflow did not use lifecycle definition", salaryWorkflow);
  const approvedSalary = await approveToTerminal(token, salaryWorkflow.approval.id);
  assert(approvedSalary.status === "已通过", "HR salary workflow did not reach approved status", approvedSalary);
  const peopleAfterSalary = await request("/api/people", { headers: authHeaders(token) });
  const salarySyncedEmployee = peopleAfterSalary.people?.employees?.find((item) => item.name === onboardingEmployeeName);
  assert(salarySyncedEmployee?.lifecycleSummary?.detail === "调薪原因：岗位调整", "Approved HR salary workflow did not update safe lifecycle summary", salarySyncedEmployee);
  assert(!JSON.stringify(salarySyncedEmployee).includes("8800"), "Salary amount leaked into people lifecycle summary", salarySyncedEmployee);

  const exceptionWorkflow = await request("/api/approvals", {
    method: "POST",
    headers: authHeaders(token),
    body: {
      definitionId: "exception",
      title: `${onboardingEmployeeName} 状态异常报备`,
      department: "人力资源部",
      formData: {
        employee: onboardingEmployeeName,
        exceptionType: "权限异常",
        discoveredAt: "2026-08-05",
        actionPlan: "商业冒烟权限复核"
      }
    }
  });
  assert(exceptionWorkflow.approval?.definitionCode === "HR-EXCEPTION", "HR exception workflow did not use lifecycle definition", exceptionWorkflow);
  const approvedException = await approveToTerminal(token, exceptionWorkflow.approval.id);
  assert(approvedException.status === "已通过", "HR exception workflow did not reach approved status", approvedException);
  const peopleAfterException = await request("/api/people", { headers: authHeaders(token) });
  const exceptionSyncedEmployee = peopleAfterException.people?.inactiveEmployees?.find((item) => item.name === onboardingEmployeeName);
  assert(exceptionSyncedEmployee?.lifecycleSummary?.detail === "异常类型：权限异常", "Approved HR exception workflow did not move employee to inactive status", exceptionSyncedEmployee);
  assert(!JSON.stringify(exceptionSyncedEmployee).includes("商业冒烟权限复核"), "Exception action plan leaked into people lifecycle summary", exceptionSyncedEmployee);

  const offboardingWorkflow = await request("/api/approvals", {
    method: "POST",
    headers: authHeaders(token),
    body: {
      definitionId: "offboarding",
      title: `${onboardingEmployeeName} 离职交接`,
      department: "人力资源部",
      formData: {
        employee: onboardingEmployeeName,
        leaveDate: "2026-08-20",
        reasonType: "个人原因",
        handover: "张三",
        assetReturn: "已归还"
      }
    }
  });
  assert(offboardingWorkflow.approval?.definitionCode === "HR-OFFBOARD", "HR offboarding workflow did not use lifecycle definition", offboardingWorkflow);
  const approvedOffboarding = await approveToTerminal(token, offboardingWorkflow.approval.id);
  assert(approvedOffboarding.status === "已通过", "HR offboarding workflow did not reach approved status", approvedOffboarding);
  const peopleAfterOffboarding = await request("/api/people", { headers: authHeaders(token) });
  const offboardedEmployee = peopleAfterOffboarding.people?.leavers?.find((item) => item.name === onboardingEmployeeName);
  assert(offboardedEmployee?.lifecycleSummary?.detail === "离职类型：个人原因", "Approved HR offboarding workflow did not move employee to leavers", offboardedEmployee);

  evidence.hrLifecycle = {
    definitions: definitions.workflowDefinitions.length,
    transferWorkflowId: transferWorkflow.approval.id,
    onboardingWorkflowId: onboardingWorkflow.approval.id,
    regularizationWorkflowId: regularizationWorkflow.approval.id,
    salaryWorkflowId: salaryWorkflow.approval.id,
    exceptionWorkflowId: exceptionWorkflow.approval.id,
    offboardingWorkflowId: offboardingWorkflow.approval.id,
    onboardingEmployeeName,
    firstNode: transferWorkflow.approval.node
  };

  const withdrawCreated = await request("/api/approvals", {
    method: "POST",
    headers: authHeaders(token),
    body: {
      definitionId: "expense",
      title: `商业冒烟撤回审批 ${Date.now()}`,
      department: rules.approvalRules[0].department,
      formData: {
        expenseType: "办公采购",
        amount: "64",
        invoice: "1",
        occurredAt: "2026-05-29"
      }
    }
  });
  assert(withdrawCreated.approval?.id, "Withdraw approval creation failed", withdrawCreated);
  const withdrawn = await request(`/api/approvals/${encodeURIComponent(withdrawCreated.approval.id)}/withdraw`, {
    method: "POST",
    headers: authHeaders(token)
  });
  assert(withdrawn.ok === true, "Applicant/admin withdraw did not succeed", withdrawn);
  const approvalsAfterWithdraw = await request("/api/approvals", { headers: authHeaders(token) });
  const withdrawnApproval = approvalsAfterWithdraw.approvals?.find((item) => item.id === withdrawCreated.approval.id);
  assert(withdrawnApproval?.status === "已撤回", "Withdrawn approval did not move to withdrawn status", withdrawnApproval);
  evidence.withdraw = { id: withdrawnApproval.id, status: withdrawnApproval.status };

  const approvalIdempotencyKey = `commercial-smoke-approval-submit-${smokeRunId}`;
  const approvalTitle = `商业冒烟费用报销 ${Date.now()}`;
  const created = await request("/api/approvals", {
    method: "POST",
    headers: authHeaders(token),
    body: {
      definitionId: "expense",
      title: approvalTitle,
      applicant: "张三",
      department: rules.approvalRules[0].department,
      formData: {
        expenseType: "办公采购",
        amount: "128",
        invoice: "1",
        occurredAt: "2026-05-29"
      },
      idempotencyKey: approvalIdempotencyKey
    }
  });
  assert(created.approval?.id, "Approval creation failed", created);
  const repeatedApproval = await request("/api/approvals", {
    method: "POST",
    headers: authHeaders(token),
    body: {
      definitionId: "expense",
      title: "不应创建的重复费用报销",
      applicant: "张三",
      department: rules.approvalRules[0].department,
      formData: {
        expenseType: "重复提交",
        amount: "9999",
        invoice: "0",
        occurredAt: "2026-07-01"
      },
      idempotencyKey: approvalIdempotencyKey
    }
  });
  assert(repeatedApproval.alreadySubmitted === true, "Repeated approval submit did not return idempotent replay flag", repeatedApproval);
  assert(repeatedApproval.approval?.id === created.approval.id, "Repeated approval submit returned a different workflow instance", {
    created: created.approval,
    repeated: repeatedApproval.approval
  });
  assert(repeatedApproval.approval?.title === approvalTitle, "Repeated approval submit mutated the original workflow payload", repeatedApproval.approval);
  const approvalsAfterSubmitReplay = await request("/api/approvals", { headers: authHeaders(token) });
  assert(
    approvalsAfterSubmitReplay.approvals?.filter((item) => item.title === approvalTitle).length === 1,
    "Repeated approval submit created a duplicate workflow",
    { title: approvalTitle }
  );
  const approvalExport = await request("/api/approvals/export", {
    method: "POST",
    headers: { ...authHeaders(token), accept: "text/csv" },
    responseType: "text",
    body: { businessReason: "商业冒烟审批复核", scope: "审批列表", filters: { keyword: approvalTitle } }
  });
  assert(approvalExport.headers["content-disposition"]?.includes("approval-export-"), "Approval export content-disposition header missing", approvalExport.headers);
  assert(approvalExport.headers["x-row-count"] === "1", "Approval export row count did not match filtered workflow", approvalExport.headers);
  assert(approvalExport.text.includes(approvalTitle), "Approval export CSV did not include created approval", approvalExport.text);
  const commentContent = `商业冒烟评论 ${smokeRunId}`;
  const comment = await request(`/api/approvals/${encodeURIComponent(created.approval.id)}/comments`, {
    method: "POST",
    headers: authHeaders(token),
    body: { content: commentContent }
  });
  assert(comment.comment?.author === currentUserName, "Approval comment author did not use authenticated user", {
    expected: currentUserName,
    comment
  });
  await assertInvalidApproverDenied(token, created.approval.id);
  const transfer = await transferFirstPendingApproval(token, created.approval.id);
  const approved = await approveToTerminal(token, created.approval.id);
  assert(approved.status === "已通过", "Approval did not complete", approved);
  evidence.approval = {
    id: approved.id,
    exportRows: Number(approvalExport.headers["x-row-count"] || 0),
    status: approved.status,
    transfer,
    idempotentReplay: repeatedApproval.alreadySubmitted === true
  };

  const createdAsset = await request("/api/assets", {
    method: "POST",
    headers: authHeaders(token),
    body: {
      name: `商业冒烟设备 ${Date.now()}`,
      category: "直播设备",
      owner: "设备库",
      status: "空闲",
      location: "三楼设备库"
    }
  });
  const assetId = createdAsset.asset?.id;
  assert(assetId, "Asset creation failed", createdAsset);
  const borrowedAsset = await request(`/api/assets/${encodeURIComponent(assetId)}/actions`, {
    method: "POST",
    headers: authHeaders(token),
    body: { action: "borrow", owner: "张三" }
  });
  assert(borrowedAsset.asset?.status === "借用中", "Asset borrow did not update status", borrowedAsset);
  await assertInvalidAssetTransition(token, assetId);
  const inventoriedAsset = await request(`/api/assets/${encodeURIComponent(assetId)}/actions`, {
    method: "POST",
    headers: authHeaders(token),
    body: { action: "inventory", result: "正常" }
  });
  assert(inventoriedAsset.asset?.inventoryResult === "正常", "Asset inventory did not record result", inventoriedAsset);
  const assetEventsAfterInventory = await request("/api/assets/events", { headers: authHeaders(token) });
  const inventoryEvent = assetEventsAfterInventory.assetEvents?.find((item) => (
    item.assetId === assetId && item.type === "inventory" && item.content.includes("完成盘点")
  ));
  assert(inventoryEvent?.operator === currentUserName, "Asset inventory event did not use authenticated operator", {
    expected: currentUserName,
    inventoryEvent
  });
  const returnedAsset = await request(`/api/assets/${encodeURIComponent(assetId)}/actions`, {
    method: "POST",
    headers: authHeaders(token),
    body: { action: "return" }
  });
  assert(returnedAsset.asset?.status === "空闲", "Asset return did not update status", returnedAsset);
  const repairingAsset = await request(`/api/assets/${encodeURIComponent(assetId)}/actions`, {
    method: "POST",
    headers: authHeaders(token),
    body: { action: "repair" }
  });
  assert(repairingAsset.asset?.status === "维修中", "Asset repair did not update status", repairingAsset);
  const qr = await request(`/api/assets/${encodeURIComponent(assetId)}/qr`, {
    method: "POST",
    headers: authHeaders(token)
  });
  assert(qr.asset?.qrVersion >= 2, "QR replacement did not increment version", qr);
  assert(/^data:image\/png;base64,/.test(qr.asset?.qrImage || ""), "QR replacement did not return a generated QR image", qr.asset);
  assert(JSON.parse(qr.asset?.qrPayload || "{}").assetNo === assetId, "QR payload does not identify the asset", qr.asset);
  const assetExport = await request("/api/assets/export", {
    method: "POST",
    headers: { ...authHeaders(token), accept: "text/csv" },
    responseType: "text",
    body: { businessReason: "商业冒烟资产盘点", scope: "资产台账", filters: { keyword: assetId } }
  });
  assert(assetExport.headers["content-disposition"]?.includes("asset-ledger-export-"), "Asset export content-disposition header missing", assetExport.headers);
  assert(Number(assetExport.headers["x-row-count"] || 0) >= 1, "Asset export row count missing", assetExport.headers);
  assert(assetExport.text.includes(assetId), "Asset export CSV did not include created asset", assetExport.text);
  evidence.asset = {
    id: assetId,
    exportRows: Number(assetExport.headers["x-row-count"] || 0),
    qrImage: "generated",
    qrVersion: qr.asset.qrVersion,
    status: repairingAsset.asset.status,
    inventoryResult: inventoriedAsset.asset.inventoryResult
  };

  const resources = await request("/api/resources", { headers: authHeaders(token) });
  assert(resources.resources?.length > 0, "No resources returned");
  const booking = await reserveFirstAvailableResource(token, resources.resources);
  assert(booking.booking?.id, "Resource booking failed", booking);
  assert(booking.booking?.applicant === currentUserName, "Resource booking did not use authenticated applicant", {
    expected: currentUserName,
    booking: booking.booking
  });
  await assertBookingConflict(token, booking.booking);
  const cancelledBooking = await request(`/api/resources/bookings/${encodeURIComponent(booking.booking.id)}/cancel`, {
    method: "POST",
    headers: authHeaders(token),
    body: { reason: "商业冒烟释放资源时段" }
  });
  assert(cancelledBooking.booking?.status === "已取消", "Resource booking cancellation failed", cancelledBooking);
  const rebookedSlot = await request("/api/resources/bookings", {
    method: "POST",
    headers: authHeaders(token),
    body: {
      resourceName: booking.booking.resourceName,
      dayIndex: booking.booking.dayIndex,
      period: booking.booking.period,
      purpose: `取消后重新预约 ${Date.now()}`
    }
  });
  assert(rebookedSlot.booking?.id && rebookedSlot.booking.id !== booking.booking.id, "Resource booking cancellation did not release slot", {
    cancelledBooking,
    rebookedSlot
  });
  const resourceBookingExport = await request("/api/resources/bookings/export", {
    method: "POST",
    responseType: "text",
    headers: authHeaders(token),
    body: {
      scope: "资源预约台账",
      businessReason: "商业冒烟资源核对",
      filters: { resourceName: booking.booking.resourceName }
    }
  });
  assert(resourceBookingExport.headers["content-type"]?.includes("text/csv"), "Resource booking export did not return CSV", resourceBookingExport.headers);
  assert(resourceBookingExport.headers["content-disposition"]?.includes("resource-booking-export-"), "Resource booking export content-disposition header missing", resourceBookingExport.headers);
  assert(resourceBookingExport.text.includes(booking.booking.resourceName), "Resource booking export CSV did not include created booking", resourceBookingExport.text.slice(0, 500));
  evidence.booking = {
    id: booking.booking.id,
    cancelled: cancelledBooking.booking.status,
    rebooked: rebookedSlot.booking.id,
    exportRows: Number(resourceBookingExport.headers["x-row-count"] || 0),
    resourceName: booking.booking.resourceName
  };

  const fileContent = `commercial smoke attachment ${Date.now()}`;
  const fileUpload = await request("/api/files", {
    method: "POST",
    headers: authHeaders(token),
    body: {
      fileName: "commercial-smoke.txt",
      mimeType: "text/plain",
      contentBase64: Buffer.from(fileContent).toString("base64"),
      visibility: "TENANT"
    }
  });
  assert(fileUpload.file?.id, "File upload did not return a file id", fileUpload);
  assert(!("storageKey" in fileUpload.file), "File API leaked storageKey", fileUpload.file);
  const files = await request("/api/files", { headers: authHeaders(token) });
  assert(files.files?.some((item) => item.id === fileUpload.file.id), "Uploaded file was not listed", files);
  const fileDownload = await request(`/api/files/${encodeURIComponent(fileUpload.file.id)}/download`, {
    headers: { ...authHeaders(token), accept: "text/plain" },
    responseType: "text"
  });
  assert(fileDownload.text === fileContent, "Downloaded file content does not match upload", fileDownload);
  try {
    await request("/api/files", {
      method: "POST",
      headers: authHeaders(token),
      body: {
        fileName: "commercial-smoke.html",
        mimeType: "text/html",
        contentBase64: Buffer.from("<script>alert(1)</script>").toString("base64"),
        visibility: "TENANT"
      }
    });
  } catch (error) {
    assert(error.status === 415 && error.payload?.error === "file_type_not_allowed", "Unsafe attachment upload was not rejected", {
      status: error.status,
      payload: error.payload
    });
    evidence.unsafeFileRejected = true;
  }
  assert(evidence.unsafeFileRejected, "Unsafe attachment upload unexpectedly succeeded");
  evidence.file = { id: fileUpload.file.id, sizeBytes: fileUpload.file.sizeBytes };

  try {
    await request("/api/auth/login", {
      method: "POST",
      body: {
        tenantCode,
        email: `commercial-smoke-failed-${Date.now()}@oa.local`,
        password: "wrong-password"
      }
    });
  } catch (error) {
    assert(error.status === 401 && error.payload?.error === "invalid_credentials", "Failed login did not return generic invalid credentials", {
      status: error.status,
      payload: error.payload
    });
    evidence.failedLoginAudited = true;
  }
  assert(evidence.failedLoginAudited, "Failed login unexpectedly succeeded");

  const auditExport = await request("/api/audit/export", {
    method: "POST",
    headers: { ...authHeaders(token), accept: "text/csv" },
    responseType: "text",
    body: { businessReason: "商业冒烟审计复核", scope: "商业冒烟验收", filters: { source: "commercial-smoke" } }
  });
  assert(auditExport.text.includes("操作时间"), "Audit export CSV header missing", auditExport);
  assert(auditExport.headers["content-disposition"]?.includes("audit-export-"), "Audit export filename header missing", auditExport.headers);
  assert(Number(auditExport.headers["x-row-count"]) > 0, "Audit export row count header missing", auditExport.headers);
  const audit = await request("/api/audit", { headers: authHeaders(token) });
  assert(audit.auditLogs?.length > 0, "No audit logs returned");
  const payrollReviewAuditText = reviewedPayroll.alreadyPublished
    ? "已发布，跳过重复复核"
    : "工资单复核发布";
  assert(audit.exportRecords?.some((item) => item.action === "audit.export" && item.scope === "商业冒烟验收"), "Audit export structured record missing");
  assert(audit.exportRecords?.some((item) => item.action === "analytics.export" && Number(item.rowCount) > 0), "Analytics export structured record missing");
  assert(
    audit.exportRecords?.some((item) => item.action === "audit.export" && item.businessReason === "商业冒烟审计复核"),
    "Audit export business reason missing"
  );
  assert(
    audit.exportRecords?.some((item) => item.action === "analytics.export" && item.businessReason === "商业冒烟管理复盘"),
    "Analytics export business reason missing"
  );
  assert(audit.auditLogs.some((item) => item.content.includes("商业冒烟验收")), "Audit export event missing");
  assert(audit.auditLogs.some((item) => item.content.includes("导出管理看板快照，后端生成管理看板快照")), "Analytics export audit event missing");
  assert(audit.auditLogs.some((item) => item.content.includes(`更新员工 ${employeeForMaintenance.name} 档案`)), "Employee maintenance audit event missing");
  assert(audit.auditLogs.some((item) => item.content.includes(`导入人员数据 commercial-smoke-dashboard-${smokeRunId}.html，共 1 行`)), "Runtime import audit event missing");
  assert(audit.auditLogs.some((item) => item.content.includes(`拒绝导入人员数据 commercial-smoke-empty-${smokeRunId}.html`)), "Empty import denial audit event missing");
  assert(audit.auditLogs.some((item) => item.content.includes("完成盘点")), "Asset inventory audit event missing");
  assert(audit.auditLogs.some((item) => item.content.includes("商业冒烟员工 提交年假申请")), "Leave submit audit event missing");
  assert(audit.auditLogs.some((item) => item.content.includes("录入商业冒烟员工 2026-06-15 考勤记录")), "Attendance record audit event missing");
  assert(!audit.auditLogs.some((item) => item.content.includes("不应创建的重复请假员工")), "Repeated leave submit wrote a duplicate audit event");
  assert(audit.auditLogs.some((item) => item.content.includes("撤回审批实例")), "Approval withdraw audit event missing");
  assert(
    findAuditLog(audit, (item) => item.operator === currentUserName && item.content.includes("添加审批评论")),
    "Approval comment audit did not use authenticated operator",
    { expected: currentUserName }
  );
  assert(
    findAuditLog(audit, (item) => item.operator === currentUserName && item.content.includes("完成盘点")),
    "Asset inventory audit did not use authenticated operator",
    { expected: currentUserName }
  );
  assert(
    findAuditLog(audit, (item) => item.operator === currentUserName && item.content.includes("商业冒烟员工 提交年假申请")),
    "Leave submit audit did not use authenticated operator",
    { expected: currentUserName }
  );
  assert(
    findAuditLog(audit, (item) => item.operator === currentUserName && item.content.includes("录入商业冒烟员工 2026-06-15 考勤记录")),
    "Attendance record audit did not use authenticated operator",
    { expected: currentUserName }
  );
  assert(audit.auditLogs.some((item) => item.content.includes("导出考勤记录台账，后端生成考勤记录台账")), "Attendance record export audit event missing");
  assert(
    findAuditLog(audit, (item) => item.operator === currentUserName && item.content.includes(`预约${booking.booking.resourceName} ${booking.booking.period}`)),
    "Resource booking audit did not use authenticated operator",
    { expected: currentUserName, booking: booking.booking }
  );
  assert(
    audit.auditLogs.some((item) => item.content.includes(`取消${booking.booking.resourceName} ${booking.booking.period}`)),
    "Resource booking cancellation audit event missing"
  );
  assert(audit.auditLogs.some((item) => item.content.includes("导出资源预约台账，后端生成资源预约台账")), "Resource booking export audit event missing");
  assert(
    findAuditLog(audit, (item) => (
      item.operator === currentUserName
      && item.type === "预约冲突"
      && item.result === "失败"
      && item.content.includes(booking.booking.resourceName)
      && item.content.includes("已被占用")
    )),
    "Resource booking conflict audit event missing",
    { expected: currentUserName, booking: booking.booking }
  );
  assert(audit.auditLogs.some((item) => item.content.includes(payrollReviewAuditText)), "Payroll review audit event missing");
  assert(audit.auditLogs.some((item) => item.content.includes("提交费用报销审批流程")), "Finance request workflow submit audit event missing");
  assert(audit.auditLogs.some((item) => item.content.includes(`${financeRequestNo} 费用报销创建并提交审批`)), "Finance request create audit event missing");
  assert(audit.auditLogs.some((item) => item.content.includes("导出财务单据台账，后端生成付款报销台账")), "Finance request export audit event missing");
  assert(!audit.auditLogs.some((item) => item.content.includes(`${financeRequestNo}-RETRY`)), "Repeated finance request submit wrote a duplicate audit event");
  assert(audit.auditLogs.some((item) => item.content.includes("提交工资单复核流程")), "Payroll workflow submit audit event missing");
  assert(audit.auditLogs.some((item) => item.content.includes(`${newPayrollBatchNo} 工资单创建并提交复核`)), "Payroll create audit event missing");
  assert(audit.auditLogs.some((item) => item.content.includes(`${newPayrollBatchNo} 审批未全部通过，不能发布工资单`)), "Unapproved payroll publish denial audit event missing");
  assert(!audit.auditLogs.some((item) => item.content.includes(`${newPayrollBatchNo}-RETRY`)), "Repeated payroll submit wrote a duplicate audit event");
  assert(
    findAuditLog(audit, (item) => item.operator === currentUserName && item.content.includes(payrollReviewAuditText)),
    "Payroll review audit did not use authenticated operator",
    { expected: currentUserName }
  );
  assert(audit.auditLogs.some((item) => item.content.includes("上传附件 commercial-smoke.txt")), "File upload audit event missing");
  assert(audit.auditLogs.some((item) => item.content.includes("下载附件 commercial-smoke.txt")), "File download audit event missing");
  assert(
    findAuditLog(audit, (item) => item.result === "失败" && item.content.includes("拒绝上传高风险附件 commercial-smoke.html")),
    "Unsafe attachment upload denial audit event missing"
  );
  assert(audit.auditLogs.some((item) => item.content.includes("用户登录失败")), "Failed login audit event missing");
  evidence.auditRows = audit.auditLogs.length;
  evidence.auditExportRows = Number(auditExport.headers["x-row-count"]);

  const logout = await request("/api/auth/logout", {
    method: "POST",
    headers: authHeaders(token)
  });
  assert(logout.ok === true, "Logout did not succeed", logout);
  try {
    await request("/api/auth/me", { headers: authHeaders(token) });
  } catch (error) {
    assert(error.status === 401 && error.payload?.error === "unauthorized", "Logout did not revoke the old token", {
      status: error.status,
      payload: error.payload
    });
    evidence.logoutRevokedToken = true;
  }
  assert(evidence.logoutRevokedToken, "Logout left the old token usable");

  return {
    ok: true,
    kind: "commercial-smoke",
    runId: smokeRunId,
    baseUrl,
    tenantCode,
    startedAt,
    finishedAt: new Date().toISOString(),
    evidence
  };
}

main().then(async (result) => {
  const evidenceFile = await writeCommercialEvidence({
    kind: "commercial-smoke",
    payload: result,
    explicitPathEnv: "COMMERCIAL_SMOKE_EVIDENCE_FILE"
  });
  console.log(JSON.stringify({
    ...result,
    ...(evidenceFile ? { evidenceFile } : {})
  }, null, 2));
}).catch(async (error) => {
  const failure = {
    ok: false,
    kind: "commercial-smoke",
    runId: smokeRunId,
    baseUrl,
    tenantCode,
    startedAt,
    finishedAt: new Date().toISOString(),
    error: error.message,
    details: error.details || error.payload || {},
    evidence
  };
  try {
    const evidenceFile = await writeCommercialEvidence({
      kind: "commercial-smoke",
      payload: failure,
      explicitPathEnv: "COMMERCIAL_SMOKE_EVIDENCE_FILE"
    });
    if (evidenceFile) {
      console.error(`Commercial smoke evidence written to ${evidenceFile}`);
    }
  } catch (writeError) {
    console.error(`Failed to write commercial smoke evidence: ${writeError.message}`);
  }
  console.error(error.message);
  if (error.details || error.payload) {
    console.error(JSON.stringify(error.details || error.payload, null, 2));
  }
  process.exitCode = 1;
});
