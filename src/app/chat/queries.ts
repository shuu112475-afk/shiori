import type { SupabaseClient } from "@supabase/supabase-js";
import type { Citation, MessageRow } from "@/lib/types";
import type { ChatMessage, ConversationSummary } from "@/components/chat/types";

/** サイドバー用。本文は不要なので必要列だけ、新しい順に上限50件 */
export async function loadConversations(
  supabase: SupabaseClient,
  userId: string,
): Promise<ConversationSummary[]> {
  const { data } = await supabase
    .from("conversations")
    .select("id, title, created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(50);

  return (data ?? []) as ConversationSummary[];
}

/**
 * citations → chunks → documents をネストした select の生の形。
 * SupabaseClient に Database 型を付けていないので戻り値は any になる。
 * 1対多に見えるか1対1に見えるかは PostgREST の推論次第なので、
 * 配列でもオブジェクトでも受けられるようにしておく。
 */
type Nested<T> = T | T[] | null;

type CitationJoinRow = {
  message_id: string;
  rank: number;
  score: number;
  chunks: Nested<{
    id: number;
    content: string;
    heading_path: string | null;
    page_no: number | null;
    documents: Nested<{ id: string; title: string }>;
  }>;
};

function one<T>(value: Nested<T>): T | null {
  if (!value) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

/**
 * 過去の会話を復元する。
 * 出典は citations テーブルから chunks / documents を辿って組み立て直す
 * （生成時に UI へ返した Citation と同じ形に揃える）。
 */
export async function loadConversationMessages(
  supabase: SupabaseClient,
  conversationId: string,
): Promise<ChatMessage[]> {
  const { data: rows } = await supabase
    .from("messages")
    .select("*")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true });

  const messageRows = (rows ?? []) as MessageRow[];
  if (messageRows.length === 0) return [];

  const assistantIds = messageRows
    .filter((m) => m.role === "assistant")
    .map((m) => m.id);

  const citationsByMessage = new Map<string, Citation[]>();

  if (assistantIds.length > 0) {
    const { data: citationRows } = await supabase
      .from("citations")
      .select(
        "message_id, rank, score, chunks(id, content, heading_path, page_no, documents(id, title))",
      )
      .in("message_id", assistantIds)
      .order("rank", { ascending: true });

    for (const raw of (citationRows ?? []) as unknown as CitationJoinRow[]) {
      const chunk = one(raw.chunks);
      const document = chunk ? one(chunk.documents) : null;
      // チャンクが削除済み（＝元文書が消された）出典は、番号だけ残しても
      // 混乱するので落とす
      if (!chunk) continue;

      const content = chunk.content ?? "";
      const list = citationsByMessage.get(raw.message_id) ?? [];
      list.push({
        rank: raw.rank,
        chunk_id: chunk.id,
        document_id: document?.id ?? "",
        document_title: document?.title ?? "（削除された文書）",
        heading_path: chunk.heading_path,
        page_no: chunk.page_no,
        // 生成時（rag.ts の toCitations）と同じ 240 文字で切る
        excerpt: content.length > 240 ? `${content.slice(0, 240)}…` : content,
        score: raw.score,
      });
      citationsByMessage.set(raw.message_id, list);
    }
  }

  return messageRows.map((m) => ({
    id: m.id,
    role: m.role,
    content: m.content,
    citations: citationsByMessage.get(m.id) ?? [],
    answered: m.answered,
    topScore: m.top_score,
    createdAt: m.created_at,
  }));
}
