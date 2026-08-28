"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Button, Input, Spinner } from "@/components/ui";

// NEXT_PUBLIC_* はビルド時に静的置換されるため、必ずフルパスで参照する。
const DEMO_EMAIL = process.env.NEXT_PUBLIC_DEMO_EMAIL;
const DEMO_PASSWORD = process.env.NEXT_PUBLIC_DEMO_PASSWORD;

/** Supabase の英語メッセージをそのまま出すと業務システムとして体裁が悪いので日本語に寄せる */
function toJapaneseMessage(raw: string): string {
  if (raw.includes("Invalid login credentials")) {
    return "メールアドレスまたはパスワードが違います。";
  }
  if (raw.includes("Email not confirmed")) {
    return "メールアドレスの確認が完了していません。管理者にお問い合わせください。";
  }
  if (raw.includes("Too many requests") || raw.includes("rate limit")) {
    return "試行回数が多すぎます。しばらく待ってからお試しください。";
  }
  if (raw.includes("Failed to fetch") || raw.includes("NetworkError")) {
    return "サーバーに接続できませんでした。通信環境を確認してください。";
  }
  return "ログインに失敗しました。しばらくしてからもう一度お試しください。";
}

export function LoginForm({ next }: { next?: string }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const showDemo = Boolean(DEMO_EMAIL && DEMO_PASSWORD);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);

    const supabase = createClient();
    const { error: signInError } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (signInError) {
      setError(toJapaneseMessage(signInError.message));
      setPending(false);
      return;
    }

    // 遷移完了までボタンを押せたままにしたくないので pending は戻さない。
    // refresh() は Server Component 側に新しいセッション cookie を読み直させるために必要。
    router.replace(next ?? "/chat");
    router.refresh();
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="space-y-1.5">
        <label
          htmlFor="email"
          className="block text-xs font-medium text-ink-600"
        >
          メールアドレス
        </label>
        <Input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.co.jp"
          disabled={pending}
        />
      </div>

      <div className="space-y-1.5">
        <label
          htmlFor="password"
          className="block text-xs font-medium text-ink-600"
        >
          パスワード
        </label>
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="••••••••"
          disabled={pending}
        />
      </div>

      {error && (
        <p
          role="alert"
          className="rounded-lg bg-danger-50 px-3 py-2 text-xs text-danger-600"
        >
          {error}
        </p>
      )}

      <Button type="submit" className="w-full" disabled={pending}>
        {pending && <Spinner className="border-white/40 border-t-white" />}
        {pending ? "ログイン中…" : "ログイン"}
      </Button>

      {showDemo && (
        <div className="rounded-lg border border-dashed border-brand-200 bg-brand-50 p-3">
          <p className="text-xs font-medium text-brand-700">デモアカウント</p>
          <p className="mt-1 text-xs text-ink-600">
            ポートフォリオ閲覧用のアカウントです。クリックすると入力欄に反映されます。
          </p>
          <button
            type="button"
            onClick={() => {
              setEmail(DEMO_EMAIL ?? "");
              setPassword(DEMO_PASSWORD ?? "");
              setError(null);
            }}
            disabled={pending}
            className="mt-2 w-full rounded-md bg-white px-3 py-2 text-left text-xs text-ink-700 ring-1 ring-brand-200 transition-colors hover:bg-brand-100 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {DEMO_EMAIL}
          </button>
        </div>
      )}
    </form>
  );
}
