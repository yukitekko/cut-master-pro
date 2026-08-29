import assert from "node:assert/strict";
import test from "node:test";
import {
  PROJECT_STORAGE_VERSION,
  createCalculationInputKey,
  readDraft,
  readProjects,
  removeProject,
  saveProject,
  writeDraft,
  type ProjectSnapshot,
} from "./project-storage.ts";

class MemoryStorage implements Storage {
  private values = new Map<string, string>();
  get length() {
    return this.values.size;
  }
  clear() {
    this.values.clear();
  }
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  key(index: number) {
    return [...this.values.keys()][index] ?? null;
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

class FailingStorage extends MemoryStorage {
  setItem() {
    throw new Error("storage failed");
  }
}

const snapshot = (): ProjectSnapshot => ({
  version: PROJECT_STORAGE_VERSION,
  project: { name: "A邸", activeProjectId: null },
  materials: [
    {
      id: "primary-material",
      name: "角パイプ",
      specification: "SUS304",
      stocks: [{ id: "s1", length: "5000" }],
      kerf: "4",
      pieces: [{ id: "p1", name: "横桟", length: "1200", qty: "4" }],
    },
  ],
  calculation: { result: null, inputKey: null },
  estimate: {
    rows: [{ stockLength: 5000, qty: "2", price: "1000" }],
    recipient: "お客様",
    issuer: "工房",
    notes: "備考",
    laborCost: "5000",
    otherCost: "1000",
    taxRate: "10",
  },
});

test("下書きは全状態を往復できる", () => {
  const storage = new MemoryStorage();
  const value = snapshot();
  writeDraft(storage, value);
  assert.deepEqual(readDraft(storage), value);
});

test("同じ案件IDの再保存は履歴を増やさず更新する", () => {
  const storage = new MemoryStorage();
  saveProject(storage, snapshot(), "project-1", "2026-01-01T00:00:00.000Z");
  const changed = snapshot();
  changed.project.name = "A邸 変更";
  saveProject(storage, changed, "project-1", "2026-01-02T00:00:00.000Z");
  const projects = readProjects(storage);
  assert.equal(projects.length, 1);
  assert.equal(projects[0]?.name, "A邸 変更");
  assert.equal(projects[0]?.createdAt, "2026-01-01T00:00:00.000Z");
  assert.equal(projects[0]?.snapshot.project.activeProjectId, "project-1");
});

test("壊れた保存データは安全に無視する", () => {
  const storage = new MemoryStorage();
  storage.setItem("cut-master-pro:draft:v1", "{broken");
  storage.setItem("cut-master-pro:projects:v1", "{} ");
  assert.equal(readDraft(storage), null);
  assert.deepEqual(readProjects(storage), []);
});

test("計算条件の変更だけを検出する", () => {
  const before = snapshot().materials[0]!;
  const renamed = structuredClone(before);
  renamed.name = "名称変更";
  renamed.pieces[0]!.name = "部材名変更";
  assert.equal(createCalculationInputKey(renamed), createCalculationInputKey(before));

  const resized = structuredClone(before);
  resized.pieces[0]!.length = "1300";
  assert.notEqual(createCalculationInputKey(resized), createCalculationInputKey(before));
});

test("指定した案件だけを履歴から削除する", () => {
  const storage = new MemoryStorage();
  saveProject(storage, snapshot(), "project-1", "2026-01-01T00:00:00.000Z");
  saveProject(storage, snapshot(), "project-2", "2026-01-02T00:00:00.000Z");
  const projects = removeProject(storage, "project-1");
  assert.deepEqual(
    projects.map((project) => project.id),
    ["project-2"],
  );
  assert.deepEqual(
    readProjects(storage).map((project) => project.id),
    ["project-2"],
  );
});

test("保存領域の書き込みエラーを呼び出し側へ通知する", () => {
  const storage = new FailingStorage();
  assert.throws(() => writeDraft(storage, snapshot()), /storage failed/);
  assert.throws(() => saveProject(storage, snapshot(), "project-1"), /storage failed/);
});
