import { HttpError } from "./errors.js";
import { handleCors } from "./http/cors.js";
import { sendJson } from "./http/json.js";
import { createStaticHandler } from "./http/static.js";
import { createRouter } from "./routes/index.js";
import { ItemsService } from "./services/items.js";
import { ReadingsService } from "./services/readings.js";

export function createApp({ pool, dedupeWindowMs = 3000, now = () => new Date() }) {
  const route = createRouter({
    items: new ItemsService(pool, now),
    readings: new ReadingsService(pool, dedupeWindowMs, now)
  });
  const serveStatic = createStaticHandler();
  return async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      if (!url.pathname.startsWith("/api/")) return await serveStatic(req, res);
      if (handleCors(req, res)) return;
      await route(req, res, url);
    } catch (error) {
      if (res.headersSent) { res.end(); return; }
      if (error instanceof URIError) return sendJson(res, 400, { error: "網址格式錯誤", code: "INVALID_URL" });
      if (error instanceof HttpError) return sendJson(res, error.status, { error: error.message, code: error.code });
      console.error("API 處理失敗：", error.message);
      sendJson(res, 500, { error: "資料處理失敗，請確認 PostgreSQL 連線", code: "INTERNAL_ERROR" });
    }
  };
}
