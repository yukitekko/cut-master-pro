import { useId, useState } from "react";
import type { RegisteredMaterial } from "@/lib/material-catalog";

export type RegisterMaterialAction = (
  name: string,
  specification: string,
) => Promise<RegisteredMaterial>;

/** Shared by job entry and offcut registration. Keep this outside other forms. */
export function MaterialPicker({
  catalog,
  selectedId,
  name = "",
  specification = "",
  disabled = false,
  onChoose,
  onRegister,
  onManual,
}: {
  catalog: RegisteredMaterial[];
  selectedId?: string;
  name?: string;
  specification?: string;
  disabled?: boolean;
  onChoose: (material: RegisteredMaterial) => void;
  onRegister: RegisterMaterialAction;
  onManual?: () => void;
}) {
  const selectId = useId();
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input =
    "mt-1 min-h-12 w-full min-w-0 rounded-xl border-2 border-border bg-background px-3 py-2 text-base font-bold";
  const known = catalog.some((item) => item.id === selectedId);
  return (
    <fieldset disabled={disabled || busy} className="min-w-0 space-y-2 disabled:opacity-60">
      <label htmlFor={selectId} className="text-sm font-bold">
        登録済みの材料・規格
      </label>
      <select
        id={selectId}
        className={input}
        value={known ? selectedId : ""}
        onChange={(event) => {
          const item = catalog.find((entry) => entry.id === event.target.value);
          if (item) onChoose(item);
          else onManual?.();
          setAdding(false);
          setError(null);
        }}
      >
        <option value="" disabled={!onManual}>
          {onManual ? "材料名・規格を手入力" : "材料・規格を選んでください"}
        </option>
        {[...catalog]
          .sort((a, b) =>
            `${a.name} ${a.specification}`.localeCompare(`${b.name} ${b.specification}`, "ja"),
          )
          .map((item) => (
            <option key={item.id} value={item.id}>
              {item.name} ／ {item.specification}
            </option>
          ))}
      </select>
      {!adding && (
        <button
          type="button"
          className="min-h-11 text-sm font-bold text-accent underline"
          onClick={() => setAdding(true)}
        >
          ＋ よく使う材料・規格を登録
        </button>
      )}
      {adding && (
        <form
          className="space-y-3 rounded-xl border border-accent/40 bg-background p-3"
          onSubmit={async (event) => {
            event.preventDefault();
            if (busy) return;
            const data = new FormData(event.currentTarget);
            setBusy(true);
            setError(null);
            try {
              const entry = await onRegister(
                String(data.get("name") ?? ""),
                String(data.get("specification") ?? ""),
              );
              onChoose(entry);
              setAdding(false);
            } catch (failure) {
              setError(failure instanceof Error ? failure.message : "材料を登録できませんでした。");
            } finally {
              setBusy(false);
            }
          }}
        >
          <p className="text-xs text-muted-foreground">
            材料名と規格名をセットで、このブラウザに保存します。定尺・刃厚は案件側で入力します。
          </p>
          <label className="block text-sm">
            登録する材料名
            <input
              name="name"
              defaultValue={name}
              placeholder="例：SGP"
              className={input}
              required
            />
          </label>
          <label className="block text-sm">
            登録する規格名
            <input
              name="specification"
              defaultValue={specification}
              placeholder="例：150A"
              className={input}
              required
            />
          </label>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              className="min-h-12 rounded-xl bg-secondary px-3 font-bold"
              onClick={() => {
                setAdding(false);
                setError(null);
              }}
            >
              キャンセル
            </button>
            <button
              type="submit"
              className="min-h-12 rounded-xl bg-primary px-3 font-black text-primary-foreground"
            >
              {busy ? "保存中…" : "登録して選ぶ"}
            </button>
          </div>
        </form>
      )}
    </fieldset>
  );
}
