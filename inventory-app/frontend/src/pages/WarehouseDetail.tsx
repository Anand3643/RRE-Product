import { useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Archive, ArchiveRestore, ArrowDownToLine, ArrowLeftRight, ArrowUpFromLine, Download, FileClock, Mail, MapPin, Pencil, Phone, RefreshCw, SlidersHorizontal, Trash2, TriangleAlert, User as UserIcon } from "lucide-react";
import { api, dt, download, fmt, money } from "../api";
import { useMe } from "../App";
import { Collapsible, Num, TabBar, useSwipe } from "../fx";
import { Badge, Confirm, Empty, Skeleton, StatusDot, useLoad, useToast } from "../ui";
import { Pagination, RowMenu, addr } from "./Warehouses";
import { TransferDialog, TransferTable } from "./Transfers";
import { ActionDialog } from "./Inventory";

const TABS = [["overview", "Overview"], ["items", "Products"], ["stock", "Stock"], ["transfers", "Transfers"], ["activity", "Activity"]] as const;
type TabKey = (typeof TABS)[number][0];
const statusBadge = (s: string) => s === "out" ? <Badge tone="bad">Out of stock</Badge> : s === "low" ? <Badge tone="warn">Low stock</Badge> : <Badge tone="ok">In stock</Badge>;
const KV = ({ k, v }: { k: string; v: React.ReactNode }) => <div className="flex items-baseline justify-between gap-3 py-1.5 text-[13px]"><dt className="text-sub">{k}</dt><dd className="text-right font-medium">{v}</dd></div>;
const Panel = ({ title, children, action }: { title: string; children: React.ReactNode; action?: React.ReactNode }) => (
  <section className="card transition-shadow hover:shadow-[var(--shadow-2)]"><div className="flex items-center justify-between border-b px-3 py-2"><h3 className="text-[13px] font-semibold">{title}</h3>{action}</div><div className="p-3">{children}</div></section>);
const tip = { contentStyle: { background: "rgb(var(--surface))", border: "1px solid rgb(var(--line))", borderRadius: 6, fontSize: 12, boxShadow: "var(--shadow-2)" }, cursor: { fill: "rgb(var(--muted) / .6)" } };

function Overview({ id, d }: { id: string; d: any }) {
  const mv = useLoad(() => api(`/inventory/movements?warehouse_id=${id}&page_size=6`), [id]);
  const ins = useLoad(() => api(`/insights?warehouse_id=${id}`), [id]);
  const alerts = [...d.out_items, ...d.low_items];
  return (
    <div className="grid gap-3 lg:grid-cols-3">
      <div className="space-y-3 lg:col-span-2">
        <Panel title="Stock summary"><dl className="grid gap-x-8 sm:grid-cols-2">
          <div className="divide-y"><KV k="Products stored" v={<Num value={d.products} />} /><KV k="Quantity on hand" v={<Num value={d.on_hand} />} /><KV k="Available quantity" v={<Num value={d.available} />} /><KV k="Reserved quantity" v={<Num value={d.reserved} />} /></div>
          <div className="divide-y"><KV k="Low stock products" v={<Num value={d.low} className={d.low ? "text-amber-600" : ""} />} /><KV k="Out of stock products" v={<Num value={d.out} className={d.out ? "text-red-600" : ""} />} /><KV k="Inventory value" v={<Num value={d.value} prefix="₹" decimals={2} />} /><KV k="Transfers in / out" v={`${d.incoming_transfers} / ${d.outgoing_transfers}`} /></div>
        </dl></Panel>
        <Panel title="Needs attention" action={<span className="text-xs text-sub">{alerts.length} item{alerts.length !== 1 ? "s" : ""}</span>}>
          {!alerts.length ? <p className="py-2 text-[13px] text-sub">All products are above their reorder points.</p> : <ul className="divide-y">{alerts.map((r: any, i: number) => (
            <li key={r.product_id} style={{ ["--i" as any]: i }} className="stagger flex items-center justify-between py-1.5 text-[13px]"><span>{r.name}<span className="ml-2 text-xs text-sub">{r.sku}</span></span><span className="flex items-center gap-2 text-xs text-sub">{fmt(r.available)} avail. / reorder {fmt(r.reorder_point)}{statusBadge(r.status)}</span></li>))}</ul>}</Panel>
        <Panel title="Recent stock movements">
          {mv.loading && !mv.data ? <Skeleton rows={3} /> : !mv.data?.items.length ? <p className="py-2 text-[13px] text-sub">No movements yet.</p> : <ul className="divide-y">{mv.data.items.map((m: any) => (
            <li key={m.id} className="flex items-center justify-between py-1.5 text-[13px]"><span>{m.product}<span className="ml-2 text-xs capitalize text-sub">{m.type.replace("_", " ")}</span></span>
              <span className="text-right"><span className={m.qty_delta >= 0 ? "text-emerald-600" : "text-red-500"}>{m.qty_delta > 0 ? "+" : ""}{fmt(m.qty_delta, 3)}</span><span className="ml-3 text-xs text-sub">{dt(m.created_at)}</span></span></li>))}</ul>}</Panel>
      </div>
      <div className="space-y-3">
        <Collapsible id="wh-info" title="Warehouse information"><dl className="divide-y text-[13px]">
          <div className="space-y-1 pb-2"><p className="flex gap-2"><MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0 text-sub" /><span>{addr(d) || <span className="text-sub">No address</span>}</span></p></div>
          <div className="space-y-1 py-2">
            <p className="flex gap-2"><UserIcon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-sub" />{d.contact_name || <span className="text-sub">No contact person</span>}</p>
            <p className="flex gap-2"><Phone className="mt-0.5 h-3.5 w-3.5 shrink-0 text-sub" />{d.phone ? <a className="text-brand hover:underline" href={`tel:${d.phone}`}>{d.phone}</a> : <span className="text-sub">No phone</span>}</p>
            <p className="flex gap-2"><Mail className="mt-0.5 h-3.5 w-3.5 shrink-0 text-sub" />{d.email ? <a className="text-brand hover:underline" href={`mailto:${d.email}`}>{d.email}</a> : <span className="text-sub">No email</span>}</p></div>
          <div className="pt-2"><p className="text-xs text-sub">Description</p><p>{d.description || <span className="text-sub">—</span>}</p></div></dl></Collapsible>
        <Collapsible id="wh-ai" title="AI insights" action={<Link className="text-xs text-brand hover:underline" to="/insights">All insights</Link>}>
          {ins.loading && !ins.data ? <Skeleton rows={3} /> : ins.data && <ul className="space-y-1.5 text-[13px]">
            {ins.data.efficiency[0] && <li>Efficiency score <b>{ins.data.efficiency[0].score}/100</b> <span className="text-xs text-sub">(health {ins.data.efficiency[0].stock_health_pct}%, idle value {ins.data.efficiency[0].idle_value_pct}%)</span></li>}
            <li>{ins.data.shortages.length} predicted shortage{ins.data.shortages.length !== 1 ? "s" : ""}{ins.data.shortages[0] && <> — soonest <b>{ins.data.shortages[0].name}</b> in {ins.data.shortages[0].days_cover} days</>}</li>
            <li>{ins.data.excess.length} excess · {ins.data.slow_moving.length} slow-moving · {ins.data.anomalies.length} unusual movements</li>
            {ins.data.recommended_transfers.slice(0, 3).map((r: any, i: number) => <li key={i} className="rounded bg-muted px-2 py-1.5 text-xs">Move <b>{r.quantity}</b> × {r.sku}: {r.from_code} → {r.to_code}</li>)}</ul>}</Collapsible>
      </div>
    </div>
  );
}

function Items({ id, canAdjust, onAdjust }: { id: string; canAdjust: boolean; onAdjust: (pid: number) => void }) {
  const toast = useToast(); const [sp] = useSearchParams();
  const [q, setQ] = useState(sp.get("q") || ""); const [status, setStatus] = useState(sp.get("status") || "all"); const [sort, setSort] = useState("name"); const [desc, setDesc] = useState(false); const [page, setPage] = useState(1); const [size, setSize] = useState(15);
  const { data, loading } = useLoad(() => api(`/warehouses/${id}/items?q=${encodeURIComponent(q)}&status=${status}&sort=${sort}&desc=${desc}&page=${page}&page_size=${size}`), [id, q, status, sort, desc, page, size]);
  const th = (key: string, label: string, right = false) => <th className={`th cursor-pointer select-none transition-colors hover:text-ink ${right ? "text-right" : ""} ${sort === key ? "text-ink" : ""}`} onClick={() => { if (sort === key) setDesc(!desc); else { setSort(key); setDesc(false); } }}>{label}<span className="ml-0.5 text-brand">{sort === key ? (desc ? "↓" : "↑") : ""}</span></th>;
  return (
    <div className="card">
      <div className="flex flex-wrap items-center gap-2 border-b p-2.5">
        <select className="input !w-auto" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}><option value="all">All products</option><option value="ok">In stock</option><option value="low">Low stock</option><option value="out">Out of stock</option></select>
        <input className="input max-w-xs" placeholder="Search product or SKU…" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} />
        <button className="btn-ghost ml-auto" onClick={() => download(`/warehouses/${id}/items?csv_export=true`, `warehouse-${id}-products.csv`).catch((e) => toast(e.message, "err"))}><Download className="h-3.5 w-3.5" />Export</button>
      </div>
      <div className={`overflow-x-auto transition-opacity duration-150 ${loading && data ? "opacity-60" : ""}`}>{loading && !data ? <Skeleton /> : !data?.items.length ? <Empty title="No products match" hint="Receive goods or transfer stock into this warehouse." /> :
        <table className="w-full min-w-[700px]"><thead className="border-b bg-muted/60"><tr>{th("name", "Product")}{th("sku", "SKU")}{th("on_hand", "On hand", true)}{th("reserved", "Reserved", true)}{th("available", "Available", true)}<th className="th text-right">Reorder pt</th>{th("value", "Value", true)}{th("status", "Status")}<th className="th w-10" /></tr></thead>
          <tbody key={`${page}-${sort}-${desc}-${status}-${q}`} className="divide-y">{data.items.map((r: any, i: number) => <tr key={r.product_id} style={{ ["--i" as any]: i }} className="stagger transition-colors hover:bg-muted/60"><td className="td font-medium">{r.name}</td><td className="td text-sub">{r.sku}</td><td className="td text-right"><Num value={r.on_hand} decimals={r.on_hand % 1 ? 3 : 0} /></td><td className="td text-right tabular-nums">{fmt(r.reserved, 3)}</td><td className="td text-right"><Num value={r.available} decimals={r.available % 1 ? 3 : 0} /></td><td className="td text-right tabular-nums">{fmt(r.reorder_point)}</td><td className="td text-right tabular-nums">{money(r.value)}</td><td className="td">{statusBadge(r.status)}</td>
            <td className="td text-right">{canAdjust && <button className="row-actions text-xs text-brand hover:underline" onClick={() => onAdjust(r.product_id)}>Adjust</button>}</td></tr>)}</tbody></table>}</div>
      {data && <Pagination total={data.total} page={page} size={size} setPage={setPage} setSize={setSize} noun="products" />}
    </div>
  );
}

function StockTab({ id, canAdjust, onNew, goTab }: { id: string; canAdjust: boolean; onNew: () => void; goTab: (tab: TabKey, extra?: Record<string, string>) => void }) {
  const items = useLoad(() => api(`/warehouses/${id}/items?page_size=200&sort=value&desc=true`), [id]);
  const trend = useLoad(() => api(`/warehouses/${id}/trend?days=30`), [id]);
  const adj = useLoad(() => api(`/warehouses/${id}/adjustments?page=1`), [id]);
  const rows: any[] = items.data?.items || [];
  const dist = [["ok", "In stock", "#0d9488"], ["low", "Low stock", "#f59e0b"], ["out", "Out of stock", "#ef4444"]].map(([k, name, color]) => ({ status: k, name, color, value: rows.filter((r) => r.status === k).length })).filter((x) => x.value > 0);
  const top = rows.slice(0, 8).map((r) => ({ ...r, label: r.name.length > 16 ? r.name.slice(0, 15) + "…" : r.name }));
  return (
    <div className="space-y-3">
      <div className="grid gap-3 lg:grid-cols-3">
        <Panel title="Stock health" action={<span className="text-[11px] text-sub">click a slice to filter</span>}>
          {items.loading && !items.data ? <div className="skeleton h-48" /> : !dist.length ? <Empty title="No stock recorded" /> : <>
            <ResponsiveContainer width="100%" height={190}><PieChart><Pie data={dist} dataKey="value" nameKey="name" innerRadius={48} outerRadius={74} paddingAngle={2} onClick={(e: any) => goTab("items", { status: e.status ?? e.payload?.status })} cursor="pointer" animationDuration={700}>{dist.map((x) => <Cell key={x.status} fill={x.color} />)}</Pie><Tooltip {...tip} formatter={(v: any, n: any) => [`${v} product${v !== 1 ? "s" : ""}`, n]} /></PieChart></ResponsiveContainer>
            <div className="flex justify-center gap-3 text-xs">{dist.map((x) => <button key={x.status} className="flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-muted" onClick={() => goTab("items", { status: x.status })}><span className="h-2 w-2 rounded-full" style={{ background: x.color }} />{x.name} <b>{x.value}</b></button>)}</div></>}</Panel>
        <Panel title="Top products by value" action={<span className="text-[11px] text-sub">click a bar to open it</span>}>
          {items.loading && !items.data ? <div className="skeleton h-48" /> : !top.length ? <Empty title="No products" /> :
            <ResponsiveContainer width="100%" height={220}><BarChart data={top} layout="vertical" margin={{ left: 0, right: 8 }}><CartesianGrid horizontal={false} stroke="rgb(var(--line))" strokeDasharray="3 3" /><XAxis type="number" tick={{ fontSize: 10 }} tickFormatter={(v) => (v >= 1000 ? `${v / 1000}k` : v)} /><YAxis type="category" dataKey="label" width={92} tick={{ fontSize: 10 }} />
              <Tooltip {...tip} formatter={(v: any, _n: any, p: any) => [`${money(v)} · ${fmt(p.payload.on_hand)} on hand, ${fmt(p.payload.reserved)} reserved`, "Value"]} labelFormatter={(_l: any, p: any) => p?.[0]?.payload.name} />
              <Bar dataKey="value" radius={[0, 4, 4, 0]} cursor="pointer" animationDuration={700} onClick={(e: any) => goTab("items", { q: e.sku })}>{top.map((r) => <Cell key={r.product_id} fill={r.status === "out" ? "#ef4444" : r.status === "low" ? "#f59e0b" : "#0d9488"} />)}</Bar></BarChart></ResponsiveContainer>}</Panel>
        <Panel title="Movement, last 30 days">
          {trend.loading && !trend.data ? <div className="skeleton h-48" /> : <ResponsiveContainer width="100%" height={220}><AreaChart data={trend.data || []}><CartesianGrid strokeDasharray="3 3" stroke="rgb(var(--line))" /><XAxis dataKey="date" tick={{ fontSize: 10 }} tickFormatter={(s) => s.slice(5)} interval={6} /><YAxis tick={{ fontSize: 10 }} width={34} />
            <Tooltip {...tip} labelFormatter={(s: any) => new Date(s).toLocaleDateString("en-IN", { day: "numeric", month: "short" })} />
            <Area dataKey="inbound" name="Inbound" stroke="#0d9488" fill="#0d948833" animationDuration={700} /><Area dataKey="outbound" name="Outbound" stroke="#3b82f6" fill="#3b82f633" animationDuration={700} /></AreaChart></ResponsiveContainer>}</Panel>
      </div>
      <div className="card">
        <div className="flex items-center justify-between border-b px-3 py-2"><h3 className="text-[13px] font-semibold">Stock adjustments</h3>{canAdjust && <button className="btn-primary !py-1" onClick={onNew}><SlidersHorizontal className="h-3.5 w-3.5" />New Adjustment</button>}</div>
        <div className="overflow-x-auto">{adj.loading && !adj.data ? <Skeleton rows={3} /> : !adj.data?.items.length ? <Empty title="No stock adjustments" hint="Adjustments, damages and opening balances appear here." /> :
          <table className="w-full min-w-[700px]"><thead className="border-b bg-muted/60"><tr>{["Date", "Product", "Type", "Change", "Balance after", "Reason", "By"].map((h) => <th key={h} className={`th ${h === "Change" || h === "Balance after" ? "text-right" : ""}`}>{h}</th>)}</tr></thead>
            <tbody className="divide-y">{adj.data.items.map((m: any, i: number) => <tr key={m.id} style={{ ["--i" as any]: i }} className="stagger transition-colors hover:bg-muted/60"><td className="td whitespace-nowrap">{dt(m.created_at)}</td><td className="td">{m.product}<div className="text-xs text-sub">{m.sku}</div></td><td className="td capitalize">{m.type}</td>
              <td className={`td text-right font-medium tabular-nums ${m.qty_delta >= 0 ? "text-emerald-600" : "text-red-500"}`}>{m.qty_delta > 0 ? "+" : ""}{fmt(m.qty_delta, 3)}</td><td className="td text-right tabular-nums">{fmt(m.on_hand_after, 3)}</td><td className="td text-sub">{m.reason || "—"}</td><td className="td">{m.user || "—"}</td></tr>)}</tbody></table>}</div>
        {adj.data && adj.data.total > adj.data.items.length && <p className="border-t px-3 py-2 text-xs text-sub">Showing the latest {adj.data.items.length} of {adj.data.total} adjustments.</p>}
      </div>
    </div>
  );
}

function TransfersTab({ id }: { id: string }) {
  const [dir, setDir] = useState("all"); const [page, setPage] = useState(1);
  const { data, loading } = useLoad(() => api(`/warehouses/${id}/transfers?direction=${dir}&page=${page}`), [id, dir, page]);
  return (
    <div className="card">
      <div className="flex gap-1 border-b p-2">{[["all", "All"], ["incoming", "Incoming"], ["outgoing", "Outgoing"]].map(([v, l]) => <button key={v} onClick={() => { setDir(v); setPage(1); }} className={`rounded px-3 py-1 text-[13px] transition-colors ${dir === v ? "bg-brand/10 font-medium text-brand" : "text-sub hover:bg-muted"}`}>{l}</button>)}</div>
      <div className={`overflow-x-auto transition-opacity ${loading && data ? "opacity-60" : ""}`}>{loading && !data ? <Skeleton /> : !data?.items.length ? <Empty title="No transfers" hint="Transfers into or out of this warehouse appear here." /> : <TransferTable items={data.items} />}</div>
      {data && <Pagination total={data.total} page={page} size={data.page_size} setPage={setPage} noun="transfers" />}
    </div>
  );
}

const EVT: Record<string, { icon: any; color: string; label: string }> = {
  receipt: { icon: ArrowDownToLine, color: "bg-emerald-500/15 text-emerald-600", label: "Receipt" }, opening: { icon: ArrowDownToLine, color: "bg-emerald-500/15 text-emerald-600", label: "Opening stock" },
  issue: { icon: ArrowUpFromLine, color: "bg-blue-500/15 text-blue-600", label: "Issue" }, transfer_in: { icon: ArrowLeftRight, color: "bg-teal-500/15 text-teal-600", label: "Transfer in" },
  transfer_out: { icon: ArrowLeftRight, color: "bg-amber-500/15 text-amber-600", label: "Transfer out" }, adjustment: { icon: SlidersHorizontal, color: "bg-violet-500/15 text-violet-600", label: "Adjustment" },
  damage: { icon: TriangleAlert, color: "bg-red-500/15 text-red-600", label: "Damage" }, audit: { icon: FileClock, color: "bg-slate-500/15 text-slate-600", label: "Warehouse" },
};
function ActivityTab({ id }: { id: string }) {
  const [page, setPage] = useState(1);
  const { data, loading } = useLoad(() => api(`/warehouses/${id}/activity?page=${page}`), [id, page]);
  const groups: [string, any[]][] = [];
  for (const e of data?.items || []) { const day = new Date(e.when).toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long", year: "numeric" }); const g = groups[groups.length - 1]; if (g && g[0] === day) g[1].push(e); else groups.push([day, [e]]); }
  return (
    <div className="card">{loading && !data ? <Skeleton /> : !groups.length ? <Empty title="No activity yet" /> :
      <div className="p-4">{groups.map(([day, evs]) => (
        <div key={day} className="mb-4 last:mb-0"><p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-sub">{day}</p>
          <ol className="relative space-y-3 before:absolute before:bottom-2 before:left-[15px] before:top-2 before:w-px before:bg-line">{evs.map((e, i) => { const t = EVT[e.type] || EVT.audit; return (
            <li key={i} style={{ ["--i" as any]: i }} className="stagger relative flex gap-3"><span className={`relative z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-full ring-4 ring-surface ${t.color}`}><t.icon className="h-4 w-4" /></span>
              <div className="min-w-0 flex-1 pt-0.5"><p className="text-[13px]"><span className="font-medium">{t.label}</span><span className="text-sub"> — {e.text.replace(/^[A-Za-z ]+: /, "")}</span></p><p className="text-xs text-sub">{new Date(e.when).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}{e.user ? ` · ${e.user}` : ""}</p></div></li>); })}</ol></div>))}
        <div className="flex justify-between border-t pt-3"><button className="btn-ghost !py-1" disabled={page === 1} onClick={() => setPage(page - 1)}>Newer</button><button className="btn-ghost !py-1" disabled={!data || data.items.length < 20} onClick={() => setPage(page + 1)}>Older</button></div></div>}</div>
  );
}

export default function WarehouseDetail() {
  const { id = "" } = useParams(); const { can } = useMe(); const toast = useToast(); const go = useNavigate();
  const [sp, setSp] = useSearchParams(); const tab = ((sp.get("tab") as TabKey) || "overview");
  const { data: d, loading, error, reload } = useLoad(() => api(`/warehouses/${id}`), [id]);
  const whs = useLoad(() => api("/warehouses")); const prods = useLoad(() => api("/products?page_size=200"));
  const [arch, setArch] = useState(false); const [del, setDel] = useState(false); const [xfer, setXfer] = useState(false); const [adj, setAdj] = useState<number | null | undefined>(undefined); const [spin, setSpin] = useState(false);
  const body = useRef<HTMLDivElement>(null);
  const setTab = (k: TabKey, extra?: Record<string, string>) => setSp(k === "overview" ? {} : { tab: k, ...(extra || {}) });
  const idx = TABS.findIndex((t) => t[0] === tab);
  useSwipe(body, { onLeft: () => idx < TABS.length - 1 && setTab(TABS[idx + 1][0]), onRight: () => idx > 0 && setTab(TABS[idx - 1][0]) }, !!d);
  if (loading && !d) return <div className="card"><Skeleton rows={6} /></div>;
  if (error || !d) return <div className="card"><Empty title="Warehouse not found" hint={error} /></div>;
  const wMod = can("warehouses", "w"), iMod = can("inventory", "w");
  const setActive = async (a: boolean) => { try { await api(`/warehouses/${id}`, { method: "PATCH", body: { is_active: a } }); toast(a ? "Warehouse restored" : "Warehouse archived"); reload(); } catch (e: any) { toast(e.message, "err"); } };
  const remove = async () => { try { await api(`/warehouses/${id}`, { method: "DELETE" }); toast("Warehouse deleted"); go("/warehouses"); } catch (e: any) { toast(e.message, "err"); } };
  const refresh = () => { setSpin(true); window.dispatchEvent(new Event("sp-data-changed")); setTimeout(() => setSpin(false), 700); };
  const active = (whs.data || []).filter((w: any) => w.is_active);
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-[13px] text-sub"><Link to="/warehouses" className="hover:text-ink">Warehouses</Link><span>/</span><span className="text-ink">{d.name}</span></div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2"><h1 className="text-lg font-semibold">{d.name}</h1><span className="text-[13px] text-sub">{d.code}</span><StatusDot active={d.is_active} /></div>
        <div className="flex flex-wrap items-center gap-2">
          <button className="btn-ghost !px-2" onClick={refresh} aria-label="Refresh data" data-tip="Refresh"><RefreshCw className={`h-3.5 w-3.5 ${spin ? "animate-spin" : ""}`} /></button>
          {wMod && <button className="btn-ghost" onClick={() => go(`/warehouses/${id}/edit`)}><Pencil className="h-3.5 w-3.5" />Edit</button>}
          {iMod && d.is_active && <button className="btn-primary" onClick={() => setXfer(true)}><ArrowLeftRight className="h-3.5 w-3.5" />New Transfer</button>}
          {iMod && d.is_active && <button className="btn-ghost" onClick={() => setAdj(null)}><SlidersHorizontal className="h-3.5 w-3.5" />Adjust Stock</button>}
          {wMod && <div className="rounded-md border bg-surface"><RowMenu items={[
            { label: "Archive", icon: Archive, onClick: () => setArch(true), hidden: !d.is_active }, { label: "Restore", icon: ArchiveRestore, onClick: () => setActive(true), hidden: d.is_active },
            { label: "Delete", icon: Trash2, onClick: () => setDel(true), danger: true }]} /></div>}
        </div>
      </div>
      <TabBar tabs={TABS} active={tab} onChange={(k) => setTab(k)} />
      <div ref={body} className="min-h-[50vh]"><div key={tab} className="anim-up">
        {tab === "overview" && <Overview id={id} d={d} />}
        {tab === "items" && <Items id={id} canAdjust={iMod && d.is_active} onAdjust={(pid) => setAdj(pid)} />}
        {tab === "stock" && <StockTab id={id} canAdjust={iMod && d.is_active} onNew={() => setAdj(null)} goTab={setTab} />}
        {tab === "transfers" && <TransfersTab id={id} />}
        {tab === "activity" && <ActivityTab id={id} />}
      </div></div>
      {arch && <Confirm title="Archive warehouse" text={`Archive ${d.name}? It must hold no stock. You can restore it later.`} action="Archive" onConfirm={() => setActive(false)} onClose={() => setArch(false)} />}
      {del && <Confirm title="Delete warehouse" text={`Permanently delete ${d.name}? Only warehouses with no stock or transfer history can be deleted; otherwise archive it.`} action="Delete" onConfirm={remove} onClose={() => setDel(false)} />}
      {xfer && <TransferDialog whs={active} products={prods.data?.items || []} from={d.id} onClose={() => setXfer(false)} onDone={reload} />}
      {adj !== undefined && <ActionDialog kind="adjust" warehouse={d.id} product={adj || undefined} products={prods.data?.items || []} whs={active} onClose={() => setAdj(undefined)} onDone={() => { reload(); window.dispatchEvent(new Event("sp-data-changed")); }} />}
    </div>
  );
}
