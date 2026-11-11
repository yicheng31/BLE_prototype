import http from "node:http";
import { loadEnvironment, loadConfig } from "./config.js";
import { createPool } from "./db/connection.js";
import { migrate } from "./db/migrate.js";
import { createApp } from "./app.js";

loadEnvironment();
const config = loadConfig();
const pool = createPool(config.databaseUrl);
try {
  await migrate(pool);
  const server = http.createServer(createApp({ pool, dedupeWindowMs: config.dedupeWindowMs }));
  let stopping = false;
  function stop() {
    if (stopping) return;
    stopping = true;
    server.close(() => { void pool.end(); });
  }
  server.on("error", error => {
    console.error("後端啟動失敗：", error.message);
    void pool.end(); process.exitCode = 1;
  });
  server.listen(config.port, config.host, () => console.log(`BLE 前端與 API 已啟動：http://localhost:${config.port}`));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
} catch (error) {
  console.error("後端啟動失敗，請確認 PostgreSQL 已執行及 DATABASE_URL 設定：", error.message);
  await pool.end(); process.exitCode = 1;
}
