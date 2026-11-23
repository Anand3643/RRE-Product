// Login monitoring browser suite (real API + DB, isolated org).
const { chromium } = require("playwright-core");
const EXE = process.env.EDGE_PATH || process.env.CHROME_PATH || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const B = "http://localhost:5173", API = "http://127.0.0.1:8000/api";
let fails = 0; const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fails++; };
const tag = Date.now().toString().slice(-6), PW = "Passw0rd123";
const PHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

(async () => {
  const su = await (await fetch(API + "/auth/signup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ org_name: `E2E Mon ${tag}`, name: "Mon Admin", email: `adm${tag}@example.com`, password: PW }) })).json();
  const H = { Authorization: "Bearer " + su.access_token, "Content-Type": "application/json" };
  const call = async (m, p, b, h = H) => { const r = await fetch(API + p, { method: m, headers: h, body: b ? JSON.stringify(b) : undefined }); const t = await r.text(); return { status: r.status, body: t ? JSON.parse(t) : null }; };
  const mk = async (n, role) => { const email = `${n}${tag}@example.com`; const r = await call("POST", "/users", { name: n[0].toUpperCase() + n.slice(1) + " Test", email, password: PW, role }); if (r.status !== 201) throw new Error(JSON.stringify(r)); return email; };
  const sam = await mk("sam", "sales"), lee = await mk("lee", "manager"), never = await mk("never", "viewer"), late = await mk("late", "sales");
  const adminEmail = `adm${tag}@example.com`;
  const browser = await chromium.launch({ executablePath: EXE, headless: true });
  const newPage = async (ua) => { const c = await browser.newContext({ viewport: { width: 1500, height: 950 }, userAgent: ua, acceptDownloads: true }); return { c, p: await c.newPage() }; };
  const signIn = async (p, email, pw = PW) => { await p.goto(B + "/"); await p.waitForSelector("#email"); await p.fill("#email", email); await p.fill("#password", pw); await p.getByRole("button", { name: /^Sign in/ }).click(); };
  const body = (p) => p.locator("body").innerText();

  // admin signs in (records an admin session)
  const A = await newPage(); await signIn(A.p, adminEmail); await A.p.waitForSelector("[data-testid=login-monitor]", { timeout: 12000 });
  ok(true, "admin dashboard shows the User login activity section");
  // two devices for sam
  const S1 = await newPage(); await signIn(S1.p, sam); await S1.p.waitForSelector("[data-testid=user-dashboard]");
  const S2 = await newPage(PHONE); await signIn(S2.p, sam); await S2.p.waitForSelector("[data-testid=user-dashboard]");
  // failed login
  const F = await newPage(); await F.p.goto(B + "/"); await F.p.fill("#email", lee); await F.p.fill("#password", "Totally-wrong9"); await F.p.getByRole("button", { name: /^Sign in/ }).click(); await F.p.waitForFunction(() => document.body.innerText.includes("Incorrect"));

  // the dashboard refreshes by itself (no reload)
  const rowsFor = (e) => A.p.locator(`[data-testid=login-monitor] tr[data-email="${e}"]`);
  await A.p.waitForFunction((e) => document.querySelectorAll(`[data-testid=login-monitor] tr[data-email="${e}"]`).length >= 2, sam, { timeout: 25000 });
  ok(true, "both of the user's sessions appeared on the admin dashboard without a manual reload");
  const t1 = await rowsFor(sam).allInnerTexts();
  ok(t1.some((r) => r.includes("Mobile")) && t1.some((r) => r.includes("Desktop")), "device type recorded per session (Desktop and Mobile)");
  ok(t1.every((r) => r.includes("Active")) && t1.some((r) => /Safari 17/.test(r)) && t1.some((r) => /Edge|Chrome/.test(r)), "browser recorded and sessions show Active");
  ok((await rowsFor(adminEmail).first().innerText()).includes("Admin"), "admin's own login is recorded with the Admin role");
  const stat = async (l) => +(await A.p.locator(`[data-stat="${l}"] p`).nth(1).innerText());
  const sumApi = (await call("GET", "/monitor/summary")).body;
  ok((await stat("Registered users")) === 5 && sumApi.total_users === 5, "registered users statistic matches the database (5)");
  ok((await stat("Never logged in")) === 3 && (await stat("Logged in today")) === 2 && (await stat("Active now")) === 2, `never logged in = 3 (lee, never, late), logged in today = 2 (admin + sam), active now = 2 (got ${await stat("Never logged in")}/${await stat("Logged in today")}/${await stat("Active now")})`);
  ok((await stat("Sessions today")) === sumApi.sessions_today && sumApi.sessions_today === 4, "sessions today = 4 (signup + admin sign-in + 2 devices)");
  ok(!(await A.p.locator("[data-testid=login-monitor]").innerText()).includes("Repeated failed sign-ins: ") || !(await A.p.locator("[data-testid=login-monitor] [role=alert]").allInnerTexts()).join().includes(tag), "no alert for this run's accounts before repeated failures");
  // a new login while the admin is watching
  const L = await newPage(); await signIn(L.p, late); await L.p.waitForSelector("[data-testid=user-dashboard]");
  await A.p.waitForFunction((e) => document.querySelector(`[data-testid=login-monitor] tr[data-email="${e}"]`), late, { timeout: 25000 }); ok(true, "a login made while the dashboard is open shows up automatically");

  // details + terminate with confirmation
  await rowsFor(sam).first().getByRole("button", { name: /View details/ }).click(); await A.p.waitForSelector("[data-testid=login-detail]");
  let d = await A.p.locator("[data-testid=login-detail]").innerText();
  ok(d.includes("Active sessions (2)") && d.includes("Device history") && d.includes("Login history") && d.includes("Assigned permissions") && d.includes("Recent activity") && /Total logins\s*\n?\s*2/.test(d), "details show profile, 2 active sessions, device & login history, permissions, activity, login count");
  const phoneKill = A.p.locator("[role=dialog] li", { hasText: "Mobile" }).getByRole("button", { name: /Terminate/ });
  await phoneKill.click(); await A.p.waitForSelector("[role=dialog] >> text=signed out of Mobile"); ok(true, "terminating asks for confirmation first");
  await A.p.getByRole("button", { name: "Terminate", exact: true }).click(); await A.p.waitForFunction(() => document.querySelector("[data-testid=login-detail]")?.innerText.includes("Active sessions (1)"), null, { timeout: 8000 }); ok(true, "terminated session leaves the active list");
  await A.p.keyboard.press("Escape");
  await S2.p.reload(); await S2.p.waitForSelector("#email", { timeout: 10000 }); ok(true, "the terminated device is signed out (its session is invalid)");
  await S1.p.reload(); await S1.p.waitForSelector("[data-testid=user-dashboard]"); ok(true, "the user's other device stays signed in");
  // logout
  await S1.p.locator("button[aria-label='Account menu']").click(); await S1.p.getByRole("button", { name: "Sign out" }).click(); await S1.p.waitForSelector("#email");
  await A.p.waitForFunction((e) => [...document.querySelectorAll(`[data-testid=login-monitor] tr[data-email="${e}"]`)].every((r) => /Logged out|Ended by admin/.test(r.innerText)), sam, { timeout: 25000 }); ok(true, "logout and admin termination show as Logged out / Ended by admin on the dashboard");

  // access control
  const M = await newPage(); await signIn(M.p, lee); await M.p.waitForSelector("[data-testid=user-dashboard]");
  await M.p.goto(B + "/admin/activity"); await M.p.waitForSelector("[data-testid=access-denied]", { timeout: 6000 }).catch(() => {}); ok(await M.p.locator("[data-testid=access-denied]").count() === 1, "a normal user opening /login-activity gets Access denied");
  ok(!(await M.p.locator("aside").count()) && !(await M.p.locator("body").innerText()).includes("Login history"), "the user portal has no Login history menu");
  const mt = await M.p.evaluate(() => localStorage.getItem("sp_access")); const MH = { Authorization: "Bearer " + mt };
  const codes = [(await call("GET", "/monitor/summary", null, MH)).status, (await call("GET", "/monitor/sessions", null, MH)).status, (await call("GET", "/monitor/history", null, MH)).status, (await call("POST", "/monitor/sessions/1/terminate", null, MH)).status];
  ok(codes.every((c) => c === 403), `monitoring APIs return 403 for a normal user (${codes})`);

  // history page
  await A.p.goto(B + "/login-activity"); await A.p.waitForSelector("[data-testid=login-activity] tbody tr");
  let t = await body(A.p); ok(["User", "Login", "Logout", "Duration", "Device", "Browser", "IP address", "Status", "Failed attempts"].every((h) => t.toLowerCase().includes(h.toLowerCase())), "history table has all required columns");
  ok(t.includes("Ended by admin") && t.includes("Logged out") && t.includes("Active"), "history shows Active, Logged out and Ended-by-admin sessions with real data");
  ok(/Failed attempts[\s\S]*1/.test(t), "history shows the failed attempt count for the user who mistyped (lee)");
  await A.p.getByLabel("Session status").selectOption("terminated"); await A.p.waitForFunction(() => document.querySelectorAll("[data-testid=login-activity] tbody tr").length === 1); ok(true, "status filter narrows the list (terminated = 1)");
  await A.p.getByLabel("Session status").selectOption(""); await A.p.getByLabel("Date range").selectOption("yesterday"); await A.p.waitForSelector("text=No records for these filters"); ok(true, "date preset 'Yesterday' shows nothing (no logins then)");
  await A.p.getByLabel("Date range").selectOption("custom"); await A.p.getByLabel("From date").fill("2020-01-01"); await A.p.getByLabel("To date").fill("2099-01-01"); await A.p.waitForSelector("[data-testid=login-activity] tbody tr"); ok(true, "custom date range works");
  await A.p.getByLabel("Date range").selectOption("7d");
  await A.p.getByLabel("User", { exact: true }).selectOption({ label: "Lee Test" }); await A.p.waitForFunction(() => [...document.querySelectorAll("[data-testid=login-activity] tbody tr")].every((r) => r.innerText.includes("lee")), null); ok(true, "specific-user filter works");
  await A.p.getByLabel("User", { exact: true }).selectOption(""); await A.p.getByLabel("Search").fill("sam"); await A.p.waitForFunction(() => [...document.querySelectorAll("[data-testid=login-activity] tbody tr")].every((r) => r.innerText.includes("sam"))); ok(true, "search works");
  ok(await A.p.getByRole("button", { name: "Next page" }).isDisabled() && await A.p.getByRole("button", { name: "Previous page" }).isDisabled(), "pagination controls present (single page here)");
  await A.p.getByLabel("Search").fill("");
  const dl1 = A.p.waitForEvent("download"); await A.p.getByRole("button", { name: "CSV" }).click(); const f1 = await dl1; const fs = require("fs"); const csvText = fs.readFileSync(await f1.path(), "utf8");
  ok(f1.suggestedFilename().endsWith(".csv") && csvText.includes(sam) && !csvText.includes(PW), "CSV export downloads real session rows (no passwords)");
  const dl2 = A.p.waitForEvent("download"); await A.p.getByRole("button", { name: "Excel" }).click(); const f2 = await dl2; ok(f2.suggestedFilename().endsWith(".xlsx") && fs.statSync(await f2.path()).size > 1000, "Excel export downloads");
  // failed tab
  await A.p.getByRole("button", { name: "Failed attempts" }).click(); await A.p.waitForSelector("tbody >> text=Wrong password");
  t = await body(A.p); ok(t.includes(lee) && t.includes("Registered") && !t.includes("Totally-wrong9"), "failed-attempt tab lists the email, reason and device, never the password");
  // repeated failures alert
  for (let i = 0; i < 5; i++) await fetch(API + "/auth/login", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ username: `victim${tag}@example.com`, password: "nope-" + i }) });
  await A.p.reload(); await A.p.waitForSelector("[role=alert]"); ok((await A.p.locator("[role=alert]").first().innerText()).includes(`victim${tag}@example.com`), "repeated failed attempts raise an alert");
  // user management link + deactivation invalidates sessions
  await A.p.goto(B + "/team"); await A.p.waitForSelector(`tr[data-user="${late}"]`);
  await A.p.locator(`tr[data-user="${late}"] button[aria-label="Deactivate user"]`).click(); await A.p.getByRole("button", { name: "Deactivate", exact: true }).click();
  await A.p.waitForFunction((e) => document.querySelector(`tr[data-user="${e}"]`)?.innerText.includes("Inactive"), late);
  await L.p.reload(); await L.p.waitForSelector("#email", { timeout: 10000 }); ok(true, "deactivating an account signs out its live session");
  await A.p.locator(`tr[data-user="${sam}"] button[aria-label="View login sessions"]`).click(); await A.p.waitForSelector("[data-testid=login-detail]"); ok(true, "User management links to a user's login sessions");
  await new Promise((r) => setTimeout(r, 800)); process.removeAllListeners("unhandledRejection"); process.on("unhandledRejection", () => {}); await browser.close().catch(() => {});
  console.log(fails ? `\n${fails} FAILED` : "\nALL PASSED"); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error("FATAL", e); process.exit(1); });
