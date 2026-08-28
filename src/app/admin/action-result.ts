/**
 * 管理画面の Server Action 共通の戻り値。
 *
 * throw で返すとクライアントには本番ビルドでマスクされたメッセージしか届かず、
 * 「何が起きたのか分からない」画面になる。運用画面では原因が読めることが
 * 最優先なので、想定内の失敗は例外にせず値として返す。
 */
export type ActionResult<T = null> =
  { ok: true; data: T } | { ok: false; error: string };
