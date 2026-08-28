import { Suspense } from "react";
import Link from "next/link";
import { FileSearch } from "lucide-react";
import { requireAdmin } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import type { DocumentRow, Profile } from "@/lib/types";
import { formatBytes, formatDateTime } from "@/lib/utils";
import { Badge, Card, CardHeader } from "@/components/ui";
import { AdminContainer, PageHeader } from "@/components/admin/PageHeader";
import { DataTable, type Column } from "@/components/admin/DataTable";
import { CardSkeleton } from "@/components/admin/Skeletons";
import { DocStatusBadge, mimeLabel } from "@/components/admin/DocStatusBadge";
import { DocumentActions } from "@/components/admin/DocumentActions";
import { IngestPoller } from "@/components/admin/IngestPoller";
import { UploadPanel } from "@/components/admin/UploadPanel";

export const metadata = { title: "ドキュメント管理 — Shiori" };

export default async function DocumentsPage() {
  const session = await requireAdmin();

  return (
    <AdminContainer>
      <PageHeader
        title="ドキュメント"
        description="AIが参照する社内文書の一覧です。取り込み状況とチャンク数まで見えるので、「入れたのに答えない」の原因をここで切り分けられます。"
      />

      <div className="space-y-6">
        <Suspense
          fallback={<CardSkeleton label="アップロード枠を準備中" rows={2} />}
        >
          <UploadSection orgId={session.profile.org_id} />
        </Suspense>

        <Suspense fallback={<CardSkeleton label="ドキュメントを読み込み中" />}>
          <DocumentsSection />
        </Suspense>
      </div>
    </AdminContainer>
  );
}

/** 公開部署の候補は「実際にメンバーが所属している部署」から作る（存在しない部署を選ばせない） */
async function UploadSection({ orgId }: { orgId: string }) {
  const supabase = await createClient();
  const { data } = await supabase
    .from("profiles")
    .select("department")
    .returns<{ department: string }[]>();

  const departments = Array.from(
    new Set((data ?? []).map((p) => p.department).filter(Boolean)),
  ).sort((a, b) => a.localeCompare(b, "ja"));

  return <UploadPanel orgId={orgId} departments={departments} />;
}

async function DocumentsSection() {
  const supabase = await createClient();

  const [{ data: documents }, { data: profiles }] = await Promise.all([
    supabase
      .from("documents")
      .select("*")
      .order("created_at", { ascending: false })
      .returns<DocumentRow[]>(),
    supabase
      .from("profiles")
      .select("id, display_name")
      .returns<Pick<Profile, "id" | "display_name">[]>(),
  ]);

  const rows = documents ?? [];
  const nameById = new Map(
    (profiles ?? []).map((p) => [p.id, p.display_name ?? "(名称未設定)"]),
  );

  // pending / processing = まだ結果が確定していない行。これが0になったらポーリングを止める
  const activeCount = rows.filter(
    (d) => d.status === "pending" || d.status === "processing",
  ).length;

  const readyCount = rows.filter((d) => d.status === "ready").length;
  const failedCount = rows.filter((d) => d.status === "failed").length;
  const totalChunks = rows.reduce((sum, d) => sum + (d.chunk_count ?? 0), 0);

  const columns: Column<DocumentRow>[] = [
    {
      key: "title",
      header: "タイトル",
      className: "min-w-56",
      cell: (d) => (
        <div className="min-w-0">
          <Link
            href={`/admin/documents/${d.id}/chunks`}
            className="font-medium text-ink-900 hover:text-brand-600 hover:underline"
          >
            {d.title}
          </Link>
          <p className="mt-0.5 text-xs text-ink-400">
            {d.uploaded_by
              ? `${nameById.get(d.uploaded_by) ?? "不明なユーザー"} が登録`
              : "登録者不明"}
          </p>
        </div>
      ),
    },
    {
      key: "mime",
      header: "種別",
      cell: (d) => (
        <span className="text-xs text-ink-600">{mimeLabel(d.mime_type)}</span>
      ),
    },
    {
      key: "size",
      header: "サイズ",
      align: "right",
      cell: (d) => <span className="text-xs">{formatBytes(d.byte_size)}</span>,
    },
    {
      key: "status",
      header: "ステータス",
      cell: (d) => <DocStatusBadge status={d.status} />,
    },
    {
      key: "chunks",
      header: "チャンク数",
      align: "right",
      cell: (d) =>
        d.chunk_count > 0 ? (
          <Link
            href={`/admin/documents/${d.id}/chunks`}
            className="text-brand-600 hover:underline"
          >
            {d.chunk_count.toLocaleString("ja-JP")}
          </Link>
        ) : (
          <span className="text-ink-400">-</span>
        ),
    },
    {
      key: "departments",
      header: "公開部署",
      cell: (d) =>
        d.allowed_departments && d.allowed_departments.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {d.allowed_departments.map((dept) => (
              <Badge key={dept} tone="neutral">
                {dept}
              </Badge>
            ))}
          </div>
        ) : (
          <Badge tone="brand">全社</Badge>
        ),
    },
    {
      key: "created",
      header: "登録日時",
      cell: (d) => (
        <span className="text-xs whitespace-nowrap text-ink-500">
          {formatDateTime(d.created_at)}
        </span>
      ),
    },
    {
      key: "actions",
      header: "",
      align: "right",
      cell: (d) => (
        <div className="flex flex-col items-end gap-1.5">
          <Link
            href={`/admin/documents/${d.id}/chunks`}
            className="inline-flex items-center gap-1 text-xs font-medium text-brand-600 hover:underline"
          >
            <FileSearch className="size-3.5" aria-hidden />
            チャンクを見る
          </Link>
          <DocumentActions documentId={d.id} title={d.title} />
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-3">
      {/* key を件数に紐づけ、処理が進むたびに打ち切りカウンタを作り直す */}
      <IngestPoller key={activeCount} activeCount={activeCount} />

      <Card>
        <CardHeader
          title={`登録済みドキュメント（${rows.length}件）`}
          description={`利用可 ${readyCount}件 / 失敗 ${failedCount}件 / 合計 ${totalChunks.toLocaleString("ja-JP")} チャンク`}
        />
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(d) => d.id}
          emptyTitle="まだドキュメントがありません"
          emptyDescription="上のエリアからファイルをアップロードすると、AIが答えられるようになります。"
          /* 失敗した理由を一覧のその場で読めるようにする。
             詳細画面を開かないと分からない作りだと運用時に確実に見落とされる。 */
          subRow={(d) =>
            d.status === "failed" && d.error_message ? (
              <p className="rounded-md bg-danger-50 px-3 py-2 text-xs text-danger-600">
                取り込みエラー: {d.error_message}
              </p>
            ) : null
          }
        />
      </Card>
    </div>
  );
}
