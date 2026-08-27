# KC-PAY-GPT

Node.js + Playwright + MySQL 的 ChatGPT 开通服务。用户可走卡密兑换或独立自助开通页，后台管理卡池、CDK、任务和账单。支付默认协议优先，支持会员套餐和 Codex 充值点数。

| 开发者 | TG     |
| ------ | ------ |
| **KC** | KcCatk |

[License: MIT](LICENSE) · Node.js 20+ · MySQL 8 · Playwright · Docker · [GitHub](https://github.com/KC-CatK/KC-PAY-GPT)

> ## 加入 Telegram 社群
>
> **[點此加入 AI科研組 Telegram 群組](https://t.me/+xPBORDjtky9mM2Mx)**

---

## 这是什么

本地开通服务，包含：

- 卡密兑换：`/`
- 自助开通：`/checkout`（不走兑换码，可选手动卡和地址）
- Codex 充值点数：最低 250，步长 250
- 协议优先支付与后台卡池 / CDK / 任务 / 账单

第三方代充 API 只影响会员兑换；点数始终走本地协议。

> ⚠️ **仅供学习与研究**。使用前请确保符合目标平台 ToS 与所在地法律法规。**开发者不对任何滥用导致的封号、扣款、法律纠纷负责。**

---

## 系统要求

| 组件         | 要求                                         |
| ------------ | -------------------------------------------- |
| **Node.js**  | ≥ 20.x                                       |
| **MySQL**    | ≥ 8.0                                        |
| **記憶體**   | ≥ 2 GB（本地瀏覽器自動化建議 4 GB+）         |
| **磁盘**     | ≥ 5 GB（含 Chromium + Python hCaptcha 依赖） |
| **操作系统** | Linux / macOS / Windows                      |

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
git clone https://github.com/KC-CatK/KC-PAY-GPT.git KC-GPT-PAY
cd KC-GPT-PAY
cp .env.example .env
```

编辑 `.env`，至少填写：

```env
DB_PASSWORD=your_strong_mysql_password   # MySQL root 密码
ADMIN_PASSWORD=your_admin_password         # 后台登录密码
PROXY=http://user:pass@proxy-host:port     # 本地自動化或第三方訂單代理（選填）
BROWSER_POOL=0                              # 預設關閉瀏覽器池
```

#### 3. 一键启动

```bash
docker compose up -d
```

首次构建镜像需数分钟（含 Playwright Chromium + hCaptcha Python 依赖）。启动成功后：

| 地址                                | 说明                          |
| ----------------------------------- | ----------------------------- |
| `http://服务器IP:3000/`             | 卡密兑换                      |
| `http://服务器IP:3000/checkout`     | 自助开通（会员 / Codex 点数） |
| `http://服务器IP:3000/subscription` | 发票助手                      |
| `http://服务器IP:3000/admin-login`  | 后台登录                      |

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

## 第三方代充 API

在後台「系統配置 → 第三方代充 API」填寫 API Key 後啟用。預設 Base URL 為：

```text
https://kc.vpss.eu.cc/
```

啟用後，系統會：

1. 使用供應商 `/plans` 取得 GPT 與積分套餐資訊。
2. 以 `/balance` 顯示可用積分與 USD 餘額。
3. 以 `/pay/inspect` 檢查 Session 格式與 JWT 有效期，再以 `/pay` 建立代充訂單。
4. 輪詢供應商訂單結果；後台僅顯示失敗代充訂單及上游公開的 `topup_code` 前綴，不會保存或展示完整卡密。

API Key 至少需要 `plans:read`、`balance:read`、`pay:write` Scope；如需使用任務查詢，另需 `tasks:read`。完整供應商協議見 [對接 API 文件](对接api.md)。

> 瀏覽器池預設關閉（`BROWSER_POOL=0`）。第三方代充模式不使用本地瀏覽器開通流程。

---

### 方式二：多端裸机部署

适合不想用 Docker、或需要在本地调试的场景。

#### macOS / Linux 一键安装

```bash
git clone https://github.com/KC-CatK/KC-PAY-GPT.git KC-GPT-PAY
cd KC-GPT-PAY
chmod +x scripts/install.sh
./scripts/install.sh
```

脚本会自动检测系统（macOS / Ubuntu / Debian / CentOS 等），安装 Node.js 20+、npm 依赖、Playwright Chromium 及 Linux 系统库。

#### Windows 一键安装

以**管理员权限**打开 PowerShell 完成首次安装：

```powershell
git clone https://github.com/KC-CatK/KC-PAY-GPT.git KC-GPT-PAY
cd KC-GPT-PAY
powershell -ExecutionPolicy Bypass -File scripts\install-windows.ps1
```

本地日常运行请用 WSL + Docker：`docker compose up -d --build`。裸机调试用 `npm start`，并先在 `.env` 填写 `DB_PASSWORD`，确保 MySQL 已运行。

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

## 后台导入银行卡，确认支付地区（默认菲律宾 PHP）

2. CDK 管理生成 Plus / Pro / Codex 点数激活码
3. 用户访问 `/` 兑换，或访问 `/checkout` 手动开通
4. 任务记录查看进度、截图、录像；已结束且无媒体时显示「暂无截图/录像」
5. 点数开通不关闭自动续费，也不走第三方代充

---

## 主要功能

| 模块                | 说明                                    |
| ------------------- | --------------------------------------- |
| **CDK 兑换**        | Plus / Pro / Codex 点数                 |
| **自助开通**        | `/checkout` 独立页，手动卡和地址        |
| **信用卡卡池**      | 导入、选卡、拒卡换卡                    |
| **协议支付**        | taxes → token → confirm → PaymentIntent |
| **账单审计**        | 筛选、CSV 导出                          |
| **任务媒体**        | 进行中提示等待；结束后无文件显示暂无    |
| **Telegram 通知**   | 任务成功 / 失败推送（后台配置）         |
| **并发 & 维护模式** | 前台并发上限、维护开关，保存即生效      |

---

## 架构概览

```
┌─────────────────────────────────────────────────────────────┐
│                     server.js (Express)                      │
│   /api/redeem/*   /api/cdk/*   /api/admin/*   /api/public/* │
└─────────────────────────────────────────────────────────────┘
server.js            Express、公开接口、后台接口、任务调度
index.js             Playwright 子进程：登录 → Checkout → 协议支付
chatgpt.js           Checkout payload、Sentinel、PHP 协议提链
checkout-protocol.js Stripe taxes / token / confirm
mysql-store.js       CDK、卡池、任务、账单
public/index.html    卡密兑换
public/checkout.html 独立自助开通
public/admin.html    管理后台
```

---

## 目录结构

```
.
├── server.js
├── index.js
├── chatgpt.js
├── checkout-protocol.js
├── payment-retry.js
├── session-auth.js
├── mysql-store.js
├── region-config.js
├── public/
│   ├── index.html
│   ├── checkout.html
│   ├── admin.html
│   └── admin-login.html
├── docker-compose.yml
├── Dockerfile
└── mysql-schema.sql

## 接口文档

常用接口：

| 用途 | Method + Path | 鉴权 |
| --- | --- | --- |
| 卡密兑换 | `POST /api/redeem-product` | 无 |
| 自助开通 | `POST /api/public/checkout/pay` | 无 |
| 开通选项 | `GET /api/public/checkout/options` | 无 |
| 查询 CDK | `GET /api/cdk/query?cdk=...` | 无 |
| 后台登录 | `POST /api/admin/login` | 密码 |
| 卡池导入 | `POST /api/admin/cards/import` | Bearer |
| 外部卡池 | `POST /api/external/cards/push` | X-API-Key |

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
A: `server.js`、`mysql-store.js` 需重启；`index.js`、`chatgpt.js`、`checkout-protocol.js` 下次任务自动加载。

**Q: Windows 上 Playwright 安装失败？**
A: 管理员 PowerShell 执行：`Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`，再 `npx playwright install chromium`。

---

## 端口说明

| 端口   | 用途                                                  |
| ------ | ----------------------------------------------------- |
| 3000   | Web 服务 + WebSocket（可通过 `PORT` 环境变量修改）    |
| 3306   | MySQL（Docker 模式下映射到宿主机）                    |
| 19222+ | 瀏覽器池 CDP 連接埠（僅啟用 `BROWSER_POOL=1` 時使用） |

---

## 开发者 & 联系方式

| 项目   | 信息       |
| ------ | ---------- |
| 开发者 | **KC**     |
| TG     | **KcCatk** |

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
```
