"use strict";

const { getTaskType } = require("../public/task-type");
const {
  SELF_PAY_CDK,
  PAYMENT_DEBUG_CDK,
  isPaymentDebugCdk,
  resolvePublicCheckoutCdk,
  buildCheckoutTaskCreate,
  buildCheckoutTaskUpdate,
} = require("../checkout-task-log");

describe("checkout submit → task log", () => {
  it("forces public /checkout pay onto [self-pay] 自助开通 records", () => {
    const cdkCode = resolvePublicCheckoutCdk();
    const created = buildCheckoutTaskCreate({
      tokenPreview: "sess_preview",
      sessionPayload: '{"accessToken":"TOKEN"}',
      cdkCode,
      cardLast4: "4242424242424242",
    });
    const updated = buildCheckoutTaskUpdate({
      cdkCode,
      planType: "plus",
      regionCode: "PH",
    });

    expect(created.cdkCode).toBe(SELF_PAY_CDK);
    expect(created.status).toBe("running");
    expect(created.progress).toBe(5);
    expect(created.phone).toBeNull();
    expect(created.cardLast4).toBe("4242");
    expect(updated.message).toBe("自助开通：plus / PH");
    expect(getTaskType({ cdk: created.cdkCode })).toBe("自助开通");
  });

  it("keeps credit quantity in the task message", () => {
    const updated = buildCheckoutTaskUpdate({
      cdkCode: SELF_PAY_CDK,
      planType: "credits",
      creditQuantity: 1000,
      regionCode: "US",
    });
    expect(updated.message).toBe("自助开通：credits x1000 / US");
  });

  it("maps admin payment debug to 支付调试 without changing public self-pay", () => {
    expect(isPaymentDebugCdk(PAYMENT_DEBUG_CDK)).toBe(true);
    expect(isPaymentDebugCdk(SELF_PAY_CDK)).toBe(false);

    const created = buildCheckoutTaskCreate({
      tokenPreview: "debug",
      sessionPayload: "{}",
      cdkCode: PAYMENT_DEBUG_CDK,
      cardLast4: "1111",
    });
    const updated = buildCheckoutTaskUpdate({
      cdkCode: PAYMENT_DEBUG_CDK,
      planType: "plus",
      regionCode: "PH",
    });

    expect(created.cdkCode).toBe(PAYMENT_DEBUG_CDK);
    expect(updated.message).toBe("付款调试：plus / PH");
    expect(getTaskType({ cdk: created.cdkCode })).toBe("支付调试");
  });
});
