import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { Card } from "@/components/ui";
import { LoginForm } from "./LoginForm";

export const metadata: Metadata = {
  title: "ログイン — Shiori",
};

const ERROR_MESSAGES: Record<string, string> = {
  "no-profile": "プロフィールが未設定です。管理者にお問い合わせください。",
  forbidden: "この画面は管理者のみ利用できます。",
  auth: "認証に失敗しました。もう一度ログインしてください。",
};

/** オープンリダイレクト防止。"//evil.com" や "/\evil.com" は外部に飛ぶので弾く */
function safeNext(value: string | string[] | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  if (!value.startsWith("/")) return undefined;
  if (value.startsWith("//") || value.startsWith("/\\")) return undefined;
  return value;
}

export default async function LoginPage(props: PageProps<"/login">) {
  const searchParams = await props.searchParams;
  const errorKey =
    typeof searchParams.error === "string" ? searchParams.error : undefined;
  const next = safeNext(searchParams.next);

  // no-profile はログイン済みだが profiles 行が無い状態。ここで /chat に戻すと
  // requireUser() が再び /login?error=no-profile に飛ばして無限ループになるため除外する。
  if (errorKey !== "no-profile") {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (user) redirect(next ?? "/chat");
  }

  const errorMessage = errorKey ? ERROR_MESSAGES[errorKey] : undefined;

  return (
    <div className="flex flex-1 items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center gap-3 text-center">
          <span
            aria-hidden
            className="flex size-11 items-center justify-center rounded-xl bg-brand-600 text-lg font-bold text-white"
          >
            S
          </span>
          <div>
            <h1 className="text-lg font-semibold tracking-tight text-ink-900">
              社内ナレッジ検索 Shiori
            </h1>
            <p className="mt-1 text-xs leading-relaxed text-ink-500">
              社内規程・マニュアルを出典付きで答えるAIアシスタントです。
              <br />
              会社から配布されたアカウントでログインしてください。
            </p>
          </div>
        </div>

        <Card className="p-5">
          {errorMessage && (
            <p
              role="alert"
              className="mb-4 rounded-lg bg-warn-50 px-3 py-2 text-xs text-warn-600"
            >
              {errorMessage}
            </p>
          )}
          <LoginForm next={next} />
        </Card>
      </div>
    </div>
  );
}
