"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ShieldCheck } from "lucide-react";
import {
  Badge,
  Button,
  Card,
  CardHeader,
  Input,
  Select,
} from "@/components/ui";
import { DataTable, type Column } from "@/components/admin/DataTable";
import { updateMember } from "@/app/admin/members/actions";
import { formatDateTime } from "@/lib/utils";
import type { MemberRole } from "@/lib/types";

export type MemberItem = {
  id: string;
  displayName: string;
  email: string;
  department: string;
  role: MemberRole;
  createdAt: string;
};

/**
 * 部署と権限をその場で編集する。
 * 部署は documents.allowed_departments と文字列一致で突き合わされるため、
 * 表記ゆれがそのままアクセス制御の穴になる。既存の部署名を datalist で候補に出して揃えやすくする。
 */
export function MemberEditor({
  members,
  currentUserId,
  departments,
}: {
  members: MemberItem[];
  currentUserId: string;
  departments: string[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [drafts, setDrafts] = useState<
    Record<string, { department: string; role: MemberRole }>
  >({});
  const [error, setError] = useState<{ id: string; message: string } | null>(
    null,
  );
  const [savedId, setSavedId] = useState<string | null>(null);

  function draftOf(member: MemberItem) {
    return (
      drafts[member.id] ?? {
        department: member.department,
        role: member.role,
      }
    );
  }

  function setDraft(
    member: MemberItem,
    patch: Partial<{ department: string; role: MemberRole }>,
  ) {
    setDrafts((prev) => ({
      ...prev,
      [member.id]: { ...draftOf(member), ...patch },
    }));
    setSavedId(null);
  }

  function isDirty(member: MemberItem) {
    const d = draftOf(member);
    return d.department !== member.department || d.role !== member.role;
  }

  function save(member: MemberItem) {
    const d = draftOf(member);
    setError(null);
    startTransition(async () => {
      const result = await updateMember({
        userId: member.id,
        department: d.department,
        role: d.role,
      });
      if (!result.ok) {
        setError({ id: member.id, message: result.error });
        return;
      }
      setSavedId(member.id);
      setDrafts((prev) => {
        const next = { ...prev };
        delete next[member.id];
        return next;
      });
      router.refresh();
    });
  }

  const columns: Column<MemberItem>[] = [
    {
      key: "name",
      header: "表示名",
      cell: (m) => (
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 font-medium text-ink-900">
            {m.displayName}
            {m.id === currentUserId && <Badge tone="brand">自分</Badge>}
          </p>
          <p className="mt-0.5 truncate text-xs text-ink-400">{m.email}</p>
        </div>
      ),
    },
    {
      key: "department",
      header: "部署",
      cell: (m) => (
        <Input
          value={draftOf(m).department}
          onChange={(e) => setDraft(m, { department: e.target.value })}
          list="shiori-departments"
          aria-label={`${m.displayName} の部署`}
          className="h-8 w-40 text-xs"
        />
      ),
    },
    {
      key: "role",
      header: "権限",
      cell: (m) => {
        const isSelf = m.id === currentUserId;
        return (
          <div className="flex flex-col gap-1">
            <Select
              value={draftOf(m).role}
              disabled={isSelf}
              onChange={(e) =>
                setDraft(m, { role: e.target.value as MemberRole })
              }
              aria-label={`${m.displayName} の権限`}
              className="h-8 w-28 text-xs"
            >
              <option value="member">メンバー</option>
              <option value="admin">管理者</option>
            </Select>
            {isSelf && (
              <span className="flex items-center gap-1 text-xs text-ink-400">
                <ShieldCheck className="size-3" aria-hidden />
                自分の権限は変更不可
              </span>
            )}
          </div>
        );
      },
    },
    {
      key: "createdAt",
      header: "登録日",
      cell: (m) => (
        <span className="text-xs whitespace-nowrap text-ink-500">
          {formatDateTime(m.createdAt)}
        </span>
      ),
    },
    {
      key: "actions",
      header: "",
      align: "right",
      cell: (m) => (
        <div className="flex flex-col items-end gap-1">
          <Button
            size="sm"
            variant="secondary"
            disabled={pending || !isDirty(m)}
            onClick={() => save(m)}
          >
            {pending && isDirty(m) ? "保存中…" : "保存"}
          </Button>
          {savedId === m.id && (
            <span className="text-xs text-ok-600">保存しました</span>
          )}
          {error?.id === m.id && (
            <span className="max-w-64 text-right text-xs text-danger-600">
              {error.message}
            </span>
          )}
        </div>
      ),
    },
  ];

  return (
    <Card>
      <CardHeader
        title={`メンバー（${members.length}名）`}
        description="部署はドキュメントの公開範囲（RLS）に直結します。権限を変えると次回アクセスから反映されます。"
      />
      {/* 部署名の表記ゆれを防ぐための入力候補 */}
      <datalist id="shiori-departments">
        {departments.map((d) => (
          <option key={d} value={d} />
        ))}
      </datalist>
      <DataTable
        columns={columns}
        rows={members}
        rowKey={(m) => m.id}
        emptyTitle="メンバーがいません"
      />
    </Card>
  );
}
