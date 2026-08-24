## 2026-08-24 - Task: Checkout 改为页面同源 fetch

### What was done

- 对齐油猴脚本：在已登录的 chatgpt.com 页面用 `fetch(..., credentials: include)` 创建订单。
- payload 补 `cancel_url`、`account_id`；短链先 `custom` 再 `hosted`。
- 请求头补 `chatgpt-account-id` / `openai-account-id`，不额外伪造 Origin/Referer。

### Testing

- `node --check chatgpt.js`。

### Notes

- `chatgpt.js`：`postCheckoutFromPage`。
- 回滚方式：还原该文件。

## 2026-08-24 - Task: 修复定价页回退停在聊天首页

### What was done

- `#pricing` 现在只打开聊天页（`Ready when you are. Think`），不再弹出套餐弹窗。
- 定价页回退改为等待套餐弹窗；没有弹窗时从 Upgrade / 账户菜单点开。

### Testing

- `node --check pricing-checkout.js`。

### Notes

- `pricing-checkout.js`：`waitForPricingPage` 必须看到套餐弹窗才继续。
- 回滚方式：还原该文件。

## 2026-08-24 - Task: 对照原始仓库恢复 Checkout 请求

### What was done

- 对照 `KC-CatK/KC-PAY-GPT`：原始默认 `custom`，用 Playwright `context.request.post`，请求体只有 `entry_point/plan_name/billing_details/checkout_ui_mode`。
- 本地改回同一路径，去掉页面 `fetch`、账号头、`cancel_url`、`processor_entity`。
- 调试模式 API 失败后仍可回退定价页。

### Testing

- `node --check chatgpt.js`。

### Notes

- 原始仓库能出链，是请求形态更接近当时可用的 custom 通道，不是多传了 hosted 字段。
- 回滚方式：还原 `chatgpt.js`。

## 2026-08-24 - Task: 对齐官方 Checkout 请求并允许调试回退定价页

### What was done

- Checkout 请求体去掉 `processor_entity`，按官方脚本补 `account_id` / `openai_account_id`。
- 创建订单先 `hosted` 再 `custom`。
- 短链只在解析响应时用 `openai_ie` / `openai_llc`。
- 调试模式 API 被风控后继续走定价页拿链接。

### Testing

- `node --check chatgpt.js`、`node --check index.js`。

### Notes

- `chatgpt.js`：payload / hosted→custom。
- `index.js`：debugOnly 不再在 API 失败时立刻退出。
- 回滚方式：还原上述文件后重启 app。

## 2026-08-24 - Task: 修复 Checkout unusual activity 400

### What was done

- Checkout 默认改为 `hosted`，并补 `processor_entity` / `cancel_url`。
- 创建订单改为页面内同源 `fetch`，带 Cookie、账号头和 Origin/Referer。
- `unusual activity` 明确按风控拦截记录。

### Testing

- `node --check chatgpt.js`。
- `npx --yes vitest --run test/chatgpt-checkout.test.js`。

### Notes

- `chatgpt.js`：`createCheckoutSession` 优先走页面 fetch。
- `test/chatgpt-checkout.test.js`：覆盖 payload 与账号头。
- 回滚方式：还原 `chatgpt.js`；回滚后调试任务会再次用裸 API POST 触发 400。

## 2026-08-24 - Task: 修复支付链接调试 session-token HTTP 403

### What was done

- Cookie 在线校验不再用 `page.goto('/api/auth/session')` 当文档打开。
- 先打开 chatgpt.com 首页，再用带 Cookie 的 `fetch(..., { credentials: 'include' })` 校验。
- 无 JSON 的 403 按 Cloudflare/风控处理，不再直接判 session-token 失效。
- 注入时补上 `__Secure-next-auth.callback-url`。

### Testing

- `node --check session-auth.js` 通过。
- `npm test -- test/session-auth.test.js`。

### Notes

- `session-auth.js`：`verifyRealSessionApi` 改为同源 fetch。
- `test/session-auth.test.js`：覆盖 callback-url、短 token 不分块、403 挑战判定。
- 回滚方式：还原上述文件；回滚后调试任务会再次因文档导航 403 立刻失败。

## 2026-08-14 - Task: 修復 GPT 代充 API 協議代理傳參

### What was done

- Session inspect 保留為不使用代理的本機格式／到期檢查。
- 執行代充時從本地代理池取得啟用代理並傳入 `/pay.proxy`；本地池為空時省略欄位，由平台啟用代理池兜底。
- 完整 Session payload 繼續傳入，固定 CDK 冪等鍵不變。
- 重寫 `協議api.md`，對齊 inspect 無代理、Worker 協議有代理的新規格。
- 修正 Vitest CommonJS 測試載入方式。

### Testing

- `node --check gpt-api-client.js`、`node --check server.js` 通過。
- `npm test -- test/gpt-api-client.test.js`：3 passed。
- 線上使用正式 API 設定呼叫 inspect 成功，回 `reason=local_check`。
- 契約驗證確認 `/pay` payload 同時包含完整 Session 與 proxy。
- `docker compose up -d --build app` 成功，app 容器 healthy。

### Notes

- `gpt-api-client.js`：`submitPay` 支援並傳送 proxy。
- `server.js`：取得協議代理並傳入平台，保留平台代理回退。
- `test/gpt-api-client.test.js`：改驗證 proxy 會傳送並修復 Vitest 載入。
- `協議api.md`：更新完整協議與 403 風險說明。
- `progress.md`：追加本輪記錄。
- 回滾方式：還原上述檔案並執行 `docker compose up -d --build app`；回滾會恢復不傳代理的舊行為。

## 2026-08-14 - Task: 補齊 GPT API 套餐與卡片相容性

### What was done

- 新增 `pro_5x → pro5x`、`pro_20x → pro20x` 映射，inspect 與 pay 共用同一平台套餐鍵。
- `GET /plans` 客戶端支援平台 `{gpt, credit}` 回應。
- 卡片有效期嚴格支援 `MMYY`、`MM/YY`、`MM/YYYY`；無效格式明確失敗，不再回退 2030。

### Testing

- Node 語法檢查通過。
- `npm test -- test/gpt-api-client.test.js`：4 passed。

### Notes

- `server.js`：新增套餐鍵映射與有效期解析。
- `gpt-api-client.js`：支援 `raw.gpt` 套餐陣列。
- `test/gpt-api-client.test.js`：增加 plans 回應契約測試。
- `協議api.md`：補充套餐映射及有效期格式。
- `progress.md`：追加本輪記錄。
- 回滾方式：還原上述檔案並重建 app；回滾會使 Pro 套餐重新可能回 `plan_disabled`。

## 2026-08-14 - Task: 修復平台任務 done 誤判激活成功

### What was done

- 查詢 task 時優先讀取 `result.status`，不再把 queue 外層 `done` 當業務成功。
- 移除 `done` 成功終態；`result.ok=false` 強制按失敗處理並顯示內層錯誤。

### Testing

- `npm test -- test/gpt-api-client.test.js`：5 passed。
- 線上容器契約驗證：`done + result.failed → failed`，`done + result.success → success`。
- app 重建部署成功，容器 healthy。

### Notes

- `gpt-api-client.js`：優先解析內層業務狀態。
- `server.js`：移除 done 成功映射並使用 result.ok／error。
- `test/gpt-api-client.test.js`：新增 queue done 與業務終態回歸測試。
- `progress.md`：追加本輪記錄。
- 回滾方式：還原上述檔案並重建 app；回滾會再次把失敗任務誤報成功。
