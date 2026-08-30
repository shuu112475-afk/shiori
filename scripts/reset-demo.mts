/**
 * デモ前の初期化。会話ログだけを消す。
 * messages / citations / feedback はカスケードで消える。
 * documents / chunks は残るので取り込み直しは不要。
 *
 * 実行前に必ず内容を表示する。--yes を付けるまで消さない。
 */
import { createClient } from "@supabase/supabase-js";

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
);

const count = async (t: string) =>
  (await admin.from(t).select("*", { count: "exact", head: true })).count ?? 0;

const tables = ["conversations", "messages", "citations", "feedback"];
const keep = ["documents", "chunks", "unanswered", "rate_limits", "profiles"];

console.log("=== 消えるもの ===");
for (const t of tables) console.log(`  ${t.padEnd(14)} ${await count(t)} 件`);
console.log("=== 残るもの ===");
for (const t of keep) console.log(`  ${t.padEnd(14)} ${await count(t)} 件`);

if (!process.argv.includes("--yes")) {
  console.log("\n（--yes を付けると実行します。いまは何も消していません）");
  process.exit(0);
}

const { error } = await admin
  .from("conversations")
  .delete()
  .not("id", "is", null);
if (error) throw new Error(`削除に失敗: ${error.message}`);

console.log("\n=== 削除後 ===");
for (const t of [...tables, ...keep])
  console.log(`  ${t.padEnd(14)} ${await count(t)} 件`);
