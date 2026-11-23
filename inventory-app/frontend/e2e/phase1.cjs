// Phase 1 browser suite: Items, Customers, Vendors. Needs API on :8000 (seeded demo data) and `npm run dev`. Run: npm run e2e:phase1
const { chromium } = require("playwright-core");
const OUT = __dirname + "/shots/";
const EXE = process.env.EDGE_PATH || process.env.CHROME_PATH || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const B = "http://localhost:5173", API = "http://127.0.0.1:8000/api";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
let fails = 0; const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fails++; };
const tag = Date.now().toString().slice(-6);
(async () => {
  const login = async (u) => (await (await fetch(API + "/auth/login", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: `username=${u}&password=demo1234` })).json());
  const t = await login("owner@demo.com"); const H = { Authorization: "Bearer " + t.access_token, "Content-Type": "application/json" };
  const jget = async (p) => (await fetch(API + p, { headers: H })).json();
  const browser = await chromium.launch({ executablePath: EXE, headless: true });
  const errs = [];
  const mk = async (tok, opts = {}) => {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, ...opts });
    await ctx.addInitScript(([a, b]) => { localStorage.setItem("sp_access", a); localStorage.setItem("sp_refresh", b); }, [tok.access_token, tok.refresh_token]);
    const p = await ctx.newPage(); p.on("pageerror", (e) => errs.push("PAGEERROR " + e.message)); p.on("console", (m) => m.type() === "error" && !/409|403|422|404/.test(m.text()) && errs.push(m.text()));
    return p;
  };
  const p = await mk(t);
  const body = async () => (await p.locator("body").innerText());
  const created = { items: [], customers: [], vendors: [] };

  // ---------- navigation ----------
  await p.goto(B + "/"); await p.waitForTimeout(900);
  const navText = await p.locator("aside").innerText();
  ok(["Items", "Customers", "Vendors"].every((x) => navText.includes(x)), "sidebar shows Items, Customers, Vendors");
  await p.keyboard.press("g"); await p.keyboard.press("c"); await p.waitForTimeout(600); ok(p.url().endsWith("/customers"), "G then C opens Customers");
  await p.keyboard.press("g"); await p.keyboard.press("v"); await p.waitForTimeout(600); ok(p.url().endsWith("/vendors"), "G then V opens Vendors");

  // ---------- items: list, filters, sort, quick view ----------
  await p.goto(B + "/products"); await p.waitForTimeout(1300);
  ok((await p.locator("tbody tr").count()) >= 10, "items list shows rows from the database");
  await p.selectOption('select[aria-label="Stock"]', "out"); await p.waitForTimeout(800);
  const outRows = await p.locator("tbody tr").allInnerTexts(); ok(outRows.length > 0 && outRows.every((r) => /Out of stock/.test(r)), `stock filter 'out of stock' (${outRows.length} rows)`);
  await p.selectOption('select[aria-label="Stock"]', "all");
  await p.getByPlaceholder(/Search name, SKU/).fill("bolt"); await p.waitForTimeout(800);
  ok((await p.locator("tbody tr").count()) >= 1 && (await p.locator("tbody").innerText()).toLowerCase().includes("bolt"), "search narrows items");
  await p.getByPlaceholder(/Search name, SKU/).fill(""); await p.waitForTimeout(500);
  await p.locator("th", { hasText: "Selling Price" }).click(); await p.waitForTimeout(700);
  const prices = (await p.locator("tbody tr td:nth-child(5)").allInnerTexts()).map((x) => +x.split("\n")[0].replace(/[₹,]/g, "")); ok(prices.length > 2 && prices.join() === [...prices].sort((a, b) => a - b).join(), "sorting by price works");
  await p.locator("tbody tr").first().locator("td").nth(3).click(); await p.waitForTimeout(700);
  ok((await p.getByRole("dialog").innerText()).toLowerCase().includes("stock by warehouse"), "quick view shows warehouse stock");
  ok(await p.getByRole("dialog").locator('img[alt="Barcode"]').count() === 1, "quick view renders the generated barcode (authenticated SVG)");
  await p.screenshot({ path: OUT + "p1-01-item-quickview.png" }); await p.keyboard.press("Escape"); await p.waitForTimeout(400);

  // ---------- items: create with validation, vendor, brand, opening stock, image ----------
  await p.goto(B + "/products/new"); await p.waitForTimeout(800);
  await p.getByRole("button", { name: "Save" }).click(); await p.waitForTimeout(300);
  ok((await body()).includes("Item name is required"), "empty item form is rejected inline");
  await p.locator("input").first().fill(`E2E Widget ${tag}`);
  await p.locator('input[maxlength="8"]').fill("12"); await p.locator('input[maxlength="8"]').blur(); await p.waitForTimeout(200);
  ok((await body()).includes("HSN is 4–8 digits"), "HSN validation message");
  await p.locator('input[maxlength="8"]').fill("73181500");
  await p.locator('input[list="brand-list"]').fill(`E2EBrand${tag}`);
  const vendorSel = p.locator("select").filter({ has: p.locator("option", { hasText: "VEN-" }) }); await vendorSel.selectOption({ index: 1 });
  const nums = p.locator('input[type=number]');
  await nums.nth(0).fill("40"); await nums.nth(1).fill("75"); await nums.nth(2).fill("10");  // purchase, selling, reorder
  await nums.nth(4).fill("25");  // opening stock
  await p.locator('input[type=file]').setInputFiles({ name: "pic.png", mimeType: "image/png", buffer: PNG });
  await p.waitForTimeout(300); ok(await p.locator('img[alt="Preview"]').count() === 1, "chosen image previews before saving");
  await p.getByRole("button", { name: "Save" }).click(); await p.waitForURL(/\/products\/\d+$/, { timeout: 8000 }); await p.waitForTimeout(1000);
  const itemId = p.url().split("/").pop(); created.items.push(itemId);
  const txt = await body();
  ok(txt.includes(`E2E Widget ${tag}`) && txt.includes(`E2EBrand${tag}`) && txt.includes("25"), "item created: details, brand and opening stock shown");
  ok(await p.locator('img[alt="Barcode"], img[alt^="Barcode"]').count() >= 1 && await p.locator('img[alt="QR code (SKU)"]').count() === 1, "barcode and QR code are rendered");
  const api1 = await jget(`/products/${itemId}`); ok(api1.has_image && api1.on_hand === 25 && api1.brand_id && api1.preferred_vendor_id, "database holds image flag, stock, brand and vendor");
  await p.screenshot({ path: OUT + "p1-02-item-detail.png" });
  await p.getByRole("tab", { name: "Stock history" }).click(); await p.waitForTimeout(900);
  ok((await body()).toLowerCase().includes("opening"), "stock history lists the opening-balance movement");
  // edit
  await p.goto(`${B}/products/${itemId}/edit`); await p.waitForTimeout(900);
  ok(await p.locator("input[disabled]").count() >= 1, "SKU is locked when editing");
  await p.locator("input").first().fill(`E2E Widget ${tag} v2`); await p.getByRole("button", { name: "Save" }).click(); await p.waitForURL(/\/products\/\d+$/, { timeout: 8000 }); await p.waitForTimeout(700);
  ok((await body()).includes(`v2`), "item edit saved");
  // bulk + archive from list
  await p.goto(B + "/products"); await p.getByPlaceholder(/Search name, SKU/).fill(`E2E Widget ${tag}`); await p.waitForTimeout(800);
  await p.locator("tbody tr").first().locator('input[type=checkbox]').check({ force: true }); await p.waitForTimeout(300);
  ok((await p.getByRole("toolbar").innerText()).includes("1 selected"), "bulk toolbar appears for selected items");
  await p.getByRole("button", { name: "Mark inactive" }).click(); await p.waitForTimeout(1500);
  ok((await jget(`/products/${itemId}`)).status === "inactive", "bulk 'Mark inactive' updated the database");
  // delete blocked for item with stock history
  await p.goto(`${B}/products/${itemId}`); await p.waitForTimeout(800);
  await p.locator('button[aria-label="More actions"]').click(); await p.getByRole("menuitem", { name: "Delete" }).click(); await p.getByRole("dialog").getByRole("button", { name: "Delete" }).click(); await p.waitForTimeout(900);
  ok((await jget(`/products/${itemId}`)).id == itemId, "item with stock history can't be deleted (still exists)");
  // CSV drop import
  await p.goto(B + "/products"); await p.waitForTimeout(900);
  await p.evaluate((tag) => { const dt = new DataTransfer(); dt.items.add(new File([`name,sku,brand,status,purchase_price,selling_price,opening_stock\nCSV Item ${tag},CSV-${tag},Generic,active,5,9,12\nBad Row ${tag},BAD-${tag},,weird,1,1,0\n`], "i.csv", { type: "text/csv" })); window.__dt = dt; document.body.dispatchEvent(new DragEvent("dragenter", { dataTransfer: dt, bubbles: true })); }, tag);
  await p.waitForTimeout(250); ok((await body()).includes("Drop CSV to import items"), "drag overlay appears on items page");
  await p.evaluate(() => document.body.dispatchEvent(new DragEvent("drop", { dataTransfer: window.__dt, bubbles: true, cancelable: true }))); await p.waitForTimeout(1500);
  ok((await body()).includes("1 item imported") && (await body()).includes("status must be active or inactive"), "dropped items CSV imported 1 row and reported the bad row");
  const csvItem = (await jget(`/products?q=CSV-${tag}`)).items[0]; created.items.push(csvItem?.id); ok(csvItem && csvItem.on_hand === 12, "imported item has its opening stock in the ledger");
  await p.getByRole("button", { name: "Done" }).click();

  // ---------- customers ----------
  await p.goto(B + "/customers"); await p.waitForTimeout(1200);
  ok((await p.locator("tbody tr").count()) >= 8, "customers list shows seeded customers");
  await p.selectOption('select[aria-label="Type"]', "individual"); await p.waitForTimeout(700);
  ok((await p.locator("tbody tr").count()) >= 1 && (await p.locator("tbody").innerText()).toLowerCase().includes("individual"), "customer type filter works");
  await p.selectOption('select[aria-label="Type"]', "");
  await p.goto(B + "/customers/new"); await p.waitForTimeout(700);
  await p.locator("input").first().fill(`E2E Customer ${tag}`);
  await p.locator('input[maxlength="15"]').fill("BADGSTIN"); await p.locator('input[maxlength="15"]').blur(); await p.waitForTimeout(200);
  ok((await body()).includes("GSTIN format"), "GSTIN validated inline");
  await p.locator('input[maxlength="15"]').fill(`27AABCE${tag.slice(-4)}Z1Z5`);
  await p.locator('input[type=email]').fill(`e2e${tag}@example.com`);
  await p.locator("textarea").first().fill("12 MG Road"); await p.getByText("Copy from billing address").click(); await p.waitForTimeout(200);
  ok((await p.locator("textarea").nth(1).inputValue()) === "12 MG Road", "'copy from billing' fills the shipping address");
  await p.getByRole("button", { name: "Save" }).click(); await p.waitForURL(/\/customers\/\d+$/, { timeout: 8000 }); await p.waitForTimeout(800);
  const custId = p.url().split("/").pop(); created.customers.push(custId);
  ok((await body()).includes(`E2E Customer ${tag}`) && /CUS-\d{5}/.test(await body()), "customer created with an auto-generated customer ID");
  await p.screenshot({ path: OUT + "p1-03-customer-detail.png" });
  await p.goto(B + "/customers/new"); await p.locator("input").first().fill("Dup GST"); await p.locator('input[maxlength="15"]').fill(`27AABCE${tag.slice(-4)}Z1Z5`); await p.getByRole("button", { name: "Save" }).click(); await p.waitForTimeout(900);
  ok((await body()).includes("already uses GSTIN"), "duplicate GSTIN rejected by the server and shown on the field");
  await p.goto(`${B}/customers/${custId}/edit`); await p.waitForTimeout(800);
  await p.locator("select").nth(1).selectOption("60"); await p.getByRole("button", { name: "Save" }).click(); await p.waitForURL(/\/customers\/\d+$/, { timeout: 8000 }); await p.waitForTimeout(700);
  ok((await body()).includes("Net 60"), "customer edit persisted (payment terms)");
  await p.getByRole("tab", { name: "Activity" }).click(); await p.waitForTimeout(700);
  ok((await body()).includes("Updated") && (await body()).includes("Created"), "activity timeline shows create and update events");
  await p.goto(B + "/customers"); await p.getByPlaceholder(/Search name/).fill(`E2E Customer ${tag}`); await p.waitForTimeout(800);
  await p.locator('button[aria-label="More actions"]').first().click(); await p.getByRole("menuitem", { name: "Mark inactive" }).click(); await p.waitForTimeout(900);
  ok((await jget(`/customers/${custId}`)).status === "inactive", "row menu 'Mark inactive' updates the database");

  // ---------- vendors + masking + permissions ----------
  await p.goto(B + "/vendors/new"); await p.waitForTimeout(700);
  await p.locator("input").first().fill(`E2E Vendor ${tag}`);
  await p.locator('input[maxlength="11"]').fill("BAD"); await p.locator('input[maxlength="11"]').blur(); await p.waitForTimeout(200);
  ok((await body()).includes("IFSC looks like"), "IFSC validated inline");
  await p.locator('input[maxlength="11"]').fill("HDFC0001234");
  const bank = p.locator("input").filter({ hasNot: p.locator("[maxlength=11]") }); // account number is the field with the hint
  await p.getByText("6–18 digits").locator("xpath=preceding-sibling::input").fill("123456789012");
  await p.getByRole("button", { name: "Save" }).click(); await p.waitForURL(/\/vendors\/\d+$/, { timeout: 8000 }); await p.waitForTimeout(800);
  const venId = p.url().split("/").pop(); created.vendors.push(venId);
  ok((await body()).includes("123456789012") && (await body()).includes("HDFC0001234"), "purchasing managers see full bank details");
  const wt = await login("warehouse@demo.com"); const wp = await mk(wt);
  await wp.goto(`${B}/vendors/${venId}`); await wp.waitForTimeout(1000);
  const wtext = await wp.locator("body").innerText(); ok(!wtext.includes("123456789012") && wtext.includes("XXXXXXXX9012"), "warehouse staff see the bank account masked");
  ok((await wp.getByRole("button", { name: "Edit" }).count()) === 0, "read-only role has no Edit button on a vendor");
  const vt = await login("viewer@demo.com"); const vp = await mk(vt);
  await vp.goto(B + "/customers"); await vp.waitForTimeout(1000);
  ok((await vp.getByRole("button", { name: /New Customer/ }).count()) === 0 && (await vp.locator("tbody tr").count()) > 0, "viewer can browse customers but sees no create button");
  await vp.goto(B + "/customers/new"); await vp.waitForSelector("[data-testid=access-denied]", { timeout: 6000 }).catch(() => {});
  ok((await vp.locator("[data-testid=access-denied]").count()) === 1, "typing /customers/new as a viewer shows Access denied");
  const hx = await fetch(API + "/customers", { method: "POST", headers: { Authorization: "Bearer " + vt.access_token, "Content-Type": "application/json" }, body: JSON.stringify({ name: "Hacker" }) });
  ok(hx.status === 403, "server rejects a viewer's create even when called directly");
  // vendor linked to an item can't be deleted
  const linked = (await jget("/vendors?q=Bharat")).items[0];
  await p.goto(`${B}/vendors/${linked.id}`); await p.waitForTimeout(800);
  await p.locator('button[aria-label="More actions"]').click(); await p.getByRole("menuitem", { name: "Delete" }).click(); await p.getByRole("dialog").getByRole("button", { name: "Delete" }).click(); await p.waitForTimeout(900);
  ok((await jget(`/vendors/${linked.id}`)).id === linked.id, "vendor that is a preferred vendor can't be deleted");
  await p.getByRole("tab", { name: "Items supplied" }).click(); await p.waitForTimeout(800); ok((await p.locator("tbody tr").count()) >= 1, "vendor 'Items supplied' tab lists linked items");
  await p.screenshot({ path: OUT + "p1-04-vendor-detail.png" });
  // mobile
  const mp = await mk(t, { viewport: { width: 390, height: 800 }, hasTouch: true, isMobile: true });
  await mp.goto(B + "/products"); await mp.waitForTimeout(1200); ok(await mp.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), "mobile: items list has no page-level horizontal scroll");
  await mp.goto(B + "/customers/new"); await mp.waitForTimeout(900); ok(await mp.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), "mobile: customer form fits the screen");

  // ---------- cleanup ----------
  for (const id of created.customers) await fetch(API + `/customers/${id}`, { method: "DELETE", headers: H });
  for (const id of created.vendors) await fetch(API + `/vendors/${id}`, { method: "DELETE", headers: H });
  for (const id of created.items.filter(Boolean)) { // items with history cannot be deleted: write the stock off through the ledger, then archive
    const it = await jget(`/products/${id}`);
    for (const b of it.balances || []) if (b.available > 0) await fetch(API + "/inventory/adjust", { method: "POST", headers: H, body: JSON.stringify({ product_id: +id, warehouse_id: b.warehouse_id, mode: "decrease", quantity: b.available, reason: "e2e cleanup" }) });
    await fetch(API + `/products/${id}`, { method: "PATCH", headers: H, body: JSON.stringify({ is_archived: true }) });
  }
  const rec = await jget("/inventory/reconcile"); ok(rec.ok, "ledger still reconciles after all UI operations");
  console.log("console/page errors:", JSON.stringify(errs.slice(0, 6)));
  console.log(fails ? `\n${fails} CHECK(S) FAILED` : "\nALL CHECKS PASSED");
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
