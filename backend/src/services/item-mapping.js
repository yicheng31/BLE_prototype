// Caller serializes by canonical MAC and owns the transaction.
export async function resolveItem(client, reading) {
  await client.query("INSERT INTO tag (ble_id) VALUES ($1) ON CONFLICT DO NOTHING", [reading.ble_id]);
  const binding = (await client.query(`SELECT i.id AS item_id FROM tag t
    LEFT JOIN items i ON i.id=t.item_id AND i.deleted_at IS NULL
    WHERE t.ble_id=$1 FOR UPDATE OF t`, [reading.ble_id])).rows[0];
  // An observed label is not a registered item. Preserve its events until the
  // user explicitly binds this MAC to a meaningful item name via POST /api/items.
  // A deleted item's retained tag binding must not make it visible again.
  return { id: binding.item_id };
}
