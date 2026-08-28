import { createAdminClient } from "./supabase/admin";
import { chunkDocument } from "./chunking";
import { parseFile } from "./parse";
import { embedBatch, toVectorLiteral } from "./embedding";

export const DOCUMENTS_BUCKET = "documents";

/**
 * 取り込みワーカー。
 *   Storage からダウンロード → パース → 階層チャンキング → Embedding → chunks へ投入
 *
 * RLS をバイパスする admin クライアントを使うため、呼び出し前に
 * 「呼び出し元が当該組織の管理者か」を必ず検証すること。
 */
export async function ingestDocument(documentId: string): Promise<void> {
  const admin = createAdminClient();

  const { data: doc, error: docError } = await admin
    .from("documents")
    .select("id, org_id, title, file_path, mime_type")
    .eq("id", documentId)
    .single();

  if (docError || !doc) {
    throw new Error(`ドキュメントが見つかりません: ${documentId}`);
  }

  await admin
    .from("documents")
    .update({ status: "processing", error_message: null })
    .eq("id", documentId);

  try {
    const { data: file, error: dlError } = await admin.storage
      .from(DOCUMENTS_BUCKET)
      .download(doc.file_path);

    if (dlError || !file) {
      throw new Error(
        `ファイルを取得できません: ${dlError?.message ?? "unknown"}`,
      );
    }

    const { blocks, pageCount } = await parseFile(
      await file.arrayBuffer(),
      doc.mime_type,
    );

    const chunks = chunkDocument(blocks, { rootTitle: doc.title });
    if (!chunks.length) {
      throw new Error(
        "抽出できるテキストがありませんでした。画像のみのPDFの可能性があります（OCRは未対応）",
      );
    }

    const embeddings = await embedBatch(chunks.map((c) => c.content));

    // 再取り込みに備えて既存チャンクを消してから入れ直す
    await admin.from("chunks").delete().eq("document_id", documentId);

    const rows = chunks.map((c, i) => ({
      document_id: documentId,
      org_id: doc.org_id,
      chunk_index: c.index,
      content: c.content,
      heading_path: c.headingPath,
      page_no: c.pageNo,
      token_count: c.tokenCount,
      embedding: toVectorLiteral(embeddings[i]),
    }));

    // 一度に入れると payload が大きすぎるので分割する
    const INSERT_BATCH = 100;
    for (let i = 0; i < rows.length; i += INSERT_BATCH) {
      const { error } = await admin
        .from("chunks")
        .insert(rows.slice(i, i + INSERT_BATCH));
      if (error) throw error;
    }

    await admin
      .from("documents")
      .update({
        status: "ready",
        page_count: pageCount,
        chunk_count: chunks.length,
        indexed_at: new Date().toISOString(),
        error_message: null,
      })
      .eq("id", documentId);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await admin
      .from("documents")
      .update({ status: "failed", error_message: message })
      .eq("id", documentId);
    throw e;
  }
}

/** 監査ログを書く（RLS をバイパスするので admin 経由） */
export async function writeAuditLog(params: {
  orgId: string;
  userId: string | null;
  action: string;
  targetType?: string;
  targetId?: string;
  detail?: Record<string, unknown>;
}): Promise<void> {
  const admin = createAdminClient();
  await admin.from("audit_logs").insert({
    org_id: params.orgId,
    user_id: params.userId,
    action: params.action,
    target_type: params.targetType ?? null,
    target_id: params.targetId ?? null,
    detail: params.detail ?? null,
  });
}
