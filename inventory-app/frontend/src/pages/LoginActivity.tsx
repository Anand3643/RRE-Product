import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { AlertTriangle, ChevronLeft, ChevronRight, Download, Eye, Laptop, ShieldAlert, Smartphone, Tablet, XCircle } from "lucide-react";
import { api, dt, download } from "../api";
import { Badge, Confirm, Empty, Modal, Skeleton, useLoad, useToast } from "../ui";

export const tzOffset = () => -new Date().getTimezoneOffset();
const STATE: Record<string, { label: string; tone: "ok" | "warn" | "neutral" | "bad" | "info"; dot: string }> = {
  active: { label: "Active", tone: "ok", dot: "bg-emerald-500" },
  inactive: { label: "Inactive", tone: "warn", dot: "bg-amber-500" },
  logged_out: { label: "Logged out", tone: "neutral", dot: "bg-slate-400" },
  terminated: { label: "Ended by admin", tone: "neutral", dot: "bg-slate-400" },
  expired: { label: "Expired", tone: "neutral", dot: "bg-slate-400" },
};
const CATEGORY: Record<string, string> = { unknown_account: "Unknown account", wrong_password: "Wrong password", account_locked: "Account locked", account_deactivated: "Account deactivated", throttled: "Too many attempts" };
export const duration = (s: number) => (s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`);
export const DeviceIcon = ({ t }: { t: string }) => (t === "Mobile" ? <Smartphone className="h-4 w-4" /> : t === "Tablet" ? <Tablet className="h-4 w-4" /> : <Laptop className="h-4 w-4" />);

export function StateBadge({ row }: { row: { state: string; suspicious?: boolean; suspicious_reason?: string | null } }) {
  const s = STATE[row.state] || STATE.expired;
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <span className="inline-flex items-center gap-1.5"><span className={`h-2 w-2 rounded-full ${s.dot}`} /><Badge tone={s.tone}>{s.label}</Badge></span>
      {row.suspicious && <span title={row.suspicious_reason || ""}><Badge tone="bad">Suspicious</Badge></span>}
    </span>
  );
}

/** Shared by the admin dashboard and the history page. Everything shown comes from user_sessions / login_audit_logs. */
export function UserLoginDetail({ userId, onClose, onChanged }: { userId: number; onClose: () => void; onChanged?: () => void }) {
  const toast = useToast();
  const d = useLoad(() => api(`/monitor/users/${userId}`), [userId]);
  const [confirm, setConfirm] = useState<any>(null);
  const kill = async (s: any) => { try { await api(`/monitor/sessions/${s.id}/terminate`, { method: "POST" }); toast("Session terminated"); d.reload(); onChanged?.(); } catch (e: any) { toast(e.message, "err"); } };
  const p = d.data?.profile;
  return (
    <Modal title={p ? p.name : "User details"} onClose={onClose} wide>
      {d.loading && !d.data ? <Skeleton rows={6} /> : d.error || !d.data ? <p className="text-red-500">{d.error}</p> : <div className="space-y-4 text-[13px]" data-testid="login-detail">
        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-4">{[["E-mail", p.email], ["Role", `${p.role}${p.is_admin ? " (administrator)" : ""}`], ["Account", p.is_active ? (p.locked ? "Active · locked" : "Active") : "Deactivated"], ["Last login", p.last_login ? dt(p.last_login) : "Never"],
          ["Total logins", String(d.data.total_logins)], ["Failed attempts", String(d.data.failed_total)], ["Department", p.department || "—"], ["Created", dt(p.created_at)]].map(([k, v]) => <div key={k}><dt className="text-xs text-sub">{k}</dt><dd className="font-medium">{v}</dd></div>)}</dl>

        <section><h3 className="mb-1 font-semibold">Active sessions ({d.data.active_sessions.length})</h3>
          {!d.data.active_sessions.length ? <p className="text-sub">No valid sessions right now.</p> : <ul className="divide-y rounded-lg border">{d.data.active_sessions.map((s: any) => (
            <li key={s.id} className="flex flex-wrap items-center gap-3 p-2.5"><DeviceIcon t={s.device_type} /><span className="min-w-40 flex-1"><b className="font-medium">{s.device_type} · {s.browser}</b><span className="block text-xs text-sub">{s.os} · {s.ip_address || "IP not retained"} · signed in {dt(s.login_at)} · last active {dt(s.last_activity_at)}</span></span>
              <StateBadge row={s} /><button className="btn-ghost !px-2 !py-1 text-red-600" aria-label={`Terminate session ${s.id}`} onClick={() => setConfirm({ s })}><XCircle className="h-4 w-4" />Terminate</button></li>))}</ul>}</section>

        <section><h3 className="mb-1 font-semibold">Device history</h3>
          {!d.data.devices.length ? <p className="text-sub">No sign-ins recorded.</p> : <ul className="flex flex-wrap gap-2">{d.data.devices.map((x: any, i: number) => <li key={i} className="flex items-center gap-2 rounded-lg border px-2.5 py-1.5"><DeviceIcon t={x.device_type} /><span>{x.device_type} · {x.browser} · {x.os}<span className="block text-xs text-sub">{x.logins} sign-in{x.logins === 1 ? "" : "s"} · last {dt(x.last_used)}</span></span></li>)}</ul>}</section>

        <section><h3 className="mb-1 font-semibold">Login history</h3>
          <div className="max-h-56 overflow-y-auto rounded-lg border"><table className="w-full"><thead className="bg-muted/50"><tr>{["Login", "Logout / end", "Duration", "Device", "IP", "Status"].map((h) => <th key={h} className="th">{h}</th>)}</tr></thead>
            <tbody className="divide-y">{d.data.history.map((s: any) => <tr key={s.id}><td className="td whitespace-nowrap">{dt(s.login_at)}</td><td className="td whitespace-nowrap">{s.logout_at ? dt(s.logout_at) : "—"}</td><td className="td">{duration(s.duration_seconds)}</td><td className="td">{s.device_type} · {s.browser}</td><td className="td">{s.ip_address || "—"}</td><td className="td"><StateBadge row={s} /></td></tr>)}</tbody></table></div></section>

        {!!d.data.failed_recent.length && <section><h3 className="mb-1 font-semibold">Recent failed attempts</h3><ul className="divide-y rounded-lg border">{d.data.failed_recent.map((f: any) => <li key={f.id} className="flex flex-wrap gap-x-4 p-2 text-xs"><span>{dt(f.timestamp)}</span><span className="font-medium">{CATEGORY[f.category] || f.category}</span><span className="text-sub">{f.ip_address || "—"} · {f.device}</span></li>)}</ul></section>}
        <div className="grid gap-4 sm:grid-cols-2">
          <section><h3 className="mb-1 font-semibold">Recent activity</h3>{!d.data.recent_activity.length ? <p className="text-sub">None yet.</p> : <ul className="divide-y">{d.data.recent_activity.slice(0, 8).map((a: any) => <li key={a.id} className="py-1.5"><b className="font-medium">{a.action.replace(/_/g, " ")}</b> <span className="text-sub">{a.entity}{a.entity_id ? ` #${a.entity_id}` : ""} · {dt(a.when)}</span></li>)}</ul>}</section>
          <section><h3 className="mb-1 font-semibold">Assigned permissions</h3>{p.is_admin ? <p className="text-sub">Full access to every module.</p> : !Object.keys(d.data.permissions).length ? <p className="text-sub">No module access.</p> : <ul className="space-y-1">{Object.entries(d.data.permissions).map(([m, a]: any) => <li key={m}><b className="font-medium capitalize">{m}</b> <span className="text-sub">{a.join(", ")}</span></li>)}</ul>}</section>
        </div>
      </div>}
      {confirm && <Confirm title="Terminate session" text={`${p?.name} will be signed out of ${confirm.s.device_type} · ${confirm.s.browser} immediately. They can sign in again unless you also deactivate the account.`} action="Terminate" onConfirm={() => kill(confirm.s)} onClose={() => setConfirm(null)} />}
    </Modal>
  );
}

const PRESETS: [string, string][] = [["today", "Today"], ["yesterday", "Yesterday"], ["7d", "Last 7 days"], ["30d", "Last 30 days"], ["custom", "Custom range"], ["", "All time"]];

export default function LoginActivity() {
  const toast = useToast(); const [sp, setSp] = useSearchParams();
  const tab = sp.get("tab") === "failed" ? "failed" : "history";
  const [f, setF] = useState({ preset: "7d", date_from: "", date_to: "", user_id: "", role: "", state: "", q: "", category: "" });
  const [page, setPage] = useState(1); const [detail, setDetail] = useState<number | null>(sp.get("user") ? +sp.get("user")! : null);
  const users = useLoad(() => api("/users"));
  const params = useMemo(() => {
    const p = new URLSearchParams({ tz: String(tzOffset()), page: String(page), page_size: "20" });
    for (const [k, v] of Object.entries(f)) if (v && !(k === "category" && tab === "history") && !(["role", "state"].includes(k) && tab === "failed")) p.set(k, v);
    if (f.preset === "custom" && !f.date_from && !f.date_to) p.delete("preset");
    return p.toString();
  }, [f, page, tab]);
  const list = useLoad(() => api(`/monitor/${tab}?${params}`), [params, tab]);
  const sum = useLoad(() => api(`/monitor/summary?tz=${tzOffset()}`));
  useEffect(() => { const t = setInterval(() => { if (!document.hidden && page === 1) list.reload(); }, 15000); return () => clearInterval(t); }, [list.reload, page]);
  const set = (k: string, v: string) => { setF((o) => ({ ...o, [k]: v })); setPage(1); };
  const exp = async (fmt: "csv" | "xlsx") => { const p = new URLSearchParams(params); p.delete("page"); p.delete("page_size"); p.set("kind", tab === "failed" ? "failed" : "history"); p.set("fmt", fmt); try { await download(`/monitor/export?${p}`, `login-${tab}.${fmt}`); toast(`Exported ${fmt.toUpperCase()}`); } catch (e: any) { toast(e.message, "err"); } };
  const d = list.data; const pages = d ? Math.max(1, Math.ceil(d.total / d.page_size)) : 1;
  return (
    <div className="space-y-4" data-testid="login-activity">
      <div className="flex flex-wrap items-center justify-between gap-2"><div><h1 className="text-xl font-semibold">Login history</h1><p className="text-[13px] text-sub">Every sign-in, session and failed attempt, from StockPilot's own authentication records. IP addresses are removed after {sum.data?.policy.ip_retention_days ?? 30} days. Locations are not resolved.</p></div>
        <div className="flex gap-2"><button className="btn-ghost" onClick={() => exp("csv")}><Download className="h-4 w-4" />CSV</button><button className="btn-ghost" onClick={() => exp("xlsx")}><Download className="h-4 w-4" />Excel</button></div></div>
      {!!sum.data?.alerts.length && <div className="flex items-start gap-2 rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-[13px]" role="alert"><ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-red-600" /><div><b>Repeated failed sign-ins</b> (≥ {sum.data.policy.alert_threshold} in {sum.data.policy.alert_window_minutes} min): {sum.data.alerts.map((a: any) => `${a.email} (${a.count})`).join(", ")}</div></div>}
      <div className="flex gap-1 border-b">{(["history", "failed"] as const).map((t) => <button key={t} onClick={() => { setSp(t === "history" ? {} : { tab: t }); setPage(1); }} className={`-mb-px border-b-2 px-3 py-2 text-[14px] font-medium ${tab === t ? "border-brand text-brand" : "border-transparent text-sub hover:text-ink"}`}>{t === "history" ? "Sessions" : "Failed attempts"}</button>)}</div>
      <div className="flex flex-wrap items-end gap-2">
        <select className="input !w-auto" aria-label="Date range" value={f.preset} onChange={(e) => set("preset", e.target.value)}>{PRESETS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
        {f.preset === "custom" && <><input type="date" className="input !w-auto" aria-label="From date" value={f.date_from} onChange={(e) => set("date_from", e.target.value)} /><input type="date" className="input !w-auto" aria-label="To date" value={f.date_to} onChange={(e) => set("date_to", e.target.value)} /></>}
        {tab === "history" && <><select className="input !w-auto" aria-label="User" value={f.user_id} onChange={(e) => set("user_id", e.target.value)}><option value="">All users</option>{users.data?.map((u: any) => <option key={u.id} value={u.id}>{u.name}</option>)}</select>
          <select className="input !w-auto" aria-label="Role" value={f.role} onChange={(e) => set("role", e.target.value)}><option value="">All roles</option><option value="admin_type">Administrators</option><option value="user_type">Normal users</option>{["manager", "warehouse", "sales", "accountant", "viewer"].map((r) => <option key={r} value={r}>{r}</option>)}</select>
          <select className="input !w-auto" aria-label="Session status" value={f.state} onChange={(e) => set("state", e.target.value)}><option value="">Any status</option>{Object.entries(STATE).map(([k, v]) => <option key={k} value={k}>{k === "active" ? "Currently active" : v.label}</option>)}</select></>}
        {tab === "failed" && <select className="input !w-auto" aria-label="Reason" value={f.category} onChange={(e) => set("category", e.target.value)}><option value="">Any reason</option>{Object.entries(CATEGORY).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>}
        <input className="input min-w-52 flex-1" placeholder={tab === "history" ? "Search name or e-mail" : "Search e-mail entered"} aria-label="Search" value={f.q} onChange={(e) => set("q", e.target.value)} />
      </div>
      <div className="card overflow-x-auto">{list.loading && !d ? <Skeleton rows={6} /> : list.error ? <p className="p-4 text-red-500">{list.error}</p> : !d?.items.length ? <Empty title="No records for these filters" /> :
        tab === "history" ? <table className="w-full"><thead className="border-b bg-muted/50"><tr>{["User", "Login", "Logout", "Duration", "Device", "Browser", "IP address", "Status", "Failed attempts", ""].map((h) => <th key={h} className="th whitespace-nowrap">{h}</th>)}</tr></thead>
          <tbody className="divide-y">{d.items.map((r: any) => <tr key={r.id} data-session={r.id}><td className="td"><div className="font-medium">{r.name}</div><div className="text-xs text-sub">{r.email}</div></td><td className="td whitespace-nowrap">{dt(r.login_at)}</td><td className="td whitespace-nowrap">{r.logout_at ? dt(r.logout_at) : "—"}</td><td className="td">{duration(r.duration_seconds)}</td>
            <td className="td"><span className="inline-flex items-center gap-1.5"><DeviceIcon t={r.device_type} />{r.device_type}</span></td><td className="td">{r.browser}</td><td className="td">{r.ip_address || <span className="text-sub" title="Older than the retention period">removed</span>}</td><td className="td"><StateBadge row={r} /></td>
            <td className="td text-center">{r.failed_attempts ? <Badge tone="warn">{r.failed_attempts}</Badge> : "0"}</td><td className="td"><button className="btn-ghost !px-2 !py-1" aria-label={`View details for ${r.name}`} onClick={() => setDetail(r.user_id)}><Eye className="h-4 w-4" />Details</button></td></tr>)}</tbody></table> :
          <table className="w-full"><thead className="border-b bg-muted/50"><tr>{["E-mail entered", "Time", "Reason", "Account", "IP address", "Device"].map((h) => <th key={h} className="th">{h}</th>)}</tr></thead>
            <tbody className="divide-y">{d.items.map((r: any) => <tr key={r.id}><td className="td font-medium">{r.email || "—"}</td><td className="td whitespace-nowrap">{dt(r.timestamp)}</td><td className="td"><Badge tone={r.category === "unknown_account" ? "neutral" : "warn"}>{CATEGORY[r.category] || r.category}</Badge></td><td className="td">{r.known_account ? <button className="text-brand hover:underline" onClick={() => setDetail(r.user_id)}>Registered</button> : <span className="text-sub">Not registered</span>}</td><td className="td">{r.ip_address || "—"}</td><td className="td">{r.device}</td></tr>)}</tbody></table>}</div>
      {d && d.total > 0 && <div className="flex items-center justify-between text-[13px] text-sub"><span>{d.total} record{d.total === 1 ? "" : "s"}</span><div className="flex items-center gap-2"><button className="btn-ghost !px-2" aria-label="Previous page" disabled={page <= 1} onClick={() => setPage(page - 1)}><ChevronLeft className="h-4 w-4" /></button><span>Page {page} of {pages}</span><button className="btn-ghost !px-2" aria-label="Next page" disabled={page >= pages} onClick={() => setPage(page + 1)}><ChevronRight className="h-4 w-4" /></button></div></div>}
      {detail !== null && <UserLoginDetail userId={detail} onClose={() => setDetail(null)} onChanged={() => { list.reload(); sum.reload(); }} />}
    </div>
  );
}

/** Dashboard panel: live statistics + recent session table, polled while the tab is visible. */
export function LoginMonitorPanel() {
  const [tick, setTick] = useState(0); const [detail, setDetail] = useState<number | null>(null); const [updated, setUpdated] = useState<Date | null>(null);
  const sum = useLoad(() => api(`/monitor/summary?tz=${tzOffset()}`, { background: true }), [tick]);
  const live = useLoad(() => api("/monitor/sessions?limit=12", { background: true }), [tick]);
  useEffect(() => { if (live.data) setUpdated(new Date()); }, [live.data]);
  const refresh = useCallback(() => setTick((t) => t + 1), []);
  useEffect(() => { const t = setInterval(() => { if (!document.hidden) refresh(); }, 10000); const v = () => !document.hidden && refresh(); document.addEventListener("visibilitychange", v); return () => { clearInterval(t); document.removeEventListener("visibilitychange", v); }; }, [refresh]);
  const s = sum.data;
  const tiles: [string, number | undefined, string][] = [["Registered users", s?.total_users, "accounts"], ["Active now", s?.active_users, `activity in the last ${s?.policy.active_minutes ?? 5} min`], ["Logged in today", s?.logged_in_today, "distinct users"], ["Never logged in", s?.never_logged_in, "no sign-in yet"], ["Inactive accounts", s?.inactive_accounts, "deactivated"], ["Sessions today", s?.sessions_today, `${s?.open_sessions ?? 0} still open`]];
  return (
    <section className="card p-4" data-testid="login-monitor">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-[13px] font-semibold">User login activity <span className="flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-600"><span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" />Live · every 10s{updated ? ` · ${updated.toLocaleTimeString("en-IN")}` : ""}</span></h3>
        <Link className="text-xs text-brand hover:underline" to="/login-activity">Full login history</Link></div>
      {!!s?.alerts.length && <p className="mb-3 flex items-center gap-2 rounded-lg bg-red-500/10 p-2 text-[13px] text-red-600" role="alert"><AlertTriangle className="h-4 w-4" />Repeated failed sign-ins: {s.alerts.map((a: any) => `${a.email} (${a.count})`).join(", ")}</p>}
      <div className="mb-3 grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-6">{tiles.map(([l, v, sub]) => <div key={l} className="rounded-lg border p-3" data-stat={l}><p className="text-xs text-sub">{l}</p><p className="text-xl font-semibold tabular-nums">{v ?? "…"}</p><p className="text-[11px] text-sub">{sub}</p></div>)}</div>
      <div className="overflow-x-auto rounded-lg border">{live.loading && !live.data ? <Skeleton rows={4} /> : !live.data?.items.length ? <Empty title="No sign-ins in the last 24 hours" /> :
        <table className="w-full"><thead className="border-b bg-muted/50"><tr>{["User", "Role", "Login time", "Last active", "IP address", "Device", "Browser", "Location", "Status", ""].map((h) => <th key={h} className="th whitespace-nowrap">{h}</th>)}</tr></thead>
          <tbody className="divide-y">{live.data.items.map((r: any) => <tr key={r.id} data-session={r.id} data-email={r.email}><td className="td"><div className="font-medium">{r.name}</div><div className="text-xs text-sub">{r.email}</div></td><td className="td">{r.is_admin ? "Admin" : "User"}</td><td className="td whitespace-nowrap">{dt(r.login_at)}</td><td className="td whitespace-nowrap">{dt(r.last_activity_at)}</td><td className="td">{r.ip_address || "—"}</td>
            <td className="td"><span className="inline-flex items-center gap-1.5"><DeviceIcon t={r.device_type} />{r.device_type}</span></td><td className="td">{r.browser}</td><td className="td text-sub" title={live.data.location_note}>Not available</td><td className="td"><StateBadge row={r} /></td>
            <td className="td"><button className="btn-ghost !px-2 !py-1" aria-label={`View details for ${r.name}`} onClick={() => setDetail(r.user_id)}><Eye className="h-4 w-4" />View Details</button></td></tr>)}</tbody></table>}</div>
      {detail !== null && <UserLoginDetail userId={detail} onClose={() => setDetail(null)} onChanged={refresh} />}
    </section>
  );
}
