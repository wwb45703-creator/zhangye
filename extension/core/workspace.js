import { byteLength, LIMITS, validateSnapshot } from "./snapshot.js";
import { validateRule } from "./compare.js";

export const STORAGE_KEY = "ledgerWorkspace";
const SCHEMA = 1;
export const emptyWorkspace = () => ({ schema: SCHEMA, revision: null, before: null, after: null, presets: [] });

function nameOfPreset(value) {
  if (typeof value !== "string" || !value.trim() || value.length > 40 ||
      !value.isWellFormed() || /[\p{Cc}]/u.test(value)) {
    throw new Error("规则名称需要 1–40 个可见字符。");
  }
  return value.trim();
}

export function readBackup(text) {
  if (byteLength(text) > LIMITS.backupBytes) throw new Error("备份超过 3.2 MB。");
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("无法读取 JSON 备份，请选择账页核对导出的文件。");
  }
  if (value?.format !== "zhangye-backup" || value?.schema !== SCHEMA ||
      !Array.isArray(value.presets) || value.presets.length > LIMITS.presets) {
    throw new Error("备份格式或版本不受支持。");
  }
  const presets = value.presets.map((preset) => ({
    name: nameOfPreset(preset?.name),
    ...validateRule(preset),
  }));
  if (new Set(presets.map(({ name }) => name)).size !== presets.length) {
    throw new Error("备份含重复的规则名称。");
  }
  return {
    before: value.before === null ? null : validateSnapshot(value.before),
    after: value.after === null ? null : validateSnapshot(value.after),
    presets,
  };
}

export function makeBackup(workspace) {
  const { before, after, presets } = workspace;
  return JSON.stringify({ format: "zhangye-backup", schema: SCHEMA, before, after, presets });
}

export function changeWorkspace(workspace, request) {
  if (workspace.schema !== SCHEMA) throw new Error("工作区版本不受支持，请使用兼容版本。");
  if (request.revision !== workspace.revision) {
    throw new Error("台账刚在其他窗口更新。请检查最新内容后再操作。");
  }
  const next = { ...workspace, revision: crypto.randomUUID() };
  const slot = request.slot;
  switch (request.action) {
    case "set-period":
    case "remove-period":
      if (slot !== "before" && slot !== "after") throw new Error("无效的期别。");
      next[slot] = request.action === "remove-period" ? null : validateSnapshot(request.snapshot);
      break;
    case "advance":
      if (!workspace.after) throw new Error("先添加本期台账。");
      next.before = workspace.after;
      next.after = null;
      break;
    case "save-preset": {
      const name = nameOfPreset(request.name);
      const existing = workspace.presets.some((item) => item.name === name);
      if (!existing && workspace.presets.length >= LIMITS.presets) {
        throw new Error(`最多保存 ${LIMITS.presets} 条规则，请先删除旧规则。`);
      }
      next.presets = [{ name, ...validateRule(request.rule) },
        ...workspace.presets.filter((item) => item.name !== name)];
      break;
    }
    case "remove-preset":
      next.presets = workspace.presets.filter((item) => item.name !== request.name);
      break;
    case "replace":
      Object.assign(next, readBackup(request.backup));
      break;
    case "clear":
      Object.assign(next, { before: null, after: null, presets: [] });
      break;
    default:
      throw new Error("操作不受支持。");
  }
  return next;
}
