// Admin portal vs User portal, driven through the real UI against a FRESH database (first-run registration rules).
// Start the API on an empty DB without ALLOW_ORG_SIGNUP:  DATABASE_URL=sqlite:///./scratch.db uvicorn app.main:app --port 8000
const { chromium } = require("playwright-core");
const EXE = process.env.EDGE_PATH || process.env.CHROME_PATH || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const B = "http://localhost:5173", API = "http://127.0.0.1:8000/api";
let fails = 0; const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fails++; };
const PW = "Passw0rd123", ADMIN = "admin@example.com", U1 = "customer1@example.com", U2 = "customer2@example.com";

(async () => {
  const cfg = await (await fetch(API + "/auth/config")).json();
  if (!cfg.first_run) throw new Error("This suite needs an EMPTY database (first_run=false). Start the API on a scratch DB.");
  const browser = await chromium.launch({ executablePath: EXE, headless: true });
  const ctx = async () => { const c = await browser.newContext({ viewport: { width: 1450, height: 950 } }); const p = await c.newPage(); return p; };
  const body = (p) => p.locator("body").innerText();
  const signIn = async (p, email) => { await p.goto(B + "/"); await p.waitForSelector("#email"); await p.fill("#email", email); await p.fill("#password", PW); await p.getByRole("button", { name: /^Sign in/ }).click(); };
  const signOut = async (p) => { await p.locator("button[aria-label='Account menu']").click(); await p.getByRole("button", { name: "Sign out" }).click(); await p.waitForSelector("#email"); };
  const token = (p) => p.evaluate(() => localStorage.getItem("sp_access"));
  const api = async (t, m, path, b) => { const r = await fetch(API + path, { method: m, headers: { Authorization: "Bearer " + t, "Content-Type": "application/json" }, body: b ? JSON.stringify(b) : undefined }); const x = await r.text(); return { status: r.status, body: x ? JSON.parse(x) : null }; };

  // ---------- registration through the UI ----------
  const p = await ctx();
  await p.goto(B + "/"); await p.waitForSelector("#email");
  await p.getByRole("button", { name: /Set up the administrator account/ }).click(); await p.waitForSelector("#org");
  ok((await body(p)).includes("This first account becomes the administrator"), "empty system offers administrator set-up");
  await p.fill("#org", "Portal Traders"); await p.fill("#fullname", "Ada Admin"); await p.fill("#email", ADMIN); await p.fill("#password", PW); await p.getByRole("button", { name: "Create administrator account" }).click();
  await p.waitForURL("**/admin/dashboard", { timeout: 15000 }); ok(true, "first account lands on /admin/dashboard");
  await p.waitForSelector("[data-testid=admin-dashboard]"); const adminTok = await token(p);
  const me0 = (await api(adminTok, "GET", "/auth/me")).body; ok(me0.role === "owner" && me0.is_admin, "first account is ADMIN in the database");
  await signOut(p);
  for (const [email, name] of [[U1, "Una Customer"], [U2, "Uri Customer"]]) {
    await p.goto(B + "/"); await p.waitForSelector("#email"); await p.getByRole("button", { name: /Create an account/ }).click(); await p.waitForSelector("#fullname");
    ok(await p.locator("#org").count() === 0, "customer registration has no organisation field");
    await p.fill("#fullname", name); await p.fill("#email", email); await p.fill("#password", PW); await p.getByRole("button", { name: "Create account" }).click();
    await p.waitForURL("**/user/dashboard", { timeout: 15000 }); await p.waitForSelector("[data-testid=user-dashboard]"); ok(true, `${email} registered and lands on /user/dashboard`);
    const m = (await api(await token(p), "GET", "/auth/me")).body; ok(m.role === "user" && !m.is_admin && m.org.id === me0.org.id, `${email} is stored as USER in the administrator's organisation`);
    await signOut(p);
  }

  // ---------- business data (as admin, via API) ----------
  const adminTok2 = (await (await fetch(API + "/auth/login", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ username: ADMIN, password: PW }) })).json()).access_token;
  const wh =(await api(adminTok2, "GET", "/warehouses")).body[0];
  const prod = (await api(adminTok2, "POST", "/products", { name: "Portal Widget", sku: "PW-1", selling_price: 250, purchase_price: 100, opening_stock: 40, reorder_point: 5, tax_rate: 18 })).body;
  const dir = (await api(adminTok2, "GET", "/users/directory")).body;
  const cust = (e) => dir.items.find((u) => u.email === e).customer_id;
  const mkOrder = async (c, qty) => { const so = (await api(adminTok2, "POST", "/sales-orders", { customer_id: c, warehouse_id: wh.id, lines: [{ product_id: prod.id, quantity: qty }] })).body; await api(adminTok2, "POST", `/sales-orders/${so.id}/confirm`); return so; };
  const o1 = await mkOrder(cust(U1), 3), o2 = await mkOrder(cust(U2), 5);

  // ---------- TEST A: administrator ----------
  await signIn(p, ADMIN); await p.waitForURL("**/admin/dashboard", { timeout: 15000 }); await p.waitForSelector("[data-testid=admin-dashboard]");
  let nav = await p.locator("aside").innerText();
  ok(["Dashboard", "Items", "Customers", "Vendors", "Sales Orders", "Purchase Orders", "Warehouses", "Shipments", "Reports", "Users", "Login history", "Settings"].every((s) => nav.includes(s)), "admin navigation lists all administrative modules");
  ok(!(await p.locator("[data-portal=user]").count()), "admin does not see the user-portal layout");
  for (const [path, test] of [["/admin/items", "Items"], ["/admin/customers", "Customers"], ["/admin/sales-orders", "Sales"], ["/admin/warehouses", "Warehouses"], ["/admin/reports", "Reports"], ["/admin/settings", "Settings"]]) {
    await p.goto(B + path); await p.waitForTimeout(900); ok(p.url().endsWith(path) && (await p.locator("[data-testid=access-denied]").count()) === 0, `admin opens ${path}`);
  }
  await p.goto(B + "/products"); await p.waitForURL("**/admin/items", { timeout: 8000 }); ok(true, "an old URL (/products) is redirected into the admin portal (/admin/items)");
  await p.goto(B + "/admin/users"); await p.waitForSelector("[data-testid=user-management] tbody tr");
  let t = await body(p);
  ok([ADMIN, U1, U2].every((e) => t.includes(e)), "User Management lists ALL registered accounts (admin + both users)");
  ok(t.includes("ADMIN") && t.includes("USER") && /Logins/i.test(t) && /Last active/i.test(t), "table shows role, login count and last-active columns");
  await p.getByLabel("Filter by role").selectOption("user"); await p.waitForFunction(() => document.querySelectorAll("[data-testid=user-management] tbody tr").length === 2); ok(true, "role filter: USER shows 2 accounts");
  await p.getByLabel("Filter by role").selectOption("admin"); await p.waitForFunction(() => document.querySelectorAll("[data-testid=user-management] tbody tr").length === 1); ok(true, "role filter: ADMIN shows 1 account");
  await p.getByLabel("Filter by role").selectOption("");
  await p.goto(B + "/admin/activity"); await p.waitForSelector("[data-testid=login-activity] tbody tr");
  t = await body(p); ok([ADMIN, U1, U2].every((e) => t.includes(e)), "Login activity shows records from the admin AND both users");
  await p.getByLabel("Role").selectOption("user_type"); await p.waitForFunction((a) => !document.querySelector("[data-testid=login-activity] tbody").innerText.includes(a), ADMIN); ok(true, "Login activity filter: normal users hides the admin");
  await p.goto(B + "/user/dashboard"); await p.waitForURL("**/admin/dashboard", { timeout: 8000 }); ok(true, "admin opening /user/dashboard is sent back to the admin portal");
  await signOut(p);

  // ---------- TEST B: first user ----------
  await signIn(p, U1); await p.waitForURL("**/user/dashboard", { timeout: 15000 }); await p.waitForSelector("[data-testid=user-dashboard]");
  ok(await p.locator("[data-portal=user]").count() === 1 && !(await p.locator("aside").count()), "user sees the customer-portal layout (no admin sidebar)");
  nav = await p.locator("nav[aria-label='User portal']").innerText();
  ok(["Dashboard", "Products", "Stock availability", "My orders", "Purchase history", "Invoices", "Payments", "Support", "Profile"].every((s) => nav.includes(s)), "user navigation has the portal pages only");
  ok(!/Customers|Vendors|Warehouses|Settings|Users|Login history/.test(nav), "admin navigation is hidden from the user");
  await p.goto(B + "/user/products"); await p.waitForSelector("[data-testid=portal-products] tbody tr"); t = await body(p);
  ok(t.includes("Portal Widget") && t.includes("In stock") && t.includes("₹250"), "user sees available products with price and availability");
  await p.goto(B + "/user/stock-availability"); await p.waitForSelector("[data-testid=portal-stock] tbody tr"); ok((await body(p)).includes("32 pcs") || /\d+ pcs/.test(await body(p)), "stock availability shows live quantity");
  await p.goto(B + "/user/orders"); await p.waitForSelector("[data-testid=portal-orders] tbody tr"); t = await body(p);
  ok(t.includes(o1.number) && !t.includes(o2.number), "My orders: own order only");
  await p.getByRole("button", { name: "Details" }).first().click(); await p.waitForSelector("[role=dialog]"); await p.waitForFunction(() => document.querySelector("[role=dialog]")?.innerText.includes("Portal Widget"), null, { timeout: 8000 }).catch(() => {}); ok((await p.locator("[role=dialog]").innerText()).includes("Portal Widget"), "order details open"); await p.keyboard.press("Escape");
  await p.goto(B + "/user/purchase-history"); await p.waitForSelector("[data-testid=portal-history] tbody tr"); t = await body(p); ok(t.includes(o1.number) && !t.includes(o2.number) && t.includes("Total spent"), "purchase history: own purchases only");
  await p.goto(B + "/user/invoices"); await p.waitForSelector("[data-testid=portal-invoices] tbody tr"); t = await body(p); ok(t.includes(o1.number) && !t.includes(o2.number), "invoices: own only");
  await p.goto(B + "/user/payments"); await p.waitForSelector("[data-testid=portal-payments]"); await p.waitForTimeout(500); ok((await body(p)).includes("Outstanding"), "payments page shows own balance");
  await p.goto(B + "/user/profile"); await p.waitForSelector("[data-testid=portal-profile] input"); ok((await body(p)).includes("Customer ID"), "profile page shows own account"); ok(await p.locator("[data-testid=portal-profile] input[disabled]").first().inputValue() !== "", "e-mail is read-only");
  await p.goto(B + "/user/support"); await p.waitForSelector("[data-testid=portal-support]"); await p.fill("[aria-label=Subject]", "Delivery question"); await p.fill("[aria-label=Message]", "When will my widgets arrive?"); await p.getByRole("button", { name: "Send request" }).click();
  await p.waitForSelector("text=Delivery question"); ok(true, "user raises a support request");
  // ---------- buying ----------
  await p.goto(B + "/user/products"); await p.waitForSelector("[data-testid=portal-products] tbody tr");
  await p.fill('[aria-label="Quantity of Portal Widget"]', "2"); await p.getByRole("button", { name: "Add Portal Widget to cart" }).click();
  await p.waitForSelector("[data-testid=cart-count]"); ok((await p.locator("[data-testid=cart-count]").innerText()) === "1", "adding a product shows 1 item in the cart badge");
  await p.getByRole("link", { name: /Cart/ }).click(); await p.waitForSelector("[data-testid=portal-cart] [data-cart-line]");
  t = await body(p); ok(t.includes("Portal Widget") && t.includes("₹500.00") && t.includes("₹590.00"), "cart shows the line, subtotal and GST-inclusive total (2 x 250 + 18% = 590)");
  await p.fill('[aria-label="Cart quantity of Portal Widget"]', "99999"); ok((await p.locator('[aria-label="Cart quantity of Portal Widget"]').inputValue()) !== "99999", "cart quantity is capped at the available stock");
  await p.fill('[aria-label="Cart quantity of Portal Widget"]', "2");
  ok(await p.locator("[data-testid=checkout-address]").count() === 1 && await p.locator("[data-testid=checkout-payment]").count() === 1, "checkout has a delivery-address section and a payment section");
  const radios = p.locator("[data-testid=checkout-payment] input[type=radio]"); ok(await radios.count() === 4 && await p.locator("[data-testid=checkout-payment] input[type=radio]:disabled").count() === 1, "payment options listed: 3 selectable, 1 (card/UPI/net banking) shown as not available");
  ok((await body(p)).includes("Cash on delivery") && (await body(p)).includes("Bank transfer") && (await body(p)).includes("Pay later") && (await body(p)).includes("Online payment is not connected yet"), "payment option descriptions shown, online payment honestly marked unavailable");
  await p.getByRole("button", { name: "Place order" }).click(); await p.waitForTimeout(400);
  t = await body(p); ok(t.includes("Enter the street address") && t.includes("Enter the city") && t.includes("PIN code must be 6 digits") && t.includes("Choose how you will pay") && p.url().includes("/user/cart"), "placing an order without address and payment shows validation and does not order");
  await p.fill('[aria-label="Address (house no., street, area)"]', "5 Market Street"); await p.fill('[aria-label="City"]', "Mumbai"); await p.fill('[aria-label="State"]', "Maharashtra"); await p.fill('[aria-label="PIN code"]', "40001");
  await p.fill('[aria-label="Phone number"]', "98200 11111"); await p.getByRole("button", { name: "Place order" }).click(); await p.waitForTimeout(300); ok((await body(p)).includes("PIN code must be 6 digits"), "a 5-digit PIN code is rejected");
  await p.fill('[aria-label="PIN code"]', "400001"); await p.getByLabel("Bank transfer (NEFT / IMPS / UPI to our account)").check();
  await p.getByRole("button", { name: "Place order" }).click(); await p.waitForURL(/\/user\/orders\?open=\d+/, { timeout: 15000 });
  await p.waitForFunction(() => document.querySelector("[role=dialog]")?.innerText.includes("Portal Widget"), null, { timeout: 8000 });
  const placed = (await p.locator("[role=dialog]").innerText()).match(/Order (SO-\d+)/)[1]; ok(true, `order ${placed} placed from the cart and opened in My orders`);
  ok((await p.locator("[role=dialog]").innerText()).toLowerCase().includes("confirmed"), "the new order is confirmed (stock reserved)");
  const dlgTxt = await p.locator("[role=dialog]").innerText(); ok(dlgTxt.includes("5 Market Street") && dlgTxt.includes("400001") && dlgTxt.includes("Bank transfer"), "the order records the delivery address and chosen payment option");
  const adminView = (await api(adminTok2, "GET", "/sales-orders")).body.items.find((x) => x.number === placed); const adm = (await api(adminTok2, "GET", `/sales-orders/${adminView.id}`)).body; ok(adm.payment_method === "bank_transfer" && adm.ship_to.includes("5 Market Street"), "admin sees the payment option and delivery address on the sales order");
  await p.keyboard.press("Escape"); ok(await p.locator("[data-testid=cart-count]").count() === 0, "cart is emptied after ordering");
  await p.goto(B + "/user/stock-availability"); await p.waitForSelector("[data-testid=portal-stock] tbody tr"); ok((await body(p)).includes("30 pcs"), "availability dropped from 32 to 30 after buying 2");
  const buy = await api(await token(p), "POST", "/portal/orders", { items: [{ product_id: prod.id, quantity: 5000 }], delivery: { name: "Una", phone: "9820011111", address: "5 Market Street", city: "Mumbai", state: "Maharashtra", pincode: "400001" }, payment_method: "cod" }); ok(buy.status === 409, "the server refuses to oversell");
  await p.goto(B + "/user/products"); await p.waitForSelector("[data-testid=portal-products] tbody tr"); ok(await p.getByRole("button", { name: "Add Portal Widget to cart" }).isEnabled(), "an item with stock keeps its Add button enabled");
  // ---------- product assistant ----------
  const askBot = async (q, expect) => { await p.fill('[aria-label="Message the assistant"]', q); await p.keyboard.press("Enter"); await p.waitForFunction((x) => [...document.querySelectorAll("[data-msg=bot]")].some((e) => e.innerText.includes(x)), expect, { timeout: 10000 }).catch(() => {}); return (await p.locator("[data-msg=bot]").last().innerText()); };
  await p.goto(B + "/user/dashboard"); await p.waitForSelector("[data-testid=user-dashboard]"); await p.getByTestId("assistant-open").click(); await p.waitForSelector("[data-testid=assistant-panel]");
  ok((await p.locator("[data-testid=assistant-panel]").innerText()).includes("not a person"), "assistant panel opens and says it is automated");
  let bot = await askBot("Is Portal Widget in stock?", "in stock"); ok(bot.includes("in stock") && bot.includes("pcs") && await p.locator('[data-product-card="PW-1"]').count() >= 1, "assistant answers stock for a product and shows a product card");
  await p.getByRole("button", { name: "Assistant: add Portal Widget to cart" }).last().click(); await p.waitForSelector("[data-testid=cart-count]"); ok(true, "the assistant's Add button puts the product in the cart");
  bot = await askBot("and its price?", "₹250.00"); ok(bot.includes("₹250.00") && bot.includes("295.00"), "follow-up question (\"its price\") uses the previous product, with GST-inclusive price");
  bot = await askBot("where is my last order?", placed); ok(bot.includes(placed), "assistant reports the user's latest order");
  bot = await askBot("what payment options do you have?", "Cash on delivery"); ok(bot.includes("Bank transfer") && bot.includes("not connected"), "assistant explains payment options");
  bot = await askBot("what is the purchase price of Portal Widget", "can only share"); ok(bot.includes("can only share") && !bot.includes("100"), "assistant will not reveal cost price");
  await p.getByTestId("assistant-open").click(); ok(await p.locator("[data-testid=assistant-panel]").count() === 0, "assistant closes");
  // TEST D/E for user 1
  for (const path of ["/admin/dashboard", "/admin/users", "/admin/activity"]) { await p.goto(B + path); await p.waitForSelector("[data-testid=access-denied]", { timeout: 6000 }).catch(() => {}); ok(await p.locator("[data-testid=access-denied]").count() === 1, `user opening ${path} gets Access denied`); }
  await p.goto(B + "/customers"); await p.waitForURL("**/user/dashboard", { timeout: 8000 }); ok(true, "an old admin-style URL (/customers) sends a user back to their dashboard");
  const t1 = await token(p);
  const codes = []; for (const path of ["/admin/overview", "/users/directory", "/users", "/monitor/summary", "/monitor/history", "/customers", "/sales-orders", "/support", "/organization"]) codes.push((await api(t1, "GET", path)).status);
  ok(codes.every((c) => c === 403), `user session gets 403 from every admin API (${codes})`);
  ok((await api(t1, "GET", `/portal/orders/${o2.id}`)).status === 404, "user cannot fetch another customer's order by id");
  await signOut(p);

  // ---------- TEST C: second user, same browser ----------
  await signIn(p, U2); await p.waitForURL("**/user/dashboard", { timeout: 15000 }); await p.waitForSelector("[data-testid=user-dashboard]");
  ok(!(await body(p)).includes(U1) && (await body(p)).includes("Uri"), "second user sees their own identity, not the first user's");
  await p.getByTestId("assistant-open").click(); await p.waitForSelector("[data-testid=assistant-panel]"); ok(!(await p.locator("[data-testid=assistant-panel]").innerText()).includes("Portal Widget"), "second user's assistant chat does not contain the first user's conversation");
  await p.fill('[aria-label="Message the assistant"]', "where is my last order?"); await p.keyboard.press("Enter"); await p.waitForFunction((x) => document.body.innerText.includes(x), o2.number, { timeout: 10000 }).catch(() => {});
  t = await p.locator("[data-testid=assistant-panel]").innerText(); ok(t.includes(o2.number) && !t.includes(o1.number) && !t.includes(placed), "second user's assistant shows only their own order"); await p.getByTestId("assistant-open").click();
  await p.goto(B + "/user/orders"); await p.waitForSelector("[data-testid=portal-orders] tbody tr"); t = await body(p); ok(t.includes(o2.number) && !t.includes(o1.number) && !t.includes(placed), "second user sees only their own order (not the first user's new purchase)");
  await p.goto(B + "/user/purchase-history"); await p.waitForSelector("[data-testid=portal-history] tbody tr"); t = await body(p); ok(t.includes(o2.number) && !t.includes(o1.number), "second user's purchase history is separate");
  await p.goto(B + "/user/support"); await p.waitForSelector("[data-testid=portal-support]"); await p.waitForTimeout(600); ok(!(await body(p)).includes("Delivery question"), "first user's support request is not visible to the second user");
  await p.goto(B + "/admin/users"); await p.waitForSelector("[data-testid=access-denied]", { timeout: 6000 }).catch(() => {}); ok(await p.locator("[data-testid=access-denied]").count() === 1, "second user cannot open /admin/users");
  const t2 = await token(p); ok(t1 !== t2 && (await api(t1, "GET", "/portal/me")).status === 401, "first user's session is dead after logout; sessions are not shared");
  await signOut(p);

  // ---------- TEST F: login activity as admin ----------
  await signIn(p, ADMIN); await p.waitForURL("**/admin/dashboard"); await p.goto(B + "/admin/activity"); await p.waitForSelector("[data-testid=login-activity] tbody tr");
  t = await body(p); ok([ADMIN, U1, U2].every((e) => t.includes(e)), "admin sees login records for all three accounts");
  const hist = (await api(await token(p), "GET", "/monitor/history?page_size=100")).body.items;
  const by = (e) => hist.filter((h) => h.email === e);
  ok(by(U1).length >= 2 && by(U2).length >= 2 && by(ADMIN).length >= 2, "each account has its own independent session records");
  ok(by(U1).every((h) => h.role === "user" && !h.is_admin) && by(U2).every((h) => h.role === "user") && by(ADMIN).every((h) => h.is_admin), "records carry the correct role");
  ok(new Set(by(U1).map((h) => h.user_id)).size === 1 && by(U1)[0].user_id !== by(U2)[0].user_id, "records are bound to the right user ids");
  ok(by(U1).some((h) => h.state === "logged_out") && by(ADMIN).some((h) => h.state === "active"), "logged-out and active sessions are tracked per account");
  await browser.close();
  console.log(fails ? `\n${fails} FAILED` : "\nALL PASSED"); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error("FATAL", e); process.exit(1); });
