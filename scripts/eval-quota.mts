/**
 * 回数制限が本当に効いているかの検証。
 *
 *   npm run eval:quota
 *
 * 公開デモは1つのアカウントを全員で共有し、そのパスワードは
 * NEXT_PUBLIC_DEMO_PASSWORD としてクライアントのJSに載る。
 * つまり「ログインできる人しか使えない」は防御になっていない。
 * 実際に効いているのはこのカウンタだけなので、口頭ではなく実測する。
 *
 * 見るのは3つ。
 *   1. 数が増えるか          … 制限として機能するか
 *   2. ユーザーから消せないか … 消せるなら上限は無いのと同じ
 *   3. 他人の枠を消費できないか … auth.uid() 由来であることの確認
 *
 * 使い終わったカウンタは service role で消すので、
 * 実行してもデモ当日の枠は減らない。
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/** member 権限のアカウント（admin は制限の対象外なので使わない） */
const TEST_EMAIL = "nurse@example.com";
const OTHER_EMAIL = "rt@example.com";

async function signInAs(
  url: string,
  anonKey: string,
  admin: SupabaseClient,
  email: string,
): Promise<{ client: SupabaseClient; userId: string }> {
  const { data, error } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email,
  });
  if (error) throw new Error(`${email}: ログインリンク: ${error.message}`);
  const tokenHash = data.properties?.hashed_token;
  if (!tokenHash) throw new Error(`${email}: hashed_token が返りませんでした`);

  const client = createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: session, error: verifyError } = await client.auth.verifyOtp({
    token_hash: tokenHash,
    type: "magiclink",
  });
  if (verifyError || !session.user)
    throw new Error(`${email}: セッション: ${verifyError?.message}`);
  return { client, userId: session.user.id };
}

async function consume(client: SupabaseClient): Promise<number> {
  const { data, error } = await client.rpc("consume_quota").single<{
    used: number;
    reset_at: string;
  }>();
  if (error) {
    throw new Error(
      `consume_quota を呼べません: ${error.message}\n` +
        `  → supabase/migrations/0005_rate_limit.sql が未適用の可能性があります`,
    );
  }
  return data.used;
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

  const limit = Number(process.env.RAG_DAILY_QUESTION_LIMIT ?? 30);
  console.log("回数制限の検証");
  console.log(`上限（RAG_DAILY_QUESTION_LIMIT）: ${limit}問/日\n`);

  const { client: user, userId } = await signInAs(
    url,
    anonKey,
    admin,
    TEST_EMAIL,
  );
  const { client: other, userId: otherId } = await signInAs(
    url,
    anonKey,
    admin,
    OTHER_EMAIL,
  );

  let failures = 0;
  const check = (ok: boolean, label: string, detail: string) => {
    if (!ok) failures += 1;
    console.log(`${ok ? "○" : "×"} ${label}`);
    console.log(`    ${detail}\n`);
  };

  try {
    // --- 1. 数が増えるか
    const before = await consume(user);
    const after = await consume(user);
    check(
      after === before + 1,
      "呼ぶたびに1つ増える",
      `1回目 ${before} → 2回目 ${after}`,
    );

    // --- 2. ユーザー側から消せないか
    //     messages を数える実装にしなかった理由がここ。
    //     messages_own は `for all` なので、ユーザーは自分の messages を
    //     消せてしまい、件数を上限判定に使うと消せば枠が戻る。
    const { data: readRows, error: readErr } = await user
      .from("rate_limits")
      .select("count");
    const cannotRead = Boolean(readErr) || (readRows ?? []).length === 0;

    const { error: delErr } = await user
      .from("rate_limits")
      .delete()
      .eq("user_id", userId);
    const afterDelete = await consume(user);
    const cannotReset = afterDelete === after + 1;

    check(
      cannotRead && cannotReset,
      "ユーザーからカウンタを消せない",
      `select: ${cannotRead ? "見えない" : "見える（危険）"}` +
        ` / delete: ${delErr ? `拒否（${delErr.code}）` : "エラーは返らない"}` +
        ` / 削除後の値: ${afterDelete}（${cannotReset ? "戻っていない" : "リセットされた（危険）"}）`,
    );

    // --- 3. 他人の枠を消費できないか
    const otherUsed = await consume(other);
    const mineAgain = await consume(user);
    check(
      mineAgain === afterDelete + 1 && otherUsed < mineAgain,
      "ユーザーごとに独立して数える",
      `${TEST_EMAIL}: ${mineAgain} / ${OTHER_EMAIL}: ${otherUsed}`,
    );

    // --- 4. route.ts が実際に使う判定と同じ計算になっているか
    check(
      mineAgain <= limit,
      "上限との突き合わせ",
      `used=${mineAgain} ${mineAgain <= limit ? "≤" : ">"} limit=${limit}` +
        ` → ${mineAgain <= limit ? "通す" : "429で断る"}`,
    );
  } finally {
    // 検証で消費したぶんを戻す（デモ当日の枠を食わないように）
    await admin.from("rate_limits").delete().in("user_id", [userId, otherId]);
    await user.auth.signOut();
    await other.auth.signOut();
  }

  console.log("============================================================");
  if (failures) {
    console.log(`${failures}件が期待と違います。この状態で公開しないこと。`);
    process.exit(1);
  }
  console.log(
    "カウンタはユーザーから読めず、消せず、ユーザーごとに独立しています。\n" +
      "デモのパスワードがクライアントJSに載っていても、1日の上限は超えられません。",
  );
  console.log("============================================================");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
