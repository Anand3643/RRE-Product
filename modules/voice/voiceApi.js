/**
 * RRE Tally — multilingual voice API. Mounted at /api/voice. Every route needs a signed-in user.
 *   GET  /capabilities         what is understood, what can be recognised, providers, the user's own settings
 *   GET/POST /prefs            speak replies, reply language, confirm-before-run, consent for sending audio
 *   POST /interpret            understand text only (nothing runs)
 *   POST /execute              understand and run (read-only answers, open screens; sensitive steps need confirmed:true)
 *   POST /transcribe           audio -> text via the Owner-configured online service; needs the user's consent; audio is never stored
 */
const express = require('express');
const router = express.Router();
const voice = require('../../core/voice');
const stt = require('../../core/voice/stt');
const asr = require('../../core/voice/asr');
const { registry } = require('../../core/voice/lexicon');
const { supportedReplyLanguages } = require('../../core/voice/responses');
const { requireAuth } = require('../../core/auth');
const { logActivity } = require('../../core/auth');

const any = requireAuth();
const handle = (fn) => async (req, res) => {
  try { res.json({ success: true, data: await fn(req) }); }
  catch (err) { res.status(err.status || 500).json({ success: false, error: err.message }); }
};

router.get('/capabilities', any, handle(async (req) => ({
  understands: stt.languageList(),
  reply_languages: supportedReplyLanguages(),
  providers: stt.describeProviders({ local: asr.status() }),
  speech_models: asr.status(),
  prefs: await voice.getPrefs(req.user),
  notes: [
    'The assistant understands the languages listed under "understands". Recognising speech from audio depends on the speech provider you use; it can recognise only what that provider supports.',
    'Replies are fixed sentences in each language plus figures shown on screen. Detailed answers are not machine-translated.',
    'Voice never saves accounting entries. It opens screens and reads answers; anything sensitive is shown to you to check first.'
  ]
})));

// On-device speech model: anyone signed in can see its status; only the Owner can install one (it downloads once).
router.get('/model', any, handle(async () => asr.status()));
router.post('/model/install', requireAuth('canAlterCompany'), handle(async (req) => {
  const r = await asr.install(String((req.body && req.body.model) || 'small'));
  await logActivity({ user: req.user, action: 'VOICE_MODEL_INSTALL', entity: 'voice', entityId: r.model, details: { model: r.model } });
  return r;
}));

router.get('/prefs', any, handle((req) => voice.getPrefs(req.user)));
router.post('/prefs', any, handle((req) => voice.setPrefs(req.user, req.body || {})));

router.post('/interpret', any, handle(async (req) => voice.understand(req.body && req.body.text, req.body && req.body.context)));
router.post('/execute', any, handle((req) => voice.handle(req.body && req.body.text, req.body && req.body.context, req.user, { confirmed: req.body && req.body.confirmed === true })));

router.post('/transcribe', any, express.raw({ type: () => true, limit: stt.MAX_AUDIO_BYTES + 1024 }), async (req, res) => {
  try {
    // On-device recognition: audio stays on this computer, so no consent step is needed. Used whenever a model is installed
    // (or when asked for explicitly with ?provider=local); otherwise the Owner-configured online service, which needs consent.
    const provider = String(req.query.provider || 'auto');
    if (provider === 'local' || (provider === 'auto' && asr.status().active)) {
      const audio = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const r = await asr.transcribe(audio, String(req.headers['content-type'] || ''), { hint: req.query.language ? String(req.query.language) : null });
      await logActivity({ user: req.user, action: 'VOICE_TRANSCRIBE', entity: 'voice', entityId: req.user.username, details: { provider: 'local', model: r.model, bytes: audio.length, seconds: r.seconds, language: r.language || null } });
      return res.json({ success: true, data: { ...r, provider: 'local', understood_language: !!(r.language && registry.languages[r.language]) } });
    }
    const prefs = await voice.getPrefs(req.user);
    if (!prefs.cloud_consent) return res.status(403).json({ success: false, error: 'Sending audio to an online transcription service needs your consent first. Nothing was sent.' });
    const audio = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const r = await stt.transcribeCloud(audio, String(req.headers['content-type'] || ''));
    await logActivity({ user: req.user, action: 'VOICE_TRANSCRIBE', entity: 'voice', entityId: req.user.username, details: { provider: 'cloud', host: stt.cloudConfig()?.host, bytes: audio.length, language: r.language || r.language_reported || null } });
    res.json({ success: true, data: { text: r.text, language: r.language, language_reported: r.language_reported, languages_known: Object.keys(registry.languages).length } });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, error: err.type === 'entity.too.large' ? 'That recording is too long. Please keep it under about a minute.' : err.message });
  }
});

module.exports = router;
