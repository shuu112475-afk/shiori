import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from "react";
import { cn } from "@/lib/utils";

/** 全画面で共有するUIプリミティブ。各画面はここを使い、独自にボタンを作らないこと。 */

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md";
};

export function Button({
  className,
  variant = "primary",
  size = "md",
  ...props
}: ButtonProps) {
  return (
    <button
      className={cn(
        "inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition-colors",
        "disabled:cursor-not-allowed disabled:opacity-50",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600",
        size === "sm" ? "h-8 px-3 text-xs" : "h-10 px-4 text-sm",
        variant === "primary" && "bg-brand-600 text-white hover:bg-brand-700",
        variant === "secondary" &&
          "border border-ink-300 bg-white text-ink-700 hover:bg-ink-100",
        variant === "ghost" && "text-ink-600 hover:bg-ink-100",
        variant === "danger" && "bg-danger-600 text-white hover:brightness-110",
        className,
      )}
      {...props}
    />
  );
}

export function Input({
  className,
  ...props
}: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        "h-10 w-full rounded-lg border border-ink-300 bg-white px-3 text-sm",
        "placeholder:text-ink-400",
        "focus:border-brand-500 focus:outline-2 focus:outline-offset-0 focus:outline-brand-200",
        className,
      )}
      {...props}
    />
  );
}

export function Textarea({
  className,
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={cn(
        "w-full rounded-lg border border-ink-300 bg-white p-3 text-sm",
        "placeholder:text-ink-400",
        "focus:border-brand-500 focus:outline-2 focus:outline-offset-0 focus:outline-brand-200",
        className,
      )}
      {...props}
    />
  );
}

export function Select({
  className,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cn(
        "h-10 rounded-lg border border-ink-300 bg-white px-3 text-sm",
        "focus:border-brand-500 focus:outline-2 focus:outline-brand-200",
        className,
      )}
      {...props}
    />
  );
}

export function Card({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "rounded-xl border border-ink-200 bg-white shadow-sm",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function CardHeader({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-ink-200 px-5 py-4">
      <div>
        <h2 className="text-sm font-semibold text-ink-900">{title}</h2>
        {description && (
          <p className="mt-0.5 text-xs text-ink-500">{description}</p>
        )}
      </div>
      {action}
    </div>
  );
}

type Tone = "neutral" | "ok" | "warn" | "danger" | "brand";

export function Badge({
  children,
  tone = "neutral",
  className,
}: {
  children: ReactNode;
  tone?: Tone;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium",
        tone === "neutral" && "bg-ink-100 text-ink-600",
        tone === "ok" && "bg-ok-50 text-ok-600",
        tone === "warn" && "bg-warn-50 text-warn-600",
        tone === "danger" && "bg-danger-50 text-danger-600",
        tone === "brand" && "bg-brand-50 text-brand-700",
        className,
      )}
    >
      {children}
    </span>
  );
}

export function EmptyState({
  title,
  description,
}: {
  title: string;
  description?: string;
}) {
  return (
    <div className="px-5 py-12 text-center">
      <p className="text-sm font-medium text-ink-600">{title}</p>
      {description && (
        <p className="mt-1 text-xs text-ink-400">{description}</p>
      )}
    </div>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      role="status"
      aria-label="読み込み中"
      className={cn(
        "inline-block size-4 animate-spin rounded-full border-2 border-ink-300 border-t-brand-600",
        className,
      )}
    />
  );
}
