-- ============================================================
-- Shiori: 0003_storage_policies.sql
--   documents バケット（storage.objects）の RLS ポリシー
-- ============================================================
--
-- 0001 はテーブルの RLS しか作っておらず、Storage 側が空だった。
-- Supabase の storage.objects は最初から RLS 有効・ポリシー0件なので、
-- 「全部拒否」になる。結果、ブラウザからのアップロードが必ず失敗する。
--
-- ファイル本体は Server Action の 1MB 制限を避けるため
-- ブラウザ → Storage へ直接上げている（UploadPanel）。
-- つまりこの経路だけは **ログインユーザーの権限** で走るので、
-- ここにポリシーが要る。
--
-- 一方、取り込みワーカーの download と削除時の remove は
-- service role なので RLS をバイパスする。読み取り用のポリシーは
-- 動作には不要だが、ダッシュボードから中身を確認できるよう
-- 管理者の select だけ許可しておく。
--
-- パスの形式は UploadPanel が発行する
--   `${org_id}/${uuid}.${ext}`
-- なので、先頭フォルダ = org_id。これを自組織のものに限定すれば
-- 他組織の領域へ書き込めない。

-- ------------------------------------------------------------
-- アップロード（管理者のみ・自組織のフォルダのみ）
-- ------------------------------------------------------------
create policy documents_insert_admin
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'documents'
    and public.is_admin()
    and (storage.foldername(name))[1] = public.current_org_id()::text
  );

-- ------------------------------------------------------------
-- 閲覧（管理者のみ・自組織のフォルダのみ）
--   アプリの取り込みは service role で読むのでここには依存しない。
--   利用者に原本ファイルを直接触らせない方針のため member には出さない。
-- ------------------------------------------------------------
create policy documents_select_admin
  on storage.objects for select to authenticated
  using (
    bucket_id = 'documents'
    and public.is_admin()
    and (storage.foldername(name))[1] = public.current_org_id()::text
  );

-- ------------------------------------------------------------
-- 差し替え・削除（管理者のみ・自組織のフォルダのみ）
--   アプリの削除は service role 経由だが、
--   ダッシュボードからの手動操作や将来の再アップロードのために用意する。
-- ------------------------------------------------------------
create policy documents_update_admin
  on storage.objects for update to authenticated
  using (
    bucket_id = 'documents'
    and public.is_admin()
    and (storage.foldername(name))[1] = public.current_org_id()::text
  )
  with check (
    bucket_id = 'documents'
    and public.is_admin()
    and (storage.foldername(name))[1] = public.current_org_id()::text
  );

create policy documents_delete_admin
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'documents'
    and public.is_admin()
    and (storage.foldername(name))[1] = public.current_org_id()::text
  );
