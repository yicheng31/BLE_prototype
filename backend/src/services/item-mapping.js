// 呼叫端須已依標準化 MAC 加鎖，並負責交易。
export async function resolveItem(client, reading) {
  await client.query("INSERT INTO tag (ble_id) VALUES ($1) ON CONFLICT DO NOTHING", [reading.ble_id]);
  const binding = (await client.query(`SELECT i.id AS item_id FROM tag t
    LEFT JOIN items i ON i.id=t.item_id AND i.deleted_at IS NULL
    WHERE t.ble_id=$1 FOR UPDATE OF t`, [reading.ble_id])).rows[0];
  // 被感應到的標籤不等於已登記物品；保留其事件，直到使用者
  // 透過 POST /api/items 明確綁定名稱。
  // 已刪除物品保留的標籤綁定不可讓它重新出現。
  return { id: binding.item_id };
}
