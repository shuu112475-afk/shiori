import Link from "next/link";
import { cn } from "@/lib/utils";

export type FilterOption = {
  label: string;
  href: string;
  active: boolean;
  count?: number;
};

/**
 * 期間・状態の絞り込み。
 * useState ではなく URL（searchParams）に状態を置くので、
 * 「この条件の画面」をそのまま同僚に共有・ブックマークできる。
 */
export function FilterTabs({ options }: { options: FilterOption[] }) {
  return (
    <div className="inline-flex items-center rounded-lg border border-ink-200 bg-white p-0.5">
      {options.map((o) => (
        <Link
          key={o.href}
          href={o.href}
          scroll={false}
          className={cn(
            "inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-xs font-medium transition-colors",
            o.active
              ? "bg-brand-600 text-white"
              : "text-ink-600 hover:bg-ink-100",
          )}
        >
          {o.label}
          {o.count != null && (
            <span
              className={cn(
                "tabular-nums",
                o.active ? "text-brand-100" : "text-ink-400",
              )}
            >
              {o.count}
            </span>
          )}
        </Link>
      ))}
    </div>
  );
}
