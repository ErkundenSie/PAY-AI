"use strict";

const axios = require("axios");
const { testProxyUrl, mapWithConcurrency } = require("../proxy-pool");

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
