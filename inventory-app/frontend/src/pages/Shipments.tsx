import { useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { AlertTriangle, ArrowRight, CheckCircle2, Download, Eye, FileText, FlaskConical, Home, MapPin, Package as PackageIcon, Pencil, Printer, Search, Tag, Truck, X } from "lucide-react";
import { api, dt, download, fmt } from "../api";
import { useMe } from "../App";
import { Col, DataTable } from "../DataTable";
import { useHotkeys } from "../fx";
import { openPdf, printPdf } from "../media";
import { Badge, Empty, Field, Modal, Skeleton, useLoad, useToast } from "../ui";
import { d8 } from "./PurchaseOrders";
import { SOBadge } from "./SalesOrders";
import { Pagination, RowMenu } from "./Warehouses";

export const SHP_TONE: Record<string, "ok" | "warn" | "bad" | "neutral" | "info"> = { ready_to_ship: "neutral", shipped: "info", in_transit: "info", out_for_delivery: "warn", delivered: "ok", failed_delivery: "bad", cancelled: "neutral" };
export const SHP_LABEL: Record<string, string> = { ready_to_ship: "Ready to ship", shipped: "Shipped", in_transit: "In transit", out_for_delivery: "Out for delivery", delivered: "Delivered", failed_delivery: "Failed delivery", cancelled: "Cancelled" };
export const SHPBadge = ({ s }: { s: string }) => <Badge tone={SHP_TONE[s] || "neutral"}>{SHP_LABEL[s] || s}</Badge>;
const EVICON: Record<string, any> = { ready_to_ship: PackageIcon, shipped: Truck, in_transit: ArrowRight, out_for_delivery: MapPin, delivered: CheckCircle2, failed_delivery: AlertTriangle, cancelled: X };

/* ============================== shipments list ============================== */
export function ShipmentList() {
  const { can } = useMe(); const toast = useToast(); const go = useNavigate();
  const [sp] = useSearchParams(); const [q, setQ] = useState(""); const [status, setStatus] = useState(sp.get("status") || "all"); const [page, setPage] = useState(1); const [size, setSize] = useState(25); const search = useRef<HTMLInputElement>(null);
  const qs = `q=${encodeURIComponent(q)}&status=${status}&page=${page}&page_size=${size}`;
  const { data, loading, error } = useLoad(() => api(`/shipments?${qs}`), [qs]);
  useHotkeys({ "/": () => search.current?.focus() }, []);
  const counts = data?.counts || {}; const c = (...s: string[]) => s.reduce((a, k) => a + (counts[k] || 0), 0);
  const tabs: [string, string, number][] = [["all", "All", Object.values(counts).reduce((a: number, x: any) => a + x, 0)], ["ready_to_ship", "Ready to ship", c("ready_to_ship")], ["active", "In progress", c("shipped", "in_transit", "out_for_delivery")], ["failed_delivery", "Failed", c("failed_delivery")], ["delivered", "Delivered", c("delivered")]];
  const columns: Col<any>[] = [
    { id: "number", label: "Shipment", w: 13, cell: (s) => <td className="td"><Link className="font-medium text-brand hover:underline" to={`/shipments/${s.id}`} onClick={(e) => e.stopPropagation()}>{s.number}</Link><div className="text-xs text-sub">{s.package_number}</div></td> },
    { id: "order", label: "Order", w: 11, cell: (s) => <td className="td"><Link className="text-brand hover:underline" to={`/sales-orders/${s.so_id}`} onClick={(e) => e.stopPropagation()}>{s.so_number}</Link></td> },
    { id: "customer", label: "Customer", w: 17, cell: (s) => <td className="td truncate">{s.customer}</td> },
    { id: "carrier", label: "Carrier / Tracking", w: 17, cell: (s) => <td className="td truncate">{s.carrier}<div className="truncate text-xs text-sub">{s.tracking_number || "No tracking number"}</div></td> },
    { id: "status", label: "Status", w: 13, cell: (s) => <td className="td"><SHPBadge s={s.status} /></td> },
    { id: "shipped", label: "Shipped", w: 9, cell: (s) => <td className="td text-sub">{d8(s.shipping_date)}</td> },
    { id: "expected", label: "Expected", w: 10, cell: (s) => <td className="td text-sub">{d8(s.expected_delivery)}{s.overdue && <div className="text-[11px] font-medium text-red-600">Overdue</div>}</td> },
    { id: "units", label: "Units", right: true, w: 6, cell: (s) => <td className="td text-right tabular-nums">{fmt(s.units)}</td> },
  ];
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2"><h1 className="text-lg font-semibold">Shipments</h1>
        <div className="flex gap-2"><Link to="/packages" className="btn-ghost"><PackageIcon className="h-3.5 w-3.5" />Packages</Link><button className="btn-ghost" onClick={() => download("/shipments-export.csv", "shipments.csv").catch((e) => toast(e.message, "err"))}><Download className="h-3.5 w-3.5" />Export</button></div></div>
      <div className="flex flex-wrap gap-1 rounded-lg border bg-surface p-1">{tabs.map(([k, l, n]) => <button key={k} onClick={() => { setStatus(k); setPage(1); }} className={`rounded-md px-3 py-1.5 text-[13px] transition-colors ${status === k ? "bg-brand/10 font-medium text-brand" : "text-sub hover:bg-muted"}`}>{l} <span className="ml-1 rounded bg-muted px-1.5 text-[11px] tabular-nums">{n}</span></button>)}</div>
      <div className="card overflow-hidden">
        <div className="flex flex-wrap items-center gap-2 border-b p-2.5"><div className="relative w-full max-w-sm"><Search className="pointer-events-none absolute left-2.5 top-2 h-3.5 w-3.5 text-sub" /><input ref={search} className="input !pl-8 !pr-7" placeholder="Search shipment, tracking no., order, customer…  ( / )" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} />{q && <button className="absolute right-1.5 top-1.5 rounded p-0.5 text-sub hover:bg-muted" onClick={() => setQ("")} aria-label="Clear search"><X className="h-3.5 w-3.5" /></button>}</div></div>
        {error ? <p className="p-4 text-red-500">{error}</p> : (
          <DataTable storageKey="sp_shp_cols" columns={columns} rows={data?.items || []} rowKey={(r) => r.id} loading={loading} hasData={!!data} sort="" desc={false} onSort={() => {}} onRowOpen={(s) => go(`/shipments/${s.id}`)} animKey={qs} minWidth={960}
            empty={<Empty title={q || status !== "all" ? "No shipments match" : "No shipments yet"} hint="Pack a confirmed sales order, then create a shipment from its package." />}
            rowActions={(s) => (<div className="flex items-center justify-end gap-0.5"><span className="row-actions flex gap-0.5"><button className="rounded p-1 hover:bg-muted" aria-label={`View ${s.number}`} data-tip="View" onClick={() => go(`/shipments/${s.id}`)}><Eye className="h-4 w-4" /></button><button className="rounded p-1 hover:bg-muted" aria-label={`Label ${s.number}`} data-tip="Shipping label" onClick={() => openPdf(`/shipments/${s.id}/label.pdf`).catch((e) => toast(e.message, "err"))}><Tag className="h-4 w-4" /></button></span>
              <RowMenu items={[{ label: "View", icon: Eye, onClick: () => go(`/shipments/${s.id}`) }, { label: "Shipping label", icon: Tag, onClick: () => openPdf(`/shipments/${s.id}/label.pdf`).catch((e) => toast(e.message, "err")) }, { label: "Print label", icon: Printer, onClick: () => printPdf(`/shipments/${s.id}/label.pdf`).catch((e) => toast(e.message, "err")) }, { label: "Packing slip", icon: FileText, onClick: () => openPdf(`/packages/${s.package_id}/slip.pdf`).catch((e) => toast(e.message, "err")) }]} /></div>)} />)}
        {data && <Pagination total={data.total} page={page} size={size} setPage={setPage} setSize={setSize} noun="shipments" />}
      </div>
      {!can("fulfilment", "w") && <p className="text-xs text-sub">You have read-only access to shipments.</p>}
    </div>
  );
}

/* ============================== packages list ============================== */
export function PackageList() {
  const toast = useToast(); const go = useNavigate(); const [q, setQ] = useState(""); const [status, setStatus] = useState("all"); const [page, setPage] = useState(1); const [size, setSize] = useState(25);
  const qs = `q=${encodeURIComponent(q)}&status=${status}&page=${page}&page_size=${size}`;
  const { data, loading, error } = useLoad(() => api(`/packages?${qs}`), [qs]);
  const counts = data?.counts || {};
  const tabs: [string, string, number][] = [["all", "All", Object.values(counts).reduce((a: number, x: any) => a + x, 0)], ["packed", "Packed", counts.packed || 0], ["shipped", "Shipped", counts.shipped || 0], ["delivered", "Delivered", counts.delivered || 0], ["void", "Void", counts.void || 0]];
  const columns: Col<any>[] = [
    { id: "number", label: "Package", w: 12, cell: (p) => <td className="td font-medium">{p.number}<div className="text-xs font-normal text-sub">{d8(p.created_at)}</div></td> },
    { id: "order", label: "Order", w: 12, cell: (p) => <td className="td"><Link className="text-brand hover:underline" to={`/sales-orders/${p.so_id}`} onClick={(e) => e.stopPropagation()}>{p.so_number}</Link></td> },
    { id: "customer", label: "Customer", w: 22, cell: (p) => <td className="td truncate">{p.customer}</td> },
    { id: "wh", label: "Warehouse", w: 10, cell: (p) => <td className="td text-sub">{p.warehouse}</td> },
    { id: "units", label: "Units", right: true, w: 8, cell: (p) => <td className="td text-right tabular-nums">{fmt(p.units)}<div className="text-xs text-sub">{p.item_count} item{p.item_count !== 1 ? "s" : ""}</div></td> },
    { id: "status", label: "Status", w: 12, cell: (p) => <td className="td"><Badge tone={p.status === "delivered" ? "ok" : p.status === "shipped" ? "info" : p.status === "void" ? "bad" : "warn"}>{p.status}</Badge></td> },
    { id: "shipment", label: "Shipment", w: 16, cell: (p) => <td className="td">{p.shipment_id ? <Link className="text-brand hover:underline" to={`/shipments/${p.shipment_id}`} onClick={(e) => e.stopPropagation()}>{p.shipment_number}</Link> : <span className="text-sub">Not created</span>}{p.shipment_status && <div className="mt-0.5"><SHPBadge s={p.shipment_status} /></div>}</td> },
  ];
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between"><h1 className="text-lg font-semibold">Packages</h1><Link to="/shipments" className="btn-ghost"><Truck className="h-3.5 w-3.5" />Shipments</Link></div>
      <div className="flex flex-wrap gap-1 rounded-lg border bg-surface p-1">{tabs.map(([k, l, n]) => <button key={k} onClick={() => { setStatus(k); setPage(1); }} className={`rounded-md px-3 py-1.5 text-[13px] transition-colors ${status === k ? "bg-brand/10 font-medium text-brand" : "text-sub hover:bg-muted"}`}>{l} <span className="ml-1 rounded bg-muted px-1.5 text-[11px] tabular-nums">{n}</span></button>)}</div>
      <div className="card overflow-hidden">
        <div className="flex items-center gap-2 border-b p-2.5"><div className="relative w-full max-w-sm"><Search className="pointer-events-none absolute left-2.5 top-2 h-3.5 w-3.5 text-sub" /><input className="input !pl-8" placeholder="Search package, order, customer…" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} /></div></div>
        {error ? <p className="p-4 text-red-500">{error}</p> : (
          <DataTable storageKey="sp_pkg_cols" columns={columns} rows={data?.items || []} rowKey={(r) => r.id} loading={loading} hasData={!!data} sort="" desc={false} onSort={() => {}} onRowOpen={(p) => go(`/sales-orders/${p.so_id}?tab=fulfilment`)} animKey={qs} minWidth={900}
            empty={<Empty title="No packages yet" hint="Open a confirmed sales order and use Pack items." />}
            rowActions={(p) => <RowMenu items={[{ label: "Open order", icon: Eye, onClick: () => go(`/sales-orders/${p.so_id}`) }, { label: "Packing slip", icon: FileText, onClick: () => openPdf(`/packages/${p.id}/slip.pdf`).catch((e) => toast(e.message, "err")) }]} />} />)}
        {data && <Pagination total={data.total} page={page} size={size} setPage={setPage} setSize={setSize} noun="packages" />}
      </div>
    </div>
  );
}

/* ============================== shipment detail ============================== */
export function ShipmentDetail() {
  const { id = "" } = useParams(); const { can } = useMe(); const toast = useToast();
  const { data: s, loading, error, reload } = useLoad(() => api(`/shipments/${id}`), [id]);
  const [dlg, setDlg] = useState<{ to: string; label: string } | null>(null); const [edit, setEdit] = useState(false); const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(""); const [loc, setLoc] = useState(""); const [who, setWho] = useState(""); const [why, setWhy] = useState("");
  if (loading && !s) return <div className="card"><Skeleton rows={6} /></div>;
  if (error || !s) return <div className="card"><Empty title="Shipment not found" hint={error} /></div>;
  const w = can("fulfilment", "w");
  const refresh = () => { window.dispatchEvent(new Event("sp-data-changed")); reload(); };
  const setStatus = async (to: string, extra: any = {}) => { setBusy(true); try { await api(`/shipments/${id}/status`, { body: { status: to, ...extra } }); toast(`Marked ${SHP_LABEL[to].toLowerCase()}`); setDlg(null); setNote(""); setLoc(""); setWho(""); setWhy(""); refresh(); } catch (e: any) { toast(e.message, "err"); } finally { setBusy(false); } };
  const simulate = async () => { try { await api(`/shipments/${id}/simulate-advance`, { method: "POST" }); toast("Simulated tracking update added"); refresh(); } catch (e: any) { toast(e.message, "err"); } };
  const fwd = s.allowed_next.filter((n: any) => !["failed_delivery", "cancelled"].includes(n.status));
  const primary = fwd[0]?.status === "shipped" ? fwd[0] : s.allowed_next.find((n: any) => n.status === "delivered") || fwd[0];
  const manual = s.tracking_mode === "manual";
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-[13px] text-sub"><Link to="/shipments" className="hover:text-ink">Shipments</Link><span>/</span><span className="text-ink">{s.number}</span></div>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div><div className="flex flex-wrap items-center gap-2"><h1 className="text-lg font-semibold">{s.number}</h1><SHPBadge s={s.status} />{s.overdue && <Badge tone="bad">Overdue</Badge>}{manual && <Badge tone="warn">Manual tracking</Badge>}</div>
          <p className="text-[13px] text-sub">{s.customer} · <Link className="text-brand hover:underline" to={`/sales-orders/${s.so_id}`}>{s.so_number}</Link> · package {s.package_number}</p></div>
        <div className="flex flex-wrap items-center gap-2">
          {w && primary && <button className="btn-primary" onClick={() => (["failed_delivery", "delivered"].includes(primary.status) ? setDlg({ to: primary.status, label: primary.label }) : setStatus(primary.status))}><Truck className="h-3.5 w-3.5" />{s.status === "ready_to_ship" ? "Mark shipped (deducts stock)" : `Mark ${primary.label.toLowerCase()}`}</button>}
          {w && s.allowed_next.filter((n: any) => n.status !== primary?.status && n.status !== "shipped").map((n: any) => <button key={n.status} className={`btn-ghost ${n.status === "failed_delivery" ? "!text-red-600" : ""}`} onClick={() => setDlg({ to: n.status, label: n.label })}>{n.label}</button>)}
          {w && manual && ["shipped", "in_transit", "out_for_delivery", "failed_delivery"].includes(s.status) && <button className="btn-ghost" onClick={simulate} data-tip="Adds the next status as a SIMULATED update"><FlaskConical className="h-3.5 w-3.5" />Simulate next update</button>}
          <button className="btn-ghost" onClick={() => openPdf(`/shipments/${id}/label.pdf`).catch((e) => toast(e.message, "err"))}><Tag className="h-3.5 w-3.5" />Label</button>
          <button className="btn-ghost" onClick={() => printPdf(`/shipments/${id}/label.pdf`).catch((e) => toast(e.message, "err"))}><Printer className="h-3.5 w-3.5" />Print label</button>
          <button className="btn-ghost" onClick={() => openPdf(`/packages/${s.package_id}/slip.pdf`).catch((e) => toast(e.message, "err"))}><FileText className="h-3.5 w-3.5" />Packing slip</button>
          {w && !["delivered", "cancelled"].includes(s.status) && <button className="btn-ghost" onClick={() => setEdit(true)}><Pencil className="h-3.5 w-3.5" />Edit</button>}</div>
      </div>
      {s.status === "failed_delivery" && <div className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/5 px-4 py-2.5 text-[13px] text-red-700 dark:text-red-400"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /><span><b>Delivery failed:</b> {s.failure_reason}. Retry by marking it out for delivery again.</span></div>}
      {s.status === "ready_to_ship" && <div className="rounded-lg border bg-muted/40 px-4 py-2.5 text-[13px] text-sub">Stock for this package is still in the warehouse. Marking the shipment <b>shipped</b> deducts it from inventory.</div>}
      <div className="grid gap-3 lg:grid-cols-3">
        <section className="card lg:col-span-2"><h3 className="border-b px-3 py-2 text-[13px] font-semibold">Tracking timeline</h3>
          <ol className="relative p-4 before:absolute before:bottom-6 before:left-[31px] before:top-6 before:w-px before:bg-line">{[...s.events].reverse().map((e: any, i: number) => { const I = EVICON[e.status] || Truck; const last = i === 0; return (
            <li key={i} style={{ ["--i" as any]: i }} className="stagger relative flex gap-3 pb-4 last:pb-0"><span className={`relative z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-full ring-4 ring-surface ${e.status === "delivered" ? "bg-emerald-500/15 text-emerald-600" : e.status === "failed_delivery" ? "bg-red-500/15 text-red-600" : last ? "bg-brand/15 text-brand" : "bg-muted text-sub"}`}><I className="h-4 w-4" /></span>
              <div className="min-w-0 flex-1 pt-0.5"><p className="flex flex-wrap items-center gap-2 text-[13px] font-medium">{e.label}{e.source === "simulated" && <Badge tone="warn">Simulated</Badge>}</p>{(e.note || e.location) && <p className="text-[13px] text-sub">{[e.location, e.note].filter(Boolean).join(" · ")}</p>}<p className="text-xs text-sub">{dt(e.when)}</p></div></li>); })}</ol></section>
        <div className="space-y-3">
          <section className="card"><h3 className="border-b px-3 py-2 text-[13px] font-semibold">Carrier</h3><dl className="space-y-1.5 p-3 text-[13px]"><div className="flex justify-between"><dt className="text-sub">Carrier</dt><dd className="font-medium">{s.carrier}</dd></div><div className="flex justify-between"><dt className="text-sub">Tracking no.</dt><dd className="font-mono text-xs">{s.tracking_number || "—"}</dd></div><div className="flex justify-between"><dt className="text-sub">Shipped</dt><dd>{d8(s.shipping_date)}</dd></div><div className="flex justify-between"><dt className="text-sub">Expected</dt><dd>{d8(s.expected_delivery)}</dd></div>{s.delivered_at && <div className="flex justify-between"><dt className="text-sub">Delivered</dt><dd>{dt(s.delivered_at)}{s.delivered_to ? ` · ${s.delivered_to}` : ""}</dd></div>}</dl>
            <p className="border-t px-3 py-2 text-xs text-sub">{manual ? "No live carrier is connected: statuses are entered by your team. Updates marked “Simulated” come from the simulate button and are not real carrier data." : "Live carrier tracking."}</p></section>
          <section className="card"><h3 className="border-b px-3 py-2 text-[13px] font-semibold">Ship to</h3><p className="flex gap-2 p-3 text-[13px]"><Home className="mt-0.5 h-3.5 w-3.5 shrink-0 text-sub" />{s.ship_to}</p></section>
          <section className="card"><h3 className="border-b px-3 py-2 text-[13px] font-semibold">Package contents</h3><ul className="divide-y">{s.package.lines.map((l: any) => <li key={l.id} className="flex justify-between px-3 py-1.5 text-[13px]"><span>{l.name}<span className="ml-2 text-xs text-sub">{l.sku}</span></span><span className="tabular-nums">{fmt(l.quantity)}</span></li>)}</ul></section>
        </div>
      </div>
      {dlg && <Modal title={dlg.label} onClose={() => setDlg(null)}><div className="space-y-3">
        {dlg.to === "delivered" && <Field label="Received by"><input autoFocus className="input" maxLength={120} value={who} onChange={(e) => setWho(e.target.value)} placeholder="Name of the person who accepted" /></Field>}
        {dlg.to === "failed_delivery" && <Field label="Reason *"><input autoFocus className="input" maxLength={200} value={why} onChange={(e) => setWhy(e.target.value)} placeholder="e.g. customer unavailable, address not found" /></Field>}
        <Field label="Location"><input className="input" maxLength={120} value={loc} onChange={(e) => setLoc(e.target.value)} /></Field><Field label="Note"><input className="input" maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
        <div className="flex justify-end gap-2"><button className="btn-ghost" onClick={() => setDlg(null)}>Cancel</button><button className={`btn-primary ${busy ? "btn-loading" : ""}`} disabled={busy || (dlg.to === "failed_delivery" && !why.trim())} onClick={() => setStatus(dlg.to, { note: note || null, location: loc || null, delivered_to: who || null, failure_reason: why || null })}>Confirm</button></div></div></Modal>}
      {edit && <EditShipment s={s} onClose={() => setEdit(false)} onDone={refresh} />}
    </div>
  );
}

function EditShipment({ s, onClose, onDone }: { s: any; onClose: () => void; onDone: () => void }) {
  const toast = useToast(); const [carrier, setCarrier] = useState(s.carrier); const [trk, setTrk] = useState(s.tracking_number || ""); const [sd, setSd] = useState(s.shipping_date || ""); const [ed, setEd] = useState(s.expected_delivery || ""); const [busy, setBusy] = useState(false);
  const save = async () => { setBusy(true); try { await api(`/shipments/${s.id}`, { method: "PATCH", body: { carrier, tracking_number: trk, shipping_date: sd || null, expected_delivery: ed || null } }); toast("Shipment updated"); onDone(); onClose(); } catch (e: any) { toast(e.message, "err"); } finally { setBusy(false); } };
  return <Modal title="Edit shipment" onClose={onClose}><div className="space-y-3"><Field label="Carrier"><input className="input" value={carrier} maxLength={80} onChange={(e) => setCarrier(e.target.value)} /></Field><Field label="Tracking number"><input className="input" value={trk} maxLength={80} onChange={(e) => setTrk(e.target.value)} /></Field><div className="grid grid-cols-2 gap-3"><Field label="Shipping date"><input type="date" className="input" value={sd} onChange={(e) => setSd(e.target.value)} /></Field><Field label="Expected delivery"><input type="date" className="input" value={ed} onChange={(e) => setEd(e.target.value)} /></Field></div>
    <div className="flex justify-end gap-2"><button className="btn-ghost" onClick={onClose}>Cancel</button><button className={`btn-primary ${busy ? "btn-loading" : ""}`} disabled={busy || carrier.trim().length < 2} onClick={save}>Save</button></div></div></Modal>;
}
void SOBadge;
