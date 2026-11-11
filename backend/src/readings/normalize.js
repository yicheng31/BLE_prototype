import { HttpError, object, text } from "../errors.js";

// Six-field contract from johnjohn1207/lost-property-radar.
export function normalizeReading(payload) {
  object(payload);
  const ble_id = text(payload.ble_id, "ble_id", 17).toLowerCase();
  if (!/^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(ble_id)) throw new HttpError(400, "INVALID_FIELD", "ble_id 必須是冒號分隔的 BLE MAC 位址");
  if (!Number.isInteger(payload.rssi) || payload.rssi < -127 || payload.rssi > 20) throw new HttpError(400, "INVALID_FIELD", "rssi 必須是 -127～20 的整數");
  if (!Number.isInteger(payload.timestamp) || payload.timestamp < 0 || payload.timestamp > 4294967295) throw new HttpError(400, "INVALID_FIELD", "timestamp 必須是 0～4294967295 的開機累計毫秒");
  return { gate_id: text(payload.gate_id, "gate_id", 64), location: text(payload.location, "location", 200),
    item_name: text(payload.item_name, "item_name", 100), ble_id, rssi: payload.rssi, timestamp: payload.timestamp };
}

// Internal record adds server receipt time without interpreting ESP32 uptime as a date.
export function toInternalReading(payload, receivedAt) {
  const reading = normalizeReading(payload);
  if (!(receivedAt instanceof Date) || !Number.isFinite(receivedAt.getTime())) {
    throw new Error("Invalid server receipt time");
  }
  return { ...reading, received_at: receivedAt.toISOString() };
}
