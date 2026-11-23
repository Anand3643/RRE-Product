import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Ban, Check, Download, Eye, FileText, Lightbulb, PackageCheck, Pencil, Plus, Printer, Search, Send, Trash2, X } from "lucide-react";
import { api, dt, download, fmt, money } from "../api";
import { useMe } from "../App";
import { Col, DataTable } from "../DataTable";
import { Combobox, Num, SuccessCheck, TabBar, useHotkeys } from "../fx";
import { gstMode, lineAmounts, totals as calcTotals } from "../gst";
import { openPdf, printPdf, savePdf } from "../media";
import { Badge, Confirm, Empty, Field, Modal, Skeleton, useLoad, useToast } from "../ui";
import { Pagination, RowMenu } from "./Warehouses";

export const PO_TONE: Record<string, "ok" | "warn" | "bad" | "neutral" | "info"> = { draft: "neutral", issued: "info", partially_received: "warn", received: "ok", cancelled: "bad" };
export const PO_LABEL: Record<string, string> = { draft: "Draft", issued: "Issued", partially_received: "Partially received", received: "Received", cancelled: "Cancelled" };
export const POBadge = ({ s }: { s: string }) => <Badge tone={PO_TONE[s]}>{PO_LABEL[s] || s}</Badge>;
export const d8 = (s?: string | null) => (s ? new Date(s).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : "—");
const today = () => new Date().toISOString().slice(0, 10);

/* ============================== list ============================== */
function Suggestions({ whs, onClose, onDone }: { whs: any[]; onClose: () => void; onDone: () => void }) {
  const toast = useToast(); const go = useNavigate();
  const { data, loading } = useLoad(() => api("/purchase-orders/suggestions"));
  const [wh, setWh] = useState(String(whs[0]?.id || "")); const [busy, setBusy] = useState(false);
  const create = async () => {
    setBusy(true);
    try { const r = await api("/purchase-orders/from-suggestions", { body: { warehouse_id: +wh } }); toast(`${r.created.length} draft purchase order${r.created.length !== 1 ? "s" : ""} created${r.skipped.length ? ` · ${r.skipped.length} item(s) skipped (no preferred vendor)` : ""}`); onDone(); onClose(); if (r.created.length === 1) go(`/purchase-orders/${r.created[0].id}`); }
    catch (e: any) { toast(e.message, "err"); } finally { setBusy(false); }
  };
  const withVendor = (data || []).filter((g: any) => g.vendor_id);
  return (
    <Modal title="Reorder suggestions" onClose={onClose} wide>
      <p className="mb-3 text-[13px] text-sub">Based on the last 30 days of sales and reorder levels, minus quantities already on open orders.</p>
      {loading ? <Skeleton rows={3} /> : !data?.length ? <Empty title="Nothing needs reordering" hint="Stock covers the next 30 days of demand." /> : (
        <div className="max-h-[50vh] space-y-3 overflow-y-auto">{data.map((g: any) => (
          <div key={g.vendor_id ?? "none"} className="rounded-md border"><div className="flex items-center justify-between border-b bg-muted/50 px-3 py-1.5 text-[13px] font-medium"><span>{g.vendor || "No preferred vendor (can't be ordered automatically)"}</span><span className="text-sub">{money(g.estimated_cost)}</span></div>
            <table className="w-full text-[13px]"><tbody className="divide-y">{g.items.map((i: any) => <tr key={i.product_id}><td className="px-3 py-1.5">{i.name}<span className="ml-2 text-xs text-sub">{i.sku}</span></td><td className="px-3 py-1.5 text-right text-xs text-sub">{fmt(i.available)} avail · {i.on_order ? `${fmt(i.on_order)} on order · ` : ""}demand {fmt(i.demand_30d)}</td><td className="px-3 py-1.5 text-right font-medium tabular-nums">{fmt(i.suggested_qty)}</td></tr>)}</tbody></table></div>))}</div>)}
      <div className="mt-4 flex items-center justify-between gap-2"><div className="flex items-center gap-2 text-[13px]"><span className="text-sub">Receive into</span><select className="input !w-auto" value={wh} onChange={(e) => setWh(e.target.value)}>{whs.map((w) => <option key={w.id} value={w.id}>{w.code} — {w.name}</option>)}</select></div>
        <div className="flex gap-2"><button className="btn-ghost" onClick={onClose}>Close</button><button className={`btn-primary ${busy ? "btn-loading" : ""}`} disabled={busy || !withVendor.length} onClick={create}><Check className="h-3.5 w-3.5" />Create draft POs</button></div></div>
    </Modal>
  );
}

export function POList() {
  const { can } = useMe(); const toast = useToast(); const go = useNavigate(); const w = can("purchases", "w");
  const [sp] = useSearchParams();
  const [q, setQ] = useState(""); const [status, setStatus] = useState(sp.get("status") || "all"); const [vendor, setVendor] = useState(sp.get("vendor") || ""); const [from, setFrom] = useState(""); const [to, setTo] = useState("");
  const [sort, setSort] = useState("order_date"); const [desc, setDesc] = useState(true); const [page, setPage] = useState(1); const [size, setSize] = useState(25);
  const [del, setDel] = useState<any>(null); const [cancel, setCancel] = useState<any>(null); const [sug, setSug] = useState(false); const search = useRef<HTMLInputElement>(null);
  const vendors = useLoad(() => api("/vendors?page_size=200&status=all")); const whs = useLoad(() => api("/warehouses"));
  const qs = `q=${encodeURIComponent(q)}&status=${status}&sort=${sort}&desc=${desc}&page=${page}&page_size=${size}${vendor ? `&vendor_id=${vendor}` : ""}${from ? `&date_from=${from}` : ""}${to ? `&date_to=${to}` : ""}`;
  const { data, loading, error, reload } = useLoad(() => api(`/purchase-orders?${qs}`), [qs]);
  useHotkeys({ n: () => w && go("/purchase-orders/new"), "/": () => search.current?.focus() }, [w]);
  const counts = data?.counts || {}; const c = (...s: string[]) => s.reduce((a, k) => a + (counts[k]?.count || 0), 0);
  const tabs: [string, string, number][] = [["all", "All", Object.values(counts).reduce((a: number, x: any) => a + x.count, 0)], ["draft", "Draft", c("draft")], ["open", "Open", c("issued", "partially_received")], ["received", "Received", c("received")], ["cancelled", "Cancelled", c("cancelled")]];
  const sortBy = (k: string) => { if (sort === k) setDesc(!desc); else { setSort(k); setDesc(k !== "number"); } setPage(1); };
  const act = async (id: number, what: string, msg: string) => { try { await api(`/purchase-orders/${id}/${what}`, { method: "POST" }); toast(msg); reload(); } catch (e: any) { toast(e.message, "err"); } };
  const remove = async (p: any) => { try { await api(`/purchase-orders/${p.id}`, { method: "DELETE" }); toast("Draft deleted"); reload(); } catch (e: any) { toast(e.message, "err"); } };
  const columns: Col<any>[] = [
    { id: "number", label: "PO Number", sort: "number", w: 12, cell: (p) => <td className="td"><Link className="font-medium text-brand hover:underline" to={`/purchase-orders/${p.id}`} onClick={(e) => e.stopPropagation()}>{p.number}</Link>{p.reference && <div className="truncate text-xs text-sub">{p.reference}</div>}</td> },
    { id: "date", label: "Date", sort: "order_date", w: 10, cell: (p) => <td className="td text-sub">{d8(p.order_date)}</td> },
    { id: "vendor", label: "Vendor", w: 20, cell: (p) => <td className="td truncate">{p.vendor}</td> },
    { id: "status", label: "Status", sort: "status", w: 14, cell: (p) => <td className="td"><POBadge s={p.status} /></td> },
    { id: "expected", label: "Expected", sort: "expected_date", w: 11, cell: (p) => <td className="td text-sub">{d8(p.expected_date)}{p.overdue && <div className="text-[11px] font-medium text-red-600">Overdue</div>}</td> },
    { id: "received", label: "Received", w: 12, cell: (p) => <td className="td">{["issued", "partially_received", "received"].includes(p.status) ? <div><div className="h-1.5 w-full overflow-hidden rounded bg-muted"><div className={`h-full rounded transition-all duration-500 ${p.received_pct >= 100 ? "bg-emerald-500" : "bg-brand"}`} style={{ width: `${p.received_pct}%` }} /></div><div className="mt-0.5 text-[11px] text-sub">{p.received_pct}%</div></div> : <span className="text-sub">—</span>}</td> },
    { id: "total", label: "Total", sort: "total", right: true, w: 12, cell: (p) => <td className="td text-right tabular-nums">{money(p.total)}<div className="text-xs text-sub">{p.item_count} item{p.item_count !== 1 ? "s" : ""}</div></td> },
  ];
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2"><h1 className="text-lg font-semibold">Purchase Orders</h1>
        <div className="flex flex-wrap gap-2">{w && <button className="btn-primary" onClick={() => go("/purchase-orders/new")} data-tip="New purchase order (N)"><Plus className="h-4 w-4" />New Purchase Order</button>}
          {w && <button className="btn-ghost" onClick={() => setSug(true)}><Lightbulb className="h-3.5 w-3.5" />Reorder suggestions</button>}
          <button className="btn-ghost" onClick={() => download("/purchase-orders-export.csv", "purchase-orders.csv").catch((e) => toast(e.message, "err"))}><Download className="h-3.5 w-3.5" />Export</button></div></div>
      <div className="flex flex-wrap gap-1 rounded-lg border bg-surface p-1">{tabs.map(([k, l, n]) => <button key={k} onClick={() => { setStatus(k); setPage(1); }} className={`rounded-md px-3 py-1.5 text-[13px] transition-colors ${status === k ? "bg-brand/10 font-medium text-brand" : "text-sub hover:bg-muted"}`}>{l} <span className="ml-1 rounded bg-muted px-1.5 text-[11px] tabular-nums">{n}</span></button>)}</div>
      <div className="card overflow-hidden">
        <div className="flex flex-wrap items-center gap-2 border-b p-2.5">
          <select className="input !w-auto" value={vendor} onChange={(e) => { setVendor(e.target.value); setPage(1); }} aria-label="Vendor"><option value="">Vendor: All</option>{(vendors.data?.items || []).map((v: any) => <option key={v.id} value={v.id}>{v.name}</option>)}</select>
          <label className="flex items-center gap-1.5 text-[13px] text-sub">From<input type="date" className="input !w-auto" value={from} onChange={(e) => { setFrom(e.target.value); setPage(1); }} /></label>
          <label className="flex items-center gap-1.5 text-[13px] text-sub">To<input type="date" className="input !w-auto" value={to} onChange={(e) => { setTo(e.target.value); setPage(1); }} /></label>
          <div className="relative w-full max-w-xs"><Search className="pointer-events-none absolute left-2.5 top-2 h-3.5 w-3.5 text-sub" /><input ref={search} className="input !pl-8 !pr-7" placeholder="Search PO number, reference, vendor…  ( / )" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} />{q && <button className="absolute right-1.5 top-1.5 rounded p-0.5 text-sub hover:bg-muted" onClick={() => setQ("")} aria-label="Clear search"><X className="h-3.5 w-3.5" /></button>}</div></div>
        {error ? <p className="p-4 text-red-500">{error}</p> : (
          <DataTable storageKey="sp_po_cols" columns={columns} rows={data?.items || []} rowKey={(r) => r.id} loading={loading} hasData={!!data} sort={sort} desc={desc} onSort={sortBy} onRowOpen={(p) => go(`/purchase-orders/${p.id}`)} animKey={qs} minWidth={900}
            empty={<Empty title={q || vendor || from || to || status !== "all" ? "No purchase orders match these filters" : "No purchase orders yet"} hint={w ? "Create one, or use Reorder suggestions to draft orders from low stock." : undefined} action={w && status === "all" && !q ? <button className="btn-primary" onClick={() => go("/purchase-orders/new")}><Plus className="h-4 w-4" />New Purchase Order</button> : undefined} />}
            rowActions={(p) => (<div className="flex items-center justify-end gap-0.5"><span className="row-actions flex gap-0.5"><button className="rounded p-1 hover:bg-muted" aria-label={`View ${p.number}`} data-tip="View" onClick={() => go(`/purchase-orders/${p.id}`)}><Eye className="h-4 w-4" /></button>
              <button className="rounded p-1 hover:bg-muted" aria-label={`PDF ${p.number}`} data-tip="Open PDF" onClick={() => openPdf(`/purchase-orders/${p.id}/pdf`).catch((e) => toast(e.message, "err"))}><FileText className="h-4 w-4" /></button></span>
              <RowMenu items={[{ label: "View", icon: Eye, onClick: () => go(`/purchase-orders/${p.id}`) }, { label: "Edit", icon: Pencil, onClick: () => go(`/purchase-orders/${p.id}/edit`), hidden: !w || p.status !== "draft" },
                { label: "Issue to vendor", icon: Send, onClick: () => act(p.id, "issue", `${p.number} issued`), hidden: !w || p.status !== "draft" }, { label: "Receive goods", icon: PackageCheck, onClick: () => go(`/purchase-orders/${p.id}?receive=1`), hidden: !can("inventory", "w") || !["issued", "partially_received"].includes(p.status) },
                { label: "Download PDF", icon: Download, onClick: () => savePdf(`/purchase-orders/${p.id}/pdf`, `${p.number}.pdf`).catch((e) => toast(e.message, "err")) }, { label: "Print", icon: Printer, onClick: () => printPdf(`/purchase-orders/${p.id}/pdf`).catch((e) => toast(e.message, "err")) },
                { label: "Cancel order", icon: Ban, onClick: () => setCancel(p), danger: true, hidden: !w || p.status !== "issued" }, { label: "Delete draft", icon: Trash2, onClick: () => setDel(p), danger: true, hidden: !w || p.status !== "draft" }]} /></div>)} />)}
        {data && <Pagination total={data.total} page={page} size={size} setPage={setPage} setSize={setSize} noun="purchase orders" />}
      </div>
      {del && <Confirm title="Delete draft" text={`Delete draft ${del.number}? This can't be undone.`} action="Delete" onConfirm={() => remove(del)} onClose={() => setDel(null)} />}
      {cancel && <Confirm title="Cancel purchase order" text={`Cancel ${cancel.number}? The vendor order is voided. Orders with received goods can't be cancelled.`} action="Cancel order" onConfirm={() => act(cancel.id, "cancel", `${cancel.number} cancelled`)} onClose={() => setCancel(null)} />}
      {sug && <Suggestions whs={(whs.data || []).filter((x: any) => x.is_active)} onClose={() => setSug(false)} onDone={reload} />}
    </div>
  );
}

/* ============================== form ============================== */
type FLine = { key: number; product_id: number | ""; quantity: string; rate: string; discount_pct: string; tax_rate: string };
let lineKey = 1;
const blankLine = (): FLine => ({ key: lineKey++, product_id: "", quantity: "1", rate: "", discount_pct: "0", tax_rate: "" });

export function POForm() {
  const { id } = useParams(); const [sp] = useSearchParams(); const go = useNavigate(); const toast = useToast(); const { me } = useMe(); const edit = !!id;
  const existing = useLoad(() => (id ? api(`/purchase-orders/${id}`) : Promise.resolve(null)), [id]);
  const vendors = useLoad(() => api("/vendors?page_size=200&status=active")); const whs = useLoad(() => api("/warehouses")); const items = useLoad(() => api("/products?page_size=200&status=active"));
  const [vendorId, setVendorId] = useState<number | "">(sp.get("vendor") ? +sp.get("vendor")! : ""); const [wh, setWh] = useState<string>(""); const [orderDate, setOrderDate] = useState(today()); const [expected, setExpected] = useState(""); const [ref, setRef] = useState(""); const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<FLine[]>([blankLine()]); const [errs, setErrs] = useState<Record<string, string>>({}); const [busy, setBusy] = useState<"" | "draft" | "issue">(""); const [done, setDone] = useState(""); const [banner, setBanner] = useState(""); const [shake, setShake] = useState(0); const [submitted, setSubmitted] = useState(false);
  useEffect(() => { if (!edit && whs.data?.length && !wh) setWh(String(whs.data.find((x: any) => x.is_active)?.id || "")); }, [whs.data]); // eslint-disable-line
  useEffect(() => { const d = existing.data; if (!d) return; setVendorId(d.vendor_id); setWh(String(d.warehouse_id)); setOrderDate(d.order_date); setExpected(d.expected_date || ""); setRef(d.reference || ""); setNotes(d.notes || ""); setLines(d.lines.map((l: any) => ({ key: lineKey++, product_id: l.product_id, quantity: String(l.quantity), rate: String(l.rate), discount_pct: String(l.discount_pct), tax_rate: String(l.tax_rate) }))); }, [existing.data]);
  useEffect(() => { const it = sp.get("item"); if (!edit && it && items.data) { const p = items.data.items.find((x: any) => x.id === +it); if (p) setLines([{ ...blankLine(), product_id: p.id, rate: String(p.purchase_price), tax_rate: String(p.tax_rate) }]); } }, [items.data]); // eslint-disable-line
  const vendor = (vendors.data?.items || []).find((v: any) => v.id === vendorId) || (existing.data ? { gstin: existing.data.vendor_info.gstin, bill_state: null } : null);
  const mode = vendor ? gstMode(me.org, vendor) : "intra";
  const prods: any[] = items.data?.items || [];
  const num = (s: string) => (s === "" || isNaN(+s) ? 0 : +s);
  const t = useMemo(() => calcTotals(lines.map((l) => ({ quantity: num(l.quantity), rate: num(l.rate), discount_pct: num(l.discount_pct), tax_rate: num(l.tax_rate) })), mode), [lines, mode]);
  const setLine = (k: number, p: Partial<FLine>) => setLines((ls) => ls.map((l) => (l.key === k ? { ...l, ...p } : l)));
  const pickItem = (k: number, p: any) => setLine(k, { product_id: p.id, rate: String(p.purchase_price), tax_rate: String(p.tax_rate) });
  const validate = () => {
    const e: Record<string, string> = {};
    if (!vendorId) e.vendor = "Choose a vendor"; if (!wh) e.wh = "Choose a receiving warehouse";
    if (expected && expected < orderDate) e.expected = "Can't be before the order date";
    lines.forEach((l, i) => { if (!l.product_id) e[`l${i}.item`] = "Choose an item"; if (!(num(l.quantity) > 0)) e[`l${i}.qty`] = "Enter a quantity above 0"; if (l.rate === "" || num(l.rate) < 0) e[`l${i}.rate`] = "Enter a rate"; if (num(l.discount_pct) < 0 || num(l.discount_pct) > 100) e[`l${i}.disc`] = "0–100"; });
    setErrs(e); return !Object.keys(e).length;
  };
  // after the first submit attempt, errors follow the form: they disappear as soon as the field is fixed
  useEffect(() => { if (submitted) validate(); }, [submitted, vendorId, wh, orderDate, expected, lines]); // eslint-disable-line
  const save = async (issue: boolean) => {
    setBanner(""); setSubmitted(true); if (!validate()) { setShake((n) => n + 1); return; }
    setBusy(issue ? "issue" : "draft");
    try {
      const body = { vendor_id: +vendorId, warehouse_id: +wh, order_date: orderDate, expected_date: expected || null, reference: ref || null, notes: notes || null, lines: lines.map((l) => ({ product_id: +l.product_id, quantity: num(l.quantity), rate: num(l.rate), discount_pct: num(l.discount_pct), tax_rate: num(l.tax_rate) })) };
      let po = edit ? await api(`/purchase-orders/${id}`, { method: "PUT", body }) : await api("/purchase-orders", { body });
      if (issue) po = await api(`/purchase-orders/${po.id}/issue`, { method: "POST" });
      window.dispatchEvent(new Event("sp-data-changed")); setDone(`${po.number} ${issue ? "issued" : "saved as draft"}`);
      setTimeout(() => { toast(`${po.number} ${issue ? "issued" : "saved"}`); go(`/purchase-orders/${po.id}`); }, 850);
    } catch (e: any) { setBanner(e.message); setShake((n) => n + 1); setBusy(""); }
  };
  if (edit && existing.loading) return <div className="card"><Skeleton rows={8} /></div>;
  if (edit && existing.data && existing.data.status !== "draft") return <div className="card"><Empty title="Only draft orders can be edited" action={<Link className="btn-primary" to={`/purchase-orders/${id}`}>Back to order</Link>} /></div>;
  const E = ({ k }: { k: string }) => <p className="mt-0.5 min-h-[0.9rem] text-[11px] text-red-600" role={errs[k] ? "alert" : undefined}>{errs[k] || ""}</p>;
  return (
    <div className="relative space-y-3">
      <div className="flex items-center gap-2 text-[13px] text-sub"><Link to="/purchase-orders" className="hover:text-ink">Purchase Orders</Link><span>/</span><span className="text-ink">{edit ? `Edit ${existing.data?.number}` : "New purchase order"}</span></div>
      <h1 className="text-lg font-semibold">{edit ? `Edit ${existing.data?.number ?? ""}` : "New Purchase Order"}</h1>
      <div key={shake} className={shake ? "anim-shake" : ""}>
        <section className="card"><h2 className="border-b px-4 py-2.5 text-[13px] font-semibold">Order details</h2>
          <div className="grid gap-x-6 gap-y-1 p-4 md:grid-cols-2 lg:grid-cols-3">
            <Field label="Vendor *"><Combobox options={vendors.data?.items || []} value={vendorId} onChange={(v: any) => setVendorId(v.id)} render={(v: any) => <span>{v.name}<span className="ml-2 text-xs text-sub">{v.code}</span></span>} search={(v: any) => `${v.name}|${v.code} ${v.company_name || ""}`} placeholder="Search vendors…" invalid={!!errs.vendor} /><E k="vendor" /></Field>
            <Field label="Receive into *"><select className={`input ${errs.wh ? "input-error" : ""}`} value={wh} onChange={(e) => setWh(e.target.value)}><option value="">Select…</option>{(whs.data || []).filter((x: any) => x.is_active).map((x: any) => <option key={x.id} value={x.id}>{x.code} — {x.name}</option>)}</select><E k="wh" /></Field>
            <Field label="Reference"><input className="input" maxLength={60} value={ref} onChange={(e) => setRef(e.target.value)} placeholder="Vendor quote / indent no." /><p className="min-h-[0.9rem]" /></Field>
            <Field label="Order date"><input type="date" className="input" value={orderDate} onChange={(e) => setOrderDate(e.target.value)} /><p className="min-h-[0.9rem]" /></Field>
            <Field label="Expected delivery"><input type="date" min={orderDate} className={`input ${errs.expected ? "input-error" : ""}`} value={expected} onChange={(e) => setExpected(e.target.value)} /><E k="expected" /></Field>
            <div className="text-[13px] text-sub"><p className="label">Tax treatment</p><p className="pt-1.5">{vendor ? (mode === "inter" ? <Badge tone="info">IGST · inter-state</Badge> : <Badge tone="neutral">CGST + SGST · intra-state</Badge>) : "Choose a vendor"}</p>{vendors.data && vendor && "payment_terms" in vendor && <p className="mt-1 text-xs">Terms: {vendor.payment_terms === 0 ? "due on receipt" : `Net ${vendor.payment_terms} days`}</p>}</div>
          </div></section>
        <section className="card mt-3"><div className="flex items-center justify-between border-b px-4 py-2.5"><h2 className="text-[13px] font-semibold">Items</h2><span className="text-xs text-sub">Prices and GST default from the item and can be overridden</span></div>
          <div className="overflow-x-auto"><table className="w-full min-w-[820px] text-[13px]"><thead className="border-b bg-muted/60"><tr>{["#", "Item", "Qty", "Rate (₹)", "Disc %", "GST %", "Amount", ""].map((h, i) => <th key={i} className={`th ${i >= 2 && i <= 6 ? "text-right" : ""}`}>{h}</th>)}</tr></thead>
            <tbody className="divide-y">{lines.map((l, i) => { const a = t.lines[i]; const p = prods.find((x) => x.id === l.product_id); return (
              <tr key={l.key} className="align-top"><td className="td w-8 text-sub">{i + 1}</td>
                <td className="td min-w-[260px]"><Combobox options={prods} value={l.product_id} onChange={(p: any) => pickItem(l.key, p)} render={(p: any) => <span>{p.name}<span className="ml-2 text-xs text-sub">{p.sku} · {fmt(p.available)} avail</span></span>} search={(p: any) => `${p.name}|${p.sku} ${p.barcode || ""}`} placeholder="Search items…" invalid={!!errs[`l${i}.item`]} /><E k={`l${i}.item`} />{p && <p className="text-[11px] text-sub">{fmt(p.on_hand)} on hand · unit {p.unit}</p>}</td>
                <td className="td w-24"><input type="number" min="0" step="any" className={`input text-right ${errs[`l${i}.qty`] ? "input-error" : ""}`} value={l.quantity} onChange={(e) => setLine(l.key, { quantity: e.target.value })} onKeyDown={(e) => { if (e.key === "Enter" && i === lines.length - 1) { e.preventDefault(); setLines((ls) => [...ls, blankLine()]); } }} /><E k={`l${i}.qty`} /></td>
                <td className="td w-28"><input type="number" min="0" step="0.01" className={`input text-right ${errs[`l${i}.rate`] ? "input-error" : ""}`} value={l.rate} onChange={(e) => setLine(l.key, { rate: e.target.value })} /><E k={`l${i}.rate`} /></td>
                <td className="td w-20"><input type="number" min="0" max="100" step="0.01" className={`input text-right ${errs[`l${i}.disc`] ? "input-error" : ""}`} value={l.discount_pct} onChange={(e) => setLine(l.key, { discount_pct: e.target.value })} /><E k={`l${i}.disc`} /></td>
                <td className="td w-24"><select className="input" value={l.tax_rate} onChange={(e) => setLine(l.key, { tax_rate: e.target.value })}>{!["0", "3", "5", "12", "18", "28"].includes(l.tax_rate) && l.tax_rate !== "" && <option value={l.tax_rate}>{l.tax_rate}%</option>}{l.tax_rate === "" && <option value="">—</option>}{[0, 3, 5, 12, 18, 28].map((r) => <option key={r} value={r}>{r}%</option>)}</select></td>
                <td className="td w-32 pt-3 text-right tabular-nums">{money(a?.amount || 0)}</td>
                <td className="td w-10"><button type="button" className="rounded p-1 text-sub hover:bg-muted hover:text-red-600 disabled:opacity-30" disabled={lines.length === 1} onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))} aria-label={`Remove line ${i + 1}`}><Trash2 className="h-4 w-4" /></button></td></tr>); })}</tbody></table></div>
          <div className="flex items-center justify-between border-t p-3"><button type="button" className="btn-ghost" onClick={() => setLines((ls) => [...ls, blankLine()])}><Plus className="h-3.5 w-3.5" />Add line</button>
            <dl className="w-72 space-y-1 text-[13px]"><div className="flex justify-between"><dt className="text-sub">Subtotal</dt><dd className="tabular-nums">{money(t.subtotal)}</dd></div>{t.discount > 0 && <div className="flex justify-between"><dt className="text-sub">Discount</dt><dd className="tabular-nums">−{money(t.discount)}</dd></div>}<div className="flex justify-between"><dt className="text-sub">Taxable amount</dt><dd className="tabular-nums">{money(t.taxable)}</dd></div>
              {mode === "inter" ? <div className="flex justify-between"><dt className="text-sub">IGST</dt><dd className="tabular-nums">{money(t.igst)}</dd></div> : <><div className="flex justify-between"><dt className="text-sub">CGST</dt><dd className="tabular-nums">{money(t.cgst)}</dd></div><div className="flex justify-between"><dt className="text-sub">SGST</dt><dd className="tabular-nums">{money(t.sgst)}</dd></div></>}
              <div className="flex justify-between border-t pt-1.5 text-base font-semibold"><dt>Total</dt><dd className="tabular-nums"><Num value={t.total} prefix="₹" decimals={2} /></dd></div></dl></div></section>
        <section className="card mt-3 p-4"><Field label="Notes (printed on the order)"><textarea className="input min-h-[60px]" maxLength={500} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field></section>
      </div>
      <div className="min-h-[2rem]">{banner && <p className="anim-fade rounded-md bg-red-500/10 px-3 py-2 text-[13px] text-red-600" role="alert">{banner}</p>}</div>
      <div className="flex flex-wrap gap-2"><button className={`btn-primary ${busy === "issue" ? "btn-loading" : ""}`} disabled={!!busy} onClick={() => save(true)}><Send className="h-3.5 w-3.5" />Save &amp; issue</button><button className={`btn-ghost ${busy === "draft" ? "btn-loading" : ""}`} disabled={!!busy} onClick={() => save(false)}>Save as draft</button><button className="btn-ghost" disabled={!!busy} onClick={() => go(edit ? `/purchase-orders/${id}` : "/purchase-orders")}>Cancel</button></div>
      {done && <div className="anim-fade fixed inset-0 z-50 flex flex-col items-center justify-center gap-2 bg-surface/90"><SuccessCheck size={64} /><p className="text-base font-semibold">{done}</p></div>}
    </div>
  );
}

/* ============================== detail ============================== */
function ReceiveDialog({ po, whs, onClose, onDone }: { po: any; whs: any[]; onClose: () => void; onDone: () => void }) {
  const toast = useToast(); const key = useMemo(() => crypto.randomUUID(), []);
  const open = po.lines.filter((l: any) => l.outstanding > 0);
  const [wh, setWh] = useState(String(po.warehouse_id)); const [on, setOn] = useState(today()); const [notes, setNotes] = useState(""); const [q, setQ] = useState<Record<number, string>>(Object.fromEntries(open.map((l: any) => [l.id, String(l.outstanding)]))); const [busy, setBusy] = useState(false);
  const total = open.reduce((a: number, l: any) => a + (+q[l.id] || 0), 0);
  const bad = open.some((l: any) => +q[l.id] < 0 || +q[l.id] > l.outstanding || isNaN(+q[l.id]));
  const submit = async () => {
    setBusy(true);
    try { const lines = open.filter((l: any) => +q[l.id] > 0).map((l: any) => ({ po_line_id: l.id, quantity: +q[l.id] })); const r = await api(`/purchase-orders/${po.id}/receive`, { body: { warehouse_id: +wh, received_on: on, notes: notes || null, idempotency_key: key, lines } }); toast(`${r.number} posted — stock updated`); window.dispatchEvent(new Event("sp-data-changed")); onDone(); onClose(); }
    catch (e: any) { toast(e.message, "err"); } finally { setBusy(false); }
  };
  return (
    <Modal title={`Receive goods — ${po.number}`} onClose={onClose} wide>
      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2"><Field label="Receive into warehouse"><select className="input" value={wh} onChange={(e) => setWh(e.target.value)}>{whs.map((w) => <option key={w.id} value={w.id}>{w.code} — {w.name}</option>)}</select></Field><Field label="Received on"><input type="date" className="input" max={today()} value={on} onChange={(e) => setOn(e.target.value)} /></Field></div>
        <table className="w-full text-[13px]"><thead className="border-b"><tr><th className="th">Item</th><th className="th text-right">Ordered</th><th className="th text-right">Received</th><th className="th text-right">Outstanding</th><th className="th w-28 text-right">Receive now</th></tr></thead>
          <tbody className="divide-y">{open.map((l: any) => <tr key={l.id}><td className="td">{l.name}<span className="ml-2 text-xs text-sub">{l.sku}</span></td><td className="td text-right tabular-nums">{fmt(l.quantity)}</td><td className="td text-right tabular-nums">{fmt(l.qty_received)}</td><td className="td text-right tabular-nums">{fmt(l.outstanding)}</td>
            <td className="td"><input type="number" min="0" max={l.outstanding} step="any" className={`input text-right ${+q[l.id] > l.outstanding ? "input-error" : ""}`} value={q[l.id]} onChange={(e) => setQ({ ...q, [l.id]: e.target.value })} /></td></tr>)}</tbody></table>
        <Field label="Notes"><input className="input" maxLength={300} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Delivery challan no., condition, etc." /></Field>
        <p className="text-xs text-sub">Posting adds this quantity to stock in the chosen warehouse and updates the item's average cost. Partial deliveries are fine — the order stays open for the rest.</p>
        <div className="flex justify-end gap-2"><button className="btn-ghost" onClick={onClose}>Cancel</button><button className={`btn-primary ${busy ? "btn-loading" : ""}`} disabled={busy || bad || total <= 0} onClick={submit}><PackageCheck className="h-3.5 w-3.5" />Post receipt ({fmt(total)} units)</button></div>
      </div>
    </Modal>
  );
}

const STEPS: [string, string][] = [["draft", "Draft"], ["issued", "Issued"], ["partially_received", "Partially received"], ["received", "Received"]];

export function PODetail() {
  const { id = "" } = useParams(); const [sp, setSp] = useSearchParams(); const { can } = useMe(); const toast = useToast(); const go = useNavigate();
  const { data: po, loading, error, reload } = useLoad(() => api(`/purchase-orders/${id}`), [id]);
  const whs = useLoad(() => api("/warehouses"));
  const [recv, setRecv] = useState(sp.get("receive") === "1"); const [cancel, setCancel] = useState(false); const [del, setDel] = useState(false); const [issue, setIssue] = useState(false);
  const [tab, setTab] = useState<"lines" | "receipts" | "activity">("lines");
  if (loading && !po) return <div className="card"><Skeleton rows={6} /></div>;
  if (error || !po) return <div className="card"><Empty title="Purchase order not found" hint={error} /></div>;
  const w = can("purchases", "w"), iw = can("inventory", "w"); const st = po.status; const idx = STEPS.findIndex((s) => s[0] === st);
  const run = async (what: string, msg: string) => { try { await api(`/purchase-orders/${id}/${what}`, { method: "POST" }); toast(msg); reload(); } catch (e: any) { toast(e.message, "err"); } };
  const remove = async () => { try { await api(`/purchase-orders/${id}`, { method: "DELETE" }); toast("Draft deleted"); go("/purchase-orders"); } catch (e: any) { toast(e.message, "err"); } };
  const KV = ({ k, v }: { k: string; v: React.ReactNode }) => <div className="flex justify-between gap-3 py-1 text-[13px]"><dt className="text-sub">{k}</dt><dd className="text-right font-medium tabular-nums">{v}</dd></div>;
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-[13px] text-sub"><Link to="/purchase-orders" className="hover:text-ink">Purchase Orders</Link><span>/</span><span className="text-ink">{po.number}</span></div>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div><div className="flex flex-wrap items-center gap-2"><h1 className="text-lg font-semibold">{po.number}</h1><POBadge s={st} />{po.overdue && <Badge tone="bad">Overdue</Badge>}</div>
          <p className="text-[13px] text-sub"><Link className="text-brand hover:underline" to={`/vendors/${po.vendor_id}`}>{po.vendor}</Link> · ordered {d8(po.order_date)}{po.expected_date && ` · expected ${d8(po.expected_date)}`} · into {po.warehouse}</p></div>
        <div className="flex flex-wrap items-center gap-2">
          {w && st === "draft" && <button className="btn-ghost" onClick={() => go(`/purchase-orders/${id}/edit`)}><Pencil className="h-3.5 w-3.5" />Edit</button>}
          {w && st === "draft" && <button className="btn-primary" onClick={() => setIssue(true)}><Send className="h-3.5 w-3.5" />Issue</button>}
          {iw && (st === "issued" || st === "partially_received") && <button className="btn-primary" onClick={() => setRecv(true)}><PackageCheck className="h-3.5 w-3.5" />Receive goods</button>}
          <button className="btn-ghost" onClick={() => openPdf(`/purchase-orders/${id}/pdf`).catch((e) => toast(e.message, "err"))}><FileText className="h-3.5 w-3.5" />PDF</button>
          <button className="btn-ghost" onClick={() => printPdf(`/purchase-orders/${id}/pdf`).catch((e) => toast(e.message, "err"))}><Printer className="h-3.5 w-3.5" />Print</button>
          {w && ["draft", "issued", "partially_received"].includes(st) && <div className="rounded-md border bg-surface"><RowMenu items={[{ label: "Download PDF", icon: Download, onClick: () => savePdf(`/purchase-orders/${id}/pdf`, `${po.number}.pdf`).catch((e) => toast(e.message, "err")) },
            { label: "Cancel order", icon: Ban, onClick: () => setCancel(true), danger: true, hidden: st === "partially_received" }, { label: "Delete draft", icon: Trash2, onClick: () => setDel(true), danger: true, hidden: st !== "draft" }]} /></div>}</div>
      </div>
      {st !== "cancelled" ? (
        <ol className="flex items-center gap-0 overflow-x-auto rounded-lg border bg-surface p-3" aria-label="Order progress">{STEPS.map(([k, l], i) => { const on = i <= idx; return (
          <li key={k} className="flex flex-1 items-center gap-2 whitespace-nowrap"><span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold transition-colors duration-300 ${on ? "bg-brand text-white dark:text-slate-900" : "bg-muted text-sub"}`}>{on && i < idx ? <Check className="h-3.5 w-3.5" /> : i + 1}</span><span className={`text-[13px] ${i === idx ? "font-semibold text-ink" : "text-sub"}`}>{l}</span>{i < STEPS.length - 1 && <span className={`mx-2 h-0.5 min-w-[1.5rem] flex-1 rounded transition-colors duration-500 ${i < idx ? "bg-brand" : "bg-line"}`} />}</li>); })}</ol>
      ) : <div className="rounded-lg border border-red-500/30 bg-red-500/5 px-4 py-2.5 text-[13px] text-red-700 dark:text-red-400">This order was cancelled and has no effect on stock.</div>}
      <div className="grid gap-3 lg:grid-cols-3">
        <div className="space-y-3 lg:col-span-2">
          <TabBar tabs={[["lines", "Items"], ["receipts", `Receipts (${po.receipts.length})`], ["activity", "Activity"]] as const} active={tab} onChange={(k) => setTab(k as any)} />
          <div key={tab} className="anim-up">
            {tab === "lines" && <div className="card overflow-x-auto"><table className="w-full min-w-[720px]"><thead className="border-b bg-muted/60"><tr>{["#", "Item", "Ordered", "Received", "Rate", "Disc.", "GST", "Amount"].map((h, i) => <th key={h} className={`th ${i >= 2 ? "text-right" : ""}`}>{h}</th>)}</tr></thead>
              <tbody className="divide-y">{po.lines.map((l: any, i: number) => <tr key={l.id} className="hover:bg-muted/60"><td className="td text-sub">{i + 1}</td><td className="td"><Link className="font-medium text-brand hover:underline" to={`/products/${l.product_id}`}>{l.name}</Link><div className="text-xs text-sub">{l.sku}{l.hsn_code && ` · HSN ${l.hsn_code}`}</div></td>
                <td className="td text-right tabular-nums">{fmt(l.quantity)} {l.unit}</td><td className="td text-right"><span className="tabular-nums">{fmt(l.qty_received)}</span>{["issued", "partially_received", "received"].includes(st) && <div className="ml-auto mt-1 h-1 w-16 overflow-hidden rounded bg-muted"><div className={`h-full ${l.outstanding === 0 ? "bg-emerald-500" : "bg-brand"}`} style={{ width: `${(l.qty_received / l.quantity) * 100}%` }} /></div>}</td>
                <td className="td text-right tabular-nums">{money(l.rate)}</td><td className="td text-right tabular-nums">{l.discount_pct ? `${l.discount_pct}%` : "—"}</td><td className="td text-right tabular-nums">{l.tax_rate}%</td><td className="td text-right tabular-nums">{money(l.amount)}</td></tr>)}</tbody></table></div>}
            {tab === "receipts" && <div className="space-y-3">{!po.receipts.length ? <div className="card"><Empty title="No goods received yet" hint={iw && ["issued", "partially_received"].includes(st) ? "Use Receive goods when a delivery arrives." : undefined} /></div> : po.receipts.map((g: any) => (
              <div key={g.id} className="card"><div className="flex flex-wrap items-center justify-between gap-2 border-b px-3 py-2 text-[13px]"><span className="font-semibold">{g.number}</span><span className="text-sub">{d8(g.received_on)} · {g.warehouse}{g.received_by && ` · ${g.received_by}`}</span></div>
                <ul className="divide-y">{g.lines.map((l: any) => { const pl = po.lines.find((x: any) => x.id === l.po_line_id); return <li key={l.po_line_id} className="flex justify-between px-3 py-1.5 text-[13px]"><span>{pl?.name}<span className="ml-2 text-xs text-sub">{pl?.sku}</span></span><span className="tabular-nums">+{fmt(l.quantity)} <span className="text-xs text-sub">@ {money(l.unit_cost)}</span></span></li>; })}</ul>{g.notes && <p className="border-t px-3 py-1.5 text-xs text-sub">{g.notes}</p>}</div>))}</div>}
            {tab === "activity" && <div className="card p-4"><ol className="relative space-y-4 before:absolute before:bottom-2 before:left-[7px] before:top-2 before:w-px before:bg-line">{po.activity.map((a: any, i: number) => <li key={i} className="relative flex gap-3"><span className="relative z-10 mt-1 h-3.5 w-3.5 shrink-0 rounded-full border-2 border-brand bg-surface" /><div><p className="text-[13px] font-medium capitalize">{a.action}{a.detail?.grn ? <span className="font-normal normal-case text-sub"> — {a.detail.grn}</span> : null}{a.detail?.source === "suggestions" ? <span className="font-normal normal-case text-sub"> — from reorder suggestions</span> : null}</p><p className="text-xs text-sub">{dt(a.when)}{a.user ? ` · ${a.user}` : ""}</p></div></li>)}</ol></div>}
          </div>
        </div>
        <div className="space-y-3">
          <section className="card"><h3 className="border-b px-3 py-2 text-[13px] font-semibold">Summary</h3><dl className="divide-y p-3"><KV k="Subtotal" v={money(po.subtotal)} />{po.discount_total > 0 && <KV k="Discount" v={`−${money(po.discount_total)}`} />}<KV k="Taxable amount" v={money(po.taxable_total)} />
            {po.gst_mode === "inter" ? <KV k="IGST" v={money(po.igst)} /> : <><KV k="CGST" v={money(po.cgst)} /><KV k="SGST" v={money(po.sgst)} /></>}<div className="flex justify-between pt-2 text-base font-semibold"><dt>Total</dt><dd className="tabular-nums"><Num value={po.total} prefix="₹" decimals={2} /></dd></div></dl></section>
          <section className="card"><h3 className="border-b px-3 py-2 text-[13px] font-semibold">Vendor</h3><div className="space-y-1 p-3 text-[13px]"><Link className="font-medium text-brand hover:underline" to={`/vendors/${po.vendor_id}`}>{po.vendor}</Link><p className="text-sub">{po.vendor_code}</p>{po.vendor_info.gstin && <p>GSTIN {po.vendor_info.gstin}</p>}{po.vendor_info.email && <p className="text-sub">{po.vendor_info.email}</p>}{po.vendor_info.phone && <p className="text-sub">{po.vendor_info.phone}</p>}<p className="text-sub">Terms: {po.vendor_info.payment_terms === 0 ? "due on receipt" : `Net ${po.vendor_info.payment_terms} days`}</p><p className="pt-1"><Badge tone={po.gst_mode === "inter" ? "info" : "neutral"}>{po.gst_mode === "inter" ? "IGST · inter-state" : "CGST + SGST · intra-state"}</Badge></p></div></section>
          {(po.reference || po.notes) && <section className="card p-3 text-[13px]">{po.reference && <p><span className="text-sub">Reference </span>{po.reference}</p>}{po.notes && <p className="mt-1 text-sub">{po.notes}</p>}</section>}
        </div>
      </div>
      {recv && <ReceiveDialog po={po} whs={(whs.data || []).filter((x: any) => x.is_active)} onClose={() => { setRecv(false); if (sp.get("receive")) setSp({}); }} onDone={reload} />}
      {issue && <Confirm title="Issue purchase order" text={`Issue ${po.number} to ${po.vendor}? It can no longer be edited, and goods can then be received against it.`} action="Issue" onConfirm={() => run("issue", `${po.number} issued`)} onClose={() => setIssue(false)} />}
      {cancel && <Confirm title="Cancel purchase order" text={`Cancel ${po.number}? This can't be undone.`} action="Cancel order" onConfirm={() => run("cancel", `${po.number} cancelled`)} onClose={() => setCancel(false)} />}
      {del && <Confirm title="Delete draft" text={`Delete draft ${po.number}?`} action="Delete" onConfirm={remove} onClose={() => setDel(false)} />}
    </div>
  );
}
