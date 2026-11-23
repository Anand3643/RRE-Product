// Phase 2 browser suite: purchasing workflow in an isolated, freshly created organization (no demo data touched).
const { chromium } = require("playwright-core");
const OUT = __dirname + "/shots/";
const EXE = process.env.EDGE_PATH || process.env.CHROME_PATH || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const B = "http://localhost:5173", API = "http://127.0.0.1:8000/api";
let finished = false; let fails = 0; const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fails++; };
const tag = Date.now().toString().slice(-6);
process.on("unhandledRejection", (e) => { if (finished) process.exit(fails ? 1 : 0); console.error(e); process.exit(1); }); // Playwright teardown noise after completion
(async () => {
  const su = await (await fetch(API + "/auth/signup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ org_name: `E2E Org ${tag}`, name: "E2E Owner", email: `e2e${tag}@example.com`, password: "password123" }) })).json();
  const H = { Authorization: "Bearer " + su.access_token, "Content-Type": "application/json" };
  const call = async (m, p, b) => { const r = await fetch(API + p, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined }); return r.status === 204 ? null : r.json(); };
  await call("PATCH", "/organization", { gstin: "27ABCDE1234F1Z5", state: "Maharashtra", address: "1 HQ Road, Mumbai" });
  const wh1 = (await call("GET", "/warehouses"))[0]; const wh2 = await call("POST", "/warehouses", { code: "EW2", name: "E2E Second" });
  const vIn = await call("POST", "/vendors", { name: `E2E Supplier ${tag}`, gstin: "27AAACB1234C1Z5", bill_state: "Maharashtra", payment_terms: 30 });
  const vOut = await call("POST", "/vendors", { name: `E2E Faraway ${tag}`, gstin: "29AABCP5678D1Z2", bill_state: "Karnataka" });
  const nut = await call("POST", "/products", { name: `E2E Nut ${tag}`, sku: `NUT-${tag}`, purchase_price: 50, tax_rate: 18 });
  const bolt = await call("POST", "/products", { name: `E2E Bolt ${tag}`, sku: `BLT-${tag}`, purchase_price: 100, tax_rate: 12 });
  const browser = await chromium.launch({ executablePath: EXE, headless: true });
  const errs = [];
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  await ctx.addInitScript(([a, b]) => { localStorage.setItem("sp_access", a); localStorage.setItem("sp_refresh", b); }, [su.access_token, su.refresh_token]);
  const p = await ctx.newPage(); p.on("pageerror", (e) => errs.push("PAGEERROR " + e.message)); p.on("console", (m) => m.type() === "error" && !/409|403|422|404/.test(m.text()) && errs.push(m.text()));
  const body = async () => (await p.locator("body").innerText());
  const stock = async (pid) => (await call("GET", `/products/${pid}`)).on_hand;
  const rows = () => p.locator("tbody tr");

  // ---------- nav + empty state ----------
  await p.goto(B + "/purchase-orders"); await p.waitForTimeout(1000);
  ok((await p.locator("aside").innerText()).includes("Purchase Orders"), "sidebar has Purchase Orders");
  ok((await body()).includes("No purchase orders yet"), "empty state shown before any order exists");
  await p.keyboard.press("g"); await p.keyboard.press("v"); await p.waitForTimeout(400); await p.keyboard.press("g"); await p.keyboard.press("o"); await p.waitForTimeout(500); ok(p.url().endsWith("/purchase-orders"), "G then O opens Purchase Orders");

  // ---------- create via form: validation, combobox, price autofill, live GST totals ----------
  await p.getByRole("button", { name: "New Purchase Order" }).first().click(); await p.waitForURL("**/purchase-orders/new"); await p.waitForTimeout(800);
  await p.getByRole("button", { name: "Save & issue" }).click(); await p.waitForTimeout(400);
  const b0 = await body(); ok(b0.includes("Choose a vendor") && b0.includes("Choose an item"), "empty PO is rejected with inline errors (no request sent)");
  await p.getByRole("combobox").first().click(); await p.keyboard.type(`Supplier ${tag}`); await p.keyboard.press("Enter"); await p.waitForTimeout(300);
  ok((await body()).includes("CGST + SGST"), "same-state vendor shows CGST + SGST treatment");
  const itemBox = p.locator("tbody input[role=combobox]").first(); await itemBox.click(); await p.keyboard.type(`E2E Nut`); await p.keyboard.press("Enter"); await p.waitForTimeout(300);
  const row1 = p.locator("tbody tr").first(); const nums = row1.locator("input[type=number]");
  ok((await nums.nth(1).inputValue()) === "50", "choosing an item auto-fills its purchase price");
  await nums.nth(0).fill("100"); await nums.nth(2).fill("10"); await p.waitForTimeout(200);   // qty 100, discount 10%
  await p.getByRole("button", { name: "Add line" }).click(); await p.waitForTimeout(200);
  const itemBox2 = p.locator("tbody input[role=combobox]").nth(1); await itemBox2.click(); await p.keyboard.type(`E2E Bolt`); await p.keyboard.press("Enter"); await p.waitForTimeout(300);
  await p.locator("tbody tr").nth(1).locator("input[type=number]").nth(0).fill("20");
  await p.waitForTimeout(1100); // let the animated total finish counting
  // line 1: 100*50=5000 -10% => 4500 +18% = 5310 ; line 2: 20*100=2000 +12% = 2240 ; total 7550 ; tax 810+240=1050 => cgst 525 sgst 525
  const txt = await body(); ok(txt.includes("7,550.00") && txt.includes("525.00") && !txt.includes("IGST"), "live totals preview matches the server maths (₹7,550.00, CGST 525 + SGST 525)");
  ok((await p.locator("[role=alert]").count()) === 0, "validation messages clear as soon as the fields are fixed");
  await p.screenshot({ path: OUT + "p2-01-po-form.png" });
  await p.getByRole("combobox").first().click(); await p.keyboard.press("Control+a"); await p.keyboard.type(`Faraway ${tag}`); await p.keyboard.press("Enter"); await p.waitForTimeout(300);
  ok((await body()).includes("IGST") && (await body()).includes("inter-state"), "switching to an out-of-state vendor flips the preview to IGST");
  await p.getByRole("combobox").first().click(); await p.keyboard.press("Control+a"); await p.keyboard.type(`Supplier ${tag}`); await p.keyboard.press("Enter"); await p.waitForTimeout(300);
  await p.getByRole("button", { name: "Save & issue" }).click(); await p.waitForURL(/\/purchase-orders\/\d+$/, { timeout: 8000 }); await p.waitForTimeout(1200);
  const poId = p.url().split("/").pop(); const poApi = await call("GET", `/purchase-orders/${poId}`);
  ok(poApi.status === "issued" && poApi.total === 7550 && poApi.cgst === 525 && poApi.sgst === 525 && poApi.number === "PO-00001", `server stored the same totals and issued it (${poApi.number}, ₹${poApi.total})`);
  ok((await body()).includes("Issued") && (await p.locator('[aria-label="Order progress"]').count()) === 1, "detail page shows status and progress stepper");
  await p.screenshot({ path: OUT + "p2-02-po-detail.png" });
  ok(await stock(nut.id) === 0, "issuing a PO does not touch stock");

  // ---------- PDF ----------
  const pdf = await p.evaluate(async ([id, tok]) => { const r = await fetch(`/api/purchase-orders/${id}/pdf`, { headers: { Authorization: "Bearer " + tok } }); const b = new Uint8Array(await r.arrayBuffer()); return { type: r.headers.get("content-type"), head: String.fromCharCode(...b.slice(0, 5)), size: b.length }; }, [poId, su.access_token]);
  ok(pdf.type === "application/pdf" && pdf.head === "%PDF-" && pdf.size > 1500, `PDF is generated (${pdf.size} bytes)`);
  const [dl] = await Promise.all([p.waitForEvent("download"), p.locator('button[aria-label="More actions"]').click().then(() => p.getByRole("menuitem", { name: "Download PDF" }).click())]);
  ok(dl.suggestedFilename() === "PO-00001.pdf", "'Download PDF' saves PO-00001.pdf");

  // ---------- partial receipt ----------
  await p.getByRole("button", { name: "Receive goods" }).click(); await p.waitForTimeout(500);
  const dlg = p.getByRole("dialog"); const qin = dlg.locator("tbody input[type=number]");
  ok((await qin.first().inputValue()) === "100", "receive dialog defaults to the outstanding quantity");
  await qin.first().fill("150"); await p.waitForTimeout(200); ok(await dlg.getByRole("button", { name: /Post receipt/ }).isDisabled(), "receiving more than outstanding is blocked in the UI");
  await qin.first().fill("40"); await qin.nth(1).fill("0"); await p.waitForTimeout(200);
  await p.screenshot({ path: OUT + "p2-03-receive.png" });
  await dlg.getByRole("button", { name: /Post receipt/ }).click(); await p.waitForTimeout(1500);
  ok(await stock(nut.id) === 40 && await stock(bolt.id) === 0, "partial receipt added exactly 40 units of the first item to stock");
  ok((await body()).includes("Partially received"), "status moves to Partially received");
  ok((await call("GET", "/inventory/reconcile")).ok, "ledger reconciles after the receipt");
  await p.getByRole("button", { name: "Receive goods" }).click(); await p.waitForTimeout(400);
  await p.getByRole("dialog").locator("select").first().selectOption(String(wh2.id)); await p.getByRole("dialog").getByRole("button", { name: /Post receipt/ }).click(); await p.waitForTimeout(1500);
  ok(await stock(nut.id) === 100 && await stock(bolt.id) === 20, "remaining quantities received into a second warehouse");
  const done = await call("GET", `/purchase-orders/${poId}`); ok(done.status === "received" && done.receipts.length === 2, "order is Received with two goods receipts");
  await p.getByRole("tab", { name: /Receipts/ }).click(); await p.waitForTimeout(600); ok((await body()).includes("GRN-00001") && (await body()).includes("GRN-00002"), "receipts tab lists both GRNs");
  ok(await p.getByRole("button", { name: "Receive goods" }).count() === 0, "no receive button on a fully received order");
  await p.getByRole("tab", { name: "Activity" }).click(); await p.waitForTimeout(500); ok((await body()).toLowerCase().includes("receive") && (await body()).toLowerCase().includes("issue"), "activity timeline records issue and receipts");

  // ---------- item + vendor views ----------
  await p.goto(`${B}/products/${nut.id}?tab=purchases`); await p.waitForTimeout(1000); ok((await body()).includes("PO-00001"), "item 'Purchases' tab shows the order");
  await p.goto(`${B}/vendors/${vIn.id}`); await p.waitForTimeout(1300);
  const vtxt = await body(); ok(vtxt.includes("7,550.00") && vtxt.toLowerCase().includes("outstanding"), "vendor page shows total purchased and outstanding (₹7,550)");
  ok(vtxt.includes("On-time delivery") && vtxt.includes("Fill rate"), "vendor performance card is shown");
  await p.getByRole("button", { name: "Record payment" }).click(); await p.waitForTimeout(400);
  const pd = p.getByRole("dialog"); await pd.locator("input[type=number]").fill("9000"); await p.waitForTimeout(200);
  ok(await pd.getByRole("button", { name: "Record payment" }).isDisabled(), "payment above the outstanding balance is blocked");
  await pd.locator("input[type=number]").fill("3000"); await pd.getByRole("button", { name: "Record payment" }).click(); await p.waitForTimeout(1500);
  const s1 = await call("GET", `/vendors/${vIn.id}/stats`); ok(s1.paid === 3000 && s1.outstanding === 4550, "payment recorded: outstanding fell to ₹4,550");
  await p.getByRole("tab", { name: "Transactions" }).click(); await p.waitForTimeout(800);
  const ttxt = await body(); ok(ttxt.includes("PO-00001") && ttxt.includes("GRN-00001") && ttxt.includes("PAY-00001"), "transactions tab lists PO, receipts and payment");
  await p.screenshot({ path: OUT + "p2-04-vendor-transactions.png" });
  await p.getByRole("button", { name: "Void" }).click(); await p.waitForTimeout(1200); ok((await call("GET", `/vendors/${vIn.id}/stats`)).outstanding === 7550, "voiding the payment restores the outstanding balance");

  // ---------- list, filters, suggestions, draft lifecycle ----------
  await p.goto(B + "/purchase-orders"); await p.waitForTimeout(1000);
  ok(await rows().count() === 1 && (await rows().first().innerText()).includes("Received"), "list shows the received order");
  await p.getByRole("button", { name: /^Draft/ }).click(); await p.waitForTimeout(600); ok((await body()).includes("No purchase orders match"), "Draft tab filters out received orders");
  await p.getByRole("button", { name: /^All/ }).click(); await p.waitForTimeout(500);
  // create low-stock demand so suggestions appear
  const low = await call("POST", "/products", { name: `E2E Low ${tag}`, sku: `LOW-${tag}`, purchase_price: 10, reorder_point: 30, preferred_vendor_id: vIn.id, opening_stock: 4 });
  await call("POST", "/inventory/adjust", { product_id: low.id, warehouse_id: wh1.id, mode: "decrease", quantity: 1, reason: "e2e sale" });
  await p.getByRole("button", { name: "Reorder suggestions" }).click(); await p.waitForTimeout(1200);
  ok((await p.getByRole("dialog").innerText()).includes(`E2E Low ${tag}`) || (await p.getByRole("dialog").innerText()).includes("Nothing needs reordering"), "reorder suggestions dialog opens with real data");
  await p.screenshot({ path: OUT + "p2-05-suggestions.png" });
  await p.keyboard.press("Escape"); await p.waitForTimeout(300);
  // draft: create, edit, delete
  const draft = await call("POST", "/purchase-orders", { vendor_id: vIn.id, warehouse_id: wh1.id, lines: [{ product_id: bolt.id, quantity: 5 }] });
  await p.goto(`${B}/purchase-orders/${draft.id}/edit`); await p.waitForTimeout(1000);
  await p.locator("tbody tr").first().locator("input[type=number]").nth(0).fill("8"); await p.getByRole("button", { name: "Save as draft" }).click(); await p.waitForURL(/\/purchase-orders\/\d+$/, { timeout: 8000 }); await p.waitForTimeout(900);
  ok((await call("GET", `/purchase-orders/${draft.id}`)).lines[0].quantity === 8, "draft edited through the form");
  await p.goto(`${B}/purchase-orders/${poId}/edit`); await p.waitForTimeout(800); ok((await body()).includes("Only draft orders can be edited"), "issued/received orders can't be opened for editing");
  await p.goto(`${B}/purchase-orders/${draft.id}`); await p.waitForTimeout(800);
  await p.locator('button[aria-label="More actions"]').click(); await p.getByRole("menuitem", { name: "Delete draft" }).click(); await p.getByRole("dialog").getByRole("button", { name: "Delete" }).click(); await p.waitForTimeout(1200);
  ok(p.url().endsWith("/purchase-orders") && (await fetch(API + `/purchase-orders/${draft.id}`, { headers: H })).status === 404, "draft deleted from the detail page");
  // cancel an issued order
  const iss = await call("POST", "/purchase-orders", { vendor_id: vIn.id, warehouse_id: wh1.id, lines: [{ product_id: bolt.id, quantity: 2 }] }); await call("POST", `/purchase-orders/${iss.id}/issue`);
  await p.goto(`${B}/purchase-orders/${iss.id}`); await p.waitForTimeout(800);
  await p.locator('button[aria-label="More actions"]').click(); await p.getByRole("menuitem", { name: "Cancel order" }).click(); await p.getByRole("dialog").getByRole("button", { name: "Cancel order" }).click(); await p.waitForTimeout(1200);
  ok((await call("GET", `/purchase-orders/${iss.id}`)).status === "cancelled" && (await body()).includes("cancelled"), "issued order cancelled; banner explains it has no stock effect");

  // ---------- settings ----------
  await p.goto(B + "/settings"); await p.waitForTimeout(900);
  await p.locator('input[maxlength="15"]').fill("BADGST"); await p.getByRole("button", { name: "Save settings" }).click(); await p.waitForTimeout(300); ok((await body()).includes("GSTIN format"), "settings validate GSTIN");
  await p.locator('input[maxlength="15"]').fill("27ABCDE1234F1Z5"); await p.getByRole("button", { name: "Save settings" }).click(); await p.waitForTimeout(1000); ok((await call("GET", "/organization")).gstin === "27ABCDE1234F1Z5", "settings saved to the database");

  // ---------- roles ----------
  const mkUser = async (role) => { await call("POST", "/users", { email: `${role}${tag}@example.com`, name: role, password: "password123", role }); const t = await (await fetch(API + "/auth/login", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: `username=${role}${tag}@example.com&password=password123` })).json(); const c2 = await browser.newContext({ viewport: { width: 1440, height: 900 } }); await c2.addInitScript(([a, b]) => { localStorage.setItem("sp_access", a); localStorage.setItem("sp_refresh", b); }, [t.access_token, t.refresh_token]); return c2.newPage(); };
  const op = await mkUser("warehouse"); await op.goto(`${B}/purchase-orders/${iss.id}`); await op.waitForTimeout(1200);
  ok((await op.getByRole("button", { name: /Issue|Edit/ }).count()) === 0, "warehouse staff can open a PO but get no Issue/Edit buttons");
  await op.goto(B + "/purchase-orders"); await op.waitForTimeout(900); ok((await op.getByRole("button", { name: "New Purchase Order" }).count()) === 0, "warehouse staff can't create purchase orders (button hidden)");
  const ap = await mkUser("sales"); await ap.goto(B + "/purchase-orders"); await ap.waitForTimeout(1200); await ap.waitForSelector("[data-testid=access-denied]", { timeout: 6000 }).catch(() => {}); ok((await ap.locator("[data-testid=access-denied]").count()) === 1, "sales staff are denied the Purchase Orders module");
  // mobile
  const mc = await browser.newContext({ viewport: { width: 390, height: 800 }, hasTouch: true, isMobile: true }); await mc.addInitScript(([a, b]) => { localStorage.setItem("sp_access", a); localStorage.setItem("sp_refresh", b); }, [su.access_token, su.refresh_token]);
  const mp = await mc.newPage(); await mp.goto(`${B}/purchase-orders/${poId}`); await mp.waitForTimeout(1200); ok(await mp.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), "mobile: PO detail has no page-level horizontal scroll");
  await mp.goto(`${B}/purchase-orders/new`); await mp.waitForTimeout(1000); ok(await mp.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), "mobile: PO form fits (lines table scrolls inside its card)");

  ok((await call("GET", "/inventory/reconcile")).ok, "ledger still reconciles after every UI operation");
  console.log("console/page errors:", JSON.stringify(errs.slice(0, 6)));
  console.log(fails ? `\n${fails} CHECK(S) FAILED` : "\nALL CHECKS PASSED");
  finished = true;
  await browser.close().catch(() => {});
  process.exit(fails ? 1 : 0);
})().catch((e) => { if (finished) process.exit(fails ? 1 : 0); console.error(e); process.exit(1); });
