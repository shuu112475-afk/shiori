import { requireAdmin } from "@/lib/auth";
import { AppShell } from "@/components/AppShell";

/**
 * /admin 配下の共通ガード。
 * proxy.ts のリダイレクトだけに頼らず、サーバー側でも毎回 role を確認する
 * （管理画面は組織の全ドキュメントとログが見えるので、多重に守る）。
 */
export default async function AdminLayout({ children }: LayoutProps<"/admin">) {
  const session = await requireAdmin();
  return <AppShell user={session}>{children}</AppShell>;
}
