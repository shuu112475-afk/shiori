import { getEncoding, type Tiktoken } from "js-tiktoken";

/**
 * 階層チャンキング。
 *
 * 見出し構造を保持したまま本文を分割し、各チャンクに
 * 「就業規則 > 第4章 休暇 > 第22条 年次有給休暇」形式の heading_path を付ける。
 *
 * これが精度の肝になる理由:
 *   1. 回答時に条番号まで示せるので、利用者が原典を検証できる
 *   2. heading_path を検索対象に含めるため、見出し語での検索が当たる
 *   3. 章をまたいだ分割が起きないので、文脈が混ざらない
 */

export type ParsedBlock = {
  text: string;
  /** PDF の場合のページ番号（1始まり） */
  page?: number;
};

export type Chunk = {
  index: number;
  content: string;
  headingPath: string | null;
  pageNo: number | null;
  tokenCount: number;
};

export type ChunkOptions = {
  /** チャンクの目標上限トークン数 */
  maxTokens?: number;
  /** これ未満のチャンクは前後に結合する */
  minTokens?: number;
  /** 前チャンク末尾から引き継ぐトークン数 */
  overlapTokens?: number;
  /** 文書タイトル（heading_path の先頭に置く） */
  rootTitle?: string;
};

let _enc: Tiktoken | null = null;
function enc(): Tiktoken {
  // text-embedding-3-small / GPT系と同じ cl100k_base。初回のみロードして使い回す
  if (!_enc) _enc = getEncoding("cl100k_base");
  return _enc;
}

export function countTokens(text: string): number {
  return enc().encode(text).length;
}

type Heading = { level: number; text: string };

const HEADING_RULES: {
  re: RegExp;
  level: number | "markdown" | "numbered";
  /** これを超える長さなら本文とみなす */
  maxLen: number;
}[] = [
  { re: /^(#{1,6})\s+(.+?)\s*$/, level: "markdown", maxLen: Infinity },
  {
    re: /^(第[0-9０-９一二三四五六七八九十百千]+編\s*.*)$/,
    level: 1,
    maxLen: 60,
  },
  {
    re: /^(第[0-9０-９一二三四五六七八九十百千]+章\s*.*)$/,
    level: 2,
    maxLen: 60,
  },
  {
    re: /^(第[0-9０-９一二三四五六七八九十百千]+節\s*.*)$/,
    level: 3,
    maxLen: 60,
  },
  {
    re: /^(第[0-9０-９一二三四五六七八九十百千]+条(?:の[0-9０-９]+)?\s*.*)$/,
    level: 4,
    maxLen: 60,
  },
  // 「1.1 概要」のような番号見出しだけを拾う。
  // 「1. 会社は〜を付与する。」という箇条書き本文を拾うと heading_path が壊れるため厳しめ。
  { re: /^([0-9]+(?:\.[0-9]+)*\.?\s+\S.*)$/, level: "numbered", maxLen: 30 },
  { re: /^([■●◆▼]\s*\S.*)$/, level: 3, maxLen: 40 },
];

/**
 * 見出し行なら Heading を返す。本文行なら null。
 *
 * 誤検出は致命的。本文を見出しと誤ると、その行が heading_path の祖先として積まれ、
 * 本来の「第4章 休暇 > 第22条 年次有給休暇」がスタックから押し出されてしまう。
 * そのため「短い」「文末の句読点で終わらない」を必須条件にしている。
 */
function detectHeading(line: string): Heading | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  for (const rule of HEADING_RULES) {
    const m = trimmed.match(rule.re);
    if (!m) continue;

    if (rule.level === "markdown") {
      return { level: m[1].length, text: m[2].trim() };
    }

    if (trimmed.length > rule.maxLen) return null;
    // 句読点で終わる行は文章＝本文
    if (/[。．、，,；;]$/.test(trimmed)) return null;

    if (rule.level === "numbered") {
      const depth = (m[1].match(/\./g) ?? []).length;
      return { level: Math.min(depth + 1, 6), text: trimmed };
    }
    return { level: rule.level, text: trimmed };
  }
  return null;
}

/** PDF由来のノイズを落とす */
function isNoiseLine(line: string): boolean {
  const t = line.trim();
  if (!t) return true;
  if (/^[-—ー–\s]+$/.test(t)) return true;
  // 「12」「- 12 -」「Page 12」のようなページ番号だけの行
  if (/^(?:[-–—]\s*)?(?:page\s*)?[0-9０-９]{1,4}(?:\s*[-–—])?$/i.test(t))
    return true;
  return false;
}

function normalize(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t　]+/g, " ")
    .replace(/\n{3,}/g, "\n\n");
}

/** 日本語・英語どちらでも文末で切る */
function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[。．！？!?])\s*|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function buildPath(stack: Heading[], rootTitle?: string): string | null {
  const parts = [rootTitle, ...stack.map((h) => h.text)].filter(
    Boolean,
  ) as string[];
  return parts.length ? parts.join(" > ") : null;
}

export function chunkDocument(
  blocks: ParsedBlock[],
  options: ChunkOptions = {},
): Chunk[] {
  const {
    maxTokens = 700,
    minTokens = 80,
    overlapTokens = 100,
    rootTitle,
  } = options;

  type Section = {
    headingPath: string | null;
    pageNo: number | null;
    body: string[];
  };

  const sections: Section[] = [];
  const stack: Heading[] = [];
  let current: Section = {
    headingPath: buildPath(stack, rootTitle),
    pageNo: null,
    body: [],
  };

  for (const block of blocks) {
    for (const rawLine of normalize(block.text).split("\n")) {
      if (isNoiseLine(rawLine)) continue;

      const heading = detectHeading(rawLine);
      if (heading) {
        if (current.body.length) sections.push(current);
        // 同レベル以下を捨てて積み直す
        while (stack.length && stack[stack.length - 1].level >= heading.level)
          stack.pop();
        stack.push(heading);
        current = {
          headingPath: buildPath(stack, rootTitle),
          pageNo: block.page ?? null,
          body: [],
        };
        continue;
      }

      if (current.pageNo == null) current.pageNo = block.page ?? null;
      current.body.push(rawLine.trim());
    }
  }
  if (current.body.length) sections.push(current);

  // セクション本文を maxTokens 以内に切り、オーバーラップを付ける
  const chunks: Chunk[] = [];
  let index = 0;

  for (const section of sections) {
    const sentences = splitSentences(section.body.join("\n"));
    if (!sentences.length) continue;

    let buf: string[] = [];
    let bufTokens = 0;

    const flush = () => {
      if (!buf.length) return;
      const content = buf.join(" ").trim();
      if (!content) return;

      const tokenCount = countTokens(content);
      const prev = chunks[chunks.length - 1];

      // 短すぎるチャンクは同じ見出しの直前チャンクに吸収させる
      if (
        tokenCount < minTokens &&
        prev &&
        prev.headingPath === section.headingPath
      ) {
        prev.content = `${prev.content} ${content}`.trim();
        prev.tokenCount = countTokens(prev.content);
      } else {
        chunks.push({
          index: index++,
          content,
          headingPath: section.headingPath,
          pageNo: section.pageNo,
          tokenCount,
        });
      }
      buf = [];
      bufTokens = 0;
    };

    for (const sentence of sentences) {
      const t = countTokens(sentence);

      // 1文で上限を超える場合はトークン単位で強制分割する
      if (t > maxTokens) {
        flush();
        const ids = enc().encode(sentence);
        for (let i = 0; i < ids.length; i += maxTokens) {
          const piece = enc().decode(ids.slice(i, i + maxTokens));
          chunks.push({
            index: index++,
            content: piece.trim(),
            headingPath: section.headingPath,
            pageNo: section.pageNo,
            tokenCount: Math.min(maxTokens, ids.length - i),
          });
        }
        continue;
      }

      if (bufTokens + t > maxTokens) {
        const carry: string[] = [];
        let carryTokens = 0;
        // 末尾から overlapTokens 分だけ次チャンクへ引き継ぐ
        for (
          let i = buf.length - 1;
          i >= 0 && carryTokens < overlapTokens;
          i--
        ) {
          carry.unshift(buf[i]);
          carryTokens += countTokens(buf[i]);
        }
        flush();
        buf = [...carry];
        bufTokens = carryTokens;
      }

      buf.push(sentence);
      bufTokens += t;
    }
    flush();
  }

  // 表紙のタイトル行など、見出しをなぞっただけの中身のないチャンクを落とす
  const meaningful = chunks.filter((c) => {
    const body = c.content.replace(/\s/g, "");
    if (!body) return false;
    const segments = (c.headingPath ?? "")
      .split(" > ")
      .map((s) => s.replace(/\s/g, ""));
    return !(c.tokenCount < 20 && segments.includes(body));
  });

  return meaningful.map((c, i) => ({ ...c, index: i }));
}
