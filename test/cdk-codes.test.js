"use strict";

const {
  createCdks,
  CDK_BODY_LENGTH,
  CDK_PATTERN,
  CDK_CHARSET,
} = require("../cdk-codes");

describe("createCdks", () => {
  it("generates unique grouped codes without a brand prefix", () => {
    const codes = createCdks(8);
    expect(codes).toHaveLength(8);
    expect(new Set(codes).size).toBe(8);
    for (const code of codes) {
      expect(code.startsWith("KC-")).toBe(false);
      expect(code).toMatch(CDK_PATTERN);
      expect(code.replace(/-/g, "")).toHaveLength(CDK_BODY_LENGTH);
      expect(
        [...code.replace(/-/g, "")].every((ch) => CDK_CHARSET.includes(ch)),
      ).toBe(true);
    }
  });

  it("clamps count to 1..100", () => {
    expect(createCdks(0)).toHaveLength(1);
    expect(createCdks(500)).toHaveLength(100);
  });
});
