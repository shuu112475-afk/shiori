/**
 * 「答えられないときに、答えない」が本当に機能しているかの評価。
 *
 *   npm run eval:refusal
 *
 * evaluate.mts は検索の当たり外れだけを見るので生成しない（＝ほぼ無料）。
 * こちらは生成モデルによる根拠判定まで通すので、30問ぶんの入力トークンが
 * かかる（Sonnet で $0.3 前後）。頻繁には回さない前提。
 *
 * 見るのは次の2つだけ。
 *   誤答  … 答えるべきでない質問（カテゴリD）に答えてしまった数。0であること
 *   誤拒否 … 答えるべき質問（A/B/C）を拒否してしまった数。少ないほどよい
 *
 * service role で実行するので RLS は効かない＝全文書が検索対象になる。
 */
import { readFileSync } from "node:fs";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
// 本番の retrieve() をそのまま呼ぶ。ここで検索を書き写すと、
// 本番だけを直したときに評価が古い経路を測り続ける。
import { retrieve } from "../src/lib/rag.ts";
import { ANSWER_THRESHOLD } from "../src/lib/thresholds.ts";
import { streamAnswer } from "../src/lib/answer.ts";

type Question = {
  id: string;
  category: "A" | "B" | "C" | "D";
  question: string;
  expected_answer_contains?: string[];
  should_answer: boolean;
};

type Outcome = {
  q: Question;
  topSimilarity: number;
  answered: boolean;
  /** 生成まで行かずに閾値で止まったか */
  stoppedByThreshold: boolean;
  answer: string;
  contains: string[];
  missing: string[];
  /** 実際に検索へ投げた文。FAQ で即答したときは空 */
  queries: string[];
};

async function judge(supabase: SupabaseClient, q: Question): Promise<Outcome> {
  const result = await retrieve(supabase, q.question);

  // FAQ の上書きに当たった質問は検索も生成も通らない。
  // 登録済みの答えをそのまま返すので「回答した」として数える。
  if (result.kind === "faq") {
    const expected = q.expected_answer_contains ?? [];
    return {
      q,
      topSimilarity: result.similarity,
      answered: true,
      stoppedByThreshold: false,
      answer: result.answer,
      contains: expected.filter((s) => result.answer.includes(s)),
      missing: expected.filter((s) => !result.answer.includes(s)),
      queries: [],
    };
  }

  const { hits, topSimilarity, queries } = result;
  const base = { q, topSimilarity, contains: [], missing: [], queries };

  // 1段目: 明らかな範囲外を、生成する前に無料で弾く（retrieve が判定済み）
  if (result.kind === "insufficient") {
    return {
      ...base,
      answered: false,
      stoppedByThreshold: true,
      answer: "",
    };
  }

  // 2段目: 生成モデル自身に「この資料で答えられるか」を先に宣言させる
  let answered = true;
  let answer = "";
  const generator = streamAnswer(q.question, hits);
  let next = await generator.next();
  while (!next.done) {
    const chunk = next.value;
    if (chunk.type === "refused") answered = false;
    else if (chunk.type === "text") answer += chunk.text;
    next = await generator.next();
  }

  const expected = q.expected_answer_contains ?? [];
  const contains = expected.filter((s) => answer.includes(s));
  const missing = expected.filter((s) => !answer.includes(s));

  return {
    ...base,
    answered,
    stoppedByThreshold: false,
    answer,
    contains,
    missing,
  };
}

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY が未設定です。--env-file=.env.local を付けて実行してください",
    );
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY が未設定です");
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

  console.log(
    `根拠判定の評価: ${questions.length}問（cosine下限 ${ANSWER_THRESHOLD} ＋ モデルによる根拠判定）\n`,
  );

  const outcomes: Outcome[] = [];
  for (const q of questions) {
    const o = await judge(supabase, q);
    outcomes.push(o);

    const ok = o.answered === q.should_answer;
    const what = o.answered
      ? "回答"
      : o.stoppedByThreshold
        ? "拒否(閾値)"
        : "拒否(根拠なし)";
    console.log(
      `${ok ? "○" : "×"} ${q.id} ${what.padEnd(14)} sim=${o.topSimilarity.toFixed(3)}  ${q.question}`,
    );
    if (!ok && q.should_answer) {
      console.log("     ← 答えられるはずの質問を拒否した");
      // 拒否の原因が検索なのか生成側の根拠判定なのかを切り分けたいので、
      // どの文で引いたのかを残す
      console.log(`     投げた検索文: ${o.queries.join(" ／ ")}`);
    }
    if (!ok && !q.should_answer) {
      console.log(`     ← 根拠がないのに答えた: ${o.answer.slice(0, 80)}…`);
    }
    if (ok && q.should_answer && o.missing.length) {
      console.log(
        `     △ 回答に含まれてほしい語が不足: ${o.missing.join(" / ")}`,
      );
    }
  }

  const shouldAnswer = outcomes.filter((o) => o.q.should_answer);
  const shouldRefuse = outcomes.filter((o) => !o.q.should_answer);
  const falseAnswers = shouldRefuse.filter((o) => o.answered);
  const falseRefusals = shouldAnswer.filter((o) => !o.answered);
  const withExpected = shouldAnswer.filter(
    (o) => o.answered && (o.q.expected_answer_contains?.length ?? 0) > 0,
  );
  const fullyCovered = withExpected.filter((o) => o.missing.length === 0);

  console.log("\n============================================================");
  console.log(
    `誤答（答えるべきでないのに答えた）: ${falseAnswers.length}/${shouldRefuse.length}`,
  );
  console.log(
    `誤拒否（答えるべきなのに拒否した）: ${falseRefusals.length}/${shouldAnswer.length}`,
  );
  console.log(
    `期待する語をすべて含む回答: ${fullyCovered.length}/${withExpected.length}`,
  );
  for (const o of falseRefusals) {
    console.log(
      `  誤拒否: ${o.q.id} sim=${o.topSimilarity.toFixed(3)} ${o.q.question}`,
    );
  }
  for (const o of falseAnswers) {
    console.log(
      `  誤答:  ${o.q.id} sim=${o.topSimilarity.toFixed(3)} ${o.q.question}`,
    );
  }
  console.log("============================================================");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
