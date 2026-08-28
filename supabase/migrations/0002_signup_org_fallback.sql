-- ============================================================
-- Shiori: 0002_signup_org_fallback.sql
--   サインアップ時に所属組織が決まらないケースを、
--   「アカウント作成の失敗」ではなく「所属未設定」として扱う
-- ============================================================
--
-- 0001 の handle_new_user() は raw_user_meta_data.org_id を
-- そのまま profiles.org_id（not null）に入れていた。
-- そのため org_id を渡さずにユーザーを作ると
--   null value in column "org_id" violates not-null constraint
-- でトリガーが落ち、auth.users への insert ごとロールバックされる。
--
-- これは「Supabase ダッシュボードの Add user から最初の管理者を作る」
-- という一番最初の操作が通らない、ということでもある。
--
-- 対処は2段構え。
--   1. メタデータに org_id が無ければ、メールドメインを
--      organizations.email_domain と突き合わせて組織を引く
--   2. それでも決まらなければ profiles を作らずに通す
--
-- 2 の状態は「ログインはできるが所属が無い」になる。
-- requireUser() が /login?error=no-profile に飛ばし、ログイン画面が
-- 「プロフィールが未設定です。管理者にお問い合わせください。」と案内する。
-- 所属不明のユーザーを勝手にどこかの組織へ入れるより、
-- 入口で止めて管理者に割り当てさせるほうが安全なため、
-- 「とりあえず先頭の組織に入れる」フォールバックは意図的に持たせていない。

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_org_id uuid;
begin
  v_org_id := nullif(new.raw_user_meta_data ->> 'org_id', '')::uuid;

  -- メールドメインから組織を引く（organizations.email_domain）
  if v_org_id is null and new.email is not null then
    select o.id into v_org_id
    from public.organizations o
    where o.email_domain is not null
      and lower(o.email_domain) = lower(split_part(new.email, '@', 2))
    limit 1;
  end if;

  -- 所属が決まらないユーザーは profiles を作らずに通す
  if v_org_id is null then
    return new;
  end if;

  insert into public.profiles (id, org_id, display_name, department, role)
  values (
    new.id,
    v_org_id,
    coalesce(new.raw_user_meta_data ->> 'display_name', split_part(new.email, '@', 1)),
    coalesce(nullif(new.raw_user_meta_data ->> 'department', ''), '未所属'),
    coalesce(nullif(new.raw_user_meta_data ->> 'role', '')::public.member_role, 'member')
  )
  on conflict (id) do nothing;

  return new;
end;
$$;

comment on function public.handle_new_user is
  'auth.users への insert 時に profiles を作る。org_id は
   raw_user_meta_data.org_id → organizations.email_domain の順で解決し、
   どちらでも決まらない場合は profiles を作らずに通す（所属未設定として
   ログイン画面で止める）。ここで例外を投げるとサインアップ自体が失敗する。';

-- ------------------------------------------------------------
-- 所属未設定ユーザーを後から組織へ割り当てるヘルパー
--   メールアドレスは RLS 越しには読めないので security definer。
--   SQL Editor（= postgres ロール）からの初期セットアップ専用で、
--   アプリからは呼ばない。実行権限も anon / authenticated には渡さない。
-- ------------------------------------------------------------
create or replace function public.assign_profile(
  p_email        text,
  p_org_id       uuid,
  p_display_name text default null,
  p_department   text default '未所属',
  p_role         public.member_role default 'member'
)
returns public.profiles
language plpgsql security definer set search_path = public as $$
declare
  v_user_id uuid;
  v_profile public.profiles;
begin
  select id into v_user_id from auth.users where lower(email) = lower(p_email);
  if v_user_id is null then
    raise exception 'auth.users に % が見つかりません。先にユーザーを作成してください', p_email;
  end if;

  insert into public.profiles (id, org_id, display_name, department, role)
  values (
    v_user_id,
    p_org_id,
    coalesce(p_display_name, split_part(p_email, '@', 1)),
    p_department,
    p_role
  )
  on conflict (id) do update
    set org_id       = excluded.org_id,
        display_name = excluded.display_name,
        department   = excluded.department,
        role         = excluded.role
  returning * into v_profile;

  return v_profile;
end;
$$;

revoke all on function public.assign_profile(text, uuid, text, text, public.member_role)
  from public, anon, authenticated;

comment on function public.assign_profile is
  '初期セットアップ用。メールアドレスから auth.users を引いて profiles を
   作成/更新する。SQL Editor からのみ実行する想定で、anon / authenticated
   には実行権限を渡していない（部署と権限を自分で書き換えられてしまうため）。
   運用中のメンバー管理は /admin/members から行うこと。';
