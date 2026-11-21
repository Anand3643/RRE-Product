/**
 * RRE Tally — recurring vouchers (rent, salaries, subscriptions…).
 *
 * A template NEVER posts by itself. When it falls due, the scheduler creates a DRAFT; a person with
 * permission reviews it and confirms (posts) or skips it. This keeps a human approval on every posting.
 */
const { run, get, all } = require('./db');
const { withTransaction } = require('./tx');
const { postVoucher, normaliseVoucher, assertRoleMayPost } = require('./voucherPoster');
const { logActivity } = require('./auth');

const FREQUENCIES = ['weekly', 'monthly', 'quarterly', 'yearly'];
const MAX_CATCHUP = 12; // drafts created per template per run
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const todayIso = () => new Date().toISOString().slice(0, 10);
const bad = (m, s = 400) => { const e = new Error(m); e.status = s; return e; };

/** Next due date after `iso` (UTC dates). Monthly/quarterly/yearly keep the original day, clamped to month end. */
function nextDue(iso, frequency, anchorDay) {
  const [y, m, d] = iso.split('-').map(Number);
  if (frequency === 'weekly') return new Date(Date.UTC(y, m - 1, d + 7)).toISOString().slice(0, 10);
  const add = frequency === 'monthly' ? 1 : frequency === 'quarterly' ? 3 : frequency === 'yearly' ? 12 : null;
  if (add === null) throw bad('Unsupported frequency.');
  const total = (m - 1) + add;
  const ny = y + Math.floor(total / 12), nm = total % 12;
  const last = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
  return new Date(Date.UTC(ny, nm, Math.min(anchorDay || d, last))).toISOString().slice(0, 10);
}

async function validateTemplate(b) {
  const name = String(b.name || '').trim();
  if (!name || name.length > 80) throw bad('Name is required (max 80 characters).');
  if (!FREQUENCIES.includes(b.frequency)) throw bad('Frequency must be weekly, monthly, quarterly or yearly.');
  if (!ISO.test(b.start_date || '')) throw bad('start_date must be YYYY-MM-DD.');
  if (b.end_date && (!ISO.test(b.end_date) || b.end_date < b.start_date)) throw bad('end_date must be YYYY-MM-DD and not before the start date.');
  const { lines } = normaliseVoucher({ voucher_type: b.voucher_type, date: b.start_date, entries: b.entries }, { tolerance: 0.005 });
  const ids = [...new Set(lines.map((l) => l.ledger_id))];
  const found = await all(`SELECT id FROM ledgers WHERE id IN (${ids.map(() => '?').join(',')})`, ids);
  if (found.length !== ids.length) throw bad('One or more ledgers do not exist.');
  const party = b.party_ledger_id ? parseInt(b.party_ledger_id, 10) : null;
  if (party && !(await get('SELECT id FROM ledgers WHERE id = ?', [party]))) throw bad('Party ledger does not exist.');
  return { name, frequency: b.frequency, start_date: b.start_date, end_date: b.end_date || null, voucher_type: b.voucher_type, party,
    narration: String(b.narration || '').slice(0, 300), reference_no: String(b.reference_no || '').slice(0, 60),
    entries: lines.map(({ ledger_id, debit_amount, credit_amount }) => ({ ledger_id, debit_amount, credit_amount })) };
}

async function createTemplate(body, user) {
  assertRoleMayPost(user, body.voucher_type);
  const t = await validateTemplate(body);
  const r = await run(
    `INSERT INTO recurring_templates (name, voucher_type, party_ledger_id, narration, reference_no, entries, frequency, anchor_day, start_date, end_date, next_due, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [t.name, t.voucher_type, t.party, t.narration, t.reference_no, JSON.stringify(t.entries), t.frequency, Number(t.start_date.slice(8)), t.start_date, t.end_date, t.start_date, user?.username || 'unknown']);
  return get('SELECT * FROM recurring_templates WHERE id = ?', [r.lastID]);
}

/** Creates drafts for every due date up to `asOf`. Idempotent (UNIQUE template+due date). */
async function generateDueDrafts(asOf = todayIso()) {
  const due = await all('SELECT * FROM recurring_templates WHERE is_active = 1 AND next_due IS NOT NULL AND next_due <= ?', [asOf]);
  let created = 0;
  for (const t of due) {
    await withTransaction(async () => {
      let d = t.next_due, n = 0;
      while (d && d <= asOf && n < MAX_CATCHUP && (!t.end_date || d <= t.end_date)) {
        const r = await run(`INSERT OR IGNORE INTO recurring_drafts (template_id, due_date) VALUES (?, ?)`, [t.id, d]);
        if (r.changes) created++;
        d = nextDue(d, t.frequency, t.anchor_day); n++;
      }
      const finished = t.end_date && d > t.end_date;
      await run('UPDATE recurring_templates SET next_due = ?, is_active = ? WHERE id = ?', [finished ? null : d, finished ? 0 : 1, t.id]);
    });
  }
  return { templates_due: due.length, drafts_created: created };
}

async function confirmDraft(id, { date, narration, amount } = {}, user) {
  const draft = await get(`SELECT d.*, t.name, t.voucher_type, t.party_ledger_id, t.narration AS t_narration, t.reference_no, t.entries
                           FROM recurring_drafts d JOIN recurring_templates t ON t.id = d.template_id WHERE d.id = ?`, [id]);
  if (!draft) throw bad('Draft not found.', 404);
  if (draft.status !== 'pending') throw bad(`This draft is already ${draft.status}.`, 409);
  assertRoleMayPost(user, draft.voucher_type);
  let entries = JSON.parse(draft.entries);
  const held = await require('./approvals').evaluate({ voucher_type: draft.voucher_type, entries: JSON.parse(draft.entries) }, user);
  if (held.length) throw bad(`This recurring voucher needs approval (${held.map((h) => h.reason).join('; ')}). An Owner or Accountant must confirm it.`, 403);
  if (amount !== undefined && amount !== null && amount !== '') {
    const a = Number(amount);
    if (!Number.isFinite(a) || a <= 0 || a > 1e10) throw bad('amount must be a positive number.');
    if (entries.length !== 2) throw bad('Amount can only be changed on simple two-line templates; edit the template instead.');
    entries = entries.map((e) => ({ ...e, debit_amount: e.debit_amount > 0 ? r2(a) : 0, credit_amount: e.credit_amount > 0 ? r2(a) : 0 }));
  }
  const postDate = date || draft.due_date;
  if (!ISO.test(postDate)) throw bad('date must be YYYY-MM-DD.');
  const voucherNo = `REC/${draft.template_id}/${draft.due_date.replace(/-/g, '')}`;

  const out = await withTransaction(async () => {
    const fresh = await get('SELECT status FROM recurring_drafts WHERE id = ?', [id]);
    if (fresh.status !== 'pending') throw bad(`This draft is already ${fresh.status}.`, 409); // lost a race
    const posted = await postVoucher({ voucher_type: draft.voucher_type, voucher_no: voucherNo, date: postDate, reference_no: draft.reference_no,
      narration: narration || draft.t_narration || `${draft.name} (recurring)`, party_ledger_id: draft.party_ledger_id, entries }, { user, source: 'recurring' });
    await run(`UPDATE recurring_drafts SET status = 'posted', voucher_id = ?, actioned_by = ?, actioned_at = CURRENT_TIMESTAMP WHERE id = ?`, [posted.id, user?.username || 'unknown', id]);
    return posted;
  });
  await logActivity({ user, action: 'RECURRING_CONFIRM', entity: 'voucher', entityId: out.id, details: { template: draft.name, due: draft.due_date, voucher_no: out.voucher_no, amount: out.total_amount } });
  return out;
}

async function skipDraft(id, user) {
  const r = await run(`UPDATE recurring_drafts SET status = 'skipped', actioned_by = ?, actioned_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'pending'`, [user?.username || 'unknown', id]);
  if (!r.changes) {
    const d = await get('SELECT status FROM recurring_drafts WHERE id = ?', [id]);
    throw d ? bad(`This draft is already ${d.status}.`, 409) : bad('Draft not found.', 404);
  }
  await logActivity({ user, action: 'RECURRING_SKIP', entity: 'recurring_draft', entityId: id });
}

async function listTemplates() {
  const rows = await all(`
    SELECT t.*, p.name AS party,
      (SELECT COUNT(*) FROM recurring_drafts d WHERE d.template_id = t.id AND d.status = 'pending') AS pending_drafts,
      (SELECT COUNT(*) FROM recurring_drafts d WHERE d.template_id = t.id AND d.status = 'posted') AS posted_count
    FROM recurring_templates t LEFT JOIN ledgers p ON p.id = t.party_ledger_id ORDER BY t.id DESC`);
  const names = new Map((await all('SELECT id, name FROM ledgers')).map((l) => [l.id, l.name]));
  return rows.map((t) => {
    const entries = JSON.parse(t.entries);
    return { ...t, entries: entries.map((e) => ({ ...e, ledger: names.get(e.ledger_id) })), amount: entries.reduce((s, e) => s + e.debit_amount, 0) };
  });
}

async function listDrafts(status = 'pending') {
  const rows = await all(`
    SELECT d.id, d.template_id, d.due_date, d.status, d.voucher_id, d.actioned_by, d.actioned_at, t.name, t.voucher_type, t.narration, t.entries
    FROM recurring_drafts d JOIN recurring_templates t ON t.id = d.template_id
    WHERE (? = 'all' OR d.status = ?) ORDER BY d.due_date, d.id LIMIT 500`, [status, status]);
  return rows.map((d) => ({ ...d, amount: JSON.parse(d.entries).reduce((s, e) => s + e.debit_amount, 0), entries: undefined }));
}

module.exports = { createTemplate, generateDueDrafts, confirmDraft, skipDraft, listTemplates, listDrafts, nextDue, FREQUENCIES };
