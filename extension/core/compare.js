import { LIMITS } from "./snapshot.js";

export const CATEGORIES = Object.freeze({
  changed: "字段变更",
  added: "仅本期有",
  missing: "本期未见",
  review: "待复核",
});
export const PERIODS = { before: "上期", after: "本期" };

export function keyColumns(rule, period) {
  return rule?.[`${period}Keys`] ?? [rule?.[`${period}Key`]];
}

export function matchingFields(before, after, rule) {
  if (!before || !after) return [];
  const available = new Set(after.headers);
  const keys = new Set([...keyColumns(rule, "before"), ...keyColumns(rule, "after")]);
  return before.headers.filter((name) => !keys.has(name) && available.has(name));
}

export function validateRule(input) {
  const isHeader = (value) => typeof value === "string" && value.length <= LIMITS.header &&
    Boolean(value) && value === value.trim() && value.isWellFormed();
  const beforeKeys = keyColumns(input, "before");
  const afterKeys = keyColumns(input, "after");
  const validKeys = (keys) => Array.isArray(keys) && keys.length >= 1 && keys.length <= 2 &&
    [...keys].every(isHeader) && new Set(keys).size === keys.length;
  if (!validKeys(beforeKeys) || !validKeys(afterKeys) || beforeKeys.length !== afterKeys.length) {
    throw new Error("请选择两期的主键。启用明细编号时，两期都需要选择不同的第二列。");
  }
  const keys = new Set([...beforeKeys, ...afterKeys]);
  if (!input ||
      !Array.isArray(input.fields) || !input.fields.length || input.fields.length > LIMITS.columns ||
      !input.fields.every(isHeader) || new Set(input.fields).size !== input.fields.length ||
      input.fields.some((field) => keys.has(field))) {
    throw new Error("请至少选择一个同名核对字段。");
  }
  const fields = [...input.fields];
  if (beforeKeys.length === 1) return { beforeKey: beforeKeys[0], afterKey: afterKeys[0], fields };
  return { beforeKeys: [...beforeKeys], afterKeys: [...afterKeys], fields };
}

export function ruleFits(rule, before, after) {
  if (!rule || !before || !after) return false;
  const beforeKeys = keyColumns(rule, "before");
  const afterKeys = keyColumns(rule, "after");
  if (beforeKeys.length !== afterKeys.length || !beforeKeys.length ||
      !beforeKeys.every((key) => before.headers.includes(key)) ||
      !afterKeys.every((key) => after.headers.includes(key))) {
    return false;
  }
  const common = new Set(matchingFields(before, after, rule));
  return rule.fields.every((field) => common.has(field));
}

function entryKeys([key, detailKey]) {
  return detailKey === undefined ? { key } : { key, detailKey };
}

function groupByKey(snapshot, columns) {
  const indices = columns.map((column) => snapshot.headers.indexOf(column));
  const groups = new Map();
  const blank = [];
  snapshot.rows.forEach((values, index) => {
    const row = { number: index + 1, values };
    const identity = indices.map((i) => values[i].trim());
    if (identity.some((part) => !part)) {
      blank.push({ row, keys: entryKeys(identity) });
      return;
    }
    const token = JSON.stringify(identity);
    if (!groups.has(token)) groups.set(token, []);
    groups.get(token).push(row);
  });
  return { groups, blank };
}

export function compareSnapshots(before, after, config) {
  if (!before || !after) throw new Error("请先添加上期和本期台账。");
  if ((before.meta.kind === "demo") !== (after.meta.kind === "demo")) {
    throw new Error("两期都使用示例或都使用业务数据。请替换另一张表。");
  }
  const rule = validateRule(config);
  if (!ruleFits(rule, before, after)) {
    throw new Error("规则中的列与本次表头不匹配，请重新选择。");
  }

  const prior = groupByKey(before, keyColumns(rule, "before"));
  const current = groupByKey(after, keyColumns(rule, "after"));
  const fields = rule.fields.map((name) => ({
    name,
    before: before.headers.indexOf(name),
    after: after.headers.indexOf(name),
  }));
  const entries = { changed: [], added: [], missing: [], review: [] };
  let unchanged = 0;

  for (const token of new Set([...prior.groups.keys(), ...current.groups.keys()])) {
    const beforeRows = prior.groups.get(token) ?? [];
    const afterRows = current.groups.get(token) ?? [];
    const record = { ...entryKeys(JSON.parse(token)), beforeRows, afterRows };
    if (beforeRows.length > 1 || afterRows.length > 1) {
      entries.review.push({ type: "review", reason: "duplicate", ...record });
    } else if (!beforeRows.length) {
      entries.added.push({ type: "added", ...record });
    } else if (!afterRows.length) {
      entries.missing.push({ type: "missing", ...record });
    } else {
      const changes = [];
      for (const field of fields) {
        const oldValue = beforeRows[0].values[field.before];
        const newValue = afterRows[0].values[field.after];
        if (oldValue !== newValue) changes.push({ field: field.name, oldValue, newValue });
      }
      if (changes.length) entries.changed.push({ type: "changed", ...record, changes });
      else unchanged++;
    }
  }
  for (const { row, keys } of prior.blank) {
    entries.review.push({ type: "review", reason: "blank", ...keys, beforeRows: [row], afterRows: [] });
  }
  for (const { row, keys } of current.blank) {
    entries.review.push({ type: "review", reason: "blank", ...keys, beforeRows: [], afterRows: [row] });
  }
  const counts = { unchanged };
  for (const [type, records] of Object.entries(entries)) counts[type] = records.length;
  return { entries, counts, rule };
}

export function entrySummary(entry) {
  if (entry.reason === "duplicate") {
    return entry.detailKey === undefined ? "主键重复，需逐行核实" : "主键组合重复，需逐行核实";
  }
  if (entry.reason === "blank") return entry.key ? "明细编号为空，无法配对" : "主键为空，无法配对";
  if (entry.type === "added") return "仅在本期输入找到";
  if (entry.type === "missing") return "本期输入范围内未找到";
  return entry.changes.map(({ field }) => field).join("、");
}
