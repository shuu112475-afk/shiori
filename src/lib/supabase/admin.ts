import { createClient } from "@supabase/supabase-js";

/**
 * service role キーを使う管理用クライアント。RLS をバイパスする。
 *
 * 使ってよい場所は以下の4つだけ。それ以外は必ず RLS が効くクライアントを使う:
 *   1. 取り込みワーカー（チャンク投入・ステータス更新）
 *   2. 監査ログの書き込み（利用者本人には書かせない）
 *   3. 未回答キューへの記録（unanswered は管理者しか触れないポリシーのため）
 *   4. auth.users の参照（メールアドレスは RLS 越しには読めない）
 *
 * 管理画面の一覧・集計は service role ではなく、
 * *_admin_read ポリシーを通してログインユーザーの権限で読む。
 * こうしておくと「service role が漏れたら何ができてしまうか」を短く説明できる。
 *
 * いずれもサーバー側でのみ呼ぶこと。クライアントに漏らさない。
 */
export function createAdminClient() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set");

  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
