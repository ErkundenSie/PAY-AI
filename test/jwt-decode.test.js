"use strict";

const {
  decodeJwtPart,
  decodeJwtPayload,
  parseSessionJson,
} = require("../public/jwt-decode");
const {
  normalizeAdminPathSegment,
  normalizeAdminPaths,
} = require("../admin-paths");

describe("decodeJwtPart", () => {
  it("decodes a standard JWT payload segment", () => {
    const payload = Buffer.from(
      JSON.stringify({ iss: "https://auth.openai.com", exp: 1 }),
    ).toString("base64url");
    expect(decodeJwtPart(payload)).toEqual({
      iss: "https://auth.openai.com",
      exp: 1,
    });
  });

  it("rejects malformed tokens", () => {
    expect(() => decodeJwtPayload("a.b")).toThrow("jwt_format");
    expect(() => decodeJwtPayload("..sig")).toThrow("jwt_format");
  });

  it("parses Session JSON and rejects non-session payloads", () => {
    expect(parseSessionJson('{"accessToken":"abc"}')).toEqual({
      accessToken: "abc",
    });
    expect(parseSessionJson("not-json")).toBeNull();
    expect(parseSessionJson('{"foo":1}')).toBeNull();
  });
});

describe("admin paths", () => {
  it("normalizes and rejects reserved or colliding paths", () => {
    expect(normalizeAdminPathSegment(" Secure Login ")).toBe("secure-login");
    expect(() => normalizeAdminPathSegment("api")).toThrow(/保留/);
    expect(() => normalizeAdminPathSegment("checkout.html")).toThrow(/保留/);
    expect(() =>
      normalizeAdminPaths({ loginPath: "panel", panelPath: "panel" }),
    ).toThrow(/不能相同/);
  });
});
