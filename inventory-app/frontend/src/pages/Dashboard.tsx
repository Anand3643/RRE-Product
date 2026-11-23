import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { AlertTriangle, Boxes, Building2, ClipboardList, Contact, IndianRupee, PackageCheck, PackageX, Settings2, ShoppingCart, Store, Truck, TrendingUp, Wallet } from "lucide-react";
import { api, dt, fmt, money } from "../api";
import { useMe } from "../App";
import { Num } from "../fx";
import { Badge, Empty, Skeleton, useLoad } from "../ui";
import { d8 } from "./PurchaseOrders";

const WIDGETS = [["kpis", "KPI cards"], ["monthly", "Monthly sales & purchases"], ["revenue", "Revenue trend"], ["warehouses", "Stock by warehouse"], ["best", "Best-selling products"], ["movement", "Stock movement"], ["alerts", "Stock alerts"], ["transactions", "Recent transactions"], ["activity", "Recent activity"]] as const;
const tip = { contentStyle: { background: "rgb(var(--surface))", border: "1px solid rgb(var(--line))", borderRadius: 6, fontSize: 12, boxShadow: "var(--shadow-2)" }, cursor: { fill: "rgb(var(--muted) / .6)" } };
const loadPrefs = (): Record<string, boolean> => { try { return JSON.parse(localStorage.getItem("sp_widgets") || "{}"); } catch { return {}; } };
const iso = (d: Date) => d.toISOString().slice(0, 10);
const RANGES: [string, number][] = [["Last 30 days", 30], ["Last 90 days", 90], ["Last 6 months", 180], ["Last 12 months", 365]];
const TONE: Record<string, "ok" | "warn" | "bad" | "neutral" | "info"> = { draft: "neutral", confirmed: "info", packed: "warn", shipped: "info", delivered: "ok", cancelled: "bad", issued: "info", partially_received: "warn", received: "ok", posted: "ok" };
const axis = { tick: { fontSize: 11 }, stroke: "rgb(var(--sub))" }; const k = (v: number): string => (v >= 100000 ? `${(v / 100000).toFixed(1)}L` : v >= 1000 ? `${v / 1000}k` : String(v));

export default function Dashboard() {
  const { can } = useMe(); const go = useNavigate();
  const [range, setRange] = useState(180); const [wh, setWh] = useState(""); const [prefs, setPrefs] = useState(loadPrefs()); const [edit, setEdit] = useState(false);
  const whs = useLoad(() => (can("warehouses") ? api("/warehouses") : Promise.resolve([])));
  const qs = `date_from=${iso(new Date(Date.now() - (range - 1) * 864e5))}&date_to=${iso(new Date())}${wh ? `&warehouse_id=${wh}` : ""}`;
  const { data: d, loading, error } = useLoad(() => api(`/dashboard?${qs}`), [qs]);
  const on = (key: string) => prefs[key] !== false; const toggle = (key: string) => { const n = { ...prefs, [key]: !on(key) }; setPrefs(n); localStorage.setItem("sp_widgets", JSON.stringify(n)); };
  if (loading && !d) return <div className="card"><Skeleton rows={8} /></div>;
  if (error || !d) return <p className="text-red-500">{error || "Could not load dashboard"}</p>;

  type K = { label: string; v: number; money?: boolean; icon: any; sub: string; to?: string; warn?: boolean; show: boolean };
  const kpis: K[] = [
    { label: "Inventory value", v: d.inventory_value, money: true, icon: IndianRupee, sub: "at weighted avg. cost", to: "/reports/inventory_valuation", show: d.inventory_value != null },
    { label: "Total products", v: d.products, icon: Boxes, sub: `${d.variants} variants · ${fmt(d.available)} available`, to: "/products", show: d.products != null },
    { label: "Total customers", v: d.customers, icon: Contact, sub: "active", to: "/customers", show: d.customers !== undefined },
    { label: "Total vendors", v: d.vendors, icon: Store, sub: "active", to: "/vendors", show: d.vendors !== undefined },
    { label: "Total sales", v: d.sales_total, money: true, icon: TrendingUp, sub: `${d.sales_orders} orders in period`, to: "/reports/sales_summary", show: d.sales_total !== undefined },
    { label: "Total purchases", v: d.purchases_total, money: true, icon: Wallet, sub: `${d.purchase_orders} orders in period`, to: "/reports/purchase_summary", show: d.purchases_total !== undefined },
    { label: "Pending sales orders", v: d.pending_sales_orders, icon: ShoppingCart, sub: `${d.draft_sales_orders} drafts`, to: "/sales-orders?status=confirmed", warn: d.pending_sales_orders > 0, show: d.pending_sales_orders !== undefined },
    { label: "Pending purchase orders", v: d.pending_purchase_orders, icon: ClipboardList, sub: "awaiting delivery", to: "/purchase-orders?status=open", warn: d.pending_purchase_orders > 0, show: d.pending_purchase_orders !== undefined },
    { label: "Pending shipments", v: d.pending_shipments, icon: Truck, sub: "not yet delivered", to: "/shipments?status=active", warn: d.pending_shipments > 0, show: d.pending_shipments !== undefined },
    { label: "Low-stock products", v: d.low_stock.length, icon: AlertTriangle, sub: "at or below reorder level", to: "/reports/low_stock", warn: d.low_stock.length > 0, show: d.reserved != null },
    { label: "Out-of-stock products", v: d.out_of_stock.length, icon: PackageX, sub: "nothing available", to: "/reports/out_of_stock", warn: d.out_of_stock.length > 0, show: d.reserved != null },
    { label: "Reserved stock", v: d.reserved, icon: PackageCheck, sub: "committed to orders", to: "/inventory", show: d.reserved != null },
  ];
  const alerts = [...d.out_of_stock.map((x: any) => ({ ...x, out: true })), ...d.low_stock];
  const Card = ({ title, children, action, className = "" }: { title: string; children: React.ReactNode; action?: React.ReactNode; className?: string }) => <section className={`card p-4 ${className}`}><div className="mb-3 flex items-center justify-between"><h3 className="text-[13px] font-semibold">{title}</h3>{action}</div>{children}</section>;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2"><div><h1 className="text-xl font-semibold">Dashboard</h1><p className="text-[13px] text-sub">{d8(d.range.date_from)} – {d8(d.range.date_to)}{wh && whs.data ? ` · ${whs.data.find((w: any) => String(w.id) === wh)?.name}` : " · all warehouses"}</p></div>
        <div className="flex flex-wrap items-center gap-2">
          <select className="input !w-auto" value={range} onChange={(e) => setRange(+e.target.value)} aria-label="Date range">{RANGES.map(([l, n]) => <option key={n} value={n}>{l}</option>)}</select>
          {can("warehouses") && <select className="input !w-auto" value={wh} onChange={(e) => setWh(e.target.value)} aria-label="Warehouse"><option value="">All warehouses</option>{(whs.data || []).filter((w: any) => w.is_active).map((w: any) => <option key={w.id} value={w.id}>{w.code} — {w.name}</option>)}</select>}
          <button className="btn-ghost" onClick={() => setEdit(!edit)}><Settings2 className="h-4 w-4" />Customize</button></div></div>
      {edit && <div className="card anim-pop flex flex-wrap gap-4 p-4 text-sm">{WIDGETS.map(([key, l]) => <label key={key} className="flex items-center gap-2"><input type="checkbox" checked={on(key)} onChange={() => toggle(key)} />{l}</label>)}</div>}

      {on("kpis") && <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4">{kpis.filter((x) => x.show).map((x, i) => (
        <button key={x.label} onClick={() => x.to && go(x.to)} style={{ ["--i" as any]: i }} className={`card stagger p-4 text-left transition-all duration-200 hover:-translate-y-0.5 hover:shadow-[var(--shadow-2)] ${x.warn ? "border-amber-500/40" : ""}`}>
          <div className="flex items-center justify-between text-sub"><span className="text-xs font-medium">{x.label}</span><x.icon className={`h-4 w-4 ${x.warn ? "text-amber-500" : ""}`} /></div>
          <p className="mt-2 text-2xl font-semibold"><Num value={x.v ?? 0} prefix={x.money ? "₹" : ""} decimals={0} /></p><p className="text-xs text-sub">{x.sub}</p></button>))}</div>}

      <div className="grid gap-4 lg:grid-cols-2">
        {on("monthly") && d.monthly && <Card title="Monthly sales vs purchases">{!d.monthly.length ? <Empty title="No orders in this period" /> :
          <ResponsiveContainer width="100%" height={250}><BarChart data={d.monthly}><CartesianGrid strokeDasharray="3 3" stroke="rgb(var(--line))" /><XAxis dataKey="period" {...axis} /><YAxis {...axis} width={50} tickFormatter={k} /><Tooltip {...tip} formatter={(v: any) => money(v)} /><Legend wrapperStyle={{ fontSize: 12 }} />
            {d.sales_total !== undefined && <Bar dataKey="sales" name="Sales" fill="#0d9488" radius={[3, 3, 0, 0]} animationDuration={700} />}{d.purchases_total !== undefined && <Bar dataKey="purchases" name="Purchases" fill="#3b82f6" radius={[3, 3, 0, 0]} animationDuration={700} />}</BarChart></ResponsiveContainer>}</Card>}
        {on("revenue") && d.revenue_daily && <Card title="Revenue trend — last 30 days" action={<Link className="text-xs text-brand hover:underline" to="/reports/revenue_trend">Full report</Link>}>
          <ResponsiveContainer width="100%" height={250}><AreaChart data={d.revenue_daily}><CartesianGrid strokeDasharray="3 3" stroke="rgb(var(--line))" /><XAxis dataKey="date" {...axis} tickFormatter={(s) => s.slice(5)} interval={4} /><YAxis {...axis} width={50} tickFormatter={k} /><Tooltip {...tip} formatter={(v: any) => money(v)} labelFormatter={(s: any) => d8(s)} /><Area dataKey="revenue" name="Revenue" stroke="#0d9488" fill="#0d948833" animationDuration={700} /></AreaChart></ResponsiveContainer></Card>}
        {on("warehouses") && can("warehouses") && <Card title="Units on hand by warehouse">{!d.warehouses.length ? <Empty title="No warehouses" /> : <ResponsiveContainer width="100%" height={250}><BarChart data={d.warehouses}><CartesianGrid strokeDasharray="3 3" stroke="rgb(var(--line))" /><XAxis dataKey="code" {...axis} /><YAxis {...axis} width={50} tickFormatter={k} /><Tooltip {...tip} /><Bar dataKey="on_hand" name="On hand" fill="#0d9488" radius={[3, 3, 0, 0]} animationDuration={700} onClick={(e: any) => go(`/reports/stock_by_warehouse`)} cursor="pointer" /></BarChart></ResponsiveContainer>}</Card>}
        {on("best") && d.best_selling && <Card title="Best-selling products" action={<Link className="text-xs text-brand hover:underline" to="/reports/best_selling">Full report</Link>}>{!d.best_selling.length ? <Empty title="No sales in this period" /> :
          <ul className="space-y-2.5">{d.best_selling.map((b: any, i: number) => <li key={b.product_id} className="text-[13px]"><div className="flex justify-between"><Link className="font-medium hover:text-brand" to={`/products/${b.product_id}`}>{i + 1}. {b.name}</Link><span className="tabular-nums text-sub">{fmt(b.qty)} units · {money(b.revenue)}</span></div><div className="mt-1 h-1.5 overflow-hidden rounded bg-muted"><div className="h-full rounded bg-brand transition-all duration-700" style={{ width: `${(b.qty / d.best_selling[0].qty) * 100}%` }} /></div></li>)}</ul>}</Card>}
        {on("movement") && d.reserved != null && <Card title="Inbound vs outbound units (30 days)">{!d.movement_trend.length ? <Empty title="No movements yet" /> : <ResponsiveContainer width="100%" height={250}><AreaChart data={d.movement_trend}><CartesianGrid strokeDasharray="3 3" stroke="rgb(var(--line))" /><XAxis dataKey="date" {...axis} tickFormatter={(s) => s.slice(5)} /><YAxis {...axis} width={40} /><Tooltip {...tip} /><Area dataKey="inbound" name="Inbound" stroke="#0d9488" fill="#0d948833" animationDuration={700} /><Area dataKey="outbound" name="Outbound" stroke="#3b82f6" fill="#3b82f633" animationDuration={700} /></AreaChart></ResponsiveContainer>}</Card>}
        {on("alerts") && d.reserved != null && <Card title="Stock alerts" action={<Link className="text-xs text-brand hover:underline" to="/reports/low_stock">Low-stock report</Link>}>{!alerts.length ? <Empty title="All stock levels healthy" /> : <ul className="divide-y">{alerts.slice(0, 8).map((a: any) => <li key={`${a.id}-${a.out}`} className="flex items-center justify-between py-2 text-[13px]"><Link className="hover:text-brand" to={`/products/${a.id}`}>{a.name}<span className="ml-2 text-xs text-sub">{a.sku}</span></Link>{a.out ? <Badge tone="bad">Out of stock</Badge> : <Badge tone="warn">{fmt(a.available)} / {fmt(a.reorder_point)}</Badge>}</li>)}</ul>}</Card>}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {on("transactions") && d.recent_transactions && <Card title="Recent transactions">{!d.recent_transactions.length ? <Empty title="No transactions yet" /> : <ul className="divide-y">{d.recent_transactions.map((t: any, i: number) => <li key={`${t.number}${i}`} className="flex items-center gap-3 py-2 text-[13px]"><div className="min-w-0 flex-1">{t.link ? <Link className="font-medium text-brand hover:underline" to={t.link}>{t.number}</Link> : <span className="font-medium">{t.number}</span>}<div className="truncate text-xs text-sub">{t.kind} · {t.who}</div></div><Badge tone={TONE[t.status] || "neutral"}>{String(t.status).replace(/_/g, " ")}</Badge><span className="w-24 text-right tabular-nums">{money(t.amount)}</span></li>)}</ul>}</Card>}
        {on("activity") && <Card title="Recent activity">{d.recent_activities ? (!d.recent_activities.length ? <Empty title="No activity" /> : <ul className="divide-y">{d.recent_activities.map((a: any) => <li key={a.id} className="flex items-center justify-between gap-3 py-2 text-[13px]"><span><b className="font-medium">{a.who || "System"}</b> <span className="capitalize text-sub">{String(a.action).replace(/_/g, " ")}</span> {a.entity.replace(/_/g, " ")} {a.entity_id}</span><span className="shrink-0 text-xs text-sub">{dt(a.when)}</span></li>)}</ul>) :
          <ul className="divide-y">{d.recent.map((r: any) => <li key={r.id} className="flex items-center justify-between py-2 text-[13px]"><span>{r.product}<span className="ml-2 text-xs capitalize text-sub">{r.type.replace("_", " ")}</span></span><span className={r.qty_delta >= 0 ? "text-emerald-600" : "text-red-500"}>{r.qty_delta > 0 ? "+" : ""}{r.qty_delta}</span></li>)}</ul>}</Card>}
      </div>
    </div>
  );
}
void Building2;
