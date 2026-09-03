import type { CutResult, StockSource } from "./cutting-stock.ts";
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
  source?: StockSource;
  cuts: CuttingOrderCut[];
}

export interface CompactCuttingOrderGroup {
  length: number;
  label: string;
  quantity: number;
}

export interface CompactCuttingOrderBar extends Omit<CuttingOrderBar, "cuts"> {
  groups: CompactCuttingOrderGroup[];
}

export interface PrintableCuttingOrderBar extends CompactCuttingOrderBar {
  printPartIndex: number;
  printPartCount: number;
}

const PRINT_COLUMNS = 4;
const FIRST_PRINT_PAGE_CARD_AREA_HEIGHT_MM = 150;
const CONTINUATION_PRINT_PAGE_CARD_AREA_HEIGHT_MM = 185;
const MAX_PRINT_CARD_HEIGHT_MM = 145;
const PRINT_CARD_HEADER_HEIGHT_MM = 6;
const PRINT_ROW_GAP_MM = 1.8;
const CHECKBOXES_PER_LINE = 6;
const LABEL_CHARACTERS_PER_LINE = 10;

const estimateGroupHeightMm = (group: CompactCuttingOrderGroup) => {
  const checkboxLines = Math.max(1, Math.ceil(group.quantity / CHECKBOXES_PER_LINE));
  const labelLines = Math.max(
    1,
    Math.ceil(Array.from(group.label.trim()).length / LABEL_CHARACTERS_PER_LINE),
  );
  return Math.max(5.5, 1.2 + Math.max(checkboxLines, labelLines) * 3.45);
};

const estimateCardHeightMm = (bar: CompactCuttingOrderBar) =>
  PRINT_CARD_HEADER_HEIGHT_MM +
  bar.groups.reduce((total, group) => total + estimateGroupHeightMm(group), 0);

const splitGroupQuantityForPrint = (
  group: CompactCuttingOrderGroup,
): CompactCuttingOrderGroup[] => {
  const cardBodyHeightMm = MAX_PRINT_CARD_HEIGHT_MM - PRINT_CARD_HEADER_HEIGHT_MM;
  const maxCheckboxLines = Math.max(1, Math.floor((cardBodyHeightMm - 1.2) / 3.45));
  const maxQuantity = maxCheckboxLines * CHECKBOXES_PER_LINE;

  if (group.quantity <= maxQuantity) return [group];

  const parts: CompactCuttingOrderGroup[] = [];
  for (let remaining = group.quantity; remaining > 0; remaining -= maxQuantity) {
    parts.push({ ...group, quantity: Math.min(remaining, maxQuantity) });
  }
  return parts;
};

const splitBarForPrint = (bar: CompactCuttingOrderBar): PrintableCuttingOrderBar[] => {
  const cardBodyHeightMm = MAX_PRINT_CARD_HEIGHT_MM - PRINT_CARD_HEADER_HEIGHT_MM;
  const groupChunks: CompactCuttingOrderGroup[][] = [];
  let currentChunk: CompactCuttingOrderGroup[] = [];
  let currentHeightMm = 0;

  for (const group of bar.groups.flatMap(splitGroupQuantityForPrint)) {
    const groupHeightMm = estimateGroupHeightMm(group);
    if (currentChunk.length > 0 && currentHeightMm + groupHeightMm > cardBodyHeightMm) {
      groupChunks.push(currentChunk);
      currentChunk = [];
      currentHeightMm = 0;
    }

    currentChunk.push(group);
    currentHeightMm += groupHeightMm;
  }

  if (currentChunk.length > 0 || groupChunks.length === 0) groupChunks.push(currentChunk);

  return groupChunks.map((groups, index) => ({
    ...bar,
    groups,
    printPartIndex: index + 1,
    printPartCount: groupChunks.length,
  }));
};

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
    ...(bar.source ? { source: bar.source } : {}),
    cuts: [...bar.pieces]
      .sort((a, b) => b.length - a.length || a.pieceIndex - b.pieceIndex)
      .map((piece, cutIndex) => {
        const storedLabel = piece.label?.trim();
        const inputLabel = calculatedPieces[piece.pieceIndex]?.name.trim();
        return {
          sequence: sequence++,
          orderInBar: cutIndex + 1,
          length: piece.length,
          label: storedLabel || inputLabel || "",
        };
      }),
  }));
};

export const buildCompactCuttingOrder = (
  result: CutResult,
  pieces: ProjectPieceInput[],
): CompactCuttingOrderBar[] =>
  buildCuttingOrder(result, pieces).map(({ cuts, ...bar }) => {
    const groups: CompactCuttingOrderGroup[] = [];

    cuts.forEach((cut) => {
      const existing = groups.find(
        (group) => group.length === cut.length && group.label === cut.label,
      );

      if (existing) {
        existing.quantity += 1;
        return;
      }

      groups.push({
        length: cut.length,
        label: cut.label,
        quantity: 1,
      });
    });

    return { ...bar, groups };
  });

/**
 * CSS grid rows can be split by browser printing even when each card requests
 * break-inside: avoid. Build explicit page-sized grids so a card row never
 * straddles an A4 landscape page.
 */
export const paginateCompactCuttingOrder = (
  bars: CompactCuttingOrderBar[],
): PrintableCuttingOrderBar[][] => {
  if (bars.length === 0) return [[]];

  const printableBars = bars.flatMap(splitBarForPrint);
  const pages: PrintableCuttingOrderBar[][] = [];
  let currentPage: PrintableCuttingOrderBar[] = [];
  let currentHeightMm = 0;

  for (let start = 0; start < printableBars.length; start += PRINT_COLUMNS) {
    const row = printableBars.slice(start, start + PRINT_COLUMNS);
    const rowHeightMm = Math.max(...row.map(estimateCardHeightMm));
    const requiredHeightMm = rowHeightMm + (currentPage.length > 0 ? PRINT_ROW_GAP_MM : 0);
    const pageHeightLimitMm =
      pages.length === 0
        ? FIRST_PRINT_PAGE_CARD_AREA_HEIGHT_MM
        : CONTINUATION_PRINT_PAGE_CARD_AREA_HEIGHT_MM;

    if (currentPage.length > 0 && currentHeightMm + requiredHeightMm > pageHeightLimitMm) {
      pages.push(currentPage);
      currentPage = [];
      currentHeightMm = 0;
    }

    currentPage.push(...row);
    currentHeightMm += rowHeightMm + (currentHeightMm > 0 ? PRINT_ROW_GAP_MM : 0);
  }

  if (currentPage.length > 0) pages.push(currentPage);
  return pages;
};
