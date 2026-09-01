import html2canvas from "html2canvas";
import { jsPDF } from "jspdf";
import paperStyles from "../styles/cutting-order-paper.css?raw";
import { PDF_PAGE, assertPdfPageFits } from "./cutting-order-export.ts";

// Isolate paper styles from dark mode, responsive sizing, and unsupported color
// functions. The document itself is the same React-rendered cutting sheet.
const pdfBaseStyles = `
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; color: #000; background: #fff; }
  body { font: 7.5pt/1.15 "Hiragino Kaku Gothic ProN", "Hiragino Sans", "Yu Gothic", "Meiryo", "MS PGothic", sans-serif; }
  .print-area { width: 297mm; color: #000; background: #fff; }
  .cut-list-title { margin: 0; text-align: center; font-weight: 900; }
  .cut-list-meta strong, .cut-list-summary strong { min-width: 0; overflow-wrap: anywhere; }
  .cut-list-content { color: #000; background: #fff; }
  .cut-card-header span { white-space: nowrap; font-size: 6.5pt; font-weight: 700; }
  .cut-card-length small { margin-left: 0.5mm; font-size: 65%; }
  .cut-list-continuation-header > strong { flex-shrink: 0; }
`;

export async function createCuttingOrderPdf(
  source: HTMLElement,
  {
    signal,
    onProgress,
  }: { signal: AbortSignal; onProgress: (page: number, total: number) => void },
): Promise<Blob> {
  signal.throwIfAborted();
  const pages = Array.from(source.querySelectorAll<HTMLElement>(".cut-list-page-sheet"));
  if (!pages.length || !source.querySelector(".cut-card"))
    throw new Error("PDFにする切断結果がありません。");
  const frame = document.createElement("iframe");
  frame.title = "PDF作成用の切断作業表";
  frame.setAttribute("aria-hidden", "true");
  frame.tabIndex = -1;
  frame.style.cssText =
    "position:fixed;left:-10000px;top:0;width:1123px;height:794px;border:0;pointer-events:none;";
  // html2canvas 1.4 measures fonts in the HOST document, even for an iframe.
  // Tailwind's img { display:block } breaks its hidden 1px baseline probe.
  // Restore inline layout only for that probe while rendering; leave app images alone.
  const fontProbeStyle = document.createElement("style");
  fontProbeStyle.textContent =
    'body > div[style*="visibility: hidden"] > img[width="1"][height="1"] { display: inline !important; }';
  document.head.appendChild(fontProbeStyle);
  document.body.appendChild(frame);
  try {
    const doc = frame.contentDocument;
    if (!doc) throw new Error("PDF作成用の画面を準備できませんでした。");
    const style = doc.createElement("style");
    style.textContent = pdfBaseStyles + paperStyles;
    doc.head.appendChild(style);
    const root = doc.createElement("div");
    root.className = "print-area cut-list-document";
    doc.body.appendChild(root);
    const pdf = new jsPDF({ unit: "mm", format: "a4", orientation: "landscape", compress: true });
    pdf.setProperties({ title: "切断作業表", creator: "カットマスタープロ" });
    for (const [index, original] of pages.entries()) {
      signal.throwIfAborted();
      onProgress(index + 1, pages.length);
      const page = doc.importNode(original, true);
      root.replaceChildren(page);
      await doc.fonts.ready;
      signal.throwIfAborted();
      // Use actual rendered heights, not just the paginator's estimates.
      const pageRect = page.getBoundingClientRect();
      const innerHeight = ((PDF_PAGE.heightMm - 2 * PDF_PAGE.marginYmm) * 96) / 25.4;
      assertPdfPageFits(
        pageRect.width,
        innerHeight,
        page.scrollWidth,
        Math.max(page.scrollHeight, pageRect.height),
      );
      const canvas = await html2canvas(root, {
        backgroundColor: "#ffffff",
        scale: PDF_PAGE.scale,
        logging: false,
        width: Math.ceil((PDF_PAGE.widthMm * 96) / 25.4),
        height: Math.ceil((PDF_PAGE.heightMm * 96) / 25.4),
        windowWidth: 1123,
        windowHeight: 794,
        scrollX: 0,
        scrollY: 0,
      });
      try {
        signal.throwIfAborted();
        if (index > 0) pdf.addPage("a4", "landscape");
        pdf.addImage(canvas, "PNG", 0, 0, PDF_PAGE.widthMm, PDF_PAGE.heightMm, undefined, "FAST");
      } finally {
        canvas.width = 0;
        canvas.height = 0;
      }
      // Yield between pages to keep cancellation and progress responsive.
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    }
    signal.throwIfAborted();
    return pdf.output("blob");
  } finally {
    frame.remove();
    fontProbeStyle.remove();
  }
}
