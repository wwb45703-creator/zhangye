// Fictional orders. Expected results are separately asserted by the browser and Excel checks.
export const before = {
  headers: ["订单编号", "供应商", "交付状态", "约定交期", "数量", "备注"],
  rows: [
    ["0007", "东岸五金", "待发货", "2026-11-07", "80", "_x0041_"],
    ["CG-001", "青岸包材", "待确认", "2026-11-09", "45", "普通订单"],
    ["CG-002", "海屿工业", "待发货", "2026-11-09", "120", ""],
    ["DUP-03", "北桥配件", "待发货", "2026-11-11", "240", ""],
    ["DUP-03", "北桥配件", "已确认", "2026-11-11", "70", ""],
    ["SAME-01", "川途设备", "已收货", "2026-11-06", "180", ""],
    ["", "沐风机械", "已确认", "2026-11-14", "20", "缺订单号"],
  ],
};

const orderedAfter = [
  ["CG-001", "青岸包材", "已确认", "2026-11-09", "45", '<img src=x onerror="window.xss=1">'],
  ["DUP-03", "北桥配件", "已发货", "2026-11-11", "310", ""],
  ["SAME-01", "川途设备", "已收货", "2026-11-06", "180", ""],
  ["0007", "东岸五金", "已发货", "2026-11-08", "120", "=1+1"],
  ["7", "森屿五金", "已确认", "2026-11-10", "60", ""],
  ["CG-004", "雨江材料", "待发货", "2026-11-10", "480", ""],
];
const order = [2, 0, 5, 1, 4, 3];
export const after = {
  headers: order.map((i) => i === 0 ? "采购单号" : before.headers[i]),
  rows: orderedAfter.map((row) => order.map((i) => row[i])),
};

export const rule = { beforeKey: "订单编号", afterKey: "采购单号", fields: before.headers.slice(1) };

export function toCsv(table) {
  return [table.headers, ...table.rows].map((row) =>
    row.map((cell) => '"' + cell.replaceAll('"', '""') + '"').join(",")).join("\r\n");
}

export function fixturePage(table, label, unmarkedHeader = false) {
  const escape = (value) => value.replace(/[&<>"]/g, (character) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[character]);
  const row = (cells, kind, attribute = "") =>
    `<tr ${attribute}>${cells.map((value) => `<${kind}>${escape(value)}</${kind}>`).join("")}</tr>`;
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>本机验收样例</title>
<style>body{font:14px sans-serif;margin:35px} table{border-collapse:collapse;margin-bottom:18px} td,th{border:1px solid #ddd;padding:8px}</style>
<h1>${escape(label)}（合成样例）</h1>
<table><caption>${escape(label)}</caption>${unmarkedHeader ? "" : `<thead>${row(table.headers, "th")}</thead>`}
<tbody>${unmarkedHeader ? row(table.headers, "td") : ""}${table.rows.map((values) => row(values, "td")).join("")}
${row(table.headers.map(() => "HIDDEN"), "td", "hidden")}</tbody></table>
<table><thead><tr><th colspan="2">不兼容表格</th></tr></thead><tr><td>A</td><td>B</td></tr></table>
<table hidden><thead><tr><th>ID</th><th>隐藏</th></tr></thead><tr><td>LEAK</td><td>行</td></tr></table>
</html>`;
}
