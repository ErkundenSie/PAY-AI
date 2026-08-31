"use strict";

const fs = require("fs");
const os = require("os");
const net = require("net");
const path = require("path");
const { spawn, execFileSync } = require("child_process");

const XRAY_SHARE_RE = /^(vless|vmess|trojan|ss):\/\//i;

function isXrayShareLink(raw) {
  return XRAY_SHARE_RE.test(String(raw || "").trim());
}

function decodeBase64Json(raw) {
  const text = String(raw || "")
    .trim()
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  const padded = text + "=".repeat((4 - (text.length % 4)) % 4);
  return Buffer.from(padded, "base64").toString("utf8");
}

function queryFlag(params, key) {
  const value = String(params.get(key) || "").trim();
  return value === "1" || value.toLowerCase() === "true";
}

function buildStreamSettings({
  network,
  security,
  sni,
  fingerprint,
  alpn,
  allowInsecure,
  path,
  host,
  serviceName,
  publicKey,
  shortId,
  spiderX,
  headerType,
}) {
  const stream = {
    network: network || "tcp",
  };
  if (network === "ws") {
    stream.wsSettings = {
      path: path || "/",
      headers: host ? { Host: host } : {},
    };
  } else if (network === "grpc") {
    stream.grpcSettings = {
      serviceName: serviceName || "",
    };
  } else if (network === "httpupgrade") {
    stream.httpupgradeSettings = {
      path: path || "/",
      host: host || "",
    };
  } else if (headerType && headerType !== "none") {
    stream.tcpSettings = {
      header: { type: headerType },
    };
  }

  if (security === "tls") {
    stream.security = "tls";
    stream.tlsSettings = {
      serverName: sni || host || "",
      allowInsecure: Boolean(allowInsecure),
    };
    if (fingerprint) stream.tlsSettings.fingerprint = fingerprint;
    if (alpn.length) stream.tlsSettings.alpn = alpn;
  } else if (security === "reality") {
    stream.security = "reality";
    stream.realitySettings = {
      serverName: sni || "",
      fingerprint: fingerprint || "chrome",
      publicKey: publicKey || "",
      shortId: shortId || "",
      spiderX: spiderX || "/",
    };
  } else {
    stream.security = "none";
  }
  return stream;
}

function parseVless(raw) {
  const url = new URL(raw);
  const uuid = decodeURIComponent(url.username || "").trim();
  if (!uuid) throw new Error("VLESS 缺少 UUID");
  const q = url.searchParams;
  const network = String(q.get("type") || "tcp").toLowerCase();
  const security = String(q.get("security") || "none").toLowerCase();
  const flow = String(q.get("flow") || "").trim();
  const outbound = {
    protocol: "vless",
    settings: {
      vnext: [
        {
          address: url.hostname,
          port: Number(url.port || 443),
          users: [
            {
              id: uuid,
              encryption: String(q.get("encryption") || "none"),
              flow,
            },
          ],
        },
      ],
    },
    streamSettings: buildStreamSettings({
      network,
      security,
      sni: q.get("sni") || "",
      fingerprint: q.get("fp") || "",
      alpn: String(q.get("alpn") || "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
      allowInsecure: queryFlag(q, "allowInsecure") || queryFlag(q, "insecure"),
      path: q.get("path") || "/",
      host: q.get("host") || "",
      serviceName: q.get("serviceName") || q.get("servicename") || "",
      publicKey: q.get("pbk") || "",
      shortId: q.get("sid") || "",
      spiderX: q.get("spx") || "/",
      headerType: q.get("headerType") || "",
    }),
  };
  return { protocol: "vless", host: url.hostname, outbound };
}

function parseVmess(raw) {
  const encoded = String(raw || "").replace(/^vmess:\/\//i, "").split("#")[0];
  const data = JSON.parse(decodeBase64Json(encoded));
  const network = String(data.net || "tcp").toLowerCase();
  const tls = String(data.tls || "").toLowerCase();
  const security = tls === "tls" || tls === "reality" ? tls : "none";
  const outbound = {
    protocol: "vmess",
    settings: {
      vnext: [
        {
          address: data.add || data.host || "",
          port: Number(data.port || 443),
          users: [
            {
              id: data.id,
              alterId: Number(data.aid || 0),
              security: data.scy || "auto",
            },
          ],
        },
      ],
    },
    streamSettings: buildStreamSettings({
      network,
      security,
      sni: data.sni || data.host || "",
      fingerprint: data.fp || "",
      alpn: String(data.alpn || "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
      allowInsecure: String(data.allowInsecure || "") === "1",
      path: data.path || "/",
      host: data.host || "",
      serviceName: data.path || "",
      publicKey: data.pbk || "",
      shortId: data.sid || "",
      spiderX: data.spx || "/",
      headerType: data.type || "",
    }),
  };
  return { protocol: "vmess", host: data.add || data.host || "", outbound };
}

function parseTrojan(raw) {
  const url = new URL(raw);
  const password = decodeURIComponent(url.username || "").trim();
  if (!password) throw new Error("Trojan 缺少密码");
  const q = url.searchParams;
  const network = String(q.get("type") || "tcp").toLowerCase();
  const security = String(q.get("security") || "tls").toLowerCase();
  const outbound = {
    protocol: "trojan",
    settings: {
      servers: [
        {
          address: url.hostname,
          port: Number(url.port || 443),
          password,
        },
      ],
    },
    streamSettings: buildStreamSettings({
      network,
      security: security === "none" ? "tls" : security,
      sni: q.get("sni") || q.get("peer") || "",
      fingerprint: q.get("fp") || "",
      alpn: String(q.get("alpn") || "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
      allowInsecure: queryFlag(q, "allowInsecure") || queryFlag(q, "insecure"),
      path: q.get("path") || "/",
      host: q.get("host") || "",
      serviceName: q.get("serviceName") || "",
      publicKey: q.get("pbk") || "",
      shortId: q.get("sid") || "",
      spiderX: q.get("spx") || "/",
      headerType: q.get("headerType") || "",
    }),
  };
  return { protocol: "trojan", host: url.hostname, outbound };
}

function parseShadowsocks(raw) {
  let body = String(raw || "").replace(/^ss:\/\//i, "").split("#")[0];
  let method = "";
  let password = "";
  let host = "";
  let port = 0;
  try {
    const url = new URL(`ss://${body}`);
    if (url.hostname && url.username) {
      method = decodeURIComponent(url.username);
      password = decodeURIComponent(url.password || "");
      host = url.hostname;
      port = Number(url.port || 0);
    }
  } catch (_) {
    /* fall through */
  }
  if (!host) {
    const decoded = decodeBase64Json(body);
    const at = decoded.lastIndexOf("@");
    if (at < 0) throw new Error("Shadowsocks 链接无效");
    const [user, server] = [decoded.slice(0, at), decoded.slice(at + 1)];
    const colon = user.indexOf(":");
    method = user.slice(0, colon);
    password = user.slice(colon + 1);
    const [hostname, portText] = server.split(":");
    host = hostname;
    port = Number(portText || 0);
  }
  if (!method || !password || !host || !port) {
    throw new Error("Shadowsocks 链接缺少必要字段");
  }
  return {
    protocol: "ss",
    host,
    outbound: {
      protocol: "shadowsocks",
      settings: {
        servers: [{ address: host, port, method, password }],
      },
    },
  };
}

function parseShareLink(raw) {
  const link = String(raw || "").trim();
  if (/^vless:\/\//i.test(link)) return parseVless(link);
  if (/^vmess:\/\//i.test(link)) return parseVmess(link);
  if (/^trojan:\/\//i.test(link)) return parseTrojan(link);
  if (/^ss:\/\//i.test(link)) return parseShadowsocks(link);
  throw new Error("不支持的分享链接");
}

function resolveXrayBin() {
  if (process.env.XRAY_BIN && fs.existsSync(process.env.XRAY_BIN)) {
    return process.env.XRAY_BIN;
  }
  const name = process.platform === "win32" ? "xray.exe" : "xray";
  const candidates = [
    path.join(__dirname, "bin", name),
    `/usr/local/bin/${name}`,
    `/usr/bin/${name}`,
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  try {
    const which = process.platform === "win32" ? "where" : "which";
    const found = execFileSync(which, [name], { encoding: "utf8" })
      .split(/\r?\n/)
      .map((item) => item.trim())
      .find(Boolean);
    if (found && fs.existsSync(found)) return found;
  } catch (_) {
    /* ignore */
  }
  return "";
}

function allocateLocalPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = address && address.port;
      server.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
    server.on("error", reject);
  });
}

function waitForLocalPort(port, timeoutMs = 8000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const socket = net.connect({ host: "127.0.0.1", port }, () => {
        socket.end();
        resolve();
      });
      socket.on("error", () => {
        socket.destroy();
        if (Date.now() - started >= timeoutMs) {
          reject(new Error("Xray 本地入口未就绪"));
          return;
        }
        setTimeout(tryOnce, 120);
      });
    };
    tryOnce();
  });
}

function buildXrayConfig(outbound, port) {
  return {
    log: { loglevel: "warning" },
    inbounds: [
      {
        tag: "socks-in",
        listen: "127.0.0.1",
        port,
        protocol: "socks",
        settings: { udp: true, auth: "noauth" },
      },
    ],
    outbounds: [
      { tag: "proxy", ...outbound },
      { tag: "direct", protocol: "freedom" },
      { tag: "block", protocol: "blackhole" },
    ],
  };
}

async function startXrayRelay(raw) {
  const link = String(raw || "").trim();
  if (!isXrayShareLink(link)) {
    return null;
  }
  const bin = resolveXrayBin();
  if (!bin) {
    throw new Error(
      "未找到 Xray 内核。VLESS/VMess/Trojan 需要安装 xray-core，或设置 XRAY_BIN",
    );
  }
  const parsed = parseShareLink(link);
  const port = await allocateLocalPort();
  const config = buildXrayConfig(parsed.outbound, port);
  const configPath = path.join(
    os.tmpdir(),
    `kc-xray-${process.pid}-${Date.now()}-${port}.json`,
  );
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

  const child = spawn(bin, ["run", "-c", configPath], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stderr = "";
  const onLog = (chunk) => {
    stderr += String(chunk);
    if (stderr.length > 4000) stderr = stderr.slice(-4000);
  };
  child.stderr.on("data", onLog);
  child.stdout.on("data", onLog);

  const cleanup = async () => {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
      }, 800).unref?.();
    }
    try {
      fs.unlinkSync(configPath);
    } catch (_) {
      /* ignore */
    }
  };

  try {
    await Promise.race([
      waitForLocalPort(port),
      new Promise((_, reject) => {
        child.once("exit", (code) => {
          reject(
            new Error(
              `Xray 退出 code=${code}${stderr ? `: ${stderr.trim().slice(0, 180)}` : ""}`,
            ),
          );
        });
      }),
    ]);
  } catch (error) {
    await cleanup();
    throw error;
  }

  return {
    protocol: parsed.protocol,
    host: parsed.host,
    localProxyUrl: `socks5://127.0.0.1:${port}`,
    cleanup,
  };
}

module.exports = {
  isXrayShareLink,
  parseShareLink,
  resolveXrayBin,
  startXrayRelay,
};
