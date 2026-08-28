"use strict";

const axios = require("axios");
const { request: playwrightRequest } = require("playwright");
const {
  cancelAutoRenew,
  cancelAutoRenewAfterActivation,
  cancelAutoRenewWithBrowserPage,
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
    });
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
    expect(get).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ ok: true, data: { cancelled: true } });
    expect(result.data.message).toContain("请稍后刷新确认状态");
  });
});
