/**
 * セットアップ診断。
 *
 *   npm run doctor
 *
 * 「ログインできない」「何も検索に出てこない」ときに、
 * どこまで出来ていてどこで止まっているかを切り分ける。
 *
 * service role で接続するので RLS は効かない＝実際にDBに何があるかが見える。
 * 逆に言うと、このスクリプトが見えているものがユーザーにも見えるとは限らない。
 */
import { createClient } from "@supabase/supabase-js";

const OK = "✅";
const NG = "❌";
const WARN = "⚠️ ";

let failed = 0;
function ok(msg: string) {
  console.log(`${OK} ${msg}`);
}
function ng(msg: string, hint?: string) {
  failed += 1;
  console.log(`${NG} ${msg}`);
  if (hint) console.log(`     → ${hint}`);
}
function warn(msg: string, hint?: string) {
  console.log(`${WARN}${msg}`);
  if (hint) console.log(`     → ${hint}`);
}

function section(title: string) {
  console.log(`\n── ${title} ${"─".repeat(Math.max(0, 46 - title.length))}`);
}

async function main() {
  console.log("Shiori セットアップ診断\n");

  // ---------------------------------------------------------
  section("1. 環境変数");
  // ---------------------------------------------------------
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const service = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url) {
    ng("NEXT_PUBLIC_SUPABASE_URL が未設定");
  } else if (!/^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/.test(url)) {
    warn(
      `NEXT_PUBLIC_SUPABASE_URL の形が変わっています: ${url}`,
      "https://xxxx.supabase.co の形か確認してください",
    );
  } else {
    ok(`NEXT_PUBLIC_SUPABASE_URL = ${url}`);
  }

  if (!anon) ng("NEXT_PUBLIC_SUPABASE_ANON_KEY が未設定");
  else
    ok(
      `NEXT_PUBLIC_SUPABASE_ANON_KEY = ${anon.slice(0, 12)}… (${anon.length}文字)`,
    );

  if (!service) ng("SUPABASE_SERVICE_ROLE_KEY が未設定");
  else
    ok(
      `SUPABASE_SERVICE_ROLE_KEY  = ${service.slice(0, 12)}… (${service.length}文字)`,
    );

  if (anon && service && anon === service) {
    ng(
      "anon キーと service role キーが同じ値です",
      "貼り間違いです。Publishable key と Secret key を貼り直してください",
    );
  }

  for (const [name, value] of [
    ["ANTHROPIC_API_KEY", process.env.ANTHROPIC_API_KEY],
    ["OPENAI_API_KEY", process.env.OPENAI_API_KEY],
  ] as const) {
    if (!value)
      warn(`${name} が未設定`, "取り込みと回答生成の段階で必要になります");
    else ok(`${name} = ${value.slice(0, 8)}…`);
  }

  if (!url || !service) {
    console.log("\n接続に必要な値が足りないため、ここで終了します。");
    process.exit(1);
  }

  const db = createClient(url, service, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // ---------------------------------------------------------
  section("2. マイグレーション");
  // ---------------------------------------------------------
  const tables = [
    "organizations",
    "profiles",
    "documents",
    "chunks",
    "conversations",
    "messages",
    "citations",
    "feedback",
    "faq_overrides",
    "unanswered",
    "audit_logs",
  ];
  const missing: string[] = [];
  for (const t of tables) {
    const { error } = await db
      .from(t)
      .select("*", { head: true, count: "exact" });
    if (error) missing.push(`${t} (${error.message})`);
  }
  if (missing.length) {
    ng(
      `テーブルが読めません: ${missing.join(", ")}`,
      "SQL Editor で supabase/migrations/0001_init.sql を実行してください",
    );
  } else {
    ok(`テーブル ${tables.length} 個すべて存在`);
  }

  // hybrid_search が居るか（引数違いのエラーなら「居る」と分かる）
  {
    const { error } = await db.rpc("hybrid_search", {
      query_embedding: `[${new Array(1536).fill(0).join(",")}]`,
      query_text: "接続テスト",
      match_count: 1,
      pool_size: 1,
    });
    if (error && /Could not find the function/i.test(error.message)) {
      ng("hybrid_search() が存在しません", "0001_init.sql を実行してください");
    } else if (error) {
      warn(`hybrid_search() 呼び出しでエラー: ${error.message}`);
    } else {
      ok("hybrid_search() 呼び出し成功");
    }
  }

  // 0004 が当たっているか（キーワード検索側が発火する状態か）を確かめる。
  //
  // 直接 pg_trgm.word_similarity_threshold を読む手段が PostgREST 経由では
  // 無いので、しきい値 0.2 なら通り 0.6 なら落ちる質問文を組み立てて試す。
  //
  //   本文から抜いた20文字（≒21トライグラム）
  // ＋ 本文に出てこないカタカナ20文字（≒21トライグラム）
  //
  // pg_trgm はトライグラムを集合として扱うので、一致するのは前半だけ。
  // word_similarity ≒ 21 / (42 + 21 - 21) = 0.5 になる。
  // 0.2 なら拾えて 0.6 なら拾えない、という判別ができる。
  {
    const { data: sample } = await db
      .from("chunks")
      .select("content")
      .limit(1)
      .maybeSingle<{ content: string }>();

    const excerpt = sample?.content.replace(/\s+/g, "").slice(0, 20);
    if (!excerpt || excerpt.length < 20) {
      // チャンクがまだ無い＝取り込み前。ここでは判定しない
    } else {
      const filler = "アイウエオカキクケコサシスセソタチツテト";
      const { data, error } = await db.rpc("hybrid_search", {
        query_embedding: `[${new Array(1536).fill(0).join(",")}]`,
        query_text: excerpt + filler,
        match_count: 20,
        pool_size: 20,
      });
      const fired = ((data ?? []) as { lexical_rank: number | null }[]).some(
        (h) => h.lexical_rank != null,
      );
      if (error) {
        warn(`キーワード検索の確認に失敗: ${error.message}`);
      } else if (fired) {
        ok("キーワード検索（pg_trgm）が発火する状態です");
      } else {
        ng(
          "キーワード検索が1件も発火しません（実質ベクトル検索のみになっています）",
          "supabase/migrations/0004_lexical_threshold.sql を実行してください",
        );
      }
    }
  }

  // ---------------------------------------------------------
  section("3. Storage");
  // ---------------------------------------------------------
  {
    const { data, error } = await db.storage.listBuckets();
    if (error) {
      ng(`バケット一覧を取得できません: ${error.message}`);
    } else {
      const bucket = data?.find((b) => b.name === "documents");
      if (!bucket) {
        ng(
          `documents バケットがありません（現在: ${data?.map((b) => b.name).join(", ") || "なし"}）`,
          "Storage > New bucket で documents を作成（Public は OFF）",
        );
      } else if (bucket.public) {
        ng(
          "documents バケットが Public になっています",
          "誰でも文書を直接ダウンロードできてしまいます。Private に変更してください",
        );
      } else {
        ok("documents バケット（非公開）");
      }
    }
  }

  // ---------------------------------------------------------
  section("4. 組織とユーザー");
  // ---------------------------------------------------------
  const { data: orgs } = await db
    .from("organizations")
    .select("id, name, email_domain");
  if (!orgs?.length) {
    ng("organizations が空です", "supabase/seed.sql を実行してください");
  } else {
    for (const o of orgs) {
      ok(`組織: ${o.name}（${o.email_domain ?? "ドメイン制限なし"}）`);
    }
  }

  const { data: userList, error: userErr } = await db.auth.admin.listUsers();
  if (userErr) {
    ng(
      `auth.users を読めません: ${userErr.message}`,
      "service role キーが正しいか確認してください",
    );
  } else if (!userList.users.length) {
    ng(
      "ユーザーが1人もいません",
      "Authentication > Users > Add user で作成してください（Auto Confirm User を ON）",
    );
  } else {
    const { data: profiles } = await db
      .from("profiles")
      .select("id, display_name, department, role, org_id");
    const byId = new Map((profiles ?? []).map((p) => [p.id, p]));

    console.log("");
    console.log(
      `   ${"メールアドレス".padEnd(28)} ${"確認".padEnd(6)} ${"部署".padEnd(12)} 権限`,
    );
    for (const u of userList.users) {
      const p = byId.get(u.id);
      const confirmed = u.email_confirmed_at ? "済" : "未確認";
      const dept = p ? p.department : "―";
      const role = p ? p.role : "プロフィール無し";
      console.log(
        `   ${(u.email ?? "(メール無し)").padEnd(28)} ${confirmed.padEnd(6)} ${dept.padEnd(12)} ${role}`,
      );
    }
    console.log("");

    const unconfirmed = userList.users.filter((u) => !u.email_confirmed_at);
    if (unconfirmed.length) {
      ng(
        `メール未確認のユーザーが ${unconfirmed.length} 人います: ${unconfirmed.map((u) => u.email).join(", ")}`,
        "この状態ではログインできません。ユーザーを作り直す（Auto Confirm User を ON）か、該当ユーザーの … > Confirm email から確認済みにしてください",
      );
    }

    const noProfile = userList.users.filter((u) => !byId.has(u.id));
    if (noProfile.length) {
      ng(
        `プロフィール未設定のユーザーが ${noProfile.length} 人います: ${noProfile.map((u) => u.email).join(", ")}`,
        "supabase/seed.sql の p_email を上の実際のアドレスに書き換えて実行してください",
      );
    }

    const admins = (profiles ?? []).filter((p) => p.role === "admin");
    if (!admins.length) {
      ng(
        "管理者（role = admin）が1人もいません",
        "seed.sql で p_role => 'admin' を1人に付けてください",
      );
    } else {
      ok(
        `管理者 ${admins.length} 人: ${admins.map((a) => a.display_name).join(", ")}`,
      );
    }
  }

  // ---------------------------------------------------------
  section("5. 取り込み状況");
  // ---------------------------------------------------------
  {
    const { data: docs } = await db
      .from("documents")
      .select("title, status, chunk_count, allowed_departments, error_message");
    if (!docs?.length) {
      warn(
        "文書がまだ0件です",
        "ログイン後 /admin/documents から demo/documents/ を取り込んでください",
      );
      // 画面でアップロードしたのに0件のままなら、Storage 側で弾かれている。
      // storage.objects は RLS 有効・ポリシー0件が初期状態なので全拒否になる。
      const { data: objs } = await db.storage
        .from("documents")
        .list("", { limit: 1 });
      if (objs && objs.length === 0) {
        warn(
          "Storage にもファイルが1つもありません",
          "画面からアップロード済みならポリシー未作成です。supabase/migrations/0003_storage_policies.sql を実行してください",
        );
      }
    } else {
      for (const d of docs) {
        const scope = d.allowed_departments?.length
          ? d.allowed_departments.join("/")
          : "全社公開";
        const line = `${d.title} — ${d.status} / ${d.chunk_count}チャンク / ${scope}`;
        if (d.status === "ready") ok(line);
        else if (d.status === "failed") ng(line, d.error_message ?? undefined);
        else warn(line);
      }
      const { count } = await db
        .from("chunks")
        .select("*", { head: true, count: "exact" });
      console.log(`\n   チャンク合計: ${count ?? 0}`);
    }
  }

  // ---------------------------------------------------------
  section("結果");
  // ---------------------------------------------------------
  if (failed === 0) {
    console.log(`${OK} 問題は見つかりませんでした。`);
  } else {
    console.log(
      `${NG} ${failed} 件の問題があります。上の → を上から順に解消してください。`,
    );
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("\n診断中に例外が発生しました:");
  console.error(e);
  process.exit(1);
});
