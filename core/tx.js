/**
 * Transactions for every posting (vouchers, orders, stock documents, quotations ...). A posting is all-or-nothing: any error rolls the
 * whole transaction back.
 *
 * Default: one queue per company - postings of a company run one after another. SQLite needs this (one writer per database), and on
 * PostgreSQL it keeps every read-then-write step (next document number, available stock ...) of the older code paths correct.
 *
 * withTransaction(fn, { concurrent: true }) on PostgreSQL: the posting does NOT wait for the company queue. It runs in its own
 * transaction at the same time as others, and locks only what it really competes for with lockKeys() - e.g. one voucher-number series
 * or one stock item - for the rest of its transaction. Two sales of different items, a sale and a journal, two users posting different
 * vouchers: none of them wait for each other. Two postings that need the same next number or the same item's last units take turns.
 * Locks are always taken in a fixed (sorted) order, so postings cannot deadlock; should PostgreSQL ever report one, the posting runs again.
 * (On SQLite the option changes nothing: the queue is kept.)
 */
const db = require('./db');
const { run, getCompanyNumber } = db;

const chains = new Map(); // one queue per company
const MAX_ATTEMPTS = 5;
const stats = { queued: 0, concurrent: 0, deadlockRetries: 0 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function once(fn, begin) {
  return db.withTxContext(async () => {
    await run(begin);
    try {
      const out = await fn();
      await run('COMMIT');
      return out;
    } catch (err) {
      await run('ROLLBACK').catch(() => {});
      throw err;
    }
  });
}

async function concurrent(fn) {
  stats.concurrent++;
  for (let attempt = 1; ; attempt++) {
    try { return await once(fn, 'BEGIN ISOLATION LEVEL READ COMMITTED'); } catch (err) {
      if (!(err && err.code === '40P01') || attempt >= MAX_ATTEMPTS) throw err; // deadlock detected: run the posting again
      stats.deadlockRetries++; await sleep(Math.round((5 + Math.random() * 20) * attempt));
    }
  }
}

function withTransaction(fn, opts = {}) {
  if (opts.concurrent && db.isPostgres()) return concurrent(fn);
  stats.queued++;
  const key = String(getCompanyNumber());
  const chain = chains.get(key) || Promise.resolve();
  const result = chain.then(() => once(fn, 'BEGIN IMMEDIATE'));
  chains.set(key, result.catch(() => {}));
  return result;
}

/**
 * Inside a transaction: wait for, and then hold until the transaction ends, a lock on each named thing of THIS company
 * ('voucher-no:RRE/SAL/', 'stock:17', 'idem:...'). After it returns, every following query sees what other postings committed while
 * this one waited. PostgreSQL only (SQLite has a single writer: nothing to lock).
 */
async function lockKeys(keys) {
  if (!db.isPostgres() || !keys || !keys.length) return;
  const co = String(getCompanyNumber());
  for (const k of [...new Set(keys.map(String))].sort()) await db.get('SELECT pg_advisory_xact_lock(hashtextextended(?, 0)) AS locked', [co + '|' + k]);
}

module.exports = { withTransaction, lockKeys, stats };
