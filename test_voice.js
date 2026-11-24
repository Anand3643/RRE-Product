process.env.RRE_LEGACY_TOKENS = '1'; // these suites mint tokens directly; the unified-auth suite (test_auth_unified.js) runs without this
process.env.RRE_ENFORCE_AUTH = process.env.RRE_ENFORCE_AUTH || '1'; // these suites verify the server-side login and role checks, which are off by default in the login-free build
/**
 * Multilingual voice assistant: language identification, command understanding, replies, permissions, consent and privacy.
 * It tests everything from TRANSCRIPTS (what a speech provider would return). It cannot test how well a provider recognises real
 * audio in a given language — see the report.   npm run test:voice
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rre_voice_test_'));
process.env.RRE_DATA_DIR = tmp;
delete process.env.RRE_STT_ENDPOINT;
process.env.RRE_MODEL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rre_voice_models_')); // these tests cover the online-provider rules, so no on-device model may be present

const { startServer } = require('./server');
const { initDb, get, all, run } = require('./core/db');
const { runMigrations } = require('./core/migrations');
const { createSessionToken } = require('./core/security');

let passed = 0, failed = 0;
function assert(cond, name, detail = '') {
  if (cond) { console.log(`  ✅ [PASS] ${name}`); passed++; }
  else { console.error(`  ❌ [FAIL] ${name} ${detail ? '(' + detail + ')' : ''}`); failed++; }
}

async function main() {
  await initDb(); await runMigrations();
  const info = await startServer(12100 + Math.floor(Math.random() * 100), '127.0.0.1');
  const base = `http://${info.host}:${info.port}`;
  const T = (id, u, r) => createSessionToken({ id, username: u, role: r });
  const admin = T(1, 'admin', 'Owner'), clerk = T(3, 'dataentry', 'Data Entry'), viewer = T(5, 'viewer', 'Viewer'), acc = T(2, 'accountant', 'Accountant');
  const req = (method, p, { token = admin, body, raw, type } = {}) => new Promise((resolve, reject) => {
    const data = raw ? raw : body ? JSON.stringify(body) : null;
    const headers = { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(data ? { 'Content-Type': type || 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}) };
    const r = http.request(base + p, { method, headers }, (res) => {
      let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => { let json = null; try { json = JSON.parse(b); } catch (e) {} resolve({ status: res.statusCode, json, raw: b }); });
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
  const exec = (text, o = {}) => req('POST', '/api/voice/execute', { token: o.token || admin, body: { text, context: o.context, confirmed: o.confirmed } });
  const understand = async (text, context) => (await req('POST', '/api/voice/interpret', { body: { text, context } })).json.data;
  const vcount = async () => (await get('SELECT COUNT(*) c FROM vouchers')).c;
  const v0 = await vcount();

  console.log('\n--- 1. Capabilities are honest ---');
  const cap = (await req('GET', '/api/voice/capabilities')).json.data;
  assert(cap.understands.length >= 18 && ['en', 'ta', 'hi', 'te', 'ml', 'kn', 'bn', 'mr', 'gu', 'pa', 'ur', 'ar', 'fr', 'de', 'es', 'zh', 'ja', 'ko'].every((c) => cap.understands.some((l) => l.code === c)), 'Every language in the brief is understood (and the list is longer than English/Tamil/Hindi)');
  const prov = Object.fromEntries(cap.providers.map((p) => [p.id, p]));
  assert(prov.typed.available && prov.typed.sends_audio === false, 'Typed input is always available and sends no audio');
  assert(prov.cloud.available === false && prov.local.available === false, 'No online or on-device speech provider is claimed to be active until one is configured');
  assert(prov.browser.auto_language === false && /does not detect the language/.test(prov.browser.note), 'Browser recognition is described as NOT auto-detecting language');
  assert(cap.notes.some((n) => /depends on the speech provider/.test(n)) && cap.notes.some((n) => /never saves accounting entries/.test(n)), 'Capabilities state the limits and that voice never saves entries');
  assert(cap.reply_languages.length === 20, 'Replies are available in all 18 languages');
  for (const p of ['capabilities', 'prefs']) assert((await req('GET', '/api/voice/' + p, { token: null })).status === 401, `${p}: needs a login`);
  assert((await req('POST', '/api/voice/execute', { token: null, body: { text: 'open inventory' } })).status === 401 && (await req('POST', '/api/voice/transcribe', { token: null, raw: Buffer.from('x'), type: 'audio/webm' })).status === 401, 'execute and transcribe need a login');

  console.log('\n--- 2. English commands ---');
  let r = (await exec('Open inventory')).json.data;
  assert(r.status === 'ok' && r.action.type === 'navigate' && r.action.title === 'Stock Summary' && r.language.reply === 'en' && /Opening/.test(r.reply), 'Open inventory -> Stock Summary, English reply');
  r = (await exec('show me the balance sheet')).json.data;
  assert(r.action && r.action.title === 'Balance Sheet', 'Show balance sheet');
  r = (await exec('how much is the total sales this month')).json.data;
  assert(r.status === 'ok' && r.action.type === 'answer' && r.action.topic === 'sales' && /sales/i.test(r.action.answer), 'Sales question is answered by the existing assistant');

  console.log('\n--- 3. Each language: "open the balance sheet" and "sales this month?" ---');
  const NAV = { en: 'open balance sheet', ta: 'இருப்புநிலைக் குறிப்பு காட்டு', hi: 'बैलेंस शीट खोलो', te: 'బ్యాలెన్స్ షీట్ చూపించు', ml: 'ബാലൻസ് ഷീറ്റ് കാണിക്കൂ', kn: 'ಬ್ಯಾಲೆನ್ಸ್ ಶೀಟ್ ತೋರಿಸು', bn: 'ব্যালেন্স শিট দেখাও', mr: 'ताळेबंद दाखवा', gu: 'સરવૈયું બતાવો', pa: 'ਬੈਲੇਂਸ ਸ਼ੀਟ ਦਿਖਾਓ', ur: 'بیلنس شیٹ کھولو', ar: 'افتح الميزانية العمومية', fr: 'ouvre le bilan', de: 'öffne die Bilanz', es: 'abre el balance general', zh: '打开资产负债表', ja: '貸借対照表を開いて', ko: '재무상태표 열어줘' };
  const SALES = { en: 'how much are sales this month', ta: 'இந்த மாதம் விற்பனை எவ்வளவு', hi: 'इस महीने की बिक्री कितनी है', te: 'ఈ నెల అమ్మకాలు ఎంత', ml: 'ഈ മാസത്തെ വിൽപ്പന എത്ര', kn: 'ಈ ತಿಂಗಳ ಮಾರಾಟ ಎಷ್ಟು', bn: 'এই মাসের বিক্রয় কত', mr: 'या महिन्याची विक्री किती', gu: 'આ મહિનાનું વેચાણ કેટલું', pa: 'ਇਸ ਮਹੀਨੇ ਦੀ ਵਿਕਰੀ ਕਿੰਨੀ', ur: 'اس مہینے کی فروخت کتنی ہے', ar: 'كم المبيعات هذا الشهر', fr: 'Quelles sont les ventes du mois', de: 'Wie hoch ist der Umsatz diesen Monat', es: 'Cuánto vendimos este mes', zh: '本月销售额多少', ja: '今月の売上はいくら', ko: '이번 달 매출 얼마' };
  for (const code of Object.keys(NAV)) {
    const a = await understand(NAV[code]), b = await understand(SALES[code]);
    assert(a.primary && a.primary.code === code && a.intent.kind === 'navigate' && a.intent.title === 'Balance Sheet', `${code}: "${NAV[code]}" -> Balance Sheet, language detected`, JSON.stringify([a.primary, a.intent]));
    assert(b.primary && b.primary.code === code && b.intent.kind === 'query' && b.intent.topic === 'sales' && b.intent.query === 'total sales this month', `${code}: "${SALES[code]}" -> sales query for this month`, JSON.stringify([b.primary, b.intent]));
  }

  console.log('\n--- 4. Telugu, Malayalam, Kannada low-stock and other commands ---');
  for (const [code, txt] of [['te', 'తక్కువ స్టాక్ చూపించు'], ['ml', 'കുറഞ്ഞ സ്റ്റോക്ക് കാണിക്കൂ'], ['kn', 'ಕಡಿಮೆ ಸ್ಟಾಕ್ ತೋರಿಸು'], ['ta', 'குறைவான சரக்கு காட்டு'], ['hi', 'कम स्टॉक दिखाओ']]) {
    const u = await understand(txt);
    assert(u.primary.code === code && u.intent.topic === 'low_stock', `${code}: low stock -> low-stock question`, JSON.stringify([u.primary, u.intent]));
  }
  for (const [code, txt, title] of [['te', 'బకాయి చూపించు', 'Bills Outstandings'], ['ml', 'കുടിശ്ശിക കാണിക്കൂ', 'Bills Outstandings'], ['kn', 'ಬಾಕಿ ತೋರಿಸು', 'Bills Outstandings'], ['te', 'జీఎస్టీ చూపించు', 'GST Portal'], ['ml', 'ബാങ്ക് തുറക്കൂ', 'Bank Reconciliation'], ['kn', 'ಲೆಡ್ಜರ್ ತೋರಿಸು', 'Chart of Accounts']]) {
    const u = await understand(txt);
    assert(u.primary.code === code && u.intent.title === title, `${code}: "${txt}" -> ${title}`, JSON.stringify([u.primary, u.intent]));
  }

  console.log('\n--- 5. Mixed-language speech ---');
  const MIX = [
    ['Tally la purchase report open pannu', 'ta', (i) => i.kind === 'navigate' && i.title === 'Day Book'],
    ['Inventory mein low stock products dikhao', 'hi', (i) => i.topic === 'low_stock'],
    ['Indha month sales evlo?', 'ta', (i) => i.topic === 'sales' && i.query === 'total sales this month'],
    ['Show pannunga outstanding payments', 'ta', (i) => i.title === 'Bills Outstandings'],
    ['Balance sheet kholo', 'hi', (i) => i.title === 'Balance Sheet'],
    ['aaj ki sales kitni hai', 'hi', (i) => i.topic === 'sales' && i.query === 'total sales today'],
    ['please profit evlo this month', 'ta', (i) => i.topic === 'profit']
  ];
  for (const [t, lang, ok] of MIX) {
    const u = await understand(t);
    assert(u.primary.code === lang && u.mixed === true && ok(u.intent), `Mixed: "${t}" -> ${lang}, understood`, JSON.stringify([u.primary, u.languages.slice(0, 3), u.intent]));
  }
  const loose = await understand('stock low products show');
  assert(loose.intent.topic === 'low_stock', 'Ungrammatical word order is still understood');
  const mixedReply = (await exec('Tally la purchase report open pannu')).json.data;
  assert(mixedReply.language.reply === 'ta' && /[஀-௿]/.test(mixedReply.reply), 'A Tamil-English mix is answered in Tamil');

  console.log('\n--- 6. Accounting terminology in other languages ---');
  const TERMS = [
    ['SALES', ['விற்பனை', 'बिक्री', 'المبيعات', 'ventes', 'Umsatz', 'ventas', '销售额', '売上', '매출']],
    ['PURCHASE', ['கொள்முதல்', 'खरीद', 'المشتريات', 'achats', 'Einkauf', 'compras', '采购', '仕入', '매입']],
    ['PAYMENT', ['செலுத்து', 'भुगतान', 'الدفع', 'paiement', 'Zahlung', 'pago', '付款', '支払い', '지급']],
    ['RECEIPT', ['ரசீது', 'रसीद', 'إيصال', 'reçu', 'Quittung', 'recibo', '收据', '領収書', '영수증']],
    ['LEDGER', ['பேரேடு', 'खाता', 'دفتر الأستاذ', 'grand livre', 'Hauptbuch', 'libro mayor', '总账', '元帳', '원장']],
    ['STOCK', ['சரக்கு', 'स्टॉक', 'المخزون', 'inventaire', 'Lagerbestand', 'inventario', '库存', '在庫', '재고']],
    ['OUTSTANDING', ['நிலுவை', 'बकाया', 'مستحقات', 'impayés', 'ausstehend', 'pendientes', '未付', '未払い', '미수금']],
    ['PROFIT', ['லாபம்', 'मुनाफा', 'الربح', 'bénéfice', 'Gewinn', 'ganancia', '利润', '利益', '이익']],
    ['LOSS', ['நஷ்டம்', 'घाटा', 'خسارة', 'perte', 'Verlust', 'pérdida', '亏损', '損失', '손실']],
    ['BALANCE_SHEET', ['இருப்புநிலைக் குறிப்பு', 'बैलेंस शीट', 'الميزانية', 'bilan', 'Bilanz', 'balance general', '资产负债表', '貸借対照表', '재무상태표']],
    ['GST', ['ஜிஎஸ்டி', 'जीएसटी', 'ضريبة القيمة المضافة', 'tva', 'Mehrwertsteuer', 'iva', '消费税', '消費税', '부가세']],
    ['DEBIT', ['பற்று', 'डेबिट', 'مدين', 'débit', 'Soll', 'débito', '借方', '借方', '차변']],
    ['CREDIT', ['வரவு', 'क्रेडिट', 'دائن', 'crédit', 'Haben', 'crédito', '贷方', '貸方', '대변']],
    ['VOUCHER', ['பற்றுச்சீட்டு', 'वाउचर', 'قسيمة', 'justificatif', 'Buchungsbeleg', 'comprobante', '凭证', '伝票', '전표']]
  ];
  for (const [concept, words] of TERMS) {
    const missed = [];
    for (const w of words) { const u = await understand(w); if (!u.concepts.includes(concept)) missed.push(w); }
    assert(!missed.length, `${concept} recognised in 9 languages`, 'missed: ' + missed.join(', '));
  }

  console.log('\n--- 7. Switching languages in one conversation (context kept) ---');
  let ctx = null;
  let s1 = (await exec('Open inventory', { context: ctx })).json.data; ctx = s1.context;
  assert(s1.action.title === 'Stock Summary' && s1.language.reply === 'en', 'English: Open inventory -> opens, replies in English');
  let s2 = (await exec('இப்போ low stock products காட்டு', { context: ctx })).json.data; ctx = s2.context;
  assert(s2.status === 'ok' && s2.action.topic === 'low_stock' && s2.language.reply === 'ta' && /[஀-௿]/.test(s2.reply), 'Tamil: low-stock products shown, reply in Tamil');
  let s3 = (await exec('how much is sales this month', { context: ctx })).json.data; ctx = s3.context;
  assert(s3.language.reply === 'en' && ctx.lastQuery.topic === 'sales', 'Back to English: answered in English, topic remembered');
  let s4 = (await exec('and last month?', { context: ctx })).json.data; ctx = s4.context;
  assert(s4.status === 'ok' && s4.action.question_english === 'total sales last month' && s4.interpretation.intent.followUp === true, 'Follow-up "and last month?" repeats the sales question for last month');
  let s5 = (await exec('पिछले महीने?', { context: ctx })).json.data;
  assert(s5.status === 'ok' && s5.action.question_english === 'total sales last month' && s5.language.reply === 'hi' && /[ऀ-ॿ]/.test(s5.reply), 'Hindi follow-up reuses the English conversation topic and replies in Hindi');
  const forged = (await exec('and last month?', { context: { lastQuery: { topic: 'DROP TABLE', concept: 'x' }, language: '../..' } })).json.data;
  assert(forged.status === 'not_understood', 'A tampered conversation context is ignored');

  console.log('\n--- 8. Reply language, spoken replies ---');
  await req('POST', '/api/voice/prefs', { body: { reply_language: 'hi' } });
  r = (await exec('Open inventory')).json.data;
  assert(r.language.detected === 'en' && r.language.reply === 'hi' && /[ऀ-ॿ]/.test(r.reply), 'The user can force the reply language (English speech, Hindi reply)');
  assert((await req('POST', '/api/voice/prefs', { body: { reply_language: 'xx' } })).status === 400, 'An unavailable reply language is refused');
  await req('POST', '/api/voice/prefs', { body: { reply_language: 'auto', speak_replies: false } });
  r = (await exec('Open inventory')).json.data;
  assert(r.speak === false && r.reply, 'Spoken replies can be switched off (text reply remains)');
  await req('POST', '/api/voice/prefs', { body: { speak_replies: true } });
  assert((await exec('Open inventory')).json.data.speak === true, 'and back on');
  assert((await req('GET', '/api/voice/prefs', { token: clerk })).json.data.reply_language === 'auto', 'Preferences are per user');

  console.log('\n--- 9. Recognised text, checking and confirming sensitive commands ---');
  r = (await exec('create sales voucher', { token: clerk })).json.data;
  assert(r.status === 'needs_confirmation' && r.recognised === 'create sales voucher' && r.action === null, 'Creating a voucher is not run until the recognised text is confirmed');
  r = (await exec('create sales voucher', { token: clerk, confirmed: true })).json.data;
  assert(r.status === 'ok' && r.action.title === 'Create Sales Voucher', 'After confirmation it opens the voucher screen');
  r = (await exec('புதிய விற்பனை வவுச்சர் உருவாக்கு', { token: clerk })).json.data;
  assert(r.status === 'needs_confirmation' && r.language.reply === 'ta' && /[஀-௿]/.test(r.reply), 'Tamil: asks for confirmation in Tamil');
  r = (await exec('नई बिक्री वाउचर बनाओ 5000', { token: clerk, confirmed: true })).json.data;
  assert(r.status === 'ok' && r.action.amount_heard === 5000, 'Hindi digits/amount heard are reported back, not entered');
  r = (await exec('इसे बनाओ ५०००', { token: clerk })).json.data;
  assert(r.interpretation.amounts[0] === 5000, 'Devanagari digits are read as numbers');
  r = (await exec('create voucher', { token: clerk })).json.data;
  assert(r.status === 'clarify', 'A voucher request with no type asks which type');
  r = (await exec('create contra voucher', { token: viewer, confirmed: true })).json.data;
  assert(r.status === 'denied', 'A Viewer cannot open a voucher screen by voice');
  r = (await exec('open balance sheet', { token: clerk })).json.data;
  assert(r.status === 'denied', 'Data Entry cannot open financial statements by voice (same rule as the screen)');
  r = (await exec('net profit this month', { token: clerk })).json.data;
  assert(r.status === 'ok' && r.action.restricted === true, 'A restricted financial answer stays restricted when asked by voice');
  r = (await exec('create journal voucher', { token: clerk, confirmed: true })).json.data;
  assert(r.status === 'denied', 'Data Entry cannot open a Journal voucher (not an allowed type)');
  await req('POST', '/api/voice/prefs', { token: acc, body: { confirm_all: true } });
  r = (await exec('open inventory', { token: acc })).json.data;
  assert(r.status === 'needs_confirmation', 'With "confirm everything" on, even opening a screen waits for confirmation');
  assert((await exec('open inventory', { token: acc, confirmed: true })).json.data.status === 'ok', 'and runs once confirmed');
  assert((await exec('create sales voucher', { token: admin, confirmed: 'yes' })).json.data.status === 'needs_confirmation', 'Only a real boolean true counts as confirmation');
  const edited = (await exec('create payment voucher', { token: clerk, confirmed: true })).json.data;
  assert(edited.action.title === 'Create Payment Voucher', 'Confirmation applies to the text as corrected (understood again on the server)');

  console.log('\n--- 10. Unsupported, unknown and bad input ---');
  for (const [name, txt] of [['Thai', 'สวัสดี ขอดูยอดขาย'], ['Cyrillic', 'Привет покажи продажи'], ['Hebrew', 'שלום הצג מכירות']]) {
    const x = (await exec(txt)).json.data;
    assert(x.status === 'unsupported_language' && x.language.reply === 'en' && /cannot understand that language yet/.test(x.reply), `${name}: reported as not supported, in English, not guessed`, JSON.stringify(x.reply));
  }
  assert((await exec('asdf qwer zxcv')).json.data.status === 'not_understood', 'Gibberish is not understood (nothing runs)');
  assert((await exec('')).json.data.status === 'not_understood' && (await exec(null)).json.data.status === 'not_understood', 'Empty input is handled');
  assert((await exec('x'.repeat(500))).status === 400, 'Very long input is refused');
  assert((await exec('தயவுசெய்து வணக்கம்')).json.data.status === 'not_understood', 'Tamil with no known command: understood as Tamil but nothing run');

  console.log('\n--- 11. Extending languages ---');
  const si = 'විකුණුම් පෙන්වන්න';
  assert((await exec(si)).json.data.status === 'unsupported_language', 'Sinhala is not supported to begin with');
  const extDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rre_voice_ext_'));
  fs.writeFileSync(path.join(extDir, 'sinhala.json'), JSON.stringify({ languages: { si: { name: 'Sinhala', native: 'සිංහල', script: 'sinhala', tts: 'si-LK' } }, terms: { OPEN: { si: 'පෙන්වන්න' }, SALES: { si: 'විකුණුම්' } }, markers: { si: 'පෙන්වන්න' } }));
  fs.writeFileSync(path.join(extDir, 'broken.json'), '{ not json');
  const rep = require('./core/voice/lexicon').loadExtensions(extDir);
  assert(rep.loaded.includes('sinhala.json') && rep.errors.length === 1 && /broken.json/.test(rep.errors[0]), 'A language file loads; a broken file is reported and skipped');
  const sx = (await exec(si)).json.data;
  assert(sx.language.detected === 'si' && sx.interpretation.concepts.includes('SALES') && sx.status === 'ok' && sx.action.title === 'Day Book', 'After adding the language it is understood (sales register)');
  assert(sx.language.reply === 'en' && sx.language.fell_back_from === 'si' && /not available/.test(sx.reply), 'A language with no reply phrases gets an English reply and says so');
  assert((await req('GET', '/api/voice/capabilities')).json.data.understands.some((l) => l.code === 'si' && l.custom), 'The new language appears in the capabilities list');

  console.log('\n--- 12. Speech providers, consent and privacy ---');
  const audio = Buffer.concat([Buffer.from('RREAUDIO-PRIVACY-MARKER-9Q'), Buffer.alloc(2000, 7)]);
  let received = null;
  const mock = http.createServer((q, s) => {
    const chunks = []; q.on('data', (c) => chunks.push(c));
    q.on('end', () => { received = { headers: q.headers, body: Buffer.concat(chunks) }; s.setHeader('Content-Type', 'application/json'); s.end(JSON.stringify({ text: 'இந்த மாதம் விற்பனை எவ்வளவு', language: 'tamil' })); });
  });
  await new Promise((res) => mock.listen(0, '127.0.0.1', res));
  const post = (tok, buf) => req('POST', '/api/voice/transcribe', { token: tok, raw: buf, type: 'audio/webm' });
  assert((await post(admin, audio)).status === 403 && received === null, 'Without consent nothing is sent anywhere');
  await req('POST', '/api/voice/prefs', { body: { cloud_consent: true } });
  assert((await post(admin, audio)).status === 409 && received === null, 'With consent but no service configured: refused, nothing sent');
  process.env.RRE_STT_ENDPOINT = 'http://example.com/v1/audio/transcriptions';
  assert((await post(admin, audio)).status === 409 && /https/.test((await post(admin, audio)).json.error) && received === null, 'A plain-http service on another host is refused');
  process.env.RRE_STT_ENDPOINT = `http://127.0.0.1:${mock.address().port}/v1/audio/transcriptions`;
  process.env.RRE_STT_KEY = 'test-key';
  const capOn = (await req('GET', '/api/voice/capabilities')).json.data.providers.find((p) => p.id === 'cloud');
  assert(capOn.available === true && capOn.endpoint_host && capOn.auto_language === true, 'Once configured, the service is shown with its host so the user knows where audio would go');
  const tr = await post(admin, audio);
  assert(tr.status === 200 && tr.json.data.language === 'ta' && /விற்பனை/.test(tr.json.data.text), 'Transcription returns text and the detected language code (ta)', tr.raw);
  const bodyStr = received.body.toString('latin1');
  assert(!/name="language"/.test(bodyStr) && /name="response_format"/.test(bodyStr) && received.headers.authorization === 'Bearer test-key', 'No language is forced (the service identifies it); the key is sent only as a header');
  assert((await post(admin, Buffer.alloc(9 * 1024 * 1024, 1))).status === 413, 'An oversized recording is refused');
  assert((await post(admin, Buffer.alloc(0))).status === 400, 'An empty recording is refused');
  await req('POST', '/api/voice/prefs', { body: { cloud_consent: false } });
  received = null;
  assert((await post(admin, audio)).status === 403 && received === null, 'Withdrawing consent stops it again');
  assert((await post(clerk, audio)).status === 403, 'Consent is per person: another user has not consented');
  process.env.RRE_STT_ENDPOINT = `http://127.0.0.1:1/x`;
  await req('POST', '/api/voice/prefs', { body: { cloud_consent: true } });
  assert((await post(admin, audio)).status === 502, 'A service that cannot be reached gives a clear error');
  mock.close(); delete process.env.RRE_STT_ENDPOINT; delete process.env.RRE_STT_KEY;
  let leaked = false;
  const walk = (d) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) walk(p); else { try { if (fs.readFileSync(p).includes('RREAUDIO-PRIVACY-MARKER-9Q')) leaked = true; } catch (e) { /* locked */ } } } };
  walk(tmp);
  assert(!leaked, 'The recording was never written to disk or the database');
  const log = await all(`SELECT action, details FROM activity_log WHERE action LIKE 'VOICE_%'`);
  assert(log.some((l) => l.action === 'VOICE_CONSENT_CLOUD_GIVEN') && log.some((l) => l.action === 'VOICE_CONSENT_CLOUD_WITHDRAWN') && log.some((l) => l.action === 'VOICE_TRANSCRIBE'), 'Consent given/withdrawn and each transcription are in the audit log');
  assert(!log.some((l) => /விற்பனை|open inventory|Open inventory/.test(l.details || '')) && log.some((l) => l.action === 'VOICE_COMMAND'), 'Commands are logged without the words that were said');

  console.log('\n--- 13. Voice never changes the books ---');
  assert(await vcount() === v0, 'No voucher was created by any voice command');
  const bal = (await get('SELECT ROUND(SUM(debit_amount),2) d, ROUND(SUM(credit_amount),2) c FROM ledger_entries'));
  assert(bal.d === bal.c, 'Debits still equal credits');
  assert(((await get('SELECT COUNT(*) c FROM schema_migrations')).c === 20), 'Migrations applied: 20');

  console.log(`\n=== ${passed} passed, ${failed} failed ===`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
