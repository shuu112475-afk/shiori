-- ============================================================
-- Shiori: 社内ドキュメントAI検索システム
-- 0001_init.sql : スキーマ / RLS / ハイブリッド検索
-- ============================================================

create extension if not exists "vector"  with schema extensions;
create extension if not exists "pg_trgm" with schema extensions;

-- ------------------------------------------------------------
-- ENUM
-- ------------------------------------------------------------
create type public.member_role   as enum ('admin', 'member');
create type public.doc_status    as enum ('pending', 'processing', 'ready', 'failed');
create type public.message_role  as enum ('user', 'assistant');
create type public.feedback_verdict as enum ('good', 'bad');

-- ------------------------------------------------------------
-- 組織 / プロフィール
-- ------------------------------------------------------------
create table public.organizations (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  email_domain text,                        -- ドメイン制限サインアップ用（例: example.co.jp）
  created_at   timestamptz not null default now()
);

create table public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  org_id      uuid not null references public.organizations(id) on delete cascade,
  display_name text,
  department  text not null default '未所属',
  role        public.member_role not null default 'member',
  created_at  timestamptz not null default now()
);
create index on public.profiles (org_id);

-- ------------------------------------------------------------
-- RLS ヘルパー
--   profiles を参照するポリシーが profiles 自身の RLS を再帰評価しないよう
--   security definer で RLS をバイパスさせる
-- ------------------------------------------------------------
create or replace function public.current_org_id()
returns uuid language sql stable security definer set search_path = public as $$
  select org_id from public.profiles where id = auth.uid()
$$;

create or replace function public.current_department()
returns text language sql stable security definer set search_path = public as $$
  select department from public.profiles where id = auth.uid()
$$;

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select role = 'admin' from public.profiles where id = auth.uid()), false)
$$;

-- ------------------------------------------------------------
-- ドキュメント
--   allowed_departments が NULL / 空 = 全部署に公開
-- ------------------------------------------------------------
create table public.documents (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null references public.organizations(id) on delete cascade,
  title               text not null,
  file_path           text not null,               -- Supabase Storage 上のパス
  mime_type           text not null,
  byte_size           bigint,
  status              public.doc_status not null default 'pending',
  page_count          int,
  chunk_count         int not null default 0,
  allowed_departments text[],
  error_message       text,
  uploaded_by         uuid references auth.users(id) on delete set null,
  created_at          timestamptz not null default now(),
  indexed_at          timestamptz
);
create index on public.documents (org_id, status);

-- ------------------------------------------------------------
-- チャンク
--   heading_path: 「就業規則 > 第4章 休暇 > 第22条 年次有給休暇」
--   検索対象は heading_path も含めた search_text（見出し語でも当てるため）
-- ------------------------------------------------------------
create table public.chunks (
  id           bigint generated always as identity primary key,
  document_id  uuid not null references public.documents(id) on delete cascade,
  org_id       uuid not null references public.organizations(id) on delete cascade,
  chunk_index  int  not null,
  content      text not null,
  heading_path text,
  page_no      int,
  token_count  int,
  embedding    extensions.vector(1536),
  search_text  text generated always as (coalesce(heading_path, '') || ' ' || content) stored
);
create index on public.chunks (document_id, chunk_index);
create index on public.chunks (org_id);

-- ベクトル検索: HNSW / cosine
create index chunks_embedding_hnsw
  on public.chunks using hnsw (embedding extensions.vector_cosine_ops);

-- レキシカル検索: 日本語は標準の to_tsvector が分かち書きできないため trigram を使う
--   （pgroonga / textsearch_ja は Supabase では利用不可）
create index chunks_search_text_trgm
  on public.chunks using gin (search_text extensions.gin_trgm_ops);

-- ------------------------------------------------------------
-- 会話 / メッセージ / 出典
-- ------------------------------------------------------------
create table public.conversations (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references public.organizations(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  title      text not null default '新しい会話',
  created_at timestamptz not null default now()
);
create index on public.conversations (user_id, created_at desc);

create table public.messages (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  org_id          uuid not null references public.organizations(id) on delete cascade,
  role            public.message_role not null,
  content         text not null,
  top_score       double precision,      -- 検索最高スコア（未回答判定の根拠）
  answered        boolean,               -- false = 根拠不足で回答を拒否した
  latency_ms      int,
  input_tokens    int,
  output_tokens   int,
  created_at      timestamptz not null default now()
);
create index on public.messages (conversation_id, created_at);
create index on public.messages (org_id, created_at desc);

create table public.citations (
  id         bigint generated always as identity primary key,
  message_id uuid not null references public.messages(id) on delete cascade,
  chunk_id   bigint not null references public.chunks(id) on delete cascade,
  rank       int not null,
  score      double precision not null
);
create index on public.citations (message_id, rank);

create table public.feedback (
  id         bigint generated always as identity primary key,
  message_id uuid not null references public.messages(id) on delete cascade,
  org_id     uuid not null references public.organizations(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  verdict    public.feedback_verdict not null,
  comment    text,
  created_at timestamptz not null default now(),
  unique (message_id, user_id)
);

-- ------------------------------------------------------------
-- FAQ上書き（運用で精度を上げるループの出口）
-- ------------------------------------------------------------
create table public.faq_overrides (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references public.organizations(id) on delete cascade,
  question   text not null,
  answer     text not null,
  embedding  extensions.vector(1536),
  enabled    boolean not null default true,
  hit_count  int not null default 0,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index faq_embedding_hnsw
  on public.faq_overrides using hnsw (embedding extensions.vector_cosine_ops);

-- ------------------------------------------------------------
-- 未回答キュー（改善ループの入口）
-- ------------------------------------------------------------
create table public.unanswered (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references public.organizations(id) on delete cascade,
  query           text not null,
  top_score       double precision,
  asked_by        uuid references auth.users(id) on delete set null,
  message_id      uuid references public.messages(id) on delete set null,
  resolved        boolean not null default false,
  faq_override_id uuid references public.faq_overrides(id) on delete set null,
  created_at      timestamptz not null default now()
);
create index on public.unanswered (org_id, resolved, created_at desc);

-- ------------------------------------------------------------
-- 監査ログ
-- ------------------------------------------------------------
create table public.audit_logs (
  id          bigint generated always as identity primary key,
  org_id      uuid not null references public.organizations(id) on delete cascade,
  user_id     uuid references auth.users(id) on delete set null,
  action      text not null,               -- 'document.upload' 'chat.ask' 'faq.create' ...
  target_type text,
  target_id   text,
  detail      jsonb,
  created_at  timestamptz not null default now()
);
create index on public.audit_logs (org_id, created_at desc);

-- ============================================================
-- RLS
-- ============================================================
alter table public.organizations  enable row level security;
alter table public.profiles       enable row level security;
alter table public.documents      enable row level security;
alter table public.chunks         enable row level security;
alter table public.conversations  enable row level security;
alter table public.messages       enable row level security;
alter table public.citations      enable row level security;
alter table public.feedback       enable row level security;
alter table public.faq_overrides  enable row level security;
alter table public.unanswered     enable row level security;
alter table public.audit_logs     enable row level security;

-- 組織: 自組織のみ閲覧
create policy org_select on public.organizations
  for select using (id = public.current_org_id());

-- プロフィール: 同組織は閲覧可 / 自分は更新可 / 管理者は全操作
create policy profiles_select on public.profiles
  for select using (org_id = public.current_org_id());
create policy profiles_update_self on public.profiles
  for update using (id = auth.uid()) with check (id = auth.uid());
create policy profiles_admin_all on public.profiles
  for all using (org_id = public.current_org_id() and public.is_admin())
  with check (org_id = public.current_org_id() and public.is_admin());

-- ドキュメント: 同組織 かつ（管理者 or 部署が許可されている）
create policy documents_select on public.documents
  for select using (
    org_id = public.current_org_id()
    and (
      public.is_admin()
      or allowed_departments is null
      or cardinality(allowed_departments) = 0
      or public.current_department() = any (allowed_departments)
    )
  );
create policy documents_admin_write on public.documents
  for all using (org_id = public.current_org_id() and public.is_admin())
  with check (org_id = public.current_org_id() and public.is_admin());

-- チャンク: 閲覧可能なドキュメントに紐づくものだけ
create policy chunks_select on public.chunks
  for select using (
    exists (select 1 from public.documents d where d.id = chunks.document_id)
  );

-- 会話 / メッセージ / 評価:
--   書き込みは本人のみ。管理者は「同じ組織の分を閲覧のみ」できる。
--   利用ログ・評価・監査は管理画面の主機能なので、service role で RLS を丸ごと
--   迂回するのではなく読み取りポリシーとして明示する。
--   service role の用途を「取り込みワーカー・監査ログ書き込み・auth.users 参照」に
--   限定できるので、漏えい時の影響範囲を説明できる。
create policy conversations_own on public.conversations
  for all using (user_id = auth.uid()) with check (user_id = auth.uid() and org_id = public.current_org_id());

create policy messages_own on public.messages
  for all using (
    exists (select 1 from public.conversations c
            where c.id = messages.conversation_id and c.user_id = auth.uid())
  )
  with check (
    exists (select 1 from public.conversations c
            where c.id = messages.conversation_id and c.user_id = auth.uid())
  );

create policy citations_own on public.citations
  for select using (
    exists (select 1 from public.messages m
            join public.conversations c on c.id = m.conversation_id
            where m.id = citations.message_id and c.user_id = auth.uid())
  );

create policy feedback_own on public.feedback
  for all using (user_id = auth.uid()) with check (user_id = auth.uid() and org_id = public.current_org_id());

-- 管理者の閲覧専用ポリシー（select のみ。管理者でも他人の会話は書き換えられない）
create policy conversations_admin_read on public.conversations
  for select using (org_id = public.current_org_id() and public.is_admin());

create policy messages_admin_read on public.messages
  for select using (org_id = public.current_org_id() and public.is_admin());

create policy citations_admin_read on public.citations
  for select using (
    exists (select 1 from public.messages m
            where m.id = citations.message_id
              and m.org_id = public.current_org_id())
    and public.is_admin()
  );

create policy feedback_admin_read on public.feedback
  for select using (org_id = public.current_org_id() and public.is_admin());

-- FAQ: 同組織は閲覧可 / 管理者のみ編集
create policy faq_select on public.faq_overrides
  for select using (org_id = public.current_org_id());
create policy faq_admin_write on public.faq_overrides
  for all using (org_id = public.current_org_id() and public.is_admin())
  with check (org_id = public.current_org_id() and public.is_admin());

-- 未回答 / 監査ログ: 管理者のみ
create policy unanswered_admin on public.unanswered
  for all using (org_id = public.current_org_id() and public.is_admin())
  with check (org_id = public.current_org_id() and public.is_admin());
create policy audit_admin on public.audit_logs
  for select using (org_id = public.current_org_id() and public.is_admin());

-- ============================================================
-- ハイブリッド検索
--   ベクトル検索 (cosine) と レキシカル検索 (trigram) を
--   RRF: score = Σ 1 / (k + rank) で統合する。
--   security invoker のため、呼び出したユーザーの RLS がそのまま効く
--   = 部署別アクセス制御が検索結果に自動で反映される。
-- ============================================================
create or replace function public.hybrid_search(
  query_embedding extensions.vector(1536),
  query_text      text,
  match_count     int  default 5,
  pool_size       int  default 20,
  rrf_k           int  default 60
)
returns table (
  chunk_id     bigint,
  document_id  uuid,
  document_title text,
  content      text,
  heading_path text,
  page_no      int,
  score        double precision,
  vector_similarity  double precision,
  lexical_similarity double precision,
  vector_rank  int,
  lexical_rank int
)
language sql stable security invoker set search_path = public, extensions as $$
  with vector_hits as (
    select c.id,
           1 - (c.embedding <=> query_embedding) as similarity,
           row_number() over (order by c.embedding <=> query_embedding) as rank
    from public.chunks c
    where c.embedding is not null
    order by c.embedding <=> query_embedding
    limit pool_size
  ),
  lexical_hits as (
    select c.id,
           extensions.word_similarity(query_text, c.search_text) as similarity,
           row_number() over (
             order by extensions.word_similarity(query_text, c.search_text) desc
           ) as rank
    from public.chunks c
    where query_text %> c.search_text
    order by extensions.word_similarity(query_text, c.search_text) desc
    limit pool_size
  ),
  fused as (
    select coalesce(v.id, l.id) as id,
           coalesce(1.0 / (rrf_k + v.rank), 0.0)
         + coalesce(1.0 / (rrf_k + l.rank), 0.0) as score,
           coalesce(v.similarity, 0.0) as vector_similarity,
           coalesce(l.similarity, 0.0) as lexical_similarity,
           v.rank as vrank,
           l.rank as lrank
    from vector_hits v
    full outer join lexical_hits l on l.id = v.id
  )
  select c.id,
         c.document_id,
         d.title,
         c.content,
         c.heading_path,
         c.page_no,
         f.score,
         f.vector_similarity,
         f.lexical_similarity,
         f.vrank::int,
         f.lrank::int
  from fused f
  join public.chunks c    on c.id = f.id
  join public.documents d on d.id = c.document_id
  order by f.score desc
  limit match_count;
$$;

comment on function public.hybrid_search is
  'RRF統合スコア(score)は順位のみに基づくため、関連度の絶対評価には使えない。
   「答えられるか」の判定には必ず vector_similarity（cosine類似度）を使うこと。';

-- FAQ上書きの照合（閾値以上なら検索を省略して即答する）
create or replace function public.match_faq(
  query_embedding extensions.vector(1536),
  similarity_threshold double precision default 0.92
)
returns table (id uuid, question text, answer text, similarity double precision)
language sql stable security invoker set search_path = public, extensions as $$
  select f.id, f.question, f.answer,
         1 - (f.embedding <=> query_embedding) as similarity
  from public.faq_overrides f
  where f.enabled
    and f.embedding is not null
    and 1 - (f.embedding <=> query_embedding) >= similarity_threshold
  order by f.embedding <=> query_embedding
  limit 1;
$$;

-- FAQ上書きが使われた回数を数える（どのFAQが効いているかを管理画面で見るため）
create or replace function public.increment_faq_hit(faq_id uuid)
returns void language sql volatile security definer set search_path = public as $$
  update public.faq_overrides set hit_count = hit_count + 1 where id = faq_id;
$$;

-- ============================================================
-- 新規ユーザーに profiles を自動作成
--   raw_user_meta_data.org_id / department を引き継ぐ
-- ============================================================
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, org_id, display_name, department, role)
  values (
    new.id,
    (new.raw_user_meta_data ->> 'org_id')::uuid,
    coalesce(new.raw_user_meta_data ->> 'display_name', split_part(new.email, '@', 1)),
    coalesce(new.raw_user_meta_data ->> 'department', '未所属'),
    coalesce((new.raw_user_meta_data ->> 'role')::public.member_role, 'member')
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
