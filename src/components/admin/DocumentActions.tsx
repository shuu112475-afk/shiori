"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui";
import { deleteDocument } from "@/app/admin/documents/actions";

/**
 * 再取り込みは Server Action ではなく /api/documents/ingest を叩く。
 * アップロード直後の取り込みと同じ経路にしておくと、
 * 権限チェックと監査ログの記録が1か所で済む。
 */
export function DocumentActions({
  documentId,
  title,
}: {
  documentId: string;
  title: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState<"reingest" | "delete" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function reingest() {
    setBusy("reingest");
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/documents/ingest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ documentId }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        setError(
          body?.error ?? `再取り込みに失敗しました（HTTP ${res.status}）`,
        );
      } else {
        setNotice("再取り込みが完了しました");
      }
    } catch (e) {
      setError(
        `再取り込みを呼び出せませんでした: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    } finally {
      setBusy(null);
      router.refresh();
    }
  }

  function remove() {
    // 削除するとチャンクも一緒に消え、チャットの根拠から即座に外れる。
    // 取り返しがつかないのでタイトルを見せて確認する。
    if (
      !window.confirm(
        `「${title}」を削除します。\nチャンクと元ファイルも削除され、以後の回答の根拠から外れます。よろしいですか？`,
      )
    ) {
      return;
    }

    setError(null);
    setNotice(null);
    setBusy("delete");
    startTransition(async () => {
      const result = await deleteDocument(documentId);
      setBusy(null);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      if (result.data.warning) setNotice(result.data.warning);
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-1">
        <Button
          variant="secondary"
          size="sm"
          onClick={reingest}
          disabled={busy !== null || pending}
        >
          <RefreshCw
            className={
              busy === "reingest" ? "size-3.5 animate-spin" : "size-3.5"
            }
            aria-hidden
          />
          再取り込み
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={remove}
          disabled={busy !== null || pending}
          className="text-danger-600 hover:bg-danger-50"
        >
          <Trash2 className="size-3.5" aria-hidden />
          削除
        </Button>
      </div>
      {error && (
        <p className="max-w-64 text-right text-xs text-danger-600">{error}</p>
      )}
      {notice && (
        <p className="max-w-64 text-right text-xs text-ink-500">{notice}</p>
      )}
    </div>
  );
}
