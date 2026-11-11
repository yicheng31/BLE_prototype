import { createStaticHandler } from "../scripts/serve.mjs";
import { HttpError, object } from "./errors.js";
import { ItemsService } from "./services/items.js";
import { ReadingsService } from "./services/readings.js";

function json(res, status, value) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(value));
}

function readJson(req) {
  if (!/^application\/json(?:\s*;|\s*$)/i.test(req.headers["content-type"] || "")) {
    req.resume();
    return Promise.reject(new HttpError(415, "JSON_REQUIRED", "請使用 Content-Type: application/json"));
  }
  return new Promise((resolve, reject) => {
    const chunks = []; let length = 0; let tooLarge = false;
    req.on("data", chunk => {
      length += chunk.length;
      if (length > 16384) {
        if (!tooLarge) reject(new HttpError(413, "BODY_TOO_LARGE", "JSON 超過 16KB"));
        tooLarge = true; chunks.length = 0;
      } else if (!tooLarge) chunks.push(chunk);
    });
    req.on("end", () => {
      if (tooLarge) return;
      try { resolve(object(JSON.parse(Buffer.concat(chunks).toString("utf8")))); }
      catch (error) { reject(error instanceof HttpError ? error : new HttpError(400, "INVALID_JSON", "JSON 格式錯誤")); }
    });
    req.on("error", reject);
    req.on("aborted", () => reject(new HttpError(400, "REQUEST_ABORTED", "請求已中斷")));
  });
}

export function createApp({ pool, dedupeWindowMs = 3000, now = () => new Date() }) {
  const items = new ItemsService(pool, now);
  const readings = new ReadingsService(pool, dedupeWindowMs, now);
  const serveStatic = createStaticHandler();
  return async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      const pathname = url.pathname;
      if (!pathname.startsWith("/api/")) return await serveStatic(req, res);
      // 允許本機 Live Server 的不同埠連到後端；不開放任意外部網站。
      const origin = req.headers.origin;
      if (origin) {
        let sameHost = false;
        try {
          const source = new URL(origin);
          sameHost = ["http:", "https:"].includes(source.protocol) && source.origin === origin && source.hostname === new URL("http://" + req.headers.host).hostname;
        } catch { /* Reject invalid origins below. */ }
        if (!sameHost && !/^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(origin)) {
          throw new HttpError(403, "ORIGIN_NOT_ALLOWED", "此來源不允許呼叫本機 API");
        }
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Vary", "Origin");
      }
      if (req.method === "OPTIONS") {
        res.writeHead(204, { "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Idempotency-Key" });
        return res.end();
      }
      if (pathname === "/api/items" && req.method === "GET") {
        return json(res, 200, await items.list({ q: url.searchParams.get("q") || "", lost: url.searchParams.get("lost") ?? undefined }));
      }
      if (pathname === "/api/items" && req.method === "POST") {
        return json(res, 201, await items.create(await readJson(req)));
      }
      const itemRoute = /^\/api\/items\/([^/]+)$/.exec(pathname);
      if (itemRoute && req.method === "GET") {
        const item = await items.get(decodeURIComponent(itemRoute[1]));
        if (!item) throw new HttpError(404, "ITEM_NOT_FOUND", "找不到這件物品");
        return json(res, 200, item);
      }
      const lostRoute = /^\/api\/items\/([^/]+)\/lost$/.exec(pathname);
      if (lostRoute && req.method === "POST") {
        const report = await items.report(decodeURIComponent(lostRoute[1]), await readJson(req));
        return json(res, report.already_reported ? 200 : 201, report);
      }
      // Both routes accept the upstream firmware's unchanged six-field JSON.
      if (["/api/readings", "/api/events"].includes(pathname) && req.method === "POST") {
        const reading = await readings.record(await readJson(req), { event_id: req.headers["idempotency-key"] });
        return json(res, 200, { status: "SUCCESS", ...reading });
      }
      throw new HttpError(404, "NOT_FOUND", "找不到此 API");
    } catch (error) {
      if (res.headersSent) { res.end(); return; }
      if (error instanceof URIError) return json(res, 400, { error: "網址格式錯誤", code: "INVALID_URL" });
      if (error instanceof HttpError) return json(res, error.status, { error: error.message, code: error.code });
      console.error("API 處理失敗：", error.message);
      json(res, 500, { error: "資料處理失敗，請確認 PostgreSQL 連線", code: "INTERNAL_ERROR" });
    }
  };
}
