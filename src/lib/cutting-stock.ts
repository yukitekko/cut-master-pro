export interface Piece {
  length: number;
  qty: number;
  label?: string;
}

export interface StockOption {
  length: number;
  /** null / undefined means that this stock length has no quantity limit. */
  availableCount?: number | null;
}

export interface PlacedPiece {
  length: number;
  pieceIndex: number;
  label?: string;
}

export type StockSource = "inventory" | "purchase";

export interface Bar {
  stockLength: number;
  pieces: PlacedPiece[];
  used: number;
  waste: number;
  source?: StockSource;
}

export interface StockUsage {
  stockLength: number;
  count: number;
  availableCount?: number;
  inventoryCount?: number;
  purchaseCount?: number;
}

export interface InventoryShortage {
  pieces: { length: number; qty: number; label?: string }[];
  suggestedStock: StockUsage[];
}

export interface CutResult {
  bars: Bar[];
  stockUsage: StockUsage[];
  totalStock: number;
  totalRequiredLength: number;
  totalStockLength: number;
  totalKerf: number;
  totalWaste: number;
  yieldRate: number;
  unfittable: { length: number; qty: number }[];
  /** Optional so calculation results saved before inventory limits remain readable. */
  inventoryShortage?: InventoryShortage | null;
}

export interface SolveCuttingStockOptions {
  /** Complete an inventory-limited plan by treating missing bars as purchases. */
  purchaseShortage?: boolean;
}

interface Cut {
  length: number;
  pieceIndex: number;
  label?: string;
}

interface WorkBar {
  stockLength: number;
  remaining: number;
  pieces: PlacedPiece[];
  source: StockSource;
}

interface NormalizedStock {
  length: number;
  availableCount: number | null;
}

const normalizeStocks = (stocks: number[] | StockOption[]): NormalizedStock[] => {
  const merged = new Map<number, number | null>();

  for (const stock of stocks) {
    const length = typeof stock === "number" ? stock : stock.length;
    if (!Number.isFinite(length) || length <= 0) continue;
    const rawCount = typeof stock === "number" ? null : stock.availableCount;
    const availableCount =
      rawCount === null || rawCount === undefined
        ? null
        : Math.max(0, Math.floor(Number.isFinite(rawCount) ? rawCount : 0));
    const previous = merged.get(length);

    if (previous === undefined) {
      merged.set(length, availableCount);
    } else if (previous === null || availableCount === null) {
      merged.set(length, null);
    } else {
      merged.set(length, previous + availableCount);
    }
  }

  return Array.from(merged.entries()).map(([length, availableCount]) => ({
    length,
    availableCount,
  }));
};

/**
 * Branch-and-bound search that mixes multiple stock sizes to minimize the
 * total length of stock used. Falls back to a greedy FFD pass if the search
 * exceeds an iteration budget (to keep response under a few seconds).
 */
function searchOptimal(
  stocks: NormalizedStock[],
  kerf: number,
  cuts: Cut[],
  iterationBudget = 200_000,
): { bars: WorkBar[]; completed: boolean } | null {
  const stocksDesc = [...stocks].sort((a, b) => b.length - a.length);
  if (stocksDesc.length === 0) return null;
  const maxStock = stocksDesc[0]!.length;

  const sortedCuts = [...cuts].sort((a, b) => b.length - a.length);
  if (sortedCuts.some((c) => c.length > maxStock)) return null;

  // Lower bound for remaining pieces: sum of (length + kerf) minus one kerf.
  // Conservative: sum of lengths only (kerf only paid if combined in a bar).
  const suffixSum: number[] = new Array(sortedCuts.length + 1).fill(0);
  for (let i = sortedCuts.length - 1; i >= 0; i--) {
    suffixSum[i] = suffixSum[i + 1] + sortedCuts[i].length;
  }

  let best = Infinity;
  let bestBars: WorkBar[] | null = null;
  let iter = 0;
  let aborted = false;
  const openedCounts = new Map<number, number>();

  const cloneBars = (bars: WorkBar[]): WorkBar[] =>
    bars.map((b) => ({
      stockLength: b.stockLength,
      remaining: b.remaining,
      pieces: b.pieces.slice(),
      source: b.source,
    }));

  const recurse = (idx: number, bars: WorkBar[], totalStock: number): void => {
    if (aborted) return;
    if (++iter > iterationBudget) {
      aborted = true;
      return;
    }
    if (totalStock >= best) return;
    if (idx === sortedCuts.length) {
      best = totalStock;
      bestBars = cloneBars(bars);
      return;
    }
    // Lower bound: even if all remaining pieces fit perfectly into open bars
    // free capacity, we still need at least ceil((needed - freeCap)/maxStock) * minStock more.
    // Simpler bound: totalStock + remainingNeed must "fit" — skip if obviously hopeless.
    const need = suffixSum[idx];
    const freeCap = bars.reduce((s, b) => s + b.remaining, 0);
    if (need > freeCap) {
      const deficit = need - freeCap;
      const minStock = stocksDesc[stocksDesc.length - 1]!.length;
      const extraMin = Math.ceil(deficit / maxStock) * minStock;
      if (totalStock + extraMin >= best) return;
    }

    const piece = sortedCuts[idx];

    // Try placing into existing bars (dedupe identical states).
    const seen = new Set<string>();
    for (const bar of bars) {
      const add = bar.pieces.length > 0 ? kerf + piece.length : piece.length;
      if (bar.remaining >= add) {
        const key = `${bar.stockLength}:${bar.remaining}`;
        if (seen.has(key)) continue;
        seen.add(key);
        bar.remaining -= add;
        bar.pieces.push({
          length: piece.length,
          pieceIndex: piece.pieceIndex,
          label: piece.label,
        });
        recurse(idx + 1, bars, totalStock);
        bar.pieces.pop();
        bar.remaining += add;
        if (aborted) return;
      }
    }

    // Try opening a new bar of each viable stock size.
    for (const stock of stocksDesc) {
      const s = stock.length;
      if (s < piece.length) continue;
      const openedCount = openedCounts.get(s) ?? 0;
      if (stock.availableCount !== null && openedCount >= stock.availableCount) continue;
      if (totalStock + s >= best) continue;
      const newBar: WorkBar = {
        stockLength: s,
        remaining: s - piece.length,
        source: stock.availableCount === null ? "purchase" : "inventory",
        pieces: [
          {
            length: piece.length,
            pieceIndex: piece.pieceIndex,
            label: piece.label,
          },
        ],
      };
      openedCounts.set(s, openedCount + 1);
      bars.push(newBar);
      recurse(idx + 1, bars, totalStock + s);
      bars.pop();
      if (openedCount === 0) openedCounts.delete(s);
      else openedCounts.set(s, openedCount);
      if (aborted) return;
    }
  };

  recurse(0, [], 0);

  if (bestBars) return { bars: bestBars, completed: !aborted };
  return null;
}

/** Greedy FFD fallback that also tries mixed stock strategies. */
function greedyFFD(
  stocks: NormalizedStock[],
  kerf: number,
  cuts: Cut[],
): { bars: WorkBar[]; unfittable: Cut[] } {
  const stocksAsc = [...stocks].sort((a, b) => a.length - b.length);
  const stocksDesc = [...stocks].sort((a, b) => b.length - a.length);
  const sortedCuts = [...cuts].sort((a, b) => b.length - a.length);

  const strategies: ("smallest" | "largest")[] = ["smallest", "largest"];
  let bestBars: WorkBar[] | null = null;
  let bestUnfit: Cut[] = [];
  let bestTotal = Infinity;

  for (const strat of strategies) {
    const bars: WorkBar[] = [];
    const unfit: Cut[] = [];
    const openedCounts = new Map<number, number>();
    for (const c of sortedCuts) {
      let placed = false;
      for (const bar of bars) {
        const add = bar.pieces.length > 0 ? kerf + c.length : c.length;
        if (bar.remaining >= add) {
          bar.remaining -= add;
          bar.pieces.push({ length: c.length, pieceIndex: c.pieceIndex, label: c.label });
          placed = true;
          break;
        }
      }
      if (placed) continue;
      const candidates = strat === "smallest" ? stocksAsc : stocksDesc;
      const chosen = candidates.find((stock) => {
        if (stock.length < c.length) return false;
        const openedCount = openedCounts.get(stock.length) ?? 0;
        return stock.availableCount === null || openedCount < stock.availableCount;
      });
      if (!chosen) {
        unfit.push(c);
        continue;
      }
      const openedCount = openedCounts.get(chosen.length) ?? 0;
      openedCounts.set(chosen.length, openedCount + 1);
      bars.push({
        stockLength: chosen.length,
        remaining: chosen.length - c.length,
        source: chosen.availableCount === null ? "purchase" : "inventory",
        pieces: [{ length: c.length, pieceIndex: c.pieceIndex, label: c.label }],
      });
    }
    const total = bars.reduce((s, b) => s + b.stockLength, 0);
    if (
      !bestBars ||
      unfit.length < bestUnfit.length ||
      (unfit.length === bestUnfit.length && total < bestTotal)
    ) {
      bestBars = bars;
      bestUnfit = unfit;
      bestTotal = total;
    }
  }
  return { bars: bestBars!, unfittable: bestUnfit };
}

const chooseCompletePlan = (
  stocks: NormalizedStock[],
  kerf: number,
  cuts: Cut[],
): { bars: WorkBar[]; unfittable: Cut[] } => {
  if (cuts.length === 0) return { bars: [], unfittable: [] };

  const hasUnlimitedStock = stocks.some((stock) => stock.availableCount === null);
  const availableLength = stocks.reduce(
    (sum, stock) =>
      stock.availableCount === null ? sum : sum + stock.length * stock.availableCount,
    0,
  );
  const requiredLength = cuts.reduce((sum, cut) => sum + cut.length, 0);
  const canFitByRawLength = hasUnlimitedStock || availableLength >= requiredLength;
  const optimal = canFitByRawLength ? searchOptimal(stocks, kerf, cuts) : null;
  const greedy = greedyFFD(stocks, kerf, cuts);

  if (!optimal) return greedy;
  if (greedy.unfittable.length > 0) return { bars: optimal.bars, unfittable: [] };
  const optimalTotal = optimal.bars.reduce((sum, bar) => sum + bar.stockLength, 0);
  const greedyTotal = greedy.bars.reduce((sum, bar) => sum + bar.stockLength, 0);
  return greedyTotal < optimalTotal ? greedy : { bars: optimal.bars, unfittable: [] };
};

const summarizeCuts = (cuts: Cut[]) => {
  const grouped = new Map<string, { length: number; qty: number; label?: string }>();
  for (const cut of cuts) {
    const key = `${cut.length}\u0000${cut.label ?? ""}`;
    const previous = grouped.get(key);
    if (previous) previous.qty += 1;
    else {
      grouped.set(key, {
        length: cut.length,
        qty: 1,
        ...(cut.label ? { label: cut.label } : {}),
      });
    }
  }
  return Array.from(grouped.values()).sort((a, b) => b.length - a.length);
};

export function solveCuttingStock(
  stockLengths: number[] | StockOption[],
  kerf: number,
  pieces: Piece[],
  options: SolveCuttingStockOptions = {},
): CutResult {
  const stocks = normalizeStocks(stockLengths);
  const expanded: Cut[] = [];
  pieces.forEach((p, idx) => {
    for (let i = 0; i < p.qty; i++) {
      expanded.push({ length: p.length, pieceIndex: idx, label: p.label });
    }
  });

  let workBars: WorkBar[] = [];
  let unfittableCuts: Cut[] = [];
  let inventoryShortageCuts: Cut[] = [];

  if (stocks.length === 0 || expanded.length === 0) {
    workBars = [];
    unfittableCuts = expanded;
  } else {
    const maxStock = Math.max(...stocks.map((stock) => stock.length));
    const fitCuts = expanded.filter((c) => c.length <= maxStock);
    unfittableCuts = expanded.filter((c) => c.length > maxStock);
    const plan = chooseCompletePlan(stocks, kerf, fitCuts);
    workBars = plan.bars;
    inventoryShortageCuts = plan.unfittable;
  }

  const shortagePlan =
    inventoryShortageCuts.length > 0
      ? chooseCompletePlan(
          stocks.map((stock) => ({ ...stock, availableCount: null })),
          kerf,
          inventoryShortageCuts,
        )
      : { bars: [], unfittable: [] };
  const suggestedStockMap = new Map<number, number>();
  shortagePlan.bars.forEach((bar) =>
    suggestedStockMap.set(bar.stockLength, (suggestedStockMap.get(bar.stockLength) ?? 0) + 1),
  );
  const suggestedStock = Array.from(suggestedStockMap.entries())
    .map(([stockLength, count]) => ({ stockLength, count }))
    .sort((a, b) => b.stockLength - a.stockLength);

  if (options.purchaseShortage && shortagePlan.bars.length > 0) {
    workBars = [...workBars, ...shortagePlan.bars];
    inventoryShortageCuts = shortagePlan.unfittable;
  }

  const bars: Bar[] = workBars.map((b) => {
    const used = b.stockLength - b.remaining;
    return {
      stockLength: b.stockLength,
      pieces: b.pieces,
      used,
      waste: b.remaining,
      source: b.source,
    };
  });

  const includeSourceCounts =
    options.purchaseShortage && stocks.some((stock) => stock.availableCount !== null);
  const usageMap = new Map<
    number,
    { count: number; inventoryCount: number; purchaseCount: number }
  >();
  bars.forEach((bar) => {
    const usage = usageMap.get(bar.stockLength) ?? {
      count: 0,
      inventoryCount: 0,
      purchaseCount: 0,
    };
    usage.count += 1;
    if (bar.source === "inventory") usage.inventoryCount += 1;
    else usage.purchaseCount += 1;
    usageMap.set(bar.stockLength, usage);
  });
  const stockUsage: StockUsage[] = Array.from(usageMap.entries())
    .map(([stockLength, usage]) => {
      const availableCount = stocks.find((stock) => stock.length === stockLength)?.availableCount;
      return {
        stockLength,
        count: usage.count,
        ...(availableCount === null || availableCount === undefined ? {} : { availableCount }),
        ...(includeSourceCounts
          ? {
              inventoryCount: usage.inventoryCount,
              purchaseCount: usage.purchaseCount,
            }
          : {}),
      };
    })
    .sort((a, b) => b.stockLength - a.stockLength);

  const totalStock = bars.length;
  const totalStockLength = bars.reduce((s, b) => s + b.stockLength, 0);
  const totalRequiredLength = bars.reduce(
    (s, b) => s + b.pieces.reduce((ss, p) => ss + p.length, 0),
    0,
  );
  const totalKerf = bars.reduce((s, b) => s + Math.max(0, b.pieces.length - 1) * kerf, 0);
  const totalWaste = totalStockLength - totalRequiredLength - totalKerf;
  const yieldRate = totalStockLength > 0 ? totalRequiredLength / totalStockLength : 0;

  const unfitMap = new Map<number, number>();
  unfittableCuts.forEach((u) => unfitMap.set(u.length, (unfitMap.get(u.length) ?? 0) + 1));

  return {
    bars,
    stockUsage,
    totalStock,
    totalRequiredLength,
    totalStockLength,
    totalKerf,
    totalWaste,
    yieldRate,
    unfittable: Array.from(unfitMap.entries()).map(([length, qty]) => ({ length, qty })),
    inventoryShortage:
      inventoryShortageCuts.length > 0
        ? { pieces: summarizeCuts(inventoryShortageCuts), suggestedStock }
        : null,
  };
}

export const PIECE_COLORS = [
  "#f97316",
  "#22d3ee",
  "#a3e635",
  "#f472b6",
  "#facc15",
  "#60a5fa",
  "#c084fc",
  "#34d399",
  "#fb7185",
  "#fbbf24",
];

export function colorFor(index: number): string {
  return PIECE_COLORS[index % PIECE_COLORS.length];
}
