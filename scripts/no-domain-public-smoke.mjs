#!/usr/bin/env node

const defaults = {
  expectedSha: process.env.GITHUB_SHA || "",
  login: process.env.PUBLIC_SMOKE_LOGIN
    || process.env.CLOUDFLARE_BOOTSTRAP_ADMIN_LOGIN
    || process.env.DEFAULT_ADMIN_EMAIL
    || "",
  pagesUrl: "https://17602842555.github.io/HR/",
  password: process.env.PUBLIC_SMOKE_PASSWORD
    || process.env.CLOUDFLARE_BOOTSTRAP_ADMIN_PASSWORD
    || process.env.DEFAULT_ADMIN_PASSWORD
    || "",
  requireBrowserLogin: process.env.PUBLIC_SMOKE_REQUIRE_BROWSER_LOGIN === "1",
  workerUrl: "https://deep-oa-hr.2445776963.workers.dev"
};

function parseArgs(argv = process.argv.slice(2)) {
  const options = { json: false, ...defaults };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--expected-sha") {
      options.expectedSha = argv[++index] || "";
    } else if (arg === "--login") {
      options.login = argv[++index] || "";
    } else if (arg === "--pages-url") {
      options.pagesUrl = argv[++index] || "";
    } else if (arg === "--require-browser-login") {
      options.requireBrowserLogin = true;
    } else if (arg === "--skip-browser-login") {
      options.requireBrowserLogin = false;
      options.login = "";
      options.password = "";
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

function publicOptions(options) {
  return {
    expectedSha: options.expectedSha,
    hasLogin: Boolean(options.login),
    hasPassword: Boolean(options.password),
    pagesUrl: options.pagesUrl,
    requireBrowserLogin: options.requireBrowserLogin,
    workerUrl: options.workerUrl
  };
}

async function runBrowserSessionSmoke(options, checks) {
  if (!options.login || !options.password) {
    const details = {
      hasLogin: Boolean(options.login),
      hasPassword: Boolean(options.password),
      requiredEnv: ["PUBLIC_SMOKE_LOGIN", "PUBLIC_SMOKE_PASSWORD"]
    };
    checks.push(options.requireBrowserLogin
      ? fail("browser-login", "Browser login smoke credentials are required.", details)
      : pass("browser-login", "Browser login smoke skipped because credentials are not configured.", { ...details, skipped: true }));
    return {
      browserSessionReady: false,
      skipped: true
    };
  }

  let browser = null;
  try {
    const { chromium } = await import("@playwright/test");
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(options.pagesUrl, { waitUntil: "networkidle" });

    const loginResult = await page.evaluate(async ({ login, password, workerUrl }) => {
      const response = await fetch(`${workerUrl}/api/auth/login`, {
        body: JSON.stringify({ login, password }),
        credentials: "include",
        headers: { "content-type": "application/json" },
        method: "POST"
      });
      const text = await response.text();
      let payload = {};
      try {
        payload = JSON.parse(text || "{}");
      } catch {
        payload = { raw: text.slice(0, 160) };
      }
      return {
        ok: response.ok,
        payload: {
          ok: payload.ok,
          userEmail: payload.user?.email || "",
          userId: payload.user?.id || "",
          userName: payload.user?.name || ""
        },
        status: response.status
      };
    }, { login: options.login, password: options.password, workerUrl: options.workerUrl });

    const cookies = await context.cookies(options.workerUrl);
    const sessionCookie = cookies.find((cookie) => cookie.name === "oa_cf_session");

    const meResult = await page.evaluate(async ({ workerUrl }) => {
      const response = await fetch(`${workerUrl}/api/auth/me`, {
        credentials: "include",
        method: "GET"
      });
      const payload = await response.json().catch(() => ({}));
      return {
        ok: response.ok,
        status: response.status,
        userEmail: payload.user?.email || "",
        userId: payload.user?.id || "",
        userName: payload.user?.name || ""
      };
    }, { workerUrl: options.workerUrl });

    const peopleResult = await page.evaluate(async ({ workerUrl }) => {
      const response = await fetch(`${workerUrl}/api/people`, {
        credentials: "include",
        method: "GET"
      });
      const payload = await response.json().catch(() => ({}));
      return {
        employeeCount: payload.people?.employees?.length || 0,
        ok: response.ok,
        status: response.status
      };
    }, { workerUrl: options.workerUrl });

    const ready = loginResult.ok
      && Boolean(sessionCookie?.value)
      && meResult.ok
      && peopleResult.ok
      && peopleResult.employeeCount > 0;

    checks.push(ready
      ? pass("browser-login", "Browser session can log in from GitHub Pages to the Worker and read business data.", {
        cookieDomain: sessionCookie?.domain || "",
        employeeCount: peopleResult.employeeCount,
        loginStatus: loginResult.status,
        meStatus: meResult.status,
        peopleStatus: peopleResult.status,
        userEmail: meResult.userEmail
      })
      : fail("browser-login", "Browser session login or authenticated business read failed.", {
        hasSessionCookie: Boolean(sessionCookie?.value),
        login: loginResult,
        me: meResult,
        people: peopleResult
      }));

    await browser.close();
    browser = null;
    return {
      browserSessionReady: ready,
      employeeCount: peopleResult.employeeCount,
      skipped: false,
      userEmail: meResult.userEmail
    };
  } catch (error) {
    checks.push(fail("browser-login", "Browser login smoke failed to execute.", {
      error: error.message,
      installHint: "Run npx playwright install chromium before requiring browser smoke."
    }));
    return {
      browserSessionReady: false,
      error: error.message,
      skipped: false
    };
  } finally {
    if (browser) await browser.close();
  }
}

async function run(options) {
  const checks = [];
  const summary = {
    browserSessionReady: false,
    corsReady: false,
    d1Ready: false,
    frontendReachable: false,
    frontendShaReady: options.expectedSha ? false : null,
    workerReady: false
  };

  if (!options.pagesUrl || !options.workerUrl) {
    checks.push(fail("input", "pages-url and worker-url are required."));
    return { checks, ok: false, options: publicOptions(options), summary };
  }

  let pageHtml = "";
  try {
    const page = await fetchText(options.pagesUrl);
    pageHtml = page.text;
    summary.frontendReachable = page.response.ok;
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
        if (options.expectedSha) {
          summary.frontendShaReady = bundleText.includes(options.expectedSha);
          checks.push(summary.frontendShaReady
            ? pass("frontend-release-sha", "Frontend bundle contains the expected release SHA.", { expectedSha: options.expectedSha })
            : fail("frontend-release-sha", "Frontend bundle does not contain the expected release SHA.", { expectedSha: options.expectedSha }));
        }
      } catch (error) {
        checks.push(fail("frontend-bundle", "Frontend bundle request failed.", { error: error.message, url: scriptUrl }));
      }
    }
  }

  try {
    const health = await fetchText(`${options.workerUrl}/api/edge/health`);
    const payload = JSON.parse(health.text || "{}");
    summary.workerReady = health.response.ok && payload.apiMode === "cloudflare-native";
    summary.d1Ready = payload.d1Configured === true;
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
    summary.corsReady = preflight.status === 204 && allowOrigin === pagesOrigin && allowCredentials === "true";
    checks.push(preflight.status === 204 && allowOrigin === pagesOrigin && allowCredentials === "true"
      ? pass("worker-cors", "Worker CORS allows the GitHub Pages origin with credentials.", { allowCredentials, allowOrigin, status: preflight.status })
      : fail("worker-cors", "Worker CORS preflight does not allow the GitHub Pages origin with credentials.", { allowCredentials, allowOrigin, expectedOrigin: pagesOrigin, status: preflight.status }));
  } catch (error) {
    checks.push(fail("worker-cors", "Worker CORS preflight request failed.", { error: error.message }));
  }

  const browserSummary = await runBrowserSessionSmoke(options, checks);
  summary.browserSessionReady = browserSummary.browserSessionReady;
  summary.browserLoginSkipped = browserSummary.skipped;
  summary.browserLoginUserEmail = browserSummary.userEmail || "";

  return {
    checks,
    ok: checks.every((item) => item.level === "pass"),
    options: publicOptions(options),
    summary
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
