import { redirect } from "next/navigation";

/** /admin 単体では見せるものが無いので、運用の起点であるドキュメント管理へ送る */
export default function AdminIndexPage() {
  redirect("/admin/documents");
}
