import type { ReactNode } from "react";
import type { SessionUser } from "@/lib/auth";
import { NavBar } from "@/components/NavBar";

/**
 * ログイン後の全画面で共通の骨格。
 * main に min-h-0 を付けるのは、チャット画面が内部に独自のスクロール領域を持つため
 * （flex アイテムの既定 min-height:auto のままだと子が縮まずページ全体が伸びてしまう）。
 * padding は画面ごとに事情が違うのでここでは付けない。
 */
export function AppShell({
  user,
  children,
}: {
  user: SessionUser;
  children: ReactNode;
}) {
  return (
    <>
      <NavBar user={user} />
      <main className="flex-1 min-h-0">{children}</main>
    </>
  );
}
