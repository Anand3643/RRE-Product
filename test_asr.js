process.env.RRE_ENFORCE_AUTH = process.env.RRE_ENFORCE_AUTH || '1'; // these suites verify the server-side login and role checks, which are off by default in the login-free build
/**
 * On-device speech recognition: audio decoding, model install rules, and recognition of REAL recorded speech.
 *
 * Fixtures (test_fixtures/speech):
 *   hi_*, ta_*, te_*, ml_*, kn_*  real human recordings from Google FLEURS (CC BY 4.0), the two shortest per language
 *   en_*                          English commands spoken by a Windows voice
 *   mix_*                         Hindi-English and Tamil-English commands spoken by an English voice
 * Needs a model in <project>/models (install it from the Voice panel, or set RRE_MODEL_DIR). Without one the model tests are
 * skipped and say so; RRE_TEST_DOWNLOAD=1 also tests the real download (about 40 MB).   npm run test:asr
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rre_asr_test_'));
process.env.RRE_DATA_DIR = tmp;
const realModelDir = process.env.RRE_MODEL_DIR || null;
const emptyModels = fs.mkdtempSync(path.join(os.tmpdir(), 'rre_asr_empty_models_'));

const { startServer } = require('./server');
const { initDb, get, all, run } = require('./core/db');
const { runMigrations } = require('./core/migrations');
const { createSessionToken } = require('./core/security');
const asr = require('./core/voice/asr');
const { interpret } = require('./core/voice/nlu');

let passed = 0, failed = 0, skipped = 0;
function assert(cond, name, detail = '') {
  if (cond) { console.log(`  ✅ [PASS] ${name}`); passed++; }
  else { console.error(`  ❌ [FAIL] ${name} ${detail ? '(' + detail + ')' : ''}`); failed++; }
}
const info = (m) => console.log(`  ℹ️  ${m}`);
const FX = path.join(__dirname, 'test_fixtures', 'speech');

function wav16(samples, rate, channels = 1) {
  const b = Buffer.alloc(44 + samples.length * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + samples.length * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(channels, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2 * channels, 28); b.writeUInt16LE(2 * channels, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) b.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), 44 + i * 2);
  return b;
}
const tone = (sec, rate, hz = 440, amp = 0.4) => Float32Array.from({ length: Math.round(sec * rate) }, (_, i) => amp * Math.sin((2 * Math.PI * hz * i) / rate));

/** Similarity of two strings (1 = identical), ignoring punctuation and case. */
function similarity(a, b) {
  const norm = (s) => String(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  const x = norm(a), y = norm(b);
  if (!x.length && !y.length) return 1;
  const prev = Array.from({ length: y.length + 1 }, (_, i) => i);
  for (let i = 1; i <= x.length; i++) { let diag = prev[0]; prev[0] = i; for (let j = 1; j <= y.length; j++) { const t = prev[j]; prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (x[i - 1] === y[j - 1] ? 0 : 1)); diag = t; } }
  return 1 - prev[y.length] / Math.max(x.length, y.length);
}
const SCRIPT = { hi: /[ऀ-ॿ]/, ta: /[஀-௿]/, te: /[ఀ-౿]/, ml: /[ഀ-ൿ]/, kn: /[ಀ-೿]/ };

async function main() {
  await initDb(); await runMigrations();
  const srv = await startServer(12700 + Math.floor(Math.random() * 100), '127.0.0.1');
  const base = `http://${srv.host}:${srv.port}`;
  const T = (id, u, r) => createSessionToken({ id, username: u, role: r });
  const admin = T(1, 'admin', 'Owner'), clerk = T(3, 'dataentry', 'Data Entry');
  const req = (method, p, { token = admin, body, raw, type } = {}) => new Promise((resolve, reject) => {
    const data = raw || (body ? JSON.stringify(body) : null);
    const headers = { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(data ? { 'Content-Type': type || 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}) };
    const r = http.request(base + p, { method, headers }, (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => { let json = null; try { json = JSON.parse(b); } catch (e) {} resolve({ status: res.statusCode, json, raw: b }); }); });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
  const stt = (buf, o = {}) => req('POST', '/api/voice/transcribe' + (o.query || ''), { token: 'token' in o ? o.token : admin, raw: buf, type: o.type || 'audio/wav' });

  console.log('\n--- 1. Audio decoding (no model needed) ---');
  const d1 = asr.decodeAudio(wav16(tone(1, 16000), 16000), 'audio/wav');
  assert(Math.abs(d1.seconds - 1) < 0.01 && !d1.silent, 'A 16 kHz WAV is decoded');
  const d2 = asr.decodeAudio(wav16(tone(2, 44100), 44100), 'audio/wav');
  assert(Math.abs(d2.seconds - 2) < 0.02 && d2.samples.length === 32000, '44.1 kHz audio is resampled to 16 kHz');
  const st = wav16(Float32Array.from({ length: 16000 * 2 }, (_, i) => (i % 2 ? 0.4 * Math.sin(i / 20) : 0)), 16000, 2);
  assert(asr.decodeAudio(st, 'audio/wav').samples.length === 16000, 'Stereo is mixed down to mono');
  const f32 = Buffer.alloc(44 + 16000 * 4); f32.write('RIFF', 0); f32.writeUInt32LE(36 + 64000, 4); f32.write('WAVEfmt ', 8); f32.writeUInt32LE(16, 16); f32.writeUInt16LE(3, 20); f32.writeUInt16LE(1, 22); f32.writeUInt32LE(16000, 24); f32.writeUInt32LE(64000, 28); f32.writeUInt16LE(4, 32); f32.writeUInt16LE(32, 34); f32.write('data', 36); f32.writeUInt32LE(64000, 40);
  for (let i = 0; i < 16000; i++) f32.writeFloatLE(0.3 * Math.sin(i / 10), 44 + i * 4);
  assert(!asr.decodeAudio(f32, 'audio/wav').silent, '32-bit float WAV (the format many recorders produce) is decoded');
  const raw = Buffer.alloc(32000); for (let i = 0; i < 16000; i++) raw.writeInt16LE(Math.round(12000 * Math.sin(i / 9)), i * 2);
  assert(Math.abs(asr.decodeAudio(raw, 'audio/pcm;rate=16000').seconds - 1) < 0.01 && Math.abs(asr.decodeAudio(raw, 'audio/pcm;rate=8000').seconds - 2) < 0.02, 'Raw 16-bit PCM is decoded using its stated rate');
  assert(asr.decodeAudio(wav16(new Float32Array(16000), 16000), 'audio/wav').silent === true, 'Silence is detected');
  const expectErr = (fn, status) => { try { fn(); return false; } catch (e) { return e.status === status; } };
  assert(expectErr(() => asr.decodeAudio(Buffer.from('not audio at all, just text'), 'audio/webm'), 415), 'An unsupported format (e.g. webm) is refused clearly');
  assert(expectErr(() => asr.decodeAudio(Buffer.alloc(0), 'audio/wav'), 400) && expectErr(() => asr.decodeAudio(wav16(tone(0.1, 16000), 16000), 'audio/wav'), 400), 'Empty and too-short recordings are refused');
  assert(expectErr(() => asr.decodeAudio(wav16(tone(31, 16000), 16000), 'audio/wav'), 413), 'A recording over 30 seconds is refused');
  assert(expectErr(() => asr.decodeAudio(Buffer.concat([Buffer.from('RIFF\x24\x00\x00\x00WAVEfmt ', 'binary'), Buffer.alloc(40)]), 'audio/wav'), 400), 'A damaged WAV is refused');

  console.log('\n--- 2. Without a model installed ---');
  process.env.RRE_MODEL_DIR = emptyModels;
  let cap = (await req('GET', '/api/voice/capabilities')).json.data;
  const local = cap.providers.find((p) => p.id === 'local');
  assert(local.available === false && cap.speech_models.installed.length === 0 && cap.speech_models.catalog.length === 3, 'Capabilities say no on-device model is installed and list the choices with sizes and quality notes');
  assert(cap.speech_models.catalog.every((m) => m.size_mb > 0 && m.quality), 'Each model states its download size and what quality to expect');
  assert((await stt(wav16(tone(1, 16000), 16000), { query: '?provider=local' })).status === 409, 'Asking for on-device recognition with no model gives a clear message (409)');
  assert((await req('POST', '/api/voice/model/install', { token: clerk, body: { model: 'small' } })).status === 403, 'Only the Owner can install a model');
  assert((await req('POST', '/api/voice/model/install', { token: null, body: { model: 'small' } })).status === 401, 'Installing needs a login');
  assert((await req('POST', '/api/voice/model/install', { body: { model: 'giant-unknown' } })).status === 400, 'An unknown model name is refused');
  assert((await req('GET', '/api/voice/model', { token: clerk })).json.data.active === null, 'Anyone signed in can see the model status');

  if (process.env.RRE_TEST_DOWNLOAD === '1') {
    console.log('\n--- 2b. Real download of the smallest model ---');
    const ins = await req('POST', '/api/voice/model/install', { body: { model: 'tiny' } });
    assert(ins.status === 200 && ins.json.data.model === 'tiny', 'Install starts');
    assert((await req('POST', '/api/voice/model/install', { body: { model: 'base' } })).status === 409, 'A second install cannot start while one is running');
    let s; for (let i = 0; i < 240; i++) { await new Promise((r) => setTimeout(r, 2000)); s = (await req('GET', '/api/voice/model')).json.data; if (s.installing && s.installing.done) break; }
    assert(s.installing.done && !s.installing.error && s.installed.includes('tiny') && s.active === 'tiny', 'The model downloads and becomes active', JSON.stringify(s.installing));
    const t = await stt(fs.readFileSync(path.join(FX, 'en_open_inventory.wav')));
    assert(t.status === 200 && /inventory/i.test(t.json.data.text) && t.json.data.provider === 'local', 'The downloaded model recognises English speech', t.raw.slice(0, 200));
    assert((await req('POST', '/api/voice/model/install', { body: { model: 'tiny' } })).status === 409, 'Installing a model that is already installed is refused');
  }

  console.log('\n--- 3. Recognition on this computer ---');
  if (realModelDir) process.env.RRE_MODEL_DIR = realModelDir; else delete process.env.RRE_MODEL_DIR;
  const have = asr.status();
  if (!have.active) {
    skipped++;
    console.log('  ⏭  SKIPPED: no on-device model is installed in', asr.modelDir(), '— install one from the Voice panel, then run this again.');
  } else {
    info(`Using model "${have.active}" (${have.catalog.find((m) => m.key === have.active).quality})`);
    const fileCountBefore = (function walk(d) { let n = 0; for (const f of fs.readdirSync(d, { withFileTypes: true })) n += f.isDirectory() ? walk(path.join(d, f.name)) : 1; return n; })(tmp);

    console.log('\n  English commands spoken aloud -> recognised -> executed');
    const EN = [['en_open_inventory', 'navigate', 'Stock Summary'], ['en_low_stock', 'query', 'low_stock'], ['en_sales_month', 'query', 'sales'], ['en_balance_sheet', 'navigate', 'Balance Sheet'], ['en_outstanding', 'navigate', 'Bills Outstandings'], ['en_create_sales', 'create_voucher', 'Create Sales Voucher']];
    for (const [f, kind, target] of EN) {
      const t = await stt(fs.readFileSync(path.join(FX, f + '.wav')));
      const text = t.json?.data?.text || '';
      const ex = await req('POST', '/api/voice/execute', { body: { text } });
      const i = ex.json?.data?.interpretation?.intent || {};
      assert(t.status === 200 && t.json.data.language === 'en' && i.kind === kind && (i.title === target || i.topic === target), `"${f.slice(3)}": heard "${text}" -> ${kind} ${target}`, JSON.stringify({ lang: t.json?.data?.language, i }));
    }

    console.log('\n  Real recordings in Hindi, Tamil, Telugu, Malayalam and Kannada');
    const manifest = JSON.parse(fs.readFileSync(path.join(FX, 'manifest.json'), 'utf8'));
    const scores = {}, langHits = {};
    for (const m of manifest) {
      const t = await stt(fs.readFileSync(path.join(FX, m.file)));
      const d = t.json?.data || {};
      const sim = similarity(d.text || '', m.reference);
      (scores[m.lang] = scores[m.lang] || []).push(sim);
      if (m.lang === 'hi' || m.lang === 'ta') assert(t.status === 200 && d.language === m.lang, `${m.file}: spoken language detected automatically as ${m.lang}`, `got ${d.language} (${JSON.stringify(d.language_candidates)})`);
      else assert(t.status === 200, `${m.file}: recognised without error (language detected: ${d.language}${d.language === m.lang ? '' : ', expected ' + m.lang + ' — known limit of small models for this language'})`, t.raw.slice(0, 200));
      if (t.status === 200 && d.language === m.lang) langHits[m.lang] = (langHits[m.lang] || 0) + 1;
      info(`${m.file} [${d.language}] accuracy ${(sim * 100).toFixed(0)}% — "${(d.text || '').slice(0, 60)}"`);
    }
    for (const lang of ['hi', 'ta']) {
      const best = Math.max(...scores[lang]);
      assert(best >= 0.45, `${lang}: at least one clip is transcribed with reasonable accuracy (best ${(best * 100).toFixed(0)}%)`);
    }
    info(`Language correctly detected on real recordings: ${manifest.reduce((o, m) => (o.includes(m.lang) ? o : [...o, m.lang]), []).map((l) => `${l} ${langHits[l] || 0}/2`).join(', ')}. Accuracy for Telugu, Malayalam and Kannada at this model size is limited; the quality note in the app says so.`);

    console.log('\n  Mixed-language commands spoken by an English voice');
    const MIX = [['mix_hi_stock', 'low_stock'], ['mix_ta_report', 'Day Book'], ['mix_ta_sales', 'sales'], ['mix_ta_out', 'Bills Outstandings']];
    let mixOk = 0;
    for (const [f, target] of MIX) {
      const t = await stt(fs.readFileSync(path.join(FX, f + '.wav')));
      const text = t.json?.data?.text || '';
      const i = interpret(text).intent;
      const ok = i.title === target || i.topic === target;
      if (ok) mixOk++;
      info(`${f}: heard "${text}" (${t.json?.data?.language}) -> ${i.kind} ${i.title || i.topic || ''}${ok ? '' : '  [not matched]'}`);
    }
    assert(mixOk >= 2, `At least half of the mixed-language commands are understood end to end (${mixOk}/4)`);

    console.log('\n  Robustness');
    const sil = await stt(wav16(new Float32Array(16000 * 2), 16000));
    assert(sil.status === 200 && sil.json.data.no_speech === true && sil.json.data.text === '', 'Silence returns "no speech", not an invented command');
    const noise = Float32Array.from({ length: 16000 * 3 }, () => (Math.random() - 0.5) * 0.3);
    const nz = await stt(wav16(noise, 16000));
    const nzi = interpret(nz.json?.data?.text || '').intent.kind;
    assert(nz.status === 200 && (nz.json.data.no_speech || nz.json.data.unreliable || nzi === 'unknown'), 'Random noise never turns into a command', JSON.stringify(nz.json?.data));
    assert((await stt(Buffer.from('this is not audio'), { type: 'audio/webm' })).status === 415, 'Unsupported audio is refused by the API');
    assert((await stt(wav16(tone(1, 16000), 16000), { token: null })).status === 401, 'Recognition needs a login');
    const hinted = await stt(fs.readFileSync(path.join(FX, 'en_open_inventory.wav')), { query: '?language=en' });
    assert(hinted.status === 200 && hinted.json.data.language === 'en' && /inventory/i.test(hinted.json.data.text), 'A language hint is accepted');
    assert((await stt(fs.readFileSync(path.join(FX, 'en_open_inventory.wav')), { query: '?language=../x' })).status === 400, 'A malformed language hint is refused');
    const par = await Promise.all([1, 2, 3].map(() => stt(fs.readFileSync(path.join(FX, 'en_open_inventory.wav')))));
    assert(par.every((r) => r.status === 200 && /inventory/i.test(r.json.data.text)), 'Three simultaneous requests are all answered (processed one at a time)');

    console.log('\n  Privacy');
    const fileCountAfter = (function walk(d) { let n = 0; for (const f of fs.readdirSync(d, { withFileTypes: true })) n += f.isDirectory() ? walk(path.join(d, f.name)) : 1; return n; })(tmp);
    assert(fileCountAfter === fileCountBefore, 'No audio file was written anywhere in the data folder');
    const log = await all(`SELECT action, details FROM activity_log WHERE action = 'VOICE_TRANSCRIBE'`);
    assert(log.length > 5 && log.every((l) => /"provider":"local"/.test(l.details)) && !log.some((l) => /inventory|sales|விற்பனை/i.test(l.details)), 'Each recognition is logged as local, without what was said');
    assert((await req('GET', '/api/voice/prefs')).json.data.cloud_consent === false, 'No online consent was needed or recorded for on-device recognition');
  }

  asr.stopWorker();
  console.log(`\n=== ${passed} passed, ${failed} failed${skipped ? `, ${skipped} section skipped (no model installed)` : ''} ===`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error('FATAL', e); asr.stopWorker(); process.exit(1); });
