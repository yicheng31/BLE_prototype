import { loadEnvFile } from "node:process";
import path from "node:path";
import { isIP } from "node:net";

export function loadEnvironment() {
  try { loadEnvFile(path.resolve(import.meta.dirname, "../.env")); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
}

export function loadConfig(env = process.env) {
  function integer(name, fallback, minimum, maximum) {
    const value = env[name] ? Number(env[name]) : fallback;
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`${name} 必須是 ${minimum}～${maximum} 的整數`);
    return value;
  }
  const databaseUrl = env.DATABASE_URL || "postgresql://rfid:rfid_dev_password@127.0.0.1:5432/rfid";
  const protocol = new URL(databaseUrl).protocol;
  if (!["postgres:", "postgresql:"].includes(protocol)) throw new Error("DATABASE_URL 必須是 PostgreSQL 連線網址");
  const host = env.HOST || "127.0.0.1";
  if (host !== "localhost" && !isIP(host)) throw new Error("HOST 必須是 IP 位址或 localhost");
  return { host, databaseUrl, port: integer("PORT", 3000, 1, 65535), dedupeWindowMs: integer("DEDUPE_WINDOW_MS", 3000, 100, 600000) };
}
