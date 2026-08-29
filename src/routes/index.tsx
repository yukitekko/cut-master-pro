import { createFileRoute } from "@tanstack/react-router";
import {
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
import {
  solveCuttingStock,
  colorFor,
  type CutResult,
  type Piece,
  type StockUsage,
} from "@/lib/cutting-stock";
import {
  PROJECT_STORAGE_VERSION,
  createCalculationInputKey,
  readDraft,
  readProjects,
  saveProject,
  writeDraft,
  type ProjectSnapshot,
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

interface PieceInput {
  id: string;
  name: string;
  length: string;
  qty: string;
}

const uid = () => Math.random().toString(36).slice(2, 9);

interface StockInput {
  id: string;
  length: string;
}

interface StockRow {
  stockLength: number;
  qty: string;
  price: string;
}

const defaultQuoteNotes =
  "・お見積有効期限：発行日より30日間\n・お支払条件：別途ご相談\n・上記金額には消費税を含みます。";

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

function Index() {
  const [projectName, setProjectName] = useState("");
  const [materialName, setMaterialName] = useState("");
  const [materialSpec, setMaterialSpec] = useState("");
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [savedProjects, setSavedProjects] = useState<SavedProject[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [storageReady, setStorageReady] = useState(false);
  const [saveStatus, setSaveStatus] = useState("下書きを準備中");
  const [stocks, setStocks] = useState<StockInput[]>([{ id: uid(), length: "5000" }]);
  const [kerf, setKerf] = useState("4");
  const [pieces, setPieces] = useState<PieceInput[]>([
    { id: uid(), name: "", length: "1200", qty: "4" },
    { id: uid(), name: "", length: "800", qty: "6" },
    { id: uid(), name: "", length: "450", qty: "10" },
  ]);
  const [result, setResult] = useState<CutResult | null>(null);
  const [lastCalculatedInputKey, setLastCalculatedInputKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [laborCost, setLaborCost] = useState("5000");
  const [otherCost, setOtherCost] = useState("1000");
  const [taxRate, setTaxRate] = useState("10");
  const [quoteOpen, setQuoteOpen] = useState(false);
  const [quoteRows, setQuoteRows] = useState<StockRow[]>([]);
  const [recipient, setRecipient] = useState("");
  const [issuer, setIssuer] = useState("");
  const [notes, setNotes] = useState(defaultQuoteNotes);
  const [printPortalMounted, setPrintPortalMounted] = useState(false);

  const currentCalculationInputKey = useMemo(
    () => createCalculationInputKey({ stocks, kerf, pieces }),
    [stocks, kerf, pieces],
  );
  const needsRecalculation =
    result !== null && lastCalculatedInputKey !== currentCalculationInputKey;

  const createSnapshot = useCallback(
    (): ProjectSnapshot => ({
      version: PROJECT_STORAGE_VERSION,
      project: { name: projectName, activeProjectId },
      materials: [
        {
          id: "primary-material",
          name: materialName,
          specification: materialSpec,
          stocks,
          kerf,
          pieces,
        },
      ],
      calculation: { result, inputKey: lastCalculatedInputKey },
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
      materialName,
      materialSpec,
      stocks,
      kerf,
      pieces,
      result,
      lastCalculatedInputKey,
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
    const material = snapshot.materials[0];
    setProjectName(snapshot.project.name);
    setActiveProjectId(snapshot.project.activeProjectId);
    setMaterialName(material.name);
    setMaterialSpec(material.specification);
    setStocks(material.stocks);
    setKerf(material.kerf);
    setPieces(material.pieces.map((piece) => ({ ...piece, name: piece.name ?? "" })));
    setResult(snapshot.calculation.result);
    setLastCalculatedInputKey(
      snapshot.calculation.inputKey ??
        (snapshot.calculation.result ? createCalculationInputKey(material) : null),
    );
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
    const draft = readDraft(window.localStorage);
    setSavedProjects(readProjects(window.localStorage));
    if (draft) restoreSnapshot(draft);
    setStorageReady(true);
    setSaveStatus(draft ? "下書きを復元しました" : "下書き自動保存");
  }, []);

  useEffect(() => {
    if (!storageReady) return;
    setSaveStatus("保存中…");
    const timer = window.setTimeout(() => {
      writeDraft(window.localStorage, createSnapshot());
      setSaveStatus("下書き保存済み");
    }, 350);
    return () => window.clearTimeout(timer);
  }, [storageReady, createSnapshot]);

  const handleSaveProject = () => {
    const id = activeProjectId ?? `project-${Date.now()}-${uid()}`;
    const snapshot = createSnapshot();
    snapshot.project.activeProjectId = id;
    const next = saveProject(window.localStorage, snapshot, id);
    setActiveProjectId(id);
    setSavedProjects(next);
    setSaveStatus("案件を保存しました");
  };

  const handleOpenProject = (project: SavedProject) => {
    restoreSnapshot(project.snapshot);
    writeDraft(window.localStorage, project.snapshot);
    setHistoryOpen(false);
    setSaveStatus("保存案件を開きました");
    window.scrollTo({ top: 0, behavior: "smooth" });
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
      cleaned.push({ length: l, qty: q });
    }
    if (cleaned.length === 0) {
      setError("部材を1つ以上追加してください。");
      return;
    }
    const nextResult = solveCuttingStock(uniqueStocks, kerfNum, cleaned);
    setResult(nextResult);
    setLastCalculatedInputKey(currentCalculationInputKey);
    setQuoteRows((prev) => {
      const previousByLength = new Map(prev.map((r) => [r.stockLength, r]));
      return nextResult.stockUsage.map((u) => {
        const previous = previousByLength.get(u.stockLength);
        return {
          stockLength: u.stockLength,
          qty: String(u.count),
          price: previous?.price ?? "",
        };
      });
    });
  };

  const pieceColorMap = useMemo(() => {
    const map = new Map<number, string>();
    pieces.forEach((_, i) => map.set(i, colorFor(i)));
    return map;
  }, [pieces]);

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
              <ResultView result={result} pieceColorMap={pieceColorMap} />
              <button
                type="button"
                onClick={() => setQuoteOpen(true)}
                disabled={needsRecalculation}
                className="w-full h-20 rounded-2xl bg-accent text-accent-foreground text-2xl font-black tracking-wide shadow-lg active:scale-[0.99] transition-transform disabled:opacity-40 disabled:shadow-none"
              >
                {needsRecalculation ? "再計算後に見積書を作成できます" : "📄 見積書を作成する"}
              </button>
            </>
          )}
        </section>
        {result && quoteOpen && (
          <QuoteModal
            onClose={() => setQuoteOpen(false)}
            stockUsage={result.stockUsage}
            rows={quoteRows}
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
        {historyOpen && (
          <ProjectHistory
            projects={savedProjects}
            onOpen={handleOpenProject}
            onClose={() => setHistoryOpen(false)}
          />
        )}
      </main>
      {result &&
        printPortalMounted &&
        createPortal(
          <PrintableEstimate
            rows={quoteRows}
            recipient={recipient}
            issuer={issuer}
            notes={notes}
            laborCost={laborCost}
            otherCost={otherCost}
            taxRate={taxRate}
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
  onClose,
}: {
  projects: SavedProject[];
  onOpen: (project: SavedProject) => void;
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
          {projects.map((project) => (
            <button
              key={project.id}
              type="button"
              onClick={() => onOpen(project)}
              className="w-full text-left rounded-2xl border border-border bg-background p-4 active:scale-[0.99]"
            >
              <div className="font-black text-lg break-words">{project.name}</div>
              <div className="text-sm text-muted-foreground mt-1 break-words">
                {[project.snapshot.materials[0]?.name, project.snapshot.materials[0]?.specification]
                  .filter(Boolean)
                  .join(" / ") || "材料未設定"}
              </div>
              <div className="text-xs text-muted-foreground mt-3">
                更新 {new Date(project.updatedAt).toLocaleString("ja-JP")}
              </div>
            </button>
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
  const { inputRef, handleInput } = useStableNumericInput(value, onChange);

  return (
    <label className="block">
      <span className="block text-sm font-bold text-muted-foreground mb-2">{label}</span>
      <div className="relative">
        <input
          ref={inputRef}
          dir="ltr"
          inputMode="numeric"
          pattern="[0-9]*"
          defaultValue={value}
          onInput={handleInput}
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
  const { inputRef, handleInput } = useStableNumericInput(value, onChange);

  return (
    <label className="block min-w-0">
      <span className="block text-xs font-bold text-muted-foreground mb-1">{label}</span>
      <input
        ref={inputRef}
        dir="ltr"
        inputMode="numeric"
        pattern="[0-9]*"
        defaultValue={value}
        placeholder={placeholder}
        onInput={handleInput}
        className="w-full h-14 rounded-xl bg-background border-2 border-border px-3 text-xl font-bold tabular-nums focus:border-primary focus:outline-none"
      />
    </label>
  );
}

function useStableNumericInput(value: string, onChange: (value: string) => void) {
  const inputRef = useRef<HTMLInputElement>(null);

  const handleInput = (event: React.FormEvent<HTMLInputElement>) =>
    onChange(event.currentTarget.value);

  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input || document.activeElement === input || input.value === value) return;
    input.value = value;
  }, [value]);

  return { inputRef, handleInput };
}

function ResultView({
  result,
  pieceColorMap,
}: {
  result: CutResult;
  pieceColorMap: Map<number, string>;
}) {
  const yieldPct = (result.yieldRate * 100).toFixed(1);
  const maxStock = Math.max(1, ...result.bars.map((b) => b.stockLength));
  return (
    <section className="space-y-5 pt-2">
      <h2 className="text-xl font-black">計算結果</h2>

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
            <tr key={r.stockLength}>
              <td className="border border-black px-2 py-2">
                定尺材 {r.stockLength.toLocaleString()}mm
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
  stockUsage,
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
  stockUsage: StockUsage[];
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

  const handlePrint = () => window.print();

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
                  key={r.stockLength}
                  className="rounded-2xl border border-border bg-background p-3"
                >
                  <div className="flex items-baseline justify-between mb-2">
                    <div className="text-lg font-black tabular-nums">
                      {r.stockLength.toLocaleString()}mm 材
                    </div>
                    <div className="text-xs text-muted-foreground">
                      推奨: {stockUsage[i]?.count ?? 0}本
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
            onClick={handlePrint}
            className="w-full h-16 rounded-2xl bg-primary text-primary-foreground text-lg font-black active:scale-[0.99]"
          >
            🖨️ 印刷する
          </button>
        </div>
      </div>
    </div>
  );
}
