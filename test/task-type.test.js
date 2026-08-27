"use strict";

const { getTaskType } = require("../public/task-type");

describe("getTaskType", () => {
  it("maps self-pay checkout tasks", () => {
    expect(getTaskType({ cdk: "[self-pay]" })).toBe("自助开通");
  });

  it("maps debug task codes", () => {
    expect(getTaskType({ cdk: "[payment-debug]" })).toBe("支付调试");
    expect(getTaskType({ cdk: "[checkout-debug]" })).toBe("链接调试");
  });

  it("treats real CDK codes as CDK 开通", () => {
    expect(getTaskType({ cdk: "KC-ABC123" })).toBe("CDK 开通");
    expect(getTaskType({})).toBe("CDK 开通");
  });
});
