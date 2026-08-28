"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Badge, Button, Card, CardHeader, Textarea } from "@/components/ui";
import { DataTable, type Column } from "@/components/admin/DataTable";
import { toggleFaq, updateFaq } from "@/app/admin/unanswered/actions";
import { formatDateTime } from "@/lib/utils";

export type FaqItem = {
  id: string;
  question: string;
  answer: string;
  enabled: boolean;
  hitCount: number;
  createdAt: string;
  authorName: string;
};

/**
 * 登録済み FAQ の一覧・編集。
 * hit_count は「その FAQ が実際に使われた回数」＝運用の成果指標なので目立たせる。
 */
export function FaqManager({ items }: { items: FaqItem[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const [editingId, setEditingId] = useState<string | null>(null);
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [error, setError] = useState<string | null>(null);

  function startEdit(item: FaqItem) {
    setEditingId(item.id);
    setQuestion(item.question);
    setAnswer(item.answer);
    setError(null);
  }

  function save(item: FaqItem) {
    setError(null);
    startTransition(async () => {
      const result = await updateFaq({ faqId: item.id, question, answer });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setEditingId(null);
      router.refresh();
    });
  }

  function toggle(item: FaqItem) {
    setError(null);
    startTransition(async () => {
      const result = await toggleFaq({
        faqId: item.id,
        enabled: !item.enabled,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  const totalHits = items.reduce((sum, i) => sum + i.hitCount, 0);
  const enabledCount = items.filter((i) => i.enabled).length;

  const columns: Column<FaqItem>[] = [
    {
      key: "question",
      header: "質問",
      className: "min-w-64",
      cell: (item) => (
        <div className="min-w-0">
          <p className="font-medium text-ink-900">{item.question}</p>
          <p className="mt-0.5 line-clamp-2 text-xs text-ink-500">
            {item.answer}
          </p>
        </div>
      ),
    },
    {
      key: "hits",
      header: "ヒット数",
      align: "right",
      cell: (item) => (
        <span
          className={
            item.hitCount > 0 ? "font-medium text-ok-600" : "text-ink-400"
          }
        >
          {item.hitCount.toLocaleString("ja-JP")}
        </span>
      ),
    },
    {
      key: "enabled",
      header: "状態",
      cell: (item) =>
        item.enabled ? (
          <Badge tone="ok">有効</Badge>
        ) : (
          <Badge tone="neutral">無効</Badge>
        ),
    },
    {
      key: "author",
      header: "登録者",
      cell: (item) => (
        <span className="text-xs text-ink-600">{item.authorName}</span>
      ),
    },
    {
      key: "createdAt",
      header: "登録日時",
      cell: (item) => (
        <span className="text-xs whitespace-nowrap text-ink-500">
          {formatDateTime(item.createdAt)}
        </span>
      ),
    },
    {
      key: "actions",
      header: "",
      align: "right",
      cell: (item) => (
        <div className="flex items-center justify-end gap-1">
          <Button
            variant="secondary"
            size="sm"
            disabled={pending}
            onClick={() =>
              editingId === item.id ? setEditingId(null) : startEdit(item)
            }
          >
            編集
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={pending}
            onClick={() => toggle(item)}
          >
            {item.enabled ? "無効にする" : "有効にする"}
          </Button>
        </div>
      ),
    },
  ];

  return (
    <Card>
      <CardHeader
        title={`登録済みFAQ（${items.length}件）`}
        description={`有効 ${enabledCount}件・累計 ${totalHits.toLocaleString("ja-JP")} 回この回答が使われました`}
      />
      <DataTable
        columns={columns}
        rows={items}
        rowKey={(item) => item.id}
        emptyTitle="FAQはまだありません"
        emptyDescription="上の未回答キューから「FAQとして回答を登録」すると、ここに並びます。"
        subRow={(item) =>
          editingId === item.id ? (
            <div className="space-y-3 rounded-lg border border-ink-200 bg-ink-50 p-4">
              <div>
                <label
                  htmlFor={`faq-q-${item.id}`}
                  className="text-xs font-medium text-ink-700"
                >
                  質問文（変更すると照合用のベクトルを作り直します）
                </label>
                <Textarea
                  id={`faq-q-${item.id}`}
                  rows={2}
                  value={question}
                  onChange={(e) => setQuestion(e.target.value)}
                  className="mt-1"
                />
              </div>
              <div>
                <label
                  htmlFor={`faq-a-${item.id}`}
                  className="text-xs font-medium text-ink-700"
                >
                  回答本文
                </label>
                <Textarea
                  id={`faq-a-${item.id}`}
                  rows={5}
                  value={answer}
                  onChange={(e) => setAnswer(e.target.value)}
                  className="mt-1"
                />
              </div>
              {error && <p className="text-xs text-danger-600">{error}</p>}
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  disabled={pending || !question.trim() || !answer.trim()}
                  onClick={() => save(item)}
                >
                  {pending ? "保存中…" : "保存"}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={pending}
                  onClick={() => setEditingId(null)}
                >
                  キャンセル
                </Button>
              </div>
            </div>
          ) : null
        }
      />
    </Card>
  );
}
