import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Archive, ArchiveRestore, Download, ImagePlus, Pencil, Plus, Power, SlidersHorizontal, Trash2 } from "lucide-react";
import { api, dt, fetchBlob, fmt, money } from "../api";
import { useMe } from "../App";
import { Num, SuccessCheck, TabBar } from "../fx";
import { AuthImg, useBlobUrl } from "../media";
import { Badge, Confirm, Empty, Field, Modal, Skeleton, StatusDot, useLoad, useToast } from "../ui";
import { ActionDialog } from "./Inventory";
import { Pagination, RowMenu } from "./Warehouses";
import { stockBadge } from "./Products";

/* ---------------------------- form ---------------------------- */
const RULES: Record<string, (v: string, ctx: any) => string> = {
  name: (v) => (!v.trim() ? "Item name is required" : v.trim().length < 2 ? "Use at least 2 characters" : ""),
  sku: (v) => (v && !/^[A-Za-z0-9._\-/]{1,64}$/.test(v.trim()) ? "Letters, numbers and . _ - / only" : ""),
  hsn_code: (v) => (v && !/^\d{4,8}$/.test(v) ? "HSN is 4–8 digits" : ""),
  purchase_price: (v) => (v === "" || +v < 0 || isNaN(+v) ? "Enter a price of 0 or more" : ""),
  selling_price: (v) => (v === "" || +v < 0 || isNaN(+v) ? "Enter a price of 0 or more" : ""),
  reorder_point: (v) => (v === "" || +v < 0 || isNaN(+v) ? "Enter 0 or more" : ""),
  opening_stock: (v, c) => (v === "" || +v < 0 || isNaN(+v) ? "Enter 0 or more" : +v > 0 && !c.edit && !c.opening_warehouse_id ? "Choose a warehouse for the opening stock" : ""),
};
const Row = ({ label, required, children, note, error }: { label: string; required?: boolean; children: React.ReactNode; note?: string; error?: string }) => (
  <div className="grid items-start gap-1 sm:grid-cols-[12rem_1fr] sm:gap-4"><label className="pt-1.5 text-[13px]">{label}{required && <span className="text-red-500"> *</span>}</label>
    <div>{children}<p className={`mt-1 min-h-[1rem] text-xs ${error ? "text-red-600" : "text-sub"}`} role={error ? "alert" : undefined}>{error || note || ""}</p></div></div>);
const Section = ({ title, children }: { title: string; children: React.ReactNode }) => <section className="card max-w-3xl"><h2 className="border-b px-5 py-2.5 text-[13px] font-semibold">{title}</h2><div className="space-y-1 p-5">{children}</div></section>;

export function ItemFormPage() {
  const { id } = useParams(); const go = useNavigate(); const toast = useToast(); const { can } = useMe(); const edit = !!id;
  const existing = useLoad(() => (id ? api(`/products/${id}`) : Promise.resolve(null)), [id]);
  const cats = useLoad(() => api("/categories")); const brands = useLoad(() => api("/brands")); const whs = useLoad(() => api("/warehouses"));
  const vendors = useLoad(() => (can("purchases") ? api("/vendors?page_size=200&status=active") : Promise.resolve({ items: [] })));
  const blank = { name: "", sku: "", barcode: "", description: "", category_id: "", brand: "", preferred_vendor_id: "", status: "active", unit: "pcs", hsn_code: "", purchase_price: "0", selling_price: "0", tax_rate: "18", reorder_point: "0", safety_stock: "0", opening_stock: "0", opening_warehouse_id: "" };
  const [f, setF] = useState<any>(blank); const [errs, setErrs] = useState<Record<string, string>>({}); const [busy, setBusy] = useState(false); const [done, setDone] = useState(false); const [banner, setBanner] = useState(""); const [shake, setShake] = useState(0);
  const [img, setImg] = useState<File | null>(null); const [preview, setPreview] = useState<string | null>(null); const [newCat, setNewCat] = useState(false); const [catName, setCatName] = useState(""); const fileRef = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => { if (existing.data) { const d = existing.data; setF({ ...blank, ...Object.fromEntries(Object.entries(d).map(([k, v]) => [k, v ?? ""])), brand: d.brand || "", category_id: d.category_id ?? "", preferred_vendor_id: d.preferred_vendor_id ?? "", purchase_price: String(d.purchase_price), selling_price: String(d.selling_price), tax_rate: String(d.tax_rate), reorder_point: String(d.reorder_point), safety_stock: String(d.safety_stock) }); } // eslint-disable-next-line
  }, [existing.data]);
  useEffect(() => { if (!img) { setPreview(null); return; } const u = URL.createObjectURL(img); setPreview(u); return () => URL.revokeObjectURL(u); }, [img]);
  useEffect(() => { if (!edit && whs.data?.length && !f.opening_warehouse_id) setF((p: any) => ({ ...p, opening_warehouse_id: String(whs.data.find((w: any) => w.is_active)?.id || "") })); }, [whs.data, edit]); // eslint-disable-line
  const ctx = { edit, opening_warehouse_id: f.opening_warehouse_id };
  const s = (k: string) => (e: any) => { setF({ ...f, [k]: e.target.value }); if (errs[k]) setErrs({ ...errs, [k]: RULES[k]?.(e.target.value, ctx) || "" }); };
  const blur = (k: string) => () => RULES[k] && setErrs((p) => ({ ...p, [k]: RULES[k](f[k] ?? "", ctx) }));
  const cls = (k: string, x = "") => `input ${errs[k] ? "input-error" : ""} ${x}`;
  const pickImage = (file?: File) => { if (!file) return; if (!/^image\/(png|jpe?g|webp)$/.test(file.type)) return toast("Use a PNG, JPEG or WebP image", "err"); if (file.size > 2 * 1024 * 1024) return toast("Image must be 2 MB or smaller", "err"); setImg(file); };
  const addCat = async () => { try { const c = await api("/categories", { body: { name: catName } }); await cats.reload(); setF((p: any) => ({ ...p, category_id: String(c.id) })); setNewCat(false); setCatName(""); toast("Category added"); } catch (e: any) { toast(e.message, "err"); } };
  const save = async (e: React.FormEvent) => {
    e.preventDefault(); setBanner("");
    const ev: Record<string, string> = {}; for (const k of Object.keys(RULES)) { if (edit && k === "opening_stock") continue; const m = RULES[k](f[k] ?? "", ctx); if (m) ev[k] = m; }
    setErrs(ev); if (Object.keys(ev).length) { setShake((n) => n + 1); return; }
    setBusy(true);
    try {
      const body: any = { name: f.name.trim(), barcode: f.barcode || null, description: f.description || null, category_id: f.category_id ? +f.category_id : null, brand: f.brand.trim() || null, preferred_vendor_id: f.preferred_vendor_id ? +f.preferred_vendor_id : null, status: f.status, unit: f.unit || "pcs", hsn_code: f.hsn_code || null, purchase_price: +f.purchase_price, selling_price: +f.selling_price, tax_rate: +f.tax_rate, reorder_point: +f.reorder_point, safety_stock: +f.safety_stock };
      if (edit && !f.brand.trim()) body.brand_id = null;
      const r = edit ? await api(`/products/${id}`, { method: "PATCH", body }) : await api("/products", { body: { ...body, sku: f.sku.trim() || null, opening_stock: +f.opening_stock || 0, opening_warehouse_id: +f.opening_stock > 0 ? +f.opening_warehouse_id : null } });
      if (img) { const fd = new FormData(); fd.append("file", img); try { await api(`/products/${r.id}/image`, { form: fd }); } catch (e: any) { toast(`Item saved, but the image failed: ${e.message}`, "err"); } }
      window.dispatchEvent(new Event("sp-data-changed")); setDone(true);
      setTimeout(() => { toast(edit ? "Item updated" : "Item created"); go(`/products/${r.id}`); }, 900);
    } catch (e: any) { if (/SKU/i.test(e.message)) setErrs((p) => ({ ...p, sku: e.message })); else setBanner(e.message); setShake((n) => n + 1); setBusy(false); }
  };
  if (edit && existing.loading) return <div className="card"><Skeleton rows={8} /></div>;
  return (
    <form onSubmit={save} className="relative space-y-3" noValidate>
      <div className="flex items-center gap-2 text-[13px] text-sub"><Link to="/products" className="hover:text-ink">Items</Link><span>/</span><span className="text-ink">{edit ? "Edit item" : "New item"}</span></div>
      <h1 className="text-lg font-semibold">{edit ? `Edit ${existing.data?.name ?? "item"}` : "New Item"}</h1>
      <div key={shake} className={`space-y-3 ${shake ? "anim-shake" : ""}`}>
        <Section title="Basic information">
          <Row label="Item name" required error={errs.name}><input autoFocus className={cls("name")} maxLength={200} value={f.name} onChange={s("name")} onBlur={blur("name")} /></Row>
          <Row label="SKU" error={errs.sku} note={edit ? "SKU can't be changed after creation." : "Leave blank to generate a unique SKU automatically."}><input disabled={edit} className={cls("sku", "sm:max-w-xs")} maxLength={64} value={f.sku} onChange={s("sku")} onBlur={blur("sku")} /></Row>
          <Row label="Barcode" note="Leave blank to generate an EAN-13 barcode."><input className="input sm:max-w-xs" maxLength={64} value={f.barcode || ""} onChange={s("barcode")} /></Row>
          <Row label="Description"><textarea className="input min-h-[64px]" maxLength={2000} value={f.description || ""} onChange={s("description")} /></Row>
          <Row label="Image" note="PNG, JPEG or WebP, up to 2 MB."><div className="flex items-center gap-3">
            <div onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); e.stopPropagation(); pickImage(e.dataTransfer.files?.[0]); }} className="flex h-20 w-20 cursor-pointer items-center justify-center overflow-hidden rounded-md border border-dashed bg-muted/40 hover:border-brand" onClick={() => fileRef.current?.click()}>
              {preview ? <img src={preview} alt="Preview" className="h-full w-full object-cover" /> : edit && existing.data?.has_image ? <AuthImg path={`/products/${id}/image`} alt="Current" className="h-full w-full" /> : <ImagePlus className="h-6 w-6 text-sub" />}</div>
            <div className="text-[13px]"><button type="button" className="btn-ghost" onClick={() => fileRef.current?.click()}>{preview || existing.data?.has_image ? "Change image" : "Choose image"}</button><p className="mt-1 text-xs text-sub">or drag a file onto the box</p></div>
            <input ref={fileRef} hidden type="file" accept="image/png,image/jpeg,image/webp" onChange={(e) => { pickImage(e.target.files?.[0]); e.target.value = ""; }} /></div></Row>
        </Section>
        <Section title="Classification">
          <Row label="Category"><div className="flex gap-2"><select className="input sm:max-w-xs" value={f.category_id} onChange={s("category_id")}><option value="">—</option>{(cats.data || []).map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}</select><button type="button" className="btn-ghost" onClick={() => setNewCat(true)}><Plus className="h-3.5 w-3.5" />New</button></div></Row>
          <Row label="Brand" note="Pick an existing brand or type a new one."><input list="brand-list" className="input sm:max-w-xs" maxLength={100} value={f.brand} onChange={s("brand")} /><datalist id="brand-list">{(brands.data || []).map((b: any) => <option key={b.id} value={b.name} />)}</datalist></Row>
          {can("purchases") && <Row label="Preferred vendor"><select className="input sm:max-w-sm" value={f.preferred_vendor_id} onChange={s("preferred_vendor_id")}><option value="">—</option>{(vendors.data?.items || []).map((v: any) => <option key={v.id} value={v.id}>{v.code} — {v.name}</option>)}</select></Row>}
          <Row label="Status"><select className="input sm:max-w-[10rem]" value={f.status} onChange={s("status")}><option value="active">Active</option><option value="inactive">Inactive</option></select></Row>
        </Section>
        <Section title="Pricing & tax">
          <Row label="Purchase price (₹)" error={errs.purchase_price}><input type="number" step="0.01" min="0" className={cls("purchase_price", "sm:max-w-[10rem]")} value={f.purchase_price} onChange={s("purchase_price")} onBlur={blur("purchase_price")} /></Row>
          <Row label="Selling price (₹)" error={errs.selling_price}><input type="number" step="0.01" min="0" className={cls("selling_price", "sm:max-w-[10rem]")} value={f.selling_price} onChange={s("selling_price")} onBlur={blur("selling_price")} /></Row>
          <Row label="GST rate"><select className="input sm:max-w-[10rem]" value={f.tax_rate} onChange={s("tax_rate")}>{[0, 3, 5, 12, 18, 28].map((r) => <option key={r} value={r}>{r}%</option>)}</select></Row>
          <Row label="HSN code" error={errs.hsn_code}><input className={cls("hsn_code", "sm:max-w-[10rem]")} maxLength={8} value={f.hsn_code || ""} onChange={s("hsn_code")} onBlur={blur("hsn_code")} /></Row>
          <Row label="Unit of measurement"><select className="input sm:max-w-[10rem]" value={f.unit} onChange={s("unit")}>{["pcs", "box", "kg", "g", "litre", "ml", "metre", "set", "pair", "dozen"].map((u) => <option key={u}>{u}</option>)}</select></Row>
        </Section>
        <Section title="Inventory">
          <Row label="Reorder level" error={errs.reorder_point} note="A low-stock alert is raised when available stock falls to this level."><input type="number" min="0" className={cls("reorder_point", "sm:max-w-[10rem]")} value={f.reorder_point} onChange={s("reorder_point")} onBlur={blur("reorder_point")} /></Row>
          <Row label="Safety stock"><input type="number" min="0" className="input sm:max-w-[10rem]" value={f.safety_stock} onChange={s("safety_stock")} /></Row>
          {!edit ? <>
            <Row label="Opening stock" error={errs.opening_stock} note="Recorded as an auditable opening-balance movement."><input type="number" min="0" step="any" className={cls("opening_stock", "sm:max-w-[10rem]")} value={f.opening_stock} onChange={s("opening_stock")} onBlur={blur("opening_stock")} /></Row>
            {+f.opening_stock > 0 && <Row label="Opening warehouse"><select className="input sm:max-w-xs" value={f.opening_warehouse_id} onChange={s("opening_warehouse_id")}>{(whs.data || []).filter((w: any) => w.is_active).map((w: any) => <option key={w.id} value={w.id}>{w.code} — {w.name}</option>)}</select></Row>}
          </> : <p className="pb-1 text-xs text-sub">Stock quantities change through receipts, adjustments and transfers so the ledger stays accurate.</p>}
        </Section>
      </div>
      <div className="min-h-[2rem] max-w-3xl">{banner && <p className="anim-fade rounded-md bg-red-500/10 px-3 py-2 text-[13px] text-red-600" role="alert">{banner}</p>}</div>
      <div className="flex max-w-3xl gap-2"><button className={`btn-primary ${busy ? "btn-loading" : ""}`} disabled={busy}>Save</button><button type="button" className="btn-ghost" disabled={busy} onClick={() => go(edit ? `/products/${id}` : "/products")}>Cancel</button></div>
      {done && <div className="anim-fade fixed inset-0 z-50 flex flex-col items-center justify-center gap-2 bg-surface/90"><SuccessCheck size={64} /><p className="text-base font-semibold">{edit ? "Item updated" : "Item created"}</p></div>}
      {newCat && <Modal title="New category" onClose={() => setNewCat(false)}><div className="space-y-3"><Field label="Category name"><input autoFocus className="input" value={catName} maxLength={120} onChange={(e) => setCatName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); if (catName.trim()) addCat(); } }} /></Field><div className="flex justify-end gap-2"><button type="button" className="btn-ghost" onClick={() => setNewCat(false)}>Cancel</button><button type="button" className="btn-primary" disabled={!catName.trim()} onClick={addCat}>Add</button></div></div></Modal>}
    </form>
  );
}

/* ---------------------------- detail ---------------------------- */
type Tab = "overview" | "history" | "purchases" | "sales";

function CodeCard({ title, path, filename }: { title: string; path: string; filename: string }) {
  const { url, state } = useBlobUrl(path); const toast = useToast();
  const save = async () => { try { const b = await fetchBlob(path); const a = document.createElement("a"); a.href = URL.createObjectURL(b); a.download = filename; a.click(); URL.revokeObjectURL(a.href); } catch { toast("Could not download", "err"); } };
  return <div className="rounded-md border p-3 text-center"><p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-sub">{title}</p>
    <div className="flex h-24 items-center justify-center rounded bg-white">{state === "loading" ? <div className="skeleton h-16 w-32" /> : url ? <img src={url} alt={title} className="max-h-24" /> : <span className="text-xs text-sub">Unavailable</span>}</div>
    <button className="mt-2 text-xs text-brand hover:underline" onClick={save}>Download SVG</button></div>;
}

function History({ id }: { id: string }) {
  const [type, setType] = useState(""); const [page, setPage] = useState(1);
  const { data, loading } = useLoad(() => api(`/products/${id}/history?page=${page}&page_size=15${type ? `&type=${type}` : ""}`), [id, page, type]);
  return (
    <div className="card">
      <div className="flex items-center gap-2 border-b p-2.5"><select className="input !w-auto" value={type} onChange={(e) => { setType(e.target.value); setPage(1); }} aria-label="Movement type"><option value="">All movement types</option>{["opening", "receipt", "issue", "adjustment", "damage", "transfer_in", "transfer_out", "reserve", "release"].map((t) => <option key={t} value={t}>{t.replace("_", " ")}</option>)}</select></div>
      <div className="overflow-x-auto">{loading && !data ? <Skeleton /> : !data?.items.length ? <Empty title="No stock movements" hint="Receipts, sales, transfers and adjustments for this item are recorded here." /> :
        <table className="w-full min-w-[760px]"><thead className="border-b bg-muted/60"><tr>{["When", "Type", "Warehouse", "Change", "Balance after", "Cost", "Reason / ref", "By"].map((h) => <th key={h} className={`th ${["Change", "Balance after", "Cost"].includes(h) ? "text-right" : ""}`}>{h}</th>)}</tr></thead>
          <tbody className="divide-y">{data.items.map((m: any, i: number) => <tr key={m.id} style={{ ["--i" as any]: i }} className="stagger hover:bg-muted/60"><td className="td whitespace-nowrap">{dt(m.created_at)}</td><td className="td capitalize">{m.type.replace("_", " ")}</td><td className="td">{m.warehouse}</td>
            <td className={`td text-right font-medium tabular-nums ${m.qty_delta > 0 ? "text-emerald-600" : m.qty_delta < 0 ? "text-red-500" : "text-sub"}`}>{m.qty_delta !== 0 ? `${m.qty_delta > 0 ? "+" : ""}${fmt(m.qty_delta, 3)}` : `reserved ${m.reserved_delta > 0 ? "+" : ""}${fmt(m.reserved_delta, 3)}`}</td>
            <td className="td text-right tabular-nums">{fmt(m.on_hand_after, 3)}</td><td className="td text-right tabular-nums">{m.unit_cost != null ? money(m.unit_cost) : "—"}</td><td className="td text-sub">{m.reason || "—"}{m.ref_type && <span className="ml-1 text-xs">({m.ref_type} {m.ref_id})</span>}</td><td className="td">{m.user || "—"}</td></tr>)}</tbody></table>}</div>
      {data && <Pagination total={data.total} page={page} size={data.page_size} setPage={setPage} noun="movements" />}
    </div>
  );
}

function PurchaseTx({ id }: { id: string }) {
  const { data, loading } = useLoad(() => api(`/products/${id}/purchase-transactions`), [id]);
  return <div className="card overflow-x-auto">{loading && !data ? <Skeleton rows={3} /> : !data?.length ? <Empty title="Not on any purchase order yet" hint="Orders that include this item appear here." /> :
    <table className="w-full min-w-[640px]"><thead className="border-b bg-muted/60"><tr>{["Order", "Date", "Vendor", "Status", "Ordered", "Received", "Rate", "Amount"].map((h, i) => <th key={h} className={`th ${i >= 4 ? "text-right" : ""}`}>{h}</th>)}</tr></thead>
      <tbody className="divide-y">{data.map((t: any) => <tr key={`${t.po_id}-${t.rate}-${t.quantity}`} className="hover:bg-muted/60"><td className="td"><Link className="font-medium text-brand hover:underline" to={`/purchase-orders/${t.po_id}`}>{t.number}</Link></td><td className="td text-sub">{new Date(t.date).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}</td><td className="td"><Link className="text-brand hover:underline" to={`/vendors/${t.vendor_id}`}>{t.vendor}</Link></td><td className="td capitalize">{t.status.replace("_", " ")}</td><td className="td text-right tabular-nums">{fmt(t.quantity)}</td><td className="td text-right tabular-nums">{fmt(t.received)}</td><td className="td text-right tabular-nums">{money(t.rate)}</td><td className="td text-right tabular-nums">{money(t.amount)}</td></tr>)}</tbody></table>}</div>;
}

function SalesTx({ id }: { id: string }) {
  const { data, loading } = useLoad(() => api(`/products/${id}/sales-transactions`), [id]);
  return <div className="card overflow-x-auto">{loading && !data ? <Skeleton rows={3} /> : !data?.length ? <Empty title="Not on any sales order yet" hint="Orders that include this item appear here." /> :
    <table className="w-full min-w-[640px]"><thead className="border-b bg-muted/60"><tr>{["Order", "Date", "Customer", "Status", "Ordered", "Shipped", "Rate", "Amount"].map((h, i) => <th key={h} className={`th ${i >= 4 ? "text-right" : ""}`}>{h}</th>)}</tr></thead>
      <tbody className="divide-y">{data.map((t: any) => <tr key={`${t.so_id}-${t.rate}-${t.quantity}`} className="hover:bg-muted/60"><td className="td"><Link className="font-medium text-brand hover:underline" to={`/sales-orders/${t.so_id}`}>{t.number}</Link></td><td className="td text-sub">{new Date(t.date).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}</td><td className="td"><Link className="text-brand hover:underline" to={`/customers/${t.customer_id}`}>{t.customer}</Link></td><td className="td capitalize">{t.status}</td><td className="td text-right tabular-nums">{fmt(t.quantity)}</td><td className="td text-right tabular-nums">{fmt(t.shipped)}</td><td className="td text-right tabular-nums">{money(t.rate)}</td><td className="td text-right tabular-nums">{money(t.amount)}</td></tr>)}</tbody></table>}</div>;
}

export function ItemDetail() {
  const { id = "" } = useParams(); const { can } = useMe(); const toast = useToast(); const go = useNavigate();
  const [sp, setSp] = useSearchParams(); const tab = ((sp.get("tab") as Tab) || "overview");
  const { data: d, loading, error, reload } = useLoad(() => api(`/products/${id}`), [id]);
  const whs = useLoad(() => api("/warehouses").catch(() => []));
  const [del, setDel] = useState(false); const [adj, setAdj] = useState(false); const fileRef = useRef<HTMLInputElement>(null); const [imgVer, setImgVer] = useState(0);
  if (loading && !d) return <div className="card"><Skeleton rows={6} /></div>;
  if (error || !d) return <div className="card"><Empty title="Item not found" hint={error} /></div>;
  const w = can("products", "w"), iw = can("inventory", "w");
  const patch = async (b: any, m: string) => { try { await api(`/products/${id}`, { method: "PATCH", body: b }); toast(m); reload(); } catch (e: any) { toast(e.message, "err"); } };
  const remove = async () => { try { await api(`/products/${id}`, { method: "DELETE" }); toast("Item deleted"); go("/products"); } catch (e: any) { toast(e.message, "err"); } };
  const uploadImg = async (file?: File) => { if (!file) return; const fd = new FormData(); fd.append("file", file); try { await api(`/products/${id}/image`, { form: fd }); setImgVer((v) => v + 1); reload(); toast("Image updated"); } catch (e: any) { toast(e.message, "err"); } };
  const KV = ({ k, v }: { k: string; v: React.ReactNode }) => <div className="flex justify-between gap-3 py-1.5 text-[13px]"><dt className="text-sub">{k}</dt><dd className="text-right font-medium">{v}</dd></div>;
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-[13px] text-sub"><Link to="/products" className="hover:text-ink">Items</Link><span>/</span><span className="text-ink">{d.name}</span></div>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="group relative"><AuthImg path={d.has_image ? `/products/${id}/image` : null} alt={d.name} className="h-16 w-16 rounded-md border" version={imgVer} />{w && <><button className="absolute inset-0 flex items-center justify-center rounded-md bg-black/50 text-white opacity-0 transition-opacity group-hover:opacity-100" onClick={() => fileRef.current?.click()} aria-label="Change image"><ImagePlus className="h-5 w-5" /></button><input ref={fileRef} hidden type="file" accept="image/png,image/jpeg,image/webp" onChange={(e) => { uploadImg(e.target.files?.[0]); e.target.value = ""; }} /></>}</div>
          <div><div className="flex flex-wrap items-center gap-2"><h1 className="text-lg font-semibold">{d.name}</h1>{d.is_archived ? <Badge tone="neutral">Archived</Badge> : <StatusDot active={d.status === "active"} />}</div><p className="text-[13px] text-sub">{d.sku}{d.category && ` · ${d.category}`}{d.brand && ` · ${d.brand}`}</p></div></div>
        <div className="flex flex-wrap items-center gap-2">
          {w && <button className="btn-ghost" onClick={() => go(`/products/${id}/edit`)}><Pencil className="h-3.5 w-3.5" />Edit</button>}
          {iw && !d.is_archived && <button className="btn-primary" onClick={() => setAdj(true)}><SlidersHorizontal className="h-3.5 w-3.5" />Adjust Stock</button>}
          {w && <div className="rounded-md border bg-surface"><RowMenu items={[{ label: d.status === "active" ? "Mark inactive" : "Mark active", icon: Power, onClick: () => patch({ status: d.status === "active" ? "inactive" : "active" }, "Status updated"), hidden: d.is_archived },
            { label: "Archive", icon: Archive, onClick: () => patch({ is_archived: true }, "Item archived"), hidden: d.is_archived }, { label: "Restore", icon: ArchiveRestore, onClick: () => patch({ is_archived: false }, "Item restored"), hidden: !d.is_archived },
            { label: "Delete", icon: Trash2, onClick: () => setDel(true), danger: true }]} /></div>}</div>
      </div>
      <TabBar tabs={[["overview", "Overview"], ["history", "Stock history"], ...(can("purchases") ? [["purchases", "Purchases"]] : []), ...(can("sales") ? [["sales", "Sales"]] : [])] as unknown as readonly (readonly [Tab, string])[]} active={tab} onChange={(k) => setSp(k === "overview" ? {} : { tab: k })} />
      <div key={tab} className="anim-up">
        {tab === "overview" ? (
          <div className="grid gap-3 lg:grid-cols-3">
            <div className="space-y-3 lg:col-span-2">
              <section className="card"><h3 className="border-b px-3 py-2 text-[13px] font-semibold">Stock summary</h3><dl className="grid gap-x-8 p-3 sm:grid-cols-2"><div className="divide-y"><KV k="On hand" v={<Num value={d.on_hand} />} /><KV k="Reserved" v={<Num value={d.reserved} />} /><KV k="Available" v={<span className="inline-flex items-center gap-2">{stockBadge(d)}</span>} /><KV k="Damaged" v={<Num value={d.damaged} />} /></div><div className="divide-y"><KV k="Reorder level" v={`${fmt(d.reorder_point)} ${d.unit}`} /><KV k="Safety stock" v={`${fmt(d.safety_stock)} ${d.unit}`} /><KV k="Average cost" v={money(d.avg_cost)} /><KV k="Inventory value" v={<Num value={d.inventory_value} prefix="₹" decimals={2} />} /></div></dl></section>
              <section className="card"><h3 className="border-b px-3 py-2 text-[13px] font-semibold">Stock by warehouse</h3>
                {!d.balances.length ? <Empty title="No stock recorded" hint="Receive goods or add opening stock to see it here." /> : <div className="overflow-x-auto"><table className="w-full min-w-[520px]"><thead className="border-b bg-muted/60"><tr>{["Warehouse", "On hand", "Reserved", "Available", "Value"].map((h, i) => <th key={h} className={`th ${i ? "text-right" : ""}`}>{h}</th>)}</tr></thead>
                  <tbody className="divide-y">{d.balances.map((b: any) => <tr key={b.warehouse_id} className="hover:bg-muted/60"><td className="td"><Link className="font-medium text-brand hover:underline" to={`/warehouses/${b.warehouse_id}`}>{b.warehouse}</Link><span className="ml-2 text-xs text-sub">{b.warehouse_name}</span></td><td className="td text-right tabular-nums">{fmt(b.on_hand, 3)}</td><td className="td text-right tabular-nums">{fmt(b.reserved, 3)}</td><td className="td text-right tabular-nums">{fmt(b.available, 3)}</td><td className="td text-right tabular-nums">{money(b.value)}</td></tr>)}</tbody></table></div>}</section>
              {d.variants.length > 0 && <section className="card"><h3 className="border-b px-3 py-2 text-[13px] font-semibold">Variants</h3><ul className="divide-y">{d.variants.map((v: any) => <li key={v.id} className="flex items-center justify-between px-3 py-2 text-[13px]"><Link className="text-brand hover:underline" to={`/products/${v.id}`}>{v.name}</Link><span className="text-sub">{v.sku} · {fmt(v.available)} available</span></li>)}</ul></section>}
            </div>
            <div className="space-y-3">
              <section className="card"><h3 className="border-b px-3 py-2 text-[13px] font-semibold">Details</h3><dl className="divide-y p-3"><KV k="Selling price" v={money(d.selling_price)} /><KV k="Purchase price" v={money(d.purchase_price)} /><KV k="GST" v={`${d.tax_rate}%`} /><KV k="HSN code" v={d.hsn_code || "—"} /><KV k="Unit" v={d.unit} /><KV k="Preferred vendor" v={d.preferred_vendor ? (can("purchases") ? <Link className="text-brand hover:underline" to={`/vendors/${d.preferred_vendor_id}`}>{d.preferred_vendor}</Link> : d.preferred_vendor) : "—"} /></dl>{d.description && <p className="border-t p-3 text-[13px] text-sub">{d.description}</p>}</section>
              <div className="grid grid-cols-2 gap-3"><CodeCard title={`Barcode ${d.barcode || ""}`} path={`/products/${id}/barcode.svg`} filename={`${d.sku}-barcode.svg`} /><CodeCard title="QR code (SKU)" path={`/products/${id}/qr.svg`} filename={`${d.sku}-qr.svg`} /></div>
            </div>
          </div>) : tab === "purchases" ? <PurchaseTx id={id} /> : tab === "sales" ? <SalesTx id={id} /> : <History id={id} />}
      </div>
      {del && <Confirm title="Delete item" text={`Delete ${d.name}? Items with stock history can't be deleted — archive them instead.`} action="Delete" onConfirm={remove} onClose={() => setDel(false)} />}
      {adj && <ActionDialog kind="adjust" product={d.id} products={[d]} whs={(whs.data || []).filter((x: any) => x.is_active)} onClose={() => setAdj(false)} onDone={() => { reload(); window.dispatchEvent(new Event("sp-data-changed")); }} />}
    </div>
  );
}
