"use strict";

const crypto = require("crypto");
const { extractProfileFromToken } = require("./session-auth");

const FIRST_NAMES = [
  "James",
  "Mary",
  "Robert",
  "Patricia",
  "John",
  "Jennifer",
  "Michael",
  "Linda",
  "David",
  "Elizabeth",
  "William",
  "Barbara",
];
const LAST_NAMES = [
  "Smith",
  "Johnson",
  "Williams",
  "Brown",
  "Jones",
  "Garcia",
  "Miller",
  "Davis",
  "Wilson",
  "Anderson",
  "Thomas",
  "Taylor",
];

function generateRandomName() {
  const first = FIRST_NAMES[Math.floor(Math.random() * FIRST_NAMES.length)];
  const last = LAST_NAMES[Math.floor(Math.random() * LAST_NAMES.length)];
  return `${first} ${last}`;
}

const PLATFORM_BASE = "https://chatgpt.com";
const TAXES_PATH = "/backend-api/payments/checkout/taxes";
const CONFIRM_PATH = "/backend-api/payments/checkout/confirm";
const SUBSCRIPTIONS_PATH = "/backend-api/payments/subscriptions";
const STRIPE_BOOTSTRAP_PATH = "/backend-api/payments/stripe_client_bootstrap";
const STRIPE_API_BASE = "https://api.stripe.com/v1";
const STRIPE_VERSION = "2025-03-31.basil";
const STRIPE_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";

const US_STATE_CODES = {
  oregon: "OR",
  delaware: "DE",
  montana: "MT",
  "new hampshire": "NH",
  alaska: "AK",
};

function protocolEnabled() {
  const raw = String(process.env.CHECKOUT_PROTOCOL || "1")
    .trim()
    .toLowerCase();
  return raw !== "0" && raw !== "false" && raw !== "off";
}

function resolveProcessorEntity(country, checkout = {}) {
  const fromCheckout = String(checkout.processor_entity || "").trim();
  if (fromCheckout) return fromCheckout;
  return String(country || "").toUpperCase() === "US"
    ? "openai_llc"
    : "openai_ie";
}

function normalizeUsStateCode(state) {
  const raw = String(state || "").trim();
  if (!raw) return "";
  if (/^[A-Z]{2}$/i.test(raw)) return raw.toUpperCase();
  return US_STATE_CODES[raw.toLowerCase()] || raw;
}

function parseCardExpiry(expiry) {
  const digits = String(expiry || "").replace(/\D/g, "");
  if (digits.length === 4) {
    const month = Number(digits.slice(0, 2));
    const year2 = Number(digits.slice(2));
    return {
      exp_month: String(month),
      exp_year: String(2000 + year2),
    };
  }
  const match = String(expiry || "").match(/^(\d{1,2})\s*[/\-]\s*(\d{2,4})$/);
  if (!match) return { exp_month: "", exp_year: "" };
  const month = Number(match[1]);
  const yearRaw = match[2];
  const year = yearRaw.length === 2 ? 2000 + Number(yearRaw) : Number(yearRaw);
  return {
    exp_month: String(month),
    exp_year: String(year),
  };
}

function normalizeCardForProtocol(card = {}) {
  const number = String(card.number || card.card_number || "").replace(
    /\s+/g,
    "",
  );
  const expiry = parseCardExpiry(card.expiry || card.card_expiry);
  return {
    number,
    cvc: String(card.cvc || card.card_cvc || "").trim(),
    exp_month: expiry.exp_month,
    exp_year: expiry.exp_year,
    holder: String(card.holder || card.card_holder || "").trim(),
  };
}

function parseCheckoutUrl(raw = "") {
  const text = String(raw || "").trim();
  if (!text) return { sessionId: "", processorEntity: "", checkoutUrl: "" };
  const hosted = /checkout\.stripe\.com/i.test(text);
  const pathMatch = text.match(
    /\/checkout\/([a-z0-9_]+)\/((?:oaics_|cs_)[A-Za-z0-9_-]+)/i,
  );
  const idMatch = text.match(/((?:oaics_|cs_)[A-Za-z0-9_-]{8,})/i);
  return {
    sessionId: String(pathMatch?.[2] || idMatch?.[1] || "").trim(),
    processorEntity: String(pathMatch?.[1] || "").trim(),
    checkoutUrl: text,
    hosted,
  };
}

function findIn(obj, keys) {
  if (!obj || typeof obj !== "object") return "";
  const wanted = new Set(keys);
  const stack = [obj];
  while (stack.length) {
    const current = stack.pop();
    if (!current || typeof current !== "object") continue;
    if (Array.isArray(current)) {
      for (const item of current) stack.push(item);
      continue;
    }
    for (const [key, value] of Object.entries(current)) {
      if (wanted.has(key) && typeof value === "string" && value.trim()) {
        return value.trim();
      }
      if (value && typeof value === "object") stack.push(value);
    }
  }
  return "";
}

function extractCheckoutContext(checkout = {}, country = "") {
  const data =
    checkout.data && typeof checkout.data === "object"
      ? checkout.data
      : checkout;
  const parsedUrl = parseCheckoutUrl(
    checkout.checkoutUrl || data.checkoutUrl || data.url || "",
  );
  const sessionId = String(
    checkout.sessionId ||
      data.checkout_session_id ||
      data.session_id ||
      parsedUrl.sessionId ||
      "",
  ).trim();
  const processorEntity =
    String(data.processor_entity || parsedUrl.processorEntity || "").trim() ||
    resolveProcessorEntity(country, data);
  return {
    sessionId,
    processorEntity,
    checkoutUrl: String(
      checkout.checkoutUrl || parsedUrl.checkoutUrl || "",
    ).trim(),
    accountId: String(checkout.accountId || "").trim(),
    customerSessionClientSecret: String(
      data.customer_session_client_secret || "",
    ).trim(),
    publishableKey: String(
      data.publishable_key || data.publishableKey || "",
    ).trim(),
    hosted: parsedUrl.hosted,
    data,
  };
}

function hydrateCheckoutFromUrl(checkout = {}, pageUrl = "") {
  const current = checkout && typeof checkout === "object" ? checkout : {};
  const fromCheckout = parseCheckoutUrl(current.checkoutUrl);
  const fromPage = parseCheckoutUrl(pageUrl);
  const parsed = fromCheckout.sessionId ? fromCheckout : fromPage;
  const sessionId = current.sessionId || parsed.sessionId;
  if (!sessionId && !parsed.checkoutUrl) return current;
  return {
    ...current,
    sessionId,
    checkoutUrl: parsed.checkoutUrl || current.checkoutUrl || "",
    data: {
      ...(current.data && typeof current.data === "object" ? current.data : {}),
      checkout_session_id:
        current.sessionId ||
        current.data?.checkout_session_id ||
        parsed.sessionId,
      processor_entity:
        current.data?.processor_entity || parsed.processorEntity || "",
    },
  };
}

function canUseProtocolCheckout(checkout = {}, accessToken = "") {
  if (!protocolEnabled()) return false;
  if (!String(accessToken || "").trim()) return false;
  const ctx = extractCheckoutContext(checkout);
  return Boolean(ctx.sessionId && !ctx.hosted);
}

function buildTaxesPayload({
  sessionId,
  email,
  billingName,
  currency,
  processorEntity,
  address,
}) {
  const country = String(address.country || "US")
    .trim()
    .toUpperCase();
  return {
    checkout_session_id: sessionId,
    checkout_email: String(email || "").trim(),
    billing_country: country,
    billing_name: String(billingName || "").trim(),
    currency: String(currency || "USD")
      .trim()
      .toLowerCase(),
    processor_entity: processorEntity,
    billing_address: {
      line1: String(address.line1 || "").trim(),
      city: String(address.city || "").trim(),
      country,
      postal_code: String(address.postal_code || "").trim(),
      state: normalizeUsStateCode(address.state),
    },
  };
}

function buildConfirmPayload({ sessionId, confirmToken }) {
  return {
    checkout_session_id: sessionId,
    confirm_token: confirmToken,
    selected_payment_method_type: "card",
  };
}

function randomHex(n = 16) {
  return crypto.randomBytes(n).toString("hex");
}

function buildConfirmationTokenForm({
  card,
  billing,
  publishableKey,
  cussSecret = "",
  stripeCustomer = "",
}) {
  const clientSessionId = crypto.randomUUID();
  const elementsSessionId = `elements_session_${randomHex(5)}`;
  const elementsConfigId = crypto.randomUUID();
  const guid = `${crypto.randomUUID().replace(/-/g, "")}fbcd8f`;
  const muid = `${crypto.randomUUID().replace(/-/g, "")}e77c22`;
  const sid = `${crypto.randomUUID().replace(/-/g, "")}4e41f2`;
  const pm = "payment_method_data";
  const params = new URLSearchParams();
  const pairs = [
    [`${pm}[type]`, "card"],
    [`${pm}[card][number]`, card.number],
    [`${pm}[card][cvc]`, card.cvc],
    [`${pm}[card][exp_year]`, card.exp_year],
    [`${pm}[card][exp_month]`, card.exp_month],
    [`${pm}[allow_redisplay]`, "limited"],
    [`${pm}[billing_details][address][line1]`, billing.line1 || ""],
    [`${pm}[billing_details][address][city]`, billing.city || ""],
    [`${pm}[billing_details][address][country]`, billing.country || "US"],
    [`${pm}[billing_details][address][postal_code]`, billing.postal_code || ""],
    [`${pm}[billing_details][address][state]`, billing.state || ""],
    [`${pm}[billing_details][name]`, billing.name || ""],
    [`${pm}[billing_details][phone]`, ""],
    [
      `${pm}[payment_user_agent]`,
      "stripe.js/0000000000; stripe-js-v3/0000000000; payment-element; deferred-intent",
    ],
    [`${pm}[referrer]`, PLATFORM_BASE],
    [`${pm}[time_on_page]`, "375482"],
    [`${pm}[guid]`, guid],
    [`${pm}[muid]`, muid],
    [`${pm}[sid]`, sid],
    [`${pm}[client_attribution_metadata][client_session_id]`, clientSessionId],
    [
      `${pm}[client_attribution_metadata][merchant_integration_source]`,
      "elements",
    ],
    [
      `${pm}[client_attribution_metadata][merchant_integration_subtype]`,
      "payment-element",
    ],
    [
      `${pm}[client_attribution_metadata][merchant_integration_version]`,
      "2021",
    ],
    [
      `${pm}[client_attribution_metadata][payment_intent_creation_flow]`,
      "deferred",
    ],
    [
      `${pm}[client_attribution_metadata][payment_method_selection_flow]`,
      "merchant_specified",
    ],
    [
      `${pm}[client_attribution_metadata][elements_session_id]`,
      elementsSessionId,
    ],
    [
      `${pm}[client_attribution_metadata][elements_session_config_id]`,
      elementsConfigId,
    ],
    [
      `${pm}[client_attribution_metadata][merchant_integration_additional_elements][0]`,
      "expressCheckout",
    ],
    [
      `${pm}[client_attribution_metadata][merchant_integration_additional_elements][1]`,
      "payment",
    ],
    [
      `${pm}[client_attribution_metadata][merchant_integration_additional_elements][2]`,
      "address",
    ],
    ["setup_future_usage", "off_session"],
  ];

  if (cussSecret) {
    pairs.push(
      [
        "client_context[currency]",
        String(billing.currency || "usd").toLowerCase(),
      ],
      ["client_context[mode]", "subscription"],
      ["client_context[payment_method_types][0]", "card"],
      ["client_context[payment_method_types][1]", "link"],
    );
  }
  if (stripeCustomer) {
    pairs.push(["client_context[customer]", stripeCustomer]);
  }

  pairs.push(
    ["client_attribution_metadata[client_session_id]", clientSessionId],
    ["client_attribution_metadata[merchant_integration_source]", "elements"],
    [
      "client_attribution_metadata[merchant_integration_subtype]",
      "payment-element",
    ],
    ["client_attribution_metadata[merchant_integration_version]", "2021"],
    ["client_attribution_metadata[payment_intent_creation_flow]", "deferred"],
    [
      "client_attribution_metadata[payment_method_selection_flow]",
      "merchant_specified",
    ],
    ["client_attribution_metadata[elements_session_id]", elementsSessionId],
    [
      "client_attribution_metadata[elements_session_config_id]",
      elementsConfigId,
    ],
    [
      "client_attribution_metadata[merchant_integration_additional_elements][0]",
      "expressCheckout",
    ],
    [
      "client_attribution_metadata[merchant_integration_additional_elements][1]",
      "payment",
    ],
    [
      "client_attribution_metadata[merchant_integration_additional_elements][2]",
      "address",
    ],
    ["set_as_default_payment_method", "false"],
    ["key", publishableKey],
    ["_stripe_version", STRIPE_VERSION],
  );

  for (const [key, value] of pairs) {
    params.append(key, value);
  }
  return params;
}

function buildPaymentIntentConfirmForm({
  confirmationToken,
  clientSecret,
  publishableKey,
  returnUrl,
}) {
  const params = new URLSearchParams();
  params.append("confirmation_token", confirmationToken);
  params.append("client_secret", clientSecret);
  params.append("key", publishableKey);
  params.append("return_url", returnUrl);
  params.append("_stripe_version", STRIPE_VERSION);
  params.append(
    "client_attribution_metadata[client_session_id]",
    crypto.randomUUID(),
  );
  params.append(
    "client_attribution_metadata[merchant_integration_source]",
    "l1",
  );
  return params;
}

function stripeHeaders() {
  return {
    Accept: "application/json",
    "Content-Type": "application/x-www-form-urlencoded",
    Origin: "https://js.stripe.com",
    Referer: "https://js.stripe.com/",
    "User-Agent": STRIPE_UA,
  };
}

function formatApiError(status, body) {
  if (body && typeof body === "object") {
    const detail = body.detail ?? body.message ?? body.error;
    if (typeof detail === "string" && detail.trim()) return detail;
    if (detail && typeof detail === "object" && detail.message) {
      return String(detail.message);
    }
  }
  return `HTTP ${status}`;
}

async function postSameOriginJson(page, { path, payload, headers, referer }) {
  return page.evaluate(
    async ({ path, payload, headers, referer }) => {
      try {
        const requestHeaders = { ...headers };
        if (referer) requestHeaders.Referer = referer;
        const response = await fetch(path, {
          method: "POST",
          credentials: "include",
          headers: requestHeaders,
          body: JSON.stringify(payload),
        });
        return {
          status: response.status,
          bodyText: await response.text(),
        };
      } catch (err) {
        return {
          status: 0,
          bodyText: "",
          error: String((err && err.message) || err),
        };
      }
    },
    { path, payload, headers, referer: referer || "" },
  );
}

async function getSameOriginJson(page, { path, headers }) {
  return page.evaluate(
    async ({ path, headers }) => {
      try {
        const response = await fetch(path, {
          method: "GET",
          credentials: "include",
          headers,
        });
        return {
          status: response.status,
          bodyText: await response.text(),
        };
      } catch (err) {
        return {
          status: 0,
          bodyText: "",
          error: String((err && err.message) || err),
        };
      }
    },
    { path, headers },
  );
}

function parseJsonBody(bodyText) {
  try {
    return bodyText ? JSON.parse(bodyText) : {};
  } catch (_) {
    return {};
  }
}

function amountFromMinorUnits(amountTotal, currency) {
  const n = Number(amountTotal);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n) / 100;
}

function expectedProtocolDueRange(currency, planName = "") {
  const cur = String(currency || "").toUpperCase();
  const plan = String(planName || "").toLowerCase();
  if (cur === "PHP" && (!plan || /plus/.test(plan))) {
    return { min: 900, max: 1050 };
  }
  return null;
}

function isExpectedProtocolDueAmount(dueAmount, currency, planName = "") {
  const amount = Number(dueAmount);
  if (!Number.isFinite(amount) || amount <= 0) return false;
  const range = expectedProtocolDueRange(currency, planName);
  if (!range) return true;
  return amount >= range.min && amount <= range.max;
}

function stripeDeclineMessage(error = {}) {
  const decline = String(error.decline_code || "").toLowerCase();
  if (decline === "insufficient_funds") return "银行卡余额不足";
  return String(error.message || "银行卡被拒绝");
}

async function resolvePublishableKey({
  page,
  accessToken,
  accountId,
  checkout,
}) {
  const envKey = String(process.env.STRIPE_KEY || "").trim();
  if (envKey.startsWith("pk_")) return envKey;

  const fromCheckout = String(
    checkout.publishableKey ||
      checkout.data?.publishable_key ||
      checkout.data?.publishableKey ||
      "",
  ).trim();
  if (fromCheckout.startsWith("pk_")) return fromCheckout;

  if (page && accountId) {
    const result = await getSameOriginJson(page, {
      path: `${STRIPE_BOOTSTRAP_PATH}?account_id=${encodeURIComponent(accountId)}`,
      headers: {
        accept: "application/json",
        authorization: `Bearer ${accessToken}`,
        "chatgpt-account-id": accountId,
        "openai-account-id": accountId,
      },
    });
    const data = parseJsonBody(result.bodyText);
    const key = findIn(data, ["publishable_key", "publishableKey"]);
    if (key.startsWith("pk_")) return key;
  }

  throw new Error("缺少 Stripe publishable key");
}

function getAxios() {
  return require("axios");
}

async function createConfirmationToken({
  card,
  billing,
  publishableKey,
  cussSecret,
  stripeCustomer,
}) {
  const axios = getAxios();
  const form = buildConfirmationTokenForm({
    card,
    billing,
    publishableKey,
    cussSecret,
    stripeCustomer,
  });
  const response = await axios.post(
    `${STRIPE_API_BASE}/confirmation_tokens`,
    form.toString(),
    {
      headers: stripeHeaders(),
      validateStatus: () => true,
      timeout: 30000,
    },
  );
  const data = response.data || {};
  if (response.status !== 200) {
    const err = data.error || {};
    throw Object.assign(
      new Error(
        `Stripe 令牌化失败: ${err.message || formatApiError(response.status, data)}`,
      ),
      { declined: Boolean(err.code || err.decline_code), stripeError: err },
    );
  }
  const tokenId = String(data.id || data.confirmation_token || "").trim();
  if (!tokenId) {
    throw new Error("confirmation_tokens 响应缺少 token");
  }
  return tokenId;
}

async function confirmPaymentIntent({
  piId,
  clientSecret,
  confirmationToken,
  publishableKey,
  returnUrl,
}) {
  const axios = getAxios();
  const form = buildPaymentIntentConfirmForm({
    confirmationToken,
    clientSecret,
    publishableKey,
    returnUrl,
  });
  const response = await axios.post(
    `${STRIPE_API_BASE}/payment_intents/${piId}/confirm`,
    form.toString(),
    {
      headers: stripeHeaders(),
      validateStatus: () => true,
      timeout: 30000,
    },
  );
  const data = response.data || {};
  if (response.status === 200) {
    const status = String(data.status || "");
    if (status === "succeeded") {
      return { ok: true, paymentIntent: data };
    }
    const error = data.last_payment_error || {};
    return {
      ok: false,
      actionRequired: status === "requires_action",
      declined: Boolean(
        error.code ||
        error.decline_code ||
        status === "requires_payment_method",
      ),
      error:
        stripeDeclineMessage(error) ||
        `PaymentIntent 状态: ${status || "unknown"}`,
      paymentIntent: data,
    };
  }
  const error = data.error || {};
  return {
    ok: false,
    declined: Boolean(error.code || error.decline_code),
    error: stripeDeclineMessage(error) || "支付失败",
    paymentIntent: error.payment_intent || data,
  };
}

async function completeProtocolCheckout({
  page,
  accessToken,
  checkout,
  card,
  billing,
  accountId,
  email,
  onProgress,
}) {
  const progress = (msg) => {
    console.log(`[CheckoutProtocol] ${msg}`);
    if (typeof onProgress === "function") {
      try {
        onProgress(msg);
      } catch (_) {
        /* ignore */
      }
    }
  };

  const token = String(accessToken || "").trim();
  const ctx = extractCheckoutContext(checkout);
  const profile = extractProfileFromToken(token);
  const resolvedAccountId = String(
    accountId || ctx.accountId || profile.accountId || "",
  ).trim();
  const holderName = String(
    billing.name || card.holder || generateRandomName(),
  ).trim();
  const cardInfo = normalizeCardForProtocol({ ...card, holder: holderName });
  if (!ctx.sessionId) {
    return {
      success: false,
      fallback: true,
      error: "缺少 checkout_session_id",
    };
  }
  if (
    !cardInfo.number ||
    !cardInfo.exp_month ||
    !cardInfo.exp_year ||
    !cardInfo.cvc
  ) {
    return { success: false, fallback: true, error: "卡片有效期/CVC 无法解析" };
  }

  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (resolvedAccountId) {
    headers["chatgpt-account-id"] = resolvedAccountId;
    headers["openai-account-id"] = resolvedAccountId;
  }

  const taxPayload = buildTaxesPayload({
    sessionId: ctx.sessionId,
    email: email || profile.email || billing.email || "",
    billingName: holderName,
    currency: billing.currency,
    processorEntity: ctx.processorEntity,
    address: billing,
  });
  progress(
    `提交税费: session=${ctx.sessionId.slice(0, 18)}… processor=${ctx.processorEntity}`,
  );
  const taxResult = await postSameOriginJson(page, {
    path: TAXES_PATH,
    payload: taxPayload,
    headers,
  });
  if (taxResult.error && !taxResult.bodyText) {
    return { success: false, fallback: true, error: taxResult.error };
  }
  const taxData = parseJsonBody(taxResult.bodyText);
  if (taxResult.status !== 200) {
    return {
      success: false,
      fallback: true,
      error: `税费接口失败: ${formatApiError(taxResult.status, taxData)}`,
    };
  }
  const checkoutSession = taxData.checkout_session || {};
  const amountTotal = Number(checkoutSession.amount_total || 0);
  const dueAmount = amountFromMinorUnits(amountTotal, billing.currency);
  const dueCurrency = String(billing.currency || "").toUpperCase();
  const stripeCustomer = String(checkoutSession.customer || "").trim();
  progress(`税费完成: ${dueCurrency} ${dueAmount || amountTotal}`);
  if (!isExpectedProtocolDueAmount(dueAmount, dueCurrency, ctx.planName || billing.planName)) {
    return {
      success: false,
      fallback: true,
      error: `应付金额异常: ${dueCurrency} ${dueAmount || amountTotal}`,
      holderName,
      dueAmount,
      dueCurrency,
    };
  }

  let publishableKey;
  try {
    publishableKey = await resolvePublishableKey({
      page,
      accessToken: token,
      accountId: resolvedAccountId,
      checkout: ctx,
    });
  } catch (err) {
    return { success: false, fallback: true, error: err.message };
  }

  progress("正在令牌化卡片...");
  let confirmToken;
  try {
    confirmToken = await createConfirmationToken({
      card: cardInfo,
      billing: {
        ...billing,
        name: holderName,
        country: String(billing.country || "US").toUpperCase(),
        state: normalizeUsStateCode(billing.state),
        currency: String(billing.currency || "usd").toLowerCase(),
      },
      publishableKey,
      cussSecret: ctx.customerSessionClientSecret,
      stripeCustomer,
    });
  } catch (err) {
    return {
      success: false,
      declined: Boolean(err.declined),
      error: err.message,
      holderName,
      dueAmount,
      dueCurrency: String(billing.currency || "").toUpperCase(),
    };
  }

  const referer = `${PLATFORM_BASE}/checkout/${ctx.processorEntity}/${ctx.sessionId}`;
  progress("确认 Checkout...");
  const confirmResult = await postSameOriginJson(page, {
    path: CONFIRM_PATH,
    payload: buildConfirmPayload({
      sessionId: ctx.sessionId,
      confirmToken,
    }),
    headers,
    referer,
  });
  const confirmData = parseJsonBody(confirmResult.bodyText);
  if (confirmResult.status !== 200) {
    return {
      success: false,
      fallback: true,
      error: `确认接口失败: ${formatApiError(confirmResult.status, confirmData)}`,
      holderName,
    };
  }

  const clientSecret = String(confirmData.client_secret || "").trim();
  const confirmStatus = String(confirmData.status || "");
  if (!clientSecret) {
    if (/succeed|success|complete/i.test(confirmStatus)) {
      return {
        success: true,
        holderName,
        dueAmount,
        dueCurrency: String(billing.currency || "").toUpperCase(),
      };
    }
    return {
      success: false,
      fallback: true,
      error: `确认响应缺少 client_secret (status=${confirmStatus || "unknown"})`,
      holderName,
    };
  }

  const piId = clientSecret.split("_secret_")[0];
  const returnUrl = `${PLATFORM_BASE}/checkout/openai_llc/${ctx.sessionId}`;
  progress(`确认 PaymentIntent: ${piId}`);
  const piResult = await confirmPaymentIntent({
    piId,
    clientSecret,
    confirmationToken: confirmToken,
    publishableKey,
    returnUrl,
  });
  if (!piResult.ok) {
    return {
      success: false,
      declined: Boolean(piResult.declined),
      actionRequired: Boolean(piResult.actionRequired),
      error: piResult.actionRequired
        ? "需要完成银行卡 3D Secure 验证"
        : piResult.error || "Stripe 扣款失败",
      holderName,
      dueAmount,
      dueCurrency: String(billing.currency || "").toUpperCase(),
    };
  }

  try {
    await page
      .goto(returnUrl, {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      })
      .catch(() => {});
    if (resolvedAccountId) {
      await getSameOriginJson(page, {
        path: `${SUBSCRIPTIONS_PATH}?account_id=${encodeURIComponent(resolvedAccountId)}`,
        headers: {
          accept: "application/json",
          authorization: `Bearer ${token}`,
          "chatgpt-account-id": resolvedAccountId,
          "openai-account-id": resolvedAccountId,
        },
      });
    }
  } catch (_) {
    /* verify is best-effort */
  }

  return {
    success: true,
    holderName,
    dueAmount,
    dueCurrency: String(billing.currency || "").toUpperCase(),
  };
}

module.exports = {
  protocolEnabled,
  canUseProtocolCheckout,
  extractCheckoutContext,
  parseCheckoutUrl,
  hydrateCheckoutFromUrl,
  resolveProcessorEntity,
  normalizeUsStateCode,
  parseCardExpiry,
  normalizeCardForProtocol,
  buildTaxesPayload,
  buildConfirmPayload,
  buildConfirmationTokenForm,
  buildPaymentIntentConfirmForm,
  completeProtocolCheckout,
  isExpectedProtocolDueAmount,
};
