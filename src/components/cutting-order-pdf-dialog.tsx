import { useEffect, useRef, useState } from "react";
import { canSharePdf, savePdf, sharePreparedPdf } from "@/lib/cutting-order-export";

interface PdfExportDialogProps {
  source: HTMLElement;
  filename: string;
  onClose: () => void;
  kind: "cutting-order" | "estimate";
}

export function PdfExportDialog({ source, filename, onClose, kind }: PdfExportDialogProps) {
  const labels =
    kind === "estimate"
      ? {
          id: "estimate-pdf-title",
          title: "見積書のPDF",
          description:
            "現在の見積内容をA4縦でPDFにします。端末内で作成し、共有先はご自身で選べます。",
          shareTitle: "御見積書",
        }
      : {
          id: "cutting-pdf-title",
          title: "切断作業表のPDF",
          description:
            "選択中の材料をA4横・4列でPDFにします。端末内で作成し、共有先はご自身で選べます。",
          shareTitle: "切断作業表",
        };
  const [file, setFile] = useState<File | null>(null);
  const [progress, setProgress] = useState("PDFを準備しています…");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const sharingRef = useRef(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    dialogRef.current?.showModal();
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    setFile(null);
    setProgress("PDFを準備しています…");
    void (async () => {
      try {
        const createPdf =
          kind === "estimate"
            ? (await import("@/lib/estimate-pdf")).createEstimatePdf
            : (await import("@/lib/cutting-order-pdf")).createCuttingOrderPdf;
        const blob = await createPdf(source, {
          signal: controller.signal,
          onProgress: (page, total) => {
            if (!controller.signal.aborted) setProgress(`PDFを作成中… ${page} / ${total}ページ`);
          },
        });
        if (!controller.signal.aborted)
          setFile(new File([blob], filename, { type: "application/pdf" }));
      } catch (failure) {
        if (!controller.signal.aborted)
          setError(
            failure instanceof Error
              ? failure.message
              : "PDFを作成できませんでした。もう一度お試しください。",
          );
      }
    })();
    return () => controller.abort();
  }, [source, filename, attempt, kind]);

  const handleShare = async () => {
    if (!file || sharingRef.current) return;
    sharingRef.current = true;
    setSharing(true);
    setNotice(null);
    setError(null);
    try {
      const outcome = await sharePreparedPdf(file, navigator, labels.shareTitle);
      if (mounted.current)
        setNotice(
          outcome === "cancelled"
            ? "共有をキャンセルしました。PDFは保存できます。"
            : outcome === "unsupported"
              ? "この環境では直接共有できません。PDFを保存して添付してください。"
              : "共有先にPDFを渡しました。送信状況は共有先のアプリで確認してください。",
        );
    } catch (failure) {
      if (mounted.current)
        setError(
          failure instanceof Error
            ? failure.message
            : "共有できませんでした。PDFを保存してください。",
        );
    } finally {
      sharingRef.current = false;
      if (mounted.current) setSharing(false);
    }
  };

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={labels.id}
      onCancel={(event) => {
        event.preventDefault();
        if (!sharingRef.current) onClose();
      }}
      className="fixed inset-0 m-0 h-full max-h-none w-full max-w-none z-[70] flex items-center justify-center bg-black/75 p-4 text-foreground backdrop:bg-transparent"
    >
      <div className="w-full max-w-md max-h-[90vh] overflow-auto rounded-2xl border border-border bg-card p-5 space-y-4">
        <h2 id={labels.id} className="text-xl font-black">
          {labels.title}
        </h2>
        <p className="text-sm text-muted-foreground">{labels.description}</p>
        {!file && !error && (
          <p role="status" className="font-bold">
            {progress}
          </p>
        )}
        {file && (
          <div className="rounded-xl bg-background p-3">
            <p className="font-bold" role="status">
              PDFの準備ができました
            </p>
            <p className="mt-2 break-all text-xs text-muted-foreground">{file.name}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {(file.size / 1024 / 1024).toFixed(2)} MB
            </p>
          </div>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {notice && (
          <p role="status" className="text-sm">
            {notice}
          </p>
        )}
        {file && (
          <>
            <div className="grid grid-cols-2 gap-3">
              <button
                type="button"
                disabled={sharing}
                onClick={() => {
                  try {
                    savePdf(file);
                    setError(null);
                    setNotice("保存を開始しました。ブラウザのダウンロード一覧を確認してください。");
                  } catch {
                    setError(
                      "保存を開始できませんでした。ブラウザのダウンロード設定を確認してください。",
                    );
                  }
                }}
                className="min-h-14 rounded-xl bg-primary px-3 font-black text-primary-foreground disabled:opacity-40"
              >
                PDFを保存
              </button>
              <button
                type="button"
                disabled={sharing || !canSharePdf(file, navigator)}
                onClick={handleShare}
                className="min-h-14 rounded-xl bg-accent px-3 font-black text-accent-foreground disabled:opacity-40"
              >
                {sharing ? "共有先を開いています…" : "共有先を選ぶ"}
              </button>
            </div>
            {!canSharePdf(file, navigator) && (
              <p className="text-xs text-muted-foreground">
                この環境では直接共有できません。「PDFを保存」後、メールなどに添付してください。
              </p>
            )}
          </>
        )}
        {!file && error && (
          <button
            type="button"
            onClick={() => setAttempt((value) => value + 1)}
            className="min-h-12 w-full rounded-xl bg-primary font-bold text-primary-foreground"
          >
            もう一度作成する
          </button>
        )}
        <button
          type="button"
          disabled={sharing}
          onClick={onClose}
          className="min-h-12 w-full rounded-xl bg-secondary font-bold disabled:opacity-40"
        >
          {file || error ? "閉じる" : "作成をキャンセル"}
        </button>
      </div>
    </dialog>
  );
}

export function CuttingOrderPdfDialog(props: Omit<PdfExportDialogProps, "kind">) {
  return <PdfExportDialog {...props} kind="cutting-order" />;
}
