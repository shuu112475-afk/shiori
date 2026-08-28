/**
 * 検索に投げる前に、質問を「文書側の言葉」へ直し、必要なら複数に分ける。
 *
 * thresholds.ts / answer.ts と同じ理由で rag.ts から分けている
 * （評価スクリプトから直接読むため、実行時の相対 import を持たない）。
 *
 * ---
 * なぜ必要か
 *
 * 30問の評価で最後まで残った誤拒否2問は、どちらも検索の取りこぼしだった。
 * そして2問とも、原因は「ユーザーの文言そのままで1回だけ引いている」ことだった。
 *
 * B-01「有休っていつまで持ち越せる？」
 *   正解（就業規則 第22条 年次有給休暇）が上位8件に1件も入らない。
 *   上位は cosine 0.407〜0.461 の団子で、13文字の口語だと埋め込みが
 *   「休暇一般」としか捉えられていない。
 *   同じ内容を正式名称で聞く A-01「有給休暇の繰り越しは何日まで」は
 *   cosine 0.661 で1位を当てている。答えも文書も同じで、違うのは言い回しだけ。
 *
 *   キーワード検索で拾えないかとも考えたが、これも無理だった。
 *   pg_trgm が見るのは文字面の重なりで、質問は「有休・持ち越せる」、
 *   規程は「年次有給休暇・繰り越し」。共通するトライグラムが無い（0004参照）。
 *
 * C-04「3歳の子どもを育てている職員は、1日の勤務時間が通常より何時間短くなるか」
 *   上位8件すべてが育児介護休業規程。短縮後の6時間は取れるが、
 *   差を出すのに必要な「通常＝8時間」（就業規則 第12条）が入らない。
 *   1問に対して照会が2つ必要なのに、検索を1回しか投げていなかった。
 *
 * つまり片方は語彙の問題、もう片方は問い合わせ回数の問題で、
 * どちらも検索の手前で質問を整えれば解ける。閾値では解けない。
 *
 * ---
 * 費用と遅延
 *
 * Haiku を1回呼ぶ。出力は数十トークンなので1問あたり $0.001 未満、
 * 体感 0.3 秒ほど増える。FAQ に当たった質問では呼ばない（rag.ts 側で分岐）。
 * 失敗したときは元の質問をそのまま使う。壊れても以前の挙動に戻るだけにしてある。
 */
import Anthropic from "@anthropic-ai/sdk";

/** 書き換えは判断の難しい作業ではないので、安い模型で十分 */
export const REWRITE_MODEL =
  process.env.ANTHROPIC_REWRITE_MODEL ?? "claude-haiku-4-5-20251001";

/** 分解しすぎると1件あたりの枠が減るので上限を設ける */
export const MAX_QUERIES = 3;

/**
 * 検索文として受け付ける最大文字数。
 *
 * プロンプトで禁止しても、Haiku は文書に無さそうな質問に対して
 * 「お答えできません。この質問は規程ではなく契約書に…」といった
 * 断り文を返してくることがある（C-02 と D-03 で実際に発生した）。
 * それがそのまま検索文として埋め込まれ、意味のない照会が1回増えていた。
 *
 * 指示を足すだけでは再発を防げないので、形の側でも弾く。
 * 検索文は助詞を落とした語の並びなので短い。
 * 30問で実際に出た最長は「産前産後休業 育児休業 復帰 年次有給休暇」の20字、
 * 断り文は100字超だった。40字ならこの差の間に十分収まる。
 */
export const MAX_QUERY_CHARS = 40;

export const REWRITE_SYSTEM_PROMPT = `あなたは社内文書検索の前処理を行います。
利用者の質問を、社内規程で実際に使われている言葉に直した「検索文」にしてください。

【前提】
利用者の質問そのものは、あなたの出力とは別に、そのまま検索にかけられます。
だからあなたの仕事は「質問だけでは引けないものを拾う」ことです。
質問を言い換えただけの行には価値がありません。

【出力形式】
検索文だけを1行に1件、改行区切りで出力する。
番号・記号・説明・前置きは一切書かない。
出力は最大${MAX_QUERIES}行。
原則は1行。2行目以降を書くのは、下の4か5に当てはまるときだけ。

【作り方】
1. 口語・略語は、規程で使われる正式な言葉に直す。
   例: 有休 → 年次有給休暇 / 産休 → 産前産後休業 / ボーナス → 賞与
   例: 持ち越す → 繰り越し / 辞める → 退職
2. 質問がすでに正式な言葉で書かれているなら、そのまま1行で出力してよい。
3. 助詞や語尾は落とし、内容語を並べた短い形にする。
4. 行を分けてよいのは、2行目が1行目とは「別の規程」を指しているときだけ。
   1行目と2行目が同じ規程の同じ条文に行き着くなら、分けてはいけない。
   例:「Aのほかに B も必要か」は、A と B で2行に分ける。
5. 「基準と比べてどれだけ違うか」を聞かれたときは、
   片方の行を必ず「基準そのもの」を調べる検索文にする。
   基準は原則を定めた別の規程に書かれていることが多く、
   質問に出てくる言葉だけで引くと、差分の側しか集まらないため。
   例:「宿直明けは通常より何時間早く退勤できるか」なら
     1行目「宿直勤務 退勤時刻」、2行目「所定労働時間 始業時刻 終業時刻」。
   このとき2行目に、質問の状況を表す言葉（宿直・育児など）を混ぜないこと。
   混ぜると基準ではなく例外の規定が引かれてしまう。
6. 同じ規程の中で語を言い換えただけの行を2つ作らないこと。
   分けた意味がなく、1件あたりの枠を減らすだけになる。
   悪い例:「制服 クリーニング代」と「制服 洗濯費用」
   悪い例:「時間外手当 割増率」と「残業代 割増率」
   どちらも同じ条文に行き着くので、1行にまとめる。
7. 単純な質問を無理に分けないこと。1行で足りるなら1行にする。
   分けるべきか迷ったら、分けない。

【禁止】
- 質問に答えないこと。答えや数値を検索文に含めないこと。
- 質問に無い話題を足さないこと。
- 断らないこと。「お答えできません」「確認が必要です」などの文を書かないこと。
  社内文書に該当する記載が無さそうに見える質問でも、必ず検索文を出す。
  記載が有るか無いかを決めるのは検索と後段の処理であって、あなたではない。
- 文を書かないこと。出力は語を並べたものにする。句点（。）で終わる行は不正。`;

let _anthropic: Anthropic | null = null;
function anthropic(): Anthropic {
  if (!_anthropic) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
    _anthropic = new Anthropic({ apiKey });
  }
  return _anthropic;
}

/**
 * モデルの出力から検索文の配列を取り出す。
 *
 * 番号付きや箇条書きで返ってくることがあるので先頭の記号を落とす。
 * 検索文の形をしていない行（長すぎる・文になっている）は捨てる。
 * 1件も残らなければ空配列を返し、呼び出し側で元の質問に倒す。
 */
export function parseQueries(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of raw.split("\n")) {
    const cleaned = line
      .trim()
      .replace(/^[-*・]\s*/, "")
      .replace(/^\d+[.)、]\s*/, "")
      .trim();
    if (!cleaned) continue;
    // 断り文・説明文をここで落とす（MAX_QUERY_CHARS の説明を参照）
    if (cleaned.length > MAX_QUERY_CHARS) continue;
    if (/[。！？!?]$/.test(cleaned)) continue;
    if (seen.has(cleaned)) continue;
    seen.add(cleaned);
    out.push(cleaned);
    if (out.length >= MAX_QUERIES) break;
  }
  return out;
}

/**
 * 元の質問を必ず1本目に据えた検索文の並びを作る。
 *
 * 書き換えを「置き換え」にしていたときは、元の言い回しで1位を取れていた
 * 質問が落ちた。A-06「出張の旅費精算はいつまでに出せばいいか」は
 * 書き換え前なら1位、書き換え後「旅費精算 提出期限」では2位。
 * 全体でも Hit@1 88.9% → 85.2% と下がっている。
 *
 * 書き換えの目的は取りこぼしを拾うことなので、元の検索結果を捨てる理由はない。
 * 元の質問を1本目に残せば、後段の RRF で元の1位は最上位の順位点を持ったまま
 * 統合され、書き換えは「足す」だけになる。
 *
 * 検索文の総数は MAX_QUERIES で頭打ちにする（元の質問を含めて数える）。
 * 増やすほど1件あたりの枠が減り、資料が薄まるため。
 */
export function withOriginal(original: string, rewritten: string[]): string[] {
  const out = [original];
  for (const q of rewritten) {
    if (out.length >= MAX_QUERIES) break;
    if (out.includes(q)) continue;
    out.push(q);
  }
  return out;
}

export type RewriteResult = {
  /** 実際に検索へ投げる文。必ず1件以上入る */
  queries: string[];
  /** 書き換えに失敗して元の質問に倒したか */
  fellBack: boolean;
};

/**
 * 質問を検索文に直す。
 * 例外は投げない。失敗しても元の質問で検索を続けられるようにする。
 */
export async function rewriteQuery(query: string): Promise<RewriteResult> {
  try {
    const res = await anthropic().messages.create({
      model: REWRITE_MODEL,
      max_tokens: 200,
      temperature: 0,
      system: REWRITE_SYSTEM_PROMPT,
      messages: [{ role: "user", content: query }],
    });
    const text = res.content
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("");
    const queries = parseQueries(text);
    if (!queries.length) {
      console.warn("[rewrite] 検索文が取れませんでした:", JSON.stringify(text));
      return { queries: [query], fellBack: true };
    }
    return { queries, fellBack: false };
  } catch (e) {
    console.warn("[rewrite] 書き換えに失敗したので元の質問で検索します:", e);
    return { queries: [query], fellBack: true };
  }
}
