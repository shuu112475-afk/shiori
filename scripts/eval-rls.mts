/**
 * 部署フィルタ（RLS）が本当に効いているかの検証。
 *
 *   npm run eval:rls
 *
 * ほかの評価スクリプトはすべて service role で動くので RLS を素通りします。
 * つまり `eval` も `eval:refusal` も、この作品の売りの1つである
 * 「誰が何を見られるかがDBで担保されている」を一度も測っていません。
 * その穴を埋めるためのスクリプトです。
 *
 * ---
 * なぜ画面から目視するのではなく、スクリプトにしたか
 *
 * 保証の実体は Postgres の RLS であって、画面の条件分岐ではありません。
 * ブラウザで1回見て「大丈夫でした」と言っても、
 *   ・次に検索周りを直したとき、同じことをもう一度やる保証がない
 *   ・落ちたときに、画面の問題かDBの問題かが切り分けられない
 * ので、境界そのものを直接突く形にしています。
 *
 * ---
 * パスワードを持たずにユーザーとして接続する方法
 *
 * デモアカウントのパスワードはリポジトリに置きたくないので、
 * service role の Admin API でログインリンクを発行し、
 * その token を anon クライアントで verify してセッションを作ります。
 * こうして得られる JWT は画面からログインしたときと同じもので、
 * RLS も同じように効きます。
 *
 * 費用は Embedding と書き換えでユーザーごとに数円未満です。
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { retrieve } from "../src/lib/rag.ts";
import { streamAnswer } from "../src/lib/answer.ts";

/** 部署限定にしてある文書。ここが出入りするかどうかを見る */
const RESTRICTED_DOC = "06_放射線部門業務マニュアル";

/**
 * A-14。この質問の答えは 06 にしか書かれていない。
 * 放射線科は答えられて、看護部は「見つかりません」になるのが正しい。
 */
const QUESTION =
  "造影剤の副作用が発生した場合、報告書はいつまでにどこへ提出しますか？";

type Expectation = {
  email: string;
  label: string;
  /** 部署限定文書が見えるべきか */
  canSeeRestricted: boolean;
  why: string;
};

const EXPECTATIONS: Expectation[] = [
  {
    email: "rt@example.com",
    label: "放射線科スタッフ",
    canSeeRestricted: true,
    why: "所属が許可部署に入っている",
  },
  {
    email: "nurse@example.com",
    label: "看護部スタッフ",
    canSeeRestricted: false,
    why: "所属が許可部署に入っていない",
  },
  {
    email: "admin@example.com",
    label: "管理者",
    canSeeRestricted: true,
    why: "is_admin() で部署の条件を外れる",
  },
];

/**
 * そのユーザーとして接続したクライアントを作る。
 * パスワードは使わない（上のコメント参照）。
 */
async function signInAs(
  url: string,
  anonKey: string,
  admin: SupabaseClient,
  email: string,
): Promise<SupabaseClient> {
  const { data, error } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email,
  });
  if (error)
    throw new Error(
      `${email}: ログインリンクを発行できません: ${error.message}`,
    );

  const tokenHash = data.properties?.hashed_token;
  if (!tokenHash) throw new Error(`${email}: hashed_token が返りませんでした`);

  const user = createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { error: verifyError } = await user.auth.verifyOtp({
    token_hash: tokenHash,
    type: "magiclink",
  });
  if (error || verifyError) {
    throw new Error(
      `${email}: セッションを作れません: ${verifyError?.message}`,
    );
  }
  return user;
}

function titlesOf(rows: { document_title: string }[]): string[] {
  return [...new Set(rows.map((r) => r.document_title))].sort();
}

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !anonKey || !serviceKey) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY が未設定です",
    );
  }

  const admin = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  console.log(`部署フィルタ（RLS）の検証`);
  console.log(`部署限定文書: ${RESTRICTED_DOC}`);
  console.log(`質問: ${QUESTION}\n`);

  let failures = 0;

  for (const exp of EXPECTATIONS) {
    const user = await signInAs(url, anonKey, admin, exp.email);

    // 1. テーブルの時点で見えているか。
    //    アプリを一切通さないので、保証がDBにあることをそのまま示せる。
    const { data: docs, error: docErr } = await user
      .from("documents")
      .select("title");
    if (docErr) throw new Error(`${exp.email}: documents: ${docErr.message}`);
    const visibleDocs = (docs ?? []).map((d) => d.title).sort();
    const seesRestrictedInTable = visibleDocs.includes(RESTRICTED_DOC);

    // 2. 本番の検索を通したとき、出典に混ざらないか
    const result = await retrieve(user, QUESTION);
    const citedTitles = result.kind === "faq" ? [] : titlesOf(result.hits);
    const seesRestrictedInSearch = citedTitles.includes(RESTRICTED_DOC);

    // 3. 最終的に答えるか断るか。
    //    ここは検索（retrieve）だけでは決まらない。閾値を超えても、
    //    生成モデルが「渡された資料では答えられない」と言えば拒否になる。
    //    最初この判定を result.kind だけで書いてしまい、看護部は
    //    「他の文書が閾値を超えているので回答する」と出て失敗した。
    //    落ちていたのは RLS ではなく、こちらの測り方だった。
    let answered = false;
    if (result.kind === "faq") {
      answered = true;
    } else if (result.kind === "hits") {
      answered = true;
      const generator = streamAnswer(QUESTION, result.hits);
      let next = await generator.next();
      while (!next.done) {
        if (next.value.type === "refused") answered = false;
        next = await generator.next();
      }
    }

    // 機密の境界（必ず守られていなければならない）と、
    // 回答の出し分け（デモの見せ場）を分けて数える。
    const boundaryOk =
      seesRestrictedInTable === exp.canSeeRestricted &&
      seesRestrictedInSearch === exp.canSeeRestricted;
    const ok = boundaryOk && answered === exp.canSeeRestricted;
    if (!ok) failures += 1;

    console.log(`${ok ? "○" : "×"} ${exp.label}（${exp.email}）— ${exp.why}`);
    console.log(
      `    見える文書 ${visibleDocs.length}件: ${visibleDocs.join(", ")}`,
    );
    console.log(
      `    検索の出典: ${citedTitles.length ? citedTitles.join(", ") : "(なし)"}`,
    );
    console.log(
      `    ${RESTRICTED_DOC} … テーブル:${seesRestrictedInTable ? "見える" : "見えない"}` +
        ` / 検索結果:${seesRestrictedInSearch ? "混ざる" : "混ざらない"}` +
        ` / 回答:${answered ? "する" : "拒否"}`,
    );
    if (!boundaryOk) {
      console.log(
        `    ← 【重大】機密の境界が壊れています。期待は「${exp.canSeeRestricted ? "見える" : "見えない"}」でした`,
      );
    } else if (!ok) {
      console.log(
        `    ← 境界は守られていますが、回答の出し分けが期待と違います` +
          `（期待: ${exp.canSeeRestricted ? "回答" : "拒否"}）`,
      );
    }
    console.log("");

    await user.auth.signOut();
  }

  console.log("============================================================");
  if (failures) {
    console.log(`${failures}件が期待と違います。RLS が効いていません。`);
    process.exit(1);
  }
  console.log(
    "全員が期待どおりでした。\n" +
      "部署限定文書は、画面の条件分岐ではなく hybrid_search() が security invoker\n" +
      "であることによって、検索結果に入る前の段階で落ちています。",
  );
  console.log("============================================================");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
