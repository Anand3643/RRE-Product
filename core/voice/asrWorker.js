/**
 * RRE Tally — on-device speech recognition worker (runs as a separate process, like the OCR worker).
 *
 * Runs a multilingual Whisper model locally with ONNX. It is isolated so a model problem or out-of-memory condition can never
 * take the application down. At run time remote downloads are DISABLED: the model must already be on this computer. Only the
 * explicit "install" command may fetch model files (from huggingface.co, no account or key needed) and only when the Owner asks.
 *
 * Messages in:  { id, cmd: 'install' | 'transcribe' | 'ping', ... }     Messages out: { id, ok, ... } and { type: 'progress', ... }
 */
const os = require('os');

const CODES = 'en zh de es ru ko fr ja pt tr pl ca nl ar sv it id hi fi vi he uk el ms cs ro da hu ta no th ur hr bg lt la mi ml cy sk te fa lv bn sr az sl kn et mk br eu is hy ne mn bs kk sq sw gl mr pa si km sn yo so af oc ka be tg sd gu am yi lo uz fo ht ps tk nn mt sa lb my bo tl mg as tt haw ln ha ba jw su'.split(' ');
const MAX_NEW_TOKENS = 80;

let lib = null, asr = null, loadedKey = null, langIds = null, sotId = null;

async function tools() { if (!lib) lib = await import('@huggingface/transformers'); return lib; }

async function load(modelId, dir, allowRemote, progress) {
  const key = `${modelId}|${dir}`;
  if (asr && loadedKey === key) return;
  const { pipeline, env } = await tools();
  env.cacheDir = dir; env.localModelPath = dir; env.allowLocalModels = true; env.allowRemoteModels = !!allowRemote; env.useBrowserCache = false;
  const threads = Math.max(2, Math.min(4, Math.floor(os.cpus().length / 2)));
  asr = await pipeline('automatic-speech-recognition', modelId, { dtype: 'q8', session_options: { intraOpNumThreads: threads }, progress_callback: progress || undefined });
  loadedKey = key;
  const tm = asr.tokenizer.model.tokens_to_ids;
  langIds = CODES.map((c) => tm.get(`<|${c}|>`));
  sotId = tm.get('<|startoftranscript|>');
}

/** Which language is being spoken? One decoder step over the language tokens. */
async function detect(audio) {
  const { Tensor } = await tools();
  const inputs = await asr.processor(audio);
  const out = await asr.model.forward({ input_features: inputs.input_features, decoder_input_ids: new Tensor('int64', BigInt64Array.from([BigInt(sotId)]), [1, 1]) });
  const logits = out.logits.data;
  let best = -1, bestV = -Infinity;
  const vals = [];
  for (let i = 0; i < langIds.length; i++) { if (langIds[i] === undefined) continue; const v = logits[langIds[i]]; vals.push([CODES[i], v]); if (v > bestV) { bestV = v; best = i; } }
  let sum = 0; for (const [, v] of vals) sum += Math.exp(v - bestV);
  const top = vals.map(([c, v]) => [c, Math.exp(v - bestV) / sum]).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([c, p]) => ({ code: c, p: Math.round(p * 100) / 100 }));
  return { code: CODES[best], confidence: Math.round((1 / sum) * 100) / 100, top };
}

/** Whisper sometimes loops on a phrase or labels silence/noise like "[Music]"; report that instead of passing it on as a command. */
function judge(text) {
  const t = String(text || '').trim();
  if (!t) return { text: '', no_speech: true };
  if (/^[\[(][^\])]{0,40}[\])]$/.test(t)) return { text: '', no_speech: true, label: t };
  const words = t.split(/\s+/);
  const grams = new Map();
  for (let i = 0; i + 2 < words.length; i++) { const g = words.slice(i, i + 3).join(' '); grams.set(g, (grams.get(g) || 0) + 1); }
  const maxRepeat = Math.max(0, ...grams.values());
  const chars = [...t.replace(/\s/g, '')];
  const unique = new Set(chars).size;
  if (maxRepeat >= 4 || (chars.length > 30 && unique / chars.length < 0.08)) return { text: t.slice(0, 120), unreliable: true };
  return { text: t };
}

async function transcribe(msg) {
  const { modelId, dir, hint } = msg;
  await load(modelId, dir, false);
  const buf = Buffer.from(msg.samples, 'base64');
  const audio = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 4)).slice(); // copy: alignment-safe
  const t0 = Date.now();
  const d = hint ? { code: hint, confidence: 1, top: [] } : await detect(audio);
  const out = await asr(audio, { task: 'transcribe', language: d.code, return_timestamps: false, no_repeat_ngram_size: 3, repetition_penalty: 1.15, max_new_tokens: MAX_NEW_TOKENS });
  const j = judge(out.text);
  return { ...j, language: d.code, language_confidence: d.confidence, language_candidates: d.top, took_ms: Date.now() - t0 };
}

process.on('message', async (m) => {
  const reply = (o) => process.send && process.send({ id: m.id, ...o });
  try {
    if (m.cmd === 'ping') return reply({ ok: true });
    if (m.cmd === 'install') {
      let last = -1;
      await load(m.modelId, m.dir, true, (p) => {
        if (p && p.status === 'progress') { const pct = Math.round(p.progress || 0); if (pct !== last) { last = pct; process.send({ type: 'progress', id: m.id, file: p.file, progress: pct }); } }
      });
      return reply({ ok: true });
    }
    if (m.cmd === 'transcribe') return reply({ ok: true, ...(await transcribe(m)) });
    reply({ ok: false, error: 'Unknown command' });
  } catch (e) {
    reply({ ok: false, error: String((e && e.message) || e).slice(0, 300) });
  }
});
if (process.send) process.send({ type: 'ready' });
