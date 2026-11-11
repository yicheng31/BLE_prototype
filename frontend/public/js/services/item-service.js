/**
 * @Author: Your name
 * @Date:   2026-11-09 23:56:13
 * @Last Modified by:   Your name
 * @Last Modified time: 2026-11-11 14:24:03
 */
import { API_BASE_URL } from "../config.js";

const validId = value => (typeof value === "string" && value.trim().length > 0) || (Number.isSafeInteger(value) && value > 0);
const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);

function apiError(message, { status = 0, code = "API_ERROR", cause } = {}) {
  const error = new Error(message, cause === undefined ? undefined : { cause });
  error.status = status;
  error.code = code;
  return error;
}

function invalidResponse(method, status) {
  return apiError(method === "POST"
    ? "後端回報結果格式不正確，無法確認儲存結果。請確認後端服務後重試，同一物品不會重複新增回報。"
    : "後端資料格式不正確。請確認 API_BASE_URL 指向正確的後端服務。", { status, code: "INVALID_RESPONSE" });
}

function isItem(item) {
  return isObject(item) && validId(item.id) &&
    [item.item_name, item.ble_id, item.category, item.icon].every(value => typeof value === "string") &&
    ["normal", "lost"].includes(item.status) &&
    (item.last_seen === null || (isObject(item.last_seen) &&
      [item.last_seen.gate_id, item.last_seen.location, item.last_seen.received_at].every(value => typeof value === "string") &&
      Number.isFinite(Date.parse(item.last_seen.received_at)) &&
      typeof item.last_seen.item_name === "string" && typeof item.last_seen.ble_id === "string" &&
      (item.last_seen.rssi === null || (Number.isInteger(item.last_seen.rssi) && item.last_seen.rssi >= -127 && item.last_seen.rssi <= 20)) &&
      (item.last_seen.timestamp === null || (Number.isInteger(item.last_seen.timestamp) && item.last_seen.timestamp >= 0 && item.last_seen.timestamp <= 4294967295))));
}

function isReport(report) {
  return isObject(report) && validId(report.id) && validId(report.item_id) &&
    [report.item_name, report.ble_id, report.description, report.reported_at].every(value => typeof value === "string") &&
    Number.isFinite(Date.parse(report.reported_at)) && typeof report.already_reported === "boolean";
}

// 僅負責既定軟體 API；不依賴 RFID 的原始 JSON、傳輸方式或硬體接收接口。
// 失敗時直接回報錯誤，不用本機資料或示例資料代替後端。
export function createItemService({ baseUrl = API_BASE_URL, fetchImpl = (...args) => globalThis.fetch(...args) } = {}) {
  if (typeof baseUrl !== "string" || !baseUrl.trim()) throw new Error("請在 API_BASE_URL 設定後端根網址。");
  let parsedBase;
  try { parsedBase = new URL(baseUrl.trim()); }
  catch { throw new Error("API_BASE_URL 必須是有效的 HTTP 或 HTTPS 後端根網址。"); }
  if (!["http:", "https:"].includes(parsedBase.protocol) || parsedBase.search || parsedBase.hash || parsedBase.username || parsedBase.password) {
    throw new Error("API_BASE_URL 必須是 HTTP 或 HTTPS 後端根網址，不可包含查詢參數、帳密或片段。");
  }
  if (typeof fetchImpl !== "function") throw new Error("無法使用網路連線功能，請使用支援 fetch 的瀏覽器。");
  const root = parsedBase.href.replace(/\/+$/, "");

  async function request(path, { method = "GET", body, allowNotFound = false } = {}) {
    let response;
    try {
      response = await fetchImpl(`${root}${path}`, {
        method,
        headers: { Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        cache: "no-store",
        signal: AbortSignal.timeout(10000)
      });
    } catch (cause) {
      throw apiError(method === "POST"
        ? `無法確認回報是否完成儲存。請確認後端 ${root} 已啟動、API_BASE_URL 設定與跨來源連線正常後重試；同一物品不會重複新增回報。`
        : `無法連線至後端 ${root}。請確認後端已啟動、API_BASE_URL 設定正確，並允許目前頁面的跨來源連線。`,
      { code: "BACKEND_UNAVAILABLE", cause });
    }
    if (allowNotFound && response.status === 404) return null;
    let data;
    try { data = await response.json(); }
    catch { throw invalidResponse(method, response.status); }
    if (!response.ok) {
      throw apiError(typeof data?.error === "string" && data.error ? data.error : `後端處理失敗（HTTP ${response.status}）。`,
        { status: response.status, code: typeof data?.code === "string" ? data.code : "API_ERROR" });
    }
    return data;
  }

  async function listItems() {
    const items = await request("/api/items");
    if (!Array.isArray(items) || !items.every(isItem)) throw invalidResponse("GET", 200);
    return items;
  }

  async function searchItems(query = "") {
    if (typeof query !== "string") throw new Error("請輸入物品名稱或 BLE MAC 文字。");
    const keyword = query.trim();
    const queryString = keyword ? `?${new URLSearchParams({ q: keyword })}` : "";
    const items = await request(`/api/items${queryString}`);
    if (!Array.isArray(items) || !items.every(isItem)) throw invalidResponse("GET", 200);
    return items;
  }

  async function getItem(id) {
    if (!validId(id)) throw new Error("請提供有效的物品編號。");
    const item = await request(`/api/items/${encodeURIComponent(String(id).trim())}`, { allowNotFound: true });
    if (item !== null && !isItem(item)) throw invalidResponse("GET", 200);
    return item;
  }

  async function reportLost(input) {
    if (!isObject(input) || !validId(input.item_id)) throw new Error("請先選擇要回報遺失的物品。");
    const description = input.description === undefined ? "" : input.description;
    if (typeof description !== "string" || description.trim().length > 500) throw new Error("遺失說明必須是文字，最多 500 字。");
    const report = await request(`/api/items/${encodeURIComponent(String(input.item_id).trim())}/lost`, {
      method: "POST", body: { description: description.trim() }
    });
    if (!isReport(report) || String(report.item_id) !== String(input.item_id).trim()) throw invalidResponse("POST", 200);
    return report;
  }

  return { listItems, searchItems, getItem, reportLost };
}

const service = createItemService();
export const listItems = () => service.listItems();
export const searchItems = query => service.searchItems(query);
export const getItem = id => service.getItem(id);
export const reportLost = input => service.reportLost(input);
