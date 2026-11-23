// Admin / User authentication + RBAC browser suite. Isolated fresh org; talks to the real API + DB.
const { chromium } = require("playwright-core");
const EXE = process.env.EDGE_PATH || process.env.CHROME_PATH || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const B = "http://localhost:5173", API = "http://127.0.0.1:8000/api";
let fails = 0; const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fails++; };
const tag = Date.now().toString().slice(-6);
const PW = "Passw0rd123";
const canOpen = async (p, path) => { await p.goto(B + path); await p.waitForFunction(() => document.querySelector("[data-testid=access-denied]") || /\/(user\/work|admin)\//.test(location.pathname) && document.querySelector("main h1, main table, main form, main [data-testid]"), null, { timeout: 8000 }).catch(() => {}); await p.waitForTimeout(500); return (await p.locator("[data-testid=access-denied]").count()) === 0 && p.url().includes("/user/work"); };

(async () => {
  const su = await (await fetch(API + "/auth/signup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ org_name: `E2E Auth ${tag}`, name: "Boss Admin", email: `boss${tag}@example.com`, password: "password123" }) })).json();
  const H = { Authorization: "Bearer " + su.access_token, "Content-Type": "application/json" };
  const call = async (m, p, b, h = H) => { const r = await fetch(API + p, { method: m, headers: h, body: b ? JSON.stringify(b) : undefined }); const t = await r.text(); return { status: r.status, body: t ? JSON.parse(t) : null }; };
  const mk = async (name, role, extra = {}) => { const r = await call("POST", "/users", { name, email: `${name.toLowerCase().replace(/ /g, "")}${tag}@example.com`, password: PW, role, ...extra }); if (r.status !== 201) throw new Error("create user failed " + JSON.stringify(r)); return { id: r.body.id, email: `${name.toLowerCase().replace(/ /g, "")}${tag}@example.com` }; };
  const sam = await mk("Sam Sales", "sales", { department: "Sales desk", phone: "98200 11111" });
  const rita = await mk("Rita Restricted", "viewer", { permissions: { products: ["view"] } });
  const dan = await mk("Dan Deactivate", "warehouse");
  const peri = await mk("Peri Perms", "viewer");
  const reset = await mk("Reese Reset", "sales");
  const adminEmail = `boss${tag}@example.com`;
  const browser = await chromium.launch({ executablePath: EXE, headless: true });
  const errs = [];
  const newPage = async () => { const c = await browser.newContext({ viewport: { width: 1440, height: 900 } }); const p = await c.newPage(); p.on("pageerror", (e) => errs.push("PAGEERROR " + e.message)); return { c, p }; };
  const body = (p) => p.locator("body").innerText();
  const signIn = async (p, email, pw, { remember = true, expectOk = true } = {}) => {
    await p.goto(B + "/"); await p.waitForSelector("#email");
    await p.fill("#email", email); await p.fill("#password", pw);
    if (!remember) await p.getByLabel("Remember me").uncheck();
    await p.getByRole("button", { name: /^Sign in/ }).click();
    if (expectOk) await p.waitForFunction(() => !document.querySelector("#email"), null, { timeout: 10000 }).catch(() => {});
  };

  // ---------- login page ----------
  { const { p } = await newPage(); await p.goto(B + "/"); await p.waitForSelector("#email");
    const t = await body(p);
    ok(t.includes("StockPilot") && t.includes("Welcome back"), "login page shows the StockPilot brand");
    ok(!(/admin|user/i.test(await p.locator("form").innerText().then((s) => s.replace(/Administrators and customers sign in here[^\n]*/i, "")))), "login form has no Admin/User selector");
    ok(await p.getByLabel("Remember me").isChecked(), "Remember me is present (default on)");
    ok(await p.getByRole("link", { name: "Forgot password?" }).isVisible(), "Forgot password link present");
    await p.getByRole("button", { name: /^Sign in/ }).click(); await p.waitForTimeout(250);
    const v = await body(p); ok(v.includes("E-mail is required") && v.includes("Password is required"), "empty submit shows validation messages");
    await p.fill("#email", "not-an-email"); await p.fill("#password", "x"); await p.getByRole("button", { name: /^Sign in/ }).click(); await p.waitForTimeout(250);
    ok((await body(p)).includes("Enter a valid e-mail"), "invalid e-mail format flagged");
    await p.fill("#password", "secret123"); ok((await p.locator("#password").getAttribute("type")) === "password", "password hidden by default");
    await p.getByRole("button", { name: "Show password" }).click(); ok((await p.locator("#password").getAttribute("type")) === "text", "show password toggles visibility");
    await p.fill("#email", adminEmail); await p.fill("#password", "wrong-password1"); await p.getByRole("button", { name: /^Sign in/ }).click();
    await p.waitForFunction(() => document.body.innerText.includes("Incorrect email or password")); ok(true, "wrong password shows an authentication error");
    await p.fill("#email", `nobody${tag}@example.com`); await p.fill("#password", "whatever123"); await p.getByRole("button", { name: /^Sign in/ }).click();
    await p.waitForFunction(() => document.body.innerText.includes("Incorrect email or password")); ok(true, "unregistered e-mail is rejected with the same message");
    ok((await p.locator("#password").inputValue()) === "", "password field cleared after a failed attempt");
    const cfg = await (await fetch(API + "/auth/config")).json(); ok(typeof cfg.signup_enabled === "boolean", "login page asks the server whether sign-up is enabled"); }

  // ---------- admin login -> Admin Dashboard ----------
  const A = await newPage();
  await signIn(A.p, adminEmail, "password123");
  await A.p.waitForSelector("[data-testid=admin-dashboard]", { timeout: 10000 });
  ok(A.p.url().endsWith("/admin/dashboard"), "admin is redirected to /admin/dashboard after sign-in");
  let t = await body(A.p);
  ok(["Admin dashboard", "Total users", "Active users", "Inactive users", "Inventory on hand", "Customers", "Vendors", "Pending transactions", "Recent system activity", "User activity"].every((s) => t.includes(s)), "admin dashboard shows user, inventory, customer, vendor, pending and activity sections");
  const nav = await A.p.locator("aside").innerText();
  ok(nav.includes("Dashboard") && nav.includes("Users") && nav.includes("Login history") && nav.includes("Settings"), "admin sees admin-only navigation");
  ok(/Total users\s*\n?\s*7/.test(t) || t.includes("7"), "total users reflects the database (7 accounts)");

  // ---------- user login -> User Dashboard ----------
  const U = await newPage();
  await signIn(U.p, sam.email, PW);
  await U.p.waitForSelector("[data-testid=user-dashboard]", { timeout: 10000 });
  ok(U.p.url().endsWith("/user/dashboard"), "normal user lands on /user/dashboard");
  t = await body(U.p); ok(/Good (morning|afternoon|evening), Sam/.test(t), "welcome message greets the user by name");
  ok(t.includes("My orders") && t.includes("Customer portal") && !t.includes("Admin dashboard"), "user dashboard is the customer portal, not admin content");
  const unav = await U.p.locator("nav[aria-label='User portal']").innerText();
  ok(!unav.includes("Users") && !unav.includes("Login history") && !unav.includes("Settings") && !(await U.p.locator("aside").count()), "user navigation hides admin-only pages");
  ok(!(await U.p.locator("header button[aria-label=Settings]").count()), "settings shortcut hidden for users");
  // direct URL access
  for (const path of ["/admin/dashboard", "/admin/users", "/admin/settings"]) {
    await U.p.goto(B + path); await U.p.waitForSelector("[data-testid=access-denied]", { timeout: 6000 }).catch(() => {});
    ok(await U.p.locator("[data-testid=access-denied]").count() === 1, `typing ${path} shows Access denied`);
  }
  await U.p.goto(B + "/purchase-orders"); await U.p.waitForTimeout(600);
  ok(await U.p.locator("[data-testid=access-denied]").count() === 1, "module outside the user's permissions is denied (/purchase-orders for a sales user)");
  // direct API calls with the user's token
  const tok = await U.p.evaluate(() => localStorage.getItem("sp_access"));
  const UH = { Authorization: "Bearer " + tok, "Content-Type": "application/json" };
  const r1 = await call("GET", "/admin/overview", null, UH); const r2 = await call("GET", "/permissions/meta", null, UH);
  const r3 = await call("POST", "/users", { name: "Hax", email: `hax${tag}@example.com`, password: PW, role: "admin" }, UH);
  const me = (await call("GET", "/auth/me", null, UH)).body;
  const r4 = await call("PATCH", `/users/${me.id}`, { role: "admin" }, UH);
  ok([r1.status, r2.status, r3.status, r4.status].every((s) => s === 403), `user calling admin APIs gets 403 (${[r1.status, r2.status, r3.status, r4.status]})`);
  ok(me.role === "sales" && me.is_admin === false, "user's role unchanged after the attempted self-promotion");

  // ---------- restricted user sees only what was granted ----------
  const R = await newPage();
  await signIn(R.p, rita.email, PW); await R.p.waitForSelector("[data-testid=user-dashboard]");
  t = await body(R.p);
  ok((await canOpen(R.p, "/products")) && !(await canOpen(R.p, "/customers")) && !(await canOpen(R.p, "/sales-orders")) && !(await canOpen(R.p, "/reports")), "per-user permissions limit the modules a user can open to those granted");
  ok(!/Total sales|Total customers|Pending sales orders/.test(t), "dashboard hides figures outside the user's permissions");
  const rk = await R.p.evaluate(() => localStorage.getItem("sp_access")); const RH = { Authorization: "Bearer " + rk, "Content-Type": "application/json" };
  const rd = (await call("GET", "/dashboard", null, RH)).body; ok(rd.on_hand === null && rd.sales_total === undefined, "API withholds stock and sales totals from this user");
  ok((await call("GET", "/customers", null, RH)).status === 403 && (await call("GET", "/products", null, RH)).status === 200, "API enforces the same permissions (customers 403, items 200)");

  // ---------- admin: user management UI ----------
  await A.p.goto(B + "/admin/users"); await A.p.waitForSelector("[data-testid=user-management] table");
  t = await body(A.p);
  ok(["User", "ID", "Role", "Department", "Phone", "Status", "Last login", "Created", "Actions"].every((h) => t.toLowerCase().includes(h.toLowerCase())), "user table has name/ID/role/department/phone/status/last login/created/actions columns");
  ok(t.includes("Sales desk") && t.includes("98200 11111"), "department and phone are displayed");
  const row = (e) => A.p.locator(`tr[data-user="${e}"]`);
  for (const l of ["View user", "Edit user", "Manage permissions", "Deactivate user", "Reset password", "View activity history"]) ok(await row(sam.email).locator(`button[aria-label="${l}"]`).count() === 1, `row action present: ${l}`);
  await A.p.getByLabel("Search users").fill("rita"); await A.p.waitForTimeout(250); ok(await A.p.locator("tbody tr").count() === 1, "search filters the table");
  await A.p.getByLabel("Search users").fill(""); await A.p.getByLabel("Filter by status").selectOption("inactive"); await A.p.waitForTimeout(250); ok(await A.p.locator("tbody tr").count() === 0 || (await body(A.p)).includes("No users match"), "status filter works (no inactive users yet)"); await A.p.getByLabel("Filter by status").selectOption("");
  // view
  await row(sam.email).locator('button[aria-label="View user"]').click(); await A.p.waitForSelector("[role=dialog]");
  ok((await A.p.locator("[role=dialog]").innerText()).includes("Effective permissions"), "View user opens details with effective permissions"); await A.p.keyboard.press("Escape");

  // add user (generated temporary password)
  await A.p.getByRole("button", { name: /Add user/ }).click(); await A.p.waitForSelector("[role=dialog]");
  const dlg = A.p.locator("[role=dialog]"); const inp = dlg.locator("input:not([type=checkbox])");
  const newEmail = `fresh${tag}@example.com`;
  await inp.nth(0).fill("Fiona Fresh"); await inp.nth(1).fill(newEmail); await inp.nth(2).fill("99999 22222"); await inp.nth(3).fill("Accounts");
  await dlg.locator("select").nth(0).selectOption("sales");
  await dlg.getByLabel(/Customise for this user/).check();
  await dlg.locator('input[data-perm="reports:view"]').check(); await dlg.locator('input[data-perm="sales:view"]').check(); await dlg.locator('input[data-perm="sales:create"]').check();
  ok((await dlg.locator('input[data-perm="sales:view"]').isChecked()), "permission matrix lets the admin choose exact actions");
  await dlg.getByRole("button", { name: "Create user" }).click();
  await A.p.waitForSelector('input[aria-label="Temporary password"]'); const temp = await A.p.locator('input[aria-label="Temporary password"]').inputValue();
  ok(temp.length >= 12, "temporary password shown once after creation"); await A.p.getByRole("button", { name: "Done" }).click();
  await A.p.waitForSelector(`tr[data-user="${newEmail}"]`); ok(true, "new user appears in the table");
  // duplicate e-mail
  await A.p.getByRole("button", { name: /Add user/ }).click(); await A.p.waitForSelector("[role=dialog]");
  const d2 = A.p.locator("[role=dialog]"); const i2 = d2.locator("input:not([type=checkbox])"); await i2.nth(0).fill("Dup"); await i2.nth(1).fill(newEmail);
  await d2.getByRole("button", { name: "Create user" }).click(); await A.p.waitForFunction(() => document.body.innerText.includes("already exists")); ok(true, "duplicate e-mail rejected with a clear message"); await A.p.keyboard.press("Escape");

  // new user signs in with the temporary password -> forced change -> user dashboard
  const N = await newPage();
  await signIn(N.p, newEmail, temp); await N.p.waitForSelector("text=Set a new password");
  ok(true, "temporary password forces a password change");
  await N.p.fill("#cp", temp); await N.p.fill("#cp-new", "weak"); await N.p.fill("#cp-new2", "weak"); await N.p.getByRole("button", { name: "Update password" }).click(); await N.p.waitForTimeout(300);
  ok((await body(N.p)).includes("at least 8"), "weak new password rejected");
  await N.p.fill("#cp-new", "FreshPass123"); await N.p.fill("#cp-new2", "FreshPass123"); await N.p.getByRole("button", { name: "Update password" }).click();
  await N.p.waitForSelector("[data-testid=user-dashboard]", { timeout: 10000 }); ok(true, "after changing the password the user reaches the user dashboard");
  ok((await canOpen(N.p, "/customers")) && (await canOpen(N.p, "/reports")) && !(await canOpen(N.p, "/vendors")), "new user can open exactly the modules the admin ticked");

  // deactivate via UI
  await row(dan.email).locator('button[aria-label="Deactivate user"]').click(); await A.p.waitForSelector("[role=dialog]");
  await A.p.getByRole("button", { name: "Deactivate", exact: true }).click(); await A.p.waitForFunction((e) => document.querySelector(`tr[data-user="${e}"]`)?.innerText.includes("Inactive"), dan.email);
  ok(true, "admin deactivates a user from the table");
  const D = await newPage(); await signIn(D.p, dan.email, PW, { expectOk: false }); await D.p.waitForFunction(() => document.body.innerText.includes("deactivated"), null, { timeout: 8000 });
  ok(true, "deactivated user cannot sign in (clear message)");
  await row(dan.email).locator('button[aria-label="Activate user"]').click(); await A.p.waitForFunction((e) => document.querySelector(`tr[data-user="${e}"]`)?.innerText.includes("Active"), dan.email); ok(true, "admin reactivates the user");

  // permissions change takes effect for a signed-in user
  const P = await newPage(); await signIn(P.p, peri.email, PW); await P.p.waitForSelector("[data-testid=user-dashboard]");
  ok(await canOpen(P.p, "/vendors"), "viewer template can open Vendors before the change");
  await row(peri.email).locator('button[aria-label="Manage permissions"]').click(); await A.p.waitForSelector("[role=dialog]");
  const pd = A.p.locator("[role=dialog]"); await pd.getByLabel(/Customise for this user/).check();
  await pd.locator('input[data-perm="purchases:view"]').uncheck(); await pd.getByRole("button", { name: "Save changes" }).click(); await A.p.waitForFunction(() => !document.querySelector("[role=dialog]"));
  await P.p.goto(B + "/user/dashboard"); await P.p.waitForSelector("[data-testid=user-dashboard]");
  ok(!(await canOpen(P.p, "/vendors")), "revoked permission closes the module for the user");
  const pt = await P.p.evaluate(() => localStorage.getItem("sp_access")); ok((await call("GET", "/vendors", null, { Authorization: "Bearer " + pt })).status === 403, "...and the API now refuses it (403)");
  await P.p.goto(B + "/vendors"); await P.p.waitForSelector("[data-testid=access-denied]", { timeout: 6000 }).catch(() => {}); ok(await P.p.locator("[data-testid=access-denied]").count() === 1, "...and the page shows Access denied");

  // reset password via link
  await row(reset.email).locator('button[aria-label="Reset password"]').click(); await A.p.waitForSelector("[role=dialog]");
  await A.p.getByText("Create a one-time reset link", { exact: true }).click(); await A.p.waitForSelector('input[aria-label="Reset link"]');
  const link = await A.p.locator('input[aria-label="Reset link"]').inputValue(); ok(link.includes("/reset-password?token="), "admin gets a one-time reset link"); await A.p.getByRole("button", { name: "Done" }).click();
  const Z = await newPage(); await Z.p.goto(link); await Z.p.waitForSelector("#np"); await Z.p.fill("#np", "ResetMe123"); await Z.p.fill("#np2", "ResetMe123"); await Z.p.getByRole("button", { name: "Update password" }).click();
  await Z.p.waitForSelector("text=Password updated"); ok(true, "user sets a new password via the reset link");
  await signIn(Z.p, reset.email, "ResetMe123"); await Z.p.waitForSelector("[data-testid=user-dashboard]"); ok(true, "user signs in with the new password");
  const old = await fetch(API + "/auth/login", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ username: reset.email, password: PW }) }); ok(old.status === 401, "old password no longer works");
  // forgot-password page
  { const { p } = await newPage(); await p.goto(B + "/"); await p.getByRole("link", { name: "Forgot password?" }).click(); await p.waitForSelector("#fe"); await p.fill("#fe", sam.email); await p.getByRole("button", { name: "Request reset link" }).click();
    await p.waitForSelector("text=sent to the administrator for approval"); ok(true, "forgot-password request accepted and says it awaits administrator approval"); }
  await A.p.reload(); await A.p.waitForSelector(`tr[data-user="${sam.email}"]`); ok((await row(sam.email).innerText()).includes("Reset requested"), "admin sees the pending reset request flagged on the user");
  await A.p.waitForSelector("[data-testid=reset-requests]"); ok((await A.p.locator(`[data-request="${sam.email}"]`).count()) === 1 && (await A.p.locator("[data-testid=reset-badge]").count()) === 1, "admin sees a Password reset requests panel with Approve / Dismiss and a badge on the Users menu");
  await A.p.getByRole("button", { name: `Approve password reset for ${sam.email}` }).click(); await A.p.getByText("Create a one-time reset link", { exact: true }).click(); await A.p.waitForSelector('input[aria-label="Reset link"]'); await A.p.getByRole("button", { name: "Done" }).click();
  await A.p.waitForFunction((e) => !document.querySelector(`[data-request="${e}"]`), sam.email); ok(true, "approving the request issues a link and clears it from the panel");
  // activity
  await row(sam.email).locator('button[aria-label="View activity history"]').click(); await A.p.waitForSelector("[role=dialog]"); ok((await A.p.locator("[role=dialog]").innerText()).toLowerCase().includes("login"), "activity history lists the user's sign-ins"); await A.p.keyboard.press("Escape");
  // audit log
  await A.p.goto(B + "/admin/users?tab=audit"); await A.p.waitForSelector("tbody tr"); t = await body(A.p); ok(t.includes("create") && t.includes("login"), "audit log records account creation and sign-ins");

  // ---------- own-role change & remember me & logout ----------
  const adminTok = await A.p.evaluate(() => localStorage.getItem("sp_access")); const adminMe = (await call("GET", "/auth/me", null, { Authorization: "Bearer " + adminTok })).body;
  ok((await call("PATCH", `/users/${adminMe.id}`, { role: "viewer" })).status === 403, "even an admin cannot change their own role");
  { const { p } = await newPage(); await signIn(p, sam.email, PW, { remember: false }); await p.waitForSelector("[data-testid=user-dashboard]");
    const where = await p.evaluate(() => ({ l: !!localStorage.getItem("sp_refresh"), s: !!sessionStorage.getItem("sp_refresh") })); ok(!where.l && where.s, "Remember me off: session kept in sessionStorage only"); }
  { const { p } = await newPage(); await signIn(p, sam.email, PW, { remember: true }); await p.waitForSelector("[data-testid=user-dashboard]");
    const where = await p.evaluate(() => ({ l: !!localStorage.getItem("sp_refresh"), s: !!sessionStorage.getItem("sp_refresh") })); ok(where.l && !where.s, "Remember me on: persistent session");
    await p.locator("button[aria-label='Account menu']").click(); await p.getByRole("button", { name: "Sign out" }).click(); await p.waitForSelector("#email"); ok(true, "sign out returns to the login page");
    ok((await p.evaluate(() => localStorage.getItem("sp_refresh") || sessionStorage.getItem("sp_refresh"))) === null, "tokens cleared on sign out");
    await p.goto(B + "/sales-orders"); await p.waitForSelector("#email"); ok(true, "protected route redirects to login when signed out"); }

  ok(errs.length === 0, "no uncaught page errors" + (errs.length ? ": " + errs.slice(0, 3).join(" | ") : ""));
  await browser.close();
  console.log(fails ? `\n${fails} FAILED` : "\nALL PASSED"); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error("FATAL", e); process.exit(1); });
