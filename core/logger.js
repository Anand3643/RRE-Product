/**
 * RRE Tally — Enterprise System Logger & Observability Engine
 * Provides structured logging, audit trails, in-memory telemetry, and file retention.
 */

const fs = require('fs');
const path = require('path');

const LOG_DIR = path.join(__dirname, '..', 'data');
const LOG_FILE = path.join(LOG_DIR, 'system.log');
const MAX_IN_MEMORY_LOGS = 250;
const MAX_LOG_FILE_SIZE = 10 * 1024 * 1024; // 10MB

// In-memory ring buffer for live health & audit queries
const inMemoryLogs = [];

function ensureLogDir() {
  try {
    if (!fs.existsSync(LOG_DIR)) {
      fs.mkdirSync(LOG_DIR, { recursive: true });
    }
  } catch (e) {}
}

function writeToFile(line) {
  try {
    ensureLogDir();
    // Rotate if exceeds limit
    if (fs.existsSync(LOG_FILE)) {
      const stats = fs.statSync(LOG_FILE);
      if (stats.size > MAX_LOG_FILE_SIZE) {
        fs.renameSync(LOG_FILE, path.join(LOG_DIR, `system-${Date.now()}.log`));
      }
    }
    fs.appendFileSync(LOG_FILE, line + '\n', 'utf8');
  } catch (e) {
    // Graceful fallback if filesystem is read-only
  }
}

function log(level, message, meta = null) {
  const timestamp = new Date().toISOString();
  const entry = {
    timestamp,
    level,
    message,
    ...(meta && typeof meta === 'object' ? meta : meta ? { detail: String(meta) } : {})
  };

  // Push to memory ring buffer
  inMemoryLogs.push(entry);
  if (inMemoryLogs.length > MAX_IN_MEMORY_LOGS) {
    inMemoryLogs.shift();
  }

  // Format line
  const metaStr = meta ? ` ${JSON.stringify(meta)}` : '';
  const formattedLine = `[${timestamp}] [${level}] ${message}${metaStr}`;

  // Console output
  if (level === 'ERROR') {
    console.error(formattedLine);
  } else if (level === 'WARN') {
    console.warn(formattedLine);
  } else {
    console.log(formattedLine);
  }

  // File output
  writeToFile(formattedLine);
  return entry;
}

const logger = {
  info: (msg, meta) => log('INFO', msg, meta),
  warn: (msg, meta) => log('WARN', msg, meta),
  error: (msg, meta) => log('ERROR', msg, meta),
  audit: (msg, meta) => log('AUDIT', msg, meta),
  metric: (msg, meta) => log('METRIC', msg, meta),
  getRecentLogs: (limit = 100) => {
    return inMemoryLogs.slice(-Math.min(limit, inMemoryLogs.length));
  },
  requestMiddleware: (req, res, next) => {
    const start = process.hrtime.bigint();
    const { method, url } = req;

    res.on('finish', () => {
      const end = process.hrtime.bigint();
      const durationMs = Number(end - start) / 1e6;
      const statusCode = res.statusCode;

      // Filter out high-frequency poll noise for clean logs
      if (!url.startsWith('/api/system/update-status')) {
        const level = statusCode >= 500 ? 'ERROR' : statusCode >= 400 ? 'WARN' : 'INFO';
        logger.metric(`${method} ${url} ${statusCode} - ${durationMs.toFixed(2)}ms`, {
          method,
          url,
          statusCode,
          durationMs: parseFloat(durationMs.toFixed(2))
        });
      }
    });

    next();
  }
};

module.exports = logger;
