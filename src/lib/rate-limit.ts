import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * 1ユーザーが1日に投げられる質問数。
 *
 * 公開デモは1つのアカウントを全員で共有するので、この値がそのまま
 * 「サイト全体の1日の上限」になる。
 *
 * 1問あたりの実測（3問の平均。入力2,203 / 出力366 トークン）:
 *   Sonnet 生成    $0.0121
 *   Haiku 書き換え $0.0012
 *   Embedding      $0.00001 未満
 *   合計           $0.0133
 * 上限30問なら、毎日使い切られても $0.40/日・$12/月。
 * ここを上げるときは、日額ではなく月額で考えること。
 *
 * 0 以下を入れると無制限になる（ローカル開発用）。
 */
export const DAILY_QUESTION_LIMIT = Number(
  process.env.RAG_DAILY_QUESTION_LIMIT ?? 30,
);

export type QuotaResult =
  | { allowed: true }
  | { allowed: false; used: number; limit: number; resetAt: Date };

/**
 * 1回分を消費し、上限を超えていないかを返す。
 *
 * 数えるのは Postgres 側（consume_quota）。アプリのメモリに持つと
 * Vercel の関数インスタンスが増減するたびにカウンタが飛ぶ。
 *
 * 消費は「答える前」に行う。生成に失敗しても1回分は減るが、
 * 逆にすると失敗を繰り返させて課金だけさせる余地が残る。
 */
export async function consumeQuota(
  supabase: SupabaseClient,
  isAdmin: boolean,
): Promise<QuotaResult> {
  // 管理者（＝リポジトリの持ち主）は制限しない。
  // デモ用アカウントは member なので必ず数えられる。
  if (isAdmin || DAILY_QUESTION_LIMIT <= 0) return { allowed: true };

  const { data, error } = await supabase.rpc("consume_quota").single<{
    used: number;
    reset_at: string;
  }>();

  // 数えられなかったときに素通しすると制限が無いのと同じになるので、
  // ここは落とす側に倒す（0005 のマイグレーション未適用もここに出る）。
  if (error || !data) {
    throw new Error(`利用回数を確認できませんでした: ${error?.message ?? ""}`);
  }

  if (data.used <= DAILY_QUESTION_LIMIT) return { allowed: true };

  return {
    allowed: false,
    used: data.used,
    limit: DAILY_QUESTION_LIMIT,
    resetAt: new Date(data.reset_at),
  };
}

/** 画面にそのまま出す文言 */
export function quotaMessage(r: Extract<QuotaResult, { allowed: false }>) {
  const jst = r.resetAt.toLocaleString("ja-JP", {
    timeZone: "Asia/Tokyo",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  return (
    `このデモは1日${r.limit}問までです（本日 ${r.used - 1}問）。` +
    `${jst} に上限がリセットされます。`
  );
}
