/**
 * 監査ログの detail(jsonb) を折りたたんで見せる。
 * 開閉のためだけに Client Component にするのは無駄なので、
 * ネイティブの <details> を使って JS ゼロで済ませている。
 */
export function JsonDetails({
  value,
  summary = "詳細",
}: {
  value: unknown;
  summary?: string;
}) {
  if (value == null) return <span className="text-ink-400">-</span>;

  const json = JSON.stringify(value, null, 2);

  return (
    <details className="group">
      <summary className="cursor-pointer list-none text-xs font-medium text-brand-600 hover:text-brand-700">
        <span className="group-open:hidden">▸ {summary}</span>
        <span className="hidden group-open:inline">▾ {summary}</span>
      </summary>
      <pre className="mt-2 max-w-md overflow-x-auto rounded-lg bg-ink-900 px-3 py-2 text-[11px] leading-relaxed text-ink-100">
        {json}
      </pre>
    </details>
  );
}
