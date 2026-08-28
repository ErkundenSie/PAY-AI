"use strict";

const express = require("express");
const {
  registerPublicRoutes,
  redactPublicCheckoutLog,
} = require("../routes/public");

function passthrough(_req, _res, next) {
  next();
}

function createApp(overrides = {}) {
  const app = express();
  app.use(express.json());
  const store = {
    getAdminPaths: async () => ({
      loginPath: "admin-login",
      panelPath: "admin",
      checkoutPath: "checkout",
    }),
    getPaymentRegion: async () => "PH",
    listCheckoutPlans: () => [{ key: "plus", name: "Plus" }],
    CREDIT_QUANTITY_PRESETS: [250, 500, 1000, 1500, 2000],
    CREDIT_QUANTITY_MIN: 250,
    CREDIT_QUANTITY_STEP: 250,
    getMaxConcurrentActivations: async () => 2,
    verifyCdkDetails: async (cdk) =>
      cdk === "KC-VALID"
        ? {
            type: "自助",
            plan_type: "plus",
            used_at: null,
            created_at: "2026-01-01",
          }
        : null,
    getRunningTaskByCdk: async () => null,
    listLatestTasksByCdks: async () => [],
    countQueuedForegroundTasks: async () => 0,
    refreshCdkCode: async (cdk) => ({
      old_code: cdk,
      new_code: "KC-NEWCODE123456",
      refresh_remaining: 1,
    }),
    cancelQueuedTaskByCdk: async () => ({ ok: true, job_key: "job-1" }),
    getActivationAttemptLimit: async () => null,
    getAppConfigValue: async () => "secret-key",
    importCards: async (cards) => ({ imported: cards.length }),
    getTaskStatus: async () => null,
    ...overrides.store,
  };
  registerPublicRoutes(app, {
    store,
    ensureStoreReady: async () => {},
    limitPublicRequests: () => passthrough,
    safeEqualString: (left, right) => left === right,
    buildAdminLoginUrl: (paths) => `/${paths.loginPath}`,
    buildAdminPanelUrl: (paths) => `/${paths.panelPath}`,
    buildCheckoutUrl: (paths) => `/${paths.checkoutPath}`,
    normalizeSessionToken: (raw) => String(raw || "").trim(),
    validateSessionTokenForQuery: () => ({ valid: true, email: "" }),
    querySubscriptionBySession: async () => ({ ok: true, data: {} }),
    extractEmailFromSession: () => "",
    cancelAutoRenew: async () => ({ ok: true, data: { message: "ok" } }),
    REGION_CONFIG: { PH: { label: "Philippines", currency: "PHP" } },
    startPublicCheckoutPay:
      overrides.startPublicCheckoutPay ||
      (async (body) => ({
        status: 200,
        payload: { success: true, cdk_code: body.cdk_code, card_id: body.card_id },
      })),
    resolvePublicCheckoutCdk: () => "KC-PUBLIC",
    runtimeLog: { after: () => [] },
    adminAuth: {
      verifyTaskViewerToken: () => false,
      issueTaskViewerToken: () => ({ token: "viewer" }),
    },
    TERMINAL_TASK_STATUSES: new Set(["success", "failed"]),
    getActiveForegroundJobCount: () => 1,
    publicDir: __dirname,
    getPlanTypeLabel: (plan) => (plan === "plus" ? "Plus" : plan),
    getClientIp: () => "127.0.0.1",
    getRemainingCooldownMinutes: () => 0,
    createCdks: () => ["KC-NEWCODE123456"],
    handleActivationRequest: (_req, res) =>
      res.json({ success: true, started: true }),
    ...overrides.deps,
  });
  return app;
}

async function request(app, method, url, body, headers = {}) {
  const server = app.listen(0);
  const { port } = server.address();
  try {
    const res = await fetch(`http://127.0.0.1:${port}${url}`, {
      method,
      headers: {
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch (_) {
      json = text;
    }
    return { status: res.status, json };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

describe("public routes", () => {
  it("returns checkout options", async () => {
    const app = createApp();
    const res = await request(app, "GET", "/api/public/checkout/options");
    expect(res.status).toBe(200);
    expect(res.json.success).toBe(true);
    expect(res.json.default_region).toBe("PH");
    expect(res.json.credit_min).toBe(250);
  });

  it("strips card_id from public checkout pay", async () => {
    let received = null;
    const app = createApp({
      startPublicCheckoutPay: async (body) => {
        received = body;
        return { status: 200, payload: { success: true } };
      },
    });
    const res = await request(app, "POST", "/api/public/checkout/pay", {
      session: "token",
      card_id: 99,
    });
    expect(res.status).toBe(200);
    expect(received.card_id).toBeUndefined();
    expect(received.cdk_code).toBe("KC-PUBLIC");
  });

  it("verifies an unused CDK", async () => {
    const app = createApp();
    const res = await request(app, "POST", "/api/verify-cdk", {
      cdk: "KC-VALID",
    });
    expect(res.status).toBe(200);
    expect(res.json.data).toMatchObject({
      type: "自助",
      plan_type: "plus",
      plan_label: "Plus",
    });
  });

  it("queries CDK status", async () => {
    const app = createApp();
    const res = await request(app, "GET", "/api/cdk/query?cdk=KC-VALID");
    expect(res.status).toBe(200);
    expect(res.json.data.status).toBe("未使用");
  });

  it("looks up multiple CDKs", async () => {
    const app = createApp();
    const res = await request(app, "POST", "/api/cdk/lookup", {
      codes: ["KC-VALID"],
    });
    expect(res.status).toBe(200);
    expect(res.json.tasks[0].status).toBe("未使用");
    expect(res.json.tasks[0].kind).toBe("unused");
    expect(res.json.tasks[0].found).toBe(true);
  });

  it("uses a uniform invalid message for missing CDK lookup", async () => {
    const app = createApp();
    const res = await request(app, "POST", "/api/cdk/lookup", {
      codes: ["MISSING-CODE"],
    });
    expect(res.status).toBe(200);
    expect(res.json.tasks[0]).toMatchObject({
      kind: "missing",
      found: false,
      error: "无效 CDK",
    });
  });

  it("does not distinguish missing CDK query from invalid CDK", async () => {
    const app = createApp();
    const res = await request(app, "GET", "/api/cdk/query?cdk=MISSING-CODE");
    expect(res.status).toBe(403);
    expect(res.json.message).toBe("无效 CDK");
  });

  it("returns queue count in public runtime", async () => {
    const app = createApp();
    const res = await request(app, "GET", "/api/public/runtime");
    expect(res.status).toBe(200);
    expect(res.json.runtime.queued_tasks).toBe(0);
  });
});

describe("redactPublicCheckoutLog", () => {
  it("masks card numbers and tokens", () => {
    const text = redactPublicCheckoutLog(
      'authorization: Bearer secret access_token=abc card_number=4242424242424242',
    );
    expect(text).not.toContain("secret");
    expect(text).not.toContain("4242424242424242");
    expect(text).toContain("[REDACTED]");
  });
});
