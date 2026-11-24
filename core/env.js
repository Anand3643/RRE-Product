/**
 * RRE Entries — loads settings from a local ".env" file (never committed: see .gitignore) into process.env.
 * Real environment variables always win. Secrets such as the Gmail app password live ONLY here or in the real environment:
 * they are never stored in the database, never sent to the browser and never written to logs.
 */
const fs = require('fs');
const path = require('path');

function parse(text) {
  const out = {};
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    else val = val.replace(/\s+#.*$/, '');
    out[key] = val;
  }
  return out;
}

function load(file) {
  const f = file || process.env.RRE_ENV_FILE || path.resolve(__dirname, '..', '.env');
  try {
    if (!fs.existsSync(f)) return { loaded: false, file: f };
    const vars = parse(fs.readFileSync(f, 'utf8'));
    let n = 0;
    for (const [k, v] of Object.entries(vars)) if (process.env[k] === undefined) { process.env[k] = v; n++; }
    return { loaded: true, file: f, count: n };
  } catch (e) { return { loaded: false, file: f, error: e.message }; }
}

module.exports = { load, parse };
