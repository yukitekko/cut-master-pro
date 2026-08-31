import assert from "node:assert/strict";
import test from "node:test";
import {
  APP_SETTINGS_KEY,
  createDefaultAppSettings,
  createMaterialDefaults,
  readAppSettings,
  validateAppSettings,
  writeAppSettings,
} from "./app-settings.ts";
import { DRAFT_STORAGE_KEY, PROJECTS_STORAGE_KEY } from "./project-storage.ts";

class MemoryStorage {
  values = new Map<string, string>();
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

test("設定未保存時は従来の定尺5000・刃厚4・自社情報空欄を使う", () => {
  assert.deepEqual(readAppSettings(new MemoryStorage()), {
    version: 1,
    stockLengths: ["5000"],
    kerf: "4",
    issuer: "",
  });
});

test("複数定尺・小数の刃厚・改行を含む自社情報を保存復元する", () => {
  const storage = new MemoryStorage();
  const settings = {
    ...createDefaultAppSettings(),
    stockLengths: ["4000", "6000"],
    kerf: "3.2",
    issuer: "渡辺工房\n住所\n電話: 000-0000",
  };
  writeAppSettings(storage, settings);
  assert.deepEqual(readAppSettings(storage), settings);
  assert.equal(storage.values.size, 1);
});

test("全角数字を正規化し空白行を除き、刃厚0も保存できる", () => {
  const result = validateAppSettings({
    ...createDefaultAppSettings(),
    stockLengths: [" ４０００．５ ", ""],
    kerf: "０",
  });
  assert.deepEqual(result, {
    ok: true,
    settings: { version: 1, stockLengths: ["4000.5"], kerf: "0", issuer: "" },
  });
});

test("保存時に数値表記を変えて次回読み込みを壊さない", () => {
  const storage = new MemoryStorage();
  const saved = writeAppSettings(storage, {
    ...createDefaultAppSettings(),
    stockLengths: ["004000.5", "1000000000000000000000"],
    kerf: "0.00000001",
  });
  assert.deepEqual(readAppSettings(storage), saved);
});

test("空欄・0・負数・数値でない定尺や刃厚は保存しない", () => {
  const storage = new MemoryStorage();
  writeAppSettings(storage, createDefaultAppSettings());
  const original = storage.getItem(APP_SETTINGS_KEY);
  for (const stockLengths of [
    [],
    [""],
    ["0"],
    ["-5000"],
    ["NaN"],
    ["Infinity"],
    ["0x123"],
    ["1e3"],
  ]) {
    assert.throws(() => writeAppSettings(storage, { ...createDefaultAppSettings(), stockLengths }));
  }
  for (const kerf of ["", "-1", "NaN", "Infinity", "0x10"]) {
    assert.throws(() => writeAppSettings(storage, { ...createDefaultAppSettings(), kerf }));
  }
  assert.equal(storage.getItem(APP_SETTINGS_KEY), original);
});

test("表記が違っても同じ長さの定尺を重複登録できない", () => {
  assert.equal(
    validateAppSettings({ ...createDefaultAppSettings(), stockLengths: ["5000", "０５０００．０"] })
      .ok,
    false,
  );
});

test("壊れた設定や未知の版は安全な初期値で読み、元データは上書きしない", () => {
  const storage = new MemoryStorage();
  for (const raw of [
    "{broken",
    "null",
    "[]",
    '{"version":99}',
    JSON.stringify({ ...createDefaultAppSettings(), stockLengths: [5000] }),
  ]) {
    storage.setItem(APP_SETTINGS_KEY, raw);
    assert.deepEqual(readAppSettings(storage), createDefaultAppSettings());
    assert.equal(storage.getItem(APP_SETTINGS_KEY), raw);
  }
});

test("保存領域の失敗は成功扱いにせず呼び出し側へ伝える", () => {
  assert.throws(
    () =>
      readAppSettings({
        getItem() {
          throw new Error("read failed");
        },
      }),
    /read failed/,
  );
  assert.throws(
    () =>
      writeAppSettings(
        {
          setItem() {
            throw new Error("write failed");
          },
        },
        createDefaultAppSettings(),
      ),
    /write failed/,
  );
});

test("設定保存は既存の下書きや案件履歴に触れない", () => {
  const storage = new MemoryStorage();
  storage.setItem(DRAFT_STORAGE_KEY, "existing draft including calculation and estimate");
  storage.setItem(PROJECTS_STORAGE_KEY, "existing project history");
  writeAppSettings(storage, { ...createDefaultAppSettings(), kerf: "3", issuer: "新しい会社名" });
  assert.equal(
    storage.getItem(DRAFT_STORAGE_KEY),
    "existing draft including calculation and estimate",
  );
  assert.equal(storage.getItem(PROJECTS_STORAGE_KEY), "existing project history");
});

test("新しい材料だけに設定をコピーし、在庫本数は引き継がない", () => {
  let nextId = 0;
  const createId = () => String(++nextId);
  const settings = { ...createDefaultAppSettings(), stockLengths: ["4000", "6000"], kerf: "3.2" };
  const first = createMaterialDefaults(settings, createId);
  const second = createMaterialDefaults(settings, createId);
  assert.equal(first.stockMode, "purchase");
  assert.equal(first.kerf, "3.2");
  assert.deepEqual(
    first.stocks.map(({ length, quantity }) => ({ length, quantity })),
    [
      { length: "4000", quantity: "" },
      { length: "6000", quantity: "" },
    ],
  );
  assert.notEqual(first.stocks[0]!.id, second.stocks[0]!.id);
  first.stocks[0]!.quantity = "9";
  first.stocks[0]!.length = "9000";
  settings.stockLengths[1] = "7000";
  settings.kerf = "10";
  assert.equal(second.stocks[0]!.quantity, "");
  assert.equal(second.stocks[0]!.length, "4000");
  assert.equal(second.stocks[1]!.length, "6000");
  assert.equal(second.kerf, "3.2");
});
