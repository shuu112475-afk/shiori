/**
 * デプロイ後の疎通確認。デモ用アカウントの実際のJWTで本番に1問投げ、
 * 出典が citations テーブルに「保存される」ところまでを見る。
 *
 * 画面で見ても判定できない。出典はストリームで別途送っているので、
 * 保存が失敗していても質問直後の画面には出典が並ぶ。実際 0001〜0005 の間
 * citations はずっと0件だったが、手で触っている限り誰も気づかなかった
 * （原因と修正は 0006_citations_insert.sql）。
 *
 * 1回 $0.013 ほどかかり、デモの回数制限を1消費する。
 *   npm run smoke
 */
import { createClient } from "@supabase/supabase-js";

const SITE = process.env.SMOKE_URL ?? "https://shiori-rust.vercel.app";
const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

const admin = createClient(URL, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false },
});

const before = await admin
  .from("citations")
  .select("*", { count: "exact", head: true });
console.log(`投げる前の citations: ${before.count} 件`);

// デモ用アカウントのセッションを Admin API で発行する（パスワード不要）
const { data: link, error: linkErr } = await admin.auth.admin.generateLink({
  type: "magiclink",
  email: process.env.NEXT_PUBLIC_DEMO_EMAIL!,
});
if (linkErr) throw new Error(`リンク発行に失敗: ${linkErr.message}`);

const user = createClient(URL, ANON, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const { data: sess, error: vErr } = await user.auth.verifyOtp({
  token_hash: link.properties!.hashed_token!,
  type: "magiclink",
});
if (vErr) throw new Error(`セッション作成に失敗: ${vErr.message}`);

// @supabase/ssr が読む形のクッキーを組み立てる
const ref = URL.match(/https:\/\/([a-z0-9]+)\.supabase\.co/)![1];
const cookie = `sb-${ref}-auth-token=base64-${Buffer.from(
  JSON.stringify(sess.session),
).toString("base64url")}`;

const res = await fetch(`${SITE}/api/chat`, {
  method: "POST",
  headers: { "Content-Type": "application/json", cookie },
  body: JSON.stringify({ query: "有給の繰り越しは何日まで？" }),
});
console.log(`POST /api/chat → HTTP ${res.status}`);

const body = await res.text();
const sawCitationEvent = body.includes('"type":"citations"');
console.log(`ストリームに出典イベントが流れたか: ${sawCitationEvent}`);

// insert はレスポンス完了後なので少しだけ待つ
await new Promise((r) => setTimeout(r, 2000));

const after = await admin
  .from("citations")
  .select("*", { count: "exact", head: true });
console.log(`投げた後の citations: ${after.count} 件`);

const ok = (after.count ?? 0) > (before.count ?? 0);
console.log(ok ? "\n○ 出典がDBに保存された" : "\n× 出典が保存されていない");

const { data: limits } = await admin.from("rate_limits").select("count");
console.log(`rate_limits: ${JSON.stringify(limits)}`);

process.exit(ok ? 0 : 1);
