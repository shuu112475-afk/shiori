import OpenAI from "openai";

export const EMBEDDING_MODEL = "text-embedding-3-small";
export const EMBEDDING_DIMENSIONS = 1536;

/** 1リクエストあたりの入力数。大きすぎるとトークン上限に当たる */
const BATCH_SIZE = 96;

let _client: OpenAI | null = null;
function client(): OpenAI {
  if (!_client) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("OPENAI_API_KEY is not set");
    _client = new OpenAI({ apiKey });
  }
  return _client;
}

/** 空文字は API がエラーにするので落としておく */
function sanitize(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length ? t : "(空)";
}

/** 検索クエリ1件を埋め込む */
export async function embedQuery(text: string): Promise<number[]> {
  const res = await client().embeddings.create({
    model: EMBEDDING_MODEL,
    input: sanitize(text),
  });
  return res.data[0].embedding;
}

/**
 * 複数テキストをバッチで埋め込む。
 * 取り込み時に数百チャンクを処理するので、順序を保ったまま分割送信する。
 */
export async function embedBatch(texts: string[]): Promise<number[][]> {
  const out: number[][] = [];

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE).map(sanitize);
    const res = await client().embeddings.create({
      model: EMBEDDING_MODEL,
      input: batch,
    });
    // index 順に並べ直してから積む（API は順序を保証するが念のため）
    const sorted = [...res.data].sort((a, b) => a.index - b.index);
    out.push(...sorted.map((d) => d.embedding));
  }

  return out;
}

/** pgvector のリテラル形式に変換する */
export function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}
