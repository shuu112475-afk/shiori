/**
 * RAG の判定に使う閾値。
 *
 * ここだけ独立したモジュールにしてあるのは、`scripts/*.mts` を
 * Node の型ストリッピング（--experimental-strip-types）で直接実行するため。
 * Node は拡張子なしの相対 import を解決できないので、
 * `./embedding` のような書き方を含む rag.ts をスクリプトから読み込めない。
 *
 * かといってスクリプト側で 0.35 を書き写すと、片方だけ変えたときに
 * 「アプリは答えるのに評価では拒否」というズレが起きる。
 * そこで依存を持たない値だけをここに置き、rag.ts は re-export する。
 */

/**
 * 「答えられる」と判断する cosine 類似度の下限。
 *
 * hybrid_search が返す RRF スコアは順位だけで決まるため、
 * 無関係な文書しかなくても1位なら高い値になる。したがって
 * 回答可否の判定には必ず cosine 類似度（vector_similarity）を使う。
 */
export const ANSWER_THRESHOLD = Number(
  process.env.RAG_ANSWER_THRESHOLD ?? 0.35,
);

/** FAQ上書きを即答に使う類似度の下限 */
export const FAQ_THRESHOLD = Number(process.env.RAG_FAQ_THRESHOLD ?? 0.92);
