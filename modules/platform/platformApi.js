/**
 * RRE Tally — Platform services (new): notification centre, global search,
 * one-click CSV export, activity log, backup verification.
 * Mounted at /api/platform. Every route requires a valid signed session token.
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sqlite3 = require('sqlite3');
const router = express.Router();

const { run, get, all } = require('../../core/db');
const { requireAuth, logActivity } = require('../../core/auth');
const { withTransaction } = require('../../core/tx');
const { getStockPositions, getOpenBills, daysBetween, getUnbalancedVouchers, round2 } = require('../../core/analytics');
const { listBackups, getBackupDir } = require('../../core/backupEngine');
const { DATASETS } = require('../../core/exports');
const scheduler = require('../../core/scheduler');
const { buildInvoiceHtml } = require('../../core/invoice');

const inr = (n) => '₹' + (Number(n) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const todayIso = () => new Date().toISOString().slice(0, 10);

// ---------------------------------------------------------------------------
// Notification centre — alerts are computed from live data and de-duplicated.
// An alert whose condition has cleared is auto-resolved (never silently deleted).
// ---------------------------------------------------------------------------
async function computeAlerts() {
  const alerts = [];
  const today = todayIso();

  // Each family of alert is capped and summarised, so a large company yields tens of alerts, not thousands.
  const CAP = { stock: 25, recv: 25, pay: 15, unbal: 20 };
  const more = (key, type, n, what, view, extra = '') => ({ key, type, severity: 'info', title: `${n} more ${what}`, message: `Open the relevant report for the full list.${extra}`, view });

  // Low stock (reorder_level > 0 and qty <= level, or qty <= 0)
  const low = [];
  for (const s of await getStockPositions()) {
    const lvl = Number(s.reorder_level) || 0;
    if (s.current_qty <= 0 || (lvl > 0 && s.current_qty <= lvl)) low.push({ s, lvl });
  }
  low.sort((x, y) => (x.s.current_qty <= 0 ? 0 : 1) - (y.s.current_qty <= 0 ? 0 : 1) || x.s.current_qty - y.s.current_qty);
  for (const { s, lvl } of low.slice(0, CAP.stock)) {
    alerts.push({
      key: `low-stock:${s.id}`, type: 'low_stock', severity: s.current_qty <= 0 ? 'critical' : 'warning',
      title: `Low stock: ${s.name}`,
      message: `Current quantity ${s.current_qty}` + (lvl > 0 ? ` is at/below reorder level ${lvl}.` : ' (zero or negative).'),
      view: 'view-stock-summary'
    });
  }
  if (low.length > CAP.stock) alerts.push(more('low-stock:more', 'low_stock', low.length - CAP.stock, 'item(s) low on stock', 'view-stock-summary'));

  // Overdue receivables / payables, one alert per customer / supplier (bill-by-bill outstandings)
  const { receivables, payables } = await getOpenBills();
  const overdueBy = (bills) => {
    const m = new Map();
    for (const b of bills) {
      const d = daysBetween(b.due_date, today);
      if (d <= 0) continue;
      const c = m.get(b.ledger_id) || { id: b.ledger_id, name: b.ledger_name, total: 0, oldest: 0, bills: 0 };
      c.total += b.pending_amount; c.oldest = Math.max(c.oldest, d); c.bills++;
      m.set(b.ledger_id, c);
    }
    return [...m.values()].sort((x, y) => y.total - x.total);
  };
  const recv = overdueBy(receivables), pay = overdueBy(payables);
  for (const c of recv.slice(0, CAP.recv)) {
    alerts.push({
      key: `overdue-recv:${c.id}`, type: 'overdue_receivable', severity: c.oldest > 30 ? 'critical' : 'warning',
      title: `Overdue receivable: ${c.name}`,
      message: `${c.bills} bill(s) overdue totalling ${inr(c.total)}; the oldest is ${c.oldest} day(s) past due.`,
      view: 'view-outstandings'
    });
  }
  if (recv.length > CAP.recv) {
    const rest = recv.slice(CAP.recv);
    alerts.push(more('overdue-recv:more', 'overdue_receivable', rest.length, 'customer(s) with overdue bills', 'view-outstandings', ` Together ${inr(rest.reduce((t, c) => t + c.total, 0))}.`));
  }
  for (const c of pay.slice(0, CAP.pay)) {
    alerts.push({
      key: `overdue-pay:${c.id}`, type: 'overdue_payable', severity: 'warning',
      title: `Payment overdue to: ${c.name}`,
      message: `${c.bills} bill(s) payable totalling ${inr(c.total)}; the oldest is ${c.oldest} day(s) past due.`,
      view: 'view-outstandings'
    });
  }
  if (pay.length > CAP.pay) alerts.push(more('overdue-pay:more', 'overdue_payable', pay.length - CAP.pay, 'supplier(s) with overdue bills', 'view-outstandings'));

  // Unbalanced vouchers (integrity)
  const unb = await getUnbalancedVouchers();
  for (const v of unb.slice(0, CAP.unbal)) {
    alerts.push({
      key: `unbalanced:${v.id}`, type: 'integrity', severity: 'critical',
      title: `Unbalanced voucher ${v.voucher_no}`,
      message: `Debit ${inr(v.total_dr)} does not equal credit ${inr(v.total_cr)}.`,
      view: 'view-daybook'
    });
  }
  if (unb.length > CAP.unbal) alerts.push({ ...more('unbalanced:more', 'integrity', unb.length - CAP.unbal, 'unbalanced voucher(s)', 'view-daybook'), severity: 'critical' });

  // Expired / soon-to-expire batches that still have stock
  try {
    for (const a of await require('../../core/trackingTools').getExpiryAlerts()) alerts.push(a);
  } catch (e) { /* tracking tables not present yet */ }

  // Vouchers waiting for an approver
  try {
    const pa = await get("SELECT COUNT(*) c, MIN(requested_at) d FROM approval_requests WHERE status = 'pending'");
    if (pa && pa.c > 0) alerts.push({ key: 'approvals-pending', type: 'approval', severity: 'warning', title: `${pa.c} voucher(s) waiting for approval`, message: `Oldest requested ${String(pa.d).slice(0, 10)}. An Owner or Accountant can approve or reject them under Approvals.`, view: null });
  } catch (e) { /* table not present yet */ }

  // Budgets nearly used / exceeded, and customers near or over their credit limit
  try { const org = require('../../core/orgTools'); for (const a of await org.getBudgetAlerts()) alerts.push(a); for (const a of await org.getCreditAlerts()) alerts.push(a); } catch (e) { /* tables not present yet */ }

  // Recurring vouchers waiting for confirmation
  try {
    const pend = await get("SELECT COUNT(*) c, MIN(due_date) d FROM recurring_drafts WHERE status = 'pending'");
    if (pend && pend.c > 0) {
      alerts.push({
        key: 'recurring-pending', type: 'recurring', severity: 'info',
        title: `${pend.c} recurring voucher(s) waiting for your confirmation`,
        message: `Oldest due ${pend.d}. Review and confirm or skip them under Recurring & Import.`, view: null
      });
    }
  } catch (e) { /* table not present yet */ }

  // Backup freshness
  try {
    const latest = listBackups()[0];
    const ageDays = latest ? (Date.now() - Date.parse(latest.created_at)) / 86400000 : Infinity;
    if (ageDays > 7) {
      alerts.push({
        key: 'backup-stale', type: 'backup', severity: 'warning',
        title: latest ? 'Backup is more than 7 days old' : 'No backup has been taken yet',
        message: 'Create a snapshot from Data (Alt+Y).', view: null
      });
    }
  } catch (e) { /* backup folder unreadable: skip */ }

  // GST filing reminders (statutory dates for regular monthly filers; QRMP/other schemes differ)
  const d = new Date();
  const day = d.getDate();
  const prev = new Date(d.getFullYear(), d.getMonth() - 1, 1);
  const period = prev.toLocaleString('en-IN', { month: 'short', year: 'numeric' });
  const pkey = `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, '0')}`;
  if (day >= 6 && day <= 11) {
    alerts.push({
      key: `gst-gstr1:${pkey}`, type: 'gst_reminder', severity: 'info',
      title: `GSTR-1 for ${period} is due on the 11th`,
      message: 'Monthly-filer due date. Verify against the current CBIC notification for your filing scheme.',
      view: 'view-gst'
    });
  }
  if (day >= 15 && day <= 20) {
    alerts.push({
      key: `gst-gstr3b:${pkey}`, type: 'gst_reminder', severity: 'info',
      title: `GSTR-3B for ${period} is due on the 20th`,
      message: 'Monthly-filer due date. Verify against the current CBIC notification for your filing scheme.',
      view: 'view-gst'
    });
  }
  return alerts;
}

async function syncNotifications() {
  const alerts = await computeAlerts();
  await withTransaction(async () => {
    const existing = new Map((await all('SELECT id, dedupe_key, severity, title, message, link_view, is_resolved FROM notifications')).map((r) => [r.dedupe_key, r]));
    const keys = new Set();
    for (const a of alerts) {
      keys.add(a.key);
      const e = existing.get(a.key);
      if (!e) {
        await run(`INSERT INTO notifications (dedupe_key, type, severity, title, message, link_view) VALUES (?, ?, ?, ?, ?, ?)`, [a.key, a.type, a.severity, a.title, a.message, a.view]);
      } else if (e.is_resolved || e.severity !== a.severity || e.title !== a.title || e.message !== a.message || (e.link_view || null) !== (a.view || null)) {
        await run(
          `UPDATE notifications SET severity=?, title=?, message=?, link_view=?, updated_at=CURRENT_TIMESTAMP,
             is_read = CASE WHEN is_resolved=1 THEN 0 ELSE is_read END, is_resolved=0 WHERE id = ?`,
          [a.severity, a.title, a.message, a.view, e.id]);
      }
    }
    for (const [k, e] of existing) {
      if (!e.is_resolved && !keys.has(k)) await run('UPDATE notifications SET is_resolved = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [e.id]);
    }
    await run("DELETE FROM notifications WHERE is_resolved = 1 AND updated_at < datetime('now', '-30 days')");
  });
}

router.get('/notifications', requireAuth(), async (req, res) => {
  try {
    await syncNotifications();
    const rows = await all(`
      SELECT id, type, severity, title, message, link_view, is_read, created_at
      FROM notifications WHERE is_resolved = 0
      ORDER BY is_read ASC,
        CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, updated_at DESC
      LIMIT 200`);
    res.json({ success: true, unread: rows.filter((r) => !r.is_read).length, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/notifications/read-all', requireAuth(), async (req, res) => {
  try {
    const r = await run('UPDATE notifications SET is_read = 1 WHERE is_resolved = 0 AND is_read = 0');
    res.json({ success: true, updated: r.changes });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/notifications/:id/read', requireAuth(), async (req, res) => {
  try {
    const r = await run('UPDATE notifications SET is_read = 1 WHERE id = ?', [parseInt(req.params.id, 10)]);
    res.json({ success: true, updated: r.changes });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Global search (vouchers, ledgers, customers, suppliers, stock items)
// ---------------------------------------------------------------------------
const likeEscape = (s) => s.replace(/[\\%_]/g, (c) => '\\' + c);

router.get('/search', requireAuth(), async (req, res) => {
  try {
    const q = String(req.query.q || '').trim().slice(0, 80);
    if (q.length < 2) return res.json({ success: true, data: { vouchers: [], ledgers: [], items: [] } });
    const like = `%${likeEscape(q)}%`;
    const asNum = Number(q.replace(/,/g, ''));
    const amountClause = Number.isFinite(asNum) && /\d/.test(q) ? ' OR ABS(v.total_amount - ?) < 0.005' : '';

    const voucherParams = [like, like, like, like];
    if (amountClause) voucherParams.push(asNum);

    const vouchers = await all(`
      SELECT v.id, v.voucher_type, v.voucher_no, v.date, v.total_amount, v.narration, p.name AS party_name
      FROM vouchers v LEFT JOIN ledgers p ON v.party_ledger_id = p.id
      WHERE v.voucher_no LIKE ? ESCAPE '\\' OR v.narration LIKE ? ESCAPE '\\'
         OR v.reference_no LIKE ? ESCAPE '\\' OR p.name LIKE ? ESCAPE '\\'${amountClause}
      ORDER BY v.date DESC, v.id DESC LIMIT 10`, voucherParams);

    const ledgers = await all(`
      SELECT l.id, l.name, l.gstin, g.name AS group_name
      FROM ledgers l JOIN account_groups g ON l.group_id = g.id
      WHERE l.name LIKE ? ESCAPE '\\' OR l.gstin LIKE ? ESCAPE '\\'
      ORDER BY l.name LIMIT 10`, [like, like]);

    const items = await all(`
      SELECT id, name, hsn_code FROM stock_items
      WHERE name LIKE ? ESCAPE '\\' OR hsn_code LIKE ? ESCAPE '\\' ORDER BY name LIMIT 10`, [like, like]);

    res.json({
      success: true,
      data: {
        vouchers,
        ledgers: ledgers.map((l) => ({
          ...l,
          kind: l.group_name === 'Sundry Debtors' ? 'Customer' : l.group_name === 'Sundry Creditors' ? 'Supplier' : 'Ledger'
        })),
        items
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// One-click export (Excel-compatible CSV, UTF-8 BOM). Guards against CSV/formula injection.
// ---------------------------------------------------------------------------
router.get('/export/:dataset', requireAuth('canViewFinancials'), async (req, res) => {
  try {
    const gen = DATASETS[req.params.dataset];
    if (!gen) return res.status(404).json({ success: false, error: 'Unknown dataset. Available: ' + Object.keys(DATASETS).join(', ') });
    const { csv } = await gen(req.query);
    await logActivity({ user: req.user, ip: req.ip, action: 'EXPORT', entity: 'dataset', entityId: req.params.dataset });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="RRE_${req.params.dataset}_${todayIso()}.csv"`);
    res.send(csv);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Transaction activity log (read)
// ---------------------------------------------------------------------------
router.get('/activity-log', requireAuth('canViewAuditTrail'), async (req, res) => {
  try {
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 100));
    const rows = await all('SELECT * FROM activity_log ORDER BY id DESC LIMIT ?', [limit]);
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Backup verification: checksum, openability, and row counts vs live database
// (read-only: opens the snapshot via a temp copy; never touches the live DB)
// ---------------------------------------------------------------------------
function openReadOnly(file) {
  return new Promise((resolve, reject) => {
    const d = new sqlite3.Database(file, sqlite3.OPEN_READONLY, (e) => (e ? reject(e) : resolve(d)));
  });
}
const dbGet = (d, sql) => new Promise((resolve, reject) => d.get(sql, (e, r) => (e ? reject(e) : resolve(r))));
const dbClose = (d) => new Promise((resolve) => d.close(() => resolve()));

async function verifyBackupFile(meta) {
  const result = { filename: meta.filename, checks: [] };
  const file = path.join(getBackupDir(), path.basename(meta.filename));
  const add = (name, ok, detail) => result.checks.push({ name, ok, detail });

  if (!fs.existsSync(file)) { add('File present', false, 'Snapshot file is missing'); result.ok = false; return result; }
  add('File present', true, `${fs.statSync(file).size} bytes`);

  const actual = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  add('SHA-256 matches recorded checksum', actual === meta.sha256, actual === meta.sha256 ? 'match' : 'MISMATCH — file changed since backup');

  if (meta.encrypted) {
    add('Database readable', null, 'Encrypted snapshot: needs the password to open (checksum verified only)');
  } else {
    const tmp = path.join(require('os').tmpdir(), `rre_verify_${Date.now()}.sqlite`);
    let d;
    try {
      fs.copyFileSync(file, tmp);
      d = await openReadOnly(tmp);
      const integ = await dbGet(d, 'PRAGMA integrity_check');
      add('SQLite integrity_check', Object.values(integ)[0] === 'ok', String(Object.values(integ)[0]));
      const counts = {};
      for (const t of ['vouchers', 'ledgers', 'stock_items']) {
        try { counts[t] = (await dbGet(d, `SELECT COUNT(*) c FROM ${t}`)).c; } catch (e) { counts[t] = null; }
      }
      add('Contains core tables', counts.vouchers !== null && counts.ledgers !== null,
        `vouchers=${counts.vouchers}, ledgers=${counts.ledgers}, stock_items=${counts.stock_items}`);
      const live = {
        vouchers: (await get('SELECT COUNT(*) c FROM vouchers')).c,
        ledgers: (await get('SELECT COUNT(*) c FROM ledgers')).c
      };
      result.snapshot_counts = counts;
      result.live_counts = live;
      add('Snapshot has the same data as live DB right now',
        counts.vouchers === live.vouchers && counts.ledgers === live.ledgers,
        `snapshot vouchers/ledgers = ${counts.vouchers}/${counts.ledgers}, live = ${live.vouchers}/${live.ledgers}` +
        ' (differences are expected if data changed after the snapshot was taken)');
    } catch (e) {
      add('Database readable', false, e.message);
    } finally {
      if (d) await dbClose(d);
      try { fs.unlinkSync(tmp); } catch (e) {}
    }
  }
  result.ok = result.checks.every((c) => c.ok !== false);
  return result;
}

router.post('/backup/verify', requireAuth('canViewAuditTrail'), async (req, res) => {
  try {
    const all_ = listBackups();
    const target = req.body?.filename ? all_.find((b) => b.filename === req.body.filename) : all_[0];
    if (!target) return res.status(404).json({ success: false, error: 'No backup found to verify.' });
    const data = await verifyBackupFile(target);
    await logActivity({ user: req.user, ip: req.ip, action: 'BACKUP_VERIFY', entity: 'backup', entityId: target.filename, details: { ok: data.ok } });
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Scheduled reports
// ---------------------------------------------------------------------------
router.get('/schedules', requireAuth('canViewFinancials'), async (req, res) => {
  try {
    const rows = await all('SELECT * FROM scheduled_reports ORDER BY id DESC');
    res.json({ success: true, data: rows.map((r) => ({ ...r, params: JSON.parse(r.params || '{}') })), datasets: Object.keys(DATASETS) });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

router.post('/schedules', requireAuth('canViewFinancials'), async (req, res) => {
  try {
    const row = await scheduler.createSchedule(req.body || {}, req.user);
    await logActivity({ user: req.user, ip: req.ip, action: 'SCHEDULE_CREATE', entity: 'report', entityId: row.id, details: { name: row.name } });
    res.json({ success: true, data: row });
  } catch (err) { res.status(400).json({ success: false, error: err.message }); }
});

router.post('/schedules/:id/run', requireAuth('canViewFinancials'), async (req, res) => {
  try {
    const s = await get('SELECT * FROM scheduled_reports WHERE id = ?', [parseInt(req.params.id, 10)]);
    if (!s) return res.status(404).json({ success: false, error: 'Schedule not found.' });
    res.json({ success: true, data: await scheduler.runSchedule(s, { advance: false, user: req.user }) });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

router.post('/schedules/:id/toggle', requireAuth('canViewFinancials'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const s = await get('SELECT * FROM scheduled_reports WHERE id = ?', [id]);
    if (!s) return res.status(404).json({ success: false, error: 'Schedule not found.' });
    const active = s.is_active ? 0 : 1;
    const next = active ? scheduler.computeNextRun(s.frequency, s.hour).toISOString() : s.next_run_at;
    await run('UPDATE scheduled_reports SET is_active = ?, next_run_at = ? WHERE id = ?', [active, next, id]);
    await logActivity({ user: req.user, ip: req.ip, action: active ? 'SCHEDULE_ENABLE' : 'SCHEDULE_DISABLE', entity: 'report', entityId: id });
    res.json({ success: true, is_active: active });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

router.delete('/schedules/:id', requireAuth('canAlterCompany'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const r = await run('DELETE FROM scheduled_reports WHERE id = ?', [id]);
    if (!r.changes) return res.status(404).json({ success: false, error: 'Schedule not found.' });
    await logActivity({ user: req.user, ip: req.ip, action: 'SCHEDULE_DELETE', entity: 'report', entityId: id });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

router.get('/schedules/:id/outputs', requireAuth('canViewFinancials'), async (req, res) => {
  try {
    const rows = await all(
      'SELECT id, generated_at, filename, row_count, status, message FROM report_outputs WHERE schedule_id = ? ORDER BY id DESC LIMIT 30',
      [parseInt(req.params.id, 10)]);
    res.json({ success: true, data: rows });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

router.get('/outputs/:id/download', requireAuth('canViewFinancials'), async (req, res) => {
  try {
    const o = await get('SELECT filename, content, status FROM report_outputs WHERE id = ?', [parseInt(req.params.id, 10)]);
    if (!o || o.status !== 'ok' || o.content == null) return res.status(404).json({ success: false, error: 'Report output not available.' });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${o.filename.replace(/[^\w.-]/g, '_')}"`);
    res.send(o.content);
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ---------------------------------------------------------------------------
// Printable invoice (HTML for Print / Save as PDF)
// ---------------------------------------------------------------------------
router.get('/invoice/:id', requireAuth('canViewFinancials'), async (req, res) => {
  try {
    const html = await buildInvoiceHtml(parseInt(req.params.id, 10));
    if (!html) return res.status(404).json({ success: false, error: 'Voucher not found.' });
    await logActivity({ user: req.user, ip: req.ip, action: 'INVOICE_PRINT', entity: 'voucher', entityId: req.params.id });
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

module.exports = router;
module.exports._internals = { computeAlerts, syncNotifications, verifyBackupFile };
