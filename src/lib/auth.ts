import { redirect } from "next/navigation";
import { createClient } from "./supabase/server";
import type { Profile } from "./types";

export type SessionUser = {
  id: string;
  email: string | null;
  profile: Profile;
};

/**
 * ログイン必須ページ用。未ログインなら /login へ飛ばす。
 * proxy.ts でも弾いているが、Server Component 側でも必ず確認する
 * （proxy はルーティングの都合で素通りする経路がありうるため）。
 */
export async function requireUser(): Promise<SessionUser> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const { data: profile } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", user.id)
    .single<Profile>();

  if (!profile) redirect("/login?error=no-profile");

  return { id: user.id, email: user.email ?? null, profile };
}

/** 管理者必須ページ用 */
export async function requireAdmin(): Promise<SessionUser> {
  const session = await requireUser();
  if (session.profile.role !== "admin") redirect("/chat?error=forbidden");
  return session;
}
