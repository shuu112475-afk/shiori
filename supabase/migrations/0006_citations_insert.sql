-- ------------------------------------------------------------
-- citations に insert のポリシーが無く、出典が1件も保存されていなかった
--
-- 0001 では citations に select のポリシーしか作っていない
-- （citations_own / citations_admin_read）。
-- /api/chat はユーザーのクライアントで insert しているので、RLS に弾かれる。
-- 戻り値のエラーを見ていなかったため、失敗しても誰も気づかなかった。
--
-- 画面上は質問した直後だけ出典が出る（ストリームで別途送っているため）。
-- 会話を開き直すと queries.ts が citations テーブルから組み立て直すので、
-- 根拠の無い回答だけが残る。「出典を出す」が売りなので、ここは致命的だった。
--
-- service role で入れて回避することもできるが、それだと
-- 「自分のメッセージにしか出典を付けられない」保証がアプリ側の実装頼みになる。
-- messages_own と同じ形の with check を置いて、DBに守らせる。
-- ------------------------------------------------------------

create policy citations_own_insert on public.citations
  for insert with check (
    exists (select 1 from public.messages m
            join public.conversations c on c.id = m.conversation_id
            where m.id = citations.message_id and c.user_id = auth.uid())
  );
