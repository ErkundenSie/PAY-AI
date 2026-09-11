# KC-PAY-GPT

Node.js + Playwright + MySQL 的开通服务。用户可走卡密兑换或独立自助开通页，后台管理卡池、CDK、任务和账单。支付默认协议优先。

支持套餐：ChatGPT Plus、Pro 5x、Pro 20x。

- 卡密兑换：`/`（含任务查询、订阅查询、更换卡密、取消任务）
- 自助开通：`/checkout`（粘贴 Session，可选手动卡和地址）
- 发票助手：`/subscription`
- 后台登录：`/admin-login`（路径可在后台修改）

默认 Web 端口 `17621`。Docker 端口默认只绑定本机 `127.0.0.1`。

## 系统要求

| 组件 | 要求 |
| --- | --- |
| Node.js | ≥ 20.x |
| MySQL | ≥ 8.0 |
| 内存 | ≥ 4 GB（Docker 容器上限 6 GB，浏览器自动化建议再留余量） |
| 磁盘 | ≥ 5 GB（含 Chromium 与 hCaptcha 依赖） |
| 操作系统 | Linux / macOS / Windows |

Linux 无图形界面跑 headless 时，需安装 Playwright 系统依赖。

## 部署

### 方式一：Docker（推荐）

适合 Linux 云服务器、macOS、Windows（Docker Desktop），自带 MySQL 8。

1. 安装 [Docker](https://www.docker.com/products/docker-desktop/) 或：

```bash
curl -fsSL https://get.docker.com | sh
sudo systemctl enable docker && sudo systemctl start docker
```

2. 在项目目录配置环境变量：

```bash
cp .env.example .env
```

至少填写：

```env
DB_PASSWORD=your_strong_mysql_password
ADMIN_PASSWORD=your_admin_password_12plus
PROXY=http://user:pass@proxy-host:port
APP_BIND_ADDRESS=127.0.0.1
MYSQL_BIND_ADDRESS=127.0.0.1
MYSQL_PORT=3310
BROWSER_POOL=1
TRUST_PROXY=0
```

`ADMIN_PASSWORD` 至少 12 位。`DB_PASSWORD` 必填。Compose 会把应用的 `DB_HOST` 强制设为 `mysql`，`.env` 里的 `DB_HOST` 不用改。

3. 启动：

```bash
docker compose up -d --build
```

首次构建需数分钟（Chromium + hCaptcha Python 依赖）。默认访问：

| 地址 | 说明 |
| --- | --- |
| `http://127.0.0.1:17621/` | 卡密兑换 |
| `http://127.0.0.1:17621/checkout` | 自助开通 |
| `http://127.0.0.1:17621/subscription` | 发票助手 |
| `http://127.0.0.1:17621/admin-login` | 后台登录 |

对外部署不要直接暴露 `17621`。保持 `APP_BIND_ADDRESS=127.0.0.1`，用 Nginx / HTTPS 反代，并设 `TRUST_PROXY=1`。仅调试时可改为 `APP_BIND_ADDRESS=0.0.0.0`。

```bash
docker compose logs -f app
docker compose restart app
docker compose down
docker compose up -d --build
```

不要使用 `docker compose down -v`，否则会删除 MySQL 数据卷。

### 方式二：裸机部署

安装 Node.js 20+ 和 MySQL 8 后，在项目目录执行：

```bash
# macOS / Linux
chmod +x scripts/install.sh
./scripts/install.sh
```

Windows 首次安装请用管理员 PowerShell：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-windows.ps1
```

或手动安装依赖：

```bash
npm install --production
npx playwright install chromium
```

Linux 服务器额外执行：

```bash
npx playwright install --with-deps chromium
```

创建数据库并配置 `.env`：

```bash
mysql -u root -p -e "CREATE DATABASE IF NOT EXISTS plus_papay CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
cp .env.example .env
```

```env
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=root
DB_PASSWORD=你的MySQL密码
DB_NAME=plus_papay
ADMIN_PASSWORD=你的后台密码至少12位
PROXY=http://user:pass@proxy-host:port
HEADFUL=0
BROWSER_POOL=1
```

```bash
npm start
```

生产环境可用 PM2 守护：

```bash
npm install -g pm2
pm2 start server.js --name kc-gpt-pay
pm2 startup
pm2 save
```

需要域名或 HTTPS 时，将 Nginx 反代到 `127.0.0.1:17621`，并设置 `TRUST_PROXY=1`。

## 注意事项

- `ADMIN_PASSWORD` 至少 12 位，`DB_PASSWORD` 必填，缺一不可启动。
- 首次使用请在后台导入银行卡，并确认支付地区（默认菲律宾 PHP）。
- Docker 应用连库用 `mysql:3306`；宿主机映射的是 `127.0.0.1:3310`。裸机连本机库用 `DB_HOST=127.0.0.1`、`DB_PORT=3306`。
- 浏览器池默认开启（`BROWSER_POOL=1`），也可在后台「浏览器池」页切换。关闭请设 `BROWSER_POOL=0`。
- Docker 已配置 `shm_size: 2gb`、内存上限 6G。浏览器仍崩溃时可把 `shm_size` 调到 `4gb`，并保证宿主机内存充足。
- Linux 上 Chromium 启动失败时执行 `npx playwright install-deps chromium`，并保持 `HEADFUL=0`。
- 已有数据库默认保留后台账号。要用 `.env` 覆盖时设 `ADMIN_CONFIG_SYNC=1`，成功启动后立刻改回 `0`。
- 请勿使用 `docker compose down -v`，以免删除数据卷。
- 修改 `server.js`、`mysql-store.js` 后需重启服务。
