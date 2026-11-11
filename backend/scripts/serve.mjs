import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const publicRoot = path.resolve(import.meta.dirname, "../../frontend/public");
const types = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };

// 靜態檔案處理共用於後端；此模組本身不定義業務 API。
export function createStaticHandler(root = publicRoot) {
  const base = path.resolve(root);
  return async (req, res) => {
    if (!["GET", "HEAD"].includes(req.method)) {
      res.writeHead(405, { Allow: "GET, HEAD" }); return res.end("此為前端開發伺服器。");
    }
    let filename;
    try {
      const pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
      filename = path.resolve(base, "." + (pathname === "/" ? "/index.html" : pathname));
      if (filename !== base && !filename.startsWith(base + path.sep)) throw new Error("outside public");
    } catch { res.writeHead(400); return res.end("Invalid path"); }
    try {
      const bytes = await fs.readFile(filename);
      res.writeHead(200, { "Content-Type": `${types[path.extname(filename)] || "application/octet-stream"}; charset=utf-8`,
        "Content-Length": bytes.length, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
      res.end(req.method === "HEAD" ? undefined : bytes);
    } catch (error) {
      res.writeHead(error.code === "ENOENT" || error.code === "EISDIR" ? 404 : 500);
      res.end("找不到前端檔案。");
    }
  };
}

export function createStaticServer(root = publicRoot) { return http.createServer(createStaticHandler(root)); }

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const port = Number(process.env.FRONTEND_PORT || 5500);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT 必須是 1～65535 的整數");
  const server = createStaticServer();
  server.on("error", error => { console.error(`前端伺服器啟動失敗：${error.message}`); process.exitCode = 1; });
  server.listen(port, "127.0.0.1", () => console.log(`前端已啟動：http://localhost:${port}`));
  process.on("SIGINT", () => server.close());
  process.on("SIGTERM", () => server.close());
}
