import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

/**
 * ルートは実体を持たない振り分け専用。
 * proxy.ts は "/" を公開扱いにしているので、ここでログイン状態を見て行き先を決める。
 */
export default async function Home() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  redirect(user ? "/chat" : "/login");
}
