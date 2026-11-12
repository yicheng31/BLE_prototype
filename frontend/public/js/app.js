import { listItems, searchItems, getItem, createItem, reportLost, markFound, deleteItem } from "./services/item-service.js";

const $ = id => document.getElementById(id);
const state = { items: [], results: [], selectedId: null, selectedItem: null, query: "", reportItemId: null, requestVersion: 0, submitting: false, findingItemId: null, registering: false, pendingDeleteId: null, deletingItemId: null };
const deletedIds = new Set();
const tabNames = ["lookup", "report", "register"];
const mutationBusy = () => state.submitting || state.findingItemId !== null || state.registering || state.deletingItemId !== null;
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
function clearFoundMessage() { $("found-message").hidden = true; $("found-message").textContent = ""; }
function clearRegisterMessage() { $("register-message").hidden = true; $("register-message").textContent = ""; }
function clearDeleteMessage() { $("delete-message").hidden = true; $("delete-message").textContent = ""; }

function activateTab(name) {
  for (const tabName of tabNames) {
    const selected = tabName === name;
    const tab = $(`${tabName}-tab`);
    tab.classList.toggle("active", selected); tab.setAttribute("aria-selected", String(selected)); tab.tabIndex = selected ? 0 : -1;
    $(`${tabName}-panel`).hidden = !selected;
  }
  clearError();
}

function renderItems() {
  $("item-list").replaceChildren();
  $("empty-results").hidden = state.results.length > 0;
  const noRegisteredItems = state.items.length === 0;
  $("empty-title").textContent = noRegisteredItems ? "還沒有登記的物品" : "沒有找到符合的物品";
  $("empty-description").textContent = noRegisteredItems ? "先登記物品名稱與標籤的 BLE MAC，讓感應記錄對應到物品清單。" : "試試其他名稱，或確認 BLE MAC 是否正確。";
  $("open-register").hidden = !noRegisteredItems;
  $("reset-search").hidden = noRegisteredItems;
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
  const lost = item.status === "lost";
  const findingThisItem = state.findingItemId === String(item.id);
  const button = element("button", "button primary detail-report-button", lost ? findingThisItem ? "正在更新…" : "已找到" : "回報此物品遺失"); button.type = "button";
  button.prepend(svg(lost ? utilityPaths.check : utilityPaths.flag));
  button.disabled = mutationBusy();
  if (lost) {
    button.id = "mark-found-button";
    button.disabled = mutationBusy();
    button.addEventListener("click", () => { void markItemFound(item); });
  } else {
    button.addEventListener("click", () => { openReport(item); });
  }
  content.append(identity, location, time, element("p", "location-footnote", "顯示資料庫中的最後一筆位置記錄，並非物品目前的即時位置。尚無讀取紀錄時不顯示位置。"), button);
  const removeButton = element("button", "button delete-item-button", "刪除物品");
  removeButton.type = "button"; removeButton.disabled = mutationBusy();
  removeButton.addEventListener("click", () => {
    if (mutationBusy()) return;
    state.pendingDeleteId = String(item.id); renderLocation();
    content.querySelector(".delete-confirm-button")?.focus();
  });
  content.append(removeButton);
  if (state.pendingDeleteId === String(item.id)) {
    const confirmation = element("div", "delete-confirmation");
    confirmation.setAttribute("role", "group"); confirmation.setAttribute("aria-label", "確認刪除物品");
    confirmation.append(element("p", "", `確定刪除「${item.item_name}」嗎？`), element("p", "item-uid", `MAC ${item.ble_id}`),
      element("p", "", "確認後，物品會從清單與遺失選單隱藏，原紀錄仍會保留。"));
    const actions = element("div", "delete-actions");
    const cancel = element("button", "button secondary", "取消");
    cancel.type = "button"; cancel.disabled = mutationBusy();
    cancel.addEventListener("click", () => {
      state.pendingDeleteId = null; renderLocation(); content.querySelector(".delete-item-button")?.focus();
    });
    const confirm = element("button", "button delete-confirm-button", state.deletingItemId === String(item.id) ? "正在刪除…" : "確認刪除");
    confirm.type = "button"; confirm.disabled = mutationBusy();
    confirm.addEventListener("click", () => { void removeRegisteredItem(item); });
    actions.append(cancel, confirm); confirmation.append(actions); content.append(confirmation);
  }
}

async function selectItem(item) {
  if (deletedIds.has(String(item.id))) return;
  const version = state.requestVersion;
  const selectionId = String(item.id); state.selectedId = selectionId;
  state.pendingDeleteId = null; state.selectedItem = null;
  renderItems(); renderLocation();
  try {
    const selected = await getItem(item.id);
    if (state.selectedId !== selectionId || version !== state.requestVersion || deletedIds.has(selectionId)) return;
    state.selectedItem = selected; renderLocation();
    if (!selected) showError(new Error("找不到這件已登記物品，請重新查詢。"));
  } catch (error) {
    if (state.selectedId !== selectionId || version !== state.requestVersion || deletedIds.has(selectionId)) return;
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
  $("report-submit").disabled = mutationBusy() || !item;
}

function updateMutationControls() {
  renderLocation(); renderReportPreview();
  $("register-submit").disabled = mutationBusy();
  $("register-submit").textContent = state.registering ? "正在登記…" : "登記並綁定";
  $("register-name").disabled = state.registering;
  $("register-mac").disabled = state.registering;
}

async function refreshItems(preferredId = state.selectedId, { refreshSelected = false } = {}) {
  const version = ++state.requestVersion;
  $("search-button").disabled = true;
  try {
    const [items, results] = await Promise.all([listItems(), searchItems(state.query)]);
    if (version !== state.requestVersion) return;
    state.items = items.filter(item => !deletedIds.has(String(item.id)));
    state.results = results.filter(item => !deletedIds.has(String(item.id)));
    const selected = state.results.find(item => String(item.id) === preferredId) || state.results[0] || null;
    state.selectedId = selected ? String(selected.id) : null; state.selectedItem = selected;
    if (state.pendingDeleteId !== state.selectedId) state.pendingDeleteId = null;
    renderItems(); renderLocation(); renderReportSelect();
    if (refreshSelected && selected) {
      const selectionId = String(selected.id);
      const detail = await getItem(selected.id);
      if (version !== state.requestVersion || state.selectedId !== selectionId) return;
      state.selectedItem = detail; renderLocation();
      if (!detail) throw new Error("找不到這件已登記物品，請重新查詢。");
    }
  } finally { if (version === state.requestVersion) $("search-button").disabled = false; }
}

async function removeRegisteredItem(item) {
  const id = String(item.id);
  if (mutationBusy() || state.pendingDeleteId !== id || deletedIds.has(id)) return;
  clearError(); clearFoundMessage(); clearRegisterMessage(); clearDeleteMessage();
  state.deletingItemId = id; updateMutationControls();
  try {
    await deleteItem(item.id);
    deletedIds.add(id); ++state.requestVersion;
    state.items = state.items.filter(row => String(row.id) !== id);
    state.results = state.results.filter(row => String(row.id) !== id);
    if (state.selectedId === id) { state.selectedId = null; state.selectedItem = null; }
    if (String(state.selectedItem?.id) === id) state.selectedItem = null;
    if (state.reportItemId === id || $("report-item").value === id) {
      state.reportItemId = null; $("report-item").value = "";
    }
    state.pendingDeleteId = null; $("report-confirmation").hidden = true;
    $("delete-message").textContent = `已刪除「${item.item_name}」，物品已從清單隱藏。`;
    $("delete-message").hidden = false;
    renderItems(); renderLocation(); renderReportSelect();
    try { await refreshItems(state.selectedId, { refreshSelected: true }); }
    catch { showError(new Error(`「${item.item_name}」已刪除，但其他物品資料更新失敗。請確認後端連線後重新查詢。`)); }
  } catch (error) { showError(error); }
  finally { state.deletingItemId = null; updateMutationControls(); }
}

async function markItemFound(item) {
  if (item.status !== "lost" || mutationBusy()) return;
  clearError(); clearFoundMessage(); clearRegisterMessage(); clearDeleteMessage(); $("report-confirmation").hidden = true;
  state.findingItemId = String(item.id); updateMutationControls();
  try {
    const result = await markFound(item.id);
    $("found-message").textContent = result.already_found
      ? result.resolved_at
        ? `「${item.item_name}」的遺失回報已結束，無需重複更新。`
        : `「${item.item_name}」目前沒有有效的遺失回報，無需重複標示已找到。`
      : `已將「${item.item_name}」標示為已找到，遺失回報已結束。`;
    $("found-message").hidden = false;
    try { await refreshItems(state.selectedId, { refreshSelected: true }); }
    catch { showError(new Error(`已確認「${item.item_name}」的已找到狀態，但物品清單或明細更新失敗。請確認後端連線後重新查詢。`)); }
  } catch (error) { showError(error); }
  finally { state.findingItemId = null; updateMutationControls(); }
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

$("back-to-lookup").addEventListener("click", () => activateTab("lookup"));
for (const [index, name] of tabNames.entries()) {
  const tab = $(`${name}-tab`);
  tab.addEventListener("click", () => activateTab(name));
  tab.addEventListener("keydown", event => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === "Home" ? 0 : event.key === "End" ? tabNames.length - 1
      : (index + (event.key === "ArrowRight" ? 1 : -1) + tabNames.length) % tabNames.length;
    activateTab(tabNames[next]); $(`${tabNames[next]}-tab`).focus();
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
$("open-register").addEventListener("click", () => { activateTab("register"); $("register-name").focus(); });
$("report-item").addEventListener("change", () => {
  state.reportItemId = $("report-item").value || null; $("report-confirmation").hidden = true; renderReportPreview();
});
$("report-description").addEventListener("input", () => { $("description-count").textContent = `${$("report-description").value.length} / 500`; });
$("report-form").addEventListener("submit", async event => {
  event.preventDefault(); clearError();
  const item = state.items.find(row => String(row.id) === $("report-item").value);
  if (!item || mutationBusy()) return;
  clearFoundMessage(); clearRegisterMessage(); clearDeleteMessage();
  $("report-confirmation").hidden = true;
  state.submitting = true; $("report-submit").disabled = true; $("report-submit").textContent = "正在儲存…";
  updateMutationControls();
  try {
    const report = await reportLost({ item_id: item.id, description: $("report-description").value.trim() });
    showConfirmation(report);
    try { await refreshItems(state.selectedId); }
    catch { showError(new Error("已確認資料庫中的遺失回報，但物品清單更新失敗。請確認後端連線後重新查詢。")); }
  } catch (error) { showError(error); }
  finally { state.submitting = false; $("report-submit").textContent = "儲存遺失回報"; updateMutationControls(); }
});

$("register-form").addEventListener("submit", async event => {
  event.preventDefault();
  if (mutationBusy()) return;
  clearError(); clearFoundMessage(); clearRegisterMessage(); clearDeleteMessage();
  const input = { item_name: $("register-name").value, ble_id: $("register-mac").value };
  state.registering = true; updateMutationControls();
  try {
    const registered = await createItem(input);
    deletedIds.delete(String(registered.id));
    $("register-message").textContent = `已登記「${registered.item_name}」，並綁定 BLE MAC ${registered.ble_id}。`;
    $("register-message").hidden = false;
    $("register-form").reset();
    state.query = ""; $("search-input").value = "";
    try {
      await refreshItems(String(registered.id), { refreshSelected: true });
      activateTab("lookup");
    } catch {
      showError(new Error(`「${registered.item_name}」已登記並綁定，但物品清單或明細更新失敗。請確認後端連線後重新查詢。`));
    }
  } catch (error) { showError(error); }
  finally { state.registering = false; updateMutationControls(); }
});

try { await refreshItems(); }
catch (error) { showError(error); $("results-summary").textContent = "物品資料無法載入"; $("report-submit").disabled = true; }
