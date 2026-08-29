"use strict";

const SELF_PAY_CDK = "[self-pay]";
const PAYMENT_DEBUG_CDK = "[payment-debug]";
const CUSTOM_PAY_CDK = "[custom-pay]";

function isPaymentDebugCdk(cdkCode) {
  return String(cdkCode || "") === PAYMENT_DEBUG_CDK;
}

function isCustomPayCdk(cdkCode) {
  return String(cdkCode || "") === CUSTOM_PAY_CDK;
}

function isAdminPaymentCdk(cdkCode) {
  return isPaymentDebugCdk(cdkCode) || isCustomPayCdk(cdkCode);
}

function resolvePublicCheckoutCdk() {
  return SELF_PAY_CDK;
}

function buildCheckoutTaskCreate({
  tokenPreview,
  sessionPayload,
  cdkCode,
  cardLast4,
} = {}) {
  const last4 = cardLast4 == null ? null : String(cardLast4).slice(-4);
  return {
    tokenPreview,
    sessionPayload,
    cdkCode: String(cdkCode || SELF_PAY_CDK),
    phone: null,
    cardLast4: last4 || null,
    status: "running",
    progress: 5,
  };
}

function buildCheckoutTaskUpdate({
  cdkCode,
  planType,
  creditQuantity = 0,
  regionCode,
} = {}) {
  const taskLabel = isCustomPayCdk(cdkCode)
    ? "自定义付款"
    : isPaymentDebugCdk(cdkCode)
      ? "付款调试"
      : "自助开通";
  return {
    status: "running",
    message: `${taskLabel}：${planType}${creditQuantity ? ` x${creditQuantity}` : ""} / ${regionCode}`,
    progress: 5,
  };
}

module.exports = {
  SELF_PAY_CDK,
  PAYMENT_DEBUG_CDK,
  CUSTOM_PAY_CDK,
  isPaymentDebugCdk,
  isCustomPayCdk,
  isAdminPaymentCdk,
  resolvePublicCheckoutCdk,
  buildCheckoutTaskCreate,
  buildCheckoutTaskUpdate,
};
