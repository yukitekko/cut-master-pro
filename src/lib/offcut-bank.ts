import { createCalculationInputKey, getMaterialStockMode } from "./project-storage.ts";
import { getOffcutCandidates } from "./offcut-planning.ts";
import type { SelectedOffcut } from "./offcut-planning.ts";
import {
  findRegisteredMaterial,
  legacyMaterialId,
  linkRegisteredMaterial,
  registerMaterial,
  validateMaterialCatalog,
  type RegisteredMaterial,
} from "./material-catalog.ts";
import type {
  ProjectMaterial,
  ProjectMaterialCalculation,
  ProjectQuoteRow,
  ProjectSnapshot,
} from "./project-storage.ts";

export const OFFCUT_BANK_KEY = "cut-master-pro:offcuts:v1";
export interface OffcutEntry {
  id: string;
  catalogId?: string;
  materialName: string;
  specification: string;
  length: number;
  quantity: number;
  location: string;
}
export interface CutCompletion {
  workId: string;
  completedAt: string;
  material: ProjectMaterial;
  calculation: ProjectMaterialCalculation;
  quoteRows?: ProjectQuoteRow[];
  inventoryChanges?: InventoryChange[];
}
export interface InventoryChange {
  id: string;
  source: "offcut" | "stock";
  length: number;
  location: string;
  before: number;
  used: number;
  added: number;
  after: number;
}
export interface OffcutBank {
  version: 1;
  catalog: RegisteredMaterial[];
  entries: OffcutEntry[];
  completions: CutCompletion[];
}
export const emptyOffcutBank = (): OffcutBank => ({
  version: 1,
  catalog: [],
  entries: [],
  completions: [],
});
const isCount = (value: number) => Number.isSafeInteger(value) && value >= 0;
const isLength = (value: number) => Number.isFinite(value) && value > 0;

export function readOffcutBank(storage: Pick<Storage, "getItem">): OffcutBank {
  const raw = storage.getItem(OFFCUT_BANK_KEY);
  if (!raw) return emptyOffcutBank();
  try {
    const bank = JSON.parse(raw) as OffcutBank;
    if (bank.version !== 1 || !Array.isArray(bank.entries) || !Array.isArray(bank.completions))
      throw new Error();
    // Additive migration: do not alter counts, entry IDs, or completion records.
    let catalog = bank.catalog === undefined ? [] : bank.catalog;
    validateMaterialCatalog(catalog);
    const ids = new Set<string>();
    for (const entry of bank.entries) {
      if (
        !entry ||
        typeof entry.id !== "string" ||
        !entry.id ||
        ids.has(entry.id) ||
        typeof entry.materialName !== "string" ||
        !entry.materialName.trim() ||
        typeof entry.specification !== "string" ||
        !entry.specification.trim() ||
        typeof entry.location !== "string" ||
        !isLength(entry.length) ||
        !isCount(entry.quantity)
      )
        throw new Error();
      ids.add(entry.id);
      if (
        entry.catalogId !== undefined &&
        (typeof entry.catalogId !== "string" || !entry.catalogId)
      )
        throw new Error();
      if (!entry.catalogId) {
        catalog = registerMaterial(catalog, {
          id: legacyMaterialId(entry.materialName, entry.specification),
          name: entry.materialName,
          specification: entry.specification,
        });
        entry.catalogId = findRegisteredMaterial(catalog, {
          name: entry.materialName,
          specification: entry.specification,
        })!.id;
      }
      const registered = catalog.find((item) => item.id === entry.catalogId);
      if (
        !registered ||
        registered.name !== entry.materialName.trim() ||
        registered.specification !== entry.specification.trim()
      )
        throw new Error();
    }
    const jobs = new Set<string>();
    for (const completion of bank.completions) {
      if (
        !completion ||
        typeof completion.workId !== "string" ||
        jobs.has(completion.workId) ||
        typeof completion.completedAt !== "string" ||
        !completion.material ||
        completion.material.workId !== completion.workId ||
        !Array.isArray(completion.material.stocks) ||
        !Array.isArray(completion.material.pieces) ||
        !completion.calculation?.result ||
        !Array.isArray(completion.calculation.result.bars) ||
        (completion.quoteRows !== undefined &&
          (!Array.isArray(completion.quoteRows) ||
            completion.quoteRows.some(
              (row) =>
                !row ||
                row.materialId !== completion.material.id ||
                !isLength(row.stockLength) ||
                typeof row.qty !== "string" ||
                typeof row.price !== "string" ||
                typeof row.materialName !== "string" ||
                typeof row.materialSpecification !== "string",
            ))) ||
        completion.calculation.materialId !== completion.material.id ||
        completion.calculation.inputKey !== createCalculationInputKey(completion.material)
      )
        throw new Error();
      jobs.add(completion.workId);
      if (
        completion.inventoryChanges !== undefined &&
        (!Array.isArray(completion.inventoryChanges) ||
          completion.inventoryChanges.some(
            (change) =>
              !change ||
              typeof change.id !== "string" ||
              !["offcut", "stock"].includes(change.source) ||
              !isLength(change.length) ||
              typeof change.location !== "string" ||
              ![change.before, change.used, change.added, change.after].every(isCount) ||
              change.used > change.before ||
              change.after !== change.before - change.used + change.added,
          ))
      )
        throw new Error();
    }
    return { ...bank, catalog };
  } catch {
    throw new Error(
      "端材バンクを読み込めません。保存データは変更していません。ブラウザのデータを削除せず、確認を依頼してください。",
    );
  }
}

export function matchesMaterial(
  entry: OffcutEntry,
  material: ProjectMaterial,
  catalog: RegisteredMaterial[],
) {
  const registered = findRegisteredMaterial(catalog, material);
  if (entry.catalogId || material.catalogId)
    return Boolean(registered && entry.catalogId === registered.id);
  return (
    entry.materialName === material.name.trim() &&
    entry.specification === material.specification.trim()
  );
}

export function selectOffcuts(bank: OffcutBank, material: ProjectMaterial): SelectedOffcut[] {
  const seen = new Set<string>();
  return (material.offcuts ?? []).map((selection) => {
    const entry = bank.entries.find((item) => item.id === selection.id);
    const quantity = Number(selection.quantity);
    if (
      !entry ||
      seen.has(selection.id) ||
      !matchesMaterial(entry, material, bank.catalog) ||
      selection.length !== entry.length ||
      !isCount(quantity) ||
      quantity === 0 ||
      quantity > entry.quantity
    ) {
      throw new Error(
        "選択した端材の材料・規格・在庫本数が変わっています。「端材バンク」で選び直して再計算してください。",
      );
    }
    seen.add(selection.id);
    return { id: entry.id, length: entry.length, quantity };
  });
}

export function registerOffcut(bank: OffcutBank, entry: OffcutEntry): OffcutBank {
  let catalog = bank.catalog;
  if (!entry.catalogId) {
    catalog = registerMaterial(catalog, {
      id: legacyMaterialId(entry.materialName, entry.specification),
      name: entry.materialName,
      specification: entry.specification,
    });
  }
  const registered = findRegisteredMaterial(catalog, {
    catalogId: entry.catalogId,
    name: entry.materialName,
    specification: entry.specification,
  });
  if (!registered) throw new Error("登録済みの材料・規格を選び直してください。");
  const normalized = {
    ...entry,
    catalogId: registered.id,
    materialName: registered.name,
    specification: registered.specification,
    location: entry.location.trim(),
  };
  if (!normalized.materialName || !normalized.specification)
    throw new Error("材料名と規格名を入力してください。違う材料との取り違えを防ぎます。");
  if (!isLength(entry.length) || !isCount(entry.quantity) || entry.quantity < 1)
    throw new Error("長さは正の数、本数は1以上の整数で入力してください。");
  const same = bank.entries.find(
    (item) =>
      (item.catalogId === normalized.catalogId ||
        (!item.catalogId &&
          item.materialName.trim() === normalized.materialName &&
          item.specification.trim() === normalized.specification)) &&
      item.length === normalized.length &&
      item.location === normalized.location,
  );
  if (same && !isCount(same.quantity + entry.quantity)) throw new Error("本数が大きすぎます。");
  if (!same && bank.entries.some((item) => item.id === entry.id))
    throw new Error("端材番号が重複しています。再度お試しください。");
  return {
    ...bank,
    catalog,
    entries: same
      ? bank.entries.map((item) =>
          item.id === same.id ? { ...item, quantity: item.quantity + entry.quantity } : item,
        )
      : [...bank.entries, normalized],
  };
}

export function adjustOffcut(bank: OffcutBank, id: string, quantity: number): OffcutBank {
  if (!isCount(quantity)) throw new Error("在庫本数は0以上の整数で入力してください。");
  if (!bank.entries.some((entry) => entry.id === id)) throw new Error("端材が見つかりません。");
  return {
    ...bank,
    entries: bank.entries.map((entry) => (entry.id === id ? { ...entry, quantity } : entry)),
  };
}

export const materialWorkId = (material: ProjectMaterial, projectId: string | null) =>
  material.workId ?? `legacy:${projectId ?? "draft"}:${material.id}`;

/** Completion records are authoritative even when an older saved project is reopened. */
export function restoreCompletedWork(snapshot: ProjectSnapshot, bank: OffcutBank): ProjectSnapshot {
  const calculations = [...snapshot.calculation.materials];
  let quoteRows = snapshot.estimate.rows;
  const materials = snapshot.materials.map((material) => {
    const workId = materialWorkId(material, snapshot.project.activeProjectId);
    const done =
      material.planningMode === "standard"
        ? undefined
        : bank.completions.find((item) => item.workId === workId);
    if (!done) {
      const linked = linkRegisteredMaterial({ ...material, workId }, bank.catalog);
      const index = calculations.findIndex((item) => item.materialId === material.id);
      // Change only the key representation of a previously CURRENT calculation.
      if (index >= 0 && calculations[index].inputKey === createCalculationInputKey(material)) {
        calculations[index] = {
          ...calculations[index],
          inputKey: createCalculationInputKey(linked),
        };
      }
      return linked;
    }
    if (done.quoteRows) {
      quoteRows = [...quoteRows.filter((row) => row.materialId !== material.id), ...done.quoteRows];
    }
    const index = calculations.findIndex((item) => item.materialId === material.id);
    if (index >= 0) calculations[index] = done.calculation;
    else calculations.push(done.calculation);
    return linkRegisteredMaterial(done.material, bank.catalog);
  });
  return {
    ...snapshot,
    materials,
    calculation: { materials: calculations },
    estimate: { ...snapshot.estimate, rows: quoteRows },
  };
}

export interface RetainedOffcut {
  candidateLength: number;
  length: number;
  quantity: number;
  location: string;
}

export function completeCutting(
  bank: OffcutBank,
  material: ProjectMaterial,
  calculation: ProjectMaterialCalculation,
  retained: RetainedOffcut[],
  createId: () => string,
  quoteRows?: ProjectQuoteRow[],
  now = new Date().toISOString(),
): OffcutBank {
  if (material.planningMode === "standard")
    throw new Error("定尺の必要本数を計算する方式では、在庫の更新は行いません。");
  if (!material.workId) throw new Error("作業番号がありません。案件を開き直してください。");
  if (bank.completions.some((item) => item.workId === material.workId))
    throw new Error("この材料の切断は完了済みです。二重に在庫を更新しません。");
  const result = calculation.result;
  if (
    !result ||
    result.bars.length === 0 ||
    calculation.materialId !== material.id ||
    calculation.inputKey !== createCalculationInputKey(material) ||
    result.unfittable.length ||
    result.inventoryShortage?.pieces.length
  ) {
    throw new Error("すべての部材を再計算してから切断完了にしてください。");
  }
  const selected = selectOffcuts(bank, material);
  const used = new Map<string, number>();
  for (const bar of result.bars) {
    if (bar.source !== "offcut") continue;
    const entry = selected.find(
      (item) => item.id === bar.offcutId && item.length === bar.stockLength,
    );
    if (!entry) throw new Error("計算時の端材と選択内容が一致しません。再計算してください。");
    used.set(entry.id, (used.get(entry.id) ?? 0) + 1);
    if (used.get(entry.id)! > entry.quantity)
      throw new Error("端材の使用本数が選択本数を超えています。");
  }
  let next: OffcutBank = {
    ...bank,
    entries: bank.entries.map((entry) => ({
      ...entry,
      quantity: entry.quantity - (used.get(entry.id) ?? 0),
    })),
  };
  const candidates = getOffcutCandidates(result, Number(material.kerf));
  const retainedCounts = new Map<number, number>();
  for (const item of retained) {
    const candidate = candidates.find((entry) => entry.length === item.candidateLength);
    const count = (retainedCounts.get(item.candidateLength) ?? 0) + item.quantity;
    if (
      !candidate ||
      !isLength(item.length) ||
      item.length > candidate.length ||
      !isCount(item.quantity) ||
      item.quantity < 1 ||
      count > candidate.quantity
    )
      throw new Error("残す端材の長さ・本数が計算結果を超えています。");
    retainedCounts.set(item.candidateLength, count);
    next = registerOffcut(next, {
      id: createId(),
      catalogId: material.catalogId,
      materialName: material.name,
      specification: material.specification,
      length: item.length,
      quantity: item.quantity,
      location: item.location,
    });
  }
  const remainingStocks = material.stocks.map((stock) => {
    if (getMaterialStockMode(material) !== "inventory") return { ...stock };
    const count = result.bars.filter(
      (bar) => bar.source === "inventory" && bar.stockLength === Number(stock.length),
    ).length;
    const remaining = Number(stock.quantity || "0") - count;
    if (!isCount(remaining))
      throw new Error("手持ち定尺の本数が不足しています。再計算してください。");
    return { ...stock, quantity: String(remaining) };
  });
  const completedMaterial = { ...material, stocks: remainingStocks, offcuts: [] };
  const inventoryChanges: InventoryChange[] = next.entries.flatMap((entry) => {
    const before = bank.entries.find((old) => old.id === entry.id)?.quantity ?? 0;
    const consumed = used.get(entry.id) ?? 0;
    const added = entry.quantity - before + consumed;
    return consumed || added
      ? [
          {
            id: entry.id,
            source: "offcut" as const,
            length: entry.length,
            location: entry.location,
            before,
            used: consumed,
            added,
            after: entry.quantity,
          },
        ]
      : [];
  });
  remainingStocks.forEach((stock, index) => {
    const before = Number(material.stocks[index].quantity || "0");
    const after = Number(stock.quantity || "0");
    if (getMaterialStockMode(material) === "inventory" && before !== after) {
      inventoryChanges.push({
        id: stock.id,
        source: "stock",
        length: Number(stock.length),
        location: "",
        before,
        used: before - after,
        added: 0,
        after,
      });
    }
  });
  return {
    ...next,
    completions: [
      ...next.completions,
      {
        workId: material.workId,
        completedAt: now,
        inventoryChanges,
        material: completedMaterial,
        calculation: { ...calculation, inputKey: createCalculationInputKey(completedMaterial) },
        ...(quoteRows
          ? { quoteRows: quoteRows.filter((row) => row.materialId === material.id) }
          : {}),
      },
    ],
  };
}

/** Run the exact completion rules without writing anything or consuming inventory. */
export function previewCuttingCompletion(
  bank: OffcutBank,
  material: ProjectMaterial,
  calculation: ProjectMaterialCalculation,
  retained: RetainedOffcut[],
) {
  let index = 0;
  const next = completeCutting(bank, material, calculation, retained, () => {
    let id: string;
    do {
      id = `preview-offcut-${++index}`;
    } while (bank.entries.some((item) => item.id === id));
    return id;
  });
  return next.completions.at(-1)!.inventoryChanges!;
}

/** One storage write commits both counts AND the duplicate-prevention receipt. */
export function updateOffcutBank(
  storage: Pick<Storage, "getItem" | "setItem">,
  update: (bank: OffcutBank) => OffcutBank,
) {
  const next = update(readOffcutBank(storage));
  storage.setItem(OFFCUT_BANK_KEY, JSON.stringify(next));
  return next;
}

/** No unlocked fallback: concurrent tabs must not overwrite one another's stock transactions. */
export async function withOffcutLock<T>(action: () => T): Promise<T> {
  if (!navigator.locks)
    throw new Error(
      "このブラウザでは在庫を安全に更新できません。ChromeまたはEdgeのlocalhost／HTTPSで開いてください。",
    );
  return navigator.locks.request(OFFCUT_BANK_KEY, action);
}
