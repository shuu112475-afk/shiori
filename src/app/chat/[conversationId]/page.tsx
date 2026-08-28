import { notFound } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { ChatView } from "@/components/chat/ChatView";
import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { loadConversationMessages, loadConversations } from "../queries";

export default async function ConversationPage(
  props: PageProps<"/chat/[conversationId]">,
) {
  // Next 16 では params は Promise。同期アクセスは削除された
  const { conversationId } = await props.params;

  const session = await requireUser();
  const supabase = await createClient();

  const [conversations, messages] = await Promise.all([
    loadConversations(supabase, session.id),
    loadConversationMessages(supabase, conversationId),
  ]);

  // 他人の会話は RLS で 0 件になる。存在しない会話と区別する意味がないので
  // どちらも 404 として扱う
  if (messages.length === 0) notFound();

  return (
    <AppShell user={session}>
      <ChatView
        // 会話を切り替えたら内部状態を持ち越さない
        key={conversationId}
        user={session}
        conversations={conversations}
        conversationId={conversationId}
        initialMessages={messages}
      />
    </AppShell>
  );
}
