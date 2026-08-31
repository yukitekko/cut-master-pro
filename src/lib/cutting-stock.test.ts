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

test("手持ち在庫を先に使い、不足分を購入材で補って全本数を配置する", () => {
  const result = solveCuttingStock(
    [{ length: 5000, availableCount: 1 }],
    4,
    [{ length: 3000, qty: 2, label: "P-01" }],
    { purchaseShortage: true },
  );

  assert.equal(result.bars.length, 2);
  assert.deepEqual(
    result.bars.map((bar) => bar.source),
    ["inventory", "purchase"],
  );
  assert.deepEqual(result.stockUsage, [
    {
      stockLength: 5000,
      count: 2,
      availableCount: 1,
      inventoryCount: 1,
      purchaseCount: 1,
    },
  ]);
  assert.equal(result.totalRequiredLength, 6000);
  assert.equal(result.inventoryShortage, null);
  assert.deepEqual(result.unfittable, []);
});

test("手持ちだけで足りる場合は追加購入を発生させない", () => {
  const result = solveCuttingStock(
    [{ length: 5000, availableCount: 3 }],
    4,
    [{ length: 3000, qty: 2 }],
    { purchaseShortage: true },
  );

  assert.equal(result.stockUsage[0]?.inventoryCount, 2);
  assert.equal(result.stockUsage[0]?.purchaseCount, 0);
  assert.equal(result.inventoryShortage, null);
});

test("手持ち0本なら全量を購入材として配置する", () => {
  const result = solveCuttingStock(
    [{ length: 5000, availableCount: 0 }],
    4,
    [{ length: 1000, qty: 3 }],
    { purchaseShortage: true },
  );

  assert.equal(result.stockUsage[0]?.inventoryCount, 0);
  assert.equal(result.stockUsage[0]?.purchaseCount, 1);
  assert.equal(result.bars[0]?.pieces.length, 3);
  assert.equal(result.inventoryShortage, null);
});

test("500本でも手持ちと購入を合わせて全本数を保持する", () => {
  const result = solveCuttingStock(
    [{ length: 5000, availableCount: 1 }],
    4,
    [{ length: 450, qty: 500 }],
    { purchaseShortage: true },
  );

  assert.equal(
    result.bars.reduce((sum, bar) => sum + bar.pieces.length, 0),
    500,
  );
  assert.equal(result.stockUsage[0]?.inventoryCount, 1);
  assert.equal(result.stockUsage[0]?.purchaseCount, result.totalStock - 1);
  assert.equal(result.inventoryShortage, null);
});

test("複数の定尺で手持ち数を守り、購入分の部材番号も保持する", () => {
  const result = solveCuttingStock(
    [
      { length: 6000, availableCount: 0 },
      { length: 4000, availableCount: 1 },
    ],
    4,
    [
      { length: 5500, qty: 1, label: "P-01" },
      { length: 3900, qty: 2, label: "P-02" },
    ],
    { purchaseShortage: true },
  );

  assert.deepEqual(result.stockUsage, [
    { stockLength: 6000, count: 1, availableCount: 0, inventoryCount: 0, purchaseCount: 1 },
    { stockLength: 4000, count: 2, availableCount: 1, inventoryCount: 1, purchaseCount: 1 },
  ]);
  const placed = result.bars.flatMap((bar) => bar.pieces);
  assert.deepEqual(
    placed
      .map(({ pieceIndex, label }) => ({ pieceIndex, label }))
      .sort((a, b) => a.pieceIndex - b.pieceIndex),
    [
      { pieceIndex: 0, label: "P-01" },
      { pieceIndex: 1, label: "P-02" },
      { pieceIndex: 1, label: "P-02" },
    ],
  );
  assert.equal(result.inventoryShortage, null);
  assert.equal(
    result.totalStockLength,
    result.totalRequiredLength + result.totalKerf + result.totalWaste,
  );
});

test("不足分を購入しても定尺より長い部材は切断不能のまま残す", () => {
  const result = solveCuttingStock(
    [{ length: 5000, availableCount: 0 }],
    4,
    [
      { length: 6000, qty: 1 },
      { length: 3000, qty: 2 },
    ],
    { purchaseShortage: true },
  );

  assert.deepEqual(result.unfittable, [{ length: 6000, qty: 1 }]);
  assert.equal(result.stockUsage[0]?.purchaseCount, 2);
  assert.equal(result.inventoryShortage, null);
});
