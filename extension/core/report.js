import { CATEGORIES, entrySummary, keyColumns } from "./compare.js";
import { makeZip } from "./zip.js";

const prolog = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const sheetNs = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const relNs = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const packageNs = "http://schemas.openxmlformats.org/package/2006";

function textXml(value) {
  // SpreadsheetML reserves _xHHHH_ sequences and normalizes raw carriage returns.
  return value.replace(/_x[\da-f]{4}_/giu, (escape) => "_x005F_" + escape.slice(1))
    .replace(/\r/g, "_x000D_")
    .replace(/[&<>"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[character]);
}

function worksheet(headers, widths, rows) {
  const columns = widths.map((width, i) => `<col min="${i + 1}" max="${i + 1}" width="${width}" customWidth="1"/>`).join("");
  const makeRow = (values, number) => {
    const cells = values.map((value, i) => {
      const address = String.fromCharCode(65 + i) + number;
      if (typeof value === "number") return `<c r="${address}"><v>${value}</v></c>`;
      return `<c r="${address}"${number === 1 ? ' s="1"' : ""} t="inlineStr"><is><t xml:space="preserve">${textXml(value)}</t></is></c>`;
    }).join("");
    return `<row r="${number}">${cells}</row>`;
  };
  return prolog + `<worksheet xmlns="${sheetNs}">
<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView></sheetViews>
<sheetFormatPr defaultRowHeight="18"/><cols>${columns}</cols>
<sheetData>${makeRow(headers, 1)}${rows.map((row, index) => makeRow(row, index + 2)).join("")}</sheetData>
<autoFilter ref="A1:${String.fromCharCode(64 + headers.length)}${rows.length + 1}"/>
</worksheet>`;
}

const styles = prolog + `<styleSheet xmlns="${sheetNs}">
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF244A3F"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/></cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

const rowNumbers = (rows) => rows.map(({ number }) => number).join(", ");

export function makeReport(result, before, after) {
  const usesDetail = keyColumns(result.rule, "before").length === 2;
  const details = [];
  const fields = [];
  for (const records of Object.values(result.entries)) {
    for (const entry of records) {
      const number = details.length + 1;
      const row = [number, CATEGORIES[entry.type], entry.key];
      if (usesDetail) row.push(entry.detailKey);
      row.push(entrySummary(entry), rowNumbers(entry.beforeRows), rowNumbers(entry.afterRows));
      details.push(row);
      for (const change of entry.changes ?? []) {
        fields.push([number, change.field, change.oldValue, change.newValue]);
      }
    }
  }

  const sources = [];
  for (const [period, snapshot] of [["上期", before], ["本期", after]]) {
    sources.push(
      [period + "来源", snapshot.meta.label],
      [period + "站点", snapshot.meta.origin ?? "—"],
      [period + "时间 UTC", snapshot.meta.at],
      [period + "记录数", snapshot.rows.length],
    );
  }
  const notes = [
    ["使用范围", "结果仅基于两期输入。当前页的分页和筛选可能影响记录范围。"],
    ["本期未见", "在本期输入中未配对，需回原系统核实。"],
    ["行号", "数据行序从首条正文的 1 起算，表头不计入。"],
    ["待复核", usesDetail
      ? "完整的主键组合重复时整组计一项。任一编号为空时每行计一项。"
      : "同一主键任一期重复时整组计一项。空键每行计一项。"],
    ["数据类型", before.meta.kind === "demo" ? "合成示例" : "用户输入"],
    ...sources,
    ["上期主键", keyColumns(result.rule, "before").join(" + ")],
    ["本期主键", keyColumns(result.rule, "after").join(" + ")],
    ["核对字段", result.rule.fields.join("、")],
    ...Object.entries(CATEGORIES).map(([type, label]) => [label, result.counts[type]]),
    ["无变化", result.counts.unchanged],
  ];

  const detailHeaders = ["差异号", "类型", "主键", "摘要", "上期行号", "本期行号"];
  const detailWidths = [12, 16, 22, 45, 18, 18];
  if (usesDetail) {
    detailHeaders.splice(3, 0, "明细编号");
    detailWidths.splice(3, 0, 20);
  }
  const sheets = [
    ["差异清单", worksheet(detailHeaders, detailWidths, details)],
    ["字段前后值", worksheet(["差异号", "字段", "上期值", "本期值"], [12, 22, 38, 38], fields)],
    ["核对说明", worksheet(["项目", "值"], [21, 75], notes)],
  ];
  const rel = (id, kind, target) => `<Relationship Id="${id}" Type="${relNs}/${kind}" Target="${target}"/>`;
  const workbook = prolog + `<workbook xmlns="${sheetNs}" xmlns:r="${relNs}">
<bookViews><workbookView activeTab="0"/></bookViews><sheets>${sheets.map(([name], i) =>
    `<sheet name="${name}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>`;
  const links = sheets.map((_, i) => rel(`rId${i + 1}`, "worksheet", `worksheets/sheet${i + 1}.xml`)).join("");
  const contentType = (path, kind) => `<Override PartName="${path}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.${kind}+xml"/>`;
  const types = prolog + `<Types xmlns="${packageNs}/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
${contentType("/xl/workbook.xml", "sheet.main")}
${contentType("/xl/styles.xml", "styles")}
${sheets.map((_, i) => contentType(`/xl/worksheets/sheet${i + 1}.xml`, "worksheet")).join("")}</Types>`;
  return makeZip([
    ["[Content_Types].xml", types],
    ["_rels/.rels", prolog + `<Relationships xmlns="${packageNs}/relationships">${rel("rId1", "officeDocument", "xl/workbook.xml")}</Relationships>`],
    ["xl/workbook.xml", workbook],
    ["xl/_rels/workbook.xml.rels", prolog + `<Relationships xmlns="${packageNs}/relationships">${links}${rel("rIdStyles", "styles", "styles.xml")}</Relationships>`],
    ["xl/styles.xml", styles],
    ...sheets.map(([, xml], i) => [`xl/worksheets/sheet${i + 1}.xml`, xml]),
  ]);
}
