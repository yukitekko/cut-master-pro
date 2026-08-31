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

test("共通設定は刃厚4・自社情報空欄だけを持つ", () => {
  assert.deepEqual(readAppSettings(new MemoryStorage()), {
    version: 1,
    kerf: "4",
    issuer: "",
  });
});

test("小数の刃厚・改行を含む自社情報を保存復元する", () => {
  const storage = new MemoryStorage();
  const settings = {
    ...createDefaultAppSettings(),
    kerf: "3.2",
    issuer: "渡辺工房\n住所\n電話: 000-0000",
  };
  writeAppSettings(storage, settings);
  assert.deepEqual(readAppSettings(storage), settings);
  assert.equal(storage.values.size, 1);
});

test("全角数字を正規化し、刃厚0も保存できる", () => {
  const result = validateAppSettings({
    ...createDefaultAppSettings(),
    kerf: "０",
  });
  assert.deepEqual(result, {
    ok: true,
    settings: { version: 1, kerf: "0", issuer: "" },
  });
});

test("保存時に数値表記を変えて次回読み込みを壊さない", () => {
  const storage = new MemoryStorage();
  const saved = writeAppSettings(storage, {
    ...createDefaultAppSettings(),
    kerf: "0.00000001",
  });
  assert.deepEqual(readAppSettings(storage), saved);
});

test("空欄・負数・数値でない刃厚は保存しない", () => {
  const storage = new MemoryStorage();
  writeAppSettings(storage, createDefaultAppSettings());
  const original = storage.getItem(APP_SETTINGS_KEY);
  for (const kerf of ["", "-1", "NaN", "Infinity", "0x10"]) {
    assert.throws(() => writeAppSettings(storage, { ...createDefaultAppSettings(), kerf }));
  }
  assert.equal(storage.getItem(APP_SETTINGS_KEY), original);
});

test("旧設定の共通定尺は無視し、刃厚と自社情報は引き継ぐ", () => {
  const storage = new MemoryStorage();
  for (const stockLengths of [["4000", "6000"], null]) {
    const legacy = {
      ...createDefaultAppSettings(),
      stockLengths,
      kerf: "3.2",
      issuer: "既存の会社名",
    };
    storage.setItem(APP_SETTINGS_KEY, JSON.stringify(legacy));
    const restored = readAppSettings(storage);
    assert.deepEqual(restored, { version: 1, kerf: "3.2", issuer: "既存の会社名" });
    assert.equal(createMaterialDefaults(restored, () => "s1").stocks[0]!.length, "");
    writeAppSettings(storage, restored);
    assert.equal("stockLengths" in JSON.parse(storage.getItem(APP_SETTINGS_KEY)!), false);
  }
});

test("壊れた設定や未知の版は安全な初期値で読み、元データは上書きしない", () => {
  const storage = new MemoryStorage();
  for (const raw of [
    "{broken",
    "null",
    "[]",
    '{"version":99}',
    JSON.stringify({ ...createDefaultAppSettings(), kerf: "invalid" }),
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

test("新しい材料の定尺と在庫本数は空欄で、刃厚だけ設定からコピーする", () => {
  let nextId = 0;
  const createId = () => String(++nextId);
  const settings = { ...createDefaultAppSettings(), kerf: "3.2" };
  const first = createMaterialDefaults(settings, createId);
  const second = createMaterialDefaults(settings, createId);
  assert.equal(first.stockMode, "purchase");
  assert.equal(first.kerf, "3.2");
  assert.deepEqual(
    first.stocks.map(({ length, quantity }) => ({ length, quantity })),
    [{ length: "", quantity: "" }],
  );
  assert.notEqual(first.stocks[0]!.id, second.stocks[0]!.id);
  first.stocks[0]!.quantity = "9";
  first.stocks[0]!.length = "9000";
  settings.kerf = "10";
  assert.equal(second.stocks[0]!.quantity, "");
  assert.equal(second.stocks[0]!.length, "");
  assert.equal(second.kerf, "3.2");
});
