"use strict";

const crypto = require("crypto");
const net = require("net");
const axios = require("axios");
const { ProxyAgent } = require("proxy-agent");
const {
  isXrayShareLink,
  parseShareLink,
  startXrayRelay,
} = require("./xray-relay");

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
  if (isXrayShareLink(proxyUrl)) return proxyUrl;

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

function defaultPortForProtocol(protocol) {
  const name = String(protocol || "")
    .replace(":", "")
    .toLowerCase();
  if (name === "https") return 443;
  if (name === "http") return 80;
  if (name === "socks" || name === "socks4" || name === "socks5" || name === "socks5h") {
    return 1080;
  }
  if (name === "vless" || name === "vmess" || name === "trojan") return 443;
  return 0;
}

function resolveProxyConnectEndpoint(raw) {
  const text = String(raw || "").trim();
  if (!text) return null;
  if (isXrayShareLink(text) || isXrayShareLink(normalizeProxyUrl(text))) {
    const parsed = parseShareLink(
      isXrayShareLink(text) ? text : normalizeProxyUrl(text),
    );
    const vnext = parsed.outbound?.settings?.vnext?.[0];
    const server = parsed.outbound?.settings?.servers?.[0];
    const host = String(parsed.host || vnext?.address || server?.address || "").trim();
    const port = Number(vnext?.port || server?.port || 0);
    return host && port ? { host, port } : null;
  }
  const parsed = new URL(normalizeProxyUrl(text));
  const host = String(parsed.hostname || "").trim();
  const port = Number(parsed.port || defaultPortForProtocol(parsed.protocol) || 0);
  return host && port ? { host, port } : null;
}

function probeProxyConnect(raw, options = {}) {
  const timeoutMs = Math.max(500, Number(options.timeoutMs) || 2500);
  const t0 = Date.now();
  let endpoint = null;
  try {
    endpoint = resolveProxyConnectEndpoint(raw);
  } catch (error) {
    return Promise.resolve({
      ok: false,
      error: `代理地址解析失败: ${error.message}`,
      latencyMs: 0,
    });
  }
  if (!endpoint) {
    return Promise.resolve({
      ok: false,
      error: "无法解析代理主机或端口",
      latencyMs: 0,
    });
  }
  return new Promise((resolve) => {
    let socket = null;
    let finished = false;
    const finish = (ok, error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (socket) socket.destroy();
      resolve({
        ok,
        error: ok ? "" : error || "连接失败",
        latencyMs: Date.now() - t0,
        host: endpoint.host,
        port: endpoint.port,
      });
    };
    const timer = setTimeout(() => finish(false, "连接超时"), timeoutMs);
    try {
      socket = net.connect({
        host: endpoint.host,
        port: endpoint.port,
      });
    } catch (error) {
      finish(false, error.message || "连接失败");
      return;
    }
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false, "连接超时"));
    socket.once("error", (error) => finish(false, error.message || "连接失败"));
  });
}

function parseProxyMeta(url) {
  try {
    if (isXrayShareLink(url)) {
      const parsed = parseShareLink(String(url || "").trim());
      return {
        protocol: parsed.protocol || "",
        host: parsed.host || "",
      };
    }
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

async function mapWithConcurrency(items, limit, mapper) {
  const list = Array.isArray(items) ? items : [];
  const concurrency = Math.max(1, Math.min(Number(limit) || 1, list.length || 1));
  const results = new Array(list.length);
  let cursor = 0;
  async function worker() {
    while (cursor < list.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(list[index], index);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, list.length) }, () => worker()),
  );
  return results;
}

async function testProxyUrl(raw, options = {}) {
  const proxyUrl = substituteProxySession(normalizeProxyUrl(raw));
  const t0 = Date.now();
  if (!proxyUrl) {
    return { ok: false, error: "代理 URL 为空", latencyMs: 0 };
  }

  let relayCleanup = async () => {};
  let probeProxyUrl = proxyUrl;
  try {
    if (isXrayShareLink(proxyUrl) || isXrayShareLink(String(raw || "").trim())) {
      const relay = await startXrayRelay(
        isXrayShareLink(proxyUrl) ? proxyUrl : String(raw || "").trim(),
      );
      probeProxyUrl = relay.localProxyUrl;
      relayCleanup = relay.cleanup;
    }

    let agent;
    try {
      agent = new ProxyAgent({ getProxyForUrl: () => probeProxyUrl });
    } catch (error) {
      return {
        ok: false,
        error: `代理 URL 解析失败: ${error.message}`,
        latencyMs: Date.now() - t0,
      };
    }

    const timeout = Math.max(1500, Number(options.timeoutMs) || 8000);
    const probes = PROBE_URLS.map(async (probeUrl) => {
      const response = await axios.get(probeUrl, {
        httpsAgent: agent,
        httpAgent: agent,
        proxy: false,
        timeout,
        maxRedirects: 2,
        validateStatus: () => true,
      });
      if (response.status !== 200) {
        throw new Error(`HTTP ${response.status} via ${probeUrl}`);
      }
      const ip = String(response.data || "")
        .trim()
        .split(/\s+/)[0];
      if (!ip) {
        throw new Error(`empty response via ${probeUrl}`);
      }
      return {
        ok: true,
        ip,
        latencyMs: Date.now() - t0,
        probedVia: probeUrl,
      };
    });

    try {
      return await Promise.any(probes);
    } catch (error) {
      const details = Array.isArray(error?.errors)
        ? error.errors
            .map((item) => String(item?.message || item || "").trim())
            .filter(Boolean)
            .join("; ")
        : String(error?.message || "").trim();
      return {
        ok: false,
        error: details || "未知错误",
        latencyMs: Date.now() - t0,
      };
    }
  } catch (error) {
    return {
      ok: false,
      error: String(error?.message || error || "未知错误"),
      latencyMs: Date.now() - t0,
    };
  } finally {
    await relayCleanup().catch(() => {});
  }
}

module.exports = {
  PROBE_URLS,
  substituteProxySession,
  normalizeProxyUrl,
  maskProxyUrl,
  hashProxyUrl,
  parseProxyMeta,
  normalizeProxyLines,
  mapWithConcurrency,
  testProxyUrl,
  resolveProxyConnectEndpoint,
  probeProxyConnect,
};
