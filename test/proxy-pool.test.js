"use strict";

const net = require("net");
const axios = require("axios");
const {
  testProxyUrl,
  mapWithConcurrency,
  normalizeProxyUrl,
  parseProxyMeta,
  probeProxyConnect,
  resolveProxyConnectEndpoint,
} = require("../proxy-pool");
const { isXrayShareLink, parseShareLink } = require("../xray-relay");

describe("testProxyUrl", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the first successful probe without waiting for the other", async () => {
    vi.spyOn(axios, "get").mockImplementation((url) => {
      if (String(url).includes("ipify")) {
        return Promise.resolve({ status: 200, data: "1.2.3.4\n" });
      }
      return new Promise(() => {});
    });

    const result = await testProxyUrl("http://user:pass@proxy.example:8080");
    expect(result).toMatchObject({ ok: true, ip: "1.2.3.4" });
    expect(axios.get).toHaveBeenCalledTimes(2);
  });

  it("fails after parallel probes miss", async () => {
    vi.spyOn(axios, "get").mockResolvedValue({ status: 500, data: "nope" });
    const result = await testProxyUrl("socks5://127.0.0.1:1080", {
      timeoutMs: 1500,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/HTTP 500/);
  });
});

describe("probeProxyConnect", () => {
  it("resolves http proxy host and port", () => {
    expect(
      resolveProxyConnectEndpoint("http://user:pass@proxy.example:8080"),
    ).toEqual({ host: "proxy.example", port: 8080 });
  });

  it("connects to an open TCP port", async () => {
    const server = net.createServer((socket) => socket.end());
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    try {
      const result = await probeProxyConnect(`http://127.0.0.1:${port}`, {
        timeoutMs: 800,
      });
      expect(result.ok).toBe(true);
      expect(result.port).toBe(port);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("fails when the port is closed", async () => {
    const result = await probeProxyConnect("http://127.0.0.1:1", {
      timeoutMs: 800,
    });
    expect(result.ok).toBe(false);
  });

  it("covers hanging connects with an overall timeout", async () => {
    const started = Date.now();
    const result = await probeProxyConnect("http://192.0.2.1:81", {
      timeoutMs: 600,
    });
    expect(result.ok).toBe(false);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe("mapWithConcurrency", () => {
  it("caps parallel work", async () => {
    let active = 0;
    let maxActive = 0;
    const results = await mapWithConcurrency([1, 2, 3, 4], 2, async (value) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 15));
      active -= 1;
      return value * 2;
    });
    expect(results).toEqual([2, 4, 6, 8]);
    expect(maxActive).toBeLessThanOrEqual(2);
  });
});

describe("xray share links", () => {
  const vless =
    "vless://550e8400-e29b-41d4-a716-446655440000@example.com:443?encryption=none&security=reality&type=tcp&flow=xtls-rprx-vision&pbk=PUBLIC&sid=ab&sni=www.example.com&fp=chrome#note";

  it("keeps vless UUID intact", () => {
    expect(isXrayShareLink(vless)).toBe(true);
    expect(normalizeProxyUrl(vless)).toBe(
      "vless://550e8400-e29b-41d4-a716-446655440000@example.com:443?encryption=none&security=reality&type=tcp&flow=xtls-rprx-vision&pbk=PUBLIC&sid=ab&sni=www.example.com&fp=chrome",
    );
    expect(parseProxyMeta(vless)).toEqual({
      protocol: "vless",
      host: "example.com",
    });
  });

  it("parses vless reality outbound", () => {
    const parsed = parseShareLink(vless);
    expect(parsed.outbound.protocol).toBe("vless");
    expect(parsed.outbound.settings.vnext[0].users[0].id).toBe(
      "550e8400-e29b-41d4-a716-446655440000",
    );
    expect(parsed.outbound.streamSettings.security).toBe("reality");
    expect(parsed.outbound.streamSettings.realitySettings.publicKey).toBe(
      "PUBLIC",
    );
  });
});
