import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";

const BodySchema = z.object({
  messageId: z.string().uuid(),
  verdict: z.enum(["good", "bad"]),
  comment: z.string().trim().max(500).optional(),
});

export async function POST(request: NextRequest) {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "認証が必要です" }, { status: 401 });
  }

  const parsed = BodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "不正なリクエストです" },
      { status: 400 },
    );
  }
  const { messageId, verdict, comment } = parsed.data;

  const { data: profile } = await supabase
    .from("profiles")
    .select("org_id")
    .eq("id", user.id)
    .single();

  if (!profile) {
    return NextResponse.json(
      { error: "プロフィールが未設定です" },
      { status: 403 },
    );
  }

  // messages は RLS で本人の会話しか見えない。
  // ここで存在確認すれば、他人のメッセージへの評価を弾ける
  const { data: message } = await supabase
    .from("messages")
    .select("id")
    .eq("id", messageId)
    .maybeSingle();

  if (!message) {
    return NextResponse.json(
      { error: "対象のメッセージが見つかりません" },
      { status: 404 },
    );
  }

  // feedback は (message_id, user_id) にユニーク制約がある。
  // 評価をやり直したら上書きになるよう upsert する
  const { error } = await supabase.from("feedback").upsert(
    {
      message_id: messageId,
      org_id: profile.org_id,
      user_id: user.id,
      verdict,
      comment: comment ?? null,
    },
    { onConflict: "message_id,user_id" },
  );

  if (error) {
    console.error("[feedback] upsert failed", error);
    return NextResponse.json(
      { error: "評価を保存できませんでした" },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true });
}
