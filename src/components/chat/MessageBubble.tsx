"use client";

import { Fragment, type ReactNode } from "react";
import { Badge, Spinner } from "@/components/ui";
import { cn } from "@/lib/utils";
import { CitationList } from "./CitationList";
import { FeedbackButtons } from "./FeedbackButtons";
import type { ChatMessage } from "./types";

type Props = {
  message: ChatMessage;
  onCitationClick?: (rank: number) => void;
};

/**
 * 本文中の `**強調**` と出典番号 `[1]` だけを React 要素に変換する。
 * Markdown パーサは依存を増やすので入れない。dangerouslySetInnerHTML も使わない。
 */
const TOKEN_PATTERN = /(\*\*[^*\n]+\*\*)|(\[(\d{1,2})\])/g;

function renderRichText(
  raw: string,
  onCitationClick?: (rank: number) => void,
): ReactNode[] {
  // 行頭の "- " / "* " だけ中黒に置き換える。改行は whitespace-pre-wrap で保つので触らない
  const text = raw.replace(/^[ \t]*[-*][ \t]+/gm, "・");

  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  TOKEN_PATTERN.lastIndex = 0;
  while ((match = TOKEN_PATTERN.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(
        <Fragment key={`t-${lastIndex}`}>
          {text.slice(lastIndex, match.index)}
        </Fragment>,
      );
    }

    if (match[1]) {
      nodes.push(
        <strong key={`b-${match.index}`} className="font-semibold">
          {match[1].slice(2, -2)}
        </strong>,
      );
    } else {
      const rank = Number(match[3]);
      nodes.push(
        <button
          key={`c-${match.index}`}
          type="button"
          className="citation-ref cursor-pointer hover:brightness-95"
          onClick={() => onCitationClick?.(rank)}
          title={`出典 ${rank} を表示`}
        >
          {rank}
        </button>,
      );
    }

    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    nodes.push(
      <Fragment key={`t-${lastIndex}`}>{text.slice(lastIndex)}</Fragment>,
    );
  }
  return nodes;
}

export function MessageBubble({ message, onCitationClick }: Props) {
  const isUser = message.role === "user";

  if (isUser) {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-brand-600 px-4 py-2.5 text-sm leading-relaxed text-white">
          {message.content}
        </div>
      </div>
    );
  }

  const refused = message.answered === false;
  const streaming = message.streaming === true;

  return (
    <div className="flex justify-start">
      <div className="w-full max-w-[92%]">
        <div
          className={cn(
            "rounded-2xl rounded-bl-sm border bg-white px-4 py-3",
            refused ? "border-warn-600/30 bg-warn-50" : "border-ink-200",
          )}
        >
          {refused && (
            <div className="mb-2 flex items-center gap-2">
              <Badge tone="warn">出典なし</Badge>
              <span className="text-[11px] text-warn-600">
                この質問は管理者の改善キューに送られました
              </span>
            </div>
          )}

          {message.content.length === 0 && streaming ? (
            <p className="flex items-center gap-2 text-sm text-ink-500">
              <Spinner />
              回答を作成しています…
            </p>
          ) : (
            <div className="whitespace-pre-wrap text-sm leading-7 text-ink-800">
              {renderRichText(message.content, onCitationClick)}
              {streaming && (
                <span className="ml-0.5 inline-block h-4 w-[2px] animate-pulse bg-ink-400 align-middle" />
              )}
            </div>
          )}

          {message.error && (
            <p className="mt-2 rounded-md bg-danger-50 px-2 py-1 text-xs text-danger-600">
              {message.error}
            </p>
          )}

          {/* 狭い画面では右パネルが出ないので、ここから出典をたどれるようにする */}
          {message.citations.length > 0 && (
            <div className="xl:hidden">
              <CitationList citations={message.citations} variant="inline" />
            </div>
          )}
        </div>

        {!streaming && (
          <div className="flex flex-wrap items-center gap-x-4 px-1">
            {/* 生成が終わったメッセージだけ評価できる（DBのidが確定しているため） */}
            {message.id && !message.id.startsWith("local-") && (
              <FeedbackButtons messageId={message.id} />
            )}
            {message.topScore != null && (
              <span className="mt-2 font-mono text-[10px] text-ink-400">
                top similarity {message.topScore.toFixed(3)}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
