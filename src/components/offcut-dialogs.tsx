import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  adjustOffcut,
  matchesMaterial,
  registerOffcut,
  previewCuttingCompletion,
  type OffcutBank,
  type RetainedOffcut,
} from "@/lib/offcut-bank";
import { getOffcutCandidates } from "@/lib/offcut-planning";
import type { ProjectMaterial, ProjectMaterialCalculation } from "@/lib/project-storage";
import { findRegisteredMaterial } from "@/lib/material-catalog";
import { MaterialPicker, type RegisterMaterialAction } from "@/components/material-picker";
import { InventoryChanges } from "@/components/inventory-changes";

const inputClass =
  "mt-1 h-12 w-full min-w-0 rounded-xl border-2 border-border bg-background px-3 text-base font-bold";
const buttonClass = "min-h-12 rounded-xl bg-secondary px-4 py-2 font-bold disabled:opacity-40";
const primaryClass =
  "min-h-12 rounded-xl bg-primary px-4 py-2 font-black text-primary-foreground disabled:opacity-40";
const textValue = (data: FormData, key: string) => String(data.get(key) ?? "").trim();
const numberValue = (data: FormData, key: string) => {
  const value = textValue(data, key).replace(/[０-９．]/g, (char) =>
    char === "．" ? "." : String.fromCharCode(char.charCodeAt(0) - 0xfee0),
  );
  return value ? Number(value) : NaN;
};

function DialogFrame({
  title,
  onClose,
  children,
  footer,
  busy = false,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer: ReactNode;
  busy?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
    const dialog = ref.current;
    return () => dialog?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      aria-label={title}
      onCancel={(event) => {
        if (busy) event.preventDefault();
        else onClose();
      }}
      className="m-auto max-h-[90dvh] w-[calc(100%_-_1rem)] max-w-2xl overflow-y-auto rounded-3xl border border-border bg-card p-0 text-foreground shadow-2xl backdrop:bg-black/75"
    >
      <div className="flex items-center justify-between gap-2 border-b border-border p-4">
        <h2 className="text-xl font-black">{title}</h2>
        <button
          type="button"
          aria-label={`${title}を閉じる`}
          onClick={onClose}
          disabled={busy}
          className={buttonClass}
        >
          ×
        </button>
      </div>
      <div className="space-y-4 p-4">{children}</div>
      <div className="sticky bottom-0 space-y-3 border-t border-border bg-card p-4">{footer}</div>
    </dialog>
  );
}

export function OffcutBankDialog({
  bank,
  material,
  locked,
  onClose,
  onUpdate,
  onSelect,
  onRegisterMaterial,
}: {
  bank: OffcutBank;
  material: ProjectMaterial;
  locked: boolean;
  onClose: () => void;
  onUpdate: (update: (bank: OffcutBank) => OffcutBank) => Promise<string | null>;
  onSelect: (selections: NonNullable<ProjectMaterial["offcuts"]>) => string | null;
  onRegisterMaterial: RegisterMaterialAction;
}) {
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [registrationMaterialId, setRegistrationMaterialId] = useState(
    () => findRegisteredMaterial(bank.catalog, material)?.id,
  );
  const run = async (update: (bank: OffcutBank) => OffcutBank, message: string) => {
    setBusy(true);
    const failure = await onUpdate(update);
    setError(failure);
    setNotice(failure ? "" : message);
    setBusy(false);
    return !failure;
  };
  const matching = bank.entries.filter(
    (entry) => matchesMaterial(entry, material, bank.catalog) && entry.quantity > 0,
  );
  return (
    <DialogFrame
      title="端材バンク"
      onClose={onClose}
      busy={busy}
      footer={
        <>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          {notice && (
            <p role="status" className="text-sm text-accent">
              {notice}
            </p>
          )}
          <div className="grid grid-cols-2 gap-2">
            <button disabled={busy} onClick={onClose} className={buttonClass}>
              閉じる
            </button>
            <button
              form="offcut-selection"
              type="submit"
              disabled={busy || locked}
              className={primaryClass}
            >
              選んだ端材を使う
            </button>
          </div>
        </>
      }
    >
      <p className="text-sm text-muted-foreground">
        この端末だけに保存します。計算・選択では在庫は減りません。実際に切り終えてから「切断完了」で更新します。
      </p>
      <details className="rounded-xl border border-border p-3">
        <summary className="min-h-11 cursor-pointer py-2 font-bold">＋ 手元の端材を登録</summary>
        <MaterialPicker
          catalog={bank.catalog}
          selectedId={registrationMaterialId}
          name={material.name}
          specification={material.specification}
          disabled={busy}
          onChoose={(item) => setRegistrationMaterialId(item.id)}
          onRegister={onRegisterMaterial}
        />
        <form
          className="mt-2 space-y-3"
          onSubmit={async (event) => {
            event.preventDefault();
            const form = event.currentTarget;
            const data = new FormData(form);
            const registered = bank.catalog.find((item) => item.id === registrationMaterialId);
            if (!registered) {
              setError(
                "端材の材料・規格を一覧から選んでください。未登録なら先に材料を登録できます。",
              );
              return;
            }
            const entry = {
              id: `offcut-${Date.now()}-${Math.random().toString(36).slice(2)}`,
              catalogId: registered.id,
              materialName: registered.name,
              specification: registered.specification,
              length: numberValue(data, "length"),
              quantity: numberValue(data, "quantity"),
              location: textValue(data, "location"),
            };
            if (await run((current) => registerOffcut(current, entry), "端材を登録しました"))
              form.reset();
          }}
        >
          <div className="grid grid-cols-2 gap-3">
            <label className="text-sm">
              端材の実測長さ (mm)
              <input name="length" inputMode="decimal" className={inputClass} />
            </label>
            <label className="text-sm">
              登録本数
              <input name="quantity" inputMode="numeric" defaultValue="1" className={inputClass} />
            </label>
          </div>
          <label className="block text-sm">
            保管場所（任意）
            <input name="location" placeholder="例：棚A" className={inputClass} />
          </label>
          <button disabled={busy} className={primaryClass}>
            端材を登録する
          </button>
        </form>
      </details>
      <div>
        <h3 className="font-black">今回使う端材</h3>
        <p className="mt-1 break-words text-sm">
          材料：{material.name || "未入力"} ／ 規格：{material.specification || "未入力"}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          案件で選んでいる材料・規格の端材だけ表示します。選んだ本数を上限に端材を先に使い、不足分を定尺材で補います。ここでは取り置きしません。
        </p>
      </div>
      <form
        id="offcut-selection"
        className="space-y-2"
        onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          const selections = matching
            .filter((entry) => data.has(`use-${entry.id}`))
            .map((entry) => ({
              id: entry.id,
              length: entry.length,
              quantity: String(numberValue(data, `qty-${entry.id}`)),
            }));
          setError(onSelect(selections));
        }}
      >
        {!matching.length && (
          <p className="rounded-xl bg-background p-3 text-sm">一致する端材の在庫はありません。</p>
        )}
        {matching.map((entry) => {
          const selected = material.offcuts?.find((item) => item.id === entry.id);
          return (
            <div
              key={`${entry.id}:${entry.quantity}`}
              className="rounded-xl border border-border bg-background p-3"
            >
              <label className="flex min-h-11 items-center gap-3 font-bold">
                <input
                  type="checkbox"
                  name={`use-${entry.id}`}
                  defaultChecked={Boolean(selected)}
                  disabled={locked}
                  className="h-6 w-6"
                />
                {entry.length.toLocaleString()}mm・在庫{entry.quantity}本
              </label>
              <p className="text-xs text-muted-foreground">
                保管場所：{entry.location || "未指定"}
              </p>
              <label className="mt-2 block text-sm">
                今回使える本数
                <input
                  name={`qty-${entry.id}`}
                  aria-label={`${entry.length}mmの使用上限本数 ${entry.location}`}
                  inputMode="numeric"
                  defaultValue={selected?.quantity ?? String(entry.quantity)}
                  disabled={locked}
                  className={inputClass}
                />
              </label>
            </div>
          );
        })}
      </form>
      <details className="rounded-xl border border-border p-3">
        <summary className="min-h-11 cursor-pointer py-2 font-bold">
          全材料の端材・実数の修正（{bank.entries.filter((entry) => entry.quantity > 0).length}件）
        </summary>
        <p className="my-2 text-xs text-muted-foreground">
          廃棄した場合や数え直した場合に、実際に残っている本数へ修正します。0本で在庫なしになります。
        </p>
        {bank.entries.map((entry) => (
          <form
            key={`${entry.id}:${entry.quantity}`}
            className="mt-3 space-y-2 rounded-xl bg-background p-3"
            onSubmit={async (event) => {
              event.preventDefault();
              const quantity = numberValue(new FormData(event.currentTarget), "quantity");
              await run(
                (current) => adjustOffcut(current, entry.id, quantity),
                "在庫本数を修正しました",
              );
            }}
          >
            <p className="break-words text-sm font-bold">
              材料：{entry.materialName}
              <br />
              規格：{entry.specification}
              <br />
              {entry.length.toLocaleString()}mm ／ {entry.location || "場所未指定"}
            </p>
            <label className="block text-sm">
              実際の在庫本数
              <input
                name="quantity"
                inputMode="numeric"
                defaultValue={entry.quantity}
                className={inputClass}
              />
            </label>
            <button disabled={busy} className={buttonClass}>
              この本数に修正
            </button>
          </form>
        ))}
      </details>
    </DialogFrame>
  );
}

export function CuttingCompletionDialog({
  bank,
  material,
  calculation,
  onClose,
  onComplete,
}: {
  bank: OffcutBank;
  material: ProjectMaterial;
  calculation: ProjectMaterialCalculation;
  onClose: () => void;
  onComplete: (retained: RetainedOffcut[]) => Promise<string | null>;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [retained, setRetained] = useState<RetainedOffcut[]>([]);
  const result = calculation.result!;
  const candidates = getOffcutCandidates(result, Number(material.kerf));
  const readRetained = (form: HTMLFormElement) => {
    const data = new FormData(form);
    return candidates.flatMap((candidate, index): RetainedOffcut[] =>
      data.has(`keep-${index}`)
        ? [
            {
              candidateLength: candidate.length,
              length: numberValue(data, `length-${index}`),
              quantity: numberValue(data, `qty-${index}`),
              location: textValue(data, "location"),
            },
          ]
        : [],
    );
  };
  const preview = (() => {
    try {
      return {
        changes: previewCuttingCompletion(bank, material, calculation, retained),
        error: null,
      };
    } catch (failure) {
      return {
        changes: [],
        error: failure instanceof Error ? failure.message : "在庫を確認できません。",
      };
    }
  })();
  return (
    <DialogFrame
      title="切断完了・残す端材の確認"
      onClose={onClose}
      busy={busy}
      footer={
        <>
          {(error || preview.error) && (
            <p role="alert" className="text-sm text-destructive">
              {error || preview.error}
            </p>
          )}
          <div className="grid grid-cols-2 gap-2">
            <button disabled={busy} onClick={onClose} className={buttonClass}>
              キャンセル
            </button>
            <button
              form="complete-cutting"
              disabled={busy || Boolean(preview.error)}
              className={primaryClass}
            >
              {busy ? "保存中…" : "切断完了して在庫更新"}
            </button>
          </div>
        </>
      }
    >
      <p className="font-bold">
        {material.name || "選択中の材料"} ／ {material.specification}
      </p>
      <p className="text-sm">
        全{result.bars.reduce((sum, bar) => sum + bar.pieces.length, 0)}
        本を、この計画どおり切り終えた場合だけ実行してください。使用した端材と手持ち定尺の本数を減らします。完了後はこの材料の条件を固定します。
      </p>
      <p className="rounded-xl bg-primary/10 p-3 text-sm">
        残して保管する端材にチェックしてください。表示寸法は最後の切り離し分の刃厚も差し引いた目安です。実物を測り、短ければ長さを修正してください。チェックしない分は登録しません。
      </p>
      <form
        id="complete-cutting"
        className="space-y-3"
        onChange={(event) => {
          setRetained(readRetained(event.currentTarget));
          setError(null);
        }}
        onSubmit={async (event) => {
          event.preventDefault();
          if (busy) return;
          const retained = readRetained(event.currentTarget);
          setBusy(true);
          setError(await onComplete(retained));
          setBusy(false);
        }}
      >
        <label className="block text-sm">
          残す端材の保管場所（任意）
          <input name="location" placeholder="例：棚A" className={inputClass} />
        </label>
        {!candidates.length && <p className="text-sm">登録できる長さの端材はありません。</p>}
        {candidates.map((candidate, index) => (
          <div key={candidate.length} className="rounded-xl border border-border bg-background p-3">
            <label className="flex min-h-11 items-center gap-3 font-bold">
              <input name={`keep-${index}`} type="checkbox" className="h-6 w-6" />
              {candidate.length.toLocaleString()}mm・{candidate.quantity}本から残す
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label className="text-sm">
                実測長さ (mm)
                <input
                  name={`length-${index}`}
                  inputMode="decimal"
                  defaultValue={candidate.length}
                  className={inputClass}
                />
              </label>
              <label className="text-sm">
                残す本数
                <input
                  name={`qty-${index}`}
                  inputMode="numeric"
                  defaultValue={candidate.quantity}
                  className={inputClass}
                />
              </label>
            </div>
          </div>
        ))}
      </form>
      {!preview.error && <InventoryChanges changes={preview.changes} />}
    </DialogFrame>
  );
}
