import { RefObject, useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { Bot, Check, Copy, Download, History, Send, Sparkles, Trash2, X } from "lucide-react";
import { api, download } from "./api";
import { SuccessCheck, reducedMotion, useSwipe } from "./fx";
import { useToast } from "./ui";

type Draft = { id: number; kind: string; title: string; status: string; lines: string[]; result?: any };
type Msg = { id: number; role: "user" | "bot"; text: string; table?: { columns: string[]; rows: any[][] } | null; drafts?: Draft[]; downloads?: any[]; suggestions?: string[]; fresh?: boolean };

const START: Msg = { id: 0, role: "bot", text: "Hi! I answer from your live warehouse data and can prepare transfers, stock adjustments and purchase requests. I never change stock myself — every action waits for your confirmation." };
const GENERAL = ["Show low stock items", "Compare warehouses", "Which items will run out soon?", "Recommend transfers", "Slow moving items", "Warehouse report"];
const SCOPED = ["Show low stock items", "Inventory value", "Which items will run out soon?", "Recommend transfers", "Recent movements", "Slow moving items"];
let seq = 1;

/** Reveals the (already complete) reply progressively so it reads like a live answer. Skipped for reduced motion. */
function Streamed({ text, onDone }: { text: string; onDone: () => void }) {
  const words = text.split(/(\s+)/); const [n, setN] = useState(reducedMotion() ? words.length : 0);
  useEffect(() => {
    if (n >= words.length) { onDone(); return; }
    const t = setTimeout(() => setN((x) => Math.min(words.length, x + 3)), 22); return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [n]);
  return <p className="whitespace-pre-wrap">{words.slice(0, n).join("")}{n < words.length && <span className="ml-0.5 inline-block h-3.5 w-0.5 translate-y-0.5 bg-current opacity-60" />}</p>;
}

function DraftCard({ d, onChange }: { d: Draft; onChange: (d: Draft) => void }) {
  const toast = useToast(); const [busy, setBusy] = useState<"" | "confirm" | "dismiss">("");
  const act = async (what: "confirm" | "dismiss") => {
    setBusy(what);
    try {
      const r = await api(`/assistant/drafts/${d.id}/${what}`, { method: "POST" });
      onChange({ ...d, status: r.status, result: r.result });
      if (what === "confirm") { toast(`Done: ${r.result?.number || "adjustment applied"}`); window.dispatchEvent(new Event("sp-data-changed")); }
    } catch (e: any) { toast(e.message, "err"); } finally { setBusy(""); }
  };
  return (
    <div className="anim-up mt-2 rounded-md border bg-surface p-3 text-[13px]">
      <div className="flex items-center justify-between gap-2"><span className="font-medium">{d.title}</span>
        <span className={`badge ${d.status === "confirmed" ? "bg-emerald-500/15 text-emerald-600" : d.status === "dismissed" ? "bg-muted text-sub" : "bg-amber-500/15 text-amber-600"}`}>{d.status === "pending" ? "Awaiting confirmation" : d.status}</span></div>
      <ul className="mt-1 space-y-0.5 text-xs text-sub">{d.lines.map((l, i) => <li key={i}>{l}</li>)}</ul>
      {d.status === "confirmed" && <div className="mt-2 flex items-center gap-2 text-xs text-emerald-600"><SuccessCheck size={22} />{d.result?.number ? `Created ${d.result.number}` : "Applied"}</div>}
      {d.status === "pending" && <div className="mt-3 flex gap-2"><button className={`btn-primary !py-1 ${busy === "confirm" ? "btn-loading" : ""}`} disabled={!!busy} onClick={() => act("confirm")}><Check className="h-3.5 w-3.5" />Confirm</button><button className={`btn-ghost !py-1 ${busy === "dismiss" ? "btn-loading" : ""}`} disabled={!!busy} onClick={() => act("dismiss")}>Dismiss</button></div>}
    </div>
  );
}

function CopyBtn({ m }: { m: Msg }) {
  const [ok, setOk] = useState(false);
  const copy = async () => {
    const tsv = m.table ? "\n\n" + [m.table.columns.join("\t"), ...m.table.rows.map((r) => r.join("\t"))].join("\n") : "";
    try { await navigator.clipboard.writeText(m.text + tsv); setOk(true); setTimeout(() => setOk(false), 1500); } catch { /* clipboard blocked */ }
  };
  return <button className="row-actions absolute -bottom-2 right-2 flex items-center gap-1 rounded border bg-surface px-1.5 py-0.5 text-[11px] text-sub shadow-[var(--shadow-1)] hover:text-ink" onClick={copy} aria-label="Copy response">{ok ? <><Check className="h-3 w-3 text-emerald-600" />Copied</> : <><Copy className="h-3 w-3" />Copy</>}</button>;
}

export default function Assistant() {
  const toast = useToast(); const loc = useLocation();
  const [open, setOpen] = useState(false); const [closing, setClosing] = useState(false);
  const [msgs, setMsgs] = useState<Msg[]>(() => { try { const s = sessionStorage.getItem("sp_chat2"); return s ? JSON.parse(s) : [START]; } catch { return [START]; } });
  const [input, setInput] = useState(""); const [busy, setBusy] = useState(false); const [showHist, setShowHist] = useState(false); const [confirmClear, setConfirmClear] = useState(false);
  const [recall, setRecall] = useState(-1); const [ctx, setCtx] = useState<{ id: number; code: string; name: string } | null>(null);
  const end = useRef<HTMLDivElement>(null); const panel = useRef<HTMLElement>(null); const inputRef = useRef<HTMLInputElement>(null);
  const m = loc.pathname.match(/^(?:\/admin|\/user\/work)?\/warehouses\/(\d+)(\/|$)/); const ctxId = m ? +m[1] : null;

  useEffect(() => { try { sessionStorage.setItem("sp_chat2", JSON.stringify(msgs.slice(-40).map(({ fresh, ...x }) => x))); } catch { /* storage unavailable */ } }, [msgs]);
  useEffect(() => { end.current?.scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth", block: "end" }); }, [msgs, busy, open]);
  useEffect(() => { // context: the warehouse page being viewed
    if (!ctxId) { setCtx(null); return; } let live = true;
    api(`/warehouses/${ctxId}`).then((w) => live && setCtx({ id: w.id, code: w.code, name: w.name })).catch(() => live && setCtx(null));
    return () => { live = false; };
  }, [ctxId]);
  const close = () => { if (closing) return; setClosing(true); setTimeout(() => { setOpen(false); setClosing(false); setShowHist(false); }, reducedMotion() ? 0 : 200); };
  useEffect(() => { if (!open) return; const h = (e: KeyboardEvent) => { if (e.key === "Escape" && !document.querySelector("[role=dialog]:not([aria-label='AI warehouse assistant'])")) close(); }; window.addEventListener("keydown", h); return () => window.removeEventListener("keydown", h); });
  useEffect(() => { if (open) setTimeout(() => inputRef.current?.focus(), 250); }, [open]);
  useSwipe(panel as RefObject<HTMLElement>, { onRight: close }, open);

  const history = Array.from(new Set(msgs.filter((x) => x.role === "user").map((x) => x.text).reverse()));
  const send = async (text: string) => {
    const t = text.trim(); if (!t || busy) return;
    setMsgs((x) => [...x, { id: seq++ + Date.now(), role: "user", text: t }]); setInput(""); setRecall(-1); setBusy(true); setShowHist(false);
    try {
      const r = await api("/assistant/chat", { body: { message: t, warehouse_id: ctx?.id ?? null } });
      setMsgs((x) => [...x, { id: seq++ + Date.now(), role: "bot", text: r.reply, table: r.table, drafts: r.drafts, downloads: r.downloads, suggestions: r.suggestions, fresh: true }]);
    } catch (e: any) { setMsgs((x) => [...x, { id: seq++ + Date.now(), role: "bot", text: `Sorry, that failed: ${e.message}` }]); } finally { setBusy(false); }
  };
  const done = (id: number) => setMsgs((x) => x.map((y) => (y.id === id ? { ...y, fresh: false } : y)));
  const setDraft = (mid: number, d: Draft) => setMsgs((x) => x.map((y) => (y.id === mid ? { ...y, drafts: y.drafts?.map((z) => (z.id === d.id ? d : z)) } : y)));
  const clear = () => { if (!confirmClear) { setConfirmClear(true); setTimeout(() => setConfirmClear(false), 3000); return; } setMsgs([START]); setConfirmClear(false); toast("Conversation cleared"); };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowUp" && history.length && (!input || recall >= 0)) { e.preventDefault(); const n = Math.min(history.length - 1, recall + 1); setRecall(n); setInput(history[n]); }
    else if (e.key === "ArrowDown" && recall >= 0) { e.preventDefault(); const n = recall - 1; setRecall(n); setInput(n >= 0 ? history[n] : ""); }
  };
  const chips = ctx ? SCOPED : GENERAL;
  const last = msgs[msgs.length - 1];

  return (
    <>
      {!open && <button onClick={() => setOpen(true)} className="idle-ring fixed bottom-5 right-5 z-40 flex items-center gap-2 rounded-full bg-brand px-4 py-2.5 text-[13px] font-medium text-white shadow-[var(--shadow-2)] transition-all hover:-translate-y-0.5 hover:shadow-[var(--shadow-3)] active:scale-95 dark:text-slate-900" aria-label="Open AI warehouse assistant"><Sparkles className="h-4 w-4" />Ask AI</button>}
      {open && (
        <aside ref={panel} role="dialog" aria-label="AI warehouse assistant" className={`fixed inset-y-0 right-0 z-[60] flex w-full flex-col border-l bg-surface shadow-[var(--shadow-3)] sm:w-[25rem] ${closing ? "anim-drawer-out" : "anim-drawer"}`}>
          <div className="flex h-12 shrink-0 items-center justify-between border-b px-3">
            <div className="flex items-center gap-2"><div className="rounded-md bg-brand/10 p-1.5 text-brand"><Bot className="h-4 w-4" /></div><div><p className="text-sm font-semibold leading-tight">Warehouse Assistant</p><p className="text-[11px] text-sub">Live data · actions need your confirmation</p></div></div>
            <div className="flex items-center gap-0.5">
              <button className={`rounded p-1.5 hover:bg-muted ${showHist ? "bg-muted" : ""}`} onClick={() => setShowHist(!showHist)} aria-label="Chat history" data-tip="History"><History className="h-4 w-4" /></button>
              <button className={`flex items-center gap-1 rounded p-1.5 text-xs hover:bg-muted ${confirmClear ? "bg-red-500/10 text-red-600" : ""}`} onClick={clear} aria-label="Clear conversation" data-tip={confirmClear ? "Click again to confirm" : "Clear chat"}><Trash2 className="h-4 w-4" />{confirmClear && "Sure?"}</button>
              <button className="rounded p-1.5 hover:bg-muted" onClick={close} aria-label="Close assistant" data-tip="Close (Esc)" data-tip-right><X className="h-4 w-4" /></button></div>
          </div>
          {ctx && <div className="anim-fade flex shrink-0 items-center gap-2 border-b bg-brand/5 px-3 py-1.5 text-xs"><span className="h-1.5 w-1.5 rounded-full bg-brand" />Context: <b>{ctx.code}</b> {ctx.name}<span className="ml-auto text-sub">answers default to this warehouse</span></div>}
          {showHist && <div className="anim-pop shrink-0 border-b bg-muted/40 p-2" style={{ transformOrigin: "top" }}>
            <p className="px-1 pb-1 text-[11px] font-semibold uppercase tracking-wide text-sub">Your earlier questions</p>
            {!history.length ? <p className="px-1 py-2 text-xs text-sub">Nothing yet.</p> : <ul className="max-h-40 overflow-y-auto">{history.slice(0, 12).map((h) => <li key={h}><button className="flex w-full items-center justify-between gap-2 rounded px-2 py-1 text-left text-[13px] hover:bg-muted" onClick={() => send(h)}><span className="truncate">{h}</span><span className="shrink-0 text-[11px] text-brand">Ask again</span></button></li>)}</ul>}</div>}
          <div className="flex-1 space-y-4 overflow-y-auto p-3">
            {msgs.map((x) => (
              <div key={x.id} className={`anim-up ${x.role === "user" ? "flex justify-end" : ""}`}>
                <div className={`group relative ${x.table || x.drafts?.length ? "w-full" : "max-w-[92%]"} rounded-lg px-3 py-2 text-[13px] ${x.role === "user" ? "inline-block rounded-br-sm bg-brand text-white dark:text-slate-900" : "rounded-bl-sm bg-muted"}`}>
                  {x.role === "bot" && x.fresh ? <Streamed text={x.text} onDone={() => done(x.id)} /> : <p className="whitespace-pre-wrap">{x.text}</p>}
                  {!x.fresh && <div className="anim-fade">
                    {x.table && x.table.rows.length > 0 && <div className="mt-2 max-h-56 overflow-auto rounded border bg-surface"><table className="w-full text-xs"><thead className="sticky top-0 bg-surface"><tr>{x.table.columns.map((c) => <th key={c} className="whitespace-nowrap px-2 py-1 text-left font-semibold text-sub">{c}</th>)}</tr></thead>
                      <tbody className="divide-y">{x.table.rows.map((r, ri) => <tr key={ri}>{r.map((c, ci) => <td key={ci} className="px-2 py-1">{String(c)}</td>)}</tr>)}</tbody></table></div>}
                    {x.drafts?.map((d) => <DraftCard key={d.id} d={d} onChange={(z) => setDraft(x.id, z)} />)}
                    {x.downloads?.map((dl) => <button key={dl.path} className="btn-ghost mt-2 !py-1 text-xs" onClick={() => download(dl.path, dl.filename).catch((e) => toast(e.message, "err"))}><Download className="h-3.5 w-3.5" />{dl.label}</button>)}</div>}
                  {x.role === "bot" && x.id !== 0 && !x.fresh && <CopyBtn m={x} />}
                </div>
                {x.suggestions && x.suggestions.length > 0 && x === last && !x.fresh && <div className="anim-up mt-2 flex flex-wrap gap-1.5">{x.suggestions.map((s) => <button key={s} onClick={() => send(s)} className="rounded-full border bg-surface px-2.5 py-1 text-xs transition-colors hover:border-brand hover:text-brand">{s}</button>)}</div>}
              </div>))}
            {busy && <div className="anim-fade inline-flex items-center gap-1 rounded-lg rounded-bl-sm bg-muted px-3 py-2.5" aria-label="Assistant is typing">{[0, 1, 2].map((i) => <span key={i} className="dot-bounce h-1.5 w-1.5 rounded-full bg-sub" style={{ ["--i" as any]: i }} />)}</div>}
            {msgs.length <= 2 && !busy && <div className="anim-up"><p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-sub">Try asking</p><div className="flex flex-wrap gap-1.5">{chips.map((s) => <button key={s} onClick={() => send(s)} className="rounded-full border bg-surface px-2.5 py-1 text-xs transition-all hover:-translate-y-px hover:border-brand hover:text-brand">{s}</button>)}</div></div>}
            <div ref={end} />
          </div>
          {msgs.length > 2 && !busy && <div className="flex shrink-0 gap-1.5 overflow-x-auto border-t px-3 py-1.5" data-noswipe>{chips.slice(0, 4).map((s) => <button key={s} onClick={() => send(s)} className="shrink-0 rounded-full border bg-surface px-2.5 py-0.5 text-[11px] text-sub transition-colors hover:border-brand hover:text-brand">{s}</button>)}</div>}
          <form className="flex shrink-0 gap-2 border-t p-3" onSubmit={(e) => { e.preventDefault(); send(input); }}>
            <input ref={inputRef} className="input" placeholder={ctx ? `Ask about ${ctx.code}, or “transfer 5 … to MUM”` : "Ask about stock, or say “transfer 20 … from MUM to DEL”"} maxLength={500} value={input} onChange={(e) => { setInput(e.target.value); setRecall(-1); }} onKeyDown={onKey} aria-label="Message" />
            <button className="btn-primary !px-3" disabled={busy || !input.trim()} aria-label="Send"><Send className="h-4 w-4" /></button></form>
        </aside>)}
    </>
  );
}
