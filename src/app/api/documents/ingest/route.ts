import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { ingestDocument, writeAuditLog } from "@/lib/ingest";

/**
 * 取り込みの起動口。アップロード直後と、一覧の「再取り込み」から呼ばれる。
 *
 * requireAdmin() はリダイレクトを投げるので Route Handler では使えない
 * （fetch のレスポンスが 3xx になり、クライアント側でエラー内容を読めなくなる）。
 * ここでは同じ判定を自前で行い、401 / 403 を JSON で返す。
 */
const BodySchema = z.object({
  documentId: z.string().uuid("ドキュメントIDが不正です"),
});

export async function POST(request: NextRequest) {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "認証が必要です" }, { status: 401 });
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("org_id, role")
    .eq("id", user.id)
    .maybeSingle<{ org_id: string; role: string }>();

  if (!profile) {
    return NextResponse.json(
      { error: "プロフィールが未設定です" },
      { status: 403 },
    );
  }
  if (profile.role !== "admin") {
    return NextResponse.json(
      { error: "管理者のみ実行できます" },
      { status: 403 },
    );
  }

  const json = await request.json().catch(() => null);
  const parsed = BodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "不正なリクエストです" },
      { status: 400 },
    );
  }
  const { documentId } = parsed.data;

  // ingestDocument は service role で動く（RLS をバイパスする）ので、
  // 「その文書が本当に自分の組織のものか」をここで必ず確かめてから渡す。
  const { data: doc } = await supabase
    .from("documents")
    .select("id, org_id, title, mime_type")
    .eq("id", documentId)
    .maybeSingle<{
      id: string;
      org_id: string;
      title: string;
      mime_type: string;
    }>();

  if (!doc) {
    return NextResponse.json(
      { error: "ドキュメントが見つかりません" },
      { status: 404 },
    );
  }
  if (doc.org_id !== profile.org_id) {
    return NextResponse.json(
      { error: "この組織のドキュメントではありません" },
      { status: 403 },
    );
  }

  const startedAt = Date.now();

  try {
    // ⚠️ 同期実行の制約:
    //    ingestDocument は パース → チャンク分割 → 埋め込みAPI（数百チャンク分）まで
    //    直列で行うため、大きなPDFでは数十秒〜数分かかる。
    //    Vercel の関数実行時間上限を超えるとレスポンスが返らず、
    //    documents.status が 'processing' のまま取り残される。
    //    （その場合も一覧から「再取り込み」で復帰できるようにしてある）
    //    Phase 2 でジョブキュー（pg_cron / QStash 等）に切り出し、
    //    このエンドポイントは「キュー投入して即 202 を返す」だけにする。
    await ingestDocument(documentId);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);

    // 失敗も監査に残す。「入れたのに使えない」の調査はここが起点になる
    await writeAuditLog({
      orgId: profile.org_id,
      userId: user.id,
      action: "document.ingest_failed",
      targetType: "document",
      targetId: documentId,
      detail: {
        title: doc.title,
        error: message,
        elapsedMs: Date.now() - startedAt,
      },
    });

    return NextResponse.json(
      { error: `取り込みに失敗しました: ${message}` },
      { status: 500 },
    );
  }

  const elapsedMs = Date.now() - startedAt;

  await writeAuditLog({
    orgId: profile.org_id,
    userId: user.id,
    action: "document.ingest",
    targetType: "document",
    targetId: documentId,
    detail: { title: doc.title, mimeType: doc.mime_type, elapsedMs },
  });

  return NextResponse.json({ ok: true, documentId, elapsedMs });
}
