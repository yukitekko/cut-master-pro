import type { ProjectMaterial } from "./project-storage.ts";

export const CSV_TEMPLATE_TEXT = [
  "案件名,材料番号,材料名,規格名,定尺材長(mm),刃厚(mm),部材名,部材長(mm),本数",
  "○○邸 手すり工事,M001,ステンレス角パイプ,SUS304 40×40×2.0,5000,4,横桟,1200,4",
  "○○邸 手すり工事,M001,ステンレス角パイプ,SUS304 40×40×2.0,5000,4,縦桟,800,6",
  "○○邸 手すり工事,M002,アルミ角パイプ,A6063 30×30×2.0,4000,3,枠材,950,8",
].join("\r\n");

export interface MaterialImportData {
  projectName: string;
  materials: ProjectMaterial[];
  sourceRowCount: number;
}

export type MaterialImportResult =
  { ok: true; data: MaterialImportData } | { ok: false; errors: string[] };

export type SpreadsheetCell = unknown;

interface CsvRow {
  cells: string[];
  line: number;
}

interface MaterialBuilder {
  id: string;
  name: string;
  specification: string;
  kerf: string | null;
  stocks: Map<string, string>;
  pieces: ProjectMaterial["pieces"];
}

const createId = (prefix: string) =>
  `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

const normalizeHeader = (value: string) =>
  value
    .replace(/^\uFEFF/, "")
    .trim()
    .toLowerCase()
    .replace(/[\s\u3000_／/・]/g, "")
    .replace(/[（）]/g, (character) => (character === "（" ? "(" : ")"));

const HEADER_ALIASES = {
  projectName: ["案件名", "projectname"],
  materialGroup: ["材料番号", "材料id", "materialid", "materialnumber"],
  materialName: ["材料名", "materialname"],
  specification: ["規格名", "規格", "specification", "spec"],
  stockLength: [
    "定尺材長(mm)",
    "定尺材の長さ(mm)",
    "定尺長(mm)",
    "定尺(mm)",
    "stocklength(mm)",
    "stocklength",
  ],
  kerf: ["刃厚(mm)", "刃の厚み(mm)", "アサリ幅(mm)", "kerf(mm)", "kerf"],
  pieceName: ["部材名", "パイプ番号・部材名", "パイプ番号", "メモ", "partname", "piecename"],
  pieceLength: [
    "部材長(mm)",
    "部材の長さ(mm)",
    "切断寸法(mm)",
    "寸法(mm)",
    "partlength(mm)",
    "piecelength(mm)",
    "partlength",
  ],
  quantity: ["本数", "数量", "quantity", "qty"],
} as const;

type HeaderKey = keyof typeof HEADER_ALIASES;

const normalizedAliases = Object.fromEntries(
  Object.entries(HEADER_ALIASES).map(([key, aliases]) => [
    key,
    new Set(aliases.map(normalizeHeader)),
  ]),
) as Record<HeaderKey, Set<string>>;

const findHeaderIndex = (headers: string[], key: HeaderKey) =>
  headers.findIndex((header) => normalizedAliases[key].has(normalizeHeader(header)));

const normalizeDigits = (value: string) =>
  value.replace(/[０-９]/g, (character) => String.fromCharCode(character.charCodeAt(0) - 0xfee0));

const parseNumber = (value: string) => {
  const normalized = normalizeDigits(value).replace(/[,，]/g, "").trim();
  if (!normalized) return null;
  const number = Number(normalized);
  return Number.isFinite(number) ? number : null;
};

const parseCsvRows = (text: string): CsvRow[] | string => {
  const rows: CsvRow[] = [];
  let cells: string[] = [];
  let cell = "";
  let inQuotes = false;
  let line = 1;
  let rowStartLine = 1;

  const pushRow = () => {
    cells.push(cell);
    rows.push({ cells, line: rowStartLine });
    cells = [];
    cell = "";
    rowStartLine = line;
  };

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (inQuotes) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cell += character;
        if (character === "\n") line += 1;
      }
      continue;
    }

    if (character === '"' && cell.length === 0) {
      inQuotes = true;
    } else if (character === ",") {
      cells.push(cell);
      cell = "";
    } else if (character === "\n") {
      line += 1;
      pushRow();
      rowStartLine = line;
    } else if (character !== "\r") {
      cell += character;
    }
  }

  if (inQuotes) return `${rowStartLine}行目: 引用符（"）が閉じられていません。`;
  if (cell.length > 0 || cells.length > 0) pushRow();
  return rows.filter((row) => row.cells.some((value) => value.trim() !== ""));
};

export const decodeCsvBytes = (buffer: ArrayBuffer): string => {
  const bytes = new Uint8Array(buffer);
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder("utf-8").decode(bytes.subarray(3));
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("shift_jis").decode(bytes);
  }
};

const parseMaterialRows = (parsedRows: CsvRow[]): MaterialImportResult => {
  if (parsedRows.length < 2) {
    return { ok: false, errors: ["見出し行と、1行以上のデータが必要です。"] };
  }

  const [headerRow, ...dataRows] = parsedRows;
  const indexes = Object.fromEntries(
    (Object.keys(HEADER_ALIASES) as HeaderKey[]).map((key) => [
      key,
      findHeaderIndex(headerRow!.cells, key),
    ]),
  ) as Record<HeaderKey, number>;
  const requiredHeaders: Array<[HeaderKey, string]> = [
    ["materialName", "材料名"],
    ["stockLength", "定尺材長(mm)"],
    ["pieceLength", "部材長(mm)"],
    ["quantity", "本数"],
  ];
  const missingHeaders = requiredHeaders
    .filter(([key]) => indexes[key] < 0)
    .map(([, label]) => label);
  if (missingHeaders.length > 0) {
    return {
      ok: false,
      errors: [`必要な列がありません: ${missingHeaders.join("、")}`],
    };
  }

  const getCell = (row: CsvRow, key: HeaderKey) =>
    indexes[key] < 0 ? "" : (row.cells[indexes[key]] ?? "").trim();
  const errors: string[] = [];
  const builders = new Map<string, MaterialBuilder>();
  let projectName = "";

  for (const row of dataRows) {
    const rowProjectName = getCell(row, "projectName");
    const materialGroup = getCell(row, "materialGroup");
    const materialName = getCell(row, "materialName");
    const specification = getCell(row, "specification");
    const stockLengthValue = getCell(row, "stockLength");
    const kerfValue = getCell(row, "kerf");
    const pieceName = getCell(row, "pieceName");
    const pieceLengthValue = getCell(row, "pieceLength");
    const quantityValue = getCell(row, "quantity");

    if (rowProjectName) {
      if (projectName && projectName !== rowProjectName) {
        errors.push(`${row.line}行目: 案件名が他の行と一致していません。`);
      } else {
        projectName = rowProjectName;
      }
    }
    if (!materialName) errors.push(`${row.line}行目: 材料名を入力してください。`);

    const stockLength = parseNumber(stockLengthValue);
    if (stockLength === null || stockLength <= 0) {
      errors.push(`${row.line}行目: 定尺材長は0より大きい数で入力してください。`);
    }
    const pieceLength = parseNumber(pieceLengthValue);
    if (pieceLength === null || pieceLength <= 0) {
      errors.push(`${row.line}行目: 部材長は0より大きい数で入力してください。`);
    }
    const quantity = parseNumber(quantityValue);
    if (quantity === null || !Number.isInteger(quantity) || quantity <= 0) {
      errors.push(`${row.line}行目: 本数は1以上の整数で入力してください。`);
    }
    const kerf = kerfValue ? parseNumber(kerfValue) : 4;
    if (kerf === null || kerf < 0) {
      errors.push(`${row.line}行目: 刃厚は0以上の数で入力してください。`);
    }
    if (
      !materialName ||
      stockLength === null ||
      stockLength <= 0 ||
      pieceLength === null ||
      pieceLength <= 0 ||
      quantity === null ||
      !Number.isInteger(quantity) ||
      quantity <= 0 ||
      kerf === null ||
      kerf < 0
    ) {
      continue;
    }

    const groupKey = materialGroup || `${materialName}\u0000${specification}`;
    const existing = builders.get(groupKey);
    if (existing && (existing.name !== materialName || existing.specification !== specification)) {
      errors.push(
        `${row.line}行目: 材料番号「${materialGroup}」の材料名または規格名が他の行と一致していません。`,
      );
      continue;
    }
    if (existing && existing.kerf !== null && existing.kerf !== String(kerf)) {
      errors.push(`${row.line}行目: 同じ材料の刃厚が他の行と一致していません。`);
      continue;
    }

    const builder =
      existing ??
      ({
        id: createId("material"),
        name: materialName,
        specification,
        kerf: null,
        stocks: new Map<string, string>(),
        pieces: [],
      } satisfies MaterialBuilder);
    builder.kerf = String(kerf);
    builder.stocks.set(String(stockLength), String(stockLength));
    builder.pieces.push({
      id: createId("piece"),
      name: pieceName,
      length: String(pieceLength),
      qty: String(quantity),
    });
    builders.set(groupKey, builder);
  }

  if (errors.length > 0) return { ok: false, errors };
  if (builders.size === 0) {
    return { ok: false, errors: ["取り込めるデータ行がありません。"] };
  }

  const materials = Array.from(builders.values()).map<ProjectMaterial>((builder) => ({
    id: builder.id,
    name: builder.name,
    specification: builder.specification,
    kerf: builder.kerf ?? "4",
    stocks: Array.from(builder.stocks.values()).map((length) => ({
      id: createId("stock"),
      length,
    })),
    pieces: builder.pieces,
  }));

  return {
    ok: true,
    data: { projectName, materials, sourceRowCount: dataRows.length },
  };
};

export const parseMaterialsRows = (rows: SpreadsheetCell[][]): MaterialImportResult =>
  parseMaterialRows(
    rows
      .map((cells, index) => ({
        line: index + 1,
        cells: cells.map((cell) => {
          if (cell === null || cell === undefined) return "";
          if (cell instanceof Date) return cell.toISOString();
          return String(cell);
        }),
      }))
      .filter((row) => row.cells.some((cell) => cell.trim() !== "")),
  );

export const parseMaterialsCsv = (text: string): MaterialImportResult => {
  const parsedRows = parseCsvRows(text);
  if (typeof parsedRows === "string") return { ok: false, errors: [parsedRows] };
  return parseMaterialRows(parsedRows);
};
