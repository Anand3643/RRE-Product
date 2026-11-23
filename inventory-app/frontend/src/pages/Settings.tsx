import { useEffect, useState } from "react";
import { api } from "../api";
import { useMe } from "../App";
import { SuccessCheck } from "../fx";
import { Skeleton, useLoad, useToast } from "../ui";

const STATES = ["Andaman and Nicobar Islands", "Andhra Pradesh", "Arunachal Pradesh", "Assam", "Bihar", "Chandigarh", "Chhattisgarh", "Dadra and Nagar Haveli and Daman and Diu", "Delhi", "Goa", "Gujarat", "Haryana", "Himachal Pradesh", "Jammu and Kashmir", "Jharkhand", "Karnataka", "Kerala", "Ladakh", "Lakshadweep", "Madhya Pradesh", "Maharashtra", "Manipur", "Meghalaya", "Mizoram", "Nagaland", "Odisha", "Puducherry", "Punjab", "Rajasthan", "Sikkim", "Tamil Nadu", "Telangana", "Tripura", "Uttar Pradesh", "Uttarakhand", "West Bengal"];
const GSTIN = /^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]$/;

export default function Settings() {
  const { me, can } = useMe(); const toast = useToast(); const w = can("settings", "w"); const owner = ["owner", "admin"].includes(me.role);
  const { data, loading, reload } = useLoad(() => api("/organization"));
  const [f, setF] = useState<any>({ name: "", gstin: "", state: "", address: "", allow_negative_stock: false }); const [errs, setErrs] = useState<Record<string, string>>({}); const [busy, setBusy] = useState(false); const [ok, setOk] = useState(false);
  useEffect(() => { if (data) setF({ name: data.name, gstin: data.gstin || "", state: data.state || "", address: data.address || "", allow_negative_stock: data.allow_negative_stock }); }, [data]);
  const validate = () => { const e: Record<string, string> = {}; if (f.name.trim().length < 2) e.name = "Organization name is required"; if (f.gstin && !GSTIN.test(f.gstin.toUpperCase())) e.gstin = "GSTIN format is 27ABCDE1234F1Z5"; setErrs(e); return !Object.keys(e).length; };
  const save = async (e: React.FormEvent) => {
    e.preventDefault(); if (!validate()) return; setBusy(true);
    try { const body: any = { name: f.name.trim(), gstin: f.gstin ? f.gstin.toUpperCase() : null, state: f.state || null, address: f.address || null }; if (owner) body.allow_negative_stock = f.allow_negative_stock; await api("/organization", { method: "PATCH", body }); window.dispatchEvent(new Event("sp-me-changed")); toast("Settings saved"); setOk(true); setTimeout(() => setOk(false), 1400); reload(); }
    catch (er: any) { toast(er.message, "err"); } finally { setBusy(false); }
  };
  if (loading && !data) return <div className="card"><Skeleton rows={6} /></div>;
  const R = ({ label, error, note, children }: { label: string; error?: string; note?: string; children: React.ReactNode }) => <div className="grid items-start gap-1 sm:grid-cols-[12rem_1fr] sm:gap-4"><label className="pt-1.5 text-[13px]">{label}</label><div>{children}<p className={`mt-1 min-h-[1rem] text-xs ${error ? "text-red-600" : "text-sub"}`}>{error || note || ""}</p></div></div>;
  return (
    <form onSubmit={save} className="space-y-3" noValidate>
      <h1 className="text-lg font-semibold">Settings</h1>
      <section className="card max-w-3xl"><h2 className="border-b px-5 py-2.5 text-[13px] font-semibold">Organization profile</h2><div className="space-y-1 p-5">
        <R label="Organization name" error={errs.name}><input disabled={!w} className={`input ${errs.name ? "input-error" : ""}`} maxLength={200} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></R>
        <R label="GSTIN" error={errs.gstin} note="Printed on purchase and sales documents. Its first two digits decide CGST+SGST vs IGST."><input disabled={!w} className={`input uppercase sm:max-w-sm ${errs.gstin ? "input-error" : ""}`} maxLength={15} value={f.gstin} onChange={(e) => setF({ ...f, gstin: e.target.value })} /></R>
        <R label="State" note="Used when a GSTIN isn't available to decide the tax treatment."><input disabled={!w} list="states" className="input sm:max-w-sm" value={f.state} onChange={(e) => setF({ ...f, state: e.target.value })} /><datalist id="states">{STATES.map((s) => <option key={s} value={s} />)}</datalist></R>
        <R label="Address"><textarea disabled={!w} className="input min-h-[64px]" maxLength={300} value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} /></R>
      </div></section>
      <section className="card max-w-3xl"><h2 className="border-b px-5 py-2.5 text-[13px] font-semibold">Stock policy</h2><div className="p-5">
        <label className={`flex items-start gap-3 text-[13px] ${owner && w ? "" : "opacity-60"}`}><input type="checkbox" className="mt-0.5" disabled={!owner || !w} checked={f.allow_negative_stock} onChange={(e) => setF({ ...f, allow_negative_stock: e.target.checked })} /><span><b>Allow negative stock</b><span className="block text-sub">When off (recommended), no transaction can take available stock below zero. Only an owner or admin can change this.</span></span></label></div></section>
      {w ? <div className="flex max-w-3xl items-center gap-3"><button className={`btn-primary ${busy ? "btn-loading" : ""}`} disabled={busy}>Save settings</button>{ok && <span className="flex items-center gap-1.5 text-[13px] text-emerald-600"><SuccessCheck size={22} />Saved</span>}</div> : <p className="text-[13px] text-sub">You have read-only access to settings.</p>}
    </form>
  );
}