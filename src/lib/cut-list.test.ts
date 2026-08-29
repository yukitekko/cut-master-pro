import assert from "node:assert/strict";
import test from "node:test";
import { buildCompactCuttingOrder, buildCuttingOrder } from "./cut-list.ts";
import { solveCuttingStock, type CutResult } from "./cutting-stock.ts";

test("定尺ごとに長い順で並べ、パイプ番号を保持する", () => {
  const result: CutResult = {
    bars: [
      {
        stockLength: 5500,
        pieces: [
          { length: 370, pieceIndex: 0, label: "BR-4-11①" },
          { length: 1780, pieceIndex: 1, label: "BR-4-12" },
          { length: 574, pieceIndex: 2, label: "BR-4-14②" },
        ],
        used: 2732,
        waste: 2768,
      },
      {
        stockLength: 4000,
        pieces: [{ length: 1700, pieceIndex: 3, label: "BR-5-12" }],
        used: 1700,
        waste: 2300,
      },
    ],
    stockUsage: [
      { stockLength: 5500, count: 1 },
      { stockLength: 4000, count: 1 },
    ],
    totalStock: 2,
    totalRequiredLength: 4432,
    totalStockLength: 9500,
    totalKerf: 8,
    totalWaste: 5060,
    yieldRate: 4432 / 9500,
    unfittable: [],
  };

  const order = buildCuttingOrder(result, []);

  assert.deepEqual(
    order[0]?.cuts.map((cut) => [cut.sequence, cut.length, cut.label]),
    [
      [1, 1780, "BR-4-12"],
      [2, 574, "BR-4-14②"],
      [3, 370, "BR-4-11①"],
    ],
  );
  assert.equal(order[1]?.cuts[0]?.sequence, 4);
  assert.equal(order[1]?.waste, 2300);
});

test("最適化結果へ入力時の部材名を引き継ぐ", () => {
  const result = solveCuttingStock([3000], 3, [
    { length: 1000, qty: 1, label: "P-01" },
    { length: 800, qty: 1, label: "P-02" },
  ]);

  assert.deepEqual(
    result.bars[0]?.pieces.map((piece) => piece.label),
    ["P-01", "P-02"],
  );
});

test("同じ定尺内の同一寸法・部材名をまとめて本数を保持する", () => {
  const result: CutResult = {
    bars: [
      {
        stockLength: 5000,
        pieces: [
          { length: 1200, pieceIndex: 0, label: "P-01" },
          { length: 1200, pieceIndex: 0, label: "P-01" },
          { length: 1200, pieceIndex: 1, label: "P-02" },
          { length: 800, pieceIndex: 2, label: "P-03" },
        ],
        used: 4400,
        waste: 600,
      },
    ],
    stockUsage: [{ stockLength: 5000, count: 1 }],
    totalStock: 1,
    totalRequiredLength: 4400,
    totalStockLength: 5000,
    totalKerf: 0,
    totalWaste: 600,
    yieldRate: 0.88,
    unfittable: [],
  };

  const compactOrder = buildCompactCuttingOrder(result, []);

  assert.deepEqual(compactOrder[0]?.groups, [
    { length: 1200, label: "P-01", quantity: 2 },
    { length: 1200, label: "P-02", quantity: 1 },
    { length: 800, label: "P-03", quantity: 1 },
  ]);
});
