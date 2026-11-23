import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { Link, NavLink, Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { Boxes, Briefcase, CreditCard, FileText, History, KeyRound, LayoutDashboard, LifeBuoy, LogOut, Moon, Package, ShoppingBag, ShoppingCart, Trash2, Bot, Send, X, Sparkles, Sun, UserCircle, Warehouse as Stock, ShieldAlert } from "lucide-react";
import { api, dt, download, fmt, money } from "../api";
import { ChangePasswordModal } from "../Auth";
import { ADMIN_ONLY, ModuleRoutes, ROUTE_MODULE, useMe, type Me } from "../App";
import { useDismiss } from "../fx";
import { WORK, redirectFor, toInternal, underBase } from "../portalPaths";
import { Badge, Empty, Modal, Skeleton, useLoad, useToast } from "../ui";
import { useRef } from "react";

const NAV = [
  { to: "/user/dashboard", label: "Dashboard", icon: LayoutDashboard }, { to: "/user/products", label: "Products", icon: ShoppingBag },
  { to: "/user/stock-availability", label: "Stock availability", icon: Stock }, { to: "/user/orders", label: "My orders", icon: Package },
  { to: "/user/purchase-history", label: "Purchase history", icon: History }, { to: "/user/invoices", label: "Invoices", icon: FileText },
  { to: "/user/payments", label: "Payments", icon: CreditCard }, { to: "/user/support", label: "Support", icon: LifeBuoy }, { to: "/user/profile", label: "Profile", icon: UserCircle },
];
type CartItem = { id: number; name: string; sku: string; price: number; tax_rate: number; unit: string; available: number; qty: number };
const CartCtx = createContext<{ items: CartItem[]; add: (p: any, qty: number) => void; setQty: (id: number, q: number) => void; remove: (id: number) => void; clear: () => void; count: number } | null>(null);
const useCart = () => useContext(CartCtx)!;
function CartProvider({ uid, children }: { uid: number; children: React.ReactNode }) {
  const key = `sp_cart_${uid}`;
  const [items, setItems] = useState<CartItem[]>(() => { try { return JSON.parse(localStorage.getItem(key) || "[]"); } catch { return []; } });
  useEffect(() => { try { localStorage.setItem(key, JSON.stringify(items)); } catch { /* storage blocked */ } }, [items, key]);
  const add = (p: any, qty: number) => setItems((cur) => { const e = cur.find((x) => x.id === p.id); const q = Math.min((e?.qty || 0) + qty, p.available);
    return e ? cur.map((x) => (x.id === p.id ? { ...x, qty: q, available: p.available, price: p.price } : x)) : [...cur, { id: p.id, name: p.name, sku: p.sku, price: p.price, tax_rate: p.tax_rate, unit: p.unit, available: p.available, qty: q }]; });
  const value = { items, add, setQty: (id: number, q: number) => setItems((c) => c.map((x) => (x.id === id ? { ...x, qty: Math.max(0, Math.min(q, x.available)) } : x))), remove: (id: number) => setItems((c) => c.filter((x) => x.id !== id)), clear: () => setItems([]), count: items.reduce((n, x) => n + (x.qty > 0 ? 1 : 0), 0) };
  return <CartCtx.Provider value={value}>{children}</CartCtx.Provider>;
}

const newKey = () => (globalThis.crypto && "randomUUID" in globalThis.crypto ? globalThis.crypto.randomUUID() : `k${Date.now()}${Math.random().toString(36).slice(2)}`);
const TONE: Record<string, "ok" | "warn" | "bad" | "neutral" | "info"> = { confirmed: "info", packed: "warn", shipped: "info", delivered: "ok", cancelled: "bad", in_stock: "ok", low_stock: "warn", out_of_stock: "bad", open: "warn", answered: "ok", closed: "neutral", posted: "ok" };
const AVAIL: Record<string, string> = { in_stock: "In stock", low_stock: "Low stock", out_of_stock: "Out of stock" };
const d8 = (s?: string) => (s ? new Date(s).toLocaleDateString("en-IN", { dateStyle: "medium" }) : "—");

function Pager({ page, total, size, set }: { page: number; total: number; size: number; set: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / size)); if (total <= size) return null;
  return <div className="flex items-center justify-between pt-3 text-[13px] text-sub"><span>{total} records</span><span className="flex items-center gap-2"><button className="btn-ghost !px-2" disabled={page <= 1} onClick={() => set(page - 1)} aria-label="Previous page">‹</button>Page {page} of {pages}<button className="btn-ghost !px-2" disabled={page >= pages} onClick={() => set(page + 1)} aria-label="Next page">›</button></span></div>;
}
const Title = ({ children, sub }: { children: React.ReactNode; sub?: string }) => <div className="mb-4"><h1 className="text-xl font-semibold">{children}</h1>{sub && <p className="text-[13px] text-sub">{sub}</p>}</div>;
const NotLinked = () => <div className="card"><Empty title="No customer account linked" hint="Your sign-in is not connected to a customer record yet. Please contact support." /></div>;

function Dashboard({ me }: { me: Me }) {
  const s = useLoad(() => api("/portal/summary")); const cat = useLoad(() => api("/portal/products?page_size=6"));
  const hour = new Date().getHours(); const greet = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  return (
    <div className="space-y-5" data-testid="user-dashboard">
      <div className="rounded-2xl bg-gradient-to-r from-teal-600 to-emerald-500 p-6 text-white"><h1 className="text-2xl font-semibold">{greet}, {me.name.split(" ")[0]}</h1><p className="mt-1 text-sm text-teal-50">Browse products, track your orders and download invoices.</p></div>
      {s.loading ? <Skeleton rows={3} /> : !s.data?.linked ? <NotLinked /> : <>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{[["My orders", fmt(s.data.orders), `${s.data.open_orders} open`], ["Total purchased", money(s.data.total_purchased), "incl. GST"], ["Outstanding balance", money(s.data.outstanding), `${money(s.data.paid)} paid`], ["Shipments in progress", fmt(s.data.active_shipments), "on the way"]].map(([l, v, sub]) =>
          <div key={l} className="card p-4"><p className="text-xs text-sub">{l}</p><p className="mt-1 text-2xl font-semibold tabular-nums">{v}</p><p className="text-xs text-sub">{sub}</p></div>)}</div>
        <section className="card p-4"><div className="mb-2 flex justify-between"><h2 className="text-[13px] font-semibold">Recent orders</h2><Link to="/user/orders" className="text-xs text-brand hover:underline">All orders</Link></div>
          {!s.data.recent_orders.length ? <Empty title="No orders yet" hint="Your orders will appear here once placed with us." /> : <ul className="divide-y">{s.data.recent_orders.map((o: any) => <li key={o.id} className="flex items-center gap-3 py-2 text-[13px]"><Link className="font-medium text-brand hover:underline" to={`/user/orders?open=${o.id}`}>{o.number}</Link><span className="flex-1 text-sub">{d8(o.date)}</span><Badge tone={TONE[o.status] || "neutral"}>{o.status}</Badge><span className="w-24 text-right tabular-nums">{money(o.total)}</span></li>)}</ul>}</section></>}
      <section className="card p-4"><div className="mb-2 flex justify-between"><h2 className="text-[13px] font-semibold">Available products</h2><Link to="/user/products" className="text-xs text-brand hover:underline">View catalogue</Link></div>
        {!cat.data?.items.length ? <Empty title="No products available" /> : <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">{cat.data.items.map((p: any) => <div key={p.id} className="flex items-center justify-between rounded-lg border p-3 text-[13px]"><span><b className="font-medium">{p.name}</b><span className="block text-xs text-sub">{p.sku}</span></span><span className="text-right"><span className="block font-medium">{money(p.price)}</span><Badge tone={TONE[p.availability]}>{AVAIL[p.availability]}</Badge></span></div>)}</div>}</section>
    </div>
  );
}

function Catalogue({ stock }: { stock?: boolean }) {
  const cart = useCart(); const toast = useToast(); const [qtys, setQtys] = useState<Record<number, number>>({});
  const [q, setQ] = useState(""); const [av, setAv] = useState(""); const [page, setPage] = useState(1);
  const d = useLoad(() => api(`/portal/products?page=${page}&page_size=20${q ? `&q=${encodeURIComponent(q)}` : ""}${av ? `&availability=${av}` : ""}`), [q, av, page]);
  return (
    <div data-testid={stock ? "portal-stock" : "portal-products"}><Title sub={stock ? "Live availability across all our warehouses." : "Prices include no GST; GST is added on your invoice."}>{stock ? "Stock availability" : "Products"}</Title>
      <div className="mb-3 flex flex-wrap gap-2"><input className="input min-w-56 flex-1" placeholder="Search by name or SKU" aria-label="Search products" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} />
        <select className="input !w-auto" aria-label="Availability" value={av} onChange={(e) => { setAv(e.target.value); setPage(1); }}><option value="">Any availability</option>{Object.entries(AVAIL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div>
      <div className="card overflow-x-auto">{d.loading && !d.data ? <Skeleton rows={6} /> : !d.data?.items.length ? <Empty title="No products found" /> : <table className="w-full"><thead className="border-b bg-muted/50"><tr>{["Product", "SKU", ...(stock ? ["Available"] : ["Price"]), "Availability", ...(stock ? [] : [""])].map((h) => <th key={h} className="th">{h}</th>)}</tr></thead>
        <tbody className="divide-y">{d.data.items.map((p: any) => <tr key={p.id}><td className="td"><div className="font-medium">{p.name}</div>{p.description && <div className="max-w-md truncate text-xs text-sub">{p.description}</div>}</td><td className="td">{p.sku}</td>
          <td className="td tabular-nums">{stock ? `${fmt(p.available)} ${p.unit}` : <>{money(p.price)} <span className="text-xs text-sub">/ {p.unit}</span></>}</td><td className="td"><Badge tone={TONE[p.availability]}>{AVAIL[p.availability]}</Badge></td>
          {!stock && <td className="td"><div className="flex items-center gap-1.5"><input type="number" min={1} max={p.available} step="any" className="input !w-20 !py-1" aria-label={`Quantity of ${p.name}`} disabled={p.availability === "out_of_stock"} value={qtys[p.id] ?? 1} onChange={(e) => setQtys({ ...qtys, [p.id]: +e.target.value })} />
            <button className="btn-primary !px-2.5 !py-1" disabled={p.availability === "out_of_stock" || !(qtys[p.id] ?? 1)} aria-label={`Add ${p.name} to cart`} onClick={() => { const n = qtys[p.id] ?? 1; if (n > p.available) { toast(`Only ${p.available} available`, "err"); return; } cart.add(p, n); toast(`${p.name} added to cart`); }}><ShoppingCart className="h-4 w-4" />Add</button></div></td>}</tr>)}</tbody></table>}</div>
      {d.data && <Pager page={page} total={d.data.total} size={20} set={setPage} />}</div>
  );
}

const PAY_ICON: Record<string, string> = { cod: "Cash on delivery", bank_transfer: "Bank transfer", on_account: "Pay later", online: "Card / UPI / Net banking" };
function CartPage() {
  const cart = useCart(); const toast = useToast(); const go = useNavigate();
  const prof = useLoad(() => api("/portal/me")); const opts = useLoad(() => api("/portal/payment-options"));
  const [dv, setDv] = useState({ name: "", phone: "", address: "", city: "", state: "", pincode: "" }); const [pay, setPay] = useState(""); const [save, setSave] = useState(true); const [notes, setNotes] = useState("");
  const [touched, setTouched] = useState(false); const [busy, setBusy] = useState(false); const [err, setErr] = useState(""); const [key, setKey] = useState(newKey);
  useEffect(() => { const d = prof.data; if (d) setDv((o) => ({ name: o.name || d.name || "", phone: o.phone || d.phone || "", address: o.address || d.customer?.address || "", city: o.city || d.customer?.city || "", state: o.state || d.customer?.state || "", pincode: o.pincode || d.customer?.pincode || "" })); }, [prof.data]);
  const lines = cart.items.filter((x) => x.qty > 0);
  const sub = lines.reduce((s, x) => s + x.qty * x.price, 0), tax = lines.reduce((s, x) => s + x.qty * x.price * x.tax_rate / 100, 0);
  const problems: Record<string, string> = {};
  if (dv.name.trim().length < 2) problems.name = "Enter the receiver's name";
  if (!/^\+?\d[\d\s-]{7,14}$/.test(dv.phone.trim())) problems.phone = "Enter a valid phone number";
  if (dv.address.trim().length < 5) problems.address = "Enter the street address";
  if (dv.city.trim().length < 2) problems.city = "Enter the city";
  if (dv.state.trim().length < 2) problems.state = "Enter the state";
  if (!/^\d{6}$/.test(dv.pincode.trim())) problems.pincode = "PIN code must be 6 digits";
  if (!pay) problems.pay = "Choose how you will pay";
  const place = async () => {
    setTouched(true); setErr("");
    if (Object.keys(problems).length) { setErr("Please complete the delivery address and choose a payment option."); return; }
    setBusy(true);
    try {
      const r = await api("/portal/orders", { body: { items: lines.map((x) => ({ product_id: x.id, quantity: x.qty })), delivery: Object.fromEntries(Object.entries(dv).map(([k, v]) => [k, v.trim()])), payment_method: pay, save_address: save, notes: notes || undefined, client_key: key } });
      cart.clear(); setKey(newKey()); toast(`Order ${r.number} placed`); go(`/user/orders?open=${r.id}`);
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  const fld = (k: keyof typeof dv, label: string, props: any = {}) => <div className={props.wide ? "sm:col-span-2" : ""}><label className="label" htmlFor={`dv-${k}`}>{label} *</label><input id={`dv-${k}`} className={`input ${touched && problems[k] ? "!border-red-500" : ""}`} aria-label={label} value={dv[k]} onChange={(e) => setDv({ ...dv, [k]: e.target.value })} inputMode={props.numeric ? "numeric" : undefined} maxLength={props.max} />{touched && problems[k] && <p className="mt-0.5 text-xs text-red-600" role="alert">{problems[k]}</p>}</div>;
  return (
    <div data-testid="portal-cart"><Title sub="Review your items, enter where to deliver, choose how you will pay, then place the order.">Checkout</Title>
      {!lines.length ? <div className="card"><Empty title="Your cart is empty" action={<Link to="/user/products" className="btn-primary">Browse products</Link>} /></div> : <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <div className="card overflow-x-auto"><table className="w-full"><thead className="border-b bg-muted/50"><tr>{["Product", "Price", "Qty", "Amount", ""].map((h) => <th key={h} className="th">{h}</th>)}</tr></thead>
            <tbody className="divide-y">{lines.map((x) => <tr key={x.id} data-cart-line={x.sku}><td className="td"><div className="font-medium">{x.name}</div><div className="text-xs text-sub">{x.sku} · {x.available} {x.unit} available</div></td><td className="td tabular-nums">{money(x.price)}</td>
              <td className="td"><input type="number" min={1} max={x.available} step="any" className="input !w-24 !py-1" aria-label={`Cart quantity of ${x.name}`} value={x.qty} onChange={(e) => cart.setQty(x.id, +e.target.value)} /></td><td className="td tabular-nums">{money(x.qty * x.price)}</td>
              <td className="td"><button className="rounded p-1.5 text-red-600 hover:bg-muted" aria-label={`Remove ${x.name}`} onClick={() => cart.remove(x.id)}><Trash2 className="h-4 w-4" /></button></td></tr>)}</tbody></table></div>
          <section className="card p-4" data-testid="checkout-address"><h2 className="mb-3 text-[13px] font-semibold">1 · Delivery address</h2>
            <div className="grid gap-3 sm:grid-cols-2">{fld("name", "Receiver name")}{fld("phone", "Phone number", { max: 16 })}{fld("address", "Address (house no., street, area)", { wide: true, max: 200 })}{fld("city", "City")}{fld("state", "State")}{fld("pincode", "PIN code", { numeric: true, max: 6 })}</div>
            <label className="mt-3 flex items-center gap-2 text-[13px]"><input type="checkbox" checked={save} onChange={(e) => setSave(e.target.checked)} />Save as my default delivery address</label></section>
          <section className="card p-4" data-testid="checkout-payment"><h2 className="mb-3 text-[13px] font-semibold">2 · Payment option</h2>
            <div className="space-y-2" role="radiogroup" aria-label="Payment option">{(opts.data?.options || []).map((o: any) => (
              <label key={o.key} className={`flex gap-3 rounded-lg border p-3 text-[13px] ${!o.available ? "cursor-not-allowed opacity-60" : "cursor-pointer hover:bg-muted"} ${pay === o.key ? "border-brand bg-brand/5" : ""}`}>
                <input type="radio" name="pay" className="mt-1" disabled={!o.available} checked={pay === o.key} onChange={() => setPay(o.key)} aria-label={o.label} />
                <span><span className="flex items-center gap-2 font-medium">{o.label}{!o.available && <Badge tone="neutral">Not available yet</Badge>}</span><span className="block text-xs text-sub">{o.hint}</span></span></label>))}</div>
            {touched && problems.pay && <p className="mt-1 text-xs text-red-600" role="alert">{problems.pay}</p>}</section>
        </div>
        <div className="card h-fit space-y-3 p-4 text-[13px]">
          <h2 className="text-[13px] font-semibold">Order summary</h2>
          <div><label className="label">Notes (optional)</label><input className="input" aria-label="Order notes" value={notes} onChange={(e) => setNotes(e.target.value)} /></div>
          <dl className="space-y-1 border-t pt-3"><div className="flex justify-between"><dt className="text-sub">Subtotal</dt><dd className="tabular-nums">{money(sub)}</dd></div><div className="flex justify-between"><dt className="text-sub">GST (estimate)</dt><dd className="tabular-nums">{money(tax)}</dd></div><div className="flex justify-between text-base font-semibold"><dt>Total</dt><dd className="tabular-nums">{money(sub + tax)}</dd></div></dl>
          <p className="text-xs text-sub">The server calculates the final amount from current prices. Stock is reserved when you place the order.</p>
          {err && <p role="alert" className="rounded-lg bg-red-500/10 p-2 text-red-600">{err}</p>}
          <button className={`btn-primary w-full !py-2.5 ${busy ? "btn-loading" : ""}`} disabled={busy} onClick={place}>Place order</button></div></div>}</div>
  );
}

function Orders() {
  const [page, setPage] = useState(1); const [open, setOpen] = useState<number | null>(new URLSearchParams(useLocation().search).get("open") ? +new URLSearchParams(useLocation().search).get("open")! : null);
  const d = useLoad(() => api(`/portal/orders?page=${page}`), [page]);
  return (
    <div data-testid="portal-orders"><Title sub="Orders placed for your account.">My orders</Title>
      <div className="card overflow-x-auto">{d.loading && !d.data ? <Skeleton rows={5} /> : !d.data?.items.length ? <Empty title="No orders yet" /> : <table className="w-full"><thead className="border-b bg-muted/50"><tr>{["Order", "Date", "Expected", "Items", "Status", "Total", ""].map((h) => <th key={h} className="th">{h}</th>)}</tr></thead>
        <tbody className="divide-y">{d.data.items.map((o: any) => <tr key={o.id} data-order={o.number}><td className="td font-medium">{o.number}</td><td className="td">{d8(o.date)}</td><td className="td">{d8(o.expected)}</td><td className="td">{o.items}</td><td className="td"><Badge tone={TONE[o.status] || "neutral"}>{o.status}</Badge></td><td className="td tabular-nums">{money(o.total)}</td><td className="td"><button className="btn-ghost !px-2 !py-1" onClick={() => setOpen(o.id)}>Details</button></td></tr>)}</tbody></table>}</div>
      {d.data && <Pager page={page} total={d.data.total} size={20} set={setPage} />}
      {open !== null && <OrderModal id={open} onClose={() => setOpen(null)} />}</div>
  );
}

function OrderModal({ id, onClose }: { id: number; onClose: () => void }) {
  const toast = useToast(); const d = useLoad(() => api(`/portal/orders/${id}`), [id]);
  return (
    <Modal title={d.data ? `Order ${d.data.number}` : "Order"} onClose={onClose} wide>
      {!d.data ? (d.error ? <p className="text-red-500">{d.error}</p> : <Skeleton rows={4} />) : <div className="space-y-4 text-[13px]">
        <div className="flex flex-wrap items-center gap-3"><Badge tone={TONE[d.data.status] || "neutral"}>{d.data.status}</Badge><span className="text-sub">Ordered {d8(d.data.date)} · expected {d8(d.data.expected)}</span>
          {["confirmed", "packed", "shipped", "delivered"].includes(d.data.status) && <button className="btn-ghost ml-auto" onClick={() => download(`/portal/orders/${id}/invoice.pdf`, `${d.data.number}.pdf`).catch((e) => toast(e.message, "err"))}><FileText className="h-4 w-4" />Invoice PDF</button>}</div>
        {d.data.ship_to && <p><span className="text-xs text-sub">Delivering to</span><br />{d.data.ship_to}</p>}{d.data.payment_method && <p><span className="text-xs text-sub">Payment</span><br />{d.data.payment_method}</p>}
        <table className="w-full"><thead className="bg-muted/50"><tr>{["Item", "Qty", "Shipped", "Rate", "Amount"].map((h) => <th key={h} className="th">{h}</th>)}</tr></thead><tbody className="divide-y">{d.data.lines.map((l: any, i: number) => <tr key={i}><td className="td">{l.name}<span className="block text-xs text-sub">{l.sku}</span></td><td className="td">{l.quantity} {l.unit}</td><td className="td">{l.shipped}</td><td className="td tabular-nums">{money(l.rate)}</td><td className="td tabular-nums">{money(l.amount)}</td></tr>)}</tbody></table>
        <dl className="ml-auto w-56 space-y-1"><div className="flex justify-between"><dt className="text-sub">Subtotal</dt><dd>{money(d.data.subtotal)}</dd></div><div className="flex justify-between"><dt className="text-sub">GST</dt><dd>{money(d.data.tax)}</dd></div><div className="flex justify-between font-semibold"><dt>Total</dt><dd>{money(d.data.total)}</dd></div></dl>
        <section><h3 className="mb-1 font-semibold">Shipments</h3>{!d.data.shipments.length ? <p className="text-sub">Not shipped yet.</p> : <ul className="divide-y rounded-lg border">{d.data.shipments.map((s: any) => <li key={s.number} className="flex flex-wrap gap-x-4 p-2"><b className="font-medium">{s.number}</b><span>{s.carrier}</span><span className="text-sub">{s.tracking_number || "no tracking number"}</span><Badge tone="info">{String(s.status).replace(/_/g, " ")}</Badge><span className="text-sub">expected {d8(s.expected_delivery)}</span></li>)}</ul>}</section>
      </div>}
    </Modal>
  );
}

function PurchaseHistory() {
  const [page, setPage] = useState(1); const d = useLoad(() => api(`/portal/purchase-history?page=${page}`), [page]);
  return (
    <div data-testid="portal-history"><Title sub={d.data ? `Total spent ${money(d.data.total_spent)} (incl. GST)` : "Everything you have bought."}>Purchase history</Title>
      <div className="card overflow-x-auto">{d.loading && !d.data ? <Skeleton rows={5} /> : !d.data?.items.length ? <Empty title="No purchases yet" /> : <table className="w-full"><thead className="border-b bg-muted/50"><tr>{["Date", "Order", "Item", "Qty", "Rate", "Amount", "Status"].map((h) => <th key={h} className="th">{h}</th>)}</tr></thead>
        <tbody className="divide-y">{d.data.items.map((l: any, i: number) => <tr key={i}><td className="td">{d8(l.date)}</td><td className="td">{l.order}</td><td className="td">{l.name}<span className="block text-xs text-sub">{l.sku}</span></td><td className="td">{l.quantity} {l.unit}</td><td className="td tabular-nums">{money(l.rate)}</td><td className="td tabular-nums">{money(l.amount)}</td><td className="td"><Badge tone={TONE[l.status] || "neutral"}>{l.status}</Badge></td></tr>)}</tbody></table>}</div>
      {d.data && <Pager page={page} total={d.data.total} size={25} set={setPage} />}</div>
  );
}

function Invoices() {
  const toast = useToast(); const d = useLoad(() => api("/portal/invoices"));
  return (
    <div data-testid="portal-invoices"><Title sub="Tax invoices for your confirmed orders.">Invoices</Title>
      <div className="card overflow-x-auto">{d.loading ? <Skeleton rows={4} /> : !d.data?.length ? <Empty title="No invoices yet" hint="An invoice is available once an order is confirmed." /> : <table className="w-full"><thead className="border-b bg-muted/50"><tr>{["Invoice", "Date", "Taxable", "GST", "Total", "Status", ""].map((h) => <th key={h} className="th">{h}</th>)}</tr></thead>
        <tbody className="divide-y">{d.data.map((i: any) => <tr key={i.id}><td className="td font-medium">{i.number}</td><td className="td">{d8(i.date)}</td><td className="td tabular-nums">{money(i.taxable)}</td><td className="td tabular-nums">{money(i.tax)}</td><td className="td tabular-nums">{money(i.total)}</td><td className="td"><Badge tone={TONE[i.status] || "neutral"}>{i.status}</Badge></td>
          <td className="td"><button className="btn-ghost !px-2 !py-1" onClick={() => download(`/portal/orders/${i.id}/invoice.pdf`, `${i.number}.pdf`).catch((e) => toast(e.message, "err"))}>PDF</button></td></tr>)}</tbody></table>}</div></div>
  );
}

function Payments() {
  const d = useLoad(() => api("/portal/payments"));
  return (
    <div data-testid="portal-payments"><Title sub="Payments received from you and your balance.">Payments</Title>
      {d.data && <div className="mb-3 grid grid-cols-3 gap-3">{[["Billed", d.data.billed], ["Paid", d.data.paid], ["Outstanding", d.data.outstanding]].map(([l, v]: any) => <div key={l} className="card p-4"><p className="text-xs text-sub">{l}</p><p className="text-xl font-semibold tabular-nums">{money(v)}</p></div>)}</div>}
      <div className="card overflow-x-auto">{d.loading ? <Skeleton rows={4} /> : !d.data?.items.length ? <Empty title="No payments recorded" /> : <table className="w-full"><thead className="border-b bg-muted/50"><tr>{["Receipt", "Date", "Method", "Reference", "Amount", "Status"].map((h) => <th key={h} className="th">{h}</th>)}</tr></thead>
        <tbody className="divide-y">{d.data.items.map((p: any) => <tr key={p.number}><td className="td font-medium">{p.number}</td><td className="td">{d8(p.date)}</td><td className="td">{String(p.method).replace(/_/g, " ")}</td><td className="td">{p.reference || "—"}</td><td className="td tabular-nums">{money(p.amount)}</td><td className="td"><Badge tone={TONE[p.status] || "neutral"}>{p.status}</Badge></td></tr>)}</tbody></table>}</div></div>
  );
}

function Support() {
  const toast = useToast(); const d = useLoad(() => api("/portal/support")); const [f, setF] = useState({ subject: "", message: "" }); const [busy, setBusy] = useState(false);
  const send = async (e: React.FormEvent) => { e.preventDefault(); setBusy(true); try { await api("/portal/support", { body: f }); setF({ subject: "", message: "" }); toast("Request sent"); d.reload(); } catch (x: any) { toast(x.message, "err"); } finally { setBusy(false); } };
  return (
    <div data-testid="portal-support"><Title sub="Ask a question or report a problem. Our team replies here.">Support</Title>
      <form onSubmit={send} className="card mb-4 space-y-3 p-4"><input required minLength={3} className="input" placeholder="Subject" aria-label="Subject" value={f.subject} onChange={(e) => setF({ ...f, subject: e.target.value })} /><textarea required minLength={5} rows={3} className="input" placeholder="How can we help?" aria-label="Message" value={f.message} onChange={(e) => setF({ ...f, message: e.target.value })} /><div className="flex justify-end"><button className={`btn-primary ${busy ? "btn-loading" : ""}`} disabled={busy}>Send request</button></div></form>
      <div className="space-y-2">{!d.data?.length ? <div className="card"><Empty title="No requests yet" /></div> : d.data.map((t: any) => <div key={t.id} className="card p-4 text-[13px]"><div className="flex items-center justify-between"><b className="font-medium">{t.subject}</b><Badge tone={TONE[t.status]}>{t.status}</Badge></div><p className="mt-1 whitespace-pre-wrap text-sub">{t.message}</p><p className="text-xs text-sub">{dt(t.created_at)}</p>{t.reply && <div className="mt-2 rounded-lg bg-muted p-2.5"><p className="text-xs font-medium text-brand">Reply · {dt(t.replied_at)}</p><p className="whitespace-pre-wrap">{t.reply}</p></div>}</div>)}</div></div>
  );
}

function Profile({ me, reload }: { me: Me; reload: () => void }) {
  const toast = useToast(); const d = useLoad(() => api("/portal/me")); const [f, setF] = useState<any>(null); const [pw, setPw] = useState(false); const [busy, setBusy] = useState(false);
  useEffect(() => { if (d.data && !f) setF({ name: d.data.name, phone: d.data.phone || "", address: d.data.customer?.address || "", city: d.data.customer?.city || "", state: d.data.customer?.state || "", pincode: d.data.customer?.pincode || "" }); }, [d.data]);
  const save = async (e: React.FormEvent) => { e.preventDefault(); setBusy(true); try { await api("/portal/profile", { method: "PATCH", body: f }); toast("Profile saved"); reload(); } catch (x: any) { toast(x.message, "err"); } finally { setBusy(false); } };
  if (!f || !d.data) return <Skeleton rows={5} />;
  return (
    <div data-testid="portal-profile"><Title sub={`Member since ${d8(d.data.member_since)} · last sign-in ${d.data.last_login ? dt(d.data.last_login) : "—"}`}>Profile</Title>
      <form onSubmit={save} className="card grid gap-3 p-4 sm:grid-cols-2">
        <div><label className="label">Full name</label><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></div>
        <div><label className="label">E-mail (sign-in)</label><input className="input" disabled value={d.data.email} /></div>
        <div><label className="label">Phone</label><input className="input" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></div>
        <div><label className="label">Customer ID</label><input className="input" disabled value={d.data.customer?.code || "not linked"} /></div>
        {d.data.customer && <><div className="sm:col-span-2"><label className="label">Address</label><input className="input" value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} /></div>
          <div><label className="label">City</label><input className="input" value={f.city} onChange={(e) => setF({ ...f, city: e.target.value })} /></div><div><label className="label">State</label><input className="input" value={f.state} onChange={(e) => setF({ ...f, state: e.target.value })} /></div>
          <div><label className="label">PIN code</label><input className="input" value={f.pincode} onChange={(e) => setF({ ...f, pincode: e.target.value })} /></div></>}
        <div className="flex justify-between sm:col-span-2"><button type="button" className="btn-ghost" onClick={() => setPw(true)}><KeyRound className="h-4 w-4" />Change password</button><button className={`btn-primary ${busy ? "btn-loading" : ""}`} disabled={busy}>Save profile</button></div></form>
      {pw && <ChangePasswordModal onClose={() => setPw(false)} />}</div>
  );
}

function WorkDenied() {
  return <div className="mx-auto max-w-md py-16 text-center" role="alert" data-testid="access-denied"><span className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-red-500/10"><ShieldAlert className="h-7 w-7 text-red-500" /></span><h1 className="mt-4 text-xl font-semibold">Access denied</h1><p className="mt-1 text-sm text-sub">Your account has not been granted access to this module. Ask your administrator.</p><Link to="/user/dashboard" className="btn-primary mt-5 inline-flex">Back to my dashboard</Link></div>;
}

function Denied() {
  return <div className="mx-auto max-w-md py-16 text-center" role="alert" data-testid="access-denied"><span className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-red-500/10"><ShieldAlert className="h-7 w-7 text-red-500" /></span><h1 className="mt-4 text-xl font-semibold">Access denied</h1><p className="mt-1 text-sm text-sub">This page is only for administrators. You are signed in to the user portal.</p><Link to="/user/dashboard" className="btn-primary mt-5 inline-flex">Back to my dashboard</Link></div>;
}

export default function UserPortal(props: { me: Me; onLogout: () => void; reloadMe: () => void }) {
  return <CartProvider uid={props.me.id}><Portal {...props} /></CartProvider>;
}

function Portal({ me, onLogout, reloadMe }: { me: Me; onLogout: () => void; reloadMe: () => void }) {
  const loc = useLocation(); const go = useNavigate();
  const [dark, setDark] = useState(document.documentElement.classList.contains("dark")); const [menu, setMenu] = useState(false); const [pw, setPw] = useState(false); const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, menu, () => setMenu(false));
  const toggle = () => { const n = !dark; document.documentElement.classList.toggle("dark", n); localStorage.setItem("sp_theme", n ? "dark" : "light"); setDark(n); };
  const granted = Object.keys(me.permissions || {});                       // staff modules an administrator explicitly granted
  const workHome = useMemo(() => { const m = [["products", "/products"], ["sales", "/sales-orders"], ["purchases", "/purchase-orders"], ["inventory", "/inventory"], ["warehouses", "/warehouses"], ["fulfilment", "/shipments"], ["reports", "/reports"]].find(([k]) => granted.includes(k)); return m ? "/user/work" + (m[1] === "/products" ? "/items" : m[1]) : null; }, [granted.join(",")]);
  const p = loc.pathname;
  if (underBase(p, "/admin")) return <PortalFrame me={me} nav={NAV} workHome={workHome} dark={dark} toggle={toggle} menu={menu} setMenu={setMenu} refEl={ref} onLogout={onLogout} setPw={setPw}><Denied />{pw && <ChangePasswordModal onClose={() => setPw(false)} />}</PortalFrame>;
  let body: React.ReactNode;
  const { can, has } = useMe();
  const ip = underBase(p, WORK) ? toInternal(p, WORK) : "/"; const seg = ip.split("/")[1] || ""; const tail = ip.split("/").pop() || ""; const need = ROUTE_MODULE[seg];
  const workDenied = ADMIN_ONLY.has(seg) || !need || !can(need) || (tail === "new" && !has(need, "create")) || (tail === "edit" && !has(need, "edit"));
  if (underBase(p, WORK)) body = workDenied ? <WorkDenied /> : <ModuleRoutes location={{ ...loc, pathname: ip }} />;
  else if (underBase(p, "/user")) body = (
    <Routes><Route path="/user/dashboard" element={<Dashboard me={me} />} /><Route path="/user/products" element={<Catalogue />} /><Route path="/user/stock-availability" element={<Catalogue stock />} />
      <Route path="/user/orders" element={<Orders />} /><Route path="/user/cart" element={<CartPage />} /><Route path="/user/purchase-history" element={<PurchaseHistory />} /><Route path="/user/invoices" element={<Invoices />} />
      <Route path="/user/payments" element={<Payments />} /><Route path="/user/support" element={<Support />} /><Route path="/user/profile" element={<Profile me={me} reload={reloadMe} />} /><Route path="*" element={<Navigate to="/user/dashboard" replace />} /></Routes>);
  else return <Navigate to={p === "/" || !workHome ? "/user/dashboard" : redirectFor(p, WORK)} replace />;
  return <PortalFrame me={me} nav={NAV} workHome={workHome} dark={dark} toggle={toggle} menu={menu} setMenu={setMenu} refEl={ref} onLogout={onLogout} setPw={setPw}><div key={p} className="anim-up">{body}</div>{pw && <ChangePasswordModal onClose={() => setPw(false)} />}</PortalFrame>;
}

type ChatMsg = { from: "bot" | "me"; text: string; products?: any[]; suggestions?: string[] };
function ProductAssistant({ uid, first }: { uid: number; first: string }) {
  const cart = useCart(); const toast = useToast(); const key = `sp_chat_${uid}`;
  const [open, setOpen] = useState(false); const [busy, setBusy] = useState(false); const [input, setInput] = useState(""); const [ctx, setCtx] = useState<number | null>(null);
  const [msgs, setMsgs] = useState<ChatMsg[]>(() => { try { const s = JSON.parse(sessionStorage.getItem(key) || "null"); if (s) return s; } catch { /* ignore */ } return [{ from: "bot", text: `Hi ${first}! I'm the StockPilot product assistant. Ask me about prices, stock, product details, or your orders.`, suggestions: ["What's in stock?", "Show the cheapest items", "What payment options do you have?", "Where is my last order?"] }]; });
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { try { sessionStorage.setItem(key, JSON.stringify(msgs.slice(-40))); } catch { /* ignore */ } end.current?.scrollIntoView({ block: "end" }); }, [msgs, open]);
  const send = async (text: string) => {
    const q = text.trim(); if (!q || busy) return; setInput(""); setBusy(true);
    setMsgs((m) => [...m, { from: "me", text: q }]);
    try { const r = await api("/portal/assistant", { body: { message: q, context_product_id: ctx } }); setCtx(r.context_product_id ?? ctx); setMsgs((m) => [...m, { from: "bot", text: r.text, products: r.products, suggestions: r.suggestions }]); }
    catch (e: any) { setMsgs((m) => [...m, { from: "bot", text: e.message || "Sorry, I couldn't answer that just now." }]); } finally { setBusy(false); }
  };
  return (
    <>
      <button data-testid="assistant-open" aria-label="Ask the product assistant" className="fixed bottom-5 right-5 z-40 flex items-center gap-2 rounded-full bg-brand px-4 py-3 text-sm font-semibold text-white shadow-[var(--shadow-3)] transition-transform hover:scale-105 dark:text-slate-900" onClick={() => setOpen(!open)}>{open ? <X className="h-5 w-5" /> : <Bot className="h-5 w-5" />}{!open && "Ask us"}</button>
      {open && <div role="dialog" aria-label="Product assistant" data-testid="assistant-panel" className="card anim-pop fixed bottom-20 right-5 z-40 flex h-[32rem] max-h-[75vh] w-[23rem] max-w-[calc(100vw-2.5rem)] flex-col overflow-hidden shadow-[var(--shadow-3)]">
        <div className="flex items-center gap-2 border-b bg-brand/10 px-3 py-2.5"><Sparkles className="h-4 w-4 text-brand" /><div className="flex-1 leading-tight"><p className="text-[13px] font-semibold">Product assistant</p><p className="text-[11px] text-sub">Automated answers from our live catalogue, not a person</p></div></div>
        <div className="flex-1 space-y-3 overflow-y-auto p-3 text-[13px]">
          {msgs.map((m, i) => <div key={i} className={m.from === "me" ? "flex justify-end" : ""}><div className={`max-w-[92%] whitespace-pre-wrap rounded-2xl px-3 py-2 ${m.from === "me" ? "bg-brand text-white dark:text-slate-900" : "bg-muted"}`} data-msg={m.from}>{m.text}</div>
            {m.products?.length ? <div className="mt-2 space-y-1.5">{m.products.slice(0, 4).map((p: any) => (
              <div key={p.id} className="rounded-xl border bg-surface p-2.5" data-product-card={p.sku}><div className="flex items-start justify-between gap-2"><span className="font-medium">{p.name}<span className="block text-[11px] font-normal text-sub">{p.sku}</span></span><Badge tone={TONE[p.availability]}>{AVAIL[p.availability]}</Badge></div>
                <div className="mt-1 flex items-center justify-between"><span className="tabular-nums">{money(p.price)} <span className="text-[11px] text-sub">+ {p.tax_rate}% GST</span></span>
                  <button className="btn-primary !px-2 !py-1 text-xs" disabled={p.availability === "out_of_stock"} aria-label={`Assistant: add ${p.name} to cart`} onClick={() => { cart.add(p, 1); toast(`${p.name} added to cart`); }}><ShoppingCart className="h-3.5 w-3.5" />Add</button></div></div>))}</div> : null}
            {i === msgs.length - 1 && m.from === "bot" && m.suggestions?.length ? <div className="mt-2 flex flex-wrap gap-1.5">{m.suggestions.map((s) => <button key={s} className="rounded-full border px-2.5 py-1 text-xs text-brand hover:bg-brand/10" onClick={() => send(s)}>{s}</button>)}</div> : null}</div>)}
          {busy && <div className="w-fit rounded-2xl bg-muted px-3 py-2 text-sub">Looking that up…</div>}<div ref={end} /></div>
        <form className="flex items-center gap-2 border-t p-2.5" onSubmit={(e) => { e.preventDefault(); send(input); }}>
          <input className="input !py-2" placeholder="Ask about a product…" aria-label="Message the assistant" maxLength={500} value={input} onChange={(e) => setInput(e.target.value)} />
          <button className="btn-primary !px-3" disabled={busy || !input.trim()} aria-label="Send"><Send className="h-4 w-4" /></button></form>
        <p className="border-t px-3 py-1.5 text-[11px] text-sub">Can't find an answer? <Link to="/user/support" className="text-brand hover:underline" onClick={() => setOpen(false)}>Contact support</Link></p></div>}
    </>
  );
}

function CartButton() {
  const { count } = useCart();
  return <Link to="/user/cart" className="btn-ghost relative" aria-label="Cart"><ShoppingCart className="h-4 w-4" /><span className="hidden sm:inline">Cart</span>{count > 0 && <span data-testid="cart-count" className="absolute -right-1 -top-1 rounded-full bg-brand px-1.5 text-[10px] font-bold text-white dark:text-slate-900">{count}</span>}</Link>;
}

function PortalFrame({ me, nav, workHome, dark, toggle, menu, setMenu, refEl, onLogout, setPw, children }: any) {
  const initials = me.name.split(" ").map((s: string) => s[0]).slice(0, 2).join("").toUpperCase();
  return (
    <div className="min-h-screen bg-bg" data-portal="user">
      <header className="sticky top-0 z-30 border-b bg-surface/95 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-4 px-4">
          <Link to="/user/dashboard" className="flex items-center gap-2"><Boxes className="h-6 w-6 text-brand" /><span className="text-lg font-bold tracking-tight">StockPilot</span><span className="rounded-full bg-brand/15 px-2 py-0.5 text-[11px] font-semibold text-brand">Customer portal</span></Link>
          <div className="ml-auto flex items-center gap-2">
            <CartButton />
            {workHome && <Link to={workHome} className="btn-ghost hidden sm:inline-flex"><Briefcase className="h-4 w-4" />Workspace</Link>}
            <div className="relative" ref={refEl}><button className="flex items-center gap-2 rounded-md px-1.5 py-1 hover:bg-muted" onClick={() => setMenu(!menu)} aria-label="Account menu"><span className="flex h-8 w-8 items-center justify-center rounded-full bg-brand text-xs font-semibold text-white dark:text-slate-900">{initials}</span><span className="hidden text-left text-[13px] leading-tight sm:block"><span className="block font-medium">{me.name}</span><span className="block text-[11px] text-sub">{me.email}</span></span></button>
              {menu && <div className="card anim-pop absolute right-0 z-40 mt-1 w-56 py-1 text-[13px] shadow-[var(--shadow-3)]">
                <button className="flex w-full items-center gap-2 px-3 py-2 hover:bg-muted" onClick={() => { setMenu(false); toggle(); }}>{dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}{dark ? "Light theme" : "Dark theme"}</button>
                <button className="flex w-full items-center gap-2 px-3 py-2 hover:bg-muted" onClick={() => { setMenu(false); setPw(true); }}><KeyRound className="h-4 w-4" />Change password</button>
                <button className="flex w-full items-center gap-2 px-3 py-2 hover:bg-muted" onClick={onLogout}><LogOut className="h-4 w-4" />Sign out</button></div>}</div></div></div>
        <nav className="mx-auto flex max-w-6xl gap-1 overflow-x-auto px-3 pb-2" aria-label="User portal">{nav.map((n: any) => <NavLink key={n.to} to={n.to} className={({ isActive }: any) => `flex items-center gap-1.5 whitespace-nowrap rounded-full px-3 py-1.5 text-[13.5px] font-medium transition-colors ${isActive ? "bg-brand/15 text-brand" : "text-ink hover:bg-muted"}`}><n.icon className="h-4 w-4" />{n.label}</NavLink>)}</nav>
      </header>
      <main className="mx-auto max-w-6xl p-4 md:p-6">{children}</main>
      <ProductAssistant uid={me.id} first={me.name.split(" ")[0]} />
    </div>
  );
}
