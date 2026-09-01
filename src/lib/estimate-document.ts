export interface EstimatePage {
  rowIndexes: number[];
  isFirst: boolean;
  isFinal: boolean;
}

export const localIsoDate = (now = new Date()) => {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

export const formatJapaneseDate = (value: string, fallback = new Date()) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match) {
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const date = new Date(year, month - 1, day);
    if (date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day) {
      return `${year}年${month}月${day}日`;
    }
  }

  return `${fallback.getFullYear()}年${fallback.getMonth() + 1}月${fallback.getDate()}日`;
};

export const paginateEstimateRows = (rowCount: number): EstimatePage[] => {
  const normalizedCount = Math.max(0, Math.floor(rowCount));
  const indexes = Array.from({ length: normalizedCount }, (_, index) => index);

  if (normalizedCount <= 9) {
    return [{ rowIndexes: indexes, isFirst: true, isFinal: true }];
  }

  const pages: EstimatePage[] = [];
  const firstCount = Math.min(14, Math.max(Math.ceil(normalizedCount / 2), normalizedCount - 8));
  pages.push({
    rowIndexes: indexes.splice(0, firstCount),
    isFirst: true,
    isFinal: false,
  });

  while (indexes.length > 8) {
    const count = Math.min(20, indexes.length - 8);
    pages.push({
      rowIndexes: indexes.splice(0, count),
      isFirst: false,
      isFinal: false,
    });
  }

  pages.push({
    rowIndexes: indexes,
    isFirst: false,
    isFinal: true,
  });

  return pages;
};
