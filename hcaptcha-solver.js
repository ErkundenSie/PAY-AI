/**
 * hCaptcha 视觉求解器桥接模块
 *
 * 调用 hcaptcha/solver.py，通过 CDP 附加到
 * 当前 Playwright 浏览器页面，自动完成 Stripe Checkout 上的 hCaptcha challenge。
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_SOLVER_SCRIPT = path.join(__dirname, 'hcaptcha', 'solver.py');
const DEFAULT_OUT_DIR = '/tmp/hcaptcha_auto_solver_live';

function resolveSolverPython() {
    const candidates = [
        process.env.HCAPTCHA_SOLVER_PYTHON,
        process.env.CTFML_PYTHON,
        path.join(os.homedir(), '.venvs', 'ctfml', 'bin', 'python'),
        path.join(os.homedir(), '.venvs', 'ctfml', 'bin', 'python3'),
        'python3',
        'python'
    ].filter(Boolean);

    for (const candidate of candidates) {
        if (candidate.includes(path.sep) || candidate.startsWith('~')) {
            const expanded = candidate.replace(/^~/, os.homedir());
            if (fs.existsSync(expanded)) {
                return expanded;
            }
            continue;
        }
        return candidate;
    }
    return 'python3';
}

function isHcaptchaSolverEnabled() {
    if (process.env.HCAPTCHA_SOLVER_ENABLED === '0') {
        return false;
    }
    const scriptPath = process.env.HCAPTCHA_SOLVER_SCRIPT || DEFAULT_SOLVER_SCRIPT;
    if (!fs.existsSync(scriptPath)) {
        return false;
    }
    return true;
}

function getCdpUrl() {
    return String(process.env.CDP_URL || '').trim();
}

function buildSolverEnv() {
    const env = { ...process.env };
    if (process.env.CTF_VLM_API_KEY) {
        env.CTF_VLM_API_KEY = process.env.CTF_VLM_API_KEY;
    }
    if (process.env.CTF_VLM_BASE_URL) {
        env.CTF_VLM_BASE_URL = process.env.CTF_VLM_BASE_URL;
    }
    if (process.env.CTF_VLM_MODEL) {
        env.CTF_VLM_MODEL = process.env.CTF_VLM_MODEL;
    }
    return env;
}

function extractJsonFromOutput(text) {
    const cleaned = String(text || '')
        .replace(/^\[hCaptcha\](?:\[stderr\])?\s*/gm, '')
        .trim();
    if (!cleaned) return null;

    try {
        const parsed = JSON.parse(cleaned);
        if (parsed && typeof parsed === 'object') {
            return parsed;
        }
    } catch (_) { /* try block extract */ }

    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) {
        try {
            return JSON.parse(cleaned.slice(start, end + 1));
        } catch (_) { /* ignore */ }
    }

    const lines = cleaned.split('\n').reverse();
    for (const line of lines) {
        const candidate = line.trim();
        if (!candidate.startsWith('{')) continue;
        try {
            return JSON.parse(candidate);
        } catch (_) { /* try previous line */ }
    }
    return null;
}

function isSolverSuccessResult(parsed) {
    if (!parsed || typeof parsed !== 'object') {
        return false;
    }
    if (parsed.type === 'passive_checkbox' || parsed.type === 'response') {
        return true;
    }
    return Boolean(parsed.response);
}

/**
 * 通过 CDP 在当前 checkout 页面上运行 Python hCaptcha solver
 * @param {object} options
 * @param {string} [options.cdpUrl]
 * @param {string} [options.pageUrlSubstr]
 * @param {number} [options.timeoutSec]
 * @param {string} [options.locale]
 * @param {string} [options.timezoneId]
 * @param {string} [options.acceptLanguage]
 * @returns {Promise<{ ok: boolean, result?: object, error?: string, logPath?: string }>}
 */
function solveHcaptchaOnPage(options = {}) {
    const cdpUrl = String(options.cdpUrl || getCdpUrl() || '').trim();
    if (!cdpUrl) {
        return Promise.resolve({
            ok: false,
            error: '未配置 CDP_URL，无法启动 hCaptcha solver（请在浏览器 launch 时开启 remote-debugging-port）'
        });
    }

    const pythonBin = resolveSolverPython();
    const scriptPath = process.env.HCAPTCHA_SOLVER_SCRIPT || DEFAULT_SOLVER_SCRIPT;
    if (!fs.existsSync(scriptPath)) {
        return Promise.resolve({
            ok: false,
            error: `hCaptcha solver 脚本不存在: ${scriptPath}`
        });
    }

    const timeoutSec = Number(options.timeoutSec || process.env.HCAPTCHA_SOLVER_TIMEOUT || 240);
    const outDir = process.env.HCAPTCHA_SOLVER_OUT_DIR || DEFAULT_OUT_DIR;
    fs.mkdirSync(outDir, { recursive: true });

    const logPath = path.join(outDir, `solver_node_${Date.now()}.log`);
    const pageUrlSubstr = String(
        options.pageUrlSubstr
        || options.pageUrl
        || 'checkout'
    ).trim();

    const args = [
        '-u',
        scriptPath,
        '--timeout',
        String(Math.max(60, timeoutSec)),
        '--out-dir',
        outDir,
        '--cdp-url',
        cdpUrl,
        '--attached-page-url-substr',
        pageUrlSubstr
    ];

    const locale = String(options.locale || process.env.HCAPTCHA_BROWSER_LOCALE || 'en-US').trim();
    const timezoneId = String(options.timezoneId || process.env.HCAPTCHA_BROWSER_TIMEZONE || 'America/Chicago').trim();
    const acceptLanguage = String(
        options.acceptLanguage
        || process.env.HCAPTCHA_ACCEPT_LANGUAGE
        || `${locale},${locale.split('-', 1)[0]};q=0.9`
    ).trim();

    args.push('--browser-locale', locale);
    args.push('--browser-timezone', timezoneId);
    args.push('--accept-language', acceptLanguage);

    if (process.env.CTF_VLM_BASE_URL) {
        args.push('--vlm-base-url', process.env.CTF_VLM_BASE_URL);
    }
    if (process.env.CTF_VLM_MODEL) {
        args.push('--vlm-model', process.env.CTF_VLM_MODEL);
    }
    if (process.env.CTF_VLM_TIMEOUT) {
        args.push('--vlm-timeout', String(process.env.CTF_VLM_TIMEOUT));
    }
    if (process.env.HCAPTCHA_SOLVER_NO_VLM === '1') {
        args.push('--no-vlm');
    }
    if (process.env.HEADFUL === '1' || process.env.HCAPTCHA_SOLVER_HEADED === '1') {
        args.push('--headed');
    }

    console.log(`[hCaptcha] 启动视觉求解器: ${pythonBin} ${args.join(' ')}`);
    console.log(`[hCaptcha] solver 日志: ${logPath}`);

    return new Promise((resolve) => {
        const logStream = fs.createWriteStream(logPath, { flags: 'a' });
        const proc = spawn(pythonBin, args, {
            env: buildSolverEnv(),
            cwd: path.dirname(scriptPath)
        });

        let stdout = '';
        proc.stdout.on('data', (chunk) => {
            const text = chunk.toString();
            stdout += text;
            logStream.write(text);
            for (const line of text.split('\n')) {
                const trimmed = line.trim();
                if (trimmed) {
                    console.log(`[hCaptcha] ${trimmed}`);
                }
            }
        });
        proc.stderr.on('data', (chunk) => {
            const text = chunk.toString();
            logStream.write(text);
            for (const line of text.split('\n')) {
                const trimmed = line.trim();
                if (trimmed) {
                    console.log(`[hCaptcha][stderr] ${trimmed}`);
                }
            }
        });

        proc.on('error', (err) => {
            logStream.end();
            resolve({
                ok: false,
                error: `启动 solver 失败: ${err.message}`,
                logPath
            });
        });

        proc.on('close', (code) => {
            logStream.end();
            const parsed = extractJsonFromOutput(stdout);
            if (code === 0 && isSolverSuccessResult(parsed)) {
                resolve({ ok: true, result: parsed, logPath });
                return;
            }
            resolve({
                ok: false,
                error: code === 0
                    ? 'solver 未返回有效 JSON 结果'
                    : `solver 退出码 ${code}`,
                result: parsed || undefined,
                logPath
            });
        });
    });
}

function checkHcaptchaSolverHealth(options = {}) {
    const scriptPath = process.env.HCAPTCHA_SOLVER_SCRIPT || DEFAULT_SOLVER_SCRIPT;
    const pythonBin = resolveSolverPython();
    const enabled = process.env.HCAPTCHA_SOLVER_ENABLED !== '0';
    const hasVlmKey = Boolean(String(process.env.CTF_VLM_API_KEY || options.vlm_api_key || '').trim());
    const noVlm = process.env.HCAPTCHA_SOLVER_NO_VLM === '1' || Boolean(options.no_vlm);

    const status = {
        enabled,
        script_exists: fs.existsSync(scriptPath),
        script_path: scriptPath,
        python: pythonBin,
        cdp_url: getCdpUrl(),
        vlm_configured: hasVlmKey,
        no_vlm: noVlm,
        ready: false,
        message: ''
    };

    if (!enabled) {
        status.message = '后台已关闭 hCaptcha 自动求解';
        return Promise.resolve(status);
    }
    if (!status.script_exists) {
        status.message = `solver 脚本不存在: ${scriptPath}`;
        return Promise.resolve(status);
    }

    return new Promise((resolve) => {
        const proc = spawn(
            pythonBin,
            ['-c', 'import cv2, numpy, torch, transformers, playwright; print("ok")'],
            { env: buildSolverEnv() }
        );
        let stdout = '';
        let stderr = '';
        const timer = setTimeout(() => {
            proc.kill('SIGKILL');
        }, 45000);

        proc.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
        proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

        proc.on('error', (err) => {
            clearTimeout(timer);
            status.message = `Python 不可用 (${pythonBin}): ${err.message}`;
            resolve(status);
        });

        proc.on('close', (code) => {
            clearTimeout(timer);
            if (code === 0 && stdout.includes('ok')) {
                status.ready = true;
                if (!noVlm && !hasVlmKey) {
                    status.message = '依赖就绪，但未配置 VLM API Key（将仅使用 CLIP/OpenCV 启发式）';
                } else {
                    status.message = 'hCaptcha solver 就绪';
                }
            } else {
                const hint = (stderr || stdout).split('\n').filter(Boolean).slice(-3).join(' | ');
                status.message = `Python 依赖检查失败: ${hint || `exit ${code}`}`;
            }
            resolve(status);
        });
    });
}

function normalizeVlmBaseUrl(baseUrl) {
    return String(baseUrl || 'https://api.openai.com/v1').trim().replace(/\/+$/, '');
}

/**
 * 真实调用 VLM API 测试连通性
 */
async function testVlmConnectivity(cfg = {}) {
    const apiKey = String(cfg.vlm_api_key || process.env.CTF_VLM_API_KEY || '').trim();
    const baseUrl = normalizeVlmBaseUrl(cfg.vlm_base_url || process.env.CTF_VLM_BASE_URL);
    const model = String(cfg.vlm_model || process.env.CTF_VLM_MODEL || 'gpt-4o').trim();
    const timeoutMs = Math.max(5000, Number(cfg.vlm_timeout || process.env.CTF_VLM_TIMEOUT || 45) * 1000);

    if (!apiKey) {
        return { ok: false, message: '未配置 VLM API Key' };
    }

    const endpoint = `${baseUrl}/chat/completions`;
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const response = await fetch(endpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${apiKey}`
            },
            body: JSON.stringify({
                model,
                temperature: 0,
                max_tokens: 32,
                messages: [
                    {
                        role: 'user',
                        content: 'Reply with exactly this JSON and nothing else: {"ok":true,"ping":"pong"}'
                    }
                ]
            }),
            signal: controller.signal
        });
        const latencyMs = Date.now() - started;
        const text = await response.text();
        let body = {};
        try {
            body = text ? JSON.parse(text) : {};
        } catch (_) {
            body = { raw: text.slice(0, 500) };
        }

        if (!response.ok) {
            const errMsg = body?.error?.message || body?.message || text.slice(0, 300) || `HTTP ${response.status}`;
            return {
                ok: false,
                message: `VLM 请求失败: ${errMsg}`,
                endpoint,
                model,
                latency_ms: latencyMs,
                http_status: response.status,
                response_preview: text.slice(0, 400)
            };
        }

        const content = body?.choices?.[0]?.message?.content || '';
        return {
            ok: true,
            message: `VLM 连通成功（${latencyMs}ms）`,
            endpoint,
            model,
            latency_ms: latencyMs,
            http_status: response.status,
            response_preview: String(content).slice(0, 200)
        };
    } catch (error) {
        const latencyMs = Date.now() - started;
        const msg = error.name === 'AbortError'
            ? `VLM 请求超时（>${timeoutMs}ms）`
            : `VLM 请求异常: ${error.message}`;
        return { ok: false, message: msg, endpoint, model, latency_ms: latencyMs };
    } finally {
        clearTimeout(timer);
    }
}

function listSolverLogFiles(limit = 20) {
    const outDir = process.env.HCAPTCHA_SOLVER_OUT_DIR || DEFAULT_OUT_DIR;
    try {
        if (!fs.existsSync(outDir)) {
            return { out_dir: outDir, files: [] };
        }
        const files = fs.readdirSync(outDir)
            .filter((name) => /solver.*\.log$/i.test(name) || /^round_\d+\.json$/i.test(name))
            .map((name) => {
                const full = path.join(outDir, name);
                const stat = fs.statSync(full);
                return {
                    name,
                    path: full,
                    size: stat.size,
                    mtime: stat.mtimeMs
                };
            })
            .sort((a, b) => b.mtime - a.mtime)
            .slice(0, Math.max(1, limit));
        return { out_dir: outDir, files };
    } catch (error) {
        return { out_dir: outDir, files: [], error: error.message };
    }
}

function readSolverLogTail(filePath, maxLines = 80) {
    try {
        const raw = fs.readFileSync(filePath, 'utf8');
        const lines = raw.split('\n').filter((l) => l.trim());
        return lines.slice(-maxLines);
    } catch (error) {
        return [`读取失败: ${error.message}`];
    }
}

module.exports = {
    solveHcaptchaOnPage,
    isHcaptchaSolverEnabled,
    checkHcaptchaSolverHealth,
    testVlmConnectivity,
    listSolverLogFiles,
    readSolverLogTail,
    getCdpUrl,
    resolveSolverPython,
    DEFAULT_SOLVER_SCRIPT
};
