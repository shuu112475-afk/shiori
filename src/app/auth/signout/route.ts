import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * ログアウト。GET を生やすとリンクのプリフェッチや画像プロキシで
 * 意図せずセッションが飛ぶので POST のみにする。
 */
export async function POST(request: Request) {
  const supabase = await createClient();
  await supabase.auth.signOut();

  // 303 にしないとブラウザが /login に対しても POST を再送してしまう
  return NextResponse.redirect(new URL("/login", request.url), { status: 303 });
}
