import { ChevronRight } from "lucide-react";

/**
 * heading_path は「就業規則 > 第4章 休暇 > 第22条 年次有給休暇」の形で入る。
 * パンくず表示にすることで「チャンクが文書のどこから来たか」が一目で分かり、
 * 回答の出典表示の説得力に直結する。
 */
export function HeadingPath({ path }: { path: string | null }) {
  if (!path) {
    return <span className="text-xs text-ink-400">（見出しなし）</span>;
  }

  const parts = path
    .split(">")
    .map((p) => p.trim())
    .filter(Boolean);

  return (
    <span className="inline-flex flex-wrap items-center gap-0.5 text-xs">
      {parts.map((part, i) => (
        <span key={`${part}-${i}`} className="inline-flex items-center gap-0.5">
          {i > 0 && (
            <ChevronRight
              className="size-3 shrink-0 text-ink-300"
              aria-hidden
            />
          )}
          <span
            className={
              i === parts.length - 1
                ? "font-medium text-ink-700"
                : "text-ink-500"
            }
          >
            {part}
          </span>
        </span>
      ))}
    </span>
  );
}
