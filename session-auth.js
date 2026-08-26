"use strict";

const CHATGPT_ORIGIN = "https://chatgpt.com";
const {
  isLoginRedirectUrl,
  isHardLoginRedirectUrl,
  isCheckoutPageUrl,
  shouldBlockLoginNavigation,
  isLoginPageContent,
  hasVisibleLoginChrome,
  hasLoggedInChatUi,
  waitForLoggedInChatUi,
  hasLoggedInSessionApi,
  buildSessionNotLoggedInError,
} = require("./auth-page-detect");

function decodeJwtPayload(token) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) {
    return null;
  }
  try {
    const normalized = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(
      normalized.length + ((4 - (normalized.length % 4)) % 4),
      "=",
    );
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
  } catch (_) {
    return null;
  }
}

function extractProfileFromToken(accessToken) {
  const payload = decodeJwtPayload(accessToken);
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

function parseSessionJson(raw) {
  const content = String(raw || "").trim();
  if (!content || !content.startsWith("{")) {
    return null;
  }
  try {
    const data = JSON.parse(content);
    if (data?.accessToken || data?.access_token || data?.user) {
      return data;
    }
  } catch (_) {
    return null;
  }
  return null;
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

  const warmup = await context.newPage();
  try {
    await warmup.goto(`${CHATGPT_COOKIE_URL}/`, {
      waitUntil: "domcontentloaded",
      timeout: 90000,
    });
  } catch (_) {
    /* 代理慢时仍尝试写 Cookie */
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
  await warmup.close().catch(() => {});

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

async function verifyRealSessionApi(context) {
  const probe = await context.newPage();
  try {
    const home = await probe
      .goto(`${CHATGPT_COOKIE_URL}/`, {
        waitUntil: "domcontentloaded",
        timeout: 60000,
      })
      .catch(() => null);
    const homeHeaders = home?.headers?.() || {};
    const homeHeaderText = Object.keys(homeHeaders)
      .map((k) => `${k}:${homeHeaders[k]}`)
      .join("\n")
      .toLowerCase();
    const homeBody = await probe
      .evaluate(() => document.body?.innerText || "")
      .catch(() => "");
    if (
      isChallengeLike({
        status: home?.status() || 0,
        headerText: homeHeaderText,
        bodyText: homeBody,
      })
    ) {
      return {
        ok: false,
        status: home?.status() || 0,
        challenge: true,
        error: `Cloudflare 人机验证拦截（HTTP ${home?.status() || 0}）。当前出口/代理 IP 被 ChatGPT 风控，请更换干净的住宅代理后重试`,
      };
    }

    const result = await probe.evaluate(async () => {
      try {
        const response = await fetch("/api/auth/session", {
          credentials: "include",
          headers: { accept: "application/json" },
        });
        return {
          status: response.status,
          headerText: [...response.headers.entries()]
            .map(([key, value]) => `${key}:${value}`)
            .join("\n"),
          bodyText: await response.text(),
        };
      } catch (err) {
        return {
          status: 0,
          headerText: "",
          bodyText: "",
          error: String((err && err.message) || err),
        };
      }
    });

    const status = Number(result.status || 0);
    const headerText = String(result.headerText || "").toLowerCase();
    const bodyText = String(result.bodyText || "");
    const data = parseSessionPayload(bodyText);
    if (hasSessionUser(data)) {
      return { ok: true, data, status };
    }
    if (result.error) {
      return { ok: false, error: `无法验证 session Cookie: ${result.error}` };
    }
    if (isChallengeLike({ status, headerText, bodyText })) {
      return {
        ok: false,
        status,
        challenge: true,
        error: `Cloudflare 人机验证拦截（HTTP ${status}）。当前出口/代理 IP 被 ChatGPT 风控，请更换干净的住宅代理后重试`,
      };
    }
    const snippet = bodyText.replace(/\s+/g, " ").slice(0, 120);
    return {
      ok: false,
      status,
      error: `session-token 未被 ChatGPT 接受（/api/auth/session 无用户信息，HTTP ${status}${snippet ? `，响应: ${snippet}` : ""}）`,
    };
  } catch (err) {
    return { ok: false, error: `无法验证 session Cookie: ${err.message}` };
  } finally {
    await probe.close().catch(() => {});
  }
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
async function installChatGptSession(context, sessionRaw) {
  const resolved = resolveSessionInput(sessionRaw);
  if (!resolved?.accessToken) {
    throw new Error(
      "缺少 Session：请粘贴完整 Session JSON（来自 chatgpt.com/api/auth/session）",
    );
  }

  const { accessToken: token, sessionData, sessionJson } = resolved;
  const sessionBody = JSON.stringify(sessionData);
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
  if (injectResult.hasSessionToken) {
    const apiCheck = await verifyRealSessionApi(context);
    if (apiCheck.ok) {
      cookieVerified = true;
      const email = apiCheck.data?.user?.email || "";
      console.log(`[Session] Cookie 校验通过${email ? `: ${email}` : ""}`);
    } else if (
      apiCheck.error &&
      !/cloudflare|challenge|captcha/i.test(apiCheck.error)
    ) {
      throw new Error(
        `${apiCheck.error}。请确认 Cookie 未过期，并尽量粘贴浏览器全部 chatgpt.com Cookies（cookies[] 或 cookieHeader）`,
      );
    } else {
      console.warn(
        `[Session] Cookie 在线校验跳过: ${apiCheck.error || "unknown"}`,
      );
    }
  }

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
  }, sessionData);

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

  await context.route("**/*", async (route) => {
    const url = route.request().url();
    const resourceType = route.request().resourceType();
    if (shouldBlockLoginNavigation(url, resourceType)) {
      await route.abort();
      return;
    }
    if (/\/api\/auth\/(session|csrf)/.test(url)) {
      await route.continue();
      return;
    }
    if (
      url.includes("auth.openai.com") ||
      url.includes("chatgpt.com") ||
      url.includes("openai.com") ||
      url.includes("pay.openai.com")
    ) {
      await route.continue({
        headers: {
          ...route.request().headers(),
          Authorization: `Bearer ${token}`,
        },
      });
      return;
    }
    await route.continue();
  });

  return { sessionData, cookieVerified };
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

  await page.goto(`${CHATGPT_ORIGIN}/`, {
    waitUntil: "domcontentloaded",
    timeout: 90000,
  });
  await page.waitForTimeout(2500);

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

  const cookieVerified = options.cookieVerified === true;
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
  buildSessionPayload,
  collectCookieSpecs,
  expandSessionTokenCookies,
  isChallengeLike,
  isLoginRedirectUrl,
  isHardLoginRedirectUrl,
  isCheckoutPageUrl,
  isLoginPageContent,
};
