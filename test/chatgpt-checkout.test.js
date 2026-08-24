"use strict";

const { buildCheckoutHeaders, buildCheckoutPayload } = require("../chatgpt");

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
});
