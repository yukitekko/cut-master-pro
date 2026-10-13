import assert from "node:assert/strict";
import test from "node:test";
import { solveCuttingStock } from "./cutting-stock.ts";
import { solveWithOffcuts } from "./offcut-planning.ts";
import {
  OFFCUT_BANK_KEY,
  completeCutting,
  emptyOffcutBank,
  readOffcutBank,
} from "./offcut-bank.ts";
import { createCalculationInputKey } from "./project-storage.ts";
import type { ProjectMaterial, ProjectMaterialCalculation } from "./project-storage.ts";

test("計算方式の版番号がない旧完了記録も読み込める", () => {
  const material: ProjectMaterial = {
    id: "material-1",
    workId: "work-1",
    name: "SGP",
    specification: "50A",
    stockMode: "inventory",
    stocks: [{ id: "stock-1", length: "5000", quantity: "1" }],
    kerf: "4",
    pieces: [{ id: "piece-1", name: "P-01", length: "1000", qty: "1" }],
  };
  const calculation: ProjectMaterialCalculation = {
    materialId: material.id,
    inputKey: createCalculationInputKey(material),
    result: solveCuttingStock(
      [{ length: 5000, availableCount: 1 }],
      4,
      [{ length: 1000, qty: 1 }],
      { purchaseShortage: true },
    ),
  };
  const done = completeCutting(emptyOffcutBank(), material, calculation, [], () => "unused");
  const oldKey = JSON.parse(done.completions[0].calculation.inputKey!) as Record<string, unknown>;
  delete oldKey.algorithmVersion;
  done.completions[0].calculation.inputKey = JSON.stringify(oldKey);
  const raw = JSON.stringify(done);
  const storage = {
    getItem: (key: string) => (key === OFFCUT_BANK_KEY ? raw : null),
  };

  const restored = readOffcutBank(storage);

  assert.equal(restored.completions[0].calculation.inputKey, JSON.stringify(oldKey));
});

test("既知の旧版完了記録は読み込み、未知の将来版は拒否する", () => {
  const material: ProjectMaterial = {
    id: "material-1",
    workId: "work-1",
    name: "SGP",
    specification: "50A",
    stockMode: "inventory",
    stocks: [{ id: "stock-1", length: "5000", quantity: "1" }],
    kerf: "4",
    pieces: [{ id: "piece-1", name: "P-01", length: "1000", qty: "1" }],
  };
  const calculation: ProjectMaterialCalculation = {
    materialId: material.id,
    inputKey: createCalculationInputKey(material),
    result: solveCuttingStock(
      [{ length: 5000, availableCount: 1 }],
      4,
      [{ length: 1000, qty: 1 }],
      { purchaseShortage: true },
    ),
  };
  const done = completeCutting(emptyOffcutBank(), material, calculation, [], () => "unused");
  const storedKey = JSON.parse(done.completions[0].calculation.inputKey!) as Record<
    string,
    unknown
  >;
  const readWithVersion = (algorithmVersion: number) => {
    const copy = structuredClone(done);
    copy.completions[0].calculation.inputKey = JSON.stringify({
      ...storedKey,
      algorithmVersion,
    });
    return readOffcutBank({
      getItem: (key: string) => (key === OFFCUT_BANK_KEY ? JSON.stringify(copy) : null),
    });
  };

  assert.equal(readWithVersion(1).completions.length, 1);
  assert.throws(() => readWithVersion(3));
});

test("最後の刃幅が取れない実測端材は使わず購入材へ回す", () => {
  const result = solveWithOffcuts(
    [{ length: 5000 }],
    4,
    [{ length: 1000, qty: 1 }],
    [{ id: "offcut-1", length: 1003, quantity: 1 }],
    true,
  );

  assert.equal(
    result.bars.some((bar) => bar.source === "offcut"),
    false,
  );
  assert.equal(result.bars.filter((bar) => bar.source === "purchase").length, 1);
  assert.deepEqual(result.unfittable, []);
});
