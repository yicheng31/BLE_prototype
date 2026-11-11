import fs from "node:fs/promises";
import { transaction, createPool } from "./connection.js";
import { loadEnvironment, loadConfig } from "../config.js";
import { pathToFileURL } from "node:url";
import path from "node:path";

export async function migrate(pool) {
  const schema = await fs.readFile(new URL("./schema.sql", import.meta.url), "utf8");
  await transaction(pool, async client => {
    await client.query("SELECT pg_advisory_xact_lock(76833001)");
    await client.query(schema);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  loadEnvironment();
  const pool = createPool(loadConfig().databaseUrl);
  try { await migrate(pool); console.log("PostgreSQL 資料表已建立，不清空既有資料。"); }
  catch (error) { console.error("建立資料表失敗：", error.message); process.exitCode = 1; }
  finally { await pool.end(); }
}
