import { readOffcutBank } from "./offcut-bank.ts";
import {
  registerMaterial,
  validateMaterialCatalog,
  type RegisteredMaterial,
} from "./material-catalog.ts";

export const MATERIAL_CATALOG_KEY = "cut-master-pro:material-catalog:v1";

/** Read the retired bank only for migration. Never rewrite or delete it. */
export function readMaterialCatalog(storage: Pick<Storage, "getItem">): RegisteredMaterial[] {
  const raw = storage.getItem(MATERIAL_CATALOG_KEY);
  try {
    if (raw === null) return readOffcutBank(storage).catalog;
    const value = JSON.parse(raw);
    if (value.version !== 1) throw new Error();
    validateMaterialCatalog(value.materials);
    return value.materials;
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
  const catalog = registerMaterial(readMaterialCatalog(storage), entry);
  storage.setItem(MATERIAL_CATALOG_KEY, JSON.stringify({ version: 1, materials: catalog }));
  return catalog;
}

export function removeRegisteredMaterial(
  storage: Pick<Storage, "getItem" | "setItem">,
  materialId: string,
) {
  if (!materialId) throw new Error("削除する材料を選び直してください。");
  const catalog = readMaterialCatalog(storage);
  const next = catalog.filter((material) => material.id !== materialId);
  if (next.length === catalog.length) throw new Error("削除する材料が見つかりませんでした。");
  storage.setItem(MATERIAL_CATALOG_KEY, JSON.stringify({ version: 1, materials: next }));
  return next;
}

export async function withMaterialCatalogLock<T>(action: () => T): Promise<T> {
  if (!navigator.locks)
    throw new Error(
      "この環境では材料一覧を安全に保存できません。手入力で計算するか、localhost／HTTPSで開いてください。",
    );
  return navigator.locks.request(MATERIAL_CATALOG_KEY, action);
}
