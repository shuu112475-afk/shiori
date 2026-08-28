import { Badge } from "@/components/ui";
import type { DocStatus } from "@/lib/types";

/** doc_status(enum) と表示の対応。SQL 側の enum とここが唯一の対応表になる */
const STATUS_MAP: Record<
  DocStatus,
  { label: string; tone: "neutral" | "brand" | "ok" | "danger" }
> = {
  pending: { label: "待機中", tone: "neutral" },
  processing: { label: "処理中", tone: "brand" },
  ready: { label: "利用可", tone: "ok" },
  failed: { label: "失敗", tone: "danger" },
};

export function DocStatusBadge({ status }: { status: DocStatus }) {
  const s = STATUS_MAP[status] ?? STATUS_MAP.pending;
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

/** MIME をそのまま出すと業務担当者には読めないので短い表記に落とす */
export function mimeLabel(mime: string): string {
  switch (mime) {
    case "application/pdf":
      return "PDF";
    case "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
      return "Word";
    case "text/markdown":
      return "Markdown";
    case "text/plain":
      return "テキスト";
    default:
      return mime;
  }
}
