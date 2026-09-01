import { solveCuttingStock } from "./cutting-stock.ts";
import type { CutResult, Piece, StockOption } from "./cutting-stock.ts";

export interface SelectedOffcut {
  id: string;
  length: number;
  quantity: number;
}

/** Offcuts are a separate, finite first pass: their lengths NEVER become purchase candidates. */
export function solveWithOffcuts(
  stocks: StockOption[],
  kerf: number,
  pieces: Piece[],
  offcuts: SelectedOffcut[],
  purchaseShortage: boolean,
): CutResult {
  if (!offcuts.length) return solveCuttingStock(stocks, kerf, pieces, { purchaseShortage });
  const offcutPlan = solveCuttingStock(
    offcuts.map((entry) => ({ length: entry.length, availableCount: entry.quantity })),
    kerf,
    pieces,
  );
  const remaining = pieces.map((piece) => ({ ...piece }));
  const available = offcuts.map((entry) => ({ ...entry }));
  const offcutBars = offcutPlan.bars.map((bar) => {
    const entry = available.find((item) => item.length === bar.stockLength && item.quantity > 0)!;
    entry.quantity--;
    bar.pieces.forEach((piece) => remaining[piece.pieceIndex].qty--);
    return { ...bar, source: "offcut" as const, offcutId: entry.id };
  });
  const rest = solveCuttingStock(stocks, kerf, remaining, { purchaseShortage });
  const bars = [...offcutBars, ...rest.bars];
  const lengths = [...new Set(bars.map((bar) => bar.stockLength))].sort((a, b) => b - a);
  const totalStockLength = offcutPlan.totalStockLength + rest.totalStockLength;
  const totalRequiredLength = offcutPlan.totalRequiredLength + rest.totalRequiredLength;
  return {
    ...rest,
    bars,
    stockUsage: lengths.map((stockLength) => {
      const group = bars.filter((bar) => bar.stockLength === stockLength);
      return {
        stockLength,
        count: group.length,
        inventoryCount: group.filter((bar) => bar.source === "inventory").length,
        purchaseCount: group.filter((bar) => bar.source === "purchase").length,
        offcutCount: group.filter((bar) => bar.source === "offcut").length,
      };
    }),
    totalStock: bars.length,
    totalStockLength,
    totalRequiredLength,
    totalKerf: offcutPlan.totalKerf + rest.totalKerf,
    totalWaste: offcutPlan.totalWaste + rest.totalWaste,
    yieldRate: totalStockLength ? totalRequiredLength / totalStockLength : 0,
  };
}

/** The existing optimizer counts kerf BETWEEN pieces. Detaching a leftover costs one more kerf. */
export function getOffcutCandidates(result: CutResult, kerf: number) {
  const counts = new Map<number, number>();
  for (const bar of result.bars) {
    const length = Math.round(Math.max(0, bar.waste - kerf) * 1000) / 1000;
    if (length > 0) counts.set(length, (counts.get(length) ?? 0) + 1);
  }
  return [...counts].sort(([a], [b]) => b - a).map(([length, quantity]) => ({ length, quantity }));
}
