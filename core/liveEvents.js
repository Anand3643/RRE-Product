/**
 * RRE Tally — live updates between devices.
 *
 * Every signed-in screen keeps one stream open: GET /api/events (Server-Sent Events over an ordinary authorised fetch, so the
 * normal sign-in, role and company checks apply). After any change is SAVED (a write request that the server answered with
 * success), every other open screen of the SAME company is told which area changed, and reloads that data from the server.
 *   - only the area name and time are sent (no record contents, no names): the screen fetches the data itself, through the normal
 *     permission checks, so an event can never show anyone something they may not see;
 *   - the screen that made the change is not told (it already shows it): each browser tab sends its own X-RRE-Client id;
 *   - a heartbeat every 25 s keeps proxies / hosting platforms from closing an idle stream; the browser reconnects by itself and
 *     re-reads its screen after a reconnect, so nothing is missed while a device was offline.
 * Customer-portal-only accounts never reach this route (routeGuard keeps them to /api/portal).
 * Why not Supabase Realtime: the browser has no direct access to the database at all (by design, see docs/CLOUD_DATABASE.md);
 * all data goes through this server, so this server is also what announces changes.
 */
const db = require('./db');

const clients = new Set(); // { res, company, client }
const HEARTBEAT_MS = 25000;

// writes that do not change business data (or are not data at all)
const QUIET = /^\/api\/(auth\/(login|logout|session|me|change-password|verify|resend|reset|forgot|google|setup|register|mode)|events|ai\/|voice\/|search|platform\/notifications|portal\/session|telemetry)|\/(preview|detect|validate|compute|check|extract|parse|estimate|suggest)(\/|$)/;

function areaOf(path) {
  const p = path.replace(/^\/api\//, '').split('/');
  return p[0] === 'inv' && p[1] ? 'inv/' + p[1] : p[0];
}

function stream(req, res) {
  res.set({ 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders && res.flushHeaders();
  const me = { res, company: String(db.getCompanyNumber()), client: String(req.get('X-RRE-Client') || '') };
  clients.add(me);
  res.write(`event: hello\ndata: ${JSON.stringify({ company: me.company, at: new Date().toISOString() })}\n\n`);
  const beat = setInterval(() => { try { res.write(': ping\n\n'); } catch (e) { /* closed */ } }, HEARTBEAT_MS);
  const bye = () => { clearInterval(beat); clients.delete(me); };
  req.on('close', bye); res.on('error', bye);
}

function publish(company, area, fromClient) {
  const msg = `event: changed\ndata: ${JSON.stringify({ area, at: new Date().toISOString() })}\n\n`;
  for (const c of clients) {
    if (c.company !== String(company) || (fromClient && c.client === fromClient)) continue;
    try { c.res.write(msg); } catch (e) { clients.delete(c); }
  }
}

/** After a successful write, tell the company's other screens. */
function announce(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS' || !req.path.startsWith('/api/') || QUIET.test(req.path)) return next();
  const company = String(db.getCompanyNumber()); // the company THIS request works in (a customer's own books, or the active company)
  const from = String(req.get('X-RRE-Client') || '');
  const area = areaOf(req.path);
  res.on('finish', () => { if (res.statusCode < 400) publish(company, area, from); });
  next();
}

module.exports = { stream, announce, publish, clientCount: () => clients.size, areaOf };
