"use strict";

const axios = require("axios");
const store = require("./mysql-store");
const { getRegionConfig } = require("./region-config");
const { executePaymentWithRetry } = require("./payment-retry");
const { extractProfileFromToken } = require("./session-auth");

const CHECKOUT_API_PATH = "/backend-api/payments/checkout";
const CHECKOUT_API_URL = `https://chatgpt.com${CHECKOUT_API_PATH}`;
const ACCOUNT_CHECK_PATH = "/backend-api/accounts/check/v4-2023-04-27";
const CHATGPT_HOME_URL = "https://chatgpt.com/";

function resolveProcessorEntity(country) {
  return String(country || "").toUpperCase() === "US"
    ? "openai_llc"
    : "openai_ie";
}

function buildCheckoutPayload(planName, country, currency, options = {}) {
  const uiMode =
    String(options.uiMode || process.env.CHECKOUT_UI_MODE || "custom").trim() ||
    "custom";
  const payload = {
    entry_point: "all_plans_pricing_modal",
    plan_name: planName,
    checkout_ui_mode: uiMode,
    billing_details: { country, currency },
    cancel_url: "https://chatgpt.com/",
  };
  const accountId = String(options.accountId || "").trim();
  if (accountId) {
    payload.account_id = accountId;
    payload.openai_account_id = accountId;
  }
  return payload;
}

function buildCheckoutHeaders(accessToken, extra = {}) {
  const token = String(accessToken || "").trim();
  const profile = extractProfileFromToken(token);
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    Accept: "application/json",
    ...extra,
  };
  const accountId = String(extra.accountId || profile.accountId || "").trim();
  if (accountId) {
    headers["chatgpt-account-id"] = accountId;
    headers["openai-account-id"] = accountId;
  }
  delete headers.accountId;
  return headers;
}

function listAccountCheckRecords(data) {
  const accounts = data?.accounts;
  if (!accounts || typeof accounts !== "object") return [];
  if (Array.isArray(accounts)) return accounts.filter(Boolean);
  return Object.entries(accounts).map(([key, item]) => ({
    ...(item && typeof item === "object" ? item : {}),
    __key: key,
  }));
}

function getAccountRecordMeta(record) {
  const account = record?.account || record || {};
  const entitlement = record?.entitlement || {};
  const plan = String(entitlement.subscription_plan || "").trim();
  const structure = String(
    account.structure ||
      account.account_structure ||
      account.type ||
      record?.structure ||
      "",
  ).toLowerCase();
  const name = String(
    account.name ||
      account.account_name ||
      account.workspace_name ||
      account.workspaceName ||
      "",
  );
  return {
    accountId: String(account.account_id || account.accountId || "").trim(),
    plan,
    hasActive: entitlement.has_active_subscription === true,
    deactivated: Boolean(
      account.is_deactivated ||
      account.deactivated ||
      record?.is_deactivated ||
      /deactivat|disabled|停用/.test(
        `${account.status || ""} ${record?.status || ""} ${name}`,
      ),
    ),
    workspace: Boolean(
      structure.includes("workspace") ||
      name.toLowerCase().includes("workspace") ||
      account.is_workspace === true,
    ),
    personal: Boolean(
      structure.includes("personal") ||
      structure.includes("individual") ||
      name.includes("个人账户") ||
      /personal|individual/.test(name.toLowerCase()),
    ),
    name,
    key: String(record?.__key || ""),
  };
}

function pickCheckoutAccountRecord(data, preferredAccountId = "") {
  const records = listAccountCheckRecords(data);
  if (!records.length) return data?.accounts?.default || null;
  const preferred = String(preferredAccountId || "").trim();
  if (preferred) {
    const matched = records.find((item) => {
      const meta = getAccountRecordMeta(item);
      return meta.accountId === preferred || item.__key === preferred;
    });
    if (matched) return matched;
  }
  const scored = records
    .map((record) => {
      const meta = getAccountRecordMeta(record);
      let score = 0;
      if (meta.deactivated) score -= 50;
      if (meta.personal) score += 20;
      if (meta.workspace) score -= 15;
      if (!meta.hasActive) score += 10;
      if (meta.key === "default") score += 1;
      return { record, meta, score };
    })
    .sort((a, b) => b.score - a.score);
  return scored[0]?.record || data?.accounts?.default || null;
}

function extractAccountIdFromCheck(data, preferredAccountId = "") {
  const record = pickCheckoutAccountRecord(data, preferredAccountId);
  return getAccountRecordMeta(record).accountId;
}

function extractCheckoutPlan(data, preferredAccountId = "") {
  const record = pickCheckoutAccountRecord(data, preferredAccountId);
  const meta = getAccountRecordMeta(record);
  if (meta.deactivated || (meta.workspace && !meta.hasActive)) {
    return "";
  }
  if (meta.hasActive) return meta.plan;
  return "";
}

function describeCheckoutAccount(data, preferredAccountId = "") {
  const record = pickCheckoutAccountRecord(data, preferredAccountId);
  const meta = getAccountRecordMeta(record);
  const parts = [
    meta.personal ? "personal" : "",
    meta.workspace ? "workspace" : "",
    meta.deactivated ? "deactivated" : "",
    meta.hasActive ? "active" : "free",
    meta.name ? `name=${meta.name}` : "",
  ].filter(Boolean);
  return parts.join(",") || "unknown";
}

function hasActiveCheckoutPlan(plan) {
  const raw = String(plan || "")
    .trim()
    .toLowerCase();
  return Boolean(raw) && raw !== "free" && !raw.includes("free");
}

function resolveCheckoutModes(plan) {
  const preferredMode =
    String(process.env.CHECKOUT_UI_MODE || "custom").trim() || "custom";
  const firstMode = hasActiveCheckoutPlan(plan) ? "hosted" : preferredMode;
  const modes = [firstMode];
  if (!hasActiveCheckoutPlan(plan) && !modes.includes("hosted")) {
    modes.push("hosted");
  }
  return modes;
}

function summarizeCheckoutCookies(cookies) {
  const names = (Array.isArray(cookies) ? cookies : [])
    .map((item) => String(item?.name || "").trim())
    .filter(Boolean);
  const has = (name) => names.includes(name);
  const sessionChunks = names.filter(
    (name) =>
      name === "__Secure-next-auth.session-token" ||
      /^__Secure-next-auth\.session-token\.\d+$/.test(name),
  );
  const markers = [
    has("oai-did") ? "oai-did" : "",
    has("oai-hlib") ? "oai-hlib" : "",
    has("oai-sc") ? "oai-sc" : "",
    has("cf_clearance") ? "cf_clearance" : "",
    has("__cf_bm") ? "__cf_bm" : "",
    sessionChunks.length ? `session-token×${sessionChunks.length}` : "",
    has("__Host-next-auth.csrf-token") ? "csrf" : "",
    has("__Secure-next-auth.callback-url") ? "callback-url" : "",
  ].filter(Boolean);
  return {
    count: names.length,
    hasOaiDid: has("oai-did"),
    markers,
  };
}

async function ensureChatGptHome(page) {
  const currentUrl = String(page.url() || "");
  if (!currentUrl.startsWith("https://chatgpt.com")) {
    await page.goto(CHATGPT_HOME_URL, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
  }
  await page
    .waitForLoadState("networkidle", { timeout: 20000 })
    .catch(() => {});
}

async function installSentinelCapture(page) {
  if (!page || page.__kcSentinelInstalled) return;
  page.__kcSentinelInstalled = true;
  page.__kcSentinelToken = "";
  page.on("request", (req) => {
    try {
      const headers = req.headers() || {};
      const token = String(
        headers["openai-sentinel-token"] ||
          headers["OpenAI-Sentinel-Token"] ||
          "",
      ).trim();
      if (token) page.__kcSentinelToken = token;
    } catch (_) {
      /* ignore */
    }
  });
  await page
    .evaluate(() => {
      if (window.__kcSentinelHook) return;
      window.__kcSentinelHook = true;
      window.__kcSentinelToken = "";
      const origFetch = window.fetch.bind(window);
      window.fetch = async function (input, init = {}) {
        try {
          const headers = (init && init.headers) || {};
          const read = (name) => {
            if (!headers) return "";
            if (typeof headers.get === "function") {
              return headers.get(name) || "";
            }
            return (
              headers[name] ||
              headers[name.toLowerCase()] ||
              headers[name.toUpperCase()] ||
              ""
            );
          };
          const token =
            read("openai-sentinel-token") ||
            read("OpenAI-Sentinel-Token") ||
            "";
          if (token) window.__kcSentinelToken = String(token);
        } catch (_) {
          /* ignore */
        }
        return origFetch(input, init);
      };
    })
    .catch(() => {});
}

async function readCapturedSentinel(page) {
  if (!page) return "";
  const fromNode = String(page.__kcSentinelToken || "").trim();
  if (fromNode) return fromNode;
  if (typeof page.evaluate !== "function") return "";
  return page
    .evaluate(() => String(window.__kcSentinelToken || "").trim())
    .catch(() => "");
}

function isCheckoutBlocked(detail = "") {
  return /unusual activity|forbidden|sentinel|blocked|403/i.test(
    String(detail || ""),
  );
}

async function waitForCheckoutCookies(page, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let summary = summarizeCheckoutCookies(
    await page.context().cookies(CHATGPT_HOME_URL),
  );
  while (Date.now() < deadline && !summary.hasOaiDid) {
    await page.waitForTimeout(500);
    summary = summarizeCheckoutCookies(
      await page.context().cookies(CHATGPT_HOME_URL),
    );
  }
  return summary;
}

function buildCheckoutWarmupRequests({
  timezoneOffsetMin = 0,
  country = "PH",
  accountId = "",
} = {}) {
  const region = String(country || "PH").toUpperCase();
  const id = String(accountId || "").trim();
  const requests = [
    { name: "session", path: "/api/auth/session", auth: false },
    {
      name: "accounts/check",
      path: `${ACCOUNT_CHECK_PATH}?timezone_offset_min=${Number(timezoneOffsetMin) || 0}`,
    },
    {
      name: "conversations",
      path: "/backend-api/conversations?offset=0&limit=28",
    },
    { name: "subscriptions", path: "/backend-api/subscriptions" },
    {
      name: "payments/subscription",
      path: "/backend-api/payments/subscription",
    },
    {
      name: "pricing_config",
      path: `/backend-api/checkout_pricing_config/configs/${region}`,
    },
  ];
  if (id) {
    requests.push(
      {
        name: "billing_info",
        path: `/backend-api/payments/billing_info?account_id=${encodeURIComponent(id)}`,
        accountHeader: true,
      },
      {
        name: "stripe_bootstrap",
        path: `/backend-api/payments/stripe_client_bootstrap?account_id=${encodeURIComponent(id)}`,
        accountHeader: true,
      },
    );
  }
  return requests;
}

async function fetchSameOriginGets(page, { token, accountId, requests }) {
  return page.evaluate(
    async ({ token, accountId, requests }) => {
      const results = [];
      for (const item of requests) {
        const headers = { accept: "application/json" };
        if (item.auth !== false) {
          headers.authorization = `Bearer ${token}`;
        }
        if (accountId && item.accountHeader) {
          headers["chatgpt-account-id"] = accountId;
          headers["openai-account-id"] = accountId;
        }
        try {
          const response = await fetch(item.path, {
            method: "GET",
            credentials: "include",
            headers,
          });
          const text = await response.text();
          results.push({
            name: item.name,
            status: response.status,
            bytes: text.length,
            bodyText: item.name === "accounts/check" ? text : "",
          });
        } catch (err) {
          results.push({
            name: item.name,
            status: 0,
            bodyText: "",
            error: String((err && err.message) || err),
          });
        }
      }
      return results;
    },
    {
      token: String(token || "").trim(),
      accountId: String(accountId || "").trim(),
      requests,
    },
  );
}

function formatWarmupStatuses(results) {
  return (Array.isArray(results) ? results : [])
    .map((item) => `${item.name}=${item.status}${item.error ? "/err" : ""}`)
    .join(" ");
}

async function openPricingModalForWarmup(page) {
  try {
    const pricing = require("./pricing-checkout");
    if (await pricing.isPricingModalVisible(page)) {
      return "already-open";
    }
    const opened = await pricing.openPricingModalFromChat(page);
    if (opened) {
      await page
        .waitForLoadState("networkidle", { timeout: 15000 })
        .catch(() => {});
      await page.waitForTimeout(1200);
      return "opened";
    }
    await page.goto("https://chatgpt.com/?upgrade=plus", {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    await page
      .waitForLoadState("networkidle", { timeout: 20000 })
      .catch(() => {});
    await page.waitForTimeout(1500);
    if (await pricing.isPricingModalVisible(page)) {
      return "hash-open";
    }
    const retry = await pricing.openPricingModalFromChat(page);
    if (retry) {
      return "opened";
    }
    return "missing";
  } catch (err) {
    return `skip:${String((err && err.message) || err).slice(0, 80)}`;
  }
}

async function warmupCheckoutContext(page, accessToken, options = {}) {
  const country = String(options.country || "PH").toUpperCase();
  await ensureChatGptHome(page);
  await installSentinelCapture(page);
  let cookies = await waitForCheckoutCookies(page);
  if (!cookies.hasOaiDid) {
    await page
      .reload({ waitUntil: "domcontentloaded", timeout: 60000 })
      .catch(() => {});
    await page
      .waitForLoadState("networkidle", { timeout: 20000 })
      .catch(() => {});
    cookies = await waitForCheckoutCookies(page, 8000);
  }

  const modal = "skip";
  cookies = summarizeCheckoutCookies(
    await page.context().cookies(CHATGPT_HOME_URL),
  );

  const timezoneOffsetMin = await page
    .evaluate(() => new Date().getTimezoneOffset())
    .catch(() => 0);
  let accountId = String(
    options.accountId || extractProfileFromToken(accessToken).accountId || "",
  ).trim();

  const firstWave = buildCheckoutWarmupRequests({
    timezoneOffsetMin,
    country,
    accountId: "",
  });
  const firstResults = await fetchSameOriginGets(page, {
    token: accessToken,
    accountId: "",
    requests: firstWave,
  });

  let plan = "";
  let accountKind = "";
  const checkResult = firstResults.find(
    (item) => item.name === "accounts/check",
  );
  if (checkResult?.bodyText) {
    try {
      const data = JSON.parse(checkResult.bodyText);
      accountId = extractAccountIdFromCheck(data, accountId);
      plan = extractCheckoutPlan(data, accountId);
      accountKind = describeCheckoutAccount(data, accountId);
    } catch (_) {
      /* ignore non-JSON */
    }
  }

  let secondResults = [];
  if (accountId) {
    const secondWave = buildCheckoutWarmupRequests({
      timezoneOffsetMin,
      country,
      accountId,
    }).filter((item) =>
      ["billing_info", "stripe_bootstrap"].includes(item.name),
    );
    secondResults = await fetchSameOriginGets(page, {
      token: accessToken,
      accountId,
      requests: secondWave,
    });
  }

  const results = [...firstResults, ...secondResults];
  cookies = summarizeCheckoutCookies(
    await page.context().cookies(CHATGPT_HOME_URL),
  );

  console.log(
    `[ChatGPT] Checkout 预热 url=${String(page.url() || "").slice(0, 80)} cookies=${cookies.count} present=${cookies.markers.join(",") || "none"} oai-did=${cookies.hasOaiDid ? "yes" : "no"} modal=${modal}`,
  );
  console.log(
    `[ChatGPT] accounts/check status=${checkResult?.status ?? 0} account_id=${accountId || "none"} plan=${plan || "none"} kind=${accountKind || "unknown"}`,
  );
  console.log(`[ChatGPT] Checkout 预热请求 ${formatWarmupStatuses(results)}`);

  return {
    accountId,
    plan,
    cookies,
    accountKind,
    checkStatus: checkResult?.status ?? 0,
    modal,
    results,
  };
}

function formatApiErrorDetail(detail, fallback = "") {
  if (detail == null || detail === "") return fallback;
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) {
    return detail
      .map((item) =>
        typeof item === "object" ? JSON.stringify(item) : String(item),
      )
      .join("; ");
  }
  if (typeof detail === "object") {
    if (detail.message) return String(detail.message);
    if (detail.msg) return String(detail.msg);
    return JSON.stringify(detail);
  }
  return String(detail);
}

function parseCheckoutApiBody(status, bodyText) {
  let data = {};
  try {
    data = bodyText ? JSON.parse(bodyText) : {};
  } catch (_) {
    data = {};
  }

  if (status !== 200) {
    const detail = formatApiErrorDetail(
      data.detail ?? data.message ?? data.error,
      bodyText.slice(0, 500) || `HTTP ${status}`,
    );
    return { ok: false, status, data, error: detail };
  }

  return { ok: true, status, data };
}

function parseCheckoutApiResponse(status, bodyText, country = "") {
  const parsed = parseCheckoutApiBody(status, bodyText);
  if (!parsed.ok) {
    return parsed;
  }

  const service = new ChatGPTService(null, "");
  const resolved = service.resolveCheckoutUrl(parsed.data, country);
  if (!resolved.checkoutUrl) {
    return {
      ok: false,
      status,
      data: parsed.data,
      error: `API 未返回 checkout_session_id 或 url: ${JSON.stringify(parsed.data).slice(0, 300)}`,
    };
  }

  return { ok: true, status, data: parsed.data, ...resolved };
}

/**
 * 使用 axios 直接调用 Checkout API（供后台调试 / 无 Playwright 场景）
 */
async function createHostedCheckoutLink({
  accessToken,
  planType = "plus",
  planName,
  country,
  currency,
}) {
  const token = String(accessToken || "").trim();
  if (!token) {
    return { success: false, error: "缺少 AccessToken" };
  }

  const region = String(country || "PH").toUpperCase();
  const billingCurrency = String(
    currency || getRegionConfig(region)?.currency || "PHP",
  ).toUpperCase();
  const planNameResolved = String(
    planName || store.resolvePlanName(planType),
  ).trim();
  const payload = buildCheckoutPayload(
    planNameResolved,
    region,
    billingCurrency,
  );

  const response = await axios.post(CHECKOUT_API_URL, payload, {
    headers: buildCheckoutHeaders(token),
    validateStatus: () => true,
    timeout: 30000,
  });

  const parsed = parseCheckoutApiResponse(
    response.status,
    JSON.stringify(response.data ?? {}),
  );
  const base = {
    plan_type: planType,
    plan_name: planNameResolved,
    country: region,
    currency: billingCurrency,
    request: payload,
    response: parsed.data,
    http_status: parsed.status,
  };

  if (!parsed.ok) {
    return { success: false, ...base, error: parsed.error };
  }

  return {
    success: true,
    ...base,
    url: parsed.checkoutUrl,
    session_id: parsed.sessionId,
  };
}

/**
 * ChatGPT 订阅服务 — Stripe 信用卡直付版本
 *
 * 职责：
 * 1. 根据 plan_type 解析 plan_name（通过 store.resolvePlanName）
 * 2. 创建 Stripe Checkout Session（调用 OpenAI 后端 API）
 * 3. 协调卡池管理、免税地址、Stripe 表单自动化完成支付
 * 4. 委托 payment-retry.js 处理支付重试与卡片轮换逻辑
 * 5. 记录账单信息（成功/失败）
 */
class ChatGPTService {
  /**
   * @param {object} request - Playwright context.request 实例
   * @param {string} token - OpenAI Bearer Token
   */
  constructor(request, token) {
    this.request = request;
    this.token = token;
    this.headers = buildCheckoutHeaders(this.token);
  }

  /**
   * 从 checkout API 响应解析支付链接
   * custom 模式：用 checkout_session_id 拼 https://chatgpt.com/checkout/openai_llc/{id}
   * hosted 模式：优先使用 API 返回的 url
   */
  resolveCheckoutUrl(data, country = "") {
    if (!data || typeof data !== "object") {
      return { sessionId: null, checkoutUrl: null };
    }

    const jsonText = JSON.stringify(data);
    const sessionId =
      data.checkout_session_id ||
      data.session_id ||
      jsonText.match(/cs_(?:live|test)_[A-Za-z0-9]+/)?.[0] ||
      jsonText.match(/oaics_[A-Za-z0-9]+/)?.[0] ||
      null;

    const apiUrl = String(
      data.url || data.stripe_hosted_url || data.checkout_url || "",
    ).trim();
    if (apiUrl.startsWith("http")) {
      return { sessionId, checkoutUrl: apiUrl };
    }

    if (sessionId) {
      const processorEntity =
        data.processor_entity || resolveProcessorEntity(country);
      return {
        sessionId,
        checkoutUrl: `https://chatgpt.com/checkout/${processorEntity}/${sessionId}`,
      };
    }

    return { sessionId, checkoutUrl: null };
  }

  async postCheckoutFromPage(page, payload) {
    await installSentinelCapture(page);
    const sentinel = await readCapturedSentinel(page);
    const headers = { ...this.headers };
    if (sentinel) headers["openai-sentinel-token"] = sentinel;
    const result = await page.evaluate(
      async ({ path, payload, headers }) => {
        try {
          const response = await fetch(path, {
            method: "POST",
            credentials: "include",
            headers,
            body: JSON.stringify(payload),
          });
          return {
            status: response.status,
            bodyText: await response.text(),
            sentinelBytes: String(headers["openai-sentinel-token"] || "")
              .length,
          };
        } catch (err) {
          return {
            status: 0,
            bodyText: "",
            error: String((err && err.message) || err),
            sentinelBytes: String(headers["openai-sentinel-token"] || "")
              .length,
          };
        }
      },
      {
        path: CHECKOUT_API_PATH,
        payload,
        headers,
      },
    );
    if (result.error && !result.bodyText) {
      throw new Error(result.error);
    }
    if (result.sentinelBytes) {
      console.log(
        `[ChatGPT] 正常网页 Checkout 已提交: HTTP ${result.status}, Sentinel=${result.sentinelBytes} bytes`,
      );
    }
    return parseCheckoutApiBody(result.status, result.bodyText);
  }

  async postCheckoutRequest(payload, page, { forcePage = false } = {}) {
    if (forcePage && page && typeof page.evaluate === "function") {
      await ensureChatGptHome(page);
      await installSentinelCapture(page);
      return this.postCheckoutFromPage(page, payload);
    }

    const response = await this.request.post(CHECKOUT_API_URL, {
      headers: this.headers,
      data: payload,
    });
    const bodyText = await response.text().catch(() => "");
    return parseCheckoutApiBody(response.status(), bodyText);
  }

  /**
   * 创建 Stripe Checkout Session，根据 plan_type 选择对应 plan_name
   * @param {string} planType - 'plus' | 'pro_5x' | 'pro_20x'
   * @param {string} country - ISO 3166-1 alpha-2 国家代码
   * @param {string} currency - 币种代码 (USD/SGD/MYR)
   * @param {string} [planNameOverride] - 可选，覆盖默认 plan_name
   * @returns {Promise<{ sessionId: string|null, checkoutUrl: string|null, error?: string }>}
   */
  async createCheckoutSession(
    planType,
    country,
    currency,
    planNameOverride,
    options = {},
  ) {
    try {
      const planName = String(
        planNameOverride || store.resolvePlanName(planType),
      ).trim();
      const profile = extractProfileFromToken(this.token);
      let accountId = String(profile.accountId || "").trim();
      let warmupPlan = "";
      if (options.page && typeof options.page.evaluate === "function") {
        const warmup = await warmupCheckoutContext(options.page, this.token, {
          country,
          accountId,
        });
        if (!accountId && warmup.accountId) {
          accountId = warmup.accountId;
        }
        warmupPlan = String(warmup.plan || "").trim();
        if (accountId) {
          this.headers = buildCheckoutHeaders(this.token, { accountId });
        }
      }
      const modes = resolveCheckoutModes(warmupPlan);
      console.log(
        `[ChatGPT] 创建 Checkout Session: plan_name=${planName}, country=${country}, currency=${currency}, account_id=${accountId || "none"}, current_plan=${warmupPlan || "none"}, modes=${modes.join("->")}${options.page ? ", via=page-fetch" : ""}`,
      );

      let lastParsed = null;
      for (const uiMode of modes) {
        const payload = buildCheckoutPayload(planName, country, currency, {
          uiMode,
          accountId,
        });
        console.log(`[ChatGPT] 尝试 checkout 模式: ${planType}-${uiMode}`);
        let parsed = await this.postCheckoutRequest(payload, null);
        lastParsed = parsed;
        if (
          !parsed.ok &&
          isCheckoutBlocked(parsed.error) &&
          options.page &&
          typeof options.page.evaluate === "function"
        ) {
          console.log(
            "[ChatGPT] 协议创建订单被拦截；正在按正常网页上下文重新创建一次。",
          );
          console.log(
            "[ChatGPT] 启动 Chromium 浏览器执行 Sentinel Checkout...",
          );
          parsed = await this.postCheckoutRequest(payload, options.page, {
            forcePage: true,
          });
          lastParsed = parsed;
        }
        if (parsed.ok) {
          const resolved = this.resolveCheckoutUrl(parsed.data, country);
          if (resolved.checkoutUrl) {
            console.log(
              `✅ 订单创建成功 (${planType}-browser-sentinel, session: ${resolved.sessionId ? resolved.sessionId.slice(0, 24) + "..." : "unknown"})`,
            );
            console.log(
              `    支付链接: ${resolved.checkoutUrl.slice(0, 120)}...`,
            );
            return {
              sessionId: resolved.sessionId,
              checkoutUrl: resolved.checkoutUrl,
              accountId,
              data: parsed.data,
            };
          }
          console.warn(
            `[Warn] Checkout ${uiMode} 未返回有效支付链接，尝试下一模式`,
          );
          continue;
        }

        const detail = parsed.error;
        console.error(
          `[-] 订单创建失败 (mode=${uiMode}, Status: ${parsed.status})`,
        );
        console.error(`    响应: ${detail}`);
        if (
          String(detail).includes("not_eligible") ||
          String(detail).includes("Offer not found")
        ) {
          console.error("❌ [提示] 该账号不符合当前套餐/地区订阅条件");
          return { sessionId: null, checkoutUrl: null, error: detail };
        }
        if (
          String(detail).includes("permission") ||
          String(detail).includes("already_subscribed")
        ) {
          console.error("❌ [提示] 该账号可能已订阅或无权重复开通");
          return { sessionId: null, checkoutUrl: null, error: detail };
        }
        if (/unusual activity/i.test(String(detail))) {
          console.error(
            "❌ [提示] Checkout 被风控拦截，当前出口 IP / 账号组合被判定异常",
          );
          continue;
        }
      }

      const detail = lastParsed?.error || "未返回 data.url";
      return { sessionId: null, checkoutUrl: null, error: detail };
    } catch (e) {
      console.error("[-] 创建 Checkout Session 异常:", e.message);
      return { sessionId: null, checkoutUrl: null, error: e.message };
    }
  }

  /**
   * @deprecated 请使用 createCheckoutSession 返回的 checkoutUrl
   */
  buildCheckoutUrl(checkoutSessionId) {
    if (!checkoutSessionId) {
      return null;
    }
    return `https://pay.openai.com/c/pay/${checkoutSessionId}`;
  }

  /**
   * 完整的 Stripe 信用卡支付流程
   *
   * 委托 payment-retry.js 处理卡片轮换和重试逻辑：
   * - 从卡池分配卡片（store.reserveCard）
   * - 填写 Stripe 表单（completeStripeCardPayment）
   * - 表单校验失败 → 同卡重试最多 2 次
   * - Stripe 拒绝 → 标记卡片报废，换卡
   * - 连续 3 张卡失败 → 终止，status='payment_failed'
   * - 记录账单（store.createBillingRecord）
   *
   * @param {import('playwright').Page} page - Playwright Page 实例
   * @param {object} options
   * @param {string} options.planType - 'plus' | 'pro_5x' | 'pro_20x'
   * @param {string} [options.cdkCode] - 关联的 CDK 码
   * @param {string} [options.email] - 关联的邮箱
   * @returns {Promise<{ success: boolean, error?: string, status?: string }>}
   */
  async processStripePayment(page, options = {}) {
    const { planType = "plus", cdkCode = null, email = null } = options;

    console.log(`[ChatGPT] 启动 Stripe 信用卡支付流程 (plan: ${planType})`);

    // 委托 payment-retry.js 处理完整的支付重试逻辑
    // 包含：地区配置获取、免税地址选取、卡池分配、表单填写、重试换卡、账单记录
    const result = await executePaymentWithRetry(page, {
      planType,
      cdkCode,
      email,
      accessToken: this.token,
      checkout: options.checkout,
      accountId: options.accountId,
      stripeSessionId: options.stripeSessionId,
    });

    if (result.success) {
      console.log(`✅ [ChatGPT] 支付成功！`);
    } else {
      console.error(`❌ [ChatGPT] 支付失败: ${result.error}`);
    }

    return result;
  }

  /**
   * 根据 plan_type 和 currency 获取预估金额
   * 用于外部调用方查询参考价格
   * @param {string} planType - 'plus' | 'pro_5x' | 'pro_20x'
   * @param {string} currency - 币种代码
   * @returns {number} 预估金额
   */
  getPlanAmount(planType, currency) {
    // 基础美元定价
    const baseAmounts = {
      plus: 20.0,
      pro_5x: 100.0,
      pro_20x: 200.0,
    };
    const amount = baseAmounts[planType] || baseAmounts.plus;

    // 非 USD 币种的简单转换（实际金额由 Stripe 返回，这里仅用于记录参考）
    if (currency === "SGD") return Math.round(amount * 1.35 * 100) / 100;
    if (currency === "MYR") return Math.round(amount * 4.5 * 100) / 100;
    if (currency === "PHP") return Math.round(amount * 56 * 100) / 100;
    return amount;
  }
}

/**
 * 端到端 Stripe 信用卡支付入口函数
 *
 * 用户流程：CDK → GPT session token → 自动支付
 * 此函数封装完整流程：创建 Checkout Session → 导航到 Stripe 页面 → 执行支付（含重试换卡）
 *
 * @param {object} params
 * @param {import('playwright').Page} params.page - Playwright Page 实例
 * @param {string} params.accessToken - OpenAI Bearer Token（用于创建 checkout session）
 * @param {string} params.planType - 'plus' | 'pro_5x' | 'pro_20x'
 * @param {string} [params.cdkCode] - 关联的 CDK 码
 * @param {string} [params.email] - 关联的邮箱
 * @param {function} [params.onProgress] - 进度回调 (message: string) => void
 * @returns {Promise<{ success: boolean, error?: string, sessionId?: string }>}
 */
async function activateSubscription({
  page,
  accessToken,
  planType,
  cdkCode,
  email,
  onProgress,
}) {
  const notify = typeof onProgress === "function" ? onProgress : () => {};

  // Step 1: Resolve billing region and currency
  const region = await store.getPaymentRegion();
  const regionConfig = getRegionConfig(region);
  if (!regionConfig) {
    return { success: false, error: `不支持的支付地区: ${region}` };
  }
  const { currency } = regionConfig;
  const country = region;

  notify(`地区: ${region}, 币种: ${currency}, 套餐: ${planType}`);

  // Step 2: Create Checkout Session via OpenAI API
  notify("正在创建 Stripe Checkout Session...");
  const gpt = new ChatGPTService(page.context().request, accessToken);
  const checkout = await gpt.createCheckoutSession(planType, country, currency);

  if (!checkout.checkoutUrl) {
    return {
      success: false,
      error: "无法获取支付链接 (createCheckoutSession 失败)",
    };
  }

  // Step 3: Navigate to Stripe Checkout URL
  const checkoutUrl = checkout.checkoutUrl;
  notify("正在打开 Stripe Checkout 页面...");

  await page.goto(checkoutUrl, {
    waitUntil: "domcontentloaded",
    timeout: 90000,
  });
  await page
    .waitForLoadState("networkidle", { timeout: 30000 })
    .catch(() => {});

  notify("Checkout 页面已打开，开始信用卡支付...");

  // Step 4: Execute payment with card pool retry logic
  const result = await executePaymentWithRetry(page, {
    planType,
    cdkCode,
    email,
    accessToken,
    checkout,
    accountId: checkout.accountId,
    stripeSessionId: checkout.sessionId,
  });

  if (result.success) {
    notify("支付成功！");
    return { success: true, sessionId: checkout.sessionId };
  }

  return { success: false, error: result.error, sessionId: checkout.sessionId };
}

/**
 * 判断 Checkout 页面是否已正常加载（避免 body 里 incidental "404" 误报）
 */
async function assertCheckoutPageReady(page) {
  const {
    isCloudflareWallPage,
    isCheckoutPaymentReady,
  } = require("./human-verification");
  const currentUrl = page.url();
  const pageText = String(
    (await page.textContent("body", { timeout: 8000 }).catch(() => "")) || "",
  );
  const title = String((await page.title().catch(() => "")) || "");

  if (await isCloudflareWallPage(page)) {
    throw new Error("Checkout 页面仍被 Cloudflare 人机验证拦截");
  }

  if (await isCheckoutPaymentReady(page)) {
    return currentUrl;
  }

  const checkoutReady =
    /Configure your plan|Subscribe|Plus plan|Pro plan|Due today|Card number|Expiration date|Security code|Monthly subscription/i.test(
      pageText,
    );

  if (checkoutReady) {
    return currentUrl;
  }

  if (
    /Page not found|could not be found|Something went wrong|contact the merchant/i.test(
      pageText,
    )
  ) {
    throw new Error(`支付链接无效: ${currentUrl.slice(0, 120)}`);
  }

  if (/accounts\.google\.com|auth\.openai\.com/i.test(currentUrl)) {
    throw new Error(`Checkout 跳转到登录页: ${currentUrl.slice(0, 80)}`);
  }

  if (/^404(\s|$)/.test(title.trim())) {
    throw new Error(`支付链接无效 (404): ${currentUrl.slice(0, 120)}`);
  }

  throw new Error(
    `无法确认 Checkout 支付表单已加载: ${currentUrl.slice(0, 120)}`,
  );
}

/**
 * 通过 API 注入 billing_details 创建 Checkout，并打开 chatgpt.com/checkout
 */
async function openApiCheckout(
  page,
  {
    accessToken,
    planType,
    country,
    currency,
    planNameOverride,
    verifyPage = true,
  },
) {
  const { assertChatGptLoggedIn } = require("./session-auth");
  const token = String(accessToken || "").trim();
  if (!token) {
    throw new Error("缺少 AccessToken，无法调用 Checkout API");
  }

  const region = String(country || "PH").toUpperCase();
  const billingCurrency = String(
    currency || getRegionConfig(region)?.currency || "PHP",
  ).toUpperCase();
  console.log(
    `🧭 [步骤] 正在通过 API 创建 Checkout (country=${region}, currency=${billingCurrency}, plan=${planType})...`,
  );

  const gpt = new ChatGPTService(page.context().request, token);
  const checkout = await gpt.createCheckoutSession(
    planType,
    region,
    billingCurrency,
    planNameOverride,
    { page },
  );
  if (!checkout.checkoutUrl) {
    throw new Error(
      `API 创建 Checkout 失败: ${checkout.error || "未返回 data.url"}`,
    );
  }

  const url = checkout.checkoutUrl;
  console.log(`🔗 [步骤] 正在打开支付链接: ${url.slice(0, 120)}...`);

  if (!verifyPage || checkout.sessionId) {
    if (checkout.sessionId) {
      await page
        .goto(url, { waitUntil: "domcontentloaded", timeout: 90000 })
        .catch(() => {});
      console.log(
        `✅ [步骤] Checkout session 已创建，走协议支付: ${checkout.sessionId}`,
      );
    } else {
      console.log("✅ [步骤] Checkout Session 已创建（跳过页面打开验证）");
    }
    return { ...checkout, checkoutUrl: url };
  }

  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page
    .waitForLoadState("networkidle", { timeout: 30000 })
    .catch(() => {});
  await page.waitForTimeout(2000);

  const {
    hasVisibleLoginChrome,
    isCheckoutLoginGate,
    buildSessionNotLoggedInError,
  } = require("./auth-page-detect");
  if (
    (await isCheckoutLoginGate(page)) ||
    (await hasVisibleLoginChrome(page))
  ) {
    const title = await page.title().catch(() => "");
    console.error(
      `[Checkout] 打开后仍为未登录 UI url=${page.url().slice(0, 100)} title=${title}`,
    );
    throw new Error(buildSessionNotLoggedInError("Checkout 支付页"));
  }

  const {
    clearHumanVerification,
    buildCaptchaRequiredError,
  } = require("./human-verification");
  const captchaResult = await clearHumanVerification(page, {
    phase: "checkout-open",
    maxWaitMs: Number(process.env.CAPTCHA_CLEAR_TIMEOUT_MS || 120000),
    maxBypassRounds: 6,
    requireCheckoutReady: true,
    checkoutReadyWaitMs: Number(process.env.CHECKOUT_READY_WAIT_MS || 60000),
  });
  if (!captchaResult.cleared) {
    const err = captchaResult.sessionRequired
      ? captchaResult.message || buildSessionNotLoggedInError("Checkout 支付页")
      : captchaResult.checkoutNotReady
        ? "Checkout 支付表单未能加载，请检查网络或稍后重试"
        : buildCaptchaRequiredError();
    throw new Error(err);
  }

  const currentUrl = await assertCheckoutPageReady(page);

  await assertChatGptLoggedIn(page, "Checkout");
  console.log(`✅ [步骤] Checkout 页面已打开: ${currentUrl.slice(0, 100)}...`);
  return { ...checkout, checkoutUrl: currentUrl };
}

module.exports = ChatGPTService;
module.exports.ChatGPTService = ChatGPTService;
module.exports.activateSubscription = activateSubscription;
module.exports.openApiCheckout = openApiCheckout;
module.exports.createHostedCheckoutLink = createHostedCheckoutLink;
module.exports.buildCheckoutPayload = buildCheckoutPayload;
module.exports.buildCheckoutHeaders = buildCheckoutHeaders;
module.exports.extractAccountIdFromCheck = extractAccountIdFromCheck;
module.exports.describeCheckoutAccount = describeCheckoutAccount;
module.exports.pickCheckoutAccountRecord = pickCheckoutAccountRecord;
module.exports.extractCheckoutPlan = extractCheckoutPlan;
module.exports.resolveCheckoutModes = resolveCheckoutModes;
module.exports.summarizeCheckoutCookies = summarizeCheckoutCookies;
module.exports.buildCheckoutWarmupRequests = buildCheckoutWarmupRequests;
module.exports.formatApiErrorDetail = formatApiErrorDetail;
