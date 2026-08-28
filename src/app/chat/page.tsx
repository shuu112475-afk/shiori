import { AppShell } from "@/components/AppShell";
import { ChatView } from "@/components/chat/ChatView";
import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { loadConversations } from "./queries";

export default async function NewChatPage() {
  const session = await requireUser();
  const supabase = await createClient();
  const conversations = await loadConversations(supabase, session.id);

  return (
    <AppShell user={session}>
      <ChatView
        user={session}
        conversations={conversations}
        initialMessages={[]}
      />
    </AppShell>
  );
}
