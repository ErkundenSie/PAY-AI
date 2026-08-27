"use strict";

function registerAdminLoginRoutes(app, deps) {
  const {
    adminAuth,
    store,
    ensureStoreReady,
    verifyPassword,
    issueAdminToken,
    logAdminSecurityEvent,
    fireAdminSecurityNotification,
    sendTelegramLoginCode,
    attachAdminPaths,
  } = deps;

  app.get("/admin", (req, res) => {
    res.status(404).type("text/plain").send("Not Found");
  });

  app.get(["/admin-login", "/admin-login/", "/admin-login.html"], (req, res) => {
    res.status(404).type("text/plain").send("Not Found");
  });

  app.post("/api/admin/login", async (req, res) => {
    const email = adminAuth.normalizeEmail(req.body?.email);
    const password = String(req.body?.password || "");
    const clientMeta = adminAuth.getClientMeta(req);

    if (!email || !password) {
      return res
        .status(400)
        .json({ success: false, message: "请输入管理员邮箱和密码" });
    }

    const rate = adminAuth.checkLoginRateLimit(clientMeta.ip);
    if (!rate.allowed) {
      return res.status(429).json({
        success: false,
        message: `登录尝试过多，请 ${rate.retryAfterSec} 秒后再试`,
      });
    }

    try {
      await ensureStoreReady();
      const authConfig = await store.getAdminAuthConfig();
      const telegramSettings = await store.getTelegramConfig();
      const emailOk = email === adminAuth.normalizeEmail(authConfig.email);
      const passwordOk = verifyPassword(password, authConfig.passwordHash);

      if (!emailOk || !passwordOk) {
        adminAuth.recordLoginFailure(rate.key, rate.entry);
        await logAdminSecurityEvent("login_failed", {
          ...clientMeta,
          email,
          detail: "邮箱或密码错误",
        });
        fireAdminSecurityNotification("admin_login_failed", {
          email,
          ip: clientMeta.ip,
          fingerprint: clientMeta.fingerprint,
          userAgent: clientMeta.userAgent,
          message: "邮箱或密码错误",
        });
        return res
          .status(401)
          .json({ success: false, message: "邮箱或密码错误" });
      }

      adminAuth.clearLoginAttempts(rate.key);

      const methods = adminAuth.resolveLogin2faMethods(
        authConfig,
        telegramSettings,
      );
      if (!adminAuth.is2faRequired(authConfig, telegramSettings)) {
        const { token, payload } = issueAdminToken(
          authConfig.passwordVersion,
          authConfig.email,
        );
        await logAdminSecurityEvent("login_success", {
          ...clientMeta,
          email: authConfig.email,
          detail: "密码登录（未启用二次验证）",
        });
        fireAdminSecurityNotification("admin_login_success", {
          email: authConfig.email,
          ip: clientMeta.ip,
          fingerprint: clientMeta.fingerprint,
          userAgent: clientMeta.userAgent,
          method: "password_only",
          message: "后台登录成功（尚未启用 2FA）",
        });
        return res.json(
          await attachAdminPaths({
            success: true,
            token,
            expiresAt: payload.exp,
            issuedAt: payload.iat,
            permissions: payload.permissions,
            email: authConfig.email,
            requires2fa: false,
            setupRequired: true,
          }),
        );
      }

      const challenge = adminAuth.issueLoginChallenge({
        email: authConfig.email,
        passwordVersion: authConfig.passwordVersion,
        ip: clientMeta.ip,
        fingerprint: clientMeta.fingerprint,
      });

      return res.json({
        success: true,
        requires2fa: true,
        challengeToken: challenge.token,
        methods,
        defaultMethod: adminAuth.pickDefaultLogin2faMethod(
          methods,
          authConfig.login2faMode === "either" ? "" : authConfig.login2faMode,
        ),
        login2faMode: authConfig.login2faMode,
        email: authConfig.email,
        expiresAt: challenge.payload.exp,
      });
    } catch (error) {
      return res.status(500).json({ success: false, message: error.message });
    }
  });

  app.post("/api/admin/login/send-tg-code", async (req, res) => {
    const challengeToken = String(req.body?.challengeToken || "").trim();
    const challenge = adminAuth.verifyLoginChallenge(challengeToken);
    if (!challenge) {
      return res
        .status(401)
        .json({ success: false, message: "登录会话已过期，请重新登录" });
    }

    try {
      await ensureStoreReady();
      const code = adminAuth.generateTelegramLoginCode();
      adminAuth.storeTelegramLoginCode(challenge.cid, code);
      const clientMeta = adminAuth.getClientMeta(req);
      const sendResult = await sendTelegramLoginCode(store, code, {
        email: challenge.email,
        ip: clientMeta.ip || challenge.ip,
      });
      if (!sendResult.ok) {
        return res.status(400).json({
          success: false,
          message: sendResult.error || "Telegram 验证码发送失败",
        });
      }
      return res.json({
        success: true,
        message: "验证码已发送到管理员 Telegram",
      });
    } catch (error) {
      return res.status(500).json({ success: false, message: error.message });
    }
  });

  app.post("/api/admin/login/verify-2fa", async (req, res) => {
    const challengeToken = String(req.body?.challengeToken || "").trim();
    const method = String(req.body?.method || "")
      .trim()
      .toLowerCase();
    const code = String(req.body?.code || "").trim();
    const clientMeta = adminAuth.getClientMeta(req);
    const challenge = adminAuth.verifyLoginChallenge(challengeToken);

    if (!challenge) {
      return res
        .status(401)
        .json({ success: false, message: "登录会话已过期，请重新登录" });
    }

    if (!code) {
      return res.status(400).json({ success: false, message: "请输入验证码" });
    }

    const rate = adminAuth.checkLoginRateLimit(`${clientMeta.ip}:2fa`);
    if (!rate.allowed) {
      return res.status(429).json({
        success: false,
        message: `验证尝试过多，请 ${rate.retryAfterSec} 秒后再试`,
      });
    }

    try {
      await ensureStoreReady();
      const authConfig = await store.getAdminAuthConfig();
      const telegramSettings = await store.getTelegramConfig();
      const methods = adminAuth.resolveLogin2faMethods(
        authConfig,
        telegramSettings,
      );
      if (!methods.includes(method)) {
        return res
          .status(400)
          .json({ success: false, message: "不支持的验证方式" });
      }

      let verified = false;
      if (method === "totp") {
        verified = adminAuth.verifyTotpCode(authConfig.totpSecret, code);
      } else if (method === "telegram") {
        const tgResult = adminAuth.verifyTelegramLoginCode(challenge.cid, code);
        verified = tgResult.ok;
        if (!verified) {
          adminAuth.recordLoginFailure(rate.key, rate.entry);
          await logAdminSecurityEvent("2fa_failed", {
            ...clientMeta,
            email: challenge.email,
            detail: `Telegram 验证码错误 (${tgResult.reason || "invalid"})`,
          });
          fireAdminSecurityNotification("admin_2fa_failed", {
            email: challenge.email,
            ip: clientMeta.ip,
            fingerprint: clientMeta.fingerprint,
            userAgent: clientMeta.userAgent,
            method: "telegram",
            message: "Telegram 验证码错误",
          });
          const message =
            tgResult.reason === "expired"
              ? "验证码已过期，请重新获取"
              : "Telegram 验证码错误";
          return res.status(401).json({ success: false, message });
        }
      }

      if (!verified) {
        adminAuth.recordLoginFailure(rate.key, rate.entry);
        await logAdminSecurityEvent("2fa_failed", {
          ...clientMeta,
          email: challenge.email,
          detail: `${method} 验证码错误`,
        });
        fireAdminSecurityNotification("admin_2fa_failed", {
          email: challenge.email,
          ip: clientMeta.ip,
          fingerprint: clientMeta.fingerprint,
          userAgent: clientMeta.userAgent,
          method,
          message: "二次验证失败",
        });
        return res.status(401).json({ success: false, message: "验证码错误" });
      }

      adminAuth.clearLoginAttempts(rate.key);
      const { token, payload } = issueAdminToken(
        authConfig.passwordVersion,
        authConfig.email,
      );
      await logAdminSecurityEvent("login_success", {
        ...clientMeta,
        email: authConfig.email,
        detail: `二次验证成功 (${method})`,
      });
      fireAdminSecurityNotification("admin_login_success", {
        email: authConfig.email,
        ip: clientMeta.ip,
        fingerprint: clientMeta.fingerprint,
        userAgent: clientMeta.userAgent,
        method,
        message: "后台登录成功",
      });

      return res.json(
        await attachAdminPaths({
          success: true,
          token,
          expiresAt: payload.exp,
          issuedAt: payload.iat,
          permissions: payload.permissions,
          email: authConfig.email,
        }),
      );
    } catch (error) {
      return res.status(500).json({ success: false, message: error.message });
    }
  });
}

function registerAdminSecurityRoutes(app, deps) {
  const {
    adminAuth,
    store,
    ensureStoreReady,
    verifyPassword,
    issueAdminToken,
    logAdminSecurityEvent,
    fireAdminSecurityNotification,
    attachAdminPaths,
    invalidateAdminPathsCache,
    setCachedAdminPaths,
    buildAdminLoginUrl,
    buildAdminPanelUrl,
    buildCheckoutUrl,
    ADMIN_REFRESH_AFTER_MS,
    authenticateAdmin,
  } = deps;

  app.get("/api/admin/session", (req, res) => {
    const age = Date.now() - Number(req.admin.iat || 0);
    const shouldRefresh = age >= ADMIN_REFRESH_AFTER_MS;
    let refreshedToken = null;
    let payload = req.admin;

    if (shouldRefresh) {
      const refreshed = issueAdminToken(req.admin.pv, req.admin.email);
      refreshedToken = refreshed.token;
      payload = refreshed.payload;
    }

    return res.json({
      success: true,
      refreshed: shouldRefresh,
      token: refreshedToken,
      expiresAt: payload.exp,
      issuedAt: payload.iat,
      permissions: payload.permissions,
      email: payload.email || "",
    });
  });

  app.get("/api/admin/security/status", async (req, res) => {
    try {
      await ensureStoreReady();
      const authConfig = await store.getAdminAuthConfig();
      const telegramSettings = await store.getTelegramConfig();
      const paths = await store.getAdminPaths();
      res.json({
        success: true,
        email: authConfig.email,
        totpEnabled: authConfig.totpEnabled,
        login2faMode: authConfig.login2faMode,
        availableMethods: adminAuth.getAvailable2faMethods(
          authConfig,
          telegramSettings,
        ),
        methods: adminAuth.resolveLogin2faMethods(authConfig, telegramSettings),
        notifyAdminLogin: authConfig.notifyAdminLogin,
        loginPath: paths.loginPath,
        panelPath: paths.panelPath,
        checkoutPath: paths.checkoutPath,
        loginUrl: buildAdminLoginUrl(paths),
        panelUrl: buildAdminPanelUrl(paths),
        checkoutUrl: buildCheckoutUrl(paths),
      });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  });

  app.get("/api/admin/login-logs", authenticateAdmin, async (req, res) => {
    try {
      await ensureStoreReady();
      const limit = Number(req.query.limit) || 100;
      const offset = Number(req.query.offset) || 0;
      res.json({
        success: true,
        ...(await store.listAdminLoginLogs(limit, offset)),
      });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  });

  app.get("/api/admin/secondary/session", (req, res) => {
    const token = String(req.headers["x-admin-secondary-token"] || "").trim();
    const payload = adminAuth.verifySecondaryToken(token);
    if (!payload) {
      return res.json({ success: true, verified: false });
    }
    return res.json({
      success: true,
      verified: true,
      expiresAt: payload.exp,
    });
  });

  app.post("/api/admin/verify-secondary", async (req, res) => {
    const password = String(req.body?.password || "");
    const clientMeta = adminAuth.getClientMeta(req);
    if (!password) {
      return res.status(400).json({ success: false, message: "请输入二级密码" });
    }

    try {
      await ensureStoreReady();
      const authConfig = await store.getAdminAuthConfig();
      if (!verifyPassword(password, authConfig.secondaryPasswordHash)) {
        await logAdminSecurityEvent("secondary_failed", {
          ...clientMeta,
          email: req.admin?.email || authConfig.email,
          detail: "二级密码错误",
        });
        return res.status(401).json({ success: false, message: "二级密码错误" });
      }

      const { token, payload } = adminAuth.issueSecondaryToken(
        authConfig.secondaryPasswordVersion,
        clientMeta.ip,
      );
      await logAdminSecurityEvent("secondary_success", {
        ...clientMeta,
        email: req.admin?.email || authConfig.email,
        detail: "敏感模块解锁",
      });
      fireAdminSecurityNotification("admin_secondary_success", {
        email: req.admin?.email || authConfig.email,
        ip: clientMeta.ip,
        fingerprint: clientMeta.fingerprint,
        userAgent: clientMeta.userAgent,
        message: "银行卡池/CDK/Session 模块已解锁",
      });
      return res.json({
        success: true,
        secondaryToken: token,
        expiresAt: payload.exp,
      });
    } catch (error) {
      return res.status(500).json({ success: false, message: error.message });
    }
  });

  app.post("/api/admin/security/2fa-mode", async (req, res) => {
    const mode = String(req.body?.mode || "")
      .trim()
      .toLowerCase();
    try {
      await ensureStoreReady();
      const saved = await store.saveAdmin2faLoginMode(mode);
      res.json({
        success: true,
        login2faMode: saved,
        message: "登录验证方式已保存",
      });
    } catch (error) {
      res.status(400).json({ success: false, message: error.message });
    }
  });

  app.post("/api/admin/security/paths", async (req, res) => {
    try {
      await ensureStoreReady();
      const saved = await store.saveAdminPaths({
        loginPath: req.body?.loginPath,
        panelPath: req.body?.panelPath,
        checkoutPath: req.body?.checkoutPath,
      });
      invalidateAdminPathsCache();
      setCachedAdminPaths(saved);
      return res.json({
        success: true,
        loginPath: saved.loginPath,
        panelPath: saved.panelPath,
        checkoutPath: saved.checkoutPath,
        loginUrl: buildAdminLoginUrl(saved),
        panelUrl: buildAdminPanelUrl(saved),
        checkoutUrl: buildCheckoutUrl(saved),
        message: "入口路径已更新，请使用新地址访问并收藏",
      });
    } catch (error) {
      return res.status(400).json({ success: false, message: error.message });
    }
  });

  app.post("/api/admin/2fa/setup", async (req, res) => {
    try {
      await ensureStoreReady();
      const authConfig = await store.getAdminAuthConfig();
      let secret = String(authConfig.totpSecret || "").trim();
      if (!secret || authConfig.totpEnabled) {
        secret = adminAuth.generateTotpSecret();
        await store.saveAdminTotpConfig({ secret, enabled: false });
      }
      const otpauthUrl = adminAuth.getTotpUri(authConfig.email, secret);
      res.json({
        success: true,
        secret,
        otpauthUrl,
        qrCodeUrl: `https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(otpauthUrl)}`,
        message: "请使用 Google Authenticator 扫码后输入验证码确认启用",
      });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  });

  app.post("/api/admin/2fa/confirm", async (req, res) => {
    const code = String(req.body?.code || "").trim();
    if (!code) {
      return res
        .status(400)
        .json({ success: false, message: "请输入 Authenticator 验证码" });
    }
    try {
      await ensureStoreReady();
      const authConfig = await store.getAdminAuthConfig();
      if (!authConfig.totpSecret) {
        return res
          .status(400)
          .json({ success: false, message: "请先发起 2FA 绑定" });
      }
      if (!adminAuth.verifyTotpCode(authConfig.totpSecret, code)) {
        return res
          .status(400)
          .json({ success: false, message: "验证码错误，请重试" });
      }
      await store.saveAdminTotpConfig({
        secret: authConfig.totpSecret,
        enabled: true,
      });
      res.json({ success: true, message: "Google Authenticator 已启用" });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  });

  app.post("/api/admin/2fa/disable", async (req, res) => {
    const currentPassword = String(req.body?.currentPassword || "");
    const code = String(req.body?.code || "").trim();
    try {
      await ensureStoreReady();
      const authConfig = await store.getAdminAuthConfig();
      if (!verifyPassword(currentPassword, authConfig.passwordHash)) {
        return res.status(400).json({ success: false, message: "登录密码错误" });
      }
      if (
        authConfig.totpEnabled &&
        !adminAuth.verifyTotpCode(authConfig.totpSecret, code)
      ) {
        return res
          .status(400)
          .json({ success: false, message: "Authenticator 验证码错误" });
      }
      await store.saveAdminTotpConfig({ secret: "", enabled: false });
      res.json({ success: true, message: "Google Authenticator 已关闭" });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  });

  app.post("/api/admin/change-secondary-password", async (req, res) => {
    const currentPassword = String(req.body?.currentPassword || "");
    const newPassword = String(req.body?.newPassword || "").trim();
    if (!currentPassword) {
      return res
        .status(400)
        .json({ success: false, message: "请输入当前二级密码" });
    }
    if (newPassword.length < 6) {
      return res
        .status(400)
        .json({ success: false, message: "新二级密码至少 6 位" });
    }
    try {
      await ensureStoreReady();
      const authConfig = await store.getAdminAuthConfig();
      if (!verifyPassword(currentPassword, authConfig.secondaryPasswordHash)) {
        return res
          .status(400)
          .json({ success: false, message: "当前二级密码错误" });
      }
      await store.updateAdminSecondaryPassword(newPassword);
      res.json({
        success: true,
        message: "二级密码已更新，敏感模块需重新验证",
      });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  });
}

module.exports = {
  registerAdminLoginRoutes,
  registerAdminSecurityRoutes,
};
