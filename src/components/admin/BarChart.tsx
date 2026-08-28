import { EmptyState } from "@/components/ui";

export type BarDatum = { label: string; value: number };

/**
 * 日別推移の棒グラフ。
 *
 * recharts などを入れれば見栄えはするが、この程度の表現のために
 * バンドルサイズと依存を増やす価値はないので div の高さだけで描く。
 * 高さは「最大値を 100% とした相対値」。0 件の日も棒の土台を残して
 * 「データが無い」と「その日が0件だった」を区別できるようにしている。
 */
export function BarChart({
  data,
  height = 140,
  unit = "件",
}: {
  data: BarDatum[];
  height?: number;
  unit?: string;
}) {
  if (data.length === 0) {
    return <EmptyState title="表示できるデータがありません" />;
  }

  const max = Math.max(...data.map((d) => d.value), 1);

  return (
    <div className="px-5 py-4">
      <div className="flex items-end gap-1" style={{ height }}>
        {data.map((d) => {
          const ratio = d.value / max;
          return (
            <div
              key={d.label}
              className="group relative flex min-w-0 flex-1 flex-col justify-end"
              style={{ height: "100%" }}
              title={`${d.label}: ${d.value}${unit}`}
            >
              <div
                className="rounded-t-sm bg-brand-500 transition-colors group-hover:bg-brand-700"
                style={{
                  // 1件でも視認できるよう最低 2px を確保する
                  height: d.value === 0 ? 2 : `max(2px, ${ratio * 100}%)`,
                  backgroundColor:
                    d.value === 0 ? "var(--color-ink-200)" : undefined,
                }}
              />
            </div>
          );
        })}
      </div>
      {/* 日付ラベルは全部出すと潰れるので両端だけ。詳細は棒の title 属性に持たせる */}
      <div className="mt-2 flex justify-between text-xs text-ink-400">
        <span>{data[0]?.label}</span>
        <span>
          最大 {max}
          {unit}／日
        </span>
        <span>{data[data.length - 1]?.label}</span>
      </div>
    </div>
  );
}
