// Purchase delivery lines modeled on public vendor documentation. All values are fictional.
export const before = {
  headers: ["订单编号", "明细编号", "物料", "交期", "未收量"],
  rows: [
    ["CG-2408", "010", "螺栓", "2026-11-10", "120"],
    ["CG-2408", "020", "垫片", "2026-11-11", "240"],
    ["CG-2410", "001", "密封圈", "2026-11-13", "30"],
    ["CG-2410", "001", "密封圈", "2026-11-13", "40"],
    ["CG-2411", "001", "钢板", "2026-11-14", "50"],
    ["CG-2412", "", "螺母", "2026-11-14", "80"],
    ["CG-2413", "001", "轴承", "2026-11-14", "20"],
  ],
};

const afterInOriginalOrder = [
  ["CG-2408", "030", "螺母", "2026-11-12", "140"],
  ["CG-2413", "001", "轴承", "2026-11-14", "20"],
  ["CG-2410", "001", "密封圈", "2026-11-13", "50"],
  ["CG-2408", "020", "垫片", "2026-11-11", "240"],
  ["CG-2408", "010", "螺栓", "2026-11-12", "80"],
];
const order = [4, 1, 0, 2, 3];
export const after = {
  headers: order.map((i) => i === 1 ? "分录标识" : before.headers[i]),
  rows: afterInOriginalOrder.map((row) => order.map((i) => row[i])),
};
export const rule = {
  beforeKeys: ["订单编号", "明细编号"],
  afterKeys: ["订单编号", "分录标识"],
  fields: ["物料", "交期", "未收量"],
};
