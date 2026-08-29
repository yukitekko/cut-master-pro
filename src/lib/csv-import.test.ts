import assert from "node:assert/strict";
import test from "node:test";
import {
  CSV_TEMPLATE_TEXT,
  decodeCsvBytes,
  parseMaterialsCsv,
  parseMaterialsRows,
} from "./csv-import.ts";

test("見本CSVから2種類の材料を取り込める", () => {
  const result = parseMaterialsCsv(CSV_TEMPLATE_TEXT);
  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.data.projectName, "○○邸 手すり工事");
  assert.equal(result.data.materials.length, 2);
  assert.equal(result.data.materials[0]?.name, "ステンレス角パイプ");
  assert.equal(result.data.materials[0]?.stocks.length, 1);
  assert.equal(result.data.materials[0]?.pieces.length, 2);
  assert.equal(result.data.materials[1]?.pieces[0]?.qty, "8");
});

test("引用符・カンマ・複数定尺長・全角数字を扱える", () => {
  const result = parseMaterialsCsv(
    [
      "材料番号,材料名,規格名,定尺材長(mm),刃厚(mm),部材名,部材長(mm),本数",
      'A,"角パイプ,黒",SUS,５０００,４,"横桟,上",１２００,４',
      'A,"角パイプ,黒",SUS,6000,4,縦桟,800,6',
    ].join("\n"),
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.deepEqual(
    result.data.materials[0]?.stocks.map((stock) => stock.length),
    ["5000", "6000"],
  );
  assert.equal(result.data.materials[0]?.pieces[0]?.name, "横桟,上");
});

test("必須列がない場合は取り込まない", () => {
  const result = parseMaterialsCsv("材料名,本数\n角パイプ,4");
  assert.deepEqual(result, {
    ok: false,
    errors: ["必要な列がありません: 定尺材長(mm)、部材長(mm)"],
  });
});

test("同じ材料番号の条件矛盾と不正な数値を行番号付きで通知する", () => {
  const result = parseMaterialsCsv(
    [
      "材料番号,材料名,定尺材長(mm),刃厚(mm),部材長(mm),本数",
      "A,角パイプ,5000,4,1200,4",
      "A,丸パイプ,5000,3,800,2",
      "B,丸パイプ,4000,3,-1,1.5",
    ].join("\n"),
  );
  assert.equal(result.ok, false);
  if (result.ok) return;

  assert.ok(result.errors.some((error) => error.includes("3行目: 材料番号")));
  assert.ok(result.errors.some((error) => error.includes("4行目: 部材長")));
  assert.ok(result.errors.some((error) => error.includes("4行目: 本数")));
});

test("案件名の不一致を検出する", () => {
  const result = parseMaterialsCsv(
    [
      "案件名,材料名,定尺材長(mm),部材長(mm),本数",
      "A邸,角パイプ,5000,1200,4",
      "B邸,丸パイプ,4000,800,2",
    ].join("\n"),
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.errors.some((error) => error.includes("案件名が他の行と一致")));
});

test("Shift-JISのCSVを文字化けせず読み取れる", () => {
  const bytes = Uint8Array.from([0x82, 0xa0, 0x2c, 0x31]);
  assert.equal(decodeCsvBytes(bytes.buffer), "あ,1");
});

test("Excel由来の数値セルもCSVと同じ材料構造へ変換できる", () => {
  const result = parseMaterialsRows([
    [
      "案件名",
      "材料番号",
      "材料名",
      "規格名",
      "定尺材長(mm)",
      "刃厚(mm)",
      "部材名",
      "部材長(mm)",
      "本数",
    ],
    ["Excel確認案件", "M001", "角パイプ", "SUS304", 5000, 4, "横桟", 1200, 4],
    ["Excel確認案件", "M001", "角パイプ", "SUS304", 6000, 4, "縦桟", 800, 6],
  ]);
  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.data.projectName, "Excel確認案件");
  assert.deepEqual(
    result.data.materials[0]?.stocks.map((stock) => stock.length),
    ["5000", "6000"],
  );
  assert.equal(result.data.materials[0]?.pieces[1]?.qty, "6");
});
