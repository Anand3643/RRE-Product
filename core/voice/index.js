/**
 * RRE Tally — multilingual voice assistant: the service that joins understanding (nlu.js), permissions, the existing assistant
 * and replies. It never posts or changes accounting data: voice can only open screens, read answers, and (after the person has
 * checked and confirmed the recognised text) open a blank voucher form. Entering and saving a voucher stays a deliberate act.
 */
const { run, get, getRolePermissions } = require('../db');
const { logActivity } = require('../auth');
const { interpret } = require('./nlu');
const { registry } = require('./lexicon');
const { phrase, pickLanguage, targetName, supportedReplyLanguages } = require('./responses');
const assistant = require('../assistant');

const bad = (m, s = 400) => { const e = new Error(m); e.status = s; return e; };
const FINANCIAL = new Set(['Balance Sheet', 'Profit & Loss A/c', 'Trial Balance']);

// ------------------------------------------------------------------ preferences
async function getPrefs(user) {
  const r = await get('SELECT * FROM voice_prefs WHERE username = ?', [user.username]);
  return {
    speak_replies: r ? !!r.speak_replies : true,
    reply_language: r ? r.reply_language : 'auto',
    confirm_all: r ? !!r.confirm_all : false,
    browser_consent: !!(r && r.browser_consent_at),
    cloud_consent: !!(r && r.cloud_consent_at)
  };
}

async function setPrefs(user, b = {}) {
  const cur = await getPrefs(user);
  const next = { ...cur };
  if (b.speak_replies !== undefined) next.speak_replies = !!b.speak_replies;
  if (b.confirm_all !== undefined) next.confirm_all = !!b.confirm_all;
  if (b.reply_language !== undefined) {
    if (b.reply_language !== 'auto' && !supportedReplyLanguages().includes(b.reply_language)) throw bad(`Replies are available in: auto, ${supportedReplyLanguages().join(', ')}.`);
    next.reply_language = b.reply_language;
  }
  if (b.browser_consent !== undefined) next.browser_consent = !!b.browser_consent;
  if (b.cloud_consent !== undefined) next.cloud_consent = !!b.cloud_consent;
  await run(`INSERT INTO voice_prefs (username, speak_replies, reply_language, confirm_all, browser_consent_at, cloud_consent_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
             ON CONFLICT(username) DO UPDATE SET speak_replies = excluded.speak_replies, reply_language = excluded.reply_language, confirm_all = excluded.confirm_all,
               browser_consent_at = CASE WHEN excluded.browser_consent_at IS NULL THEN NULL ELSE COALESCE(voice_prefs.browser_consent_at, excluded.browser_consent_at) END,
               cloud_consent_at = CASE WHEN excluded.cloud_consent_at IS NULL THEN NULL ELSE COALESCE(voice_prefs.cloud_consent_at, excluded.cloud_consent_at) END,
               updated_at = CURRENT_TIMESTAMP`,
    [user.username, next.speak_replies ? 1 : 0, next.reply_language, next.confirm_all ? 1 : 0, next.browser_consent ? new Date().toISOString() : null, next.cloud_consent ? new Date().toISOString() : null]);
  if (next.browser_consent !== cur.browser_consent) await logActivity({ user, action: next.browser_consent ? 'VOICE_CONSENT_BROWSER_GIVEN' : 'VOICE_CONSENT_BROWSER_WITHDRAWN', entity: 'voice', entityId: user.username });
  if (next.cloud_consent !== cur.cloud_consent) await logActivity({ user, action: next.cloud_consent ? 'VOICE_CONSENT_CLOUD_GIVEN' : 'VOICE_CONSENT_CLOUD_WITHDRAWN', entity: 'voice', entityId: user.username });
  return getPrefs(user);
}

// ------------------------------------------------------------------ helpers
const cleanContext = (c) => {
  if (!c || typeof c !== 'object') return null;
  const out = {};
  if (typeof c.language === 'string' && registry.languages[c.language]) out.language = c.language;
  if (c.lastQuery && typeof c.lastQuery === 'object' && ['sales', 'profit', 'expenses'].includes(c.lastQuery.topic)) out.lastQuery = { topic: c.lastQuery.topic, concept: String(c.lastQuery.concept || '').slice(0, 20) };
  return out;
};

const plainFirstLine = (md) => String(md || '').replace(/\*\*/g, '').replace(/^[•\-]\s*/gm, '').split(/\n/).map((s) => s.trim()).filter(Boolean)[0] || '';

/** Understand a command without doing anything. Used to show "what I heard / what I understood" before running it. */
function understand(text, context) {
  const n = interpret(text, cleanContext(context));
  return n;
}

/**
 * Run a command for a signed-in user. `confirmed` is the person's explicit go-ahead for a sensitive step; the text is understood
 * again here, so a changed or tampered interpretation cannot be smuggled in.
 */
async function handle(text, context, user, { confirmed = false } = {}) {
  const n = interpret(text, cleanContext(context));
  const prefs = await getPrefs(user);
  const detected = n.primary && n.primary.code;
  const rl = pickLanguage(detected, prefs.reply_language);
  const lang = rl.code;
  const perms = getRolePermissions(user.role);
  const intent = n.intent;
  const out = {
    status: 'not_understood', recognised: n.text,
    language: { detected: detected || null, detected_name: n.primary ? n.primary.name : null, mixed: n.mixed, reply: lang, fell_back_from: rl.fellBackFrom, all: n.languages },
    interpretation: { intent, concepts: n.concepts, period: n.period, amounts: n.amounts, confidence: n.confidence },
    reply: '', speak: prefs.speak_replies, action: null,
    context: { ...(cleanContext(context) || {}), language: detected || (cleanContext(context) || {}).language }
  };
  const say = (k, v) => phrase(lang, k, v);
  const withFallback = (s) => (rl.fellBackFrom && registry.languages[rl.fellBackFrom] ? `${s} ${phrase('en', 'fallback', { language: registry.languages[rl.fellBackFrom].name })}` : s);

  if (!n.supported) {
    out.status = 'unsupported_language'; out.language.reply = 'en';
    out.reply = phrase('en', 'unsupported', { script: (n.unsupported_scripts[0] || 'that').replace(/^./, (c) => c.toUpperCase()) });
  } else if (intent.kind === 'unknown') {
    out.status = 'not_understood'; out.reply = withFallback(say('notUnderstood'));
  } else if (intent.kind === 'clarify') {
    out.status = 'clarify'; out.reply = withFallback(say('clarify'));
  } else if (intent.kind === 'create_voucher' && !perms.canCreateVouchers) {
    out.status = 'denied'; out.reply = withFallback(say('denied'));
  } else if (intent.kind === 'create_voucher' && !(perms.allowedVoucherTypes || []).includes(intent.voucherType)) {
    out.status = 'denied'; out.reply = withFallback(say('denied'));
  } else if (intent.kind === 'navigate' && FINANCIAL.has(intent.title) && !perms.canViewFinancials) {
    out.status = 'denied'; out.reply = withFallback(say('denied'));
  } else if ((intent.sensitive || prefs.confirm_all) && !confirmed) {
    out.status = 'needs_confirmation'; out.reply = withFallback(say('confirm'));
  } else if (intent.kind === 'navigate' || intent.kind === 'create_voucher') {
    out.status = 'ok'; out.action = { type: 'navigate', title: intent.title };
    out.reply = withFallback(say('opening', { target: targetName(intent, lang) }));
    if (intent.amount) out.action.amount_heard = intent.amount;
  } else if (intent.kind === 'query') {
    const r = await assistant.ask(intent.query, { perms });
    if (!r) { out.status = 'not_understood'; out.reply = withFallback(say('notUnderstood')); }
    else {
      out.status = 'ok'; out.action = { type: 'answer', topic: intent.topic, question_english: intent.query, answer: r.answer, table: r.table || null, restricted: !!r.restricted };
      out.reply = withFallback(say('answer') + ' ' + (lang === 'en' ? plainFirstLine(r.answer).slice(0, 240) : say('screen')));
      if (['sales', 'profit', 'expenses'].includes(intent.topic)) out.context.lastQuery = { topic: intent.topic, concept: intent.concept };
    }
  }
  await logActivity({ user, action: 'VOICE_COMMAND', entity: 'voice', entityId: user.username, details: { status: out.status, intent: intent.kind, target: intent.title || intent.topic || null, language: detected || null, reply_language: lang, chars: n.text.length } });
  return out;
}

module.exports = { handle, understand, getPrefs, setPrefs };
