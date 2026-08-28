-- ------------------------------------------------------------
-- 1ユーザーあたりの1日の質問回数を数える
--
-- なぜ必要か
--   デモ用のログインボタンは NEXT_PUBLIC_DEMO_PASSWORD を使うが、
--   NEXT_PUBLIC_* はビルド時にクライアントのJSへ埋め込まれる。
--   つまり公開した時点で、パスワードは誰でも取り出せる。
--   /api/chat は 1回あたり Haiku 1回 + Embedding 最大3回 + Sonnet 1回を
--   個人のAPIキーで叩くので、回数制限が無いままだと請求が青天井になる。
--
-- なぜ messages を数えないか
--   messages_own ポリシーは `for all` なので、ユーザーは自分の messages を
--   DELETE できる。messages の件数を上限判定に使うと、消せば上限が戻る。
--   そこで、ユーザーからは触れないカウンタを別に持つ。
-- ------------------------------------------------------------
create table if not exists public.rate_limits (
  user_id      uuid        not null references auth.users(id) on delete cascade,
  window_start timestamptz not null,
  count        int         not null default 0,
  primary key (user_id, window_start)
);

alter table public.rate_limits enable row level security;

-- ポリシーを1つも作らない。
-- RLS 有効 + ポリシー0件 = anon / authenticated からは読み書きどちらも不可。
-- 触れるのは下の security definer 関数と service role だけになる。

-- ------------------------------------------------------------
-- 1回分を消費して、消費後の累計と次のリセット時刻を返す。
--
-- 上限値そのものは引数に取らない。引数にすると、クライアントが直接RPCを
-- 叩くときに好きな上限を渡せてしまう。ここは「数えて返す」だけに留め、
-- 通す / 断るの判断はサーバ側（route.ts）が環境変数の上限と突き合わせて行う。
--
-- security definer なので rate_limits の RLS をバイパスする。
-- 対象ユーザーは引数ではなく auth.uid() から取るため、他人の枠は消費できない。
-- ------------------------------------------------------------
create or replace function public.consume_quota()
returns table (used int, reset_at timestamptz)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user  uuid        := auth.uid();
  v_start timestamptz := date_trunc('day', now());
  v_used  int;
begin
  if v_user is null then
    raise exception 'consume_quota: 認証されていません';
  end if;

  -- insert ... on conflict なので、同時に叩かれても行ロックで直列化される。
  -- select してから update する書き方だと、並列リクエストで数え落とす。
  insert into public.rate_limits as r (user_id, window_start, count)
  values (v_user, v_start, 1)
  on conflict (user_id, window_start)
    do update set count = r.count + 1
  returning r.count into v_used;

  return query select v_used, v_start + interval '1 day';
end;
$$;

-- 古い窓を掃除する用。放っておいても1ユーザー1日1行しか増えないので、
-- デモ規模なら実行しなくても困らない。
create or replace function public.purge_rate_limits(p_keep_days int default 7)
returns int
language sql
security definer
set search_path = public, pg_temp
as $$
  with deleted as (
    delete from public.rate_limits
    where window_start < date_trunc('day', now()) - make_interval(days => p_keep_days)
    returning 1
  )
  select count(*)::int from deleted;
$$;

revoke execute on function public.purge_rate_limits(int) from public, anon, authenticated;
