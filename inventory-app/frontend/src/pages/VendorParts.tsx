import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Banknote, FileText, PackageCheck, ReceiptText } from "lucide-react";
import { api, dt, money } from "../api";
import { useMe } from "../App";
import { Num } from "../fx";
import { Badge, Empty, Field, Modal, Skeleton, useLoad, useToast } from "../ui";
import { d8, POBadge } from "./PurchaseOrders";
import { SOBadge } from "./SalesOrders";

export function PaymentDialog({ vendorId, outstanding, onClose, partyType = "vendor" }: { vendorId: string; outstanding: number; onClose: () => void; partyType?: "vendor" | "customer" }) {
  const toast = useToast();
  const [amount, setAmount] = useState(String(outstanding)); const [on, setOn] = useState(new Date().toISOString().slice(0, 10)); const [method, setMethod] = useState("bank_transfer"); const [ref, setRef] = useState(""); const [notes, setNotes] = useState(""); const [busy, setBusy] = useState(false);
  const bad = !(+amount > 0) || +amount > outstanding + 0.001;
  const submit = async () => {
    setBusy(true);
    try { const r = await api("/payments", { body: { party_type: partyType, party_id: +vendorId, amount: +amount, paid_on: on, method, reference: ref || null, notes: notes || null } }); toast(`${r.number} recorded`); window.dispatchEvent(new Event("sp-data-changed")); onClose(); }
    catch (e: any) { toast(e.message, "err"); } finally { setBusy(false); }
  };
  return (
    <Modal title={partyType === "vendor" ? "Record payment to vendor" : "Record payment received"} onClose={onClose}>
      <div className="space-y-3">
        <p className="rounded-md bg-muted px-3 py-2 text-[13px]">{partyType === "vendor" ? "Outstanding for goods received" : "Outstanding for goods shipped"}: <b>{money(outstanding)}</b></p>
        <Field label="Amount (₹)"><input type="number" min="0.01" step="0.01" max={outstanding} autoFocus className={`input ${+amount > outstanding ? "input-error" : ""}`} value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
        {+amount > outstanding && <p className="-mt-2 text-xs text-red-600">Can't exceed the outstanding balance.</p>}
        <div className="grid grid-cols-2 gap-3"><Field label="Paid on"><input type="date" className="input" max={new Date().toISOString().slice(0, 10)} value={on} onChange={(e) => setOn(e.target.value)} /></Field>
          <Field label="Method"><select className="input" value={method} onChange={(e) => setMethod(e.target.value)}>{[["bank_transfer", "Bank transfer"], ["upi", "UPI"], ["cheque", "Cheque"], ["cash", "Cash"], ["card", "Card"], ["other", "Other"]].map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field></div>
        <Field label="Reference / UTR"><input className="input" maxLength={80} value={ref} onChange={(e) => setRef(e.target.value)} /></Field>
        <Field label="Notes"><input className="input" maxLength={300} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
        <div className="flex justify-end gap-2"><button className="btn-ghost" onClick={onClose}>Cancel</button><button className={`btn-primary ${busy ? "btn-loading" : ""}`} disabled={busy || bad} onClick={submit}>Record payment</button></div>
      </div>
    </Modal>
  );
}

export function VendorStatsStrip({ id }: { id: string }) {
  const { can } = useMe(); const { data: s, loading } = useLoad(() => api(`/vendors/${id}/stats`), [id]); const [pay, setPay] = useState(false);
  if (loading && !s) return <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">{Array.from({ length: 5 }).map((_, i) => <div key={i} className="skeleton h-16" />)}</div>;
  if (!s) return null;
  const cards: [string, number, boolean, string][] = [["Total purchased", s.total_purchased, true, "issued + received orders"], ["Goods received", s.received_value, true, "value incl. GST"], ["Paid", s.paid, true, "recorded payments"], ["Outstanding", s.outstanding, true, "received − paid"], ["Open orders", s.open_orders, false, `${s.orders} orders in total`]];
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">{cards.map(([l, v, m, sub], i) => <div key={l} style={{ ["--i" as any]: i }} className={`stagger card p-3 ${l === "Outstanding" && v > 0 ? "border-amber-500/50" : ""}`}><p className="text-[11px] font-medium text-sub">{l}</p><p className="mt-0.5 text-lg font-semibold"><Num value={v} prefix={m ? "₹" : ""} decimals={m ? 2 : 0} /></p><p className="text-[11px] text-sub">{sub}</p></div>)}</div>
      {can("purchases", "w") && s.outstanding > 0 && <div className="flex justify-end"><button className="btn-primary" onClick={() => setPay(true)}><Banknote className="h-3.5 w-3.5" />Record payment</button></div>}
      {pay && <PaymentDialog vendorId={id} outstanding={s.outstanding} onClose={() => setPay(false)} />}
    </div>
  );
}

export function PerformanceCard({ id }: { id: string }) {
  const { data: s } = useLoad(() => api(`/vendors/${id}/stats`), [id]);
  if (!s) return null;
  const p = s.performance;
  const M = ({ label, v, suffix, hint }: { label: string; v: number | null; suffix: string; hint: string }) => (
    <div className="rounded-md border p-3"><p className="text-[11px] font-medium text-sub">{label}</p>{v === null ? <p className="mt-0.5 text-lg font-semibold text-sub">—</p> : <p className="mt-0.5 text-lg font-semibold"><Num value={v} decimals={v % 1 ? 1 : 0} suffix={suffix} /></p>}<p className="text-[11px] text-sub">{v === null ? "Not enough completed orders yet" : hint}</p></div>);
  return (
    <section className="card"><h3 className="border-b px-3 py-2 text-[13px] font-semibold">Vendor performance</h3>
      <div className="grid gap-3 p-3 sm:grid-cols-2 lg:grid-cols-4"><M label="On-time delivery" v={p.on_time_pct} suffix="%" hint="completed orders delivered by the expected date" /><M label="Fill rate" v={p.fill_rate_pct} suffix="%" hint="quantity received ÷ quantity ordered" /><M label="Avg. lead time" v={p.avg_lead_days} suffix=" days" hint="issue date to first receipt" /><M label="Completed orders" v={p.completed_orders} suffix="" hint="fully received" /></div></section>
  );
}

const ICON: Record<string, any> = { purchase_order: FileText, receipt: PackageCheck, payment: ReceiptText };
export function VendorTransactions({ id }: { id: string }) {
  const { data, loading } = useLoad(() => api(`/vendors/${id}/transactions`), [id]);
  const [kind, setKind] = useState("all");
  const rows = useMemo(() => (data || []).filter((e: any) => kind === "all" || e.kind === kind), [data, kind]);
  const toast = useToast(); const { can } = useMe();
  const voidPay = async (e: any) => { try { await api(`/payments/${e.id}/void`, { method: "POST" }); toast(`${e.number} voided`); window.dispatchEvent(new Event("sp-data-changed")); } catch (er: any) { toast(er.message, "err"); } };
  return (
    <div className="card">
      <div className="flex gap-1 border-b p-2">{[["all", "All"], ["purchase_order", "Purchase orders"], ["receipt", "Receipts"], ["payment", "Payments"]].map(([k, l]) => <button key={k} onClick={() => setKind(k)} className={`rounded px-3 py-1 text-[13px] transition-colors ${kind === k ? "bg-brand/10 font-medium text-brand" : "text-sub hover:bg-muted"}`}>{l}</button>)}</div>
      {loading && !data ? <Skeleton rows={4} /> : !rows.length ? <Empty title="No transactions yet" hint="Purchase orders, goods receipts and payments with this vendor appear here." /> : (
        <ul className="divide-y">{rows.map((e: any, i: number) => { const I = ICON[e.kind]; return (
          <li key={`${e.kind}${e.number}${i}`} style={{ ["--i" as any]: Math.min(i, 12) }} className="stagger flex items-center gap-3 px-3 py-2.5 text-[13px] hover:bg-muted/50"><span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted text-sub"><I className="h-4 w-4" /></span>
            <div className="min-w-0 flex-1">{e.kind === "purchase_order" || e.kind === "receipt" ? <Link className="font-medium text-brand hover:underline" to={`/purchase-orders/${e.kind === "purchase_order" ? e.id : e.id}`}>{e.number}</Link> : <span className="font-medium">{e.number}</span>}<div className="text-xs text-sub">{e.kind === "purchase_order" ? "Purchase order" : e.kind === "receipt" ? `Goods receipt ${e.status}` : `Payment · ${(e.method || "").replace("_", " ")}${e.reference ? ` · ${e.reference}` : ""}`} · {d8(e.date)}</div></div>
            {e.kind === "purchase_order" && <POBadge s={e.status} />}{e.kind === "payment" && (e.status === "void" ? <Badge tone="neutral">Void</Badge> : can("purchases", "w") ? <button className="text-xs text-sub hover:text-red-600" onClick={() => voidPay(e)}>Void</button> : null)}
            <span className={`w-28 text-right tabular-nums ${e.status === "void" ? "text-sub line-through" : ""}`}>{e.amount != null ? money(Math.abs(e.amount)) : ""}{e.kind === "payment" && e.status !== "void" && <span className="ml-1 text-xs text-emerald-600">paid</span>}</span></li>); })}</ul>)}
    </div>
  );
}


/* ------------------------- customer equivalents ------------------------- */
export function CustomerStatsStrip({ id }: { id: string }) {
  const { can } = useMe(); const { data: s, loading } = useLoad(() => api(`/customers/${id}/stats`), [id]); const [pay, setPay] = useState(false);
  if (loading && !s) return <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">{Array.from({ length: 5 }).map((_, i) => <div key={i} className="skeleton h-16" />)}</div>;
  if (!s) return null;
  const cards: [string, number, boolean, string][] = [["Total sales", s.total_sales, true, "confirmed orders and later"], ["Billed", s.billed, true, "value of goods shipped"], ["Received", s.paid, true, "recorded payments"], ["Outstanding", s.outstanding, true, "billed − received"], ["Open orders", s.open_orders, false, `${s.orders} orders in total`]];
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">{cards.map(([l, v, m, sub], i) => <div key={l} style={{ ["--i" as any]: i }} className={`stagger card p-3 ${l === "Outstanding" && v > 0 ? "border-amber-500/50" : ""}`}><p className="text-[11px] font-medium text-sub">{l}</p><p className="mt-0.5 text-lg font-semibold"><Num value={v} prefix={m ? "₹" : ""} decimals={m ? 2 : 0} /></p><p className="text-[11px] text-sub">{sub}</p></div>)}</div>
      {s.credit_limit > 0 && <div className="card p-3"><div className="mb-1 flex justify-between text-[12px]"><span className="text-sub">Credit used (outstanding + open orders)</span><span className={`font-medium tabular-nums ${s.credit_used_pct > 100 ? "text-red-600" : ""}`}>{money(s.exposure)} of {money(s.credit_limit)} · {s.credit_used_pct}%</span></div><div className="h-2 overflow-hidden rounded bg-muted"><div className={`h-full rounded transition-all duration-700 ${s.credit_used_pct > 100 ? "bg-red-500" : s.credit_used_pct > 80 ? "bg-amber-500" : "bg-brand"}`} style={{ width: `${Math.min(100, s.credit_used_pct)}%` }} /></div></div>}
      {can("sales", "w") && s.outstanding > 0 && <div className="flex justify-end"><button className="btn-primary" onClick={() => setPay(true)}><Banknote className="h-3.5 w-3.5" />Record payment</button></div>}
      {pay && <PaymentDialog vendorId={id} partyType="customer" outstanding={s.outstanding} onClose={() => setPay(false)} />}
    </div>
  );
}

export function CustomerInsights({ id }: { id: string }) {
  const { data: s } = useLoad(() => api(`/customers/${id}/stats`), [id]);
  if (!s) return null;
  return (
    <section className="card"><h3 className="border-b px-3 py-2 text-[13px] font-semibold">Purchase analytics</h3>
      <div className="grid gap-3 p-3 sm:grid-cols-3"><div className="rounded-md border p-3"><p className="text-[11px] text-sub">Average order value</p><p className="mt-0.5 text-lg font-semibold">{s.avg_order_value != null ? money(s.avg_order_value) : "—"}</p></div><div className="rounded-md border p-3"><p className="text-[11px] text-sub">Last order</p><p className="mt-0.5 text-lg font-semibold">{s.last_order_date ? d8(s.last_order_date) : "—"}</p></div><div className="rounded-md border p-3"><p className="text-[11px] text-sub">Orders</p><p className="mt-0.5 text-lg font-semibold">{s.orders}</p></div></div>
      <div className="border-t p-3"><p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-sub">Most purchased items</p>{!s.top_items.length ? <p className="text-[13px] text-sub">No confirmed orders yet.</p> : <ul className="divide-y rounded-md border">{s.top_items.map((t: any) => <li key={t.product_id} className="flex items-center justify-between px-3 py-1.5 text-[13px]"><Link className="text-brand hover:underline" to={`/products/${t.product_id}`}>{t.name}</Link><span className="tabular-nums text-sub">{t.quantity} units · {money(t.amount)}</span></li>)}</ul>}</div></section>
  );
}

const CICON: Record<string, any> = { sales_order: FileText, payment: ReceiptText, shipment: PackageCheck };
export function CustomerTransactions({ id }: { id: string }) {
  const { data, loading } = useLoad(() => api(`/customers/${id}/transactions`), [id]); const [kind, setKind] = useState("all"); const toast = useToast(); const { can } = useMe();
  const rows = useMemo(() => (data || []).filter((e: any) => kind === "all" || e.kind === kind), [data, kind]);
  const voidPay = async (e: any) => { try { await api(`/payments/${e.id}/void`, { method: "POST" }); toast(`${e.number} voided`); window.dispatchEvent(new Event("sp-data-changed")); } catch (er: any) { toast(er.message, "err"); } };
  return (
    <div className="card"><div className="flex gap-1 border-b p-2">{[["all", "All"], ["sales_order", "Sales orders"], ["shipment", "Shipments"], ["payment", "Payments"]].map(([k, l]) => <button key={k} onClick={() => setKind(k)} className={`rounded px-3 py-1 text-[13px] transition-colors ${kind === k ? "bg-brand/10 font-medium text-brand" : "text-sub hover:bg-muted"}`}>{l}</button>)}</div>
      {loading && !data ? <Skeleton rows={4} /> : !rows.length ? <Empty title="No transactions yet" hint="Sales orders, shipments and payments for this customer appear here." /> : (
        <ul className="divide-y">{rows.map((e: any, i: number) => { const I = CICON[e.kind]; return (
          <li key={`${e.kind}${e.number}${i}`} style={{ ["--i" as any]: Math.min(i, 12) }} className="stagger flex items-center gap-3 px-3 py-2.5 text-[13px] hover:bg-muted/50"><span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted text-sub"><I className="h-4 w-4" /></span>
            <div className="min-w-0 flex-1">{e.kind === "payment" ? <span className="font-medium">{e.number}</span> : <Link className="font-medium text-brand hover:underline" to={e.kind === "shipment" ? `/shipments` : `/sales-orders/${e.id}`}>{e.number}</Link>}<div className="text-xs text-sub">{e.kind === "sales_order" ? "Sales order" : e.kind === "shipment" ? `Shipment · ${e.status}` : `Payment · ${(e.method || "").replace("_", " ")}${e.reference ? ` · ${e.reference}` : ""}`} · {d8(e.date)}</div></div>
            {e.kind === "sales_order" && <SOBadge s={e.status} />}{e.kind === "payment" && (e.status === "void" ? <Badge tone="neutral">Void</Badge> : can("sales", "w") ? <button className="text-xs text-sub hover:text-red-600" onClick={() => voidPay(e)}>Void</button> : null)}
            <span className={`w-28 text-right tabular-nums ${e.status === "void" ? "text-sub line-through" : ""}`}>{e.amount != null ? money(Math.abs(e.amount)) : ""}{e.kind === "payment" && e.status !== "void" && <span className="ml-1 text-xs text-emerald-600">received</span>}</span></li>); })}</ul>)}</div>
  );
}