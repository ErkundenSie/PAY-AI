/**
 * 人机验证统一处理：Cloudflare Turnstile / hCaptcha / Stripe challenge
 */

const { solveHcaptchaOnPage, isHcaptchaSolverEnabled } = require('./hcaptcha-solver');
const {
    isCaptchaPlatformEnabled,
    extractHcaptchaParamsFromPage,
    solveHcaptchaViaPlatform,
    injectHcaptchaTokenOnPage,
    clickCheckoutContinueAfterCaptcha
} = require('./captcha-platform');
const { isLoginPageContent, isHardLoginRedirectUrl, isCheckoutPageUrl, hasVisibleLoginChrome, isCheckoutLoginGate, buildSessionNotLoggedInError } = require('./auth-page-detect');

const BLOCKING_TEXT_PATTERNS = [
    /one more step before you'?re done/i,
    /select the checkbox below/i,
    /verify you are human/i,
    /are you a human/i,
    /i am human/i,
    /cf-turnstile/i,
    /cloudflare security check/i,
    /protected by hcaptcha/i,
    /performing security verification/i,
    /just a moment/i,
    /checking your browser/i,
    /完成验证/i,
    /人机验证/i,
    /请勾选/i
];

/** @deprecated 仅保留兼容；请用 isBlockingHumanVerificationVisible */
const CAPTCHA_CHALLENGE_PATTERNS = BLOCKING_TEXT_PATTERNS;

function captchaLog(phase, message, level = 'info') {
    const tag = level === 'warn' ? 'WARN' : level === 'error' ? 'ERROR' : 'INFO';
    const line = `[Captcha/${phase}][${tag}] ${message}`;
    console.log(`CAPTCHA_LOG: ${line}`);
}

function randomBetween(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function isInvisibleStripeHcaptchaUrl(url) {
    const u = String(url || '').toLowerCase();
    if (!u) {
        return false;
    }
    if (u.includes('hcaptcha-invisible') || u.includes('hcaptchainvisible')) {
        return true;
    }
    if (u.includes('stripecdn.com') && u.includes('hcaptcha')) {
        return true;
    }
    if (u.includes('js.stripe.com') && u.includes('hcaptcha')) {
        return true;
    }
    // Stripe 后台静态资源帧，不是可见 challenge
    if (u.includes('hcaptcha') && (u.includes('/static/') || u.includes('#debugmod'))) {
        return true;
    }
    return false;
}

function isBlockingCaptchaFrameUrl(url) {
    if (isInvisibleStripeHcaptchaUrl(url)) {
        return false;
    }
    const u = String(url || '').toLowerCase();
    if (u.includes('frame=challenge') || u.includes('frame=checkbox')) {
        return true;
    }
    return u.includes('challenges.cloudflare')
        || u.includes('turnstile')
        || u.includes('cloudflare.com/cdn-cgi');
}

function isCaptchaFrameUrl(url) {
    return isBlockingCaptchaFrameUrl(url) || isInvisibleStripeHcaptchaUrl(url);
}

function isHcaptchaCheckboxFrameUrl(url) {
    return String(url || '').toLowerCase().includes('frame=checkbox');
}

function isHcaptchaChallengeFrameUrl(url) {
    return String(url || '').toLowerCase().includes('frame=challenge');
}

async function hasHcaptchaImageChallenge(page) {
    for (const frame of page.frames()) {
        if (isHcaptchaChallengeFrameUrl(frame.url() || '')) {
            return true;
        }
    }
    for (const frame of page.frames()) {
        const url = String(frame.url() || '').toLowerCase();
        if (isInvisibleStripeHcaptchaUrl(url)) {
            continue;
        }
        if (!/hcaptcha|newassets/i.test(url)) {
            continue;
        }
        try {
            const looksLikeChallenge = await frame.evaluate(() => {
                const body = String(document.body?.innerText || '').toLowerCase();
                if (/click the|please click|please select|drag the|different from|matching shape|choose all|identify/i.test(body)) {
                    return true;
                }
                if (document.querySelector('.challenge-container, .button-submit, .task-grid, canvas')) {
                    return true;
                }
                return false;
            });
            if (looksLikeChallenge) {
                return true;
            }
        } catch (_) { /* cross-origin frame */ }
    }
    try {
        const mainHasChallenge = await page.evaluate(() => {
            const body = String(document.body?.innerText || '').toLowerCase();
            return /click the .+ (different|arrow|select)/i.test(body)
                || /please click|please select|drag the matching|that are different/i.test(body);
        });
        if (mainHasChallenge) {
            return true;
        }
    } catch (_) { /* ignore */ }
    return false;
}

async function hasHcaptchaSolverTarget(page) {
    if (await hasHcaptchaImageChallenge(page)) {
        return true;
    }
    for (const frame of page.frames()) {
        const url = String(frame.url() || '').toLowerCase();
        if (isHcaptchaCheckboxFrameUrl(url)) {
            return true;
        }
    }
    return false;
}

async function waitForPassiveCheckboxClear(page, phase, verifyOpts, timeoutMs = 45000) {
    captchaLog(phase, `仅 checkbox 验证，等待被动通过（最长 ${Math.round(timeoutMs / 1000)}s）...`);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        await clickHcaptchaCheckboxFrames(page, `${phase}-passive`);
        if (await isVerificationCleared(page, verifyOpts)) {
            captchaLog(phase, 'checkbox 被动验证已通过');
            return true;
        }
        await page.waitForTimeout(1200);
    }
    return false;
}

async function logCaptchaFrameSnapshot(page, phase) {
    const urls = page.frames()
        .map((frame) => frame.url() || '')
        .filter((url) => isBlockingCaptchaFrameUrl(url));
    const invisible = page.frames()
        .map((frame) => frame.url() || '')
        .filter((url) => isInvisibleStripeHcaptchaUrl(url));
    if (invisible.length > 0) {
        captchaLog(phase, `Stripe 隐形 hCaptcha 帧 ${invisible.length} 个（已忽略，非可见验证）`);
    }
    if (urls.length > 0) {
        captchaLog(phase, `可见拦截 frames: ${urls.map((url) => url.slice(0, 90)).join(' | ')}`);
    }
}

async function clickHcaptchaCheckboxFrames(page, phase = 'hcaptcha-checkbox') {
    let clicked = false;
    const selectors = ['#checkbox', '#anchor', '[id="checkbox"]', '[role="checkbox"]', 'div[aria-checked]', '.checkbox'];

    for (const frame of page.frames()) {
        const url = frame.url() || '';
        if (!isHcaptchaCheckboxFrameUrl(url)) {
            continue;
        }
        for (const sel of selectors) {
            try {
                const loc = frame.locator(sel).first();
                if (!(await loc.isVisible({ timeout: 600 }).catch(() => false))) {
                    continue;
                }
                const box = await loc.boundingBox({ timeout: 1000 }).catch(() => null);
                if (box) {
                    await humanClickBoundingBox(page, box, 'checkbox-left');
                } else {
                    await loc.click({ timeout: 2000, delay: randomBetween(40, 120) });
                }
                captchaLog(phase, `已点击 hCaptcha checkbox frame (${url.slice(0, 70)}...)`);
                clicked = true;
                break;
            } catch (_) { /* next selector */ }
        }
    }

    if (!clicked) {
        const iframes = await collectCaptchaIframeLocators(page);
        for (const iframe of iframes) {
            const src = await iframe.getAttribute('src').catch(() => '') || '';
            if (!/hcaptcha/i.test(src)) {
                continue;
            }
            if (await humanClickLocator(page, iframe, 'checkbox-left')) {
                captchaLog(phase, `已点击 hCaptcha iframe bbox (${src.slice(0, 70)}...)`);
                clicked = true;
                break;
            }
        }
    }
    return clicked;
}

async function waitForHcaptchaSolverTarget(page, phase, timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await hasHcaptchaSolverTarget(page)) {
            return true;
        }
        await clickHcaptchaCheckboxFrames(page, `${phase}-warmup`);
        await page.waitForTimeout(900);
    }
    return false;
}

const CHECKOUT_CAPTCHA_TEXT_RE = /one more step|select the checkbox below|i am human|are you a human/i;

/** 从 body / 可见节点判断 Checkout hCaptcha 弹层 */
async function hasCheckoutCaptchaOverlayText(page) {
    if (!/checkout/i.test(page.url() || '')) {
        return false;
    }
    try {
        return await page.evaluate(() => {
            const normalize = (s) => String(s || '').replace(/\s+/g, ' ').trim();
            const captchaRe = /one more step|select the checkbox below|i am human|are you a human/i;
            const body = normalize(document.body?.innerText);
            if (captchaRe.test(body)) {
                return true;
            }
            const nodes = document.querySelectorAll('div, p, span, h1, h2, h3, [role="dialog"], section, article');
            for (const el of nodes) {
                if (!(el instanceof HTMLElement)) continue;
                const style = window.getComputedStyle(el);
                if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
                    continue;
                }
                const rect = el.getBoundingClientRect();
                if (rect.width < 8 || rect.height < 8) continue;
                const text = normalize(el.innerText);
                if (!text || text.length > 320) continue;
                if (captchaRe.test(text)) {
                    return true;
                }
            }
            const iframes = document.querySelectorAll('iframe');
            for (const iframe of iframes) {
                const src = String(iframe.getAttribute('src') || '').toLowerCase();
                const title = String(iframe.getAttribute('title') || '').toLowerCase();
                if (!src.includes('hcaptcha') && !title.includes('hcaptcha')) continue;
                if (src.includes('hcaptcha-invisible') || src.includes('hcaptchainvisible')) continue;
                const rect = iframe.getBoundingClientRect();
                if (rect.width > 40 && rect.height > 20) {
                    return true;
                }
            }
            return false;
        });
    } catch (_) {
        return false;
    }
}

async function hasVisiblePostSubmitHcaptchaWidget(page) {
    if (!/checkout/i.test(page.url() || '')) {
        return false;
    }
    try {
        const iframes = page.locator('iframe');
        const count = await iframes.count().catch(() => 0);
        for (let i = 0; i < count; i += 1) {
            const iframe = iframes.nth(i);
            const src = String(await iframe.getAttribute('src').catch(() => '') || '').toLowerCase();
            const title = String(await iframe.getAttribute('title').catch(() => '') || '').toLowerCase();
            if (isInvisibleStripeHcaptchaUrl(src)) continue;
            const isHcaptcha = src.includes('hcaptcha.com')
                || (src.includes('hcaptcha') && (src.includes('frame=checkbox') || src.includes('frame=challenge')))
                || title.includes('hcaptcha');
            if (!isHcaptcha) continue;
            if (!(await iframe.isVisible({ timeout: 250 }).catch(() => false))) continue;
            const box = await iframe.boundingBox().catch(() => null);
            if (box && box.width > 36 && box.height > 18) {
                return true;
            }
        }
    } catch (_) { /* ignore */ }

    for (const frame of page.frames()) {
        const url = String(frame.url() || '').toLowerCase();
        if (isInvisibleStripeHcaptchaUrl(url)) continue;
        if (/hcaptcha\.com.*frame=(checkbox|challenge)/i.test(url)) {
            return true;
        }
    }
    return false;
}

async function hasAnyCheckoutCaptchaSignal(page) {
    if (!/checkout/i.test(page.url() || '')) {
        return false;
    }
    if (await hasCheckoutCaptchaOverlayText(page)) {
        return true;
    }
    if (await hasVisiblePostSubmitHcaptchaWidget(page)) {
        return true;
    }
    for (const re of [/one more step/i, /select the checkbox/i, /i am human/i]) {
        try {
            if (await page.getByText(re).first().isVisible({ timeout: 300 })) {
                return true;
            }
        } catch (_) { /* next */ }
    }
    return false;
}

async function waitForCheckoutOverlayCaptcha(page, timeoutMs = 45000) {
    const deadline = Date.now() + timeoutMs;
    let lastLog = 0;
    while (Date.now() < deadline) {
        if (await hasAnyCheckoutCaptchaSignal(page)) {
            return true;
        }
        const now = Date.now();
        if (now - lastLog >= 5000) {
            captchaLog('overlay-wait', `仍在等待 hCaptcha 弹层… (${Math.round((now - (deadline - timeoutMs)) / 1000)}s)`);
            lastLog = now;
        }
        await page.waitForTimeout(500);
    }
    return false;
}

/** Checkout 上「One more step」hCaptcha 弹层 */
async function isCheckoutOverlayCaptchaVisible(page) {
    if (!(await hasAnyCheckoutCaptchaSignal(page))) {
        return false;
    }
    return true;
}

async function isBlockingHumanVerificationVisible(page) {
    if (await isCheckoutOverlayCaptchaVisible(page)) {
        return true;
    }

    const textPatterns = [
        /one more step/i,
        /select the checkbox below/i,
        /i am human/i,
        /are you a human/i,
        /verify you are human/i,
        /performing security verification/i,
        /just a moment/i,
        /checking your browser/i
    ];
    for (const re of textPatterns) {
        try {
            if (await page.getByText(re).first().isVisible({ timeout: 400 })) {
                return true;
            }
        } catch (_) { /* next */ }
    }

    const bodyText = String(await page.textContent('body', { timeout: 3000 }).catch(() => '') || '');
    if (/one more step|select the checkbox below|i am human/i.test(bodyText)) {
        return true;
    }
    if (BLOCKING_TEXT_PATTERNS.some((re) => re.test(bodyText))) {
        return true;
    }

    const captchaSelectors = [
        'iframe[src*="hcaptcha.com"][src*="frame=checkbox"]',
        'iframe[src*="hcaptcha.com"][src*="frame=challenge"]',
        'div:has-text("One more step") iframe',
        'div:has-text("I am human") iframe',
        'iframe[src*="challenges.cloudflare"]',
        'iframe[src*="turnstile"]',
        'iframe[title*="Cloudflare" i]',
        '.cf-turnstile',
        '#challenge-running',
        '#challenge-stage',
        'div:has-text("Verify you are human") iframe'
    ];
    for (const sel of captchaSelectors) {
        try {
            if (await page.locator(sel).first().isVisible({ timeout: 400 })) {
                return true;
            }
        } catch (_) { /* next */ }
    }

    for (const frame of page.frames()) {
        if (isBlockingCaptchaFrameUrl(frame.url())) {
            return true;
        }
    }

    // 支付表单在弹层背后仍可见 — 不能据此判定「无验证」
    if (/checkout/i.test(page.url() || '')) {
        return false;
    }

    if (await isCheckoutPaymentReady(page)) {
        return false;
    }

    if (/configure your plan|card number|due today|subscribe now|billing address/i.test(bodyText)) {
        return false;
    }
    return false;
}

async function isHumanVerificationVisible(page) {
    return isBlockingHumanVerificationVisible(page);
}

/** Cloudflare 全页拦截（OpenAI logo + Verify you are human） */
async function isCloudflareWallPage(page) {
    try {
        const info = await page.evaluate(() => {
            const text = (document.body?.innerText || '').replace(/\s+/g, ' ');
            const lower = text.toLowerCase();
            const hasVerify = lower.includes('verify you are human')
                || lower.includes('i am human')
                || lower.includes('select the checkbox');
            const hasCfBrand = lower.includes('cloudflare');
            const hasCheckoutUi = /card number|configure your plan|subscribe|billing address|支付|订阅/i.test(text);
            const hasChallengeEl = Boolean(
                document.querySelector(
                    'iframe[src*="challenges.cloudflare"], iframe[src*="turnstile"], .cf-turnstile, #challenge-running, #challenge-stage, [id*="turnstile"]'
                )
            );
            return { hasVerify, hasCfBrand, hasCheckoutUi, hasChallengeEl, textSample: text.slice(0, 280) };
        });
        if (info.hasChallengeEl) {
            return true;
        }
        if (info.hasVerify && !info.hasCheckoutUi) {
            return true;
        }
        if (info.hasVerify && info.hasCfBrand) {
            return true;
        }
    } catch (_) { /* ignore */ }
    return false;
}

/** Checkout 支付表单是否已真正加载（不仅是 URL 对了） */
async function hasVisibleStripeCardInputs(page) {
    const iframeCount = await page.locator('iframe').count().catch(() => 0);
    for (let i = 0; i < iframeCount; i += 1) {
        const src = await page.locator('iframe').nth(i).getAttribute('src').catch(() => '') || '';
        if (isInvisibleStripeHcaptchaUrl(src)) {
            continue;
        }
        const fl = page.frameLocator('iframe').nth(i);
        try {
            const input = fl.locator('input:not([type="hidden"])').first();
            if (await input.isVisible({ timeout: 500 })) {
                return true;
            }
        } catch (_) { /* next iframe */ }
    }
    return false;
}

async function isCheckoutPaymentReady(page) {
    if (await hasVisibleStripeCardInputs(page)) {
        return true;
    }

    const probes = [
        () => page.getByText(/^Card number$/i).first().isVisible({ timeout: 1200 }),
        () => page.getByText(/Configure your plan/i).first().isVisible({ timeout: 1200 }),
        () => page.getByText(/Due today/i).first().isVisible({ timeout: 1200 }),
        () => page.getByText(/Plus plan|Pro plan|Monthly subscription/i).first().isVisible({ timeout: 1200 }),
        () => page.getByRole('button', { name: /subscribe|订阅|pay/i }).first().isVisible({ timeout: 1200 }),
        () => page.locator('input[autocomplete="cc-number"]').first().isVisible({ timeout: 1200 })
    ];
    for (const probe of probes) {
        if (await probe().catch(() => false)) {
            return true;
        }
    }

    for (const frame of page.frames()) {
        if (isInvisibleStripeHcaptchaUrl(frame.url())) {
            continue;
        }
        if (!/js\.stripe\.com|stripe\.com|elements-inner/i.test(frame.url())) {
            continue;
        }
        try {
            const input = frame.locator('input[autocomplete="cc-number"], input[name="cardnumber"], input[name="number"]').first();
            if (await input.isVisible({ timeout: 500 })) {
                return true;
            }
        } catch (_) { /* next frame */ }
    }
    return false;
}

async function waitForCheckoutPaymentReady(page, timeoutMs = 60000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await isCheckoutLoginGate(page) || await hasVisibleLoginChrome(page)) {
            return 'login_required';
        }
        const url = page.url() || '';
        if (isHardLoginRedirectUrl(url) && !isCheckoutPageUrl(url)) {
            return 'login_redirect';
        }
        if (await isCheckoutPaymentReady(page)) {
            return true;
        }
        await page.waitForTimeout(800);
    }
    if (await isCheckoutLoginGate(page) || await hasVisibleLoginChrome(page)) {
        return 'login_required';
    }
    return false;
}

async function isVerificationCleared(page, options = {}) {
    const pageUrl = page.url() || '';
    if (/redirect_status=succeeded/i.test(pageUrl) || /checkout\/verify/i.test(pageUrl)) {
        return true;
    }

    const requireCheckoutReady = options.requireCheckoutReady
        ?? /checkout/i.test(pageUrl);

    if (await hasAnyCheckoutCaptchaSignal(page)) {
        return false;
    }
    if (await isCheckoutOverlayCaptchaVisible(page)) {
        return false;
    }

    if (requireCheckoutReady && await isCheckoutPaymentReady(page)) {
        return true;
    }

    if (await isBlockingHumanVerificationVisible(page)) {
        return false;
    }
    if (await isCloudflareWallPage(page)) {
        return false;
    }
    if (requireCheckoutReady) {
        return await isCheckoutPaymentReady(page);
    }
    return true;
}

async function isPageBlocked(page, options = {}) {
    return !(await isVerificationCleared(page, options));
}

async function humanPause(page, minMs = 80, maxMs = 220) {
    await page.waitForTimeout(randomBetween(minMs, maxMs));
}

async function humanMouseMove(page, targetX, targetY) {
    const startX = targetX + randomBetween(-100, 100);
    const startY = targetY + randomBetween(-70, 70);
    const steps = randomBetween(14, 24);
    for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const ease = 1 - Math.pow(1 - t, 3);
        const x = startX + (targetX - startX) * ease + randomBetween(-2, 2);
        const y = startY + (targetY - startY) * ease + randomBetween(-2, 2);
        await page.mouse.move(x, y);
        await page.waitForTimeout(randomBetween(6, 22));
    }
}

async function humanClickAt(page, x, y) {
    const jitterX = x + randomBetween(-4, 4);
    const jitterY = y + randomBetween(-4, 4);
    await humanMouseMove(page, jitterX, jitterY);
    await humanPause(page, 50, 160);
    await page.mouse.down();
    await humanPause(page, 35, 110);
    await page.mouse.up();
}

async function humanClickBoundingBox(page, box, profile = 'center') {
    if (!box || box.width <= 0 || box.height <= 0) {
        return false;
    }
    let x;
    let y;
    if (profile === 'checkbox-left') {
        x = box.x + Math.min(38, box.width * 0.2) + randomBetween(-2, 3);
        y = box.y + box.height / 2 + randomBetween(-5, 5);
    } else if (profile === 'modal-below-text') {
        x = box.x + box.width / 2 + randomBetween(-20, 20);
        y = box.y + box.height * 0.72 + randomBetween(-8, 8);
    } else {
        x = box.x + box.width / 2 + randomBetween(-6, 6);
        y = box.y + box.height / 2 + randomBetween(-5, 5);
    }
    await humanClickAt(page, x, y);
    return true;
}

async function humanClickLocator(page, locator, profile = 'center') {
    try {
        await locator.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
        const box = await locator.boundingBox({ timeout: 2000 });
        return humanClickBoundingBox(page, box, profile);
    } catch (_) {
        return false;
    }
}

async function collectCaptchaIframeLocators(page) {
    const selectors = [
        'div:has-text("One more step") iframe',
        'div:has-text("I am human") iframe',
        'div:has-text("Verify you are human") iframe',
        'div:has-text("Select the checkbox") iframe',
        'iframe[src*="hcaptcha.com"][src*="frame=checkbox"]',
        'iframe[src*="hcaptcha.com"][src*="frame=challenge"]',
        'iframe[src*="challenges.cloudflare.com"]',
        'iframe[src*="turnstile"]',
        'iframe[title*="Cloudflare" i]',
        '.cf-turnstile iframe'
    ];
    const seen = new Set();
    const locators = [];

    for (const sel of selectors) {
        try {
            const items = page.locator(sel);
            const count = await items.count().catch(() => 0);
            for (let i = 0; i < count; i++) {
                const item = items.nth(i);
                const visible = await item.isVisible({ timeout: 400 }).catch(() => false);
                if (!visible) continue;
                const src = await item.getAttribute('src').catch(() => '') || '';
                if (isInvisibleStripeHcaptchaUrl(src)) continue;
                const title = await item.getAttribute('title').catch(() => '') || '';
                const key = `${sel}::${src}::${title}::${i}`;
                if (seen.has(key)) continue;
                seen.add(key);
                locators.push(item);
            }
        } catch (_) { /* next */ }
    }

    try {
        const allIframes = page.locator('iframe');
        const count = await allIframes.count().catch(() => 0);
        for (let i = 0; i < count; i += 1) {
            const item = allIframes.nth(i);
            if (!(await item.isVisible({ timeout: 300 }).catch(() => false))) continue;
            const src = await item.getAttribute('src').catch(() => '') || '';
            const title = await item.getAttribute('title').catch(() => '') || '';
            if (isInvisibleStripeHcaptchaUrl(src)) continue;
            if (!isBlockingCaptchaFrameUrl(src)
                && !/cloudflare|turnstile|hcaptcha|verify you are human/i.test(`${title} ${src}`)) continue;
            const key = `all::${src}::${title}::${i}`;
            if (seen.has(key)) continue;
            seen.add(key);
            locators.push(item);
        }
    } catch (_) { /* ignore */ }

    return locators;
}

async function dispatchSyntheticClickInFrame(frame) {
    return frame.evaluate(() => {
        const pickTarget = () => {
            const selectors = [
                'input[type="checkbox"]',
                'label.ctp-checkbox-label',
                'label',
                '#challenge-stage',
                '[role="checkbox"]',
                '.mark',
                'span',
                'body'
            ];
            for (const sel of selectors) {
                const el = document.querySelector(sel);
                if (el) return el;
            }
            return document.body;
        };
        const el = pickTarget();
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        const x = rect.left + Math.min(rect.width * 0.2, 30);
        const y = rect.top + rect.height / 2;
        const eventInit = { bubbles: true, cancelable: true, clientX: x, clientY: y, view: window };
        for (const type of ['pointerover', 'pointerenter', 'mouseover', 'mousemove', 'mousedown', 'mouseup', 'click']) {
            el.dispatchEvent(new MouseEvent(type, eventInit));
        }
        if (typeof PointerEvent !== 'undefined') {
            el.dispatchEvent(new PointerEvent('pointerdown', { ...eventInit, pointerId: 1, pointerType: 'mouse' }));
            el.dispatchEvent(new PointerEvent('pointerup', { ...eventInit, pointerId: 1, pointerType: 'mouse' }));
        }
        if (el.click) {
            try { el.click(); } catch (_) { /* ignore */ }
        }
        return true;
    }).catch(() => false);
}

async function clickTurnstileIframeByBBox(page) {
    const iframes = await collectCaptchaIframeLocators(page);
    for (const iframe of iframes) {
        const box = await iframe.boundingBox({ timeout: 2000 }).catch(() => null);
        if (!box || box.width < 24 || box.height < 20) {
            continue;
        }
        const clickPoints = [
            [box.x + Math.min(30, box.width * 0.14), box.y + box.height / 2],
            [box.x + box.width * 0.22, box.y + box.height / 2],
            [box.x + box.width / 2, box.y + box.height / 2]
        ];
        for (const [x, y] of clickPoints) {
            captchaLog('click', `Turnstile iframe 物理坐标点击 (${Math.round(x)}, ${Math.round(y)})`);
            await humanClickAt(page, x, y);
            await humanPause(page, 1800, 3000);
            return true;
        }
    }
    return false;
}

async function humanClickInsideFrame(page, frame) {
    const innerTargets = [
        '#checkbox', '#anchor', '[id="checkbox"]', 'input[type="checkbox"]',
        'label.ctp-checkbox-label', '[role="checkbox"]', '.checkbox', 'label',
        '#challenge-stage', '.mark'
    ];
    for (const target of innerTargets) {
        try {
            const el = frame.locator(target).first();
            if (!(await el.isVisible({ timeout: 800 }))) continue;
            const box = await el.boundingBox({ timeout: 1000 });
            if (box) {
                await humanClickBoundingBox(page, box, target.includes('checkbox') ? 'checkbox-left' : 'center');
                captchaLog('click', `iframe 内点击 ${target}`);
                return true;
            }
            await el.click({ timeout: 2000, delay: randomBetween(40, 120) });
            captchaLog('click', `iframe 内 direct 点击 ${target}`);
            return true;
        } catch (_) { /* next */ }
    }
    return dispatchSyntheticClickInFrame(frame);
}

async function clickMainPageCloudflareCheckbox(page) {
    const patterns = [/verify you are human/i, /i am human/i, /select the checkbox/i];
    for (const re of patterns) {
        try {
            const label = page.getByText(re).first();
            if (!(await label.isVisible({ timeout: 800 }).catch(() => false))) continue;

            const container = label.locator('xpath=ancestor::div[contains(@class,"cb") or contains(@class,"challenge") or contains(@class,"cf-")][1]');
            const checkbox = container.locator('input[type="checkbox"], [role="checkbox"]').first();
            if (await checkbox.isVisible({ timeout: 600 }).catch(() => false)) {
                if (await humanClickLocator(page, checkbox, 'checkbox-left')) {
                    captchaLog('click', `主页面 Cloudflare 勾选框 (${re})`);
                    return true;
                }
            }

            const labelBox = await label.boundingBox({ timeout: 1000 }).catch(() => null);
            if (labelBox && await humanClickBoundingBox(page, {
                x: labelBox.x - 28,
                y: labelBox.y,
                width: Math.max(labelBox.width + 36, 40),
                height: labelBox.height
            }, 'checkbox-left')) {
                captchaLog('click', `主页面 Cloudflare 标签左侧 (${re})`);
                return true;
            }

            await label.click({ timeout: 2000, delay: randomBetween(50, 120) }).catch(() => {});
            captchaLog('click', `主页面 Cloudflare 标签点击 (${re})`);
            return true;
        } catch (_) { /* next */ }
    }
    return false;
}

async function waitForTurnstileReady(page, timeoutMs = 10000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const locators = await collectCaptchaIframeLocators(page);
        if (locators.length > 0 || await isHumanVerificationVisible(page)) {
            return locators;
        }
        await page.waitForTimeout(350);
    }
    return collectCaptchaIframeLocators(page);
}

async function attemptBypassHumanVerification(page, options = {}) {
    const { phase = 'poll' } = options;
    captchaLog(phase, '尝试模拟人类点击绕过验证...');

    const strategies = [
        'checkout-hcaptcha-modal',
        'turnstile-bbox',
        'hcaptcha-checkbox-frame',
        'main-page-cloudflare',
        'iframe-checkbox-left',
        'iframe-center',
        'frame-inner-elements',
        'modal-below-text',
        'dispatch-events',
        'all-iframes-scan'
    ];

    await waitForTurnstileReady(page, phase === 'post_submit' ? 12000 : 8000);
    await humanPause(page, 300, 700);

    const iframeLocators = await collectCaptchaIframeLocators(page);

    for (const strategy of strategies) {
        try {
            if (strategy === 'checkout-hcaptcha-modal') {
                if (!(await isCheckoutOverlayCaptchaVisible(page))) {
                    continue;
                }
                captchaLog(phase, '检测到 Checkout hCaptcha 弹层，优先点击 checkbox...');
                if (await clickHcaptchaCheckboxFrames(page, phase)) {
                    await humanPause(page, 2200, 3800);
                    return { attempted: true, strategy };
                }
                const modalIframe = page.locator(
                    'div:has-text("One more step") iframe, div:has-text("I am human") iframe'
                ).first();
                if (await humanClickLocator(page, modalIframe, 'checkbox-left')) {
                    captchaLog(phase, '策略 checkout-hcaptcha-modal 已点击弹层 iframe');
                    await humanPause(page, 2200, 3800);
                    return { attempted: true, strategy };
                }
                const modal = page.getByText(/one more step|select the checkbox/i).first();
                const modalBox = await modal.locator('xpath=ancestor::*[contains(@class,"Modal") or @role="dialog"][1]')
                    .boundingBox({ timeout: 1500 })
                    .catch(() => null);
                if (modalBox && await humanClickBoundingBox(page, modalBox, 'modal-below-text')) {
                    captchaLog(phase, '策略 checkout-hcaptcha-modal 已点击弹层下方');
                    await humanPause(page, 2200, 3800);
                    return { attempted: true, strategy };
                }
                continue;
            }

            if (strategy === 'turnstile-bbox') {
                if (await clickTurnstileIframeByBBox(page)) {
                    captchaLog(phase, '策略 turnstile-bbox 已执行');
                    return { attempted: true, strategy };
                }
                continue;
            }

            if (strategy === 'hcaptcha-checkbox-frame') {
                if (await clickHcaptchaCheckboxFrames(page, phase)) {
                    await humanPause(page, 1800, 3200);
                    return { attempted: true, strategy };
                }
                continue;
            }

            if (strategy === 'main-page-cloudflare') {
                if (await clickMainPageCloudflareCheckbox(page)) {
                    await humanPause(page, 1500, 2800);
                    return { attempted: true, strategy };
                }
                continue;
            }

            if (strategy === 'iframe-checkbox-left' || strategy === 'iframe-center') {
                const profile = strategy === 'iframe-checkbox-left' ? 'checkbox-left' : 'center';
                for (const iframe of iframeLocators) {
                    if (await humanClickLocator(page, iframe, profile)) {
                        captchaLog(phase, `策略 ${strategy} 已执行`);
                        await humanPause(page, 1200, 2200);
                        return { attempted: true, strategy };
                    }
                }
                continue;
            }

            if (strategy === 'frame-inner-elements') {
                for (const frame of page.frames()) {
                    if (!isBlockingCaptchaFrameUrl(frame.url())) continue;
                    if (await humanClickInsideFrame(page, frame)) {
                        captchaLog(phase, `策略 ${strategy} (${frame.url().slice(0, 60)}...)`);
                        await humanPause(page, 1200, 2200);
                        return { attempted: true, strategy };
                    }
                }
                for (const iframe of iframeLocators) {
                    const frame = iframe.contentFrame();
                    if (!frame) continue;
                    if (await humanClickInsideFrame(page, frame)) {
                        captchaLog(phase, `策略 ${strategy} (locator frame)`);
                        await humanPause(page, 1200, 2200);
                        return { attempted: true, strategy };
                    }
                }
                continue;
            }

            if (strategy === 'modal-below-text') {
                const modal = page.getByText(/one more step|select the checkbox|i am human|verify you are human/i).first();
                if (await modal.isVisible({ timeout: 800 }).catch(() => false)) {
                    const modalBox = await modal.locator('xpath=ancestor::*[contains(@class,"Modal") or contains(@role,"dialog")][1]').boundingBox({ timeout: 1500 }).catch(() => null)
                        || await modal.locator('xpath=ancestor::div[1]').boundingBox({ timeout: 1500 }).catch(() => null);
                    if (modalBox && await humanClickBoundingBox(page, modalBox, 'modal-below-text')) {
                        captchaLog(phase, `策略 ${strategy} 已执行`);
                        await humanPause(page, 1200, 2200);
                        return { attempted: true, strategy };
                    }
                }
                continue;
            }

            if (strategy === 'dispatch-events') {
                for (const frame of page.frames()) {
                    if (!isBlockingCaptchaFrameUrl(frame.url())) continue;
                    if (await dispatchSyntheticClickInFrame(frame)) {
                        captchaLog(phase, `策略 ${strategy} 已执行`);
                        await humanPause(page, 1500, 2500);
                        return { attempted: true, strategy };
                    }
                }
                continue;
            }

            if (strategy === 'all-iframes-scan') {
                const allIframes = page.locator('iframe');
                const count = await allIframes.count().catch(() => 0);
                for (let i = 0; i < count; i++) {
                    const iframe = allIframes.nth(i);
                    if (!(await iframe.isVisible({ timeout: 400 }).catch(() => false))) continue;
                    for (const profile of ['checkbox-left', 'center']) {
                        if (await humanClickLocator(page, iframe, profile)) {
                            captchaLog(phase, `策略 ${strategy} iframe #${i} ${profile}`);
                            await humanPause(page, 1200, 2200);
                            return { attempted: true, strategy: `${strategy}-${i}` };
                        }
                    }
                }
            }
        } catch (err) {
            captchaLog(phase, `策略 ${strategy} 失败: ${err.message}`, 'warn');
        }
    }

    captchaLog(phase, '所有模拟点击策略均未命中', 'warn');
    return { attempted: false };
}

async function attemptCaptchaPlatformSolver(page, phase = 'platform', verifyOpts = {}) {
    if (!isCaptchaPlatformEnabled()) {
        captchaLog(phase, '打码平台未配置，跳过', 'warn');
        return false;
    }

    const imageChallenge = await hasHcaptchaImageChallenge(page);
    if (imageChallenge) {
        captchaLog(phase, '已出现 hCaptcha 图片题，打码 token 注入无效，跳过平台解题', 'warn');
        return false;
    }

    captchaLog(phase, '尝试打码平台（createTask/getTaskResult）解题…');
    const params = await extractHcaptchaParamsFromPage(page);
    const userAgent = String(
        await page.evaluate(() => navigator.userAgent).catch(() => '')
        || process.env.HCAPTCHA_USER_AGENT
        || ''
    ).trim();
    captchaLog(
        phase,
        `提取参数 siteKey=${params.siteKey.slice(0, 12)}… rqdata=${params.rqdata ? 'yes' : 'no'} urls=${params.websiteUrls.length} ua=${userAgent ? 'yes' : 'no'}`
    );

    const solveResult = await solveHcaptchaViaPlatform({
        siteKey: params.siteKey,
        rqdata: params.rqdata,
        websiteUrls: params.websiteUrls,
        isInvisible: true,
        userAgent
    });

    if (!solveResult.ok) {
        captchaLog(phase, `打码平台失败: ${solveResult.error || 'unknown'}`, 'error');
        return false;
    }

    captchaLog(phase, `打码平台返回 token（${solveResult.token.length} chars），注入页面…`);
    await injectHcaptchaTokenOnPage(page, solveResult.token, solveResult.ekey);
    await page.waitForTimeout(2500);
    await clickCheckoutContinueAfterCaptcha(page);

    const deadline = Date.now() + 35000;
    while (Date.now() < deadline) {
        const pageUrl = page.url() || '';
        if (/redirect_status=succeeded|checkout\/verify/i.test(pageUrl)) {
            captchaLog(phase, '打码平台 token 注入后支付已跳转成功页');
            return true;
        }
        if (await isVerificationCleared(page, verifyOpts)) {
            captchaLog(phase, '打码平台 token 注入后验证已通过');
            return true;
        }
        await page.waitForTimeout(1500);
    }

    captchaLog(phase, '打码平台 token 注入后验证仍在', 'warn');
    return false;
}

async function attemptHcaptchaVisualSolver(page, phase = 'visual') {
    if (!isHcaptchaSolverEnabled()) {
        captchaLog(phase, '视觉求解器未启用', 'warn');
        return false;
    }

    const cloudflareWall = await isCloudflareWallPage(page);
    await clickHcaptchaCheckboxFrames(page, `${phase}-pre`);
    await page.waitForTimeout(cloudflareWall ? 3500 : 2000);

    const solverReady = await waitForHcaptchaSolverTarget(page, phase, cloudflareWall ? 12000 : 20000);
    if (!solverReady) {
        if (cloudflareWall) {
            captchaLog(phase, 'Cloudflare 勾选验证：无 hCaptcha 图片 challenge frame，跳过 VLM 求解器', 'warn');
        } else {
            captchaLog(phase, '未发现 hCaptcha challenge/checkbox frame，跳过 VLM 求解器', 'warn');
        }
        return false;
    }

    captchaLog(phase, '检测到 hCaptcha solver frame，启动视觉求解器（VLM + CLIP/OpenCV）...');
    const pageUrlSubstr = (() => {
        try {
            const url = page.url() || '';
            if (/checkout|stripe|chatgpt/i.test(url)) {
                return url.includes('checkout') ? 'checkout' : 'chatgpt.com';
            }
        } catch (_) { /* ignore */ }
        return 'checkout';
    })();

    const solverResult = await solveHcaptchaOnPage({
        pageUrlSubstr,
        locale: process.env.HCAPTCHA_BROWSER_LOCALE,
        timezoneId: process.env.HCAPTCHA_BROWSER_TIMEZONE,
        acceptLanguage: process.env.HCAPTCHA_ACCEPT_LANGUAGE
    });

    if (!solverResult.ok) {
        captchaLog(phase, `视觉求解器失败: ${solverResult.error || 'unknown'}`, 'error');
        if (solverResult.logPath) {
            captchaLog(phase, `solver 日志: ${solverResult.logPath}`);
        }
        return false;
    }

    if (solverResult.result?.type === 'passive_checkbox') {
        captchaLog(phase, '视觉求解器：被动 checkbox 信号，等待页面确认...');
    } else {
        captchaLog(phase, '视觉求解器已完成，等待页面继续...');
    }
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline) {
        if (await isVerificationCleared(page, { requireCheckoutReady: /checkout/i.test(page.url() || '') })) {
            captchaLog(phase, '视觉求解器已通过验证');
            return true;
        }
        await page.waitForTimeout(1500);
    }
    const cleared = await isVerificationCleared(page, { requireCheckoutReady: /checkout/i.test(page.url() || '') });
    if (!cleared) {
        captchaLog(phase, '视觉求解器结束后验证仍在', 'warn');
    }
    return cleared;
}

function buildCaptchaRequiredError() {
    const parts = [];
    if (isCaptchaPlatformEnabled()) {
        parts.push('打码平台');
    }
    if (isHcaptchaSolverEnabled()) {
        parts.push('视觉求解');
    }
    const solverHint = parts.length
        ? `已尝试自动点击与${parts.join('、')}仍失败，`
        : '自动化无法可靠通过，';
    const configHint = isCaptchaPlatformEnabled()
        ? ''
        : '请在后台配置打码平台 API Key（推荐）或 VLM API Key，';
    return `需要人工验证：触发 Cloudflare/hCaptcha 人机验证，${solverHint}`
        + `${configHint}或换住宅代理 IP，或 HEADFUL=1 有头模式人工勾选`;
}

/**
 * 统一清除人机验证（登录、Checkout、支付各阶段调用）
 */
async function clearHumanVerification(page, options = {}) {
    const {
        phase = 'page',
        maxWaitMs = Number(process.env.CAPTCHA_CLEAR_TIMEOUT_MS || 120000),
        maxBypassRounds = 4,
        useVisualSolver = true,
        requireCheckoutReady = /checkout/i.test(page.url() || ''),
        checkoutReadyWaitMs = Number(process.env.CHECKOUT_READY_WAIT_MS || 60000)
    } = options;

    const verifyOpts = { requireCheckoutReady };
    const effectiveMaxRounds = requireCheckoutReady
        ? Math.max(maxBypassRounds, Number(process.env.CAPTCHA_CHECKOUT_MAX_ROUNDS || 15))
        : maxBypassRounds;

    const onCheckout = /checkout/i.test(page.url() || '');
    const waitOverlayMs = Number(options.overlayWaitMs || 0);
    const isPostSubmitCheckout = onCheckout && String(phase).startsWith('post_submit');
    if (onCheckout && (isPostSubmitCheckout || waitOverlayMs > 0)) {
        const overlayMs = waitOverlayMs || Number(process.env.CAPTCHA_OVERLAY_WAIT_MS || 45000);
        captchaLog(phase, `等待 Checkout 提交后 hCaptcha 弹层（最长 ${Math.round(overlayMs / 1000)}s，弹层可能延迟 15–35s）...`);
        const appeared = await waitForCheckoutOverlayCaptcha(page, overlayMs);
        if (appeared) {
            captchaLog(phase, '已检测到 hCaptcha 弹层');
        } else {
            captchaLog(phase, '等待期内未检测到弹层，仍将尝试自动处理', 'warn');
        }
    }

    const captchaStill = await hasAnyCheckoutCaptchaSignal(page);
    if (await isVerificationCleared(page, verifyOpts)) {
        if (!isPostSubmitCheckout || !captchaStill) {
            return { cleared: true, skipped: true };
        }
        captchaLog(phase, '提交后 checkout 仍有人机验证信号，进入自动处理', 'warn');
    }

    if (requireCheckoutReady) {
        captchaLog(phase, `等待 Checkout 支付表单加载（最长 ${Math.round(checkoutReadyWaitMs / 1000)}s）...`);
        const ready = await waitForCheckoutPaymentReady(page, checkoutReadyWaitMs);
        if (ready === true) {
            captchaLog(phase, '支付表单已就绪，无需验证处理');
            return { cleared: true, skipped: true, via: 'checkout-ready' };
        }
        if (ready === 'login_required' || ready === 'login_redirect') {
            captchaLog(phase, 'Checkout 出现登录页，Session 未在支付页生效', 'error');
            return {
                cleared: false,
                sessionRequired: true,
                checkoutNotReady: true,
                message: buildSessionNotLoggedInError('Checkout 支付页')
            };
        }
    }

    await logCaptchaFrameSnapshot(page, phase);

    const cloudflareWall = await isCloudflareWallPage(page);
    const blockingVisible = await isBlockingHumanVerificationVisible(page);

    if (requireCheckoutReady && !blockingVisible && !cloudflareWall) {
        captchaLog(phase, '未发现可见人机验证（已忽略 Stripe 隐形 hCaptcha），继续等待支付表单...', 'warn');
        const slowDeadline = Date.now() + maxWaitMs;
        while (Date.now() < slowDeadline) {
            if (await isCheckoutLoginGate(page) || await hasVisibleLoginChrome(page)) {
                captchaLog(phase, 'Checkout 显示登录界面，停止空等', 'error');
                return {
                    cleared: false,
                    sessionRequired: true,
                    checkoutNotReady: true,
                    message: buildSessionNotLoggedInError('Checkout 支付页')
                };
            }
            if (await isCheckoutPaymentReady(page)) {
                captchaLog(phase, '支付表单已加载（慢加载）');
                return { cleared: true, via: 'checkout-slow-load' };
            }
            await page.waitForTimeout(1500);
        }
        captchaLog(phase, '支付表单长时间未出现（非验证拦截）', 'error');
        return { cleared: false, checkoutNotReady: true, captchaRequired: false };
    }

    if (cloudflareWall) {
        captchaLog(phase, '检测到 Cloudflare 全页验证墙');
    } else if (blockingVisible || await hasCheckoutCaptchaOverlayText(page)) {
        captchaLog(phase, 'Checkout 被可见人机验证拦截（hCaptcha/Cloudflare）');
    } else if (requireCheckoutReady) {
        captchaLog(phase, 'Checkout 被可见人机验证拦截');
    }

    captchaLog(phase, `开始处理可见人机验证（最长 ${Math.round(maxWaitMs / 1000)}s，maxRounds=${effectiveMaxRounds}）...`);
    const deadline = Date.now() + maxWaitMs;
    let round = 0;

    while (Date.now() < deadline) {
        if (await isVerificationCleared(page, verifyOpts)) {
            captchaLog(phase, '验证已清除，页面内容就绪');
            return { cleared: true, rounds: round };
        }

        round += 1;
        captchaLog(phase, `第 ${round} 轮自动绕过...`);

        await attemptBypassHumanVerification(page, { phase: `${phase}-r${round}` });
        await page.waitForTimeout(cloudflareWall ? 10000 : 5000);

        if (await isVerificationCleared(page, verifyOpts)) {
            captchaLog(phase, `第 ${round} 轮模拟点击后验证已通过`);
            return { cleared: true, rounds: round };
        }

        let overlayCaptcha = await hasAnyCheckoutCaptchaSignal(page);
        let imageChallenge = await hasHcaptchaImageChallenge(page);
        if (overlayCaptcha && !imageChallenge) {
            const passiveOk = await waitForPassiveCheckboxClear(page, `${phase}-r${round}`, verifyOpts, 35000);
            if (passiveOk) {
                return { cleared: true, rounds: round, via: 'passive-checkbox' };
            }
        }

        if (await isVerificationCleared(page, verifyOpts)) {
            captchaLog(phase, `被动验证等待后页面已就绪`);
            return { cleared: true, rounds: round };
        }

        overlayCaptcha = await hasAnyCheckoutCaptchaSignal(page);
        imageChallenge = await hasHcaptchaImageChallenge(page);

        // 图片题优先走 VLM 实点（参考 Gpt-Agreement-Payment：浏览器侧解题优先，打码平台仅 passive 兜底）
        const shouldRunSolver = useVisualSolver
            && isHcaptchaSolverEnabled()
            && (imageChallenge || overlayCaptcha);

        if (shouldRunSolver && imageChallenge) {
            const solved = await attemptHcaptchaVisualSolver(page, `${phase}-vlm-${round}`);
            if (solved && await isVerificationCleared(page, verifyOpts)) {
                return { cleared: true, rounds: round, via: 'visual-solver' };
            }
        }

        if (overlayCaptcha && isCaptchaPlatformEnabled() && !imageChallenge) {
            const platformOk = await attemptCaptchaPlatformSolver(page, `${phase}-platform-${round}`, verifyOpts);
            if (platformOk && await isVerificationCleared(page, verifyOpts)) {
                return { cleared: true, rounds: round, via: 'captcha-platform' };
            }
        }

        if (shouldRunSolver && !imageChallenge) {
            const solved = await attemptHcaptchaVisualSolver(page, `${phase}-vlm-${round}`);
            if (solved && await isVerificationCleared(page, verifyOpts)) {
                return { cleared: true, rounds: round, via: 'visual-solver' };
            }
        } else if (useVisualSolver && isHcaptchaSolverEnabled() && round >= 2 && !imageChallenge) {
            captchaLog(phase, '无可见 hCaptcha 图片题，跳过 VLM 求解器');
        }

        if (process.env.HEADFUL === '1') {
            captchaLog(phase, '有头模式：等待人工勾选（10s）...');
            await page.waitForTimeout(10000);
            if (await isVerificationCleared(page, verifyOpts)) {
                captchaLog(phase, '人工勾选后验证已通过');
                return { cleared: true, rounds: round, via: 'manual-headful' };
            }
        }

        if (round >= effectiveMaxRounds && !process.env.HEADFUL) {
            break;
        }
        await page.waitForTimeout(2000);
    }

    if (await isVerificationCleared(page, verifyOpts)) {
        return { cleared: true, rounds: round };
    }

    captchaLog(phase, '验证未能自动通过（页面仍无支付表单）', 'error');
    return { cleared: false, captchaRequired: true, rounds: round };
}

module.exports = {
    isCheckoutOverlayCaptchaVisible,
    hasCheckoutCaptchaOverlayText,
    hasAnyCheckoutCaptchaSignal,
    hasVisiblePostSubmitHcaptchaWidget,
    waitForCheckoutOverlayCaptcha,
    isBlockingHumanVerificationVisible,
    isHumanVerificationVisible,
    isInvisibleStripeHcaptchaUrl,
    waitForCheckoutPaymentReady,
    isCloudflareWallPage,
    isCheckoutPaymentReady,
    isVerificationCleared,
    isPageBlocked,
    attemptBypassHumanVerification,
    attemptHcaptchaVisualSolver,
    attemptCaptchaPlatformSolver,
    clearHumanVerification,
    buildCaptchaRequiredError,
    isCaptchaFrameUrl,
    collectCaptchaIframeLocators,
    hasHcaptchaSolverTarget,
    hasHcaptchaImageChallenge,
    waitForPassiveCheckboxClear,
    clickHcaptchaCheckboxFrames,
};
