"use strict";

const {
  collectCookieSpecs,
  expandSessionTokenCookies,
  isChallengeLike,
} = require("../session-auth");

describe("session-auth cookie helpers", () => {
  it("injects callback-url alongside a short sessionToken", () => {
    const specs = collectCookieSpecs(
      {
        sessionToken: "a".repeat(120),
        accessToken: "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIn0.sig",
      },
      null,
    );
    const names = specs.map((item) => item.name);
    expect(names).toContain("__Secure-next-auth.session-token");
    expect(names).toContain("__Secure-next-auth.callback-url");
    expect(
      specs.find((item) => item.name === "__Secure-next-auth.callback-url")
        .value,
    ).toBe("https://chatgpt.com/");
  });

  it("keeps a 3672-character sessionToken as a single cookie", () => {
    const chunks = expandSessionTokenCookies("b".repeat(3672));
    expect(chunks).toHaveLength(1);
    expect(chunks[0].name).toBe("__Secure-next-auth.session-token");
    expect(chunks[0].value).toHaveLength(3672);
  });

  it("treats a non-json 403 as a challenge instead of an expired cookie", () => {
    expect(
      isChallengeLike({
        status: 403,
        headerText: "",
        bodyText: "",
      }),
    ).toBe(true);
    expect(
      isChallengeLike({
        status: 200,
        headerText: "",
        bodyText: "{}",
      }),
    ).toBe(false);
  });
});
