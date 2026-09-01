"use strict";

const path = require("path");
const { redactPublicCheckoutLog } = require("../log-redact");

function listPublicCheckoutLogs(runtimeLog, jobKey, after, limit) {
  const cap = Math.min(200, Math.max(1, Number(limit) || 80));
  if (typeof runtimeLog.forJob === "function") {
    return runtimeLog.forJob(jobKey, after, cap);
  }
  return runtimeLog
    .after(after, 2000)
    .filter((entry) => String(entry.jobKey || "") === String(jobKey))
    .slice(0, cap);
}

function logsFromRawOutput(rawOutput, after) {
  if (after > 0) return [];
  return String(rawOutput || "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 200)
    .map((text, index) => ({
      id: index + 1,
      ts: Date.now(),
      text: redactPublicCheckoutLog(text),
    }));
}

function registerPublicRoutes(app, deps) {
  const {
    store,
    ensureStoreReady,
    limitPublicRequests,
    safeEqualString,
    buildAdminLoginUrl,
    buildAdminPanelUrl,
    buildCheckoutUrl,
    normalizeSessionToken,
    validateSessionTokenForQuery,
    querySubscriptionBySession,
    extractEmailFromSession,
    cancelAutoRenew,
    REGION_CONFIG,
    startPublicCheckoutPay,
    resolvePublicCheckoutCdk,
    runtimeLog,
    adminAuth,
    TERMINAL_TASK_STATUSES,
    getActiveForegroundJobCount,
    publicDir,
    getPlanTypeLabel,
    getClientIp,
    getRemainingCooldownMinutes,
    handleActivationRequest,
    createCdks,
    stopCheckoutJob,
  } = deps;
  const resolveActivationHandler = (req, res, next) => {
    const handler =
      typeof deps.handleActivationRequest === "function"
        ? deps.handleActivationRequest
        : handleActivationRequest;
    return handler(req, res, next);
  };

  app.post(
    "/api/external/cards/push",
    limitPublicRequests("external-cards-push", 20, 60 * 1000),
    async (req, res) => {
      try {
        await ensureStoreReady();
        const apiKey = String(req.headers["x-api-key"] || "").trim();
        if (!apiKey) {
          return res
            .status(401)
            .json({ success: false, error: "API Key 无效或缺失" });
        }
        const expectedKey = await store.getAppConfigValue(
          "external_card_api_key",
          "",
        );
        if (!expectedKey || !safeEqualString(apiKey, expectedKey)) {
          return res
            .status(401)
            .json({ success: false, error: "API Key 无效或缺失" });
        }

        const cards = Array.isArray(req.body?.cards) ? req.body.cards : [];
        if (cards.length === 0) {
          return res
            .status(400)
            .json({ success: false, error: "缺少 cards 数组或为空" });
        }
        if (cards.length > 500) {
          return res
            .status(400)
            .json({ success: false, error: "单次导入上限 500 条" });
        }

        const result = await store.importCards(cards);
        res.json({ success: true, ...result });
      } catch (error) {
        if (error.message === "单次导入上限 500 条") {
          return res.status(400).json({ success: false, error: error.message });
        }
        res.status(500).json({ success: false, message: error.message });
      }
    },
  );

  app.post(
    "/api/public/subscription/check",
    limitPublicRequests("subscription-check", 10, 60 * 1000),
    async (req, res) => {
      try {
        const rawSession = String(req.body?.session || req.body?.token || "")
          .trim()
          .replace(/^\uFEFF/, "");
        if (!rawSession) {
          return res.status(400).json({
            success: false,
            message: "请粘贴 Session JSON 或 AccessToken",
          });
        }

        const token = normalizeSessionToken(rawSession);
        const tokenCheck = validateSessionTokenForQuery(token);
        if (!tokenCheck.valid) {
          return res
            .status(400)
            .json({ success: false, message: tokenCheck.message });
        }

        const timezoneOffsetMin = Number(req.body?.timezone_offset_min);
        const result = await querySubscriptionBySession(token, {
          timezoneOffsetMin: Number.isFinite(timezoneOffsetMin)
            ? timezoneOffsetMin
            : -new Date().getTimezoneOffset(),
          email: extractEmailFromSession(rawSession) || tokenCheck.email || "",
        });

        if (!result.ok) {
          return res.status(result.statusCode || 502).json({
            success: false,
            message: result.error || "查询订阅失败",
          });
        }

        return res.json({ success: true, data: result.data });
      } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
      }
    },
  );

  app.post(
    "/api/public/subscription/cancel-auto-renew",
    limitPublicRequests("subscription-cancel-renew", 6, 60 * 1000),
    async (req, res) => {
      try {
        const rawSession = String(req.body?.session || req.body?.token || "")
          .trim()
          .replace(/^\uFEFF/, "");
        if (!rawSession) {
          return res.status(400).json({
            success: false,
            message: "请粘贴 Session JSON 或 AccessToken",
          });
        }

        const token = normalizeSessionToken(rawSession);
        const tokenCheck = validateSessionTokenForQuery(token);
        if (!tokenCheck.valid) {
          return res
            .status(400)
            .json({ success: false, message: tokenCheck.message });
        }

        const timezoneOffsetMin = Number(req.body?.timezone_offset_min);
        const result = await cancelAutoRenew(token, {
          timezoneOffsetMin: Number.isFinite(timezoneOffsetMin)
            ? timezoneOffsetMin
            : -new Date().getTimezoneOffset(),
          email: extractEmailFromSession(rawSession) || tokenCheck.email || "",
        });

        if (!result.ok) {
          return res.status(result.statusCode || 502).json({
            success: false,
            message: result.error || "取消自动续费失败",
          });
        }

        return res.json({
          success: true,
          data: result.data,
          message: result.data?.message || "已提交取消自动续费",
        });
      } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
      }
    },
  );

  app.get("/api/public/checkout/options", async (req, res) => {
    try {
      await ensureStoreReady();
      const regionCode = await store.getPaymentRegion();
      const current = REGION_CONFIG[regionCode] || REGION_CONFIG.PH;
      const proxyGroups = await store.listProxyGroups();
      const defaultProxyGroupId = String(
        (await store.getAppConfigValue("default_proxy_group_id", "")) || "",
      ).trim();
      return res.json({
        success: true,
        plans: store.listCheckoutPlans(),
        credit_presets: store.CREDIT_QUANTITY_PRESETS,
        credit_min: store.CREDIT_QUANTITY_MIN,
        credit_step: store.CREDIT_QUANTITY_STEP,
        regions: Object.entries(REGION_CONFIG).map(([code, cfg]) => ({
          code,
          label: cfg.label,
          currency: cfg.currency,
        })),
        default_region: regionCode,
        default_currency: current.currency,
        default_label: current.label,
        proxy_groups: proxyGroups,
        default_proxy_group_id: defaultProxyGroupId,
        default_timezone: store.getDefaultTimeZone(),
      });
    } catch (error) {
      return res.status(500).json({ success: false, message: error.message });
    }
  });

  app.post(
    "/api/public/checkout/pay",
    limitPublicRequests("public-checkout-pay", 8, 60 * 1000),
    async (req, res) => {
      try {
        await ensureStoreReady();
        const body = { ...(req.body || {}) };
        delete body.card_id;
        delete body.card_group_id;
        delete body.cardGroupId;
        const result = await startPublicCheckoutPay(
          {
            ...body,
            cdk_code: resolvePublicCheckoutCdk(),
          },
          { requireManualPayment: true },
        );
        return res.status(result.status).json(result.payload);
      } catch (error) {
        return res.status(500).json({ success: false, error: error.message });
      }
    },
  );

  app.post(
    "/api/public/checkout/stop",
    limitPublicRequests("public-checkout-stop", 12, 60 * 1000),
    async (req, res) => {
      try {
        await ensureStoreReady();
        const jobKey = String(
          req.body?.jobKey || req.body?.job_key || "",
        ).trim();
        const viewerToken = String(
          req.body?.token || req.body?.viewerToken || "",
        ).trim();
        if (!jobKey || !/^[A-Za-z0-9._-]{1,80}$/.test(jobKey)) {
          return res
            .status(400)
            .json({ success: false, error: "缺少任务标识" });
        }
        if (!adminAuth.verifyTaskViewerToken(viewerToken, jobKey)) {
          return res.status(401).json({ success: false, error: "未授权订阅" });
        }
        if (typeof stopCheckoutJob !== "function") {
          return res.status(500).json({ success: false, error: "停止功能不可用" });
        }
        const result = await stopCheckoutJob(jobKey);
        if (!result.ok) {
          return res.status(result.status).json({
            success: false,
            error: result.error,
          });
        }
        return res.json({
          success: true,
          jobKey: result.jobKey,
          message: result.message,
        });
      } catch (error) {
        return res.status(500).json({ success: false, error: error.message });
      }
    },
  );

  app.get(
    "/api/public/checkout/status/:jobKey",
    limitPublicRequests("public-checkout-status", 60, 60 * 1000),
    async (req, res) => {
      try {
        await ensureStoreReady();
        const jobKey = decodeURIComponent(
          String(req.params.jobKey || "").trim(),
        );
        const viewerToken = String(
          req.query?.token || req.query?.viewerToken || "",
        ).trim();
        if (!jobKey || !/^[A-Za-z0-9._-]{1,80}$/.test(jobKey)) {
          return res
            .status(400)
            .json({ success: false, error: "缺少任务标识" });
        }
        if (!adminAuth.verifyTaskViewerToken(viewerToken, jobKey)) {
          return res.status(401).json({ success: false, error: "未授权订阅" });
        }
        const task = await store.getTaskStatus(jobKey);
        if (!task) {
          return res.status(404).json({ success: false, error: "任务不存在" });
        }
        const after = Math.max(
          0,
          parseInt(String(req.query.after || "0"), 10) || 0,
        );
        let logEntries = listPublicCheckoutLogs(
          runtimeLog,
          jobKey,
          after,
          200,
        ).map((entry) => ({
          id: entry.id,
          ts: entry.ts,
          text: redactPublicCheckoutLog(entry.text),
        }));
        if (!logEntries.length) {
          logEntries = logsFromRawOutput(task.raw_output, after);
        }
        const lastLog = logEntries[logEntries.length - 1];
        return res.json({
          success: true,
          jobKey,
          status: task.status,
          message: task.message,
          progress: Number(task.progress || 0),
          isTerminal: TERMINAL_TASK_STATUSES.has(task.status),
          logs: logEntries,
          logAfter: lastLog ? lastLog.id : after,
        });
      } catch (error) {
        return res.status(500).json({ success: false, error: error.message });
      }
    },
  );

  app.get("/subscription", (req, res) => {
    res.sendFile(path.join(publicDir, "subscription.html"));
  });

  app.get("/api/public/payment-region", async (req, res) => {
    try {
      await ensureStoreReady();
      const regionCode = await store.getPaymentRegion();
      const config = REGION_CONFIG[regionCode] || REGION_CONFIG.PH;
      return res.json({
        success: true,
        region: regionCode,
        currency: config.currency,
        label: config.label,
      });
    } catch (error) {
      return res.status(500).json({ success: false, message: error.message });
    }
  });

  app.get("/api/public/runtime", async (req, res) => {
    try {
      await ensureStoreReady();
      const [maxConcurrentActivations, queued] = await Promise.all([
        store.getMaxConcurrentActivations(),
        store.countQueuedForegroundTasks(),
      ]);
      const max = Math.max(1, Number(maxConcurrentActivations || 1));
      const active = Number(getActiveForegroundJobCount() || 0);
      return res.json({
        success: true,
        runtime: {
          active_foreground_jobs: active,
          max_foreground_jobs: max,
          queued_tasks: Number(queued || 0),
        },
      });
    } catch (error) {
      return res.status(500).json({ success: false, message: error.message });
    }
  });

  app.post(
    "/api/run-process",
    limitPublicRequests("activation", 5, 60 * 1000),
    resolveActivationHandler,
  );

  app.post(
    "/api/verify-cdk",
    limitPublicRequests("verify-cdk", 30, 60 * 1000),
    async (req, res) => {
      const cdk = String(req.body?.cdk || "").trim();
      const clientIp = getClientIp(req);
      if (!cdk) {
        return res.status(400).json({ success: false, message: "请输入 CDK" });
      }

      try {
        await ensureStoreReady();
        const cdkData = await store.verifyCdkDetails(cdk);
        const runningTask = cdkData
          ? await store.getRunningTaskByCdk(cdk)
          : null;
        if (cdkData && runningTask) {
          const queued = Number(runningTask.progress || 0) < 8;
          return res.json({
            success: true,
            data: {
              type: cdkData.type || "自助",
              plan_type: cdkData.plan_type || "plus",
              plan_label: getPlanTypeLabel(cdkData.plan_type || "plus"),
              status: queued ? "queued" : "processing",
              pending: queued,
              cancellable: queued,
              jobKey: runningTask.job_key,
              viewerToken: adminAuth.issueTaskViewerToken(runningTask.job_key)
                .token,
              message:
                runningTask.message ||
                (queued ? "当前 CDK 正在排队" : "当前 CDK 正在开通中"),
            },
          });
        }
        if (cdkData && !cdkData.used_at) {
          if (cdkData.type === "自助") {
            const cdkCooldownMinutes = getRemainingCooldownMinutes(
              cdkData.cooldown_until,
            );
            if (cdkCooldownMinutes > 0) {
              return res.status(403).json({
                success: false,
                message: `该卡密连续无资格尝试过多，请冷静 ${cdkCooldownMinutes} 分钟后再试`,
              });
            }
            if (clientIp) {
              const ipAttemptLimit = await store.getActivationAttemptLimit(
                "ip",
                clientIp,
              );
              const ipCooldownMinutes = getRemainingCooldownMinutes(
                ipAttemptLimit?.cooldown_until,
              );
              if (ipCooldownMinutes > 0) {
                return res.status(403).json({
                  success: false,
                  message: `当前 IP 连续无资格尝试过多，请冷静 ${ipCooldownMinutes} 分钟后再试`,
                });
              }
            }
          }
          return res.json({
            success: true,
            data: {
              type: cdkData.type || "自助",
              plan_type: cdkData.plan_type || "plus",
              plan_label: getPlanTypeLabel(cdkData.plan_type || "plus"),
            },
          });
        }

        return res.status(403).json({
          success: false,
          message: cdkData?.used_at ? "该 CDK 已使用" : "无效 CDK",
        });
      } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
      }
    },
  );

  app.get(
    "/api/cdk/query",
    limitPublicRequests("cdk-query", 30, 60 * 1000),
    async (req, res) => {
      const cdk = String(req.query.cdk || "").trim();
      if (!cdk) {
        return res
          .status(400)
          .json({ success: false, message: "请输入查询激活码" });
      }

      try {
        await ensureStoreReady();
        const cdkData = await store.verifyCdkDetails(cdk);
        if (!cdkData) {
          return res
            .status(403)
            .json({ success: false, message: "无效 CDK" });
        }
        const runningTask = await store.getRunningTaskByCdk(cdk);
        const latestRows = await store.listLatestTasksByCdks([cdk]);
        const latest = latestRows[0] || null;
        const cdkStatus = runningTask
          ? Number(runningTask.progress || 0) < 8
            ? "排队中"
            : "开通中"
          : cdkData.used_at
            ? "已使用"
            : latest &&
                ["failed", "manual", "maintenance", "card_invalid"].includes(
                  String(latest.status || ""),
                )
              ? "失败"
              : "未使用";

        res.json({
          success: true,
          data: {
            status: cdkStatus,
            type: cdkData.type || "自助",
            plan_type: cdkData.plan_type || "plus",
            createdAt: store.formatStoreDateTime(cdkData.created_at),
            jobKey: runningTask?.job_key || latest?.job_key || null,
            message: runningTask?.message || latest?.message || "",
            usedAt: store.formatStoreDateTime(cdkData.used_at),
          },
        });
      } catch (error) {
        res.status(500).json({ success: false, message: error.message });
      }
    },
  );

  app.post(
    "/api/cdk/lookup",
    limitPublicRequests("cdk-lookup", 20, 60 * 1000),
    async (req, res) => {
      try {
        await ensureStoreReady();
        const raw = Array.isArray(req.body?.codes)
          ? req.body.codes
          : String(req.body?.cdk || req.body?.codes || "")
              .split(/[\n,;\s]+/)
              .filter(Boolean);
        const codes = [
          ...new Set(
            raw.map((item) => String(item || "").trim()).filter(Boolean),
          ),
        ].slice(0, 100);
        if (!codes.length) {
          return res
            .status(400)
            .json({ success: false, message: "请输入要查询的卡密" });
        }
        const [latestRows] = await Promise.all([
          store.listLatestTasksByCdks(codes),
        ]);
        const latestMap = new Map(
          latestRows.map((row) => [String(row.cdk_code || "").toLowerCase(), row]),
        );
        const tasks = [];
        for (const code of codes) {
          const cdkData = await store.verifyCdkDetails(code);
          const latest = latestMap.get(code.toLowerCase()) || null;
          const running = cdkData
            ? await store.getRunningTaskByCdk(code)
            : null;
          if (!cdkData && !latest) {
            tasks.push({
              code,
              error: "无效 CDK",
              status: "未找到",
              kind: "missing",
              unused: false,
              found: false,
              plan_type: "",
              email: "",
              task: null,
            });
            continue;
          }
          const latestStatus = String(latest?.status || "");
          const failedLast = [
            "failed",
            "manual",
            "maintenance",
            "card_invalid",
          ].includes(latestStatus);
          let status = "未使用";
          let kind = "unused";
          if (running) {
            if (Number(running.progress || 0) < 8) {
              status = "排队中";
              kind = "queued";
            } else {
              status = "处理中";
              kind = "processing";
            }
          } else if (latestStatus === "success" || cdkData?.used_at) {
            status = "已完成";
            kind = "completed";
          } else if (failedLast) {
            status = "失败";
            kind = "failed";
          }
          const createdAt = running?.created_at || latest?.created_at || null;
          const updatedAt = running?.updated_at || latest?.updated_at || cdkData?.used_at || null;
          tasks.push({
            code,
            unused: kind === "unused",
            found: true,
            plan_type: cdkData?.plan_type || "plus",
            email: String(latest?.token_preview || "").trim(),
            created_at: createdAt,
            updated_at: updatedAt,
            task: latest || running
              ? {
                  task_id: running?.job_key || latest?.job_key || "",
                  cdk_code: code,
                  task_status: running?.status || latestStatus,
                  message: running?.message || latest?.message || "",
                  created_at: createdAt,
                  updated_at: updatedAt,
                }
              : null,
            status,
            kind,
          });
        }
        res.json({ success: true, tasks });
      } catch (error) {
        res.status(500).json({ success: false, message: error.message });
      }
    },
  );

  app.post(
    "/api/cdk/refresh",
    limitPublicRequests("cdk-refresh", 10, 60 * 1000),
    async (req, res) => {
      try {
        await ensureStoreReady();
        const cdk = String(req.body?.cdk || req.body?.cdk_code || "").trim();
        const result = await store.refreshCdkCode(cdk, createCdks);
        res.json({
          success: true,
          old_code: result.old_code,
          new_code: result.new_code,
          refresh_remaining: result.refresh_remaining,
        });
      } catch (error) {
        res.status(400).json({ success: false, message: error.message });
      }
    },
  );

  app.post(
    "/api/cdk/cancel",
    limitPublicRequests("cdk-cancel", 10, 60 * 1000),
    async (req, res) => {
      try {
        await ensureStoreReady();
        const cdk = String(req.body?.cdk || req.body?.cdk_code || "").trim();
        const result = await store.cancelQueuedTaskByCdk(cdk);
        if (!result.ok) {
          return res
            .status(400)
            .json({ success: false, message: result.error || "取消失败" });
        }
        res.json({ success: true, ok: true, jobKey: result.job_key });
      } catch (error) {
        res.status(400).json({ success: false, message: error.message });
      }
    },
  );

  app.get("/api/cdk/download", async (req, res) => {
    return res.status(410).send("成品号下载功能已移除，仅支持自助开通");
  });
}

module.exports = {
  registerPublicRoutes,
  redactPublicCheckoutLog,
};
