/**
 * @Author: Your name
 * @Date:   2026-11-10 10:15:39
 * @Last Modified by:   Your name
 * @Last Modified time: 2026-11-10 10:23:14
 */
export class HttpError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

export function object(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "INVALID_BODY", "請提供 JSON 物件");
  return value;
}

export function text(value, name, maximum = 100, allowEmpty = false) {
  if (typeof value !== "string" || value.trim().length > maximum || (!allowEmpty && !value.trim()) || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new HttpError(400, "INVALID_FIELD", `${name} 必須是${allowEmpty ? "不超過" : "1~"}${maximum} 字的文字`);
  }
  return value.trim();
}

export function tag(value) { return text(value, "ble_id", 128).toUpperCase(); }
