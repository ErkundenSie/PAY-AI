require("./load-env");

const { executePaymentWithRetry } = require("./payment-retry");
const { openPricingCheckout } = require("./pricing-checkout");
const { openApiCheckout } = require("./chatgpt");
const { hydrateCheckoutFromUrl } = require("./checkout-protocol");
const store = require("./mysql-store");
const { getRegionConfig, getRegionBrowserProfile } = require("./region-config");
const { buildBrowserFingerprint } = require("./browser-fingerprint");
const {
  installChatGptSession,
  bootstrapChatGptSession,
  acquireFreshChatGptAccessToken,
  fetchLiveChatGptSession,
} = require("./session-auth");
const {
  connectTaskBrowser,
  applyCdpEnv,
  closeTaskBrowser,
} = require("./browser-runtime");
const { preparePlaywrightProxy } = require("./playwright-proxy");
const {
  cancelAutoRenewWithBrowserPage,
  createChatGptLiveStateTracker,
} = require("./subscription-check");
const fs = require("fs");
const path = require("path");

/**
 * Stripe Card Pool Payment Activation Flow
 *
 * 核心流程：
 * 1. 代理连通性检查
 * 2. 从 CDK 记录获取 plan_type
 * 3. 创建 Stripe Checkout Session（根据 plan_type）
 * 4. 打开 Stripe Checkout 页面
 * 5. 使用 payment-retry.js（executePaymentWithRetry）完成信用卡支付
 *    - 自动从卡池分配卡片
 *    - 支持表单重试 + 换卡重试（最多 3 张卡）
 *    - 自动选取免税地址
 *    - 记录账单信息
 * 6. 检测支付结果：成功则继续，失败则标记 payment_failed
 *
 * 进度输出约定（供 server.js / product_activator.js 解析）：
 * - "正在检查代理连通性"  → 代理检查开始
 * - "代理连接成功! 代理公网 IP" → 代理检查通过
 * - "[1] 创建订单" → 订单创建开始
 * - "套餐类型:" → plan_type/region 已解析
 * - "定价页" / "Checkout 页面已打开" → UI 升级流程
 * - "[Stripe] Step" → 填写信用卡与账单地址
 * - "正在使用 Stripe 信用卡卡池支付流程" → 支付流程开始
 * - "最终校验：支付成功!" / "PAYMENT_SUCCESS" → 成功
 * - "支付失败 (payment_failed)" → 全部卡片均失败
 * - "支付失败 (stripe_card_declined)" → 卡被拒
 */

// 全部敏感配置请通过环境变量传入
const CONFIG = {
  chatgptToken: process.env.CHATGPT_TOKEN || "",
  chatgptSessionJson: process.env.CHATGPT_SESSION_JSON || "",
  cdkCode: process.env.CDK_CODE || "",
  email: process.env.ACTIVATION_EMAIL || "",
  planType: process.env.CDK_PLAN_TYPE || "",
  planNameOverride: process.env.PLAN_NAME_OVERRIDE || "",
  creditQuantity: Number(process.env.CREDIT_QUANTITY || 0),
  paymentRegionOverride: process.env.PAYMENT_REGION_OVERRIDE || "",
  checkoutUrl: process.env.CHECKOUT_URL || "",
  proxy: process.env.PROXY || "",
};

const RECORD_VIDEO = String(process.env.RECORD_VIDEO || "0") !== "0";
const VIDEO_DIR = path.join(__dirname, "debug_screenshots", "videos");
const VIDEO_TAG =
  (process.env.JOB_KEY || process.env.CDK_CODE || `${Date.now()}`)
    .replace(/[^a-zA-Z0-9_-]/g, "")
    .slice(0, 32) || `${Date.now()}`;

function buildDebugScreenshotPath(prefix) {
  const subdir =
    process.env.CHECKOUT_DEBUG_ONLY === "1" ? "checkout_debug" : "activation";
  const screenshotDir = path.join(__dirname, "debug_screenshots", subdir);
  fs.mkdirSync(screenshotDir, { recursive: true });
  return path.join(screenshotDir, `${prefix}_${Date.now()}.png`);
}

function removeMediaFiles(paths) {
  for (const filePath of paths || []) {
    try {
      fs.unlinkSync(filePath);
    } catch (_) {}
  }
}

// 关闭 context 后把录像重命名为带任务标识的稳定文件名，并输出路径供 server 解析
async function finalizeVideo(context, page, options = {}) {
  const deleteOnSuccess = Boolean(options.deleteOnSuccess);
  if (!RECORD_VIDEO || !context) return null;
  try {
    const pages =
      (typeof context.pages === "function" ? context.pages() : []) || [];
    const targetPage =
      page && typeof page.video === "function" && page.video()
        ? page
        : pages.find((p) => p && p.video && p.video());
    const video = targetPage && targetPage.video ? targetPage.video() : null;

    await context.close().catch(() => {});

    if (!video) return null;
    const rawPath = await video.path().catch(() => null);
    if (!rawPath) return null;

    const finalPath = path.join(
      VIDEO_DIR,
      `payment_${VIDEO_TAG}_${Date.now()}.webm`,
    );
    try {
      fs.renameSync(rawPath, finalPath);
    } catch (_) {
      try {
        fs.copyFileSync(rawPath, finalPath);
        fs.unlinkSync(rawPath);
      } catch (_) {
        return rawPath;
      }
    }

    if (deleteOnSuccess) {
      try {
        fs.unlinkSync(finalPath);
        console.log("🎬 [系统] 支付成功，录像已自动删除以节省磁盘");
        return null;
      } catch (e) {
        console.warn(`⚠️ [系统] 删除成功录像失败: ${e.message}`);
      }
    }

    console.log(`🎬 [系统] 自动化录像已保存: ${finalPath}`);
    console.log(`VIDEO_FILE: ${finalPath}`);
    return finalPath;
  } catch (e) {
    console.warn(`⚠️ [系统] 录像保存失败: ${e.message}`);
    return null;
  }
}

function getAvailableDebugPage(context, preferredPage) {
  if (preferredPage && !preferredPage.isClosed()) {
    return preferredPage;
  }
  if (!context || typeof context.pages !== "function") {
    return null;
  }
  const alivePages = context.pages().filter((item) => item && !item.isClosed());
  return alivePages.length ? alivePages[alivePages.length - 1] : null;
}

async function captureDebugScreenshot(
  context,
  preferredPage,
  prefix,
  label = "异常截图",
) {
  const targetPage = getAvailableDebugPage(context, preferredPage);
  if (!targetPage) {
    console.warn(`⚠️ [系统] ${label}未保存：当前没有可用页面。`);
    return null;
  }

  const screenshotPath = buildDebugScreenshotPath(prefix);
  await targetPage.screenshot({ path: screenshotPath, fullPage: true });
  console.log(`📸 [系统] ${label}已保存: ${screenshotPath}`);
  return screenshotPath;
}

async function isCheckoutErrorPage(page) {
  try {
    const bodyText = String(
      (await page.textContent("body", { timeout: 3000 }).catch(() => "")) || "",
    );
    return (
      bodyText.includes("Something went wrong") ||
      bodyText.includes("could not be found") ||
      bodyText.includes("contact the merchant")
    );
  } catch (_) {
    return false;
  }
}

async function isConnectionClosedPage(page) {
  try {
    const bodyText = String(
      (await page.textContent("body", { timeout: 3000 }).catch(() => "")) || "",
    );
    return (
      bodyText.includes("ERR_CONNECTION_CLOSED") ||
      bodyText.includes("无法访问此网站") ||
      bodyText.includes("意外终止了连接") ||
      bodyText.includes("This site can\u2019t be reached") ||
      bodyText.includes("This site cannot be reached")
    );
  } catch (_) {
    return false;
  }
}

async function recoverConnectionClosed(page, fallbackUrl = "") {
  if (!(await isConnectionClosedPage(page))) {
    return false;
  }

  console.warn("[Warn] 检测到浏览器连接关闭错误页，正在尝试自动重载...");
  for (let attempt = 1; attempt <= 3; attempt++) {
    await page
      .reload({ waitUntil: "domcontentloaded", timeout: 30000 })
      .catch(async () => {
        const nextUrl = fallbackUrl || page.url();
        if (nextUrl) {
          return page
            .goto(nextUrl, { waitUntil: "domcontentloaded", timeout: 30000 })
            .catch(() => {});
        }
      });
    await page.waitForTimeout(3000);
    if (!(await isConnectionClosedPage(page))) {
      console.log(`[Info] 连接关闭错误页已恢复 (第 ${attempt} 次重载成功)。`);
      return true;
    }
  }

  return false;
}

async function preparePostPaymentSubscription(page, options = {}) {
  return acquireFreshChatGptAccessToken(page, {
    previousToken: options.accessToken,
    tracker: options.tracker,
    maxAttempts: Number(options.maxAttempts || 4),
    onStatus: options.onStatus,
  });
}

/**
 * Main Automation logic
 */
async function run() {
  // 切到有头模式调试：HEADFUL=1 node server.js 或 HEADFUL=1 node index.js
  const DEBUG_HEADFUL = process.env.HEADFUL === "1";
  const CHROMIUM_CHANNEL = (process.env.CHROMIUM_CHANNEL || "").trim();

  let proxyCleanup = async () => {};
  let browserSession = null;
  let browser = null;
  let context = null;
  let page = null;
  let paymentSucceeded = false;

  const preparedProxy = await preparePlaywrightProxy(CONFIG.proxy);
  proxyCleanup = preparedProxy.cleanup;
  const proxyConfig = preparedProxy.proxyConfig;

  if (proxyConfig) {
    console.log(
      `🌐 [系统] 代理已配置${preparedProxy.relayed ? "（SOCKS→本地 HTTP 中继）" : ""}`,
    );
  }

  browserSession = await connectTaskBrowser({
    proxyConfig,
    headful: DEBUG_HEADFUL,
    chromiumChannel: CHROMIUM_CHANNEL,
  });
  applyCdpEnv(browserSession);
  browser = browserSession.browser;

  const realUserAgent = browserSession.realUserAgent;

  const matched = realUserAgent.match(/Chrome\/(\d+)/);
  const chromeMajor = matched ? Number(matched[1]) : 147;

  const paymentRegion =
    String(CONFIG.paymentRegionOverride || "")
      .trim()
      .toUpperCase() || (await store.getPaymentRegion());
  const regionCfg = getRegionConfig(paymentRegion);
  const browserProfile = getRegionBrowserProfile(paymentRegion);
  const fingerprintSeed =
    process.env.JOB_KEY ||
    process.env.CDK_CODE ||
    CONFIG.chatgptSessionJson ||
    CONFIG.chatgptToken ||
    `${Date.now()}`;
  const fingerprint = buildBrowserFingerprint({
    chromeMajor,
    locale: browserProfile.locale,
    seed: fingerprintSeed,
  });
  const viewport = fingerprint.viewport;

  const contextOptions = {
    userAgent: realUserAgent,
    viewport,
    locale: browserProfile.locale,
    timezoneId: browserProfile.timezoneId,
    screen: {
      width: fingerprint.screen.width,
      height: fingerprint.screen.height,
    },
    deviceScaleFactor: 1,
    isMobile: false,
    hasTouch: false,
    extraHTTPHeaders: {
      "sec-ch-ua": `"Not)A;Brand";v="8", "Chromium";v="${chromeMajor}", "Google Chrome";v="${chromeMajor}"`,
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": '"Windows"',
    },
  };
  if (proxyConfig) {
    contextOptions.proxy = proxyConfig;
  }

  // 全程录像，便于回看自动化卡在哪一步（输出到挂载目录，前台可播放）
  if (RECORD_VIDEO) {
    contextOptions.recordVideo = {
      dir: VIDEO_DIR,
      size: { width: 1280, height: 720 },
    };
  }

  context = await browser.newContext(contextOptions);
  const sessionRaw = CONFIG.chatgptSessionJson || CONFIG.chatgptToken;
  const installResult = await installChatGptSession(context, sessionRaw, {
    proxy: CONFIG.proxy,
  });
  const sessionData = installResult?.sessionData || installResult;
  const cookieVerified = Boolean(installResult?.cookieVerified);

  console.log(
    `[指纹] ${viewport.width}x${viewport.height} cores=${fingerprint.hardwareConcurrency} mem=${fingerprint.deviceMemory} gpu=${fingerprint.webglRenderer.slice(0, 48)}`,
  );

  // ============= 指纹伪装 =============
  await context.addInitScript((fp) => {
    const NavProto = Object.getPrototypeOf(navigator);
    const ScrProto = Object.getPrototypeOf(screen);
    const safeDefine = (obj, key, getter) => {
      try {
        Object.defineProperty(obj, key, { get: getter, configurable: true });
      } catch (_) {
        /* ignore */
      }
    };

    // 隐藏 webdriver
    try {
      delete Object.getPrototypeOf(navigator).webdriver;
    } catch (_) {}
    safeDefine(NavProto, "webdriver", () => undefined);
    try {
      Object.defineProperty(navigator, "webdriver", {
        get: () => undefined,
        configurable: true,
      });
    } catch (_) {}

    // navigator.userAgentData
    try {
      const uaData = {
        brands: [
          { brand: "Not)A;Brand", version: "8" },
          { brand: "Chromium", version: String(fp.chromeMajor) },
          { brand: "Google Chrome", version: String(fp.chromeMajor) },
        ],
        mobile: false,
        platform: "Windows",
        getHighEntropyValues: () =>
          Promise.resolve({
            architecture: "x86",
            bitness: "64",
            mobile: false,
            model: "",
            platform: "Windows",
            platformVersion: fp.platformVersion,
            wow64: false,
          }),
        toJSON: () => ({
          brands: uaData.brands,
          mobile: uaData.mobile,
          platform: uaData.platform,
        }),
      };
      safeDefine(NavProto, "userAgentData", () => uaData);
    } catch (_) {}

    // plugins / mimeTypes
    try {
      const pdfMime = Object.create(MimeType.prototype);
      Object.defineProperties(pdfMime, {
        type: { get: () => "application/pdf" },
        suffixes: { get: () => "pdf" },
        description: { get: () => "Portable Document Format" },
      });
      const pdfPlugin = Object.create(Plugin.prototype);
      Object.defineProperties(pdfPlugin, {
        name: { get: () => "Chrome PDF Plugin" },
        filename: { get: () => "internal-pdf-viewer" },
        description: { get: () => "Portable Document Format" },
        length: { get: () => 1 },
        0: { get: () => pdfMime },
      });
      pdfPlugin.item = () => pdfMime;
      pdfPlugin.namedItem = () => pdfMime;

      const fakePlugins = Object.create(PluginArray.prototype);
      Object.defineProperties(fakePlugins, {
        length: { get: () => 1 },
        0: { get: () => pdfPlugin },
      });
      fakePlugins.item = () => pdfPlugin;
      fakePlugins.namedItem = (n) => (n === pdfPlugin.name ? pdfPlugin : null);
      fakePlugins.refresh = () => {};

      const fakeMimeTypes = Object.create(MimeTypeArray.prototype);
      Object.defineProperties(fakeMimeTypes, {
        length: { get: () => 1 },
        0: { get: () => pdfMime },
      });
      fakeMimeTypes.item = () => pdfMime;
      fakeMimeTypes.namedItem = (n) => (n === pdfMime.type ? pdfMime : null);

      safeDefine(NavProto, "plugins", () => fakePlugins);
      safeDefine(NavProto, "mimeTypes", () => fakeMimeTypes);
    } catch (_) {}

    // 语言、平台、硬件
    safeDefine(NavProto, "languages", () => fp.languages);
    safeDefine(NavProto, "language", () => fp.language);
    safeDefine(NavProto, "platform", () => "Win32");
    safeDefine(NavProto, "hardwareConcurrency", () => fp.hardwareConcurrency);
    safeDefine(NavProto, "deviceMemory", () => fp.deviceMemory);
    safeDefine(NavProto, "maxTouchPoints", () => 0);
    safeDefine(NavProto, "vendor", () => "Google Inc.");

    // navigator.connection
    try {
      const conn = {
        effectiveType: fp.connection.effectiveType,
        rtt: fp.connection.rtt,
        downlink: fp.connection.downlink,
        saveData: false,
      };
      safeDefine(NavProto, "connection", () => conn);
    } catch (_) {}

    // window.chrome
    try {
      const fakeChrome = {
        app: {
          isInstalled: false,
          InstallState: {
            DISABLED: "disabled",
            INSTALLED: "installed",
            NOT_INSTALLED: "not_installed",
          },
          RunningState: {
            CANNOT_RUN: "cannot_run",
            READY_TO_RUN: "ready_to_run",
            RUNNING: "running",
          },
          getDetails: () => null,
          getIsInstalled: () => false,
        },
        runtime: {
          OnInstalledReason: {
            CHROME_UPDATE: "chrome_update",
            INSTALL: "install",
            SHARED_MODULE_UPDATE: "shared_module_update",
            UPDATE: "update",
          },
          OnRestartRequiredReason: {
            APP_UPDATE: "app_update",
            OS_UPDATE: "os_update",
            PERIODIC: "periodic",
          },
          PlatformArch: {
            ARM: "arm",
            ARM64: "arm64",
            MIPS: "mips",
            MIPS64: "mips64",
            X86_32: "x86-32",
            X86_64: "x86-64",
          },
          PlatformNaclArch: {
            ARM: "arm",
            MIPS: "mips",
            MIPS64: "mips64",
            X86_32: "x86-32",
            X86_64: "x86-64",
          },
          PlatformOs: {
            ANDROID: "android",
            CROS: "cros",
            LINUX: "linux",
            MAC: "mac",
            OPENBSD: "openbsd",
            WIN: "win",
          },
          RequestUpdateCheckStatus: {
            NO_UPDATE: "no_update",
            THROTTLED: "throttled",
            UPDATE_AVAILABLE: "update_available",
          },
          connect: () => {},
          sendMessage: () => {},
        },
        csi: () => ({
          onloadT: Date.now(),
          pageT: Date.now() - 1000,
          startE: Date.now() - 2000,
          tran: 15,
        }),
        loadTimes: () => ({
          requestTime: Date.now() / 1000 - 2,
          startLoadTime: Date.now() / 1000 - 1.5,
          commitLoadTime: Date.now() / 1000 - 1,
          finishDocumentLoadTime: Date.now() / 1000 - 0.5,
          finishLoadTime: Date.now() / 1000,
          firstPaintTime: Date.now() / 1000 - 0.3,
          firstPaintAfterLoadTime: 0,
          navigationType: "Other",
          wasFetchedViaSpdy: true,
          wasNpnNegotiated: true,
          npnNegotiatedProtocol: "h2",
          wasAlternateProtocolAvailable: false,
          connectionInfo: "h2",
        }),
      };
      Object.defineProperty(window, "chrome", {
        value: fakeChrome,
        writable: true,
        configurable: true,
      });
    } catch (_) {}

    // permissions.query
    try {
      const origQuery = navigator.permissions.query.bind(navigator.permissions);
      navigator.permissions.query = (params) => {
        if (params && params.name === "notifications") {
          return Promise.resolve({
            state:
              typeof Notification !== "undefined"
                ? Notification.permission
                : "default",
            onchange: null,
          });
        }
        return origQuery(params).catch(() => ({
          state: "prompt",
          onchange: null,
        }));
      };
    } catch (_) {}

    // screen
    safeDefine(ScrProto, "availHeight", () => fp.screen.availHeight);
    safeDefine(ScrProto, "availWidth", () => fp.screen.availWidth);
    safeDefine(ScrProto, "colorDepth", () => fp.screen.colorDepth);
    safeDefine(ScrProto, "pixelDepth", () => fp.screen.pixelDepth);
    safeDefine(ScrProto, "width", () => fp.screen.width);
    safeDefine(ScrProto, "height", () => fp.screen.height);

    // Canvas 微噪声
    try {
      const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
      HTMLCanvasElement.prototype.toDataURL = function (...args) {
        const ctx = this.getContext("2d");
        if (ctx) {
          try {
            const w = this.width,
              h = this.height;
            if (w > 0 && h > 0) {
              const data = ctx.getImageData(0, 0, 1, 1);
              data.data[3] = Math.max(1, data.data[3] - fp.canvasNoise);
              ctx.putImageData(data, 0, 0);
            }
          } catch (_) {}
        }
        return origToDataURL.apply(this, args);
      };
    } catch (_) {}

    // WebGL
    try {
      const fakeWebGL = (gl) => {
        const origGetParameter = gl.getParameter.bind(gl);
        gl.getParameter = function (param) {
          if (param === 0x9245) return fp.webglVendor;
          if (param === 0x9246) return fp.webglRenderer;
          return origGetParameter(param);
        };
      };
      const origGetCtx = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (type, ...args) {
        const ctx = origGetCtx.call(this, type, ...args);
        if (
          ctx &&
          (type === "webgl" ||
            type === "webgl2" ||
            type === "experimental-webgl")
        ) {
          try {
            fakeWebGL(ctx);
          } catch (_) {}
        }
        return ctx;
      };
    } catch (_) {}

    // ChromeDriver 痕迹
    try {
      for (const key of Object.keys(window)) {
        if (
          /^(cdc_|\$cdc_|_phantom|callPhantom|webdriver-|driver-)/.test(key)
        ) {
          try {
            delete window[key];
          } catch (_) {}
        }
      }
    } catch (_) {}

    // Notification.permission
    try {
      if (typeof Notification !== "undefined") {
        Object.defineProperty(Notification, "permission", {
          get: () => "default",
          configurable: true,
        });
      }
    } catch (_) {}
  }, fingerprint);

  try {
    // --- Phase 1: Resolve payment parameters ---
    const debugOnly = process.env.CHECKOUT_DEBUG_ONLY === "1";
    if (debugOnly) {
      console.log(
        "[调试] 支付链接调试模式：浏览器注入 Session → Checkout API → 输出链接（不执行支付）",
      );
    } else {
      console.log("[1] 准备自助充值流程...");
    }

    // Determine plan_type: prefer env variable, fallback to CDK lookup
    let planType = CONFIG.planType;
    const cdkCode = CONFIG.cdkCode;
    const email = CONFIG.email;

    if (cdkCode) {
      try {
        const cdkDetails = await store.verifyCdkDetails(cdkCode);
        if (cdkDetails && cdkDetails.plan_type) {
          planType = cdkDetails.plan_type;
        }
      } catch (_) {
        // CDK lookup failed, use default
      }
    }
    if (!planType) {
      planType = "plus";
    }

    // Resolve region and currency (与浏览器 profile 一致)
    const billingCountry = paymentRegion;
    const billingCurrency = regionCfg ? regionCfg.currency : "USD";

    console.log(
      `[1] 套餐类型: ${planType}, 地区: ${paymentRegion}, 币种: ${billingCurrency}`,
    );

    page = await context.newPage();
    page.on("close", () => {
      console.warn(`⚠️ [系统] 当前页面已关闭，关闭前最后 URL: ${page.url()}`);
    });

    const loginInfo = await bootstrapChatGptSession(page, sessionRaw, {
      sessionData,
      cookieVerified,
    });
    if (loginInfo.email && !email) {
      console.log(`[Info] 账号邮箱: ${loginInfo.email}`);
    }

    // --- Phase 2: API 创建 Checkout（注入账单地区），失败时回退 UI 定价页 ---
    const checkoutMode = String(
      process.env.CHECKOUT_MODE || "api",
    ).toLowerCase();
    let checkoutOpened = false;
    let checkoutResult = null;
    const planNameOverride =
      String(CONFIG.planNameOverride || "").trim() || undefined;
    const customCheckoutUrl = String(CONFIG.checkoutUrl || "").trim();

    if (customCheckoutUrl) {
      console.log(
        `[步骤] 自定义付款：Session 已登录，正在打开付款链接 ${customCheckoutUrl}`,
      );
      await page.goto(customCheckoutUrl, {
        waitUntil: "domcontentloaded",
        timeout: 90000,
      });
      await page
        .waitForLoadState("networkidle", { timeout: 30000 })
        .catch(() => {});
      checkoutResult = hydrateCheckoutFromUrl(
        { checkoutUrl: customCheckoutUrl },
        page.url(),
      );
      checkoutOpened = true;
    } else if (checkoutMode === "api" || checkoutMode === "auto") {
      try {
        checkoutResult = await openApiCheckout(page, {
          accessToken: loginInfo.session?.accessToken || CONFIG.chatgptToken,
          planType,
          country: billingCountry,
          currency: billingCurrency,
          planNameOverride,
          creditQuantity: Number(CONFIG.creditQuantity || 0),
          verifyPage: !debugOnly,
        });
        checkoutOpened = true;
      } catch (apiError) {
        console.warn(`[Warn] API Checkout 失败: ${apiError.message}`);
        if (checkoutMode === "auto") {
          console.log("[Info] 正在回退到 UI 定价页流程...");
        } else {
          throw apiError;
        }
      }
    } else {
      console.log(
        "[Info] Session 已登录，Checkout 走页面升级按钮后再付款",
      );
    }

    if (!checkoutOpened) {
      console.log("🧭 [步骤] 正在打开定价页并选择升级套餐...");
      const pricingUrl = await openPricingCheckout(page, {
        region: billingCountry,
        planType,
      });
      checkoutResult = { checkoutUrl: pricingUrl || page.url() };
    }

    if (debugOnly) {
      const checkoutUrl = checkoutResult?.checkoutUrl || page.url();
      console.log(`🔗 [调试] 支付链接: ${checkoutUrl}`);
      console.log(`CHECKOUT_URL: ${checkoutUrl}`);
      console.log("CHECKOUT_DEBUG_SUCCESS");
      return;
    }

    console.log("✅ [步骤] Checkout 页面已打开，开始信用卡支付流程...");

    checkoutResult = hydrateCheckoutFromUrl(checkoutResult, page.url());
    const stripeSessionId = checkoutResult?.sessionId || null;
    let accessToken = loginInfo.session?.accessToken || CONFIG.chatgptToken;
    let cardGroupId = null;
    const envCardGroupId = Number(process.env.PAYMENT_CARD_GROUP_ID || 0);
    if (envCardGroupId > 0) {
      cardGroupId = envCardGroupId;
      console.log(`[Info] 任务指定银行卡分组: ${cardGroupId}`);
    } else if (cdkCode) {
      try {
        const cdkDetails = await store.verifyCdkDetails(cdkCode);
        if (cdkDetails?.card_group_id) {
          cardGroupId = Number(cdkDetails.card_group_id);
          console.log(`[Info] CDK 指定银行卡分组: ${cardGroupId}`);
        }
      } catch (_) {
        /* ignore */
      }
    }
    if (stripeSessionId) {
      console.log(`[Info] Checkout session: ${stripeSessionId}`);
    }

    if (String(process.env.CHECKOUT_WAIT_USER || "").trim() === "1") {
      const { waitForCustomCheckoutUserContinue } = require("./stripe-payment");
      await waitForCustomCheckoutUserContinue(page, {
        jobKey: process.env.JOB_KEY,
        checkoutUrl:
          customCheckoutUrl ||
          checkoutResult?.checkoutUrl ||
          (typeof page.url === "function" ? page.url() : ""),
      });
    }

    // --- Phase 4: Execute Payment with Card Pool Retry ---
    console.log("[步骤] 正在使用协议优先支付流程...");
    const paymentResult = await executePaymentWithRetry(page, {
      planType,
      cdkCode,
      email: email || loginInfo.email,
      stripeSessionId,
      accessToken,
      checkout: checkoutResult,
      accountId: checkoutResult?.accountId || loginInfo.accountId,
      cardGroupId,
    });

    if (paymentResult.success) {
      paymentSucceeded = true;
      const isCredits =
        store.isCreditsPlan(planType) || Number(CONFIG.creditQuantity || 0) > 0;
      const cancelAutoRenewEnabled = !["0", "false", "no", "off"].includes(
        String(process.env.CANCEL_AUTO_RENEW ?? "1")
          .trim()
          .toLowerCase(),
      );
      if (!isCredits && cancelAutoRenewEnabled) {
        console.log("[步骤] 支付完成，正在换发 Session...");
        const previousToken = accessToken;
        const tracker = createChatGptLiveStateTracker(page, { previousToken });
        try {
          const fresh = await preparePostPaymentSubscription(page, {
            accessToken: previousToken,
            tracker,
          });
          const cancelToken = String(fresh.accessToken || "").trim();
          if (!cancelToken || cancelToken === previousToken) {
            console.warn(
              "⚠️ [步骤] 未拿到支付后新 Session，已跳过用旧 Token 取消续费",
            );
          } else {
            accessToken = cancelToken;
            console.log("[步骤] 已拿到新 Session，正在关闭自动续费...");
            const cancelResult = await cancelAutoRenewWithBrowserPage(page, {
              accountId: checkoutResult?.accountId || loginInfo.accountId,
              email: email || loginInfo.email,
              accessToken: cancelToken,
              maxAttempts: 6,
              delayMs: 200,
              verifyAttempts: 2,
              verifyDelayMs: 300,
              paymentFailureNote: true,
              refreshAccessToken: async () => {
                const failedToken = String(accessToken || "").trim();
                const rotated = String(tracker.getRotatedToken?.() || "").trim();
                if (rotated && rotated !== previousToken && rotated !== failedToken) {
                  return rotated;
                }
                const captured = String(tracker.getToken?.() || "").trim();
                if (
                  captured &&
                  captured !== previousToken &&
                  captured !== failedToken
                ) {
                  return captured;
                }
                const live = await fetchLiveChatGptSession(page, {
                  forceRefresh: true,
                });
                const liveToken = String(live.ok ? live.accessToken : "").trim();
                if (
                  liveToken &&
                  liveToken !== previousToken &&
                  liveToken !== failedToken
                ) {
                  return liveToken;
                }
                const next = await acquireFreshChatGptAccessToken(page, {
                  previousToken,
                  excludeToken: failedToken,
                  tracker,
                  maxAttempts: 1,
                  allowNavigate: false,
                });
                return next.accessToken || "";
              },
              onStatus: (message) => console.log(`[步骤] ${message}`),
            });
            if (cancelResult.ok) {
              const cancelMessage =
                cancelResult.data?.message || "已提交取消自动续费请求";
              if (
                cancelResult.data?.confirmed ||
                cancelResult.data?.alreadyCancelled
              ) {
                console.log(`✅ [步骤] ${cancelMessage}`);
              } else {
                console.warn(`⚠️ [步骤] ${cancelMessage}`);
              }
            } else {
              console.warn(
                `⚠️ [步骤] 关闭自动续费失败: ${cancelResult.error || "未知错误"}`,
              );
            }
          }
        } finally {
          tracker.dispose();
        }
      } else if (!isCredits) {
        console.log("[步骤] 已按选项跳过关闭自动续费");
      }
      console.log("PAYMENT_SUCCESS");
      removeMediaFiles(paymentResult.screenshots);
    } else {
      const errorMsg = paymentResult.error || "支付失败（未知原因）";
      for (const screenshotPath of paymentResult.screenshots || []) {
        console.log(`FAILURE_SCREENSHOT: ${screenshotPath}`);
      }
      throw new Error(`支付失败 (manual_intervention): ${errorMsg}`);
    }
  } catch (e) {
    console.error("❌ [运行时错误]:", e.message);
    try {
      const errorShot = await captureDebugScreenshot(context, page, "error");
      if (errorShot) {
        console.log(`FAILURE_SCREENSHOT: ${errorShot}`);
      }
    } catch (err) {
      console.error(`⚠️ [系统] 异常截图保存失败: ${err.message}`);
    }
    // 用 exitCode 而非 process.exit()，确保下方 finally 能完整执行（录像需 context 关闭后才落盘）
    process.exitCode = 1;
  } finally {
    console.log("👋 [系统] 流程结束，正在关闭浏览器...");
    // 先关闭 context 以 flush 录像并取回路径，再关浏览器
    await finalizeVideo(context, page, {
      deleteOnSuccess: paymentSucceeded,
    }).catch(() => {});
    await closeTaskBrowser(browserSession, browser);
    await proxyCleanup();
  }
}

run().finally(() => {
  // 录像已在 run() 的 finally 中落盘；此处兜底强制退出，避免 mysql 连接池保持事件循环导致子进程不退出
  setTimeout(() => process.exit(process.exitCode || 0), 800).unref();
});
