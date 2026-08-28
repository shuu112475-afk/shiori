"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { embedQuery, toVectorLiteral } from "@/lib/embedding";
import { writeAuditLog } from "@/lib/ingest";
import type { ActionResult } from "@/app/admin/action-result";

/**
 * FAQ は「質問文の埋め込み」で照合される（match_faq）。
 * 質問文を保存・変更するときは必ず埋め込みを作り直す必要があるので、
 * 埋め込み生成をここに一本化する。
 */
async function embedQuestion(
  question: string,
): Promise<{ ok: true; vector: string } | { ok: false; error: string }> {
  try {
    return { ok: true, vector: toVectorLiteral(await embedQuery(question)) };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      error: `質問文のベクトル化に失敗しました: ${message}（OPENAI_API_KEY を確認してください）`,
    };
  }
}

const ResolveSchema = z.object({
  unansweredId: z.string().uuid(),
  question: z.string().trim().min(1, "質問文を入力してください").max(500),
  answer: z.string().trim().min(1, "回答を入力してください").max(4000),
});

/**
 * 未回答の質問に answer を紐づけて FAQ 化する。
 *
 * ここで登録した FAQ は match_faq（類似度 0.92 以上）で照合され、
 * 次に同じ質問が来たときは検索も生成も行わず即答される。
 * = 「答えられなかった質問」が「即答できる質問」に変わる改善ループの出口。
 */
export async function resolveWithFaq(
  input: z.infer<typeof ResolveSchema>,
): Promise<ActionResult<{ faqId: string }>> {
  const session = await requireAdmin();

  const parsed = ResolveSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "入力内容が不正です",
    };
  }
  const { unansweredId, question, answer } = parsed.data;

  const supabase = await createClient();
  const orgId = session.profile.org_id;

  // RLS（unanswered_admin）で自組織に限定される
  const { data: target } = await supabase
    .from("unanswered")
    .select("id, query, resolved")
    .eq("id", unansweredId)
    .maybeSingle<{ id: string; query: string; resolved: boolean }>();

  if (!target) {
    return { ok: false, error: "対象の質問が見つかりません" };
  }

  const embedded = await embedQuestion(question);
  if (!embedded.ok) return { ok: false, error: embedded.error };

  const { data: faq, error: faqError } = await supabase
    .from("faq_overrides")
    .insert({
      org_id: orgId,
      question,
      answer,
      embedding: embedded.vector,
      enabled: true,
      created_by: session.id,
    })
    .select("id")
    .single<{ id: string }>();

  if (faqError || !faq) {
    return {
      ok: false,
      error: `FAQの登録に失敗しました: ${faqError?.message ?? "unknown"}`,
    };
  }

  const { error: updateError } = await supabase
    .from("unanswered")
    .update({ resolved: true, faq_override_id: faq.id })
    .eq("id", unansweredId);

  if (updateError) {
    return {
      ok: false,
      error: `FAQは登録できましたが、未回答キューの更新に失敗しました: ${updateError.message}`,
    };
  }

  await writeAuditLog({
    orgId,
    userId: session.id,
    action: "faq.create",
    targetType: "faq_override",
    targetId: faq.id,
    detail: { question, originalQuery: target.query, unansweredId },
  });

  revalidatePath("/admin/unanswered");
  return { ok: true, data: { faqId: faq.id } };
}

const FaqUpdateSchema = z.object({
  faqId: z.string().uuid(),
  question: z.string().trim().min(1, "質問文を入力してください").max(500),
  answer: z.string().trim().min(1, "回答を入力してください").max(4000),
});

export async function updateFaq(
  input: z.infer<typeof FaqUpdateSchema>,
): Promise<ActionResult<null>> {
  const session = await requireAdmin();

  const parsed = FaqUpdateSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "入力内容が不正です",
    };
  }
  const { faqId, question, answer } = parsed.data;

  const supabase = await createClient();

  const { data: current } = await supabase
    .from("faq_overrides")
    .select("id, question")
    .eq("id", faqId)
    .maybeSingle<{ id: string; question: string }>();

  if (!current) return { ok: false, error: "FAQが見つかりません" };

  const patch: Record<string, unknown> = { question, answer };

  // 回答だけ直したときに埋め込みAPIを叩くのは無駄なので、質問文が変わったときだけ作り直す
  if (current.question !== question) {
    const embedded = await embedQuestion(question);
    if (!embedded.ok) return { ok: false, error: embedded.error };
    patch.embedding = embedded.vector;
  }

  const { error } = await supabase
    .from("faq_overrides")
    .update(patch)
    .eq("id", faqId);

  if (error)
    return { ok: false, error: `更新に失敗しました: ${error.message}` };

  await writeAuditLog({
    orgId: session.profile.org_id,
    userId: session.id,
    action: "faq.update",
    targetType: "faq_override",
    targetId: faqId,
    detail: { question, reEmbedded: current.question !== question },
  });

  revalidatePath("/admin/unanswered");
  return { ok: true, data: null };
}

const ToggleSchema = z.object({
  faqId: z.string().uuid(),
  enabled: z.boolean(),
});

/** 削除ではなく無効化。効果を比べたいときに戻せるようにしておく */
export async function toggleFaq(
  input: z.infer<typeof ToggleSchema>,
): Promise<ActionResult<null>> {
  const session = await requireAdmin();

  const parsed = ToggleSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "入力内容が不正です" };

  const supabase = await createClient();
  const { error } = await supabase
    .from("faq_overrides")
    .update({ enabled: parsed.data.enabled })
    .eq("id", parsed.data.faqId);

  if (error) return { ok: false, error: error.message };

  await writeAuditLog({
    orgId: session.profile.org_id,
    userId: session.id,
    action: parsed.data.enabled ? "faq.enable" : "faq.disable",
    targetType: "faq_override",
    targetId: parsed.data.faqId,
  });

  revalidatePath("/admin/unanswered");
  return { ok: true, data: null };
}

const UnansweredStatusSchema = z.object({
  unansweredId: z.string().uuid(),
  resolved: z.boolean(),
});

/**
 * FAQ を作らずに片付ける／差し戻す。
 * 「そもそも社内文書に無い質問」まで FAQ 化すると FAQ が汚れるため、逃がし口を用意する。
 */
export async function setUnansweredResolved(
  input: z.infer<typeof UnansweredStatusSchema>,
): Promise<ActionResult<null>> {
  const session = await requireAdmin();

  const parsed = UnansweredStatusSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "入力内容が不正です" };

  const supabase = await createClient();
  const { error } = await supabase
    .from("unanswered")
    .update({
      resolved: parsed.data.resolved,
      // 差し戻すときは FAQ の紐づけも外す
      ...(parsed.data.resolved ? {} : { faq_override_id: null }),
    })
    .eq("id", parsed.data.unansweredId);

  if (error) return { ok: false, error: error.message };

  await writeAuditLog({
    orgId: session.profile.org_id,
    userId: session.id,
    action: parsed.data.resolved ? "unanswered.dismiss" : "unanswered.reopen",
    targetType: "unanswered",
    targetId: parsed.data.unansweredId,
  });

  revalidatePath("/admin/unanswered");
  return { ok: true, data: null };
}
