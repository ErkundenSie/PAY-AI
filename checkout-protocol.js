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
const APPROVE_PATH = "/backend-api/payments/checkout/approve";
const SUBSCRIPTIONS_PATH = "/backend-api/payments/subscriptions";
const STRIPE_BOOTSTRAP_PATH = "/backend-api/payments/stripe_client_bootstrap";
const STRIPE_API_BASE = "https://api.stripe.com/v1";
const STRIPE_VERSION = "2025-03-31.basil";
const STRIPE_JS_DEPLOY_STATUS =
  "https://js.stripe.com/deploy_status_henson.json";
const CHECKOUT_STRIPE_ORIGIN = "https://checkout.stripe.com";
const OPENAI_PUBLISHABLE_KEYS = [
  "pk_live_51Pj377KslHRdbaPgTJYjThzH3f5dt1N1vK7LUp0qh0yNSarhfZ6nfbG7FFlh8KLxVkvdMWN5o6Mc4Vda6NHaSnaV00C2Sbl8Zs",
  "pk_live_51HOrSwC6h1nxGoI3lTAgRjYVrz4dU3fVOabyCcKR3pbEJguCVAlqCxdxCUvoRh1XWwRacViovU3kLKvpkjh7IqkW00iXQsjo3n",
];
const STRIPE_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";
const BROWSER_MAJOR = "136";

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

function isCreditsProtocolPlan(planName = "") {
  return /credit|usage_based|platformbusiness|chatgptbusiness/i.test(
    String(planName || ""),
  );
}

function resolveProtocolClientMode(billing = {}) {
  const explicit = String(billing.clientMode || billing.mode || "")
    .trim()
    .toLowerCase();
  if (explicit === "payment" || explicit === "subscription") return explicit;
  if (billing.credits === true || isCreditsProtocolPlan(billing.planName)) {
    return "payment";
  }
  return "subscription";
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
    if (!Number.isInteger(month) || month < 1 || month > 12) {
      return { exp_month: "", exp_year: "" };
    }
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
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    return { exp_month: "", exp_year: "" };
  }
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

function isHostedStripeSession(sessionId = "", checkoutUrl = "") {
  if (/checkout\.stripe\.com/i.test(String(checkoutUrl || ""))) return true;
  return /^cs_(?:live|test)_/i.test(String(sessionId || ""));
}

function parseCheckoutUrl(raw = "") {
  const text = String(raw || "").trim();
  if (!text) {
    return { sessionId: "", processorEntity: "", checkoutUrl: "", hosted: false };
  }
  const pathMatch = text.match(
    /\/checkout\/([a-z0-9_]+)\/((?:oaics_|cs_)[A-Za-z0-9_-]+)/i,
  );
  const idMatch = text.match(/((?:oaics_|cs_)[A-Za-z0-9_-]{8,})/i);
  const sessionId = String(pathMatch?.[2] || idMatch?.[1] || "").trim();
  return {
    sessionId,
    processorEntity: String(pathMatch?.[1] || "").trim(),
    checkoutUrl: text,
    hosted: isHostedStripeSession(sessionId, text),
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
    hosted: isHostedStripeSession(
      sessionId,
      checkout.checkoutUrl || parsedUrl.checkoutUrl || data.url || "",
    ),
    planName: String(
      checkout.planName || data.plan_name || data.planName || "",
    ).trim(),
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
  return Boolean(ctx.sessionId);
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

function stripeDeviceId(hosted = false) {
  if (hosted) return `${crypto.randomUUID()}${randomHex(3)}`;
  return `${crypto.randomUUID().replace(/-/g, "")}fbcd8f`;
}

function buildConfirmationTokenForm({
  card,
  billing,
  publishableKey,
  cussSecret = "",
  stripeCustomer = "",
  hosted = false,
  stripeVersion = "",
  elementsSessionId: elementsSessionIdArg = "",
  elementsConfigId: elementsConfigIdArg = "",
}) {
  const clientSessionId = crypto.randomUUID();
  const elementsSessionId =
    elementsSessionIdArg || `elements_session_${randomHex(5)}`;
  const elementsConfigId = elementsConfigIdArg || crypto.randomUUID();
  const guid = stripeDeviceId(hosted);
  const muid = stripeDeviceId(hosted);
  const sid = stripeDeviceId(hosted);
  const attr = hosted
    ? { source: "checkout", version: "custom", selectionFlow: "automatic" }
    : {
        source: "elements",
        version: "2021",
        selectionFlow: "merchant_specified",
      };
  const version =
    String(stripeVersion || STRIPE_VERSION).split(";")[0].trim() ||
    STRIPE_VERSION;
  const pm = "payment_method_data";
  const params = new URLSearchParams();
  const clientMode = resolveProtocolClientMode(billing);
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
      attr.source,
    ],
    [
      `${pm}[client_attribution_metadata][merchant_integration_subtype]`,
      "payment-element",
    ],
    [
      `${pm}[client_attribution_metadata][merchant_integration_version]`,
      attr.version,
    ],
    [
      `${pm}[client_attribution_metadata][payment_intent_creation_flow]`,
      "deferred",
    ],
    [
      `${pm}[client_attribution_metadata][payment_method_selection_flow]`,
      attr.selectionFlow,
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
    ...(clientMode === "subscription"
      ? [["setup_future_usage", "off_session"]]
      : []),
    [
      "client_context[currency]",
      String(billing.currency || "usd").toLowerCase(),
    ],
    ["client_context[mode]", clientMode],
    ["client_context[payment_method_types][0]", "card"],
    ["client_context[payment_method_types][1]", "link"],
  ];

  if (stripeCustomer) {
    pairs.push(["client_context[customer]", stripeCustomer]);
  }

  pairs.push(
    ["client_attribution_metadata[client_session_id]", clientSessionId],
    ["client_attribution_metadata[merchant_integration_source]", attr.source],
    [
      "client_attribution_metadata[merchant_integration_subtype]",
      "payment-element",
    ],
    [
      "client_attribution_metadata[merchant_integration_version]",
      attr.version,
    ],
    ["client_attribution_metadata[payment_intent_creation_flow]", "deferred"],
    [
      "client_attribution_metadata[payment_method_selection_flow]",
      attr.selectionFlow,
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
    ["_stripe_version", version],
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
    priority: "u=1, i",
    "sec-ch-ua": `"Not;A=Brand";v="8", "Chromium";v="${BROWSER_MAJOR}", "Google Chrome";v="${BROWSER_MAJOR}"`,
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "sec-ch-ua-arch": '"x86"',
    "sec-ch-ua-bitness": '"64"',
    "sec-ch-ua-full-version": `"${BROWSER_MAJOR}.0.0.0"`,
    "sec-ch-ua-full-version-list": `"Not;A=Brand";v="8", "Chromium";v="${BROWSER_MAJOR}.0.0.0", "Google Chrome";v="${BROWSER_MAJOR}.0.0.0"`,
    "sec-ch-ua-platform-version": '"15.0.0"',
  };
}

function toSameOriginPath(raw = "") {
  const text = String(raw || "").trim();
  if (!text) return "";
  try {
    const url = new URL(text, PLATFORM_BASE);
    if (url.origin === PLATFORM_BASE) {
      return `${url.pathname}${url.search}`;
    }
  } catch (_) {
    /* ignore */
  }
  return text.startsWith("/") ? text : "";
}

async function tryChallengeSdk(page, flow) {
  if (!page || typeof page.evaluate !== "function") {
    return { token: "", telemetry: "" };
  }
  return page
    .evaluate(async (requestedFlow) => {
      if (typeof window.ChallengeSDK === "undefined") {
        return { token: "", telemetry: "" };
      }
      await window.ChallengeSDK.init(requestedFlow);
      const tokenValue = await window.ChallengeSDK.token(requestedFlow);
      let timingValue = "";
      if (typeof window.ChallengeSDK.timing === "function") {
        timingValue = await window.ChallengeSDK.timing();
      }
      return {
        token: String(tokenValue || "").trim(),
        telemetry: timingValue
          ? JSON.stringify(timingValue)
          : "[1,null]",
      };
    }, flow)
    .catch(() => ({ token: "", telemetry: "" }));
}

async function collectProtocolApiHeaders({
  page,
  accessToken,
  accountId,
  flow,
  targetPath,
  referer,
}) {
  const chatgpt = require("./chatgpt");
  const gpt = new chatgpt.ChatGPTService(
    page && typeof page.context === "function" ? page.context().request : null,
    accessToken,
  );
  const php = await gpt.collectPhpCheckoutContext(page, accountId);
  const sdk = await tryChallengeSdk(page, flow);
  const sentinel =
    sdk.token ||
    (await gpt.harvestPhpSentinel(page, { flow }).catch(() => ""));
  const headers = chatgpt.buildPhpCheckoutHeaders({
    token: accessToken,
    accountId: php.accountId || accountId,
    deviceId: php.deviceId,
    clientVersion: php.clientVersion,
    clientBuild: php.clientBuild,
    attestation: php.attestation,
    sentinel: chatgpt.isUsableCheckoutSentinel(sentinel) ? sentinel : "",
    extra: {
      "x-openai-target-path": targetPath,
      "x-openai-target-route": targetPath,
      ...(referer ? { Referer: referer } : {}),
      ...(sdk.telemetry ? { "oai-telemetry": sdk.telemetry } : {}),
    },
  });
  const sizes = chatgpt.summarizeCheckoutSentinel(sentinel);
  return {
    headers,
    sentinel,
    attestation: php.attestation,
    deviceId: php.deviceId,
    flow: sizes.flow || flow,
    sentinelBytes: sizes.total,
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
  const args = { path, payload, headers, referer: referer || "" };
  const run = () =>
    page.evaluate(async ({ path, payload, headers, referer }) => {
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
    }, args);

  try {
    return await run();
  } catch (err) {
    const msg = String((err && err.message) || err);
    if (!/Execution context was destroyed|navigation/i.test(msg)) throw err;
    await page
      .waitForLoadState("domcontentloaded", { timeout: 20000 })
      .catch(() => {});
    const now =
      page && typeof page.url === "function" ? String(page.url() || "") : "";
    if (!now.startsWith("https://chatgpt.com")) {
      await page
        .goto("https://chatgpt.com/", {
          waitUntil: "domcontentloaded",
          timeout: 60000,
        })
        .catch(() => {});
    }
    return run();
  }
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
  if (/credit|usage_based|platformbusiness/.test(plan)) {
    return null;
  }
  if (cur !== "PHP") {
    return null;
  }
  if (/prolite|pro_5x|pro5x|5xpro/.test(plan)) {
    return { min: 3800, max: 6400 };
  }
  if (/pro_20x|pro20x|chatgptpro(?!lite)/.test(plan)) {
    return { min: 7500, max: 12500 };
  }
  if (!plan || /plus/.test(plan)) {
    return { min: 900, max: 1050 };
  }
  return null;
}

function isExpectedProtocolDueAmount(dueAmount, currency, planName = "") {
  if (String(process.env.CHECKOUT_WAIT_USER || "").trim() === "1") {
    const amount = Number(dueAmount);
    return Number.isFinite(amount) && amount > 0;
  }
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
  hosted = false,
  stripeVersion = "",
  elementsSessionId = "",
  elementsConfigId = "",
}) {
  const axios = getAxios();
  const form = buildConfirmationTokenForm({
    card,
    billing,
    publishableKey,
    cussSecret,
    stripeCustomer,
    hosted,
    stripeVersion,
    elementsSessionId,
    elementsConfigId,
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
    const missingParam = String(err.param || err.message || "");
    const configError = /missing required param|client_context/i.test(
      missingParam,
    );
    throw Object.assign(
      new Error(
        `Stripe 令牌化失败: ${err.message || formatApiError(response.status, data)}`,
      ),
      {
        declined: Boolean(err.code || err.decline_code) && !configError,
        stripeError: err,
      },
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

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pkPrefix(pk = "") {
  return String(pk || "").slice(0, 24);
}

function hostedPublishableKeyCandidates(preferred = "") {
  const keys = [preferred, ...OPENAI_PUBLISHABLE_KEYS].filter((key) =>
    String(key || "").startsWith("pk_"),
  );
  return [...new Set(keys)];
}

function hostedStripeVersion(deploy = {}) {
  const basil = deploy.basil || {};
  const rv = String(basil.rv || STRIPE_VERSION).trim();
  const base = rv.includes("basil") ? rv : `${rv}.basil`;
  return base.split(";")[0].trim();
}

function checkoutPageHeaders(sessionId = "", extra = {}) {
  const sid = String(sessionId || "").trim();
  return {
    Accept: "application/json",
    "Accept-Language": "en-US,en;q=0.9",
    Referer: `${CHECKOUT_STRIPE_ORIGIN}/c/pay/${sid}`,
    "User-Agent": STRIPE_UA,
    ...extra,
  };
}

function cookieHeaderFromAxios(headers = {}) {
  const setCookie = headers["set-cookie"] || headers["Set-Cookie"];
  const list = Array.isArray(setCookie)
    ? setCookie
    : setCookie
      ? [setCookie]
      : [];
  return list
    .map((line) => String(line).split(";")[0].trim())
    .filter(Boolean)
    .join("; ");
}

function extractPaymentPageInitFromHtml(html = "") {
  const text = String(html || "");
  if (!text) return null;
  const pick = (key) => {
    const match = text.match(new RegExp(`"${key}"\\s*:\\s*"([^"]+)"`, "i"));
    return match?.[1] || "";
  };
  const pkMatch = text.match(/pk_(?:live|test)_[A-Za-z0-9]+/);
  const data = {
    init_checksum: pick("init_checksum"),
    checkout_config_id: pick("checkout_config_id"),
    ppage_token: pick("ppage_token"),
    publishable_key: pkMatch?.[0] || pick("publishable_key"),
  };
  if (
    !data.init_checksum &&
    !data.ppage_token &&
    !data.publishable_key &&
    !data.checkout_config_id
  ) {
    return null;
  }
  return data;
}

function asNestedId(value) {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (value && typeof value === "object") {
    return String(value.id || "").trim();
  }
  return "";
}

function paymentPageState(data = {}) {
  const pi = data.payment_intent;
  const piId =
    typeof pi === "string"
      ? pi
      : String(pi?.id || data.payment_intent_id || "").trim();
  const piStatus = String(
    (typeof pi === "object" && pi?.status) || data.payment_object_status || "",
  ).trim();
  const status = String(data.status || data.payment_page_status || "").trim();
  return {
    status,
    paymentObjectStatus: piStatus,
    paymentIntentId: piId,
    clientSecret: String(
      data.client_secret ||
        (typeof pi === "object" && pi?.client_secret) ||
        "",
    ).trim(),
    succeeded: /succeed/i.test(piStatus) || /succeed/i.test(status),
    requiresAction: /requires_action/i.test(piStatus),
    declined:
      /requires_payment_method|canceled|failed/i.test(piStatus) ||
      Boolean(data.error || data.last_payment_error),
  };
}

function buildElementsSessionForm({
  publishableKey,
  stripeVersion,
  sessionId,
  amount,
  currency,
  clientMode,
  pmcId = "",
  stripeJsId,
  locale = "en",
}) {
  const params = new URLSearchParams();
  const mode = clientMode === "payment" ? "payment" : "subscription";
  const cur = String(currency || "usd").toLowerCase();
  const pairs = [
    ["type", "deferred_intent"],
    ["deferred_intent[mode]", mode],
    ["deferred_intent[amount]", String(amount || 0)],
    ["deferred_intent[currency]", cur],
    ["deferred_intent[payment_method_types][0]", "card"],
    ["currency", cur],
    ["elements_init_source", "custom_checkout"],
    ["referrer_host", "chatgpt.com"],
    ["stripe_js_id", stripeJsId],
    ["locale", locale],
    ["checkout_session_id", sessionId],
    ["key", publishableKey],
    ["_stripe_version", stripeVersion],
  ];
  if (mode === "subscription") {
    pairs.splice(4, 0, ["deferred_intent[setup_future_usage]", "off_session"]);
  }
  if (pmcId) {
    pairs.push(["deferred_intent[payment_method_configuration][id]", pmcId]);
  }
  for (const [key, value] of pairs) params.append(key, value);
  return params;
}

function buildPaymentPageConfirmForm({
  confirmationToken,
  publishableKey,
  stripeVersion,
  expectedAmount,
  guid = "",
  muid = "",
  sid = "",
}) {
  const params = new URLSearchParams();
  const pairs = [
    ["confirmation_token", confirmationToken],
    ["key", publishableKey],
    ["_stripe_version", stripeVersion],
  ];
  if (expectedAmount) {
    pairs.push(["expected_amount", String(expectedAmount)]);
  }
  if (guid) pairs.push(["guid", guid]);
  if (muid) pairs.push(["muid", muid]);
  if (sid) pairs.push(["sid", sid]);
  for (const [key, value] of pairs) {
    if (value !== undefined && value !== null && value !== "") {
      params.append(key, value);
    }
  }
  return params;
}

async function stripeRequest(url, { method = "GET", body, headers, timeout = 30000, responseType } = {}) {
  const axios = getAxios();
  try {
    const response = await axios({
      url,
      method,
      headers: headers || stripeHeaders(),
      data: body,
      timeout,
      validateStatus: () => true,
      maxRedirects: 5,
      responseType,
    });
    const data = response.data;
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      data:
        typeof data === "object" && data !== null
          ? data
          : parseJsonBody(String(data || "")),
      text: typeof data === "string" ? data : "",
      headers: response.headers || {},
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      data: {},
      text: "",
      headers: {},
      error: String(err.message || err),
    };
  }
}

async function retrievePaymentPage(sessionId, pk, stripeVersion) {
  const params = new URLSearchParams();
  params.append("key", pk);
  params.append("_stripe_version", stripeVersion);
  return stripeRequest(
    `${STRIPE_API_BASE}/payment_pages/${encodeURIComponent(sessionId)}?${params}`,
    { method: "GET", headers: stripeHeaders() },
  );
}

async function resolveHostedPublishableKey({
  sessionId,
  preferredKey,
  stripeVersion,
  progress,
}) {
  const keys = hostedPublishableKeyCandidates(preferredKey);
  for (const key of keys) {
    const result = await retrievePaymentPage(sessionId, key, stripeVersion);
    const detail = String(result.data?.error?.message || result.error || "").slice(
      0,
      180,
    );
    progress(
      `hosted: 探测 payment_page pk=${pkPrefix(key)} http=${result.status}${detail ? ` ${detail}` : ""}`,
    );
    if (result.ok) return { pk: key, page: result.data || {} };
  }
  return { pk: preferredKey, page: null };
}

async function fetchStripeDeployStatus() {
  const result = await stripeRequest(STRIPE_JS_DEPLOY_STATUS, {
    method: "GET",
    headers: { Accept: "application/json" },
    timeout: 15000,
  });
  return result.data || {};
}

async function initPaymentPage(sessionId, { publishableKey = "", progress } = {}) {
  const sid = String(sessionId || "").trim();
  const pageUrl = `${CHECKOUT_STRIPE_ORIGIN}/c/pay/${sid}`;
  const initUrl = `${CHECKOUT_STRIPE_ORIGIN}/api/payment-page/${encodeURIComponent(sid)}/init`;
  let cookieHeader = "";
  let html = "";

  const pageResult = await stripeRequest(pageUrl, {
    method: "GET",
    headers: {
      Accept: "text/html,application/xhtml+xml",
      "Accept-Language": "en-US,en;q=0.9",
      "User-Agent": STRIPE_UA,
    },
    timeout: 30000,
    responseType: "text",
  });
  html = pageResult.text || (typeof pageResult.data === "string" ? pageResult.data : "");
  cookieHeader = cookieHeaderFromAxios(pageResult.headers);
  progress(
    `hosted: checkout 页 http=${pageResult.status} cookies=${cookieHeader ? cookieHeader.split("; ").length : 0} html=${html.length}B`,
  );

  const fromHtml = extractPaymentPageInitFromHtml(html);
  const attempts = [
    checkoutPageHeaders(sid, cookieHeader ? { Cookie: cookieHeader } : {}),
    checkoutPageHeaders(sid, {
      Origin: CHECKOUT_STRIPE_ORIGIN,
      ...(cookieHeader ? { Cookie: cookieHeader } : {}),
    }),
  ];
  const keyQuery = String(
    publishableKey || fromHtml?.publishable_key || "",
  ).trim();
  const urls = keyQuery
    ? [`${initUrl}?key=${encodeURIComponent(keyQuery)}`, initUrl]
    : [initUrl];

  for (const url of urls) {
    for (const headers of attempts) {
      const result = await stripeRequest(url, {
        method: "GET",
        headers,
        timeout: 30000,
      });
      progress(`hosted: payment-page init http=${result.status}`);
      if (result.ok) {
        return { ...result, html, cookieHeader };
      }
    }
  }

  if (fromHtml) {
    progress(
      `hosted: 从 checkout HTML 提取 init checksum=${fromHtml.init_checksum ? "yes" : "no"} pk=${fromHtml.publishable_key ? "yes" : "no"}`,
    );
    return { ok: true, status: 200, data: fromHtml, html, cookieHeader };
  }

  return {
    ok: false,
    status: pageResult.status || 403,
    data: { error: "payment-page init 失败，无 HTML 可提取" },
    html,
    cookieHeader,
  };
}

async function tryHostedApprove({
  page,
  accessToken,
  accountId,
  sessionId,
  processorEntity,
  progress,
}) {
  const referer = `${PLATFORM_BASE}/checkout/${processorEntity}/${sessionId}`;
  const headers = {
    accept: "application/json",
    authorization: `Bearer ${String(accessToken || "").trim()}`,
    "content-type": "application/json",
  };
  if (accountId) {
    headers["chatgpt-account-id"] = accountId;
    headers["openai-account-id"] = accountId;
  }
  let approveHeaders = headers;
  try {
    const challenge = await collectProtocolApiHeaders({
      page,
      accessToken,
      accountId,
      flow: "checkout_session_approval",
      targetPath: APPROVE_PATH,
      referer,
    });
    approveHeaders = challenge.headers;
  } catch (err) {
    progress(
      `hosted: approve 风控跳过 ${String((err && err.message) || err).slice(0, 80)}`,
    );
  }
  const result = await postSameOriginJson(page, {
    path: APPROVE_PATH,
    payload: { checkout_session_id: sessionId },
    headers: approveHeaders,
    referer,
  });
  progress(`hosted: approve http=${result.status}`);
  return result;
}

async function completeHostedStripeConfirm({
  page,
  sessionId,
  card,
  billing,
  publishableKey,
  stripeCustomer,
  amountTotal,
  dueAmount,
  dueCurrency,
  holderName,
  accessToken,
  accountId,
  processorEntity,
  creditsPurchase,
  progress,
}) {
  const locale = "en";
  const stripeJsId = crypto.randomUUID();
  const clientMode = resolveProtocolClientMode(billing);
  const minor = Math.round(Number(amountTotal || dueAmount * 100) || 0);

  progress("hosted: 初始化 Payment Page");
  const initResult = await initPaymentPage(sessionId, {
    publishableKey,
    progress,
  });
  if (!initResult.ok) {
    const detail = String(
      initResult.data?.error ||
        initResult.data?.message ||
        formatApiError(initResult.status, initResult.data) ||
        "",
    ).trim();
    progress(
      `hosted: init 跳过，继续 elements/sessions http=${initResult.status} ${detail.slice(0, 180)}`,
    );
  }
  const initData = initResult.data || {};
  const checkoutConfigId = String(
    initData.checkout_config_id ||
      initData.checkoutConfigId ||
      findIn(initData, ["checkout_config_id", "checkoutConfigId"]) ||
      "",
  ).trim();
  const pmcId =
    asNestedId(initData.payment_method_configuration) ||
    asNestedId(initData.config?.payment_method_configuration) ||
    findIn(initData, ["payment_method_configuration"]);
  const deploy = await fetchStripeDeployStatus();
  const stripeVersion = hostedStripeVersion(deploy);
  progress(`hosted: Stripe.js 部署 ${stripeVersion}`);
  const probed = await resolveHostedPublishableKey({
    sessionId,
    preferredKey: publishableKey,
    stripeVersion,
    progress,
  });
  const pk = probed.pk || publishableKey;
  progress(`hosted: 使用 pk=${pkPrefix(pk)}`);

  progress("hosted: Elements Session");
  let elementsResult = await stripeRequest(
    `${STRIPE_API_BASE}/elements/sessions`,
    {
      method: "POST",
      headers: stripeHeaders(),
      body: buildElementsSessionForm({
        publishableKey: pk,
        stripeVersion,
        sessionId,
        amount: minor,
        currency: billing.currency,
        clientMode,
        pmcId,
        stripeJsId,
        locale,
      }).toString(),
    },
  );
  if (!elementsResult.ok) {
    const qs = buildElementsSessionForm({
      publishableKey: pk,
      stripeVersion,
      sessionId,
      amount: minor,
      currency: billing.currency,
      clientMode,
      pmcId,
      stripeJsId,
      locale,
    });
    elementsResult = await stripeRequest(
      `${STRIPE_API_BASE}/elements/sessions?${qs}`,
      { method: "GET", headers: stripeHeaders(), timeout: 20000 },
    );
  }
  progress(
    `hosted: Elements Session http=${elementsResult.status} ok=${elementsResult.ok}`,
  );
  const elementsData = elementsResult.data || {};
  const elementsSessionId = elementsResult.ok
    ? String(
        elementsData.elements_session_id ||
          elementsData.session_id ||
          findIn(elementsData, ["elements_session_id", "session_id"]) ||
          "",
      ).trim()
    : "";
  const elementsConfigId = String(
    elementsData.config_id ||
      elementsData.session_config_id ||
      checkoutConfigId ||
      "",
  ).trim();

  progress("hosted: 令牌化卡片");
  let confirmToken;
  try {
    confirmToken = await createConfirmationToken({
      card,
      billing,
      publishableKey: pk,
      stripeCustomer,
      hosted: true,
      stripeVersion,
      elementsSessionId,
      elementsConfigId,
    });
  } catch (error) {
    return {
      success: false,
      declined: Boolean(error?.declined),
      fallback: !error?.declined,
      holderName,
      dueAmount,
      dueCurrency,
      error: String(error.message || error),
    };
  }
  progress(`hosted: 令牌化完成 ${String(confirmToken).slice(0, 12)}`);

  const confirmForm = buildPaymentPageConfirmForm({
    confirmationToken: confirmToken,
    publishableKey: pk,
    stripeVersion,
    expectedAmount: minor,
    guid: stripeDeviceId(true),
    muid: stripeDeviceId(true),
    sid: stripeDeviceId(true),
  });
  progress("hosted: payment_pages/confirm");
  const confirmResult = await stripeRequest(
    `${STRIPE_API_BASE}/payment_pages/${encodeURIComponent(sessionId)}/confirm`,
    {
      method: "POST",
      headers: stripeHeaders(),
      body: confirmForm.toString(),
    },
  );
  let state = paymentPageState(confirmResult.data);
  const confirmError = confirmResult.data?.error || {};
  progress(
    `hosted: confirm http=${confirmResult.status} status=${state.status} pi=${state.paymentObjectStatus} ${String(confirmError.message || "").slice(0, 120)}`,
  );
  if (
    confirmResult.status === 404 ||
    confirmError.code === "resource_missing"
  ) {
    return {
      success: false,
      fallback: true,
      holderName,
      dueAmount,
      dueCurrency,
      error:
        confirmError.message ||
        `payment_pages 不存在该 session (${pkPrefix(pk)})`,
    };
  }
  if (state.declined && !state.succeeded) {
    return {
      success: false,
      declined: true,
      holderName,
      dueAmount,
      dueCurrency,
      error: stripeDeclineMessage(confirmError),
    };
  }

  const pollForm = new URLSearchParams();
  pollForm.append("key", pk);
  pollForm.append("_stripe_version", stripeVersion);
  const pollDeadline = Date.now() + 60000;
  let approved = false;
  while (
    !state.succeeded &&
    !state.requiresAction &&
    !state.declined &&
    Date.now() < pollDeadline
  ) {
    if (!approved && /open|requires_approval/i.test(state.status)) {
      await tryHostedApprove({
        page,
        accessToken,
        accountId,
        sessionId,
        processorEntity,
        progress,
      });
      approved = true;
    }
    await sleepMs(2500);
    const pollResult = await stripeRequest(
      `${STRIPE_API_BASE}/payment_pages/${encodeURIComponent(sessionId)}/poll`,
      {
        method: "POST",
        headers: stripeHeaders(),
        body: pollForm.toString(),
      },
    );
    state = paymentPageState(pollResult.data);
    progress(`hosted: poll status=${state.status} pi=${state.paymentObjectStatus}`);
  }

  if (state.succeeded) {
    const returnUrl = `${PLATFORM_BASE}/checkout/verify?stripe_session_id=${encodeURIComponent(sessionId)}&processor_entity=${encodeURIComponent(processorEntity)}`;
    try {
      const verifyPath = toSameOriginPath(returnUrl);
      if (verifyPath) {
        progress(`hosted: 回调 Verify ${verifyPath}`);
        await getSameOriginJson(page, {
          path: verifyPath,
          headers: {
            accept: "application/json",
            authorization: `Bearer ${accessToken}`,
          },
        });
      }
      if (accountId && !creditsPurchase) {
        await getSameOriginJson(page, {
          path: `${SUBSCRIPTIONS_PATH}?account_id=${encodeURIComponent(accountId)}`,
          headers: {
            accept: "application/json",
            authorization: `Bearer ${accessToken}`,
            "chatgpt-account-id": accountId,
            "openai-account-id": accountId,
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
      dueCurrency,
      returnUrl,
      creditsPurchase,
    };
  }
  if (state.requiresAction) {
    return {
      success: false,
      actionRequired: true,
      fallback: true,
      holderName,
      dueAmount,
      dueCurrency,
      error: "需要完成银行卡 3D Secure 验证",
    };
  }
  if (state.declined) {
    return {
      success: false,
      declined: true,
      holderName,
      dueAmount,
      dueCurrency,
      error: "银行卡被拒绝",
    };
  }
  return {
    success: false,
    fallback: true,
    holderName,
    dueAmount,
    dueCurrency,
    error: `hosted 未完成: status=${state.status || "timeout"}`,
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
    if (typeof onProgress === "function") {
      try {
        onProgress(msg);
        return;
      } catch (_) {
        /* ignore */
      }
    }
    console.log(`[CheckoutProtocol] ${msg}`);
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
  const checkoutReferer = `${PLATFORM_BASE}/checkout/${ctx.processorEntity}/${ctx.sessionId}`;
  let taxHeaders = headers;
  try {
    const taxChallenge = await collectProtocolApiHeaders({
      page,
      accessToken: token,
      accountId: resolvedAccountId,
      flow: "chatgpt_checkout",
      targetPath: TAXES_PATH,
      referer: checkoutReferer,
    });
    taxHeaders = taxChallenge.headers;
    progress(
      `税费风控: flow=${taxChallenge.flow || "chatgpt_checkout"} sentinel=${taxChallenge.sentinelBytes}B attest=${taxChallenge.attestation ? "yes" : "no"} did=${taxChallenge.deviceId ? "yes" : "no"}`,
    );
  } catch (err) {
    progress(`税费风控跳过: ${String((err && err.message) || err).slice(0, 80)}`);
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
    headers: taxHeaders,
    referer: checkoutReferer,
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
  if (
    !isExpectedProtocolDueAmount(
      dueAmount,
      dueCurrency,
      ctx.planName || billing.planName,
    )
  ) {
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

  const hosted = isHostedStripeSession(ctx.sessionId, ctx.checkoutUrl);
  if (hosted) {
    progress(
      "走协议支付(hosted): taxes → init → elements → token → payment_pages/confirm → poll",
    );
    return completeHostedStripeConfirm({
      page,
      sessionId: ctx.sessionId,
      card: cardInfo,
      billing: {
        ...billing,
        name: holderName,
        country: String(billing.country || "US").toUpperCase(),
        state: normalizeUsStateCode(billing.state),
        currency: String(billing.currency || "usd").toLowerCase(),
      },
      publishableKey,
      stripeCustomer,
      amountTotal,
      dueAmount,
      dueCurrency,
      holderName,
      accessToken: token,
      accountId: resolvedAccountId,
      processorEntity: ctx.processorEntity,
      creditsPurchase: Boolean(
        billing.credits === true ||
          isCreditsProtocolPlan(billing.planName || ctx.planName),
      ),
      progress,
    });
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

  const referer = checkoutReferer;
  progress("确认 Checkout...");
  let confirmHeaders = headers;
  try {
    const confirmChallenge = await collectProtocolApiHeaders({
      page,
      accessToken: token,
      accountId: resolvedAccountId,
      flow: "checkout_session_approval",
      targetPath: CONFIRM_PATH,
      referer,
    });
    confirmHeaders = confirmChallenge.headers;
    progress(
      `确认风控: flow=${confirmChallenge.flow || "checkout_session_approval"} sentinel=${confirmChallenge.sentinelBytes}B attest=${confirmChallenge.attestation ? "yes" : "no"}`,
    );
  } catch (err) {
    progress(`确认风控跳过: ${String((err && err.message) || err).slice(0, 80)}`);
  }
  const confirmResult = await postSameOriginJson(page, {
    path: CONFIRM_PATH,
    payload: buildConfirmPayload({
      sessionId: ctx.sessionId,
      confirmToken,
    }),
    headers: confirmHeaders,
    referer,
  });
  if (confirmResult.error && !confirmResult.bodyText) {
    return {
      success: false,
      fallback: true,
      error: confirmResult.error,
      holderName,
    };
  }
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
  const confirmReturnUrl = String(confirmData.confirm_return_url || "").trim();
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
      dueAmount,
      dueCurrency: String(billing.currency || "").toUpperCase(),
    };
  }

  const piId = clientSecret.split("_secret_")[0];
  const returnUrl =
    confirmReturnUrl ||
    `${PLATFORM_BASE}/checkout/verify?stripe_session_id=${encodeURIComponent(ctx.sessionId)}&processor_entity=${encodeURIComponent(ctx.processorEntity)}`;
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
    const verifyPath = toSameOriginPath(returnUrl);
    if (verifyPath) {
      progress(`回调 Verify: ${verifyPath}`);
      await getSameOriginJson(page, {
        path: verifyPath,
        headers: confirmHeaders,
      });
    } else {
      await page
        .goto(returnUrl, {
          waitUntil: "domcontentloaded",
          timeout: 30000,
        })
        .catch(() => {});
    }
    const creditsPurchase = Boolean(
      billing.credits === true ||
        isCreditsProtocolPlan(billing.planName || ctx.planName),
    );
    if (resolvedAccountId && !creditsPurchase) {
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
  stripeHeaders,
  toSameOriginPath,
  parseCardExpiry,
  normalizeCardForProtocol,
  buildTaxesPayload,
  buildConfirmPayload,
  buildConfirmationTokenForm,
  buildPaymentIntentConfirmForm,
  completeProtocolCheckout,
  isExpectedProtocolDueAmount,
  isHostedStripeSession,
  isCreditsProtocolPlan,
  resolveProtocolClientMode,
  buildElementsSessionForm,
  buildPaymentPageConfirmForm,
  paymentPageState,
};
