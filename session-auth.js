"use strict";

const { request: playwrightRequest } = require("playwright");
const { preparePlaywrightProxy } = require("./playwright-proxy");

const CHATGPT_ORIGIN = "https://chatgpt.com";
const {
  isLoginRedirectUrl,
  isHardLoginRedirectUrl,
  isCheckoutPageUrl,
  shouldBlockLoginNavigation,
  shouldBlockPricingNoise,
  isLoginPageContent,
  hasVisibleLoginChrome,
  hasLoggedInChatUi,
  waitForLoggedInChatUi,
  hasLoggedInSessionApi,
  buildSessionNotLoggedInError,
} = require("./auth-page-detect");
const { decodeJwtPayload, parseSessionJson } = require("./public/jwt-decode");

function extractProfileFromToken(accessToken) {
  let payload = null;
  try {
    payload = decodeJwtPayload(accessToken).payload;
  } catch (_) {
    payload = null;
  }
  if (!payload) {
    return { email: "", accountId: "", userId: "" };
  }
  const authInfo = payload["https://api.openai.com/auth"] || {};
  const profile = payload["https://api.openai.com/profile"] || {};
  return {
    email: profile.email || "",
    accountId: authInfo.chatgpt_account_id || "",
    userId: authInfo.chatgpt_user_id || "",
  };
}

function buildSessionPayload(accessToken, sessionJson = null) {
  const token = String(accessToken || "").trim();
  const profile = extractProfileFromToken(token);
  const base =
    sessionJson && typeof sessionJson === "object" ? { ...sessionJson } : {};
  const user =
    base.user ||
    (profile.email || profile.userId
      ? {
          id: profile.userId || `user-${profile.accountId || "session"}`,
          email: profile.email || undefined,
          name: profile.email || undefined,
        }
      : null);

  const expires =
    base.expires ||
    new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  return {
    ...base,
    user,
    expires,
    accessToken: base.accessToken || base.access_token || token,
    authProvider: base.authProvider || "google-oauth2",
  };
}

const CHATGPT_COOKIE_URL = "https://chatgpt.com";
const SESSION_TOKEN_BASE = "__Secure-next-auth.session-token";
/** 与 NextAuth SessionStore 一致：4096 - 160 */
const SESSION_COOKIE_CHUNK_SIZE = 3936;

function isSessionTokenCookieName(name) {
  return (
    name === SESSION_TOKEN_BASE || name.startsWith(`${SESSION_TOKEN_BASE}.`)
  );
}

/** 超长 sessionToken 按 NextAuth 规则拆成 .0 / .1 / … 多块 Cookie */
function expandSessionTokenCookies(value) {
  const token = sanitizeCookieValue(value);
  if (!token) {
    return [];
  }
  if (token.length <= SESSION_COOKIE_CHUNK_SIZE) {
    return [{ name: SESSION_TOKEN_BASE, value: token }];
  }
  const chunkCount = Math.ceil(token.length / SESSION_COOKIE_CHUNK_SIZE);
  const chunks = [];
  for (let i = 0; i < chunkCount; i++) {
    chunks.push({
      name: `${SESSION_TOKEN_BASE}.${i}`,
      value: token.substr(
        i * SESSION_COOKIE_CHUNK_SIZE,
        SESSION_COOKIE_CHUNK_SIZE,
      ),
    });
  }
  return chunks;
}

function hasStoredSessionToken(cookies) {
  return (cookies || []).some((item) => isSessionTokenCookieName(item.name));
}

function parseCookieHeader(header) {
  const pairs = [];
  for (const rawPart of String(header || "").split(";")) {
    const part = rawPart.trim();
    if (!part || !part.includes("=")) continue;
    const eq = part.indexOf("=");
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (name && value) {
      pairs.push({ name, value });
    }
  }
  return pairs;
}

function isChatGptCookieDomain(domain) {
  const value = String(domain || "").toLowerCase();
  return !value || value.includes("chatgpt.com");
}

function normalizeSameSite(raw) {
  const value = String(raw || "")
    .trim()
    .toLowerCase();
  if (value === "no_restriction" || value === "none") {
    return "None";
  }
  if (value === "strict") {
    return "Strict";
  }
  return "Lax";
}

function sanitizeCookieValue(value) {
  return String(value || "")
    .replace(/^["']+|["']+$/g, "")
    .replace(/[\r\n\0]/g, "")
    .trim();
}

function isValidCookieName(name) {
  return /^[!#$%&'*+\-.0-9A-Z^_`a-z|~]+$/.test(name);
}

function toPlaywrightCookie(spec) {
  if (!spec || typeof spec !== "object") {
    return null;
  }
  const name = String(spec.name || "").trim();
  const value = sanitizeCookieValue(spec.value);
  if (!name || !value || !isValidCookieName(name)) {
    return null;
  }

  const sameSite = normalizeSameSite(spec.sameSite);
  const secure =
    sameSite === "None" ||
    name.startsWith("__Host-") ||
    name.startsWith("__Secure-")
      ? true
      : spec.secure !== false;
  const httpOnly = spec.httpOnly !== false;

  const base = { name, value, secure, httpOnly, sameSite };

  // __Host- / __Secure- 前缀：只能用 url，不能带 domain/path
  if (name.startsWith("__Host-") || name.startsWith("__Secure-")) {
    return { ...base, url: CHATGPT_COOKIE_URL };
  }

  const hostOnly = spec.hostOnly === true;
  const rawDomain =
    String(spec.domain || "chatgpt.com")
      .trim()
      .toLowerCase() || "chatgpt.com";
  const bareDomain = rawDomain.replace(/^\./, "");
  const domain = hostOnly
    ? bareDomain
    : rawDomain.startsWith(".")
      ? rawDomain
      : `.${bareDomain}`;
  const path = String(spec.path || "/").trim() || "/";

  return { ...base, domain, path };
}

function toApiRequestCookie(spec) {
  const cookie = toPlaywrightCookie(spec);
  if (!cookie) {
    return null;
  }
  let domain = String(cookie.domain || "").replace(/^\./, "");
  let path = String(cookie.path || "/") || "/";
  if (cookie.url) {
    try {
      const parsed = new URL(cookie.url);
      domain = parsed.hostname;
      path = parsed.pathname || "/";
    } catch (_) {
      domain = "chatgpt.com";
      path = "/";
    }
  }
  return {
    name: cookie.name,
    value: cookie.value,
    domain: domain || "chatgpt.com",
    path,
    expires: -1,
    httpOnly: Boolean(cookie.httpOnly),
    secure: Boolean(cookie.secure),
    sameSite: cookie.sameSite,
  };
}

function toPlaywrightCookieFallback(cookie) {
  if (!cookie?.name || !cookie?.value) {
    return null;
  }
  const { name, value, secure, httpOnly, sameSite } = cookie;
  if (name.startsWith("__Host-")) {
    return {
      name,
      value,
      path: "/",
      secure: true,
      httpOnly,
      sameSite,
      url: CHATGPT_COOKIE_URL,
    };
  }
  if (name.startsWith("__Secure-")) {
    return {
      name,
      value,
      domain: "chatgpt.com",
      path: "/",
      secure: true,
      httpOnly,
      sameSite,
    };
  }
  return null;
}

async function addCookieSafe(context, cookie) {
  try {
    await context.addCookies([cookie]);
    return null;
  } catch (primaryErr) {
    const fallback = toPlaywrightCookieFallback(cookie);
    if (!fallback) {
      return primaryErr.message;
    }
    try {
      await context.addCookies([fallback]);
      return null;
    } catch (fallbackErr) {
      return fallbackErr.message || primaryErr.message;
    }
  }
}

async function injectChatGptCookies(context, cookieSpecs) {
  if (!cookieSpecs.length) {
    return { injected: 0, hasSessionToken: false, failed: [] };
  }

  const playwrightCookies = cookieSpecs
    .map((spec) => toPlaywrightCookie(spec))
    .filter(Boolean);

  const failed = [];
  let injected = 0;
  for (const cookie of playwrightCookies) {
    const error = await addCookieSafe(context, cookie);
    if (error) {
      failed.push({ name: cookie.name, error });
      console.warn(`[Session] Cookie 注入跳过 ${cookie.name}: ${error}`);
      continue;
    }
    injected += 1;
  }

  if (failed.length) {
    console.warn(
      `[Session] ${failed.length}/${playwrightCookies.length} 个 Cookie 注入失败`,
    );
  }

  const stored = await context.cookies(CHATGPT_COOKIE_URL);
  const hasSessionToken = hasStoredSessionToken(stored);

  return {
    injected,
    hasSessionToken,
    storedNames: stored.map((c) => c.name),
    failed,
  };
}

function collectCookieSpecs(sessionData, sessionJson) {
  const specs = [];
  const seen = new Set();
  const seenNames = new Set();

  const push = (name, value, extra = {}) => {
    const n = String(name || "").trim();
    const v = String(value || "").trim();
    if (!n || !v) return;
    const key = `${n}\0${v}`;
    if (seen.has(key)) return;
    seen.add(key);
    seenNames.add(n);
    specs.push({ name: n, value: v, ...extra });
  };

  for (const source of [sessionJson?.cookies, sessionData?.cookies]) {
    if (!Array.isArray(source)) continue;
    for (const item of source) {
      if (!item || typeof item !== "object") continue;
      const name = String(item.name || "").trim();
      const value = String(item.value || "").trim();
      if (!name || !value) continue;
      if (!isChatGptCookieDomain(item.domain)) continue;
      push(name, value, {
        domain: item.domain,
        path: item.path,
        secure: item.secure,
        httpOnly: item.httpOnly,
        sameSite: item.sameSite,
        hostOnly: item.hostOnly,
      });
    }
  }

  for (const header of [
    sessionData?.cookieHeader,
    sessionData?.cookie_header,
    sessionJson?.cookieHeader,
    sessionJson?.cookie_header,
  ]) {
    for (const pair of parseCookieHeader(header)) {
      push(pair.name, pair.value);
    }
  }

  const hasExportedSessionToken = [...seenNames].some((name) =>
    isSessionTokenCookieName(name),
  );

  const sessionToken = String(
    process.env.CHATGPT_SESSION_COOKIE ||
      process.env.CHATGPT_SESSION_TOKEN ||
      sessionData?.sessionToken ||
      sessionData?.session_token ||
      sessionData?.["__Secure-next-auth.session-token"] ||
      "",
  ).trim();

  if (sessionToken && !hasExportedSessionToken) {
    const chunks = expandSessionTokenCookies(sessionToken);
    if (chunks.length > 1) {
      console.log(
        `[Session] session-token 长度 ${sessionToken.length}，按 NextAuth 分 ${chunks.length} 块注入`,
      );
    }
    for (const chunk of chunks) {
      push(chunk.name, chunk.value);
    }
  }

  const csrfToken = String(
    sessionData?.csrfToken ||
      sessionData?.csrf_token ||
      sessionData?.["__Host-next-auth.csrf-token"] ||
      "",
  ).trim();
  if (csrfToken && !seenNames.has("__Host-next-auth.csrf-token")) {
    push("__Host-next-auth.csrf-token", csrfToken);
  }

  const deviceId = String(
    sessionData?.deviceId ||
      sessionData?.device_id ||
      sessionData?.["oai-did"] ||
      "",
  ).trim();
  if (deviceId && !seenNames.has("oai-did")) {
    push("oai-did", deviceId);
  }

  if (!seenNames.has("__Secure-next-auth.callback-url")) {
    push("__Secure-next-auth.callback-url", `${CHATGPT_COOKIE_URL}/`);
  }

  return specs;
}

function buildSessionCookieHeader(raw) {
  const resolved = resolveSessionInput(raw);
  if (!resolved) {
    return "";
  }
  return collectCookieSpecs(resolved.sessionData, resolved.sessionJson)
    .map((item) => {
      const value =
        item.name === "__Secure-next-auth.callback-url"
          ? encodeURIComponent(String(item.value || ""))
          : String(item.value || "");
      return `${item.name}=${value}`;
    })
    .join("; ");
}

function formatCookieHeader(cookies) {
  return (cookies || [])
    .filter((item) => item?.name && item?.value)
    .map((item) => `${item.name}=${item.value}`)
    .join("; ");
}

function parseSessionPayload(text) {
  try {
    return JSON.parse(String(text || ""));
  } catch (_) {
    return null;
  }
}

function hasSessionUser(data) {
  return Boolean(data?.accessToken || data?.user?.email || data?.user?.id);
}

function mergeFreshSessionData(sessionData, freshData, accessToken) {
  return {
    ...(sessionData || {}),
    ...(freshData || {}),
    user: freshData?.user || sessionData?.user || null,
    accessToken,
  };
}

function isChallengeLike({ status = 0, headerText = "", bodyText = "" } = {}) {
  const headers = String(headerText || "").toLowerCase();
  const body = String(bodyText || "");
  if (
    headers.includes("cf-mitigated: challenge") ||
    /just a moment|verify you are human|attention required/i.test(body)
  ) {
    return true;
  }
  const trimmed = body.trim();
  return (
    Number(status) === 403 &&
    !trimmed.startsWith("{") &&
    !trimmed.startsWith("[")
  );
}

function isTransportSessionFailure({ status = 0, bodyText = "", error = "" } = {}) {
  const code = Number(status) || 0;
  if (
    code === 0 ||
    code === 407 ||
    code === 502 ||
    code === 503 ||
    code === 504 ||
    code === 522 ||
    code === 523 ||
    code === 524 ||
    code === 525 ||
    code === 599
  ) {
    return true;
  }
  const message = String(error || "");
  if (
    /timeout|timed out|net::|econnreset|econnrefused|enotfound|socket|proxy/i.test(
      message,
    )
  ) {
    return true;
  }
  const body = String(bodyText || "").trim();
  return code >= 500 && !body.startsWith("{") && !body.startsWith("[");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function interpretSessionApiResult({ status = 0, headerText = "", bodyText = "" } = {}) {
  const data = parseSessionPayload(bodyText);
  if (hasSessionUser(data)) {
    return { ok: true, data, status };
  }
  if (isChallengeLike({ status, headerText, bodyText })) {
    return {
      ok: false,
      status,
      challenge: true,
      error: `Cloudflare 人机验证拦截（HTTP ${status}）。当前出口/代理 IP 被 ChatGPT 风控，请更换干净的住宅代理后重试`,
    };
  }
  if (isTransportSessionFailure({ status, bodyText })) {
    const snippet = String(bodyText || "")
      .replace(/\s+/g, " ")
      .slice(0, 80);
    return {
      ok: false,
      status,
      transport: true,
      error: `代理/网络未能访问 ChatGPT（HTTP ${status}${snippet ? `，响应: ${snippet}` : ""}）`,
    };
  }
  const snippet = String(bodyText || "")
    .replace(/\s+/g, " ")
    .slice(0, 120);
  return {
    ok: false,
    status,
    error: `session-token 未被 ChatGPT 接受（/api/auth/session 无用户信息，HTTP ${status}${snippet ? `，响应: ${snippet}` : ""}）`,
  };
}

async function readSessionApiResponse(response) {
  const status = Number(response.status() || 0);
  const headerText = Object.entries(response.headers() || {})
    .map(([key, value]) => `${key}:${value}`)
    .join("\n")
    .toLowerCase();
  const bodyText = await response.text().catch(() => "");
  return interpretSessionApiResult({ status, headerText, bodyText });
}

async function verifyRealSessionApiOnce(context) {
  try {
    const response = await context.request.get(
      `${CHATGPT_COOKIE_URL}/api/auth/session`,
      {
        timeout: 15000,
        headers: { accept: "application/json" },
      },
    );
    return await readSessionApiResponse(response);
  } catch (err) {
    return {
      ok: false,
      transport: true,
      error: `无法验证 session Cookie: ${err.message}`,
    };
  }
}

async function fetchSessionViaStandaloneRequest(cookieSpecs, proxyValue, timeoutMs) {
  const storageCookies = (cookieSpecs || [])
    .map((spec) => toApiRequestCookie(spec))
    .filter(Boolean);
  if (!storageCookies.length) {
    return {
      ok: false,
      transport: true,
      error: "无 Cookie 可做独立校验",
    };
  }
  const { proxyConfig, cleanup } = await preparePlaywrightProxy(
    String(proxyValue || "").trim(),
  );
  const requestContext = await playwrightRequest.newContext({
    proxy: proxyConfig || undefined,
    storageState: { cookies: storageCookies, origins: [] },
    extraHTTPHeaders: {
      Accept: "application/json",
      Referer: `${CHATGPT_ORIGIN}/`,
      Origin: CHATGPT_ORIGIN,
    },
  });
  try {
    const response = await requestContext.get(
      `${CHATGPT_ORIGIN}/api/auth/session`,
      {
        timeout: Math.max(2000, Number(timeoutMs) || 15000),
      },
    );
    return await readSessionApiResponse(response);
  } catch (err) {
    return {
      ok: false,
      transport: true,
      error: `独立请求校验失败: ${err.message}`,
    };
  } finally {
    await requestContext.dispose().catch(() => {});
    await cleanup().catch(() => {});
  }
}

async function verifyRealSessionApi(context, options = {}) {
  const attempts = Math.max(1, Number(options.attempts) || 3);
  const delayMs = Math.max(0, Number(options.retryDelayMs ?? 400));
  let last = {
    ok: false,
    error: "无法验证 session Cookie",
  };
  for (let i = 0; i < attempts; i += 1) {
    last = await verifyRealSessionApiOnce(context);
    if (last.ok || last.challenge || !last.transport) {
      return last;
    }
    if (i < attempts - 1 && delayMs) {
      await sleep(delayMs);
    }
  }
  if (Array.isArray(options.cookieSpecs) && options.cookieSpecs.length) {
    const fallback = await fetchSessionViaStandaloneRequest(
      options.cookieSpecs,
      options.proxy,
    );
    if (fallback.ok) {
      fallback.fromStandalone = true;
      return fallback;
    }
    if (!fallback.transport || fallback.challenge) {
      return fallback;
    }
    last.error = `${last.error}；独立请求: ${fallback.error}`;
  }
  return last;
}

async function refreshSessionAccessToken(sessionRaw, options = {}) {
  const resolved = resolveSessionInput(sessionRaw);
  if (!resolved?.accessToken) {
    return { ok: false, accessToken: "", error: "缺少 AccessToken" };
  }

  const cookieSpecs = collectCookieSpecs(
    resolved.sessionData,
    resolved.sessionJson,
  );
  if (!cookieSpecs.some((item) => isSessionTokenCookieName(item.name))) {
    return {
      ok: false,
      accessToken: resolved.accessToken,
      sessionData: resolved.sessionData,
      error: "未提供 session-token Cookie",
    };
  }

  const storageCookies = cookieSpecs.map(toApiRequestCookie).filter(Boolean);
  const proxyValue = String(options.proxy || "").trim();
  const attempts = proxyValue
    ? [
        { proxy: proxyValue, usedProxy: true },
        { proxy: "", usedProxy: false },
      ]
    : [{ proxy: "", usedProxy: false }];
  let lastFailure = null;

  for (const attempt of attempts) {
    const { proxyConfig, cleanup } = await preparePlaywrightProxy(attempt.proxy);
    const context = await playwrightRequest.newContext({
      proxy: proxyConfig || undefined,
      storageState: { cookies: storageCookies, origins: [] },
      extraHTTPHeaders: {
        Accept: "application/json",
        Referer: `${CHATGPT_ORIGIN}/`,
        Origin: CHATGPT_ORIGIN,
      },
    });

    try {
      const response = await context.get(`${CHATGPT_ORIGIN}/api/auth/session`, {
        timeout: Math.max(2000, Number(options.timeoutMs || 15000)),
      });
      const status = Number(response.status() || 0);
      const bodyText = await response.text().catch(() => "");
      const data = parseSessionPayload(bodyText);
      const accessToken = String(
        data?.accessToken || data?.access_token || "",
      ).trim();
      const storageState =
        typeof context.storageState === "function"
          ? await context.storageState().catch(() => null)
          : null;
      const cookieHeader = formatCookieHeader(storageState?.cookies);
      if (status === 200 && accessToken) {
        return {
          ok: true,
          statusCode: status,
          accessToken,
          refreshed: accessToken !== resolved.accessToken,
          usedProxy: attempt.usedProxy,
          sessionData: mergeFreshSessionData(
            resolved.sessionData,
            data,
            accessToken,
          ),
          cookieHeader,
        };
      }
      lastFailure = {
        statusCode: status || 502,
        error: `无法通过 session-token 刷新 AccessToken（HTTP ${status || 0}）`,
      };
    } catch (error) {
      lastFailure = {
        statusCode: 502,
        error: `刷新 AccessToken 失败：${error.message}`,
      };
    } finally {
      await context.dispose().catch(() => {});
      await cleanup().catch(() => {});
    }
  }

  return {
    ok: false,
    statusCode: lastFailure?.statusCode || 502,
    accessToken: resolved.accessToken,
    sessionData: resolved.sessionData,
    cookieHeader: "",
    error: lastFailure?.error || "刷新 AccessToken 失败",
  };
}

function extractAccessTokenFromRaw(raw) {
  const content = String(raw || "").trim();
  if (!content) {
    return "";
  }

  const sessionJson = parseSessionJson(content);
  if (sessionJson) {
    return String(
      sessionJson.accessToken || sessionJson.access_token || "",
    ).trim();
  }

  const jwtMatch = content.match(
    /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/,
  );
  if (jwtMatch) {
    return jwtMatch[0];
  }

  return content;
}

/**
 * 统一解析用户输入：优先完整 Session JSON，其次裸 AccessToken
 */
function resolveSessionInput(raw) {
  const content = String(raw || "").trim();
  if (!content) {
    return null;
  }

  const sessionJson = parseSessionJson(content);
  if (sessionJson) {
    const accessToken = extractAccessTokenFromRaw(content);
    if (!accessToken) {
      return null;
    }
    return {
      accessToken,
      sessionJson,
      sessionData: buildSessionPayload(accessToken, sessionJson),
      rawJson: JSON.stringify(sessionJson),
    };
  }

  const accessToken = extractAccessTokenFromRaw(content);
  if (!accessToken) {
    return null;
  }

  const sessionData = buildSessionPayload(accessToken, null);
  return {
    accessToken,
    sessionJson: null,
    sessionData,
    rawJson: JSON.stringify(sessionData),
  };
}

async function assertChatGptLoggedIn(page, label = "页面") {
  const url = page.url();
  if (isLoginRedirectUrl(url)) {
    throw new Error(
      `Session 未生效：${label} 跳转到 Google/登录页 (${url.slice(0, 80)})`,
    );
  }
  if (await isLoginPageContent(page)) {
    throw new Error(
      `Session 未生效：${label} 显示 Google 登录界面，请粘贴完整 Session JSON`,
    );
  }
}

function attachLoginRedirectGuard(page) {
  page.on("framenavigated", async (frame) => {
    if (frame !== page.mainFrame() || page.isClosed()) {
      return;
    }
    const url = frame.url();
    const current = page.url();
    if (isCheckoutPageUrl(current) || isCheckoutPageUrl(url)) {
      return;
    }
    if (!isHardLoginRedirectUrl(url)) {
      return;
    }
    console.warn(
      `[Warn] 检测到登录页跳转，正在拉回 ChatGPT: ${url.slice(0, 80)}`,
    );
    await page
      .goto(`${CHATGPT_ORIGIN}/`, {
        waitUntil: "domcontentloaded",
        timeout: 60000,
      })
      .catch(() => {});
  });
}

/**
 * 在浏览器上下文安装 Session：拦截 auth API + 注入 fetch 补丁
 * 注意：__Secure-next-auth.session-token 是加密 cookie，不能用 accessToken 冒充
 */
async function installChatGptSession(context, sessionRaw, options = {}) {
  const resolved = resolveSessionInput(sessionRaw);
  if (!resolved?.accessToken) {
    throw new Error(
      "缺少 Session：请粘贴完整 Session JSON（来自 chatgpt.com/api/auth/session）",
    );
  }

  const { accessToken: token, sessionData, sessionJson } = resolved;
  let effectiveToken = token;
  let effectiveSessionData = sessionData;
  const cookieSpecs = collectCookieSpecs(sessionData, sessionJson);

  const sessionTokenValue = String(
    process.env.CHATGPT_SESSION_COOKIE ||
      process.env.CHATGPT_SESSION_TOKEN ||
      sessionData?.sessionToken ||
      sessionData?.session_token ||
      sessionData?.["__Secure-next-auth.session-token"] ||
      cookieSpecs.find((c) => c.name === SESSION_TOKEN_BASE)?.value ||
      "",
  ).trim();

  if (sessionTokenValue && sessionTokenValue === token) {
    throw new Error(
      "sessionToken 与 accessToken 相同：请从浏览器 DevTools → Application → Cookies 复制 " +
        "__Secure-next-auth.session-token（不是 /api/auth/session JSON 里的 accessToken）",
    );
  }

  const injectResult = await injectChatGptCookies(context, cookieSpecs);

  const sessionTokenFailed =
    injectResult.failed?.filter((item) =>
      isSessionTokenCookieName(item.name),
    ) || [];

  if (sessionTokenValue && sessionTokenFailed.length) {
    throw new Error(
      `session-token Cookie 注入失败: ${sessionTokenFailed.map((item) => `${item.name}(${item.error})`).join("; ")}`,
    );
  }

  if (!injectResult.hasSessionToken) {
    console.warn(
      "[Session] 未提供 session-token Cookie，Checkout 会停留在登录页；" +
        "请导出 __Secure-next-auth.session-token，或粘贴完整 cookies[] / cookieHeader",
    );
  } else {
    console.log(
      `[Session] 已注入 ${injectResult.injected} 个 Cookie（session-token ${sessionTokenValue ? `${sessionTokenValue.length} 字符` : "来自 cookies[]"}）`,
    );
  }

  let cookieVerified = false;
  if (injectResult.hasSessionToken && options.skipCookieVerify === true) {
    cookieVerified = true;
  } else if (injectResult.hasSessionToken) {
    const apiCheck = await verifyRealSessionApi(context, {
      attempts: options.verifyAttempts,
      retryDelayMs: options.verifyRetryDelayMs,
      cookieSpecs,
      proxy: options.proxy || process.env.PROXY,
    });
    if (apiCheck.ok) {
      cookieVerified = true;
      const email = apiCheck.data?.user?.email || "";
      const refreshedToken = String(
        apiCheck.data?.accessToken || apiCheck.data?.access_token || "",
      ).trim();
      if (refreshedToken) {
        effectiveToken = refreshedToken;
        effectiveSessionData = mergeFreshSessionData(
          sessionData,
          apiCheck.data,
          refreshedToken,
        );
        if (refreshedToken !== token) {
          console.log("[Session] 已通过 session-token 刷新 AccessToken");
        }
      }
      console.log(
        `[Session] Cookie 校验通过${email ? `: ${email}` : ""}${apiCheck.fromStandalone ? "（独立请求）" : ""}`,
      );
    } else if (apiCheck.challenge || apiCheck.transport) {
      console.warn(
        `[Session] Cookie 在线校验跳过: ${apiCheck.error || "unknown"}；将继续用已注入的 Cookie 打开页面`,
      );
    } else {
      throw new Error(
        `${apiCheck.error}。请确认 Cookie 未过期，并尽量粘贴浏览器全部 chatgpt.com Cookies（cookies[] 或 cookieHeader）`,
      );
    }
  }

  const sessionBody = JSON.stringify(effectiveSessionData);

  if (!cookieVerified) {
    await context.addInitScript((payload) => {
      const sessionStr = JSON.stringify(payload);
      try {
        window.__CHATGPT_BOOTSTRAP_SESSION__ = payload;
        localStorage.setItem("oai/apps/chat/bootstrap-session", sessionStr);
      } catch (_) {
        /* ignore */
      }

      const originalFetch = window.fetch.bind(window);
      window.fetch = async function patchedFetch(input, init) {
        const url =
          typeof input === "string" ? input : (input && input.url) || "";
        if (url.includes("/api/auth/session")) {
          return new Response(sessionStr, {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (url.includes("/api/auth/csrf")) {
          return new Response(
            JSON.stringify({ csrfToken: "bootstrap-csrf-token" }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          );
        }
        return originalFetch(input, init);
      };
    }, effectiveSessionData);

    await context.route(/\/api\/auth\/session(\?.*)?$/, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: sessionBody,
      });
    });

    await context.route(/\/api\/auth\/csrf(\?.*)?$/, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ csrfToken: "bootstrap-csrf-token" }),
      });
    });
  }

  await context.route("**/*", async (route) => {
    const url = route.request().url();
    const resourceType = route.request().resourceType();
    if (shouldBlockLoginNavigation(url, resourceType)) {
      await route.abort();
      return;
    }
    if (shouldBlockPricingNoise(url, resourceType)) {
      await route.abort();
      return;
    }
    if (/\/api\/auth\/(session|csrf)/.test(url)) {
      await route.continue();
      return;
    }
    const isApiRequest = resourceType === "xhr" || resourceType === "fetch";
    const isOpenAiApi =
      url.includes("/backend-api/") ||
      url.includes("/api/") ||
      url.includes("api.openai.com/") ||
      url.includes("pay.openai.com/api/");
    if (!cookieVerified && isApiRequest && isOpenAiApi) {
      const requestHeaders = route.request().headers();
      await route.continue({
        headers: requestHeaders.authorization
          ? requestHeaders
          : {
              ...requestHeaders,
              Authorization: `Bearer ${effectiveToken}`,
            },
      });
      return;
    }
    await route.continue();
  });

  return {
    sessionData: effectiveSessionData,
    accessToken: effectiveToken,
    tokenRefreshed: effectiveToken !== token,
    cookieVerified,
  };
}

async function fetchLiveChatGptSession(page, options = {}) {
  if (!page || page.isClosed()) {
    return { ok: false, error: "浏览器页面已关闭" };
  }
  try {
    const result = await page.evaluate(async (opts) => {
      const path = opts.forceRefresh
        ? "/api/auth/session?refresh=true&reason=integrity_state_missing"
        : `/api/auth/session?refresh=${opts.cacheKey}`;
      const headers = {
        Accept: "application/json",
        "Cache-Control": "no-cache",
        Pragma: "no-cache",
      };
      if (opts.forceRefresh) {
        headers["x-openai-target-route"] = "/api/auth/session";
      }
      const response = await fetch(path, {
        method: "GET",
        credentials: "include",
        cache: "no-store",
        headers,
      });
      const text = await response.text();
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch (_) {}
      return { status: response.status, data };
    }, {
      forceRefresh: Boolean(options.forceRefresh),
      cacheKey: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    });
    const accessToken = String(
      result?.data?.accessToken || result?.data?.access_token || "",
    ).trim();
    if (result?.status === 200 && accessToken) {
      return { ok: true, accessToken, sessionData: result.data };
    }
    return {
      ok: false,
      statusCode: Number(result?.status || 0),
      error: `实时 Session 未返回 AccessToken（HTTP ${result?.status || 0}）`,
    };
  } catch (error) {
    return { ok: false, error: `读取实时 Session 失败：${error.message}` };
  }
}

function isJwtAccessToken(value) {
  const parts = String(value || "").trim().split(".");
  return parts.length === 3 && parts.every(Boolean) && parts[0].startsWith("eyJ");
}

function joinSessionTokenCookies(cookies) {
  const list = (cookies || []).filter(
    (item) => isSessionTokenCookieName(item?.name) && String(item.value || "").trim(),
  );
  if (!list.length) {
    return "";
  }
  const numbered = list.filter((item) =>
    item.name.startsWith(`${SESSION_TOKEN_BASE}.`),
  );
  if (numbered.length) {
    const byIndex = new Map();
    for (const item of numbered) {
      const index = Number(String(item.name).slice(SESSION_TOKEN_BASE.length + 1));
      const value = String(item.value || "").trim();
      if (!Number.isFinite(index) || !value) {
        continue;
      }
      const prev = byIndex.get(index);
      if (!prev || value.length >= prev.length) {
        byIndex.set(index, value);
      }
    }
    return [...byIndex.keys()]
      .sort((a, b) => a - b)
      .map((index) => byIndex.get(index))
      .join("");
  }
  const plain = list
    .filter((item) => item.name === SESSION_TOKEN_BASE)
    .map((item) => String(item.value || "").trim())
    .filter(Boolean);
  if (!plain.length) {
    return "";
  }
  return plain.sort((a, b) => b.length - a.length)[0];
}

function buildExportableSessionJson(sessionData, cookies) {
  const accessToken = String(
    sessionData?.accessToken || sessionData?.access_token || "",
  ).trim();
  const sessionToken =
    joinSessionTokenCookies(cookies) ||
    String(sessionData?.sessionToken || sessionData?.session_token || "").trim();
  if (!isJwtAccessToken(accessToken) || !sessionToken) {
    return "";
  }
  const payload = buildSessionPayload(accessToken, sessionData);
  if (!payload.user) {
    return "";
  }
  payload.sessionToken = sessionToken;
  return JSON.stringify(payload);
}

async function captureLiveChatGptSessionExport(page, sessionData = null) {
  let data =
    sessionData && typeof sessionData === "object" ? { ...sessionData } : null;
  if (page && !page.isClosed?.()) {
    const live = await fetchLiveChatGptSession(page).catch(() => null);
    if (live?.ok) {
      data = mergeFreshSessionData(data, live.sessionData, live.accessToken);
    }
  }
  let cookies = [];
  try {
    const context =
      typeof page?.context === "function" ? page.context() : page?.context;
    if (typeof context?.cookies === "function") {
      cookies = await context.cookies("https://chatgpt.com");
    }
  } catch (_) {}
  const text = buildExportableSessionJson(data, cookies);
  return {
    ok: Boolean(text),
    text,
    accessToken: String(data?.accessToken || "").trim(),
    sessionToken: joinSessionTokenCookies(cookies),
  };
}

async function openLiveChatGptMainPage(page, options = {}) {
  if (!page || page.isClosed()) {
    return { ok: false, error: "浏览器页面已关闭" };
  }
  const timeoutMs = Math.max(5000, Number(options.timeoutMs || 90000));
  await page.goto(`${CHATGPT_ORIGIN}/`, {
    waitUntil: "domcontentloaded",
    timeout: timeoutMs,
  });
  await page.waitForTimeout(Number(options.settleMs || 1500));
  if (options.reload !== false) {
    await page.reload({
      waitUntil: "domcontentloaded",
      timeout: timeoutMs,
    });
    await page.waitForTimeout(Number(options.afterReloadMs || 2000));
  }
  return fetchLiveChatGptSession(page);
}

async function refreshLiveChatGptAccessToken(page) {
  if (!page || page.isClosed()) {
    return "";
  }
  await page
    .reload({ waitUntil: "domcontentloaded", timeout: 90000 })
    .catch(() => {});
  await page.waitForTimeout(1500);
  const live = await fetchLiveChatGptSession(page);
  return live.ok ? live.accessToken : "";
}

async function acquireFreshChatGptAccessToken(page, options = {}) {
  const previousToken = String(options.previousToken || "").trim();
  const excludeToken = String(options.excludeToken || "").trim();
  const tracker = options.tracker;
  const maxAttempts = Math.max(1, Number(options.maxAttempts || 4));
  const requireRotated = options.requireRotated !== false;
  const allowNavigate = options.allowNavigate !== false;
  const log =
    typeof options.onStatus === "function"
      ? options.onStatus
      : (message) => console.log(`[步骤] ${message}`);

  const wait = (ms) =>
    typeof page.waitForTimeout === "function"
      ? page.waitForTimeout(ms)
      : new Promise((resolve) => setTimeout(resolve, ms));

  const isUsable = (value) => {
    const token = String(value || "").trim();
    return Boolean(
      token && token !== previousToken && token !== excludeToken,
    );
  };

  const pickToken = (fallback = "") => {
    const rotated = String(tracker?.getRotatedToken?.() || "").trim();
    if (isUsable(rotated)) {
      return rotated;
    }
    const captured = String(tracker?.getToken?.() || "").trim();
    if (isUsable(captured)) {
      return captured;
    }
    const liveToken = String(fallback || "").trim();
    if (isUsable(liveToken)) {
      return liveToken;
    }
    return rotated || captured || liveToken;
  };

  const waitForPageRotatedToken = async (timeoutMs) => {
    if (!tracker || !previousToken) {
      return "";
    }
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const rotated = String(tracker.getRotatedToken?.() || "").trim();
      if (isUsable(rotated)) {
        return rotated;
      }
      await wait(200);
    }
    return String(tracker.getRotatedToken?.() || "").trim();
  };

  const canProbeUi = typeof page.getByRole === "function";
  const hasTracker = Boolean(tracker);

  if (hasTracker) {
    const currentUrl = String(page.url?.() || "");
    const onChatGpt = currentUrl.startsWith(CHATGPT_ORIGIN);
    if (!onChatGpt && allowNavigate) {
      log("正在打开 ChatGPT 并调用 Session 换发接口...");
      await page.goto(`${CHATGPT_ORIGIN}/?refresh_account=true`, {
        waitUntil: "domcontentloaded",
        timeout: 90000,
      });
    } else {
      log("正在调用 Session 换发接口...");
    }
    let live = await fetchLiveChatGptSession(page, { forceRefresh: true });
    let token = pickToken(live.ok ? live.accessToken : "");
    if (isUsable(token)) {
      log("Session 换发接口已返回新 Token");
      return { ok: true, accessToken: token, refreshed: true };
    }
    token = pickToken(await waitForPageRotatedToken(onChatGpt ? 1200 : 400));
    if (isUsable(token)) {
      log("页面已自动刷新 Session");
      return { ok: true, accessToken: token, refreshed: true };
    }
    if (allowNavigate) {
      const urlAfter = String(page.url?.() || "");
      if (!/[?&]refresh_account=true(?:&|$)/.test(urlAfter)) {
        log("当前页未换发，打开主界面触发 Session 换发...");
        await page.goto(`${CHATGPT_ORIGIN}/?refresh_account=true`, {
          waitUntil: "domcontentloaded",
          timeout: 90000,
        });
      }
      live = await fetchLiveChatGptSession(page, { forceRefresh: true });
      token = pickToken(live.ok ? live.accessToken : token);
      if (isUsable(token)) {
        log("Session 换发接口已返回新 Token");
        return { ok: true, accessToken: token, refreshed: true };
      }
    } else {
      live = await fetchLiveChatGptSession(page, { forceRefresh: true });
      token = pickToken(live.ok ? live.accessToken : token);
      if (isUsable(token)) {
        log("Session 换发接口已返回新 Token");
        return { ok: true, accessToken: token, refreshed: true };
      }
    }
    if (token && !requireRotated) {
      log("已读取主界面当前 Session");
      return { ok: true, accessToken: token, refreshed: false };
    }
    if (!requireRotated && previousToken) {
      log("页面未换发，继续使用当前 Session");
      return { ok: true, accessToken: previousToken, refreshed: false };
    }
    log("未拿到新 Session，不会使用付款前 Token");
    return {
      ok: false,
      accessToken: "",
      refreshed: false,
      error: "未获取到支付后新 Session",
    };
  }

  log("正在打开 ChatGPT 主界面，等待页面自己刷新 Session...");

  let live = await openLiveChatGptMainPage(page);
  let token = pickToken(live.ok ? live.accessToken : "");
  if (token && token !== previousToken) {
    log("已获取主界面新 Session");
    return { ok: true, accessToken: token, refreshed: true };
  }

  if (canProbeUi) {
    await waitForLoggedInChatUi(page, 12000).catch(() => false);
  }
  token = pickToken(token);
  if (token && token !== previousToken) {
    log("已获取主界面新 Session");
    return { ok: true, accessToken: token, refreshed: true };
  }

  if (tracker && previousToken) {
    log("等待主界面像手动登录一样自动换发 Session...");
    token = pickToken(await waitForPageRotatedToken(12000));
    if (token && token !== previousToken) {
      log("页面已自动刷新 Session");
      return { ok: true, accessToken: token, refreshed: true };
    }
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (token && (token !== previousToken || !requireRotated)) {
      log(
        token !== previousToken
          ? "已获取主界面新 Session"
          : "已读取主界面当前 Session",
      );
      return {
        ok: true,
        accessToken: token,
        refreshed: token !== previousToken,
      };
    }
    if (attempt === maxAttempts) {
      break;
    }
    log(
      `主界面仍是旧 Session，正在刷新以触发页面换发 (${attempt}/${maxAttempts})...`,
    );
    await page.reload({
      waitUntil: "domcontentloaded",
      timeout: 90000,
    });
    await wait(2000);
    if (canProbeUi) {
      await waitForLoggedInChatUi(page, 8000).catch(() => false);
    }
    const rotated = await waitForPageRotatedToken(8000);
    live = await fetchLiveChatGptSession(page);
    token = pickToken(rotated || (live.ok ? live.accessToken : token));
  }

  if (token && (token !== previousToken || !requireRotated)) {
    log(
      token !== previousToken
        ? "已获取主界面新 Session"
        : "已读取主界面当前 Session",
    );
    return {
      ok: true,
      accessToken: token,
      refreshed: token !== previousToken,
    };
  }
  log("未拿到新 Session，不会使用付款前 Token");
  return {
    ok: false,
    accessToken: "",
    refreshed: false,
    error: "未获取到支付后新 Session",
  };
}

/**
 * @deprecated 使用 installChatGptSession(context, sessionRaw)
 */
function setupChatGptSessionAuth(context, accessToken) {
  return installChatGptSession(context, accessToken);
}

/**
 * 打开 ChatGPT 并验证 Session 在浏览器 UI 中生效
 */
async function bootstrapChatGptSession(page, sessionRaw, options = {}) {
  const resolved = resolveSessionInput(sessionRaw);
  if (!resolved?.accessToken) {
    throw new Error("缺少 Session：请粘贴完整 Session JSON");
  }

  const sessionData = options.sessionData || resolved.sessionData;
  const email =
    sessionData?.user?.email ||
    extractProfileFromToken(resolved.accessToken).email ||
    "";

  if (!email && !sessionData?.user?.id) {
    throw new Error(
      "Session 无效：JSON 中缺少 user 信息，请从 chatgpt.com/api/auth/session 复制完整内容",
    );
  }

  console.log("🔐 [步骤] 正在使用 Session 登录 ChatGPT...");
  attachLoginRedirectGuard(page);

  if (options.cookieVerified === true) {
    const resolvedEmail =
      sessionData?.user?.email ||
      email ||
      extractProfileFromToken(resolved.accessToken).email;
    console.log(`✅ [步骤] Session 登录成功: ${resolvedEmail}`);
    return {
      email: resolvedEmail,
      session: sessionData,
      hasSessionCookie: true,
    };
  }

  await page.goto(`${CHATGPT_ORIGIN}/`, {
    waitUntil: "domcontentloaded",
    timeout: 90000,
  });

  const { clearHumanVerification } = require("./human-verification");
  const captchaResult = await clearHumanVerification(page, {
    phase: "session-bootstrap",
    maxWaitMs: Number(process.env.CAPTCHA_CLEAR_TIMEOUT_MS || 180000),
    maxBypassRounds: 6,
  });
  if (!captchaResult.cleared) {
    throw new Error(
      "Cloudflare 人机验证未能通过，请换住宅代理 IP 或 HEADFUL=1 人工勾选",
    );
  }

  if (await hasVisibleLoginChrome(page)) {
    await page
      .reload({ waitUntil: "domcontentloaded", timeout: 90000 })
      .catch(() => {});
    await page.waitForTimeout(2000);
  }

  await assertChatGptLoggedIn(page, "首页");
  const { openPersonalWorkspace } = require("./auth-page-detect");
  await openPersonalWorkspace(page);

  const uiReady = await waitForLoggedInChatUi(page, 12000);
  const apiReady = await hasLoggedInSessionApi(page);

  if (await hasVisibleLoginChrome(page)) {
    throw new Error(buildSessionNotLoggedInError("ChatGPT 首页"));
  }
  if (!uiReady && !apiReady) {
    throw new Error(buildSessionNotLoggedInError("ChatGPT 首页"));
  }
  if (!uiReady && apiReady) {
    console.log(
      "[Session] 首页 UI 探针未命中，但 /api/auth/session 已确认登录，继续流程",
    );
  }

  const resolvedEmail =
    sessionData?.user?.email ||
    email ||
    extractProfileFromToken(resolved.accessToken).email;
  console.log(`✅ [步骤] Session 登录成功: ${resolvedEmail}`);
  return {
    email: resolvedEmail,
    session: sessionData,
    hasSessionCookie: Boolean(
      process.env.CHATGPT_SESSION_COOKIE ||
      process.env.CHATGPT_SESSION_TOKEN ||
      sessionData.sessionToken ||
      sessionData.session_token ||
      sessionData["__Secure-next-auth.session-token"] ||
      (Array.isArray(sessionData.cookies) && sessionData.cookies.length > 0) ||
      sessionData.cookieHeader ||
      sessionData.cookie_header,
    ),
  };
}

function extractSessionPreview(raw) {
  const resolved = resolveSessionInput(raw);
  if (!resolved) {
    return String(raw || "").slice(0, 32);
  }
  const email = resolved.sessionData?.user?.email;
  if (email) {
    return email;
  }
  return `${resolved.accessToken.slice(0, 12)}...`;
}

function extractEmailFromSession(raw) {
  const resolved = resolveSessionInput(raw);
  if (!resolved) {
    return "";
  }
  return String(
    resolved.sessionData?.user?.email ||
      resolved.sessionJson?.user?.email ||
      extractProfileFromToken(resolved.accessToken).email ||
      "",
  ).trim();
}

module.exports = {
  CHATGPT_ORIGIN,
  installChatGptSession,
  setupChatGptSessionAuth,
  bootstrapChatGptSession,
  assertChatGptLoggedIn,
  parseSessionJson,
  resolveSessionInput,
  extractAccessTokenFromRaw,
  extractProfileFromToken,
  extractSessionPreview,
  extractEmailFromSession,
  refreshSessionAccessToken,
  fetchLiveChatGptSession,
  captureLiveChatGptSessionExport,
  buildExportableSessionJson,
  joinSessionTokenCookies,
  openLiveChatGptMainPage,
  refreshLiveChatGptAccessToken,
  acquireFreshChatGptAccessToken,
  buildSessionPayload,
  collectCookieSpecs,
  buildSessionCookieHeader,
  formatCookieHeader,
  expandSessionTokenCookies,
  isChallengeLike,
  isTransportSessionFailure,
  isLoginRedirectUrl,
  isHardLoginRedirectUrl,
  isCheckoutPageUrl,
  isLoginPageContent,
};
