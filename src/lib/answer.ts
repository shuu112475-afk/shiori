/**
 * 回答生成と、その手前に置く「根拠があるか」の判定。
 *
 * このモジュールが rag.ts から分かれているのは thresholds.ts と同じ理由で、
 * `scripts/*.mts` を Node の型ストリッピングで直接実行して評価したいため。
 * 実行時の相対 import を持たない（型だけの import は消えるので可）。
 *
 * ---
 * なぜ cosine 類似度だけで「答えない」を判定できないのか
 *
 * デモ文書6本・30問で実測したところ、答えるべきでない質問の類似度は
 *   0.502 / 0.544 / 0.580
 * で、答えるべき質問の下位8問（0.419〜0.578）と完全に重なっていた。
 * どこに線を引いても、誤答を消すと正答も同じ数だけ消える。
 *
 * 原因は埋め込みが測っているものが「話題の近さ」であって
 * 「答えが書いてあるか」ではないこと。「職員駐車場の月額利用料」と
 * 旅費規程（交通費と金額の話）は、話題としては確かに近い。
 *
 * そこで判定を2段にした。
 *   1段目: cosine < ANSWER_THRESHOLD なら生成せず拒否（明らかな範囲外を無料で弾く）
 *   2段目: 生成モデル自身に「この資料で答えられるか」を先に1行で宣言させる
 * 2段目の拒否は出力10トークン程度で終わるので、費用は入力分だけ増える。
 */
import Anthropic from "@anthropic-ai/sdk";
import type { SearchHit } from "./types";

export const ANSWER_MODEL = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6";

/** 1行目に必ずどちらかを書かせる。判定結果を機械的に読み取るための目印 */
const VERDICT_OK = "ANSWERABLE";
const VERDICT_NG = "NO_EVIDENCE";

/** 1行目を読み切る前に打ち切る上限。これを超えたら形式違反とみなす */
const VERDICT_MAX_CHARS = 64;

export const SYSTEM_PROMPT = `あなたは社内文書に基づいて質問に答えるアシスタントです。

【出力形式】
1行目には、必ず次のどちらか1語だけを書くこと。
  ${VERDICT_OK}   … 【資料】の記載だけで【質問】に答えられる場合
  ${VERDICT_NG}  … 【資料】に答えが書かれていない場合
${VERDICT_NG} のときは、1行目以外には何も書かないこと。
${VERDICT_OK} のときは、2行目以降に回答本文を書くこと。

【${VERDICT_NG} と判定する基準】
1. 質問が求めている事実そのものが【資料】に書かれていないなら ${VERDICT_NG}。
2. 話題・分野が近いだけの記載しかない場合も ${VERDICT_NG}。
   例: 「制服のクリーニング代はいくらか」と聞かれ、資料にあるのが
   出張旅費の金額だけなら、同じ「費用」の話でも根拠にはならない。
3. 一部でも直接の根拠がある場合は ${VERDICT_OK} とし、
   書かれていない部分は回答本文で「資料には記載がありません」と明示する。

【回答本文の厳守事項】
1. 回答は、提示された【資料】に書かれている内容のみを根拠にすること。
2. 資料に書かれていないことは、一般的な知識で補わないこと。推測もしないこと。
3. 各文には、根拠にした資料の番号を [1] の形式で文末に必ず付けること。複数の資料を根拠にした場合は [1][3] のように並べること。
4. 資料の条番号・章番号（例: 第22条）が分かる場合は、回答本文にも明記すること。
5. 日本語で、結論から先に、簡潔に答えること。箇条書きを適切に使うこと。
6. 資料の記載に例外・但し書きがある場合は、必ずそれも書くこと。`;

function formatSource(hit: SearchHit, index: number): string {
  const where = [hit.document_title, hit.heading_path]
    .filter(Boolean)
    .join(" > ");
  const page = hit.page_no ? `（p.${hit.page_no}）` : "";
  return `[${index + 1}] 出典: ${where}${page}\n${hit.content}`;
}

export function buildUserPrompt(query: string, hits: SearchHit[]): string {
  const sources = hits.map(formatSource).join("\n\n---\n\n");
  return `【資料】\n${sources}\n\n【質問】\n${query}`;
}

let _anthropic: Anthropic | null = null;
function anthropic(): Anthropic {
  if (!_anthropic) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
    _anthropic = new Anthropic({ apiKey });
  }
  return _anthropic;
}

export type AnswerUsage = {
  inputTokens: number;
  outputTokens: number;
};

/**
 * 最初に必ず grounded / refused のどちらかが1回流れ、
 * grounded のときだけ続けて text が流れる。
 */
export type AnswerChunk =
  { type: "grounded" } | { type: "refused" } | { type: "text"; text: string };

/**
 * 1行目の判定語を読み取る。
 *
 * どちらの語も見つからないときは grounded として扱う（本文を捨てない）。
 * モデルが目印を忘れたということは、そのまま回答本文を書き始めたということで、
 * 「答えられる」と判断した結果とみなすのが自然なため。
 * その場合はバッファをそのまま本文として流す。
 */
function readVerdict(buffer: string): {
  verdict: "grounded" | "refused";
  rest: string;
  malformed: boolean;
} {
  const nl = buffer.indexOf("\n");
  const head = (nl === -1 ? buffer : buffer.slice(0, nl)).trim();
  const rest = nl === -1 ? "" : buffer.slice(nl + 1);

  if (head.includes(VERDICT_NG)) {
    return { verdict: "refused", rest: "", malformed: false };
  }
  if (head.includes(VERDICT_OK)) {
    return { verdict: "grounded", rest, malformed: false };
  }
  return { verdict: "grounded", rest: buffer, malformed: true };
}

/**
 * Claude の回答をストリーミングで流す。
 * 完了後に usage を戻り値で受け取り、コスト記録に使う。
 */
export async function* streamAnswer(
  query: string,
  hits: SearchHit[],
): AsyncGenerator<AnswerChunk, AnswerUsage, void> {
  const stream = anthropic().messages.stream({
    model: ANSWER_MODEL,
    max_tokens: 1500,
    temperature: 0,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: buildUserPrompt(query, hits) }],
  });

  // 1行目を読み切るまでは本文を出せないので、その間だけ溜める
  let buffer = "";
  let decided: "grounded" | "refused" | null = null;

  for await (const event of stream) {
    if (
      event.type !== "content_block_delta" ||
      event.delta.type !== "text_delta"
    ) {
      continue;
    }
    const text = event.delta.text;

    if (decided === null) {
      buffer += text;
      if (buffer.indexOf("\n") === -1 && buffer.length < VERDICT_MAX_CHARS) {
        continue;
      }
      const { verdict, rest, malformed } = readVerdict(buffer);
      if (malformed) {
        console.warn(
          "[answer] 判定語が見つかりません:",
          JSON.stringify(buffer),
        );
      }
      decided = verdict;
      yield { type: verdict };
      if (verdict === "refused") continue;
      if (rest) yield { type: "text", text: rest };
      continue;
    }

    if (decided === "grounded") yield { type: "text", text };
  }

  // 判定語だけで改行なしに終わった場合（NO_EVIDENCE 単独など）はここで拾う
  if (decided === null) {
    const { verdict, rest, malformed } = readVerdict(buffer);
    if (malformed && buffer) {
      console.warn("[answer] 判定語が見つかりません:", JSON.stringify(buffer));
    }
    yield { type: verdict };
    if (verdict === "grounded" && rest) yield { type: "text", text: rest };
  }

  const final = await stream.finalMessage();
  return {
    inputTokens: final.usage.input_tokens,
    outputTokens: final.usage.output_tokens,
  };
}
