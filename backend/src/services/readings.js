import { createHash } from "node:crypto";
import { transaction } from "../db/connection.js";
import { normalizeReading, toInternalReading } from "../readings/normalize.js";
import { HttpError, text } from "../errors.js";
import { resolveItem } from "./item-mapping.js";

export class ReadingsService {
  constructor(pool, dedupeWindowMs = 3000, now = () => new Date()) {
    this.pool = pool; this.dedupeWindowMs = dedupeWindowMs; this.now = now;
  }
  async record(payload, { event_id } = {}) {
    const read = normalizeReading(payload);
    const eventId = event_id === undefined ? null : text(event_id, "Idempotency-Key", 128);
    const fingerprint = createHash("sha256").update(JSON.stringify(read)).digest("hex");
    return transaction(this.pool, async client => {
      if (eventId !== null) {
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
          [JSON.stringify(["event", read.gate_id, eventId])]);
        const prior = (await client.query(
          "SELECT payload_hash,response_json FROM reading_requests WHERE gate_id=$1 AND event_id=$2",
          [read.gate_id, eventId])).rows[0];
        if (prior) {
          if (prior.payload_hash !== fingerprint) throw new HttpError(409, "EVENT_ID_CONFLICT", "同一閘門的事件識別碼不可對應不同內容");
          if (!prior.response_json) throw new HttpError(409, "LEGACY_EVENT_ID", "此識別碼已用於舊版事件，請使用新的事件識別碼");
          return { ...prior.response_json, duplicate: true, reason: "event_retry" };
        }
      }
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [read.ble_id]);
      const item = await resolveItem(client, read);
      await client.query("INSERT INTO gates (gate_id,location) VALUES ($1,$2) ON CONFLICT (gate_id) DO UPDATE SET location=EXCLUDED.location",
        [read.gate_id, read.location]);
      const received = this.now();
      const internal = toInternalReading(read, received);
      const latest = (await client.query("SELECT * FROM gates_event WHERE lower(ble_id)=$1 ORDER BY last_seen_at DESC,id DESC LIMIT 1", [read.ble_id])).rows[0];
      const repeat = latest && latest.gate_id === read.gate_id && latest.location === read.location && received - latest.last_seen_at >= 0 && received - latest.last_seen_at < this.dedupeWindowMs;
      const fields = [read.ble_id, read.gate_id, read.location, read.item_name, read.rssi, read.timestamp, internal.received_at];
      const row = repeat
        ? (await client.query("UPDATE gates_event SET ble_id=$1,gate_id=$2,location=$3,item_name=$4,rssi=$5,timestamp=$6,last_seen_at=$7,read_count=read_count+1 WHERE id=$8 RETURNING *", [...fields, latest.id])).rows[0]
        : (await client.query("INSERT INTO gates_event (ble_id,gate_id,location,item_name,rssi,timestamp,first_seen_at,last_seen_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$7) RETURNING *", fields)).rows[0];
      const response = { ...internal, id: row.id, item_id: item.id, first_seen_at: row.first_seen_at.toISOString(),
        read_count: row.read_count, duplicate: Boolean(repeat), reason: repeat ? "repeat_read" : null };
      if (eventId !== null) await client.query(
        "INSERT INTO reading_requests (gate_id,event_id,payload_hash,reading_id,response_json) VALUES ($1,$2,$3,$4,$5)",
        [read.gate_id, eventId, fingerprint, row.id, JSON.stringify(response)]
      );
      return response;
    });
  }
}
