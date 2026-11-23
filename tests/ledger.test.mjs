import assert from "node:assert/strict";
import { test } from "node:test";
import { compareSnapshots } from "../extension/core/compare.js";
import { makeReport } from "../extension/core/report.js";
import { LIMITS, importCsv, parseCsv, validateSnapshot } from "../extension/core/snapshot.js";
import { changeWorkspace, emptyWorkspace, makeBackup, readBackup } from "../extension/core/workspace.js";
import { crc32 } from "../extension/core/zip.js";
import { before, after, rule } from "./fixtures/ledger.mjs";
import * as delivery from "./fixtures/delivery-lines.mjs";

const at = "2026-11-08T01:02:03.000Z";
const csv = (text, encoding = "auto") => importCsv(new TextEncoder().encode(text), "验收.csv", encoding, at);
const snapshot = (table) => validateSnapshot({ ...table, meta: { kind: "csv", label: "验收.csv", at } });
const prior = snapshot(before);
const current = snapshot(after);

test("CSV handles UTF-8 BOM, quotes, newlines, commas, and leading zeros", () => {
  const result = csv('\uFEFF单号,备注,状态\r\n0007,"一行, ""引号""\r\n二行",待确认\r\n\r\n,,\r\n,有内容,待确认\r\n,,');
  assert.deepEqual(result.rows, [["0007", '一行, "引号"\r\n二行', "待确认"], ["", "", ""], ["", "有内容", "待确认"]]);
});

test("GB18030 fallback decodes Chinese CSV while rejecting invalid bytes", () => {
  const bytes = Uint8Array.from(Buffer.from("b5a5bac52cd7b4ccac0a303030372ccdeab3c9", "hex"));
  assert.deepEqual(importCsv(bytes, "验收.csv", "auto", at).rows, [["0007", "完成"]]);
  assert.throws(() => importCsv(bytes, "验收.csv", "utf-8", at), /编码/);
  assert.throws(() => importCsv(Uint8Array.of(0xff, 0xfe, 0x41, 0), "验收.csv", "auto", at), /另存/);
});

test("malformed quotes and inconsistent, duplicate, or empty headers fail", () => {
  assert.throws(() => parseCsv('ID,值\n0007,"待核对'), /未闭合/);
  assert.throws(() => parseCsv('ID,值\n0007,"待核对"x'), /逗号/);
  assert.throws(() => csv("ID,值\n0007"), /列数/);
  assert.throws(() => csv("ID, ID\n1,1"), /重复/);
  assert.throws(() => csv("ID,\n1,1"), /空列名/);
});

test("rejects oversized or malformed cells without truncated results", () => {
  assert.throws(() => csv("ID,值\n1," + "a".repeat(LIMITS.cell + 1)), /单元格/);
  assert.throws(() => csv("ID,值\n" + "1,2\n".repeat(LIMITS.rows + 1)), /最多/);
  assert.throws(() => csv("ID,值\n1,\u0000"), /有效文本/);
  assert.throws(() => csv("a".repeat(LIMITS.snapshotBytes + 1)), /1.5 MB/);
  assert.equal(csv("ID,值\n" + "1,2\n".repeat(LIMITS.rows) + ",\n,\n").rows.length, LIMITS.rows);
  assert.throws(() => csv("ID,值\n" + ",\n".repeat(LIMITS.rows) + "1,2"), /最多/);
});

test("aligns renamed keys and reordered columns, keeping identifiers as text", () => {
  const result = compareSnapshots(prior, current, rule);
  assert.deepEqual(result.counts, { changed: 2, added: 2, missing: 1, review: 2, unchanged: 1 });
  assert.deepEqual(result.entries.added.map(({ key }) => key), ["7", "CG-004"]);
  assert.equal(result.entries.missing[0].key, "CG-002");
  const record = result.entries.changed.find(({ key }) => key === "0007");
  assert.deepEqual(record.changes.map(({ field }) => field), ["交付状态", "约定交期", "数量", "备注"]);
  assert.equal(record.beforeRows[0].number, 1);
  assert.equal(record.afterRows[0].number, 4);
});

test("withholds all matching rows when either period has a duplicate key", () => {
  const first = csv("ID,字段\n a ,1\na,2\nB,3\n ,4");
  const next = csv("ID,字段\nA,1\na,2\nB,3\nB,9\n,0");
  const result = compareSnapshots(first, next, { beforeKey: "ID", afterKey: "ID", fields: ["字段"] });
  assert.deepEqual(result.entries.review.map(({ reason, key, beforeRows, afterRows }) =>
    [reason, key, beforeRows.length, afterRows.length]), [
    ["duplicate", "a", 2, 1], ["duplicate", "B", 1, 2],
    ["blank", "", 1, 0], ["blank", "", 0, 1],
  ]);
  assert.equal(result.entries.added[0].key, "A");
  assert.equal(result.counts.changed, 0);
  assert.equal(result.counts.missing, 0);
});

test("pairs delivery lines by the full identity even if the order repeats and rows are rearranged", () => {
  const result = compareSnapshots(snapshot(delivery.before), snapshot(delivery.after), delivery.rule);
  assert.deepEqual(result.counts, { changed: 1, added: 1, missing: 1, review: 2, unchanged: 2 });
  const [changed] = result.entries.changed;
  assert.equal(changed.key, "CG-2408");
  assert.equal(changed.detailKey, "010");
  assert.equal(changed.beforeRows[0].number, 1);
  assert.equal(changed.afterRows[0].number, 5);
  assert.deepEqual(changed.changes, [
    { field: "交期", oldValue: "2026-11-10", newValue: "2026-11-12" },
    { field: "未收量", oldValue: "120", newValue: "80" },
  ]);
  assert.deepEqual(result.entries.review.map(({ key, detailKey, reason }) => [key, detailKey, reason]),
    [["CG-2410", "001", "duplicate"], ["CG-2412", "", "blank"]]);
});

test("composite identifiers preserve distinct text parts including common separators", () => {
  const first = csv("单号,编号,数量\na|b,c,1\na,b|c,2\n001,1,7\n1,1,9");
  const next = csv("单号,编号,数量\n1,1,9\na,b|c,2\na|b,c,3\n001,1,7");
  const selection = { beforeKeys: ["单号", "编号"], afterKeys: ["单号", "编号"], fields: ["数量"] };
  const result = compareSnapshots(first, next, selection);
  assert.deepEqual(result.counts, { changed: 1, added: 0, missing: 0, review: 0, unchanged: 3 });
  assert.deepEqual(result.entries.changed.map(({ key, detailKey }) => [key, detailKey]), [["a|b", "c"]]);
  assert.throws(() => compareSnapshots(first, next, { ...selection, afterKeys: ["单号", "单号"] }), /第二列/);
  assert.throws(() => compareSnapshots(first, next, { ...selection, afterKeys: ["单号"] }), /第二列/);
});

test("header-only lists remain explicit, selected fields control scope, invalid rules fail", () => {
  const first = csv("ID,字段,其他\n01,1,a");
  const empty = csv("ID,字段,其他");
  const next = csv("ID,字段,其他\n01,1,b");
  const select = { beforeKey: "ID", afterKey: "ID", fields: ["字段"] };
  assert.equal(compareSnapshots(first, empty, select).counts.missing, 1);
  assert.equal(compareSnapshots(first, next, select).counts.unchanged, 1);
  assert.throws(() => compareSnapshots(first, next, { ...select, fields: ["无效"] }), /不匹配/);
});

test("does not compare demonstration and real snapshots", () => {
  const demo = { ...current, meta: { ...current.meta, kind: "demo" } };
  assert.throws(() => compareSnapshots(prior, demo, rule), /示例/);
});

test("compares the full supported row count with changes at distant rows", () => {
  const original = Array.from({ length: LIMITS.rows }, (_, i) => [`ID-${i}`, "未确认"]);
  const revised = [...original];
  revised[2500] = ["ID-2500", "已确认"];
  revised[LIMITS.rows - 1] = ["ID-new", "未确认"];
  revised.reverse();
  const asTable = (rows) => snapshot({ headers: ["单号", "状态"], rows });
  const output = compareSnapshots(asTable(original), asTable(revised),
    { beforeKey: "单号", afterKey: "单号", fields: ["状态"] });
  assert.deepEqual(output.counts, { changed: 1, added: 1, missing: 1, review: 0, unchanged: LIMITS.rows - 2 });
  assert.equal(output.entries.changed[0].key, "ID-2500");
  assert.equal(output.entries.missing[0].key, `ID-${LIMITS.rows - 1}`);
});

test("backups round-trip and corrupted backups cannot modify the working data", () => {
  const initial = emptyWorkspace();
  const stored = changeWorkspace(initial, { revision: null, action: "set-period", slot: "before", snapshot: prior });
  const backup = makeBackup(stored);
  assert.deepEqual(readBackup(backup), { before: prior, after: null, presets: [] });
  const invalid = backup.replace('"schema":1', '"schema":999');
  assert.throws(() => changeWorkspace(stored, { revision: stored.revision, action: "replace", backup: invalid }), /版本/);
  assert.deepEqual(stored.before, prior);
  const leak = { ...prior, meta: { ...prior.meta, kind: "web", origin: "https://example.com/?private=true" } };
  assert.throws(() => validateSnapshot(leak), /来源/);
});

test("revisions prevent stale overwrites, including after clearing", () => {
  let state = changeWorkspace(emptyWorkspace(), { revision: null, action: "set-period", slot: "after", snapshot: current });
  const beforeClear = state.revision;
  state = changeWorkspace(state, { revision: state.revision, action: "advance" });
  assert.deepEqual(state.before, current);
  assert.equal(state.after, null);
  state = changeWorkspace(state, { revision: state.revision, action: "clear" });
  assert.notEqual(state.revision, beforeClear);
  assert.throws(() => changeWorkspace(state, { revision: beforeClear, action: "replace", backup: "{}" }), /其他窗口/);
});

test("named rules are replaceable and backup validates rule structure", () => {
  let state = changeWorkspace(emptyWorkspace(), { revision: null, action: "save-preset", name: "采购周报", rule });
  const narrower = { ...rule, fields: ["数量"] };
  state = changeWorkspace(state, { revision: state.revision, action: "save-preset", name: "采购周报", rule: narrower });
  assert.deepEqual(readBackup(makeBackup(state)).presets, [{ name: "采购周报", ...narrower }]);
  assert.throws(() => readBackup(makeBackup({ ...state, presets: [{ name: "无效", ...rule, fields: [] }] })), /核对字段/);
});

test("previous single-key presets and new compound presets coexist after backup restoration", () => {
  const baseline = { ...emptyWorkspace(), presets: [{ name: "旧单号规则", ...rule }] };
  const next = changeWorkspace(baseline, {
    revision: baseline.revision, action: "save-preset", name: "交货明细", rule: delivery.rule,
  });
  const restored = readBackup(makeBackup(next));
  assert.deepEqual(restored.presets, [{ name: "交货明细", ...delivery.rule }, baseline.presets[0]]);
  assert.equal(Object.hasOwn(restored.presets[0], "beforeKey"), false);
});

test("Excel archive has valid entry CRCs and formula-like input as inline text", () => {
  const workbook = makeReport(compareSnapshots(prior, current, rule), prior, current);
  const view = new DataView(workbook.buffer);
  const decoder = new TextDecoder();
  const files = new Map();
  for (let cursor = 0; view.getUint32(cursor, true) === 0x04034b50;) {
    const length = view.getUint32(cursor + 18, true);
    const nameLength = view.getUint16(cursor + 26, true);
    const start = cursor + 30;
    const name = decoder.decode(workbook.subarray(start, start + nameLength));
    const data = workbook.subarray(start + nameLength, start + nameLength + length);
    assert.equal(crc32(data), view.getUint32(cursor + 14, true));
    files.set(name, decoder.decode(data));
    cursor = start + nameLength + length;
  }
  assert.match(files.get("xl/worksheets/sheet1.xml"), /t="inlineStr"><is><t xml:space="preserve">0007<\/t>/);
  assert.match(files.get("xl/worksheets/sheet2.xml"), />=1\+1<\/t>/);
  assert.match(files.get("xl/worksheets/sheet2.xml"), />_x005F_x0041_<\/t>/);
  assert.doesNotMatch(files.get("xl/worksheets/sheet2.xml"), /<f[\s>]/);
});
