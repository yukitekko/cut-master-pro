import { APP_SETTINGS_KEY, validateAppSettings } from "./app-settings.ts";
import {
  MATERIAL_CATALOG_KEY,
  readMaterialCatalog,
  readMaterialCatalogOptions,
} from "./material-catalog-storage.ts";
import { OFFCUT_BANK_KEY, readOffcutBank } from "./offcut-bank.ts";
import {
  DRAFT_STORAGE_KEY,
  PROJECT_FOLDERS_STORAGE_KEY,
  PROJECTS_STORAGE_KEY,
  isProjectSnapshot,
  readDraft,
  readProjectFolders,
  readProjects,
  readProjectsStrict,
  type ProjectSnapshot,
  type SavedProject,
} from "./project-storage.ts";

export const APP_BACKUP_ID = "cut-master-pro" as const;
export const APP_BACKUP_FORMAT_VERSION = 1 as const;
export const MAX_BACKUP_FILE_SIZE = 20 * 1024 * 1024;

// Version 1 must keep this exact key set forever. A future storage area needs a
// new backup format version and migration instead of changing this tuple.
const APP_BACKUP_V1_STORAGE_KEYS = [
  "cut-master-pro:draft:v1",
  "cut-master-pro:projects:v1",
  "cut-master-pro:project-folders:v1",
  "cut-master-pro:settings:v1",
  "cut-master-pro:material-catalog:v1",
  "cut-master-pro:offcuts:v1",
] as const;

export const APP_STORAGE_KEYS = APP_BACKUP_V1_STORAGE_KEYS;

export type AppStorageKey = (typeof APP_STORAGE_KEYS)[number];

export interface AppDataBackup {
  app: typeof APP_BACKUP_ID;
  formatVersion: typeof APP_BACKUP_FORMAT_VERSION;
  exportedAt: string;
  data: Record<AppStorageKey, string | null>;
  recovery?: {
    reason: "invalid-current-storage";
    rawData: Record<AppStorageKey, string | null>;
  };
}

export interface AppDataBackupSummary {
  exportedAt: string;
  projects: number;
  folders: number;
  materialNames: number;
  specifications: number;
  hasDraft: boolean;
}

type ReadWriteStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export class BackupRestoreRollbackError extends Error {
  constructor() {
    super(
      "復元に失敗し、元の状態へ完全に戻せませんでした。画面を閉じず、復元前バックアップからもう一度復元してください。",
    );
    this.name = "BackupRestoreRollbackError";
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const isStringOrUndefined = (value: unknown) => value === undefined || typeof value === "string";
const isFiniteNumber = (value: unknown) => typeof value === "number" && Number.isFinite(value);
const isNonNegativeInteger = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const invalidBackup = (detail: string): never => {
  throw new Error(`バックアップファイルを読み込めません。${detail}`);
};

function assertRecord(value: unknown, detail: string): asserts value is Record<string, unknown> {
  if (!isRecord(value)) invalidBackup(detail);
}

function assertArray(value: unknown, detail: string): asserts value is unknown[] {
  if (!Array.isArray(value)) invalidBackup(detail);
}

class StagedStorage implements Storage {
  private readonly values = new Map<string, string>();

  constructor(values?: Partial<Record<AppStorageKey, string | null>>) {
    for (const key of APP_STORAGE_KEYS) {
      const value = values?.[key];
      if (typeof value === "string") this.values.set(key, value);
    }
  }

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

const parseStoredJson = (raw: string, label: string): unknown => {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return invalidBackup(`${label}の内容が壊れています。`);
  }
};

const assertCutResult = (value: unknown) => {
  assertRecord(value, "案件の計算結果が壊れています。");
  const numericKeys = [
    "totalStock",
    "totalRequiredLength",
    "totalStockLength",
    "totalKerf",
    "totalWaste",
    "yieldRate",
  ] as const;
  if (numericKeys.some((key) => !isFiniteNumber(value[key])))
    invalidBackup("案件の計算結果が壊れています。");
  if (
    !Array.isArray(value.bars) ||
    !Array.isArray(value.stockUsage) ||
    !Array.isArray(value.unfittable)
  )
    invalidBackup("案件の計算結果が壊れています。");
  const bars = value.bars as unknown[];
  const stockUsage = value.stockUsage as unknown[];

  for (const bar of bars) {
    assertRecord(bar, "案件の計算結果が壊れています。");
    if (
      !isFiniteNumber(bar.stockLength) ||
      !Array.isArray(bar.pieces) ||
      !isFiniteNumber(bar.used) ||
      !isFiniteNumber(bar.waste) ||
      !isStringOrUndefined(bar.source) ||
      !isStringOrUndefined(bar.offcutId)
    )
      invalidBackup("案件の計算結果が壊れています。");
    for (const piece of bar.pieces as unknown[]) {
      if (
        !isRecord(piece) ||
        !isFiniteNumber(piece.length) ||
        !isNonNegativeInteger(piece.pieceIndex) ||
        !isStringOrUndefined(piece.label)
      )
        invalidBackup("案件の計算結果が壊れています。");
    }
  }

  for (const usage of stockUsage) {
    if (
      !isRecord(usage) ||
      !isFiniteNumber(usage.stockLength) ||
      !isNonNegativeInteger(usage.count) ||
      [usage.availableCount, usage.inventoryCount, usage.purchaseCount, usage.offcutCount].some(
        (count) => count !== undefined && !isNonNegativeInteger(count),
      )
    )
      invalidBackup("案件の計算結果が壊れています。");
  }

  const assertPieceCounts = (items: unknown) => {
    assertArray(items, "案件の計算結果が壊れています。");
    for (const piece of items) {
      if (
        !isRecord(piece) ||
        !isFiniteNumber(piece.length) ||
        !isNonNegativeInteger(piece.qty) ||
        !isStringOrUndefined(piece.label)
      )
        invalidBackup("案件の計算結果が壊れています。");
    }
  };
  assertPieceCounts(value.unfittable);

  if (value.inventoryShortage !== undefined && value.inventoryShortage !== null) {
    assertRecord(value.inventoryShortage, "案件の計算結果が壊れています。");
    if (!Array.isArray(value.inventoryShortage.suggestedStock))
      invalidBackup("案件の計算結果が壊れています。");
    const suggestedStock = value.inventoryShortage.suggestedStock as unknown[];
    assertPieceCounts(value.inventoryShortage.pieces);
    for (const stock of suggestedStock) {
      if (
        !isRecord(stock) ||
        !isFiniteNumber(stock.stockLength) ||
        !isNonNegativeInteger(stock.count)
      )
        invalidBackup("案件の計算結果が壊れています。");
    }
  }
};

const assertProjectSnapshot = (snapshot: ProjectSnapshot) => {
  if (!isProjectSnapshot(snapshot)) invalidBackup("案件データが壊れています。");
  if (
    snapshot.version !== 2 ||
    !isRecord(snapshot.project) ||
    typeof snapshot.project.name !== "string" ||
    (snapshot.project.activeProjectId !== null &&
      typeof snapshot.project.activeProjectId !== "string") ||
    typeof snapshot.project.activeMaterialId !== "string" ||
    !Array.isArray(snapshot.materials) ||
    snapshot.materials.length === 0 ||
    !isRecord(snapshot.calculation) ||
    !Array.isArray(snapshot.calculation.materials) ||
    !isRecord(snapshot.estimate) ||
    !Array.isArray(snapshot.estimate.rows)
  )
    invalidBackup("案件データが壊れています。");

  const materialIds = new Set<string>();
  for (const material of snapshot.materials) {
    if (
      !isRecord(material) ||
      typeof material.id !== "string" ||
      !material.id ||
      materialIds.has(material.id) ||
      typeof material.name !== "string" ||
      typeof material.specification !== "string" ||
      typeof material.kerf !== "string" ||
      !Array.isArray(material.stocks) ||
      !Array.isArray(material.pieces) ||
      (material.planningMode !== undefined && material.planningMode !== "standard") ||
      (material.catalogId !== undefined && typeof material.catalogId !== "string") ||
      (material.stockMode !== undefined &&
        material.stockMode !== "purchase" &&
        material.stockMode !== "inventory") ||
      !isStringOrUndefined(material.workId)
    )
      invalidBackup("案件の材料データが壊れています。");
    materialIds.add(material.id);

    for (const stock of material.stocks) {
      if (
        !isRecord(stock) ||
        typeof stock.id !== "string" ||
        typeof stock.length !== "string" ||
        !isStringOrUndefined(stock.quantity)
      )
        invalidBackup("案件の定尺データが壊れています。");
    }
    for (const piece of material.pieces) {
      if (
        !isRecord(piece) ||
        typeof piece.id !== "string" ||
        (piece.name !== undefined && typeof piece.name !== "string") ||
        typeof piece.length !== "string" ||
        typeof piece.qty !== "string"
      )
        invalidBackup("案件の部材データが壊れています。");
    }
    if (material.manualOffcuts !== undefined) {
      if (!Array.isArray(material.manualOffcuts)) invalidBackup("案件の端材データが壊れています。");
      for (const offcut of material.manualOffcuts) {
        if (
          !isRecord(offcut) ||
          typeof offcut.id !== "string" ||
          typeof offcut.length !== "string" ||
          typeof offcut.quantity !== "string"
        )
          invalidBackup("案件の端材データが壊れています。");
      }
    }
    if (material.offcuts !== undefined) {
      if (!Array.isArray(material.offcuts)) invalidBackup("旧案件の端材データが壊れています。");
      for (const offcut of material.offcuts) {
        if (
          !isRecord(offcut) ||
          typeof offcut.id !== "string" ||
          !isFiniteNumber(offcut.length) ||
          typeof offcut.quantity !== "string"
        )
          invalidBackup("旧案件の端材データが壊れています。");
      }
    }
  }
  if (!materialIds.has(snapshot.project.activeMaterialId))
    invalidBackup("案件の選択中材料が見つかりません。");

  const calculationIds = new Set<string>();
  for (const calculation of snapshot.calculation.materials) {
    if (
      !isRecord(calculation) ||
      typeof calculation.materialId !== "string" ||
      !materialIds.has(calculation.materialId) ||
      calculationIds.has(calculation.materialId) ||
      (calculation.inputKey !== null && typeof calculation.inputKey !== "string") ||
      (calculation.result !== null && !isRecord(calculation.result))
    )
      invalidBackup("案件の計算データが壊れています。");
    calculationIds.add(calculation.materialId);
    if (calculation.result !== null) assertCutResult(calculation.result);
  }

  for (const row of snapshot.estimate.rows) {
    if (
      !isRecord(row) ||
      typeof row.materialId !== "string" ||
      typeof row.materialName !== "string" ||
      typeof row.materialSpecification !== "string" ||
      !isFiniteNumber(row.stockLength) ||
      typeof row.qty !== "string" ||
      typeof row.price !== "string"
    )
      invalidBackup("案件の見積データが壊れています。");
  }
  if (
    typeof snapshot.estimate.recipient !== "string" ||
    typeof snapshot.estimate.issuer !== "string" ||
    typeof snapshot.estimate.notes !== "string" ||
    typeof snapshot.estimate.laborCost !== "string" ||
    typeof snapshot.estimate.otherCost !== "string" ||
    typeof snapshot.estimate.taxRate !== "string" ||
    !isStringOrUndefined(snapshot.estimate.issuedOn)
  )
    invalidBackup("案件の見積データが壊れています。");
};

export const normalizeSavedProjectsForBackup = (
  projects: readonly SavedProject[],
  fallbackTimestamp: string,
): SavedProject[] => {
  const ids = new Set<string>();
  return projects.flatMap((project) => {
    const normalized = {
      ...project,
      createdAt: typeof project.createdAt === "string" ? project.createdAt : fallbackTimestamp,
      updatedAt: typeof project.updatedAt === "string" ? project.updatedAt : fallbackTimestamp,
    };
    try {
      if (
        typeof normalized.id !== "string" ||
        !normalized.id ||
        ids.has(normalized.id) ||
        typeof normalized.name !== "string"
      )
        return [];
      assertProjectSnapshot(normalized.snapshot);
      ids.add(normalized.id);
      return [normalized];
    } catch {
      return [];
    }
  });
};

const validateBackupContents = (data: Record<AppStorageKey, string | null>) => {
  const staged = new StagedStorage(data);

  if (data[APP_SETTINGS_KEY] !== null) {
    const parsed = validateAppSettings(parseStoredJson(data[APP_SETTINGS_KEY], "設定"));
    if (!parsed.ok) invalidBackup(parsed.error);
  }

  let draft: ProjectSnapshot | null = null;
  if (data[DRAFT_STORAGE_KEY] !== null) {
    parseStoredJson(data[DRAFT_STORAGE_KEY], "作業中の案件");
    const restoredDraft = readDraft(staged);
    if (!restoredDraft) invalidBackup("作業中の案件データが壊れています。");
    assertProjectSnapshot(restoredDraft as ProjectSnapshot);
    draft = restoredDraft as ProjectSnapshot;
  }

  let projects = [] as ReturnType<typeof readProjectsStrict>;
  if (data[PROJECTS_STORAGE_KEY] !== null) {
    const parsed = parseStoredJson(data[PROJECTS_STORAGE_KEY], "案件履歴");
    assertArray(parsed, "案件履歴の形式が不正です。");
    try {
      projects = readProjectsStrict(staged);
    } catch {
      invalidBackup("案件履歴に壊れた案件があります。");
    }
    if (projects.length !== parsed.length) invalidBackup("案件履歴に壊れた案件があります。");
    for (const [index, project] of projects.entries()) {
      const rawProject = parsed[index];
      if (
        !isRecord(rawProject) ||
        typeof rawProject.id !== "string" ||
        !rawProject.id ||
        typeof rawProject.name !== "string" ||
        typeof rawProject.createdAt !== "string" ||
        typeof rawProject.updatedAt !== "string" ||
        (rawProject.folderId !== undefined && typeof rawProject.folderId !== "string")
      )
        invalidBackup("案件履歴に壊れた案件があります。");
      assertProjectSnapshot(project.snapshot);
    }
  }

  let folders = [] as ReturnType<typeof readProjectFolders>;
  if (data[PROJECT_FOLDERS_STORAGE_KEY] !== null) {
    parseStoredJson(data[PROJECT_FOLDERS_STORAGE_KEY], "フォルダー");
    try {
      folders = readProjectFolders(staged);
    } catch {
      invalidBackup("フォルダー情報が壊れています。");
    }
  }

  let materialOptions = { names: [] as string[], specifications: [] as string[] };
  try {
    readMaterialCatalog(staged);
    materialOptions = readMaterialCatalogOptions(staged);
  } catch {
    invalidBackup("登録した材料名・規格名が壊れています。");
  }

  if (data[OFFCUT_BANK_KEY] !== null) {
    try {
      readOffcutBank(staged);
    } catch {
      invalidBackup("旧案件の互換データが壊れています。");
    }
  }

  return {
    exportedAt: "",
    projects: projects.length,
    folders: folders.length,
    materialNames: materialOptions.names.length,
    specifications: materialOptions.specifications.length,
    hasDraft: draft !== null,
  };
};

const validateBackupEnvelope = (value: unknown): AppDataBackup => {
  assertRecord(value, "ファイル形式が違います。");
  if (value.app !== APP_BACKUP_ID) invalidBackup("カットマスタープロのファイルではありません。");
  if (value.formatVersion !== APP_BACKUP_FORMAT_VERSION)
    invalidBackup("この版では読み込めないバックアップです。アプリを更新してください。");
  if (typeof value.exportedAt !== "string" || Number.isNaN(Date.parse(value.exportedAt)))
    invalidBackup("保存日時が壊れています。");
  assertRecord(value.data, "保存内容がありません。");

  const keys = Object.keys(value.data).sort();
  const expectedKeys = [...APP_STORAGE_KEYS].sort();
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index]))
    invalidBackup("保存内容の種類が一致しません。");

  const data = {} as Record<AppStorageKey, string | null>;
  for (const key of APP_STORAGE_KEYS) {
    const stored = value.data[key];
    if (stored !== null && typeof stored !== "string") invalidBackup("保存内容の形式が不正です。");
    data[key] = stored as string | null;
  }
  let recovery: AppDataBackup["recovery"];
  if (value.recovery !== undefined) {
    assertRecord(value.recovery, "緊急退避データの形式が不正です。");
    if (value.recovery.reason !== "invalid-current-storage")
      invalidBackup("緊急退避データの形式が不正です。");
    assertRecord(value.recovery.rawData, "緊急退避データの形式が不正です。");
    const recoveryKeys = Object.keys(value.recovery.rawData).sort();
    if (
      recoveryKeys.length !== expectedKeys.length ||
      recoveryKeys.some((key, index) => key !== expectedKeys[index])
    )
      invalidBackup("緊急退避データの種類が一致しません。");
    const rawData = {} as Record<AppStorageKey, string | null>;
    for (const key of APP_STORAGE_KEYS) {
      const stored = value.recovery.rawData[key];
      if (stored !== null && typeof stored !== "string")
        invalidBackup("緊急退避データの形式が不正です。");
      rawData[key] = stored as string | null;
    }
    recovery = { reason: "invalid-current-storage", rawData };
  }
  validateBackupContents(data);
  return {
    app: APP_BACKUP_ID,
    formatVersion: APP_BACKUP_FORMAT_VERSION,
    exportedAt: value.exportedAt as string,
    data,
    ...(recovery ? { recovery } : {}),
  };
};

const captureOwnedData = (storage: Pick<Storage, "getItem">) => {
  const data = {} as Record<AppStorageKey, string | null>;
  for (const key of APP_BACKUP_V1_STORAGE_KEYS) data[key] = storage.getItem(key);
  return data;
};

export const createAppDataBackup = (
  storage: Pick<Storage, "getItem">,
  now = new Date(),
  overrides: Partial<Record<AppStorageKey, string | null>> = {},
): AppDataBackup => {
  const data = captureOwnedData(storage);
  for (const key of APP_BACKUP_V1_STORAGE_KEYS) {
    if (Object.hasOwn(overrides, key)) data[key] = overrides[key] ?? null;
  }
  try {
    return validateBackupEnvelope({
      app: APP_BACKUP_ID,
      formatVersion: APP_BACKUP_FORMAT_VERSION,
      exportedAt: now.toISOString(),
      data,
    });
  } catch (failure) {
    const detail =
      failure instanceof Error
        ? failure.message.replace(/^バックアップファイルを読み込めません。/, "")
        : "保存内容を確認できませんでした。";
    throw new Error(
      `現在の保存データの一部に問題があるため、バックアップを作成できません。データは変更していません。${detail}`,
    );
  }
};

const emptyBackupData = (): Record<AppStorageKey, string | null> => ({
  [DRAFT_STORAGE_KEY]: null,
  [PROJECTS_STORAGE_KEY]: "[]",
  [PROJECT_FOLDERS_STORAGE_KEY]: JSON.stringify({ version: 1, folders: [] }),
  [APP_SETTINGS_KEY]: JSON.stringify({
    version: 1,
    kerf: "4",
    issuer: "",
    displayMode: "auto",
  }),
  [MATERIAL_CATALOG_KEY]: JSON.stringify({
    version: 2,
    materials: [],
    names: [],
    specifications: [],
  }),
  [OFFCUT_BANK_KEY]: JSON.stringify({ version: 1, catalog: [], entries: [], completions: [] }),
});

/**
 * Recovery path only: keep every raw byte in `recovery.rawData`, while the
 * regular data section contains only areas that pass the normal restore rules.
 */
export const createSalvagedAppDataBackup = (
  storage: Pick<Storage, "getItem">,
  now: Date,
  preferred: Partial<Record<AppStorageKey, string | null>>,
): AppDataBackup => {
  const data = emptyBackupData();
  for (const key of APP_STORAGE_KEYS) {
    if (!Object.hasOwn(preferred, key)) continue;
    const candidate = { ...data, [key]: preferred[key] ?? null };
    try {
      validateBackupContents(candidate);
      data[key] = candidate[key];
    } catch {
      // The raw value remains attached below for manual recovery. Keeping it
      // out of `data` ensures this file can still restore healthy areas.
    }
  }
  const captured = captureOwnedData(storage);
  const rawData = Object.fromEntries(APP_STORAGE_KEYS.map((key) => [key, null])) as Record<
    AppStorageKey,
    string | null
  >;
  for (const key of APP_STORAGE_KEYS) {
    try {
      validateBackupContents({ ...emptyBackupData(), [key]: captured[key] });
    } catch {
      rawData[key] = captured[key];
    }
  }
  return validateBackupEnvelope({
    app: APP_BACKUP_ID,
    formatVersion: APP_BACKUP_FORMAT_VERSION,
    exportedAt: now.toISOString(),
    data,
    recovery: {
      reason: "invalid-current-storage",
      rawData,
    },
  });
};

/**
 * Create a recovery file without trusting the current storage. Healthy areas
 * remain directly restorable; unreadable raw values are attached separately.
 * When only some saved projects are invalid, the readable projects are also
 * retained in the restorable section.
 */
export const createStorageRecoveryBackup = (
  storage: Pick<Storage, "getItem">,
  now = new Date(),
): AppDataBackup => {
  const captured = captureOwnedData(storage);
  const readableProjects = normalizeSavedProjectsForBackup(
    readProjects(storage),
    now.toISOString(),
  );
  return createSalvagedAppDataBackup(storage, now, {
    ...captured,
    [PROJECTS_STORAGE_KEY]: JSON.stringify(readableProjects),
  });
};

export const serializeAppDataBackup = (backup: AppDataBackup) => JSON.stringify(backup, null, 2);

export const parseAppDataBackup = (text: string): AppDataBackup => {
  if (new TextEncoder().encode(text).byteLength > MAX_BACKUP_FILE_SIZE)
    invalidBackup("ファイルが大きすぎます（20MBまで）。");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return invalidBackup("JSON形式ではありません。");
  }
  return validateBackupEnvelope(parsed);
};

export const summarizeAppDataBackup = (backup: AppDataBackup): AppDataBackupSummary => {
  const validated = validateBackupEnvelope(backup);
  return {
    ...validateBackupContents(validated.data),
    exportedAt: validated.exportedAt,
  };
};

const replaceOwnedStorage = (
  storage: ReadWriteStorage,
  values: Record<AppStorageKey, string | null>,
) => {
  for (const key of APP_STORAGE_KEYS) storage.removeItem(key);
  for (const key of APP_STORAGE_KEYS) {
    const value = values[key];
    if (value !== null) storage.setItem(key, value);
  }
};

export const restoreAppDataBackup = (storage: ReadWriteStorage, backup: AppDataBackup) => {
  const validated = validateBackupEnvelope(backup);
  const previous = captureOwnedData(storage);
  try {
    replaceOwnedStorage(storage, validated.data);
    for (const key of APP_STORAGE_KEYS) {
      if (storage.getItem(key) !== validated.data[key])
        throw new Error("storage verification failed");
    }
  } catch {
    try {
      replaceOwnedStorage(storage, previous);
    } catch {
      throw new BackupRestoreRollbackError();
    }
    throw new Error("復元に失敗しました。現在のデータは元の状態に戻しました。");
  }
};

const twoDigits = (value: number) => String(value).padStart(2, "0");

export const appDataBackupFilename = (
  kind: "backup" | "before-restore" | "recovery",
  now = new Date(),
) => {
  const stamp = `${now.getFullYear()}${twoDigits(now.getMonth() + 1)}${twoDigits(now.getDate())}-${twoDigits(now.getHours())}${twoDigits(now.getMinutes())}${twoDigits(now.getSeconds())}`;
  const label =
    kind === "backup"
      ? "バックアップ"
      : kind === "before-restore"
        ? "復元前バックアップ"
        : "復旧用データ";
  return `カットマスタープロ_${label}_${stamp}.json`;
};
