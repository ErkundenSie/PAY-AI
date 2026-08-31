"use strict";

const { rejectCrossOriginAdmin } = require("../admin-csrf");

describe("admin CSRF origin check", () => {
  it("allows same-origin admin mutations", () => {
    expect(
      rejectCrossOriginAdmin({
        method: "POST",
        path: "/api/admin/cdks/generate",
        headers: {
          origin: "https://pay.example:3000",
          host: "pay.example:3000",
        },
      }),
    ).toBeNull();
  });

  it("rejects missing origin on admin mutations", () => {
    expect(
      rejectCrossOriginAdmin({
        method: "DELETE",
        path: "/api/admin/cdks/x",
        headers: { host: "pay.example" },
      }),
    ).toMatchObject({ status: 403 });
  });

  it("rejects cross-site fetch metadata", () => {
    expect(
      rejectCrossOriginAdmin({
        method: "POST",
        path: "/api/admin/login",
        headers: {
          origin: "https://pay.example",
          host: "pay.example",
          "sec-fetch-site": "cross-site",
        },
      }),
    ).toMatchObject({ status: 403 });
  });

  it("does not block public mutations or GET", () => {
    expect(
      rejectCrossOriginAdmin({
        method: "POST",
        path: "/api/cdk/query",
        headers: { host: "pay.example" },
      }),
    ).toBeNull();
    expect(
      rejectCrossOriginAdmin({
        method: "GET",
        path: "/api/admin/session",
        headers: { host: "pay.example" },
      }),
    ).toBeNull();
  });
});
