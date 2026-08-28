import { Fragment, type ReactNode } from "react";
import { EmptyState } from "@/components/ui";
import { cn } from "@/lib/utils";

export type Column<T> = {
  /** React の key 用。列の識別子 */
  key: string;
  header: ReactNode;
  align?: "left" | "right";
  /** 列幅の指定など。w-* / whitespace-* をここで足す */
  className?: string;
  cell: (row: T) => ReactNode;
};

/**
 * 管理画面のテーブルは6画面で繰り返し出てくるので、見た目と空状態をここに集約する。
 *
 * subRow は「行の直下に補足を出したい」ケース（取り込み失敗のエラーメッセージ、
 * 未回答質問の展開フォームなど）のためのもの。<td colSpan> で1行分を占有する。
 */
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  emptyTitle,
  emptyDescription,
  subRow,
}: {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string | number;
  emptyTitle: string;
  emptyDescription?: string;
  subRow?: (row: T) => ReactNode;
}) {
  if (rows.length === 0) {
    return <EmptyState title={emptyTitle} description={emptyDescription} />;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-ink-200 bg-ink-50">
            {columns.map((c) => (
              <th
                key={c.key}
                scope="col"
                className={cn(
                  "px-4 py-2.5 text-left text-xs font-medium whitespace-nowrap text-ink-500",
                  c.align === "right" && "text-right",
                  c.className,
                )}
              >
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const extra = subRow?.(row);
            return (
              <Fragment key={rowKey(row)}>
                <tr
                  className={cn(
                    "align-top",
                    extra ? "border-b-0" : "border-b border-ink-100",
                  )}
                >
                  {columns.map((c) => (
                    <td
                      key={c.key}
                      className={cn(
                        "px-4 py-3 text-ink-700",
                        c.align === "right" && "text-right tabular-nums",
                        c.className,
                      )}
                    >
                      {c.cell(row)}
                    </td>
                  ))}
                </tr>
                {extra && (
                  <tr className="border-b border-ink-100">
                    <td colSpan={columns.length} className="px-4 pb-3">
                      {extra}
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
