import assert from "node:assert/strict";
import test from "node:test";
import { solveWithOffcuts, getOffcutCandidates } from "./offcut-planning.ts";
import { solveCuttingStock } from "./cutting-stock.ts";
import { buildCompactCuttingOrder, paginateCompactCuttingOrder } from "./cut-list.ts";
import {
  OFFCUT_BANK_KEY,
  adjustOffcut,
  completeCutting,
  emptyOffcutBank,
  materialWorkId,
  matchesMaterial,
  previewCuttingCompletion,
  readOffcutBank,
  registerOffcut,
  restoreCompletedWork,
  selectOffcuts,
  updateOffcutBank,
} from "./offcut-bank.ts";
import {
  chooseRegisteredMaterial,
  findRegisteredMaterial,
  linkRegisteredMaterial,
  registerMaterial,
  validateMaterialCatalog,
} from "./material-catalog.ts";
import {
  createCalculationInputKey,
  readDraft,
  writeDraft,
  saveProject,
  readProjects,
} from "./project-storage.ts";
import type {
  ProjectMaterial,
  ProjectMaterialCalculation,
  ProjectSnapshot,
} from "./project-storage.ts";

const entry = () => ({
  id: "offcut-1",
  materialName: "SGP",
  specification: "150A",
  length: 1830,
  quantity: 1,
  location: "棚A",
});
const material = (): ProjectMaterial => ({
  id: "material-1",
  workId: "job-1",
  name: "SGP",
  specification: "150A",
  stockMode: "inventory",
  stocks: [{ id: "s1", length: "6000", quantity: "1" }],
  kerf: "4",
  pieces: [{ id: "p1", name: "P-01", length: "1200", qty: "8" }],
  offcuts: [{ id: "offcut-1", length: 1830, quantity: "1" }],
});
const calculate = (value = material()): ProjectMaterialCalculation => ({
  materialId: value.id,
  inputKey: createCalculationInputKey(value),
  result: solveWithOffcuts(
    value.stocks.map((stock) => ({
      length: Number(stock.length),
      availableCount: Number(stock.quantity),
    })),
    Number(value.kerf),
    value.pieces.map((piece) => ({
      length: Number(piece.length),
      qty: Number(piece.qty),
      label: piece.name,
    })),
    (value.offcuts ?? []).map((item) => ({ ...item, quantity: Number(item.quantity) })),
    true,
  ),
});
const snapshot = (): ProjectSnapshot => ({
  version: 2,
  project: { name: "復元テスト", activeMaterialId: "material-1", activeProjectId: "project-1" },
  materials: [material()],
  calculation: { materials: [calculate()] },
  estimate: {
    rows: [
      {
        materialId: "material-1",
        materialName: "SGP",
        materialSpecification: "150A",
        stockLength: 6000,
        price: "12345",
        qty: "2",
      },
    ],
    recipient: "お客様",
    issuer: "工房",
    notes: "備考を保持",
    laborCost: "1000",
    otherCost: "0",
    taxRate: "10",
  },
});
const bank = () => registerOffcut(emptyOffcutBank(), entry());
const storage = () => {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  } as Storage;
};

test("材料名と規格をセット登録し、同じ組合せは重複させずIDを再利用", () => {
  const catalog = registerMaterial([], { id: "sgp150", name: " SGP ", specification: " 150A " });
  assert.deepEqual(catalog, [{ id: "sgp150", name: "SGP", specification: "150A" }]);
  assert.equal(
    registerMaterial(catalog, { id: "another", name: "SGP", specification: "150A" }),
    catalog,
  );
  const two = registerMaterial(catalog, { id: "sgp100", name: "SGP", specification: "100A" });
  assert.equal(two.length, 2);
  assert.throws(() => registerMaterial(two, { id: "sgp150", name: "SGP", specification: "50A" }));
  assert.throws(() => registerMaterial(two, { id: "new", name: "SGP", specification: " " }));
  assert.throws(() => registerMaterial(two, { id: "new", name: " ", specification: "150A" }));
  validateMaterialCatalog(two);
});

test("旧端材は同じ材料・規格ごとに安定したIDへ移行し、元の保存データを変更しない", () => {
  const store = storage();
  const old = {
    version: 1,
    entries: [
      entry(),
      { ...entry(), id: "b", location: "棚B" },
      { ...entry(), id: "c", specification: "100A" },
    ],
    completions: [],
  };
  store.setItem(OFFCUT_BANK_KEY, JSON.stringify(old));
  const first = readOffcutBank(store);
  const second = readOffcutBank(store);
  assert.deepEqual(first, second);
  assert.equal(first.catalog.length, 2);
  assert.equal(first.entries[0].catalogId, first.entries[1].catalogId);
  assert.notEqual(first.entries[0].catalogId, first.entries[2].catalogId);
  assert.equal(store.getItem(OFFCUT_BANK_KEY), JSON.stringify(old));
  assert.deepEqual(
    first.entries.map(({ catalogId, ...item }) => item),
    old.entries,
  );
});

test("壊れた材料一覧・不明な紐付けは拒否し、在庫を上書きしない", () => {
  const store = storage();
  const current = bank();
  for (const invalid of [
    { ...current, catalog: null },
    { ...current, catalog: [...current.catalog, ...current.catalog] },
    { ...current, entries: [{ ...current.entries[0], catalogId: "missing" }] },
    { ...current, entries: [{ ...current.entries[0], catalogId: "" }] },
    { ...current, entries: [{ ...current.entries[0], specification: "100A" }] },
  ]) {
    const raw = JSON.stringify(invalid);
    store.setItem(OFFCUT_BANK_KEY, raw);
    assert.throws(() => updateOffcutBank(store, (value) => registerOffcut(value, entry())));
    assert.equal(store.getItem(OFFCUT_BANK_KEY), raw);
  }
});

test("端材登録と案件選択は同じ登録IDを使い、違う規格の在庫は混ぜない", () => {
  const before = bank();
  const selected = chooseRegisteredMaterial(material(), before.catalog[0]);
  assert.equal(matchesMaterial(before.entries[0], selected, before.catalog), true);
  // Identity, not a job's display label, determines the link.
  assert.equal(
    matchesMaterial(before.entries[0], { ...selected, name: "案件内の表示名" }, before.catalog),
    true,
  );
  assert.equal(
    matchesMaterial(before.entries[0], { ...selected, catalogId: "unknown" }, before.catalog),
    false,
  );
  assert.equal(
    matchesMaterial(before.entries[0], { ...material(), specification: "100A" }, before.catalog),
    false,
  );
  const next = registerOffcut(before, {
    ...entry(),
    id: "second",
    catalogId: selected.catalogId,
    materialName: "別表記",
    quantity: 2,
  });
  assert.equal(next.entries.length, 1);
  assert.equal(next.entries[0].materialName, "SGP");
  assert.equal(next.entries[0].quantity, 3);
});

test("材料選択で寸法・刃厚・本数は保持し、別材料への切替時だけ端材の選択を外す", () => {
  const before = material();
  before.manualOffcuts = [{ id: "manual-1", length: "1825", quantity: "1" }];
  const same = chooseRegisteredMaterial(before, bank().catalog[0]);
  assert.deepEqual(same.offcuts, before.offcuts);
  assert.deepEqual(same.manualOffcuts, before.manualOffcuts);
  const other = chooseRegisteredMaterial(same, {
    id: "sgp100",
    name: "SGP",
    specification: "100A",
  });
  assert.deepEqual(other.offcuts, []);
  assert.deepEqual(other.manualOffcuts, []);
  assert.deepEqual(other.stocks, before.stocks);
  assert.deepEqual(other.pieces, before.pieces);
  assert.equal(other.kerf, before.kerf);
  assert.equal(other.workId, before.workId);
  assert.equal(chooseRegisteredMaterial(same, bank().catalog[0]).catalogId, same.catalogId);
});

test("旧案件を登録済み材料へ紐付けても有効な計算と見積単価・備考を保つ", () => {
  const old = snapshot();
  const next = restoreCompletedWork(old, bank());
  assert.equal(next.materials[0].catalogId, bank().catalog[0].id);
  assert.equal(
    next.calculation.materials[0].inputKey,
    createCalculationInputKey(next.materials[0]),
  );
  assert.deepEqual(next.calculation.materials[0].result, old.calculation.materials[0].result);
  assert.deepEqual(next.estimate, old.estimate);
  const store = storage();
  writeDraft(store, next);
  saveProject(store, next, "saved-project");
  assert.deepEqual(readDraft(store), next);
  assert.equal(readProjects(store)[0].snapshot.materials[0].catalogId, next.materials[0].catalogId);
});

test("IDへの移行で再計算待ちを誤って計算済みにしない", () => {
  const old = snapshot();
  old.materials[0].kerf = "3";
  const next = restoreCompletedWork(old, bank());
  assert.equal(next.calculation.materials[0].inputKey, old.calculation.materials[0].inputKey);
  assert.notEqual(
    next.calculation.materials[0].inputKey,
    createCalculationInputKey(next.materials[0]),
  );
});

test("登録や材料複製は在庫を消費せず、同じ端材へ再び紐付く", () => {
  const current = bank();
  const copy = structuredClone(current);
  const original = linkRegisteredMaterial(material(), current.catalog);
  const duplicate = { ...original, id: "copy-material", workId: "copy-work", offcuts: [] };
  assert.equal(matchesMaterial(current.entries[0], duplicate, current.catalog), true);
  assert.equal(findRegisteredMaterial(current.catalog, duplicate)?.id, original.catalogId);
  assert.deepEqual(current, copy);
  assert.equal(
    linkRegisteredMaterial({ ...material(), name: "未登録の別材料" }, current.catalog).catalogId,
    undefined,
  );
});

test("登録したIDは名前・部材名の表示変更で再計算にせず、端材の別IDは区別する", () => {
  const selected = linkRegisteredMaterial(material(), bank().catalog);
  assert.equal(
    createCalculationInputKey(selected),
    createCalculationInputKey({ ...selected, name: "別表記" }),
  );
  assert.notEqual(
    createCalculationInputKey(selected),
    createCalculationInputKey({ ...selected, catalogId: "other" }),
  );
});

test("完了前プレビューは使用・登録・残りを示すが、在庫も完了記録も書き換えない", () => {
  const current = bank();
  const before = structuredClone(current);
  const value = linkRegisteredMaterial(material(), current.catalog);
  const calculation = calculate(value);
  const changes = previewCuttingCompletion(current, value, calculation, [
    { candidateLength: 2388, length: 2380, quantity: 1, location: "棚B" },
  ]);
  assert.deepEqual(
    changes.find((item) => item.id === "offcut-1"),
    {
      id: "offcut-1",
      source: "offcut",
      length: 1830,
      location: "棚A",
      before: 1,
      used: 1,
      added: 0,
      after: 0,
    },
  );
  assert.deepEqual(
    changes.find((item) => item.source === "stock"),
    {
      id: "s1",
      source: "stock",
      length: 6000,
      location: "",
      before: 1,
      used: 1,
      added: 0,
      after: 0,
    },
  );
  assert.equal(changes.find((item) => item.length === 2380)?.added, 1);
  assert.equal(changes.find((item) => item.length === 2380)?.after, 1);
  assert.deepEqual(current, before);
});

test("使った端材と同寸法・同場所へ新しい端材を足す場合、残数が同じでも両方表示する", () => {
  const current = bank();
  const changes = previewCuttingCompletion(current, material(), calculate(), [
    { candidateLength: 2388, length: 1830, quantity: 1, location: "棚A" },
  ]);
  assert.deepEqual(
    changes.find((item) => item.id === "offcut-1"),
    {
      id: "offcut-1",
      source: "offcut",
      length: 1830,
      location: "棚A",
      before: 1,
      used: 1,
      added: 1,
      after: 1,
    },
  );
});

test("端材未選択なら在庫プレビューに減算を出さず、不正な登録候補は拒否", () => {
  const value = { ...material(), offcuts: [] };
  const current = bank();
  const before = structuredClone(current);
  const changes = previewCuttingCompletion(current, value, calculate(value), []);
  assert.equal(changes.filter((item) => item.source === "offcut").length, 0);
  assert.throws(() =>
    previewCuttingCompletion(current, value, calculate(value), [
      { candidateLength: 2388, length: 3000, quantity: 1, location: "" },
    ]),
  );
  assert.deepEqual(current, before);
});

test("材料IDと在庫の変化記録を完了保存・再起動・古い案件の再読込後も保持", () => {
  const current = bank();
  const value = chooseRegisteredMaterial(material(), current.catalog[0]);
  const done = completeCutting(current, value, calculate(value), [], () => "new");
  const store = storage();
  updateOffcutBank(store, () => done);
  const restoredBank = readOffcutBank(store);
  const restored = restoreCompletedWork(snapshot(), restoredBank);
  assert.equal(restored.materials[0].catalogId, value.catalogId);
  assert.equal(
    restored.calculation.materials[0].inputKey,
    createCalculationInputKey(restored.materials[0]),
  );
  assert.deepEqual(
    restoredBank.completions[0].inventoryChanges,
    done.completions[0].inventoryChanges,
  );
  assert.equal(restoredBank.entries[0].quantity, 0);
  assert.equal(restored.estimate.notes, snapshot().estimate.notes);
  assert.throws(() =>
    completeCutting(
      restoredBank,
      restored.materials[0],
      restored.calculation.materials[0],
      [],
      () => "new",
    ),
  );
});

test("材料登録の保存に失敗しても既存の材料一覧・在庫・完了記録を保つ", () => {
  const store = storage();
  updateOffcutBank(store, () => bank());
  const raw = store.getItem(OFFCUT_BANK_KEY);
  assert.throws(() =>
    updateOffcutBank(
      {
        getItem: store.getItem,
        setItem: () => {
          throw new Error("full");
        },
      },
      (current) => ({
        ...current,
        catalog: registerMaterial(current.catalog, { id: "a", name: "SGP", specification: "100A" }),
      }),
    ),
  );
  assert.equal(store.getItem(OFFCUT_BANK_KEY), raw);
});

test("材料一覧導入前の完了済みデータも移行でき、残数・計算・見積を復元する", () => {
  const done = completeCutting(
    bank(),
    material(),
    calculate(),
    [],
    () => "unused",
    snapshot().estimate.rows,
  );
  const old = {
    version: 1,
    entries: done.entries.map(({ catalogId, ...item }) => item),
    completions: done.completions.map(({ inventoryChanges, ...item }) => item),
  };
  const store = storage();
  store.setItem(OFFCUT_BANK_KEY, JSON.stringify(old));
  const restoredBank = readOffcutBank(store);
  const restored = restoreCompletedWork(snapshot(), restoredBank);
  assert.equal(restoredBank.entries[0].quantity, 0);
  assert.equal(restored.materials[0].stocks[0].quantity, "0");
  assert.equal(restored.materials[0].catalogId, restoredBank.catalog[0].id);
  assert.equal(
    restored.calculation.materials[0].inputKey,
    createCalculationInputKey(restored.materials[0]),
  );
  assert.deepEqual(restored.estimate, snapshot().estimate);
  assert.equal(restoredBank.completions[0].inventoryChanges, undefined);
  assert.equal(store.getItem(OFFCUT_BANK_KEY), JSON.stringify(old));
});

test("端材を選ばない計算は既存の結果と同一", () => {
  const stocks = [{ length: 6000, availableCount: 1 }];
  const pieces = [{ length: 1200, qty: 8 }];
  assert.deepEqual(
    solveWithOffcuts(stocks, 4, pieces, [], true),
    solveCuttingStock(stocks, 4, pieces, { purchaseShortage: true }),
  );
});
test("1830mmの端材は1本だけ使い、不足を6000mmの購入材で補う", () => {
  const result = calculate().result!;
  assert.equal(result.bars.filter((bar) => bar.source === "offcut").length, 1);
  assert.equal(result.bars.filter((bar) => bar.source === "inventory").length, 1);
  assert.equal(result.bars.filter((bar) => bar.source === "purchase").length, 1);
  assert.ok(
    result.bars.filter((bar) => bar.source === "purchase").every((bar) => bar.stockLength === 6000),
  );
  assert.equal(result.bars.flatMap((bar) => bar.pieces).length, 8);
  assert.ok(
    result.bars
      .flatMap((bar) => bar.pieces)
      .every((piece) => piece.label === "P-01" && piece.pieceIndex === 0),
  );
  assert.equal(
    result.totalStockLength,
    result.totalRequiredLength + result.totalKerf + result.totalWaste,
  );
});
test("同寸法でも保管場所別の端材IDと使用本数を保持", () => {
  const result = solveWithOffcuts(
    [{ length: 5000 }],
    4,
    [{ length: 1000, qty: 5 }],
    [
      { id: "a", length: 1830, quantity: 1 },
      { id: "b", length: 1830, quantity: 2 },
    ],
    false,
  );
  assert.deepEqual(
    result.bars
      .filter((bar) => bar.source === "offcut")
      .map((bar) => bar.offcutId)
      .sort(),
    ["a", "b", "b"],
  );
});
test("端材のみで足りる場合は定尺なしでも計算可能・不足時は架空購入しない", () => {
  const offcuts = [{ id: "a", length: 2000, quantity: 1 }];
  assert.equal(
    solveWithOffcuts([], 4, [{ length: 1000, qty: 1 }], offcuts, false).unfittable.length,
    0,
  );
  const result = solveWithOffcuts([], 4, [{ length: 1000, qty: 2 }], offcuts, true);
  assert.equal(result.unfittable[0].qty, 1);
  assert.equal(result.bars.length, 1);
});
test("500本の長さ・番号・本数と在庫上限を保持", () => {
  const result = solveWithOffcuts(
    [{ length: 5000, availableCount: 2 }],
    4,
    [
      { length: 450, qty: 250, label: "A" },
      { length: 800, qty: 250, label: "B" },
    ],
    [{ id: "a", length: 1830, quantity: 10 }],
    true,
  );
  const pieces = result.bars.flatMap((bar) => bar.pieces);
  assert.equal(pieces.length, 500);
  assert.equal(pieces.filter((piece) => piece.label === "A").length, 250);
  assert.ok(result.bars.filter((bar) => bar.source === "offcut").length <= 10);
  assert.ok(result.bars.filter((bar) => bar.source === "inventory").length <= 2);
  assert.ok(result.bars.every((bar) => bar.used <= bar.stockLength));
  const printed = paginateCompactCuttingOrder(
    buildCompactCuttingOrder(result, [
      { id: "a", name: "A", length: "450", qty: "250" },
      { id: "b", name: "B", length: "800", qty: "250" },
    ]),
  ).flat();
  assert.equal(
    printed.flatMap((bar) => bar.groups).reduce((sum, group) => sum + group.quantity, 0),
    500,
  );
  assert.equal(
    printed.filter((bar) => bar.source === "offcut").length,
    result.bars.filter((bar) => bar.source === "offcut").length,
  );
});
test("端材候補は最後の切り離しの刃厚を引き、ゼロ以下を登録候補にしない", () => {
  const result = solveCuttingStock([5000], 4, [{ length: 1200, qty: 4 }]);
  assert.deepEqual(getOffcutCandidates(result, 4), [{ length: 184, quantity: 1 }]);
  assert.deepEqual(
    getOffcutCandidates(solveCuttingStock([5000], 4, [{ length: 4998, qty: 1 }]), 4),
    [],
  );
});
test("材料・規格は完全一致のみ、本数超過・消失・重複選択を拒否", () => {
  const value = material();
  assert.equal(selectOffcuts(bank(), value).length, 1);
  for (const change of [
    { name: "STPG" },
    { specification: "100A" },
    { offcuts: [{ id: "offcut-1", length: 1830, quantity: "2" }] },
    { offcuts: [...value.offcuts!, ...value.offcuts!] },
  ])
    assert.throws(() => selectOffcuts(bank(), { ...value, ...change }));
  assert.throws(() => selectOffcuts(emptyOffcutBank(), value));
});
test("端材選択時のみ材料名・規格・選択本数の変更で再計算が必要", () => {
  const value = material();
  const key = createCalculationInputKey(value);
  assert.notEqual(key, createCalculationInputKey({ ...value, name: "別材料" }));
  assert.notEqual(key, createCalculationInputKey({ ...value, offcuts: [] }));
  assert.equal(
    createCalculationInputKey({ ...value, offcuts: [] }),
    createCalculationInputKey({ ...value, offcuts: [], name: "別材料" }),
  );
});
test("登録は材料・規格・長さ・場所が同じものだけ合算", () => {
  const next = registerOffcut(bank(), { ...entry(), id: "another", quantity: 2 });
  assert.equal(next.entries.length, 1);
  assert.equal(next.entries[0].quantity, 3);
  assert.equal(
    registerOffcut(next, { ...entry(), id: "other-location", location: "棚B" }).entries.length,
    2,
  );
  assert.equal(
    registerOffcut(next, { ...entry(), id: "other-spec", specification: "100A" }).entries.length,
    2,
  );
  assert.throws(() => registerOffcut(next, { ...entry(), materialName: " " }));
  assert.throws(() => registerOffcut(next, { ...entry(), length: Infinity }));
});
test("切断完了時だけ使用端材・手持ちを減算し、選んだ端材を登録", () => {
  const before = bank();
  const copy = structuredClone(before);
  const calculation = calculate();
  const candidate = getOffcutCandidates(calculation.result!, 4)[0];
  const next = completeCutting(
    before,
    material(),
    calculation,
    [
      {
        candidateLength: candidate.length,
        length: candidate.length - 1,
        quantity: 1,
        location: "棚B",
      },
    ],
    () => "new",
  );
  assert.deepEqual(before, copy);
  assert.equal(next.entries.find((entry) => entry.id === "offcut-1")!.quantity, 0);
  assert.equal(next.entries.find((entry) => entry.id === "new")!.length, candidate.length - 1);
  assert.equal(next.completions[0].material.stocks[0].quantity, "0");
  assert.deepEqual(next.completions[0].material.offcuts, []);
  assert.equal(
    next.completions[0].calculation.inputKey,
    createCalculationInputKey(next.completions[0].material),
  );
});
test("チェックしなければ端材は自動登録しない・同一作業を二重完了できない", () => {
  const next = completeCutting(bank(), material(), calculate(), [], () => "new");
  assert.equal(next.entries.length, 1);
  assert.throws(() => completeCutting(next, material(), calculate(), [], () => "new"), /完了済み/);
  const changed = { ...material(), kerf: "0" };
  assert.throws(
    () => completeCutting(next, changed, calculate(changed), [], () => "new"),
    /完了済み/,
  );
});
test("古い計算・不足計画・更新された在庫・過剰な残材登録は拒否", () => {
  assert.throws(() =>
    completeCutting(bank(), { ...material(), kerf: "3" }, calculate(), [], () => "new"),
  );
  assert.throws(() =>
    completeCutting(adjustOffcut(bank(), "offcut-1", 0), material(), calculate(), [], () => "new"),
  );
  const result = calculate().result!;
  const candidate = getOffcutCandidates(result, 4)[0];
  assert.throws(() =>
    completeCutting(
      bank(),
      material(),
      calculate(),
      [
        {
          candidateLength: candidate.length,
          length: candidate.length + 1,
          quantity: 1,
          location: "",
        },
      ],
      () => "new",
    ),
  );
  assert.throws(() =>
    completeCutting(
      bank(),
      material(),
      calculate(),
      [
        {
          candidateLength: candidate.length,
          length: candidate.length,
          quantity: candidate.quantity + 1,
          location: "",
        },
      ],
      () => "new",
    ),
  );
});
test("1回の保存で本数と完了記録が同時に残り、保存失敗では減算しない", () => {
  const store = storage();
  updateOffcutBank(store, () => bank());
  const before = store.getItem(OFFCUT_BANK_KEY);
  assert.throws(() =>
    updateOffcutBank(
      {
        getItem: store.getItem,
        setItem: () => {
          throw new Error("quota");
        },
      },
      (value) => completeCutting(value, material(), calculate(), [], () => "new"),
    ),
  );
  assert.equal(store.getItem(OFFCUT_BANK_KEY), before);
  updateOffcutBank(store, (value) =>
    completeCutting(value, material(), calculate(), [], () => "new"),
  );
  const next = readOffcutBank(store);
  assert.equal(next.entries[0].quantity, 0);
  assert.equal(next.completions.length, 1);
});
test("古い保存案件・再起動前の下書きも完了記録から復元し、単価・備考を保持", () => {
  const store = storage();
  const original = snapshot();
  writeDraft(store, original);
  saveProject(store, original, "project-1");
  const next = completeCutting(
    bank(),
    original.materials[0],
    original.calculation.materials[0],
    [],
    () => "new",
  );
  for (const saved of [readDraft(store)!, readProjects(store)[0].snapshot]) {
    const restored = restoreCompletedWork(saved, next);
    assert.equal(restored.materials[0].stocks[0].quantity, "0");
    assert.equal(
      restored.calculation.materials[0].result?.bars.length,
      original.calculation.materials[0].result?.bars.length,
    );
    assert.deepEqual(restored.estimate, original.estimate);
    assert.equal(restored.materials[0].workId, "job-1");
  }
});

test("古い保存案件の見積行も完了時の材料行へ合わせ、単価と任意本数を保持", () => {
  const original = snapshot();
  const currentRows = [
    { ...original.estimate.rows[0], qty: "7", price: "54321" },
    { ...original.estimate.rows[0], stockLength: 1830, qty: "1", price: "500" },
  ];
  const next = completeCutting(bank(), material(), calculate(), [], () => "new", currentRows);
  const restored = restoreCompletedWork(original, next);
  assert.deepEqual(restored.estimate.rows, currentRows);
  assert.equal(restored.estimate.notes, original.estimate.notes);
});

test("別案件が同じ端材を先に使ったら、後の完了を拒否して前の記録を保つ", () => {
  const store = storage();
  updateOffcutBank(store, () => bank());
  updateOffcutBank(store, (value) =>
    completeCutting(value, material(), calculate(), [], () => "new"),
  );
  const before = store.getItem(OFFCUT_BANK_KEY);
  const second = { ...material(), workId: "another-job" };
  assert.throws(() =>
    updateOffcutBank(store, (value) =>
      completeCutting(value, second, calculate(second), [], () => "new"),
    ),
  );
  assert.equal(store.getItem(OFFCUT_BANK_KEY), before);
});
test("旧案件には安定した作業IDを付け、計算条件・見積は変えない", () => {
  const value = snapshot();
  delete value.materials[0].workId;
  const restored = restoreCompletedWork(value, emptyOffcutBank());
  assert.equal(restored.materials[0].workId, materialWorkId(value.materials[0], "project-1"));
  assert.deepEqual(restored.estimate, value.estimate);
  assert.deepEqual(restored.calculation, value.calculation);
});
test("破損した端材データを空とみなして上書きしない", () => {
  const store = storage();
  for (const raw of [
    "bad-json",
    '{"version":2}',
    JSON.stringify({ ...bank(), entries: [{ ...entry(), quantity: -1 }] }),
  ]) {
    store.setItem(OFFCUT_BANK_KEY, raw);
    assert.throws(() => updateOffcutBank(store, (value) => registerOffcut(value, entry())));
    assert.equal(store.getItem(OFFCUT_BANK_KEY), raw);
  }
});
