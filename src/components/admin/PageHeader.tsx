import type { ReactNode } from "react";

/**
 * 管理画面の共通レイアウト部品。
 *
 * AppShell の <main> は padding を持たない契約なので、余白はここで一元管理する。
 * 各画面が個別に max-w / px を書くと画面ごとに横幅がズレて「作りかけ」に見えるため、
 * 必ず AdminContainer を通すこと。
 */
export function AdminContainer({ children }: { children: ReactNode }) {
  return <div className="mx-auto max-w-6xl px-6 py-8">{children}</div>;
}

export function PageHeader({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight text-ink-900">
          {title}
        </h1>
        {description && (
          <p className="mt-1 max-w-2xl text-sm text-ink-500">{description}</p>
        )}
      </div>
      {action && (
        <div className="flex shrink-0 items-center gap-2">{action}</div>
      )}
    </div>
  );
}

/**
 * 「なぜこの画面がこう作られているか」を営業デモ中に口頭で説明しなくて済むよう、
 * 画面上に設計意図を書いておくための注記ブロック。
 */
export function NoteBox({
  icon,
  children,
}: {
  icon?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex gap-2.5 rounded-lg border border-brand-100 bg-brand-50 px-4 py-3 text-xs leading-relaxed text-brand-700">
      {icon && <span className="mt-0.5 shrink-0">{icon}</span>}
      <div className="min-w-0">{children}</div>
    </div>
  );
}
