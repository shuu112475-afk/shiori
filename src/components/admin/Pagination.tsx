import Link from "next/link";
import { cn } from "@/lib/utils";

/**
 * 件数が多いテーブル用の最小限のページャ。
 * ページ番号は searchParams に持たせる（Next 16 では await が必要な点に注意）。
 */
export function Pagination({
  page,
  totalPages,
  total,
  hrefFor,
}: {
  page: number;
  totalPages: number;
  total: number;
  hrefFor: (page: number) => string;
}) {
  if (totalPages <= 1) return null;

  const prev = Math.max(1, page - 1);
  const next = Math.min(totalPages, page + 1);

  const linkClass =
    "inline-flex h-8 items-center rounded-md border border-ink-300 bg-white px-3 text-xs font-medium text-ink-700 hover:bg-ink-100";
  const disabledClass =
    "inline-flex h-8 cursor-not-allowed items-center rounded-md border border-ink-200 bg-ink-50 px-3 text-xs font-medium text-ink-400";

  return (
    <div className="flex items-center justify-between border-t border-ink-200 px-5 py-3">
      <p className="text-xs text-ink-500">
        全 {total.toLocaleString("ja-JP")} 件中 {page} / {totalPages} ページ
      </p>
      <div className="flex items-center gap-2">
        {page > 1 ? (
          <Link href={hrefFor(prev)} className={linkClass}>
            前へ
          </Link>
        ) : (
          <span className={disabledClass}>前へ</span>
        )}
        {page < totalPages ? (
          <Link href={hrefFor(next)} className={linkClass}>
            次へ
          </Link>
        ) : (
          <span className={cn(disabledClass)}>次へ</span>
        )}
      </div>
    </div>
  );
}
