"use client";

import { useRef, useState, type DragEvent, type ChangeEvent } from "react";
import { useRouter } from "next/navigation";
import {
  Upload,
  FileText,
  X,
  CircleAlert,
  CircleCheckBig,
  LoaderCircle,
} from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { isSupportedMime } from "@/lib/parse";
import { createDocumentRecord } from "@/app/admin/documents/actions";
import { Badge, Button, Card, CardHeader, Input } from "@/components/ui";
import { cn, formatBytes } from "@/lib/utils";

/**
 * `DOCUMENTS_BUCKET` は @/lib/ingest にあるが、あちらは service role クライアントと
 * PDF/DOCX パーサを引き連れているのでクライアントバンドルに入れたくない。
 * 定数だけここに写して、値がズレないようコメントで対応関係を残す。
 */
const BUCKET = "documents"; // = DOCUMENTS_BUCKET (@/lib/ingest)

/** Supabase Storage の既定上限は 50MB。取り込み時間も考えて 25MB で頭打ちにする */
const MAX_BYTES = 25 * 1024 * 1024;

const ACCEPT = ".pdf,.docx,.md,.markdown,.txt";

/**
 * 拡張子から MIME を補う。
 * ブラウザは .md / .markdown に MIME を割り当てないことが多く（file.type が ""）、
 * そのままだと対応形式なのに弾かれてしまう。
 */
function resolveMime(file: File): string {
  if (file.type && isSupportedMime(file.type)) return file.type;

  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  switch (ext) {
    case "pdf":
      return "application/pdf";
    case "docx":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case "md":
    case "markdown":
      return "text/markdown";
    case "txt":
      return "text/plain";
    default:
      return file.type || "application/octet-stream";
  }
}

function fileExtension(file: File): string {
  const ext = file.name.split(".").pop()?.toLowerCase();
  return ext && /^[a-z0-9]{1,10}$/.test(ext) ? ext : "bin";
}

/** タイトルの初期値は拡張子を落としたファイル名 */
function defaultTitle(file: File): string {
  return file.name.replace(/\.[^.]+$/, "").slice(0, 200) || file.name;
}

/**
 * Supabase Storage / Server Action / 取り込みAPI のどれで失敗したのか、
 * 素のメッセージだけでは判断できない。よくある原因を先回りして提示する。
 * （Supabase プロジェクト未作成の状態でも「何が足りないか」が画面で分かるように）
 */
function diagnose(raw: string): string | null {
  const m = raw.toLowerCase();
  if (m.includes("bucket not found") || m.includes("bucket_not_found")) {
    return `Supabase Storage に「${BUCKET}」バケットがありません。Storage で作成してください。`;
  }
  if (
    m.includes("row-level security") ||
    m.includes("unauthorized") ||
    m.includes("403")
  ) {
    return `Storage の書き込みポリシーが未設定の可能性があります。「${BUCKET}」バケットに認証ユーザーの insert を許可してください。`;
  }
  if (m.includes("already exists")) {
    return "同じパスのファイルが既に存在します。もう一度お試しください。";
  }
  if (m.includes("payload too large") || m.includes("exceeded the maximum")) {
    return "バケットのファイルサイズ上限を超えています。Supabase の Storage 設定を確認してください。";
  }
  if (m.includes("failed to fetch") || m.includes("networkerror")) {
    return "Supabase へ接続できませんでした。NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY を確認してください。";
  }
  return null;
}

type Stage =
  "queued" | "uploading" | "registering" | "ingesting" | "done" | "error";

type Item = {
  key: string;
  file: File;
  mime: string;
  title: string;
  stage: Stage;
  message?: string;
  hint?: string;
};

const STAGE_LABEL: Record<Stage, string> = {
  queued: "待機中",
  uploading: "アップロード中",
  registering: "登録中",
  ingesting: "取り込み中",
  done: "完了",
  error: "エラー",
};

/** 進捗は段階で表す（supabase-js の upload は進捗コールバックを持たないため） */
const STAGE_PERCENT: Record<Stage, number> = {
  queued: 4,
  uploading: 35,
  registering: 60,
  ingesting: 85,
  done: 100,
  error: 100,
};

export function UploadPanel({
  orgId,
  departments,
}: {
  orgId: string;
  departments: string[];
}) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);

  const [items, setItems] = useState<Item[]>([]);
  const [selectedDepts, setSelectedDepts] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);
  const [running, setRunning] = useState(false);
  const [globalError, setGlobalError] = useState<string | null>(null);

  function patch(key: string, next: Partial<Item>) {
    setItems((prev) =>
      prev.map((it) => (it.key === key ? { ...it, ...next } : it)),
    );
  }

  function addFiles(files: FileList | File[]) {
    setGlobalError(null);
    const incoming = Array.from(files);
    const next: Item[] = [];

    for (const file of incoming) {
      const mime = resolveMime(file);
      const key = `${file.name}-${file.size}-${file.lastModified}-${Math.random()
        .toString(36)
        .slice(2, 8)}`;

      if (!isSupportedMime(mime)) {
        next.push({
          key,
          file,
          mime,
          title: defaultTitle(file),
          stage: "error",
          message: "対応していない形式です",
          hint: "PDF / DOCX / Markdown / TXT のみ取り込めます。",
        });
        continue;
      }
      if (file.size > MAX_BYTES) {
        next.push({
          key,
          file,
          mime,
          title: defaultTitle(file),
          stage: "error",
          message: `サイズ上限（${formatBytes(MAX_BYTES)}）を超えています`,
          hint: `このファイルは ${formatBytes(file.size)} です。分割してからアップロードしてください。`,
        });
        continue;
      }

      next.push({
        key,
        file,
        mime,
        title: defaultTitle(file),
        stage: "queued",
      });
    }

    setItems((prev) => [...prev, ...next]);
  }

  function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer.files?.length) addFiles(e.dataTransfer.files);
  }

  function onPick(e: ChangeEvent<HTMLInputElement>) {
    if (e.target.files?.length) addFiles(e.target.files);
    // 同じファイルを選び直せるように値をリセットする
    e.target.value = "";
  }

  function toggleDept(dept: string) {
    setSelectedDepts((prev) =>
      prev.includes(dept) ? prev.filter((d) => d !== dept) : [...prev, dept],
    );
  }

  /** 1ファイル分の アップロード → 行作成 → 取り込み開始 */
  async function processOne(
    item: Item,
    supabase: ReturnType<typeof createClient>,
  ) {
    const path = `${orgId}/${crypto.randomUUID()}.${fileExtension(item.file)}`;

    patch(item.key, {
      stage: "uploading",
      message: undefined,
      hint: undefined,
    });

    const { error: uploadError } = await supabase.storage
      .from(BUCKET)
      .upload(path, item.file, { contentType: item.mime, upsert: false });

    if (uploadError) {
      patch(item.key, {
        stage: "error",
        message: `アップロードに失敗しました: ${uploadError.message}`,
        hint: diagnose(uploadError.message) ?? undefined,
      });
      return;
    }

    patch(item.key, { stage: "registering" });

    const created = await createDocumentRecord({
      filePath: path,
      title: item.title.trim() || defaultTitle(item.file),
      mimeType: item.mime,
      byteSize: item.file.size,
      allowedDepartments: selectedDepts,
    });

    if (!created.ok) {
      // DB に行が作れなかったのに Storage にファイルだけ残ると、
      // 誰も参照しない孤児ファイルになる。ここで巻き戻しておく。
      await supabase.storage.from(BUCKET).remove([path]);
      patch(item.key, {
        stage: "error",
        message: created.error,
        hint: diagnose(created.error) ?? undefined,
      });
      return;
    }

    patch(item.key, { stage: "ingesting" });

    try {
      const res = await fetch("/api/documents/ingest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ documentId: created.data.documentId }),
      });

      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        patch(item.key, {
          stage: "error",
          message: `取り込みに失敗しました: ${body?.error ?? `HTTP ${res.status}`}`,
          hint: "ファイルは保存済みです。一覧の「再取り込み」からやり直せます。",
        });
        return;
      }
    } catch (e) {
      patch(item.key, {
        stage: "error",
        message: `取り込みの呼び出しに失敗しました: ${
          e instanceof Error ? e.message : String(e)
        }`,
        hint: "ファイルは保存済みです。一覧の「再取り込み」からやり直せます。",
      });
      return;
    }

    patch(item.key, { stage: "done", message: "取り込みまで完了しました" });
  }

  async function start() {
    const targets = items.filter((it) => it.stage === "queued");
    if (!targets.length) return;

    setRunning(true);
    setGlobalError(null);

    let supabase: ReturnType<typeof createClient>;
    try {
      supabase = createClient();
    } catch (e) {
      // 環境変数が無いとここで落ちる。原因が分かるよう画面に出す
      setGlobalError(
        `Supabase クライアントを初期化できませんでした: ${
          e instanceof Error ? e.message : String(e)
        }（NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY を確認してください）`,
      );
      setRunning(false);
      return;
    }

    // 埋め込みAPIのレート制限に当てないよう、あえて直列で処理する
    for (const item of targets) {
      await processOne(item, supabase);
    }

    setRunning(false);
    router.refresh();
  }

  const queuedCount = items.filter((it) => it.stage === "queued").length;

  return (
    <Card>
      <CardHeader
        title="ドキュメントを追加"
        description="アップロードすると、階層見出しを保ったままチャンク分割し、ベクトル化まで自動で行います。"
        action={
          items.length > 0 ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setItems([])}
              disabled={running}
            >
              一覧をクリア
            </Button>
          ) : undefined
        }
      />

      <div className="space-y-4 p-5">
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          onClick={() => inputRef.current?.click()}
          className={cn(
            "flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed px-6 py-10 text-center transition-colors",
            dragging
              ? "border-brand-500 bg-brand-50"
              : "border-ink-300 bg-ink-50 hover:border-brand-500 hover:bg-brand-50",
          )}
        >
          <Upload className="size-6 text-ink-400" aria-hidden />
          <p className="mt-2 text-sm font-medium text-ink-700">
            ここにファイルをドロップ、またはクリックして選択
          </p>
          <p className="mt-1 text-xs text-ink-500">
            PDF / DOCX / Markdown / TXT・1ファイル {formatBytes(MAX_BYTES)}{" "}
            まで・複数選択できます
          </p>
          <input
            ref={inputRef}
            type="file"
            multiple
            accept={ACCEPT}
            onChange={onPick}
            className="hidden"
          />
        </div>

        <div>
          <p className="text-xs font-medium text-ink-600">公開部署</p>
          <p className="mt-0.5 text-xs text-ink-400">
            何も選ばない場合は
            <span className="font-medium text-ink-600">全社公開</span>
            になります。選んだ部署のメンバーだけが検索結果・回答の根拠として参照できます（RLS
            で制御）。
          </p>
          {departments.length === 0 ? (
            <p className="mt-2 text-xs text-ink-400">
              登録済みの部署がまだありません（全社公開として登録されます）。
            </p>
          ) : (
            <div className="mt-2 flex flex-wrap gap-2">
              {departments.map((d) => {
                const checked = selectedDepts.includes(d);
                return (
                  <label
                    key={d}
                    className={cn(
                      "inline-flex cursor-pointer items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs transition-colors",
                      checked
                        ? "border-brand-500 bg-brand-50 text-brand-700"
                        : "border-ink-300 bg-white text-ink-600 hover:bg-ink-100",
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleDept(d)}
                      className="size-3.5 accent-brand-600"
                    />
                    {d}
                  </label>
                );
              })}
            </div>
          )}
        </div>

        {items.length > 0 && (
          <ul className="space-y-2">
            {items.map((item) => (
              <li
                key={item.key}
                className="rounded-lg border border-ink-200 bg-white p-3"
              >
                <div className="flex items-start gap-3">
                  <FileText
                    className="mt-1 size-4 shrink-0 text-ink-400"
                    aria-hidden
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate text-xs text-ink-500">
                        {item.file.name}
                      </span>
                      <span className="text-xs text-ink-400">
                        {formatBytes(item.file.size)}
                      </span>
                      <StageBadge stage={item.stage} />
                    </div>

                    {/* タイトルは検索結果と出典表示に出るので、送信前に直せるようにする */}
                    <Input
                      value={item.title}
                      disabled={
                        item.stage !== "queued" && item.stage !== "error"
                      }
                      onChange={(e) =>
                        patch(item.key, { title: e.target.value })
                      }
                      className="mt-2 h-8 text-xs"
                      aria-label="ドキュメントのタイトル"
                    />

                    <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-ink-100">
                      <div
                        className={cn(
                          "h-full rounded-full transition-all duration-300",
                          item.stage === "error"
                            ? "bg-danger-600"
                            : item.stage === "done"
                              ? "bg-ok-600"
                              : "bg-brand-500",
                        )}
                        style={{ width: `${STAGE_PERCENT[item.stage]}%` }}
                      />
                    </div>

                    {item.message && (
                      <p
                        className={cn(
                          "mt-1.5 text-xs",
                          item.stage === "error"
                            ? "text-danger-600"
                            : "text-ok-600",
                        )}
                      >
                        {item.message}
                      </p>
                    )}
                    {item.hint && (
                      <p className="mt-1 text-xs text-ink-500">{item.hint}</p>
                    )}
                  </div>

                  <button
                    type="button"
                    aria-label="この行を取り消す"
                    disabled={running}
                    onClick={() =>
                      setItems((prev) =>
                        prev.filter((it) => it.key !== item.key),
                      )
                    }
                    className="rounded-md p-1 text-ink-400 transition-colors hover:bg-ink-100 hover:text-ink-600 disabled:opacity-40"
                  >
                    <X className="size-4" aria-hidden />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}

        {globalError && (
          <p className="flex items-start gap-2 rounded-lg bg-danger-50 px-3 py-2 text-xs text-danger-600">
            <CircleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            {globalError}
          </p>
        )}

        <div className="flex items-center justify-between gap-3">
          <p className="text-xs text-ink-400">
            取り込みは
            埋め込み生成まで行うため、1ファイルあたり数十秒かかることがあります。
          </p>
          <Button onClick={start} disabled={running || queuedCount === 0}>
            {running ? (
              <>
                <LoaderCircle className="size-4 animate-spin" aria-hidden />
                処理中…
              </>
            ) : (
              `${queuedCount}件を取り込む`
            )}
          </Button>
        </div>
      </div>
    </Card>
  );
}

function StageBadge({ stage }: { stage: Stage }) {
  if (stage === "done") {
    return (
      <Badge tone="ok">
        <CircleCheckBig className="mr-1 size-3" aria-hidden />
        {STAGE_LABEL[stage]}
      </Badge>
    );
  }
  if (stage === "error") {
    return (
      <Badge tone="danger">
        <CircleAlert className="mr-1 size-3" aria-hidden />
        {STAGE_LABEL[stage]}
      </Badge>
    );
  }
  if (stage === "queued") {
    return <Badge tone="neutral">{STAGE_LABEL[stage]}</Badge>;
  }
  return (
    <Badge tone="brand">
      <LoaderCircle className="mr-1 size-3 animate-spin" aria-hidden />
      {STAGE_LABEL[stage]}
    </Badge>
  );
}
