import { Suspense } from "react";
import { requireAdmin } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import type { Profile } from "@/lib/types";
import { formatDateTime } from "@/lib/utils";
import { Badge, Card, CardHeader } from "@/components/ui";
import { AdminContainer, PageHeader } from "@/components/admin/PageHeader";
import { DataTable, type Column } from "@/components/admin/DataTable";
import { CardSkeleton } from "@/components/admin/Skeletons";
import { FilterTabs } from "@/components/admin/FilterTabs";
import { JsonDetails } from "@/components/admin/JsonDetails";
import { Pagination } from "@/components/admin/Pagination";

export const metadata = { title: "監査ログ — Shiori" };

const PAGE_SIZE = 50;

/** action は自由文字列なので、既知のものだけ和名にして残りは生の値を出す */
const ACTION_LABEL: Record<string, string> = {
  "document.upload": "ドキュメント登録",
  "document.ingest": "取り込み実行",
  "document.ingest_failed": "取り込み失敗",
  "document.delete": "ドキュメント削除",
  "document.update_access": "公開範囲の変更",
  "faq.create": "FAQ登録",
  "faq.update": "FAQ更新",
  "faq.enable": "FAQ有効化",
  "faq.disable": "FAQ無効化",
  "unanswered.dismiss": "未回答を対応済みに",
  "unanswered.reopen": "未回答を差し戻し",
  "member.update": "メンバー変更",
  "chat.ask": "チャット質問",
};

function actionTone(action: string): "neutral" | "ok" | "warn" | "danger" {
  if (action.endsWith("_failed")) return "danger";
  if (action.includes("delete") || action.includes("disable")) return "warn";
  if (action.includes("create") || action.includes("upload")) return "ok";
  return "neutral";
}

type AuditRow = {
  id: number;
  user_id: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  detail: unknown;
  created_at: string;
};

export default async function AuditPage(props: PageProps<"/admin/audit">) {
  const sp = await props.searchParams;
  const rawAction = Array.isArray(sp.action) ? sp.action[0] : sp.action;
  const action = rawAction && rawAction !== "all" ? rawAction : null;
  const rawPage = Array.isArray(sp.page) ? sp.page[0] : sp.page;
  const page = Math.max(1, Number.parseInt(rawPage ?? "1", 10) || 1);

  await requireAdmin();

  return (
    <AdminContainer>
      <PageHeader
        title="監査ログ"
        description="管理操作の履歴です。「誰が・いつ・何をしたか」が残るので、社内文書を扱うシステムとして説明責任を果たせます。"
      />

      <Suspense
        key={`${action ?? "all"}-${page}`}
        fallback={<CardSkeleton label="監査ログを読み込み中" rows={8} />}
      >
        <AuditSection action={action} page={page} />
      </Suspense>
    </AdminContainer>
  );
}

async function AuditSection({
  action,
  page,
}: {
  action: string | null;
  page: number;
}) {
  const supabase = await createClient();

  let query = supabase
    .from("audit_logs")
    .select("id, user_id, action, target_type, target_id, detail, created_at", {
      count: "exact",
    })
    .order("created_at", { ascending: false })
    .range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1);

  if (action) query = query.eq("action", action);

  const [{ data, count }, { data: actionRows }, { data: profiles }] =
    await Promise.all([
      query.returns<AuditRow[]>(),
      // フィルタの選択肢は実際に記録されている action から作る（使われていない項目を並べない）
      supabase
        .from("audit_logs")
        .select("action")
        .order("created_at", { ascending: false })
        .limit(500)
        .returns<{ action: string }[]>(),
      supabase
        .from("profiles")
        .select("id, display_name")
        .returns<Pick<Profile, "id" | "display_name">[]>(),
    ]);

  const rows = data ?? [];
  const total = count ?? rows.length;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const nameById = new Map(
    (profiles ?? []).map((p) => [p.id, p.display_name ?? "(名称未設定)"]),
  );

  const actions = Array.from(
    new Set((actionRows ?? []).map((r) => r.action)),
  ).sort();

  const columns: Column<AuditRow>[] = [
    {
      key: "createdAt",
      header: "日時",
      cell: (r) => (
        <span className="text-xs whitespace-nowrap text-ink-600">
          {formatDateTime(r.created_at)}
        </span>
      ),
    },
    {
      key: "user",
      header: "ユーザー",
      cell: (r) => (
        <span className="text-xs text-ink-700">
          {r.user_id
            ? (nameById.get(r.user_id) ?? "退会済みユーザー")
            : "システム"}
        </span>
      ),
    },
    {
      key: "action",
      header: "アクション",
      cell: (r) => (
        <div className="flex flex-col gap-0.5">
          <Badge tone={actionTone(r.action)}>
            {ACTION_LABEL[r.action] ?? r.action}
          </Badge>
          <span className="font-mono text-[10px] text-ink-400">{r.action}</span>
        </div>
      ),
    },
    {
      key: "target",
      header: "対象",
      cell: (r) =>
        r.target_type ? (
          <div className="min-w-0">
            <p className="text-xs text-ink-700">{r.target_type}</p>
            <p className="truncate font-mono text-[10px] text-ink-400">
              {r.target_id ?? "-"}
            </p>
          </div>
        ) : (
          <span className="text-xs text-ink-400">-</span>
        ),
    },
    {
      key: "detail",
      header: "詳細",
      cell: (r) => <JsonDetails value={r.detail} />,
    },
  ];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <FilterTabs
          options={[
            {
              label: "すべて",
              href: "/admin/audit",
              active: action === null,
            },
            ...actions.map((a) => ({
              label: ACTION_LABEL[a] ?? a,
              href: `/admin/audit?action=${encodeURIComponent(a)}`,
              active: action === a,
            })),
          ]}
        />
      </div>

      <Card>
        <CardHeader
          title={`監査ログ（${total.toLocaleString("ja-JP")}件）`}
          description="新しい順。詳細は各行の「詳細」から展開できます。"
        />
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(r) => r.id}
          emptyTitle="監査ログがありません"
          emptyDescription="ドキュメントの登録やFAQの編集を行うと、ここに記録されます。"
        />
        <Pagination
          page={page}
          totalPages={totalPages}
          total={total}
          hrefFor={(p) =>
            action
              ? `/admin/audit?action=${encodeURIComponent(action)}&page=${p}`
              : `/admin/audit?page=${p}`
          }
        />
      </Card>
    </div>
  );
}
