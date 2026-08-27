"use strict";

const {
  buildTaxesPayload,
  buildConfirmPayload,
  buildConfirmationTokenForm,
  parseCardExpiry,
  resolveProcessorEntity,
  canUseProtocolCheckout,
  extractCheckoutContext,
  hydrateCheckoutFromUrl,
  isExpectedProtocolDueAmount,
} = require("../checkout-protocol");

describe("checkout protocol helpers", () => {
  it("builds a taxes payload with US tax-free address", () => {
    expect(
      buildTaxesPayload({
        sessionId: "oaics_abc",
        email: "user@example.com",
        billingName: "Jane Doe",
        currency: "USD",
        processorEntity: "openai_llc",
        address: {
          line1: "123 Main St",
          city: "Portland",
          state: "Oregon",
          postal_code: "97201",
          country: "US",
        },
      }),
    ).toEqual({
      checkout_session_id: "oaics_abc",
      checkout_email: "user@example.com",
      billing_country: "US",
      billing_name: "Jane Doe",
      currency: "usd",
      processor_entity: "openai_llc",
      billing_address: {
        line1: "123 Main St",
        city: "Portland",
        country: "US",
        postal_code: "97201",
        state: "OR",
      },
    });
  });

  it("builds a confirm payload with the confirmation token", () => {
    expect(
      buildConfirmPayload({
        sessionId: "oaics_abc",
        confirmToken: "ctoken_123",
      }),
    ).toEqual({
      checkout_session_id: "oaics_abc",
      confirm_token: "ctoken_123",
      selected_payment_method_type: "card",
    });
  });

  it("parses MM/YY and MMYY card expiry", () => {
    expect(parseCardExpiry("12/28")).toEqual({
      exp_month: "12",
      exp_year: "2028",
    });
    expect(parseCardExpiry("1228")).toEqual({
      exp_month: "12",
      exp_year: "2028",
    });
  });

  it("uses checkout processor_entity before country fallback", () => {
    expect(
      resolveProcessorEntity("PH", { processor_entity: "openai_llc" }),
    ).toBe("openai_llc");
    expect(resolveProcessorEntity("US")).toBe("openai_llc");
    expect(resolveProcessorEntity("PH")).toBe("openai_ie");
  });

  it("skips protocol for hosted Stripe checkout", () => {
    expect(
      canUseProtocolCheckout(
        {
          sessionId: "cs_live_abc",
          checkoutUrl: "https://checkout.stripe.com/c/pay/cs_live_abc",
        },
        "token",
      ),
    ).toBe(false);
    expect(
      canUseProtocolCheckout(
        {
          sessionId: "oaics_abc",
          checkoutUrl: "https://chatgpt.com/checkout/openai_llc/oaics_abc",
        },
        "token",
      ),
    ).toBe(true);
  });

  it("uses oaicss session from checkout URL when sessionId is missing", () => {
    const checkout = hydrateCheckoutFromUrl(
      { checkoutUrl: "https://chatgpt.com/pricing" },
      "https://chatgpt.com/checkout/openai_llc/oaics_559a7063d70d4d69a199f717cf3bdad4",
    );
    expect(checkout.sessionId).toBe("oaics_559a7063d70d4d69a199f717cf3bdad4");
    expect(extractCheckoutContext(checkout).processorEntity).toBe("openai_llc");
    expect(canUseProtocolCheckout(checkout, "token")).toBe(true);
    expect(
      canUseProtocolCheckout(
        {
          checkoutUrl:
            "https://chatgpt.com/checkout/openai_llc/oaics_559a7063d70d4d69a199f717cf3bdad4",
        },
        "token",
      ),
    ).toBe(true);
  });

  it("accepts PHP tax-free plus due amount from taxes API", () => {
    expect(isExpectedProtocolDueAmount(982.14, "PHP", "chatgptplusplan")).toBe(
      true,
    );
    expect(isExpectedProtocolDueAmount(1100, "PHP", "chatgptplusplan")).toBe(
      false,
    );
    expect(isExpectedProtocolDueAmount(0, "PHP")).toBe(false);
  });

  it("includes card, billing, and stripe version in confirmation token form", () => {
    const form = buildConfirmationTokenForm({
      card: {
        number: "4242424242424242",
        cvc: "123",
        exp_month: "12",
        exp_year: "2028",
      },
      billing: {
        line1: "123 Main St",
        city: "Portland",
        country: "US",
        postal_code: "97201",
        state: "OR",
        name: "Jane Doe",
        currency: "usd",
      },
      publishableKey: "pk_test_xxx",
      cussSecret: "cuss_secret",
    });
    const text = form.toString();
    expect(text).toContain("payment_method_data%5Btype%5D=card");
    expect(text).toContain("4242424242424242");
    expect(text).toContain("setup_future_usage=off_session");
    expect(text).toContain("_stripe_version=2025-03-31.basil");
    expect(text).toContain("key=pk_test_xxx");
    expect(text).toContain("client_context");
  });
});
