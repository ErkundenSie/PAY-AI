"use strict";

(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  if (root && typeof root === "object") {
    root.CardParse = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  function digitsOnly(value) {
    return String(value || "").replace(/\D/g, "");
  }

  function looksLikeCardBundle(value) {
    return /[|,，;、]/.test(String(value || ""));
  }

  function normalizeExpiry(expiry) {
    const raw = String(expiry || "").trim();
    if (!raw) return "";
    const digits = raw.replace(/\D/g, "");
    if (digits.length === 4) {
      const month = Number(digits.slice(0, 2));
      if (month >= 1 && month <= 12) {
        return `${digits.slice(0, 2)}/${digits.slice(2)}`;
      }
    }
    const match = raw.match(/^(\d{1,2})\s*[/\-.]\s*(\d{2,4})$/);
    if (!match) return raw;
    const month = Number(match[1]);
    if (month < 1 || month > 12) return raw;
    const year = match[2].length === 4 ? match[2].slice(-2) : match[2];
    return `${String(month).padStart(2, "0")}/${year}`;
  }

  function parseCardBundle(value) {
    const raw = String(value || "").trim();
    if (!raw) return null;
    let parts = raw
      .split(/[|,，;、\t\r\n]+/)
      .map((item) => item.trim())
      .filter(Boolean);
    if (parts.length < 3) {
      const packed = raw.match(
        /(\d[\d\s-]{11,23}\d)\D+(\d{1,2}\s*[/\-.]\s*\d{2,4})\D+(\d{3,4})\b/,
      );
      if (packed) parts = [packed[1], packed[2], packed[3]];
    }
    if (parts.length < 3) return null;
    const number = digitsOnly(parts[0]);
    if (number.length < 13 || number.length > 19) return null;
    const expiry = normalizeExpiry(parts[1]);
    if (!/^\d{2}\/\d{2}$/.test(expiry)) return null;
    const cvc = digitsOnly(parts[2]);
    if (!/^\d{3,4}$/.test(cvc)) return null;
    const holder = parts.slice(3).join(" ").trim();
    return {
      number,
      expiry,
      cvc,
      holder,
      card_number: number,
      card_expiry: expiry,
      card_cvc: cvc,
      card_holder: holder,
    };
  }

  function parseCardImportLine(raw) {
    const text = String(raw || "").trim();
    if (!text) return null;
    const parsed = parseCardBundle(text);
    if (!parsed) {
      return { error: "格式错误（卡号|有效期|CVC，也可用逗号分隔）" };
    }
    return {
      card_number: parsed.card_number,
      card_expiry: parsed.card_expiry,
      card_cvc: parsed.card_cvc,
      card_holder: parsed.card_holder,
    };
  }

  return {
    digitsOnly,
    looksLikeCardBundle,
    normalizeExpiry,
    parseCardBundle,
    parseCardImportLine,
  };
});
