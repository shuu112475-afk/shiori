import { Suspense } from "react";
import { MessageSquareWarning } from "lucide-react";
import { requireAdmin } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import type { FaqOverride, Profile, Unanswered } from "@/lib/types";
import {
  AdminContainer,
  NoteBox,
  PageHeader,
} from "@/components/admin/PageHeader";
import { CardSkeleton } from "@/components/admin/Skeletons";
import { FilterTabs } from "@/components/admin/FilterTabs";
import {
  UnansweredQueue,
  type UnansweredItem,
} from "@/components/admin/UnansweredQueue";
import { FaqManager, type FaqItem } from "@/components/admin/FaqManager";

export const metadata = { title: "未回答キュー — Shiori" };

type StatusFilter = "open" | "resolved" | "all";

function parseStatus(value: string | string[] | undefined): StatusFilter {
  const v = Array.isArray(value) ? value[0] : value;
  return v === "resolved" || v === "all" ? v : "open";
}

export default async function UnansweredPage(
  props: PageProps<"/admin/unanswered">,
) {
  // searchParams も Promise。await せずに触ると 16 では壊れる
  const sp = await props.searchParams;
  const status = parseStatus(sp.status);

  await requireAdmin();

  return (
    <AdminContainer>
      <PageHeader
        title="未回答キュー"
        description="答えられなかった質問を、FAQとして登録して潰していく画面です。ここが回るほどAIの回答率が上がります。"
      />

      <div className="space-y-6">
        <NoteBox
          icon={<MessageSquareWarning className="size-3.5" aria-hidden />}
        >
          <p>
            <span className="font-medium">改善ループ:</span> 社員の質問 →
            根拠不足でAIが回答を拒否 → この画面に溜まる →
            管理者が正しい回答を書く → 次から同じ質問には即答される。
            「AIが答えられない」を放置せず、運用で潰し込める形にしてあります。
          </p>
        </NoteBox>

        <Suspense fallback={<CardSkeleton label="未回答の質問を読み込み中" />}>
          <QueueSection status={status} />
        </Suspense>

        <Suspense fallback={<CardSkeleton label="FAQを読み込み中" rows={3} />}>
          <FaqSection />
        </Suspense>
      </div>
    </AdminContainer>
  );
}

async function QueueSection({ status }: { status: StatusFilter }) {
  const supabase = await createClient();

  let query = supabase
    .from("unanswered")
    .select("*")
    // 未解決を上に固定してから新着順。運用時に見るべき行が常に最初に来る
    .order("resolved", { ascending: true })
    .order("created_at", { ascending: false })
    .limit(200);

  if (status === "open") query = query.eq("resolved", false);
  if (status === "resolved") query = query.eq("resolved", true);

  const [{ data: rows }, { data: profiles }, counts] = await Promise.all([
    query.returns<Unanswered[]>(),
    supabase
      .from("profiles")
      .select("id, display_name")
      .returns<Pick<Profile, "id" | "display_name">[]>(),
    countByStatus(supabase),
  ]);

  const nameById = new Map(
    (profiles ?? []).map((p) => [p.id, p.display_name ?? "(名称未設定)"]),
  );

  const items: UnansweredItem[] = (rows ?? []).map((r) => ({
    id: r.id,
    query: r.query,
    topScore: r.top_score,
    askerName: r.asked_by
      ? (nameById.get(r.asked_by) ?? "不明なユーザー")
      : "不明なユーザー",
    createdAt: r.created_at,
    resolved: r.resolved,
    faqOverrideId: r.faq_override_id,
  }));

  return (
    <div className="space-y-3">
      <FilterTabs
        options={[
          {
            label: "未対応",
            href: "/admin/unanswered?status=open",
            active: status === "open",
            count: counts.open,
          },
          {
            label: "対応済み",
            href: "/admin/unanswered?status=resolved",
            active: status === "resolved",
            count: counts.resolved,
          },
          {
            label: "すべて",
            href: "/admin/unanswered?status=all",
            active: status === "all",
            count: counts.open + counts.resolved,
          },
        ]}
      />
      <UnansweredQueue items={items} />
    </div>
  );
}

async function countByStatus(
  supabase: Awaited<ReturnType<typeof createClient>>,
): Promise<{ open: number; resolved: number }> {
  // 件数だけ欲しいので head: true（行本体を転送しない）
  const [open, resolved] = await Promise.all([
    supabase
      .from("unanswered")
      .select("id", { count: "exact", head: true })
      .eq("resolved", false),
    supabase
      .from("unanswered")
      .select("id", { count: "exact", head: true })
      .eq("resolved", true),
  ]);

  return { open: open.count ?? 0, resolved: resolved.count ?? 0 };
}

async function FaqSection() {
  const supabase = await createClient();

  const [{ data: faqs }, { data: profiles }] = await Promise.all([
    supabase
      .from("faq_overrides")
      .select(
        "id, org_id, question, answer, enabled, hit_count, created_by, created_at",
      )
      // よく使われている FAQ を上に。運用の成果が最初に目に入るようにする
      .order("hit_count", { ascending: false })
      .order("created_at", { ascending: false })
      .returns<FaqOverride[]>(),
    supabase
      .from("profiles")
      .select("id, display_name")
      .returns<Pick<Profile, "id" | "display_name">[]>(),
  ]);

  const nameById = new Map(
    (profiles ?? []).map((p) => [p.id, p.display_name ?? "(名称未設定)"]),
  );

  const items: FaqItem[] = (faqs ?? []).map((f) => ({
    id: f.id,
    question: f.question,
    answer: f.answer,
    enabled: f.enabled,
    hitCount: f.hit_count,
    createdAt: f.created_at,
    authorName: f.created_by
      ? (nameById.get(f.created_by) ?? "不明なユーザー")
      : "システム",
  }));

  return <FaqManager items={items} />;
}
