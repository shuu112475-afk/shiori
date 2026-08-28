# セットアップ手順

## 1. Supabase プロジェクトを作る

1. https://supabase.com/dashboard で新規プロジェクトを作成（リージョンは `Northeast Asia (Tokyo)` 推奨）
2. プロジェクト作成後、**SQL Editor** を開く
3. `supabase/migrations/0001_init.sql` の中身を貼り付けて実行する
   - `vector` / `pg_trgm` 拡張の有効化、テーブル、RLS、`hybrid_search()` などが一括で作られる
4. 続けて `supabase/migrations/0002_signup_org_fallback.sql` を実行する
   - サインアップ時に所属組織が決まらない場合の扱いと、初期セットアップ用の `assign_profile()` が入る
   - **これを飛ばすと、`org_id` を指定せずに作ったユーザーでトリガーが not-null 違反を起こし、ユーザー作成そのものが失敗する**
5. **Storage** で `documents` という名前のバケットを作る（Public にはしない）
6. `supabase/migrations/0003_storage_policies.sql` を実行する
   - `storage.objects` は RLS 有効・ポリシー0件が初期状態＝**全部拒否**。これを飛ばすとブラウザからのアップロードが必ず失敗する
   - **バケットを作ったあとに実行すること**（順序が逆でも通るが、混乱を避けるため）
7. `supabase/migrations/0004_lexical_threshold.sql` を実行する
   - `hybrid_search()` を作り直し、pg_trgm のしきい値を日本語向けに下げる
   - これを飛ばしても動くが、**キーワード検索側が1件も発火せず、実質ベクトル検索だけになる**
   - 適用できているかは `npm run eval` の「キーワード側が1件以上ヒットした質問」で分かる

## 2. API キーを用意する

| 変数                            | 取得場所                          | 用途                                                    |
| ------------------------------- | --------------------------------- | ------------------------------------------------------- |
| `NEXT_PUBLIC_SUPABASE_URL`      | Supabase > Project Settings > API | プロジェクトURL                                         |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | 同上                              | ブラウザ用。RLSが効く                                   |
| `SUPABASE_SERVICE_ROLE_KEY`     | 同上                              | **RLSをバイパスする。サーバー側のみ。絶対に公開しない** |
| `ANTHROPIC_API_KEY`             | https://console.anthropic.com     | 回答生成                                                |
| `OPENAI_API_KEY`                | https://platform.openai.com       | 埋め込み（text-embedding-3-small）                      |

## 3. 環境変数ファイルを置く

プロジェクト直下に `.env.local` を作り、以下を記入する。

```bash
# ── Supabase ──
NEXT_PUBLIC_SUPABASE_URL=https://xxxxxxxxxxxx.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJhbGciOi...
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOi...

# ── LLM ──
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_MODEL=claude-sonnet-4-6
OPENAI_API_KEY=sk-...

# ── RAG チューニング（省略可）──
# 「答えられる」と判断する cosine 類似度の下限。
#   下げる → 回答範囲は広がるがハルシネーションが増える
#   上げる → 誤答は減るが「見つかりませんでした」が増える
RAG_ANSWER_THRESHOLD=0.35

# FAQ上書きを即答に使う類似度の下限
RAG_FAQ_THRESHOLD=0.92
```

`.env.local` は `.gitignore` 済み。コミットしないこと。

## 4. 起動

```bash
npm install
npm run dev
```

## 5. 初期データ

`supabase/seed.sql` のメールアドレスを、自分が Supabase ダッシュボードで作った
ユーザーのものに書き換えてから SQL Editor で実行すると、組織とメンバーの所属が入る。

デモ文書6本の取り込み、部署フィルタの確認、`npm run eval` までの通し手順は
**`docs/DEMO.md`** を参照。商談用の進行台本は `demo/README.md`。

---

## 設計上の注意

### service role キーの使用範囲

`src/lib/supabase/admin.ts` は RLS をバイパスする。使ってよいのは以下のみ。

1. 取り込みワーカー（チャンク投入・ステータス更新）
2. 監査ログの書き込み（利用者本人には書かせない）
3. 未回答キューへの記録（`unanswered` は管理者しか触れないポリシーのため）
4. `auth.users` の参照（メールアドレスは RLS 越しには読めない）

Server Component / Server Action で通常のデータ取得をするときは
`src/lib/supabase/server.ts` を使い、RLS を効かせること。

**管理画面の一覧・集計も service role は使わない。**
`conversations` / `messages` / `citations` / `feedback` には管理者向けの
閲覧専用ポリシー（`*_admin_read`）を用意してあるので、ログインユーザーの
権限のまま組織内のログを読める。書き込みは本人のみのまま変わらない。
service role の用途を上の4つに閉じておくと、キーが漏れたときの影響範囲を
そのまま説明できる。

### 日本語全文検索について

PostgreSQL 標準の `to_tsvector` は日本語を分かち書きできず、Supabase では
`pgroonga` / `textsearch_ja` も使えない。そのためレキシカル検索は
**`pg_trgm` の `word_similarity`** で実装している（`0001_init.sql` 参照）。

### スコアの扱い

`hybrid_search()` が返す `score` は RRF（順位ベース）なので、**関連度の絶対評価には使えない**。
「答えられるか」の判定には必ず `vector_similarity`（cosine類似度）を使うこと。
