import { listItems, searchItems, getItem, reportLost } from "./services/item-service.js";

const $ = id => document.getElementById(id);
const state = { items: [], results: [], selectedId: null, selectedItem: null, query: "", reportItemId: null, requestVersion: 0, submitting: false };
const iconPaths = {
  backpack: ["M17 13V9a7 7 0 0 1 14 0v4", "M12 13h24v29H12z", "M17 27h14v10H17z", "M12 21h24", "M30 21v5"],
  laptop: ["M10 8h28v24H10z", "M6 38h36l-4-6H10z", "M19 38h10"],
  bottle: ["M20 4h8v7h-8z", "M20 11v5l-5 7v17a3 3 0 0 0 3 3h12a3 3 0 0 0 3-3V23l-5-7v-5", "M15 28h18", "M20 34h8"],
  umbrella: ["M6 23a18 18 0 0 1 36 0H6Z", "M24 23v14a5 5 0 0 0 10 0", "M24 5v-2", "M15 23c0-10 4-18 9-18s9 8 9 18"]
};
const utilityPaths = {
  pin: ["M19 10c0 5-7 10-7 10S5 15 5 10a7 7 0 1 1 14 0Z", "M14.5 10a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0Z"],
  clock: ["M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z", "M12 7v5l3 2"],
  flag: ["M6 21V3m0 1h12l-3 4 3 4H6"],
  check: ["M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z", "m8 12 3 3 5-6"]
};

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

function svg(paths, viewBox = "0 0 24 24") {
  const node = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  for (const [name, value] of Object.entries({ viewBox, fill: "none", stroke: "currentColor", "stroke-width": "1.7", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" })) node.setAttribute(name, value);
  for (const d of paths) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d); node.append(path);
  }
  return node;
}

function itemIcon(item) {
  const kind = Object.hasOwn(iconPaths, item.icon) ? item.icon : "backpack";
  const wrapper = element("span", `item-icon ${kind}`);
  wrapper.append(svg(iconPaths[kind], "0 0 48 48"));
  return wrapper;
}

function statusBadge(item) { return element("span", `item-status${item.status === "lost" ? " lost" : ""}`, item.status === "lost" ? "遺失中" : "一般"); }
function formatDate(value) {
  const date = new Date(value);
  if (!value || !Number.isFinite(date.getTime())) return "尚無記錄";
  return new Intl.DateTimeFormat("zh-TW", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
}

function showError(error) {
  $("global-message").textContent = error instanceof Error ? error.message : "無法完成操作，請稍後再試。";
  $("global-message").hidden = false;
}
function clearError() { $("global-message").hidden = true; $("global-message").textContent = ""; }

function activateTab(name) {
  const report = name === "report";
  for (const [tabId, panelId, selected] of [["lookup-tab", "lookup-panel", !report], ["report-tab", "report-panel", report]]) {
    const tab = $(tabId);
    tab.classList.toggle("active", selected); tab.setAttribute("aria-selected", String(selected)); tab.tabIndex = selected ? 0 : -1;
    $(panelId).hidden = !selected;
  }
  clearError();
}

function renderItems() {
  $("item-list").replaceChildren();
  $("empty-results").hidden = state.results.length > 0;
  $("clear-search").hidden = !state.query;
  $("items-heading").textContent = state.query ? "搜尋結果" : "已登記物品";
  $("results-summary").textContent = state.query ? `找到 ${state.results.length} 件符合的物品` : `共 ${state.items.length} 件物品，選擇一件查看最後位置`;
  for (const item of state.results) {
    const selected = String(item.id) === state.selectedId;
    const card = element("button", `item-card${selected ? " selected" : ""}`);
    card.type = "button"; card.setAttribute("aria-pressed", String(selected));
    card.setAttribute("aria-label", `查看${item.item_name}的最後記錄位置`);
    const top = element("span", "item-top"); top.append(itemIcon(item), statusBadge(item));
    const bottom = element("span", "item-bottom");
    bottom.append(svg(utilityPaths.pin), element("span", "", item.last_seen?.location || "尚無位置記錄"), element("span", "item-arrow", "→"));
    card.append(top, element("span", "item-name", item.item_name), element("span", "item-uid", `MAC ${item.ble_id}`), bottom);
    card.addEventListener("click", () => { void selectItem(item); });
    $("item-list").append(card);
  }
}

function renderLocation() {
  const content = $("location-content"); content.replaceChildren();
  const item = state.selectedItem;
  if (!item) {
    const placeholder = element("div", "detail-empty");
    placeholder.append(svg(utilityPaths.pin), element("p", "", "選擇一件物品，查看最後位置。"));
    content.append(placeholder); return;
  }
  const identity = element("div", "detail-item");
  const identityText = element("div"); identityText.append(element("strong", "item-name", item.item_name), element("span", "item-uid", `MAC ${item.ble_id}`));
  identity.append(itemIcon(item), identityText);
  const location = element("div", "location-box");
  location.append(element("p", "location-label", "最後記錄位置"));
  const locationName = element("p", "location-name"); locationName.append(svg(utilityPaths.pin), document.createTextNode(item.last_seen?.location || "尚無位置記錄"));
  location.append(locationName, element("p", "gate-name", item.last_seen?.gate_id || "尚無閘門記錄"));
  if (item.last_seen?.rssi !== null && item.last_seen?.rssi !== undefined) location.append(element("p", "gate-name", "訊號強度：" + item.last_seen.rssi + " dBm"));
  const time = element("div", "detail-time");
  const timeText = element("div"); timeText.append(element("p", "", "最後觀測時間（台灣時間）"), element("strong", "", formatDate(item.last_seen?.received_at)));
  time.append(svg(utilityPaths.clock), timeText);
  const button = element("button", "button primary detail-report-button", "回報此物品遺失"); button.type = "button";
  button.prepend(svg(utilityPaths.flag));
  button.addEventListener("click", () => { openReport(item); });
  content.append(identity, location, time, element("p", "location-footnote", "顯示資料庫中的最後一筆位置記錄，並非物品目前的即時位置。尚無讀取紀錄時不顯示位置。"), button);
}

async function selectItem(item) {
  const selectionId = String(item.id); state.selectedId = selectionId;
  renderItems();
  try {
    const selected = await getItem(item.id);
    if (state.selectedId !== selectionId) return;
    state.selectedItem = selected; renderLocation();
    if (!selected) showError(new Error("找不到這件已登記物品，請重新查詢。"));
  } catch (error) {
    if (state.selectedId !== selectionId) return;
    state.selectedItem = null; renderLocation(); showError(error);
  }
}

function renderReportSelect() {
  const select = $("report-item");
  const current = state.reportItemId || select.value;
  select.replaceChildren();
  select.add(new Option("請選擇遺失的物品", ""));
  for (const item of state.items) select.add(new Option(`${item.item_name}　｜　${item.ble_id}`, String(item.id)));
  select.value = state.items.some(item => String(item.id) === current) ? current : "";
  state.reportItemId = select.value || null;
  renderReportPreview();
}

function renderReportPreview() {
  const item = state.items.find(row => String(row.id) === $("report-item").value);
  const preview = $("report-item-preview"); preview.replaceChildren(); preview.hidden = !item;
  if (item) {
    const text = element("div");
    text.append(element("p", "", "最後記錄位置"), element("strong", "", item.last_seen?.location || "尚無位置記錄"));
    preview.append(itemIcon(item), text, statusBadge(item));
  }
  $("report-submit").disabled = state.submitting || !item;
}

async function refreshItems(preferredId = state.selectedId) {
  const version = ++state.requestVersion;
  $("search-button").disabled = true;
  try {
    const [items, results] = await Promise.all([listItems(), searchItems(state.query)]);
    if (version !== state.requestVersion) return;
    state.items = items; state.results = results;
    const selected = results.find(item => String(item.id) === preferredId) || results[0] || null;
    state.selectedId = selected ? String(selected.id) : null; state.selectedItem = selected;
    renderItems(); renderLocation(); renderReportSelect();
  } finally { if (version === state.requestVersion) $("search-button").disabled = false; }
}

function openReport(item) {
  state.reportItemId = String(item.id); $("report-item").value = state.reportItemId;
  $("report-confirmation").hidden = true; renderReportPreview(); activateTab("report"); $("report-item").focus();
}

function showConfirmation(report) {
  const confirmation = $("report-confirmation"); confirmation.replaceChildren();
  const heading = element("h3", "", report.already_reported ? "這件物品已回報過遺失" : "遺失回報已儲存"); heading.prepend(svg(utilityPaths.check));
  confirmation.append(heading, element("p", "", report.already_reported ? "沿用資料庫中已存在的回報，沒有重複新增。" : "後端已確認回報儲存至資料庫。"));
  confirmation.append(element("p", "", `${report.item_name}　｜　MAC ${report.ble_id}`), element("p", "", `回報時間：${formatDate(report.reported_at)}`));
  if (report.description) confirmation.append(element("p", "confirmation-description", report.description));
  confirmation.hidden = false;
}

$("lookup-tab").addEventListener("click", () => activateTab("lookup"));
$("report-tab").addEventListener("click", () => activateTab("report"));
$("back-to-lookup").addEventListener("click", () => activateTab("lookup"));
for (const [index, id] of ["lookup-tab", "report-tab"].entries()) {
  $(id).addEventListener("keydown", event => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === "Home" ? 0 : event.key === "End" ? 1 : 1 - index;
    activateTab(next === 0 ? "lookup" : "report"); $(["lookup-tab", "report-tab"][next]).focus();
  });
}
$("search-form").addEventListener("submit", async event => {
  event.preventDefault(); clearError(); state.query = $("search-input").value.trim();
  try { await refreshItems(); } catch (error) { showError(error); }
});
async function resetSearch() {
  clearError(); $("search-input").value = ""; state.query = "";
  try { await refreshItems(); $("search-input").focus(); } catch (error) { showError(error); }
}
$("clear-search").addEventListener("click", () => { void resetSearch(); });
$("reset-search").addEventListener("click", () => { void resetSearch(); });
$("report-item").addEventListener("change", () => {
  state.reportItemId = $("report-item").value || null; $("report-confirmation").hidden = true; renderReportPreview();
});
$("report-description").addEventListener("input", () => { $("description-count").textContent = `${$("report-description").value.length} / 500`; });
$("report-form").addEventListener("submit", async event => {
  event.preventDefault(); clearError();
  const item = state.items.find(row => String(row.id) === $("report-item").value);
  if (!item || state.submitting) return;
  $("report-confirmation").hidden = true;
  state.submitting = true; $("report-submit").disabled = true; $("report-submit").textContent = "正在儲存…";
  try {
    const report = await reportLost({ item_id: item.id, description: $("report-description").value.trim() });
    showConfirmation(report);
    try { await refreshItems(state.selectedId); }
    catch { showError(new Error("已確認資料庫中的遺失回報，但物品清單更新失敗。請確認後端連線後重新查詢。")); }
  } catch (error) { showError(error); }
  finally { state.submitting = false; $("report-submit").textContent = "儲存遺失回報"; renderReportPreview(); }
});

try { await refreshItems(); }
catch (error) { showError(error); $("results-summary").textContent = "物品資料無法載入"; $("report-submit").disabled = true; }
