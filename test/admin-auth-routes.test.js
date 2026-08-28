"use strict";

const express = require("express");
const {
  registerAdminLoginRoutes,
  registerAdminSecurityRoutes,
} = require("../routes/admin-auth");

function passthrough(_req, _res, next) {
  next();
}

function authenticateTestAdmin(req, res, next) {
  const cookie = String(req.headers.cookie || "");
  if (!/(?:^|;\s*)oai_admin_session=(?:admin-token|refreshed)(?:;|$)/.test(cookie)) {
    return res.status(401).json({ success: false, message: "未登录" });
  }
  req.admin = {
    pv: 1,
    email: "admin@example.com",
    iat: Date.now(),
    exp: Date.now() + 60_000,
    permissions: [],
  };
  next();
}

function createLoginApp(overrides = {}) {
  const app = express();
  app.use(express.json());
  const store = {
    getAdminAuthConfig: async () => ({
      email: "admin@example.com",
      passwordHash: "hashed",
      passwordVersion: 1,
      totpEnabled: false,
      totpSecret: "",
      login2faMode: "either",
      secondaryPasswordHash: "secondary",
      secondaryPasswordVersion: 1,
      notifyAdminLogin: false,
    }),
    getTelegramConfig: async () => ({}),
    getAdminPaths: async () => ({
      loginPath: "admin-login",
      panelPath: "admin",
      checkoutPath: "checkout",
    }),
    saveAdminPaths: async (paths) => paths,
    saveAdmin2faLoginMode: async (mode) => mode,
    saveAdminTotpConfig: async () => {},
    updateAdminSecondaryPassword: async () => {},
    listAdminLoginLogs: async () => ({ logs: [] }),
    ...overrides.store,
  };
  const adminAuth = {
    normalizeEmail: (email) => String(email || "").trim().toLowerCase(),
    getClientMeta: () => ({
      ip: "127.0.0.1",
      fingerprint: "fp",
      userAgent: "test",
    }),
    checkLoginRateLimit: () => ({ allowed: true, key: "ip", entry: {} }),
    recordLoginFailure: () => {},
    clearLoginAttempts: () => {},
    resolveLogin2faMethods: () => [],
    is2faRequired: () => false,
    issueLoginChallenge: () => ({
      token: "challenge",
      payload: { exp: Date.now() + 1000 },
    }),
    verifyLoginChallenge: (token) =>
      token === "challenge"
        ? { cid: "c1", email: "admin@example.com", ip: "127.0.0.1" }
        : null,
    generateTelegramLoginCode: () => "123456",
    storeTelegramLoginCode: () => {},
    verifyTelegramLoginCode: () => ({ ok: true }),
    verifyTotpCode: () => true,
    pickDefaultLogin2faMethod: () => "totp",
    generateTotpSecret: () => "SECRET",
    getTotpUri: () => "otpauth://totp/test",
    getAvailable2faMethods: () => [],
    verifySecondaryToken: (token) =>
      token === "ok" ? { exp: Date.now() + 1000 } : null,
    issueSecondaryToken: () => ({
      token: "secondary",
      payload: { exp: Date.now() + 1000 },
    }),
    ...overrides.adminAuth,
  };
  registerAdminLoginRoutes(app, {
    adminAuth,
    store,
    ensureStoreReady: async () => {},
    verifyPassword: (password) => password === "correct-password",
    issueAdminToken: () => ({
      token: "admin-token",
      payload: { exp: Date.now() + 60_000, iat: Date.now(), permissions: [] },
    }),
    logAdminSecurityEvent: async () => {},
    fireAdminSecurityNotification: () => {},
    sendTelegramLoginCode: async () => ({ ok: true }),
    attachAdminPaths: async (payload) => ({
      ...payload,
      loginPath: "/admin-login",
    }),
  });
  app.use("/api/admin", authenticateTestAdmin);
  registerAdminSecurityRoutes(app, {
    adminAuth,
    store,
    ensureStoreReady: async () => {},
    verifyPassword: (password) =>
      password === "correct-password" || password === "secondary-password",
    issueAdminToken: () => ({
      token: "refreshed",
      payload: { exp: Date.now() + 60_000, iat: Date.now(), permissions: [] },
    }),
    logAdminSecurityEvent: async () => {},
    fireAdminSecurityNotification: () => {},
    attachAdminPaths: async (payload) => payload,
    invalidateAdminPathsCache: () => {},
    setCachedAdminPaths: () => {},
    buildAdminLoginUrl: (paths) => `/${paths.loginPath}`,
    buildAdminPanelUrl: (paths) => `/${paths.panelPath}`,
    buildCheckoutUrl: (paths) => `/${paths.checkoutPath}`,
    ADMIN_REFRESH_AFTER_MS: 60 * 60 * 1000,
    authenticateAdmin: authenticateTestAdmin,
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
    return { status: res.status, json, setCookie: res.headers.get("set-cookie") || "" };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

describe("admin login routes", () => {
  it("hides default admin HTML paths", async () => {
    const app = createLoginApp();
    const res = await request(app, "GET", "/admin");
    expect(res.status).toBe(404);
  });

  it("rejects empty login credentials", async () => {
    const app = createLoginApp();
    const res = await request(app, "POST", "/api/admin/login", {});
    expect(res.status).toBe(400);
  });

  it("issues an HttpOnly session cookie when 2FA is not required", async () => {
    const app = createLoginApp();
    const res = await request(app, "POST", "/api/admin/login", {
      email: "admin@example.com",
      password: "correct-password",
    });
    expect(res.status).toBe(200);
    expect(res.json.success).toBe(true);
    expect(res.json.token).toBeUndefined();
    expect(res.setCookie).toContain("oai_admin_session=admin-token");
    expect(res.setCookie).toContain("HttpOnly");
    expect(res.setCookie).toContain("SameSite=Strict");
    expect(res.json.requires2fa).toBe(false);
  });

  it("uses the session cookie for authenticated requests and clears it on logout", async () => {
    const app = createLoginApp();
    const login = await request(app, "POST", "/api/admin/login", {
      email: "admin@example.com",
      password: "correct-password",
    });
    const cookie = login.setCookie.split(";")[0];

    const session = await request(
      app,
      "GET",
      "/api/admin/session",
      undefined,
      { Cookie: cookie },
    );
    expect(session.status).toBe(200);
    expect(session.json).toMatchObject({
      success: true,
      email: "admin@example.com",
      refreshed: false,
    });
    expect(session.json.token).toBeUndefined();

    const logout = await request(
      app,
      "POST",
      "/api/admin/logout",
      undefined,
      { Cookie: cookie },
    );
    expect(logout.status).toBe(200);
    expect(logout.setCookie).toContain("oai_admin_session=");
    expect(logout.setCookie).toContain("Max-Age=0");

    const unauthenticated = await request(app, "GET", "/api/admin/session");
    expect(unauthenticated.status).toBe(401);
  });

  it("rejects a wrong password", async () => {
    const app = createLoginApp();
    const res = await request(app, "POST", "/api/admin/login", {
      email: "admin@example.com",
      password: "wrong",
    });
    expect(res.status).toBe(401);
  });
});

describe("admin security routes", () => {
  it("saves custom admin paths", async () => {
    const app = createLoginApp();
    const login = await request(app, "POST", "/api/admin/login", {
      email: "admin@example.com",
      password: "correct-password",
    });
    const res = await request(
      app,
      "POST",
      "/api/admin/security/paths",
      {
        loginPath: "secure-login",
        panelPath: "secure-panel",
        checkoutPath: "pay",
      },
      { Cookie: login.setCookie.split(";")[0] },
    );
    expect(res.status).toBe(200);
    expect(res.json.loginUrl).toBe("/secure-login");
    expect(res.json.panelUrl).toBe("/secure-panel");
    expect(res.json.checkoutUrl).toBe("/pay");
  });

  it("reports an unverified secondary session", async () => {
    const app = createLoginApp();
    const login = await request(app, "POST", "/api/admin/login", {
      email: "admin@example.com",
      password: "correct-password",
    });
    const res = await request(
      app,
      "GET",
      "/api/admin/secondary/session",
      undefined,
      { Cookie: login.setCookie.split(";")[0] },
    );
    expect(res.json).toMatchObject({ success: true, verified: false });
  });
});
