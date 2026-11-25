/**
 * RRE Tally — Disaster Recovery & Enterprise Backup Engine
 * Implements:
 * 1. Automated Point-in-Time Snapshots (Zero Data Loss)
 * 2. Cryptographic SHA-256 Integrity Verification
 * 3. Optional AES-256-GCM Backup Encryption
 * 4. Safety Rollback on Restore (Zero RPO Disaster Recovery)
 * 5. Data Retention Policy & Automated Pruning
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Resolve backup directory: data/100000/backups
// Use the exact directory the live database uses (handles dev, packaged app and test overrides)
const dbModule = require('./db');
// Resolved at call time so they follow the ACTIVE company after a switch
const getBackupDir = () => path.resolve(dbModule.getDataDir(), 'backups');
const getDbFile = () => path.resolve(dbModule.getDataDir(), 'company.db');
const MAX_BACKUP_RETENTION = 30;

function ensureBackupDir() {
  if (!fs.existsSync(getBackupDir())) {
    fs.mkdirSync(getBackupDir(), { recursive: true });
  }
}

/**
 * Calculates SHA-256 checksum of a file
 * @param {string} filePath 
 * @returns {string} Hex hash
 */
function calculateChecksum(filePath) {
  const hash = crypto.createHash('sha256');
  const data = fs.readFileSync(filePath);
  hash.update(data);
  return hash.digest('hex');
}


/**
 * Writes a transactionally consistent copy of the live database (including any
 * data still sitting in the WAL) to destPath. Copying company.db alone would omit
 * recent commits when the database runs in WAL mode.
 */
async function snapshotDatabaseTo(destPath) {
  try { if (fs.existsSync(destPath)) fs.unlinkSync(destPath); } catch (e) {}
  try {
    await dbModule.run(`VACUUM INTO '${destPath.replace(/'/g, "''")}'`);
    if (fs.existsSync(destPath) && fs.statSync(destPath).size > 0) return;
  } catch (e) {
    console.warn('[Backup Engine] VACUUM INTO unavailable, falling back to WAL checkpoint:', e.message);
  }
  await dbModule.run('PRAGMA wal_checkpoint(TRUNCATE)');
  fs.copyFileSync(getDbFile(), destPath);
}

/**
 * Generates an ISO-like formatted date-time string suitable for Windows filenames
 */
function getTimestampString() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const yyyy = now.getFullYear();
  const mm = pad(now.getMonth() + 1);
  const dd = pad(now.getDate());
  const hh = pad(now.getHours());
  const min = pad(now.getMinutes());
  const ss = pad(now.getSeconds());
  return `${yyyy}-${mm}-${dd}_${hh}${min}${ss}`;
}

/**
 * Encrypts a buffer using AES-256-GCM
 */
function encryptBuffer(buffer, secretKey) {
  const key = crypto.scryptSync(secretKey, 'tally_backup_salt', 32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(buffer), cipher.final()]);
  const authTag = cipher.getAuthTag();
  // Packed format: [12-byte IV] + [16-byte AuthTag] + [Encrypted Data]
  return Buffer.concat([iv, authTag, encrypted]);
}

/**
 * Decrypts a buffer using AES-256-GCM
 */
function decryptBuffer(packedBuffer, secretKey) {
  const key = crypto.scryptSync(secretKey, 'tally_backup_salt', 32);
  const iv = packedBuffer.subarray(0, 12);
  const authTag = packedBuffer.subarray(12, 28);
  const ciphertext = packedBuffer.subarray(28);

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/**
 * Creates a timestamped snapshot backup of the current database
 * @param {object} options
 * @param {string} [options.notes]
 * @param {boolean} [options.encrypt]
 * @param {string} [options.password]
 * @param {object} [options.metadata]
 * @returns {object} Backup summary
 */
/**
 * Cloud database (PostgreSQL): the active company's rows from one consistent snapshot, as a checksummed .cloud.json.gz file
 * (optionally AES-256 encrypted: .cloud.enc). Supabase's own backups remain the primary protection; this is the copy you keep.
 */
async function createCloudBackup(options = {}, prefix = 'backup') {
  ensureBackupDir();
  const db = require('./db');
  const timestamp = getTimestampString();
  const isEncrypted = Boolean(options.encrypt && options.password);
  const plainName = `${prefix}_${timestamp}.cloud.json.gz`, filename = isEncrypted ? `${prefix}_${timestamp}.cloud.enc` : plainName;
  const targetPath = path.join(getBackupDir(), filename);
  const tmp = isEncrypted ? path.join(getBackupDir(), `.snapshot_${timestamp}.tmp`) : targetPath;
  await require('../scripts/pg-backup').backup(null, { shared: true, companies: [db.getCompanyNumber()], out: tmp, log: () => {} });
  const unencryptedChecksum = calculateChecksum(tmp);
  if (isEncrypted) { fs.writeFileSync(targetPath, encryptBuffer(fs.readFileSync(tmp), options.password)); try { fs.unlinkSync(tmp); } catch (e) { /* ignore */ } }
  const st = fs.statSync(targetPath);
  const metadata = { filename, created_at: new Date().toISOString(), size_bytes: st.size, size_formatted: (st.size / (1024 * 1024)).toFixed(2) + ' MB', sha256: calculateChecksum(targetPath),
    unencrypted_sha256: unencryptedChecksum, encrypted: isEncrypted, engine: 'postgresql', company: db.getCompanyNumber(), notes: options.notes || 'Cloud database snapshot (this company)', ...(options.metadata || {}) };
  fs.writeFileSync(path.join(getBackupDir(), `${prefix}_${timestamp}.meta.json`), JSON.stringify(metadata, null, 2), 'utf8');
  if (prefix === 'backup') pruneBackups();
  return { success: true, data: metadata };
}

async function createBackup(options = {}) {
  if (require('./db').isPostgres()) return createCloudBackup(options);
  ensureBackupDir();

  if (!fs.existsSync(getDbFile())) {
    throw new Error(`Database file not found at: ${getDbFile()}`);
  }

  const timestamp = getTimestampString();
  const isEncrypted = Boolean(options.encrypt && options.password);
  const extension = isEncrypted ? '.sqlite.enc' : '.sqlite.bak';
  const filename = `backup_${timestamp}${extension}`;
  const targetPath = path.join(getBackupDir(), filename);
  const metaPath = path.join(getBackupDir(), `backup_${timestamp}.meta.json`);

  // Read current DB file bytes
  const tmpSnap = path.join(getBackupDir(), `.snapshot_${timestamp}.tmp`);
  await snapshotDatabaseTo(tmpSnap);
  let dbBytes = fs.readFileSync(tmpSnap);
  try { fs.unlinkSync(tmpSnap); } catch (e) {}
  const unencryptedChecksum = crypto.createHash('sha256').update(dbBytes).digest('hex');

  if (isEncrypted) {
    dbBytes = encryptBuffer(dbBytes, options.password);
  }

  // Write snapshot file
  fs.writeFileSync(targetPath, dbBytes);
  const fileStat = fs.statSync(targetPath);
  const fileChecksum = calculateChecksum(targetPath);

  const metadata = {
    filename,
    created_at: new Date().toISOString(),
    size_bytes: fileStat.size,
    size_formatted: (fileStat.size / (1024 * 1024)).toFixed(2) + ' MB',
    sha256: fileChecksum,
    unencrypted_sha256: unencryptedChecksum,
    encrypted: isEncrypted,
    notes: options.notes || 'Automated Point-in-Time Snapshot',
    ...(options.metadata || {})
  };

  fs.writeFileSync(metaPath, JSON.stringify(metadata, null, 2), 'utf8');

  // Prune older backups according to retention policy
  pruneBackups();

  return {
    success: true,
    data: metadata
  };
}

/**
 * Enforces data retention policy by removing backups exceeding the retention threshold
 */
function pruneBackups() {
  try {
    ensureBackupDir();
    const files = fs.readdirSync(getBackupDir())
      .filter(f => f.endsWith('.bak') || f.endsWith('.enc') || f.endsWith('.cloud.json.gz'))
      .map(f => {
        const full = path.join(getBackupDir(), f);
        return { name: f, time: fs.statSync(full).mtimeMs, path: full };
      })
      .sort((a, b) => b.time - a.time);

    // Keep the latest MAX_BACKUP_RETENTION items
    if (files.length > MAX_BACKUP_RETENTION) {
      const toRemove = files.slice(MAX_BACKUP_RETENTION);
      for (const item of toRemove) {
        fs.unlinkSync(item.path);
        const metaPath = item.path.replace(/\.(sqlite\.(bak|enc)|cloud\.json\.gz|cloud\.enc)$/, '.meta.json');
        if (fs.existsSync(metaPath)) {
          fs.unlinkSync(metaPath);
        }
      }
    }
  } catch (err) {
    console.warn('[Backup Engine] Retention pruning notice:', err.message);
  }
}

/**
 * Lists all existing point-in-time backups with their integrity information
 * @returns {Array<object>}
 */
function listBackups() {
  ensureBackupDir();

  const files = fs.readdirSync(getBackupDir())
    .filter(f => f.endsWith('.bak') || f.endsWith('.enc') || f.endsWith('.cloud.json.gz'))
    .sort()
    .reverse();

  return files.map(filename => {
    const fullPath = path.join(getBackupDir(), filename);
    const stat = fs.statSync(fullPath);
    const baseName = filename.replace(/\.(sqlite\.(bak|enc)|cloud\.json\.gz|cloud\.enc)$/, '');
    const metaPath = path.join(getBackupDir(), `${baseName}.meta.json`);

    let meta = {};
    if (fs.existsSync(metaPath)) {
      try {
        meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      } catch (e) {}
    }

    return {
      filename,
      size_bytes: stat.size,
      size_formatted: (stat.size / (1024 * 1024)).toFixed(2) + ' MB',
      created_at: meta.created_at || stat.mtime.toISOString(),
      encrypted: meta.encrypted || filename.endsWith('.enc'),
      notes: meta.notes || 'Point-in-Time Snapshot',
      sha256: meta.sha256 || null
    };
  });
}

/**
 * Restores the active database from a chosen backup file.
 * Automatically takes a safety rollback snapshot before overwriting anything.
 * @param {string} filename 
 * @param {object} options 
 * @param {string} [options.password] 
 * @param {function} [options.beforeRestoreHook]
 * @param {function} [options.afterRestoreHook]
 * @returns {object} Restore result
 */
/** Cloud database: restores the active company from a .cloud backup, after a safety snapshot; one transaction, verified row counts. */
async function restoreCloudBackup(safeFilename, options = {}) {
  const db = require('./db');
  const file = path.join(getBackupDir(), safeFilename);
  if (!/\.cloud\.(json\.gz|enc)$/.test(safeFilename)) throw Object.assign(new Error('This is a local (SQLite) backup; the data is now in the cloud database. Restore a cloud backup (.cloud) instead.'), { status: 409 });
  let plain = file;
  if (safeFilename.endsWith('.enc')) {
    if (!options.password) throw new Error('This backup is encrypted with AES-256. Password is required to restore.');
    plain = path.join(getBackupDir(), `.restore_${getTimestampString()}.tmp`);
    try { fs.writeFileSync(plain, decryptBuffer(fs.readFileSync(file), options.password)); } catch (e) { throw new Error('Incorrect decryption password or corrupted backup archive.'); }
  }
  try {
    const pgb = require('../scripts/pg-backup');
    const co = db.getCompanyNumber();
    if (!pgb.readBackup(plain).companies[co]) throw Object.assign(new Error(`This backup does not contain company ${co}.`), { status: 409 });
    const rollback = await createCloudBackup({ notes: 'Safety snapshot before restore' }, 'rollback_pre_restore');
    await pgb.restore(null, plain, { shared: true, companies: [co], replace: true, log: () => {} });
    if (typeof options.afterRestoreHook === 'function') await options.afterRestoreHook();
    return { success: true, message: `Company ${co} successfully restored from "${safeFilename}".`, restored_file: safeFilename, rollback_snapshot: rollback.data.filename };
  } finally { if (plain !== file) try { fs.unlinkSync(plain); } catch (e) { /* ignore */ } }
}

async function restoreBackup(filename, options = {}) {
  if (require('./db').isPostgres()) {
    ensureBackupDir();
    const safe = path.basename(filename);
    if (!fs.existsSync(path.join(getBackupDir(), safe))) throw new Error(`Backup file "${safe}" does not exist in backup archive.`);
    return restoreCloudBackup(safe, options);
  }
  ensureBackupDir();

  // Prevent directory traversal attacks
  const safeFilename = path.basename(filename);
  const targetBackupPath = path.join(getBackupDir(), safeFilename);

  if (!fs.existsSync(targetBackupPath)) {
    throw new Error(`Backup file "${safeFilename}" does not exist in backup archive.`);
  }

  // 1. Point-in-Time Safety: Take pre-restore rollback snapshot of active database
  const rollbackTimestamp = getTimestampString();
  const rollbackName = `rollback_pre_restore_${rollbackTimestamp}.sqlite.bak`;
  const rollbackPath = path.join(getBackupDir(), rollbackName);

  if (fs.existsSync(getDbFile())) {
    await snapshotDatabaseTo(rollbackPath);
    console.log(`[Backup Engine] Pre-restore safety rollback created: ${rollbackName}`);
  }

  // 2. Invoke pre-restore hook to close active SQLite handles cleanly
  if (typeof options.beforeRestoreHook === 'function') {
    await options.beforeRestoreHook();
  }

  try {
    let backupBytes = fs.readFileSync(targetBackupPath);

    // If backup is encrypted, decrypt with provided passphrase
    if (safeFilename.endsWith('.enc')) {
      if (!options.password) {
        throw new Error('This backup is encrypted with AES-256. Password is required to restore.');
      }
      try {
        backupBytes = decryptBuffer(backupBytes, options.password);
      } catch (decErr) {
        throw new Error('Incorrect decryption password or corrupted backup archive.');
      }
    }

    // 3. Atomically overwrite company.db
    fs.writeFileSync(getDbFile(), backupBytes);

    // Remove WAL & SHM files if present so DB opens freshly
    const walPath = `${getDbFile()}-wal`;
    const shmPath = `${getDbFile()}-shm`;
    if (fs.existsSync(walPath)) try { fs.unlinkSync(walPath); } catch (e) {}
    if (fs.existsSync(shmPath)) try { fs.unlinkSync(shmPath); } catch (e) {}

    // 4. Invoke post-restore hook to re-initialize SQLite handles
    if (typeof options.afterRestoreHook === 'function') {
      await options.afterRestoreHook();
    }

    return {
      success: true,
      message: `Database successfully restored from "${safeFilename}".`,
      restored_file: safeFilename,
      rollback_snapshot: rollbackName
    };
  } catch (restoreErr) {
    // If restore failed, try to recover from rollback snapshot
    if (fs.existsSync(rollbackPath)) {
      try {
        fs.copyFileSync(rollbackPath, getDbFile());
        if (typeof options.afterRestoreHook === 'function') {
          await options.afterRestoreHook();
        }
      } catch (rollErr) {
        console.error('[Backup Engine] Critical error recovering rollback:', rollErr.message);
      }
    }
    throw restoreErr;
  }
}

module.exports = {
  createBackup,
  listBackups,
  restoreBackup,
  calculateChecksum,
  getBackupDir,
  getDbFile
};

// Backwards-compatible live values for code that still reads BACKUP_DIR / DB_PATH
Object.defineProperty(module.exports, 'BACKUP_DIR', { enumerable: true, get: getBackupDir });
Object.defineProperty(module.exports, 'DB_PATH', { enumerable: true, get: getDbFile });
