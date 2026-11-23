import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Activity, Check, Copy, Eye, LogIn, KeyRound, Lock, Pencil, Plus, Search, ShieldCheck, UserCheck, UserX } from "lucide-react";
import { api, dt } from "../api";
import { useMe } from "../App";
import { pwProblem } from "../Auth";
import { Badge, Confirm, Empty, Field, Modal, Skeleton, useLoad, useToast } from "../ui";

type Meta = { modules: { key: string; label: string; view_only: boolean }[]; actions: string[]; roles: { key: string; admin: boolean; defaults: Record<string, string[]> }[] };
type Perms = Record<string, string[]>;
const ROLE_LABEL: Record<string, string> = { user: "User (customer portal)", owner: "Owner (administrator)", admin: "Administrator", manager: "Manager", warehouse: "Warehouse staff", sales: "Sales", accountant: "Accountant", viewer: "Viewer (read-only staff)" };
const day = (s?: string) => (s ? new Date(s).toLocaleDateString("en-IN", { dateStyle: "medium" }) : "—");

function PermMatrix({ meta, value, onChange, disabled }: { meta: Meta; value: Perms; onChange: (p: Perms) => void; disabled?: boolean }) {
  const toggle = (m: string, a: string) => {
    const cur = new Set(value[m] || []);
    if (cur.has(a)) { cur.delete(a); if (a === "view") cur.clear(); } else { cur.add(a); cur.add("view"); }
    const next = { ...value, [m]: meta.actions.filter((x) => cur.has(x)) }; if (!next[m].length) delete next[m]; onChange(next);
  };
  return (
    <div className="overflow-x-auto rounded-lg border">
      <table className="w-full text-[13px]"><thead className="bg-muted/50"><tr><th className="th">Module</th>{meta.actions.map((a) => <th key={a} className="th text-center capitalize">{a}</th>)}</tr></thead>
        <tbody className="divide-y">{meta.modules.map((m) => <tr key={m.key}><td className="td font-medium">{m.label}</td>
          {meta.actions.map((a) => { const locked = m.view_only && a !== "view"; return <td key={a} className="td text-center">
            <input type="checkbox" disabled={disabled || locked} title={locked ? "Only administrators can manage users" : ""} aria-label={`${m.label} ${a}`} data-perm={`${m.key}:${a}`} checked={(value[m.key] || []).includes(a)} onChange={() => toggle(m.key, a)} /></td>; })}</tr>)}</tbody></table>
    </div>
  );
}

function UserForm({ meta, user, onClose, onSaved }: { meta: Meta; user?: any; onClose: () => void; onSaved: (r?: any) => void }) {
  const toast = useToast(); const { me } = useMe(); const edit = !!user;
  const [f, setF] = useState({ name: user?.name || "", email: user?.email || "", phone: user?.phone || "", department: user?.department || "", role: user?.role || "user", is_active: user?.is_active ?? true });
  const [gen, setGen] = useState(true); const [pw, setPw] = useState(""); const [mustChange, setMustChange] = useState(true);
  const detail = useLoad(() => (edit ? api(`/users/${user.id}`) : Promise.resolve(null)), [user?.id]);
  const [custom, setCustom] = useState<Perms | null | undefined>(undefined);   // undefined = untouched
  const isAdminRole = meta.roles.find((r) => r.key === f.role)?.admin;
  const template = meta.roles.find((r) => r.key === f.role)?.defaults || {};
  const current: Perms | null = custom !== undefined ? custom : (detail.data?.permissions ?? null);
  const [busy, setBusy] = useState(false); const [err, setErr] = useState("");
  const self = edit && user.id === me.id;
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setErr("");
    if (!edit && !gen && pwProblem(pw)) { setErr(pwProblem(pw)); return; }
    setBusy(true);
    try {
      if (edit) {
        const body: any = { name: f.name, phone: f.phone, department: f.department };
        if (!self) { body.role = f.role; body.is_active = f.is_active; if (!isAdminRole && custom !== undefined) { if (custom === null) body.reset_permissions = true; else body.permissions = custom; } }
        await api(`/users/${user.id}`, { method: "PATCH", body }); toast("User updated"); onSaved();
      } else {
        const body: any = { ...f, email: f.email.trim(), must_change_password: mustChange };
        if (!gen) body.password = pw; if (!isAdminRole && custom) body.permissions = custom;
        const r = await api("/users", { body }); toast("User created"); onSaved(r.temporary_password ? { email: f.email, temporary_password: r.temporary_password } : undefined);
      }
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  return (
    <Modal title={edit ? `Edit ${user.name}` : "Add user"} onClose={onClose} wide>
      <form onSubmit={submit} className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Full name"><input required className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <Field label="E-mail address"><input required type="email" disabled={edit} className="input" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
          <Field label="Phone number"><input className="input" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></Field>
          <Field label="Department"><input className="input" value={f.department} onChange={(e) => setF({ ...f, department: e.target.value })} /></Field>
          <Field label="Role"><select className="input" disabled={self} value={f.role} onChange={(e) => { setF({ ...f, role: e.target.value }); setCustom(undefined); }}>
            {meta.roles.filter((r) => r.key !== "owner" || me.role === "owner" || user?.role === "owner").map((r) => <option key={r.key} value={r.key}>{ROLE_LABEL[r.key] || r.key}</option>)}</select></Field>
          <Field label="Account status"><select className="input" disabled={self} value={f.is_active ? "1" : "0"} onChange={(e) => setF({ ...f, is_active: e.target.value === "1" })}><option value="1">Active</option><option value="0">Inactive</option></select></Field>
        </div>
        {!edit && <div className="space-y-2 rounded-lg border p-3">
          <label className="flex items-center gap-2 text-[13px]"><input type="checkbox" checked={gen} onChange={(e) => setGen(e.target.checked)} />Generate a secure temporary password (shown once after saving)</label>
          {!gen && <><Field label="Temporary password"><input className="input" type="text" autoComplete="off" value={pw} onChange={(e) => setPw(e.target.value)} /></Field>
            <label className="flex items-center gap-2 text-[13px]"><input type="checkbox" checked={mustChange} onChange={(e) => setMustChange(e.target.checked)} />Require a new password at first sign-in</label></>}
        </div>}
        <div>
          <div className="mb-1 flex items-center justify-between"><span className="label !mb-0">Module permissions</span>
            {!isAdminRole && <label className="flex items-center gap-2 text-[13px]"><input type="checkbox" checked={current !== null} onChange={(e) => setCustom(e.target.checked ? { ...template } : null)} />Customise for this user</label>}</div>
          {isAdminRole ? <p className="rounded-lg bg-muted p-3 text-[13px] text-sub"><ShieldCheck className="mr-1 inline h-4 w-4 text-brand" />Administrators always have full access to every module, including user management and settings.</p>
            : current === null ? <><p className="mb-2 text-xs text-sub">Using the <b>{ROLE_LABEL[f.role] || f.role}</b> role template. Tick "Customise" to set exact actions.</p><PermMatrix meta={meta} value={template} onChange={() => {}} disabled /></>
              : <PermMatrix meta={meta} value={current} onChange={(p) => setCustom(p)} />}
        </div>
        {err && <p role="alert" className="rounded-lg bg-red-500/10 p-2 text-sm text-red-600">{err}</p>}
        <div className="flex justify-end gap-2"><button type="button" className="btn-ghost" onClick={onClose}>Cancel</button><button className={`btn-primary ${busy ? "btn-loading" : ""}`} disabled={busy}>{edit ? "Save changes" : "Create user"}</button></div>
      </form>
    </Modal>
  );
}

function Secret({ title, intro, label, value, onClose }: { title: string; intro: string; label: string; value: string; onClose: () => void }) {
  const [done, setDone] = useState(false);
  return (
    <Modal title={title} onClose={onClose}>
      <p className="mb-3 text-[13px] text-sub">{intro}</p>
      <label className="label">{label}</label>
      <div className="flex gap-2"><input readOnly className="input font-mono text-[13px]" value={value} onFocus={(e) => e.target.select()} aria-label={label} />
        <button className="btn-ghost" onClick={async () => { try { await navigator.clipboard.writeText(value); setDone(true); } catch { /* clipboard blocked */ } }}>{done ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}Copy</button></div>
      <p className="mt-3 text-xs text-amber-600">This is shown only once. It is not stored in readable form.</p>
      <div className="mt-4 flex justify-end"><button className="btn-primary" onClick={onClose}>Done</button></div>
    </Modal>
  );
}

function ResetModal({ user, onClose, onDone }: { user: any; onClose: () => void; onDone: (s: { title: string; intro: string; label: string; value: string }) => void }) {
  const [busy, setBusy] = useState(false); const toast = useToast(); 
  const run = async (mode: "link" | "temporary") => {
    setBusy(true);
    try {
      const r = await api(`/users/${user.id}/reset-password`, { body: { mode } });
      onDone(mode === "link" ? { title: "Reset link created", intro: `Send this one-time link to ${user.name}. It expires in ${r.expires_hours} hours and works once.`, label: "Reset link", value: `${location.origin}${r.path}` }
        : { title: "Temporary password set", intro: `${user.name} was signed out everywhere and must choose a new password at next sign-in.`, label: "Temporary password", value: r.temporary_password });
    } catch (e: any) { toast(e.message, "err"); setBusy(false); }
  };
  return (
    <Modal title={`Reset password — ${user.name}`} onClose={onClose}>
      <p className="mb-4 text-[13px] text-sub">No e-mail is sent by StockPilot, so you deliver the credential yourself.</p>
      <div className="space-y-2">
        <button disabled={busy} className="card w-full p-3 text-left hover:bg-muted" onClick={() => run("link")}><p className="font-medium">Create a one-time reset link</p><p className="text-xs text-sub">The user picks their own new password. Valid for 24 hours, single use.</p></button>
        <button disabled={busy} className="card w-full p-3 text-left hover:bg-muted" onClick={() => run("temporary")}><p className="font-medium">Set a temporary password now</p><p className="text-xs text-sub">Signs the user out everywhere. They must change it at next sign-in.</p></button>
      </div>
    </Modal>
  );
}

export default function UsersPage() {
  const { me } = useMe(); const toast = useToast(); const admin = me.is_admin;
  const [sp, setSp] = useSearchParams(); const nav = useNavigate(); const tab = sp.get("tab") === "audit" ? "audit" : "users";
  const users = useLoad(() => api("/users")); const logs = useLoad(() => api("/audit-logs"), []);
  const meta = useLoad<Meta | null>(() => (admin ? api("/permissions/meta") : Promise.resolve(null)));
  const [q, setQ] = useState(""); const [roleF, setRoleF] = useState(""); const [statusF, setStatusF] = useState("");
  const [form, setForm] = useState<null | { user?: any }>(null); const [view, setView] = useState<any>(null); const [reset, setReset] = useState<any>(null);
  const [secret, setSecret] = useState<any>(null); const [confirm, setConfirm] = useState<any>(null); const [activity, setActivity] = useState<any>(null);
  const [page, setPage] = useState(1);
  const dir = useLoad(() => (admin ? api(`/users/directory?page=${page}&page_size=15${q ? `&q=${encodeURIComponent(q)}` : ""}${roleF ? `&role=${roleF}` : ""}${statusF ? `&status=${statusF}` : ""}`) : Promise.resolve(null)), [admin, page, q, roleF, statusF]);
  const legacy = useMemo(() => (users.data || []).filter((u: any) => (!q || `${u.name} ${u.email} ${u.department || ""}`.toLowerCase().includes(q.toLowerCase())) && (!roleF || u.role === roleF) && (!statusF || (statusF === "active" ? u.is_active : !u.is_active))), [users.data, q, roleF, statusF]);
  const rows: any[] = admin ? (dir.data?.items || []) : legacy;
  const reqs = useLoad<any[]>(() => (admin ? api("/password-requests") : Promise.resolve([])), [admin]);
  const reloadAll = () => { users.reload(); dir.reload(); logs.reload(); reqs.reload(); window.dispatchEvent(new Event("sp-requests-changed")); };
  const dismiss = async (u: any) => { try { await api(`/password-requests/${u.id}/dismiss`, { method: "POST" }); toast("Request dismissed"); reloadAll(); } catch (e: any) { toast(e.message, "err"); } };
  const setActive = async (u: any, on: boolean) => { try { await api(`/users/${u.id}`, { method: "PATCH", body: { is_active: on } }); toast(on ? "User activated" : "User deactivated and signed out"); reloadAll(); } catch (e: any) { toast(e.message, "err"); } };
  const openActivity = async (u: any) => { try { setActivity({ user: u, rows: await api(`/users/${u.id}/activity`) }); } catch (e: any) { toast(e.message, "err"); } };
  const unlock = async (u: any) => { try { await api(`/users/${u.id}/unlock`, { method: "POST" }); toast("Account unlocked"); reloadAll(); } catch (e: any) { toast(e.message, "err"); } };
  const names = useMemo(() => Object.fromEntries((users.data || []).map((u: any) => [u.id, u.name])), [users.data]);
  const IconBtn = ({ label, onClick, children, danger }: { label: string; onClick: () => void; children: React.ReactNode; danger?: boolean }) => <button type="button" aria-label={label} title={label} onClick={onClick} className={`rounded p-1.5 transition-colors hover:bg-muted ${danger ? "text-red-600" : "text-sub hover:text-brand"}`}>{children}</button>;
  return (
    <div className="space-y-4" data-testid="user-management">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div><h1 className="text-xl font-semibold">{admin ? "User management" : "Team & audit"}</h1><p className="text-[13px] text-sub">{admin ? "Create accounts, assign roles and decide exactly what each person can do." : "Read-only view of the team."}</p></div>
        {admin && <button className="btn-primary" onClick={() => setForm({})}><Plus className="h-4 w-4" />Add user</button>}</div>
      <div className="flex gap-1 border-b">{(["users", "audit"] as const).map((t) => <button key={t} onClick={() => setSp(t === "users" ? {} : { tab: t })} className={`-mb-px border-b-2 px-3 py-2 text-[14px] font-medium ${tab === t ? "border-brand text-brand" : "border-transparent text-sub hover:text-ink"}`}>{t === "users" ? `Users${admin ? (dir.data ? ` (${dir.data.total})` : "") : (users.data ? ` (${users.data.length})` : "")}` : "Audit log"}</button>)}</div>
      {tab === "users" ? <>
        {admin && !!reqs.data?.length && <section className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-4" data-testid="reset-requests" role="region" aria-label="Password reset requests">
          <h2 className="mb-2 flex items-center gap-2 text-[13px] font-semibold"><KeyRound className="h-4 w-4 text-amber-600" />Password reset requests waiting for approval ({reqs.data.length})</h2>
          <ul className="divide-y divide-amber-500/20">{reqs.data.map((r: any) => <li key={r.id} className="flex flex-wrap items-center gap-3 py-2 text-[13px]" data-request={r.email}>
            <span className="min-w-48 flex-1"><b className="font-medium">{r.name}</b><span className="block text-xs text-sub">{r.email} · requested {dt(r.requested_at)}</span></span>
            <button className="btn-primary !py-1" aria-label={`Approve password reset for ${r.email}`} onClick={() => setReset(r)}>Approve</button>
            <button className="btn-ghost !py-1" aria-label={`Dismiss password reset for ${r.email}`} onClick={() => dismiss(r)}>Dismiss</button></li>)}</ul>
          <p className="mt-2 text-xs text-sub">Approving lets you create a one-time reset link (or a temporary password) to give to the user. Dismiss if the request was not genuine.</p></section>}
        <div className="flex flex-wrap gap-2">
          <div className="relative min-w-56 flex-1"><Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-sub" /><input className="input !pl-9" placeholder="Search name, e-mail, department" aria-label="Search users" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} /></div>
          <select className="input !w-auto" aria-label="Filter by role" value={roleF} onChange={(e) => { setRoleF(e.target.value); setPage(1); }}><option value="">All roles</option><option value="admin">Administrators (ADMIN)</option><option value="user">Users (USER)</option>{Object.keys(ROLE_LABEL).map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}</select>
          <select className="input !w-auto" aria-label="Filter by status" value={statusF} onChange={(e) => { setStatusF(e.target.value); setPage(1); }}><option value="">Any status</option><option value="active">Active</option><option value="inactive">Inactive</option></select></div>
        <div className="card overflow-x-auto">{(admin ? dir.loading && !dir.data : users.loading) ? <Skeleton rows={5} /> : (admin ? dir.error : users.error) ? <p className="p-4 text-red-500">{admin ? dir.error : users.error}</p> : !rows.length ? <Empty title="No users match" /> :
          <table className="w-full"><thead className="border-b bg-muted/50"><tr>{["User", "ID", "Role", "Department", "Phone", "Status", "Last login", "Logins", "Last active", "Created", ...(admin ? ["Actions"] : [])].map((h) => <th key={h} className="th whitespace-nowrap">{h}</th>)}</tr></thead>
            <tbody className="divide-y">{rows.map((u: any) => <tr key={u.id} data-user={u.email}>
              <td className="td"><div className="font-medium">{u.name}</div><div className="text-xs text-sub">{u.email}</div></td>
              <td className="td tabular-nums text-sub">#{u.id}</td>
              <td className="td"><div className="flex flex-wrap items-center gap-1"><Badge tone={u.is_admin ? "info" : "neutral"}>{u.is_admin ? "ADMIN" : "USER"}</Badge><span className="text-xs capitalize text-sub">{u.role}</span>{u.custom_permissions && <Badge tone="warn">custom</Badge>}</div></td>
              <td className="td">{u.department || "—"}</td><td className="td">{u.phone || "—"}</td>
              <td className="td"><div className="flex flex-wrap gap-1">{u.is_active ? <Badge tone="ok">Active</Badge> : <Badge tone="bad">Inactive</Badge>}{u.locked && <Badge tone="warn">Locked</Badge>}{u.reset_requested_at && <Badge tone="warn">Reset requested</Badge>}</div></td>
              <td className="td whitespace-nowrap text-sub">{u.last_login ? dt(u.last_login) : "Never"}</td><td className="td tabular-nums">{u.login_count ?? "—"}</td><td className="td whitespace-nowrap text-sub">{u.last_active ? dt(u.last_active) : "—"}</td><td className="td whitespace-nowrap text-sub">{day(u.created_at)}</td>
              {admin && <td className="td"><div className="flex items-center">
                <IconBtn label="View user" onClick={() => setView(u)}><Eye className="h-4 w-4" /></IconBtn>
                <IconBtn label="Edit user" onClick={() => setForm({ user: u })}><Pencil className="h-4 w-4" /></IconBtn>
                {!u.is_admin && <IconBtn label="Manage permissions" onClick={() => setForm({ user: u })}><ShieldCheck className="h-4 w-4" /></IconBtn>}
                {u.id !== me.id && (u.is_active ? <IconBtn danger label="Deactivate user" onClick={() => setConfirm({ title: "Deactivate user", text: `${u.name} will be signed out immediately and will not be able to sign in until reactivated.`, action: "Deactivate", run: () => setActive(u, false) })}><UserX className="h-4 w-4" /></IconBtn> : <IconBtn label="Activate user" onClick={() => setActive(u, true)}><UserCheck className="h-4 w-4" /></IconBtn>)}
                <IconBtn label="Reset password" onClick={() => setReset(u)}><KeyRound className="h-4 w-4" /></IconBtn>
                {u.locked && <IconBtn label="Unlock account" onClick={() => unlock(u)}><Lock className="h-4 w-4" /></IconBtn>}
                <IconBtn label="View login sessions" onClick={() => nav(`/login-activity?user=${u.id}`)}><LogIn className="h-4 w-4" /></IconBtn>
                <IconBtn label="View activity history" onClick={() => openActivity(u)}><Activity className="h-4 w-4" /></IconBtn></div></td>}
            </tr>)}</tbody></table>}</div>
        {admin && dir.data && dir.data.total > 0 && <div className="flex items-center justify-between text-[13px] text-sub"><span>{dir.data.total} account{dir.data.total === 1 ? "" : "s"}</span><span className="flex items-center gap-2"><button className="btn-ghost !px-2" aria-label="Previous page" disabled={page <= 1} onClick={() => setPage(page - 1)}>‹</button>Page {page} of {Math.max(1, Math.ceil(dir.data.total / dir.data.page_size))}<button className="btn-ghost !px-2" aria-label="Next page" disabled={page >= Math.ceil(dir.data.total / dir.data.page_size)} onClick={() => setPage(page + 1)}>›</button></span></div>}</> :
        <div className="card overflow-x-auto">{logs.loading ? <Skeleton rows={5} /> : <table className="w-full"><thead className="border-b bg-muted/50"><tr>{["When", "User", "Action", "Entity", "Detail"].map((h) => <th key={h} className="th">{h}</th>)}</tr></thead>
          <tbody className="divide-y">{logs.data?.map((a: any) => <tr key={a.id}><td className="td whitespace-nowrap">{dt(a.created_at)}</td><td className="td">{names[a.user_id] || a.user_id || "system"}</td><td className="td">{a.action.replace(/_/g, " ")}</td><td className="td">{a.entity} {a.entity_id}</td><td className="td max-w-xs truncate text-xs text-sub">{a.detail ? JSON.stringify(a.detail) : ""}</td></tr>)}</tbody></table>}</div>}

      {form && meta.data && <UserForm meta={meta.data} user={form.user} onClose={() => setForm(null)} onSaved={(r) => { setForm(null); reloadAll(); if (r) setSecret({ title: "User created", intro: `Give ${r.email} this temporary password. They must choose a new one at first sign-in.`, label: "Temporary password", value: r.temporary_password }); }} />}
      {view && <ViewModal u={view} onClose={() => setView(null)} />}
      {reset && <ResetModal user={reset} onClose={() => setReset(null)} onDone={(s) => { setReset(null); setSecret(s); reloadAll(); }} />}
      {secret && <Secret {...secret} onClose={() => setSecret(null)} />}
      {confirm && <Confirm title={confirm.title} text={confirm.text} action={confirm.action} onConfirm={confirm.run} onClose={() => setConfirm(null)} />}
      {activity && <Modal title={`Activity — ${activity.user.name}`} onClose={() => setActivity(null)} wide>{!activity.rows.length ? <Empty title="No activity recorded" /> :
        <ul className="max-h-[60vh] divide-y overflow-y-auto">{activity.rows.map((a: any) => <li key={a.id} className="flex gap-3 py-2 text-[13px]"><span className="w-36 shrink-0 text-xs text-sub">{dt(a.created_at)}</span><span><b className="font-medium">{a.action.replace(/_/g, " ")}</b> <span className="text-sub">{a.entity}{a.entity_id ? ` #${a.entity_id}` : ""}{a.by_id !== activity.user.id && a.by ? ` — by ${a.by}` : ""}</span></span></li>)}</ul>}</Modal>}
    </div>
  );
}

function ViewModal({ u, onClose }: { u: any; onClose: () => void }) {
  const d = useLoad(() => api(`/users/${u.id}`), [u.id]);
  const meta = useLoad<Meta>(() => api("/permissions/meta"));
  return (
    <Modal title={u.name} onClose={onClose} wide>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-[13px]">{[["User ID", `#${u.id}`], ["E-mail", u.email], ["Role", ROLE_LABEL[u.role] || u.role], ["Status", u.is_active ? "Active" : "Inactive"], ["Department", u.department || "—"], ["Phone", u.phone || "—"], ["Last login", u.last_login ? dt(u.last_login) : "Never"], ["Created", day(u.created_at)]].map(([k, v]) => <div key={k}><dt className="text-xs text-sub">{k}</dt><dd className="font-medium">{v}</dd></div>)}</dl>
      <h3 className="mb-1 mt-4 text-[13px] font-semibold">Effective permissions {d.data?.custom_permissions ? "(customised)" : "(role template)"}</h3>
      {u.is_admin ? <p className="text-[13px] text-sub">Full access to every module.</p> : d.data && meta.data ? <PermMatrix meta={meta.data} value={d.data.effective} onChange={() => {}} disabled /> : <Skeleton rows={3} />}
    </Modal>
  );
}
