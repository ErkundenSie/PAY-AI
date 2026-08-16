# GPT-KCCatk API 完整對接說明

> 文件版本：2026-08-16  
> 適用接口：`/api/v1`  
> 預設資料格式：`application/json; charset=utf-8`

本文是普通使用者／第三方系統對接文件，涵蓋目前正式提供的全部 `/api/v1` 接口、認證、Scope、請求欄位、成功回應、錯誤回應、冪等、代理、Session、輪詢與終態判定。

---

## 1. 基本資訊

### 1.1 Base URL

```text
https://gogpt.id88.icu/api/v1
```

若使用其他部署域名，請替換主機部分，路徑 `/api/v1` 不變。

以下範例使用環境變數：

```bash
export BASE_URL="https://gogpt.id88.icu/api/v1"
export GPTK="gptk_your_api_key"
```

### 1.2 通用請求 Header

```http
Authorization: Bearer gptk_your_api_key
Content-Type: application/json
```

建立代充訂單時還必須傳：

```http
Idempotency-Key: your-stable-business-id
```

### 1.3 認證

所有 `/api/v1` 接口均使用 Bearer API Key：

```http
Authorization: Bearer gptk_...
```

API Key 必須屬於啟用中的帳號、未被撤銷，且包含接口所需 Scope。

常見認證錯誤：

```json
{"detail":"not_authenticated"}
```

```json
{"detail":"invalid_api_key"}
```

```json
{"detail":"insufficient_scope"}
```

對應 HTTP 狀態：

- `401 not_authenticated`：缺少 Bearer 認證。
- `401 invalid_api_key`：API Key 無效、已撤銷或帳號不可用。
- `403 insufficient_scope`：API Key 沒有所需 Scope。

### 1.4 Scope 清單

- `plans:read`：讀取套餐。
- `plans:purchase`：購買積分／訂閱套餐；目前購買接口已停用。
- `pay:write`：檢查 Session、建立代充訂單、查詢單筆代充訂單、補交 CVC／Session。
- `tasks:read`：查詢任務。
- `orders:read`：查詢訂單列表。
- `balance:read`：查詢積分與餘額。
- `entitlements:read`：查詢訂閱權益。
- `api_keys:read`、`api_keys:write`：管理 API Key。
- `bank_cards:read`、`bank_cards:write`、`bank_cards:balance`：管理銀行卡、餘額與嘗試記錄。
- `proxy:read`、`proxy:write`、`proxy:test`：管理與測試個人代理。
- `virtual_cards:read`、`virtual_cards:write`：管理虛擬卡申請。

### 1.5 時間、金額與敏感資料

- 公開訂單時間按北京時間格式化，常見格式為 `YYYY-MM-DD HH:mm:ss`。
- `amount_minor` 是最小貨幣單位整數，例如 `1000` 表示 `10.00`。
- `amount`、`balance_usd` 等十進位金額使用字串，避免浮點誤差。
- 完整 API Key 僅建立時回傳一次。
- Session、PAN、CVC、完整代理帳密不會出現在公開訂單／任務結果中。
- 已保存銀行卡的完整卡號不會由 API 查詢接口回傳。

---

## 2. 標準錯誤格式

### 2.1 業務錯誤

一般錯誤：

```json
{
  "detail": "invalid_proxy"
}
```

客戶端應讀取 HTTP response body 的 `detail`，不要只讀 `message`。

### 2.2 欄位驗證錯誤（HTTP 422）

```json
{
  "detail": [
    {
      "type": "missing",
      "loc": ["body", "plan_key"],
      "msg": "Field required",
      "input": {}
    }
  ]
}
```

`detail` 可能是字串，也可能是陣列；客戶端必須同時相容。

### 2.3 常見錯誤碼

- `400 idempotency_key_required`：`POST /pay` 未帶 `Idempotency-Key`。
- `400 session_required`：Session 缺失或找不到 access token（`POST /pay` 為 400；`/pay/inspect` 則為 HTTP 200 + body.error）。
- `400 session_expired`：Session 中 JWT 已過期（同上，inspect 為 200 + error）。
- `400 exactly_one_card_source_required`：`card_id` 與 `new_card` 必須二選一。
- `400 invalid_pan`：卡號未通過 Luhn 驗證。
- `400 invalid_expiry`：到期月份不在 `1..12`。
- `400 invalid_proxy`：代理 URL scheme／埠號不合法。
- `400 proxy_hostname_must_be_public_ip`：代理主機不是公網 IP（域名不可用）。
- `400 private_proxy_forbidden`：代理主機是 localhost／內網 IP。
- `400 invalid_currency`：貨幣代碼不合法。
- `400 amount_required`：未提供 `amount` 或 `amount_minor`。
- `400 invalid_fx_rate`：匯率不是正數。
- `400 invalid_batch_size`：批次銀行卡數量不在 `1..100`。
- `400 ids_required`：批次刪除沒有有效 ID。
- `400 card_provider_unavailable`：虛擬卡服務商不存在或未啟用。
- `401 invalid_api_key`：API Key 無效。
- `403 insufficient_scope`：缺少 Scope。
- `403 payment_cards_disabled`：支付卡功能未開放。
- `403 credit_purchase_disabled`：API 購買積分已停用。
- `403 subscription_purchase_disabled`：API 購買訂閱已停用。
- `404 order_not_found`：訂單不存在或不屬於目前帳號。
- `404 task_not_found`：任務不存在或不屬於目前帳號。
- `404 card_not_found`：銀行卡不存在或不屬於目前帳號。
- `404 proxy_not_found`：未保存個人代理。
- `404 request_not_found`：虛擬卡申請不存在。
- `404 api_key_not_found`：API Key 不存在、已撤銷或不屬於目前帳號。
- `409 idempotency_conflict`：相同冪等鍵被用於不同業務請求。
- `409 card_already_exists`：相同卡號已存在。
- `409 card_disabled`：已保存銀行卡不是 `active`。
- `409 credentials_not_supplementable`：訂單目前不允許補交憑證。
- `409 warnings_not_accepted`：使用有警告的已保存卡且未傳 `accept_warnings=true`；`detail` 為物件含 `warnings`。
- `409 concurrency_limit`：已達帳號並行上限（少見）；現行多數情況會改回 HTTP 200 + `already_submitted=true`。
- `409 insufficient_credits`：積分不足。
- `409 topup_code_out_of_stock`：目前套餐沒有可用代充卡密。
- `422`：JSON 欄位型別或結構錯誤。
- `503 transient_secret_store_unavailable`：臨時敏感資料儲存不可用。

---

## 3. 建議代充對接流程

1. `GET /plans` 取得有效 `plan_key`。
2. 可選呼叫 `POST /pay/inspect` 做 Session 本機格式／到期檢查。
3. 準備 `new_card`，或先建立銀行卡再使用 `card_id`。
4. 生成穩定的 `Idempotency-Key`。
5. `POST /pay` 建單，保存 `order_id` 與 `task_id`。若回 `already_submitted=true`，改輪詢既有訂單，不要再建單。
6. 優先輪詢 `GET /pay/orders/{order_id}`；也可輪詢 `GET /tasks/{task_id}`。若出現 `requires_cvc`，先 `POST /orders/{order_id}/credentials` 再繼續輪詢。
7. 只有訂單 `status=success`，或任務 `status=success` 且 `result.ok=true`，才可報告開通成功。

重要：`POST /pay` 的 `ok=true` 只表示建單／入隊成功，不代表付款或開通成功。

---

# 4. 套餐、代充、任務與訂單

## 4.1 GET `/plans`

Scope：`plans:read`

取得 GPT 套餐與積分套餐。

請求：

```bash
curl "$BASE_URL/plans" \
  -H "Authorization: Bearer $GPTK"
```

成功回應 `200`：

```json
{
  "gpt": [
    {
      "id": 1,
      "key": "plus",
      "name": "ChatGPT Plus",
      "plan_name": "chatgptplusplan",
      "success_cost": 100,
      "fail_cost": 5,
      "enabled": 1,
      "sort": 10
    }
  ],
  "credit": [
    {
      "id": 1,
      "name": "100 Credits",
      "price": 1000,
      "credits": 100,
      "price_usd": "10.00"
    }
  ]
}
```

`gpt[].key` 是 `/pay` 的 `plan_key`。只提交 API 實際返回且 `enabled` 為真值的套餐。

---

## 4.2 POST `/pay/inspect`

Scope：`pay:write`

此接口只做本機 Session 結構、access token 與 JWT 到期檢查：

- 不連線 ChatGPT。
- 不使用代理。
- 不檢查目前 ChatGPT 套餐。
- 不建單、不占用卡密、不扣積分。
- 不需要 `Idempotency-Key`。

請求欄位：

- `session`：object，可選；實際使用時應提供。需包含可識別的 access token。
- `plan_key`：string，可選；目前本機檢查不驗證套餐。

請求：

```bash
curl -X POST "$BASE_URL/pay/inspect" \
  -H "Authorization: Bearer $GPTK" \
  -H "Content-Type: application/json" \
  -d '{
    "plan_key": "plus",
    "session": {
      "access_token": "eyJ..."
    }
  }'
```

有效 Session 回應 `200`：

```json
{
  "ok": true,
  "verified": true,
  "error": null,
  "expired": false,
  "already_active": false,
  "current_plan": null,
  "has_active_subscription": false,
  "subscription_plan": null,
  "email": "user@example.com",
  "check_skipped": true,
  "reason": "local_check",
  "upstream_status": null
}
```

缺少 token 時仍回 HTTP `200`，以 body 表示失敗：

```json
{
  "ok": false,
  "verified": false,
  "error": "session_required",
  "expired": false,
  "already_active": false,
  "current_plan": null,
  "has_active_subscription": false,
  "subscription_plan": null,
  "email": null,
  "check_skipped": true,
  "reason": "local_check",
  "upstream_status": null
}
```

JWT 過期時：

```json
{
  "ok": false,
  "verified": false,
  "error": "session_expired",
  "expired": true,
  "already_active": false,
  "current_plan": null,
  "has_active_subscription": false,
  "subscription_plan": null,
  "email": "user@example.com",
  "check_skipped": true,
  "reason": "local_check",
  "upstream_status": null
}
```

`verified=true` 只表示 Session 可提交，不表示 ChatGPT 已接受它。

---

## 4.3 POST `/pay`

Scope：`pay:write`

建立 GPT 代充訂單。

必要 Header：

```http
Authorization: Bearer gptk_...
Idempotency-Key: cdk-order-123456
Content-Type: application/json
```

請求欄位：

- `plan_key`：string，必填；來自 `GET /plans` 的 `gpt[].key`。
- `session`：object，業務必填；完整 Session JSON。
- `card_id`：integer，可選；已保存銀行卡 ID。
- `new_card`：object，可選；本次訂單使用的新卡。
- `cvc`：string，使用 `card_id` 時傳入；不會持久化保存。
- `country`：string，預設 `PH`。
- `currency`：string，預設 `PHP`。
- `accept_warnings`：boolean，預設 `false`。使用 `card_id` 且該卡存在警告時，若不為 `true` 會回 `409 warnings_not_accepted`（`detail` 為物件）。
- `client_ref`：string，預設 `single`；對接方自己的業務標識。
- `billing_address`：object，可選；訂單帳單地址。
- `proxy`：string 或 null，可選；固定該訂單 Worker 協議出口。
- `platform_api_key`：string，公開 `/api/v1/pay` 不需要傳，Bearer API Key 已完成認證。

`card_id` 與 `new_card` 必須且只能提供一個。

`new_card` 欄位：

- `number`：string，必填；允許字串中有分隔符，後端取數字並做 Luhn 驗證。
- `exp_month`：integer，必填，`1..12`。
- `exp_year`：integer，必填，例如 `2030`。
- `cvc`：string，必填。
- `name`：string，預設空；空值時使用帳號 Email。
- `country`：string，預設 `US`。
- `billing_address`：object，預設 `{}`。

### 使用新卡建單

```bash
curl -X POST "$BASE_URL/pay" \
  -H "Authorization: Bearer $GPTK" \
  -H "Idempotency-Key: cdk-order-123456" \
  -H "Content-Type: application/json" \
  -d '{
    "plan_key": "plus",
    "new_card": {
      "number": "4242424242424242",
      "exp_month": 12,
      "exp_year": 2030,
      "cvc": "123",
      "name": "API User",
      "country": "US",
      "billing_address": {
        "line1": "1 Main Street",
        "city": "Manila",
        "postal_code": "1000",
        "country": "PH"
      }
    },
    "country": "PH",
    "currency": "PHP",
    "session": {
      "access_token": "eyJ...",
      "user": {"email": "user@example.com"}
    },
    "proxy": "http://user:pass@203.0.113.10:8080",
    "client_ref": "kc-cdk-123456"
  }'
```

### 使用已保存銀行卡建單

```bash
curl -X POST "$BASE_URL/pay" \
  -H "Authorization: Bearer $GPTK" \
  -H "Idempotency-Key: cdk-order-123457" \
  -H "Content-Type: application/json" \
  -d '{
    "plan_key": "plus",
    "card_id": 12,
    "cvc": "123",
    "accept_warnings": true,
    "country": "PH",
    "currency": "PHP",
    "session": {"access_token": "eyJ..."}
  }'
```

建單成功 `200`：

```json
{
  "ok": true,
  "task_id": 501,
  "order_id": 1201,
  "order_no": "20260814122500",
  "status": "pending",
  "message": "已入队，请稍后查询结果",
  "warnings": [],
  "client_ref": "kc-cdk-123456",
  "card": {
    "id": null,
    "last4": "4242",
    "source": "new"
  }
}
```

使用已保存卡時，`card.id` 是銀行卡 ID，`source` 為 `saved`。

相同冪等鍵與相同業務請求重試：

```json
{
  "ok": true,
  "task_id": 501,
  "order_id": 1201,
  "status": "pending",
  "display_status": "queued",
  "order_no": "20260814122500",
  "request_fingerprint": "...",
  "idempotent": true
}
```

已有同一充值帳號的處理中訂單時，接口可能回 HTTP `200` 並復用既有訂單：

```json
{
  "ok": true,
  "already_submitted": true,
  "error": "already_submitted",
  "active_count": 1,
  "order_id": 1201,
  "order_no": "20260814122500",
  "task_id": 501,
  "status": "pending",
  "display_status": "queued",
  "recharge_account": "user@example.com",
  "orders": [
    {
      "id": 1201,
      "task_id": 501,
      "order_no": "20260814122500",
      "status": "pending",
      "display_status": "queued",
      "recharge_account": "user@example.com"
    }
  ],
  "message": "已有1笔订单正在处理/排队中，已提交无需重复提交"
}
```

客戶端遇到 `already_submitted=true` 時，應輪詢回傳的既有 `order_id`，不可再次建立新訂單。

代理規則：

1. 若請求傳 `proxy`，平台驗證後固定保存到該訂單。
2. 未傳時，依序使用帳號個人代理、帳號代理 override、平台代理池。
3. 支援 `http://`、`https://`、`socks5://`。
4. 主機必須是**公網 IP**（不可用域名），且必須含埠號；localhost、內網 IP、域名、無埠號或其他 scheme 會拒絕。
5. Worker 執行 ChatGPT／付款協議時使用解析後代理；`/pay/inspect` 不使用它。

---

## 4.4 GET `/pay/orders/{order_id}`

Scope：`pay:write`

建議作為主要輪詢接口。

```bash
curl "$BASE_URL/pay/orders/1201" \
  -H "Authorization: Bearer $GPTK"
```

處理中回應示例：

```json
{
  "id": 1201,
  "user_id": 10,
  "kind": "pay",
  "plan": "plus",
  "action": "pay",
  "status": "pending",
  "display_status": "queued",
  "currency": "PHP",
  "task_id": 501,
  "order_no": "20260814122500",
  "recharge_account": "user@example.com",
  "card_last4": "4242",
  "card_number": "•••• 4242",
  "topup_code": "user-code-prefix...",
  "attempt": 0,
  "fail_reason": null,
  "error_code": "",
  "auto_renew": false,
  "amount_minor": null,
  "amount": null,
  "redirect_url": null,
  "created_at": "2026-08-14 12:25:00",
  "updated_at": "2026-08-14 12:25:00",
  "settled_at": null,
  "duration_seconds": 3
}
```

成功終態示例：

```json
{
  "id": 1201,
  "kind": "pay",
  "plan": "plus",
  "status": "success",
  "display_status": "success",
  "outcome": "success",
  "currency": "PHP",
  "amount_minor": 115000,
  "amount": "1150.00",
  "task_id": 501,
  "order_no": "20260814122500",
  "recharge_account": "user@example.com",
  "card_number": "•••• 4242",
  "topup_code": "user-code-prefix...",
  "attempt": 1,
  "fail_reason": null,
  "error_code": "",
  "auto_renew": true,
  "redirect_url": "https://chatgpt.com/...",
  "created_at": "2026-08-14 12:25:00",
  "updated_at": "2026-08-14 12:27:01",
  "settled_at": "2026-08-14 12:27:01",
  "duration_seconds": 121
}
```

失敗終態示例：

```json
{
  "id": 1201,
  "kind": "pay",
  "plan": "plus",
  "status": "failed",
  "display_status": "failed",
  "outcome": "failed",
  "currency": "PHP",
  "task_id": 501,
  "order_no": "20260814122500",
  "recharge_account": "user@example.com",
  "card_number": "•••• 4242",
  "attempt": 1,
  "fail_reason": "cf_challenge_unresolved: cf_clearance not issued",
  "error_code": "",
  "auto_renew": false,
  "created_at": "2026-08-14 12:25:00",
  "updated_at": "2026-08-14 12:27:01",
  "settled_at": "2026-08-14 12:27:01",
  "duration_seconds": 121
}
```

主要狀態：

- 業務 `status` 非終態常見為 `pending`（排隊時 `display_status` 多為 `queued`）、`running`。
- 成功終態：`success`。
- 失敗／拒付終態：`failed`、`declined`。
- 系統不確定終態：`system_error`、`stalled`。
- 取消終態：`cancelled`。
- 需補資料：`requires_cvc`（應呼叫 `POST /orders/{order_id}/credentials`）。

對接方應以 `status` 作業務判定，`display_status` 只用於顯示。只有 `success` 可報告開通成功。

公開回應會移除 `proxy`、`metadata`、Session、CVC、完整卡號密文、API Key 與 Worker 密鑰等敏感欄位。部分欄位只有在有資料時才出現或為 `null`。

---

## 4.5 GET `/tasks/{task_id}`

Scope：`tasks:read`

```bash
curl "$BASE_URL/tasks/501" \
  -H "Authorization: Bearer $GPTK"
```

處理中：

```json
{
  "id": 501,
  "status": "running",
  "queue_status": "running",
  "error": null,
  "order_id": 1201,
  "result": {}
}
```

成功：

```json
{
  "id": 501,
  "status": "success",
  "queue_status": "done",
  "error": null,
  "order_id": 1201,
  "result": {
    "ok": true,
    "order_id": 1201,
    "status": "success",
    "charge_id": "ch_...",
    "credits_cost": 100
  }
}
```

Worker 業務失敗但佇列已完成：

```json
{
  "id": 501,
  "status": "failed",
  "queue_status": "done",
  "error": "cf_challenge_unresolved: cf_clearance not issued",
  "order_id": 1201,
  "result": {
    "ok": false,
    "order_id": 1201,
    "status": "failed",
    "error": "cf_challenge_unresolved: cf_clearance not issued",
    "credits_cost": 5
  }
}
```

欄位定義：

- `status`：支付業務狀態；queue 為 `done` 時優先取 `result.status`。
- `queue_status`：原始佇列狀態，例如 `pending`、`running`、`done`、`failed`。
- `error`：優先取 `result.error`，否則取佇列錯誤。
- `result.ok`：支付業務是否成功。
- `result` 只公開白名單欄位：`ok`、`error`、`decline_code`、`charge_id`、`order_id`、`status`、`credits_cost`、`idempotent`。

成功判定必須同時滿足：

```text
status == "success" AND result.ok == true
```

絕對不可把 `queue_status=done` 當作支付成功；它只表示 Worker 已完成此次任務。

---

## 4.6 GET `/orders`

Scope：`orders:read`

Query：

- `page`：integer，預設 `1`。
- `size`：integer，預設 `20`。

```bash
curl "$BASE_URL/orders?page=1&size=20" \
  -H "Authorization: Bearer $GPTK"
```

成功回應：

```json
{
  "total": 35,
  "items": [
    {
      "id": 1201,
      "kind": "pay",
      "plan": "plus",
      "status": "success",
      "display_status": "success",
      "currency": "PHP",
      "amount_minor": 115000,
      "amount": "1150.00",
      "task_id": 501,
      "order_no": "20260814122500",
      "recharge_account": "user@example.com",
      "card_number": "•••• 4242",
      "attempt": 1,
      "topup_code": "user-code-prefix...",
      "fail_reason": null,
      "error_code": "",
      "auto_renew": true,
      "created_at": "2026-08-14 12:25:00",
      "settled_at": "2026-08-14 12:27:01",
      "duration_seconds": 121
    }
  ]
}
```

`page`／`size` 僅為查詢參數，回應不含這兩欄。`items[]` 欄位規則與 `GET /pay/orders/{order_id}` 相同。

---

## 4.7 POST `/orders/{order_id}/credentials`

Scope：`pay:write`

為 `requires_cvc`、`pending` 或 `system_error` 訂單補交 CVC／Session，並重新排入任務。

請求欄位：

- `cvc`：string，必填。
- `session`：object，可選，建議傳最新完整 Session。
- `ttl`：integer，預設 `900` 秒；實際回應有效期限制在 `30..3600` 秒。

```bash
curl -X POST "$BASE_URL/orders/1201/credentials" \
  -H "Authorization: Bearer $GPTK" \
  -H "Content-Type: application/json" \
  -d '{
    "cvc": "123",
    "session": {"access_token": "eyJ..."},
    "ttl": 900
  }'
```

成功：

```json
{
  "ok": true,
  "order_id": 1201,
  "expires_in": 900
}
```

常見錯誤：`order_not_found`、`credentials_not_supplementable`、`card_not_found`、`transient_secret_store_unavailable`。

---

# 5. 帳戶與權益

## 5.1 GET `/balance`

Scope：`balance:read`

```bash
curl "$BASE_URL/balance" \
  -H "Authorization: Bearer $GPTK"
```

```json
{
  "credits": 980,
  "balance": 1250,
  "balance_usd": "12.50"
}
```

- `credits`：可用積分整數。
- `balance`：USD 最小單位整數。
- `balance_usd`：USD 十進位字串。

---

## 5.2 GET `/entitlements`

Scope：`entitlements:read`

```bash
curl "$BASE_URL/entitlements" \
  -H "Authorization: Bearer $GPTK"
```

```json
[
  {
    "id": 18,
    "plan_id": 2,
    "status": "active",
    "starts_at": "2026-08-01T00:00:00+00:00",
    "expires_at": "2026-09-01T00:00:00+00:00",
    "auto_renew": false,
    "plan_name": "Monthly Pro"
  }
]
```

沒有權益時回空陣列 `[]`。

---

## 5.3 POST `/plans/credit/{plan_id}/purchase`

Scope：`plans:purchase`

目前停用，固定回：

```http
HTTP/1.1 403 Forbidden
```

```json
{"detail":"credit_purchase_disabled"}
```

積分請透過站內兌換碼取得。

---

## 5.4 POST `/plans/subscription/{plan_id}/purchase`

Scope：`plans:purchase`

目前停用，固定回：

```http
HTTP/1.1 403 Forbidden
```

```json
{"detail":"subscription_purchase_disabled"}
```

訂閱權益請透過站內兌換碼取得。

---

# 6. API Key 管理

## 6.1 GET `/api-keys`

Scope：`api_keys:read`

```bash
curl "$BASE_URL/api-keys" \
  -H "Authorization: Bearer $GPTK"
```

```json
[
  {
    "id": 8,
    "name": "KC-GPT-PAY",
    "prefix": "gptk_ab12cd",
    "scopes": ["plans:read", "pay:write", "tasks:read", "orders:read"],
    "created_at": "2026-08-14T04:00:00+00:00",
    "revoked_at": null,
    "last_used_at": "2026-08-14T04:25:00+00:00"
  }
]
```

列表僅回未撤銷的 API Key，且不回完整明文。

---

## 6.2 POST `/api-keys`

Scope：`api_keys:write`

請求欄位：

- `name`：string，可選。
- `scopes`：string array，可選；省略時採用後端預設完整使用者 Scope。

```bash
curl -X POST "$BASE_URL/api-keys" \
  -H "Authorization: Bearer $GPTK" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "KC-GPT-PAY",
    "scopes": ["plans:read", "pay:write", "tasks:read", "orders:read"]
  }'
```

```json
{
  "id": 9,
  "key": "gptk_full_secret_only_returned_once",
  "prefix": "gptk_ab12cd",
  "scopes": ["plans:read", "pay:write", "tasks:read", "orders:read"]
}
```

`key` 僅在這次回應出現，必須立即安全保存。

注意：若用目前 API Key 撤銷自己，後續請求會失敗。

---

## 6.3 DELETE `/api-keys/{key_id}`

Scope：`api_keys:write`

```bash
curl -X DELETE "$BASE_URL/api-keys/9" \
  -H "Authorization: Bearer $GPTK"
```

```json
{"ok":true}
```

成功後該密鑰立即失效，列表也不再返回。ID 不存在、已撤銷或不屬於目前帳號時回 `404`：

```json
{"detail":"api_key_not_found"}
```

---

# 7. 銀行卡

## 7.1 GET `/bank-cards`

Scope：`bank_cards:read`

```bash
curl "$BASE_URL/bank-cards" \
  -H "Authorization: Bearer $GPTK"
```

```json
[
  {
    "id": 12,
    "user_id": 10,
    "source": "self",
    "label": "Main card",
    "brand": "visa",
    "last4": "4242",
    "exp_month": 12,
    "exp_year": 2030,
    "cardholder_name": "API User",
    "country": "US",
    "billing_address": {},
    "status": "active",
    "requires_cvc": true,
    "failed_attempts": 0,
    "last_used_at": null,
    "balances": [
      {
        "currency": "USD",
        "amount_minor": 5000,
        "amount": "50.00",
        "display": "50.00 USD",
        "source": "manual",
        "checked_at": "2026-08-14T04:00:00+00:00",
        "usd_equivalent_minor": 5000,
        "usd_equivalent": "50.00",
        "fx_rate": "1",
        "fx_as_of": "2026-08-14T04:00:00+00:00"
      }
    ],
    "overall_status": "available",
    "total_usd_equivalent_minor": 5000,
    "total_usd_equivalent": "50.00",
    "spent_php": "0.00",
    "spent_usd": "0.00",
    "created_at": "2026-08-14T04:00:00+00:00",
    "updated_at": "2026-08-14T04:00:00+00:00"
  }
]
```

不回完整卡號與 CVC。

---

## 7.2 POST `/bank-cards`

Scope：`bank_cards:write`

請求欄位：

- `number`：string，必填。
- `exp_month`：integer，必填，`1..12`。
- `exp_year`：integer，必填。
- `name`：string，預設空。
- `country`：string，預設 `US`。
- `label`：string，預設空。
- `billing_address`：object，預設 `{}`。

CVC 不可在此接口保存。

```bash
curl -X POST "$BASE_URL/bank-cards" \
  -H "Authorization: Bearer $GPTK" \
  -H "Content-Type: application/json" \
  -d '{
    "number": "4242424242424242",
    "exp_month": 12,
    "exp_year": 2030,
    "name": "API User",
    "country": "US",
    "label": "Main card",
    "billing_address": {}
  }'
```

```json
{
  "ok": true,
  "id": 12,
  "requires_cvc": true
}
```

常見錯誤：`invalid_pan`、`invalid_expiry`、`card_already_exists`。

---

## 7.3 POST `/bank-cards/batch`

Scope：`bank_cards:write`

Body 是陣列，數量 `1..100`，每個 item 與 `POST /bank-cards` 相同。

```bash
curl -X POST "$BASE_URL/bank-cards/batch" \
  -H "Authorization: Bearer $GPTK" \
  -H "Content-Type: application/json" \
  -d '[
    {"number":"4242424242424242","exp_month":12,"exp_year":2030,"name":"A"},
    {"number":"4000000000000002","exp_month":11,"exp_year":2031,"name":"B"}
  ]'
```

```json
{
  "items": [
    {"index": 0, "ok": true, "id": 12, "requires_cvc": true},
    {"index": 1, "ok": false, "error": "invalid_card"}
  ],
  "succeeded": 1,
  "failed": 1
}
```

任何 item 含 `cvc`、`cvv` 或 `security_code` 時，該 item 回：

```json
{"index":0,"ok":false,"error":"payment_credential_not_allowed"}
```

批次接口以 item 級結果表示部分成功，不因單筆失敗回滾全部項目。

---

## 7.4 GET `/bank-cards/{card_id}`

Scope：`bank_cards:read`

```bash
curl "$BASE_URL/bank-cards/12" \
  -H "Authorization: Bearer $GPTK"
```

回應欄位與銀行卡列表 item 相同，包含遮罩資料、餘額、狀態與支出統計，不包含完整卡號及密文欄位。

不存在時：

```json
{"detail":"card_not_found"}
```

---

## 7.5 PUT `/bank-cards/{card_id}`

Scope：`bank_cards:write`

全部欄位均可選，只更新已提供欄位：

- `label`：string 或 null。
- `exp_month`：integer 或 null。
- `exp_year`：integer 或 null。
- `name`：string 或 null。
- `country`：string 或 null。
- `status`：只允許 `active` 或 `paused`。

```bash
curl -X PUT "$BASE_URL/bank-cards/12" \
  -H "Authorization: Bearer $GPTK" \
  -H "Content-Type: application/json" \
  -d '{"label":"Backup","status":"paused"}'
```

```json
{"ok":true}
```

---

## 7.6 DELETE `/bank-cards/{card_id}`

Scope：`bank_cards:write`

```bash
curl -X DELETE "$BASE_URL/bank-cards/12" \
  -H "Authorization: Bearer $GPTK"
```

```json
{"ok":true}
```

不存在或不屬於目前帳號時回 `{"ok":false}`。

---

## 7.7 POST `/bank-cards/cleanup`

Scope：`bank_cards:write`

批次刪除，最多處理前 100 個正整數 ID。

```bash
curl -X POST "$BASE_URL/bank-cards/cleanup" \
  -H "Authorization: Bearer $GPTK" \
  -H "Content-Type: application/json" \
  -d '{"ids":[12,13,99999]}'
```

```json
{
  "ok": true,
  "deleted": [12, 13],
  "skipped": [
    {"id": 99999, "reason": "card_not_found"}
  ]
}
```

---

## 7.8 GET `/bank-cards/{card_id}/balance`

Scope：`bank_cards:balance`

```bash
curl "$BASE_URL/bank-cards/12/balance" \
  -H "Authorization: Bearer $GPTK"
```

```json
{
  "balances": [
    {
      "currency": "USD",
      "amount_minor": 5000,
      "amount": "50.00",
      "display": "50.00 USD",
      "source": "manual",
      "checked_at": "2026-08-14T04:00:00+00:00",
      "usd_equivalent_minor": 5000,
      "usd_equivalent": "50.00",
      "fx_rate": "1",
      "fx_as_of": "2026-08-14T04:00:00+00:00"
    }
  ],
  "overall_status": "available",
  "total_usd_equivalent_minor": 5000,
  "total_usd_equivalent": "50.00"
}
```

`overall_status`：

- `available`：已知 USD 等值總額達平台門檻。
- `low`：已知 USD 等值總額低於門檻。
- `unknown`：沒有餘額或存在無法換算 USD 的貨幣。

---

## 7.9 PUT `/bank-cards/{card_id}/balance`

Scope：`bank_cards:balance`

請求欄位：

- `currency`：string，必填，3–8 個英文字母。
- `amount`：十進位字串，可選。
- `amount_minor`：integer，可選。
- `source`：string，預設 `manual`。
- `fx_rate`：正數字串，可選；非 USD／PHP 建議提供。
- `fx_as_of`：string 或 null，可選。

`amount` 與 `amount_minor` 至少提供一個；同時提供時優先使用 `amount`。

```bash
curl -X PUT "$BASE_URL/bank-cards/12/balance" \
  -H "Authorization: Bearer $GPTK" \
  -H "Content-Type: application/json" \
  -d '{
    "currency": "PHP",
    "amount": "2500.00",
    "source": "manual",
    "fx_rate": "0.016",
    "fx_as_of": "2026-08-14T12:00:00+08:00"
  }'
```

成功回應與 `GET /bank-cards/{card_id}/balance` 相同。

---

## 7.10 GET `/bank-cards/{card_id}/attempts`

Scope：`bank_cards:read`

最多回最近 50 筆支付嘗試。

```bash
curl "$BASE_URL/bank-cards/12/attempts" \
  -H "Authorization: Bearer $GPTK"
```

```json
[
  {
    "id": 88,
    "order_id": 1201,
    "outcome": "declined",
    "risk_score": null,
    "reason": "insufficient_funds",
    "created_at": "2026-08-14T04:27:01+00:00"
  }
]
```

---

# 8. 個人代理

## 8.1 GET `/proxy`

Scope：`proxy:read`

```bash
curl "$BASE_URL/proxy" \
  -H "Authorization: Bearer $GPTK"
```

未保存個人代理：

```json
{
  "mode": "default",
  "proxy": null
}
```

已保存：

```json
{
  "mode": "custom",
  "proxy": {
    "id": 5,
    "user_id": 10,
    "label": "user",
    "status": "active",
    "fail_count": 0,
    "proxy": "http://8.8.8.8:8080",
    "created_at": "2026-08-14 12:00:00",
    "last_test_at": "2026-08-14 12:01:00",
    "last_test_error": null
  }
}
```

回應中的代理已遮罩帳號密碼。

---

## 8.2 PUT `/proxy`

Scope：`proxy:write`

```bash
curl -X PUT "$BASE_URL/proxy" \
  -H "Authorization: Bearer $GPTK" \
  -H "Content-Type: application/json" \
  -d '{"proxy":"socks5://user:pass@8.8.8.8:1080"}'
```

```json
{"ok":true}
```

合法格式：

```text
http://user:pass@203.0.113.10:8080
https://user:pass@203.0.113.10:8443
socks5://user:pass@198.51.100.20:1080
```

主機必須是公網 IP（不可用域名）。禁止 localhost、內網 IP、無埠號及非允許 scheme。

---

## 8.3 DELETE `/proxy`

Scope：`proxy:write`

```bash
curl -X DELETE "$BASE_URL/proxy" \
  -H "Authorization: Bearer $GPTK"
```

```json
{"ok":true}
```

刪除後代充會回退到帳號 override 或平台代理池。

---

## 8.4 POST `/proxy/test`

Scope：`proxy:test`

測試請求中的代理：

```bash
curl -X POST "$BASE_URL/proxy/test" \
  -H "Authorization: Bearer $GPTK" \
  -H "Content-Type: application/json" \
  -d '{"proxy":"http://user:pass@8.8.8.8:8080"}'
```

測試已保存代理：

```bash
curl -X POST "$BASE_URL/proxy/test" \
  -H "Authorization: Bearer $GPTK" \
  -H "Content-Type: application/json" \
  -d '{}'
```

成功：

```json
{"ok":true,"error":null}
```

連線失敗仍通常回 HTTP `200`：

```json
{
  "ok": false,
  "error": "connection timeout"
}
```

客戶端必須檢查 body 的 `ok`，不能只看 HTTP `200`。測試目標目前是 `https://example.com`，只代表基本代理連通性，不代表 ChatGPT 一定不觸發 Cloudflare。

---

# 9. 虛擬卡申請

## 9.1 GET `/virtual-card-requests`

Scope：`virtual_cards:read`

```bash
curl "$BASE_URL/virtual-card-requests" \
  -H "Authorization: Bearer $GPTK"
```

```json
[
  {
    "id": 31,
    "provider_id": 2,
    "status": "pending",
    "note": "For GPT payment",
    "admin_note": null,
    "requested_at": "2026-08-14T04:00:00+00:00",
    "reviewed_at": null,
    "card_id": null
  }
]
```

---

## 9.2 POST `/virtual-card-requests`

Scope：`virtual_cards:write`

請求欄位：

- `provider_id`：integer，必填；必須是已啟用服務商。
- `note`：string，預設空。

```bash
curl -X POST "$BASE_URL/virtual-card-requests" \
  -H "Authorization: Bearer $GPTK" \
  -H "Content-Type: application/json" \
  -d '{"provider_id":2,"note":"For GPT payment"}'
```

```json
{
  "ok": true,
  "id": 31
}
```

功能關閉時回 `403 payment_cards_disabled`；服務商不可用時回 `400 card_provider_unavailable`。

---

## 9.3 GET `/virtual-card-requests/{request_id}`

Scope：`virtual_cards:read`

```bash
curl "$BASE_URL/virtual-card-requests/31" \
  -H "Authorization: Bearer $GPTK"
```

待審核：

```json
{
  "id": 31,
  "provider_id": 2,
  "status": "pending",
  "note": "For GPT payment",
  "admin_note": null,
  "requested_at": "2026-08-14T04:00:00+00:00",
  "reviewed_at": null,
  "card_id": null
}
```

審核後若已綁定卡，額外包含遮罩卡資料：

```json
{
  "id": 31,
  "provider_id": 2,
  "status": "approved",
  "note": "For GPT payment",
  "admin_note": "Approved",
  "requested_at": "2026-08-14T04:00:00+00:00",
  "reviewed_at": "2026-08-14T04:10:00+00:00",
  "card_id": 15,
  "card": {
    "id": 15,
    "user_id": 10,
    "source": "platform",
    "exp_month": 12,
    "exp_year": 2030,
    "name": "API User",
    "country": "US",
    "status": "idle",
    "last_charge_result": null,
    "provider_id": 2,
    "provider_ref": "provider-ref",
    "last4": "4242",
    "created_at": "2026-08-14 12:10:00"
  }
}
```

---

# 10. 冪等與重試規則

## 10.1 `Idempotency-Key` 生成

每一筆業務產生一個穩定值，例如：

```text
kc-cdk-ABC123
```

或 UUID：

```text
550e8400-e29b-41d4-a716-446655440000
```

同一筆業務所有重試必須沿用原值。不要附加每次重試時間戳，否則會建立不同訂單。

## 10.2 重試策略

- 建單請求超時但不確定服務端是否收到：使用相同 `Idempotency-Key`、相同 `plan_key`、`card_id` 與 `client_ref` 重試。
- 收到 `idempotent=true`：使用原 `order_id` 繼續輪詢。
- 收到 `already_submitted=true`：輪詢回傳的既有 `order_id`。
- 收到 `409 idempotency_conflict`：停止自動重試，產生新業務單號並人工核對原訂單。
- `400`／`401`／`403`／`404`／`409` 業務錯誤通常不應盲目重試。
- `5xx` 或網路錯誤可指數退避重試，但建單必須沿用冪等鍵。

## 10.3 建議輪詢

- 建單後 2–5 秒開始輪詢。
- 建議間隔 3–5 秒，不要高頻請求。
- 優先輪詢 `/pay/orders/{order_id}`。
- 到達終態後立即停止輪詢。
- 長時間無終態時保留訂單，不要直接再建一筆；先查原訂單或由人工處理。

偽代碼：

```javascript
const terminal = new Set([
  'success', 'failed', 'declined', 'system_error',
  'cancelled', 'stalled', 'manual'
]);

while (true) {
  const order = await getOrder(orderId);
  if (terminal.has(order.status)) {
    if (order.status === 'success') {
      // 開通成功
    } else {
      // 開通未成功，記錄 fail_reason / error_code
    }
    break;
  }
  await sleep(4000);
}
```

---

# 11. 完整 Node.js 對接示例

Node.js 18+：

```javascript
const BASE_URL = 'https://gogpt.id88.icu/api/v1';
const API_KEY = process.env.GPTK;

async function api(path, options = {}) {
  const response = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });

  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = data?.detail;
    const message = typeof detail === 'string'
      ? detail
      : JSON.stringify(detail ?? data ?? `HTTP ${response.status}`);
    throw new Error(`API ${response.status}: ${message}`);
  }
  return data;
}

async function submitAndWait({ planKey, session, card, proxy, businessId }) {
  const inspect = await api('/pay/inspect', {
    method: 'POST',
    body: JSON.stringify({ plan_key: planKey, session }),
  });
  if (!inspect.ok || !inspect.verified) {
    throw new Error(inspect.error || 'session_invalid');
  }

  const created = await api('/pay', {
    method: 'POST',
    headers: { 'Idempotency-Key': businessId },
    body: JSON.stringify({
      plan_key: planKey,
      new_card: card,
      session,
      proxy: proxy || undefined,
      client_ref: businessId,
    }),
  });

  if (!created.ok || !created.order_id) {
    throw new Error(created.error || 'pay_submit_failed');
  }

  const orderId = created.order_id;
  for (;;) {
    await new Promise(resolve => setTimeout(resolve, 4000));
    const order = await api(`/pay/orders/${orderId}`);
    const terminal = [
      'success', 'failed', 'declined', 'system_error',
      'cancelled', 'stalled', 'manual',
    ].includes(order.status);
    if (!terminal) continue;

    return {
      ok: order.status === 'success',
      orderId,
      status: order.status,
      error: order.fail_reason || null,
      order,
    };
  }
}
```

---

# 12. 完整 Python 對接示例

```python
import time
import requests

BASE_URL = "https://gogpt.id88.icu/api/v1"
API_KEY = "gptk_your_api_key"

session_http = requests.Session()
session_http.headers.update({
    "Authorization": f"Bearer {API_KEY}",
    "Content-Type": "application/json",
})


def api(method, path, **kwargs):
    response = session_http.request(method, BASE_URL + path, timeout=30, **kwargs)
    try:
        data = response.json()
    except ValueError:
        data = None
    if not response.ok:
        detail = data.get("detail") if isinstance(data, dict) else data
        raise RuntimeError(f"API {response.status_code}: {detail}")
    return data


def submit_and_wait(plan_key, chatgpt_session, card, business_id, proxy=None):
    inspect = api("POST", "/pay/inspect", json={
        "plan_key": plan_key,
        "session": chatgpt_session,
    })
    if not inspect.get("ok") or not inspect.get("verified"):
        raise RuntimeError(inspect.get("error") or "session_invalid")

    payload = {
        "plan_key": plan_key,
        "new_card": card,
        "session": chatgpt_session,
        "client_ref": business_id,
    }
    if proxy:
        payload["proxy"] = proxy

    created = api("POST", "/pay", headers={
        "Idempotency-Key": business_id,
    }, json=payload)
    order_id = created["order_id"]

    terminal = {
        "success", "failed", "declined", "system_error",
        "cancelled", "stalled", "manual",
    }
    while True:
        time.sleep(4)
        order = api("GET", f"/pay/orders/{order_id}")
        if order.get("status") not in terminal:
            continue
        return {
            "ok": order.get("status") == "success",
            "order_id": order_id,
            "status": order.get("status"),
            "error": order.get("fail_reason"),
            "order": order,
        }
```

---

# 13. 對接驗收清單

- [ ] Base URL 使用 `/api/v1`。
- [ ] 所有請求帶 `Authorization: Bearer gptk_...`。
- [ ] API Key Scope 覆蓋實際接口。
- [ ] 套餐 key 從 `GET /plans` 取得，不自行猜測。
- [ ] Session 傳完整 object，至少可解析 access token。
- [ ] `card_id` 與 `new_card` 嚴格二選一。
- [ ] 使用 `card_id` 時每次付款傳 CVC。
- [ ] `/pay` 每筆業務使用穩定 `Idempotency-Key`。
- [ ] 網路重試沿用原冪等鍵，不附加時間戳。
- [ ] 需要固定協議出口時在 `/pay` 傳合法 `proxy`。
- [ ] 不把 `/pay/inspect verified=true` 當作 ChatGPT 套餐驗證成功。
- [ ] 不把 `/pay ok=true` 當作開通成功。
- [ ] 不把任務 `queue_status=done` 當作開通成功。
- [ ] 只在訂單 `status=success`，或任務 `status=success && result.ok=true` 時報告成功。
- [ ] 失敗時保存 `order_id`、`task_id`、`status`、`fail_reason`／`error`，方便追蹤。
- [ ] 客戶端同時相容字串與陣列形式的 `detail`。
- [ ] 日誌不輸出 API Key、Session、PAN、CVC 或代理密碼。

---

# 14. 接口總表

| Method | Path | Scope | 說明 |
|---|---|---|---|
| GET | `/plans` | `plans:read` | 套餐列表 |
| POST | `/pay/inspect` | `pay:write` | Session 本機檢查 |
| POST | `/pay` | `pay:write` | 建立代充訂單 |
| GET | `/pay/orders/{order_id}` | `pay:write` | 輪詢單筆代充訂單 |
| GET | `/tasks/{task_id}` | `tasks:read` | 查詢任務及業務結果 |
| GET | `/orders` | `orders:read` | 訂單列表 |
| POST | `/orders/{order_id}/credentials` | `pay:write` | 補交 CVC／Session |
| GET | `/balance` | `balance:read` | 積分與 USD 餘額 |
| GET | `/entitlements` | `entitlements:read` | 訂閱權益 |
| POST | `/plans/credit/{plan_id}/purchase` | `plans:purchase` | 已停用的積分購買 |
| POST | `/plans/subscription/{plan_id}/purchase` | `plans:purchase` | 已停用的訂閱購買 |
| GET | `/api-keys` | `api_keys:read` | API Key 列表 |
| POST | `/api-keys` | `api_keys:write` | 建立 API Key |
| DELETE | `/api-keys/{key_id}` | `api_keys:write` | 撤銷 API Key |
| GET | `/bank-cards` | `bank_cards:read` | 銀行卡列表 |
| POST | `/bank-cards` | `bank_cards:write` | 建立銀行卡 |
| POST | `/bank-cards/batch` | `bank_cards:write` | 批次建立銀行卡 |
| GET | `/bank-cards/{card_id}` | `bank_cards:read` | 銀行卡詳情 |
| PUT | `/bank-cards/{card_id}` | `bank_cards:write` | 更新銀行卡 |
| DELETE | `/bank-cards/{card_id}` | `bank_cards:write` | 刪除銀行卡 |
| POST | `/bank-cards/cleanup` | `bank_cards:write` | 批次刪除銀行卡 |
| GET | `/bank-cards/{card_id}/balance` | `bank_cards:balance` | 查詢卡餘額 |
| PUT | `/bank-cards/{card_id}/balance` | `bank_cards:balance` | 寫入卡餘額 |
| GET | `/bank-cards/{card_id}/attempts` | `bank_cards:read` | 支付嘗試記錄 |
| GET | `/proxy` | `proxy:read` | 查詢個人代理 |
| PUT | `/proxy` | `proxy:write` | 保存個人代理 |
| DELETE | `/proxy` | `proxy:write` | 清除個人代理 |
| POST | `/proxy/test` | `proxy:test` | 測試代理 |
| GET | `/virtual-card-requests` | `virtual_cards:read` | 虛擬卡申請列表 |
| POST | `/virtual-card-requests` | `virtual_cards:write` | 建立虛擬卡申請 |
| GET | `/virtual-card-requests/{request_id}` | `virtual_cards:read` | 虛擬卡申請詳情 |
