import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Ban, Box, Check, Download, Eye, FileText, Lightbulb, Package as PackageIcon, Pencil, Plus, Printer, Search, Send, Tag, Trash2, Truck, X } from "lucide-react";
import { api, dt, download, fmt, money } from "../api";
import { useMe } from "../App";
import { Col, DataTable } from "../DataTable";
import { Combobox, Num, SuccessCheck, TabBar, useHotkeys } from "../fx";
import { gstMode, totals as calcTotals } from "../gst";
import { openPdf, printPdf, savePdf } from "../media";
import { Badge, Confirm, Empty, Field, Modal, Skeleton, useLoad, useToast } from "../ui";
import { d8 } from "./PurchaseOrders";
import { Pagination, RowMenu } from "./Warehouses";

export const SO_TONE: Record<string, "ok" | "warn" | "bad" | "neutral" | "info"> = { draft: "neutral", confirmed: "info", packed: "warn", shipped: "info", delivered: "ok", cancelled: "bad" };
export const SO_LABEL: Record<string, string> = { draft: "Draft", confirmed: "Confirmed", packed: "Packed", shipped: "Shipped", delivered: "Delivered", cancelled: "Cancelled" };
export const SOBadge = ({ s }: { s: string }) => <Badge tone={SO_TONE[s] || "neutral"}>{SO_LABEL[s] || s}</Badge>;
const today = () => new Date().toISOString().slice(0, 10);

/* ============================== list ============================== */
export function SOList() {
  const { can } = useMe(); const toast = useToast(); const go = useNavigate(); const w = can("sales", "w"); const [sp] = useSearchParams();
  const [q, setQ] = useState(""); const [status, setStatus] = useState(sp.get("status") || "all"); const [customer, setCustomer] = useState(sp.get("customer") || ""); const [from, setFrom] = useState(""); const [to, setTo] = useState("");
  const [sort, setSort] = useState("order_date"); const [desc, setDesc] = useState(true); const [page, setPage] = useState(1); const [size, setSize] = useState(25);
  const [del, setDel] = useState<any>(null); const [cancel, setCancel] = useState<any>(null); const search = useRef<HTMLInputElement>(null);
  const customers = useLoad(() => api("/customers?page_size=200&status=all"));
  const qs = `q=${encodeURIComponent(q)}&status=${status}&sort=${sort}&desc=${desc}&page=${page}&page_size=${size}${customer ? `&customer_id=${customer}` : ""}${from ? `&date_from=${from}` : ""}${to ? `&date_to=${to}` : ""}`;
  const { data, loading, error, reload } = useLoad(() => api(`/sales-orders?${qs}`), [qs]);
  useHotkeys({ n: () => w && go("/sales-orders/new"), "/": () => search.current?.focus() }, [w]);
  const counts = data?.counts || {}; const c = (...s: string[]) => s.reduce((a, k) => a + (counts[k]?.count || 0), 0);
  const tabs: [string, string, number][] = [["all", "All", Object.values(counts).reduce((a: number, x: any) => a + x.count, 0)], ["draft", "Draft", c("draft")], ["confirmed", "Confirmed", c("confirmed")], ["packed", "Packed", c("packed")], ["shipped", "Shipped", c("shipped")], ["delivered", "Delivered", c("delivered")], ["cancelled", "Cancelled", c("cancelled")]];
  const sortBy = (k: string) => { if (sort === k) setDesc(!desc); else { setSort(k); setDesc(k !== "number"); } setPage(1); };
  const act = async (id: number, what: string, msg: string) => { try { await api(`/sales-orders/${id}/${what}`, { method: "POST" }); toast(msg); reload(); } catch (e: any) { toast(e.message, "err"); } };
  const remove = async (p: any) => { try { await api(`/sales-orders/${p.id}`, { method: "DELETE" }); toast("Draft deleted"); reload(); } catch (e: any) { toast(e.message, "err"); } };
  const prog = (p: any) => !["confirmed", "packed", "shipped", "delivered"].includes(p.status) ? <span className="text-sub">—</span> : <div><div className="flex h-1.5 w-full overflow-hidden rounded bg-muted"><div className="h-full bg-emerald-500 transition-all duration-500" style={{ width: `${p.delivered_pct}%` }} /><div className="h-full bg-brand/70 transition-all duration-500" style={{ width: `${Math.max(0, p.shipped_pct - p.delivered_pct)}%` }} /><div className="h-full bg-amber-400/70 transition-all duration-500" style={{ width: `${Math.max(0, p.packed_pct - p.shipped_pct)}%` }} /></div><div className="mt-0.5 text-[11px] text-sub">packed {p.packed_pct}% · shipped {p.shipped_pct}%</div></div>;
  const columns: Col<any>[] = [
    { id: "number", label: "Order", sort: "number", w: 11, cell: (p) => <td className="td"><Link className="font-medium text-brand hover:underline" to={`/sales-orders/${p.id}`} onClick={(e) => e.stopPropagation()}>{p.number}</Link>{p.reference && <div className="truncate text-xs text-sub">{p.reference}</div>}</td> },
    { id: "date", label: "Date", sort: "order_date", w: 10, cell: (p) => <td className="td text-sub">{d8(p.order_date)}</td> },
    { id: "customer", label: "Customer", w: 19, cell: (p) => <td className="td truncate">{p.customer}</td> },
    { id: "status", label: "Status", sort: "status", w: 11, cell: (p) => <td className="td"><SOBadge s={p.status} /></td> },
    { id: "progress", label: "Fulfilment", w: 15, cell: (p) => <td className="td">{prog(p)}</td> },
    { id: "delivery", label: "Delivery by", sort: "expected_date", w: 10, cell: (p) => <td className="td text-sub">{d8(p.expected_date)}{p.overdue && <div className="text-[11px] font-medium text-red-600">Overdue</div>}</td> },
    { id: "total", label: "Total", sort: "total", right: true, w: 12, cell: (p) => <td className="td text-right tabular-nums">{money(p.total)}<div className="text-xs text-sub">{p.item_count} item{p.item_count !== 1 ? "s" : ""}</div></td> },
  ];
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2"><h1 className="text-lg font-semibold">Sales Orders</h1>
        <div className="flex flex-wrap gap-2">{w && <button className="btn-primary" onClick={() => go("/sales-orders/new")} data-tip="New sales order (N)"><Plus className="h-4 w-4" />New Sales Order</button>}
          <button className="btn-ghost" onClick={() => download("/sales-orders-export.csv", "sales-orders.csv").catch((e) => toast(e.message, "err"))}><Download className="h-3.5 w-3.5" />Export</button></div></div>
      <div className="flex flex-wrap gap-1 rounded-lg border bg-surface p-1">{tabs.map(([k, l, n]) => <button key={k} onClick={() => { setStatus(k); setPage(1); }} className={`rounded-md px-3 py-1.5 text-[13px] transition-colors ${status === k ? "bg-brand/10 font-medium text-brand" : "text-sub hover:bg-muted"}`}>{l} <span className="ml-1 rounded bg-muted px-1.5 text-[11px] tabular-nums">{n}</span></button>)}</div>
      <div className="card overflow-hidden">
        <div className="flex flex-wrap items-center gap-2 border-b p-2.5">
          <select className="input !w-auto" value={customer} onChange={(e) => { setCustomer(e.target.value); setPage(1); }} aria-label="Customer"><option value="">Customer: All</option>{(customers.data?.items || []).map((v: any) => <option key={v.id} value={v.id}>{v.name}</option>)}</select>
          <label className="flex items-center gap-1.5 text-[13px] text-sub">From<input type="date" className="input !w-auto" value={from} onChange={(e) => { setFrom(e.target.value); setPage(1); }} /></label>
          <label className="flex items-center gap-1.5 text-[13px] text-sub">To<input type="date" className="input !w-auto" value={to} onChange={(e) => { setTo(e.target.value); setPage(1); }} /></label>
          <div className="relative w-full max-w-xs"><Search className="pointer-events-none absolute left-2.5 top-2 h-3.5 w-3.5 text-sub" /><input ref={search} className="input !pl-8 !pr-7" placeholder="Search order, reference, customer…  ( / )" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} />{q && <button className="absolute right-1.5 top-1.5 rounded p-0.5 text-sub hover:bg-muted" onClick={() => setQ("")} aria-label="Clear search"><X className="h-3.5 w-3.5" /></button>}</div></div>
        {error ? <p className="p-4 text-red-500">{error}</p> : (
          <DataTable storageKey="sp_so_cols" columns={columns} rows={data?.items || []} rowKey={(r) => r.id} loading={loading} hasData={!!data} sort={sort} desc={desc} onSort={sortBy} onRowOpen={(p) => go(`/sales-orders/${p.id}`)} animKey={qs} minWidth={940}
            empty={<Empty title={q || customer || from || to || status !== "all" ? "No sales orders match these filters" : "No sales orders yet"} hint={w ? "Create an order, confirm it to reserve stock, then pack and ship it." : undefined} action={w && status === "all" && !q ? <button className="btn-primary" onClick={() => go("/sales-orders/new")}><Plus className="h-4 w-4" />New Sales Order</button> : undefined} />}
            rowActions={(p) => (<div className="flex items-center justify-end gap-0.5"><span className="row-actions flex gap-0.5"><button className="rounded p-1 hover:bg-muted" aria-label={`View ${p.number}`} data-tip="View" onClick={() => go(`/sales-orders/${p.id}`)}><Eye className="h-4 w-4" /></button><button className="rounded p-1 hover:bg-muted" aria-label={`PDF ${p.number}`} data-tip="Open PDF" onClick={() => openPdf(`/sales-orders/${p.id}/pdf`).catch((e) => toast(e.message, "err"))}><FileText className="h-4 w-4" /></button></span>
              <RowMenu items={[{ label: "View", icon: Eye, onClick: () => go(`/sales-orders/${p.id}`) }, { label: "Edit", icon: Pencil, onClick: () => go(`/sales-orders/${p.id}/edit`), hidden: !w || p.status !== "draft" },
                { label: "Confirm & reserve stock", icon: Check, onClick: () => go(`/sales-orders/${p.id}?confirm=1`), hidden: !w || p.status !== "draft" }, { label: "Download PDF", icon: Download, onClick: () => savePdf(`/sales-orders/${p.id}/pdf`, `${p.number}.pdf`).catch((e) => toast(e.message, "err")) }, { label: "Print", icon: Printer, onClick: () => printPdf(`/sales-orders/${p.id}/pdf`).catch((e) => toast(e.message, "err")) },
                { label: "Cancel order", icon: Ban, onClick: () => setCancel(p), danger: true, hidden: !w || !["confirmed", "packed"].includes(p.status) }, { label: "Delete draft", icon: Trash2, onClick: () => setDel(p), danger: true, hidden: !w || p.status !== "draft" }]} /></div>)} />)}
        {data && <Pagination total={data.total} page={page} size={size} setPage={setPage} setSize={setSize} noun="sales orders" />}
      </div>
      {del && <Confirm title="Delete draft" text={`Delete draft ${del.number}?`} action="Delete" onConfirm={() => remove(del)} onClose={() => setDel(null)} />}
      {cancel && <Confirm title="Cancel sales order" text={`Cancel ${cancel.number}? Reserved stock is released and any unshipped packages are voided.`} action="Cancel order" onConfirm={() => act(cancel.id, "cancel", `${cancel.number} cancelled`)} onClose={() => setCancel(null)} />}
    </div>
  );
}

/* ============================== form ============================== */
type FLine = { key: number; product_id: number | ""; quantity: string; rate: string; discount_pct: string; tax_rate: string; warehouse_id: string };
let lk = 1; const blank = (): FLine => ({ key: lk++, product_id: "", quantity: "1", rate: "", discount_pct: "0", tax_rate: "", warehouse_id: "" });

export function SOForm() {
  const { id } = useParams(); const [sp] = useSearchParams(); const go = useNavigate(); const toast = useToast(); const { me } = useMe(); const edit = !!id;
  const existing = useLoad(() => (id ? api(`/sales-orders/${id}`) : Promise.resolve(null)), [id]);
  const customers = useLoad(() => api("/customers?page_size=200&status=active")); const whs = useLoad(() => api("/warehouses")); const items = useLoad(() => api("/products?page_size=200&status=active"));
  const [cid, setCid] = useState<number | "">(sp.get("customer") ? +sp.get("customer")! : ""); const [wh, setWh] = useState(""); const [od, setOd] = useState(today()); const [exp, setExp] = useState(""); const [ref, setRef] = useState(""); const [notes, setNotes] = useState(""); const [ship, setShip] = useState("0");
  const [lines, setLines] = useState<FLine[]>([blank()]); const [errs, setErrs] = useState<Record<string, string>>({}); const [busy, setBusy] = useState<"" | "draft" | "confirm">(""); const [done, setDone] = useState(""); const [banner, setBanner] = useState(""); const [shake, setShake] = useState(0); const [submitted, setSubmitted] = useState(false);
  const activeWhs = (whs.data || []).filter((x: any) => x.is_active);
  useEffect(() => { if (!edit && activeWhs.length && !wh) setWh(String(activeWhs[0].id)); }, [whs.data]); // eslint-disable-line
  useEffect(() => { const d = existing.data; if (!d) return; setCid(d.customer_id); setWh(String(d.warehouse_id)); setOd(d.order_date); setExp(d.expected_date || ""); setRef(d.reference || ""); setNotes(d.notes || ""); setShip(String(d.shipping_charge)); setLines(d.lines.map((l: any) => ({ key: lk++, product_id: l.product_id, quantity: String(l.quantity), rate: String(l.rate), discount_pct: String(l.discount_pct), tax_rate: String(l.tax_rate), warehouse_id: l.warehouse_id !== d.warehouse_id ? String(l.warehouse_id) : "" }))); }, [existing.data]);
  const customer = (customers.data?.items || []).find((v: any) => v.id === cid) || (existing.data ? { gstin: existing.data.customer_info.gstin, ship_state: null, bill_state: null } : null);
  const mode = customer ? gstMode(me.org, { gstin: customer.gstin, bill_state: customer.ship_state || customer.bill_state }) : "intra";
  const prods: any[] = items.data?.items || []; const num = (s: string) => (s === "" || isNaN(+s) ? 0 : +s);
  const t = useMemo(() => calcTotals(lines.map((l) => ({ quantity: num(l.quantity), rate: num(l.rate), discount_pct: num(l.discount_pct), tax_rate: num(l.tax_rate) })), mode, num(ship)), [lines, mode, ship]);
  const setLine = (k: number, p: Partial<FLine>) => setLines((ls) => ls.map((l) => (l.key === k ? { ...l, ...p } : l)));
  const pick = (k: number, p: any) => setLine(k, { product_id: p.id, rate: String(p.selling_price), tax_rate: String(p.tax_rate) });
  const validate = () => {
    const e: Record<string, string> = {}; if (!cid) e.customer = "Choose a customer"; if (!wh) e.wh = "Choose a warehouse"; if (exp && exp < od) e.exp = "Can't be before the order date"; if (num(ship) < 0) e.ship = "Can't be negative";
    lines.forEach((l, i) => { if (!l.product_id) e[`l${i}.item`] = "Choose an item"; if (!(num(l.quantity) > 0)) e[`l${i}.qty`] = "Enter a quantity above 0"; if (l.rate === "" || num(l.rate) < 0) e[`l${i}.rate`] = "Enter a rate"; if (num(l.discount_pct) < 0 || num(l.discount_pct) > 100) e[`l${i}.disc`] = "0–100"; });
    setErrs(e); return !Object.keys(e).length;
  };
  useEffect(() => { if (submitted) validate(); }, [submitted, cid, wh, od, exp, ship, lines]); // eslint-disable-line
  const save = async (confirm: boolean) => {
    setBanner(""); setSubmitted(true); if (!validate()) { setShake((n) => n + 1); return; }
    setBusy(confirm ? "confirm" : "draft");
    try {
      const body = { customer_id: +cid, warehouse_id: +wh, order_date: od, expected_date: exp || null, reference: ref || null, notes: notes || null, shipping_charge: num(ship), lines: lines.map((l) => ({ product_id: +l.product_id, quantity: num(l.quantity), rate: num(l.rate), discount_pct: num(l.discount_pct), tax_rate: num(l.tax_rate), warehouse_id: l.warehouse_id ? +l.warehouse_id : null })) };
      const so = edit ? await api(`/sales-orders/${id}`, { method: "PUT", body }) : await api("/sales-orders", { body });
      window.dispatchEvent(new Event("sp-data-changed")); setDone(`${so.number} saved as draft`);
      setTimeout(() => { toast(`${so.number} saved`); go(`/sales-orders/${so.id}${confirm ? "?confirm=1" : ""}`); }, 800);
    } catch (e: any) { setBanner(e.message); setShake((n) => n + 1); setBusy(""); }
  };
  if (edit && existing.loading) return <div className="card"><Skeleton rows={8} /></div>;
  if (edit && existing.data && existing.data.status !== "draft") return <div className="card"><Empty title="Only draft orders can be edited" action={<Link className="btn-primary" to={`/sales-orders/${id}`}>Back to order</Link>} /></div>;
  const E = ({ k }: { k: string }) => <p className="mt-0.5 min-h-[0.9rem] text-[11px] text-red-600" role={errs[k] ? "alert" : undefined}>{errs[k] || ""}</p>;
  return (
    <div className="relative space-y-3">
      <div className="flex items-center gap-2 text-[13px] text-sub"><Link to="/sales-orders" className="hover:text-ink">Sales Orders</Link><span>/</span><span className="text-ink">{edit ? `Edit ${existing.data?.number}` : "New sales order"}</span></div>
      <h1 className="text-lg font-semibold">{edit ? `Edit ${existing.data?.number ?? ""}` : "New Sales Order"}</h1>
      <div key={shake} className={shake ? "anim-shake" : ""}>
        <section className="card"><h2 className="border-b px-4 py-2.5 text-[13px] font-semibold">Order details</h2>
          <div className="grid gap-x-6 gap-y-1 p-4 md:grid-cols-2 lg:grid-cols-3">
            <Field label="Customer *"><Combobox options={customers.data?.items || []} value={cid} onChange={(v: any) => setCid(v.id)} render={(v: any) => <span>{v.name}<span className="ml-2 text-xs text-sub">{v.code}</span></span>} search={(v: any) => `${v.name}|${v.code} ${v.company_name || ""}`} placeholder="Search customers…" invalid={!!errs.customer} /><E k="customer" /></Field>
            <Field label="Ship from *"><select className={`input ${errs.wh ? "input-error" : ""}`} value={wh} onChange={(e) => setWh(e.target.value)}><option value="">Select…</option>{activeWhs.map((x: any) => <option key={x.id} value={x.id}>{x.code} — {x.name}</option>)}</select><E k="wh" /></Field>
            <Field label="Reference"><input className="input" maxLength={60} value={ref} onChange={(e) => setRef(e.target.value)} placeholder="Customer PO no." /><p className="min-h-[0.9rem]" /></Field>
            <Field label="Order date"><input type="date" className="input" value={od} onChange={(e) => setOd(e.target.value)} /><p className="min-h-[0.9rem]" /></Field>
            <Field label="Expected delivery"><input type="date" min={od} className={`input ${errs.exp ? "input-error" : ""}`} value={exp} onChange={(e) => setExp(e.target.value)} /><E k="exp" /></Field>
            <div className="text-[13px] text-sub"><p className="label">Tax treatment</p><p className="pt-1.5">{customer ? (mode === "inter" ? <Badge tone="info">IGST · inter-state</Badge> : <Badge tone="neutral">CGST + SGST · intra-state</Badge>) : "Choose a customer"}</p>{customer && "credit_limit" in customer && customer.credit_limit > 0 && <p className="mt-1 text-xs">Credit limit {money(customer.credit_limit)}</p>}</div>
          </div></section>
        <section className="card mt-3"><div className="flex items-center justify-between border-b px-4 py-2.5"><h2 className="text-[13px] font-semibold">Items</h2><span className="text-xs text-sub">Prices come from the item and can be overridden. Stock is reserved when the order is confirmed.</span></div>
          <div className="overflow-x-auto"><table className="w-full min-w-[900px] text-[13px]"><thead className="border-b bg-muted/60"><tr>{["#", "Item", ...(activeWhs.length > 1 ? ["From"] : []), "Qty", "Rate (₹)", "Disc %", "GST %", "Amount", ""].map((h, i) => <th key={i} className={`th ${["Qty", "Rate (₹)", "Disc %", "GST %", "Amount"].includes(h) ? "text-right" : ""}`}>{h}</th>)}</tr></thead>
            <tbody className="divide-y">{lines.map((l, i) => { const a = t.lines[i]; const p = prods.find((x) => x.id === l.product_id); const short = p && num(l.quantity) > p.available; return (
              <tr key={l.key} className="align-top"><td className="td w-8 text-sub">{i + 1}</td>
                <td className="td min-w-[250px]"><Combobox options={prods} value={l.product_id} onChange={(p: any) => pick(l.key, p)} render={(p: any) => <span>{p.name}<span className="ml-2 text-xs text-sub">{p.sku} · {fmt(p.available)} avail</span></span>} search={(p: any) => `${p.name}|${p.sku} ${p.barcode || ""}`} placeholder="Search items…" invalid={!!errs[`l${i}.item`]} /><E k={`l${i}.item`} />{p && <p className={`text-[11px] ${short ? "font-medium text-amber-600" : "text-sub"}`}>{short ? `Only ${fmt(p.available)} available across warehouses — confirming will fail unless stock arrives` : `${fmt(p.available)} available · unit ${p.unit}`}</p>}</td>
                {activeWhs.length > 1 && <td className="td w-28"><select className="input" value={l.warehouse_id} onChange={(e) => setLine(l.key, { warehouse_id: e.target.value })}><option value="">Default</option>{activeWhs.map((x: any) => <option key={x.id} value={x.id}>{x.code}</option>)}</select></td>}
                <td className="td w-24"><input type="number" min="0" step="any" className={`input text-right ${errs[`l${i}.qty`] ? "input-error" : ""}`} value={l.quantity} onChange={(e) => setLine(l.key, { quantity: e.target.value })} onKeyDown={(e) => { if (e.key === "Enter" && i === lines.length - 1) { e.preventDefault(); setLines((ls) => [...ls, blank()]); } }} /><E k={`l${i}.qty`} /></td>
                <td className="td w-28"><input type="number" min="0" step="0.01" className={`input text-right ${errs[`l${i}.rate`] ? "input-error" : ""}`} value={l.rate} onChange={(e) => setLine(l.key, { rate: e.target.value })} /><E k={`l${i}.rate`} /></td>
                <td className="td w-20"><input type="number" min="0" max="100" step="0.01" className={`input text-right ${errs[`l${i}.disc`] ? "input-error" : ""}`} value={l.discount_pct} onChange={(e) => setLine(l.key, { discount_pct: e.target.value })} /><E k={`l${i}.disc`} /></td>
                <td className="td w-24"><select className="input" value={l.tax_rate} onChange={(e) => setLine(l.key, { tax_rate: e.target.value })}>{l.tax_rate === "" && <option value="">—</option>}{!["0", "3", "5", "12", "18", "28", ""].includes(l.tax_rate) && <option value={l.tax_rate}>{l.tax_rate}%</option>}{[0, 3, 5, 12, 18, 28].map((r) => <option key={r} value={r}>{r}%</option>)}</select></td>
                <td className="td w-32 pt-3 text-right tabular-nums">{money(a?.amount || 0)}</td>
                <td className="td w-10"><button type="button" className="rounded p-1 text-sub hover:bg-muted hover:text-red-600 disabled:opacity-30" disabled={lines.length === 1} onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))} aria-label={`Remove line ${i + 1}`}><Trash2 className="h-4 w-4" /></button></td></tr>); })}</tbody></table></div>
          <div className="flex flex-wrap items-start justify-between gap-3 border-t p-3"><button type="button" className="btn-ghost" onClick={() => setLines((ls) => [...ls, blank()])}><Plus className="h-3.5 w-3.5" />Add line</button>
            <dl className="w-72 space-y-1 text-[13px]"><div className="flex justify-between"><dt className="text-sub">Subtotal</dt><dd className="tabular-nums">{money(t.subtotal)}</dd></div>{t.discount > 0 && <div className="flex justify-between"><dt className="text-sub">Discount</dt><dd className="tabular-nums">−{money(t.discount)}</dd></div>}<div className="flex justify-between"><dt className="text-sub">Taxable amount</dt><dd className="tabular-nums">{money(t.taxable)}</dd></div>
              {mode === "inter" ? <div className="flex justify-between"><dt className="text-sub">IGST</dt><dd className="tabular-nums">{money(t.igst)}</dd></div> : <><div className="flex justify-between"><dt className="text-sub">CGST</dt><dd className="tabular-nums">{money(t.cgst)}</dd></div><div className="flex justify-between"><dt className="text-sub">SGST</dt><dd className="tabular-nums">{money(t.sgst)}</dd></div></>}
              <div className="flex items-center justify-between gap-3"><dt className="text-sub">Shipping charge</dt><dd><input type="number" min="0" step="0.01" className={`input !w-28 text-right ${errs.ship ? "input-error" : ""}`} value={ship} onChange={(e) => setShip(e.target.value)} aria-label="Shipping charge" /></dd></div>
              <div className="flex justify-between border-t pt-1.5 text-base font-semibold"><dt>Total</dt><dd className="tabular-nums"><Num value={t.total} prefix="₹" decimals={2} /></dd></div></dl></div></section>
        <section className="card mt-3 p-4"><Field label="Notes (printed on the order)"><textarea className="input min-h-[60px]" maxLength={500} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field></section>
      </div>
      <div className="min-h-[2rem]">{banner && <p className="anim-fade rounded-md bg-red-500/10 px-3 py-2 text-[13px] text-red-600" role="alert">{banner}</p>}</div>
      <div className="flex flex-wrap gap-2"><button className={`btn-primary ${busy === "confirm" ? "btn-loading" : ""}`} disabled={!!busy} onClick={() => save(true)}><Check className="h-3.5 w-3.5" />Save &amp; confirm</button><button className={`btn-ghost ${busy === "draft" ? "btn-loading" : ""}`} disabled={!!busy} onClick={() => save(false)}>Save as draft</button><button className="btn-ghost" disabled={!!busy} onClick={() => go(edit ? `/sales-orders/${id}` : "/sales-orders")}>Cancel</button></div>
      {done && <div className="anim-fade fixed inset-0 z-50 flex flex-col items-center justify-center gap-2 bg-surface/90"><SuccessCheck size={64} /><p className="text-base font-semibold">{done}</p></div>}
    </div>
  );
}

/* ============================== detail ============================== */
const STEPS: [string, string][] = [["draft", "Draft"], ["confirmed", "Confirmed"], ["packed", "Packed"], ["shipped", "Shipped"], ["delivered", "Delivered"]];
const CARRIERS = ["Blue Dart", "Delhivery", "DTDC", "India Post", "Ecom Express", "Own vehicle", "Customer pickup"];

function PackDialog({ so, onClose, onDone }: { so: any; onClose: () => void; onDone: () => void }) {
  const toast = useToast(); const key = useMemo(() => crypto.randomUUID(), []);
  const open = so.lines.filter((l: any) => l.unpacked > 0);
  const [wh, setWh] = useState<number>(open[0]?.warehouse_id); const [weight, setWeight] = useState(""); const [notes, setNotes] = useState(""); const [busy, setBusy] = useState(false);
  const whIds: number[] = Array.from(new Set(open.map((l: any) => l.warehouse_id)));
  const mine = open.filter((l: any) => l.warehouse_id === wh);
  const [q, setQ] = useState<Record<number, string>>(Object.fromEntries(open.map((l: any) => [l.id, String(l.unpacked)])));
  const total = mine.reduce((a: number, l: any) => a + (+q[l.id] || 0), 0); const bad = mine.some((l: any) => +q[l.id] < 0 || +q[l.id] > l.unpacked || isNaN(+q[l.id]));
  const submit = async () => {
    setBusy(true);
    try { const r = await api(`/sales-orders/${so.id}/packages`, { body: { lines: mine.filter((l: any) => +q[l.id] > 0).map((l: any) => ({ so_line_id: l.id, quantity: +q[l.id] })), weight_kg: weight ? +weight : null, notes: notes || null, idempotency_key: key } }); toast(`${r.number} packed`); window.dispatchEvent(new Event("sp-data-changed")); onDone(); onClose(); }
    catch (e: any) { toast(e.message, "err"); } finally { setBusy(false); }
  };
  return (
    <Modal title={`Pack items — ${so.number}`} onClose={onClose} wide>
      <div className="space-y-3">
        {whIds.length > 1 && <Field label="Package from warehouse (one package per warehouse)"><select className="input" value={wh} onChange={(e) => setWh(+e.target.value)}>{whIds.map((id) => <option key={id} value={id}>{open.find((l: any) => l.warehouse_id === id).warehouse}</option>)}</select></Field>}
        <table className="w-full text-[13px]"><thead className="border-b"><tr><th className="th">Item</th><th className="th text-right">Ordered</th><th className="th text-right">Already packed</th><th className="th text-right">Left to pack</th><th className="th w-28 text-right">Pack now</th></tr></thead>
          <tbody className="divide-y">{mine.map((l: any) => <tr key={l.id}><td className="td">{l.name}<span className="ml-2 text-xs text-sub">{l.sku}</span></td><td className="td text-right tabular-nums">{fmt(l.quantity)}</td><td className="td text-right tabular-nums">{fmt(l.qty_packed)}</td><td className="td text-right tabular-nums">{fmt(l.unpacked)}</td><td className="td"><input type="number" min="0" max={l.unpacked} step="any" className={`input text-right ${+q[l.id] > l.unpacked ? "input-error" : ""}`} value={q[l.id]} onChange={(e) => setQ({ ...q, [l.id]: e.target.value })} /></td></tr>)}</tbody></table>
        <div className="grid grid-cols-2 gap-3"><Field label="Weight (kg)"><input type="number" min="0" step="0.01" className="input" value={weight} onChange={(e) => setWeight(e.target.value)} /></Field><Field label="Notes"><input className="input" maxLength={300} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field></div>
        <p className="text-xs text-sub">Packing reserves nothing new and moves no stock — stock leaves the warehouse when the shipment is marked shipped.</p>
        <div className="flex justify-end gap-2"><button className="btn-ghost" onClick={onClose}>Cancel</button><button className={`btn-primary ${busy ? "btn-loading" : ""}`} disabled={busy || bad || total <= 0} onClick={submit}><Box className="h-3.5 w-3.5" />Create package ({fmt(total)} units)</button></div>
      </div>
    </Modal>
  );
}

function ShipDialog({ pkg, so, onClose, onDone }: { pkg: any; so: any; onClose: () => void; onDone: () => void }) {
  const toast = useToast(); const [carrier, setCarrier] = useState(""); const [trk, setTrk] = useState(""); const [sd, setSd] = useState(today()); const [ed, setEd] = useState(so.expected_date || ""); const [busy, setBusy] = useState(false);
  const bad = carrier.trim().length < 2 || (ed && ed < sd);
  const submit = async () => {
    setBusy(true);
    try { const r = await api(`/packages/${pkg.id}/shipment`, { body: { carrier, tracking_number: trk || null, shipping_date: sd, expected_delivery: ed || null } }); toast(`${r.number} created — mark it shipped when it leaves`); window.dispatchEvent(new Event("sp-data-changed")); onDone(); onClose(); }
    catch (e: any) { toast(e.message, "err"); } finally { setBusy(false); }
  };
  return (
    <Modal title={`Create shipment — ${pkg.number}`} onClose={onClose}>
      <div className="space-y-3">
        <Field label="Carrier *"><input list="carriers" className="input" autoFocus value={carrier} onChange={(e) => setCarrier(e.target.value)} maxLength={80} /><datalist id="carriers">{CARRIERS.map((c) => <option key={c} value={c} />)}</datalist></Field>
        <Field label="Tracking number"><input className="input" maxLength={80} value={trk} onChange={(e) => setTrk(e.target.value)} /></Field>
        <div className="grid grid-cols-2 gap-3"><Field label="Shipping date"><input type="date" className="input" value={sd} onChange={(e) => setSd(e.target.value)} /></Field><Field label="Expected delivery"><input type="date" min={sd} className="input" value={ed} onChange={(e) => setEd(e.target.value)} /></Field></div>
        <p className="rounded-md bg-muted px-3 py-2 text-xs text-sub">No live carrier is connected: tracking is entered by your team and any "simulate" action is labelled as a simulation.</p>
        <div className="flex justify-end gap-2"><button className="btn-ghost" onClick={onClose}>Cancel</button><button className={`btn-primary ${busy ? "btn-loading" : ""}`} disabled={busy || !!bad} onClick={submit}><Truck className="h-3.5 w-3.5" />Create shipment</button></div>
      </div>
    </Modal>
  );
}

export function SODetail() {
  const { id = "" } = useParams(); const [sp, setSp] = useSearchParams(); const { can, me } = useMe(); const toast = useToast(); const go = useNavigate();
  const { data: so, loading, error, reload } = useLoad(() => api(`/sales-orders/${id}`), [id]);
  const [tab, setTab] = useState<"lines" | "fulfilment" | "activity">("lines");
  const [conf, setConf] = useState(sp.get("confirm") === "1"); const [credit, setCredit] = useState(""); const [cancel, setCancel] = useState(false); const [del, setDel] = useState(false); const [pack, setPack] = useState(false); const [ship, setShip] = useState<any>(null); const [voidP, setVoidP] = useState<any>(null);
  if (loading && !so) return <div className="card"><Skeleton rows={6} /></div>;
  if (error || !so) return <div className="card"><Empty title="Sales order not found" hint={error} /></div>;
  const w = can("sales", "w"), fw = can("fulfilment", "w"); const st = so.status; const idx = STEPS.findIndex((s) => s[0] === st); const mgr = ["owner", "admin", "manager"].includes(me.role);
  const run = async (what: string, msg: string, qs = "") => { try { await api(`/sales-orders/${id}/${what}${qs}`, { method: "POST" }); toast(msg); window.dispatchEvent(new Event("sp-data-changed")); reload(); return true; } catch (e: any) { if (/Credit limit exceeded/.test(e.message)) setCredit(e.message); else toast(e.message, "err"); return false; } };
  const remove = async () => { try { await api(`/sales-orders/${id}`, { method: "DELETE" }); toast("Draft deleted"); go("/sales-orders"); } catch (e: any) { toast(e.message, "err"); } };
  const voidPkg = async (p: any) => { try { await api(`/packages/${p.id}/void`, { method: "POST" }); toast(`${p.number} voided`); window.dispatchEvent(new Event("sp-data-changed")); reload(); } catch (e: any) { toast(e.message, "err"); } };
  const KV = ({ k, v }: { k: string; v: React.ReactNode }) => <div className="flex justify-between gap-3 py-1 text-[13px]"><dt className="text-sub">{k}</dt><dd className="text-right font-medium tabular-nums">{v}</dd></div>;
  const canPack = fw && ["confirmed", "packed"].includes(st) && so.lines.some((l: any) => l.unpacked > 0);
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-[13px] text-sub"><Link to="/sales-orders" className="hover:text-ink">Sales Orders</Link><span>/</span><span className="text-ink">{so.number}</span></div>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div><div className="flex flex-wrap items-center gap-2"><h1 className="text-lg font-semibold">{so.number}</h1><SOBadge s={st} />{so.overdue && <Badge tone="bad">Overdue</Badge>}{so.credit_override && <Badge tone="warn">Credit override</Badge>}</div>
          <p className="text-[13px] text-sub"><Link className="text-brand hover:underline" to={`/customers/${so.customer_id}`}>{so.customer}</Link> · ordered {d8(so.order_date)}{so.expected_date && ` · deliver by ${d8(so.expected_date)}`} · from {so.warehouse}</p></div>
        <div className="flex flex-wrap items-center gap-2">
          {w && st === "draft" && <button className="btn-ghost" onClick={() => go(`/sales-orders/${id}/edit`)}><Pencil className="h-3.5 w-3.5" />Edit</button>}
          {w && st === "draft" && <button className="btn-primary" onClick={() => setConf(true)}><Check className="h-3.5 w-3.5" />Confirm</button>}
          {canPack && <button className="btn-primary" onClick={() => setPack(true)}><Box className="h-3.5 w-3.5" />Pack items</button>}
          <button className="btn-ghost" onClick={() => openPdf(`/sales-orders/${id}/pdf`).catch((e) => toast(e.message, "err"))}><FileText className="h-3.5 w-3.5" />PDF</button>
          <button className="btn-ghost" onClick={() => printPdf(`/sales-orders/${id}/pdf`).catch((e) => toast(e.message, "err"))}><Printer className="h-3.5 w-3.5" />Print</button>
          {w && ["draft", "confirmed", "packed"].includes(st) && <div className="rounded-md border bg-surface"><RowMenu items={[{ label: "Download PDF", icon: Download, onClick: () => savePdf(`/sales-orders/${id}/pdf`, `${so.number}.pdf`).catch((e) => toast(e.message, "err")) }, { label: "Cancel order", icon: Ban, onClick: () => setCancel(true), danger: true, hidden: st === "draft" || so.lines.some((l: any) => l.qty_shipped > 0) }, { label: "Delete draft", icon: Trash2, onClick: () => setDel(true), danger: true, hidden: st !== "draft" }]} /></div>}</div>
      </div>
      {st !== "cancelled" ? (
        <ol className="flex items-center gap-0 overflow-x-auto rounded-lg border bg-surface p-3" aria-label="Order progress">{STEPS.map(([k, l], i) => { const on = i <= idx; return (
          <li key={k} className="flex flex-1 items-center gap-2 whitespace-nowrap"><span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold transition-colors duration-300 ${on ? "bg-brand text-white dark:text-slate-900" : "bg-muted text-sub"}`}>{on && i < idx ? <Check className="h-3.5 w-3.5" /> : i + 1}</span><span className={`text-[13px] ${i === idx ? "font-semibold text-ink" : "text-sub"}`}>{l}</span>{i < STEPS.length - 1 && <span className={`mx-2 h-0.5 min-w-[1.5rem] flex-1 rounded transition-colors duration-500 ${i < idx ? "bg-brand" : "bg-line"}`} />}</li>); })}</ol>
      ) : <div className="rounded-lg border border-red-500/30 bg-red-500/5 px-4 py-2.5 text-[13px] text-red-700 dark:text-red-400">This order was cancelled. Reserved stock was released.</div>}
      <div className="grid gap-3 lg:grid-cols-3">
        <div className="space-y-3 lg:col-span-2">
          <TabBar tabs={[["lines", "Items"], ["fulfilment", `Fulfilment (${so.packages.length})`], ["activity", "Activity"]] as const} active={tab} onChange={(k) => setTab(k as any)} />
          <div key={tab} className="anim-up">
            {tab === "lines" && <div className="card overflow-x-auto"><table className="w-full min-w-[700px]"><thead className="border-b bg-muted/60"><tr>{["#", "Item", "Ordered", "Packed", "Shipped", "Delivered", "Rate", "GST", "Amount"].map((h, i) => <th key={h} className={`th ${i >= 2 ? "text-right" : ""}`}>{h}</th>)}</tr></thead>
              <tbody className="divide-y">{so.lines.map((l: any, i: number) => <tr key={l.id} className="hover:bg-muted/60"><td className="td text-sub">{i + 1}</td><td className="td"><Link className="font-medium text-brand hover:underline" to={`/products/${l.product_id}`}>{l.name}</Link><div className="text-xs text-sub">{l.sku} · from {l.warehouse}{st === "draft" && <span className={l.quantity > l.available ? " font-medium text-amber-600" : ""}> · {fmt(l.available)} available</span>}</div></td>
                <td className="td text-right tabular-nums">{fmt(l.quantity)} {l.unit}</td>{[l.qty_packed, l.qty_shipped, l.qty_delivered].map((v, k) => <td key={k} className="td text-right tabular-nums">{fmt(v)}{["confirmed", "packed", "shipped", "delivered"].includes(st) && <div className="ml-auto mt-1 h-1 w-12 overflow-hidden rounded bg-muted"><div className={`h-full ${v >= l.quantity ? "bg-emerald-500" : "bg-brand"}`} style={{ width: `${(v / l.quantity) * 100}%` }} /></div>}</td>)}
                <td className="td text-right tabular-nums">{money(l.rate)}{l.discount_pct > 0 && <div className="text-xs text-sub">−{l.discount_pct}%</div>}</td><td className="td text-right tabular-nums">{l.tax_rate}%</td><td className="td text-right tabular-nums">{money(l.amount)}</td></tr>)}</tbody></table></div>}
            {tab === "fulfilment" && <div className="space-y-3">{!so.packages.length ? <div className="card"><Empty title="Nothing packed yet" hint={canPack ? "Use Pack items to create a package, then create a shipment for it." : st === "draft" ? "Confirm the order first; packing starts after stock is reserved." : undefined} action={canPack ? <button className="btn-primary" onClick={() => setPack(true)}><Box className="h-3.5 w-3.5" />Pack items</button> : undefined} /></div> : so.packages.map((p: any) => (
              <div key={p.id} className={`card ${p.status === "void" ? "opacity-60" : ""}`}><div className="flex flex-wrap items-center justify-between gap-2 border-b px-3 py-2"><div className="flex items-center gap-2 text-[13px]"><PackageIcon className="h-4 w-4 text-sub" /><span className="font-semibold">{p.number}</span><Badge tone={p.status === "delivered" ? "ok" : p.status === "shipped" ? "info" : p.status === "void" ? "bad" : "warn"}>{p.status}</Badge><span className="text-xs text-sub">{p.warehouse}{p.weight_kg ? ` · ${p.weight_kg} kg` : ""}</span></div>
                <div className="flex flex-wrap items-center gap-1.5"><button className="btn-ghost !py-1 text-xs" onClick={() => openPdf(`/packages/${p.id}/slip.pdf`).catch((e) => toast(e.message, "err"))}><FileText className="h-3.5 w-3.5" />Packing slip</button>
                  {p.shipment_id ? <Link className="btn-ghost !py-1 text-xs" to={`/shipments/${p.shipment_id}`}><Truck className="h-3.5 w-3.5" />{p.shipment_number} · {String(p.shipment_status).replace(/_/g, " ")}</Link> : fw && p.status === "packed" && <button className="btn-primary !py-1 text-xs" onClick={() => setShip(p)}><Truck className="h-3.5 w-3.5" />Create shipment</button>}
                  {fw && p.status === "packed" && (!p.shipment_id || p.shipment_status === "ready_to_ship") && <button className="rounded p-1 text-sub hover:bg-muted hover:text-red-600" aria-label={`Void ${p.number}`} data-tip="Void package" onClick={() => setVoidP(p)}><Trash2 className="h-3.5 w-3.5" /></button>}</div></div>
                <ul className="divide-y">{p.lines.map((l: any) => <li key={l.id} className="flex justify-between px-3 py-1.5 text-[13px]"><span>{l.name}<span className="ml-2 text-xs text-sub">{l.sku}</span></span><span className="tabular-nums">{fmt(l.quantity)} {l.unit}</span></li>)}</ul>{p.notes && <p className="border-t px-3 py-1.5 text-xs text-sub">{p.notes}</p>}</div>))}</div>}
            {tab === "activity" && <div className="card p-4"><ol className="relative space-y-4 before:absolute before:bottom-2 before:left-[7px] before:top-2 before:w-px before:bg-line">{so.activity.map((a: any, i: number) => <li key={i} className="relative flex gap-3"><span className="relative z-10 mt-1 h-3.5 w-3.5 shrink-0 rounded-full border-2 border-brand bg-surface" /><div><p className="text-[13px] font-medium capitalize">{a.action.replace(/_/g, " ")}{a.detail?.package ? <span className="font-normal normal-case text-sub"> — {a.detail.package}</span> : null}{a.detail?.credit_override ? <span className="font-normal normal-case text-amber-600"> — credit limit overridden</span> : null}</p><p className="text-xs text-sub">{dt(a.when)}{a.user ? ` · ${a.user}` : ""}</p></div></li>)}</ol></div>}
          </div>
        </div>
        <div className="space-y-3">
          <section className="card"><h3 className="border-b px-3 py-2 text-[13px] font-semibold">Summary</h3><dl className="divide-y p-3"><KV k="Subtotal" v={money(so.subtotal)} />{so.discount_total > 0 && <KV k="Discount" v={`−${money(so.discount_total)}`} />}<KV k="Taxable amount" v={money(so.taxable_total)} />
            {so.gst_mode === "inter" ? <KV k="IGST" v={money(so.igst)} /> : <><KV k="CGST" v={money(so.cgst)} /><KV k="SGST" v={money(so.sgst)} /></>}{so.shipping_charge > 0 && <KV k="Shipping" v={money(so.shipping_charge)} />}<div className="flex justify-between pt-2 text-base font-semibold"><dt>Total</dt><dd className="tabular-nums"><Num value={so.total} prefix="₹" decimals={2} /></dd></div></dl></section>
          {["confirmed", "packed", "shipped", "delivered"].includes(st) && <section className="card p-3"><h3 className="mb-2 text-[13px] font-semibold">Fulfilment</h3>{[["Packed", so.packed_pct, "bg-amber-400"], ["Shipped", so.shipped_pct, "bg-brand"], ["Delivered", so.delivered_pct, "bg-emerald-500"]].map(([l, v, c]) => <div key={l as string} className="mb-2 last:mb-0"><div className="flex justify-between text-xs"><span className="text-sub">{l}</span><span className="tabular-nums">{v}%</span></div><div className="h-1.5 overflow-hidden rounded bg-muted"><div className={`h-full rounded transition-all duration-700 ${c}`} style={{ width: `${v}%` }} /></div></div>)}</section>}
          <section className="card"><h3 className="border-b px-3 py-2 text-[13px] font-semibold">Customer</h3><div className="space-y-1 p-3 text-[13px]"><Link className="font-medium text-brand hover:underline" to={`/customers/${so.customer_id}`}>{so.customer}</Link><p className="text-sub">{so.customer_code}</p>{so.customer_info.gstin && <p>GSTIN {so.customer_info.gstin}</p>}{so.customer_info.phone && <p className="text-sub">{so.customer_info.phone}</p>}<p className="text-sub">Terms: {so.customer_info.payment_terms === 0 ? "due on receipt" : `Net ${so.customer_info.payment_terms} days`}</p>
            <div className="pt-2"><p className="text-[11px] text-sub">Ship to</p><p>{so.ship_to}</p></div>{so.payment_method && <div className="pt-2"><p className="text-[11px] text-sub">Payment (chosen by customer)</p><p data-testid="so-payment-method">{({ cod: "Cash on delivery", bank_transfer: "Bank transfer", on_account: "Pay later on invoice" } as Record<string, string>)[so.payment_method] || so.payment_method}</p></div>}<p className="pt-1"><Badge tone={so.gst_mode === "inter" ? "info" : "neutral"}>{so.gst_mode === "inter" ? "IGST · inter-state" : "CGST + SGST · intra-state"}</Badge></p></div></section>
          {(so.reference || so.notes) && <section className="card p-3 text-[13px]">{so.reference && <p><span className="text-sub">Reference </span>{so.reference}</p>}{so.notes && <p className="mt-1 text-sub">{so.notes}</p>}</section>}
        </div>
      </div>
      {conf && <Confirm title="Confirm sales order" text={`Confirm ${so.number}? Stock for every line is reserved now. If any line can't be covered, nothing is reserved and you'll see which one.`} action="Confirm & reserve" onConfirm={async () => { await run("confirm", `${so.number} confirmed — stock reserved`); if (sp.get("confirm")) setSp({}); return; }} onClose={() => { setConf(false); if (sp.get("confirm")) setSp({}); }} />}
      {credit && <Modal title="Credit limit exceeded" onClose={() => setCredit("")}><div className="space-y-3"><p className="rounded-md bg-amber-500/10 px-3 py-2 text-[13px] text-amber-800 dark:text-amber-300">{credit}</p>{mgr ? <div className="flex justify-end gap-2"><button className="btn-ghost" onClick={() => setCredit("")}>Cancel</button><button className="btn-primary" onClick={async () => { const ok = await run("confirm", `${so.number} confirmed with credit override`, "?override_credit=true"); if (ok) setCredit(""); }}>Confirm with override</button></div> : <div className="flex justify-end"><button className="btn-primary" onClick={() => setCredit("")}>OK</button></div>}{!mgr && <p className="text-xs text-sub">Ask a manager, admin or owner to confirm this order with a credit override.</p>}</div></Modal>}
      {cancel && <Confirm title="Cancel sales order" text={`Cancel ${so.number}? Reserved stock is released and any unshipped packages are voided.`} action="Cancel order" onConfirm={async () => { await run("cancel", `${so.number} cancelled`); }} onClose={() => setCancel(false)} />}
      {del && <Confirm title="Delete draft" text={`Delete draft ${so.number}?`} action="Delete" onConfirm={remove} onClose={() => setDel(false)} />}
      {voidP && <Confirm title="Void package" text={`Void ${voidP.number}? Its quantities become unpacked again.`} action="Void package" onConfirm={() => voidPkg(voidP)} onClose={() => setVoidP(null)} />}
      {pack && <PackDialog so={so} onClose={() => setPack(false)} onDone={reload} />}
      {ship && <ShipDialog pkg={ship} so={so} onClose={() => setShip(null)} onDone={reload} />}
    </div>
  );
}
