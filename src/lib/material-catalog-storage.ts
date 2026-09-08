import { readOffcutBank } from "./offcut-bank.ts";
import {
  registerMaterial,
  validateMaterialCatalog,
  type RegisteredMaterial,
} from "./material-catalog.ts";

export const MATERIAL_CATALOG_KEY = "cut-master-pro:material-catalog:v1";

export interface MaterialCatalogOptions {
  names: string[];
  specifications: string[];
}

interface MaterialCatalogData extends MaterialCatalogOptions {
  materials: RegisteredMaterial[];
}

const uniqueOptions = (values: string[]) => [...new Set(values)];

const validateOptions = (values: unknown) => {
  if (
    !Array.isArray(values) ||
    values.some((value) => typeof value !== "string" || !value.trim() || value !== value.trim()) ||
    new Set(values).size !== values.length
  )
    throw new Error("材料一覧が壊れています。");
  return values as string[];
};

const optionsFromMaterials = (materials: RegisteredMaterial[]): MaterialCatalogOptions => ({
  names: uniqueOptions(materials.map((material) => material.name)),
  specifications: uniqueOptions(materials.map((material) => material.specification)),
});

const readMaterialCatalogData = (storage: Pick<Storage, "getItem">): MaterialCatalogData => {
  const raw = storage.getItem(MATERIAL_CATALOG_KEY);
  if (raw === null) {
    const materials = readOffcutBank(storage).catalog;
    return { materials, ...optionsFromMaterials(materials) };
  }

  const value = JSON.parse(raw);
  if (value.version !== 1 && value.version !== 2) throw new Error();
  validateMaterialCatalog(value.materials);
  const derived = optionsFromMaterials(value.materials);
  if (value.version === 1) return { materials: value.materials, ...derived };
  const names = validateOptions(value.names);
  const specifications = validateOptions(value.specifications);
  return {
    materials: value.materials,
    names: uniqueOptions([...names, ...derived.names]),
    specifications: uniqueOptions([...specifications, ...derived.specifications]),
  };
};

const writeMaterialCatalogData = (storage: Pick<Storage, "setItem">, data: MaterialCatalogData) => {
  storage.setItem(MATERIAL_CATALOG_KEY, JSON.stringify({ version: 2, ...data }));
  return data;
};

/** Read the retired bank only for migration. Never rewrite or delete it. */
export function readMaterialCatalog(storage: Pick<Storage, "getItem">): RegisteredMaterial[] {
  try {
    return readMaterialCatalogData(storage).materials;
  } catch {
    throw new Error(
      "材料一覧を読み込めません。手入力で計算できます。元の保存データは変更していません。",
    );
  }
}

export function readMaterialCatalogOptions(
  storage: Pick<Storage, "getItem">,
): MaterialCatalogOptions {
  try {
    const { names, specifications } = readMaterialCatalogData(storage);
    return { names, specifications };
  } catch {
    throw new Error(
      "材料一覧を読み込めません。手入力で計算できます。元の保存データは変更していません。",
    );
  }
}

export function saveRegisteredMaterial(
  storage: Pick<Storage, "getItem" | "setItem">,
  entry: RegisteredMaterial,
) {
  const data = readMaterialCatalogData(storage);
  const materials = registerMaterial(data.materials, entry);
  return writeMaterialCatalogData(storage, {
    materials,
    names: uniqueOptions([...data.names, entry.name.trim()]),
    specifications: uniqueOptions([...data.specifications, entry.specification.trim()]),
  }).materials;
}

export function saveRegisteredMaterialName(
  storage: Pick<Storage, "getItem" | "setItem">,
  name: string,
) {
  const normalized = name.trim();
  if (!normalized) throw new Error("登録する材料名を入力してください。");
  const data = readMaterialCatalogData(storage);
  return writeMaterialCatalogData(storage, {
    ...data,
    names: uniqueOptions([...data.names, normalized]),
  });
}

export function saveRegisteredSpecification(
  storage: Pick<Storage, "getItem" | "setItem">,
  specification: string,
) {
  const normalized = specification.trim();
  if (!normalized) throw new Error("登録する規格名を入力してください。");
  const data = readMaterialCatalogData(storage);
  return writeMaterialCatalogData(storage, {
    ...data,
    specifications: uniqueOptions([...data.specifications, normalized]),
  });
}

export function removeRegisteredMaterial(
  storage: Pick<Storage, "getItem" | "setItem">,
  materialId: string,
) {
  if (!materialId) throw new Error("削除する材料を選び直してください。");
  const data = readMaterialCatalogData(storage);
  const materials = data.materials.filter((material) => material.id !== materialId);
  if (materials.length === data.materials.length)
    throw new Error("削除する材料が見つかりませんでした。");
  return writeMaterialCatalogData(storage, { ...data, materials }).materials;
}

export function removeRegisteredMaterialName(
  storage: Pick<Storage, "getItem" | "setItem">,
  name: string,
) {
  const data = readMaterialCatalogData(storage);
  if (!data.names.includes(name)) throw new Error("削除する材料名が見つかりませんでした。");
  return writeMaterialCatalogData(storage, {
    materials: data.materials.filter((material) => material.name !== name),
    names: data.names.filter((item) => item !== name),
    specifications: data.specifications,
  });
}

export function removeRegisteredSpecification(
  storage: Pick<Storage, "getItem" | "setItem">,
  specification: string,
) {
  const data = readMaterialCatalogData(storage);
  if (!data.specifications.includes(specification))
    throw new Error("削除する規格名が見つかりませんでした。");
  return writeMaterialCatalogData(storage, {
    materials: data.materials.filter((material) => material.specification !== specification),
    names: data.names,
    specifications: data.specifications.filter((item) => item !== specification),
  });
}

export async function withMaterialCatalogLock<T>(action: () => T): Promise<T> {
  if (!navigator.locks)
    throw new Error(
      "この環境では材料一覧を安全に保存できません。手入力で計算するか、localhost／HTTPSで開いてください。",
    );
  return navigator.locks.request(MATERIAL_CATALOG_KEY, action);
}
