      let adminLoginPath = "/admin-login";
      let adminCheckoutPath = "/checkout";
      const _lucideCreateIcons =
        typeof lucide !== "undefined" && lucide.createIcons
          ? lucide.createIcons.bind(lucide)
          : () => {};
      let lucideIconsRaf = 0;
      if (typeof lucide !== "undefined") {
        lucide.createIcons = function scheduledCreateIcons() {
          if (lucideIconsRaf) return;
          lucideIconsRaf = requestAnimationFrame(() => {
            lucideIconsRaf = 0;
            _lucideCreateIcons();
          });
        };
      }
      const ADMIN_LOGIN_EVENT_LABELS = {
        login_success: "登录成功",
        login_failed: "登录失败",
        "2fa_failed": "二次验证失败",
        password_changed: "修改密码",
        logout: "退出登录",
        cdk_generated: "生成 CDK",
        cdk_imported: "导入 CDK",
        cdk_deleted: "删除 CDK",
        cards_imported: "导入银行卡",
        card_deleted: "删除银行卡",
        cards_batch_deleted: "批量删除银行卡",
        cards_paused: "暂停银行卡",
        cards_resumed: "恢复银行卡",
        cards_max_usage_updated: "设置银行卡次数上限",
        session_exported: "导出 Session",
        secondary_failed: "二级密码失败",
        secondary_success: "二级密码成功",
      };
      const statusMap = {
        success: { class: "status-success", label: "SUCCESS" },
        failed: { class: "status-failed", label: "FAILED" },
        running: { class: "status-running", label: "RUNNING" },
        manual: { class: "status-warning", label: "需人工" },
        card_invalid: { class: "status-warning", label: "CARD_INVALID" },
      };

      let phonePool = [];
      let cardPool = [];
      let cdkPool = [];
      let cdkTotal = 0;
      let cdkListRequestSeq = 0;
      let cdkSearchTimer = null;
      let cardSearchTimer = null;
      let productPool = [];
      let poolEmailsList = [];
      const selectedItems = {
        phone_pool: new Set(),
        card_pool: new Set(),
        cdk: new Set(),
        product: new Set(),
      };
      const tableFilters = {
        phone_pool: "all",
        card_pool: "all",
        cdk: "all",
        product: "all",
      };
      const tableSearch = {
        cdk: "",
        product: "",
        card_number: "",
      };
      let cardGroupList = [];
      let cardGroupFilter = "all";
      let cdkGroupFilter = "all";
      let cdkPlanTypeFilter = "all";
      let proxyGroupList = [];
      let proxyGroupFilter = "all";
      let defaultProxyGroupId = "";
      const taskLogFilters = {
        type: "all",
        cdk: "",
        account: "",
        status: "all",
      };
      let adminRefreshTimer = null;
      let uptimeTickTimer = null;
      let uptimeBaseSeconds = 0;
      let uptimeBaseAt = 0;
      window.__adminLogs = [];
      window.__adminRuntime = { active_activation_jobs: 0 };
      let maintenanceModeSaving = false;
      let lastMaintenanceModeValue = false;
      let adminDefaultTimeZone = "Asia/Shanghai";

      const paginationState = {
        phone_pool: { page: 1, pageSize: 10 },
        card_pool: { page: 1, pageSize: 10 },
        card_assets: { page: 1, pageSize: 20 },
        cdk: { page: 1, pageSize: 12 },
        product: { page: 1, pageSize: 12 },
        log: { page: 1, pageSize: 12 },
        automation: { page: 1, pageSize: 12 },
      };

      const RUNTIME_LOG_TEXT_CAP = 1_200_000;
      let runtimeLogPollTimer = null;
      let runtimeLogAfter = 0;
      let runtimeLogText = "";
      let runtimeLogEntries = [];
      const RUNTIME_LOG_ENTRY_CAP = 2500;

      /** 后台定时 loadData（含任务管理列表）；为便于阅读可暂停 */
      let adminDataRefreshPaused = false;
      let adminDataRefreshTimer = null;
      let lastAdminDataRefreshAt = 0;

      /** 当前成品批量生产 WebSocket 对应的 jobKey，用于「停止生产」 */
      window.__adminProductGenJobKey = "";

      function formatRuntimeLogTs(ts) {
        if (typeof ts === "object" && ts?.displayTime) {
          return ts.displayTime;
        }
        try {
          const d = new Date(Number(ts) || 0);
          return d.toLocaleTimeString("en-GB", {
            timeZone: adminDefaultTimeZone,
            hour12: false,
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
          });
        } catch (_) {
          return "--:--:--";
        }
      }

      function runtimeLogDisplayWidth(value) {
        let width = 0;
        for (const char of String(value || "")) {
          width += char.codePointAt(0) > 255 ? 2 : 1;
        }
        return width;
      }

      function padRuntimeLogField(value, width) {
        let text = "";
        for (const char of String(value || "")) {
          const next =
            runtimeLogDisplayWidth(text) + (char.codePointAt(0) > 255 ? 2 : 1);
          if (next > width) break;
          text += char;
        }
        return (
          text + " ".repeat(Math.max(0, width - runtimeLogDisplayWidth(text)))
        );
      }

      function formatAdminDateTime(value, includeSeconds = false) {
        if (value == null || value === "") return "-";
        const raw = String(value).trim();
        if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(raw) && !/[zZ]|[+-]\d{2}:\d{2}$/.test(raw)) {
          const text = raw.replace("T", " ").slice(0, includeSeconds ? 19 : 16);
          return includeSeconds ? text : text.slice(0, 16);
        }
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return "-";
        return date
          .toLocaleString("zh-CN", {
            timeZone: adminDefaultTimeZone,
            hour12: false,
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            ...(includeSeconds ? { second: "2-digit" } : {}),
          })
          .replace(/\//g, "-");
      }

      function getAdminTimeZoneOffsetMinutes() {
        const now = new Date();
        const parts = new Intl.DateTimeFormat("en-CA", {
          timeZone: adminDefaultTimeZone,
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          hourCycle: "h23",
        }).formatToParts(now);
        const values = Object.fromEntries(
          parts
            .filter((part) => part.type !== "literal")
            .map((part) => [part.type, part.value]),
        );
        const localAsUtc = Date.UTC(
          Number(values.year),
          Number(values.month) - 1,
          Number(values.day),
          Number(values.hour),
          Number(values.minute),
          Number(values.second),
        );
        return Math.round((now.getTime() - localAsUtc) / 60000);
      }

      const RUNTIME_LOG_SOURCE_MAP = {
        "fork/register_openai.js": "注册",
        "fork/oauth_login.js": "协议",
        "fork/index.js": "结账",
        product: "流程",
        task: "任务",
        server: "服务",
        system: "系统",
        ChatGPT: "结账",
        Session: "会话",
        PaymentRetry: "支付",
        CheckoutProtocol: "协议",
        "Browser/pool": "浏览器",
      };

      function formatRuntimeLogSource(entry) {
        const raw = String(entry.source || entry.level || "").trim();
        if (RUNTIME_LOG_SOURCE_MAP[raw]) {
          return RUNTIME_LOG_SOURCE_MAP[raw];
        }
        const forkMatch = raw.match(/^fork\/([\w.-]+)$/);
        if (forkMatch) {
          return forkMatch[1].replace(/\.js$/, "").slice(0, 4);
        }
        return raw.slice(0, 4) || "日志";
      }

      function formatRuntimeLogJob(jobKey) {
        const k = String(jobKey || "").trim();
        if (!k) {
          return "-";
        }
        return k.slice(-8);
      }

      function formatRuntimeLogLine(entry) {
        const time = padRuntimeLogField(formatRuntimeLogTs(entry.ts), 8);
        const job = padRuntimeLogField(formatRuntimeLogJob(entry.jobKey), 8);
        const source = padRuntimeLogField(formatRuntimeLogSource(entry), 4);
        const text = String(entry.text || "")
          .replace(/[\p{Extended_Pictographic}\uFE0F]/gu, "")
          .replace(/\s+/g, " ")
          .trim();
        return `${time}  ${job}  ${source}  ${text}`;
      }

      function getRuntimeLogLevel(entry) {
        const text = String(entry.text || "").toLowerCase();
        const rawLevel = String(entry.level || "").toLowerCase();
        if (
          /error|fail|failed|declined|拒绝|失败|异常|超时|timeout|exit code=[1-9]/.test(
            `${rawLevel} ${text}`,
          )
        ) {
          return { key: "error", label: "错误" };
        }
        if (
          /warn|warning|回退|重试|retry|人工|已提交取消|暂未更新|未确认|请稍后刷新确认/.test(
            `${rawLevel} ${text}`,
          )
        ) {
          return { key: "warning", label: "警告" };
        }
        if (
          /success|完成|已保存|已启动|已关闭|payment_success|取消续费成功|自动续费已关闭/.test(
            text,
          )
        ) {
          return { key: "success", label: "完成" };
        }
        return { key: "info", label: "信息" };
      }

      function getRuntimeLogMessage(entry) {
        return String(entry.text || "")
          .replace(/[\p{Extended_Pictographic}\uFE0F]/gu, "")
          .replace(/\s+/g, " ")
          .trim();
      }

      function createRuntimeLogRow(entry) {
        const level = getRuntimeLogLevel(entry);
        const row = document.createElement("div");
        row.className = `runtime-log-row is-${level.key}`;

        const addCell = (className, text) => {
          const cell = document.createElement("span");
          cell.className = className;
          cell.textContent = text;
          row.appendChild(cell);
        };

        addCell(
          "runtime-log-meta",
          formatRuntimeLogTs(entry.displayTime ? entry : entry.ts),
        );
        addCell("runtime-log-meta", formatRuntimeLogJob(entry.jobKey));
        addCell("runtime-log-source", formatRuntimeLogSource(entry));
        addCell("runtime-log-level", level.label);
        addCell("runtime-log-message", getRuntimeLogMessage(entry));
        return row;
      }

      function renderRuntimeLogEntries(
        entries,
        append = false,
        targetId = "runtime_log_pre",
      ) {
        const log = document.getElementById(targetId);
        if (!log) return;
        if (!append) {
          log.replaceChildren();
        }
        const fragment = document.createDocumentFragment();
        for (const entry of entries) {
          fragment.appendChild(createRuntimeLogRow(entry));
        }
        log.appendChild(fragment);
      }

      function parseTaskLogEntries(rawOutput, jobKey) {
        return String(rawOutput || "")
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
          .map((line) => {
            const timestampMatch = line.match(/^\[([^\]]+)]\s*(.*)$/);
            const timestamp = timestampMatch ? timestampMatch[1] : "";
            const sourceMatch = String(
              timestampMatch ? timestampMatch[2] : line,
            ).match(/^\[([^\]]+)]\s*(.*)$/);
            return {
              displayTime: timestamp.slice(-8) || "--:--:--",
              jobKey,
              source: sourceMatch?.[1] || "任务",
              level: "log",
              text:
                sourceMatch?.[2] || (timestampMatch ? timestampMatch[2] : line),
            };
          });
      }

      function appendRuntimeLogEntries(entries) {
        if (!entries || entries.length === 0) {
          return;
        }
        const chunk = entries.map(formatRuntimeLogLine).join("\n") + "\n";
        runtimeLogText += chunk;
        if (runtimeLogText.length > RUNTIME_LOG_TEXT_CAP) {
          runtimeLogText = runtimeLogText.slice(
            -Math.floor(RUNTIME_LOG_TEXT_CAP * 0.85),
          );
        }
        runtimeLogEntries.push(...entries);
        if (runtimeLogEntries.length > RUNTIME_LOG_ENTRY_CAP) {
          runtimeLogEntries = runtimeLogEntries.slice(-RUNTIME_LOG_ENTRY_CAP);
          renderRuntimeLogEntries(runtimeLogEntries);
        } else {
          renderRuntimeLogEntries(entries, true);
        }
        const autoscroll = document.getElementById("runtime_log_autoscroll");
        const log = document.getElementById("runtime_log_pre");
        const wrap = log?.parentElement;
        if (autoscroll && autoscroll.checked && wrap) {
          wrap.scrollTop = wrap.scrollHeight;
        }
      }

      function stopRuntimeLogStream() {
        if (runtimeLogPollTimer) {
          clearInterval(runtimeLogPollTimer);
          runtimeLogPollTimer = null;
        }
      }

      async function fetchRuntimeLogsTail() {
        const res = await authFetch(
          "/api/admin/runtime-logs?tail=1&limit=1500",
        );
        const data = await res.json();
        if (!data.success) {
          throw new Error(data.message || "加载失败");
        }
        runtimeLogText = (data.entries || [])
          .map(formatRuntimeLogLine)
          .join("\n");
        if (runtimeLogText) {
          runtimeLogText += "\n";
        }
        runtimeLogAfter = Number(data.nextAfter || 0);
        runtimeLogEntries = (data.entries || []).slice(-RUNTIME_LOG_ENTRY_CAP);
        renderRuntimeLogEntries(runtimeLogEntries);
        const log = document.getElementById("runtime_log_pre");
        if (log) {
          const wrap = log.parentElement;
          const autoscroll = document.getElementById("runtime_log_autoscroll");
          if (autoscroll && autoscroll.checked && wrap) {
            wrap.scrollTop = wrap.scrollHeight;
          }
        }
      }

      async function fetchRuntimeLogsIncremental() {
        const pause = document.getElementById("runtime_log_pause");
        if (pause && pause.checked) {
          return;
        }
        try {
          const res = await authFetch(
            `/api/admin/runtime-logs?after=${runtimeLogAfter}&limit=1000`,
          );
          const data = await res.json();
          if (!data.success || !data.entries || data.entries.length === 0) {
            if (data.success && data.nextAfter != null) {
              runtimeLogAfter = Number(data.nextAfter);
            }
            return;
          }
          appendRuntimeLogEntries(data.entries);
          runtimeLogAfter = Number(data.nextAfter || runtimeLogAfter);
        } catch (_) {
          /* 静默失败，下一轮再试 */
        }
      }

      function startRuntimeLogStream() {
        stopRuntimeLogStream();
        fetchRuntimeLogsTail().catch(() => {});
        runtimeLogPollTimer = setInterval(() => {
          fetchRuntimeLogsIncremental();
        }, 2000);
      }

      async function refreshRuntimeLogsManual() {
        try {
          await fetchRuntimeLogsTail();
          showMessage("运行日志已刷新", "success");
        } catch (error) {
          showMessage(error.message || "刷新失败", "error");
        }
        lucide.createIcons();
      }

      async function exportRuntimeLogs(scope = "all") {
        try {
          const res = await authFetch(
            `/api/admin/runtime-logs/export?scope=${encodeURIComponent(scope)}`,
          );
          if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            throw new Error(data.message || "导出失败");
          }
          const blob = await res.blob();
          const url = URL.createObjectURL(blob);
          const link = document.createElement("a");
          link.href = url;
          link.download =
            scope === "errors" ? "runtime-errors.log" : "runtime-logs.log";
          document.body.appendChild(link);
          link.click();
          link.remove();
          URL.revokeObjectURL(url);
          showMessage(
            scope === "errors" ? "错误日志已导出" : "运行日志已导出",
            "success",
          );
        } catch (error) {
          showMessage(error.message || "导出失败", "error");
        }
      }

      function updateAdminDataRefreshButton() {
        const btn = document.getElementById("admin_refresh_pause_btn");
        const label = document.getElementById("admin_refresh_pause_label");
        if (!btn || !label) {
          return;
        }
        const paused = adminDataRefreshPaused;
        label.textContent = paused ? "恢复刷新" : "停止刷新";
        const iconName = paused ? "play" : "pause";
        const icon = btn.querySelector("i[data-lucide]");
        if (icon) {
          icon.setAttribute("data-lucide", iconName);
        }
        btn.classList.toggle("btn-success", !paused);
        btn.classList.toggle("btn-secondary", paused);
        lucide.createIcons();
      }

      function toggleAdminDataRefresh() {
        adminDataRefreshPaused = !adminDataRefreshPaused;
        updateAdminDataRefreshButton();
        showMessage(
          adminDataRefreshPaused
            ? "已停止自动刷新：概览与各列表（含任务记录）不再自动更新"
            : "已恢复自动刷新：任务记录每 2 秒，概览每 10 秒",
          "success",
        );
      }

      async function manualRefreshAdminData() {
        try {
          await loadData(false);
          await loadTaskLogs(false);
          showMessage("数据已刷新", "success");
        } catch (error) {
          showMessage(error.message || "刷新失败", "error");
        }
        lucide.createIcons();
      }

      async function stopAdminProductBatch(opts = {}) {
        const useCurrent = Boolean(opts.useCurrentJob);
        const jobKey = useCurrent
          ? String(window.__adminProductGenJobKey || "").trim()
          : "";
        try {
          const res = await authFetch("/api/admin/products/generate-stop", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(jobKey ? { jobKey } : {}),
          });
          const raw = await res.text();
          let data = {};
          if (raw) {
            try {
              data = JSON.parse(raw);
            } catch (_) {
              /* 非 JSON（如 404 返回 HTML） */
            }
          }
          if (!res.ok) {
            const hint =
              res.status === 404
                ? "接口不存在，请部署含「停止成品批量」的后端并重启 Node 服务"
                : "";
            throw new Error(
              data.message || hint || `请求失败（${res.status}）`,
            );
          }
          if (data && data.success === false) {
            throw new Error(data.message || "操作失败");
          }
          const n = Number(data.stopped || 0);
          showMessage(
            data.message || "操作完成",
            n > 0 ? "success" : "warning",
          );
        } catch (e) {
          showMessage(e.message || "停止失败", "error");
        }
        lucide.createIcons();
      }

      function setProductGenStopVisible(visible) {
        const stopBtn = document.getElementById("product_gen_stop_btn");
        if (stopBtn) {
          stopBtn.style.display = visible ? "inline-flex" : "none";
        }
      }

      async function clearRuntimeLogs() {
        const ok = await showAdminConfirm(
          "确定清空当前内存中的运行日志？（不影响任务管理数据库表）",
          "清空运行日志",
        );
        if (!ok) {
          return;
        }
        try {
          const res = await authFetch("/api/admin/runtime-logs/clear", {
            method: "POST",
          });
          const data = await res.json();
          if (!data.success) {
            throw new Error(data.message || "清空失败");
          }
          runtimeLogText = "";
          runtimeLogEntries = [];
          runtimeLogAfter = 0;
          renderRuntimeLogEntries([]);
          await fetchRuntimeLogsTail();
          showMessage(data.message || "已清空", "success");
        } catch (error) {
          showMessage(error.message || "清空失败", "error");
        }
        lucide.createIcons();
      }

      function getAdminToken() {
        return "";
      }

      function clearAdminToken() {
        localStorage.removeItem("plus_admin_token");
      }

      function formatDurationText(totalSeconds) {
        const seconds = Math.max(0, Math.floor(Number(totalSeconds) || 0));
        const days = Math.floor(seconds / 86400);
        const hours = Math.floor((seconds % 86400) / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        const remainSeconds = seconds % 60;

        if (days > 0) return `${days}天 ${hours}时 ${minutes}分`;
        if (hours > 0) return `${hours}时 ${minutes}分 ${remainSeconds}秒`;
        if (minutes > 0) return `${minutes}分 ${remainSeconds}秒`;
        return `${remainSeconds}秒`;
      }

      function renderUptimeTick() {
        const currentSeconds =
          uptimeBaseSeconds +
          Math.max(0, Math.floor((Date.now() - uptimeBaseAt) / 1000));
        document.getElementById("stat_uptime_text").innerText =
          formatDurationText(currentSeconds);
      }

      function getCurrentUptimeSeconds() {
        if (!uptimeBaseAt) {
          return 0;
        }
        return (
          uptimeBaseSeconds +
          Math.max(0, Math.floor((Date.now() - uptimeBaseAt) / 1000))
        );
      }

      function startUptimeTicker(baseSeconds) {
        const nextBaseSeconds = Math.max(
          0,
          Math.floor(Number(baseSeconds) || 0),
        );
        const currentSeconds = getCurrentUptimeSeconds();
        if (uptimeBaseAt && nextBaseSeconds <= currentSeconds) {
          return;
        }
        uptimeBaseSeconds = nextBaseSeconds;
        uptimeBaseAt = Date.now();
        renderUptimeTick();
        if (uptimeTickTimer) {
          clearInterval(uptimeTickTimer);
        }
        uptimeTickTimer = setInterval(renderUptimeTick, 1000);
      }

      function redirectToLogin() {
        clearAdminToken();
        location.href = adminLoginPath;
      }

      function normalizePublicPath(raw, fallback) {
        const value = String(raw || "")
          .trim()
          .replace(/^\/+/, "")
          .split(/[?#]/)[0];
        if (!value) {
          return fallback;
        }
        return `/${value}`;
      }

      function setAdminCheckoutPath(raw) {
        adminCheckoutPath = normalizePublicPath(raw, "/checkout");
      }

      function openSelfCheckoutPage() {
        window.open(adminCheckoutPath, "_blank", "noopener");
      }

      function updateAdminPathPreview() {
        const origin = location.origin;
        const loginSeg = String(
          document.getElementById("admin_login_path")?.value || "",
        )
          .trim()
          .toLowerCase();
        const panelSeg = String(
          document.getElementById("admin_panel_path")?.value || "",
        )
          .trim()
          .toLowerCase();
        const checkoutSeg = String(
          document.getElementById("checkout_path")?.value || "",
        )
          .trim()
          .toLowerCase();
        const loginPreview = document.getElementById("admin_login_path_url");
        const panelPreview = document.getElementById("admin_panel_path_url");
        const checkoutPreview = document.getElementById("checkout_path_url");
        if (loginPreview) {
          loginPreview.textContent = loginSeg
            ? `完整登录地址：${origin}/${loginSeg.replace(/^\/+/, "")}`
            : "完整登录地址：—";
        }
        if (panelPreview) {
          panelPreview.textContent = panelSeg
            ? `完整后台地址：${origin}/${panelSeg.replace(/^\/+/, "")}`
            : "完整后台地址：—";
        }
        if (checkoutPreview) {
          checkoutPreview.textContent = checkoutSeg
            ? `完整自助开通地址：${origin}/${checkoutSeg.replace(/^\/+/, "")}`
            : "完整自助开通地址：—";
        }
      }

      function logoutAdmin() {
        fetch("/api/admin/logout", {
          method: "POST",
          credentials: "same-origin",
        })
          .catch(() => {})
          .finally(redirectToLogin);
      }

      async function authFetch(url, options = {}) {
        const response = await fetch(url, {
          ...options,
          credentials: "same-origin",
          headers: { ...(options.headers || {}) },
        });
        if (response.status === 401) {
          const loginPath = response.headers.get("X-Admin-Login-Path");
          if (loginPath && loginPath.startsWith("/")) {
            adminLoginPath = loginPath;
          }
          redirectToLogin();
          throw new Error("登录已失效");
        }
        return response;
      }

      async function loadAdminSecurityStatus() {
        try {
          const res = await authFetch("/api/admin/security/status");
          const data = await res.json();
          if (!data.success) return;
          const modeEl = document.getElementById("admin_2fa_login_mode");
          if (modeEl && data.login2faMode) {
            modeEl.value = data.login2faMode;
          }
          if (data.loginUrl) {
            adminLoginPath = data.loginUrl;
          }
          if (data.checkoutUrl || data.checkoutPath) {
            setAdminCheckoutPath(data.checkoutUrl || data.checkoutPath);
          }
          const loginPathEl = document.getElementById("admin_login_path");
          const panelPathEl = document.getElementById("admin_panel_path");
          const checkoutPathEl = document.getElementById("checkout_path");
          if (loginPathEl && data.loginPath) {
            loginPathEl.value = data.loginPath;
          }
          if (panelPathEl && data.panelPath) {
            panelPathEl.value = data.panelPath;
          }
          if (checkoutPathEl && data.checkoutPath) {
            checkoutPathEl.value = data.checkoutPath;
          }
          updateAdminPathPreview();
          const statusEl = document.getElementById("totp_status_text");
          if (statusEl) {
            const available =
              (data.availableMethods || data.methods || [])
                .map((m) =>
                  m === "totp" ? "Google Authenticator" : "Telegram",
                )
                .join(" / ") || "未配置";
            const modeLabel =
              {
                either: "登录时可切换",
                totp: "仅 Google Authenticator",
                telegram: "仅 Telegram",
              }[data.login2faMode] || "登录时可切换";
            statusEl.textContent = `当前账号 ${data.email || "-"} · 2FA: ${data.totpEnabled ? "已启用" : "未启用"} · 已配置: ${available} · 策略: ${modeLabel}`;
          }
        } catch (_) {}
      }

      async function saveAdminPaths() {
        const loginPath =
          document.getElementById("admin_login_path")?.value.trim() || "";
        const panelPath =
          document.getElementById("admin_panel_path")?.value.trim() || "";
        const checkoutPath =
          document.getElementById("checkout_path")?.value.trim() || "";
        try {
          const res = await authFetch("/api/admin/security/paths", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ loginPath, panelPath, checkoutPath }),
          });
          const raw = await res.text();
          let data = {};
          try {
            data = raw ? JSON.parse(raw) : {};
          } catch (_) {
            showMessage(
              res.status === 404
                ? "保存接口未就绪，请重启应用后再试"
                : "服务器响应异常，请重启应用后重试",
              "error",
            );
            return;
          }
          if (!res.ok || !data.success) {
            showMessage(data.message || "保存失败", "error");
            return;
          }
          if (data.loginUrl) {
            adminLoginPath = data.loginUrl;
          }
          if (data.checkoutUrl || data.checkoutPath) {
            setAdminCheckoutPath(data.checkoutUrl || data.checkoutPath);
          }
          if (data.loginPath) {
            document.getElementById("admin_login_path").value = data.loginPath;
          }
          if (data.panelPath) {
            document.getElementById("admin_panel_path").value = data.panelPath;
          }
          if (data.checkoutPath) {
            document.getElementById("checkout_path").value = data.checkoutPath;
          }
          updateAdminPathPreview();
          showMessage(
            `${data.message || "入口路径已更新"}。登录：${data.loginUrl || ""} · 后台：${data.panelUrl || ""} · 开通：${data.checkoutUrl || ""}`,
            "success",
          );
        } catch (error) {
          showMessage(error.message || "保存失败", "error");
        }
      }

      async function saveAdmin2faLoginMode() {
        const mode =
          document.getElementById("admin_2fa_login_mode")?.value || "either";
        try {
          const res = await authFetch("/api/admin/security/2fa-mode", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ mode }),
          });
          const data = await res.json();
          showMessage(
            data.message || (data.success ? "已保存" : "保存失败"),
            data.success ? "success" : "error",
          );
          await loadAdminSecurityStatus();
        } catch (error) {
          showMessage(error.message || "保存失败", "error");
        }
      }

      async function setupAdmin2fa() {
        try {
          const res = await authFetch("/api/admin/2fa/setup", {
            method: "POST",
          });
          const data = await res.json();
          if (!res.ok || !data.success) {
            showMessage(data.message || "绑定失败", "error");
            return;
          }
          document.getElementById("totp_setup_box").style.display = "block";
          const qrImg = document.getElementById("totp_qr_img");
          if (qrImg) {
            qrImg.src =
              data.qrCodeUrl ||
              `https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(data.otpauthUrl || "")}`;
            qrImg.style.display = "block";
          }
          document.getElementById("totp_secret_text").innerHTML = `
                          <div style="margin-bottom:6px;">请用 Google Authenticator 扫描上方二维码</div>
                          <div>手动密钥：<code style="word-break:break-all;">${escapeHtml(data.secret || "")}</code></div>
                      `;
          showMessage("扫码后输入 6 位验证码确认启用", "success");
        } catch (error) {
          showMessage(error.message || "绑定失败", "error");
        }
      }

      async function confirmAdmin2fa() {
        const code = document.getElementById("totp_confirm_code").value.trim();
        try {
          const res = await authFetch("/api/admin/2fa/confirm", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ code }),
          });
          const data = await res.json();
          showMessage(
            data.message || (data.success ? "已启用" : "失败"),
            data.success ? "success" : "error",
          );
          if (data.success) {
            document.getElementById("totp_setup_box").style.display = "none";
            await loadAdminSecurityStatus();
          }
        } catch (error) {
          showMessage(error.message || "确认失败", "error");
        }
      }

      async function disableAdmin2fa() {
        const currentPassword =
          document.getElementById("current_password").value;
        const code =
          prompt(
            "若已启用 Authenticator，请输入当前 6 位验证码（未启用可留空）",
          ) || "";
        if (!currentPassword) {
          showMessage("请先在上方填写原登录密码", "warning");
          return;
        }
        try {
          const res = await authFetch("/api/admin/2fa/disable", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ currentPassword, code }),
          });
          const data = await res.json();
          showMessage(
            data.message || (data.success ? "已关闭" : "失败"),
            data.success ? "success" : "error",
          );
          await loadAdminSecurityStatus();
        } catch (error) {
          showMessage(error.message || "关闭失败", "error");
        }
      }

      async function loadAdminLoginLogs() {
        try {
          const res = await authFetch("/api/admin/login-logs?limit=100");
          const data = await res.json();
          const body = document.getElementById("admin_login_logs_body");
          if (!body) return;
          const logs = data.logs || [];
          if (!logs.length) {
            body.innerHTML =
              '<tr><td colspan="7" style="text-align:center; color: var(--text-dim);">暂无记录</td></tr>';
            return;
          }
          body.innerHTML = logs
            .map(
              (row) => `
                          <tr>
                              <td>${escapeHtml(formatAdminDateTime(row.created_at))}</td>
                              <td>${escapeHtml(ADMIN_LOGIN_EVENT_LABELS[row.event] || row.event || "")}</td>
                              <td>${escapeHtml(String(row.admin_email || ""))}</td>
                              <td>${escapeHtml(String(row.ip || ""))}</td>
                              <td style="word-break:break-all;">${escapeHtml(String(row.fingerprint || ""))}</td>
                              <td style="word-break:break-word;">${escapeHtml(String(row.user_agent || ""))}</td>
                              <td>${escapeHtml(String(row.detail || ""))}</td>
                          </tr>
                      `,
            )
            .join("");
        } catch (error) {
          showMessage(error.message || "加载登录日志失败", "error");
        }
      }

      async function readJsonResponse(response) {
        const text = await response.text();
        if (!text) {
          return {
            ok: false,
            message: `服务器返回空响应 (${response.status})`,
          };
        }
        try {
          return { ok: true, data: JSON.parse(text) };
        } catch (_) {
          const snippet = text.replace(/\s+/g, " ").slice(0, 120);
          if (response.status === 404) {
            return {
              ok: false,
              message: "接口不存在 (404)，请确认服务已重启并更新到最新版本",
            };
          }
          return {
            ok: false,
            message: `服务器响应异常 (${response.status})${snippet ? `：${snippet}` : ""}`,
          };
        }
      }

      function renderStatus(status) {
        const cfg = statusMap[status] || {
          class: "",
          label: String(status || "").toUpperCase(),
        };
        return `<span class="status-badge ${cfg.class}">${cfg.label || String(status || "").toUpperCase()}</span>`;
      }

      let screenshotObjectUrls = [];

      function closeScreenshotModal() {
        const overlay = document.getElementById("screenshot_modal_overlay");
        const body = document.getElementById("screenshot_modal_body");
        if (overlay) {
          overlay.classList.remove("open");
        }
        if (body) {
          body.innerHTML = "";
        }
        screenshotObjectUrls.forEach((url) => URL.revokeObjectURL(url));
        screenshotObjectUrls = [];
      }

      function buildScreenshotApiPath(relativePath) {
        const normalized = String(relativePath || "")
          .replace(/\\/g, "/")
          .replace(/^\/+/, "");
        if (!normalized) {
          return "";
        }
        return `/api/admin/screenshots?path=${encodeURIComponent(normalized)}`;
      }

      function buildVideoApiPath(relativePath) {
        const normalized = String(relativePath || "")
          .replace(/\\/g, "/")
          .replace(/^\/+/, "");
        if (!normalized) {
          return "";
        }
        return `/api/admin/video?path=${encodeURIComponent(normalized)}`;
      }

      document.addEventListener("click", (event) => {
        const screenshotBtn = event.target.closest("[data-view-screenshots]");
        if (screenshotBtn) {
          event.preventDefault();
          showTaskScreenshotsByJobKey(
            screenshotBtn.getAttribute("data-view-screenshots") || "",
          );
          return;
        }
        const videoBtn = event.target.closest("[data-view-video]");
        if (videoBtn) {
          event.preventDefault();
          showTaskVideoByJobKey(videoBtn.getAttribute("data-view-video") || "");
          return;
        }
        const detailBtn = event.target.closest("[data-view-task-detail]");
        if (detailBtn) {
          event.preventDefault();
          openTaskDetailModal(
            detailBtn.getAttribute("data-view-task-detail") || "",
          );
          return;
        }
        const copyVideoBtn = event.target.closest("[data-copy-video-url]");
        if (copyVideoBtn) {
          event.preventDefault();
          const href = copyVideoBtn.getAttribute("data-copy-video-url") || "";
          const url = href.startsWith("http")
            ? href
            : `${window.location.origin}${href}`;
          copyTextToClipboard(url)
            .then(() =>
              showMessage("播放链接已复制，可粘贴到 Edge 打开", "success"),
            )
            .catch((error) =>
              showMessage(error.message || "复制失败", "error"),
            );
          return;
        }
        const deleteBtn = event.target.closest("[data-delete-task]");
        if (deleteBtn) {
          event.preventDefault();
          deleteAdminTaskLog(deleteBtn.getAttribute("data-delete-task") || "");
          return;
        }
        const copyCdkBtn = event.target.closest("[data-copy-cdk]");
        if (copyCdkBtn) {
          event.preventDefault();
          copyCDK(copyCdkBtn.getAttribute("data-copy-cdk") || "");
          return;
        }
        const deleteCdkBtn = event.target.closest("[data-delete-cdk]");
        if (deleteCdkBtn) {
          event.preventDefault();
          deleteCDK(deleteCdkBtn.getAttribute("data-delete-cdk") || "");
          return;
        }
        const viewSessionBtn = event.target.closest("[data-view-session]");
        if (viewSessionBtn) {
          event.preventDefault();
          openSessionModal(
            viewSessionBtn.getAttribute("data-view-session") || "",
          );
          return;
        }
        const copySessionBtn = event.target.closest("[data-copy-session]");
        if (copySessionBtn) {
          event.preventDefault();
          copySessionByJobKey(
            copySessionBtn.getAttribute("data-copy-session") || "",
          );
          return;
        }
        const exportSessionBtn = event.target.closest("[data-export-session]");
        if (exportSessionBtn) {
          event.preventDefault();
          exportSessionByJobKey(
            exportSessionBtn.getAttribute("data-export-session") || "",
          );
          return;
        }
        const cancelRenewBtn = event.target.closest("[data-cancel-renew]");
        if (cancelRenewBtn) {
          event.preventDefault();
          cancelAutoRenewByJobKey(
            cancelRenewBtn.getAttribute("data-cancel-renew") || "",
            cancelRenewBtn,
          );
          return;
        }
        const enableRenewBtn = event.target.closest("[data-enable-renew]");
        if (enableRenewBtn) {
          event.preventDefault();
          enableAutoRenewByJobKey(
            enableRenewBtn.getAttribute("data-enable-renew") || "",
            enableRenewBtn,
          );
          return;
        }
        const deleteBillingBtn = event.target.closest("[data-delete-billing]");
        if (deleteBillingBtn) {
          event.preventDefault();
          deleteBillingRecord(
            deleteBillingBtn.getAttribute("data-delete-billing") || "",
          );
        }
      });

      document.addEventListener("change", (event) => {
        const input = event.target.closest(
          "input[data-select-type][data-select-key]",
        );
        if (!input || input.type !== "checkbox") {
          return;
        }
        toggleSelection(
          input.getAttribute("data-select-type") || "",
          input.getAttribute("data-select-key") || "",
          input.checked,
        );
      });

      let sessionModalPayload = "";
      let sessionModalJobKey = "";

      function formatSessionPayload(raw) {
        const text = String(raw || "").trim();
        if (!text) {
          return "";
        }
        if (text.startsWith("{")) {
          try {
            return JSON.stringify(JSON.parse(text), null, 2);
          } catch (_) {
            return text;
          }
        }
        return text;
      }

      function applyAccountSessionWriteback(payload) {
        const session = String(
          payload?.session || payload?.data?.session || "",
        ).trim();
        if (!session) {
          return false;
        }
        try {
          const parsed = JSON.parse(session);
          const token = String(parsed.accessToken || "").trim();
          const cookie = String(parsed.sessionToken || "").trim();
          if (!token || token.split(".").length !== 3 || !parsed.user || !cookie) {
            return false;
          }
        } catch (_) {
          return false;
        }
        const input = document.getElementById("cancel_renewal_session");
        if (!input) {
          return false;
        }
        input.value = formatSessionPayload(session);
        return true;
      }

      async function parseAccountActionResponse(res, fallbackMessage) {
        const parsed = await readJsonResponse(res);
        if (!parsed.ok) {
          throw new Error(parsed.message);
        }
        const data = parsed.data;
        applyAccountSessionWriteback(data);
        if (!res.ok || !data.success) {
          const error = new Error(data.message || fallbackMessage);
          error.session = data.session || "";
          throw error;
        }
        applyAccountSessionWriteback(data.data);
        return data.data || {};
      }

      async function fetchSessionPayload(jobKey) {
        const res = await authFetch(
          `/api/admin/sessions/${encodeURIComponent(jobKey)}`,
        );
        const parsed = await readJsonResponse(res);
        if (!parsed.ok) {
          throw new Error(parsed.message);
        }
        const data = parsed.data;
        if (!res.ok || !data.success) {
          throw new Error(data.message || "加载 Session 失败");
        }
        return {
          payload: data.session?.session_payload || "",
          meta: data.session || {},
        };
      }

      function closeSessionModal() {
        const overlay = document.getElementById("session_modal_overlay");
        const body = document.getElementById("session_modal_body");
        const meta = document.getElementById("session_modal_meta");
        if (overlay) {
          overlay.classList.remove("open");
        }
        if (body) {
          body.textContent = "";
        }
        if (meta) {
          meta.textContent = "";
        }
        sessionModalPayload = "";
        sessionModalJobKey = "";
      }

      async function openSessionModal(jobKey) {
        if (!jobKey) {
          return;
        }
        const overlay = document.getElementById("session_modal_overlay");
        const body = document.getElementById("session_modal_body");
        const meta = document.getElementById("session_modal_meta");
        if (!overlay || !body) {
          return;
        }
        closeSessionModal();
        overlay.classList.add("open");
        body.textContent = "加载中...";
        if (meta) {
          meta.textContent = `任务: ${jobKey}`;
        }
        try {
          const { payload, meta: sessionMeta } =
            await fetchSessionPayload(jobKey);
          if (!payload) {
            body.textContent =
              "该记录未保存完整 Session（仅旧任务有摘要）。请重新提交一次开通以保存完整内容。";
            return;
          }
          sessionModalJobKey = jobKey;
          sessionModalPayload = formatSessionPayload(payload);
          body.textContent = sessionModalPayload;
          if (meta) {
            meta.textContent = `任务: ${jobKey} · CDK: ${sessionMeta.cdk_code || "-"} · ${sessionMeta.time || ""}`;
          }
        } catch (error) {
          body.textContent = `加载失败: ${error.message}`;
        }
      }

      async function copyTextToClipboard(text) {
        if (!text) {
          throw new Error("内容为空");
        }
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(text);
          return;
        }
        const textarea = document.createElement("textarea");
        textarea.value = text;
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand("copy");
        document.body.removeChild(textarea);
      }

      async function copySessionByJobKey(jobKey) {
        try {
          const { payload } = await fetchSessionPayload(jobKey);
          const formatted = formatSessionPayload(payload);
          if (!formatted) {
            showMessage("该记录没有完整 Session 可复制", "warning");
            return;
          }
          await copyTextToClipboard(formatted);
          showMessage("Session 已复制到剪贴板", "success");
        } catch (error) {
          showMessage(error.message || "复制失败", "error");
        }
      }

      function accountStatusBadgeClass(text) {
        const value = String(text || "");
        if (/已订阅(?!（不续费）)/.test(value) || value === "是" || value === "可重置") {
          return "ok";
        }
        if (/未订阅|已过期|否|暂无/.test(value)) {
          return "danger";
        }
        if (/不续费|未返回|未读取/.test(value)) {
          return "warn";
        }
        return "";
      }

      function renderAccountStatusField(label, value, { wide = false, badge = false } = {}) {
        const text = String(value || "—");
        const badgeClass = badge ? accountStatusBadgeClass(text) : "";
        const valueHtml = badge
          ? `<span class="account-status-badge ${badgeClass}">${escapeHtml(text)}</span>`
          : escapeHtml(text);
        return `<div class="account-status-field${wide ? " wide" : ""}">
          <span class="account-status-label">${escapeHtml(label)}</span>
          <div class="account-status-value">${valueHtml}</div>
        </div>`;
      }

      function renderCancelRenewalDetail(data = {}) {
        const quota = data.codexQuota || {};
        const windows = Array.isArray(quota.windows) ? quota.windows : [];
        const statusText =
          data.accountStatus ||
          (data.hasActiveSubscription ? "已订阅" : "未订阅");
        const quotaItems = windows.length
          ? windows
              .map(
                (item) => `<div class="account-quota-item">
                  <div class="account-quota-item-head">
                    <span>${escapeHtml(item.windowLabel || "额度窗口")}</span>
                  </div>
                  <div class="account-quota-meta">
                    <div>已用 / 总量<strong>${escapeHtml(item.usageText || "—")}</strong></div>
                    <div>剩余<strong>${escapeHtml(item.remainingText || "—")}</strong></div>
                    <div>周期<strong>${escapeHtml(item.periodText || "—")}</strong></div>
                    <div>重置时间<strong>${escapeHtml(item.resetAtText || "—")}</strong></div>
                  </div>
                </div>`,
              )
              .join("")
          : `<div class="account-quota-item">
              <div class="account-quota-item-head">
                <span>${escapeHtml(quota.status || "未读取到")}</span>
              </div>
              <div class="account-quota-meta">
                <div>已用 / 总量<strong>${escapeHtml(quota.usageText || "—")}</strong></div>
                <div>剩余<strong>${escapeHtml(quota.remainingText || "—")}</strong></div>
                <div>重置时间<strong>${escapeHtml(quota.resetAtText || "—")}</strong></div>
              </div>
            </div>`;

        return `<div class="account-status-grid">
          <section class="account-status-card">
            <div class="account-status-card-head">
              <div class="account-status-card-title">账户信息</div>
            </div>
            <div class="account-status-fields">
              ${renderAccountStatusField("账号", data.email || "—", { wide: true })}
              ${renderAccountStatusField("账户 ID", data.accountId || "—", { wide: true })}
              ${renderAccountStatusField("开通货币", data.currency || "—")}
              ${renderAccountStatusField("订阅渠道", data.subscriptionChannel || "—")}
            </div>
          </section>
          <section class="account-status-card">
            <div class="account-status-card-head">
              <div class="account-status-card-title">订阅状态</div>
              <span class="account-status-badge ${accountStatusBadgeClass(statusText)}">${escapeHtml(statusText)}</span>
            </div>
            <div class="account-status-fields">
              ${renderAccountStatusField("套餐", data.plan || "—")}
              ${renderAccountStatusField("自动续费", data.autoRenew || "—", { badge: true })}
              ${renderAccountStatusField("到期时间", data.expiresAtDisplay || "—")}
              ${renderAccountStatusField("剩余天数", data.remainingDaysDisplay || "—", { badge: true })}
            </div>
          </section>
          <section class="account-status-card">
            <div class="account-status-card-head">
              <div class="account-status-card-title">Codex 额度</div>
              <span class="account-status-badge ${accountStatusBadgeClass(quota.resetAvailableText)}">${escapeHtml(quota.resetAvailableText || quota.status || "未返回")}</span>
            </div>
            <div class="account-status-fields">
              ${renderAccountStatusField("重置次数", quota.resetCountText || "—")}
              ${renderAccountStatusField("可否重置", quota.resetAvailableText || "—", { badge: true })}
            </div>
            <div class="account-quota-list">${quotaItems}</div>
          </section>
        </div>`;
      }

      function showCancelRenewalResult(data = {}, message = "") {
        const box = document.getElementById("cancel_renewal_result");
        const statusEl = document.getElementById("cancel_renewal_status");
        const detailEl = document.getElementById("cancel_renewal_detail");
        if (!box || !statusEl || !detailEl) {
          return;
        }
        const already = Boolean(data.alreadyCancelled);
        const cancelled = Boolean(data.cancelled);
        const confirmed = Boolean(data.confirmed || already);
        const pending = Boolean(data.pendingVerify || (cancelled && !confirmed));
        const statusText = already
          ? "取消续费成功：自动续费已关闭"
          : confirmed
            ? "取消续费成功：已确认自动续费关闭"
            : pending
              ? data.message || "取消请求已提交，状态尚未确认"
            : message || data.message || "操作完成";
        const color =
          confirmed || /成功|已关闭/.test(statusText)
            ? "var(--success)"
            : pending
              ? "var(--warning)"
              : "var(--text-main)";
        statusEl.textContent = statusText;
        statusEl.style.color = color;
        detailEl.innerHTML = renderCancelRenewalDetail(data);
        box.style.display = "block";
      }

      function clearCancelRenewalPage() {
        const input = document.getElementById("cancel_renewal_session");
        const box = document.getElementById("cancel_renewal_result");
        if (input) {
          input.value = "";
        }
        if (box) {
          box.style.display = "none";
        }
      }

      function setAccountLoading(visible, text) {
        const overlay = document.getElementById("account_loading_overlay");
        const label = document.getElementById("account_loading_text");
        if (label && text) {
          label.textContent = text;
        }
        if (!overlay) {
          return;
        }
        overlay.classList.toggle("is-open", Boolean(visible));
        overlay.setAttribute("aria-hidden", visible ? "false" : "true");
        if (visible) {
          lucide.createIcons();
        }
      }

      async function requestCancelAutoRenew(sessionRaw, jobKey = "") {
        const res = await authFetch(
          "/api/admin/subscription/cancel-auto-renew",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              session: sessionRaw,
              job_key: jobKey || undefined,
              timezone_offset_min: getAdminTimeZoneOffsetMinutes(),
              proxy_group_id: getSelectedProxyGroupId("account_proxy_group"),
            }),
          },
        );
        return parseAccountActionResponse(res, "取消自动续费失败");
      }

      async function requestEnableAutoRenew(sessionRaw, jobKey = "") {
        const res = await authFetch(
          "/api/admin/subscription/enable-auto-renew",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              session: sessionRaw,
              job_key: jobKey || undefined,
              timezone_offset_min: getAdminTimeZoneOffsetMinutes(),
              proxy_group_id: getSelectedProxyGroupId("account_proxy_group"),
            }),
          },
        );
        return parseAccountActionResponse(res, "开启自动续费失败");
      }

      async function requestAccountStatus(sessionRaw, jobKey = "") {
        const res = await authFetch("/api/admin/account/status", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            session: sessionRaw,
            job_key: jobKey || undefined,
            timezone_offset_min: getAdminTimeZoneOffsetMinutes(),
            proxy_group_id: getSelectedProxyGroupId("account_proxy_group"),
          }),
        });
        return parseAccountActionResponse(res, "查询账户状态失败");
      }

      async function requestResetCodexQuota(sessionRaw, jobKey = "") {
        const res = await authFetch("/api/admin/account/reset-codex-quota", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            session: sessionRaw,
            job_key: jobKey || undefined,
            timezone_offset_min: getAdminTimeZoneOffsetMinutes(),
            proxy_group_id: getSelectedProxyGroupId("account_proxy_group"),
          }),
        });
        return parseAccountActionResponse(res, "重置 Codex 额度失败");
      }

      function applyRenewalStatusFromResult(jobKey, result = {}) {
        if (!jobKey) {
          return;
        }
        sessionRenewalStatus[jobKey] = {
          ok: true,
          email: result.email || "",
          autoRenew: result.autoRenew || "—",
          autoRenewRaw: result.autoRenewRaw,
          hasActiveSubscription: Boolean(result.hasActiveSubscription),
          subscriptionChannel: result.subscriptionChannel || "",
        };
        renderSessionTable();
      }

      async function runAccountPageAction({
        buttonId,
        requireSession = true,
        confirmText,
        hintText,
        requestFn,
        fallbackMessage,
        errorMessage,
      }) {
        const input = document.getElementById("cancel_renewal_session");
        const btn = document.getElementById(buttonId);
        const sessionRaw = String(input?.value || "").trim();
        if (requireSession && !sessionRaw) {
          showMessage("请先粘贴 Session JSON 或 AccessToken", "warning");
          return;
        }
        if (confirmText && !confirm(confirmText)) {
          return;
        }
        if (btn) {
          btn.disabled = true;
        }
        setAccountLoading(true, hintText || "正在处理，请稍候…");
        try {
          const result = await requestFn(sessionRaw);
          applyAccountSessionWriteback(result);
          const pending = Boolean(
            result.pendingVerify ||
              (result.cancelled &&
                !result.confirmed &&
                !result.alreadyCancelled),
          );
          const displayMsg =
            result.alreadyCancelled
              ? "取消续费成功：自动续费已关闭"
              : result.confirmed
                ? "取消续费成功：已确认自动续费关闭"
                : pending
                  ? result.message || "取消请求已提交，状态尚未确认"
                : result.message || fallbackMessage || "操作完成";
          showCancelRenewalResult(result, displayMsg);
          showMessage(displayMsg, pending ? "warning" : "success");
        } catch (error) {
          applyAccountSessionWriteback(error);
          showMessage(error.message || errorMessage || "操作失败", "error");
        } finally {
          if (btn) {
            btn.disabled = false;
          }
          setAccountLoading(false);
          lucide.createIcons();
        }
      }

      async function submitAccountStatusPage() {
        await runAccountPageAction({
          buttonId: "account_status_btn",
          hintText: "正在查询账户状态…",
          requestFn: requestAccountStatus,
          fallbackMessage: "查询完成",
          errorMessage: "查询账户状态失败",
        });
      }

      async function submitCancelRenewalPage() {
        await runAccountPageAction({
          buttonId: "cancel_renewal_btn",
          confirmText:
            "确认要关闭该账号的自动续费吗？当前计费周期内仍可继续使用。",
          hintText: "正在处理，请稍候…",
          requestFn: requestCancelAutoRenew,
          fallbackMessage: "取消续费成功",
          errorMessage: "取消自动续费失败",
        });
      }

      async function submitEnableRenewalPage() {
        await runAccountPageAction({
          buttonId: "enable_renewal_btn",
          confirmText: "确认要开启该账号的自动续费吗？",
          hintText: "正在处理，请稍候…",
          requestFn: requestEnableAutoRenew,
          fallbackMessage: "操作完成",
          errorMessage: "开启自动续费失败",
        });
      }

      async function submitResetCodexQuotaPage() {
        await runAccountPageAction({
          buttonId: "reset_codex_quota_btn",
          confirmText: "确认要重置该账号的 Codex 额度吗？将消耗一次官方重置次数。",
          hintText: "正在重置 Codex 额度…",
          requestFn: requestResetCodexQuota,
          fallbackMessage: "已提交 Codex 额度重置请求",
          errorMessage: "重置 Codex 额度失败",
        });
      }

      async function cancelAutoRenewByJobKey(jobKey, triggerBtn) {
        if (!jobKey) {
          return;
        }
        if (!confirm("确认要关闭该 Session 对应账号的自动续费吗？")) {
          return;
        }
        const originalLabel = triggerBtn ? triggerBtn.textContent : "";
        if (triggerBtn) {
          triggerBtn.disabled = true;
          triggerBtn.textContent = "处理中…";
        }
        showMessage("正在取消自动续费，请稍候…", "warning");
        try {
          const { payload } = await fetchSessionPayload(jobKey);
          const sessionRaw = formatSessionPayload(payload);
          if (!sessionRaw) {
            showMessage("该记录没有完整 Session，无法取消续费", "warning");
            return;
          }
          const result = await requestCancelAutoRenew(sessionRaw, jobKey);
          applyAccountSessionWriteback(result);
          const pending = Boolean(
            result.pendingVerify ||
              (result.cancelled &&
                !result.confirmed &&
                !result.alreadyCancelled),
          );
          const msg = result.alreadyCancelled
            ? "取消续费成功：自动续费已关闭"
            : result.confirmed
              ? "取消续费成功：已确认自动续费关闭"
              : pending
                ? result.message || "取消请求已提交，状态尚未确认"
                : result.message || "取消续费操作完成";
          applyRenewalStatusFromResult(jobKey, result);
          showMessage(
            `${msg}${result.email ? `（${result.email}）` : ""}`,
            pending ? "warning" : "success",
          );
        } catch (error) {
          applyAccountSessionWriteback(error);
          showMessage(error.message || "取消自动续费失败", "error");
        } finally {
          if (triggerBtn) {
            triggerBtn.disabled = false;
            triggerBtn.textContent = originalLabel || "取消续费";
          }
        }
      }

      async function enableAutoRenewByJobKey(jobKey, triggerBtn) {
        if (!jobKey) {
          return;
        }
        if (!confirm("确认要开启该 Session 对应账号的自动续费吗？")) {
          return;
        }
        const originalLabel = triggerBtn ? triggerBtn.textContent : "";
        if (triggerBtn) {
          triggerBtn.disabled = true;
          triggerBtn.textContent = "处理中…";
        }
        showMessage("正在开启自动续费，请稍候…", "warning");
        try {
          const { payload } = await fetchSessionPayload(jobKey);
          const sessionRaw = formatSessionPayload(payload);
          if (!sessionRaw) {
            showMessage("该记录没有完整 Session，无法开启续费", "warning");
            return;
          }
          const result = await requestEnableAutoRenew(sessionRaw, jobKey);
          applyAccountSessionWriteback(result);
          const msg = result.message || "操作完成";
          applyRenewalStatusFromResult(jobKey, result);
          showMessage(
            `${msg}${result.email ? `（${result.email}）` : ""}`,
            "success",
          );
        } catch (error) {
          applyAccountSessionWriteback(error);
          showMessage(error.message || "开启自动续费失败", "error");
        } finally {
          if (triggerBtn) {
            triggerBtn.disabled = false;
            triggerBtn.textContent = originalLabel || "开启续费";
          }
        }
      }

      function downloadTextFile(filename, content) {
        const blob = new Blob([content], {
          type: "application/json;charset=utf-8",
        });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }

      async function exportSessionByJobKey(jobKey) {
        try {
          const { payload } = await fetchSessionPayload(jobKey);
          const formatted = formatSessionPayload(payload);
          if (!formatted) {
            showMessage("该记录没有完整 Session 可导出", "warning");
            return;
          }
          downloadTextFile(`session_${jobKey}.json`, formatted);
          showMessage("Session 已导出", "success");
        } catch (error) {
          showMessage(error.message || "导出失败", "error");
        }
      }

      function copySessionModalContent() {
        if (!sessionModalPayload) {
          showMessage("没有可复制的 Session 内容", "warning");
          return;
        }
        copyTextToClipboard(sessionModalPayload)
          .then(() => showMessage("Session 已复制到剪贴板", "success"))
          .catch((error) => showMessage(error.message || "复制失败", "error"));
      }

      function exportSessionModalContent() {
        if (!sessionModalPayload || !sessionModalJobKey) {
          showMessage("没有可导出的 Session 内容", "warning");
          return;
        }
        downloadTextFile(
          `session_${sessionModalJobKey}.json`,
          sessionModalPayload,
        );
        showMessage("Session 已导出", "success");
      }

      function renderTaskMediaCell(task) {
        const screenshotCount = Array.isArray(task?.screenshots)
          ? task.screenshots.length
          : 0;
        const videoCount = Array.isArray(task?.videos) ? task.videos.length : 0;
        const status = String(task?.status || "").toLowerCase();
        const running =
          status === "running" ||
          status === "retry" ||
          status === "processing";
        const shotBtn = screenshotCount
          ? `<button type="button" class="btn-icon" title="查看截图 (${screenshotCount})" data-view-screenshots="${escapeHtml(task.id)}"><i data-lucide="image"></i></button>`
          : `<button type="button" class="btn-icon is-disabled" title="${running ? "任务进行中，结束后可查看截图" : "暂无截图"}" disabled><i data-lucide="image"></i></button>`;
        const videoBtn = videoCount
          ? `<button type="button" class="btn-icon" title="查看录像 (${videoCount})" data-view-video="${escapeHtml(task.id)}"><i data-lucide="clapperboard"></i></button>`
          : `<button type="button" class="btn-icon is-disabled" title="${running ? "任务进行中，结束后可查看录像" : "暂无录像"}" disabled><i data-lucide="clapperboard"></i></button>`;
        return `<div class="task-media-actions">${shotBtn}${videoBtn}</div>`;
      }

      function closeTaskDetailModal() {
        const overlay = document.getElementById("task_detail_modal_overlay");
        const meta = document.getElementById("task_detail_modal_meta");
        const output = document.getElementById("task_detail_modal_output");
        overlay?.classList.remove("open");
        if (meta) meta.innerHTML = "";
        if (output) output.textContent = "";
      }

      async function openTaskDetailModal(jobKey) {
        const key = String(jobKey || "").trim();
        const overlay = document.getElementById("task_detail_modal_overlay");
        const meta = document.getElementById("task_detail_modal_meta");
        const output = document.getElementById("task_detail_modal_output");
        if (!key || !overlay || !meta || !output) return;

        const listTask = (window.__adminLogs || []).find(
          (item) => item.id === key,
        );
        output.textContent = "正在加载执行日志...";
        meta.innerHTML = "";
        overlay.classList.add("open");

        try {
          const res = await authFetch(
            `/api/admin/task-logs/${encodeURIComponent(key)}`,
          );
          const data = await res.json();
          if (!res.ok || !data.success) {
            throw new Error(data.message || "加载任务详情失败");
          }
          const task = data.task || {};
          const currentPhase =
            listTask?.automation?.phase || task.message || "-";
          const bound = task.boundCard || {};
          const cardLast4 = task.cardLast4 || bound.last4 || "";
          const isPaymentTask =
            String(listTask?.cdk || task.cdk || "").includes("payment-debug") ||
            String(listTask?.cdk || task.cdk || "").includes("custom-pay") ||
            getTaskType(listTask) === "支付调试" ||
            getTaskType(listTask) === "自定义付款" ||
            Boolean(cardLast4);
          const entries = [
            ["任务 ID", key],
            ["任务类型", getTaskType(listTask)],
            ["执行时间", listTask?.time || "-"],
            ["激活码", task.cdk || listTask?.cdk || "-"],
            ["充值账号", listTask?.token || "-"],
            ["当前状态", task.status || listTask?.status || "-"],
            [
              "执行进度",
              `${Number(task.progress ?? listTask?.progress ?? 0)}%`,
            ],
            [
              "任务用时",
              formatDurationText(
                task.durationSeconds ?? listTask?.durationSeconds ?? 0,
              ),
            ],
            ["当前阶段", currentPhase],
          ];
          if (isPaymentTask) {
            entries.push(["绑定卡片", cardLast4 ? `**** ${cardLast4}` : "-"]);
            if (bound.holder) entries.push(["持卡人", bound.holder]);
            if (bound.expiry) entries.push(["有效期", bound.expiry]);
            if (bound.address) entries.push(["账单地址", bound.address]);
          }
          meta.innerHTML = entries
            .map(
              ([label, value]) =>
                `<div><strong>${escapeHtml(label)}：</strong>${escapeHtml(value)}</div>`,
            )
            .join("");
          const logEntries = parseTaskLogEntries(task.output, key);
          if (logEntries.length) {
            renderRuntimeLogEntries(
              logEntries,
              false,
              "task_detail_modal_output",
            );
          } else {
            output.textContent = "暂无可用执行日志";
          }
        } catch (error) {
          output.textContent = "";
          meta.innerHTML = `<span style="color:var(--error);">${escapeHtml(error.message || "加载任务详情失败")}</span>`;
        }
      }

      async function showTaskScreenshotsByJobKey(jobKey) {
        const fromHistory = checkoutDebugHistory.find(
          (item) => item.id === jobKey || item.jobKey === jobKey,
        );
        const task =
          fromHistory ||
          (window.__adminLogs || []).find((item) => item.id === jobKey);
        const screenshots =
          (checkoutDebugJobKey === jobKey && checkoutDebugMedia.screenshots.length
            ? checkoutDebugMedia.screenshots
            : null) ||
          (Array.isArray(task?.screenshots) ? task.screenshots : []);
        if (!screenshots.length) {
          showMessage("该任务暂无失败截图", "warning");
          return;
        }
        await showTaskScreenshots(screenshots, task?.message || "");
      }

      async function showTaskVideoByJobKey(jobKey) {
        const fromHistory = checkoutDebugHistory.find(
          (item) => item.id === jobKey || item.jobKey === jobKey,
        );
        const task =
          fromHistory ||
          (window.__adminLogs || []).find((item) => item.id === jobKey);
        const videos =
          (checkoutDebugJobKey === jobKey && checkoutDebugMedia.videos.length
            ? checkoutDebugMedia.videos
            : null) ||
          (Array.isArray(task?.videos) ? task.videos : []);
        if (!videos.length) {
          showMessage("该任务暂无录像", "warning");
          return;
        }
        const overlay = document.getElementById("screenshot_modal_overlay");
        const body = document.getElementById("screenshot_modal_body");
        if (!overlay || !body) return;
        closeScreenshotModal();
        overlay.classList.add("open");
        const blocks = videos.map((rel) => {
          const src = buildVideoApiPath(rel);
          if (!src) {
            return `<p style="color:#f87171;">无法加载录像：${escapeHtml(rel)}</p>`;
          }
          return `
                          <div style="margin-bottom:16px;">
                              <div style="font-size:12px; color:var(--text-dim); margin-bottom:6px;">${escapeHtml(rel)}</div>
                              <video src="${src}" controls playsinline preload="metadata" style="width:100%; border-radius:8px; background:#000;"></video>
                              <div style="display:flex; gap:8px; flex-wrap:wrap; margin-top:8px;">
                                  <a class="btn btn-secondary" href="${src}" target="_blank" rel="noopener">浏览打开</a>
                                  <button type="button" class="btn btn-secondary" data-copy-video-url="${src.replace(/"/g, "&quot;")}">复制链接</button>
                              </div>
                              <p style="font-size:12px; color:var(--text-dim); margin:8px 0 0;">VS Code 内置预览经常播不了 WebM，请点上面用 Edge 打开。</p>
                          </div>
                      `;
        });
        body.innerHTML = `<p style="color:var(--text-dim); margin:0 0 12px;">自动化全程录像（可拖动进度条查看卡在哪一步）</p>${blocks.join("") || '<p style="color:var(--text-dim);">暂无录像</p>'}`;
      }

      async function showTaskScreenshots(screenshots, title = "") {
        const overlay = document.getElementById("screenshot_modal_overlay");
        const body = document.getElementById("screenshot_modal_body");
        if (!overlay || !body) {
          return;
        }
        closeScreenshotModal();
        overlay.classList.add("open");
        body.innerHTML = `<p style="color:var(--text-dim); margin:0 0 12px;">${escapeHtml(title || "自动化连续失败，请根据截图人工处理 Stripe 页面")}</p><p style="color:var(--text-dim);">加载截图中...</p>`;

        const blocks = [];
        for (const relativePath of screenshots) {
          const apiPath = buildScreenshotApiPath(relativePath);
          if (!apiPath) {
            continue;
          }
          try {
            const res = await authFetch(apiPath);
            if (!res.ok) {
              blocks.push(
                `<p style="color:#f87171;">无法加载：${escapeHtml(relativePath)}</p>`,
              );
              continue;
            }
            const blob = await res.blob();
            const objectUrl = URL.createObjectURL(blob);
            screenshotObjectUrls.push(objectUrl);
            blocks.push(`
                              <div>
                                  <div style="font-size:12px; color:var(--text-dim); margin-bottom:6px;">${escapeHtml(relativePath)}</div>
                                  <img src="${objectUrl}" alt="${escapeHtml(relativePath)}">
                              </div>
                          `);
          } catch (error) {
            blocks.push(
              `<p style="color:#f87171;">加载失败：${escapeHtml(relativePath)} (${escapeHtml(error.message)})</p>`,
            );
          }
        }
        body.innerHTML = `<p style="color:var(--text-dim); margin:0 0 12px;">${escapeHtml(title || "自动化连续失败，请根据截图人工处理 Stripe 页面")}</p>${blocks.join("") || '<p style="color:var(--text-dim);">暂无截图</p>'}`;
      }

      function showMessage(content, type = "success") {
        const container = document.getElementById("message_container");
        if (!container) return;
        const item = document.createElement("div");
        item.className = `message-item message-${type}`;
        const iconMap = {
          success: "check-circle-2",
          error: "x-circle",
          warning: "alert-triangle",
          info: "info",
        };
        const icon = iconMap[type] || "info";
        item.innerHTML = `<i data-lucide="${icon}"></i><span>${escapeHtml(String(content || ""))}</span>`;
        container.appendChild(item);
        lucide.createIcons();
        setTimeout(() => {
          item.style.opacity = "0";
          item.style.transform = "none";
          item.style.transition = "0.2s";
          setTimeout(() => item.remove(), 220);
        }, 2400);
      }

      let adminConfirmResolver = null;

      function showAdminConfirm(message, title, extraHtml) {
        return new Promise((resolve) => {
          const overlay = document.getElementById("admin_confirm_overlay");
          const textEl = document.getElementById("admin_confirm_text");
          const titleEl = document.getElementById("admin_confirm_title");
          const extraEl = document.getElementById("admin_confirm_extra");
          if (!overlay || !textEl) {
            resolve(false);
            return;
          }
          if (titleEl) {
            titleEl.textContent =
              title && String(title).trim() ? String(title).trim() : "请确认";
          }
          textEl.textContent = message;
          if (extraEl) {
            extraEl.innerHTML = extraHtml || "";
            extraEl.hidden = !extraHtml;
            enhanceAssetSelects(extraEl);
          }
          overlay.classList.add("is-open");
          overlay.setAttribute("aria-hidden", "false");
          adminConfirmResolver = resolve;
          lucide.createIcons();
          const okBtn = document.getElementById("admin_confirm_ok");
          if (okBtn) {
            setTimeout(() => okBtn.focus(), 0);
          }
        });
      }

      function closeAdminConfirm(result) {
        const overlay = document.getElementById("admin_confirm_overlay");
        const extraEl = document.getElementById("admin_confirm_extra");
        if (overlay) {
          overlay.classList.remove("is-open");
          overlay.setAttribute("aria-hidden", "true");
        }
        const extraValue =
          extraEl && extraEl.querySelector("[data-confirm-value]");
        const extraPayload =
          extraEl && extraEl.querySelector("[data-confirm-extra]");
        const payload = extraValue
          ? {
              source: extraValue.value || "pool",
              extra: extraPayload ? extraPayload.value : "",
            }
          : true;
        if (extraEl) extraEl.innerHTML = "";
        const r = adminConfirmResolver;
        adminConfirmResolver = null;
        if (r) {
          r(result ? payload : false);
        }
      }

      document.addEventListener("keydown", (e) => {
        if (e.key !== "Escape") return;
        if (document.querySelector(".ui-select.open, .ui-date.open, .filter-dropdown.open")) {
          e.preventDefault();
          closeFilterMenus();
          return;
        }
        if (adminConfirmResolver) {
          e.preventDefault();
          closeAdminConfirm(false);
        }
      });

      function getPageItems(list, stateKey) {
        const state = paginationState[stateKey];
        const items = Array.isArray(list) ? list : [];
        const total = items.length;
        const pageSize = state.pageSize;
        const totalPages = Math.max(1, Math.ceil(total / pageSize));
        state.page = Math.min(Math.max(1, state.page), totalPages);
        const start = (state.page - 1) * pageSize;
        return {
          items: items.slice(start, start + pageSize),
          page: state.page,
          pageSize,
          total,
          totalPages,
          start,
        };
      }

      function getFilteredTaskLogs(logs) {
        const type = String(taskLogFilters.type || "all");
        const cdk = String(taskLogFilters.cdk || "")
          .trim()
          .toLowerCase();
        const account = String(taskLogFilters.account || "")
          .trim()
          .toLowerCase();
        const status = String(taskLogFilters.status || "all");
        const filtered = (Array.isArray(logs) ? logs : []).filter((task) => {
          if (type !== "all" && getTaskType(task) !== type) return false;
          if (
            cdk &&
            !String(task.cdk || "")
              .toLowerCase()
              .includes(cdk)
          ) {
            return false;
          }
          if (
            account &&
            !String(task.token || "")
              .toLowerCase()
              .includes(account)
          ) {
            return false;
          }
          const taskStatus = String(task.status || "");
          if (status === "all") return true;
          if (status === "running") {
            return (
              taskStatus === "running" ||
              taskStatus === "retry" ||
              taskStatus === "processing"
            );
          }
          if (status === "failed") {
            return (
              taskStatus === "failed" ||
              taskStatus === "manual" ||
              taskStatus === "maintenance" ||
              taskStatus === "card_invalid"
            );
          }
          return taskStatus === status;
        });
        return filtered.sort((left, right) => {
          const isActive = (value) =>
            value === "running" || value === "retry" || value === "processing";
          const leftRunning = isActive(String(left.status || "")) ? 1 : 0;
          const rightRunning = isActive(String(right.status || "")) ? 1 : 0;
          return rightRunning - leftRunning;
        });
      }

      function updateTaskLogFilter(key, value) {
        if (!(key in taskLogFilters)) return;
        taskLogFilters[key] = String(value || "");
        paginationState.log.page = 1;
        renderLogTable(window.__adminLogs || []);
      }

      function clearTaskLogFilters() {
        Object.assign(taskLogFilters, {
          type: "all",
          cdk: "",
          account: "",
          status: "all",
        });
        ["type", "cdk", "account", "status"].forEach((key) => {
          const input = document.getElementById(`task_filter_${key}`);
          if (input) {
            input.value = taskLogFilters[key];
            if (input.tagName === "SELECT") syncUiSelect(input);
          }
        });
        paginationState.log.page = 1;
        renderLogTable(window.__adminLogs || []);
      }

      function isAssetActive(item) {
        return item && item.is_active !== 0 && item.status !== "invalid";
      }

      function getFilteredItems(type) {
        const filter = tableFilters[type] || "all";
        const source =
          type === "phone_pool"
            ? phonePool
            : type === "card_pool"
              ? cardPool
              : type === "cdk"
                ? cdkPool
                : productPool;
        let result = source;
        if (type === "phone_pool" || type === "card_pool") {
          result =
            filter === "all"
              ? source
              : source.filter((item) =>
                  filter === "normal"
                    ? isAssetActive(item)
                    : !isAssetActive(item),
                );
          return result;
        }
        if (type === "cdk") {
          result = filterCdkItems(source, {
            status: filter,
            planType: cdkPlanTypeFilter,
            groupId: cdkGroupFilter,
            keyword: tableSearch.cdk,
          });
        }
        if (type === "product") {
          if (filter === "today") {
            const todayStr = formatAdminDateTime(new Date()).split(" ")[0];
            result = source.filter((item) =>
              String(item.time).startsWith(todayStr),
            );
          } else if (filter === "yesterday") {
            const y = new Date();
            y.setDate(y.getDate() - 1);
            const yStr = formatAdminDateTime(y).split(" ")[0];
            result = source.filter((item) =>
              String(item.time).startsWith(yStr),
            );
          } else if (filter === "status_normal") {
            result = source.filter((item) => item.status === "正常");
          } else if (filter === "status_disabled") {
            result = source.filter((item) => item.status === "封禁");
          } else if (filter === "shipped") {
            result = source.filter((item) => item.shipped);
          } else if (filter === "unshipped") {
            result = source.filter((item) => !item.shipped);
          }
          const keyword = String(tableSearch.product || "")
            .trim()
            .toUpperCase();
          if (keyword) {
            result = result.filter((item) => {
              const email = typeof item === "string" ? item : item.email || "";
              return String(email).toUpperCase().includes(keyword);
            });
          }
          return result;
        }
        return result;
      }

      function setFilter(type, value) {
        tableFilters[type] = value;
        paginationState[type].page = 1;
        if (type === "phone_pool") renderPhoneTable();
        if (type === "card_pool") renderCardTable();
        if (type === "cdk") {
          loadCdkList().catch((error) => {
            console.error("Failed to load CDK list", error);
          });
        }
        if (type === "product") renderProductTable();
      }

      function handleProductSearch(value) {
        tableSearch.product = String(value || "");
        paginationState.product.page = 1;
        renderProductTable();
      }

      function handleCdkSearch(value) {
        tableSearch.cdk = String(value || "");
        paginationState.cdk.page = 1;
        if (cdkSearchTimer) {
          clearTimeout(cdkSearchTimer);
        }
        cdkSearchTimer = setTimeout(() => {
          loadCdkList().catch((error) => {
            console.error("Failed to load CDK list", error);
          });
        }, 250);
      }

      function closeFilterMenus() {
        document
          .querySelectorAll(".filter-dropdown.open, .ui-select.open, .ui-date.open")
          .forEach((dropdown) => dropdown.classList.remove("open"));
      }

      function toggleFilterMenu(type) {
        const dropdown = document.querySelector(
          `.filter-dropdown[data-filter="${type}"]`,
        );
        const shouldOpen = !dropdown?.classList.contains("open");
        closeFilterMenus();
        if (shouldOpen) {
          dropdown?.classList.add("open");
        }
      }

      function selectFilter(type, value, label) {
        const dropdown = document.querySelector(
          `.filter-dropdown[data-filter="${type}"]`,
        );
        dropdown
          ?.querySelector(".filter-trigger span")
          ?.replaceChildren(document.createTextNode(label));
        dropdown
          ?.querySelectorAll(".filter-option")
          .forEach((option) => option.classList.remove("active"));
        const activeOption = Array.from(
          dropdown?.querySelectorAll(".filter-option") || [],
        ).find((option) => option.textContent.trim() === label);
        activeOption?.classList.add("active");
        closeFilterMenus();
        setFilter(type, value);
      }

      document.addEventListener("click", (event) => {
        if (
          !event.target.closest(".filter-dropdown") &&
          !event.target.closest(".ui-select") &&
          !event.target.closest(".ui-date")
        ) {
          closeFilterMenus();
        }
      });

      function getSelectOptionLabel(option) {
        return String(option?.textContent || option?.label || "").trim();
      }

      function syncUiSelect(select) {
        const wrap = select?.closest(".ui-select");
        if (!wrap) return;
        const labelEl = wrap.querySelector(".ui-select-trigger span");
        const menu = wrap.querySelector(".ui-select-menu");
        if (!labelEl || !menu) return;
        const selected = select.options[select.selectedIndex];
        labelEl.textContent = selected
          ? getSelectOptionLabel(selected)
          : "";
        const current = String(select.value ?? "");
        menu.querySelectorAll(".ui-select-option").forEach((btn) => {
          btn.classList.toggle(
            "active",
            String(btn.dataset.value ?? "") === current,
          );
        });
      }

      function rebuildUiSelectMenu(select) {
        const wrap = select?.closest(".ui-select");
        const menu = wrap?.querySelector(".ui-select-menu");
        if (!menu) return;
        menu.replaceChildren();
        Array.from(select.options).forEach((option) => {
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = "ui-select-option";
          btn.dataset.value = option.value;
          btn.textContent = getSelectOptionLabel(option);
          btn.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            if (select.value !== option.value) {
              select.value = option.value;
              select.dispatchEvent(new Event("change", { bubbles: true }));
            }
            syncUiSelect(select);
            closeFilterMenus();
          });
          menu.appendChild(btn);
        });
        syncUiSelect(select);
      }

      function enhanceSelect(select) {
        if (!select || select.dataset.uiSelect === "1") return;
        const wrap = document.createElement("div");
        wrap.className = "ui-select";
        if (select.style.width) {
          wrap.style.width = select.style.width;
          wrap.classList.add("is-inline");
        }
        select.parentNode.insertBefore(wrap, select);
        wrap.appendChild(select);
        const trigger = document.createElement("button");
        trigger.type = "button";
        trigger.className = "ui-select-trigger";
        trigger.setAttribute("aria-haspopup", "listbox");
        const label = document.createElement("span");
        const chevron = document.createElement("i");
        chevron.setAttribute("data-lucide", "chevron-down");
        trigger.append(label, chevron);
        const menu = document.createElement("div");
        menu.className = "ui-select-menu";
        wrap.append(trigger, menu);
        select.dataset.uiSelect = "1";
        trigger.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          const shouldOpen = !wrap.classList.contains("open");
          closeFilterMenus();
          if (shouldOpen) wrap.classList.add("open");
        });
        select.addEventListener("change", () => syncUiSelect(select));
        const valueDesc = Object.getOwnPropertyDescriptor(
          HTMLSelectElement.prototype,
          "value",
        );
        if (valueDesc?.set && valueDesc?.get) {
          Object.defineProperty(select, "value", {
            configurable: true,
            enumerable: valueDesc.enumerable,
            get() {
              return valueDesc.get.call(this);
            },
            set(next) {
              valueDesc.set.call(this, next);
              syncUiSelect(this);
            },
          });
        }
        const observer = new MutationObserver(() => rebuildUiSelectMenu(select));
        observer.observe(select, {
          childList: true,
          subtree: true,
          characterData: true,
        });
        rebuildUiSelectMenu(select);
      }

      function enhanceAssetSelects(root = document) {
        root
          .querySelectorAll("select.asset-input")
          .forEach((select) => enhanceSelect(select));
        enhanceDateInputs(root);
        if (typeof lucide !== "undefined") lucide.createIcons();
      }

      function padDatePart(value) {
        return String(value).padStart(2, "0");
      }

      function formatDateInputValue(year, month, day) {
        return `${year}-${padDatePart(month)}-${padDatePart(day)}`;
      }

      function parseDateInputValue(value) {
        const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
        if (!match) return null;
        const year = Number(match[1]);
        const month = Number(match[2]);
        const day = Number(match[3]);
        const date = new Date(year, month - 1, day);
        if (
          date.getFullYear() !== year ||
          date.getMonth() !== month - 1 ||
          date.getDate() !== day
        ) {
          return null;
        }
        return date;
      }

      function formatDateTriggerLabel(value) {
        const date = parseDateInputValue(value);
        if (!date) return "年 / 月 / 日";
        return `${date.getFullYear()}-${padDatePart(date.getMonth() + 1)}-${padDatePart(date.getDate())}`;
      }

      function syncUiDate(input) {
        const wrap = input?.closest(".ui-date");
        if (!wrap) return;
        const labelEl = wrap.querySelector(".ui-date-trigger span");
        const trigger = wrap.querySelector(".ui-date-trigger");
        if (!labelEl || !trigger) return;
        const value = String(input.value || "");
        labelEl.textContent = formatDateTriggerLabel(value);
        trigger.classList.toggle("is-empty", !value);
      }

      function renderUiDateMenu(input, viewDate) {
        const wrap = input?.closest(".ui-date");
        const menu = wrap?.querySelector(".ui-date-menu");
        if (!menu) return;
        const selected = parseDateInputValue(input.value);
        const today = new Date();
        const view = viewDate
          ? new Date(viewDate.getFullYear(), viewDate.getMonth(), 1)
          : new Date(
              (selected || today).getFullYear(),
              (selected || today).getMonth(),
              1,
            );
        wrap._uiDateView = view;
        const year = view.getFullYear();
        const month = view.getMonth();
        const firstWeekday = (new Date(year, month, 1).getDay() + 6) % 7;
        const daysInMonth = new Date(year, month + 1, 0).getDate();
        const prevDays = new Date(year, month, 0).getDate();
        const weekdays = ["一", "二", "三", "四", "五", "六", "日"];
        const cells = [];
        for (let i = 0; i < 42; i += 1) {
          const offset = i - firstWeekday + 1;
          let cellYear = year;
          let cellMonth = month + 1;
          let cellDay = offset;
          let outside = false;
          if (offset < 1) {
            cellMonth = month;
            cellDay = prevDays + offset;
            outside = true;
            if (cellMonth < 1) {
              cellMonth = 12;
              cellYear -= 1;
            }
          } else if (offset > daysInMonth) {
            cellMonth = month + 2;
            cellDay = offset - daysInMonth;
            outside = true;
            if (cellMonth > 12) {
              cellMonth = 1;
              cellYear += 1;
            }
          }
          const value = formatDateInputValue(cellYear, cellMonth, cellDay);
          const isSelected = input.value === value;
          const isToday =
            today.getFullYear() === cellYear &&
            today.getMonth() + 1 === cellMonth &&
            today.getDate() === cellDay;
          cells.push(
            `<button type="button" class="ui-date-day${outside ? " is-outside" : ""}${isSelected ? " is-selected" : ""}${isToday ? " is-today" : ""}" data-date="${value}">${cellDay}</button>`,
          );
        }
        menu.innerHTML = `
          <div class="ui-date-head">
            <button type="button" class="ui-date-nav" data-date-nav="prev" aria-label="上一月"><i data-lucide="chevron-left"></i></button>
            <div class="ui-date-month">${year}年${padDatePart(month + 1)}月</div>
            <button type="button" class="ui-date-nav" data-date-nav="next" aria-label="下一月"><i data-lucide="chevron-right"></i></button>
          </div>
          <div class="ui-date-week">${weekdays.map((day) => `<span>${day}</span>`).join("")}</div>
          <div class="ui-date-grid">${cells.join("")}</div>
          <div class="ui-date-foot">
            <button type="button" data-date-action="clear">清除</button>
            <button type="button" data-date-action="today">今天</button>
          </div>
        `;
        if (typeof lucide !== "undefined") lucide.createIcons();
      }

      function setUiDateValue(input, value) {
        if (input.value !== value) {
          input.value = value;
          input.dispatchEvent(new Event("change", { bubbles: true }));
          input.dispatchEvent(new Event("input", { bubbles: true }));
        }
        syncUiDate(input);
      }

      function enhanceDateInput(input) {
        if (!input || input.dataset.uiDate === "1") return;
        const wrap = document.createElement("div");
        wrap.className = "ui-date";
        input.parentNode.insertBefore(wrap, input);
        wrap.appendChild(input);
        const trigger = document.createElement("button");
        trigger.type = "button";
        trigger.className = "ui-date-trigger is-empty";
        trigger.setAttribute("aria-haspopup", "dialog");
        const label = document.createElement("span");
        const icon = document.createElement("i");
        icon.setAttribute("data-lucide", "calendar");
        trigger.append(label, icon);
        const menu = document.createElement("div");
        menu.className = "ui-date-menu";
        wrap.append(trigger, menu);
        input.dataset.uiDate = "1";
        trigger.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          const shouldOpen = !wrap.classList.contains("open");
          closeFilterMenus();
          if (!shouldOpen) return;
          renderUiDateMenu(input, wrap._uiDateView || parseDateInputValue(input.value));
          wrap.classList.add("open");
        });
        menu.addEventListener("click", (event) => {
          event.stopPropagation();
          const nav = event.target.closest("[data-date-nav]");
          if (nav) {
            const view = wrap._uiDateView || new Date();
            const next =
              nav.dataset.dateNav === "prev"
                ? new Date(view.getFullYear(), view.getMonth() - 1, 1)
                : new Date(view.getFullYear(), view.getMonth() + 1, 1);
            renderUiDateMenu(input, next);
            return;
          }
          const action = event.target.closest("[data-date-action]");
          if (action) {
            if (action.dataset.dateAction === "clear") {
              setUiDateValue(input, "");
            } else {
              const today = new Date();
              setUiDateValue(
                input,
                formatDateInputValue(
                  today.getFullYear(),
                  today.getMonth() + 1,
                  today.getDate(),
                ),
              );
            }
            closeFilterMenus();
            return;
          }
          const day = event.target.closest("[data-date]");
          if (!day) return;
          setUiDateValue(input, day.dataset.date || "");
          closeFilterMenus();
        });
        input.addEventListener("change", () => syncUiDate(input));
        const valueDesc = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          "value",
        );
        if (valueDesc?.set && valueDesc?.get) {
          Object.defineProperty(input, "value", {
            configurable: true,
            enumerable: valueDesc.enumerable,
            get() {
              return valueDesc.get.call(this);
            },
            set(next) {
              valueDesc.set.call(this, next);
              syncUiDate(this);
            },
          });
        }
        syncUiDate(input);
      }

      function enhanceDateInputs(root = document) {
        root
          .querySelectorAll('input[type="date"]')
          .forEach((input) => enhanceDateInput(input));
      }

      function changePage(stateKey, nextPage) {
        paginationState[stateKey].page = nextPage;
        if (stateKey === "phone_pool") renderPhoneTable();
        if (stateKey === "card_pool") renderCardTable();
        if (stateKey === "card_assets") {
          loadCardPoolList().catch((error) => {
            console.error("Failed to load card pool", error);
          });
        }
        if (stateKey === "cdk") {
          loadCdkList().catch((error) => {
            console.error("Failed to load CDK list", error);
          });
        }
        if (stateKey === "log") renderLogTable(window.__adminLogs || []);
      }

      function getItemKey(type, item) {
        if (type === "phone_pool") return item.phone || "";
        if (type === "card_pool") return item.number || "";
        if (type === "cdk")
          return typeof item === "string" ? item : item.code || "";
        if (type === "product") return String(item.id || "");
        return "";
      }

      function toggleSelection(type, key, checked) {
        if (!key) return;
        if (checked) {
          selectedItems[type].add(key);
        } else {
          selectedItems[type].delete(key);
        }
      }

      function togglePageSelection(type) {
        const pageItems =
          type === "cdk"
            ? cdkPool
            : getPageItems(getFilteredItems(type), type).items;
        const keys = pageItems
          .map((item) => getItemKey(type, item))
          .filter(Boolean);
        const shouldSelect = keys.some((key) => !selectedItems[type].has(key));
        keys.forEach((key) => {
          if (shouldSelect) {
            selectedItems[type].add(key);
          } else {
            selectedItems[type].delete(key);
          }
        });
        if (type === "phone_pool") renderPhoneTable();
        if (type === "card_pool") renderCardTable();
        if (type === "cdk") renderCDKTable();
        if (type === "product") renderProductTable();
      }

      function selectUnusedOnPage(type) {
        if (type !== "cdk") return;
        const pageItems = Array.isArray(cdkPool) ? cdkPool : [];
        let count = 0;
        pageItems.forEach((item) => {
          const code = getItemKey("cdk", item);
          const status =
            typeof item === "string" ? "unused" : item.status || "unused";
          if (code && status === "unused") {
            selectedItems.cdk.add(code);
            count += 1;
          }
        });
        renderCDKTable();
        if (count > 0) {
          showMessage(`已选中本页 ${count} 个未使用 CDK`, "success");
        } else {
          showMessage("本页没有未使用的 CDK", "warning");
        }
      }

      function pruneSelection(type, source) {
        const validKeys = new Set(
          (Array.isArray(source) ? source : [])
            .map((item) => getItemKey(type, item))
            .filter(Boolean),
        );
        Array.from(selectedItems[type]).forEach((key) => {
          if (!validKeys.has(key)) {
            selectedItems[type].delete(key);
          }
        });
      }

      function getPaginationItems(currentPage, totalPages) {
        if (totalPages <= 7) {
          return Array.from({ length: totalPages }, (_, index) => index + 1);
        }

        const pages = new Set([
          1,
          totalPages,
          currentPage - 1,
          currentPage,
          currentPage + 1,
        ]);

        if (currentPage <= 3) {
          pages.add(2);
          pages.add(3);
          pages.add(4);
        }

        if (currentPage >= totalPages - 2) {
          pages.add(totalPages - 1);
          pages.add(totalPages - 2);
          pages.add(totalPages - 3);
        }

        const sortedPages = [...pages]
          .filter((page) => page >= 1 && page <= totalPages)
          .sort((left, right) => left - right);

        const items = [];
        sortedPages.forEach((page, index) => {
          if (index > 0 && page - sortedPages[index - 1] > 1) {
            items.push("ellipsis");
          }
          items.push(page);
        });

        return items;
      }

      function renderPagination(containerId, stateKey, total) {
        const state = paginationState[stateKey];
        const container = document.getElementById(containerId);
        if (!state || !container) return;
        const totalPages = Math.max(1, Math.ceil(total / state.pageSize));
        const start = total === 0 ? 0 : (state.page - 1) * state.pageSize + 1;
        const end = Math.min(state.page * state.pageSize, total);
        const pageItems = getPaginationItems(state.page, totalPages);
        container.innerHTML = `
                      <div class="pagination-meta">共 ${total} 条，当前显示 ${start}-${end}</div>
                      <div class="pagination">
                          <button class="pagination-nav" onclick="changePage('${stateKey}', ${state.page - 1})" ${state.page <= 1 ? "disabled" : ""}>上一页</button>
                          ${pageItems
                            .map((item) =>
                              item === "ellipsis"
                                ? '<span class="pagination-ellipsis">...</span>'
                                : `<button class="${item === state.page ? "active" : ""}" onclick="changePage('${stateKey}', ${item})">${item}</button>`,
                            )
                            .join("")}
                          <button class="pagination-nav" onclick="changePage('${stateKey}', ${state.page + 1})" ${state.page >= totalPages ? "disabled" : ""}>下一页</button>
                      </div>
                  `;
      }

      function resolveNavItem(pId, el) {
        if (el && el.classList.contains("nav-item")) {
          return el;
        }
        return (
          document.querySelector(`.nav-item[data-page="${pId}"]`) ||
          document.querySelector(`.nav-item[onclick*="'${pId}'"]`)
        );
      }

      function switchSystemLogTab(tab) {
        const next = tab === "login" ? "login" : "runtime";
        document
          .querySelectorAll("#system_log_tabs .page-tab")
          .forEach((btn) => {
            btn.classList.toggle("active", btn.dataset.tab === next);
          });
        document
          .getElementById("system_log_tab_runtime")
          ?.classList.toggle("active", next === "runtime");
        document
          .getElementById("system_log_tab_login")
          ?.classList.toggle("active", next === "login");
        if (next === "runtime") {
          startRuntimeLogStream();
        } else {
          stopRuntimeLogStream();
          loadAdminLoginLogs().catch(() => {});
        }
        lucide.createIcons();
      }

      function normalizePageId(pId) {
        if (pId === "sessions") {
          return "checkout_debug";
        }
        if (pId === "automation_tasks") {
          return "logs";
        }
        if (pId === "runtime_logs" || pId === "admin_login_logs") {
          return "system_logs";
        }
        return pId;
      }

      function switchConfigSection(sectionId, el) {
        const id = String(sectionId || "config_ops");
        document.querySelectorAll("#config .config-section").forEach((sec) => {
          sec.classList.toggle("active", sec.id === id);
        });
        document.querySelectorAll("#config .config-subnav-item").forEach((btn) => {
          btn.classList.toggle(
            "active",
            btn.getAttribute("data-config-section") === id,
          );
        });
        lucide.createIcons();
      }

      function switchPageInternal(pId, el) {
        const requestedPageId = pId;
        pId = normalizePageId(pId);
        document
          .querySelectorAll(".nav-item.active")
          .forEach((i) => i.classList.remove("active"));
        const page = document.getElementById(pId);
        if (!page) {
          console.error("Page not found:", pId);
          return;
        }
        page.classList.add("active");
        document.querySelectorAll(".page-view").forEach((p) => {
          if (p.id !== pId) p.classList.remove("active");
        });

        resolveNavItem(pId, el)?.classList.add("active");

        if (pId === "system_logs") {
          if (requestedPageId === "admin_login_logs") {
            switchSystemLogTab("login");
          } else {
            switchSystemLogTab("runtime");
          }
        } else {
          stopRuntimeLogStream();
        }

        if (pId === "config") {
          const current = document.querySelector("#config .config-section.active");
          switchConfigSection(current?.id || "config_ops");
        }
        if (pId === "billing") {
          loadBillingRecords(1).catch(() => {});
        }
        if (pId === "cards") {
          loadCardPoolList();
        }

        if (pId === "checkout_debug") {
          loadCheckoutDebugPage().catch(() => {});
          startCheckoutDebugLogStream();
        } else {
          stopCheckoutDebugLogStream();
        }

        if (pId === "tax_addresses") {
          loadAddressList("US").catch(() => {});
        }

        if (pId === "proxies") {
          loadProxyPool().catch(() => {});
        }

        if (pId === "browser_pool") {
          loadBrowserPoolPage(true).catch(() => {});
          startBrowserPoolAutoRefresh();
        } else {
          stopBrowserPoolAutoRefresh();
        }

        if (pId === "config") {
          reloadSystemConfigFromServer().catch(() => {});
          loadAdminSecurityStatus().catch(() => {});
        }

        if (pId === "cdks") {
          loadProxyGroupList().catch(() => {});
          loadCdkList().catch((error) => {
            console.error("Failed to load CDK list", error);
          });
        }

        if (pId === "cancel_renewal") {
          loadProxyGroupList().catch(() => {});
        }

        if (pId === "logs") {
          loadTaskLogs(false).catch((error) => {
            console.error("Failed to load task logs", error);
          });
        }
      }

      async function switchPage(pId, el) {
        switchPageInternal(pId, el);
      }

      function escapeHtml(str) {
        return String(str ?? "")
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;");
      }

      function renderPoolEmailsTable() {
        const tbody = document.getElementById("pool_emails_body");
        const hint = document.getElementById("pool_emails_empty_hint");
        if (!tbody) {
          return;
        }
        if (!poolEmailsList.length) {
          tbody.innerHTML = "";
          if (hint) {
            hint.style.display = "block";
          }
          lucide.createIcons();
          return;
        }
        if (hint) {
          hint.style.display = "none";
        }

        tbody.innerHTML = poolEmailsList
          .map((row) => {
            const id = Number(row.id);
            const regBadge = row.registered
              ? '<span class="status-badge status-success">已注册</span>'
              : '<span class="status-badge status-running">未注册</span>';
            const lockBadge = row.in_use
              ? '<span class="status-badge" style="background:rgba(245,158,11,0.15);color:#f59e0b;">占用中</span>'
              : '<span class="status-badge" style="opacity:.78;">空闲</span>';
            let pwdCell;
            if (row.has_oauth) {
              pwdCell =
                '<span class="status-badge status-success">OAuth2</span>';
            } else if (row.has_password) {
              pwdCell = '<span style="color:var(--text-secondary)">密码</span>';
            } else {
              pwdCell =
                '<span class="status-badge" style="background:rgba(239,68,68,0.12);color:#f87171;">缺失</span>';
            }
            const regAt = row.registered_at
              ? formatAdminDateTime(row.registered_at, true)
              : "-";
            const safeEmail = escapeHtml(row.email || "");
            return `
                      <tr>
                          <td><code>${safeEmail}</code></td>
                          <td style="text-align:center">${pwdCell}</td>
                          <td style="text-align:center">${regBadge}</td>
                          <td style="text-align:center">${lockBadge}</td>
                          <td>${escapeHtml(regAt)}</td>
                          <td style="text-align:center">
                              <button type="button" class="btn btn-success" style="padding:8px 12px;margin-right:8px;border-radius:10px;" onclick="previewPoolMailbox(${id})">
                                  <i data-lucide="inbox"></i> 邮件
                              </button>
                              <button type="button" class="btn-delete" onclick="deletePoolEmailRow(${id})">
                                  <i data-lucide="trash-2"></i>
                              </button>
                          </td>
                      </tr>`;
          })
          .join("");
        lucide.createIcons();
      }

      async function loadPoolEmails(showToast = false) {
        try {
          const res = await authFetch("/api/admin/pool-emails");
          const data = await res.json();
          if (!res.ok) {
            throw new Error(data.message || "加载邮箱列表失败");
          }
          poolEmailsList = Array.isArray(data.items) ? data.items : [];
          renderPoolEmailsTable();
          if (showToast) {
            showMessage("邮箱列表已刷新", "success");
          }
        } catch (error) {
          showMessage(error.message || "加载邮箱列表失败", "error");
        }
      }

      function handlePoolMailFileImport(ev) {
        const input = ev.target;
        const file = input.files && input.files[0];
        if (!file) {
          return;
        }
        const reader = new FileReader();
        reader.onload = () => {
          const ta = document.getElementById("pool_mail_import_text");
          if (ta) {
            ta.value = String(reader.result || "");
          }
          showMessage(`已载入文件：${file.name}`, "success");
        };
        reader.onerror = () => showMessage("读取文件失败", "error");
        reader.readAsText(file);
        input.value = "";
      }

      async function submitPoolMailImport() {
        const ta = document.getElementById("pool_mail_import_text");
        const text = ta ? ta.value.trim() : "";
        if (!text) {
          showMessage("请先粘贴内容或选择 mail.txt", "warning");
          return;
        }
        try {
          const res = await authFetch("/api/admin/pool-emails/import", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text }),
          });
          const data = await res.json();
          if (!res.ok || data.success === false) {
            throw new Error(data.message || "导入失败");
          }
          showMessage(data.message || "导入成功", "success");
          await loadPoolEmails(false);
        } catch (error) {
          showMessage(error.message || "导入失败", "error");
        }
      }

      async function previewPoolMailbox(id) {
        const panel = document.getElementById("pool_mail_preview_panel");
        const title = document.getElementById("pool_mail_preview_title");
        const tbody = document.getElementById("pool_mail_preview_body");
        if (!panel || !tbody) {
          return;
        }
        panel.style.display = "block";
        if (title) {
          title.textContent = `邮件预览 (#${id})`;
        }
        tbody.innerHTML = '<tr><td colspan="4">加载中...</td></tr>';
        try {
          const res = await authFetch(
            `/api/admin/pool-emails/${id}/messages?limit=50`,
          );
          const data = await res.json();
          if (!res.ok || data.success === false) {
            throw new Error(data.message || "加载失败");
          }
          const rows = data.messages || [];
          if (!rows.length) {
            tbody.innerHTML =
              '<tr><td colspan="4">暂无邮件（请确认密码支持 IMAP，且已在系统配置中启用垃圾箱）</td></tr>';
          } else {
            tbody.innerHTML = rows
              .map(
                (m) => `
                          <tr>
                              <td>${escapeHtml(m.folder)}</td>
                              <td>${escapeHtml(m.subject)}</td>
                              <td>${escapeHtml(m.from)}</td>
                              <td>${escapeHtml(m.date)}</td>
                          </tr>`,
              )
              .join("");
          }
          lucide.createIcons();
          panel.scrollIntoView({ behavior: "smooth", block: "start" });
        } catch (error) {
          tbody.innerHTML = `<tr><td colspan="4">${escapeHtml(error.message || "加载失败")}</td></tr>`;
        }
      }

      function closePoolMailPreview() {
        const panel = document.getElementById("pool_mail_preview_panel");
        if (panel) {
          panel.style.display = "none";
        }
      }

      async function deletePoolEmailRow(id) {
        const ok = await showAdminConfirm(
          `确定删除邮箱池记录 #${id} ?`,
          "删除邮箱",
        );
        if (!ok) {
          return;
        }
        try {
          const res = await authFetch(`/api/admin/pool-emails/${id}`, {
            method: "DELETE",
          });
          const data = await res.json();
          if (!res.ok || data.success === false) {
            throw new Error(data.message || "删除失败");
          }
          showMessage(data.message || "已删除", "success");
          await loadPoolEmails(false);
        } catch (error) {
          showMessage(error.message || "删除失败", "error");
        }
      }

      function scheduleSessionRefresh(expiresAt) {
        if (adminRefreshTimer) {
          clearTimeout(adminRefreshTimer);
        }

        const fallbackDelay = 55 * 60 * 1000;
        const delay = Math.max(
          60 * 1000,
          Math.min(
            fallbackDelay,
            Number(expiresAt || 0) - Date.now() - 5 * 60 * 1000,
          ),
        );
        adminRefreshTimer = setTimeout(() => {
          ensureAdminSession().catch(() => {});
        }, delay);
      }

      async function ensureAdminSession() {
        const response = await authFetch("/api/admin/session");
        const data = await response.json();
        if (data.loginPath) adminLoginPath = data.loginPath;
        if (data.checkoutUrl || data.checkoutPath) {
          setAdminCheckoutPath(data.checkoutUrl || data.checkoutPath);
        }
        scheduleSessionRefresh(data.expiresAt);
        return data;
      }

      async function reloadSystemConfigFromServer() {
        const res = await authFetch("/api/admin/data");
        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.message || "加载系统配置失败");
        }
        applySystemConfigFromData(data);
        await loadProxyGroupList();
        return data;
      }

      function applySystemConfigFromData(data) {
        const cfg = data?.config || {};
        const maxConcurrentEl = document.getElementById(
          "max_concurrent_activations",
        );
        if (maxConcurrentEl) {
          maxConcurrentEl.value = cfg.max_concurrent_activations || 1;
        }
        adminDefaultTimeZone = cfg.default_timezone || "Asia/Shanghai";
        const timeZoneEl = document.getElementById("default_timezone");
        if (timeZoneEl) {
          timeZoneEl.value = adminDefaultTimeZone;
        }
        defaultProxyGroupId = String(cfg.default_proxy_group_id || "");
        const defaultProxyEl = document.getElementById("default_proxy_group");
        if (defaultProxyEl) {
          defaultProxyEl.value = defaultProxyGroupId;
        }
        loadTelegramConfig(data.telegram || {});
        loadHcaptchaConfig(data.hcaptcha || {});
        lastMaintenanceModeValue = Boolean(cfg.maintenance_mode);
        const recordVideoEl = document.getElementById("record_video");
        if (recordVideoEl) {
          recordVideoEl.checked = Boolean(cfg.record_video);
        }
        updateMaintenanceModeUI(
          cfg,
          window.__adminRuntime || { active_activation_jobs: 0 },
        );
      }

      function setTextById(id, value) {
        const el = document.getElementById(id);
        if (el) el.innerText = value;
      }

      function setStyleById(id, property, value) {
        const el = document.getElementById(id);
        if (el) el.style.setProperty(property, value);
      }

      function decorateDashboardCards() {
        const icons = [
          "cpu",
          "memory-stick",
          "hard-drive",
          "clock-3",
          "list-todo",
          "circle-check-big",
          "circle-x",
          "key-round",
          "key-round",
          "key",
          "credit-card",
          "wallet-cards",
          "badge-dollar-sign",
          "gauge",
        ];
        document
          .querySelectorAll("#dashboard .stat-card")
          .forEach((card, index) => {
            if (card.querySelector(".stat-header")) return;
            const label = card.querySelector(".stat-label");
            if (!label) return;
            const header = document.createElement("div");
            header.className = "stat-header";
            const icon = document.createElement("span");
            icon.className = "stat-icon";
            icon.innerHTML = `<i data-lucide="${icons[index] || "chart-no-axes-column"}"></i>`;
            label.before(header);
            header.append(label, icon);
          });
        lucide.createIcons();
      }

      async function loadData(isInitial = false) {
        try {
          const res = await authFetch(
            isInitial ? "/api/admin/data" : "/api/admin/data?light=1",
          );
          const data = await res.json();
          setTextById(
            "stat_cpu_percent",
            `${Number(data.runtime?.system?.cpu?.percent || 0)}%`,
          );
          setTextById("stat_cpu_meta", data.runtime?.system?.cpu?.text || "");
          setTextById(
            "stat_memory_percent",
            `${Number(data.runtime?.system?.memory?.percent || 0)}%`,
          );
          setTextById(
            "stat_memory_meta",
            data.runtime?.system?.memory?.text || "0.0G/0.0G",
          );
          setTextById(
            "stat_disk_percent",
            `${Number(data.runtime?.system?.disk?.percent || 0)}%`,
          );
          setTextById(
            "stat_disk_meta",
            `${data.runtime?.system?.disk?.usedText || "0.0G"} / ${data.runtime?.system?.disk?.totalText || "0.0G"}`,
          );
          startUptimeTicker(data.runtime?.system?.uptime?.seconds || 0);
          setTextById("stat_total", data.stats.total);
          setTextById("stat_success", data.stats.success);
          setTextById("stat_failed", data.stats.failed);
          setTextById("stat_cdk_total", data.stats.cdk_total || 0);
          setTextById("stat_cdk_used", data.stats.cdk_used || 0);
          setTextById("stat_cdk_unused", data.stats.cdk_unused || 0);
          const billingRevenue = Number(data.stats.billing_revenue || 0);
          setTextById("stat_billing_revenue", billingRevenue.toFixed(2));
          setTextById(
            "stat_billing_paid_count",
            data.stats.billing_paid_count || 0,
          );
          setTextById("stat_card_total", data.stats.card_total || 0);
          setTextById(
            "stat_foreground_slots",
            `${Number(data.runtime?.active_foreground_jobs || 0)}/${Number(data.config.max_concurrent_activations || 1)}`,
          );
          const pool = data.runtime?.browser_pool;
          const poolMeta =
            pool?.enabled && pool?.size
              ? `浏览器池 ${pool.idle ?? 0}/${pool.size} 空闲${pool.waiting ? ` · 排队 ${pool.waiting}` : ""}`
              : "";
          setTextById("stat_foreground_slots_meta", poolMeta);

          const taskTotal = Math.max(0, Number(data.stats?.total || 0));
          const taskSuccess = Math.max(0, Number(data.stats?.success || 0));
          const taskRunning = Math.max(0, Number(data.stats?.running || 0));
          const taskFailed = Math.max(0, Number(data.stats?.failed || 0));
          const taskDenominator = Math.max(
            taskTotal,
            taskSuccess + taskRunning + taskFailed,
            1,
          );
          const setTaskSegment = (id, value) =>
            setStyleById(id, "width", `${(value / taskDenominator) * 100}%`);
          setTextById("dashboard_task_success", taskSuccess);
          setTextById("dashboard_task_running", taskRunning);
          setTextById("dashboard_task_failed", taskFailed);
          setTaskSegment("dashboard_task_success_bar", taskSuccess);
          setTaskSegment("dashboard_task_running_bar", taskRunning);
          setTaskSegment("dashboard_task_failed_bar", taskFailed);

          const planPlus = Math.max(0, Number(data.stats?.plan_plus || 0));
          const planPro = Math.max(0, Number(data.stats?.plan_pro || 0));
          const planCredits = Math.max(0, Number(data.stats?.plan_credits || 0));
          const planOther = Math.max(0, Number(data.stats?.plan_other || 0));
          const planDenominator = Math.max(
            planPlus + planPro + planCredits + planOther,
            1,
          );
          const setPlanSegment = (id, value) =>
            setStyleById(id, "width", `${(value / planDenominator) * 100}%`);
          setTextById("dashboard_plan_plus", planPlus);
          setTextById("dashboard_plan_pro", planPro);
          setTextById("dashboard_plan_credits", planCredits);
          setTextById("dashboard_plan_other", planOther);
          setPlanSegment("dashboard_plan_plus_bar", planPlus);
          setPlanSegment("dashboard_plan_pro_bar", planPro);
          setPlanSegment("dashboard_plan_credits_bar", planCredits);
          setPlanSegment("dashboard_plan_other_bar", planOther);

          [
            ["cpu", Number(data.runtime?.system?.cpu?.percent || 0)],
            ["memory", Number(data.runtime?.system?.memory?.percent || 0)],
            ["disk", Number(data.runtime?.system?.disk?.percent || 0)],
          ].forEach(([name, rawValue]) => {
            const percent = Math.min(100, Math.max(0, rawValue));
            const bar = document.getElementById(`dashboard_${name}_bar`);
            if (bar) {
              bar.style.width = `${percent}%`;
              bar.classList.toggle("warning", percent >= 70 && percent < 90);
              bar.classList.toggle("danger", percent >= 90);
            }
          });
          decorateDashboardCards();

          if (isInitial) {
            applySystemConfigFromData(data);
            loadCardPoolList();
            loadProxyGroupList().catch(() => {});
            lucide.createIcons();
          }

          window.__adminRuntime = data.runtime || { active_activation_jobs: 0 };
          if (!isInitial) {
            lastMaintenanceModeValue = Boolean(data.config.maintenance_mode);
            updateMaintenanceModeUI(data.config, window.__adminRuntime);
          }

          if (!isInitial) {
            return;
          }

          const logsPage = document.getElementById("logs");
          if (logsPage && logsPage.classList.contains("active")) {
            loadTaskLogs(false).catch(() => {});
          }

          const cdkPage = document.getElementById("cdks");
          if (cdkPage && cdkPage.classList.contains("active")) {
            try {
              await loadCdkList();
            } catch (cdkError) {
              console.error("Failed to load CDK list in loadData", cdkError);
            }
          }
        } catch (error) {
          console.error("Failed to load data", error);
        }
      }

      async function loadCdkList() {
        const requestId = ++cdkListRequestSeq;
        const page = Math.max(1, Number(paginationState.cdk.page) || 1);
        const pageSize = Math.max(
          1,
          Number(paginationState.cdk.pageSize) || 12,
        );
        const params = new URLSearchParams({
          page: String(page),
          pageSize: String(pageSize),
          status: String(tableFilters.cdk || "all"),
          plan_type: String(cdkPlanTypeFilter || "all"),
          group_id: String(cdkGroupFilter || "all"),
        });
        const keyword = String(tableSearch.cdk || "").trim();
        if (keyword) params.set("q", keyword);
        const cdkRes = await authFetch(`/api/admin/cdks?${params.toString()}`);
        let cdkData = [];
        try {
          cdkData = await cdkRes.json();
        } catch (parseError) {
          throw new Error("CDK 列表响应解析失败");
        }
        if (!cdkRes.ok) {
          throw new Error(
            cdkData?.message || `加载 CDK 失败（${cdkRes.status}）`,
          );
        }
        if (requestId !== cdkListRequestSeq) {
          return;
        }
        const pageItems = Array.isArray(cdkData)
          ? cdkData
          : Array.isArray(cdkData?.cdks)
            ? cdkData.cdks
            : [];
        cdkPool = pageItems;
        cdkTotal = Array.isArray(cdkData)
          ? pageItems.length
          : Number(cdkData?.total || pageItems.length);
        const nextPage = Number(cdkData?.page || page);
        const nextPageSize = Number(cdkData?.pageSize || pageSize);
        paginationState.cdk.page = Math.max(1, nextPage || 1);
        paginationState.cdk.pageSize = Math.max(1, nextPageSize || 12);
        await loadCardGroupList();
        if (requestId !== cdkListRequestSeq) {
          return;
        }
        renderCDKTable();
      }

      let sessionList = [];
      let sessionRenewalStatus = {};
      let sessionRenewalFetchInFlight = false;
      let sessionRenewalJobKeySnapshot = "";

      function getSessionRenewalJobKeys() {
        return sessionList
          .filter(
            (row) => row.status === "success" && row.has_session !== false,
          )
          .map((row) => row.job_key)
          .filter(Boolean);
      }

      function buildSessionRenewalSnapshot(jobKeys = []) {
        return [...jobKeys].sort().join("|");
      }

      function hasCachedRenewalStatuses(jobKeys = []) {
        return (
          jobKeys.length > 0 &&
          jobKeys.every((jobKey) => {
            const info = sessionRenewalStatus[jobKey];
            return info && typeof info === "object";
          })
        );
      }

      function renderAutoRenewCell(row) {
        if (row.status !== "success" || row.has_session === false) {
          return '<span style="color:var(--text-dim);">—</span>';
        }
        const info = sessionRenewalStatus[row.job_key];
        if (!info) {
          return '<span style="color:var(--text-dim); font-size:12px;">查询中…</span>';
        }
        if (!info.ok) {
          const err = escapeHtml(info.error || "查询失败");
          return `<span style="color:#f87171; font-size:12px;" title="${err}">失败</span>`;
        }
        if (!info.hasActiveSubscription) {
          return '<span style="color:var(--text-dim); font-size:12px;">无订阅</span>';
        }
        if (info.autoRenewRaw === true) {
          return '<span class="status-badge status-success">已开启</span>';
        }
        if (info.autoRenewRaw === false) {
          return '<span class="status-badge" style="background:rgba(251,191,36,0.12);color:#fbbf24;">已关闭</span>';
        }
        return '<span style="color:var(--text-dim);">—</span>';
      }

      async function refreshSessionRenewalStatuses(force = false) {
        const jobKeys = getSessionRenewalJobKeys();
        if (!jobKeys.length) {
          return;
        }

        const snapshot = buildSessionRenewalSnapshot(jobKeys);
        if (
          !force &&
          snapshot === sessionRenewalJobKeySnapshot &&
          hasCachedRenewalStatuses(jobKeys)
        ) {
          return;
        }
        if (sessionRenewalFetchInFlight) {
          return;
        }

        sessionRenewalFetchInFlight = true;
        sessionRenewalJobKeySnapshot = snapshot;

        jobKeys.forEach((jobKey) => {
          if (!sessionRenewalStatus[jobKey]) {
            sessionRenewalStatus[jobKey] = null;
          }
        });
        renderSessionTable();

        try {
          const res = await authFetch(
            "/api/admin/subscription/batch-renewal-status",
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                job_keys: jobKeys,
                timezone_offset_min: getAdminTimeZoneOffsetMinutes(),
              }),
            },
          );
          const parsed = await readJsonResponse(res);
          if (!parsed.ok) {
            throw new Error(parsed.message);
          }
          const payload = parsed.data;
          if (!res.ok || !payload.success) {
            throw new Error(payload.message || "查询自动续费状态失败");
          }
          Object.assign(sessionRenewalStatus, payload.data || {});
          renderSessionTable();
        } catch (error) {
          jobKeys.forEach((jobKey) => {
            sessionRenewalStatus[jobKey] = {
              ok: false,
              error: error.message || "查询失败",
            };
          });
          renderSessionTable();
        } finally {
          sessionRenewalFetchInFlight = false;
        }
      }

      async function loadSessions(showToast = false, options = {}) {
        const refreshRenewal = options.refreshRenewal !== false;
        try {
          const res = await authFetch("/api/admin/sessions");
          const parsed = await readJsonResponse(res);
          if (!parsed.ok) {
            throw new Error(parsed.message);
          }
          const data = parsed.data;
          const nextList = Array.isArray(data) ? data : [];
          const oldSnapshot = buildSessionRenewalSnapshot(
            sessionList.map((row) => row.job_key).filter(Boolean),
          );
          const newSnapshot = buildSessionRenewalSnapshot(
            nextList.map((row) => row.job_key).filter(Boolean),
          );
          const listChanged = oldSnapshot !== newSnapshot;

          sessionList = nextList;
          if (
            refreshRenewal &&
            (showToast ||
              listChanged ||
              !hasCachedRenewalStatuses(getSessionRenewalJobKeys()))
          ) {
            sessionRenewalStatus = {};
            sessionRenewalJobKeySnapshot = "";
            renderSessionTable();
            refreshSessionRenewalStatuses(true).catch(() => {});
          } else {
            renderSessionTable();
          }
          if (showToast) {
            showMessage("Session 列表已刷新", "success");
          }
        } catch (error) {
          if (showToast) {
            showMessage(error.message || "加载 Session 失败", "error");
          }
        }
      }

      async function triggerAdminActivation() {
        const cdk =
          document.getElementById("admin_activation_cdk")?.value.trim() || "";
        const sessionRaw =
          document.getElementById("admin_activation_session")?.value.trim() ||
          "";
        const resultEl = document.getElementById("admin_activation_result");
        const btn = document.getElementById("admin_activation_btn");

        if (!cdk) {
          showMessage("请输入 CDK", "error");
          return;
        }
        if (!sessionRaw) {
          showMessage("请粘贴 Session JSON 或 AccessToken", "error");
          return;
        }

        btn.disabled = true;
        if (resultEl) {
          resultEl.textContent = "正在提交...";
        }

        try {
          const res = await authFetch("/api/admin/trigger-activation", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ cdk, session: sessionRaw }),
          });
          const data = await res.json();
          if (!data.success) {
            throw new Error(data.message || "启动失败");
          }
          const msg = `任务已启动：${data.jobKey}`;
          if (resultEl) {
            resultEl.textContent = msg;
          }
          showMessage(msg + "，请到「运行日志」查看进度", "success");
          await loadSessions(false);
          await loadAdminData();
          switchPage("runtime_logs");
        } catch (error) {
          if (resultEl) {
            resultEl.textContent = "";
          }
          showMessage(error.message || "启动自动化失败", "error");
        } finally {
          btn.disabled = false;
          lucide.createIcons();
        }
      }

      function renderSessionTable() {
        const tbody = document.getElementById("session_body");
        if (!tbody) {
          return;
        }
        if (!sessionList.length) {
          tbody.innerHTML =
            '<tr><td colspan="8" style="text-align:center; color: var(--text-dim); padding: 40px 0;">暂无 Session 记录</td></tr>';
          lucide.createIcons();
          return;
        }
        tbody.innerHTML = sessionList
          .map((row) => {
            const jobKey = escapeHtml(row.job_key || "");
            const preview = escapeHtml(row.token_preview || "-");
            const canView = row.has_session !== false;
            const renewInfo = sessionRenewalStatus[row.job_key];
            const canManageRenew =
              row.status === "success" &&
              canView &&
              renewInfo?.ok &&
              renewInfo?.hasActiveSubscription;
            const sessionCell = canView
              ? `<button type="button" class="session-preview-link" data-view-session="${jobKey}" title="点击查看完整 Session">${preview}</button>`
              : `<code>${preview}</code>`;
            const cancelRenewBtn =
              canManageRenew && renewInfo.autoRenewRaw === true
                ? `<button type="button" class="btn btn-danger" style="padding:4px 8px; font-size:12px;" data-cancel-renew="${jobKey}" title="取消自动续费">取消续费</button>`
                : "";
            const enableRenewBtn =
              canManageRenew && renewInfo.autoRenewRaw === false
                ? `<button type="button" class="btn btn-success" style="padding:4px 8px; font-size:12px;" data-enable-renew="${jobKey}" title="开启自动续费">开启续费</button>`
                : "";
            return `
                      <tr>
                          <td>${escapeHtml(row.time || row.created_at || "-")}</td>
                          <td><code>${escapeHtml(row.cdk_code || "-")}</code></td>
                          <td>${sessionCell}</td>
                          <td style="text-align:center">${escapeHtml(row.card_last4 || "-")}</td>
                          <td>${escapeHtml(row.message || "-")}</td>
                          <td>${renderStatus(row.status)}</td>
                          <td style="text-align:center">${renderAutoRenewCell(row)}</td>
                          <td style="text-align:center">
                              <div class="table-action-group">
                                  <button type="button" class="btn btn-primary" style="padding:4px 8px; font-size:12px;" data-copy-session="${jobKey}" title="复制 Session">复制</button>
                                  <button type="button" class="btn btn-success" style="padding:4px 8px; font-size:12px;" data-export-session="${jobKey}" title="导出 Session">导出</button>
                                  ${enableRenewBtn}
                                  ${cancelRenewBtn}
                                  <button type="button" class="btn-delete" title="删除此任务记录" data-delete-task="${jobKey}">
                                      <i data-lucide="trash-2"></i>
                                  </button>
                              </div>
                          </td>
                      </tr>`;
          })
          .join("");
        lucide.createIcons();
      }

      function updateMaintenanceModeUI(config = {}, runtime = {}) {
        const checkbox = document.getElementById("maintenance_mode");
        const hint = document.getElementById("maintenance_mode_hint");
        if (!checkbox || !hint) {
          return;
        }

        const enabled = Boolean(config.maintenance_mode);
        const drain = Boolean(config.maintenance_mode_drain);
        const activeJobs = Math.max(
          0,
          Number(runtime.active_activation_jobs || 0),
        );

        const isPendingEnable = enabled && drain && activeJobs > 0;
        checkbox.checked = isPendingEnable ? false : enabled;
        checkbox.disabled = maintenanceModeSaving || isPendingEnable;

        if (isPendingEnable) {
          hint.textContent = `维护模式待开启，当前还有 ${activeJobs} 个任务在运行；新请求已拒绝，待现有任务全部完成后将自动开启`;
          return;
        }

        if (enabled) {
          hint.textContent = "维护模式已开启，当前拒绝所有新任务";
          return;
        }

        hint.textContent = "开启后立即拒绝所有新任务";
      }

      let proxyPoolList = [];
      const selectedProxyIds = new Set();
      let editingProxyId = null;

      function proxyGroupLabel(item) {
        return item?.group_name || "未分组";
      }

      function fillSelectOptions(select, optionsHtml, currentValue) {
        if (!select) return;
        select.innerHTML = optionsHtml;
        const next = currentValue == null ? "" : String(currentValue);
        if ([...select.options].some((option) => option.value === next)) {
          select.value = next;
        }
      }

      function proxyGroupTaskOptionsHtml(emptyLabel) {
        return [
          `<option value="">${escapeHtml(emptyLabel)}</option>`,
          '<option value="all">全部代理</option>',
          ...proxyGroupList.map(
            (group) =>
              `<option value="${escapeHtml(String(group.id))}">${escapeHtml(group.name)}</option>`,
          ),
        ].join("");
      }

      function fillProxyGroupSelects() {
        fillSelectOptions(
          document.getElementById("proxy_group_filter"),
          [
            '<option value="all">全部分组</option>',
            '<option value="none">未分组</option>',
            ...proxyGroupList.map(
              (group) =>
                `<option value="${escapeHtml(String(group.id))}">${escapeHtml(group.name)} (${Number(group.proxy_count || 0)})</option>`,
            ),
          ].join(""),
          proxyGroupFilter,
        );
        fillSelectOptions(
          document.getElementById("cdk_proxy_group"),
          proxyGroupTaskOptionsHtml("默认代理分组"),
          document.getElementById("cdk_proxy_group")?.value || "",
        );
        fillSelectOptions(
          document.getElementById("default_proxy_group"),
          [
            '<option value="">全部代理</option>',
            ...proxyGroupList.map(
              (group) =>
                `<option value="${escapeHtml(String(group.id))}">${escapeHtml(group.name)}</option>`,
            ),
          ].join(""),
          defaultProxyGroupId,
        );
        fillSelectOptions(
          document.getElementById("checkout_proxy_group"),
          proxyGroupTaskOptionsHtml("跟随系统默认"),
          document.getElementById("checkout_proxy_group")?.value || "",
        );
        fillSelectOptions(
          document.getElementById("account_proxy_group"),
          proxyGroupTaskOptionsHtml("跟随系统默认"),
          document.getElementById("account_proxy_group")?.value || "",
        );
        enhanceAssetSelects();
      }

      async function loadProxyGroupList() {
        try {
          const res = await authFetch("/api/admin/proxy-groups");
          const data = await res.json();
          proxyGroupList = Array.isArray(data.groups) ? data.groups : [];
          fillProxyGroupSelects();
        } catch (error) {
          console.error("loadProxyGroupList failed", error);
        }
      }

      function handleProxyGroupFilter(value) {
        proxyGroupFilter = String(value || "all");
        loadProxyPool().catch((error) => {
          console.error("Failed to load proxy pool", error);
        });
      }

      function getSelectedProxyGroupId(selectId) {
        return String(document.getElementById(selectId)?.value || "").trim();
      }

      async function createProxyGroupFromSelection() {
        const proxyIds = Array.from(selectedProxyIds);
        const extraHtml = `<input data-confirm-value class="asset-input" placeholder="输入分组名称" style="width:100%;margin-top:8px" />`;
        const confirmed = await showAdminConfirm(
          proxyIds.length
            ? `将选中的 ${proxyIds.length} 条代理加入新分组`
            : "创建空分组后可再把代理加入",
          "创建代理分组",
          extraHtml,
        );
        if (!confirmed) return;
        const name =
          typeof confirmed === "object"
            ? String(confirmed.source || "").trim()
            : "";
        if (!name) {
          showMessage("请输入分组名称", "warning");
          return;
        }
        try {
          const res = await authFetch("/api/admin/proxy-groups", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name, proxyIds }),
          });
          const data = await res.json();
          if (!res.ok || !data.success) {
            throw new Error(data.message || "创建失败");
          }
          selectedProxyIds.clear();
          showMessage(data.message || "分组已创建", "success");
          await loadProxyPool();
        } catch (error) {
          showMessage(error.message || "创建失败", "error");
        }
      }

      async function assignSelectedProxiesToGroup() {
        const proxyIds = Array.from(selectedProxyIds);
        if (!proxyIds.length) {
          showMessage("请先选择代理", "warning");
          return;
        }
        if (!proxyGroupList.length) {
          showMessage("请先创建代理分组", "warning");
          return;
        }
        const extraHtml = `<select data-confirm-value class="asset-input" style="width:100%;margin-top:8px">${proxyGroupList
          .map(
            (group) =>
              `<option value="${escapeHtml(String(group.id))}">${escapeHtml(group.name)}</option>`,
          )
          .join("")}</select>`;
        const confirmed = await showAdminConfirm(
          `将选中的 ${proxyIds.length} 条代理加入分组`,
          "加入代理分组",
          extraHtml,
        );
        if (!confirmed) return;
        const groupId = typeof confirmed === "object" ? confirmed.source : "";
        try {
          const res = await authFetch("/api/admin/proxy-groups/assign", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ groupId, proxyIds }),
          });
          const data = await res.json();
          if (!res.ok || !data.success) {
            throw new Error(data.message || "加入失败");
          }
          selectedProxyIds.clear();
          showMessage(data.message || "已加入分组", "success");
          await loadProxyPool();
        } catch (error) {
          showMessage(error.message || "加入失败", "error");
        }
      }

      async function clearSelectedProxyGroup() {
        const proxyIds = Array.from(selectedProxyIds);
        if (!proxyIds.length) {
          showMessage("请先选择代理", "warning");
          return;
        }
        const ok = await showAdminConfirm(
          `确定将选中的 ${proxyIds.length} 条代理移出分组？`,
          "移出分组",
        );
        if (!ok) return;
        try {
          const res = await authFetch("/api/admin/proxy-groups/assign", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ groupId: null, proxyIds }),
          });
          const data = await res.json();
          if (!res.ok || !data.success) {
            throw new Error(data.message || "移出失败");
          }
          selectedProxyIds.clear();
          showMessage(data.message || "已移出分组", "success");
          await loadProxyPool();
        } catch (error) {
          showMessage(error.message || "移出失败", "error");
        }
      }

      async function confirmDeleteEmptyProxyGroups(emptiedGroups) {
        const groups = Array.isArray(emptiedGroups) ? emptiedGroups : [];
        if (!groups.length) return false;
        const names = groups
          .map((group) => group.name || `#${group.id}`)
          .join("、");
        return showAdminConfirm(
          `删除后，分组「${names}」将变成空分组。是否同时删除这些分组？`,
          "删除空分组",
        );
      }

      async function deleteProxiesAndMaybeEmptyGroups(proxyIds) {
        const ids = (Array.isArray(proxyIds) ? proxyIds : [])
          .map((id) => Number(id))
          .filter((id) => Number.isInteger(id) && id > 0);
        if (!ids.length) {
          throw new Error("请选择要删除的代理");
        }
        const firstRes = await authFetch("/api/admin/proxies/batch-delete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ proxyIds: ids }),
        });
        const firstData = await firstRes.json();
        if (!firstRes.ok || !firstData.success) {
          throw new Error(firstData.message || firstData.error || "删除失败");
        }
        const emptiedGroups = firstData.emptied_groups || [];
        if (!emptiedGroups.length) {
          return firstData;
        }
        const deleteGroups = await confirmDeleteEmptyProxyGroups(emptiedGroups);
        if (!deleteGroups) {
          return {
            ...firstData,
            message: `${firstData.message || "代理已删除"}。空分组已保留。`,
          };
        }
        let deletedGroups = 0;
        for (const group of emptiedGroups) {
          const groupRes = await authFetch(
            `/api/admin/proxy-groups/${group.id}`,
            { method: "DELETE" },
          );
          const groupData = await groupRes.json().catch(() => ({}));
          if (!groupRes.ok || groupData.success === false) {
            throw new Error(groupData.message || "删除空分组失败");
          }
          deletedGroups += 1;
        }
        return {
          ...firstData,
          deleted_groups: deletedGroups,
          message: `已删除 ${firstData.deleted || ids.length} 条代理，并删除 ${deletedGroups} 个空分组`,
        };
      }

      function renderProxyCheckBadge(item) {
        if (item.last_check_ok === true) {
          return '<span class="status-badge status-success">活跃</span>';
        }
        if (item.last_check_ok === false) {
          return '<span class="status-badge" style="background:rgba(239,68,68,0.12);color:#f87171;">不可用</span>';
        }
        return '<span class="status-badge" style="opacity:.65;">未检测</span>';
      }

      function renderProxyPoolTable() {
        const tbody = document.getElementById("proxy_pool_body");
        const summary = document.getElementById("proxy_pool_summary");
        if (!tbody) return;

        if (!proxyPoolList.length) {
          tbody.innerHTML =
            '<tr><td colspan="11">暂无代理，请在上方粘贴 URL 后点击「导入代理」</td></tr>';
          if (summary) summary.textContent = "共 0 条，启用 0 条";
          return;
        }

        const activeCount = proxyPoolList.filter(
          (item) => item.is_active,
        ).length;
        tbody.innerHTML = proxyPoolList
          .map((item) => {
            const ipCell = item.last_check_ok
              ? `<code>${escapeHtml(item.last_check_ip || "-")}</code>`
              : `<span style="color:#f87171;font-size:12px;">${escapeHtml(item.last_check_error || "—")}</span>`;
            const latency = item.last_check_ok
              ? `${item.last_check_latency_ms || 0}ms`
              : "—";
            return `
                          <tr id="proxy_row_${item.id}">
                        <td class="select-cell">
                        <input type="checkbox" ${selectedProxyIds.has(item.id) ? "checked" : ""} onchange="toggleProxySelection(${item.id}, this.checked)" aria-label="选择代理">
                      </td>
                              <td style="text-align:center;">
                                  <label class="toggle-control" style="justify-content:center;">
                                      <input type="checkbox" class="toggle-input" ${item.is_active ? "checked" : ""} onchange="toggleProxyActive(${item.id}, this.checked)">
                                      <span class="toggle-switch"></span>
                                  </label>
                              </td>
                              <td style="text-align:center;" id="proxy_check_${item.id}">${renderProxyCheckBadge(item)}</td>
                              <td id="proxy_ip_${item.id}">${ipCell}</td>
                              <td style="text-align:center;" id="proxy_lat_${item.id}">${latency}</td>
                              <td style="text-align:center;"><code>${escapeHtml(item.protocol || "-")}</code></td>
                              <td><code style="font-size:12px; word-break:break-all;">${escapeHtml(item.proxy_url || "")}</code></td>
                              <td>${escapeHtml(proxyGroupLabel(item))}</td>
                              <td style="text-align:center;">
                                <button type="button" class="btn btn-secondary" style="min-width:32px; padding:6px 8px; justify-content:center;" onclick="editSavedProxy(${item.id})" title="编辑代理">
                                  <i data-lucide="pencil"></i>
                                </button>
                              </td>
                              <td style="text-align:center;">
                                <button type="button" class="btn btn-secondary" style="min-width:58px; padding:4px 10px; font-size:12px; justify-content:center;" onclick="testSavedProxy(${item.id})">检测</button>
                              </td>
                              <td style="text-align:center;">
                                  <button type="button" class="btn-delete" onclick="deleteSavedProxy(${item.id})" title="删除">
                                      <i data-lucide="trash-2"></i>
                                  </button>
                              </td>
                          </tr>
                      `;
          })
          .join("");

        if (summary) {
          summary.textContent = `共 ${proxyPoolList.length} 条，启用 ${activeCount} 条，已选 ${selectedProxyIds.size} 条`;
        }
        lucide.createIcons();
      }

      let browserPoolRefreshTimer = null;

      function formatDurationShort(sec) {
        const s = Math.max(0, Number(sec) || 0);
        if (s < 60) return `${s}秒`;
        if (s < 3600) return `${Math.floor(s / 60)}分${s % 60}秒`;
        const h = Math.floor(s / 3600);
        const m = Math.floor((s % 3600) / 60);
        return `${h}时${m}分`;
      }

      function stopBrowserPoolAutoRefresh() {
        if (browserPoolRefreshTimer) {
          clearInterval(browserPoolRefreshTimer);
          browserPoolRefreshTimer = null;
        }
      }

      function startBrowserPoolAutoRefresh() {
        stopBrowserPoolAutoRefresh();
        browserPoolRefreshTimer = setInterval(() => {
          if (
            document
              .getElementById("browser_pool")
              ?.classList.contains("active")
          ) {
            loadBrowserPoolPage(false).catch(() => {});
          }
        }, 2000);
      }

      function renderBrowserPoolSlots(pool) {
        const grid = document.getElementById("browser_pool_slots_grid");
        if (!grid) return;
        const slots = Array.isArray(pool?.slots) ? pool.slots : [];
        if (!slots.length) {
          grid.innerHTML =
            '<div style="color:var(--text-dim); padding:16px;">暂无槽位（池未初始化或已禁用）</div>';
          return;
        }
        grid.innerHTML = slots
          .map((slot) => {
            const busy = Boolean(slot.inUse);
            const border = busy ? "#f59e0b" : "#22c55e";
            const bg = busy ? "rgba(245,158,11,0.08)" : "rgba(34,197,94,0.06)";
            const statusText = busy ? "忙碌" : "空闲";
            const job = slot.jobKey ? escapeHtml(slot.jobKey) : "—";
            const urls =
              (slot.openUrls || [])
                .map(
                  (u) =>
                    `<div style="font-size:11px; opacity:0.85; word-break:break-all;">${escapeHtml(u)}</div>`,
                )
                .join("") ||
              '<div style="font-size:11px; opacity:0.6;">无打开页面</div>';
            return `
                      <div style="border:1px solid ${border}; background:${bg}; border-radius:14px; padding:16px;">
                          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">
                              <strong style="font-size:16px;">Slot #${slot.slotId}</strong>
                              <span class="status-badge ${busy ? "status-warning" : "status-success"}">${statusText}</span>
                          </div>
                          <div style="font-size:13px; line-height:1.65; color:var(--text-dim);">
                              <div>CDP: <code>${escapeHtml(slot.cdpUrl || "")}</code></div>
                              <div>端口: ${slot.port} · 累计 ${slot.uses || 0} 次 · 运行 ${formatDurationShort(slot.uptimeSec)}</div>
                              <div>Profile: ${escapeHtml(slot.profileSizeText || "0 B")}</div>
                              <div>页面数: ${slot.pageCount || 0}${busy ? ` · 任务 <code>${job}</code>` : ""}</div>
                          </div>
                          <div style="margin-top:10px; padding-top:10px; border-top:1px solid var(--divider);">${urls}</div>
                      </div>`;
          })
          .join("");
      }

      async function loadBrowserPoolPage(showToast = false) {
        const res = await authFetch("/api/admin/browser-pool");
        const data = await res.json();
        if (!res.ok || !data.success) {
          throw new Error(data.message || "加载浏览器池失败");
        }
        const pool = data.pool || {};
        const mode = data.mode || {};
        const sys = data.system || {};
        const mem = pool.memory || {};

        const modeToggle = document.getElementById("bp_mode_enabled");
        if (modeToggle && document.activeElement !== modeToggle) {
          modeToggle.checked = Boolean(mode.enabled);
        }
        const modeHint = document.getElementById("bp_mode_hint");
        if (modeHint) {
          modeHint.textContent = mode.enabled
            ? `当前：浏览器池 · 子进程 BROWSER_RUNTIME_MODE=pool`
            : `当前：独立启动 · 子进程 BROWSER_RUNTIME_MODE=standalone`;
        }

        document.getElementById("bp_max_size").textContent =
          pool.maxPoolSize || 24;
        const sizeInput = document.getElementById("bp_pool_size_input");
        if (sizeInput && document.activeElement !== sizeInput) {
          sizeInput.max = String(pool.maxPoolSize || 48);
          sizeInput.value = pool.configuredSize || pool.size || 2;
        }

        const enabled =
          Boolean(mode.enabled) && pool.enabled && pool.initialized;
        document.getElementById("bp_stat_status").textContent = !mode.enabled
          ? "独立模式"
          : !pool.enabled
            ? "已禁用"
            : pool.initialized
              ? "运行中"
              : "未就绪";
        document.getElementById("bp_stat_status").style.color = enabled
          ? "var(--success)"
          : "var(--error)";
        document.getElementById("bp_stat_slots").textContent =
          `${pool.size || 0} / ${pool.configuredSize || pool.size || 0}`;
        document.getElementById("bp_stat_usage").textContent =
          `${pool.idle || 0} / ${pool.busy || 0}`;
        document.getElementById("bp_stat_waiting").textContent = String(
          pool.waiting || 0,
        );
        document.getElementById("bp_stat_uses").textContent = String(
          pool.totalUses || 0,
        );
        document.getElementById("bp_stat_mem").textContent =
          pool.totals?.estimatedProcessText || "—";
        const memHint = document.getElementById("bp_config_mem_hint");
        if (memHint) {
          const slots = Number(pool.configuredSize || pool.size || 0);
          const memText = pool.totals?.estimatedProcessText || "";
          memHint.textContent = slots
            ? ` 当前 ${slots} 槽预估占用 ${memText || "—"}。`
            : "";
        }

        const maxPoolSize = Number(pool.maxPoolSize || 24);
        const totalGb =
          mem.hostTotalGb == null ? NaN : Number(mem.hostTotalGb);
        const freeGb = mem.hostFreeGb == null ? NaN : Number(mem.hostFreeGb);
        const suggested = Number.isFinite(freeGb)
          ? Math.min(maxPoolSize, Math.max(1, Math.floor(freeGb / 0.55)))
          : maxPoolSize;
        let dailyLow = 2;
        let dailyHigh = 4;
        if (Number.isFinite(totalGb) && totalGb >= 32) {
          dailyLow = 8;
          dailyHigh = 16;
        } else if (Number.isFinite(totalGb) && totalGb >= 12) {
          dailyLow = 4;
          dailyHigh = 8;
        }
        dailyHigh = Math.min(dailyHigh, suggested, maxPoolSize);
        dailyLow = Math.min(dailyLow, dailyHigh);
        const dailyEl = document.getElementById("bp_memo_daily_slots");
        const dailyNote = document.getElementById("bp_memo_daily_note");
        const extraEl = document.getElementById("bp_memo_extra_slots");
        const extraNote = document.getElementById("bp_memo_extra_note");
        const maxEl = document.getElementById("bp_memo_max_slots");
        if (dailyEl) dailyEl.textContent = `${dailyLow}–${dailyHigh}`;
        if (dailyNote) {
          dailyNote.textContent = Number.isFinite(totalGb)
            ? `本机约 ${totalGb.toFixed(1)}GB，与「前台并发」对齐即可`
            : "与本页「前台并发」对齐即可";
        }
        if (extraEl) extraEl.textContent = `≤${suggested}`;
        if (extraNote) {
          extraNote.textContent = Number.isFinite(freeGb)
            ? `当前可用约 ${freeGb.toFixed(1)}GB，每加 1 槽约 0.5GB`
            : "以「主机内存与容量建议」为准，每加 1 槽约 0.5GB";
        }
        if (maxEl) maxEl.textContent = `≤${maxPoolSize}`;

        const hostLines = [];
        if (mem.hostTotalGb != null) {
          hostLines.push(
            `主机内存：已用 <strong>${mem.hostUsedGb?.toFixed?.(1) ?? mem.hostUsedGb} GB</strong> / 共 ${mem.hostTotalGb} GB（可用约 <strong>${mem.hostFreeGb?.toFixed?.(1) ?? mem.hostFreeGb} GB</strong>）`,
          );
        } else if (sys.memory?.text) {
          hostLines.push(
            `主机内存：${escapeHtml(sys.memory.text)}（${sys.memory.percent || 0}%）`,
          );
        }
        hostLines.push(
          `CPU：${escapeHtml(sys.cpu?.text || "—")}（${sys.cpu?.percent || 0}%）`,
        );
        hostLines.push(
          `池 Profile 磁盘：${escapeHtml(pool.totals?.profileSizeText || "0 B")} · CDP 基址端口 ${pool.basePort || 19222}`,
        );
        hostLines.push(
          `前台任务：${data.foreground?.activeForegroundJobs ?? 0} 占用 · 槽位上限 ${pool.maxPoolSize || 24}`,
        );
        if (mem.sizingHint) {
          hostLines.push(`<span>${escapeHtml(mem.sizingHint)}</span>`);
        }
        document.getElementById("browser_pool_memory_hint").innerHTML =
          hostLines.join("<br>");

        renderBrowserPoolSlots(pool);

        const queue = Array.isArray(pool.queue) ? pool.queue : [];
        const queueEl = document.getElementById("browser_pool_queue");
        if (!queue.length) {
          queueEl.innerHTML = "无排队任务";
        } else {
          queueEl.innerHTML = queue
            .map(
              (q, i) =>
                `<div style="padding:8px 0; border-bottom:1px solid rgba(255,255,255,0.06);">#${i + 1} 等待槽位 · 任务 <code>${escapeHtml(q.jobKey || "—")}</code></div>`,
            )
            .join("");
        }

        if (showToast) {
          showMessage("浏览器池状态已刷新", "success");
        }
        lucide.createIcons();
      }

      async function setBrowserPoolMode(enabled) {
        const hint = document.getElementById("bp_reload_hint");
        if (hint) hint.textContent = "正在切换模式…";
        try {
          const res = await authFetch("/api/admin/browser-pool/mode", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ enabled: Boolean(enabled) }),
          });
          const data = await res.json();
          if (!res.ok || !data.success) {
            throw new Error(data.message || "切换失败");
          }
          if (hint) hint.textContent = data.message || "已切换";
          await loadBrowserPoolPage(false);
        } catch (error) {
          if (hint) hint.textContent = error.message || "切换失败";
          const toggle = document.getElementById("bp_mode_enabled");
          if (toggle) toggle.checked = !enabled;
        }
      }

      async function saveForegroundConcurrency() {
        const el = document.getElementById("max_concurrent_activations");
        const value = Math.max(1, parseInt(el?.value, 10) || 1);
        if (el) el.value = String(value);
        try {
          const res = await authFetch("/api/admin/config", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(buildConfigPayload()),
          });
          const data = await res.json();
          if (!res.ok || !data.success) {
            throw new Error(data.message || "保存失败");
          }
          showMessage("前台并发已保存", "success");
        } catch (error) {
          showMessage(error.message || "保存失败", "error");
        }
      }

      async function reloadBrowserPool() {
        const input = document.getElementById("bp_pool_size_input");
        const hint = document.getElementById("bp_reload_hint");
        const size = Number(input?.value || 0);
        if (!size || size < 1) {
          showMessage("请输入有效的槽位数量", "error");
          return;
        }
        hint.textContent = "正在重载...";
        try {
          const res = await authFetch("/api/admin/browser-pool/reload", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ size }),
          });
          const data = await res.json();
          if (!res.ok || !data.success) {
            throw new Error(data.message || "重载失败");
          }
          hint.textContent = data.message || "已重载";
          showMessage(data.message || "浏览器池已重载", "success");
          await loadBrowserPoolPage(false);
        } catch (e) {
          hint.textContent = "";
          showMessage(e.message, "error");
        }
      }

      async function loadProxyPool() {
        const params = new URLSearchParams({
          group_id: String(proxyGroupFilter || "all"),
        });
        const res = await authFetch(`/api/admin/proxies?${params.toString()}`);
        const data = await res.json();
        if (!res.ok || !data.success) {
          throw new Error(data.message || "加载代理池失败");
        }
        proxyPoolList = Array.isArray(data.proxies) ? data.proxies : [];
        const validIds = new Set(proxyPoolList.map((item) => item.id));
        Array.from(selectedProxyIds).forEach((id) => {
          if (!validIds.has(id)) selectedProxyIds.delete(id);
        });
        await loadProxyGroupList();
        renderProxyPoolTable();
      }

      async function saveProxyPool() {
        const input = document.getElementById("proxy_add_input");
        const hint = document.getElementById("proxy_add_hint");
        const lines = String(input?.value || "").trim();
        if (!lines) {
          showMessage("请先粘贴至少一条代理 URL", "warning");
          return;
        }
        await loadProxyGroupList();
        const extraHtml = `<label>导入到分组</label>
          <select data-confirm-value class="asset-input" style="width:100%;margin-top:8px">
            <option value="">不分组</option>
            ${proxyGroupList
              .map(
                (group) =>
                  `<option value="${escapeHtml(String(group.id))}">${escapeHtml(group.name)}</option>`,
              )
              .join("")}
          </select>
          <input data-confirm-extra class="asset-input" placeholder="或输入新分组名称" style="width:100%;margin-top:8px" />`;
        const confirmed = await showAdminConfirm(
          "选择已有分组，或填写新分组名称后创建。",
          "导入代理",
          extraHtml,
        );
        if (!confirmed) return;
        let groupId =
          typeof confirmed === "object" ? String(confirmed.source || "") : "";
        const newName =
          typeof confirmed === "object"
            ? String(confirmed.extra || "").trim()
            : "";
        if (hint) hint.textContent = "保存中...";
        try {
          if (newName) {
            const created = await authFetch("/api/admin/proxy-groups", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ name: newName }),
            });
            const createdData = await created.json();
            if (!created.ok || !createdData.success) {
              throw new Error(createdData.message || "创建分组失败");
            }
            groupId = createdData.group?.id || "";
          }
          const res = await authFetch("/api/admin/proxies", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              proxies: lines.split(/\r?\n/),
              group_id: groupId || null,
            }),
          });
          const data = await res.json();
          if (!res.ok || !data.success) {
            throw new Error(data.error || data.message || "保存失败");
          }
          if (input) input.value = "";
          if (hint) hint.textContent = data.message || "已保存";
          if (groupId) proxyGroupFilter = String(groupId);
          showMessage(data.message || "代理已保存", "success");
          await loadProxyPool();
        } catch (error) {
          if (hint) hint.textContent = "";
          showMessage(error.message || "保存代理失败", "error");
        }
      }

      function applyProxyTestResultToRow(id, result) {
        const checkCell = document.getElementById(`proxy_check_${id}`);
        const ipCell = document.getElementById(`proxy_ip_${id}`);
        const latCell = document.getElementById(`proxy_lat_${id}`);
        const rowItem = proxyPoolList.find((item) => item.id === id);
        if (rowItem) {
          rowItem.last_check_ok = !!result.ok;
          rowItem.last_check_ip = result.ok ? result.ip || "" : "";
          rowItem.last_check_latency_ms = result.ok
            ? result.latencyMs || 0
            : null;
          rowItem.last_check_error = result.ok
            ? ""
            : result.error || "检测失败";
        }
        if (checkCell) {
          checkCell.innerHTML = result.ok
            ? '<span class="status-badge status-success">活跃</span>'
            : '<span class="status-badge" style="background:rgba(239,68,68,0.12);color:#f87171;">不可用</span>';
        }
        if (ipCell) {
          ipCell.innerHTML = result.ok
            ? `<code>${escapeHtml(result.ip || "-")}</code>`
            : `<span style="color:#f87171;font-size:12px;">${escapeHtml(result.error || "失败")}</span>`;
        }
        if (latCell) {
          latCell.textContent = result.ok ? `${result.latencyMs || 0}ms` : "—";
        }
      }

      async function testSavedProxy(id) {
        try {
          const res = await authFetch(`/api/admin/proxies/${id}/test`, {
            method: "POST",
          });
          const data = await res.json();
          if (!res.ok || !data.success) {
            throw new Error(data.error || data.message || "检测失败");
          }
          applyProxyTestResultToRow(id, data);
          showMessage(
            data.ok
              ? `代理活跃，出口 IP: ${data.ip}`
              : `代理不可用: ${data.error || ""}`,
            data.ok ? "success" : "warning",
          );
        } catch (error) {
          showMessage(error.message || "检测失败", "error");
        }
      }

      async function testAllSavedProxies() {
        if (!proxyPoolList.length) {
          showMessage("代理池为空", "warning");
          return;
        }
        const ids = proxyPoolList.map((item) => item.id);
        try {
          showMessage(`正在检测 ${ids.length} 条代理...`, "success");
          const res = await authFetch("/api/admin/proxy/test", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ids, persist: true }),
          });
          const data = await res.json();
          if (!res.ok || !data.success) {
            throw new Error(data.message || "批量检测失败");
          }
          const results = Array.isArray(data.results) ? data.results : [];
          let okCount = 0;
          results.forEach((result) => {
            if (result.id) {
              applyProxyTestResultToRow(result.id, result);
            }
            if (result.ok) okCount += 1;
          });
          showMessage(
            `检测完成：活跃 ${okCount} / 共 ${results.length}`,
            okCount ? "success" : "warning",
          );
          renderProxyPoolTable();
        } catch (error) {
          showMessage(error.message || "批量检测失败", "error");
        }
      }

      function toggleProxySelection(id, checked) {
        if (checked) {
          selectedProxyIds.add(id);
        } else {
          selectedProxyIds.delete(id);
        }
        renderProxyPoolTable();
      }

      function toggleAllProxySelection() {
        const shouldSelect = proxyPoolList.some(
          (item) => !selectedProxyIds.has(item.id),
        );
        proxyPoolList.forEach((item) => {
          if (shouldSelect) {
            selectedProxyIds.add(item.id);
          } else {
            selectedProxyIds.delete(item.id);
          }
        });
        renderProxyPoolTable();
      }

      function selectUnavailableProxies() {
        const unavailable = proxyPoolList.filter(
          (item) => item.last_check_ok === false,
        );
        if (!unavailable.length) {
          showMessage("没有已检测为失效的代理", "warning");
          return;
        }
        unavailable.forEach((item) => selectedProxyIds.add(item.id));
        renderProxyPoolTable();
        showMessage(`已选中 ${unavailable.length} 条失效代理`, "success");
      }

      async function batchDeleteSavedProxies() {
        const ids = Array.from(selectedProxyIds);
        if (!ids.length) {
          showMessage("请先选择要删除的代理", "warning");
          return;
        }
        const ok = await showAdminConfirm(
          `确定删除选中的 ${ids.length} 条代理？`,
          "批量删除代理",
        );
        if (!ok) return;

        try {
          const data = await deleteProxiesAndMaybeEmptyGroups(ids);
          selectedProxyIds.clear();
          showMessage(data.message || `已删除 ${ids.length} 条代理`, "success");
          await loadProxyPool();
        } catch (error) {
          showMessage(error.message || "批量删除失败", "error");
          await loadProxyPool();
        }
      }

      async function toggleProxyActive(id, isActive) {
        try {
          const res = await authFetch(`/api/admin/proxies/${id}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ is_active: !!isActive }),
          });
          const data = await res.json();
          if (!res.ok || !data.success) {
            throw new Error(data.error || data.message || "更新失败");
          }
          const rowItem = proxyPoolList.find((item) => item.id === id);
          if (rowItem) rowItem.is_active = !!isActive;
          renderProxyPoolTable();
        } catch (error) {
          showMessage(error.message || "更新代理状态失败", "error");
          await loadProxyPool();
        }
      }

      async function editSavedProxy(id) {
        const item = proxyPoolList.find((proxy) => proxy.id === id);
        if (!item) return;
        const overlay = document.getElementById("proxy_edit_modal_overlay");
        const input = document.getElementById("proxy_edit_input");
        if (!overlay || !input) return;
        editingProxyId = id;
        input.value = item.proxy_url || "";
        overlay.classList.add("open");
        input.focus();
      }

      function closeProxyEditModal() {
        const overlay = document.getElementById("proxy_edit_modal_overlay");
        if (overlay) overlay.classList.remove("open");
        editingProxyId = null;
      }

      async function saveProxyEdit() {
        const input = document.getElementById("proxy_edit_input");
        const item = proxyPoolList.find((proxy) => proxy.id === editingProxyId);
        if (!input || !item) return;
        const proxyUrl = input.value.trim();
        if (proxyUrl === item.proxy_url) {
          closeProxyEditModal();
          return;
        }
        if (!proxyUrl.trim()) {
          showMessage("代理 URL 不能为空", "warning");
          return;
        }
        try {
          const res = await authFetch(`/api/admin/proxies/${editingProxyId}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ proxy_url: proxyUrl.trim() }),
          });
          const data = await res.json();
          if (!res.ok || !data.success) {
            throw new Error(data.error || data.message || "更新失败");
          }
          closeProxyEditModal();
          showMessage("代理已更新，请重新检测", "success");
          await loadProxyPool();
        } catch (error) {
          showMessage(error.message || "更新代理失败", "error");
        }
      }

      async function deleteSavedProxy(id) {
        const ok = await showAdminConfirm("确定删除这条代理？", "删除代理");
        if (!ok) return;
        try {
          const data = await deleteProxiesAndMaybeEmptyGroups([id]);
          selectedProxyIds.delete(Number(id));
          showMessage(data.message || "代理已删除", "success");
          await loadProxyPool();
        } catch (error) {
          showMessage(error.message || "删除失败", "error");
        }
      }

      function buildConfigPayload(overrides = {}) {
        return {
          max_concurrent_activations: Math.max(
            1,
            parseInt(
              document.getElementById("max_concurrent_activations").value,
              10,
            ) || 1,
          ),
          maintenance_mode: Object.prototype.hasOwnProperty.call(
            overrides,
            "maintenance_mode",
          )
            ? Boolean(overrides.maintenance_mode)
            : document.getElementById("maintenance_mode").checked,
          default_timezone:
            document.getElementById("default_timezone")?.value ||
            "Asia/Shanghai",
          default_proxy_group_id:
            document.getElementById("default_proxy_group")?.value || "",
          record_video:
            document.getElementById("record_video")?.checked || false,
        };
      }

      function getCurrentEmailSource() {
        if (document.getElementById("email_source_pool")?.checked)
          return "pool";
        if (document.getElementById("email_source_inbox")?.checked)
          return "inbox";
        return "random";
      }

      function syncEmailSourceUI() {
        const src = getCurrentEmailSource();
        document.querySelectorAll(".email-source-card").forEach((card) => {
          const input = card.querySelector('input[type="radio"]');
          if (input) {
            card.classList.toggle("is-active", !!input.checked);
          }
        });
        const setEnabled = (id, enabled) => {
          const el = document.getElementById(id);
          if (el) el.dataset.disabled = enabled ? "0" : "1";
        };
        setEnabled("random_email_options", src === "random");
        setEnabled("pool_email_options", src === "pool");
        setEnabled("inbox_email_options", src === "inbox");
      }

      function normalizeRandomDomain(raw) {
        const cleaned = String(raw || "")
          .trim()
          .replace(/^@+/, "")
          .replace(/\s+/g, "")
          .toLowerCase();
        return cleaned || "chiyiyi.cloud";
      }

      async function saveMaintenanceMode() {
        const checkbox = document.getElementById("maintenance_mode");
        const nextValue = Boolean(checkbox?.checked);
        maintenanceModeSaving = true;
        updateMaintenanceModeUI(
          {
            maintenance_mode: nextValue,
            maintenance_mode_drain:
              nextValue &&
              Number(window.__adminRuntime?.active_activation_jobs || 0) > 0,
          },
          window.__adminRuntime,
        );

        try {
          const res = await authFetch("/api/admin/config", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(
              buildConfigPayload({
                maintenance_mode: nextValue,
              }),
            ),
          });
          const data = await res.json();
          if (!res.ok || !data.success) {
            throw new Error(data.message || "维护模式保存失败");
          }
          lastMaintenanceModeValue = nextValue;
          showMessage(data.message, "success");
          await loadData(true);
        } catch (error) {
          if (checkbox) {
            checkbox.checked = lastMaintenanceModeValue;
          }
          showMessage(error.message || "维护模式保存失败", "error");
          await loadData(true);
        } finally {
          maintenanceModeSaving = false;
          updateMaintenanceModeUI(
            {
              maintenance_mode:
                document.getElementById("maintenance_mode")?.checked,
              maintenance_mode_drain:
                Boolean(document.getElementById("maintenance_mode")?.checked) &&
                Number(window.__adminRuntime?.active_activation_jobs || 0) > 0,
            },
            window.__adminRuntime,
          );
        }
      }

      function shortenJobKey(jobKey) {
        const value = String(jobKey || "");
        if (!value) {
          return "-";
        }
        const parts = value.split("-");
        return parts.length > 1 ? parts[1] : value.slice(-8);
      }

      function getTaskType(task) {
        return window.TaskType.getTaskType(task);
      }

      async function loadTaskLogs(showToast = false) {
        try {
          const sinceMs = showToast
            ? 0
            : Math.max(
                0,
                ...((window.__adminLogs || []).map((task) =>
                  Number(task.updatedAtMs || 0),
                ) || [0]),
              );
          const sinceId = showToast
            ? 0
            : Math.max(
                0,
                ...((window.__adminLogs || [])
                  .filter((task) => Number(task.updatedAtMs || 0) === sinceMs)
                  .map((task) => Number(task.rowId || 0)) || [0]),
              );
          const query =
            sinceMs > 0
              ? `/api/admin/task-logs?since=${sinceMs}&since_id=${sinceId}&limit=200`
              : "/api/admin/task-logs";
          const res = await authFetch(query);
          const data = await res.json();
          if (!res.ok) {
            throw new Error(data.message || `加载任务失败（${res.status}）`);
          }
          const incoming = Array.isArray(data.tasks) ? data.tasks : [];
          if (sinceMs > 0 && data.incremental) {
            const byId = new Map(
              (window.__adminLogs || []).map((task) => [task.id, task]),
            );
            incoming.forEach((task) => {
              if (task?.id) byId.set(task.id, task);
            });
            window.__adminLogs = Array.from(byId.values())
              .sort((left, right) => {
                const rightMs = Number(right.updatedAtMs || 0);
                const leftMs = Number(left.updatedAtMs || 0);
                if (rightMs !== leftMs) return rightMs - leftMs;
                return Number(right.rowId || 0) - Number(left.rowId || 0);
              })
              .slice(0, 500);
          } else {
            window.__adminLogs = incoming;
          }
          renderLogTable(window.__adminLogs);
          if (showToast) {
            showMessage("任务列表已刷新", "success");
          }
        } catch (error) {
          console.error("loadTaskLogs failed", error);
          if (showToast) {
            showMessage(error.message || "加载任务失败", "error");
          }
        }
        lucide.createIcons();
      }

      function renderCDKTable() {
        const tbody = document.getElementById("cdk_body");
        if (!tbody) {
          return;
        }
        const state = paginationState.cdk;
        const total = Number(cdkTotal || 0);
        const totalPages = Math.max(1, Math.ceil(total / state.pageSize) || 1);
        state.page = Math.min(Math.max(1, state.page), totalPages);
        const pageData = {
          items: Array.isArray(cdkPool) ? cdkPool : [],
          page: state.page,
          pageSize: state.pageSize,
          total,
          totalPages,
        };
        tbody.innerHTML = pageData.items
          .map((cdk) => {
            const code = typeof cdk === "string" ? cdk : cdk.code || "";
            const status =
              typeof cdk === "string" ? "unused" : cdk.status || "unused";
            const planType =
              typeof cdk === "string" ? "plus" : cdk.plan_type || "plus";
            const usedAt = typeof cdk === "string" ? null : cdk.used_at;
            const sessionPreview =
              typeof cdk === "string" ? null : cdk.session_preview || null;

            const planTypeLabel =
              {
                plus: "Plus",
                pro_5x: "Pro 5x",
                pro_20x: "Pro 20x",
                credits: "Codex",
                credits_250: "Codex 250",
                credits_500: "Codex 500",
                credits_1000: "Codex 1000",
                credits_1500: "Codex 1500",
                credits_2000: "Codex 2000",
              }[planType] ||
              (String(planType).startsWith("credits") ? "Codex" : "Plus");
            const planTypeColor =
              {
                plus: "#2563eb",
                pro_5x: "#8b5cf6",
                pro_20x: "#ec4899",
                credits: "#0f766e",
                credits_250: "#0f766e",
                credits_500: "#0f766e",
                credits_1000: "#0f766e",
                credits_1500: "#0f766e",
                credits_2000: "#0f766e",
              }[planType] ||
              (String(planType).startsWith("credits") ? "#0f766e" : "#2563eb");
            const planTypeBg =
              {
                plus: "rgba(37, 99, 235, 0.12)",
                pro_5x: "rgba(139, 92, 246, 0.12)",
                pro_20x: "rgba(236, 72, 153, 0.12)",
                credits: "rgba(15, 118, 110, 0.12)",
                credits_250: "rgba(15, 118, 110, 0.12)",
                credits_500: "rgba(15, 118, 110, 0.12)",
                credits_1000: "rgba(15, 118, 110, 0.12)",
                credits_1500: "rgba(15, 118, 110, 0.12)",
                credits_2000: "rgba(15, 118, 110, 0.12)",
              }[planType] ||
              (String(planType).startsWith("credits")
                ? "rgba(15, 118, 110, 0.12)"
                : "rgba(37, 99, 235, 0.12)");

            const safeCode = escapeHtml(code);
            return `
                      <tr>
                          <td class="select-cell"><input type="checkbox" data-select-type="cdk" data-select-key="${safeCode}" ${selectedItems.cdk.has(code) ? "checked" : ""}></td>
                          <td><span class="cdk-copy" title="复制兑换链接" data-copy-cdk="${safeCode}"><code>${safeCode}</code><i data-lucide="copy"></i></span></td>
                          <td style="text-align:center"><span class="status-badge" style="background: ${planTypeBg}; color: ${planTypeColor}">${escapeHtml(planTypeLabel)}</span></td>
                          <td>${escapeHtml(typeof cdk === "string" ? "不限分组" : cdk.card_group_name || "不限分组")}</td>
                          <td>${escapeHtml(typeof cdk === "string" ? "默认代理" : cdk.proxy_group_name || "默认代理")}</td>
                          <td><code>${sessionPreview ? escapeHtml(sessionPreview) : "-"}</code></td>
                          <td>${
                            status === "processing"
                              ? '<span class="status-badge" style="background: rgba(245, 158, 11, 0.15); color: #f59e0b;">开通中</span>'
                              : status === "used"
                                ? '<span class="status-badge status-success">已使用</span>'
                                : '<span class="status-badge status-running">未使用</span>'
                          }</td>
                          <td>${escapeHtml(usedAt || "-")}</td>
                          <td style="text-align:center">
                              <button type="button" class="btn-delete" data-delete-cdk="${safeCode}" title="删除">
                                  <i data-lucide="trash-2"></i>
                              </button>
                          </td>
                      </tr>
                  `;
          })
          .join("");
        renderPagination("cdk_pagination", "cdk", pageData.total);
        lucide.createIcons();
      }

      function buildCdkRedeemUrl(cdk) {
        const origin = String(location.origin || "").replace(/\/+$/, "");
        return `${origin}/?cdk=${encodeURIComponent(cdk)}`;
      }

      async function copyCDK(cdk) {
        try {
          await copyText(buildCdkRedeemUrl(cdk));
          showMessage(`已复制兑换链接: ${cdk}`, "success");
        } catch (error) {
          showMessage("复制失败，请手动复制", "error");
        }
      }

      async function copyText(text) {
        if (navigator.clipboard && window.isSecureContext) {
          await navigator.clipboard.writeText(text);
          return;
        }
        const input = document.createElement("textarea");
        input.value = text;
        document.body.appendChild(input);
        input.select();
        document.execCommand("copy");
        document.body.removeChild(input);
      }

      async function batchCopyCDKs() {
        const codes = Array.from(selectedItems.cdk);
        if (codes.length === 0) {
          showMessage("请选择要复制的 CDK", "warning");
          return;
        }

        try {
          await copyText(codes.map((code) => buildCdkRedeemUrl(code)).join("\n"));
          showMessage(`已复制 ${codes.length} 条兑换链接`, "success");
        } catch (error) {
          showMessage(error.message || "批量复制失败", "error");
        }
      }

      async function batchDeleteCDKs() {
        const codes = Array.from(selectedItems.cdk);
        if (codes.length === 0) {
          showMessage("请选择要删除的 CDK", "warning");
          return;
        }
        const ok = await showAdminConfirm(
          `确定删除选中的 ${codes.length} 个 CDK ?`,
          "删除 CDK",
        );
        if (!ok) {
          return;
        }
        try {
          const results = await Promise.all(
            codes.map(async (code) => {
              const res = await authFetch(
                `/api/admin/cdks/${encodeURIComponent(code)}`,
                { method: "DELETE" },
              );
              const data = await res.json().catch(() => ({}));
              return {
                code,
                ok: res.ok && data.success !== false,
                message: data.message,
              };
            }),
          );
          const failed = results.filter((item) => !item.ok);
          selectedItems.cdk.clear();
          await loadData();
          if (failed.length) {
            showMessage(
              `已删除 ${codes.length - failed.length} 个，失败 ${failed.length} 个`,
              "warning",
            );
            return;
          }
          showMessage(`已删除 ${codes.length} 个 CDK`, "success");
        } catch (error) {
          showMessage(error.message || "批量删除失败", "error");
        }
      }

      async function batchDeletePhones() {
        const keys = Array.from(selectedItems.phone_pool);
        if (keys.length === 0) {
          showMessage("请选择要删除的号码", "warning");
          return;
        }
        const ok = await showAdminConfirm(
          `确定删除选中的 ${keys.length} 个号码 ?`,
          "删除号码",
        );
        if (!ok) {
          return;
        }
        phonePool = phonePool.filter(
          (item) => !selectedItems.phone_pool.has(item.phone || ""),
        );
        selectedItems.phone_pool.clear();
        renderPhoneTable();
      }

      async function batchDeleteCards() {
        // Legacy — no longer used; card pool now uses API-based deleteCardPoolItem
      }

      // ============ Stripe Card Pool Management ============

      let cardPoolList = [];
      let cardPoolTotal = 0;
      let cardPoolStats = {
        total: 0,
        active: 0,
        paused: 0,
        cooldown: 0,
        exhausted: 0,
      };
      let cardPoolRequestSeq = 0;
      let selectedCardIds = new Set();

      function toggleCardPoolImportBox() {
        const box = document.getElementById("card_pool_import_box");
        box.classList.toggle("active");
      }

      function cardGroupLabel(card) {
        return card?.group_name || "未分组";
      }

      function getFilteredCardPoolList() {
        return Array.isArray(cardPoolList) ? cardPoolList : [];
      }

      function fillCardGroupSelects() {
        const cardFilter = document.getElementById("card_group_filter");
        if (cardFilter) {
          cardFilter.innerHTML = [
            '<option value="all">全部分组</option>',
            '<option value="none">未分组</option>',
            ...cardGroupList.map(
              (group) =>
                `<option value="${escapeHtml(String(group.id))}">${escapeHtml(group.name)} (${Number(group.card_count || 0)})</option>`,
            ),
          ].join("");
          cardFilter.value = cardGroupFilter;
        }
        const cdkFilter = document.getElementById("cdk_group_filter");
        if (cdkFilter) {
          cdkFilter.innerHTML = [
            '<option value="all">全部分组</option>',
            '<option value="none">未绑定分组</option>',
            ...cardGroupList.map(
              (group) =>
                `<option value="${escapeHtml(String(group.id))}">${escapeHtml(group.name)}</option>`,
            ),
          ].join("");
          cdkFilter.value = cdkGroupFilter;
        }
        const cdkCreate = document.getElementById("cdk_card_group");
        if (cdkCreate) {
          const current = cdkCreate.value;
          cdkCreate.innerHTML = [
            '<option value="">不限分组</option>',
            ...cardGroupList.map(
              (group) =>
                `<option value="${escapeHtml(String(group.id))}">${escapeHtml(group.name)}</option>`,
            ),
          ].join("");
          if ([...cdkCreate.options].some((option) => option.value === current)) {
            cdkCreate.value = current;
          }
        }
      }

      function handleCardGroupFilter(value) {
        cardGroupFilter = String(value || "all");
        paginationState.card_assets.page = 1;
        loadCardPoolList().catch((error) => {
          console.error("Failed to load card pool", error);
        });
      }

      function handleCardNumberSearch(value) {
        tableSearch.card_number = String(value || "").trim();
        paginationState.card_assets.page = 1;
        if (cardSearchTimer) clearTimeout(cardSearchTimer);
        cardSearchTimer = setTimeout(() => {
          loadCardPoolList().catch((error) => {
            console.error("Failed to load card pool", error);
          });
        }, 250);
      }

      function handleCdkGroupFilter(value) {
        cdkGroupFilter = String(value || "all");
        paginationState.cdk.page = 1;
        loadCdkList().catch((error) => {
          console.error("Failed to load CDK list", error);
        });
      }

      async function loadCardGroupList() {
        try {
          const res = await authFetch("/api/admin/card-groups");
          const data = await res.json();
          cardGroupList = Array.isArray(data.groups) ? data.groups : [];
          fillCardGroupSelects();
        } catch (error) {
          console.error("loadCardGroupList failed", error);
        }
      }

      function toggleCardSelection(cardId, checked) {
        const id = Number(cardId);
        if (!id) return;
        if (checked) selectedCardIds.add(id);
        else selectedCardIds.delete(id);
      }

      function toggleCardPoolPageSelection() {
        const cards = getFilteredCardPoolList();
        const ids = cards.map((card) => Number(card.id)).filter(Boolean);
        const shouldSelect = ids.some((id) => !selectedCardIds.has(id));
        ids.forEach((id) => {
          if (shouldSelect) selectedCardIds.add(id);
          else selectedCardIds.delete(id);
        });
        renderCardPoolTable();
      }

      async function createCardGroupFromSelection() {
        const cardIds = Array.from(selectedCardIds);
        const extraHtml = `<input data-confirm-value class="asset-input" placeholder="输入分组名称" style="width:100%;margin-top:8px" />`;
        const confirmed = await showAdminConfirm(
          cardIds.length
            ? `将选中的 ${cardIds.length} 张卡加入新分组`
            : "创建空分组后可再把银行卡加入",
          "创建银行卡分组",
          extraHtml,
        );
        if (!confirmed) return;
        const name =
          typeof confirmed === "object"
            ? String(confirmed.source || "").trim()
            : "";
        if (!name) {
          showMessage("请输入分组名称", "warning");
          return;
        }
        try {
          const res = await authFetch("/api/admin/card-groups", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name, cardIds }),
          });
          const data = await res.json();
          if (!res.ok || !data.success) {
            throw new Error(data.message || "创建失败");
          }
          selectedCardIds.clear();
          showMessage(data.message || "分组已创建", "success");
          await loadCardPoolList();
        } catch (error) {
          showMessage(error.message || "创建失败", "error");
        }
      }

      async function assignSelectedCardsToGroup() {
        const cardIds = Array.from(selectedCardIds);
        if (!cardIds.length) {
          showMessage("请先选择银行卡", "warning");
          return;
        }
        if (!cardGroupList.length) {
          showMessage("请先创建银行卡分组", "warning");
          return;
        }
        const extraHtml = `<select data-confirm-value class="asset-input" style="width:100%;margin-top:8px">${cardGroupList
          .map(
            (group) =>
              `<option value="${escapeHtml(String(group.id))}">${escapeHtml(group.name)}</option>`,
          )
          .join("")}</select>`;
        const confirmed = await showAdminConfirm(
          `将选中的 ${cardIds.length} 张卡加入分组`,
          "加入银行卡分组",
          extraHtml,
        );
        if (!confirmed) return;
        const groupId = typeof confirmed === "object" ? confirmed.source : "";
        try {
          const res = await authFetch("/api/admin/card-groups/assign", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ groupId, cardIds }),
          });
          const data = await res.json();
          if (!res.ok || !data.success) {
            throw new Error(data.message || "加入失败");
          }
          selectedCardIds.clear();
          showMessage(data.message || "已加入分组", "success");
          await loadCardPoolList();
        } catch (error) {
          showMessage(error.message || "加入失败", "error");
        }
      }

      async function clearSelectedCardGroup() {
        const cardIds = Array.from(selectedCardIds);
        if (!cardIds.length) {
          showMessage("请先选择银行卡", "warning");
          return;
        }
        const ok = await showAdminConfirm(
          `确定将选中的 ${cardIds.length} 张卡移出分组？`,
          "移出分组",
        );
        if (!ok) return;
        try {
          const res = await authFetch("/api/admin/card-groups/assign", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ groupId: null, cardIds }),
          });
          const data = await res.json();
          if (!res.ok || !data.success) {
            throw new Error(data.message || "移出失败");
          }
          selectedCardIds.clear();
          showMessage(data.message || "已移出分组", "success");
          await loadCardPoolList();
        } catch (error) {
          showMessage(error.message || "移出失败", "error");
        }
      }

      async function loadCardPoolList() {
        const requestId = ++cardPoolRequestSeq;
        try {
          const page = Math.max(
            1,
            Number(paginationState.card_assets.page) || 1,
          );
          const pageSize = Math.max(
            1,
            Number(paginationState.card_assets.pageSize) || 20,
          );
          const params = new URLSearchParams({
            page: String(page),
            pageSize: String(pageSize),
            group_id: String(cardGroupFilter || "all"),
          });
          const keyword = String(tableSearch.card_number || "").trim();
          if (keyword) params.set("q", keyword);
          const res = await authFetch(`/api/admin/cards?${params.toString()}`);
          const data = await res.json();
          if (requestId !== cardPoolRequestSeq) return;
          cardPoolList = Array.isArray(data.cards)
            ? data.cards
            : Array.isArray(data)
              ? data
              : [];
          cardPoolTotal = Number(data.total || cardPoolList.length);
          cardPoolStats = data.stats || {
            total: cardPoolTotal,
            active: 0,
            paused: 0,
            cooldown: 0,
            exhausted: 0,
          };
          paginationState.card_assets.page = Math.max(
            1,
            Number(data.page || page),
          );
          paginationState.card_assets.pageSize = Math.max(
            1,
            Number(data.pageSize || pageSize),
          );
          await loadCardGroupList();
          if (requestId !== cardPoolRequestSeq) return;
          renderCardPoolStats();
          renderCardPoolTable();
        } catch (e) {
          if (requestId !== cardPoolRequestSeq) return;
          console.error("loadCardPoolList failed", e);
          showMessage("加载卡池列表失败", "error");
        }
      }

      function renderCardPoolStats() {
        document.getElementById("card_stat_total").textContent = Number(
          cardPoolStats.total || 0,
        );
        document.getElementById("card_stat_active").textContent = Number(
          cardPoolStats.active || 0,
        );
        const pausedEl = document.getElementById("card_stat_paused");
        if (pausedEl) {
          pausedEl.textContent = Number(cardPoolStats.paused || 0);
        }
        document.getElementById("card_stat_cooldown").textContent = Number(
          cardPoolStats.cooldown || 0,
        );
        document.getElementById("card_stat_exhausted").textContent = Number(
          cardPoolStats.exhausted || 0,
        );
      }

      function formatBoundAddress(card) {
        if (card.bound_address) return card.bound_address;
        const line1 = card.payment_address_line1 || "";
        const city = card.payment_address_city || "";
        const state = card.payment_address_state || "";
        const postal = card.payment_address_postal || "";
        if (!line1 && !city) return "-";
        const parts = [line1, city, state, postal].filter(Boolean);
        return parts.join(", ");
      }

      function formatCardHolder(card) {
        return (
          String(card.payment_holder_name || "").trim() ||
          String(card.card_holder || "").trim() ||
          "-"
        );
      }

      function renderCardPoolTable() {
        const tbody = document.getElementById("card_pool_list_body");
        const visibleCards = getFilteredCardPoolList();
        if (visibleCards.length === 0) {
          tbody.innerHTML =
            '<tr><td colspan="11" style="text-align:center; color: var(--text-dim); padding: 40px 0;">暂无卡片，请使用批量导入添加</td></tr>';
          renderPagination("card_pool_pagination", "card_assets", 0);
          lucide.createIcons();
          return;
        }
        tbody.innerHTML = visibleCards
          .map((card) => {
            const cardNumber = escapeHtml(card.card_number || card.last4 || "-");
            const cardExpiry = escapeHtml(card.card_expiry || "-");
            const cardCvc = escapeHtml(card.card_cvc || "-");
            const importHolder = escapeHtml(formatCardHolder(card));
            const boundAddress = escapeHtml(formatBoundAddress(card));
            const usageCount = Number(card.usage_count || 0);
            const maxUsage =
              card.max_usage_count == null || card.max_usage_count === ""
                ? null
                : Number(card.max_usage_count);
            const usageLabel =
              maxUsage == null ? `${usageCount} / 不限` : `${usageCount} / ${maxUsage}`;
            const lastUsed = card.last_used_at
              ? formatTimeShort(card.last_used_at)
              : "-";
            const statusBadge = getCardStatusBadge(card);
            const checked = selectedCardIds.has(Number(card.id))
              ? "checked"
              : "";
            const pauseAction =
              String(card.status || "") === "已报废" ||
              String(card.status || "") === "暂停" ||
              Number(card.is_active) === 0
                ? `<button class="btn-delete" style="background:var(--success-soft);color:#047857;border-color:#a7f3d0;" onclick="resumeCardPoolItem(${Number(card.id)})" title="恢复">
                                  <i data-lucide="play"></i>
                              </button>`
                : `<button class="btn-delete" style="background:var(--warning-soft);color:#b45309;border-color:#fde68a;" onclick="pauseCardPoolItem(${Number(card.id)})" title="暂停">
                                  <i data-lucide="pause"></i>
                              </button>`;
            return `
                      <tr>
                          <td class="select-cell"><input type="checkbox" ${checked} onchange="toggleCardSelection(${Number(card.id)}, this.checked)"></td>
                          <td><code>${cardNumber}</code></td>
                          <td><code>${cardExpiry}</code></td>
                          <td><code>${cardCvc}</code></td>
                          <td>${importHolder}</td>
                          <td class="card-bound-address" title="${boundAddress}" onclick="copyCardBoundAddress(event)">${boundAddress}</td>
                          <td>${escapeHtml(cardGroupLabel(card))}</td>
                          <td style="text-align:center">${statusBadge}</td>
                          <td style="text-align:center">${escapeHtml(usageLabel)}</td>
                          <td style="text-align:center">${lastUsed}</td>
                          <td style="text-align:center">
                              <div class="table-action-group">
                              ${pauseAction}
                              <button class="btn-delete" onclick="deleteCardPoolItem(${card.id})" title="删除">
                                  <i data-lucide="trash-2"></i>
                              </button>
                              </div>
                          </td>
                      </tr>`;
          })
          .join("");
        renderPagination(
          "card_pool_pagination",
          "card_assets",
          Number(cardPoolTotal || 0),
        );
        lucide.createIcons();
      }

      function getCardStatusBadge(card) {
        const status = String(card.status || "");
        if (status === "已报废") {
          return '<span class="status-badge status-failed">已报废</span>';
        }
        if (status === "暂停" || Number(card.is_active) === 0) {
          return '<span class="status-badge status-warning">暂停</span>';
        }
        if (
          status === "冷却中" ||
          (card.cooldown_until && new Date(card.cooldown_until) > new Date())
        ) {
          return '<span class="status-badge status-warning">冷却中</span>';
        }
        return '<span class="status-badge status-success">正常</span>';
      }

      function formatTimeShort(ts) {
        if (!ts) return "-";
        return formatAdminDateTime(ts);
      }

      async function confirmDeleteEmptyCardGroups(emptiedGroups) {
        const groups = Array.isArray(emptiedGroups) ? emptiedGroups : [];
        if (!groups.length) return false;
        const names = groups
          .map((group) => group.name || `#${group.id}`)
          .join("、");
        const cdkCount = groups.reduce(
          (sum, group) => sum + Number(group.cdk_count || 0),
          0,
        );
        const extra = cdkCount
          ? `若删除分组，CDK 管理中绑定这些分组的 ${cdkCount} 个卡密也会一并删除，且不可恢复。`
          : "这些分组下已没有银行卡。删除分组不会影响未绑定分组的 CDK。";
        return showAdminConfirm(
          `删除后，分组「${names}」将变成空分组。是否同时删除这些分组？\n\n${extra}`,
          "删除空分组",
        );
      }

      async function deleteCardsAndMaybeEmptyGroups(cardIds) {
        const ids = (Array.isArray(cardIds) ? cardIds : [])
          .map((id) => Number(id))
          .filter((id) => Number.isInteger(id) && id > 0);
        if (!ids.length) {
          throw new Error("请选择要删除的银行卡");
        }
        const firstRes = await authFetch("/api/admin/cards/batch-delete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cardIds: ids }),
        });
        const firstData = await firstRes.json();
        if (!firstRes.ok || !firstData.success) {
          throw new Error(firstData.message || firstData.error || "删除失败");
        }
        const emptiedGroups = firstData.emptied_groups || [];
        if (!emptiedGroups.length) {
          return firstData;
        }
        const deleteGroups = await confirmDeleteEmptyCardGroups(emptiedGroups);
        if (!deleteGroups) {
          return {
            ...firstData,
            message: `${firstData.message || "卡片已删除"}。空分组已保留。`,
          };
        }
        const groupIds = emptiedGroups.map((group) => Number(group.id));
        let deletedGroups = 0;
        let deletedCdks = 0;
        for (const groupId of groupIds) {
          const groupRes = await authFetch(
            `/api/admin/card-groups/${groupId}?deleteBoundCdks=1`,
            { method: "DELETE" },
          );
          const groupData = await groupRes.json().catch(() => ({}));
          if (!groupRes.ok || groupData.success === false) {
            throw new Error(groupData.message || "删除空分组失败");
          }
          deletedGroups += 1;
          deletedCdks += Number(groupData.deleted_cdks || 0);
        }
        let message = `已删除 ${firstData.deleted || ids.length} 张卡，并删除 ${deletedGroups} 个空分组`;
        if (deletedCdks) {
          message += `及绑定的 ${deletedCdks} 个 CDK`;
        }
        return {
          ...firstData,
          deleted_groups: deletedGroups,
          deleted_cdks: deletedCdks,
          message,
        };
      }

      async function deleteCardPoolItem(cardId) {
        const ok = await showAdminConfirm(
          "确定删除该卡片？删除后不可恢复。",
          "删除卡片",
        );
        if (!ok) return;
        try {
          const data = await deleteCardsAndMaybeEmptyGroups([cardId]);
          selectedCardIds.delete(Number(cardId));
          showMessage(data.message || "卡片已删除", "success");
          await loadCardPoolList();
        } catch (e) {
          showMessage(e.message || "删除请求失败", "error");
        }
      }

      async function postSelectedCards(url, body, emptyHint) {
        const cardIds = Array.from(selectedCardIds);
        if (!cardIds.length) {
          showMessage(emptyHint || "请先选择银行卡", "warning");
          return null;
        }
        const res = await authFetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cardIds, ...body }),
        });
        const data = await res.json();
        if (!res.ok || !data.success) {
          throw new Error(data.message || data.error || "操作失败");
        }
        return data;
      }

      async function batchDeleteSelectedCards() {
        const cardIds = Array.from(selectedCardIds);
        if (!cardIds.length) {
          showMessage("请先选择要删除的银行卡", "warning");
          return;
        }
        const ok = await showAdminConfirm(
          `确定删除选中的 ${cardIds.length} 张卡？删除后不可恢复。`,
          "批量删除银行卡",
        );
        if (!ok) return;
        try {
          const data = await deleteCardsAndMaybeEmptyGroups(cardIds);
          selectedCardIds.clear();
          showMessage(data.message || "已删除", "success");
          await loadCardPoolList();
        } catch (error) {
          showMessage(error.message || "批量删除失败", "error");
        }
      }

      async function pauseSelectedCards() {
        try {
          const data = await postSelectedCards("/api/admin/cards/pause", {
            paused: true,
          });
          if (!data) return;
          showMessage(data.message || "已暂停", "success");
          await loadCardPoolList();
        } catch (error) {
          showMessage(error.message || "暂停失败", "error");
        }
      }

      async function resumeSelectedCards() {
        try {
          const data = await postSelectedCards("/api/admin/cards/pause", {
            paused: false,
          });
          if (!data) return;
          showMessage(data.message || "已恢复", "success");
          await loadCardPoolList();
        } catch (error) {
          showMessage(error.message || "恢复失败", "error");
        }
      }

      async function pauseCardPoolItem(cardId) {
        try {
          const res = await authFetch("/api/admin/cards/pause", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ cardIds: [Number(cardId)], paused: true }),
          });
          const data = await res.json();
          if (!res.ok || !data.success) {
            throw new Error(data.message || "暂停失败");
          }
          showMessage(data.message || "已暂停", "success");
          await loadCardPoolList();
        } catch (error) {
          showMessage(error.message || "暂停失败", "error");
        }
      }

      async function resumeCardPoolItem(cardId) {
        try {
          const res = await authFetch("/api/admin/cards/pause", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ cardIds: [Number(cardId)], paused: false }),
          });
          const data = await res.json();
          if (!res.ok || !data.success) {
            throw new Error(data.message || "恢复失败");
          }
          showMessage(data.message || "已恢复", "success");
          await loadCardPoolList();
        } catch (error) {
          showMessage(error.message || "恢复失败", "error");
        }
      }

      async function setSelectedCardsMaxUsage() {
        const cardIds = Array.from(selectedCardIds);
        if (!cardIds.length) {
          showMessage("请先选择银行卡", "warning");
          return;
        }
        const extraHtml = `<label>最多使用次数（留空表示不限制）</label>
                <input data-confirm-value class="asset-input" type="number" min="1" step="1" placeholder="不限制" />`;
        const confirmed = await showAdminConfirm(
          `为选中的 ${cardIds.length} 张卡设置成功支付次数上限。任务成功后次数 +1，达到上限后自动暂停。`,
          "设置使用次数上限",
          extraHtml,
        );
        if (!confirmed) return;
        const raw =
          typeof confirmed === "object" ? String(confirmed.source || "").trim() : "";
        const maxUsageCount = raw === "" ? null : Number(raw);
        if (raw !== "" && (!Number.isFinite(maxUsageCount) || maxUsageCount <= 0)) {
          showMessage("请输入大于 0 的次数，或留空表示不限制", "warning");
          return;
        }
        try {
          const data = await postSelectedCards("/api/admin/cards/max-usage", {
            maxUsageCount,
          });
          showMessage(data.message || "已保存", "success");
          await loadCardPoolList();
        } catch (error) {
          showMessage(error.message || "设置失败", "error");
        }
      }

      async function copyCardBoundAddress(event) {
        const text = String(event?.currentTarget?.getAttribute("title") || event?.currentTarget?.textContent || "").trim();
        if (!text || text === "-") {
          showMessage("没有可复制的地址", "warning");
          return;
        }
        try {
          await copyText(text);
          showMessage("地址已复制", "success");
        } catch (error) {
          showMessage(error.message || "复制失败", "error");
        }
      }

      async function bindSelectedCardsAddress() {
        const cardIds = Array.from(selectedCardIds);
        if (!cardIds.length) {
          showMessage("请先选择银行卡", "warning");
          return;
        }
        let addresses = [];
        try {
          const res = await authFetch("/api/admin/addresses?region=US");
          const data = await res.json();
          addresses = Array.isArray(data.addresses) ? data.addresses : [];
        } catch (_) {
          addresses = [];
        }
        if (!addresses.length) {
          showMessage("暂无可用免税地址，请先在「免税地址」添加", "warning");
          return;
        }
        const options = addresses
          .map((item) => {
            const label = `${item.line1}, ${item.city}, ${item.state} ${item.postal_code || ""}`;
            return `<option value="${escapeHtml(String(item.id))}">${escapeHtml(label)}</option>`;
          })
          .join("");
        const extraHtml = `<label>支付姓名（可选，空白则保留原值）</label>
                <input data-confirm-extra class="asset-input" placeholder="如 John Smith" />
                <label>绑定地址</label>
                <select id="card_bind_address_select" data-confirm-value class="asset-input">${options}</select>`;
        const confirmed = await showAdminConfirm(
          `为选中的 ${cardIds.length} 张卡绑定免税地址。支付时将优先使用该地址。`,
          "绑定地址",
          extraHtml,
        );
        if (!confirmed) return;
        const addressId =
          typeof confirmed === "object" ? String(confirmed.source || "").trim() : "";
        const holderName =
          typeof confirmed === "object" ? String(confirmed.extra || "").trim() : "";
        const addr = addresses.find((item) => String(item.id) === addressId);
        if (!addr) {
          showMessage("请选择要绑定的地址", "warning");
          return;
        }
        try {
          const data = await postSelectedCards("/api/admin/cards/bind-address", {
            holder_name: holderName,
            address: {
              id: addr.id,
              line1: addr.line1,
              city: addr.city,
              state: addr.state,
              postal_code: addr.postal_code,
            },
          });
          showMessage(data.message || "已绑定地址", "success");
          await loadCardPoolList();
        } catch (error) {
          showMessage(error.message || "绑定失败", "error");
        }
      }

      function parseImportedCardLine(raw) {
        const text = String(raw || "").trim();
        if (!text) return { error: "为空" };
        const parts = text
          .split(/[|,，\t]/)
          .map((item) => item.trim())
          .filter(Boolean);
        if (parts.length < 3) {
          return { error: "格式错误（卡号|有效期|CVC，也可用逗号分隔）" };
        }
        const digits = String(parts[1] || "").replace(/\D/g, "");
        const card_expiry =
          digits.length === 4
            ? `${digits.slice(0, 2)}/${digits.slice(2)}`
            : String(parts[1] || "").trim();
        return {
          card_number: parts[0].replace(/\s+/g, ""),
          card_expiry,
          card_cvc: parts[2].replace(/\s+/g, ""),
          card_holder: parts.slice(3).join(" ").trim(),
        };
      }

      async function importCardPool() {
        const textarea = document.getElementById("card_pool_import_text");
        const resultEl = document.getElementById("card_pool_import_result");
        const btn = document.getElementById("card_pool_import_btn");
        const text = (textarea.value || "").trim();
        if (!text) {
          showMessage("请输入要导入的卡片数据", "warning");
          return;
        }

        const lines = text
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean);
        const cards = [];
        const parseErrors = [];
        for (let i = 0; i < lines.length; i++) {
          const parsed = parseImportedCardLine(lines[i]);
          if (parsed.error) {
            parseErrors.push(`第 ${i + 1} 行${parsed.error}`);
            continue;
          }
          cards.push(parsed);
        }

        if (cards.length === 0) {
          showMessage("未解析到有效卡片数据，请检查格式", "error");
          if (parseErrors.length > 0) {
            resultEl.textContent = parseErrors.slice(0, 5).join("；");
          }
          return;
        }

        btn.disabled = true;
        btn.innerHTML =
          '<i data-lucide="loader" class="animate-spin"></i> 导入中...';
        lucide.createIcons();

        try {
          const res = await authFetch("/api/admin/cards/import", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ cards }),
          });
          const data = await res.json();
          if (res.ok) {
            const imported = data.imported || 0;
            const skipped = data.skipped || 0;
            const failed = data.failed || 0;
            resultEl.textContent = `导入完成：成功 ${imported}，跳过 ${skipped}，失败 ${failed}`;
            resultEl.style.color =
              imported > 0 ? "var(--success)" : "var(--text-dim)";
            showMessage(`成功导入 ${imported} 张卡片`, "success");
            textarea.value = "";
            await loadCardPoolList();
          } else {
            showMessage(data.error || "导入失败", "error");
            resultEl.textContent = data.error || "导入失败";
            resultEl.style.color = "var(--error)";
          }
        } catch (e) {
          showMessage("导入请求失败", "error");
          resultEl.textContent = "网络错误";
          resultEl.style.color = "var(--error)";
        } finally {
          btn.disabled = false;
          btn.innerHTML = '<i data-lucide="check-check"></i> 解析导入';
          lucide.createIcons();
        }
      }

      // ============ End Card Pool Management ============


      function renderLogTable(logs) {
        const tbody = document.getElementById("log_body");
        if (!tbody) {
          return;
        }
        const pageData = getPageItems(getFilteredTaskLogs(logs), "log");
        if (!pageData.items.length) {
          tbody.innerHTML =
            '<tr><td colspan="9" style="text-align:center; color: var(--text-dim); padding: 36px 0;">暂无符合筛选条件的任务记录</td></tr>';
          renderPagination("log_pagination", "log", 0);
          return;
        }
        tbody.innerHTML = pageData.items
          .map((l) => {
            const mediaCell = renderTaskMediaCell(l);
            const taskType = getTaskType(l);
            const taskTypeClass =
              taskType === "CDK 开通"
                ? "status-running"
                : taskType === "支付调试" || taskType === "自定义付款"
                  ? "status-success"
                  : "status-warning";
            return `
                      <tr>
                          <td class="col-time">${escapeHtml(l.time || "-")}</td>
                          <td><span class="status-badge ${taskTypeClass}">${taskType}</span></td>
                          <td class="col-cdk"><code>${escapeHtml(l.cdk || "-")}</code></td>
                          <td class="col-token"><code>${escapeHtml(l.token || "-")}</code></td>
                          <td class="col-progress">
                              <div style="font-size: 12px; margin-bottom: 2px;">${l.progress}%</div>
                              <div class="progress-mini-track">
                                  <div class="progress-mini-bar ${l.status}" style="width: ${l.progress}%"></div>
                              </div>
                          </td>
                          <td class="col-duration">${escapeHtml(formatDurationText(l.durationSeconds))}</td>
                          <td class="col-status">${renderStatus(l.status)}</td>
                          <td class="col-media">${mediaCell}</td>
                          <td class="col-action" style="text-align:center">
                            <div class="table-action-group task-action-buttons">
                              <button type="button" class="btn-icon" title="查看任务详情" data-view-task-detail="${escapeHtml(l.id)}"><i data-lucide="file-search"></i></button>
                              <button type="button" class="btn-delete" title="删除此任务记录" data-delete-task="${escapeHtml(l.id)}"><i data-lucide="trash-2"></i></button>
                            </div>
                          </td>
                      </tr>`;
          })
          .join("");
        renderPagination("log_pagination", "log", pageData.total);
        lucide.createIcons();
      }

      async function deleteAdminTaskLog(jobKey) {
        const key = String(jobKey || "").trim();
        if (!key) {
          return;
        }
        const ok = await showAdminConfirm(
          `确定删除任务记录「${key}」？仅删除数据库中的本条记录，不会强制终止正在运行的子进程。`,
          "删除任务",
        );
        if (!ok) {
          return;
        }
        try {
          const res = await authFetch(
            `/api/admin/task-logs/${encodeURIComponent(key)}`,
            { method: "DELETE" },
          );
          let data = {};
          try {
            data = await res.json();
          } catch (_) {
            /* ignore */
          }
          if (!res.ok) {
            throw new Error(data.message || `删除失败（${res.status}）`);
          }
          showMessage(data.message || "任务记录已删除", "success");
          await loadData();
        } catch (e) {
          showMessage(e.message || "删除失败", "error");
        }
        lucide.createIcons();
      }

      function selectCdkPlanTypeFilter(value, label) {
        cdkPlanTypeFilter = value;
        const dropdown = document.querySelector(
          '.filter-dropdown[data-filter="cdk_plan_type_filter"]',
        );
        dropdown.querySelector(".filter-trigger span").innerText = label;
        dropdown.querySelectorAll(".filter-option").forEach((item) => {
          item.classList.toggle("active", item.textContent.trim() === label);
        });
        closeFilterMenus();
        paginationState.cdk.page = 1;
        loadCdkList().catch((error) => {
          console.error("Failed to load CDK list", error);
        });
      }

      async function generateCDKs(btn) {
        const count =
          parseInt(document.getElementById("cdk_count").value, 10) || 1;
        const plan_type =
          document.getElementById("cdk_plan_type").value || "plus";
        const card_group_id =
          document.getElementById("cdk_card_group")?.value || "";
        const proxy_group_id =
          document.getElementById("cdk_proxy_group")?.value || "";
        const original = btn.innerHTML;
        btn.innerHTML =
          '<i data-lucide="loader" class="animate-spin"></i> 生成中...';
        lucide.createIcons();

        try {
          const res = await authFetch("/api/admin/cdks/generate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ count, plan_type, card_group_id, proxy_group_id }),
          });
          const data = await res.json();
          if (!res.ok || !data.success) {
            throw new Error(data.message || "生成失败");
          }
          showMessage(data.message || "生成成功", "success");
          tableFilters.cdk = "all";
          paginationState.cdk.page = 1;
          cdkGroupFilter = card_group_id || "none";
          const dropdown = document.querySelector(
            '.filter-dropdown[data-filter="cdk"] .filter-trigger span',
          );
          if (dropdown) {
            dropdown.textContent = "全部状态";
          }
          await loadCdkList();
          const cdkFilter = document.getElementById("cdk_group_filter");
          if (cdkFilter) {
            cdkFilter.value = cdkGroupFilter;
            syncUiSelect(cdkFilter);
          }
        } catch (error) {
          showMessage(error.message || "生成失败", "error");
        } finally {
          btn.innerHTML = original;
          lucide.createIcons();
        }
      }

      async function deleteCDK(cdk) {
        const code = String(cdk || "").trim();
        if (!code) {
          return;
        }
        const ok = await showAdminConfirm(`确定删除 CDK: ${code} ?`, "删除 CDK");
        if (!ok) {
          return;
        }
        try {
          const res = await authFetch(
            `/api/admin/cdks/${encodeURIComponent(code)}`,
            { method: "DELETE" },
          );
          const data = await res.json().catch(() => ({}));
          if (!res.ok || data.success === false) {
            throw new Error(data.message || "删除失败");
          }
          showMessage(data.message || "CDK 已删除", "success");
          await loadData();
        } catch (error) {
          showMessage(error.message || "删除失败", "error");
        }
      }

      function renderPhoneTable() {
        const pageData = getPageItems(
          getFilteredItems("phone_pool"),
          "phone_pool",
        );
        document.getElementById("phone_pool_body").innerHTML = pageData.items
          .map((item, index) => {
            const actualIndex = phonePool.indexOf(item);
            const isActive = isAssetActive(item);
            const key = item.phone || "";
            return `
                      <tr>
                          <td class="select-cell"><input type="checkbox" ${selectedItems.phone_pool.has(key) ? "checked" : ""} onchange="toggleSelection('phone_pool', '${key}', this.checked)"></td>
                          <td><input type="text" class="asset-input" value="${item.phone}" onchange="phonePool[${actualIndex}].phone=this.value" placeholder="13800000000"></td>
                          <td><input type="text" class="asset-input" value="${item.key}" onchange="phonePool[${actualIndex}].key=this.value" placeholder="API Key"></td>
                          <td style="text-align:center">${Number(item.usage_count || 0)}</td>
                          <td style="text-align:center">${renderAssetStatus(isActive)}</td>
                          <td style="text-align:center"><button class="btn-delete" onclick="phonePool.splice(${actualIndex},1);renderPhoneTable()" title="删除"><i data-lucide="trash-2"></i></button></td>
                      </tr>
                  `;
          })
          .join("");
        renderPagination("phone_pool_pagination", "phone_pool", pageData.total);
        lucide.createIcons();
      }

      function formatCardExpiryForDisplay(expiry) {
        return String(expiry || "")
          .replace(/\D/g, "")
          .slice(0, 4);
      }

      function formatCardExpiryForSave(expiry) {
        const digits = String(expiry || "")
          .replace(/\D/g, "")
          .slice(0, 4);
        if (digits.length === 4) {
          return `${digits.slice(0, 2)}/${digits.slice(2)}`;
        }
        return String(expiry || "");
      }

      function renderCardTable() {
        // Legacy renderCardTable is now a no-op; card pool uses API-based rendering
        // Delegate to new loadCardPoolList if called
        loadCardPoolList();
      }

      function renderAssetStatus(isActive) {
        return isActive
          ? '<span class="status-badge status-success">正常</span>'
          : '<span class="status-badge status-failed">已作废</span>';
      }

      function getImportBoxId(type) {
        if (type === "phone_pool") return "phone_import_box";
        if (type === "card_pool") return "card_import_box";
        return "cdk_import_box";
      }

      function toggleImportBox(type) {
        const currentBox = document.getElementById(getImportBoxId(type));
        ["phone_pool", "card_pool", "cdk"].forEach((key) => {
          if (key !== type) {
            document
              .getElementById(getImportBoxId(key))
              ?.classList.remove("active");
          }
        });
        currentBox?.classList.toggle("active");
      }

      function normalizeImportLines(rawText) {
        return String(rawText || "")
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean);
      }

      function upsertPhoneAsset(phone, key) {
        const existing = phonePool.find(
          (item) => String(item.phone || "") === phone,
        );
        if (existing) {
          existing.key = key;
          existing.is_active = 1;
          existing.status = "normal";
          return false;
        }
        phonePool.push({
          phone,
          key,
          usage_count: 0,
          is_active: 1,
          status: "normal",
        });
        return true;
      }

      function upsertCardAsset(number, expiry, cvc) {
        const existing = cardPool.find(
          (item) => String(item.number || "") === number,
        );
        if (existing) {
          existing.expiry = expiry;
          existing.cvc = cvc;
          existing.is_active = 1;
          existing.status = "normal";
          return false;
        }
        cardPool.push({
          number,
          expiry,
          cvc,
          usage_count: 0,
          is_active: 1,
          status: "normal",
        });
        return true;
      }

      function importAssets(type) {
        const isPhonePool = type === "phone_pool";
        const textarea = document.getElementById(
          isPhonePool ? "phone_import_text" : "card_import_text",
        );
        const lines = normalizeImportLines(textarea?.value);

        if (lines.length === 0) {
          showMessage("请输入要导入的内容", "warning");
          return;
        }

        let createdCount = 0;
        let updatedCount = 0;

        for (let index = 0; index < lines.length; index += 1) {
          const line = lines[index];

          if (isPhonePool) {
            const match = line.match(/^([0-9]+)\s*-\s*(.+)$/);
            if (!match) {
              showMessage(
                `第 ${index + 1} 行格式错误，请使用 号码-APIKEY`,
                "error",
              );
              return;
            }

            const [, phone, key] = match;
            const isNew = upsertPhoneAsset(phone.trim(), key.trim());
            if (isNew) createdCount += 1;
            else updatedCount += 1;
            continue;
          }

          const match = line.match(
            /^([0-9]{12,19})\s*-\s*([0-9/]{4,5})\s*-\s*([0-9]{3,4})$/,
          );
          if (!match) {
            showMessage(
              `第 ${index + 1} 行格式错误，请使用 卡号-有效期-安全码`,
              "error",
            );
            return;
          }

          const [, number, rawExpiry, cvc] = match;
          const expiry = formatCardExpiryForDisplay(rawExpiry);
          if (expiry.length !== 4) {
            showMessage(
              `第 ${index + 1} 行有效期错误，请使用 4 位 MMYY`,
              "error",
            );
            return;
          }

          const isNew = upsertCardAsset(number.trim(), expiry, cvc.trim());
          if (isNew) createdCount += 1;
          else updatedCount += 1;
        }

        if (isPhonePool) {
          paginationState.phone_pool.page = Math.max(
            1,
            Math.ceil(phonePool.length / paginationState.phone_pool.pageSize),
          );
          renderPhoneTable();
        } else {
          paginationState.card_pool.page = Math.max(
            1,
            Math.ceil(cardPool.length / paginationState.card_pool.pageSize),
          );
          renderCardTable();
        }

        textarea.value = "";
        document
          .getElementById(isPhonePool ? "phone_import_box" : "card_import_box")
          ?.classList.remove("active");
        showMessage(
          `导入完成，新增 ${createdCount} 条，更新 ${updatedCount} 条`,
          "success",
        );
      }

      function normalizeCdkImportValues(rawText) {
        return [
          ...new Set(
            String(rawText || "")
              .split(/[\s,，]+/)
              .map((item) => item.trim())
              .filter(Boolean),
          ),
        ];
      }

      async function importCDKs() {
        const textarea = document.getElementById("cdk_import_text");
        const codes = normalizeCdkImportValues(textarea?.value);

        if (codes.length === 0) {
          showMessage("请输入要导入的卡密", "warning");
          return;
        }

        try {
          const res = await authFetch("/api/admin/cdks/import", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              cdks: codes,
              plan_type: document.getElementById("cdk_plan_type")?.value || "plus",
              card_group_id:
                document.getElementById("cdk_card_group")?.value || "",
              proxy_group_id:
                document.getElementById("cdk_proxy_group")?.value || "",
            }),
          });
          const data = await res.json();
          if (!res.ok || !data.success) {
            throw new Error(data.message || "导入失败");
          }
          textarea.value = "";
          document.getElementById("cdk_import_box")?.classList.remove("active");
          await loadData();
          showMessage(
            `导入完成，新增 ${Number(data.insertedCount || 0)} 个，重复 ${Number(data.duplicateCount || 0)} 个`,
            "success",
          );
        } catch (error) {
          showMessage(error.message || "导入失败", "error");
        }
      }

      function addAssetRow(type) {
        if (type === "phone_pool") {
          phonePool.push({
            phone: "",
            key: "",
            usage_count: 0,
            is_active: 1,
            status: "normal",
          });
          paginationState.phone_pool.page = Math.max(
            1,
            Math.ceil(phonePool.length / paginationState.phone_pool.pageSize),
          );
          renderPhoneTable();
          return;
        }

        cardPool.push({
          number: "",
          expiry: "",
          cvc: "",
          usage_count: 0,
          is_active: 1,
          status: "normal",
        });
        paginationState.card_pool.page = Math.max(
          1,
          Math.ceil(cardPool.length / paginationState.card_pool.pageSize),
        );
        renderCardTable();
      }

      function loadTelegramConfig(telegram) {
        const cfg = telegram || {};
        const setValue = (id, value, placeholder) => {
          const el = document.getElementById(id);
          if (!el) return;
          el.value = value ?? "";
          if (placeholder !== undefined) {
            el.placeholder = placeholder;
          }
        };
        const setChecked = (id, value) => {
          const el = document.getElementById(id);
          if (el) el.checked = Boolean(value);
        };
        const tokenPlaceholder = cfg.bot_token
          ? `已保存（${cfg.bot_token.slice(0, 10)}…）留空不修改`
          : "123456789:ABCdefGHI...";
        setValue("telegram_bot_token", "", tokenPlaceholder);
        setValue("telegram_admin_chat_id", cfg.admin_chat_id || "");
        setValue("telegram_group_chat_id", cfg.group_chat_id || "");
        setChecked("telegram_notify_admin", cfg.notify_admin);
        setChecked("telegram_notify_group", cfg.notify_group);
        setChecked("telegram_on_success", cfg.on_success);
        setChecked("telegram_on_failure", cfg.on_failure);
        setChecked("telegram_on_card_pool_empty", cfg.on_card_pool_empty);
      }

      function buildTelegramPayload() {
        return {
          bot_token:
            document.getElementById("telegram_bot_token")?.value.trim() || "",
          admin_chat_id:
            document.getElementById("telegram_admin_chat_id")?.value.trim() ||
            "",
          group_chat_id:
            document.getElementById("telegram_group_chat_id")?.value.trim() ||
            "",
          notify_admin: Boolean(
            document.getElementById("telegram_notify_admin")?.checked,
          ),
          notify_group: Boolean(
            document.getElementById("telegram_notify_group")?.checked,
          ),
          on_success: Boolean(
            document.getElementById("telegram_on_success")?.checked,
          ),
          on_failure: Boolean(
            document.getElementById("telegram_on_failure")?.checked,
          ),
          on_card_pool_empty: Boolean(
            document.getElementById("telegram_on_card_pool_empty")?.checked,
          ),
        };
      }

      async function saveTelegramConfig() {
        try {
          const res = await authFetch("/api/admin/telegram", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(buildTelegramPayload()),
          });
          const data = await res.json();
          if (!res.ok || !data.success) {
            throw new Error(data.message || "保存失败");
          }
          showMessage(data.message, "success");
          await reloadSystemConfigFromServer();
        } catch (error) {
          showMessage(error.message || "Telegram 配置保存失败", "error");
        }
      }

      async function testTelegramNotification() {
        try {
          const res = await authFetch("/api/admin/telegram/test", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({}),
          });
          const data = await res.json();
          if (!res.ok || !data.success) {
            throw new Error(data.message || "测试失败");
          }
          showMessage(data.message, "success");
        } catch (error) {
          showMessage(error.message || "Telegram 测试失败", "error");
        }
      }

      function loadHcaptchaConfig(hcaptcha) {
        const cfg = hcaptcha || {};
        const setValue = (id, value, placeholder) => {
          const el = document.getElementById(id);
          if (!el) return;
          el.value = value ?? "";
          if (placeholder !== undefined) {
            el.placeholder = placeholder;
          }
        };
        const setChecked = (id, value) => {
          const el = document.getElementById(id);
          if (el) el.checked = Boolean(value);
        };
        setChecked("hcaptcha_enabled", cfg.enabled !== false);
        setChecked("hcaptcha_no_vlm", cfg.no_vlm);
        const keySaved = Boolean(cfg.vlm_api_key_saved || cfg.vlm_api_key);
        const keyPreview =
          cfg.vlm_api_key_preview ||
          (cfg.vlm_api_key ? `${cfg.vlm_api_key.slice(0, 10)}…` : "");
        const keyPlaceholder = keySaved
          ? `已保存（${keyPreview || "sk-…"}）留空不修改`
          : "sk-...（也可写在 .env 的 HCAPTCHA_VLM_API_KEY）";
        setValue("hcaptcha_vlm_api_key", "", keyPlaceholder);
        const platformKeySaved = Boolean(
          cfg.captcha_platform_api_key_saved || cfg.captcha_platform_api_key,
        );
        const platformKeyPreview =
          cfg.captcha_platform_api_key_preview ||
          (cfg.captcha_platform_api_key
            ? `${cfg.captcha_platform_api_key.slice(0, 8)}…`
            : "");
        const platformKeyPlaceholder = platformKeySaved
          ? `已保存（${platformKeyPreview || "CAP-…"}）留空不修改`
          : "clientKey（也可写在 .env 的 HCAPTCHA_CAPTCHA_PLATFORM_API_KEY）";
        setValue(
          "hcaptcha_captcha_platform_api_key",
          "",
          platformKeyPlaceholder,
        );
        setValue(
          "hcaptcha_captcha_platform_api_url",
          cfg.captcha_platform_api_url || "https://api.anti-captcha.com",
        );
        setValue(
          "hcaptcha_captcha_platform_timeout",
          cfg.captcha_platform_timeout || 180,
        );
        setValue(
          "hcaptcha_vlm_base_url",
          cfg.vlm_base_url || "https://api.openai.com/v1",
        );
        setValue("hcaptcha_vlm_model", cfg.vlm_model || "gpt-5.5");
        setValue("hcaptcha_vlm_timeout", cfg.vlm_timeout || 45);
        setValue("hcaptcha_solver_timeout", cfg.solver_timeout || 240);
        setValue("hcaptcha_cdp_port", cfg.cdp_port || 9222);
        const hint = document.getElementById("hcaptcha_status_hint");
        if (hint) {
          if (platformKeySaved) {
            hint.textContent =
              "✓ 打码平台 Key 已持久化。passive checkbox 将优先走打码平台；VLM 仅作图片题备选。";
          } else if (keySaved) {
            hint.textContent =
              "✓ VLM 已持久化（MySQL + data/hcaptcha-config.json）。重建 app 容器无需重填 Key；留空保存不会覆盖已有 Key。";
          } else if (cfg.enabled === false) {
            hint.textContent = "当前已关闭自动求解。";
          } else {
            hint.textContent =
              "建议配置打码平台 API Key（推荐）。也可将 Key 写入 .env 的 HCAPTCHA_CAPTCHA_PLATFORM_API_KEY。";
          }
        }
      }

      function buildHcaptchaPayload() {
        return {
          enabled: Boolean(
            document.getElementById("hcaptcha_enabled")?.checked,
          ),
          vlm_api_key:
            document.getElementById("hcaptcha_vlm_api_key")?.value.trim() || "",
          vlm_base_url:
            document.getElementById("hcaptcha_vlm_base_url")?.value.trim() ||
            "https://api.openai.com/v1",
          vlm_model:
            document.getElementById("hcaptcha_vlm_model")?.value.trim() ||
            "gpt-5.5",
          vlm_timeout: Math.max(
            10,
            parseInt(
              document.getElementById("hcaptcha_vlm_timeout")?.value,
              10,
            ) || 45,
          ),
          solver_timeout: Math.max(
            60,
            parseInt(
              document.getElementById("hcaptcha_solver_timeout")?.value,
              10,
            ) || 240,
          ),
          no_vlm: Boolean(document.getElementById("hcaptcha_no_vlm")?.checked),
          cdp_port:
            String(
              document.getElementById("hcaptcha_cdp_port")?.value || "9222",
            ).trim() || "9222",
          captcha_platform_api_key:
            document
              .getElementById("hcaptcha_captcha_platform_api_key")
              ?.value.trim() || "",
          captcha_platform_api_url:
            document
              .getElementById("hcaptcha_captcha_platform_api_url")
              ?.value.trim() || "https://api.anti-captcha.com",
          captcha_platform_timeout: Math.max(
            30,
            parseInt(
              document.getElementById("hcaptcha_captcha_platform_timeout")
                ?.value,
              10,
            ) || 180,
          ),
        };
      }

      async function saveHcaptchaConfig() {
        try {
          const res = await authFetch("/api/admin/hcaptcha", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(buildHcaptchaPayload()),
          });
          const data = await res.json();
          if (!res.ok || !data.success) {
            throw new Error(data.message || "保存失败");
          }
          showMessage(data.message, "success");
          await reloadSystemConfigFromServer();
        } catch (error) {
          showMessage(error.message || "hCaptcha 配置保存失败", "error");
        }
      }

      async function testHcaptchaSolver() {
        try {
          const res = await authFetch("/api/admin/hcaptcha/test", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({}),
          });
          const data = await res.json();
          const hint = document.getElementById("hcaptcha_status_hint");
          if (hint) {
            hint.textContent = data.message || data.status?.message || "";
          }
          if (!res.ok || !data.success) {
            throw new Error(data.message || "检测失败");
          }
          showMessage(data.message, "success");
          await refreshHcaptchaLogs();
        } catch (error) {
          showMessage(error.message || "hCaptcha 环境检测失败", "error");
        }
      }

      async function testHcaptchaVlm() {
        try {
          const res = await authFetch("/api/admin/hcaptcha/test-vlm", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(buildHcaptchaPayload()),
          });
          const data = await res.json();
          const hint = document.getElementById("hcaptcha_status_hint");
          const detail = [
            data.message,
            data.model ? `model=${data.model}` : "",
            data.latency_ms != null ? `latency=${data.latency_ms}ms` : "",
            data.response_preview ? `reply=${data.response_preview}` : "",
          ]
            .filter(Boolean)
            .join(" | ");
          if (hint) hint.textContent = detail;
          if (!res.ok || !data.success) {
            throw new Error(data.message || "VLM 测试失败");
          }
          showMessage(data.message, "success");
        } catch (error) {
          showMessage(error.message || "VLM 连通性测试失败", "error");
        }
      }

      async function testHcaptchaCaptchaPlatform() {
        try {
          const payload = buildHcaptchaPayload();
          const res = await authFetch(
            "/api/admin/hcaptcha/test-captcha-platform",
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(payload),
            },
          );
          const data = await res.json();
          const hint = document.getElementById("hcaptcha_status_hint");
          if (!res.ok || !data.success) {
            throw new Error(data.message || "打码平台测试失败");
          }
          if (hint) {
            hint.textContent = data.message || "打码平台连通正常";
            hint.style.color = "var(--success)";
          }
          showMessage(data.message || "打码平台连通正常", "success");
        } catch (error) {
          showMessage(error.message || "打码平台测试失败", "error");
        }
      }

      async function refreshHcaptchaLogs() {
        const panel = document.getElementById("hcaptcha_log_panel");
        const output = document.getElementById("hcaptcha_log_output");
        if (!panel || !output) return;
        try {
          const res = await authFetch("/api/admin/hcaptcha/logs?limit=10");
          const data = await res.json();
          if (!res.ok || !data.success) {
            throw new Error(data.message || "读取日志失败");
          }
          panel.style.display = "block";
          const runtimeLines = (data.runtime || []).map(
            (e) => `[${formatRuntimeLogTs(e.ts)}] ${e.text}`,
          );
          const fileList = (data.files || []).map(
            (f) => `${f.name} (${Math.round(f.size / 1024)}KB)`,
          );
          let latestFileLines = [];
          if (data.files && data.files[0]) {
            const fileRes = await authFetch(
              `/api/admin/hcaptcha/logs?file=${encodeURIComponent(data.files[0].name)}`,
            );
            const fileData = await fileRes.json();
            if (fileRes.ok && fileData.success) {
              latestFileLines = fileData.lines || [];
            }
          }
          output.textContent = [
            "=== 运行时 CAPTCHA 日志 ===",
            ...(runtimeLines.length
              ? runtimeLines
              : ["（暂无，跑一笔任务后刷新）"]),
            "",
            "=== Solver 文件 ===",
            ...(fileList.length ? fileList : ["（暂无 solver 日志文件）"]),
            "",
            "=== 最新 solver 日志尾部 ===",
            ...(latestFileLines.length ? latestFileLines : ["（空）"]),
          ].join("\n");
        } catch (error) {
          panel.style.display = "block";
          output.textContent = `读取日志失败: ${error.message}`;
        }
      }

      async function saveAllConfigs() {
        const btn = event.currentTarget;
        const originalContent = btn.innerHTML;
        btn.innerHTML =
          '<i data-lucide="loader" class="animate-spin"></i> 处理中...';
        lucide.createIcons();

        const payload = buildConfigPayload();

        try {
          const res = await authFetch("/api/admin/config", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
          const data = await res.json();
          if (!res.ok || !data.success) {
            throw new Error(data.message || "保存失败");
          }
          const regionSaved = await savePaymentRegion(true);
          if (!regionSaved) {
            throw new Error("基本配置已保存，但支付地区保存失败");
          }
          showMessage(data.message, "success");
          await loadData(true);
        } catch (error) {
          showMessage(error.message || "保存失败", "error");
        } finally {
          btn.innerHTML = originalContent;
          lucide.createIcons();
        }
      }

      async function changeAdminPassword() {
        const btn = event.currentTarget;
        const originalContent = btn.innerHTML;
        const currentPassword =
          document.getElementById("current_password").value;
        const newPassword = document
          .getElementById("new_password")
          .value.trim();

        if (!currentPassword) {
          showMessage("请输入原密码", "warning");
          return;
        }

        if (newPassword.length < 12) {
          showMessage("新密码至少 12 位", "warning");
          return;
        }

        btn.innerHTML =
          '<i data-lucide="loader" class="animate-spin"></i> 提交中...';
        lucide.createIcons();

        try {
          const res = await authFetch("/api/admin/change-password", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ currentPassword, newPassword }),
          });
          const data = await res.json();
          if (!res.ok || !data.success) {
            throw new Error(data.message || "修改失败");
          }

          document.getElementById("current_password").value = "";
          document.getElementById("new_password").value = "";
          showMessage(data.message, "success");
          redirectToLogin();
        } catch (error) {
          showMessage(error.message || "修改失败", "error");
        } finally {
          btn.innerHTML = originalContent;
          lucide.createIcons();
        }
      }

      function renderProductTable() {
        const pageData = getPageItems(getFilteredItems("product"), "product");
        const tbody = document.getElementById("product_body");
        if (!tbody) return;

        tbody.innerHTML = pageData.items
          .map((p) => {
            const isActive = p.status === "正常";
            return `
                      <tr>
                          <td class="select-cell"><input type="checkbox" ${selectedItems.product.has(String(p.id)) ? "checked" : ""} onchange="toggleSelection('product', '${p.id}', this.checked)"></td>
                          <td><code>${p.email}</code></td>
                          <td>${p.claimed_cdk ? `<code>${p.claimed_cdk}</code>` : '<span style="color: var(--text-dim);">-</span>'}</td>
                          <td>
                              ${
                                p.imap_key
                                  ? `<a href="https://imap.chiyiyi.cloud/?key=${encodeURIComponent(p.imap_key)}" target="_blank" rel="noopener noreferrer" style="color: var(--accent); text-decoration: none; font-family: monospace;">${p.imap_key}</a>`
                                  : '<span style="color: var(--text-dim);">-</span>'
                              }
                          </td>
                          <td>${p.time}</td>
                          <td style="text-align:center">
                              <span class="status-badge ${isActive ? "status-success" : "status-failed"}" style="cursor: pointer;" onclick="toggleProductStatus('${p.id}', '${p.status}')" title="${isActive ? "点击封禁" : "点击恢复"}">${p.status}</span>
                          </td>
                          <td style="text-align:center">
                              <span class="readonly-switch ${p.shipped ? "active" : ""}" title="${p.shipped ? "已出库" : "未出库"}"></span>
                          </td>
                          <td>
                              <div style="display: flex; justify-content: center; gap: 8px;">
                                  <button class="btn-delete" style="background: rgba(16, 185, 129, 0.12); color: var(--success);" onclick="exportSingleProduct('${p.id}', '${p.email}')" title="单个出库下载">
                                      <i data-lucide="download"></i>
                                  </button>
                                  <button class="btn-delete" onclick="deleteProduct('${p.id}')" title="删除">
                                      <i data-lucide="trash-2"></i>
                                  </button>
                              </div>
                          </td>
                      </tr>
                  `;
          })
          .join("");
        renderPagination("product_pagination", "product", pageData.total);
        lucide.createIcons();
      }

      async function toggleProductStatus(id, currentStatus) {
        const newStatus = currentStatus === "正常" ? "封禁" : "正常";
        try {
          const res = await authFetch(`/api/admin/products/${id}/status`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ status: newStatus }),
          });
          if (res.ok) {
            showMessage("状态已更新", "success");
            loadData();
          } else {
            showMessage("状态更新失败", "error");
          }
        } catch (e) {
          showMessage("网络错误", "error");
        }
      }

      async function batchDeleteProducts() {
        const selected = Array.from(selectedItems.product);
        if (selected.length === 0) {
          showMessage("请先选择要删除的成品号", "warn");
          return;
        }
        const ok = await showAdminConfirm(
          `确定要删除选中的 ${selected.length} 个成品号吗？此操作不可恢复。`,
          "删除成品号",
        );
        if (!ok) {
          return;
        }
        let successCount = 0;
        for (const id of selected) {
          try {
            const res = await authFetch(`/api/admin/products/${id}`, {
              method: "DELETE",
            });
            if (res.ok) successCount++;
          } catch (e) {
            console.error("Delete error", e);
          }
        }
        showMessage(`成功删除 ${successCount} 个成品号`, "success");
        selectedItems.product.clear();
        loadData(); // reload data
      }

      async function batchExportProducts() {
        const selected = Array.from(selectedItems.product);
        if (selected.length === 0) {
          showMessage("请先选择要导出的成品号", "warn");
          return;
        }

        const okExport = await showAdminConfirm(
          `确定要将选中的 ${selected.length} 个成品号批量出库并导出为一个 JSON 文件吗？`,
          "批量出库",
        );
        if (!okExport) {
          return;
        }

        try {
          const res = await authFetch("/api/admin/products/export", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ids: selected }),
          });

          if (!res.ok) {
            let message = "批量出库失败";
            try {
              const data = await res.json();
              message = data.message || message;
            } catch (_) {}
            throw new Error(message);
          }

          const blob = await res.blob();
          const disposition = res.headers.get("Content-Disposition") || "";
          const match = disposition.match(/filename=([^;]+)/i);
          const fileName = match
            ? decodeURIComponent(match[1].replace(/"/g, "").trim())
            : `成品号批量出库_${Date.now()}.json`;
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = fileName;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          URL.revokeObjectURL(url);

          showMessage(`已批量出库 ${selected.length} 个成品号`, "success");
          selectedItems.product.clear();
          loadData();
        } catch (e) {
          showMessage(e.message || "批量出库失败", "error");
        }
      }

      async function exportSingleProduct(id, email) {
        try {
          const res = await authFetch(`/api/admin/products/${id}/export`);
          if (!res.ok) {
            throw new Error((await res.text()) || "单个出库失败");
          }

          const blob = await res.blob();
          const disposition = res.headers.get("Content-Disposition") || "";
          const match = disposition.match(/filename=([^;]+)/i);
          const fileName = match
            ? decodeURIComponent(match[1].replace(/"/g, "").trim())
            : `成品号出库_${Date.now()}.json`;
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = fileName;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          URL.revokeObjectURL(url);

          showMessage(`已单个出库 ${email}`, "success");
          await loadData();
        } catch (error) {
          showMessage(error.message || "单个出库失败", "error");
        }
      }

      async function deleteProduct(id) {
        const ok = await showAdminConfirm(
          "确定要删除该成品号吗？",
          "删除成品号",
        );
        if (!ok) {
          return;
        }
        try {
          await authFetch(`/api/admin/products/${id}`, { method: "DELETE" });
          showMessage("成品号已删除", "success");
          await loadData();
        } catch (error) {
          showMessage(error.message, "error");
        }
      }

      async function runAdminProductGeneration(
        btn,
        endpoint,
        payload,
        options = {},
      ) {
        const container = document.getElementById(
          "product_gen_progress_container",
        );
        const bar = document.getElementById("product_gen_bar");
        const percentText = document.getElementById("product_gen_percent");
        const statusText = document.getElementById("product_gen_status");
        const count = Math.max(1, Number(options.count || payload?.count || 1));
        const wsHeartbeatIntervalMs = 5000;
        const wsHeartbeatTimeoutMs = 12000;

        if (btn.disabled) return;

        btn.disabled = true;
        const originalContent = btn.innerHTML;
        btn.innerHTML = `<i data-lucide="loader" class="animate-spin"></i> ${options.loadingText || "生产中..."}`;
        lucide.createIcons();

        if (options.switchToProducts) {
          switchPage("products");
        }

        container.style.display = "block";
        bar.style.width = "0%";
        percentText.innerText = "0%";
        statusText.innerText =
          options.initialText || `准备生产 ${count} 个成品号...`;
        bar.style.background = "var(--primary)";

        let socket = null;
        let settled = false;
        let heartbeatInterval = null;
        let heartbeatTimeout = null;
        let reconnectTimer = null;

        const clearHeartbeat = () => {
          clearInterval(heartbeatInterval);
          clearTimeout(heartbeatTimeout);
          heartbeatInterval = null;
          heartbeatTimeout = null;
        };

        const scheduleHeartbeatTimeout = () => {
          clearTimeout(heartbeatTimeout);
          heartbeatTimeout = setTimeout(() => {
            if (socket && !settled) {
              console.warn(
                "Admin product WS heartbeat timeout, reconnecting...",
              );
              try {
                socket.close();
              } catch (_) {}
            }
          }, wsHeartbeatTimeoutMs);
        };

        const startHeartbeat = () => {
          clearHeartbeat();
          scheduleHeartbeatTimeout();
          heartbeatInterval = setInterval(() => {
            if (!socket || socket.readyState !== WebSocket.OPEN) {
              return;
            }
            try {
              socket.send(JSON.stringify({ type: "ping", ts: Date.now() }));
              scheduleHeartbeatTimeout();
            } catch (error) {
              console.error("Admin product ws ping failed", error);
            }
          }, wsHeartbeatIntervalMs);
        };

        const cleanupSocket = () => {
          clearHeartbeat();
          clearTimeout(reconnectTimer);
          reconnectTimer = null;
          if (socket) {
            try {
              socket.close();
            } catch (_) {}
          }
          socket = null;
        };

        const finish = async (message, isSuccess) => {
          if (settled) return;
          settled = true;
          cleanupSocket();
          window.__adminProductGenJobKey = "";
          setProductGenStopVisible(false);
          statusText.innerText = message;
          bar.style.background = isSuccess ? "var(--success)" : "var(--danger)";
          btn.disabled = false;
          btn.innerHTML = originalContent;
          lucide.createIcons();
          await loadData();
        };

        try {
          const response = await authFetch(endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload || {}),
          });
          const data = await response.json();

          if (!data.success || !data.jobKey) {
            throw new Error(
              data.message || options.failMessage || "后台成品生产启动失败",
            );
          }

          window.__adminProductGenJobKey = String(data.jobKey);
          setProductGenStopVisible(true);

          statusText.innerText =
            data.message ||
            options.runningText ||
            `后台成品生产已启动，并发上限 ${data.workerCount || 1}`;

          const connectSocket = () => {
            const protocol =
              window.location.protocol === "https:" ? "wss:" : "ws:";
            socket = new WebSocket(`${protocol}//${window.location.host}`);

            socket.onopen = () => {
              clearTimeout(reconnectTimer);
              reconnectTimer = null;
              socket.send(
                JSON.stringify({
                  type: "subscribe",
                  jobKey: data.jobKey,
                }),
              );
              startHeartbeat();
            };

            socket.onmessage = async (event) => {
              try {
                const payload = JSON.parse(event.data);
                if (payload.type === "pong") {
                  scheduleHeartbeatTimeout();
                  return;
                }
                if (payload.jobKey !== data.jobKey) return;

                scheduleHeartbeatTimeout();

                const progress = Math.max(
                  0,
                  Math.min(100, Math.round(Number(payload.progress) || 0)),
                );
                bar.style.width = `${progress}%`;
                percentText.innerText = `${progress}%`;
                if (payload.message) {
                  statusText.innerText = payload.message;
                }

                if (payload.status === "success") {
                  await finish(
                    payload.message || `成功生产 ${count} 个成品号！`,
                    true,
                  );
                } else if (
                  payload.status === "failed" ||
                  payload.status === "maintenance"
                ) {
                  await finish(payload.message || "后台成品生产失败", false);
                }
              } catch (error) {
                console.error("Admin product ws parse failed", error);
              }
            };

            socket.onclose = () => {
              clearHeartbeat();
              socket = null;
              if (!settled) {
                statusText.innerText = "连接中断，正在重连...";
                clearTimeout(reconnectTimer);
                reconnectTimer = setTimeout(connectSocket, 3000);
              }
            };

            socket.onerror = (error) => {
              console.error("Admin product ws error", error);
            };
          };

          connectSocket();
        } catch (error) {
          window.__adminProductGenJobKey = "";
          setProductGenStopVisible(false);
          container.style.display = "none";
          bar.style.width = "0%";
          percentText.innerText = "0%";
          statusText.innerText = "正在准备生产环境...";
          bar.style.background = "var(--primary)";
          btn.disabled = false;
          btn.innerHTML = originalContent;
          lucide.createIcons();
          showMessage(
            error.message || options.failMessage || "后台成品生产启动失败",
            "error",
          );
        }
      }

      async function startProductGeneration(btn) {
        const count =
          parseInt(document.getElementById("product_gen_count").value, 10) || 1;
        await runAdminProductGeneration(
          btn,
          "/api/admin/products/generate",
          { count },
          {
            count,
            loadingText: "生产中...",
            initialText: `准备生产 ${count} 个成品号...`,
            failMessage: "后台成品生产启动失败",
          },
        );
      }

      async function resumePendingProducts(btn) {
        const count = Math.max(1, Number(btn?.dataset?.count || 1));
        await runAdminProductGeneration(
          btn,
          "/api/admin/products/resume",
          {},
          {
            count,
            loadingText: "继续中...",
            initialText: `准备继续生产剩余 ${count} 个成品号...`,
            failMessage: "继续生产启动失败",
            switchToProducts: true,
          },
        );
      }

      // ==================== 账单记录 ====================
      const billingState = { page: 1, pageSize: 20, total: 0 };

      function getBillingFilters() {
        return {
          start_date:
            document.getElementById("billing_start_date")?.value || "",
          end_date: document.getElementById("billing_end_date")?.value || "",
          card_last4:
            document.getElementById("billing_card_last4")?.value.trim() || "",
          plan_type: document.getElementById("billing_plan_type")?.value || "",
          status: document.getElementById("billing_status")?.value || "",
        };
      }

      async function loadBillingRecords(page) {
        billingState.page = page || billingState.page;
        const filters = getBillingFilters();
        const params = new URLSearchParams();
        if (filters.start_date) params.set("start_date", filters.start_date);
        if (filters.end_date) params.set("end_date", filters.end_date);
        if (filters.card_last4) params.set("card_last4", filters.card_last4);
        if (filters.plan_type) params.set("plan_type", filters.plan_type);
        if (filters.status) params.set("status", filters.status);
        params.set("page", billingState.page);

        try {
          const res = await authFetch(
            `/api/admin/billing?${params.toString()}`,
          );
          const data = await res.json();
          if (!data.success) {
            showMessage(data.error || "查询失败", "error");
            return;
          }
          billingState.total = data.total || 0;
          renderBillingTable(data.records || []);
          renderBillingPagination();
          const hint = document.getElementById("billing_total_hint");
          if (hint) hint.textContent = `共 ${billingState.total} 条记录`;
        } catch (e) {
          showMessage("查询账单失败: " + e.message, "error");
        }
      }

      function renderBillingTable(records) {
        const tbody = document.getElementById("billing_body");
        if (!tbody) return;
        if (!records.length) {
          tbody.innerHTML = `<tr><td colspan="9" style="text-align:center; color:var(--text-dim); padding:32px;">暂无账单记录</td></tr>`;
          return;
        }
        const planLabels = {
          plus: "Plus",
          pro_5x: "Pro 5x",
          pro_20x: "Pro 20x",
          credits: "Codex 点数",
          credits_250: "Codex 250",
          credits_500: "Codex 500",
          credits_1000: "Codex 1000",
          credits_1500: "Codex 1500",
          credits_2000: "Codex 2000",
        };
        tbody.innerHTML = records
          .map((r) => {
            const time = r.payment_time
              ? formatAdminDateTime(r.payment_time)
              : "-";
            const statusClass =
              r.status === "success" ? "status-success" : "status-failed";
            const statusText = r.status === "success" ? "成功" : "失败";
            const planLabel = planLabels[r.plan_type] || r.plan_type || "-";
            const cardDisplay = escapeHtml(
              r.card_number || r.card_last4 || "-",
            );
            const cardSummaryKey = escapeHtml(
              r.card_last4 ||
                (r.card_number ? String(r.card_number).slice(-4) : ""),
            );
            return `<tr>
                          <td>${escapeHtml(time)}</td>
                          <td><a href="javascript:void(0)" onclick="showCardBillingSummary('${cardSummaryKey}')" style="cursor:pointer; color:var(--primary); font-weight:600; font-family:monospace;">${cardDisplay}</a></td>
                          <td>${escapeHtml(r.amount != null ? Number(r.amount).toFixed(2) : "-")}</td>
                          <td>${escapeHtml(r.currency || "-")}</td>
                          <td>${escapeHtml(planLabel)}</td>
                          <td style="font-family:monospace; font-size:12px;">${escapeHtml(r.cdk_code || "-")}</td>
                          <td style="font-size:12px;">${escapeHtml(r.email || "-")}</td>
                          <td style="text-align:center"><span class="status-badge ${statusClass}">${statusText}</span></td>
                          <td style="text-align:center">
                              <button type="button" class="btn-delete" data-delete-billing="${escapeHtml(String(r.id))}" title="删除此账单">
                                  <i data-lucide="trash-2"></i>
                              </button>
                          </td>
                      </tr>`;
          })
          .join("");
        lucide.createIcons();
      }

      async function deleteBillingRecord(id) {
        if (!id) {
          return;
        }
        const ok = await showAdminConfirm("确定删除这条账单记录吗？");
        if (!ok) {
          return;
        }
        try {
          const res = await authFetch(
            `/api/admin/billing/${encodeURIComponent(id)}`,
            { method: "DELETE" },
          );
          const data = await res.json();
          if (!res.ok || !data.success) {
            throw new Error(data.message || "删除失败");
          }
          showMessage("账单记录已删除", "success");
          await loadBillingRecords();
        } catch (error) {
          showMessage(error.message || "删除失败", "error");
        }
      }

      async function clearFailedBillingRecords() {
        const ok = await showAdminConfirm(
          "确定清除所有失败状态的账单记录吗？此操作不可恢复。",
        );
        if (!ok) {
          return;
        }
        try {
          const res = await authFetch("/api/admin/billing/failed", {
            method: "DELETE",
          });
          const data = await res.json();
          if (!res.ok || !data.success) {
            throw new Error(data.message || "清除失败");
          }
          showMessage(`已清除 ${data.deleted || 0} 条失败账单`, "success");
          await loadBillingRecords(1);
        } catch (error) {
          showMessage(error.message || "清除失败", "error");
        }
      }

      function renderBillingPagination() {
        const container = document.getElementById("billing_pagination");
        if (!container) return;
        const totalPages = Math.max(
          1,
          Math.ceil(billingState.total / billingState.pageSize),
        );
        const page = billingState.page;
        const start =
          billingState.total === 0 ? 0 : (page - 1) * billingState.pageSize + 1;
        const end = Math.min(page * billingState.pageSize, billingState.total);

        let paginationHtml = `<div class="pagination-meta">显示 ${start}-${end}，共 ${billingState.total} 条</div>`;
        paginationHtml += `<div class="pagination">`;
        paginationHtml += `<button class="pagination-nav" onclick="loadBillingRecords(${page - 1})" ${page <= 1 ? "disabled" : ""}>上一页</button>`;
        // Page numbers
        const items = getBillingPaginationItems(page, totalPages);
        items.forEach((item) => {
          if (item === "...") {
            paginationHtml += `<span class="pagination-ellipsis">...</span>`;
          } else {
            paginationHtml += `<button class="${item === page ? "active" : ""}" onclick="loadBillingRecords(${item})">${item}</button>`;
          }
        });
        paginationHtml += `<button class="pagination-nav" onclick="loadBillingRecords(${page + 1})" ${page >= totalPages ? "disabled" : ""}>下一页</button>`;
        paginationHtml += `</div>`;
        container.innerHTML = paginationHtml;
      }

      function getBillingPaginationItems(current, totalPages) {
        if (totalPages <= 7)
          return Array.from({ length: totalPages }, (_, i) => i + 1);
        const items = [];
        items.push(1);
        if (current > 3) items.push("...");
        for (
          let i = Math.max(2, current - 1);
          i <= Math.min(totalPages - 1, current + 1);
          i++
        ) {
          items.push(i);
        }
        if (current < totalPages - 2) items.push("...");
        items.push(totalPages);
        return items;
      }

      async function exportBillingCSV() {
        const filters = getBillingFilters();
        const params = new URLSearchParams();
        if (filters.start_date) params.set("start_date", filters.start_date);
        if (filters.end_date) params.set("end_date", filters.end_date);
        if (filters.card_last4) params.set("card_last4", filters.card_last4);
        if (filters.plan_type) params.set("plan_type", filters.plan_type);
        if (filters.status) params.set("status", filters.status);

        try {
          const res = await authFetch(
            `/api/admin/billing/export?${params.toString()}`,
          );
          if (!res.ok) {
            const errData = await res.json().catch(() => ({}));
            showMessage(errData.error || "导出失败", "error");
            return;
          }
          const blob = await res.blob();
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = `billing_export_${new Date().toISOString().slice(0, 10)}.csv`;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
          showMessage("CSV 导出成功", "success");
        } catch (e) {
          showMessage("导出 CSV 失败: " + e.message, "error");
        }
      }

      async function showCardBillingSummary(cardLast4) {
        if (!cardLast4) return;
        const panel = document.getElementById("billing_summary_panel");
        const title = document.getElementById("billing_summary_title");
        const stats = document.getElementById("billing_summary_stats");
        if (!panel || !title || !stats) return;

        title.textContent = `卡片 **** ${cardLast4} 消费汇总`;
        stats.innerHTML = `<div style="padding:20px; color:var(--text-dim);">加载中...</div>`;
        panel.style.display = "block";
        panel.scrollIntoView({ behavior: "smooth", block: "nearest" });

        try {
          const res = await authFetch(
            `/api/admin/billing/summary/${encodeURIComponent(cardLast4)}`,
          );
          const data = await res.json();
          if (!data.success) {
            stats.innerHTML = `<div style="padding:20px; color:var(--error);">${escapeHtml(data.error || "查询失败")}</div>`;
            return;
          }
          const summary = data;
          stats.innerHTML = `
                          <div class="stat-card">
                              <div class="stat-header">
                                  <span class="stat-label">累计消费金额</span>
                                  <div class="stat-icon" style="background: rgba(16, 185, 129, 0.1); color: #10b981;">
                                      <i data-lucide="banknote"></i>
                                  </div>
                              </div>
                              <div class="stat-value" style="color: #047857;">${Number(summary.cumulative_amount || 0).toFixed(2)}</div>
                          </div>
                          <div class="stat-card">
                              <div class="stat-header">
                                  <span class="stat-label">成功支付次数</span>
                                  <div class="stat-icon" style="background: rgba(16, 185, 129, 0.1); color: #10b981;">
                                      <i data-lucide="check-circle"></i>
                                  </div>
                              </div>
                              <div class="stat-value" style="color: var(--success);">${summary.success_count || 0}</div>
                          </div>
                          <div class="stat-card">
                              <div class="stat-header">
                                  <span class="stat-label">失败支付次数</span>
                                  <div class="stat-icon" style="background: rgba(239, 68, 68, 0.1); color: #f87171;">
                                      <i data-lucide="x-circle"></i>
                                  </div>
                              </div>
                              <div class="stat-value" style="color: var(--error);">${summary.failed_count || 0}</div>
                          </div>
                      `;
          lucide.createIcons();
        } catch (e) {
          stats.innerHTML = `<div style="padding:20px; color:var(--error);">加载失败: ${escapeHtml(e.message)}</div>`;
        }
      }

      function closeBillingSummary() {
        const panel = document.getElementById("billing_summary_panel");
        if (panel) panel.style.display = "none";
      }

      const SIDEBAR_COLLAPSED_KEY = "oai_admin_sidebar_collapsed";

      function setSidebarCollapsed(collapsed, persist = false) {
        const sidebar = document.querySelector(".sidebar");
        const toggle = document.getElementById("sidebar_toggle");
        if (!sidebar || !toggle) {
          return;
        }

        sidebar.classList.toggle("collapsed", collapsed);
        toggle.setAttribute(
          "aria-label",
          collapsed ? "展开菜单栏" : "收起菜单栏",
        );
        toggle.title = collapsed ? "展开菜单栏" : "收起菜单栏";
        toggle.innerHTML = `<i data-lucide="${collapsed ? "chevron-right" : "chevron-left"}"></i>`;
        document.querySelectorAll(".nav-item").forEach((item) => {
          const label = item.querySelector("span")?.textContent?.trim();
          if (label) {
            item.title = label;
          }
        });
        lucide.createIcons();

        if (persist) {
          localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(collapsed));
        }
      }

      function toggleSidebar() {
        const sidebar = document.querySelector(".sidebar");
        setSidebarCollapsed(!sidebar?.classList.contains("collapsed"), true);
      }

      function initializeSidebar() {
        setSidebarCollapsed(
          localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "true",
        );
      }

      async function bootAdmin() {
        enhanceAssetSelects();
        initializeSidebar();
        document
          .getElementById("admin_login_path")
          ?.addEventListener("input", updateAdminPathPreview);
        document
          .getElementById("admin_panel_path")
          ?.addEventListener("input", updateAdminPathPreview);
        document
          .getElementById("checkout_path")
          ?.addEventListener("input", updateAdminPathPreview);

        try {
          await ensureAdminSession();
          await loadData(true);
          await loadRegionConfig();
          await loadGptApiConfig();
          if (adminDataRefreshTimer) {
            clearInterval(adminDataRefreshTimer);
          }
          adminDataRefreshTimer = setInterval(() => {
            if (adminDataRefreshPaused) return;
            const logsPage = document.getElementById("logs");
            if (logsPage && logsPage.classList.contains("active")) {
              loadTaskLogs(false).catch(() => {});
              return;
            }
            const dashboard = document.getElementById("dashboard");
            if (!dashboard || !dashboard.classList.contains("active")) return;
            const now = Date.now();
            if (now - lastAdminDataRefreshAt < 10000) return;
            lastAdminDataRefreshAt = now;
            loadData(false).catch(() => {});
          }, 2000);
          updateAdminDataRefreshButton();
          lucide.createIcons();
        } catch (error) {
          console.error("Admin boot failed", error);
        }
      }

      document
        .getElementById("maintenance_mode")
        ?.addEventListener("change", () => {
          if (maintenanceModeSaving) {
            return;
          }
          saveMaintenanceMode().catch((error) => {
            console.error("Maintenance mode save failed", error);
          });
        });

      document.querySelectorAll('input[name="email_source"]').forEach((el) => {
        el.addEventListener("change", () => syncEmailSourceUI());
      });

      // ─── Region & Address Management ───────────────────────────────────────────
      let regionAddressList = [];
      let currentRegion = "PH";
      let paymentRegionCatalog = {};
      let checkoutPlanMap = {
        plus: "chatgptplusplan",
        pro_5x: "chatgptprolite",
        pro_20x: "chatgptpro",
      };
      let checkoutDebugJobKey = "";
      let checkoutDebugLogAfter = 0;
      let checkoutDebugLogText = "";
      let checkoutDebugLogPollTimer = null;
      let checkoutDebugStatusPollTimer = null;
      let checkoutDebugMode = "link";
      const CHECKOUT_DEBUG_TERMINAL_STATUSES = new Set([
        "success",
        "failed",
        "error",
        "cancelled",
        "canceled",
        "timeout",
        "timed_out",
        "manual",
      ]);
      const CHECKOUT_DEBUG_BUSY_STATUSES = new Set([
        "running",
        "processing",
        "queued",
        "pending",
        "retry",
      ]);
      let checkoutDebugUnlockTimer = null;

      function checkoutDebugLogsIndicateFailure(text) {
        return /❌\s*\[运行时错误\]|API 创建 Checkout 失败|无法创建官方 Checkout|支付失败 \(|调试失败|CHECKOUT_DEBUG_FAILED/.test(
          String(text || ""),
        );
      }

      function checkoutDebugLogsIndicateFinished(text) {
        const raw = String(text || "");
        return (
          /👋 \[系统\] 流程结束/.test(raw) ||
          /CHECKOUT_DEBUG_SUCCESS/.test(raw) ||
          /PAYMENT_SUCCESS/.test(raw) ||
          checkoutDebugLogsIndicateFailure(raw)
        );
      }

      function setCheckoutDebugBusy(busy, runningLabel) {
        const specs = [
          [
            "checkout_link_debug_btn",
            "play",
            "链接调试",
            "链接调试中...",
          ],
          [
            "checkout_payment_debug_btn",
            "credit-card",
            "支付调试",
            "支付调试中...",
          ],
          [
            "checkout_custom_pay_btn",
            "log-in",
            "自定义付款",
            "自定义付款中...",
          ],
        ];
        const activeId =
          checkoutDebugMode === "custom"
            ? "checkout_custom_pay_btn"
            : checkoutDebugMode === "payment"
              ? "checkout_payment_debug_btn"
              : "checkout_link_debug_btn";
        for (const [id, icon, idle] of specs) {
          const el = document.getElementById(id);
          if (!el) continue;
          el.disabled = Boolean(busy);
          if (!busy) {
            el.innerHTML = `<i data-lucide="${icon}"></i> ${idle}`;
          } else if (id === activeId) {
            el.innerHTML = `<i data-lucide="loader"></i> ${runningLabel || "调试中..."}`;
          }
        }
        lucide.createIcons();
      }

      function resetCheckoutDebugButton() {
        if (checkoutDebugUnlockTimer) {
          clearTimeout(checkoutDebugUnlockTimer);
          checkoutDebugUnlockTimer = null;
        }
        setCheckoutDebugBusy(false);
      }

      function finishCheckoutDebugUi(status, data) {
        stopCheckoutDebugLogStream();
        resetCheckoutDebugButton();
        if (data) {
          renderCheckoutDebugStatus({
            ...data,
            status: status || data.status || "failed",
          });
        }
      }

      function scheduleCheckoutDebugUnlockFromLogs() {
        if (checkoutDebugUnlockTimer) return;
        checkoutDebugUnlockTimer = setTimeout(() => {
          checkoutDebugUnlockTimer = null;
          finishCheckoutDebugUi("failed", {
            status: "failed",
            message: "调试失败，可重新发起",
            screenshots: [],
          });
        }, 6000);
      }

      function clearCheckoutDebugForm() {
        stopCheckoutDebugLogStream();
        const input = document.getElementById("checkout_session_input");
        if (input) input.value = "";
        updateCheckoutSessionAccountHint();
        const checkoutUrlInput = document.getElementById("checkout_url_input");
        if (checkoutUrlInput) checkoutUrlInput.value = "";
        const box = document.getElementById("checkout_result_box");
        if (box) box.style.display = "none";
        const pre = document.getElementById("checkout_debug_log_pre");
        if (pre) pre.textContent = "";
        checkoutDebugLogText = "";
        checkoutDebugLogAfter = 0;
        checkoutDebugJobKey = "";
        resetCheckoutDebugButton();
      }

      function appendCheckoutDebugLogEntries(entries) {
        if (!entries || !entries.length || !checkoutDebugJobKey) {
          return;
        }
        const filtered = entries.filter(
          (entry) => entry.jobKey === checkoutDebugJobKey,
        );
        if (!filtered.length) {
          return;
        }
        const chunk = filtered.map(formatRuntimeLogLine).join("\n") + "\n";
        checkoutDebugLogText += chunk;
        if (checkoutDebugLogText.length > 120000) {
          checkoutDebugLogText = checkoutDebugLogText.slice(-100000);
        }
        const pre = document.getElementById("checkout_debug_log_pre");
        if (!pre) return;
        pre.textContent = checkoutDebugLogText;
        const wrap = pre.parentElement;
        if (wrap) wrap.scrollTop = wrap.scrollHeight;
        updateCheckoutPlanChoiceUi();
        if (checkoutDebugLogsIndicateFailure(checkoutDebugLogText)) {
          scheduleCheckoutDebugUnlockFromLogs();
        }
      }

      function stopCheckoutDebugLogStream() {
        if (checkoutDebugLogPollTimer) {
          clearInterval(checkoutDebugLogPollTimer);
          checkoutDebugLogPollTimer = null;
        }
        if (checkoutDebugStatusPollTimer) {
          clearInterval(checkoutDebugStatusPollTimer);
          checkoutDebugStatusPollTimer = null;
        }
      }

      async function fetchCheckoutDebugLogsTail() {
        const res = await authFetch(
          "/api/admin/runtime-logs?tail=1&limit=2000",
        );
        const data = await res.json();
        if (!data.success) {
          throw new Error(data.message || "加载日志失败");
        }
        checkoutDebugLogAfter = Number(data.nextAfter || 0);
        if (!checkoutDebugJobKey) {
          return;
        }
        const filtered = (data.entries || []).filter(
          (entry) => entry.jobKey === checkoutDebugJobKey,
        );
        checkoutDebugLogText = filtered.map(formatRuntimeLogLine).join("\n");
        if (checkoutDebugLogText) checkoutDebugLogText += "\n";
        const pre = document.getElementById("checkout_debug_log_pre");
        if (pre) {
          pre.textContent = checkoutDebugLogText;
          const wrap = pre.parentElement;
          if (wrap) wrap.scrollTop = wrap.scrollHeight;
        }
        updateCheckoutPlanChoiceUi();
        if (checkoutDebugLogsIndicateFailure(checkoutDebugLogText)) {
          scheduleCheckoutDebugUnlockFromLogs();
        }
      }

      async function fetchCheckoutDebugLogsIncremental() {
        if (!checkoutDebugJobKey) return;
        try {
          const res = await authFetch(
            `/api/admin/runtime-logs?after=${checkoutDebugLogAfter}&limit=500`,
          );
          const data = await res.json();
          if (!data.success) return;
          if (data.entries && data.entries.length) {
            appendCheckoutDebugLogEntries(data.entries);
          }
          checkoutDebugLogAfter = Number(
            data.nextAfter || checkoutDebugLogAfter,
          );
        } catch (_) {
          /* ignore */
        }
      }

      function startCheckoutDebugLogStream() {
        stopCheckoutDebugLogStream();
        if (checkoutDebugJobKey) {
          fetchCheckoutDebugLogsTail().catch(() => {});
        }
        checkoutDebugLogPollTimer = setInterval(() => {
          fetchCheckoutDebugLogsIncremental();
        }, 1500);
        checkoutDebugStatusPollTimer = setInterval(() => {
          pollCheckoutDebugStatus(false);
        }, 2000);
      }

      async function copyCheckoutDebugLogs() {
        const text = String(checkoutDebugLogText || "").trim();
        if (!text) {
          showMessage("当前没有可复制的运行日志", "warning");
          return;
        }
        try {
          await copyText(text);
          showMessage("运行日志已复制", "success");
        } catch (error) {
          showMessage(error.message || "复制日志失败", "error");
        }
      }

      function isCheckoutWaitingPlanChoice(data) {
        if (data && data.waiting_plan_choice === true) return true;
        return /请用当前账号在浏览器打开付款链接|仍在等待你在付款页完成选择|等待选择套餐档位|仍在等待后台选择套餐档位/.test(
          String(checkoutDebugLogText || ""),
        );
      }

      function updateCheckoutPlanChoiceUi(data) {
        const choiceWrap = document.getElementById("checkout_plan_choice_wrap");
        const statusEl = document.getElementById("checkout_result_status");
        const urlEl = document.getElementById("checkout_plan_choice_url");
        if (!choiceWrap) return;
        const waitingChoice =
          Boolean(checkoutDebugJobKey) &&
          checkoutDebugMode === "custom" &&
          isCheckoutWaitingPlanChoice(data);
        choiceWrap.style.display = waitingChoice ? "block" : "none";
        if (waitingChoice && statusEl) {
          statusEl.textContent = "⏳ 请在浏览器打开付款链接并完成选择";
          statusEl.style.color = "var(--primary)";
        }
        if (urlEl) {
          const checkoutUrl = String(
            data?.checkout_url ||
              document.getElementById("checkout_url_input")?.value ||
              "",
          ).trim();
          urlEl.innerHTML = checkoutUrl
            ? `<a href="${escapeHtml(checkoutUrl)}" target="_blank" rel="noopener">${escapeHtml(checkoutUrl)}</a>`
            : "";
        }
      }

      function renderCheckoutDebugStatus(data) {
        const box = document.getElementById("checkout_result_box");
        const statusEl = document.getElementById("checkout_result_status");
        const emailEl = document.getElementById("checkout_result_email");
        const urlWrap = document.getElementById("checkout_result_url_wrap");
        const shotWrap = document.getElementById("checkout_screenshot_wrap");
        const hint = document.getElementById("checkout_job_hint");
        if (box) box.style.display = "block";

        const status = data.status || "running";
        const checkoutUrl = data.checkout_url || "";
        if (hint && checkoutDebugJobKey) {
          hint.textContent = `Job: ${checkoutDebugJobKey}`;
        }
        if (statusEl) {
          if (status === "success") {
            statusEl.textContent =
              checkoutDebugMode === "custom"
                ? "✅ 自定义付款成功"
                : checkoutDebugMode === "payment"
                ? "✅ 支付调试成功"
                : "✅ 支付链接已生成";
            statusEl.style.color = "var(--success, #22c55e)";
          } else if (status === "running") {
            statusEl.textContent =
              checkoutDebugMode === "custom"
                ? "⏳ 正在登录并付款..."
                : checkoutDebugMode === "payment"
                ? "⏳ 正在发起支付调试..."
                : "⏳ 链接调试进行中...";
            statusEl.style.color = "var(--text-dim)";
          } else {
            statusEl.textContent = `❌ ${data.message || "调试失败"}`;
            statusEl.style.color = "var(--error, #ef4444)";
          }
        }
        if (emailEl) {
          const email =
            data.email ||
            parseCheckoutSessionEmail(
              document.getElementById("checkout_session_input")?.value,
            );
          emailEl.textContent = email || "";
        }
        updateCheckoutPlanChoiceUi(data);
        if (urlWrap) {
          urlWrap.innerHTML =
            checkoutDebugMode !== "payment" && checkoutUrl
              ? `<a href="${escapeHtml(checkoutUrl)}" target="_blank" rel="noopener" style="color: var(--primary);">${escapeHtml(checkoutUrl)}</a>`
              : status === "running"
                ? '<span style="color:var(--text-dim); font-size:13px;">正在等待支付流程结果...</span>'
                : "";
        }
        if (shotWrap) {
          const historyTask = checkoutDebugHistory.find(
            (item) =>
              item.jobKey === checkoutDebugJobKey ||
              item.id === checkoutDebugJobKey,
          );
          const shots = [
            ...new Set(
              [
                ...(Array.isArray(data.screenshots) ? data.screenshots : []),
                ...(Array.isArray(historyTask?.screenshots)
                  ? historyTask.screenshots
                  : []),
              ].filter(Boolean),
            ),
          ];
          const videos = [
            ...new Set(
              [
                ...(Array.isArray(data.videos) ? data.videos : []),
                ...(Array.isArray(historyTask?.videos)
                  ? historyTask.videos
                  : []),
              ].filter(Boolean),
            ),
          ];
          checkoutDebugMedia = { screenshots: shots, videos };
          const failed =
            !CHECKOUT_DEBUG_BUSY_STATUSES.has(String(status).toLowerCase()) &&
            String(status).toLowerCase() !== "success";
          if (failed && (shots.length || videos.length)) {
            shotWrap.innerHTML = `${
              shots.length
                ? `<button type="button" class="btn btn-secondary" onclick="showCheckoutDebugScreenshots()"><i data-lucide="image"></i> 查看截图 (${shots.length})</button>`
                : ""
            }${
              videos.length
                ? `<button type="button" class="btn btn-secondary" onclick="showCheckoutDebugVideos()"><i data-lucide="clapperboard"></i> 查看录像 (${videos.length})</button>`
                : ""
            }`;
            lucide.createIcons();
          } else {
            shotWrap.innerHTML = "";
          }
        }
      }

      async function pollCheckoutDebugStatus(forceToast) {
        if (!checkoutDebugJobKey) return;
        try {
          const res = await authFetch(
            `/api/admin/checkout/status/${encodeURIComponent(checkoutDebugJobKey)}`,
          );
          const data = await res.json();
          if (!data.success) return;
          renderCheckoutDebugStatus(data);
          const status = String(data.status || "").toLowerCase();
          const finished =
            CHECKOUT_DEBUG_TERMINAL_STATUSES.has(status) ||
            (Boolean(status) && !CHECKOUT_DEBUG_BUSY_STATUSES.has(status)) ||
            checkoutDebugLogsIndicateFinished(checkoutDebugLogText);
          if (finished) {
            const resolvedStatus = CHECKOUT_DEBUG_BUSY_STATUSES.has(status)
              ? checkoutDebugLogsIndicateFailure(checkoutDebugLogText)
                ? "failed"
                : status
              : status;
            stopCheckoutDebugLogStream();
            fetchCheckoutDebugLogsTail().catch(() => {});
            resetCheckoutDebugButton();
            loadCheckoutDebugHistory().catch(() => {});
            if (resolvedStatus === "failed" && status !== "failed") {
              renderCheckoutDebugStatus({
                ...data,
                status: "failed",
                message: data.message || "调试失败",
              });
            }
            if (forceToast) {
              showMessage(
                resolvedStatus === "success"
                  ? checkoutDebugMode === "custom"
                    ? "自定义付款成功"
                    : checkoutDebugMode === "payment"
                    ? "支付调试成功"
                    : "支付链接生成成功"
                  : data.message || "调试失败",
                resolvedStatus === "success" ? "success" : "error",
              );
            }
          }
        } catch (_) {
          /* ignore */
        }
      }

      async function submitCheckoutPlanChoice(variant) {
        if (!checkoutDebugJobKey) {
          showMessage("当前没有自定义付款任务", "warning");
          return;
        }
        try {
          const res = await authFetch(
            `/api/admin/checkout/${encodeURIComponent(checkoutDebugJobKey)}/choice`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ variant }),
            },
          );
          const data = await res.json();
          if (!res.ok || !data.success) {
            throw new Error(data.error || data.message || "提交档位失败");
          }
          const wrap = document.getElementById("checkout_plan_choice_wrap");
          if (wrap) wrap.style.display = "none";
          showMessage(data.message || "已提交套餐档位", "success");
        } catch (error) {
          showMessage(error.message || "提交档位失败", "error");
        }
      }

      async function startCheckoutDebug() {
        return startCheckoutTask("link");
      }

      let checkoutDebugHistory = [];
      let checkoutDebugAddresses = [];
      let checkoutDebugMedia = { screenshots: [], videos: [] };

      async function showCheckoutDebugScreenshots() {
        const shots = checkoutDebugMedia.screenshots || [];
        if (!shots.length) {
          showMessage("该任务暂无失败截图", "warning");
          return;
        }
        await showTaskScreenshots(shots, "失败截图");
      }

      async function showCheckoutDebugVideos() {
        const videos = checkoutDebugMedia.videos || [];
        if (!videos.length) {
          showMessage("该任务暂无录像", "warning");
          return;
        }
        await showTaskVideoByJobKey(checkoutDebugJobKey);
      }

      function checkoutDebugTypeFromTask(task) {
        const type = getTaskType(task);
        if (type === "自定义付款") return "custom";
        if (type === "支付调试") return "payment";
        return "link";
      }

      function onCheckoutCardSourceChange() {
        const source = document.getElementById("checkout_card_source")?.value;
        const wrap = document.getElementById("checkout_manual_card_wrap");
        if (wrap) wrap.hidden = source !== "manual";
      }

      function getCheckoutDebugCardChoice() {
        const source =
          document.getElementById("checkout_card_source")?.value || "pool";
        const extra = document.getElementById("checkout_manual_card")?.value || "";
        return { source, extra };
      }

      function decodeJwtPayloadSafe(token) {
        const parts = String(token || "").split(".");
        if (parts.length < 2) {
          return null;
        }
        try {
          const padded = parts[1].replace(/-/g, "+").replace(/_/g, "/");
          const json = decodeURIComponent(
            atob(padded)
              .split("")
              .map((ch) => `%${`00${ch.charCodeAt(0).toString(16)}`.slice(-2)}`)
              .join(""),
          );
          return JSON.parse(json);
        } catch (_) {
          return null;
        }
      }

      function parseCheckoutSessionEmail(raw) {
        const text = String(raw || "").trim();
        if (!text) {
          return "";
        }
        const fromJwt = (token) => {
          const payload = decodeJwtPayloadSafe(token);
          if (!payload || typeof payload !== "object") {
            return "";
          }
          const profile = payload["https://api.openai.com/profile"] || {};
          return String(
            profile.email || payload.email || payload.preferred_username || "",
          ).trim();
        };
        if (text.startsWith("{")) {
          try {
            const obj = JSON.parse(text);
            const email = String(
              obj?.user?.email ||
                obj?.account?.email ||
                obj?.email ||
                obj?.session?.user?.email ||
                "",
            ).trim();
            if (email) {
              return email;
            }
            return fromJwt(obj?.accessToken || obj?.access_token || "");
          } catch (_) {
            return "";
          }
        }
        return fromJwt(text);
      }

      function updateCheckoutSessionAccountHint() {
        const hint = document.getElementById("checkout_session_account");
        if (!hint) {
          return "";
        }
        const email = parseCheckoutSessionEmail(
          document.getElementById("checkout_session_input")?.value,
        );
        hint.textContent = email || "";
        return email;
      }

      function clearCheckoutSessionText() {
        const input = document.getElementById("checkout_session_input");
        if (input) input.value = "";
        updateCheckoutSessionAccountHint();
      }

      function randomCheckoutHolderName() {
        const first = [
          "James",
          "Mary",
          "John",
          "Patricia",
          "Robert",
          "Jennifer",
          "Michael",
          "Linda",
        ];
        const last = [
          "Smith",
          "Johnson",
          "Williams",
          "Brown",
          "Jones",
          "Miller",
          "Davis",
          "Wilson",
        ];
        return `${first[Math.floor(Math.random() * first.length)]} ${last[Math.floor(Math.random() * last.length)]}`;
      }

      function fillCheckoutDebugAddress(addr) {
        const setVal = (id, value) => {
          const el = document.getElementById(id);
          if (el) el.value = value || "";
        };
        setVal(
          "checkout_addr_name",
          addr?.name || randomCheckoutHolderName(),
        );
        setVal("checkout_addr_line1", addr?.line1);
        setVal("checkout_addr_city", addr?.city);
        setVal("checkout_addr_state", addr?.state);
        setVal("checkout_addr_postal", addr?.postal_code);
        setVal("checkout_addr_country", addr?.country || "US");
      }

      function getCheckoutDebugAddress() {
        const line1 = document.getElementById("checkout_addr_line1")?.value?.trim();
        const city = document.getElementById("checkout_addr_city")?.value?.trim();
        const state = document.getElementById("checkout_addr_state")?.value?.trim();
        const postal = document
          .getElementById("checkout_addr_postal")
          ?.value?.trim();
        const country = String(
          document.getElementById("checkout_addr_country")?.value || "US",
        )
          .trim()
          .toUpperCase();
        const name = document
          .getElementById("checkout_addr_name")
          ?.value?.trim();
        if (!line1 || !city || !state || !postal) return null;
        return {
          name: name || "",
          line1,
          city,
          state,
          postal_code: postal,
          country: country || "US",
        };
      }

      function onCheckoutAddressSourceChange() {
        const sel = document.getElementById("checkout_address_source");
        const value = sel?.value || "auto";
        if (value === "none") {
          fillCheckoutDebugAddress({ country: "US" });
          return;
        }
        const addr =
          checkoutDebugAddresses.find((item) => String(item.id) === value) ||
          checkoutDebugAddresses.find((item) => !Number(item.is_bound)) ||
          checkoutDebugAddresses[0];
        fillCheckoutDebugAddress(addr || { country: "US" });
      }

      const CHECKOUT_DEBUG_FALLBACK_ADDRS = [
        {
          line1: "123 SW Main St",
          city: "Portland",
          state: "OR",
          postal_code: "97201",
          country: "US",
        },
        {
          line1: "200 Market St",
          city: "Wilmington",
          state: "DE",
          postal_code: "19801",
          country: "US",
        },
        {
          line1: "45 Main St",
          city: "Concord",
          state: "NH",
          postal_code: "03301",
          country: "US",
        },
        {
          line1: "12 Last Chance Gulch",
          city: "Helena",
          state: "MT",
          postal_code: "59601",
          country: "US",
        },
        {
          line1: "500 W 5th Ave",
          city: "Anchorage",
          state: "AK",
          postal_code: "99501",
          country: "US",
        },
      ];

      function pickNextCheckoutDebugAddress() {
        const currentLine1 =
          document.getElementById("checkout_addr_line1")?.value?.trim() || "";
        const currentPostal =
          document.getElementById("checkout_addr_postal")?.value?.trim() || "";
        const pool = [
          ...checkoutDebugAddresses,
          ...CHECKOUT_DEBUG_FALLBACK_ADDRS,
        ].filter((item) => item?.line1);
        const different = pool.filter(
          (item) =>
            item.line1 !== currentLine1 ||
            String(item.postal_code || "") !== currentPostal,
        );
        const source = different.length ? different : pool;
        return source[Math.floor(Math.random() * source.length)] || {
          country: "US",
        };
      }

      function refreshCheckoutDebugAddress() {
        const addr = pickNextCheckoutDebugAddress();
        fillCheckoutDebugAddress({
          ...addr,
          name: randomCheckoutHolderName(),
        });
        const sel = document.getElementById("checkout_address_source");
        if (!sel || sel.value === "auto" || sel.value === "none") return;
        const nextId = addr?.id != null ? String(addr.id) : "";
        if (nextId && [...sel.options].some((opt) => opt.value === nextId)) {
          sel.value = nextId;
        }
      }

      async function loadCheckoutDebugCards() {
        const sel = document.getElementById("checkout_card_source");
        if (!sel) return;
        const current = sel.value || "pool";
        let options = '<option value="pool">跟随系统（卡池自动选卡）</option>';
        try {
          const res = await authFetch("/api/admin/cards/options");
          const data = await res.json();
          const cards = Array.isArray(data.cards) ? data.cards : [];
          options += cards
            .map((card) => {
              const last4 = String(card.last4 || "").slice(-4);
              const holder = card.payment_holder_name || card.card_holder || "";
              const label = `#${card.id} **** ${last4}${holder ? ` / ${holder}` : ""}`;
              return `<option value="id:${card.id}">${escapeHtml(label)}</option>`;
            })
            .join("");
        } catch (_) {
          /* keep pool */
        }
        options += '<option value="manual">手动输入新卡片</option>';
        sel.innerHTML = options;
        if ([...sel.options].some((opt) => opt.value === current)) {
          sel.value = current;
        }
        onCheckoutCardSourceChange();
      }

      async function loadCheckoutDebugAddresses() {
        const sel = document.getElementById("checkout_address_source");
        if (!sel) return;
        checkoutDebugAddresses = [];
        try {
          const res = await authFetch("/api/admin/addresses?region=US");
          const data = await res.json();
          checkoutDebugAddresses = Array.isArray(data.addresses)
            ? data.addresses
            : [];
        } catch (_) {
          checkoutDebugAddresses = [];
        }
        const unbound = checkoutDebugAddresses.filter(
          (item) => !Number(item.is_bound),
        );
        const generated = {
          line1: "123 SW Main St",
          city: "Portland",
          state: "OR",
          postal_code: "97201",
          country: "US",
        };
        const autoAddr = unbound[0] || checkoutDebugAddresses[0] || generated;
        let html = '<option value="auto">自动填充（免税地址池）</option>';
        html += '<option value="none">不指定，系统自动选</option>';
        html += checkoutDebugAddresses
          .map((item) => {
            const label = `${item.line1}, ${item.city}${Number(item.is_bound) ? "（已绑定）" : ""}`;
            return `<option value="${escapeHtml(String(item.id))}">${escapeHtml(label)}</option>`;
          })
          .join("");
        sel.innerHTML = html;
        sel.value = autoAddr ? "auto" : "none";
        fillCheckoutDebugAddress(autoAddr || { country: "US" });
      }

      function bindCheckoutDebugOverlayScroll(el) {
        if (!el || el.dataset.overlayScroll === "1") return;
        el.dataset.overlayScroll = "1";
        let timer = 0;
        el.addEventListener(
          "scroll",
          () => {
            el.classList.add("is-scrolling");
            clearTimeout(timer);
            timer = setTimeout(() => el.classList.remove("is-scrolling"), 800);
          },
          { passive: true },
        );
      }

      function bindCheckoutDebugHistoryOverlayScroll() {
        bindCheckoutDebugOverlayScroll(
          document.getElementById("checkout_debug_history_list"),
        );
        bindCheckoutDebugOverlayScroll(
          document.querySelector("#checkout_debug .checkout-debug-body"),
        );
      }

      function renderCheckoutDebugHistory() {
        const list = document.getElementById("checkout_debug_history_list");
        if (!list) return;
        bindCheckoutDebugHistoryOverlayScroll();
        if (!checkoutDebugHistory.length) {
          list.innerHTML =
            '<div class="checkout-debug-history-empty">暂无支付调试任务</div>';
          return;
        }
        list.innerHTML = checkoutDebugHistory
          .map((task) => {
            const type = getTaskType(task);
            const status = statusMap[task.status] || {
              class: "status-running",
              label: String(task.status || "").toUpperCase(),
            };
            const active =
              checkoutDebugJobKey && task.jobKey === checkoutDebugJobKey
                ? " active"
                : "";
            const key = escapeHtml(task.jobKey || "");
            return `<button type="button" class="checkout-debug-history-item${active}" data-job-key="${key}" onclick="selectCheckoutDebugHistory('${key}')">
              <div class="checkout-debug-history-top">
                <span class="checkout-debug-history-type">${escapeHtml(type)}</span>
                <span class="status-badge ${status.class}">${escapeHtml(status.label)}</span>
              </div>
              <div class="checkout-debug-history-meta">${escapeHtml(task.time || "")} · <span class="checkout-debug-history-job">${key}</span></div>
            </button>`;
          })
          .join("");
      }

      async function loadCheckoutDebugHistory(showToast = false) {
        try {
          const res = await authFetch("/api/admin/task-logs?limit=200");
          const data = await res.json();
          const tasks = Array.isArray(data.tasks) ? data.tasks : [];
          checkoutDebugHistory = tasks.filter((task) => {
            const cdk = String(task.cdk || "");
            return (
              cdk === "[checkout-debug]" ||
              cdk === "[payment-debug]" ||
              cdk === "[custom-pay]"
            );
          });
          renderCheckoutDebugHistory();
          if (showToast) showMessage("历史任务已刷新", "success");
        } catch (error) {
          if (showToast) {
            showMessage(error.message || "加载历史任务失败", "error");
          }
        }
        lucide.createIcons();
      }

      async function selectCheckoutDebugHistory(jobKey) {
        const key = String(jobKey || "").trim();
        if (!key) return;
        const task = checkoutDebugHistory.find((item) => item.jobKey === key);
        stopCheckoutDebugLogStream();
        checkoutDebugJobKey = key;
        checkoutDebugMode = checkoutDebugTypeFromTask(task);
        renderCheckoutDebugHistory();
        renderCheckoutDebugStatus({
          status: task?.status || "running",
          message: task?.message || "",
          email: task?.token || "",
          checkout_url: "",
          screenshots: task?.screenshots || [],
          videos: task?.videos || [],
        });
        try {
          const res = await authFetch(
            `/api/admin/task-logs/${encodeURIComponent(key)}`,
          );
          const data = await res.json();
          const output = String(data.task?.output || "");
          checkoutDebugLogText = output;
          checkoutDebugLogAfter = 0;
          const pre = document.getElementById("checkout_debug_log_pre");
          if (pre) {
            pre.textContent = output;
            const wrap = pre.parentElement;
            if (wrap) wrap.scrollTop = wrap.scrollHeight;
          }
          if (
            CHECKOUT_DEBUG_BUSY_STATUSES.has(
              String(task?.status || "").toLowerCase(),
            )
          ) {
            startCheckoutDebugLogStream();
          }
        } catch (error) {
          showMessage(error.message || "加载任务日志失败", "error");
        }
      }

      async function startCheckoutPayment() {
        const payload = getCheckoutDebugCardChoice();
        if (payload.source === "manual" && !String(payload.extra || "").trim()) {
          showMessage("请填写手动卡片：卡号|月/年|CVC", "warning");
          return;
        }
        const extraHtml = `<label>是否取消自动续费</label>
          <select data-confirm-value class="asset-input">
            <option value="yes" selected>是</option>
            <option value="no">否</option>
          </select>`;
        const confirmed = await showAdminConfirm(
          "支付成功后是否取消自动续费？",
          "支付调试",
          extraHtml,
        );
        if (!confirmed) {
          return;
        }
        const cancelAutoRenew =
          typeof confirmed === "object"
            ? String(confirmed.source || "yes").toLowerCase() !== "no"
            : true;
        await startCheckoutTask("payment", { ...payload, cancelAutoRenew });
      }

      async function startCustomCheckoutPayment() {
        const payload = getCheckoutDebugCardChoice();
        if (payload.source === "manual" && !String(payload.extra || "").trim()) {
          showMessage("请填写手动卡片：卡号|月/年|CVC", "warning");
          return;
        }
        await startCheckoutTask("custom", payload);
      }

      async function startCheckoutTask(mode, cardChoice) {
        const sessionRaw = document
          .getElementById("checkout_session_input")
          ?.value?.trim();
        const checkoutUrl = document
          .getElementById("checkout_url_input")
          ?.value?.trim();
        const planType =
          document.getElementById("checkout_plan_type")?.value || "plus";
        syncCheckoutPlanName();
        const planName = getCheckoutPlanNameForSubmit();
        const regionSel = document.getElementById("checkout_region_selector");
        const region =
          normalizePaymentRegion(regionSel?.value) || currentRegion;
        const isCustom = mode === "custom";
        const isPayment = mode === "payment" || isCustom;
        if (isPayment && !cardChoice) {
          cardChoice = getCheckoutDebugCardChoice();
        }

        if (!sessionRaw) {
          showMessage("请粘贴 Session JSON", "warning");
          return;
        }

        checkoutDebugMode = isCustom ? "custom" : isPayment ? "payment" : "link";
        setCheckoutDebugBusy(
          true,
          isCustom
            ? "登录付款中..."
            : isPayment
              ? "支付启动中..."
              : "链接启动中...",
        );

        checkoutDebugLogText = "";
        checkoutDebugLogAfter = 0;
        checkoutDebugJobKey = "";
        const pre = document.getElementById("checkout_debug_log_pre");
        if (pre) pre.textContent = "";

        if (
          isPayment &&
          cardChoice &&
          cardChoice.source === "manual" &&
          !String(cardChoice.extra || "").trim()
        ) {
          resetCheckoutDebugButton();
          showMessage("请填写手动卡片：卡号|月/年|CVC", "warning");
          return;
        }

        try {
          const res = await authFetch(
            isPayment
              ? "/api/admin/checkout/pay"
              : "/api/admin/checkout/generate",
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(
                (() => {
                  const requestBody = {
                    session: sessionRaw,
                    plan_type: planType,
                    plan_name: planName || undefined,
                    country: region,
                    credit_quantity: String(planType).startsWith("credits")
                      ? Number(
                          document.getElementById("checkout_credit_quantity")
                            ?.value || 500,
                        )
                      : undefined,
                  };
                  if (isCustom) {
                    requestBody.cdk_code = "[custom-pay]";
                    requestBody.checkout_mode = "ui";
                    if (checkoutUrl) requestBody.checkout_url = checkoutUrl;
                  }
                  if (isPayment && cardChoice && cardChoice.source) {
                    if (String(cardChoice.source).startsWith("id:")) {
                      requestBody.card_id = Number(
                        String(cardChoice.source).slice(3),
                      );
                    } else if (cardChoice.source === "manual") {
                      requestBody.card_manual = String(
                        cardChoice.extra || "",
                      ).trim();
                    }
                  }
                  if (
                    isPayment &&
                    !isCustom &&
                    typeof cardChoice?.cancelAutoRenew === "boolean"
                  ) {
                    requestBody.cancel_auto_renew = cardChoice.cancelAutoRenew;
                  }
                  const address = getCheckoutDebugAddress();
                  if (address) requestBody.address = address;
                  requestBody.proxy_group_id = getSelectedProxyGroupId(
                    "checkout_proxy_group",
                  );
                  return requestBody;
                })(),
              ),
            },
          );
          const data = await res.json();
          if (!res.ok || !data.success) {
            throw new Error(data.error || data.message || "启动失败");
          }

          checkoutDebugJobKey = data.jobKey;
          setCheckoutDebugBusy(
            true,
            isCustom
              ? "自定义付款中..."
              : isPayment
                ? "支付调试中..."
                : "链接调试中...",
          );
          renderCheckoutDebugStatus({
            status: "running",
            email: data.email,
            checkout_url: "",
            screenshots: [],
          });
          showMessage(
            `${isCustom ? "自定义付款" : isPayment ? "支付" : "链接"}任务已启动：${data.jobKey}`,
            "success",
          );
          startCheckoutDebugLogStream();
          loadCheckoutDebugHistory().catch(() => {});
        } catch (e) {
          resetCheckoutDebugButton();
          showMessage(e.message || "启动失败", "error");
        }
      }

      function onCheckoutRegionChange() {
        const sel = document.getElementById("checkout_region_selector");
        const region = normalizePaymentRegion(sel?.value);
        if (!region) return;
        currentRegion = region;
        const config = paymentRegionCatalog[region] || {};
        updateCheckoutRegionHint(config.label || region, config.currency || "");
      }

      async function loadCheckoutDebugPage() {
        await loadRegionConfig();
        await loadCheckoutPlans();
        await loadProxyGroupList();
        const sel = document.getElementById("checkout_region_selector");
        if (sel) sel.value = currentRegion;
        onCheckoutRegionChange();
        await Promise.all([
          loadCheckoutDebugCards(),
          loadCheckoutDebugAddresses(),
          loadCheckoutDebugHistory(),
        ]);
        updateCheckoutSessionAccountHint();
        bindCheckoutDebugHistoryOverlayScroll();
        lucide.createIcons();
      }

      function renderCheckoutPlanTypeOptions() {
        const sel = document.getElementById("checkout_plan_type");
        if (!sel) return;
        const labels = {
          plus: "Plus",
          pro_5x: "Pro 5x",
          pro_20x: "Pro 20x",
          credits: "Codex 点数",
        };
        const currentRaw = sel.value || "plus";
        const current = String(currentRaw).startsWith("credits")
          ? "credits"
          : currentRaw;
        const planKeys = ["plus", "pro_5x", "pro_20x", "credits"].filter(
          (key) => checkoutPlanMap[key],
        );
        const keys = planKeys.length
          ? planKeys
          : Object.keys(checkoutPlanMap).filter(
              (key) => !/^credits_\d+$/.test(key),
            );
        sel.innerHTML = keys
          .map((key) => {
            const name = checkoutPlanMap[key] || checkoutPlanMap.plus;
            return `<option value="${escapeHtml(key)}">${escapeHtml(labels[key] || key)} — ${escapeHtml(name)}</option>`;
          })
          .join("");
        sel.value = checkoutPlanMap[current] ? current : "plus";
        syncCheckoutPlanName();
      }

      function syncCheckoutPlanName() {
        const planType =
          document.getElementById("checkout_plan_type")?.value || "plus";
        const input = document.getElementById("checkout_plan_name");
        const wrap = document.getElementById("checkout_credit_quantity_wrap");
        if (wrap) wrap.hidden = !String(planType).startsWith("credits");
        const mapped =
          checkoutPlanMap[planType] ||
          checkoutPlanMap.credits ||
          checkoutPlanMap.plus ||
          "chatgptplusplan";
        if (input) {
          input.value = mapped;
          input.dataset.autoValue = mapped;
        }
      }

      function getCheckoutPlanNameForSubmit() {
        const planType =
          document.getElementById("checkout_plan_type")?.value || "plus";
        const input = document.getElementById("checkout_plan_name");
        const mapped =
          checkoutPlanMap[planType] ||
          checkoutPlanMap.plus ||
          "chatgptplusplan";
        const typed = String(input?.value || "").trim();
        // 仅当用户手动改过 plan_name 时才作为 override 提交
        if (typed && typed !== mapped && typed !== input?.dataset?.autoValue) {
          return typed;
        }
        return undefined;
      }

      function updateCheckoutRegionHint(label, currency) {
        const hint = document.getElementById("checkout_region_hint");
        if (hint) {
          hint.textContent = `将使用: ${label || currentRegion} / ${currency || ""}`;
        }
      }

      async function loadCheckoutPlans() {
        try {
          const res = await authFetch("/api/admin/checkout/plans");
          const data = await res.json();
          if (data.success && data.plans) {
            checkoutPlanMap = data.plans;
            renderCheckoutPlanTypeOptions();
            updateCheckoutRegionHint(data.label, data.currency);
          }
        } catch (e) {
          renderCheckoutPlanTypeOptions();
        }
      }

      async function loadRegionConfig() {
        try {
          const res = await authFetch("/api/admin/region");
          const data = await res.json();
          if (data.success) {
            currentRegion = data.region || "PH";
            paymentRegionCatalog = data.supported || {};
            renderPaymentRegionOptions();
            const sel = document.getElementById("region_selector");
            if (sel) sel.value = currentRegion;
            const checkoutSel = document.getElementById(
              "checkout_region_selector",
            );
            if (checkoutSel) checkoutSel.value = currentRegion;
            const badge = document.getElementById("region_current_badge");
            if (badge)
              badge.textContent = `当前: ${data.label || currentRegion} (${data.currency || "USD"})`;
            updateCheckoutRegionHint(data.label, data.currency);
          }
        } catch (e) {
          console.error("loadRegionConfig failed", e);
        }
      }

      async function savePaymentRegion(silent = false) {
        const sel = document.getElementById("region_selector");
        const raw = String(sel?.value || "").trim();
        if (!raw) {
          if (!silent) showMessage("请选择地区", "warning");
          return Boolean(silent);
        }
        const region = normalizePaymentRegion(raw);
        if (!region) {
          if (!silent) showMessage("请选择地区", "warning");
          return false;
        }
        try {
          const res = await authFetch("/api/admin/region", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ region }),
          });
          const data = await res.json();
          if (!res.ok || !data.success) {
            throw new Error(data.error || data.message || "保存失败");
          }
          currentRegion = data.region;
          const badge = document.getElementById("region_current_badge");
          if (badge)
            badge.textContent = `当前: ${data.label || currentRegion} (${data.currency || "USD"})`;
          updateCheckoutRegionHint(data.label, data.currency);
          if (!silent) showMessage("支付地区已更新", "success");
          return true;
        } catch (e) {
          showMessage(e.message || "保存地区失败", "error");
          return false;
        } finally {
          lucide.createIcons();
        }
      }

      function normalizePaymentRegion(value) {
        const raw = String(value || "").trim();
        if (!raw) return "";
        const code = raw.toUpperCase();
        if (paymentRegionCatalog[code]) return code;
        const matched = Object.entries(paymentRegionCatalog).find(
          ([, cfg]) =>
            String(cfg.label || "").toLowerCase() === raw.toLowerCase(),
        );
        return matched ? matched[0] : "";
      }

      function renderPaymentRegionOptions() {
        const list = document.getElementById("payment_region_options");
        if (!list) return;
        list.innerHTML = Object.entries(paymentRegionCatalog)
          .sort(([, left], [, right]) =>
            String(left.label || "").localeCompare(
              String(right.label || ""),
              "zh-CN",
            ),
          )
          .map(
            ([code, cfg]) =>
              `<option value="${escapeHtml(code)}" label="${escapeHtml(`${cfg.label || code} / ${cfg.currency || ""}`)}"></option>`,
          )
          .join("");
      }

      // ─── 第三方代充 API 配置 ─────────────────────────────────────────────
      async function loadGptApiConfig() {
        try {
          const res = await authFetch("/api/admin/gpt-api");
          const data = await res.json();
          if (!res.ok || !data.success) {
            throw new Error(data.message || "加载 API 配置失败");
          }
          const cfg = data.config || {};
          const enabledEl = document.getElementById("gpt_api_enabled");
          if (enabledEl) enabledEl.checked = Boolean(cfg.enabled);
          const baseUrlEl = document.getElementById("gpt_api_base_url");
          if (baseUrlEl) baseUrlEl.value = cfg.base_url || "";
          const keyEl = document.getElementById("gpt_api_key");
          const keyHint = document.getElementById("gpt_api_key_hint");
          if (keyEl) keyEl.value = "";
          if (keyEl)
            keyEl.placeholder = cfg.api_key_saved
              ? `已保存（${cfg.api_key_preview || "gptk_…"}）留空不修改`
              : "gptk_...";
          if (keyHint) {
            keyHint.textContent = cfg.api_key_saved
              ? "✓ API Key 已保存"
              : "尚未配置 API Key";
          }
          if (cfg.api_key_saved) refreshGptApiStatus();
        } catch (e) {
          console.error("loadGptApiConfig failed", e);
        }
      }

      function buildGptApiPayload() {
        return {
          enabled: Boolean(document.getElementById("gpt_api_enabled")?.checked),
          base_url:
            document.getElementById("gpt_api_base_url")?.value.trim() || "",
          api_key: document.getElementById("gpt_api_key")?.value.trim() || "",
        };
      }

      async function saveGptApiConfig() {
        try {
          const res = await authFetch("/api/admin/gpt-api", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(buildGptApiPayload()),
          });
          const data = await res.json();
          if (!res.ok || !data.success) {
            throw new Error(data.message || "保存失败");
          }
          showMessage(data.message, "success");
          await loadGptApiConfig();
        } catch (error) {
          showMessage(error.message || "第三方代充 API 配置保存失败", "error");
        }
      }

      function renderGptApiStatus(data) {
        const balance = data.balance || {};
        document.getElementById("gpt_api_credits").textContent =
          balance.credits ?? "—";
        document.getElementById("gpt_api_balance_usd").textContent =
          balance.balance_usd
            ? `$${balance.balance_usd}`
            : balance.balance != null
              ? `${balance.balance} cents`
              : "—";
        const gptPlans = (data.gpt_plans || []).filter(
          (p) => p.enabled !== 0 && p.enabled !== false,
        );
        document.getElementById("gpt_api_plans").textContent = gptPlans.length
          ? gptPlans
              .map((p) => `${p.name || p.key} (${p.key || "—"})`)
              .join("、")
          : "无可用套餐";
        const creditPlans = data.credit_plans || [];
        document.getElementById("gpt_api_credit_plans").textContent =
          creditPlans.length
            ? creditPlans
                .map((p) => `${p.name || p.id}: ${p.credits ?? "—"} 积分`)
                .join("、")
            : "无";
        const orders = data.recent_orders || [];
        document.getElementById("gpt_api_recent_orders").innerHTML =
          orders.length
            ? `<table style="width:100%; border-collapse:collapse"><thead><tr><th style="text-align:left">订单</th><th style="text-align:left">状态</th><th style="text-align:left">套餐卡密</th><th style="text-align:left">更新时间</th></tr></thead><tbody>${orders.map((o) => `<tr><td>${escapeHtml(String(o.order_id || o.task_id || "—"))}</td><td>${escapeHtml(o.status || "—")}</td><td>${escapeHtml(o.topup_code || "—")}</td><td>${escapeHtml(o.updated_at || "—")}</td></tr>`).join("")}</tbody></table>`
            : "暂无失败的第三方代充订单";
        document.getElementById("gpt_api_status_hint").textContent =
          data.balance_error
            ? `积分查询失败：${data.balance_error}`
            : "数据来自供应商 /plans 与 /balance；完整卡密不会由接口返回。";
      }

      async function readApiJson(response, fallbackMessage) {
        const contentType = response.headers.get("content-type") || "";
        const text = await response.text();
        if (!contentType.includes("application/json")) {
          const preview = text
            .replace(/<[^>]*>/g, " ")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 160);
          throw new Error(
            `${fallbackMessage}：服务器返回 HTML，请重新启动应用服务后再试${preview ? `（${preview}）` : ""}`,
          );
        }
        try {
          return JSON.parse(text);
        } catch (_) {
          throw new Error(`${fallbackMessage}：服务器返回了无法解析的 JSON`);
        }
      }

      async function refreshGptApiStatus() {
        try {
          const res = await authFetch("/api/admin/gpt-api/status");
          const data = await readApiJson(res, "状态查询失败");
          if (!res.ok || !data.success)
            throw new Error(data.message || "状态查询失败");
          renderGptApiStatus(data);
        } catch (error) {
          document.getElementById("gpt_api_status_hint").textContent =
            error.message || "状态查询失败";
        }
        lucide.createIcons();
      }

      async function testGptApiConnection() {
        const payload = buildGptApiPayload();
        const hasSavedKey = Boolean(
          document
            .getElementById("gpt_api_key_hint")
            ?.textContent.includes("已保存"),
        );
        if (!payload.api_key && !hasSavedKey) {
          showMessage("请先填写并保存 API Key", "warning");
          return;
        }
        try {
          const res = await authFetch("/api/admin/gpt-api/test", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
          const data = await readApiJson(res, "API 连接测试失败");
          if (!res.ok || !data.success)
            throw new Error(data.message || "连接失败");
          showMessage(data.message, "success");
          await refreshGptApiStatus();
        } catch (error) {
          showMessage(error.message || "API 连接测试失败", "error");
        }
      }

      const US_TAX_FREE_STATE_NAMES = [
        "Oregon",
        "Delaware",
        "Montana",
        "New Hampshire",
        "Alaska",
      ];
      const US_STATE_ABBR_MAP = {
        OR: "Oregon",
        DE: "Delaware",
        MT: "Montana",
        NH: "New Hampshire",
        AK: "Alaska",
      };

      function normalizeUsStateInput(state) {
        const raw = String(state || "").trim();
        if (!raw) return raw;
        const upper = raw.toUpperCase();
        if (US_STATE_ABBR_MAP[upper]) return US_STATE_ABBR_MAP[upper];
        return raw;
      }

      async function loadAddressList(region) {
        try {
          const res = await authFetch(
            `/api/admin/addresses?region=${encodeURIComponent(region)}`,
          );
          const data = await res.json();
          if (data.success) {
            regionAddressList = data.addresses || [];
          } else {
            regionAddressList = [];
          }
        } catch (e) {
          regionAddressList = [];
        }
        renderAddressTable();
      }

      function renderAddressTable() {
        const tbody = document.getElementById("address_list_body");
        const hint = document.getElementById("address_empty_hint");
        if (!tbody) return;
        if (regionAddressList.length === 0) {
          tbody.innerHTML = "";
          if (hint) hint.style.display = "block";
          lucide.createIcons();
          return;
        }
        if (hint) hint.style.display = "none";
        tbody.innerHTML = regionAddressList
          .map((addr) => {
            const isBound = Number(addr.is_bound) === 1;
            const statusBadge = isBound
              ? '<span class="status-badge status-success">已绑定</span>'
              : '<span class="status-badge" style="opacity:.85;">未绑定</span>';
            const editBtn = isBound
              ? '<button class="btn-delete" disabled style="opacity:0.4;cursor:not-allowed;" title="已绑定不可编辑"><i data-lucide="pencil"></i></button>'
              : `<button class="btn-delete" style="background: rgba(37, 99, 235, 0.1); color: var(--primary); border-color: #bfdbfe;" onclick="editAddress(${addr.id})" title="编辑"><i data-lucide="pencil"></i></button>`;
            const deleteBtn = isBound
              ? '<button class="btn-delete" disabled style="opacity:0.4;cursor:not-allowed;" title="已绑定不可删"><i data-lucide="trash-2"></i></button>'
              : `<button class="btn-delete" onclick="deleteAddress(${addr.id})" title="删除"><i data-lucide="trash-2"></i></button>`;
            return `
                      <tr>
                          <td>${escapeHtml(addr.line1)}</td>
                          <td>${escapeHtml(addr.city)}</td>
                          <td>${escapeHtml(addr.state)}</td>
                          <td>${escapeHtml(addr.postal_code)}</td>
                          <td>${escapeHtml(addr.country)}</td>
                          <td style="text-align:center">${statusBadge}</td>
                          <td style="text-align:center">
                              <div style="display: flex; justify-content: center; gap: 8px;">
                                  ${editBtn}
                                  ${deleteBtn}
                              </div>
                          </td>
                      </tr>`;
          })
          .join("");
        lucide.createIcons();
      }

      function showAddressForm(addr) {
        const box = document.getElementById("address_form_box");
        const title = document.getElementById("address_form_title");
        const submitLabel = document.getElementById(
          "address_form_submit_label",
        );
        const editId = document.getElementById("address_edit_id");
        if (box) box.classList.add("active");
        clearAddressFormErrors();
        if (addr) {
          if (title) title.textContent = "编辑地址模板";
          if (submitLabel) submitLabel.textContent = "更新";
          if (editId) editId.value = String(addr.id);
          document.getElementById("addr_line1").value = addr.line1 || "";
          document.getElementById("addr_city").value = addr.city || "";
          document.getElementById("addr_state").value = normalizeUsStateInput(
            addr.state || "",
          );
          document.getElementById("addr_postal_code").value =
            addr.postal_code || "";
          document.getElementById("addr_country").value = addr.country || "";
        } else {
          if (title) title.textContent = "新增地址模板";
          if (submitLabel) submitLabel.textContent = "保存";
          if (editId) editId.value = "";
          document.getElementById("addr_line1").value = "";
          document.getElementById("addr_city").value = "";
          document.getElementById("addr_state").value = "";
          document.getElementById("addr_postal_code").value = "";
          document.getElementById("addr_country").value = "US";
        }
        lucide.createIcons();
      }

      function hideAddressForm() {
        const box = document.getElementById("address_form_box");
        if (box) box.classList.remove("active");
        clearAddressFormErrors();
      }

      function clearAddressFormErrors() {
        ["line1", "city", "state", "postal_code", "country"].forEach((f) => {
          const el = document.getElementById(`addr_${f}_err`);
          if (el) {
            el.style.display = "none";
            el.textContent = "";
          }
        });
      }

      function validateAddressForm() {
        clearAddressFormErrors();
        const fields = {
          line1: { max: 200, label: "街道地址" },
          city: { max: 100, label: "城市" },
          state: { max: 100, label: "州/省" },
          postal_code: { max: 20, label: "邮编" },
          country: { max: 2, label: "国家代码" },
        };
        let valid = true;
        const values = {};
        for (const [key, cfg] of Object.entries(fields)) {
          const input = document.getElementById(`addr_${key}`);
          const val = (input ? input.value : "").trim();
          values[key] = val;
          const errEl = document.getElementById(`addr_${key}_err`);
          if (!val) {
            if (errEl) {
              errEl.textContent = `${cfg.label}不能为空`;
              errEl.style.display = "block";
            }
            valid = false;
          } else if (val.length > cfg.max) {
            if (errEl) {
              errEl.textContent = `${cfg.label}最长 ${cfg.max} 字符`;
              errEl.style.display = "block";
            }
            valid = false;
          }
        }
        // country must be exactly 2 uppercase letters
        if (
          values.country &&
          !/^[A-Z]{2}$/.test(values.country.toUpperCase())
        ) {
          const errEl = document.getElementById("addr_country_err");
          if (errEl) {
            errEl.textContent = "国家代码必须为 2 位大写字母";
            errEl.style.display = "block";
          }
          valid = false;
        } else if (values.country) {
          values.country = values.country.toUpperCase();
        }
        values.state = normalizeUsStateInput(values.state);
        if (
          values.state &&
          !US_TAX_FREE_STATE_NAMES.some(
            (s) => s.toLowerCase() === values.state.toLowerCase(),
          )
        ) {
          const errEl = document.getElementById("addr_state_err");
          if (errEl) {
            errEl.textContent =
              "请填写免税州完整英文名：Oregon / Delaware / Montana / New Hampshire / Alaska";
            errEl.style.display = "block";
          }
          valid = false;
        }
        return valid ? values : null;
      }

      async function submitAddressForm() {
        const values = validateAddressForm();
        if (!values) return;

        const editId = document.getElementById("address_edit_id")?.value;
        const isEdit = Boolean(editId);
        const payload = { ...values, region: "US" };

        try {
          let res;
          if (isEdit) {
            res = await authFetch(`/api/admin/addresses/${editId}`, {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(payload),
            });
          } else {
            res = await authFetch("/api/admin/addresses", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(payload),
            });
          }
          const data = await res.json();
          if (!res.ok || !data.success) {
            throw new Error(
              data.error ||
                data.message ||
                (data.details ? data.details.join(", ") : "保存失败"),
            );
          }
          showMessage(isEdit ? "地址模板已更新" : "地址模板已添加", "success");
          hideAddressForm();
          await loadAddressList("US");
        } catch (e) {
          showMessage(e.message || "保存失败", "error");
        }
        lucide.createIcons();
      }

      function editAddress(id) {
        const addr = regionAddressList.find((a) => a.id === id);
        if (!addr) {
          showMessage("地址不存在", "error");
          return;
        }
        if (Number(addr.is_bound) === 1) {
          showMessage("已绑定地址不可编辑", "warning");
          return;
        }
        showAddressForm(addr);
      }

      async function deleteAddress(id) {
        const ok = await showAdminConfirm(
          "确定删除该地址模板？删除后不可恢复。",
          "删除地址模板",
        );
        if (!ok) return;
        try {
          const res = await authFetch(`/api/admin/addresses/${id}`, {
            method: "DELETE",
          });
          const data = await res.json();
          if (!res.ok || !data.success) {
            throw new Error(data.error || data.message || "删除失败");
          }
          showMessage("地址模板已删除", "success");
          await loadAddressList("US");
        } catch (e) {
          showMessage(e.message || "删除失败", "error");
        }
        lucide.createIcons();
      }

      async function generateRandomUsAddresses() {
        const ok = await showAdminConfirm(
          "将通过 OpenStreetMap 反查生成 10 条美国免税州真实街道地址（OR / DE / MT / NH / AK）并加入地址池。失败时回退本地模板。继续？",
          "批量生成美国免税地址",
        );
        if (!ok) return;
        try {
          const res = await authFetch(
            "/api/admin/addresses/generate-random-us",
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ count: 10 }),
            },
          );
          const data = await res.json();
          if (!res.ok || !data.success) {
            throw new Error(data.error || data.message || "生成失败");
          }
          const nominatim = Number(data.nominatim_count || 0);
          const fallback = Number(data.fallback_count || 0);
          const suffix =
            nominatim && fallback
              ? `（地图 ${nominatim}，模板 ${fallback}）`
              : nominatim
                ? "（OpenStreetMap 反查）"
                : "（模板回退）";
          showMessage(
            `已生成 ${data.count} 条美国免税地址${suffix}`,
            "success",
          );
          await loadAddressList("US");
        } catch (e) {
          showMessage(e.message || "生成失败", "error");
        }
        lucide.createIcons();
      }

      async function clearUnboundAddresses() {
        const unboundCount = regionAddressList.filter(
          (a) => Number(a.is_bound) !== 1,
        ).length;
        if (unboundCount === 0) {
          showMessage("没有可清空的未绑定地址", "warning");
          return;
        }
        const ok = await showAdminConfirm(
          `将清空 ${unboundCount} 条未绑定地址（从未支付成功使用过的），已绑定的会保留。继续？`,
          "清空未绑定地址",
        );
        if (!ok) return;
        try {
          const res = await authFetch(
            "/api/admin/addresses/unbound?region=US",
            { method: "DELETE" },
          );
          const data = await res.json();
          if (!res.ok || !data.success) {
            throw new Error(data.error || data.message || "清空失败");
          }
          showMessage(`已清空 ${data.count} 条未绑定地址`, "success");
          await loadAddressList("US");
        } catch (e) {
          showMessage(e.message || "清空失败", "error");
        }
        lucide.createIcons();
      }

      bootAdmin();
    