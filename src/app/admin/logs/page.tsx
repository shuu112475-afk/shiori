import { Suspense } from "react";
import { requireAdmin } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import type { Profile } from "@/lib/types";
import { estimateCostUsd, formatDateTime } from "@/lib/utils";
import { Badge, Card, CardHeader } from "@/components/ui";
import { AdminContainer, PageHeader } from "@/components/admin/PageHeader";
import { DataTable, type Column } from "@/components/admin/DataTable";
import { StatCard, StatGrid } from "@/components/admin/StatCard";
import { CardSkeleton, StatSkeleton } from "@/components/admin/Skeletons";
import { FilterTabs } from "@/components/admin/FilterTabs";
import { BarChart, type BarDatum } from "@/components/admin/BarChart";

export const metadata = { title: "利用ログ — Shiori" };

type Period = "7d" | "30d" | "all";

const PERIOD_DAYS: Record<Period, number | null> = {
  "7d": 7,
  "30d": 30,
  all: null,
};

/**
 * 期間の下限（ISO）を返す。
 * Date.now() はレンダー中に直接呼ぶと「純粋でない」として React に警告されるので、
 * コンポーネント外のヘルパーに閉じ込める。
 */
function sinceIso(days: number | null): string | null {
  if (days == null) return null;
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function parsePeriod(value: string | string[] | undefined): Period {
  const v = Array.isArray(value) ? value[0] : value;
  return v === "7d" || v === "all" ? v : "30d";
}

/** 集計対象の上限。デモ規模では十分で、これを超えるならDB側の集計関数に寄せるべき境目 */
const MAX_ROWS = 2000;

export default async function LogsPage(props: PageProps<"/admin/logs">) {
  const sp = await props.searchParams;
  const period = parsePeriod(sp.period);

  const session = await requireAdmin();

  return (
    <AdminContainer>
      <PageHeader
        title="利用ログ / コスト"
        description="誰がどれだけ使い、いくらかかっているかを可視化します。稟議で必ず聞かれる数字をそのまま出せます。"
        action={
          <FilterTabs
            options={[
              {
                label: "7日間",
                href: "/admin/logs?period=7d",
                active: period === "7d",
              },
              {
                label: "30日間",
                href: "/admin/logs?period=30d",
                active: period === "30d",
              },
              {
                label: "全期間",
                href: "/admin/logs?period=all",
                active: period === "all",
              },
            ]}
          />
        }
      />

      <Suspense
        key={period}
        fallback={
          <div className="space-y-6">
            <StatSkeleton count={5} />
            <CardSkeleton label="ログを集計中" />
          </div>
        }
      >
        <LogsDashboard orgId={session.profile.org_id} period={period} />
      </Suspense>
    </AdminContainer>
  );
}

type AssistantMessage = {
  id: string;
  conversation_id: string;
  content: string;
  top_score: number | null;
  answered: boolean | null;
  latency_ms: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  created_at: string;
};

/** 日付キーは JST 基準。sv-SE ロケールは "YYYY-MM-DD" を返すのでそのまま並べ替えに使える */
const DATE_KEY = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Asia/Tokyo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function dateKey(iso: string): string {
  return DATE_KEY.format(new Date(iso));
}

/**
 * 日別の件数。
 * 期間指定があるときは「質問が0件だった日」も棒を残す（使われなくなった日が見えないと意味がない）。
 */
function buildDailySeries(
  rows: AssistantMessage[],
  days: number | null,
): BarDatum[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const key = dateKey(row.created_at);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  if (days == null) {
    return [...counts.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => ({
        label: key.slice(5).replace("-", "/"),
        value,
      }));
  }

  const series: BarDatum[] = [];
  const today = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today.getTime() - i * 24 * 60 * 60 * 1000);
    const key = DATE_KEY.format(d);
    series.push({
      label: key.slice(5).replace("-", "/"),
      value: counts.get(key) ?? 0,
    });
  }
  return series;
}

async function LogsDashboard({
  orgId,
  period,
}: {
  orgId: string;
  period: Period;
}) {
  const days = PERIOD_DAYS[period];
  const since = sinceIso(days);

  // messages には管理者向けの閲覧専用ポリシー（messages_admin_read）があるので、
  // service role を使わずログインユーザーの権限で読む。
  // org_id の絞り込みはRLSと二重になるが、保険として必ず付ける。
  const supabase = await createClient();

  let query = supabase
    .from("messages")
    .select(
      "id, conversation_id, content, top_score, answered, latency_ms, input_tokens, output_tokens, created_at",
    )
    .eq("org_id", orgId)
    .eq("role", "assistant")
    .order("created_at", { ascending: false })
    .limit(MAX_ROWS);

  if (since) query = query.gte("created_at", since);

  const { data } = await query.returns<AssistantMessage[]>();
  const rows = data ?? [];

  // ---- サマリー ----
  const total = rows.length;
  const answered = rows.filter((r) => r.answered !== false).length;
  const answerRate = total ? Math.round((answered / total) * 100) : 0;

  const latencies = rows
    .map((r) => r.latency_ms)
    .filter((v): v is number => typeof v === "number" && v > 0);
  const avgLatency = latencies.length
    ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
    : 0;

  const totalCost = rows.reduce(
    (sum, r) => sum + estimateCostUsd(r.input_tokens, r.output_tokens),
    0,
  );
  const avgCost = total ? totalCost / total : 0;

  const totalTokens = rows.reduce(
    (sum, r) => sum + (r.input_tokens ?? 0) + (r.output_tokens ?? 0),
    0,
  );

  const series = buildDailySeries(rows, days);

  // ---- 直近ログの質問文を復元する ----
  const recent = rows.slice(0, 50);
  const conversationIds = Array.from(
    new Set(recent.map((r) => r.conversation_id)),
  );

  type QuestionMessage = {
    conversation_id: string;
    content: string;
    created_at: string;
  };
  let questions: QuestionMessage[] = [];
  if (conversationIds.length) {
    const { data: qs } = await supabase
      .from("messages")
      .select("conversation_id, content, created_at")
      .in("conversation_id", conversationIds)
      .eq("role", "user")
      .order("created_at", { ascending: true })
      .returns<QuestionMessage[]>();
    questions = qs ?? [];
  }

  const questionsByConv = new Map<string, QuestionMessage[]>();
  for (const q of questions) {
    const list = questionsByConv.get(q.conversation_id) ?? [];
    list.push(q);
    questionsByConv.set(q.conversation_id, list);
  }

  // 会話の持ち主（誰が質問したか）は conversations にしか無いので別途引く
  let ownerByConv = new Map<string, string>();
  if (conversationIds.length) {
    const { data: convs } = await supabase
      .from("conversations")
      .select("id, user_id")
      .in("id", conversationIds)
      .returns<{ id: string; user_id: string }[]>();
    ownerByConv = new Map((convs ?? []).map((c) => [c.id, c.user_id]));
  }

  const { data: profiles } = await supabase
    .from("profiles")
    .select("id, display_name")
    .returns<Pick<Profile, "id" | "display_name">[]>();
  const nameById = new Map(
    (profiles ?? []).map((p) => [p.id, p.display_name ?? "(名称未設定)"]),
  );

  type LogItem = AssistantMessage & { question: string; userName: string };

  const items: LogItem[] = recent.map((r) => {
    const candidates = questionsByConv.get(r.conversation_id) ?? [];
    const matched = [...candidates]
      .filter((q) => q.created_at <= r.created_at)
      .pop();
    const ownerId = ownerByConv.get(r.conversation_id);
    return {
      ...r,
      question: matched?.content ?? "(質問を特定できませんでした)",
      userName: ownerId
        ? (nameById.get(ownerId) ?? "不明なユーザー")
        : "不明なユーザー",
    };
  });

  const columns: Column<LogItem>[] = [
    {
      key: "question",
      header: "質問",
      className: "min-w-64",
      cell: (item) => (
        <div className="min-w-0">
          <p className="text-ink-900">{item.question}</p>
          <p className="mt-0.5 text-xs text-ink-400">{item.userName}</p>
        </div>
      ),
    },
    {
      key: "answered",
      header: "回答可否",
      cell: (item) =>
        item.answered === false ? (
          <Badge tone="warn">根拠不足</Badge>
        ) : (
          <Badge tone="ok">回答</Badge>
        ),
    },
    {
      key: "score",
      header: "類似度",
      align: "right",
      cell: (item) => (
        <span className="text-xs">
          {item.top_score != null
            ? `${(item.top_score * 100).toFixed(1)}%`
            : "-"}
        </span>
      ),
    },
    {
      key: "latency",
      header: "レイテンシ",
      align: "right",
      cell: (item) => (
        <span className="text-xs">
          {item.latency_ms != null
            ? `${item.latency_ms.toLocaleString("ja-JP")} ms`
            : "-"}
        </span>
      ),
    },
    {
      key: "tokens",
      header: "トークン",
      align: "right",
      cell: (item) => (
        <span className="text-xs whitespace-nowrap">
          {(item.input_tokens ?? 0).toLocaleString("ja-JP")} /{" "}
          {(item.output_tokens ?? 0).toLocaleString("ja-JP")}
        </span>
      ),
    },
    {
      key: "cost",
      header: "概算コスト",
      align: "right",
      cell: (item) => (
        <span className="text-xs">
          ${estimateCostUsd(item.input_tokens, item.output_tokens).toFixed(4)}
        </span>
      ),
    },
    {
      key: "createdAt",
      header: "日時",
      cell: (item) => (
        <span className="text-xs whitespace-nowrap text-ink-500">
          {formatDateTime(item.created_at)}
        </span>
      ),
    },
  ];

  const periodLabel =
    period === "all" ? "全期間" : period === "7d" ? "直近7日間" : "直近30日間";

  return (
    <div className="space-y-6">
      <StatGrid columns={5}>
        <StatCard
          label="総質問数"
          value={total.toLocaleString("ja-JP")}
          hint={periodLabel}
        />
        <StatCard
          label="回答できた率"
          value={total ? `${answerRate}%` : "-"}
          hint={`根拠不足 ${(total - answered).toLocaleString("ja-JP")} 件`}
          tone={
            total === 0
              ? "default"
              : answerRate >= 85
                ? "ok"
                : answerRate >= 70
                  ? "warn"
                  : "danger"
          }
        />
        <StatCard
          label="平均レイテンシ"
          value={avgLatency ? `${(avgLatency / 1000).toFixed(1)}秒` : "-"}
          hint={
            avgLatency ? `${avgLatency.toLocaleString("ja-JP")} ms` : undefined
          }
        />
        <StatCard
          label="累計コスト"
          value={`$${totalCost.toFixed(2)}`}
          hint={`${totalTokens.toLocaleString("ja-JP")} トークン`}
        />
        <StatCard
          label="1質問あたり"
          value={`$${avgCost.toFixed(4)}`}
          hint="入出力トークンからの概算"
        />
      </StatGrid>

      <Card>
        <CardHeader
          title="日別の質問数"
          description={`${periodLabel}の推移。棒にカーソルを合わせると件数が出ます。`}
        />
        <BarChart data={series} />
      </Card>

      <Card>
        <CardHeader
          title="直近の質問ログ"
          description={`新しい順に最大50件。${total >= MAX_ROWS ? `集計は直近${MAX_ROWS.toLocaleString("ja-JP")}件が上限です。` : ""}`}
        />
        <DataTable
          columns={columns}
          rows={items}
          rowKey={(item) => item.id}
          emptyTitle="この期間のログはありません"
          emptyDescription="チャットで質問すると、ここに記録されます。"
        />
      </Card>
    </div>
  );
}
