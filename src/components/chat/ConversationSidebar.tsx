"use client";

import Link from "next/link";
import { MessageSquare, Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ConversationSummary } from "./types";

type Props = {
  conversations: ConversationSummary[];
  activeId?: string;
};

/** 日付だけの軽い見出し。時刻まで出すと一覧が読みにくい */
function formatDay(iso: string): string {
  return new Date(iso).toLocaleDateString("ja-JP", {
    month: "numeric",
    day: "numeric",
  });
}

export function ConversationSidebar({ conversations, activeId }: Props) {
  return (
    <aside className="hidden w-60 shrink-0 flex-col border-r border-ink-200 bg-white lg:flex">
      <div className="p-3">
        <Link
          href="/chat"
          className="flex h-9 w-full items-center justify-center gap-1.5 rounded-lg bg-brand-600 text-sm font-medium text-white transition-colors hover:bg-brand-700"
        >
          <Plus className="size-4" />
          新しい会話
        </Link>
      </div>

      <p className="px-4 pb-1 text-[11px] font-medium text-ink-400">履歴</p>

      <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {conversations.length === 0 ? (
          <p className="px-2 py-6 text-center text-xs text-ink-400">
            まだ会話がありません
          </p>
        ) : (
          <ul className="space-y-0.5">
            {conversations.map((c) => {
              const active = c.id === activeId;
              return (
                <li key={c.id}>
                  <Link
                    href={`/chat/${c.id}`}
                    className={cn(
                      "flex items-start gap-2 rounded-lg px-2 py-2 text-xs transition-colors",
                      active
                        ? "bg-brand-50 text-brand-700"
                        : "text-ink-600 hover:bg-ink-100",
                    )}
                  >
                    <MessageSquare
                      className={cn(
                        "mt-0.5 size-3.5 shrink-0",
                        active ? "text-brand-600" : "text-ink-400",
                      )}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{c.title}</span>
                      <span className="block text-[10px] text-ink-400">
                        {formatDay(c.created_at)}
                      </span>
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </nav>
    </aside>
  );
}
