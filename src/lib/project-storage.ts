import type { CutResult } from "@/lib/cutting-stock";

export const PROJECT_STORAGE_VERSION = 2 as const;
export const DRAFT_STORAGE_KEY = "cut-master-pro:draft:v1";
export const PROJECTS_STORAGE_KEY = "cut-master-pro:projects:v1";
export const PROJECT_FOLDERS_STORAGE_KEY = "cut-master-pro:project-folders:v1";
const CALCULATION_ALGORITHM_VERSION = 2 as const;

export interface ProjectPieceInput {
  id: string;
  name: string;
  length: string;
  qty: string;
}

export interface ProjectStockInput {
  id: string;
  length: string;
  /** On-hand count; ignored in purchase mode and treated as zero when blank in inventory mode. */
  quantity?: string;
}

/** An actually measured offcut used only by this project material. */
export interface ProjectManualOffcutInput {
  id: string;
  length: string;
  quantity: string;
}

export interface ProjectQuoteRow {
  materialId: string;
  materialName: string;
  materialSpecification: string;
  stockLength: number;
  qty: string;
  price: string;
}

export interface ProjectMaterialCalculation {
  materialId: string;
  result: CutResult | null;
  inputKey: string | null;
}

export type MaterialStockMode = "purchase" | "inventory";

export interface ProjectMaterial {
  id: string;
  /** Standard-length planning ignores retired inventory fields without erasing them. */
  planningMode?: "standard";
  /** Shared registered material/specification identity, distinct from this job's material row ID. */
  catalogId?: string;
  name: string;
  specification: string;
  /** Legacy projects infer inventory mode only when a stock quantity was entered. */
  stockMode?: MaterialStockMode;
  stocks: ProjectStockInput[];
  kerf: string;
  pieces: ProjectPieceInput[];
  /** A cutting job keeps its identity across recalculation and project restores. */
  workId?: string;
  /** Project-local measured offcuts. These never read from or update the retired offcut bank. */
  manualOffcuts?: ProjectManualOffcutInput[];
  /** Retired offcut-bank selections kept only so old saved projects remain readable. */
  offcuts?: { id: string; length: number; quantity: string }[];
}

export const getMaterialStockMode = (
  material: Pick<ProjectMaterial, "stockMode" | "stocks">,
): MaterialStockMode =>
  material.stockMode ??
  (material.stocks.some((stock) => Boolean(stock.quantity?.trim())) ? "inventory" : "purchase");

export interface ProjectSnapshot {
  version: typeof PROJECT_STORAGE_VERSION;
  project: {
    name: string;
    activeProjectId: string | null;
    activeMaterialId: string;
  };
  materials: ProjectMaterial[];
  calculation: {
    materials: ProjectMaterialCalculation[];
  };
  estimate: {
    rows: ProjectQuoteRow[];
    /** ISO local date (YYYY-MM-DD). Optional only for snapshots saved before this field existed. */
    issuedOn?: string;
    recipient: string;
    issuer: string;
    notes: string;
    laborCost: string;
    otherCost: string;
    taxRate: string;
  };
}

export const createCalculationInputKey = (
  material: Pick<ProjectMaterial, "stockMode" | "stocks" | "kerf" | "pieces"> &
    Partial<
      Pick<
        ProjectMaterial,
        "manualOffcuts" | "offcuts" | "name" | "specification" | "catalogId" | "planningMode"
      >
    >,
) => {
  const stockMode =
    material.planningMode === "standard" ? "purchase" : getMaterialStockMode(material);
  return JSON.stringify({
    algorithmVersion: CALCULATION_ALGORITHM_VERSION,
    ...(stockMode === "inventory" ? { stockMode } : {}),
    stocks: material.stocks.map((stock) =>
      stockMode === "inventory"
        ? { length: stock.length, quantity: stock.quantity?.trim() || "0" }
        : stock.length,
    ),
    kerf: material.kerf,
    pieces: material.pieces.map((piece) => ({ length: piece.length, qty: piece.qty })),
    ...(material.manualOffcuts?.length
      ? {
          manualOffcuts: material.manualOffcuts.map((offcut) => ({
            length: offcut.length,
            quantity: offcut.quantity,
          })),
        }
      : {}),
    ...(material.planningMode !== "standard" && material.offcuts?.length
      ? {
          offcuts: material.offcuts,
          identity: material.catalogId ?? [material.name?.trim(), material.specification?.trim()],
        }
      : {}),
  });
};

/**
 * Completion receipts created before the cutting algorithm was versioned must
 * remain readable. They are accepted only for restoring an already-completed
 * job; ordinary saved calculations still require the current key and are
 * therefore recalculated under the latest rules.
 */
export const isCompatibleCompletionInputKey = (
  material: Parameters<typeof createCalculationInputKey>[0],
  inputKey: string | null,
) => {
  if (inputKey === createCalculationInputKey(material)) return true;
  if (!inputKey) return false;
  try {
    const stored = JSON.parse(inputKey) as Record<string, unknown>;
    if (!stored || typeof stored !== "object" || Array.isArray(stored)) return false;
    const storedVersion = stored.algorithmVersion;
    if (
      storedVersion !== undefined &&
      (!Number.isSafeInteger(storedVersion) ||
        Number(storedVersion) < 1 ||
        Number(storedVersion) > CALCULATION_ALGORITHM_VERSION)
    )
      return false;
    delete stored.algorithmVersion;
    const expected = JSON.parse(createCalculationInputKey(material)) as Record<string, unknown>;
    delete expected.algorithmVersion;
    return JSON.stringify(stored) === JSON.stringify(expected);
  } catch {
    return false;
  }
};

export interface SavedProject {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  /** One-level organizer only. Missing means the project is uncategorized. */
  folderId?: string;
  snapshot: ProjectSnapshot;
}

export interface ProjectFolder {
  id: string;
  name: string;
  createdAt: string;
}

export type ProjectStorageArea = "draft" | "projects";

export class ProjectStorageReadError extends Error {
  readonly area: ProjectStorageArea;
  readonly key: typeof DRAFT_STORAGE_KEY | typeof PROJECTS_STORAGE_KEY;
  readonly raw: string | null | undefined;
  readonly reason: "invalid" | "unavailable";

  constructor(
    area: ProjectStorageArea,
    options: {
      key: typeof DRAFT_STORAGE_KEY | typeof PROJECTS_STORAGE_KEY;
      raw: string | null | undefined;
      reason: "invalid" | "unavailable";
    },
  ) {
    const label = area === "draft" ? "作業中の案件" : "案件履歴";
    super(
      options.reason === "invalid"
        ? `${label}を読み込めません。元データは変更せず、そのまま残しています。`
        : `${label}の保存領域を確認できません。安全のため保存を停止しました。`,
    );
    this.name = "ProjectStorageReadError";
    this.area = area;
    this.key = options.key;
    this.raw = options.raw;
    this.reason = options.reason;
  }
}

export class ProjectStorageRollbackError extends Error {
  constructor() {
    super(
      "保存に失敗し、元の状態へ完全に戻せませんでした。安全のため自動保存を停止しました。画面を閉じず、バックアップを保管してください。",
    );
    this.name = "ProjectStorageRollbackError";
  }
}

export interface ProjectStorageInspection {
  draft: ProjectSnapshot | null;
  projects: SavedProject[];
  issues: ProjectStorageReadError[];
}

const migrateSnapshot = (value: unknown): ProjectSnapshot | null => {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  const project = candidate.project as Record<string, unknown> | undefined;
  const materials = candidate.materials as ProjectMaterial[] | undefined;
  const calculation = candidate.calculation as Record<string, unknown> | undefined;
  const estimate = candidate.estimate as ProjectSnapshot["estimate"] | undefined;
  if (
    !project ||
    !Array.isArray(materials) ||
    materials.length === 0 ||
    !calculation ||
    !estimate
  ) {
    return null;
  }

  if (candidate.version === PROJECT_STORAGE_VERSION && Array.isArray(calculation.materials)) {
    return isProjectSnapshot(candidate) ? (candidate as unknown as ProjectSnapshot) : null;
  }

  if (candidate.version !== 1) return null;
  if (
    typeof project.name !== "string" ||
    (project.activeProjectId !== undefined &&
      project.activeProjectId !== null &&
      typeof project.activeProjectId !== "string") ||
    !Array.isArray(estimate.rows) ||
    (calculation.inputKey !== undefined &&
      calculation.inputKey !== null &&
      typeof calculation.inputKey !== "string")
  )
    return null;
  const primaryMaterial = materials[0]!;
  const migrated: ProjectSnapshot = {
    version: PROJECT_STORAGE_VERSION,
    project: {
      name: project.name,
      activeProjectId:
        project.activeProjectId === undefined ? null : (project.activeProjectId as string | null),
      activeMaterialId: primaryMaterial.id,
    },
    materials,
    calculation: {
      materials: [
        {
          materialId: primaryMaterial.id,
          result:
            calculation.result === undefined ? null : (calculation.result as CutResult | null),
          inputKey:
            calculation.inputKey === undefined ? null : (calculation.inputKey as string | null),
        },
      ],
    },
    estimate: {
      ...estimate,
      rows: estimate.rows.map((row) => ({
        ...row,
        materialId: primaryMaterial.id,
        materialName: primaryMaterial.name,
        materialSpecification: primaryMaterial.specification,
      })),
    },
  };
  return isProjectSnapshot(migrated) ? migrated : null;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const isOptionalString = (value: unknown) => value === undefined || typeof value === "string";

const isFiniteNumber = (value: unknown) => typeof value === "number" && Number.isFinite(value);

const isNonNegativeInteger = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const isPieceCountList = (value: unknown) =>
  Array.isArray(value) &&
  value.every(
    (piece) =>
      isRecord(piece) &&
      isFiniteNumber(piece.length) &&
      isNonNegativeInteger(piece.qty) &&
      isOptionalString(piece.label),
  );

const isCutResult = (value: unknown): value is CutResult => {
  if (!isRecord(value)) return false;
  if (
    !Array.isArray(value.bars) ||
    !Array.isArray(value.stockUsage) ||
    !isFiniteNumber(value.totalStock) ||
    !isFiniteNumber(value.totalRequiredLength) ||
    !isFiniteNumber(value.totalStockLength) ||
    !isFiniteNumber(value.totalKerf) ||
    !isFiniteNumber(value.totalWaste) ||
    !isFiniteNumber(value.yieldRate) ||
    !isPieceCountList(value.unfittable)
  )
    return false;

  const barsAreValid = value.bars.every(
    (bar) =>
      isRecord(bar) &&
      isFiniteNumber(bar.stockLength) &&
      Array.isArray(bar.pieces) &&
      bar.pieces.every(
        (piece) =>
          isRecord(piece) &&
          isFiniteNumber(piece.length) &&
          isNonNegativeInteger(piece.pieceIndex) &&
          isOptionalString(piece.label),
      ) &&
      isFiniteNumber(bar.used) &&
      isFiniteNumber(bar.waste) &&
      (bar.source === undefined ||
        bar.source === "inventory" ||
        bar.source === "purchase" ||
        bar.source === "offcut") &&
      isOptionalString(bar.offcutId),
  );
  if (!barsAreValid) return false;

  const stockUsageIsValid = value.stockUsage.every(
    (usage) =>
      isRecord(usage) &&
      isFiniteNumber(usage.stockLength) &&
      isNonNegativeInteger(usage.count) &&
      [usage.availableCount, usage.inventoryCount, usage.purchaseCount, usage.offcutCount].every(
        (count) => count === undefined || isNonNegativeInteger(count),
      ),
  );
  if (!stockUsageIsValid) return false;

  if (value.inventoryShortage !== undefined && value.inventoryShortage !== null) {
    if (
      !isRecord(value.inventoryShortage) ||
      !isPieceCountList(value.inventoryShortage.pieces) ||
      !Array.isArray(value.inventoryShortage.suggestedStock) ||
      !value.inventoryShortage.suggestedStock.every(
        (stock) =>
          isRecord(stock) &&
          isFiniteNumber(stock.stockLength) &&
          isNonNegativeInteger(stock.count) &&
          [
            stock.availableCount,
            stock.inventoryCount,
            stock.purchaseCount,
            stock.offcutCount,
          ].every((count) => count === undefined || isNonNegativeInteger(count)),
      )
    )
      return false;
  }
  return true;
};

export const isProjectSnapshot = (value: unknown): value is ProjectSnapshot => {
  if (!isRecord(value)) return false;
  const snapshot = value as unknown as ProjectSnapshot;
  if (
    snapshot.version !== PROJECT_STORAGE_VERSION ||
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
    !Array.isArray(snapshot.estimate.rows) ||
    !isOptionalString(snapshot.estimate.issuedOn) ||
    [
      snapshot.estimate.recipient,
      snapshot.estimate.issuer,
      snapshot.estimate.notes,
      snapshot.estimate.laborCost,
      snapshot.estimate.otherCost,
      snapshot.estimate.taxRate,
    ].some((item) => typeof item !== "string")
  )
    return false;

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
      !isOptionalString(material.catalogId) ||
      !isOptionalString(material.workId) ||
      (material.planningMode !== undefined && material.planningMode !== "standard") ||
      (material.stockMode !== undefined &&
        material.stockMode !== "purchase" &&
        material.stockMode !== "inventory")
    )
      return false;
    materialIds.add(material.id);
    if (
      !material.stocks.every(
        (stock) =>
          isRecord(stock) &&
          typeof stock.id === "string" &&
          typeof stock.length === "string" &&
          isOptionalString(stock.quantity),
      ) ||
      !material.pieces.every(
        (piece) =>
          isRecord(piece) &&
          typeof piece.id === "string" &&
          typeof piece.name === "string" &&
          typeof piece.length === "string" &&
          typeof piece.qty === "string",
      ) ||
      (material.manualOffcuts !== undefined &&
        (!Array.isArray(material.manualOffcuts) ||
          !material.manualOffcuts.every(
            (offcut) =>
              isRecord(offcut) &&
              typeof offcut.id === "string" &&
              typeof offcut.length === "string" &&
              typeof offcut.quantity === "string",
          ))) ||
      (material.offcuts !== undefined &&
        (!Array.isArray(material.offcuts) ||
          !material.offcuts.every(
            (offcut) =>
              isRecord(offcut) &&
              typeof offcut.id === "string" &&
              isFiniteNumber(offcut.length) &&
              typeof offcut.quantity === "string",
          )))
    )
      return false;
  }
  if (!materialIds.has(snapshot.project.activeMaterialId)) return false;

  const calculationIds = new Set<string>();
  if (
    !snapshot.calculation.materials.every((calculation) => {
      if (
        !isRecord(calculation) ||
        typeof calculation.materialId !== "string" ||
        !materialIds.has(calculation.materialId) ||
        calculationIds.has(calculation.materialId) ||
        (calculation.inputKey !== null && typeof calculation.inputKey !== "string") ||
        (calculation.result !== null && !isCutResult(calculation.result))
      )
        return false;
      calculationIds.add(calculation.materialId);
      return true;
    })
  )
    return false;

  return snapshot.estimate.rows.every(
    (row) =>
      isRecord(row) &&
      typeof row.materialId === "string" &&
      materialIds.has(row.materialId) &&
      typeof row.materialName === "string" &&
      typeof row.materialSpecification === "string" &&
      isFiniteNumber(row.stockLength) &&
      typeof row.qty === "string" &&
      typeof row.price === "string",
  );
};

const decodeDraft = (raw: string) => {
  const parsed: unknown = JSON.parse(raw);
  const snapshot = migrateSnapshot(parsed);
  if (!snapshot || !isProjectSnapshot(snapshot)) throw new Error("invalid draft");
  return snapshot;
};

const decodeProjects = (raw: string) => {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error("invalid projects");
  const ids = new Set<string>();
  return parsed.map((item): SavedProject => {
    if (!isRecord(item)) throw new Error("invalid project");
    const saved = item as unknown as SavedProject;
    const snapshot = migrateSnapshot(saved.snapshot);
    if (
      typeof saved.id !== "string" ||
      !saved.id ||
      ids.has(saved.id) ||
      typeof saved.name !== "string" ||
      (Object.hasOwn(saved, "createdAt") && typeof saved.createdAt !== "string") ||
      (Object.hasOwn(saved, "updatedAt") && typeof saved.updatedAt !== "string") ||
      (Object.hasOwn(saved, "folderId") && typeof saved.folderId !== "string") ||
      !snapshot ||
      !isProjectSnapshot(snapshot)
    )
      throw new Error("invalid project");
    ids.add(saved.id);
    const fallbackTimestamp = "1970-01-01T00:00:00.000Z";
    const createdAt =
      typeof saved.createdAt === "string"
        ? saved.createdAt
        : typeof saved.updatedAt === "string"
          ? saved.updatedAt
          : fallbackTimestamp;
    const updatedAt =
      typeof saved.updatedAt === "string"
        ? saved.updatedAt
        : typeof saved.createdAt === "string"
          ? saved.createdAt
          : fallbackTimestamp;
    return {
      ...saved,
      createdAt,
      updatedAt,
      folderId: typeof saved.folderId === "string" && saved.folderId ? saved.folderId : undefined,
      snapshot,
    };
  });
};

const readRaw = (
  storage: Pick<Storage, "getItem">,
  area: ProjectStorageArea,
  key: typeof DRAFT_STORAGE_KEY | typeof PROJECTS_STORAGE_KEY,
) => {
  try {
    return storage.getItem(key);
  } catch {
    throw new ProjectStorageReadError(area, { key, raw: undefined, reason: "unavailable" });
  }
};

export const readDraftStrict = (storage: Pick<Storage, "getItem">): ProjectSnapshot | null => {
  const raw = readRaw(storage, "draft", DRAFT_STORAGE_KEY);
  if (raw === null) return null;
  try {
    return decodeDraft(raw);
  } catch {
    throw new ProjectStorageReadError("draft", {
      key: DRAFT_STORAGE_KEY,
      raw,
      reason: "invalid",
    });
  }
};

export const readProjectsStrict = (storage: Pick<Storage, "getItem">): SavedProject[] => {
  const raw = readRaw(storage, "projects", PROJECTS_STORAGE_KEY);
  if (raw === null) return [];
  try {
    return decodeProjects(raw);
  } catch {
    throw new ProjectStorageReadError("projects", {
      key: PROJECTS_STORAGE_KEY,
      raw,
      reason: "invalid",
    });
  }
};

export const inspectProjectStorage = (
  storage: Pick<Storage, "getItem">,
): ProjectStorageInspection => {
  let draft: ProjectSnapshot | null = null;
  let projects: SavedProject[] = [];
  const issues: ProjectStorageReadError[] = [];
  try {
    draft = readDraftStrict(storage);
  } catch (failure) {
    issues.push(
      failure instanceof ProjectStorageReadError
        ? failure
        : new ProjectStorageReadError("draft", {
            key: DRAFT_STORAGE_KEY,
            raw: undefined,
            reason: "unavailable",
          }),
    );
  }
  try {
    projects = readProjectsStrict(storage);
  } catch (failure) {
    issues.push(
      failure instanceof ProjectStorageReadError
        ? failure
        : new ProjectStorageReadError("projects", {
            key: PROJECTS_STORAGE_KEY,
            raw: undefined,
            reason: "unavailable",
          }),
    );
  }
  return { draft, projects, issues };
};

export const resetInvalidProjectStorage = (
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem">,
  issues: readonly ProjectStorageReadError[],
  replacements: Partial<
    Record<typeof DRAFT_STORAGE_KEY | typeof PROJECTS_STORAGE_KEY, string | null>
  > = {},
) => {
  const targets = [...new Map(issues.map((issue) => [issue.key, issue])).values()];
  if (targets.length === 0) throw new Error("初期化する保存データがありません。");

  for (const issue of targets) {
    if (issue.reason !== "invalid" || typeof issue.raw !== "string")
      throw new Error(
        "保存領域を安全に確認できないため、初期化できません。ブラウザを再起動してからもう一度お試しください。",
      );
    let current: string | null;
    try {
      current = storage.getItem(issue.key);
    } catch {
      throw new Error("退避後の保存データを確認できないため、初期化していません。");
    }
    if (current !== issue.raw)
      throw new Error(
        "復旧用ファイルを保存した後にデータが変更されました。安全のため初期化していません。もう一度保存してください。",
      );
    const stillInvalid = (() => {
      try {
        if (issue.area === "draft") decodeDraft(current);
        else decodeProjects(current);
        return false;
      } catch {
        return true;
      }
    })();
    if (!stillInvalid)
      throw new Error("現在の保存データは正常です。初期化せず画面を再読み込みしてください。");

    const replacement = Object.hasOwn(replacements, issue.key) ? replacements[issue.key] : null;
    if (replacement !== null && replacement !== undefined) {
      try {
        if (issue.area === "draft") decodeDraft(replacement);
        else decodeProjects(replacement);
      } catch {
        throw new Error("復旧用ファイルの安全なデータを確認できないため、初期化していません。");
      }
    }
  }

  const changed: ProjectStorageReadError[] = [];
  try {
    for (const issue of targets) {
      const replacement = Object.hasOwn(replacements, issue.key) ? replacements[issue.key] : null;
      if (typeof replacement === "string") storage.setItem(issue.key, replacement);
      else storage.removeItem(issue.key);
      changed.push(issue);
    }
  } catch {
    try {
      for (const issue of changed) storage.setItem(issue.key, issue.raw as string);
    } catch {
      throw new Error(
        "初期化に失敗し、元データを完全に戻せませんでした。画面を閉じず、復旧用ファイルを保管してください。",
      );
    }
    throw new Error("初期化に失敗しました。元データはそのまま残しています。");
  }
};

export const readDraft = (storage: Pick<Storage, "getItem">): ProjectSnapshot | null => {
  try {
    const raw = storage.getItem(DRAFT_STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return migrateSnapshot(parsed);
  } catch {
    return null;
  }
};

export const writeDraft = (storage: Storage, snapshot: ProjectSnapshot) => {
  readDraftStrict(storage);
  if (!isProjectSnapshot(snapshot)) throw new Error("保存する下書きの内容が不正です。");
  storage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(snapshot));
};

export const readProjects = (storage: Pick<Storage, "getItem">): SavedProject[] => {
  try {
    const raw = storage.getItem(PROJECTS_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item): SavedProject[] => {
      if (!item || typeof item !== "object") return [];
      const saved = item as SavedProject;
      const snapshot = migrateSnapshot(saved.snapshot);
      if (typeof saved.id !== "string" || typeof saved.name !== "string" || !snapshot) return [];
      return [
        {
          ...saved,
          folderId:
            typeof saved.folderId === "string" && saved.folderId ? saved.folderId : undefined,
          snapshot,
        },
      ];
    });
  } catch {
    return [];
  }
};

export const saveProject = (
  storage: Storage,
  snapshot: ProjectSnapshot,
  id: string,
  now = new Date().toISOString(),
  folderId?: string | null,
): SavedProject[] => {
  const projects = readProjectsStrict(storage);
  if (!isProjectSnapshot(snapshot)) throw new Error("保存する案件の内容が不正です。");
  const previous = projects.find((project) => project.id === id);
  const saved: SavedProject = {
    id,
    name: snapshot.project.name.trim() || "名称未設定の案件",
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
    folderId: folderId === undefined ? previous?.folderId : folderId || undefined,
    snapshot: {
      ...snapshot,
      project: { ...snapshot.project, activeProjectId: id },
    },
  };
  const next = [saved, ...projects.filter((project) => project.id !== id)].sort((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt),
  );
  storage.setItem(PROJECTS_STORAGE_KEY, JSON.stringify(next));
  return next;
};

export const removeProject = (storage: Storage, id: string): SavedProject[] => {
  const projects = readProjectsStrict(storage);
  if (!projects.some((project) => project.id === id))
    throw new Error("削除する案件が見つかりませんでした。");
  const next = projects.filter((project) => project.id !== id);
  storage.setItem(PROJECTS_STORAGE_KEY, JSON.stringify(next));
  return next;
};

export const readProjectFolders = (storage: Pick<Storage, "getItem">): ProjectFolder[] => {
  try {
    const raw = storage.getItem(PROJECT_FOLDERS_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") throw new Error();
    const value = parsed as { version?: unknown; folders?: unknown };
    if (value.version !== 1 || !Array.isArray(value.folders)) throw new Error();
    const ids = new Set<string>();
    const names = new Set<string>();
    return value.folders.map((item): ProjectFolder => {
      if (!item || typeof item !== "object") throw new Error();
      const folder = item as ProjectFolder;
      if (
        typeof folder.id !== "string" ||
        !folder.id ||
        ids.has(folder.id) ||
        typeof folder.name !== "string" ||
        !folder.name.trim() ||
        folder.name !== folder.name.trim() ||
        names.has(folder.name) ||
        typeof folder.createdAt !== "string"
      )
        throw new Error();
      ids.add(folder.id);
      names.add(folder.name);
      return folder;
    });
  } catch {
    throw new Error("フォルダー情報を読み込めません。案件データは変更せず、そのまま残しています。");
  }
};

const writeProjectFolders = (storage: Pick<Storage, "setItem">, folders: ProjectFolder[]) => {
  storage.setItem(PROJECT_FOLDERS_STORAGE_KEY, JSON.stringify({ version: 1, folders }));
  return folders;
};

const writeStorageEntriesAtomically = (
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem">,
  entries: readonly { key: string; value: string | null }[],
) => {
  const previous = new Map<string, string | null>();
  try {
    for (const { key } of entries) previous.set(key, storage.getItem(key));
  } catch {
    throw new Error("現在の保存データを確認できないため、変更していません。");
  }

  const attempted: string[] = [];
  try {
    for (const { key, value } of entries) {
      attempted.push(key);
      if (value === null) storage.removeItem(key);
      else storage.setItem(key, value);
      if (storage.getItem(key) !== value) throw new Error("storage verification failed");
    }
  } catch {
    try {
      for (const key of attempted.reverse()) {
        const value = previous.get(key) ?? null;
        if (value === null) storage.removeItem(key);
        else storage.setItem(key, value);
      }
    } catch {
      throw new ProjectStorageRollbackError();
    }
    throw new Error("保存に失敗したため、変更前の状態へ戻しました。");
  }
};

export const createProjectFolder = (
  storage: Pick<Storage, "getItem" | "setItem">,
  folder: ProjectFolder,
) => {
  const name = folder.name.trim();
  if (!name) throw new Error("フォルダー名を入力してください。");
  const folders = readProjectFolders(storage);
  if (folders.some((item) => item.id === folder.id))
    throw new Error("フォルダーを作り直してください。");
  if (folders.some((item) => item.name === name)) throw new Error(`「${name}」はすでにあります。`);
  return writeProjectFolders(storage, [...folders, { ...folder, name }]);
};

export const renameProjectFolder = (
  storage: Pick<Storage, "getItem" | "setItem">,
  folderId: string,
  nextName: string,
) => {
  const name = nextName.trim();
  if (!name) throw new Error("変更後のフォルダー名を入力してください。");
  const folders = readProjectFolders(storage);
  if (!folders.some((folder) => folder.id === folderId))
    throw new Error("変更するフォルダーが見つかりませんでした。");
  if (folders.some((folder) => folder.id !== folderId && folder.name === name))
    throw new Error(`「${name}」はすでにあります。`);
  return writeProjectFolders(
    storage,
    folders.map((folder) => (folder.id === folderId ? { ...folder, name } : folder)),
  );
};

export const moveProjectToFolder = (
  storage: Storage,
  projectId: string,
  folderId: string | null,
) => {
  if (folderId && !readProjectFolders(storage).some((folder) => folder.id === folderId))
    throw new Error("移動先のフォルダーが見つかりませんでした。");
  const projects = readProjectsStrict(storage);
  if (!projects.some((project) => project.id === projectId))
    throw new Error("移動する案件が見つかりませんでした。");
  const next = projects.map((project) =>
    project.id === projectId ? { ...project, folderId: folderId || undefined } : project,
  );
  storage.setItem(PROJECTS_STORAGE_KEY, JSON.stringify(next));
  return next;
};

export const removeProjectFolder = (storage: Storage, folderId: string) => {
  const folders = readProjectFolders(storage);
  if (!folders.some((folder) => folder.id === folderId))
    throw new Error("削除するフォルダーが見つかりませんでした。");
  const nextFolders = folders.filter((folder) => folder.id !== folderId);
  const nextProjects = readProjectsStrict(storage).map((project) =>
    project.folderId === folderId ? { ...project, folderId: undefined } : project,
  );
  writeStorageEntriesAtomically(storage, [
    {
      key: PROJECT_FOLDERS_STORAGE_KEY,
      value: JSON.stringify({ version: 1, folders: nextFolders }),
    },
    { key: PROJECTS_STORAGE_KEY, value: JSON.stringify(nextProjects) },
  ]);
  return { folders: nextFolders, projects: nextProjects };
};

export type MaterialOptionKind = "name" | "specification";

const snapshotUsesMaterialOption = (
  snapshot: ProjectSnapshot,
  kind: MaterialOptionKind,
  value: string,
) =>
  snapshot.materials.some((material) =>
    kind === "name" ? material.name === value : material.specification === value,
  ) ||
  snapshot.estimate.rows.some((row) =>
    kind === "name" ? row.materialName === value : row.materialSpecification === value,
  );

export const countProjectsUsingMaterialOption = (
  projects: SavedProject[],
  kind: MaterialOptionKind,
  value: string,
) => projects.filter((project) => snapshotUsesMaterialOption(project.snapshot, kind, value)).length;

/** Rename display text only. Cutting dimensions, quantities and calculated results stay untouched. */
export const renameMaterialOptionInSnapshot = (
  snapshot: ProjectSnapshot,
  kind: MaterialOptionKind,
  currentValue: string,
  nextValue: string,
): ProjectSnapshot => {
  const materials = snapshot.materials.map((material) => {
    const matches =
      kind === "name" ? material.name === currentValue : material.specification === currentValue;
    if (!matches) return material;
    return kind === "name"
      ? { ...material, name: nextValue }
      : { ...material, specification: nextValue };
  });
  const calculations = snapshot.calculation.materials.map((calculation) => {
    const before = snapshot.materials.find((material) => material.id === calculation.materialId);
    const after = materials.find((material) => material.id === calculation.materialId);
    return before && after && calculation.inputKey === createCalculationInputKey(before)
      ? { ...calculation, inputKey: createCalculationInputKey(after) }
      : calculation;
  });
  return {
    ...snapshot,
    materials,
    calculation: { materials: calculations },
    estimate: {
      ...snapshot.estimate,
      rows: snapshot.estimate.rows.map((row) =>
        kind === "name" && row.materialName === currentValue
          ? { ...row, materialName: nextValue }
          : kind === "specification" && row.materialSpecification === currentValue
            ? { ...row, materialSpecification: nextValue }
            : row,
      ),
    },
  };
};

export const renameMaterialOptionInStoredProjects = (
  storage: Storage,
  kind: MaterialOptionKind,
  currentValue: string,
  nextValue: string,
  draftOverride?: ProjectSnapshot | null,
) => {
  const storedDraft = readDraftStrict(storage);
  if (draftOverride !== undefined && draftOverride !== null && !isProjectSnapshot(draftOverride))
    throw new Error("保存する下書きの内容が不正です。");
  const draft = draftOverride === undefined ? storedDraft : draftOverride;
  const projects = readProjectsStrict(storage).map((project) =>
    snapshotUsesMaterialOption(project.snapshot, kind, currentValue)
      ? {
          ...project,
          snapshot: renameMaterialOptionInSnapshot(project.snapshot, kind, currentValue, nextValue),
        }
      : project,
  );
  writeStorageEntriesAtomically(storage, [
    { key: PROJECTS_STORAGE_KEY, value: JSON.stringify(projects) },
    ...(draft
      ? [
          {
            key: DRAFT_STORAGE_KEY,
            value: JSON.stringify(
              renameMaterialOptionInSnapshot(draft, kind, currentValue, nextValue),
            ),
          },
        ]
      : []),
  ]);
  return projects;
};
