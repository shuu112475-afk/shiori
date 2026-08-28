"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight, FileText } from "lucide-react";
import { Badge } from "@/components/ui";
import { cn } from "@/lib/utils";
import type { Citation } from "@/lib/types";

type Props = {
  citations: Citation[];
  /** panel = 右カラム常設 / inline = メッセージ直下の折りたたみ */
  variant?: "panel" | "inline";
  /** 本文の [n] がクリックされた出典。スクロール＋ハイライト対象 */
  activeRank?: number | null;
};

/** "第3章 > 休暇 > 年次有給休暇" をパンくず風に分解する */
function splitHeadingPath(path: string | null): string[] {
  if (!path) return [];
  return path
    .split(">")
    .map((s) => s.trim())
    .filter(Boolean);
}

function CitationCard({
  citation,
  active,
  registerRef,
}: {
  citation: Citation;
  active: boolean;
  registerRef?: (el: HTMLLIElement | null) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const crumbs = splitHeadingPath(citation.heading_path);

  return (
    <li
      ref={registerRef}
      className={cn(
        "rounded-lg border bg-white p-3 transition-colors",
        active
          ? "border-brand-500 ring-2 ring-brand-200"
          : "border-ink-200 hover:border-ink-300",
      )}
    >
      <div className="flex items-start gap-2">
        <Badge tone="brand" className="shrink-0 font-mono">
          [{citation.rank}]
        </Badge>
        <div className="min-w-0 flex-1">
          <p className="flex items-start gap-1.5 text-xs font-semibold text-ink-900">
            <FileText className="mt-0.5 size-3.5 shrink-0 text-ink-400" />
            <span className="break-words">{citation.document_title}</span>
          </p>

          {(crumbs.length > 0 || citation.page_no != null) && (
            <p className="mt-1 flex flex-wrap items-center gap-x-1 text-[11px] text-ink-500">
              {crumbs.map((crumb, i) => (
                <span key={`${crumb}-${i}`} className="flex items-center gap-1">
                  {i > 0 && <span className="text-ink-300">›</span>}
                  <span>{crumb}</span>
                </span>
              ))}
              {citation.page_no != null && (
                <span className="ml-1 rounded bg-ink-100 px-1 py-0.5 font-mono text-[10px] text-ink-600">
                  p.{citation.page_no}
                </span>
              )}
            </p>
          )}
        </div>
      </div>

      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="mt-2 w-full text-left"
        aria-expanded={expanded}
      >
        <p
          className={cn(
            "whitespace-pre-wrap text-[11px] leading-relaxed text-ink-600",
            !expanded && "line-clamp-3",
          )}
        >
          {citation.excerpt}
        </p>
        <span className="mt-1 inline-flex items-center gap-0.5 text-[10px] text-brand-600">
          {expanded ? (
            <ChevronDown className="size-3" />
          ) : (
            <ChevronRight className="size-3" />
          )}
          {expanded ? "抜粋を閉じる" : "抜粋を全文表示"}
        </span>
      </button>

      <p className="mt-1.5 font-mono text-[10px] text-ink-400">
        score {citation.score.toFixed(3)}
      </p>
    </li>
  );
}

export function CitationList({
  citations,
  variant = "panel",
  activeRank = null,
}: Props) {
  const [open, setOpen] = useState(false);
  // rank -> DOM。本文の [n] クリックで該当カードまでスクロールさせる
  const cardRefs = useRef(new Map<number, HTMLLIElement>());

  useEffect(() => {
    if (activeRank == null) return;
    cardRefs.current
      .get(activeRank)
      ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [activeRank]);

  if (citations.length === 0) return null;

  const cards = (
    <ul className="space-y-2">
      {citations.map((c) => (
        <CitationCard
          key={`${c.rank}-${c.chunk_id}`}
          citation={c}
          active={variant === "panel" && activeRank === c.rank}
          registerRef={(el) => {
            if (el) cardRefs.current.set(c.rank, el);
            else cardRefs.current.delete(c.rank);
          }}
        />
      ))}
    </ul>
  );

  if (variant === "inline") {
    return (
      <div className="mt-2">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="inline-flex items-center gap-1 text-xs font-medium text-brand-600 hover:text-brand-700"
          aria-expanded={open}
        >
          {open ? (
            <ChevronDown className="size-3.5" />
          ) : (
            <ChevronRight className="size-3.5" />
          )}
          出典 {citations.length} 件
        </button>
        {open && <div className="mt-2">{cards}</div>}
      </div>
    );
  }

  return cards;
}
