import { useState } from "react";
import { ArrowRight, Plus, Trash2 } from "lucide-react";
import { api, dt, fmt } from "../api";
import { useMe } from "../App";
import { Badge, Empty, Field, Modal, Skeleton, useLoad, useToast } from "../ui";

type Line = { product_id: string; quantity: string };

export function TransferDialog({ whs, products, from, to, lines, onClose, onDone }: { whs: any[]; products: any[]; from?: number; to?: number; lines?: Line[]; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [f, setF] = useState({ from: String(from || whs[0]?.id || ""), to: String(to || whs.find((w) => w.id !== (from || whs[0]?.id))?.id || ""), notes: "" });
  const [ls, setLs] = useState<Line[]>(lines?.length ? lines : [{ product_id: "", quantity: "" }]);
  const [busy, setBusy] = useState(false);
  const setLine = (i: number, k: keyof Line, v: string) => setLs(ls.map((l, j) => (j === i ? { ...l, [k]: v } : l)));
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true);
    try {
      const r = await api("/transfers", { body: { from_warehouse_id: +f.from, to_warehouse_id: +f.to, notes: f.notes || null, lines: ls.map((l) => ({ product_id: +l.product_id, quantity: +l.quantity })) } });
      toast(`Transfer ${r.number} completed`); window.dispatchEvent(new Event("sp-data-changed")); onDone(); onClose();
    } catch (e: any) { toast(e.message, "err"); } finally { setBusy(false); }
  };
  return (
    <Modal title="New stock transfer" onClose={onClose} wide>
      <form onSubmit={submit} className="space-y-4">
        <div className="grid grid-cols-[1fr_auto_1fr] items-end gap-3">
          <Field label="Source warehouse"><select className="input" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })}>{whs.map((w) => <option key={w.id} value={w.id}>{w.code} — {w.name}</option>)}</select></Field>
          <ArrowRight className="mb-2.5 h-4 w-4 text-sub" />
          <Field label="Destination warehouse"><select className="input" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })}>{whs.map((w) => <option key={w.id} value={w.id}>{w.code} — {w.name}</option>)}</select></Field>
        </div>
        <div className="space-y-2">
          <div className="grid grid-cols-[1fr_7rem_2rem] gap-2 text-xs font-medium text-sub"><span>Item</span><span>Quantity</span><span /></div>
          {ls.map((l, i) => (
            <div key={i} className="grid grid-cols-[1fr_7rem_2rem] gap-2">
              <select required className="input" value={l.product_id} onChange={(e) => setLine(i, "product_id", e.target.value)}><option value="">Select item…</option>{products.map((p) => <option key={p.id} value={p.id}>{p.sku} — {p.name}</option>)}</select>
              <input required className="input" type="number" min="0.001" step="any" value={l.quantity} onChange={(e) => setLine(i, "quantity", e.target.value)} />
              <button type="button" className="rounded p-1.5 hover:bg-muted disabled:opacity-30" disabled={ls.length === 1} onClick={() => setLs(ls.filter((_, j) => j !== i))} aria-label="Remove line"><Trash2 className="h-4 w-4" /></button>
            </div>))}
          <button type="button" className="text-sm text-brand" onClick={() => setLs([...ls, { product_id: "", quantity: "" }])}>+ Add another item</button>
        </div>
        <Field label="Notes"><input className="input" maxLength={300} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
        <p className="text-xs text-sub">Stock leaves the source and arrives at the destination immediately. If any line is short, nothing moves.</p>
        <div className="flex justify-end gap-2"><button type="button" className="btn-ghost" onClick={onClose}>Cancel</button><button className={`btn-primary ${busy ? "btn-loading" : ""}`} disabled={busy}>Transfer stock</button></div>
      </form>
    </Modal>
  );
}

export function TransferTable({ items }: { items: any[] }) {
  return (
    <table className="w-full"><thead className="border-b bg-muted/50"><tr>{["Transfer #", "Date", "From", "To", "Items", "Qty", "Status", "Source"].map((h) => <th key={h} className="th">{h}</th>)}</tr></thead>
      <tbody className="divide-y">{items.map((t) => <tr key={t.id} className="hover:bg-muted/40"><td className="td font-medium">{t.number}{t.notes && <div className="max-w-[14rem] truncate text-xs font-normal text-sub">{t.notes}</div>}</td><td className="td whitespace-nowrap">{dt(t.created_at)}</td>
        <td className="td">{t.from_code}</td><td className="td">{t.to_code}</td>
        <td className="td">{t.lines.map((l: any) => <div key={l.product_id} className="text-xs">{l.sku} <span className="text-sub">× {fmt(l.quantity, 3)}</span></div>)}</td>
        <td className="td">{fmt(t.total_qty, 3)}</td><td className="td"><Badge tone="ok">{t.status}</Badge></td><td className="td"><Badge tone={t.source === "assistant" ? "warn" : "neutral"}>{t.source === "assistant" ? "AI-prepared" : "manual"}</Badge></td></tr>)}</tbody></table>
  );
}

export default function Transfers() {
  const { can } = useMe();
  const [q, setQ] = useState(""); const [wh, setWh] = useState(""); const [page, setPage] = useState(1); const [open, setOpen] = useState(false);
  const whs = useLoad(() => api("/warehouses")); const prods = useLoad(() => api("/products?page_size=200"));
  const { data, loading, reload } = useLoad(() => api(`/transfers?page=${page}&q=${encodeURIComponent(q)}${wh ? `&warehouse_id=${wh}` : ""}`), [page, q, wh]);
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between"><h1 className="text-xl font-semibold">Stock transfers</h1>
        {can("inventory", "w") && <button className="btn-primary" onClick={() => setOpen(true)}><Plus className="h-4 w-4" />New transfer</button>}</div>
      <div className="card flex flex-wrap items-center gap-3 p-3">
        <input className="input max-w-xs" placeholder="Search transfer number…" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} />
        <select className="input w-auto" value={wh} onChange={(e) => { setWh(e.target.value); setPage(1); }}><option value="">All warehouses</option>{(whs.data || []).map((w: any) => <option key={w.id} value={w.id}>{w.code}</option>)}</select>
      </div>
      <div className="card overflow-x-auto">{loading ? <Skeleton /> : !data?.items.length ? <Empty title="No transfers yet" hint="Move stock between warehouses to see history here." /> : <TransferTable items={data.items} />}</div>
      {data && data.total > data.page_size && <div className="flex items-center justify-between text-sm text-sub"><span>{data.total} transfers</span><div className="flex gap-2"><button className="btn-ghost" disabled={page === 1} onClick={() => setPage(page - 1)}>Previous</button><button className="btn-ghost" disabled={page * data.page_size >= data.total} onClick={() => setPage(page + 1)}>Next</button></div></div>}
      {open && <TransferDialog whs={(whs.data || []).filter((w: any) => w.is_active)} products={prods.data?.items || []} onClose={() => setOpen(false)} onDone={reload} />}
    </div>
  );
}
