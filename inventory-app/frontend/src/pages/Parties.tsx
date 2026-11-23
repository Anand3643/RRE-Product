import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Download, Eye, Mail, MapPin, Pencil, Phone, Plus, Power, Search, Trash2, X } from "lucide-react";
import { api, dt, download, fmt, money } from "../api";
import { useMe } from "../App";
import { Col, DataTable } from "../DataTable";
import { Drawer, SuccessCheck, TabBar, useHotkeys } from "../fx";
import { Badge, Confirm, Empty, Skeleton, StatusDot, useLoad, useToast } from "../ui";
import { Pagination, RowMenu } from "./Warehouses";
import { CustomerInsights, CustomerStatsStrip, CustomerTransactions, PerformanceCard, VendorStatsStrip, VendorTransactions } from "./VendorParts";

export type Kind = "customer" | "vendor";
type FieldDef = { key: string; label: string; type?: "text" | "email" | "tel" | "number" | "select" | "textarea"; required?: boolean; options?: [string, string][]; hint?: string; upper?: boolean; narrow?: boolean };
type Section = { title: string; fields: FieldDef[]; sameAsBilling?: boolean };

const TERMS: [string, string][] = [["0", "Due on receipt"], ["7", "Net 7"], ["15", "Net 15"], ["30", "Net 30"], ["45", "Net 45"], ["60", "Net 60"], ["90", "Net 90"]];
const BILLING: FieldDef[] = [{ key: "bill_address", label: "Address", type: "textarea" }, { key: "bill_city", label: "City", narrow: true }, { key: "bill_state", label: "State", narrow: true }, { key: "bill_pincode", label: "PIN code", narrow: true }];
const BASE_TOP: FieldDef[] = [{ key: "name", label: "Display name", required: true }, { key: "company_name", label: "Company name" }];
const CONTACT: FieldDef[] = [{ key: "email", label: "Email", type: "email" }, { key: "phone", label: "Phone", type: "tel", narrow: true }, { key: "gstin", label: "GSTIN", upper: true, narrow: true, hint: "15 characters, e.g. 27ABCDE1234F1Z5" }];
const TAIL: FieldDef[] = [{ key: "status", label: "Status", type: "select", options: [["active", "Active"], ["inactive", "Inactive"]], narrow: true }, { key: "notes", label: "Notes", type: "textarea" }];

export const CFG = {
  customer: {
    path: "customers", label: "Customer", plural: "Customers", perm: "sales", blank: { customer_type: "business", payment_terms: "30", credit_limit: "0", status: "active" },
    sections: [
      { title: "Basic information", fields: [...BASE_TOP, { key: "customer_type", label: "Customer type", type: "select", options: [["business", "Business"], ["individual", "Individual"]], narrow: true }, ...CONTACT] },
      { title: "Billing address", fields: BILLING },
      { title: "Shipping address", sameAsBilling: true, fields: [{ key: "ship_address", label: "Address", type: "textarea" }, { key: "ship_city", label: "City", narrow: true }, { key: "ship_state", label: "State", narrow: true }, { key: "ship_pincode", label: "PIN code", narrow: true }] },
      { title: "Terms & credit", fields: [{ key: "payment_terms", label: "Payment terms", type: "select", options: TERMS, narrow: true }, { key: "credit_limit", label: "Credit limit (₹)", type: "number", narrow: true, hint: "0 means no credit limit is enforced." }, ...TAIL] },
    ] as Section[],
  },
  vendor: {
    path: "vendors", label: "Vendor", plural: "Vendors", perm: "purchases", blank: { payment_terms: "30", status: "active" },
    sections: [
      { title: "Basic information", fields: [...BASE_TOP, { key: "contact_person", label: "Contact person" }, ...CONTACT] },
      { title: "Billing address", fields: BILLING },
      { title: "Terms", fields: [{ key: "payment_terms", label: "Payment terms", type: "select", options: TERMS, narrow: true }, ...TAIL] },
      { title: "Bank details", fields: [{ key: "bank_name", label: "Bank name" }, { key: "bank_account", label: "Account number", narrow: true, hint: "6–18 digits" }, { key: "bank_ifsc", label: "IFSC", upper: true, narrow: true, hint: "e.g. HDFC0001234" }] },
    ] as Section[],
  },
} as const;

const VALIDATE: Record<string, (v: string) => string> = {
  name: (v) => (!v.trim() ? "Name is required" : ""),
  email: (v) => (v && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v) ? "Enter a valid email address" : ""),
  phone: (v) => (v && !/^[0-9+()\-\s]{6,30}$/.test(v) ? "Use digits, spaces, + ( ) -" : ""),
  gstin: (v) => (v && !/^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]$/.test(v.toUpperCase()) ? "GSTIN format is 27ABCDE1234F1Z5" : ""),
  bank_account: (v) => (v && !/^\d{6,18}$/.test(v) ? "Account number is 6–18 digits" : ""),
  bank_ifsc: (v) => (v && !/^[A-Z]{4}0[A-Z0-9]{6}$/.test(v.toUpperCase()) ? "IFSC looks like HDFC0001234" : ""),
  credit_limit: (v) => (v !== "" && (isNaN(+v) || +v < 0) ? "Enter 0 or more" : ""),
};
const addrOf = (o: any, p: "bill" | "ship") => [o[`${p}_address`], o[`${p}_city`], [o[`${p}_state`], o[`${p}_pincode`]].filter(Boolean).join(" ")].filter(Boolean).join(", ");

/* ----------------------------- list ----------------------------- */
function QuickView({ kind, row, canEdit, onClose }: { kind: Kind; row: any; canEdit: boolean; onClose: () => void }) {
  const go = useNavigate(); const c = CFG[kind];
  return (
    <Drawer title={row.name} subtitle={<span className="flex items-center gap-2">{row.code} · <StatusDot active={row.status === "active"} /></span>} onClose={onClose}
      footer={<><button className="btn-primary flex-1" onClick={() => go(`/${c.path}/${row.id}`)}><Eye className="h-3.5 w-3.5" />Open {c.label.toLowerCase()}</button>{canEdit && <button className="btn-ghost" onClick={() => go(`/${c.path}/${row.id}/edit`)}><Pencil className="h-3.5 w-3.5" />Edit</button>}</>}>
      <dl className="space-y-3 text-[13px]">
        {row.company_name && <div><dt className="text-[11px] text-sub">Company</dt><dd>{row.company_name}</dd></div>}
        {row.contact_person && <div><dt className="text-[11px] text-sub">Contact person</dt><dd>{row.contact_person}</dd></div>}
        <div><dt className="text-[11px] text-sub">Email</dt><dd>{row.email ? <a className="text-brand hover:underline" href={`mailto:${row.email}`}>{row.email}</a> : "—"}</dd></div>
        <div><dt className="text-[11px] text-sub">Phone</dt><dd>{row.phone || "—"}</dd></div>
        <div><dt className="text-[11px] text-sub">GSTIN</dt><dd>{row.gstin || "—"}</dd></div>
        <div><dt className="text-[11px] text-sub">Billing address</dt><dd>{addrOf(row, "bill") || "—"}</dd></div>
        {kind === "customer" && <div><dt className="text-[11px] text-sub">Shipping address</dt><dd>{addrOf(row, "ship") || "Same as billing"}</dd></div>}
        <div><dt className="text-[11px] text-sub">Payment terms</dt><dd>{row.payment_terms === 0 ? "Due on receipt" : `Net ${row.payment_terms} days`}</dd></div>
        {kind === "customer" && <div><dt className="text-[11px] text-sub">Credit limit</dt><dd>{row.credit_limit ? money(row.credit_limit) : "None"}</dd></div>}
        {kind === "vendor" && <div><dt className="text-[11px] text-sub">Items supplied</dt><dd>{row.items_supplied}</dd></div>}
      </dl>
    </Drawer>
  );
}

export function PartyList({ kind }: { kind: Kind }) {
  const c = CFG[kind]; const { can } = useMe(); const toast = useToast(); const go = useNavigate();
  const [q, setQ] = useState(""); const [status, setStatus] = useState("all"); const [type, setType] = useState(""); const [sort, setSort] = useState("name"); const [desc, setDesc] = useState(false);
  const [page, setPage] = useState(1); const [size, setSize] = useState(25); const [quick, setQuick] = useState<any>(null); const [del, setDel] = useState<any>(null);
  const search = useRef<HTMLInputElement>(null); const w = can(c.perm, "w");
  const qs = `q=${encodeURIComponent(q)}&status=${status}&sort=${sort}&desc=${desc}&page=${page}&page_size=${size}${type ? `&type=${type}` : ""}`;
  const { data, loading, error, reload } = useLoad(() => api(`/${c.path}?${qs}`), [qs, kind]);
  useHotkeys({ n: () => w && go(`/${c.path}/new`), "/": () => search.current?.focus() }, [w, kind]);
  useEffect(() => { setPage(1); setQ(""); setStatus("all"); setType(""); }, [kind]);
  const sortBy = (k: string) => { if (sort === k) setDesc(!desc); else { setSort(k); setDesc(false); } setPage(1); };
  const setActive = async (o: any) => { try { await api(`/${c.path}/${o.id}`, { method: "PATCH", body: { status: o.status === "active" ? "inactive" : "active" } }); toast("Status updated"); reload(); } catch (e: any) { toast(e.message, "err"); } };
  const remove = async (o: any) => { try { await api(`/${c.path}/${o.id}`, { method: "DELETE" }); toast(`${c.label} deleted`); reload(); } catch (e: any) { toast(e.message, "err"); } };
  const link = (o: any) => <td className="td"><Link className="font-medium text-brand hover:underline" to={`/${c.path}/${o.id}`} onClick={(e) => e.stopPropagation()}>{o.name}</Link><div className="truncate text-xs text-sub">{o.code}{o.company_name ? ` · ${o.company_name}` : ""}</div></td>;
  const contact = (o: any) => <td className="td truncate">{kind === "vendor" && o.contact_person ? <div>{o.contact_person}</div> : null}<div className="truncate text-sub">{o.email || "—"}</div>{o.phone && <div className="text-xs text-sub">{o.phone}</div>}</td>;
  const columns: Col<any>[] = kind === "customer" ? [
    { id: "name", label: "Customer", sort: "name", w: 24, cell: link }, { id: "contact", label: "Contact", w: 22, cell: contact }, { id: "gstin", label: "GSTIN", w: 14, cell: (o) => <td className="td text-sub">{o.gstin || "—"}</td> },
    { id: "type", label: "Type", w: 9, cell: (o) => <td className="td capitalize text-sub">{o.customer_type}</td> }, { id: "terms", label: "Terms", sort: "payment_terms", w: 9, cell: (o) => <td className="td text-sub">{o.payment_terms === 0 ? "Due on receipt" : `Net ${o.payment_terms}`}</td> },
    { id: "credit", label: "Credit Limit", w: 11, right: true, cell: (o) => <td className="td text-right tabular-nums">{o.credit_limit ? money(o.credit_limit) : <span className="text-sub">—</span>}</td> }, { id: "status", label: "Status", sort: "status", w: 9, cell: (o) => <td className="td"><StatusDot active={o.status === "active"} /></td> },
  ] : [
    { id: "name", label: "Vendor", sort: "name", w: 25, cell: link }, { id: "contact", label: "Contact", w: 24, cell: contact }, { id: "gstin", label: "GSTIN", w: 15, cell: (o) => <td className="td text-sub">{o.gstin || "—"}</td> },
    { id: "terms", label: "Terms", sort: "payment_terms", w: 10, cell: (o) => <td className="td text-sub">{o.payment_terms === 0 ? "Due on receipt" : `Net ${o.payment_terms}`}</td> },
    { id: "items", label: "Items Supplied", w: 11, right: true, cell: (o) => <td className="td text-right tabular-nums">{fmt(o.items_supplied)}</td> }, { id: "status", label: "Status", sort: "status", w: 9, cell: (o) => <td className="td"><StatusDot active={o.status === "active"} /></td> },
  ];
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2"><h1 className="text-lg font-semibold">{c.plural}</h1>
        <div className="flex gap-2">{w && <button className="btn-primary" onClick={() => go(`/${c.path}/new`)} data-tip={`New ${c.label.toLowerCase()} (N)`}><Plus className="h-4 w-4" />New {c.label}</button>}
          <button className="btn-ghost" onClick={() => download(`/${c.path}-export.csv`, `${c.path}.csv`).catch((e) => toast(e.message, "err"))}><Download className="h-3.5 w-3.5" />Export</button></div></div>
      <div className="card overflow-hidden">
        <div className="flex flex-wrap items-center gap-2 border-b p-2.5">
          <select className="input !w-auto" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} aria-label="Status"><option value="all">Status: All</option><option value="active">Status: Active</option><option value="inactive">Status: Inactive</option></select>
          {kind === "customer" && <select className="input !w-auto" value={type} onChange={(e) => { setType(e.target.value); setPage(1); }} aria-label="Type"><option value="">Type: All</option><option value="business">Business</option><option value="individual">Individual</option></select>}
          <div className="relative w-full max-w-xs"><Search className="pointer-events-none absolute left-2.5 top-2 h-3.5 w-3.5 text-sub" /><input ref={search} className="input !pl-8 !pr-7" placeholder={`Search name, code, email, phone, GSTIN…  ( / )`} value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} />
            {q && <button className="absolute right-1.5 top-1.5 rounded p-0.5 text-sub hover:bg-muted" onClick={() => setQ("")} aria-label="Clear search"><X className="h-3.5 w-3.5" /></button>}</div></div>
        {error ? <p className="p-4 text-red-500">{error}</p> : (
          <DataTable storageKey={`sp_${c.path}_cols`} columns={columns} rows={data?.items || []} rowKey={(r) => r.id} loading={loading} hasData={!!data} sort={sort} desc={desc} onSort={sortBy} onRowOpen={setQuick} animKey={qs}
            empty={<Empty title={q || status !== "all" || type ? `No ${c.plural.toLowerCase()} match these filters` : `No ${c.plural.toLowerCase()} yet`} hint={w ? `Click New ${c.label} to add your first one.` : undefined} action={w && !q ? <button className="btn-primary" onClick={() => go(`/${c.path}/new`)}><Plus className="h-4 w-4" />New {c.label}</button> : undefined} />}
            rowActions={(o) => (<div className="flex items-center justify-end gap-0.5"><span className="row-actions flex gap-0.5"><button className="rounded p-1 hover:bg-muted" aria-label={`View ${o.name}`} data-tip="View" onClick={() => go(`/${c.path}/${o.id}`)}><Eye className="h-4 w-4" /></button>{w && <button className="rounded p-1 hover:bg-muted" aria-label={`Edit ${o.name}`} data-tip="Edit" onClick={() => go(`/${c.path}/${o.id}/edit`)}><Pencil className="h-4 w-4" /></button>}</span>
              <RowMenu items={[{ label: "View", icon: Eye, onClick: () => go(`/${c.path}/${o.id}`) }, { label: "Edit", icon: Pencil, onClick: () => go(`/${c.path}/${o.id}/edit`), hidden: !w }, { label: o.status === "active" ? "Mark inactive" : "Mark active", icon: Power, onClick: () => setActive(o), hidden: !w }, { label: "Delete", icon: Trash2, onClick: () => setDel(o), danger: true, hidden: !w }]} /></div>)} />)}
        {data && <Pagination total={data.total} page={page} size={size} setPage={setPage} setSize={setSize} noun={c.plural.toLowerCase()} />}
      </div>
      {quick && <QuickView kind={kind} row={quick} canEdit={w} onClose={() => setQuick(null)} />}
      {del && <Confirm title={`Delete ${c.label.toLowerCase()}`} text={`Delete ${del.name}? ${c.label}s with transactions can't be deleted — mark them inactive instead.`} action="Delete" onConfirm={() => remove(del)} onClose={() => setDel(null)} />}
    </div>
  );
}

/* ----------------------------- form ----------------------------- */
const Row = ({ label, required, children, note, error }: { label: string; required?: boolean; children: React.ReactNode; note?: string; error?: string }) => (
  <div className="grid items-start gap-1 sm:grid-cols-[12rem_1fr] sm:gap-4"><label className="pt-1.5 text-[13px]">{label}{required && <span className="text-red-500"> *</span>}</label>
    <div>{children}<p className={`mt-1 min-h-[1rem] text-xs ${error ? "text-red-600" : "text-sub"}`} role={error ? "alert" : undefined}>{error || note || ""}</p></div></div>);

export function PartyForm({ kind }: { kind: Kind }) {
  const c = CFG[kind]; const { id } = useParams(); const go = useNavigate(); const toast = useToast(); const edit = !!id;
  const existing = useLoad(() => (id ? api(`/${c.path}/${id}`) : Promise.resolve(null)), [id, kind]);
  const [f, setF] = useState<any>({ ...c.blank }); const [errs, setErrs] = useState<Record<string, string>>({}); const [busy, setBusy] = useState(false); const [done, setDone] = useState(false); const [banner, setBanner] = useState(""); const [shake, setShake] = useState(0);
  useLayoutEffect(() => { if (existing.data) setF(Object.fromEntries(Object.entries(existing.data).map(([k, v]) => [k, v == null ? "" : String(v)]))); }, [existing.data]);
  const masked = !!existing.data?.bank_masked;
  const set = (k: string, v: string) => { setF((p: any) => ({ ...p, [k]: v })); if (errs[k]) setErrs((p) => ({ ...p, [k]: VALIDATE[k]?.(v) || "" })); };
  const sameAsBilling = () => setF((p: any) => ({ ...p, ship_address: p.bill_address || "", ship_city: p.bill_city || "", ship_state: p.bill_state || "", ship_pincode: p.bill_pincode || "" }));
  const save = async (e: React.FormEvent) => {
    e.preventDefault(); setBanner("");
    const ev: Record<string, string> = {}; for (const k of Object.keys(VALIDATE)) { if (masked && k.startsWith("bank_")) continue; const m = VALIDATE[k](f[k] ?? ""); if (m) ev[k] = m; }
    setErrs(ev); if (Object.keys(ev).length) { setShake((n) => n + 1); return; }
    setBusy(true);
    try {
      const body: any = {};
      for (const s of c.sections) for (const fd of s.fields) { if (masked && fd.key.startsWith("bank_")) continue; let v: any = (f[fd.key] ?? "").toString().trim(); if (fd.key === "payment_terms") v = +v; else if (fd.key === "credit_limit") v = +(v || 0); else if (fd.upper) v = v ? v.toUpperCase() : null; else if (v === "" && !["status", "customer_type"].includes(fd.key)) v = null; body[fd.key] = v; }
      const r = edit ? await api(`/${c.path}/${id}`, { method: "PATCH", body }) : await api(`/${c.path}`, { body });
      window.dispatchEvent(new Event("sp-data-changed")); setDone(true);
      setTimeout(() => { toast(`${c.label} ${edit ? "updated" : "created"}`); go(`/${c.path}/${r.id}`); }, 900);
    } catch (e: any) { if (/GSTIN/i.test(e.message)) setErrs((p) => ({ ...p, gstin: e.message })); else setBanner(e.message); setShake((n) => n + 1); setBusy(false); }
  };
  if (edit && existing.loading) return <div className="card"><Skeleton rows={8} /></div>;
  return (
    <form onSubmit={save} className="relative space-y-3" noValidate>
      <div className="flex items-center gap-2 text-[13px] text-sub"><Link to={`/${c.path}`} className="hover:text-ink">{c.plural}</Link><span>/</span><span className="text-ink">{edit ? `Edit ${c.label.toLowerCase()}` : `New ${c.label.toLowerCase()}`}</span></div>
      <h1 className="text-lg font-semibold">{edit ? `Edit ${existing.data?.name ?? c.label}` : `New ${c.label}`}</h1>
      <div key={shake} className={`space-y-3 ${shake ? "anim-shake" : ""}`}>
        {c.sections.map((sec) => (
          <section key={sec.title} className="card max-w-3xl"><div className="flex items-center justify-between border-b px-5 py-2.5"><h2 className="text-[13px] font-semibold">{sec.title}</h2>{sec.sameAsBilling && <button type="button" className="text-xs text-brand hover:underline" onClick={sameAsBilling}>Copy from billing address</button>}</div>
            <div className="space-y-1 p-5">
              {sec.title === "Bank details" && masked && <p className="rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-700">Bank details are hidden for your role and can only be changed by purchasing managers.</p>}
              {sec.fields.map((fd) => (
                <Row key={fd.key} label={fd.label} required={fd.required} note={fd.hint} error={errs[fd.key]}>
                  {fd.type === "textarea" ? <textarea className="input min-h-[60px]" maxLength={500} value={f[fd.key] ?? ""} onChange={(e) => set(fd.key, e.target.value)} />
                    : fd.type === "select" ? <select className="input sm:max-w-xs" value={f[fd.key] ?? ""} onChange={(e) => set(fd.key, e.target.value)}>{fd.options!.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
                    : <input autoFocus={fd.key === "name"} type={fd.type === "number" ? "number" : fd.type === "email" ? "email" : "text"} min={fd.type === "number" ? 0 : undefined} disabled={masked && fd.key.startsWith("bank_")} className={`input ${errs[fd.key] ? "input-error" : ""} ${fd.narrow ? "sm:max-w-sm" : ""} ${fd.upper ? "uppercase" : ""}`} value={masked && fd.key.startsWith("bank_") ? "" : f[fd.key] ?? ""} placeholder={masked && fd.key.startsWith("bank_") ? "Hidden" : ""} maxLength={fd.key === "gstin" ? 15 : fd.key === "bank_ifsc" ? 11 : 200}
                      onChange={(e) => set(fd.key, e.target.value)} onBlur={() => VALIDATE[fd.key] && setErrs((p) => ({ ...p, [fd.key]: VALIDATE[fd.key](f[fd.key] ?? "") }))} aria-invalid={!!errs[fd.key]} />}
                </Row>))}
            </div></section>))}
      </div>
      <div className="min-h-[2rem] max-w-3xl">{banner && <p className="anim-fade rounded-md bg-red-500/10 px-3 py-2 text-[13px] text-red-600" role="alert">{banner}</p>}</div>
      <div className="flex max-w-3xl gap-2"><button className={`btn-primary ${busy ? "btn-loading" : ""}`} disabled={busy}>Save</button><button type="button" className="btn-ghost" disabled={busy} onClick={() => go(edit ? `/${c.path}/${id}` : `/${c.path}`)}>Cancel</button></div>
      {done && <div className="anim-fade fixed inset-0 z-50 flex flex-col items-center justify-center gap-2 bg-surface/90"><SuccessCheck size={64} /><p className="text-base font-semibold">{c.label} {edit ? "updated" : "created"}</p></div>}
    </form>
  );
}

/* ----------------------------- detail ----------------------------- */
export function PartyDetail({ kind }: { kind: Kind }) {
  const c = CFG[kind]; const { id = "" } = useParams(); const { can } = useMe(); const toast = useToast(); const go = useNavigate();
  const [sp, setSp] = useSearchParams(); const tab = sp.get("tab") || "overview"; const w = can(c.perm, "w");
  const { data: d, loading, error, reload } = useLoad(() => api(`/${c.path}/${id}`), [id, kind]);
  const act = useLoad(() => api(`/${c.path}/${id}/activity`), [id, kind]);
  const items = useLoad(() => (kind === "vendor" ? api(`/vendors/${id}/products`) : Promise.resolve([])), [id, kind]);
  const [del, setDel] = useState(false);
  if (loading && !d) return <div className="card"><Skeleton rows={6} /></div>;
  if (error || !d) return <div className="card"><Empty title={`${c.label} not found`} hint={error} /></div>;
  const tabs = (kind === "vendor" ? [["overview", "Overview"], ["transactions", "Transactions"], ["items", "Items supplied"], ["activity", "Activity"]] : [["overview", "Overview"], ["transactions", "Transactions"], ["activity", "Activity"]]) as readonly (readonly [string, string])[];
  const toggle = async () => { try { await api(`/${c.path}/${id}`, { method: "PATCH", body: { status: d.status === "active" ? "inactive" : "active" } }); toast("Status updated"); reload(); act.reload(); } catch (e: any) { toast(e.message, "err"); } };
  const remove = async () => { try { await api(`/${c.path}/${id}`, { method: "DELETE" }); toast(`${c.label} deleted`); go(`/${c.path}`); } catch (e: any) { toast(e.message, "err"); } };
  const KV = ({ k, v }: { k: string; v: React.ReactNode }) => <div className="flex justify-between gap-3 py-1.5 text-[13px]"><dt className="text-sub">{k}</dt><dd className="text-right font-medium">{v}</dd></div>;
  const verb: Record<string, string> = { create: "Created", update: "Updated", delete: "Deleted" };
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-[13px] text-sub"><Link to={`/${c.path}`} className="hover:text-ink">{c.plural}</Link><span>/</span><span className="text-ink">{d.name}</span></div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div><div className="flex items-center gap-2"><h1 className="text-lg font-semibold">{d.name}</h1><span className="text-[13px] text-sub">{d.code}</span><StatusDot active={d.status === "active"} /></div>{d.company_name && <p className="text-[13px] text-sub">{d.company_name}</p>}</div>
        {w && <div className="flex items-center gap-2">{kind === "vendor" && <Link className="btn-primary" to={`/purchase-orders/new?vendor=${id}`}><Plus className="h-3.5 w-3.5" />New purchase order</Link>}{kind === "customer" && <Link className="btn-primary" to={`/sales-orders/new?customer=${id}`}><Plus className="h-3.5 w-3.5" />New sales order</Link>}<button className="btn-ghost" onClick={() => go(`/${c.path}/${id}/edit`)}><Pencil className="h-3.5 w-3.5" />Edit</button><div className="rounded-md border bg-surface"><RowMenu items={[{ label: d.status === "active" ? "Mark inactive" : "Mark active", icon: Power, onClick: toggle }, { label: "Delete", icon: Trash2, onClick: () => setDel(true), danger: true }]} /></div></div>}
      </div>
      {kind === "vendor" && <VendorStatsStrip id={id} />}
      {kind === "customer" && <CustomerStatsStrip id={id} />}
      <TabBar tabs={tabs} active={tab} onChange={(k) => setSp(k === "overview" ? {} : { tab: k })} />
      <div key={tab} className="anim-up">
        {tab === "overview" && (
          <div className="grid gap-3 lg:grid-cols-3">
            <section className="card"><h3 className="border-b px-3 py-2 text-[13px] font-semibold">Contact</h3><dl className="space-y-1.5 p-3 text-[13px]">
              {d.contact_person && <p className="flex gap-2"><Mail className="mt-0.5 h-3.5 w-3.5 shrink-0 text-sub" />{d.contact_person}</p>}
              <p className="flex gap-2"><Mail className="mt-0.5 h-3.5 w-3.5 shrink-0 text-sub" />{d.email ? <a className="text-brand hover:underline" href={`mailto:${d.email}`}>{d.email}</a> : <span className="text-sub">No email</span>}</p>
              <p className="flex gap-2"><Phone className="mt-0.5 h-3.5 w-3.5 shrink-0 text-sub" />{d.phone ? <a className="text-brand hover:underline" href={`tel:${d.phone}`}>{d.phone}</a> : <span className="text-sub">No phone</span>}</p>
              <p className="pt-1"><span className="text-sub">GSTIN </span><b>{d.gstin || "—"}</b></p></dl></section>
            <section className="card"><h3 className="border-b px-3 py-2 text-[13px] font-semibold">Addresses</h3><div className="space-y-3 p-3 text-[13px]">
              <div><p className="text-[11px] text-sub">Billing</p><p className="flex gap-2"><MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0 text-sub" />{addrOf(d, "bill") || <span className="text-sub">Not set</span>}</p></div>
              {kind === "customer" && <div><p className="text-[11px] text-sub">Shipping</p><p className="flex gap-2"><MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0 text-sub" />{addrOf(d, "ship") || <span className="text-sub">Same as billing</span>}</p></div>}</div></section>
            <section className="card"><h3 className="border-b px-3 py-2 text-[13px] font-semibold">Terms</h3><dl className="divide-y p-3"><KV k="Payment terms" v={d.payment_terms === 0 ? "Due on receipt" : `Net ${d.payment_terms} days`} />
              {kind === "customer" && <><KV k="Customer type" v={<span className="capitalize">{d.customer_type}</span>} /><KV k="Credit limit" v={d.credit_limit ? money(d.credit_limit) : "None"} /></>}
              {kind === "vendor" && <><KV k="Items supplied" v={fmt(d.items_supplied)} /><KV k="Bank" v={d.bank_name || "—"} /><KV k="Account" v={d.bank_account ? <span className="font-mono text-xs">{d.bank_account}</span> : "—"} /><KV k="IFSC" v={d.bank_ifsc ? <span className="font-mono text-xs">{d.bank_ifsc}</span> : "—"} /></>}
            </dl>{d.bank_masked && <p className="border-t px-3 py-2 text-xs text-sub">Bank details are partly hidden for your role.</p>}{d.notes && <p className="border-t p-3 text-[13px] text-sub">{d.notes}</p>}</section>
          </div>)}
        {tab === "overview" && kind === "vendor" && <div className="mt-3"><PerformanceCard id={id} /></div>}
        {tab === "overview" && kind === "customer" && <div className="mt-3"><CustomerInsights id={id} /></div>}
        {tab === "transactions" && kind === "vendor" && <VendorTransactions id={id} />}
        {tab === "transactions" && kind === "customer" && <CustomerTransactions id={id} />}
        {tab === "items" && <div className="card">{items.loading && !items.data ? <Skeleton rows={3} /> : !items.data?.length ? <Empty title="No items linked yet" hint="Set this vendor as the preferred vendor on an item to list it here." /> :
          <table className="w-full"><thead className="border-b bg-muted/60"><tr>{["Item", "SKU", "Unit", "Purchase price"].map((h, i) => <th key={h} className={`th ${i === 3 ? "text-right" : ""}`}>{h}</th>)}</tr></thead><tbody className="divide-y">{items.data.map((p: any) => <tr key={p.id} className="hover:bg-muted/60"><td className="td"><Link className="font-medium text-brand hover:underline" to={`/products/${p.id}`}>{p.name}</Link></td><td className="td text-sub">{p.sku}</td><td className="td">{p.unit}</td><td className="td text-right tabular-nums">{money(p.purchase_price)}</td></tr>)}</tbody></table>}</div>}
        {tab === "activity" && <div className="card p-4">{act.loading && !act.data ? <Skeleton rows={3} /> : <ol className="relative space-y-4 before:absolute before:bottom-2 before:left-[7px] before:top-2 before:w-px before:bg-line">{(act.data || []).map((a: any, i: number) => (
          <li key={i} className="relative flex gap-3 pl-0"><span className="relative z-10 mt-1 h-3.5 w-3.5 shrink-0 rounded-full border-2 border-brand bg-surface" /><div><p className="text-[13px] font-medium">{verb[a.action] || a.action}{a.detail?.fields?.length ? <span className="font-normal text-sub"> — {a.detail.fields.join(", ")}</span> : null}</p><p className="text-xs text-sub">{dt(a.when)}{a.user ? ` · ${a.user}` : ""}</p></div></li>))}</ol>}</div>}
      </div>
      {del && <Confirm title={`Delete ${c.label.toLowerCase()}`} text={`Delete ${d.name}? This can't be undone, and ${c.label.toLowerCase()}s with transactions can't be deleted.`} action="Delete" onConfirm={remove} onClose={() => setDel(false)} />}
    </div>
  );
}
