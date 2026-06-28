# KC GPT 自动充值系统

> **KC ChatGPT PLUS 订阅自动开通平台**  
> 用户粘贴 Session + 兑换 CDK → 官方 Stripe Checkout → 信用卡卡池自动支付 → 订阅开通完成。  
> 配套 **KC GPT自动充值系统** 后台：卡池管理、CDK 管理、任务监控、账单审计、浏览器池、并发控制。

| 开发者 | QQ | 微信 |
|--------|-----|------|
| **KC** | 1619043 | widc0cc |

[License: MIT](LICENSE) · Node.js 20+ · MySQL 8 · Playwright · Docker

---

## 这是什么

`KC-GPT-PAY`（KC GPT 自动充值系统）是一套 **Node.js + Playwright + MySQL** 服务端方案，包含：

- **用户前台**（`/public/index.html`）：卡密兑换、Session 提交、订阅自动开通、状态查询
- **管理后台**（`/admin`）：卡池 / CDK / 任务 / 账单 / 系统配置 / 运行日志
- **自动化引擎**：Stripe Checkout 填表、信用卡轮换、hCaptcha 求解、反指纹浏览器、失败重试

典型用途：CDK 自助充值站后端、ChatGPT Plus / Pro 批量协议 token 生产、Stripe 卡池支付方案验证。

> ⚠️ **仅供学习与研究**。使用前请确保符合目标平台 ToS 与所在地法律法规。**开发者不对任何滥用导致的封号、扣款、法律纠纷负责。**

---

## 系统要求

| 组件 | 要求 |
|------|------|
| **Node.js** | ≥ 20.x |
| **MySQL** | ≥ 8.0 |
| **内存** | ≥ 2 GB（建议 4 GB+，浏览器池并发高时需 8 GB+） |
| **磁盘** | ≥ 5 GB（含 Chromium + Python hCaptcha 依赖） |
| **操作系统** | Linux / macOS / Windows |

Linux 无图形界面跑 headless 时，需安装 Playwright 系统依赖（见下方各平台说明）。

---

## 部署教程

### 方式一：Docker 一键部署（推荐）

适合 Linux 云服务器、macOS、Windows（Docker Desktop），**自带 MySQL 8**，无需单独装数据库。

#### 1. 安装 Docker

```bash
# Ubuntu / Debian（一键脚本）
curl -fsSL https://get.docker.com | sh
sudo systemctl enable docker && sudo systemctl start docker

# macOS / Windows — 安装 Docker Desktop
# https://www.docker.com/products/docker-desktop/
```

#### 2. 拉取代码并配置

```bash
git clone <your-repo-url> KC-GPT-PAY
cd KC-GPT-PAY
cp .env.example .env
```

编辑 `.env`，至少填写：

```env
DB_PASSWORD=your_strong_mysql_password   # MySQL root 密码
ADMIN_PASSWORD=your_admin_password         # 后台登录密码
PROXY=http://user:pass@proxy-host:port     # 住宅代理（强烈建议）
```

#### 3. 一键启动

```bash
docker compose up -d
```

首次构建镜像需数分钟（含 Playwright Chromium + hCaptcha Python 依赖）。启动成功后：

| 地址 | 说明 |
|------|------|
| `http://服务器IP:3000/` | 用户前台（卡密兑换） |
| `http://服务器IP:3000/admin-login` | 后台登录（默认路径可在后台修改） |

#### 4. Docker 常用命令

```bash
# 查看应用日志
docker compose logs -f app

# 重启应用
docker compose restart app

# 停止并移除容器（数据卷保留，MySQL 数据不丢）
docker compose down

# 更新代码后重新构建
docker compose up -d --build

# 进入容器调试
docker compose exec app bash
```

> **注意**：请勿使用 `docker compose down -v`，否则会删除 MySQL 数据卷。配置写入 MySQL 后，重启容器不会丢失。

---

### 方式二：多端裸机部署

适合不想用 Docker、或需要在本地调试的场景。

#### macOS / Linux 一键安装

```bash
git clone <your-repo-url> KC-GPT-PAY
cd KC-GPT-PAY
chmod +x scripts/install.sh
./scripts/install.sh
```

脚本会自动检测系统（macOS / Ubuntu / Debian / CentOS 等），安装 Node.js 20+、npm 依赖、Playwright Chromium 及 Linux 系统库。

#### Windows 一键安装

以**管理员权限**打开 PowerShell：

```powershell
git clone <your-repo-url> KC-GPT-PAY
cd KC-GPT-PAY
powershell -ExecutionPolicy Bypass -File scripts\install-windows.ps1
```

#### 手动安装（各平台通用）

**① 安装 Node.js 20+**

```bash
# macOS (Homebrew)
brew install node@20

# Ubuntu / Debian
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# CentOS / RHEL
curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -
sudo yum install -y nodejs

# Windows — 下载 LTS 安装包
# https://nodejs.org/
```

**② 安装 Playwright 系统依赖（仅 Linux 服务器）**

```bash
# Ubuntu / Debian 推荐
npx playwright install --with-deps chromium

# 或手动安装常见依赖
sudo apt-get install -y wget curl fonts-liberation fonts-noto-cjk \
    libatk-bridge2.0-0 libatk1.0-0 libcups2 libdbus-1-3 libdrm2 libgbm1 \
    libgtk-3-0 libnspr4 libnss3 libx11-xcb1 libxcomposite1 libxdamage1 \
    libxrandr2 libxss1 libasound2 libpangocairo-1.0-0 libxshmfence1
```

macOS / Windows 无需额外系统依赖。

**③ 安装项目依赖**

```bash
npm install --production
npx playwright install chromium
```

**④ 安装并初始化 MySQL 8**

```bash
# Ubuntu
sudo apt-get install -y mysql-server && sudo systemctl start mysql

# macOS
brew install mysql && brew services start mysql

# 创建数据库
mysql -u root -p -e "CREATE DATABASE IF NOT EXISTS plus_papay CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
```

**⑤ 配置环境变量**

```bash
cp .env.example .env
# 编辑 .env
```

裸机部署关键项：

```env
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=root
DB_PASSWORD=你的MySQL密码
DB_NAME=plus_papay
ADMIN_PASSWORD=你的后台密码
PROXY=http://user:pass@proxy-host:port
HEADFUL=0          # 调试时可设为 1 开启有头浏览器
```

**⑥ 启动服务**

```bash
npm start
# 或调试模式（有头浏览器）
npm run start:headful
```

启动成功示例：

```
🔓 [资产锁] 启动时已重置所有 in_use 标记
数据库表检查完成
http://localhost:3000
MySQL => root@127.0.0.1:3306/plus_papay
```

---

### 方式三：PM2 生产守护（裸机推荐）

```bash
npm install -g pm2
pm2 start server.js --name kc-gpt-pay
pm2 startup          # 配置开机自启
pm2 save
pm2 logs kc-gpt-pay  # 查看日志
pm2 restart kc-gpt-pay
```

---

### 方式四：Nginx 反向代理 + HTTPS

通过域名访问或启用 HTTPS 时，在 Nginx 中反代到 `127.0.0.1:3000`：

```nginx
server {
    listen 80;
    server_name your-domain.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 86400;
    }
}
```

免费 HTTPS（Let's Encrypt）：

```bash
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d your-domain.com
```

---

## 首次使用

1. 打开后台 → **系统配置**：填写代理、支付地区（默认菲律宾 PHP）、邮箱通道、hCaptcha 等
2. **卡池管理** → 批量导入信用卡（格式：`卡号|有效期|CVC|持卡人姓名`）
3. **免税地址** → 确认当前地区有足够地址模板（默认已预置）
4. **CDK 管理** → 生成 Plus / Pro 5x / Pro 20x 激活码
5. 用户访问前台 → 输入 CDK → 粘贴 Session JSON → 提交，约 3–5 分钟自动开通
6. 在 **任务管理** / **运行日志** 查看进度与结果

---

## 主要功能

| 模块 | 说明 |
|------|------|
| **CDK 兑换** | Plus / Pro 5x / Pro 20x 三档套餐，一卡一充 |
| **信用卡卡池** | 批量导入、智能选卡、冷却机制、Stripe 拒卡自动报废、失败换卡重试 |
| **支付地区** | PH / US / SG / MY 可切换，配套免税地址池 |
| **账单审计** | 自动记录每笔支付，支持筛选与 CSV 导出 |
| **浏览器池** | 多槽位并发，CDP 独立端口，降低启动开销 |
| **hCaptcha** | VLM / 打码平台 / Python solver 多通道 |
| **反指纹** | Stealth + 30+ 指纹点修正，支持真 Chrome / Edge |
| **Telegram 通知** | 任务成功 / 失败推送（后台配置） |
| **并发 & 维护模式** | 前台并发上限、维护开关，保存即生效 |

---

## 架构概览

```
┌─────────────────────────────────────────────────────────────┐
│                     server.js (Express)                      │
│   /api/redeem/*   /api/cdk/*   /api/admin/*   /api/public/* │
└─────────────────────────────────────────────────────────────┘
         │                                    │
         ▼                                    ▼
┌─────────────────────┐            ┌─────────────────────┐
│  product_activator  │            │  public/admin.html  │
│  任务调度 / 重试     │            │  KC GPT 管理后台     │
└─────────────────────┘            └─────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────┐
│  index.js / stripe-payment.js / session-auth.js / browser-pool │
│  Stripe Checkout 自动化 · Session 鉴权 · 卡池支付 · 重试      │
└─────────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────┐
│  MySQL — 卡池 / CDK / 任务 / 账单 / 配置 / Session 记录       │
└─────────────────────────────────────────────────────────────┘
```

---

## 目录结构

```
.
├── server.js              # Express 入口、REST API
├── product_activator.js   # 任务调度核心
├── index.js               # Stripe 支付主流程（子进程）
├── stripe-payment.js      # Checkout 表单自动化
├── session-auth.js        # Session 解析与鉴权
├── browser-pool.js        # 浏览器池管理
├── mysql-store.js         # MySQL 全部 CRUD
├── payment-retry.js       # 支付重试与换卡逻辑
├── region-config.js       # 支付地区配置
├── hcaptcha/              # Python hCaptcha solver
├── public/
│   ├── index.html         # 用户前台
│   ├── admin.html         # 管理后台
│   └── admin-login.html   # 后台登录
├── scripts/
│   ├── install.sh         # macOS / Linux 一键安装
│   └── install-windows.ps1
├── docker-compose.yml     # Docker 一键部署
├── Dockerfile
├── mysql-schema.sql
├── .env.example
└── API_DOC.md             # 完整 REST API 文档
```

---

## 接口文档

完整 REST API 见 [API_DOC.md](API_DOC.md)。常用接口：

| 用途 | Method + Path | 鉴权 |
|------|---------------|------|
| 用户兑换开通 | `POST /api/redeem-product` | 无 |
| 查询 CDK 状态 | `GET /api/cdk/query?cdk=...` | 无 |
| 后台登录 | `POST /api/admin/login` | 密码 |
| 卡池批量导入 | `POST /api/admin/cards/import` | Bearer |
| 外部卡池推送 | `POST /api/external/cards/push` | X-API-Key |
| 账单 CSV 导出 | `GET /api/admin/billing/export` | Bearer |
| 实时运行日志 | `GET /api/admin/runtime-logs` | Bearer |

---

## 常见问题

**Q: Docker 里浏览器崩溃？**  
A: `docker-compose.yml` 已配置 `shm_size: 2gb`。仍崩溃可改为 `4gb`，并确保宿主机内存 ≥ 4 GB。

**Q: Linux 上 Chromium 启动失败？**  
A: 执行 `npx playwright install-deps chromium`，确认 `HEADFUL=0`（无头模式）。

**Q: MySQL 连接被拒绝？**  
A: Docker 模式下 `DB_HOST=mysql`（compose 服务名）；裸机模式下 `DB_HOST=127.0.0.1`。确认 MySQL 服务已启动。

**Q: Stripe 一直 `redirect_status=failed`？**  
A: 多为卡 BIN 被风控、余额不足或代理 IP 不干净。换卡、换代理、确认支付地区设置。

**Q: 卡池枯竭怎么办？**  
A: 后台批量导入，或配置 Webhook `POST /api/external/cards/push` 自动补货。

**Q: 修改哪些文件需要重启？**  
A: `server.js`、`mysql-store.js`、`product_activator.js` 等主进程文件需重启；`index.js`、`stripe-payment.js` 等子进程文件下次任务自动加载。

**Q: Windows 上 Playwright 安装失败？**  
A: 管理员 PowerShell 执行：`Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`，再 `npx playwright install chromium`。

---

## 端口说明

| 端口 | 用途 |
|------|------|
| 3000 | Web 服务 + WebSocket（可通过 `PORT` 环境变量修改） |
| 3306 | MySQL（Docker 模式下映射到宿主机） |
| 19222+ | 浏览器池 CDP 端口（`BROWSER_POOL_BASE_PORT` 起） |

---

## 开发者 & 联系方式

| 项目 | 信息 |
|------|------|
| 开发者 | **KC** |
| QQ | **1619043** |
| 微信 | **widc0cc** |

部署或使用过程中遇到问题，可通过以上方式联系开发者。

---

## 免责声明

本项目所有代码以 **「AS IS」** 形式发布，开发者**不对以下情形负责**：

- 因使用本项目导致的 OpenAI 账号封禁、银行卡风控
- 违反目标平台 ToS 或所在地法律法规所引起的任何后果
- 因使用本项目导致的资金损失、数据泄露、第三方权益受损

**使用即表示你已阅读、理解并接受以上条款。**

---

## 许可

[MIT License](LICENSE) © KC
