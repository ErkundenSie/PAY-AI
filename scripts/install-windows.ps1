# ============================================================
# ChatGPT Plus 自动化开通工具 — Windows 安装脚本 (PowerShell)
# 需要以管理员权限运行
# ============================================================

$ErrorActionPreference = "Stop"

function Write-Info($msg) { Write-Host "[INFO] $msg" -ForegroundColor Cyan }
function Write-OK($msg) { Write-Host "[OK] $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "[WARN] $msg" -ForegroundColor Yellow }
function Write-Err($msg) { Write-Host "[ERROR] $msg" -ForegroundColor Red; exit 1 }

Write-Host ""
Write-Host "============================================" -ForegroundColor White
Write-Host "  ChatGPT Plus 自动化开通工具 — Windows 安装" -ForegroundColor White
Write-Host "============================================" -ForegroundColor White
Write-Host ""

# 检查 Node.js
Write-Info "检查 Node.js..."
try {
    $nodeVersion = (node -v) -replace 'v', ''
    $major = [int]($nodeVersion.Split('.')[0])
    if ($major -lt 20) {
        Write-Err "需要 Node.js >= 20，当前: v$nodeVersion。请从 https://nodejs.org 下载安装。"
    }
    Write-OK "Node.js v$nodeVersion"
} catch {
    Write-Err "未安装 Node.js。请从 https://nodejs.org 下载安装 Node.js 20+。"
}

# 安装 npm 依赖
Write-Info "安装 npm 依赖..."
npm install --production
if ($LASTEXITCODE -ne 0) { Write-Err "npm install 失败" }
Write-OK "npm 依赖已安装"

# 安装 Playwright Chromium
Write-Info "安装 Playwright Chromium 浏览器..."
npx playwright install chromium
if ($LASTEXITCODE -ne 0) { Write-Err "Playwright 浏览器安装失败" }
Write-OK "Chromium 已安装"

# 配置环境变量
if (-Not (Test-Path ".env")) {
    Copy-Item ".env.example" ".env"
    Write-Warn "已创建 .env 文件，请编辑填写 MySQL 密码和代理配置"
} else {
    Write-OK ".env 文件已存在"
}

Write-Host ""
Write-OK "============================================"
Write-OK "  安装完成！"
Write-OK "============================================"
Write-Host ""
Write-Host "下一步操作：" -ForegroundColor White
Write-Host "  1. 编辑配置: notepad .env"
Write-Host "  2. 确保 MySQL 已运行并填写正确的连接信息"
Write-Host "  3. 启动: npm start"
Write-Host "     或在 WSL 中: docker compose up -d --build"
Write-Host "  4. 访问后台: http://localhost:17621/admin-login"
Write-Host "     请先在 .env 设置至少 12 位的 ADMIN_PASSWORD"
Write-Host ""
