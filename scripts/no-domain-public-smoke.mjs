#!/usr/bin/env node

const defaults = {
  pagesUrl: "https://17602842555.github.io/HR/",
  workerUrl: "https://deep-oa-hr.2445776963.workers.dev"
};

function parseArgs(argv = process.argv.slice(2)) {
  const options = { json: false, ...defaults };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--pages-url") {
      options.pagesUrl = argv[++index] || "";
    } else if (arg === "--worker-url") {
      options.workerUrl = argv[++index] || "";
    }
  }
  options.pagesUrl = normalizeUrl(options.pagesUrl, true);
  options.workerUrl = normalizeUrl(options.workerUrl, false);
  return options;
}

function normalizeUrl(value, keepTrailingSlash) {
  const text = String(value || "").trim();
  if (!text) return "";
  const normalized = text.replace(/\/+$/g, "");
  return keepTrailingSlash ? `${normalized}/` : normalized;
}

function check(level, name, message, details = {}) {
  return { details, level, message, name };
}

function pass(name, message, details) {
  return check("pass", name, message, details);
}

function fail(name, message, details) {
  return check("fail", name, message, details);
}

async function fetchText(url, options = {}) {
  const response = await fetch(url, options);
  return { response, text: await response.text() };
}

function firstModuleScriptUrl(html, pagesUrl) {
  const match = String(html || "").match(/<script[^>]+type=["']module["'][^>]+src=["']([^"']+)["']/i)
    || String(html || "").match(/<script[^>]+src=["']([^"']+\.js[^"']*)["']/i);
  if (!match) return "";
  return new URL(match[1], pagesUrl).toString();
}

async function run(options) {
  const checks = [];

  if (!options.pagesUrl || !options.workerUrl) {
    checks.push(fail("input", "pages-url and worker-url are required."));
    return { checks, ok: false, options };
  }

  let pageHtml = "";
  try {
    const page = await fetchText(options.pagesUrl);
    pageHtml = page.text;
    checks.push(page.response.ok
      ? pass("github-pages", "GitHub Pages frontend is reachable.", { status: page.response.status, url: options.pagesUrl })
      : fail("github-pages", "GitHub Pages frontend is not reachable.", { status: page.response.status, url: options.pagesUrl }));
  } catch (error) {
    checks.push(fail("github-pages", "GitHub Pages frontend request failed.", { error: error.message, url: options.pagesUrl }));
  }

  if (pageHtml) {
    const scriptUrl = firstModuleScriptUrl(pageHtml, options.pagesUrl);
    if (!scriptUrl) {
      checks.push(fail("frontend-bundle", "Could not find a frontend JavaScript bundle in the Pages HTML."));
    } else {
      try {
        const bundle = await fetchText(scriptUrl);
        const expectedApi = `${options.workerUrl}/api`;
        const bundleText = bundle.text;
        checks.push(bundle.response.ok
          ? pass("frontend-bundle", "Frontend bundle is reachable.", { status: bundle.response.status, url: scriptUrl })
          : fail("frontend-bundle", "Frontend bundle is not reachable.", { status: bundle.response.status, url: scriptUrl }));
        checks.push(bundleText.includes(expectedApi)
          ? pass("frontend-api-base", "Frontend bundle points to the Cloudflare Worker API.", { expectedApi })
          : fail("frontend-api-base", "Frontend bundle does not contain the expected Worker API base URL.", { expectedApi }));
      } catch (error) {
        checks.push(fail("frontend-bundle", "Frontend bundle request failed.", { error: error.message, url: scriptUrl }));
      }
    }
  }

  try {
    const health = await fetchText(`${options.workerUrl}/api/edge/health`);
    const payload = JSON.parse(health.text || "{}");
    checks.push(health.response.ok && payload.apiMode === "cloudflare-native"
      ? pass("worker-health", "Cloudflare native Worker API is reachable.", { apiMode: payload.apiMode, d1Configured: payload.d1Configured, status: health.response.status })
      : fail("worker-health", "Cloudflare Worker health did not return the native API contract.", { payload, status: health.response.status }));
    checks.push(payload.d1Configured === true
      ? pass("worker-d1", "Cloudflare D1 binding is configured.", { d1Configured: payload.d1Configured })
      : fail("worker-d1", "Cloudflare D1 binding is not configured.", { d1Configured: payload.d1Configured }));
  } catch (error) {
    checks.push(fail("worker-health", "Cloudflare Worker health request failed.", { error: error.message }));
  }

  try {
    const pagesOrigin = new URL(options.pagesUrl).origin;
    const preflight = await fetch(`${options.workerUrl}/api/auth/login`, {
      headers: {
        "Access-Control-Request-Headers": "content-type",
        "Access-Control-Request-Method": "POST",
        Origin: pagesOrigin
      },
      method: "OPTIONS"
    });
    const allowOrigin = preflight.headers.get("access-control-allow-origin") || "";
    const allowCredentials = preflight.headers.get("access-control-allow-credentials") || "";
    checks.push(preflight.status === 204 && allowOrigin === pagesOrigin && allowCredentials === "true"
      ? pass("worker-cors", "Worker CORS allows the GitHub Pages origin with credentials.", { allowCredentials, allowOrigin, status: preflight.status })
      : fail("worker-cors", "Worker CORS preflight does not allow the GitHub Pages origin with credentials.", { allowCredentials, allowOrigin, expectedOrigin: pagesOrigin, status: preflight.status }));
  } catch (error) {
    checks.push(fail("worker-cors", "Worker CORS preflight request failed.", { error: error.message }));
  }

  return {
    checks,
    ok: checks.every((item) => item.level === "pass"),
    options
  };
}

const options = parseArgs();
const result = await run(options);
if (options.json) {
  console.log(JSON.stringify(result, null, 2));
} else {
  result.checks.forEach((item) => {
    const marker = item.level === "pass" ? "PASS" : "FAIL";
    console.log(`[${marker}] ${item.name}: ${item.message}`);
  });
}
process.exitCode = result.ok ? 0 : 1;
