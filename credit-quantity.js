"use strict";

const CREDIT_QUANTITY_MIN = 250;
const CREDIT_QUANTITY_STEP = 250;
const CREDIT_QUANTITY_PRESETS = [250, 500, 1000, 1500, 2000];
const CHECKOUT_PLANS = [
  { id: "plus", label: "ChatGPT Plus" },
  { id: "pro_5x", label: "ChatGPT Pro 5x" },
  { id: "pro_20x", label: "ChatGPT Pro 20x" },
  { id: "credits", label: "Codex 充值点数" },
  { id: "gift", label: "额度礼品卡" },
];
const PLAN_NAME_MAP = {
  plus: "chatgptplusplan",
  pro_5x: "chatgptprolite",
  pro_20x: "chatgptpro",
  credits: "chatgptbusiness_usage_based",
  credits_250: "chatgptbusiness_usage_based",
  credits_500: "chatgptbusiness_usage_based",
  credits_1000: "chatgptbusiness_usage_based",
  credits_1500: "chatgptbusiness_usage_based",
  credits_2000: "chatgptbusiness_usage_based",
  gift: "chatgptbusiness_usage_based",
  gift_250: "chatgptbusiness_usage_based",
  gift_500: "chatgptbusiness_usage_based",
  gift_1000: "chatgptbusiness_usage_based",
  gift_1500: "chatgptbusiness_usage_based",
  gift_2000: "chatgptbusiness_usage_based",
};
const PLAN_TYPE_LABELS = {
  plus: "ChatGPT Plus",
  pro_5x: "ChatGPT Pro 5x",
  pro_20x: "ChatGPT Pro 20x",
  credits: "Codex 充值点数",
  credits_250: "Codex 250 点",
  credits_500: "Codex 500 点",
  credits_1000: "Codex 1000 点",
  credits_1500: "Codex 1500 点",
  credits_2000: "Codex 2000 点",
  gift: "额度礼品卡",
  gift_250: "礼品卡 250 点",
  gift_500: "礼品卡 500 点",
  gift_1000: "礼品卡 1000 点",
  gift_1500: "礼品卡 1500 点",
  gift_2000: "礼品卡 2000 点",
};

function isGiftCreditsPlan(planType) {
  const raw = String(planType || "")
    .trim()
    .toLowerCase();
  return raw === "gift" || raw.startsWith("gift_");
}

function isCreditsPlan(planType) {
  const raw = String(planType || "")
    .trim()
    .toLowerCase();
  return (
    raw === "credits" ||
    raw.startsWith("credits_") ||
    isGiftCreditsPlan(raw)
  );
}

function normalizeCreditQuantity(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < CREDIT_QUANTITY_MIN) return 0;
  return Math.round(n / CREDIT_QUANTITY_STEP) * CREDIT_QUANTITY_STEP;
}

function resolveCreditQuantity(planType, quantity) {
  const raw = String(planType || "")
    .trim()
    .toLowerCase();
  const fromPlan = Number(
    (raw.match(/^(?:credits|gift)_(\d+)$/) || [])[1] || 0,
  );
  return normalizeCreditQuantity(quantity || fromPlan || 0);
}

function listCheckoutPlans() {
  return CHECKOUT_PLANS.map((plan) => ({ ...plan }));
}

function getCheckoutPlanNameMap() {
  return Object.fromEntries(
    CHECKOUT_PLANS.map((plan) => [plan.id, resolvePlanName(plan.id)]),
  );
}

function resolvePlanName(planType) {
  if (isGiftCreditsPlan(planType) || isCreditsPlan(planType)) {
    return PLAN_NAME_MAP.credits;
  }
  return PLAN_NAME_MAP[planType] || PLAN_NAME_MAP.plus;
}

function getPlanTypeLabel(planType) {
  const raw = String(planType || "")
    .trim()
    .toLowerCase();
  if (PLAN_TYPE_LABELS[raw]) {
    return PLAN_TYPE_LABELS[raw];
  }
  if (isGiftCreditsPlan(raw)) {
    const quantity = resolveCreditQuantity(raw, 0);
    return quantity ? `礼品卡 ${quantity} 点` : PLAN_TYPE_LABELS.gift;
  }
  if (isCreditsPlan(raw)) {
    const quantity = resolveCreditQuantity(raw, 0);
    return quantity ? `Codex ${quantity} 点` : PLAN_TYPE_LABELS.credits;
  }
  return PLAN_TYPE_LABELS.plus;
}

module.exports = {
  CREDIT_QUANTITY_MIN,
  CREDIT_QUANTITY_STEP,
  CREDIT_QUANTITY_PRESETS,
  CHECKOUT_PLANS,
  PLAN_NAME_MAP,
  PLAN_TYPE_LABELS,
  isCreditsPlan,
  isGiftCreditsPlan,
  normalizeCreditQuantity,
  resolveCreditQuantity,
  listCheckoutPlans,
  getCheckoutPlanNameMap,
  resolvePlanName,
  getPlanTypeLabel,
};
