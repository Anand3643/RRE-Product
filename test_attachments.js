process.env.RRE_ENFORCE_AUTH = process.env.RRE_ENFORCE_AUTH || '1'; // these suites verify the server-side login and role checks, which are off by default in the login-free build
/**
 * Voucher attachments: validation by file contents, safe downloads, access control, backup & cascade.
 * Runs against a DISPOSABLE data directory.   npm run test:attachments
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const sqlite3 = require('sqlite3');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rre_attach_test_'));
process.env.RRE_DATA_DIR = tmp;

const { startServer } = require('./server');
const { initDb, get, all } = require('./core/db');
const { runMigrations } = require('./core/migrations');
const { createSessionToken } = require('./core/security');
const { createBackup } = require('./core/backupEngine');

let passed = 0, failed = 0;
function assert(cond, name, detail = '') {
  if (cond) { console.log(`  ✅ [PASS] ${name}`); passed++; }
  else { console.error(`  ❌ [FAIL] ${name} ${detail ? '(' + detail + ')' : ''}`); failed++; }
}

async function main() {
  await initDb(); await runMigrations();
  const info = await startServer(9000 + Math.floor(Math.random() * 150), '127.0.0.1');
  const base = `http://${info.host}:${info.port}`;
  const T = (id, u, r) => createSessionToken({ id, username: u, role: r });
  const admin = T(1, 'admin', 'Owner'), acc = T(2, 'accountant', 'Accountant'), clerk = T(3, 'dataentry', 'Data Entry'), auditor = T(4, 'auditor', 'Auditor'), viewer = T(5, 'viewer', 'Viewer');

  const raw = (method, p, { token = admin, body } = {}) => new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request(base + p, { method, headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}) } }, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c));
      res.on('end', () => { const buf = Buffer.concat(chunks); let json = null; try { json = JSON.parse(buf.toString('utf8')); } catch (e) {} resolve({ status: res.statusCode, json, buf, headers: res.headers }); });
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
  const up = (vid, filename, buf, token) => raw('POST', `/api/attachments/voucher/${vid}`, { token, body: { filename, content_base64: Buffer.isBuffer(buf) ? buf.toString('base64') : buf } });

  const L = async (n) => (await get('SELECT id FROM ledgers WHERE name = ?', [n])).id;
  const mkVoucher = async (no) => (await raw('POST', '/api/vouchers', { body: { voucher_type: 'Contra', voucher_no: no, date: '2026-06-01', entries: [{ ledger_id: await L('Cash'), debit_amount: 5 }, { ledger_id: await L('HDFC Bank Current A/c'), credit_amount: 5 }] } })).json.id;
  const v1 = await mkVoucher('AT/1'), v2 = await mkVoucher('AT/2');

  const FILES = {
    'invoice.pdf': Buffer.concat([Buffer.from('%PDF-1.4\n'), crypto.randomBytes(200)]),
    'scan.png': Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), crypto.randomBytes(300)]),
    'photo.JPEG': Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(300)]),
    'bill.webp': Buffer.concat([Buffer.from('RIFF'), Buffer.from([1, 2, 3, 4]), Buffer.from('WEBP'), crypto.randomBytes(100)]),
    'sheet.xlsx': Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), crypto.randomBytes(200)]),
    'data.csv': Buffer.from('a,b\n1,2\n₹,3\n', 'utf8'),
    'note.txt': Buffer.from('Cheque handed over on Monday. ₹5', 'utf8')
  };

  console.log('\n--- 1. Upload, list, download round-trip ---');
  const ids = {};
  for (const [name, buf] of Object.entries(FILES)) {
    const r = await up(v1, name, buf);
    assert(r.status === 200 && r.json.data.size_bytes === buf.length, `Uploaded ${name} (${buf.length} bytes)`, r.buf.toString().slice(0, 150));
    ids[name] = r.json.data.id;
  }
  const lst = (await raw('GET', `/api/attachments/voucher/${v1}`, { token: viewer })).json.data;
  assert(lst.length === 7 && lst.every((a) => a.sha256.length === 64 && a.uploaded_by === 'admin'), 'Listing shows all seven files with hashes and uploader (read-only roles may list)');
  assert(lst.find((a) => a.filename === 'photo.JPEG').mime === 'image/jpeg', 'Upper-case .JPEG recognised as image/jpeg');
  for (const [name, buf] of Object.entries(FILES)) {
    const d = await raw('GET', `/api/attachments/${ids[name]}/download`, { token: auditor });
    assert(d.status === 200 && d.buf.equals(buf), `Download returns identical bytes: ${name}`);
  }
  const dh = await raw('GET', `/api/attachments/${ids['invoice.pdf']}/download`);
  assert(dh.headers['content-type'] === 'application/pdf' && /^attachment;/.test(dh.headers['content-disposition']) && dh.headers['x-content-type-options'] === 'nosniff' && /sandbox/.test(dh.headers['content-security-policy']), 'Served as attachment with nosniff and a sandbox CSP (never rendered inline)');
  const dt = await raw('GET', `/api/attachments/${ids['note.txt']}/download`);
  assert(dt.headers['content-type'] === 'text/plain', 'Text is always served as text/plain');

  console.log('\n--- 2. Rejections ---');
  const png = FILES['scan.png'];
  assert((await up(v2, 'fake.pdf', png)).status === 400, 'PNG bytes named .pdf rejected (contents must match the extension)');
  assert((await up(v2, 'page.html', Buffer.from('<script>alert(1)</script>'))).status === 400, '.html not allowed');
  assert((await up(v2, 'logo.svg', Buffer.from('<svg onload="alert(1)"/>'))).status === 400, '.svg not allowed (can carry scripts)');
  assert((await up(v2, 'run.exe', Buffer.from('MZ....'))).status === 400, '.exe not allowed');
  assert((await up(v2, 'noext', Buffer.from('hello'))).status === 400 && (await up(v2, '.pdf', FILES['invoice.pdf'])).status === 400, 'Missing extension / hidden-file names rejected');
  assert((await up(v2, 'bin.txt', Buffer.from([0, 1, 2, 3, 0xff, 0xfe]))).status === 400, 'Binary data named .txt rejected');
  assert((await up(v2, 'bad.csv', Buffer.from([0xc3, 0x28, 0x41]))).status === 400, 'Invalid UTF-8 named .csv rejected');
  assert((await up(v2, 'a.pdf', '')).status === 400 && (await up(v2, 'a.pdf', '!!!not base64!!!')).status === 400, 'Empty / non-base64 content rejected');
  const big = Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(6 * 1024 * 1024)]);
  assert((await up(v2, 'big.pdf', big)).status === 413, 'A 6 MB file is refused (limit 5 MB)');
  const okMax = Buffer.concat([Buffer.from('%PDF-'), crypto.randomBytes(4.9 * 1024 * 1024)]);
  assert((await up(v2, 'max.pdf', okMax)).status === 200, 'A 4.9 MB file is accepted');
  assert((await up(v1, 'copy.pdf', FILES['invoice.pdf'])).status === 409, 'The same file content cannot be attached twice to one voucher');
  assert((await up(v2, 'invoice.pdf', FILES['invoice.pdf'])).status === 200, '…but the same file may be attached to a different voucher');
  assert((await up(99999, 'x.pdf', FILES['invoice.pdf'])).status === 404, 'Unknown voucher -> 404');
  const trav = await up(v2, '../../etc/pass"wd\u0001.csv', Buffer.from('x,y\n1,2\n'));
  assert(trav.status === 200 && trav.json.data.filename === 'passwd.csv', 'Path parts, quotes and control characters are stripped from the name', trav.json?.data?.filename);
  let n = 0; let last;
  for (let i = 0; i < 20; i++) { last = await up(v2, `f${i}.txt`, Buffer.from('file ' + i)); if (last.status === 200) n++; }
  assert((await get('SELECT COUNT(*) c FROM voucher_attachments WHERE voucher_id = ?', [v2])).c === 20 && last.status === 400, 'A voucher is limited to 20 attachments', `${n} accepted`);

  console.log('\n--- 3. Access control ---');
  assert((await raw('GET', `/api/attachments/voucher/${v1}`, { token: null })).status === 401 && (await raw('GET', `/api/attachments/${ids['note.txt']}/download`, { token: null })).status === 401, 'Listing and download require login');
  assert((await up(v1, 'v.txt', Buffer.from('v'), viewer)).status === 403 && (await up(v1, 'a.txt', Buffer.from('a'), auditor)).status === 403, 'Viewer and Auditor cannot upload');
  assert((await up(v1, 'c.txt', Buffer.from('clerk file'), clerk)).status === 200, 'Data Entry can upload');
  const clerkFile = (await raw('GET', `/api/attachments/voucher/${v1}`)).json.data.find((a) => a.filename === 'c.txt').id;
  assert((await raw('DELETE', `/api/attachments/${clerkFile}`, { token: clerk })).status === 403, 'Data Entry cannot delete (no edit permission)');
  assert((await raw('DELETE', `/api/attachments/${clerkFile}`, { token: viewer })).status === 403, 'Viewer cannot delete');
  assert((await raw('DELETE', `/api/attachments/${clerkFile}`, { token: acc })).status === 200, 'Accountant can delete');
  assert((await get('SELECT COUNT(*) c FROM voucher_attachment_data WHERE attachment_id = ?', [clerkFile])).c === 0, 'Deleting removes the stored bytes too');
  assert((await raw('DELETE', `/api/attachments/${clerkFile}`)).status === 404 && (await raw('GET', `/api/attachments/${clerkFile}/download`)).status === 404, 'Deleted attachment -> 404');
  const log = (await raw('GET', '/api/platform/activity-log?limit=100')).json.data;
  assert(log.some((l) => l.action === 'ATTACHMENT_ADD' && l.username === 'dataentry') && log.some((l) => l.action === 'ATTACHMENT_DELETE' && l.username === 'accountant'), 'Uploads and deletions are in the activity log');

  console.log('\n--- 4. Backups include attachments; vouchers cascade ---');
  const before = (await get('SELECT COUNT(*) c FROM voucher_attachment_data')).c;
  const bk = await createBackup({ notes: 'attachments test' });
  const snap = path.join(tmp, 'backups', bk.data.filename);
  const copy = path.join(tmp, 'snap_copy.sqlite'); fs.copyFileSync(snap, copy);
  const sdb = await new Promise((res, rej) => { const d = new sqlite3.Database(copy, sqlite3.OPEN_READONLY, (e) => (e ? rej(e) : res(d))); });
  const row = await new Promise((res, rej) => sdb.get('SELECT COUNT(*) c, SUM(LENGTH(data)) s FROM voucher_attachment_data', (e, r) => (e ? rej(e) : res(r))));
  const live = await get('SELECT COUNT(*) c, SUM(LENGTH(data)) s FROM voucher_attachment_data');
  sdb.close();
  assert(row.c === before && row.s === live.s, `Backup snapshot contains all ${before} attachments (${live.s} bytes)`, JSON.stringify(row));
  const del = await raw('DELETE', `/api/vouchers/${v1}`);
  assert(del.status === 200 && (await get('SELECT COUNT(*) c FROM voucher_attachments WHERE voucher_id = ?', [v1])).c === 0, 'Deleting a voucher deletes its attachments');
  assert((await get('SELECT COUNT(*) c FROM voucher_attachment_data WHERE attachment_id NOT IN (SELECT id FROM voucher_attachments)')).c === 0, 'No orphaned file data remains');
  const dr = (await get('SELECT ROUND(SUM(debit_amount),2) s FROM ledger_entries')).s, cr = (await get('SELECT ROUND(SUM(credit_amount),2) s FROM ledger_entries')).s;
  assert(dr === cr, 'Total Dr == total Cr', `${dr}/${cr}`);
  assert((await get('SELECT COUNT(*) c FROM schema_migrations')).c === 15, 'Migration 007 recorded');
  void all;

  console.log('\n====================================================');
  console.log(`📊 ATTACHMENT RESULTS: ${passed} PASSED | ${failed} FAILED`);
  console.log('====================================================');
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error('Test run crashed:', e); process.exit(2); });
