import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { NavLink, Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { Bell, Boxes, ChevronsLeft, ChevronsRight, History, LayoutDashboard, LogOut, Moon, Package, Search, Sun, Users, Warehouse as WhIcon, Command, ArrowLeftRight, ArrowRightLeft, Sparkles, Settings, Plus, CornerDownLeft, Contact, Store, ClipboardList, ShoppingCart, Box, Truck, SlidersHorizontal, BarChart3, Activity, LifeBuoy, ShieldCheck, KeyRound, ShieldAlert } from "lucide-react";
import { api, tokens, dt } from "./api";
import { useToast, Modal } from "./ui";
import { ChangePasswordModal, ForcedPasswordChange, ForgotPage, LoginPage, ResetPage } from "./Auth";
import AdminDashboard from "./pages/AdminDashboard";
import AdminSupport from "./pages/AdminSupport";
import UserPortal from "./portal/UserPortal";
import { ADMIN, ext, redirectFor, toInternal, underBase } from "./portalPaths";
import LoginActivity from "./pages/LoginActivity";
import Dashboard from "./pages/Dashboard";
import Products from "./pages/Products";
import { ItemDetail, ItemFormPage } from "./pages/ItemPages";
import { PartyDetail, PartyForm, PartyList } from "./pages/Parties";
import { POList, POForm, PODetail } from "./pages/PurchaseOrders";
import SettingsPage from "./pages/Settings";
import { SODetail, SOForm, SOList } from "./pages/SalesOrders";
import { PackageList, ShipmentDetail, ShipmentList } from "./pages/Shipments";
import { AdjDetail, AdjForm, AdjList } from "./pages/Adjustments";
import { ReportsHome, ReportView } from "./pages/Reports";
import Inventory from "./pages/Inventory";
import Warehouses, { WarehouseFormPage } from "./pages/Warehouses";
import UsersPage from "./pages/UsersPage";
import WarehouseDetail from "./pages/WarehouseDetail";
import Transfers from "./pages/Transfers";
import Insights from "./pages/Insights";
import Assistant from "./Assistant";
import { NavProgress, useDismiss } from "./fx";

export type Me = { id: number; name: string; email: string; role: string; org: { id: number; name: string; currency: string; gstin?: string | null; state?: string | null }; permissions: Record<string, string>; is_admin: boolean; home: string; department?: string | null; phone?: string | null; must_change_password: boolean; actions: Record<string, string[]> };
const MeCtx = createContext<{ me: Me; can: (m: string, l?: "r" | "w") => boolean; has: (m: string, action: string) => boolean } | null>(null);
export const useMe = () => useContext(MeCtx)!;
export function MeProvider({ me, children }: { me: Me; children: React.ReactNode }) {
  const can = useCallback((m: string, l: "r" | "w" = "r") => { const h = me.permissions[m]; return !!h && (h === "w" || l === "r"); }, [me]);
  const has = useCallback((m: string, a: string) => me.is_admin || (me.actions?.[m] || []).includes(a), [me]);
  return <MeCtx.Provider value={{ me, can, has }}>{children}</MeCtx.Provider>;
}

const NAV: { to: string; label: string; icon: any; mod: string; group: string; admin?: boolean }[] = [
  { to: "/admin", label: "Dashboard", icon: ShieldCheck, mod: "", group: "", admin: true },
  { to: "/", label: "Operations", icon: LayoutDashboard, mod: "", group: "", admin: true },
  { to: "/products", label: "Items", icon: Package, mod: "products", group: "Items" },
  { to: "/adjustments", label: "Adjustments", icon: SlidersHorizontal, mod: "inventory", group: "Items" },
  { to: "/customers", label: "Customers", icon: Contact, mod: "sales", group: "Sales" },
  { to: "/sales-orders", label: "Sales Orders", icon: ShoppingCart, mod: "sales", group: "Sales" },
  { to: "/packages", label: "Packages", icon: Box, mod: "fulfilment", group: "Sales" },
  { to: "/shipments", label: "Shipments", icon: Truck, mod: "fulfilment", group: "Sales" },
  { to: "/vendors", label: "Vendors", icon: Store, mod: "purchases", group: "Purchases" },
  { to: "/purchase-orders", label: "Purchase Orders", icon: ClipboardList, mod: "purchases", group: "Purchases" },
  { to: "/inventory", label: "Inventory", icon: ArrowLeftRight, mod: "inventory", group: "Inventory" },
  { to: "/warehouses", label: "Warehouses", icon: WhIcon, mod: "warehouses", group: "Inventory" },
  { to: "/transfers", label: "Transfers", icon: ArrowRightLeft, mod: "inventory", group: "Inventory" },
  { to: "/reports", label: "Reports", icon: BarChart3, mod: "reports", group: "Insights" },
  { to: "/insights", label: "AI Insights", icon: Sparkles, mod: "inventory", group: "Insights" },
  { to: "/team", label: "Users", icon: Users, mod: "users", group: "Admin" },
  { to: "/login-activity", label: "Login history", icon: Activity, mod: "", group: "Admin", admin: true },
  { to: "/support", label: "Support tickets", icon: LifeBuoy, mod: "", group: "Admin", admin: true },
  { to: "/settings", label: "Settings", icon: Settings, mod: "settings", group: "Admin" },
];

type PalItem = { key: string; group: string; label: string; hint?: string; icon: any; run: () => void };

function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  const rows: [string, string][] = [["Ctrl / ⌘ + K", "Open search & commands"], ["?", "Show this list"], ["/", "Focus the search box on a list page"], ["N", "New record (on a list page: warehouse, item, customer, vendor)"], ["G then D / P / C / V / O / I / W / T / A / S", "Go to Dashboard / Items / Customers / Vendors / Purchase Orders / Inventory / Warehouses / Transfers / AI Insights / Settings"], ["↑ ↓ · Enter · Space", "Move between table rows · open quick view · select row"], ["← →", "Switch tabs (when a tab is focused)"], ["Esc", "Close dialogs, drawers and menus"]];
  return (
    <Modal title="Keyboard shortcuts" onClose={onClose}>
      <ul className="divide-y text-[13px]">{rows.map(([k, d]) => <li key={k} className="flex items-center justify-between gap-4 py-2"><span className="text-sub">{d}</span><kbd className="shrink-0 rounded border bg-muted px-1.5 py-0.5 text-[11px] font-medium">{k}</kbd></li>)}</ul>
    </Modal>
  );
}

function Palette({ onClose, nav, can, toggleTheme, showShortcuts }: { onClose: () => void; nav: typeof NAV; can: (m: string, l?: "r" | "w") => boolean; toggleTheme: () => void; showShortcuts: () => void }) {
  const [q, setQ] = useState(""); const [hits, setHits] = useState<any[]>([]); const [active, setActive] = useState(0); const go = useNavigate();
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (q.trim().length < 2) { setHits([]); return; }
    const t = setTimeout(() => api(`/products?q=${encodeURIComponent(q)}&page_size=6`).then((d) => setHits(d.items)).catch(() => setHits([])), 180);
    return () => clearTimeout(t);
  }, [q]);
  const nav2 = (to: string) => () => { go(to); onClose(); };
  const items: PalItem[] = [
    ...(can("warehouses", "w") ? [{ key: "a1", group: "Actions", label: "New warehouse", icon: Plus, run: nav2("/warehouses/new") }] : []),
    ...(can("products", "w") ? [{ key: "a5", group: "Actions", label: "New item", icon: Plus, run: nav2("/products/new") }] : []),
    ...(can("sales", "w") ? [{ key: "a6", group: "Actions", label: "New customer", icon: Plus, run: nav2("/customers/new") }] : []),
    ...(can("purchases", "w") ? [{ key: "a7", group: "Actions", label: "New vendor", icon: Plus, run: nav2("/vendors/new") }] : []),
    ...(can("sales", "w") ? [{ key: "a9", group: "Actions", label: "New sales order", icon: Plus, run: nav2("/sales-orders/new") }] : []),
    ...(can("purchases", "w") ? [{ key: "a8", group: "Actions", label: "New purchase order", icon: Plus, run: nav2("/purchase-orders/new") }] : []),
    ...(can("inventory", "w") ? [{ key: "a2", group: "Actions", label: "New stock transfer", icon: ArrowRightLeft, run: nav2("/transfers") }] : []),
    { key: "a3", group: "Actions", label: "Toggle light / dark theme", icon: Moon, run: () => { toggleTheme(); onClose(); } },
    { key: "a4", group: "Actions", label: "Keyboard shortcuts", hint: "?", icon: Command, run: () => { onClose(); showShortcuts(); } },
    ...nav.map((n) => ({ key: n.to, group: "Go to", label: n.label, icon: n.icon, run: nav2(n.to) })),
    ...hits.map((h) => ({ key: `p${h.id}`, group: "Products", label: h.name, hint: `${h.sku} · ${h.available} available`, icon: Package, run: nav2(`/products?q=${encodeURIComponent(h.sku)}`) })),
  ].filter((i) => i.group === "Products" || i.label.toLowerCase().includes(q.toLowerCase()));
  useEffect(() => setActive(0), [q, hits.length]);
  useEffect(() => { list.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`)?.scrollIntoView({ block: "nearest" }); }, [active]);
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(items.length - 1, a + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
    else if (e.key === "Enter") { e.preventDefault(); items[active]?.run(); }
  };
  let last = "";
  return (
    <Modal title="Search & commands" onClose={onClose}>
      <input autoFocus className="input mb-2" placeholder="Search products, SKUs or type a command…" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey} role="combobox" aria-expanded aria-controls="palette-list" />
      <div ref={list} id="palette-list" role="listbox" className="max-h-80 overflow-y-auto">
        {!items.length && <p className="py-6 text-center text-[13px] text-sub">No matches</p>}
        {items.map((it, i) => {
          const head = it.group !== last ? it.group : ""; last = it.group;
          return (<div key={it.key}>{head && <p className="px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-sub">{head}</p>}
            <button data-idx={i} role="option" aria-selected={i === active} onMouseMove={() => setActive(i)} onClick={it.run}
              className={`flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left text-[13px] transition-colors ${i === active ? "bg-brand/10 text-brand" : ""}`}>
              <it.icon className="h-4 w-4 shrink-0 opacity-70" /><span className="flex-1 truncate">{it.label}</span>{it.hint && <span className="text-xs text-sub">{it.hint}</span>}{i === active && <CornerDownLeft className="h-3 w-3 opacity-60" />}</button></div>);
        })}
      </div>
      <p className="mt-2 flex gap-3 border-t pt-2 text-[11px] text-sub"><span>↑↓ navigate</span><span>↵ select</span><span>esc close</span></p>
    </Modal>
  );
}

function Bells() {
  const [open, setOpen] = useState(false); const [d, setD] = useState<any>(null); const ref = useRef<HTMLDivElement>(null);
  const load = useCallback(() => api("/notifications").then(setD).catch(() => {}), []);
  useEffect(() => { load(); const t = setInterval(load, 30000); window.addEventListener("sp-data-changed", load); return () => { clearInterval(t); window.removeEventListener("sp-data-changed", load); }; }, [load]);
  useDismiss(ref, open, () => setOpen(false));
  return (
    <div className="relative" ref={ref}>
      <button className="btn-ghost relative !border-transparent !bg-transparent !px-2 hover:!bg-muted" onClick={() => { setOpen(!open); load(); }} aria-label="Notifications" data-tip="Notifications"><Bell className="h-4 w-4" />
        {d?.unread > 0 && <span key={d.unread} className="anim-pop absolute -right-0.5 -top-0.5 rounded-full bg-red-500 px-1.5 text-[10px] font-bold text-white">{d.unread}</span>}</button>
      {open && <div className="card anim-pop absolute right-0 z-40 mt-2 max-h-96 w-80 overflow-y-auto p-2 shadow-[var(--shadow-3)]">
        <div className="flex items-center justify-between px-2 py-1"><span className="text-[13px] font-semibold">Notifications</span>
          <button className="text-xs text-brand hover:underline" onClick={async () => { await api("/notifications/read-all", { method: "POST" }); load(); }}>Mark all read</button></div>
        {!d?.items.length && <p className="p-4 text-center text-[13px] text-sub">You're all caught up.</p>}
        {d?.items.map((n: any, i: number) => <div key={n.id} style={{ ["--i" as any]: i }} className={`stagger rounded-md p-2 text-[13px] ${n.is_read ? "opacity-60" : "bg-muted"}`}><p className="font-medium">{n.title}</p><p className="text-xs text-sub">{n.body}</p><p className="mt-1 text-[11px] text-sub">{dt(n.created_at)}</p></div>)}
      </div>}
    </div>
  );
}

function ProfileMenu({ me, dark, toggleTheme, onLogout, showShortcuts, changePassword }: { me: Me; dark: boolean; toggleTheme: () => void; onLogout: () => void; showShortcuts: () => void; changePassword: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, open, () => setOpen(false));
  const initials = me.name.split(" ").map((s) => s[0]).slice(0, 2).join("").toUpperCase();
  return (
    <div className="relative" ref={ref}>
      <button className="flex items-center gap-2 rounded-md px-1.5 py-1 transition-colors hover:bg-muted" onClick={() => setOpen(!open)} aria-label="Account menu" aria-expanded={open}>
        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-brand text-[11px] font-semibold text-white dark:text-slate-900">{initials}</span>
        <span className="hidden text-left leading-tight sm:block"><span className="block text-[13px] font-medium">{me.name}</span><span className="block text-[11px] capitalize text-sub">{me.is_admin ? "Administrator" : me.role}</span></span>
      </button>
      {open && <div className="card anim-pop absolute right-0 z-40 mt-1 w-56 py-1 text-[13px] shadow-[var(--shadow-3)]">
        <div className="border-b px-3 py-2"><p className="font-medium">{me.name}</p><p className="truncate text-xs text-sub">{me.email}</p><p className="text-xs text-sub">{me.org.name}</p></div>
        <button className="flex w-full items-center gap-2 px-3 py-2 transition-colors hover:bg-muted" onClick={() => { setOpen(false); toggleTheme(); }}>{dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}{dark ? "Switch to light theme" : "Switch to dark theme"}</button>
        <button className="flex w-full items-center gap-2 px-3 py-2 transition-colors hover:bg-muted" onClick={() => { setOpen(false); showShortcuts(); }}><Command className="h-4 w-4" />Keyboard shortcuts</button>
        <button className="flex w-full items-center gap-2 px-3 py-2 transition-colors hover:bg-muted" onClick={() => { setOpen(false); changePassword(); }}><KeyRound className="h-4 w-4" />Change password</button>
        <button className="flex w-full items-center gap-2 px-3 py-2 transition-colors hover:bg-muted" onClick={onLogout}><LogOut className="h-4 w-4" />Sign out</button>
      </div>}
    </div>
  );
}

export function ModuleRoutes({ location }: { location: any }) {
  return (
    <Routes location={location}>
                <Route path="/admin" element={<AdminDashboard />} />
                <Route path="/login-activity" element={<LoginActivity />} />
                <Route path="/" element={<Dashboard />} />
                <Route path="/support" element={<AdminSupport />} />
                <Route path="/products" element={<Products />} />
                <Route path="/products/new" element={<ItemFormPage />} />
                <Route path="/products/:id" element={<ItemDetail />} />
                <Route path="/products/:id/edit" element={<ItemFormPage />} />
                <Route path="/customers" element={<PartyList kind="customer" />} />
                <Route path="/customers/new" element={<PartyForm kind="customer" />} />
                <Route path="/customers/:id" element={<PartyDetail kind="customer" />} />
                <Route path="/customers/:id/edit" element={<PartyForm kind="customer" />} />
                <Route path="/vendors" element={<PartyList kind="vendor" />} />
                <Route path="/vendors/new" element={<PartyForm kind="vendor" />} />
                <Route path="/vendors/:id" element={<PartyDetail kind="vendor" />} />
                <Route path="/vendors/:id/edit" element={<PartyForm kind="vendor" />} />
                <Route path="/purchase-orders" element={<POList />} />
                <Route path="/purchase-orders/new" element={<POForm />} />
                <Route path="/purchase-orders/:id" element={<PODetail />} />
                <Route path="/purchase-orders/:id/edit" element={<POForm />} />
                <Route path="/sales-orders" element={<SOList />} />
                <Route path="/sales-orders/new" element={<SOForm />} />
                <Route path="/sales-orders/:id" element={<SODetail />} />
                <Route path="/sales-orders/:id/edit" element={<SOForm />} />
                <Route path="/packages" element={<PackageList />} />
                <Route path="/shipments" element={<ShipmentList />} />
                <Route path="/shipments/:id" element={<ShipmentDetail />} />
                <Route path="/adjustments" element={<AdjList />} />
                <Route path="/adjustments/new" element={<AdjForm />} />
                <Route path="/adjustments/:id" element={<AdjDetail />} />
                <Route path="/reports" element={<ReportsHome />} />
                <Route path="/reports/:key" element={<ReportView />} />
                <Route path="/settings" element={<SettingsPage />} />
                <Route path="/inventory" element={<Inventory />} />
                <Route path="/warehouses" element={<Warehouses />} />
                <Route path="/warehouses/new" element={<WarehouseFormPage />} />
                <Route path="/warehouses/:id" element={<WarehouseDetail />} />
                <Route path="/warehouses/:id/edit" element={<WarehouseFormPage />} />
                <Route path="/transfers" element={<Transfers />} />
                <Route path="/insights" element={<Insights />} />
                <Route path="/team" element={<UsersPage />} />
                <Route path="*" element={<Navigate to="/" />} />
              </Routes>
  );
}

export const ADMIN_ONLY = new Set(["admin", "login-activity", "support"]);
export const ROUTE_MODULE: Record<string, string> = { products: "products", customers: "sales", "sales-orders": "sales", packages: "fulfilment", shipments: "fulfilment", vendors: "purchases", "purchase-orders": "purchases", adjustments: "inventory", inventory: "inventory", transfers: "inventory", insights: "inventory", warehouses: "warehouses", reports: "reports", team: "users", settings: "settings" };

function AccessDenied({ home }: { home: string }) {
  return (
    <div className="mx-auto max-w-md py-16 text-center" role="alert" data-testid="access-denied">
      <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-red-500/10"><ShieldAlert className="h-7 w-7 text-red-500" /></span>
      <h1 className="mt-4 text-xl font-semibold">Access denied</h1>
      <p className="mt-1 text-sm text-sub">Your account does not have permission to open this page. If you think this is a mistake, ask your administrator.</p>
      <NavLink to={home} className="btn-primary mt-5 inline-flex">Go to my dashboard</NavLink>
    </div>
  );
}

const CHORDS: Record<string, string> = { d: "/", p: "/products", c: "/customers", v: "/vendors", o: "/purchase-orders", j: "/adjustments", e: "/reports", s: "/settings", r: "/sales-orders", k: "/packages", h: "/shipments", i: "/inventory", w: "/warehouses", t: "/transfers", a: "/insights", u: "/team" };

function Shell({ me, onLogout }: { me: Me; onLogout: () => void }) {
  const [collapsed, setCollapsed] = useState(localStorage.getItem("sp_collapsed") === "1");
  const [dark, setDark] = useState(document.documentElement.classList.contains("dark"));
  const [pal, setPal] = useState(false); const [keys, setKeys] = useState(false);
  const go = useNavigate(); const loc = useLocation();
  const can = useCallback((m: string, l: "r" | "w" = "r") => { const h = me.permissions[m]; return !!h && (h === "w" || l === "r"); }, [me]);
  const has = useCallback((m: string, a: string) => me.is_admin || (me.actions?.[m] || []).includes(a), [me]);
  const nav = useMemo(() => NAV.filter((n) => (n.admin ? me.is_admin : !n.mod || can(n.mod))).map((n) => ({ ...n, to: ext(n.to, ADMIN) })), [can, me.is_admin]);
  const [pwOpen, setPwOpen] = useState(false); const [resetCount, setResetCount] = useState(0);
  useEffect(() => { if (!me.is_admin) return; const load = () => api("/password-requests", { background: true }).then((r) => setResetCount(r.length)).catch(() => {}); load(); const t = setInterval(() => { if (!document.hidden) load(); }, 30000); window.addEventListener("sp-requests-changed", load); return () => { clearInterval(t); window.removeEventListener("sp-requests-changed", load); }; }, [me.is_admin]);
  // server enforces everything; this only avoids showing pages the API would refuse
  const internalPath = underBase(loc.pathname, ADMIN) ? toInternal(loc.pathname, ADMIN) : "/";
  const seg = internalPath.split("/")[1] || ""; const tail = internalPath.split("/").pop() || "";
  const need = ADMIN_ONLY.has(seg) ? null : ROUTE_MODULE[seg];
  const denied = (ADMIN_ONLY.has(seg) && !me.is_admin) || (!!need && (!can(need) || (tail === "new" && !has(need, "create")) || (tail === "edit" && !has(need, "edit"))));
  useEffect(() => { localStorage.setItem("sp_collapsed", collapsed ? "1" : "0"); }, [collapsed]);
  const toggleTheme = useCallback(() => { setDark((d) => { const n = !d; document.documentElement.classList.toggle("dark", n); localStorage.setItem("sp_theme", n ? "dark" : "light"); return n; }); }, []);
  useEffect(() => {
    let chord = 0;
    const h = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setPal(true); return; }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if ((e.target as HTMLElement).closest("input,textarea,select,[contenteditable=true]") || document.querySelector("[role=dialog]")) return;
      if (e.key === "?") { e.preventDefault(); setKeys(true); return; }
      if (Date.now() < chord) { chord = 0; const to0 = CHORDS[e.key.toLowerCase()]; const to = to0 ? ext(to0, ADMIN) : undefined; if (to && nav.some((n) => n.to === to)) { e.preventDefault(); go(to); } return; }
      if (e.key.toLowerCase() === "g") chord = Date.now() + 1200;
    };
    window.addEventListener("keydown", h); return () => window.removeEventListener("keydown", h);
  }, [nav, go]);
  if (!underBase(loc.pathname, ADMIN)) return <Navigate to={(loc.pathname.startsWith("/user") ? "/admin/dashboard" : redirectFor(loc.pathname, ADMIN)) + loc.search} replace />;
  let lastGroup = "";
  return (
    <MeCtx.Provider value={{ me, can, has }}>
      <NavProgress />
      <div className="flex min-h-screen">
        <aside className={`sticky top-0 hidden h-screen shrink-0 flex-col border-r bg-surface transition-[width] duration-300 ease-out md:flex ${collapsed ? "w-16" : "w-60"}`}>
          <div className="flex h-14 items-center gap-2.5 overflow-hidden border-b px-4"><Boxes className="h-6 w-6 shrink-0 text-brand" /><span className={`whitespace-nowrap text-[18px] font-bold tracking-tight transition-opacity duration-200 ${collapsed ? "opacity-0" : "opacity-100"}`}>StockPilot</span></div>
          <nav className="flex-1 overflow-y-auto overflow-x-hidden py-2">
            {nav.map((n) => {
              const head = n.group !== lastGroup && n.group ? n.group : ""; lastGroup = n.group;
              return (
                <div key={n.to}>
                  {head && <><p className={`overflow-hidden whitespace-nowrap px-4 text-[11px] font-bold uppercase tracking-wider text-brand/80 transition-all duration-200 ${collapsed ? "max-h-0 pb-0 pt-0 opacity-0" : "max-h-9 pb-1.5 pt-4 opacity-100"}`}>{head}</p>
                    <div className={`mx-3 border-t transition-all duration-200 ${collapsed ? "my-2 opacity-100" : "my-0 h-0 border-0 opacity-0"}`} /></>}
                  <NavLink to={n.to} title={collapsed ? n.label : undefined} aria-label={n.label}
                    className={({ isActive }) => `group flex items-center gap-2.5 border-l-[3px] py-2.5 pl-[0.95rem] pr-3 text-[14.5px] transition-all duration-200 ${isActive ? "border-brand bg-brand/15 font-semibold text-brand" : "border-transparent font-medium text-ink hover:bg-brand/10 hover:pl-5"}`}>
                    <n.icon className="h-5 w-5 shrink-0 text-brand transition-transform duration-200 group-hover:scale-110" />
                    <span className={`overflow-hidden whitespace-nowrap transition-all duration-200 ${collapsed ? "max-w-0 opacity-0" : "max-w-[13rem] opacity-100"}`}>{n.label}</span>{n.to === ext("/team", ADMIN) && resetCount > 0 && <span data-testid="reset-badge" title={`${resetCount} password reset request${resetCount === 1 ? "" : "s"} waiting`} className="ml-auto rounded-full bg-amber-500 px-1.5 text-[10px] font-bold text-white">{resetCount}</span>}</NavLink>
                </div>);
            })}
          </nav>
          <button className="flex items-center gap-2 overflow-hidden whitespace-nowrap border-t px-4 py-3 text-[13px] font-medium text-ink/70 transition-colors hover:bg-brand/10 hover:text-brand" onClick={() => setCollapsed(!collapsed)} aria-label="Toggle sidebar" title={collapsed ? "Expand menu" : "Collapse menu"}>
            <ChevronsLeft className={`h-4 w-4 shrink-0 transition-transform duration-300 ${collapsed ? "rotate-180" : ""}`} /><span className={`transition-opacity duration-200 ${collapsed ? "opacity-0" : "opacity-100"}`}>Collapse menu</span></button>
        </aside>
        <div className="min-w-0 flex-1">
          <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b bg-surface/95 px-4 backdrop-blur">
            <button className="flex w-full max-w-md items-center gap-2 rounded-md border bg-bg px-3 py-2 text-left text-[14px] text-sub transition-all hover:border-sub/40 hover:bg-surface hover:shadow-[var(--shadow-1)]" onClick={() => setPal(true)}>
              <Search className="h-4 w-4" /><span className="flex-1">Search items, SKUs, pages…</span><kbd className="hidden items-center gap-0.5 rounded border bg-surface px-1 text-[10px] sm:flex"><Command className="h-2.5 w-2.5" />K</kbd></button>
            <div className="ml-auto flex items-center gap-1">
              <span className="mr-2 hidden text-[13px] text-sub lg:block">{me.org.name}</span>
              <Bells />
              {can("settings") && <button className="btn-ghost !border-transparent !bg-transparent !px-2 hover:!bg-muted" data-tip="Settings" onClick={() => go(ext("/settings", ADMIN))} aria-label="Settings"><Settings className="h-4 w-4" /></button>}
              <ProfileMenu me={me} dark={dark} toggleTheme={toggleTheme} onLogout={onLogout} showShortcuts={() => setKeys(true)} changePassword={() => setPwOpen(true)} />
            </div>
          </header>
          <nav className="flex gap-1 overflow-x-auto border-b bg-surface px-2 py-1.5 md:hidden" data-noswipe>{nav.map((n) => <NavLink key={n.to} to={n.to} end={n.to === "/"} className={({ isActive }) => `whitespace-nowrap rounded px-3 py-1.5 text-[14px] font-medium transition-colors ${isActive ? "bg-brand/15 text-brand" : "text-ink"}`}>{n.label}</NavLink>)}</nav>
          <main className="mx-auto max-w-[1400px] p-4 md:px-6">
            <div key={loc.pathname} className="anim-up">
              {denied ? <AccessDenied home={me.home} /> : <ModuleRoutes location={{ ...loc, pathname: internalPath }} />}
            </div>
          </main>
        </div>
        {can("inventory") && <Assistant />}
        {pal && <Palette onClose={() => setPal(false)} nav={nav} can={can} toggleTheme={toggleTheme} showShortcuts={() => setKeys(true)} />}
        {keys && <ShortcutsDialog onClose={() => setKeys(false)} />}
        {pwOpen && <ChangePasswordModal onClose={() => setPwOpen(false)} />}
      </div>
    </MeCtx.Provider>
  );
}

export default function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [ready, setReady] = useState(false);
  const toast = useToast(); const go = useNavigate();
  const load = useCallback(async () => {
    if (!tokens.access) { setMe(null); setReady(true); return null; }
    try { const m = await api("/auth/me"); setMe(m); return m as Me; } catch { setMe(null); return null; } finally { setReady(true); }
  }, []);
  useEffect(() => { const r = () => api("/auth/me").then(setMe).catch(() => {}); window.addEventListener("sp-me-changed", r); return () => window.removeEventListener("sp-me-changed", r); }, []);
  useEffect(() => { load(); const h = () => setMe(null); window.addEventListener("sp-logout", h); return () => window.removeEventListener("sp-logout", h); }, [load]);
  // pick up permission changes made by an administrator while the user is working
  useEffect(() => { if (!me) return; const t = setInterval(() => api("/auth/me", { background: true }).then((m) => setMe((o) => (o && JSON.stringify(o.actions) === JSON.stringify(m.actions) && o.role === m.role ? o : m))).catch(() => {}), 60000); return () => clearInterval(t); }, [!!me]);
  const logout = async () => { const r = tokens.refresh; if (r) await api("/auth/logout", { body: { refresh_token: r } }).catch(() => {}); tokens.clear(); setMe(null); go("/"); toast("Signed out"); };
  if (!ready) return <div className="p-10 text-sm text-sub">Loading…</div>;
  if (!me) return (
    <Routes>
      <Route path="/forgot-password" element={<ForgotPage />} />
      <Route path="/reset-password" element={<ResetPage />} />
      <Route path="*" element={<LoginPage onDone={async () => { const m = await load(); go(m?.must_change_password ? "/" : m?.home || "/"); }} />} />
    </Routes>);
  if (me.must_change_password) return <ForcedPasswordChange onDone={async () => { const m = await load(); go(m?.home || "/"); }} onLogout={logout} />;
  return me.is_admin ? <Shell key={me.id} me={me} onLogout={logout} /> : <MeProvider me={me}><UserPortal key={me.id} me={me} onLogout={logout} reloadMe={load} /></MeProvider>;
}
