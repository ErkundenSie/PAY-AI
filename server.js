require("./load-env");

const express = require("express");
const { spawn, execFile } = require("child_process");
const path = require("path");
const crypto = require("crypto");
const dns = require("dns").promises;
const net = require("net");
const fs = require("fs");
const os = require("os");
const WebSocket = require("ws");
const axios = require("axios");
const store = require("./mysql-store");
const runtimeLog = require("./runtime-log");
const mediaCleanup = require("./media-cleanup");
const { rejectCrossOriginAdmin } = require("./admin-csrf");
const {
  redactSensitiveText,
  redactInternalErrorForLog,
  redactTaskDetailOutput,
} = require("./log-redact");
const { REGION_CONFIG, isSupportedRegion, getRegionBrowserProfile } = require("./region-config");
const { getPlanTypeLabel } = require("./credit-quantity");
const {
  isCustomPayCdk,
  isAdminPaymentCdk,
  resolvePublicCheckoutCdk,
  buildCheckoutTaskCreate,
  buildCheckoutTaskUpdate,
} = require("./checkout-task-log");
const { parseCheckoutUrl } = require("./checkout-protocol");
const {
  setCheckoutChoice,
  isWaitingCheckoutChoice,
  clearCheckoutChoice,
} = require("./checkout-choice");
const taxFreeAddress = require("./tax-free-address");
const { testProxyUrl, normalizeProxyLines, mapWithConcurrency } = require("./proxy-pool");
const {
  extractSessionPreview,
  extractAccessTokenFromRaw,
  parseSessionJson,
  extractEmailFromSession,
  buildSessionCookieHeader,
  formatCookieHeader,
  installChatGptSession,
  refreshSessionAccessToken,
  refreshLiveChatGptAccessToken,
  acquireFreshChatGptAccessToken,
  fetchLiveChatGptSession,
  captureLiveChatGptSessionExport,
  CHATGPT_ORIGIN,
} = require("./session-auth");
const {
  notifyTelegramEvent,
  notifyAdminSecurityEvent,
  sendTelegramLoginCode,
  sendTelegramTest,
  isCardPoolExhaustedIssue,
} = require("./telegram-notify");
const adminAuth = require("./admin-auth");
const {
  buildAdminLoginUrl,
  buildAdminPanelUrl,
  buildCheckoutUrl,
} = require("./admin-paths");
const { buildHcaptchaEnvFromConfig } = require("./hcaptcha-runtime");
const {
  checkHcaptchaSolverHealth,
  testVlmConnectivity,
  listSolverLogFiles,
  readSolverLogTail,
} = require("./hcaptcha-solver");
const {
  testCaptchaPlatformConnectivity,
  normalizeCaptchaPlatformApiUrl,
  resolveCaptchaPlatformCredentials,
} = require("./captcha-platform");
const browserPool = require("./browser-pool");
const { preparePlaywrightProxy } = require("./playwright-proxy");
const { buildWorkerRuntimeEnv } = require("./browser-runtime");
const {
  querySubscriptionBySession,
  queryAccountStatusBySession,
  queryAccountStatusWithBrowserPage,
  createChatGptLiveStateTracker,
  resetCodexQuota,
  resetCodexQuotaWithBrowserPage,
  validateSessionTokenForQuery,
  cancelAutoRenew,
  cancelAutoRenewAfterActivation,
  cancelAutoRenewWithBrowserPage,
  resumeAutoRenew,
  resumeAutoRenewWithBrowserPage,
} = require("./subscription-check");
const gptApi = require("./gpt-api-client");
const cardValidator = require("./card-validator");
const { decodeJwtPart } = require("./public/jwt-decode");
const { createCdks } = require("./cdk-codes");
const { registerAdminAssetRoutes } = require("./routes/admin-assets");
const { registerPublicRoutes } = require("./routes/public");
const {
  registerAdminLoginRoutes,
  registerAdminSecurityRoutes,
} = require("./routes/admin-auth");

const app = express();
const PORT = Number(process.env.PORT || 17621);
const TRUST_PROXY = String(process.env.TRUST_PROXY || "0") === "1";
const VERIFY_OPENAI_TOKEN_ON_ACTIVATION =
  String(process.env.VERIFY_OPENAI_TOKEN_ON_ACTIVATION || "1") !== "0";
const ADMIN_TOKEN_TTL_MS = adminAuth.ADMIN_TOKEN_TTL_MS;
const ADMIN_REFRESH_AFTER_MS = adminAuth.ADMIN_REFRESH_AFTER_MS;
const PROCESS_IDLE_TIMEOUT_MS =
  Number(process.env.PROCESS_IDLE_TIMEOUT_MS) || 3 * 60 * 1000;
const MAX_PROCESS_ATTEMPTS = Number(process.env.MAX_PROCESS_ATTEMPTS) || 1;
const WS_HEARTBEAT_PING_TYPE = "ping";
const WS_HEARTBEAT_PONG_TYPE = "pong";
const ACCESS_DEACTIVATED_MESSAGES_URL = "";
const ACCESS_DEACTIVATED_SYNC_KEY = "";
const ACCESS_DEACTIVATED_SYNC_COOLDOWN_MS = 30 * 1000;
// Validate configured signing material (or create the secure persistent fallback) at startup.
adminAuth.resolveAdminTokenSecret();

app.disable("x-powered-by");
app.set("trust proxy", TRUST_PROXY ? 1 : false);

// 追踪活跃的子进程，防止产生僵尸进程
const activeProcesses = new Set();
function cleanupProcesses() {
  if (activeProcesses.size > 0) {
    console.log(`清理 ${activeProcesses.size} 个活跃子进程...`);
    for (const child of activeProcesses) {
      try {
        child.kill("SIGKILL");
      } catch (e) {}
    }
    activeProcesses.clear();
  }
  browserPool.shutdownBrowserPool().catch((error) => {
    console.warn(`[BrowserPool] 关闭失败: ${error.message}`);
  });
}

// WebSocket 客户端映射: jobKey -> Set<WebSocket>
const taskClients = new Map();
const TERMINAL_TASK_STATUSES = new Set([
  "success",
  "failed",
  "maintenance",
  "manual",
]);
const activeForegroundJobs = new Set();
const jobChildren = new Map();
const abortedJobs = new Set();

let systemMetricsCache = {
  ts: 0,
  data: null,
  promise: null,
};
let diskMetricsCache = {
  ts: 0,
  data: null,
  promise: null,
};
let cpuSample = {
  ts: 0,
  idle: 0,
  total: 0,
  percent: 0,
};

function formatGiB(bytes) {
  return `${(Number(bytes || 0) / 1024 ** 3).toFixed(1)}G`;
}

function readCpuTimes() {
  return (os.cpus() || []).reduce(
    (acc, cpu) => {
      const times = cpu.times || {};
      const idle = Number(times.idle || 0);
      const total = Object.values(times).reduce(
        (sum, value) => sum + Number(value || 0),
        0,
      );
      acc.idle += idle;
      acc.total += total;
      return acc;
    },
    { idle: 0, total: 0 },
  );
}

function sampleCpuPercent() {
  const now = Date.now();
  const current = readCpuTimes();
  const cpuCount = Math.max(1, (os.cpus() || []).length);
  const load = Number(os.loadavg()[0] || 0);
  const loadPercent = Math.min(100, Math.round((load / cpuCount) * 100));
  let percent = cpuSample.percent || loadPercent;
  if (cpuSample.ts && current.total > cpuSample.total) {
    const idleDelta = current.idle - cpuSample.idle;
    const totalDelta = current.total - cpuSample.total;
    if (totalDelta > 0) {
      percent = Math.min(
        100,
        Math.max(0, Math.round((1 - idleDelta / totalDelta) * 100)),
      );
    }
  }
  cpuSample = { ts: now, idle: current.idle, total: current.total, percent };
  return {
    percent,
    load,
    cpuCount,
    text: `占用 ${percent}% · 负载 ${load.toFixed(2)} / ${cpuCount} 核`,
  };
}

function parseDfKilobytes(output, fallbackDrive = "/") {
  const lines = String(output || "")
    .trim()
    .split("\n");
  if (lines.length < 2) return null;
  const parts = lines[1].trim().split(/\s+/);
  const total = Number(parts[1] || 0) * 1024;
  const used = Number(parts[2] || 0) * 1024;
  if (!Number.isFinite(total) || total <= 0) return null;
  return {
    percent: Math.min(100, Math.round((used / total) * 100)),
    usedText: formatGiB(used),
    totalText: formatGiB(total),
    drive: parts[5] || fallbackDrive,
  };
}

function execFileText(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { encoding: "utf8", timeout: 1500 }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(String(stdout || ""));
    });
  });
}

async function readDiskMetrics() {
  const now = Date.now();
  if (diskMetricsCache.data && now - diskMetricsCache.ts < 15000) {
    return diskMetricsCache.data;
  }
  if (diskMetricsCache.promise) {
    return diskMetricsCache.promise;
  }
  const fallback = {
    percent: 0,
    usedText: "0.0G",
    totalText: "0.0G",
    drive: "/",
  };
  diskMetricsCache.promise = (async () => {
    const targets = ["/host", "/", process.cwd()];
    for (const target of targets) {
      try {
        if (target !== "/" && target !== process.cwd() && !fs.existsSync(target)) {
          continue;
        }
        const dfOut = await execFileText("df", ["-kP", target]);
        const disk = parseDfKilobytes(dfOut, target);
        if (disk) {
          diskMetricsCache = { ts: Date.now(), data: disk, promise: null };
          return disk;
        }
      } catch (_) {
        /* try next mount */
      }
    }
    diskMetricsCache = { ts: Date.now(), data: fallback, promise: null };
    return fallback;
  })().catch((error) => {
    diskMetricsCache.promise = null;
    throw error;
  });
  return diskMetricsCache.promise;
}

async function getSystemMetrics() {
  const now = Date.now();
  if (systemMetricsCache.data && now - systemMetricsCache.ts < 3000) {
    return systemMetricsCache.data;
  }
  if (systemMetricsCache.promise) {
    return systemMetricsCache.promise;
  }

  systemMetricsCache.promise = (async () => {
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    const cpu = sampleCpuPercent();
    const disk = await readDiskMetrics();
    const data = {
      cpu: {
        percent: cpu.percent,
        text: cpu.text,
      },
      memory: {
        percent: totalMem > 0 ? Math.round((usedMem / totalMem) * 100) : 0,
        text: `${formatGiB(usedMem)}/${formatGiB(totalMem)}`,
      },
      disk,
      uptime: { seconds: Math.floor(os.uptime()) },
    };
    systemMetricsCache.data = data;
    systemMetricsCache.ts = Date.now();
    systemMetricsCache.promise = null;
    return data;
  })().catch((error) => {
    systemMetricsCache.promise = null;
    throw error;
  });

  return systemMetricsCache.promise;
}

function reserveForegroundSlot(slotKey) {
  activeForegroundJobs.add(String(slotKey));
}

function releaseForegroundSlot(slotKey) {
  activeForegroundJobs.delete(String(slotKey));
}

async function reapOrphanCheckoutTasks({ startup = false } = {}) {
  const message = startup
    ? "服务重启，任务已中断"
    : "任务进程已退出，状态已回收";
  const result = await store.failOrphanRunningCheckoutTasks({
    excludeJobKeys: startup ? [] : [...activeForegroundJobs],
    minAgeSeconds: startup ? 0 : 60,
    message,
  });
  for (const jobKey of result.jobKeys || []) {
    clearCheckoutChoice(jobKey);
    logTask(jobKey, message, "warn");
    broadcastToTask(jobKey, {
      type: "status",
      jobKey,
      status: "failed",
      message,
      progress: 100,
    });
  }
  if (result.failed) {
    console.warn(`[Checkout] 已回收 ${result.failed} 个卡住的调试任务`);
  }
  return result;
}

let drainingActivationQueue = false;
async function drainActivationQueue() {
  if (drainingActivationQueue) return;
  drainingActivationQueue = true;
  try {
    while (true) {
      const maxConcurrentActivations =
        await store.getMaxConcurrentActivations();
      if (activeForegroundJobs.size >= maxConcurrentActivations) {
        break;
      }
      const queued = await store.claimNextQueuedActivation();
      if (!queued) break;
      const cdk = queued.cdkCode;
      const sessionRaw = queued.sessionPayload || "";
      const token = normalizeSessionToken(sessionRaw);
      const cdkDetails = cdk ? await store.verifyCdkDetails(cdk) : null;
      if (!cdk || !token || !cdkDetails) {
        await store.updateTaskLog(queued.jobKey, {
          status: "failed",
          message: "排队任务数据无效，已取消",
          progress: 100,
        });
        if (cdk) await store.markCdkUnused(cdk).catch(() => {});
        continue;
      }
      const gptApiConfig = await store.getGptApiConfig();
      const useGptApi =
        gptApiConfig.enabled &&
        Boolean(gptApiConfig.api_key) &&
        !store.isCreditsPlan(cdkDetails.plan_type);
      const task = {
        jobKey: queued.jobKey,
        tokenPreview: queued.tokenPreview,
      };
      logTask(
        queued.jobKey,
        `排队任务开始执行，CDK=${cdk} mode=${useGptApi ? "gpt-api" : "local"}`,
      );
      reserveForegroundSlot(queued.jobKey);
      broadcastToTask(queued.jobKey, {
        type: "progress",
        jobKey: queued.jobKey,
        status: "running",
        message: "排队完成，正在开通中",
        progress: 3,
      });
      if (useGptApi) {
        let session = null;
        try {
          session = JSON.parse(sessionRaw);
        } catch (_) {
          session = { access_token: token };
        }
        runGptApiWorker({
          task,
          token,
          session,
          cdk,
          planType: cdkDetails.plan_type || "plus",
          proxyGroupId: cdkDetails.proxy_group_id,
        }).catch((error) => {
          console.error(`[GPT API Worker] ${queued.jobKey}:`, error);
        });
      } else {
        spawnActivationWorker({
          task,
          token,
          sessionRaw,
          cdk,
          cdkDetails,
          clientIp: "",
        });
      }
    }
  } catch (error) {
    console.warn(`[Queue] drainActivationQueue: ${error.message}`);
  } finally {
    drainingActivationQueue = false;
  }
}

function getTotalActiveJobs() {
  return activeForegroundJobs.size;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getClientIp(req) {
  const forwarded = TRUST_PROXY
    ? String(req.headers["x-forwarded-for"] || "").trim()
    : "";
  const rawIp = forwarded
    ? forwarded.split(",")[0].trim()
    : req.socket?.remoteAddress || "";
  return String(rawIp || "")
    .replace(/^::ffff:/, "")
    .replace(/^::1$/, "127.0.0.1")
    .trim();
}

function safeEqualString(left, right) {
  const leftBuffer = Buffer.from(String(left || ""));
  const rightBuffer = Buffer.from(String(right || ""));
  return (
    leftBuffer.length === rightBuffer.length &&
    crypto.timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function isPrivateNetworkAddress(address) {
  const value = String(address || "").toLowerCase();
  if (net.isIPv4(value)) {
    const [a, b] = value.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 0 || b === 168)) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  return (
    value === "::" ||
    value === "::1" ||
    value.startsWith("fc") ||
    value.startsWith("fd") ||
    value.startsWith("fe80:")
  );
}

async function validateExternalApiBaseUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl || "").trim());
  } catch (_) {
    return "外部 API 地址格式无效";
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    return "外部 API 仅支持不含账号密码的 HTTPS 地址";
  }
  try {
    const addresses = await dns.lookup(parsed.hostname, {
      all: true,
      verbatim: true,
    });
    if (
      !addresses.length ||
      addresses.some(({ address }) => isPrivateNetworkAddress(address))
    ) {
      return "外部 API 地址不能指向内网或本机地址";
    }
  } catch (_) {
    return "外部 API 域名无法解析";
  }
  return "";
}

function resolvePathWithin(root, relativePath) {
  const resolved = path.resolve(root, relativePath);
  const relative = path.relative(root, resolved);
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    return "";
  }
  return resolved;
}

const publicRequestWindows = new Map();
const PUBLIC_RATE_LIMIT_MAX_KEYS = 10_000;

function prunePublicRequestWindows(now = Date.now(), windowMs = 60 * 1000) {
  for (const [key, entry] of publicRequestWindows) {
    if (!entry || now - Number(entry.startedAt || 0) >= windowMs) {
      publicRequestWindows.delete(key);
    }
  }
  if (publicRequestWindows.size <= PUBLIC_RATE_LIMIT_MAX_KEYS) {
    return;
  }
  const overflow = publicRequestWindows.size - PUBLIC_RATE_LIMIT_MAX_KEYS;
  let removed = 0;
  for (const key of publicRequestWindows.keys()) {
    publicRequestWindows.delete(key);
    removed += 1;
    if (removed >= overflow) break;
  }
}

function limitPublicRequests(scope, limit, windowMs) {
  return (req, res, next) => {
    const now = Date.now();
    if (publicRequestWindows.size > PUBLIC_RATE_LIMIT_MAX_KEYS * 0.9) {
      prunePublicRequestWindows(now, windowMs);
    }
    const key = `${scope}:${getClientIp(req) || "unknown"}`;
    const current = publicRequestWindows.get(key);
    const entry =
      current && now - current.startedAt < windowMs
        ? current
        : { startedAt: now, count: 0 };
    entry.count += 1;
    publicRequestWindows.set(key, entry);
    if (entry.count > limit) {
      const retryAfterSec = Math.max(
        1,
        Math.ceil((windowMs - (now - entry.startedAt)) / 1000),
      );
      res.setHeader("Retry-After", String(retryAfterSec));
      return res
        .status(429)
        .json({ success: false, message: "请求过于频繁，请稍后再试" });
    }
    return next();
  };
}

function getRemainingCooldownMinutes(cooldownUntil) {
  if (!cooldownUntil) {
    return 0;
  }
  const cooldownDate = new Date(cooldownUntil);
  if (
    !(cooldownDate instanceof Date) ||
    Number.isNaN(cooldownDate.getTime()) ||
    cooldownDate <= new Date()
  ) {
    return 0;
  }
  return Math.ceil((cooldownDate - new Date()) / 60000);
}

function isNoActivationEligibilityMessage(message) {
  return String(message || "").includes("无激活权限");
}

function parseFlexibleTimestamp(value) {
  if (value == null || value === "") {
    return null;
  }

  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isFinite(time) ? time : null;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    if (value > 1e12) {
      return Math.trunc(value);
    }
    if (value > 1e9) {
      return Math.trunc(value * 1000);
    }
    return null;
  }

  const normalized = String(value).trim();
  if (!normalized) {
    return null;
  }

  if (/^\d{13}$/.test(normalized)) {
    return Number(normalized);
  }
  if (/^\d{10}$/.test(normalized)) {
    return Number(normalized) * 1000;
  }

  const candidate = normalized.includes("T")
    ? normalized
    : normalized.replace(" ", "T");
  const parsed = Date.parse(candidate);
  if (Number.isFinite(parsed)) {
    return parsed;
  }

  return null;
}

function broadcastToTask(jobKey, data) {
  const clients = taskClients.get(jobKey);
  if (clients) {
    const message = JSON.stringify({
      type: data.type,
      jobKey: String(jobKey),
      status: data.status,
      message: data.message,
      progress: Number(data.progress || 0),
      isTerminal: TERMINAL_TASK_STATUSES.has(data.status),
    });
    for (const client of clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    }
  }
}

function unsubscribeTaskClient(jobKey, ws) {
  if (!jobKey || !taskClients.has(jobKey)) {
    return;
  }
  const clients = taskClients.get(jobKey);
  clients.delete(ws);
  if (clients.size === 0) {
    taskClients.delete(jobKey);
  }
}

async function sendTaskSnapshot(ws, jobKey) {
  const task = await store.getTaskStatus(jobKey);
  if (!task || ws.readyState !== WebSocket.OPEN) {
    return;
  }

  ws.send(
    JSON.stringify({
      type: "snapshot",
      jobKey,
      status: task.status,
      message: task.message,
      progress: Number(task.progress || 0),
      isTerminal: TERMINAL_TASK_STATUSES.has(task.status),
    }),
  );
}

function logTask(jobKey, message, level = "log") {
  const text = String(message || "");
  runtimeLog.push({
    jobKey,
    level,
    source: "task",
    text,
  });
  const logger = console[level] || console.log;
  logger(`[Task ${jobKey}] ${redactSensitiveText(text, { maxLen: 8192 })}`);
}

function logTaskChunk(jobKey, attempt, source, chunk) {
  const text = String(chunk || "");
  if (!text) {
    return;
  }

  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n");
  for (const line of lines) {
    if (!line.trim()) {
      continue;
    }
    const lineText = line.replace(/^CAPTCHA_LOG:\s*/, "");
    runtimeLog.push({
      jobKey,
      level:
        line.includes("CAPTCHA_LOG:") || line.includes("[Captcha/")
          ? "captcha"
          : source === "stderr"
            ? "stderr"
            : "stdout",
      source:
        line.includes("CAPTCHA_LOG:") || line.includes("[Captcha/")
          ? "captcha"
          : `spawn/a${attempt}/${source}`,
      text: lineText,
    });
    console.log(
      `[Task ${jobKey}][Attempt ${attempt}][${source}] ${redactSensitiveText(lineText, { maxLen: 8192 })}`,
    );
  }
}

process.on("SIGINT", () => {
  cleanupProcesses();
  process.exit(0);
});
process.on("SIGTERM", () => {
  cleanupProcesses();
  process.exit(0);
});
process.on("exit", () => cleanupProcesses());

let storeReadyPromise = null;

function resolveJsonBodyLimit() {
  const raw = String(process.env.JSON_BODY_LIMIT || "2mb").trim().toLowerCase();
  const match = raw.match(/^(\d+(?:\.\d+)?)(kb|mb)?$/);
  if (!match) return "2mb";
  const amount = Number(match[1]);
  const unit = match[2] || "mb";
  const bytes = unit === "kb" ? amount * 1024 : amount * 1024 * 1024;
  const maxBytes = 2 * 1024 * 1024;
  if (!Number.isFinite(bytes) || bytes <= 0 || bytes > maxBytes) {
    return "2mb";
  }
  return raw;
}

const JSON_BODY_LIMIT = resolveJsonBodyLimit();

app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=()",
  );
  if (req.path.startsWith("/api")) {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  }
  if (
    req.secure ||
    (TRUST_PROXY &&
      String(req.headers["x-forwarded-proto"] || "")
        .split(",")[0]
        .trim() === "https")
  ) {
    res.setHeader(
      "Strict-Transport-Security",
      "max-age=31536000; includeSubDomains",
    );
  }
  const blocked = rejectCrossOriginAdmin(req, { trustProxy: TRUST_PROXY });
  if (blocked) {
    return res.status(blocked.status).json({
      success: false,
      message: blocked.message,
    });
  }
  next();
});
app.use(express.json({ limit: JSON_BODY_LIMIT }));

app.use((req, res, next) => {
  const sendJson = res.json.bind(res);
  res.json = function sendSanitizedJson(body) {
    if (
      res.statusCode === 500 &&
      body &&
      typeof body === "object" &&
      !Array.isArray(body) &&
      (typeof body.message === "string" || typeof body.error === "string")
    ) {
      const detail = body.message || body.error;
      console.error(
        `[HTTP] ${req.method} ${req.path} failed: ${redactInternalErrorForLog(detail)}`,
      );
      const safeBody = { ...body };
      if (typeof safeBody.message === "string") {
        safeBody.message = "服务器内部错误，请稍后重试";
      }
      if (typeof safeBody.error === "string") {
        safeBody.error = "服务器内部错误，请稍后重试";
      }
      return sendJson(safeBody);
    }
    return sendJson(body);
  };
  next();
});

let cachedAdminPaths = null;

async function getCachedAdminPaths() {
  if (cachedAdminPaths) {
    return cachedAdminPaths;
  }
  await ensureStoreReady();
  cachedAdminPaths = await store.getAdminPaths();
  return cachedAdminPaths;
}

function invalidateAdminPathsCache() {
  cachedAdminPaths = null;
}

function setCachedAdminPaths(paths) {
  cachedAdminPaths = paths || null;
}

function normalizeRequestPathname(pathname) {
  return String(pathname || "/").replace(/\/+$/, "") || "/";
}

async function attachAdminPaths(payload) {
  const paths = await getCachedAdminPaths();
  return {
    ...payload,
    loginPath: buildAdminLoginUrl(paths),
    panelPath: buildAdminPanelUrl(paths),
    checkoutPath: buildCheckoutUrl(paths),
  };
}

app.use((req, res, next) => {
  if (
    req.method === "GET" &&
    ["/admin.html", "/admin-login.html"].includes(req.path)
  ) {
    return res.status(404).type("text/plain").send("Not Found");
  }
  next();
});

app.use(async (req, res, next) => {
  if (req.method !== "GET") {
    return next();
  }
  try {
    const paths = await getCachedAdminPaths();
    const current = normalizeRequestPathname(req.path);
    const loginUrl = normalizeRequestPathname(buildAdminLoginUrl(paths));
    const panelUrl = normalizeRequestPathname(buildAdminPanelUrl(paths));
    const checkoutUrl = normalizeRequestPathname(buildCheckoutUrl(paths));
    if (current === loginUrl) {
      return res.sendFile(path.join(__dirname, "public", "admin-login.html"));
    }
    if (current === panelUrl) {
      return res.sendFile(path.join(__dirname, "public", "admin.html"));
    }
    if (current === checkoutUrl) {
      return res.sendFile(path.join(__dirname, "public", "checkout.html"));
    }
  } catch (_) {
    // DB 尚未就绪时交给后续路由处理
  }
  return next();
});

app.get("/us-tax-free-address.js", (req, res) => {
  res.type("application/javascript");
  res.sendFile(path.join(__dirname, "public", "us-tax-free-address.js"));
});

app.use(express.static(path.join(__dirname, "public")));

function ensureStoreReady() {
  if (!storeReadyPromise) {
    storeReadyPromise = store.ensureReady().catch((error) => {
      storeReadyPromise = null;
      throw error;
    });
  }
  return storeReadyPromise;
}

function normalizeSessionToken(raw) {
  return extractAccessTokenFromRaw(raw);
}

function normalizeSessionRaw(raw) {
  return parseSessionJson(raw) ? String(raw || "").trim() : "";
}

function buildStoredSessionPayload(rawSession, sessionJson, token) {
  if (sessionJson) {
    return normalizeSessionRaw(rawSession) || JSON.stringify(sessionJson);
  }
  if (rawSession.startsWith("{")) {
    return rawSession;
  }
  if (token) {
    return JSON.stringify({
      accessToken: token,
      user: null,
      expires: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    });
  }
  return rawSession;
}

function validateAccessToken(token) {
  const value = String(token || "").trim();
  if (!value) {
    return { valid: false, message: "缺少 AccessToken" };
  }

  const parts = value.split(".");
  if (parts.length !== 3 || parts.some((item) => !item)) {
    return { valid: false, message: "该 Token 不合法：格式错误" };
  }

  let header;
  let payload;
  try {
    header = decodeJwtPart(parts[0]);
    payload = decodeJwtPart(parts[1]);
  } catch (_) {
    return { valid: false, message: "该 Token 不合法：无法解析" };
  }

  if (header.typ !== "JWT") {
    return { valid: false, message: "该 Token 不合法：类型错误" };
  }

  if (header.alg !== "RS256") {
    return { valid: false, message: "该 Token 不合法：算法错误" };
  }

  if (payload.iss !== "https://auth.openai.com") {
    return { valid: false, message: "该 Token 不合法：签发方错误" };
  }

  const audiences = Array.isArray(payload.aud)
    ? payload.aud
    : [payload.aud].filter(Boolean);
  if (!audiences.includes("https://api.openai.com/v1")) {
    return { valid: false, message: "该 Token 不合法：aud 不匹配" };
  }

  const authInfo = payload["https://api.openai.com/auth"];
  if (!authInfo || !authInfo.chatgpt_account_id || !authInfo.chatgpt_user_id) {
    return { valid: false, message: "该 Token 不合法：缺少账户信息" };
  }

  const scopes = Array.isArray(payload.scp) ? payload.scp : [];
  if (!scopes.includes("model.request")) {
    return {
      valid: false,
      message: "该 Token 不合法：缺少 model.request 权限",
    };
  }

  const exp = Number(payload.exp || 0);
  const now = Math.floor(Date.now() / 1000);
  if (!exp || !Number.isFinite(exp)) {
    return { valid: false, message: "该 Token 不合法：缺少过期时间" };
  }
  if (exp <= now) {
    return { valid: false, message: "该 Token 已过期" };
  }

  return { valid: true };
}

const verifyPassword = adminAuth.verifyPassword;
const issueAdminToken = adminAuth.issueAdminToken;
const verifyAdminToken = adminAuth.verifyAdminToken;
const ADMIN_SESSION_COOKIE = adminAuth.ADMIN_SESSION_COOKIE;
const requireSecondaryAuth = adminAuth.createRequireSecondaryAuth(
  store,
  ensureStoreReady,
);

async function logAdminSecurityEvent(event, meta = {}) {
  try {
    await ensureStoreReady();
    await store.insertAdminLoginLog({
      event,
      adminEmail: meta.email || "",
      ip: meta.ip || "",
      userAgent: meta.userAgent || "",
      fingerprint: meta.fingerprint || "",
      detail: meta.detail || "",
    });
  } catch (error) {
    console.warn(`[AdminAuth] 登录日志写入失败: ${error.message}`);
  }
}

async function fireAdminSecurityNotification(event, payload = {}) {
  notifyAdminSecurityEvent(store, event, payload).catch((error) => {
    console.warn(`[AdminAuth] Telegram 通知失败: ${error.message}`);
  });
}

function getBearerToken(req) {
  const header = req.headers.authorization || "";
  const [scheme, token] = header.split(" ");
  if (scheme === "Bearer" && token) {
    return token.trim();
  }
  return null;
}

function getCookieValue(req, name) {
  const target = `${String(name || "").trim()}=`;
  for (const part of String(req.headers.cookie || "").split(";")) {
    const value = part.trim();
    if (!value.startsWith(target)) continue;
    try {
      return decodeURIComponent(value.slice(target.length));
    } catch (_) {
      return "";
    }
  }
  return "";
}

async function rejectAdminAuthentication(req, res, message) {
  try {
    const paths = await getCachedAdminPaths();
    res.setHeader("X-Admin-Login-Path", buildAdminLoginUrl(paths));
  } catch (_) {}
  return res.status(401).json({ success: false, message });
}

async function authenticateAdmin(req, res, next) {
  const token = getBearerToken(req) || getCookieValue(req, ADMIN_SESSION_COOKIE);
  const payload = verifyAdminToken(token);
  if (!payload) {
    return rejectAdminAuthentication(req, res, "未授权，请重新登录");
  }

  try {
    await ensureStoreReady();
    const authConfig = await store.getAdminAuthConfig();
    if (Number(payload.pv || 0) !== authConfig.passwordVersion) {
      return rejectAdminAuthentication(req, res, "登录状态已失效，请重新登录");
    }
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }

  req.admin = payload;
  req.adminToken = token;
  return next();
}

function extractScreenshotsFromOutput(output) {
  const paths = new Set();
  const text = String(output || "");
  const patterns = [
    /FAILURE_SCREENSHOT:\s*([^\s\n]+\.png)/g,
    /SUCCESS_SCREENSHOT:\s*([^\s\n]+\.png)/g,
    /LIVE_SCREENSHOT:\s*([^\s\n]+\.png)/g,
    /截图已保存:\s*([^\s\n]+\.png)/g,
  ];
  for (const pattern of patterns) {
    let match = pattern.exec(text);
    while (match) {
      paths.add(match[1]);
      match = pattern.exec(text);
    }
  }
  return normalizeMediaPaths([...paths]);
}

function extractVideosFromOutput(output) {
  const paths = new Set();
  const text = String(output || "");
  const pattern = /VIDEO_FILE:\s*([^\s\n]+\.webm)/g;
  let match = pattern.exec(text);
  while (match) {
    paths.add(match[1]);
    match = pattern.exec(text);
  }
  return normalizeMediaPaths([...paths]);
}

function normalizeMediaPaths(paths) {
  return paths.map((filePath) => {
    const normalized = String(filePath).replace(/\\/g, "/");
    const marker = "debug_screenshots/";
    const idx = normalized.indexOf(marker);
    if (idx >= 0) {
      return normalized.slice(idx + marker.length);
    }
    return path.basename(normalized);
  });
}

function extractTaskMediaFromOutput(output) {
  return {
    screenshots: extractScreenshotsFromOutput(output),
    videos: extractVideosFromOutput(output),
  };
}

function splitTaskMediaPaths(items) {
  const list = Array.isArray(items) ? items : [];
  const screenshots = [];
  const videos = [];
  for (const item of list) {
    const rel = String(item || "").replace(/\\/g, "/");
    if (!rel) continue;
    if (/\.webm$/i.test(rel)) {
      videos.push(rel);
    } else {
      screenshots.push(rel);
    }
  }
  return { screenshots, videos };
}

function extractCheckoutUrlFromOutput(output) {
  const match = String(output || "").match(/CHECKOUT_URL:\s*(https?\S+)/);
  return match ? match[1].trim() : "";
}

function extractGiftRedeemUrlFromOutput(output) {
  const match = String(output || "").match(/GIFT_REDEEM_URL:\s*(https?\S+)/);
  return match ? match[1].trim() : "";
}

function analyzeCheckoutDebugOutput(output, timedOut) {
  const normalized = String(output || "");
  const runtimeError = extractRuntimeErrorMessage(normalized);

  if (normalized.includes("CHECKOUT_DEBUG_SUCCESS")) {
    const checkoutUrl = extractCheckoutUrlFromOutput(normalized);
    return {
      status: "success",
      message: checkoutUrl
        ? `支付链接已生成: ${checkoutUrl}`
        : "支付链接调试成功",
      checkoutUrl,
      reachedPayment: Boolean(checkoutUrl),
      shouldRetry: false,
      deletePhone: false,
      deleteCard: false,
    };
  }

  const base = analyzeProcessOutput(output, timedOut);
  if (base.status === "retry") {
    return {
      ...base,
      status: "failed",
      message: String(
        base.message || runtimeError || "支付链接调试失败",
      ).replace("，准备重试", ""),
    };
  }
  if (base.status === "success") {
    return {
      status: "failed",
      message:
        runtimeError || "调试流程异常结束（未输出 CHECKOUT_DEBUG_SUCCESS）",
      reachedPayment: false,
      shouldRetry: false,
      deletePhone: false,
      deleteCard: false,
    };
  }
  return base;
}

function extractCardLast4FromOutput(output) {
  const text = String(output || "");
  const reserved = text.match(/已预留卡片(?:\s*#\d+)?:\s*\.\.\.(\d{4})/);
  if (reserved) {
    return reserved[1];
  }
  const success = text.match(/支付成功！卡片:\s*\.\.\.(\d{4})/);
  if (success) {
    return success[1];
  }
  const attempt = text.match(/ATTEMPT \d+ \| CARD (\d{4})/);
  if (attempt) {
    return attempt[1];
  }
  return null;
}

function extractBoundCardFromOutput(output) {
  const text = String(output || "");
  const last4 = extractCardLast4FromOutput(text);
  const holder =
    (text.match(/支付成功！卡片:.*?姓名:\s*([^，,\n]+)/) || [])[1] || "";
  const address =
    (text.match(/支付成功！卡片:.*?地址:\s*([^\n]+)/) || [])[1] || "";
  if (!last4 && !holder && !address) return null;
  return {
    last4: last4 || "",
    holder: String(holder).trim(),
    address: String(address)
      .trim()
      .replace(/[，,]\s*$/, ""),
  };
}

function parseManualDebugCard(raw) {
  const parsed = cardValidator.parseCardBundle(raw);
  if (!parsed) {
    throw new Error("手动卡片格式：卡号|月/年|CVC，可再加持卡人姓名");
  }
  const card = {
    card_number: parsed.card_number,
    card_expiry: parsed.card_expiry,
    card_cvc: parsed.card_cvc,
    card_holder: parsed.card_holder || "",
  };
  const numberCheck = cardValidator.validateCardNumber(card.card_number);
  if (!numberCheck.valid) throw new Error(numberCheck.error || "卡号无效");
  const expiryCheck = cardValidator.validateExpiry(card.card_expiry);
  if (!expiryCheck.valid) throw new Error(expiryCheck.error || "有效期无效");
  const cvcCheck = cardValidator.validateCVC(card.card_cvc);
  if (!cvcCheck.valid) throw new Error(cvcCheck.error || "CVC 无效");
  return card;
}

function parseManualBillingAddress(raw) {
  if (!raw || typeof raw !== "object") return null;
  const address = {
    line1: String(raw.line1 || raw.address || "").trim(),
    city: String(raw.city || "").trim(),
    state: String(raw.state || "").trim(),
    postal_code: String(raw.postal_code || raw.postal || raw.zip || "").trim(),
    country:
      String(raw.country || "US")
        .trim()
        .toUpperCase() || "US",
    name: String(raw.name || raw.holder || "").trim(),
  };
  if (
    !address.line1 ||
    !address.city ||
    !address.state ||
    !address.postal_code
  ) {
    throw new Error("请完整填写账单地址：街道、城市、州、邮编");
  }
  if (!/^[A-Z]{2}$/.test(address.country)) {
    throw new Error("账单国家需为 2 位大写字母");
  }
  return address;
}

function resolveAdminCheckoutCdk(cdkCode) {
  return isCustomPayCdk(cdkCode) ? "[custom-pay]" : "[payment-debug]";
}

function resolveCustomCheckoutUrl(raw) {
  const text = String(raw || "").trim();
  if (!text) return "";
  if (/^https:\/\/chatgpt\.com\/checkout\//i.test(text)) return text;
  const parsed = parseCheckoutUrl(text);
  if (parsed.sessionId) {
    const processor = parsed.processorEntity || "openai_llc";
    return (
      parsed.checkoutUrl ||
      `https://chatgpt.com/checkout/${processor}/${parsed.sessionId}`
    );
  }
  return null;
}

async function pickTaskProxy(rawGroupId) {
  const groupId = await store.resolveProxyGroupId(rawGroupId);
  return store.getActiveProxy(groupId);
}

async function startPublicCheckoutPay(body = {}, options = {}) {
  const requireManualPayment = Boolean(options.requireManualPayment);
  const isCustomPay = isCustomPayCdk(body.cdk_code);
  const isAdminDebug = isAdminPaymentCdk(body.cdk_code);
  const rawSession = String(body.session || "").trim();
  if (!rawSession) {
    return {
      status: 400,
      payload: { success: false, error: "请提供 Session JSON" },
    };
  }

  const sessionJson = parseSessionJson(rawSession);
  const token = normalizeSessionToken(rawSession);
  if (!token) {
    return {
      status: 400,
      payload: { success: false, error: "Session 无效，无法提取 accessToken" },
    };
  }
  const tokenCheck = validateAccessToken(token);
  if (!tokenCheck.valid) {
    return {
      status: 400,
      payload: { success: false, error: tokenCheck.message },
    };
  }

  const planType = String(body.plan_type || "plus").trim() || "plus";
  const planNameOverride = body.plan_name ? String(body.plan_name).trim() : "";
  const resolvedPlanName = planNameOverride || store.resolvePlanName(planType);
  const creditQuantity = store.isCreditsPlan(planType)
    ? store.resolveCreditQuantity(
        planType,
        body.credit_quantity || body.credits || 0,
      )
    : 0;
  if (store.isCreditsPlan(planType) && creditQuantity < 250) {
    return {
      status: 400,
      payload: {
        success: false,
        error: "充值点数至少 250，且需为 250 的倍数",
      },
    };
  }
  const regionCode = String(
    body.country || body.region || (await store.getPaymentRegion()),
  ).toUpperCase();
  if (!isSupportedRegion(regionCode)) {
    return {
      status: 400,
      payload: { success: false, error: `不支持的地区: ${regionCode}` },
    };
  }

  if (VERIFY_OPENAI_TOKEN_ON_ACTIVATION) {
    const verification = await querySubscriptionBySession(token, {
      email: extractEmailFromSession(rawSession) || tokenCheck.email || "",
    });
    if (!verification.ok) {
      return {
        status: 400,
        payload: {
          success: false,
          error: "Session 无法通过 OpenAI 服务验证，请确认有效后重试",
        },
      };
    }
  }

  const maintenanceModeState = await store.getMaintenanceModeState();
  if (maintenanceModeState.enabled) {
    return {
      status: 503,
      payload: { success: false, error: "系统维护中，请稍后再试" },
    };
  }
  const maxConcurrentActivations = await store.getMaxConcurrentActivations();
  if (activeForegroundJobs.size >= maxConcurrentActivations) {
    return {
      status: 429,
      payload: { success: false, error: "当前任务过多，请稍后再试" },
    };
  }

  let preferredCardId = requireManualPayment ? 0 : Number(body.card_id || 0);
  let cardGroupId = null;
  let manualCard = null;
  let manualAddress = null;
  try {
    if (String(body.card_manual || "").trim()) {
      manualCard = parseManualDebugCard(body.card_manual);
      preferredCardId = 0;
    } else if (body.card && typeof body.card === "object") {
      manualCard = parseManualDebugCard(
        [
          body.card.number || body.card.card_number,
          body.card.expiry || body.card.card_expiry,
          body.card.cvc || body.card.card_cvc,
          body.card.holder || body.card.card_holder || "",
        ].join("|"),
      );
      preferredCardId = 0;
    } else if (preferredCardId) {
      const selected = await store.getCardById(preferredCardId);
      if (!selected) {
        return {
          status: 400,
          payload: { success: false, error: "指定卡片不存在" },
        };
      }
      if (!Number(selected.is_active) || selected.status !== "正常") {
        return {
          status: 400,
          payload: { success: false, error: "指定卡片当前不可用" },
        };
      }
    } else if (!requireManualPayment) {
      const rawGroup = body.card_group_id ?? body.cardGroupId ?? "";
      if (
        rawGroup !== "" &&
        rawGroup != null &&
        String(rawGroup) !== "all" &&
        String(rawGroup) !== "pool"
      ) {
        const group = await store.getCardGroupById(rawGroup);
        if (!group) {
          return {
            status: 400,
            payload: { success: false, error: "银行卡分组不存在" },
          };
        }
        cardGroupId = Number(group.id);
      }
    }
    if (requireManualPayment || body.address) {
      manualAddress = parseManualBillingAddress(body.address);
    }
  } catch (err) {
    return { status: 400, payload: { success: false, error: err.message } };
  }

  const cancelAutoRenew = parseCheckoutCancelAutoRenew(body.cancel_auto_renew);
  const checkoutUrl = resolveCustomCheckoutUrl(
    body.checkout_url || body.checkoutUrl || "",
  );
  if (checkoutUrl === null) {
    return {
      status: 400,
      payload: {
        success: false,
        error: "请填写有效的 ChatGPT Checkout 链接，例如 https://chatgpt.com/checkout/openai_llc/oaics_...",
      },
    };
  }
  const checkoutModeRaw = String(
    body.checkout_mode || body.checkoutMode || "",
  )
    .trim()
    .toLowerCase();
  const checkoutMode =
    checkoutUrl || isCustomPay || checkoutModeRaw === "ui"
      ? "ui"
      : "api";

  if (requireManualPayment && !manualCard) {
    return {
      status: 400,
      payload: { success: false, error: "请填写银行卡信息" },
    };
  }

  if (!manualCard && !preferredCardId && !(await store.hasAvailableCard(cardGroupId))) {
    return {
      status: 409,
      payload: {
        success: false,
        error: isAdminDebug
          ? cardGroupId
            ? "当前银行卡分组暂无可用卡片"
            : "银行卡池暂无可用卡片，请先在后台「银行卡池」导入银行卡后再试"
          : "请先填写银行卡信息后再试",
      },
    };
  }

  const storedSession = buildStoredSessionPayload(
    rawSession,
    sessionJson,
    token,
  );
  const email = extractEmailFromSession(sessionJson);
  const task = await store.createTaskLog(
    buildCheckoutTaskCreate({
      tokenPreview: extractSessionPreview(storedSession),
      sessionPayload: storedSession,
      cdkCode: body.cdk_code,
      cardLast4: manualCard ? manualCard.card_number : null,
    }),
  );
  const taskLabel = isCustomPay
    ? "自定义付款"
    : isAdminDebug
      ? "付款调试"
      : "自助开通";
  await store.updateTaskLog(
    task.jobKey,
    buildCheckoutTaskUpdate({
      cdkCode: body.cdk_code,
      planType,
      creditQuantity,
      regionCode,
    }),
  );
  logTask(
    task.jobKey,
    `${taskLabel}任务已创建 plan=${planType} plan_name=${resolvedPlanName}${creditQuantity ? ` credits=${creditQuantity}` : ""} region=${regionCode} email=${email || "-"} mode=${checkoutMode}${checkoutUrl ? " checkout_url=yes" : ""} cancel_auto_renew=${cancelAutoRenew ? "yes" : "no"} card_group=${cardGroupId || "all"}`,
  );
  reserveForegroundSlot(task.jobKey);
  spawnCheckoutPaymentWorker({
    task,
    token,
    sessionRaw: storedSession,
    planType,
    region: regionCode,
    planNameOverride: resolvedPlanName,
    creditQuantity,
    email,
    preferredCardId,
    cardGroupId,
    manualCard,
    manualAddress,
    taskLabel,
    checkoutMode,
    checkoutUrl,
    cancelAutoRenew,
    proxyGroupId: body.proxy_group_id ?? body.proxyGroupId ?? "",
  });

  return {
    status: 200,
    payload: {
      success: true,
      jobKey: task.jobKey,
      email: email || null,
      viewerToken: adminAuth.issueTaskViewerToken(task.jobKey).token,
      message: isAdminDebug
        ? "付款调试任务已启动，请查看下方运行日志"
        : "开通任务已启动",
    },
  };
}

function buildRuntimeFailure(message, code, status = "failed", extra = {}) {
  return {
    success: false,
    message,
    code,
    status,
    ...extra,
  };
}

function extractRuntimeErrorMessage(output) {
  const normalized = String(output || "");
  const match = normalized.match(/❌ \[运行时错误\]:\s*(.+)/);
  if (match) {
    return match[1].trim();
  }
  const lines = normalized
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (lines[i].startsWith("Error:")) {
      return lines[i].replace(/^Error:\s*/, "");
    }
  }
  return "";
}

function analyzeProcessOutput(output, timedOut) {
  const normalized = String(output || "");
  const runtimeError = extractRuntimeErrorMessage(normalized);
  const reachedPayment =
    normalized.includes("[Stripe] Step") ||
    normalized.includes("正在使用 Stripe 信用卡") ||
    normalized.includes("正在使用协议优先支付") ||
    normalized.includes("走协议支付") ||
    normalized.includes("Checkout 页面已打开") ||
    normalized.includes("chatgpt.com/checkout") ||
    normalized.includes("配置套餐") ||
    normalized.includes("定价页") ||
    normalized.includes("#pricing");
  const success =
    normalized.includes("PAYMENT_SUCCESS") ||
    normalized.includes("最终校验：支付成功") ||
    normalized.includes("支付成功");

  if (success) {
    const giftRedeemUrl = extractGiftRedeemUrlFromOutput(normalized);
    return {
      status: "success",
      message: giftRedeemUrl
        ? `支付成功，兑换链接: ${giftRedeemUrl}`
        : "激活成功",
      checkoutUrl: giftRedeemUrl || undefined,
      giftRedeemUrl,
      reachedPayment: true,
      shouldRetry: false,
      deletePhone: false,
      deleteCard: false,
    };
  }

  if (normalized.includes("金额校验失败")) {
    return {
      status: "failed",
      message: "支付金额校验失败，请检查账单地区与币种配置",
      reachedPayment: false,
      shouldRetry: false,
      deletePhone: false,
      deleteCard: false,
    };
  }

  if (
    normalized.includes("Session 未生效") ||
    normalized.includes("Google 登录") ||
    normalized.includes("Sign in with Google")
  ) {
    return {
      status: "failed",
      message:
        runtimeError ||
        "Session 未在浏览器中生效，请粘贴完整 Session JSON（从 chatgpt.com/api/auth/session 全选复制）",
      reachedPayment: false,
      shouldRetry: false,
      deletePhone: false,
      deleteCard: false,
    };
  }

  if (
    normalized.includes("Session 无效") ||
    normalized.includes("Session 登录失败") ||
    normalized.includes("Session 响应异常") ||
    normalized.includes("缺少 AccessToken")
  ) {
    return {
      status: "failed",
      message:
        runtimeError ||
        "Session 无效或已过期，请重新获取完整 Session JSON 后重试",
      reachedPayment: false,
      shouldRetry: false,
      deletePhone: false,
      deleteCard: false,
    };
  }

  if (normalized.includes("无法将定价页切换到目标地区")) {
    return {
      status: "failed",
      message:
        runtimeError ||
        "定价页地区切换失败，已尝试 API Checkout；若仍失败请检查后台账单地区",
      reachedPayment: false,
      shouldRetry: false,
      deletePhone: false,
      deleteCard: false,
    };
  }

  if (normalized.includes("未找到") && normalized.includes("升级按钮")) {
    return {
      status: "failed",
      message: runtimeError || "定价页未找到对应套餐升级按钮，请确认账号可升级",
      reachedPayment: false,
      shouldRetry: false,
      deletePhone: false,
      deleteCard: false,
    };
  }

  if (normalized.includes("等待 Checkout 页面超时")) {
    return {
      status: "failed",
      message: runtimeError || "点击升级后未跳转到 Checkout 页面",
      reachedPayment: false,
      shouldRetry: false,
      deletePhone: false,
      deleteCard: false,
    };
  }

  if (
    normalized.includes("无法获取支付链接") ||
    normalized.includes("API 创建 Checkout 失败") ||
    normalized.includes("createCheckoutSession 失败") ||
    normalized.includes("无法打开 Checkout 页面") ||
    normalized.includes("订单创建失败")
  ) {
    return {
      status: "failed",
      message:
        runtimeError ||
        "无法创建官方 Checkout 订单，请检查账号是否已订阅、账单地区与币种是否匹配",
      reachedPayment: false,
      shouldRetry: false,
      deletePhone: false,
      deleteCard: false,
    };
  }

  if (
    normalized.includes("该账号无激活权限") ||
    normalized.includes("not_eligible") ||
    normalized.includes("Offer not found")
  ) {
    return {
      status: "failed",
      message:
        "该账号不符合订阅条件（可能已订阅或地区不支持），请更换账号或调整后台账单地区",
      reachedPayment: false,
      shouldRetry: false,
      deletePhone: false,
      deleteCard: false,
    };
  }

  if (
    normalized.includes(
      "Browser does not support socks5 proxy authentication",
    ) ||
    normalized.includes("socks5 proxy authentication")
  ) {
    return {
      status: "failed",
      message:
        "代理配置错误：Playwright 不支持带账号密码的 SOCKS5，系统已自动中继；若仍失败请检查代理 URL 或改用 HTTP 代理",
      reachedPayment: false,
      shouldRetry: false,
      deletePhone: false,
      deleteCard: false,
    };
  }

  if (
    normalized.includes("代理认证失败") ||
    normalized.includes("代理响应异常") ||
    normalized.includes("账号余额")
  ) {
    return {
      status: "failed",
      message: "系统维护中,请联系管理员修复",
      reachedPayment,
      shouldRetry: false,
      deletePhone: false,
      deleteCard: false,
    };
  }

  if (
    normalized.includes("代理连接失败") ||
    normalized.includes("代理响应异常")
  ) {
    return {
      status: "maintenance",
      message: "系统维护中,请联系管理员修复",
      reachedPayment,
      shouldRetry: false,
      deletePhone: false,
      deleteCard: false,
    };
  }

  if (
    normalized.includes("监测到致命拦截文字") ||
    normalized.includes("监测到致命拦截") ||
    normalized.includes("You have been blocked")
  ) {
    return {
      status: "retry",
      message: "监测到致命拦截文字，准备重试",
      reachedPayment: true,
      shouldRetry: true,
      deletePhone: false,
      deleteCard: false,
    };
  }

  if (normalized.includes("手机号被拒绝或系统拦截")) {
    return {
      status: "retry",
      message: "手机号不可用，准备重试",
      reachedPayment,
      shouldRetry: true,
      deletePhone: true,
      deleteCard: false,
    };
  }

  if (
    normalized.includes("短信验证码超时") ||
    normalized.includes("该手机号无验证码") ||
    normalized.includes("手机号短信验证异常")
  ) {
    return {
      status: "retry",
      message: "短信异常：手机号不可用，已禁用该号，准备重试",
      reachedPayment,
      shouldRetry: true,
      deletePhone: true,
      deleteCard: false,
    };
  }

  if (
    normalized.includes("银行卡被拒绝") ||
    normalized.includes("stripe_card_declined") ||
    normalized.includes("支付失败 (stripe_redirect_failed)") ||
    normalized.includes("支付失败 (stripe_redirect_canceled)") ||
    normalized.includes("支付失败 (stripe_card_declined)")
  ) {
    return {
      status: "manual",
      message: "银行卡被拒绝或 Stripe 驳回，请查看截图后人工处理",
      reachedPayment: true,
      shouldRetry: false,
      deletePhone: false,
      deleteCard: true,
    };
  }

  if (
    normalized.includes("支付结果检测失败") ||
    normalized.includes("支付结果等待超时")
  ) {
    return {
      status: "manual",
      message: "支付结果未确认，请查看截图后人工处理",
      reachedPayment: true,
      shouldRetry: false,
      deletePhone: false,
      deleteCard: false,
    };
  }

  if (
    normalized.includes("需要人工验证：触发 Cloudflare") ||
    normalized.includes("captcha_challenge_required")
  ) {
    return {
      status: "manual",
      message:
        "触发 Cloudflare 人机验证（需勾选验证框），自动化无法可靠通过。请换住宅代理 IP，或 HEADFUL=1 有头模式人工勾选",
      reachedPayment: true,
      shouldRetry: false,
      deletePhone: false,
      deleteCard: false,
    };
  }

  if (
    normalized.includes("支付失败 (manual_intervention)") ||
    normalized.includes("manual_intervention") ||
    normalized.includes("需要人工操作") ||
    normalized.includes("人机验证") ||
    normalized.includes("Cloudflare/人机验证") ||
    normalized.includes("captcha_challenge")
  ) {
    return {
      status: "manual",
      message: runtimeError || "需要人工操作：支付自动化失败，请查看失败截图",
      reachedPayment: true,
      shouldRetry: false,
      deletePhone: false,
      deleteCard: false,
    };
  }

  if (
    normalized.includes("支付失败 (payment_failed)") ||
    normalized.includes("支付失败 (card_pool_exhausted)")
  ) {
    return {
      status: "manual",
      message: runtimeError || "支付失败，请查看运行日志与截图",
      reachedPayment: true,
      shouldRetry: false,
      deletePhone: false,
      deleteCard: false,
    };
  }

  // 已进入 Stripe/Checkout 支付流程后，任何失败都不再整单重试
  if (
    reachedPayment &&
    (normalized.includes("支付失败") ||
      normalized.includes("❌ [支付失败]") ||
      normalized.includes("FAILURE_SCREENSHOT") ||
      normalized.includes("billing_address_not_filled") ||
      normalized.includes("账单地址未完整"))
  ) {
    return {
      status: "manual",
      message: runtimeError || "支付流程失败，请查看失败截图后人工处理",
      reachedPayment: true,
      shouldRetry: false,
      deletePhone: false,
      deleteCard: false,
    };
  }

  if (
    normalized.includes("代理或网络持续超时") ||
    normalized.includes("浏览器连接被代理多次关闭")
  ) {
    return {
      status: "retry",
      message: "当前代理超时严重，已切换代理重试",
      reachedPayment: false,
      shouldRetry: true,
      deletePhone: false,
      deleteCard: false,
    };
  }

  if (
    normalized.includes("OpenAI 鉴权服务异常") ||
    normalized.includes("/auth/error?error=undefined") ||
    normalized.includes("chatgpt.com/auth/error")
  ) {
    return {
      status: "retry",
      message: "OpenAI 鉴权风控 (auth/error)，换代理 IP 重试",
      reachedPayment: false,
      shouldRetry: true,
      deletePhone: false,
      deleteCard: false,
    };
  }

  if (
    normalized.includes("user_already_exists") ||
    normalized.includes("该邮箱已被注册")
  ) {
    return {
      status: "retry",
      message: "邮箱已被注册，自动换下一个邮箱重试",
      reachedPayment: false,
      shouldRetry: true,
      deletePhone: false,
      deleteCard: false,
    };
  }

  if (normalized.includes("该账号无激活权限,请更换账号重试")) {
    return {
      status: "failed",
      message:
        "该账号不符合订阅条件（可能已订阅或地区不支持），请更换账号或调整后台账单地区",
      reachedPayment,
      shouldRetry: false,
      deletePhone: false,
      deleteCard: false,
    };
  }

  if (normalized.includes("❌ [运行时错误]") || runtimeError) {
    return {
      status: "failed",
      message: runtimeError || "自动化执行失败，请查看运行日志",
      reachedPayment,
      shouldRetry: false,
      deletePhone: false,
      deleteCard: false,
    };
  }

  if (!reachedPayment) {
    const deepCheckoutFlow =
      normalized.includes("Stripe") ||
      normalized.includes("pay.openai.com") ||
      normalized.includes("Checkout") ||
      normalized.includes("正在打开 Stripe");
    if (deepCheckoutFlow) {
      return {
        status: "retry",
        message: "已进入支付流程但未完成，准备重试",
        reachedPayment: false,
        shouldRetry: true,
        deletePhone: false,
        deleteCard: false,
      };
    }
    return {
      status: "failed",
      message:
        runtimeError ||
        "开通失败，请查看运行日志排查 Session、账单地区或卡池配置",
      reachedPayment,
      shouldRetry: false,
      deletePhone: false,
      deleteCard: false,
    };
  }

  if (timedOut || normalized.includes("运行时错误")) {
    return {
      status: reachedPayment ? "manual" : "failed",
      message: reachedPayment
        ? "支付流程超时或中断，请查看失败截图后人工处理"
        : "激活失败",
      reachedPayment,
      shouldRetry: false,
      deletePhone: false,
      deleteCard: false,
    };
  }

  return {
    status: reachedPayment ? "manual" : "failed",
    message: reachedPayment
      ? runtimeError || "支付流程未完成，请查看失败截图后人工处理"
      : runtimeError || "开通失败，请查看运行日志",
    reachedPayment,
    shouldRetry: false,
    deletePhone: false,
    deleteCard: false,
  };
}

function getCheckoutProgress(output, status = "running") {
  const text = String(output || "");
  const markers = [
    ["正在检查代理连通性", 2],
    ["代理连接成功! 代理公网 IP", 5],
    ["[1] 准备自助充值", 8],
    ["Session 登录成功", 12],
    ["正在通过 API 创建 Checkout", 20],
    ["Checkout 页面已打开", 35],
    ["CHECKOUT_DEBUG_SUCCESS", 100],
    ["CHECKOUT_URL:", 95],
    ["已打开 ChatGPT 定价页", 15],
    ["[Stripe] Step 1", 45],
    ["[Stripe] Step 6", 60],
    ["[Stripe] Step 9", 80],
    ["[Stripe] Step 10", 90],
    ["正在使用协议优先支付流程", 40],
    ["走协议支付", 50],
    ["正在使用 Stripe 信用卡卡池支付流程", 40],
    ["最终校验：支付成功!", 100],
    ["PAYMENT_SUCCESS", 100],
  ];

  let progress = 0;
  for (const [marker, value] of markers) {
    if (text.includes(marker)) {
      progress = Math.max(progress, value);
    }
  }

  if (status === "success") return 100;
  return Math.min(progress, 99);
}

function normalizeTaskProgress(progress, status = "running", previous = 0) {
  const numericProgress = Number(progress);
  const safeProgress = Number.isFinite(numericProgress)
    ? Math.max(0, Math.round(numericProgress))
    : 0;
  const cappedProgress =
    status === "success"
      ? Math.min(safeProgress, 100)
      : Math.min(safeProgress, 99);
  return Math.max(Math.max(0, Number(previous) || 0), cappedProgress);
}

function timestampTaskOutput(chunk) {
  const stamp = store.formatStoreDateTime(new Date()) || new Date().toISOString();
  return String(chunk)
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => (line ? `[${stamp}] ${line}` : ""))
    .join("\n");
}

function registerJobChild(jobKey, child) {
  const key = String(jobKey || "").trim();
  if (!key || !child) return;
  if (!jobChildren.has(key)) jobChildren.set(key, new Set());
  jobChildren.get(key).add(child);
}

function unregisterJobChild(jobKey, child) {
  const key = String(jobKey || "").trim();
  const set = jobChildren.get(key);
  if (!set) return;
  set.delete(child);
  if (!set.size) jobChildren.delete(key);
}

function isJobAborted(jobKey) {
  return abortedJobs.has(String(jobKey || "").trim());
}

function safeTouchJob(jobKey) {
  if (typeof browserPool.touchJob === "function") {
    try {
      browserPool.touchJob(jobKey);
    } catch (_) {}
  }
}

function safeReleaseSlotByJobKey(jobKey) {
  if (typeof browserPool.releaseSlotByJobKey === "function") {
    try {
      browserPool.releaseSlotByJobKey(jobKey);
    } catch (_) {}
  }
}

function killJobChildren(jobKey) {
  const key = String(jobKey || "").trim();
  const children = jobChildren.get(key);
  if (!children || !children.size) return 0;
  let count = 0;
  for (const child of children) {
    count += 1;
    try {
      child.kill("SIGTERM");
    } catch (_) {}
    setTimeout(() => {
      if (child.exitCode != null || child.signalCode != null) return;
      try {
        child.kill("SIGKILL");
      } catch (_) {}
    }, 3000).unref();
  }
  return count;
}

async function stopCheckoutJob(jobKey, reason = "任务已停止") {
  const key = String(jobKey || "").trim();
  if (!key || !/^[A-Za-z0-9._-]{1,80}$/.test(key)) {
    return { ok: false, status: 400, error: "缺少任务标识" };
  }
  const task = await store.getTaskStatus(key);
  if (!task) {
    return { ok: false, status: 404, error: "任务不存在" };
  }
  if (TERMINAL_TASK_STATUSES.has(String(task.status || "").toLowerCase())) {
    return { ok: false, status: 409, error: "任务已结束" };
  }
  abortedJobs.add(key);
  const killed = killJobChildren(key);
  const message = String(reason || "任务已停止");
  const progress = Number(task.progress || 0);
  await store.updateTaskLog(key, {
    status: "failed",
    message,
    progress: Number.isFinite(progress) && progress > 0 ? progress : 0,
  });
  broadcastToTask(key, {
    type: "status",
    jobKey: key,
    status: "failed",
    message,
    progress: Number.isFinite(progress) && progress > 0 ? progress : 0,
  });
  logTask(key, `任务已停止 killed=${killed}`, "warn");
  return { ok: true, status: 200, killed, jobKey: key, message };
}

function runCheckoutScript(
  jobKey,
  scriptPath,
  env,
  attempt = 1,
  onProgress = null,
) {
  if (isJobAborted(jobKey)) {
    return Promise.resolve({
      attempt,
      code: null,
      signal: "SIGTERM",
      timedOut: false,
      output: "",
      analysis: { status: "failed", message: "任务已停止" },
    });
  }
  return new Promise((resolve) => {
    logTask(jobKey, `启动子进程 attempt=${attempt} script=${scriptPath}`);
    const child = spawn("node", [scriptPath], {
      env: {
        ...env,
        JOB_KEY: String(env?.JOB_KEY || jobKey || "").trim(),
      },
      windowsHide: true,
    });

    let output = "";
    let idleTimer = null;
    let finished = false;
    let timedOut = false;

    activeProcesses.add(child);
    registerJobChild(jobKey, child);
    if (isJobAborted(jobKey)) {
      try {
        child.kill("SIGTERM");
      } catch (_) {}
      setTimeout(() => {
        if (child.exitCode != null || child.signalCode != null) return;
        try {
          child.kill("SIGKILL");
        } catch (_) {}
      }, 3000).unref();
    }
    const cleanup = () => {
      activeProcesses.delete(child);
      unregisterJobChild(jobKey, child);
      if (idleTimer) clearTimeout(idleTimer);
      safeReleaseSlotByJobKey(jobKey);
    };

    const finish = (result) => {
      if (finished) {
        return;
      }
      finished = true;
      cleanup();
      resolve({ attempt, ...result });
    };

    const resetIdleTimer = () => {
      safeTouchJob(jobKey);
      if (idleTimer) {
        clearTimeout(idleTimer);
      }
      idleTimer = setTimeout(() => {
        timedOut = true;
        output += `\n${timestampTaskOutput("[TIMEOUT] 超过 3 分钟没有打印，任务终止。\n")}`;
        logTask(
          jobKey,
          `attempt=${attempt} 超过 ${PROCESS_IDLE_TIMEOUT_MS / 1000} 秒无输出，终止子进程`,
          "warn",
        );
        child.kill("SIGTERM");
        setTimeout(() => {
          if (finished) return;
          child.kill("SIGKILL");
          completeChild(null, "SIGKILL");
        }, 8000).unref();
      }, PROCESS_IDLE_TIMEOUT_MS);
    };

    const appendChunk = (source, chunk) => {
      const text = chunk.toString();
      const timestamped = timestampTaskOutput(text);
      if (output && !output.endsWith("\n") && timestamped) {
        output += "\n";
      }
      output += timestamped;
      logTaskChunk(jobKey, attempt, source, text);
      if (onProgress) {
        onProgress(getCheckoutProgress(output), output).catch((error) =>
          console.error("[Progress Update Error]", error),
        );
      }
      resetIdleTimer();
    };

    resetIdleTimer();
    child.stdout.on("data", (chunk) => appendChunk("stdout", chunk));
    child.stderr.on("data", (chunk) => appendChunk("stderr", chunk));
    child.on("error", (error) => {
      output += `\n${timestampTaskOutput(`[SPAWN_ERROR] ${error.message}\n`)}`;
      logTask(
        jobKey,
        `attempt=${attempt} 子进程启动失败: ${error.message}`,
        "error",
      );
    });
    const completeChild = (code, signal) => {
      if (finished) return;
      logTask(
        jobKey,
        `attempt=${attempt} 子进程退出 code=${code} signal=${signal || "none"} timedOut=${timedOut}`,
      );
      finish({
        code,
        signal,
        timedOut,
        output,
        analysis: analyzeProcessOutput(output, timedOut),
      });
    };
    child.on("exit", (code, signal) => completeChild(code, signal));
    child.on("close", (code, signal) => completeChild(code, signal));
  });
}

registerAdminLoginRoutes(app, {
  adminAuth,
  store,
  ensureStoreReady,
  verifyPassword,
  issueAdminToken,
  logAdminSecurityEvent,
  fireAdminSecurityNotification,
  sendTelegramLoginCode,
  attachAdminPaths,
  adminSessionCookieName: ADMIN_SESSION_COOKIE,
});

/** 运行日志：必须挂在 app.use('/api/admin', authenticateAdmin) 之前，并为每条路由单独鉴权，否则部分环境下会 404 */
app.get("/api/admin/runtime-logs", authenticateAdmin, (req, res) => {
  try {
    const wantTail =
      String(req.query.tail || "") === "1" ||
      String(req.query.tail || "") === "true";
    const after = Math.max(
      0,
      parseInt(String(req.query.after || "0"), 10) || 0,
    );
    let limit = parseInt(String(req.query.limit || "500"), 10) || 500;
    limit = Math.min(2000, Math.max(1, limit));

    const entries = wantTail
      ? runtimeLog.tail(limit)
      : runtimeLog.after(after, limit);
    const nextAfter = entries.length ? entries[entries.length - 1].id : after;
    res.json({ success: true, entries, nextAfter });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.get("/api/admin/runtime-logs/export", authenticateAdmin, (req, res) => {
  try {
    const errorsOnly = String(req.query.scope || "") === "errors";
    const entries = runtimeLog.tail(15000).filter((entry) => {
      if (!errorsOnly) {
        return true;
      }
      return (
        /^(error|warn)$/i.test(String(entry.level || "")) ||
        /错误|失败|异常|❌|\[ERROR\]/i.test(String(entry.text || ""))
      );
    });
    const content = entries
      .map((entry) => {
        const timestamp =
          store.formatStoreDateTime(entry.ts) ||
          new Date(entry.ts).toISOString();
        return `[${timestamp}] [${entry.level || "log"}] [${entry.source || "server"}]${entry.jobKey ? ` [${entry.jobKey}]` : ""} ${entry.text}`;
      })
      .join("\n");
    const filename = errorsOnly ? "runtime-errors.log" : "runtime-logs.log";
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(`\uFEFF${content}${content ? "\n" : ""}`);
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.post("/api/admin/runtime-logs/clear", authenticateAdmin, (req, res) => {
  try {
    runtimeLog.clear();
    runtimeLog.push({
      jobKey: "",
      level: "system",
      source: "server",
      text: "🧹 运行日志已手动清空",
  stopCheckoutJob,
    });
    res.json({ success: true, message: "运行日志已清空" });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

/** 代理批量测试：支持临时 URL 或已保存代理 ID；检测后可选写回 proxy_assets。 */
app.post("/api/admin/proxy/test", authenticateAdmin, async (req, res) => {
  try {
    await ensureStoreReady();
    const ids = Array.isArray(req.body?.ids)
      ? req.body.ids.map((id) => Number(id)).filter((id) => id > 0)
      : [];
    const rawProxies = normalizeProxyLines(req.body?.proxies || []);
    const persist = req.body?.persist !== false;

    let targets = [];
    if (ids.length) {
      const saved = await store.listProxyAssets();
      const map = new Map(saved.map((item) => [item.id, item]));
      targets = ids
        .map((id) => {
          const row = map.get(id);
          return row ? { id, proxy_url: row.proxy_url } : null;
        })
        .filter(Boolean);
    } else {
      targets = rawProxies.map((proxy_url) => ({ id: null, proxy_url }));
    }

    if (!targets.length) {
      return res
        .status(400)
        .json({ success: false, message: "未提供代理 URL 或 ID" });
    }
    if (targets.length > 50) {
      return res
        .status(400)
        .json({ success: false, message: "一次最多测试 50 条代理" });
    }

    const results = await mapWithConcurrency(targets, 8, async (target) => {
      const result = await testProxyUrl(target.proxy_url);
      if (persist && target.id) {
        await store.updateProxyAssetCheck(target.id, result);
      }
      return {
        id: target.id,
        proxy_url: target.proxy_url,
        ...result,
      };
    });

    return res.json({ success: true, results });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

registerPublicRoutes(app, {
  store,
  ensureStoreReady,
  limitPublicRequests,
  safeEqualString,
  buildAdminLoginUrl,
  buildAdminPanelUrl,
  buildCheckoutUrl,
  normalizeSessionToken,
  validateSessionTokenForQuery,
  querySubscriptionBySession,
  extractEmailFromSession,
  cancelAutoRenew,
  REGION_CONFIG,
  startPublicCheckoutPay,
  resolvePublicCheckoutCdk,
  runtimeLog,
  adminAuth,
  TERMINAL_TASK_STATUSES,
  getActiveForegroundJobCount: () => activeForegroundJobs.size,
  publicDir: path.join(__dirname, "public"),
  getPlanTypeLabel,
  getClientIp,
  getRemainingCooldownMinutes,
  createCdks,
  get handleActivationRequest() {
    return handleActivationRequest;
  },
});

app.use("/api/admin", authenticateAdmin);

registerAdminSecurityRoutes(app, {
  adminAuth,
  store,
  ensureStoreReady,
  verifyPassword,
  issueAdminToken,
  logAdminSecurityEvent,
  fireAdminSecurityNotification,
  attachAdminPaths,
  invalidateAdminPathsCache,
  setCachedAdminPaths,
  buildAdminLoginUrl,
  buildAdminPanelUrl,
  buildCheckoutUrl,
  ADMIN_REFRESH_AFTER_MS,
  authenticateAdmin,
  adminSessionCookieName: ADMIN_SESSION_COOKIE,
});

app.get("/api/admin/task-logs", requireSecondaryAuth, async (req, res) => {
  try {
    await ensureStoreReady();
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 200));
    const sinceMs = Math.max(
      0,
      Number(req.query.since || req.query.sinceMs || 0),
    );
    const sinceId = Math.max(
      0,
      Number(req.query.since_id || req.query.sinceId || 0),
    );
    const tasks = await store.listAdminTaskLogs({ limit, sinceMs, sinceId });
    res.json({
      success: true,
      tasks,
      incremental: sinceMs > 0,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.get("/api/admin/task-logs/:jobKey", requireSecondaryAuth, async (req, res) => {
  try {
    await ensureStoreReady();
    const jobKey = decodeURIComponent(String(req.params.jobKey || "").trim());
    if (!jobKey) {
      return res.status(400).json({ success: false, message: "缺少任务标识" });
    }
    const task = await store.getTaskStatus(jobKey);
    if (!task) {
      return res
        .status(404)
        .json({ success: false, message: "未找到任务记录" });
    }
    const boundFromLog = extractBoundCardFromOutput(task.raw_output);
    const last4 = String(task.card_last4 || boundFromLog?.last4 || "").trim();
    let boundCard = boundFromLog;
    if (last4) {
      const stored = await store.getCardByLast4(last4).catch(() => null);
      if (stored) {
        boundCard = {
          last4,
          holder:
            stored.payment_holder_name ||
            boundFromLog?.holder ||
            stored.card_holder ||
            "",
          address:
            [
              stored.payment_address_line1,
              stored.payment_address_city,
              stored.payment_address_state,
              stored.payment_address_postal,
            ]
              .filter(Boolean)
              .join(", ") ||
            boundFromLog?.address ||
            "",
          expiry: stored.card_expiry || "",
        };
      } else if (!boundCard) {
        boundCard = { last4, holder: "", address: "" };
      }
    }
    return res.json({
      success: true,
      task: {
        status: task.status,
        message: task.message,
        progress: Number(task.progress || 0),
        durationSeconds: Math.max(0, Number(task.duration_seconds || 0)),
        cdk: task.cdk_code || "",
        phone: task.phone || "",
        cardLast4: last4,
        boundCard,
        output: redactTaskDetailOutput(task.raw_output),
      },
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

app.get("/api/admin/data", async (req, res) => {
  try {
    await ensureStoreReady();
    const data = await store.getAdminData({
      light: String(req.query.light || "") === "1",
    });
    const system = await getSystemMetrics();
    data.runtime = {
      active_activation_jobs: getTotalActiveJobs(),
      active_foreground_jobs: activeForegroundJobs.size,
      system,
      browser_pool: browserPool.getStats(),
    };
    res.json(data);
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.get("/api/admin/browser-pool", async (req, res) => {
  try {
    await ensureStoreReady();
    const modeEnabled = await store.getBrowserPoolEnabled();
    const system = await getSystemMetrics();
    const memText = String(system?.memory?.text || "");
    const memMatch = memText.match(/([\d.]+)G\/([\d.]+)G/);
    const hostMemory = memMatch
      ? { usedGb: Number(memMatch[1]), totalGb: Number(memMatch[2]) }
      : null;
    const pool = await browserPool.getDetailedStats(hostMemory);
    res.json({
      success: true,
      pool,
      mode: {
        enabled: modeEnabled,
        runtime: browserPool.getRuntimeEnabled(),
        workerMode: modeEnabled ? "pool" : "standalone",
      },
      system,
      foreground: {
        activeJobs: getTotalActiveJobs(),
        activeForegroundJobs: activeForegroundJobs.size,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.post("/api/admin/browser-pool/mode", async (req, res) => {
  try {
    await ensureStoreReady();
    const enabled =
      req.body?.enabled === true ||
      req.body?.enabled === 1 ||
      String(req.body?.enabled || "").trim() === "1";
    await store.setBrowserPoolEnabled(enabled);
    const info = await syncBrowserPoolModeFromStore();
    res.json({
      success: true,
      message: enabled
        ? `已切换为浏览器池模式（${info.size || 0} 个槽位）`
        : "已切换为独立浏览器模式（每任务冷启动 Chromium）",
      mode: {
        enabled,
        runtime: browserPool.getRuntimeEnabled(),
        workerMode: enabled ? "pool" : "standalone",
      },
      pool: browserPool.getStats(),
    });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});

app.post("/api/admin/browser-pool/reload", async (req, res) => {
  try {
    await ensureStoreReady();
    const requestedSize = req.body?.size;
    if (requestedSize != null) {
      const size = Number(requestedSize);
      const maxSize = browserPool.getStats().maxPoolSize;
      if (!Number.isInteger(size) || size < 1 || size > maxSize) {
        throw new Error(`浏览器池槽位数量必须为 1–${maxSize} 的整数`);
      }
      const normalizedSize = browserPool.setRuntimePoolSize(size);
      await store.setBrowserPoolSize(normalizedSize);
    }
    const result = await browserPool.reloadBrowserPool(requestedSize);
    res.json({
      success: true,
      message: `浏览器池已重载，当前 ${result.size} 个槽位`,
      pool: browserPool.getStats(),
    });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});

app.get("/api/admin/sessions", requireSecondaryAuth, async (req, res) => {
  try {
    await ensureStoreReady();
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 200));
    res.json(await store.listSessions({ limit }));
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.get(
  "/api/admin/sessions/:jobKey",
  requireSecondaryAuth,
  async (req, res) => {
    try {
      await ensureStoreReady();
      const session = await store.getSessionByJobKey(req.params.jobKey);
      if (!session) {
        return res
          .status(404)
          .json({ success: false, message: "Session 记录不存在" });
      }
      const clientMeta = adminAuth.getClientMeta(req);
      await logAdminSecurityEvent("session_exported", {
        ...clientMeta,
        email: req.admin?.email || "",
        detail: `导出 Session ${req.params.jobKey}`,
      });
      res.json({ success: true, session });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  },
);

function adminSubscriptionActionErrorStatus(statusCode) {
  return Number(statusCode) === 401 ? 422 : Number(statusCode) || 502;
}

function hasAdminSessionCookies(rawSession) {
  return /__Secure-next-auth\.session-token/i.test(
    String(buildSessionCookieHeader(rawSession) || ""),
  );
}

async function refreshAdminSessionWithBrowser(rawSession, preferredProxy) {
  const proxyCandidates = String(preferredProxy || "").trim()
    ? [String(preferredProxy).trim(), ""]
    : [""];
  let lastError = "浏览器 Session 刷新失败";

  for (const proxy of proxyCandidates) {
    const prepared = await preparePlaywrightProxy(proxy);
    try {
      const installed = await browserPool.withBrowserContext(
        `admin-session-${crypto.randomUUID()}`,
        {
          proxy: prepared.proxyConfig || undefined,
          locale: "en-US",
          timezoneId: "America/Chicago",
        },
        async (context) => {
          if (!context) {
            throw new Error("浏览器池当前不可用");
          }
          const installed = await installChatGptSession(context, rawSession, {
            proxy,
          });
          const cookies = await context.cookies("https://chatgpt.com");
          return {
            ...installed,
            cookieHeader: formatCookieHeader(cookies),
          };
        },
      );
      const accessToken = String(installed?.accessToken || "").trim();
      if (accessToken) {
        return {
          ok: true,
          statusCode: 200,
          accessToken,
          refreshed:
            accessToken !== String(normalizeSessionToken(rawSession) || "").trim(),
          usedProxy: Boolean(proxy),
          sessionData: installed.sessionData,
          cookieHeader: installed.cookieHeader,
        };
      }
      lastError = "浏览器 Session 未返回 AccessToken";
    } catch (error) {
      lastError = error.message || lastError;
    } finally {
      await prepared.cleanup().catch(() => {});
    }
  }

  return { ok: false, statusCode: 502, error: lastError };
}

async function runAdminBrowserSessionAction(
  rawSession,
  preferredProxy,
  action,
  options = {},
) {
  const preferred = String(preferredProxy || "").trim();
  const extraProxy =
    options.retryWithNewProxy === false
      ? ""
      : await pickTaskProxy(options.proxyGroupId).catch(() => "");
  const proxyCandidates = [];
  const pushProxy = (value) => {
    const next = String(value || "").trim();
    if (next && !proxyCandidates.includes(next)) {
      proxyCandidates.push(next);
    }
  };
  if (options.preferDirect === true) {
    proxyCandidates.push("");
    pushProxy(preferred);
  } else {
    pushProxy(preferred);
    pushProxy(extraProxy);
    if (options.allowDirectFallback === true) {
      proxyCandidates.push("");
    }
  }
  if (!proxyCandidates.length) {
    proxyCandidates.push("");
  }
  let lastResult = null;
  const regionCode = await store.getPaymentRegion().catch(() => "PH");
  const browserProfile = getRegionBrowserProfile(regionCode);

  for (const proxy of proxyCandidates) {
    const prepared = await preparePlaywrightProxy(proxy);
    try {
      console.log(
        `[Account] 使用${proxy ? "代理池" : "直连"}浏览器查询 ChatGPT...`,
      );
      const result = await browserPool.withBrowserContext(
        `admin-action-${crypto.randomUUID()}`,
        {
          proxy: prepared.proxyConfig || undefined,
          locale: browserProfile.locale,
          timezoneId: browserProfile.timezoneId,
        },
        async (context) => {
          if (!context) {
            return { ok: false, statusCode: 503, error: "浏览器池当前不可用" };
          }
          const installed = await installChatGptSession(context, rawSession, {
            skipCookieVerify: options.skipCookieVerify === true,
            proxy,
          });
          const page = await context.newPage();
          if (options.skipNavigate === true) {
            await page
              .goto(`${CHATGPT_ORIGIN}/`, {
                waitUntil: "commit",
                timeout: 20000,
              })
              .catch(() => {});
          }
          return action({
            page,
            accessToken: installed.accessToken,
            sessionData: installed.sessionData,
            proxy,
            cookieVerified: installed.cookieVerified,
            refreshAccessToken: () => refreshLiveChatGptAccessToken(page),
          });
        },
      );
      if (result?.ok) {
        return result;
      }
      lastResult = result;
      const statusCode = Number(result?.statusCode || 0);
      const shouldRetryNetwork =
        [401, 403, 502].includes(statusCode) ||
        /cloudflare|风控拦截/i.test(String(result?.error || ""));
      if (!shouldRetryNetwork) {
        return result;
      }
    } catch (error) {
      lastResult = {
        ok: false,
        statusCode: 502,
        error: `浏览器 Session 操作失败：${error.message}`,
      };
    } finally {
      await prepared.cleanup().catch(() => {});
    }
  }

  return lastResult || {
    ok: false,
    statusCode: 502,
    error: "浏览器 Session 操作失败",
  };
}

async function resolveAdminSessionToken(rawSession, proxyOverride = null, options = {}) {
  const proxy =
    proxyOverride == null
      ? await pickTaskProxy(options.proxyGroupId).catch(() => "")
      : String(proxyOverride || "").trim();
  const token = normalizeSessionToken(rawSession);
  const tokenCheck = validateSessionTokenForQuery(token);
  const skipRefresh =
    options.skipRefresh === true ||
    (options.skipRefresh !== false &&
      tokenCheck.valid &&
      hasAdminSessionCookies(rawSession));
  if (skipRefresh) {
    return {
      token,
      tokenCheck,
      proxy,
      cookieHeader: buildSessionCookieHeader(rawSession),
      tokenRefreshed: false,
      refreshError: "",
    };
  }
  let refreshed = await refreshSessionAccessToken(rawSession, {
    proxy,
    timeoutMs: 12000,
  }).catch((error) => ({ ok: false, error: error.message }));
  if (!refreshed.ok) {
    refreshed = await refreshAdminSessionWithBrowser(rawSession, proxy);
  }
  const effectiveProxy = refreshed.ok && refreshed.usedProxy === false ? "" : proxy;
  if (refreshed.ok) {
    console.log(
      `[Session/Admin] session-token 校验通过，AccessToken ${refreshed.refreshed ? "已刷新" : "未变化"} proxy=${effectiveProxy ? "yes" : "no"}`,
    );
  } else {
    console.warn(
      `[Session/Admin] session-token 刷新失败 status=${refreshed.statusCode || 0} proxy=${proxy ? "yes" : "no"}: ${refreshed.error || "unknown"}`,
    );
  }
  const nextToken = refreshed.ok && refreshed.accessToken ? refreshed.accessToken : token;
  return {
    token: nextToken,
    tokenCheck: validateSessionTokenForQuery(nextToken),
    proxy: effectiveProxy,
    cookieHeader:
      String(refreshed.cookieHeader || "").trim() ||
      buildSessionCookieHeader(rawSession),
    tokenRefreshed: Boolean(refreshed.ok && refreshed.refreshed),
    refreshError: refreshed.ok ? "" : refreshed.error || "",
  };
}

function respondAdminAccountAction(res, result, fallbackMessage) {
  const session = String(result?.data?.session || "").trim();
  if (!result?.ok) {
    return res
      .status(adminSubscriptionActionErrorStatus(result?.statusCode))
      .json({
        success: false,
        message: result?.error || fallbackMessage,
        ...(session ? { session } : {}),
      });
  }
  return res.json({ success: true, data: result.data });
}

function isAdminAccountProxyFallbackError(result) {
  if (!result || result.ok) return false;
  const status = Number(result.statusCode || 0);
  const error = String(result.error || "");
  return (
    [403, 502, 503].includes(status) ||
    /cloudflare|风控拦截|浏览器池当前不可用|浏览器 Session 操作失败|无法连接 OpenAI/i.test(
      error,
    )
  );
}

async function withAdminAccountHttpFallback({
  rawSession,
  browserResult,
  httpFn,
}) {
  if (browserResult?.ok) return browserResult;
  if (
    !browserResult ||
    !hasAdminSessionCookies(rawSession) ||
    isAdminAccountProxyFallbackError(browserResult)
  ) {
    const httpResult = await httpFn();
    if (httpResult?.ok || !browserResult) {
      if (httpResult?.ok && isAdminAccountProxyFallbackError(browserResult)) {
        console.log(
          `[Account] 浏览器查询被拦截，已改走代理 HTTP 接口 status=${httpResult.statusCode || 200}`,
        );
      }
      return httpResult;
    }
  }
  return browserResult;
}

function attachExportedSession(result, exported, previousToken = "") {
  const text = String(exported?.ok ? exported.text : "").trim();
  if (!text) {
    return result;
  }
  const next = result && typeof result === "object" ? result : { ok: false };
  next.data = {
    ...(next.data || {}),
    session: text,
    sessionRefreshed:
      Boolean(exported.accessToken) &&
      exported.accessToken !== String(previousToken || "").trim(),
  };
  return next;
}

async function persistExportedAdminSession(jobKey, result) {
  const key = String(jobKey || "").trim();
  const text = String(result?.data?.session || "").trim();
  if (!key || !text) {
    return;
  }
  try {
    await store.updateTaskSessionPayload(
      key,
      text,
      extractSessionPreview(text),
    );
  } catch (error) {
    console.warn(`[Account] 写回 Session 存档失败: ${error.message}`);
  }
}

async function runAdminCookiePageAction(rawSession, proxy, action, options = {}) {
  if (!hasAdminSessionCookies(rawSession)) {
    return null;
  }
  return runAdminBrowserSessionAction(rawSession, proxy, action, {
    preferDirect: false,
    allowDirectFallback: false,
    skipCookieVerify: true,
    skipNavigate: true,
    ...options,
  });
}

async function runAdminFreshSessionAction(rawSession, proxy, previousToken, action, options = {}) {
  return runAdminCookiePageAction(
    rawSession,
    proxy,
    async ({ page, accessToken, proxy: browserProxy }) => {
      const tracker = createChatGptLiveStateTracker(page, {
        previousToken: previousToken || accessToken,
      });
      try {
        let liveToken = String(accessToken || previousToken || "").trim();
        if (options.rotateSession === true) {
          const fresh = await acquireFreshChatGptAccessToken(page, {
            previousToken: previousToken || accessToken,
            tracker,
            maxAttempts: 2,
            requireRotated: false,
            allowNavigate: false,
            onStatus: (message) => console.log(`[Account] ${message}`),
          });
          liveToken = String(fresh.accessToken || liveToken).trim();
        }
        if (!liveToken) {
          return {
            ok: false,
            statusCode: 401,
            error: "未拿到主界面 Session，已跳过用旧 Token 操作",
          };
        }
        const result = await action({
          page,
          accessToken: liveToken,
          proxy: browserProxy,
          tracker,
          refreshAccessToken: async () => {
            const failedToken = String(liveToken || "").trim();
            const rotated = String(tracker.getRotatedToken?.() || "").trim();
            if (rotated && rotated !== failedToken) {
              return rotated;
            }
            const captured = String(tracker.getToken?.() || "").trim();
            if (captured && captured !== failedToken) {
              return captured;
            }
            const live = await fetchLiveChatGptSession(page, {
              forceRefresh: true,
            });
            return String(live.ok ? live.accessToken : "").trim();
          },
        });
        if (options.captureSession === false) {
          return result;
        }
        const exported = await captureLiveChatGptSessionExport(page, {
          accessToken: liveToken,
        }).catch(() => null);
        return attachExportedSession(
          result,
          exported,
          previousToken || accessToken,
        );
      } finally {
        tracker.dispose();
      }
    },
    options,
  );
}

app.post("/api/admin/subscription/cancel-auto-renew", async (req, res) => {
  try {
    const rawSession = String(req.body?.session || req.body?.token || "")
      .trim()
      .replace(/^\uFEFF/, "");
    if (!rawSession) {
      return res.status(400).json({
        success: false,
        message: "请粘贴 Session JSON 或 AccessToken",
      });
    }

    const proxyGroupId =
      req.body?.proxy_group_id ?? req.body?.proxyGroupId ?? "";
    const resolved = await resolveAdminSessionToken(rawSession, null, {
      proxyGroupId,
    });
    const { token, tokenCheck, proxy, cookieHeader } = resolved;
    if (!tokenCheck.valid) {
      return res
        .status(400)
        .json({ success: false, message: tokenCheck.message });
    }

    const timezoneOffsetMin = Number.isFinite(Number(req.body?.timezone_offset_min))
      ? Number(req.body.timezone_offset_min)
      : new Date().getTimezoneOffset();
    const email = extractEmailFromSession(rawSession) || tokenCheck.email || "";
    let result = await runAdminFreshSessionAction(
      rawSession,
      proxy,
      token,
      async ({ page, accessToken, refreshAccessToken, proxy: browserProxy }) => {
        const browserTokenCheck = validateSessionTokenForQuery(accessToken);
        return cancelAutoRenewWithBrowserPage(page, {
          accountId: browserTokenCheck.accountId || tokenCheck.accountId,
          accessToken,
          email,
          timezoneOffsetMin,
          proxy: browserProxy,
          cookieHeader,
          refreshAccessToken,
          maxAttempts: 6,
          delayMs: 200,
          verifyAttempts: 2,
          verifyDelayMs: 300,
          onStatus: (message) => console.log(`[Account] ${message}`),
        });
      },
      { proxyGroupId },
    );
    result = await withAdminAccountHttpFallback({
      rawSession,
      browserResult: result,
      httpFn: () =>
        cancelAutoRenew(token, {
          timezoneOffsetMin,
          email,
          proxy,
          cookieHeader,
        }),
    });

    await persistExportedAdminSession(req.body?.job_key, result);
    return respondAdminAccountAction(res, result, "取消自动续费失败");
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

app.post("/api/admin/subscription/enable-auto-renew", async (req, res) => {
  try {
    const rawSession = String(req.body?.session || req.body?.token || "")
      .trim()
      .replace(/^\uFEFF/, "");
    if (!rawSession) {
      return res.status(400).json({
        success: false,
        message: "请粘贴 Session JSON 或 AccessToken",
      });
    }

    const proxyGroupId =
      req.body?.proxy_group_id ?? req.body?.proxyGroupId ?? "";
    const resolved = await resolveAdminSessionToken(rawSession, null, {
      proxyGroupId,
    });
    const { token, tokenCheck, proxy, cookieHeader } = resolved;
    if (!tokenCheck.valid) {
      return res
        .status(400)
        .json({ success: false, message: tokenCheck.message });
    }

    const timezoneOffsetMin = Number.isFinite(Number(req.body?.timezone_offset_min))
      ? Number(req.body.timezone_offset_min)
      : new Date().getTimezoneOffset();
    const email = extractEmailFromSession(rawSession) || tokenCheck.email || "";
    let result = await runAdminFreshSessionAction(
      rawSession,
      proxy,
      token,
      async ({ page, accessToken, refreshAccessToken, proxy: browserProxy }) => {
        const browserTokenCheck = validateSessionTokenForQuery(accessToken);
        return resumeAutoRenewWithBrowserPage(page, {
          accountId: browserTokenCheck.accountId || tokenCheck.accountId,
          accessToken,
          email,
          timezoneOffsetMin,
          proxy: browserProxy,
          cookieHeader,
          refreshAccessToken,
        });
      },
      { proxyGroupId },
    );
    result = await withAdminAccountHttpFallback({
      rawSession,
      browserResult: result,
      httpFn: () =>
        resumeAutoRenew(token, {
          timezoneOffsetMin,
          email,
          proxy,
          cookieHeader,
        }),
    });

    await persistExportedAdminSession(req.body?.job_key, result);
    return respondAdminAccountAction(res, result, "开启自动续费失败");
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

async function parseAdminSessionPayload(req) {
  const rawSession = String(req.body?.session || req.body?.token || "")
    .trim()
    .replace(/^\uFEFF/, "");
  if (!rawSession) {
    return {
      error: {
        status: 400,
        message: "请粘贴 Session JSON 或 AccessToken",
      },
    };
  }
  const proxyGroupId = req.body?.proxy_group_id ?? req.body?.proxyGroupId ?? "";
  const resolved = await resolveAdminSessionToken(rawSession, null, {
    proxyGroupId,
  });
  const { token, tokenCheck, proxy, cookieHeader } = resolved;
  if (!tokenCheck.valid) {
    return { error: { status: 400, message: tokenCheck.message } };
  }
  const timezoneOffsetMin = Number(req.body?.timezone_offset_min);
  return {
    rawSession,
    token,
    tokenCheck,
    proxy,
    cookieHeader,
    tokenRefreshed: resolved.tokenRefreshed,
    jobKey: String(req.body?.job_key || "").trim(),
    proxyGroupId,
    timezoneOffsetMin: Number.isFinite(timezoneOffsetMin)
      ? timezoneOffsetMin
      : new Date().getTimezoneOffset(),
  };
}

app.post("/api/admin/account/status", async (req, res) => {
  try {
    const parsed = await parseAdminSessionPayload(req);
    if (parsed.error) {
      return res.status(parsed.error.status).json({
        success: false,
        message: parsed.error.message,
      });
    }
    const email =
      extractEmailFromSession(parsed.rawSession) ||
      parsed.tokenCheck.email ||
      "";
    let result = await runAdminFreshSessionAction(
      parsed.rawSession,
      parsed.proxy,
      parsed.token,
      async ({ page, accessToken, refreshAccessToken }) => {
        let pageResult = await queryAccountStatusWithBrowserPage(
          page,
          accessToken,
          {
            timezoneOffsetMin: parsed.timezoneOffsetMin,
            email,
          },
        );
        if (!pageResult.ok && refreshAccessToken) {
          const refreshed = String(
            (await refreshAccessToken().catch(() => "")) || "",
          ).trim();
          if (refreshed) {
            pageResult = await queryAccountStatusWithBrowserPage(page, refreshed, {
              timezoneOffsetMin: parsed.timezoneOffsetMin,
              email,
            });
          }
        }
        return pageResult;
      },
      { captureSession: false, proxyGroupId: parsed.proxyGroupId },
    );
    result = await withAdminAccountHttpFallback({
      rawSession: parsed.rawSession,
      browserResult: result,
      httpFn: () =>
        queryAccountStatusBySession(parsed.token, {
          timezoneOffsetMin: parsed.timezoneOffsetMin,
          email,
          proxy: parsed.proxy,
          cookieHeader: parsed.cookieHeader,
        }),
    });
    await persistExportedAdminSession(parsed.jobKey, result);
    return respondAdminAccountAction(res, result, "查询账户状态失败");
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

app.post("/api/admin/account/reset-codex-quota", async (req, res) => {
  try {
    const parsed = await parseAdminSessionPayload(req);
    if (parsed.error) {
      return res.status(parsed.error.status).json({
        success: false,
        message: parsed.error.message,
      });
    }
    const email =
      extractEmailFromSession(parsed.rawSession) ||
      parsed.tokenCheck.email ||
      "";
    let result = await runAdminFreshSessionAction(
      parsed.rawSession,
      parsed.proxy,
      parsed.token,
      async ({ page, accessToken, refreshAccessToken }) =>
        resetCodexQuotaWithBrowserPage(page, {
          accessToken,
          accountId: parsed.tokenCheck.accountId,
          timezoneOffsetMin: parsed.timezoneOffsetMin,
          email,
          proxy: parsed.proxy,
          cookieHeader: parsed.cookieHeader,
          refreshAccessToken,
        }),
      { proxyGroupId: parsed.proxyGroupId },
    );
    result = await withAdminAccountHttpFallback({
      rawSession: parsed.rawSession,
      browserResult: result,
      httpFn: () =>
        resetCodexQuota(parsed.token, {
          timezoneOffsetMin: parsed.timezoneOffsetMin,
          email,
          proxy: parsed.proxy,
          cookieHeader: parsed.cookieHeader,
        }),
    });
    await persistExportedAdminSession(parsed.jobKey, result);
    return respondAdminAccountAction(res, result, "重置 Codex 额度失败");
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

app.post("/api/admin/subscription/batch-renewal-status", async (req, res) => {
  try {
    await ensureStoreReady();
    const jobKeys = Array.isArray(req.body?.job_keys)
      ? req.body.job_keys
          .map((item) => String(item || "").trim())
          .filter(Boolean)
          .slice(0, 50)
      : [];
    if (!jobKeys.length) {
      return res.json({ success: true, data: {} });
    }

    const timezoneOffsetMin = Number(req.body?.timezone_offset_min);
    const offset = Number.isFinite(timezoneOffsetMin)
      ? timezoneOffsetMin
      : new Date().getTimezoneOffset();
    const concurrency = 3;
    const results = {};
    let cursor = 0;
    const proxy = await pickTaskProxy(
      req.body?.proxy_group_id ?? req.body?.proxyGroupId,
    ).catch(() => "");

    async function queryJobRenewalStatus(jobKey) {
      const session = await store.getSessionByJobKey(jobKey);
      if (!session?.session_payload) {
        results[jobKey] = { ok: false, error: "无完整 Session" };
        return;
      }

      const rawSession = String(session.session_payload || "").trim();
      const resolved = await resolveAdminSessionToken(rawSession, proxy);
      const { token, tokenCheck } = resolved;
      if (!tokenCheck.valid) {
        results[jobKey] = { ok: false, error: tokenCheck.message };
        return;
      }

      const queryResult = await querySubscriptionBySession(token, {
        timezoneOffsetMin: offset,
        email: extractEmailFromSession(rawSession) || tokenCheck.email || "",
        proxy,
      });
      if (!queryResult.ok) {
        results[jobKey] = { ok: false, error: queryResult.error || "查询失败" };
        return;
      }

      const data = queryResult.data || {};
      results[jobKey] = {
        ok: true,
        email: data.email || "",
        autoRenew: data.autoRenew || "—",
        autoRenewRaw: data.autoRenewRaw,
        hasActiveSubscription: Boolean(data.hasActiveSubscription),
        subscriptionChannel: data.subscriptionChannel || "",
      };
    }

    async function worker() {
      while (cursor < jobKeys.length) {
        const index = cursor;
        cursor += 1;
        await queryJobRenewalStatus(jobKeys[index]);
      }
    }

    await Promise.all(
      Array.from({ length: Math.min(concurrency, jobKeys.length) }, () =>
        worker(),
      ),
    );
    return res.json({ success: true, data: results });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

app.get("/api/admin/screenshots", async (req, res) => {
  try {
    const rel = String(req.query.path || "")
      .replace(/\\/g, "/")
      .replace(/^\/+/, "");
    if (!rel || rel.includes("..") || !rel.endsWith(".png")) {
      return res
        .status(400)
        .json({ success: false, message: "无效的截图路径" });
    }
    const root = path.join(__dirname, "debug_screenshots");
    let fullPath = resolvePathWithin(root, rel);
    if (!fullPath || !fs.existsSync(fullPath)) {
      if (rel.startsWith("激活/")) {
        const altPath = resolvePathWithin(
          root,
          path.join("activation", rel.slice("激活/".length)),
        );
        if (altPath && fs.existsSync(altPath)) {
          fullPath = altPath;
        }
      }
    }
    if (!fullPath || !fs.existsSync(fullPath)) {
      return res.status(404).json({ success: false, message: "截图不存在" });
    }
    res.setHeader("Cache-Control", "private, max-age=3600");
    return res.sendFile(fullPath);
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

app.get("/api/admin/video", async (req, res) => {
  try {
    const rel = String(req.query.path || "")
      .replace(/\\/g, "/")
      .replace(/^\/+/, "");
    if (!rel || rel.includes("..") || !rel.endsWith(".webm")) {
      return res
        .status(400)
        .json({ success: false, message: "无效的录像路径" });
    }
    const root = path.join(__dirname, "debug_screenshots");
    const fullPath = resolvePathWithin(root, rel);
    if (!fullPath || !fs.existsSync(fullPath)) {
      return res.status(404).json({ success: false, message: "录像不存在" });
    }
    res.setHeader("Content-Type", "video/webm");
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.setHeader(
      "Content-Disposition",
      `inline; filename="${path.basename(fullPath)}"`,
    );
    return res.sendFile(fullPath);
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

app.get("/api/admin/screenshots/:subdir/:filename", async (req, res) => {
  try {
    const subdir = path.basename(String(req.params.subdir || ""));
    const filename = path.basename(String(req.params.filename || ""));
    if (!subdir || !filename || !filename.endsWith(".png")) {
      return res
        .status(400)
        .json({ success: false, message: "无效的截图路径" });
    }
    const root = path.join(__dirname, "debug_screenshots");
    const fullPath = resolvePathWithin(root, path.join(subdir, filename));
    if (!fullPath || !fs.existsSync(fullPath)) {
      return res.status(404).json({ success: false, message: "截图不存在" });
    }
    res.setHeader("Cache-Control", "private, max-age=3600");
    return res.sendFile(fullPath);
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

app.delete("/api/admin/task-logs/:jobKey", requireSecondaryAuth, async (req, res) => {
  try {
    await ensureStoreReady();
    const jobKey = decodeURIComponent(String(req.params.jobKey || "").trim());
    if (!jobKey) {
      return res.status(400).json({ success: false, message: "缺少任务标识" });
    }
    const { deleted, mediaDeleted } = await store.deleteTaskLogByJobKey(jobKey);
    if (!deleted) {
      return res
        .status(404)
        .json({ success: false, message: "未找到该任务记录" });
    }
    return res.json({
      success: true,
      message:
        mediaDeleted > 0
          ? `任务记录已删除，并清理 ${mediaDeleted} 个截图/录像文件`
          : "任务记录已删除",
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

function fireTelegramNotification(event, payload) {
  notifyTelegramEvent(store, event, payload).catch((error) => {
    console.error(`[Telegram] ${event} 通知失败:`, error.message);
  });
}

function notifyTaskOutcome({ event, email, cdk, jobKey, message }) {
  fireTelegramNotification(event, { email, cdk, jobKey, message });
}

app.post("/api/admin/telegram", async (req, res) => {
  try {
    await ensureStoreReady();
    const body = req.body || {};
    await store.saveTelegramConfig({
      bot_token: body.bot_token,
      admin_chat_id: body.admin_chat_id,
      group_chat_id: body.group_chat_id,
      notify_admin: Boolean(body.notify_admin),
      notify_group: Boolean(body.notify_group),
      on_success: Boolean(body.on_success),
      on_failure: Boolean(body.on_failure),
      on_card_pool_empty: Boolean(body.on_card_pool_empty),
    });
    res.json({ success: true, message: "Telegram 通知配置已保存" });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.post("/api/admin/telegram/test", async (req, res) => {
  try {
    await ensureStoreReady();
    const result = await sendTelegramTest(store, req.body || {});
    if (!result.success) {
      return res.status(400).json({ success: false, message: result.message });
    }
    res.json({ success: true, message: result.message });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.post("/api/admin/hcaptcha", async (req, res) => {
  try {
    await ensureStoreReady();
    const body = req.body || {};
    await store.saveHcaptchaConfig({
      enabled: Boolean(body.enabled),
      vlm_api_key: body.vlm_api_key,
      vlm_base_url: body.vlm_base_url,
      vlm_model: body.vlm_model,
      vlm_timeout: body.vlm_timeout,
      solver_timeout: body.solver_timeout,
      no_vlm: Boolean(body.no_vlm),
      cdp_port: body.cdp_port,
      captcha_platform_api_key: body.captcha_platform_api_key,
      captcha_platform_api_url: body.captcha_platform_api_url,
      captcha_platform_timeout: body.captcha_platform_timeout,
    });
    res.json({ success: true, message: "hCaptcha 求解器配置已保存" });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.post("/api/admin/hcaptcha/test", async (req, res) => {
  try {
    await ensureStoreReady();
    const cfg = await store.getHcaptchaConfig();
    const { env } = buildHcaptchaEnvFromConfig(cfg);
    const prevEnv = {};
    for (const [key, value] of Object.entries(env)) {
      prevEnv[key] = process.env[key];
      process.env[key] = value;
    }
    try {
      const status = await checkHcaptchaSolverHealth(cfg);
      if (!status.ready) {
        return res
          .status(400)
          .json({ success: false, message: status.message, status });
      }
      res.json({ success: true, message: status.message, status });
    } finally {
      for (const [key, value] of Object.entries(prevEnv)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.post("/api/admin/hcaptcha/test-vlm", async (req, res) => {
  try {
    await ensureStoreReady();
    const body = req.body || {};
    const cfg = await store.getHcaptchaConfig();
    const merged = {
      ...cfg,
      vlm_api_key: String(body.vlm_api_key || "").trim() || cfg.vlm_api_key,
      vlm_base_url: String(body.vlm_base_url || "").trim() || cfg.vlm_base_url,
      vlm_model: String(body.vlm_model || "").trim() || cfg.vlm_model,
      vlm_timeout: body.vlm_timeout ?? cfg.vlm_timeout,
    };
    const result = await testVlmConnectivity(merged);
    if (!result.ok) {
      return res.status(400).json({ success: false, ...result });
    }
    res.json({ success: true, ...result });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.post("/api/admin/hcaptcha/test-captcha-platform", async (req, res) => {
  try {
    await ensureStoreReady();
    const body = req.body || {};
    const cfg = await store.getHcaptchaConfig();
    const merged = {
      captcha_platform_api_key:
        String(body.captcha_platform_api_key || "").trim() ||
        cfg.captcha_platform_api_key,
      captcha_platform_api_url:
        String(body.captcha_platform_api_url || "").trim() ||
        cfg.captcha_platform_api_url,
      captcha_platform_timeout:
        body.captcha_platform_timeout ?? cfg.captcha_platform_timeout,
    };
    const resolved = resolveCaptchaPlatformCredentials(
      merged.captcha_platform_api_key,
      merged.captcha_platform_api_url,
    );
    merged.captcha_platform_api_url = resolved.apiUrl;
    if (resolved.apiKey) {
      await store.saveHcaptchaConfig({
        ...cfg,
        captcha_platform_api_key: resolved.apiKey,
        captcha_platform_api_url: resolved.apiUrl,
        captcha_platform_timeout: merged.captcha_platform_timeout,
      });
    }
    const result = await testCaptchaPlatformConnectivity({
      apiKey: merged.captcha_platform_api_key,
      apiUrl: merged.captcha_platform_api_url,
      timeoutSec: merged.captcha_platform_timeout,
    });
    if (!result.ok) {
      return res.status(400).json({ success: false, ...result });
    }
    res.json({ success: true, ...result });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.get("/api/admin/hcaptcha/logs", async (req, res) => {
  try {
    await ensureStoreReady();
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 15));
    const listing = listSolverLogFiles(limit);
    const file = String(req.query.file || "").trim();
    if (file) {
      const safeName = path.basename(file);
      const target = listing.files.find((item) => item.name === safeName);
      if (!target) {
        return res
          .status(404)
          .json({ success: false, message: "日志文件不存在" });
      }
      const lines = readSolverLogTail(target.path, 120);
      return res.json({ success: true, file: safeName, lines, ...listing });
    }
    const captchaRuntime = runtimeLog
      .tail(200)
      .filter((e) => e.source === "captcha" || e.level === "captcha");
    res.json({ success: true, runtime: captchaRuntime.slice(-80), ...listing });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── 第三方 GPT 代充 API 配置 ──────────────────────────────────────────────

app.get("/api/admin/gpt-api", async (req, res) => {
  try {
    await ensureStoreReady();
    const cfg = await store.getGptApiConfig();
    const masked = gptApi.maskApiKey(cfg.api_key);
    res.json({
      success: true,
      config: {
        enabled: cfg.enabled,
        base_url: cfg.base_url,
        api_key_saved: Boolean(cfg.api_key),
        api_key_preview: masked,
        plan_key: cfg.plan_key,
        country: cfg.country,
        currency: cfg.currency,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.post("/api/admin/gpt-api", async (req, res) => {
  try {
    await ensureStoreReady();
    const body = req.body || {};
    const baseUrlError = await validateExternalApiBaseUrl(body.base_url);
    if (baseUrlError) {
      return res.status(400).json({ success: false, message: baseUrlError });
    }
    await store.saveGptApiConfig({
      enabled: Boolean(body.enabled),
      base_url: body.base_url,
      api_key: body.api_key,
      plan_key: body.plan_key,
      country: body.country,
      currency: body.currency,
    });
    res.json({ success: true, message: "第三方代充 API 配置已保存" });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.post("/api/admin/gpt-api/test", async (req, res) => {
  try {
    await ensureStoreReady();
    const body = req.body || {};
    const saved = await store.getGptApiConfig();
    const merged = {
      base_url: String(body.base_url || "").trim() || saved.base_url,
      api_key: String(body.api_key || "").trim() || saved.api_key,
    };
    const baseUrlError = await validateExternalApiBaseUrl(merged.base_url);
    if (baseUrlError) {
      return res.status(400).json({ success: false, message: baseUrlError });
    }
    const result = await gptApi.testConnection(merged);
    if (!result.success) {
      return res
        .status(400)
        .json({ success: false, message: result.error || "连接失败" });
    }
    res.json({
      success: true,
      message: result.message,
      plans: result.plans,
      balance: result.balance,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.get("/api/admin/gpt-api/status", async (req, res) => {
  try {
    await ensureStoreReady();
    const cfg = await store.getGptApiConfig();
    if (!cfg.api_key) {
      return res
        .status(400)
        .json({ success: false, message: "尚未配置第三方代充 API Key" });
    }
    const [plansResult, balanceResult, recentOrders] = await Promise.all([
      gptApi.fetchPlans(cfg),
      gptApi.queryBalance(cfg),
      store.listRecentGptApiOrders(10),
    ]);
    if (!plansResult.success) {
      return res.status(400).json({
        success: false,
        message: `套餐查询失败: ${plansResult.error || "未知错误"}`,
      });
    }
    const orders = recentOrders.map((order) => ({
      job_key: order.job_key,
      cdk_code: order.cdk_code,
      status: order.status,
      message: order.message,
      updated_at: order.updated_at,
      order_id: order.gpt_api_order_id,
      task_id: order.gpt_api_task_id,
      topup_code: order.gpt_api_topup_code || null,
    }));
    res.json({
      success: true,
      gpt_plans: plansResult.gptPlans,
      credit_plans: plansResult.creditPlans,
      balance: balanceResult.success ? balanceResult.data : null,
      balance_error: balanceResult.success ? null : balanceResult.error,
      recent_orders: orders,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.post("/api/admin/config", async (req, res) => {
  try {
    await ensureStoreReady();
    const nextConfig = { ...(req.body || {}) };
    if (nextConfig.maintenance_mode) {
      nextConfig.maintenance_mode_drain = getTotalActiveJobs() > 0;
    } else {
      nextConfig.maintenance_mode_drain = false;
    }
    await store.saveConfig(nextConfig);
    res.json({ success: true, message: "所有资产配置已保存" });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── Region Selector API ────────────────────────────────────────────────────

app.get("/api/admin/region", async (req, res) => {
  try {
    await ensureStoreReady();
    const regionCode = await store.getPaymentRegion();
    const config = REGION_CONFIG[regionCode];
    res.json({
      success: true,
      region: regionCode,
      currency: config.currency,
      label: config.label,
      supported: REGION_CONFIG,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.put("/api/admin/region", async (req, res) => {
  try {
    await ensureStoreReady();
    const regionCode = String(req.body?.region || "").toUpperCase();
    if (!isSupportedRegion(regionCode)) {
      return res
        .status(400)
        .json({ success: false, error: "不支持的地区代码" });
    }
    const result = await store.setPaymentRegion(regionCode);
    if (!result.success) {
      return res.status(400).json({ success: false, error: result.error });
    }
    const config = REGION_CONFIG[regionCode];
    res.json({
      success: true,
      region: regionCode,
      currency: config.currency,
      label: config.label,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── Checkout Link Debug API ────────────────────────────────────────────────

app.get("/api/admin/checkout/plans", async (req, res) => {
  try {
    await ensureStoreReady();
    const regionCode = await store.getPaymentRegion();
    const config = REGION_CONFIG[regionCode] || REGION_CONFIG.PH;
    res.json({
      success: true,
      plans: store.getCheckoutPlanNameMap
        ? store.getCheckoutPlanNameMap()
        : {
            plus: store.resolvePlanName("plus"),
            pro_5x: store.resolvePlanName("pro_5x"),
            pro_20x: store.resolvePlanName("pro_20x"),
            credits: store.resolvePlanName("credits"),
          },
      resolved: {
        plus: store.resolvePlanName("plus"),
        pro_5x: store.resolvePlanName("pro_5x"),
        pro_20x: store.resolvePlanName("pro_20x"),
        credits: store.resolvePlanName("credits"),
      },
      region: regionCode,
      currency: config.currency,
      label: config.label,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.post("/api/admin/checkout/generate", async (req, res) => {
  try {
    await ensureStoreReady();
    const body = req.body || {};
    const rawSession = String(body.session || "").trim();
    if (!rawSession) {
      return res
        .status(400)
        .json({ success: false, error: "请提供 Session JSON" });
    }

    const sessionJson = parseSessionJson(rawSession);
    const token = normalizeSessionToken(rawSession);
    if (!token) {
      return res
        .status(400)
        .json({ success: false, error: "Session 无效，无法提取 accessToken" });
    }
    const tokenCheck = validateAccessToken(token);
    if (!tokenCheck.valid) {
      return res
        .status(400)
        .json({ success: false, error: tokenCheck.message });
    }

    const planType = String(body.plan_type || "plus").trim();
    const planNameOverride = body.plan_name
      ? String(body.plan_name).trim()
      : "";
    const resolvedPlanName =
      planNameOverride || store.resolvePlanName(planType);
    const creditQuantity = store.isCreditsPlan(planType)
      ? store.resolveCreditQuantity(
          planType,
          body.credit_quantity || body.credits || 0,
        )
      : 0;
    if (store.isCreditsPlan(planType) && creditQuantity < 250) {
      return res.status(400).json({
        success: false,
        error: "充值点数至少 250，且需为 250 的倍数",
      });
    }
    const regionCode = String(
      body.country || body.region || (await store.getPaymentRegion()),
    ).toUpperCase();
    if (!isSupportedRegion(regionCode)) {
      return res
        .status(400)
        .json({ success: false, error: `不支持的地区: ${regionCode}` });
    }

    const storedSession = buildStoredSessionPayload(
      rawSession,
      sessionJson,
      token,
    );
    const email = extractEmailFromSession(sessionJson);
    const task = await store.createTaskLog({
      tokenPreview: extractSessionPreview(storedSession),
      sessionPayload: storedSession,
      cdkCode: "[checkout-debug]",
      phone: null,
      cardLast4: null,
      status: "running",
      progress: 5,
    });

    await store.updateTaskLog(task.jobKey, {
      status: "running",
      message: `支付链接调试：${planType} / ${regionCode}`,
      progress: 5,
    });

    logTask(
      task.jobKey,
      `支付链接调试任务已创建 plan=${planType} plan_name=${resolvedPlanName} region=${regionCode} email=${email || "-"}`,
    );
    spawnCheckoutDebugWorker({
      task,
      token,
      sessionRaw: storedSession,
      planType,
      region: regionCode,
      planNameOverride: resolvedPlanName,
      creditQuantity,
      email,
      proxyGroupId: req.body?.proxy_group_id ?? req.body?.proxyGroupId ?? "",
    });

    return res.json({
      success: true,
      jobKey: task.jobKey,
      email: email || null,
      message: "浏览器调试任务已启动，请查看下方运行日志",
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post("/api/admin/checkout/pay", async (req, res) => {
  try {
    await ensureStoreReady();
    const result = await startPublicCheckoutPay({
      ...(req.body || {}),
      cdk_code: resolveAdminCheckoutCdk(req.body?.cdk_code),
    });
    return res.status(result.status).json(result.payload);
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

app.post("/api/admin/checkout/stop", async (req, res) => {
  try {
    await ensureStoreReady();
    const jobKey = String(req.body?.jobKey || req.body?.job_key || "").trim();
    const result = await stopCheckoutJob(jobKey);
    if (!result.ok) {
      return res.status(result.status).json({
        success: false,
        error: result.error,
      });
    }
    return res.json({
      success: true,
      jobKey: result.jobKey,
      message: result.message,
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

app.get("/api/admin/checkout/status/:jobKey", async (req, res) => {
  try {
    await ensureStoreReady();
    const jobKey = decodeURIComponent(String(req.params.jobKey || "").trim());
    if (!jobKey) {
      return res.status(400).json({ success: false, error: "缺少 jobKey" });
    }
    const task = await store.getTaskStatus(jobKey);
    if (!task) {
      return res.status(404).json({ success: false, error: "任务不存在" });
    }
    const checkoutUrl = extractCheckoutUrlFromOutput(task.raw_output || "");
    let screenshots = [];
    if (task.failure_screenshots) {
      try {
        const parsed = JSON.parse(task.failure_screenshots);
        if (Array.isArray(parsed)) screenshots = parsed;
      } catch (_) {
        /* ignore */
      }
    }
    if (!screenshots.length) {
      screenshots = extractScreenshotsFromOutput(task.raw_output || "");
    }
    const videos = extractVideosFromOutput(task.raw_output || "");
    const waitingPlanChoice =
      isWaitingCheckoutChoice(jobKey) ||
      /请用当前账号在浏览器打开付款链接|仍在等待你在付款页完成选择|等待选择套餐档位|仍在等待后台选择套餐档位/.test(
        String(task.raw_output || task.message || ""),
      );
    res.json({
      success: true,
      jobKey,
      status: task.status,
      message: task.message,
      progress: Number(task.progress || 0),
      checkout_url: checkoutUrl || null,
      waiting_plan_choice: waitingPlanChoice,
      screenshots,
      videos,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post("/api/admin/checkout/:jobKey/choice", async (req, res) => {
  try {
    const jobKey = decodeURIComponent(String(req.params.jobKey || "").trim());
    if (!jobKey) {
      return res.status(400).json({ success: false, error: "缺少 jobKey" });
    }
    const variant = String(req.body?.variant || req.body?.choice || "").trim();
    if (!activeForegroundJobs.has(jobKey)) {
      await store.updateTaskLog(jobKey, {
        status: "failed",
        message: "任务进程已退出，无法继续协议付款",
        progress: 100,
      });
      clearCheckoutChoice(jobKey);
      logTask(jobKey, "任务进程已退出，无法继续协议付款", "warn");
      return res.status(409).json({
        success: false,
        error: "任务已不在运行，无法继续协议付款",
      });
    }
    setCheckoutChoice(jobKey, variant);
    logTask(jobKey, `自定义付款已确认继续协议付款: ${variant}`);
    return res.json({
      success: true,
      jobKey,
      variant,
      message: "已确认，任务将继续协议付款",
    });
  } catch (error) {
    return res.status(400).json({ success: false, error: error.message });
  }
});

registerAdminAssetRoutes(app, {
  store,
  ensureStoreReady,
  requireSecondaryAuth,
  createCdks,
  logAdminSecurityEvent,
  getClientMeta: adminAuth.getClientMeta,
});

// ─── Proxy Pool CRUD API ────────────────────────────────────────────────────

app.get("/api/admin/proxies", authenticateAdmin, async (req, res) => {
  try {
    await ensureStoreReady();
    const proxies = await store.listProxyAssets({
      groupId: req.query?.group_id ?? req.query?.groupId ?? "all",
    });
    res.json({ success: true, proxies });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.post("/api/admin/proxies", authenticateAdmin, async (req, res) => {
  try {
    await ensureStoreReady();
    const input =
      req.body?.proxies ?? req.body?.proxy_url ?? req.body?.proxy ?? "";
    const result = await store.addProxyAssets(input, {
      groupId: req.body?.group_id ?? req.body?.groupId ?? null,
    });
    if (!result.success) {
      return res.status(400).json(result);
    }
    res.json(result);
  } catch (error) {
    const message = String(error.message || "保存代理失败");
    const clientError = /无效的代理分组|未提供代理/.test(message);
    res.status(clientError ? 400 : 500).json({
      success: false,
      error: message,
      message,
    });
  }
});

app.put("/api/admin/proxies/:id", authenticateAdmin, async (req, res) => {
  try {
    await ensureStoreReady();
    const id = req.params.id;
    if (Object.prototype.hasOwnProperty.call(req.body || {}, "is_active")) {
      const result = await store.setProxyAssetActive(
        id,
        Boolean(req.body.is_active),
      );
      if (!result.success) {
        return res.status(404).json(result);
      }
      return res.json(result);
    }
    if (Object.prototype.hasOwnProperty.call(req.body || {}, "proxy_url")) {
      const result = await store.updateProxyAsset(id, req.body.proxy_url);
      if (!result.success) {
        return res
          .status(result.error === "代理不存在" ? 404 : 400)
          .json(result);
      }
      return res.json(result);
    }
    return res.status(400).json({ success: false, error: "缺少可更新字段" });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.post("/api/admin/proxies/:id/test", authenticateAdmin, async (req, res) => {
  try {
    await ensureStoreReady();
    const row = await store.getProxyAssetById(req.params.id);
    if (!row) {
      return res.status(404).json({ success: false, error: "代理不存在" });
    }
    const result = await testProxyUrl(row.proxy_url);
    await store.updateProxyAssetCheck(row.id, result);
    res.json({ success: true, id: row.id, ...result });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.delete("/api/admin/proxies/:id", authenticateAdmin, async (req, res) => {
  try {
    await ensureStoreReady();
    const result = await store.deleteProxyAsset(req.params.id);
    if (!result.success) {
      return res.status(404).json(result);
    }
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── Tax-Free Address CRUD API ──────────────────────────────────────────────

app.get("/api/admin/addresses", async (req, res) => {
  try {
    await ensureStoreReady();
    const region = String(req.query?.region || "").toUpperCase();
    if (!region) {
      return res
        .status(400)
        .json({ success: false, error: "缺少 region 参数" });
    }
    const addresses = await taxFreeAddress.listAddresses(region);
    res.json({ success: true, addresses });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.post("/api/admin/addresses", async (req, res) => {
  try {
    await ensureStoreReady();
    const result = await taxFreeAddress.createAddress(req.body);
    if (!result.success) {
      return res.status(400).json(result);
    }
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.post("/api/admin/addresses/generate-random-us", async (req, res) => {
  try {
    await ensureStoreReady();
    const count = Number(req.body?.count) || 10;
    const result = await taxFreeAddress.batchGenerateUsAddresses(count);
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.delete("/api/admin/addresses/unbound", async (req, res) => {
  try {
    await ensureStoreReady();
    const region = String(req.query?.region || "US").toUpperCase();
    const result = await taxFreeAddress.clearUnboundAddresses(region);
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.put("/api/admin/addresses/:id", async (req, res) => {
  try {
    await ensureStoreReady();
    const id = req.params.id;
    const result = await taxFreeAddress.updateAddress(id, req.body);
    if (!result.success) {
      const status = result.error === "地址模板不存在" ? 404 : 400;
      return res.status(status).json(result);
    }
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.delete("/api/admin/addresses/:id", async (req, res) => {
  try {
    await ensureStoreReady();
    const id = req.params.id;
    const result = await taxFreeAddress.deleteAddress(id);
    if (!result.success) {
      return res.status(404).json(result);
    }
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.post("/api/admin/change-password", async (req, res) => {
  const currentPassword = String(req.body?.currentPassword || "");
  const newPassword = String(req.body?.newPassword || "").trim();

  if (!currentPassword) {
    return res.status(400).json({ success: false, message: "请输入原密码" });
  }

  if (newPassword.length < 12) {
    return res
      .status(400)
      .json({ success: false, message: "新密码至少 12 位" });
  }

  try {
    await ensureStoreReady();
    const authConfig = await store.getAdminAuthConfig();

    if (!verifyPassword(currentPassword, authConfig.passwordHash)) {
      return res.status(400).json({ success: false, message: "原密码错误" });
    }

    if (verifyPassword(newPassword, authConfig.passwordHash)) {
      return res
        .status(400)
        .json({ success: false, message: "新密码不能与原密码相同" });
    }

    await store.updateAdminPassword(newPassword);
    await logAdminSecurityEvent("password_changed", {
      ...adminAuth.getClientMeta(req),
      email: req.admin?.email || authConfig.email,
      detail: "登录密码已修改",
    });
    return res.json({ success: true, message: "密码修改成功，请重新登录" });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});



// ─── Billing Records API ─────────────────────────────────────────────────────

app.get("/api/admin/billing", requireSecondaryAuth, async (req, res) => {
  try {
    await ensureStoreReady();
    const filters = {};
    if (req.query.start_date) filters.startDate = req.query.start_date;
    if (req.query.end_date) filters.endDate = req.query.end_date;
    if (req.query.card_last4) filters.cardLast4 = req.query.card_last4;
    if (req.query.plan_type) filters.planType = req.query.plan_type;
    if (req.query.status) filters.status = req.query.status;
    const page = Math.max(1, Number(req.query.page) || 1);
    const result = await store.listBillingRecords(filters, page, 20);
    res.json({ success: true, ...result });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.get("/api/admin/billing/export", requireSecondaryAuth, async (req, res) => {
  try {
    await ensureStoreReady();
    const filters = {};
    if (req.query.start_date) filters.startDate = req.query.start_date;
    if (req.query.end_date) filters.endDate = req.query.end_date;
    if (req.query.card_last4) filters.cardLast4 = req.query.card_last4;
    if (req.query.plan_type) filters.planType = req.query.plan_type;
    if (req.query.status) filters.status = req.query.status;
    const csv = await store.exportBillingRecordsCSV(filters);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      'attachment; filename="billing_export.csv"',
    );
    res.send(csv);
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.get("/api/admin/billing/summary/:cardLast4", requireSecondaryAuth, async (req, res) => {
  try {
    await ensureStoreReady();
    const cardLast4 = String(req.params.cardLast4 || "");
    const summary = await store.getCardBillingSummary(cardLast4);
    res.json({ success: true, ...summary });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.delete("/api/admin/billing/failed", requireSecondaryAuth, async (req, res) => {
  try {
    await ensureStoreReady();
    const deleted = await store.deleteFailedBillingRecords();
    res.json({ success: true, deleted });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.delete("/api/admin/billing/:id", requireSecondaryAuth, async (req, res) => {
  try {
    await ensureStoreReady();
    const id = Number(req.params.id);
    if (!id) {
      return res.status(400).json({ success: false, message: "无效的记录 ID" });
    }
    const ok = await store.deleteBillingRecord(id);
    if (!ok) {
      return res
        .status(404)
        .json({ success: false, message: "账单记录不存在" });
    }
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

async function syncBrowserPoolModeFromStore() {
  const enabled = await store.getBrowserPoolEnabled();
  const savedSize = await store.getBrowserPoolSize();
  if (savedSize != null) {
    browserPool.setRuntimePoolSize(savedSize);
  }
  browserPool.setRuntimeEnabled(enabled);
  if (!enabled) {
    await browserPool.shutdownBrowserPool().catch(() => {});
    return { enabled: false, initialized: false, size: 0, mode: "standalone" };
  }
  const info = await browserPool.initBrowserPool();
  return { ...info, mode: "pool" };
}

async function spawnWorkerWithBrowser({ jobKey, runtimeEnv, runScript }) {
  if (isJobAborted(jobKey)) {
    return {
      code: null,
      signal: "SIGTERM",
      timedOut: false,
      output: "",
      analysis: { status: "failed", message: "任务已停止" },
    };
  }
  const poolEnabled = browserPool.getRuntimeEnabled();
  if (!poolEnabled) {
    logTask(jobKey, "浏览器模式: 独立启动（后台已关闭浏览器池）");
    return runScript(buildWorkerRuntimeEnv(runtimeEnv, null, "standalone"));
  }
  return browserPool.withBrowserSlot(jobKey, async (poolSlot) => {
    if (isJobAborted(jobKey)) {
      return {
        code: null,
        signal: "SIGTERM",
        timedOut: false,
        output: "",
        analysis: { status: "failed", message: "任务已停止" },
      };
    }
    if (poolSlot) {
      logTask(
        jobKey,
        `浏览器模式: 池 slot=${poolSlot.slotId} ${poolSlot.cdpUrl}`,
      );
    } else {
      logTask(jobKey, "浏览器模式: 池未就绪，回退独立启动");
    }
    const mode = poolSlot ? "pool" : "standalone";
    return runScript(buildWorkerRuntimeEnv(runtimeEnv, poolSlot, mode));
  });
}

function spawnCheckoutDebugWorker({
  task,
  token,
  sessionRaw,
  planType,
  region,
  creditQuantity = 0,
  planNameOverride,
  email,
  proxyGroupId = "",
}) {
  (async () => {
    const checkoutScript = path.join(__dirname, "index.js");
    let settled = false;
    try {
      const proxy = await pickTaskProxy(proxyGroupId);
      if (isJobAborted(task.jobKey)) {
        settled = true;
        return;
      }
      const hcaptchaCfg = await store.getHcaptchaConfig();
      const recordVideo = await store.getRecordVideoEnabled();
      const { env: hcaptchaEnv } = buildHcaptchaEnvFromConfig(hcaptchaCfg);
      const runtimeEnv = {
        ...process.env,
        ...hcaptchaEnv,
        CHECKOUT_DEBUG_ONLY: "1",
        CHECKOUT_MODE: "api",
        RECORD_VIDEO: recordVideo ? "1" : "0",
        CHATGPT_TOKEN: token,
        CHATGPT_SESSION_JSON: String(sessionRaw || "").startsWith("{")
          ? sessionRaw
          : "",
        CDK_PLAN_TYPE: planType,
        PAYMENT_REGION_OVERRIDE: region,
        PLAN_NAME_OVERRIDE: planNameOverride || "",
        CREDIT_QUANTITY: creditQuantity ? String(creditQuantity) : "",
        CDK_CODE: "",
        ACTIVATION_EMAIL: email || "",
        PROXY: proxy,
      };

      logTask(
        task.jobKey,
        `启动 Playwright 浏览器 proxy=${proxy ? "yes" : "no"}`,
      );
      const run = await spawnWorkerWithBrowser({
        jobKey: task.jobKey,
        runtimeEnv,
        runScript: (workerEnv) =>
          runCheckoutScript(
            task.jobKey,
            checkoutScript,
            workerEnv,
            1,
            async (progress) => {
              if (settled || isJobAborted(task.jobKey) || progress <= 0) return;
              if (isJobAborted(task.jobKey)) return;
              await store.updateTaskLog(task.jobKey, {
                status: "running",
                message: "浏览器调试进行中...",
                progress: Math.min(progress, 99),
              });
            },
          ),
      });

      const analysis = analyzeCheckoutDebugOutput(run.output, run.timedOut);
      if (isJobAborted(task.jobKey) && analysis.status !== "success") {
        settled = true;
        return;
      }
      const checkoutUrl =
        analysis.checkoutUrl || extractCheckoutUrlFromOutput(run.output);
      const failureScreenshots = extractScreenshotsFromOutput(run.output);
      const finalStatus = analysis.status || "failed";
      const finalProgress =
        finalStatus === "success"
          ? 100
          : Math.min(getCheckoutProgress(run.output, finalStatus), 99);
      const finalMessage =
        finalStatus === "success" && checkoutUrl
          ? `支付链接: ${checkoutUrl}`
          : analysis.message || "支付链接调试失败";

      settled = true;
      await store.updateTaskLog(task.jobKey, {
        status: finalStatus,
        message: finalMessage,
        rawOutput: run.output,
        progress: finalProgress,
        failureScreenshots,
      });

      logTask(
        task.jobKey,
        `调试结束 status=${finalStatus} url=${checkoutUrl ? "yes" : "no"} screenshots=${failureScreenshots.length}`,
      );
    } catch (error) {
      if (isJobAborted(task.jobKey)) {
        settled = true;
        return;
      }
      console.error(`[Checkout Debug] ${task.jobKey}:`, error);
      logTask(task.jobKey, `调试任务异常: ${error.message}`, "error");
      settled = true;
      await store.updateTaskLog(task.jobKey, {
        status: "failed",
        message: error.message,
        progress: 0,
      });
    } finally {
      abortedJobs.delete(String(task.jobKey || "").trim());
    }
  })();
}

function parseCheckoutCancelAutoRenew(value) {
  if (value === undefined || value === null || value === "") {
    return true;
  }
  if (typeof value === "boolean") {
    return value;
  }
  const raw = String(value).trim().toLowerCase();
  if (["0", "false", "no", "off", "n"].includes(raw)) {
    return false;
  }
  return true;
}

function spawnCheckoutPaymentWorker({
  task,
  token,
  sessionRaw,
  planType,
  region,
  creditQuantity = 0,
  planNameOverride,
  email,
  preferredCardId = 0,
  cardGroupId = null,
  manualCard = null,
  manualAddress = null,
  taskLabel = "付款调试",
  checkoutMode = "api",
  checkoutUrl = "",
  cancelAutoRenew = true,
  proxyGroupId = "",
}) {
  (async () => {
    const checkoutScript = path.join(__dirname, "index.js");
    const runningMessage = `${taskLabel}进行中...`;
    const failedMessage = `${taskLabel}失败`;
    let settled = false;
    try {
      const proxy = await pickTaskProxy(proxyGroupId);
      if (isJobAborted(task.jobKey)) {
        settled = true;
        return;
      }
      const hcaptchaCfg = await store.getHcaptchaConfig();
      const recordVideo = await store.getRecordVideoEnabled();
      const { env: hcaptchaEnv } = buildHcaptchaEnvFromConfig(hcaptchaCfg);
      const runtimeEnv = {
        ...process.env,
        ...hcaptchaEnv,
        CHECKOUT_MODE: checkoutMode === "ui" ? "ui" : "api",
        CHECKOUT_URL: checkoutUrl || "",
        CHECKOUT_WAIT_USER:
          checkoutMode === "ui" || checkoutUrl ? "1" : "",
        JOB_KEY: task.jobKey,
        RECORD_VIDEO: recordVideo ? "1" : "0",
        CHATGPT_TOKEN: token,
        CHATGPT_SESSION_JSON: String(sessionRaw || "").startsWith("{")
          ? sessionRaw
          : "",
        CDK_CODE: "",
        CDK_PLAN_TYPE: planType,
        PAYMENT_REGION_OVERRIDE: region,
        PLAN_NAME_OVERRIDE: planNameOverride || "",
        CREDIT_QUANTITY: creditQuantity ? String(creditQuantity) : "",
        ACTIVATION_EMAIL: email || "",
        PROXY: proxy,
        PAYMENT_CARD_ID: preferredCardId ? String(preferredCardId) : "",
        PAYMENT_CARD_GROUP_ID: cardGroupId ? String(cardGroupId) : "",
        PAYMENT_CARD_MANUAL: manualCard ? JSON.stringify(manualCard) : "",
        PAYMENT_ADDRESS_MANUAL: manualAddress
          ? JSON.stringify(manualAddress)
          : "",
        CANCEL_AUTO_RENEW: cancelAutoRenew ? "1" : "0",
      };

      logTask(
        task.jobKey,
        `启动${taskLabel} Playwright 浏览器 proxy=${proxy ? "yes" : "no"}`,
      );
      const run = await spawnWorkerWithBrowser({
        jobKey: task.jobKey,
        runtimeEnv,
        runScript: (workerEnv) =>
          runCheckoutScript(
            task.jobKey,
            checkoutScript,
            workerEnv,
            1,
            async (progress) => {
              if (settled || isJobAborted(task.jobKey) || progress <= 0) return;
              const runningProgress = Math.min(progress, 99);
              if (isJobAborted(task.jobKey)) return;
              await store.updateTaskLog(task.jobKey, {
                status: "running",
                message: runningMessage,
                progress: runningProgress,
              });
              broadcastToTask(task.jobKey, {
                type: "progress",
                jobKey: task.jobKey,
                status: "running",
                message: runningMessage,
                progress: runningProgress,
              });
            },
          ),
      });

      const analysis = analyzeProcessOutput(run.output, run.timedOut);
      if (isJobAborted(task.jobKey) && analysis.status !== "success") {
        settled = true;
        return;
      }
      const finalStatus =
        analysis.status === "retry" ? "failed" : analysis.status || "failed";
      const taskMedia = extractTaskMediaFromOutput(run.output);
      const cardLast4 = extractCardLast4FromOutput(run.output);
      const finalProgress =
        finalStatus === "success"
          ? 100
          : Math.min(getCheckoutProgress(run.output, finalStatus), 99);
      const finalMessage = analysis.message || failedMessage;

      settled = true;
      await store.updateTaskLog(task.jobKey, {
        status: finalStatus,
        message: finalMessage,
        rawOutput: run.output,
        progress: finalProgress,
        cardLast4,
        failureScreenshots: [...taskMedia.screenshots, ...taskMedia.videos],
      });
      broadcastToTask(task.jobKey, {
        type: "status",
        jobKey: task.jobKey,
        status: finalStatus,
        message: finalMessage,
        progress: finalProgress,
      });
      logTask(
        task.jobKey,
        `${taskLabel}结束 status=${finalStatus} card=${cardLast4 || "-"}`,
      );
    } catch (error) {
      if (isJobAborted(task.jobKey)) {
        settled = true;
        return;
      }
      console.error(`[Checkout Payment] ${task.jobKey}:`, error);
      logTask(task.jobKey, `${taskLabel}任务异常: ${error.message}`, "error");
      settled = true;
      await store.updateTaskLog(task.jobKey, {
        status: "failed",
        message: error.message,
        progress: 0,
      });
      broadcastToTask(task.jobKey, {
        type: "status",
        jobKey: task.jobKey,
        status: "failed",
        message: error.message,
        progress: 0,
      });
    } finally {
      abortedJobs.delete(String(task.jobKey || "").trim());
      releaseForegroundSlot(task.jobKey);
      drainActivationQueue().catch((error) => {
        console.warn(`[Queue] 排空失败: ${error.message}`);
      });
      if (getTotalActiveJobs() === 0) {
        const maintenanceModeState = await store.getMaintenanceModeState();
        if (maintenanceModeState.enabled && maintenanceModeState.drain) {
          await store.setMaintenanceModeState(true, false);
        }
      }
    }
  })();
}

/**
 * 第三方 GPT 代充 API 任务 Worker（协议见 协议api.md）
 *
 * 流程：
 * 1. 读取后台配置（base_url / api_key / plan_key / country / currency / enabled）
 * 2. 从银行卡池预留一张卡作为 new_card（可选，失败则跳过）
 * 3. POST /pay 提交代充（带 Idempotency-Key = `cdk-${cdk}`）
 * 4. 轮询订单/任务状态，直到终态（success / failed）
 * 5. 将结果写回 task_logs（含 gpt_api_order_id / gpt_api_task_id / gpt_api_raw）
 */
const GPT_API_PLAN_MAP = Object.freeze({
  plus: "plus",
  pro_5x: "pro5x",
  pro_20x: "pro20x",
});

function mapGptApiPlanKey(planType) {
  return GPT_API_PLAN_MAP[String(planType || "").trim()] || "plus";
}

function parseCardExpiry(value) {
  const match = String(value || "")
    .trim()
    .match(/^(0?[1-9]|1[0-2])\s*\/?\s*(\d{2}|\d{4})$/);
  if (!match)
    throw new Error("银行卡有效期格式错误，应为 MMYY、MM/YY 或 MM/YYYY");
  const year = Number(match[2].length === 2 ? `20${match[2]}` : match[2]);
  return { month: Number(match[1]), year };
}

async function runGptApiWorker({
  task,
  token,
  session,
  cdk,
  planType,
  proxyGroupId = "",
}) {
  const { jobKey } = task;
  const sessionPayload =
    session && typeof session === "object" ? session : { access_token: token };
  const accountEmail = task.tokenPreview || "";
  let shouldRollbackCdk = true;
  let reservedCard = null;

  const setProgress = async (status, progress, message, extra = {}) => {
    await store.updateTaskLog(jobKey, { status, progress, message, ...extra });
    broadcastToTask(jobKey, {
      type: status === "running" ? "progress" : "status",
      jobKey,
      status,
      progress,
      message,
      cdkCode: cdk,
    });
  };

  try {
    const cfg = await store.getGptApiConfig();
    if (!cfg.enabled) {
      throw new Error(
        "第三方代充 API 未启用，请在后台「系统配置」中开启并填写 API 地址与 Key",
      );
    }
    if (!cfg.api_key) {
      throw new Error("第三方代充 API Key 未配置");
    }

    const apiPlanKey = mapGptApiPlanKey(planType);
    await setProgress("running", 10, "正在检查 Session 格式...");
    const inspect = await gptApi.inspectPay(cfg, {
      planKey: apiPlanKey,
      session: sessionPayload,
    });
    if (!inspect.success) {
      const statusText = inspect.status ? ` (HTTP ${inspect.status})` : "";
      const detail = [
        inspect.error,
        inspect.reason,
        inspect.upstreamStatus ? `upstream ${inspect.upstreamStatus}` : "",
      ]
        .filter(Boolean)
        .join(" / ");
      throw new Error(
        `Session 格式或有效期检查失败${statusText}: ${detail || "session_invalid"}`,
      );
    }
    logTask(
      jobKey,
      "Session 本机格式／有效期检查通过；上游将在代充任务中验证登录状态",
    );

    const proxy = await pickTaskProxy(proxyGroupId);
    logTask(
      jobKey,
      proxy
        ? `第三方 API 协议代理 ${maskProxyForLog(proxy)}`
        : "第三方 API 使用平台启用代理池",
    );

    // 本機检查通过后才从卡池预留一张卡，避免无效 Session 占用资产。
    let newCard = null;
    reservedCard = await store.reserveCard(`gptapi_${jobKey}`);
    if (!reservedCard) {
      throw new Error(
        "银行卡池暂无可用卡片，请在后台「银行卡池」导入银行卡后再试",
      );
    }
    const expiry = parseCardExpiry(reservedCard.card_expiry);
    newCard = {
      number: reservedCard.card_number,
      exp_month: expiry.month,
      exp_year: expiry.year,
      cvc: reservedCard.card_cvc,
      name: reservedCard.card_holder || "API User",
      country: cfg.country || "PH",
    };
    logTask(
      jobKey,
      `第三方 API 使用卡池预留卡 ...${String(reservedCard.card_number || "").slice(-4)}`,
    );

    // 套餐从 CDK 的 plan_type 同步；国家币种使用协议默认值（PH / PHP）
    await setProgress("running", 20, "正在提交代充订单...");
    const idempotencyKey = `cdk-${cdk}`;
    const submit = await gptApi.submitPay(cfg, {
      planKey: apiPlanKey,
      session: sessionPayload,
      country: cfg.country,
      currency: cfg.currency,
      newCard,
      proxy,
      clientRef: `kc-cdk-${cdk}-${jobKey}`,
      idempotencyKey,
    });

    if (!submit.success) {
      const statusText = submit.status ? ` (HTTP ${submit.status})` : "";
      const detail =
        submit.error ||
        (submit.data && typeof submit.data === "object"
          ? JSON.stringify(submit.data).slice(0, 300)
          : "");
      throw new Error(`代充提交失败${statusText}: ${detail || "未知错误"}`);
    }

    const orderId = submit.orderId || submit.taskId || submit.id;
    const taskId = submit.taskId || null;
    if (!orderId) {
      throw new Error(
        `代充提交成功但未返回订单号: ${JSON.stringify(submit.data).slice(0, 300)}`,
      );
    }

    await setProgress(
      "running",
      35,
      `代充订单已创建 ${orderId}，正在等待上游处理...`,
      {
        gptApiOrderId: orderId,
        gptApiTaskId: taskId,
        gptApiRaw: JSON.stringify(submit.data),
        gptApiTopupCode: submit.topupCode,
      },
    );

    // 轮询状态
    let finalStatus = "running";
    let finalMessage = "第三方代充进行中";
    let lastRaw = submit.data;
    const maxPolls = Number(process.env.GPT_API_MAX_POLLS || 120);
    const pollIntervalMs = Number(process.env.GPT_API_POLL_INTERVAL_MS || 5000);

    for (let poll = 1; poll <= maxPolls; poll += 1) {
      await sleep(pollIntervalMs);

      let queryRes = null;
      if (taskId) {
        queryRes = await gptApi.queryTask(cfg, taskId);
      }
      if (!queryRes || !queryRes.success || !queryRes.rawStatus) {
        queryRes = await gptApi.queryOrder(cfg, orderId);
      }

      if (!queryRes || !queryRes.success) {
        logTask(
          jobKey,
          `状态轮询第 ${poll} 次失败: ${queryRes?.error || "未知错误"}`,
          "warn",
        );
        continue;
      }

      lastRaw = queryRes.data;
      const rawStatus = String(queryRes.rawStatus || "").toLowerCase();
      const progress = Math.min(95, 40 + poll);

      if (isTerminalGptApiStatus(rawStatus)) {
        const businessResult =
          lastRaw && typeof lastRaw.result === "object" ? lastRaw.result : {};
        const succeeded =
          businessResult.ok === false
            ? false
            : isSuccessGptApiStatus(rawStatus);
        const failureDetail =
          businessResult.error ||
          lastRaw?.error ||
          businessResult.status ||
          rawStatus ||
          "unknown";
        finalStatus = succeeded ? "success" : "failed";
        finalMessage = succeeded
          ? "第三方代充开通成功"
          : `第三方代充失败: ${failureDetail}`;
        await setProgress(finalStatus, succeeded ? 100 : 99, finalMessage, {
          gptApiRaw: JSON.stringify(lastRaw),
          gptApiTopupCode: gptApi.extractTopupCode(lastRaw),
        });
        break;
      }

      await setProgress(
        "running",
        progress,
        `上游处理中 (${rawStatus || "pending"})...`,
      );
    }

    if (finalStatus === "running") {
      finalStatus = "failed";
      finalMessage = "第三方代充超时未完成，请稍后在第三方平台查询订单状态";
      await setProgress(finalStatus, 99, finalMessage, {
        gptApiRaw: JSON.stringify(lastRaw),
        gptApiTopupCode: gptApi.extractTopupCode(lastRaw),
      });
    }

    if (finalStatus === "success") {
      shouldRollbackCdk = false;
      await store.resetCdkFailure(cdk);
      await store.recordCardUsage(reservedCard?.id);
      await store.releaseCard(reservedCard?.id).catch(() => {});
      try {
        const cancelResult = await cancelAutoRenewAfterActivation(token, {
          email: accountEmail,
        });
        if (cancelResult.ok) {
          logTask(jobKey, cancelResult.data?.message || "已关闭自动续费");
        } else {
          logTask(
            jobKey,
            `关闭自动续费失败: ${cancelResult.error || "未知错误"}`,
            "warn",
          );
        }
      } catch (cancelError) {
        logTask(jobKey, `关闭自动续费异常: ${cancelError.message}`, "warn");
      }
      notifyTaskOutcome({
        event: "success",
        email: accountEmail,
        cdk,
        jobKey,
        message: finalMessage,
      });
    } else {
      await store.releaseCard(reservedCard?.id).catch(() => {});
      notifyTaskOutcome({
        event: "failure",
        email: accountEmail,
        cdk,
        jobKey,
        message: finalMessage,
      });
    }
  } catch (error) {
    console.error(`[GPT API Task Error] ${jobKey}:`, error);
    logTask(jobKey, `第三方代充任务异常: ${error.message}`, "error");
    await store.releaseCard(reservedCard?.id).catch(() => {});
    await store.updateTaskLog(jobKey, {
      status: "failed",
      message: error.message,
      progress: 0,
      cdkCode: cdk,
    });
    broadcastToTask(jobKey, {
      type: "status",
      jobKey,
      status: "failed",
      message: error.message,
      cdkCode: cdk,
      progress: 0,
    });
    notifyTaskOutcome({
      event: "failure",
      email: accountEmail,
      cdk,
      jobKey,
      message: error.message,
    });
  } finally {
    releaseForegroundSlot(jobKey);
    if (shouldRollbackCdk) {
      await store.markCdkUnused(cdk).catch(() => {});
      logTask(jobKey, `CDK ${cdk} 已回滚为未使用`);
    }
    drainActivationQueue().catch((error) => {
      console.warn(`[Queue] 排空失败: ${error.message}`);
    });
    if (getTotalActiveJobs() === 0) {
      const maintenanceModeState = await store.getMaintenanceModeState();
      if (maintenanceModeState.enabled && maintenanceModeState.drain) {
        await store.setMaintenanceModeState(true, false);
      }
    }
  }
}

function maskProxyForLog(proxyUrl) {
  const raw = String(proxyUrl || "");
  try {
    const masked = raw.replace(/\/\/([^@/]+)@/, "//***:***@");
    return masked || "(空)";
  } catch (_) {
    return "(已配置)";
  }
}

const GPT_API_TERMINAL_SUCCESS = new Set([
  "success",
  "succeeded",
  "completed",
  "paid",
  "active",
  "开通成功",
  "成功",
]);
const GPT_API_TERMINAL_FAILED = new Set([
  "failed",
  "declined",
  "canceled",
  "cancelled",
  "error",
  "expired",
  "rejected",
  "失败",
  "取消",
]);

function isSuccessGptApiStatus(rawStatus) {
  const s = String(rawStatus || "")
    .toLowerCase()
    .trim();
  return [...GPT_API_TERMINAL_SUCCESS].some((kw) =>
    s.includes(kw.toLowerCase()),
  );
}

function isTerminalGptApiStatus(rawStatus) {
  const s = String(rawStatus || "")
    .toLowerCase()
    .trim();
  if (!s) return false;
  if (isSuccessGptApiStatus(s)) return true;
  return [...GPT_API_TERMINAL_FAILED].some((kw) =>
    s.includes(kw.toLowerCase()),
  );
}

function spawnActivationWorker({
  task,
  token,
  sessionRaw,
  cdk,
  cdkDetails,
  clientIp,
}) {
  (async () => {
    const checkoutScript = path.join(__dirname, "index.js");
    let finalRun = null;
    const allOutputs = [];
    let shouldRollbackCdk = true;
    let lastProgress = 0;
    const accountEmail =
      extractEmailFromSession(sessionRaw) || task.tokenPreview || "";

    try {
      for (let attempt = 1; attempt <= MAX_PROCESS_ATTEMPTS; attempt += 1) {
        logTask(
          task.jobKey,
          `开始第 ${attempt}/${MAX_PROCESS_ATTEMPTS} 次尝试`,
        );

        const attemptProgress = normalizeTaskProgress(
          attempt > 1 ? 1 : 3,
          "running",
          lastProgress,
        );
        broadcastToTask(task.jobKey, {
          type: "progress",
          jobKey: task.jobKey,
          progress: attemptProgress,
          status: "running",
          message: `正在进行第 ${attempt} 次尝试...`,
          cdkCode: cdk,
        });

        const proxy = await pickTaskProxy(cdkDetails?.proxy_group_id);
        if (isJobAborted(task.jobKey)) {
          return;
        }
        const hcaptchaCfg = await store.getHcaptchaConfig();
        const recordVideo = await store.getRecordVideoEnabled();
        const { env: hcaptchaEnv } = buildHcaptchaEnvFromConfig(hcaptchaCfg);
        const runtimeEnv = {
          ...process.env,
          ...hcaptchaEnv,
          JOB_KEY: task.jobKey,
          CHECKOUT_MODE: process.env.CHECKOUT_MODE || "api",
          RECORD_VIDEO: recordVideo ? "1" : "0",
          CHATGPT_TOKEN: token,
          CHATGPT_SESSION_JSON: String(sessionRaw || "").startsWith("{")
            ? sessionRaw
            : "",
          CDK_CODE: cdk,
          CDK_PLAN_TYPE: cdkDetails.plan_type || "plus",
          CREDIT_QUANTITY: store.isCreditsPlan(cdkDetails.plan_type)
            ? String(store.resolveCreditQuantity(cdkDetails.plan_type, 0) || "")
            : "",
          PROXY: proxy,
        };

        logTask(
          task.jobKey,
          `尝试 ${attempt} 启动自动化 proxy=${proxy ? "yes" : "no"}`,
        );

        const run = await spawnWorkerWithBrowser({
          jobKey: task.jobKey,
          runtimeEnv,
          runScript: (workerEnv) =>
            runCheckoutScript(
              task.jobKey,
              checkoutScript,
              workerEnv,
              attempt,
              async (progress, liveOutput) => {
                if (isJobAborted(task.jobKey)) return;
                if (progress > 0) {
                  const runningProgress = normalizeTaskProgress(
                    progress,
                    "running",
                    lastProgress,
                  );
                  lastProgress = runningProgress;
                  const updatePayload = {
                    status: "running",
                    message: "正在开通中",
                    rawOutput: null,
                    cdkCode: cdk,
                    progress: runningProgress,
                  };
                  if (liveOutput) {
                    const liveMedia = extractTaskMediaFromOutput(liveOutput);
                    const combined = [
                      ...liveMedia.screenshots,
                      ...liveMedia.videos,
                    ];
                    if (combined.length) {
                      updatePayload.failureScreenshots = combined;
                    }
                  }
                  await store.updateTaskLog(task.jobKey, updatePayload);
                  broadcastToTask(task.jobKey, {
                    type: "progress",
                    jobKey: task.jobKey,
                    progress: runningProgress,
                    status: "running",
                    message: "正在开通中",
                    cdkCode: cdk,
                    screenshots: liveOutput
                      ? extractTaskMediaFromOutput(liveOutput).screenshots
                      : undefined,
                    videos: liveOutput
                      ? extractTaskMediaFromOutput(liveOutput).videos
                      : undefined,
                  });
                }
              },
            ),
        });

        const cardLast4 = extractCardLast4FromOutput(run.output);
        allOutputs.push(
          `===== ATTEMPT ${attempt}${cardLast4 ? ` | CARD ${cardLast4}` : ""} =====\n${run.output}`,
        );
        finalRun = { ...run, output: allOutputs.join("\n\n") };

        const currentStatus =
          run.analysis.status === "success" ? "success" : "running";
        const currentProgress = normalizeTaskProgress(
          getCheckoutProgress(run.output, currentStatus),
          currentStatus,
          lastProgress,
        );
        lastProgress = currentProgress;
        await store.updateTaskLog(task.jobKey, {
          status: currentStatus,
          message: currentStatus === "success" ? "激活成功" : "正在开通中",
          rawOutput: finalRun.output,
          progress: currentProgress,
          cdkCode: cdk,
          cardLast4,
        });

        broadcastToTask(task.jobKey, {
          type: "progress",
          jobKey: task.jobKey,
          progress: currentProgress,
          status: currentStatus,
          message: currentStatus === "success" ? "激活成功" : "正在开通中",
          cdkCode: cdk,
          cardLast4,
        });

        if (!run.analysis.shouldRetry || attempt >= MAX_PROCESS_ATTEMPTS) {
          logTask(
            task.jobKey,
            `尝试 ${attempt} 结束，status=${run.analysis.status} shouldRetry=${run.analysis.shouldRetry}`,
          );
          break;
        }
        logTask(task.jobKey, `尝试 ${attempt} 失败，准备重试`, "warn");
      }

      const rawOutput = finalRun?.output || "";
      const normalizedAnalysis =
        finalRun?.analysis?.status === "retry"
          ? {
              ...finalRun.analysis,
              status: "failed",
              message: String(finalRun.analysis.message || "激活失败").replace(
                "，准备重试",
                "",
              ),
            }
          : finalRun?.analysis;
      const finalStatus = normalizedAnalysis?.status || "failed";
      if (isJobAborted(task.jobKey) && finalStatus !== "success") {
        return;
      }

      const finalProgress = normalizeTaskProgress(
        finalStatus === "success" ? 100 : lastProgress,
        finalStatus,
        lastProgress,
      );
      const taskMedia = extractTaskMediaFromOutput(rawOutput);
      const failureScreenshots = [
        ...taskMedia.screenshots,
        ...taskMedia.videos,
      ];
      await store.updateTaskLog(task.jobKey, {
        status: finalStatus,
        message: normalizedAnalysis?.message || null,
        rawOutput,
        cdkCode: cdk,
        progress: finalProgress,
        failureScreenshots,
      });

      broadcastToTask(task.jobKey, {
        type: "status",
        jobKey: task.jobKey,
        status: finalStatus,
        message: normalizedAnalysis?.message,
        cdkCode: cdk,
        progress: finalProgress,
        screenshots: taskMedia.screenshots,
        videos: taskMedia.videos,
      });

      logTask(
        task.jobKey,
        `任务结束 status=${finalStatus} progress=${finalProgress} message=${normalizedAnalysis?.message || ""}`,
      );

      if (finalStatus === "success") {
        shouldRollbackCdk = false;
        await store.resetCdkFailure(cdk);
        if (clientIp) {
          await store.resetActivationAttemptFailure("ip", clientIp);
        }
        notifyTaskOutcome({
          event: "success",
          email: accountEmail,
          cdk,
          jobKey: task.jobKey,
          message: normalizedAnalysis?.message || "激活成功",
        });
      } else if (isCardPoolExhaustedIssue(rawOutput, normalizedAnalysis)) {
        notifyTaskOutcome({
          event: "card_pool_empty",
          email: accountEmail,
          cdk,
          jobKey: task.jobKey,
          message: normalizedAnalysis?.message || "卡池资产枯竭",
        });
      } else if (finalStatus === "failed" || finalStatus === "manual") {
        notifyTaskOutcome({
          event: "failure",
          email: accountEmail,
          cdk,
          jobKey: task.jobKey,
          message: normalizedAnalysis?.message || "激活失败",
        });
      }

      if (finalStatus !== "success") {
        await store.markCdkUnused(cdk);
        logTask(task.jobKey, `CDK ${cdk} 已回滚为未使用`);
      }

      if (isNoActivationEligibilityMessage(normalizedAnalysis?.message)) {
        const cdkCooledDown = await store.recordCdkFailure(cdk);
        const ipCooledDown = clientIp
          ? await store.recordActivationAttemptFailure("ip", clientIp)
          : false;

        if (cdkCooledDown || ipCooledDown) {
          const cooldownParts = [];
          if (cdkCooledDown) {
            cooldownParts.push("该 CDK 已冷却 10 分钟");
            logTask(
              task.jobKey,
              `CDK ${cdk} 因连续无资格提交进入 10 分钟冷却`,
              "warn",
            );
          }
          if (ipCooledDown) {
            cooldownParts.push(`IP ${clientIp} 已冷却 10 分钟`);
            logTask(
              task.jobKey,
              `IP ${clientIp} 因连续无资格提交进入 10 分钟冷却`,
              "warn",
            );
          }
          const cooldownMessage = `${normalizedAnalysis?.message || "该账号无激活权限,请更换账号重试"}（${cooldownParts.join("，")}）`;
          await store.updateTaskLog(task.jobKey, {
            status: finalStatus,
            message: cooldownMessage,
            rawOutput,
            cdkCode: cdk,
            progress: finalProgress,
          });
          broadcastToTask(task.jobKey, {
            type: "status",
            jobKey: task.jobKey,
            status: finalStatus,
            message: cooldownMessage,
            cdkCode: cdk,
            progress: finalProgress,
          });
        }
      }
    } catch (bgError) {
      if (isJobAborted(task.jobKey)) {
        return;
      }
      console.error(`[Background Task Error] ${task.jobKey}:`, bgError);
      logTask(task.jobKey, `后台任务异常: ${bgError.message}`, "error");
      await store.updateTaskLog(task.jobKey, {
        status: "failed",
        message: bgError.message,
        rawOutput: bgError.message,
        cdkCode: cdk,
        progress: normalizeTaskProgress(lastProgress, "failed", lastProgress),
      });
      broadcastToTask(task.jobKey, {
        type: "status",
        jobKey: task.jobKey,
        status: "failed",
        message: bgError.message,
        cdkCode: cdk,
        progress: normalizeTaskProgress(lastProgress, "failed", lastProgress),
      });
      notifyTaskOutcome({
        event: "failure",
        email: accountEmail,
        cdk,
        jobKey: task.jobKey,
        message: bgError.message,
      });
      if (shouldRollbackCdk) {
        await store.markCdkUnused(cdk);
        logTask(task.jobKey, `CDK ${cdk} 已回滚为未使用`);
      }
    } finally {
      abortedJobs.delete(String(task.jobKey || "").trim());
      releaseForegroundSlot(task.jobKey);
      drainActivationQueue().catch((error) => {
        console.warn(`[Queue] 排空失败: ${error.message}`);
      });
      if (getTotalActiveJobs() === 0) {
        const maintenanceModeState = await store.getMaintenanceModeState();
        if (maintenanceModeState.enabled && maintenanceModeState.drain) {
          await store.setMaintenanceModeState(true, false);
        }
      }
    }
  })();
}

async function handleActivationRequest(req, res) {
  const rawSession = String(req.body?.session || req.body?.token || "").trim();
  const sessionJson = parseSessionJson(rawSession);
  const token = normalizeSessionToken(rawSession);
  const cdk = String(req.body?.cdk || "").trim();
  const clientIp = getClientIp(req);
  console.log(
    `[Activation] 收到开通请求 path=${req.path} cdk=${cdk} session_json=${Boolean(sessionJson)} token_len=${token.length}`,
  );
  if (!token) {
    return res
      .status(400)
      .json({ success: false, message: "缺少 Session JSON 或 AccessToken" });
  }
  if (!cdk) {
    return res.status(400).json({ success: false, message: "缺少 CDK" });
  }
  const tokenCheck = validateAccessToken(token);
  if (!tokenCheck.valid) {
    return res
      .status(400)
      .json({ success: false, message: tokenCheck.message });
  }

  try {
    await ensureStoreReady();
    if (VERIFY_OPENAI_TOKEN_ON_ACTIVATION) {
      // Claim inspection alone is not signature verification. Ask the issuer's
      // authenticated endpoint before a CDK is consumed or a worker starts.
      const verification = await querySubscriptionBySession(token, {
        email: extractEmailFromSession(rawSession) || tokenCheck.email || "",
      });
      if (!verification.ok) {
        return res.status(400).json({
          success: false,
          message: "Session 无法通过 OpenAI 服务验证，请确认有效后重试",
        });
      }
    }
    const maintenanceModeState = await store.getMaintenanceModeState();
    if (maintenanceModeState.enabled) {
      return res
        .status(503)
        .json({ success: false, message: "系统维护中，请稍后再试" });
    }
    const maxConcurrentActivations = await store.getMaxConcurrentActivations();
    const atCapacity =
      activeForegroundJobs.size >= maxConcurrentActivations;

    const cdkDetails = await store.verifyCdkDetails(cdk);
    const runningTask = cdkDetails
      ? await store.getRunningTaskByCdk(cdk)
      : null;
    if (runningTask) {
      return res.json({
        success: true,
        jobKey: runningTask.job_key,
        viewerToken: adminAuth.issueTaskViewerToken(runningTask.job_key).token,
        message: runningTask.message || "该 CDK 正在开通中，已为您恢复等待进度",
      });
    }
    if (!cdkDetails || cdkDetails.used_at || cdkDetails.type !== "自助") {
      return res
        .status(403)
        .json({ success: false, message: "CDK 无效、已使用或非自助激活码" });
    }

    const cdkCooldownMinutes = getRemainingCooldownMinutes(
      cdkDetails.cooldown_until,
    );
    if (cdkCooldownMinutes > 0) {
      return res.status(403).json({
        success: false,
        message: `该卡密连续无资格尝试过多，请冷静 ${cdkCooldownMinutes} 分钟后再试`,
      });
    }

    if (clientIp) {
      const ipAttemptLimit = await store.getActivationAttemptLimit(
        "ip",
        clientIp,
      );
      const ipCooldownMinutes = getRemainingCooldownMinutes(
        ipAttemptLimit?.cooldown_until,
      );
      if (ipCooldownMinutes > 0) {
        return res.status(403).json({
          success: false,
          message: `当前 IP 连续无资格尝试过多，请冷静 ${ipCooldownMinutes} 分钟后再试`,
        });
      }
    }

    // 判断是否走第三方代充 API 模式（后台「系统配置」开启后生效）
    // Codex 充值点数走本地协议，不走第三方代充
    const gptApiConfig = await store.getGptApiConfig();
    const useGptApi =
      gptApiConfig.enabled &&
      Boolean(gptApiConfig.api_key) &&
      !store.isCreditsPlan(cdkDetails.plan_type);

    if (!useGptApi) {
      const hasCard = await store.hasAvailableCard(cdkDetails.card_group_id);
      if (!hasCard) {
        const poolEmail = extractEmailFromSession(rawSession);
        fireTelegramNotification("card_pool_empty", {
          email: poolEmail,
          cdk,
          message: cdkDetails.card_group_id
            ? "该 CDK 绑定的银行卡分组暂无可用卡片，任务未启动"
            : "银行卡池暂无可用卡片，任务未启动",
        });
        return res.status(503).json({
          success: false,
          message: cdkDetails.card_group_id
            ? "该 CDK 绑定的银行卡分组暂无可用卡片，请先在后台将该分组补充银行卡后再试"
            : "银行卡池暂无可用卡片，请先在后台「银行卡池」导入银行卡后再试",
        });
      }
    }

    const lockSuccess = await store.markCdkUsed(cdk);
    if (!lockSuccess) {
      return res
        .status(403)
        .json({ success: false, message: "CDK 不可用或正在被他人使用" });
    }

    const storedSession = buildStoredSessionPayload(
      rawSession,
      sessionJson,
      token,
    );
    const task = await store.createTaskLog({
      tokenPreview: extractSessionPreview(storedSession),
      sessionPayload: storedSession,
      cdkCode: cdk,
      phone: null,
      cardLast4: null,
      status: atCapacity ? "processing" : "running",
      progress: atCapacity ? 1 : 3,
    });
    const viewerToken = adminAuth.issueTaskViewerToken(task.jobKey).token;

    if (atCapacity) {
      await store.updateTaskLog(task.jobKey, {
        status: "processing",
        message: "当前任务较多，已加入排队",
        progress: 1,
      });
      logTask(task.jobKey, `任务已排队，CDK=${cdk}`);
      drainActivationQueue().catch((error) => {
        console.warn(`[Queue] 排空失败: ${error.message}`);
      });
      return res.json({
        success: true,
        jobKey: task.jobKey,
        viewerToken,
        queued: true,
        message: "当前任务较多，已加入排队，请稍候",
      });
    }

    logTask(
      task.jobKey,
      `任务已创建，CDK=${cdk} mode=${useGptApi ? "gpt-api" : "local"}`,
    );
    reserveForegroundSlot(task.jobKey);

    if (useGptApi) {
      runGptApiWorker({
        task,
        token,
        session: JSON.parse(storedSession),
        cdk,
        planType: cdkDetails.plan_type || "plus",
        proxyGroupId: cdkDetails.proxy_group_id,
      }).catch((error) => {
        console.error(`[GPT API Worker] ${task.jobKey}:`, error);
      });
    } else {
      spawnActivationWorker({
        task,
        token,
        sessionRaw: storedSession,
        cdk,
        cdkDetails,
        clientIp,
      });
    }

    return res.json({
      success: true,
      jobKey: task.jobKey,
      viewerToken,
      queued: false,
      message: "任务已启动，正在为您开通中...",
    });
  } catch (error) {
    try {
      await store.markCdkUnused(cdk);
    } catch (_) {}
    return res.status(500).json({ success: false, message: error.message });
  }
}

async function authorizeTaskSubscription(data, jobKey, request) {
  if (adminAuth.verifyTaskViewerToken(String(data.viewerToken || ""), jobKey)) {
    return true;
  }

  const adminPayload = adminAuth.verifyAdminToken(
    String(data.adminToken || getCookieValue(request || {}, ADMIN_SESSION_COOKIE)),
  );
  if (!adminPayload) return false;

  await ensureStoreReady();
  const authConfig = await store.getAdminAuthConfig();
  return Number(adminPayload.pv || 0) === authConfig.passwordVersion;
}

app.post("/api/admin/trigger-activation", handleActivationRequest);

async function start() {
  await ensureStoreReady();

  try {
    const poolInfo = await syncBrowserPoolModeFromStore();
    if (poolInfo.enabled && poolInfo.initialized !== false) {
      runtimeLog.push({
        jobKey: "",
        level: "system",
        source: "server",
        text: `[BrowserPool] 已预热 ${poolInfo.size} 个浏览器槽位`,
      });
    } else if (!poolInfo.enabled) {
      runtimeLog.push({
        jobKey: "",
        level: "system",
        source: "server",
        text: "[Browser] 独立启动模式（后台已关闭浏览器池）",
      });
    }
  } catch (error) {
    console.error(`[BrowserPool] 初始化失败: ${error.message}`);
  }

  // 启动时仅回收超时锁，避免影响其他实例仍在执行的任务。
  try {
    const released = await store.releaseStaleAssetLocks();
    console.log(
      `🧹 [资产锁] 启动回收过期锁 phone=${released.phoneReleased} card=${released.cardReleased} pool_emails=${released.poolReleased}`,
    );
  } catch (error) {
    console.error(`❌ [资产锁] 启动回收失败: ${error.message}`);
  }

  try {
    const reaped = await reapOrphanCheckoutTasks({ startup: true });
    if (reaped.failed) {
      console.warn(`[Checkout] 启动回收卡住的调试任务 ${reaped.failed} 个`);
    }
  } catch (error) {
    console.error(`[Checkout] 启动回收失败: ${error.message}`);
  }

  setInterval(() => {
    reapOrphanCheckoutTasks().catch((error) => {
      console.warn(`[Checkout] 周期回收失败: ${error.message}`);
    });
  }, 60 * 1000).unref();

  // 每 60 秒兜底回收一次"超过 15 分钟仍未释放"的锁（防进程崩溃）
  setInterval(async () => {
    try {
      const released = await store.releaseStaleAssetLocks();
      if (
        released.phoneReleased > 0 ||
        released.cardReleased > 0 ||
        released.poolReleased > 0
      ) {
        console.log(
          `🧹 [资产锁] 兜底回收  phone=${released.phoneReleased}  card=${released.cardReleased}  pool_emails=${released.poolReleased}`,
        );
      }
    } catch (error) {
      console.warn(`⚠️  [资产锁] 周期清理失败: ${error.message}`);
    }
  }, 60 * 1000).unref();

  const runDebugMediaCleanup = (reason) => {
    const result = mediaCleanup.purgeOldMedia(
      path.join(__dirname, "debug_screenshots"),
      {
        maxAgeMs:
          Math.max(1, Number(process.env.MEDIA_RETENTION_DAYS || 7)) *
          24 *
          60 *
          60 *
          1000,
        maxTotalBytes:
          Math.max(0, Number(process.env.MEDIA_MAX_GB || 2)) * 1024 ** 3,
      },
    );
    if (result.deleted > 0) {
      const text = `[MediaCleanup] ${reason}删除 ${result.deleted} 个截图/录像，释放 ${result.freedText}`;
      console.log(text);
      runtimeLog.push({
        jobKey: "",
        level: "system",
        source: "server",
        text,
      });
    }
    return result;
  };

  setTimeout(() => {
    try {
      runDebugMediaCleanup("启动");
    } catch (error) {
      console.warn(`[MediaCleanup] 启动清理失败: ${error.message}`);
    }
  }, 20 * 1000).unref();

  setInterval(() => {
    try {
      runDebugMediaCleanup("周期");
    } catch (error) {
      console.warn(`[MediaCleanup] 周期清理失败: ${error.message}`);
    }
  }, 6 * 60 * 60 * 1000).unref();

  const server = app.listen(PORT, () => {
    sampleCpuPercent();
    setInterval(sampleCpuPercent, 2000).unref();
    const conn = store.connectionInfo;
    runtimeLog.push({
      jobKey: "",
      level: "system",
      source: "server",
      text: `✅ 服务就绪  http://localhost:${PORT}  ·  MySQL ${conn.user}@${conn.host}:${conn.port}/${conn.database}  ·  PID=${process.pid}`,
    });
    console.log("数据库表检查完成");
    console.log(`http://localhost:${PORT}`);
    console.log(
      `MySQL => ${conn.user}@${conn.host}:${conn.port}/${conn.database}`,
    );
  });

  // WebSocket Server Setup
  const wss = new WebSocket.Server({ server, maxPayload: 8 * 1024 });
  let activeWebSocketConnections = 0;
  const MAX_WEB_SOCKET_CONNECTIONS = 200;
  wss.on("connection", (ws, request) => {
    activeWebSocketConnections += 1;
    if (activeWebSocketConnections > MAX_WEB_SOCKET_CONNECTIONS) {
      activeWebSocketConnections -= 1;
      ws.close(1013, "服务器繁忙，请稍后重试");
      return;
    }

    let currentJobKey = null;
    let subscribed = false;
    const subscriptionTimeout = setTimeout(() => {
      if (!subscribed) ws.close(1008, "订阅超时");
    }, 10_000);

    ws.on("message", async (message) => {
      try {
        const data = JSON.parse(message);
        if (data.type === WS_HEARTBEAT_PING_TYPE) {
          if (!subscribed) return ws.close(1008, "尚未授权订阅");
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(
              JSON.stringify({
                type: WS_HEARTBEAT_PONG_TYPE,
                ts: Number(data.ts) || Date.now(),
              }),
            );
          }
          return;
        }
        if (data.type === "subscribe" && data.jobKey) {
          const jobKey = String(data.jobKey || "").trim();
          if (!/^[A-Za-z0-9._-]{1,80}$/.test(jobKey)) {
            return ws.close(1008, "无效任务标识");
          }
          if (!(await authorizeTaskSubscription(data, jobKey, request))) {
            return ws.close(1008, "未授权订阅");
          }
          if (currentJobKey && currentJobKey !== jobKey) {
            unsubscribeTaskClient(currentJobKey, ws);
          }
          currentJobKey = jobKey;
          subscribed = true;
          clearTimeout(subscriptionTimeout);
          if (!taskClients.has(currentJobKey)) {
            taskClients.set(currentJobKey, new Set());
          }
          taskClients.get(currentJobKey).add(ws);
          console.log(`Client subscribed to task: ${currentJobKey}`);
          await sendTaskSnapshot(ws, currentJobKey);
        }
      } catch (e) {
        console.error("WebSocket message error:", e);
      }
    });

    ws.on("close", () => {
      clearTimeout(subscriptionTimeout);
      activeWebSocketConnections = Math.max(0, activeWebSocketConnections - 1);
      unsubscribeTaskClient(currentJobKey, ws);
    });
  });
}

if (process.env.IS_PRODUCT_FLOW === "true") {
  console.log("[系统] 检测到成品子流程环境，跳过 Web 服务监听。");
} else {
  start().catch((error) => {
    console.error("服务启动失败:", error.message);

    if (error && /ECONNREFUSED|connect/i.test(String(error.message || error))) {
      const conn = store.connectionInfo;
      console.error(
        `MySQL 连接配置 => ${conn.user}@${conn.host}:${conn.port}/${conn.database}`,
      );
      console.error("排查建议:");
      console.error(
        "1. 确认本机或远程 MySQL 已启动，并且监听了对应 host/port。",
      );
      console.error(`2. 如果不是本机默认库，请先设置环境变量后再启动，例如:`);
      console.error(
        `   $env:DB_HOST='127.0.0.1'; $env:DB_PORT='3306'; $env:DB_USER='root'; $env:DB_PASSWORD='你的密码'; $env:DB_NAME='gpt'; node server.js`,
      );
      console.error(
        "3. 首次建库时，请先在 MySQL 中创建数据库，再启动服务自动建表。",
      );
    }

    process.exit(1);
  });
}
