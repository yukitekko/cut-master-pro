import assert from "node:assert/strict";
import test from "node:test";
import { APP_SETTINGS_KEY } from "./app-settings.ts";
import {
  APP_BACKUP_FORMAT_VERSION,
  APP_BACKUP_ID,
  APP_STORAGE_KEYS,
  BackupRestoreRollbackError,
  appDataBackupFilename,
  createAppDataBackup,
  createSalvagedAppDataBackup,
  createStorageRecoveryBackup,
  normalizeSavedProjectsForBackup,
  parseAppDataBackup,
  restoreAppDataBackup,
  serializeAppDataBackup,
  summarizeAppDataBackup,
  type AppDataBackup,
} from "./data-backup.ts";
import { MATERIAL_CATALOG_KEY } from "./material-catalog-storage.ts";
import { OFFCUT_BANK_KEY } from "./offcut-bank.ts";
import {
  DRAFT_STORAGE_KEY,
  PROJECT_FOLDERS_STORAGE_KEY,
  PROJECTS_STORAGE_KEY,
  PROJECT_STORAGE_VERSION,
  readProjects,
  readProjectsStrict,
  type ProjectSnapshot,
} from "./project-storage.ts";

class MemoryStorage implements Storage {
  protected values = new Map<string, string>();

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

class FailsOnceStorage extends MemoryStorage {
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

class FailsEveryWriteStorage extends MemoryStorage {
  private failing = false;

  startFailing() {
    this.failing = true;
  }

  override setItem(key: string, value: string) {
    if (this.failing) throw new Error("simulated persistent storage failure");
    super.setItem(key, value);
  }
}

const snapshot = (): ProjectSnapshot => ({
  version: PROJECT_STORAGE_VERSION,
  project: { name: "A邸", activeProjectId: "project-1", activeMaterialId: "material-1" },
  materials: [
    {
      id: "material-1",
      planningMode: "standard",
      name: "パイプ 黒",
      specification: "50A SGP",
      stocks: [{ id: "stock-1", length: "5500", quantity: "" }],
      kerf: "4",
      pieces: [{ id: "piece-1", name: "横桟", length: "1200", qty: "4" }],
      manualOffcuts: [],
    },
  ],
  calculation: { materials: [] },
  estimate: {
    rows: [],
    recipient: "お客様",
    issuer: "工房",
    notes: "",
    laborCost: "",
    otherCost: "",
    taxRate: "10",
    issuedOn: "2026-10-14",
  },
});

const populateValidData = (storage: Storage) => {
  const draft = snapshot();
  storage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(draft));
  storage.setItem(
    PROJECTS_STORAGE_KEY,
    JSON.stringify([
      {
        id: "project-1",
        name: "A邸",
        createdAt: "2026-10-13T00:00:00.000Z",
        updatedAt: "2026-10-14T00:00:00.000Z",
        folderId: "folder-1",
        snapshot: draft,
      },
    ]),
  );
  storage.setItem(
    PROJECT_FOLDERS_STORAGE_KEY,
    JSON.stringify({
      version: 1,
      folders: [{ id: "folder-1", name: "今月", createdAt: "2026-10-13T00:00:00.000Z" }],
    }),
  );
  storage.setItem(
    APP_SETTINGS_KEY,
    JSON.stringify({ version: 1, kerf: "4", issuer: "工房", displayMode: "auto" }),
  );
  storage.setItem(
    MATERIAL_CATALOG_KEY,
    JSON.stringify({
      version: 2,
      materials: [],
      names: ["パイプ 黒", "パイプ 白"],
      specifications: ["50A SGP", "50A sch40"],
    }),
  );
  storage.setItem(
    OFFCUT_BANK_KEY,
    JSON.stringify({ version: 1, catalog: [], entries: [], completions: [] }),
  );
};

const validBackup = () => {
  const storage = new MemoryStorage();
  populateValidData(storage);
  return createAppDataBackup(storage, new Date("2026-10-14T01:02:03.000Z"));
};

test("6種類の保存データだけを文字列のままバックアップする", () => {
  const storage = new MemoryStorage();
  populateValidData(storage);
  storage.setItem("unrelated", "keep me");

  const backup = createAppDataBackup(storage, new Date("2026-10-14T01:02:03.000Z"));
  assert.equal(backup.app, APP_BACKUP_ID);
  assert.equal(backup.formatVersion, APP_BACKUP_FORMAT_VERSION);
  assert.equal(backup.exportedAt, "2026-10-14T01:02:03.000Z");
  assert.deepEqual(Object.keys(backup.data), APP_STORAGE_KEYS);
  assert.equal("unrelated" in backup.data, false);
  for (const key of APP_STORAGE_KEYS) assert.equal(backup.data[key], storage.getItem(key));
});

test("ゴミ箱の案件もバックアップして復元できる", () => {
  const source = new MemoryStorage();
  populateValidData(source);
  const projects = JSON.parse(source.getItem(PROJECTS_STORAGE_KEY)!) as Array<
    Record<string, unknown>
  >;
  projects[0]!.trashedAt = "2026-10-14T02:00:00.000Z";
  source.setItem(PROJECTS_STORAGE_KEY, JSON.stringify(projects));

  const backup = parseAppDataBackup(
    serializeAppDataBackup(createAppDataBackup(source, new Date("2026-10-14T03:00:00.000Z"))),
  );
  const destination = new MemoryStorage();
  restoreAppDataBackup(destination, backup);

  assert.equal(readProjectsStrict(destination)[0]?.trashedAt, "2026-10-14T02:00:00.000Z");
});

test("v1バックアップの保存キーは将来の保存先変更から独立して固定する", () => {
  assert.deepEqual(APP_STORAGE_KEYS, [
    "cut-master-pro:draft:v1",
    "cut-master-pro:projects:v1",
    "cut-master-pro:project-folders:v1",
    "cut-master-pro:settings:v1",
    "cut-master-pro:material-catalog:v1",
    "cut-master-pro:offcuts:v1",
  ]);
});

test("バックアップは保存件数を復元前に確認できる", () => {
  const parsed = parseAppDataBackup(serializeAppDataBackup(validBackup()));
  assert.deepEqual(summarizeAppDataBackup(parsed), {
    exportedAt: "2026-10-14T01:02:03.000Z",
    projects: 1,
    folders: 1,
    materialNames: 2,
    specifications: 2,
    hasDraft: true,
  });
});

test("バックアップを復元すると対象6キーだけが完全に置き換わる", () => {
  const destination = new MemoryStorage();
  destination.setItem(DRAFT_STORAGE_KEY, "old draft");
  destination.setItem(OFFCUT_BANK_KEY, "old offcut");
  destination.setItem("unrelated", "preserved");
  const backup = validBackup();
  backup.data[OFFCUT_BANK_KEY] = null;

  restoreAppDataBackup(destination, backup);

  for (const key of APP_STORAGE_KEYS) assert.equal(destination.getItem(key), backup.data[key]);
  assert.equal(destination.getItem("unrelated"), "preserved");
});

test("復元できない現在データを保存成功にはしない", () => {
  const storage = new MemoryStorage();
  populateValidData(storage);
  storage.setItem(APP_SETTINGS_KEY, "{}");
  assert.throws(() => createAppDataBackup(storage), /設定の形式が不正です/);

  const backup = createAppDataBackup(storage, new Date("2026-10-14T01:02:03.000Z"), {
    [APP_SETTINGS_KEY]: JSON.stringify({
      version: 1,
      kerf: "3.2",
      issuer: "現在の入力",
      displayMode: "mobile",
    }),
  });
  assert.equal(
    backup.data[APP_SETTINGS_KEY],
    JSON.stringify({
      version: 1,
      kerf: "3.2",
      issuer: "現在の入力",
      displayMode: "mobile",
    }),
  );
});

test("現在の保存領域が壊れていても正常化した全領域から復元前バックアップを作れる", () => {
  const broken = new MemoryStorage();
  for (const key of APP_STORAGE_KEYS) broken.setItem(key, "{}");
  assert.throws(() => createAppDataBackup(broken), /バックアップを作成できません/);

  const normalized = validBackup();
  const safetyBackup = createSalvagedAppDataBackup(
    broken,
    new Date("2026-10-14T02:03:04.000Z"),
    normalized.data,
  );
  assert.deepEqual(safetyBackup.data, normalized.data);
  assert.equal(safetyBackup.recovery?.reason, "invalid-current-storage");
  assert.ok(APP_STORAGE_KEYS.every((key) => safetyBackup.recovery?.rawData[key] === "{}"));
  const reparsed = parseAppDataBackup(serializeAppDataBackup(safetyBackup));
  assert.deepEqual(reparsed.recovery, safetyBackup.recovery);
  assert.deepEqual(summarizeAppDataBackup(safetyBackup), {
    exportedAt: "2026-10-14T02:03:04.000Z",
    projects: 1,
    folders: 1,
    materialNames: 2,
    specifications: 2,
    hasDraft: true,
  });

  restoreAppDataBackup(broken, safetyBackup);
  for (const key of APP_STORAGE_KEYS) {
    assert.equal(broken.getItem(key), normalized.data[key]);
  }
});

test("日時だけ欠けた旧案件を正規化して復元前バックアップへ残す", () => {
  const storage = new MemoryStorage();
  populateValidData(storage);
  const projectWithoutDates = JSON.parse(storage.getItem(PROJECTS_STORAGE_KEY)!) as Array<
    Record<string, unknown>
  >;
  delete projectWithoutDates[0]!.createdAt;
  delete projectWithoutDates[0]!.updatedAt;
  storage.setItem(PROJECTS_STORAGE_KEY, JSON.stringify(projectWithoutDates));

  const visibleProjects = readProjects(storage);
  assert.equal(visibleProjects.length, 1);
  assert.throws(() => createAppDataBackup(storage), /案件履歴/);

  const timestamp = "2026-10-14T03:04:05.000Z";
  const normalizedProjects = normalizeSavedProjectsForBackup(visibleProjects, timestamp);
  const safetyBackup = createAppDataBackup(storage, new Date(timestamp), {
    [PROJECTS_STORAGE_KEY]: JSON.stringify(normalizedProjects),
  });
  assert.equal(summarizeAppDataBackup(safetyBackup).projects, 1);
  assert.equal(normalizedProjects[0]!.createdAt, timestamp);
  assert.equal(normalizedProjects[0]!.updatedAt, timestamp);
});

test("読めても復元不能な案件は通常領域から外し、生データを緊急退避へ残す", () => {
  const storage = new MemoryStorage();
  populateValidData(storage);
  const projects = JSON.parse(storage.getItem(PROJECTS_STORAGE_KEY)!) as Array<
    Record<string, unknown>
  >;
  const savedSnapshot = projects[0]!.snapshot as Record<string, unknown>;
  const estimate = savedSnapshot.estimate as Record<string, unknown>;
  delete estimate.issuer;
  storage.setItem(PROJECTS_STORAGE_KEY, JSON.stringify(projects));

  const visibleProjects = readProjects(storage);
  assert.equal(visibleProjects.length, 0);
  const normalizedProjects = normalizeSavedProjectsForBackup(
    visibleProjects,
    "2026-10-14T04:05:06.000Z",
  );
  assert.equal(normalizedProjects.length, 0);

  const safetyBackup = createSalvagedAppDataBackup(storage, new Date("2026-10-14T04:05:06.000Z"), {
    ...validBackup().data,
    [PROJECTS_STORAGE_KEY]: JSON.stringify(normalizedProjects),
  });
  assert.equal(summarizeAppDataBackup(safetyBackup).projects, 0);
  assert.equal(
    safetyBackup.recovery?.rawData[PROJECTS_STORAGE_KEY],
    storage.getItem(PROJECTS_STORAGE_KEY),
  );

  const destination = new MemoryStorage();
  restoreAppDataBackup(destination, safetyBackup);
  assert.equal(summarizeAppDataBackup(createAppDataBackup(destination)).projects, 0);
});

test("復旧用ファイルは破損した生データと読み取れる案件の両方を残す", () => {
  const storage = new MemoryStorage();
  populateValidData(storage);
  const projects = JSON.parse(storage.getItem(PROJECTS_STORAGE_KEY)!) as unknown[];
  projects.push({ id: "broken", name: "壊れた案件", snapshot: {} });
  const brokenProjects = JSON.stringify(projects);
  const brokenDraft = "{broken-draft";
  storage.setItem(PROJECTS_STORAGE_KEY, brokenProjects);
  storage.setItem(DRAFT_STORAGE_KEY, brokenDraft);

  const backup = createStorageRecoveryBackup(storage, new Date("2026-10-14T05:06:07.000Z"));
  assert.deepEqual(summarizeAppDataBackup(backup), {
    exportedAt: "2026-10-14T05:06:07.000Z",
    projects: 1,
    folders: 1,
    materialNames: 2,
    specifications: 2,
    hasDraft: false,
  });
  assert.equal(backup.recovery?.rawData[PROJECTS_STORAGE_KEY], brokenProjects);
  assert.equal(backup.recovery?.rawData[DRAFT_STORAGE_KEY], brokenDraft);
  assert.doesNotThrow(() => parseAppDataBackup(serializeAppDataBackup(backup)));
});

test("案件IDが重複した履歴は元データを退避し、重複しない案件だけ復元できる", () => {
  const storage = new MemoryStorage();
  populateValidData(storage);
  const projects = JSON.parse(storage.getItem(PROJECTS_STORAGE_KEY)!) as Array<
    Record<string, unknown>
  >;
  projects.push(structuredClone(projects[0]!));
  const duplicatedProjects = JSON.stringify(projects);
  storage.setItem(PROJECTS_STORAGE_KEY, duplicatedProjects);

  const backup = createStorageRecoveryBackup(storage, new Date("2026-10-14T06:07:08.000Z"));
  assert.equal(backup.recovery?.rawData[PROJECTS_STORAGE_KEY], duplicatedProjects);
  assert.equal(summarizeAppDataBackup(backup).projects, 1);

  const destination = new MemoryStorage();
  restoreAppDataBackup(destination, backup);
  assert.equal(readProjectsStrict(destination).length, 1);
});

test("厳密読込が拒否する案件履歴は復旧用ファイルでも元データとして退避する", () => {
  const corruptions: Array<(projects: Array<Record<string, unknown>>) => void> = [
    (projects) => {
      projects[0]!.createdAt = null;
    },
    (projects) => {
      projects[0]!.folderId = { id: "folder-1" };
    },
    (projects) => {
      projects[0]!.trashedAt = 123;
    },
    (projects) => {
      const storedSnapshot = projects[0]!.snapshot as Record<string, unknown>;
      (storedSnapshot.project as Record<string, unknown>).activeMaterialId = "missing-material";
    },
  ];

  for (const corrupt of corruptions) {
    const storage = new MemoryStorage();
    populateValidData(storage);
    const projects = JSON.parse(storage.getItem(PROJECTS_STORAGE_KEY)!) as Array<
      Record<string, unknown>
    >;
    corrupt(projects);
    const raw = JSON.stringify(projects);
    storage.setItem(PROJECTS_STORAGE_KEY, raw);
    assert.throws(() => readProjectsStrict(storage));

    const backup = createStorageRecoveryBackup(storage, new Date("2026-10-14T07:08:09.000Z"));
    assert.equal(backup.recovery?.rawData[PROJECTS_STORAGE_KEY], raw);
    assert.doesNotThrow(() => parseAppDataBackup(serializeAppDataBackup(backup)));

    const destination = new MemoryStorage();
    restoreAppDataBackup(destination, backup);
    assert.doesNotThrow(() => readProjectsStrict(destination));
  }
});

test("意味的に壊れた下書きも補正せず復旧用ファイルへ退避する", () => {
  const storage = new MemoryStorage();
  populateValidData(storage);
  const draft = JSON.parse(storage.getItem(DRAFT_STORAGE_KEY)!) as Record<string, unknown>;
  (draft.project as Record<string, unknown>).activeMaterialId = "missing-material";
  const raw = JSON.stringify(draft);
  storage.setItem(DRAFT_STORAGE_KEY, raw);

  const backup = createStorageRecoveryBackup(storage, new Date("2026-10-14T08:09:10.000Z"));
  assert.equal(backup.data[DRAFT_STORAGE_KEY], null);
  assert.equal(backup.recovery?.rawData[DRAFT_STORAGE_KEY], raw);
  assert.doesNotThrow(() => parseAppDataBackup(serializeAppDataBackup(backup)));
});

test("保存データがまだない新規環境もバックアップできる", () => {
  const backup = createAppDataBackup(new MemoryStorage(), new Date("2026-10-14T01:02:03.000Z"));
  assert.ok(APP_STORAGE_KEYS.every((key) => backup.data[key] === null));
  assert.deepEqual(summarizeAppDataBackup(backup), {
    exportedAt: "2026-10-14T01:02:03.000Z",
    projects: 0,
    folders: 0,
    materialNames: 0,
    specifications: 0,
    hasDraft: false,
  });
});

test("旧案件・旧設定・旧材料一覧をまとめてバックアップできる", () => {
  const storage = new MemoryStorage();
  const current = snapshot();
  const legacySnapshot = {
    ...current,
    version: 1,
    project: { name: "旧案件", activeProjectId: "legacy-project" },
    calculation: { result: null, inputKey: null },
  };
  storage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(legacySnapshot));
  storage.setItem(PROJECTS_STORAGE_KEY, "[]");
  storage.setItem(APP_SETTINGS_KEY, JSON.stringify({ version: 1, kerf: "4", issuer: "旧工房" }));
  storage.setItem(
    MATERIAL_CATALOG_KEY,
    JSON.stringify({
      version: 1,
      materials: [{ id: "legacy-material", name: "パイプ 黒", specification: "50A SGP" }],
    }),
  );
  storage.setItem(OFFCUT_BANK_KEY, JSON.stringify({ version: 1, entries: [], completions: [] }));

  const backup = parseAppDataBackup(serializeAppDataBackup(createAppDataBackup(storage)));
  const summary = summarizeAppDataBackup(backup);
  assert.equal(summary.hasDraft, true);
  assert.equal(summary.materialNames, 1);
  assert.equal(summary.specifications, 1);
});

test("途中で保存に失敗した場合は全データを元の状態へ戻す", () => {
  const destination = new FailsOnceStorage();
  for (const [index, key] of APP_STORAGE_KEYS.entries())
    destination.setItem(key, `original-${index}`);
  destination.setItem("unrelated", "preserved");
  const before = APP_STORAGE_KEYS.map((key) => destination.getItem(key));
  destination.failAfterSuccessfulWrites(2);

  assert.throws(
    () => restoreAppDataBackup(destination, validBackup()),
    /現在のデータは元の状態に戻しました/,
  );
  assert.deepEqual(
    APP_STORAGE_KEYS.map((key) => destination.getItem(key)),
    before,
  );
  assert.equal(destination.getItem("unrelated"), "preserved");
});

test("復元と元への巻き戻しが両方失敗した場合を区別する", () => {
  const destination = new FailsEveryWriteStorage();
  populateValidData(destination);
  destination.startFailing();
  assert.throws(() => restoreAppDataBackup(destination, validBackup()), BackupRestoreRollbackError);
});

test("壊れた各保存領域を含むファイルは1つも復元しない", () => {
  const brokenValues: Array<[string, (backup: AppDataBackup) => void]> = [
    ["設定", (backup) => (backup.data[APP_SETTINGS_KEY] = "{}")],
    ["下書き", (backup) => (backup.data[DRAFT_STORAGE_KEY] = "{}")],
    ["案件履歴", (backup) => (backup.data[PROJECTS_STORAGE_KEY] = '[{"id":"bad"}]')],
    ["フォルダー", (backup) => (backup.data[PROJECT_FOLDERS_STORAGE_KEY] = "{}")],
    ["材料一覧", (backup) => (backup.data[MATERIAL_CATALOG_KEY] = "{}")],
    ["旧端材", (backup) => (backup.data[OFFCUT_BANK_KEY] = "{}")],
  ];

  for (const [label, breakBackup] of brokenValues) {
    const destination = new MemoryStorage();
    populateValidData(destination);
    const before = APP_STORAGE_KEYS.map((key) => destination.getItem(key));
    const backup = validBackup();
    breakBackup(backup);
    assert.throws(() => restoreAppDataBackup(destination, backup), label);
    assert.deepEqual(
      APP_STORAGE_KEYS.map((key) => destination.getItem(key)),
      before,
      label,
    );
  }
});

test("別アプリ・未知の版・キー不足・不正JSONを拒否する", () => {
  const backup = validBackup();
  assert.throws(() => parseAppDataBackup("not json"), /JSON形式ではありません/);
  assert.throws(
    () => parseAppDataBackup(JSON.stringify({ ...backup, app: "another-app" })),
    /カットマスタープロのファイルではありません/,
  );
  assert.throws(
    () => parseAppDataBackup(JSON.stringify({ ...backup, formatVersion: 99 })),
    /アプリを更新してください/,
  );
  const missingKey = structuredClone(backup) as unknown as Record<string, unknown>;
  delete (missingKey.data as Record<string, unknown>)[APP_SETTINGS_KEY];
  assert.throws(() => parseAppDataBackup(JSON.stringify(missingKey)), /種類が一致しません/);

  const extraKey = structuredClone(backup) as unknown as Record<string, unknown>;
  (extraKey.data as Record<string, unknown>)["cut-master-pro:future:v2"] = "{}";
  assert.throws(() => parseAppDataBackup(JSON.stringify(extraKey)), /種類が一致しません/);
});

test("バックアップ名は通常保存と復元前を区別する", () => {
  const now = new Date(2026, 9, 14, 9, 8, 7);
  assert.equal(
    appDataBackupFilename("backup", now),
    "カットマスタープロ_バックアップ_20261014-090807.json",
  );
  assert.equal(
    appDataBackupFilename("before-restore", now),
    "カットマスタープロ_復元前バックアップ_20261014-090807.json",
  );
  assert.equal(
    appDataBackupFilename("recovery", now),
    "カットマスタープロ_復旧用データ_20261014-090807.json",
  );
});
