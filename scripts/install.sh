#!/bin/bash
# ============================================================
# ChatGPT Plus 自动化开通工具 — 一键安装脚本
# 支持 macOS / Ubuntu / Debian / CentOS / RHEL
# ============================================================
set -e

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

info() { echo -e "${CYAN}[INFO]${NC} $1"; }
success() { echo -e "${GREEN}[OK]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

# 检测操作系统
detect_os() {
    if [[ "$OSTYPE" == "darwin"* ]]; then
        OS="macos"
    elif [[ -f /etc/os-release ]]; then
        . /etc/os-release
        case "$ID" in
            ubuntu|debian) OS="debian" ;;
            centos|rhel|fedora|rocky|alma) OS="rhel" ;;
            *) OS="linux" ;;
        esac
    else
        OS="linux"
    fi
    info "检测到操作系统: $OS"
}

# 检查 Node.js 版本
check_node() {
    if ! command -v node &> /dev/null; then
        warn "未安装 Node.js，正在安装..."
        install_node
    fi

    NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
    if [ "$NODE_VERSION" -lt 20 ]; then
        error "需要 Node.js >= 20，当前版本: $(node -v)。请升级后重试。"
    fi
    success "Node.js $(node -v) ✓"
}

install_node() {
    case "$OS" in
        macos)
            if command -v brew &> /dev/null; then
                brew install node@20
            else
                error "请先安装 Homebrew (https://brew.sh) 或手动安装 Node.js 20+"
            fi
            ;;
        debian)
            curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
            sudo apt-get install -y nodejs
            ;;
        rhel)
            curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -
            sudo yum install -y nodejs
            ;;
        *)
            error "请手动安装 Node.js 20+: https://nodejs.org/"
            ;;
    esac
}

# 安装 Playwright 系统依赖
install_playwright_deps() {
    info "安装 Playwright 浏览器依赖..."
    case "$OS" in
        macos)
            # macOS 不需要额外系统依赖
            success "macOS 无需额外系统依赖"
            ;;
        debian)
            sudo apt-get update
            sudo apt-get install -y --no-install-recommends \
                wget curl ca-certificates fonts-liberation fonts-noto-cjk \
                libatk-bridge2.0-0 libatk1.0-0 libcups2 libdbus-1-3 \
                libdrm2 libgbm1 libgtk-3-0 libnspr4 libnss3 \
                libx11-xcb1 libxcomposite1 libxdamage1 libxrandr2 \
                libxss1 libasound2 libpangocairo-1.0-0 libpango-1.0-0 \
                libxshmfence1 xdg-utils
            success "Debian/Ubuntu 系统依赖已安装"
            ;;
        rhel)
            sudo yum install -y \
                wget curl ca-certificates liberation-fonts google-noto-cjk-fonts \
                atk cups-libs dbus-libs libdrm mesa-libgbm gtk3 nspr nss \
                libXcomposite libXdamage libXrandr libXScrnSaver alsa-lib \
                pango xdg-utils libxshmfence
            success "RHEL/CentOS 系统依赖已安装"
            ;;
    esac
}

# 安装 npm 依赖
install_deps() {
    info "安装 npm 依赖..."
    npm install --production
    success "npm 依赖已安装"
}

# 安装 Playwright 浏览器
install_browser() {
    info "安装 Playwright Chromium 浏览器..."
    npx playwright install chromium
    success "Chromium 浏览器已安装"
}

# 安装 hCaptcha Python 求解器（可选，失败不阻断主流程）
install_hcaptcha_solver() {
    if ! command -v python3 &> /dev/null; then
        warn "未找到 python3，跳过 hCaptcha solver 安装（可在 Docker 部署中自动内置）"
        return
    fi

    info "安装 hCaptcha 视觉求解器 Python 依赖..."
    VENV_DIR="${HOME}/.venvs/ctfml"
    if [ ! -d "$VENV_DIR" ]; then
        python3 -m venv "$VENV_DIR"
    fi
    # shellcheck disable=SC1091
    source "$VENV_DIR/bin/activate"
    pip install -q -r requirements-hcaptcha.txt
    python -m playwright install chromium
    deactivate

    if grep -q '^HCAPTCHA_SOLVER_PYTHON=' .env 2>/dev/null; then
        if [[ "$OSTYPE" == "darwin"* ]]; then
            sed -i '' "s|^HCAPTCHA_SOLVER_PYTHON=.*|HCAPTCHA_SOLVER_PYTHON=${VENV_DIR}/bin/python|" .env
        else
            sed -i "s|^HCAPTCHA_SOLVER_PYTHON=.*|HCAPTCHA_SOLVER_PYTHON=${VENV_DIR}/bin/python|" .env
        fi
    else
        echo "HCAPTCHA_SOLVER_PYTHON=${VENV_DIR}/bin/python" >> .env
    fi
    success "hCaptcha solver 已安装 (${VENV_DIR})"
}

# 配置环境变量
setup_env() {
    if [ ! -f .env ]; then
        cp .env.example .env
        warn "已创建 .env 文件，请编辑填写 MySQL 密码和代理配置："
        warn "  nano .env"
    else
        success ".env 文件已存在"
    fi
}

# 主流程
main() {
    echo ""
    echo "============================================"
    echo "  ChatGPT Plus 自动化开通工具 — 安装脚本"
    echo "============================================"
    echo ""

    detect_os
    check_node
    install_playwright_deps
    install_deps
    install_browser
    install_hcaptcha_solver
    setup_env

    echo ""
    success "============================================"
    success "  安装完成！"
    success "============================================"
    echo ""
    echo "下一步操作："
    echo "  1. 编辑配置: nano .env"
    echo "  2. 确保 MySQL 已运行并填写正确的连接信息"
    echo "  3. 启动服务: npm start"
    echo "  4. 访问后台: http://localhost:3000/admin-login.html"
    echo "     默认密码: admin123"
    echo ""
}

main "$@"
