"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CircleCheckBig, Plus } from "lucide-react";
import { Badge, Button, Card, CardHeader, Textarea } from "@/components/ui";
import { DataTable, type Column } from "@/components/admin/DataTable";
import {
  resolveWithFaq,
  setUnansweredResolved,
} from "@/app/admin/unanswered/actions";
import { formatDateTime } from "@/lib/utils";

export type UnansweredItem = {
  id: string;
  query: string;
  topScore: number | null;
  askerName: string;
  createdAt: string;
  resolved: boolean;
  faqOverrideId: string | null;
};

/**
 * 類似度は「なぜ答えられなかったか」の唯一の手がかりなので、
 * 数値をそのまま出したうえで色でも分かるようにする。
 * 閾値 0.35（RAG_ANSWER_THRESHOLD の既定値）を下回ると回答が拒否される。
 */
function ScoreBadge({ score }: { score: number | null }) {
  if (score == null) return <span className="text-xs text-ink-400">-</span>;
  const percent = `${(score * 100).toFixed(1)}%`;
  if (score < 0.25) return <Badge tone="danger">{percent}</Badge>;
  if (score < 0.35) return <Badge tone="warn">{percent}</Badge>;
  return <Badge tone="neutral">{percent}</Badge>;
}

export function UnansweredQueue({ items }: { items: UnansweredItem[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const [openId, setOpenId] = useState<string | null>(null);
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [successId, setSuccessId] = useState<string | null>(null);

  function open(item: UnansweredItem) {
    setOpenId(item.id);
    // 質問文はそのままだと口語で揺れているので、FAQ の見出しとして直せる状態で開く
    setQuestion(item.query);
    setAnswer("");
    setError(null);
    setSuccessId(null);
  }

  function save(item: UnansweredItem) {
    setError(null);
    startTransition(async () => {
      const result = await resolveWithFaq({
        unansweredId: item.id,
        question,
        answer,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setOpenId(null);
      setSuccessId(item.id);
      router.refresh();
    });
  }

  function changeStatus(item: UnansweredItem, resolved: boolean) {
    setError(null);
    startTransition(async () => {
      const result = await setUnansweredResolved({
        unansweredId: item.id,
        resolved,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  const columns: Column<UnansweredItem>[] = [
    {
      key: "query",
      header: "質問文",
      className: "min-w-64",
      cell: (item) => (
        <div className="min-w-0">
          <p className="text-ink-900">{item.query}</p>
          {successId === item.id && (
            <p className="mt-1 flex items-center gap-1 text-xs text-ok-600">
              <CircleCheckBig className="size-3.5" aria-hidden />
              FAQに登録しました。次から同じ質問には検索せず即答します。
            </p>
          )}
        </div>
      ),
    },
    {
      key: "score",
      header: "類似度",
      cell: (item) => <ScoreBadge score={item.topScore} />,
    },
    {
      key: "asker",
      header: "質問者",
      cell: (item) => (
        <span className="text-xs text-ink-600">{item.askerName}</span>
      ),
    },
    {
      key: "createdAt",
      header: "日時",
      cell: (item) => (
        <span className="text-xs whitespace-nowrap text-ink-500">
          {formatDateTime(item.createdAt)}
        </span>
      ),
    },
    {
      key: "status",
      header: "状態",
      cell: (item) =>
        item.resolved ? (
          <Badge tone="ok">
            {item.faqOverrideId ? "FAQ登録済み" : "対応済み"}
          </Badge>
        ) : (
          <Badge tone="warn">未対応</Badge>
        ),
    },
    {
      key: "actions",
      header: "",
      align: "right",
      cell: (item) =>
        item.resolved ? (
          <Button
            variant="ghost"
            size="sm"
            disabled={pending}
            onClick={() => changeStatus(item, false)}
          >
            差し戻す
          </Button>
        ) : (
          <div className="flex items-center justify-end gap-1">
            <Button
              size="sm"
              disabled={pending}
              onClick={() =>
                openId === item.id ? setOpenId(null) : open(item)
              }
            >
              <Plus className="size-3.5" aria-hidden />
              FAQとして回答を登録
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={pending}
              onClick={() => changeStatus(item, true)}
            >
              対応不要
            </Button>
          </div>
        ),
    },
  ];

  return (
    <Card>
      <CardHeader
        title={`未回答の質問（${items.length}件）`}
        description="AIが「社内文書に根拠が無い」と判断して回答を拒否した質問です。未対応を上に並べています。"
      />
      <DataTable
        columns={columns}
        rows={items}
        rowKey={(item) => item.id}
        emptyTitle="未回答の質問はありません"
        emptyDescription="社員からの質問すべてに、社内文書だけで回答できています。"
        subRow={(item) =>
          openId === item.id ? (
            <div className="rounded-lg border border-brand-200 bg-brand-50 p-4">
              <p className="text-xs text-brand-700">
                ここで登録した回答は、質問文をベクトル化して保存されます。次回以降、
                似た質問（類似度 0.92 以上）が来ると
                <span className="font-medium">
                  検索も生成も行わずこの回答をそのまま返します
                </span>
                。回答が安定し、応答も速く、コストもかかりません。
              </p>

              <div className="mt-3 space-y-3">
                <div>
                  <label
                    htmlFor={`q-${item.id}`}
                    className="text-xs font-medium text-ink-700"
                  >
                    質問文（照合のキーになります。口語のままより一般化した表現が効きます）
                  </label>
                  <Textarea
                    id={`q-${item.id}`}
                    rows={2}
                    value={question}
                    onChange={(e) => setQuestion(e.target.value)}
                    className="mt-1"
                  />
                </div>
                <div>
                  <label
                    htmlFor={`a-${item.id}`}
                    className="text-xs font-medium text-ink-700"
                  >
                    回答本文
                  </label>
                  <Textarea
                    id={`a-${item.id}`}
                    rows={5}
                    value={answer}
                    onChange={(e) => setAnswer(e.target.value)}
                    placeholder="社内の正式な回答を書いてください。ここに書いた文章がそのまま社員に返ります。"
                    className="mt-1"
                  />
                </div>

                {error && <p className="text-xs text-danger-600">{error}</p>}

                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    disabled={pending || !answer.trim() || !question.trim()}
                    onClick={() => save(item)}
                  >
                    {pending ? "登録中…" : "FAQに登録して解決にする"}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={pending}
                    onClick={() => setOpenId(null)}
                  >
                    キャンセル
                  </Button>
                </div>
              </div>
            </div>
          ) : null
        }
      />
    </Card>
  );
}
