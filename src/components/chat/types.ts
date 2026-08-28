import type { Citation } from "@/lib/types";

/**
 * 画面上のメッセージ表現。
 * DB の messages 行（過去ログ）と、ストリーミング中の一時メッセージの
 * 両方を同じ形で扱いたいので、messages テーブルの型はそのまま使わない。
 */
export type ChatMessage = {
  /** 生成中は "local-xxx"。done イベントで DB の uuid に差し替わる */
  id: string;
  role: "user" | "assistant";
  content: string;
  citations: Citation[];
  /** false = 根拠不足で回答を断ったメッセージ */
  answered: boolean | null;
  /** cosine 類似度（開発者向けの補助情報） */
  topScore: number | null;
  createdAt: string | null;
  /** ストリーミング中は本文が伸び続ける。完了までフィードバックUIを出さない */
  streaming?: boolean;
  /** ストリーム途中の error イベント、または通信失敗 */
  error?: string | null;
};

/** サイドバー用の会話サマリ（本文は要らないので必要列だけ） */
export type ConversationSummary = {
  id: string;
  title: string;
  created_at: string;
};
