"use strict";

/**
 * 第三方 GPT 代充 API 客户端（协议见 协议api.md）
 *
 * 基础 URL:   https://kc.vpss.eu.cc/
 * 认证:       Authorization: Bearer gptk_...
 * 幂等键:     Idempotency-Key（提交代充必须带上）
 *
 * 本模块仅做轻量封装：提交代充、查询订单/任务状态、查询套餐/余额、测试连通。
 */

const axios = require("axios");

const DEFAULT_BASE_URL = "https://kc.vpss.eu.cc/";

function normalizeBaseUrl(raw) {
  const url = String(raw || "")
    .trim()
    .replace(/\/+$/, "");
  if (!url) return "";
  return url;
}

function maskApiKey(key) {
  const k = String(key || "").trim();
  if (!k) return "";
  if (k.length <= 8) return "****";
  return `${k.slice(0, 6)}\u2026${k.slice(-4)}`;
}

/**
 * 统一请求封装，始终返回 { success, status?, data?, error? }
 */
async function request(
  method,
  path,
  cfg,
  { body, headers: extraHeaders, timeoutMs } = {},
) {
  const base = normalizeBaseUrl(cfg?.base_url) || DEFAULT_BASE_URL;
  const apiKey = String(cfg?.api_key || "").trim();
  if (!apiKey) {
    return { success: false, error: "缺少 API Key" };
  }

  const headers = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    Accept: "application/json",
    ...(extraHeaders || {}),
  };

  try {
    const response = await axios.request({
      method,
      url: `${base}${path}`,
      headers,
      data: body == null ? undefined : body,
      validateStatus: () => true,
      timeout: Number(timeoutMs) || 30000,
    });
    let data = response.data;
    if (data == null) data = {};
    if (typeof data === "string") {
      try {
        data = JSON.parse(data);
      } catch (_) {
        data = { _raw: data };
      }
    }
    const ok = response.status >= 200 && response.status < 300;
    return {
      success: ok,
      status: response.status,
      data,
      error: ok ? undefined : extractErrorDetail(data, response.status),
    };
  } catch (error) {
    let detail = "请求失败";
    if (error?.response?.data) {
      detail = extractErrorDetail(error.response.data, error.response.status);
    } else if (error?.code === "ECONNABORTED") {
      detail = "请求超时";
    } else if (error?.message) {
      detail = error.message;
    }
    return { success: false, error: detail };
  }
}

/**
 * 从上游响应中提取可读的错误信息（兼容 detail/message/error 等常见字段）
 */
function extractErrorDetail(data, status) {
  if (!data || typeof data !== "object") {
    return `HTTP ${status || ""} ${JSON.stringify(data || "")}`.trim();
  }
  if (typeof data.detail === "string" && data.detail) return data.detail;
  if (
    data.detail &&
    typeof data.detail === "object" &&
    !Array.isArray(data.detail)
  ) {
    const code = String(data.detail.error || data.detail.code || "").trim();
    const reason = String(data.detail.reason || "").trim();
    const upstream = data.detail.upstream_status
      ? `upstream ${data.detail.upstream_status}`
      : "";
    const parts = [code, reason, upstream].filter(Boolean);
    if (parts.length) return parts.join(" / ");
    return JSON.stringify(data.detail).slice(0, 300);
  }
  if (Array.isArray(data.detail) && data.detail.length) {
    return data.detail
      .map((item) =>
        typeof item === "object" ? JSON.stringify(item) : String(item),
      )
      .join("; ");
  }
  if (typeof data.message === "string" && data.message) return data.message;
  if (typeof data.error === "string" && data.error) return data.error;
  if (typeof data.msg === "string" && data.msg) return data.msg;
  const raw = JSON.stringify(data);
  if (raw && raw !== "{}") return raw.slice(0, 300);
  return `HTTP ${status || ""}`;
}

/**
 * 查询可用 GPT 套餐 (GET /plans)
 */
async function fetchPlans(cfg) {
  const res = await request("GET", "/plans", cfg);
  if (!res.success) return res;
  const raw = res.data;
  const gptPlans = Array.isArray(raw)
    ? raw
    : Array.isArray(raw?.gpt)
      ? raw.gpt
      : raw?.plans || raw?.data || [];
  const creditPlans = Array.isArray(raw?.credit) ? raw.credit : [];
  return {
    success: true,
    status: res.status,
    plans: Array.isArray(gptPlans) ? gptPlans : [],
    gptPlans: Array.isArray(gptPlans) ? gptPlans : [],
    creditPlans,
    raw,
  };
}

/**
 * 建单前验证 Session 与当前套餐 (POST /pay/inspect)
 */
async function inspectPay(cfg, { planKey, session, sessionToken }) {
  const sessionBody =
    session && typeof session === "object"
      ? session
      : sessionToken
        ? { access_token: sessionToken }
        : {};
  const body = {
    plan_key: planKey || "plus",
    session: sessionBody,
  };
  const res = await request("POST", "/pay/inspect", cfg, {
    body,
    timeoutMs: 30000,
  });
  if (!res.success) return res;
  return {
    success: Boolean(res.data?.verified && res.data?.ok),
    status: res.status,
    data: res.data,
    error: res.data?.error || undefined,
    reason: res.data?.reason || undefined,
    upstreamStatus: res.data?.upstream_status ?? null,
  };
}

/**
 * 提交 GPT 代充 (POST /pay)
 * @returns { success, orderId?, taskId?, data, error? }
 */
async function submitPay(
  cfg,
  {
    planKey,
    session,
    sessionToken,
    country,
    currency,
    newCard,
    cardId,
    cvc,
    acceptWarnings,
    billingAddress,
    proxy,
    clientRef,
    idempotencyKey,
  },
) {
  const body = {
    plan_key: planKey,
    country: country || "PH",
    currency: currency || "PHP",
  };
  if (newCard && typeof newCard === "object") {
    body.new_card = newCard;
  } else if (Number.isInteger(Number(cardId)) && Number(cardId) > 0) {
    body.card_id = Number(cardId);
    if (cvc) body.cvc = String(cvc);
    if (acceptWarnings === true) body.accept_warnings = true;
  }
  if (billingAddress && typeof billingAddress === "object")
    body.billing_address = billingAddress;
  if (clientRef) body.client_ref = String(clientRef);
  if (proxy) {
    body.proxy = String(proxy).trim();
  }
  if (session && typeof session === "object") {
    body.session = session;
  } else if (sessionToken) {
    body.session = { access_token: sessionToken };
  }
  const headers = {};
  if (idempotencyKey) {
    headers["Idempotency-Key"] = idempotencyKey;
  }

  const res = await request("POST", "/pay", cfg, {
    body,
    headers,
    timeoutMs: 60000,
  });
  if (!res.success) return res;

  const orderId = extractOrderId(res.data);
  const taskId = extractTaskId(res.data);
  return {
    success: true,
    status: res.status,
    orderId,
    taskId,
    id: orderId || taskId || extractId(res.data) || null,
    alreadySubmitted: Boolean(res.data?.already_submitted),
    topupCode: extractTopupCode(res.data),
    data: res.data,
  };
}

function extractId(data) {
  if (!data || typeof data !== "object") return null;
  return data.id ?? data.order_id ?? data.task_id ?? data._id ?? null;
}

function extractOrderId(data) {
  if (!data || typeof data !== "object") return null;
  return (
    data.order_id ?? data.order?.id ?? data.orderId ?? data.pay_order_id ?? null
  );
}

function extractTaskId(data) {
  if (!data || typeof data !== "object") return null;
  return data.task_id ?? data.task?.id ?? data.taskId ?? null;
}

function extractTopupCode(data) {
  if (!data || typeof data !== "object") return null;
  const code = data.topup_code ?? data.order?.topup_code ?? null;
  return code == null || String(code).trim() === ""
    ? null
    : String(code).trim();
}

/**
 * 查询单笔代充订单状态 (GET /pay/orders/{order_id})
 */
async function queryOrder(cfg, orderId) {
  if (!orderId) {
    return { success: false, error: "缺少订单号" };
  }
  const res = await request(
    "GET",
    `/pay/orders/${encodeURIComponent(orderId)}`,
    cfg,
  );
  if (!res.success) return res;
  return {
    success: true,
    status: res.status,
    data: res.data,
    rawStatus: extractStatus(res.data),
  };
}

/**
 * 查询任务状态 (GET /tasks/{task_id})
 */
async function queryTask(cfg, taskId) {
  if (!taskId) {
    return { success: false, error: "缺少任务号" };
  }
  const res = await request("GET", `/tasks/${encodeURIComponent(taskId)}`, cfg);
  if (!res.success) return res;
  return {
    success: true,
    status: res.status,
    data: res.data,
    rawStatus: extractStatus(res.data),
  };
}

/**
 * 查询积分与账户余额 (GET /balance)
 */
async function queryBalance(cfg) {
  const res = await request("GET", "/balance", cfg);
  if (!res.success) return res;
  return {
    success: true,
    status: res.status,
    data: res.data,
    credits: res.data?.credits ?? null,
    balance: res.data?.balance ?? null,
    balanceUsd: res.data?.balance_usd ?? null,
  };
}

function extractStatus(data) {
  if (!data || typeof data !== "object") return "";
  const resultStatus =
    data.result && typeof data.result === "object" ? data.result.status : "";
  if (resultStatus) return resultStatus;
  const outer =
    data.status ?? data.state ?? data.order?.status ?? data.task?.status ?? "";
  if (
    String(outer).toLowerCase() === "done" &&
    data.result &&
    data.result.ok === false
  )
    return "failed";
  return outer;
}

/**
 * 测试连接：查询套餐 + 余额，返回摘要
 */
async function testConnection(cfg) {
  const [plansRes, balanceRes] = await Promise.all([
    fetchPlans(cfg),
    queryBalance(cfg),
  ]);

  if (!plansRes.success) {
    return { success: false, error: `套餐查询失败: ${plansRes.error}` };
  }

  const messages = [];
  if (plansRes.success) {
    messages.push(
      `套餐 ${Array.isArray(plansRes.plans) ? plansRes.plans.length : 0} 个`,
    );
  }
  if (balanceRes.success) {
    const b = balanceRes.data || {};
    const balance = b.balance ?? b.credits ?? b.amount ?? "";
    if (balance !== "") {
      messages.push(`余额 ${balance}`);
    }
  }

  return {
    success: true,
    message: `API 连接成功（${messages.join("，")}）`,
    plans: plansRes.plans || [],
    gptPlans: plansRes.gptPlans || [],
    creditPlans: plansRes.creditPlans || [],
    balance: balanceRes.success ? balanceRes.data : null,
  };
}

module.exports = {
  DEFAULT_BASE_URL,
  normalizeBaseUrl,
  maskApiKey,
  request,
  fetchPlans,
  inspectPay,
  submitPay,
  queryOrder,
  queryTask,
  queryBalance,
  testConnection,
  extractOrderId,
  extractTaskId,
  extractTopupCode,
  extractStatus,
};
