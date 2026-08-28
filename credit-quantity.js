"use strict";

const CREDIT_QUANTITY_MIN = 250;
const CREDIT_QUANTITY_STEP = 250;
const CREDIT_QUANTITY_PRESETS = [500, 1000, 2000];
const CHECKOUT_PLANS = [
  { id: "plus", label: "ChatGPT Plus" },
  { id: "pro_5x", label: "ChatGPT Pro 5x" },
  { id: "pro_20x", label: "ChatGPT Pro 20x" },
  { id: "credits", label: "Codex 充值点数" },
];
const PLAN_NAME_MAP = {
  plus: "chatgptplusplan",
  pro_5x: "chatgptprolite",
  pro_20x: "chatgptpro",
  credits: "platformbusiness_usage_based",
  credits_500: "platformbusiness_usage_based",
  credits_1000: "platformbusiness_usage_based",
  credits_2000: "platformbusiness_usage_based",
};
const PLAN_TYPE_LABELS = {
  plus: "ChatGPT Plus",
  pro_5x: "ChatGPT Pro 5x",
  pro_20x: "ChatGPT Pro 20x",
  credits: "Codex 充值点数",
  credits_500: "Codex 500 点",
  credits_1000: "Codex 1000 点",
  credits_2000: "Codex 2000 点",
};

function isCreditsPlan(planType) {
  const raw = String(planType || "")
    .trim()
    .toLowerCase();
  return raw === "credits" || raw.startsWith("credits_");
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
  const fromPlan = Number((raw.match(/^credits_(\d+)$/) || [])[1] || 0);
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
  if (isCreditsPlan(planType)) {
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
  normalizeCreditQuantity,
  resolveCreditQuantity,
  listCheckoutPlans,
  getCheckoutPlanNameMap,
  resolvePlanName,
  getPlanTypeLabel,
};
