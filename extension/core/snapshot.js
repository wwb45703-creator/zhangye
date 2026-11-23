export const LIMITS = Object.freeze({
  rows: 5000,
  columns: 48,
  cell: 4096,
  header: 96,
  snapshotBytes: 1_500_000,
  backupBytes: 3_200_000,
  presets: 12,
});

export const byteLength = (text) => new TextEncoder().encode(text).length;

function plainText(value, limit, field) {
  if (typeof value !== "string" || value.length > limit ||
      !value.isWellFormed() || /[\x00-\x08\x0B\x0C\x0E-\x1F\uFFFE\uFFFF]/u.test(value)) {
    throw new Error(`${field}不是有效文本或超出 ${limit} 字限制。`);
  }
  return value;
}

function validateSource(meta) {
  if (!meta || !["web", "csv", "demo"].includes(meta.kind)) {
    throw new Error("找不到有效的数据来源。");
  }
  const label = plainText(meta.label, 120, "来源名称").trim();
  const at = plainText(meta.at, 30, "添加时间");
  if (!label || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(at) ||
      !Number.isFinite(Date.parse(at)) || new Date(at).toISOString() !== at) {
    throw new Error("来源名称或添加时间无效。");
  }
  if (meta.kind !== "web") return { kind: meta.kind, label, at };

  try {
    const origin = new URL(meta.origin);
    if (!["http:", "https:"].includes(origin.protocol) ||
        origin.origin !== meta.origin || origin.origin.length > 300) throw new Error();
    return { kind: "web", label, at, origin: origin.origin };
  } catch {
    throw new Error("网页来源必须是 HTTP 或 HTTPS 站点。");
  }
}

export function validateSnapshot(input) {
  if (!input || !Array.isArray(input.headers) ||
      input.headers.length < 2 || input.headers.length > LIMITS.columns) {
    throw new Error(`每张表需要 2–${LIMITS.columns} 列，首行是表头。`);
  }
  const headers = input.headers.map((value) => plainText(value, LIMITS.header, "表头").trim());
  if (headers.some((header) => !header)) throw new Error("表头含空列名，请补齐后重试。");
  if (new Set(headers).size !== headers.length) {
    throw new Error("表头有重复列名，请给每列使用唯一名称。");
  }
  if (!Array.isArray(input.rows) || input.rows.length > LIMITS.rows) {
    throw new Error(`每期最多 ${LIMITS.rows} 条记录，请缩小两期的核对范围。`);
  }
  const meta = validateSource(input.meta);
  let textUnits = 0;
  const rows = input.rows.map((row, index) => {
    if (!Array.isArray(row) || row.length !== headers.length) {
      throw new Error(`第 ${index + 1} 条数据的列数与表头不一致。`);
    }
    return row.map((cell) => {
      const value = plainText(cell, LIMITS.cell, `第 ${index + 1} 条数据的单元格`);
      textUnits += value.length;
      if (textUnits > LIMITS.snapshotBytes) throw new Error("单期数据太大，请缩小核对范围。");
      return value;
    });
  });
  const result = { headers, rows, meta };
  if (byteLength(JSON.stringify(result)) > LIMITS.snapshotBytes) {
    throw new Error("单期数据太大，请缩小核对范围。");
  }
  return result;
}

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let state = "start";
  let trailingEmpty = 0;
  text = text.replace(/^\uFEFF/u, "");

  const append = (char) => {
    cell += char;
    if (cell.length > LIMITS.cell) throw new Error(`单元格超过 ${LIMITS.cell} 字。`);
  };
  const endCell = () => {
    row.push(cell);
    if (row.length > LIMITS.columns) throw new Error(`最多支持 ${LIMITS.columns} 列。`);
    cell = "";
    state = "start";
  };
  const endRow = () => {
    // Spreadsheets can export formatted but unused rows at the bottom as ",,,".
    if (row.length || cell || state !== "start") {
      endCell();
      const width = rows[0]?.length;
      if (row.length === width && row.every((value) => value === "")) {
        trailingEmpty++;
      } else {
        if (rows.length + trailingEmpty >= LIMITS.rows + 1) {
          throw new Error(`每期最多 ${LIMITS.rows} 条记录。`);
        }
        while (trailingEmpty > 0) {
          rows.push(Array(width).fill(""));
          trailingEmpty--;
        }
        rows.push(row);
      }
      row = [];
    }
  };

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (state === "quoted") {
      if (char !== '"') append(char);
      else if (text[i + 1] === '"') {
        append('"');
        i++;
      } else state = "closed";
    } else if (char === ",") endCell();
    else if (char === "\r" || char === "\n") {
      endRow();
      if (char === "\r" && text[i + 1] === "\n") i++;
    } else if (state === "closed") throw new Error("CSV 引号结束后应为逗号或换行。");
    else if (char === '"') {
      if (state !== "start") throw new Error("CSV 的字段引号格式有误。");
      state = "quoted";
    } else {
      append(char);
      state = "unquoted";
    }
  }
  if (state === "quoted") throw new Error("CSV 中有未闭合的引号。");
  endRow();
  if (!rows.length) throw new Error("CSV 为空。");
  return rows;
}

export function importCsv(buffer, name, encoding = "auto", at = new Date().toISOString()) {
  if (buffer.byteLength > LIMITS.snapshotBytes) throw new Error("CSV 超过 1.5 MB，请缩小核对范围。");
  const bytes = new Uint8Array(buffer);
  const utf16 = (bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff);
  if (utf16) throw new Error("请另存为 UTF-8 或 GB18030 编码的 CSV。");
  const utf8Bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  let decoded;
  try {
    decoded = new TextDecoder(encoding === "gb18030" && !utf8Bom ? "gb18030" : "utf-8", {
      fatal: true,
    }).decode(bytes);
  } catch {
    if (encoding !== "auto" || utf8Bom) throw new Error("文件与所选编码不匹配。");
    try {
      decoded = new TextDecoder("gb18030", { fatal: true }).decode(bytes);
    } catch {
      throw new Error("无法解码文件，请另存为 UTF-8 CSV。");
    }
  }
  const [headers, ...rows] = parseCsv(decoded);
  return validateSnapshot({ headers, rows, meta: { kind: "csv", label: name.toWellFormed().slice(0, 120).toWellFormed(), at } });
}
