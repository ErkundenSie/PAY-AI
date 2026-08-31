"use strict";

const ProxyChain = require("proxy-chain");
const { normalizeProxyUrl } = require("./proxy-pool");
const { isXrayShareLink, startXrayRelay } = require("./xray-relay");

function maskProxyUrl(url) {
  return String(url || "").replace(/\/\/([^:@/]+):([^@/]+)@/i, "//$1:***@");
}

function isSocksProtocol(protocol) {
  const p = String(protocol || "")
    .replace(":", "")
    .toLowerCase();
  return p === "socks" || p === "socks4" || p === "socks5" || p === "socks5h";
}

function buildDirectPlaywrightProxy(parsed) {
  const server = `${parsed.protocol}//${parsed.hostname}${parsed.port ? `:${parsed.port}` : ""}`;
  const proxy = { server };
  if (parsed.username) {
    proxy.username = decodeURIComponent(parsed.username);
  }
  if (parsed.password) {
    proxy.password = decodeURIComponent(parsed.password);
  }
  return proxy;
}

/**
 * Playwright Chromium 不支持带账号密码的 SOCKS 代理，需用 proxy-chain 转成本地 HTTP 中继。
 * @param {string} proxyValue
 * @returns {Promise<{ proxyConfig: object|null, cleanup: () => Promise<void>, relayed?: boolean }>}
 */
async function preparePlaywrightProxy(proxyValue) {
  const raw = normalizeProxyUrl(proxyValue);
  if (!raw) {
    return { proxyConfig: null, cleanup: async () => {} };
  }

  if (isXrayShareLink(raw) || isXrayShareLink(String(proxyValue || "").trim())) {
    const shareLink = isXrayShareLink(raw)
      ? raw
      : String(proxyValue || "").trim();
    const relay = await startXrayRelay(shareLink);
    const inner = await preparePlaywrightProxy(relay.localProxyUrl);
    return {
      proxyConfig: inner.proxyConfig,
      relayed: true,
      cleanup: async () => {
        try {
          await inner.cleanup();
        } finally {
          await relay.cleanup();
        }
      },
    };
  }

  let parsed;
  try {
    parsed = new URL(raw);
  } catch (error) {
    console.warn(
      `[!] [系统] 代理 URL 解析失败，将按原始值使用: ${error.message}`,
    );
    return {
      proxyConfig: { server: raw },
      cleanup: async () => {},
    };
  }

  const hasAuth = Boolean(parsed.username || parsed.password);
  if (isSocksProtocol(parsed.protocol) && hasAuth) {
    const localProxyUrl = await ProxyChain.anonymizeProxy(raw);
    console.log(
      `🌐 [系统] SOCKS 认证代理已转为本地 HTTP 中继: ${maskProxyUrl(localProxyUrl)}`,
    );
    return {
      proxyConfig: { server: localProxyUrl },
      relayed: true,
      cleanup: async () => {
        await ProxyChain.closeAnonymizedProxy(localProxyUrl, true).catch(
          () => {},
        );
      },
    };
  }

  return {
    proxyConfig: buildDirectPlaywrightProxy(parsed),
    cleanup: async () => {},
  };
}

module.exports = {
  preparePlaywrightProxy,
  isSocksProtocol,
};
