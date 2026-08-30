"use strict";

const axios = require("axios");
const { request: playwrightRequest } = require("playwright");
const {
  cancelAutoRenew,
  cancelAutoRenewAfterActivation,
  cancelAutoRenewWithBrowserPage,
  parseCodexQuotaPayload,
  parseAccountCheckResponse,
  prepareLiveChatGptSubscription,
  querySubscriptionBySession,
} = require("../subscription-check");

const ACCOUNT_ID = "acct-test-123";
const originalAdapter = axios.defaults.adapter;

function createToken() {
  const header = Buffer.from(
    JSON.stringify({ alg: "RS256", typ: "JWT" }),
  ).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      exp: Math.floor(Date.now() / 1000) + 3600,
      "https://api.openai.com/auth": {
        chatgpt_account_id: ACCOUNT_ID,
      },
      "https://api.openai.com/profile": {
        email: "user@example.com",
      },
    }),
  ).toString("base64url");
  return `${header}.${payload}.signature`;
}

function response(status, data = {}) {
  return {
    status: () => status,
    json: async () => data,
    text: async () => JSON.stringify(data),
  };
}

function activeSubscription(autoRenew = true) {
  return {
    accounts: {
      default: {
        account: { account_id: ACCOUNT_ID },
        entitlement: {
          has_active_subscription: true,
          subscription_plan: "chatgptplusplan",
        },
        last_active_subscription: {
          will_renew: autoRenew,
          purchase_origin_platform: "stripe",
        },
      },
    },
  };
}

describe("subscription cancellation", () => {
  afterEach(() => {
    axios.defaults.adapter = originalAdapter;
    vi.restoreAllMocks();
  });

  it.each([200, 204])(
    "sends account headers and accepts HTTP %i after activation",
    async (status) => {
      let requestConfig;
      axios.defaults.adapter = async (config) => {
        requestConfig = config;
        return {
          status,
          statusText: "",
          headers: {},
          config,
          data: {},
        };
      };

      const result = await cancelAutoRenewAfterActivation(createToken(), {
        accountId: ACCOUNT_ID,
        maxAttempts: 1,
      });

      expect(result.ok).toBe(true);
      expect(requestConfig.url).toBe(
        "https://chatgpt.com/backend-api/subscriptions/cancel",
      );
      expect(requestConfig.method).toBe("post");
      expect(requestConfig.headers.get("chatgpt-account-id")).toBe(ACCOUNT_ID);
      expect(requestConfig.headers.get("openai-account-id")).toBe(ACCOUNT_ID);
      expect(JSON.parse(requestConfig.data)).toEqual({
        account_id: ACCOUNT_ID,
      });
    },
  );

  it("returns a session error for HTTP 401 without retrying", async () => {
    const adapter = vi.fn(async (config) => ({
      status: 401,
      statusText: "Unauthorized",
      headers: {},
      config,
      data: { error: "invalid_session" },
    }));
    axios.defaults.adapter = adapter;

    const result = await cancelAutoRenewAfterActivation(createToken(), {
      accountId: ACCOUNT_ID,
      maxAttempts: 2,
    });

    expect(result).toMatchObject({ ok: false, statusCode: 401 });
    expect(result.error).toContain("Session");
    expect(adapter).toHaveBeenCalledTimes(1);
  });

  it("reports an upstream-revoked access token separately", async () => {
    vi.spyOn(playwrightRequest, "newContext").mockResolvedValue({
      get: vi.fn().mockResolvedValue(
        response(401, {
          error: { code: "token_expired" },
          detail: { code: "token_expired" },
        }),
      ),
      dispose: vi.fn().mockResolvedValue(),
    });

    const result = await querySubscriptionBySession(createToken());

    expect(result).toMatchObject({ ok: false, statusCode: 401 });
    expect(result.error).toContain("Session Cookie 仍有效");
    expect(result.error).toContain("AccessToken");
  });

  it("uses the active browser page to cancel with its session cookies", async () => {
    const evaluate = vi.fn().mockResolvedValue({ status: 200, data: {} });
    const result = await cancelAutoRenewWithBrowserPage(
      { isClosed: () => false, evaluate },
      { accountId: ACCOUNT_ID },
    );

    expect(result).toMatchObject({ ok: true, data: { cancelled: true } });
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(evaluate.mock.calls[0][1]).toEqual({
      url: "https://chatgpt.com/backend-api/subscriptions/cancel",
      targetAccountId: ACCOUNT_ID,
      token: "",
    });
  });

  it("falls back to the browser context request when page fetch is unavailable", async () => {
    const post = vi.fn().mockResolvedValue(response(200, {}));
    const evaluate = vi.fn();
    const result = await cancelAutoRenewWithBrowserPage(
      {
        isClosed: () => false,
        context: () => ({ request: { post } }),
        evaluate,
      },
      { accountId: ACCOUNT_ID },
    );

    expect(result).toMatchObject({
      ok: true,
      data: { cancelled: true, via: "browser-context" },
    });
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0][1]).toMatchObject({
      data: { account_id: ACCOUNT_ID },
    });
    expect(evaluate).toHaveBeenCalledTimes(1);
  });

  it("uses page fetch before the browser context request", async () => {
    const post = vi.fn().mockResolvedValue(response(401, {}));
    const evaluate = vi.fn().mockResolvedValue({
      status: 200,
      data: {},
      via: "page-fetch",
    });
    const result = await cancelAutoRenewWithBrowserPage(
      {
        isClosed: () => false,
        context: () => ({ request: { post } }),
        evaluate,
      },
      { accountId: ACCOUNT_ID },
    );

    expect(result).toMatchObject({
      ok: true,
      data: { cancelled: true, via: "page-fetch" },
    });
    expect(post).not.toHaveBeenCalled();
    expect(evaluate).toHaveBeenCalledTimes(1);
  });

  it("refreshes the live token after page cancellation returns 401", async () => {
    const freshToken = createToken() + "fresh";
    const evaluate = vi
      .fn()
      .mockResolvedValueOnce({ status: 401, data: { error: "expired" } })
      .mockResolvedValueOnce({ status: 401, data: { error: "expired" } })
      .mockResolvedValueOnce({ status: 200, data: {}, via: "page-fetch" })
      .mockResolvedValueOnce({
        status: 200,
        data: activeSubscription(false),
        via: "page-fetch",
      });
    const refreshAccessToken = vi.fn().mockResolvedValue(freshToken);

    const result = await cancelAutoRenewWithBrowserPage(
      { isClosed: () => false, evaluate, waitForTimeout: vi.fn() },
      {
        accountId: ACCOUNT_ID,
        accessToken: createToken(),
        maxAttempts: 2,
        delayMs: 0,
        refreshAccessToken,
      },
    );

    expect(result).toMatchObject({ ok: true, data: { cancelled: true } });
    expect(refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(evaluate.mock.calls[2][1].token).toBe(freshToken);
  });

  it("does not keep retrying 401 when the access token does not change", async () => {
    const token = createToken();
    const evaluate = vi.fn().mockResolvedValue({
      status: 401,
      data: {
        error: { code: "token_expired" },
        detail: { code: "token_expired" },
      },
    });
    const result = await cancelAutoRenewWithBrowserPage(
      { isClosed: () => false, evaluate },
      {
        accountId: ACCOUNT_ID,
        accessToken: token,
        maxAttempts: 4,
        delayMs: 0,
        refreshAccessToken: async () => token,
      },
    );

    expect(result).toMatchObject({ ok: false, statusCode: 401 });
    expect(result.error).toContain("AccessToken");
    expect(evaluate.mock.calls.length).toBeLessThan(4);
  });

  it("retries when the subscription has not propagated after payment", async () => {
    const evaluate = vi
      .fn()
      .mockResolvedValueOnce({
        status: 404,
        data: { detail: "no active subscription found for account" },
      })
      .mockResolvedValueOnce({ status: 200, data: {} });
    const result = await cancelAutoRenewWithBrowserPage(
      { isClosed: () => false, evaluate },
      { accountId: ACCOUNT_ID, maxAttempts: 2, delayMs: 0 },
    );

    expect(result).toMatchObject({ ok: true, data: { cancelled: true } });
    expect(evaluate).toHaveBeenCalledTimes(2);
  });

  it("stops after the configured retry limit when propagation remains incomplete", async () => {
    const evaluate = vi.fn().mockResolvedValue({
      status: 404,
      data: { detail: "no active subscription found for account" },
    });

    const result = await cancelAutoRenewWithBrowserPage(
      { isClosed: () => false, evaluate },
      { accountId: ACCOUNT_ID, maxAttempts: 3, delayMs: 0 },
    );

    expect(result).toMatchObject({ ok: false, statusCode: 404 });
    expect(evaluate).toHaveBeenCalledTimes(3);
  });

  it("does not fall back to AccessToken when cancel returns 404", async () => {
    const evaluate = vi.fn().mockResolvedValue({
      status: 404,
      data: { detail: "no active subscription found for account" },
    });
    const newContext = vi.spyOn(playwrightRequest, "newContext");

    const result = await cancelAutoRenewWithBrowserPage(
      { isClosed: () => false, evaluate },
      {
        accountId: ACCOUNT_ID,
        accessToken: createToken(),
        maxAttempts: 3,
        delayMs: 0,
        fallbackAttempts: 1,
      },
    );

    expect(result).toMatchObject({ ok: false, statusCode: 404 });
    expect(evaluate).toHaveBeenCalledTimes(3);
    expect(newContext).not.toHaveBeenCalled();
  });

  it("falls back to the access token after a browser 401", async () => {
    const evaluate = vi.fn().mockResolvedValue({
      status: 401,
      data: { error: "invalid_session" },
    });
    axios.defaults.adapter = async (config) => ({
      status: 200,
      statusText: "OK",
      headers: {},
      config,
      data: {},
    });
    const get = vi
      .fn()
      .mockResolvedValue(response(200, activeSubscription(false)));
    vi.spyOn(playwrightRequest, "newContext").mockResolvedValue({
      get,
      dispose: vi.fn().mockResolvedValue(),
    });

    const result = await cancelAutoRenewWithBrowserPage(
      { isClosed: () => false, evaluate },
      {
        accountId: ACCOUNT_ID,
        accessToken: createToken(),
        maxAttempts: 1,
        fallbackAttempts: 1,
        verifyAttempts: 1,
      },
    );

    expect(result).toMatchObject({
      ok: true,
      data: {
        cancelled: true,
        confirmed: true,
        via: "token-fallback",
      },
    });
  });

  it("returns a mapped forbidden error for HTTP 403", async () => {
    axios.defaults.adapter = async (config) => ({
      status: 403,
      statusText: "Forbidden",
      headers: {},
      config,
      data: { error: "forbidden" },
    });
    vi.spyOn(playwrightRequest, "newContext").mockResolvedValue({
      fetch: vi.fn().mockResolvedValue(response(403, { error: "forbidden" })),
      dispose: vi.fn().mockResolvedValue(),
    });

    const result = await cancelAutoRenewAfterActivation(createToken(), {
      accountId: ACCOUNT_ID,
      maxAttempts: 1,
    });

    expect(result).toMatchObject({ ok: false, statusCode: 403 });
    expect(result.error).toContain("OpenAI 拒绝访问");
  });

  it("does not call the cancellation endpoint when renewal is already disabled", async () => {
    const get = vi
      .fn()
      .mockResolvedValue(response(200, activeSubscription(false)));
    vi.spyOn(playwrightRequest, "newContext").mockResolvedValue({
      get,
      dispose: vi.fn().mockResolvedValue(),
    });
    const adapter = vi.fn();
    axios.defaults.adapter = adapter;

    const result = await cancelAutoRenew(createToken(), {
      accountId: ACCOUNT_ID,
    });

    expect(result).toMatchObject({
      ok: true,
      data: { alreadyCancelled: true },
    });
    expect(adapter).not.toHaveBeenCalled();
  });

  it("reports pending confirmation when renewal status has not updated yet", async () => {
    const get = vi
      .fn()
      .mockResolvedValue(response(200, activeSubscription(true)));
    const fetch = vi.fn().mockResolvedValue(response(200, {}));
    vi.spyOn(playwrightRequest, "newContext").mockResolvedValue({
      get,
      fetch,
      dispose: vi.fn().mockResolvedValue(),
    });

    const result = await cancelAutoRenew(createToken(), {
      accountId: ACCOUNT_ID,
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledTimes(4);
    expect(result).toMatchObject({ ok: true, data: { cancelled: true } });
    expect(result.data.message).toContain("请稍后刷新确认状态");
  });
});

describe("account status parsing", () => {
  it("parses subscription and Codex quota windows", () => {
    const account = parseAccountCheckResponse(activeSubscription(true), {
      email: "user@example.com",
      accountId: ACCOUNT_ID,
    });
    expect(account).toMatchObject({
      email: "user@example.com",
      plan: "ChatGPT Plus",
      hasActiveSubscription: true,
      autoRenew: "是",
      accountStatus: "已订阅",
    });

    const quota = parseCodexQuotaPayload({
      rate_limit: {
        primary_window: {
          used: 12,
          limit: 80,
          remaining: 68,
          reset_at: "2026-08-28T18:30:45.000Z",
          reset_after_seconds: 18000,
          limit_window_seconds: 18000,
        },
        secondary_window: {
          used: 120,
          limit: 1000,
          remaining: 880,
          limit_window_seconds: 604800,
        },
      },
      available_count: 1,
      credits: [
        {
          id: "credit-1",
          status: "available",
          title: "Rate limit reset",
          description: "Expires soon",
        },
      ],
    });
    expect(quota.status).toBe("已读取");
    expect(quota.canReset).toBe(true);
    expect(quota.resetCredits).toHaveLength(1);
    expect(quota.windows.map((item) => item.windowLabel)).toEqual([
      "5小时额度",
      "周额度",
    ]);
    expect(quota.windows[0].resetAtText).toMatch(
      /^\d{2}\/\d{2} \d{2}:\d{2} \(5h\)$/,
    );
    expect(quota.windows[0].resetAtText).not.toMatch(/1970|秒/);
    expect(quota.windows[1].resetAtText).toBe("—");
  });

  it("prefers an active Plus account over a free default account", () => {
    const account = parseAccountCheckResponse(
      {
        accounts: {
          default: {
            account: { account_id: "acct-free" },
            entitlement: {
              has_active_subscription: false,
              subscription_plan: "free",
            },
          },
          personal: {
            account: { account_id: ACCOUNT_ID },
            entitlement: {
              has_active_subscription: true,
              subscription_plan: "chatgptplusplan",
            },
            last_active_subscription: {
              will_renew: true,
              purchase_origin_platform: "stripe",
            },
          },
        },
      },
      { accountId: ACCOUNT_ID },
    );
    expect(account).toMatchObject({
      accountId: ACCOUNT_ID,
      plan: "ChatGPT Plus",
      hasActiveSubscription: true,
    });
  });
});

describe("live ChatGPT subscription sync", () => {
  it("opens the main page, reloads, and confirms an active Plus subscription", async () => {
    const token = createToken();
    const evaluate = vi
      .fn()
      .mockResolvedValueOnce({
        status: 200,
        data: { accessToken: token },
      })
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce({
        status: 200,
        data: activeSubscription(true),
        via: "page-fetch",
      });
    const page = {
      isClosed: () => false,
      goto: vi.fn().mockResolvedValue(),
      reload: vi.fn().mockResolvedValue(),
      waitForTimeout: vi.fn().mockResolvedValue(),
      evaluate,
    };

    const result = await prepareLiveChatGptSubscription(page, {
      accessToken: "old-token",
      requireActive: true,
      maxAttempts: 1,
      onStatus: () => {},
    });

    expect(page.goto).toHaveBeenCalledWith("https://chatgpt.com/", {
      waitUntil: "domcontentloaded",
      timeout: 90000,
    });
    expect(page.reload).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      synced: true,
      accessToken: token,
    });
    expect(result.status.data.hasActiveSubscription).toBe(true);
  });

  it("treats cookie-only account-check Plus as synced when the bearer token still says free", async () => {
    const token = createToken();
    const evaluate = vi
      .fn()
      .mockResolvedValueOnce({
        status: 200,
        data: { accessToken: token },
      })
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce({
        status: 200,
        data: {
          accounts: {
            default: {
              account: { account_id: ACCOUNT_ID },
              entitlement: {
                has_active_subscription: false,
                subscription_plan: "free",
              },
            },
          },
        },
        via: "page-fetch",
      })
      .mockResolvedValueOnce({
        status: 200,
        data: activeSubscription(true),
        via: "page-fetch",
      });
    const page = {
      isClosed: () => false,
      goto: vi.fn().mockResolvedValue(),
      reload: vi.fn().mockResolvedValue(),
      waitForTimeout: vi.fn().mockResolvedValue(),
      evaluate,
    };

    const result = await prepareLiveChatGptSubscription(page, {
      accessToken: token,
      accountId: ACCOUNT_ID,
      requireActive: true,
      maxAttempts: 1,
      onStatus: () => {},
    });

    expect(result.synced).toBe(true);
    expect(result.status.data.hasActiveSubscription).toBe(true);
    expect(evaluate).toHaveBeenCalledTimes(4);
  });

  it("stops immediately when the live page account check is blocked", async () => {
    const token = createToken();
    const evaluate = vi
      .fn()
      .mockResolvedValueOnce({
        status: 200,
        data: { accessToken: token },
      })
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce({
        status: 403,
        data: "<html>Cloudflare attention required</html>",
        via: "page-fetch",
      });
    const page = {
      isClosed: () => false,
      goto: vi.fn().mockResolvedValue(),
      reload: vi.fn().mockResolvedValue(),
      waitForTimeout: vi.fn().mockResolvedValue(),
      evaluate,
    };

    const result = await prepareLiveChatGptSubscription(page, {
      accessToken: token,
      requireActive: false,
      maxAttempts: 4,
      onStatus: () => {},
    });

    expect(result.synced).toBe(false);
    expect(result.status).toMatchObject({
      ok: false,
      statusCode: 403,
    });
    expect(result.status.error).toContain("Cloudflare");
    expect(page.waitForTimeout).toHaveBeenCalledTimes(2);
  });
});

describe("browser cancel payment note", () => {
  it("does not append the payment-success note on account-page 401 fallback", async () => {
    const evaluate = vi.fn().mockResolvedValue({
      status: 401,
      data: {
        error: { code: "token_expired" },
        detail: { code: "token_expired" },
      },
    });
    axios.defaults.adapter = async (config) => ({
      status: 401,
      statusText: "Unauthorized",
      headers: {},
      config,
      data: {
        error: { code: "token_expired" },
        detail: { code: "token_expired" },
      },
    });
    vi.spyOn(playwrightRequest, "newContext").mockResolvedValue({
      get: vi.fn().mockResolvedValue(
        response(401, {
          error: { code: "token_expired" },
          detail: { code: "token_expired" },
        }),
      ),
      post: vi.fn().mockResolvedValue(
        response(401, {
          error: { code: "token_expired" },
          detail: { code: "token_expired" },
        }),
      ),
      dispose: vi.fn().mockResolvedValue(),
    });

    const result = await cancelAutoRenewWithBrowserPage(
      { isClosed: () => false, evaluate },
      {
        accountId: ACCOUNT_ID,
        accessToken: createToken(),
        maxAttempts: 1,
        fallbackAttempts: 1,
        verifyAttempts: 1,
      },
    );

    expect(result.ok).toBe(false);
    expect(result.statusCode).toBe(401);
    expect(result.error).not.toContain("支付已成功");
  });
});
