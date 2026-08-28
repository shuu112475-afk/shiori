import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("ja-JP", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatBytes(bytes: number | null): string {
  if (bytes == null) return "-";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

/**
 * Claude Sonnet の概算コスト（USD）。
 * 管理画面で「1質問あたりいくらか」を見せるために使う。
 */
const USD_PER_INPUT_TOKEN = 3 / 1_000_000;
const USD_PER_OUTPUT_TOKEN = 15 / 1_000_000;

export function estimateCostUsd(
  inputTokens: number | null,
  outputTokens: number | null,
): number {
  return (
    (inputTokens ?? 0) * USD_PER_INPUT_TOKEN +
    (outputTokens ?? 0) * USD_PER_OUTPUT_TOKEN
  );
}
