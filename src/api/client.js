const DEFAULT_API_BASE_URL = "/api";
const DEFAULT_TIMEOUT_MS = 12000;

function getApiBaseUrl() {
  const configured = import.meta.env?.VITE_API_BASE_URL || DEFAULT_API_BASE_URL;
  return configured.replace(/\/+$/, "");
}

function toApiUrl(path, query) {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const url = `${getApiBaseUrl()}${normalizedPath}`;
  const search = query ? new URLSearchParams(query) : null;
  const queryString = search?.toString();
  return queryString ? `${url}?${queryString}` : url;
}

function isJsonBody(body) {
  const isFormData = typeof FormData !== "undefined" && body instanceof FormData;
  const isBlob = typeof Blob !== "undefined" && body instanceof Blob;
  return body && typeof body === "object" && !isFormData && !isBlob;
}

async function parseBody(response, responseType) {
  if (response.status === 204) return null;
  if (response.ok && responseType === "blob" && typeof response.blob === "function") {
    return response.blob();
  }
  if (response.ok && responseType === "arrayBuffer" && typeof response.arrayBuffer === "function") {
    return response.arrayBuffer();
  }
  const text = await response.text();
  if (!text) return null;
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) return text;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function errorMessageFromPayload(payload, fallback) {
  if (!payload) return fallback;
  if (typeof payload === "string") return payload;
  return payload.message || payload.error?.message || payload.error || fallback;
}

function errorCodeFromPayload(payload, fallback) {
  if (!payload || typeof payload === "string") return fallback;
  return payload.code || payload.error?.code || fallback;
}

export class ApiError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "ApiError";
    this.status = options.status || 0;
    this.code = options.code || "API_ERROR";
    this.details = options.details || null;
    this.method = options.method || "GET";
    this.url = options.url || "";
  }
}

export async function apiRequest(path, options = {}) {
  const {
    body,
    headers,
    method = body === undefined ? "GET" : "POST",
    query,
    responseType,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    ...rest
  } = options;
  const url = toApiUrl(path, query);
  const controller = new AbortController();
  const timeoutId = globalThis.setTimeout(() => controller.abort(), timeoutMs);
  const requestHeaders = new Headers(headers);
  const requestBody = isJsonBody(body) ? JSON.stringify(body) : body;

  if (isJsonBody(body) && !requestHeaders.has("content-type")) {
    requestHeaders.set("content-type", "application/json");
  }
  if (!requestHeaders.has("accept")) {
    requestHeaders.set("accept", "application/json");
  }

  try {
    const response = await fetch(url, {
      ...rest,
      body: requestBody,
      credentials: "include",
      headers: requestHeaders,
      method,
      signal: rest.signal || controller.signal
    });
    const payload = await parseBody(response, responseType);
    if (!response.ok) {
      throw new ApiError(errorMessageFromPayload(payload, `${method} ${url} failed`), {
        code: errorCodeFromPayload(payload, `HTTP_${response.status}`),
        details: payload,
        method,
        status: response.status,
        url
      });
    }
    return payload;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(error.name === "AbortError" ? "API request timed out" : "Unable to reach API service", {
      code: error.name === "AbortError" ? "API_TIMEOUT" : "NETWORK_ERROR",
      details: error,
      method,
      url
    });
  } finally {
    globalThis.clearTimeout(timeoutId);
  }
}
