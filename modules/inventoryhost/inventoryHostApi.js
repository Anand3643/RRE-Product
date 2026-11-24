/**
 * RRE Entries — opens the original inventory application. Mounted at /api/inventory-app.
 *   GET  /status   is the inventory application installed, and is it running?
 *   POST /launch   starts it if needed and returns the address to open. The person is signed in to Inventory automatically with a
 *                  one-minute, single-use signed link made from THEIR RRE session: there is no second login and no second account.
 *                  Administrators and employees (whose administrator allows the Inventory module) get it; customers and guests do not.
 */
const express = require('express');
const router = express.Router();
const host = require('../../core/inventoryHost');
const identity = require('../../core/identity');
const { identify, logActivity } = require('../../core/auth');
const db = require('../../core/db');

const fail = (res, status, message) => res.status(status).json({ success: false, error: message });

// When an RRE account changes (role, deactivation, password reset, sign-out) the inventory application follows at once.
async function follow(userId) {
  try {
    const u = await db.get('SELECT id, username, full_name, email, role, status FROM users WHERE id = ?', [userId]);
    if (u && u.role === 'Guest') u.email = 'guest@rre-entries.app';
    if (u && u.email && u.role !== 'Customer') await host.syncUser(u, { active: u.status === 'Active' });
  } catch (e) { /* the inventory application may not be running */ }
}
identity.onRevoke((userId) => { follow(userId); });
identity.onChange((userId) => { follow(userId); });

router.get('/status', (req, res) => res.json({ success: true, data: host.status() }));

router.post('/launch', async (req, res) => {
  try {
    const user = identify(req);
    if (!user) return fail(res, 401, 'Please sign in.');
    if (user.role === 'Customer') return fail(res, 403, 'Customer accounts use the customer portal.');
    if (Array.isArray(user.modules) && !['Owner', 'Administrator'].includes(user.role) && !user.modules.includes('inventory')) return fail(res, 403, 'Your account does not have access to Inventory. Ask your administrator.');
    const row = await db.get('SELECT id, username, full_name, email, role FROM users WHERE id = ? AND status = ?', [user.userId, 'Active']);
    if (!row) return fail(res, 401, 'This account is not active.');
    if (row.role === 'Guest') row.email = 'guest@rre-entries.app'; // read-only guest: a viewer in Inventory
    if (!row.email && !['Owner', 'Administrator'].includes(row.role)) return fail(res, 409, 'Your account has no e-mail address, which Inventory needs to recognise you. Ask your administrator to add one.');
    const out = await host.launch({ user: row, path: req.body && req.body.path, wait: !(req.body && req.body.nowait) });
    if (out.starting) return res.status(202).json({ success: true, data: { starting: true } }); // still starting: the screen asks again
    logActivity({ user, ip: req.ip, action: 'INVENTORY_APP_OPEN', entity: 'inventory-app', details: { role: row.role } });
    res.json({ success: true, data: { url: out.url, signed_in: true } });
  } catch (err) { fail(res, 503, err.message); }
});

module.exports = router;
