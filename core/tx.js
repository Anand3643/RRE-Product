/**
 * Serialised transactions for the single shared SQLite connection.
 * Calls made through withTransaction() never overlap each other, so a BEGIN/COMMIT pair
 * can't be interleaved with another new-module operation.
 * (Legacy routers still issue their own BEGIN; that is outside this helper's reach.)
 */
const { run, getCompanyNumber } = require('./db');

const chains = new Map(); // one queue per company: each company has its own connection

function withTransaction(fn) {
  const key = String(getCompanyNumber());
  const chain = chains.get(key) || Promise.resolve();
  const result = chain.then(async () => {
    await run('BEGIN IMMEDIATE');
    try {
      const out = await fn();
      await run('COMMIT');
      return out;
    } catch (err) {
      await run('ROLLBACK').catch(() => {});
      throw err;
    }
  });
  chains.set(key, result.catch(() => {}));
  return result;
}

module.exports = { withTransaction };
