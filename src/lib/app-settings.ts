import type { ProjectMaterial } from "./project-storage.ts";

export const APP_SETTINGS_KEY = "cut-master-pro:settings:v1";

export interface AppSettings {
  version: 1;
  stockLengths: string[];
  kerf: string;
  issuer: string;
}

export const createDefaultAppSettings = (): AppSettings => ({
  version: 1,
  stockLengths: ["5000"],
  kerf: "4",
  issuer: "",
});

const normalizeNumberText = (value: string) =>
  value
    .trim()
    .replace(/[０-９．]/g, (character) => String.fromCharCode(character.charCodeAt(0) - 0xfee0));

const isDecimal = (value: string) => /^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value);

export const validateAppSettings = (
  value: unknown,
): { ok: true; settings: AppSettings } | { ok: false; error: string } => {
  if (!value || typeof value !== "object") return { ok: false, error: "設定の形式が不正です。" };
  const candidate = value as Partial<AppSettings>;
  if (
    candidate.version !== 1 ||
    !Array.isArray(candidate.stockLengths) ||
    !candidate.stockLengths.every((length) => typeof length === "string") ||
    typeof candidate.kerf !== "string" ||
    typeof candidate.issuer !== "string"
  ) {
    return { ok: false, error: "設定の形式が不正です。" };
  }

  const lengths = candidate.stockLengths.map(normalizeNumberText).filter(Boolean);
  if (lengths.length === 0) return { ok: false, error: "定尺材の長さを1つ以上入力してください。" };
  if (
    lengths.some(
      (length) => !isDecimal(length) || !Number.isFinite(Number(length)) || Number(length) <= 0,
    )
  ) {
    return { ok: false, error: "定尺材の長さは0より大きい数で入力してください。" };
  }
  if (new Set(lengths.map(Number)).size !== lengths.length) {
    return { ok: false, error: "同じ定尺材の長さが重複しています。1つにまとめてください。" };
  }

  const kerf = normalizeNumberText(candidate.kerf);
  if (!isDecimal(kerf) || !Number.isFinite(Number(kerf)) || Number(kerf) < 0) {
    return { ok: false, error: "刃厚は0以上の数で入力してください。" };
  }
  return {
    ok: true,
    settings: {
      version: 1,
      stockLengths: lengths,
      kerf,
      issuer: candidate.issuer.trim(),
    },
  };
};

export const readAppSettings = (storage: Pick<Storage, "getItem">): AppSettings => {
  const raw = storage.getItem(APP_SETTINGS_KEY);
  if (raw) {
    try {
      const parsed = validateAppSettings(JSON.parse(raw));
      if (parsed.ok) return parsed.settings;
    } catch {
      // Leave invalid stored data untouched; only an explicit save replaces it.
    }
  }
  return createDefaultAppSettings();
};

export const writeAppSettings = (
  storage: Pick<Storage, "setItem">,
  settings: AppSettings,
): AppSettings => {
  const parsed = validateAppSettings(settings);
  if (!parsed.ok) throw new Error(parsed.error);
  storage.setItem(APP_SETTINGS_KEY, JSON.stringify(parsed.settings));
  return parsed.settings;
};

/** Copy defaults only when creating a material; never patch existing materials with settings. */
export const createMaterialDefaults = (
  settings: AppSettings,
  createId: () => string,
): Pick<ProjectMaterial, "stockMode" | "stocks" | "kerf"> => ({
  stockMode: "purchase",
  stocks: settings.stockLengths.map((length) => ({ id: createId(), length, quantity: "" })),
  kerf: settings.kerf,
});
