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

async function proxyApi(request, env) {
  if (!env.API_ORIGIN) {
    return json({
      error: "api_origin_not_configured",
      message: "Cloudflare Worker 缺少 API_ORIGIN 变量，不能转发 OA 后端请求。"
    }, { status: 503 });
  }

  const incomingUrl = new URL(request.url);
  const targetUrl = new URL(env.API_ORIGIN);
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
      return json({
        apiOriginConfigured: Boolean(env.API_ORIGIN),
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
