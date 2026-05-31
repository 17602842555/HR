const json = "application/json";

function response(description, schema = { type: "object" }) {
  return {
    description,
    content: {
      [json]: {
        schema
      }
    }
  };
}

function operation({ body, description, operationId, parameters = [], responses = {}, secured = true, summary, tags }) {
  return {
    operationId,
    summary,
    description,
    tags,
    ...(secured ? { security: [{ bearerAuth: [] }, { sessionCookie: [] }] } : {}),
    ...(parameters.length ? { parameters } : {}),
    ...(body ? {
      requestBody: {
        required: true,
        content: {
          [json]: {
            schema: body
          }
        }
      }
    } : {}),
    responses: {
      "200": response("Success"),
      "400": response("Bad request", { $ref: "#/components/schemas/ErrorResponse" }),
      "401": response("Unauthorized", { $ref: "#/components/schemas/ErrorResponse" }),
      "403": response("Forbidden", { $ref: "#/components/schemas/ErrorResponse" }),
      ...responses
    }
  };
}

const idParam = { name: "id", in: "path", required: true, schema: { type: "string" } };
const limitParam = { name: "limit", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 500 } };
const auditIntegrityLimitParam = { name: "limit", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 5000 } };
const fromDateParam = { name: "from", in: "query", required: false, schema: { type: "string", format: "date" } };
const toDateParam = { name: "to", in: "query", required: false, schema: { type: "string", format: "date" } };
const exportRequest = { $ref: "#/components/schemas/ExportRequest" };

export const openApiDocument = {
  openapi: "3.1.0",
  info: {
    title: "集团人事行政 OA Commercial API",
    version: "2026.05.30",
    description: "Fastify + Prisma + PostgreSQL commercial OA API contract for auth, IAM, people, approvals, attendance, finance, assets, resources, imports, files, audit, analytics, readiness, backup smoke verification, and frontend integration."
  },
  servers: [
    { url: "/api", description: "Same-origin API behind Vite/nginx proxy" },
    { url: "http://127.0.0.1:8787/api", description: "Local Fastify API" }
  ],
  tags: [
    { name: "Auth" },
    { name: "People" },
    { name: "Approvals" },
    { name: "Attendance" },
    { name: "Finance" },
    { name: "Assets" },
    { name: "Resources" },
    { name: "Files" },
    { name: "Imports" },
    { name: "IAM" },
    { name: "Audit" },
    { name: "Analytics" },
    { name: "Runtime" }
  ],
  paths: {
    "/health": {
      get: operation({
        operationId: "getApiHealth",
        summary: "API liveness",
        tags: ["Runtime"],
        secured: false,
        responses: { "200": response("API process is alive", { $ref: "#/components/schemas/HealthResponse" }) }
      })
    },
    "/ready": {
      get: operation({
        operationId: "getApiReadiness",
        summary: "API readiness",
        tags: ["Runtime"],
        secured: false,
        responses: {
          "200": response("Database, database integrity, and file storage are ready", { $ref: "#/components/schemas/ReadinessResponse" }),
          "503": response("Dependency unavailable", { $ref: "#/components/schemas/ReadinessResponse" })
        }
      })
    },
    "/system/readiness": {
      get: operation({
        operationId: "getSystemReadiness",
        summary: "Authenticated commercial release readiness summary",
        tags: ["Runtime"],
        responses: { "200": response("Commercial readiness summary", { $ref: "#/components/schemas/SystemReadinessResponse" }) }
      })
    },
    "/openapi.json": {
      get: operation({
        operationId: "getOpenApiContract",
        summary: "OpenAPI contract",
        tags: ["Runtime"],
        secured: false,
        responses: { "200": response("OpenAPI document") }
      })
    },
    "/auth/login": {
      post: operation({
        operationId: "login",
        summary: "Login and set session cookie",
        tags: ["Auth"],
        secured: false,
        body: { $ref: "#/components/schemas/LoginRequest" },
        responses: {
          "200": response("Authenticated session", { $ref: "#/components/schemas/AuthSession" }),
          "429": response("Too many failed login attempts", { $ref: "#/components/schemas/ErrorResponse" })
        }
      })
    },
    "/auth/me": {
      get: operation({ operationId: "getCurrentUser", summary: "Current authenticated user", tags: ["Auth"], responses: { "200": response("Current user", { $ref: "#/components/schemas/AuthSession" }) } })
    },
    "/auth/logout": {
      post: operation({ operationId: "logout", summary: "Revoke current session version", tags: ["Auth"], responses: { "200": response("Logged out") } })
    },
    "/auth/change-password": {
      post: operation({
        operationId: "changePassword",
        summary: "Change own password, revoke old sessions, and return a refreshed token",
        tags: ["Auth"],
        body: { $ref: "#/components/schemas/PasswordChangeRequest" },
        responses: { "200": response("Password changed", { $ref: "#/components/schemas/AuthSession" }) }
      })
    },
    "/auth/complete-first-login": {
      post: operation({
        operationId: "completeFirstLogin",
        summary: "Complete first login by changing login identifier, display name, and password",
        tags: ["Auth"],
        body: { $ref: "#/components/schemas/FirstLoginSetupRequest" },
        responses: { "200": response("First login setup completed", { $ref: "#/components/schemas/AuthSession" }) }
      })
    },
    "/auth/activate-account": {
      post: operation({
        operationId: "activateEmployeeAccount",
        summary: "Employee self-service account activation using an administrator issued one-time code",
        tags: ["Auth"],
        body: { $ref: "#/components/schemas/AccountActivationCompleteRequest" },
        responses: { "201": response("Activated account session", { $ref: "#/components/schemas/AuthSession" }) }
      })
    },
    "/people": {
      get: operation({
        operationId: "getPeopleOverview",
        summary: "People overview with masked sensitive fields by default",
        tags: ["People"],
        parameters: [{ name: "revealSensitive", in: "query", required: false, schema: { type: "boolean" } }],
        responses: { "200": response("People overview", { $ref: "#/components/schemas/PeopleOverview" }) }
      })
    },
    "/people/employees": {
      get: operation({ operationId: "listActiveEmployees", summary: "Active employees", tags: ["People"], responses: { "200": response("Employees list") } })
    },
    "/people/leavers": {
      get: operation({ operationId: "listLeavers", summary: "Leaver employees", tags: ["People"], responses: { "200": response("Leavers list") } })
    },
    "/people/employees/{id}": {
      patch: operation({
        operationId: "updateEmployee",
        summary: "Update controlled employee fields",
        tags: ["People"],
        parameters: [idParam],
        body: { $ref: "#/components/schemas/EmployeePatch" },
        responses: { "404": response("Employee not found", { $ref: "#/components/schemas/ErrorResponse" }) }
      })
    },
    "/people/export": {
      post: operation({ operationId: "exportPeople", summary: "Audit-backed people export with required business reason", tags: ["People"], body: exportRequest, responses: { "200": response("CSV export metadata") } })
    },
    "/approvals/definitions": {
      get: operation({ operationId: "listApprovalDefinitions", summary: "Workflow definitions", tags: ["Approvals"] })
    },
    "/approvals": {
      get: operation({ operationId: "listApprovals", summary: "Workflow instances", tags: ["Approvals"], parameters: [limitParam] }),
      post: operation({ operationId: "submitApproval", summary: "Submit approval workflow", tags: ["Approvals"], body: { $ref: "#/components/schemas/ApprovalSubmit" }, responses: { "201": response("Workflow submitted") } })
    },
    "/approvals/export": {
      post: operation({ operationId: "exportApprovals", summary: "Backend-generated approval list CSV export", tags: ["Approvals"], body: exportRequest })
    },
    "/approvals/{id}/decision": {
      post: operation({ operationId: "decideApproval", summary: "Approve or reject current task", tags: ["Approvals"], parameters: [idParam], body: { $ref: "#/components/schemas/ApprovalDecision" } })
    },
    "/approvals/{id}/transfer": {
      post: operation({ operationId: "transferApproval", summary: "Transfer pending approver task", tags: ["Approvals"], parameters: [idParam], body: { $ref: "#/components/schemas/ApprovalTransfer" } })
    },
    "/approvals/{id}/withdraw": {
      post: operation({ operationId: "withdrawApproval", summary: "Withdraw pending workflow", tags: ["Approvals"], parameters: [idParam] })
    },
    "/approvals/{id}/comments": {
      post: operation({ operationId: "commentApproval", summary: "Add approval comment as authenticated actor", tags: ["Approvals"], parameters: [idParam], body: { $ref: "#/components/schemas/CommentRequest" } })
    },
    "/approvals/rules": {
      get: operation({ operationId: "listApprovalRules", summary: "Department approval rules", tags: ["Approvals"] }),
      post: operation({ operationId: "saveApprovalRule", summary: "Create or update department approval rule", tags: ["Approvals"], body: { $ref: "#/components/schemas/ApprovalRule" } })
    },
    "/approvals/rules/coverage": {
      get: operation({ operationId: "listApprovalRuleCoverage", summary: "Department workflow rule coverage matrix", tags: ["Approvals"] })
    },
    "/approvals/rules/preview": {
      get: operation({
        operationId: "previewApprovalRule",
        summary: "Preview active department approval path",
        tags: ["Approvals"],
        parameters: [
          { name: "department", in: "query", required: true, schema: { type: "string" } },
          { name: "templateId", in: "query", required: true, schema: { type: "string" } }
        ]
      })
    },
    "/approvals/rules/{id}": {
      delete: operation({ operationId: "deleteApprovalRule", summary: "Disable/delete department approval rule", tags: ["Approvals"], parameters: [idParam], responses: { "404": response("Rule not found", { $ref: "#/components/schemas/ErrorResponse" }) } })
    },
    "/attendance/leaves": {
      get: operation({ operationId: "listLeaveRequests", summary: "Leave requests", tags: ["Attendance"], parameters: [limitParam] }),
      post: operation({ operationId: "submitLeaveRequest", summary: "Submit leave request and linked workflow", tags: ["Attendance"], body: { $ref: "#/components/schemas/LeaveRequest" }, responses: { "201": response("Leave submitted") } })
    },
    "/attendance/records": {
      get: operation({ operationId: "listAttendanceRecords", summary: "Attendance clock records", tags: ["Attendance"], parameters: [limitParam] }),
      post: operation({ operationId: "createAttendanceRecord", summary: "Create audited attendance clock record", tags: ["Attendance"], body: { type: "object" }, responses: { "201": response("Attendance record created") } })
    },
    "/attendance/records/export": {
      post: operation({ operationId: "exportAttendanceRecords", summary: "Backend-generated attendance record CSV export", tags: ["Attendance"], body: exportRequest })
    },
    "/finance/requests": {
      get: operation({ operationId: "listFinanceRequests", summary: "Payment and expense request ledger", tags: ["Finance"], parameters: [limitParam], responses: { "200": response("Finance request ledger", { type: "object", properties: { financeRequests: { type: "array", items: { $ref: "#/components/schemas/FinanceRequest" } } } }) } }),
      post: operation({ operationId: "createFinanceRequest", summary: "Create payment or expense request and linked workflow", tags: ["Finance"], body: { $ref: "#/components/schemas/FinanceRequestInput" }, responses: { "201": response("Finance request created", { $ref: "#/components/schemas/FinanceRequestResponse" }) } })
    },
    "/finance/requests/export": {
      post: operation({ operationId: "exportFinanceRequests", summary: "Backend-generated finance request CSV export", tags: ["Finance"], body: exportRequest })
    },
    "/finance/payrolls": {
      get: operation({ operationId: "listPayrollBatches", summary: "Payroll batches", tags: ["Finance"], parameters: [limitParam] }),
      post: operation({ operationId: "createPayrollBatch", summary: "Create payroll batch and linked workflow", tags: ["Finance"], body: { $ref: "#/components/schemas/PayrollBatch" }, responses: { "201": response("Payroll created") } })
    },
    "/finance/payrolls/{id}/review": {
      post: operation({ operationId: "reviewPayrollBatch", summary: "Review or publish approved payroll", tags: ["Finance"], parameters: [idParam], body: { type: "object", properties: { action: { type: "string", enum: ["review", "publish"] } } } })
    },
    "/assets": {
      get: operation({ operationId: "listAssets", summary: "Asset ledger", tags: ["Assets"], responses: { "200": response("Asset ledger", { type: "object", properties: { assets: { type: "array", items: { $ref: "#/components/schemas/Asset" } } } }) } }),
      post: operation({ operationId: "createAsset", summary: "Create asset with QR metadata", tags: ["Assets"], body: { $ref: "#/components/schemas/AssetInput" }, responses: { "201": response("Asset created", { $ref: "#/components/schemas/AssetResponse" }) } })
    },
    "/assets/export": {
      post: operation({ operationId: "exportAssetLedger", summary: "Backend-generated asset ledger CSV export", tags: ["Assets"], body: exportRequest })
    },
    "/assets/{id}": {
      patch: operation({ operationId: "updateAsset", summary: "Update asset metadata", tags: ["Assets"], parameters: [idParam], body: { $ref: "#/components/schemas/AssetInput" }, responses: { "200": response("Asset updated", { $ref: "#/components/schemas/AssetResponse" }) } })
    },
    "/assets/{id}/actions": {
      post: operation({ operationId: "assetLifecycleAction", summary: "Borrow, return, repair, inventory, or retire asset", tags: ["Assets"], parameters: [idParam], body: { $ref: "#/components/schemas/AssetAction" }, responses: { "200": response("Asset lifecycle action completed", { $ref: "#/components/schemas/AssetResponse" }) } })
    },
    "/assets/{id}/qr": {
      post: operation({ operationId: "regenerateAssetQr", summary: "Regenerate asset QR version and image", tags: ["Assets"], parameters: [idParam], responses: { "200": response("Asset QR regenerated", { $ref: "#/components/schemas/AssetResponse" }) } })
    },
    "/assets/events": {
      get: operation({ operationId: "listAssetEvents", summary: "Asset lifecycle events", tags: ["Assets"], parameters: [limitParam] })
    },
    "/resources": {
      get: operation({ operationId: "listResources", summary: "Reservable resources", tags: ["Resources"], parameters: [fromDateParam] })
    },
    "/resources/bookings": {
      get: operation({ operationId: "listResourceBookings", summary: "Resource bookings", tags: ["Resources"], parameters: [limitParam, fromDateParam, toDateParam] }),
      post: operation({ operationId: "createResourceBooking", summary: "Create conflict-checked booking", tags: ["Resources"], body: { $ref: "#/components/schemas/ResourceBooking" }, responses: { "409": response("Booking conflict", { $ref: "#/components/schemas/ErrorResponse" }) } })
    },
    "/resources/bookings/export": {
      post: operation({ operationId: "exportResourceBookings", summary: "Backend-generated resource booking CSV export", tags: ["Resources"], body: exportRequest })
    },
    "/resources/bookings/{id}/cancel": {
      post: operation({ operationId: "cancelResourceBooking", summary: "Cancel booking and release slot", tags: ["Resources"], parameters: [idParam], body: { type: "object", properties: { reason: { type: "string" } } } })
    },
    "/files": {
      get: operation({ operationId: "listFiles", summary: "Attachment center files", tags: ["Files"], parameters: [limitParam] }),
      post: operation({ operationId: "uploadFile", summary: "Upload base64 attachment with checksum and audit", tags: ["Files"], body: { $ref: "#/components/schemas/FileUpload" }, responses: { "413": response("File too large", { $ref: "#/components/schemas/ErrorResponse" }) } })
    },
    "/files/{id}/download": {
      get: operation({ operationId: "downloadFile", summary: "Download attachment by opaque id", tags: ["Files"], parameters: [idParam], responses: { "409": response("Checksum mismatch", { $ref: "#/components/schemas/ErrorResponse" }) } })
    },
    "/imports": {
      get: operation({ operationId: "listImports", summary: "Data import lineage", tags: ["Imports"], parameters: [limitParam] })
    },
    "/imports/dashboard-html": {
      post: operation({ operationId: "importDashboardHtml", summary: "Import oa-dashboard.html personnel source", tags: ["Imports"], body: { $ref: "#/components/schemas/DashboardHtmlImport" }, responses: { "409": response("Duplicate import", { $ref: "#/components/schemas/ErrorResponse" }) } })
    },
    "/imports/{id}/source": {
      get: operation({ operationId: "downloadImportSource", summary: "Download checksum-verified original import source", tags: ["Imports"], parameters: [idParam], responses: { "409": response("Source checksum mismatch", { $ref: "#/components/schemas/ErrorResponse" }) } })
    },
    "/iam": {
      get: operation({ operationId: "getIamOverview", summary: "Roles, permissions, and user role assignments", tags: ["IAM"] })
    },
    "/iam/users": {
      post: operation({ operationId: "createIamUser", summary: "Create account with initial roles and audited temporary password handling", tags: ["IAM"], body: { $ref: "#/components/schemas/UserCreateRequest" }, responses: { "201": response("Created user") } })
    },
    "/iam/accounts/sync-employees": {
      post: operation({
        operationId: "syncEmployeeAccounts",
        summary: "Create one login account for each active employee missing an account",
        tags: ["IAM"],
        body: { $ref: "#/components/schemas/EmployeeAccountSyncRequest" },
        responses: { "201": response("Created employee accounts", { $ref: "#/components/schemas/EmployeeAccountSyncResponse" }) }
      })
    },
    "/iam/account-activations": {
      post: operation({
        operationId: "createEmployeeAccountActivation",
        summary: "Issue a one-time account activation code for an active employee without an account",
        tags: ["IAM"],
        body: { $ref: "#/components/schemas/AccountActivationCreateRequest" },
        responses: { "201": response("Created activation code", { $ref: "#/components/schemas/AccountActivationCreateResponse" }) }
      })
    },
    "/iam/roles/{id}/permissions": {
      put: operation({ operationId: "updateRolePermissions", summary: "Update role permissions and audit the change", tags: ["IAM"], parameters: [idParam], body: { $ref: "#/components/schemas/RolePermissionUpdate" } })
    },
    "/iam/users/{id}/roles": {
      put: operation({ operationId: "updateUserRoles", summary: "Update account role assignments", tags: ["IAM"], parameters: [idParam], body: { $ref: "#/components/schemas/UserRoleUpdate" } })
    },
    "/iam/users/{id}/status": {
      put: operation({ operationId: "updateUserStatus", summary: "Enable or disable account and revoke disabled sessions", tags: ["IAM"], parameters: [idParam], body: { $ref: "#/components/schemas/UserStatusUpdate" } })
    },
    "/iam/users/{id}/password": {
      put: operation({ operationId: "resetUserPassword", summary: "Admin reset account password and revoke existing sessions", tags: ["IAM"], parameters: [idParam], body: { $ref: "#/components/schemas/PasswordResetRequest" } })
    },
    "/audit": {
      get: operation({ operationId: "listAuditLogs", summary: "Tenant-scoped audit logs", tags: ["Audit"], parameters: [limitParam] })
    },
    "/audit/export-records": {
      get: operation({ operationId: "listExportRecords", summary: "Structured export records with actor, scope, filters, and row counts", tags: ["Audit"], parameters: [limitParam] })
    },
    "/audit/integrity": {
      get: operation({
        operationId: "checkAuditIntegrity",
        summary: "Validate tamper-evident audit hash chain",
        tags: ["Audit"],
        parameters: [auditIntegrityLimitParam],
        responses: { "200": response("Audit integrity chain validation", { $ref: "#/components/schemas/AuditIntegrityResponse" }) }
      })
    },
    "/audit/export": {
      post: operation({ operationId: "exportAuditLogs", summary: "Backend-generated audit CSV export", tags: ["Audit"], body: exportRequest })
    },
    "/audit/sensitive-access": {
      post: operation({ operationId: "requestSensitiveAccess", summary: "Audit sensitive reveal action", tags: ["Audit"], body: { type: "object" } })
    },
    "/analytics/overview": {
      get: operation({ operationId: "getManagementAnalytics", summary: "Backend-computed management analytics", tags: ["Analytics"] })
    },
    "/analytics/export": {
      post: operation({ operationId: "exportManagementAnalytics", summary: "Backend-generated management analytics CSV snapshot", tags: ["Analytics"], body: exportRequest })
    },
    "/workflows/definitions": {
      get: operation({ operationId: "listWorkflowDefinitions", summary: "Raw workflow definitions", tags: ["Approvals"] })
    }
  },
  components: {
    securitySchemes: {
      bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
      sessionCookie: { type: "apiKey", in: "cookie", name: "oa_session" }
    },
    schemas: {
      ErrorResponse: {
        type: "object",
        required: ["error"],
        properties: {
          error: { type: "string" },
          message: { type: "string" },
          details: { type: "object" }
        }
      },
      HealthResponse: {
        type: "object",
        required: ["ok", "service"],
        properties: { ok: { type: "boolean" }, service: { type: "string", const: "deep-oa-api" } }
      },
      ReadinessResponse: {
        type: "object",
        required: ["ok", "service", "database", "databaseIntegrity", "fileStorage"],
        properties: {
          ok: { type: "boolean" },
          service: { type: "string", const: "deep-oa-api" },
          database: { type: "string" },
          databaseIntegrity: { type: "string" },
          fileStorage: { type: "string" }
        }
      },
      SystemReadinessResponse: {
        type: "object",
        required: ["systemReadiness"],
        properties: {
          systemReadiness: {
            type: "object",
            required: [
              "generatedAt",
              "runtime",
              "closurePlan",
              "dependencies",
              "controls",
              "knownGaps",
              "releaseGate",
              "gapActionReport",
              "hrDataReview",
              "latestEvidence",
              "ownerEvidenceChecklist",
              "signoffDrafts"
            ],
            properties: {
              generatedAt: { type: "string", format: "date-time" },
              runtime: {
                type: "object",
                description: "Safe runtime flags without secrets, origins, or filesystem paths."
              },
              closurePlan: {
                type: "array",
                description: "Safe release closure checklist without commands, paths, hostnames, database URLs, or raw blocker text.",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string" },
                    category: { type: "string" },
                    evidenceStatus: { type: "string" },
                    failedCheckCount: { type: "integer" },
                    missingCheckCount: { type: "integer" },
                    nextAction: { type: "string" },
                    owner: { type: "string" },
                    relatedCheckIds: { type: "array", items: { type: "string" } },
                    releaseBlocking: { type: "boolean" },
                    status: { type: "string" },
                    targetDate: { type: "string" }
                  }
                }
              },
              dependencies: { $ref: "#/components/schemas/ReadinessResponse" },
              controls: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string" },
                    label: { type: "string" },
                    ok: { type: "boolean" },
                    status: { type: "string" },
                    detail: { type: "string" }
                  }
                }
              },
              knownGapSourceAvailable: { type: "boolean" },
              knownGaps: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string" },
                    status: { type: "string" },
                    owner: { type: "string" },
                    targetDate: { type: "string" },
                    gap: { type: "string" },
                    exitCriteria: { type: "string" }
                  }
                }
              },
              ownerEvidenceChecklist: {
                type: "array",
                description: "Safe owner-by-gap release evidence checklist without file paths, commands, hostnames, database URLs, checksums, or secrets.",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string" },
                    artifactCount: { type: "integer" },
                    category: { type: "string" },
                    evidenceStatus: { type: "string" },
                    missingArtifactCount: { type: "integer" },
                    nextAction: { type: "string" },
                    owner: { type: "string" },
                    presentArtifactCount: { type: "integer" },
                    releaseBlocking: { type: "boolean" },
                    requiredArtifactCount: { type: "integer" },
                    status: { type: "string" },
                    targetDate: { type: "string" },
                    artifacts: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          label: { type: "string" },
                          phase: { type: "string" },
                          present: { type: "boolean" },
                          releaseRequired: { type: "boolean" },
                          status: { type: "string" }
                        }
                      }
                    }
                  }
                }
              },
              releaseGate: {
                type: "object",
                properties: {
                  blockers: { type: "array", items: { type: "string" } },
                  openGapCount: { type: "integer" },
                  releaseReady: { type: "boolean" },
                  warnings: { type: "array", items: { type: "string" } }
                }
              },
              hrDataReview: {
                type: "object",
                description: "Safe HR data review package summary without paths or sensitive personnel fields.",
                properties: {
                  available: { type: "boolean" },
                  counts: {
                    type: "object",
                    properties: {
                      activeEmployees: { type: "integer" },
                      leavers: { type: "integer" },
                      femaleEmployees: { type: "integer" },
                      monthLeavers: { type: "integer" },
                      departments: { type: "integer" },
                      orgs: { type: "integer" },
                      totalReviewRows: { type: "integer" }
                    }
                  },
                  generatedAt: { type: ["string", "null"], format: "date-time" },
                  nextCommandCount: { type: "integer" },
                  noSensitiveFields: { type: "boolean" },
                  releaseEvidence: { type: "boolean" },
                  rowCount: { type: "integer" },
                  status: { type: "string" },
                  unsafeFileCount: { type: "integer" }
                }
              },
              gapActionReport: {
                type: "object",
                description: "Safe owner handoff summary for open commercial gaps without evidence paths, commands, or blocker text.",
                properties: {
                  available: { type: "boolean" },
                  blockedGapCount: { type: "integer" },
                  generatedAt: { type: ["string", "null"], format: "date-time" },
                  ownerCount: { type: "integer" },
                  releaseEvidence: { type: "boolean" },
                  releaseReady: { type: "boolean" },
                  status: { type: "string" },
                  warningCheckCount: { type: "integer" },
                  owners: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        owner: { type: "string" },
                        blockerCount: { type: "integer" },
                        gapCount: { type: "integer" },
                        gapIds: { type: "array", items: { type: "string" } },
                        status: { type: "string" },
                        targetDates: { type: "array", items: { type: "string" } },
                        validationCommandCount: { type: "integer" }
                      }
                    }
                  }
                }
              },
              latestEvidence: {
                type: "object",
                description: "Safe latest commercial evidence summary without command output, filesystem paths, URLs, database names, or secrets.",
                properties: {
                  artifactSummary: {
                    type: "object",
                    description: "Safe evidence artifact inventory grouped by release phase without file paths or checksums.",
                    properties: {
                      available: { type: "boolean" },
                      itemCount: { type: "integer" },
                      migrationCount: { type: "integer" },
                      missingFileCount: { type: "integer" },
                      missingReleaseArtifactCount: { type: "integer" },
                      presentFileCount: { type: "integer" },
                      releaseRequiredCount: { type: "integer" },
                      trackedFileCount: { type: "integer" },
                      items: {
                        type: "array",
                        items: {
                          type: "object",
                          properties: {
                            id: { type: "string" },
                            label: { type: "string" },
                            phase: { type: "string" },
                            present: { type: "boolean" },
                            releaseRequired: { type: "boolean" },
                            status: { type: "string" }
                          }
                        }
                      }
                    }
                  },
                  available: { type: "boolean" },
                  checkCount: { type: "integer" },
                  e2eIncluded: { type: "boolean" },
                  evidenceMode: { type: "string", enum: ["full", "quick", "partial", "missing", "unknown"] },
                  generatedAt: { type: ["string", "null"], format: "date-time" },
                  openGapCount: { type: "integer" },
                  releaseBlockerCount: { type: "integer" },
                  releaseCandidateReady: { type: "boolean" },
                  releaseEvidence: { type: "boolean" },
                  requiredFailedCount: { type: "integer" },
                  status: { type: "string" },
                  warningCheckCount: { type: "integer" },
                  targetProfile: {
                    type: "object",
                    properties: {
                      database: {
                        type: "object",
                        properties: {
                          configured: { type: "boolean" },
                          target: { type: "string" }
                        }
                      },
                      e2eIncluded: { type: "boolean" },
                      evidenceClass: { type: "string" },
                      productionEvidenceReady: { type: "boolean" },
                      productionRuntime: { type: "boolean" },
                      signoffChecks: { type: "object" },
                      viteDemoFallback: { type: "string" },
                      viteRequireApi: { type: "string" },
                      warningCount: { type: "integer" }
                    }
                  },
                  checks: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        id: { type: "string" },
                        exitCode: { type: ["integer", "null"] },
                        required: { type: "boolean" },
                        status: { type: "string" }
                      }
                    }
                  }
                }
              },
              signoffDrafts: {
                type: "object",
                description: "Safe signoff-draft summary without absolute paths or plaintext secrets.",
                properties: {
                  available: { type: "boolean" },
                  draftCount: { type: "integer" },
                  generatedAt: { type: ["string", "null"], format: "date-time" },
                  handoffItemCount: { type: "integer" },
                  nextCommandCount: { type: "integer" },
                  openExceptionCount: { type: "integer" },
                  pendingApprovalCount: { type: "integer" },
                  relatedGapIds: { type: "array", items: { type: "string" } },
                  releaseEvidence: { type: "boolean" },
                  requiredActionCount: { type: "integer" },
                  signoffReadinessStatus: { type: "string" },
                  status: { type: "string" },
                  validatorCommandCount: { type: "integer" },
                  kinds: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        id: { type: "string" },
                        draft: { type: "boolean" },
                        label: { type: "string" },
                        openExceptionCount: { type: "integer" },
                        pendingApprovalCount: { type: "integer" },
                        status: { type: "string" }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      },
      LoginRequest: {
        type: "object",
        required: ["login", "password"],
        properties: {
          tenantCode: { type: "string", default: "default" },
          login: { type: "string", description: "Primary login identifier: mobile phone number. Legacy email accounts remain supported." },
          email: { type: "string", description: "Legacy alias for the login identifier." },
          phone: { type: "string", description: "Mobile phone login alias." },
          password: { type: "string", minLength: 1 }
        }
      },
      AuthSession: {
        type: "object",
        properties: { user: { type: "object" }, token: { type: "string" } }
      },
      PasswordChangeRequest: {
        type: "object",
        required: ["currentPassword", "newPassword"],
        properties: {
          currentPassword: { type: "string", minLength: 1 },
          newPassword: { type: "string", minLength: 12 }
        }
      },
      FirstLoginSetupRequest: {
        type: "object",
        required: ["currentPassword", "login", "name", "newPassword"],
        properties: {
          currentPassword: { type: "string", minLength: 1 },
          login: { type: "string", description: "Primary new login identifier: mobile phone number. Legacy email accounts remain supported." },
          email: { type: "string", description: "Legacy alias for the login identifier." },
          phone: { type: "string", description: "Mobile phone login alias." },
          name: { type: "string", minLength: 1 },
          newPassword: { type: "string", minLength: 12 }
        }
      },
      AccountActivationCompleteRequest: {
        type: "object",
        required: ["activationCode", "employeeNo", "name", "login", "password"],
        properties: {
          activationCode: { type: "string", minLength: 12 },
          employeeNo: { type: "string", minLength: 1 },
          name: { type: "string", minLength: 1 },
          login: { type: "string", description: "Primary new login identifier: mobile phone number. Legacy email accounts remain supported." },
          email: { type: "string", description: "Legacy alias for the login identifier." },
          phone: { type: "string", description: "Mobile phone login alias." },
          password: { type: "string", minLength: 12 },
          tenantCode: { type: "string", default: "default" }
        }
      },
      PasswordResetRequest: {
        type: "object",
        required: ["newPassword"],
        properties: {
          newPassword: { type: "string", minLength: 12 }
        }
      },
      UserCreateRequest: {
        type: "object",
        required: ["login", "name", "newPassword", "roleCodes"],
        properties: {
          login: { type: "string", description: "Primary login identifier: mobile phone number. Legacy email accounts remain supported." },
          email: { type: "string", description: "Legacy alias for the login identifier." },
          phone: { type: "string", description: "Mobile phone login alias." },
          name: { type: "string", minLength: 1 },
          newPassword: { type: "string", minLength: 12 },
          roleCodes: { type: "array", items: { type: "string" } },
          status: { type: "string", enum: ["ACTIVE", "DISABLED"], default: "ACTIVE" }
        }
      },
      EmployeeAccountSyncRequest: {
        type: "object",
        properties: {
          roleCodes: {
            type: "array",
            items: { type: "string" },
            default: ["employee-self-service"],
            description: "Roles assigned to every newly generated employee account."
          },
          emailDomain: { type: "string", default: "oa.local" },
          includeLeavers: { type: "boolean", default: false },
          status: { type: "string", enum: ["ACTIVE", "DISABLED"], default: "ACTIVE" }
        }
      },
      EmployeeAccountSyncResponse: {
        type: "object",
        properties: {
          createdCount: { type: "integer", minimum: 0 },
          skippedCount: { type: "integer", minimum: 0 },
          accountStats: { type: "object" },
          credentials: {
            type: "array",
            description: "One-time temporary credentials returned only to the authorized administrator and never written to audit logs.",
            items: {
              type: "object",
              properties: {
                employeeId: { type: "string" },
                employeeNo: { type: "string" },
                name: { type: "string" },
                email: { type: "string", description: "Stored login identifier. Prefer mobile phone numbers for new accounts." },
                temporaryPassword: { type: "string" },
                roleCodes: { type: "array", items: { type: "string" } }
              }
            }
          }
        }
      },
      AccountActivationCreateRequest: {
        type: "object",
        required: ["employeeId"],
        properties: {
          employeeId: { type: "string" },
          roleCodes: {
            type: "array",
            items: { type: "string" },
            default: ["employee-self-service"]
          },
          expiresInDays: { type: "integer", minimum: 1, maximum: 30, default: 7 }
        }
      },
      AccountActivationCreateResponse: {
        type: "object",
        properties: {
          activation: {
            type: "object",
            properties: {
              activationCode: { type: "string", description: "One-time code shown once to the administrator and never written to audit logs." },
              employeeId: { type: "string" },
              expiresAt: { type: "string", format: "date-time" },
              roleCodes: { type: "array", items: { type: "string" } },
              status: { type: "string" }
            }
          }
        }
      },
      PeopleOverview: {
        type: "object",
        properties: { people: { type: "object" } }
      },
      ExportRequest: {
        type: "object",
        required: ["businessReason"],
        properties: {
          businessReason: {
            type: "string",
            minLength: 4,
            maxLength: 240,
            description: "Required business purpose for auditability before any backend CSV export is generated."
          },
          scope: { type: "string" },
          filters: { type: "object" },
          includeSensitive: {
            type: "boolean",
            description: "Only accepted by endpoints that explicitly support denied sensitive-export audit handling."
          },
          limit: { type: "integer", minimum: 1, maximum: 500 }
        }
      },
      AuditIntegrityResponse: {
        type: "object",
        required: ["ok", "errors", "warnings", "summary"],
        properties: {
          ok: { type: "boolean" },
          errors: { type: "array", items: { type: "string" } },
          warnings: { type: "array", items: { type: "string" } },
          summary: {
            type: "object",
            required: ["totalRows", "signedRows", "unsignedRows", "firstSequence", "lastSequence", "lastHash"],
            properties: {
              totalRows: { type: "integer", minimum: 0 },
              signedRows: { type: "integer", minimum: 0 },
              unsignedRows: { type: "integer", minimum: 0 },
              firstSequence: { type: ["integer", "null"], minimum: 1 },
              lastSequence: { type: ["integer", "null"], minimum: 1 },
              lastHash: {
                type: ["string", "null"],
                pattern: "^[a-f0-9]{64}$",
                description: "Record hash at the tail of the tenant audit hash chain when signed rows exist."
              }
            }
          }
        }
      },
      EmployeePatch: {
        type: "object",
        additionalProperties: false,
        properties: {
          department: { type: "string" },
          departmentName: { type: "string" },
          role: { type: "string" },
          roleTitle: { type: "string" },
          status: { type: "string", enum: ["在职", "离职", "停用", "ACTIVE", "LEAVED", "SUSPENDED"] },
          leaveDate: { type: "string", format: "date" }
        }
      },
      ApprovalSubmit: {
        type: "object",
        required: ["definitionId", "title", "department"],
        properties: {
          definitionId: { type: "string" },
          title: { type: "string" },
          department: { type: "string" },
          formData: { type: "object" },
          idempotencyKey: { type: "string" }
        }
      },
      ApprovalDecision: {
        type: "object",
        required: ["action", "approverName"],
        properties: {
          action: { type: "string", enum: ["approve", "reject"] },
          approverName: { type: "string" },
          comment: { type: "string" },
          idempotencyKey: { type: "string" }
        }
      },
      ApprovalTransfer: {
        type: "object",
        required: ["target", "sourceApproverName"],
        properties: {
          target: { type: "string" },
          sourceApproverName: { type: "string" },
          reason: { type: "string" }
        }
      },
      CommentRequest: {
        type: "object",
        required: ["content"],
        properties: { content: { type: "string" } }
      },
      ApprovalRule: {
        type: "object",
        required: ["department", "templateId", "nodes"],
        properties: {
          id: { type: "string" },
          department: { type: "string" },
          templateId: { type: "string" },
          templateName: { type: "string" },
          enabled: { type: "boolean" },
          nodes: {
            type: "array",
            items: {
              type: "object",
              required: ["name", "approvers"],
              properties: {
                id: { type: "string" },
                name: { type: "string" },
                mode: { type: "string", enum: ["AND"] },
                approvers: { type: "array", items: { type: "string" } },
                approverUsers: {
                  type: "array",
                  description: "Backend-resolved active user bindings for each approver label; unresolved labels keep userId null.",
                  items: {
                    type: "object",
                    properties: {
                      name: { type: "string" },
                      userId: { type: "string", nullable: true },
                      email: { type: "string" },
                      employeeId: { type: "string", nullable: true }
                    }
                  }
                }
              }
            }
          }
        }
      },
      LeaveRequest: {
        type: "object",
        required: ["type", "dates", "days"],
        properties: {
          employee: { type: "string" },
          type: { type: "string" },
          dates: { type: "string" },
          days: { type: "number" },
          idempotencyKey: { type: "string" }
        }
      },
      PayrollBatch: {
        type: "object",
        required: ["batchNo", "period", "scope", "headcount", "totalAmount"],
        properties: {
          batchNo: { type: "string" },
          period: { type: "string" },
          scope: { type: "string" },
          headcount: { type: "integer" },
          totalAmount: { type: "number" },
          idempotencyKey: { type: "string" }
        }
      },
      FinanceRequestInput: {
        type: "object",
        required: ["type", "title", "amount"],
        properties: {
          requestNo: { type: "string" },
          type: { type: "string", enum: ["EXPENSE", "PAYMENT"] },
          title: { type: "string" },
          department: { type: "string" },
          amount: { type: "number" },
          currency: { type: "string", default: "CNY" },
          vendor: { type: "string" },
          paymentMethod: { type: "string" },
          purpose: { type: "string" },
          expenseType: { type: "string" },
          invoiceNo: { type: "string" },
          idempotencyKey: { type: "string" }
        }
      },
      FinanceRequest: {
        type: "object",
        required: ["id", "type", "title", "amount", "status"],
        properties: {
          id: { type: "string" },
          dbId: { type: "string" },
          type: { type: "string", enum: ["EXPENSE", "PAYMENT"] },
          typeLabel: { type: "string" },
          title: { type: "string" },
          applicant: { type: "string" },
          department: { type: "string" },
          amount: { type: "number" },
          currency: { type: "string" },
          vendor: { type: "string" },
          paymentMethod: { type: "string" },
          status: { type: "string" },
          workflowInstanceId: { type: "string" },
          workflowStatus: { type: "string" },
          createdAt: { type: "string" }
        }
      },
      FinanceRequestResponse: {
        type: "object",
        required: ["financeRequest"],
        properties: {
          financeRequest: { $ref: "#/components/schemas/FinanceRequest" },
          alreadySubmitted: { type: "boolean" }
        }
      },
      AssetInput: {
        type: "object",
        properties: {
          name: { type: "string" },
          category: { type: "string" },
          owner: { type: "string" },
          status: { type: "string" },
          location: { type: "string" }
        }
      },
      Asset: {
        type: "object",
        required: ["id", "name", "status", "qrVersion", "qrPayload"],
        properties: {
          id: { type: "string" },
          dbId: { type: "string" },
          name: { type: "string" },
          category: { type: "string" },
          owner: { type: "string" },
          status: { type: "string" },
          location: { type: "string" },
          qrVersion: { type: "integer", minimum: 1 },
          qrPayload: { type: "string", description: "Safe internal asset QR payload without sensitive employee or financial fields." },
          qrImage: { type: "string", description: "PNG data URL generated by the backend for browser rendering." },
          lastInventoryAt: { type: "string" },
          inventoryResult: { type: "string" }
        }
      },
      AssetResponse: {
        type: "object",
        required: ["asset"],
        properties: {
          asset: { $ref: "#/components/schemas/Asset" }
        }
      },
      AssetAction: {
        type: "object",
        required: ["action"],
        properties: {
          action: { type: "string", enum: ["borrow", "return", "repair", "inventory", "retire"] },
          note: { type: "string" }
        }
      },
      ResourceBooking: {
        type: "object",
        properties: {
          resourceId: { type: "string", description: "Preferred durable resource id when known." },
          resourceCode: { type: "string" },
          resourceName: { type: "string", description: "Accepted for UI forms and imports when id is not available." },
          bookingDate: { type: "string", format: "date" },
          period: { type: "string", example: "09:00-10:00" },
          startTime: { type: "string", example: "09:00" },
          endTime: { type: "string", example: "10:00" },
          startsAt: { type: "string", format: "date-time", description: "Alternative explicit start timestamp." },
          endsAt: { type: "string", format: "date-time", description: "Alternative explicit end timestamp." },
          dayIndex: { type: "integer", minimum: 0, maximum: 6, deprecated: true },
          purpose: { type: "string" },
          applicant: { type: "string", deprecated: true }
        }
      },
      FileUpload: {
        type: "object",
        required: ["fileName", "contentBase64"],
        properties: {
          fileName: { type: "string" },
          mimeType: { type: "string" },
          contentBase64: { type: "string" },
          module: { type: "string" },
          objectId: { type: "string" }
        }
      },
      DashboardHtmlImport: {
        type: "object",
        required: ["sourceName", "html"],
        properties: {
          sourceName: { type: "string" },
          html: { type: "string" }
        }
      },
      RolePermissionUpdate: {
        type: "object",
        required: ["permissionCodes"],
        properties: {
          permissionCodes: { type: "array", items: { type: "string" } }
        }
      },
      UserRoleUpdate: {
        type: "object",
        required: ["roleCodes"],
        properties: {
          roleCodes: { type: "array", items: { type: "string" } }
        }
      },
      UserStatusUpdate: {
        type: "object",
        required: ["status"],
        properties: {
          status: { type: "string", enum: ["ACTIVE", "DISABLED"] }
        }
      }
    }
  }
};
