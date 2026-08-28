"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { DOCUMENTS_BUCKET, writeAuditLog } from "@/lib/ingest";
import { isSupportedMime } from "@/lib/parse";
import type { ActionResult } from "@/app/admin/action-result";

/**
 * ファイル本体はここを通らない。
 *
 * Server Action のボディ上限は既定 1MB で、社内規程 PDF は簡単に超える。
 * そのためブラウザ → Supabase Storage へ直接アップロードし、
 * この Action にはアップロード済みのパスとメタデータだけを渡す設計にしている。
 */
const CreateSchema = z.object({
  filePath: z.string().min(1),
  title: z.string().trim().min(1, "タイトルを入力してください").max(200),
  mimeType: z.string().min(1),
  byteSize: z.number().int().nonnegative(),
  allowedDepartments: z.array(z.string().trim().min(1)).max(50),
});

export type CreateDocumentInput = z.infer<typeof CreateSchema>;

export async function createDocumentRecord(
  input: CreateDocumentInput,
): Promise<ActionResult<{ documentId: string }>> {
  const session = await requireAdmin();

  const parsed = CreateSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "入力内容が不正です",
    };
  }
  const { filePath, title, mimeType, byteSize, allowedDepartments } =
    parsed.data;

  if (!isSupportedMime(mimeType)) {
    return { ok: false, error: `対応していないファイル形式です: ${mimeType}` };
  }

  const orgId = session.profile.org_id;

  // パスは `${org_id}/...` で発行している。ここを検証しないと、
  // 細工したリクエストで他組織のファイルを自組織の文書として登録できてしまう。
  if (!filePath.startsWith(`${orgId}/`)) {
    return { ok: false, error: "ファイルの保存先が不正です" };
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("documents")
    .insert({
      org_id: orgId,
      title,
      file_path: filePath,
      mime_type: mimeType,
      byte_size: byteSize,
      // SQL 側のコメント通り NULL / 空配列 = 全部署に公開。
      // 空配列だと cardinality 判定に頼ることになるので NULL に寄せる。
      allowed_departments: allowedDepartments.length
        ? allowedDepartments
        : null,
      uploaded_by: session.id,
      status: "pending",
    })
    .select("id")
    .single<{ id: string }>();

  if (error || !data) {
    return {
      ok: false,
      error: `文書の登録に失敗しました: ${error?.message ?? "unknown"}`,
    };
  }

  await writeAuditLog({
    orgId,
    userId: session.id,
    action: "document.upload",
    targetType: "document",
    targetId: data.id,
    detail: { title, mimeType, byteSize, allowedDepartments },
  });

  revalidatePath("/admin/documents");
  return { ok: true, data: { documentId: data.id } };
}

const DeleteSchema = z.object({ documentId: z.string().uuid() });

export async function deleteDocument(
  documentId: string,
): Promise<ActionResult<{ warning?: string }>> {
  const session = await requireAdmin();

  const parsed = DeleteSchema.safeParse({ documentId });
  if (!parsed.success) return { ok: false, error: "IDが不正です" };

  const supabase = await createClient();

  // RLS（documents_admin_write）で自組織に限定されるので、
  // ここで取得できた時点で「自組織の文書」であることが保証される。
  const { data: doc } = await supabase
    .from("documents")
    .select("id, title, file_path")
    .eq("id", documentId)
    .single<{ id: string; title: string; file_path: string }>();

  if (!doc) {
    return { ok: false, error: "文書が見つからないか、権限がありません" };
  }

  // Storage の削除は service role で行う。
  // Storage ポリシーは Supabase プロジェクト側の設定次第で失敗しうるので、
  // 失敗しても DB 行は消し、孤児ファイルが残ったことを警告として返す。
  let warning: string | undefined;
  const admin = createAdminClient();
  const { error: storageError } = await admin.storage
    .from(DOCUMENTS_BUCKET)
    .remove([doc.file_path]);
  if (storageError) {
    warning = `Storage のファイル削除に失敗しました（${storageError.message}）。一覧からは消えていますが、実ファイルが残っています。`;
  }

  // chunks は on delete cascade で一緒に消える
  const { error: deleteError } = await supabase
    .from("documents")
    .delete()
    .eq("id", documentId);

  if (deleteError) {
    return { ok: false, error: `削除に失敗しました: ${deleteError.message}` };
  }

  await writeAuditLog({
    orgId: session.profile.org_id,
    userId: session.id,
    action: "document.delete",
    targetType: "document",
    targetId: documentId,
    detail: {
      title: doc.title,
      filePath: doc.file_path,
      storageWarning: warning ?? null,
    },
  });

  revalidatePath("/admin/documents");
  return { ok: true, data: { warning } };
}

const UpdateAccessSchema = z.object({
  documentId: z.string().uuid(),
  allowedDepartments: z.array(z.string().trim().min(1)).max(50),
});

/** 公開部署の変更。取り込み直しは不要（RLS だけで効くため） */
export async function updateDocumentAccess(
  input: z.infer<typeof UpdateAccessSchema>,
): Promise<ActionResult<null>> {
  const session = await requireAdmin();

  const parsed = UpdateAccessSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "入力内容が不正です" };

  const supabase = await createClient();
  const { error } = await supabase
    .from("documents")
    .update({
      allowed_departments: parsed.data.allowedDepartments.length
        ? parsed.data.allowedDepartments
        : null,
    })
    .eq("id", parsed.data.documentId);

  if (error) return { ok: false, error: error.message };

  await writeAuditLog({
    orgId: session.profile.org_id,
    userId: session.id,
    action: "document.update_access",
    targetType: "document",
    targetId: parsed.data.documentId,
    detail: { allowedDepartments: parsed.data.allowedDepartments },
  });

  revalidatePath("/admin/documents");
  return { ok: true, data: null };
}
