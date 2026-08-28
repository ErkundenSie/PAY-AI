"use strict";

const fs = require("fs");
const { chromium } = require("playwright-extra");

describe("browser pool recovery", () => {
  let browserPool;
  let persistentContext;
  let launchPersistentContext;

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubEnv("BROWSER_POOL", "1");
    vi.stubEnv("BROWSER_POOL_SIZE", "1");
    vi.stubEnv("BROWSER_POOL_MAX_SIZE", "1");
    persistentContext = {
      close: vi.fn().mockResolvedValue(),
      pages: () => [],
    };
    vi.spyOn(fs, "mkdirSync").mockImplementation(() => {});
    vi.spyOn(chromium, "use").mockImplementation(() => {});
    launchPersistentContext = vi
      .spyOn(chromium, "launchPersistentContext")
      .mockResolvedValue(persistentContext);
    delete require.cache[require.resolve("../browser-pool")];
    browserPool = require("../browser-pool");
  });

  afterEach(async () => {
    await browserPool.shutdownBrowserPool();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("releases a slot when its task throws", async () => {
    const initialized = await browserPool.initBrowserPool();
    expect(initialized).toMatchObject({ enabled: true, size: 1 });

    await expect(
      browserPool.withBrowserSlot("job-failed", async () => {
        throw new Error("worker crashed");
      }),
    ).rejects.toThrow("worker crashed");

    expect(browserPool.getStats()).toMatchObject({ idle: 1, busy: 0, totalUses: 1 });
  });

  it("recovers when a browser slot fails during initial warm-up", async () => {
    launchPersistentContext.mockRejectedValueOnce(new Error("browser unavailable"));

    const first = await browserPool.initBrowserPool();
    expect(first).toMatchObject({ enabled: false, size: 0 });
    expect(browserPool.getStats()).toMatchObject({ initialized: false, size: 0 });

    const recovered = await browserPool.initBrowserPool();
    expect(recovered).toMatchObject({ enabled: true, size: 1 });
    expect(launchPersistentContext).toHaveBeenCalledTimes(2);
  });
});