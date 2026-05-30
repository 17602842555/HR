import { resolveApiPolicy } from "../config/apiPolicy.mjs";

const STORAGE_VERSION = 1;
const STORAGE_KEY = "oa-enterprise-system-v1";

function currentEnv() {
  return import.meta.env || {};
}

function currentStorage(storage) {
  return storage || globalThis.window?.localStorage || null;
}

export function localStatePersistenceAllowed(env = currentEnv()) {
  return resolveApiPolicy(env).allowDemoFallback;
}

export function readStoredState({ env = currentEnv(), storage } = {}) {
  if (!localStatePersistenceAllowed(env)) return null;
  const localStorage = currentStorage(storage);
  if (!localStorage) return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed?.version === STORAGE_VERSION ? parsed.state : null;
  } catch {
    return null;
  }
}

export function writeStoredState(state, { env = currentEnv(), storage } = {}) {
  const localStorage = currentStorage(storage);
  if (!localStorage) return false;
  if (!localStatePersistenceAllowed(env)) {
    localStorage.removeItem(STORAGE_KEY);
    return false;
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: STORAGE_VERSION, state }));
  return true;
}

export function clearStoredState({ storage } = {}) {
  currentStorage(storage)?.removeItem(STORAGE_KEY);
}

export { STORAGE_KEY, STORAGE_VERSION };
