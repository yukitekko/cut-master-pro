import assert from "node:assert/strict";
import test from "node:test";

import { formatJapaneseDate, localIsoDate, paginateEstimateRows } from "./estimate-document.ts";

test("見積の発行日をローカル日付で保存・表示できる", () => {
  const date = new Date(2026, 8, 1, 23, 30);
  assert.equal(localIsoDate(date), "2026-09-01");
  assert.equal(formatJapaneseDate("2026-09-01", date), "2026年9月1日");
  assert.equal(formatJapaneseDate("2026-99-99", date), "2026年9月1日");
});

test("9行までは1ページに収める", () => {
  assert.deepEqual(paginateEstimateRows(9), [
    {
      rowIndexes: Array.from({ length: 9 }, (_, index) => index),
      isFirst: true,
      isFinal: true,
    },
  ]);
});

test("10行からは先頭ページと集計ページへ偏りすぎないよう分ける", () => {
  assert.deepEqual(
    paginateEstimateRows(12).map((page) => page.rowIndexes.length),
    [6, 6],
  );
});

test("材料が多い見積は最終ページに集計欄を残して分割する", () => {
  const pages = paginateEstimateRows(40);
  assert.deepEqual(
    pages.flatMap((page) => page.rowIndexes),
    Array.from({ length: 40 }, (_, index) => index),
  );
  assert.equal(pages[0]?.isFirst, true);
  assert.equal(pages.at(-1)?.isFinal, true);
  assert.ok((pages.at(-1)?.rowIndexes.length ?? 99) <= 8);
  assert.ok(pages.slice(0, -1).every((page) => !page.isFinal));
});
