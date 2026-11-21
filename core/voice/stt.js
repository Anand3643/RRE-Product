/**
 * RRE Tally — multilingual voice: speech-to-text providers.
 *
 * Understanding a command (nlu.js) does not depend on how the speech was turned into text. This file is the only place audio is
 * handled, and it is deliberately conservative:
 *   - the app is offline by default: no provider is active until the Owner configures one;
 *   - audio is only sent to an external service if the Owner configured that service AND the person using the microphone has
 *     given consent for it; consent is recorded and can be withdrawn;
 *   - audio is processed in memory and never written to disk or the database; only size, provider and language are logged;
 *   - the languages a provider can recognise are the provider's, not ours; we never claim more than it documents.
 */
const http = require('http');
const https = require('https');
const { URL } = require('url');
const { registry } = require('./lexicon');

const MAX_AUDIO_BYTES = 8 * 1024 * 1024;

// Whisper-style APIs report the language as an English name; map to our codes (extend via lexicon registry names too)
const NAME_TO_CODE = { english: 'en', tamil: 'ta', hindi: 'hi', telugu: 'te', malayalam: 'ml', kannada: 'kn', bengali: 'bn', marathi: 'mr', gujarati: 'gu', punjabi: 'pa', urdu: 'ur', arabic: 'ar', french: 'fr', german: 'de', spanish: 'es', chinese: 'zh', japanese: 'ja', korean: 'ko' };

function cloudConfig() {
  const endpoint = process.env.RRE_STT_ENDPOINT || '';
  if (!endpoint) return null;
  let u;
  try { u = new URL(endpoint); } catch (e) { return { error: 'RRE_STT_ENDPOINT is not a valid URL.' }; }
  const loopback = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) return { error: 'The transcription endpoint must use https (plain http is allowed only for this computer).' };
  return { url: u, host: u.host, key: process.env.RRE_STT_KEY || '', model: process.env.RRE_STT_MODEL || 'whisper-1', loopback };
}

/** What the user can actually use right now, and what each option involves. Nothing here is a promise about accuracy. */
function describeProviders({ local } = {}) {
  const cloud = cloudConfig();
  return [
    { id: 'typed', name: 'Typed / pasted text', available: true, offline: true, sends_audio: false, auto_language: true, languages: 'every language the assistant understands (see "understands")',
      note: 'Always available. Use it when no microphone provider is set up.' },
    { id: 'browser', name: 'Browser speech recognition', available: null, offline: false, sends_audio: true, auto_language: false, languages: 'chosen by the browser vendor; one language at a time',
      note: 'Only works in a normal browser (Chrome, Edge). Audio goes to the browser vendor\'s online service, so it needs your consent. It does not detect the language by itself, and it does not work inside the desktop app.' },
    { id: 'cloud', name: 'Online transcription service (Whisper-compatible)', available: !!(cloud && !cloud.error), offline: false, sends_audio: true, auto_language: true, languages: 'defined by the service you configured (Whisper-class models cover about 99 languages with automatic detection; accuracy varies a lot by language)',
      endpoint_host: cloud && !cloud.error ? cloud.host : null, note: cloud ? (cloud.error || 'Configured by the Owner. Audio is sent to this service only after you consent.') : 'Not configured. The Owner sets RRE_STT_ENDPOINT (and RRE_STT_KEY) on this computer to enable it.' },
    { id: 'local', name: 'On-device speech model (Whisper)', available: !!(local && local.active), offline: true, sends_audio: false, auto_language: true,
      languages: 'about 99 languages with automatic detection; accuracy depends on the model size and the language (see each model\'s quality note)',
      model: local && local.active ? local.active : null,
      note: local && local.active ? 'Runs on this computer. Audio never leaves it and no account or key is needed.' : 'Not installed yet. The Owner can install a model once (it is downloaded from huggingface.co); after that it works fully offline.' }
  ];
}

function languageList() {
  return Object.entries(registry.languages).map(([code, d]) => ({ code, name: d.name, native: d.native, tts_locale: d.tts, stt_locale: d.stt, custom: !!d.custom }));
}

function multipart(fields, file) {
  const boundary = '----rre' + Math.random().toString(16).slice(2);
  const parts = [];
  for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`));
  parts.push(file.data); parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), type: `multipart/form-data; boundary=${boundary}` };
}

/** Sends audio to the configured service. The caller has already checked the user's consent. Returns { text, language }. */
function transcribeCloud(audio, mime) {
  const cfg = cloudConfig();
  if (!cfg) { const e = new Error('Online transcription is not configured on this computer.'); e.status = 409; throw e; }
  if (cfg.error) { const e = new Error(cfg.error); e.status = 409; throw e; }
  if (!audio || !audio.length) { const e = new Error('No audio was received.'); e.status = 400; throw e; }
  if (audio.length > MAX_AUDIO_BYTES) { const e = new Error('That recording is too long. Please keep it under about a minute.'); e.status = 413; throw e; }
  const ext = /ogg/.test(mime) ? 'ogg' : /mp4|m4a/.test(mime) ? 'm4a' : /wav/.test(mime) ? 'wav' : 'webm';
  // No language is sent: the service identifies it. verbose_json returns the detected language.
  const m = multipart({ model: cfg.model, response_format: 'verbose_json' }, { name: `speech.${ext}`, type: mime || 'audio/webm', data: audio });
  return new Promise((resolve, reject) => {
    const lib = cfg.url.protocol === 'https:' ? https : http;
    const req = lib.request(cfg.url, { method: 'POST', timeout: 60000, headers: { 'Content-Type': m.type, 'Content-Length': m.body.length, ...(cfg.key ? { Authorization: 'Bearer ' + cfg.key } : {}) } }, (res) => {
      let b = ''; res.on('data', (c) => { b += c; if (b.length > 1e6) req.destroy(); });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) { const e = new Error(`The transcription service answered ${res.statusCode}.`); e.status = 502; return reject(e); }
        let j; try { j = JSON.parse(b); } catch (err) { const e = new Error('The transcription service returned something unreadable.'); e.status = 502; return reject(e); }
        const lang = String(j.language || '').toLowerCase();
        resolve({ text: String(j.text || '').trim(), language: NAME_TO_CODE[lang] || (registry.languages[lang] ? lang : null), language_reported: j.language || null });
      });
    });
    req.on('error', (err) => { const e = new Error('Could not reach the transcription service: ' + err.message); e.status = 502; reject(e); });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.write(m.body); req.end();
  });
}

module.exports = { describeProviders, languageList, transcribeCloud, cloudConfig, MAX_AUDIO_BYTES };
