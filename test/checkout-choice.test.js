"use strict";

const {
  writeCheckoutChoiceWait,
  setCheckoutChoice,
  readCheckoutChoice,
  isWaitingCheckoutChoice,
  clearCheckoutChoice,
} = require("../checkout-choice");

describe("checkout plan choice", () => {
  const jobKey = `test-choice-${Date.now()}`;

  afterEach(() => {
    clearCheckoutChoice(jobKey);
  });

  it("stores a waiting state and accepts continue", () => {
    writeCheckoutChoiceWait(jobKey);
    expect(isWaitingCheckoutChoice(jobKey)).toBe(true);
    setCheckoutChoice(jobKey, "continue");
    expect(readCheckoutChoice(jobKey)).toMatchObject({
      status: "chosen",
      variant: "continue",
    });
    expect(isWaitingCheckoutChoice(jobKey)).toBe(false);
  });

  it("rejects invalid variants", () => {
    writeCheckoutChoiceWait(jobKey);
    expect(() => setCheckoutChoice(jobKey, "plus")).toThrow("选择无效");
  });
});
