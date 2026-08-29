import type { CutResult } from "@/lib/cutting-stock";

export const PROJECT_STORAGE_VERSION = 2 as const;
export const DRAFT_STORAGE_KEY = "cut-master-pro:draft:v1";
export const PROJECTS_STORAGE_KEY = "cut-master-pro:projects:v1";

export interface ProjectPieceInput {
  id: string;
  name: string;
  length: string;
  qty: string;
}

export interface ProjectStockInput {
  id: string;
  length: string;
  /** Empty / missing keeps the legacy behavior: no quantity limit. */
  quantity?: string;
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

export interface ProjectMaterial {
  id: string;
  name: string;
  specification: string;
  stocks: ProjectStockInput[];
  kerf: string;
  pieces: ProjectPieceInput[];
}

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
    recipient: string;
    issuer: string;
    notes: string;
    laborCost: string;
    otherCost: string;
    taxRate: string;
  };
}

export const createCalculationInputKey = (
  material: Pick<ProjectMaterial, "stocks" | "kerf" | "pieces">,
) =>
  JSON.stringify({
    stocks: material.stocks.map((stock) =>
      stock.quantity?.trim() ? { length: stock.length, quantity: stock.quantity } : stock.length,
    ),
    kerf: material.kerf,
    pieces: material.pieces.map((piece) => ({ length: piece.length, qty: piece.qty })),
  });

export interface SavedProject {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  snapshot: ProjectSnapshot;
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
      return [{ ...saved, snapshot }];
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
): SavedProject[] => {
  const projects = readProjects(storage);
  const previous = projects.find((project) => project.id === id);
  const saved: SavedProject = {
    id,
    name: snapshot.project.name.trim() || "名称未設定の案件",
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
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
