/**
 * RRE Tally — in-process report scheduler.
 * Generates CSV reports on a schedule and stores them in report_outputs.
 * The app must be running at the scheduled time; missed runs execute once at next start/tick
 * (they are never replayed more than once).
 */
const { run, get, all } = require('./db');
const { DATASETS } = require('./exports');
const { logActivity } = require('./auth');

const FREQUENCIES = ['daily', 'weekly', 'monthly'];
const MAX_OUTPUTS_PER_SCHEDULE = 30;
const MAX_CSV_BYTES = 5 * 1024 * 1024;
const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** Next run strictly after `from`, at local `hour`:00. */
function computeNextRun(frequency, hour, from = new Date()) {
  const d = new Date(from.getTime());
  d.setHours(hour, 0, 0, 0);
  if (frequency === 'daily') {
    if (d <= from) d.setDate(d.getDate() + 1);
  } else if (frequency === 'weekly') {
    d.setDate(d.getDate() + 7);
  } else if (frequency === 'monthly') {
    const day = from.getDate();
    d.setDate(1);
    d.setMonth(d.getMonth() + 1);
    const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    d.setDate(Math.min(day, last));
  } else {
    throw new Error('Unsupported frequency');
  }
  return d;
}

function validateSchedule(body) {
  const name = String(body.name || '').trim();
  if (!name || name.length > 80) throw new Error('Name is required (max 80 characters).');
  if (!DATASETS[body.dataset]) throw new Error('Unknown report. Available: ' + Object.keys(DATASETS).join(', '));
  if (!FREQUENCIES.includes(body.frequency)) throw new Error('Frequency must be daily, weekly or monthly.');
  const hour = Number(body.hour);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) throw new Error('Hour must be a whole number from 0 to 23.');
  const params = {};
  const p = body.params || {};
  for (const k of ['from_date', 'to_date']) {
    if (p[k]) { if (!ISO.test(p[k])) throw new Error(`${k} must be YYYY-MM-DD.`); params[k] = p[k]; }
  }
  if (p.type) { if (typeof p.type !== 'string' || p.type.length > 30) throw new Error('Invalid voucher type.'); params.type = p.type; }
  return { name, dataset: body.dataset, frequency: body.frequency, hour, params };
}

async function createSchedule(body, user) {
  const v = validateSchedule(body);
  const next = computeNextRun(v.frequency, v.hour);
  const r = await run(
    `INSERT INTO scheduled_reports (name, dataset, params, frequency, hour, next_run_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [v.name, v.dataset, JSON.stringify(v.params), v.frequency, v.hour, next.toISOString(), user?.username || 'unknown']
  );
  return get('SELECT * FROM scheduled_reports WHERE id = ?', [r.lastID]);
}

/** Generates and stores one output for a schedule. Never throws for generator errors; records them. */
async function runSchedule(schedule, { advance = true, user = null } = {}) {
  let status = 'ok';
  let message = null;
  let csv = null;
  let rows = 0;
  try {
    const gen = DATASETS[schedule.dataset];
    if (!gen) throw new Error('Report type no longer available');
    const out = await gen(JSON.parse(schedule.params || '{}'));
    csv = out.csv;
    rows = out.rows;
    if (Buffer.byteLength(csv) > MAX_CSV_BYTES) throw new Error('Report exceeds the 5 MB storage limit; narrow the date range.');
  } catch (e) {
    status = 'error';
    message = e.message;
    csv = null;
  }

  const filename = `RRE_${schedule.dataset}_${new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19)}.csv`;
  const ins = await run(
    `INSERT INTO report_outputs (schedule_id, dataset, filename, row_count, status, message, content) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [schedule.id, schedule.dataset, filename, rows, status, message, csv]
  );
  const nowIso = new Date().toISOString();
  if (advance) {
    await run('UPDATE scheduled_reports SET last_run_at = ?, next_run_at = ? WHERE id = ?',
      [nowIso, computeNextRun(schedule.frequency, schedule.hour).toISOString(), schedule.id]);
  } else {
    await run('UPDATE scheduled_reports SET last_run_at = ? WHERE id = ?', [nowIso, schedule.id]);
  }
  // retention: keep newest N outputs per schedule
  await run(
    `DELETE FROM report_outputs WHERE schedule_id = ? AND id NOT IN
       (SELECT id FROM report_outputs WHERE schedule_id = ? ORDER BY id DESC LIMIT ?)`,
    [schedule.id, schedule.id, MAX_OUTPUTS_PER_SCHEDULE]
  );
  await logActivity({
    user: user || { username: 'scheduler', role: 'system' },
    action: 'SCHEDULED_REPORT_RUN', entity: 'report', entityId: schedule.id,
    details: { name: schedule.name, status, rows }
  });
  return { output_id: ins.lastID, status, message, rows, filename };
}

/** Runs every active schedule that is due. Safe to call repeatedly. */
async function runDueSchedules(now = new Date()) {
  const due = await all(
    'SELECT * FROM scheduled_reports WHERE is_active = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?',
    [now.toISOString()]
  );
  const results = [];
  for (const s of due) results.push({ id: s.id, ...(await runSchedule(s)) });
  return results;
}

let timer = null;
function startScheduler(intervalMs = 60000) {
  if (timer) return;
  const tick = () => {
    runDueSchedules().catch((e) => console.warn('[Scheduler] tick failed:', e.message));
    require('./recurring').generateDueDrafts().catch((e) => console.warn('[Scheduler] recurring drafts failed:', e.message)); // drafts only; never posts
  };
  timer = setInterval(tick, intervalMs);
  timer.unref();
  tick();
}
function stopScheduler() { if (timer) { clearInterval(timer); timer = null; } }

module.exports = { computeNextRun, validateSchedule, createSchedule, runSchedule, runDueSchedules, startScheduler, stopScheduler, FREQUENCIES };
