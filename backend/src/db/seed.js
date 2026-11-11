import { createPool, transaction } from "./connection.js";
import { migrate } from "./migrate.js";
import { loadConfig, loadEnvironment } from "../config.js";

loadEnvironment();
const pool = createPool(loadConfig().databaseUrl);
try {
  await migrate(pool);
  const samples = [
    ["item-001", "深藍色後背包", "02:00:00:00:00:01", "隨身物品", "backpack"],
    ["item-002", "灰色筆電包", "02:00:00:00:00:02", "電子配件", "laptop"],
    ["item-003", "保溫瓶", "02:00:00:00:00:03", "生活用品", "bottle"],
    ["item-004", "黑色雨傘", "02:00:00:00:00:04", "生活用品", "umbrella"]
  ];
  const added = await transaction(pool, async client => {
    let count = 0;
    for (const row of samples) {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [row[2]]);
      const existing = (await client.query("SELECT item_id FROM tag WHERE ble_id=$1", [row[2]])).rows[0];
      if (existing?.item_id) continue;
      const result = await client.query("INSERT INTO items (id,item_name,category,icon) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING", [row[0],row[1],row[3],row[4]]);
      // A reused sample item ID may already have a different historical tag.
      await client.query("INSERT INTO tag (ble_id,item_id) SELECT $1,$2 WHERE NOT EXISTS (SELECT 1 FROM tag WHERE item_id=$2) ON CONFLICT DO NOTHING", [row[2],row[0]]);
      count += result.rowCount;
    }
    return count;
  });
  console.log(`新增 ${added} 件測試物品；沒有寫入示範位置或遺失紀錄。`);
} catch (error) { console.error("示範登記失敗：", error.message); process.exitCode = 1; }
finally { await pool.end(); }
