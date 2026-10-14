import assert from "node:assert/strict";
import test from "node:test";
import {
  PROJECT_STORAGE_VERSION,
  DRAFT_STORAGE_KEY,
  PROJECT_FOLDERS_STORAGE_KEY,
  PROJECTS_STORAGE_KEY,
  ProjectStorageRollbackError,
  countProjectsUsingMaterialOption,
  createProjectFolder,
  createCalculationInputKey,
  getMaterialStockMode,
  inspectProjectStorage,
  moveProjectToFolder,
  readDraft,
  readDraftStrict,
  readProjectFolders,
  readProjects,
  readProjectsStrict,
  removeProject,
  removeProjectFolder,
  resetInvalidProjectStorage,
  renameProjectFolder,
  renameMaterialOptionInSnapshot,
  renameMaterialOptionInStoredProjects,
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

class FailsAfterWritesStorage extends MemoryStorage {
  private writesUntilFailure: number | null = null;

  failAfterSuccessfulWrites(count: number) {
    this.writesUntilFailure = count;
  }

  override setItem(key: string, value: string) {
    if (this.writesUntilFailure !== null) {
      if (this.writesUntilFailure === 0) {
        this.writesUntilFailure = null;
        throw new Error("simulated storage failure");
      }
      this.writesUntilFailure -= 1;
    }
    super.setItem(key, value);
  }
}

class FailsWriteAndRollbackStorage extends MemoryStorage {
  private writesUntilPermanentFailure: number | null = null;

  failPermanentlyAfterSuccessfulWrites(count: number) {
    this.writesUntilPermanentFailure = count;
  }

  override setItem(key: string, value: string) {
    if (this.writesUntilPermanentFailure !== null) {
      if (this.writesUntilPermanentFailure === 0) throw new Error("storage permanently failed");
      this.writesUntilPermanentFailure -= 1;
    }
    super.setItem(key, value);
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
    issuedOn: "2026-09-01",
  },
});

test("下書きは全状態を往復できる", () => {
  const storage = new MemoryStorage();
  const value = snapshot();
  value.materials[0]!.manualOffcuts = [{ id: "manual-offcut-1", length: "1830", quantity: "2" }];
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
  const migrated = readDraftStrict(storage);
  assert.equal(migrated?.version, 2);
  assert.equal(migrated?.project.activeMaterialId, "primary-material");
  assert.equal(migrated?.calculation.materials[0]?.materialId, "primary-material");
  assert.equal(migrated?.estimate.rows[0]?.materialName, "角パイプ");

  storage.setItem(
    PROJECTS_STORAGE_KEY,
    JSON.stringify([
      {
        id: "old-1",
        name: "旧案件",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        snapshot: legacy,
      },
    ]),
  );
  assert.equal(readProjectsStrict(storage)[0]?.snapshot.version, 2);
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
  assert.throws(() => readDraftStrict(storage), /元データは変更せず/);
  assert.throws(() => readProjectsStrict(storage), /元データは変更せず/);
});

test("未保存の下書きと案件履歴は異常扱いせず新規保存できる", () => {
  const storage = new MemoryStorage();
  assert.equal(readDraftStrict(storage), null);
  assert.deepEqual(readProjectsStrict(storage), []);
  writeDraft(storage, snapshot());
  saveProject(storage, snapshot(), "project-1", "2026-10-14T00:00:00.000Z");
  assert.equal(readDraftStrict(storage)?.project.name, "A邸");
  assert.equal(readProjectsStrict(storage).length, 1);
});

test("1件だけ壊れた案件履歴をすべての更新操作で切り捨てない", () => {
  const storage = new MemoryStorage();
  saveProject(storage, snapshot(), "project-1", "2026-10-14T00:00:00.000Z");
  const projects = JSON.parse(storage.getItem(PROJECTS_STORAGE_KEY)!) as unknown[];
  projects.push({ id: "broken", name: "壊れた案件", snapshot: {} });
  const brokenRaw = JSON.stringify(projects);
  const foldersRaw = JSON.stringify({
    version: 1,
    folders: [{ id: "folder-1", name: "現場", createdAt: "2026-10-14T00:00:00.000Z" }],
  });
  storage.setItem(PROJECTS_STORAGE_KEY, brokenRaw);
  storage.setItem(PROJECT_FOLDERS_STORAGE_KEY, foldersRaw);

  const attempts = [
    () => saveProject(storage, snapshot(), "project-2"),
    () => removeProject(storage, "project-1"),
    () => moveProjectToFolder(storage, "project-1", "folder-1"),
    () => renameMaterialOptionInStoredProjects(storage, "name", "角パイプ", "角パイプ白"),
    () => removeProjectFolder(storage, "folder-1"),
  ];
  for (const attempt of attempts) {
    assert.throws(attempt, /案件履歴/);
    assert.equal(storage.getItem(PROJECTS_STORAGE_KEY), brokenRaw);
    assert.equal(storage.getItem(PROJECT_FOLDERS_STORAGE_KEY), foldersRaw);
  }
});

test("旧案件で保存日時が欠けている場合だけ互換日時を補う", () => {
  const storage = new MemoryStorage();
  saveProject(storage, snapshot(), "project-1", "2026-10-14T00:00:00.000Z");
  const projects = JSON.parse(storage.getItem(PROJECTS_STORAGE_KEY)!) as Array<
    Record<string, unknown>
  >;
  delete projects[0]!.createdAt;
  delete projects[0]!.updatedAt;
  storage.setItem(PROJECTS_STORAGE_KEY, JSON.stringify(projects));

  const [restored] = readProjectsStrict(storage);
  assert.equal(restored?.createdAt, "1970-01-01T00:00:00.000Z");
  assert.equal(restored?.updatedAt, "1970-01-01T00:00:00.000Z");
});

test("日時やフォルダーIDの型が壊れた履歴を更新操作で上書きしない", () => {
  const corruptions: Array<[string, unknown]> = [
    ["createdAt", null],
    ["updatedAt", 123],
    ["folderId", { id: "folder-1" }],
  ];

  for (const [field, value] of corruptions) {
    const storage = new MemoryStorage();
    saveProject(storage, snapshot(), "project-1", "2026-10-14T00:00:00.000Z");
    const projects = JSON.parse(storage.getItem(PROJECTS_STORAGE_KEY)!) as Array<
      Record<string, unknown>
    >;
    projects[0]![field] = value;
    const brokenRaw = JSON.stringify(projects);
    const foldersRaw = JSON.stringify({
      version: 1,
      folders: [{ id: "folder-1", name: "現場", createdAt: "2026-10-14T00:00:00.000Z" }],
    });
    storage.setItem(PROJECTS_STORAGE_KEY, brokenRaw);
    storage.setItem(PROJECT_FOLDERS_STORAGE_KEY, foldersRaw);

    const attempts = [
      () => saveProject(storage, snapshot(), "project-2"),
      () => removeProject(storage, "project-1"),
      () => moveProjectToFolder(storage, "project-1", null),
      () => renameMaterialOptionInStoredProjects(storage, "name", "角パイプ", "角パイプ白"),
      () => removeProjectFolder(storage, "folder-1"),
    ];
    for (const attempt of attempts) {
      assert.throws(attempt, /案件履歴/);
      assert.equal(storage.getItem(PROJECTS_STORAGE_KEY), brokenRaw);
      assert.equal(storage.getItem(PROJECT_FOLDERS_STORAGE_KEY), foldersRaw);
    }
  }
});

test("現行案件の選択材料と旧案件の必須項目が壊れていたら補正せず保護する", () => {
  const currentWithMissingMaterial = snapshot();
  currentWithMissingMaterial.project.activeMaterialId = "missing-material";
  const legacyBase = snapshot();
  const legacy = {
    ...legacyBase,
    version: 1,
    project: { name: "旧案件", activeProjectId: "project-1" },
    calculation: { result: null, inputKey: null },
  };
  const legacyWithInvalidName = structuredClone(legacy) as Record<string, unknown>;
  (legacyWithInvalidName.project as Record<string, unknown>).name = null;
  const legacyWithInvalidRows = structuredClone(legacy) as Record<string, unknown>;
  (legacyWithInvalidRows.estimate as Record<string, unknown>).rows = null;
  const legacyWithInvalidInputKey = structuredClone(legacy) as Record<string, unknown>;
  (legacyWithInvalidInputKey.calculation as Record<string, unknown>).inputKey = 123;

  for (const invalidSnapshot of [
    currentWithMissingMaterial,
    legacyWithInvalidName,
    legacyWithInvalidRows,
    legacyWithInvalidInputKey,
  ]) {
    const storage = new MemoryStorage();
    const brokenProjects = JSON.stringify([
      {
        id: "project-1",
        name: "壊れた案件",
        createdAt: "2026-10-14T00:00:00.000Z",
        updatedAt: "2026-10-14T00:00:00.000Z",
        snapshot: invalidSnapshot,
      },
    ]);
    const brokenDraft = JSON.stringify(invalidSnapshot);
    const foldersRaw = JSON.stringify({
      version: 1,
      folders: [{ id: "folder-1", name: "現場", createdAt: "2026-10-14T00:00:00.000Z" }],
    });
    storage.setItem(PROJECTS_STORAGE_KEY, brokenProjects);
    storage.setItem(DRAFT_STORAGE_KEY, brokenDraft);
    storage.setItem(PROJECT_FOLDERS_STORAGE_KEY, foldersRaw);

    assert.throws(() => writeDraft(storage, snapshot()), /作業中の案件/);
    const attempts = [
      () => saveProject(storage, snapshot(), "project-2"),
      () => removeProject(storage, "project-1"),
      () => moveProjectToFolder(storage, "project-1", null),
      () => renameMaterialOptionInStoredProjects(storage, "name", "角パイプ", "角パイプ白"),
      () => removeProjectFolder(storage, "folder-1"),
    ];
    for (const attempt of attempts) assert.throws(attempt);
    assert.equal(storage.getItem(DRAFT_STORAGE_KEY), brokenDraft);
    assert.equal(storage.getItem(PROJECTS_STORAGE_KEY), brokenProjects);
    assert.equal(storage.getItem(PROJECT_FOLDERS_STORAGE_KEY), foldersRaw);
  }
});

test("壊れた下書きを自動保存相当の書き込みで上書きしない", () => {
  const storage = new MemoryStorage();
  const brokenRaw = "{broken-draft";
  storage.setItem(DRAFT_STORAGE_KEY, brokenRaw);
  assert.throws(() => writeDraft(storage, snapshot()), /作業中の案件/);
  assert.equal(storage.getItem(DRAFT_STORAGE_KEY), brokenRaw);
  const inspection = inspectProjectStorage(storage);
  assert.equal(inspection.issues.length, 1);
  assert.equal(inspection.issues[0]?.area, "draft");
  assert.equal(inspection.issues[0]?.raw, brokenRaw);
});

test("復旧用に退避した内容と一致する破損領域だけを初期化する", () => {
  const storage = new MemoryStorage();
  const brokenDraft = "{broken-draft";
  const brokenProjects = "{broken-projects";
  storage.setItem(DRAFT_STORAGE_KEY, brokenDraft);
  storage.setItem(PROJECTS_STORAGE_KEY, brokenProjects);
  storage.setItem("unrelated", "keep");
  const issues = inspectProjectStorage(storage).issues;
  assert.equal(issues.length, 2);

  storage.setItem(PROJECTS_STORAGE_KEY, "{changed-after-backup");
  assert.throws(() => resetInvalidProjectStorage(storage, issues), /データが変更されました/);
  assert.equal(storage.getItem(DRAFT_STORAGE_KEY), brokenDraft);
  assert.equal(storage.getItem(PROJECTS_STORAGE_KEY), "{changed-after-backup");

  storage.setItem(PROJECTS_STORAGE_KEY, brokenProjects);
  resetInvalidProjectStorage(storage, issues);
  assert.equal(storage.getItem(DRAFT_STORAGE_KEY), null);
  assert.equal(storage.getItem(PROJECTS_STORAGE_KEY), null);
  assert.equal(storage.getItem("unrelated"), "keep");
});

test("破損領域の初期化が途中で失敗したら全対象と無関係な保存を元のまま残す", () => {
  const storage = new FailsAfterWritesStorage();
  const safeStorage = new MemoryStorage();
  writeDraft(safeStorage, snapshot());
  saveProject(safeStorage, snapshot(), "project-1", "2026-10-14T00:00:00.000Z");
  const brokenDraft = "{broken-draft";
  const brokenProjects = "{broken-projects";
  storage.setItem(DRAFT_STORAGE_KEY, brokenDraft);
  storage.setItem(PROJECTS_STORAGE_KEY, brokenProjects);
  storage.setItem("unrelated", "keep");
  const issues = inspectProjectStorage(storage).issues;

  storage.failAfterSuccessfulWrites(1);
  assert.throws(
    () =>
      resetInvalidProjectStorage(storage, issues, {
        [DRAFT_STORAGE_KEY]: safeStorage.getItem(DRAFT_STORAGE_KEY),
        [PROJECTS_STORAGE_KEY]: safeStorage.getItem(PROJECTS_STORAGE_KEY),
      }),
    /元データはそのまま残しています/,
  );
  assert.equal(storage.getItem(DRAFT_STORAGE_KEY), brokenDraft);
  assert.equal(storage.getItem(PROJECTS_STORAGE_KEY), brokenProjects);
  assert.equal(storage.getItem("unrelated"), "keep");
});

test("一部だけ読めた案件は破損履歴の初期化後にも残す", () => {
  const storage = new MemoryStorage();
  const safeStorage = new MemoryStorage();
  saveProject(safeStorage, snapshot(), "project-1", "2026-10-14T00:00:00.000Z");
  const safeProjectsRaw = safeStorage.getItem(PROJECTS_STORAGE_KEY)!;
  const safeProjects = JSON.parse(safeProjectsRaw) as unknown[];
  safeProjects.push({ id: "broken", name: "壊れた案件", snapshot: {} });
  const brokenProjects = JSON.stringify(safeProjects);
  storage.setItem(PROJECTS_STORAGE_KEY, brokenProjects);
  const issues = inspectProjectStorage(storage).issues;

  resetInvalidProjectStorage(storage, issues, {
    [PROJECTS_STORAGE_KEY]: safeProjectsRaw,
  });

  assert.equal(storage.getItem(PROJECTS_STORAGE_KEY), safeProjectsRaw);
  assert.equal(readProjectsStrict(storage).length, 1);
  assert.equal(readProjectsStrict(storage)[0]?.id, "project-1");
});

test("復旧用ファイル内の安全なデータも不正なら元データを残す", () => {
  const storage = new MemoryStorage();
  const brokenProjects = "{broken-projects";
  storage.setItem(PROJECTS_STORAGE_KEY, brokenProjects);
  const issues = inspectProjectStorage(storage).issues;

  assert.throws(
    () =>
      resetInvalidProjectStorage(storage, issues, {
        [PROJECTS_STORAGE_KEY]: "{}",
      }),
    /安全なデータを確認できない/,
  );
  assert.equal(storage.getItem(PROJECTS_STORAGE_KEY), brokenProjects);
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

  const withOffcut = structuredClone(before);
  withOffcut.manualOffcuts = [{ id: "manual-1", length: "1830", quantity: "1" }];
  assert.notEqual(createCalculationInputKey(withOffcut), createCalculationInputKey(before));
  const renamedOffcut = structuredClone(withOffcut);
  renamedOffcut.manualOffcuts![0]!.id = "manual-2";
  assert.equal(createCalculationInputKey(renamedOffcut), createCalculationInputKey(withOffcut));
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

test("案件を1階層のフォルダーへ整理し、フォルダー削除時は未分類へ戻す", () => {
  const storage = new MemoryStorage();
  saveProject(storage, snapshot(), "project-1", "2026-01-01T00:00:00.000Z");
  saveProject(storage, snapshot(), "project-2", "2026-01-02T00:00:00.000Z");
  assert.ok(readProjects(storage).every((project) => project.folderId === undefined));

  const folders = createProjectFolder(storage, {
    id: "folder-1",
    name: " A社 ",
    createdAt: "2026-01-03T00:00:00.000Z",
  });
  assert.equal(folders[0]?.name, "A社");
  assert.throws(
    () =>
      createProjectFolder(storage, {
        id: "folder-2",
        name: "A社",
        createdAt: "2026-01-03T00:00:00.000Z",
      }),
    /すでにあります/,
  );

  moveProjectToFolder(storage, "project-1", "folder-1");
  assert.equal(
    readProjects(storage).find((project) => project.id === "project-1")?.folderId,
    "folder-1",
  );
  renameProjectFolder(storage, "folder-1", "A社 工事");
  assert.equal(readProjectFolders(storage)[0]?.name, "A社 工事");

  const removed = removeProjectFolder(storage, "folder-1");
  assert.deepEqual(removed.folders, []);
  assert.equal(removed.projects.find((project) => project.id === "project-1")?.folderId, undefined);
});

test("フォルダー削除の途中で保存に失敗しても分類情報を元へ戻す", () => {
  const storage = new FailsAfterWritesStorage();
  createProjectFolder(storage, {
    id: "folder-1",
    name: "A社",
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  saveProject(storage, snapshot(), "project-1", "2026-01-01T00:00:00.000Z", "folder-1");
  const foldersBefore = storage.getItem(PROJECT_FOLDERS_STORAGE_KEY);
  const projectsBefore = storage.getItem(PROJECTS_STORAGE_KEY);

  storage.failAfterSuccessfulWrites(1);
  assert.throws(() => removeProjectFolder(storage, "folder-1"), /変更前の状態へ戻しました/);
  assert.equal(storage.getItem(PROJECT_FOLDERS_STORAGE_KEY), foldersBefore);
  assert.equal(storage.getItem(PROJECTS_STORAGE_KEY), projectsBefore);
});

test("変更と巻き戻しの両方に失敗した場合は保存停止用の専用エラーにする", () => {
  const storage = new FailsWriteAndRollbackStorage();
  createProjectFolder(storage, {
    id: "folder-1",
    name: "A社",
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  saveProject(storage, snapshot(), "project-1", "2026-01-01T00:00:00.000Z", "folder-1");

  storage.failPermanentlyAfterSuccessfulWrites(1);
  assert.throws(
    () => removeProjectFolder(storage, "folder-1"),
    (failure) => failure instanceof ProjectStorageRollbackError,
  );
});

test("案件の再保存は所属フォルダーを保持し、複製には任意で引き継げる", () => {
  const storage = new MemoryStorage();
  createProjectFolder(storage, {
    id: "folder-1",
    name: "A社",
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  saveProject(storage, snapshot(), "project-1", "2026-01-01T00:00:00.000Z", "folder-1");
  saveProject(storage, snapshot(), "project-1", "2026-01-02T00:00:00.000Z");
  saveProject(storage, snapshot(), "project-copy", "2026-01-03T00:00:00.000Z", "folder-1");

  assert.equal(
    readProjects(storage).find((project) => project.id === "project-1")?.folderId,
    "folder-1",
  );
  assert.equal(
    readProjects(storage).find((project) => project.id === "project-copy")?.folderId,
    "folder-1",
  );
});

test("壊れたフォルダー情報を空の一覧で上書きしない", () => {
  const storage = new MemoryStorage();
  storage.setItem(PROJECT_FOLDERS_STORAGE_KEY, "壊れたデータ");

  assert.throws(() => readProjectFolders(storage), /案件データは変更せず/);
  assert.throws(() =>
    createProjectFolder(storage, {
      id: "folder-1",
      name: "A社",
      createdAt: "2026-01-01T00:00:00.000Z",
    }),
  );
  assert.equal(storage.getItem(PROJECT_FOLDERS_STORAGE_KEY), "壊れたデータ");
});

test("材料名の一括変更は完全一致する保存案件だけへ反映し計算結果を保つ", () => {
  const storage = new MemoryStorage();
  const first = snapshot();
  const material = first.materials[0]!;
  first.calculation.materials[0] = {
    materialId: material.id,
    result: solveCuttingStock([5000], 4, [{ length: 1200, qty: 4, label: "横桟" }]),
    inputKey: createCalculationInputKey(material),
  };
  writeDraft(storage, first);
  saveProject(storage, first, "project-1", "2026-01-01T00:00:00.000Z");

  const second = snapshot();
  second.project.name = "似た名前の案件";
  second.materials[0]!.name = "角パイプ白";
  second.estimate.rows[0]!.materialName = "角パイプ白";
  saveProject(storage, second, "project-2", "2026-01-02T00:00:00.000Z");

  const before = readProjects(storage);
  assert.equal(countProjectsUsingMaterialOption(before, "name", "角パイプ"), 1);
  const resultBefore = first.calculation.materials[0]!.result;

  const renamed = renameMaterialOptionInStoredProjects(
    storage,
    "name",
    "角パイプ",
    "ステンレス角パイプ",
  );

  assert.equal(renamed[1]!.snapshot.materials[0]!.name, "ステンレス角パイプ");
  assert.equal(renamed[1]!.snapshot.estimate.rows[0]!.materialName, "ステンレス角パイプ");
  assert.deepEqual(renamed[1]!.snapshot.calculation.materials[0]!.result, resultBefore);
  assert.equal(renamed[1]!.updatedAt, "2026-01-01T00:00:00.000Z");
  assert.equal(renamed[0]!.snapshot.materials[0]!.name, "角パイプ白");
  assert.equal(readDraft(storage)?.materials[0]?.name, "ステンレス角パイプ");
});

test("材料名一括変更の途中で保存に失敗しても案件と下書きを元へ戻す", () => {
  const storage = new FailsAfterWritesStorage();
  writeDraft(storage, snapshot());
  saveProject(storage, snapshot(), "project-1", "2026-01-01T00:00:00.000Z");
  const draftBefore = storage.getItem(DRAFT_STORAGE_KEY);
  const projectsBefore = storage.getItem(PROJECTS_STORAGE_KEY);

  storage.failAfterSuccessfulWrites(1);
  assert.throws(
    () => renameMaterialOptionInStoredProjects(storage, "name", "角パイプ", "ステンレス角パイプ"),
    /変更前の状態へ戻しました/,
  );
  assert.equal(storage.getItem(DRAFT_STORAGE_KEY), draftBefore);
  assert.equal(storage.getItem(PROJECTS_STORAGE_KEY), projectsBefore);
});

test("規格名の一括変更は同じ規格を使うすべての材料へ反映する", () => {
  const value = snapshot();
  value.materials.push({
    ...structuredClone(value.materials[0]!),
    id: "material-2",
    name: "別の材料",
  });
  value.estimate.rows.push({
    ...value.estimate.rows[0]!,
    materialId: "material-2",
    materialName: "別の材料",
  });

  const renamed = renameMaterialOptionInSnapshot(value, "specification", "SUS304", "SUS304L");

  assert.deepEqual(
    renamed.materials.map((material) => material.specification),
    ["SUS304L", "SUS304L"],
  );
  assert.deepEqual(
    renamed.estimate.rows.map((row) => row.materialSpecification),
    ["SUS304L", "SUS304L"],
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
