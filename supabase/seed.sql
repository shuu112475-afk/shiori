-- ============================================================
-- Shiori: seed.sql — デモ用テナントの初期データ
--   0001_init.sql / 0002_signup_org_fallback.sql を実行したあとに
--   Supabase の SQL Editor で実行する。
--   何度実行しても同じ状態になる（冪等）。
-- ============================================================
--
-- ここで作るのは「組織」と「メンバーの所属」だけ。
-- 文書とチャンクは管理画面からアップロードして取り込む
-- （パース → チャンキング → Embedding を実際に通したいため、
--   出来上がったチャンクを直接 insert することはしない）。
--
-- 手順の全体像は docs/DEMO.md を参照。

-- ------------------------------------------------------------
-- 1. 組織
-- ------------------------------------------------------------
-- email_domain を入れておくと、このドメインのメールでサインアップした
-- ユーザーが自動でこの組織に所属する（handle_new_user のフォールバック）。
-- 自分のメールドメインで試すときはここを書き換える。
insert into public.organizations (id, name, email_domain)
values (
  'a0000000-0000-4000-8000-000000000001',
  'さくら総合病院',
  null   -- 例: 'sakura-hp.example.jp'
)
on conflict (id) do update
  set name = excluded.name,
      email_domain = excluded.email_domain;

-- ------------------------------------------------------------
-- 2. メンバーの所属を割り当てる
-- ------------------------------------------------------------
-- 先に Supabase ダッシュボード（Authentication > Users > Add user）で
-- ユーザーを作っておくこと。Add user では user metadata を入れられない
-- ことがあるが、0002 のフォールバックにより所属未設定のまま
-- アカウントは作られるので、ここで割り当てれば良い。
--
-- 部署はデモ文書の公開設定に合わせて 放射線科 / 看護部 / 事務部 / 医事課 の4つ。
-- 放射線科ユーザーと看護部ユーザーの2アカウントがあると、
-- 06_放射線部門業務マニュアル.md による部署フィルタのデモができる。
--
-- ↓ メールアドレスを自分が作ったものに書き換えてから実行する。

select public.assign_profile(
  p_email        => 'admin@example.com',
  p_org_id       => 'a0000000-0000-4000-8000-000000000001',
  p_display_name => '管理者',
  p_department   => '事務部',
  p_role         => 'admin'
);

select public.assign_profile(
  p_email        => 'rt@example.com',
  p_org_id       => 'a0000000-0000-4000-8000-000000000001',
  p_display_name => '放射線科スタッフ',
  p_department   => '放射線科',
  p_role         => 'member'
);

select public.assign_profile(
  p_email        => 'nurse@example.com',
  p_org_id       => 'a0000000-0000-4000-8000-000000000001',
  p_display_name => '看護部スタッフ',
  p_department   => '看護部',
  p_role         => 'member'
);

-- ------------------------------------------------------------
-- 3. 確認
-- ------------------------------------------------------------
select
  p.display_name,
  p.department,
  p.role,
  u.email
from public.profiles p
join auth.users u on u.id = p.id
where p.org_id = 'a0000000-0000-4000-8000-000000000001'
order by p.role, p.department;
