import { HttpError } from "../errors.js";
import { itemRoutes } from "./items.js";
import { readingRoutes } from "./readings.js";

// 每條路由為 [method, pattern, handler]；pattern 的群組會解碼後放入 params。
export function createRouter({ items, readings }) {
  const routes = [...itemRoutes(items), ...readingRoutes(readings)];
  return async (req, res, url) => {
    for (const [method, pattern, handler] of routes) {
      if (method !== req.method) continue;
      const match = pattern.exec(url.pathname);
      if (match) return handler({ req, res, url, params: match.slice(1).map(decodeURIComponent) });
    }
    throw new HttpError(404, "NOT_FOUND", "找不到此 API");
  };
}
