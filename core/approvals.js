/**
 * RRE Tally — approval workflows for purchases, sales discounts and expenses.
 *
 * A rule says "a voucher of this kind above this threshold needs approval". When someone who is subject to a rule posts such
 * a voucher, it is HELD (nothing is posted) as an approval request. An approver — a different person, with edit permission —
 * approves it; the held voucher is then posted through the ordinary voucher route exactly as submitted, or rejects it.
 *
 * Safety: nobody can approve their own request; an approved voucher is replayed with a signed one-time pass that is only
 * valid for that stored request; CSV import and recurring vouchers obey the same rules.
 */
const crypto = require('crypto');
const http = require('http');
const { run, get, all, getRolePermissions } = require('./db');
const security = require('./security');
const { logActivity } = require('./auth');

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const bad = (m, s = 400, extra) => { const e = new Error(m); e.status = s; if (extra) Object.assign(e, extra); return e; };
const ROLES = ['Owner', 'Accountant', 'Data Entry', 'Auditor', 'Viewer', 'Guest'];
const KINDS = {
  purchase_amount: { label: 'Purchase above an amount', needsType: 'Purchase' },
  sales_discount: { label: 'Sales discount above a percentage', needsType: 'Sales' },
  expense_amount: { label: 'Expense payment above an amount', needsType: 'Payment' }
};
const hashOf = (obj) => crypto.createHash('sha256').update(JSON.stringify(obj)).digest('hex');
const money = (n) => '₹' + Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ---------------------------------------------------------------- rules
async function listRules() {
  return all('SELECT * FROM approval_rules ORDER BY is_active DESC, id');
}

async function saveRule(id, b, user) {
  const name = String(b.name || '').trim();
  if (name.length < 3 || name.length > 80) throw bad('Rule name must be 3–80 characters.');
  if (!KINDS[b.kind]) throw bad(`kind must be one of: ${Object.keys(KINDS).join(', ')}.`);
  const th = Number(b.threshold);
  if (b.threshold === null || b.threshold === undefined || b.threshold === '' || !Number.isFinite(th) || th <= 0) throw bad('threshold must be a positive number.');
  if (b.kind === 'sales_discount' && th >= 100) throw bad('A discount threshold must be below 100 (percent).');
  if (th > 1e11) throw bad('threshold is too large.');
  let exempt = b.exempt_roles === undefined ? ['Owner', 'Accountant'] : b.exempt_roles;
  if (typeof exempt === 'string') exempt = exempt.split(',').map((s) => s.trim()).filter(Boolean);
  if (!Array.isArray(exempt) || exempt.some((r) => !ROLES.includes(r))) throw bad(`exempt_roles must be a list of: ${ROLES.join(', ')}.`);
  try {
    if (id) {
      const r = await run('UPDATE approval_rules SET name=?, kind=?, threshold=?, exempt_roles=? WHERE id=?', [name, b.kind, r2(th), exempt.join(','), id]);
      if (!r.changes) throw bad('Rule not found.', 404);
    } else {
      const r = await run('INSERT INTO approval_rules (name, kind, threshold, exempt_roles, created_by) VALUES (?, ?, ?, ?, ?)', [name, b.kind, r2(th), exempt.join(','), user?.username || 'unknown']);
      id = r.lastID;
    }
  } catch (e) {
    if (/UNIQUE/.test(e.message)) throw bad('A rule with that name already exists.', 409);
    throw e;
  }
  await logActivity({ user, action: 'APPROVAL_RULE_SAVE', entity: 'approval_rule', entityId: id, details: { name, kind: b.kind, threshold: r2(th), exempt } });
  return get('SELECT * FROM approval_rules WHERE id = ?', [id]);
}

async function setRuleActive(id, active, user) {
  const r = await run('UPDATE approval_rules SET is_active = ? WHERE id = ?', [active ? 1 : 0, id]);
  if (!r.changes) throw bad('Rule not found.', 404);
  await logActivity({ user, action: active ? 'APPROVAL_RULE_ENABLE' : 'APPROVAL_RULE_DISABLE', entity: 'approval_rule', entityId: id });
}

/** Which active rules does this voucher trigger for this user? ([] = posts normally). */
async function evaluate(v, user) {
  const rules = (await all('SELECT * FROM approval_rules WHERE is_active = 1')).filter((r) => !String(r.exempt_roles || '').split(',').includes(user && user.role));
  if (!rules.length || !v) return [];
  const entries = Array.isArray(v.entries) ? v.entries : [];
  const out = [];
  for (const r of rules) {
    const k = KINDS[r.kind];
    if (!k || v.voucher_type !== k.needsType) continue;
    if (r.kind === 'purchase_amount') {
      const total = r2(entries.reduce((s, e) => s + (Number(e.debit_amount) || 0), 0));
      if (total > r.threshold) out.push({ rule_id: r.id, rule_name: r.name, kind: r.kind, reason: `Purchase total ${money(total)} is above ${money(r.threshold)}`, value: total });
    } else if (r.kind === 'sales_discount') {
      const worst = Math.max(0, ...(Array.isArray(v.inventory) ? v.inventory : []).map((i) => Number(i.discount_pct) || 0));
      if (worst > r.threshold) out.push({ rule_id: r.id, rule_name: r.name, kind: r.kind, reason: `Discount of ${worst}% is above ${r.threshold}%`, value: worst });
    } else if (r.kind === 'expense_amount') {
      const ids = [...new Set(entries.map((e) => parseInt(e.ledger_id, 10)).filter(Boolean))];
      if (!ids.length) continue;
      const exp = new Set((await all(`SELECT l.id FROM ledgers l JOIN account_groups g ON g.id = l.group_id WHERE g.name IN ('Direct Expenses', 'Indirect Expenses') AND l.id IN (${ids.map(() => '?').join(',')})`, ids)).map((x) => x.id));
      const total = r2(entries.filter((e) => exp.has(parseInt(e.ledger_id, 10))).reduce((s, e) => s + (Number(e.debit_amount) || 0), 0));
      if (total > r.threshold) out.push({ rule_id: r.id, rule_name: r.name, kind: r.kind, reason: `Expense payment ${money(total)} is above ${money(r.threshold)}`, value: total });
    }
  }
  return out;
}

// ---------------------------------------------------------------- requests
async function createRequest(body, user, matches) {
  const total = r2((body.entries || []).reduce((s, e) => s + (Number(e.debit_amount) || 0), 0));
  let party = null;
  if (body.party_ledger_id) party = (await get('SELECT name FROM ledgers WHERE id = ?', [parseInt(body.party_ledger_id, 10)]))?.name || null;
  const summary = { voucher_no: body.voucher_no || null, date: body.date || null, party, total, narration: String(body.narration || '').slice(0, 120), reasons: matches.map((m) => m.reason) };
  const r = await run(`INSERT INTO approval_requests (voucher_type, summary, payload, payload_hash, rule_ids, requested_by, requested_by_id, requested_role) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [body.voucher_type, JSON.stringify(summary), JSON.stringify(body), hashOf(body), matches.map((m) => m.rule_id).join(','), user.username, user.userId ?? null, user.role]);
  await logActivity({ user, action: 'APPROVAL_REQUEST', entity: 'approval_request', entityId: r.lastID, details: { type: body.voucher_type, total, reasons: summary.reasons } });
  return { id: r.lastID, summary };
}

/** Middleware: holds a voucher that triggers an approval rule. A valid signed pass (used when an approved request is replayed) bypasses it. */
async function gate(req, res, next) {
  try {
    if (req.method !== 'POST' || req.originalUrl.split('?')[0] !== '/api/vouchers' || !req.user || !req.body) return next();
    const pass = String(req.headers['x-rre-approval'] || '');
    if (pass) {
      const [idStr, sig] = pass.split('.');
      const id = parseInt(idStr, 10);
      if (id && sig && security.verifyApprovalPass(id, sig)) {
        const row = await get(`SELECT status, payload_hash FROM approval_requests WHERE id = ?`, [id]);
        if (row && row.status === 'approving' && row.payload_hash === hashOf(req.body)) return next();
      }
      // an invalid pass is ignored: the voucher is evaluated like any other
    }
    const matches = await evaluate(req.body, req.user);
    if (!matches.length) return next();
    const r = await createRequest(req.body, req.user, matches);
    return res.status(202).json({
      success: false, pending_approval: true, request_id: r.id,
      error: `Not posted yet — sent for approval (request #${r.id}). ${matches.map((m) => m.reason).join('; ')}. An Owner or Accountant must approve it before it is recorded.`
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Could not check approval rules: ' + err.message });
  }
}

const parseRow = (r) => ({ ...r, summary: JSON.parse(r.summary || '{}'), payload: undefined });

async function listRequests({ status = 'pending', mine = null } = {}) {
  const where = [], p = [];
  if (status !== 'all') { where.push('status = ?'); p.push(status); }
  if (mine) { where.push('requested_by = ?'); p.push(mine); }
  const rows = await all(`SELECT id, voucher_type, summary, status, requested_by, requested_role, requested_at, decided_by, decided_at, decision_note, voucher_id, error, rule_ids
                          FROM approval_requests ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT 200`, p);
  return rows.map(parseRow);
}

async function getRequest(id) {
  const r = await get('SELECT * FROM approval_requests WHERE id = ?', [id]);
  if (!r) throw bad('Request not found.', 404);
  return r;
}

function replay(port, token, id, payload) {
  return new Promise((resolve) => {
    const data = JSON.stringify(payload);
    const req = http.request({ host: '127.0.0.1', port, path: '/api/vouchers', method: 'POST', timeout: 60000,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), Authorization: 'Bearer ' + token, 'X-RRE-Approval': `${id}.${security.signApprovalPass(id)}` } }, (res) => {
      let b = ''; res.on('data', (c) => (b += c));
      res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (e) { /* not json */ } resolve({ status: res.statusCode, json: j }); });
    });
    req.on('error', (e) => resolve({ status: 0, json: { success: false, error: e.message } }));
    req.on('timeout', () => { req.destroy(); });
    req.write(data); req.end();
  });
}

async function approve(id, user, port, note) {
  const r0 = await getRequest(id);
  if (r0.requested_by.toLowerCase() === String(user.username).toLowerCase() || (r0.requested_by_id != null && r0.requested_by_id === user.userId)) {
    throw bad('You cannot approve your own request. Another approver must do it.', 403);
  }
  // claim it so two approvers cannot both post it
  const claim = await run(`UPDATE approval_requests SET status = 'approving' WHERE id = ? AND status = 'pending'`, [id]);
  if (!claim.changes) throw bad(`This request is already ${(await getRequest(id)).status}.`, 409);
  const payload = JSON.parse(r0.payload);
  // post it AS the requester (so tags, defaults and the audit trail show who entered it), for one minute only
  const token = security.createSessionToken({ id: r0.requested_by_id, username: r0.requested_by, role: r0.requested_role }, 1 / 60);
  const res = await replay(port, token, id, payload);
  if (res.json && res.json.success) {
    await run(`UPDATE approval_requests SET status = 'approved', decided_by = ?, decided_at = CURRENT_TIMESTAMP, decision_note = ?, voucher_id = ?, error = NULL WHERE id = ?`, [user.username, String(note || '').slice(0, 200) || null, res.json.id || null, id]);
    await logActivity({ user, action: 'APPROVAL_APPROVE', entity: 'approval_request', entityId: id, details: { voucher_no: res.json.voucher_no, voucher_id: res.json.id, requested_by: r0.requested_by } });
    return { request_id: id, voucher_id: res.json.id, voucher_no: res.json.voucher_no, total_amount: res.json.total_amount };
  }
  const why = (res.json && res.json.error) || `The voucher route answered ${res.status}`;
  await run(`UPDATE approval_requests SET status = 'pending', error = ? WHERE id = ?`, [String(why).slice(0, 300), id]); // stays open so it can be fixed or rejected
  throw bad(`Approved, but the voucher could not be posted: ${why}. The request is still pending; reject it or ask the requester to correct and resubmit.`, 409);
}

async function decideSimple(id, user, status, note, action) {
  const r = await run(`UPDATE approval_requests SET status = ?, decided_by = ?, decided_at = CURRENT_TIMESTAMP, decision_note = ? WHERE id = ? AND status = 'pending'`, [status, user.username, String(note || '').slice(0, 200) || null, id]);
  if (!r.changes) { const cur = await get('SELECT status FROM approval_requests WHERE id = ?', [id]); throw cur ? bad(`This request is already ${cur.status}.`, 409) : bad('Request not found.', 404); }
  await logActivity({ user, action, entity: 'approval_request', entityId: id, details: { note: note || null } });
}

async function reject(id, user, note) {
  const r0 = await getRequest(id);
  if (r0.requested_by.toLowerCase() === String(user.username).toLowerCase()) throw bad('Use Cancel to withdraw your own request.', 403);
  if (!String(note || '').trim()) throw bad('Please give a reason for rejecting.');
  await decideSimple(id, user, 'rejected', note, 'APPROVAL_REJECT');
}

async function cancel(id, user) {
  const r0 = await getRequest(id);
  if (r0.requested_by.toLowerCase() !== String(user.username).toLowerCase()) throw bad('Only the person who made the request can cancel it.', 403);
  await decideSimple(id, user, 'cancelled', 'Withdrawn by requester', 'APPROVAL_CANCEL');
}

async function pendingCount() { return (await get(`SELECT COUNT(*) c, MIN(requested_at) d FROM approval_requests WHERE status = 'pending'`)); }

module.exports = { listRules, saveRule, setRuleActive, evaluate, gate, listRequests, getRequest, approve, reject, cancel, pendingCount, KINDS, ROLES };
