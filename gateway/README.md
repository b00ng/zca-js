# Zalo Gateway

Dịch vụ HTTP bọc thư viện `zca-js` để các hệ thống nội bộ gửi tin nhắn Zalo tới **cá nhân** hoặc **nhóm**
qua một REST API đơn giản. Gateway chạy bằng Docker trên máy local và mở ra cho các ứng dụng khác qua **Tailscale**.

> [!WARNING]
> `zca-js` là API **không chính thức**. Nó giả lập Zalo Web trên một **tài khoản cá nhân**, nên tài khoản có thể bị Zalo
> giới hạn hoặc khoá. Nên:
> - Dùng một **tài khoản Zalo riêng cho bot**, không dùng tài khoản cá nhân quan trọng.
> - Chỉ dùng cho thông báo **nội bộ**: cảnh báo vận hành, báo cáo ca, nhắc việc trong nhóm.
> - Để gửi thông báo cho **khách hàng** (OTP, đơn hàng…), dùng kênh chính thức là **Zalo OA / ZNS**.

- Hướng dẫn tích hợp cho ứng dụng: [docs/INTEGRATION.md](docs/INTEGRATION.md)
- Đặc tả API (OpenAPI 3): [docs/openapi.yaml](docs/openapi.yaml)

---

## 1. Kiến trúc

```
 ┌──────────────────────┐   HTTPS (tailnet)    ┌──────────────────────────────┐   HTTPS / WSS   ┌──────────┐
 │ Ứng dụng vận hành    │ ───────────────────▶ │ zalo-gateway (Docker, local) │ ──────────────▶ │ Zalo Web │
 │ (cron, monitoring,   │  Bearer API key      │  • REST API  :8080           │                 └──────────┘
 │  ERP, n8n, ...)      │ ◀─────────────────── │  • Hàng đợi gửi + giãn cách  │
 └──────────────────────┘  webhook (tuỳ chọn)  │  • Lưu phiên vào volume /data│
                                               └──────────────────────────────┘
                         tailscale serve: https://<máy>.<tailnet>.ts.net  →  http://127.0.0.1:8080
```

- **Mỗi tài khoản Zalo chạy một container, và chỉ một bản.** Phiên đăng nhập có trạng thái, nên không scale ngang được.
- Mọi tin gửi đi đi qua **một hàng đợi tuần tự**, mặc định cách nhau 1,5–2,5 giây, để giảm nguy cơ bị khoá.
- Container chỉ mở cổng trên `127.0.0.1`. Ra ngoài máy thì **chỉ qua Tailscale**.

## 2. Yêu cầu

| Thành phần | Ghi chú |
|---|---|
| Docker Engine + Docker Compose **v2.24+** | `docker compose version` |
| Tailscale đã cài trên máy chạy gateway | Đã bật **MagicDNS** và **HTTPS Certificates** trong trang admin của Tailscale |
| 1 tài khoản Zalo (nên là tài khoản phụ) + điện thoại có app Zalo | Dùng để quét QR khi đăng nhập |
| Tài khoản bot phải **là thành viên** của các nhóm cần gửi tin | Với cá nhân: nên **kết bạn** trước, vì Zalo hạn chế tin nhắn gửi cho người lạ |

## 3. Cài đặt

```bash
git clone <repo-này> zca-js && cd zca-js/gateway

cp .env.example .env
# Tạo API key và điền vào API_KEY trong .env
openssl rand -hex 32

docker compose up -d --build
docker compose logs -f zalo-gateway
```

Kiểm tra:

```bash
curl http://127.0.0.1:8080/health          # {"status":"ok"}
curl http://127.0.0.1:8080/ready           # 503 cho tới khi đăng nhập Zalo xong
```

## 4. Đăng nhập Zalo lần đầu (quét QR)

**Cách 1 – Trình duyệt (dễ nhất):** mở `http://127.0.0.1:8080/login` trên máy chạy gateway, hoặc
`https://<máy>.<tailnet>.ts.net/login` sau khi đã làm bước 5. Nhập API key, bấm **Lấy mã QR**, rồi mở Zalo trên điện thoại
→ **Quét mã QR** → **Đăng nhập**.

**Cách 2 – Dòng lệnh:**

```bash
KEY=<API_KEY>
curl -s -X POST -H "Authorization: Bearer $KEY" http://127.0.0.1:8080/v1/auth/qr > /dev/null
curl -s -H "Authorization: Bearer $KEY" http://127.0.0.1:8080/v1/auth/qr.png -o qr.png   # mở qr.png và quét
curl -s -H "Authorization: Bearer $KEY" http://127.0.0.1:8080/v1/status                  # state = logged_in
```

- Mã QR hết hạn sau khoảng **100 giây**. Hết hạn thì gọi lại `POST /v1/auth/qr`.
- Phiên đăng nhập (cookie, imei, user agent) được lưu trong volume `zalo-data` (`/data/credentials.json`, quyền 600).
  Khởi động lại container **không cần quét lại**. Chỉ cần quét lại khi Zalo làm hết hạn phiên: lúc đó `/ready` trả 503 và
  `lastError` trong `/v1/status` có thông báo.
- Đổi sang tài khoản khác: gọi `POST /v1/auth/logout` rồi quét QR mới.

## 5. Mở gateway ra tailnet bằng Tailscale

### Cách A – `tailscale serve` trên máy host (khuyến nghị khi máy đã cài Tailscale)

```bash
sudo tailscale serve --bg --https=443 http://127.0.0.1:8080
tailscale serve status
# → https://<tên-máy>.<tailnet>.ts.net  (chứng chỉ HTTPS hợp lệ do Tailscale cấp, chỉ truy cập được trong tailnet)
```

Gỡ ra: `sudo tailscale serve --https=443 off`.

> [!CAUTION]
> **Không** dùng `tailscale funnel`, vì lệnh này mở dịch vụ ra Internet công cộng.

### Cách B – Gateway là một node riêng trong tailnet (sidecar container)

Dùng khi muốn gateway có tên riêng, ví dụ `zalo-gateway.<tailnet>.ts.net`, và ACL riêng, tách khỏi máy host.

1. Tạo auth key tại *Tailscale admin → Settings → Keys* (nên chọn *Reusable* và gắn tag `tag:zalo-gateway`).
2. Thêm vào `.env`:
   ```
   TS_AUTHKEY=tskey-auth-xxxx
   TS_HOSTNAME=zalo-gateway
   TS_EXTRA_ARGS=--advertise-tags=tag:zalo-gateway
   ```
3. Chạy:
   ```bash
   docker compose -f docker-compose.yml -f docker-compose.tailscale.yml up -d --build
   ```
   Gateway có địa chỉ `https://zalo-gateway.<tailnet>.ts.net`. Cấu hình HTTPS nằm trong `tailscale/serve.json`.

### Giới hạn quyền truy cập bằng ACL (nên làm)

Chỉ cho các máy chạy ứng dụng vận hành gọi tới gateway. Ví dụ trong *Access controls* của Tailscale:

```jsonc
{
  "tagOwners": {
    "tag:zalo-gateway": ["autogroup:admin"],
    "tag:ops-app":      ["autogroup:admin"]
  },
  "grants": [
    // các máy ứng dụng gọi được gateway qua HTTPS
    { "src": ["tag:ops-app"], "dst": ["tag:zalo-gateway"], "ip": ["tcp:443"] },
    // gateway gọi được webhook của ứng dụng (nếu dùng)
    { "src": ["tag:zalo-gateway"], "dst": ["tag:ops-app"], "ip": ["tcp:443", "tcp:80"] }
  ]
}
```

Với cách A, gắn `tag:zalo-gateway` cho chính máy host bằng `sudo tailscale up --advertise-tags=tag:zalo-gateway`.
Nếu máy host còn dùng cho việc khác, cân nhắc chuyển sang cách B.

## 6. Cấu hình (`.env`)

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `API_KEY` / `API_KEYS` | *(bắt buộc)* | Key cho ứng dụng gọi vào, mỗi key ≥ 24 ký tự. Nhiều key thì phân tách bằng dấu phẩy, tiện cho việc xoay vòng key hoặc cấp mỗi ứng dụng một key. |
| `ALIASES` | – | JSON `{ "ten": { "type": "group" \| "user", "id": "..." } }`. Ứng dụng gửi `"to": "ten"` mà không cần biết ID. |
| `ALIASES_FILE` | `/data/aliases.json` | Như `ALIASES` nhưng đọc từ file. `ALIASES` ghi đè lên file. |
| `SEND_MIN_INTERVAL_MS` | `1500` | Khoảng cách tối thiểu giữa hai lần gửi. |
| `SEND_JITTER_MS` | `1000` | Độ trễ ngẫu nhiên cộng thêm vào mỗi lần gửi. |
| `SEND_MAX_QUEUE` | `200` | Số tin tối đa chờ trong hàng đợi. Vượt quá thì trả `429`. |
| `SEND_TIMEOUT_MS` | `60000` | Thời gian chờ Zalo phản hồi cho mỗi tin. |
| `ATTACHMENT_MAX_MB` / `ATTACHMENT_MAX_COUNT` | `25` / `10` | Giới hạn file đính kèm. |
| `ATTACHMENT_ALLOW_URL` | `true` | Cho phép gateway tự tải file từ URL. |
| `BODY_MAX_MB` | `40` | Giới hạn kích thước body JSON. |
| `ENABLE_LISTENER` | `true` | Kết nối WebSocket để nhận tin đến. **Bắt buộc** nếu cần gửi file không phải ảnh (pdf, xlsx, mp4…), dùng webhook hoặc `/v1/threads/recent`. |
| `WEBHOOK_URL` / `WEBHOOK_SECRET` | – | Chuyển tin nhắn đến tới ứng dụng, có ký HMAC-SHA256. |
| `WEBHOOK_INCLUDE_SELF` | `false` | Có chuyển cả tin do chính tài khoản bot gửi hay không. |
| `LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` |
| `ZALO_LOGGING` | `false` | Bật log nội bộ của `zca-js` để debug. |
| `GATEWAY_HOST_PORT` | `8080` | Cổng trên `127.0.0.1` của máy host. |

Thay đổi `.env` → `docker compose up -d` để áp dụng.

## 7. Vận hành

| Việc | Lệnh / cách làm |
|---|---|
| Xem log | `docker compose logs -f --tail=200 zalo-gateway` |
| Cập nhật code / thư viện | `git pull && docker compose up -d --build` (phiên đăng nhập vẫn giữ trong volume) |
| Sao lưu phiên đăng nhập | `docker run --rm -v zalo-gateway_zalo-data:/data -v "$PWD":/bk alpine tar czf /bk/zalo-data.tgz -C /data .` |
| Giám sát | Ping `GET /ready` (không cần key): `200` là đang đăng nhập, `503` là cần quét QR lại |
| Trạng thái chi tiết | `GET /v1/status`: `state`, `listener`, `queueSize`, `lastError` |
| Nhiều tài khoản Zalo | Mỗi tài khoản một thư mục hoặc project riêng: `docker compose -p zalo-ops --env-file .env.ops up -d`, với `GATEWAY_HOST_PORT` khác nhau |

**Các điểm cần biết:**

- **Mỗi tài khoản chỉ có một phiên Zalo Web.** Nếu mở `chat.zalo.me` trên trình duyệt bằng tài khoản bot, listener của gateway
  sẽ bị ngắt (mã 3000). Gateway tự kết nối lại sau 5 phút, và lúc đó sẽ đẩy phiên trên trình duyệt ra. App Zalo trên điện thoại
  và PC không bị ảnh hưởng.
- Phiên đăng nhập được ghi lại vào volume mỗi giờ và khi container dừng. Gateway tự kiểm tra phiên mỗi 30 phút.
- File `/data/phone-cache.json` lưu kết quả tra cứu số điện thoại → user ID, vì Zalo giới hạn số lần tra cứu mỗi ngày.

## 8. Xử lý sự cố

| Hiện tượng | Nguyên nhân / cách xử lý |
|---|---|
| `503 NOT_LOGGED_IN` | Chưa đăng nhập hoặc phiên đã hết hạn → quét QR lại (mục 4). |
| `502 QR_LOGIN_FAILED` | Máy không ra được `id.zalo.me` / `chat.zalo.me`, hoặc QR hết hạn/bị từ chối. Kiểm tra mạng rồi gọi lại. |
| `503 LISTENER_REQUIRED` | Gửi file pdf/xlsx/mp4… cần listener: bật `ENABLE_LISTENER=true` và kiểm tra `listener` = `connected` trong `/v1/status`. |
| `429 QUEUE_FULL` | Ứng dụng gửi dồn dập quá. Gộp nhiều thông báo thành một tin, hoặc retry có backoff. |
| `502 ZALO_ERROR` | Zalo từ chối yêu cầu: không phải thành viên nhóm, người nhận chặn người lạ, nội dung bị cấm, tài khoản bị hạn chế… Xem `message`. |
| Listener `closed` liên tục | Có người đang mở Zalo Web bằng tài khoản bot → đóng tab đó. |
| Không truy cập được qua `*.ts.net` | Kiểm tra `tailscale serve status`, MagicDNS/HTTPS trong admin, ACL cho phép máy gọi, và máy gọi đã vào tailnet. |
