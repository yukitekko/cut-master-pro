import { createFileRoute } from "@tanstack/react-router";
import {
  type ChangeEvent,
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { solveCuttingStock, colorFor, type CutResult, type Piece } from "@/lib/cutting-stock";
import { buildCuttingOrder } from "@/lib/cut-list";
import {
  CSV_TEMPLATE_TEXT,
  decodeCsvBytes,
  parseMaterialsCsv,
  parseMaterialsRows,
  type MaterialImportData,
  type MaterialImportResult,
} from "@/lib/csv-import";
import {
  PROJECT_STORAGE_VERSION,
  createCalculationInputKey,
  readDraft,
  readProjects,
  removeProject,
  saveProject,
  writeDraft,
  type ProjectMaterial,
  type ProjectMaterialCalculation,
  type ProjectPieceInput,
  type ProjectQuoteRow,
  type ProjectSnapshot,
  type ProjectStockInput,
  type SavedProject,
} from "@/lib/project-storage";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "定尺カット最適化 | 歩留まり計算" },
      {
        name: "description",
        content:
          "定尺材の切り出しを最適化。刃厚を考慮した1次元カッティングストック計算で歩留まりを最大化する職人向けモバイルアプリ。",
      },
      { property: "og:title", content: "定尺カット最適化" },
      {
        property: "og:description",
        content: "1次元切断最適化で材料の歩留まりを最大化。",
      },
    ],
  }),
  component: Index,
});

type PieceInput = ProjectPieceInput;

const uid = () => Math.random().toString(36).slice(2, 9);

type StockInput = ProjectStockInput;

type StockRow = ProjectQuoteRow;

interface ConfirmationRequest {
  title: string;
  description: string;
  confirmLabel: string;
  destructive?: boolean;
  onConfirm: () => void;
}

interface MaterialImportDialogState {
  fileName: string;
  result: MaterialImportResult;
}

type PrintDocumentKind = "estimate" | "cutting-order";

const defaultQuoteNotes =
  "・お見積有効期限：発行日より30日間\n・お支払条件：別途ご相談\n・上記金額には消費税を含みます。";

const csvTemplateUrl = `data:text/csv;charset=utf-8,${encodeURIComponent(`\uFEFF${CSV_TEMPLATE_TEXT}`)}`;
const maxImportFileSize = 10 * 1024 * 1024;

const yen = (n: number) => `¥${n.toLocaleString()}`;

const formatToday = () =>
  new Date().toLocaleDateString("ja-JP", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

const calculateQuoteTotals = (
  rows: StockRow[],
  laborCost: string,
  otherCost: string,
  taxRate: string,
) => {
  const laborCostNum = Number(laborCost) || 0;
  const otherCostNum = Number(otherCost) || 0;
  const taxRateNum = Number(taxRate) || 0;
  const subtotals = rows.map((r) => (Number(r.qty) || 0) * (Number(r.price) || 0));
  const materialCost = subtotals.reduce((a, b) => a + b, 0);
  const subtotal = materialCost + laborCostNum + otherCostNum;
  const tax = Math.round((subtotal * taxRateNum) / 100);
  const total = subtotal + tax;

  return { laborCostNum, otherCostNum, taxRateNum, subtotals, subtotal, tax, total };
};

const createMaterial = (
  id = `material-${Date.now()}-${uid()}`,
  withSamples = false,
): ProjectMaterial => ({
  id,
  name: "",
  specification: "",
  stocks: [{ id: uid(), length: "5000" }],
  kerf: "4",
  pieces: withSamples
    ? [
        { id: uid(), name: "", length: "1200", qty: "4" },
        { id: uid(), name: "", length: "800", qty: "6" },
        { id: uid(), name: "", length: "450", qty: "10" },
      ]
    : [{ id: uid(), name: "", length: "", qty: "1" }],
});

const createBlankSnapshot = (): ProjectSnapshot => ({
  version: PROJECT_STORAGE_VERSION,
  project: { name: "", activeProjectId: null, activeMaterialId: "primary-material" },
  materials: [createMaterial("primary-material")],
  calculation: { materials: [] },
  estimate: {
    rows: [],
    recipient: "",
    issuer: "",
    notes: defaultQuoteNotes,
    laborCost: "5000",
    otherCost: "1000",
    taxRate: "10",
  },
});

function Index() {
  const [projectName, setProjectName] = useState("");
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [materials, setMaterials] = useState<ProjectMaterial[]>(() => [
    createMaterial("primary-material", true),
  ]);
  const [activeMaterialId, setActiveMaterialId] = useState("primary-material");
  const [calculations, setCalculations] = useState<ProjectMaterialCalculation[]>([]);
  const [savedProjects, setSavedProjects] = useState<SavedProject[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [confirmation, setConfirmation] = useState<ConfirmationRequest | null>(null);
  const [storageReady, setStorageReady] = useState(false);
  const [saveStatus, setSaveStatus] = useState("下書きを準備中");
  const [storageError, setStorageError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [laborCost, setLaborCost] = useState("5000");
  const [otherCost, setOtherCost] = useState("1000");
  const [taxRate, setTaxRate] = useState("10");
  const [quoteOpen, setQuoteOpen] = useState(false);
  const [cuttingPreviewOpen, setCuttingPreviewOpen] = useState(false);
  const [quoteRows, setQuoteRows] = useState<StockRow[]>([]);
  const [recipient, setRecipient] = useState("");
  const [issuer, setIssuer] = useState("");
  const [notes, setNotes] = useState(defaultQuoteNotes);
  const [printPortalMounted, setPrintPortalMounted] = useState(false);
  const [printDocument, setPrintDocument] = useState<PrintDocumentKind | null>(null);
  const [materialImportDialog, setMaterialImportDialog] =
    useState<MaterialImportDialogState | null>(null);
  const [materialImportReading, setMaterialImportReading] = useState(false);
  const importFileInputRef = useRef<HTMLInputElement>(null);

  const activeMaterial =
    materials.find((material) => material.id === activeMaterialId) ?? materials[0]!;
  const materialName = activeMaterial.name;
  const materialSpec = activeMaterial.specification;
  const stocks = activeMaterial.stocks;
  const kerf = activeMaterial.kerf;
  const pieces = activeMaterial.pieces;
  const activeCalculation = calculations.find(
    (calculation) => calculation.materialId === activeMaterial.id,
  );
  const result = activeCalculation?.result ?? null;
  const lastCalculatedInputKey = activeCalculation?.inputKey ?? null;

  const updateActiveMaterial = useCallback(
    (update: (material: ProjectMaterial) => ProjectMaterial) => {
      setMaterials((previous) =>
        previous.map((material) =>
          material.id === activeMaterialId ? update(material) : material,
        ),
      );
    },
    [activeMaterialId],
  );
  const setMaterialName = (value: string) =>
    updateActiveMaterial((material) => ({ ...material, name: value }));
  const setMaterialSpec = (value: string) =>
    updateActiveMaterial((material) => ({ ...material, specification: value }));
  const setStocks = (next: SetStateAction<StockInput[]>) =>
    updateActiveMaterial((material) => ({
      ...material,
      stocks: typeof next === "function" ? next(material.stocks) : next,
    }));
  const setKerf = (value: string) =>
    updateActiveMaterial((material) => ({ ...material, kerf: value }));
  const setPieces = (next: SetStateAction<PieceInput[]>) =>
    updateActiveMaterial((material) => ({
      ...material,
      pieces: typeof next === "function" ? next(material.pieces) : next,
    }));
  const updateActiveCalculation = (
    update: (calculation: ProjectMaterialCalculation) => ProjectMaterialCalculation,
  ) =>
    setCalculations((previous) => {
      const existing = previous.find(
        (calculation) => calculation.materialId === activeMaterial.id,
      ) ?? {
        materialId: activeMaterial.id,
        result: null,
        inputKey: null,
      };
      return [
        ...previous.filter((calculation) => calculation.materialId !== activeMaterial.id),
        update(existing),
      ];
    });
  const setResult = (value: CutResult | null) =>
    updateActiveCalculation((calculation) => ({ ...calculation, result: value }));
  const setLastCalculatedInputKey = (value: string | null) =>
    updateActiveCalculation((calculation) => ({ ...calculation, inputKey: value }));

  const currentCalculationInputKey = useMemo(
    () => createCalculationInputKey({ stocks, kerf, pieces }),
    [stocks, kerf, pieces],
  );
  const needsRecalculation =
    result !== null && lastCalculatedInputKey !== currentCalculationInputKey;

  const createSnapshot = useCallback(
    (): ProjectSnapshot => ({
      version: PROJECT_STORAGE_VERSION,
      project: { name: projectName, activeProjectId, activeMaterialId },
      materials,
      calculation: { materials: calculations },
      estimate: {
        rows: quoteRows,
        recipient,
        issuer,
        notes,
        laborCost,
        otherCost,
        taxRate,
      },
    }),
    [
      projectName,
      activeProjectId,
      activeMaterialId,
      materials,
      calculations,
      quoteRows,
      recipient,
      issuer,
      notes,
      laborCost,
      otherCost,
      taxRate,
    ],
  );

  const restoreSnapshot = (snapshot: ProjectSnapshot) => {
    setProjectName(snapshot.project.name);
    setActiveProjectId(snapshot.project.activeProjectId);
    setMaterials(
      snapshot.materials.map((material) => ({
        ...material,
        pieces: material.pieces.map((piece) => ({ ...piece, name: piece.name ?? "" })),
      })),
    );
    setActiveMaterialId(snapshot.project.activeMaterialId);
    setCalculations(snapshot.calculation.materials);
    setQuoteRows(snapshot.estimate.rows);
    setRecipient(snapshot.estimate.recipient);
    setIssuer(snapshot.estimate.issuer);
    setNotes(snapshot.estimate.notes);
    setLaborCost(snapshot.estimate.laborCost);
    setOtherCost(snapshot.estimate.otherCost);
    setTaxRate(snapshot.estimate.taxRate);
    setError(null);
  };

  useEffect(() => {
    setPrintPortalMounted(true);
    try {
      const draft = readDraft(window.localStorage);
      setSavedProjects(readProjects(window.localStorage));
      if (draft) restoreSnapshot(draft);
      setSaveStatus(draft ? "下書きを復元しました" : "下書き自動保存");
    } catch {
      setStorageError(
        "この端末の保存領域を利用できません。ブラウザや端末の設定を確認してください。",
      );
      setSaveStatus("保存できません");
    } finally {
      setStorageReady(true);
    }
  }, []);

  useEffect(() => {
    const handleAfterPrint = () => setPrintDocument(null);
    window.addEventListener("afterprint", handleAfterPrint);
    return () => window.removeEventListener("afterprint", handleAfterPrint);
  }, []);

  useEffect(() => {
    if (!storageReady) return;
    setSaveStatus("保存中…");
    const timer = window.setTimeout(() => {
      try {
        writeDraft(window.localStorage, createSnapshot());
        setStorageError(null);
        setSaveStatus("下書き保存済み");
      } catch {
        setStorageError(
          "下書きを保存できませんでした。端末の空き容量やブラウザの保存設定を確認してください。",
        );
        setSaveStatus("保存できません");
      }
    }, 350);
    return () => window.clearTimeout(timer);
  }, [storageReady, createSnapshot]);

  const handleSaveProject = () => {
    const id = activeProjectId ?? `project-${Date.now()}-${uid()}`;
    const snapshot = createSnapshot();
    snapshot.project.activeProjectId = id;
    try {
      const next = saveProject(window.localStorage, snapshot, id);
      setActiveProjectId(id);
      setSavedProjects(next);
      setStorageError(null);
      setSaveStatus("案件を保存しました");
    } catch {
      setStorageError(
        "案件を保存できませんでした。端末の空き容量やブラウザの保存設定を確認してください。",
      );
      setSaveStatus("保存できません");
    }
  };

  const handleOpenProject = (project: SavedProject) => {
    restoreSnapshot(project.snapshot);
    try {
      writeDraft(window.localStorage, project.snapshot);
      setStorageError(null);
    } catch {
      setStorageError("案件は開けましたが、下書きとして保存できませんでした。");
    }
    setHistoryOpen(false);
    setSaveStatus("保存案件を開きました");
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const handleNewProject = () => {
    setConfirmation({
      title: "新しい案件を作りますか？",
      description:
        "現在の下書きは新しい案件に切り替わります。必要な内容は先に「案件を保存」してください。保存済みの案件履歴は消えません。",
      confirmLabel: "新しい案件を作る",
      onConfirm: () => {
        const snapshot = createBlankSnapshot();
        restoreSnapshot(snapshot);
        try {
          writeDraft(window.localStorage, snapshot);
          setStorageError(null);
        } catch {
          setStorageError("新しい案件を作成しましたが、下書きとして保存できませんでした。");
        }
        setQuoteOpen(false);
        setHistoryOpen(false);
        setSaveStatus("新しい案件を作成しました");
        window.scrollTo({ top: 0, behavior: "smooth" });
      },
    });
  };

  const handleDuplicateProject = (project: SavedProject) => {
    const id = `project-${Date.now()}-${uid()}`;
    const snapshot = structuredClone(project.snapshot);
    snapshot.project = {
      name: `${project.name}（コピー）`,
      activeProjectId: id,
      activeMaterialId: snapshot.project.activeMaterialId,
    };
    let next: SavedProject[];
    try {
      next = saveProject(window.localStorage, snapshot, id);
    } catch {
      setStorageError("案件を複製できませんでした。端末の保存領域を確認してください。");
      setSaveStatus("保存できません");
      return;
    }
    const duplicate = next.find((saved) => saved.id === id)!;
    setSavedProjects(next);
    restoreSnapshot(duplicate.snapshot);
    try {
      writeDraft(window.localStorage, duplicate.snapshot);
      setStorageError(null);
    } catch {
      setStorageError("案件は複製できましたが、下書きとして保存できませんでした。");
    }
    setHistoryOpen(false);
    setSaveStatus("案件を複製しました");
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const handleDeleteProject = (project: SavedProject) => {
    setConfirmation({
      title: "案件を削除しますか？",
      description: `「${project.name}」を案件履歴から削除します。この操作は元に戻せません。`,
      confirmLabel: "削除する",
      destructive: true,
      onConfirm: () => {
        try {
          const next = removeProject(window.localStorage, project.id);
          setSavedProjects(next);
          setStorageError(null);
          if (activeProjectId === project.id) {
            setActiveProjectId(null);
            setSaveStatus("案件履歴から削除しました（編集中の内容は残っています）");
          }
        } catch {
          setStorageError("案件を削除できませんでした。端末の保存領域を確認してください。");
          setSaveStatus("保存できません");
        }
      },
    });
  };

  const handleAddMaterial = () => {
    const material = createMaterial();
    setMaterials((previous) => [...previous, material]);
    setActiveMaterialId(material.id);
    setError(null);
    setQuoteOpen(false);
  };

  const handleImportFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    const lowerFileName = file.name.toLowerCase();
    const isCsv = lowerFileName.endsWith(".csv");
    const isExcel = lowerFileName.endsWith(".xlsx");
    if (!isCsv && !isExcel) {
      setMaterialImportDialog({
        fileName: file.name,
        result: { ok: false, errors: ["CSVまたはExcel（.xlsx）ファイルを選んでください。"] },
      });
      return;
    }
    if (file.size > maxImportFileSize) {
      setMaterialImportDialog({
        fileName: file.name,
        result: { ok: false, errors: ["取込ファイルは10MB以下にしてください。"] },
      });
      return;
    }

    setMaterialImportReading(true);
    try {
      const result = isCsv
        ? parseMaterialsCsv(decodeCsvBytes(await file.arrayBuffer()))
        : parseMaterialsRows(await (await import("read-excel-file/browser")).readSheet(file));
      setMaterialImportDialog({ fileName: file.name, result });
    } catch {
      setMaterialImportDialog({
        fileName: file.name,
        result: {
          ok: false,
          errors: [
            "ファイルを読み込めませんでした。パスワード保護されていないCSVまたはExcel（.xlsx）ファイルでお試しください。",
          ],
        },
      });
    } finally {
      setMaterialImportReading(false);
    }
  };

  const handleApplyMaterialImport = (data: MaterialImportData) => {
    setProjectName(data.projectName);
    setActiveProjectId(null);
    setMaterials(data.materials);
    setActiveMaterialId(data.materials[0]!.id);
    setCalculations([]);
    setQuoteRows([]);
    setRecipient("");
    setIssuer("");
    setNotes(defaultQuoteNotes);
    setLaborCost("5000");
    setOtherCost("1000");
    setTaxRate("10");
    setQuoteOpen(false);
    setError(null);
    setMaterialImportDialog(null);
    setSaveStatus("ファイルを取り込みました（下書き保存中）");
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const handleDuplicateMaterial = () => {
    const material = createMaterial();
    material.name = activeMaterial.name
      ? `${activeMaterial.name}（コピー）`
      : `材料${materials.length + 1}`;
    material.specification = activeMaterial.specification;
    material.stocks = activeMaterial.stocks.map((stock) => ({ ...stock, id: uid() }));
    material.kerf = activeMaterial.kerf;
    material.pieces = activeMaterial.pieces.map((piece) => ({ ...piece, id: uid() }));
    setMaterials((previous) => [...previous, material]);
    setActiveMaterialId(material.id);
    setError(null);
    setQuoteOpen(false);
  };

  const handleDeleteMaterial = () => {
    if (materials.length === 1) return;
    setConfirmation({
      title: "材料を削除しますか？",
      description: `「${activeMaterial.name || "名称未設定の材料"}」と、その計算結果・見積材料行を削除します。この操作は元に戻せません。`,
      confirmLabel: "材料を削除する",
      destructive: true,
      onConfirm: () => {
        const remaining = materials.filter((material) => material.id !== activeMaterial.id);
        setMaterials(remaining);
        setCalculations((previous) =>
          previous.filter((calculation) => calculation.materialId !== activeMaterial.id),
        );
        setQuoteRows((previous) => previous.filter((row) => row.materialId !== activeMaterial.id));
        setActiveMaterialId(remaining[0]!.id);
        setError(null);
        setQuoteOpen(false);
      },
    });
  };

  const updatePiece = (id: string, key: "name" | "length" | "qty", value: string) => {
    setPieces((prev) => prev.map((p) => (p.id === id ? { ...p, [key]: value } : p)));
  };

  const addPiece = () =>
    setPieces((prev) => [...prev, { id: uid(), name: "", length: "", qty: "1" }]);

  const removePiece = (id: string) => setPieces((prev) => prev.filter((p) => p.id !== id));

  const updateStock = (id: string, value: string) =>
    setStocks((prev) => prev.map((s) => (s.id === id ? { ...s, length: value } : s)));
  const addStock = () => setStocks((prev) => [...prev, { id: uid(), length: "" }]);
  const removeStock = (id: string) => setStocks((prev) => prev.filter((s) => s.id !== id));

  const handleCalc = () => {
    setError(null);
    const kerfNum = Number(kerf);
    if (!Number.isFinite(kerfNum) || kerfNum < 0) {
      setError("刃の厚みを正しく入力してください。");
      return;
    }
    const stockNums: number[] = [];
    for (const s of stocks) {
      const v = Number(s.length);
      if (!s.length.trim()) continue;
      if (!Number.isFinite(v) || v <= 0) {
        setError("定尺材の長さは正の数で入力してください。");
        return;
      }
      stockNums.push(v);
    }
    if (stockNums.length === 0) {
      setError("定尺材を1つ以上追加してください。");
      return;
    }
    // de-duplicate
    const uniqueStocks = Array.from(new Set(stockNums));
    const cleaned: Piece[] = [];
    for (const p of pieces) {
      const l = Number(p.length);
      const q = Number(p.qty);
      if (!l && !q) continue;
      if (!Number.isFinite(l) || l <= 0) {
        setError("部材の長さは正の数で入力してください。");
        return;
      }
      if (!Number.isInteger(q) || q <= 0) {
        setError("部材の本数は1以上の整数で入力してください。");
        return;
      }
      cleaned.push({ length: l, qty: q, label: p.name.trim() || undefined });
    }
    if (cleaned.length === 0) {
      setError("部材を1つ以上追加してください。");
      return;
    }
    const nextResult = solveCuttingStock(uniqueStocks, kerfNum, cleaned);
    setResult(nextResult);
    setLastCalculatedInputKey(currentCalculationInputKey);
    setQuoteRows((prev) => {
      const materialRows = prev.filter((row) => row.materialId === activeMaterial.id);
      const previousByLength = new Map(materialRows.map((r) => [r.stockLength, r]));
      const nextMaterialRows = nextResult.stockUsage.map((u) => {
        const previous = previousByLength.get(u.stockLength);
        return {
          materialId: activeMaterial.id,
          materialName: activeMaterial.name,
          materialSpecification: activeMaterial.specification,
          stockLength: u.stockLength,
          qty: String(u.count),
          price: previous?.price ?? "",
        };
      });
      return [...prev.filter((row) => row.materialId !== activeMaterial.id), ...nextMaterialRows];
    });
  };

  const displayQuoteRows = useMemo(
    () =>
      quoteRows.map((row) => {
        const material = materials.find((candidate) => candidate.id === row.materialId);
        return material
          ? {
              ...row,
              materialName: material.name,
              materialSpecification: material.specification,
            }
          : row;
      }),
    [quoteRows, materials],
  );

  const allMaterialsCalculated = materials.every((material) => {
    const calculation = calculations.find((candidate) => candidate.materialId === material.id);
    return (
      calculation?.result !== null &&
      calculation?.result !== undefined &&
      calculation.inputKey === createCalculationInputKey(material)
    );
  });

  const pieceColorMap = useMemo(() => {
    const map = new Map<number, string>();
    pieces.forEach((_, i) => map.set(i, colorFor(i)));
    return map;
  }, [pieces]);

  const handlePrintDocument = (kind: PrintDocumentKind) => {
    setPrintDocument(kind);
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => window.print());
    });
  };

  return (
    <>
      <main className="app-screen min-h-screen bg-background text-foreground pb-32">
        <header className="px-5 pt-6 pb-4 border-b border-border sticky top-0 bg-background/95 backdrop-blur z-10">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h1 className="text-2xl font-black tracking-tight">カットマスタープロ</h1>
              <p className="text-xs text-muted-foreground mt-1">{saveStatus}</p>
            </div>
            <button
              type="button"
              onClick={() => setHistoryOpen(true)}
              className="h-11 px-4 rounded-xl bg-secondary text-secondary-foreground text-sm font-bold shrink-0"
            >
              案件履歴 <span className="tabular-nums">{savedProjects.length}</span>
            </button>
          </div>
        </header>

        <section className="px-5 pt-6 space-y-6">
          {storageError && (
            <div
              role="alert"
              className="rounded-2xl border-2 border-destructive bg-destructive/15 p-4"
            >
              <div className="font-black text-destructive">端末への保存に失敗しました</div>
              <p className="text-sm text-muted-foreground mt-1">{storageError}</p>
            </div>
          )}
          <div className="rounded-2xl border-2 border-primary/30 bg-card p-4 space-y-4">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-lg font-black">案件情報</h2>
              <button
                type="button"
                onClick={handleSaveProject}
                className="h-11 px-5 rounded-xl bg-primary text-primary-foreground font-black active:scale-[0.98]"
              >
                案件を保存
              </button>
            </div>
            <TextInput
              label="案件名"
              value={projectName}
              onChange={setProjectName}
              placeholder="例: ○○邸 手すり工事"
            />
          </div>

          <div className="rounded-2xl border-2 border-primary/30 bg-card p-4 space-y-4">
            <div>
              <div>
                <h2 className="text-lg font-black">材料</h2>
                <p className="text-xs text-muted-foreground mt-1">
                  {materials.length}種類中{" "}
                  {materials.findIndex((m) => m.id === activeMaterial.id) + 1}件目
                </p>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={handleAddMaterial}
                className="h-12 rounded-xl bg-primary text-primary-foreground text-sm font-black"
              >
                ＋ 材料追加
              </button>
              <button
                type="button"
                onClick={() => importFileInputRef.current?.click()}
                disabled={materialImportReading}
                className="h-12 rounded-xl bg-secondary text-secondary-foreground text-sm font-black disabled:opacity-50"
              >
                {materialImportReading ? "読込中…" : "CSV・Excel取込"}
              </button>
              <input
                ref={importFileInputRef}
                type="file"
                accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                onChange={handleImportFileChange}
                className="hidden"
                aria-label="取り込むCSVまたはExcelファイル"
              />
            </div>
            <a
              href={csvTemplateUrl}
              download="cut-master-pro-template.csv"
              className="text-xs font-bold text-primary underline underline-offset-4"
            >
              Excelで開ける入力見本（CSV）
            </a>

            <div className="flex gap-2 overflow-x-auto pb-1" aria-label="材料切り替え">
              {materials.map((material, index) => {
                const calculation = calculations.find(
                  (candidate) => candidate.materialId === material.id,
                );
                const current = material.id === activeMaterial.id;
                const calculated =
                  calculation?.result &&
                  calculation.inputKey === createCalculationInputKey(material);
                return (
                  <button
                    key={material.id}
                    type="button"
                    onClick={() => {
                      setActiveMaterialId(material.id);
                      setError(null);
                    }}
                    aria-pressed={current}
                    className={`min-w-[9rem] h-14 px-3 rounded-xl border-2 text-left shrink-0 ${
                      current ? "border-primary bg-primary/15" : "border-border bg-background"
                    }`}
                  >
                    <span className="block text-sm font-black truncate">
                      {material.name || `材料${index + 1}`}
                    </span>
                    <span className="block text-[11px] text-muted-foreground mt-0.5">
                      {calculated ? "計算済み" : calculation?.result ? "再計算が必要" : "未計算"}
                    </span>
                  </button>
                );
              })}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <TextInput
                label="材料名"
                value={materialName}
                onChange={setMaterialName}
                placeholder="例: ステンレス角パイプ"
              />
              <TextInput
                label="規格名"
                value={materialSpec}
                onChange={setMaterialSpec}
                placeholder="例: SUS304 40×40×2.0"
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={handleDuplicateMaterial}
                className="h-11 rounded-xl bg-secondary text-secondary-foreground text-sm font-bold"
              >
                この材料を複製
              </button>
              <button
                type="button"
                onClick={handleDeleteMaterial}
                disabled={materials.length === 1}
                className="h-11 rounded-xl border border-destructive text-destructive text-sm font-bold disabled:opacity-30"
              >
                この材料を削除
              </button>
            </div>
          </div>
          {/* Stocks list */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-bold">使用可能な定尺材</h2>
              <span className="text-xs text-muted-foreground">在庫リスト (mm)</span>
            </div>
            <div className="space-y-3">
              {stocks.map((s) => (
                <div key={s.id} className="rounded-2xl border border-border bg-card p-3">
                  <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2 items-end">
                    <NumberInput
                      label="定尺材の長さ (mm)"
                      value={s.length}
                      onChange={(v) => updateStock(s.id, v)}
                      placeholder="例: 5000"
                    />
                    <button
                      type="button"
                      aria-label="この定尺材を削除"
                      onClick={() => removeStock(s.id)}
                      disabled={stocks.length === 1}
                      className="h-14 w-14 shrink-0 rounded-xl bg-secondary text-secondary-foreground text-2xl font-bold active:scale-95 transition-transform disabled:opacity-30"
                    >
                      ×
                    </button>
                  </div>
                </div>
              ))}
            </div>
            <button
              type="button"
              onClick={addStock}
              className="w-full h-14 rounded-2xl border-2 border-dashed border-border text-base font-bold text-muted-foreground active:scale-[0.99] transition-transform"
            >
              ＋ 定尺材を追加
            </button>
          </div>

          <BigField label="刃の厚み（アサリ幅）" unit="mm" value={kerf} onChange={setKerf} />

          {/* Pieces */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-bold">必要な部材</h2>
              <span className="text-xs text-muted-foreground">長さ / 本数を入力</span>
            </div>

            <div className="space-y-3">
              {pieces.map((p, i) => (
                <div
                  key={p.id}
                  className="rounded-2xl border border-border bg-card p-3"
                  style={{
                    boxShadow: `inset 4px 0 0 0 ${colorFor(i)}`,
                  }}
                >
                  <TextInput
                    label="部材名"
                    value={p.name}
                    onChange={(v) => updatePiece(p.id, "name", v)}
                    placeholder="例: 横桟"
                    compact
                  />
                  <div className="mt-2 grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] gap-2 items-end">
                    <NumberInput
                      label="長さ (mm)"
                      value={p.length}
                      onChange={(v) => updatePiece(p.id, "length", v)}
                      placeholder="例: 1200"
                    />
                    <NumberInput
                      label="本数"
                      value={p.qty}
                      onChange={(v) => updatePiece(p.id, "qty", v)}
                      placeholder="例: 4"
                    />
                    <button
                      type="button"
                      aria-label="この部材を削除"
                      onClick={() => removePiece(p.id)}
                      disabled={pieces.length === 1}
                      className="h-14 w-14 shrink-0 rounded-xl bg-secondary text-secondary-foreground text-2xl font-bold active:scale-95 transition-transform disabled:opacity-30"
                    >
                      ×
                    </button>
                  </div>
                </div>
              ))}
            </div>

            <button
              type="button"
              onClick={addPiece}
              className="w-full h-14 rounded-2xl border-2 border-dashed border-border text-base font-bold text-muted-foreground active:scale-[0.99] transition-transform"
            >
              ＋ 部材を追加
            </button>
          </div>

          {error && (
            <div
              role="alert"
              className="rounded-xl bg-destructive/20 border border-destructive text-destructive-foreground p-3 text-sm font-medium"
            >
              {error}
            </div>
          )}

          <button
            type="button"
            onClick={handleCalc}
            className="w-full h-20 rounded-2xl bg-primary text-primary-foreground text-2xl font-black tracking-wide shadow-lg active:scale-[0.99] transition-transform"
            style={{
              boxShadow: "0 10px 30px -10px color-mix(in oklab, var(--primary) 60%, transparent)",
            }}
          >
            {needsRecalculation ? "再計算する" : "計算する"}
          </button>

          {needsRecalculation && (
            <div
              role="status"
              className="rounded-2xl border-2 border-amber-500 bg-amber-500/15 p-4"
            >
              <div className="font-black text-amber-500">計算条件が変更されています</div>
              <p className="text-sm text-muted-foreground mt-1">
                下の結果は変更前の内容です。「再計算する」を押して更新してください。
              </p>
            </div>
          )}

          {result && (
            <>
              <ResultView
                result={result}
                pieceColorMap={pieceColorMap}
                materialLabel={
                  materialName ||
                  `材料${materials.findIndex((material) => material.id === activeMaterial.id) + 1}`
                }
              />
              <div className="rounded-2xl border-2 border-accent/50 bg-accent/10 p-4 space-y-3">
                <div>
                  <h3 className="text-lg font-black">現場用の切断順</h3>
                  <p className="text-sm text-muted-foreground mt-1">
                    定尺材ごとに分け、各定尺の中を長い順に並べて印刷します。
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setCuttingPreviewOpen(true)}
                  disabled={needsRecalculation}
                  className="w-full h-16 rounded-2xl bg-secondary text-secondary-foreground text-lg font-black active:scale-[0.99] transition-transform disabled:opacity-40"
                >
                  {needsRecalculation ? "再計算すると切断順を印刷できます" : "🖨️ 切断順を印刷する"}
                </button>
              </div>
              <button
                type="button"
                onClick={() => setQuoteOpen(true)}
                disabled={!allMaterialsCalculated}
                className="w-full h-20 rounded-2xl bg-accent text-accent-foreground text-2xl font-black tracking-wide shadow-lg active:scale-[0.99] transition-transform disabled:opacity-40 disabled:shadow-none"
              >
                {allMaterialsCalculated
                  ? "📄 全材料の見積書を作成する"
                  : "すべての材料を計算すると見積できます"}
              </button>
            </>
          )}
        </section>
        {result && quoteOpen && (
          <QuoteModal
            onClose={() => setQuoteOpen(false)}
            onPrint={() => handlePrintDocument("estimate")}
            rows={displayQuoteRows}
            setRows={setQuoteRows}
            recipient={recipient}
            setRecipient={setRecipient}
            issuer={issuer}
            setIssuer={setIssuer}
            notes={notes}
            setNotes={setNotes}
            laborCost={laborCost}
            setLaborCost={setLaborCost}
            otherCost={otherCost}
            setOtherCost={setOtherCost}
            taxRate={taxRate}
            setTaxRate={setTaxRate}
          />
        )}
        {result && cuttingPreviewOpen && (
          <CuttingOrderPreviewModal
            projectName={projectName}
            material={activeMaterial}
            result={result}
            onClose={() => setCuttingPreviewOpen(false)}
            onPrint={() => handlePrintDocument("cutting-order")}
          />
        )}
        {historyOpen && (
          <ProjectHistory
            projects={savedProjects}
            onOpen={handleOpenProject}
            onNew={handleNewProject}
            onDuplicate={handleDuplicateProject}
            onDelete={handleDeleteProject}
            onClose={() => setHistoryOpen(false)}
          />
        )}
        {confirmation && (
          <ConfirmationDialog
            request={confirmation}
            onCancel={() => setConfirmation(null)}
            onConfirm={() => {
              const action = confirmation.onConfirm;
              setConfirmation(null);
              action();
            }}
          />
        )}
        {materialImportDialog && (
          <MaterialImportDialog
            state={materialImportDialog}
            onCancel={() => setMaterialImportDialog(null)}
            onApply={handleApplyMaterialImport}
          />
        )}
      </main>
      {result &&
        printPortalMounted &&
        printDocument === "estimate" &&
        createPortal(
          <PrintableEstimate
            rows={displayQuoteRows}
            recipient={recipient}
            issuer={issuer}
            notes={notes}
            laborCost={laborCost}
            otherCost={otherCost}
            taxRate={taxRate}
          />,
          document.body,
        )}
      {result &&
        printPortalMounted &&
        printDocument === "cutting-order" &&
        createPortal(
          <PrintableCuttingOrder
            projectName={projectName}
            material={activeMaterial}
            result={result}
          />,
          document.body,
        )}
    </>
  );
}

function TextInput({
  label,
  value,
  onChange,
  placeholder,
  compact = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  compact?: boolean;
}) {
  return (
    <label className="block min-w-0">
      <span className="block text-xs font-bold text-muted-foreground mb-1">{label}</span>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className={`w-full ${compact ? "h-12" : "h-14"} rounded-xl bg-background border-2 border-border px-3 text-base font-bold focus:border-primary focus:outline-none`}
      />
    </label>
  );
}

function ProjectHistory({
  projects,
  onOpen,
  onNew,
  onDuplicate,
  onDelete,
  onClose,
}: {
  projects: SavedProject[];
  onOpen: (project: SavedProject) => void;
  onNew: () => void;
  onDuplicate: (project: SavedProject) => void;
  onDelete: (project: SavedProject) => void;
  onClose: () => void;
}) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="案件履歴"
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/70 p-0 sm:p-4"
      onClick={onClose}
    >
      <div
        className="bg-card w-full sm:max-w-lg rounded-t-3xl sm:rounded-3xl max-h-[85vh] overflow-y-auto border border-border"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="sticky top-0 bg-card px-5 py-4 border-b border-border flex items-center justify-between z-10">
          <div>
            <h2 className="text-xl font-black">案件履歴</h2>
            <p className="text-xs text-muted-foreground mt-1">この端末に保存された案件</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="閉じる"
            className="h-12 w-12 rounded-xl bg-secondary text-2xl font-bold"
          >
            ×
          </button>
        </div>
        <div className="p-4 space-y-3">
          <button
            type="button"
            onClick={onNew}
            className="w-full h-14 rounded-2xl border-2 border-dashed border-primary text-primary font-black active:scale-[0.99]"
          >
            ＋ 新しい案件を作る
          </button>
          {projects.map((project) => (
            <div key={project.id} className="rounded-2xl border border-border bg-background p-3">
              <button
                type="button"
                onClick={() => onOpen(project)}
                className="w-full text-left p-1 active:opacity-70"
              >
                <div className="font-black text-lg break-words">{project.name}</div>
                <div className="text-sm text-muted-foreground mt-1 break-words">
                  {project.snapshot.materials
                    .slice(0, 2)
                    .map((material, index) => material.name || `材料${index + 1}`)
                    .join(" / ") || "材料未設定"}
                  {project.snapshot.materials.length > 2
                    ? ` ほか${project.snapshot.materials.length - 2}種類`
                    : ""}
                </div>
                <div className="text-xs text-muted-foreground mt-3">
                  {project.snapshot.materials.length}種類・更新
                  {new Date(project.updatedAt).toLocaleString("ja-JP")}
                </div>
              </button>
              <div className="grid grid-cols-2 gap-2 mt-3 pt-3 border-t border-border">
                <button
                  type="button"
                  onClick={() => onDuplicate(project)}
                  className="h-11 rounded-xl bg-secondary text-secondary-foreground text-sm font-bold"
                >
                  複製
                </button>
                <button
                  type="button"
                  onClick={() => onDelete(project)}
                  className="h-11 rounded-xl border border-destructive text-destructive text-sm font-bold"
                >
                  削除
                </button>
              </div>
            </div>
          ))}
          {projects.length === 0 && (
            <div className="py-12 text-center text-muted-foreground">
              保存済みの案件はありません
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function MaterialImportDialog({
  state,
  onCancel,
  onApply,
}: {
  state: MaterialImportDialogState;
  onCancel: () => void;
  onApply: (data: MaterialImportData) => void;
}) {
  const importData = state.result.ok ? state.result.data : null;
  const importErrors = state.result.ok ? [] : state.result.errors;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="material-import-title"
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/75 p-5"
    >
      <div className="w-full max-w-md max-h-[85vh] overflow-y-auto rounded-3xl border border-border bg-card p-5 shadow-2xl">
        <h2 id="material-import-title" className="text-xl font-black">
          {importData ? "取込内容を確認" : "ファイルを取り込めません"}
        </h2>
        <p className="mt-1 text-xs text-muted-foreground break-all">{state.fileName}</p>
        {importData && state.fileName.toLowerCase().endsWith(".xlsx") && (
          <p className="mt-1 text-xs text-muted-foreground">Excelの先頭シートを読み込みました</p>
        )}

        {importData ? (
          <>
            <div className="mt-4 rounded-2xl bg-primary/10 border border-primary/40 p-4">
              <div className="text-sm font-black">
                {importData.materials.length}種類・{importData.sourceRowCount}行を取り込みます
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                {importData.projectName
                  ? `案件名: ${importData.projectName}`
                  : "案件名は空欄になります"}
              </p>
            </div>
            <div className="mt-4 space-y-2">
              {importData.materials.map((material) => (
                <div key={material.id} className="rounded-xl border border-border p-3">
                  <div className="font-black break-words">{material.name}</div>
                  {material.specification && (
                    <div className="text-xs text-muted-foreground mt-0.5 break-words">
                      {material.specification}
                    </div>
                  )}
                  <div className="text-xs text-muted-foreground mt-2">
                    定尺材 {material.stocks.length}種類・部材 {material.pieces.length}件・刃厚
                    {material.kerf}mm
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-4 rounded-xl border border-amber-500 bg-amber-500/15 p-3">
              <div className="text-sm font-black text-amber-500">反映前にご確認ください</div>
              <p className="text-xs leading-relaxed text-muted-foreground mt-1">
                現在編集中の材料・計算結果・見積内容は置き換わります。取込後は新しい未保存案件として扱うため、保存済みの案件履歴は変更されません。
              </p>
            </div>
            <div className="grid grid-cols-2 gap-3 mt-6">
              <button
                type="button"
                onClick={onCancel}
                className="h-14 rounded-2xl bg-secondary text-secondary-foreground font-bold"
              >
                キャンセル
              </button>
              <button
                type="button"
                onClick={() => onApply(importData)}
                className="h-14 rounded-2xl bg-primary text-primary-foreground font-black"
              >
                この内容で反映
              </button>
            </div>
          </>
        ) : (
          <>
            <div
              role="alert"
              className="mt-4 rounded-2xl border border-destructive bg-destructive/15 p-4"
            >
              <ul className="space-y-2 text-sm">
                {importErrors.slice(0, 20).map((error, index) => (
                  <li key={`${index}-${error}`}>・{error}</li>
                ))}
              </ul>
              {importErrors.length > 20 && (
                <p className="mt-3 text-xs text-muted-foreground">
                  ほか {importErrors.length - 20}件のエラーがあります。
                </p>
              )}
            </div>
            <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
              「入力用CSV見本」と同じ列名にすると取り込めます。CSVはUTF-8／Shift-JIS、Excelは.xlsx形式の先頭シートに対応しています。
            </p>
            <button
              type="button"
              onClick={onCancel}
              className="w-full h-14 mt-6 rounded-2xl bg-secondary text-secondary-foreground font-bold"
            >
              閉じる
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function ConfirmationDialog({
  request,
  onCancel,
  onConfirm,
}: {
  request: ConfirmationRequest;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="confirmation-title"
      aria-describedby="confirmation-description"
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/75 p-5"
    >
      <div className="w-full max-w-sm rounded-3xl border border-border bg-card p-5 shadow-2xl">
        <h2 id="confirmation-title" className="text-xl font-black">
          {request.title}
        </h2>
        <p
          id="confirmation-description"
          className="mt-3 text-sm leading-relaxed text-muted-foreground"
        >
          {request.description}
        </p>
        <div className="grid grid-cols-2 gap-3 mt-6">
          <button
            type="button"
            onClick={onCancel}
            className="h-14 rounded-2xl bg-secondary text-secondary-foreground font-bold"
          >
            キャンセル
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className={`h-14 rounded-2xl font-black ${
              request.destructive
                ? "bg-destructive text-destructive-foreground"
                : "bg-primary text-primary-foreground"
            }`}
          >
            {request.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

function BigField({
  label,
  unit,
  value,
  onChange,
}: {
  label: string;
  unit: string;
  value: string;
  onChange: (v: string) => void;
}) {
  const { inputRef, initialValue, handleInput, handleKeyDown } = useStableNumericInput(
    value,
    onChange,
  );

  return (
    <label className="block">
      <span className="block text-sm font-bold text-muted-foreground mb-2">{label}</span>
      <div className="relative">
        <input
          ref={inputRef}
          dir="ltr"
          inputMode="numeric"
          pattern="[0-9]*"
          defaultValue={initialValue}
          onInput={handleInput}
          onKeyDown={handleKeyDown}
          className="w-full h-16 rounded-2xl bg-card border-2 border-border px-5 pr-16 text-3xl font-bold tabular-nums text-foreground focus:border-primary focus:outline-none"
        />
        <span className="absolute right-5 top-1/2 -translate-y-1/2 text-lg font-bold text-muted-foreground">
          {unit}
        </span>
      </div>
    </label>
  );
}

function NumberInput({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  const { inputRef, initialValue, handleInput, handleKeyDown } = useStableNumericInput(
    value,
    onChange,
  );

  return (
    <label className="block min-w-0">
      <span className="block text-xs font-bold text-muted-foreground mb-1">{label}</span>
      <input
        ref={inputRef}
        dir="ltr"
        inputMode="numeric"
        pattern="[0-9]*"
        defaultValue={initialValue}
        placeholder={placeholder}
        onInput={handleInput}
        onKeyDown={handleKeyDown}
        className="w-full h-14 rounded-xl bg-background border-2 border-border px-3 text-xl font-bold tabular-nums focus:border-primary focus:outline-none"
      />
    </label>
  );
}

function useStableNumericInput(value: string, onChange: (value: string) => void) {
  const inputRef = useRef<HTMLInputElement>(null);
  const initialValue = useRef(value).current;

  const handleInput = (event: React.FormEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    onChange(input.value);
    window.requestAnimationFrame(() => {
      if (document.activeElement !== input) return;
      const end = input.value.length;
      input.setSelectionRange(end, end);
    });
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (!/^[0-9]$/.test(event.key)) return;
    const input = event.currentTarget;
    if (input.selectionStart !== input.selectionEnd) return;
    const end = input.value.length;
    input.setSelectionRange(end, end);
  };

  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input || document.activeElement === input || input.value === value) return;
    input.value = value;
  }, [value]);

  return { inputRef, initialValue, handleInput, handleKeyDown };
}

function ResultView({
  result,
  pieceColorMap,
  materialLabel,
}: {
  result: CutResult;
  pieceColorMap: Map<number, string>;
  materialLabel: string;
}) {
  const yieldPct = (result.yieldRate * 100).toFixed(1);
  const maxStock = Math.max(1, ...result.bars.map((b) => b.stockLength));
  return (
    <section className="space-y-5 pt-2">
      <div>
        <h2 className="text-xl font-black">計算結果</h2>
        <p className="text-sm text-muted-foreground mt-1">{materialLabel}</p>
      </div>

      {result.stockUsage.length > 0 && (
        <div className="rounded-2xl border-2 border-primary/50 bg-primary/10 p-4">
          <div className="text-xs font-bold text-muted-foreground mb-2">使用する定尺材の内訳</div>
          <div className="space-y-1">
            {result.stockUsage.map((u) => (
              <div
                key={u.stockLength}
                className="flex items-baseline justify-between text-base font-bold"
              >
                <span className="tabular-nums">{u.stockLength.toLocaleString()}mm 材</span>
                <span className="tabular-nums text-2xl text-primary">
                  {u.count}
                  <span className="text-sm ml-1">本</span>
                </span>
              </div>
            ))}
            <div className="flex items-baseline justify-between pt-2 mt-2 border-t border-border text-sm font-bold text-muted-foreground">
              <span>合計</span>
              <span className="tabular-nums">{result.totalStock} 本</span>
            </div>
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3">
        <Stat label="歩留まり率" value={yieldPct} unit="%" highlight />
        <Stat label="端材合計" value={result.totalWaste.toLocaleString()} unit="mm" />
        <Stat label="必要長さ合計" value={result.totalRequiredLength.toLocaleString()} unit="mm" />
        <Stat label="定尺材長さ合計" value={result.totalStockLength.toLocaleString()} unit="mm" />
      </div>

      {result.unfittable.length > 0 && (
        <div className="rounded-xl bg-destructive/20 border border-destructive p-3 text-sm">
          <strong className="block font-bold mb-1">配置不可な部材があります</strong>
          {result.unfittable.map((u, i) => (
            <div key={i}>
              長さ {u.length}mm × {u.qty}本 は最大の定尺材を超えています
            </div>
          ))}
        </div>
      )}

      <div className="space-y-4">
        <h3 className="text-base font-bold text-muted-foreground">切り出し図（各定尺材）</h3>
        {result.bars.map((bar, idx) => (
          <BarDiagram
            key={idx}
            index={idx}
            bar={bar}
            maxStock={maxStock}
            colorMap={pieceColorMap}
          />
        ))}
      </div>
    </section>
  );
}

function Stat({
  label,
  value,
  unit,
  highlight,
}: {
  label: string;
  value: string;
  unit: string;
  highlight?: boolean;
}) {
  return (
    <div
      className={`rounded-2xl p-4 border ${
        highlight ? "bg-primary/15 border-primary" : "bg-card border-border"
      }`}
    >
      <div className="text-xs font-bold text-muted-foreground">{label}</div>
      <div className="mt-1 flex items-baseline gap-1">
        <span className="text-3xl font-black tabular-nums">{value}</span>
        <span className="text-sm font-bold text-muted-foreground">{unit}</span>
      </div>
    </div>
  );
}

function BarDiagram({
  index,
  bar,
  maxStock,
  colorMap,
}: {
  index: number;
  bar: {
    stockLength: number;
    pieces: { length: number; pieceIndex: number }[];
    used: number;
    waste: number;
  };
  maxStock: number;
  colorMap: Map<number, string>;
}) {
  const containerWidthPct = (bar.stockLength / maxStock) * 100;
  return (
    <div className="rounded-2xl bg-card border border-border p-3">
      <div className="flex items-center justify-between mb-2 gap-2 flex-wrap">
        <div className="text-sm font-bold">
          #{index + 1}・<span className="tabular-nums">{bar.stockLength.toLocaleString()}mm</span>{" "}
          材
        </div>
        <div className="text-xs text-muted-foreground tabular-nums">
          使用 {bar.used.toLocaleString()} / 端材 {bar.waste.toLocaleString()}mm
        </div>
      </div>
      <div
        className="relative h-14 rounded-lg overflow-hidden bg-muted flex"
        style={{ width: `${containerWidthPct}%`, minWidth: "40%" }}
      >
        {bar.pieces.map((p, i) => {
          const widthPct = (p.length / bar.stockLength) * 100;
          return (
            <div
              key={i}
              className="h-full flex items-center justify-center text-[10px] sm:text-xs font-black text-black/80 border-r border-background/60"
              style={{
                width: `${widthPct}%`,
                backgroundColor: colorMap.get(p.pieceIndex) ?? "#888",
              }}
              title={`${p.length}mm`}
            >
              {widthPct > 6 ? `${p.length}` : ""}
            </div>
          );
        })}
        {bar.waste > 0 && (
          <div
            className="h-full flex items-center justify-center text-[10px] font-bold text-muted-foreground"
            style={{
              width: `${(bar.waste / bar.stockLength) * 100}%`,
              backgroundImage:
                "repeating-linear-gradient(45deg, transparent 0 6px, rgba(255,255,255,0.08) 6px 12px)",
            }}
          >
            {(bar.waste / bar.stockLength) * 100 > 8 ? `端材 ${bar.waste}` : ""}
          </div>
        )}
      </div>
      <div className="mt-2 text-xs text-muted-foreground tabular-nums">
        切断: {bar.pieces.map((p) => p.length).join(" / ")} mm
      </div>
    </div>
  );
}

interface CuttingOrderDocumentProps {
  projectName: string;
  material: ProjectMaterial;
  result: CutResult;
}

function CuttingOrderDocument({ projectName, material, result }: CuttingOrderDocumentProps) {
  const cuttingOrder = buildCuttingOrder(result, material.pieces);
  const stockSummary = result.stockUsage
    .map((usage) => `${usage.stockLength.toLocaleString()}mm × ${usage.count}本`)
    .join(" / ");

  return (
    <div className="cut-list-content bg-white text-black">
      <h2 className="cut-list-title text-3xl font-black text-center mb-5">切 断 作 業 表</h2>

      <div className="cut-list-meta grid grid-cols-2 border border-black mb-4">
        <div className="grid grid-cols-[7rem_1fr] border-r border-b border-black">
          <span className="bg-gray-100">案件名</span>
          <strong className="min-w-0 break-words">
            {projectName.trim() || "名称未設定の案件"}
          </strong>
        </div>
        <div className="grid grid-cols-[7rem_1fr] border-b border-black">
          <span className="bg-gray-100">材料・規格</span>
          <strong className="min-w-0 break-words">
            {material.name.trim() || "名称未設定の材料"}
            {material.specification.trim() ? ` / ${material.specification.trim()}` : ""}
          </strong>
        </div>
        <div className="grid grid-cols-[7rem_1fr] border-r border-black">
          <span className="bg-gray-100">刃厚</span>
          <strong>{Number(material.kerf).toLocaleString()}mm</strong>
        </div>
        <div className="grid grid-cols-[7rem_1fr]">
          <span className="bg-gray-100">作成日</span>
          <strong>{formatToday()}</strong>
        </div>
      </div>

      <div className="cut-list-summary grid grid-cols-[2fr_1fr_1fr] border border-black mb-4">
        <div className="flex flex-col border-r border-black">
          <span className="bg-gray-100">使用する定尺材</span>
          <strong>{stockSummary || "なし"}</strong>
        </div>
        <div className="flex flex-col border-r border-black">
          <span className="bg-gray-100">必要長さ合計</span>
          <strong>{result.totalRequiredLength.toLocaleString()}mm</strong>
        </div>
        <div className="flex flex-col">
          <span className="bg-gray-100">端材合計</span>
          <strong>{result.totalWaste.toLocaleString()}mm</strong>
        </div>
      </div>

      <p className="cut-list-note mb-3">
        各定尺材の中で、切断寸法の長い順に並んでいます。上から順に切断し、確認欄へ印を付けてください。
      </p>

      <table className="cut-list-table w-full border-collapse">
        <thead>
          <tr>
            <th className="w-[10%] border border-black bg-blue-100 px-2 py-2">No</th>
            <th className="w-[12%] border border-black bg-blue-100 px-2 py-2">定尺内</th>
            <th className="w-[22%] border border-black bg-blue-100 px-2 py-2">切断寸法(mm)</th>
            <th className="border border-black bg-blue-100 px-2 py-2">パイプ番号・部材名</th>
            <th className="w-[11%] border border-black bg-blue-100 px-2 py-2">確認</th>
          </tr>
        </thead>
        {cuttingOrder.map((bar) => (
          <tbody key={bar.barNumber} className="cut-stock-group">
            <tr className="cut-stock-heading">
              <th colSpan={5} className="border border-black bg-gray-100 px-2 py-2 text-left">
                定尺 #{bar.barNumber} ・ {bar.stockLength.toLocaleString()}mm材 ／ 使用
                {bar.used.toLocaleString()}mm ／ 端材 {bar.waste.toLocaleString()}mm
              </th>
            </tr>
            {bar.cuts.map((cut) => (
              <tr key={`${bar.barNumber}-${cut.sequence}`}>
                <td className="border border-black px-2 py-2 text-center">{cut.sequence}</td>
                <td className="border border-black px-2 py-2 text-center">{cut.orderInBar}</td>
                <td className="cut-length border border-black px-2 py-2 text-right font-bold">
                  {cut.length.toLocaleString()}
                </td>
                <td className="cut-label border border-black px-2 py-2">{cut.label}</td>
                <td className="cut-check border border-black px-2 py-2 text-center">□</td>
              </tr>
            ))}
          </tbody>
        ))}
      </table>
    </div>
  );
}

function PrintableCuttingOrder(props: CuttingOrderDocumentProps) {
  return (
    <div id="cutting-order-print-area" className="print-root print-area cut-list-document">
      <CuttingOrderDocument {...props} />
    </div>
  );
}

function CuttingOrderPreviewModal({
  onClose,
  onPrint,
  ...documentProps
}: CuttingOrderDocumentProps & {
  onClose: () => void;
  onPrint: () => void;
}) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="切断順プレビュー"
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/75 backdrop-blur-sm p-0 sm:p-4"
      onClick={onClose}
    >
      <div
        className="bg-card text-card-foreground w-full sm:max-w-5xl sm:rounded-2xl rounded-t-3xl max-h-[94vh] overflow-hidden border border-border flex flex-col"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 px-5 py-4 border-b border-border shrink-0">
          <div>
            <h2 className="text-xl font-black">切断順プレビュー</h2>
            <p className="text-xs text-muted-foreground mt-1">
              内容を確認してから印刷画面を開いてください。
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="閉じる"
            className="h-12 w-12 rounded-xl bg-secondary text-secondary-foreground text-2xl font-bold shrink-0"
          >
            ×
          </button>
        </div>

        <div className="overflow-auto bg-slate-200 p-3 sm:p-6">
          <div className="min-w-[680px] max-w-[210mm] mx-auto bg-white p-6 sm:p-8 shadow-xl">
            <CuttingOrderDocument {...documentProps} />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 p-4 border-t border-border shrink-0">
          <button
            type="button"
            onClick={onClose}
            className="h-14 rounded-xl bg-secondary text-secondary-foreground font-black"
          >
            閉じる
          </button>
          <button
            type="button"
            onClick={onPrint}
            className="h-14 rounded-xl bg-primary text-primary-foreground font-black"
          >
            🖨️ 印刷画面を開く
          </button>
        </div>
      </div>
    </div>
  );
}

function PrintableEstimate(props: EstimateDocumentProps) {
  return (
    <div id="quote-print-area" className="print-root print-area">
      <EstimateDocument {...props} />
    </div>
  );
}

interface EstimateDocumentProps {
  rows: StockRow[];
  recipient: string;
  issuer: string;
  notes: string;
  laborCost: string;
  otherCost: string;
  taxRate: string;
}

function EstimateDocument({
  rows,
  recipient,
  issuer,
  notes,
  laborCost,
  otherCost,
  taxRate,
}: EstimateDocumentProps) {
  const { laborCostNum, otherCostNum, taxRateNum, subtotals, subtotal, tax, total } =
    calculateQuoteTotals(rows, laborCost, otherCost, taxRate);
  const today = formatToday();

  return (
    <div className="estimate-document">
      <h3 className="invoice-title text-3xl font-bold text-center tracking-[0.4em] pb-2 border-b-2 border-black mb-6">
        御 見 積 書
      </h3>

      <div className="flex justify-between gap-6 mb-6">
        <div className="flex-1 min-w-0">
          <div className="text-lg font-bold border-b border-black pb-1 min-h-[2em] whitespace-pre-wrap break-words">
            {recipient || (
              <span className="text-gray-400 font-normal">（宛名を入力してください）</span>
            )}
          </div>
          <div className="text-xs mt-2 text-gray-700">下記の通り御見積申し上げます。</div>
        </div>

        <div className="flex-1 min-w-0 text-sm">
          <div className="text-right mb-2">発行日： {today}</div>
          <div className="border border-black p-3 min-h-[5em] whitespace-pre-wrap break-words leading-relaxed">
            {issuer || <span className="text-gray-400">（発行元情報を入力してください）</span>}
          </div>
        </div>
      </div>

      <div className="qt-total-box mb-6 px-4 py-3 flex items-center justify-between border-2 border-black bg-gray-100">
        <span className="text-base font-bold tracking-widest">御見積金額（税込）</span>
        <span className="text-2xl font-bold tabular-nums">{yen(total)} -</span>
      </div>

      <table className="qt-table w-full border-collapse text-sm mb-6">
        <thead>
          <tr>
            <th className="border border-black bg-gray-200 px-2 py-2 w-[46%] text-center">品目</th>
            <th className="border border-black bg-gray-200 px-2 py-2 w-[16%] text-center">数量</th>
            <th className="border border-black bg-gray-200 px-2 py-2 w-[19%] text-center">単価</th>
            <th className="border border-black bg-gray-200 px-2 py-2 w-[19%] text-center">金額</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={`${r.materialId}-${r.stockLength}`}>
              <td className="border border-black px-2 py-2">
                {r.materialName || "材料"}
                {r.materialSpecification ? `（${r.materialSpecification}）` : ""}／定尺材
                {r.stockLength.toLocaleString()}mm
              </td>
              <td className="border border-black px-2 py-2 text-right tabular-nums">
                {Number(r.qty) || 0} 本
              </td>
              <td className="border border-black px-2 py-2 text-right tabular-nums">
                {yen(Number(r.price) || 0)}
              </td>
              <td className="border border-black px-2 py-2 text-right tabular-nums">
                {yen(subtotals[i])}
              </td>
            </tr>
          ))}
          <tr>
            <td className="border border-black px-2 py-2">加工費・技術料</td>
            <td className="border border-black px-2 py-2 text-right">一式</td>
            <td className="border border-black px-2 py-2 text-right tabular-nums">
              {yen(laborCostNum)}
            </td>
            <td className="border border-black px-2 py-2 text-right tabular-nums">
              {yen(laborCostNum)}
            </td>
          </tr>
          <tr>
            <td className="border border-black px-2 py-2">その他経費（副資材・送料等）</td>
            <td className="border border-black px-2 py-2 text-right">一式</td>
            <td className="border border-black px-2 py-2 text-right tabular-nums">
              {yen(otherCostNum)}
            </td>
            <td className="border border-black px-2 py-2 text-right tabular-nums">
              {yen(otherCostNum)}
            </td>
          </tr>
        </tbody>
      </table>

      <div className="flex justify-end mb-6">
        <table className="qt-summary border-collapse text-sm w-full sm:w-[58%]">
          <tbody>
            <tr>
              <th className="border border-black bg-gray-100 px-3 py-2 text-right font-bold w-1/2">
                小計（税抜）
              </th>
              <td className="border border-black px-3 py-2 text-right tabular-nums">
                {yen(subtotal)}
              </td>
            </tr>
            <tr>
              <th className="border border-black bg-gray-100 px-3 py-2 text-right font-bold">
                消費税（{taxRateNum}%）
              </th>
              <td className="border border-black px-3 py-2 text-right tabular-nums">{yen(tax)}</td>
            </tr>
            <tr className="qt-grand">
              <th className="border-2 border-black bg-gray-200 px-3 py-3 text-right font-black text-base">
                合計金額（税込）
              </th>
              <td className="border-2 border-black bg-gray-200 px-3 py-3 text-right tabular-nums font-black text-lg">
                {yen(total)}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div>
        <div className="text-sm font-bold border-b border-black pb-1 mb-2">備考</div>
        <div className="text-sm whitespace-pre-wrap break-words min-h-[5em] leading-relaxed">
          {notes || <span className="text-gray-400">（備考を入力してください）</span>}
        </div>
      </div>
    </div>
  );
}

function QuoteModal({
  onClose,
  onPrint,
  rows,
  setRows,
  recipient,
  setRecipient,
  issuer,
  setIssuer,
  notes,
  setNotes,
  laborCost,
  setLaborCost,
  otherCost,
  setOtherCost,
  taxRate,
  setTaxRate,
}: {
  onClose: () => void;
  onPrint: () => void;
  rows: StockRow[];
  setRows: Dispatch<SetStateAction<StockRow[]>>;
  recipient: string;
  setRecipient: (v: string) => void;
  issuer: string;
  setIssuer: (v: string) => void;
  notes: string;
  setNotes: (v: string) => void;
  laborCost: string;
  setLaborCost: (v: string) => void;
  otherCost: string;
  setOtherCost: (v: string) => void;
  taxRate: string;
  setTaxRate: (v: string) => void;
}) {
  const updateRow = (i: number, key: "qty" | "price", v: string) =>
    setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, [key]: v } : r)));

  const { subtotals } = calculateQuoteTotals(rows, laborCost, otherCost, taxRate);

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="quote-modal-root fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/70 backdrop-blur-sm p-0 sm:p-4"
      onClick={onClose}
    >
      <div
        className="bg-card text-card-foreground w-full sm:max-w-2xl sm:rounded-2xl rounded-t-3xl max-h-[92vh] overflow-y-auto border border-border"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="no-print flex items-center justify-between px-5 py-4 border-b border-border sticky top-0 bg-card z-10">
          <h2 className="text-xl font-black">見積書</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="閉じる"
            className="h-12 w-12 rounded-xl bg-secondary text-secondary-foreground text-2xl font-bold"
          >
            ×
          </button>
        </div>

        {/* Input section (not printed) */}
        <div className="no-print p-5 pb-2 space-y-4 border-b border-border">
          <div className="grid grid-cols-1 gap-3">
            <label className="block">
              <span className="block text-sm font-bold text-muted-foreground mb-2">
                宛名（お客様名）
              </span>
              <input
                value={recipient}
                onChange={(e) => setRecipient(e.target.value)}
                placeholder="例: 株式会社〇〇 御中"
                className="w-full h-14 rounded-2xl bg-background border-2 border-border px-4 text-lg font-bold focus:border-primary focus:outline-none"
              />
            </label>
            <label className="block">
              <span className="block text-sm font-bold text-muted-foreground mb-2">
                発行元（自社名・氏名）
              </span>
              <textarea
                value={issuer}
                onChange={(e) => setIssuer(e.target.value)}
                placeholder={"例: 〇〇工房\n代表 山田 太郎\n〒000-0000 〇〇県〇〇市..."}
                rows={3}
                className="w-full rounded-2xl bg-background border-2 border-border px-4 py-3 text-base font-medium focus:border-primary focus:outline-none resize-y"
              />
            </label>
          </div>

          <div>
            <div className="text-sm font-bold text-muted-foreground mb-2">
              材料費（定尺材の種類ごとに入力）
            </div>
            <div className="space-y-3">
              {rows.map((r, i) => (
                <div
                  key={`${r.materialId}-${r.stockLength}`}
                  className="rounded-2xl border border-border bg-background p-3"
                >
                  <div className="mb-2">
                    <div className="text-sm font-bold text-muted-foreground truncate">
                      {r.materialName || "名称未設定の材料"}
                      {r.materialSpecification ? ` / ${r.materialSpecification}` : ""}
                    </div>
                    <div className="text-lg font-black tabular-nums mt-1">
                      {r.stockLength.toLocaleString()}mm 材
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <NumberInput
                      label="本数"
                      value={r.qty}
                      onChange={(v) => updateRow(i, "qty", v)}
                    />
                    <NumberInput
                      label="単価 (円)"
                      value={r.price}
                      onChange={(v) => updateRow(i, "price", v)}
                    />
                  </div>
                  <div className="mt-2 flex items-baseline justify-between">
                    <span className="text-xs font-bold text-muted-foreground">小計</span>
                    <span className="text-xl font-black tabular-nums text-primary">
                      {yen(subtotals[i])}
                    </span>
                  </div>
                </div>
              ))}
              {rows.length === 0 && (
                <div className="text-sm text-muted-foreground">使用する定尺材がありません。</div>
              )}
            </div>
          </div>

          <BigField label="加工費・技術料" unit="円" value={laborCost} onChange={setLaborCost} />
          <BigField
            label="その他経費（副資材・送料など）"
            unit="円"
            value={otherCost}
            onChange={setOtherCost}
          />
          <BigField label="消費税率" unit="%" value={taxRate} onChange={setTaxRate} />

          <label className="block">
            <span className="block text-sm font-bold text-muted-foreground mb-2">備考欄</span>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={4}
              className="w-full rounded-2xl bg-background border-2 border-border px-4 py-3 text-base font-medium focus:border-primary focus:outline-none resize-y"
            />
          </label>
        </div>

        <div className="no-print bg-white text-black p-6 sm:p-8">
          <EstimateDocument
            rows={rows}
            recipient={recipient}
            issuer={issuer}
            notes={notes}
            laborCost={laborCost}
            otherCost={otherCost}
            taxRate={taxRate}
          />
        </div>

        <div className="no-print p-5 pt-2 border-t border-border">
          <button
            type="button"
            onClick={onPrint}
            className="w-full h-16 rounded-2xl bg-primary text-primary-foreground text-lg font-black active:scale-[0.99]"
          >
            🖨️ 印刷する
          </button>
        </div>
      </div>
    </div>
  );
}
