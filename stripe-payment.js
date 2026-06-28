/**
 * Stripe Payment Automation Module
 *
 * 在 Stripe Checkout 页面自动完成信用卡支付：
 * - 选择信用卡支付方式
 * - 填写卡号、有效期、CVC（通过 Stripe iframe）
 * - 填写持卡人姓名和账单地址
 * - 模拟人类输入行为（逐字符、随机延迟 50-200ms）
 * - 勾选服务协议、提交支付表单
 * - 检测支付结果（redirect_status=succeeded）
 */

const fs = require('fs');
const path = require('path');
const {
    isHumanVerificationVisible,
    clearHumanVerification,
    buildCaptchaRequiredError,
    hasCheckoutCaptchaOverlayText,
    isCheckoutOverlayCaptchaVisible,
    hasAnyCheckoutCaptchaSignal
} = require('./human-verification');

// ==================== Helper Functions ====================

/**
 * 返回 50-200 之间的随机整数（含两端），用于模拟人类打字延迟
 * @returns {number}
 */
function getTypingDelay() {
    return Math.floor(Math.random() * 151) + 50; // 50 to 200 inclusive
}

function randomBetween(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * 生成随机英文姓名（First + Last）
 * @returns {string}
 */
function generateRandomName() {
    const firstNames = [
        'James', 'Mary', 'Robert', 'Patricia', 'John', 'Jennifer',
        'Michael', 'Linda', 'David', 'Elizabeth', 'William', 'Barbara',
        'Richard', 'Susan', 'Joseph', 'Jessica', 'Thomas', 'Sarah',
        'Christopher', 'Karen', 'Charles', 'Lisa', 'Daniel', 'Nancy',
        'Matthew', 'Betty', 'Anthony', 'Margaret', 'Mark', 'Sandra'
    ];
    const lastNames = [
        'Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia',
        'Miller', 'Davis', 'Rodriguez', 'Martinez', 'Hernandez', 'Lopez',
        'Gonzalez', 'Wilson', 'Anderson', 'Thomas', 'Taylor', 'Moore',
        'Jackson', 'Martin', 'Lee', 'Perez', 'Thompson', 'White',
        'Harris', 'Sanchez', 'Clark', 'Ramirez', 'Lewis', 'Robinson'
    ];
    const first = firstNames[Math.floor(Math.random() * firstNames.length)];
    const last = lastNames[Math.floor(Math.random() * lastNames.length)];
    return `${first} ${last}`;
}

/**
 * 模拟人类逐字符输入：每个字符之间随机延迟 50-200ms
 * @param {import('playwright').Page | import('playwright').Frame} context - Playwright Page 或 Frame
 * @param {string} selector - CSS 选择器
 * @param {string} text - 要输入的文本
 */
async function humanType(context, selector, text) {
    await context.click(selector);
    for (const char of text) {
        await context.type(selector, char, { delay: 0 });
        const delay = getTypingDelay();
        await context.waitForTimeout(delay);
    }
}

/**
 * 在 Stripe iframe 内逐字符输入（用于卡号、有效期、CVC）
 * @param {import('playwright').Frame} frame - Stripe iframe frame
 * @param {string} selector - iframe 内的 CSS 选择器
 * @param {string} text - 要输入的文本
 */
async function humanTypeInFrame(frame, selector, text) {
    await frame.click(selector);
    for (const char of text) {
        await frame.type(selector, char, { delay: 0 });
        const delay = getTypingDelay();
        await frame.waitForTimeout(delay);
    }
}

// ==================== Screenshot Helper ====================

/**
 * 保存调试截图
 * @param {import('playwright').Page} page
 * @param {string} prefix
 * @returns {string|null} 截图路径
 */
async function saveDebugScreenshot(page, prefix) {
    try {
        const screenshotDir = path.join(__dirname, 'debug_screenshots', 'stripe');
        fs.mkdirSync(screenshotDir, { recursive: true });
        const filePath = path.join(screenshotDir, `${prefix}_${Date.now()}.png`);
        const shotOpts = { path: filePath, animations: 'disabled', timeout: 8000 };
        try {
            await page.screenshot({ ...shotOpts, fullPage: false });
        } catch (_) {
            await page.screenshot({ ...shotOpts, fullPage: true, timeout: 15000 });
        }
        console.log(`📸 [Stripe] 截图已保存: ${filePath}`);
        return filePath;
    } catch (e) {
        console.warn(`⚠️ [Stripe] 截图保存失败: ${e.message}`);
        return null;
    }
}

function normalizeCardExpiry(expiry) {
    const raw = String(expiry || '').trim();
    if (/^\d{4}$/.test(raw)) {
        return `${raw.slice(0, 2)}/${raw.slice(2)}`;
    }
    return raw;
}

function normalizeCardNumber(number) {
    return String(number || '').replace(/\s+/g, '');
}

/**
 * 在 page 及所有 iframe 中查找第一个可见的输入框
 */
async function findVisibleInput(contexts, selectors, timeout = 5000) {
    for (const ctx of contexts) {
        for (const sel of selectors) {
            try {
                const loc = ctx.locator(sel).first();
                if (await loc.isVisible({ timeout: Math.min(1000, timeout) })) {
                    return { context: ctx, selector: sel, locator: loc };
                }
            } catch (_) { /* next */ }
        }
    }
    return null;
}

/**
 * 适配 chatgpt.com/checkout/openai_llc 与 Stripe hosted 两种页面结构
 */
async function discoverCardInputs(page, timeout = 45000) {
    const deadline = Date.now() + timeout;
    const cardSelectors = [
        'input[autocomplete="cc-number"]',
        'input[name="cardnumber"]',
        'input[name="number"]',
        'input[placeholder*="1234" i]',
        'input[aria-label*="Card number" i]',
        'input[data-elements-stable-field-name="cardNumber"]'
    ];
    const expirySelectors = [
        'input[autocomplete="cc-exp"]',
        'input[name="exp-date"]',
        'input[name="expiry"]',
        'input[placeholder*="MM" i]',
        'input[aria-label*="Expiration" i]',
        'input[aria-label*="expir" i]',
        'input[data-elements-stable-field-name="cardExpiry"]'
    ];
    const cvcSelectors = [
        'input[autocomplete="cc-csc"]',
        'input[name="cvc"]',
        'input[name="cardCvc"]',
        'input[placeholder*="CVC" i]',
        'input[aria-label*="CVC" i]',
        'input[aria-label*="security code" i]',
        'input[data-elements-stable-field-name="cardCvc"]'
    ];

    while (Date.now() < deadline) {
        await prepareCheckoutCardSection(page);

        const contexts = [page, ...page.frames().filter((f) => f !== page.mainFrame())];
        const card = await findVisibleInput(contexts, cardSelectors, 1500);
        if (card) {
            const expiry = await findVisibleInput(contexts, expirySelectors, 1500);
            const cvc = await findVisibleInput(contexts, cvcSelectors, 1500);
            return { card, expiry, cvc };
        }

        await page.waitForTimeout(500);
    }

    return null;
}

async function prepareCheckoutCardSection(page) {
    await page.waitForURL(/checkout\/openai_llc|pay\.openai|checkout\.stripe|stripe\.com/i, { timeout: 5000 }).catch(() => {});
    await page.getByText(/Configure your plan|Card number|Pay with/i).first()
        .waitFor({ state: 'visible', timeout: 3000 }).catch(() => {});

    const cardLabel = page.getByText(/^Card number$/i).first();
    if (await cardLabel.isVisible({ timeout: 800 }).catch(() => false)) {
        await cardLabel.scrollIntoViewIfNeeded().catch(() => {});
    }

    const orSep = page.getByText(/^OR$/i).first();
    if (await orSep.isVisible({ timeout: 800 }).catch(() => false)) {
        await orSep.click({ timeout: 1000 }).catch(() => {});
    }
}

async function typeIntoFrameLocator(frameLocator, text) {
    const input = frameLocator.locator('input:not([type="hidden"])').first();
    await input.waitFor({ state: 'visible', timeout: 15000 });
    await input.click();
    await input.fill('');
    await input.pressSequentially(String(text), { delay: 60 });
}

/**
 * 枚举页面上所有含可见 input 的 Stripe iframe（OpenAI checkout 通常 3 个：卡号/有效期/CVC）
 */
async function collectStripeInputFrameLocators(page, timeout = 45000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        await prepareCheckoutCardSection(page);
        const iframeCount = await page.locator('iframe').count();
        const frames = [];
        for (let i = 0; i < iframeCount; i += 1) {
            const fl = page.frameLocator('iframe').nth(i);
            try {
                const input = fl.locator('input:not([type="hidden"])').first();
                if (await input.isVisible({ timeout: 600 })) {
                    frames.push(fl);
                }
            } catch (_) { /* skip */ }
        }
        if (frames.length >= 1) {
            console.log(`[Stripe] 发现 ${frames.length} 个含输入框的 iframe（页面共 ${iframeCount} 个 iframe）`);
            return frames;
        }
        await page.waitForTimeout(500);
    }
    return [];
}

async function fillCardFieldsOpenAiCheckout(page, cardInfo, timeout = 45000) {
    const cardNumber = normalizeCardNumber(cardInfo.number);
    const cardExpiry = normalizeCardExpiry(cardInfo.expiry);
    const cardCvc = String(cardInfo.cvc || '').trim();

    const frames = await collectStripeInputFrameLocators(page, timeout);
    if (frames.length >= 3) {
        await typeIntoFrameLocator(frames[0], cardNumber);
        console.log('[Stripe] ✅ 卡号已填写 (iframe[0])');
        await typeIntoFrameLocator(frames[1], cardExpiry);
        console.log('[Stripe] ✅ 有效期已填写 (iframe[1])');
        await typeIntoFrameLocator(frames[2], cardCvc);
        console.log('[Stripe] ✅ CVC 已填写 (iframe[2])');
        return { ok: true };
    }

    if (frames.length === 1) {
        const fl = frames[0];
        const inputs = fl.locator('input:not([type="hidden"])');
        const count = await inputs.count();
        console.log(`[Stripe] 单 iframe 内含 ${count} 个 input，按顺序填写`);
        if (count >= 3) {
            const in0 = inputs.nth(0);
            await in0.click(); await in0.fill(''); await in0.pressSequentially(cardNumber, { delay: 60 });
            const in1 = inputs.nth(1);
            await in1.click(); await in1.fill(''); await in1.pressSequentially(cardExpiry, { delay: 60 });
            const in2 = inputs.nth(2);
            await in2.click(); await in2.fill(''); await in2.pressSequentially(cardCvc, { delay: 60 });
            console.log('[Stripe] ✅ 卡号/有效期/CVC 已填写 (单 iframe 多 input)');
            return { ok: true };
        }
    }

    // 回退：discoverCardInputs 扫描所有 frame
    const fields = await discoverCardInputs(page, 8000);
    if (fields?.card) {
        await fillLocatedInput(fields.card, cardNumber);
        if (fields.expiry) await fillLocatedInput(fields.expiry, cardExpiry);
        if (fields.cvc) await fillLocatedInput(fields.cvc, cardCvc);
        console.log('[Stripe] ✅ 卡号/有效期/CVC 已填写 (frame 扫描回退)');
        return { ok: true };
    }

    return { ok: false, error: '无法定位信用卡输入框（iframe/input）' };
}

function isOpenAiCustomCheckout(page) {
    return /checkout\/openai_llc/i.test(page.url());
}

/**
 * 从 Checkout 页面读取「今日应付」金额（随汇率浮动）
 * @returns {Promise<{ amount: number, currency: string }|null>}
 */
async function readCheckoutDueAmount(page) {
    try {
        const bodyText = String(await page.textContent('body', { timeout: 8000 }).catch(() => '') || '');
        const patterns = [
            /Due today[^\n₱$€£]{0,48}?([₱$€£])\s*([\d,]+\.\d{2})/i,
            /(?:Total due|Pay today|今日应付|应付)[^\n₱$€£]{0,48}?([₱$€£])\s*([\d,]+\.\d{2})/i,
            /([₱$€£])\s*([\d,]+\.\d{2})\s*(?:\n|$)/,
        ];
        const currencyMap = { '₱': 'PHP', '$': 'USD', '€': 'EUR', '£': 'GBP' };
        for (const re of patterns) {
            const match = bodyText.match(re);
            if (!match) continue;
            const sym = match[1];
            const amount = parseFloat(String(match[2] || '').replace(/,/g, ''));
            if (Number.isFinite(amount) && amount > 0) {
                return { amount, currency: currencyMap[sym] || null };
            }
        }
    } catch (_) { /* ignore */ }
    return null;
}

/** 菲律宾 VAT 12%：1100 PHP 含税 → 约 982.14 PHP 免税 */
const PH_VAT_RATE = 0.12;

function estimateTaxFreeAmount(taxedAmount) {
    const n = Number(taxedAmount);
    if (!Number.isFinite(n) || n <= 0) return null;
    return Math.round((n / (1 + PH_VAT_RATE)) * 100) / 100;
}

async function blurActiveBillingField(page) {
    try {
        await page.keyboard.press('Tab');
    } catch (_) { /* ignore */ }
    await page.waitForTimeout(350);
}

/**
 * 填写美国免税州后等待 Stripe 重算「Due today」
 */
async function waitForCheckoutTaxRecalculation(page, options = {}) {
    const {
        baselineAmount = null,
        maxWaitMs = 18000,
        pollMs = 700,
    } = options;

    const taxFreeTarget = baselineAmount ? estimateTaxFreeAmount(baselineAmount) : null;
    const started = Date.now();
    let lastLogged = null;

    while (Date.now() - started < maxWaitMs) {
        const due = await readCheckoutDueAmount(page);
        if (due?.amount) {
            if (taxFreeTarget != null && due.amount <= taxFreeTarget + 0.05) {
                console.log(`  [Stripe] ✅ 税区已更新，应付: ${due.currency || ''} ${due.amount}`);
                return { ok: true, due };
            }
            if (baselineAmount && due.amount < baselineAmount * 0.97) {
                console.log(`  [Stripe] ✅ 应付已从 ${baselineAmount} 降至 ${due.amount}`);
                return { ok: true, due };
            }
            if (lastLogged !== due.amount) {
                console.log(`  [Stripe] 等待税区重算… 当前应付: ${due.currency || ''} ${due.amount}`);
                lastLogged = due.amount;
            }
        }
        await page.waitForTimeout(pollMs);
    }

    const finalDue = await readCheckoutDueAmount(page);
    const stillTaxed = baselineAmount
        && finalDue?.amount
        && finalDue.amount >= baselineAmount * 0.99;
    if (stillTaxed) {
        return { ok: false, due: finalDue };
    }
    return { ok: true, due: finalDue };
}

async function ensureCheckoutTaxFreeAmount(page, address, baselineAmount) {
    const due = await readCheckoutDueAmount(page);
    if (!baselineAmount || !due?.amount) {
        return { ok: true, due };
    }

    const taxFreeMax = (estimateTaxFreeAmount(baselineAmount) || 0) + 0.05;
    if (due.amount <= taxFreeMax) {
        console.log(`  [Stripe] ✅ 免税金额确认: ${due.currency || ''} ${due.amount}`);
        return { ok: true, due };
    }

    console.warn(
        `  [Stripe] ⚠️ 仍为含税 ${due.amount}，免税应约 ${taxFreeMax.toFixed(2)}，重试州/邮编…`
    );
    const stateFullName = normalizeStateFullName(address.state);
    await selectBillingState(page, stateFullName, address.state);
    await fillBillingControl(
        page,
        [/postal code/i, /zip code/i, /邮政编码/i, /^zip$/i],
        address.postal_code,
        '邮编'
    );
    await blurActiveBillingField(page);
    const retry = await waitForCheckoutTaxRecalculation(page, { baselineAmount, maxWaitMs: 15000 });
    if (retry.ok && retry.due?.amount <= taxFreeMax) {
        return retry;
    }

    const finalDue = retry.due || due;
    const expected = estimateTaxFreeAmount(baselineAmount);
    return {
        ok: false,
        due: finalDue,
        error: `账单税区未生效，应付仍为 ${finalDue.currency || ''} ${finalDue.amount}`
            + (expected ? `（美国免税州应约 ${expected.toFixed(2)}）` : ''),
    };
}

async function captureCheckoutDueAmount(page, existing = null) {
    if (existing?.amount > 0) {
        return existing;
    }
    const due = await readCheckoutDueAmount(page);
    if (due?.amount > 0) {
        return { amount: due.amount, currency: due.currency || null };
    }
    return existing;
}

async function resolveBillingDueResult(page, taxCheck) {
    const captured = await captureCheckoutDueAmount(
        page,
        taxCheck?.due?.amount
            ? { amount: taxCheck.due.amount, currency: taxCheck.due.currency || null }
            : null
    );
    return {
        dueAmount: captured?.amount,
        dueCurrency: captured?.currency,
    };
}

async function fillLocatedInput(target, text) {
    if (!target || !text) return;
    const { context, selector } = target;
    await context.click(selector);
    await context.fill(selector, '');
    await humanType(context, selector, text);
}

/**
 * 在 Stripe Checkout 页面完成信用卡支付
 * @param {import('playwright').Page} page - Playwright Page 实例
 * @param {object} cardInfo - { number, expiry, cvc, holder }
 * @param {object} address - { line1, city, state, postal_code, country }
 * @param {object} [options] - { cardAttempt?: number, holderName?: string }
 * @returns {Promise<{ success: boolean, error?: string, screenshot?: string, declined?: boolean, canRetryCard?: boolean }>}
 */
async function completeStripeCardPayment(page, cardInfo, address, options = {}) {
    const ELEMENT_TIMEOUT = 45000;
    const cardAttempt = Number(options.cardAttempt) || 1;
    const isCardRetry = cardAttempt > 1;
    let holderName = String(options.holderName || '').trim();
    let checkoutDue = null;

    try {
        if (isCardRetry) {
            console.log(`[Stripe] 换卡重试 #${cardAttempt}：更换卡号并重新提交...`);
            await dismissCheckoutPaymentError(page);
            await prepareCheckoutCardSection(page);
            await page.waitForTimeout(800);
            console.log('[Stripe] Step 2 (重试): 填写新信用卡...');
            const retryFill = await fillCardFieldsOpenAiCheckout(page, cardInfo, ELEMENT_TIMEOUT);
            if (!retryFill.ok) {
                const screenshotPath = await saveDebugScreenshot(page, 'card_fields_not_found');
                return { success: false, error: retryFill.error || '无法定位信用卡输入框', screenshot: screenshotPath };
            }
        } else {
        console.log('[Stripe] Step 0: 等待 Checkout 支付页就绪...');
        const captchaClear = await clearHumanVerification(page, {
            phase: 'pre-fill-card',
            maxWaitMs: Number(process.env.CAPTCHA_CLEAR_TIMEOUT_MS || 90000),
            maxBypassRounds: 3,
            requireCheckoutReady: true,
            checkoutReadyWaitMs: Number(process.env.CHECKOUT_READY_WAIT_MS || 45000)
        });
        if (!captchaClear.cleared) {
            const screenshotPath = await saveDebugScreenshot(page, captchaClear.checkoutNotReady ? 'checkout_not_ready' : 'captcha_before_card_fill');
            if (captchaClear.checkoutNotReady) {
                return {
                    success: false,
                    error: 'Checkout 支付表单未能加载',
                    screenshot: screenshotPath
                };
            }
            return {
                success: false,
                error: buildCaptchaRequiredError(),
                screenshot: screenshotPath,
                captchaRequired: true
            };
        }
        await prepareCheckoutCardSection(page);
        await page.waitForTimeout(1000);

        const openAiCheckout = isOpenAiCustomCheckout(page);
        if (!openAiCheckout) {
            // 仅 Stripe hosted 页需要选择支付方式 tab
            console.log('[Stripe] Step 1: 选择信用卡支付方式...');
            try {
                const cardMethodSelectors = [
                    '[data-testid="card-tab"]',
                    '[data-testid="CARD-tab"]',
                    'button:has-text("Credit or debit card")',
                    'button:has-text("信用卡")',
                    '[data-testid="payment-method-card"]'
                ];
                for (const sel of cardMethodSelectors) {
                    try {
                        const el = page.locator(sel).first();
                        if (await el.isVisible({ timeout: 1500 })) {
                            await el.click();
                            console.log(`[Stripe] ✅ 已选择信用卡支付方式 (${sel})`);
                            break;
                        }
                    } catch (_) { /* next */ }
                }
            } catch (e) {
                console.log('[Stripe] 支付方式选择跳过:', e.message);
            }
            await page.waitForTimeout(800);
        } else {
            console.log('[Stripe] OpenAI checkout 页面，跳过支付方式选择，直接填卡');
        }

        console.log('[Stripe] Step 2: 填写信用卡字段（iframe 自动识别）...');
        const fillResult = await fillCardFieldsOpenAiCheckout(page, cardInfo, ELEMENT_TIMEOUT);
        if (!fillResult.ok) {
            const screenshotPath = await saveDebugScreenshot(page, 'card_fields_not_found');
            return { success: false, error: fillResult.error || '无法定位信用卡输入框', screenshot: screenshotPath };
        }

        // 离开卡号 iframe，点击账单区确保主文档获得焦点
        await focusOpenAiBillingSection(page);

        // 等待账单地址区域出现（chatgpt.com/checkout 在填完卡号后才会展示）
        console.log('[Stripe] Step 5: 等待账单地址表单出现...');
        await waitForBillingFields(page, 25000);
        await page.waitForTimeout(1200);

        holderName = generateRandomName();

        // Step 6: Fill billing address (after card fields) — 仅填必填项
        console.log('[Stripe] Step 6: 填写账单地址与姓名...');
        if (openAiCheckout) {
            const billingResult = await fillOpenAiCheckoutBilling(page, address, holderName);
            if (!billingResult.ok) {
                const screenshotPath = await saveDebugScreenshot(page, 'billing_address_not_filled');
                return {
                    success: false,
                    error: billingResult.error || '账单地址填写失败',
                    screenshot: screenshotPath
                };
            }
            if (billingResult.dueAmount) {
                checkoutDue = {
                    amount: billingResult.dueAmount,
                    currency: billingResult.dueCurrency || null,
                };
                console.log(
                    `[Stripe] ✅ 免税后应付: ${checkoutDue.currency || ''} ${checkoutDue.amount}`
                );
            }
            await dismissAddressAutocomplete(page);
            console.log(`[Stripe] ✅ OpenAI 账单地址已填写，姓名: ${holderName}`);
        } else {
            await fillBillingAddress(page, address);
            console.log('[Stripe] ✅ 账单地址已填写');

            // Step 7: Fill cardholder name if visible (Stripe hosted)
            console.log('[Stripe] Step 7: 填写持卡人姓名（如有）...');
            const stripeHolderName = (cardInfo.holder && cardInfo.holder.trim()) ? cardInfo.holder.trim() : holderName;
            const nameSelectors = [
                '#billingName',
                'input[name="billingName"]',
                'input[name="name"]',
                'input[autocomplete="cc-name"]',
                'input[autocomplete="name"]',
                'input[placeholder*="name" i]',
                'input[placeholder*="Name" i]',
                'input[placeholder*="全名" i]',
                '[data-testid="billingName"]'
            ];

            let nameFilled = false;
            for (const sel of nameSelectors) {
                try {
                    const el = page.locator(sel).first();
                    if (await el.isVisible({ timeout: 2000 })) {
                        await el.fill('');
                        await humanType(page, sel, stripeHolderName);
                        nameFilled = true;
                        break;
                    }
                } catch (_) { /* try next */ }
            }
            if (nameFilled) {
                console.log(`[Stripe] ✅ 持卡人姓名已填写: ${stripeHolderName}`);
            }
        }

        // Step 8: Check service agreement checkbox if present
        console.log('[Stripe] Step 8: 检查服务协议...');
        try {
            const checkboxSelectors = [
                'input[type="checkbox"][name*="agree"]',
                'input[type="checkbox"][name*="terms"]',
                'input[type="checkbox"][id*="agree"]',
                'input[type="checkbox"][id*="terms"]',
                '.CheckboxInput input[type="checkbox"]',
                '[data-testid*="agreement"] input[type="checkbox"]',
                '[data-testid*="terms"] input[type="checkbox"]',
                'input[type="checkbox"]'
            ];

            for (const sel of checkboxSelectors) {
                try {
                    const checkbox = page.locator(sel).first();
                    if (await checkbox.isVisible({ timeout: 2000 })) {
                        const isChecked = await checkbox.isChecked();
                        if (!isChecked) {
                            await checkbox.check();
                            console.log('[Stripe] ✅ 已勾选服务协议');
                        }
                        break;
                    }
                } catch (_) { /* try next */ }
            }
        } catch (e) {
            console.log('[Stripe] 未发现服务协议复选框，继续...');
        }
        }

        checkoutDue = await captureCheckoutDueAmount(page, checkoutDue);
        if (checkoutDue?.amount) {
            console.log(`[Stripe] 提交前确认应付: ${checkoutDue.currency || ''} ${checkoutDue.amount}`);
        }

        const payResult = await finalizeCheckoutPayment(page, holderName);
        if (checkoutDue?.amount) {
            payResult.dueAmount = checkoutDue.amount;
            payResult.dueCurrency = checkoutDue.currency;
        }
        return payResult;

    } catch (error) {
        console.error(`[Stripe] ❌ 支付流程异常: ${error.message}`);
        const screenshotPath = await saveDebugScreenshot(page, 'payment_exception');
        return { success: false, error: error.message, screenshot: screenshotPath };
    }
}

// ==================== Payment Result Wait ====================

const PAYMENT_RESULT_TIMEOUT_MS = Number(process.env.PAYMENT_RESULT_TIMEOUT_MS) || 180000;
const PAYMENT_RESULT_POLL_MS = 2000;

const PAYMENT_SUCCESS_PATTERNS = [
    /redirect_status=succeeded/i,
    /thank you for subscribing/i,
    /subscription is active/i,
    /subscription active/i,
    /you.?re all set/i,
    /订阅成功/i,
    /支付成功/i,
    /welcome to plus/i,
    /welcome to pro/i,
    /已成功订阅/i
];

const PAYMENT_DECLINE_PATTERNS = [
    /your card was declined/i,
    /your card has been declined/i,
    /card was declined/i,
    /card has been declined/i,
    /payment was not approved/i,
    /payment was declined/i,
    /payment could not be processed/i,
    /payment method could not be verified/i,
    /your bank may have declined/i,
    /payment details may be incorrect/i,
    /we are unable to authenticate your payment method/i,
    /payment failed/i,
    /payment was not successful/i,
    /could not be completed/i,
    /transaction (was )?(declined|failed)/i,
    /insufficient funds/i,
    /do not honor/i,
    /incorrect.*cvc/i,
    /expired card/i,
    /card number is (incorrect|invalid)/i,
    /银行卡被拒绝/i,
    /支付未(通过|成功|获批)/i,
    /未获批准/i,
    /拒付/i,
    /被拒绝/i,
    /try another (payment )?method/i,
    /try a different (card|payment)/i,
    /unable to authenticate/i
];

function buildDeclinedPaymentResult(page, msg, screenshotPath) {
    return {
        success: false,
        error: `银行卡被拒绝: ${msg}`,
        screenshot: screenshotPath,
        declined: true,
        canRetryCard: true
    };
}

/**
 * 扫描页面是否已出现 Stripe/OpenAI 拒付文案
 * @returns {Promise<string|null>}
 */
async function detectPaymentDeclineOnPage(page) {
    try {
        const bodyText = String(await page.textContent('body', { timeout: 3000 }).catch(() => '') || '');
        for (const re of PAYMENT_DECLINE_PATTERNS) {
            if (re.test(bodyText)) {
                const match = bodyText.match(re);
                return match ? match[0] : 'card declined';
            }
        }

        const alerts = page.getByRole('alert');
        const alertCount = await alerts.count();
        for (let i = 0; i < alertCount; i += 1) {
            const alertText = String(await alerts.nth(i).textContent({ timeout: 500 }).catch(() => '') || '');
            if (!alertText.trim()) continue;
            if (PAYMENT_DECLINE_PATTERNS.some((re) => re.test(alertText))) {
                return alertText.trim();
            }
        }
    } catch (_) { /* ignore */ }
    return null;
}

async function dismissCheckoutPaymentError(page) {
    const dismissSelectors = [
        '[role="alert"] button',
        '[role="alert"] [aria-label="Close"]',
        'button[aria-label="Close"]',
        'button[aria-label="Dismiss"]'
    ];
    for (const sel of dismissSelectors) {
        try {
            const btn = page.locator(sel).first();
            if (await btn.isVisible({ timeout: 800 })) {
                await btn.click({ timeout: 2000 });
                console.log('[Stripe] 已关闭拒付提示条');
                await page.waitForTimeout(400);
                return;
            }
        } catch (_) { /* try next */ }
    }
}

/**
 * 提交后并行等待：hCaptcha 弹层 vs 直接拒付（避免无验证拒付时空等 45s）
 */
async function handlePostSubmitPhase(page) {
    const overlayWaitMs = Number(process.env.CAPTCHA_OVERLAY_WAIT_MS || 45000);
    const pollMs = Number(process.env.POST_SUBMIT_POLL_MS || 500);
    const startedAt = Date.now();
    const deadline = startedAt + overlayWaitMs;
    let captchaDetected = false;
    let lastLogSec = -1;

    console.log(`[Stripe] Step 9.5: 并行等待 hCaptcha 弹层或拒付结果（最长 ${Math.round(overlayWaitMs / 1000)}s）...`);

    while (Date.now() < deadline) {
        const declineMsg = await detectPaymentDeclineOnPage(page);
        if (declineMsg) {
            console.log(`[Stripe] ❌ 提交后快速检测到拒付（未出现验证）: ${declineMsg}`);
            const screenshotPath = await saveDebugScreenshot(page, 'payment_declined');
            return {
                action: 'declined',
                declineMsg,
                screenshot: screenshotPath
            };
        }

        if (await hasAnyCheckoutCaptchaSignal(page)) {
            captchaDetected = true;
            console.log('[Stripe] 检测到 hCaptcha 弹层，开始自动处理...');
            break;
        }

        const url = page.url();
        if (url.includes('redirect_status=succeeded')) {
            return { action: 'success' };
        }
        if (/chatgpt\.com/i.test(url) && !/\/checkout\//i.test(url)) {
            return { action: 'success' };
        }

        const elapsedSec = Math.floor((Date.now() - startedAt) / 1000);
        if (elapsedSec >= lastLogSec + 5) {
            lastLogSec = elapsedSec;
            console.log(`[Captcha/overlay-wait][INFO] 仍在等待 hCaptcha 或拒付结果… (${elapsedSec}s)`);
        }

        await page.waitForTimeout(pollMs);
    }

    if (!captchaDetected) {
        console.log('[Stripe] 等待期内未检测到 hCaptcha，继续等待支付结果');
        return { action: 'continue' };
    }

    const postCaptcha = await clearHumanVerification(page, {
        phase: 'post_submit',
        maxWaitMs: Number(process.env.CAPTCHA_POST_SUBMIT_TIMEOUT_MS || 180000),
        maxBypassRounds: Number(process.env.CAPTCHA_POST_SUBMIT_MAX_ROUNDS || 8),
        requireCheckoutReady: false,
        useVisualSolver: true,
        overlayWaitMs: 0
    });

    if (!postCaptcha.cleared) {
        const overlayStill = await hasAnyCheckoutCaptchaSignal(page);
        if (overlayStill) {
            const screenshotPath = await saveDebugScreenshot(page, 'captcha_post_submit');
            console.log('[Stripe] ❌ 提交后人机验证未能自动通过');
            return {
                action: 'captcha_failed',
                error: buildCaptchaRequiredError(),
                screenshot: screenshotPath
            };
        }
        console.log('[Stripe] ⚠️ 提交后验证未能自动清除（无可见弹层）');
    } else if (postCaptcha.via === 'visual-solver') {
        console.log('[Stripe] ✅ 提交后 hCaptcha 已由视觉求解器通过');
    } else if (!postCaptcha.skipped) {
        console.log('[Stripe] ✅ 提交后人机验证已通过');
    }

    return { action: 'continue', captcha: postCaptcha };
}

async function finalizeCheckoutPayment(page, holderName) {
    console.log('[Stripe] Step 9: 点击订阅/支付...');
    const submitted = await clickCheckoutSubmitButton(page);
    if (!submitted) {
        const screenshotPath = await saveDebugScreenshot(page, 'submit_not_found');
        return { success: false, error: '无法找到提交/支付按钮', screenshot: screenshotPath };
    }

    const postResult = await handlePostSubmitPhase(page);
    if (postResult.action === 'declined') {
        return buildDeclinedPaymentResult(page, postResult.declineMsg, postResult.screenshot);
    }
    if (postResult.action === 'captcha_failed') {
        return {
            success: false,
            error: postResult.error,
            screenshot: postResult.screenshot,
            captchaRequired: true
        };
    }
    if (postResult.action === 'success') {
        console.log('[Stripe] ✅ 支付成功！');
        const screenshotPath = await saveDebugScreenshot(page, 'payment_success');
        return { success: true, holderName, screenshot: screenshotPath };
    }

    const paymentOutcome = await waitForPaymentResult(page, holderName);
    if (paymentOutcome.success) {
        console.log('[Stripe] ✅ 支付成功！');
        return {
            success: true,
            holderName: paymentOutcome.holderName,
            screenshot: paymentOutcome.screenshot
        };
    }
    if (paymentOutcome.error && PAYMENT_DECLINE_PATTERNS.some((re) => re.test(paymentOutcome.error))) {
        return {
            ...paymentOutcome,
            declined: true,
            canRetryCard: true
        };
    }
    return paymentOutcome;
}

/**
 * 点击 Subscribe 后轮询等待：处理加载中、成功跳转、拒付文案
 */
async function buildPaymentSuccessResult(page, holderName) {
    const screenshotPath = await saveDebugScreenshot(page, 'payment_success');
    return { success: true, holderName, screenshot: screenshotPath };
}

async function waitForPaymentResult(page, holderName) {
    const maxSec = Math.round(PAYMENT_RESULT_TIMEOUT_MS / 1000);
    console.log(`[Stripe] Step 10: 等待支付结果（最长 ${maxSec}s，含 Stripe 处理中）...`);
    page.setDefaultTimeout(Math.max(PAYMENT_RESULT_TIMEOUT_MS, 120000));

    const deadline = Date.now() + PAYMENT_RESULT_TIMEOUT_MS;
    let lastProgressLog = 0;
    let lastLiveShot = 0;
    let captchaAttempts = 0;

    while (Date.now() < deadline) {
        const url = page.url();

        const captchaBlocking = await hasAnyCheckoutCaptchaSignal(page)
            || await isHumanVerificationVisible(page);

        if (captchaBlocking) {
            captchaAttempts += 1;
            console.log(`[Stripe] 检测到人机验证弹层，开始第 ${captchaAttempts} 次自动处理...`);
            const captchaResult = await clearHumanVerification(page, {
                phase: `payment-poll-${captchaAttempts}`,
                maxWaitMs: Number(process.env.CAPTCHA_POST_SUBMIT_TIMEOUT_MS || 180000),
                maxBypassRounds: Number(process.env.CAPTCHA_POST_SUBMIT_MAX_ROUNDS || 8),
                requireCheckoutReady: false,
                useVisualSolver: true,
                overlayWaitMs: 0
            });
            if (captchaResult.cleared) {
                console.log('[Stripe] ✅ 人机验证已通过，继续等待支付结果');
                continue;
            }
            const screenshotPath = await saveDebugScreenshot(page, 'captcha_challenge_required');
            console.log('[Stripe] ❌ 人机验证无法自动通过，需人工处理（hCaptcha/Cloudflare）');
            return {
                success: false,
                error: buildCaptchaRequiredError(),
                screenshot: screenshotPath,
                captchaRequired: true
            };
        }

        if (url.includes('redirect_status=succeeded')) {
            console.log('[Stripe] ✅ URL 含 redirect_status=succeeded');
            return buildPaymentSuccessResult(page, holderName);
        }

        if (/chatgpt\.com/i.test(url) && !/\/checkout\//i.test(url)) {
            console.log('[Stripe] ✅ 已离开 checkout 页面');
            return buildPaymentSuccessResult(page, holderName);
        }

        const bodyText = String(await page.textContent('body', { timeout: 8000 }).catch(() => '') || '');

        for (const re of PAYMENT_DECLINE_PATTERNS) {
            if (re.test(bodyText)) {
                const match = bodyText.match(re);
                const msg = match ? match[0] : 'card declined';
                console.log(`[Stripe] ❌ 检测到拒付/失败: ${msg}`);
                const screenshotPath = await saveDebugScreenshot(page, 'payment_declined');
                return buildDeclinedPaymentResult(page, msg, screenshotPath);
            }
        }

        for (const re of PAYMENT_SUCCESS_PATTERNS) {
            if (re.test(bodyText)) {
                console.log(`[Stripe] ✅ 页面文案确认支付成功`);
                return buildPaymentSuccessResult(page, holderName);
            }
        }

        try {
            const alerts = page.getByRole('alert');
            const alertCount = await alerts.count();
            for (let i = 0; i < alertCount; i += 1) {
                const alertText = String(await alerts.nth(i).textContent({ timeout: 500 }).catch(() => '') || '');
                if (!alertText.trim()) continue;
                if (PAYMENT_DECLINE_PATTERNS.some((re) => re.test(alertText))) {
                    console.log(`[Stripe] ❌ Alert 拒付: ${alertText.trim()}`);
                    const screenshotPath = await saveDebugScreenshot(page, 'payment_declined');
                    return buildDeclinedPaymentResult(page, alertText.trim(), screenshotPath);
                }
            }
        } catch (_) { /* no alerts */ }

        const now = Date.now();
        if (now - lastProgressLog >= 15000) {
            const processing = await page.locator(
                '[aria-busy="true"], button[disabled]:has-text("Subscribe"), button[disabled]:has-text("订阅")'
            ).first().isVisible({ timeout: 800 }).catch(() => false);
            const elapsed = Math.round((now - (deadline - PAYMENT_RESULT_TIMEOUT_MS)) / 1000);
            console.log(`[Stripe] 等待支付结果 ${elapsed}s/${maxSec}s${processing ? '（Stripe 处理中…）' : ''}`);
            lastProgressLog = now;
        }

        // 等待期间每 15s 保存一次实时截图，供后台刷新查看当前页面状态
        if (now - lastLiveShot >= 15000) {
            lastLiveShot = now;
            const livePath = await saveDebugScreenshot(page, 'payment_live');
            if (livePath) {
                console.log(`LIVE_SCREENSHOT: ${livePath}`);
            }
        }

        await page.waitForTimeout(PAYMENT_RESULT_POLL_MS);
    }

    const screenshotPath = await saveDebugScreenshot(page, 'payment_result_timeout');
    if (await hasAnyCheckoutCaptchaSignal(page)
        || await isHumanVerificationVisible(page)) {
        return {
            success: false,
            error: buildCaptchaRequiredError(),
            screenshot: screenshotPath,
            captchaRequired: true
        };
    }
    return {
        success: false,
        error: `支付结果等待超时（${maxSec}s），当前 URL: ${page.url()}`,
        screenshot: screenshotPath
    };
}

// ==================== Internal Helpers ====================

/**
 * 等待并获取 Stripe iframe 的 Frame 对象
 * @param {import('playwright').Page} page
 * @param {string[]} selectors - iframe 选择器列表
 * @param {number} timeout - 超时时间 ms
 * @returns {Promise<import('playwright').Frame|null>}
 */
async function waitForStripeFrame(page, selectors, timeout) {
    const deadline = Date.now() + timeout;

    while (Date.now() < deadline) {
        for (const sel of selectors) {
            try {
                const iframeEl = page.locator(sel).first();
                if (await iframeEl.isVisible({ timeout: 1000 })) {
                    const elementHandle = await iframeEl.elementHandle();
                    if (elementHandle) {
                        const frame = await elementHandle.contentFrame();
                        if (frame) {
                            // Wait for the input inside the iframe to be ready
                            try {
                                await frame.waitForSelector('input', { timeout: 5000 });
                                return frame;
                            } catch (_) {
                                // iframe visible but input not ready yet, continue waiting
                            }
                        }
                    }
                }
            } catch (_) { /* try next selector */ }
        }
        await page.waitForTimeout(500);
    }

    return null;
}

async function waitForBillingFields(page, timeout = 20000) {
    // 原生 select 常被隐藏 → 用 count() 判断是否已挂载，而非 isVisible
    const attachedSelectors = [
        '#billingAddress-countryInput',
        'select[name="country"]',
        '#billingAddress-administrativeAreaInput',
        'select[name="administrativeArea"]'
    ];
    const visibleSelectors = [
        '#billingAddress-nameInput',
        'input[autocomplete="billing name"]',
        'input[name="addressLine1"]',
        'input[autocomplete="billing address-line1"]',
        'input[autocomplete="address-line1"]',
        '#billingAddressLine1'
    ];
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        for (const sel of attachedSelectors) {
            try {
                if ((await page.locator(sel).count()) > 0) {
                    return true;
                }
            } catch (_) { /* continue */ }
        }
        for (const sel of visibleSelectors) {
            try {
                if (await page.locator(sel).first().isVisible({ timeout: 300 })) {
                    return true;
                }
            } catch (_) { /* continue */ }
        }
        await page.waitForTimeout(500);
    }
    console.warn('[Stripe] ⚠️ 账单地址字段未在超时内出现，将尝试继续填写');
    return false;
}

const OPENAI_BILLING_FIELD_SELECTORS = {
    name: [
        '#billingAddress-nameInput',
        'input[name="name"][autocomplete="billing name"]',
        'input[autocomplete="billing name"]'
    ],
    country: [
        '#billingAddress-countryInput',
        'select[name="country"][autocomplete="billing country"]',
        'select[name="country"]'
    ],
    line1: [
        '#billingAddress-addressLine1Input',
        '#billingAddressLine1',
        'input[name="addressLine1"]',
        'input[name="billingAddressLine1"]',
        'input[autocomplete="billing address-line1"]',
        'input[autocomplete="address-line1"]',
        'input.pac-target-input',
        'input[placeholder*="Address line 1" i]',
        'input[placeholder*="Street" i]'
    ],
    city: [
        '#billingAddress-localityInput',
        'input[name="locality"]',
        'input[autocomplete="billing address-level2"]'
    ],
    postal: [
        '#billingAddress-postalCodeInput',
        'input[name="postalCode"]',
        'input[autocomplete="billing postal-code"]'
    ],
    state: [
        '#billingAddress-administrativeAreaInput',
        'select[name="administrativeArea"]',
        'select[autocomplete="billing address-level1"]'
    ]
};

async function resolveElementTag(el) {
    return el.evaluate((node) => node.tagName.toLowerCase()).catch(() => '');
}

async function fillFirstVisibleSelector(page, selectors, value, logLabel, waitMs = 8000) {
    if (value === undefined || value === null || String(value) === '') return false;
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
        for (const sel of selectors) {
            try {
                const el = page.locator(sel).first();
                if ((await el.count()) === 0) continue;
                const tag = await resolveElementTag(el);
                if (tag === 'select') continue;
                if (!(await el.isVisible({ timeout: 300 }).catch(() => false))) continue;
                const current = String(await el.inputValue({ timeout: 500 }).catch(() => '')).trim();
                if (current) {
                    console.log(`  [Stripe] ⏭️ ${logLabel} 已有值，跳过`);
                    return true;
                }
                await el.scrollIntoViewIfNeeded();
                await el.click({ timeout: 2000 });
                await el.fill(String(value));
                console.log(`  [Stripe] ✅ ${logLabel}: ${value}`);
                return true;
            } catch (_) { /* next selector */ }
        }
        await page.waitForTimeout(500);
    }
    return false;
}

async function selectFirstVisibleSelect(page, selectors, optionLabels, logLabel, waitMs = 8000) {
    const options = [...new Set(optionLabels.map(String).filter(Boolean))];
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
        for (const sel of selectors) {
            try {
                const el = page.locator(sel).first();
                if ((await el.count()) === 0) continue;
                const tag = await resolveElementTag(el);
                if (tag !== 'select') {
                    if (!(await el.isVisible({ timeout: 300 }).catch(() => false))) continue;
                    const ok = await selectBillingComboboxItem(page, { el }, options, logLabel);
                    if (ok) return true;
                    continue;
                }
                // 原生 <select> 常被视觉隐藏（自定义下拉覆盖），不要求 visible，直接 selectOption
                for (const opt of options) {
                    try {
                        await el.selectOption({ label: opt }, { timeout: 2000 });
                        console.log(`  [Stripe] ✅ ${logLabel}: ${opt}`);
                        await page.waitForTimeout(600);
                        return true;
                    } catch (_) { /* next */ }
                    try {
                        await el.selectOption({ value: opt }, { timeout: 2000 });
                        console.log(`  [Stripe] ✅ ${logLabel}: ${opt} (value)`);
                        await page.waitForTimeout(600);
                        return true;
                    } catch (_) { /* next */ }
                }
            } catch (_) { /* next selector */ }
        }
        await page.waitForTimeout(500);
    }
    return false;
}

async function getCurrentBillingCountryValue(page) {
    for (const sel of OPENAI_BILLING_FIELD_SELECTORS.country) {
        try {
            const el = page.locator(sel).first();
            if (!(await el.isVisible({ timeout: 800 }))) continue;
            const tag = await resolveElementTag(el);
            if (tag !== 'select') continue;
            const value = await el.inputValue().catch(() => '');
            const label = await el.evaluate((node) => {
                const opt = node.options[node.selectedIndex];
                return opt ? opt.textContent.trim() : '';
            }).catch(() => '');
            return { value, label };
        } catch (_) { /* next */ }
    }
    return { value: '', label: '' };
}

const US_STATE_LABELS = {
    OR: 'Oregon',
    DE: 'Delaware',
    MT: 'Montana',
    NH: 'New Hampshire',
    AK: 'Alaska'
};

function normalizeStateFullName(state) {
    const raw = String(state || '').trim();
    if (!raw) return raw;
    const upper = raw.toUpperCase();
    if (US_STATE_LABELS[upper]) return US_STATE_LABELS[upper];
    return raw;
}

async function fillInputLocator(locator, value, label = '字段') {
    if (!value) return false;
    try {
        console.log(`  [Stripe] 填写 ${label}...`);
        await locator.waitFor({ state: 'visible', timeout: 3000 });
        await locator.scrollIntoViewIfNeeded();
        await locator.click({ timeout: 2000 });
        await locator.fill(String(value));
        return true;
    } catch (_) {
        console.log(`  [Stripe] ⚠️ ${label} 跳过（未找到或不可填）`);
        return false;
    }
}

/**
 * 在 page 及所有 frame 中按多种策略查找可填控件
 */
// 禁用 Google Places 地址联想下拉（分字段填地址时不能选建议项，否则会卡住支付）
async function suppressGoogleAddressAutocomplete(page) {
    await page.evaluate(() => {
        if (!document.getElementById('stripe-hide-pac')) {
            const style = document.createElement('style');
            style.id = 'stripe-hide-pac';
            style.textContent = '.pac-container{display:none!important;visibility:hidden!important;pointer-events:none!important;}';
            (document.head || document.documentElement).appendChild(style);
        }
        document.querySelectorAll('.pac-container').forEach((el) => {
            el.style.display = 'none';
            el.style.visibility = 'hidden';
        });
    }).catch(() => { });
}

// 关闭 Address line 1 触发的 Google Places 自动补全下拉（我们分字段填地址，不能选建议项）
async function dismissAddressAutocomplete(page) {
    try {
        const suggestion = page.getByText(/Suggestions powered by Google/i).first();
        const hadDropdown = await suggestion.isVisible({ timeout: 800 }).catch(() => false);
        if (hadDropdown) {
            console.log('  [Stripe] 检测到 Google 地址联想下拉，正在关闭...');
        }

        // 1) 优先点击下拉里的关闭按钮（× icon）
        if (hadDropdown) {
            const closeBtn = page.locator('[aria-label*="close" i], [aria-label*="关闭" i], button:has-text("×")').first();
            if (await closeBtn.isVisible({ timeout: 400 }).catch(() => false)) {
                await closeBtn.click({ timeout: 1000 }).catch(() => { });
                await page.waitForTimeout(200);
            }
        }

        // 2) 主动让当前聚焦元素失焦 + 移除 Google 注入的 pac-container
        await page.evaluate(() => {
            try { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); } catch (_) { }
            try {
                document.querySelectorAll('.pac-container').forEach((el) => { el.style.display = 'none'; });
            } catch (_) { }
        }).catch(() => { });

        // 3) 连按两次 Escape
        await page.keyboard.press('Escape').catch(() => { });
        await page.waitForTimeout(150);
        await page.keyboard.press('Escape').catch(() => { });
        await page.waitForTimeout(150);

        // 4) 点击中性区域（右侧套餐卡 / 账单标题）彻底收起下拉
        const heading = page.getByText(/^\s*Billing address\s*$|^\s*账单地址\s*$/i).first();
        if (await heading.isVisible({ timeout: 600 }).catch(() => false)) {
            await heading.click({ timeout: 1000 }).catch(() => { });
        } else {
            await page.mouse.click(12, 12).catch(() => { });
        }
        await page.waitForTimeout(300);

        // 5) 终检：仍在则再 Escape + 隐藏
        if (await suggestion.isVisible({ timeout: 400 }).catch(() => false)) {
            await page.keyboard.press('Escape').catch(() => { });
            await page.evaluate(() => {
                document.querySelectorAll('.pac-container').forEach((el) => { el.style.display = 'none'; });
            }).catch(() => { });
            await page.waitForTimeout(200);
            const still = await suggestion.isVisible({ timeout: 300 }).catch(() => false);
            console.log(`  [Stripe] ${still ? '⚠️ 地址联想下拉仍可见' : '✅ 地址联想下拉已关闭'}`);
        } else if (hadDropdown) {
            console.log('  [Stripe] ✅ 地址联想下拉已关闭');
        }
    } catch (_) { /* best-effort */ }
}

async function focusOpenAiBillingSection(page) {
    await page.locator('body').click({ position: { x: 12, y: 12 }, timeout: 2000 }).catch(() => { });
    await page.keyboard.press('Escape').catch(() => { });
    const heading = page.getByText(/^Billing address$|^账单地址$/i).first();
    await heading.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => { });
    await heading.click({ timeout: 5000 }).catch(() => { });
    await page.waitForTimeout(700);
}

async function getBillingInputsBelowHeading(page) {
    const heading = page.getByText(/^Billing address$|^账单地址$/i).first();
    await heading.waitFor({ state: 'visible', timeout: 10000 });
    const headingBox = await heading.boundingBox().catch(() => null);
    const minY = headingBox ? headingBox.y - 6 : 0;

    const controls = page.locator('input:visible, select:visible, textarea:visible, [role="combobox"]:visible');
    const count = await controls.count();
    const items = [];

    for (let i = 0; i < count; i += 1) {
        const el = controls.nth(i);
        const visible = await el.isVisible({ timeout: 200 }).catch(() => false);
        if (!visible) continue;
        const box = await el.boundingBox().catch(() => null);
        if (box && box.y < minY) continue;

        const meta = await el.evaluate((node) => {
            const labelFromFor = () => {
                const id = node.id;
                if (!id) return '';
                const lbl = document.querySelector(`label[for="${CSS.escape(id)}"]`);
                return lbl ? (lbl.textContent || '').trim() : '';
            };
            const labelFromWrap = () => {
                const lbl = node.closest('label');
                return lbl ? (lbl.textContent || '').trim() : '';
            };
            const labelFromAria = () => {
                const labelledBy = node.getAttribute('aria-labelledby');
                if (!labelledBy) return '';
                const parts = labelledBy.split(/\s+/).map((id) => {
                    const n = document.getElementById(id);
                    return n ? (n.textContent || '').trim() : '';
                }).filter(Boolean);
                return parts.join(' ');
            };
            const labelFromParent = () => {
                let parent = node.parentElement;
                for (let depth = 0; depth < 4 && parent; depth += 1) {
                    const lbl = parent.querySelector(':scope > label, :scope > span, :scope > div');
                    const text = lbl ? (lbl.textContent || '').trim() : '';
                    if (text && text.length < 80) return text;
                    parent = parent.parentElement;
                }
                return '';
            };
            return {
                tag: node.tagName.toLowerCase(),
                type: node.getAttribute('type') || '',
                autocomplete: node.getAttribute('autocomplete') || '',
                placeholder: node.getAttribute('placeholder') || '',
                ariaLabel: node.getAttribute('aria-label') || '',
                name: node.getAttribute('name') || '',
                role: node.getAttribute('role') || '',
                id: node.id || '',
                className: node.className || '',
                labelText: labelFromFor() || labelFromWrap() || labelFromAria() || labelFromParent()
            };
        }).catch(() => null);
        if (!meta) continue;

        const hay = `${meta.autocomplete} ${meta.placeholder} ${meta.ariaLabel} ${meta.name} ${meta.labelText} ${meta.id} ${meta.className}`.toLowerCase();
        if (/^(email|tel|number|password)$/.test(meta.type)) continue;
        if (/email|phone|mobile|card|cvc|cc-|expir|security code|contact/.test(hay)) continue;

        items.push({ el, box, meta, hay, y: box.y, x: box.x });
    }

    items.sort((a, b) => a.y - b.y || a.x - b.x);
    return items;
}

async function fillBillingTextItem(item, value, logLabel) {
    if (!item?.el || value === undefined || value === null || value === '') return false;
    try {
        await item.el.scrollIntoViewIfNeeded();
        await item.el.click({ timeout: 3000 });
        await item.el.fill(String(value));
        console.log(`  [Stripe] ✅ ${logLabel}: ${value}`);
        return true;
    } catch (error) {
        console.log(`  [Stripe] ⚠️ ${logLabel} 填写失败: ${error.message}`);
        return false;
    }
}

async function pickBillingItem(items, matchers) {
    for (const item of items) {
        if (matchers.some((re) => re.test(item.hay))) {
            return item;
        }
    }
    return null;
}

async function selectBillingComboboxItem(page, item, optionLabels, logLabel) {
    if (!item?.el) return false;
    const options = optionLabels.filter(Boolean);
    try {
        await item.el.scrollIntoViewIfNeeded();
        let tag = String(item.meta?.tag || '').toLowerCase();
        if (!tag || tag === 'unknown') {
            tag = await resolveElementTag(item.el);
        }
        if (tag === 'select') {
            for (const opt of options) {
                try {
                    await item.el.selectOption({ label: String(opt) });
                    console.log(`  [Stripe] ✅ ${logLabel}: ${opt}`);
                    await page.waitForTimeout(600);
                    return true;
                } catch (_) { /* next */ }
                try {
                    await item.el.selectOption({ value: String(opt) });
                    console.log(`  [Stripe] ✅ ${logLabel}: ${opt} (value)`);
                    await page.waitForTimeout(600);
                    return true;
                } catch (_) { /* next */ }
            }
            return false;
        }

        if (tag === 'input' || tag === 'textarea') {
            await item.el.fill(String(options[0] || ''));
            await page.keyboard.press('ArrowDown').catch(() => { });
            await page.keyboard.press('Enter').catch(() => { });
            console.log(`  [Stripe] ✅ ${logLabel}: ${options[0]} (typeahead)`);
            return true;
        }

        await item.el.click({ timeout: 3000 });
        await page.waitForTimeout(350);
        for (const opt of options) {
            try {
                const option = page.getByRole('option', { name: opt }).first();
                if (await option.isVisible({ timeout: 1200 })) {
                    await option.click({ timeout: 2000 });
                    console.log(`  [Stripe] ✅ ${logLabel}: ${opt}`);
                    return true;
                }
            } catch (_) { /* next */ }
            try {
                await page.getByText(opt, { exact: true }).click({ timeout: 1200 });
                console.log(`  [Stripe] ✅ ${logLabel}: ${opt}`);
                return true;
            } catch (_) { /* next */ }
        }
    } catch (error) {
        console.log(`  [Stripe] ⚠️ ${logLabel} 选择失败: ${error.message}`);
    }
    return false;
}

async function fillOpenAiBillingDirect(page, address, fullName, baselineAmount = null) {
    const stateFullName = normalizeStateFullName(address.state);
    const countryCode = String(address.country || 'US').trim().toUpperCase() || 'US';
    const filled = { name: false, country: false, line1: false, city: false, postal: false, state: false };

    const directWait = 2500;
    console.log('  [Stripe] 税区优先：国家 → 州 → 邮编 → 街道/城市 → 姓名');

    const currentCountry = await getCurrentBillingCountryValue(page);
    const alreadyUs = currentCountry.value === 'US'
        || /united states/i.test(currentCountry.label)
        || /美国/.test(currentCountry.label);
    if (alreadyUs) {
        filled.country = true;
        console.log('  [Stripe] ✅ 国家已是 United States');
    } else {
        filled.country = await selectFirstVisibleSelect(
            page,
            OPENAI_BILLING_FIELD_SELECTORS.country,
            ['United States', '美国', 'US', countryCode],
            '国家',
            directWait
        );
    }

    if (filled.country) {
        await page.waitForTimeout(1500);
        await blurActiveBillingField(page);
        await waitForCheckoutTaxRecalculation(page, { baselineAmount });
        const line1Deadline = Date.now() + 10000;
        while (Date.now() < line1Deadline) {
            const line1Input = await locateBillingLine1Input(page).catch(() => null);
            if (line1Input) break;
            await page.waitForTimeout(400);
        }
    }

    filled.state = await selectFirstVisibleSelect(
        page,
        OPENAI_BILLING_FIELD_SELECTORS.state,
        [stateFullName, address.state, address.state?.toUpperCase?.()].filter(Boolean),
        '州/省',
        directWait
    );
    if (filled.state) {
        await blurActiveBillingField(page);
        await waitForCheckoutTaxRecalculation(page, { baselineAmount });
    }

    filled.postal = await fillFirstVisibleSelector(
        page,
        OPENAI_BILLING_FIELD_SELECTORS.postal,
        address.postal_code,
        '邮编',
        directWait
    );
    if (filled.postal) {
        await blurActiveBillingField(page);
        await waitForCheckoutTaxRecalculation(page, { baselineAmount });
    }

    filled.line1 = await fillBillingLine1Strict(page, address.line1);
    if (!filled.line1) {
        filled.line1 = await fillFirstVisibleSelector(
            page,
            OPENAI_BILLING_FIELD_SELECTORS.line1,
            address.line1,
            '街道地址',
            directWait
        );
    }
    filled.city = await fillFirstVisibleSelector(
        page,
        OPENAI_BILLING_FIELD_SELECTORS.city,
        address.city,
        '城市',
        directWait
    );
    filled.name = await fillFirstVisibleSelector(
        page,
        OPENAI_BILLING_FIELD_SELECTORS.name,
        fullName,
        '账单全名',
        directWait
    );

    return filled;
}

async function fillOpenAiBillingBySectionMeta(page, address, fullName) {
    const stateFullName = normalizeStateFullName(address.state);
    const countryOptions = ['United States', '美国', 'US'];
    const filled = { name: false, country: false, line1: false, city: false, postal: false, state: false };

    await focusOpenAiBillingSection(page);
    let items = await getBillingInputsBelowHeading(page);
    console.log(`  [Stripe] Billing 区可见控件: ${items.length} 个`);

    if (items.length === 0) {
        await page.waitForTimeout(1500);
        items = await getBillingInputsBelowHeading(page);
        console.log(`  [Stripe] 重试后 Billing 区控件: ${items.length} 个`);
    }

    const nameItem = await pickBillingItem(items, [/full name/, /billing name/, /^name$/, /姓名/, /全名/])
        || items.find((item) => /name/.test(item.hay) && !/country|address|city|state|postal|zip/.test(item.hay))
        || items[0];
    filled.name = await fillBillingTextItem(nameItem, fullName, '账单全名');

    const nameIndex = nameItem ? items.indexOf(nameItem) : -1;
    const afterName = nameIndex >= 0 ? items.slice(nameIndex + 1) : items;
    const countryItem = await pickBillingItem(afterName, [/country/, /region/, /国家/, /地区/])
        || afterName.find((item) => item.meta.tag === 'select' || item.meta.role === 'combobox');
    const countryAlreadyUs = await page.getByText(/^United States$|^美国$/).first()
        .isVisible({ timeout: 600 })
        .catch(() => false);
    if (countryAlreadyUs) {
        filled.country = true;
        console.log('  [Stripe] ✅ 国家已是 United States');
    } else if (countryItem) {
        filled.country = await selectBillingComboboxItem(page, countryItem, countryOptions, '国家');
        if (filled.country) {
            await page.waitForTimeout(1200);
            items = await getBillingInputsBelowHeading(page);
        }
    }

    const line1Item = await findBillingLine1ItemAfterCountry(page)
        || await pickBillingItem(items, [/address-line1/, /address line 1/, /line1/, /street/]);
    if (line1Item?.el) {
        filled.line1 = await fillBillingLine1Element(line1Item.el, address.line1, 'section-meta');
    } else {
        filled.line1 = await fillBillingLine1Strict(page, address.line1);
    }

    const cityItem = await pickBillingItem(items, [/address-level2/, /^city$/, /城市/]);
    filled.city = await fillBillingTextItem(cityItem, address.city, '城市');

    const stateItem = await pickBillingItem(items, [/address-level1/, /^state$/, /^province$/, /州/, /省/]);
    if (stateItem) {
        filled.state = await selectBillingComboboxItem(
            page,
            stateItem,
            [stateFullName, address.state].filter(Boolean),
            '州'
        );
    }

    const postalItem = await pickBillingItem(items, [/postal-code/, /postal code/, /zip code/, /^zip$/, /邮编/, /邮政/]);
    filled.postal = await fillBillingTextItem(postalItem, address.postal_code, '邮编');

    return filled;
}

async function findBillingControl(page, labelPatterns, role = 'textbox') {
    const patterns = Array.isArray(labelPatterns) ? labelPatterns : [labelPatterns];

    for (const pat of patterns) {
        try {
            const byPlaceholder = page.getByPlaceholder(pat, { exact: false });
            const phCount = await byPlaceholder.count();
            for (let i = phCount - 1; i >= 0; i -= 1) {
                const el = byPlaceholder.nth(i);
                if (await el.isVisible({ timeout: 800 }).catch(() => false)) {
                    return el;
                }
            }
        } catch (_) { /* next */ }

        try {
            const byLabel = page.getByLabel(pat, { exact: false });
            const count = await byLabel.count();
            for (let i = count - 1; i >= 0; i -= 1) {
                const el = byLabel.nth(i);
                if (await el.isVisible({ timeout: 800 }).catch(() => false)) {
                    return el;
                }
            }
        } catch (_) { /* next */ }

        try {
            const byRole = page.getByRole(role, { name: pat });
            const count = await byRole.count();
            for (let i = count - 1; i >= 0; i -= 1) {
                const el = byRole.nth(i);
                if (await el.isVisible({ timeout: 800 }).catch(() => false)) {
                    return el;
                }
            }
        } catch (_) { /* next */ }

        try {
            const fieldBox = page.locator('div, fieldset, label').filter({ hasText: pat }).last();
            const nested = fieldBox.locator('input:visible, select:visible, [role="combobox"]:visible, textarea:visible').first();
            if (await nested.isVisible({ timeout: 800 }).catch(() => false)) {
                return nested;
            }
            const following = fieldBox.locator('xpath=following::input[not(@type="hidden")][1] | following::select[1]');
            if (await following.first().isVisible({ timeout: 800 }).catch(() => false)) {
                return following.first();
            }
        } catch (_) { /* next */ }
    }

    for (const frame of page.frames()) {
        if (frame === page.mainFrame()) continue;
        for (const pat of patterns) {
            try {
                const el = frame.getByLabel(pat, { exact: false }).first();
                if (await el.isVisible({ timeout: 500 }).catch(() => false)) {
                    return el;
                }
            } catch (_) { /* next */ }
        }
    }
    return null;
}

async function fillBillingControl(page, labelPatterns, value, logLabel) {
    if (value === undefined || value === null || String(value) === '') {
        return false;
    }

    const isLine1 = /街道|line\s*1|address line/i.test(logLabel);
    const fieldPatterns = isLine1
        ? [/address line 1/i, /^address line 1$/i, /street address/i, /^address$/i]
        : (Array.isArray(labelPatterns) ? labelPatterns : [labelPatterns]);

    console.log(`  [Stripe] 填写 ${logLabel}...`);
    const field = await findBillingControl(page, fieldPatterns, 'textbox');
    if (!field) {
        console.log(`  [Stripe] ⚠️ ${logLabel} 未找到`);
        return false;
    }
    try {
        const tag = await resolveElementTag(field);
        if (tag === 'select') {
            return selectBillingComboboxItem(page, { el: field }, [String(value)], logLabel);
        }

        const current = String(await field.inputValue({ timeout: 1000 }).catch(() => '')).trim();
        if (current) {
            console.log(`  [Stripe] ⏭️ ${logLabel} 已有值 (${current.slice(0, 24)}...)，跳过`);
            return true;
        }

        await field.scrollIntoViewIfNeeded();
        await dismissAddressAutocomplete(page);
        if (isLine1) {
            await suppressGoogleAddressAutocomplete(page);
            const ok = await fillBillingLine1Element(field, value, 'fillBillingControl');
            if (ok) {
                await dismissAddressAutocomplete(page);
            }
            return ok;
        }
        await field.click({ timeout: 2000 });
        await field.fill(String(value));

        const val = String(await field.inputValue({ timeout: 1000 }).catch(() => '')).trim();
        if (!val) {
            console.log(`  [Stripe] ⚠️ ${logLabel} 填写后仍为空`);
            return false;
        }
        console.log(`  [Stripe] ✅ ${logLabel}: ${value}`);
        return true;
    } catch (e) {
        console.log(`  [Stripe] ⚠️ ${logLabel} 填写失败: ${e.message}`);
        return false;
    }
}

async function selectBillingCountry(page, optionLabels) {
    console.log('  [Stripe] 选择国家...');
    const ok = await selectFirstVisibleSelect(
        page,
        OPENAI_BILLING_FIELD_SELECTORS.country,
        optionLabels,
        '国家'
    );
    if (ok) return true;

    const patterns = [/country or region/i, /国家或地区/i, /^country$/i, /国家/];
    let field = null;
    for (const pat of patterns) {
        field = await findBillingControl(page, pat, 'combobox');
        if (field) break;
    }
    if (!field) {
        field = await findBillingControl(page, patterns, 'textbox');
    }
    if (!field) {
        console.log('  [Stripe] ⚠️ 国家字段未找到');
        return false;
    }

    return selectBillingComboboxItem(page, { el: field }, optionLabels, '国家');
}

async function selectBillingState(page, stateFullName, stateRaw) {
    console.log('  [Stripe] 选择州...');
    const options = [stateFullName, stateRaw].filter(Boolean);
    const ok = await selectFirstVisibleSelect(
        page,
        OPENAI_BILLING_FIELD_SELECTORS.state,
        options,
        '州/省'
    );
    if (ok) return true;

    const patterns = [/^state$/i, /^province$/i, /^州$/i, /^省$/i, /address-level1/i];
    let field = await findBillingControl(page, patterns, 'combobox');
    if (!field) {
        field = await findBillingControl(page, patterns, 'textbox');
    }
    if (!field) {
        console.log('  [Stripe] ⚠️ 州字段未找到');
        return false;
    }

    return selectBillingComboboxItem(page, { el: field }, options, '州');
}

async function locateOpenAiBillingHeading(page) {
    const heading = page.getByText(/^Billing address$|^账单地址$/i).first();
    await heading.waitFor({ state: 'visible', timeout: 10000 });
    await heading.scrollIntoViewIfNeeded();
    return heading;
}

/** 按 Billing address 标题下方的 DOM 顺序兜底填写 */
async function fillBillingByDomOrder(page, fullName, address, stateFullName) {
    console.log('  [Stripe] 尝试按 DOM 顺序兜底填写...');
    const items = await getBillingInputsBelowHeading(page);
    const result = { name: false, country: false, line1: false, city: false, postal: false, state: false };
    if (items.length === 0) return result;

    const textQueue = [
        { key: 'name', value: fullName },
        { key: 'line1', value: address.line1 },
        { key: 'city', value: address.city },
        { key: 'postal', value: address.postal_code }
    ];
    let textIdx = 0;
    let countryDone = false;

    for (const item of items) {
        const tag = item.meta?.tag || '';
        const role = item.meta?.role || '';
        const isSelectLike = tag === 'select' || role === 'combobox';

        if (!countryDone && isSelectLike && !result.country) {
            const ok = await selectBillingComboboxItem(
                page,
                item,
                ['United States', '美国', 'US'],
                '国家'
            );
            if (ok) {
                result.country = true;
                countryDone = true;
                await page.waitForTimeout(900);
            }
            continue;
        }

        if (isSelectLike && !result.state) {
            const ok = await selectBillingComboboxItem(
                page,
                item,
                [stateFullName, address.state].filter(Boolean),
                '州'
            );
            if (ok) {
                result.state = true;
            }
            continue;
        }

        if (textIdx >= textQueue.length) continue;
        const current = textQueue[textIdx];
        const ok = await fillBillingTextItem(item, current.value, `[兜底] ${current.key}`);
        if (ok) {
            result[current.key] = true;
            textIdx += 1;
        }
    }

    return result;
}

async function hasBillingValidationError(page) {
    const patterns = [
        /your billing address is required/i,
        /please provide your full name/i,
        /this field is incomplete/i,
        /请提供.*全名/i,
        /此字段不完整/i,
        /您的账单地址/i
    ];
    for (const re of patterns) {
        try {
            const el = page.getByText(re).first();
            if (await el.isVisible({ timeout: 300 })) {
                return true;
            }
        } catch (_) { /* next */ }
    }
    return false;
}

/**
 * OpenAI custom checkout 账单区 — getByLabel / combobox 为主
 */
async function fillOpenAiCheckoutBilling(page, address, fullName) {
    const stateFullName = normalizeStateFullName(address.state);
    let filled = { name: false, country: false, line1: false, city: false, postal: false, state: false };

    console.log('  [Stripe] 开始填写账单地址（必填项）...');
    await suppressGoogleAddressAutocomplete(page);
    await dismissAddressAutocomplete(page);

    const preBillingDue = await readCheckoutDueAmount(page);
    const baselineAmount = preBillingDue?.amount || null;
    if (baselineAmount) {
        const taxFree = estimateTaxFreeAmount(baselineAmount);
        console.log(
            `  [Stripe] 填地址前应付: ${preBillingDue.currency || ''} ${baselineAmount}`
            + (taxFree ? `（免税州目标约 ${taxFree.toFixed(2)}）` : '')
        );
    }

    if (await isOpenAiBillingFormComplete(page)) {
        console.log('  [Stripe] ✅ 账单表单已完整，跳过重复填写');
        const taxCheck = await ensureCheckoutTaxFreeAmount(page, address, baselineAmount);
        if (!taxCheck.ok) {
            return { ok: false, error: taxCheck.error, filled, skipped: true };
        }
        return {
            ok: true,
            filled,
            skipped: true,
            ...(await resolveBillingDueResult(page, taxCheck)),
        };
    }

    try {
        await locateOpenAiBillingHeading(page);
        console.log('  [Stripe] ✅ 已定位账单地址区块');
    } catch (e) {
        console.warn(`  [Stripe] ⚠️ 账单标题不可见: ${e.message}`);
    }

    await focusOpenAiBillingSection(page);
    filled = await fillOpenAiBillingDirect(page, address, fullName, baselineAmount);
    filled = await syncFilledFlags(page, filled);
    await dismissAddressAutocomplete(page);

    if (await isOpenAiBillingFormComplete(page, filled)) {
        console.log('  [Stripe] ✅ 账单地址校验通过（直连填写）');
        const taxCheck = await ensureCheckoutTaxFreeAmount(page, address, baselineAmount);
        if (!taxCheck.ok) {
            return { ok: false, error: taxCheck.error, filled };
        }
        return {
            ok: true,
            filled,
            ...(await resolveBillingDueResult(page, taxCheck)),
        };
    }

    let status = getBillingFieldStatus(await readBillingInputValues(page), filled);
    let missing = listBillingMissing(status);

    if (missing.length > 0) {
        console.log(`  [Stripe] 仍需补填: ${missing.join(', ')}`);

        if (!status.name) {
            filled.name = await fillBillingFullNameStrict(page, fullName);
        }
        if (!status.country) {
            filled.country = await selectBillingCountry(page, ['United States', '美国', 'US']);
            if (filled.country) await page.waitForTimeout(800);
        }
        if (!status.line1) {
            filled.line1 = await fillBillingLine1Strict(page, address.line1);
        }
        if (!filled.line1 && !status.line1) {
            console.log('  [Stripe] 街道地址仍失败，尝试 section-meta 兜底...');
            const sectionFilled = await fillOpenAiBillingBySectionMeta(page, address, fullName);
            filled.line1 = filled.line1 || sectionFilled.line1;
            filled = await syncFilledFlags(page, filled);
        }
        if (!status.city) {
            filled.city = await fillBillingControl(page, [/^city$/i, /^城市$/i], address.city, '城市');
        }
        if (!status.postal) {
            filled.postal = await fillBillingControl(
                page,
                [/postal code/i, /zip code/i, /邮政编码/i, /^zip$/i],
                address.postal_code,
                '邮编'
            );
        }
        if (!status.state) {
            filled.state = await selectBillingState(page, stateFullName, address.state);
        }
        filled = await syncFilledFlags(page, filled);
        await dismissAddressAutocomplete(page);
    }

    status = getBillingFieldStatus(await readBillingInputValues(page), filled);
    missing = listBillingMissing(status);

    if (missing.length > 0) {
        console.warn(`  [Stripe] ⚠️ 账单字段未全部填写: ${missing.join(', ')}`);
        const stillError = await hasBillingValidationError(page);
        if (stillError || missing.includes('line1')) {
            return {
                ok: false,
                error: `账单地址未完整填写 (缺失: ${missing.join(', ') || '校验未通过'})`,
                filled
            };
        }
    }

    console.log('  [Stripe] ✅ 账单地址校验通过');

    const taxCheck = await ensureCheckoutTaxFreeAmount(page, address, baselineAmount);
    if (!taxCheck.ok) {
        return { ok: false, error: taxCheck.error, filled };
    }
    return {
        ok: true,
        filled,
        ...(await resolveBillingDueResult(page, taxCheck)),
    };
}

const BILLING_FULL_NAME_SELECTORS = [
    '#billingAddress-nameInput',
    'input[name="billingName"]',
    'input[autocomplete="billing name"]'
];

async function readControlValue(item) {
    if (!item?.el) return '';
    const tag = String(item.meta?.tag || '').toLowerCase();
    if (tag === 'select') {
        return String(await item.el.evaluate((node) => {
            const opt = node.options?.[node.selectedIndex];
            return opt ? opt.textContent.trim() : (node.value || '');
        }).catch(() => '')).trim();
    }
    return String(await item.el.inputValue({ timeout: 800 }).catch(() => '')).trim();
}

async function readBillingInputValues(page) {
    const result = { name: '', line1: '', city: '', postal: '', state: '', country: '' };

    try {
        const items = await getBillingInputsBelowHeading(page);
        for (const item of items) {
            const val = await readControlValue(item);
            if (!val) continue;
            const hay = `${item.hay} ${item.meta?.labelText || ''}`.toLowerCase();
            if (!result.name && /full name|billing name/.test(hay) && !/optional/.test(hay)) {
                result.name = val;
            } else if (!result.line1 && /address line 1|address-line1|line1|street|billing address-line/.test(hay) && !/line\s*2|optional/.test(hay)) {
                result.line1 = val;
            } else if (!result.city && /locality|address-level2|\bcity\b/.test(hay)) {
                result.city = val;
            } else if (!result.postal && /postal|zip|postal-code/.test(hay)) {
                result.postal = val;
            } else if (!result.state && /address-level1|administrative|state|province/.test(hay)) {
                result.state = val;
            } else if (!result.country && /country|region/.test(hay)) {
                result.country = val;
            }
        }
    } catch (_) { /* fallback below */ }

    const readers = [
        ['name', [/^(full name|billing name)$/i], [/^(full name|name)$/i]],
        ['line1', [/address line 1/i], [/address line 1/i]],
        ['city', [/^city$/i], [/^city$/i]],
        ['postal', [/zip code|postal code/i], [/zip|postal/i]],
        ['state', [/^state$/i, /^province$/i], [/^state$|^province$/i]],
        ['country', [/country or region/i, /^country$/i], [/country/i]]
    ];

    for (const [key, labelPatterns, placeholderPatterns] of readers) {
        if (result[key]) continue;
        for (const pat of labelPatterns) {
            try {
                const el = page.getByLabel(pat).first();
                if (!(await el.isVisible({ timeout: 250 }).catch(() => false))) continue;
                const val = String(await el.inputValue({ timeout: 800 }).catch(() => '')).trim();
                if (val) {
                    result[key] = val;
                    break;
                }
            } catch (_) { /* next */ }
        }
        if (result[key]) continue;
        for (const pat of placeholderPatterns) {
            try {
                const el = page.getByPlaceholder(pat).first();
                if (!(await el.isVisible({ timeout: 250 }).catch(() => false))) continue;
                const val = String(await el.inputValue({ timeout: 800 }).catch(() => '')).trim();
                if (val) {
                    result[key] = val;
                    break;
                }
            } catch (_) { /* next */ }
        }
    }

    for (const [key, selectors] of Object.entries({
        name: BILLING_FULL_NAME_SELECTORS,
        line1: OPENAI_BILLING_FIELD_SELECTORS.line1,
        city: OPENAI_BILLING_FIELD_SELECTORS.city,
        postal: OPENAI_BILLING_FIELD_SELECTORS.postal
    })) {
        if (result[key]) continue;
        for (const sel of selectors) {
            try {
                const val = String(await page.locator(sel).first().inputValue({ timeout: 500 }).catch(() => '')).trim();
                if (val) {
                    result[key] = val;
                    break;
                }
            } catch (_) { /* next */ }
        }
    }

    if (!result.country) {
        const currentCountry = await getCurrentBillingCountryValue(page);
        if (currentCountry.label) result.country = currentCountry.label;
        else if (currentCountry.value) result.country = currentCountry.value;
    }

    return result;
}

function getBillingFieldStatus(actual, filled = {}) {
    const countryOk = /united states|^us$/i.test(actual.country || '');
    return {
        name: Boolean(actual.name) || Boolean(filled.name),
        line1: Boolean(actual.line1) || Boolean(filled.line1),
        city: Boolean(actual.city) || Boolean(filled.city),
        postal: Boolean(actual.postal) || Boolean(filled.postal),
        state: Boolean(actual.state) || Boolean(filled.state),
        country: countryOk || Boolean(filled.country),
        actual
    };
}

function listBillingMissing(status) {
    const missing = [];
    if (!status.name) missing.push('name');
    if (!status.line1) missing.push('line1');
    if (!status.city) missing.push('city');
    if (!status.postal) missing.push('postal');
    if (!status.state) missing.push('state');
    if (!status.country) missing.push('country');
    return missing;
}

async function syncFilledFlags(page, filled) {
    const actual = await readBillingInputValues(page);
    if (actual.name) filled.name = true;
    if (actual.line1) filled.line1 = true;
    if (actual.city) filled.city = true;
    if (actual.postal) filled.postal = true;
    if (actual.state) filled.state = true;
    if (/united states|^us$/i.test(actual.country || '')) filled.country = true;
    return filled;
}

async function isOpenAiBillingFormComplete(page, filled = {}) {
    const values = await readBillingInputValues(page);
    const status = getBillingFieldStatus(values, filled);
    return listBillingMissing(status).length === 0;
}

async function billingFullNameHasValue(page) {
    const values = await readBillingInputValues(page);
    if (values.name) return true;
    for (const sel of BILLING_FULL_NAME_SELECTORS) {
        try {
            const el = page.locator(sel).first();
            if ((await el.count()) === 0) continue;
            const val = await el.inputValue({ timeout: 1000 }).catch(() => '');
            if (val && val.trim()) return true;
        } catch (_) { /* next */ }
    }
    return false;
}

async function billingLine1HasValue(page) {
    const values = await readBillingInputValues(page);
    if (values.line1) return true;
    try {
        const input = await locateBillingLine1Input(page);
        if (!input) return false;
        const val = String(await input.inputValue({ timeout: 800 }).catch(() => '')).trim();
        return Boolean(val);
    } catch (_) {
        return false;
    }
}

async function fillBillingLine1Element(el, value, via = '') {
    if (!el || value === undefined || value === null || String(value) === '') return false;
    try {
        await el.scrollIntoViewIfNeeded();
        await el.click({ timeout: 3000 });
        await el.fill('');
        await el.fill(String(value));
        let val = String(await el.inputValue({ timeout: 1000 }).catch(() => '')).trim();
        if (!val) {
            await el.click({ timeout: 2000 }).catch(() => { });
            await el.pressSequentially(String(value), { delay: 35 });
            val = String(await el.inputValue({ timeout: 1000 }).catch(() => '')).trim();
        }
        if (!val) {
            await el.evaluate((node, text) => {
                node.value = text;
                node.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
                node.dispatchEvent(new Event('change', { bubbles: true }));
            }, String(value));
            val = String(await el.inputValue({ timeout: 1000 }).catch(() => '')).trim();
        }
        if (val) {
            console.log(`  [Stripe] ✅ 街道地址: ${value}${via ? ` (${via})` : ''}`);
            return true;
        }
        console.log(`  [Stripe] ⚠️ 街道地址填写后仍为空 (${via || 'unknown'})`);
    } catch (error) {
        console.log(`  [Stripe] ⚠️ 街道地址填写失败 (${via || 'unknown'}): ${error.message}`);
    }
    return false;
}

async function locateBillingLine1Input(page) {
    const labelPatterns = [/^Address line 1$/i, /^地址行\s*1$/i, /^街道地址$/i];
    for (const pat of labelPatterns) {
        try {
            const byLabel = page.getByLabel(pat).first();
            if (await byLabel.isVisible({ timeout: 600 }).catch(() => false)) {
                return byLabel;
            }
        } catch (_) { /* next */ }

        try {
            const label = page.getByText(pat, { exact: true }).first();
            if (!(await label.isVisible({ timeout: 600 }).catch(() => false))) continue;
            const inParent = label.locator('xpath=ancestor::*[self::div or self::fieldset or self::label][1]//input[not(@type="hidden")]').first();
            if (await inParent.isVisible({ timeout: 600 }).catch(() => false)) {
                return inParent;
            }
            const following = label.locator('xpath=following::input[not(@type="hidden")][1]');
            if (await following.isVisible({ timeout: 600 }).catch(() => false)) {
                return following;
            }
        } catch (_) { /* next */ }

        try {
            const container = page.locator('div, fieldset, section, label').filter({
                has: page.getByText(pat, { exact: true })
            }).last();
            const input = container.locator('input:not([type="hidden"])').first();
            if (await input.isVisible({ timeout: 600 }).catch(() => false)) {
                return input;
            }
        } catch (_) { /* next */ }
    }

    const directSels = [
        '#billingAddress-addressLine1Input',
        '#billingAddressLine1',
        'input[name="addressLine1"]',
        'input[name="billingAddressLine1"]',
        'input[autocomplete="billing address-line1"]',
        'input[autocomplete="address-line1"]',
        'input.pac-target-input'
    ];
    for (const sel of directSels) {
        try {
            const input = page.locator(sel).first();
            if (await input.isVisible({ timeout: 400 }).catch(() => false)) {
                return input;
            }
        } catch (_) { /* next */ }
    }

    const item = await findBillingLine1ItemAfterCountry(page);
    return item?.el || null;
}

async function findBillingLine1ItemAfterCountry(page) {
    const items = await getBillingInputsBelowHeading(page);
    if (!items.length) return null;

    const labeled = items.find((item) => {
        const hay = `${item.hay} ${item.meta?.labelText || ''}`.toLowerCase();
        return /address line 1|address-line1|billing address-line|line1|street address/.test(hay)
            && !/line\s*2|optional/.test(hay);
    });
    if (labeled) return labeled;

    const countryIndex = items.findIndex((item) => {
        const hay = `${item.hay} ${item.meta?.labelText || ''}`.toLowerCase();
        return /country|region|国家|地区/.test(hay)
            || (item.meta?.tag === 'select' && /country/.test(item.meta?.name || ''));
    });

    const start = countryIndex >= 0 ? countryIndex + 1 : 0;
    for (let i = start; i < items.length; i += 1) {
        const item = items[i];
        const tag = String(item.meta?.tag || '').toLowerCase();
        if (tag !== 'input' && tag !== 'textarea') continue;
        const hay = `${item.hay} ${item.meta?.labelText || ''}`.toLowerCase();
        if (/line\s*2|optional|city|locality|postal|zip|state|province|name|country|region|email|phone|card/.test(hay)) {
            continue;
        }
        return item;
    }
    return null;
}

async function fillBillingLine1InFrame(frame, value) {
    const labelPatterns = [/^Address line 1$/i, /^地址行\s*1$/i];
    for (const pat of labelPatterns) {
        for (const getter of ['getByLabel', 'getByPlaceholder']) {
            try {
                const loc = frame[getter](pat);
                const count = await loc.count();
                for (let i = 0; i < count; i += 1) {
                    const el = loc.nth(i);
                    if (!(await el.isVisible({ timeout: 400 }).catch(() => false))) continue;
                    if (await fillBillingLine1Element(el, value, getter)) return true;
                }
            } catch (_) { /* next */ }
        }
    }

    try {
        const heading = frame.getByText(/^\s*Billing address\s*$|^\s*账单地址\s*$/i).first();
        if ((await heading.count()) > 0) {
            const headBox = await heading.boundingBox().catch(() => null);
            const minY = headBox ? headBox.y - 4 : 0;
            const inputs = frame.locator('input[type="text"], input:not([type]), input[type="search"]');
            const total = await inputs.count();
            let seenCountry = false;
            for (let i = 0; i < total; i += 1) {
                const el = inputs.nth(i);
                if (!(await el.isVisible({ timeout: 250 }).catch(() => false))) continue;
                const box = await el.boundingBox().catch(() => null);
                if (box && box.y < minY) continue;
                const meta = await el.evaluate((node) => ({
                    tag: node.tagName.toLowerCase(),
                    name: node.getAttribute('name') || '',
                    ac: node.getAttribute('autocomplete') || '',
                    ph: node.getAttribute('placeholder') || '',
                    val: node.value || ''
                })).catch(() => null);
                if (!meta) continue;
                const hay = `${meta.name} ${meta.ac} ${meta.ph}`.toLowerCase();
                if (meta.tag === 'select' || /country|region/.test(hay)) {
                    seenCountry = true;
                    continue;
                }
                if (!seenCountry) continue;
                if (/line\s*2|optional|city|locality|postal|zip|state|province|name|email|phone|card/.test(hay)) continue;
                if (String(meta.val).trim()) continue;
                if (await fillBillingLine1Element(el, value, 'frame-after-country')) return true;
            }
        }
    } catch (_) { /* next */ }

    return false;
}

async function fillBillingLine1Strict(page, value) {
    if (!value) return false;
    if (await billingLine1HasValue(page)) {
        console.log('  [Stripe] ⏭️ Address line 1 已有值，跳过');
        return true;
    }

    await suppressGoogleAddressAutocomplete(page);
    await dismissAddressAutocomplete(page);

    const directSels = [
        'input[autocomplete="billing address-line1"]',
        'input[autocomplete="address-line1"]',
        'input[name="addressLine1"]',
        'input[name="billingAddressLine1"]',
        '#billingAddress-addressLine1Input',
        '#billingAddressLine1',
        'input.pac-target-input',
        'input[placeholder*="Address line 1" i]'
    ];
    if (await fillFirstVisibleSelector(page, directSels, value, '街道地址', 3000)) {
        await dismissAddressAutocomplete(page);
        return true;
    }

    try {
        const located = await locateBillingLine1Input(page);
        if (located) {
            await dismissAddressAutocomplete(page);
            if (await fillBillingLine1Element(located, value, 'label-locate')) {
                await dismissAddressAutocomplete(page);
                return true;
            }
        }
    } catch (error) {
        console.log(`  [Stripe] ⚠️ 街道地址 label 定位失败: ${error.message}`);
    }

    try {
        const line1Item = await findBillingLine1ItemAfterCountry(page);
        if (line1Item?.el) {
            await dismissAddressAutocomplete(page);
            if (await fillBillingLine1Element(line1Item.el, value, 'after-country')) {
                await dismissAddressAutocomplete(page);
                return true;
            }
        } else {
            const items = await getBillingInputsBelowHeading(page);
            console.log(`  [Stripe] 街道地址 DOM 扫描: ${items.length} 个控件`);
        }
    } catch (error) {
        console.log(`  [Stripe] ⚠️ 街道地址 DOM 填写失败: ${error.message}`);
    }

    if (await fillBillingLine1InFrame(page, value)) {
        await dismissAddressAutocomplete(page);
        return true;
    }
    for (const frame of page.frames()) {
        if (frame === page.mainFrame()) continue;
        try {
            if (await fillBillingLine1InFrame(frame, value)) {
                await dismissAddressAutocomplete(page);
                return true;
            }
        } catch (_) { /* next frame */ }
    }

    const byPlaceholder = page.getByPlaceholder(/address line 1/i).first();
    if (await byPlaceholder.isVisible({ timeout: 1000 }).catch(() => false)) {
        if (await fillBillingLine1Element(byPlaceholder, value, 'placeholder')) {
            await dismissAddressAutocomplete(page);
            return true;
        }
    }

    const ok = await fillBillingControl(page, [/address line 1/i], value, '街道地址');
    if (ok) {
        await dismissAddressAutocomplete(page);
    }
    return ok;
}

async function clickCheckoutSubmitButton(page) {
    await dismissAddressAutocomplete(page);
    await page.keyboard.press('Escape').catch(() => {});
    await page.evaluate(() => {
        window.scrollTo({ top: document.body.scrollHeight, behavior: 'instant' });
    });
    await page.waitForTimeout(400);

    const tryClick = async (locator, label) => {
        try {
            const target = locator.first ? locator.first() : locator;
            if (!(await target.isVisible({ timeout: 2000 }).catch(() => false))) {
                return false;
            }
            if (await target.isDisabled().catch(() => false)) {
                console.log(`[Stripe] ⚠️ 提交按钮暂不可用 (${label})`);
                return false;
            }
            await target.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
            await page.waitForTimeout(randomBetween(150, 350));
            await target.click({ timeout: 8000, delay: randomBetween(40, 120) });
            console.log(`[Stripe] ✅ 已点击提交按钮 (${label})`);
            return true;
        } catch (error) {
            console.log(`[Stripe] 提交按钮点击失败 (${label}): ${error.message}`);
            return false;
        }
    };

    const strategies = [
        () => tryClick(page.getByRole('button', { name: /^Subscribe$/i }), 'role=Subscribe'),
        () => tryClick(page.getByRole('button', { name: /^订阅$/ }), 'role=订阅'),
        () => tryClick(page.getByRole('button', { name: /subscribe|订阅|pay/i }), 'role=subscribe'),
        () => tryClick(page.locator('button').filter({ hasText: /^Subscribe$/i }), 'button Subscribe'),
        () => tryClick(page.locator('button').filter({ hasText: /^订阅$/ }), 'button 订阅'),
        () => tryClick(page.locator('[role="button"]').filter({ hasText: /^Subscribe$/i }), 'role=button Subscribe'),
        () => tryClick(page.locator('button[type="submit"]'), 'type=submit'),
        () => tryClick(page.locator('.SubmitButton'), 'SubmitButton'),
        () => tryClick(
            page.locator('div').filter({ hasText: /Due today/i }).first()
                .locator('xpath=ancestor::div[1]')
                .getByRole('button', { name: /subscribe|订阅/i }),
            'summary Subscribe'
        ),
        () => tryClick(page.getByText(/^Subscribe$/i), 'text Subscribe'),
        () => tryClick(page.getByText(/^订阅$/), 'text 订阅')
    ];

    for (const strategy of strategies) {
        if (await strategy()) {
            return true;
        }
    }
    return false;
}

async function fillBillingNameElement(el, fullName, via) {
    try {
        await el.scrollIntoViewIfNeeded();
        await el.click({ timeout: 2000 });
        await el.fill('');
        await el.fill(String(fullName));
        let val = await el.inputValue({ timeout: 1000 }).catch(() => '');
        if (!val || !val.trim()) {
            // 某些 React 受控输入忽略 fill，改用真实键入
            await el.click({ timeout: 2000 }).catch(() => { });
            await el.pressSequentially(String(fullName), { delay: 40 }).catch(() => { });
            val = await el.inputValue({ timeout: 1000 }).catch(() => '');
        }
        if (val && val.trim()) {
            console.log(`  [Stripe] ✅ 账单全名: ${fullName}${via ? ` (${via})` : ''}`);
            return true;
        }
    } catch (_) { /* next */ }
    return false;
}

// 在单个 frame 内，定位 "Billing address" 标题下方的第一个空文本输入框（即 Full name）
async function fillBillingNameInFrame(frame, fullName) {
    // 1) 锚定 placeholder/label，排除 "Full name (optional)"
    const exact = [/^\s*Full name\s*$/i, /^\s*全名\s*$/i];
    for (const pat of exact) {
        for (const getter of ['getByPlaceholder', 'getByLabel']) {
            try {
                const loc = frame[getter](pat);
                const c = await loc.count();
                for (let i = c - 1; i >= 0; i -= 1) {
                    const el = loc.nth(i);
                    if (!(await el.isVisible({ timeout: 400 }).catch(() => false))) continue;
                    if (await fillBillingNameElement(el, fullName, getter)) return true;
                }
            } catch (_) { /* next */ }
        }
    }

    // 2) 定位 Billing address 标题，取其后方按位置排序的第一个空文本输入框
    try {
        const heading = frame.getByText(/^\s*Billing address\s*$|^\s*账单地址\s*$/i).first();
        if ((await heading.count()) > 0) {
            const headBox = await heading.boundingBox().catch(() => null);
            const minY = headBox ? headBox.y - 4 : 0;
            const inputs = frame.locator('input[type="text"], input:not([type]), input[type="search"]');
            const total = await inputs.count();
            const candidates = [];
            for (let i = 0; i < total; i += 1) {
                const el = inputs.nth(i);
                if (!(await el.isVisible({ timeout: 300 }).catch(() => false))) continue;
                const box = await el.boundingBox().catch(() => null);
                if (!box || box.y < minY) continue;
                const meta = await el.evaluate((n) => ({
                    ph: (n.getAttribute('placeholder') || '').toLowerCase(),
                    aria: (n.getAttribute('aria-label') || '').toLowerCase(),
                    name: (n.getAttribute('name') || '').toLowerCase(),
                    ac: (n.getAttribute('autocomplete') || '').toLowerCase(),
                    val: n.value || ''
                })).catch(() => null);
                if (!meta) continue;
                const hay = `${meta.ph} ${meta.aria} ${meta.name} ${meta.ac}`;
                if (/optional|email|phone|mobile|card|cvc|cc-|expir|security|line\s*2|address-line2|postal|zip|city|locality|state|province|country|region/.test(hay)) continue;
                candidates.push({ el, y: box.y, x: box.x, empty: !String(meta.val).trim(), hay });
            }
            candidates.sort((a, b) => a.y - b.y || a.x - b.x);
            console.log(`  [Stripe] Full name 候选输入框: ${candidates.length} 个`);
            // 优先选「明确含 full name/name 且非 optional」的，其次选第一个空文本框
            const named = candidates.find((c) => /full name|full_name|^name$|\bname\b/.test(c.hay));
            if (named && await fillBillingNameElement(named.el, fullName, 'heading-named')) return true;
            const firstEmpty = candidates.find((c) => c.empty);
            if (firstEmpty && await fillBillingNameElement(firstEmpty.el, fullName, 'heading-first-empty')) return true;
            if (candidates[0] && await fillBillingNameElement(candidates[0].el, fullName, 'heading-first')) return true;
        }
    } catch (_) { /* next */ }

    return false;
}

// 仅针对 Billing address 区块的必填 Full name，避免误填上方的 "Full name (optional)"
async function fillBillingFullNameStrict(page, fullName) {
    if (!fullName) return false;

    // 1) billing 专属选择器（若该页面使用了对应 id/name）
    if (await fillFirstVisibleSelector(page, BILLING_FULL_NAME_SELECTORS, fullName, '账单全名', 2000)) {
        return true;
    }

    // 2) 主页面 + 所有子 frame 内查找
    if (await fillBillingNameInFrame(page, fullName)) return true;
    for (const frame of page.frames()) {
        if (frame === page.mainFrame()) continue;
        try {
            if (await fillBillingNameInFrame(frame, fullName)) return true;
        } catch (_) { /* next frame */ }
    }

    console.log('  [Stripe] ⚠️ 全 frame 扫描仍未找到账单 Full name 输入框');
    return false;
}

/**
 * 填写账单地址字段
 * @param {import('playwright').Page} page
 * @param {object} address - { line1, city, state, postal_code, country }
 */
async function fillBillingAddress(page, address) {
    // Address line 1
    const line1Selectors = [
        '#billingAddressLine1',
        'input[name="billingAddressLine1"]',
        'input[name="addressLine1"]',
        'input[name="line1"]',
        'input[autocomplete="address-line1"]',
        'input[placeholder*="Address" i]',
        'input[placeholder*="Street" i]',
        '[data-testid="billingAddressLine1"]'
    ];
    await fillField(page, line1Selectors, address.line1, '街道地址');

    // City
    const citySelectors = [
        '#billingLocality',
        'input[name="billingLocality"]',
        'input[name="billingAddressCity"]',
        'input[name="city"]',
        'input[name="locality"]',
        'input[autocomplete="address-level2"]',
        'input[placeholder*="City" i]',
        '[data-testid="billingLocality"]'
    ];
    await fillField(page, citySelectors, address.city, '城市');

    // State / Province
    const stateSelectors = [
        '#billingAdministrativeArea',
        'input[name="billingAdministrativeArea"]',
        'input[name="billingAddressState"]',
        'input[name="state"]',
        'input[name="administrativeArea"]',
        'input[autocomplete="address-level1"]',
        'select[name="billingAdministrativeArea"]',
        'select[name="state"]',
        'input[placeholder*="State" i]',
        'input[placeholder*="Province" i]',
        '[data-testid="billingAdministrativeArea"]'
    ];
    await fillFieldOrSelect(page, stateSelectors, address.state, '州/省');

    // Postal code
    const postalSelectors = [
        '#billingPostalCode',
        'input[name="billingPostalCode"]',
        'input[name="billingAddressZip"]',
        'input[name="postal_code"]',
        'input[name="postalCode"]',
        'input[name="zip"]',
        'input[autocomplete="postal-code"]',
        'input[placeholder*="ZIP" i]',
        'input[placeholder*="Postal" i]',
        '[data-testid="billingPostalCode"]'
    ];
    await fillField(page, postalSelectors, address.postal_code, '邮编');

    // Country (usually a dropdown/select)
    const countrySelectors = [
        '#billingCountry',
        'select[name="billingCountry"]',
        'select[name="billingAddressCountry"]',
        'select[name="country"]',
        'select[autocomplete="country"]',
        '[data-testid="billingCountry"]'
    ];
    await selectCountry(page, countrySelectors, address.country);
}

/**
 * 填写普通文本输入字段
 * @param {import('playwright').Page} page
 * @param {string[]} selectors
 * @param {string} value
 * @param {string} fieldName
 */
async function fillField(page, selectors, value, fieldName) {
    if (!value) return;

    for (const sel of selectors) {
        try {
            const el = page.locator(sel).first();
            if (await el.isVisible({ timeout: 2000 })) {
                await el.fill(''); // clear existing
                await humanType(page, sel, value);
                console.log(`  [Stripe] ✅ ${fieldName}: ${value}`);
                return;
            }
        } catch (_) { /* try next */ }
    }
    console.warn(`  [Stripe] ⚠️ 未找到${fieldName}字段`);
}

/**
 * 填写字段（支持 input 和 select）
 * @param {import('playwright').Page} page
 * @param {string[]} selectors
 * @param {string} value
 * @param {string} fieldName
 */
async function fillFieldOrSelect(page, selectors, value, fieldName) {
    if (!value) return;

    for (const sel of selectors) {
        try {
            const el = page.locator(sel).first();
            if (await el.isVisible({ timeout: 2000 })) {
                const tagName = await el.evaluate(node => node.tagName.toLowerCase());
                if (tagName === 'select') {
                    await el.selectOption({ label: value }).catch(() =>
                        el.selectOption({ value: value })
                    );
                } else {
                    await el.fill('');
                    await humanType(page, sel, value);
                }
                console.log(`  [Stripe] ✅ ${fieldName}: ${value}`);
                return;
            }
        } catch (_) { /* try next */ }
    }
    console.warn(`  [Stripe] ⚠️ 未找到${fieldName}字段`);
}

/**
 * 选择国家下拉框
 * @param {import('playwright').Page} page
 * @param {string[]} selectors
 * @param {string} countryCode - ISO 3166-1 alpha-2
 */
async function selectCountry(page, selectors, countryCode) {
    if (!countryCode) return;

    for (const sel of selectors) {
        try {
            const el = page.locator(sel).first();
            if (await el.isVisible({ timeout: 2000 })) {
                // Try selecting by value (country code) first, then by label
                try {
                    await el.selectOption({ value: countryCode });
                } catch (_) {
                    try {
                        await el.selectOption(countryCode);
                    } catch (__) {
                        // Some Stripe forms use custom dropdowns, try clicking and searching
                        await el.click();
                        await page.waitForTimeout(500);
                        // Look for option with country code
                        const option = page.locator(`option[value="${countryCode}"]`).first();
                        if (await option.isVisible({ timeout: 1000 })) {
                            await option.click();
                        }
                    }
                }
                console.log(`  [Stripe] ✅ 国家: ${countryCode}`);
                return;
            }
        } catch (_) { /* try next */ }
    }
    console.warn(`  [Stripe] ⚠️ 未找到国家选择框`);
}

// ==================== Exports ====================

module.exports = {
    completeStripeCardPayment,
    humanType,
    generateRandomName,
    getTypingDelay,
    normalizeCardExpiry,
    normalizeCardNumber,
    // Internal helpers exported for testing
    humanTypeInFrame,
    saveDebugScreenshot,
    waitForStripeFrame,
    waitForBillingFields,
    fillBillingAddress,
    fillOpenAiCheckoutBilling,
    discoverCardInputs,
    prepareCheckoutCardSection,
    readCheckoutDueAmount,
    estimateTaxFreeAmount,
    waitForCheckoutTaxRecalculation,
    ensureCheckoutTaxFreeAmount,
    captureCheckoutDueAmount
};
