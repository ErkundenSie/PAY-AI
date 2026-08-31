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

  it("reclaims a stale slot without invalidating a newer lease", async () => {
    vi.stubEnv("BROWSER_POOL_STALE_MS", "40");
    vi.stubEnv("BROWSER_POOL_STALE_SWEEP_MS", "60000");
    delete require.cache[require.resolve("../browser-pool")];
    browserPool = require("../browser-pool");
    await browserPool.initBrowserPool();

    const first = await browserPool.acquireSlot("job-old");
    expect(first.leaseId).toBeGreaterThan(0);
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(browserPool.reclaimStaleSlots()).toBe(1);
    const second = await browserPool.acquireSlot("job-new");
    expect(second.slotId).toBe(first.slotId);
    expect(second.leaseId).not.toBe(first.leaseId);

    expect(browserPool.releaseSlot(first.slotId, first.leaseId)).toBe(false);
    expect(browserPool.getStats()).toMatchObject({ idle: 0, busy: 1 });
    expect(browserPool.releaseSlot(second.slotId, second.leaseId)).toBe(true);
    expect(browserPool.getStats()).toMatchObject({ idle: 1, busy: 0 });
  });

  it("keeps a busy slot when the job is still heartbeating", async () => {
    vi.stubEnv("BROWSER_POOL_STALE_MS", "200");
    vi.stubEnv("BROWSER_POOL_STALE_SWEEP_MS", "60000");
    delete require.cache[require.resolve("../browser-pool")];
    browserPool = require("../browser-pool");
    await browserPool.initBrowserPool();

    await browserPool.acquireSlot("job-live");
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(browserPool.touchJob("job-live")).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(browserPool.reclaimStaleSlots()).toBe(0);
    expect(browserPool.getStats()).toMatchObject({ busy: 1, idle: 0 });
    expect(browserPool.releaseSlotByJobKey("job-live")).toBe(true);
    expect(browserPool.getStats()).toMatchObject({ busy: 0, idle: 1 });
  });

  it("rejects waiters on acquire timeout without leaking the queue", async () => {
    vi.stubEnv("BROWSER_POOL_ACQUIRE_TIMEOUT_MS", "30");
    delete require.cache[require.resolve("../browser-pool")];
    browserPool = require("../browser-pool");
    await browserPool.initBrowserPool();

    await browserPool.acquireSlot("job-hold");
    await expect(browserPool.acquireSlot("job-wait")).rejects.toThrow(/繁忙/);
    expect(browserPool.getStats()).toMatchObject({ busy: 1, waiting: 0 });
  });
});