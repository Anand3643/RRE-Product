import { Link, useNavigate } from "react-router-dom";
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { AlertTriangle, ClipboardList, Contact, IndianRupee, KeyRound, Lock, ShieldCheck, ShoppingCart, Store, Truck, UserCheck, UserX, Users, Boxes } from "lucide-react";
import { api, dt, fmt, money } from "../api";
import { useMe } from "../App";
import { Num } from "../fx";
import { Badge, Empty, Skeleton, useLoad } from "../ui";

const tip = { contentStyle: { background: "rgb(var(--surface))", border: "1px solid rgb(var(--line))", borderRadius: 6, fontSize: 12 }, cursor: { fill: "rgb(var(--muted) / .6)" } };
const axis = { tick: { fontSize: 11 }, stroke: "rgb(var(--sub))" };
const k = (v: number): string => (v >= 100000 ? `${(v / 100000).toFixed(1)}L` : v >= 1000 ? `${v / 1000}k` : String(v));

export default function AdminDashboard() {
  const { me } = useMe(); const go = useNavigate();
  const biz = useLoad(() => api("/dashboard"));
  if (biz.loading) return <div className="card"><Skeleton rows={8} /></div>;
  if (biz.error) return <p className="text-red-500">{biz.error}</p>;
  const d = biz.data;
  const pending = d ? (d.pending_sales_orders ?? 0) + (d.pending_purchase_orders ?? 0) + (d.pending_shipments ?? 0) : 0;
  type Kp = { label: string; v: number; icon: any; sub: string; to?: string; money?: boolean; warn?: boolean };
  const business: Kp[] = d ? [
    { label: "Inventory on hand", v: d.on_hand ?? 0, icon: Boxes, sub: `${money(d.inventory_value ?? 0)} at average cost`, to: "/inventory" },
    { label: "Customers", v: d.customers ?? 0, icon: Contact, sub: "active", to: "/customers" },
    { label: "Vendors", v: d.vendors ?? 0, icon: Store, sub: "active", to: "/vendors" },
    { label: "Sales (6 months)", v: d.sales_total ?? 0, icon: IndianRupee, sub: `${d.sales_orders ?? 0} orders`, money: true, to: "/reports/sales_summary" },
    { label: "Purchases (6 months)", v: d.purchases_total ?? 0, icon: ShoppingCart, sub: `${d.purchase_orders ?? 0} orders`, money: true, to: "/reports/purchase_summary" },
    { label: "Pending transactions", v: pending, icon: ClipboardList, sub: `${d.pending_sales_orders ?? 0} sales · ${d.pending_purchase_orders ?? 0} purchase · ${d.pending_shipments ?? 0} shipments`, to: "/shipments?status=active", warn: pending > 0 },
  ] : [];
  const Tile = ({ x, i }: { x: Kp; i: number }) => (
    <button onClick={() => x.to && go(x.to)} style={{ ["--i" as any]: i }} className={`card stagger p-4 text-left transition-all duration-200 hover:-translate-y-0.5 hover:shadow-[var(--shadow-2)] ${x.warn ? "border-amber-500/40" : ""}`}>
      <div className="flex items-center justify-between text-sub"><span className="text-xs font-medium">{x.label}</span><x.icon className={`h-4 w-4 ${x.warn ? "text-amber-500" : ""}`} /></div>
      <p className="mt-2 text-2xl font-semibold"><Num value={x.v} prefix={x.money ? "₹" : ""} /></p><p className="text-xs text-sub">{x.sub}</p></button>);
  const Card = ({ title, children, action }: { title: string; children: React.ReactNode; action?: React.ReactNode }) => <section className="card p-4"><div className="mb-3 flex items-center justify-between"><h3 className="text-[13px] font-semibold">{title}</h3>{action}</div>{children}</section>;
  return (
    <div className="space-y-4" data-testid="admin-dashboard">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div><h1 className="flex items-center gap-2 text-xl font-semibold"><ShieldCheck className="h-5 w-5 text-brand" />Dashboard</h1><p className="text-[13px] text-sub">Signed in as {me.name} · {me.org.name}</p></div>
      </div>
      {d && <div className="grid grid-cols-2 gap-3 md:grid-cols-3">{business.map((x, i) => <Tile key={x.label} x={x} i={i + 4} />)}</div>}
      <div className="grid gap-4 lg:grid-cols-2">
        {d?.monthly && <Card title="Sales & purchase overview" action={<Link className="text-xs text-brand hover:underline" to="/reports">Reports</Link>}>{!d.monthly.length ? <Empty title="No orders in this period" /> :
          <ResponsiveContainer width="100%" height={240}><BarChart data={d.monthly}><CartesianGrid strokeDasharray="3 3" stroke="rgb(var(--line))" /><XAxis dataKey="period" {...axis} /><YAxis {...axis} width={50} tickFormatter={k} /><Tooltip {...tip} formatter={(v: any) => money(v)} /><Legend wrapperStyle={{ fontSize: 12 }} />
            <Bar dataKey="sales" name="Sales" fill="#0d9488" radius={[3, 3, 0, 0]} /><Bar dataKey="purchases" name="Purchases" fill="#3b82f6" radius={[3, 3, 0, 0]} /></BarChart></ResponsiveContainer>}</Card>}
        {d?.warehouses && <Card title="Warehouse overview" action={<Link className="text-xs text-brand hover:underline" to="/warehouses">Warehouses</Link>}>{!d.warehouses.length ? <Empty title="No warehouses" /> :
          <ResponsiveContainer width="100%" height={240}><BarChart data={d.warehouses}><CartesianGrid strokeDasharray="3 3" stroke="rgb(var(--line))" /><XAxis dataKey="code" {...axis} /><YAxis {...axis} width={50} tickFormatter={k} /><Tooltip {...tip} /><Bar dataKey="on_hand" name="Units on hand" fill="#0d9488" radius={[3, 3, 0, 0]} /></BarChart></ResponsiveContainer>}</Card>}
      </div>
      {d && <p className="text-xs text-sub"><Truck className="mr-1 inline h-3 w-3" />Business figures cover the last 6 months. Open the <Link className="text-brand hover:underline" to="/">operations dashboard</Link> for filters and more charts.</p>}
    </div>
  );
}
