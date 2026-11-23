// URL layout: administrators live under /admin/*, users under /user/*.
// Existing module pages keep their internal route names (/products, /sales-orders ...); these helpers translate them
// to the public, portal-prefixed URLs (/admin/items, /admin/sales-orders ...) and back, so every old link still works.
export const ADMIN = "/admin";
export const WORK = "/user/work";   // module pages a USER was explicitly granted access to
const OUT: Record<string, string> = { products: "items", team: "users", "login-activity": "activity" };
const IN: Record<string, string> = Object.fromEntries(Object.entries(OUT).map(([k, v]) => [v, k]));

export const underBase = (path: string, base: string) => path === base || path.startsWith(base + "/");

export function ext(internal: string, base: string): string {
  if (base === ADMIN) { if (internal === "/admin") return "/admin/dashboard"; if (internal === "/") return "/admin/operations"; }
  const m = internal.match(/^\/([^/?#]*)(.*)$/); const seg = m?.[1] ?? ""; const rest = m?.[2] ?? "";
  return base + "/" + (OUT[seg] ?? seg) + rest;
}

export function toInternal(pathname: string, base: string): string {
  const rest = pathname.slice(base.length) || "/";
  const m = rest.match(/^\/([^/]*)(.*)$/); const seg = m?.[1] ?? ""; const tail = m?.[2] ?? "";
  if (base === ADMIN) { if (seg === "" || seg === "dashboard") return "/admin"; if (seg === "operations") return "/"; }
  return "/" + (IN[seg] ?? seg) + tail;
}

/** Where an old / unprefixed URL (e.g. /sales-orders/5 or /) should land inside a portal. */
export function redirectFor(pathname: string, base: string): string {
  if (pathname === "/" || pathname === "") return base === ADMIN ? "/admin/dashboard" : "/user/dashboard";
  return ext(pathname, base);
}
