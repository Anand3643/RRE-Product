import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Download, Eye, Plus, Search, Trash2, X } from "lucide-react";
import { api, dt, download, fmt, money } from "../api";
import { useMe } from "../App";
import { Col, DataTable } from "../DataTable";
import { Combobox, Num, SuccessCheck, useHotkeys } from "../fx";
import { Badge, Empty, Field, Skeleton, useLoad, useToast } from "../ui";
import { d8 } from "./PurchaseOrders";
import { Pagination, RowMenu } from "./Warehouses";

const TYPES: [string, string, string][] = [["increase", "Stock increase", "Add units (found stock, opening balance fixes)"], ["decrease", "Stock decrease", "Remove units (samples, internal use)"], ["damage", "Damaged goods", "Moves units out of sellable stock into the damaged bucket"], ["missing", "Missing stock", "Units that can't be found"], ["correction", "Correction (count)", "Set the exact counted quantity per item"]];
const TONE: Record<string, "ok" | "warn" | "bad" | "neutral" | "info"> = { increase: "ok", decrease: "neutral", damage: "bad", missing: "warn", correction: "info" };
export const TypeBadge = ({ t, label }: { t: string; label?: string }) => <Badge tone={TONE[t] || "neutral"}>{label || TYPES.find((x) => x[0] === t)?.[1] || t}</Badge>;

export function AdjList() {
  const { can } = useMe(); const toast = useToast(); const go = useNavigate(); const w = can("inventory", "w");
  const [q, setQ] = useState(""); const [type, setType] = useState(""); const [wh, setWh] = useState(""); const [from, setFrom] = useState(""); const [to, setTo] = useState(""); const [page, setPage] = useState(1); const [size, setSize] = useState(25); const search = useRef<HTMLInputElement>(null);
  const whs = useLoad(() => api("/warehouses"));
  const qs = `q=${encodeURIComponent(q)}&page=${page}&page_size=${size}${type ? `&adj_type=${type}` : ""}${wh ? `&warehouse_id=${wh}` : ""}${from ? `&date_from=${from}` : ""}${to ? `&date_to=${to}` : ""}`;
  const { data, loading, error } = useLoad(() => api(`/adjustments?${qs}`), [qs]);
  useHotkeys({ n: () => w && go("/adjustments/new"), "/": () => search.current?.focus() }, [w]);
  const columns: Col<any>[] = [
    { id: "number", label: "Adjustment", w: 12, cell: (a) => <td className="td"><Link className="font-medium text-brand hover:underline" to={`/adjustments/${a.id}`} onClick={(e) => e.stopPropagation()}>{a.number}</Link><div className="text-xs text-sub">{d8(a.adj_date)}</div></td> },
    { id: "type", label: "Type", w: 14, cell: (a) => <td className="td"><TypeBadge t={a.adj_type} label={a.type_label} /></td> },
    { id: "wh", label: "Warehouse", w: 10, cell: (a) => <td className="td text-sub">{a.warehouse}</td> },
    { id: "reason", label: "Reason", w: 28, cell: (a) => <td className="td truncate" title={a.reason}>{a.reason}</td> },
    { id: "items", label: "Items", right: true, w: 7, cell: (a) => <td className="td text-right tabular-nums">{a.line_count}</td> },
    { id: "net", label: "Net units", right: true, w: 9, cell: (a) => <td className={`td text-right font-medium tabular-nums ${a.net_units > 0 ? "text-emerald-600" : a.net_units < 0 ? "text-red-500" : ""}`}>{a.net_units > 0 ? "+" : ""}{fmt(a.net_units, 3)}</td> },
    { id: "value", label: "Value impact", right: true, w: 11, cell: (a) => <td className={`td text-right tabular-nums ${a.value_impact < 0 ? "text-red-500" : ""}`}>{money(a.value_impact)}</td> },
    { id: "by", label: "By", w: 9, cell: (a) => <td className="td truncate text-sub">{a.created_by || "—"}</td> },
  ];
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2"><h1 className="text-lg font-semibold">Inventory Adjustments</h1>
        <div className="flex gap-2">{w && <button className="btn-primary" onClick={() => go("/adjustments/new")} data-tip="New adjustment (N)"><Plus className="h-4 w-4" />New Adjustment</button>}<button className="btn-ghost" onClick={() => download("/adjustments-export.csv", "adjustments.csv").catch((e) => toast(e.message, "err"))}><Download className="h-3.5 w-3.5" />Export</button></div></div>
      <div className="card overflow-hidden">
        <div className="flex flex-wrap items-center gap-2 border-b p-2.5">
          <select className="input !w-auto" value={type} onChange={(e) => { setType(e.target.value); setPage(1); }} aria-label="Type"><option value="">Type: All</option>{TYPES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
          <select className="input !w-auto" value={wh} onChange={(e) => { setWh(e.target.value); setPage(1); }} aria-label="Warehouse"><option value="">Warehouse: All</option>{(whs.data || []).map((x: any) => <option key={x.id} value={x.id}>{x.code}</option>)}</select>
          <label className="flex items-center gap-1.5 text-[13px] text-sub">From<input type="date" className="input !w-auto" value={from} onChange={(e) => { setFrom(e.target.value); setPage(1); }} /></label>
          <label className="flex items-center gap-1.5 text-[13px] text-sub">To<input type="date" className="input !w-auto" value={to} onChange={(e) => { setTo(e.target.value); setPage(1); }} /></label>
          <div className="relative w-full max-w-xs"><Search className="pointer-events-none absolute left-2.5 top-2 h-3.5 w-3.5 text-sub" /><input ref={search} className="input !pl-8 !pr-7" placeholder="Search number or reason…  ( / )" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} />{q && <button className="absolute right-1.5 top-1.5 rounded p-0.5 text-sub hover:bg-muted" onClick={() => setQ("")} aria-label="Clear search"><X className="h-3.5 w-3.5" /></button>}</div></div>
        {error ? <p className="p-4 text-red-500">{error}</p> : (
          <DataTable storageKey="sp_adj_cols" columns={columns} rows={data?.items || []} rowKey={(r) => r.id} loading={loading} hasData={!!data} sort="" desc={false} onSort={() => {}} onRowOpen={(a) => go(`/adjustments/${a.id}`)} animKey={qs} minWidth={900}
            empty={<Empty title={q || type || wh || from || to ? "No adjustments match these filters" : "No adjustments yet"} hint="Every stock correction, damage or write-off is recorded here with who did it and why." action={w && !q ? <button className="btn-primary" onClick={() => go("/adjustments/new")}><Plus className="h-4 w-4" />New Adjustment</button> : undefined} />}
            rowActions={(a) => <RowMenu items={[{ label: "View", icon: Eye, onClick: () => go(`/adjustments/${a.id}`) }]} />} />)}
        {data && <Pagination total={data.total} page={page} size={size} setPage={setPage} setSize={setSize} noun="adjustments" />}
      </div>
    </div>
  );
}

type FLine = { key: number; product_id: number | ""; quantity: string; unit_cost: string }; let lk = 1; const blank = (): FLine => ({ key: lk++, product_id: "", quantity: "", unit_cost: "" });

export function AdjForm() {
  const go = useNavigate(); const toast = useToast(); const key = useMemo(() => crypto.randomUUID(), []);
  const whs = useLoad(() => api("/warehouses")); const items = useLoad(() => api("/products?page_size=200&status=all"));
  const [type, setType] = useState("decrease"); const [wh, setWh] = useState(""); const [date, setDate] = useState(new Date().toISOString().slice(0, 10)); const [reason, setReason] = useState(""); const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<FLine[]>([blank()]); const [stockMap, setStockMap] = useState<Record<string, number>>({}); const [errs, setErrs] = useState<Record<string, string>>({}); const [busy, setBusy] = useState(false); const [done, setDone] = useState(""); const [banner, setBanner] = useState(""); const [shake, setShake] = useState(0); const [submitted, setSubmitted] = useState(false);
  const active = (whs.data || []).filter((x: any) => x.is_active); const prods: any[] = items.data?.items || []; const num = (s: string) => (s === "" || isNaN(+s) ? NaN : +s);
  useEffect(() => { if (active.length && !wh) setWh(String(active[0].id)); }, [whs.data]); // eslint-disable-line
  useEffect(() => { if (!wh) return; api(`/inventory/stock?warehouse_id=${wh}`).then((rows: any[]) => setStockMap(Object.fromEntries(rows.map((r) => [r.product_id, r.on_hand])))).catch(() => setStockMap({})); }, [wh]);
  const cur = (pid: number | "") => (pid ? stockMap[pid] ?? 0 : 0); const corr = type === "correction";
  const setLine = (k: number, p: Partial<FLine>) => setLines((ls) => ls.map((l) => (l.key === k ? { ...l, ...p } : l)));
  const validate = () => {
    const e: Record<string, string> = {}; if (!wh) e.wh = "Choose a warehouse"; if (reason.trim().length < 3) e.reason = "Give a reason (at least 3 characters)";
    const seen = new Set<number>();
    lines.forEach((l, i) => { if (!l.product_id) e[`l${i}.item`] = "Choose an item"; else if (corr && seen.has(+l.product_id)) e[`l${i}.item`] = "Already in this count"; if (l.product_id) seen.add(+l.product_id);
      const q = num(l.quantity); if (isNaN(q) || q < 0 || (!corr && q === 0)) e[`l${i}.qty`] = corr ? "Enter the counted quantity" : "Enter a quantity above 0"; else if (["decrease", "damage", "missing"].includes(type) && l.product_id && q > cur(l.product_id)) e[`l${i}.qty`] = `Only ${fmt(cur(l.product_id), 3)} on hand here`; else if (corr && l.product_id && q === cur(l.product_id)) e[`l${i}.qty`] = "Same as the current quantity"; });
    setErrs(e); return !Object.keys(e).length;
  };
  useEffect(() => { if (submitted) validate(); }, [submitted, type, wh, reason, lines, stockMap]); // eslint-disable-line
  const save = async () => {
    setBanner(""); setSubmitted(true); if (!validate()) { setShake((n) => n + 1); return; }
    setBusy(true);
    try { const r = await api("/adjustments", { body: { adj_type: type, warehouse_id: +wh, adj_date: date, reason: reason.trim(), notes: notes || null, idempotency_key: key, lines: lines.map((l) => ({ product_id: +l.product_id, quantity: num(l.quantity), unit_cost: l.unit_cost === "" ? null : +l.unit_cost })) } });
      window.dispatchEvent(new Event("sp-data-changed")); setDone(`${r.number} posted`); setTimeout(() => { toast(`${r.number} posted — stock updated`); go(`/adjustments/${r.id}`); }, 850); }
    catch (e: any) { setBanner(e.message); setShake((n) => n + 1); setBusy(false); }
  };
  const E = ({ k }: { k: string }) => <p className="mt-0.5 min-h-[0.9rem] text-[11px] text-red-600" role={errs[k] ? "alert" : undefined}>{errs[k] || ""}</p>;
  return (
    <div className="relative space-y-3">
      <div className="flex items-center gap-2 text-[13px] text-sub"><Link to="/adjustments" className="hover:text-ink">Adjustments</Link><span>/</span><span className="text-ink">New adjustment</span></div>
      <h1 className="text-lg font-semibold">New Inventory Adjustment</h1>
      <div key={shake} className={shake ? "anim-shake" : ""}>
        <section className="card"><h2 className="border-b px-4 py-2.5 text-[13px] font-semibold">Adjustment details</h2>
          <div className="space-y-3 p-4"><div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">{TYPES.map(([k, l, d]) => <button key={k} type="button" onClick={() => setType(k)} aria-pressed={type === k} className={`rounded-md border p-2.5 text-left transition-all ${type === k ? "border-brand bg-brand/5 shadow-[var(--shadow-1)]" : "hover:bg-muted"}`}><p className="text-[13px] font-medium">{l}</p><p className="mt-0.5 text-[11px] leading-tight text-sub">{d}</p></button>)}</div>
            <div className="grid gap-x-6 gap-y-1 md:grid-cols-3"><Field label="Warehouse *"><select className={`input ${errs.wh ? "input-error" : ""}`} value={wh} onChange={(e) => setWh(e.target.value)}>{active.map((x: any) => <option key={x.id} value={x.id}>{x.code} — {x.name}</option>)}</select><E k="wh" /></Field>
              <Field label="Date"><input type="date" className="input" max={new Date().toISOString().slice(0, 10)} value={date} onChange={(e) => setDate(e.target.value)} /><p className="min-h-[0.9rem]" /></Field>
              <Field label="Reason *"><input className={`input ${errs.reason ? "input-error" : ""}`} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. cycle count aisle 4, water damage" /><E k="reason" /></Field></div></div></section>
        <section className="card mt-3"><div className="flex items-center justify-between border-b px-4 py-2.5"><h2 className="text-[13px] font-semibold">Items</h2><span className="text-xs text-sub">{corr ? "Enter the quantity you counted; the difference is calculated for you." : "Quantities can't take stock below what is reserved for customers."}</span></div>
          <div className="overflow-x-auto"><table className="w-full min-w-[720px] text-[13px]"><thead className="border-b bg-muted/60"><tr><th className="th w-8">#</th><th className="th">Item</th><th className="th text-right">On hand ({active.find((x: any) => String(x.id) === wh)?.code})</th><th className="th text-right">{corr ? "Counted qty" : "Quantity"}</th>{type === "increase" && <th className="th text-right">Unit cost (₹)</th>}<th className="th text-right">After</th><th className="th w-10" /></tr></thead>
            <tbody className="divide-y">{lines.map((l, i) => { const q = num(l.quantity); const after = isNaN(q) || !l.product_id ? null : corr ? q : type === "increase" ? cur(l.product_id) + q : cur(l.product_id) - q; const diff = after == null ? null : after - cur(l.product_id); return (
              <tr key={l.key} className="align-top"><td className="td text-sub">{i + 1}</td><td className="td min-w-[260px]"><Combobox options={prods} value={l.product_id} onChange={(p: any) => setLine(l.key, { product_id: p.id, unit_cost: type === "increase" ? String(p.purchase_price) : "" })} render={(p: any) => <span>{p.name}<span className="ml-2 text-xs text-sub">{p.sku}</span></span>} search={(p: any) => `${p.name}|${p.sku} ${p.barcode || ""}`} placeholder="Search items…" invalid={!!errs[`l${i}.item`]} /><E k={`l${i}.item`} /></td>
                <td className="td pt-3 text-right tabular-nums">{l.product_id ? fmt(cur(l.product_id), 3) : "—"}</td>
                <td className="td w-32"><input type="number" min="0" step="any" className={`input text-right ${errs[`l${i}.qty`] ? "input-error" : ""}`} value={l.quantity} onChange={(e) => setLine(l.key, { quantity: e.target.value })} onKeyDown={(e) => { if (e.key === "Enter" && i === lines.length - 1) { e.preventDefault(); setLines((ls) => [...ls, blank()]); } }} /><E k={`l${i}.qty`} /></td>
                {type === "increase" && <td className="td w-28"><input type="number" min="0" step="0.01" className="input text-right" value={l.unit_cost} onChange={(e) => setLine(l.key, { unit_cost: e.target.value })} /></td>}
                <td className="td pt-3 text-right tabular-nums">{after == null ? "—" : <span className={diff! > 0 ? "text-emerald-600" : diff! < 0 ? "text-red-500" : ""}>{fmt(after, 3)} <span className="text-xs">({diff! > 0 ? "+" : ""}{fmt(diff!, 3)})</span></span>}</td>
                <td className="td"><button type="button" className="rounded p-1 text-sub hover:bg-muted hover:text-red-600 disabled:opacity-30" disabled={lines.length === 1} onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))} aria-label={`Remove line ${i + 1}`}><Trash2 className="h-4 w-4" /></button></td></tr>); })}</tbody></table></div>
          <div className="border-t p-3"><button type="button" className="btn-ghost" onClick={() => setLines((ls) => [...ls, blank()])}><Plus className="h-3.5 w-3.5" />Add item</button></div></section>
        <section className="card mt-3 p-4"><Field label="Notes"><textarea className="input min-h-[56px]" maxLength={500} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field></section>
      </div>
      <div className="min-h-[2rem]">{banner && <p className="anim-fade rounded-md bg-red-500/10 px-3 py-2 text-[13px] text-red-600" role="alert">{banner}</p>}</div>
      <div className="flex gap-2"><button className={`btn-primary ${busy ? "btn-loading" : ""}`} disabled={busy} onClick={save}>Post adjustment</button><button className="btn-ghost" disabled={busy} onClick={() => go("/adjustments")}>Cancel</button><span className="self-center text-xs text-sub">Posted adjustments can't be edited or deleted; reverse one with another adjustment.</span></div>
      {done && <div className="anim-fade fixed inset-0 z-50 flex flex-col items-center justify-center gap-2 bg-surface/90"><SuccessCheck size={64} /><p className="text-base font-semibold">{done}</p></div>}
    </div>
  );
}

export function AdjDetail() {
  const { id = "" } = useParams(); const { data: a, loading, error } = useLoad(() => api(`/adjustments/${id}`), [id]);
  if (loading && !a) return <div className="card"><Skeleton rows={5} /></div>;
  if (error || !a) return <div className="card"><Empty title="Adjustment not found" hint={error} /></div>;
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-[13px] text-sub"><Link to="/adjustments" className="hover:text-ink">Adjustments</Link><span>/</span><span className="text-ink">{a.number}</span></div>
      <div className="flex flex-wrap items-center gap-2"><h1 className="text-lg font-semibold">{a.number}</h1><TypeBadge t={a.adj_type} label={a.type_label} /><span className="text-[13px] text-sub">{a.warehouse} · {d8(a.adj_date)} · by {a.created_by || "—"} · posted {dt(a.created_at)}</span></div>
      <div className="grid gap-3 sm:grid-cols-3">{[["Net units", a.net_units, false], ["Value impact", a.value_impact, true], ["Items", a.line_count, false]].map(([l, v, m]) => <div key={l as string} className="card p-3"><p className="text-[11px] text-sub">{l}</p><p className={`text-lg font-semibold ${(v as number) < 0 ? "text-red-500" : ""}`}><Num value={v as number} prefix={m ? "₹" : ""} decimals={m ? 2 : 3} /></p></div>)}</div>
      <section className="card p-3 text-[13px]"><p><span className="text-sub">Reason </span>{a.reason}</p>{a.notes && <p className="mt-1 text-sub">{a.notes}</p>}</section>
      <div className="card overflow-x-auto"><table className="w-full min-w-[680px]"><thead className="border-b bg-muted/60"><tr>{["Item", "Before", "Change", "After", "Unit cost", "Value", "Ledger"].map((h, i) => <th key={h} className={`th ${i >= 1 && i <= 5 ? "text-right" : ""}`}>{h}</th>)}</tr></thead>
        <tbody className="divide-y">{a.lines.map((l: any) => <tr key={l.id} className="hover:bg-muted/60"><td className="td"><Link className="font-medium text-brand hover:underline" to={`/products/${l.product_id}`}>{l.name}</Link><div className="text-xs text-sub">{l.sku}</div></td><td className="td text-right tabular-nums">{fmt(l.qty_before, 3)}</td><td className={`td text-right font-medium tabular-nums ${l.qty_delta > 0 ? "text-emerald-600" : "text-red-500"}`}>{l.qty_delta > 0 ? "+" : ""}{fmt(l.qty_delta, 3)}</td><td className="td text-right tabular-nums">{fmt(l.qty_after, 3)}</td><td className="td text-right tabular-nums">{l.unit_cost != null ? money(l.unit_cost) : "—"}</td><td className="td text-right tabular-nums">{money(l.value)}</td><td className="td text-xs text-sub">movement #{l.movement_id}</td></tr>)}</tbody></table></div>
    </div>
  );
}
