"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { SessionUser } from "@/lib/auth";
import { Badge, Button } from "@/components/ui";
import { cn } from "@/lib/utils";

type NavLink = { href: string; label: string };

const MEMBER_LINKS: NavLink[] = [{ href: "/chat", label: "チャット" }];

const ADMIN_LINKS: NavLink[] = [
  { href: "/admin/documents", label: "ドキュメント" },
  { href: "/admin/unanswered", label: "未回答" },
  { href: "/admin/feedback", label: "評価" },
  { href: "/admin/logs", label: "利用ログ" },
  { href: "/admin/members", label: "メンバー" },
  { href: "/admin/audit", label: "監査ログ" },
];

/**
 * /admin/documents/xxx のような詳細ページでも親リンクを点灯させたいので前方一致で判定する。
 * ただし /admin/logs と /admin/logsomething を取り違えないよう、区切りは "/" に限定する。
 */
function isActive(pathname: string, href: string) {
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function NavBar({ user }: { user: SessionUser }) {
  const pathname = usePathname();
  const isAdmin = user.profile.role === "admin";
  const links = isAdmin ? [...MEMBER_LINKS, ...ADMIN_LINKS] : MEMBER_LINKS;

  return (
    <header className="sticky top-0 z-20 shrink-0 border-b border-ink-200 bg-white">
      <div className="flex h-14 items-center gap-4 px-4">
        <Link
          href="/chat"
          className="flex shrink-0 items-center gap-2 rounded-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600"
        >
          <span
            aria-hidden
            className="flex size-7 items-center justify-center rounded-md bg-brand-600 text-sm font-bold text-white"
          >
            S
          </span>
          <span className="text-sm font-semibold tracking-tight text-ink-900">
            Shiori
          </span>
        </Link>

        {/* 管理者は7リンクになり狭い画面で溢れるので、ハンバーガーではなく横スクロールで逃がす */}
        <nav className="min-w-0 flex-1 overflow-x-auto">
          <ul className="flex items-center gap-1">
            {links.map((link) => {
              const active = isActive(pathname, link.href);
              return (
                <li key={link.href}>
                  <Link
                    href={link.href}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "block whitespace-nowrap rounded-lg px-3 py-1.5 text-sm font-medium transition-colors",
                      "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600",
                      active
                        ? "bg-brand-50 text-brand-700"
                        : "text-ink-600 hover:bg-ink-100 hover:text-ink-900",
                    )}
                  >
                    {link.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>

        <div className="flex shrink-0 items-center gap-2">
          <span className="hidden max-w-40 truncate text-sm text-ink-700 sm:block">
            {user.profile.display_name ?? user.email}
          </span>
          <span className="hidden md:inline-flex">
            <Badge tone="neutral">{user.profile.department}</Badge>
          </span>
          {isAdmin && <Badge tone="brand">管理者</Badge>}
          <form action="/auth/signout" method="post">
            <Button variant="ghost" size="sm">
              ログアウト
            </Button>
          </form>
        </div>
      </div>
    </header>
  );
}
