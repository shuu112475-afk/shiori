/**
 * 複数の検索結果を1本にまとめる（Reciprocal Rank Fusion）。
 *
 * hybrid_search() の中でもベクトル側とキーワード側を RRF で統合しているが、
 * こちらは「検索文が複数あるとき」に、その結果同士をまとめるためのもの。
 * 質問を分解して2回引いた場合などに使う。
 *
 * rag.ts から分けているのは thresholds.ts / answer.ts と同じ理由で、
 * `scripts/*.mts` から直接読んで評価したいため。
 * 実行時の相対 import を持たない（型だけの import は消えるので可）。
 */
import type { SearchHit } from "./types";

/** SQL側の rrf_k の既定値と揃えている */
export const CROSS_QUERY_RRF_K = 60;

/**
 * 検索文ごとの結果リストを順位で統合する。
 *
 * cosine の絶対値を足さずに順位を使うのは、検索文が変われば
 * cosine の出方も変わり、そのままでは足せないため。順位なら比較できる。
 *
 * 同じチャンクが複数の検索文で出てきた場合、cosine は
 * 「最も高く出たときの値」を残す。未回答判定はこの値を見るので、
 * 分解した片方でしっかり当たっているならその事実を消さない。
 *
 * 戻り値の score は、この関数で計算し直した統合スコアで上書きする。
 */
export function mergeByRrf(lists: SearchHit[][], limit: number): SearchHit[] {
  const fused = new Map<number, { hit: SearchHit; score: number }>();

  for (const list of lists) {
    list.forEach((hit, index) => {
      const added = 1 / (CROSS_QUERY_RRF_K + index + 1);
      const current = fused.get(hit.chunk_id);
      if (!current) {
        fused.set(hit.chunk_id, { hit, score: added });
        return;
      }
      current.score += added;
      if (hit.vector_similarity > current.hit.vector_similarity) {
        current.hit = hit;
      }
    });
  }

  return [...fused.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ hit, score }) => ({ ...hit, score }));
}
