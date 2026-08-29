"use strict";

const fs = require("fs");

/**
 * Payment Retry with Card Rotation Module
 *
 * 支付逻辑：
 * 1. 获取当前地区和账单配置
 * 2. 选取免税地址
 * 3. 从卡池预留卡片，拒付时自动换卡（最多 PAYMENT_MAX_CARD_ATTEMPTS 次）
 * 4. 成功 → 绑定地址/姓名到卡片、标记地址已绑定
 */

const store = require("./mysql-store");
const {
  completeStripeCardPayment,
  readCheckoutDueAmount,
  estimateTaxFreeAmount,
} = require("./stripe-payment");
const {
  pickBillingAddressForCheckout,
  markAddressBound,
} = require("./tax-free-address");
const { getRegionConfig } = require("./region-config");
const {
  canUseProtocolCheckout,
  completeProtocolCheckout,
  hydrateCheckoutFromUrl,
} = require("./checkout-protocol");

const MAX_CARD_ATTEMPTS = Number(process.env.PAYMENT_MAX_CARD_ATTEMPTS) || 3;
const MAX_AUTOMATION_ATTEMPTS = MAX_CARD_ATTEMPTS;

function isPaymentDeclined(errorMsg) {
  if (!errorMsg) return false;
  const declinedKeywords = [
    "declined",
    "card_declined",
    "insufficient_funds",
    "expired_card",
    "incorrect_cvc",
    "processing_error",
    "lost_card",
    "stolen_card",
    "do_not_honor",
    "拒绝",
    "被拒",
    "your card was declined",
    "payment was not successful",
    "payment was not approved",
    "not approved",
  ];
  const lower = errorMsg.toLowerCase();
  if (
    /missing required param|client_context\[mode\]|invalid_request_error/.test(
      lower,
    )
  ) {
    return false;
  }
  return declinedKeywords.some((kw) => lower.includes(kw));
}

/**
 * 解析应写入账单的实际扣款金额（优先免税后应付）
 */
async function resolveBilledAmountForRecord(
  page,
  paymentResult,
  preTaxAmount,
  currency,
) {
  if (paymentResult?.dueAmount > 0) {
    return {
      amount: paymentResult.dueAmount,
      currency: paymentResult.dueCurrency || currency,
    };
  }
  try {
    const due = await readCheckoutDueAmount(page);
    if (due?.amount > 0) {
      return { amount: due.amount, currency: due.currency || currency };
    }
  } catch (_) {
    /* ignore */
  }
  if (preTaxAmount > 0) {
    const estimated = estimateTaxFreeAmount(preTaxAmount);
    if (estimated && estimated < preTaxAmount * 0.98) {
      return { amount: estimated, currency };
    }
  }
  return { amount: preTaxAmount, currency };
}

/**
 * 执行支付；拒付时在同一会话内换卡重试
 * @param {import('playwright').Page} page - Playwright Page 实例
 * @param {object} options - 支付选项
 * @returns {Promise<{ success: boolean, error?: string, cardLast4?: string, manualIntervention?: boolean, screenshots?: string[] }>}
 */
async function attemptCardPayment(
  page,
  {
    cardInfo,
    address,
    cardAttempt,
    holderName,
    accessToken,
    checkout,
    accountId,
    email,
    currency,
    progress,
    planType,
  },
) {
  const checkoutContext = hydrateCheckoutFromUrl(
    checkout,
    page && typeof page.url === "function" ? page.url() : "",
  );
  if (canUseProtocolCheckout(checkoutContext, accessToken)) {
    progress("走协议支付: taxes → token → confirm → PI");
    try {
      const protocolResult = await completeProtocolCheckout({
        page,
        accessToken,
        checkout: checkoutContext,
        card: cardInfo,
        billing: {
          line1: address.line1,
          city: address.city,
          state: address.state,
          postal_code: address.postal_code,
          country: address.country || "US",
          currency,
          name: holderName,
          email,
          planName: checkout?.data?.plan_name || checkout?.planName || "",
        },
        accountId,
        email,
        onProgress: progress,
      });
      if (protocolResult.success || protocolResult.declined) {
        return protocolResult;
      }
      progress(
        `协议未完成，回退 UI 填表: ${protocolResult.error || "unknown"}`,
      );
      if (protocolResult.holderName) {
        holderName = protocolResult.holderName;
      }
    } catch (err) {
      progress(`协议异常，回退 UI 填表: ${err.message}`);
    }
  } else {
    progress(
      `协议不可用，走 UI 填表: token=${Boolean(String(accessToken || "").trim())} session=${Boolean(checkoutContext.sessionId)} hosted=${/checkout\.stripe\.com/i.test(String(checkoutContext.checkoutUrl || ""))}`,
    );
  }

  const checkoutUrl = String(checkoutContext.checkoutUrl || "").trim();
  const currentUrl =
    page && typeof page.url === "function" ? String(page.url() || "") : "";
  if (checkoutUrl && currentUrl !== checkoutUrl) {
    progress("正在打开 Checkout 页面以继续 UI 支付...");
    try {
      await page.goto(checkoutUrl, {
        waitUntil: "domcontentloaded",
        timeout: 90000,
      });
    } catch (err) {
      await page
        .waitForLoadState("domcontentloaded", { timeout: 20000 })
        .catch(() => {});
      const now = page && typeof page.url === "function" ? String(page.url() || "") : "";
      if (/checkout\.stripe\.com|\/checkout\//i.test(now)) {
        progress(`Checkout 导航被打断，已停留在付款页`);
      } else {
        throw err;
      }
    }
    await page
      .waitForLoadState("networkidle", { timeout: 30000 })
      .catch(() => {});
  }

  return completeStripeCardPayment(page, cardInfo, address, {
    cardAttempt,
    holderName,
    planType,
  });
}

async function executePaymentWithRetry(page, options) {
  const {
    planType,
    cdkCode,
    email,
    onProgress,
    stripeSessionId,
    accessToken,
    checkout,
    accountId,
    cardGroupId = null,
  } = options || {};
  const preferredCardId = Number(process.env.PAYMENT_CARD_ID || 0);
  const manualCardRaw = String(process.env.PAYMENT_CARD_MANUAL || "").trim();
  let manualCard = null;
  if (manualCardRaw) {
    try {
      const parsed = JSON.parse(manualCardRaw);
      if (
        parsed &&
        parsed.card_number &&
        parsed.card_expiry &&
        parsed.card_cvc
      ) {
        manualCard = {
          id: 0,
          card_number: String(parsed.card_number).replace(/\s+/g, ""),
          card_expiry: String(parsed.card_expiry).trim(),
          card_cvc: String(parsed.card_cvc).trim(),
          card_holder: String(parsed.card_holder || "").trim(),
        };
      }
    } catch (_) {
      /* ignore */
    }
  }
  const checkoutContext = hydrateCheckoutFromUrl(
    checkout,
    page && typeof page.url === "function" ? page.url() : "",
  );
  const protocolSessionId = checkoutContext.sessionId || stripeSessionId || "";

  const progress = (msg) => {
    console.log(`[PaymentRetry] ${msg}`);
    if (typeof onProgress === "function") {
      try {
        onProgress(msg);
      } catch (_) {
        /* ignore callback errors */
      }
    }
  };

  const regionOverride = String(process.env.PAYMENT_REGION_OVERRIDE || "")
    .trim()
    .toUpperCase();
  const region = regionOverride || (await store.getPaymentRegion());
  const regionConfig = getRegionConfig(region);
  if (!regionConfig) {
    return { success: false, error: "不支持的支付地区配置" };
  }
  const { currency } = regionConfig;
  progress(`支付地区: ${region}, 币种: ${currency}`);

  const lastUsedIdRaw = await store.getAppConfigValue(
    "last_used_address_id",
    null,
  );
  const lastUsedId = lastUsedIdRaw ? Number(lastUsedIdRaw) : null;

  let address;
  const manualAddressRaw = String(
    process.env.PAYMENT_ADDRESS_MANUAL || "",
  ).trim();
  if (manualAddressRaw) {
    try {
      const parsed = JSON.parse(manualAddressRaw);
      address = {
        line1: String(parsed.line1 || "").trim(),
        city: String(parsed.city || "").trim(),
        state: String(parsed.state || "").trim(),
        postal_code: String(parsed.postal_code || parsed.postal || "").trim(),
        country:
          String(parsed.country || "US")
            .trim()
            .toUpperCase() || "US",
        name: String(parsed.name || parsed.holder || "").trim(),
        generated: false,
      };
      if (
        !address.line1 ||
        !address.city ||
        !address.state ||
        !address.postal_code
      ) {
        address = null;
      }
    } catch (_) {
      address = null;
    }
  }
  if (!address) {
    address = await pickBillingAddressForCheckout(lastUsedId);
  }
  const addressSource =
    manualAddressRaw && address && !address.id
      ? "手动输入"
      : address.generated
        ? "随机生成"
        : `地址池 #${address.id}`;
  progress(
    `已选取美国免税账单地址 (${addressSource}): ${address.line1}, ${address.city}, ${address.state}`,
  );

  const ownerKey = cdkCode
    ? `payment_${cdkCode}_${Date.now()}`
    : `payment_debug_${Date.now()}`;

  const screenshots = [];
  const declinedLast4s = [];
  let lastError = "";
  let lastCardLast4 = "";
  let billingHolderName = String(address.name || "").trim();

  let billedAmount = 0;
  let billedCurrency = currency;
  if (!canUseProtocolCheckout(checkoutContext, accessToken)) {
    try {
      const due = await readCheckoutDueAmount(page);
      if (due?.amount) {
        billedAmount = due.amount;
        if (due.currency) billedCurrency = due.currency;
        progress(`Checkout 应付金额: ${billedCurrency} ${billedAmount}`);
      }
    } catch (_) {
      /* ignore */
    }
  }

  progress(
    `开始支付（最多尝试 ${manualCard || preferredCardId ? 1 : MAX_CARD_ATTEMPTS} 张卡）...`,
  );

  const maxAttempts = manualCard || preferredCardId ? 1 : MAX_CARD_ATTEMPTS;
  for (let cardAttempt = 1; cardAttempt <= maxAttempts; cardAttempt += 1) {
    let card = null;
    if (manualCard) {
      card = { ...manualCard };
      progress(`使用手动卡片: ...${String(card.card_number || "").slice(-4)}`);
    } else if (preferredCardId) {
      try {
        card = await store.reserveCardById(preferredCardId, ownerKey);
      } catch (err) {
        return { success: false, error: err.message || "指定卡片不可用" };
      }
      if (!card) {
        return { success: false, error: "指定卡片不存在" };
      }
      progress(
        `已指定卡片 #${cardAttempt}: ...${String(card.card_number || "").slice(-4)}`,
      );
    } else {
      card = await store.reserveCard(ownerKey, cardGroupId);
    }
    if (!card) {
      progress(
        cardAttempt === 1
          ? cardGroupId
            ? "当前分组卡池无可用卡，终止支付"
            : "卡池无可用卡，终止支付"
          : `卡池已无更多可用卡（已拒 ${declinedLast4s.length} 张）`,
      );
      if (cardAttempt === 1) {
        await store.createBillingRecord({
          card_last4: "----",
          amount: billedAmount,
          currency: billedCurrency,
          plan_type: planType || "plus",
          cdk_code: cdkCode,
          email,
          stripe_session_id: protocolSessionId || null,
          status: "failed",
          error_code: "card_pool_exhausted",
          error_message: "卡池资产枯竭",
        });
        return { success: false, error: "卡池资产枯竭" };
      }
      break;
    }

    const cardInfo = {
      number: card.card_number,
      expiry: card.card_expiry,
      cvc: card.card_cvc,
      holder: card.card_holder,
    };
    const cardLast4 = String(card.card_number || "").slice(-4);
    lastCardLast4 = cardLast4;
    progress(`已预留卡片 #${cardAttempt}: ...${cardLast4}`);

    let cardHandled = false;

    try {
      const paymentResult = await attemptCardPayment(page, {
        cardInfo,
        address,
        cardAttempt,
        holderName: billingHolderName,
        accessToken,
        checkout: checkoutContext,
        accountId,
        email,
        currency: billedCurrency,
        progress,
        planType,
      });

      if (paymentResult.holderName) {
        billingHolderName = paymentResult.holderName;
      }

      if (paymentResult.success) {
        const resolved = await resolveBilledAmountForRecord(
          page,
          paymentResult,
          billedAmount,
          billedCurrency,
        );
        billedAmount = resolved.amount;
        billedCurrency = resolved.currency;
        if (
          Number(billedAmount) <= 0 ||
          (String(billedCurrency || "").toUpperCase() === "PHP" &&
            (Number(billedAmount) < 900 || Number(billedAmount) > 1050))
        ) {
          lastError = `应付金额异常: ${billedCurrency} ${billedAmount}`;
          progress(lastError);
          if (card.id) await store.releaseCard(card.id).catch(() => {});
          cardHandled = true;
          return {
            success: false,
            error: lastError,
            cardLast4,
            manualIntervention: true,
            screenshots,
          };
        }
        progress(`实际扣款金额（免税后）: ${billedCurrency} ${billedAmount}`);

        const holderName =
          paymentResult.holderName ||
          card.card_holder ||
          billingHolderName ||
          "";
        let cardReleased = !card.id;
        if (card.id) {
          await store
            .bindCardPaymentProfile(card.id, { holderName, address })
            .catch((error) =>
              progress(`支付成功后保存卡片资料失败: ${error.message}`),
            );
          if (address.id) {
            await markAddressBound(address.id, card.id).catch((error) =>
              progress(`支付成功后更新地址绑定失败: ${error.message}`),
            );
          }
          await store.recordCardUsage(card.id).catch((error) =>
            progress(`支付成功后记录卡片使用失败: ${error.message}`),
          );
          try {
            await store.releaseCard(card.id);
            cardReleased = true;
          } catch (error) {
            progress(`支付成功后释放卡片失败: ${error.message}`);
          }
        }
        cardHandled = cardReleased;
        await store
          .createBillingRecord({
            card_number: card.card_number,
            card_last4: cardLast4,
            amount: billedAmount,
            currency: billedCurrency,
            plan_type: planType || "plus",
            cdk_code: cdkCode,
            email,
            stripe_session_id: protocolSessionId || null,
            status: "success",
          })
          .catch((error) =>
            progress(`支付成功后写入账单记录失败: ${error.message}`),
          );
        progress(
          `支付成功！卡片: ...${cardLast4}，姓名: ${holderName}，地址: ${address.line1}, ${address.city}`,
        );
        if (paymentResult.screenshot) {
          try {
            fs.unlinkSync(paymentResult.screenshot);
          } catch (_) {}
        }
        return { success: true, cardLast4, holderName, screenshots };
      }

      lastError = paymentResult.error || "支付失败";
      if (paymentResult.screenshot) {
        screenshots.push(paymentResult.screenshot);
        progress(`FAILURE_SCREENSHOT: ${paymentResult.screenshot}`);
      }

      const declined = paymentResult.declined || isPaymentDeclined(lastError);
      if (declined) {
        await store
          .createBillingRecord({
            card_number: card.card_number,
            card_last4: cardLast4,
            amount: billedAmount,
            currency: billedCurrency,
            plan_type: planType || "plus",
            cdk_code: cdkCode,
            email,
            stripe_session_id: protocolSessionId || null,
            status: "failed",
            error_code: "card_declined",
            error_message: lastError,
          })
          .catch((error) => progress(`写入拒付账单记录失败: ${error.message}`));
        progress(
          `Stripe 拒绝支付，标记卡片已报废 (ID: ${card.id || "-"}, ...${cardLast4})`,
        );
        if (card.id) {
          await store
            .markCardExhausted(card.id)
            .catch((error) => progress(`标记拒付卡片失败: ${error.message}`));
        }
        cardHandled = true;
        declinedLast4s.push(cardLast4);

        if (
          !manualCard &&
          !preferredCardId &&
          cardAttempt < MAX_CARD_ATTEMPTS &&
          paymentResult.canRetryCard !== false
        ) {
          progress(
            `卡 ...${cardLast4} 被拒，换上下一张卡 (${cardAttempt}/${MAX_CARD_ATTEMPTS})`,
          );
          continue;
        }

        const summary =
          declinedLast4s.length > 1
            ? `${declinedLast4s.length} 张卡均被拒 (...${declinedLast4s.join(", ...")})`
            : `银行卡被拒绝: ${lastError}`;
        return {
          success: false,
          error: summary,
          cardLast4: lastCardLast4,
          manualIntervention: true,
          screenshots,
          cardsDeclined: declinedLast4s.length,
        };
      }

      if (paymentResult.captchaRequired) {
        progress("检测到 Cloudflare/hCaptcha 人机验证，自动化无法可靠通过");
      }

      await store.createBillingRecord({
        card_number: card.card_number,
        card_last4: cardLast4,
        amount: billedAmount,
        currency: billedCurrency,
        plan_type: planType || "plus",
        cdk_code: cdkCode,
        email,
        stripe_session_id: protocolSessionId || null,
        status: "failed",
        error_code: "form_validation_failed",
        error_message: lastError,
      });

      progress("支付自动化失败，需人工操作");
      return {
        success: false,
        error: `需要人工操作：${lastError}`,
        cardLast4,
        manualIntervention: true,
        screenshots,
      };
    } finally {
      if (card?.id && !cardHandled) {
        await store.releaseCard(card.id).catch(() => {});
      }
    }
  }

  const summary = declinedLast4s.length
    ? `${declinedLast4s.length} 张卡均被拒 (...${declinedLast4s.join(", ...")})`
    : lastError || "支付失败";
  return {
    success: false,
    error: summary,
    cardLast4: lastCardLast4,
    manualIntervention: true,
    screenshots,
    cardsDeclined: declinedLast4s.length,
  };
}

module.exports = {
  executePaymentWithRetry,
  isPaymentDeclined,
  MAX_AUTOMATION_ATTEMPTS,
  MAX_CARD_ATTEMPTS,
};
