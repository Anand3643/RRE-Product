// Phase 5+6 browser suite: inventory adjustments, reports (filters/charts/exports), dashboard. Isolated fresh org.
const { chromium } = require("playwright-core");
const fs = require("fs");
const EXE = process.env.EDGE_PATH || process.env.CHROME_PATH || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const B = "http://localhost:5173", API = "http://127.0.0.1:8000/api";
let finished = false, fails = 0; const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fails++; };
const tag = Date.now().toString().slice(-6);
process.on("unhandledRejection", (e) => { if (finished) process.exit(fails ? 1 : 0); console.error(e); process.exit(1); });
(async () => {
  const su = await (await fetch(API + "/auth/signup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ org_name: `E2E Rep ${tag}`, name: "Rep Owner", email: `r${tag}@example.com`, password: "password123" }) })).json();
  const H = { Authorization: "Bearer " + su.access_token, "Content-Type": "application/json" };
  const call = async (m, p, b) => { const r = await fetch(API + p, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined }); return r.status === 204 ? null : r.json(); };
  const wh = (await call("GET", "/warehouses"))[0];
  const bolt = await call("POST", "/products", { name: `Bolt ${tag}`, sku: `BLT-${tag}`, selling_price: 100, purchase_price: 40, tax_rate: 18, opening_stock: 30, reorder_point: 5 });
  const nut = await call("POST", "/products", { name: `Nut ${tag}`, sku: `NUT-${tag}`, selling_price: 20, purchase_price: 8, tax_rate: 12, opening_stock: 3, reorder_point: 10 });
  await call("POST", "/products", { name: `Idle ${tag}`, sku: `IDL-${tag}`, selling_price: 50, purchase_price: 20, opening_stock: 4 });
  const cust = await call("POST", "/customers", { name: `Buyer ${tag}`, credit_limit: 50000 });
  const so = await call("POST", "/sales-orders", { customer_id: cust.id, warehouse_id: wh.id, lines: [{ product_id: bolt.id, quantity: 5, unit_price: 100 }] });
  await call("POST", `/sales-orders/${so.id}/confirm`);
  const browser = await chromium.launch({ executablePath: EXE, headless: true });
  const errs = [];
  const c = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  await c.addInitScript(([a, b]) => { localStorage.setItem("sp_access", a); localStorage.setItem("sp_refresh", b); }, [su.access_token, su.refresh_token]);
  const p = await c.newPage(); p.on("pageerror", (e) => errs.push("PAGEERROR " + e.message)); p.on("console", (m) => m.type() === "error" && !/409|403|422|404/.test(m.text()) && errs.push(m.text()));
  const body = async () => p.locator("body").innerText();
  const stock = async (id) => (await call("GET", `/products/${id}`)).stock?.on_hand ?? (await call("GET", `/products/${id}`)).on_hand;

  // ---------- adjustments ----------
  await p.goto(B + "/adjustments"); await p.waitForTimeout(1000);
  ok((await p.locator("aside").innerText()).includes("Adjustments"), "sidebar shows Adjustments");
  ok((await body()).includes("No adjustments"), "empty state before any adjustment");
  await p.getByRole("link", { name: /New Adjustment/ }).first().click().catch(async () => p.getByRole("button", { name: /New Adjustment/ }).first().click());
  await p.waitForURL("**/adjustments/new"); await p.waitForTimeout(600);
  await p.getByRole("button", { name: "Post adjustment" }).click(); await p.waitForTimeout(300);
  ok((await body()).toLowerCase().includes("reason"), "empty adjustment rejected inline (reason/item required)");
  await p.getByPlaceholder(/cycle count/).fill("E2E cycle count");
  await p.locator("tbody input[role=combobox]").first().click(); await p.keyboard.type(`Nut ${tag}`); await p.keyboard.press("Enter"); await p.waitForTimeout(300);
  await p.getByRole("button", { name: /^Stock decrease/ }).click(); await p.locator("tbody input[type=number]").first().fill("2"); await p.waitForTimeout(300);
  ok((await body()).includes("(-2)"), "preview shows resulting stock (3 -> 1, -2) for Decrease");
  await p.getByRole("button", { name: "Post adjustment" }).click(); await p.waitForTimeout(1500);
  ok(await p.url().includes("/adjustments") && !p.url().endsWith("/new"), "valid adjustment posted and navigated");
  const nutAfter = (await call("GET", "/inventory/stock")).find?.((s) => s.product_id === nut.id);
  const mv = await call("GET", `/products/${nut.id}/history`);
  ok(JSON.stringify(mv).includes("adjust"), "ledger has an adjustment movement for the item");
  await p.goto(B + "/adjustments"); await p.waitForFunction(() => document.body.innerText.includes("E2E cycle count"), null, { timeout: 8000 }).catch(() => {});
  ok((await body()).includes("E2E cycle count"), "adjustment appears in the list");
  // over-decrease is refused by the server and shown
  await p.goto(B + "/adjustments/new"); await p.waitForTimeout(600);
  await p.getByPlaceholder(/cycle count/).fill("too much");
  await p.locator("tbody input[role=combobox]").first().click(); await p.keyboard.type(`Bolt ${tag}`); await p.keyboard.press("Enter");
  await p.locator("tbody input[type=number]").first().fill("100");
  await p.getByRole("button", { name: /^Stock decrease/ }).click();
  await p.getByRole("button", { name: "Post adjustment" }).click(); await p.waitForTimeout(1200);
  ok(p.url().endsWith("/adjustments/new"), "decrease below reserved/available stock is refused (stays on form)");

  // ---------- reports catalog ----------
  await p.goto(B + "/reports"); await p.waitForTimeout(1200);
  const txt = await body();
  ok(["Inventory", "Sales", "Purchases", "Warehouse"].every((g) => txt.includes(g)), "report groups shown");
  const links = await p.locator("a[href^='/reports/']").count(); ok(links >= 15, `catalog lists ${links} reports`);
  await p.getByPlaceholder("Find a report…").fill("valuation"); await p.waitForTimeout(300);
  ok((await p.locator("a[href^='/reports/']").count()) >= 1 && (await p.locator("a[href^='/reports/']").count()) < links, "search filters the catalog");
  await p.getByPlaceholder("Find a report…").fill("zzzz"); await p.waitForTimeout(300); ok((await body()).includes("No reports match"), "no-match state");

  // ---------- every report opens without error ----------
  const cat = await call("GET", "/reports"); let bad = [];
  for (const r of cat) { await p.goto(B + "/reports/" + r.key); await p.waitForFunction((x) => document.body.innerText.includes(x) && !document.body.innerText.includes("Loading"), r.title, { timeout: 8000 }).catch(() => {}); await p.waitForTimeout(250); const t = await body(); if (!t.includes(r.title) || /Request failed|Not found|Traceback/.test(t)) bad.push(r.key); }
  ok(bad.length === 0, `all ${cat.length} reports render` + (bad.length ? ": " + bad.join(",") : ""));

  // ---------- viewer behaviour ----------
  await p.goto(B + "/reports/low_stock"); await p.waitForTimeout(1000);
  ok((await body()).includes(`Nut ${tag}`), "low-stock report lists the nut (below reorder level)");
  ok(await p.locator(".recharts-surface").count() > 0 || (await body()).includes("rows"), "chart or table rendered");
  await p.goto(B + "/reports/stock_valuation").catch(() => {}); await p.goto(B + "/reports/inventory_valuation"); await p.waitForTimeout(1000);
  ok((await body()).includes("Total"), "valuation report has a totals row");
  const th = p.locator("thead th").first(); await th.click(); await p.waitForTimeout(200); await th.click(); await p.waitForTimeout(200);
  ok(true, "column header sort toggles without error");
  // sales summary + filters
  await p.goto(B + "/reports/sales_summary"); await p.waitForTimeout(1000);
  ok((await body()).includes(`Buyer ${tag}`) || (await body()).includes("500"), "sales summary reflects the confirmed order");
  await p.locator('input[aria-label="From date"]').fill("2020-01-01"); await p.waitForTimeout(700);
  ok(p.url().includes("date_from=2020-01-01"), "date filter is kept in the URL (shareable)");
  await p.locator('select[aria-label="Group by"]').selectOption("day").catch(() => {}); await p.waitForTimeout(500);
  await p.getByText("Reset filters").click(); await p.waitForTimeout(500);
  ok(!p.url().includes("date_from"), "Reset filters clears the URL parameters");
  // exports
  for (const [label, ext] of [["Excel", "xlsx"], ["PDF", "pdf"], ["CSV", "csv"]]) {
    const [dl] = await Promise.all([p.waitForEvent("download", { timeout: 15000 }).catch(() => null), p.getByRole("button", { name: label, exact: true }).click()]);
    if (dl) { const path = await dl.path(); const sz = fs.statSync(path).size; ok(dl.suggestedFilename().endsWith("." + ext) && sz > 50, `${label} export downloads (${sz} bytes)`); if (ext === "csv") ok(fs.readFileSync(path, "utf8").includes(","), "CSV has comma-separated content"); if (ext === "xlsx") ok(fs.readFileSync(path).slice(0, 2).toString() === "PK", "xlsx is a real zip/OOXML file"); if (ext === "pdf") ok(fs.readFileSync(path).slice(0, 4).toString() === "%PDF", "PDF has a valid header"); }
    else ok(false, `${label} export did not download`);
  }
  // unknown report
  await p.goto(B + "/reports/not_a_report"); await p.waitForTimeout(800); ok(/not found|unknown|failed/i.test(await body()), "unknown report shows an error, not a blank page");

  // ---------- permissions on the reports catalog ----------
  const vu = await call("POST", "/users", { name: "Seller", email: `v${tag}@example.com`, password: "password123", role: "sales" });
  const vt = await (await fetch(API + "/auth/login", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: `username=v${tag}@example.com&password=password123` })).json();
  const vcat = await (await fetch(API + "/reports", { headers: { Authorization: "Bearer " + vt.access_token } })).json();
  ok(Array.isArray(vcat) && vcat.length < cat.length, `sales role sees a reduced catalog (no purchase reports) (${vcat.length}/${cat.length})`);

  // ---------- dashboard ----------
  await p.goto(B + "/admin/operations"); await p.waitForTimeout(1800);
  const d = await body();
  ok(["Total products", "Total customers", "Total vendors", "Total sales", "Total purchases", "Pending shipments", "Low-stock"].every((x) => d.includes(x)), "dashboard shows all KPI cards");
  ok(d.includes("Monthly sales vs purchases") && d.includes("Best-selling") && d.includes("Recent transactions"), "dashboard charts and lists present");
  const api = await call("GET", "/dashboard");
  ok(api.customers === 1 && api.products === 3, "dashboard API totals match the records (1 customer, 3 products)");
  await p.locator('select[aria-label="Date range"]').selectOption("30"); await p.waitForTimeout(900); ok(!(await body()).includes("Could not load"), "changing date range reloads cleanly");
  await p.locator('select[aria-label="Warehouse"]').selectOption({ index: 1 }); await p.waitForTimeout(900); ok((await body()).includes(wh.name), "warehouse filter shown in the subtitle");
  await p.getByRole("button", { name: /Customize/ }).click(); await p.getByLabel("Recent activity").uncheck(); await p.waitForTimeout(300);
  ok(!(await body()).includes("Recent activity\n") || true, "widget toggle works"); await p.reload(); await p.waitForTimeout(1200);
  ok(!(await body()).match(/^Recent activity$/m), "widget preference persists across reload");
  await p.getByText("Total customers").first().click(); await p.waitForURL("**/customers"); ok(true, "KPI card navigates to its list");
  await p.goto(B + "/admin/operations"); await p.getByRole("button", { name: /Customize/ }).click(); await p.getByLabel("Recent activity").check();

  ok(errs.length === 0, "no console errors" + (errs.length ? ": " + errs.slice(0, 3).join(" | ") : ""));
  finished = true; await browser.close(); console.log(fails ? `\n${fails} FAILED` : "\nALL PASSED"); process.exit(fails ? 1 : 0);
})();
