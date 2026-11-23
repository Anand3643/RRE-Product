import { useMemo, useState } from "react";
import { ArrowLeftRight, PackagePlus, ScanLine, SlidersHorizontal } from "lucide-react";
import { api, dt, fmt } from "../api";
import { useMe } from "../App";
import { Badge, Empty, Field, Modal, Skeleton, useLoad, useToast } from "../ui";

type Kind = "receive" | "adjust" | "transfer";

export function ActionDialog({ kind, product, warehouse, products, whs, onClose, onDone }: { kind: Kind; product?: number; warehouse?: number; products: any[]; whs: any[]; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const key = useMemo(() => crypto.randomUUID(), []); // one key per dialog => double-click safe
  const [f, setF] = useState<any>({ product_id: product || "", warehouse_id: warehouse || whs[0]?.id || "", to_warehouse_id: whs[1]?.id || "", mode: "decrease", quantity: "", unit_cost: "", reason: "" });
  const [code, setCode] = useState(""); const [busy, setBusy] = useState(false);
  const s = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value });
  const scan = async () => { try { const p = await api(`/products/lookup/${encodeURIComponent(code.trim())}`); setF({ ...f, product_id: p.id }); toast(`Selected ${p.name}`); setCode(""); } catch (e: any) { toast(e.message, "err"); } };
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true);
    try {
      const base = { product_id: +f.product_id, quantity: +f.quantity, idempotency_key: key };
      if (kind === "transfer") await api("/inventory/transfer", { body: { ...base, from_warehouse_id: +f.warehouse_id, to_warehouse_id: +f.to_warehouse_id, reason: f.reason || null } });
      else if (kind === "receive") await api("/inventory/receive", { body: { ...base, warehouse_id: +f.warehouse_id, mode: "increase", unit_cost: f.unit_cost === "" ? null : +f.unit_cost, reason: f.reason || "Goods received" } });
      else await api("/inventory/adjust", { body: { ...base, warehouse_id: +f.warehouse_id, mode: f.mode, unit_cost: f.unit_cost === "" ? null : +f.unit_cost, reason: f.reason } });
      toast("Stock updated"); onDone(); onClose();
    } catch (e: any) { toast(e.message, "err"); } finally { setBusy(false); }
  };
  const title = { receive: "Receive goods", adjust: "Adjust stock", transfer: "Transfer stock" }[kind];
  return (
    <Modal title={title} onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <div className="flex gap-2"><input className="input" placeholder="Scan or type barcode / SKU, press Enter" value={code} onChange={(e) => setCode(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); scan(); } }} />
          <button type="button" className="btn-ghost" onClick={scan}><ScanLine className="h-4 w-4" /></button></div>
        <Field label="Product"><select required className="input" value={f.product_id} onChange={s("product_id")}><option value="">Select…</option>{products.map((p) => <option key={p.id} value={p.id}>{p.sku} — {p.name}</option>)}</select></Field>
        <div className={kind === "transfer" ? "grid grid-cols-2 gap-3" : ""}>
          <Field label={kind === "transfer" ? "From warehouse" : "Warehouse"}><select className="input" value={f.warehouse_id} onChange={s("warehouse_id")}>{whs.map((w) => <option key={w.id} value={w.id}>{w.code} — {w.name}</option>)}</select></Field>
          {kind === "transfer" && <Field label="To warehouse"><select className="input" value={f.to_warehouse_id} onChange={s("to_warehouse_id")}>{whs.map((w) => <option key={w.id} value={w.id}>{w.code} — {w.name}</option>)}</select></Field>}
        </div>
        {kind === "adjust" && <Field label="Adjustment type"><select className="input" value={f.mode} onChange={s("mode")}>
          <option value="decrease">Decrease (loss, correction)</option><option value="increase">Increase (found stock)</option><option value="set">Set counted quantity (cycle count)</option><option value="damage">Mark as damaged</option></select></Field>}
        <div className="grid grid-cols-2 gap-3">
          <Field label={kind === "adjust" && f.mode === "set" ? "Counted quantity" : "Quantity"}><input required className="input" type="number" min={kind === "adjust" && f.mode === "set" ? 0 : 0.001} step="any" value={f.quantity} onChange={s("quantity")} /></Field>
          {(kind === "receive" || (kind === "adjust" && f.mode === "increase")) && <Field label="Unit cost (optional)"><input className="input" type="number" min="0" step="0.01" value={f.unit_cost} onChange={s("unit_cost")} /></Field>}
        </div>
        <Field label={kind === "adjust" ? "Reason *" : "Reference / note"}><input className="input" required={kind === "adjust"} minLength={kind === "adjust" ? 3 : 0} value={f.reason} onChange={s("reason")} /></Field>
        <div className="flex justify-end gap-2 pt-1"><button type="button" className="btn-ghost" onClick={onClose}>Cancel</button><button className={`btn-primary ${busy ? "btn-loading" : ""}`} disabled={busy}>Confirm</button></div>
      </form>
    </Modal>
  );
}

const typeTone: Record<string, "ok" | "bad" | "warn" | "neutral"> = { receipt: "ok", opening: "ok", transfer_in: "ok", issue: "bad", damage: "bad", transfer_out: "warn", adjustment: "neutral", reserve: "neutral", release: "neutral" };

export default function Inventory() {
  const { can } = useMe();
  const [tab, setTab] = useState<"stock" | "ledger">("stock");
  const [wh, setWh] = useState(""); const [q, setQ] = useState(""); const [type, setType] = useState(""); const [page, setPage] = useState(1);
  const [dlg, setDlg] = useState<Kind | null>(null); const [pre, setPre] = useState<number | undefined>();
  const whs = useLoad(() => api("/warehouses")); const prods = useLoad(() => api("/products?page_size=200"));
  const stock = useLoad(() => api(`/inventory/stock?q=${encodeURIComponent(q)}${wh ? `&warehouse_id=${wh}` : ""}`), [q, wh]);
  const ledger = useLoad(() => api(`/inventory/movements?page=${page}&page_size=25${wh ? `&warehouse_id=${wh}` : ""}${type ? `&type=${type}` : ""}`), [page, wh, type]);
  const w = can("inventory", "w");
  const refresh = () => { stock.reload(); ledger.reload(); prods.reload(); };
  const activeWh = (whs.data || []).filter((x: any) => x.is_active);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2"><h1 className="text-xl font-semibold">Inventory</h1>
        {w && <div className="flex flex-wrap gap-2"><button className="btn-primary" onClick={() => { setPre(undefined); setDlg("receive"); }}><PackagePlus className="h-4 w-4" />Receive</button>
          <button className="btn-ghost" onClick={() => { setPre(undefined); setDlg("adjust"); }}><SlidersHorizontal className="h-4 w-4" />Adjust</button>
          <button className="btn-ghost" onClick={() => { setPre(undefined); setDlg("transfer"); }}><ArrowLeftRight className="h-4 w-4" />Transfer</button></div>}</div>
      <div className="card flex flex-wrap items-center gap-3 p-3">
        <div className="flex rounded-lg border p-0.5 text-sm">{(["stock", "ledger"] as const).map((t) => <button key={t} onClick={() => setTab(t)} className={`rounded-md px-3 py-1 ${tab === t ? "bg-brand/10 font-medium text-brand" : "text-sub"}`}>{t === "stock" ? "Stock levels" : "Movement ledger"}</button>)}</div>
        <select className="input w-auto" value={wh} onChange={(e) => { setWh(e.target.value); setPage(1); }}><option value="">All warehouses</option>{(whs.data || []).map((x: any) => <option key={x.id} value={x.id}>{x.code}</option>)}</select>
        {tab === "stock" ? <input className="input max-w-xs" placeholder="Filter product or SKU" value={q} onChange={(e) => setQ(e.target.value)} />
          : <select className="input w-auto" value={type} onChange={(e) => { setType(e.target.value); setPage(1); }}><option value="">All types</option>{Object.keys(typeTone).map((t) => <option key={t} value={t}>{t.replace("_", " ")}</option>)}</select>}
      </div>
      <div className="card overflow-x-auto">
        {tab === "stock" ? (stock.loading ? <Skeleton /> : !stock.data?.length ? <Empty title="No stock recorded" hint="Receive goods to start tracking inventory." /> :
          <table className="w-full"><thead className="border-b bg-muted/50"><tr>{["Product", "Warehouse", "On hand", "Reserved", "Available", "Damaged", "Value", ""].map((h) => <th key={h} className="th">{h}</th>)}</tr></thead>
            <tbody className="divide-y">{stock.data.map((r: any) => <tr key={`${r.product_id}-${r.warehouse_id}`} className="hover:bg-muted/40"><td className="td font-medium">{r.name}<div className="text-xs font-normal text-sub">{r.sku}</div></td><td className="td">{r.warehouse}</td>
              <td className="td">{fmt(r.on_hand, 3)}</td><td className="td">{fmt(r.reserved, 3)}</td><td className="td">{r.available <= 0 ? <Badge tone="bad">{fmt(r.available, 3)}</Badge> : fmt(r.available, 3)}</td><td className="td">{fmt(r.damaged, 3)}</td><td className="td">₹{fmt(r.value, 2)}</td>
              <td className="td text-right">{w && <button className="text-xs text-brand" onClick={() => { setPre(r.product_id); setDlg("adjust"); }}>Adjust</button>}</td></tr>)}</tbody></table>)
          : (ledger.loading ? <Skeleton /> : !ledger.data?.items.length ? <Empty title="No movements" /> :
            <table className="w-full"><thead className="border-b bg-muted/50"><tr>{["#", "When", "Product", "Warehouse", "Type", "Change", "Balance after", "Reason"].map((h) => <th key={h} className="th">{h}</th>)}</tr></thead>
              <tbody className="divide-y">{ledger.data.items.map((m: any) => <tr key={m.id}><td className="td text-sub">{m.id}</td><td className="td whitespace-nowrap">{dt(m.created_at)}</td><td className="td">{m.product}<div className="text-xs text-sub">{m.sku}</div></td><td className="td">{m.warehouse}</td>
                <td className="td"><Badge tone={typeTone[m.type] || "neutral"}>{m.type.replace("_", " ")}</Badge></td>
                <td className="td font-medium">{m.qty_delta !== 0 ? <span className={m.qty_delta > 0 ? "text-emerald-600" : "text-red-500"}>{m.qty_delta > 0 ? "+" : ""}{fmt(m.qty_delta, 3)}</span> : <span className="text-sub">reserved {m.reserved_delta > 0 ? "+" : ""}{fmt(m.reserved_delta, 3)}</span>}</td>
                <td className="td">{fmt(m.on_hand_after, 3)}</td><td className="td text-sub">{m.reason || "—"}</td></tr>)}</tbody></table>)}
      </div>
      {tab === "ledger" && ledger.data && ledger.data.total > 25 && <div className="flex items-center justify-between text-sm text-sub"><span>{ledger.data.total} movements</span>
        <div className="flex gap-2"><button className="btn-ghost" disabled={page === 1} onClick={() => setPage(page - 1)}>Previous</button><button className="btn-ghost" disabled={page * 25 >= ledger.data.total} onClick={() => setPage(page + 1)}>Next</button></div></div>}
      {dlg && <ActionDialog kind={dlg} product={pre} products={prods.data?.items || []} whs={activeWh} onClose={() => setDlg(null)} onDone={refresh} />}
    </div>
  );
}
