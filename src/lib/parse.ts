import type { ParsedBlock } from "./chunking";

/**
 * アップロードされたファイルを ParsedBlock[] に変換する。
 * PDF はページ単位でブロックを分けるので、チャンクにページ番号を持たせられる。
 */

export type ParseResult = {
  blocks: ParsedBlock[];
  pageCount: number | null;
};

export class UnsupportedFileTypeError extends Error {
  constructor(mime: string) {
    super(`対応していないファイル形式です: ${mime}`);
    this.name = "UnsupportedFileTypeError";
  }
}

export const SUPPORTED_MIME_TYPES = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document", // .docx
  "text/markdown",
  "text/plain",
] as const;

export function isSupportedMime(mime: string): boolean {
  return (SUPPORTED_MIME_TYPES as readonly string[]).includes(mime);
}

async function parsePdf(buffer: ArrayBuffer): Promise<ParseResult> {
  const { extractText, getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  // mergePages: false でページごとの配列を受け取る
  const { text, totalPages } = await extractText(pdf, { mergePages: false });

  const pages = Array.isArray(text) ? text : [text];
  const blocks = pages
    .map((t, i) => ({ text: t ?? "", page: i + 1 }))
    .filter((b) => b.text.trim().length > 0);

  return { blocks, pageCount: totalPages ?? pages.length };
}

async function parseDocx(buffer: ArrayBuffer): Promise<ParseResult> {
  const mammoth = (await import("mammoth")).default;
  // HTML 経由にすると <h1>〜<h3> が取れるので、見出しを Markdown に落として
  // chunking 側の階層検出に乗せる（.docx はページ概念がないので pageCount は null）
  const { value: html } = await mammoth.convertToHtml({
    buffer: Buffer.from(buffer),
  });

  const text = html
    .replace(/<h1[^>]*>(.*?)<\/h1>/gis, "\n# $1\n")
    .replace(/<h2[^>]*>(.*?)<\/h2>/gis, "\n## $1\n")
    .replace(/<h3[^>]*>(.*?)<\/h3>/gis, "\n### $1\n")
    .replace(/<h4[^>]*>(.*?)<\/h4>/gis, "\n#### $1\n")
    .replace(/<li[^>]*>(.*?)<\/li>/gis, "$1\n")
    .replace(/<\/(p|div|tr|table|ul|ol)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");

  return { blocks: [{ text }], pageCount: null };
}

export async function parseFile(
  buffer: ArrayBuffer,
  mimeType: string,
): Promise<ParseResult> {
  switch (mimeType) {
    case "application/pdf":
      return parsePdf(buffer);
    case "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
      return parseDocx(buffer);
    case "text/markdown":
    case "text/plain":
      return {
        blocks: [{ text: new TextDecoder("utf-8").decode(buffer) }],
        pageCount: null,
      };
    default:
      throw new UnsupportedFileTypeError(mimeType);
  }
}
