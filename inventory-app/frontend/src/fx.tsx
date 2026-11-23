// Motion + interaction primitives. Everything here is a no-op for users who prefer reduced motion
// (CSS handles animations; JS-driven ones check useReducedMotion).
import { ReactNode, RefObject, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown } from "lucide-react";

/** Renders overlays on document.body so parent spacing/transform rules can never offset or clip them. */
export const Portal = ({ children }: { children: ReactNode }) => createPortal(children, document.body);

export const reducedMotion = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/** Animates from the previous value to the new one (and from 0 on first appearance). */
export function useCountUp(value: number, duration = 650) {
  const [shown, setShown] = useState(reducedMotion() ? value : 0);
  const cur = useRef(reducedMotion() ? value : 0); // what is on screen right now
  useEffect(() => {
    if (reducedMotion() || cur.current === value) { cur.current = value; setShown(value); return; }
    const start = performance.now(), a = cur.current; let raf = 0;
    const tick = (t: number) => {
      const p = Math.min(1, Math.max(0, (t - start) / duration)), e = 1 - Math.pow(1 - p, 3); // rAF timestamps can precede `start`
      cur.current = a + (value - a) * e; setShown(cur.current);
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf); // safe under StrictMode's mount/unmount/mount
  }, [value, duration]);
  return shown;
}
/** Number that counts up on appearance and flashes green/red when it later changes (e.g. after a refresh). */
export function Num({ value, decimals = 0, prefix = "", suffix = "", className = "" }: { value: number; decimals?: number; prefix?: string; suffix?: string; className?: string }) {
  const shown = useCountUp(value ?? 0);
  const prev = useRef<number | null>(null);
  const [flash, setFlash] = useState("");
  useEffect(() => {
    if (prev.current !== null && prev.current !== value && !reducedMotion()) {
      setFlash(value > prev.current ? "anim-flash-up" : "anim-flash-down");
      const t = setTimeout(() => setFlash(""), 950); prev.current = value; return () => clearTimeout(t);
    }
    prev.current = value;
  }, [value]);
  return <span className={`tabular-nums rounded-sm ${flash} ${className}`}>{prefix}{shown.toLocaleString("en-IN", { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}{suffix}</span>;
}

export function Spinner({ className = "" }: { className?: string }) {
  return <span className={`inline-block h-3.5 w-3.5 animate-[spin_.7s_linear_infinite] rounded-full border-2 border-current border-t-transparent ${className}`} aria-hidden />;
}

export function Checkbox({ checked, indeterminate, onChange, label }: { checked: boolean; indeterminate?: boolean; onChange: (v: boolean) => void; label: string }) {
  const on = checked || indeterminate;
  return (
    <label className="relative inline-flex h-4 w-4 shrink-0 cursor-pointer items-center justify-center" onClick={(e) => e.stopPropagation()}>
      <input type="checkbox" className="peer sr-only" aria-label={label} checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className={`flex h-4 w-4 items-center justify-center rounded border transition-all duration-150 peer-focus-visible:ring-2 peer-focus-visible:ring-brand/40 ${on ? "scale-100 border-brand bg-brand" : "bg-surface hover:border-brand"}`}>
        {checked && <Check className="h-3 w-3 animate-[pop-in_.15s_ease-out] text-white dark:text-slate-900" strokeWidth={3} />}
        {indeterminate && !checked && <span className="h-0.5 w-2 rounded bg-white dark:bg-slate-900" />}
      </span>
    </label>
  );
}

export function SuccessCheck({ size = 40 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 28 28" fill="none" aria-hidden>
      <circle className="check-circle" cx="14" cy="14" r="12" stroke="rgb(16 185 129)" strokeWidth="2" />
      <path className="check-path" d="M8.5 14.5l3.8 3.8 7.2-7.6" stroke="rgb(16 185 129)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Collapsible panel; height animates via grid rows, state is remembered per key. */
export function Collapsible({ id, title, action, children, defaultOpen = true }: { id: string; title: string; action?: ReactNode; children: ReactNode; defaultOpen?: boolean }) {
  const key = `sp_panel_${id}`;
  const [open, setOpen] = useState(() => { try { const v = localStorage.getItem(key); return v === null ? defaultOpen : v === "1"; } catch { return defaultOpen; } });
  const toggle = () => { setOpen(!open); try { localStorage.setItem(key, !open ? "1" : "0"); } catch { /* ignore */ } };
  return (
    <section className="card overflow-hidden transition-shadow hover:shadow-[var(--shadow-2)]">
      <div className="flex items-center justify-between px-3 py-2">
        <button className="flex flex-1 items-center gap-1.5 text-left text-[13px] font-semibold" aria-expanded={open} onClick={toggle}>
          <ChevronDown className={`h-3.5 w-3.5 text-sub transition-transform duration-200 ${open ? "" : "-rotate-90"}`} />{title}</button>
        {action}
      </div>
      <div className="grid transition-[grid-template-rows] duration-200 ease-out" style={{ gridTemplateRows: open ? "1fr" : "0fr" }}>
        <div className="overflow-hidden"><div className="border-t p-3">{children}</div></div>
      </div>
    </section>
  );
}

/** Tab strip with a sliding indicator and arrow-key navigation. */
export function TabBar<T extends string>({ tabs, active, onChange }: { tabs: readonly (readonly [T, string])[]; active: T; onChange: (k: T) => void }) {
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  const [bar, setBar] = useState({ left: 0, width: 0 });
  useLayoutEffect(() => {
    const el = refs.current[active]; if (el) setBar({ left: el.offsetLeft, width: el.offsetWidth });
  }, [active, tabs]);
  useEffect(() => { const h = () => { const el = refs.current[active]; if (el) setBar({ left: el.offsetLeft, width: el.offsetWidth }); }; window.addEventListener("resize", h); return () => window.removeEventListener("resize", h); }, [active]);
  const onKey = (e: React.KeyboardEvent) => {
    const fi = tabs.findIndex((t) => refs.current[t[0]] === document.activeElement);
    const i = fi >= 0 ? fi : tabs.findIndex((t) => t[0] === active);
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") { e.preventDefault(); const n = tabs[(i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length][0]; onChange(n); refs.current[n]?.focus(); }
    else if (e.key === "Home" || e.key === "End") { e.preventDefault(); const n = tabs[e.key === "Home" ? 0 : tabs.length - 1][0]; onChange(n); refs.current[n]?.focus(); }
  };
  return (
    <div className="relative flex gap-0.5 overflow-x-auto border-b" role="tablist" onKeyDown={onKey}>
      {tabs.map(([k, l]) => (
        <button key={k} ref={(el) => { refs.current[k] = el; }} role="tab" aria-selected={active === k} tabIndex={active === k ? 0 : -1} onClick={() => onChange(k)}
          className={`whitespace-nowrap px-3.5 py-2 text-[13px] transition-colors ${active === k ? "font-medium text-brand" : "text-sub hover:text-ink"}`}>{l}</button>))}
      <span className="absolute bottom-0 h-0.5 rounded bg-brand transition-all duration-300 ease-out" style={{ left: bar.left, width: bar.width }} />
    </div>
  );
}

/** Horizontal swipe on touch devices. Ignores swipes that start inside scrollable tables/inputs so normal scrolling is never hijacked. */
export function useSwipe(ref: RefObject<HTMLElement>, h: { onLeft?: () => void; onRight?: () => void }, enabled = true) {
  const cb = useRef(h); cb.current = h;
  useEffect(() => {
    const el = ref.current; if (!el || !enabled) return;
    let sx = 0, sy = 0, st = 0, ok = false;
    const start = (e: TouchEvent) => {
      const t = e.touches[0]; sx = t.clientX; sy = t.clientY; st = Date.now();
      ok = !(e.target as HTMLElement).closest("input,textarea,select,table,.overflow-x-auto,[data-noswipe]");
    };
    const end = (e: TouchEvent) => {
      if (!ok) return; const t = e.changedTouches[0]; const dx = t.clientX - sx, dy = t.clientY - sy;
      if (Math.abs(dx) > 70 && Math.abs(dy) < 45 && Date.now() - st < 600) (dx < 0 ? cb.current.onLeft : cb.current.onRight)?.();
    };
    el.addEventListener("touchstart", start, { passive: true }); el.addEventListener("touchend", end, { passive: true });
    return () => { el.removeEventListener("touchstart", start); el.removeEventListener("touchend", end); };
  }, [ref, enabled]);
}

/** Close on outside click and Escape. */
export function useDismiss(ref: RefObject<HTMLElement>, active: boolean, close: () => void) {
  useEffect(() => {
    if (!active) return;
    const md = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) close(); };
    const kd = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    document.addEventListener("mousedown", md); document.addEventListener("keydown", kd);
    return () => { document.removeEventListener("mousedown", md); document.removeEventListener("keydown", kd); };
  }, [ref, active, close]);
}

/** Thin top progress bar driven by in-flight API requests. */
export function NavProgress() {
  const [w, setW] = useState(0); const [vis, setVis] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval>>();
  useEffect(() => {
    let hide: ReturnType<typeof setTimeout>;
    const h = (e: Event) => {
      const n = (e as CustomEvent).detail as number;
      clearTimeout(hide);
      if (n > 0) { setVis(true); setW((x) => (x > 0 && x < 90 ? x : 12)); clearInterval(timer.current); timer.current = setInterval(() => setW((x) => (x < 85 ? x + (90 - x) * 0.12 : x)), 200); }
      else { clearInterval(timer.current); setW(100); hide = setTimeout(() => { setVis(false); setW(0); }, 260); }
    };
    window.addEventListener("sp-pending", h); return () => { window.removeEventListener("sp-pending", h); clearInterval(timer.current); clearTimeout(hide); };
  }, []);
  return <div className="pointer-events-none fixed inset-x-0 top-0 z-[90] h-0.5" aria-hidden><div className="h-full bg-brand transition-[width,opacity] duration-200 ease-out" style={{ width: `${w}%`, opacity: vis ? 1 : 0 }} /></div>;
}

/** Slide-over panel with scrim. Closes on Esc, scrim click, close button or a right-swipe; animates out before unmounting. */
export function Drawer({ title, subtitle, onClose, children, footer, width = "26rem" }: { title: ReactNode; subtitle?: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; width?: string }) {
  const [closing, setClosing] = useState(false);
  const ref = useRef<HTMLElement>(null);
  const close = () => { if (closing) return; setClosing(true); setTimeout(onClose, reducedMotion() ? 0 : 200); };
  useEffect(() => { const h = (e: KeyboardEvent) => e.key === "Escape" && close(); window.addEventListener("keydown", h); return () => window.removeEventListener("keydown", h); });
  useEffect(() => { ref.current?.focus(); }, []);
  useSwipe(ref as RefObject<HTMLElement>, { onRight: close });
  return (
    <Portal><div className="fixed inset-0 z-50">
      <div className={`absolute inset-0 bg-black/20 ${closing ? "opacity-0" : "anim-fade"} transition-opacity duration-200`} onMouseDown={close} />
      <aside ref={ref} tabIndex={-1} role="dialog" aria-modal="true" style={{ width }} className={`absolute inset-y-0 right-0 flex max-w-full flex-col border-l bg-surface shadow-[var(--shadow-3)] outline-none ${closing ? "anim-drawer-out" : "anim-drawer"}`}>
        <div className="flex items-start justify-between gap-3 border-b px-4 py-3">
          <div className="min-w-0"><h2 className="truncate text-[15px] font-semibold">{title}</h2>{subtitle && <div className="text-xs text-sub">{subtitle}</div>}</div>
          <button className="rounded p-1 text-sub hover:bg-muted hover:text-ink" onClick={close} aria-label="Close panel" data-tip="Close (Esc)" data-tip-right>×</button>
        </div>
        <div className="flex-1 overflow-y-auto p-4">{children}</div>
        {footer && <div className="flex gap-2 border-t p-3">{footer}</div>}
      </aside>
    </div></Portal>
  );
}

/** Single-key shortcuts that never fire while typing or while a dialog is open. */
export function useHotkeys(map: Record<string, () => void>, deps: unknown[] = []) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target as HTMLElement;
      if (t.closest("input,textarea,select,[contenteditable=true]")) return;
      if (document.querySelector("[role=dialog]")) return;
      const fn = map[e.key]; if (fn) { e.preventDefault(); fn(); }
    };
    window.addEventListener("keydown", h); return () => window.removeEventListener("keydown", h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}


/** Searchable select. Options are filtered client-side; ↑↓ Enter to pick, Esc to close, outside click closes. */
export function Combobox<T extends { id: number | string }>({ options, value, onChange, render, search, placeholder = "Search…", invalid, disabled }: {
  options: T[]; value: number | string | ""; onChange: (o: T) => void; render: (o: T) => ReactNode; search: (o: T) => string; placeholder?: string; invalid?: boolean; disabled?: boolean;
}) {
  const [open, setOpen] = useState(false); const [q, setQ] = useState(""); const [active, setActive] = useState(0);
  const ref = useRef<HTMLDivElement>(null); const input = useRef<HTMLInputElement>(null);
  useDismiss(ref, open, () => setOpen(false));
  const sel = options.find((o) => o.id === value);
  const list = options.filter((o) => !q || search(o).toLowerCase().includes(q.toLowerCase())).slice(0, 50);
  useEffect(() => setActive(0), [q]);
  const pick = (o: T) => { onChange(o); setOpen(false); setQ(""); };
  return (
    <div ref={ref} className="relative">
      <input ref={input} disabled={disabled} className={`input ${invalid ? "input-error" : ""}`} role="combobox" aria-expanded={open} placeholder={sel ? "" : placeholder}
        value={open ? q : sel ? search(sel).split("|")[0] : ""} onFocus={() => setOpen(true)} onChange={(e) => { setQ(e.target.value); setOpen(true); }}
        onKeyDown={(e) => { if (e.key === "ArrowDown") { e.preventDefault(); setOpen(true); setActive((a) => Math.min(list.length - 1, a + 1)); } else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); } else if (e.key === "Enter" && open && list[active]) { e.preventDefault(); pick(list[active]); } }} />
      {open && <div role="listbox" className="card anim-pop absolute z-40 mt-1 max-h-60 w-full min-w-[16rem] overflow-y-auto py-1 shadow-[var(--shadow-3)]">
        {!list.length && <p className="px-3 py-2 text-[13px] text-sub">No matches</p>}
        {list.map((o, i) => <button type="button" key={o.id} role="option" aria-selected={i === active} onMouseMove={() => setActive(i)} onMouseDown={(e) => { e.preventDefault(); pick(o); }}
          className={`block w-full px-3 py-1.5 text-left text-[13px] ${i === active ? "bg-brand/10 text-brand" : ""}`}>{render(o)}</button>)}</div>}
    </div>
  );
}