/**
 * 検索精度の評価スクリプト。
 *
 *   node --env-file=.env.local --experimental-strip-types scripts/evaluate.mts
 *
 * demo/eval/questions.json の30問を投げ、
 *   ・ベクトル検索のみ
 *   ・ハイブリッド検索（ベクトル + pg_trgm を RRF で統合）
 *   ・ハイブリッド + 質問の書き換え（文書側の言葉に直し、必要なら分解）
 * の3通りで Hit@1 / Hit@3 / Hit@5 / MRR を比較する。
 * 「その工夫に意味があったのか」を毎回数字で言えるようにするのが目的。
 *
 * 生成は行わない（検索の当たり外れだけを見る）。費用は Embedding と、
 * 書き換えの Haiku 30回分で、1回あたり $0.02 程度。
 *
 * service role で実行するので RLS は効かない＝全文書が検索対象になる。
 * 部署フィルタの検証はこのスクリプトの対象外（画面から確認すること）。
 */
import { readFileSync } from "node:fs";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { embedQuery, toVectorLiteral } from "../src/lib/embedding.ts";
// rag.ts ではなく個別のモジュールから取る。
// rag.ts は `./embedding` のような拡張子なし相対 import を含み、
// Node の型ストリッピングでは解決できないため。
import { ANSWER_THRESHOLD } from "../src/lib/thresholds.ts";
import { rewriteQuery, withOriginal } from "../src/lib/query-rewrite.ts";
import { mergeByRrf } from "../src/lib/fusion.ts";
import type { SearchHit } from "../src/lib/types.ts";

type Question = {
  id: string;
  category: "A" | "B" | "C" | "D";
  question: string;
  expected_document: string | null;
  expected_heading?: string | null;
  supporting_documents?: string[];
  expected_answer_contains?: string[];
  should_answer: boolean;
  note?: string;
};

// 検索結果の型はアプリ本体と同じものを使う。
// types.ts は実行時 import を持たないので型ストリッピングでも読める。
type Hit = SearchHit;

const POOL_SIZE = 20;
const TOP_N = 5;
/**
 * 質問を分解したときに渡す件数。rag.ts の finalCount と揃えている。
 * 分解すると1つの検索文あたりの枠が減るので少しだけ広げる。
 */
const SPLIT_TOP_N = TOP_N + 3;

/**
 * 書き換え後の検索文で引いて、結果を1本にまとめる。
 * 本番（rag.ts の retrieve）と同じ手順を踏むこと自体が目的なので、
 * 件数の決め方もあちらに合わせている。
 */
async function searchRewritten(
  supabase: SupabaseClient,
  question: string,
): Promise<{ hits: Hit[]; queries: string[] }> {
  // 元の質問を1本目に残すところまで含めて本番と同じにする。
  // ここを揃えていないと、評価で見ている順位が本番の順位ではなくなる。
  const queries = withOriginal(
    question,
    (await rewriteQuery(question)).queries,
  );
  // 本番と同じく同時に投げる
  const lists = await Promise.all(
    queries.map(async (q) => {
      const { data, error } = await supabase.rpc("hybrid_search", {
        query_embedding: toVectorLiteral(await embedQuery(q)),
        query_text: q,
        match_count: TOP_N,
        pool_size: POOL_SIZE,
      });
      if (error) throw new Error(`${question} / ${q}: ${error.message}`);
      return (data ?? []) as Hit[];
    }),
  );
  const hits = lists.length === 1 ? lists[0] : mergeByRrf(lists, SPLIT_TOP_N);
  return { hits, queries };
}

/**
 * アップロード時のタイトルは拡張子ありなしが揺れうるので、
 * 拡張子と連番プレフィックスを落として突き合わせる。
 */
function normalizeTitle(s: string): string {
  return s
    .replace(/\.(md|pdf|docx?|txt)$/i, "")
    .replace(/\s+/g, "")
    .toLowerCase();
}

function requiredDocs(q: Question): string[] {
  return [q.expected_document, ...(q.supporting_documents ?? [])]
    .filter((d): d is string => typeof d === "string")
    .map(normalizeTitle);
}

function isCorrect(hit: Hit, q: Question): boolean {
  return requiredDocs(q).some((e) =>
    normalizeTitle(hit.document_title).includes(e),
  );
}

/**
 * 必要な文書が「すべて」上位に入っているか。
 *
 * Hit@k は正解文書が1本でも入れば当たりと数えるので、
 * 2文書を突き合わせないと答えられない質問（カテゴリC）では
 * 片方しか引けていなくても満点に見えてしまう。
 * 実際 C-04 は Hit@1 が当たりなのに、差分計算に必要な
 * 就業規則第12条が引けておらず、回答は作れなかった。
 * その取りこぼしを見えるようにするための指標。
 */
function coversAllDocs(hits: Hit[], q: Question): boolean {
  return requiredDocs(q).every((e) =>
    hits.some((h) => normalizeTitle(h.document_title).includes(e)),
  );
}

/** 先頭から見て最初に正解が現れた順位（1始まり）。無ければ null */
function firstCorrectRank(hits: Hit[], q: Question): number | null {
  const i = hits.findIndex((h) => isCorrect(h, q));
  return i === -1 ? null : i + 1;
}

type Metrics = {
  n: number;
  hit1: number;
  hit3: number;
  hit5: number;
  mrrSum: number;
};

function emptyMetrics(): Metrics {
  return { n: 0, hit1: 0, hit3: 0, hit5: 0, mrrSum: 0 };
}

function accumulate(m: Metrics, rank: number | null) {
  m.n += 1;
  if (rank === null) return;
  if (rank <= 1) m.hit1 += 1;
  if (rank <= 3) m.hit3 += 1;
  if (rank <= 5) m.hit5 += 1;
  m.mrrSum += 1 / rank;
}

function pct(a: number, b: number): string {
  return b === 0 ? "  -  " : `${((a / b) * 100).toFixed(1).padStart(5)}%`;
}

function formatRow(label: string, m: Metrics): string {
  const mrr = m.n === 0 ? "  -  " : (m.mrrSum / m.n).toFixed(3).padStart(5);
  return `${label.padEnd(22)} ${String(m.n).padStart(3)}問   ${pct(m.hit1, m.n)}   ${pct(m.hit3, m.n)}   ${pct(m.hit5, m.n)}   ${mrr}`;
}

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY が未設定です。--env-file=.env.local を付けて実行してください",
    );
  }
  const supabase = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const raw = JSON.parse(
    readFileSync(
      new URL("../demo/eval/questions.json", import.meta.url),
      "utf8",
    ),
  );
  const questions: Question[] = Array.isArray(raw) ? raw : raw.questions;

  const answerable = questions.filter((q) => q.should_answer);
  const refusable = questions.filter((q) => !q.should_answer);

  const vectorAll = emptyMetrics();
  const hybridAll = emptyMetrics();
  const rewriteAll = emptyMetrics();
  const byCategory = new Map<string, { v: Metrics; h: Metrics; r: Metrics }>();
  const regressions: string[] = [];
  // 書き換えで悪化した質問。増えるなら書き換えのプロンプトを疑う
  const rewriteRegressions: string[] = [];
  // 検索文の本数ごとの質問数。添字がそのまま本数（元の質問を含む）。
  // 元の質問は必ず1本目に入るので、2本 = 書き換えを1つ足した、
  // 3本 = 別々の規程を見に行くべきと判断して分解した、という意味になる。
  const armCounts = new Map<number, number>();
  // キーワード側が実際に発火しているかを数える。
  // ここが0だと「ハイブリッド」を名乗っていても中身はベクトル検索だけになる
  // （0004 で踏んだ不具合。閾値が既定の 0.6 のままだと日本語では常に0件）
  let lexicalFired = 0;
  // 複数文書をまたぐ質問で、必要な文書がすべて上位に入ったか
  const multiDoc: {
    id: string;
    covered: boolean;
    coveredRewritten: boolean;
  }[] = [];

  console.log(
    `評価開始: ${questions.length}問（回答すべき ${answerable.length} / 断るべき ${refusable.length}）\n`,
  );

  for (const q of answerable) {
    const embedding = await embedQuery(q.question);
    const { data, error } = await supabase.rpc("hybrid_search", {
      query_embedding: toVectorLiteral(embedding),
      query_text: q.question,
      // プール全体を受け取り、同じ結果からベクトル単体とハイブリッドの両方を作る
      match_count: POOL_SIZE * 2,
      pool_size: POOL_SIZE,
    });
    if (error) throw new Error(`${q.id}: ${error.message}`);

    const hits = (data ?? []) as Hit[];
    if (hits.some((h) => h.lexical_rank != null)) lexicalFired += 1;

    // ベクトル単体: ベクトル側にヒットしたものだけを vector_rank 順に
    const vectorTop = hits
      .filter((h) => h.vector_rank != null)
      .sort((a, b) => a.vector_rank! - b.vector_rank!)
      .slice(0, TOP_N);

    // ハイブリッド: RRF スコアの降順（RPC が既にこの順で返す）
    const hybridTop = hits.slice(0, TOP_N);

    // 書き換えあり: 本番と同じ手順で引き直す
    const { hits: rewriteTop, queries } = await searchRewritten(
      supabase,
      q.question,
    );
    armCounts.set(queries.length, (armCounts.get(queries.length) ?? 0) + 1);

    const vRank = firstCorrectRank(vectorTop, q);
    const hRank = firstCorrectRank(hybridTop, q);
    // 分解したときは本番も8件返すが、順位の指標だけは他の2方式と同じ
    // 上位5件で測る。8件から測ると6〜8位が MRR に乗ってしまい、
    // 「枠を広げたぶん有利」なだけの差を改善に見せかけてしまうため。
    // 文書カバー率は本番どおり8件で見る（生成モデルには8件渡るので）。
    const rRank = firstCorrectRank(rewriteTop.slice(0, TOP_N), q);

    if (q.supporting_documents?.length) {
      multiDoc.push({
        id: q.id,
        covered: coversAllDocs(hybridTop, q),
        coveredRewritten: coversAllDocs(rewriteTop, q),
      });
    }

    accumulate(vectorAll, vRank);
    accumulate(hybridAll, hRank);
    accumulate(rewriteAll, rRank);

    const cat = byCategory.get(q.category) ?? {
      v: emptyMetrics(),
      h: emptyMetrics(),
      r: emptyMetrics(),
    };
    accumulate(cat.v, vRank);
    accumulate(cat.h, hRank);
    accumulate(cat.r, rRank);
    byCategory.set(q.category, cat);

    if (hRank !== null && (rRank === null || rRank > hRank)) {
      rewriteRegressions.push(
        `  ${q.id} ${q.question}（書き換えなし ${hRank}位 → あり ${rRank ?? "圏外"}）` +
          `\n     投げた検索文: ${queries.join(" ／ ")}`,
      );
    }

    // ハイブリッドにして悪化した質問は個別に潰したいので控えておく
    if (vRank !== null && (hRank === null || hRank > vRank)) {
      regressions.push(
        `  ${q.id} ${q.question}（ベクトル ${vRank}位 → ハイブリッド ${hRank ?? "圏外"}）`,
      );
    }

    const mark = rRank === 1 ? "○" : rRank !== null ? "△" : "×";
    const top = rewriteTop[0];
    console.log(
      `${mark} ${q.id} v=${vRank ?? "-"} h=${hRank ?? "-"} r=${rRank ?? "-"}` +
        `  sim=${top?.vector_similarity.toFixed(3) ?? "-"}  ${q.question}`,
    );
    // 1本目は元の質問なので、足された分だけを出す
    if (queries.length > 1) {
      console.log(`     足した検索文: ${queries.slice(1).join(" ／ ")}`);
    }
    if (rRank !== 1 && top) {
      console.log(
        `     1位に来たのは: ${top.document_title} / ${top.heading_path ?? "(見出しなし)"}`,
      );
    }
  }

  // --- 断るべき質問 ---
  console.log("\n--- 答えられないべき質問（閾値 %s） ---", ANSWER_THRESHOLD);
  // 書き換えは「引っかかりやすくする」方向の工夫なので、
  // 断るべき質問の類似度を押し上げていないかも併せて見る。
  let refusedCorrectly = 0;
  for (const q of refusable) {
    const { hits, queries } = await searchRewritten(supabase, q.question);
    const topSim = hits.length
      ? Math.max(...hits.map((h) => h.vector_similarity))
      : 0;
    const refused = topSim < ANSWER_THRESHOLD;
    if (refused) refusedCorrectly += 1;
    console.log(
      `${refused ? "○" : "×"} ${q.id} sim=${topSim.toFixed(3)}  ${q.question}` +
        (refused ? "" : `  ← 誤って答えてしまう（${hits[0]?.document_title}）`),
    );
    if (queries.length > 1) {
      console.log(`     足した検索文: ${queries.slice(1).join(" ／ ")}`);
    }
  }

  // --- サマリー ---
  console.log("\n============================================================");
  console.log("検索精度（正解文書が上位に入った割合）");
  console.log("------------------------------------------------------------");
  console.log(`${"".padEnd(22)}  件数    Hit@1    Hit@3    Hit@5     MRR`);
  console.log(formatRow("ベクトル検索のみ", vectorAll));
  console.log(formatRow("ハイブリッド+RRF", hybridAll));
  console.log(formatRow("＋質問の書き換え", rewriteAll));

  console.log("\n1問あたりに投げた検索文の本数（元の質問を1本目に含む）");
  for (const [n, c] of [...armCounts].sort((a, b) => a[0] - b[0])) {
    console.log(`  ${n}本: ${String(c).padStart(3)}問`);
  }

  console.log(
    `\nキーワード側が1件以上ヒットした質問: ${lexicalFired}/${answerable.length}` +
      (lexicalFired === 0
        ? "\n  ⚠ 0件です。RRFがベクトル順位しか見ていない＝実質ベクトル検索のみになっています。" +
          "\n    supabase/migrations/0004_lexical_threshold.sql を適用してください。"
        : ""),
  );

  console.log("\nカテゴリ別（書き換えあり）");
  const labels: Record<string, string> = {
    A: "A 単一文書で明確",
    B: "B 表記ゆれ・言い換え",
    C: "C 複数文書をまたぐ",
  };
  for (const [cat, m] of [...byCategory].sort()) {
    console.log(formatRow(labels[cat] ?? cat, m.r));
    console.log(formatRow(`  （書き換えなし）`, m.h));
    console.log(formatRow(`  （ベクトルのみ）`, m.v));
  }

  if (multiDoc.length) {
    const covered = multiDoc.filter((m) => m.covered);
    const coveredRw = multiDoc.filter((m) => m.coveredRewritten);
    console.log(
      `\n複数文書が必要な質問で、必要な文書がすべて揃った割合` +
        `\n  書き換えなし: ${covered.length}/${multiDoc.length}` +
        `\n  書き換えあり: ${coveredRw.length}/${multiDoc.length}`,
    );
    for (const m of multiDoc.filter((m) => !m.coveredRewritten)) {
      console.log(`  ${m.id} は片方の文書しか引けていない（＝完答できない）`);
    }
  }

  console.log(
    `\n断るべき質問: ${refusedCorrectly}/${refusable.length} 正しく拒否` +
      `\n  ※ ここは cosine 閾値だけの判定。実際のアプリは生成モデルによる根拠判定も通す。` +
      `\n     そちらの数字は npm run eval:refusal で測る。`,
  );

  if (regressions.length) {
    console.log("\nハイブリッド化で順位が下がった質問:");
    for (const r of regressions) console.log(r);
  } else {
    console.log("\nハイブリッド化で順位が下がった質問: なし");
  }

  if (rewriteRegressions.length) {
    console.log("\n書き換えで順位が下がった質問:");
    for (const r of rewriteRegressions) console.log(r);
  } else {
    console.log("書き換えで順位が下がった質問: なし");
  }
  console.log("============================================================");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
