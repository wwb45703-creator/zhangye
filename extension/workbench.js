import { download, getWorkspace, saveWorkspace, watchWorkspace } from "./core/client.js";
import { CATEGORIES, PERIODS, compareSnapshots, entrySummary, keyColumns, matchingFields, ruleFits } from "./core/compare.js";
import { DEMO_RULE, makeDemoBackup } from "./core/demo.js";
import { makeReport } from "./core/report.js";
import { importCsv, LIMITS } from "./core/snapshot.js";
import { makeBackup, readBackup } from "./core/workspace.js";
import { confirmAction, dateLabel, element, node } from "./ui.js";

const $ = element;
const draftRule = (saved) => ({
  beforeKeys: keyColumns(saved, "before").map((key) => key ?? ""),
  afterKeys: keyColumns(saved, "after").map((key) => key ?? ""),
  fields: [...(saved?.fields ?? [])],
});
const keyLabel = ({ key, detailKey }) => detailKey === undefined
  ? key || "空主键"
  : `${key || "空主键"} / ${detailKey || "空明细编号"}`;
const dateStamp = () => new Date().toISOString().slice(0, 10);
const sameSnapshot = (a, b) => a === b ||
  (a?.meta.at === b?.meta.at && JSON.stringify(a) === JSON.stringify(b));
const PAGE_SIZE = 20;

let workspace;
let readSequence = 0;
let rule = draftRule();
let result = null;
let filter = "all";
let page = 0;
let importContext;
let presetContext;

function message(id, text = "", kind = "info") {
  const banner = $(id);
  banner.hidden = !text;
  banner.dataset.kind = kind;
  banner.textContent = text;
}

function actionButton(text, extra = "") {
  const button = node("button", `button ${extra}`, text);
  button.type = "button";
  return button;
}

function showSources() {
  const sections = Object.entries(PERIODS).map(([slot, period]) => {
    const snapshot = workspace[slot];
    const box = node("div", "source-card");
    box.dataset.slot = slot;
    const header = node("div", "source-head");
    const label = node("strong", "", period);
    const count = node("span", "source-count", snapshot ? `${snapshot.rows.length} 条 · ${snapshot.headers.length} 列` : "未添加");
    header.append(label, count);
    box.append(header);
    if (snapshot) {
      const name = node("div", "source-name", snapshot.meta.label);
      name.title = snapshot.meta.label;
      const info = node("div", "source-meta", [snapshot.meta.origin, dateLabel(snapshot.meta.at)].filter(Boolean).join(" · "));
      info.title = info.textContent;
      box.append(name, info);
    } else box.append(node("p", "source-meta", "等待读取网页或导入文件"));
    const button = actionButton(snapshot ? "换用 CSV" : "导入 CSV", "small");
    button.dataset.import = slot;
    button.setAttribute("aria-label", `${period}${button.textContent}`);
    button.addEventListener("click", () => openImport(slot));
    box.append(button);
    return box;
  });
  $("sources").replaceChildren(...sections);
  $("advance").hidden = !workspace.after;
  $("demo-badge").hidden = ![workspace.before, workspace.after].some((s) => s?.meta.kind === "demo");
}

function validRule() {
  return rule.fields.length > 0 && ruleFits(rule, workspace?.before, workspace?.after) &&
    ((workspace.before.meta.kind === "demo") === (workspace.after.meta.kind === "demo"));
}

function updateRuleButtons() {
  $("compare").disabled = !validRule();
  $("save-preset").disabled = !validRule();
}

function showFields() {
  const ready = [...rule.beforeKeys, ...rule.afterKeys].every(Boolean);
  const common = ready ? matchingFields(workspace.before, workspace.after, rule) : [];
  const hint = ready
    ? (common.length ? "按文本逐格核对。只列出两期同名列。" : "没有同名核对字段，请统一表头后重导。")
    : "请选齐两期的编号列。";
  $("fields-hint").textContent = hint;
  $("fields-list").replaceChildren(...common.map((name) => {
    const label = node("label", "check-field");
    const input = node("input");
    input.type = "checkbox";
    input.checked = rule.fields.includes(name);
    input.value = name;
    input.addEventListener("change", () => {
      rule.fields = [...$("fields-list").querySelectorAll("input:checked")].map((item) => item.value);
      clearResult();
      updateRuleButtons();
    });
    label.append(input, node("span", "", name));
    return label;
  }));
}

function showRules() {
  const ready = Boolean(workspace.before && workspace.after);
  $("rule-editor").hidden = !ready;
  $("rule-empty").hidden = ready;
  if (ready) {
    const presets = workspace.presets;
    $("preset-select").replaceChildren(new Option(presets.length ? "选择已保存规则…" : "尚无保存规则", ""),
      ...presets.map(({ name }) => new Option(name, name)));
    $("preset-select").disabled = !presets.length;
    const detail = rule.beforeKeys.length === 2;
    $("use-detail").checked = detail;
    $("use-detail").disabled = !detail && [workspace.before, workspace.after].some(({ headers }) => headers.length < 3);
    $("detail-keys").hidden = !detail;
    for (const slot of Object.keys(PERIODS)) {
      const keys = rule[`${slot}Keys`];
      const headers = workspace[slot].headers;
      for (const [index, control] of ["key", "detail-key"].entries()) {
        const select = $(`${slot}-${control}`);
        select.replaceChildren(new Option("选择列…", ""),
          ...headers.filter((name) => name !== keys[1 - index]).map((name) => new Option(name, name)));
        select.value = keys[index] ?? "";
        select.disabled = index === 1 && !detail;
      }
    }
    showFields();
  }
  updateRuleButtons();
}

function resultCount() {
  return Object.values(result.entries).reduce((count, entries) => count + entries.length, 0);
}

function clearResult() {
  result = null;
  showResults();
}

function resetFilters() {
  filter = "all";
  page = 0;
  $("result-search").value = "";
}

function showResults() {
  $("empty-results").hidden = Boolean(result);
  $("result-content").hidden = !result;
  $("compare").hidden = Boolean(result);
  $("export").hidden = !result;
  $("export").disabled = !result;
  if (!result) {
    $("result-summary").textContent = "核对后可查看字段的前后值。";
    const ready = Boolean(workspace?.before && workspace?.after);
    const mixed = ready && ((workspace.before.meta.kind === "demo") !== (workspace.after.meta.kind === "demo"));
    $("empty-title").textContent = ready ? (mixed ? "请选择同一种数据" : "两期台账已齐备") : "带入两期台账开始核对";
    $("empty-description").textContent = ready
      ? (mixed ? "请用真实数据替换示例，或重新载入两期示例。" : "确认期别和筛选范围，再设置核对规则。")
      : "在采购网页点击扩展读取表格，或从左侧导入两期 CSV。";
    $("load-demo").hidden = ready && !mixed;
    $("demo-note").hidden = $("load-demo").hidden;
    return;
  }
  $("export").disabled = false;
  $("result-summary").textContent = `${resultCount()} 项需查看 · ${result.counts.unchanged} 条无变化`;
  const metrics = Object.entries(CATEGORIES).map(([type, label]) => {
    const button = node("button", "metric");
    button.type = "button";
    button.dataset.type = type;
    button.append(node("span", "metric-label", label), node("strong", "metric-number", String(result.counts[type])));
    button.addEventListener("click", () => setFilter(filter === type ? "all" : type));
    return button;
  });
  $("metrics").replaceChildren(...metrics);
  const { before, after } = workspace;
  const caveat = before.rows.length === 0 || after.rows.length === 0
    ? " 有一期没有记录，请核实来源。"
    : (before.meta.origin && after.meta.origin && before.meta.origin !== after.meta.origin
      ? " 两期来自不同站点，请核实范围。" : "");
  $("scope-note").textContent = "结果仅基于两期输入。分页与筛选会影响「本期未见」。" + caveat;
  renderRows();
}

function setFilter(type) {
  filter = type;
  page = 0;
  renderRows();
}

function shortRowNumbers(rows) {
  if (!rows.length) return "—";
  const preview = rows.slice(0, 3).map((row) => row.number).join(", ");
  return rows.length > 3 ? `${preview}…` : preview;
}

function makeResultRow(entry) {
  const row = node("tr");
  row.dataset.resultType = entry.type;
  const kind = node("td");
  const badge = node("span", "tag", CATEGORIES[entry.type]);
  badge.dataset.type = entry.type;
  kind.append(badge);
  const key = node("td", "result-key", keyLabel(entry));
  key.title = key.textContent;
  const summary = node("td", "result-description", entrySummary(entry));
  summary.title = summary.textContent;
  const location = node("td", "line-numbers",
    `${shortRowNumbers(entry.beforeRows)} / ${shortRowNumbers(entry.afterRows)}`);
  const action = node("td", "row-action");
  const button = node("button", "text-button", "查看");
  button.type = "button";
  button.setAttribute("aria-label", `查看 ${keyLabel(entry)} 明细`);
  button.addEventListener("click", () => showDetail(entry));
  action.append(button);
  row.append(kind, key, summary, location, action);
  return row;
}

function renderRows() {
  if (!result) return;
  const text = $("result-search").value.trim().toLowerCase();
  const records = filter === "all" ? Object.values(result.entries).flat() : result.entries[filter];
  const visible = text
    ? records.filter((entry) => keyLabel(entry).toLowerCase().includes(text) || entrySummary(entry).toLowerCase().includes(text))
    : records;
  for (const button of $("metrics").children) {
    button.setAttribute("aria-pressed", String(button.dataset.type === filter));
  }
  $("all-results").setAttribute("aria-pressed", String(filter === "all"));
  const start = page * PAGE_SIZE;
  const rows = visible.slice(start, start + PAGE_SIZE).map(makeResultRow);
  if (!rows.length) {
    const row = node("tr");
    const cell = node("td", "no-results", text || filter !== "all" ? "没有匹配的差异项。" : "本次所选字段没有发现差异。");
    cell.colSpan = 5;
    row.append(cell);
    rows.push(row);
  }
  $("results-body").replaceChildren(...rows);
  $("result-range").textContent = visible.length
    ? `${start + 1}–${Math.min(start + PAGE_SIZE, visible.length)} / ${visible.length} 项`
    : "0 项";
  $("previous-page").disabled = page === 0;
  $("next-page").disabled = start + PAGE_SIZE >= visible.length;
}

function showDetail(entry) {
  $("detail-kind").dataset.type = entry.type;
  $("detail-kind").textContent = CATEGORIES[entry.type];
  $("detail-title").textContent = keyLabel(entry);
  $("detail-summary").textContent = entrySummary(entry);
  const content = $("detail-content");
  content.replaceChildren();

  if (entry.changes) {
    const table = node("table", "detail-table");
    const head = node("thead");
    const header = node("tr");
    for (const label of ["字段", "上期", "本期"]) {
      const th = node("th", "", label);
      th.scope = "col";
      header.append(th);
    }
    head.append(header);
    const body = node("tbody");
    for (const change of entry.changes) {
      const tr = node("tr");
      tr.append(node("th", "", change.field), node("td", "old-value", change.oldValue || "（空）"),
        node("td", "new-value", change.newValue || "（空）"));
      tr.firstChild.scope = "row";
      body.append(tr);
    }
    table.append(head, body);
    content.append(table);
  }

  const periods = node("div", "detail-periods");
  for (const [slot, label] of Object.entries(PERIODS)) {
    const section = node("section");
    const records = entry[`${slot}Rows`];
    section.append(node("h3", "", `${label} · ${records.length} 行`));
    if (!records.length) section.append(node("p", "hint", "输入中未见。"));
    for (const row of records.slice(0, 8)) {
      const box = node("details", "detail-record");
      box.append(node("summary", "", `第 ${row.number} 行`));
      const list = node("dl");
      workspace[slot].headers.forEach((field, i) => {
        list.append(node("dt", "", field), node("dd", "", row.values[i] || "（空）"));
      });
      box.append(list);
      section.append(box);
    }
    if (records.length > 8) section.append(node("p", "hint", "其余行号可在导出的报表中查看。"));
    periods.append(section);
  }
  content.append(periods);
  $("detail-dialog").showModal();
}

function renderManage() {
  const records = [];
  for (const [slot, label] of Object.entries(PERIODS)) {
    const snapshot = workspace[slot];
    if (snapshot) {
      const button = actionButton("删除", "small danger");
      button.setAttribute("aria-label", `删除${label}`);
      button.addEventListener("click", () => removePeriod(slot));
      records.push([label, `${snapshot.rows.length} 条 · ${snapshot.meta.label}`, button]);
    }
  }
  for (const preset of workspace.presets) {
    const button = actionButton("移除", "small");
    button.setAttribute("aria-label", `移除规则 ${preset.name}`);
    button.addEventListener("click", () => removePreset(preset.name));
    records.push(["规则", preset.name, button]);
  }
  $("managed-data").replaceChildren(...(records.length ? records.map(([label, value, button]) => {
    const row = node("div", "managed-row");
    row.append(node("strong", "", label), node("span", "", value), button);
    return row;
  }) : [node("p", "hint", "暂无已保存的台账或规则。")]));
  $("clear-data").disabled = !records.length;
  $("backup").disabled = !records.length;
}

function adoptWorkspace(next) {
  if (workspace && workspace.revision === next.revision) return;
  const initial = !workspace;
  const changed = initial || !sameSnapshot(workspace.before, next.before) || !sameSnapshot(workspace.after, next.after);
  workspace = next;
  if (initial) {
    $("manage").disabled = false;
    $("load-demo").disabled = false;
  }
  if (changed) {
    result = null;
    resetFilters();
    if ($("detail-dialog").open) $("detail-dialog").close();
    const { before, after } = workspace;
    if (before?.meta.kind === "demo" && after?.meta.kind === "demo" &&
        (initial || !ruleFits(rule, before, after))) {
      if (ruleFits(DEMO_RULE, before, after)) {
        rule = draftRule(DEMO_RULE);
        result = compareSnapshots(before, after, rule);
      } else rule = draftRule();
    } else if (before && after && !ruleFits(rule, before, after)) {
      rule = draftRule();
    }
  }
  showSources();
  showRules();
  renderManage();
  showResults();
}

async function refresh() {
  const seq = ++readSequence;
  try {
    const next = await getWorkspace();
    if (seq === readSequence) adoptWorkspace(next);
  } catch {
    message("workbench-message", "暂时无法读取本地台账。请刷新页面。", "error");
  }
}

async function change(revision, action) {
  try {
    return await saveWorkspace(revision, action);
  } finally {
    await refresh();
  }
}

function openImport(slot) {
  importContext = { slot, revision: workspace.revision };
  $("import-form").reset();
  message("import-message");
  $("import-title").textContent = `导入${PERIODS[slot]} CSV`;
  $("import-submit").textContent = workspace[slot] ? `导入并替换${PERIODS[slot]}` : `导入为${PERIODS[slot]}`;
  $("import-dialog").showModal();
}

$("import-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const file = $("csv-file").files[0];
  if (!file || $("import-submit").disabled) return;
  const { slot, revision } = importContext;
  $("import-submit").disabled = true;
  try {
    if (file.size > LIMITS.snapshotBytes) throw new Error("CSV 超过 1.5 MB，请缩小核对范围。");
    const snapshot = importCsv(await file.arrayBuffer(), file.name, $("csv-encoding").value);
    await change(revision, { action: "set-period", slot, snapshot });
    $("import-dialog").close();
    message("workbench-message", `已导入${PERIODS[slot]} · ${snapshot.rows.length} 条记录。`, "success");
  } catch (error) {
    message("import-message", error.message, "error");
  } finally {
    $("import-submit").disabled = false;
  }
});

$("preset-select").addEventListener("change", () => {
  const select = $("preset-select");
  const selected = workspace.presets.find(({ name }) => name === select.value);
  if (!selected) return;
  if (!ruleFits(selected, workspace.before, workspace.after)) {
    message("workbench-message", "此规则的列与本次台账不匹配。请重新选主键和字段。", "error");
    select.value = "";
    return;
  }
  rule = draftRule(selected);
  clearResult();
  showRules();
  select.value = selected.name;
  message("workbench-message", `已应用规则「${selected.name}」。`, "success");
});

function keysChanged() {
  rule.fields = matchingFields(workspace.before, workspace.after, rule);
  clearResult();
  showRules();
  message("workbench-message");
}

$("use-detail").addEventListener("change", (event) => {
  for (const keys of [rule.beforeKeys, rule.afterKeys]) {
    if (event.target.checked) keys.push("");
    else keys.length = 1;
  }
  keysChanged();
});

for (const [index, control] of ["key", "detail-key"].entries()) {
  for (const slot of Object.keys(PERIODS)) {
    $(`${slot}-${control}`).addEventListener("change", (event) => {
      const other = slot === "before" ? "after" : "before";
      const otherKeys = rule[`${other}Keys`];
      const selected = event.target.value;
      rule[`${slot}Keys`][index] = selected;
      if (!otherKeys[index] && otherKeys[1 - index] !== selected && workspace[other].headers.includes(selected)) {
        otherKeys[index] = selected;
      }
      keysChanged();
    });
  }
}

$("compare").addEventListener("click", () => {
  try {
    result = compareSnapshots(workspace.before, workspace.after, rule);
    resetFilters();
    showResults();
    message("workbench-message");
  } catch (error) {
    clearResult();
    message("workbench-message", error.message, "error");
  }
});

$("save-preset").addEventListener("click", () => {
  presetContext = { revision: workspace.revision, rule: draftRule(rule) };
  $("preset-form").reset();
  message("preset-message");
  $("preset-dialog").showModal();
});

$("preset-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if ($("preset-submit").disabled) return;
  const name = $("preset-name").value.trim();
  const { revision, rule: selected } = presetContext;
  $("preset-submit").disabled = true;
  try {
    await change(revision, { action: "save-preset", name, rule: selected });
    $("preset-dialog").close();
    $("preset-select").value = name;
    message("workbench-message", `已保存规则「${name}」。`, "success");
  } catch (error) {
    message("preset-message", error.message, "error");
  } finally {
    $("preset-submit").disabled = false;
  }
});

$("load-demo").addEventListener("click", async () => {
  const base = workspace;
  if (!base || $("load-demo").disabled) return;
  if ((base.before || base.after) && !await confirmAction(
    "换成两期示例？", "这会替换当前两期台账。已保存规则保留。", "载入示例",
  )) return;
  $("load-demo").disabled = true;
  try {
    const saved = await change(base.revision, { action: "replace", backup: makeDemoBackup(base.presets) });
    if (workspace.revision === saved.revision) {
      rule = draftRule(DEMO_RULE);
      result = compareSnapshots(workspace.before, workspace.after, rule);
      resetFilters();
      showRules();
      showResults();
    }
    message("workbench-message");
  } catch (error) {
    message("workbench-message", error.message, "error");
  } finally {
    $("load-demo").disabled = false;
  }
});

$("advance").addEventListener("click", async () => {
  const base = workspace;
  if (!base?.after || !await confirmAction(
    "把本期转为下次上期？", "原上期将被替换，本期腾空。可以先在数据管理中备份。", "确认转期",
  )) return;
  try {
    await change(base.revision, { action: "advance" });
    message("workbench-message", "本期已转为上期。可以添加下一期。", "success");
  } catch (error) {
    message("workbench-message", error.message, "error");
  }
});

$("all-results").addEventListener("click", () => setFilter("all"));
$("result-search").addEventListener("input", () => {
  page = 0;
  renderRows();
});
$("previous-page").addEventListener("click", () => {
  page--;
  renderRows();
});
$("next-page").addEventListener("click", () => {
  page++;
  renderRows();
});
$("export").addEventListener("click", () => {
  if (!result) return;
  try {
    const workbook = makeReport(result, workspace.before, workspace.after);
    download(`账页核对-差异-${dateStamp()}.xlsx`,
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", workbook);
  } catch {
    message("workbench-message", "生成报表失败。请缩小核对范围后重试。", "error");
  }
});

async function removePeriod(slot) {
  const base = workspace;
  if (!await confirmAction(`删除${PERIODS[slot]}台账？`, "请确认已有备份或原始数据。", "确认删除")) return;
  try {
    await change(base.revision, { action: "remove-period", slot });
    message("manage-message", `${PERIODS[slot]}已删除。`, "success");
  } catch (error) {
    message("manage-message", error.message, "error");
  }
}

async function removePreset(name) {
  const base = workspace;
  if (!await confirmAction("移除已存规则？", name, "确认移除")) return;
  try {
    await change(base.revision, { action: "remove-preset", name });
    message("manage-message", "规则已移除。", "success");
  } catch (error) {
    message("manage-message", error.message, "error");
  }
}

$("manage").addEventListener("click", () => {
  if (!workspace) return;
  message("manage-message");
  renderManage();
  $("manage-dialog").showModal();
});
$("backup").addEventListener("click", () => {
  download(`账页核对-备份-${dateStamp()}.json`, "application/json", makeBackup(workspace));
  message("manage-message", "已请求下载备份。文件含两期台账，请按业务要求保存。", "success");
});
$("restore").addEventListener("click", () => $("restore-file").click());
$("restore-file").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  event.target.value = "";
  if (!file) return;
  const base = workspace;
  try {
    if (file.size > LIMITS.backupBytes) throw new Error("备份超过 3.2 MB。");
    let backup;
    try {
      backup = new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer());
    } catch {
      throw new Error("备份需要 UTF-8 编码。");
    }
    const data = readBackup(backup);
    if (!await confirmAction(
      "恢复这份备份？",
      `包含上期 ${data.before?.rows.length ?? 0} 条、本期 ${data.after?.rows.length ?? 0} 条及 ${data.presets.length} 条规则。将替换当前全部内容。`,
      "确认恢复",
    )) return;
    await change(base.revision, { action: "replace", backup });
    message("manage-message", "已恢复备份。", "success");
  } catch (error) {
    message("manage-message", error.message, "error");
  }
});
$("clear-data").addEventListener("click", async () => {
  const base = workspace;
  if (!await confirmAction("清除全部本地数据？", "两期台账和已存规则会从此浏览器删除。", "确认清除")) return;
  try {
    await change(base.revision, { action: "clear" });
    rule = draftRule();
    message("manage-message", "已清除全部台账和规则。", "success");
  } catch (error) {
    message("manage-message", error.message, "error");
  }
});

for (const button of document.querySelectorAll("[data-close]")) {
  button.addEventListener("click", () => $(button.dataset.close).close());
}

$("version").textContent = chrome.runtime.getManifest().version;
watchWorkspace(refresh);
void refresh();
