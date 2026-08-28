import type { SupabaseClient } from "@supabase/supabase-js";
// 相対 import に拡張子を付けているのは、このファイルを scripts/*.mts から
// そのまま読めるようにするため。Node の型ストリッピングは拡張子なしの
// 相対指定を解決できない（tsconfig の allowImportingTsExtensions で許可済み）。
//
// これを付ける前は eval-refusal.mts が retrieve() を使えず、検索の手順を
// 自前で書き写していた。その写しが古いまま残り、書き換えを実装したあとも
// 「B-01 は誤拒否」と報告し続けていた（実際には解消していた）。
// 評価スクリプトが本番と違う経路を測るのは、測っていないのと同じなので、
// 経路は1本に保つ。
import { embedQuery, toVectorLiteral } from "./embedding.ts";
import { ANSWER_THRESHOLD, FAQ_THRESHOLD } from "./thresholds.ts";
import { ANSWER_MODEL, streamAnswer } from "./answer.ts";
import { rewriteQuery, withOriginal } from "./query-rewrite.ts";
import { mergeByRrf } from "./fusion.ts";
import type { AnswerChunk, AnswerUsage } from "./answer.ts";
import type { Citation, SearchHit } from "./types.ts";

// 閾値の実体は ./thresholds、生成と根拠判定は ./answer、
// 検索前の質問の整形は ./query-rewrite にある。
// 既存の import 元を変えずに済むよう、ここから re-export する。
export { ANSWER_THRESHOLD, FAQ_THRESHOLD, ANSWER_MODEL, streamAnswer };
export type { AnswerChunk, AnswerUsage };

export const REFUSAL_MESSAGE =
  "社内文書の中に、ご質問に該当する記載が見つかりませんでした。\n" +
  "表現を変えて質問し直すか、管理者にお問い合わせください。";

export type RetrievalResult =
  | { kind: "faq"; faqId: string; answer: string; similarity: number }
  | {
      kind: "hits" | "insufficient";
      hits: SearchHit[];
      topSimilarity: number;
      /**
       * 実際に検索へ投げた文。1本目は必ず元の質問で、2本目以降が書き換え。
       * 拒否されたときに「検索が悪かったのか、本当に載っていないのか」を
       * 切り分ける材料になるので返している。いまは評価スクリプトが使う。
       */
      queries: string[];
    };

export type RetrieveOptions = {
  matchCount?: number;
  /**
   * 検索前に質問を文書側の言葉へ直すか。
   * false にすると質問そのままで1回だけ引く（`npm run eval` の比較用）。
   */
  rewrite?: boolean;
};

/**
 * 質問に対して根拠を集める。
 * 1. FAQ上書きに強く一致すれば、検索せず即答する
 * 2. 質問を文書側の言葉に直し、必要なら複数の検索文に分ける
 *    （元の質問も検索文として残す。書き換えは足すだけで、置き換えない）
 * 3. 検索文ごとにハイブリッド検索（ベクトル + trigram を RRF 統合）
 * 4. 検索文が複数ならその結果をさらに RRF で統合する
 * 5. 最良 cosine 類似度が閾値未満なら insufficient を返す（＝答えない）
 */
export async function retrieve(
  supabase: SupabaseClient,
  query: string,
  options: RetrieveOptions = {},
): Promise<RetrievalResult> {
  const { matchCount = 5, rewrite = true } = options;

  // FAQ は「利用者の言い回し」同士を突き合わせるものなので、
  // 書き換える前の質問で引く。書き換えると登録時の文面から離れてしまう。
  const originalEmbedding = await embedQuery(query);

  const { data: faqData, error: faqError } = await supabase
    .rpc("match_faq", {
      query_embedding: toVectorLiteral(originalEmbedding),
      similarity_threshold: FAQ_THRESHOLD,
    })
    .maybeSingle<{
      id: string;
      question: string;
      answer: string;
      similarity: number;
    }>();

  if (faqError) throw faqError;
  if (faqData) {
    return {
      kind: "faq",
      faqId: faqData.id,
      answer: faqData.answer,
      similarity: faqData.similarity,
    };
  }

  // FAQ に当たらなかったときだけ書き換える（当たった質問では Haiku を呼ばない）。
  //
  // 元の質問は必ず1本目に残す。書き換えは取りこぼしを「足す」ためのもので、
  // 元の言い回しで既に1位を取れている質問の順位を下げてよい理由はない。
  // 実際、置き換え方式にしたときは A-06「旅費精算 提出期限」など
  // 3問が1位から落ちた（Hit@1 88.9% → 85.2%）。
  const queries = rewrite
    ? withOriginal(query, (await rewriteQuery(query)).queries)
    : [query];

  // 分解したときは1つの検索文あたりの枠が減るので、返す件数を少し増やす。
  // 増やしすぎると資料が薄まるので +3 に留めている。
  const finalCount = queries.length === 1 ? matchCount : matchCount + 3;

  // 検索文どうしは独立しているので同時に投げる。
  //
  // 直列に回していたときは、検索文が1本増えるごとに
  // 埋め込み1往復とSQL1往復が待ち時間に積み上がっていた。
  // 書き換えは 27問中15問で3本に分かれるので、これは体感に出る差になる。
  // 同時に投げれば所要時間は最も遅い1本と同じで、本数にほぼ依存しない。
  //
  // 「分けすぎ」をプロンプトで抑え込もうとしたが、Haiku は
  // 「賞与 支給時期／賞与 支給日」のような言い換えだけの2行目を出し続けた。
  // ただし実測では順位が下がった質問は0問で、増えた費用も
  // 埋め込み1回（$0.00002 程度）なので、遅さだけが実害だった。
  // 指示で直らないものを指示で直そうとするより、実害の側を消す。
  const lists = await Promise.all(
    queries.map(async (q) => {
      // 元の質問と同じ文なら埋め込みを取り直さない
      const vectorLiteral =
        q === query
          ? toVectorLiteral(originalEmbedding)
          : toVectorLiteral(await embedQuery(q));

      const { data, error } = await supabase.rpc("hybrid_search", {
        query_embedding: vectorLiteral,
        query_text: q,
        match_count: matchCount,
      });
      if (error) throw error;
      return (data ?? []) as SearchHit[];
    }),
  );

  const hits = lists.length === 1 ? lists[0] : mergeByRrf(lists, finalCount);
  const topSimilarity = hits.reduce(
    (max, h) => Math.max(max, h.vector_similarity ?? 0),
    0,
  );

  if (!hits.length || topSimilarity < ANSWER_THRESHOLD) {
    return { kind: "insufficient", hits, topSimilarity, queries };
  }
  return { kind: "hits", hits, topSimilarity, queries };
}

/** UI に返す出典情報へ変換する */
export function toCitations(hits: SearchHit[]): Citation[] {
  return hits.map((h, i) => ({
    rank: i + 1,
    chunk_id: h.chunk_id,
    document_id: h.document_id,
    document_title: h.document_title,
    heading_path: h.heading_path,
    page_no: h.page_no,
    excerpt: h.content.length > 240 ? `${h.content.slice(0, 240)}…` : h.content,
    score: h.score,
  }));
}
