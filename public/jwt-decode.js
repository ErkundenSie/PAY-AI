(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.JwtDecode = factory();
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  function decodeJwtPart(part) {
    const normalized = String(part || "")
      .replace(/-/g, "+")
      .replace(/_/g, "/");
    const padded = normalized.padEnd(
      normalized.length + ((4 - (normalized.length % 4)) % 4),
      "=",
    );
    const decoded =
      typeof atob === "function"
        ? atob(padded)
        : Buffer.from(padded, "base64").toString("utf8");
    return JSON.parse(decoded);
  }

  function decodeJwtPayload(token) {
    const parts = String(token || "").split(".");
    if (parts.length !== 3 || parts.some((item) => !item)) {
      throw new Error("jwt_format");
    }
    return {
      header: decodeJwtPart(parts[0]),
      payload: decodeJwtPart(parts[1]),
    };
  }

  function parseSessionJson(raw) {
    const content = String(raw || "")
      .trim()
      .replace(/^\uFEFF/, "");
    if (!content.startsWith("{")) {
      return null;
    }
    try {
      const data = JSON.parse(content);
      if (data?.accessToken || data?.access_token || data?.user) {
        return data;
      }
    } catch (_) {
      return null;
    }
    return null;
  }

  return { decodeJwtPart, decodeJwtPayload, parseSessionJson };
});
