"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { writeAuditLog } from "@/lib/ingest";
import type { ActionResult } from "@/app/admin/action-result";

const UpdateSchema = z.object({
  userId: z.string().uuid(),
  department: z.string().trim().min(1, "部署を入力してください").max(50),
  role: z.enum(["admin", "member"]),
});

export async function updateMember(
  input: z.infer<typeof UpdateSchema>,
): Promise<ActionResult<null>> {
  const session = await requireAdmin();

  const parsed = UpdateSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "入力内容が不正です",
    };
  }
  const { userId, department, role } = parsed.data;

  // 自分の管理者権限を外すと、その瞬間に管理画面へ入れなくなる。
  // 組織に管理者が1人もいなくなると誰も復旧できないので、ここで止める。
  if (userId === session.id && role !== "admin") {
    return {
      ok: false,
      error:
        "自分自身の管理者権限は外せません。他のメンバーを管理者にしてから、そのアカウントで変更してください。",
    };
  }

  const supabase = await createClient();

  const { data: before } = await supabase
    .from("profiles")
    .select("id, department, role, display_name")
    .eq("id", userId)
    .maybeSingle<{
      id: string;
      department: string;
      role: string;
      display_name: string | null;
    }>();

  if (!before) {
    return { ok: false, error: "メンバーが見つからないか、権限がありません" };
  }

  // RLS（profiles_admin_all）が同組織かどうかを担保する
  const { error } = await supabase
    .from("profiles")
    .update({ department, role })
    .eq("id", userId);

  if (error) {
    return { ok: false, error: `更新に失敗しました: ${error.message}` };
  }

  await writeAuditLog({
    orgId: session.profile.org_id,
    userId: session.id,
    action: "member.update",
    targetType: "profile",
    targetId: userId,
    detail: {
      displayName: before.display_name,
      before: { department: before.department, role: before.role },
      after: { department, role },
    },
  });

  revalidatePath("/admin/members");
  return { ok: true, data: null };
}
