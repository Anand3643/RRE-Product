import { createContext, ReactNode, useCallback, useContext, useEffect, useState } from "react";
import { X, AlertCircle } from "lucide-react";
import { Portal, SuccessCheck } from "./fx";

// ---- toasts ----
type Toast = { id: number; text: string; kind: "ok" | "err"; leaving?: boolean };
const ToastCtx = createContext<(text: string, kind?: "ok" | "err") => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const dismiss = useCallback((id: number) => {
    setItems((x) => x.map((t) => (t.id === id ? { ...t, leaving: true } : t)));
    setTimeout(() => setItems((x) => x.filter((t) => t.id !== id)), 220); // let the exit animation finish
  }, []);
  const push = useCallback((text: string, kind: "ok" | "err" = "ok") => {
    const id = Date.now() + Math.random();
    setItems((x) => [...x.slice(-3), { id, text, kind }]);
    setTimeout(() => dismiss(id), kind === "err" ? 6000 : 4000);
  }, [dismiss]);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-[100] flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2" role="status" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`card pointer-events-auto flex items-start gap-2.5 border-l-4 p-3 text-[13px] shadow-[var(--shadow-3)] ${t.leaving ? "anim-toast-out" : "anim-toast"} ${t.kind === "ok" ? "border-l-emerald-500" : "border-l-red-500"}`}>
            {t.kind === "ok" ? <span className="-m-1 mt-[-2px] shrink-0"><SuccessCheck size={22} /></span> : <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-500" />}
            <span className="flex-1">{t.text}</span>
            <button className="rounded p-0.5 text-sub hover:bg-muted" onClick={() => dismiss(t.id)} aria-label="Dismiss"><X className="h-3.5 w-3.5" /></button>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

// ---- modal / confirm ----
export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", h); return () => window.removeEventListener("keydown", h);
  }, [onClose]);
  return (
    <Portal><div className="anim-fade fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 pt-[8vh] backdrop-blur-[1px]" onMouseDown={onClose}>
      <div role="dialog" aria-modal="true" aria-label={title} className={`card anim-pop w-full ${wide ? "max-w-2xl" : "max-w-md"} p-5 shadow-[var(--shadow-3)]`} style={{ transformOrigin: "top center" }} onMouseDown={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-semibold">{title}</h2>
          <button onClick={onClose} className="rounded p-1 hover:bg-muted" aria-label="Close"><X className="h-4 w-4" /></button>
        </div>
        {children}
      </div>
    </div></Portal>
  );
}

export function Confirm({ title, text, action, onConfirm, onClose }: { title: string; text: string; action: string; onConfirm: () => Promise<void> | void; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <Modal title={title} onClose={onClose}>
      <p className="mb-5 text-sm text-sub">{text}</p>
      <div className="flex justify-end gap-2">
        <button className="btn-ghost" onClick={onClose}>Cancel</button>
        <button className={`btn-danger ${busy ? "btn-loading" : ""}`} disabled={busy} autoFocus onClick={async () => { setBusy(true); try { await onConfirm(); } finally { setBusy(false); onClose(); } }}>{action}</button>
      </div>
    </Modal>
  );
}

export const Field = ({ label, children }: { label: string; children: ReactNode }) => (
  <div><label className="label">{label}</label>{children}</div>
);

export const Skeleton = ({ rows = 5 }: { rows?: number }) => (
  <div className="space-y-2 p-4" aria-busy="true" aria-label="Loading">{Array.from({ length: rows }).map((_, i) => <div key={i} className="skeleton h-9" style={{ opacity: 1 - i * 0.08 }} />)}</div>
);

/** Empty state: a small stacked-boxes illustration that settles in once (no looping animation). */
export const Empty = ({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }) => (
  <div className="flex flex-col items-center px-4 py-12 text-center">
    <svg width="84" height="72" viewBox="0 0 84 72" fill="none" aria-hidden>
      <ellipse cx="42" cy="64" rx="26" ry="4" fill="currentColor" className="anim-float text-line" style={{ ["--i" as any]: 0 }} />
      <g className="anim-float" style={{ ["--i" as any]: 1 }}><path d="M18 34l24-12 24 12v18L42 64 18 52V34z" fill="rgb(var(--muted))" stroke="rgb(var(--line))" strokeWidth="1.5" /><path d="M18 34l24 12 24-12M42 46v18" stroke="rgb(var(--line))" strokeWidth="1.5" /></g>
      <g className="anim-float" style={{ ["--i" as any]: 3 }}><rect x="30" y="8" width="24" height="16" rx="3" fill="rgb(var(--brand) / .14)" stroke="rgb(var(--brand))" strokeWidth="1.5" /><path d="M36 16h12" stroke="rgb(var(--brand))" strokeWidth="1.5" strokeLinecap="round" /></g>
    </svg>
    <p className="mt-3 font-medium">{title}</p>{hint && <p className="mt-1 max-w-sm text-[13px] text-sub">{hint}</p>}{action && <div className="mt-3">{action}</div>}
  </div>
);

/** Active/Archived indicator: the dot rings once when it first appears, then stays still. */
export const StatusDot = ({ active }: { active: boolean }) => (
  <span className="inline-flex items-center gap-1.5 text-[13px]"><span className="relative flex h-2 w-2">
    {active && <span className="absolute inline-flex h-full w-full animate-[ping_1s_ease-out_1] rounded-full bg-emerald-500 opacity-60" />}
    <span className={`relative inline-flex h-2 w-2 rounded-full transition-colors duration-300 ${active ? "bg-emerald-500" : "bg-slate-400"}`} /></span>{active ? "Active" : "Archived"}</span>
);

export const Badge = ({ tone, children }: { tone: "ok" | "warn" | "bad" | "neutral" | "info"; children: ReactNode }) => {
  const c = { info: "bg-sky-500/15 text-sky-700 dark:text-sky-400", ok: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400", warn: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
    bad: "bg-red-500/15 text-red-600 dark:text-red-400", neutral: "bg-muted text-sub" }[tone];
  return <span className={`badge ${c}`}>{children}</span>;
};

// ---- async data hook ----
export function useLoad<T>(fn: () => Promise<T>, deps: any[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true; setLoading(true);
    fn().then((d) => live && (setData(d), setError(""))).catch((e) => live && setError(e.message)).finally(() => live && setLoading(false));
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  // the assistant (or any global action) can ask every mounted screen to refetch
  useEffect(() => { const h = () => setTick((t) => t + 1); window.addEventListener("sp-data-changed", h); return () => window.removeEventListener("sp-data-changed", h); }, []);
  return { data, error, loading, reload: () => setTick((t) => t + 1) };
}
