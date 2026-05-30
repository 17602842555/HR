const REDACTED = Object.freeze({
  phone: "[REDACTED:phone]",
  address: "[REDACTED:address]",
  idCard: "[REDACTED:id-card]",
  bank: "[REDACTED:bank]",
  salary: "[REDACTED:salary]",
  attachmentObjectKey: "[REDACTED:attachment-object-key]",
  secret: "[REDACTED:secret]"
});

function normalizeKey(key) {
  return String(key || "").replace(/[_\-\s]/g, "").toLowerCase();
}

function classifySensitiveField(key, path) {
  const normalized = normalizeKey(key);
  const pathText = path.map(normalizeKey).join(".");

  if (normalized === "objectkey" && /(attachment|attachments|file|files|upload|uploads|oss|cos|s3)/.test(pathText)) {
    return "attachmentObjectKey";
  }
  if (normalized === "objectkey") return "attachmentObjectKey";
  if (/(phone|mobile|telephone|tel|contactphone|手机号|电话)/.test(normalized)) return "phone";
  if (/(address|addr|住址|地址)/.test(normalized)) return "address";
  if (/(idcard|identitycard|identityno|citizenid|身份证)/.test(normalized)) return "idCard";
  if (/(bankaccount|bankcard|银行卡|银行账号|收款账号)/.test(normalized)) return "bank";
  if (/(salary|payroll|wage|compensation|薪资|工资|调薪)/.test(normalized)) return "salary";
  if (/^(password|passwordhash|token|authorization|cookie|secret)$/.test(normalized)) return "secret";
  return "";
}

function redactValue(value, kind) {
  if (value === undefined || value === null) return value;
  return REDACTED[kind] ?? "[REDACTED]";
}

function redactNode(value, path, seen) {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[REDACTED:circular]";
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item, index) => redactNode(item, [...path, String(index)], seen));
  }

  return Object.fromEntries(Object.entries(value).map(([key, entryValue]) => {
    const kind = classifySensitiveField(key, [...path, key]);
    if (kind) return [key, redactValue(entryValue, kind)];
    return [key, redactNode(entryValue, [...path, key], seen)];
  }));
}

export function redactAuditPayload(payload) {
  return redactNode(payload, [], new WeakSet());
}

export function createAuditEvent({ type, actorId, objectType, objectId, payload, occurredAt = new Date().toISOString() }) {
  return {
    type,
    actorId,
    objectType,
    objectId,
    occurredAt,
    payload: redactAuditPayload(payload)
  };
}
