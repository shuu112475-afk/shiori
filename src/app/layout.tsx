import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Shiori — 社内ナレッジ検索",
  description: "社内規程・マニュアルを出典付きで答えるAIアシスタント",
};

// フォントは globals.css の --font-sans（日本語フォントスタック）に任せる。
// next/font/google の Geist は日本語グリフを持たず、和文だけフォールバックして
// 字面がちぐはぐになるため読み込まない。
export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="ja" className="h-full antialiased">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
