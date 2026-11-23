import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Archive, ArchiveRestore, Download, Eye, FileSpreadsheet, Pencil, Plus, Power, Search, Trash2, Upload, X } from "lucide-react";
import { api, download, fmt, money } from "../api";
import { useMe } from "../App";
import { Col, DataTable } from "../DataTable";
import { Drawer, Num, Portal, SuccessCheck, useHotkeys } from "../fx";
import { AuthImg, useBlobUrl } from "../media";
import { Badge, Confirm, Empty, Modal, StatusDot, useLoad, useToast } from "../ui";
import { Pagination, RowMenu } from "./Warehouses";

export const stockBadge = (p: any) => p.available <= 0 ? <Badge tone="bad">Out of stock</Badge> : p.reorder_point && p.available <= p.reorder_point ? <Badge tone="warn">{fmt(p.available)} · low</Badge> : <Badge tone="ok">{fmt(p.available)}</Badge>;

function QuickView({ row, canEdit, onClose }: { row: any; canEdit: boolean; onClose: () => void }) {
  const go = useNavigate();
  const { data: d } = useLoad(() => api(`/products/${row.id}`), [row.id]);
  const bc = useBlobUrl(`/products/${row.id}/barcode.svg`);
  const p = d || row;
  return (
    <Drawer title={row.name} subtitle={<span className="flex items-center gap-2">{row.sku} · <StatusDot active={row.status === "active"} />{row.is_archived && <Badge tone="neutral">archived</Badge>}</span>} onClose={onClose}
      footer={<><button className="btn-primary flex-1" onClick={() => go(`/products/${row.id}`)}><Eye className="h-3.5 w-3.5" />Open item</button>{canEdit && <button className="btn-ghost" onClick={() => go(`/products/${row.id}/edit`)}><Pencil className="h-3.5 w-3.5" />Edit</button>}</>}>
      <div className="space-y-4 text-[13px]">
        <div className="flex gap-3"><AuthImg path={row.has_image ? `/products/${row.id}/image` : null} alt={row.name} className="h-20 w-20 shrink-0 rounded-md border" />
          <div className="min-w-0"><p className="text-xs text-sub">{[p.category, p.brand].filter(Boolean).join(" · ") || "Uncategorised"}</p><p className="mt-1 text-lg font-semibold">{money(p.selling_price)}</p><p className="text-xs text-sub">cost {money(p.purchase_price)} · GST {p.tax_rate}%</p></div></div>
        <div className="grid grid-cols-3 gap-2">{[["On hand", p.on_hand], ["Reserved", p.reserved], ["Available", p.available]].map(([l, v], i) => <div key={l as string} style={{ ["--i" as any]: i }} className="stagger rounded-md border bg-muted/40 p-2.5"><p className="text-[11px] text-sub">{l}</p><p className="text-base font-semibold"><Num value={v as number} /></p></div>)}</div>
        <div><p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-sub">Stock by warehouse</p>
          {!d ? <div className="skeleton h-16" /> : !d.balances.length ? <p className="text-sub">No stock recorded.</p> : <ul className="divide-y rounded-md border">{d.balances.map((b: any) => <li key={b.warehouse_id} className="flex items-center justify-between px-2.5 py-1.5"><span>{b.warehouse}<span className="ml-2 text-xs text-sub">{b.warehouse_name}</span></span><span className="tabular-nums">{fmt(b.available)} <span className="text-xs text-sub">/ {fmt(b.on_hand)}</span></span></li>)}</ul>}</div>
        <dl className="space-y-1.5"><div><dt className="text-[11px] text-sub">Preferred vendor</dt><dd>{p.preferred_vendor || "—"}</dd></div><div><dt className="text-[11px] text-sub">Reorder level</dt><dd>{fmt(p.reorder_point)} {p.unit}</dd></div></dl>
        {bc.url && <div className="rounded-md border bg-white p-2 text-center"><img src={bc.url} alt="Barcode" className="mx-auto h-16" /></div>}
      </div>
    </Drawer>
  );
}

export default function Products() {
  const { can } = useMe(); const toast = useToast(); const go = useNavigate();
  const [sp, setSp] = useSearchParams();
  const [q, setQ] = useState(sp.get("q") || ""); const [status, setStatus] = useState("active"); const [stock, setStock] = useState("all");
  const [cat, setCat] = useState(""); const [brand, setBrand] = useState(""); const [vendor, setVendor] = useState("");
  const [sort, setSort] = useState("name"); const [desc, setDesc] = useState(false); const [page, setPage] = useState(1); const [size, setSize] = useState(25);
  const [sel, setSel] = useState<Map<string | number, any>>(new Map()); const [quick, setQuick] = useState<any>(null); const [del, setDel] = useState<any>(null); const [bulkDel, setBulkDel] = useState(false);
  const [bulk, setBulk] = useState<{ label: string; done: number; total: number } | null>(null);
  const [dropping, setDropping] = useState(false); const [importRes, setImportRes] = useState<any>(null); const [importing, setImporting] = useState(false);
  const search = useRef<HTMLInputElement>(null); const file = useRef<HTMLInputElement>(null);
  const w = can("products", "w");
  const cats = useLoad(() => api("/categories")); const brands = useLoad(() => api("/brands"));
  const vendors = useLoad(() => (can("purchases") ? api("/vendors?page_size=200&status=all") : Promise.resolve({ items: [] })));
  const qs = `q=${encodeURIComponent(q)}&status=${status}&stock=${stock}&sort=${sort}&desc=${desc}&page=${page}&page_size=${size}${cat ? `&category_id=${cat}` : ""}${brand ? `&brand_id=${brand}` : ""}${vendor ? `&vendor_id=${vendor}` : ""}`;
  const { data, loading, error, reload } = useLoad(() => api(`/products?${qs}`), [qs]);
  const rows: any[] = data?.items || [];
  useHotkeys({ n: () => w && go("/products/new"), "/": () => search.current?.focus() }, [w]);
  useEffect(() => { setSel(new Map()); }, [q, status, stock, cat, brand, vendor]);

  const upload = async (f: File) => {
    if (!w) return toast("You don't have permission to import items", "err");
    if (!/\.csv$/i.test(f.name)) return toast("Please drop a .csv file", "err");
    setImporting(true);
    try { const fd = new FormData(); fd.append("file", f); const r = await api("/products-import", { form: fd }); setImportRes(r); toast(`Imported ${r.created} item${r.created !== 1 ? "s" : ""}${r.errors.length ? `, ${r.errors.length} skipped` : ""}`, r.errors.length && !r.created ? "err" : "ok"); reload(); cats.reload(); brands.reload(); }
    catch (e: any) { toast(e.message, "err"); } finally { setImporting(false); }
  };
  useEffect(() => {
    let depth = 0; const has = (e: DragEvent) => Array.from(e.dataTransfer?.types || []).includes("Files");
    const enter = (e: DragEvent) => { if (has(e)) { depth++; setDropping(true); } }; const leave = (e: DragEvent) => { if (has(e) && --depth <= 0) { depth = 0; setDropping(false); } };
    const over = (e: DragEvent) => { if (has(e)) e.preventDefault(); }; const drop = (e: DragEvent) => { if (!has(e)) return; e.preventDefault(); depth = 0; setDropping(false); const f = e.dataTransfer?.files?.[0]; if (f) upload(f); };
    window.addEventListener("dragenter", enter); window.addEventListener("dragleave", leave); window.addEventListener("dragover", over); window.addEventListener("drop", drop);
    return () => { window.removeEventListener("dragenter", enter); window.removeEventListener("dragleave", leave); window.removeEventListener("dragover", over); window.removeEventListener("drop", drop); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [w]);

  const patch = async (p: any, body: any, msg: string) => { try { await api(`/products/${p.id}`, { method: "PATCH", body }); toast(msg); reload(); } catch (e: any) { toast(e.message, "err"); } };
  const remove = async (p: any) => { try { await api(`/products/${p.id}`, { method: "DELETE" }); toast("Item deleted"); reload(); } catch (e: any) { toast(e.message, "err"); } };
  const runBulk = async (label: string, fn: (r: any) => Promise<any>) => {
    const list = Array.from(sel.values()); const fails: string[] = []; setBulk({ label, done: 0, total: list.length });
    for (let i = 0; i < list.length; i++) { try { await fn(list[i]); } catch (e: any) { fails.push(`${list[i].sku}: ${e.message}`); } setBulk({ label, done: i + 1, total: list.length }); }
    setBulk(null); setSel(new Map()); reload();
    if (fails.length) toast(`${list.length - fails.length} done, ${fails.length} failed — ${fails[0]}`, "err"); else toast(`${label} complete for ${list.length} item${list.length !== 1 ? "s" : ""}`);
  };
  const exportSelected = () => {
    const cols = ["sku", "name", "category", "brand", "status", "unit", "purchase_price", "selling_price", "tax_rate", "on_hand", "reserved", "available", "reorder_point"];
    const esc = (v: any) => { const s = String(v ?? ""); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([[cols.join(","), ...Array.from(sel.values()).map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n")], { type: "text/csv" })); a.download = "selected-items.csv"; a.click(); URL.revokeObjectURL(a.href);
  };
  const selArr = Array.from(sel.values());
  const toggle = (r: any) => setSel((m) => { const n = new Map(m); n.has(r.id) ? n.delete(r.id) : n.set(r.id, r); return n; });
  const sortBy = (k: string) => { if (sort === k) setDesc(!desc); else { setSort(k); setDesc(false); } setPage(1); };

  const columns: Col<any>[] = [
    { id: "item", label: "Item", sort: "name", w: 26, cell: (p) => <td className="td"><div className="flex items-center gap-2.5"><AuthImg path={p.has_image ? `/products/${p.id}/image` : null} alt="" className="h-9 w-9 shrink-0 rounded border" /><div className="min-w-0"><Link className="block truncate font-medium text-brand hover:underline" to={`/products/${p.id}`} onClick={(e) => e.stopPropagation()}>{p.name}</Link><span className="text-xs text-sub">{p.sku}{p.parent_id ? " · variant" : ""}</span></div></div></td> },
    { id: "category", label: "Category", sort: "category", w: 12, cell: (p) => <td className="td truncate text-sub">{p.category || "—"}</td> },
    { id: "brand", label: "Brand", sort: "brand", w: 10, cell: (p) => <td className="td truncate text-sub">{p.brand || "—"}</td> },
    { id: "price", label: "Selling Price", sort: "selling_price", right: true, w: 11, cell: (p) => <td className="td text-right tabular-nums">{money(p.selling_price)}<div className="text-xs text-sub">cost {money(p.purchase_price)}</div></td> },
    { id: "stock", label: "Available", sort: "available", right: true, w: 11, cell: (p) => <td className="td text-right">{stockBadge(p)}<div className="mt-0.5 text-xs text-sub">{fmt(p.on_hand)} on hand</div></td> },
    { id: "gst", label: "GST", w: 6, right: true, cell: (p) => <td className="td text-right tabular-nums">{p.tax_rate}%</td> },
    { id: "vendor", label: "Preferred Vendor", w: 13, cell: (p) => <td className="td truncate text-sub">{p.preferred_vendor || "—"}</td> },
    { id: "status", label: "Status", w: 9, cell: (p) => <td className="td">{p.is_archived ? <Badge tone="neutral">Archived</Badge> : <StatusDot active={p.status === "active"} />}</td> },
  ];
  const tpl = () => { const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob(["name,sku,category,brand,preferred_vendor,status,unit,hsn_code,purchase_price,selling_price,tax_rate,reorder_point,opening_stock,warehouse\nHex Bolt M10,,Fasteners,Generic,VEN-00001,active,pcs,73181500,3,6,18,100,500,MAIN\n"], { type: "text/csv" })); a.download = "items-import-template.csv"; a.click(); URL.revokeObjectURL(a.href); };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-lg font-semibold">Items</h1>
        <div className="flex flex-wrap gap-2">
          {w && <button className="btn-primary" onClick={() => go("/products/new")} data-tip="New item (N)"><Plus className="h-4 w-4" />New Item</button>}
          {w && <><input ref={file} type="file" accept=".csv,text/csv" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); e.target.value = ""; }} />
            <button className={`btn-ghost ${importing ? "btn-loading" : ""}`} onClick={() => file.current?.click()} data-tip="Or drop a CSV anywhere on this page"><Upload className="h-3.5 w-3.5" />Import</button></>}
          <button className="btn-ghost" onClick={() => download("/products-export.csv", "items.csv").catch((e) => toast(e.message, "err"))}><Download className="h-3.5 w-3.5" />Export</button>
        </div>
      </div>
      <div className="card overflow-hidden">
        {selArr.length > 0 ? (
          <div className="anim-fade flex flex-wrap items-center gap-2 border-b bg-brand/5 p-2.5" role="toolbar" aria-label="Bulk actions">
            <span className="text-[13px] font-medium tabular-nums">{selArr.length} selected</span><span className="mx-1 h-4 w-px bg-line" />
            {w && <button className="btn-ghost !py-1" disabled={!!bulk} onClick={() => runBulk("Mark active", (r) => api(`/products/${r.id}`, { method: "PATCH", body: { status: "active", is_archived: false } }))}><Power className="h-3.5 w-3.5" />Mark active</button>}
            {w && <button className="btn-ghost !py-1" disabled={!!bulk} onClick={() => runBulk("Mark inactive", (r) => api(`/products/${r.id}`, { method: "PATCH", body: { status: "inactive" } }))}>Mark inactive</button>}
            {w && selArr.some((r) => !r.is_archived) && <button className="btn-ghost !py-1" disabled={!!bulk} onClick={() => runBulk("Archive", (r) => api(`/products/${r.id}`, { method: "PATCH", body: { is_archived: true } }))}><Archive className="h-3.5 w-3.5" />Archive</button>}
            {w && selArr.some((r) => r.is_archived) && <button className="btn-ghost !py-1" disabled={!!bulk} onClick={() => runBulk("Restore", (r) => api(`/products/${r.id}`, { method: "PATCH", body: { is_archived: false } }))}><ArchiveRestore className="h-3.5 w-3.5" />Restore</button>}
            <button className="btn-ghost !py-1" onClick={exportSelected}><FileSpreadsheet className="h-3.5 w-3.5" />Export selected</button>
            {w && <button className="btn-ghost !py-1 !text-red-600" disabled={!!bulk} onClick={() => setBulkDel(true)}><Trash2 className="h-3.5 w-3.5" />Delete</button>}
            <button className="ml-auto rounded p-1 text-sub hover:bg-muted" onClick={() => setSel(new Map())} aria-label="Clear selection"><X className="h-4 w-4" /></button>
            {bulk && <div className="basis-full"><div className="text-xs text-sub">{bulk.label}… {bulk.done}/{bulk.total}</div><div className="mt-1 h-1 overflow-hidden rounded bg-muted"><div className="h-full rounded bg-brand transition-all duration-300" style={{ width: `${(bulk.done / bulk.total) * 100}%` }} /></div></div>}
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2 border-b p-2.5">
            <select className="input !w-auto" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} aria-label="Status"><option value="active">Status: Active</option><option value="inactive">Status: Inactive</option><option value="archived">Status: Archived</option><option value="all">Status: All</option></select>
            <select className="input !w-auto" value={stock} onChange={(e) => { setStock(e.target.value); setPage(1); }} aria-label="Stock"><option value="all">Stock: Any</option><option value="in">In stock</option><option value="low">Low stock</option><option value="out">Out of stock</option></select>
            <select className="input !w-auto" value={cat} onChange={(e) => { setCat(e.target.value); setPage(1); }} aria-label="Category"><option value="">Category: All</option>{(cats.data || []).map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
            <select className="input !w-auto" value={brand} onChange={(e) => { setBrand(e.target.value); setPage(1); }} aria-label="Brand"><option value="">Brand: All</option>{(brands.data || []).map((b: any) => <option key={b.id} value={b.id}>{b.name}</option>)}</select>
            {can("purchases") && <select className="input !w-auto" value={vendor} onChange={(e) => { setVendor(e.target.value); setPage(1); }} aria-label="Vendor"><option value="">Vendor: All</option>{(vendors.data?.items || []).map((v: any) => <option key={v.id} value={v.id}>{v.name}</option>)}</select>}
            <div className="relative w-full max-w-xs"><Search className="pointer-events-none absolute left-2.5 top-2 h-3.5 w-3.5 text-sub" /><input ref={search} className="input !pl-8 !pr-7" placeholder="Search name, SKU, barcode, brand…  ( / )" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); setSp(e.target.value ? { q: e.target.value } : {}); }} />
              {q && <button className="absolute right-1.5 top-1.5 rounded p-0.5 text-sub hover:bg-muted" onClick={() => { setQ(""); setSp({}); }} aria-label="Clear search"><X className="h-3.5 w-3.5" /></button>}</div>
          </div>)}
        {error ? <p className="p-4 text-red-500">{error}</p> : (
          <DataTable storageKey="sp_items_cols" columns={columns} rows={rows} rowKey={(r) => r.id} loading={loading} hasData={!!data} sort={sort} desc={desc} onSort={sortBy} minWidth={900}
            selected={sel} onToggle={toggle} onToggleAll={(v) => setSel((m) => { const n = new Map(m); rows.forEach((r) => (v ? n.set(r.id, r) : n.delete(r.id))); return n; })}
            onRowOpen={setQuick} animKey={qs}
            empty={<Empty title={q || cat || brand || vendor || stock !== "all" ? "No items match these filters" : "No items yet"} hint={w ? "Click New Item, or drop a CSV file anywhere on this page to import many at once." : "Try changing the filters."} action={w ? <button className="btn-primary" onClick={() => go("/products/new")}><Plus className="h-4 w-4" />New Item</button> : undefined} />}
            rowActions={(p) => (
              <div className="flex items-center justify-end gap-0.5">
                <span className="row-actions flex gap-0.5"><button className="rounded p-1 hover:bg-muted" aria-label={`View ${p.name}`} data-tip="View" onClick={() => go(`/products/${p.id}`)}><Eye className="h-4 w-4" /></button>
                  {w && <button className="rounded p-1 hover:bg-muted" aria-label={`Edit ${p.name}`} data-tip="Edit" onClick={() => go(`/products/${p.id}/edit`)}><Pencil className="h-4 w-4" /></button>}</span>
                <RowMenu items={[{ label: "View", icon: Eye, onClick: () => go(`/products/${p.id}`) }, { label: "Edit", icon: Pencil, onClick: () => go(`/products/${p.id}/edit`), hidden: !w },
                  { label: p.status === "active" ? "Mark inactive" : "Mark active", icon: Power, onClick: () => patch(p, { status: p.status === "active" ? "inactive" : "active" }, "Status updated"), hidden: !w || p.is_archived },
                  { label: "Archive", icon: Archive, onClick: () => patch(p, { is_archived: true }, "Item archived"), hidden: !w || p.is_archived }, { label: "Restore", icon: ArchiveRestore, onClick: () => patch(p, { is_archived: false }, "Item restored"), hidden: !w || !p.is_archived },
                  { label: "Delete", icon: Trash2, onClick: () => setDel(p), danger: true, hidden: !w }]} /></div>)} />)}
        {data && <Pagination total={data.total} page={page} size={size} setPage={setPage} setSize={setSize} noun="items" />}
      </div>
      {quick && <QuickView row={quick} canEdit={w} onClose={() => setQuick(null)} />}
      {del && <Confirm title="Delete item" text={`Delete ${del.name}? Items with stock history can't be deleted — archive them instead.`} action="Delete" onConfirm={() => remove(del)} onClose={() => setDel(null)} />}
      {bulkDel && <Confirm title={`Delete ${selArr.length} item${selArr.length !== 1 ? "s" : ""}`} text="Items with stock history are skipped and reported; archive those instead." action="Delete" onConfirm={() => runBulk("Delete", (r) => api(`/products/${r.id}`, { method: "DELETE" }))} onClose={() => setBulkDel(false)} />}
      {importRes && <Modal title="Import results" onClose={() => setImportRes(null)}>
        <div className="space-y-3 text-[13px]"><div className="flex items-center gap-3 rounded-md bg-emerald-500/10 p-3"><SuccessCheck size={32} /><div><p className="font-semibold">{importRes.created} item{importRes.created !== 1 ? "s" : ""} imported</p><p className="text-sub">{importRes.errors.length} row{importRes.errors.length !== 1 ? "s" : ""} skipped (nothing partial is saved for a skipped row)</p></div></div>
          {importRes.errors.length > 0 && <ul className="max-h-48 space-y-1 overflow-y-auto rounded-md border p-2">{importRes.errors.map((e: any, i: number) => <li key={i} className="text-red-600"><b>Row {e.row}:</b> {e.error}</li>)}</ul>}
          <div className="flex justify-between"><button className="btn-ghost" onClick={tpl}><Download className="h-3.5 w-3.5" />Download template</button><button className="btn-primary" onClick={() => setImportRes(null)}>Done</button></div></div></Modal>}
      {dropping && w && <Portal><div className="anim-fade pointer-events-none fixed inset-0 z-[80] flex items-center justify-center bg-brand/10 backdrop-blur-[1px]"><div className="anim-pop rounded-xl border-2 border-dashed border-brand bg-surface px-10 py-8 text-center shadow-[var(--shadow-3)]"><Upload className="mx-auto h-8 w-8 text-brand" /><p className="mt-2 text-base font-semibold">Drop CSV to import items</p><p className="text-[13px] text-sub">name, sku, category, brand, preferred_vendor, status, unit, hsn_code, prices, tax_rate, reorder_point, opening_stock, warehouse</p></div></div></Portal>}
    </div>
  );
}
