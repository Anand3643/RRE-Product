const { chromium } = require("playwright-core");
// Browser regression suite for the Warehouses module and shell. Needs: API on :8000 seeded with demo data (python seed.py), `npm run dev`,
// and a Chromium-based browser (set EDGE_PATH or CHROME_PATH; defaults to Windows Edge). Run: npm run e2e
const OUT = __dirname + "/shots/";
const EXE = process.env.EDGE_PATH || process.env.CHROME_PATH || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const B = "http://localhost:5173", API = "http://127.0.0.1:8000/api";
let fails = 0; const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const t = await (await fetch(API + "/auth/login", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "username=owner@demo.com&password=demo1234" })).json();
  const H = { Authorization: "Bearer " + t.access_token, "Content-Type": "application/json" };
  const jget = async (p) => (await fetch(API + p, { headers: H })).json();
  const cleanup = async () => { for (const w of await jget("/warehouses")) if (/^(TA\d|P\d\d|IM\d|PUN)$/.test(w.code)) { if (!w.is_active) await fetch(API + `/warehouses/${w.id}`, { method: "PATCH", headers: H, body: JSON.stringify({ is_active: true }) }); await fetch(API + `/warehouses/${w.id}`, { method: "DELETE", headers: H }); } };
  await cleanup();
  const browser = await chromium.launch({ executablePath: EXE, headless: true });
  const errs = [];
  const mk = async (opts = {}) => {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ["clipboard-read", "clipboard-write"], ...opts });
    await ctx.addInitScript(([a, b]) => { localStorage.setItem("sp_access", a); localStorage.setItem("sp_refresh", b); window.__cls = 0; try { new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__cls += e.value; }).observe({ type: "layout-shift", buffered: true }); } catch {} }, [t.access_token, t.refresh_token]);
    const p = await ctx.newPage(); p.on("pageerror", (e) => errs.push("PAGEERROR " + e.message)); p.on("console", (m) => m.type() === "error" && !/409|403|422/.test(m.text()) && errs.push(m.text()));
    return { ctx, p };
  };
  const { p } = await mk();
  const rows = () => p.locator("tbody tr");
  const warehouses = await jget("/warehouses"); const first = warehouses.find((w) => w.code === "BLR");

  // ---------- count-up + stagger on dashboard ----------
  await p.goto(B + "/"); await p.waitForTimeout(150);
  const early = await p.locator("main .card p.text-2xl").first().innerText();
  await p.waitForTimeout(1500);
  const late = await p.locator("main .card p.text-2xl").first().innerText();
  ok(early !== late && /^₹?\d/.test(late) && !early.includes("-"), `KPI counts up (${early} -> ${late})`);
  ok((await p.locator("main > div").first().evaluate((e) => getComputedStyle(e).animationName)) === "slide-up", "page transition animation applied");

  // ---------- warehouse list: hover, tooltip, quick view ----------
  await p.goto(B + "/warehouses"); await p.waitForTimeout(1200);
  const row = rows().first();
  const op0 = await row.locator(".row-actions").evaluate((e) => getComputedStyle(e).opacity);
  await row.hover(); await p.waitForTimeout(300);
  const op1 = await row.locator(".row-actions").evaluate((e) => getComputedStyle(e).opacity);
  ok(op0 === "0" && op1 === "1", `contextual row actions appear on hover (${op0} -> ${op1})`);
  await row.locator('button[aria-label^="View"]').hover(); await p.waitForTimeout(700);
  const tipOp = await row.locator('button[aria-label^="View"]').evaluate((e) => getComputedStyle(e, "::after").opacity);
  ok(tipOp === "1", "tooltip shows on icon hover");
  await p.screenshot({ path: OUT + "u01-list-hover.png" });
  await row.locator("td").nth(3).click(); await p.waitForTimeout(500);
  ok(await p.getByRole("dialog").count() === 1, "clicking a row opens the quick-view panel");
  await p.screenshot({ path: OUT + "u02-quickview.png" });
  await p.keyboard.press("Escape"); await p.waitForTimeout(450);
  ok(await p.getByRole("dialog").count() === 0, "Escape closes the quick view");
  await row.locator("td").nth(3).click(); await p.waitForTimeout(400); await p.mouse.click(200, 400); await p.waitForTimeout(450);
  ok(await p.getByRole("dialog").count() === 0, "scrim click closes the quick view");

  // ---------- selection + bulk bar ----------
  await row.locator('input[type=checkbox]').check({ force: true }); await p.waitForTimeout(300);
  ok((await p.getByRole("toolbar").innerText()).includes("1 selected"), "row checkbox shows bulk toolbar");
  await p.screenshot({ path: OUT + "u03-bulk.png" });
  await p.getByRole("button", { name: "Clear selection" }).click(); await p.waitForTimeout(250);
  ok(await p.getByRole("toolbar").count() === 0, "clear selection hides toolbar");
  await p.locator('thead input[type=checkbox]').check({ force: true }); await p.waitForTimeout(250);
  ok((await p.getByRole("toolbar").innerText()).includes(`${await rows().count()} selected`), "select-all selects every row on the page");
  await p.getByRole("button", { name: "Clear selection" }).click();

  // ---------- keyboard navigation ----------
  await rows().first().focus(); await p.keyboard.press("ArrowDown");
  ok(await rows().nth(1).evaluate((e) => e === document.activeElement), "ArrowDown moves row focus");
  await p.keyboard.press(" "); await p.waitForTimeout(200);
  ok((await rows().nth(1).getAttribute("aria-selected")) === "true", "Space toggles row selection");
  await p.keyboard.press(" "); await p.keyboard.press("Enter"); await p.waitForTimeout(450);
  ok(await p.getByRole("dialog").count() === 1, "Enter opens quick view"); await p.keyboard.press("Escape"); await p.waitForTimeout(400);

  // ---------- sorting + column reorder (persisted) ----------
  await p.locator("th", { hasText: "Warehouse Name" }).click(); await p.waitForTimeout(500);
  ok((await p.locator("th", { hasText: "Warehouse Name" }).getAttribute("aria-sort")) === "descending", "sort click toggles aria-sort with visual arrow");
  await p.locator("th", { hasText: "Code" }).dragTo(p.locator("th", { hasText: "Warehouse Name" })); await p.waitForTimeout(400);
  const heads = await p.locator("thead th").allInnerTexts();
  ok(heads.findIndex((h) => /^\s*CODE/i.test(h)) < heads.findIndex((h) => /WAREHOUSE NAME/i.test(h)), "drag-and-drop reorders columns: " + heads.filter(Boolean).join(" | "));
  await p.reload(); await p.waitForTimeout(900);
  const heads2 = await p.locator("thead th").allInnerTexts();
  ok(heads2.findIndex((h) => /^\s*CODE/i.test(h)) < heads2.findIndex((h) => /WAREHOUSE NAME/i.test(h)), "column order persists after reload");
  await p.screenshot({ path: OUT + "u04-reordered.png" });
  await p.getByRole("button", { name: "Reset columns" }).click(); await p.waitForTimeout(300);

  // ---------- pagination + bulk delete with progress (12 temp warehouses) ----------
  for (let i = 1; i <= 12; i++) await fetch(API + "/warehouses", { method: "POST", headers: H, body: JSON.stringify({ code: `P${String(i).padStart(2, "0")}`, name: `Temp Site ${i}` }) });
  await p.goto(B + "/warehouses"); await p.waitForTimeout(900);
  await p.getByPlaceholder(/Search name/).fill("Temp Site"); await p.waitForTimeout(700);
  ok((await p.locator("body").innerText()).includes("Page 1 of 2"), "pagination: 12 rows -> 2 pages");
  await p.getByRole("button", { name: "Next" }).click(); await p.waitForTimeout(600);
  ok(await rows().count() === 2, "page 2 shows remaining rows");
  await p.getByRole("button", { name: "Previous" }).click(); await p.waitForTimeout(600);
  await p.locator('thead input[type=checkbox]').check({ force: true }); await p.getByRole("button", { name: "Delete", exact: true }).first().click(); await p.waitForTimeout(300);
  await p.screenshot({ path: OUT + "u05-confirm-delete.png" });
  await p.getByRole("dialog").getByRole("button", { name: "Delete" }).click();
  await p.waitForTimeout(2500);
  const left = (await jget("/warehouses")).filter((w) => /^P\d\d$/.test(w.code)).length;
  ok(left === 2, `bulk delete removed the 10 selected (remaining via API: ${left})`);
  // bulk archive the remaining two
  await p.getByPlaceholder(/Search name/).fill("Temp Site"); await p.waitForTimeout(700);
  await p.locator('thead input[type=checkbox]').check({ force: true });
  await p.getByRole("button", { name: "Archive", exact: true }).click(); await p.waitForTimeout(400);
  await p.getByRole("dialog").getByRole("button", { name: "Archive" }).count() && await p.getByRole("dialog").getByRole("button", { name: "Archive" }).click().catch(() => {});
  await p.waitForTimeout(1800);
  const arch = (await jget("/warehouses?status=archived")).filter((w) => /^P\d\d$/.test(w.code)).length;
  ok(arch === 2 || (await jget("/warehouses")).filter((w) => /^P\d\d$/.test(w.code) && !w.is_active).length === 2, "bulk archive archived both");
  const hadToast = await p.locator(".anim-toast, .anim-toast-out").count();
  ok(hadToast > 0, "toast notification appears");
  await p.waitForTimeout(5000);
  ok(await p.locator(".anim-toast").count() === 0, "toast disappears on its own after its exit animation");

  // ---------- CSV drag & drop import ----------
  await cleanup();
  await p.goto(B + "/warehouses"); await p.waitForTimeout(900);
  await p.evaluate(() => { const dt = new DataTransfer(); dt.items.add(new File(["code,name,city\nIM1,Imported One,Pune\nIM2,Imported Two,Surat\nIM1,Dup,X\n"], "w.csv", { type: "text/csv" })); window.__dt = dt; document.body.dispatchEvent(new DragEvent("dragenter", { dataTransfer: dt, bubbles: true })); });
  await p.waitForTimeout(250);
  ok((await p.locator("body").innerText()).includes("Drop CSV to import"), "drag overlay appears while a file is dragged over the page");
  await p.screenshot({ path: OUT + "u06-dropzone.png" });
  await p.evaluate(() => document.body.dispatchEvent(new DragEvent("drop", { dataTransfer: window.__dt, bubbles: true, cancelable: true })));
  await p.waitForTimeout(1500);
  const txt = await p.locator("body").innerText();
  ok(txt.includes("2 warehouses imported") && txt.includes("Code IM1 already exists"), "dropped CSV imported 2 rows and reported the duplicate");
  await p.screenshot({ path: OUT + "u07-import-result.png" });
  await p.getByRole("button", { name: "Done" }).click(); await cleanup();

  // ---------- form validation without layout shift + success animation ----------
  await p.goto(B + "/warehouses/new"); await p.waitForTimeout(700);
  const h0 = (await p.locator("form .card").boundingBox()).height;
  await p.locator("input[type=email]").fill("nope"); await p.locator("input[type=email]").blur(); await p.waitForTimeout(300);
  const h1 = (await p.locator("form .card").boundingBox()).height;
  ok((await p.locator("form").innerText()).includes("valid email") && Math.abs(h1 - h0) < 1, `inline validation appears with no layout shift (${h0} -> ${h1})`);
  await p.locator("input").first().fill("Zed Depot"); await p.locator("input.uppercase").fill("PUN"); await p.locator("input[type=email]").fill("z@x.com");
  await p.getByRole("button", { name: "Save" }).click(); await p.waitForTimeout(350);
  ok(await p.locator("svg .check-path").count() > 0, "success check animation plays after saving");
  await p.screenshot({ path: OUT + "u08-success.png" });
  await p.waitForURL(/\/warehouses\/\d+$/); await p.waitForTimeout(600);
  const pun = (await jget("/warehouses")).find((w) => w.code === "PUN");
  ok(!!pun, "warehouse persisted in the database after the animation");
  // duplicate code -> field error
  await p.goto(B + "/warehouses/new"); await p.locator("input").first().fill("Dup"); await p.locator("input.uppercase").fill("PUN"); await p.getByRole("button", { name: "Save" }).click(); await p.waitForTimeout(600);
  ok((await p.locator("form").innerText()).includes("already exists"), "server error shown on the code field");
  await p.screenshot({ path: OUT + "u09-form-error.png" });
  await fetch(API + `/warehouses/${pun.id}`, { method: "DELETE", headers: H });

  // ---------- detail: tabs, charts, panels ----------
  await p.goto(`${B}/warehouses/${first.id}`); await p.waitForTimeout(1200);
  await p.screenshot({ path: OUT + "u10-detail.png" });
  const ind1 = await p.locator('[role=tablist] > span').evaluate((e) => e.style.left);
  await p.getByRole("tab", { name: "Stock" }).click(); await p.waitForTimeout(1300);
  const ind2 = await p.locator('[role=tablist] > span').evaluate((e) => e.style.left);
  ok(ind1 !== ind2, `tab indicator slides (${ind1} -> ${ind2})`);
  ok(await p.locator(".recharts-surface").count() >= 3, "Stock tab renders 3 interactive charts");
  await p.locator(".recharts-bar-rectangle").nth(1).hover(); await p.waitForTimeout(400);
  const bx = await p.locator(".recharts-bar-rectangle").nth(1).boundingBox(); await p.mouse.move(bx.x + bx.width / 2 + 3, bx.y + bx.height / 2 + 1); await p.waitForTimeout(400);
  const tt = await p.evaluate(() => [...document.querySelectorAll(".recharts-tooltip-wrapper")].filter((e) => getComputedStyle(e).visibility === "visible").map((e) => e.innerText));
  ok(tt.length > 0 && tt[0].includes("on hand"), "hovering a chart shows details: " + (tt[0] || "").replace(/\n+/g, " "));
  await p.screenshot({ path: OUT + "u11-stock-charts.png" });
  await p.locator(".recharts-pie-sector path").first().dispatchEvent("click"); await p.waitForTimeout(900);
  ok(/tab=items/.test(p.url()) && /status=/.test(p.url()), "clicking a pie slice jumps to Products filtered by that status: " + p.url().split("?")[1]);
  await p.getByRole("tab", { name: "Activity" }).click(); await p.waitForTimeout(900);
  ok(await p.locator("ol li").count() > 3 && (await p.locator("body").innerText()).match(/20\d\d/), "activity timeline groups events by day");
  await p.screenshot({ path: OUT + "u12-activity.png" });
  await p.getByRole("tab", { name: "Overview" }).focus(); await p.keyboard.press("ArrowRight"); await p.waitForTimeout(500);
  ok(/tab=items/.test(p.url()), "arrow keys move between tabs");
  await p.goto(`${B}/warehouses/${first.id}`); await p.waitForTimeout(900);
  const info = p.getByRole("button", { name: "Warehouse information" });
  await info.click(); await p.waitForTimeout(400);
  ok((await info.getAttribute("aria-expanded")) === "false", "information panel collapses");
  await p.reload(); await p.waitForTimeout(800);
  ok((await p.getByRole("button", { name: "Warehouse information" }).getAttribute("aria-expanded")) === "false", "collapsed state is remembered");
  await p.getByRole("button", { name: "Warehouse information" }).click();
  const reqs = []; p.on("request", (r) => r.url().includes("/api/") && reqs.push(r.url()));
  await p.getByRole("button", { name: "Refresh data" }).click(); await p.waitForTimeout(800);
  ok(reqs.length >= 2, `Refresh re-fetches live data (${reqs.length} requests)`);

  // ---------- command palette + shortcuts + sidebar ----------
  await p.goto(B + "/"); await p.waitForTimeout(700);
  await p.keyboard.press("Control+k"); await p.waitForTimeout(300);
  ok(await p.getByRole("dialog", { name: "Search & commands" }).count() === 1, "Ctrl+K opens the command palette");
  await p.keyboard.type("warehouses"); await p.waitForTimeout(250); await p.keyboard.press("Enter"); await p.waitForTimeout(700);
  ok(p.url().endsWith("/warehouses"), "palette: type + Enter navigates");
  await p.keyboard.press("?"); await p.waitForTimeout(300);
  ok((await p.locator("body").innerText()).includes("Keyboard shortcuts"), "? opens shortcut help"); await p.keyboard.press("Escape"); await p.waitForTimeout(250);
  await p.keyboard.press("n"); await p.waitForTimeout(600);
  ok(p.url().endsWith("/warehouses/new"), "N creates a new warehouse");
  await p.locator("main h1").click(); await p.keyboard.press("g"); await p.keyboard.press("w"); await p.waitForTimeout(600);
  ok(p.url().endsWith("/warehouses"), "G then W goes to Warehouses");
  await p.keyboard.press("/"); ok(await p.evaluate(() => document.activeElement?.placeholder?.startsWith("Search name")), "/ focuses the search box");
  const w0 = (await p.locator("aside").first().boundingBox()).width;
  await p.getByRole("button", { name: "Toggle sidebar" }).click(); await p.waitForTimeout(500);
  const w1 = (await p.locator("aside").first().boundingBox()).width;
  ok(w0 > 150 && w1 < 70, `sidebar collapses smoothly (${w0}px -> ${w1}px)`);
  await p.screenshot({ path: OUT + "u13-collapsed.png" });
  await p.getByRole("button", { name: "Toggle sidebar" }).click();

  // ---------- AI assistant ----------
  await p.route("**/assistant/chat", async (r) => { await sleep(1200); r.continue(); });
  await p.goto(`${B}/warehouses/${first.id}`); await p.waitForTimeout(900);
  const hx = await p.locator("main h1").boundingBox();
  ok((await p.getByRole("button", { name: "Open AI warehouse assistant" }).getAttribute("class")).includes("idle-ring"), "Ask AI button has the subtle idle animation");
  await p.getByRole("button", { name: "Open AI warehouse assistant" }).click(); await p.waitForTimeout(500);
  const hy = await p.locator("main h1").boundingBox();
  ok(hx.x === hy.x && hx.y === hy.y, "drawer opens without moving page layout");
  ok((await p.locator("[aria-label='AI warehouse assistant']").innerText()).match(/Context:\s*BLR/), "assistant knows the current warehouse");
  await p.getByPlaceholder(/Ask about BLR/).fill("inventory value"); await p.keyboard.press("Enter"); await p.waitForTimeout(500);
  ok(await p.locator("[aria-label='Assistant is typing']").count() === 1, "typing indicator shows while waiting");
  await p.waitForTimeout(1050);
  const len1 = (await p.locator("[aria-label='AI warehouse assistant'] .bg-muted p").last().innerText()).length;
  await p.waitForTimeout(1500);
  const final = await p.locator("[aria-label='AI warehouse assistant'] .bg-muted p").last().innerText();
  ok(final.includes("Bengaluru DC") && len1 <= final.length, "reply streams in and is scoped to the current warehouse: " + final.slice(0, 70));
  await p.locator("[aria-label='AI warehouse assistant'] .bg-muted").last().hover();
  await p.getByRole("button", { name: "Copy response" }).last().click(); await p.waitForTimeout(300);
  ok((await p.evaluate(() => navigator.clipboard.readText())).includes("Bengaluru DC"), "Copy puts the response on the clipboard");
  await p.screenshot({ path: OUT + "u14-assistant.png" });
  await p.getByRole("button", { name: "Chat history" }).click(); await p.waitForTimeout(300);
  ok((await p.locator("[aria-label='AI warehouse assistant']").innerText()).toLowerCase().includes("your earlier questions"), "history panel lists earlier questions");
  await p.getByRole("button", { name: "Chat history" }).click();
  await p.getByPlaceholder(/Ask about BLR/).click(); await p.keyboard.press("ArrowUp");
  ok((await p.getByPlaceholder(/Ask about BLR/).inputValue()) === "inventory value", "ArrowUp recalls the previous question");
  await p.reload(); await p.waitForTimeout(800); await p.getByRole("button", { name: "Open AI warehouse assistant" }).click(); await p.waitForTimeout(400);
  ok((await p.locator("[aria-label='AI warehouse assistant']").innerText()).includes("Bengaluru DC"), "conversation survives reload");
  await p.keyboard.press("Escape"); await p.waitForTimeout(450);
  ok(await p.locator("[aria-label='AI warehouse assistant']").count() === 0, "Escape closes the drawer");
  await p.unroute("**/assistant/chat");

  // ---------- layout shift ----------
  await p.goto(B + "/warehouses"); await p.waitForTimeout(2000);
  const cls = await p.evaluate(() => window.__cls);
  ok(cls < 0.1, `cumulative layout shift on the warehouse list = ${cls.toFixed(3)} (good < 0.1)`);

  // ---------- reduced motion ----------
  const rm = await mk({ reducedMotion: "reduce" });
  await rm.p.goto(B + "/"); await rm.p.waitForTimeout(250);
  const dur = await rm.p.locator("main > div").first().evaluate((e) => getComputedStyle(e).animationDuration);
  const kpi = await rm.p.locator("main .card p.text-2xl").first().innerText();
  ok(parseFloat(dur) < 0.001 && /^₹?\d/.test(kpi) && kpi !== "0" && kpi !== "₹0", `reduced motion: animations disabled (${dur}) and numbers show final value immediately (${kpi})`);
  await rm.ctx.close();

  // ---------- mobile + touch ----------
  const mo = await mk({ viewport: { width: 390, height: 800 }, hasTouch: true, isMobile: true });
  await mo.p.goto(B + "/warehouses"); await mo.p.waitForTimeout(1200);
  ok(await mo.p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), "mobile: no horizontal page scroll on the list");
  ok(await mo.p.locator("tbody tr").first().locator(".row-actions").evaluate((e) => getComputedStyle(e).opacity) === "1", "touch devices always show row actions");
  await mo.p.screenshot({ path: OUT + "u15-mobile-list.png" });
  await mo.p.goto(`${B}/warehouses/${first.id}`); await mo.p.waitForTimeout(1000);
  const swipe = (dx) => mo.p.evaluate((dx) => { const el = document.querySelector("div.min-h-\\[50vh\\] > div"); const tch = (x, y) => new Touch({ identifier: 1, target: el, clientX: x, clientY: y }); el.dispatchEvent(new TouchEvent("touchstart", { touches: [tch(250, 300)], changedTouches: [tch(250, 300)], bubbles: true })); el.dispatchEvent(new TouchEvent("touchend", { touches: [], changedTouches: [tch(250 + dx, 305)], bubbles: true })); }, dx);
  await swipe(-150); await mo.p.waitForTimeout(600);
  ok(/tab=items/.test(mo.p.url()), "swipe left moves to the next tab");
  await swipe(150); await mo.p.waitForTimeout(600);
  ok(!/tab=/.test(mo.p.url()), "swipe right moves back");
  await mo.p.getByRole("button", { name: "Open AI warehouse assistant" }).click(); await mo.p.waitForTimeout(500);
  const wdt = (await mo.p.locator("[aria-label='AI warehouse assistant']").boundingBox()).width;
  ok(wdt >= 389, `mobile: assistant drawer is full width (${wdt}px)`);
  await mo.p.evaluate(() => { const el = document.querySelector("[aria-label='AI warehouse assistant']"); const t = (x) => new Touch({ identifier: 2, target: el, clientX: x, clientY: 400 }); el.dispatchEvent(new TouchEvent("touchstart", { touches: [t(100)], changedTouches: [t(100)], bubbles: true })); el.dispatchEvent(new TouchEvent("touchend", { touches: [], changedTouches: [t(260)], bubbles: true })); });
  await mo.p.waitForTimeout(500);
  ok(await mo.p.locator("[aria-label='AI warehouse assistant']").count() === 0, "swipe right closes the assistant drawer");

  await cleanup();
  console.log("console/page errors:", JSON.stringify(errs.slice(0, 6)));
  console.log(fails ? `\n${fails} CHECK(S) FAILED` : "\nALL CHECKS PASSED");
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
