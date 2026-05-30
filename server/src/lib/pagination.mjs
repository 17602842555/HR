export function boundedQueryLimit(value, { fallback = 100, max = 500 } = {}) {
  const raw = value === undefined || value === null || String(value).trim() === "" ? fallback : value;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), max);
}
