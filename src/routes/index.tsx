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
import { MaterialPicker } from "@/components/material-picker";
import { CuttingOrderPdfDialog, PdfExportDialog } from "@/components/cutting-order-pdf-dialog";
import { cuttingOrderFilename, estimateFilename } from "@/lib/cutting-order-export";
import { formatJapaneseDate, localIsoDate, paginateEstimateRows } from "@/lib/estimate-document";
import {
  chooseRegisteredMaterial,
  findRegisteredMaterial,
  type RegisteredMaterial,
} from "@/lib/material-catalog";
import { emptyOffcutBank, readOffcutBank } from "@/lib/offcut-bank";
import {
  MATERIAL_CATALOG_KEY,
  readMaterialCatalog,
  saveRegisteredMaterial,
  withMaterialCatalogLock,
} from "@/lib/material-catalog-storage";
import {
  calculateStandardMaterial,
  hasLegacyInventoryConditions,
  isCurrentStandardCalculation,
  restoreStandardSnapshot,
} from "@/lib/standard-planning";
import {
  createDefaultAppSettings,
  createMaterialDefaults,
  readAppSettings,
  shouldShowSpreadsheetTools,
  validateAppSettings,
  writeAppSettings,
  type AppSettings,
} from "@/lib/app-settings";
import { useIsMobile } from "@/hooks/use-mobile";
import { colorFor, type CutResult } from "@/lib/cutting-stock";
import { buildCompactCuttingOrder, paginateCompactCuttingOrder } from "@/lib/cut-list";
import {
  decodeCsvBytes,
  parsePiecesCsv,
  parsePiecesRows,
  type PieceImportData,
  type PieceImportResult,
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

interface PieceImportDialogState {
  fileName: string;
  targetMaterialId: string;
  targetMaterialName: string;
  result: PieceImportResult;
}

type PrintDocumentKind = "estimate" | "cutting-order";

const defaultQuoteNotes =
  "・お見積有効期限：発行日より30日間\n・お支払条件：別途ご相談\n・上記金額には消費税を含みます。";

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

const isCompleteCalculationResult = (result: CutResult) =>
  result.unfittable.length === 0 && !(result.inventoryShortage?.pieces.length ?? 0);

const createMaterial = (
  id = `material-${Date.now()}-${uid()}`,
  settings = createDefaultAppSettings(),
): ProjectMaterial => ({
  id,
  planningMode: "standard",
  workId: `work-${Date.now()}-${uid()}`,
  name: "",
  specification: "",
  ...createMaterialDefaults(settings, uid),
  pieces: [{ id: uid(), name: "", length: "", qty: "1" }],
});

const createBlankSnapshot = (settings: AppSettings): ProjectSnapshot => ({
  version: PROJECT_STORAGE_VERSION,
  project: { name: "", activeProjectId: null, activeMaterialId: "primary-material" },
  materials: [createMaterial("primary-material", settings)],
  calculation: { materials: [] },
  estimate: {
    rows: [],
    recipient: "",
    issuer: settings.issuer,
    notes: defaultQuoteNotes,
    laborCost: "",
    otherCost: "",
    taxRate: "10",
    issuedOn: localIsoDate(),
  },
});

function Index() {
  const isMobileViewport = useIsMobile();
  const [materialCatalog, setMaterialCatalog] = useState<RegisteredMaterial[]>([]);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [legacyReadWarning, setLegacyReadWarning] = useState<string | null>(null);
  const [appSettings, setAppSettings] = useState(createDefaultAppSettings);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsNotice, setSettingsNotice] = useState<string | null>(null);
  const [projectName, setProjectName] = useState("");
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [materials, setMaterials] = useState<ProjectMaterial[]>(() => [
    createMaterial("primary-material"),
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
  const [laborCost, setLaborCost] = useState("");
  const [otherCost, setOtherCost] = useState("");
  const [taxRate, setTaxRate] = useState("10");
  const [issuedOn, setIssuedOn] = useState(localIsoDate);
  const [quoteOpen, setQuoteOpen] = useState(false);
  const [cuttingPreviewOpen, setCuttingPreviewOpen] = useState(false);
  const [quoteRows, setQuoteRows] = useState<StockRow[]>([]);
  const [recipient, setRecipient] = useState("");
  const [issuer, setIssuer] = useState("");
  const [notes, setNotes] = useState(defaultQuoteNotes);
  const [printPortalMounted, setPrintPortalMounted] = useState(false);
  const [printDocument, setPrintDocument] = useState<PrintDocumentKind | null>(null);
  const [materialImportDialog, setMaterialImportDialog] = useState<PieceImportDialogState | null>(
    null,
  );
  const [materialImportReading, setMaterialImportReading] = useState(false);
  const pieceImportFileInputRef = useRef<HTMLInputElement>(null);
  const showSpreadsheetTools = shouldShowSpreadsheetTools(
    appSettings.displayMode,
    isMobileViewport,
  );

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
  const legacyInventoryConditions = hasLegacyInventoryConditions(activeMaterial, activeCalculation);

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
    updateActiveMaterial((material) => ({
      ...material,
      name: value,
      catalogId: undefined,
    }));
  const setMaterialSpec = (value: string) =>
    updateActiveMaterial((material) => ({
      ...material,
      specification: value,
      catalogId: undefined,
    }));
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
  const setLastCalculatedInputKey = (value: string | null) =>
    updateActiveCalculation((calculation) => ({ ...calculation, inputKey: value }));

  const needsRecalculation =
    result !== null && !isCurrentStandardCalculation(activeMaterial, activeCalculation);
  const resultHasUnallocatedPieces = result ? !isCompleteCalculationResult(result) : false;

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
        issuedOn,
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
      issuedOn,
    ],
  );

  const restoreSnapshot = useCallback((original: ProjectSnapshot) => {
    let catalog: RegisteredMaterial[] = [];
    try {
      catalog = readMaterialCatalog(window.localStorage);
      setCatalogError(null);
    } catch (failure) {
      setCatalogError(
        failure instanceof Error
          ? failure.message
          : "材料一覧を読み込めません。手入力で計算できます。",
      );
    }
    setMaterialCatalog(catalog);
    let bank = emptyOffcutBank();
    setLegacyReadWarning(null);
    if (original.materials.some((material) => material.planningMode !== "standard")) {
      try {
        bank = readOffcutBank(window.localStorage);
      } catch {
        setLegacyReadWarning(
          "以前の在庫更新記録を読み込めません。案件の保存内容を表示しています。元データは変更せず、定尺の長さから再計算できます。",
        );
      }
    }
    const snapshot = restoreStandardSnapshot(original, catalog, bank);
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
    setIssuedOn(snapshot.estimate.issuedOn ?? localIsoDate());
    setError(null);
  }, []);

  useEffect(() => {
    setPrintPortalMounted(true);
    try {
      setMaterialCatalog(readMaterialCatalog(window.localStorage));
    } catch (failure) {
      setCatalogError(
        failure instanceof Error
          ? failure.message
          : "材料一覧を読み込めません。手入力で計算できます。",
      );
    }
    let initialSettings = createDefaultAppSettings();
    try {
      initialSettings = readAppSettings(window.localStorage);
      setAppSettings(initialSettings);
    } catch {
      setSettingsNotice("設定を読み込めなかったため、標準の刃厚で新規作成します。");
    }
    try {
      const draft = readDraft(window.localStorage);
      setSavedProjects(readProjects(window.localStorage));
      if (draft) {
        restoreSnapshot(draft);
      } else {
        setMaterials([createMaterial("primary-material", initialSettings)]);
        setIssuer(initialSettings.issuer);
      }
      setSaveStatus(draft ? "下書きを復元しました" : "下書き自動保存");
    } catch {
      setStorageError(
        "この端末の保存領域を利用できません。ブラウザや端末の設定を確認してください。",
      );
      setSaveStatus("保存できません");
    } finally {
      setStorageReady(true);
    }
  }, [restoreSnapshot]);

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

  useEffect(() => {
    const refresh = (event: StorageEvent) => {
      if (event.key !== MATERIAL_CATALOG_KEY && event.key !== null) return;
      try {
        setMaterialCatalog(readMaterialCatalog(window.localStorage));
        setCatalogError(null);
      } catch (failure) {
        setCatalogError(
          failure instanceof Error
            ? failure.message
            : "材料一覧を読み込めません。手入力で計算できます。",
        );
      }
    };
    window.addEventListener("storage", refresh);
    return () => window.removeEventListener("storage", refresh);
  }, []);

  const handleRegisterMaterial = async (
    name: string,
    specification: string,
  ): Promise<RegisteredMaterial> => {
    const catalog = await withMaterialCatalogLock(() =>
      saveRegisteredMaterial(window.localStorage, {
        id: `catalog-${Date.now()}-${uid()}`,
        name,
        specification,
      }),
    );
    setMaterialCatalog(catalog);
    setCatalogError(null);
    return findRegisteredMaterial(catalog, { name, specification })!;
  };

  const handleChooseMaterial = (selected: RegisteredMaterial) => {
    const next = chooseRegisteredMaterial(activeMaterial, selected);
    // Linking the exact same legacy pair is not a change to a cutting plan.
    if (
      activeCalculation?.inputKey === createCalculationInputKey(activeMaterial) &&
      !activeMaterial.catalogId &&
      activeMaterial.name.trim() === selected.name &&
      activeMaterial.specification.trim() === selected.specification
    ) {
      setLastCalculatedInputKey(createCalculationInputKey(next));
    }
    updateActiveMaterial((material) => chooseRegisteredMaterial(material, selected));
  };

  const handleSaveSettings = (settings: AppSettings): string | null => {
    try {
      const saved = writeAppSettings(window.localStorage, settings);
      setAppSettings(saved);
      setSettingsOpen(false);
      setSettingsNotice(
        "設定を保存しました。画面表示はすぐに、刃厚・自社情報は新しい案件・材料から適用します。",
      );
      return null;
    } catch {
      return "設定を保存できませんでした。端末の空き容量やブラウザの保存設定を確認してください。";
    }
  };

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
        const snapshot = createBlankSnapshot(appSettings);
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
    const source = restoreStandardSnapshot(snapshot, materialCatalog);
    snapshot.estimate = source.estimate;
    snapshot.materials = source.materials.map((material) => ({
      ...material,
      planningMode: "standard",
      workId: `work-${Date.now()}-${uid()}`,
      offcuts: [],
    }));
    snapshot.calculation.materials = source.calculation.materials.filter((calculation) => {
      const material = source.materials.find((item) => item.id === calculation.materialId)!;
      return isCurrentStandardCalculation(material, calculation);
    });
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
    const material = createMaterial(undefined, appSettings);
    setMaterials((previous) => [...previous, material]);
    setActiveMaterialId(material.id);
    setError(null);
    setQuoteOpen(false);
  };

  const handlePieceImportFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    const target = {
      targetMaterialId: activeMaterial.id,
      targetMaterialName: activeMaterial.name || "名称未設定の材料",
    };
    const lowerFileName = file.name.toLowerCase();
    const isCsv = lowerFileName.endsWith(".csv");
    const isExcel = lowerFileName.endsWith(".xlsx");
    if (!isCsv && !isExcel) {
      setMaterialImportDialog({
        fileName: file.name,
        ...target,
        result: { ok: false, errors: ["CSVまたはExcel（.xlsx）ファイルを選んでください。"] },
      });
      return;
    }
    if (file.size > maxImportFileSize) {
      setMaterialImportDialog({
        fileName: file.name,
        ...target,
        result: { ok: false, errors: ["取込ファイルは10MB以下にしてください。"] },
      });
      return;
    }

    setMaterialImportReading(true);
    try {
      const result = isCsv
        ? parsePiecesCsv(decodeCsvBytes(await file.arrayBuffer()))
        : parsePiecesRows(await (await import("read-excel-file/browser")).readSheet(file));
      setMaterialImportDialog({ fileName: file.name, ...target, result });
    } catch {
      setMaterialImportDialog({
        fileName: file.name,
        ...target,
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

  const handleApplyPieceImport = (data: PieceImportData, targetMaterialId: string) => {
    setMaterials((previous) =>
      previous.map((material) =>
        material.id === targetMaterialId ? { ...material, pieces: data.pieces } : material,
      ),
    );
    setCalculations((previous) =>
      previous.filter((calculation) => calculation.materialId !== targetMaterialId),
    );
    setQuoteRows((previous) => previous.filter((row) => row.materialId !== targetMaterialId));
    setActiveMaterialId(targetMaterialId);
    setQuoteOpen(false);
    setError(null);
    setMaterialImportDialog(null);
    setSaveStatus("Excelの切断寸法を取り込みました（下書き保存中）");
  };

  const handleDuplicateMaterial = () => {
    const material = createMaterial();
    material.name = activeMaterial.name;
    material.catalogId = activeMaterial.catalogId;
    material.specification = activeMaterial.specification;
    material.stocks = activeMaterial.stocks.map((stock) => ({ length: stock.length, id: uid() }));
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

  const updateStock = (id: string, key: "length", value: string) =>
    setStocks((prev) => prev.map((s) => (s.id === id ? { ...s, [key]: value } : s)));
  const addStock = () => setStocks((prev) => [...prev, { id: uid(), length: "" }]);
  const removeStock = (id: string) => setStocks((prev) => prev.filter((s) => s.id !== id));

  const handleCalc = () => {
    setError(null);
    let next: ReturnType<typeof calculateStandardMaterial>;
    try {
      next = calculateStandardMaterial(activeMaterial);
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "計算できませんでした。入力を確認してください。",
      );
      return;
    }
    updateActiveMaterial(() => next.material);
    updateActiveCalculation(() => next.calculation);
    const nextResult = next.calculation.result!;
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

  const allMaterialsHaveCurrentCalculations = materials.every((material) => {
    const calculation = calculations.find((candidate) => candidate.materialId === material.id);
    return isCurrentStandardCalculation(material, calculation);
  });
  const allMaterialsCalculated =
    allMaterialsHaveCurrentCalculations &&
    materials.every((material) => {
      const calculation = calculations.find((candidate) => candidate.materialId === material.id);
      return calculation?.result ? isCompleteCalculationResult(calculation.result) : false;
    });

  const pieceColorMap = useMemo(() => {
    const map = new Map<number, string>();
    pieces.forEach((_, i) => map.set(i, colorFor(i)));
    return map;
  }, [pieces]);

  const handlePrintDocument = (kind: PrintDocumentKind) => {
    const targets = kind === "estimate" ? materials : [activeMaterial];
    if (
      targets.some((material) => {
        const calculation = calculations.find((item) => item.materialId === material.id);
        return (
          !isCurrentStandardCalculation(material, calculation) ||
          !calculation?.result ||
          !isCompleteCalculationResult(calculation.result)
        );
      })
    ) {
      setCuttingPreviewOpen(false);
      setQuoteOpen(false);
      setError("印刷する前に再計算し、すべての部材が配置できていることを確認してください。");
      return;
    }
    setPrintDocument(kind);
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => window.print());
    });
  };

  return (
    <>
      <main className="app-screen min-h-screen bg-background text-foreground pb-32">
        <header className="px-5 pt-6 pb-4 border-b border-border sticky top-0 bg-background/95 backdrop-blur z-10">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h1 className="text-2xl font-black tracking-tight">カットマスタープロ</h1>
              <p className="text-xs text-muted-foreground mt-1">{saveStatus}</p>
            </div>
            <div className="flex gap-2 shrink-0">
              <button
                type="button"
                onClick={() => setSettingsOpen(true)}
                disabled={!storageReady}
                className="h-11 px-3 rounded-xl bg-secondary text-secondary-foreground text-sm font-bold disabled:opacity-40"
              >
                設定
              </button>
              <button
                type="button"
                onClick={() => setHistoryOpen(true)}
                className="h-11 px-4 rounded-xl bg-secondary text-secondary-foreground text-sm font-bold"
              >
                案件履歴 <span className="tabular-nums">{savedProjects.length}</span>
              </button>
            </div>
          </div>
        </header>

        <section className="px-5 pt-6 space-y-6">
          {(catalogError || legacyReadWarning) && (
            <p
              role="alert"
              className="rounded-xl border border-destructive p-3 text-sm text-destructive"
            >
              {catalogError || legacyReadWarning}
            </p>
          )}
          {settingsNotice && (
            <div
              role="status"
              className="flex items-center justify-between gap-3 rounded-xl border border-border bg-card p-3 text-sm"
            >
              <p>{settingsNotice}</p>
              <button
                type="button"
                aria-label="設定のお知らせを閉じる"
                onClick={() => setSettingsNotice(null)}
                className="h-11 w-11 shrink-0 rounded-xl bg-secondary text-xl font-bold"
              >
                ×
              </button>
            </div>
          )}
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

            <div className={`grid gap-2 ${showSpreadsheetTools ? "grid-cols-2" : "grid-cols-1"}`}>
              <button
                type="button"
                onClick={handleAddMaterial}
                className="h-12 rounded-xl bg-primary text-primary-foreground text-sm font-black"
              >
                ＋ 材料追加
              </button>
              {showSpreadsheetTools && (
                <>
                  <button
                    type="button"
                    onClick={() => pieceImportFileInputRef.current?.click()}
                    disabled={materialImportReading}
                    className="h-12 rounded-xl bg-secondary text-secondary-foreground text-sm font-black disabled:opacity-50"
                  >
                    {materialImportReading ? "読込中…" : "Excelから寸法取込"}
                  </button>
                  <input
                    ref={pieceImportFileInputRef}
                    type="file"
                    accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                    onChange={handlePieceImportFileChange}
                    className="hidden"
                    aria-label="取り込む切断寸法のCSVまたはExcelファイル"
                  />
                </>
              )}
            </div>
            {showSpreadsheetTools && (
              <div className="rounded-xl border border-primary/30 bg-primary/5 p-3">
                <a
                  href="/templates/cut-master-pro-input-template.xlsx"
                  download="cut-master-pro-input-template.xlsx"
                  className="flex h-12 items-center justify-center rounded-xl bg-primary px-4 text-center text-sm font-black text-primary-foreground"
                >
                  Excel部材テンプレートを保存
                </a>
                <p className="mt-2 text-center text-xs text-muted-foreground">
                  番号・切断寸法・本数だけ入力
                </p>
              </div>
            )}

            <div className="flex gap-2 overflow-x-auto pb-1" aria-label="材料切り替え">
              {materials.map((material, index) => {
                const calculation = calculations.find(
                  (candidate) => candidate.materialId === material.id,
                );
                const current = material.id === activeMaterial.id;
                const calculated = isCurrentStandardCalculation(material, calculation);
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
                      {index + 1}. {material.name || "材料未入力"}
                      {material.specification && ` ／ ${material.specification}`}
                    </span>
                    <span className="block text-[11px] text-muted-foreground mt-0.5">
                      {calculated ? "計算済み" : calculation?.result ? "再計算が必要" : "未計算"}
                    </span>
                  </button>
                );
              })}
            </div>

            <MaterialPicker
              key={activeMaterial.id}
              catalog={materialCatalog}
              selectedId={activeMaterial.catalogId}
              name={materialName}
              specification={materialSpec}
              disabled={Boolean(catalogError)}
              onChoose={handleChooseMaterial}
              onRegister={handleRegisterMaterial}
              onManual={() =>
                updateActiveMaterial((material) => ({
                  ...material,
                  catalogId: undefined,
                }))
              }
            />
            {(!activeMaterial.catalogId || catalogError) && (
              <fieldset className="grid grid-cols-1 sm:grid-cols-2 gap-3">
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
              </fieldset>
            )}
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
          <fieldset className="min-w-0 space-y-6">
            {/* Stocks list */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h2 className="text-lg font-bold">使用する定尺材</h2>
                <span className="text-xs text-muted-foreground">長さを入力</span>
              </div>
              <p className="text-xs leading-relaxed text-muted-foreground">
                購入できる定尺材の長さを入力すると、必要な総本数を計算します。本数に限りのある端材は入力しないでください。
              </p>
              <div className="space-y-3">
                {stocks.map((s) => (
                  <div key={s.id} className="rounded-2xl border border-border bg-card p-3">
                    <div className="grid gap-2 items-end grid-cols-[minmax(0,1fr)_auto]">
                      <NumberInput
                        label="定尺材の長さ (mm)"
                        value={s.length}
                        onChange={(v) => updateStock(s.id, "length", v)}
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
          </fieldset>

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

          {(needsRecalculation || legacyInventoryConditions) && (
            <div
              role="status"
              className="rounded-2xl border-2 border-amber-500 bg-amber-500/15 p-4"
            >
              <div className="font-black text-amber-500">
                {legacyInventoryConditions
                  ? "以前の在庫条件を含む案件です"
                  : "計算条件が変更されています"}
              </div>
              <p className="text-sm text-muted-foreground mt-1">
                {legacyInventoryConditions
                  ? "保存した結果は残しています。再計算すると、入力した定尺の長さだけで必要本数を計算します。在庫の更新は行いません。"
                  : "下の結果は変更前の内容です。「再計算する」を押して更新してください。"}
              </p>
            </div>
          )}

          {result && (
            <>
              <ResultView
                result={result}
                pieceColorMap={pieceColorMap}
                materialLabel={
                  [materialName, materialSpec].filter(Boolean).join(" ／ ") ||
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
                  disabled={needsRecalculation || resultHasUnallocatedPieces}
                  className="w-full h-16 rounded-2xl bg-secondary text-secondary-foreground text-lg font-black active:scale-[0.99] transition-transform disabled:opacity-40"
                >
                  {needsRecalculation
                    ? "再計算すると切断順を印刷できます"
                    : resultHasUnallocatedPieces
                      ? "不足を解消すると切断順を印刷できます"
                      : "🖨️ 切断作業表（印刷・PDF）"}
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
                  : allMaterialsHaveCurrentCalculations
                    ? "不足を解消すると見積できます"
                    : "すべての材料を計算すると見積できます"}
              </button>
            </>
          )}
        </section>
        {result && quoteOpen && (
          <QuoteModal
            onClose={() => setQuoteOpen(false)}
            onPrint={() => handlePrintDocument("estimate")}
            projectName={projectName}
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
            issuedOn={issuedOn}
            setIssuedOn={setIssuedOn}
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
        {settingsOpen && (
          <AppSettingsDialog
            settings={appSettings}
            onSave={handleSaveSettings}
            onClose={() => setSettingsOpen(false)}
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
          <PieceImportDialog
            state={materialImportDialog}
            onCancel={() => setMaterialImportDialog(null)}
            onApply={handleApplyPieceImport}
          />
        )}
      </main>
      {result &&
        printPortalMounted &&
        printDocument === "estimate" &&
        createPortal(
          <PrintableEstimate
            projectName={projectName}
            rows={displayQuoteRows}
            recipient={recipient}
            issuer={issuer}
            notes={notes}
            laborCost={laborCost}
            otherCost={otherCost}
            taxRate={taxRate}
            issuedOn={issuedOn}
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

function AppSettingsDialog({
  settings,
  onSave,
  onClose,
}: {
  settings: AppSettings;
  onSave: (settings: AppSettings) => string | null;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [kerf, setKerf] = useState(settings.kerf);
  const [issuer, setIssuer] = useState(settings.issuer);
  const [displayMode, setDisplayMode] = useState(settings.displayMode);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);

  const handleSave = () => {
    const parsed = validateAppSettings({
      version: 1,
      kerf,
      issuer,
      displayMode,
    });
    setError(parsed.ok ? onSave(parsed.settings) : parsed.error);
  };

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="app-settings-title"
      onCancel={onClose}
      className="m-auto max-h-[90dvh] w-[calc(100%_-_2rem)] max-w-lg overflow-y-auto rounded-3xl border border-border bg-card p-0 text-foreground shadow-2xl backdrop:bg-black/75"
    >
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          handleSave();
        }}
      >
        <div className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-border bg-card p-4">
          <h2 id="app-settings-title" className="text-xl font-black">
            よく使う設定
          </h2>
          <button
            type="button"
            aria-label="設定を閉じる"
            onClick={onClose}
            className="h-11 w-11 rounded-xl bg-secondary text-xl font-bold"
          >
            ×
          </button>
        </div>
        <div className="space-y-5 p-4">
          <p className="text-sm leading-relaxed text-muted-foreground">
            刃厚は新しい案件や材料の初期値、自社情報は新しい案件の見積に使います。定尺は材料ごとに入力してください。作業中・保存済みの案件や複製元の内容は変わりません。
          </p>
          <fieldset>
            <legend className="mb-2 block text-sm font-bold">画面表示</legend>
            <div className="grid grid-cols-3 gap-2" role="group" aria-label="画面表示を選択">
              {(
                [
                  ["auto", "自動"],
                  ["mobile", "スマホ"],
                  ["desktop", "PC"],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={displayMode === value}
                  onClick={() => setDisplayMode(value)}
                  className={`h-12 rounded-xl border-2 text-sm font-black ${
                    displayMode === value
                      ? "border-primary bg-primary/15 text-primary"
                      : "border-border bg-background text-foreground"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
              {displayMode === "auto" &&
                "おすすめ。画面幅で自動判定し、スマホではExcel・CSV機能を隠します。"}
              {displayMode === "mobile" &&
                "Excel・CSV機能を隠します。計算・案件保存・PDFはそのまま使えます。"}
              {displayMode === "desktop" &&
                "Excel・CSV機能を表示します。スマホから必要なときにも選べます。"}
            </p>
          </fieldset>
          <NumberInput
            label="よく使う刃厚 (mm)"
            value={kerf}
            onChange={setKerf}
            placeholder="例: 3.2"
            inputMode="decimal"
          />
          <label className="block">
            <span className="mb-2 block text-sm font-bold">自社情報（見積の発行元）</span>
            <textarea
              value={issuer}
              onChange={(event) => setIssuer(event.target.value)}
              rows={4}
              placeholder={"会社名・氏名\n住所・電話番号など（空欄でも保存できます）"}
              className="w-full rounded-xl border-2 border-border bg-background p-3 text-base focus:border-primary focus:outline-none"
            />
          </label>
          <p className="text-xs leading-relaxed text-muted-foreground">
            この端末・ブラウザに保存します。在庫本数や案件ごとの単価は引き継ぎません。
          </p>
        </div>
        <div className="sticky bottom-0 space-y-3 border-t border-border bg-card p-4">
          {error && (
            <p
              role="alert"
              className="rounded-xl border border-destructive bg-destructive/10 p-3 text-sm font-bold text-destructive"
            >
              {error}
            </p>
          )}
          <div className="grid grid-cols-2 gap-3">
            <button
              type="button"
              onClick={onClose}
              className="h-14 rounded-xl bg-secondary font-bold"
            >
              キャンセル
            </button>
            <button
              type="submit"
              className="h-14 rounded-xl bg-primary font-black text-primary-foreground"
            >
              設定を保存
            </button>
          </div>
        </div>
      </form>
    </dialog>
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
                    .map((material, index) =>
                      [material.name || `材料${index + 1}`, material.specification]
                        .filter(Boolean)
                        .join(" ／ "),
                    )
                    .join("、") || "材料未設定"}
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

function PieceImportDialog({
  state,
  onCancel,
  onApply,
}: {
  state: PieceImportDialogState;
  onCancel: () => void;
  onApply: (data: PieceImportData, targetMaterialId: string) => void;
}) {
  const importData = state.result.ok ? state.result.data : null;
  const importErrors = state.result.ok ? [] : state.result.errors;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="piece-import-title"
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/75 p-5"
    >
      <div className="w-full max-w-md max-h-[85vh] overflow-y-auto rounded-3xl border border-border bg-card p-5 shadow-2xl">
        <h2 id="piece-import-title" className="text-xl font-black">
          {importData ? "Excelの切断寸法を確認" : "Excelの切断寸法を取り込めません"}
        </h2>
        <p className="mt-1 text-xs text-muted-foreground break-all">{state.fileName}</p>
        <p className="mt-1 text-xs text-muted-foreground">取込先: {state.targetMaterialName}</p>
        {importData && state.fileName.toLowerCase().endsWith(".xlsx") && (
          <p className="mt-1 text-xs text-muted-foreground">Excelの先頭シートを読み込みました</p>
        )}

        {importData ? (
          <>
            <div className="mt-4 rounded-2xl bg-primary/10 border border-primary/40 p-4">
              <div className="text-sm font-black">
                {importData.sourceRowCount}行・合計
                {importData.pieces.reduce((sum, piece) => sum + Number(piece.qty), 0)}
                本を取り込みます
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                材料名・規格名・定尺・刃厚は変更しません。
              </p>
            </div>
            <div className="mt-4 max-h-56 space-y-2 overflow-y-auto pr-1">
              {importData.pieces.slice(0, 30).map((piece, index) => (
                <div
                  key={piece.id}
                  className="grid grid-cols-[2rem_minmax(0,1fr)_auto] items-center gap-2 rounded-xl border border-border p-3"
                >
                  <span className="text-xs text-muted-foreground">{index + 1}</span>
                  <div className="min-w-0">
                    <div className="font-black tabular-nums">
                      {Number(piece.length).toLocaleString()}mm × {piece.qty}本
                    </div>
                    <div className="truncate text-xs text-muted-foreground">
                      {piece.name || "パイプ番号・部材名は空欄"}
                    </div>
                  </div>
                  <span aria-hidden="true" className="text-primary">
                    ✓
                  </span>
                </div>
              ))}
              {importData.pieces.length > 30 && (
                <p className="py-2 text-center text-xs text-muted-foreground">
                  ほか {importData.pieces.length - 30}行
                </p>
              )}
            </div>
            <div className="mt-4 rounded-xl border border-amber-500 bg-amber-500/15 p-3">
              <div className="text-sm font-black text-amber-500">
                現在の切断寸法一覧を置き換えます
              </div>
              <p className="text-xs leading-relaxed text-muted-foreground mt-1">
                選択中の材料にある部材と計算結果だけが置き換わります。ほかの材料や保存済み案件は変更されません。
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
                onClick={() => onApply(importData, state.targetMaterialId)}
                className="h-14 rounded-2xl bg-primary text-primary-foreground font-black"
              >
                切断寸法を置き換える
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
            </div>
            <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
              「Excel部材テンプレート」と同じ列名にしてください。切断寸法は必須、パイプ番号・部材名と本数は空欄でも取り込めます。
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
  inputMode = "numeric",
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  inputMode?: "numeric" | "decimal";
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
        inputMode={inputMode}
        pattern={inputMode === "decimal" ? "[0-9.]*" : "[0-9]*"}
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
  const hasInventoryShortage = Boolean(result.inventoryShortage?.pieces.length);
  const showsInventoryBreakdown = result.stockUsage.some(
    (usage) => usage.inventoryCount !== undefined,
  );
  const totalInventoryUsed = result.stockUsage.reduce(
    (sum, usage) => sum + (usage.inventoryCount ?? 0),
    0,
  );
  const totalPurchaseCount = result.stockUsage.reduce(
    (sum, usage) => sum + (usage.purchaseCount ?? 0),
    0,
  );
  const totalOffcutCount = result.stockUsage.reduce(
    (sum, usage) => sum + (usage.offcutCount ?? 0),
    0,
  );
  return (
    <section className="space-y-5 pt-2">
      <div>
        <h2 className="text-xl font-black">計算結果</h2>
        <p className="text-sm text-muted-foreground mt-1">{materialLabel}</p>
      </div>

      {result.stockUsage.length > 0 && (
        <div className="rounded-2xl border-2 border-primary/50 bg-primary/10 p-4">
          <div className="text-xs font-bold text-muted-foreground mb-2">
            {showsInventoryBreakdown
              ? "保存時の材料内訳（以前の在庫条件）"
              : "必要な定尺材（総本数）"}
          </div>
          <div className="space-y-1">
            {result.stockUsage.map((u) => (
              <div
                key={u.stockLength}
                className="flex items-baseline justify-between text-base font-bold"
              >
                <span>
                  <span className="block tabular-nums">{u.stockLength.toLocaleString()}mm 材</span>
                  {u.availableCount !== undefined && (
                    <span className="block text-xs font-bold text-muted-foreground">
                      計算時の手持ち定尺 {u.availableCount}本
                    </span>
                  )}
                </span>
                {showsInventoryBreakdown ? (
                  <span className="text-right tabular-nums">
                    {!!u.offcutCount && (
                      <span className="block text-base text-accent">
                        端材から使用 {u.offcutCount}本
                      </span>
                    )}
                    <span className="block text-base">
                      手持ち定尺から使用 {u.inventoryCount ?? 0}本
                    </span>
                    <span className="block text-lg text-primary">
                      追加購入 {u.purchaseCount ?? 0}本
                    </span>
                  </span>
                ) : (
                  <span className="tabular-nums text-2xl text-primary">
                    <span className="text-sm mr-1">使用</span>
                    {u.count}
                    <span className="text-sm ml-1">本</span>
                  </span>
                )}
              </div>
            ))}
            <div className="flex items-baseline justify-between pt-2 mt-2 border-t border-border text-sm font-bold text-muted-foreground">
              <span>合計</span>
              <span className="tabular-nums">{result.totalStock} 本</span>
            </div>
            {showsInventoryBreakdown && (
              <p className="text-right text-sm font-bold tabular-nums">
                端材 {totalOffcutCount}本 / 手持ち定尺 {totalInventoryUsed}本 / 追加購入{" "}
                {totalPurchaseCount}本
              </p>
            )}
          </div>
          {!showsInventoryBreakdown && (
            <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
              必要な総本数です。同じ材料・規格・長さの手持ち分は、ご自身で差し引いて購入してください。
            </p>
          )}
        </div>
      )}

      {showsInventoryBreakdown && !hasInventoryShortage && result.unfittable.length === 0 && (
        <div className="rounded-2xl border border-accent/50 bg-accent/10 p-4">
          <strong className="block font-black">
            {totalPurchaseCount > 0
              ? `保存時の計画：追加購入 ${totalPurchaseCount}本`
              : "保存時の計画：手持ち在庫を使用"}
          </strong>
          <p className="text-sm text-muted-foreground mt-1">
            以前の在庫条件で計算した結果です。印刷・見積の前に、定尺の長さを確認して再計算してください。
          </p>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3">
        <Stat
          label={hasInventoryShortage ? "手持ち分の歩留まり" : "歩留まり率"}
          value={yieldPct}
          unit="%"
          highlight
        />
        <Stat
          label={hasInventoryShortage ? "手持ち分の端材" : "端材合計"}
          value={result.totalWaste.toLocaleString()}
          unit="mm"
        />
        <Stat
          label={hasInventoryShortage ? "配置済み長さ" : "必要長さ合計"}
          value={result.totalRequiredLength.toLocaleString()}
          unit="mm"
        />
        <Stat
          label={hasInventoryShortage ? "使用した定尺長さ" : "定尺材長さ合計"}
          value={result.totalStockLength.toLocaleString()}
          unit="mm"
        />
      </div>

      {result.unfittable.length > 0 && (
        <div className="rounded-xl bg-destructive/20 border border-destructive p-3 text-sm">
          <strong className="block font-bold mb-1">配置不可な部材があります</strong>
          {result.unfittable.map((u, i) => (
            <div key={i}>
              長さ {u.length}mm × {u.qty}本 を配置できません。定尺材の長さを確認してください。
            </div>
          ))}
        </div>
      )}

      {result.inventoryShortage && result.inventoryShortage.pieces.length > 0 && (
        <div className="rounded-2xl border-2 border-amber-500 bg-amber-500/15 p-4 space-y-3">
          <div>
            <strong className="block text-lg font-black text-amber-500">
              保存時に配置できなかった部材があります
            </strong>
            <p className="text-sm text-muted-foreground mt-1">
              以前の在庫条件での不足です。定尺の長さを確認して再計算してください。
            </p>
          </div>
          <div className="rounded-xl bg-background/70 border border-amber-500/50 p-3 space-y-1">
            <div className="text-xs font-bold text-muted-foreground">保存時の追加本数の目安</div>
            {result.inventoryShortage.suggestedStock.map((stock) => (
              <div
                key={stock.stockLength}
                className="flex items-baseline justify-between font-black"
              >
                <span className="tabular-nums">{stock.stockLength.toLocaleString()}mm 材</span>
                <span className="text-xl text-amber-500">
                  あと {stock.count}
                  <span className="text-sm ml-1">本</span>
                </span>
              </div>
            ))}
          </div>
          <div className="text-sm">
            <div className="text-xs font-bold text-muted-foreground mb-1">まだ配置できない部材</div>
            {result.inventoryShortage.pieces.map((piece, index) => (
              <div key={`${piece.length}-${piece.label ?? ""}-${index}`}>
                {piece.label ? `${piece.label}・` : ""}
                <span className="tabular-nums">
                  {piece.length.toLocaleString()}mm × {piece.qty}本
                </span>
              </div>
            ))}
          </div>
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
            showSource={showsInventoryBreakdown}
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
  showSource = false,
}: {
  index: number;
  bar: CutResult["bars"][number];
  maxStock: number;
  colorMap: Map<number, string>;
  showSource?: boolean;
}) {
  const containerWidthPct = (bar.stockLength / maxStock) * 100;
  return (
    <div className="rounded-2xl bg-card border border-border p-3">
      <div className="flex items-center justify-between mb-2 gap-2 flex-wrap">
        <div className="text-sm font-bold">
          #{index + 1}・<span className="tabular-nums">{bar.stockLength.toLocaleString()}mm</span>{" "}
          材
          {showSource && (
            <span className="ml-2 rounded bg-secondary px-2 py-0.5 text-xs">
              {bar.source === "offcut" ? "端材" : bar.source === "inventory" ? "手持ち" : "購入"}
            </span>
          )}
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
  const cuttingOrder = buildCompactCuttingOrder(result, material.pieces);
  const printPages = paginateCompactCuttingOrder(cuttingOrder);
  const showsInventoryBreakdown = result.stockUsage.some(
    (usage) => usage.inventoryCount !== undefined,
  );
  const totalCutCount = cuttingOrder.reduce(
    (total, bar) => total + bar.groups.reduce((barTotal, group) => barTotal + group.quantity, 0),
    0,
  );
  const stockSummary = result.stockUsage
    .map((usage) => {
      if (!showsInventoryBreakdown)
        return `${usage.stockLength.toLocaleString()}mm × ${usage.count}本`;
      const sources = [
        usage.offcutCount ? `端材${usage.offcutCount}本` : "",
        usage.inventoryCount ? `手持ち${usage.inventoryCount}本` : "",
        usage.purchaseCount ? `購入${usage.purchaseCount}本` : "",
      ]
        .filter(Boolean)
        .join("・");
      return `${usage.stockLength.toLocaleString()}mm ${sources}`;
    })
    .join(" / ");
  const materialNameDisplay = material.name.trim() || "名称未設定の材料";
  const specificationDisplay = material.specification.trim() || "—";
  const materialDisplayName = `${materialNameDisplay}${
    material.specification.trim() ? ` / ${material.specification.trim()}` : ""
  }`;

  return (
    <div className="cut-list-content bg-white text-black">
      {printPages.map((page, pageIndex) => (
        <section key={page[0]?.barNumber ?? `empty-${pageIndex}`} className="cut-list-page-sheet">
          {pageIndex === 0 ? (
            <>
              <div className="cut-list-heading relative">
                <h2 className="cut-list-title text-2xl font-black text-center mb-3">
                  切 断 作 業 表
                </h2>
                <span className="cut-list-page-number absolute right-0 top-0 font-bold">
                  {pageIndex + 1} / {printPages.length}
                </span>
              </div>

              <div className="cut-list-meta grid grid-cols-2 border border-black mb-2">
                <div className="grid grid-cols-[7rem_1fr] border-r border-b border-black">
                  <span className="bg-gray-100">案件名</span>
                  <strong className="min-w-0 break-words">
                    {projectName.trim() || "名称未設定の案件"}
                  </strong>
                </div>
                <div className="grid grid-cols-[7rem_1fr] border-b border-black">
                  <span className="bg-gray-100">材料・規格</span>
                  <strong className="min-w-0 break-words">{materialDisplayName}</strong>
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

              <div className="cut-list-summary grid grid-cols-[2fr_1fr_1fr_0.8fr] border border-black mb-2">
                <div className="flex flex-col border-r border-black">
                  <span className="bg-gray-100">使用する定尺材</span>
                  <strong>{stockSummary || "なし"}</strong>
                </div>
                <div className="flex flex-col border-r border-black">
                  <span className="bg-gray-100">必要長さ合計</span>
                  <strong>{result.totalRequiredLength.toLocaleString()}mm</strong>
                </div>
                <div className="flex flex-col border-r border-black">
                  <span className="bg-gray-100">端材合計</span>
                  <strong>{result.totalWaste.toLocaleString()}mm</strong>
                </div>
                <div className="flex flex-col">
                  <span className="bg-gray-100">切断総数</span>
                  <strong>{totalCutCount.toLocaleString()}本</strong>
                </div>
              </div>
            </>
          ) : (
            <div className="cut-list-continuation-header flex items-center justify-between border-b border-black">
              <div className="cut-list-continuation-details min-w-0">
                <span>
                  <strong>材料名：</strong>
                  {materialNameDisplay}
                </span>
                <span>
                  <strong>規格名：</strong>
                  {specificationDisplay}
                </span>
              </div>
              <strong className="shrink-0">
                {pageIndex + 1} / {printPages.length}
              </strong>
            </div>
          )}

          <div className="cut-card-grid grid grid-cols-4 gap-2">
            {page.map((bar) => (
              <section
                key={bar.barNumber}
                className="cut-card overflow-hidden rounded-md border border-black"
              >
                <div className="cut-card-header flex items-center justify-between gap-1 border-b border-black bg-slate-200 px-1.5 py-1">
                  <strong>
                    {showsInventoryBreakdown
                      ? bar.source === "offcut"
                        ? "端材"
                        : bar.source === "inventory"
                          ? "手持ち"
                          : "購入"
                      : "定尺"}{" "}
                    #{bar.barNumber}・{bar.stockLength.toLocaleString()}mm
                  </strong>
                  <span className="whitespace-nowrap text-xs font-bold">
                    端材 {bar.waste.toLocaleString()}mm
                  </span>
                </div>

                <div className="cut-card-body">
                  {bar.groups.map((group, groupIndex) => (
                    <div
                      key={`${bar.barNumber}-${group.length}-${group.label}-${groupIndex}`}
                      className="cut-card-row grid grid-cols-[4.7rem_minmax(0,1fr)_auto] items-center gap-1 border-b border-black px-1.5 py-1 last:border-b-0"
                    >
                      <strong className="cut-card-length text-right text-base tabular-nums">
                        {group.length.toLocaleString()}
                        <small className="ml-0.5 text-[0.65em] font-bold">mm</small>
                      </strong>
                      <span className="cut-card-label min-w-0 break-words font-bold">
                        {group.label}
                      </span>
                      <span
                        className="cut-card-checks flex max-w-28 flex-wrap items-center justify-end gap-1"
                        aria-label={`${group.quantity}本分の確認欄`}
                      >
                        <strong className="cut-card-quantity mr-0.5 text-xs">
                          ×{group.quantity}
                        </strong>
                        {Array.from({ length: group.quantity }, (_, checkboxIndex) => (
                          <span
                            key={checkboxIndex}
                            aria-hidden="true"
                            className="cut-card-box inline-block h-4 w-4 shrink-0 border border-black bg-white"
                          />
                        ))}
                      </span>
                    </div>
                  ))}
                </div>
              </section>
            ))}
          </div>
        </section>
      ))}
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
  const documentRef = useRef<HTMLDivElement>(null);
  const [pdfSource, setPdfSource] = useState<HTMLElement | null>(null);
  const [pdfFilename, setPdfFilename] = useState("");
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="切断順プレビュー"
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/75 backdrop-blur-sm p-0 sm:p-4"
      onClick={() => {
        if (!pdfSource) onClose();
      }}
    >
      <div
        className="bg-card text-card-foreground w-full sm:max-w-[96vw] sm:rounded-2xl rounded-t-3xl max-h-[94vh] overflow-hidden border border-border flex flex-col"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 px-5 py-4 border-b border-border shrink-0">
          <div>
            <h2 className="text-xl font-black">切断順プレビュー</h2>
            <p className="text-xs text-muted-foreground mt-1">
              A4横・4列です。定尺カードは左上から右へ進みます。
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
          <div
            ref={documentRef}
            className="min-w-[1000px] max-w-[297mm] mx-auto bg-white p-5 sm:p-6 shadow-xl"
          >
            <CuttingOrderDocument {...documentProps} />
          </div>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 p-4 border-t border-border shrink-0">
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
          <button
            type="button"
            onClick={() => {
              if (!documentRef.current) return;
              setPdfFilename(
                cuttingOrderFilename(
                  documentProps.projectName,
                  documentProps.material.name,
                  documentProps.material.specification,
                ),
              );
              setPdfSource(documentRef.current);
            }}
            className="col-span-2 sm:col-span-1 h-14 rounded-xl bg-accent text-accent-foreground font-black"
          >
            PDF保存・共有
          </button>
        </div>
      </div>
      {pdfSource && (
        <CuttingOrderPdfDialog
          source={pdfSource}
          filename={pdfFilename}
          onClose={() => setPdfSource(null)}
        />
      )}
    </div>
  );
}

function PrintableEstimate(props: EstimateDocumentProps) {
  return (
    <div id="quote-print-area" className="print-root">
      <EstimateDocument {...props} />
    </div>
  );
}

interface EstimateDocumentProps {
  projectName: string;
  rows: StockRow[];
  recipient: string;
  issuer: string;
  notes: string;
  laborCost: string;
  otherCost: string;
  taxRate: string;
  issuedOn: string;
}

function EstimateDocument({
  projectName,
  rows,
  recipient,
  issuer,
  notes,
  laborCost,
  otherCost,
  taxRate,
  issuedOn,
}: EstimateDocumentProps) {
  const { laborCostNum, otherCostNum, taxRateNum, subtotals, subtotal, tax, total } =
    calculateQuoteTotals(rows, laborCost, otherCost, taxRate);
  const pages = paginateEstimateRows(rows.length);
  const displayDate = formatJapaneseDate(issuedOn);

  return (
    <div className="estimate-document">
      {pages.map((page, pageIndex) => (
        <section className="estimate-page-sheet" key={pageIndex}>
          {page.isFirst ? (
            <>
              <div className="estimate-topline">
                <div className="estimate-brand">CUT MASTER PRO</div>
                <div className="estimate-date">
                  <span className="estimate-label">発行日</span>
                  <strong>{displayDate}</strong>
                </div>
              </div>
              <h3 className="estimate-title">御見積書</h3>
              <div className="estimate-parties">
                <div className="estimate-recipient">
                  <span className="estimate-label">お客様</span>
                  <strong>
                    {recipient || <span className="estimate-placeholder">宛名未入力</span>}
                  </strong>
                  <p className="estimate-message">下記の通り御見積申し上げます。</p>
                </div>
                <div className="estimate-issuer">
                  <span className="estimate-label">発行元</span>
                  <strong>
                    {issuer || <span className="estimate-placeholder">発行元未入力</span>}
                  </strong>
                </div>
              </div>
              <div className="estimate-project">
                <span className="estimate-label">案件名</span>
                <strong>
                  {projectName || <span className="estimate-placeholder">案件名未入力</span>}
                </strong>
              </div>
              <div className="estimate-total-hero">
                <span>御見積金額（税込）</span>
                <strong className="estimate-money">{yen(total)}</strong>
              </div>
            </>
          ) : (
            <div className="estimate-continuation-header">
              <div>
                <span className="estimate-brand">CUT MASTER PRO</span>
                <strong>御見積書（明細続き）</strong>
              </div>
              <div className="estimate-continuation-meta">
                <div>{projectName || "案件名未入力"}</div>
                <div>{displayDate}</div>
              </div>
            </div>
          )}

          <h4 className="estimate-section-title">明細</h4>
          <table className="estimate-table">
            <colgroup>
              <col style={{ width: "48%" }} />
              <col style={{ width: "14%" }} />
              <col style={{ width: "19%" }} />
              <col style={{ width: "19%" }} />
            </colgroup>
            <thead>
              <tr>
                <th>品目</th>
                <th>数量</th>
                <th>単価</th>
                <th>金額</th>
              </tr>
            </thead>
            <tbody>
              {page.rowIndexes.map((rowIndex) => {
                const row = rows[rowIndex]!;
                return (
                  <tr key={`${row.materialId}-${row.stockLength}`}>
                    <td>
                      <span className="estimate-item-name">{row.materialName || "材料"}</span>
                      <span className="estimate-item-detail">
                        {[row.materialSpecification, `定尺 ${row.stockLength.toLocaleString()}mm`]
                          .filter(Boolean)
                          .join(" ／ ")}
                      </span>
                    </td>
                    <td className="estimate-money">{Number(row.qty) || 0} 本</td>
                    <td className="estimate-money">{yen(Number(row.price) || 0)}</td>
                    <td className="estimate-money">{yen(subtotals[rowIndex])}</td>
                  </tr>
                );
              })}
              {page.isFinal && (
                <>
                  <tr>
                    <td>
                      <span className="estimate-item-name">加工費・技術料</span>
                    </td>
                    <td>一式</td>
                    <td className="estimate-money">{yen(laborCostNum)}</td>
                    <td className="estimate-money">{yen(laborCostNum)}</td>
                  </tr>
                  <tr>
                    <td>
                      <span className="estimate-item-name">その他経費</span>
                    </td>
                    <td>一式</td>
                    <td className="estimate-money">{yen(otherCostNum)}</td>
                    <td className="estimate-money">{yen(otherCostNum)}</td>
                  </tr>
                </>
              )}
            </tbody>
          </table>

          {!page.isFinal && <p className="estimate-continued">明細は次ページへ続きます。</p>}
          {page.isFinal && (
            <>
              <div className="estimate-summary-wrap">
                <table className="estimate-summary">
                  <tbody>
                    <tr>
                      <th>小計（税抜）</th>
                      <td className="estimate-money">{yen(subtotal)}</td>
                    </tr>
                    <tr>
                      <th>消費税（{taxRateNum}%）</th>
                      <td className="estimate-money">{yen(tax)}</td>
                    </tr>
                    <tr className="estimate-grand">
                      <th>合計金額（税込）</th>
                      <td className="estimate-money">{yen(total)}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <div className="estimate-notes">
                <div className="estimate-section-title">備考</div>
                <div className="estimate-notes-content">
                  {notes || <span className="estimate-placeholder">備考未入力</span>}
                </div>
              </div>
            </>
          )}
          <div className="estimate-page-number">
            {pageIndex + 1} / {pages.length}
          </div>
        </section>
      ))}
    </div>
  );
}

function QuoteModal({
  onClose,
  onPrint,
  projectName,
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
  issuedOn,
  setIssuedOn,
}: {
  onClose: () => void;
  onPrint: () => void;
  projectName: string;
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
  issuedOn: string;
  setIssuedOn: (v: string) => void;
}) {
  const updateRow = (i: number, key: "qty" | "price", v: string) =>
    setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, [key]: v } : r)));

  const { subtotals } = calculateQuoteTotals(rows, laborCost, otherCost, taxRate);
  const documentRef = useRef<HTMLDivElement>(null);
  const [pdfSource, setPdfSource] = useState<HTMLElement | null>(null);
  const pdfFilename = estimateFilename(projectName, recipient, issuedOn);

  return (
    <>
      <div
        role="dialog"
        aria-modal="true"
        className="quote-modal-root fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/70 backdrop-blur-sm p-0 sm:p-4"
        onClick={() => {
          if (!pdfSource) onClose();
        }}
      >
        <div
          className="bg-card text-card-foreground w-full sm:max-w-5xl sm:rounded-2xl rounded-t-3xl max-h-[92vh] overflow-y-auto border border-border"
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
                <span className="block text-sm font-bold text-muted-foreground mb-2">発行日</span>
                <input
                  type="date"
                  value={issuedOn}
                  onChange={(event) => setIssuedOn(event.target.value)}
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

          <div className="no-print overflow-auto bg-slate-200 p-3 sm:p-6">
            <div ref={documentRef}>
              <EstimateDocument
                projectName={projectName}
                rows={rows}
                recipient={recipient}
                issuer={issuer}
                notes={notes}
                laborCost={laborCost}
                otherCost={otherCost}
                taxRate={taxRate}
                issuedOn={issuedOn}
              />
            </div>
          </div>

          <div className="no-print grid grid-cols-2 gap-3 p-5 border-t border-border sm:grid-cols-3">
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
              className="h-14 rounded-xl bg-primary text-primary-foreground font-black active:scale-[0.99]"
            >
              🖨️ 印刷する
            </button>
            <button
              type="button"
              onClick={() => {
                if (documentRef.current) setPdfSource(documentRef.current);
              }}
              className="col-span-2 h-14 rounded-xl bg-accent text-accent-foreground font-black sm:col-span-1"
            >
              PDF保存・共有
            </button>
          </div>
        </div>
      </div>
      {pdfSource && (
        <PdfExportDialog
          kind="estimate"
          source={pdfSource}
          filename={pdfFilename}
          onClose={() => setPdfSource(null)}
        />
      )}
    </>
  );
}
