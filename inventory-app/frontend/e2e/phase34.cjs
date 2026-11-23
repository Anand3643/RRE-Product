// Phase 3+4 browser suite: sales orders, reservation, packing, shipping, delivery, customer money. Isolated fresh org.
const { chromium } = require("playwright-core");
const OUT = __dirname + "/shots/";
const EXE = process.env.EDGE_PATH || process.env.CHROME_PATH || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const B = "http://localhost:5173", API = "http://127.0.0.1:8000/api";
let finished = false; let fails = 0; const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fails++; };
const tag = Date.now().toString().slice(-6);
process.on("unhandledRejection", (e) => { if (finished) process.exit(fails ? 1 : 0); console.error(e); process.exit(1); });
(async () => {
  const su = await (await fetch(API + "/auth/signup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ org_name: `E2E Sales ${tag}`, name: "Sales Owner", email: `s${tag}@example.com`, password: "password123" }) })).json();
  const H = { Authorization: "Bearer " + su.access_token, "Content-Type": "application/json" };
  const call = async (m, p, b) => { const r = await fetch(API + p, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined }); return r.status === 204 ? null : r.json(); };
  await call("PATCH", "/organization", { gstin: "27ABCDE1234F1Z5", state: "Maharashtra", address: "1 HQ Road, Mumbai" });
  const wh = (await call("GET", "/warehouses"))[0];
  const cust = await call("POST", "/customers", { name: `Buyer ${tag}`, gstin: "27AABCB1111A1Z1", ship_state: "Maharashtra", bill_address: "5 Market St", bill_city: "Mumbai", credit_limit: 20000 });
  const small = await call("POST", "/customers", { name: `Tiny Limit ${tag}`, credit_limit: 500 });
  const bolt = await call("POST", "/products", { name: `Bolt ${tag}`, sku: `BLT-${tag}`, selling_price: 100, purchase_price: 40, tax_rate: 18, opening_stock: 30 });
  const nut = await call("POST", "/products", { name: `Nut ${tag}`, sku: `NUT-${tag}`, selling_price: 20, purchase_price: 8, tax_rate: 12, opening_stock: 5 });
  const browser = await chromium.launch({ executablePath: EXE, headless: true });
  const errs = [];
  const mkctx = async (tok, opts = {}) => { const c = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true, ...opts }); await c.addInitScript(([a, b]) => { localStorage.setItem("sp_access", a); localStorage.setItem("sp_refresh", b); }, [tok.access_token, tok.refresh_token]); const pg = await c.newPage(); pg.on("pageerror", (e) => errs.push("PAGEERROR " + e.message)); pg.on("console", (m) => m.type() === "error" && !/409|403|422|404/.test(m.text()) && errs.push(m.text())); return pg; };
  const p = await mkctx(su);
  const body = async () => (await p.locator("body").innerText());
  const pr = async (id) => call("GET", `/products/${id}`);

  // ---------- nav ----------
  await p.goto(B + "/sales-orders"); await p.waitForTimeout(1000);
  const nav = await p.locator("aside").innerText(); ok(["Sales Orders", "Packages", "Shipments"].every((x) => nav.includes(x)), "sidebar shows Sales Orders, Packages, Shipments");
  ok((await body()).includes("No sales orders yet"), "empty state before any order");

  // ---------- create via form ----------
  await p.getByRole("button", { name: "New Sales Order" }).first().click(); await p.waitForURL("**/sales-orders/new"); await p.waitForTimeout(700);
  await p.getByRole("button", { name: "Save & confirm" }).click(); await p.waitForTimeout(300); ok((await body()).includes("Choose a customer"), "empty order rejected inline");
  await p.getByRole("combobox").first().click(); await p.keyboard.type(`Buyer ${tag}`); await p.keyboard.press("Enter"); await p.waitForTimeout(300);
  await p.locator("tbody input[role=combobox]").first().click(); await p.keyboard.type(`Bolt ${tag}`); await p.keyboard.press("Enter"); await p.waitForTimeout(300);
  const r1 = p.locator("tbody tr").first(); const n1 = r1.locator("input[type=number]");
  ok((await n1.nth(1).inputValue()) === "100", "item price is fetched automatically");
  await n1.nth(0).fill("10"); await n1.nth(2).fill("10");
  await p.getByRole("button", { name: "Add line" }).click(); await p.waitForTimeout(200);
  await p.locator("tbody input[role=combobox]").nth(1).click(); await p.keyboard.type(`Nut ${tag}`); await p.keyboard.press("Enter"); await p.waitForTimeout(300);
  await p.locator("tbody tr").nth(1).locator("input[type=number]").nth(0).fill("8"); await p.waitForTimeout(300);
  ok((await body()).includes("Only 5 available"), "line warns when quantity exceeds available stock");
  await p.locator("tbody tr").nth(1).locator("input[type=number]").nth(0).fill("2");
  await p.locator('input[aria-label="Shipping charge"]').fill("100"); await p.waitForTimeout(1200);
  // line1: 1000 - 10% = 900 +18% = 1062 ; line2: 40 + 12% = 44.80 ; tax 162 + 4.80 = 166.80 ; shipping 100 -> total 1206.80
  const t = await body(); ok(t.includes("1,206.80") && t.includes("CGST"), "live total includes GST and shipping (₹1,206.80)");
  ok((await p.locator("[role=alert]").count()) === 0, "no stale validation messages");
  await p.screenshot({ path: OUT + "p3-01-so-form.png" });
  await p.getByRole("button", { name: "Save as draft" }).click(); await p.waitForURL(/\/sales-orders\/\d+$/, { timeout: 8000 }); await p.waitForTimeout(1000);
  const soId = p.url().split("/").pop(); let so = await call("GET", `/sales-orders/${soId}`);
  ok(so.status === "draft" && so.total === 1206.8 && so.number === "SO-00001", `draft saved by the server with the same total (${so.number} ₹${so.total})`);
  ok((await pr(bolt.id)).reserved === 0, "a draft reserves no stock");

  // ---------- confirm: reservation ----------
  await p.getByRole("button", { name: "Confirm", exact: true }).click(); await p.waitForTimeout(400);
  await p.getByRole("dialog").getByRole("button", { name: "Confirm & reserve" }).click(); await p.waitForTimeout(1500);
  const b1 = await pr(bolt.id); ok(b1.reserved === 10 && b1.on_hand === 30 && b1.available === 20, "confirming reserved 10 units (on hand 30, available 20)");
  ok((await body()).includes("Confirmed") && (await p.locator('[aria-label="Order progress"]').count()) === 1, "status moves to Confirmed with progress stepper");
  await p.screenshot({ path: OUT + "p3-02-so-confirmed.png" });
  // oversell attempt through the UI: a second order wanting more than is left
  const big = await call("POST", "/sales-orders", { customer_id: cust.id, warehouse_id: wh.id, lines: [{ product_id: bolt.id, quantity: 25 }] });
  await p.goto(`${B}/sales-orders/${big.id}`); await p.waitForTimeout(800); await p.getByRole("button", { name: "Confirm", exact: true }).click(); await p.getByRole("dialog").getByRole("button", { name: "Confirm & reserve" }).click(); await p.waitForTimeout(1200);
  ok((await body()).includes("Insufficient stock") && (await pr(bolt.id)).reserved === 10, "overselling is refused and the message names the shortage; nothing extra reserved");
  await call("DELETE", `/sales-orders/${big.id}`);

  // ---------- credit limit ----------
  const lim = await call("POST", "/sales-orders", { customer_id: small.id, warehouse_id: wh.id, lines: [{ product_id: bolt.id, quantity: 8 }] });  // 944
  await p.goto(`${B}/sales-orders/${lim.id}`); await p.waitForTimeout(800); await p.getByRole("button", { name: "Confirm", exact: true }).click(); await p.getByRole("dialog").getByRole("button", { name: "Confirm & reserve" }).click(); await p.waitForTimeout(1200);
  ok((await body()).includes("Credit limit exceeded"), "credit limit stops the confirmation and explains why");
  await p.getByRole("button", { name: "Confirm with override" }).click(); await p.waitForTimeout(1500);
  ok((await call("GET", `/sales-orders/${lim.id}`)).status === "confirmed" && (await body()).includes("Credit override"), "owner confirms with a credit override, flagged on the order");
  await call("POST", `/sales-orders/${lim.id}/cancel`); ok((await pr(bolt.id)).reserved === 10, "cancelling the overridden order released its reservation");

  // ---------- pack partially ----------
  await p.goto(`${B}/sales-orders/${soId}`); await p.waitForTimeout(900);
  await p.getByRole("button", { name: "Pack items" }).first().click(); await p.waitForTimeout(500);
  const pd = p.getByRole("dialog"); const pq = pd.locator("tbody input[type=number]");
  await pq.first().fill("20"); await p.waitForTimeout(200); ok(await pd.getByRole("button", { name: /Create package/ }).isDisabled(), "packing more than ordered is blocked");
  await pq.first().fill("6"); await pq.nth(1).fill("0"); await pd.getByRole("button", { name: /Create package/ }).click(); await p.waitForTimeout(1500);
  so = await call("GET", `/sales-orders/${soId}`); ok(so.lines[0].qty_packed === 6 && so.status === "confirmed", "partial pack recorded; order not yet 'Packed'");
  const b2 = await pr(bolt.id); ok(b2.on_hand === 30 && b2.reserved === 10, "packing moved no stock");
  await p.getByRole("tab", { name: /Fulfilment/ }).click(); await p.waitForTimeout(600); ok((await body()).includes("PKG-00001"), "package appears on the fulfilment tab");
  await p.getByRole("button", { name: "Pack items" }).first().click(); await p.waitForTimeout(400); await p.getByRole("dialog").getByRole("button", { name: /Create package/ }).click(); await p.waitForTimeout(1500);
  so = await call("GET", `/sales-orders/${soId}`); ok(so.status === "packed" && so.packages.length === 2, "second package completes packing: status Packed");
  const [dl] = await Promise.all([p.waitForEvent("popup").catch(() => null), p.getByRole("button", { name: "Packing slip" }).first().click()]); if (dl) await dl.close();
  const slip = await p.evaluate(async ([id, tok]) => { const r = await fetch(`/api/packages/${id}/slip.pdf`, { headers: { Authorization: "Bearer " + tok } }); const b = new Uint8Array(await r.arrayBuffer()); return String.fromCharCode(...b.slice(0, 5)); }, [so.packages[0].id, su.access_token]); ok(slip === "%PDF-", "packing slip PDF is generated");

  // ---------- shipments ----------
  await p.getByRole("button", { name: "Create shipment" }).first().click(); await p.waitForTimeout(500);
  const sd = p.getByRole("dialog"); await sd.locator("input[list=carriers]").fill("Blue Dart"); await sd.locator("input").nth(1).fill("BD" + tag); await sd.getByRole("button", { name: "Create shipment" }).click(); await p.waitForTimeout(1500);
  so = await call("GET", `/sales-orders/${soId}`); const pkg1 = so.packages.find((x) => x.shipment_id); ok(!!pkg1 && pkg1.shipment_status === "ready_to_ship", "shipment created for the first package (ready to ship)");
  ok((await pr(bolt.id)).on_hand === 30, "a ready-to-ship shipment hasn't touched stock");
  await p.goto(`${B}/shipments/${pkg1.shipment_id}`); await p.waitForTimeout(1000);
  ok((await body()).includes("deducts it from inventory") || (await body()).includes("deducts stock"), "shipment page explains that shipping deducts stock");
  await p.getByRole("button", { name: /Mark shipped/ }).click(); await p.waitForTimeout(1500);
  const b3 = await pr(bolt.id); ok(b3.on_hand === 24 && b3.reserved === 4, "marking shipped deducted exactly the package quantity (30 -> 24, reserved 10 -> 4)");
  ok((await call("GET", "/inventory/reconcile")).ok, "ledger and reservations reconcile after shipping");
  ok((await call("GET", `/sales-orders/${soId}`)).status === "packed", "order stays 'Packed' until every package has shipped");
  await p.screenshot({ path: OUT + "p4-01-shipment.png" });
  ok(await p.getByRole("button", { name: /Mark shipped/ }).count() === 0, "no second 'mark shipped' button (can't deduct twice)");
  // simulated tracking, labelled
  await p.getByRole("button", { name: "Simulate next update" }).click(); await p.waitForTimeout(1000);
  ok((await body()).includes("Simulated") && (await body()).includes("In transit") && (await body()).includes("Manual tracking"), "simulated tracking is clearly labelled as simulated / manual");
  // failed delivery needs a reason
  await p.getByRole("button", { name: "Failed delivery" }).click(); await p.waitForTimeout(400);
  ok(await p.getByRole("dialog").getByRole("button", { name: "Confirm" }).isDisabled(), "failed delivery can't be saved without a reason");
  await p.getByRole("dialog").getByPlaceholder(/customer unavailable/).fill("Customer unavailable"); await p.getByRole("dialog").getByRole("button", { name: "Confirm" }).click(); await p.waitForTimeout(1200);
  ok((await body()).includes("Delivery failed") && (await body()).includes("Customer unavailable"), "failed delivery is recorded with its reason");
  await p.getByRole("button", { name: "Out for delivery" }).first().click().catch(() => {}); await p.waitForTimeout(400); if (await p.getByRole("dialog").count()) { await p.getByRole("dialog").getByRole("button", { name: "Confirm" }).click(); await p.waitForTimeout(1000); }
  await p.getByRole("button", { name: /Mark delivered/ }).click(); await p.waitForTimeout(400); await p.getByRole("dialog").getByPlaceholder(/Name of the person/).fill("Ravi"); await p.getByRole("dialog").getByRole("button", { name: "Confirm" }).click(); await p.waitForTimeout(1500);
  const shp = await call("GET", `/shipments/${pkg1.shipment_id}`); ok(shp.status === "delivered" && shp.delivered_to === "Ravi", "delivery confirmed with the receiver's name");
  ok(shp.events.map((e) => e.status).join(",") === "ready_to_ship,shipped,in_transit,failed_delivery,out_for_delivery,delivered", "tracking timeline has every step in order");
  await p.screenshot({ path: OUT + "p4-02-delivered.png" });
  const lbl = await p.evaluate(async ([id, tok]) => { const r = await fetch(`/api/shipments/${id}/label.pdf`, { headers: { Authorization: "Bearer " + tok } }); const b = new Uint8Array(await r.arrayBuffer()); return String.fromCharCode(...b.slice(0, 5)); }, [pkg1.shipment_id, su.access_token]); ok(lbl === "%PDF-", "shipping label PDF is generated");
  // second package: ship + deliver through the API, then check the order closes out
  const pkg2 = so.packages.find((x) => !x.shipment_id); const s2 = await call("POST", `/packages/${pkg2.id}/shipment`, { carrier: "DTDC" });
  for (const to of ["shipped", "in_transit", "out_for_delivery", "delivered"]) await call("POST", `/shipments/${s2.id}/status`, { status: to });
  await p.goto(`${B}/sales-orders/${soId}`); await p.waitForTimeout(1200);
  so = await call("GET", `/sales-orders/${soId}`); ok(so.status === "delivered" && so.delivered_pct === 100, "order becomes Delivered once every package is delivered");
  const b4 = await pr(bolt.id); ok(b4.on_hand === 20 && b4.reserved === 0, "final stock: 20 on hand, nothing reserved (10 sold)");
  ok((await call("GET", "/inventory/reconcile")).ok, "ledger reconciles at the end of the order");

  // ---------- lists ----------
  await p.goto(B + "/shipments"); await p.waitForTimeout(1000); ok((await p.locator("tbody tr").count()) === 2, "shipments list shows both shipments");
  await p.getByRole("button", { name: /^Delivered/ }).click(); await p.waitForTimeout(700); ok((await p.locator("tbody tr").count()) === 2, "Delivered tab filters correctly");
  await p.getByPlaceholder(/Search shipment/).fill("BD" + tag); await p.waitForTimeout(700); ok((await p.locator("tbody tr").count()) === 1, "tracking-number search finds the shipment");
  await p.goto(B + "/packages"); await p.waitForTimeout(1000); ok((await p.locator("tbody tr").count()) === 2 && (await body()).includes("delivered"), "packages list shows both packages as delivered");
  await p.goto(B + "/sales-orders"); await p.waitForTimeout(1000);
  ok((await rowsText(p)).includes("Delivered"), "sales order list shows the delivered order");
  await p.getByRole("button", { name: /^Draft/ }).click(); await p.waitForTimeout(600); ok((await body()).includes("No sales orders match"), "Draft tab excludes the delivered order");

  // ---------- customer financials ----------
  await p.goto(`${B}/customers/${cust.id}`); await p.waitForTimeout(1500);
  const ct = await body(); ok(ct.includes("1,206.80") && ct.toLowerCase().includes("outstanding"), "customer page shows total sales and outstanding (₹1,206.80 billed once shipped)");
  ok(ct.includes("Credit used") && ct.toLowerCase().includes("most purchased items"), "credit usage and purchase analytics are shown");
  await p.getByRole("button", { name: "Record payment" }).click(); await p.waitForTimeout(400); const pm = p.getByRole("dialog"); await pm.locator("input[type=number]").fill("99999"); await p.waitForTimeout(200);
  ok(await pm.getByRole("button", { name: "Record payment" }).isDisabled(), "payment above the outstanding amount is blocked");
  await pm.locator("input[type=number]").fill("700"); await pm.getByRole("button", { name: "Record payment" }).click(); await p.waitForTimeout(1500);
  const cs = await call("GET", `/customers/${cust.id}/stats`); ok(cs.paid === 700 && cs.outstanding === 506.8, "payment recorded: outstanding ₹506.80");
  await p.getByRole("tab", { name: "Transactions" }).click(); await p.waitForTimeout(800); const tt = await body(); ok(tt.includes("SO-00001") && tt.includes("SHP-0000") && tt.includes("PAY-"), "transactions tab lists order, shipments and payment");
  await p.screenshot({ path: OUT + "p3-03-customer.png" });
  await p.goto(`${B}/products/${bolt.id}?tab=sales`); await p.waitForTimeout(1000); ok((await body()).includes("SO-00001"), "item 'Sales' tab lists the order");

  // ---------- cancel releases ----------
  const c2 = await call("POST", "/sales-orders", { customer_id: cust.id, warehouse_id: wh.id, lines: [{ product_id: bolt.id, quantity: 5 }] }); await call("POST", `/sales-orders/${c2.id}/confirm`);
  ok((await pr(bolt.id)).reserved === 5, "a confirmed order holds its stock");
  await p.goto(`${B}/sales-orders/${c2.id}`); await p.waitForTimeout(900); await p.locator('button[aria-label="More actions"]').click(); await p.getByRole("menuitem", { name: "Cancel order" }).click(); await p.getByRole("dialog").getByRole("button", { name: "Cancel order" }).click(); await p.waitForTimeout(1500);
  ok((await pr(bolt.id)).reserved === 0 && (await body()).includes("cancelled"), "cancelling from the UI released the reservation");

  // ---------- roles ----------
  const mkUser = async (role) => { await call("POST", "/users", { email: `${role}${tag}@example.com`, name: role, password: "password123", role }); const tk = await (await fetch(API + "/auth/login", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: `username=${role}${tag}@example.com&password=password123` })).json(); return mkctx(tk); };
  const d2 = await call("POST", "/sales-orders", { customer_id: cust.id, warehouse_id: wh.id, lines: [{ product_id: bolt.id, quantity: 2 }] }); await call("POST", `/sales-orders/${d2.id}/confirm`);
  const wp = await mkUser("warehouse"); await wp.goto(`${B}/sales-orders/${d2.id}`); await wp.waitForTimeout(1300);
  ok((await wp.getByRole("button", { name: "Pack items" }).count()) === 1 && (await wp.getByRole("button", { name: /^Confirm|Edit/ }).count()) === 0, "warehouse staff can pack but can't confirm/edit orders");
  const sp2 = await mkUser("sales"); await sp2.goto(`${B}/sales-orders/${d2.id}`); await sp2.waitForTimeout(1300);
  ok((await sp2.getByRole("button", { name: "Pack items" }).count()) === 0, "sales staff don't see the Pack button");
  await sp2.goto(B + "/shipments"); await sp2.waitForTimeout(1000); ok((await sp2.locator("body").innerText()).includes("read-only"), "sales staff get a read-only shipments view");
  const mc = await browser.newContext({ viewport: { width: 390, height: 800 }, hasTouch: true, isMobile: true }); await mc.addInitScript(([a, b]) => { localStorage.setItem("sp_access", a); localStorage.setItem("sp_refresh", b); }, [su.access_token, su.refresh_token]);
  const mp = await mc.newPage(); for (const path of [`/sales-orders/${soId}`, "/sales-orders/new", `/shipments/${pkg1.shipment_id}`]) { await mp.goto(B + path); await mp.waitForTimeout(1200); ok(await mp.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `mobile: ${path.replace(/\d+/g, "#")} fits the screen`); }
  ok((await call("GET", "/inventory/reconcile")).ok, "ledger and reservations reconcile after every UI operation");
  console.log("console/page errors:", JSON.stringify(errs.slice(0, 6)));
  console.log(fails ? `\n${fails} CHECK(S) FAILED` : "\nALL CHECKS PASSED");
  finished = true; await browser.close().catch(() => {}); process.exit(fails ? 1 : 0);
})().catch((e) => { if (finished) process.exit(fails ? 1 : 0); console.error(e); process.exit(1); });
async function rowsText(p) { return (await p.locator("tbody").innerText()); }
