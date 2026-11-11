import { randomUUID } from "node:crypto";
import { HttpError, object, text, tag } from "../errors.js";
import { transaction } from "../db/connection.js";

const selectItems = `SELECT i.id, i.item_name, t.ble_id, i.category, i.icon,
  CASE WHEN l.id IS NULL THEN 'normal' ELSE 'lost' END AS status,
  r.gate_id, r.location, r.last_seen_at, r.item_name AS broadcast_name, r.rssi, r.timestamp
  FROM items i JOIN tag t ON t.item_id=i.id LEFT JOIN lost_reports l ON l.item_id = i.id
  LEFT JOIN LATERAL (SELECT gate_id, location, last_seen_at, item_name, rssi, timestamp FROM gates_event
    WHERE ble_id = t.ble_id ORDER BY last_seen_at DESC, id DESC LIMIT 1) r ON TRUE`;
const iso = value => value instanceof Date ? value.toISOString() : value;
function itemDto(row) {
  return { id: row.id, item_name: row.item_name, ble_id: row.ble_id.toLowerCase(), category: row.category, icon: row.icon, status: row.status,
    last_seen: row.last_seen_at ? { gate_id: row.gate_id, location: row.location, received_at: iso(row.last_seen_at), item_name: row.broadcast_name || row.item_name, ble_id: row.ble_id.toLowerCase(), rssi: row.rssi, timestamp: row.timestamp === null ? null : Number(row.timestamp) } : null };
}

export class ItemsService {
  constructor(pool, now = () => new Date()) { this.pool = pool; this.now = now; }
  async list({ q = "", lost } = {}) {
    q = text(q, "q", 200, true);
    if (lost !== undefined && !["true", "false"].includes(lost)) throw new HttpError(400, "INVALID_QUERY", "lost 必須是 true 或 false");
    const rows = await this.pool.query(`${selectItems} WHERE
      ($1 = '' OR strpos(lower(i.item_name), lower($1)) > 0 OR strpos(lower(t.ble_id), lower($1)) > 0)
      AND ($2::boolean IS NULL OR (l.id IS NOT NULL) = $2::boolean) ORDER BY i.id`, [q, lost === undefined ? null : lost === "true"]);
    return rows.rows.map(itemDto);
  }
  async get(id) {
    const { rows } = await this.pool.query(`${selectItems} WHERE i.id = $1`, [id]);
    return rows[0] ? itemDto(rows[0]) : null;
  }
  async create(payload) {
    object(payload);
    const item = { id: randomUUID(), item_name: text(payload.item_name, "item_name"), ble_id: tag(payload.ble_id).toLowerCase(),
      category: payload.category === undefined ? "" : text(payload.category, "category", 100, true),
      icon: payload.icon === undefined ? "backpack" : text(payload.icon, "icon", 30) };
    if (!/^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(item.ble_id)) throw new HttpError(400, "INVALID_FIELD", "ble_id 必須是 BLE MAC 位址");
    if (!["backpack", "laptop", "bottle", "umbrella"].includes(item.icon)) throw new HttpError(400, "INVALID_FIELD", "icon 不支援此值");
    try {
      await transaction(this.pool, async client => {
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [item.ble_id]);
        const existing = (await client.query("SELECT item_id FROM tag WHERE ble_id=$1 FOR UPDATE", [item.ble_id])).rows[0];
        if (existing?.item_id) throw new HttpError(409, "TAG_ALREADY_EXISTS", "這張標籤已登記物品");
        await client.query("INSERT INTO items (id,item_name,category,icon) VALUES ($1,$2,$3,$4)", [item.id,item.item_name,item.category,item.icon]);
        await client.query("INSERT INTO tag (ble_id,item_id) VALUES ($1,$2) ON CONFLICT (ble_id) DO UPDATE SET item_id=EXCLUDED.item_id", [item.ble_id,item.id]);
      });
    } catch (error) {
      if (error.code === "23505") throw new HttpError(409, "TAG_ALREADY_EXISTS", "這張標籤已登記物品");
      throw error;
    }
    return this.get(item.id);
  }
  async report(id, payload) {
    object(payload);
    const description = payload.description === undefined ? "" : payload.description;
    if (typeof description !== "string" || description.trim().length > 500 || description.includes("\u0000")) {
      throw new HttpError(400, "INVALID_FIELD", "遺失說明必須是不超過 500 字的文字");
    }
    return transaction(this.pool, async client => {
      const item = (await client.query("SELECT i.id,i.item_name,t.ble_id FROM items i JOIN tag t ON t.item_id=i.id WHERE i.id=$1", [id])).rows[0];
      if (!item) throw new HttpError(404, "ITEM_NOT_FOUND", "找不到這件物品");
      const created = await client.query(`INSERT INTO lost_reports (id,item_id,description,reported_at)
        VALUES ($1,$2,$3,$4) ON CONFLICT (item_id) DO NOTHING RETURNING *`, [randomUUID(),id,description.trim(),this.now().toISOString()]);
      const row = created.rows[0] || (await client.query("SELECT * FROM lost_reports WHERE item_id = $1", [id])).rows[0];
      return { id: row.id, item_id: item.id, item_name: item.item_name, ble_id: item.ble_id.toLowerCase(),
        description: row.description, reported_at: iso(row.reported_at), already_reported: created.rowCount === 0 };
    });
  }
}
