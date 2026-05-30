import { readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { requirePermission } from "../iam/route-guards.mjs";
import { readinessPayload } from "./runtime-readiness.mjs";

function knownGapFromMarkdownRow(line) {
  if (!line.startsWith("| GAP-")) return null;
  const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
  if (cells.length < 6) return null;
  const [id, status, owner, targetDate, gap, exitCriteria] = cells;
  return { id, status, owner, targetDate, gap, exitCriteria };
}

function publicKnownGapSummary(gap) {
  return {
    id: gap.id,
    status: gap.status,
    owner: gap.owner,
    targetDate: gap.targetDate,
    gap: gap.status === "Open"
      ? "仍有发布阻断项，需责任人完成目标验收后关闭。"
      : "发布阻断项已关闭。",
    exitCriteria: "详细验收材料保留在受控发布台账中；此接口仅返回状态摘要。"
  };
}

export function parseKnownGaps(markdown = "") {
  return String(markdown)
    .split(/\r?\n/)
    .map(knownGapFromMarkdownRow)
    .filter(Boolean);
}

async function loadKnownGaps(rootDir = process.cwd()) {
  try {
    const markdown = await readFile(join(rootDir, "docs", "KNOWN_GAPS.md"), "utf8");
    return {
      gaps: parseKnownGaps(markdown),
      sourceAvailable: true
    };
  } catch {
    return {
      gaps: [],
      sourceAvailable: false
    };
  }
}

function safeRelativeFile(rootDir, baseDir, filePath) {
  if (!filePath || isAbsolute(filePath)) return null;
  const resolved = resolve(rootDir, filePath);
  const relativeToBase = relative(baseDir, resolved);
  if (!relativeToBase || relativeToBase.startsWith("..") || isAbsolute(relativeToBase)) return null;
  return resolved;
}

const signoffDraftLabels = Object.freeze({
  hr: "HR 数据签署",
  secrets: "生产密钥签署",
  storage: "文件存储签署"
});
const hrReviewCountKeys = Object.freeze([
  "activeEmployees",
  "leavers",
  "femaleEmployees",
  "monthLeavers",
  "departments",
  "orgs",
  "totalReviewRows"
]);
const closureDefinitions = Object.freeze({
  "GAP-001": {
    category: "目标环境验证",
    relatedCheckIds: ["db-generate", "test-server", "build", "e2e"],
    nextAction: "保持目标环境 CI、API-required 前端和商业 smoke 证据随基础设施变更持续回归。"
  },
  "GAP-002": {
    category: "Docker 恢复演练",
    relatedCheckIds: ["drill-evidence", "doctor"],
    nextAction: "在具备 Docker 能力的主机完成 Compose 备份/恢复演练，并重新生成 full 商业证据。"
  },
  "GAP-003": {
    category: "生产环境与密钥",
    relatedCheckIds: ["production-env", "secrets-signoff", "doctor"],
    nextAction: "提交真实生产环境配置和 Security/Deployment 签署证据，再运行生产环境与密钥校验。"
  },
  "GAP-004": {
    category: "文件存储与恢复",
    relatedCheckIds: ["storage-signoff", "drill-evidence"],
    nextAction: "完成生产附件存储的独立备份、恢复演练和 Infrastructure/Security 签署。"
  },
  "GAP-005": {
    category: "HR/Product 数据签署",
    relatedCheckIds: ["hr-signoff"],
    nextAction: "由 HR/Product 复核脱敏人员包、导出策略和留存规则，并提交非示例签署证据。"
  }
});
const evidenceArtifactCatalog = Object.freeze([
  { id: "migration-lock", label: "迁移锁定清单", path: "prisma/migrations/migration-lock.json", phase: "schema", releaseRequired: true },
  { id: "openapi-contract", label: "OpenAPI 合同快照", path: "docs/openapi.json", phase: "contract", releaseRequired: true },
  { id: "sbom", label: "SPDX SBOM", path: "reports/commercial-evidence/sbom/latest-spdx.json", phase: "supply-chain", releaseRequired: true },
  { id: "hr-review-prep", label: "HR 脱敏审阅包", path: "reports/commercial-evidence/hr-data-review/latest-manifest.json", phase: "signoff-prep", releaseRequired: true },
  { id: "production-env-prep", label: "生产环境准备包", path: "reports/commercial-evidence/production-env-prep/latest-manifest.json", phase: "signoff-prep", releaseRequired: false },
  { id: "signoff-drafts", label: "签署草稿包", path: "reports/commercial-evidence/signoff-drafts/latest-manifest.json", phase: "signoff-prep", releaseRequired: false },
  { id: "production-secrets-signoff", label: "生产密钥正式签署", path: "docs/production-secrets-signoff.json", phase: "release-signoff", releaseRequired: true },
  { id: "hr-data-signoff", label: "HR/Product 正式签署", path: "docs/hr-data-signoff.json", phase: "release-signoff", releaseRequired: true },
  { id: "file-storage-signoff", label: "文件存储正式签署", path: "docs/file-storage-signoff.json", phase: "release-signoff", releaseRequired: true },
  { id: "docker-drill", label: "Docker 恢复演练证据", path: "commercial-evidence/latest-drill-summary.json", phase: "drill", releaseRequired: true },
  { id: "local-recovery", label: "本地恢复诊断证据", path: "commercial-evidence/latest-local-recovery-drill-summary.json", phase: "diagnostic", releaseRequired: false },
  { id: "gap-report", label: "GAP 闭环报告", path: "reports/commercial-evidence/latest-gap-report.json", phase: "handoff", releaseRequired: true },
  { id: "owner-handoff", label: "责任人分派清单", path: "reports/commercial-evidence/latest-owner-handoff-manifest.json", phase: "handoff", releaseRequired: false },
  { id: "signoff-validation", label: "受保护签署验证输出", path: "reports/commercial-evidence/signoff-validation/release-inputs.json", phase: "release-signoff", releaseRequired: true }
]);
const releaseArtifactIdsByGap = Object.freeze({
  "GAP-001": ["migration-lock", "openapi-contract", "sbom"],
  "GAP-002": ["docker-drill"],
  "GAP-003": ["production-secrets-signoff", "signoff-validation"],
  "GAP-004": ["file-storage-signoff", "docker-drill", "signoff-validation"],
  "GAP-005": ["hr-review-prep", "hr-data-signoff", "signoff-validation"]
});
const evidenceArtifactCatalogById = new Map(evidenceArtifactCatalog.map((artifact) => [artifact.id, artifact]));

function summarizeSignoffDraft(kind, draft) {
  const approvals = Array.isArray(draft?.approvals) ? draft.approvals : [];
  const openExceptions = Array.isArray(draft?.openExceptions) ? draft.openExceptions : [];
  const pendingApprovals = approvals.filter((approval) => approval.decision !== "approved").length;
  return {
    id: kind,
    draft: draft?.draft === true,
    label: signoffDraftLabels[kind] || kind,
    openExceptionCount: openExceptions.length,
    pendingApprovalCount: pendingApprovals,
    status: openExceptions.length || pendingApprovals || draft?.draft === true ? "草稿待复核" : "可进入验证"
  };
}

export async function loadSignoffDrafts(rootDir = process.cwd()) {
  const baseDir = resolve(rootDir, "reports", "commercial-evidence", "signoff-drafts");
  try {
    const manifestPath = join(baseDir, "latest-manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const files = manifest?.files && typeof manifest.files === "object" ? manifest.files : {};
    const draftKinds = [];

    for (const kind of ["hr", "secrets", "storage"]) {
      const draftPath = safeRelativeFile(rootDir, baseDir, files[kind]);
      if (!draftPath) {
        draftKinds.push({
          id: kind,
          draft: true,
          label: signoffDraftLabels[kind],
          openExceptionCount: 1,
          pendingApprovalCount: 0,
          status: "草稿缺失"
        });
        continue;
      }
      try {
        const draft = JSON.parse(await readFile(draftPath, "utf8"));
        draftKinds.push(summarizeSignoffDraft(kind, draft));
      } catch {
        draftKinds.push({
          id: kind,
          draft: true,
          label: signoffDraftLabels[kind],
          openExceptionCount: 1,
          pendingApprovalCount: 0,
          status: "草稿不可读"
        });
      }
    }

    return {
      available: true,
      draftCount: draftKinds.length,
      generatedAt: manifest.generatedAt || null,
      kinds: draftKinds,
      nextCommandCount: Array.isArray(manifest.nextCommands) ? manifest.nextCommands.length : 0,
      openExceptionCount: draftKinds.reduce((sum, item) => sum + item.openExceptionCount, 0),
      pendingApprovalCount: draftKinds.reduce((sum, item) => sum + item.pendingApprovalCount, 0),
      releaseEvidence: false,
      status: "draft-only"
    };
  } catch {
    return {
      available: false,
      draftCount: 0,
      generatedAt: null,
      kinds: [],
      nextCommandCount: 0,
      openExceptionCount: 0,
      pendingApprovalCount: 0,
      releaseEvidence: false,
      status: "missing"
    };
  }
}

function safeCountMap(counts = {}) {
  return Object.fromEntries(hrReviewCountKeys.map((key) => {
    const number = Number(counts?.[key] || 0);
    return [key, Number.isFinite(number) && number >= 0 ? number : 0];
  }));
}

function missingHrDataReview() {
  return {
    available: false,
    counts: safeCountMap(),
    generatedAt: null,
    nextCommandCount: 0,
    noSensitiveFields: false,
    releaseEvidence: false,
    rowCount: 0,
    status: "missing",
    unsafeFileCount: 0
  };
}

export async function loadHrDataReview(rootDir = process.cwd()) {
  const baseDir = resolve(rootDir, "reports", "commercial-evidence", "hr-data-review");
  try {
    const manifest = JSON.parse(await readFile(join(baseDir, "latest-manifest.json"), "utf8"));
    const files = manifest?.files && typeof manifest.files === "object" ? manifest.files : {};
    const requiredFiles = ["peopleReviewCsv", "summary", "readme", "manifest"];
    const unsafeFileCount = requiredFiles.filter((key) => !safeRelativeFile(rootDir, baseDir, files[key])).length;
    const summaryPath = safeRelativeFile(rootDir, baseDir, files.summary);
    let summary = null;
    let summaryReadable = false;
    if (summaryPath) {
      try {
        summary = JSON.parse(await readFile(summaryPath, "utf8"));
        summaryReadable = true;
      } catch {
        summaryReadable = false;
      }
    }
    const counts = safeCountMap(summary?.source?.counts || manifest?.source?.counts || {});
    const rowCount = Number(summary?.reviewCsv?.rowCount || counts.totalReviewRows || 0);
    const noSensitiveFields = unsafeFileCount === 0
      && manifest?.noSensitiveFields === true
      && summary?.reviewPolicy?.noSensitiveFields === true;
    return {
      available: true,
      counts: {
        ...counts,
        totalReviewRows: counts.totalReviewRows || (Number.isFinite(rowCount) && rowCount >= 0 ? rowCount : 0)
      },
      generatedAt: manifest.generatedAt || summary?.generatedAt || null,
      nextCommandCount: Array.isArray(manifest.nextCommands) ? manifest.nextCommands.length : 0,
      noSensitiveFields,
      releaseEvidence: false,
      rowCount: Number.isFinite(rowCount) && rowCount >= 0 ? rowCount : 0,
      status: unsafeFileCount > 0
        ? "清单路径异常"
        : summaryReadable
          ? noSensitiveFields ? "已生成" : "需复核"
          : "摘要不可读",
      unsafeFileCount
    };
  } catch {
    return missingHrDataReview();
  }
}

function safeNonNegativeNumber(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function summarizeGapReportOwner(owner = {}) {
  const gapIds = Array.isArray(owner.gapIds)
    ? owner.gapIds.filter((id) => /^GAP-\d{3}$/.test(String(id)))
    : [];
  const targetDates = Array.isArray(owner.targetDates)
    ? owner.targetDates.filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(String(date)))
    : [];
  const blockerCount = Array.isArray(owner.blockers) ? owner.blockers.length : 0;
  const validationCommandCount = Array.isArray(owner.validationCommands) ? owner.validationCommands.length : 0;
  return {
    owner: String(owner.owner || "Unassigned").slice(0, 80),
    blockerCount,
    gapCount: gapIds.length,
    gapIds,
    status: blockerCount > 0 ? "待闭环" : "可复核",
    targetDates,
    validationCommandCount
  };
}

function safeCheckId(value) {
  const id = String(value || "").trim();
  return /^[a-z0-9][a-z0-9-]{0,80}$/.test(id) ? id : "unknown";
}

function safeExitCode(value) {
  const number = Number(value);
  return Number.isInteger(number) ? number : null;
}

function summarizeEvidenceCheck(check = {}) {
  const exitCode = safeExitCode(check.exitCode);
  return {
    id: safeCheckId(check.id),
    exitCode,
    required: check.required === true,
    status: exitCode === 0 ? "pass" : "failed"
  };
}

function publicArtifactId(index) {
  return `artifact-${String(index + 1).padStart(2, "0")}`;
}

function summarizeArtifactInventory(artifacts = {}) {
  const files = artifacts?.files && typeof artifacts.files === "object" ? artifacts.files : {};
  const trackedFiles = Object.values(files);
  const items = evidenceArtifactCatalog.map((artifact, index) => {
    const present = files[artifact.path]?.exists === true;
    return {
      id: publicArtifactId(index),
      label: artifact.label,
      phase: artifact.phase,
      present,
      releaseRequired: artifact.releaseRequired === true,
      status: present ? "已归档" : artifact.releaseRequired ? "缺失" : "待生成"
    };
  });
  const releaseRequiredCount = items.filter((item) => item.releaseRequired).length;
  const missingReleaseArtifactCount = items.filter((item) => item.releaseRequired && !item.present).length;
  return {
    available: Object.keys(files).length > 0 || Array.isArray(artifacts?.migrations),
    itemCount: items.length,
    items,
    migrationCount: Array.isArray(artifacts?.migrations) ? artifacts.migrations.length : 0,
    missingFileCount: trackedFiles.filter((file) => file?.exists !== true).length,
    missingReleaseArtifactCount,
    presentFileCount: trackedFiles.filter((file) => file?.exists === true).length,
    releaseRequiredCount,
    trackedFileCount: trackedFiles.length
  };
}

function releaseClosureStatus(gap, relatedChecks) {
  if (gap.status !== "Open" && relatedChecks.every((check) => check.status === "pass")) return "可复核关闭";
  if (gap.status !== "Open") return "已缓解";
  if (relatedChecks.some((check) => check.status === "failed")) return "证据未通过";
  if (relatedChecks.some((check) => check.status === "missing")) return "等待证据";
  return "待闭环";
}

export function buildReleaseClosurePlan(gaps = [], latestEvidence = missingLatestCommercialEvidence()) {
  const checksById = new Map((latestEvidence.checks || []).map((check) => [check.id, check]));
  return gaps.map((gap) => {
    const definition = closureDefinitions[gap.id] || {
      category: "发布缺口",
      relatedCheckIds: [],
      nextAction: "由责任人补充目标环境证据，并重新生成 full 商业证据。"
    };
    const relatedChecks = definition.relatedCheckIds.map((id) => {
      const check = checksById.get(id);
      return {
        id,
        status: check?.status || "missing"
      };
    });
    const failedCheckCount = relatedChecks.filter((check) => check.status === "failed").length;
    const missingCheckCount = relatedChecks.filter((check) => check.status === "missing").length;
    return {
      id: gap.id,
      category: definition.category,
      evidenceStatus: releaseClosureStatus(gap, relatedChecks),
      failedCheckCount,
      missingCheckCount,
      nextAction: definition.nextAction,
      owner: gap.owner,
      relatedCheckIds: definition.relatedCheckIds,
      releaseBlocking: gap.status === "Open" || failedCheckCount > 0,
      status: gap.status,
      targetDate: gap.targetDate
    };
  });
}

export function buildOwnerEvidenceChecklist(gaps = [], closurePlan = [], latestEvidence = missingLatestCommercialEvidence()) {
  const artifactItemsByLabel = new Map((latestEvidence.artifactSummary?.items || [])
    .map((item) => [item.label, item]));
  const closureById = new Map((closurePlan || []).map((item) => [item.id, item]));
  return gaps.map((gap) => {
    const closure = closureById.get(gap.id);
    const artifactIds = releaseArtifactIdsByGap[gap.id] || [];
    const artifacts = artifactIds
      .map((artifactId) => {
        const catalogItem = evidenceArtifactCatalogById.get(artifactId);
        if (!catalogItem) return null;
        const inventoryItem = artifactItemsByLabel.get(catalogItem.label);
        const present = inventoryItem?.present === true;
        return {
          label: catalogItem.label,
          phase: catalogItem.phase,
          present,
          releaseRequired: catalogItem.releaseRequired === true,
          status: present ? "已归档" : catalogItem.releaseRequired ? "缺失" : "待生成"
        };
      })
      .filter(Boolean);
    const missingReleaseArtifacts = artifacts.filter((artifact) => artifact.releaseRequired && !artifact.present);
    return {
      id: gap.id,
      artifactCount: artifacts.length,
      artifacts,
      category: closure?.category || closureDefinitions[gap.id]?.category || "发布缺口",
      evidenceStatus: closure?.evidenceStatus || (missingReleaseArtifacts.length ? "等待证据" : "待闭环"),
      missingArtifactCount: missingReleaseArtifacts.length,
      nextAction: closure?.nextAction || closureDefinitions[gap.id]?.nextAction || "由责任人补充目标环境证据，并重新生成 full 商业证据。",
      owner: gap.owner,
      presentArtifactCount: artifacts.filter((artifact) => artifact.present).length,
      releaseBlocking: closure?.releaseBlocking ?? (gap.status === "Open" || missingReleaseArtifacts.length > 0),
      requiredArtifactCount: artifacts.filter((artifact) => artifact.releaseRequired).length,
      status: gap.status,
      targetDate: gap.targetDate
    };
  });
}

function summarizeTargetProfile(profile = {}) {
  const database = profile.database && typeof profile.database === "object" ? profile.database : {};
  return {
    database: {
      configured: database.configured === true,
      target: database.configured === true
        ? database.isLocal === true ? "local-postgresql" : "non-local-postgresql"
        : "unconfigured"
    },
    e2eIncluded: profile.e2eIncluded === true,
    evidenceClass: String(profile.evidenceClass || "missing").slice(0, 80),
    productionEvidenceReady: profile.productionEvidenceReady === true,
    productionRuntime: profile.productionRuntime === true,
    signoffChecks: {
      cloudflareBackend: profile.signoffChecks?.cloudflareBackend === true,
      drillEvidence: profile.signoffChecks?.drillEvidence === true,
      hr: profile.signoffChecks?.hr === true,
      productionEnv: profile.signoffChecks?.productionEnv === true,
      secrets: profile.signoffChecks?.secrets === true,
      storage: profile.signoffChecks?.storage === true
    },
    viteDemoFallback: String(profile.viteDemoFallback || "unset").slice(0, 20),
    viteRequireApi: String(profile.viteRequireApi || "unset").slice(0, 20),
    warningCount: Array.isArray(profile.warnings) ? profile.warnings.length : 0
  };
}

function missingLatestCommercialEvidence() {
  return {
    artifactSummary: summarizeArtifactInventory(),
    available: false,
    checkCount: 0,
    checks: [],
    e2eIncluded: false,
    evidenceMode: "missing",
    generatedAt: null,
    openGapCount: 0,
    releaseBlockerCount: 0,
    releaseCandidateReady: false,
    releaseEvidence: false,
    requiredFailedCount: 0,
    status: "missing",
    targetProfile: summarizeTargetProfile(),
    warningCheckCount: 0
  };
}

export async function loadLatestCommercialEvidence(rootDir = process.cwd()) {
  try {
    const report = JSON.parse(await readFile(
      join(rootDir, "reports", "commercial-evidence", "latest.json"),
      "utf8"
    ));
    const checks = Array.isArray(report?.checks) ? report.checks.map(summarizeEvidenceCheck) : [];
    const requiredFailedCount = Array.isArray(report?.summary?.requiredFailed)
      ? report.summary.requiredFailed.length
      : checks.filter((check) => check.required && check.exitCode !== 0).length;
    const warningCheckCount = Array.isArray(report?.summary?.warningChecks)
      ? report.summary.warningChecks.length
      : checks.filter((check) => !check.required && check.exitCode !== 0).length;
    const openGapCount = safeNonNegativeNumber(report?.summary?.openGapCount);
    const releaseCandidateReady = report?.summary?.releaseCandidateReady === true;
    const releaseBlockerCount = Array.isArray(report?.summary?.releaseBlockers)
      ? report.summary.releaseBlockers.length
      : 0;
    const e2eIncluded = report?.summary?.e2eIncluded === true
      || checks.some((check) => check.id === "e2e");
    const targetProfile = summarizeTargetProfile(report?.targetProfile);
    const releaseEvidence = report?.summary?.ok === true
      && releaseCandidateReady
      && report?.evidenceMode === "full"
      && requiredFailedCount === 0
      && warningCheckCount === 0
      && openGapCount === 0
      && targetProfile.evidenceClass === "production-release-evidence"
      && targetProfile.productionRuntime === true
      && targetProfile.productionEvidenceReady === true
      && targetProfile.e2eIncluded === true
      && targetProfile.database.target === "non-local-postgresql"
      && targetProfile.viteRequireApi === "1"
      && targetProfile.viteDemoFallback === "0";

    return {
      artifactSummary: summarizeArtifactInventory(report?.artifacts),
      available: true,
      checkCount: checks.length,
      checks,
      e2eIncluded,
      evidenceMode: String(report?.evidenceMode || "missing").slice(0, 20),
      generatedAt: report?.generatedAt || null,
      openGapCount,
      releaseBlockerCount,
      releaseCandidateReady,
      releaseEvidence,
      requiredFailedCount,
      status: releaseEvidence
        ? "production-release-evidence"
        : releaseCandidateReady ? "needs-release-gate-review"
        : report?.evidenceMode === "quick" ? "quick-diagnostic-evidence"
          : targetProfile.evidenceClass === "production-release-evidence" ? "needs-release-gate-review" : "non-production-evidence",
      targetProfile,
      warningCheckCount
    };
  } catch {
    return missingLatestCommercialEvidence();
  }
}

export async function loadGapActionReport(rootDir = process.cwd()) {
  try {
    const report = JSON.parse(await readFile(
      join(rootDir, "reports", "commercial-evidence", "latest-gap-report.json"),
      "utf8"
    ));
    const owners = Array.isArray(report?.owners) ? report.owners.map(summarizeGapReportOwner) : [];
    return {
      available: true,
      blockedGapCount: safeNonNegativeNumber(report?.summary?.blockedGapCount),
      generatedAt: report?.generatedAt || report?.summary?.generatedAt || null,
      ownerCount: safeNonNegativeNumber(report?.summary?.ownerCount || owners.length),
      owners,
      releaseEvidence: false,
      releaseReady: report?.releaseReady === true,
      status: report?.releaseReady === true ? "可进入发布门禁" : "责任人闭环中",
      warningCheckCount: safeNonNegativeNumber(report?.summary?.warningCheckCount)
    };
  } catch {
    return {
      available: false,
      blockedGapCount: 0,
      generatedAt: null,
      ownerCount: 0,
      owners: [],
      releaseEvidence: false,
      releaseReady: false,
      status: "missing",
      warningCheckCount: 0
    };
  }
}

function runtimeSummary(config) {
  return {
    apiBodyLimitBytes: config.apiBodyLimitBytes,
    cookieMaxAgeSeconds: config.cookieMaxAgeSeconds,
    environment: config.isProduction ? "production" : "development",
    fileStorageConfigured: Boolean(config.fileStorageDirExplicit),
    fileStorageDriver: config.fileStorageDriver,
    fileUploadMaxBytes: config.fileMaxUploadBytes,
    importMaxHtmlBytes: config.importMaxHtmlBytes,
    isProduction: config.isProduction,
    runDbSeed: Boolean(config.runDbSeed),
    service: "deep-oa-api",
    trustProxy: Boolean(config.trustProxy),
    webOriginCount: config.webOrigin?.length || 0
  };
}

function controlSummary(config) {
  return [
    {
      id: "production-mode",
      label: "生产运行模式",
      ok: Boolean(config.isProduction),
      status: config.isProduction ? "已启用" : "未启用",
      detail: config.isProduction ? "生产环境强校验已生效" : "当前为开发/演示运行环境，不能作为发布证据"
    },
    {
      id: "explicit-origin",
      label: "访问源白名单",
      ok: Boolean(config.webOrigin?.length) && !config.webOrigin.includes("*"),
      status: `${config.webOrigin?.length || 0} 个来源`,
      detail: "仅返回来源数量，不暴露具体域名"
    },
    {
      id: "body-limit",
      label: "上传与导入体积限制",
      ok: true,
      status: `${Math.round(config.apiBodyLimitBytes / 1024 / 1024)} MB`,
      detail: "API 请求体限制已覆盖附件上传和 HTML 数据导入"
    },
    {
      id: "file-storage",
      label: "文件存储配置",
      ok: !config.isProduction || config.fileStorageDriver === "s3" || Boolean(config.fileStorageDirExplicit),
      status: config.fileStorageDriver === "s3"
        ? "对象存储"
        : config.fileStorageDirExplicit ? "显式配置" : "本地默认",
      detail: config.fileStorageDriver === "s3"
        ? "附件与导入源文件使用 S3 兼容对象存储驱动"
        : config.fileStorageDirExplicit ? "使用显式 FILE_STORAGE_DIR" : "开发默认目录不能作为生产持久化证据"
    },
    {
      id: "seed-guard",
      label: "生产初始化保护",
      ok: !config.isProduction || !config.runDbSeed,
      status: config.runDbSeed ? "允许初始化" : "未开启初始化",
      detail: "生产环境初始化需显式审批并通过默认密码保护"
    }
  ];
}

function releaseGateSummary({ dependencies, gaps, gapActionReport, gapSourceAvailable, hrDataReview, latestEvidence, runtime, signoffDrafts }) {
  const blockers = [];
  const warnings = [];
  const openGaps = gaps.filter((gap) => gap.status === "Open");

  if (!dependencies.ok) {
    if (dependencies.database !== "ok") blockers.push("数据库不可用");
    if (dependencies.databaseIntegrity !== "ok") blockers.push("数据库审计/导入/导出不可篡改触发器未验证");
    if (dependencies.fileStorage !== "ok") blockers.push("文件存储不可写");
  }
  if (!runtime.isProduction) blockers.push("当前不是 production 运行环境");
  if (!gapSourceAvailable) blockers.push("无法读取 docs/KNOWN_GAPS.md 商用缺口台账");
  openGaps.forEach((gap) => blockers.push(`${gap.id} 仍为 Open`));
  if (runtime.runDbSeed) warnings.push("RUN_DB_SEED 已开启，生产发布前需确认初始化审批证据");
  if (!hrDataReview?.available) warnings.push("HR 脱敏审阅包尚未生成，GAP-005 签收前缺少安全复核材料");
  if (hrDataReview?.available && hrDataReview.releaseEvidence === false) {
    warnings.push("HR 脱敏审阅包仅用于签收前复核，不能替代正式 HR/Product 签署证据");
  }
  if (hrDataReview?.available && hrDataReview.noSensitiveFields !== true) {
    warnings.push("HR 脱敏审阅包未通过无敏感字段清单检查");
  }
  if (!signoffDrafts?.available) warnings.push("签署草稿尚未生成，GAP-003/004/005 需要 reviewer-ready 草稿或正式签署证据");
  if (signoffDrafts?.available && signoffDrafts.releaseEvidence === false) {
    warnings.push("签署草稿仅用于复核准备，不能替代正式发布证据");
  }
  if (!gapActionReport?.available) warnings.push("GAP 责任人闭环报告尚未生成，管理员看不到按责任人分派的外部闭环动作");
  if (gapActionReport?.available && gapActionReport.releaseEvidence === false) {
    warnings.push("GAP 责任人闭环报告仅用于动作分派，不能替代正式发布证据");
  }
  if (!latestEvidence?.available) {
    blockers.push("缺少最新商业证据包");
  } else {
    if (latestEvidence.releaseCandidateReady !== true) blockers.push("最新商业证据摘要未达到 releaseCandidateReady");
    if (latestEvidence.releaseEvidence !== true) blockers.push("最新商业证据包不是可接受的生产发布证据");
    if (latestEvidence.evidenceMode !== "full") blockers.push("最新商业证据包不是 full 模式，不能作为发布候选证据");
    if (latestEvidence.e2eIncluded !== true) blockers.push("最新商业证据缺少 E2E 检查");
    if (latestEvidence.requiredFailedCount > 0) blockers.push(`最新商业证据有 ${latestEvidence.requiredFailedCount} 个必需检查失败`);
    if (latestEvidence.warningCheckCount > 0) warnings.push(`最新商业证据有 ${latestEvidence.warningCheckCount} 个警告检查未通过`);
    if (latestEvidence.releaseBlockerCount > 0) warnings.push(`最新商业证据摘要列出 ${latestEvidence.releaseBlockerCount} 个发布阻断原因`);
    if (latestEvidence.targetProfile?.database?.target === "local-postgresql") {
      warnings.push("最新商业证据连接的是本地 PostgreSQL，不能作为生产发布证据");
    }
  }

  return {
    blockers,
    openGapCount: openGaps.length,
    releaseReady: blockers.length === 0,
    warnings
  };
}

export async function buildSystemReadiness(app, request) {
  const dependencies = await readinessPayload(app, request);
  const { gaps, sourceAvailable } = await loadKnownGaps();
  const signoffDrafts = await loadSignoffDrafts();
  const hrDataReview = await loadHrDataReview();
  const gapActionReport = await loadGapActionReport();
  const latestEvidence = await loadLatestCommercialEvidence();
  const runtime = runtimeSummary(app.config);
  const closurePlan = buildReleaseClosurePlan(gaps, latestEvidence);
  const ownerEvidenceChecklist = buildOwnerEvidenceChecklist(gaps, closurePlan, latestEvidence);
  return {
    closurePlan,
    controls: controlSummary(app.config),
    dependencies,
    generatedAt: new Date().toISOString(),
    knownGapSourceAvailable: sourceAvailable,
    knownGaps: gaps.map(publicKnownGapSummary),
    ownerEvidenceChecklist,
    releaseGate: releaseGateSummary({
      dependencies,
      gaps,
      gapActionReport,
      gapSourceAvailable: sourceAvailable,
      hrDataReview,
      latestEvidence,
      runtime,
      signoffDrafts
    }),
    gapActionReport,
    hrDataReview,
    latestEvidence,
    runtime,
    signoffDrafts
  };
}

export async function registerSystemRoutes(app) {
  app.get("/api/system/readiness", { preHandler: app.authenticate }, async (request) => {
    await requirePermission(app, request, { module: "system", action: "admin" });
    return { systemReadiness: await buildSystemReadiness(app, request) };
  });
}
