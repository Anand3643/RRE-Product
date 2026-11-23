import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { ArrowDown, ArrowUp, ArrowUpDown, BarChart3, ChevronRight, Download, FileSpreadsheet, FileText, Printer, Search, X } from "lucide-react";
import { api, download, fmt, money } from "../api";
import { Combobox, Num } from "../fx";
import { openPdf, printPdf } from "../media";
import { Badge, Empty, Skeleton, useLoad, useToast } from "../ui";

const PALETTE = ["#0d9488", "#3b82f6", "#f59e0b", "#8b5cf6", "#ef4444", "#14b8a6", "#64748b", "#ec4899"];
const GROUP_ICON: Record<string, string> = { Inventory: "bg-teal-500/10 text-teal-600", Sales: "bg-blue-500/10 text-blue-600", Purchases: "bg-amber-500/10 text-amber-600", Warehouse: "bg-violet-500/10 text-violet-600", Analytics: "bg-pink-500/10 text-pink-600" };
const tip = { contentStyle: { background: "rgb(var(--surface))", border: "1px solid rgb(var(--line))", borderRadius: 6, fontSize: 12, boxShadow: "var(--shadow-2)" }, cursor: { fill: "rgb(var(--muted) / .6)" } };
const iso = (d: Date) => d.toISOString().slice(0, 10);
function presets() {
  const t = new Date(), y = t.getFullYear(), m = t.getMonth(); const fyStart = m >= 3 ? new Date(y, 3, 1) : new Date(y - 1, 3, 1);
  return [["Last 30 days", iso(new Date(Date.now() - 29 * 864e5)), iso(t)], ["Last 90 days", iso(new Date(Date.now() - 89 * 864e5)), iso(t)], ["This month", iso(new Date(y, m, 1)), iso(t)], ["Last month", iso(new Date(y, m - 1, 1)), iso(new Date(y, m, 0))],
    ["This quarter", iso(new Date(y, Math.floor(m / 3) * 3, 1)), iso(t)], ["This financial year", iso(fyStart), iso(t)], ["Last 12 months", iso(new Date(y, m - 11, 1)), iso(t)]] as [string, string, string][];
}
export const cellText = (c: any, v: any) => v == null || v === "" ? "—" : c.type === "money" ? money(v) : c.type === "percent" ? `${v}%` : c.type === "number" ? (typeof v === "number" ? fmt(v, 3) : v) : c.type === "date" ? String(v) : String(v);

/* ============================== catalog ============================== */
export function ReportsHome() {
  const { data, loading, error } = useLoad(() => api("/reports")); const [q, setQ] = useState("");
  const groups = useMemo(() => { const g: Record<string, any[]> = {}; (data || []).filter((r: any) => !q || `${r.title} ${r.description}`.toLowerCase().includes(q.toLowerCase())).forEach((r: any) => (g[r.group] ||= []).push(r)); return g; }, [data, q]);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2"><div><h1 className="text-lg font-semibold">Reports</h1><p className="text-[13px] text-sub">Live reports from your inventory, sales, purchase and warehouse records. Export any of them to Excel, PDF or CSV.</p></div>
        <div className="relative w-full max-w-xs"><Search className="pointer-events-none absolute left-2.5 top-2 h-3.5 w-3.5 text-sub" /><input className="input !pl-8 !pr-7" placeholder="Find a report…" value={q} onChange={(e) => setQ(e.target.value)} />{q && <button className="absolute right-1.5 top-1.5 rounded p-0.5 text-sub hover:bg-muted" onClick={() => setQ("")} aria-label="Clear"><X className="h-3.5 w-3.5" /></button>}</div></div>
      {loading ? <div className="card"><Skeleton rows={6} /></div> : error ? <p className="text-red-500">{error}</p> : !Object.keys(groups).length ? <div className="card"><Empty title="No reports match" /></div> :
        <div className="grid gap-3 lg:grid-cols-2">{Object.entries(groups).map(([g, rs], gi) => (
          <section key={g} style={{ ["--i" as any]: gi }} className="card stagger"><h2 className="flex items-center gap-2 border-b px-4 py-2.5 text-[13px] font-semibold"><span className={`flex h-6 w-6 items-center justify-center rounded ${GROUP_ICON[g] || "bg-muted"}`}><BarChart3 className="h-3.5 w-3.5" /></span>{g}<span className="ml-auto text-xs font-normal text-sub">{rs.length} report{rs.length !== 1 ? "s" : ""}</span></h2>
            <ul className="divide-y">{rs.map((r: any) => <li key={r.key}><Link to={`/reports/${r.key}`} className="group flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-muted/60"><div className="min-w-0 flex-1"><p className="text-[13px] font-medium group-hover:text-brand">{r.title}</p><p className="truncate text-xs text-sub">{r.description}</p></div><ChevronRight className="h-4 w-4 shrink-0 text-sub transition-transform group-hover:translate-x-0.5" /></Link></li>)}</ul></section>))}</div>}
    </div>
  );
}

/* ============================== viewer ============================== */
function ReportChart({ r }: { r: any }) {
  const ch = r.chart; const [hidden, setHidden] = useState<Record<string, boolean>>({});
  if (!ch) return null;
  let data: any[] = ch.data || r.rows; if (ch.limit && !ch.data) data = data.slice(0, ch.limit);
  if (!data.length) return null;
  const series = ch.series.filter((s: any) => !hidden[s.key]); const toggle = (e: any) => setHidden((h) => ({ ...h, [e.dataKey]: !h[e.dataKey] }));
  const axis = { tick: { fontSize: 11 }, stroke: "rgb(var(--sub))" }; const label = (v: any) => (typeof v === "string" && v.length > 14 ? v.slice(0, 13) + "…" : v);
  const moneyish = r.columns.find((c: any) => c.key === ch.series[0].key)?.type === "money";
  const fmtV = (v: any) => (moneyish ? money(v) : fmt(v, 2));
  const grid = <CartesianGrid strokeDasharray="3 3" stroke="rgb(var(--line))" />;
  const legend = <Legend onClick={toggle} wrapperStyle={{ fontSize: 12, cursor: "pointer" }} formatter={(v) => <span className={hidden[ch.series.find((s: any) => s.label === v)?.key] ? "opacity-40" : ""}>{v}</span>} />;
  return (
    <div className="card p-4"><ResponsiveContainer width="100%" height={280}>
      {ch.kind === "pie" ? <PieChart><Pie data={data} dataKey={ch.series[0].key} nameKey={ch.x} innerRadius={60} outerRadius={105} paddingAngle={2} animationDuration={700} label={(e: any) => `${label(e[ch.x])}`}>{data.map((_, i) => <Cell key={i} fill={PALETTE[i % PALETTE.length]} />)}</Pie><Tooltip {...tip} formatter={(v: any) => fmtV(v)} /></PieChart>
        : ch.kind === "line" ? <LineChart data={data}>{grid}<XAxis dataKey={ch.x} {...axis} /><YAxis {...axis} width={60} tickFormatter={(v: number) => (v >= 1000 ? `${v / 1000}k` : String(v))} /><Tooltip {...tip} formatter={(v: any) => fmtV(v)} />{legend}{series.map((s: any, i: number) => <Line key={s.key} dataKey={s.key} name={s.label} stroke={PALETTE[ch.series.indexOf(s) % PALETTE.length]} strokeWidth={2} dot={false} animationDuration={700} />)}</LineChart>
        : ch.kind === "area" ? <AreaChart data={data}>{grid}<XAxis dataKey={ch.x} {...axis} /><YAxis {...axis} width={60} tickFormatter={(v: number) => (v >= 1000 ? `${v / 1000}k` : String(v))} /><Tooltip {...tip} formatter={(v: any) => fmtV(v)} />{legend}{series.map((s: any) => <Area key={s.key} dataKey={s.key} name={s.label} stroke={PALETTE[ch.series.indexOf(s) % PALETTE.length]} fill={PALETTE[ch.series.indexOf(s) % PALETTE.length] + "33"} animationDuration={700} />)}</AreaChart>
        : <BarChart data={data}>{grid}<XAxis dataKey={ch.x} {...axis} tickFormatter={label} interval={0} angle={data.length > 6 ? -25 : 0} textAnchor={data.length > 6 ? "end" : "middle"} height={data.length > 6 ? 60 : 30} /><YAxis {...axis} width={60} tickFormatter={(v: number) => (v >= 1000 ? `${v / 1000}k` : String(v))} /><Tooltip {...tip} formatter={(v: any) => fmtV(v)} />{legend}
          {series.map((s: any) => <Bar key={s.key} dataKey={s.key} name={s.label} stackId={ch.kind === "stacked" ? "a" : undefined} fill={PALETTE[ch.series.indexOf(s) % PALETTE.length]} radius={ch.kind === "stacked" ? 0 : [3, 3, 0, 0]} animationDuration={700} />)}</BarChart>}
    </ResponsiveContainer></div>
  );
}

export function ReportView() {
  const { key = "" } = useParams(); const [sp, setSp] = useSearchParams(); const toast = useToast(); const go = useNavigate();
  const params = Object.fromEntries(sp.entries()); const setP = (k: string, v: string) => { const n = new URLSearchParams(sp); v ? n.set(k, v) : n.delete(k); setSp(n, { replace: true }); };
  const qs = new URLSearchParams(sp).toString();
  const { data: r, loading, error } = useLoad(() => api(`/reports/${key}${qs ? `?${qs}` : ""}`), [key, qs]);
  const whs = useLoad(() => api("/warehouses").catch(() => [])); const prods = useLoad(() => api("/products?page_size=200&status=all").catch(() => ({ items: [] })));
  const custs = useLoad(() => api("/customers?page_size=200&status=all").catch(() => ({ items: [] }))); const vends = useLoad(() => api("/vendors?page_size=200&status=all").catch(() => ({ items: [] })));
  const [sort, setSort] = useState<{ k: string; desc: boolean } | null>(null); useEffect(() => setSort(null), [key]);
  const rows = useMemo(() => { if (!r) return []; if (!sort) return r.rows; return [...r.rows].sort((a: any, b: any) => { const x = a[sort.k], y = b[sort.k]; const c = typeof x === "number" && typeof y === "number" ? x - y : String(x ?? "").localeCompare(String(y ?? "")); return sort.desc ? -c : c; }); }, [r, sort]);
  const f: string[] = r?.filters || []; const ap = r?.applied || {};
  const exp = (fmtName: "xlsx" | "pdf" | "csv") => download(`/reports/${key}/export.${fmtName}${qs ? `?${qs}` : ""}`, `${key}.${fmtName}`).then(() => toast(`${fmtName.toUpperCase()} downloaded`)).catch((e: any) => toast(e.message, "err"));
  const pdfPath = `/reports/${key}/export.pdf${qs ? `?${qs}` : ""}`;
  const Sel = ({ k, label, opts }: { k: string; label: string; opts: [string | number, string][] }) => <select className="input !w-auto" value={params[k] || ""} onChange={(e) => setP(k, e.target.value)} aria-label={label}><option value="">{label}: All</option>{opts.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>;
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-[13px] text-sub"><Link to="/reports" className="hover:text-ink">Reports</Link><span>/</span>{r && <><span>{r.group}</span><span>/</span></>}<span className="text-ink">{r?.title || key}</span></div>
      <div className="flex flex-wrap items-start justify-between gap-2"><div><h1 className="text-lg font-semibold">{r?.title || "Report"}</h1>{r && <p className="text-[13px] text-sub">{r.description}</p>}</div>
        <div className="flex flex-wrap gap-2"><button className="btn-ghost" onClick={() => exp("xlsx")}><FileSpreadsheet className="h-3.5 w-3.5" />Excel</button><button className="btn-ghost" onClick={() => exp("pdf")}><FileText className="h-3.5 w-3.5" />PDF</button><button className="btn-ghost" onClick={() => exp("csv")}><Download className="h-3.5 w-3.5" />CSV</button><button className="btn-ghost" onClick={() => printPdf(pdfPath).catch((e) => toast(e.message, "err"))}><Printer className="h-3.5 w-3.5" />Print</button></div></div>
      {r && <div className="card flex flex-wrap items-center gap-2 p-2.5">
        {f.includes("date") && <><select className="input !w-auto" aria-label="Period" value="" onChange={(e) => { const p = presets().find((x) => x[0] === e.target.value); if (p) { const n = new URLSearchParams(sp); n.set("date_from", p[1]); n.set("date_to", p[2]); setSp(n, { replace: true }); } }}><option value="">Period: {params.date_from || ap.date_from} → {params.date_to || ap.date_to}</option>{presets().map(([l]) => <option key={l} value={l}>{l}</option>)}</select>
          <input type="date" className="input !w-auto" aria-label="From date" value={params.date_from || ap.date_from || ""} onChange={(e) => setP("date_from", e.target.value)} /><span className="text-sub">to</span><input type="date" className="input !w-auto" aria-label="To date" value={params.date_to || ap.date_to || ""} onChange={(e) => setP("date_to", e.target.value)} /></>}
        {f.includes("warehouse") && <Sel k="warehouse_id" label="Warehouse" opts={(whs.data || []).filter((w: any) => w.is_active).map((w: any) => [w.id, `${w.code} — ${w.name}`])} />}
        {f.includes("customer") && <Sel k="customer_id" label="Customer" opts={(custs.data?.items || []).map((c: any) => [c.id, c.name])} />}{f.includes("vendor") && <Sel k="vendor_id" label="Vendor" opts={(vends.data?.items || []).map((v: any) => [v.id, v.name])} />}
        {f.includes("product") && <div className="w-60"><Combobox options={[{ id: "", name: "All products", sku: "" }, ...(prods.data?.items || [])]} value={params.product_id ? +params.product_id : ""} onChange={(p: any) => setP("product_id", String(p.id))} render={(p: any) => <span>{p.name}{p.sku && <span className="ml-2 text-xs text-sub">{p.sku}</span>}</span>} search={(p: any) => `${p.name}|${p.sku || ""}`} placeholder="Product: All" /></div>}
        {f.includes("group") && <select className="input !w-auto" aria-label="Group by" value={params.group || "month"} onChange={(e) => setP("group", e.target.value)}><option value="day">Group: Daily</option><option value="week">Group: Weekly</option><option value="month">Group: Monthly</option></select>}
        {f.includes("days") && <label className="flex items-center gap-1.5 text-[13px] text-sub">No sales in<input type="number" min="1" max="730" className="input !w-20" value={params.days || 30} onChange={(e) => setP("days", e.target.value)} />days</label>}
        {[...sp.keys()].length > 0 && <button className="ml-auto text-xs text-brand hover:underline" onClick={() => setSp({}, { replace: true })}>Reset filters</button>}</div>}
      {loading && !r ? <div className="card"><Skeleton rows={7} /></div> : error ? <div className="card p-4 text-red-500">{error}</div> : r && (<>
        {r.note && <p className="text-xs text-sub">{r.note}</p>}
        <ReportChart r={r} />
        <div className={`card overflow-hidden transition-opacity ${loading ? "opacity-60" : ""}`}>
          <div className="flex items-center justify-between border-b px-3 py-2 text-[13px]"><span className="font-semibold">{r.row_count} row{r.row_count !== 1 ? "s" : ""}</span><span className="text-xs text-sub">Generated {new Date(r.generated_at).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}</span></div>
          {!rows.length ? <Empty title="No data for these filters" hint="Try a wider date range or remove a filter." /> : <div className="max-h-[560px] overflow-auto"><table className="w-full min-w-[640px]"><thead className="sticky top-0 z-10 border-b bg-muted/90 backdrop-blur"><tr>{r.columns.map((c: any) => <th key={c.key} onClick={() => setSort(sort && sort.k === c.key ? { k: c.key, desc: !sort.desc } : { k: c.key, desc: false })} className={`th cursor-pointer select-none whitespace-nowrap hover:text-ink ${c.align === "right" ? "text-right" : ""}`}><span className="inline-flex items-center gap-1">{c.label}{sort && sort.k === c.key ? (sort.desc ? <ArrowDown className="h-3 w-3 text-brand" /> : <ArrowUp className="h-3 w-3 text-brand" />) : <ArrowUpDown className="h-3 w-3 opacity-30" />}</span></th>)}</tr></thead>
            <tbody className="divide-y">{rows.map((row: any, i: number) => <tr key={i} className="transition-colors hover:bg-muted/60">{r.columns.map((c: any) => <td key={c.key} className={`td ${c.align === "right" ? "text-right tabular-nums" : ""}`}>{c.type === "badge" ? <Badge tone={/out|fail|cancel/i.test(row[c.key]) ? "bad" : /low|part|ready|packed/i.test(row[c.key]) ? "warn" : /deliver|receiv|in stock|shipped|complete/i.test(row[c.key]) ? "ok" : "neutral"}>{row[c.key]}</Badge> : cellText(c, row[c.key])}</td>)}</tr>)}</tbody>
            {Object.keys(r.totals || {}).length > 0 && <tfoot className="sticky bottom-0 border-t-2 bg-muted/90 font-semibold backdrop-blur"><tr>{r.columns.map((c: any, i: number) => <td key={c.key} className={`td ${c.align === "right" ? "text-right tabular-nums" : ""}`}>{i === 0 ? "Total" : r.totals[c.key] != null ? cellText(c, r.totals[c.key]) : ""}</td>)}</tr></tfoot>}</table></div>}
        </div></>)}
    </div>
  );
}
void useNavigate; void Num; void openPdf;
