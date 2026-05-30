# API Contract

The commercial backend exposes a machine-readable OpenAPI contract at:

```bash
GET /api/openapi.json
```

The same contract is generated from `server/src/openapi.mjs` into `docs/openapi.json`.

Validation commands:

```bash
node scripts/export-openapi.mjs --check
npm run preflight:commercial
npm run test:server
```

Contract scope:

- Auth/session, self password change, readiness, and OpenAPI discovery.
- People, sensitive reveal, controlled employee maintenance, and backend export with required business reason.
- Approval definitions, workflow submit/decision/transfer/withdraw/comment, and department approval rules.
- Attendance leave workflow, attendance record CSV export with required business reason, finance payment/expense request workflow linkage, backend finance request CSV export, and payroll workflow linkage.
- Asset lifecycle, resource booking/cancel with real date/time ranges and conflict checks, backend resource booking CSV export, file attachment through local or S3-compatible storage, dashboard HTML import with source-artifact preservation, IAM account creation/employee-account sync/role assignment/account status/password reset, audit, structured export-record lookup including business reason, `/api/audit/integrity` tamper-evident hash chain validation with an explicit `AuditIntegrityResponse` schema, analytics overview, and backend management analytics CSV export endpoints.

Production rule: update `server/src/openapi.mjs` and regenerate `docs/openapi.json` whenever a commercial API route is added, removed, or changes request/response semantics.
