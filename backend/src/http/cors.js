import { HttpError } from "../errors.js";

const LOCAL_ORIGIN = /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/;

// 允許同主機與本機 Live Server 的不同埠連到後端；不開放任意外部網站。
// 回傳 true 表示已回應 OPTIONS 預檢請求。
export function handleCors(req, res) {
  const origin = req.headers.origin;
  if (origin) {
    let sameHost = false;
    try {
      const source = new URL(origin);
      sameHost = ["http:", "https:"].includes(source.protocol) && source.origin === origin && source.hostname === new URL("http://" + req.headers.host).hostname;
    } catch { /* 無效來源交由下方拒絕。 */ }
    if (!sameHost && !LOCAL_ORIGIN.test(origin)) {
      throw new HttpError(403, "ORIGIN_NOT_ALLOWED", "此來源不允許呼叫本機 API");
    }
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  if (req.method === "OPTIONS") {
    res.writeHead(204, { "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Idempotency-Key" });
    res.end();
    return true;
  }
  return false;
}
