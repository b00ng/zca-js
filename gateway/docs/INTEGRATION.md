# Hướng dẫn tích hợp Zalo Gateway

Tài liệu cho đội phát triển ứng dụng vận hành cần gửi thông báo Zalo tới **một người** hoặc **một nhóm chung**.
Phần triển khai gateway xem tại [../README.md](../README.md). Đặc tả máy đọc được nằm ở [openapi.yaml](openapi.yaml).

---

## 1. Thông tin kết nối

| | |
|---|---|
| Base URL | `https://<máy-gateway>.<tailnet>.ts.net` (qua Tailscale). Máy gọi phải nằm trong tailnet và được ACL cho phép. |
| Xác thực | Header `Authorization: Bearer <API_KEY>` (hoặc `X-API-Key: <API_KEY>`) |
| Định dạng | JSON UTF-8 (`Content-Type: application/json`) |
| Chống gửi trùng | Header `Idempotency-Key: <chuỗi duy nhất>` (khuyến nghị, có hiệu lực 24 giờ) |

Mỗi ứng dụng nên dùng **một API key riêng**: khai báo nhiều key trong `API_KEYS=key1,key2` để thu hồi từng key được.

## 2. Luồng tích hợp khuyến nghị

```
(1) Lấy ID nhóm / người nhận  ──▶  (2) Đặt alias trong .env của gateway  ──▶  (3) Ứng dụng gửi tin theo alias
```

Gửi theo **alias** (ví dụ `"to": "ops-alerts"`) giúp ứng dụng không phụ thuộc ID của Zalo. Khi đổi nhóm, chỉ cần sửa cấu hình
gateway, không phải sửa code ứng dụng.

### 2.1. Tìm ID nhóm

Tài khoản bot phải **là thành viên** của nhóm.

```bash
curl -s -H "Authorization: Bearer $KEY" $GW/v1/groups
```

```json
{
  "groups": [
    { "id": "5432109876543210987", "name": "Vận hành - Cảnh báo", "totalMember": 18, "isAdmin": false }
  ]
}
```

Cách khác: nhắn một tin bất kỳ vào nhóm, rồi xem danh sách hội thoại gần đây (cần listener đang bật):

```bash
curl -s -H "Authorization: Bearer $KEY" $GW/v1/threads/recent
```

### 2.2. Tìm ID người nhận

```bash
# Danh sách bạn bè của tài khoản bot
curl -s -H "Authorization: Bearer $KEY" $GW/v1/friends

# Tra theo số điện thoại (kết quả được cache; Zalo giới hạn số lần tra mỗi ngày)
curl -s -H "Authorization: Bearer $KEY" "$GW/v1/users/lookup?phone=0912345678"
# → { "uid": "1234567890123456789", "displayName": "Nguyễn Văn A", "zaloName": "A Nguyễn" }
```

> [!IMPORTANT]
> Zalo hạn chế tin nhắn gửi cho **người lạ**: người nhận có thể đã tắt nhận tin từ người lạ, và gửi nhiều tin cho người lạ dễ
> làm tài khoản bị khoá. Hãy **kết bạn** giữa tài khoản bot và những người cần nhận tin cá nhân.

### 2.3. Khai báo alias

Trong `gateway/.env`:

```env
ALIASES={"ops-alerts":{"type":"group","id":"5432109876543210987"},"truong-ca":{"type":"user","id":"1234567890123456789"}}
```

hoặc file `/data/aliases.json` trong volume (cùng cấu trúc). Sau đó chạy `docker compose up -d`.
Kiểm tra lại bằng `GET /v1/aliases`.

## 3. Gửi tin nhắn — `POST /v1/messages`

### 3.1. Tham số

| Trường | Kiểu | Bắt buộc | Mô tả |
|---|---|---|---|
| `to` | `string` hoặc `object` | ✔ | Alias (`"ops-alerts"`), hoặc `{ "type": "group", "id": "..." }`, `{ "type": "user", "id": "..." }`, `{ "type": "user", "phone": "09..." }` |
| `text` | `string` | ✔* | Nội dung, xuống dòng bằng `\n`. *Có thể bỏ trống nếu có `attachments`. |
| `mentionAll` | `boolean` | | **Chỉ nhóm.** Thêm `@All` vào đầu tin và thông báo tới mọi thành viên. |
| `mentions` | `array` | | **Chỉ nhóm.** `[{ "uid": "...", "pos": 0, "len": 6 }]`: `pos`/`len` là vị trí đoạn `@Tên` trong `text`. |
| `urgency` | `string` | | `default` \| `important` (Quan trọng) \| `urgent` (Khẩn cấp) |
| `ttl` | `number` | | Tin tự xoá sau số mili giây này. |
| `attachments` | `array` | | `[{ "url": "https://..." }]` hoặc `[{ "base64": "...", "filename": "bao-cao.pdf" }]`, tối đa 10 file, mỗi file ≤ 25MB. Ảnh (jpg/png/webp/gif) gửi được luôn; file khác cần listener đang bật. |

### 3.2. Kết quả

```json
{
  "to": { "type": "group", "id": "5432109876543210987", "alias": "ops-alerts" },
  "messageId": "7340012345678",
  "attachmentIds": [],
  "sentAt": "2026-10-08T02:15:04.120Z"
}
```

API trả kết quả **sau khi** Zalo đã nhận tin. Nếu hàng đợi đang có nhiều tin, thời gian chờ sẽ dài hơn (≈ 2 giây × số tin đứng trước).
Ứng dụng nên đặt client timeout **≥ 90 giây**.

### 3.3. Ví dụ

**Gửi vào nhóm chung, gắn thẻ tất cả, mức khẩn cấp:**

```bash
curl -s -X POST $GW/v1/messages \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -H "Idempotency-Key: incident-2026-10-08-0042" \
  -d '{
    "to": "ops-alerts",
    "text": "🔴 [P1] API thanh toán lỗi 5xx > 20%\nBắt đầu: 09:12\nRunbook: https://wiki/runbook/payment",
    "mentionAll": true,
    "urgency": "urgent"
  }'
```

**Gửi cho một cá nhân theo ID:**

```bash
curl -s -X POST $GW/v1/messages \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{ "to": { "type": "user", "id": "1234567890123456789" }, "text": "Ca đêm nay bạn trực hệ thống kho." }'
```

**Gửi cho một cá nhân theo số điện thoại:**

```bash
curl -s -X POST $GW/v1/messages \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{ "to": { "type": "user", "phone": "0912345678" }, "text": "Đơn #A123 đã giao xong." }'
```

**Gửi ảnh biểu đồ kèm chú thích vào nhóm:**

```bash
curl -s -X POST $GW/v1/messages \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{
    "to": "ops-alerts",
    "text": "Báo cáo doanh thu ngày 07/10",
    "attachments": [{ "url": "https://grafana.internal/render/d/abc?width=1000&height=500", "filename": "doanh-thu.png" }]
  }'
```

**Gắn thẻ một người trong nhóm:** `pos`/`len` trỏ đúng đoạn `@Lan` trong `text`.

```json
{ "to": "ops-alerts", "text": "@Lan kiểm tra giúp job ETL nhé", "mentions": [{ "uid": "1234567890123456789", "pos": 0, "len": 4 }] }
```

## 4. Mã lỗi và chiến lược retry

Mọi lỗi có dạng:

```json
{ "error": { "code": "NOT_LOGGED_IN", "message": "…" } }
```

| HTTP | `code` | Ý nghĩa | Retry? |
|---|---|---|---|
| 400 | `BAD_REQUEST` | Thiếu hoặc sai tham số, file không hợp lệ | ✘ sửa request |
| 401 | `UNAUTHORIZED` | Sai hoặc thiếu API key | ✘ |
| 404 | `UNKNOWN_ALIAS`, `USER_NOT_FOUND`, `NOT_FOUND` | Alias không tồn tại, số điện thoại không có Zalo | ✘ |
| 409 | `ALREADY_LOGGED_IN` | (auth) đã đăng nhập | ✘ |
| 413 | `ATTACHMENT_TOO_LARGE`, `BODY_TOO_LARGE` | File quá lớn | ✘ |
| 429 | `QUEUE_FULL` | Hàng đợi gửi đầy | ✔ backoff |
| 502 | `ZALO_ERROR`, `ATTACHMENT_DOWNLOAD_FAILED` | Zalo từ chối hoặc lỗi tạm thời; không tải được file | ✔ tối đa 2–3 lần (nếu lỗi lặp lại, xem `message`) |
| 503 | `NOT_LOGGED_IN`, `LISTENER_REQUIRED` | Gateway chưa sẵn sàng; cần admin quét QR lại | ✔ chậm (phút), **đồng thời báo admin** |
| 504 | `SEND_TIMEOUT` | Zalo không phản hồi kịp | ⚠ tin **có thể đã được gửi**, nên retry với cùng `Idempotency-Key` |

**Khuyến nghị:**

1. Luôn gửi `Idempotency-Key`, ví dụ `"<loại-sự-kiện>-<id-nghiệp-vụ>"`. Khi retry thì dùng **cùng key**: nếu lần trước đã gửi
   thành công, gateway trả lại kết quả cũ (header `Idempotent-Replayed: true`) và không gửi lại. Cache này nằm trong bộ nhớ,
   nên sẽ mất khi gateway khởi động lại.
2. Retry với exponential backoff (2s, 4s, 8s…) chỉ cho `429`, `502`, `503`, `504`.
3. Đừng gọi gateway đồng bộ trong luồng nghiệp vụ quan trọng. Hãy ghi thông báo vào bảng/hàng đợi **outbox**, rồi để một worker
   gửi và retry. Như vậy Zalo có trục trặc cũng không làm nghẽn hệ thống chính.

## 5. Giới hạn và thực hành tốt

- **Thông lượng**: khoảng 25–40 tin/phút cho mỗi tài khoản, do hàng đợi giãn cách để tránh bị khoá. Đừng tăng giãn cách quá thấp.
- **Gộp tin**: thay vì 50 cảnh báo rời, hãy gửi 1 tin tổng hợp (digest) mỗi 1–5 phút.
- **Tránh spam cá nhân**: chỉ gửi cho người đã kết bạn. Không gửi hàng loạt tin giống hệt nhau cho nhiều người.
- **Nội dung**: văn bản thuần, emoji và `\n` hoạt động bình thường. Link được Zalo tự tạo preview.
- **Bảo mật**: không nhúng API key vào frontend hoặc app di động. Chỉ gọi từ backend trong tailnet.
- **Sẵn sàng**: kiểm tra `GET /ready` (không cần key) trong hệ thống monitoring để biết khi nào phải quét QR lại.

## 6. Code mẫu

### 6.1. Node.js / TypeScript (Node ≥ 18, không cần thư viện)

```ts
// zalo-client.ts
type Recipient = string | { type: "user" | "group"; id?: string; phone?: string };

export class ZaloGatewayClient {
    constructor(private baseUrl: string, private apiKey: string) {}

    async send(
        to: Recipient,
        text: string,
        opts: { mentionAll?: boolean; urgency?: "default" | "important" | "urgent"; idempotencyKey?: string;
                attachments?: Array<{ url?: string; base64?: string; filename?: string }> } = {},
    ) {
        const { idempotencyKey, ...rest } = opts;
        const body = JSON.stringify({ to, text, ...rest });
        const retryable = new Set([429, 502, 503, 504]);

        for (let attempt = 0; ; attempt++) {
            const res = await fetch(`${this.baseUrl}/v1/messages`, {
                method: "POST",
                headers: {
                    authorization: `Bearer ${this.apiKey}`,
                    "content-type": "application/json",
                    ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
                },
                body,
                signal: AbortSignal.timeout(90_000),
            });
            const data = await res.json();
            if (res.ok) return data as { messageId: string | null; sentAt: string };
            if (!retryable.has(res.status) || attempt >= 3) {
                throw new Error(`Zalo gateway ${res.status} ${data.error?.code}: ${data.error?.message}`);
            }
            await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
        }
    }
}

// Sử dụng
const zalo = new ZaloGatewayClient(process.env.ZALO_GW_URL!, process.env.ZALO_GW_KEY!);

// Gửi vào nhóm chung
await zalo.send("ops-alerts", "✅ Backup DB hoàn tất lúc 02:00", { idempotencyKey: "backup-2026-10-08" });

// Gửi cho cá nhân
await zalo.send({ type: "user", id: "1234567890123456789" }, "Bạn có 3 phiếu chờ duyệt.");
```

### 6.2. Python (`requests`)

```python
# zalo_client.py
import os, time, requests

class ZaloGatewayClient:
    RETRYABLE = {429, 502, 503, 504}

    def __init__(self, base_url: str, api_key: str):
        self.base_url = base_url.rstrip("/")
        self.session = requests.Session()
        self.session.headers.update({"Authorization": f"Bearer {api_key}"})

    def send(self, to, text: str = "", *, mention_all=False, urgency=None,
             attachments=None, idempotency_key=None, max_retries=3):
        payload = {"to": to, "text": text, "mentionAll": mention_all}
        if urgency:
            payload["urgency"] = urgency
        if attachments:
            payload["attachments"] = attachments
        headers = {"Idempotency-Key": idempotency_key} if idempotency_key else {}

        for attempt in range(max_retries + 1):
            r = self.session.post(f"{self.base_url}/v1/messages", json=payload, headers=headers, timeout=90)
            if r.ok:
                return r.json()
            if r.status_code not in self.RETRYABLE or attempt == max_retries:
                err = r.json().get("error", {})
                raise RuntimeError(f"Zalo gateway {r.status_code} {err.get('code')}: {err.get('message')}")
            time.sleep(2 * 2 ** attempt)


zalo = ZaloGatewayClient(os.environ["ZALO_GW_URL"], os.environ["ZALO_GW_KEY"])

# Nhóm chung, gắn thẻ tất cả
zalo.send("ops-alerts", "🔴 Kho HN: tồn kho SKU-123 dưới ngưỡng", mention_all=True, urgency="important",
          idempotency_key="stock-low-SKU-123-2026-10-08")

# Cá nhân theo số điện thoại
zalo.send({"type": "user", "phone": "0912345678"}, "Ca trực của bạn bắt đầu lúc 22:00.")

# Gửi file Excel (cần listener đang bật)
import base64
with open("bao-cao.xlsx", "rb") as f:
    zalo.send("ops-alerts", "Báo cáo tuần",
              attachments=[{"base64": base64.b64encode(f.read()).decode(), "filename": "bao-cao.xlsx"}])
```

### 6.3. Công cụ no-code (n8n, Make, Zapier self-hosted…)

Dùng node **HTTP Request**:

- Method `POST`, URL `https://<gateway>.ts.net/v1/messages`
- Header `Authorization: Bearer <API_KEY>`
- Body JSON: `{"to": "ops-alerts", "text": "{{ $json.message }}"}`

Máy chạy n8n phải nằm trong tailnet.

## 7. Nhận tin nhắn đến (webhook, tuỳ chọn)

Dùng khi muốn người dùng trả lời hoặc ra lệnh trong nhóm Zalo, ví dụ `ack 42` để xác nhận một sự cố.

Cấu hình trong `.env` của gateway:

```env
ENABLE_LISTENER=true
WEBHOOK_URL=https://my-ops-app.<tailnet>.ts.net/zalo/webhook
WEBHOOK_SECRET=<openssl rand -hex 32>
```

Gateway sẽ `POST` tới `WEBHOOK_URL` với mỗi tin nhắn đến:

```http
POST /zalo/webhook
Content-Type: application/json
X-Zalo-Gateway-Event: message
X-Zalo-Gateway-Event-Id: 1b4e28ba-2fa1-11d2-883f-0016d3cca427
X-Zalo-Gateway-Timestamp: 1791345304
X-Zalo-Gateway-Signature: sha256=<hex HMAC-SHA256(secret, "<timestamp>.<raw body>")>
```

```json
{
  "event": "message",
  "eventId": "1b4e28ba-2fa1-11d2-883f-0016d3cca427",
  "receivedAt": "2026-10-08T02:15:04.120Z",
  "thread": { "type": "group", "id": "5432109876543210987" },
  "sender": { "id": "1234567890123456789", "name": "Lan" },
  "isSelf": false,
  "messageId": "7340012345678",
  "msgType": "webchat",
  "text": "ack 42",
  "content": "ack 42",
  "timestamp": 1791345304000
}
```

- `text` là `null` với tin không phải văn bản (ảnh, sticker, file…). Khi đó xem `content` và `msgType`.
- Trả về HTTP `2xx` trong vòng 5 giây. Nếu lỗi, gateway retry 3 lần (1s, 2s, 4s) với **cùng `eventId`**, nên hãy loại trùng
  theo `eventId`.
- **Luôn xác minh chữ ký** và từ chối request có timestamp lệch quá 5 phút.

**Xác minh chữ ký – Node.js (Express):**

```ts
import crypto from "node:crypto";
import express from "express";

const app = express();
app.post("/zalo/webhook", express.raw({ type: "application/json" }), (req, res) => {
    const ts = req.header("x-zalo-gateway-timestamp") ?? "";
    const sig = req.header("x-zalo-gateway-signature") ?? "";
    const expected = "sha256=" + crypto.createHmac("sha256", process.env.ZALO_WEBHOOK_SECRET!)
        .update(`${ts}.${req.body.toString("utf8")}`).digest("hex");
    const fresh = Math.abs(Date.now() / 1000 - Number(ts)) < 300;
    if (!fresh || sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
        return res.sendStatus(401);
    }
    const event = JSON.parse(req.body.toString("utf8"));
    // xử lý bất đồng bộ (đẩy vào queue), trả 200 ngay
    res.sendStatus(200);
});
```

**Xác minh chữ ký – Python (Flask):**

```python
import hmac, hashlib, os, time
from flask import Flask, request, abort

app = Flask(__name__)

@app.post("/zalo/webhook")
def zalo_webhook():
    ts = request.headers.get("X-Zalo-Gateway-Timestamp", "")
    sig = request.headers.get("X-Zalo-Gateway-Signature", "")
    body = request.get_data()
    expected = "sha256=" + hmac.new(os.environ["ZALO_WEBHOOK_SECRET"].encode(),
                                    f"{ts}.".encode() + body, hashlib.sha256).hexdigest()
    if abs(time.time() - int(ts or 0)) > 300 or not hmac.compare_digest(sig, expected):
        abort(401)
    event = request.get_json()
    # ... xử lý
    return "", 200
```

## 8. Checklist trước khi đưa vào vận hành

- [ ] Tài khoản bot là tài khoản riêng, đã vào đủ các nhóm và đã kết bạn với người nhận cá nhân.
- [ ] Đã khai báo alias cho các nhóm và người nhận chính. Ứng dụng gửi theo alias.
- [ ] Mỗi ứng dụng có API key riêng, lưu trong secret manager và không commit vào git.
- [ ] Đã giới hạn ACL Tailscale, chỉ máy ứng dụng gọi được gateway. Không dùng Funnel.
- [ ] Ứng dụng có outbox/retry, gửi `Idempotency-Key`, và có client timeout ≥ 90 giây.
- [ ] Monitoring theo dõi `GET /ready` và cảnh báo qua kênh **khác Zalo** (email, Slack…) khi cần quét QR lại.
- [ ] Đã sao lưu volume `zalo-data`.
