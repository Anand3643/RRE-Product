/**
 * Serialised transactions, one queue per company.
 * Calls made through withTransaction() never overlap each other, so a BEGIN/COMMIT pair can't be interleaved with another posting
 * (voucher numbers, stock checks and other read-then-write steps are safe).
 * Each transaction runs with its own transaction id (db.withTxContext): on PostgreSQL only the statements of THIS transaction use
 * its connection, while everybody else's queries keep running in parallel on other connections (they see committed data only).
 */
const db = require('./db');
const { run, getCompanyNumber } = db;

const chains = new Map(); // one queue per company

function withTransaction(fn) {
  const key = String(getCompanyNumber());
  const chain = chains.get(key) || Promise.resolve();
  const result = chain.then(() => db.withTxContext(async () => {
    await run('BEGIN IMMEDIATE');
    try {
      const out = await fn();
      await run('COMMIT');
      return out;
    } catch (err) {
      await run('ROLLBACK').catch(() => {});
      throw err;
    }
  }));
  chains.set(key, result.catch(() => {}));
  return result;
}

module.exports = { withTransaction };
