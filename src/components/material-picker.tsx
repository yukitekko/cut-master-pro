import { useEffect, useId, useMemo, useState } from "react";
import type { RegisteredMaterial } from "@/lib/material-catalog";

export type RegisterMaterialAction = (
  name: string,
  specification: string,
) => Promise<RegisteredMaterial>;

export type RegisterMaterialOptionAction = (value: string) => Promise<string>;

const uniqueOptions = (values: string[]) =>
  [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b, "ja"),
  );

/** Shared by job entry and the retired offcut screen. Keep this outside other forms. */
export function MaterialPicker({
  catalog,
  materialNames,
  specifications,
  selectedId,
  name = "",
  specification = "",
  disabled = false,
  onChoose,
  onChooseValues,
  onRegister,
  onRegisterName,
  onRegisterSpecification,
  onManual,
}: {
  catalog: RegisteredMaterial[];
  materialNames?: string[];
  specifications?: string[];
  selectedId?: string;
  name?: string;
  specification?: string;
  disabled?: boolean;
  onChoose: (material: RegisteredMaterial) => void;
  onChooseValues?: (name: string, specification: string) => void;
  onRegister?: RegisterMaterialAction;
  onRegisterName?: RegisterMaterialOptionAction;
  onRegisterSpecification?: RegisterMaterialOptionAction;
  onManual?: () => void;
}) {
  const nameSelectId = useId();
  const specificationSelectId = useId();
  const selected = catalog.find((item) => item.id === selectedId);
  const selectedName = selected?.name ?? name.trim();
  const selectedSpecification = selected?.specification ?? specification.trim();
  const [draftName, setDraftName] = useState(selectedName);
  const [draftSpecification, setDraftSpecification] = useState(selectedSpecification);
  const [adding, setAdding] = useState<"name" | "specification" | "pair" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const names = useMemo(
    () => uniqueOptions([...(materialNames ?? []), ...catalog.map((item) => item.name)]),
    [catalog, materialNames],
  );
  const specificationOptions = useMemo(
    () => uniqueOptions([...(specifications ?? []), ...catalog.map((item) => item.specification)]),
    [catalog, specifications],
  );
  const separateRegistration = Boolean(onRegisterName && onRegisterSpecification);
  const input =
    "mt-1 min-h-12 w-full min-w-0 rounded-xl border-2 border-border bg-background px-3 py-2 text-base font-bold";

  useEffect(() => {
    setDraftName(selectedName);
    setDraftSpecification(selectedSpecification);
  }, [selectedName, selectedSpecification]);

  const chooseValues = (nextName: string, nextSpecification: string) => {
    const registered = catalog.find(
      (item) => item.name === nextName && item.specification === nextSpecification,
    );
    if (registered) onChoose(registered);
    else if (onChooseValues) onChooseValues(nextName, nextSpecification);
    else if (!nextName && !nextSpecification) onManual?.();
    else setError("この組み合わせは未登録です。先に材料名と規格名を登録してください。");
  };

  const closeAdding = () => {
    setAdding(null);
    setError(null);
  };

  return (
    <fieldset disabled={disabled || busy} className="min-w-0 space-y-3 disabled:opacity-60">
      <p className="text-xs leading-relaxed text-muted-foreground">
        材料名と規格名を別々に選べます。登録済みなら、どの組み合わせでも使用できます。
      </p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor={nameSelectId} className="text-sm font-bold">
            材料名
          </label>
          <select
            id={nameSelectId}
            className={input}
            value={names.includes(draftName) ? draftName : ""}
            onChange={(event) => {
              const nextName = event.target.value;
              setDraftName(nextName);
              setError(null);
              chooseValues(nextName, draftSpecification);
              setAdding(null);
            }}
          >
            <option value="">
              {onChooseValues || onManual ? "一覧にない材料名を入力" : "材料名を選択"}
            </option>
            {names.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor={specificationSelectId} className="text-sm font-bold">
            規格名
          </label>
          <select
            id={specificationSelectId}
            className={input}
            value={specificationOptions.includes(draftSpecification) ? draftSpecification : ""}
            onChange={(event) => {
              const nextSpecification = event.target.value;
              setDraftSpecification(nextSpecification);
              setError(null);
              chooseValues(draftName, nextSpecification);
              setAdding(null);
            }}
          >
            <option value="">
              {onChooseValues || onManual ? "一覧にない規格名を入力" : "規格名を選択"}
            </option>
            {specificationOptions.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </div>
      </div>

      {separateRegistration ? (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <button
            type="button"
            className="min-h-11 text-sm font-bold text-accent underline"
            onClick={() => {
              setAdding("name");
              setError(null);
            }}
          >
            ＋ 材料名を登録
          </button>
          <button
            type="button"
            className="min-h-11 text-sm font-bold text-accent underline"
            onClick={() => {
              setAdding("specification");
              setError(null);
            }}
          >
            ＋ 規格名を登録
          </button>
        </div>
      ) : (
        onRegister &&
        adding !== "pair" && (
          <button
            type="button"
            className="min-h-11 text-sm font-bold text-accent underline"
            onClick={() => setAdding("pair")}
          >
            ＋ よく使う材料・規格を登録
          </button>
        )
      )}

      {(adding === "name" || adding === "specification") && (
        <form
          className="space-y-3 rounded-xl border border-accent/40 bg-background p-3"
          onSubmit={async (event) => {
            event.preventDefault();
            if (busy) return;
            const data = new FormData(event.currentTarget);
            const value = String(data.get("value") ?? "");
            setBusy(true);
            setError(null);
            try {
              if (adding === "name") {
                const saved = await onRegisterName!(value);
                setDraftName(saved);
                chooseValues(saved, draftSpecification);
              } else {
                const saved = await onRegisterSpecification!(value);
                setDraftSpecification(saved);
                chooseValues(draftName, saved);
              }
              setAdding(null);
            } catch (failure) {
              setError(failure instanceof Error ? failure.message : "候補を登録できませんでした。");
            } finally {
              setBusy(false);
            }
          }}
        >
          <label className="block text-sm">
            {adding === "name" ? "登録する材料名" : "登録する規格名"}
            <input
              name="value"
              defaultValue={adding === "name" ? draftName : draftSpecification}
              placeholder={adding === "name" ? "例：パイプ白" : "例：100A sch40"}
              className={input}
              required
              autoFocus
            />
          </label>
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              className="min-h-12 rounded-xl bg-secondary px-3 font-bold"
              onClick={closeAdding}
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

      {adding === "pair" && onRegister && (
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
              setDraftName(entry.name);
              setDraftSpecification(entry.specification);
              onChoose(entry);
              setAdding(null);
            } catch (failure) {
              setError(failure instanceof Error ? failure.message : "材料を登録できませんでした。");
            } finally {
              setBusy(false);
            }
          }}
        >
          <p className="text-xs text-muted-foreground">
            材料名と規格名をセットで、このブラウザに保存します。
          </p>
          <label className="block text-sm">
            登録する材料名
            <input name="name" defaultValue={name} className={input} required />
          </label>
          <label className="block text-sm">
            登録する規格名
            <input name="specification" defaultValue={specification} className={input} required />
          </label>
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              className="min-h-12 rounded-xl bg-secondary px-3 font-bold"
              onClick={closeAdding}
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

      {error && (
        <p role="alert" className="text-sm font-bold text-destructive">
          {error}
        </p>
      )}
    </fieldset>
  );
}
