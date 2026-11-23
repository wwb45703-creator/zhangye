import { getWorkspace, saveWorkspace, watchWorkspace } from "./core/client.js";
import { PERIODS } from "./core/compare.js";
import { validateSnapshot } from "./core/snapshot.js";
import { confirmAction, element } from "./ui.js";

const readButton = element("read-page");
const picker = element("table-picker");
const select = element("source-table");
const preview = element("table-preview");
const feedback = element("popup-message");
const openButton = element("open-workbench");
const headerConfirmation = element("confirm-header");
const saveButtons = [...document.querySelectorAll("[data-save]")];
let workspace;
let tables = [];
let busy = false;

function show(message = "", kind = "info") {
  feedback.textContent = message;
  feedback.dataset.kind = kind;
  feedback.hidden = !message;
}

function updateControls() {
  const chosen = tables[Number(select.value)];
  const awaitingHeader = chosen?.needsHeaderConfirmation && !headerConfirmation.checked;
  for (const [slot, label] of Object.entries(PERIODS)) {
    const value = workspace?.[slot];
    element(`popup-${slot}`).textContent = value ? `${value.rows.length} 条记录` : "未添加";
    const button = saveButtons.find((item) => item.dataset.save === slot);
    button.textContent = value ? `替换${label}` : `存为${label}`;
    button.disabled = busy || !workspace || !chosen || awaitingHeader;
  }
  readButton.disabled = busy || !workspace;
}

function showSelected() {
  const table = tables[Number(select.value)];
  element("header-assumption").hidden = !table?.needsHeaderConfirmation;
  headerConfirmation.checked = false;
  preview.textContent = table
    ? `${table.rows.length} 条记录 · ${table.headers.length} 列\n${table.headers.slice(0, 3).join("、")}${table.headers.length > 3 ? " 等" : ""}`
    : "";
  updateControls();
}

readButton.addEventListener("click", async () => {
  busy = true;
  tables = [];
  picker.hidden = true;
  updateControls();
  show("正在读取当前页…");
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !/^https?:\/\//.test(tab.url ?? "")) {
      show("请切换到普通网页再读取。也可以在核对台导入 CSV。", "error");
      return;
    }
    let response;
    try {
      const [injection] = await chrome.scripting.executeScript({
        target: { tabId: tab.id }, files: ["capture.js"], world: "ISOLATED",
      });
      response = injection.result;
    } catch {
      show("浏览器未允许读取此页。请在普通网页打开扩展，或导入 CSV。", "error");
      return;
    }

    let rejected = response?.unsupported ?? 0;
    for (const candidate of response?.tables ?? []) {
      try {
        tables.push({ ...validateSnapshot(candidate), needsHeaderConfirmation: candidate.needsHeaderConfirmation === true });
      } catch {
        rejected++;
      }
    }
    if (!tables.length) {
      show(rejected
        ? "这里的表格有合并单元格、表头或数据格式限制。请导入系统导出的 CSV。"
        : "当前页主框架没有可读表格。请展开列表或导入 CSV。", "error");
      return;
    }
    select.replaceChildren(...tables.map((table, index) =>
      new Option(`${table.meta.label} · ${table.rows.length} 条`, String(index))));
    showSelected();
    picker.hidden = false;
    show(`只读取当前页已显示的行。${rejected ? ` 跳过 ${rejected} 张不兼容表格。` : ""}${response.limited ? " 表格较多，仅列出前几张。" : ""}`);
  } catch {
    show("读取未完成，请刷新原网页后重试。", "error");
  } finally {
    busy = false;
    updateControls();
  }
});

select.addEventListener("change", showSelected);
headerConfirmation.addEventListener("change", updateControls);
for (const button of saveButtons) {
  button.addEventListener("click", async () => {
    const slot = button.dataset.save;
    const base = workspace;
    const selected = tables[Number(select.value)];
    if (!base || !selected || busy || (selected.needsHeaderConfirmation && !headerConfirmation.checked)) return;
    if (base[slot] && !await confirmAction(
      `替换${PERIODS[slot]}台账？`, "这会用当前选择的表覆盖此期数据。", "确认替换",
    )) return;

    busy = true;
    updateControls();
    try {
      workspace = await saveWorkspace(base.revision, { action: "set-period", slot, snapshot: selected });
      tables = [];
      picker.hidden = true;
      show(`已存为${PERIODS[slot]} · ${selected.rows.length} 条记录。`, "success");
    } catch (error) {
      show(error.message, "error");
      workspace = await getWorkspace().catch(() => workspace);
    } finally {
      busy = false;
      updateControls();
    }
  });
}

openButton.addEventListener("click", async () => {
  openButton.disabled = true;
  try {
    const url = chrome.runtime.getURL("workbench.html");
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
    const contexts = await chrome.runtime.getContexts({ contextTypes: ["TAB"], documentUrls: [url] });
    const existing = contexts.find((context) => context.windowId === active?.windowId && context.tabId >= 0);
    if (existing) {
      try {
        await chrome.tabs.update(existing.tabId, { active: true });
      } catch {
        await chrome.tabs.create({ url });
      }
    } else await chrome.tabs.create({ url });
    window.close();
  } catch {
    show("无法打开核对台，请从扩展的「选项」打开。", "error");
  } finally {
    openButton.disabled = false;
  }
});

function refresh() {
  return getWorkspace().then((value) => {
    workspace = value;
    updateControls();
  }).catch(() => show("本地数据暂不可用，请重新打开扩展。", "error"));
}
watchWorkspace(refresh);
updateControls();
void refresh();
