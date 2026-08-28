"use client";

import { useState } from "react";
import { ThumbsDown, ThumbsUp } from "lucide-react";
import { Button, Spinner, Textarea } from "@/components/ui";
import { cn } from "@/lib/utils";
import type { FeedbackVerdict } from "@/lib/types";

type Props = {
  messageId: string;
};

export function FeedbackButtons({ messageId }: Props) {
  const [verdict, setVerdict] = useState<FeedbackVerdict | null>(null);
  const [pending, setPending] = useState(false);
  const [comment, setComment] = useState("");
  const [commentSent, setCommentSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function post(next: FeedbackVerdict, body?: string) {
    setPending(true);
    setError(null);
    try {
      const res = await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messageId,
          verdict: next,
          comment: body?.trim() ? body.trim() : undefined,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error ?? "評価を送信できませんでした");
      }
      setVerdict(next);
      if (body !== undefined) setCommentSent(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "評価を送信できませんでした");
    } finally {
      setPending(false);
    }
  }

  function choose(next: FeedbackVerdict) {
    // 連打・同じ評価の再送を防ぐ
    if (pending || verdict === next) return;
    void post(next);
  }

  return (
    <div className="mt-2">
      <div className="flex items-center gap-1">
        <span className="mr-1 text-[11px] text-ink-400">
          この回答は役に立った？
        </span>
        <button
          type="button"
          onClick={() => choose("good")}
          disabled={pending}
          aria-label="役に立った"
          aria-pressed={verdict === "good"}
          className={cn(
            "rounded-md p-1.5 transition-colors disabled:opacity-50",
            verdict === "good"
              ? "bg-ok-50 text-ok-600"
              : "text-ink-400 hover:bg-ink-100 hover:text-ink-600",
          )}
        >
          <ThumbsUp className="size-3.5" />
        </button>
        <button
          type="button"
          onClick={() => choose("bad")}
          disabled={pending}
          aria-label="役に立たなかった"
          aria-pressed={verdict === "bad"}
          className={cn(
            "rounded-md p-1.5 transition-colors disabled:opacity-50",
            verdict === "bad"
              ? "bg-danger-50 text-danger-600"
              : "text-ink-400 hover:bg-ink-100 hover:text-ink-600",
          )}
        >
          <ThumbsDown className="size-3.5" />
        </button>
        {pending && <Spinner className="ml-1 size-3" />}
        {verdict && !pending && !error && (
          <span className="ml-1 text-[11px] text-ink-400">
            評価を記録しました
          </span>
        )}
      </div>

      {error && <p className="mt-1 text-[11px] text-danger-600">{error}</p>}

      {/* 低評価のときだけ理由を任意で聞く。改善キューの精度に直結するため */}
      {verdict === "bad" && !commentSent && (
        <div className="mt-2 max-w-md">
          <Textarea
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            rows={2}
            maxLength={500}
            placeholder="どこが期待と違いましたか？（任意）"
            className="text-xs"
          />
          <div className="mt-1 flex justify-end">
            <Button
              size="sm"
              variant="secondary"
              disabled={pending || comment.trim().length === 0}
              onClick={() => void post("bad", comment)}
            >
              理由を送信
            </Button>
          </div>
        </div>
      )}
      {commentSent && (
        <p className="mt-1 text-[11px] text-ink-400">
          ご意見ありがとうございます。管理画面で確認されます
        </p>
      )}
    </div>
  );
}
