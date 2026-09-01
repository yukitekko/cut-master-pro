import { solveCuttingStock, type Piece } from "./cutting-stock.ts";
import {
  createCalculationInputKey,
  getMaterialStockMode,
  type ProjectMaterial,
  type ProjectMaterialCalculation,
  type ProjectSnapshot,
} from "./project-storage.ts";
import { linkRegisteredMaterial, type RegisteredMaterial } from "./material-catalog.ts";
import { emptyOffcutBank, restoreCompletedWork, type OffcutBank } from "./offcut-bank.ts";

export function hasLegacyInventoryConditions(
  material: ProjectMaterial,
  calculation?: ProjectMaterialCalculation,
) {
  return Boolean(
    (material.planningMode !== "standard" &&
      (getMaterialStockMode(material) === "inventory" || material.offcuts?.length)) ||
    calculation?.result?.bars.some(
      (bar) => bar.source === "offcut" || bar.source === "inventory",
    ) ||
    calculation?.result?.stockUsage.some(
      (usage) => usage.availableCount !== undefined || (usage.offcutCount ?? 0) > 0,
    ) ||
    calculation?.result?.inventoryShortage,
  );
}

export function isCurrentStandardCalculation(
  material: ProjectMaterial,
  calculation?: ProjectMaterialCalculation,
) {
  return Boolean(
    calculation?.result &&
    !hasLegacyInventoryConditions(material, calculation) &&
    calculation.inputKey === createCalculationInputKey(material),
  );
}

/** Preserve the stored result/estimate until the user explicitly recalculates. */
export function restoreStandardSnapshot(
  snapshot: ProjectSnapshot,
  catalog: RegisteredMaterial[],
  bank: OffcutBank = emptyOffcutBank(),
): ProjectSnapshot {
  const restored = restoreCompletedWork(snapshot, bank);
  const calculations = [...restored.calculation.materials];
  const materials = restored.materials.map((material) => {
    // Detach this opened draft from retired completion receipts immediately, so
    // later edits (including quote prices) cannot be overwritten on restart.
    // The old result/key stays stale until explicit recalculation.
    const linked: ProjectMaterial = {
      ...linkRegisteredMaterial(material, catalog),
      planningMode: "standard",
    };
    const index = calculations.findIndex((item) => item.materialId === material.id);
    if (index >= 0 && isCurrentStandardCalculation(material, calculations[index])) {
      calculations[index] = { ...calculations[index], inputKey: createCalculationInputKey(linked) };
    }
    return linked;
  });
  return { ...restored, materials, calculation: { materials: calculations } };
}

/** No storage access and no stock counts/offcuts passed to the optimizer. */
export function calculateStandardMaterial(original: ProjectMaterial) {
  const material: ProjectMaterial = { ...original, planningMode: "standard" };
  const kerf = Number(material.kerf);
  if (!material.kerf.trim() || !Number.isFinite(kerf) || kerf < 0)
    throw new Error("刃の厚みを正しく入力してください。");
  const lengths: number[] = [];
  for (const stock of material.stocks) {
    if (!stock.length.trim()) continue;
    const length = Number(stock.length);
    if (!Number.isFinite(length) || length <= 0)
      throw new Error("定尺材の長さは正の数で入力してください。");
    if (lengths.includes(length))
      throw new Error("同じ長さの定尺材が重複しています。1つの欄にまとめてください。");
    lengths.push(length);
  }
  if (!lengths.length) throw new Error("定尺材の長さを1つ以上入力してください。");
  const pieces: Piece[] = [];
  for (const piece of material.pieces) {
    const length = Number(piece.length);
    const qty = Number(piece.qty);
    if (!piece.length.trim() && !piece.qty.trim()) continue;
    if (!Number.isFinite(length) || length <= 0)
      throw new Error("部材の長さは正の数で入力してください。");
    if (!Number.isSafeInteger(qty) || qty <= 0)
      throw new Error("部材の本数は1以上の整数で入力してください。");
    pieces.push({ length, qty, label: piece.name.trim() || undefined });
  }
  if (!pieces.length) throw new Error("部材を1つ以上追加してください。");
  const calculation: ProjectMaterialCalculation = {
    materialId: material.id,
    inputKey: createCalculationInputKey(material),
    result: solveCuttingStock(lengths, kerf, pieces),
  };
  return { material, calculation };
}
