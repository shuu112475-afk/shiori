import { Card, Spinner } from "@/components/ui";

/**
 * Suspense の fallback。
 * Next 16 はデフォルト非キャッシュなので、DB を読むセクションは Suspense で包み、
 * 画面の枠だけ先に出す。ここはその「枠」に相当する。
 */
export function CardSkeleton({
  label = "読み込み中",
  rows = 4,
}: {
  label?: string;
  rows?: number;
}) {
  return (
    <Card>
      <div className="flex items-center gap-2 border-b border-ink-200 px-5 py-4 text-sm text-ink-500">
        <Spinner />
        {label}
      </div>
      <div className="space-y-2 px-5 py-4">
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className="h-8 animate-pulse rounded-md bg-ink-100" />
        ))}
      </div>
    </Card>
  );
}

export function StatSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          className="h-20 animate-pulse rounded-xl border border-ink-200 bg-white"
        />
      ))}
    </div>
  );
}
