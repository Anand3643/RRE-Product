/**
 * RRE Tally — opens the original inventory application. Mounted at /api/inventory-app.
 *   GET  /status   is the inventory application installed, and is it running?
 *   POST /launch   starts it if needed and returns the address to open. RRE's administrator is signed in automatically (a one-minute,
 *                  single-use signed link); every other role is shown the original inventory login. Portal customers are refused.
 */
const express = require('express');
const router = express.Router();
const host = require('../../core/inventoryHost');
const { identify, logActivity } = require('../../core/auth');
const { getRolePermissions } = require('../../core/db');

const fail = (res, status, message) => res.status(status).json({ success: false, error: message });

router.get('/status', (req, res) => res.json({ success: true, data: host.status() }));

router.post('/launch', async (req, res) => {
  try {
    const user = identify(req); // optional: in the login-free build there is no session and the person at the keyboard is the administrator
    if (user && user.role === 'Customer') return fail(res, 403, 'Customer accounts use the customer portal.');
    const admin = !user || !!getRolePermissions(user.role).canManageUsers;
    const out = await host.launch({ admin, path: req.body && req.body.path });
    if (user) logActivity({ user, ip: req.ip, action: 'INVENTORY_APP_OPEN', entity: 'inventory-app', details: { admin } });
    res.json({ success: true, data: { url: out.url, signed_in: admin } });
  } catch (err) { fail(res, 503, err.message); }
});

module.exports = router;
