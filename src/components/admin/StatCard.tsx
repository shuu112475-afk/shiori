import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * サマリー数値の並び。運用画面は「まず数字、次に明細」の順で見せると
 * 状況把握が速いので、各画面の先頭に置く。
 */
export function StatGrid({
  columns = 4,
  children,
}: {
  columns?: 3 | 4 | 5;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "grid gap-3",
        columns === 3 && "grid-cols-1 sm:grid-cols-3",
        columns === 4 && "grid-cols-2 lg:grid-cols-4",
        columns === 5 && "grid-cols-2 lg:grid-cols-5",
      )}
    >
      {children}
    </div>
  );
}

export function StatCard({
  label,
  value,
  hint,
  tone = "default",
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  tone?: "default" | "ok" | "warn" | "danger";
}) {
  return (
    <div className="rounded-xl border border-ink-200 bg-white px-4 py-3 shadow-sm">
      <p className="text-xs font-medium text-ink-500">{label}</p>
      <p
        className={cn(
          "mt-1 text-2xl font-semibold tabular-nums",
          tone === "default" && "text-ink-900",
          tone === "ok" && "text-ok-600",
          tone === "warn" && "text-warn-600",
          tone === "danger" && "text-danger-600",
        )}
      >
        {value}
      </p>
      {hint && <p className="mt-0.5 text-xs text-ink-400">{hint}</p>}
    </div>
  );
}
