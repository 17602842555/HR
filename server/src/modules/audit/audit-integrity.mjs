import { createHash } from "node:crypto";

export const auditIntegrityAlgorithm = "sha256-v1";

function canonicalize(value) {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.keys(value)
      .sort()
      .reduce((result, key) => {
        const next = value[key];
        if (next !== undefined) result[key] = canonicalize(next);
        return result;
      }, {});
  }
  return value;
}

function sha256(value) {
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

export function stripAuditIntegrity(metadata = {}) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return metadata || {};
  const { integrity: _integrity, ...rest } = metadata;
  return rest;
}

export function auditLogHashPayload(log = {}) {
  return {
    tenantId: log.tenantId || null,
    actorUserId: log.actorUserId || null,
    action: log.action || "",
    objectType: log.objectType || "",
    objectId: log.objectId || null,
    summary: log.summary || "",
    metadata: stripAuditIntegrity(log.metadata || {}),
    ipAddress: log.ipAddress || null,
    userAgent: log.userAgent || null
  };
}

export function computeAuditRecordHash(log = {}, {
  previousHash = null,
  sequence = 1
} = {}) {
  return sha256({
    algorithm: auditIntegrityAlgorithm,
    sequence,
    previousHash,
    payload: auditLogHashPayload(log)
  });
}

export function buildAuditIntegrityMetadata(log = {}, {
  previousHash = null,
  sequence = 1
} = {}) {
  const normalizedSequence = Number.isFinite(Number(sequence)) && Number(sequence) > 0
    ? Number(sequence)
    : 1;
  const normalizedPreviousHash = previousHash || null;
  return {
    algorithm: auditIntegrityAlgorithm,
    sequence: normalizedSequence,
    previousHash: normalizedPreviousHash,
    recordHash: computeAuditRecordHash(log, {
      previousHash: normalizedPreviousHash,
      sequence: normalizedSequence
    })
  };
}

function integrityFromLog(log = {}) {
  const integrity = log.metadata?.integrity;
  if (!integrity || typeof integrity !== "object" || Array.isArray(integrity)) return null;
  return integrity;
}

export function hasAuditIntegrity(log = {}) {
  const integrity = integrityFromLog(log);
  return Boolean(
    integrity
    && integrity.algorithm === auditIntegrityAlgorithm
    && Number.isFinite(Number(integrity.sequence))
    && typeof integrity.recordHash === "string"
    && /^[a-f0-9]{64}$/.test(integrity.recordHash)
  );
}

export async function latestAuditIntegrity(prisma, tenantId) {
  if (!prisma?.auditLog?.findMany || !tenantId) return { sequence: 0, recordHash: null };
  const rows = await prisma.auditLog.findMany({
    where: { tenantId },
    orderBy: [{ createdAt: "desc" }],
    take: 100
  });
  const signed = rows
    .filter(hasAuditIntegrity)
    .sort((a, b) => Number(integrityFromLog(b).sequence) - Number(integrityFromLog(a).sequence))[0];
  if (!signed) return { sequence: 0, recordHash: null };
  const integrity = integrityFromLog(signed);
  return {
    sequence: Number(integrity.sequence),
    recordHash: integrity.recordHash
  };
}

export async function attachAuditIntegrity(prisma, log = {}) {
  const latest = await latestAuditIntegrity(prisma, log.tenantId);
  const metadataWithoutIntegrity = stripAuditIntegrity(log.metadata || {});
  const payload = { ...log, metadata: metadataWithoutIntegrity };
  const integrity = buildAuditIntegrityMetadata(payload, {
    previousHash: latest.recordHash,
    sequence: latest.sequence + 1
  });
  return {
    ...payload,
    metadata: {
      ...metadataWithoutIntegrity,
      integrity
    }
  };
}

function sortByIntegritySequence(logs = []) {
  return [...logs].sort((a, b) => {
    const aSeq = Number(integrityFromLog(a)?.sequence || 0);
    const bSeq = Number(integrityFromLog(b)?.sequence || 0);
    if (aSeq !== bSeq) return aSeq - bSeq;
    return String(a.id || "").localeCompare(String(b.id || ""));
  });
}

export function verifyAuditIntegrityChain(logs = []) {
  const rows = Array.isArray(logs) ? logs : [];
  const signedRows = rows.filter((log) => Boolean(integrityFromLog(log)));
  const unsignedRows = rows.length - signedRows.length;
  const errors = [];
  const warnings = [];

  if (signedRows.length === 0) {
    warnings.push("no signed audit-log rows found");
    return {
      ok: true,
      errors,
      warnings,
      summary: {
        totalRows: rows.length,
        signedRows: 0,
        unsignedRows,
        firstSequence: null,
        lastSequence: null,
        lastHash: null
      }
    };
  }

  let previousHash = null;
  let previousSequence = 0;
  const ordered = sortByIntegritySequence(signedRows);

  ordered.forEach((log) => {
    const integrity = integrityFromLog(log);
    const sequence = Number(integrity?.sequence);
    if (integrity?.algorithm !== auditIntegrityAlgorithm) {
      errors.push(`audit log ${log.id || "(unknown)"} uses unsupported integrity algorithm.`);
    }
    if (!Number.isFinite(sequence) || sequence <= 0) {
      errors.push(`audit log ${log.id || "(unknown)"} has invalid integrity sequence.`);
      return;
    }
    if (sequence !== previousSequence + 1) {
      errors.push(`audit log ${log.id || "(unknown)"} integrity sequence is not contiguous.`);
    }
    if ((integrity.previousHash || null) !== previousHash) {
      errors.push(`audit log ${log.id || "(unknown)"} previousHash does not match prior recordHash.`);
    }
    const expectedHash = computeAuditRecordHash(log, { previousHash, sequence });
    if (integrity.recordHash !== expectedHash) {
      errors.push(`audit log ${log.id || "(unknown)"} recordHash does not match payload.`);
    }
    previousHash = integrity.recordHash || null;
    previousSequence = sequence;
  });

  if (unsignedRows > 0) {
    warnings.push(`${unsignedRows} legacy audit-log rows are unsigned`);
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    summary: {
      totalRows: rows.length,
      signedRows: signedRows.length,
      unsignedRows,
      firstSequence: Number(integrityFromLog(ordered[0])?.sequence || 0) || null,
      lastSequence: previousSequence || null,
      lastHash: previousHash
    }
  };
}
