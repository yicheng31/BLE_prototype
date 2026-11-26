import fs from "node:fs/promises";
import path from "node:path";

export const publicRoot = path.resolve(import.meta.dirname, "../../../frontend/public");
const types = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };

// 提供 frontend/public 的靜態檔案；此模組不定義業務 API。
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
