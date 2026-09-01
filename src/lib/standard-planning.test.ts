import assert from "node:assert/strict";
import test from "node:test";
import { solveCuttingStock } from "./cutting-stock.ts";
import { buildCompactCuttingOrder, paginateCompactCuttingOrder } from "./cut-list.ts";
import {
  calculateStandardMaterial,
  hasLegacyInventoryConditions,
  isCurrentStandardCalculation,
  restoreStandardSnapshot,
} from "./standard-planning.ts";
import {
  MATERIAL_CATALOG_KEY,
  readMaterialCatalog,
  saveRegisteredMaterial,
} from "./material-catalog-storage.ts";
import {
  OFFCUT_BANK_KEY,
  completeCutting,
  emptyOffcutBank,
  readOffcutBank,
  registerOffcut,
} from "./offcut-bank.ts";
import { solveWithOffcuts } from "./offcut-planning.ts";
import {
  createCalculationInputKey,
  PROJECTS_STORAGE_KEY,
  readDraft,
  writeDraft,
  readProjects,
  saveProject,
  type ProjectMaterial,
  type ProjectSnapshot,
  type ProjectMaterialCalculation,
} from "./project-storage.ts";

const material = (): ProjectMaterial => ({
  id: "m1",
  workId: "w1",
  name: "SGP",
  specification: "150A",
  stockMode: "inventory",
  stocks: [{ id: "s1", length: "6000", quantity: "1" }],
  kerf: "4",
  pieces: [{ id: "p1", name: "P-01", length: "1200", qty: "8" }],
  offcuts: [{ id: "o1", length: 1830, quantity: "1" }],
});
const legacyCalculation = (value = material()): ProjectMaterialCalculation => ({
  materialId: value.id,
  inputKey: createCalculationInputKey(value),
  result: solveWithOffcuts(
    value.stocks.map((s) => ({ length: Number(s.length), availableCount: Number(s.quantity) })),
    Number(value.kerf),
    value.pieces.map((p) => ({ length: Number(p.length), qty: Number(p.qty), label: p.name })),
    (value.offcuts ?? []).map((o) => ({ ...o, quantity: Number(o.quantity) })),
    true,
  ),
});
const snapshot = (): ProjectSnapshot => ({
  version: 2,
  project: { name: "単純化の確認", activeMaterialId: "m1", activeProjectId: "project-1" },
  materials: [material()],
  calculation: { materials: [legacyCalculation()] },
  estimate: {
    rows: [
      {
        materialId: "m1",
        materialName: "SGP",
        materialSpecification: "150A",
        stockLength: 6000,
        qty: "2",
        price: "12345",
      },
    ],
    recipient: "お客様",
    issuer: "工房",
    notes: "単価と備考を保持",
    laborCost: "1000",
    otherCost: "500",
    taxRate: "10",
  },
});
const bank = () =>
  registerOffcut(emptyOffcutBank(), {
    id: "o1",
    materialName: "SGP",
    specification: "150A",
    length: 1830,
    quantity: 1,
    location: "棚A",
  });
const storage = () => {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  } as Storage;
};

test("必要総本数は旧在庫本数や選択端材によらず定尺長さだけから計算する", () => {
  const expected = solveCuttingStock([6000], 4, [{ length: 1200, qty: 8, label: "P-01" }]);
  for (const quantity of ["0", "1", "100", "壊れた旧値"]) {
    const original = material();
    original.stocks[0].quantity = quantity;
    const before = structuredClone(original);
    const next = calculateStandardMaterial(original);
    assert.deepEqual(next.calculation.result, expected);
    assert.equal(next.calculation.result?.totalStock, 2);
    assert.equal(next.material.planningMode, "standard");
    assert.equal(isCurrentStandardCalculation(next.material, next.calculation), true);
    assert.deepEqual(original, before);
    assert.deepEqual(next.material.offcuts, original.offcuts);
  }
});

test("端材しか指定していない旧案件では、端材を無制限の定尺として流用しない", () => {
  const value = material();
  value.stocks = [];
  assert.throws(() => calculateStandardMaterial(value), /定尺材の長さを1つ以上/);
});

test("500本・複数定尺の計算と4列カードの総切断数・部材番号を保持する", () => {
  const value = material();
  value.stocks.push({ id: "s2", length: "4000" });
  value.pieces = [
    { id: "p1", name: "P-01", length: "1200", qty: "200" },
    { id: "p2", name: "P-02", length: "950", qty: "200" },
    { id: "p3", name: "", length: "450", qty: "100" },
  ];
  const { calculation } = calculateStandardMaterial(value);
  const result = calculation.result!;
  assert.equal(result.unfittable.length, 0);
  assert.equal(result.inventoryShortage, null);
  assert.ok(
    result.bars.every((b) => [4000, 6000].includes(b.stockLength) && b.source === "purchase"),
  );
  assert.ok(result.bars.every((b) => b.used <= b.stockLength && b.waste >= 0));
  const cards = buildCompactCuttingOrder(result, value.pieces);
  const groups = paginateCompactCuttingOrder(cards)
    .flat()
    .flatMap((b) => b.groups);
  assert.equal(
    groups.reduce((sum, g) => sum + g.quantity, 0),
    500,
  );
  assert.equal(
    groups.filter((g) => g.label === "P-01").reduce((sum, g) => sum + g.quantity, 0),
    200,
  );
  assert.equal(
    groups.filter((g) => g.label === "P-02").reduce((sum, g) => sum + g.quantity, 0),
    200,
  );
  assert.equal(
    groups.filter((g) => g.label === "").reduce((sum, g) => sum + g.quantity, 0),
    100,
  );
});

test("旧在庫結果は入力キーが一致しても新方式の計算済みとしない", () => {
  const old = material();
  const calculation = legacyCalculation(old);
  assert.equal(calculation.inputKey, createCalculationInputKey(old));
  assert.equal(hasLegacyInventoryConditions(old, calculation), true);
  assert.equal(isCurrentStandardCalculation(old, calculation), false);
  const next = calculateStandardMaterial(old);
  assert.equal(hasLegacyInventoryConditions(next.material, next.calculation), false);
});

test("旧購入方式の結果は再計算を強制せず、入力変更済みなら古いままと判定する", () => {
  const original = snapshot();
  original.materials[0] = { ...material(), stockMode: "purchase", offcuts: [] };
  const calculated = calculateStandardMaterial(original.materials[0]);
  original.calculation.materials = [calculated.calculation];
  const restored = restoreStandardSnapshot(original, []);
  assert.equal(
    isCurrentStandardCalculation(restored.materials[0], restored.calculation.materials[0]),
    true,
  );
  original.materials[0].kerf = "8";
  const stale = restoreStandardSnapshot(original, []);
  assert.equal(
    isCurrentStandardCalculation(stale.materials[0], stale.calculation.materials[0]),
    false,
  );
});

test("新方式では定尺・刃厚・部材寸法本数だけを再計算判定に使う", () => {
  const next = calculateStandardMaterial(material());
  for (const edit of [
    (m: ProjectMaterial) => {
      m.stocks[0].length = "5000";
    },
    (m: ProjectMaterial) => {
      m.kerf = "3";
    },
    (m: ProjectMaterial) => {
      m.pieces[0].length = "1000";
    },
    (m: ProjectMaterial) => {
      m.pieces[0].qty = "9";
    },
  ]) {
    const changed = structuredClone(next.material);
    edit(changed);
    assert.equal(isCurrentStandardCalculation(changed, next.calculation), false);
  }
  const changed = structuredClone(next.material);
  changed.name = "材料の表示名";
  changed.specification = "規格の表示名";
  changed.pieces[0].name = "変更した番号";
  changed.catalogId = "another";
  changed.stocks[0].quantity = "999";
  changed.offcuts = [{ id: "missing", length: 100, quantity: "999" }];
  assert.equal(isCurrentStandardCalculation(changed, next.calculation), true);
});

test("旧案件を開いても保存結果と見積を保持し、履歴・端材バンクを書き換えない", () => {
  const store = storage();
  const original = snapshot();
  store.setItem(OFFCUT_BANK_KEY, JSON.stringify(bank()));
  saveProject(store, original, "project-1");
  const savedBank = store.getItem(OFFCUT_BANK_KEY);
  const savedHistory = store.getItem(PROJECTS_STORAGE_KEY);
  const opened = restoreStandardSnapshot(
    readProjects(store)[0].snapshot,
    readMaterialCatalog(store),
    readOffcutBank(store),
  );
  assert.deepEqual(
    opened.calculation.materials[0].result,
    original.calculation.materials[0].result,
  );
  assert.deepEqual(opened.estimate, original.estimate);
  assert.equal(
    isCurrentStandardCalculation(opened.materials[0], opened.calculation.materials[0]),
    false,
  );
  writeDraft(store, opened);
  const reopened = restoreStandardSnapshot(
    readDraft(store)!,
    readMaterialCatalog(store),
    readOffcutBank(store),
  );
  assert.deepEqual(reopened.estimate, original.estimate);
  assert.equal(store.getItem(OFFCUT_BANK_KEY), savedBank);
  assert.equal(store.getItem(PROJECTS_STORAGE_KEY), savedHistory);
});

test("旧完了記録を復元後の編集・再計算・再保存が完了記録に巻き戻されない", () => {
  const store = storage();
  const original = snapshot();
  const completedBank = completeCutting(
    bank(),
    original.materials[0],
    original.calculation.materials[0],
    [],
    () => "unused",
    original.estimate.rows,
  );
  store.setItem(OFFCUT_BANK_KEY, JSON.stringify(completedBank));
  const savedBank = store.getItem(OFFCUT_BANK_KEY);
  const catalog = readMaterialCatalog(store);
  const opened = restoreStandardSnapshot(original, catalog, completedBank);
  assert.equal(opened.materials[0].stocks[0].quantity, "0");
  assert.deepEqual(
    opened.calculation.materials[0].result,
    original.calculation.materials[0].result,
  );
  opened.materials[0].pieces[0].qty = "12";
  opened.estimate.rows[0].price = "54321";
  opened.estimate.notes = "復元後に編集した備考";
  writeDraft(store, opened);
  const edited = restoreStandardSnapshot(readDraft(store)!, catalog, completedBank);
  assert.equal(edited.materials[0].pieces[0].qty, "12");
  assert.equal(edited.estimate.rows[0].price, "54321");
  assert.equal(edited.estimate.notes, "復元後に編集した備考");
  const next = calculateStandardMaterial(edited.materials[0]);
  edited.materials = [next.material];
  edited.calculation.materials = [next.calculation];
  saveProject(store, edited, "project-1");
  const reopened = restoreStandardSnapshot(readProjects(store)[0].snapshot, catalog, completedBank);
  assert.deepEqual(reopened.calculation.materials[0], next.calculation);
  assert.deepEqual(reopened.estimate, edited.estimate);
  assert.equal(reopened.calculation.materials[0].result?.totalStock, 3);
  assert.equal(
    isCurrentStandardCalculation(reopened.materials[0], reopened.calculation.materials[0]),
    true,
  );
  assert.equal(store.getItem(OFFCUT_BANK_KEY), savedBank);
  assert.throws(
    () => completeCutting(bank(), next.material, next.calculation, [], () => "unused"),
    /在庫の更新は行いません/,
  );
});

test("材料一覧の初回登録は旧一覧のIDを引き継ぎ、端材バンクを書き換えない", () => {
  const store = storage();
  store.setItem(OFFCUT_BANK_KEY, JSON.stringify(bank()));
  const savedBank = store.getItem(OFFCUT_BANK_KEY);
  const original = readMaterialCatalog(store);
  assert.equal(store.getItem(MATERIAL_CATALOG_KEY), null);
  const updated = saveRegisteredMaterial(store, {
    id: "sgp100",
    name: " SGP ",
    specification: " 100A ",
  });
  assert.equal(updated.length, 2);
  assert.deepEqual(updated[0], original[0]);
  assert.deepEqual(readMaterialCatalog(store), updated);
  assert.equal(
    saveRegisteredMaterial(store, { id: "duplicate", name: "SGP", specification: "150A" }).length,
    2,
  );
  assert.equal(store.getItem(OFFCUT_BANK_KEY), savedBank);
});

test("旧バンクが壊れていても独立した材料一覧と標準計算は使用できる", () => {
  const store = storage();
  saveRegisteredMaterial(store, { id: "sgp150", name: "SGP", specification: "150A" });
  store.setItem(OFFCUT_BANK_KEY, "壊れた旧バンク");
  assert.equal(readMaterialCatalog(store).length, 1);
  assert.equal(calculateStandardMaterial(material()).calculation.result?.totalStock, 2);
  assert.equal(store.getItem(OFFCUT_BANK_KEY), "壊れた旧バンク");
});

test("壊れた材料一覧・旧バンクを空の一覧で上書きしない", () => {
  for (const key of [OFFCUT_BANK_KEY, MATERIAL_CATALOG_KEY]) {
    const store = storage();
    store.setItem(key, "不正JSON");
    assert.throws(() => readMaterialCatalog(store), /手入力で計算できます/);
    assert.throws(() =>
      saveRegisteredMaterial(store, { id: "x", name: "SGP", specification: "150A" }),
    );
    assert.equal(store.getItem(key), "不正JSON");
    if (key === OFFCUT_BANK_KEY) assert.equal(store.getItem(MATERIAL_CATALOG_KEY), null);
    assert.equal(calculateStandardMaterial(material()).calculation.result?.totalStock, 2);
  }
});

test("材料登録の保存失敗時に材料一覧・旧端材を変更しない", () => {
  const store = storage();
  store.setItem(OFFCUT_BANK_KEY, JSON.stringify(bank()));
  const raw = store.getItem(OFFCUT_BANK_KEY);
  const unavailable = {
    getItem: store.getItem,
    setItem: () => {
      throw new Error("保存容量不足");
    },
  };
  assert.throws(
    () => saveRegisteredMaterial(unavailable, { id: "x", name: "SGP", specification: "100A" }),
    /保存容量不足/,
  );
  assert.equal(store.getItem(MATERIAL_CATALOG_KEY), null);
  assert.equal(store.getItem(OFFCUT_BANK_KEY), raw);
});

test("空欄・不正な数値・重複する定尺を拒否し、切れない部材を結果に残す", () => {
  for (const edit of [
    (m: ProjectMaterial) => {
      m.kerf = "";
    },
    (m: ProjectMaterial) => {
      m.kerf = "-1";
    },
    (m: ProjectMaterial) => {
      m.stocks[0].length = "0";
    },
    (m: ProjectMaterial) => {
      m.stocks[0].length = "abc";
    },
    (m: ProjectMaterial) => {
      m.stocks.push({ id: "s2", length: "6000" });
    },
    (m: ProjectMaterial) => {
      m.pieces[0].length = "-1";
    },
    (m: ProjectMaterial) => {
      m.pieces[0].qty = "1.5";
    },
    (m: ProjectMaterial) => {
      m.pieces = [];
    },
  ]) {
    const bad = material();
    edit(bad);
    assert.throws(() => calculateStandardMaterial(bad));
  }
  const tooLong = material();
  tooLong.pieces[0].length = "7000";
  assert.equal(calculateStandardMaterial(tooLong).calculation.result?.unfittable[0].qty, 8);
});
