/**
 * Local database initializer for RRE Entries (company.db) & RRE Inventory (inventory/stockpilot.db).
 * Ensures schemas, 38 Tally groups, 96 standard Tally ledgers, SQLite app_settings defaults,
 * and the RRE Inventory SQLite database are initialized cleanly on local disk.
 *
 * Usage:
 *   node scripts/init-local-db.js                      # initialize workspace ./data/100000
 *   node scripts/init-local-db.js --clean              # back up & reset to clean production ledger slate
 *   node scripts/init-local-db.js --target=appdata     # initialize %APPDATA%/TallyPrimeGold/data/100000
 *   node scripts/init-local-db.js --target=all --clean # initialize both workspace and installed desktop DBs
 */
const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..');

function resolveTargetRoot(target) {
  if (target === 'appdata') {
    const appData = process.env.APPDATA || (process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'AppData', 'Roaming') : repoRoot);
    return path.join(appData, 'TallyPrimeGold', 'data');
  }
  return path.join(repoRoot, 'data');
}

function runSubTarget(target, clean) {
  const args = [__filename, `--target=${target}`];
  if (clean) args.push('--clean');
  const res = spawnSync(process.execPath, args, {
    cwd: repoRoot,
    env: { ...process.env, RRE_DATA_ROOT: resolveTargetRoot(target), RRE_INVENTORY_SEED: '0' },
    stdio: 'inherit'
  });
  if (res.status !== 0) process.exit(res.status || 1);
}

async function initSingleTarget(clean) {
  const paths = require('../core/paths');
  const db = require('../core/db');
  const { runMigrations } = require('../core/migrations');
  const settings = require('../core/settings');
  const host = require('../core/inventoryHost');

  const companyNum = paths.DEFAULT_COMPANY;
  const companyDir = paths.companyDir(companyNum);
  fs.mkdirSync(path.join(companyDir, 'backups'), { recursive: true });
  fs.mkdirSync(path.join(companyDir, 'inventory', 'uploads'), { recursive: true });

  await db.initDb();
  await runMigrations();

  if (clean) {
    await db.resetCleanCompany();
    await db.seedStandardTallyLedgers({ force: true });
    await db.run('PRAGMA foreign_keys = OFF');
    await db.run('DELETE FROM activity_log').catch(() => {});
    await db.run('DELETE FROM notifications').catch(() => {});
    await db.run('DELETE FROM user_logins').catch(() => {});
    await db.run('DELETE FROM auth_sessions').catch(() => {});
    await db.run('DELETE FROM password_resets').catch(() => {});
    await db.run("DELETE FROM users WHERE username != 'admin'").catch(() => {});
    await db.run('PRAGMA foreign_keys = ON');
  } else {
    await db.seedStandardTallyLedgers();
  }

  await settings.seedDefaults();

  // Ensure companies.json registry reflects local company
  if (!paths.readRegistry()) {
    const co = await db.get('SELECT name FROM company_info LIMIT 1');
    paths.writeRegistry({
      active: companyNum,
      companies: [{ number: companyNum, name: (co && co.name) || 'RRE Entries', created_at: new Date().toISOString() }]
    });
  }

  await db.run('PRAGMA wal_checkpoint(TRUNCATE)').catch(() => {});
  const integrityRow = await db.get('PRAGMA integrity_check');
  const integrity = integrityRow ? Object.values(integrityRow)[0] : 'unknown';

  const groups = (await db.get('SELECT COUNT(*) c FROM account_groups')).c;
  const ledgers = (await db.get('SELECT COUNT(*) c FROM ledgers')).c;
  const vouchers = (await db.get('SELECT COUNT(*) c FROM vouchers')).c;
  const settingsCount = (await db.get('SELECT COUNT(*) c FROM app_settings')).c;

  // Initialize local RRE Inventory SQLite DB (stockpilot.db) cleanly
  const invDbPath = path.join(companyDir, 'inventory', 'stockpilot.db');
  if (clean && fs.existsSync(invDbPath)) {
    const bakName = `stockpilot_preclean_${new Date().toISOString().replace(/[:.]/g, '-')}.db.bak`;
    fs.copyFileSync(invDbPath, path.join(companyDir, 'backups', bakName));
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(invDbPath + suffix); } catch {}
    }
  }

  const py = await host.findPython();
  let invStatus = 'skipped (Python inventory environment not installed)';
  if (py) {
    const dbUrl = `sqlite:///${invDbPath.replace(/\\/g, '/')}`;
    const pyScript = [
      'import os, secrets',
      'from sqlalchemy import select, text',
      'from app.core import engine, SessionLocal, hash_password',
      'from app.migrate import run as run_migrations',
      'from app.models import Organization, Warehouse, User',
      'run_migrations()',
      'with SessionLocal() as s:',
      '    org = s.scalars(select(Organization).order_by(Organization.id)).first()',
      '    if org is None:',
      '        org = Organization(name="RRE Entries")',
      '        s.add(org); s.flush()',
      '    wh = s.scalars(select(Warehouse).where(Warehouse.org_id == org.id)).first()',
      '    if wh is None:',
      '        s.add(Warehouse(org_id=org.id, code="MAIN", name="Main Warehouse"))',
      '    owner = s.scalars(select(User).where(User.role == "owner")).first()',
      '    if owner is None:',
      '        s.add(User(org_id=org.id, email="owner@rre-entries.app", name="Administrator", role="owner", password_hash=hash_password(secrets.token_urlsafe(32))))',
      '    s.commit()',
      'with engine.connect() as conn:',
      '    chk = conn.execute(text("PRAGMA integrity_check")).scalar()',
      '    print("INV_INTEGRITY=" + str(chk))'
    ].join('\n');

    const out = execFileSync(py, ['-c', pyScript], {
      cwd: path.join(repoRoot, 'inventory-app', 'backend'),
      env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONUTF8: '1', DATABASE_URL: dbUrl },
      encoding: 'utf8',
      windowsHide: true
    });
    invStatus = `ready (${out.trim()})`;
  }

  console.log(`\n[Local DB Initialized] Root: ${paths.ROOT}`);
  console.log(`  company.db     : ${db.getDbPath()} (integrity=${integrity}, groups=${groups}, ledgers=${ledgers}, vouchers=${vouchers}, app_settings=${settingsCount})`);
  console.log(`  stockpilot.db  : ${invDbPath} (${invStatus})`);

  await db.closeDb();
}

async function main() {
  const args = process.argv.slice(2);
  const clean = args.includes('--clean');
  const targetArg = args.find((a) => a.startsWith('--target='));
  const target = targetArg ? targetArg.split('=')[1] : 'workspace';

  if (target === 'all') {
    runSubTarget('workspace', clean);
    runSubTarget('appdata', clean);
    return;
  }

  if (!process.env.RRE_DATA_ROOT) {
    process.env.RRE_DATA_ROOT = resolveTargetRoot(target);
  }
  await initSingleTarget(clean);
}

main().catch((err) => {
  console.error('[init-local-db] Error:', err.message);
  process.exit(1);
});
