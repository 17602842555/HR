const STORAGE_VERSION = 1;
const STORAGE_KEY = "oa-enterprise-system-v1";

export function readStoredState() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed?.version === STORAGE_VERSION ? parsed.state : null;
  } catch {
    return null;
  }
}

export function writeStoredState(state) {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: STORAGE_VERSION, state }));
}

export function clearStoredState() {
  window.localStorage.removeItem(STORAGE_KEY);
}
