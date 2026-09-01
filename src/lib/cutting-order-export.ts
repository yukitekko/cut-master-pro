/** Browser-only file operations are injected so the failure paths can be tested. */
export interface PdfShareTarget {
  canShare?: (data: ShareData) => boolean;
  share?: (data: ShareData) => Promise<void>;
}

export const PDF_PAGE = {
  widthMm: 297,
  heightMm: 210,
  marginXmm: 6,
  marginYmm: 5,
  scale: 2,
} as const;

const filenamePart = (value: string, fallback: string) => {
  const safe = Array.from(value, (char) => (char.codePointAt(0)! < 32 ? "_" : char))
    .join("")
    .normalize("NFC")
    .replace(/[<>:"/\\|?*\u007f\u202a-\u202e\u2066-\u2069]/g, "_")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .trim();
  return Array.from(safe || fallback)
    .slice(0, 36)
    .join("");
};

export function cuttingOrderFilename(
  projectName: string,
  materialName: string,
  specification: string,
  now = new Date(),
) {
  const date = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
  return (
    [
      "切断作業表",
      filenamePart(projectName, "名称未設定の案件"),
      filenamePart(materialName, "材料"),
      ...(specification.trim() ? [filenamePart(specification, "規格")] : []),
      date,
    ].join("_") + ".pdf"
  );
}

export function estimateFilename(
  projectName: string,
  recipient: string,
  issuedOn: string,
  now = new Date(),
) {
  const safeIssuedOn = /^\d{4}-\d{2}-\d{2}$/.test(issuedOn)
    ? issuedOn.replaceAll("-", "")
    : `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
  return (
    [
      "見積書",
      filenamePart(projectName, "名称未設定の案件"),
      ...(recipient.trim() ? [filenamePart(recipient, "宛名未設定")] : []),
      safeIssuedOn,
    ].join("_") + ".pdf"
  );
}

export function canSharePdf(file: File, target: PdfShareTarget): boolean {
  try {
    return Boolean(target.share && target.canShare?.({ files: [file] }));
  } catch {
    return false;
  }
}

/** Call directly in the click handler; never generate a PDF before this await. */
export async function sharePreparedPdf(
  file: File,
  target: PdfShareTarget,
  title = "切断作業表",
): Promise<"shared" | "cancelled" | "unsupported"> {
  if (!canSharePdf(file, target)) return "unsupported";
  try {
    await target.share!({ files: [file], title });
    return "shared";
  } catch (error) {
    if (error && typeof error === "object" && "name" in error && error.name === "AbortError")
      return "cancelled";
    throw new Error(
      "共有を開始できませんでした。「PDFを保存」から保存し、メールなどに添付してください。",
    );
  }
}

export function savePdf(file: File) {
  const url = URL.createObjectURL(file);
  const link = document.createElement("a");
  link.href = url;
  link.download = file.name;
  document.body.appendChild(link);
  try {
    link.click();
  } finally {
    link.remove();
    // Allow browsers to finish consuming the download before releasing it.
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}

/** Fail visibly instead of silently cropping a card or a long header. */
export function assertPdfPageFits(
  width: number,
  height: number,
  contentWidth: number,
  contentHeight: number,
) {
  if (contentWidth > width + 2 || contentHeight > height + 2) {
    throw new Error(
      "用紙に収まらないページがあります。長い案件名・材料名・備考などを確認してください。見切れを防ぐためPDFの作成を中止しました。",
    );
  }
}
