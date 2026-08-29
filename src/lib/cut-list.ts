import type { CutResult } from "./cutting-stock.ts";
import type { ProjectPieceInput } from "./project-storage.ts";

export interface CuttingOrderCut {
  sequence: number;
  orderInBar: number;
  length: number;
  label: string;
}

export interface CuttingOrderBar {
  barNumber: number;
  stockLength: number;
  used: number;
  waste: number;
  cuts: CuttingOrderCut[];
}

const validPieceInputs = (pieces: ProjectPieceInput[]) =>
  pieces.filter((piece) => {
    const length = Number(piece.length);
    const quantity = Number(piece.qty);
    return Number.isFinite(length) && length > 0 && Number.isInteger(quantity) && quantity > 0;
  });

export const buildCuttingOrder = (
  result: CutResult,
  pieces: ProjectPieceInput[],
): CuttingOrderBar[] => {
  const calculatedPieces = validPieceInputs(pieces);
  let sequence = 1;

  return result.bars.map((bar, barIndex) => ({
    barNumber: barIndex + 1,
    stockLength: bar.stockLength,
    used: bar.used,
    waste: bar.waste,
    cuts: [...bar.pieces]
      .sort((a, b) => b.length - a.length || a.pieceIndex - b.pieceIndex)
      .map((piece, cutIndex) => {
        const storedLabel = piece.label?.trim();
        const inputLabel = calculatedPieces[piece.pieceIndex]?.name.trim();
        return {
          sequence: sequence++,
          orderInBar: cutIndex + 1,
          length: piece.length,
          label: storedLabel || inputLabel || `部材${piece.pieceIndex + 1}`,
        };
      }),
  }));
};
