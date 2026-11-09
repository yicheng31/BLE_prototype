import { demoItems } from "../data/demo-items.js";

const storageKey = "rfid-lost-found.reports.v1";
const clone = value => structuredClone(value);

// 前端資料接點：未來接 API 時替換此層，頁面不需直接依賴硬體 JSON 或接口。
export function createItemService({ storage, now = () => new Date(), makeId = () => crypto.randomUUID() } = {}) {
  const getStorage = () => {
    const target = storage === undefined ? globalThis.localStorage : storage;
    if (!target || typeof target.getItem !== "function" || typeof target.setItem !== "function") {
      throw new Error("無法使用本機儲存空間，請確認瀏覽器允許網站儲存資料。");
    }
    return target;
  };

  function readReports() {
    try {
      const saved = getStorage().getItem(storageKey);
      if (saved === null) return [];
      const rows = JSON.parse(saved);
      if (!Array.isArray(rows) || rows.length > demoItems.length || new Set(rows.map(row => row?.itemId)).size !== rows.length || rows.some(row =>
        !row || typeof row.id !== "string" || !row.id ||
        !demoItems.some(item => item.id === row.itemId && item.name === row.itemName && item.tagUid === row.tagUid) ||
        typeof row.description !== "string" || row.description.length > 500 ||
        typeof row.reportedAt !== "string" || !Number.isFinite(Date.parse(row.reportedAt)))) {
        throw new Error("Invalid stored reports");
      }
      return rows;
    } catch {
      throw new Error("本機遺失回報資料無法讀取。請檢查瀏覽器儲存設定，原有資料尚未被覆寫。");
    }
  }

  async function listItems() {
    const reportedIds = new Set(readReports().map(report => report.itemId));
    return demoItems.map(item => ({ ...clone(item), status: reportedIds.has(item.id) ? "lost" : item.status }));
  }

  async function searchItems(query = "") {
    if (typeof query !== "string") throw new Error("請輸入物品名稱或標籤 UID。");
    const keyword = query.trim().toLocaleLowerCase("zh-TW");
    return (await listItems()).filter(item => !keyword || item.name.toLocaleLowerCase("zh-TW").includes(keyword) || item.tagUid.toLowerCase().includes(keyword));
  }

  async function getItem(id) {
    return (await listItems()).find(item => item.id === id) || null;
  }

  async function reportLost(input) {
    if (!input || typeof input !== "object" || Array.isArray(input) || typeof input.itemId !== "string" || !input.itemId.trim()) {
      throw new Error("請先選擇要回報遺失的物品。");
    }
    const item = demoItems.find(row => row.id === input.itemId.trim());
    if (!item) throw new Error("找不到這件物品，請重新選擇。");
    const description = input.description === undefined ? "" : input.description;
    if (typeof description !== "string" || description.trim().length > 500) throw new Error("遺失說明最多 500 字。");
    const reports = readReports();
    const existing = reports.find(row => row.itemId === item.id);
    if (existing) return { ...clone(existing), alreadyReported: true };
    const report = { id: makeId(), itemId: item.id, itemName: item.name, tagUid: item.tagUid,
      description: description.trim(), reportedAt: now().toISOString() };
    try { getStorage().setItem(storageKey, JSON.stringify([...reports, report])); }
    catch { throw new Error("遺失回報尚未儲存，可能是瀏覽器儲存空間不足或儲存權限被停用。"); }
    return { ...clone(report), alreadyReported: false };
  }

  return { listItems, searchItems, getItem, reportLost };
}

const service = createItemService();
export const listItems = () => service.listItems();
export const searchItems = query => service.searchItems(query);
export const getItem = id => service.getItem(id);
export const reportLost = input => service.reportLost(input);
