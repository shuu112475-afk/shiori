import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Info } from "lucide-react";
import { requireAdmin } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import type { ChunkRow, DocumentRow } from "@/lib/types";
import { formatBytes, formatDateTime } from "@/lib/utils";
import { Card, CardHeader, EmptyState } from "@/components/ui";
import {
  AdminContainer,
  NoteBox,
  PageHeader,
} from "@/components/admin/PageHeader";
import { StatCard, StatGrid } from "@/components/admin/StatCard";
import { CardSkeleton } from "@/components/admin/Skeletons";
import { DocStatusBadge, mimeLabel } from "@/components/admin/DocStatusBadge";
import { HeadingPath } from "@/components/admin/HeadingPath";
import { Pagination } from "@/components/admin/Pagination";

const PAGE_SIZE = 50;

export default async function ChunksPage(
  props: PageProps<"/admin/documents/[id]/chunks">,
) {
  // Next 16 では params / searchParams は Promise。同期アクセスは削除されている
  const { id } = await props.params;
  const sp = await props.searchParams;

  await requireAdmin();

  const rawPage = Array.isArray(sp.page) ? sp.page[0] : sp.page;
  const page = Math.max(1, Number.parseInt(rawPage ?? "1", 10) || 1);

  return (
    <AdminContainer>
      <div className="mb-4">
        <Link
          href="/admin/documents"
          className="text-xs font-medium text-brand-600 hover:underline"
        >
          ← ドキュメント一覧へ戻る
        </Link>
      </div>

      <Suspense
        fallback={<CardSkeleton label="チャンクを読み込み中" rows={8} />}
      >
        <ChunkInspector documentId={id} page={page} />
      </Suspense>
    </AdminContainer>
  );
}

async function ChunkInspector({
  documentId,
  page,
}: {
  documentId: string;
  page: number;
}) {
  const supabase = await createClient();

  const { data: doc } = await supabase
    .from("documents")
    .select("*")
    .eq("id", documentId)
    .maybeSingle<DocumentRow>();

  // RLS で自組織の文書しか取れない。取れない = 存在しないか権限がない
  if (!doc) notFound();

  // 統計は全チャンクを対象にしたいが、本文まで全件持ってくると重い。
  // 統計用は軽い列だけ、本文はページ分だけ取る、と2回に分けている。
  const [{ data: statRows }, { data: pageRows, count }] = await Promise.all([
    supabase
      .from("chunks")
      .select("token_count, heading_path")
      .eq("document_id", documentId)
      .returns<Pick<ChunkRow, "token_count" | "heading_path">[]>(),
    supabase
      .from("chunks")
      .select(
        "id, document_id, org_id, chunk_index, content, heading_path, page_no, token_count",
        { count: "exact" },
      )
      .eq("document_id", documentId)
      .order("chunk_index", { ascending: true })
      .range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1)
      .returns<ChunkRow[]>(),
  ]);

  const stats = statRows ?? [];
  const total = count ?? stats.length;
  const tokens = stats
    .map((c) => c.token_count)
    .filter((t): t is number => typeof t === "number" && t > 0);

  const avgTokens = tokens.length
    ? Math.round(tokens.reduce((a, b) => a + b, 0) / tokens.length)
    : 0;
  const minTokens = tokens.length ? Math.min(...tokens) : 0;
  const maxTokens = tokens.length ? Math.max(...tokens) : 0;

  const withHeading = stats.filter(
    (c) => c.heading_path && c.heading_path.trim().length > 0,
  ).length;
  const headingRate = stats.length
    ? Math.round((withHeading / stats.length) * 100)
    : 0;

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const chunks = pageRows ?? [];

  return (
    <>
      <PageHeader
        title={doc.title}
        description="この文書がどう分割され、どの見出しの下に置かれたかを確認できます。回答が的外れなときは、まずここを見ます。"
        action={<DocStatusBadge status={doc.status} />}
      />

      <div className="space-y-6">
        <Card>
          <CardHeader title="文書の情報" />
          <dl className="grid grid-cols-2 gap-x-6 gap-y-4 px-5 py-4 text-sm sm:grid-cols-3 lg:grid-cols-6">
            <Meta label="種別" value={mimeLabel(doc.mime_type)} />
            <Meta label="サイズ" value={formatBytes(doc.byte_size)} />
            <Meta
              label="ページ数"
              value={doc.page_count != null ? `${doc.page_count} ページ` : "-"}
            />
            <Meta label="チャンク数" value={total.toLocaleString("ja-JP")} />
            <Meta label="登録日時" value={formatDateTime(doc.created_at)} />
            <Meta
              label="取り込み完了"
              value={doc.indexed_at ? formatDateTime(doc.indexed_at) : "未完了"}
            />
          </dl>
          {doc.status === "failed" && doc.error_message && (
            <div className="border-t border-ink-200 px-5 py-4">
              <p className="rounded-md bg-danger-50 px-3 py-2 text-xs text-danger-600">
                取り込みエラー: {doc.error_message}
              </p>
            </div>
          )}
        </Card>

        <StatGrid columns={4}>
          <StatCard
            label="チャンク総数"
            value={total.toLocaleString("ja-JP")}
            hint="検索の最小単位"
          />
          <StatCard
            label="平均トークン数"
            value={avgTokens.toLocaleString("ja-JP")}
            hint={`最小 ${minTokens.toLocaleString("ja-JP")} / 最大 ${maxTokens.toLocaleString("ja-JP")}`}
          />
          <StatCard
            label="見出しパス取得率"
            value={`${headingRate}%`}
            hint={`${withHeading.toLocaleString("ja-JP")} / ${stats.length.toLocaleString("ja-JP")} チャンク`}
            tone={
              headingRate >= 80 ? "ok" : headingRate >= 50 ? "warn" : "danger"
            }
          />
          <StatCard
            label="ページ番号付き"
            value={doc.page_count != null ? "あり" : "なし"}
            hint={
              doc.page_count != null
                ? "出典に「何ページ目か」を出せます"
                : "Word/テキストはページ概念がありません"
            }
          />
        </StatGrid>

        <NoteBox icon={<Info className="size-3.5" aria-hidden />}>
          <p className="font-medium">なぜこの分割で精度が出るのか</p>
          <p className="mt-1">
            単純な文字数分割ではなく、見出しの階層（第◯章 &gt;
            第◯条）を保持したまま分割し、 各チャンクに「文書名 &gt; 章 &gt;
            条」の見出しパスを持たせています。
            検索対象は本文だけでなく見出しパスを連結したテキスト（search_text）なので、
            「有給」のように条文中に出てこない口語でも、見出し側で当たります。
            上の<span className="font-medium">見出しパス取得率</span>
            が低い文書は、元ファイルの見出しがスタイル設定されていない可能性が高く、
            回答精度が落ちるサインです。
          </p>
        </NoteBox>

        <Card>
          <CardHeader
            title="チャンク一覧"
            description={`${total.toLocaleString("ja-JP")} 件中 ${chunks.length} 件を表示中（chunk_index 昇順）`}
          />

          {chunks.length === 0 ? (
            <EmptyState
              title="チャンクがありません"
              description={
                doc.status === "ready"
                  ? "取り込みは完了していますが、抽出できるテキストがありませんでした。"
                  : "取り込みが完了すると、ここに分割結果が表示されます。"
              }
            />
          ) : (
            <ul className="divide-y divide-ink-100">
              {chunks.map((c) => (
                <li key={c.id} className="px-5 py-4">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span className="rounded-md bg-ink-100 px-2 py-0.5 text-xs font-medium tabular-nums text-ink-600">
                      #{c.chunk_index}
                    </span>
                    <HeadingPath path={c.heading_path} />
                    <span className="ml-auto flex items-center gap-3 text-xs text-ink-400 tabular-nums">
                      {c.page_no != null && <span>p.{c.page_no}</span>}
                      <span>
                        {(c.token_count ?? 0).toLocaleString("ja-JP")} tok
                      </span>
                    </span>
                  </div>
                  <p className="mt-2 max-h-56 overflow-y-auto rounded-lg bg-ink-50 px-3 py-2 text-xs leading-relaxed whitespace-pre-wrap text-ink-700">
                    {c.content}
                  </p>
                </li>
              ))}
            </ul>
          )}

          <Pagination
            page={page}
            totalPages={totalPages}
            total={total}
            hrefFor={(p) => `/admin/documents/${doc.id}/chunks?page=${p}`}
          />
        </Card>
      </div>
    </>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-ink-500">{label}</dt>
      <dd className="mt-0.5 truncate text-sm font-medium text-ink-900">
        {value}
      </dd>
    </div>
  );
}
