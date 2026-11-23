import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Archive, ArchiveRestore, Download, Eye, FileSpreadsheet, MoreHorizontal, Pencil, Plus, Search, Trash2, Upload, X } from "lucide-react";
import { api, download, fmt, money } from "../api";
import { useMe } from "../App";
import { Drawer, Num, Portal, SuccessCheck, useDismiss, useHotkeys } from "../fx";
import { Col, DataTable } from "../DataTable";
import { Badge, Confirm, Empty, Modal, Skeleton, StatusDot, useLoad, useToast } from "../ui";

export const addr = (w: any) => [w.address, w.city, [w.state, w.pincode].filter(Boolean).join(" ")].filter(Boolean).join(", ");

/** Kebab menu positioned with fixed coordinates (never clipped by table overflow); animates open, closes on outside click / Esc / scroll. */
export function RowMenu({ items }: { items: { label: string; icon: any; onClick: () => void; danger?: boolean; hidden?: boolean }[] }) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const btn = useRef<HTMLButtonElement>(null); const menu = useRef<HTMLDivElement>(null);
  useDismiss(menu, !!pos, () => setPos(null));
  useEffect(() => {
    if (!pos) return; const close = () => setPos(null);
    window.addEventListener("scroll", close, true); window.addEventListener("resize", close);
    menu.current?.querySelector("button")?.focus();
    return () => { window.removeEventListener("scroll", close, true); window.removeEventListener("resize", close); };
  }, [pos]);
  const open = () => { const r = btn.current!.getBoundingClientRect(); setPos({ x: Math.max(8, r.right - 176), y: Math.min(r.bottom + 4, window.innerHeight - 190) }); };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return; e.preventDefault();
    const bs = Array.from(menu.current!.querySelectorAll("button")); const i = bs.indexOf(document.activeElement as HTMLButtonElement);
    bs[(i + (e.key === "ArrowDown" ? 1 : bs.length - 1)) % bs.length].focus();
  };
  return (
    <>
      <button ref={btn} className="rounded p-1 hover:bg-muted" aria-label="More actions" aria-haspopup="menu" aria-expanded={!!pos} data-tip="More actions" data-tip-right onClick={(e) => { e.stopPropagation(); pos ? setPos(null) : open(); }}><MoreHorizontal className="h-4 w-4" /></button>
      {pos && <div ref={menu} role="menu" onKeyDown={onKey} className="card anim-pop fixed z-50 w-44 py-1 text-[13px] shadow-[var(--shadow-3)]" style={{ left: pos.x, top: pos.y }} onClick={(e) => e.stopPropagation()}>
        {items.filter((i) => !i.hidden).map((i) => <button key={i.label} role="menuitem" className={`flex w-full items-center gap-2 px-3 py-1.5 text-left outline-none transition-colors hover:bg-muted focus:bg-muted ${i.danger ? "text-red-600" : ""}`} onClick={() => { setPos(null); i.onClick(); }}><i.icon className="h-3.5 w-3.5" />{i.label}</button>)}
      </div>}
    </>
  );
}

export function Pagination({ total, page, size, setPage, setSize, noun }: { total: number; page: number; size: number; setPage: (n: number) => void; setSize?: (n: number) => void; noun: string }) {
  const pages = Math.max(1, Math.ceil(total / size));
  const from = total ? (page - 1) * size + 1 : 0, to = Math.min(total, page * size);
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-t px-3 py-2 text-[13px] text-sub">
      <span>{total ? `Showing ${from}–${to} of ${total} ${noun}` : `No ${noun}`}</span>
      <div className="flex items-center gap-2">
        {setSize && <select className="input !w-auto !py-1" value={size} onChange={(e) => { setSize(+e.target.value); setPage(1); }} aria-label="Rows per page">{[10, 25, 50].map((n) => <option key={n} value={n}>{n} per page</option>)}</select>}
        <button className="btn-ghost !py-1" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button>
        <span className="px-1 tabular-nums">Page {page} of {pages}</span>
        <button className="btn-ghost !py-1" disabled={page >= pages} onClick={() => setPage(page + 1)}>Next</button>
      </div>
    </div>
  );
}

function QuickView({ row, canEdit, onClose }: { row: any; canEdit: boolean; onClose: () => void }) {
  const go = useNavigate();
  const { data: d } = useLoad(() => api(`/warehouses/${row.id}`), [row.id]);
  const w = d || row;
  return (
    <Drawer title={row.name} subtitle={<span className="flex items-center gap-2">{row.code} · <StatusDot active={row.is_active} /></span>} onClose={onClose}
      footer={<><button className="btn-primary flex-1" onClick={() => go(`/warehouses/${row.id}`)}><Eye className="h-3.5 w-3.5" />Open details</button>{canEdit && <button className="btn-ghost" onClick={() => go(`/warehouses/${row.id}/edit`)}><Pencil className="h-3.5 w-3.5" />Edit</button>}</>}>
      <div className="space-y-4 text-[13px]">
        <div className="grid grid-cols-2 gap-2">{[["Products", w.products, 0], ["On hand", w.on_hand, 0], ["Available", w.available, 0], ["Reserved", w.reserved, 0]].map(([l, v, dec], i) => (
          <div key={l as string} className="stagger rounded-md border bg-muted/40 p-2.5" style={{ ["--i" as any]: i }}><p className="text-[11px] text-sub">{l}</p><p className="text-base font-semibold"><Num value={v as number} decimals={dec as number} /></p></div>))}</div>
        <div className="rounded-md border p-2.5"><p className="text-[11px] text-sub">Inventory value</p><p className="text-base font-semibold"><Num value={w.value} prefix="₹" decimals={2} /></p></div>
        <dl className="space-y-1.5"><div><dt className="text-[11px] text-sub">Address</dt><dd>{addr(w) || "—"}</dd></div>
          <div><dt className="text-[11px] text-sub">Contact</dt><dd>{[w.contact_name, w.phone, w.email].filter(Boolean).join(" · ") || "—"}</dd></div>
          {w.description && <div><dt className="text-[11px] text-sub">Description</dt><dd>{w.description}</dd></div>}</dl>
        <div><p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-sub">Needs attention</p>
          {!d ? <div className="skeleton h-16" /> : [...d.out_items, ...d.low_items].length === 0 ? <p className="text-sub">All products are above reorder points.</p> :
            <ul className="divide-y rounded-md border">{[...d.out_items, ...d.low_items].slice(0, 6).map((r: any) => <li key={r.product_id} className="flex items-center justify-between px-2.5 py-1.5"><span className="truncate">{r.name}</span><Badge tone={r.status === "out" ? "bad" : "warn"}>{r.status === "out" ? "Out" : `${fmt(r.available)} left`}</Badge></li>)}</ul>}</div>
      </div>
    </Drawer>
  );
}

export default function Warehouses() {
  const { can } = useMe(); const toast = useToast(); const go = useNavigate();
  const [q, setQ] = useState(""); const [status, setStatus] = useState("active"); const [sort, setSort] = useState("name"); const [desc, setDesc] = useState(false);
  const [page, setPage] = useState(1); const [size, setSize] = useState(10);
  const [arch, setArch] = useState<any>(null); const [del, setDel] = useState<any>(null); const [quick, setQuick] = useState<any>(null);
  const [sel, setSel] = useState<Map<string | number, any>>(new Map()); const [bulk, setBulk] = useState<{ label: string; done: number; total: number } | null>(null); const [bulkDel, setBulkDel] = useState(false);
  const [dropping, setDropping] = useState(false); const [importRes, setImportRes] = useState<any>(null); const [importing, setImporting] = useState(false);
  const search = useRef<HTMLInputElement>(null); const file = useRef<HTMLInputElement>(null);
  const ov = useLoad(() => api("/warehouses/overview"));
  const { data, loading, error, reload } = useLoad(() => api(`/warehouses?page=${page}&page_size=${size}&q=${encodeURIComponent(q)}&status=${status}&sort=${sort}&desc=${desc}`), [page, size, q, status, sort, desc]);
  const w = can("warehouses", "w");
  const refresh = () => { reload(); ov.reload(); };
  const rows: any[] = data?.items || [];

  useHotkeys({ n: () => w && go("/warehouses/new"), "/": () => search.current?.focus() }, [w]);
  useEffect(() => { setSel(new Map()); }, [q, status]);

  /* --- file drag & drop (CSV import) --- */
  const upload = async (f: File) => {
    if (!w) return toast("You don't have permission to import warehouses", "err");
    if (!/\.csv$/i.test(f.name)) return toast("Please drop a .csv file", "err");
    setImporting(true);
    try { const fd = new FormData(); fd.append("file", f); const r = await api("/warehouses-import", { form: fd }); setImportRes(r); toast(`Imported ${r.created} warehouse${r.created !== 1 ? "s" : ""}${r.errors.length ? `, ${r.errors.length} skipped` : ""}`, r.errors.length && !r.created ? "err" : "ok"); window.dispatchEvent(new Event("sp-data-changed")); }
    catch (e: any) { toast(e.message, "err"); } finally { setImporting(false); }
  };
  useEffect(() => {
    let depth = 0; const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types || []).includes("Files");
    const enter = (e: DragEvent) => { if (hasFiles(e)) { depth++; setDropping(true); } };
    const leave = (e: DragEvent) => { if (hasFiles(e) && --depth <= 0) { depth = 0; setDropping(false); } };
    const over = (e: DragEvent) => { if (hasFiles(e)) e.preventDefault(); };
    const drop = (e: DragEvent) => { if (!hasFiles(e)) return; e.preventDefault(); depth = 0; setDropping(false); const f = e.dataTransfer?.files?.[0]; if (f) upload(f); };
    window.addEventListener("dragenter", enter); window.addEventListener("dragleave", leave); window.addEventListener("dragover", over); window.addEventListener("drop", drop);
    return () => { window.removeEventListener("dragenter", enter); window.removeEventListener("dragleave", leave); window.removeEventListener("dragover", over); window.removeEventListener("drop", drop); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [w]);

  const setArchived = async (x: any, active: boolean) => {
    try { await api(`/warehouses/${x.id}`, { method: "PATCH", body: { is_active: active } }); toast(active ? "Warehouse restored" : "Warehouse archived"); refresh(); }
    catch (e: any) { toast(e.message, "err"); }
  };
  const remove = async (x: any) => { try { await api(`/warehouses/${x.id}`, { method: "DELETE" }); toast("Warehouse deleted"); refresh(); } catch (e: any) { toast(e.message, "err"); } };

  /* --- bulk actions with visible progress --- */
  const runBulk = async (label: string, fn: (r: any) => Promise<void>) => {
    const list = Array.from(sel.values()); const fails: string[] = []; setBulk({ label, done: 0, total: list.length });
    for (let i = 0; i < list.length; i++) { try { await fn(list[i]); } catch (e: any) { fails.push(`${list[i].code}: ${e.message}`); } setBulk({ label, done: i + 1, total: list.length }); }
    setBulk(null); setSel(new Map()); refresh();
    if (fails.length) toast(`${list.length - fails.length} done, ${fails.length} failed — ${fails[0]}`, "err"); else toast(`${label} complete for ${list.length} warehouse${list.length !== 1 ? "s" : ""}`);
  };
  const exportSelected = () => {
    const cols = ["code", "name", "address", "city", "state", "pincode", "contact_name", "phone", "email", "products", "available", "value"];
    const esc = (v: any) => { const s = String(v ?? ""); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const csv = [cols.join(","), ...Array.from(sel.values()).map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n");
    const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" })); a.download = "selected-warehouses.csv"; a.click(); URL.revokeObjectURL(a.href);
  };
  const toggle = (r: any) => setSel((m) => { const n = new Map(m); n.has(r.id) ? n.delete(r.id) : n.set(r.id, r); return n; });
  const selArr = Array.from(sel.values());
  const sortBy = (k: string) => { if (sort === k) setDesc(!desc); else { setSort(k); setDesc(false); } setPage(1); };

  const columns: Col<any>[] = [
    { id: "name", label: "Warehouse Name", sort: "name", w: 20, cell: (x) => <td className="td"><Link className="font-medium text-brand hover:underline" to={`/warehouses/${x.id}`} onClick={(e) => e.stopPropagation()}>{x.name}</Link></td> },
    { id: "code", label: "Code", sort: "code", w: 8, cell: (x) => <td className="td text-sub">{x.code}</td> },
    { id: "address", label: "Address", sort: "city", w: 24, cell: (x) => <td className="td truncate text-sub" title={addr(x)}>{addr(x) || "—"}</td> },
    { id: "contact", label: "Contact Person", w: 15, cell: (x) => <td className="td truncate">{x.contact_name || <span className="text-sub">—</span>}{x.phone && <div className="truncate text-xs text-sub">{x.phone}</div>}</td> },
    { id: "status", label: "Status", w: 9, cell: (x) => <td className="td"><StatusDot active={x.is_active} /></td> },
    { id: "products", label: "Products", sort: "products", right: true, w: 8, cell: (x) => <td className="td text-right tabular-nums">{fmt(x.products)}</td> },
    { id: "available", label: "Available Stock", sort: "available", right: true, w: 12, cell: (x) => <td className="td text-right"><Num value={x.available} />{(x.low > 0 || x.out > 0) && <div className="text-[11px]">{x.low > 0 && <span className="text-amber-600">{x.low} low</span>}{x.low > 0 && x.out > 0 && " · "}{x.out > 0 && <span className="text-red-600">{x.out} out</span>}</div>}</td> },
  ];
  const o = ov.data;
  const template = () => { const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob(["code,name,address,city,state,pincode,contact_name,phone,email,description\nPUN,Pune Depot,Plot 4 MIDC,Pune,Maharashtra,411026,Meera Nair,+91 98200 11122,pune@example.com,Overflow storage\n"], { type: "text/csv" })); a.download = "warehouse-import-template.csv"; a.click(); URL.revokeObjectURL(a.href); };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-lg font-semibold">Warehouses</h1>
        <div className="flex flex-wrap gap-2">
          {w && <button className="btn-primary" onClick={() => go("/warehouses/new")} data-tip="New warehouse (N)"><Plus className="h-4 w-4" />New Warehouse</button>}
          {w && <><input ref={file} type="file" accept=".csv,text/csv" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); e.target.value = ""; }} />
            <button className={`btn-ghost ${importing ? "btn-loading" : ""}`} onClick={() => file.current?.click()} data-tip="Or drop a CSV anywhere on this page"><Upload className="h-3.5 w-3.5" />Import</button></>}
          <button className="btn-ghost" onClick={() => download("/warehouses/report.csv", "warehouse-report.csv").catch((e) => toast(e.message, "err"))}><Download className="h-3.5 w-3.5" />Export</button>
          <Link to="/transfers" className="btn-ghost">Transfers</Link>
        </div>
      </div>

      {o ? <p className="anim-fade text-[13px] text-sub">
        <b className="font-semibold text-ink"><Num value={o.active} /></b> active{o.archived > 0 && <> · {o.archived} archived</>} · <b className="font-semibold text-ink"><Num value={o.on_hand} /></b> units on hand (<Num value={o.available} /> available, <Num value={o.reserved} /> reserved) · inventory value <b className="font-semibold text-ink"><Num value={o.value} prefix="₹" decimals={2} /></b>
        {(o.low > 0 || o.out > 0) && <> · <span className="text-amber-600">{o.low} low</span> · <span className="text-red-600">{o.out} out of stock</span></>}</p> : <div className="skeleton h-5 w-2/3" />}

      <div className="card overflow-hidden">
        {selArr.length > 0 ? (
          <div className="anim-fade flex flex-wrap items-center gap-2 border-b bg-brand/5 p-2.5" role="toolbar" aria-label="Bulk actions">
            <span className="text-[13px] font-medium tabular-nums">{selArr.length} selected</span><span className="mx-1 h-4 w-px bg-line" />
            {w && selArr.some((r) => r.is_active) && <button className="btn-ghost !py-1" disabled={!!bulk} onClick={() => runBulk("Archive", (r) => r.is_active ? api(`/warehouses/${r.id}`, { method: "PATCH", body: { is_active: false } }) : Promise.resolve())}><Archive className="h-3.5 w-3.5" />Archive</button>}
            {w && selArr.some((r) => !r.is_active) && <button className="btn-ghost !py-1" disabled={!!bulk} onClick={() => runBulk("Restore", (r) => !r.is_active ? api(`/warehouses/${r.id}`, { method: "PATCH", body: { is_active: true } }) : Promise.resolve())}><ArchiveRestore className="h-3.5 w-3.5" />Restore</button>}
            <button className="btn-ghost !py-1" onClick={exportSelected}><FileSpreadsheet className="h-3.5 w-3.5" />Export selected</button>
            {w && <button className="btn-ghost !py-1 !text-red-600" disabled={!!bulk} onClick={() => setBulkDel(true)}><Trash2 className="h-3.5 w-3.5" />Delete</button>}
            <button className="ml-auto rounded p-1 text-sub hover:bg-muted" onClick={() => setSel(new Map())} aria-label="Clear selection" data-tip="Clear selection" data-tip-right><X className="h-4 w-4" /></button>
            {bulk && <div className="basis-full"><div className="flex items-center justify-between text-xs text-sub"><span>{bulk.label}… {bulk.done}/{bulk.total}</span></div><div className="mt-1 h-1 overflow-hidden rounded bg-muted"><div className="h-full rounded bg-brand transition-all duration-300" style={{ width: `${(bulk.done / bulk.total) * 100}%` }} /></div></div>}
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2 border-b p-2.5">
            <select className="input !w-auto" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} aria-label="Status filter"><option value="active">Status: Active</option><option value="archived">Status: Archived</option><option value="all">Status: All</option></select>
            <div className="relative w-full max-w-xs"><Search className="pointer-events-none absolute left-2.5 top-2 h-3.5 w-3.5 text-sub" /><input ref={search} className="input !pl-8 !pr-7" placeholder="Search name, code, city, contact…  ( / )" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} />
              {q && <button className="absolute right-1.5 top-1.5 rounded p-0.5 text-sub hover:bg-muted" onClick={() => { setQ(""); search.current?.focus(); }} aria-label="Clear search"><X className="h-3.5 w-3.5" /></button>}</div>
            <span className="ml-auto hidden text-xs text-sub lg:block">Tip: drag column headers to reorder · ↑↓ to move, Enter to preview, Space to select</span>
          </div>)}
        {error ? <p className="p-4 text-red-500">{error}</p> : (
          <DataTable storageKey="sp_wh_cols" columns={columns} rows={rows} rowKey={(r) => r.id} loading={loading} hasData={!!data} sort={sort} desc={desc} onSort={sortBy}
            selected={sel} onToggle={toggle} onToggleAll={(v) => setSel((m) => { const n = new Map(m); rows.forEach((r) => (v ? n.set(r.id, r) : n.delete(r.id))); return n; })}
            onRowOpen={setQuick} animKey={`${page}-${sort}-${desc}-${status}-${q}`}
            empty={<Empty title={q ? "No warehouses match your search" : "No warehouses yet"} hint={w && !q ? "Click New Warehouse, or drop a CSV file anywhere on this page to import several at once." : "Try a different search or status filter."} action={w && !q ? <button className="btn-primary" onClick={() => go("/warehouses/new")}><Plus className="h-4 w-4" />New Warehouse</button> : undefined} />}
            rowActions={(x) => (
              <div className="flex items-center justify-end gap-0.5">
                <span className="row-actions flex gap-0.5"><button className="rounded p-1 hover:bg-muted" aria-label={`View ${x.name}`} data-tip="View details" onClick={() => go(`/warehouses/${x.id}`)}><Eye className="h-4 w-4" /></button>
                  {w && <button className="rounded p-1 hover:bg-muted" aria-label={`Edit ${x.name}`} data-tip="Edit" onClick={() => go(`/warehouses/${x.id}/edit`)}><Pencil className="h-4 w-4" /></button>}</span>
                <RowMenu items={[
                  { label: "View", icon: Eye, onClick: () => go(`/warehouses/${x.id}`) }, { label: "Edit", icon: Pencil, onClick: () => go(`/warehouses/${x.id}/edit`), hidden: !w },
                  { label: "Archive", icon: Archive, onClick: () => setArch(x), hidden: !w || !x.is_active }, { label: "Restore", icon: ArchiveRestore, onClick: () => setArchived(x, true), hidden: !w || x.is_active },
                  { label: "Delete", icon: Trash2, onClick: () => setDel(x), danger: true, hidden: !w }]} /></div>)} />)}
        {data && <Pagination total={data.total} page={page} size={size} setPage={setPage} setSize={setSize} noun="warehouses" />}
      </div>

      {quick && <QuickView row={quick} canEdit={w} onClose={() => setQuick(null)} />}
      {arch && <Confirm title="Archive warehouse" text={`Archive ${arch.name}? It must hold no stock, and nothing can be transferred into it until you restore it.`} action="Archive" onConfirm={() => setArchived(arch, false)} onClose={() => setArch(null)} />}
      {del && <Confirm title="Delete warehouse" text={`Permanently delete ${del.name}? This only works for warehouses with no stock or transfer history; otherwise archive it.`} action="Delete" onConfirm={() => remove(del)} onClose={() => setDel(null)} />}
      {bulkDel && <Confirm title={`Delete ${selArr.length} warehouse${selArr.length !== 1 ? "s" : ""}`} text="Each selected warehouse is deleted only if it has no stock or transfer history. Others are left untouched and reported." action="Delete" onConfirm={() => runBulk("Delete", (r) => api(`/warehouses/${r.id}`, { method: "DELETE" }))} onClose={() => setBulkDel(false)} />}
      {importRes && <Modal title="Import results" onClose={() => setImportRes(null)}>
        <div className="space-y-3 text-[13px]"><div className="flex items-center gap-3 rounded-md bg-emerald-500/10 p-3"><SuccessCheck size={32} /><div><p className="font-semibold">{importRes.created} warehouse{importRes.created !== 1 ? "s" : ""} imported</p><p className="text-sub">{importRes.errors.length} row{importRes.errors.length !== 1 ? "s" : ""} skipped</p></div></div>
          {importRes.errors.length > 0 && <ul className="max-h-48 space-y-1 overflow-y-auto rounded-md border p-2">{importRes.errors.map((e: any, i: number) => <li key={i} className="text-red-600"><b>Row {e.row}:</b> {e.error}</li>)}</ul>}
          <div className="flex justify-between"><button className="btn-ghost" onClick={template}><Download className="h-3.5 w-3.5" />Download template</button><button className="btn-primary" onClick={() => setImportRes(null)}>Done</button></div></div></Modal>}
      {dropping && w && <Portal><div className="anim-fade pointer-events-none fixed inset-0 z-[80] flex items-center justify-center bg-brand/10 backdrop-blur-[1px]"><div className="anim-pop rounded-xl border-2 border-dashed border-brand bg-surface px-10 py-8 text-center shadow-[var(--shadow-3)]"><Upload className="mx-auto h-8 w-8 text-brand" /><p className="mt-2 text-base font-semibold">Drop CSV to import warehouses</p><p className="text-[13px] text-sub">Columns: code, name, address, city, state, pincode, contact_name, phone, email, description</p></div></div></Portal>}
    </div>
  );
}

/* ---------- full-page create / edit form with inline validation ---------- */
const RULES: Record<string, (v: string, edit: boolean) => string> = {
  name: (v) => (!v.trim() ? "Warehouse name is required" : v.trim().length < 2 ? "Use at least 2 characters" : ""),
  code: (v, edit) => (edit ? "" : !v.trim() ? "Warehouse code is required" : !/^[A-Za-z0-9_-]{1,20}$/.test(v.trim()) ? "Letters, numbers, - and _ only (max 20)" : ""),
  email: (v) => (v && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v) ? "Enter a valid email address" : ""),
  phone: (v) => (v && !/^[0-9+()\-\s]{6,30}$/.test(v) ? "Use digits, spaces, + ( ) - (6–30 characters)" : ""),
  pincode: (v) => (v && !/^[0-9A-Za-z\s-]{3,10}$/.test(v) ? "Enter a valid PIN / postal code" : ""),
};
const Row = ({ label, required, children, note, error }: { label: string; required?: boolean; children: React.ReactNode; note?: string; error?: string }) => (
  <div className="grid items-start gap-1 sm:grid-cols-[12rem_1fr] sm:gap-4">
    <label className="pt-1.5 text-[13px] text-ink">{label}{required && <span className="text-red-500"> *</span>}</label>
    <div>{children}<p className={`mt-1 min-h-[1rem] text-xs transition-colors ${error ? "text-red-600" : "text-sub"}`} role={error ? "alert" : undefined}>{error || note || ""}</p></div>
  </div>);

export function WarehouseFormPage() {
  const { id } = useParams(); const go = useNavigate(); const toast = useToast();
  const edit = !!id;
  const existing = useLoad(() => (id ? api(`/warehouses/${id}`) : Promise.resolve(null)), [id]);
  const [f, setF] = useState<any>({ code: "", name: "", address: "", city: "", state: "", pincode: "", contact_name: "", phone: "", email: "", description: "" });
  const [errs, setErrs] = useState<Record<string, string>>({}); const [busy, setBusy] = useState(false); const [banner, setBanner] = useState(""); const [shake, setShake] = useState(0); const [done, setDone] = useState(false);
  useLayoutEffect(() => { if (existing.data) setF((p: any) => ({ ...p, ...Object.fromEntries(Object.entries(existing.data).map(([k, v]) => [k, v ?? ""])) })); }, [existing.data]);
  const s = (k: string) => (e: any) => { setF({ ...f, [k]: e.target.value }); if (errs[k]) setErrs({ ...errs, [k]: RULES[k]?.(e.target.value, edit) || "" }); };
  const blur = (k: string) => () => RULES[k] && setErrs((p) => ({ ...p, [k]: RULES[k](f[k], edit) }));
  const cls = (k: string, extra = "") => `input ${errs[k] ? "input-error" : ""} ${extra}`;
  const save = async (e: React.FormEvent) => {
    e.preventDefault(); setBanner("");
    const ev: Record<string, string> = {}; for (const k of Object.keys(RULES)) { const m = RULES[k](f[k] || "", edit); if (m) ev[k] = m; }
    setErrs(ev); if (Object.keys(ev).length) { setShake((n) => n + 1); document.querySelector<HTMLElement>("[role=alert]")?.closest("div.grid")?.querySelector<HTMLElement>("input,textarea")?.focus(); return; }
    setBusy(true);
    try {
      const body: any = {}; for (const k of ["address", "city", "state", "pincode", "contact_name", "phone", "email", "description"]) body[k] = f[k] || null; body.name = f.name.trim();
      const r = edit ? await api(`/warehouses/${id}`, { method: "PATCH", body }) : await api("/warehouses", { body: { ...body, code: f.code.trim() } });
      window.dispatchEvent(new Event("sp-data-changed")); setDone(true);
      setTimeout(() => { toast(edit ? "Warehouse updated" : "Warehouse created"); go(edit ? `/warehouses/${id}` : `/warehouses/${r.id}`); }, 950);
    } catch (e: any) { if (/code/i.test(e.message)) setErrs((p) => ({ ...p, code: e.message })); else setBanner(e.message); setShake((n) => n + 1); setBusy(false); }
  };
  if (edit && existing.loading) return <div className="card"><Skeleton rows={8} /></div>;
  return (
    <form onSubmit={save} className="space-y-3" noValidate>
      <div className="flex items-center gap-2 text-[13px] text-sub"><Link to="/warehouses" className="hover:text-ink">Warehouses</Link><span>/</span><span className="text-ink">{edit ? "Edit warehouse" : "New warehouse"}</span></div>
      <h1 className="text-lg font-semibold">{edit ? `Edit ${existing.data?.name ?? "warehouse"}` : "New Warehouse"}</h1>
      <div key={shake} className={`card relative max-w-3xl space-y-1 p-5 ${shake ? "anim-shake" : ""}`}>
        <Row label="Warehouse Name" required error={errs.name}><input autoFocus className={cls("name")} maxLength={120} value={f.name} onChange={s("name")} onBlur={blur("name")} aria-invalid={!!errs.name} /></Row>
        <Row label="Warehouse Code" required error={errs.code} note={edit ? "The code can't be changed after creation." : "Short unique identifier, e.g. MUM. Saved in upper case."}><input disabled={edit} className={cls("code", "uppercase sm:max-w-[12rem]")} maxLength={20} value={f.code} onChange={s("code")} onBlur={blur("code")} aria-invalid={!!errs.code} /></Row>
        <Row label="Address"><textarea className="input min-h-[60px]" maxLength={300} value={f.address} onChange={s("address")} /></Row>
        <Row label="City / State / PIN" error={errs.pincode}><div className="grid gap-2 sm:grid-cols-3"><input className="input" placeholder="City" value={f.city} onChange={s("city")} /><input className="input" placeholder="State" value={f.state} onChange={s("state")} /><input className={cls("pincode")} placeholder="PIN code" maxLength={10} value={f.pincode} onChange={s("pincode")} onBlur={blur("pincode")} /></div></Row>
        <Row label="Contact Person"><input className="input" maxLength={120} value={f.contact_name} onChange={s("contact_name")} /></Row>
        <Row label="Phone" error={errs.phone}><input className={cls("phone", "sm:max-w-xs")} value={f.phone} onChange={s("phone")} onBlur={blur("phone")} /></Row>
        <Row label="Email" error={errs.email}><input className={cls("email", "sm:max-w-md")} type="email" value={f.email} onChange={s("email")} onBlur={blur("email")} /></Row>
        <Row label="Description"><textarea className="input min-h-[72px]" maxLength={500} value={f.description} onChange={s("description")} /></Row>
        <div className="min-h-[2.25rem]">{banner && <p className="anim-fade rounded-md bg-red-500/10 px-3 py-2 text-[13px] text-red-600" role="alert">{banner}</p>}</div>
        {done && <div className="anim-fade absolute inset-0 flex flex-col items-center justify-center gap-2 rounded-md bg-surface/95"><SuccessCheck size={56} /><p className="font-semibold">{edit ? "Warehouse updated" : "Warehouse created"}</p></div>}
      </div>
      <div className="flex max-w-3xl gap-2"><button className={`btn-primary ${busy ? "btn-loading" : ""}`} disabled={busy}>Save</button><button type="button" className="btn-ghost" disabled={busy} onClick={() => go(edit ? `/warehouses/${id}` : "/warehouses")}>Cancel</button></div>
    </form>
  );
}
