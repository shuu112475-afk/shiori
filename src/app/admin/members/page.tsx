import { Suspense } from "react";
import { Users } from "lucide-react";
import { requireAdmin } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Profile } from "@/lib/types";
import {
  AdminContainer,
  NoteBox,
  PageHeader,
} from "@/components/admin/PageHeader";
import { CardSkeleton } from "@/components/admin/Skeletons";
import { MemberEditor, type MemberItem } from "@/components/admin/MemberEditor";

export const metadata = { title: "メンバー管理 — Shiori" };

export default async function MembersPage() {
  const session = await requireAdmin();

  return (
    <AdminContainer>
      <PageHeader
        title="メンバー"
        description="所属部署と権限を管理します。部署はドキュメントの閲覧範囲（RLS）の判定に使われます。"
      />

      <div className="space-y-6">
        <NoteBox icon={<Users className="size-3.5" aria-hidden />}>
          <p>
            新規ユーザーの招待メール送信は Phase 2 の予定です。現在は Supabase
            のサインアップ（メールドメイン制限）で参加したユーザーが自動的にここへ並びます。
          </p>
        </NoteBox>

        <Suspense fallback={<CardSkeleton label="メンバーを読み込み中" />}>
          <MembersSection currentUserId={session.id} />
        </Suspense>
      </div>
    </AdminContainer>
  );
}

async function MembersSection({ currentUserId }: { currentUserId: string }) {
  const supabase = await createClient();

  const { data: profiles } = await supabase
    .from("profiles")
    .select("*")
    .order("created_at", { ascending: true })
    .returns<Profile[]>();

  const rows = profiles ?? [];

  // メールアドレスは auth.users にあり、RLS 越しの public スキーマからは参照できない。
  // service role の Admin API で引いて id で突き合わせる。
  const emailById = new Map<string, string>();
  let emailError: string | null = null;
  try {
    const admin = createAdminClient();
    const { data, error } = await admin.auth.admin.listUsers({
      page: 1,
      perPage: 1000,
    });
    if (error) {
      emailError = error.message;
    } else {
      for (const user of data.users) {
        if (user.email) emailById.set(user.id, user.email);
      }
    }
  } catch (e) {
    // service role キー未設定でもメンバー一覧そのものは見せたいので、握りつぶさず注記に回す
    emailError = e instanceof Error ? e.message : String(e);
  }

  const members: MemberItem[] = rows.map((p) => ({
    id: p.id,
    displayName: p.display_name ?? "(名称未設定)",
    email: emailById.get(p.id) ?? "(メール取得不可)",
    department: p.department,
    role: p.role,
    createdAt: p.created_at,
  }));

  const departments = Array.from(
    new Set(rows.map((p) => p.department).filter(Boolean)),
  ).sort((a, b) => a.localeCompare(b, "ja"));

  return (
    <div className="space-y-3">
      {emailError && (
        <p className="rounded-lg bg-danger-50 px-4 py-2.5 text-xs text-danger-600">
          メールアドレスを取得できませんでした（{emailError}）。
          SUPABASE_SERVICE_ROLE_KEY が設定されているか確認してください。
        </p>
      )}
      <MemberEditor
        members={members}
        currentUserId={currentUserId}
        departments={departments}
      />
    </div>
  );
}
