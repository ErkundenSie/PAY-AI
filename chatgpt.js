"use strict";

const crypto = require("crypto");
const axios = require("axios");
const store = require("./mysql-store");
const { getRegionConfig } = require("./region-config");
const { executePaymentWithRetry } = require("./payment-retry");
const { extractProfileFromToken } = require("./session-auth");

const CHECKOUT_API_PATH = "/backend-api/payments/checkout";
const CHECKOUT_API_URL = `https://chatgpt.com${CHECKOUT_API_PATH}`;
const CHATGPT_HOME_URL = "https://chatgpt.com/";

function resolveProcessorEntity(country) {
  return String(country || "").toUpperCase() === "US"
    ? "openai_llc"
    : "openai_ie";
}

function normalizeGiftCreditAmount(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n) || n < 250) return 250;
  return Math.round(n / 250) * 250;
}

function extractGiftId(data) {
  if (!data || typeof data !== "object") return "";
  const direct = String(
    data.gift_id ||
      data.giftId ||
      data.purchased_gift_checkout_data?.gift_id ||
      data.gift?.id ||
      data.gift?.gift_id ||
      "",
  ).trim();
  if (direct && !/^(cs_|oaics_)/i.test(direct)) return direct;
  const match = JSON.stringify(data).match(
    /"gift_id"\s*:\s*"([a-f0-9]{16,})"/i,
  );
  return match ? match[1] : "";
}

function isGiftCreditsPurchaseUrl(url = "") {
  return /chatgpt\.com\/gifts\/credits(\?|$)/i.test(String(url || ""));
}

function pickExplicitGiftRedeemUrl(gift = {}) {
  const candidates = [
    gift.redeem_url,
    gift.share_url,
    gift.claim_url,
    gift.gift?.redeem_url,
    gift.gift?.share_url,
    gift.gift?.claim_url,
  ];
  for (const raw of candidates) {
    const url = String(raw || "").trim();
    if (
      /^https:\/\/chatgpt\.com\//i.test(url) &&
      !isGiftCreditsPurchaseUrl(url)
    ) {
      return url;
    }
  }
  const code = String(
    gift.redeem_code || gift.code || gift.claim_code || gift.gift?.code || "",
  ).trim();
  if (code) {
    return `https://chatgpt.com/gifts/redeem/${encodeURIComponent(code)}`;
  }
  return "";
}

function buildGiftCreditsRedeemUrl(gift = {}, giftId = "") {
  const explicit = pickExplicitGiftRedeemUrl(gift);
  if (explicit) return explicit;
  const id = String(giftId || extractGiftId(gift) || "").trim();
  if (id) return `https://chatgpt.com/gifts/${encodeURIComponent(id)}`;
  return "";
}

function buildGiftCreditsPurchaseUrl(quantity, giftId = "") {
  const url = new URL("https://chatgpt.com/gifts/credits");
  if (giftId) url.searchParams.set("gift_id", String(giftId));
  if (quantity) url.searchParams.set("credits", String(quantity));
  return url.toString();
}

function buildCheckoutPayload(planName, country, currency, options = {}) {
  const uiMode =
    String(options.uiMode || process.env.CHECKOUT_UI_MODE || "custom").trim() ||
    "custom";
  const creditQuantity = Number(options.creditQuantity || 0);
  const giftId = String(options.giftId || "").trim();
  const looksLikeCredits =
    Boolean(options.credits) ||
    creditQuantity > 0 ||
    /usage_based|platformbusiness|chatgptbusiness/i.test(
      String(planName || ""),
    );
  const isGiftCredits =
    Boolean(giftId) || (looksLikeCredits && options.giftCredits !== false);
  const payload = isGiftCredits
    ? (() => {
        const quantity = normalizeGiftCreditAmount(creditQuantity);
        const data = {
          entry_point: "gift_credits_purchase",
          checkout_ui_mode: uiMode,
          billing_details: { country, currency },
          credit_purchase_data: {
            quantity,
            unit: "credit",
          },
        };
        if (giftId) {
          data.purchased_gift_checkout_data = { gift_id: giftId };
          data.cancel_url = buildGiftCreditsPurchaseUrl(quantity, giftId);
          data.cancel_url +=
            (data.cancel_url.includes("?") ? "&" : "?") + "checkout=cancelled";
        }
        return data;
      })()
    : looksLikeCredits
      ? {
          entry_point: "codex_team_start",
          plan_name: String(planName || "").trim(),
          checkout_ui_mode: uiMode,
          billing_details: { country, currency },
          usage_based_workspace_credit_purchase_data: {
            quantity: normalizeGiftCreditAmount(creditQuantity),
            unit: "credit",
            workspace_name:
              String(options.workspaceName || "Codex Space").trim() ||
              "Codex Space",
            plan_type: "team",
            auto_top_up_enabled: true,
          },
        }
      : {
          entry_point: "all_plans_pricing_modal",
          plan_name: planName,
          checkout_ui_mode: uiMode,
          billing_details: { country, currency },
        };
  const accountId = String(options.accountId || "").trim();
  if (accountId) {
    payload.account_id = accountId;
    payload.openai_account_id = accountId;
    if (payload.credit_purchase_data) {
      payload.credit_purchase_data.account_id = accountId;
    }
  }
  return payload;
}

function isGiftCreditsCheckoutPayload(payload) {
  return Boolean(
    payload &&
      (payload.entry_point === "gift_credits_purchase" ||
        payload.purchased_gift_checkout_data),
  );
}

function isCreditsCheckoutPayload(payload) {
  return Boolean(
    isGiftCreditsCheckoutPayload(payload) ||
      (payload &&
        payload.usage_based_workspace_credit_purchase_data &&
        typeof payload.usage_based_workspace_credit_purchase_data ===
          "object"),
  );
}

function buildCodexCreditPurchaseUrl(creditQuantity, options = {}) {
  const quantity = Number(creditQuantity || 0);
  if (!Number.isSafeInteger(quantity) || quantity < 250 || quantity % 250) {
    throw new Error("充值点数至少 250，且需为 250 的倍数");
  }
  const url = new URL("https://chatgpt.com/codex/purchase/credits");
  url.searchParams.set("quantity", String(quantity));
  url.searchParams.set(
    "source",
    String(options.source || "codex-embedded-checkout"),
  );
  if (options.autoTopUpEnabled === false) {
    url.searchParams.set("auto_top_up_enabled", "false");
  }
  return url.toString();
}

function isCodexCreditPurchaseUrl(rawUrl) {
  try {
    const url = new URL(String(rawUrl || ""));
    return (
      url.origin === "https://chatgpt.com" &&
      url.pathname === "/codex/purchase/credits"
    );
  } catch (_) {
    return false;
  }
}

function pickCookieValue(cookies, name) {
  const hit = (Array.isArray(cookies) ? cookies : []).find(
    (item) => String(item?.name || "").trim() === name,
  );
  return String(hit?.value || "").trim();
}

async function snapshotChatGptCookies(page) {
  try {
    const context =
      page && typeof page.context === "function" ? page.context() : null;
    if (!context || typeof context.cookies !== "function") return [];
    return await context.cookies(CHATGPT_HOME_URL);
  } catch (_) {
    return [];
  }
}

async function restoreChatGptCookies(page, cookies) {
  if (!page || !Array.isArray(cookies) || !cookies.length) return;
  try {
    const context = page.context();
    if (!context || typeof context.addCookies !== "function") return;
    await context.addCookies(cookies);
  } catch (_) {
    /* ignore */
  }
}

function extractHomepageMetadata(html) {
  const text = String(html || "");
  const pick = (pattern) => {
    const match = text.match(pattern);
    return match ? String(match[1] || "").trim() : "";
  };
  return {
    clientVersion: pick(/data-build="([^"]+)"/),
    clientBuild: pick(/data-seq="([^"]+)"/),
    attestation: pick(/"webDeploymentAttestation":"([^"]+)"/),
  };
}

function parseSentinelObject(raw) {
  const text = String(raw || "").trim();
  if (!text) return null;
  try {
    const data = JSON.parse(text);
    return data && typeof data === "object" ? data : null;
  } catch (_) {
    return null;
  }
}

function fnv1a32Hex(input) {
  let hash = 2166136261 >>> 0;
  const text = String(input || "");
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 2246822507) >>> 0;
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 3266489909) >>> 0;
  hash ^= hash >>> 16;
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function encodeSentinelConfig(config) {
  return Buffer.from(JSON.stringify(config), "utf8").toString("base64");
}

function buildDefaultSentinelFingerprint(overrides = {}) {
  return [
    2730,
    String(new Date()),
    4395630592,
    0,
    overrides.userAgent ||
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36",
    "https://chatgpt.com/cdn-cgi/challenge-platform/scripts/jsd/api.js?onload=jsdOnload",
    overrides.clientVersion || null,
    "zh-CN",
    "zh-CN",
    0,
    "serial\u2212[object Serial]",
    "location",
    "closed",
    1000 + Math.random() * 49000,
    overrides.sid || crypto.randomUUID(),
    "",
    8,
    Date.now() + Math.random(),
    0,
    0,
    0,
    0,
    1,
    0,
    0,
  ];
}

function cloneSentinelFingerprint(fingerprint, overrides = {}) {
  return Array.isArray(fingerprint) && fingerprint.length >= 18
    ? fingerprint.slice()
    : buildDefaultSentinelFingerprint(overrides);
}

function generateSentinelRequirementsToken(fingerprint = null) {
  const config = cloneSentinelFingerprint(fingerprint);
  config[3] = 1;
  config[9] = Math.round(5 + Math.random() * 45);
  return `gAAAAAC${encodeSentinelConfig(config)}`;
}

function generateSentinelPowToken(seed, difficulty = "0", fingerprint = null) {
  const config = cloneSentinelFingerprint(fingerprint);
  const start = Date.now();
  const target = String(difficulty || "0");
  for (let i = 0; i < 500000; i += 1) {
    config[3] = i;
    config[9] = Math.round(Date.now() - start);
    const data = encodeSentinelConfig(config);
    const hex = fnv1a32Hex(String(seed) + data);
    if (hex.slice(0, target.length) <= target) {
      return `gAAAAAB${data}`;
    }
  }
  return `gAAAAAB${encodeSentinelConfig(config)}`;
}

function extractChallengeToken(challenge) {
  if (!challenge || typeof challenge !== "object") return "";
  return String(
    challenge.token ||
      challenge.c ||
      challenge.challenge ||
      challenge?.proofofwork?.token ||
      "",
  ).trim();
}

function pickLongerSentinelField(left, right) {
  const a = String(left || "").trim();
  const b = String(right || "").trim();
  return b.length > a.length ? b : a;
}

function summarizeCheckoutSentinel(raw) {
  const obj = parseSentinelObject(raw) || {};
  return {
    p: String(obj.p || "").length,
    t: String(obj.t || "").length,
    c: String(obj.c || "").length,
    id: String(obj.id || "").length,
    flow: String(obj.flow || ""),
    total: String(raw || "").length,
  };
}

function isUsableCheckoutSentinel(raw) {
  const obj = parseSentinelObject(raw);
  if (!obj) return false;
  return Boolean(
    String(obj.p || "").startsWith("gAAAAA") &&
    String(obj.c || "").trim() &&
    String(obj.id || "").trim() &&
    String(obj.flow || "").trim(),
  );
}

function pickSentinelFlow(left, right, fallback = "chatgpt_checkout") {
  const a = String(left || "").trim();
  const b = String(right || "").trim();
  if (b && b !== "chatgpt_checkout") return b;
  if (a && a !== "chatgpt_checkout") return a;
  return a || b || fallback;
}

function mergeCheckoutSentinelToken(base, extra) {
  const a = parseSentinelObject(base) || {};
  const b = parseSentinelObject(extra) || {};
  const token = {
    p: pickLongerSentinelField(a.p, b.p),
    t: pickLongerSentinelField(a.t, b.t),
    c: pickLongerSentinelField(a.c, b.c),
    id: String(a.id || b.id || "").trim(),
    flow: pickSentinelFlow(a.flow, b.flow),
  };
  if (!token.p || !token.id || !token.c) {
    return pickLongerSentinelField(base, extra);
  }
  return JSON.stringify(token);
}

function buildCheckoutSentinelReqBody(
  deviceId = "",
  fingerprint = null,
  flow = "chatgpt_checkout",
) {
  const id = String(deviceId || "").trim() || crypto.randomUUID();
  return {
    p: generateSentinelRequirementsToken(fingerprint),
    id,
    flow: String(flow || "chatgpt_checkout").trim() || "chatgpt_checkout",
  };
}

function assembleCheckoutSentinelToken(
  reqBody,
  challenge,
  captured = "",
  fingerprint = null,
) {
  const capturedObj = parseSentinelObject(captured) || {};
  const challengeObj =
    challenge && typeof challenge === "object" ? challenge : {};
  const pow = challengeObj.proofofwork || {};
  const deviceId = String(capturedObj.id || reqBody?.id || "").trim();
  const proof =
    pow.required && pow.seed
      ? generateSentinelPowToken(pow.seed, pow.difficulty || "0", fingerprint)
      : pickLongerSentinelField(capturedObj.p, reqBody?.p);
  const token = {
    p: proof,
    t: pickLongerSentinelField(
      capturedObj.t,
      challengeObj.t || challengeObj.turnstile?.token || "",
    ),
    c: pickLongerSentinelField(
      capturedObj.c,
      extractChallengeToken(challengeObj),
    ),
    id: deviceId,
    flow: pickSentinelFlow(capturedObj.flow, reqBody?.flow),
  };
  if (!token.p || !token.id || !token.c) {
    return String(captured || "").trim();
  }
  return JSON.stringify(token);
}

function buildPhpCheckoutHeaders({
  token,
  accountId = "",
  deviceId = "",
  clientVersion = "",
  clientBuild = "",
  attestation = "",
  sentinel = "",
  extra = {},
} = {}) {
  const headers = {
    accept: "*/*",
    authorization: `Bearer ${String(token || "").trim()}`,
    "content-type": "application/json",
    origin: "https://chatgpt.com",
    referer: "https://chatgpt.com/",
    "oai-language": "zh-CN",
    "oai-session-id": crypto.randomUUID(),
    "oai-telemetry": "[1,null]",
    "x-openai-target-path": CHECKOUT_API_PATH,
    "x-openai-target-route": CHECKOUT_API_PATH,
    ...extra,
  };
  const aid = String(accountId || "").trim();
  if (aid) {
    headers["chatgpt-account-id"] = aid;
    headers["openai-account-id"] = aid;
  }
  if (deviceId) headers["oai-device-id"] = deviceId;
  if (clientVersion) headers["oai-client-version"] = clientVersion;
  if (clientBuild) headers["oai-client-build-number"] = clientBuild;
  if (attestation) headers["oai-web-deployment-attestation"] = attestation;
  if (sentinel) headers["openai-sentinel-token"] = sentinel;
  return headers;
}

function shouldFallbackFromPhpCheckout(parsed) {
  if (!parsed || parsed.ok) return false;
  const detail = String(parsed.error || "");
  if (
    /already paid|already_subscribed|not_eligible|Offer not found|permission|usage_based_workspace_credit_purchase_data is not enabled|credit_purchase_disabled/i.test(
      detail,
    )
  ) {
    return false;
  }
  return true;
}

function isTransientProxyNetworkError(err) {
  const text = String((err && err.message) || err || "");
  return /Failed to fetch|ERR_TUNNEL_CONNECTION_FAILED|ERR_PROXY_CONNECTION_FAILED|ERR_CONNECTION_CLOSED|ERR_CONNECTION_RESET|ERR_CONNECTION_TIMED_OUT|ERR_TIMED_OUT|ERR_EMPTY_RESPONSE|ERR_SOCKS|ERR_SSL_PROTOCOL_ERROR|net::ERR_|HTTP 599|aborted|ECONNRESET|ETIMEDOUT|tunnel|sentinel token missing/i.test(
    text,
  );
}

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function resolveCheckoutModes(plan, options = {}) {
  const preferredMode =
    String(process.env.CHECKOUT_UI_MODE || "custom").trim() || "custom";
  const credits = Boolean(
    options.credits ||
      Number(options.creditQuantity || 0) > 0 ||
      /usage_based|platformbusiness|chatgptbusiness/i.test(String(plan || "")),
  );
  if (credits) {
    const modes = [preferredMode];
    if (preferredMode !== "hosted") modes.push("hosted");
    return modes;
  }
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
  const {
    openPersonalWorkspace,
    hasVisibleLoginChrome,
  } = require("./auth-page-detect");
  const currentUrl = String(page.url() || "");
  if (await hasVisibleLoginChrome(page).catch(() => false)) {
    throw new Error("Session 未生效：当前是登录页，无法打开套餐弹窗");
  }
  if (
    !currentUrl.startsWith("https://chatgpt.com") ||
    /about:blank|^chrome:\/\//i.test(currentUrl)
  ) {
    let lastErr;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        await page.goto("https://chatgpt.com/#pricing", {
          waitUntil: "domcontentloaded",
          timeout: 45000,
        });
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        if (!isTransientProxyNetworkError(err) || attempt >= 3) {
          throw err;
        }
        console.warn(
          `[ChatGPT] 打开主页代理网络失败，重试 ${attempt}/3: ${String(err.message || err).slice(0, 120)}`,
        );
        await sleepMs(1500 * attempt);
      }
    }
    if (lastErr) throw lastErr;
  }
  await openPersonalWorkspace(page);
}

function captureSentinelFromHeaders(headers) {
  const entries = headers && typeof headers === "object" ? headers : {};
  for (const [key, value] of Object.entries(entries)) {
    if (/sentinel/i.test(String(key || "")) && String(value || "").trim()) {
      return String(value).trim();
    }
  }
  return "";
}

function readRequestPostData(request) {
  try {
    if (!request || typeof request.postData !== "function") return "";
    const value = request.postData();
    return String(value || "");
  } catch (_) {
    return "";
  }
}

function captureSentinelFromPayload(text) {
  const raw = String(text || "").trim();
  if (!raw) return "";
  if (isUsableCheckoutSentinel(raw)) return raw;
  try {
    const data = JSON.parse(raw);
    const token = String(
      data.sentinel_token || data.sentinelToken || data.value || "",
    ).trim();
    return isUsableCheckoutSentinel(token) ? token : "";
  } catch (_) {
    return "";
  }
}

function rememberSentinelToken(target, token) {
  const value = String(token || "").trim();
  if (!target || value.length < 200) return;
  const current = String(target.__kcSentinelToken || "");
  if (value.length >= current.length) {
    target.__kcSentinelToken = value;
  }
}

async function installSentinelCapture(page) {
  if (!page) return;
  const context = typeof page.context === "function" ? page.context() : null;

  if (context && !context.__kcSentinelInitScript) {
    context.__kcSentinelInitScript = true;
    await context
      .addInitScript(() => {
        if (window.__kcSentinelHook) return;
        window.__kcSentinelHook = true;
        window.__kcSentinelToken = "";
        const pick = (headers) => {
          try {
            if (!headers) return "";
            if (typeof headers.get === "function") {
              return (
                headers.get("openai-sentinel-token") ||
                headers.get("OpenAI-Sentinel-Token") ||
                ""
              );
            }
            for (const [key, value] of Object.entries(headers)) {
              if (/sentinel/i.test(String(key || "")) && value) {
                return String(value);
              }
            }
          } catch (_) {
            /* ignore */
          }
          return "";
        };
        const save = (headers) => {
          const token = pick(headers);
          if (token) window.__kcSentinelToken = token;
        };
        const origFetch = window.fetch.bind(window);
        window.fetch = (input, init = {}) => {
          try {
            save(init && init.headers);
            if (input && typeof input === "object") save(input.headers);
          } catch (_) {
            /* ignore */
          }
          return origFetch(input, init);
        };
        const origSet = XMLHttpRequest.prototype.setRequestHeader;
        XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
          try {
            if (/sentinel/i.test(String(name || "")) && value) {
              window.__kcSentinelToken = String(value);
            }
          } catch (_) {
            /* ignore */
          }
          return origSet.apply(this, arguments);
        };
      })
      .catch(() => {});
  }

  if (context && !context.__kcSentinelInstalled) {
    context.__kcSentinelInstalled = true;
    context.__kcSentinelToken = String(context.__kcSentinelToken || "");
    context.on("request", (req) => {
      try {
        const token = captureSentinelFromHeaders(req.headers() || {});
        rememberSentinelToken(context, token);
        try {
          const frame = req.frame();
          const owner =
            frame && typeof frame.page === "function" ? frame.page() : null;
          rememberSentinelToken(owner, token);
        } catch (_) {
          /* ignore */
        }
      } catch (_) {
        /* ignore */
      }
    });
    context.on("response", (res) => {
      try {
        const url = String(res.url() || "");
        if (!/sentinel/i.test(url)) return;
        res
          .text()
          .then((text) => {
            rememberSentinelToken(context, captureSentinelFromPayload(text));
          })
          .catch(() => {});
      } catch (_) {
        /* ignore */
      }
    });
  }

  if (!page.__kcSentinelInstalled) {
    page.__kcSentinelInstalled = true;
    page.__kcSentinelToken = String(page.__kcSentinelToken || "");
    page.on("request", (req) => {
      try {
        rememberSentinelToken(
          page,
          captureSentinelFromHeaders(req.headers() || {}),
        );
      } catch (_) {
        /* ignore */
      }
    });
  }
}

async function readCapturedSentinel(page) {
  if (!page) return "";
  const fromPage = String(page.__kcSentinelToken || "").trim();
  if (fromPage.length > 200) return fromPage;
  try {
    const context = page.context();
    const fromCtx = String(context.__kcSentinelToken || "").trim();
    if (fromCtx.length > 200) return fromCtx;
  } catch (_) {
    /* ignore */
  }
  if (typeof page.evaluate !== "function") return fromPage;
  const fromWindow = await page
    .evaluate(() => String(window.__kcSentinelToken || "").trim())
    .catch(() => "");
  if (fromWindow.length > 200) {
    rememberSentinelToken(page, fromWindow);
    return fromWindow;
  }
  return fromPage || fromWindow;
}

async function clearCapturedSentinel(page) {
  if (!page) return;
  page.__kcSentinelToken = "";
  try {
    page.context().__kcSentinelToken = "";
  } catch (_) {
    /* ignore */
  }
  if (typeof page.evaluate === "function") {
    await page
      .evaluate(() => {
        window.__kcSentinelToken = "";
      })
      .catch(() => {});
  }
}

async function waitForSentinelToken(page, options = {}) {
  const timeoutMs = Number(options.timeoutMs || 22000);
  const minBytes = Number(options.minBytes || 4000);
  await installSentinelCapture(page);
  if (options.fresh) {
    await clearCapturedSentinel(page);
    console.log("[ChatGPT] 正在等待页面产出 openai-sentinel-token...");
    await page
      .reload({ waitUntil: "domcontentloaded", timeout: 60000 })
      .catch(() => {});
    await page
      .waitForLoadState("networkidle", { timeout: 15000 })
      .catch(() => {});
  }

  const started = Date.now();
  let token = await readCapturedSentinel(page);
  const deadline = started + timeoutMs;
  while (Date.now() < deadline && token.length < minBytes) {
    await page.waitForTimeout(400);
    token = await readCapturedSentinel(page);
  }
  console.log(
    `[ChatGPT] Sentinel 等待 ${Date.now() - started}ms, bytes=${token.length}`,
  );
  return token;
}

function isCheckoutBlocked(detail = "") {
  return /unusual activity|forbidden|sentinel|blocked|403/i.test(
    String(detail || ""),
  );
}

function isGoCheckoutPayload(data, requestBody = "") {
  const blob =
    `${JSON.stringify(data || {})} ${String(requestBody || "")}`.toLowerCase();
  return /chatgptgo|plan_type=go|\bplan_type["']?\s*[:=]\s*["']go["']/.test(
    blob,
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

async function probePageSentinelEndpoint(page, path, body = {}) {
  if (!page || typeof page.evaluate !== "function") {
    return null;
  }
  return page
    .evaluate(
      async ({ path, body }) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 12000);
        try {
          const response = await fetch(path, {
            method: "POST",
            credentials: "include",
            headers: {
              "content-type": "application/json",
              accept: "application/json",
            },
            body: JSON.stringify(body || {}),
            signal: controller.signal,
          });
          const text = await response.text();
          let data = {};
          try {
            data = text ? JSON.parse(text) : {};
          } catch (_) {
            data = {};
          }
          const headerToken =
            response.headers.get("openai-sentinel-token") ||
            response.headers.get("OpenAI-Sentinel-Token") ||
            "";
          return {
            status: response.status,
            data,
            headerToken,
            bytes: text.length,
          };
        } catch (err) {
          return {
            status: 0,
            data: {},
            headerToken: "",
            error: String((err && err.message) || err),
          };
        } finally {
          clearTimeout(timer);
        }
      },
      { path, body },
    )
    .catch(() => null);
}

function buildCheckoutWarmupRequests({ country = "PH" } = {}) {
  const region = String(country || "PH").toUpperCase();
  return [
    {
      name: "countries",
      path: "/backend-api/checkout_pricing_config/countries",
    },
    {
      name: region,
      path: `/backend-api/checkout_pricing_config/configs/${region}`,
    },
  ];
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
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 12000);
          const response = await fetch(item.path, {
            method: "GET",
            credentials: "include",
            headers,
            signal: controller.signal,
          });
          clearTimeout(timer);
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
  await installSentinelCapture(page);
  console.log("[ChatGPT] Checkout 预热开始");
  const requests = buildCheckoutWarmupRequests({ country });
  const requestApi = page.context?.().request;
  let results = [];
  if (requestApi && typeof requestApi.get === "function") {
    for (const item of requests) {
      try {
        const response = await requestApi.get(
          `https://chatgpt.com${item.path}`,
          {
            timeout: 12000,
            headers: {
              accept: "application/json",
              authorization: `Bearer ${accessToken}`,
            },
          },
        );
        results.push({ name: item.name, status: response.status() });
      } catch (err) {
        results.push({
          name: item.name,
          status: 0,
          error: String((err && err.message) || err),
        });
      }
    }
  } else {
    const currentUrl = String(page.url() || "");
    if (!currentUrl.startsWith("https://chatgpt.com")) {
      await page.goto(CHATGPT_HOME_URL, {
        waitUntil: "domcontentloaded",
        timeout: 60000,
      });
    }
    results = await fetchSameOriginGets(page, {
      token: accessToken,
      accountId: "",
      requests,
    });
  }
  for (const item of results) {
    console.log(
      `[ChatGPT] 预热 ${item.name}: HTTP ${item.status}${item.error ? "/err" : ""}`,
    );
  }

  const cookies = summarizeCheckoutCookies(
    await page.context().cookies(CHATGPT_HOME_URL),
  );
  const accountId = String(
    options.accountId || extractProfileFromToken(accessToken).accountId || "",
  ).trim();

  return {
    accountId,
    plan: "",
    cookies,
    accountKind: "unknown",
    checkStatus: 0,
    modal: "skip",
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
    const explicitId = String(
      data.checkout_session_id || data.session_id || "",
    ).trim();
    const oaicss =
      (/^oaics_/i.test(explicitId) ? explicitId : "") ||
      jsonText.match(/oaics_[A-Za-z0-9]+/)?.[0] ||
      "";
    const sessionId =
      oaicss ||
      explicitId ||
      jsonText.match(/cs_(?:live|test)_[A-Za-z0-9]+/)?.[0] ||
      null;

    const apiUrl = String(
      data.url || data.stripe_hosted_url || data.checkout_url || "",
    ).trim();
    if (apiUrl.startsWith("http") && !oaicss) {
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

  async collectPhpCheckoutContext(page, accountId = "") {
    const cookies = await snapshotChatGptCookies(page);
    const deviceId = pickCookieValue(cookies, "oai-did");
    let html = "";
    if (
      page &&
      typeof page.content === "function" &&
      String(page.url() || "").startsWith("https://chatgpt.com")
    ) {
      html = await page.content().catch(() => "");
    }
    const meta = extractHomepageMetadata(html);
    return {
      accountId: String(accountId || "").trim(),
      deviceId,
      clientVersion: meta.clientVersion,
      clientBuild: meta.clientBuild,
      attestation: meta.attestation,
      cookieCount: Array.isArray(cookies) ? cookies.length : 0,
    };
  }

  async harvestPhpSentinel(page, options = {}) {
    await installSentinelCapture(page);
    const flow =
      String(
        options.flow ||
          (isGiftCreditsCheckoutPayload(options.payload)
            ? "chatgpt_gift_credit_purchase"
            : "chatgpt_checkout"),
      ).trim() || "chatgpt_checkout";
    let token = String(options.sentinel || "").trim();
    if (!isUsableCheckoutSentinel(token)) {
      const captured = await readCapturedSentinel(page);
      token = mergeCheckoutSentinelToken(token, captured);
    }
    const existing = parseSentinelObject(token);
    if (
      isUsableCheckoutSentinel(token) &&
      existing?.t &&
      String(existing.flow || "") === flow
    ) {
      return token;
    }

    const onChatGpt =
      page &&
      typeof page.url === "function" &&
      String(page.url() || "").startsWith("https://chatgpt.com");
    if (!onChatGpt && page && typeof page.goto === "function") {
      const startUrl = isGiftCreditsCheckoutPayload(options.payload)
        ? "https://chatgpt.com/gifts/credits"
        : "https://chatgpt.com/#pricing";
      await page
        .goto(startUrl, {
          waitUntil: "domcontentloaded",
          timeout: 20000,
        })
        .catch(() => {});
    }

    const stillOnChatGpt =
      page &&
      typeof page.url === "function" &&
      String(page.url() || "").startsWith("https://chatgpt.com");
    if (!stillOnChatGpt) {
      return token;
    }

    if (
      isCreditsCheckoutPayload(options.payload) &&
      !isGiftCreditsCheckoutPayload(options.payload)
    ) {
      const creditsProbe = await probePageSentinelEndpoint(
        page,
        "/backend-api/sentinel/chat-requirements",
        {},
      );
      if (creditsProbe?.headerToken) {
        rememberSentinelToken(page, creditsProbe.headerToken);
      }
      const probedToken = captureSentinelFromPayload(
        JSON.stringify(creditsProbe?.data || {}),
      );
      token = mergeCheckoutSentinelToken(token, probedToken);
      token = mergeCheckoutSentinelToken(token, await readCapturedSentinel(page));
      console.log(
        `[ChatGPT] sentinel/chat-requirements HTTP ${creditsProbe?.status || 0}, body=${creditsProbe?.bytes || 0}B${creditsProbe?.error ? `, err=${creditsProbe.error}` : ""}`,
      );
      if (isUsableCheckoutSentinel(token) && parseSentinelObject(token)?.t) {
        return token;
      }
    }

    const cookies = await snapshotChatGptCookies(page);
    const deviceId = pickCookieValue(cookies, "oai-did");
    const fingerprint = await page
      .evaluate(() => {
        const screenSum =
          Number(window.screen?.width || 0) +
          Number(window.screen?.height || 0);
        return [
          screenSum || 2730,
          String(new Date()),
          Number(performance.memory?.jsHeapSizeLimit || 4395630592),
          0,
          navigator.userAgent || "",
          "https://chatgpt.com/cdn-cgi/challenge-platform/scripts/jsd/api.js?onload=jsdOnload",
          document.documentElement?.getAttribute("data-build") || null,
          navigator.language || "zh-CN",
          Array.isArray(navigator.languages)
            ? navigator.languages.join(",")
            : navigator.language || "zh-CN",
          0,
          "serial\u2212[object Serial]",
          "location",
          "closed",
          Number(performance.now() || 0),
          crypto.randomUUID(),
          "",
          Number(navigator.hardwareConcurrency || 8),
          Number(performance.timeOrigin || Date.now()),
          Number("ai" in window),
          Number("answers" in window),
          Number("cache" in window),
          Number("data" in window),
          Number("required" in window),
          Number("match" in window),
          Number("stringify" in window),
        ];
      })
      .catch(() => buildDefaultSentinelFingerprint({ sid: deviceId }));
    const reqBody = buildCheckoutSentinelReqBody(deviceId, fingerprint, flow);
    let challenge = null;
    let probe = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      probe = await probePageSentinelEndpoint(
        page,
        "/backend-api/sentinel/req",
        reqBody,
      );
      if (probe?.status > 0 && !probe?.error) {
        break;
      }
      if (attempt < 3) {
        console.warn(
          `[ChatGPT] sentinel/req 网络失败，重试 ${attempt}/3: HTTP ${probe?.status || 0}${probe?.error ? ` ${probe.error}` : ""}`,
        );
        await sleepMs(1500 * attempt);
      }
    }

    if (probe?.headerToken) {
      rememberSentinelToken(page, probe.headerToken);
    }
    if (probe?.data && typeof probe.data === "object") {
      challenge = probe.data;
    }
    console.log(
      `[ChatGPT] sentinel/req flow=${flow} HTTP ${probe?.status || 0}, body=${probe?.bytes || 0}B${probe?.error ? `, err=${probe.error}` : ""}`,
    );

    const assembled = assembleCheckoutSentinelToken(
      reqBody,
      challenge,
      token,
      fingerprint,
    );
    token = mergeCheckoutSentinelToken(token, assembled);
    rememberSentinelToken(page, token);
    const sizes = summarizeCheckoutSentinel(token);
    console.log(
      `[ChatGPT] Sentinel 拼装 p=${sizes.p} t=${sizes.t} c=${sizes.c} total=${sizes.total}`,
    );
    if (!isUsableCheckoutSentinel(token)) {
      const waited = await waitForSentinelToken(page, {
        timeoutMs: Number(options.timeoutMs || 1800),
        minBytes: Math.max(token.length + 200, 4000),
        fresh: false,
      });
      token = mergeCheckoutSentinelToken(token, waited);
    }
    return token;
  }

  async postPhpProtocolCheckout(page, payload, options = {}) {
    const started = Date.now();
    const accountId = String(
      options.accountId || payload?.account_id || "",
    ).trim();
    const savedCookies = await snapshotChatGptCookies(page);
    const php = await this.collectPhpCheckoutContext(page, accountId);
    const sentinel = await this.harvestPhpSentinel(page, {
      ...options,
      payload,
    });
    await restoreChatGptCookies(page, savedCookies);
    if (!isUsableCheckoutSentinel(sentinel)) {
      const sizes = summarizeCheckoutSentinel(sentinel);
      console.warn(
        `[ChatGPT] PHP 协议提链缺 Sentinel (p=${sizes.p} t=${sizes.t} c=${sizes.c} total=${sizes.total})，跳过协议 POST`,
      );
      return {
        ok: false,
        status: 0,
        data: {},
        error: "sentinel token missing",
      };
    }
    const headers = buildPhpCheckoutHeaders({
      token: this.token,
      accountId: php.accountId,
      deviceId: php.deviceId,
      clientVersion: php.clientVersion,
      clientBuild: php.clientBuild,
      attestation: php.attestation,
      sentinel,
    });
    console.log(
      `[ChatGPT] PHP 协议提链: cookies=${php.cookieCount}, did=${php.deviceId ? "yes" : "no"}, Sentinel=${JSON.stringify(summarizeCheckoutSentinel(sentinel))}`,
    );

    let parsed;
    if (page && typeof page.evaluate === "function") {
      const officialPayload = {
        entry_point: payload.entry_point,
        billing_details: payload.billing_details,
        checkout_ui_mode: payload.checkout_ui_mode || "custom",
      };
      if (payload.plan_name) {
        officialPayload.plan_name = payload.plan_name;
      }
      if (payload.usage_based_workspace_credit_purchase_data) {
        officialPayload.usage_based_workspace_credit_purchase_data =
          payload.usage_based_workspace_credit_purchase_data;
      }
      if (payload.credit_purchase_data) {
        officialPayload.credit_purchase_data = payload.credit_purchase_data;
      }
      if (payload.purchased_gift_checkout_data) {
        officialPayload.purchased_gift_checkout_data =
          payload.purchased_gift_checkout_data;
      }
      if (payload.cancel_url) {
        officialPayload.cancel_url = payload.cancel_url;
      }
      const result = await page.evaluate(
        async ({ path, payload, headers }) => {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 20000);
          try {
            const response = await fetch(path, {
              method: "POST",
              credentials: "include",
              headers,
              body: JSON.stringify(payload),
              signal: controller.signal,
            });
            const bodyText = await response.text();
            return { status: response.status, bodyText };
          } catch (err) {
            return {
              status: 0,
              bodyText: "",
              error: String((err && err.message) || err),
            };
          } finally {
            clearTimeout(timer);
          }
        },
        {
          path: CHECKOUT_API_PATH,
          payload: officialPayload,
          headers,
        },
      );
      parsed = result.error
        ? { ok: false, status: 0, data: {}, error: result.error }
        : parseCheckoutApiBody(result.status, result.bodyText);
    } else if (this.request && typeof this.request.post === "function") {
      const response = await this.request.post(CHECKOUT_API_URL, {
        headers,
        data: payload,
        timeout: 20000,
      });
      const bodyText = await response.text().catch(() => "");
      parsed = parseCheckoutApiBody(response.status(), bodyText);
    } else {
      parsed = { ok: false, status: 0, data: {}, error: "missing request api" };
    }

    if (!parsed.ok) {
      await restoreChatGptCookies(page, savedCookies);
    }
    console.log(
      `[ChatGPT] PHP 协议提链完成: HTTP ${parsed.status}, ${Date.now() - started}ms${parsed.ok ? "" : `, err=${String(parsed.error || "").slice(0, 80)}`}`,
    );
    return parsed;
  }

  async postCheckoutViaPageFetch(page, payload, options = {}) {
    await installSentinelCapture(page);
    let sentinel = String(options.sentinel || "").trim();
    if (sentinel.length < 4000) {
      sentinel = await waitForSentinelToken(page, {
        timeoutMs: Number(options.waitMs || 8000),
        minBytes: 4000,
      });
    }
    if (sentinel.length < 4000 && options.probe !== false) {
      await page
        .evaluate(async () => {
          try {
            await fetch("/backend-api/sentinel/chat-requirements", {
              method: "POST",
              credentials: "include",
              headers: { "content-type": "application/json" },
              body: "{}",
            });
          } catch (_) {
            /* ignore */
          }
        })
        .catch(() => {});
      sentinel = await waitForSentinelToken(page, {
        timeoutMs: 6000,
        minBytes: 4000,
      });
    }

    const result = await page.evaluate(
      async ({ path, payload, token, sentinel }) => {
        const liveSentinel = String(
          window.__kcSentinelToken || sentinel || "",
        ).trim();
        const headers = {
          accept: "application/json",
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        };
        if (liveSentinel) {
          headers["openai-sentinel-token"] = liveSentinel;
        }
        if (payload.account_id) {
          headers["chatgpt-account-id"] = payload.account_id;
          headers["openai-account-id"] = payload.account_id;
        }
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 20000);
        try {
          const response = await fetch(path, {
            method: "POST",
            credentials: "include",
            headers,
            body: JSON.stringify(payload),
            signal: controller.signal,
          });
          const bodyText = await response.text();
          return {
            status: response.status,
            bodyText,
            sentinelBytes: liveSentinel.length,
          };
        } catch (err) {
          return {
            status: 0,
            bodyText: "",
            error: String((err && err.message) || err),
            sentinelBytes: liveSentinel.length,
          };
        } finally {
          clearTimeout(timer);
        }
      },
      {
        path: CHECKOUT_API_PATH,
        payload,
        token: this.token,
        sentinel,
      },
    );

    console.log(
      `[ChatGPT] 已登录页 Checkout: HTTP ${result.status}, Sentinel=${result.sentinelBytes || 0} bytes`,
    );
    if (result.error) {
      return { ok: false, status: 0, data: {}, error: result.error };
    }
    return parseCheckoutApiBody(result.status, result.bodyText);
  }

  async postCheckoutFromPage(page, payload) {
    const pricing = require("./pricing-checkout");
    await installSentinelCapture(page);
    const planType = /pro/i.test(String(payload?.plan_name || ""))
      ? "pro_5x"
      : "plus";
    const country = String(
      payload?.billing_details?.country || "PH",
    ).toUpperCase();

    await ensureChatGptHome(page);
    console.log("[ChatGPT] 浏览器已设置 Session Cookie (已登录态)");
    console.log("[ChatGPT] 打开套餐弹窗，由站点自己完成 Sentinel Checkout...");
    await installSentinelCapture(page);

    const checkoutRoute = (url) =>
      /\/backend-api\/payments\/checkout(?:\?|$)/.test(String(url || ""));
    const rewriteCheckout = async (route) => {
      const req = route.request();
      if (req.method() !== "POST") {
        return route.continue();
      }
      const headers = { ...(req.headers() || {}) };
      rememberSentinelToken(page, captureSentinelFromHeaders(headers));
      return route.continue({
        postData: JSON.stringify(payload),
        headers,
      });
    };
    await page.route(checkoutRoute, rewriteCheckout);

    try {
      const { openPersonalWorkspace } = require("./auth-page-detect");
      await openPersonalWorkspace(page);
      await pricing.waitForPricingPage(page);
      await pricing.switchToPersonalPlans(page);
      await pricing.selectPricingRegion(page, country).catch((err) => {
        console.warn(`[ChatGPT] 地区切换跳过: ${err.message}`);
      });
    } catch (err) {
      console.warn(
        `[ChatGPT] 套餐页准备失败: ${String((err && err.message) || err)}`,
      );
      return {
        ok: false,
        status: 0,
        data: {},
        error: String((err && err.message) || err),
      };
    }

    const waiter = page.waitForResponse(
      (res) => res.request().method() === "POST" && checkoutRoute(res.url()),
      { timeout: 60000 },
    );
    try {
      await pricing.clickPlanUpgrade(page, planType);
    } catch (err) {
      console.warn(
        `[ChatGPT] 页面 Upgrade 触发失败: ${String((err && err.message) || err)}`,
      );
    }

    const response = await waiter.catch(() => null);
    await page.unroute(checkoutRoute, rewriteCheckout).catch(() => {});
    if (!response) {
      console.warn("[ChatGPT] 站点未发出 Checkout 请求，Sentinel 仍为空。");
      return {
        ok: false,
        status: 0,
        data: {},
        error: "sentinel token missing",
      };
    }

    const sentinel = captureSentinelFromHeaders(
      response.request().headers() || {},
    );
    const status = response.status();
    const requestBody = readRequestPostData(response.request());
    const bodyText = await response.text().catch(() => "");
    console.log(
      `[ChatGPT] 正常网页 Checkout 已提交: HTTP ${status}, Sentinel=${sentinel.length} bytes`,
    );
    const parsed = parseCheckoutApiBody(status, bodyText);
    if (
      parsed.ok &&
      planType === "plus" &&
      isGoCheckoutPayload(parsed.data, requestBody)
    ) {
      console.warn("[ChatGPT] 页面开单套餐是 Go，已丢弃，避免误扣 Plus");
      return {
        ok: false,
        status,
        data: parsed.data,
        error: "checkout plan mismatch: go",
      };
    }
    return parsed;
  }

  async postCheckoutRequest(payload, page, { forcePage = false } = {}) {
    if (forcePage && page && typeof page.evaluate === "function") {
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

  async postSameOriginJson(page, { path, method = "POST", body, accountId }) {
    const headers = {
      accept: "application/json",
      authorization: `Bearer ${this.token}`,
    };
    if (String(method || "POST").toUpperCase() !== "GET") {
      headers["content-type"] = "application/json";
    }
    const aid = String(accountId || "").trim();
    if (aid) {
      headers["chatgpt-account-id"] = aid;
      headers["openai-account-id"] = aid;
    }
    const verb = String(method || "POST").toUpperCase();
    const url = /^https?:\/\//i.test(String(path || ""))
      ? String(path)
      : `https://chatgpt.com${String(path || "").startsWith("/") ? path : `/${path}`}`;
    if (page && typeof page.goto === "function") {
      const current = String(
        (typeof page.url === "function" && page.url()) || "",
      );
      if (!/^https:\/\/chatgpt\.com(\/|$)/i.test(current)) {
        await page
          .goto("https://chatgpt.com/gifts/credits", {
            waitUntil: "domcontentloaded",
            timeout: 20000,
          })
          .catch(() => {});
      }
    }
    if (page && typeof page.evaluate === "function") {
      const result = await page.evaluate(
        async ({ url, method, headers, body }) => {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 20000);
          try {
            const response = await fetch(url, {
              method,
              credentials: "include",
              headers,
              body:
                body && method !== "GET" ? JSON.stringify(body) : undefined,
              signal: controller.signal,
            });
            const bodyText = await response.text();
            return { status: response.status, bodyText };
          } catch (err) {
            return {
              status: 0,
              bodyText: "",
              error: String((err && err.message) || err),
            };
          } finally {
            clearTimeout(timer);
          }
        },
        { url, method: verb, headers, body },
      );
      if (result.error) {
        return { ok: false, status: 0, data: {}, error: result.error };
      }
      return parseCheckoutApiBody(result.status, result.bodyText);
    }
    const fn =
      this.request &&
      this.request[verb === "GET" ? "get" : "post"];
    if (typeof fn === "function") {
      const response = await fn.call(this.request, url, {
        headers,
        data: verb === "GET" ? undefined : body,
        timeout: 20000,
      });
      const bodyText = await response.text().catch(() => "");
      return parseCheckoutApiBody(response.status(), bodyText);
    }
    return { ok: false, status: 0, data: {}, error: "missing request api" };
  }

  async createGiftCreditsOrder({
    page,
    amount,
    country,
    currency,
    accountId,
  } = {}) {
    const quantity = normalizeGiftCreditAmount(amount);
    const parsed = await this.postSameOriginJson(page, {
      path: "/backend-api/gift-credits/checkout",
      method: "POST",
      body: {
        amount: quantity,
        billing_details: { country, currency },
      },
      accountId,
    });
    const giftId = extractGiftId(parsed.data);
    if (!parsed.ok || !giftId) {
      return {
        giftId: "",
        amount: quantity,
        error: parsed.error || "gift-credits/checkout 未返回 gift_id",
        data: parsed.data,
      };
    }
    console.log(`[ChatGPT] 礼品卡 gift_id=${giftId} amount=${quantity}`);
    return { giftId, amount: quantity, data: parsed.data };
  }

  async fetchGiftCreditsRedeem({ page, giftId, accountId } = {}) {
    const id = String(giftId || "").trim();
    if (!id) return { giftId: "", redeemUrl: "" };
    let lastData = {};
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      const parsed = await this.postSameOriginJson(page, {
        path: `/backend-api/gift-credits/${encodeURIComponent(id)}`,
        method: "GET",
        accountId,
      });
      lastData = parsed.data || {};
      const redeemUrl = pickExplicitGiftRedeemUrl(lastData);
      if (redeemUrl) {
        return { giftId: id, redeemUrl, data: lastData };
      }
      await sleepMs(1500);
    }
    return {
      giftId: id,
      redeemUrl: buildGiftCreditsRedeemUrl(lastData, id),
      data: lastData,
    };
  }

  /**
   * 创建 Stripe Checkout Session，根据 plan_type 选择对应 plan_name
   * @param {string} planType - 'plus' | 'pro_5x' | 'pro_20x' | 'credits'
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
      const creditQuantity = Number(
        options.creditQuantity || store.resolveCreditQuantity(planType, 0) || 0,
      );
      const profile = extractProfileFromToken(this.token);
      let accountId = String(profile.accountId || "").trim();
      let warmupPlan = "";
      const pageCheckoutFirst =
        options.page && typeof options.page.evaluate === "function";
      if (accountId) {
        this.headers = buildCheckoutHeaders(this.token, { accountId });
      }
      const useGiftCredits =
        (store.isCreditsPlan(planType) || creditQuantity > 0) &&
        options.giftCredits !== false;
      let giftId = String(options.giftId || "").trim();
      if (useGiftCredits && !giftId) {
        const gift = await this.createGiftCreditsOrder({
          page: options.page,
          amount: creditQuantity,
          country,
          currency,
          accountId,
        });
        giftId = String(gift.giftId || "").trim();
        if (!giftId) {
          return {
            sessionId: null,
            checkoutUrl: null,
            giftId: "",
            error: gift.error || "gift-credits/checkout 未返回 gift_id",
          };
        }
      }
      const modes = pageCheckoutFirst
        ? ["custom"]
        : resolveCheckoutModes(warmupPlan, {
            credits: store.isCreditsPlan(planType) || creditQuantity > 0,
            creditQuantity,
          });
      console.log(
        `[ChatGPT] 创建 Checkout Session: plan_name=${planName}, country=${country}, currency=${currency}, account_id=${accountId || "none"}, current_plan=${warmupPlan || "none"}, modes=${modes.join("->")}${creditQuantity ? `, credits=${creditQuantity}` : ""}${giftId ? `, gift_id=${giftId}` : ""}${pageCheckoutFirst ? ", via=php-protocol" : ""}`,
      );

      let lastParsed = null;
      for (const uiMode of modes) {
        const payload = buildCheckoutPayload(planName, country, currency, {
          uiMode,
          accountId,
          creditQuantity,
          giftId,
          giftCredits: useGiftCredits,
        });
        console.log(`[ChatGPT] 尝试 checkout 模式: ${planType}-${uiMode}`);
        let parsed;
        if (pageCheckoutFirst) {
          console.log("[ChatGPT] 先走 PHP 协议提链...");
          const savedCookies = await snapshotChatGptCookies(options.page);
          parsed = { ok: false };
          for (let attempt = 1; attempt <= 3; attempt += 1) {
            parsed = await this.postPhpProtocolCheckout(options.page, payload, {
              accountId,
            });
            if (parsed.ok) break;
            if (
              !isTransientProxyNetworkError(parsed.error) ||
              attempt >= 3
            ) {
              break;
            }
            console.warn(
              `[ChatGPT] PHP 协议提链网络失败，重试 ${attempt}/3: ${String(parsed.error || parsed.status).slice(0, 120)}`,
            );
            await sleepMs(1500 * attempt);
          }
          if (!parsed.ok && shouldFallbackFromPhpCheckout(parsed)) {
            console.warn(
              `[ChatGPT] PHP 协议提链未过: ${String(parsed.error || parsed.status).slice(0, 120)}，改用原网页 Sentinel`,
            );
            await restoreChatGptCookies(options.page, savedCookies);
            const warmup = await warmupCheckoutContext(
              options.page,
              this.token,
              { country, accountId },
            );
            await restoreChatGptCookies(options.page, savedCookies);
            if (!accountId && warmup.accountId) {
              accountId = warmup.accountId;
              payload.account_id = accountId;
              payload.openai_account_id = accountId;
              if (payload.credit_purchase_data) {
                payload.credit_purchase_data.account_id = accountId;
              }
              this.headers = buildCheckoutHeaders(this.token, { accountId });
            }
            for (let attempt = 1; attempt <= 3; attempt += 1) {
              parsed = isCreditsCheckoutPayload(payload)
                ? await this.postCheckoutViaPageFetch(options.page, payload)
                : await this.postCheckoutRequest(payload, options.page, {
                    forcePage: true,
                  });
              if (parsed.ok) break;
              if (
                !isTransientProxyNetworkError(parsed.error) ||
                attempt >= 3
              ) {
                break;
              }
              console.warn(
                `[ChatGPT] 网页 Checkout 网络失败，重试 ${attempt}/3: ${String(parsed.error || parsed.status).slice(0, 120)}`,
              );
              await sleepMs(1500 * attempt);
            }
          }
        } else {
          parsed = await this.postCheckoutRequest(payload, null);
        }
        lastParsed = parsed;
        if (parsed.ok) {
          if (
            String(planType || "").toLowerCase() === "plus" &&
            isGoCheckoutPayload(parsed.data)
          ) {
            console.warn("[ChatGPT] Checkout 套餐是 Go，不是 Plus，已丢弃");
            lastParsed = {
              ...parsed,
              ok: false,
              error: "checkout plan mismatch: go",
            };
            continue;
          }
          const resolved = this.resolveCheckoutUrl(parsed.data, country);
          if (resolved.checkoutUrl) {
            const processorEntity =
              parsed.data?.processor_entity || resolveProcessorEntity(country);
            console.log(
              `[ChatGPT] Checkout route: provider=stripe, processor_entity=${processorEntity}, source=checkout_response`,
            );
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
              planName,
              giftId,
              data: {
                ...(parsed.data && typeof parsed.data === "object"
                  ? parsed.data
                  : {}),
                plan_name: parsed.data?.plan_name || planName,
                gift_id: giftId || parsed.data?.gift_id,
              },
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
          return { sessionId: null, checkoutUrl: null, giftId, error: detail };
        }
        if (
          String(detail).includes("permission") ||
          String(detail).includes("already_subscribed")
        ) {
          console.error("❌ [提示] 该账号可能已订阅或无权重复开通");
          return { sessionId: null, checkoutUrl: null, giftId, error: detail };
        }
        if (/unusual activity/i.test(String(detail))) {
          console.error(
            "❌ [提示] Checkout 被风控拦截，当前出口 IP / 账号组合被判定异常",
          );
          continue;
        }
      }

      const detail = lastParsed?.error || "未返回 data.url";
      return { sessionId: null, checkoutUrl: null, giftId, error: detail };
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
    creditQuantity = 0,
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

  if (store.isCreditsPlan(planType)) {
    const quantity = store.resolveCreditQuantity(planType, creditQuantity);
    const gpt = new ChatGPTService(page.context().request, token);
    const checkout = await gpt.createCheckoutSession(
      planType,
      region,
      billingCurrency,
      planNameOverride,
      { page, creditQuantity: quantity },
    );
    if (checkout.checkoutUrl && checkout.sessionId) {
      console.log(
        `✅ [步骤] 额度礼品卡走协议支付: session=${checkout.sessionId} quantity=${quantity} gift_id=${checkout.giftId || ""}`,
      );
      return { ...checkout, checkoutUrl: checkout.checkoutUrl };
    }
    throw new Error(
      `API 创建礼品 Checkout 失败: ${checkout.error || "未返回 session"}${checkout.giftId ? ` gift_id=${checkout.giftId}` : ""}`,
    );
  }

  const gpt = new ChatGPTService(page.context().request, token);
  const checkout = await gpt.createCheckoutSession(
    planType,
    region,
    billingCurrency,
    planNameOverride,
    { page, creditQuantity: Number(creditQuantity || 0) },
  );
  if (!checkout.checkoutUrl) {
    throw new Error(
      `API 创建 Checkout 失败: ${checkout.error || "未返回 data.url"}`,
    );
  }

  const url = checkout.checkoutUrl;
  console.log(`🔗 [步骤] 支付链接: ${url.slice(0, 120)}...`);

  if (!verifyPage || checkout.sessionId) {
    if (checkout.sessionId) {
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
module.exports.isCreditsCheckoutPayload = isCreditsCheckoutPayload;
module.exports.isGiftCreditsCheckoutPayload = isGiftCreditsCheckoutPayload;
module.exports.extractGiftId = extractGiftId;
module.exports.buildGiftCreditsRedeemUrl = buildGiftCreditsRedeemUrl;
module.exports.buildGiftCreditsPurchaseUrl = buildGiftCreditsPurchaseUrl;
module.exports.normalizeGiftCreditAmount = normalizeGiftCreditAmount;
module.exports.buildCodexCreditPurchaseUrl = buildCodexCreditPurchaseUrl;
module.exports.isCodexCreditPurchaseUrl = isCodexCreditPurchaseUrl;
module.exports.buildCheckoutHeaders = buildCheckoutHeaders;
module.exports.extractAccountIdFromCheck = extractAccountIdFromCheck;
module.exports.describeCheckoutAccount = describeCheckoutAccount;
module.exports.pickCheckoutAccountRecord = pickCheckoutAccountRecord;
module.exports.extractCheckoutPlan = extractCheckoutPlan;
module.exports.resolveCheckoutModes = resolveCheckoutModes;
module.exports.readRequestPostData = readRequestPostData;
module.exports.summarizeCheckoutCookies = summarizeCheckoutCookies;
module.exports.buildCheckoutWarmupRequests = buildCheckoutWarmupRequests;
module.exports.formatApiErrorDetail = formatApiErrorDetail;
module.exports.extractHomepageMetadata = extractHomepageMetadata;
module.exports.buildPhpCheckoutHeaders = buildPhpCheckoutHeaders;
module.exports.shouldFallbackFromPhpCheckout = shouldFallbackFromPhpCheckout;
module.exports.buildCheckoutSentinelReqBody = buildCheckoutSentinelReqBody;
module.exports.assembleCheckoutSentinelToken = assembleCheckoutSentinelToken;
module.exports.isUsableCheckoutSentinel = isUsableCheckoutSentinel;
module.exports.summarizeCheckoutSentinel = summarizeCheckoutSentinel;
