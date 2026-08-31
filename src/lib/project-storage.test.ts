import assert from "node:assert/strict";
import test from "node:test";
import {
  PROJECT_STORAGE_VERSION,
  DRAFT_STORAGE_KEY,
  createCalculationInputKey,
  getMaterialStockMode,
  readDraft,
  readProjects,
  removeProject,
  saveProject,
  writeDraft,
  type ProjectSnapshot,
} from "./project-storage.ts";
import { solveCuttingStock } from "./cutting-stock.ts";

class MemoryStorage implements Storage {
  private values = new Map<string, string>();
  get length() {
    return this.values.size;
  }
  clear() {
    this.values.clear();
  }
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  key(index: number) {
    return [...this.values.keys()][index] ?? null;
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

class FailingStorage extends MemoryStorage {
  setItem() {
    throw new Error("storage failed");
  }
}

const snapshot = (): ProjectSnapshot => ({
  version: PROJECT_STORAGE_VERSION,
  project: { name: "A邸", activeProjectId: null, activeMaterialId: "primary-material" },
  materials: [
    {
      id: "primary-material",
      name: "角パイプ",
      specification: "SUS304",
      stocks: [{ id: "s1", length: "5000" }],
      kerf: "4",
      pieces: [{ id: "p1", name: "横桟", length: "1200", qty: "4" }],
    },
  ],
  calculation: {
    materials: [{ materialId: "primary-material", result: null, inputKey: null }],
  },
  estimate: {
    rows: [
      {
        materialId: "primary-material",
        materialName: "角パイプ",
        materialSpecification: "SUS304",
        stockLength: 5000,
        qty: "2",
        price: "1000",
      },
    ],
    recipient: "お客様",
    issuer: "工房",
    notes: "備考",
    laborCost: "5000",
    otherCost: "1000",
    taxRate: "10",
  },
});

test("下書きは全状態を往復できる", () => {
  const storage = new MemoryStorage();
  const value = snapshot();
  writeDraft(storage, value);
  assert.deepEqual(readDraft(storage), value);
});

test("複数材料と材料別計算結果をまとめて往復できる", () => {
  const storage = new MemoryStorage();
  const value = snapshot();
  value.materials.push({
    id: "material-2",
    name: "アルミ丸棒",
    specification: "A6063 φ20",
    stocks: [{ id: "s2", length: "4000" }],
    kerf: "3",
    pieces: [{ id: "p2", name: "支柱", length: "900", qty: "3" }],
  });
  value.project.activeMaterialId = "material-2";
  value.calculation.materials.push({
    materialId: "material-2",
    result: null,
    inputKey: createCalculationInputKey(value.materials[1]!),
  });
  value.estimate.rows.push({
    materialId: "material-2",
    materialName: "アルミ丸棒",
    materialSpecification: "A6063 φ20",
    stockLength: 4000,
    qty: "1",
    price: "800",
  });
  writeDraft(storage, value);
  assert.deepEqual(readDraft(storage), value);
});

test("第1版の下書きを複数材料対応の第2版へ移行する", () => {
  const storage = new MemoryStorage();
  const current = snapshot();
  const legacy = {
    ...current,
    version: 1,
    project: { name: "旧案件", activeProjectId: "old-1" },
    calculation: { result: null, inputKey: null },
    estimate: {
      ...current.estimate,
      rows: [{ stockLength: 5000, qty: "2", price: "1000" }],
    },
  };
  storage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(legacy));
  const migrated = readDraft(storage);
  assert.equal(migrated?.version, 2);
  assert.equal(migrated?.project.activeMaterialId, "primary-material");
  assert.equal(migrated?.calculation.materials[0]?.materialId, "primary-material");
  assert.equal(migrated?.estimate.rows[0]?.materialName, "角パイプ");
});

test("同じ案件IDの再保存は履歴を増やさず更新する", () => {
  const storage = new MemoryStorage();
  saveProject(storage, snapshot(), "project-1", "2026-01-01T00:00:00.000Z");
  const changed = snapshot();
  changed.project.name = "A邸 変更";
  saveProject(storage, changed, "project-1", "2026-01-02T00:00:00.000Z");
  const projects = readProjects(storage);
  assert.equal(projects.length, 1);
  assert.equal(projects[0]?.name, "A邸 変更");
  assert.equal(projects[0]?.createdAt, "2026-01-01T00:00:00.000Z");
  assert.equal(projects[0]?.snapshot.project.activeProjectId, "project-1");
});

test("壊れた保存データは安全に無視する", () => {
  const storage = new MemoryStorage();
  storage.setItem("cut-master-pro:draft:v1", "{broken");
  storage.setItem("cut-master-pro:projects:v1", "{} ");
  assert.equal(readDraft(storage), null);
  assert.deepEqual(readProjects(storage), []);
});

test("計算条件の変更だけを検出する", () => {
  const before = snapshot().materials[0]!;
  const renamed = structuredClone(before);
  renamed.name = "名称変更";
  renamed.pieces[0]!.name = "部材名変更";
  assert.equal(createCalculationInputKey(renamed), createCalculationInputKey(before));

  const resized = structuredClone(before);
  resized.pieces[0]!.length = "1300";
  assert.notEqual(createCalculationInputKey(resized), createCalculationInputKey(before));

  const limitedStock = structuredClone(before);
  limitedStock.stocks[0]!.quantity = "2";
  assert.notEqual(createCalculationInputKey(limitedStock), createCalculationInputKey(before));

  const blankStockLimit = structuredClone(before);
  blankStockLimit.stocks[0]!.quantity = "";
  assert.equal(createCalculationInputKey(blankStockLimit), createCalculationInputKey(before));
});

test("手持ち在庫の本数を下書きへ保存して復元できる", () => {
  const storage = new MemoryStorage();
  const value = snapshot();
  value.materials[0]!.stocks[0]!.quantity = "3";

  writeDraft(storage, value);

  assert.equal(readDraft(storage)?.materials[0]?.stocks[0]?.quantity, "3");
});

test("在庫不足の計算結果も下書きから完全復元できる", () => {
  const storage = new MemoryStorage();
  const value = snapshot();
  const material = value.materials[0]!;
  material.stocks[0]!.quantity = "1";
  material.pieces = [{ id: "p1", name: "P-01", length: "3000", qty: "2" }];
  value.calculation.materials[0] = {
    materialId: material.id,
    result: solveCuttingStock([{ length: 5000, availableCount: 1 }], 4, [
      { length: 3000, qty: 2, label: "P-01" },
    ]),
    inputKey: createCalculationInputKey(material),
  };

  writeDraft(storage, value);
  const restored = readDraft(storage);

  assert.equal(restored?.materials[0]?.stocks[0]?.quantity, "1");
  assert.equal(restored?.calculation.materials[0]?.inputKey, createCalculationInputKey(material));
  assert.deepEqual(restored?.calculation.materials[0]?.result?.inventoryShortage, {
    pieces: [{ length: 3000, qty: 1, label: "P-01" }],
    suggestedStock: [{ stockLength: 5000, count: 1 }],
  });
});

test("購入モードは保存済み在庫本数を計算条件に含めない", () => {
  const original = snapshot().materials[0]!;
  const purchase = structuredClone(original);
  purchase.stockMode = "purchase";
  purchase.stocks[0]!.quantity = "3";

  assert.equal(getMaterialStockMode(original), "purchase");
  assert.equal(getMaterialStockMode(purchase), "purchase");
  assert.equal(createCalculationInputKey(purchase), createCalculationInputKey(original));

  purchase.stockMode = "inventory";
  assert.notEqual(createCalculationInputKey(purchase), createCalculationInputKey(original));
});

test("旧在庫案件は手持ちモードへ引き継ぎ、新方式では再計算を要求する", () => {
  const material = snapshot().materials[0]!;
  material.stocks[0]!.quantity = "1";
  const oldInputKey = JSON.stringify({
    stocks: [{ length: "5000", quantity: "1" }],
    kerf: material.kerf,
    pieces: material.pieces.map((piece) => ({ length: piece.length, qty: piece.qty })),
  });

  assert.equal(getMaterialStockMode(material), "inventory");
  assert.notEqual(createCalculationInputKey(material), oldInputKey);
});

test("購入と手持ちの切替状態・完全な切断結果を保存復元する", () => {
  const storage = new MemoryStorage();
  const value = snapshot();
  const material = value.materials[0]!;
  material.stockMode = "inventory";
  material.stocks[0]!.quantity = "1";
  material.pieces = [{ id: "p1", name: "P-01", length: "3000", qty: "2" }];
  value.calculation.materials[0] = {
    materialId: material.id,
    result: solveCuttingStock(
      [{ length: 5000, availableCount: 1 }],
      4,
      [{ length: 3000, qty: 2, label: "P-01" }],
      { purchaseShortage: true },
    ),
    inputKey: createCalculationInputKey(material),
  };

  writeDraft(storage, value);
  const restored = readDraft(storage);

  assert.equal(restored?.materials[0]?.stockMode, "inventory");
  assert.equal(restored?.materials[0]?.stocks[0]?.quantity, "1");
  assert.equal(restored?.calculation.materials[0]?.result?.stockUsage[0]?.purchaseCount, 1);
  assert.equal(restored?.calculation.materials[0]?.result?.inventoryShortage, null);
  assert.deepEqual(restored, value);
});

test("指定した案件だけを履歴から削除する", () => {
  const storage = new MemoryStorage();
  saveProject(storage, snapshot(), "project-1", "2026-01-01T00:00:00.000Z");
  saveProject(storage, snapshot(), "project-2", "2026-01-02T00:00:00.000Z");
  const projects = removeProject(storage, "project-1");
  assert.deepEqual(
    projects.map((project) => project.id),
    ["project-2"],
  );
  assert.deepEqual(
    readProjects(storage).map((project) => project.id),
    ["project-2"],
  );
});

test("保存領域の書き込みエラーを呼び出し側へ通知する", () => {
  const storage = new FailingStorage();
  assert.throws(() => writeDraft(storage, snapshot()), /storage failed/);
  assert.throws(() => saveProject(storage, snapshot(), "project-1"), /storage failed/);
});

test("500本分の入力と計算結果を下書き保存して完全復元できる", () => {
  const storage = new MemoryStorage();
  const value = snapshot();
  const pieces = Array.from({ length: 500 }, (_, index) => ({
    id: `piece-${index + 1}`,
    name: `P-${String(index + 1).padStart(3, "0")}`,
    length: String(350 + (((index + 1) * 137) % 2101)),
    qty: "1",
  }));
  value.materials[0]!.pieces = pieces;
  value.calculation.materials[0] = {
    materialId: value.materials[0]!.id,
    result: solveCuttingStock(
      [5000],
      4,
      pieces.map((piece) => ({
        length: Number(piece.length),
        qty: Number(piece.qty),
        label: piece.name,
      })),
    ),
    inputKey: createCalculationInputKey(value.materials[0]!),
  };

  writeDraft(storage, value);
  const restored = readDraft(storage);
  const restoredCutCount = restored?.calculation.materials[0]?.result?.bars.reduce(
    (sum, bar) => sum + bar.pieces.length,
    0,
  );

  assert.equal(restored?.materials[0]?.pieces.length, 500);
  assert.equal(restored?.materials[0]?.pieces[499]?.name, "P-500");
  assert.equal(restoredCutCount, 500);
  assert.deepEqual(restored, value);
});
