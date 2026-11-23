import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { AlertCircle, ArrowLeft, Boxes, CheckCircle2, Eye, EyeOff, Loader2, Lock, Mail, ShieldCheck, Truck, BarChart3 } from "lucide-react";
import { ApiError, api, login, publicPost, tokens } from "./api";
import { Modal, useToast } from "./ui";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function Shell({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <div className="grid min-h-screen lg:grid-cols-[1.05fr_1fr]">
      <aside className="relative hidden overflow-hidden bg-gradient-to-br from-teal-700 via-teal-600 to-emerald-500 p-12 text-white lg:flex lg:flex-col lg:justify-between">
        <div className="pointer-events-none absolute -right-24 -top-24 h-96 w-96 rounded-full bg-white/10 blur-2xl" />
        <div className="pointer-events-none absolute -bottom-32 -left-16 h-96 w-96 rounded-full bg-black/10 blur-2xl" />
        <div className="relative flex items-center gap-3"><span className="flex h-11 w-11 items-center justify-center rounded-xl bg-white/20 backdrop-blur"><Boxes className="h-6 w-6" /></span><span className="text-2xl font-bold tracking-tight">StockPilot</span></div>
        <div className="relative space-y-8">
          <div><h2 className="text-4xl font-bold leading-tight">Every item, order and shipment —<br />in one trusted ledger.</h2>
            <p className="mt-3 max-w-md text-teal-50/90">Sales, purchasing, warehouses and reporting, with access controlled per person by your administrator.</p></div>
          <ul className="space-y-4 text-[15px]">
            {[[ShieldCheck, "Role-based access enforced on the server"], [Truck, "Orders, packages and shipments tracked end to end"], [BarChart3, "Live reports and dashboards from real stock movements"]].map(([I, t]: any) =>
              <li key={t} className="flex items-center gap-3"><span className="flex h-9 w-9 items-center justify-center rounded-lg bg-white/15"><I className="h-5 w-5" /></span>{t}</li>)}
          </ul>
        </div>
        <p className="relative text-xs text-teal-50/70">© StockPilot</p>
      </aside>
      <main className="flex items-center justify-center p-6">
        <div className="anim-up w-full max-w-sm">
          <div className="mb-8 flex items-center gap-2 lg:hidden"><Boxes className="h-7 w-7 text-brand" /><span className="text-xl font-bold">StockPilot</span></div>
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          <p className="mb-6 mt-1 text-sm text-sub">{subtitle}</p>
          {children}
        </div>
      </main>
    </div>
  );
}

function PasswordInput({ id, value, onChange, label, autoComplete, invalid, hint }: { id: string; value: string; onChange: (v: string) => void; label: string; autoComplete: string; invalid?: string; hint?: string }) {
  const [show, setShow] = useState(false);
  return (
    <div>
      <label htmlFor={id} className="label">{label}</label>
      <div className="relative">
        <Lock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-sub" />
        <input id={id} name={id} type={show ? "text" : "password"} autoComplete={autoComplete} className={`input !pl-9 !pr-10 ${invalid ? "!border-red-500" : ""}`} value={value} onChange={(e) => onChange(e.target.value)} />
        <button type="button" aria-label={show ? "Hide password" : "Show password"} className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-sub hover:bg-muted" onClick={() => setShow(!show)}>{show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}</button>
      </div>
      {invalid ? <p className="mt-1 text-xs text-red-600" role="alert">{invalid}</p> : hint && <p className="mt-1 text-xs text-sub">{hint}</p>}
    </div>
  );
}

const ErrorBox = ({ msg }: { msg: string }) => msg ? <p role="alert" className="flex items-start gap-2 rounded-lg bg-red-500/10 p-2.5 text-sm text-red-600"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />{msg}</p> : null;

export function pwProblem(p: string): string {
  if (p.length < 8) return "Use at least 8 characters";
  if (!/[A-Za-z]/.test(p) || !/\d/.test(p)) return "Include at least one letter and one number";
  if (new TextEncoder().encode(p).length > 72) return "Password is too long";
  return "";
}

export function LoginPage({ onDone }: { onDone: (home: string) => void | Promise<void> }) {
  const [email, setEmail] = useState(""); const [password, setPassword] = useState(""); const [remember, setRemember] = useState(true);
  const [touched, setTouched] = useState({ email: false, password: false }); const [err, setErr] = useState(""); const [busy, setBusy] = useState(false);
  const [cfg, setCfg] = useState<{ signup_enabled: boolean; first_run?: boolean } | null>(null);
  const [signup, setSignup] = useState(false); const [org, setOrg] = useState(""); const [name, setName] = useState("");
  useEffect(() => { fetch("/api/auth/config").then((r) => r.json()).then(setCfg).catch(() => setCfg({ signup_enabled: false })); }, []);
  const emailErr = touched.email && !EMAIL_RE.test(email.trim()) ? (email ? "Enter a valid e-mail address" : "E-mail is required") : "";
  const pwErr = touched.password && !password ? "Password is required" : "";
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setTouched({ email: true, password: true }); setErr("");
    if (!EMAIL_RE.test(email.trim()) || !password) return;
    setBusy(true);
    try {
      if (signup) {
        const d = await publicPost("/auth/signup", { ...(cfg?.first_run ? { org_name: org } : {}), name, email: email.trim(), password });
        tokens.set(d.access_token, d.refresh_token, remember); await onDone("");
      } else { const u = await login(email.trim(), password, remember); await onDone(u.home); }
    } catch (e: any) { setErr(e instanceof ApiError ? e.message : "Cannot reach the server. Check your connection and try again."); setPassword(""); } finally { setBusy(false); }
  };
  return (
    <Shell title={signup ? (cfg?.first_run ? "Set up StockPilot" : "Create your account") : "Welcome back"} subtitle={signup ? (cfg?.first_run ? "This first account becomes the administrator." : "Register to browse products and track your orders.") : "Sign in to your StockPilot account"}>
      <form onSubmit={submit} className="space-y-4" noValidate>
        {signup && <>{cfg?.first_run && <div><label htmlFor="org" className="label">Organization name</label><input id="org" className="input" required value={org} onChange={(e) => setOrg(e.target.value)} /></div>}
          <div><label htmlFor="fullname" className="label">Your name</label><input id="fullname" className="input" required value={name} onChange={(e) => setName(e.target.value)} /></div></>}
        <div>
          <label htmlFor="email" className="label">E-mail</label>
          <div className="relative"><Mail className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-sub" />
            <input id="email" name="email" type="email" autoComplete="username" autoFocus placeholder="you@company.com" className={`input !pl-9 ${emailErr ? "!border-red-500" : ""}`} value={email} onChange={(e) => setEmail(e.target.value)} onBlur={() => setTouched((t) => ({ ...t, email: true }))} /></div>
          {emailErr && <p className="mt-1 text-xs text-red-600" role="alert">{emailErr}</p>}
        </div>
        <PasswordInput id="password" label="Password" autoComplete={signup ? "new-password" : "current-password"} value={password} onChange={setPassword} invalid={pwErr} hint={signup ? "8+ characters with a letter and a number" : undefined} />
        {!signup && <div className="flex items-center justify-between text-sm">
          <label className="flex cursor-pointer items-center gap-2"><input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />Remember me</label>
          <Link to="/forgot-password" className="text-brand hover:underline">Forgot password?</Link></div>}
        <ErrorBox msg={err} />
        <button className={`btn-primary w-full !py-2.5 ${busy ? "btn-loading" : ""}`} disabled={busy} type="submit">{busy ? <><Loader2 className="h-4 w-4 animate-spin" />Signing in…</> : signup ? (cfg?.first_run ? "Create administrator account" : "Create account") : "Sign in"}</button>
        {cfg?.signup_enabled && <button type="button" className="w-full text-center text-sm text-brand" onClick={() => { setSignup(!signup); setErr(""); }}>{signup ? "Have an account? Sign in" : cfg?.first_run ? "First time? Set up the administrator account" : "New customer? Create an account"}</button>}
        {!signup && !cfg?.first_run && <p className="text-center text-xs text-sub">Administrators and customers sign in here. You are taken to the right portal automatically.</p>}
      </form>
    </Shell>
  );
}

export function ForgotPage() {
  const [email, setEmail] = useState(""); const [done, setDone] = useState(""); const [err, setErr] = useState(""); const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setErr("");
    if (!EMAIL_RE.test(email.trim())) { setErr("Enter a valid e-mail address"); return; }
    setBusy(true);
    try { const d = await publicPost("/auth/forgot", { email: email.trim() }); setDone(d.message); } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  return (
    <Shell title="Forgot your password?" subtitle="Tell us your e-mail. Your administrator will send you a one-time reset link.">
      {done ? <div className="space-y-4"><p className="flex items-start gap-2 rounded-lg bg-emerald-500/10 p-3 text-sm text-emerald-700 dark:text-emerald-400"><CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />{done}</p><Link to="/" className="btn-ghost w-full justify-center"><ArrowLeft className="h-4 w-4" />Back to sign in</Link></div> :
        <form onSubmit={submit} className="space-y-4" noValidate>
          <div><label htmlFor="fe" className="label">E-mail</label><input id="fe" type="email" autoFocus className="input" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" /></div>
          <ErrorBox msg={err} />
          <button className={`btn-primary w-full !py-2.5 ${busy ? "btn-loading" : ""}`} disabled={busy}>Request reset link</button>
          <Link to="/" className="flex items-center justify-center gap-1 text-sm text-brand"><ArrowLeft className="h-4 w-4" />Back to sign in</Link></form>}
    </Shell>
  );
}

export function ResetPage() {
  const [sp] = useSearchParams(); const token = sp.get("token") || ""; const go = useNavigate();
  const [pw, setPw] = useState(""); const [pw2, setPw2] = useState(""); const [err, setErr] = useState(""); const [busy, setBusy] = useState(false); const [done, setDone] = useState(false);
  const bad = pw ? pwProblem(pw) : ""; const mismatch = pw2 && pw !== pw2 ? "Passwords do not match" : "";
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setErr("");
    if (pwProblem(pw) || pw !== pw2) return;
    setBusy(true);
    try { await publicPost("/auth/reset", { token, new_password: pw }); setDone(true); } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  return (
    <Shell title="Choose a new password" subtitle="This link works once and expires after 24 hours.">
      {done ? <div className="space-y-4"><p className="flex items-start gap-2 rounded-lg bg-emerald-500/10 p-3 text-sm text-emerald-700 dark:text-emerald-400"><CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />Password updated. You can sign in now.</p><button className="btn-primary w-full" onClick={() => go("/")}>Go to sign in</button></div> :
        !token ? <ErrorBox msg="This reset link is missing its token. Ask your administrator for a new one." /> :
          <form onSubmit={submit} className="space-y-4" noValidate>
            <PasswordInput id="np" label="New password" autoComplete="new-password" value={pw} onChange={setPw} invalid={bad} hint="8+ characters with a letter and a number" />
            <PasswordInput id="np2" label="Confirm new password" autoComplete="new-password" value={pw2} onChange={setPw2} invalid={mismatch} />
            <ErrorBox msg={err} />
            <button className={`btn-primary w-full !py-2.5 ${busy ? "btn-loading" : ""}`} disabled={busy}>Update password</button></form>}
    </Shell>
  );
}

/** Used both for the forced first-login change (full screen) and the voluntary change (modal). */
function ChangeForm({ forced, onDone, onCancel }: { forced?: boolean; onDone: () => void; onCancel?: () => void }) {
  const [cur, setCur] = useState(""); const [pw, setPw] = useState(""); const [pw2, setPw2] = useState(""); const [err, setErr] = useState(""); const [busy, setBusy] = useState(false);
  const bad = pw ? pwProblem(pw) : ""; const mismatch = pw2 && pw !== pw2 ? "Passwords do not match" : "";
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setErr("");
    if (!cur || pwProblem(pw) || pw !== pw2) { setErr("Fill in all fields correctly"); return; }
    setBusy(true);
    try { const d = await api("/auth/change-password", { body: { current_password: cur, new_password: pw } }); tokens.set(d.access_token, d.refresh_token); onDone(); }
    catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      <PasswordInput id="cp" label={forced ? "Temporary password" : "Current password"} autoComplete="current-password" value={cur} onChange={setCur} />
      <PasswordInput id="cp-new" label="New password" autoComplete="new-password" value={pw} onChange={setPw} invalid={bad} hint="8+ characters with a letter and a number" />
      <PasswordInput id="cp-new2" label="Confirm new password" autoComplete="new-password" value={pw2} onChange={setPw2} invalid={mismatch} />
      <ErrorBox msg={err} />
      <div className="flex justify-end gap-2">{onCancel && <button type="button" className="btn-ghost" onClick={onCancel}>Cancel</button>}<button className={`btn-primary ${busy ? "btn-loading" : ""}`} disabled={busy}>Update password</button></div>
    </form>
  );
}

export function ForcedPasswordChange({ onDone, onLogout }: { onDone: () => void; onLogout: () => void }) {
  return (
    <Shell title="Set a new password" subtitle="Your account uses a temporary password. Choose your own to continue.">
      <ChangeForm forced onDone={onDone} />
      <button className="mt-4 w-full text-center text-sm text-sub hover:text-brand" onClick={onLogout}>Sign out</button>
    </Shell>
  );
}

export function ChangePasswordModal({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  return <Modal title="Change password" onClose={onClose}><ChangeForm onCancel={onClose} onDone={() => { toast("Password updated. Other devices were signed out."); onClose(); }} /></Modal>;
}
