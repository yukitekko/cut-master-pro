import html2canvas from "html2canvas";
import { jsPDF } from "jspdf";
import estimateStyles from "../styles/estimate-paper.css?raw";
import { assertPdfPageFits } from "./cutting-order-export.ts";

const PAGE = { widthMm: 210, heightMm: 297, scale: 2 } as const;
const baseStyles = `
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; color: #172033; background: #fff; }
  body { font-family: "Meiryo", "Yu Gothic", sans-serif; }
  .estimate-document { width: 210mm; margin: 0; background: #fff; }
  .estimate-page-sheet { margin: 0; box-shadow: none; }
  .estimate-placeholder { visibility: hidden; }
`;

export async function createEstimatePdf(
  source: HTMLElement,
  {
    signal,
    onProgress,
  }: { signal: AbortSignal; onProgress: (page: number, total: number) => void },
): Promise<Blob> {
  signal.throwIfAborted();
  const pages = Array.from(source.querySelectorAll<HTMLElement>(".estimate-page-sheet"));
  if (!pages.length || !source.querySelector(".estimate-table"))
    throw new Error("PDFにする見積内容がありません。");

  const frame = document.createElement("iframe");
  frame.title = "PDF作成用の見積書";
  frame.setAttribute("aria-hidden", "true");
  frame.tabIndex = -1;
  frame.style.cssText =
    "position:fixed;left:-10000px;top:0;width:794px;height:1123px;border:0;pointer-events:none;";
  const fontProbeStyle = document.createElement("style");
  fontProbeStyle.textContent =
    'body > div[style*="visibility: hidden"] > img[width="1"][height="1"] { display: inline !important; }';
  document.head.appendChild(fontProbeStyle);
  document.body.appendChild(frame);

  try {
    const doc = frame.contentDocument;
    if (!doc) throw new Error("PDF作成用の画面を準備できませんでした。");
    const style = doc.createElement("style");
    style.textContent = baseStyles + estimateStyles;
    doc.head.appendChild(style);
    const root = doc.createElement("div");
    root.className = "estimate-document";
    doc.body.appendChild(root);
    const pdf = new jsPDF({ unit: "mm", format: "a4", orientation: "portrait", compress: true });
    pdf.setProperties({ title: "御見積書", creator: "カットマスタープロ" });

    for (const [index, original] of pages.entries()) {
      signal.throwIfAborted();
      onProgress(index + 1, pages.length);
      const page = doc.importNode(original, true);
      root.replaceChildren(page);
      await doc.fonts.ready;
      signal.throwIfAborted();
      const pageRect = page.getBoundingClientRect();
      assertPdfPageFits(
        (PAGE.widthMm * 96) / 25.4,
        (PAGE.heightMm * 96) / 25.4,
        page.scrollWidth,
        Math.max(page.scrollHeight, pageRect.height),
      );
      const canvas = await html2canvas(root, {
        backgroundColor: "#ffffff",
        scale: PAGE.scale,
        logging: false,
        width: Math.ceil((PAGE.widthMm * 96) / 25.4),
        height: Math.ceil((PAGE.heightMm * 96) / 25.4),
        windowWidth: 794,
        windowHeight: 1123,
        scrollX: 0,
        scrollY: 0,
      });
      try {
        signal.throwIfAborted();
        if (index > 0) pdf.addPage("a4", "portrait");
        pdf.addImage(canvas, "PNG", 0, 0, PAGE.widthMm, PAGE.heightMm, undefined, "FAST");
      } finally {
        canvas.width = 0;
        canvas.height = 0;
      }
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    }
    signal.throwIfAborted();
    return pdf.output("blob");
  } finally {
    frame.remove();
    fontProbeStyle.remove();
  }
}
