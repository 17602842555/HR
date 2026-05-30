export class DomainError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.details = details;
  }
}

export class PermissionDeniedError extends DomainError {
  constructor(message, details = {}) {
    super("PERMISSION_DENIED", message, details);
    this.name = "PermissionDeniedError";
  }
}

export function invariant(condition, code, message, details = {}) {
  if (!condition) {
    throw new DomainError(code, message, details);
  }
}

