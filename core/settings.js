/**
 * Local SQLite key-value persistence for application & UI settings (`app_settings` table).
 * Keeps UI preferences (theme, colour mode, sidebar state, etc.) in company.db alongside accounting data.
 */
const fs = require('fs');
const path = require('path');
const db = require('./db');
const paths = require('./paths');
const { listBackups } = require('./backupEngine');

const UI_KEYS = ['tally_theme', 'rre_aurora_default_v1', 'au_mode', 'au_rail_open'];
const RESERVED = new Set(['guest_access']);
const VALID_KEY = /^[A-Za-z0-9_.:-]{1,80}$/;

const DEFAULTS = {
  tally_theme: 'aurora',
  rre_aurora_default_v1: '1',
  au_mode: 'light',
  au_rail_open: '0'
};

async function ensureTable() {
  await db.run('CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT)');
}

function isAllowedKey(key) {
  return VALID_KEY.test(key) && !RESERVED.has(key) && !key.startsWith('_');
}

async function get(key, fallback = null) {
  await ensureTable();
  const row = await db.get('SELECT value FROM app_settings WHERE key = ?', [String(key)]);
  return row && row.value != null ? row.value : fallback;
}

async function getAll() {
  await ensureTable();
  const rows = await db.all('SELECT key, value FROM app_settings ORDER BY key');
  const out = {};
  for (const r of rows) {
    if (isAllowedKey(r.key)) out[r.key] = r.value;
  }
  return out;
}

async function getUiPrefs() {
  await ensureTable();
  const placeholders = UI_KEYS.map(() => '?').join(',');
  const rows = await db.all(`SELECT key, value FROM app_settings WHERE key IN (${placeholders})`, UI_KEYS);
  const out = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}

async function setMany(values = {}) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) return await getAll();
  await ensureTable();
  for (const [rawKey, rawVal] of Object.entries(values)) {
    const key = String(rawKey || '').trim();
    if (!isAllowedKey(key)) continue;
    if (rawVal === null || rawVal === undefined) {
      await db.run('DELETE FROM app_settings WHERE key = ?', [key]);
      continue;
    }
    const val = typeof rawVal === 'string' ? rawVal : JSON.stringify(rawVal);
    await db.run(
      'INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      [key, val.slice(0, 4000)]
    );
  }
  return await getAll();
}

async function seedDefaults() {
  await ensureTable();
  for (const [k, v] of Object.entries(DEFAULTS)) {
    await db.run('INSERT OR IGNORE INTO app_settings (key, value) VALUES (?, ?)', [k, v]);
  }
}

async function getStorageStatus() {
  const dataDir = db.getDataDir();
  const companyDbPath = db.getDbPath();
  const inventoryDbPath = path.join(dataDir, 'inventory', 'stockpilot.db');
  const backupsDir = path.join(dataDir, 'backups');
  const statSize = (p) => { try { return fs.statSync(p).size; } catch { return 0; } };
  let backups = [];
  try { backups = listBackups(); } catch { backups = []; }
  return {
    storageMode: '100% Local SQLite & Filesystem (No Cloud Database)',
    dataRoot: paths.ROOT,
    companyNumber: db.getCompanyNumber(),
    dataDir,
    companyDbPath,
    companyDbExists: fs.existsSync(companyDbPath),
    companyDbSizeBytes: statSize(companyDbPath),
    inventoryDbPath,
    inventoryDbExists: fs.existsSync(inventoryDbPath),
    inventoryDbSizeBytes: statSize(inventoryDbPath),
    backupsDir,
    backupCount: backups.length
  };
}

module.exports = { UI_KEYS, DEFAULTS, ensureTable, get, getAll, getUiPrefs, setMany, seedDefaults, getStorageStatus };
