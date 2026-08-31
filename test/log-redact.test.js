"use strict";

const {
  redactSensitiveText,
  redactPublicCheckoutLog,
  redactTaskDetailOutput,
} = require("../log-redact");

describe("log-redact", () => {
  it("masks tokens, passwords, cards, and JWTs", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0In0.abcdeflongsignaturevalue";
    const text = redactSensitiveText(
      `authorization: Bearer secret password=hunter2 api_key=sk-live ${jwt} card_number=4242424242424242`,
    );
    expect(text).not.toContain("secret");
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("sk-live");
    expect(text).not.toContain("4242424242424242");
    expect(text).not.toContain(jwt);
    expect(text).toContain("[REDACTED]");
    expect(text).toContain("[REDACTED_JWT]");
    expect(redactSensitiveText("pay 4242424242424242 now")).toContain(
      "[REDACTED_CARD]",
    );
  });

  it("keeps public checkout lines short", () => {
    const text = redactPublicCheckoutLog(`access_token=${"a".repeat(800)}`);
    expect(text).toContain("[REDACTED]");
    expect(text.length).toBeLessThanOrEqual(500);
  });

  it("keeps the tail of long task output", () => {
    const text = redactTaskDetailOutput(`${"x".repeat(210000)}card_cvc=123`);
    expect(text).toContain("[REDACTED]");
    expect(text.length).toBeLessThanOrEqual(200000);
  });
});
