"use strict";

function redactSensitiveText(value, options = {}) {
  const maxLen = Number(options.maxLen);
  const keepTail = Boolean(options.keepTail);
  const text = String(value || "")
    .replace(/(authorization\s*[:=]\s*(?:bearer\s+)?)\S+/gi, "$1[REDACTED]")
    .replace(
      /((?:api[_-]?key|secret|password|passwd|cookie|session(?:_?token|_?json)?|access[_-]?token|refresh[_-]?token|CHATGPT_TOKEN|CHATGPT_SESSION_JSON|PAYMENT_CARD_MANUAL)\s*[:=]\s*["']?)\S+/gi,
      "$1[REDACTED]",
    )
    .replace(
      /(["']?(?:access_?token|session(?:_?token|_?json)?|cookie|card_(?:number|cvc)|password|secret|api[_-]?key)["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi,
      "$1[REDACTED]",
    )
    .replace(
      /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9._-]{10,}\.[A-Za-z0-9._-]{10,}\b/g,
      "[REDACTED_JWT]",
    )
    .replace(/\b\d{12,19}\b/g, "[REDACTED_CARD]");

  if (!Number.isFinite(maxLen) || maxLen <= 0) {
    return text;
  }
  return keepTail ? text.slice(-maxLen) : text.slice(0, maxLen);
}

function redactPublicCheckoutLog(value) {
  return redactSensitiveText(value, { maxLen: 500 });
}

function redactInternalErrorForLog(value) {
  return redactSensitiveText(value, { maxLen: 1000 });
}

function redactTaskDetailOutput(value) {
  return redactSensitiveText(value, { maxLen: 200000, keepTail: true });
}

module.exports = {
  redactSensitiveText,
  redactPublicCheckoutLog,
  redactInternalErrorForLog,
  redactTaskDetailOutput,
};
