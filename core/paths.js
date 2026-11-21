/**
 * RRE Tally — where company data lives, and the small registry of companies.
 *
 *   <ROOT>/companies.json        registry: which companies exist and which one is active
 *   <ROOT>/<number>/company.db   one database per company (plus its backups/ folder)
 *
 * ROOT is  <app>/data  in development,  %APPDATA%/TallyPrimeGold/data  in the installed app,
 * or RRE_DATA_ROOT (used by tests). The original company keeps its original folder, number 100000.
 */
const fs = require('fs');
const path = require('path');

const isPackaged = __dirname.includes('app.asar');
const DEFAULT_COMPANY = '100000';

function appDataRoot() {
  return process.env.APPDATA || (process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'AppData', 'Roaming') : '.');
}

const ROOT = process.env.RRE_DATA_ROOT
  ? path.resolve(process.env.RRE_DATA_ROOT)
  : isPackaged ? path.join(appDataRoot(), 'TallyPrimeGold', 'data') : path.resolve(__dirname, '..', 'data');

const registryFile = () => path.join(ROOT, 'companies.json');
const companyDir = (number) => path.join(ROOT, String(number));

function readRegistry() {
  try {
    const j = JSON.parse(fs.readFileSync(registryFile(), 'utf8'));
    if (j && Array.isArray(j.companies) && j.companies.length) return j;
  } catch (e) { /* missing or unreadable: treated as "no registry yet" */ }
  return null;
}

/** Atomic write (temp file + rename) so a crash can never leave a half-written registry. */
function writeRegistry(reg) {
  fs.mkdirSync(ROOT, { recursive: true });
  const tmp = registryFile() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(reg, null, 2), 'utf8');
  fs.renameSync(tmp, registryFile());
}

module.exports = { ROOT, DEFAULT_COMPANY, isPackaged, readRegistry, writeRegistry, companyDir, registryFile };
