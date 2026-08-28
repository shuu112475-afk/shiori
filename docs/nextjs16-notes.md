# Next.js 16 チートシート（shiori 用）

対象バージョン: **next 16.3.3**（`node_modules/next/package.json` で確認）
出典はすべて `node_modules/next/dist/docs/` 配下のバンドル済みドキュメント。Web 検索は不使用。
以下、パスは `node_modules/next/dist/docs/` からの相対パスで記載する。

このプロジェクトの現状:

- `next.config.ts` は空（**`cacheComponents` は未有効**）→ 「旧キャッシュモデル」が適用される。
- `src/proxy.ts` は既に proxy 規約で存在。

---

## 0. 最重要の 7 点（先に読む）

| #   | 罠                                                  | 正解                                                                                 |
| --- | --------------------------------------------------- | ------------------------------------------------------------------------------------ |
| 1   | `params` / `searchParams` を同期アクセス            | `await props.params` / `await props.searchParams`                                    |
| 2   | `cookies()` / `headers()` を同期アクセス            | `await cookies()` / `await headers()`                                                |
| 3   | `proxy.ts` に `export const runtime`                | 書かない（**エラーを投げる**）                                                       |
| 4   | ストリーミング Route Handler に `runtime = 'edge'`  | 書かない。`new Response(stream, { headers })` だけ                                   |
| 5   | Supabase の常時最新化に脊髄反射で `force-dynamic`   | 16 は fetch も DB 読みも**デフォルト非キャッシュ**。`use cache` を付けないだけでよい |
| 6   | `revalidateTag('tag')`                              | `revalidateTag('tag', 'max')`（第 2 引数必須）                                       |
| 7   | `useActionState` のサーバ関数を `(formData)` で書く | `(prevState, formData)`                                                              |

---

## 1. 15 → 16 の破壊的変更

### 1-1. 非同期 Request API（`params` / `searchParams` / `cookies` / `headers` / `draftMode`）

出典: `01-app/02-guides/upgrading/version-16.md`

> 「Next.js 16 から、同期アクセスは完全に削除されました」（`cookies`, `headers`, `draftMode`, `params`, `searchParams`）

15 では同期アクセスが警告付きで動いたが、**16 では動かない**。

#### ✅ 正しい書き方 — `app/chat/[conversationId]/page.tsx`

```tsx
export default async function ChatPage(
  props: PageProps<"/chat/[conversationId]">,
) {
  const { conversationId } = await props.params;
  const { q } = await props.searchParams;
  return <Chat id={conversationId} query={q} />;
}
```

#### ❌ 間違った書き方

```tsx
// 型エラー & 実行時に壊れる
export default function ChatPage({
  params,
}: {
  params: { conversationId: string };
}) {
  return <Chat id={params.conversationId} />; // ← 同期アクセスは 16 で削除
}
```

`app/admin/documents/[id]/chunks/page.tsx` も同様:

```tsx
export default async function ChunksPage(
  props: PageProps<"/admin/documents/[id]/chunks">,
) {
  const { id } = await props.params;
  // ...
}
```

**`PageProps` / `LayoutProps` / `RouteContext` はグローバル型**で、`next dev` / `next build` / `next typegen` が自動生成する。import 不要。
出典: `01-app/02-guides/upgrading/version-16.md`, `01-app/03-api-reference/03-file-conventions/page.md`

補足（`page.md`）:

- `searchParams` は **プレーンオブジェクト**であって `URLSearchParams` ではない。`.get()` は使えない。
- Client Component で受け取る場合は React の `use()` で unwrap する。

```tsx
"use client";
import { use } from "react";

export default function Page(props: PageProps<"/chat/[conversationId]">) {
  const { conversationId } = use(props.params);
}
```

#### cookies / headers

```ts
// ✅
import { cookies, headers } from "next/headers";
const cookieStore = await cookies();
const token = cookieStore.get("session")?.value;
const h = await headers();

// ❌
const token = cookies().get("session")?.value; // 16 で削除
```

---

### 1-2. Route Handler のデフォルトキャッシュ

出典: `01-app/01-getting-started/15-route-handlers.md`

> 「Route Handlers はデフォルトでキャッシュされません。ただし `GET` メソッドについてはキャッシュにオプトインできます」

つまり `/api/chat` のような POST/ストリーミング用途では**何も書かなくてよい**。キャッシュしたい GET だけ:

```ts
export const dynamic = "force-static"; // GET をキャッシュしたいときだけ
```

（履歴: `01-app/03-api-reference/03-file-conventions/route.md` の Version History に「v15.0.0-RC: GET のデフォルトキャッシュが static → dynamic に変更」とある。）

---

### 1-3. `dynamic` / `revalidate` / `fetchCache` の運命 ← 誤解しやすい

出典: `01-app/03-api-reference/03-file-conventions/02-route-segment-config/index.md`

Version History にこう書かれている:

> `v16.0.0` | `dynamic`, `dynamicParams`, `revalidate`, `fetchCache` は **Cache Components が有効なときに削除**

つまり:

| 条件                                          | `export const dynamic = 'force-dynamic'` |
| --------------------------------------------- | ---------------------------------------- |
| `cacheComponents` 未設定（**shiori の現状**） | **まだ有効**                             |
| `cacheComponents: true`                       | **削除済み。使えない**                   |

`cacheComponents` 無効時に何が使えるかは `01-app/02-guides/caching-without-cache-components.md` に列挙されている（`dynamic = 'auto' | 'force-dynamic' | 'error' | 'force-static'`、`fetchCache`、`revalidate = false | 0 | number`、`unstable_cache`）。

現行の segment config 表に残っているのは `dynamicParams` / `runtime` / `preferredRegion` / `maxDuration` のみ。

---

### 1-4. Supabase を「常に最新」にする正しい方法 ← ここが本命

出典: `01-app/01-getting-started/06-fetching-data.md`, `01-app/01-getting-started/08-caching.md`

`06-fetching-data.md`:

> 「`fetch` リクエストは**デフォルトではキャッシュされず**、リクエストが完了するまでページのレンダリングをブロックします。結果をキャッシュするには `use cache` ディレクティブを使うか、フェッチするコンポーネントを `<Suspense>` で包んでください」

`08-caching.md`:

> 「データを取得し、リクエストごとに新鮮なデータが必要なコンポーネントでは、**`"use cache"` を使わないでください**。代わりにコンポーネントを `<Suspense>` で包んでください」

**Next 16 では非キャッシュがデフォルト。**「最新にするために何かを足す」のではなく「キャッシュしたいときだけ `use cache` を足す」という発想に反転している。

#### ✅ 正しい書き方（shiori の Supabase 読み取り）

```tsx
// app/admin/documents/page.tsx
import { Suspense } from "react";

async function DocumentList() {
  const supabase = await createClient();
  const { data } = await supabase.from("documents").select("*"); // 非キャッシュ（デフォルト）
  return (
    <ul>
      {data?.map((d) => (
        <li key={d.id}>{d.title}</li>
      ))}
    </ul>
  );
}

export default function Page() {
  return (
    <Suspense fallback={<Skeleton />}>
      <DocumentList />
    </Suspense>
  );
}
```

#### ❌ 間違い（というより不要）な書き方

```tsx
export const dynamic = "force-dynamic"; // 15 の癖。16 では通常不要
export const revalidate = 0; // 同上
```

これらは `cacheComponents` 無効の今は**動く**が、書く必要がない。そして `cacheComponents: true` にした瞬間に**削除された API になる**ので、最初から書かないほうが安全。

補足:

- Request 時 API（`cookies` / `headers` / `searchParams` / `params`）を使うコンポーネントは `<Suspense>` の内側に置く（`08-caching.md`）。
- `await params` は可能な限り深い階層に押し下げるか、Promise のまま子に渡すと静的シェルが最大化される（同上）。
- 乱数・タイムスタンプなどリクエストごとに変わる値の前には `await connection()`（`01-app/03-api-reference/04-functions/connection.md`）。**`unstable_noStore` は非推奨で `connection` に置き換え**。

---

### 1-5. `middleware` → `proxy`

出典: `01-app/03-api-reference/03-file-conventions/proxy.md`, `01-app/02-guides/upgrading/version-16.md`

#### ✅ 正しい書き方

```ts
// src/proxy.ts
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export function proxy(request: NextRequest) {
  return NextResponse.redirect(new URL("/home", request.url));
}

export const config = {
  matcher: "/about/:path*",
};
```

- 引数は 2 つ: `(request: NextRequest, event: NextFetchEvent)`。`event.waitUntil(promise)` が使える。
- 型のショートハンド: `export const proxy: NextProxy = (request, event) => { ... }`
- **default export でも named export `proxy` でもよい**（`02-guides/authentication.md` の例は `export default async function proxy(req: NextRequest)`）。
- codemod: `npx @next/codemod@canary middleware-to-proxy .`
- `skipMiddlewareUrlNormalize` → `skipProxyUrlNormalize` にリネーム。

#### ❌ 間違った書き方

```ts
// middleware.ts というファイル名           ← 16 では認識されない
export function middleware(request) {} // ← 関数名も違う
export const runtime = "edge"; // ← proxy では【エラーを投げる】
```

`proxy.md` の記述:

> 「Proxy はデフォルトで Node.js ランタイムを使用します。`runtime` config オプションは Proxy ファイルでは利用できません。Proxy で `runtime` config オプションを設定すると**エラーを投げます**」

#### matcher の推奨形

認証ガード用途では `02-guides/authentication.md` の例が実用的:

```ts
export const config = {
  matcher: ["/((?!api|_next/static|_next/image|.*\\.png$).*)"],
};
```

同ドキュメントの注意点:

- 認証では**全ルートで走らせることが推奨**される。
- proxy 内では cookie の楽観的チェックに留め、**DB 参照はしない**。
- proxy は**唯一の防御線にしてはいけない**。

#### matcher と Server Function のセキュリティ落とし穴（重要）

`proxy.md`:

> Server Function はそれがホストされているルートへの POST として送られる。matcher があるパスを除外していると、**そのパスの Server Function 呼び出しも proxy をスキップする**。したがって**各 Server Function の内部で必ず認可チェックを行うこと**。

その他:

- `matcher` を書かないと `_next/static` / `_next/image` / `public/` を含む**全リクエスト**で走る。
- `_next/data` は除外指定していても proxy を通る（意図的な仕様）。
- RSC 系ヘッダ（`rsc`, `next-router-state-tree`, `next-router-prefetch`）は `request.headers` から除去される。
- `revalidateTag` は **Proxy 内では呼べない**（`04-functions/revalidateTag.md`）。

---

### 1-6. Server Actions

出典: `01-app/01-getting-started/07-mutating-data.md`, `01-app/02-guides/server-actions.md`, `01-app/02-guides/forms.md`

#### `useActionState` を使うとサーバ関数のシグネチャが変わる

```ts
// ✅ app/actions.ts
"use server";
export async function createUser(initialState: any, formData: FormData) {
  // ...
  return { message: "ok" };
}
```

```tsx
// ✅ Client Component
"use client";
import { useActionState } from "react";

const [state, formAction, pending] = useActionState(createUser, initialState);
return <form action={formAction}>...</form>;
```

```ts
// ❌ useActionState と組み合わせるとズレる
'use server'
export async function createUser(formData: FormData) { ... }
```

```tsx
// ❌ 旧 API
const { pending } = useFormStatus(); // 用途が違う（子コンポーネント専用）
const [state, action] = useFormState(fn, s); // useActionState に置換
```

#### その他の Server Action 仕様（`02-guides/server-actions.md`）

- **POST のみ**。
- クライアントからの呼び出しは**逐次実行**される。クライアント側で `Promise.all` しても並列化されない。
- 1 回のレスポンスに「戻り値」と「再レンダリング済み RSC ペイロード」が同梱される（`updateTag` / `revalidatePath` / `refresh` / cookie 変更 / `redirect` のいずれかがあるとき）。
- CSRF: Origin ヘッダ検証あり。
- `redirect()` は throw するので、**revalidate を先に呼ぶ**。

```ts
// ✅
revalidateTag("documents", "max");
redirect("/admin/documents");

// ❌ ここは到達しない
redirect("/admin/documents");
revalidateTag("documents", "max");
```

#### ボディサイズ上限（ファイルアップロードで必ず踏む）

出典: `01-app/03-api-reference/05-config/01-next-config-js/serverActions.md`

**デフォルト 1MB**。multipart のオーバーヘッドが約 10〜20KB あるので実質はもう少し小さい。

```ts
// next.config.ts
const nextConfig: NextConfig = {
  experimental: {
    serverActions: {
      bodySizeLimit: "10mb",
      // allowedOrigins: ['my-proxy.com'],
    },
  },
};
```

さらに proxy を使っている場合の落とし穴（`05-config/01-next-config-js/proxyClientMaxBodySize.md`、experimental）:
proxy があると Next はリクエストボディをバッファリングする（デフォルト 10MB）。**上限超過は拒否ではなく、警告付きで黙って切り詰められる**。

---

### 1-7. `revalidateTag` の 2 引数化

出典: `01-app/02-guides/upgrading/version-16.md`, `01-app/03-api-reference/04-functions/revalidateTag.md`

```ts
// ❌ Before (15)
revalidateTag("posts");

// ✅ After (16)
revalidateTag("posts", "max");
```

シグネチャ: `revalidateTag(tag: string, profile: string | { expire?: number }): void`

- `'max'` が推奨。
- Webhook / Route Handler からは `{ expire: 0 }`。
- **Client Component と Proxy では呼べない。**
- 1 引数形式は非推奨。

新 API:

- `updateTag(tag)` — Server Actions 専用。read-your-writes（自分の書き込みを即座に読める）。
- `refresh()` — `next/cache` から。

---

### 1-8. その他の 16 の変更（`02-guides/upgrading/version-16.md`）

- **Parallel Routes**: `default.js` の明示が必須になった。無いと**ビルド失敗**。
- `experimental.ppr` / `experimental_ppr` 削除 → `cacheComponents: true` に統合。
- `experimental.dynamicIO` / `experimental.useCache` 削除 → 同上。
- `unstable_rootParams` → `next/root-params`。
- `cacheLife` / `cacheTag` が安定化: `import { cacheLife, cacheTag } from 'next/cache'`（`unstable_` プレフィックス廃止）。
- `next dev` は `process.argv` に `'dev'` を含まなくなり、出力先は `.next/dev`。
- Turbopack がデフォルト。

---

## 2. Route Handler でのストリーミング（Claude API 用）

出典: `01-app/02-guides/streaming.md`, `01-app/03-api-reference/03-file-conventions/route.md`

### 結論

- **`ReadableStream` を返すのが正解。**
- **`runtime` の指定は不要**（Node.js がデフォルト、Edge は非推奨）。

### ✅ 正しい書き方

```ts
// app/api/chat/route.ts
export async function POST(request: Request) {
  const { messages } = await request.json();

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      // ここで Claude API のストリームを読んで enqueue する
      for (let i = 0; i < 10; i++) {
        controller.enqueue(encoder.encode(`Chunk ${i + 1}\n`));
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
```

（`streaming.md` のサンプルほぼそのまま。`runtime` の export は**一切登場しない**。）

`route.md` にはイテレータを変換する版もある:

```ts
function iteratorToStream(iterator: any) {
  return new ReadableStream({
    async pull(controller) {
      const { value, done } = await iterator.next();
      if (done) controller.close();
      else controller.enqueue(value);
    },
  });
}
```

### ❌ 間違った書き方

```ts
export const runtime = "edge"; // 非推奨。route から runtime export は消すよう明記されている
export const dynamic = "force-dynamic"; // Route Handler は元々非キャッシュ。不要
```

`01-app/03-api-reference/03-file-conventions/02-route-segment-config/runtime.md`:

> 「Edge Runtime は非推奨です。ルートファイルから `runtime` export を削除してください」
> 「このオプションは Proxy では使用できません」

### ストリーミングの HTTP 契約（`streaming.md`）

- **最初のチャンクを送った時点でステータスコードとヘッダは確定する。**あとから変更できない。
- 本物の 404 を返したいなら `notFound()` は **await や Suspense より前**に呼ぶ。
- ストリーム途中の `redirect()` はクライアントサイドリダイレクトになる。

### バッファリングの罠（`streaming.md`）

ストリームが「届かない」時に疑う場所:

- nginx → `X-Accel-Buffering: no` ヘッダを付ける
- CDN のバッファリング
- AWS Lambda は response streaming モードが必要
- gzip / brotli 圧縮
- Safari は最初の 1024 バイトをバッファする
- `curl` で確認するときは `curl -N`
- Bot には非ストリーミングの完全な HTML が返る

### FormData の受け取り

```ts
// ✅ route.md より
export async function POST(request: Request) {
  const formData = await request.formData();
  const file = formData.get("file") as File;
}
```

### Route Handler の params

```ts
// ✅ params は Promise
export async function GET(
  request: Request,
  { params }: { params: Promise<{ team: string }> },
) {
  const { team } = await params;
}

// ✅ 生成型を使う版
export async function GET(request: Request, ctx: RouteContext<"/users/[id]">) {
  const { id } = await ctx.params;
}

// ❌
export async function GET(
  request: Request,
  { params }: { params: { team: string } },
) {
  const team = params.team;
}
```

### Cache Components 有効時の注意（`15-route-handlers.md`）

> **`use cache` は Route Handler の本体で直接使えない。ヘルパー関数に切り出すこと。**

プリレンダリングは `request.headers` / `req.url` / `request.body` / `cookies()` / `headers()` / `connection()` / 非決定的な処理に触れた時点で停止する。

---

## 3. Next 15 の癖でうっかり書きがちな、非推奨／削除済み API 一覧

出典: `01-app/02-guides/upgrading/version-16.md` および `03-api-reference/` 全体の "deprecated" 横断検索。

### 完全に削除された

| 削除されたもの                                                                               | 代替                                 |
| -------------------------------------------------------------------------------------------- | ------------------------------------ |
| `middleware.ts` / `export function middleware`                                               | `proxy.ts` / `export function proxy` |
| `params` / `searchParams` の同期アクセス                                                     | `await` する                         |
| `cookies()` / `headers()` / `draftMode()` の同期アクセス                                     | `await` する                         |
| `experimental.ppr`, `experimental_ppr`                                                       | `cacheComponents: true`              |
| `experimental.dynamicIO`                                                                     | `cacheComponents: true`              |
| `experimental.useCache`                                                                      | `cacheComponents: true`              |
| `unstable_rootParams`                                                                        | `next/root-params`                   |
| AMP サポート                                                                                 | —                                    |
| `next lint` / `next.config` の `eslint` キー                                                 | ESLint CLI を直接使う                |
| `serverRuntimeConfig` / `publicRuntimeConfig`                                                | 環境変数                             |
| `devIndicators.appIsrStatus` / `.buildActivity` / `.buildActivityPosition`                   | —                                    |
| `exportPathMap`                                                                              | —                                    |
| `dynamic` / `dynamicParams` / `revalidate` / `fetchCache`（**Cache Components 有効時のみ**） | `use cache` / `<Suspense>`           |

### 非推奨（動くが書かないほうがよい）

| 非推奨                                                | 代替                         |
| ----------------------------------------------------- | ---------------------------- |
| `export const runtime = 'edge'`                       | 削除（Node.js がデフォルト） |
| `export const preferredRegion`                        | —                            |
| `unstable_noStore()`                                  | `await connection()`         |
| `revalidateTag(tag)`（1 引数）                        | `revalidateTag(tag, 'max')`  |
| `next/legacy/image`                                   | `next/image`                 |
| `images.domains`                                      | `images.remotePatterns`      |
| `next/image` の `priority`                            | `preload`（16.0.0）          |
| metadata の `themeColor` / `colorScheme` / `viewport` | `export const viewport`      |
| `unstable_cacheLife` / `unstable_cacheTag`            | `cacheLife` / `cacheTag`     |

### next/image のデフォルト値変更（`version-16.md`）

- `minimumCacheTTL`: 60 秒 → **4 時間**
- `qualities`: → **`[75]`**（他の quality を使うなら明示的に設定が必要）
- `imageSizes` から **`16` が削除**
- `maximumRedirects`: **3**
- ローカル IP へのリクエストがブロックされる

---

## 4. shiori の 6 機能ごとの実装チェックリスト

### (1) Claude API ストリーミング Route Handler

- [ ] `runtime` を export しない
- [ ] `new Response(readableStream, { headers })` を返す
- [ ] `Content-Type` と `X-Content-Type-Options: nosniff` を付ける
- [ ] エラーは最初のチャンク前に判定（ステータスは後から変えられない）

### (2) Server Actions（アップロード・FAQ 登録）

- [ ] `'use server'` をファイル先頭に
- [ ] `useActionState` を使うなら `(prevState, formData)`
- [ ] `bodySizeLimit` をアップロードサイズに合わせて引き上げる（デフォルト 1MB）
- [ ] Action 内で**必ず認可チェック**（proxy の matcher に頼らない）
- [ ] `revalidateTag(tag, 'max')` → `redirect()` の順

### (3) 動的ルート 2 本

- [ ] `PageProps<'/chat/[conversationId]'>` を使う
- [ ] `await props.params`

### (4) Supabase の常時最新読み取り

- [ ] `use cache` を**付けない**
- [ ] `<Suspense>` で包む
- [ ] `force-dynamic` は書かない

### (5) `src/proxy.ts` 認証ガード

- [ ] 関数名 `proxy`
- [ ] `runtime` を export しない
- [ ] matcher は静的アセットを除外する negative lookahead
- [ ] cookie の楽観的チェックのみ（DB を叩かない）

### (6) FormData アップロード

- [ ] Route Handler なら `await request.formData()`
- [ ] Server Action なら `bodySizeLimit` と proxy の 10MB バッファ切り詰めに注意

---

## 5. ドキュメントに記載なし

以下は本調査の範囲（バンドル済みドキュメント）では確認できなかった。推測で書かないこと。

- Claude API / Anthropic SDK と Next.js Route Handler の統合に関する記述 → **ドキュメントに記載なし**
- Supabase 固有の連携（`@supabase/ssr` と proxy の組み合わせ）に関する記述 → **ドキュメントに記載なし**
- ベクトル検索 / RAG 固有のパターン → **ドキュメントに記載なし**
- `proxyClientMaxBodySize` の安定版としての扱い（experimental 表記のみ確認）→ 安定化予定は**ドキュメントに記載なし**

---

## 出典ファイル一覧

すべて `node_modules/next/dist/docs/` 配下。

- `01-app/02-guides/upgrading/version-16.md` — 破壊的変更の一次情報
- `01-app/03-api-reference/03-file-conventions/proxy.md` — proxy のシグネチャ・matcher・runtime 禁止
- `01-app/03-api-reference/03-file-conventions/route.md` — Route Handler、params、formData
- `01-app/03-api-reference/03-file-conventions/page.md` — params / searchParams
- `01-app/03-api-reference/03-file-conventions/02-route-segment-config/index.md` — segment config の削除条件
- `01-app/03-api-reference/03-file-conventions/02-route-segment-config/runtime.md` — Edge 非推奨
- `01-app/02-guides/caching-without-cache-components.md` — 旧キャッシュモデルで使える API
- `01-app/01-getting-started/06-fetching-data.md` — fetch のデフォルト非キャッシュ
- `01-app/01-getting-started/08-caching.md` — 「常に新鮮」の正解
- `01-app/01-getting-started/15-route-handlers.md` — Route Handler のキャッシュ
- `01-app/02-guides/streaming.md` — ストリーミングの実装と HTTP 契約
- `01-app/01-getting-started/07-mutating-data.md` / `01-app/02-guides/server-actions.md` — Server Actions
- `01-app/02-guides/forms.md` — `useActionState` のシグネチャ
- `01-app/02-guides/authentication.md` — proxy 認証ガードの実例
- `01-app/03-api-reference/04-functions/revalidateTag.md` — 2 引数化
- `01-app/03-api-reference/04-functions/connection.md` / `after.md`
- `01-app/03-api-reference/05-config/01-next-config-js/cacheComponents.md`
- `01-app/03-api-reference/05-config/01-next-config-js/serverActions.md` — bodySizeLimit
- `01-app/03-api-reference/05-config/01-next-config-js/proxyClientMaxBodySize.md`
- `01-app/03-api-reference/01-directives/use-server.md`
