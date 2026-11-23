import { ReactNode, useState } from "react";
import { Link } from "react-router-dom";
import { Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { api, dt, fmt, money } from "../api";
import { useMe } from "../App";
import { Badge, Empty, Skeleton, useLoad } from "../ui";
import { TransferDialog } from "./Transfers";

const COLORS = ["#0d9488", "#3b82f6", "#f59e0b", "#8b5cf6", "#ef4444", "#64748b"];
const Section = ({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) => (
  <div className="card"><div className="border-b px-4 py-3"><h3 className="text-sm font-semibold">{title}</h3>{hint && <p className="text-xs text-sub">{hint}</p>}</div><div className="overflow-x-auto">{children}</div></div>);
const Tbl = ({ head, rows, empty }: { head: string[]; rows: ReactNode[][]; empty: string }) => !rows.length ? <Empty title={empty} /> : (
  <table className="w-full"><thead className="border-b bg-muted/50"><tr>{head.map((h) => <th key={h} className="th">{h}</th>)}</tr></thead><tbody className="divide-y">{rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j} className="td">{c}</td>)}</tr>)}</tbody></table>);

export default function Insights() {
  const { can } = useMe();
  const [wh, setWh] = useState("");
  const whs = useLoad(() => api("/warehouses")); const prods = useLoad(() => api("/products?page_size=200"));
  const { data: d, loading, error, reload } = useLoad(() => api(`/insights${wh ? `?warehouse_id=${wh}` : ""}`), [wh]);
  const prs = useLoad(() => (can("purchases") ? api("/purchase-requests") : Promise.resolve([])));
  const [xfer, setXfer] = useState<any>(null);
  const w = can("inventory", "w");
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2"><div><h1 className="text-xl font-semibold">AI Insights</h1>
        <p className="text-sm text-sub">Computed live from stock balances and the last {d?.window_days ?? 30} days of movements.</p></div>
        <select className="input w-auto" value={wh} onChange={(e) => setWh(e.target.value)}><option value="">All warehouses</option>{(whs.data || []).filter((x: any) => x.is_active).map((x: any) => <option key={x.id} value={x.id}>{x.code} — {x.name}</option>)}</select></div>
      {loading ? <div className="card"><Skeleton rows={8} /></div> : error || !d ? <p className="text-red-500">{error}</p> : <>
        <div className="grid gap-4 lg:grid-cols-3">
          <div className="card p-4 lg:col-span-2"><h3 className="text-sm font-semibold">Warehouse efficiency score</h3><p className="mb-2 text-xs text-sub">{d.score_formula}</p>
            {!d.efficiency.length ? <Empty title="No warehouse data" /> : <ResponsiveContainer width="100%" height={220}><BarChart data={d.efficiency}><CartesianGrid strokeDasharray="3 3" stroke="rgb(var(--line))" /><XAxis dataKey="code" tick={{ fontSize: 11 }} /><YAxis domain={[0, 100]} tick={{ fontSize: 11 }} />
              <Tooltip contentStyle={{ background: "rgb(var(--surface))", border: "1px solid rgb(var(--line))", borderRadius: 8 }} /><Bar dataKey="score" name="Score" fill="#0d9488" radius={[4, 4, 0, 0]} /><Bar dataKey="stock_health_pct" name="Stock health %" fill="#3b82f6" radius={[4, 4, 0, 0]} /></BarChart></ResponsiveContainer>}</div>
          <div className="card p-4"><h3 className="text-sm font-semibold">Inventory value distribution</h3>
            {!d.efficiency.length ? <Empty title="No data" /> : <ResponsiveContainer width="100%" height={220}><PieChart><Pie data={d.efficiency} dataKey="value_share_pct" nameKey="code" outerRadius={80} label={(e: any) => `${e.code} ${e.value_share_pct}%`}>{d.efficiency.map((_: any, i: number) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}</Pie><Tooltip /></PieChart></ResponsiveContainer>}</div>
        </div>

        <Section title="Recommended transfers" hint="Surplus in one warehouse that covers a shortage in another.">
          <Tbl empty="No redistribution needed" head={["Item", "From", "To", "Qty", "Why", ""]} rows={d.recommended_transfers.map((r: any) => [<span>{r.name}<span className="ml-2 text-xs text-sub">{r.sku}</span></span>, r.from_code, r.to_code, r.quantity, <span className="text-xs text-sub">{r.reason}</span>,
            w ? <button className="text-xs text-brand" onClick={() => setXfer(r)}>Review & transfer</button> : null])} /></Section>

        <div className="grid gap-4 xl:grid-cols-2">
          <Section title="Shortage predictions" hint="Days of cover = available ÷ average daily sales; flagged under 14 days.">
            <Tbl empty="No shortages predicted" head={["Item", "WH", "Avail.", "Per day", "Days left", "Runs out"]} rows={d.shortages.map((s: any) => [<span>{s.name}<span className="ml-2 text-xs text-sub">{s.sku}</span></span>, s.warehouse, fmt(s.available), s.daily_rate, <Badge tone={s.severity === "critical" ? "bad" : "warn"}>{s.days_cover}d</Badge>, s.stockout_date])} /></Section>
          <Section title="Predicted 30-day requirements" hint="Company-wide demand vs. available stock; suggested order covers the gap.">
            <Tbl empty="Stock covers the next 30 days" head={["Item", "Available", "30-day demand", "Suggested order"]} rows={d.requirements.map((r: any) => [<span>{r.name}<span className="ml-2 text-xs text-sub">{r.sku}</span></span>, fmt(r.available), r.demand_30d, <b>{fmt(r.suggested_order_qty)}</b>])} /></Section>
          <Section title="Excess stock" hint="Over 90 days of cover (or well above reorder point with no sales).">
            <Tbl empty="No excess stock" head={["Item", "WH", "Available", "Target", "Excess", "Value"]} rows={d.excess.map((x: any) => [<span>{x.name}<span className="ml-2 text-xs text-sub">{x.sku}</span></span>, x.warehouse, fmt(x.available), fmt(x.target), fmt(x.excess_qty), money(x.excess_value)])} /></Section>
          <Section title="Slow-moving inventory" hint="Stocked, but nothing issued in the last 30 days.">
            <Tbl empty="Everything is moving" head={["Item", "WH", "On hand", "Value tied up"]} rows={d.slow_moving.map((x: any) => [<span>{x.name}<span className="ml-2 text-xs text-sub">{x.sku}</span></span>, x.warehouse, fmt(x.on_hand), money(x.value)])} /></Section>
        </div>

        <Section title="Unusual stock movements" hint="Quantities far above the item's norm, or adjustments that wrote off half the stock.">
          <Tbl empty="No anomalies in the last 30 days" head={["When", "Item", "WH", "Type", "Change", "Why flagged"]} rows={d.anomalies.map((a: any) => [dt(a.when), <span>{a.name}<span className="ml-2 text-xs text-sub">{a.sku}</span></span>, a.warehouse, a.type, fmt(a.qty_delta, 3), <span className="text-xs">{a.why}</span>])} /></Section>

        {can("purchases") && <Section title="Purchase requests" hint="Created from the assistant after confirmation.">
          <Tbl empty={'No purchase requests yet. Ask the assistant: "create purchase request for low stock"'} head={["Number", "Created", "Items", "Source"]} rows={(prs.data || []).map((p: any) => [p.number, dt(p.created_at), p.lines.map((l: any) => `${l.sku} × ${l.quantity}`).join(", "), <Badge tone={p.source === "assistant" ? "warn" : "neutral"}>{p.source}</Badge>])} /></Section>}
        <p className="text-xs text-sub">Prefer a table? See <Link className="text-brand" to="/warehouses">Warehouses</Link> for per-location stock.</p>
      </>}
      {xfer && <TransferDialog whs={(whs.data || []).filter((x: any) => x.is_active)} products={prods.data?.items || []} from={xfer.from_warehouse_id} to={xfer.to_warehouse_id} lines={[{ product_id: String(xfer.product_id), quantity: String(xfer.quantity) }]} onClose={() => setXfer(null)} onDone={reload} />}
    </div>
  );
}
