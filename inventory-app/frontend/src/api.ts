// Thin API client with automatic access-token refresh.
const ACCESS = "sp_access";
const REFRESH = "sp_refresh";

// "Remember me" -> localStorage (survives the browser closing); otherwise sessionStorage (this tab/session only).
const read = (k: string) => sessionStorage.getItem(k) ?? localStorage.getItem(k);
export const tokens = {
  set(a: string, r: string, remember?: boolean) {
    const persistent = remember ?? (localStorage.getItem(REFRESH) !== null || sessionStorage.getItem(REFRESH) === null);
    const [on, off] = persistent ? [localStorage, sessionStorage] : [sessionStorage, localStorage];
    on.setItem(ACCESS, a); on.setItem(REFRESH, r); off.removeItem(ACCESS); off.removeItem(REFRESH);
  },
  clear() { for (const s of [localStorage, sessionStorage]) { s.removeItem(ACCESS); s.removeItem(REFRESH); } },
  get access() { return read(ACCESS); },
  get refresh() { return read(REFRESH); },
};

// in-flight request counter -> drives the top progress bar
let inflight = 0;
function pending(d: number) { inflight = Math.max(0, inflight + d); window.dispatchEvent(new CustomEvent("sp-pending", { detail: inflight })); }

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

let refreshing: Promise<boolean> | null = null;
async function tryRefresh(): Promise<boolean> {
  if (!tokens.refresh) return false;
  refreshing ??= fetch("/api/auth/refresh", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: tokens.refresh }),
  }).then(async (r) => {
    if (!r.ok) return false;
    const d = await r.json(); tokens.set(d.access_token, d.refresh_token); return true;
  }).catch(() => false).finally(() => { refreshing = null; });
  return refreshing;
}

function msg(d: any, fallback: string) {
  if (typeof d?.detail === "string") return d.detail;
  if (Array.isArray(d?.detail)) return d.detail.map((e: any) => `${(e.loc || []).slice(1).join(".")}: ${e.msg}`).join("; ");
  return fallback;
}

export async function api<T = any>(path: string, opts: { method?: string; body?: any; form?: FormData; background?: boolean } = {}, retry = true): Promise<T> {
  const headers: Record<string, string> = {};
  if (tokens.access) headers.Authorization = `Bearer ${tokens.access}`;
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  if (opts.background) headers["X-Background"] = "1";   // automatic polling: must not count as user activity
  if (!opts.background) pending(1);
  let r: Response;
  try {
    r = await fetch("/api" + path, {
      method: opts.method || (opts.body !== undefined || opts.form ? "POST" : "GET"),
      headers, body: opts.form ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined),
    });
  } finally { if (!opts.background) pending(-1); }
  if (r.status === 401 && retry && (await tryRefresh())) return api<T>(path, opts, false);
  if (r.status === 401) { tokens.clear(); window.dispatchEvent(new Event("sp-logout")); }
  if (r.status === 204) return undefined as T;
  const text = await r.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* non-json */ }
  if (!r.ok) throw new ApiError(r.status, msg(data, `Request failed (${r.status})`));
  return data as T;
}

/** Signs in. The server decides the role; the returned user carries `home` ("/admin" for administrators). */
export async function login(email: string, password: string, remember = true) {
  const r = await fetch(`/api/auth/login?remember=${remember}`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username: email, password }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new ApiError(r.status, msg(d, "Login failed"));
  tokens.set(d.access_token, d.refresh_token, remember);
  return d.user as { home: string; is_admin: boolean; must_change_password: boolean };
}

export async function publicPost(path: string, body: unknown) {
  const r = await fetch("/api" + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new ApiError(r.status, msg(d, "Request failed"));
  return d;
}

export async function download(path: string, filename: string) {
  const r = await fetch("/api" + path, { headers: { Authorization: `Bearer ${tokens.access}` } });
  if (!r.ok) throw new ApiError(r.status, "Download failed");
  const url = URL.createObjectURL(await r.blob());
  const a = document.createElement("a"); a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

/** Authenticated binary fetch (images, SVG barcodes, PDFs) returned as a Blob. */
export async function fetchBlob(path: string): Promise<Blob> {
  const r = await fetch("/api" + path, { headers: { Authorization: `Bearer ${tokens.access}` } });
  if (!r.ok) throw new ApiError(r.status, "Not available");
  return r.blob();
}

export const fmt = (n: number, d = 0) => (n ?? 0).toLocaleString("en-IN", { maximumFractionDigits: d });
export const money = (n: number) => "₹" + (n ?? 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const dt = (s: string) => new Date(s).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
