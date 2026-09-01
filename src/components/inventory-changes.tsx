import type { InventoryChange } from "@/lib/offcut-bank";

export function InventoryChanges({
  changes,
  completed = false,
}: {
  changes: InventoryChange[];
  completed?: boolean;
}) {
  const usedOffcuts = changes
    .filter((item) => item.source === "offcut")
    .reduce((sum, item) => sum + item.used, 0);
  return (
    <section className="space-y-2 rounded-xl border border-accent/40 bg-accent/5 p-3">
      <h3 className="font-black">
        {completed ? "この作業で更新した在庫" : "完了すると在庫はこう変わります"}
      </h3>
      <p className="text-sm">
        端材バンクから{completed ? "使った" : "使う"}端材：{usedOffcuts}本
        {usedOffcuts === 0 && "（端材の減算なし）"}
      </p>
      {changes.map((item) => (
        <div key={`${item.source}:${item.id}`} className="rounded-lg bg-background p-3 text-sm">
          <p className="break-words font-bold">
            {item.source === "offcut" ? "端材" : "手持ち定尺"} {item.length.toLocaleString()}mm
            {item.location && ` ／ ${item.location}`}
          </p>
          <p className="mt-1">
            更新前 {item.before}本 − 使用 {item.used}本
            {item.added > 0 && ` ＋ 登録 ${item.added}本`} → <strong>残り {item.after}本</strong>
          </p>
        </div>
      ))}
      {!changes.length && (
        <p className="text-xs text-muted-foreground">更新する在庫はありません。</p>
      )}
      <p className="text-xs text-muted-foreground">
        {completed
          ? "完了時点の記録です。現在の端材本数は端材バンクで確認できます。"
          : "まだ在庫は変わりません。キャンセルすれば更新しません。"}
      </p>
    </section>
  );
}
