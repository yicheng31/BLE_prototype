import { randomUUID } from "node:crypto";

// Caller serializes by canonical MAC and owns the transaction.
export async function resolveItem(client, reading) {
  await client.query("INSERT INTO tag (ble_id) VALUES ($1) ON CONFLICT DO NOTHING", [reading.ble_id]);
  const binding = (await client.query("SELECT item_id FROM tag WHERE ble_id=$1 FOR UPDATE", [reading.ble_id])).rows[0];
  if (binding.item_id) return { id: binding.item_id };
  const id = randomUUID();
  await client.query("INSERT INTO items (id,item_name,category) VALUES ($1,$2,'BLE 標籤')", [id, reading.item_name]);
  await client.query("UPDATE tag SET item_id=$2 WHERE ble_id=$1", [reading.ble_id, id]);
  return { id };
}
