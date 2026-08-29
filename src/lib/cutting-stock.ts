export interface Piece {
  length: number;
  qty: number;
  label?: string;
}

export interface PlacedPiece {
  length: number;
  pieceIndex: number;
  label?: string;
}

export interface Bar {
  stockLength: number;
  pieces: PlacedPiece[];
  used: number;
  waste: number;
}

export interface StockUsage {
  stockLength: number;
  count: number;
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
}

/**
 * Branch-and-bound search that mixes multiple stock sizes to minimize the
 * total length of stock used. Falls back to a greedy FFD pass if the search
 * exceeds an iteration budget (to keep response under a few seconds).
 */
function searchOptimal(
  uniqueStocks: number[],
  kerf: number,
  cuts: Cut[],
  iterationBudget = 200_000,
): { bars: WorkBar[]; completed: boolean } | null {
  const stocksDesc = [...uniqueStocks].sort((a, b) => b - a);
  const maxStock = stocksDesc[0];

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

  const cloneBars = (bars: WorkBar[]): WorkBar[] =>
    bars.map((b) => ({
      stockLength: b.stockLength,
      remaining: b.remaining,
      pieces: b.pieces.slice(),
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
      const minStock = stocksDesc[stocksDesc.length - 1];
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
    for (const s of stocksDesc) {
      if (s < piece.length) continue;
      if (totalStock + s >= best) continue;
      const newBar: WorkBar = {
        stockLength: s,
        remaining: s - piece.length,
        pieces: [
          {
            length: piece.length,
            pieceIndex: piece.pieceIndex,
            label: piece.label,
          },
        ],
      };
      bars.push(newBar);
      recurse(idx + 1, bars, totalStock + s);
      bars.pop();
      if (aborted) return;
    }
  };

  recurse(0, [], 0);

  if (bestBars) return { bars: bestBars, completed: !aborted };
  return null;
}

/** Greedy FFD fallback that also tries mixed stock strategies. */
function greedyFFD(
  uniqueStocks: number[],
  kerf: number,
  cuts: Cut[],
): { bars: WorkBar[]; unfittable: Cut[] } {
  const stocksAsc = [...uniqueStocks].sort((a, b) => a - b);
  const stocksDesc = [...uniqueStocks].sort((a, b) => b - a);
  const maxStock = stocksAsc[stocksAsc.length - 1];
  const sortedCuts = [...cuts].sort((a, b) => b.length - a.length);

  const strategies: ("smallest" | "largest")[] = ["smallest", "largest"];
  let bestBars: WorkBar[] | null = null;
  let bestUnfit: Cut[] = [];
  let bestTotal = Infinity;

  for (const strat of strategies) {
    const bars: WorkBar[] = [];
    const unfit: Cut[] = [];
    for (const c of sortedCuts) {
      if (c.length > maxStock) {
        unfit.push(c);
        continue;
      }
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
      const chosen = candidates.find((s) => s >= c.length)!;
      bars.push({
        stockLength: chosen,
        remaining: chosen - c.length,
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

export function solveCuttingStock(
  stockLengths: number[],
  kerf: number,
  pieces: Piece[],
): CutResult {
  const uniqueStocks = Array.from(new Set(stockLengths.filter((s) => s > 0)));
  const expanded: Cut[] = [];
  pieces.forEach((p, idx) => {
    for (let i = 0; i < p.qty; i++) {
      expanded.push({ length: p.length, pieceIndex: idx, label: p.label });
    }
  });

  let workBars: WorkBar[] = [];
  let unfittableCuts: Cut[] = [];

  if (uniqueStocks.length === 0 || expanded.length === 0) {
    workBars = [];
    unfittableCuts = expanded;
  } else {
    const maxStock = Math.max(...uniqueStocks);
    const fitCuts = expanded.filter((c) => c.length <= maxStock);
    unfittableCuts = expanded.filter((c) => c.length > maxStock);

    const optimal = searchOptimal(uniqueStocks, kerf, fitCuts);
    if (optimal && optimal.bars.length >= 0) {
      workBars = optimal.bars;
      // Also run greedy and keep whichever is better (safety net).
      const greedy = greedyFFD(uniqueStocks, kerf, fitCuts);
      const optTotal = workBars.reduce((s, b) => s + b.stockLength, 0);
      const grTotal = greedy.bars.reduce((s, b) => s + b.stockLength, 0);
      if (grTotal < optTotal) workBars = greedy.bars;
    } else {
      const greedy = greedyFFD(uniqueStocks, kerf, fitCuts);
      workBars = greedy.bars;
    }
  }

  const bars: Bar[] = workBars.map((b) => {
    const used = b.stockLength - b.remaining;
    return {
      stockLength: b.stockLength,
      pieces: b.pieces,
      used,
      waste: b.remaining,
    };
  });

  const usageMap = new Map<number, number>();
  bars.forEach((b) => usageMap.set(b.stockLength, (usageMap.get(b.stockLength) ?? 0) + 1));
  const stockUsage: StockUsage[] = Array.from(usageMap.entries())
    .map(([stockLength, count]) => ({ stockLength, count }))
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
