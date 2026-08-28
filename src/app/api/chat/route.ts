import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  REFUSAL_MESSAGE,
  retrieve,
  streamAnswer,
  toCitations,
} from "@/lib/rag";
import { consumeQuota, quotaMessage } from "@/lib/rate-limit";
import { writeAuditLog } from "@/lib/ingest";
import type { Citation } from "@/lib/types";

const BodySchema = z.object({
  query: z.string().trim().min(1, "質問を入力してください").max(1000),
  conversationId: z.string().uuid().optional(),
});

/** クライアントへは NDJSON（1行1イベント）で流す */
type StreamEvent =
  | { type: "meta"; conversationId: string }
  | { type: "citations"; citations: Citation[] }
  | { type: "text"; text: string }
  | {
      type: "done";
      messageId: string;
      answered: boolean;
      topSimilarity: number;
    }
  | { type: "error"; message: string };

export async function POST(request: NextRequest) {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "認証が必要です" }, { status: 401 });
  }

  const parsed = BodySchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "不正なリクエストです" },
      { status: 400 },
    );
  }
  const { query } = parsed.data;

  const { data: profile } = await supabase
    .from("profiles")
    .select("org_id, department, role")
    .eq("id", user.id)
    .single();

  if (!profile) {
    return NextResponse.json(
      { error: "プロフィールが未設定です" },
      { status: 403 },
    );
  }

  // 回数制限は、会話を作るより先・課金の発生するより先に見る。
  // 公開デモはログイン情報がクライアントJSに載る前提なので、
  // ここが無いと誰でも API キーを好きなだけ叩ける（詳細は rate-limit.ts）。
  try {
    const quota = await consumeQuota(supabase, profile.role === "admin");
    if (!quota.allowed) {
      return NextResponse.json({ error: quotaMessage(quota) }, { status: 429 });
    }
  } catch (e) {
    console.error("[chat] quota check failed", e);
    return NextResponse.json(
      { error: "利用回数を確認できませんでした" },
      { status: 503 },
    );
  }

  // 会話がなければ作る。タイトルは最初の質問から仮生成する
  let conversationId = parsed.data.conversationId;
  if (!conversationId) {
    const { data: conv, error } = await supabase
      .from("conversations")
      .insert({
        org_id: profile.org_id,
        user_id: user.id,
        title: query.length > 30 ? `${query.slice(0, 30)}…` : query,
      })
      .select("id")
      .single();
    if (error || !conv) {
      return NextResponse.json(
        { error: "会話を作成できませんでした" },
        { status: 500 },
      );
    }
    conversationId = conv.id;
  }

  await supabase.from("messages").insert({
    conversation_id: conversationId,
    org_id: profile.org_id,
    role: "user",
    content: query,
  });

  const startedAt = Date.now();
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: StreamEvent) =>
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));

      try {
        send({ type: "meta", conversationId: conversationId! });

        // RLS が効いた supabase を渡すので、検索結果は自動で部署フィルタされる
        const result = await retrieve(supabase, query);

        let answerText = "";
        let citations: Citation[] = [];
        let answered = true;
        let topSimilarity = 0;
        let inputTokens: number | null = null;
        let outputTokens: number | null = null;

        if (result.kind === "faq") {
          topSimilarity = result.similarity;
          answerText = result.answer;
          send({ type: "text", text: answerText });
          await createAdminClient().rpc("increment_faq_hit", {
            faq_id: result.faqId,
          });
        } else if (result.kind === "insufficient") {
          answered = false;
          topSimilarity = result.topSimilarity;
          answerText = REFUSAL_MESSAGE;
          send({ type: "text", text: answerText });
        } else {
          topSimilarity = result.topSimilarity;

          // 出典はまだ送らない。検索は当たっていても「答えが書かれていない」
          // ことがあり、その判定はモデルの最初の1行で返ってくる。
          // 先に出典を出すと、拒否したのに根拠だけ並ぶ画面になる。
          const generator = streamAnswer(query, result.hits);
          let next = await generator.next();
          while (!next.done) {
            const chunk = next.value;
            if (chunk.type === "refused") {
              answered = false;
              answerText = REFUSAL_MESSAGE;
              send({ type: "text", text: answerText });
            } else if (chunk.type === "grounded") {
              citations = toCitations(result.hits);
              send({ type: "citations", citations });
            } else {
              answerText += chunk.text;
              send({ type: "text", text: chunk.text });
            }
            next = await generator.next();
          }
          inputTokens = next.value.inputTokens;
          outputTokens = next.value.outputTokens;
        }

        const { data: message } = await supabase
          .from("messages")
          .insert({
            conversation_id: conversationId,
            org_id: profile.org_id,
            role: "assistant",
            content: answerText,
            top_score: topSimilarity,
            answered,
            latency_ms: Date.now() - startedAt,
            input_tokens: inputTokens,
            output_tokens: outputTokens,
          })
          .select("id")
          .single();

        if (message && citations.length) {
          await supabase.from("citations").insert(
            citations.map((c) => ({
              message_id: message.id,
              chunk_id: c.chunk_id,
              rank: c.rank,
              score: c.score,
            })),
          );
        }

        // 答えられなかった質問は改善キューに積む（RLSが管理者限定なので admin 経由）
        if (!answered) {
          await createAdminClient()
            .from("unanswered")
            .insert({
              org_id: profile.org_id,
              query,
              top_score: topSimilarity,
              asked_by: user.id,
              message_id: message?.id ?? null,
            });
        }

        await writeAuditLog({
          orgId: profile.org_id,
          userId: user.id,
          action: "chat.ask",
          targetType: "conversation",
          targetId: conversationId,
          detail: { query, answered, topSimilarity },
        });

        send({
          type: "done",
          messageId: message?.id ?? "",
          answered,
          topSimilarity,
        });
      } catch (e) {
        console.error("[chat] failed", e);
        send({
          type: "error",
          message:
            e instanceof Error
              ? e.message
              : "回答の生成中にエラーが発生しました",
        });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
