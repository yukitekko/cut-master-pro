import type { CutResult } from "@/lib/cutting-stock";

export const PROJECT_STORAGE_VERSION = 1 as const;
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
}

export interface ProjectQuoteRow {
  stockLength: number;
  qty: string;
  price: string;
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
  };
  materials: ProjectMaterial[];
  calculation: {
    result: CutResult | null;
    inputKey?: string | null;
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
    stocks: material.stocks.map((stock) => stock.length),
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

const isSnapshot = (value: unknown): value is ProjectSnapshot => {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ProjectSnapshot>;
  return (
    candidate.version === PROJECT_STORAGE_VERSION &&
    !!candidate.project &&
    Array.isArray(candidate.materials) &&
    candidate.materials.length > 0 &&
    !!candidate.calculation &&
    !!candidate.estimate
  );
};

export const readDraft = (storage: Storage): ProjectSnapshot | null => {
  try {
    const raw = storage.getItem(DRAFT_STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isSnapshot(parsed) ? parsed : null;
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
    return parsed.filter(
      (item): item is SavedProject =>
        !!item &&
        typeof item === "object" &&
        typeof (item as SavedProject).id === "string" &&
        typeof (item as SavedProject).name === "string" &&
        isSnapshot((item as SavedProject).snapshot),
    );
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
