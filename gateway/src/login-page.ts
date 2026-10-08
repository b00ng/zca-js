/** Minimal admin page to scan the login QR code from a browser. The API key never goes into a URL. */
export const LOGIN_PAGE = `<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Zalo Gateway Login</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 420px; margin: 40px auto; padding: 0 16px; color: #1f2937; }
  input, button { font: inherit; padding: 8px 12px; width: 100%; box-sizing: border-box; margin-top: 8px; }
  button { cursor: pointer; background: #0068ff; color: #fff; border: 0; border-radius: 6px; }
  #qr { margin-top: 16px; width: 100%; image-rendering: pixelated; display: none; border: 1px solid #e5e7eb; }
  pre { background: #f3f4f6; padding: 12px; border-radius: 6px; white-space: pre-wrap; word-break: break-word; }
</style>
</head>
<body>
<h2>Zalo Gateway — đăng nhập</h2>
<label>API key <input id="key" type="password" autocomplete="off"></label>
<button id="go">Lấy mã QR</button>
<img id="qr" alt="QR code">
<pre id="out">Nhập API key rồi bấm "Lấy mã QR". Mở Zalo trên điện thoại → Quét mã QR.</pre>
<script>
const $ = (id) => document.getElementById(id);
$("key").value = sessionStorage.getItem("zgw-key") || "";
let timer;
async function call(method, path) {
  const key = $("key").value.trim();
  sessionStorage.setItem("zgw-key", key);
  const res = await fetch(path, { method, headers: { authorization: "Bearer " + key } });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ? data.error.code + ": " + data.error.message : res.status);
  return data;
}
async function poll() {
  try {
    const s = await call("GET", "/v1/status");
    $("out").textContent = JSON.stringify(s, null, 2);
    if (s.state === "logged_in") { $("qr").style.display = "none"; clearInterval(timer); }
    if (s.state === "logged_out") { clearInterval(timer); }
  } catch (e) { $("out").textContent = String(e); clearInterval(timer); }
}
$("go").onclick = async () => {
  clearInterval(timer);
  $("out").textContent = "Đang tạo mã QR...";
  try {
    const r = await call("POST", "/v1/auth/qr");
    $("qr").src = "data:image/png;base64," + r.qr.imageBase64;
    $("qr").style.display = "block";
    $("out").textContent = "Quét mã trước " + new Date(r.qr.expiresAt).toLocaleTimeString();
    timer = setInterval(poll, 2000);
  } catch (e) { $("out").textContent = String(e); }
};
</script>
</body>
</html>
`;
