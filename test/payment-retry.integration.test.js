"use strict";

const mocks = {
  store: require("../mysql-store"),
  stripe: require("../stripe-payment"),
  address: require("../tax-free-address"),
  protocol: require("../checkout-protocol"),
};
let executePaymentWithRetry;

const card = {
  id: 7,
  card_number: "4242424242424242",
  card_expiry: "12/30",
  card_cvc: "123",
  card_holder: "Jane Doe",
};

function createPage() {
  return { url: () => "https://checkout.example.test" };
}

function setupSuccessfulPayment() {
  vi.spyOn(mocks.store, "getPaymentRegion").mockResolvedValue("PH");
  vi.spyOn(mocks.store, "getAppConfigValue").mockResolvedValue(null);
  vi.spyOn(mocks.store, "reserveCard").mockResolvedValue({ ...card });
  vi.spyOn(mocks.address, "pickBillingAddressForCheckout").mockResolvedValue({
    id: 4,
    line1: "1 Test Street",
    city: "Makati",
    state: "Metro Manila",
    postal_code: "1200",
    country: "PH",
    generated: false,
  });
  vi.spyOn(mocks.protocol, "hydrateCheckoutFromUrl").mockReturnValue({
    checkoutUrl: "",
    sessionId: "oaics_test",
  });
  vi.spyOn(mocks.protocol, "canUseProtocolCheckout").mockReturnValue(false);
  vi.spyOn(mocks.stripe, "readCheckoutDueAmount").mockResolvedValue({
    amount: 999,
    currency: "PHP",
  });
  vi.spyOn(mocks.stripe, "completeStripeCardPayment").mockResolvedValue({
    success: true,
    dueAmount: 999,
    dueCurrency: "PHP",
    holderName: "Jane Doe",
  });
  vi.spyOn(mocks.store, "bindCardPaymentProfile").mockResolvedValue();
  vi.spyOn(mocks.address, "markAddressBound").mockResolvedValue();
  vi.spyOn(mocks.store, "recordCardUsage").mockResolvedValue();
  vi.spyOn(mocks.store, "releaseCard").mockResolvedValue();
  vi.spyOn(mocks.store, "createBillingRecord").mockResolvedValue(101);
  vi.spyOn(mocks.store, "markCardExhausted").mockResolvedValue();
}

describe("payment retry integration", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubEnv("PAYMENT_REGION_OVERRIDE", "PH");
    vi.stubEnv("PAYMENT_CARD_ID", "");
    vi.stubEnv("PAYMENT_CARD_MANUAL", "");
    vi.stubEnv("PAYMENT_ADDRESS_MANUAL", "");
    setupSuccessfulPayment();
    delete require.cache[require.resolve("../payment-retry")];
    ({ executePaymentWithRetry } = require("../payment-retry"));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("persists a successful charge after releasing its card lock", async () => {
    const result = await executePaymentWithRetry(createPage(), {
      planType: "plus",
      cdkCode: "KC-TEST",
      email: "user@example.com",
      accountId: "acct-test",
    });

    expect(result).toMatchObject({ success: true, cardLast4: "4242" });
    expect(mocks.store.releaseCard).toHaveBeenCalledWith(7);
    expect(mocks.store.createBillingRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        card_last4: "4242",
        amount: 999,
        currency: "PHP",
        plan_type: "plus",
        cdk_code: "KC-TEST",
        email: "user@example.com",
        stripe_session_id: "oaics_test",
        status: "success",
      }),
    );
  });

  it("keeps a successful payment successful when billing persistence fails", async () => {
    mocks.store.createBillingRecord.mockRejectedValueOnce(new Error("db unavailable"));

    const result = await executePaymentWithRetry(createPage(), {
      planType: "plus",
      email: "user@example.com",
    });

    expect(result).toMatchObject({ success: true, cardLast4: "4242" });
    expect(mocks.store.releaseCard).toHaveBeenCalledWith(7);
    expect(mocks.store.createBillingRecord).toHaveBeenCalledTimes(1);
  });

  it("does not retry a declined card when the processor marks it non-retryable", async () => {
    mocks.stripe.completeStripeCardPayment.mockResolvedValueOnce({
      success: false,
      declined: true,
      canRetryCard: false,
      error: "card_declined",
    });

    const result = await executePaymentWithRetry(createPage(), {
      planType: "plus",
      email: "user@example.com",
    });

    expect(result).toMatchObject({ success: false, cardsDeclined: 1 });
    expect(mocks.store.reserveCard).toHaveBeenCalledTimes(1);
    expect(mocks.store.markCardExhausted).toHaveBeenCalledWith(7);
    expect(mocks.store.createBillingRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "failed",
        error_code: "card_declined",
      }),
    );
  });
});