import { type ButtonHTMLAttributes, type KeyboardEvent as ReactKeyboardEvent, type PropsWithChildren, type ReactNode, useEffect, useRef } from "react";
import { AlertCircle, CheckCircle2, CloudOff, LoaderCircle, RefreshCw } from "lucide-react";
import { ApiError } from "../lib/api";

export function Button({ className = "", variant = "secondary", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "danger" | "quiet" }) {
  return <button className={`button button--${variant} ${className}`} {...props} />;
}

export function IconButton({ label, className = "", children, ...props }: PropsWithChildren<ButtonHTMLAttributes<HTMLButtonElement> & { label: string }>) {
  return <button className={`icon-button ${className}`} aria-label={label} title={label} {...props}>{children}</button>;
}

export function Toggle({ checked, onChange, disabled = false, label }: { checked: boolean; onChange(value: boolean): void; disabled?: boolean; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className="toggle"
      data-on={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    ><span /></button>
  );
}

export function Spinner({ label = "Loading" }: { label?: string }) {
  return <span className="spinner" role="status"><LoaderCircle aria-hidden="true" /><span className="sr-only">{label}</span></span>;
}

export function StatusDot({ status }: { status?: string }) {
  return <span className="status-dot" data-status={status ?? "unknown"} aria-hidden="true" />;
}

export function Modal({ labelledBy, describedBy, onClose, className = "", children }: PropsWithChildren<{ labelledBy: string; describedBy?: string; onClose?: () => void; className?: string }>) {
  const dialog = useRef<HTMLElement>(null);
  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusable = dialog.current?.querySelector<HTMLElement>("[autofocus], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href]");
    focusable?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus();
    };
  }, []);

  function keyDown(event: ReactKeyboardEvent<HTMLElement>) {
    if (event.key === "Escape" && onClose) {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = [...(dialog.current?.querySelectorAll<HTMLElement>("button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href]") ?? [])];
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }

  return <div className="modal-backdrop" onPointerDown={(event) => { if (event.target === event.currentTarget && onClose) onClose(); }}><section ref={dialog} className={`modal ${className}`} role="dialog" aria-modal="true" aria-labelledby={labelledBy} aria-describedby={describedBy} onKeyDown={keyDown}>{children}</section></div>;
}

export function PageLoading({ label = "Loading live data…" }: { label?: string }) {
  return <div className="state-view"><Spinner label={label} /><p>{label}</p></div>;
}

export function EmptyState({ icon, title, detail, action }: { icon?: ReactNode; title: string; detail: string; action?: ReactNode }) {
  return <div className="empty-state">{icon && <div className="empty-state__icon">{icon}</div>}<h2>{title}</h2><p>{detail}</p>{action}</div>;
}

export function ErrorState({ error, retry, title = "Continuum couldn’t load this view" }: { error: unknown; retry?(): void; title?: string }) {
  const detail = error instanceof ApiError
    ? error.status === 401 ? "Sign in to the configured Continuum service, or check the remote service URL in Settings." : error.message
    : error instanceof Error ? error.message : "An unexpected request error occurred.";
  return (
    <div className="empty-state empty-state--error" role="alert">
      {error instanceof ApiError && error.status === 0 ? <CloudOff aria-hidden="true" /> : <AlertCircle aria-hidden="true" />}
      <h2>{title}</h2><p>{detail}</p>
      {retry && <Button onClick={retry}><RefreshCw size={16} /> Try again</Button>}
    </div>
  );
}

export function SavedNotice({ visible }: { visible: boolean }) {
  if (!visible) return null;
  return <span className="saved-notice" role="status"><CheckCircle2 size={16} /> Saved</span>;
}

export function formatRelativeTime(value?: string): string {
  if (!value) return "Not yet";
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return value;
  const seconds = Math.round((time - Date.now()) / 1000);
  const absolute = Math.abs(seconds);
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (absolute < 60) return formatter.format(seconds, "second");
  if (absolute < 3_600) return formatter.format(Math.round(seconds / 60), "minute");
  if (absolute < 86_400) return formatter.format(Math.round(seconds / 3_600), "hour");
  return formatter.format(Math.round(seconds / 86_400), "day");
}

export function formatDateTime(value?: string): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}
