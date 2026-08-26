"use strict";

const {
  buildCheckoutHeaders,
  buildCheckoutPayload,
  extractAccountIdFromCheck,
  extractCheckoutPlan,
  summarizeCheckoutCookies,
  buildCheckoutWarmupRequests,
  resolveCheckoutModes,
  readRequestPostData,
} = require("../chatgpt");

describe("chatgpt checkout helpers", () => {
  it("matches the userscript checkout payload", () => {
    const payload = buildCheckoutPayload("chatgptplusplan", "PH", "PHP", {
      accountId: "acct-1",
    });
    expect(payload).toEqual({
      entry_point: "all_plans_pricing_modal",
      plan_name: "chatgptplusplan",
      checkout_ui_mode: "custom",
      billing_details: { country: "PH", currency: "PHP" },
      cancel_url: "https://chatgpt.com/",
      account_id: "acct-1",
      openai_account_id: "acct-1",
    });
  });

  it("adds account headers from the access token", () => {
    const header = Buffer.from(
      JSON.stringify({ alg: "RS256", typ: "JWT" }),
    ).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({
        "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" },
      }),
    ).toString("base64url");
    const token = `${header}.${payload}.sig`;
    const headers = buildCheckoutHeaders(token);
    expect(headers.Authorization).toBe(`Bearer ${token}`);
    expect(headers["chatgpt-account-id"]).toBe("acct-1");
    expect(headers["openai-account-id"]).toBe("acct-1");
  });

  it("reads account_id from accounts/check default account", () => {
    expect(
      extractAccountIdFromCheck({
        accounts: { default: { account: { account_id: "acct-check" } } },
      }),
    ).toBe("acct-check");
  });

  it("prefers the personal free account over a deactivated workspace plus plan", () => {
    const data = {
      accounts: {
        default: {
          account: {
            account_id: "acct-workspace",
            name: "Cronkshaw's Workspace",
            structure: "workspace",
            is_deactivated: true,
          },
          entitlement: {
            has_active_subscription: true,
            subscription_plan: "chatgptplusplan",
          },
        },
        personal: {
          account: {
            account_id: "acct-personal",
            name: "Cronkshaw 个人账户",
            structure: "personal",
          },
          entitlement: {
            has_active_subscription: false,
            subscription_plan: "free",
          },
        },
      },
    };
    expect(extractAccountIdFromCheck(data)).toBe("acct-personal");
    expect(extractCheckoutPlan(data)).toBe("");
    expect(resolveCheckoutModes(extractCheckoutPlan(data))).toEqual([
      "custom",
      "hosted",
    ]);
  });

  it("summarizes checkout cookies without values", () => {
    const summary = summarizeCheckoutCookies([
      { name: "oai-did" },
      { name: "__Secure-next-auth.session-token.0" },
      { name: "__Secure-next-auth.session-token.1" },
      { name: "cf_clearance" },
    ]);
    expect(summary.hasOaiDid).toBe(true);
    expect(summary.markers).toEqual([
      "oai-did",
      "cf_clearance",
      "session-token×2",
    ]);
  });

  it("warms countries and region pricing only", () => {
    const requests = buildCheckoutWarmupRequests({
      country: "PH",
      accountId: "acct-1",
    });
    expect(requests.map((item) => item.name)).toEqual(["countries", "PH"]);
    expect(requests[0].path).toBe(
      "/backend-api/checkout_pricing_config/countries",
    );
    expect(requests[1].path).toBe(
      "/backend-api/checkout_pricing_config/configs/PH",
    );
  });

  it("uses hosted only when the account already has a paid plan", () => {
    expect(resolveCheckoutModes("chatgptplusplan")).toEqual(["hosted"]);
    expect(resolveCheckoutModes("free")).toEqual(["custom", "hosted"]);
  });

  it("reads Playwright postData as a sync string", () => {
    expect(
      readRequestPostData({
        postData: () => '{"plan_name":"chatgptplusplan"}',
      }),
    ).toBe('{"plan_name":"chatgptplusplan"}');
    expect(readRequestPostData({ postData: () => null })).toBe("");
    expect(readRequestPostData({})).toBe("");
  });
});
