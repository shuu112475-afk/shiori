"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { BookOpen, SendHorizontal, Sparkles } from "lucide-react";
import { Button, Spinner, Textarea } from "@/components/ui";
import type { Citation } from "@/lib/types";
import type { SessionUser } from "@/lib/auth";
import { ConversationSidebar } from "./ConversationSidebar";
import { CitationList } from "./CitationList";
import { MessageBubble } from "./MessageBubble";
import type { ChatMessage, ConversationSummary } from "./types";

type Props = {
  user: SessionUser;
  conversations: ConversationSummary[];
  /** 既存会話を開いているときだけ渡る。/chat（新規）では undefined */
  conversationId?: string;
  initialMessages: ChatMessage[];
};

/** デモの導線。クリックで入力欄に入る */
const SAMPLE_QUESTIONS = [
  "有給休暇の繰り越しは何日まで？",
  "退職手続きの流れを教えて",
  "出張旅費の上限は？",
  "育児休業はいつから申請できる？",
];

/** /api/chat が流す NDJSON の1行 */
type StreamEvent =
  | { type: "meta"; conversationId: string }
  | { type: "citations"; citations: Citation[] }
  | { type: "text"; text: string }
  | {
      type: "done";
      messageId: string;
      answered: boolean;
      topSimilarity: number;
    }
  | { type: "error"; message: string };

export function ChatView({
  user,
  conversations,
  conversationId,
  initialMessages,
}: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [activeConversationId, setActiveConversationId] = useState<
    string | undefined
  >(conversationId);
  const [conversationList, setConversationList] =
    useState<ConversationSummary[]>(conversations);
  // 本文の [n] をクリックしたときに右パネルで指すカード
  const [focus, setFocus] = useState<{
    messageId: string;
    rank: number;
  } | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  // ui/index.tsx の Textarea は ref を props 型に持たないので、
  // 包み要素から実 DOM を引いてフォーカスを当てる
  const composerRef = useRef<HTMLDivElement>(null);
  const focusInput = useCallback(() => {
    composerRef.current?.querySelector("textarea")?.focus();
  }, []);
  // IME 変換中の Enter で送信してしまうのを防ぐ。isComposing だけだと
  // ブラウザによって確定直後のキーイベントを拾うことがあるので両方見る
  const composingRef = useRef(false);

  /** 右パネルに出す出典。未選択なら「出典を持つ最後のメッセージ」 */
  const panelMessage = useMemo(() => {
    if (focus) {
      const found = messages.find((m) => m.id === focus.messageId);
      if (found) return found;
    }
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i].citations.length > 0) return messages[i];
    }
    return null;
  }, [messages, focus]);

  const lastContentLength = messages.at(-1)?.content.length ?? 0;
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, lastContentLength]);

  const patchMessage = useCallback(
    (id: string, fn: (m: ChatMessage) => ChatMessage) => {
      setMessages((prev) => prev.map((m) => (m.id === id ? fn(m) : m)));
    },
    [],
  );

  const send = useCallback(
    async (rawQuery: string) => {
      const query = rawQuery.trim();
      if (!query || isStreaming) return;

      const stamp = Date.now();
      const userId = `local-user-${stamp}`;
      // done を受け取るまでは DB の id が分からないので暫定 id で保持する
      let assistantId = `local-assistant-${stamp}`;

      setMessages((prev) => [
        ...prev,
        {
          id: userId,
          role: "user",
          content: query,
          citations: [],
          answered: null,
          topScore: null,
          createdAt: new Date().toISOString(),
        },
        {
          id: assistantId,
          role: "assistant",
          content: "",
          citations: [],
          answered: null,
          topScore: null,
          createdAt: new Date().toISOString(),
          streaming: true,
        },
      ]);
      setInput("");
      setFocus(null);
      setIsStreaming(true);

      const handleEvent = (event: StreamEvent) => {
        switch (event.type) {
          case "meta": {
            if (activeConversationId) break;
            setActiveConversationId(event.conversationId);
            setConversationList((prev) =>
              prev.some((c) => c.id === event.conversationId)
                ? prev
                : [
                    {
                      id: event.conversationId,
                      // サーバー側の仮タイトル生成と同じ規則に合わせる
                      title:
                        query.length > 30 ? `${query.slice(0, 30)}…` : query,
                      created_at: new Date().toISOString(),
                    },
                    ...prev,
                  ],
            );
            // router.replace だとサーバーコンポーネントを取り直して
            // 進行中のストリームごと画面が差し替わる。URL だけ書き換える
            window.history.replaceState(
              null,
              "",
              `/chat/${event.conversationId}`,
            );
            break;
          }
          case "citations":
            patchMessage(assistantId, (m) => ({
              ...m,
              citations: event.citations,
            }));
            break;
          case "text":
            patchMessage(assistantId, (m) => ({
              ...m,
              content: m.content + event.text,
            }));
            break;
          case "done": {
            const realId = event.messageId || assistantId;
            patchMessage(assistantId, (m) => ({
              ...m,
              id: realId,
              answered: event.answered,
              topScore: event.topSimilarity,
              streaming: false,
            }));
            assistantId = realId;
            break;
          }
          case "error":
            patchMessage(assistantId, (m) => ({
              ...m,
              streaming: false,
              error: event.message,
            }));
            break;
        }
      };

      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            query,
            conversationId: activeConversationId,
          }),
        });

        if (!res.ok || !res.body) {
          const data = (await res.json().catch(() => null)) as {
            error?: string;
          } | null;
          throw new Error(data?.error ?? "回答を取得できませんでした");
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        // チャンクは行の途中で切れる。残りをバッファに持ち越す
        let buffer = "";

        const flush = (chunk: string) => {
          buffer += chunk;
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              handleEvent(JSON.parse(line) as StreamEvent);
            } catch {
              // 壊れた行は捨てる。1行落ちても会話は続けられる
            }
          }
        };

        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          flush(decoder.decode(value, { stream: true }));
        }
        flush(decoder.decode());
        if (buffer.trim()) {
          try {
            handleEvent(JSON.parse(buffer) as StreamEvent);
          } catch {
            // 同上
          }
        }
      } catch (e) {
        patchMessage(assistantId, (m) => ({
          ...m,
          streaming: false,
          error: e instanceof Error ? e.message : "通信に失敗しました",
        }));
      } finally {
        // done を受け取れずにストリームが切れても、生成中表示のまま
        // 固まらないようにする
        patchMessage(assistantId, (m) =>
          m.streaming ? { ...m, streaming: false } : m,
        );
        setIsStreaming(false);
        // ストリーム完了後にフォーカスを戻すと、連続して質問しやすい
        focusInput();
      }
    },
    [activeConversationId, focusInput, isStreaming, patchMessage],
  );

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key !== "Enter") return;
    if (e.shiftKey) return;
    // 日本語変換中の Enter は「確定」であって「送信」ではない
    if (composingRef.current || e.nativeEvent.isComposing) return;
    e.preventDefault();
    void send(input);
  }

  const displayName = user.profile.display_name ?? "";

  return (
    <div className="flex h-full min-h-0">
      <ConversationSidebar
        conversations={conversationList}
        activeId={activeConversationId}
      />

      {/* 中央: メッセージ列 + 入力欄 */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-3xl px-4 py-6">
            {messages.length === 0 ? (
              <div className="pt-10">
                <div className="flex size-11 items-center justify-center rounded-xl bg-brand-50">
                  <BookOpen className="size-5 text-brand-600" />
                </div>
                <h1 className="mt-4 text-xl font-semibold text-ink-900">
                  {displayName ? `${displayName}さん、` : ""}
                  何を調べますか？
                </h1>
                <p className="mt-2 text-sm leading-relaxed text-ink-600">
                  Shiori
                  は社内文書に書かれていることだけを、出典付きで答えます。
                  <br />
                  根拠が見つからないときは、推測せずに「分かりません」と答え、
                  その質問を管理者の改善キューに送ります。
                </p>

                <p className="mt-8 flex items-center gap-1.5 text-xs font-medium text-ink-400">
                  <Sparkles className="size-3.5" />
                  質問例
                </p>
                <div className="mt-2 grid gap-2 sm:grid-cols-2">
                  {SAMPLE_QUESTIONS.map((q) => (
                    <button
                      key={q}
                      type="button"
                      onClick={() => {
                        setInput(q);
                        focusInput();
                      }}
                      className="rounded-lg border border-ink-200 bg-white px-3 py-2.5 text-left text-sm text-ink-700 transition-colors hover:border-brand-500 hover:bg-brand-50"
                    >
                      {q}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="space-y-5">
                {messages.map((m) => (
                  <MessageBubble
                    key={m.id}
                    message={m}
                    onCitationClick={(rank) =>
                      setFocus({ messageId: m.id, rank })
                    }
                  />
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="border-t border-ink-200 bg-white">
          <div className="mx-auto w-full max-w-3xl px-4 py-3">
            <div ref={composerRef} className="flex items-end gap-2">
              <Textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                onCompositionStart={() => {
                  composingRef.current = true;
                }}
                onCompositionEnd={() => {
                  composingRef.current = false;
                }}
                disabled={isStreaming}
                rows={2}
                maxLength={1000}
                placeholder="社内規程について質問する（Enterで送信 / Shift+Enterで改行）"
                className="max-h-40 min-h-[52px] resize-none disabled:bg-ink-50"
              />
              <Button
                onClick={() => void send(input)}
                disabled={isStreaming || input.trim().length === 0}
                aria-label="送信"
                className="mb-0.5 shrink-0"
              >
                <SendHorizontal className="size-4" />
              </Button>
            </div>
            <p className="mt-1.5 flex h-4 items-center gap-1.5 text-[11px] text-ink-400">
              {isStreaming ? (
                <>
                  <Spinner className="size-3" />
                  回答を作成しています…
                </>
              ) : (
                "回答は社内文書の記載のみに基づきます。出典を必ず確認してください"
              )}
            </p>
          </div>
        </div>
      </div>

      {/* 右: 出典パネル。狭い画面ではメッセージ内のインライン出典で代替する */}
      <aside className="hidden w-[340px] shrink-0 flex-col border-l border-ink-200 bg-ink-50 xl:flex">
        <div className="border-b border-ink-200 bg-white px-4 py-3">
          <h2 className="text-sm font-semibold text-ink-900">出典</h2>
          <p className="mt-0.5 text-[11px] text-ink-500">
            回答中の番号をクリックすると該当箇所へ移動します
          </p>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {panelMessage && panelMessage.citations.length > 0 ? (
            <CitationList
              citations={panelMessage.citations}
              variant="panel"
              activeRank={
                focus && focus.messageId === panelMessage.id ? focus.rank : null
              }
            />
          ) : (
            <p className="px-2 py-10 text-center text-xs text-ink-400">
              まだ出典はありません。
              <br />
              質問すると、根拠にした社内文書がここに並びます
            </p>
          )}
        </div>
      </aside>
    </div>
  );
}
