import type { ProjectMaterial } from "./project-storage.ts";

/** One identity per material/specification pair; lengths and prices stay in each job. */
export interface RegisteredMaterial {
  id: string;
  name: string;
  specification: string;
}

export function findRegisteredMaterial(
  catalog: RegisteredMaterial[],
  material: Pick<ProjectMaterial, "name" | "specification" | "catalogId">,
) {
  // Never silently replace an unknown ID by a similarly named material.
  return material.catalogId
    ? catalog.find((item) => item.id === material.catalogId)
    : catalog.find(
        (item) =>
          item.name === material.name.trim() &&
          item.specification === material.specification.trim(),
      );
}

export function registerMaterial(
  catalog: RegisteredMaterial[],
  entry: RegisteredMaterial,
): RegisteredMaterial[] {
  const normalized = {
    ...entry,
    name: entry.name.trim(),
    specification: entry.specification.trim(),
  };
  if (!normalized.id || !normalized.name || !normalized.specification)
    throw new Error("材料名と規格名を両方入力してください。例：SGP ／ 150A");
  if (findRegisteredMaterial(catalog, normalized)) return catalog;
  if (catalog.some((item) => item.id === normalized.id))
    throw new Error("材料の登録番号が重複しています。もう一度登録してください。");
  return [...catalog, normalized];
}

export function validateMaterialCatalog(value: unknown): asserts value is RegisteredMaterial[] {
  if (!Array.isArray(value)) throw new Error("材料一覧が壊れています。");
  const ids = new Set<string>();
  const pairs = new Set<string>();
  for (const item of value) {
    if (
      !item ||
      typeof item.id !== "string" ||
      !item.id ||
      ids.has(item.id) ||
      typeof item.name !== "string" ||
      !item.name.trim() ||
      item.name !== item.name.trim() ||
      typeof item.specification !== "string" ||
      !item.specification.trim() ||
      item.specification !== item.specification.trim()
    )
      throw new Error("材料一覧が壊れています。");
    const pair = JSON.stringify([item.name, item.specification]);
    if (pairs.has(pair)) throw new Error("材料の登録が重複しています。");
    ids.add(item.id);
    pairs.add(pair);
  }
}

/** Stable even if an old bank is read repeatedly before its first explicit save. */
export const legacyMaterialId = (name: string, specification: string) =>
  `legacy-material:${encodeURIComponent(JSON.stringify([name.trim(), specification.trim()]))}`;

export function linkRegisteredMaterial(material: ProjectMaterial, catalog: RegisteredMaterial[]) {
  const registered = findRegisteredMaterial(catalog, material);
  return registered ? { ...material, catalogId: registered.id } : material;
}

/** Selecting a different pair keeps dimensions, but cannot carry over another material's offcuts. */
export function chooseRegisteredMaterial(
  material: ProjectMaterial,
  selected: RegisteredMaterial,
): ProjectMaterial {
  const same = material.catalogId
    ? material.catalogId === selected.id
    : material.name.trim() === selected.name &&
      material.specification.trim() === selected.specification;
  return {
    ...material,
    catalogId: selected.id,
    name: selected.name,
    specification: selected.specification,
    offcuts: same ? material.offcuts : [],
  };
}
