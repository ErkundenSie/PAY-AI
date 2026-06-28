# 部署指南

## 系统要求

| 组件 | 最低要求 |
|------|----------|
| Node.js | >= 20 |
| MySQL | >= 8.0 |
| 内存 | >= 2GB（浏览器自动化需要） |
| 磁盘 | >= 5GB（含 Chromium 浏览器） |

---

## 方式一：Docker 部署（推荐）

最简单的部署方式，适合所有支持 Docker 的平台。

### 1. 安装 Docker

```bash
# Ubuntu/Debian
curl -fsSL https://get.docker.com | sh
sudo systemctl enable docker && sudo systemctl start docker

# macOS — 安装 Docker Desktop
# https://www.docker.com/products/docker-desktop/

# Windows — 安装 Docker Desktop (WSL2 模式)
# https://www.docker.com/products/docker-desktop/
```

### 2. 配置环境变量

```bash
cp .env.example .env
nano .env   # 填写 DB_PASSWORD 和 PROXY
```

关键配置项：
```env
DB_PASSWORD=your_strong_password   # MySQL 密码
PROXY=http://user:pass@proxy:port  # 住宅代理（强烈建议）
ADMIN_PASSWORD=your_admin_pass     # 后台管理密码
```

### 3. 一键启动

```bash
docker compose up -d
```

访问：`http://your-server-ip:3000/admin-login.html`

### 4. 常用命令

```bash
# 查看日志
docker compose logs -f app

# 重启服务
docker compose restart app

# 停止所有
docker compose down

# 更新代码后重新构建
docker compose up -d --build

# 进入容器调试
docker compose exec app bash
```

---

## 方式二：裸机部署

适合 macOS / Ubuntu / Debian / CentOS / Windows。

### macOS / Linux 一键安装

```bash
git clone <your-repo-url> KC-GPT-PAY
cd KC-GPT-PAY
chmod +x scripts/install.sh
./scripts/install.sh
```

### Windows (PowerShell 管理员)

```powershell
git clone <your-repo-url> KC-GPT-PAY
cd KC-GPT-PAY
powershell -ExecutionPolicy Bypass -File scripts\install-windows.ps1
```

### 手动安装步骤

#### 1. 安装 Node.js 20+

```bash
# macOS (Homebrew)
brew install node@20

# Ubuntu/Debian
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# CentOS/RHEL
curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -
sudo yum install -y nodejs

# Windows — 下载安装包
# https://nodejs.org/en/download
```

#### 2. 安装系统依赖（Linux）

Ubuntu/Debian:
```bash
sudo apt-get install -y \
    wget curl fonts-liberation fonts-noto-cjk \
    libatk-bridge2.0-0 libatk1.0-0 libcups2 libdbus-1-3 \
    libdrm2 libgbm1 libgtk-3-0 libnspr4 libnss3 \
    libx11-xcb1 libxcomposite1 libxdamage1 libxrandr2 \
    libxss1 libasound2 libpangocairo-1.0-0 libxshmfence1
```

CentOS/RHEL:
```bash
sudo yum install -y \
    wget curl liberation-fonts google-noto-cjk-fonts \
    atk cups-libs dbus-libs libdrm mesa-libgbm gtk3 nspr nss \
    libXcomposite libXdamage libXrandr libXScrnSaver alsa-lib pango
```

macOS / Windows 不需要额外系统依赖。

#### 3. 安装项目依赖

```bash
npm install --production
npx playwright install chromium
```

#### 4. 安装 MySQL 8

```bash
# Ubuntu
sudo apt-get install -y mysql-server
sudo systemctl start mysql

# macOS
brew install mysql && brew services start mysql

# CentOS
sudo yum install -y mysql-server
sudo systemctl start mysqld

# Windows — 下载安装包
# https://dev.mysql.com/downloads/installer/
```

创建数据库：
```bash
mysql -u root -p -e "CREATE DATABASE IF NOT EXISTS plus_papay CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
```

#### 5. 配置并启动

```bash
cp .env.example .env
# 编辑 .env，填写 DB_PASSWORD、PROXY 等

npm start
```

---

## 方式三：使用 PM2 守护进程（生产推荐）

```bash
# 安装 PM2
npm install -g pm2

# 启动
pm2 start server.js --name kc-gpt-pay

# 开机自启
pm2 startup
pm2 save

# 查看日志
pm2 logs kc-gpt-pay

# 重启
pm2 restart kc-gpt-pay
```

---

## 反向代理（Nginx）

如果需要通过域名访问或使用 HTTPS：

```nginx
server {
    listen 80;
    server_name your-domain.com;

    # WebSocket 支持
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

配合 Let's Encrypt 免费 HTTPS：
```bash
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d your-domain.com
```

---

## 常见问题

### Q: Chromium 启动失败 (Linux 无图形界面)

确保使用 `HEADFUL=0`（默认无头模式），并安装了所有系统依赖：
```bash
npx playwright install-deps chromium
```

### Q: Docker 中浏览器崩溃

增加共享内存：docker-compose.yml 中已配置 `shm_size: '2gb'`。如果仍然崩溃，可以增大到 4gb。

### Q: Windows 上 Playwright 安装失败

以管理员权限运行 PowerShell：
```powershell
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
npx playwright install chromium
```

### Q: MySQL 连接被拒绝

检查：
1. MySQL 服务是否运行：`sudo systemctl status mysql`
2. 用户权限：`GRANT ALL ON plus_papay.* TO 'root'@'%';`
3. Docker 模式下 DB_HOST 应为 `mysql`（service name），裸机模式下为 `127.0.0.1`

### Q: 代理如何配置

在 `.env` 中设置：
```env
PROXY=http://username:password@proxy-host:port
```

支持 HTTP/HTTPS/SOCKS5 代理。强烈建议使用住宅代理以降低风控风险。

---

## 端口说明

| 端口 | 用途 |
|------|------|
| 3000 | Web 服务 + WebSocket |
| 3306 | MySQL |
