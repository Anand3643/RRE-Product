/**
 * Serialised transactions for the single shared SQLite connection.
 * Calls made through withTransaction() never overlap each other, so a BEGIN/COMMIT pair
 * can't be interleaved with another new-module operation.
 * (Legacy routers still issue their own BEGIN; that is outside this helper's reach.)
 */
const { run } = require('./db');

let chain = Promise.resolve();

function withTransaction(fn) {
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
  chain = result.catch(() => {});
  return result;
}

module.exports = { withTransaction };
