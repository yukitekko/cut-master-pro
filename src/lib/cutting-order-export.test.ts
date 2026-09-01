import assert from "node:assert/strict";
import test from "node:test";
import {
  PDF_PAGE,
  assertPdfPageFits,
  canSharePdf,
  cuttingOrderFilename,
  estimateFilename,
  sharePreparedPdf,
} from "./cutting-order-export.ts";

const file = () => new File(["%PDF-1.4\n"], "切断作業表.pdf", { type: "application/pdf" });

test("PDF名は案件・材料・規格・作成日を含み、日本語を保持する", () => {
  assert.equal(
    cuttingOrderFilename("ポンプ室", "SGP", "150A", new Date(2026, 7, 31)),
    "切断作業表_ポンプ室_SGP_150A_20260831.pdf",
  );
  assert.equal(
    cuttingOrderFilename("", "", "", new Date(2026, 0, 2)),
    "切断作業表_名称未設定の案件_材料_20260102.pdf",
  );
});

test("見積書名は案件・宛名・保存された発行日を使う", () => {
  assert.equal(
    estimateFilename("ポンプ室", "株式会社〇〇 御中", "2026-09-01"),
    "見積書_ポンプ室_株式会社〇〇 御中_20260901.pdf",
  );
  assert.equal(
    estimateFilename("", "", "invalid", new Date(2026, 8, 2)),
    "見積書_名称未設定の案件_20260902.pdf",
  );
});

test("ファイル名の区切り文字・制御文字・双方向制御を安全にし、長さを制限する", () => {
  const name = cuttingOrderFilename(
    '../案件/\\:*?"<>|\n\u202e',
    "A".repeat(200),
    "規格".repeat(200),
  );
  assert.ok(!/[<>:"/\\|?*\n\u202e]/.test(name));
  assert.ok(Array.from(name).length < 130);
  assert.ok(name.endsWith(".pdf"));
});

test("共有はPDFファイル対応を確認し、文字やURLだけの共有へすり替えない", () => {
  const pdf = file();
  assert.equal(canSharePdf(pdf, {}), false);
  assert.equal(canSharePdf(pdf, { share: async () => {} }), false);
  assert.equal(canSharePdf(pdf, { canShare: () => false, share: async () => {} }), false);
  assert.equal(
    canSharePdf(pdf, {
      canShare: () => {
        throw new Error("拒否");
      },
      share: async () => {},
    }),
    false,
  );
  assert.equal(
    canSharePdf(pdf, { canShare: (data) => data.files?.[0] === pdf, share: async () => {} }),
    true,
  );
});

test("共有対象には生成したPDFだけを渡し、共有をクリックと同じ実行タイミングで開始する", async () => {
  const pdf = file();
  let received: ShareData | undefined;
  const pending = sharePreparedPdf(pdf, {
    canShare: () => true,
    share: async (data) => {
      received = data;
    },
  });
  assert.equal(received?.files?.[0], pdf);
  assert.equal(received?.url, undefined);
  assert.equal(received?.text, undefined);
  assert.equal(await pending, "shared");
});

test("見積書を共有するときは見積書の表題を渡せる", async () => {
  let received: ShareData | undefined;
  await sharePreparedPdf(
    file(),
    {
      canShare: () => true,
      share: async (data) => {
        received = data;
      },
    },
    "御見積書",
  );
  assert.equal(received?.title, "御見積書");
});

test("共有非対応では共有を呼ばず、保存を案内できる結果を返す", async () => {
  let called = false;
  assert.equal(
    await sharePreparedPdf(file(), {
      canShare: () => false,
      share: async () => {
        called = true;
      },
    }),
    "unsupported",
  );
  assert.equal(called, false);
});

test("共有キャンセルは失敗扱いせず、勝手な保存や再共有をしない", async () => {
  let calls = 0;
  assert.equal(
    await sharePreparedPdf(file(), {
      canShare: () => true,
      share: async () => {
        calls += 1;
        throw new DOMException("cancel", "AbortError");
      },
    }),
    "cancelled",
  );
  assert.equal(calls, 1);
});

test("共有エラーは成功にせずPDF保存の案内を返す", async () => {
  await assert.rejects(
    sharePreparedPdf(file(), {
      canShare: () => true,
      share: async () => {
        throw new DOMException("denied", "NotAllowedError");
      },
    }),
    /PDFを保存/,
  );
});

test("PDFはA4横で1ページずつ生成する寸法とし、見切れを検知する", () => {
  assert.equal(PDF_PAGE.widthMm, 297);
  assert.equal(PDF_PAGE.heightMm, 210);
  assert.ok(
    Math.ceil((297 * 96) / 25.4) * Math.ceil((210 * 96) / 25.4) * PDF_PAGE.scale ** 2 < 4_000_000,
  );
  assert.doesNotThrow(() => assertPdfPageFits(1000, 755, 1000, 750));
  assert.throws(() => assertPdfPageFits(1000, 755, 1003, 750), /見切れ/);
  assert.throws(() => assertPdfPageFits(1000, 755, 1000, 800), /見切れ/);
});
