import type { CutResult } from "@/lib/cutting-stock";

export const PROJECT_STORAGE_VERSION = 2 as const;
export const DRAFT_STORAGE_KEY = "cut-master-pro:draft:v1";
export const PROJECTS_STORAGE_KEY = "cut-master-pro:projects:v1";
export const PROJECT_FOLDERS_STORAGE_KEY = "cut-master-pro:project-folders:v1";

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

  const activeMaterialId =
    typeof project.activeMaterialId === "string" &&
    materials.some((material) => material.id === project.activeMaterialId)
      ? project.activeMaterialId
      : materials[0]!.id;

  if (candidate.version === PROJECT_STORAGE_VERSION && Array.isArray(calculation.materials)) {
    return {
      ...(candidate as unknown as ProjectSnapshot),
      project: {
        ...(project as unknown as ProjectSnapshot["project"]),
        activeMaterialId,
      },
    };
  }

  if (candidate.version !== 1) return null;
  const primaryMaterial = materials[0]!;
  const legacyRows = Array.isArray(estimate.rows) ? estimate.rows : [];
  return {
    version: PROJECT_STORAGE_VERSION,
    project: {
      name: typeof project.name === "string" ? project.name : "",
      activeProjectId: typeof project.activeProjectId === "string" ? project.activeProjectId : null,
      activeMaterialId: primaryMaterial.id,
    },
    materials,
    calculation: {
      materials: [
        {
          materialId: primaryMaterial.id,
          result: (calculation.result as CutResult | null | undefined) ?? null,
          inputKey: typeof calculation.inputKey === "string" ? calculation.inputKey : null,
        },
      ],
    },
    estimate: {
      ...estimate,
      rows: legacyRows.map((row) => ({
        ...row,
        materialId: primaryMaterial.id,
        materialName: primaryMaterial.name,
        materialSpecification: primaryMaterial.specification,
      })),
    },
  };
};

export const readDraft = (storage: Storage): ProjectSnapshot | null => {
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
  storage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(snapshot));
};

export const readProjects = (storage: Storage): SavedProject[] => {
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
  const projects = readProjects(storage);
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
  const next = readProjects(storage).filter((project) => project.id !== id);
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
  const projects = readProjects(storage);
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
  const nextProjects = readProjects(storage).map((project) =>
    project.folderId === folderId ? { ...project, folderId: undefined } : project,
  );
  writeProjectFolders(storage, nextFolders);
  storage.setItem(PROJECTS_STORAGE_KEY, JSON.stringify(nextProjects));
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
) => {
  const draft = readDraft(storage);
  const projects = readProjects(storage).map((project) =>
    snapshotUsesMaterialOption(project.snapshot, kind, currentValue)
      ? {
          ...project,
          snapshot: renameMaterialOptionInSnapshot(project.snapshot, kind, currentValue, nextValue),
        }
      : project,
  );
  storage.setItem(PROJECTS_STORAGE_KEY, JSON.stringify(projects));
  if (draft)
    writeDraft(storage, renameMaterialOptionInSnapshot(draft, kind, currentValue, nextValue));
  return projects;
};
