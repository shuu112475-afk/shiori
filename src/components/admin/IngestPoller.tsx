"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Spinner } from "@/components/ui";

/** 4秒間隔・最大60回（約4分）で打ち切る。取り込みが詰まったときに永久に叩き続けないため */
const INTERVAL_MS = 4000;
const MAX_POLLS = 60;

/**
 * pending / processing の行があるあいだだけサーバーを再取得する。
 *
 * WebSocket（Supabase Realtime）を張るほどの頻度ではないので router.refresh() で足りる。
 * refresh のたびにサーバー側で件数を数え直すため、
 * activeCount が 0 になった時点で effect が張り直され、ポーリングは自然に止まる。
 *
 * 打ち切りカウンタのリセットは呼び出し側の key={activeCount} に任せている
 * （件数が動いた＝処理が進んでいるときだけ作り直され、
 *   同じ件数のまま止まっているときだけ上限に到達する）。
 */
export function IngestPoller({ activeCount }: { activeCount: number }) {
  const router = useRouter();
  const [stopped, setStopped] = useState(false);
  const pollsRef = useRef(0);

  useEffect(() => {
    if (activeCount === 0 || stopped) return;

    const timer = setInterval(() => {
      pollsRef.current += 1;
      if (pollsRef.current >= MAX_POLLS) {
        setStopped(true);
        return;
      }
      router.refresh();
    }, INTERVAL_MS);

    return () => clearInterval(timer);
  }, [activeCount, stopped, router]);

  if (activeCount === 0) return null;

  return (
    <div className="flex items-center gap-2 rounded-lg border border-brand-100 bg-brand-50 px-4 py-2.5 text-xs text-brand-700">
      {stopped ? (
        <>
          <span>
            {activeCount} 件が処理中のままです。自動更新を停止しました。
            ページを再読み込みするか、「再取り込み」でやり直してください。
          </span>
        </>
      ) : (
        <>
          <Spinner />
          <span>
            {activeCount} 件を取り込み中です。完了するまで自動で更新します。
          </span>
        </>
      )}
    </div>
  );
}
