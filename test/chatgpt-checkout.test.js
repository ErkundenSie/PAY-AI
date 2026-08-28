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
  extractHomepageMetadata,
  buildPhpCheckoutHeaders,
  shouldFallbackFromPhpCheckout,
  buildCheckoutSentinelReqBody,
  assembleCheckoutSentinelToken,
  isUsableCheckoutSentinel,
  isCreditsCheckoutPayload,
  buildCodexCreditPurchaseUrl,
  isCodexCreditPurchaseUrl,
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
      account_id: "acct-1",
      openai_account_id: "acct-1",
    });
  });

  it("builds Codex credit purchase payload", () => {
    const payload = buildCheckoutPayload(
      "chatgptbusiness_usage_based",
      "PH",
      "PHP",
      { accountId: "acct-1", creditQuantity: 1000 },
    );
    expect(payload).toEqual({
      entry_point: "codex_team_start",
      plan_name: "chatgptbusiness_usage_based",
      checkout_ui_mode: "custom",
      billing_details: { country: "PH", currency: "PHP" },
      usage_based_workspace_credit_purchase_data: {
        quantity: 1000,
        unit: "credit",
        workspace_name: "Codex Space",
        plan_type: "team",
        auto_top_up_enabled: true,
      },
      account_id: "acct-1",
      openai_account_id: "acct-1",
    });
  });

  it("detects credits checkout payloads", () => {
    const creditsPayload = buildCheckoutPayload(
      "chatgptbusiness_usage_based",
      "PH",
      "PHP",
      { accountId: "acct-1", creditQuantity: 500 },
    );
    const plusPayload = buildCheckoutPayload("chatgptplusplan", "PH", "PHP", {
      accountId: "acct-1",
    });

    expect(isCreditsCheckoutPayload(creditsPayload)).toBe(true);
    expect(isCreditsCheckoutPayload(plusPayload)).toBe(false);
  });

  it("builds the official Codex credit purchase URL", () => {
    const url = buildCodexCreditPurchaseUrl(2000, {
      source: "codex-embedded-checkout",
      autoTopUpEnabled: false,
    });
    expect(url).toBe(
      "https://chatgpt.com/codex/purchase/credits?quantity=2000&source=codex-embedded-checkout&auto_top_up_enabled=false",
    );
    expect(isCodexCreditPurchaseUrl(url)).toBe(true);
    expect(
      isCodexCreditPurchaseUrl(
        "https://chatgpt.com/codex/settings/analytics",
      ),
    ).toBe(false);
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

  it("extracts PHP checkout metadata from homepage html", () => {
    const meta = extractHomepageMetadata(
      '<html data-build="prod-123" data-seq="456">{"webDeploymentAttestation":"att-1"}</html>',
    );
    expect(meta).toEqual({
      clientVersion: "prod-123",
      clientBuild: "456",
      attestation: "att-1",
    });
  });

  it("builds PHP protocol checkout headers", () => {
    const headers = buildPhpCheckoutHeaders({
      token: "tok",
      accountId: "acct-1",
      deviceId: "did-1",
      clientVersion: "prod-123",
      attestation: "att-1",
      sentinel: '{"p":1}',
    });
    expect(headers.authorization).toBe("Bearer tok");
    expect(headers["chatgpt-account-id"]).toBe("acct-1");
    expect(headers["oai-device-id"]).toBe("did-1");
    expect(headers["oai-client-version"]).toBe("prod-123");
    expect(headers["openai-sentinel-token"]).toBe('{"p":1}');
    expect(headers["oai-telemetry"]).toBe("[1,null]");
    expect(headers.origin).toBe("https://chatgpt.com");
    expect(headers.referer).toBe("https://chatgpt.com/");
    expect(headers["x-openai-target-path"]).toBe(
      "/backend-api/payments/checkout",
    );
  });

  it("falls back from PHP protocol on unusual activity but not already subscribed", () => {
    expect(
      shouldFallbackFromPhpCheckout({
        ok: false,
        error: "unusual activity",
      }),
    ).toBe(true);
    expect(
      shouldFallbackFromPhpCheckout({
        ok: false,
        error: "already_subscribed",
      }),
    ).toBe(false);
    expect(
      shouldFallbackFromPhpCheckout({
        ok: false,
        error: "usage_based_workspace_credit_purchase_data is not enabled",
      }),
    ).toBe(false);
    expect(shouldFallbackFromPhpCheckout({ ok: true })).toBe(false);
  });

  it("builds chatgpt_checkout sentinel/req body with device id and proof token", () => {
    const body = buildCheckoutSentinelReqBody("did-1");
    expect(body.id).toBe("did-1");
    expect(body.flow).toBe("chatgpt_checkout");
    expect(body.p.startsWith("gAAAAAC")).toBe(true);
  });

  it("assembles p/t/c/id/flow sentinel token from req + challenge", () => {
    const token = assembleCheckoutSentinelToken(
      { p: "gAAAAACproof", id: "did-1", flow: "chatgpt_checkout" },
      { token: "c-token", t: "turnstile" },
      "",
    );
    expect(JSON.parse(token)).toEqual({
      p: "gAAAAACproof",
      t: "turnstile",
      c: "c-token",
      id: "did-1",
      flow: "chatgpt_checkout",
    });
  });

  it("solves proofofwork into gAAAAAB p without ~S", () => {
    const token = assembleCheckoutSentinelToken(
      { p: "gAAAAACproof", id: "did-1", flow: "chatgpt_checkout" },
      {
        token: "c-token",
        proofofwork: { required: true, seed: "seed", difficulty: "0" },
      },
      "",
    );
    const obj = JSON.parse(token);
    expect(obj.p.startsWith("gAAAAAB")).toBe(true);
    expect(obj.p.includes("~S")).toBe(false);
    expect(
      JSON.parse(Buffer.from(obj.p.slice(7), "base64").toString("utf8")),
    ).toHaveLength(25);
    expect(obj.c).toBe("c-token");
    expect(isUsableCheckoutSentinel(token)).toBe(true);
  });
});
