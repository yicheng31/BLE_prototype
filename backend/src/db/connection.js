import pg from "pg";

export function createPool(connectionString, options = {}) {
  const pool = new pg.Pool({ connectionString, max: 10, connectionTimeoutMillis: 5000, ...options });
  // 閒置連線斷線不讓程序發生未處理事件；實際查詢錯誤仍會回傳給呼叫端。
  pool.on("error", error => console.error("PostgreSQL 連線中斷：", error.message));
  return pool;
}

export async function transaction(pool, action) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await action(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}
