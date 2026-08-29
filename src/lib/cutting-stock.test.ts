import assert from "node:assert/strict";
import test from "node:test";
import { solveCuttingStock } from "./cutting-stock.ts";

test("本数未指定の定尺材は従来どおり制限なく使える", () => {
  const result = solveCuttingStock([5000], 0, [{ length: 3000, qty: 2 }]);

  assert.equal(result.bars.length, 2);
  assert.equal(result.stockUsage[0]?.count, 2);
  assert.equal(result.stockUsage[0]?.availableCount, undefined);
  assert.equal(result.inventoryShortage, null);
});

test("指定した手持ち本数を超えて定尺材を使わない", () => {
  const result = solveCuttingStock([{ length: 5000, availableCount: 1 }], 0, [
    { length: 3000, qty: 2, label: "P-01" },
  ]);

  assert.equal(result.bars.length, 1);
  assert.deepEqual(result.stockUsage, [{ stockLength: 5000, count: 1, availableCount: 1 }]);
  assert.deepEqual(result.inventoryShortage?.pieces, [{ length: 3000, qty: 1, label: "P-01" }]);
  assert.deepEqual(result.inventoryShortage?.suggestedStock, [{ stockLength: 5000, count: 1 }]);
});

test("複数の定尺長それぞれの在庫本数を守って配置する", () => {
  const result = solveCuttingStock(
    [
      { length: 5000, availableCount: 1 },
      { length: 3000, availableCount: 1 },
    ],
    0,
    [{ length: 2800, qty: 2 }],
  );

  assert.equal(result.bars.length, 2);
  assert.deepEqual(
    result.stockUsage.map(({ stockLength, count, availableCount }) => ({
      stockLength,
      count,
      availableCount,
    })),
    [
      { stockLength: 5000, count: 1, availableCount: 1 },
      { stockLength: 3000, count: 1, availableCount: 1 },
    ],
  );
  assert.equal(result.inventoryShortage, null);
});

test("同じ長さの在庫行は本数を合算する", () => {
  const result = solveCuttingStock(
    [
      { length: 5000, availableCount: 1 },
      { length: 5000, availableCount: 2 },
    ],
    0,
    [{ length: 3000, qty: 3 }],
  );

  assert.deepEqual(result.stockUsage, [{ stockLength: 5000, count: 3, availableCount: 3 }]);
  assert.equal(result.inventoryShortage, null);
});

test("在庫0本は長さ超過ではなく在庫不足として通知する", () => {
  const result = solveCuttingStock([{ length: 5000, availableCount: 0 }], 4, [
    { length: 1000, qty: 3 },
  ]);

  assert.equal(result.bars.length, 0);
  assert.deepEqual(result.unfittable, []);
  assert.deepEqual(result.inventoryShortage?.pieces, [{ length: 1000, qty: 3 }]);
  assert.deepEqual(result.inventoryShortage?.suggestedStock, [{ stockLength: 5000, count: 1 }]);
});

test("定尺より長い部材は在庫不足と分けて通知する", () => {
  const result = solveCuttingStock([{ length: 5000, availableCount: 0 }], 4, [
    { length: 6000, qty: 1 },
  ]);

  assert.deepEqual(result.unfittable, [{ length: 6000, qty: 1 }]);
  assert.equal(result.inventoryShortage, null);
});
