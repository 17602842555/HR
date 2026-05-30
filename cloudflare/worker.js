const SECURITY_HEADERS = {
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY"
};

function json(payload, init = {}) {
  return new Response(JSON.stringify(payload), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...SECURITY_HEADERS,
      ...(init.headers || {})
    }
  });
}

function withSecurityHeaders(response) {
  const headers = new Headers(response.headers);
  Object.entries(SECURITY_HEADERS).forEach(([key, value]) => headers.set(key, value));
  if (!headers.has("cache-control") && headers.get("content-type")?.includes("text/html")) {
    headers.set("cache-control", "no-store");
  }
  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText
  });
}

const LOCAL_HOSTNAMES = new Set([
  "0.0.0.0",
  "localhost",
  "127.0.0.1",
  "::1",
  "0:0:0:0:0:0:0:1"
]);

function normalizedHostname(hostname) {
  return String(hostname || "").trim().toLowerCase().replace(/^\[|\]$/g, "");
}

function isPrivateIpv4(hostname) {
  const parts = String(hostname || "").split(".");
  if (parts.length !== 4) return false;
  const numbers = parts.map((part) => Number.parseInt(part, 10));
  if (numbers.some((number, index) => !Number.isInteger(number) || String(number) !== parts[index] || number < 0 || number > 255)) {
    return false;
  }
  const [first, second] = numbers;
  return first === 0
    || first === 10
    || first === 127
    || (first === 169 && second === 254)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168)
    || (first === 100 && second >= 64 && second <= 127);
}

function isUnsafeHostname(hostname) {
  const value = normalizedHostname(hostname);
  if (LOCAL_HOSTNAMES.has(value) || value.endsWith(".local")) return true;
  if (isPrivateIpv4(value)) return true;
  if (value.includes(":")) {
    return value.startsWith("fe80:")
      || value.startsWith("fc")
      || value.startsWith("fd");
  }
  return false;
}

export function validateApiOrigin(rawValue, requestUrl) {
  const value = String(rawValue || "").trim();
  if (!value) {
    return {
      code: "api_origin_not_configured",
      configured: false,
      message: "Cloudflare Worker 缺少 API_ORIGIN 变量，不能转发 OA 后端请求。",
      ok: false
    };
  }

  let targetUrl;
  try {
    targetUrl = new URL(value);
  } catch {
    return {
      code: "api_origin_invalid",
      configured: true,
      message: "Cloudflare Worker 的 API_ORIGIN 不是有效的 HTTPS 后端地址。",
      ok: false
    };
  }

  if (targetUrl.protocol !== "https:") {
    return {
      code: "api_origin_invalid",
      configured: true,
      message: "Cloudflare Worker 的 API_ORIGIN 必须使用 HTTPS。",
      ok: false
    };
  }

  if (targetUrl.username || targetUrl.password || isUnsafeHostname(targetUrl.hostname)) {
    return {
      code: "api_origin_unsafe",
      configured: true,
      message: "Cloudflare Worker 的 API_ORIGIN 指向了不允许的后端地址。",
      ok: false
    };
  }

  const incomingOrigin = new URL(requestUrl).origin;
  if (targetUrl.origin === incomingOrigin) {
    return {
      code: "api_origin_loop",
      configured: true,
      message: "Cloudflare Worker 的 API_ORIGIN 不能和前端部署地址相同。",
      ok: false
    };
  }

  return {
    configured: true,
    ok: true,
    url: targetUrl
  };
}

async function proxyApi(request, env) {
  const originValidation = validateApiOrigin(env.API_ORIGIN, request.url);
  if (!originValidation.ok) {
    return json({
      error: originValidation.code,
      message: originValidation.message
    }, { status: 503 });
  }

  const incomingUrl = new URL(request.url);
  const targetUrl = new URL(originValidation.url);
  targetUrl.pathname = incomingUrl.pathname;
  targetUrl.search = incomingUrl.search;

  const headers = new Headers(request.headers);
  headers.set("X-Forwarded-Host", incomingUrl.host);
  headers.set("X-Forwarded-Proto", incomingUrl.protocol.replace(":", ""));
  headers.set("X-Request-Source", "cloudflare-worker");

  const proxied = await fetch(targetUrl, {
    body: ["GET", "HEAD"].includes(request.method) ? undefined : request.body,
    headers,
    method: request.method,
    redirect: "manual"
  });
  return withSecurityHeaders(proxied);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/edge/health") {
      const originValidation = validateApiOrigin(env.API_ORIGIN, request.url);
      return json({
        apiOriginConfigured: originValidation.configured,
        apiOriginError: originValidation.ok ? null : originValidation.code,
        apiOriginValid: originValidation.ok,
        ok: true,
        service: "deep-oa-cloudflare-edge"
      });
    }

    if (url.pathname.startsWith("/api/")) {
      return proxyApi(request, env);
    }

    const assetResponse = await env.ASSETS.fetch(request);
    return withSecurityHeaders(assetResponse);
  }
};
