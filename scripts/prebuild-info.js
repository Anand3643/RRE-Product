const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
let commit = 'local';
try {
  commit = execSync('git rev-parse --short HEAD', { cwd: root }).toString().trim() || commit;
} catch (e) {}

const info = {
  productName: pkg.productName || 'RRE Entries',
  version: pkg.version || '1.0.0',
  commit,
  buildDate: new Date().toISOString(),
  repository: 'https://github.com/Anand3643/RRE-Product',
  setupInstaller: 'dist/RRE Entries Setup 1.0.0.exe'
};

fs.writeFileSync(path.join(root, 'build-info.json'), JSON.stringify(info, null, 2) + '\n', 'utf8');
console.log('[build-info] Updated build-info.json ->', info.commit);
