"use strict";

const axios = require("axios");
const { request: playwrightRequest } = require("playwright");
const {
  extractProfileFromToken,
  fetchLiveChatGptSession,
  openLiveChatGptMainPage,
} = require("./session-auth");
const { decodeJwtPart } = require("./public/jwt-decode");
const { preparePlaywrightProxy } = require("./playwright-proxy");
const { requestWithChromeImpersonation } = require("./openai-http");

const CHECK_V4_BASE =
  "https://chatgpt.com/backend-api/accounts/check/v4-2023-04-27";
const CANCEL_SUBSCRIPTION_URL =
  "https://chatgpt.com/backend-api/subscriptions/cancel";
const RESUME_SUBSCRIPTION_URL =
  "https://chatgpt.com/backend-api/subscriptions/resume";
const BILLING_INFO_URL =
  "https://chatgpt.com/backend-api/payments/billing_info";
const BILLING_PAGE_URL = "https://chatgpt.com/account/manage";
const CODEX_QUOTA_ENDPOINTS = [
  "https://chatgpt.com/backend-api/wham/usage",
  "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits",
  "https://chatgpt.com/backend-api/codex/usage",
];
const CODEX_QUOTA_RESET_URL =
  "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";

const PLAN_LABELS = {
  plus: "ChatGPT Plus",
  pro: "ChatGPT Pro",
  team: "ChatGPT Team",
  free: "免费版",
  unknown: "未知",
};

const ORIGIN_LABELS = {
  chatgpt_not_purchased: "未购买",
  chatgpt_web: "Web (Stripe)",
  web: "Web (Stripe)",
  stripe: "Stripe",
  ios: "Apple App Store",
  apple: "Apple App Store",
  android: "Google Play",
  google_play: "Google Play",
};

function normalizeSubscriptionPlan(subPlan, hasActive) {
  const raw = String(subPlan || "")
    .trim()
    .toLowerCase();
  if (!raw) {
    return hasActive ? "unknown" : "free";
  }
  if (raw.includes("team")) {
    return "team";
  }
  if (raw.includes("pro") && !raw.includes("plus")) {
    return "pro";
  }
  if (raw.includes("plus")) {
    return "plus";
  }
  if (raw.includes("free")) {
    return "free";
  }
  return raw.slice(0, 40);
}

function formatPlanLabel(planKey, rawPlan) {
  if (PLAN_LABELS[planKey]) {
    return PLAN_LABELS[planKey];
  }
  if (rawPlan) {
    return rawPlan;
  }
  return PLAN_LABELS.unknown;
}

function formatPurchaseOrigin(value) {
  const raw = String(value || "")
    .trim()
    .toLowerCase();
  if (!raw) {
    return "—";
  }
  if (ORIGIN_LABELS[raw]) {
    return ORIGIN_LABELS[raw];
  }
  if (raw.includes("apple") || raw.includes("ios")) {
    return ORIGIN_LABELS.ios;
  }
  if (raw.includes("android") || raw.includes("google")) {
    return ORIGIN_LABELS.android;
  }
  if (raw.includes("stripe") || raw.includes("web")) {
    return ORIGIN_LABELS.chatgpt_web;
  }
  return value;
}

function pickCurrency(...sources) {
  for (const source of sources) {
    if (!source || typeof source !== "object") {
      continue;
    }
    for (const key of [
      "billing_currency",
      "currency",
      "currency_code",
      "billing_currency_code",
    ]) {
      const value = String(source[key] || "")
        .trim()
        .toUpperCase();
      if (/^[A-Z]{3}$/.test(value)) {
        return value;
      }
    }
  }
  return "";
}

function computeRemainingDays(expiresAt) {
  if (!expiresAt) {
    return null;
  }
  const expiresMs = Date.parse(String(expiresAt));
  if (!Number.isFinite(expiresMs)) {
    return null;
  }
  const diffMs = expiresMs - Date.now();
  return Math.ceil(diffMs / (24 * 60 * 60 * 1000));
}

function getDisplayTimeZone() {
  try {
    const store = require("./mysql-store");
    if (typeof store.getDefaultTimeZone === "function") {
      return store.getDefaultTimeZone();
    }
  } catch (_) {
    /* 配置未就绪时回退东八区 */
  }
  return "Asia/Shanghai";
}

function formatDateTime(value) {
  if (!value) {
    return "—";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value);
  }
  return date
    .toLocaleString("zh-CN", {
      timeZone: getDisplayTimeZone(),
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    })
    .replace(/\//g, "-");
}

function formatQuotaResetTime(value) {
  if (value == null || value === "") {
    return "";
  }
  const numeric = Number(value);
  const date = Number.isFinite(numeric)
    ? new Date(numeric > 1e12 ? numeric : numeric * 1000)
    : new Date(value);
  if (Number.isNaN(date.getTime()) || date.getFullYear() < 2000) {
    return "";
  }
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: getDisplayTimeZone(),
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const values = Object.fromEntries(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  return `${values.month}/${values.day} ${values.hour}:${values.minute}`;
}

function formatCompactDuration(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return "";
  }
  if (seconds < 3600) {
    return `${Math.max(1, Math.round(seconds / 60))}m`;
  }
  if (seconds < 86400) {
    return `${Math.round((seconds / 3600) * 10) / 10}h`.replace(/\.0h$/, "h");
  }
  return `${Math.round((seconds / 86400) * 10) / 10}d`.replace(/\.0d$/, "d");
}

function formatQuotaResetAtText(resetAt, resetAfter) {
  const timeText = formatQuotaResetTime(resetAt);
  const afterText = formatCompactDuration(resetAfter);
  if (timeText && afterText) {
    return `${timeText} (${afterText})`;
  }
  if (timeText) {
    return timeText;
  }
  if (afterText) {
    return afterText;
  }
  return "—";
}

function formatRemainingDays(days) {
  if (days == null) {
    return "—";
  }
  if (days < 0) {
    return `已过期 ${Math.abs(days)} 天`;
  }
  if (days === 0) {
    return "今天到期";
  }
  return `${days} 天`;
}

function formatBoolean(value) {
  if (value === true) {
    return "是";
  }
  if (value === false) {
    return "否";
  }
  return "—";
}

function buildCheckHeaders(accessToken) {
  const accountId = extractProfileFromToken(accessToken).accountId;
  return {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9,zh-CN;q=0.8",
    "User-Agent": USER_AGENT,
    Referer: "https://chatgpt.com/",
    Origin: "https://chatgpt.com",
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
    "sec-ch-ua":
      '"Chromium";v="136", "Google Chrome";v="136", "Not.A/Brand";v="99"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    ...(accountId
      ? {
          "chatgpt-account-id": accountId,
          "openai-account-id": accountId,
        }
      : {}),
  };
}

function validateSessionTokenForQuery(token) {
  const value = String(token || "").trim();
  if (!value) {
    return { valid: false, message: "缺少 AccessToken" };
  }

  const parts = value.split(".");
  if (parts.length !== 3 || parts.some((item) => !item)) {
    return { valid: false, message: "该 Token 不合法：格式错误" };
  }

  let payload;
  try {
    payload = decodeJwtPart(parts[1]);
  } catch (_) {
    return { valid: false, message: "该 Token 不合法：无法解析" };
  }

  if (payload.iss && payload.iss !== "https://auth.openai.com") {
    return { valid: false, message: "该 Token 不合法：签发方错误" };
  }

  const authInfo = payload["https://api.openai.com/auth"] || {};
  const profile = payload["https://api.openai.com/profile"] || {};
  const exp = Number(payload.exp || 0);
  const now = Math.floor(Date.now() / 1000);
  if (exp && Number.isFinite(exp) && exp <= now) {
    return { valid: false, message: "该 Token 已过期，请重新获取 Session" };
  }

  return {
    valid: true,
    email: profile.email || "",
    accountId: authInfo.chatgpt_account_id || "",
  };
}

function formatQuotaNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return "—";
  }
  return Number.isInteger(number)
    ? number.toLocaleString("zh-CN")
    : number.toFixed(1);
}

function formatSecondsAsWindow(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return "";
  }
  if (seconds < 60) {
    return `${seconds} 秒`;
  }
  if (seconds < 3600) {
    return `${Math.round(seconds / 60)} 分钟`;
  }
  if (seconds < 86400) {
    return `${Math.round((seconds / 3600) * 10) / 10} 小时`;
  }
  return `${Math.round((seconds / 86400) * 10) / 10} 天`;
}

function detectQuotaWindowLabel(periodText, raw) {
  const text = `${periodText || ""} ${JSON.stringify(raw || {})}`.toLowerCase();
  const windowSeconds = Number(
    raw?.limit_window_seconds || raw?.limitWindowSeconds || 0,
  );
  if (text.includes("5h") || text.includes("5小时") || windowSeconds === 18000) {
    return "5小时额度";
  }
  if (
    text.includes("week") ||
    text.includes("weekly") ||
    text.includes("7天") ||
    windowSeconds === 604800
  ) {
    return "周额度";
  }
  return periodText || "额度窗口";
}

function parseCodexWindows(raw) {
  const windows = [
    raw?.rate_limit?.primary_window,
    raw?.rate_limit?.secondary_window,
    raw?.code_review_rate_limit?.primary_window,
    raw?.code_review_rate_limit?.secondary_window,
  ].filter((item) => item && typeof item === "object");
  const extra = raw?.additional_rate_limits;
  if (Array.isArray(extra)) {
    extra.forEach((item) => {
      if (item?.primary_window) windows.push(item.primary_window);
      else if (item) windows.push(item);
    });
  }
  const seen = new Set();
  return windows
    .map((item) => {
      const used = item.used ?? item.usage ?? null;
      const limit = item.limit ?? item.total ?? item.quota ?? null;
      const remaining =
        item.remaining ??
        (Number.isFinite(Number(limit)) && Number.isFinite(Number(used))
          ? Number(limit) - Number(used)
          : null);
      const resetAt = item.reset_at || item.resetAt || item.resets_at || null;
      const resetAfter =
        item.reset_after_seconds ?? item.resetAfterSeconds ?? null;
      const period =
        item.period ||
        item.window ||
        formatSecondsAsWindow(item.limit_window_seconds || item.limitWindowSeconds);
      const label = detectQuotaWindowLabel(period, item);
      const key = `${label}|${used}|${remaining}|${resetAt}`;
      if (seen.has(key)) {
        return null;
      }
      seen.add(key);
      return {
        windowLabel: label,
        usageText:
          used == null && limit == null
            ? "—"
            : `${formatQuotaNumber(used)} / ${formatQuotaNumber(limit)}`,
        remainingText: remaining == null ? "—" : formatQuotaNumber(remaining),
        resetAtText: formatQuotaResetAtText(resetAt, resetAfter),
        periodText: period || "—",
      };
    })
    .filter(Boolean);
}

function parseCodexResetCredits(data) {
  const credits = [];
  const collect = (value, depth = 0) => {
    if (!value || depth > 4) {
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item) => collect(item, depth + 1));
      return;
    }
    if (typeof value !== "object") {
      return;
    }
    const id = value.id || value.credit_id || value.creditId;
    const status = String(value.status || "").toLowerCase();
    if (id && (status === "available" || value.title || value.description)) {
      credits.push({
        id: String(id),
        status: status || "unknown",
        title: String(value.title || "").trim(),
        description: String(value.description || "").trim(),
        expiresAtText: formatQuotaResetTime(
          value.expires_at || value.expiresAt || value.expiration || "",
        ) || "—",
      });
    }
    Object.values(value).forEach((child) => {
      if (child && typeof child === "object") {
        collect(child, depth + 1);
      }
    });
  };
  collect(data);
  const seen = new Set();
  return credits.filter((credit) => {
    if (seen.has(credit.id)) {
      return false;
    }
    seen.add(credit.id);
    return true;
  });
}

function parseCodexQuotaPayload(data) {
  const windows = parseCodexWindows(data);
  const credits = parseCodexResetCredits(data);
  const used = data?.used ?? data?.usage ?? data?.rate_limit?.used ?? null;
  const limit =
    data?.limit ?? data?.total ?? data?.quota ?? data?.rate_limit?.limit ?? null;
  const remaining =
    data?.remaining ??
    (Number.isFinite(Number(limit)) && Number.isFinite(Number(used))
      ? Number(limit) - Number(used)
      : null);
  const resetAt =
    data?.reset_at || data?.resetAt || data?.rate_limit?.reset_at || null;
  const availableCount =
    data?.available_count ??
    data?.availableCount ??
    data?.resets_remaining ??
    (credits.length || null);
  const canReset =
    availableCount == null ? null : Number(availableCount) > 0 || credits.length > 0;
  return {
    status:
      windows.length || used != null || remaining != null || credits.length
        ? "已读取"
        : "未返回明细",
    usageText:
      used == null && limit == null
        ? "—"
        : `${formatQuotaNumber(used)} / ${formatQuotaNumber(limit)}`,
    remainingText: remaining == null ? "—" : formatQuotaNumber(remaining),
    resetAtText: formatQuotaResetAtText(resetAt),
    resetCountText:
      availableCount == null && !credits.length
        ? "—"
        : `${credits.length || availableCount || 0} 次`,
    canReset,
    resetAvailableText:
      canReset === true ? "可重置" : canReset === false ? "暂无次数" : "未返回",
    resetCredits: credits,
    windows,
  };
}

function listAccountCheckRecords(data) {
  const accounts = data?.accounts;
  if (!accounts || typeof accounts !== "object") {
    return [];
  }
  if (Array.isArray(accounts)) {
    return accounts.filter(Boolean);
  }
  return Object.entries(accounts).map(([key, item]) => ({
    ...(item && typeof item === "object" ? item : {}),
    __key: key,
  }));
}

function pickStatusAccountRecord(data, profile = {}) {
  const records = listAccountCheckRecords(data);
  const preferredId = String(profile.accountId || "").trim();
  if (preferredId) {
    const matched = records.find((item) => {
      const accountId = String(
        item?.account?.account_id || item?.account?.accountId || "",
      ).trim();
      return accountId === preferredId || item.__key === preferredId;
    });
    if (matched) {
      return matched;
    }
  }
  const active = records.find(
    (item) => item?.entitlement?.has_active_subscription === true,
  );
  if (active) {
    return active;
  }
  return (data?.accounts || {}).default || records[0] || {};
}

function parseAccountCheckResponse(data, profile = {}) {
  const selected = pickStatusAccountRecord(data, profile);
  const account = selected.account || {};
  const entitlement = selected.entitlement || {};
  const lastActive = selected.last_active_subscription || {};

  const hasActive = Boolean(entitlement.has_active_subscription);
  const rawPlan = String(entitlement.subscription_plan || "");
  const planKey = normalizeSubscriptionPlan(rawPlan, hasActive);
  const expiresAt = entitlement.expires_at || lastActive.expires_at || null;
  const remainingDays = computeRemainingDays(expiresAt);
  const currency = pickCurrency(lastActive, entitlement, account) || "—";
  const plan = formatPlanLabel(planKey, rawPlan);

  return {
    email: profile.email || "",
    accountId: account.account_id || profile.accountId || "",
    plan,
    planLabel: plan,
    planKey,
    rawPlan,
    hasActiveSubscription: hasActive,
    subscriptionChannel: formatPurchaseOrigin(
      lastActive.purchase_origin_platform,
    ),
    subscriptionChannelRaw: lastActive.purchase_origin_platform || "",
    currency,
    expiresAt: expiresAt || null,
    expiresAtDisplay: formatDateTime(expiresAt),
    remainingDays,
    remainingDaysDisplay: formatRemainingDays(remainingDays),
    autoRenew: formatBoolean(lastActive.will_renew),
    autoRenewRaw: lastActive.will_renew,
    hasPreviouslyPaid: formatBoolean(account.has_previously_paid_subscription),
    hasPreviouslyPaidRaw: Boolean(account.has_previously_paid_subscription),
    queriedAt: new Date().toISOString(),
    queriedAtDisplay: formatDateTime(new Date()),
    billingPageUrl: BILLING_PAGE_URL,
    accountStatus: hasActive
      ? lastActive.will_renew === false
        ? "已订阅（不续费）"
        : "已订阅"
      : "未订阅",
  };
}

async function fetchOptionalJson(accessToken, url, accountId, options = {}) {
  const extraHeaders = accountId
    ? { "chatgpt-account-id": accountId, "openai-account-id": accountId }
    : {};
  try {
    const response = await requestOpenAiJson(accessToken, {
      method: "GET",
      url,
      extraHeaders,
      timeoutMs: options.timeoutMs || 8000,
      preferAxios: options.preferAxios,
      proxy: options.proxy,
      cookieHeader: options.cookieHeader,
    });
    if (response.status < 200 || response.status >= 300) {
      return null;
    }
    const body = normalizeResponseBody(response.data);
    return body && typeof body === "object" ? body : null;
  } catch (_) {
    return null;
  }
}

async function fetchCodexQuota(accessToken, accountId, options = {}) {
  let best = {
    status: "未读取到",
    usageText: "—",
    remainingText: "—",
    resetAtText: "—",
    resetCountText: "—",
    canReset: null,
    resetAvailableText: "未返回",
    resetCredits: [],
    windows: [],
  };
  for (const url of CODEX_QUOTA_ENDPOINTS) {
    const payload = await fetchOptionalJson(accessToken, url, accountId, options);
    if (!payload) {
      continue;
    }
    const parsed = parseCodexQuotaPayload(payload);
    if (parsed.status === "已读取") {
      best = parsed;
      if (parsed.windows.length || parsed.resetCredits.length) {
        return parsed;
      }
    }
  }
  return best;
}

async function queryAccountStatusBySession(accessToken, options = {}) {
  const checkResult = await querySubscriptionBySession(accessToken, options);
  if (!checkResult.ok) {
    return checkResult;
  }

  const account = checkResult.data;
  const [billing, quota] = await Promise.all([
    fetchOptionalJson(
      accessToken,
      BILLING_INFO_URL,
      account.accountId,
      options,
    ),
    fetchCodexQuota(accessToken, account.accountId, options),
  ]);
  const billingCurrency = pickCurrency(billing, billing?.processor) || "";
  return {
    ok: true,
    data: {
      ...account,
      currency: billingCurrency || account.currency,
      accountStatus: account.hasActiveSubscription
        ? account.autoRenewRaw === false
          ? "已订阅（不续费）"
          : "已订阅"
        : "未订阅",
      codexQuota: quota,
    },
  };
}

async function resetCodexQuota(accessToken, options = {}) {
  const token = String(accessToken || "").trim();
  if (!token) {
    return { ok: false, statusCode: 400, error: "缺少 AccessToken" };
  }
  const profile = extractProfileFromToken(token);
  const accountId = String(options.accountId || profile.accountId || "").trim();
  if (!accountId) {
    return {
      ok: false,
      statusCode: 400,
      error: "无法解析 account_id，请确认 Session 完整有效",
    };
  }

  const quota = await fetchCodexQuota(token, accountId, options);
  if (quota.canReset === false) {
    return {
      ok: false,
      statusCode: 400,
      error: "当前没有可用的 Codex 重置次数",
    };
  }

  const creditId = quota.resetCredits[0]?.id || "";
  const redeemRequestId = `acct-${Date.now()}`;
  const body = creditId
    ? { credit_id: creditId, redeem_request_id: redeemRequestId }
    : { redeem_request_id: redeemRequestId };
  let response;
  try {
    response = await requestOpenAiJson(token, {
      method: "POST",
      url: CODEX_QUOTA_RESET_URL,
      body,
      extraHeaders: {
        "chatgpt-account-id": accountId,
        "openai-account-id": accountId,
      },
      timeoutMs: options.timeoutMs || 12000,
      preferAxios: options.preferAxios,
      proxy: options.proxy,
    });
  } catch (error) {
    return {
      ok: false,
      statusCode: 502,
      error: `重置 Codex 额度失败：${error.message}`,
    };
  }

  const payload = normalizeResponseBody(response.data);
  if (response.status === 401) {
    return { ok: false, ...mapUnauthorizedError(payload) };
  }
  if (response.status !== 200 && response.status !== 204) {
    const detail =
      typeof payload === "string"
        ? payload.slice(0, 200)
        : JSON.stringify(payload || {}).slice(0, 200);
    return {
      ok: false,
      statusCode: response.status || 502,
      error: `重置 Codex 额度失败 (${response.status})${detail ? `：${detail}` : ""}`,
    };
  }

  const resetCode = String(payload?.code || payload?.outcome || "")
    .toLowerCase()
    .replace(/[_-]/g, "");
  if (resetCode === "nocredit") {
    return { ok: false, statusCode: 400, error: "没有可用的 Codex 重置次数" };
  }
  if (resetCode === "nothingtoreset") {
    return { ok: false, statusCode: 400, error: "当前 Codex 额度窗口无需重置" };
  }

  const refreshed = await queryAccountStatusBySession(token, {
    ...options,
    accountId,
  });
  return {
    ok: true,
    data: {
      ...(refreshed.ok ? refreshed.data : { accountId }),
      reset: true,
      message: "已提交 Codex 额度重置请求",
    },
  };
}

function buildCheckUrl(timezoneOffsetMin = 0) {
  const offset = Number.isFinite(Number(timezoneOffsetMin))
    ? Number(timezoneOffsetMin)
    : new Date().getTimezoneOffset();
  return `${CHECK_V4_BASE}?timezone_offset_min=${offset}`;
}

function normalizeResponseBody(data) {
  if (typeof data === "string") {
    const trimmed = data.trim();
    if (!trimmed) {
      return null;
    }
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        return JSON.parse(trimmed);
      } catch (_) {
        return trimmed;
      }
    }
    return trimmed;
  }
  return data;
}

function mapUnauthorizedError(data) {
  const body = normalizeResponseBody(data);
  const code = String(
    body?.detail?.code || body?.error?.code || body?.code || "",
  ).toLowerCase();
  if (code === "token_expired") {
    return {
      statusCode: 401,
      error:
        "Session Cookie 仍有效，但 AccessToken 已被 OpenAI 判定过期或撤销；请重新打开 chatgpt.com/api/auth/session 并粘贴最新完整 JSON",
    };
  }
  return {
    statusCode: 401,
    error: "Session 无效或已过期，请重新获取 Session",
  };
}

function isCloudflareBlock(status, data) {
  if (status !== 403) {
    return false;
  }
  const text = typeof data === "string" ? data : JSON.stringify(data || "");
  return /cloudflare|cf-ray|attention required|just a moment|cf_chl/i.test(
    text,
  );
}

async function fetchAccountCheckWithPlaywright(
  accessToken,
  timezoneOffsetMin = 0,
  proxyOverride = "",
) {
  const url = buildCheckUrl(timezoneOffsetMin);
  const proxyValue = String(proxyOverride || process.env.PROXY || "").trim();
  const { proxyConfig, cleanup } = await preparePlaywrightProxy(proxyValue);
  const ctx = await playwrightRequest.newContext({
    userAgent: USER_AGENT,
    proxy: proxyConfig || undefined,
    extraHTTPHeaders: buildCheckHeaders(accessToken),
  });

  try {
    const response = await ctx.get(url, { timeout: 20000 });
    const status = response.status();
    let data;
    try {
      data = await response.json();
    } catch (_) {
      data = await response.text().catch(() => "");
    }
    return { status, data, via: "playwright" };
  } finally {
    await ctx.dispose().catch(() => {});
    await cleanup().catch(() => {});
  }
}

async function fetchAccountCheckWithAxios(accessToken, timezoneOffsetMin = 0) {
  const url = buildCheckUrl(timezoneOffsetMin);
  const response = await axios.get(url, {
    headers: buildCheckHeaders(accessToken),
    timeout: 20000,
    validateStatus: () => true,
  });
  return { status: response.status, data: response.data, via: "axios" };
}

async function fetchAccountCheck(
  accessToken,
  timezoneOffsetMin = 0,
  proxyOverride = "",
  cookieHeader = "",
) {
  let lastError = null;

  try {
    const playwrightResult = await fetchAccountCheckWithPlaywright(
      accessToken,
      timezoneOffsetMin,
      proxyOverride,
    );
    if (playwrightResult.status === 200) {
      return playwrightResult;
    }
    if (playwrightResult.status === 401 && !cookieHeader) {
      return playwrightResult;
    }
    lastError = playwrightResult;
  } catch (error) {
    lastError = { status: 0, data: error.message, via: "playwright", error };
  }

  if (cookieHeader) {
    const impersonationHeaders = {
      Accept: "application/json, text/plain, */*",
      Authorization: `Bearer ${accessToken}`,
      Cookie: cookieHeader,
      Referer: "https://chatgpt.com/",
      ...(() => {
        const accountId = extractProfileFromToken(accessToken).accountId;
        return accountId
          ? {
              "chatgpt-account-id": accountId,
              "openai-account-id": accountId,
            }
          : {};
      })(),
    };
    const proxyCandidates = String(
      proxyOverride || process.env.PROXY || "",
    ).trim()
      ? [String(proxyOverride || process.env.PROXY).trim(), ""]
      : [""];
    for (const proxy of proxyCandidates) {
      try {
        const result = await requestWithChromeImpersonation({
          method: "GET",
          url: buildCheckUrl(timezoneOffsetMin),
          headers: impersonationHeaders,
          proxy,
          timeoutMs: 20000,
        });
        console.log(
          `[Subscription] account-check curl-cffi status=${result.status} proxy=${proxy ? "yes" : "no"}`,
        );
        if (result.status === 200 || result.status === 401) {
          return result;
        }
        lastError = result;
      } catch (error) {
        console.warn(
          `[Subscription] account-check curl-cffi failed proxy=${proxy ? "yes" : "no"}: ${error.message}`,
        );
        lastError = { status: 0, data: error.message, via: "curl-cffi", error };
      }
    }
  }

  try {
    const axiosResult = await fetchAccountCheckWithAxios(
      accessToken,
      timezoneOffsetMin,
    );
    if (axiosResult.status === 200 || axiosResult.status === 401) {
      return axiosResult;
    }
    if (!lastError || lastError.status !== 200) {
      lastError = axiosResult;
    }
  } catch (error) {
    if (!lastError) {
      lastError = { status: 0, data: error.message, via: "axios", error };
    }
  }

  return lastError || { status: 502, data: "unknown error", via: "none" };
}

async function fetchAccountCheckWithBrowserPage(
  page,
  accessToken,
  timezoneOffsetMin = 0,
  accountId = "",
) {
  const url = buildCheckUrl(timezoneOffsetMin);
  const targetAccountId =
    String(accountId || "").trim() ||
    extractProfileFromToken(accessToken).accountId;
  const run = (token) => page.evaluate(
    async ({ targetUrl, token, targetAccountId }) => {
      const headers = {
        Accept: "application/json, text/plain, */*",
        ...(targetAccountId
          ? {
              "chatgpt-account-id": targetAccountId,
              "openai-account-id": targetAccountId,
            }
          : {}),
      };
      if (token) {
        headers.Authorization = `Bearer ${token}`;
      }
      const result = await fetch(targetUrl, {
        method: "GET",
        credentials: "include",
        headers,
      });
      const text = await result.text();
      let data = text;
      try {
        data = text ? JSON.parse(text) : null;
      } catch (_) {}
      return { status: result.status, data, via: "page-fetch" };
    },
    { targetUrl: url, token, targetAccountId },
  );
  const response = await run(accessToken);
  if (response.status === 401 && accessToken) {
    return run("");
  }
  return response;
}

async function queryAccountStatusWithBrowserPage(page, accessToken, options = {}) {
  const token = String(accessToken || "").trim();
  if (!page || page.isClosed()) {
    return { ok: false, statusCode: 400, error: "浏览器页面已关闭" };
  }

  const profile = {
    ...extractProfileFromToken(token),
    email: String(
      options.email || extractProfileFromToken(token).email || "",
    ).trim(),
    accountId: String(
      options.accountId || extractProfileFromToken(token).accountId || "",
    ).trim(),
  };

  const run = (useToken) =>
    fetchAccountCheckWithBrowserPage(
      page,
      useToken,
      options.timezoneOffsetMin,
      profile.accountId,
    );

  let response;
  try {
    response = await run(token);
    let body = normalizeResponseBody(response.data);
    if (response.status === 200 && body && typeof body === "object") {
      let account = parseAccountCheckResponse(body, profile);
      if (
        !account.hasActiveSubscription &&
        token &&
        options.cookieFallback !== false
      ) {
        const cookieResponse = await run("");
        const cookieBody = normalizeResponseBody(cookieResponse.data);
        if (
          cookieResponse.status === 200 &&
          cookieBody &&
          typeof cookieBody === "object"
        ) {
          const cookieAccount = parseAccountCheckResponse(cookieBody, profile);
          if (cookieAccount.hasActiveSubscription) {
            account = cookieAccount;
            response = cookieResponse;
            body = cookieBody;
          }
        }
      }
      return {
        ok: true,
        data: {
          ...account,
          planLabel: account.planLabel || account.plan,
          accountStatus: account.hasActiveSubscription
            ? account.autoRenewRaw === false
              ? "已订阅（不续费）"
              : "已订阅"
            : "未订阅",
          codexQuota: {
            status: "未读取到",
            usageText: "—",
            remainingText: "—",
            resetAtText: "—",
            resetCountText: "—",
            canReset: null,
            resetAvailableText: "未返回",
            resetCredits: [],
            windows: [],
          },
        },
      };
    }
    if (response.status !== 200) {
      return { ok: false, ...mapCheckError(response.status, body) };
    }
    return { ok: false, statusCode: 502, error: "OpenAI 返回数据格式异常" };
  } catch (error) {
    return {
      ok: false,
      statusCode: 502,
      error: `浏览器查询账户状态失败：${error.message}`,
    };
  }
}

async function requestJsonWithBrowserPage(
  page,
  { url, method = "GET", token = "", accountId = "", body = null },
) {
  return page.evaluate(
    async ({ targetUrl, method, token, targetAccountId, body }) => {
      const headers = { Accept: "*/*" };
      if (String(method || "GET").toUpperCase() !== "GET") {
        headers["Content-Type"] = "application/json";
      }
      if (targetAccountId) {
        headers["chatgpt-account-id"] = targetAccountId;
        headers["openai-account-id"] = targetAccountId;
      }
      if (token) {
        headers.Authorization = `Bearer ${token}`;
      }
      const result = await fetch(targetUrl, {
        method,
        credentials: "include",
        cache: "no-store",
        headers,
        body: body == null ? undefined : JSON.stringify(body),
      });
      const text = await result.text();
      let data = text;
      try {
        data = text ? JSON.parse(text) : null;
      } catch (_) {}
      return { status: result.status, data, via: "page-fetch" };
    },
    {
      targetUrl: url,
      method,
      token,
      targetAccountId: accountId,
      body,
    },
  );
}

function createChatGptLiveStateTracker(page, options = {}) {
  const previousToken = String(options.previousToken || "").trim();
  let latestCheck = null;
  let latestToken = "";
  let rotatedToken = "";

  const takeToken = (token) => {
    const value = String(token || "").trim();
    if (!value) {
      return;
    }
    latestToken = value;
    if (previousToken && value !== previousToken) {
      rotatedToken = value;
    }
  };

  const takeBearer = (headers = {}) => {
    const raw = String(
      headers.authorization || headers.Authorization || "",
    ).trim();
    takeToken(raw.replace(/^Bearer\s+/i, "").trim());
  };

  const onRequest = (request) => {
    try {
      const url = String(request.url() || "");
      if (!/chatgpt\.com\/(backend-api\/|api\/auth\/session)/i.test(url)) {
        return;
      }
      takeBearer(request.headers());
    } catch (_) {
      /* ignore */
    }
  };

  const onResponse = (response) => {
    try {
      const url = String(response.url() || "");
      const status = Number(response.status());
      const isSession = /\/api\/auth\/session(\?|$)/.test(url);
      const isCheck = /\/backend-api\/accounts\/check/.test(url);
      if (isSession && status === 200) {
        Promise.resolve(response.text())
          .then((text) => {
            try {
              const data = JSON.parse(text);
              takeToken(data?.accessToken || data?.access_token || "");
            } catch (_) {
              /* ignore */
            }
          })
          .catch(() => {});
        return;
      }
      if (isCheck && status === 200) {
        Promise.resolve(response.text())
          .then((text) => {
            try {
              const data = JSON.parse(text);
              if (data && typeof data === "object") {
                latestCheck = data;
              }
            } catch (_) {
              /* ignore */
            }
          })
          .catch(() => {});
      }
    } catch (_) {
      /* ignore */
    }
  };

  if (typeof page?.on === "function") {
    page.on("request", onRequest);
    page.on("response", onResponse);
  }

  return {
    getToken: () => rotatedToken || latestToken,
    getRotatedToken: () => rotatedToken,
    getCheck: () => latestCheck,
    dispose: () => {
      if (typeof page?.off === "function") {
        page.off("request", onRequest);
        page.off("response", onResponse);
      }
    },
  };
}

async function readChatGptPlanFromPage(page) {
  if (!page || page.isClosed()) {
    return "";
  }
  try {
    return String(
      (await page.evaluate(() => {
        const body = String(document.body?.innerText || "");
        if (
          /Your current plan[\s\S]{0,80}\bPlus\b|当前套餐[\s\S]{0,40}Plus/i.test(
            body,
          )
        ) {
          return "ChatGPT Plus";
        }
        if (
          /Upgrade to Plus|Get Plus|Regain Plus|Subscribe to Plus|升级至\s*Plus/i.test(
            body,
          )
        ) {
          return "";
        }
        return "";
      })) || "",
    ).trim();
  } catch (_) {
    return "";
  }
}

async function prepareLiveChatGptSubscription(page, options = {}) {
  let accessToken = String(options.accessToken || "").trim();
  const email = String(options.email || "").trim();
  const accountId = String(options.accountId || "").trim();
  const requireActive = options.requireActive === true;
  const maxAttempts = Math.max(
    1,
    Number(options.maxAttempts || (requireActive ? 12 : 3)),
  );
  const log = (message) => {
    if (typeof options.onStatus === "function") {
      options.onStatus(message);
      return;
    }
    console.log(`[步骤] ${message}`);
  };
  const listener = options.tracker || createChatGptLiveStateTracker(page);
  const ownsListener = !options.tracker;
  const timezoneOffsetMin =
    options.timezoneOffsetMin ?? new Date().getTimezoneOffset();

  const statusFromCheck = (data) => {
    if (!data || typeof data !== "object") {
      return null;
    }
    const parsed = parseAccountCheckResponse(data, { email, accountId });
    return {
      ok: true,
      data: {
        ...parsed,
        planLabel: parsed.planLabel || parsed.plan,
      },
    };
  };

  try {
    if (options.skipOpen !== true) {
      log("正在打开 ChatGPT 主界面并刷新登录态...");
      const opened = await openLiveChatGptMainPage(page);
      if (opened.ok && opened.accessToken) {
        if (accessToken && opened.accessToken !== accessToken) {
          log("主界面已刷新 AccessToken");
        }
        accessToken = opened.accessToken;
      }
    }

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (attempt > 1 || options.skipOpen === true) {
        const liveSession = await fetchLiveChatGptSession(page);
        if (liveSession.ok && liveSession.accessToken) {
          if (accessToken && liveSession.accessToken !== accessToken) {
            log("主界面已刷新 AccessToken");
          }
          accessToken = liveSession.accessToken;
        }
      }

      let captured = String(listener.getToken?.() || "").trim();
      if (captured && captured !== accessToken) {
        log("已捕获主界面请求中的 AccessToken");
        accessToken = captured;
      }

      let status = statusFromCheck(listener.getCheck?.() || listener.getLatest?.());
      if (status?.data?.hasActiveSubscription) {
        log(
          `主界面账户接口已更新: ${status.data.planLabel || status.data.plan || "已订阅"}`,
        );
        return { accessToken, status, synced: true };
      }

      const uiPlan = await readChatGptPlanFromPage(page);
      if (uiPlan) {
        log(`主界面已从免费版切换为 ${uiPlan}`);
        return {
          accessToken,
          status: {
            ok: true,
            data: {
              hasActiveSubscription: true,
              plan: uiPlan,
              planLabel: uiPlan,
              accountId,
              email,
            },
          },
          synced: true,
        };
      }

      status = await queryAccountStatusWithBrowserPage(page, accessToken, {
        email,
        accountId,
        timezoneOffsetMin,
      });
      if (status.ok && status.data?.hasActiveSubscription) {
        log(
          `主界面订阅状态已更新: ${status.data.planLabel || status.data.plan || "已订阅"}`,
        );
        return { accessToken, status, synced: true };
      }
      if (status.ok && !requireActive) {
        return { accessToken, status, synced: false };
      }
      if (!status.ok && [401, 403].includes(Number(status.statusCode || 0))) {
        log(
          `主界面账户查询失败: ${status.error || `HTTP ${status.statusCode}`}`,
        );
        return { accessToken, status, synced: false };
      }

      if (attempt < maxAttempts) {
        log(
          status && !status.ok
            ? `主界面账户查询未成功，正在重试 (${attempt}/${maxAttempts})...`
            : `主界面仍显示免费版，等待订阅同步 (${attempt}/${maxAttempts})...`,
        );
        await page.waitForTimeout(Math.min(2000 + attempt * 500, 5000));
        if (attempt % 3 === 0) {
          log("会员状态尚未更新，正在重新刷新主界面...");
          await page.reload({
            waitUntil: "domcontentloaded",
            timeout: 90000,
          });
          await page.waitForTimeout(2000);
        }
      } else {
        log(
          requireActive
            ? "尚未从主界面确认到 Plus，将按支付成功继续尝试取消续费"
            : "已刷新主界面，将使用当前登录态继续操作",
        );
        return { accessToken, status, synced: false };
      }
    }

    return { accessToken, status: null, synced: false };
  } finally {
    if (ownsListener) {
      listener.dispose();
    }
  }
}

async function requestOpenAiJson(
  accessToken,
  {
    method = "GET",
    url,
    body = null,
    timeoutMs = 20000,
    preferAxios = false,
    proxy = "",
    cookieHeader = "",
    extraHeaders = {},
  },
) {
  const headers = { ...buildCheckHeaders(accessToken), ...extraHeaders };
  if (cookieHeader) {
    headers.Cookie = cookieHeader;
  }
  const timeout = Math.max(2000, Number(timeoutMs || 20000));
  const proxyValue = String(proxy || process.env.PROXY || "").trim();
  let lastError = null;

  const tryAxios = async () => {
    const response = await axios({
      method,
      url,
      headers:
        body != null
          ? { ...headers, "Content-Type": "application/json" }
          : headers,
      data: body != null ? body : undefined,
      timeout,
      validateStatus: () => true,
    });
    return { status: response.status, data: response.data, via: "axios" };
  };

  const tryPlaywright = async () => {
    const { proxyConfig, cleanup } = await preparePlaywrightProxy(proxyValue);
    const ctx = await playwrightRequest.newContext({
      userAgent: USER_AGENT,
      proxy: proxyConfig || undefined,
      extraHTTPHeaders: headers,
    });
    try {
      const response = await ctx.fetch(url, {
        method,
        timeout,
        headers:
          body != null
            ? { ...headers, "Content-Type": "application/json" }
            : headers,
        data: body != null ? body : undefined,
      });
      const status = response.status();
      let data;
      try {
        data = await response.json();
      } catch (_) {
        data = await response.text().catch(() => "");
      }
      return { status, data, via: "playwright" };
    } finally {
      await ctx.dispose().catch(() => {});
      await cleanup().catch(() => {});
    }
  };

  const attempts = proxyValue
    ? [tryPlaywright, tryAxios]
    : preferAxios
      ? [tryAxios, tryPlaywright]
      : [tryPlaywright, tryAxios];
  for (const attempt of attempts) {
    try {
      const result = await attempt();
      if (
        (result.status >= 200 && result.status < 300) ||
        result.status === 401
      ) {
        if (result.status !== 401) {
          return result;
        }
        if (!cookieHeader) {
          return result;
        }
      }
      lastError = result;
    } catch (error) {
      lastError = {
        status: 0,
        data: error.message,
        via: preferAxios ? "axios" : "playwright",
        error,
      };
    }
  }

  if (cookieHeader) {
    const proxyCandidates = proxyValue ? [proxyValue, ""] : [""];
    for (const impersonationProxy of proxyCandidates) {
      try {
        const impersonationHeaders = Object.fromEntries(
          Object.entries(headers).filter(([name]) => {
            const lower = name.toLowerCase();
            return lower !== "user-agent" && !lower.startsWith("sec-");
          }),
        );
        if (method === "GET") {
          delete impersonationHeaders.Origin;
          delete impersonationHeaders.origin;
          delete impersonationHeaders["Content-Type"];
          delete impersonationHeaders["content-type"];
        }
        const result = await requestWithChromeImpersonation({
          method,
          url,
          headers:
            body != null
              ? { ...impersonationHeaders, "Content-Type": "application/json" }
              : impersonationHeaders,
          body,
          proxy: impersonationProxy,
          timeoutMs: timeout,
        });
        console.log(
          `[Subscription] request curl-cffi method=${method} status=${result.status} proxy=${impersonationProxy ? "yes" : "no"}`,
        );
        if (
          (result.status >= 200 && result.status < 300) ||
          result.status === 401
        ) {
          return result;
        }
        lastError = result;
      } catch (error) {
        lastError = {
          status: 0,
          data: error.message,
          via: "curl-cffi",
          error,
        };
      }
    }
  }

  return lastError || { status: 502, data: "unknown error", via: "none" };
}

function isAppStoreOrigin(channelRaw) {
  const raw = String(channelRaw || "")
    .trim()
    .toLowerCase();
  return (
    raw.includes("apple") ||
    raw.includes("ios") ||
    raw.includes("google") ||
    raw.includes("android")
  );
}

async function cancelAutoRenew(accessToken, options = {}) {
  const token = String(accessToken || "").trim();
  if (!token) {
    return { ok: false, statusCode: 400, error: "缺少 AccessToken" };
  }

  const profile = extractProfileFromToken(token);
  const accountId = String(options.accountId || profile.accountId || "").trim();
  if (!accountId) {
    return {
      ok: false,
      statusCode: 400,
      error: "无法解析 account_id，请确认 Session 完整有效",
    };
  }

  let subscription = null;
  if (!options.skipPreCheck) {
    const checkResult = await querySubscriptionBySession(token, {
      timezoneOffsetMin: options.timezoneOffsetMin,
      email: options.email || profile.email || "",
      proxy: options.proxy,
      cookieHeader: options.cookieHeader,
    });
    if (!checkResult.ok) {
      return checkResult;
    }

    subscription = checkResult.data;
    if (isAppStoreOrigin(subscription.subscriptionChannelRaw)) {
      return {
        ok: false,
        statusCode: 400,
        error: `该订阅来自 ${subscription.subscriptionChannel}，无法通过 API 取消，请在对应平台关闭续费`,
      };
    }

    if (!subscription.hasActiveSubscription) {
      return {
        ok: false,
        statusCode: 400,
        error: "账号当前无有效订阅，无需取消自动续费",
      };
    }

    if (subscription.autoRenewRaw === false) {
      return {
        ok: true,
        data: {
          ...subscription,
          alreadyCancelled: true,
          message: "自动续费已关闭，无需重复操作",
        },
      };
    }
  }

  let response;
  try {
    response = await requestOpenAiJson(token, {
      method: "POST",
      url: CANCEL_SUBSCRIPTION_URL,
      body: { account_id: accountId },
      extraHeaders: {
        "chatgpt-account-id": accountId,
        "openai-account-id": accountId,
      },
      timeoutMs: options.timeoutMs,
      preferAxios: options.preferAxios,
      proxy: options.proxy,
      cookieHeader: options.cookieHeader,
    });
  } catch (error) {
    return {
      ok: false,
      statusCode: 502,
      error: `取消自动续费请求失败：${error.message}`,
    };
  }

  const body = normalizeResponseBody(response.data);
  if (response.status === 401) {
    return { ok: false, ...mapUnauthorizedError(body) };
  }
  if (response.status === 403) {
    const mapped = mapCheckError(403, body);
    return { ok: false, ...mapped };
  }
  if (response.status !== 200 && response.status !== 204) {
    const detail =
      typeof body === "string"
        ? body.slice(0, 200)
        : JSON.stringify(body || {}).slice(0, 200);
    return {
      ok: false,
      statusCode: response.status || 502,
      error: `取消自动续费失败 (${response.status})${detail ? `：${detail}` : ""}`,
    };
  }

  if (options.skipVerify) {
    return {
      ok: true,
      data: {
        ...(subscription || {}),
        alreadyCancelled: false,
        cancelled: true,
        message: "已提交取消自动续费请求",
      },
    };
  }

  const verify = await verifyAutoRenewDisabled(token, {
    timezoneOffsetMin: options.timezoneOffsetMin,
    email: options.email || profile.email || "",
    maxAttempts: options.verifyAttempts,
    delayMs: options.verifyDelayMs,
    proxy: options.proxy,
    cookieHeader: options.cookieHeader,
    onStatus: options.onStatus,
  });

  return {
    ok: true,
    data: {
      ...(verify.ok ? verify.data : subscription),
      alreadyCancelled: false,
      cancelled: true,
      confirmed: Boolean(verify.confirmed),
      pendingVerify: !verify.confirmed,
      message:
        verify.confirmed
          ? "已成功关闭自动续费，当前周期仍可继续使用"
          : "已提交取消自动续费请求，请稍后刷新确认状态",
    },
  };
}

async function verifyAutoRenewDisabled(accessToken, options = {}) {
  const token = String(accessToken || "").trim();
  if (!token) {
    return { ok: false, confirmed: false, error: "缺少 AccessToken" };
  }

  const maxAttempts = Math.max(1, Number(options.maxAttempts || 3));
  const delayMs = Math.max(0, Number(options.delayMs ?? 1200));
  let last = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    last = await querySubscriptionBySession(token, {
      timezoneOffsetMin: options.timezoneOffsetMin,
      email: options.email || "",
      proxy: options.proxy,
      cookieHeader: options.cookieHeader,
    });
    if (last.ok && last.data.autoRenewRaw === false) {
      return { ...last, confirmed: true };
    }
    if (attempt < maxAttempts) {
      options.onStatus?.(
        `自动续费状态暂未更新，正在第 ${attempt + 1}/${maxAttempts} 次确认...`,
      );
      await sleep(Math.min(delayMs * attempt, 4000));
    }
  }

  return { ...(last || {}), confirmed: false };
}

async function verifyAutoRenewDisabledWithBrowserPage(
  page,
  accessToken,
  options = {},
) {
  let token = String(accessToken || "").trim();
  const maxAttempts = Math.max(1, Number(options.maxAttempts || 5));
  const delayMs = Math.max(0, Number(options.delayMs ?? 1500));
  let last = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    last = await queryAccountStatusWithBrowserPage(page, token, {
      timezoneOffsetMin: options.timezoneOffsetMin,
      email: options.email || "",
      cookieFallback: false,
    });
    if (last.ok && last.data.autoRenewRaw === false) {
      return { ...last, confirmed: true, accessToken: token };
    }
    if (last.statusCode === 401 && options.refreshAccessToken) {
      const refreshed = String(
        (await options.refreshAccessToken().catch(() => "")) || "",
      ).trim();
      if (refreshed) {
        token = refreshed;
      }
    }
    if (attempt < maxAttempts) {
      options.onStatus?.(
        `自动续费状态暂未更新，正在第 ${attempt + 1}/${maxAttempts} 次确认...`,
      );
      await sleep(Math.min(delayMs * attempt, 5000));
    }
  }

  return { ...(last || {}), confirmed: false, accessToken: token };
}

async function cancelAutoRenewWithBrowserPage(page, options = {}) {
  if (!page || page.isClosed()) {
    return {
      ok: false,
      statusCode: 400,
      error: "浏览器页面已关闭，无法使用已登录 Session 取消自动续费",
    };
  }

  const accountId = String(options.accountId || "").trim();
  if (!accountId) {
    return {
      ok: false,
      statusCode: 400,
      error: "缺少 account_id，无法取消自动续费",
    };
  }

  const maxAttempts = Math.max(1, Number(options.maxAttempts || 8));
  const requestedDelayMs = Number(options.delayMs);
  const delayMs = Math.max(
    0,
    Number.isFinite(requestedDelayMs) ? requestedDelayMs : 2000,
  );
  let lastResult = null;
  let accessToken = String(options.accessToken || "").trim();
  let cookieHeader = String(options.cookieHeader || "").trim();
  if (!cookieHeader && typeof page.context?.()?.cookies === "function") {
    const cookies = await page
      .context()
      .cookies("https://chatgpt.com")
      .catch(() => []);
    cookieHeader = cookies
      .filter((item) => item?.name && item?.value)
      .map((item) => `${item.name}=${item.value}`)
      .join("; ");
  }

  const submitWithBrowserContext = async () => {
    const request = page.context?.()?.request;
    if (!request || typeof request.post !== "function") {
      return null;
    }
    const headers = {
      Accept: "application/json, text/plain, */*",
      "Content-Type": "application/json",
      Origin: "https://chatgpt.com",
      Referer: "https://chatgpt.com/",
      "chatgpt-account-id": accountId,
      "openai-account-id": accountId,
    };
    if (accessToken) {
      headers.Authorization = `Bearer ${accessToken}`;
    }
    const response = await request.post(CANCEL_SUBSCRIPTION_URL, {
      headers,
      data: { account_id: accountId },
      timeout: Math.max(2000, Number(options.timeoutMs || 10000)),
    });
    let data;
    try {
      data = await response.json();
    } catch (_) {
      data = await response.text().catch(() => "");
    }
    return { status: response.status(), data, via: "browser-context" };
  };

  const submitWithPage = async (token = accessToken) =>
    page.evaluate(
      async ({ url, targetAccountId, token }) => {
        const headers = {
          Accept: "*/*",
          "Content-Type": "application/json",
          "chatgpt-account-id": targetAccountId,
          "openai-account-id": targetAccountId,
        };
        if (token) {
          headers.Authorization = `Bearer ${token}`;
        }
        const result = await fetch(url, {
          method: "POST",
          credentials: "include",
          headers,
          body: JSON.stringify({ account_id: targetAccountId }),
        });
        const text = await result.text();
        let data = text;
        try {
          data = text ? JSON.parse(text) : null;
        } catch (_) {}
        return { status: result.status, data, via: "page-fetch" };
      },
      {
        url: CANCEL_SUBSCRIPTION_URL,
        targetAccountId: accountId,
        token,
      },
    );

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let response;
    let refreshedThisAttempt = false;
    try {
      response = await submitWithPage();
      if (response?.status === 401 && accessToken) {
        const cookieResponse = await submitWithPage("");
        if (cookieResponse && cookieResponse.status !== 401) {
          response = cookieResponse;
        } else if (options.refreshAccessToken) {
          const refreshed = String(
            (await options.refreshAccessToken().catch(() => "")) || "",
          ).trim();
          if (refreshed && refreshed !== accessToken) {
            options.onStatus?.(
              "主界面 Session 已更新，正在使用新 AccessToken 重试...",
            );
            accessToken = refreshed;
            refreshedThisAttempt = true;
            lastResult = {
              ok: false,
              statusCode: 401,
              tokenRefreshed: true,
            };
            response = await submitWithPage(refreshed);
          } else {
            response = cookieResponse || response;
          }
        } else {
          response = cookieResponse || response;
        }
      }
      if (!response || response.status === 401 || response.status === 403) {
        const contextResponse = await submitWithBrowserContext();
        if (contextResponse) {
          response = contextResponse;
        }
      }
    } catch (error) {
      lastResult = {
        ok: false,
        statusCode: 502,
        error: `浏览器取消自动续费请求失败：${error.message}`,
      };
    }

    if (response?.status === 200 || response?.status === 204) {
      options.onStatus?.("取消请求已受理，正在确认自动续费状态...");
      let verify = accessToken
        ? await verifyAutoRenewDisabledWithBrowserPage(page, accessToken, {
            timezoneOffsetMin: options.timezoneOffsetMin,
            email: options.email || "",
            maxAttempts: options.verifyAttempts,
            delayMs: options.verifyDelayMs,
            refreshAccessToken: options.refreshAccessToken,
            onStatus: options.onStatus,
          })
        : { ok: false, confirmed: false };
      if (!verify.confirmed && accessToken) {
        verify = await verifyAutoRenewDisabled(accessToken, {
          timezoneOffsetMin: options.timezoneOffsetMin,
          email: options.email || "",
          maxAttempts: 1,
          delayMs: 0,
          proxy: options.proxy,
          cookieHeader,
          onStatus: options.onStatus,
        });
      }
      return {
        ok: true,
        data: {
          cancelled: true,
          confirmed: Boolean(verify.confirmed),
          pendingVerify: !verify.confirmed,
          via: response.via || "browser",
          ...(verify.ok ? verify.data : {}),
          message: verify.confirmed
            ? "已成功关闭自动续费，当前周期仍可继续使用"
            : "已提交取消自动续费请求，请稍后刷新确认状态",
        },
      };
    }

    if (response) {
      const body = normalizeResponseBody(response.data);
      if (response.status === 401) {
        lastResult = {
          ok: false,
          ...mapUnauthorizedError(body),
          tokenRefreshed: Boolean(lastResult?.tokenRefreshed),
        };
      } else if (response.status === 403) {
        lastResult = { ok: false, ...mapCheckError(403, body) };
      } else {
        const detail =
          typeof body === "string"
            ? body.slice(0, 200)
            : JSON.stringify(body || {}).slice(0, 200);
        lastResult = {
          ok: false,
          statusCode: response.status || 502,
          error: `取消自动续费失败 (${response.status || 0})${detail ? `：${detail}` : ""}`,
        };
      }
    }

    if (
      !refreshedThisAttempt &&
      lastResult?.statusCode === 401 &&
      options.refreshAccessToken
    ) {
      const refreshed = String(
        (await options.refreshAccessToken().catch(() => "")) || "",
      ).trim();
      if (refreshed && refreshed !== accessToken) {
        options.onStatus?.("主界面 Session 已更新，正在使用新 AccessToken 重试...");
        accessToken = refreshed;
        lastResult.tokenRefreshed = true;
      }
    }

    const shouldRetry =
      [400, 404, 409, 425, 429, 502, 503, 504].includes(
        Number(lastResult?.statusCode || 0),
      ) ||
      (lastResult?.statusCode === 401 && Boolean(lastResult.tokenRefreshed)) ||
      /no active subscription|no subscription|not ready|not found|propagat/i.test(
        String(lastResult?.error || ""),
      );
    const isPropagation =
      [404, 409, 425].includes(Number(lastResult?.statusCode || 0)) ||
      /no active subscription|no subscription|not ready|not found|propagat/i.test(
        String(lastResult?.error || ""),
      );
    const tokenExpired = /AccessToken 已被 OpenAI 判定过期/.test(
      String(lastResult?.error || ""),
    );
    if (!shouldRetry || attempt === maxAttempts) {
      if (accessToken && !isPropagation && !tokenExpired) {
        break;
      }
      return lastResult;
    }
    if (isPropagation) {
      options.onStatus?.(
        `订阅尚未同步，正在第 ${attempt + 1}/${maxAttempts} 次关闭自动续费...`,
      );
      await sleep(
        delayMs === 0 ? 0 : Math.min(Math.max(delayMs, 800) * attempt, 3000),
      );
    } else {
      await sleep(
        refreshedThisAttempt
          ? Math.min(delayMs, 400)
          : Math.min(delayMs * attempt, 8000),
      );
    }
  }

  const skipExpiredTokenFallback =
    /AccessToken 已被 OpenAI 判定过期/.test(String(lastResult?.error || "")) ||
    [404, 409, 425].includes(Number(lastResult?.statusCode || 0)) ||
    /no active subscription|no subscription|not ready|not found|propagat/i.test(
      String(lastResult?.error || ""),
    );
  if (accessToken && !skipExpiredTokenFallback) {
    options.onStatus?.(
      `浏览器取消未成功${lastResult?.statusCode ? `（HTTP ${lastResult.statusCode}）` : ""}，正在改用 AccessToken 重试...`,
    );
    const fallback = await cancelAutoRenewAfterActivation(accessToken, {
      accountId,
      email: options.email || "",
      timezoneOffsetMin: options.timezoneOffsetMin,
      maxAttempts: options.fallbackAttempts,
      delayMs: options.fallbackDelayMs,
      timeoutMs: options.timeoutMs,
      proxy: options.proxy,
      cookieHeader,
    });
    if (!fallback.ok) {
      if (fallback.statusCode === 401 && options.paymentFailureNote) {
        return {
          ...fallback,
          error: `${fallback.error || "订阅取消接口返回 401"}；支付已成功，但自动续费尚未关闭`,
        };
      }
      return fallback;
    }

    options.onStatus?.("AccessToken 取消请求已受理，正在确认自动续费状态...");
    const verify = await verifyAutoRenewDisabled(accessToken, {
      timezoneOffsetMin: options.timezoneOffsetMin,
      email: options.email || "",
      maxAttempts: options.verifyAttempts,
      delayMs: options.verifyDelayMs,
      proxy: options.proxy,
      cookieHeader,
      onStatus: options.onStatus,
    });
    return {
      ok: true,
      data: {
        ...(fallback.data || {}),
        ...(verify.ok ? verify.data : {}),
        cancelled: true,
        confirmed: Boolean(verify.confirmed),
        pendingVerify: !verify.confirmed,
        via: "token-fallback",
        message: verify.confirmed
          ? "已成功关闭自动续费，当前周期仍可继续使用"
          : "已提交取消自动续费请求，请稍后刷新确认状态",
      },
    };
  }

  return lastResult;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shouldRetryCancelAutoRenew(result) {
  if (!result || result.ok) {
    return false;
  }
  const status = Number(result.statusCode || 0);
  if (
    status === 400 &&
    /App Store|无法通过 API 取消/.test(String(result.error || ""))
  ) {
    return false;
  }
  if (status === 401) {
    return false;
  }
  return true;
}

async function cancelAutoRenewAfterActivation(accessToken, options = {}) {
  const maxAttempts = Math.max(1, Number(options.maxAttempts || 2));
  const delayMs = Math.max(300, Number(options.delayMs || 800));
  let last = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    last = await cancelAutoRenew(accessToken, {
      ...options,
      skipPreCheck: true,
      skipVerify: true,
      preferAxios: true,
      timeoutMs: Number(options.timeoutMs || 8000),
    });
    if (last.ok) {
      return last;
    }
    if (!shouldRetryCancelAutoRenew(last) || attempt === maxAttempts) {
      return last;
    }
    await sleep(delayMs);
  }

  return last;
}

async function resumeAutoRenew(accessToken, options = {}) {
  const token = String(accessToken || "").trim();
  if (!token) {
    return { ok: false, statusCode: 400, error: "缺少 AccessToken" };
  }

  const profile = extractProfileFromToken(token);
  const accountId = String(options.accountId || profile.accountId || "").trim();
  if (!accountId) {
    return {
      ok: false,
      statusCode: 400,
      error: "无法解析 account_id，请确认 Session 完整有效",
    };
  }

  const checkResult = await querySubscriptionBySession(token, {
    timezoneOffsetMin: options.timezoneOffsetMin,
    email: options.email || profile.email || "",
    proxy: options.proxy,
    cookieHeader: options.cookieHeader,
  });
  if (!checkResult.ok) {
    return checkResult;
  }

  const subscription = checkResult.data;
  if (isAppStoreOrigin(subscription.subscriptionChannelRaw)) {
    return {
      ok: false,
      statusCode: 400,
      error: `该订阅来自 ${subscription.subscriptionChannel}，无法通过 API 开启，请在对应平台操作`,
    };
  }

  if (!subscription.hasActiveSubscription) {
    return {
      ok: false,
      statusCode: 400,
      error: "账号当前无有效订阅，无法开启自动续费",
    };
  }

  if (subscription.autoRenewRaw === true) {
    return {
      ok: true,
      data: {
        ...subscription,
        alreadyEnabled: true,
        message: "自动续费已开启，无需重复操作",
      },
    };
  }

  let response;
  try {
    response = await requestOpenAiJson(token, {
      method: "POST",
      url: RESUME_SUBSCRIPTION_URL,
      body: { account_id: accountId },
      proxy: options.proxy,
      cookieHeader: options.cookieHeader,
    });
  } catch (error) {
    return {
      ok: false,
      statusCode: 502,
      error: `开启自动续费请求失败：${error.message}`,
    };
  }

  const body = normalizeResponseBody(response.data);
  if (response.status === 401) {
    return { ok: false, ...mapUnauthorizedError(body) };
  }
  if (response.status === 403) {
    const mapped = mapCheckError(403, body);
    return { ok: false, ...mapped };
  }
  if (response.status !== 200 && response.status !== 204) {
    const detail =
      typeof body === "string"
        ? body.slice(0, 200)
        : JSON.stringify(body || {}).slice(0, 200);
    return {
      ok: false,
      statusCode: response.status || 502,
      error: `开启自动续费失败 (${response.status})${detail ? `：${detail}` : ""}`,
    };
  }

  const verify = await querySubscriptionBySession(token, {
    timezoneOffsetMin: options.timezoneOffsetMin,
    email: options.email || profile.email || "",
    proxy: options.proxy,
  });

  return {
    ok: true,
    data: {
      ...(verify.ok ? verify.data : subscription),
      alreadyEnabled: false,
      resumed: true,
      message:
        verify.ok && verify.data.autoRenewRaw === true
          ? "已成功开启自动续费"
          : "已提交开启自动续费请求，请稍后刷新确认状态",
    },
  };
}

async function resumeAutoRenewWithBrowserPage(page, options = {}) {
  if (!page || page.isClosed()) {
    return {
      ok: false,
      statusCode: 400,
      error: "浏览器页面已关闭，无法使用已登录 Session 开启自动续费",
    };
  }

  let accessToken = String(options.accessToken || "").trim();
  const profile = extractProfileFromToken(accessToken);
  const accountId = String(options.accountId || profile.accountId || "").trim();
  if (!accountId) {
    return {
      ok: false,
      statusCode: 400,
      error: "缺少 account_id，无法开启自动续费",
    };
  }

  const status = await queryAccountStatusWithBrowserPage(page, accessToken, {
    timezoneOffsetMin: options.timezoneOffsetMin,
    email: options.email || profile.email || "",
  });
  if (!status.ok) {
    return status;
  }
  if (isAppStoreOrigin(status.data.subscriptionChannelRaw)) {
    return {
      ok: false,
      statusCode: 400,
      error: `该订阅来自 ${status.data.subscriptionChannel}，无法通过 API 开启，请在对应平台操作`,
    };
  }
  if (!status.data.hasActiveSubscription) {
    return {
      ok: false,
      statusCode: 400,
      error: "账号当前无有效订阅，无法开启自动续费",
    };
  }
  if (status.data.autoRenewRaw === true) {
    return {
      ok: true,
      data: {
        ...status.data,
        alreadyEnabled: true,
        message: "自动续费已开启，无需重复操作",
      },
    };
  }

  let response = await requestJsonWithBrowserPage(page, {
    url: RESUME_SUBSCRIPTION_URL,
    method: "POST",
    token: accessToken,
    accountId,
    body: { account_id: accountId },
  });
  if (response?.status === 401 && options.refreshAccessToken) {
    const refreshed = String(
      (await options.refreshAccessToken().catch(() => "")) || "",
    ).trim();
    if (refreshed) {
      accessToken = refreshed;
      response = await requestJsonWithBrowserPage(page, {
        url: RESUME_SUBSCRIPTION_URL,
        method: "POST",
        token: accessToken,
        accountId,
        body: { account_id: accountId },
      });
    }
  }
  if (response?.status !== 200 && response?.status !== 204) {
    const body = normalizeResponseBody(response?.data);
    return { ok: false, ...mapCheckError(response?.status || 502, body) };
  }

  const verify = await queryAccountStatusWithBrowserPage(page, accessToken, {
    timezoneOffsetMin: options.timezoneOffsetMin,
    email: options.email || profile.email || "",
  });
  return {
    ok: true,
    data: {
      ...(verify.ok ? verify.data : status.data),
      alreadyEnabled: false,
      resumed: true,
      via: "page-fetch",
      message:
        verify.ok && verify.data.autoRenewRaw === true
          ? "已成功开启自动续费"
          : "已提交开启自动续费请求，请稍后刷新确认状态",
    },
  };
}

async function resetCodexQuotaWithBrowserPage(page, options = {}) {
  if (!page || page.isClosed()) {
    return {
      ok: false,
      statusCode: 400,
      error: "浏览器页面已关闭，无法重置 Codex 额度",
    };
  }
  let accessToken = String(options.accessToken || "").trim();
  const result = await resetCodexQuota(accessToken, options);
  if (result.ok || ![401, 403].includes(Number(result.statusCode || 0))) {
    return result;
  }
  if (options.refreshAccessToken) {
    const refreshed = String(
      (await options.refreshAccessToken().catch(() => "")) || "",
    ).trim();
    if (refreshed) {
      accessToken = refreshed;
    }
  }
  const accountId = String(
    options.accountId || extractProfileFromToken(accessToken).accountId || "",
  ).trim();
  const response = await requestJsonWithBrowserPage(page, {
    url: CODEX_QUOTA_RESET_URL,
    method: "POST",
    token: accessToken,
    accountId,
    body: { redeem_request_id: `acct-${Date.now()}` },
  });
  if (response?.status !== 200 && response?.status !== 204) {
    const body = normalizeResponseBody(response?.data);
    return { ok: false, ...mapCheckError(response?.status || 502, body) };
  }
  const refreshed = await queryAccountStatusWithBrowserPage(page, accessToken, {
    timezoneOffsetMin: options.timezoneOffsetMin,
    email: options.email || "",
  });
  return {
    ok: true,
    data: {
      ...(refreshed.ok ? refreshed.data : { accountId }),
      reset: true,
      via: "page-fetch",
      message: "已提交 Codex 额度重置请求",
    },
  };
}

function mapCheckError(status, data) {
  const body = normalizeResponseBody(data);

  if (status === 401) {
    return mapUnauthorizedError(body);
  }

  if (status === 403) {
    if (isCloudflareBlock(status, body)) {
      return {
        statusCode: 403,
        error:
          "OpenAI 风控拦截（Cloudflare），请稍后重试或在后台配置住宅代理 PROXY",
      };
    }
    return {
      statusCode: 403,
      error:
        "OpenAI 拒绝访问（403），请确认 Session 来自 chatgpt.com 且 accessToken 未过期",
    };
  }

  if (!status) {
    return {
      statusCode: 502,
      error: `无法连接 OpenAI 订阅接口：${String(body || "network error")}`,
    };
  }

  const detail =
    typeof body === "string"
      ? body.slice(0, 200)
      : JSON.stringify(body || {}).slice(0, 200);
  return {
    statusCode: status || 502,
    error: `OpenAI 返回异常 (${status})${detail ? `：${detail}` : ""}`,
  };
}

async function querySubscriptionBySession(accessToken, options = {}) {
  const token = String(accessToken || "").trim();
  if (!token) {
    return { ok: false, statusCode: 400, error: "缺少 AccessToken" };
  }

  const profile = {
    ...extractProfileFromToken(token),
    email: String(
      options.email || extractProfileFromToken(token).email || "",
    ).trim(),
  };

  let response;
  try {
    response = await fetchAccountCheck(
      token,
      options.timezoneOffsetMin,
      options.proxy,
      options.cookieHeader,
    );
  } catch (error) {
    return {
      ok: false,
      statusCode: 502,
      error: `无法连接 OpenAI 订阅接口：${error.message}`,
    };
  }

  const body = normalizeResponseBody(response.data);
  if (response.status !== 200) {
    const mapped = mapCheckError(response.status, body);
    return { ok: false, ...mapped };
  }

  if (!body || typeof body !== "object") {
    return { ok: false, statusCode: 502, error: "OpenAI 返回数据格式异常" };
  }

  return {
    ok: true,
    data: parseAccountCheckResponse(body, profile),
  };
}

module.exports = {
  BILLING_PAGE_URL,
  normalizeSubscriptionPlan,
  formatPurchaseOrigin,
  computeRemainingDays,
  parseAccountCheckResponse,
  parseCodexQuotaPayload,
  validateSessionTokenForQuery,
  querySubscriptionBySession,
  queryAccountStatusBySession,
  queryAccountStatusWithBrowserPage,
  createChatGptLiveStateTracker,
  prepareLiveChatGptSubscription,
  resetCodexQuota,
  resetCodexQuotaWithBrowserPage,
  cancelAutoRenew,
  cancelAutoRenewWithBrowserPage,
  cancelAutoRenewAfterActivation,
  resumeAutoRenew,
  resumeAutoRenewWithBrowserPage,
};
