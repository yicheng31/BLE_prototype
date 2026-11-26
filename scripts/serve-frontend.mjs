// 只提供前端靜態檔案（不含 API），供前端獨立開發使用。
import http from "node:http";
import { createStaticHandler } from "../backend/src/http/static.js";

const port = Number(process.env.FRONTEND_PORT || 5500);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("FRONTEND_PORT 必須是 1～65535 的整數");
const server = http.createServer(createStaticHandler());
server.on("error", error => { console.error(`前端伺服器啟動失敗：${error.message}`); process.exitCode = 1; });
server.listen(port, "127.0.0.1", () => console.log(`前端已啟動：http://localhost:${port}`));
process.on("SIGINT", () => server.close());
process.on("SIGTERM", () => server.close());
