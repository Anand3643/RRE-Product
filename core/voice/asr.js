/**
 * RRE Tally — on-device speech recognition: model management, audio decoding and the worker process.
 *
 * Audio never leaves this computer on this path. It is decoded in memory, handed to a local worker process, and discarded.
 * Models live in a folder next to the data folder (outside the program files) and are installed only when the Owner asks.
 */
const fs = require('fs');
const path = require('path');
const { fork } = require('child_process');
const paths = require('../paths');

const MODELS = {
  tiny: { id: 'Xenova/whisper-tiny', size_mb: 40, speed: 'fastest', quality: 'Basic. English is usable; Indian languages are unreliable.' },
  base: { id: 'Xenova/whisper-base', size_mb: 80, speed: 'fast', quality: 'Fair. English good; Hindi and Tamil usable; other Indian languages weak.' },
  small: { id: 'Xenova/whisper-small', size_mb: 240, speed: 'slower (several seconds per command on a typical laptop)', quality: 'Recommended. English and Hindi good, Tamil fair; Telugu, Malayalam and Kannada are often wrong at this size.' }
};
const PREFERENCE = ['small', 'base', 'tiny'];
const MAX_SECONDS = 30, TARGET_RATE = 16000;
const IDLE_MS = 5 * 60 * 1000, REQUEST_TIMEOUT_MS = 240000;

const bad = (m, s = 400) => { const e = new Error(m); e.status = s; return e; };
const modelDir = () => process.env.RRE_MODEL_DIR ? path.resolve(process.env.RRE_MODEL_DIR) : path.join(path.dirname(paths.ROOT), 'models');
const isInstalled = (key) => {
  const d = path.join(modelDir(), ...MODELS[key].id.split('/'));
  return ['config.json', 'tokenizer.json', 'preprocessor_config.json', 'onnx/encoder_model_quantized.onnx', 'onnx/decoder_model_merged_quantized.onnx'].every((f) => fs.existsSync(path.join(d, f)));
};

let installing = null; // { model, file, progress, error, done }
function status() {
  const installed = Object.keys(MODELS).filter(isInstalled);
  const active = PREFERENCE.find((k) => installed.includes(k)) || null;
  return {
    installed, active, installing,
    catalog: Object.entries(MODELS).map(([key, m]) => ({ key, model: m.id, size_mb: m.size_mb, speed: m.speed, quality: m.quality, installed: installed.includes(key) })),
    note: 'Speech is recognised on this computer. Language is detected automatically. Accuracy depends on the model size and on the language; the quality note on each model says what to expect.'
  };
}

// ------------------------------------------------------------------ worker process
let worker = null, idleTimer = null, nextId = 1;
const waiting = new Map();

function workerScript() {
  // when packaged, the file is unpacked from the archive
  return __filename.replace('app.asar', 'app.asar.unpacked').replace(/asr\.js$/, 'asrWorker.js');
}

function startWorker() {
  if (worker) return worker;
  const w = fork(workerScript(), [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
  const failAll = (msg) => { for (const [id, p] of waiting) if (p.w === w) { waiting.delete(id); clearTimeout(p.timer); p.reject(bad(msg, 502)); } if (worker === w) worker = null; };
  w.on('message', (m) => {
    if (m.type === 'progress') { if (installing) { installing.file = m.file; installing.progress = m.progress; } return; }
    const p = waiting.get(m.id); if (!p) return;
    waiting.delete(m.id); clearTimeout(p.timer);
    m.ok ? p.resolve(m) : p.reject(bad(m.error || 'Speech recognition failed.', 502));
  });
  w.on('exit', () => failAll('The speech engine stopped unexpectedly (it may have run out of memory). Please try again.'));
  w.on('error', (e) => failAll('The speech engine could not start: ' + e.message));
  worker = w;
  return w;
}

function call(payload, timeout = REQUEST_TIMEOUT_MS) {
  const w = startWorker();
  const id = nextId++;
  clearTimeout(idleTimer);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { waiting.delete(id); try { w.kill(); } catch (e) { /* ignore */ } worker = null; reject(bad('Speech recognition took too long and was stopped.', 504)); }, timeout);
    waiting.set(id, { resolve, reject, timer, w });
    w.send({ id, ...payload });
  }).finally(() => { idleTimer = setTimeout(stopWorker, IDLE_MS); idleTimer.unref && idleTimer.unref(); });
}

function stopWorker() { clearTimeout(idleTimer); if (worker) { try { worker.kill(); } catch (e) { /* ignore */ } worker = null; } }

// one recognition at a time: the model is memory-hungry
let chain = Promise.resolve();
const serial = (fn) => { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p; };

// ------------------------------------------------------------------ installing a model (Owner only; the only network use)
async function install(key) {
  if (!MODELS[key]) throw bad(`Choose one of: ${Object.keys(MODELS).join(', ')}.`);
  if (installing && !installing.done) throw bad('A model is already being installed.', 409);
  if (isInstalled(key)) throw bad('That model is already installed.', 409);
  fs.mkdirSync(modelDir(), { recursive: true });
  installing = { model: key, file: null, progress: 0, error: null, done: false };
  serial(() => call({ cmd: 'install', modelId: MODELS[key].id, dir: modelDir() }, 30 * 60 * 1000))
    .then(() => { installing = { ...installing, progress: 100, done: true }; })
    .catch((e) => { installing = { ...installing, error: 'The download did not finish: ' + e.message, done: true }; })
    .finally(stopWorker);
  return installing;
}

// ------------------------------------------------------------------ audio decoding (WAV or raw 16-bit PCM -> 16 kHz mono float)
function resample(samples, rate) {
  if (rate === TARGET_RATE) return samples;
  const ratio = rate / TARGET_RATE, n = Math.floor(samples.length / ratio), out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.floor(i * ratio), b = Math.min(samples.length, Math.max(a + 1, Math.floor((i + 1) * ratio)));
    if (ratio > 1) { let s = 0; for (let k = a; k < b; k++) s += samples[k]; out[i] = s / (b - a); } // average the window when shrinking
    else { const f = i * ratio - a, x0 = samples[a], x1 = samples[Math.min(samples.length - 1, a + 1)]; out[i] = x0 + (x1 - x0) * f; }
  }
  return out;
}

function decodeAudio(buf, contentType = '') {
  if (!buf || !buf.length) throw bad('No audio was received.');
  let samples, rate;
  if (/pcm|raw|l16/i.test(contentType) && !(buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF')) {
    rate = Number((/rate=(\d+)/i.exec(contentType) || [])[1]) || TARGET_RATE;
    if (rate < 8000 || rate > 96000) throw bad('Unsupported sample rate.');
    const n = Math.floor(buf.length / 2); samples = new Float32Array(n);
    for (let i = 0; i < n; i++) samples[i] = buf.readInt16LE(i * 2) / 32768;
  } else if (buf.length > 44 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WAVE') {
    let p = 12, fmt = null, data = null;
    while (p + 8 <= buf.length) {
      const id = buf.toString('ascii', p, p + 4), sz = buf.readUInt32LE(p + 4);
      if (id === 'fmt ') fmt = { tag: buf.readUInt16LE(p + 8), ch: buf.readUInt16LE(p + 10), rate: buf.readUInt32LE(p + 12), bits: buf.readUInt16LE(p + 22) };
      if (id === 'data') { data = buf.subarray(p + 8, p + 8 + Math.min(sz, buf.length - p - 8)); break; }
      p += 8 + sz + (sz & 1);
    }
    if (!fmt || !data) throw bad('That WAV file is damaged.');
    const bps = fmt.bits / 8, ok = (fmt.tag === 1 && [1, 2, 3, 4].includes(bps)) || (fmt.tag === 3 && bps === 4) || fmt.tag === 0xfffe;
    if (!ok || fmt.ch < 1 || fmt.ch > 2) throw bad('Unsupported WAV format. Use 16-bit PCM or 32-bit float, mono or stereo.', 415);
    const n = Math.floor(data.length / bps / fmt.ch); samples = new Float32Array(n); rate = fmt.rate;
    const rd = (o) => (fmt.tag === 3 ? data.readFloatLE(o) : bps === 2 ? data.readInt16LE(o) / 32768 : bps === 1 ? (data[o] - 128) / 128 : bps === 3 ? data.readIntLE(o, 3) / 8388608 : data.readInt32LE(o) / 2147483648);
    for (let i = 0; i < n; i++) { let s = 0; for (let c = 0; c < fmt.ch; c++) s += rd((i * fmt.ch + c) * bps); samples[i] = s / fmt.ch; }
  } else {
    throw bad('Unsupported audio format. Send a WAV file or raw 16-bit PCM (audio/pcm;rate=16000).', 415);
  }
  if (samples.length / rate > MAX_SECONDS) throw bad(`That recording is longer than ${MAX_SECONDS} seconds. Please keep a command short.`, 413);
  const out = resample(samples, rate);
  let peak = 0; for (let i = 0; i < out.length; i++) peak = Math.max(peak, Math.abs(out[i]));
  if (out.length < TARGET_RATE * 0.3) throw bad('That recording is too short.');
  return { samples: out, seconds: out.length / TARGET_RATE, silent: peak < 0.005 };
}

async function transcribe(buf, contentType, { hint } = {}) {
  const st = status();
  if (!st.active) throw bad('No on-device speech model is installed. The Owner can install one from the Voice panel.', 409);
  const a = decodeAudio(buf, contentType);
  if (a.silent) return { text: '', no_speech: true, language: null, model: st.active, seconds: a.seconds };
  if (hint && !/^[a-z]{2,3}$/.test(hint)) throw bad('Invalid language hint.');
  const raw = Buffer.from(a.samples.buffer, a.samples.byteOffset, a.samples.byteLength).toString('base64');
  const r = await serial(() => call({ cmd: 'transcribe', modelId: MODELS[st.active].id, dir: modelDir(), samples: raw, hint: hint || null }));
  return { text: r.text, language: r.language, language_confidence: r.language_confidence, language_candidates: r.language_candidates, no_speech: !!r.no_speech, unreliable: !!r.unreliable, model: st.active, seconds: Math.round(a.seconds * 10) / 10, took_ms: r.took_ms };
}

module.exports = { status, install, transcribe, decodeAudio, stopWorker, modelDir, MODELS, MAX_SECONDS };
