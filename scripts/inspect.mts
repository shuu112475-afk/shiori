/**
 * 1問だけ検索して、何が引けているかを目で見るためのツール。
 *
 *   npm run inspect -- "有休っていつまで持ち越せる？"
 *
 * 「答えが変」というときに、原因が検索（欲しいチャンクが入っていない）なのか
 * 生成（入っているのに使えていない）なのかを切り分けるために使う。
 * 生成はしないので費用は Embedding 1回分。
 *
 * service role で実行するので RLS は効かない＝全文書が対象。
 */
import { createClient } from "@supabase/supabase-js";
// 本番の retrieve() を呼ぶ。検索の手順をここに書き写すと、
// 切り分けに使う道具のほうが本番とずれる。
import { retrieve } from "../src/lib/rag.ts";
import { ANSWER_THRESHOLD } from "../src/lib/thresholds.ts";

const args = process.argv.slice(2);
const topArg = args.find((a) => a.startsWith("--top="));
const noRewrite = args.includes("--no-rewrite");
const matchCount = topArg ? Number(topArg.slice(6)) : 5;
const query = args
  .filter((a) => a !== topArg && a !== "--no-rewrite")
  .join(" ")
  .trim();
if (!query || !Number.isFinite(matchCount)) {
  console.error(
    '使い方: npm run inspect -- [--top=5] [--no-rewrite] "質問文"\n' +
      "  --no-rewrite: 書き換えを挟まず、質問そのままで1回だけ引く",
  );
  process.exit(1);
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error(
    "NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY が未設定です",
  );
  process.exit(1);
}

const db = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const result = await retrieve(db, query, {
  matchCount,
  rewrite: !noRewrite,
});

console.log(`質問: ${query}`);

if (result.kind === "faq") {
  console.log(
    `FAQ に一致（cosine ${result.similarity.toFixed(3)}）。検索も生成も通らず即答します。`,
  );
  console.log(`\n${result.answer}`);
  process.exit(0);
}

const { hits, topSimilarity: top, queries } = result;

if (queries.length > 1) {
  console.log(`検索文（1本目は元の質問）:`);
  for (const q of queries) console.log(`  - ${q}`);
}
console.log(
  `最良 cosine: ${top.toFixed(3)}（閾値 ${ANSWER_THRESHOLD} → ${result.kind === "insufficient" ? "生成せず拒否" : "生成へ進む"}）`,
);
if (!hits.some((h) => h.lexical_rank != null)) {
  console.log(
    "キーワード側のヒット: 0件（この質問はベクトル検索だけで順位が決まっている）",
  );
}
console.log("");

hits.forEach((h, i) => {
  console.log(
    `[${i + 1}] cos=${h.vector_similarity.toFixed(3)}  trgm=${h.lexical_similarity.toFixed(3)}  ` +
      `順位(ベクトル/キーワード)=${h.vector_rank ?? "-"}/${h.lexical_rank ?? "-"}  RRF=${h.score.toFixed(4)}`,
  );
  console.log(`    ${h.document_title} > ${h.heading_path ?? "(見出しなし)"}`);
  console.log(`    ${h.content.replace(/\s+/g, " ").slice(0, 160)}…`);
  console.log("");
});
