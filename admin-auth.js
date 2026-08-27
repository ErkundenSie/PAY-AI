"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const BASE32_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

const ADMIN_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const ADMIN_REFRESH_AFTER_MS = 60 * 60 * 1000;
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const SECONDARY_TOKEN_TTL_MS = 30 * 60 * 1000;
const TG_CODE_TTL_MS = 5 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_LOCK_MS = 30 * 60 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const TG_CODE_MAX_ATTEMPTS = 5;
const TASK_VIEWER_TOKEN_TTL_MS = 60 * 60 * 1000;
const MIN_ADMIN_TOKEN_SECRET_LENGTH = 32;

const loginAttempts = new Map();
const tgLoginCodes = new Map();

function resolveAdminTokenSecret() {
  const configured = String(process.env.ADMIN_TOKEN_SECRET || "").trim();
  if (configured) {
    if (configured.length < MIN_ADMIN_TOKEN_SECRET_LENGTH) {
      throw new Error(
        `ADMIN_TOKEN_SECRET 至少需要 ${MIN_ADMIN_TOKEN_SECRET_LENGTH} 个字符`,
      );
    }
    return configured;
  }

  // Never derive a signing key from public values such as the working directory.
  // The generated key lives in the persistent data volume so restarts retain it.
  const secretFile = path.join(__dirname, "data", ".admin-token-secret");
  try {
    const existing = fs.readFileSync(secretFile, "utf8").trim();
    if (existing.length >= MIN_ADMIN_TOKEN_SECRET_LENGTH) return existing;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  fs.mkdirSync(path.dirname(secretFile), { recursive: true, mode: 0o700 });
  const generated = crypto.randomBytes(48).toString("base64url");
  try {
    fs.writeFileSync(secretFile, `${generated}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    console.warn(
      "[安全] 未设置 ADMIN_TOKEN_SECRET，已生成并持久化随机签名密钥；生产环境请在 .env 中设置独立密钥。",
    );
    return generated;
  } catch (error) {
    if (error.code === "EEXIST") {
      const existing = fs.readFileSync(secretFile, "utf8").trim();
      if (existing.length >= MIN_ADMIN_TOKEN_SECRET_LENGTH) return existing;
    }
    throw error;
  }
}

function encodeBase64Url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function decodeBase64Url(input) {
  const normalized = String(input || "")
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(String(input || "").length / 4) * 4, "=");
  return Buffer.from(normalized, "base64").toString("utf8");
}

function signPayload(encodedPayload, secret = resolveAdminTokenSecret()) {
  return crypto
    .createHmac("sha256", secret)
    .update(encodedPayload)
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function safeEqualString(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function createPasswordHash(
  password,
  salt = crypto.randomBytes(16).toString("hex"),
) {
  const hash = crypto.scryptSync(String(password), salt, 64).toString("hex");
  return `scrypt$${salt}$${hash}`;
}

function verifyPassword(password, storedHash) {
  const parts = String(storedHash || "").split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") {
    return false;
  }
  const [, salt, expectedHash] = parts;
  const actualHash = crypto
    .scryptSync(String(password), salt, 64)
    .toString("hex");
  return safeEqualString(actualHash, expectedHash);
}

function issueSignedToken(payload, ttlMs, secret = resolveAdminTokenSecret()) {
  const now = Date.now();
  const body = {
    ...payload,
    iat: now,
    exp: now + ttlMs,
  };
  const encodedPayload = encodeBase64Url(JSON.stringify(body));
  const signature = signPayload(encodedPayload, secret);
  return {
    token: `${encodedPayload}.${signature}`,
    payload: body,
  };
}

function verifySignedToken(
  token,
  { expectedSub, secret = resolveAdminTokenSecret() } = {},
) {
  if (!token || typeof token !== "string") {
    return null;
  }
  const [encodedPayload, signature] = token.split(".");
  if (!encodedPayload || !signature) {
    return null;
  }
  const expectedSignature = signPayload(encodedPayload, secret);
  if (!safeEqualString(signature, expectedSignature)) {
    return null;
  }
  try {
    const payload = JSON.parse(decodeBase64Url(encodedPayload));
    if (!payload || !payload.exp || Date.now() >= Number(payload.exp)) {
      return null;
    }
    if (expectedSub && payload.sub !== expectedSub) {
      return null;
    }
    return payload;
  } catch (_) {
    return null;
  }
}

function issueAdminToken(passwordVersion, email = "") {
  return issueSignedToken(
    {
      sub: "admin",
      permissions: ["admin"],
      pv: Math.max(1, Number(passwordVersion || 1)),
      email: String(email || "")
        .trim()
        .toLowerCase(),
    },
    ADMIN_TOKEN_TTL_MS,
  );
}

function verifyAdminToken(token) {
  const payload = verifySignedToken(token, { expectedSub: "admin" });
  if (
    !payload ||
    !Array.isArray(payload.permissions) ||
    !payload.permissions.includes("admin")
  ) {
    return null;
  }
  return payload;
}

function issueTaskViewerToken(jobKey) {
  return issueSignedToken(
    {
      sub: "task_viewer",
      jobKey: String(jobKey || "").trim(),
    },
    TASK_VIEWER_TOKEN_TTL_MS,
  );
}

function verifyTaskViewerToken(token, jobKey) {
  const payload = verifySignedToken(token, { expectedSub: "task_viewer" });
  if (!payload || !payload.jobKey || !jobKey) return null;
  return safeEqualString(String(payload.jobKey), String(jobKey))
    ? payload
    : null;
}

function issueLoginChallenge({ email, passwordVersion, ip, fingerprint }) {
  const challengeId = crypto.randomBytes(16).toString("hex");
  return issueSignedToken(
    {
      sub: "admin_login_challenge",
      cid: challengeId,
      email: String(email || "")
        .trim()
        .toLowerCase(),
      pv: Math.max(1, Number(passwordVersion || 1)),
      ip: String(ip || "").slice(0, 45),
      fp: String(fingerprint || "").slice(0, 128),
    },
    CHALLENGE_TTL_MS,
  );
}

function verifyLoginChallenge(token) {
  return verifySignedToken(token, { expectedSub: "admin_login_challenge" });
}

function issueSecondaryToken(secondaryPasswordVersion, ip = "") {
  return issueSignedToken(
    {
      sub: "admin_secondary",
      sv: Math.max(1, Number(secondaryPasswordVersion || 1)),
      ip: String(ip || "").slice(0, 45),
    },
    SECONDARY_TOKEN_TTL_MS,
  );
}

function verifySecondaryToken(token) {
  return verifySignedToken(token, { expectedSub: "admin_secondary" });
}

function getClientMeta(req) {
  const trustProxy = String(process.env.TRUST_PROXY || "0") === "1";
  const forwarded = trustProxy
    ? String(req.headers["x-forwarded-for"] || "")
        .split(",")[0]
        .trim()
    : "";
  const realIp = trustProxy
    ? String(req.headers["x-real-ip"] || "").trim()
    : "";
  const ip = forwarded || realIp || req.socket?.remoteAddress || "";
  return {
    ip: ip.replace(/^::ffff:/, ""),
    userAgent: String(req.headers["user-agent"] || "").slice(0, 512),
    fingerprint: String(
      req.body?.fingerprint || req.headers["x-client-fingerprint"] || "",
    ).slice(0, 128),
  };
}

function normalizeEmail(email) {
  return String(email || "")
    .trim()
    .toLowerCase();
}

const LOGIN_ATTEMPT_MAX_KEYS = 10_000;

function loginAttemptKey(kind, value) {
  return `${kind}:${String(value || "unknown").slice(0, 80)}`;
}

function pruneLoginAttempts(now = Date.now()) {
  for (const [key, entry] of loginAttempts) {
    if (!entry) {
      loginAttempts.delete(key);
      continue;
    }
    const windowExpired = now - Number(entry.firstAt || 0) > LOGIN_WINDOW_MS;
    const lockExpired = !entry.lockedUntil || now >= entry.lockedUntil;
    if (windowExpired && lockExpired) {
      loginAttempts.delete(key);
    }
  }
  if (loginAttempts.size <= LOGIN_ATTEMPT_MAX_KEYS) {
    return;
  }
  const overflow = loginAttempts.size - LOGIN_ATTEMPT_MAX_KEYS;
  let removed = 0;
  for (const key of loginAttempts.keys()) {
    loginAttempts.delete(key);
    removed += 1;
    if (removed >= overflow) break;
  }
}

function readLoginAttemptEntry(key, now) {
  const entry = loginAttempts.get(key) || {
    count: 0,
    firstAt: now,
    lockedUntil: 0,
  };
  if (entry.lockedUntil && now < entry.lockedUntil) {
    return {
      allowed: false,
      retryAfterSec: Math.ceil((entry.lockedUntil - now) / 1000),
      reason: "locked",
      entry,
      key,
    };
  }
  if (now - entry.firstAt > LOGIN_WINDOW_MS) {
    entry.count = 0;
    entry.firstAt = now;
    entry.lockedUntil = 0;
  }
  if (entry.count >= LOGIN_MAX_ATTEMPTS) {
    entry.lockedUntil = now + LOGIN_LOCK_MS;
    loginAttempts.set(key, entry);
    return {
      allowed: false,
      retryAfterSec: Math.ceil(LOGIN_LOCK_MS / 1000),
      reason: "locked",
      entry,
      key,
    };
  }
  return { allowed: true, entry, key };
}

function checkLoginRateLimit(ip, email = "") {
  pruneLoginAttempts();
  const now = Date.now();
  const keys = [loginAttemptKey("ip", ip)];
  const normalizedEmail = normalizeEmail(email);
  if (normalizedEmail) {
    keys.push(loginAttemptKey("email", normalizedEmail));
  }
  const entries = {};
  let blocked = null;
  for (const key of keys) {
    const result = readLoginAttemptEntry(key, now);
    entries[key] = result.entry;
    if (!result.allowed && !blocked) {
      blocked = result;
    }
  }
  if (blocked) {
    return {
      allowed: false,
      retryAfterSec: blocked.retryAfterSec,
      reason: blocked.reason,
      key: blocked.key,
      keys,
      entries,
    };
  }
  return {
    allowed: true,
    key: keys[0],
    keys,
    entry: entries[keys[0]],
    entries,
  };
}

function recordLoginFailure(keyOrKeys, entryOrEntries) {
  const now = Date.now();
  const keys = Array.isArray(keyOrKeys)
    ? keyOrKeys
    : [keyOrKeys || "unknown"];
  const entryMap =
    entryOrEntries &&
    typeof entryOrEntries === "object" &&
    !Array.isArray(entryOrEntries) &&
    !Object.prototype.hasOwnProperty.call(entryOrEntries, "count")
      ? entryOrEntries
      : null;
  for (const key of keys) {
    const next =
      (entryMap && entryMap[key]) ||
      (!entryMap && entryOrEntries) ||
      loginAttempts.get(key) || {
        count: 0,
        firstAt: now,
        lockedUntil: 0,
      };
    next.count += 1;
    if (next.count >= LOGIN_MAX_ATTEMPTS) {
      next.lockedUntil = now + LOGIN_LOCK_MS;
    }
    loginAttempts.set(String(key), next);
  }
}

function clearLoginAttempts(keyOrKeys) {
  const keys = Array.isArray(keyOrKeys)
    ? keyOrKeys
    : [keyOrKeys || "unknown"];
  for (const key of keys) {
    loginAttempts.delete(String(key));
  }
}

function base32Encode(buffer) {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_CHARS[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_CHARS[(value << (5 - bits)) & 31];
  }
  return output;
}

function base32Decode(input) {
  const cleaned = String(input || "")
    .toUpperCase()
    .replace(/=+$/g, "")
    .replace(/\s+/g, "");
  let bits = 0;
  let value = 0;
  const output = [];
  for (const char of cleaned) {
    const idx = BASE32_CHARS.indexOf(char);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(output);
}

function generateTotpToken(secret, counter) {
  const key = base32Decode(secret);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac("sha1", key).update(buf).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  return String(binary % 1_000_000).padStart(6, "0");
}

function generateTotpSecret() {
  return base32Encode(crypto.randomBytes(20));
}

function verifyTotpCode(secret, token, window = 1) {
  const normalizedSecret = String(secret || "")
    .replace(/\s+/g, "")
    .toUpperCase();
  const normalizedToken = String(token || "")
    .trim()
    .padStart(6, "0");
  if (!normalizedSecret || !/^\d{6}$/.test(normalizedToken)) {
    return false;
  }
  const counter = Math.floor(Date.now() / 1000 / 30);
  for (let w = -window; w <= window; w += 1) {
    if (generateTotpToken(normalizedSecret, counter + w) === normalizedToken) {
      return true;
    }
  }
  return false;
}

function getTotpUri(email, secret, issuer = "PlusPapay") {
  const normalizedSecret = String(secret || "")
    .replace(/\s+/g, "")
    .toUpperCase();
  const accountName = `${issuer}:${String(email || "admin").trim()}`;
  const encodedAccount = encodeURIComponent(accountName);
  const encodedIssuer = encodeURIComponent(issuer);
  return `otpauth://totp/${encodedAccount}?secret=${normalizedSecret}&issuer=${encodedIssuer}&algorithm=SHA1&digits=6&period=30`;
}

function storeTelegramLoginCode(challengeId, code) {
  const key = String(challengeId || "").trim();
  if (!key) return;
  tgLoginCodes.set(key, {
    code: String(code),
    exp: Date.now() + TG_CODE_TTL_MS,
    attempts: 0,
  });
}

function verifyTelegramLoginCode(challengeId, inputCode) {
  const key = String(challengeId || "").trim();
  const entry = tgLoginCodes.get(key);
  if (!entry) {
    return { ok: false, reason: "expired" };
  }
  if (Date.now() >= entry.exp) {
    tgLoginCodes.delete(key);
    return { ok: false, reason: "expired" };
  }
  entry.attempts += 1;
  if (entry.attempts > TG_CODE_MAX_ATTEMPTS) {
    tgLoginCodes.delete(key);
    return { ok: false, reason: "too_many_attempts" };
  }
  if (!safeEqualString(String(inputCode || "").trim(), entry.code)) {
    tgLoginCodes.set(key, entry);
    return { ok: false, reason: "invalid" };
  }
  tgLoginCodes.delete(key);
  return { ok: true };
}

function generateTelegramLoginCode() {
  return String(crypto.randomInt(100000, 1000000));
}

function is2faRequired(authConfig = {}, telegramSettings = {}) {
  if (authConfig.totpEnabled && authConfig.totpSecret) {
    return true;
  }
  const botToken = String(telegramSettings.bot_token || "").trim();
  const adminChatId = String(telegramSettings.admin_chat_id || "").trim();
  return Boolean(botToken && adminChatId);
}

function getAvailable2faMethods(authConfig = {}, telegramSettings = {}) {
  const methods = [];
  const totpSecret = String(authConfig.totpSecret || "").trim();
  if (authConfig.totpEnabled && totpSecret) {
    methods.push("totp");
  }
  const botToken = String(telegramSettings.bot_token || "").trim();
  const adminChatId = String(telegramSettings.admin_chat_id || "").trim();
  if (botToken && adminChatId) {
    methods.push("telegram");
  }
  return methods;
}

function resolveLogin2faMethods(authConfig = {}, telegramSettings = {}) {
  const available = getAvailable2faMethods(authConfig, telegramSettings);
  const mode = String(authConfig.login2faMode || "either")
    .trim()
    .toLowerCase();
  if (mode === "totp") {
    return available.includes("totp") ? ["totp"] : available;
  }
  if (mode === "telegram") {
    return available.includes("telegram") ? ["telegram"] : available;
  }
  return available;
}

function pickDefaultLogin2faMethod(methods = [], preferred = "") {
  const list = Array.isArray(methods) ? methods : [];
  const pref = String(preferred || "")
    .trim()
    .toLowerCase();
  if (pref && list.includes(pref)) {
    return pref;
  }
  if (list.includes("totp")) {
    return "totp";
  }
  return list[0] || "";
}

function createRequireSecondaryAuth(store, ensureStoreReady) {
  const requireSecondary =
    String(process.env.ADMIN_REQUIRE_SECONDARY || "0") === "1";
  return async function requireSecondaryAuth(req, res, next) {
    if (!requireSecondary) {
      req.secondaryAuth = { bypassed: true };
      return next();
    }
    try {
      await ensureStoreReady();
      const authConfig = await store.getAdminAuthConfig();
      if (!String(authConfig?.secondaryPasswordHash || "").trim()) {
        req.secondaryAuth = { bypassed: true };
        return next();
      }
      const token = String(req.headers["x-admin-secondary-token"] || "").trim();
      const payload = verifySecondaryToken(token);
      if (
        !payload ||
        Number(payload.sv || 0) !==
          Number(authConfig.secondaryPasswordVersion || 1)
      ) {
        return res.status(403).json({
          success: false,
          code: "secondary_required",
          message: "请先验证二级密码",
        });
      }
      req.secondaryAuth = payload;
      return next();
    } catch (error) {
      return res.status(500).json({ success: false, message: error.message });
    }
  };
}

module.exports = {
  ADMIN_TOKEN_TTL_MS,
  ADMIN_REFRESH_AFTER_MS,
  TASK_VIEWER_TOKEN_TTL_MS,
  resolveAdminTokenSecret,
  createPasswordHash,
  verifyPassword,
  issueAdminToken,
  verifyAdminToken,
  issueTaskViewerToken,
  verifyTaskViewerToken,
  issueLoginChallenge,
  verifyLoginChallenge,
  issueSecondaryToken,
  verifySecondaryToken,
  getClientMeta,
  normalizeEmail,
  checkLoginRateLimit,
  recordLoginFailure,
  clearLoginAttempts,
  generateTotpSecret,
  verifyTotpCode,
  getTotpUri,
  storeTelegramLoginCode,
  verifyTelegramLoginCode,
  generateTelegramLoginCode,
  is2faRequired,
  getAvailable2faMethods,
  resolveLogin2faMethods,
  pickDefaultLogin2faMethod,
  createRequireSecondaryAuth,
};
