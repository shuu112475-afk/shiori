import { Suspense } from "react";
import { ThumbsDown, ThumbsUp } from "lucide-react";
import { requireAdmin } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import type { FeedbackVerdict, Profile } from "@/lib/types";
import { formatDateTime } from "@/lib/utils";
import { Badge, Card, CardHeader } from "@/components/ui";
import { AdminContainer, PageHeader } from "@/components/admin/PageHeader";
import { DataTable, type Column } from "@/components/admin/DataTable";
import { StatCard, StatGrid } from "@/components/admin/StatCard";
import { CardSkeleton, StatSkeleton } from "@/components/admin/Skeletons";
import { FilterTabs } from "@/components/admin/FilterTabs";

export const metadata = { title: "評価一覧 — Shiori" };

type VerdictFilter = "all" | "good" | "bad";

function parseVerdict(value: string | string[] | undefined): VerdictFilter {
  const v = Array.isArray(value) ? value[0] : value;
  return v === "good" || v === "bad" ? v : "all";
}

export default async function FeedbackPage(
  props: PageProps<"/admin/feedback">,
) {
  const sp = await props.searchParams;
  const verdict = parseVerdict(sp.verdict);

  const session = await requireAdmin();

  return (
    <AdminContainer>
      <PageHeader
        title="評価"
        description="回答に対する社員の👍/👎です。👎とコメントは、ドキュメントの不足やFAQ化すべき論点を見つける手がかりになります。"
      />

      <div className="space-y-6">
        <Suspense fallback={<StatSkeleton count={3} />}>
          <FeedbackSummary orgId={session.profile.org_id} />
        </Suspense>

        <Suspense fallback={<CardSkeleton label="評価を読み込み中" />}>
          <FeedbackList orgId={session.profile.org_id} verdict={verdict} />
        </Suspense>
      </div>
    </AdminContainer>
  );
}

/**
 * feedback には管理者向けの閲覧専用ポリシー（feedback_admin_read）があるので、
 * service role ではなくログインユーザーの権限で読む。
 * org_id の絞り込みはRLSと二重になるが、ポリシーを将来ゆるめたときの保険として残す。
 */
async function fetchCounts(orgId: string) {
  const supabase = await createClient();
  const [good, bad] = await Promise.all([
    supabase
      .from("feedback")
      .select("id", { count: "exact", head: true })
      .eq("org_id", orgId)
      .eq("verdict", "good"),
    supabase
      .from("feedback")
      .select("id", { count: "exact", head: true })
      .eq("org_id", orgId)
      .eq("verdict", "bad"),
  ]);
  return { good: good.count ?? 0, bad: bad.count ?? 0 };
}

async function FeedbackSummary({ orgId }: { orgId: string }) {
  const { good, bad } = await fetchCounts(orgId);
  const total = good + bad;
  const rate = total ? Math.round((good / total) * 100) : 0;

  return (
    <StatGrid columns={3}>
      <StatCard
        label="👍 高評価"
        value={good.toLocaleString("ja-JP")}
        tone="ok"
      />
      <StatCard
        label="👎 低評価"
        value={bad.toLocaleString("ja-JP")}
        tone={bad > 0 ? "danger" : "default"}
      />
      <StatCard
        label="満足率"
        value={total ? `${rate}%` : "-"}
        hint={
          total
            ? `評価 ${total.toLocaleString("ja-JP")} 件`
            : "まだ評価がありません"
        }
        tone={
          total === 0
            ? "default"
            : rate >= 80
              ? "ok"
              : rate >= 60
                ? "warn"
                : "danger"
        }
      />
    </StatGrid>
  );
}

type FeedbackItem = {
  id: number;
  verdict: FeedbackVerdict;
  comment: string | null;
  createdAt: string;
  userName: string;
  question: string;
  answer: string;
};

async function FeedbackList({
  orgId,
  verdict,
}: {
  orgId: string;
  verdict: VerdictFilter;
}) {
  const supabase = await createClient();

  let query = supabase
    .from("feedback")
    .select("id, message_id, user_id, verdict, comment, created_at")
    .eq("org_id", orgId)
    .order("created_at", { ascending: false })
    .limit(200);

  if (verdict !== "all") query = query.eq("verdict", verdict);

  const { data: feedbackRows } = await query.returns<
    {
      id: number;
      message_id: string;
      user_id: string;
      verdict: FeedbackVerdict;
      comment: string | null;
      created_at: string;
    }[]
  >();

  const rows = feedbackRows ?? [];
  const messageIds = rows.map((r) => r.message_id);

  // 評価対象（assistant のメッセージ）を引く
  type AnswerMessage = {
    id: string;
    conversation_id: string;
    content: string;
    created_at: string;
  };
  let answers: AnswerMessage[] = [];
  if (messageIds.length) {
    const { data } = await supabase
      .from("messages")
      .select("id, conversation_id, content, created_at")
      .in("id", messageIds)
      .returns<AnswerMessage[]>();
    answers = data ?? [];
  }

  const answerById = new Map(answers.map((m) => [m.id, m]));
  const conversationIds = Array.from(
    new Set(answers.map((m) => m.conversation_id)),
  );

  // 質問文は「同じ会話の中で、その回答より前にある最後の user メッセージ」。
  // messages には親子関係が無いので、時刻順で突き合わせて復元する。
  type QuestionMessage = {
    conversation_id: string;
    content: string;
    created_at: string;
  };
  let questions: QuestionMessage[] = [];
  if (conversationIds.length) {
    const { data } = await supabase
      .from("messages")
      .select("conversation_id, content, created_at")
      .in("conversation_id", conversationIds)
      .eq("role", "user")
      .order("created_at", { ascending: true })
      .returns<QuestionMessage[]>();
    questions = data ?? [];
  }

  const questionsByConv = new Map<
    string,
    { content: string; created_at: string }[]
  >();
  for (const q of questions) {
    const list = questionsByConv.get(q.conversation_id) ?? [];
    list.push({ content: q.content, created_at: q.created_at });
    questionsByConv.set(q.conversation_id, list);
  }

  // profiles は RLS 上も管理者から見えるので通常クライアントで足りる
  const { data: profiles } = await supabase
    .from("profiles")
    .select("id, display_name")
    .returns<Pick<Profile, "id" | "display_name">[]>();

  const nameById = new Map(
    (profiles ?? []).map((p) => [p.id, p.display_name ?? "(名称未設定)"]),
  );

  const items: FeedbackItem[] = rows.map((r) => {
    const answer = answerById.get(r.message_id);
    let question = "(質問を特定できませんでした)";
    if (answer) {
      const candidates = questionsByConv.get(answer.conversation_id) ?? [];
      const matched = [...candidates]
        .filter((q) => q.created_at <= answer.created_at)
        .pop();
      if (matched) question = matched.content;
    }
    return {
      id: r.id,
      verdict: r.verdict,
      comment: r.comment,
      createdAt: r.created_at,
      userName: nameById.get(r.user_id) ?? "不明なユーザー",
      question,
      answer: answer?.content ?? "(削除されたメッセージ)",
    };
  });

  const columns: Column<FeedbackItem>[] = [
    {
      key: "verdict",
      header: "評価",
      cell: (item) =>
        item.verdict === "good" ? (
          <Badge tone="ok">
            <ThumbsUp className="mr-1 size-3" aria-hidden />
            良い
          </Badge>
        ) : (
          <Badge tone="danger">
            <ThumbsDown className="mr-1 size-3" aria-hidden />
            悪い
          </Badge>
        ),
    },
    {
      key: "content",
      header: "質問と回答",
      className: "min-w-80",
      cell: (item) => (
        <div className="min-w-0 space-y-1.5">
          <p className="text-ink-900">{item.question}</p>
          <p className="line-clamp-3 rounded-md bg-ink-50 px-2.5 py-1.5 text-xs leading-relaxed text-ink-600">
            {item.answer}
          </p>
          {item.comment && (
            <p className="rounded-md bg-warn-50 px-2.5 py-1.5 text-xs text-warn-600">
              コメント: {item.comment}
            </p>
          )}
        </div>
      ),
    },
    {
      key: "user",
      header: "評価者",
      cell: (item) => (
        <span className="text-xs text-ink-600">{item.userName}</span>
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
  ];

  return (
    <div className="space-y-3">
      <FilterTabs
        options={[
          {
            label: "すべて",
            href: "/admin/feedback",
            active: verdict === "all",
          },
          {
            label: "👎 低評価のみ",
            href: "/admin/feedback?verdict=bad",
            active: verdict === "bad",
          },
          {
            label: "👍 高評価のみ",
            href: "/admin/feedback?verdict=good",
            active: verdict === "good",
          },
        ]}
      />

      <Card>
        <CardHeader
          title={`評価一覧（${items.length}件）`}
          description="直近200件を新しい順に表示しています。"
        />
        <DataTable
          columns={columns}
          rows={items}
          rowKey={(item) => item.id}
          emptyTitle="評価がありません"
          emptyDescription="チャット画面で回答に👍/👎を付けると、ここに集まります。"
        />
      </Card>
    </div>
  );
}
