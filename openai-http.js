"use strict";

const { spawn } = require("child_process");
const path = require("path");

const PYTHON =
  String(process.env.HCAPTCHA_SOLVER_PYTHON || process.env.PYTHON || "python3").trim() ||
  "python3";
const SCRIPT = path.join(__dirname, "openai-http.py");

function requestWithChromeImpersonation(options = {}) {
  return new Promise((resolve, reject) => {
    const timeoutMs = Math.max(2000, Number(options.timeoutMs || 20000));
    const child = spawn(PYTHON, [SCRIPT], {
      cwd: __dirname,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error("Chrome 模拟请求超时"));
    }, timeoutMs + 3000);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      if (stdout.length > 2_000_000) child.kill("SIGKILL");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => finish(error));
    child.on("close", (code) => {
      try {
        const result = JSON.parse(stdout || "{}");
        if (code !== 0 || result.error) {
          finish(new Error(String(result.data || stderr || "Chrome 模拟请求失败")));
          return;
        }
        finish(null, result);
      } catch (error) {
        finish(new Error(`Chrome 模拟响应解析失败：${error.message}`));
      }
    });

    child.stdin.end(
      JSON.stringify({
        method: options.method || "GET",
        url: options.url,
        headers: options.headers || {},
        body: options.body ?? null,
        proxy: options.proxy || "",
        timeout_seconds: timeoutMs / 1000,
      }),
    );
  });
}

module.exports = { requestWithChromeImpersonation };
