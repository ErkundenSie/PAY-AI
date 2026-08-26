"use strict";

const crypto = require("crypto");
const axios = require("axios");
const { ProxyAgent } = require("proxy-agent");

const PROBE_URLS = [
  "https://api.ipify.org/?format=text",
  "https://ifconfig.me/ip",
];

function substituteProxySession(rawProxy) {
  if (!rawProxy) {
    return rawProxy;
  }
  if (!/\{session\}/i.test(rawProxy)) {
    return rawProxy;
  }
  const sid = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  return rawProxy.replace(/\{session\}/gi, sid);
}

function normalizeProxyUrl(rawProxy) {
  let proxyUrl = String(rawProxy || "").trim();
  if (!proxyUrl) return "";

  const labelIndex = proxyUrl.indexOf("#");
  if (labelIndex >= 0) {
    proxyUrl = proxyUrl.slice(0, labelIndex).trim();
  }

  proxyUrl = proxyUrl.replace(/^socks:\/\//i, "socks5://");

  try {
    const parsed = new URL(proxyUrl);
    const packedCredentials = decodeURIComponent(parsed.username || "");
    if (!packedCredentials || parsed.password) return proxyUrl;

    const base64 = packedCredentials.replace(/-/g, "+").replace(/_/g, "/");
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) return proxyUrl;

    const decoded = Buffer.from(base64, "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    if (separator <= 0 || separator === decoded.length - 1) return proxyUrl;

    const username = decoded.slice(0, separator);
    const password = decoded.slice(separator + 1);
    if (/[^\x20-\x7E]/.test(username) || /[^\x20-\x7E]/.test(password)) {
      return proxyUrl;
    }

    return `${parsed.protocol}//${encodeURIComponent(username)}:${encodeURIComponent(password)}@${parsed.host}`;
  } catch (_) {
    return proxyUrl;
  }
}

function maskProxyUrl(url) {
  return String(url || "").replace(/\/\/([^:@/]+):([^@/]+)@/i, "//$1:***@");
}

function hashProxyUrl(url) {
  return crypto
    .createHash("sha256")
    .update(String(url || "").trim())
    .digest("hex");
}

function parseProxyMeta(url) {
  try {
    const parsed = new URL(normalizeProxyUrl(url));
    return {
      protocol: String(parsed.protocol || "")
        .replace(":", "")
        .toLowerCase(),
      host: parsed.hostname || "",
    };
  } catch (_) {
    return { protocol: "", host: "" };
  }
}

function normalizeProxyLines(input) {
  const lines = Array.isArray(input)
    ? input
    : String(input || "").split(/\r?\n/);
  return [...new Set(lines.map(normalizeProxyUrl).filter(Boolean))];
}

async function testProxyUrl(raw, options = {}) {
  const proxyUrl = substituteProxySession(normalizeProxyUrl(raw));
  const t0 = Date.now();
  if (!proxyUrl) {
    return { ok: false, error: "代理 URL 为空", latencyMs: 0 };
  }

  let agent;
  try {
    agent = new ProxyAgent({ getProxyForUrl: () => proxyUrl });
  } catch (error) {
    return {
      ok: false,
      error: `代理 URL 解析失败: ${error.message}`,
      latencyMs: Date.now() - t0,
    };
  }

  const timeout = Math.max(3000, Number(options.timeoutMs) || 12000);
  let lastErr = "";
  for (const probeUrl of PROBE_URLS) {
    try {
      const response = await axios.get(probeUrl, {
        httpsAgent: agent,
        httpAgent: agent,
        proxy: false,
        timeout,
        validateStatus: () => true,
      });
      if (response.status === 200) {
        const ip = String(response.data || "")
          .trim()
          .split(/\s+/)[0];
        return {
          ok: true,
          ip,
          latencyMs: Date.now() - t0,
          probedVia: probeUrl,
        };
      }
      lastErr = `HTTP ${response.status} via ${probeUrl}`;
    } catch (error) {
      lastErr = `${error.code || ""} ${error.message}`.trim();
    }
  }

  return {
    ok: false,
    error: lastErr || "未知错误",
    latencyMs: Date.now() - t0,
  };
}

module.exports = {
  PROBE_URLS,
  substituteProxySession,
  normalizeProxyUrl,
  maskProxyUrl,
  hashProxyUrl,
  parseProxyMeta,
  normalizeProxyLines,
  testProxyUrl,
};
