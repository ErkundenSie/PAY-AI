"use strict";

const {
  CREDIT_QUANTITY_MIN,
  isCreditsPlan,
  normalizeCreditQuantity,
  resolveCreditQuantity,
  resolvePlanName,
  listCheckoutPlans,
  getCheckoutPlanNameMap,
  getPlanTypeLabel,
} = require("../credit-quantity");

describe("credit quantity", () => {
  it("detects credits plans", () => {
    expect(isCreditsPlan("credits")).toBe(true);
    expect(isCreditsPlan("credits_500")).toBe(true);
    expect(isCreditsPlan("plus")).toBe(false);
  });

  it("rounds to the 250 step and rejects values below min", () => {
    expect(normalizeCreditQuantity(240)).toBe(0);
    expect(normalizeCreditQuantity(CREDIT_QUANTITY_MIN)).toBe(250);
    expect(normalizeCreditQuantity(375)).toBe(500);
  });

  it("reads quantity from plan id when not provided", () => {
    expect(resolveCreditQuantity("credits_1000")).toBe(1000);
    expect(resolveCreditQuantity("credits", 2000)).toBe(2000);
  });

  it("maps checkout plans and OpenAI plan names", () => {
    expect(listCheckoutPlans().map((plan) => plan.id)).toEqual([
      "plus",
      "pro_5x",
      "pro_20x",
      "credits",
    ]);
    expect(resolvePlanName("plus")).toBe("chatgptplusplan");
    expect(resolvePlanName("credits_500")).toBe("platformbusiness_usage_based");
    expect(getPlanTypeLabel("plus")).toBe("ChatGPT Plus");
    expect(getPlanTypeLabel("credits_500")).toBe("Codex 500 点");
    expect(Object.keys(getCheckoutPlanNameMap())).toEqual([
      "plus",
      "pro_5x",
      "pro_20x",
      "credits",
    ]);
  });
});
