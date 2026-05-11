# plus-papay

> **ChatGPT Plus 自动化开通工具（PayPal 通道）**  
> 注册 OpenAI 账号 → 走 0 元 Stripe Checkout → PayPal 支付占位 → 拉取 OAuth 协议 token → 自动入库出货。  
> 全流程后台管理、CDK 兑换、子进程并发、Playwright Stealth + 反指纹方案。

[License: MIT](LICENSE)
Node
MySQL
Playwright
Status

仓库：[https://github.com/432539/plus_gopay_gptp-plus](https://github.com/432539/plus_gopay_gptp-plus)

---

## 截图

> 后台「任务管理」页面：实时进度、状态徽章、Token 摘要、批量操作。

后台任务管理

---

## 这是什么

`plus-papay` 是一个用 **Node.js + Playwright** 写的服务端工具，配合一个 **MySQL** 数据库与一个简单的 Web 后台，把 ChatGPT Plus 的「**注册 → 0 元订单 → PayPal 占位支付 → 拉协议 token**」流程做成了**可批量、可重试、可观测**的成品生产系统。

它的常见用途：

- 给 CDK 自助兑换站做后端供货
- 跑批量 ChatGPT Plus 协议 token，供 Plus API/中转使用
- 验证一种「PayPal hosted checkout + 风控对抗」的实战方案

> ⚠️ **仅供学习与研究**：本项目涉及自动化注册、模拟支付、反指纹等技术，使用前请确保符合目标平台 ToS 与所在地法律法规。**作者不对任何滥用导致的封号、扣款、法律纠纷负责。**

---

## 架构

```
┌─────────────────────────────────────────────────────────────────┐
│                          server.js (Express)                    │
│  /api/admin/*    /api/cdk/*    /api/redeem/*    /api/public/*   │
└─────────────────────────────────────────────────────────────────┘
                │                                       │
                ▼                                       ▼
┌──────────────────────────┐            ┌──────────────────────────┐
│   product_activator.js   │            │    public/admin.html     │
│   • 任务调度 / 重试       │            │    • 后台单页面 (SPA)     │
│   • 资产池 reserve / lock │            │    • 任务、CDK、资产池    │
│   • 子进程错误分类        │            │    • 系统配置 / 邮箱管理  │
└──────────────────────────┘            └──────────────────────────┘
        │              │
        ▼              ▼
┌──────────────┐  ┌──────────────┐
│ register_*.js│  │   index.js   │
│ OpenAI 注册   │  │ 0 元 Stripe  │
│              │  │ + PayPal     │
└──────────────┘  └──────────────┘
        │              │
        └──────┬───────┘
               ▼
┌─────────────────────────────────────┐
│         oauth_login.js              │
│  支付成功后用 OTP 二次登录拿 RT      │
└─────────────────────────────────────┘
               │
               ▼
┌─────────────────────────────────────┐
│  MySQL（资产池 / 任务 / 配置 / 成品） │
└─────────────────────────────────────┘
```

每个任务由父进程 `product_activator` 调度，分三段子进程：

1. `**register_openai.js**` —— 注册 OpenAI 账号，拿到 `access_token`
2. `**index.js**` —— 用该 token 创建 0 元 Plus 订单，跑 Stripe Hosted Checkout，跳到 PayPal 走授权
3. `**oauth_login.js**` —— 支付成功后用注册邮箱重新登录，取出 `refresh_token`，写回成品库

任意一段失败都会被 `analyzeProcessOutput` 分类（如 `手机号被拒` / `代理超时` / `PayPal风控驳回` / ...），父进程根据分类决定**禁用资产、换号重试、还是终止整批**。

---

## 主要特性

### 1) 资产池 + 状态机

- 手机号 / 银行卡 / 邮箱、代理 IP 全部入库管理
- 任务级 `lock` + `release` 防止并发抢同一个号
- 出错时自动 `is_active=0, status='已报废'`，避免反复重试坏资产

### 2) 反指纹 / 反风控

- **Stealth Plugin** + 自定义 `addInitScript`：精修 `navigator.webdriver / plugins / userAgentData / canvas / WebGL` 等 30+ 指纹点
- **同一内核全程一致**：UA 与 `userAgentData.brands` 强制对齐，避免 hCaptcha invisible 检出
- **支持真 Chrome / Edge channel**：`CHROMIUM_CHANNEL=chrome` 或 `=msedge`
- **HEADFUL 模式**：`HEADFUL=1` 切到有头便于调试
- **PayPal 字段 fast 填充**：模拟密码管理器粘贴节奏，反制「键盘事件过长」打分

### 3) 多渠道邮箱

- **Cloudflare temp_email** 协议（多域名随机选 + 失败黑名单）
- **Microsoft Outlook IMAP / XOAUTH2** 邮箱池
- **OpenAI 自有随机域名** 三选一，可在后台动态切换

### 4) 智能重试


| 错误类型                                   | 处理                     |
| -------------------------------------- | ---------------------- |
| `OpenAI 鉴权服务异常`                        | 换代理 + 同号重试             |
| `手机号被拒/收不到验证码`                         | **永久禁用手机号**，换号重试       |
| `银行卡被拒`                                | 永久禁用银行卡，换卡重试           |
| `PayPal/Stripe redirect_status=failed` | 换号重试                   |
| `PayPal 仅渲染欢迎页`                        | 自动 `reload` 2 次，再判定为致命 |
| `资产池枯竭`                                | 终止整批，等待补货              |


### 5) 支付成功多重判定

- URL 跳到 `chatgpt.com` ✓
- Stripe 标准回调 `redirect_status=succeeded` ✓
- `redirect_status=failed/canceled` → **立即失败**，不傻等 60s
- `paypal.com/checkoutweb/genericError` → **立即识别为风控**

### 6) 实时运行日志

- 后台「运行日志」页面环形缓冲，可按 jobKey 过滤
- 子进程 stdout/stderr 全程透传 + 关键行进度条解析（如 `[结账] 等待 PayPal...` → 90%）

---

## 快速开始

### 1. 准备环境


| 组件          | 版本                                                                                                                           |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------- |
| **Node.js** | ≥ 20.x（Playwright 1.59 要求）                                                                                                   |
| **MySQL**   | ≥ 8.0                                                                                                                        |
| **OS**      | Linux / Windows / macOS 均可，Linux 跑 headless 需要 `libgbm1 libnss3 libxkbcommon0` 等（用 `npx playwright install --with-deps` 一键装） |


### 2. 拉代码 & 装依赖

```bash
git clone https://github.com/432539/plus_gopay_gptp-plus.git plus-papay
cd plus-papay
npm install
npx playwright install chromium     # Linux 服务器：npx playwright install --with-deps chromium
```

### 3. 建库 & 配置

```bash
# 建库
mysql -uroot -p -e "CREATE DATABASE plus_papay CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"

# 复制环境变量模板，按注释填
cp .env.example .env
```

`.env` 至少要填：

```
DB_PASSWORD=<your-mysql-password>
DB_NAME=plus_papay
ADMIN_PASSWORD=<your-admin-password>
PROXY=http://user:pass@your-proxy:port    # 强烈建议住宅代理
SMS_API_KEY=<sms-platform-key>
```

> 银行卡 / 手机号 / 邮箱建议**通过后台「资产池」入库管理**，而不是写在 `.env` 里。

### 4. 启动

```bash
# Linux / macOS
DB_HOST=127.0.0.1 DB_PORT=3306 DB_USER=root DB_PASSWORD=xxx DB_NAME=plus_papay node server.js

# Windows PowerShell（headful 调试）
$env:HEADFUL='1'; node server.js
```

启动成功会看到：

```
🔓 [资产锁] 启动时已重置所有 in_use 标记
数据库表检查完成
http://localhost:3000
MySQL => root@127.0.0.1:3306/plus_papay
```

打开 [http://localhost:3000/admin](http://localhost:3000/admin) 用 `ADMIN_PASSWORD` 登录即可。

### 5. 第一次跑一单

1. 后台 → **系统配置**：填好 PayPal 邮箱域名、临时邮箱 API、代理
2. 后台 → **资产池**：导入手机号 / 银行卡 / Outlook 邮箱池
3. 后台 → **任务管理** → **后台批量** → `count=1, workerCount=1` → 触发
4. 在「运行日志」页面观察整个流程；成功后会在「成品列表」看到 `🟢 SUCCESS` 一行

---

## 目录结构

```
.
├── server.js                # Express 入口、所有 REST API、WebSocket 推送
├── product_activator.js     # 任务调度核心：fork 子进程 / 错误分类 / 资产管理
├── register_openai.js       # OpenAI 注册流程（Playwright 子进程）
├── index.js                 # Stripe + PayPal 支付流程（Playwright 子进程）
├── oauth_login.js           # 支付后二次登录抓 refresh_token
├── chatgpt.js               # OpenAI checkout / order API 客户端
├── inbox-email.js           # cloudflare_temp_email 适配
├── pool-email-imap.js       # Outlook IMAP / XOAUTH2 邮箱池
├── imap-auth.js             # 自有 IMAP 服务的鉴权 token 缓存
├── mysql-store.js           # 全部 MySQL CRUD：资产、配置、成品
├── runtime-log.js           # 内存环形 buffer + WebSocket 广播
├── mysql-schema.sql         # 全套表结构（启动时也会自动建表）
├── public/
│   ├── admin.html           # 后台单页面 SPA（任务/CDK/资产/配置/邮箱/日志）
│   ├── admin-login.html
│   └── index.html           # 用户侧 CDK 兑换页
├── docs/
│   └── images/              # README 截图
├── .env.example
├── .gitignore
└── package.json
```

---

## 后台管理

后台一共五个标签页：

- **任务管理**：手动创建批量任务、看任务流水、Token 摘要、状态徽章、删除
- **CDK 管理**：批量生成、导入、导出、删除、出货
- **资产池**：手机号 / 银行卡 / 临时邮箱池、批量导入、状态切换
- **系统配置**：DB 连接、ADMIN 密码修改、代理列表、邮箱通道、并发上限、超时阈值
- **运行日志**：实时滚动日志，按 jobKey 过滤，支持手动清空

> 截图见上文「截图」一节。

---

## 接口

完整 REST API 见 `[API_DOC.md](API_DOC.md)`（项目自带）。摘要：


| 用途        | Method + Path                            | 鉴权     |
| --------- | ---------------------------------------- | ------ |
| 用户兑换 CDK  | `POST /api/redeem-product`               | 无      |
| 查询 CDK 状态 | `GET /api/cdk/query?cdk=...`             | 无      |
| 后台登录      | `POST /api/admin/login`                  | 密码     |
| 后台数据全量    | `GET /api/admin/data`                    | Bearer |
| 创建批量任务    | `POST /api/admin/products/generate`      | Bearer |
| 终止任务      | `POST /api/admin/products/generate-stop` | Bearer |
| 实时日志      | `GET /api/admin/runtime-logs?after=...`  | Bearer |
| 邮箱池 CRUD  | `/api/admin/pool-emails(/...)`           | Bearer |
| 代理批量测试    | `POST /api/admin/proxy/test`             | Bearer |
| 配置读写      | `GET/POST /api/admin/config`             | Bearer |


---

## 常见问题

**Q: PayPal 一直 `redirect_status=failed`？**  
A: 99% 是代理 IP 评分太低或银行卡 BIN 被 PayPal 标记。建议：①换更干净的住宅代理 ②换不同 BIN 段 ③`workerCount` 降到 1。

**Q: PayPal 创建账户表单只显示购物袋盾牌图（welcome page）？**  
A: 已内置自动 `reload` 2 次的兜底，仍不出现就视为 PayPal 风控直接放弃，让父进程换号。

**Q: 短信平台一直返回 `no|暂无验证码`？**  
A: 已内置「连续 12 次（约 60s）无验证码」→ 抛错 `手机号短信验证异常`，自动**永久禁用该号**并换号。

**Q: 怎么看任务到底卡哪了？**  
A: 后台「运行日志」按 jobKey 过滤；每个子进程的 stdout 都有时间戳前缀，可以精确到秒定位。

**Q: 程序为什么不重启就能改 `index.js / register_openai.js`？**  
A: 这两个是子进程文件，每次任务 `fork` 时重新加载；只有 `server.js / product_activator.js / mysql-store.js` 改动需要重启 server。

---

## 路线图 / 不在范围

`plus-papay` 只解决 **PayPal 通道**。如果你需要 **GoPay / 信用卡直付** 的版本，作者在另一个仓库里维护：

- **plus-gopay**（同作者）：Python + Playwright + 自家 hCaptcha solver，通过 GoPay/信用卡直付走 Stripe，机制完全独立。

两个项目的资产池 schema、错误分类逻辑设计相似，但**不要共用进程跑**，PayPal 与信用卡两条链路对指纹一致性要求不同。

---

## 安全披露

如果你发现可被恶意利用的漏洞（例如能绕过后台鉴权、读取他人 token），请 **不要直接开 issue**，而是发邮件到仓库 owner 的 GitHub 邮箱。  
请给作者 7 天的修复窗口。

---

## 许可

[MIT License](LICENSE) © 2026 plus-papay contributors

---

## 免责声明

本项目所有代码以 **「AS IS」** 形式发布，作者**不对以下情形负责**：

- 因使用本项目导致的 OpenAI 账号封禁、PayPal 账户冻结、银行卡风控
- 因使用本项目违反目标平台 ToS、SaaS 服务条款、所在地法律法规所引起的任何后果
- 因使用本项目导致的资金损失、数据泄露、第三方权益受损

**使用即表示你已阅读、理解并接受以上条款。**

---

## 赞赏 / Sponsor

如果这个项目对你有帮助，欢迎请作者喝杯咖啡 ☕



> 把你的赞赏码图片保存到 `docs/images/sponsor.png` 即可显示。

