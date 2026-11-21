/**
 * RRE Tally — multilingual Voice Assistant panel (button at the bottom-left, or Alt+Shift+V).
 * Shows what was heard (editable), what was understood, and the reply in the person's language. Sensitive commands wait for
 * the person to check and confirm. Voice only opens screens and reads answers; it never saves accounting entries.
 * Audio is sent anywhere only after the person agrees below, and the panel says exactly where.
 */
(function () {
  'use strict';
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const base = () => (typeof API_BASE !== 'undefined' ? API_BASE : '/api');
  const $ = (id) => document.getElementById(id);
  let caps = null, prefs = null, context = null, recorder = null, recog = null, pending = null, localRec = null, installTimer = null;

  async function call(path, opts = {}) {
    const res = await fetch(`${base()}/voice${path}`, { ...opts, headers: { ...(opts.headers || {}), ...(opts.body && typeof opts.body === 'string' ? { 'Content-Type': 'application/json' } : {}) } });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || j.success === false) { const e = new Error(j.error || `Request failed (${res.status})`); e.status = res.status; throw e; }
    return j.data;
  }
  const say = (h, cls) => { const el = $('vx-msg'); if (el) { el.className = 'text-[10px] ' + (cls || 'text-slate-500'); el.innerHTML = h; } };

  // ------------------------------------------------------------------ speaking (text-to-speech)
  function speak(text, locale) {
    if (!prefs || !prefs.speak_replies || !text) return;
    if (!('speechSynthesis' in window)) { say('Spoken replies are not available in this window; the reply is shown as text.'); return; }
    const voices = window.speechSynthesis.getVoices();
    const prefix = String(locale || 'en').split('-')[0].toLowerCase();
    const v = voices.find((x) => x.lang && x.lang.toLowerCase() === String(locale).toLowerCase()) || voices.find((x) => x.lang && x.lang.toLowerCase().startsWith(prefix));
    if (!v) { say(`No voice for this language is installed on this computer (${esc(locale)}), so the reply is shown as text only. You can add a voice in Windows Settings → Time & language → Speech.`); return; }
    const u = new SpeechSynthesisUtterance(text); u.voice = v; u.lang = v.lang;
    window.speechSynthesis.cancel(); window.speechSynthesis.speak(u);
  }

  // ------------------------------------------------------------------ doing what was asked
  function openScreen(title) {
    const reg = typeof GOTO_REGISTRY !== 'undefined' ? GOTO_REGISTRY : null;
    const item = reg && reg.find((x) => x.title.toLowerCase().includes(title.toLowerCase()));
    if (!item) return false;
    try { item.action(); return true; } catch (e) { return false; }
  }

  function log(kind, html) {
    const box = $('vx-log'); if (!box) return;
    const d = document.createElement('div');
    d.className = kind === 'you' ? 'text-right' : '';
    d.innerHTML = `<span class="inline-block max-w-[92%] rounded px-2 py-1 ${kind === 'you' ? 'bg-slate-200' : 'bg-indigo-50 border border-indigo-100'}">${html}</span>`;
    box.appendChild(d); box.scrollTop = box.scrollHeight;
  }

  async function run(text, confirmed) {
    text = String(text || '').trim();
    if (!text) { say('Type or say something first.'); return; }
    if (!confirmed) log('you', esc(text));
    say('Working…');
    try {
      const r = await call('/execute', { method: 'POST', body: JSON.stringify({ text, context, confirmed: !!confirmed }) });
      context = r.context || context;
      const lang = r.language || {};
      $('vx-lang').innerHTML = lang.detected ? `Heard: <b>${esc(lang.detected_name)}</b>${lang.mixed ? ' (mixed languages)' : ''} · replying in <b>${esc((caps.understands.find((l) => l.code === lang.reply) || {}).name || lang.reply)}</b>` : '';
      pending = null; $('vx-confirm').classList.add('hidden');
      if (r.status === 'needs_confirmation') {
        pending = text; $('vx-confirm').classList.remove('hidden');
        log('bot', `${esc(r.reply)}<div class="text-[10px] text-slate-500 mt-0.5">Understood as: ${esc(r.interpretation.intent.title || r.interpretation.intent.query || r.interpretation.intent.kind)}. Correct the text above if it is wrong, then press Confirm.</div>`);
      } else if (r.status === 'ok' && r.action && r.action.type === 'navigate') {
        const ok = openScreen(r.action.title);
        log('bot', esc(r.reply) + (r.action.amount_heard ? `<div class="text-[10px] text-slate-500">Amount heard: ${esc(r.action.amount_heard)} — enter it on the form yourself.</div>` : '') + (ok ? '' : '<div class="text-[10px] text-amber-700">That screen is not available here.</div>'));
      } else if (r.status === 'ok' && r.action && r.action.type === 'answer') {
        log('bot', `${esc(r.reply)}<div class="mt-1 whitespace-pre-wrap text-[11px]">${esc(r.action.answer)}</div>`);
      } else {
        log('bot', esc(r.reply));
      }
      say('');
      speak(r.reply, (caps.understands.find((l) => l.code === lang.reply) || {}).tts_locale || 'en-IN');
    } catch (e) { say(esc(e.message), 'text-red-700'); }
  }

  // ------------------------------------------------------------------ listening
  function stopListening() { try { if (localRec) localRec.stop(); } catch (e) { /* ignore */ } try { if (recorder && recorder.state === 'recording') recorder.stop(); } catch (e) { /* ignore */ } try { if (recog) recog.stop(); } catch (e) { /* ignore */ } }

  // On-device recognition: record 16 kHz mono audio in the page, send it to this computer's own server, nothing leaves the PC.
  async function listenLocal() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
      const Ctx = window.AudioContext || window.webkitAudioContext;
      const ctx = new Ctx({ sampleRate: 16000 });
      const src = ctx.createMediaStreamSource(stream), proc = ctx.createScriptProcessor(4096, 1, 1), chunks = [];
      proc.onaudioprocess = (e) => chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
      src.connect(proc); proc.connect(ctx.destination);
      let done = false;
      const finish = async () => {
        if (done) return; done = true; localRec = null;
        try { proc.disconnect(); src.disconnect(); stream.getTracks().forEach((t) => t.stop()); const rate = ctx.sampleRate; await ctx.close(); $('vx-mic').classList.remove('bg-red-600');
          const n = chunks.reduce((t, c) => t + c.length, 0), pcm = new Int16Array(n); let o = 0;
          for (const c of chunks) for (let i = 0; i < c.length; i++) pcm[o++] = Math.max(-32768, Math.min(32767, Math.round(c[i] * 32767)));
          say('Recognising on this computer… (this can take several seconds)');
          const res = await fetch(`${base()}/voice/transcribe?provider=local`, { method: 'POST', headers: { 'Content-Type': `audio/pcm;rate=${rate}` }, body: pcm.buffer });
          const j = await res.json(); if (!res.ok || !j.success) throw new Error(j.error || 'Recognition failed');
          const d = j.data;
          if (d.no_speech || !d.text) { say('I did not catch any speech. Please try again, a little closer to the microphone.'); return; }
          $('vx-text').value = d.text;
          say(d.unreliable ? 'That recognition looks unreliable — please check the text before running it.' : `Heard in ${esc(((caps.understands.find((l) => l.code === d.language) || {}).name) || d.language || 'an unknown language')}. Check the text; it runs now unless it needs confirmation.`, d.unreliable ? 'text-amber-700' : 'text-slate-500');
          if (!d.unreliable) run(d.text, false);
        } catch (e) { say(esc(e.message), 'text-red-700'); }
      };
      localRec = { stop: finish };
      $('vx-mic').classList.add('bg-red-600'); say('Listening… press the mic again when you finish (up to 20 seconds).');
      setTimeout(finish, 20000);
    } catch (e) { say('The microphone could not be used: ' + esc(e.message), 'text-red-700'); }
  }

  async function listenCloud() {
    if (!prefs.cloud_consent) { say('Tick the consent box for the online service first. Nothing is recorded until you do.', 'text-amber-700'); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const chunks = []; recorder = new MediaRecorder(stream);
      recorder.ondataavailable = (e) => chunks.push(e.data);
      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop()); $('vx-mic').classList.remove('bg-red-600'); say('Recognising…');
        try {
          const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
          const res = await fetch(`${base()}/voice/transcribe`, { method: 'POST', headers: { 'Content-Type': blob.type }, body: blob });
          const j = await res.json(); if (!res.ok || !j.success) throw new Error(j.error || 'Recognition failed');
          $('vx-text').value = j.data.text; say(j.data.language ? 'Check the text, then press Run (it runs automatically unless it needs confirmation).' : 'Language not identified; check the text.');
          if (j.data.text) run(j.data.text, false);
        } catch (e) { say(esc(e.message), 'text-red-700'); }
      };
      recorder.start(); $('vx-mic').classList.add('bg-red-600'); say('Listening… press the mic again to stop (max about one minute).');
      setTimeout(() => { if (recorder && recorder.state === 'recording') recorder.stop(); }, 55000);
    } catch (e) { say('The microphone could not be used: ' + esc(e.message), 'text-red-700'); }
  }

  function listenBrowser() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { say('Browser speech recognition is not available here. Type the command instead, or ask the Owner to set up an online transcription service.', 'text-amber-700'); return; }
    if (!prefs.browser_consent) { say('Tick the consent box for browser recognition first. Nothing is recorded until you do.', 'text-amber-700'); return; }
    recog = new SR(); recog.lang = $('vx-speak-lang').value || navigator.language || 'en-IN'; recog.interimResults = false; recog.maxAlternatives = 1;
    recog.onresult = (e) => { const t = e.results[0][0].transcript; $('vx-text').value = t; run(t, false); };
    recog.onerror = (e) => say(e.error === 'network' || e.error === 'service-not-allowed' ? 'Browser recognition is not available in this app window (it needs the browser vendor\'s online service). Type the command instead.' : 'Could not recognise: ' + esc(e.error), 'text-red-700');
    recog.onend = () => $('vx-mic').classList.remove('bg-red-600');
    try { recog.start(); $('vx-mic').classList.add('bg-red-600'); say(`Listening in ${esc(recog.lang)}… (this method needs you to choose the language you will speak)`); } catch (e) { say(esc(e.message), 'text-red-700'); }
  }

  function toggleMic() {
    if (localRec || (recorder && recorder.state === 'recording') || (recog && $('vx-mic').classList.contains('bg-red-600'))) { stopListening(); return; }
    const local = caps.providers.find((p) => p.id === 'local'), cloud = caps.providers.find((p) => p.id === 'cloud');
    if (local && local.available) listenLocal(); else if (cloud && cloud.available) listenCloud(); else listenBrowser();
  }

  // ------------------------------------------------------------------ settings
  async function savePrefs(patch) {
    try { prefs = await call('/prefs', { method: 'POST', body: JSON.stringify(patch) }); say('Saved.', 'text-emerald-700'); } catch (e) { say(esc(e.message), 'text-red-700'); }
    renderProviders();
  }

  function renderLocal() {
    const el = $('vx-local'); if (!el) return;
    const m = caps.speech_models, active = m.active;
    const owner = typeof appState !== 'undefined' && appState.permissions && appState.permissions.canAlterCompany;
    const ins = m.installing && !m.installing.done ? m.installing : null;
    el.innerHTML = `<div class="font-bold">On-device speech recognition ${active ? '<span class="text-emerald-700">— ready (' + esc(active) + ')</span>' : '<span class="text-slate-500">— not installed</span>'}</div>
      <div class="text-[10px] text-slate-600">Runs on this computer: your voice never leaves it, no account or key. Detects the language you speak automatically.</div>
      ${active ? `<div class="text-[10px] text-slate-500">${esc((m.catalog.find((x) => x.key === active) || {}).quality || '')}</div>` : ''}
      ${ins ? `<div class="text-[10px] mt-1">Downloading ${esc(ins.model)}… ${esc(ins.progress)}% <span class="text-slate-500">${esc(ins.file || '')}</span></div>` :
        (m.installing && m.installing.error ? `<div class="text-[10px] text-red-700 mt-1">${esc(m.installing.error)}</div>` : '')}
      ${owner && !ins ? `<div class="flex flex-wrap items-center gap-1 mt-1"><select id="vx-model" class="border border-slate-300 rounded p-1 bg-white">${m.catalog.filter((x) => !x.installed).map((x) => `<option value="${x.key}" ${x.key === 'small' ? 'selected' : ''}>${esc(x.key)} — about ${x.size_mb} MB, ${esc(x.speed)}</option>`).join('')}</select>
        <button type="button" id="vx-install" class="px-2 py-1 rounded bg-indigo-700 hover:bg-indigo-800 text-white font-bold">Download &amp; install</button></div>
        <div class="text-[10px] text-slate-500">A one-time download from huggingface.co (no account). Afterwards it works offline. Larger models are more accurate but slower.</div>` : ''}
      ${!owner && !active ? '<div class="text-[10px] text-slate-500 mt-1">Ask the Owner to install a model from this panel.</div>' : ''}`;
    const b = $('vx-install');
    if (b) b.addEventListener('click', async () => {
      try { await call('/model/install', { method: 'POST', body: JSON.stringify({ model: $('vx-model').value }) }); pollModel(); } catch (e) { say(esc(e.message), 'text-red-700'); }
    });
    if (ins) pollModel();
  }

  function pollModel() {
    clearTimeout(installTimer);
    installTimer = setTimeout(async () => {
      try {
        caps.speech_models = await call('/model');
        const lp = caps.providers.find((p) => p.id === 'local'); if (lp) lp.available = !!caps.speech_models.active;
        renderLocal();
        if (caps.speech_models.installing && caps.speech_models.installing.done && !caps.speech_models.installing.error) say('The speech model is installed. You can now use the microphone.', 'text-emerald-700');
      } catch (e) { /* try again next time the panel opens */ }
    }, 2000);
  }

  function renderProviders() {
    const cloud = caps.providers.find((p) => p.id === 'cloud'), br = caps.providers.find((p) => p.id === 'browser');
    $('vx-providers').innerHTML = `
      <div class="font-bold">How your voice is turned into text</div>
      <div class="text-[10px] text-slate-600">Typing always works and sends nothing anywhere. ${esc(br.note)}</div>
      <label class="block mt-1"><input type="checkbox" id="vx-c-browser" ${prefs.browser_consent ? 'checked' : ''}> I agree my voice is sent to my browser's speech service (browser only).</label>
      ${cloud.available ? `<label class="block"><input type="checkbox" id="vx-c-cloud" ${prefs.cloud_consent ? 'checked' : ''}> I agree my recordings are sent to <b>${esc(cloud.endpoint_host)}</b> for transcription. They are not stored by RRE.</label>`
        : `<div class="text-[10px] text-slate-500 mt-1">Online transcription: ${esc(cloud.note)}</div>`}
      <div id="vx-local" class="mt-1 border border-slate-200 rounded p-1.5 bg-slate-50"></div>`;
    renderLocal();
    const cb = $('vx-c-browser'); if (cb) cb.addEventListener('change', () => savePrefs({ browser_consent: cb.checked }));
    const cc = $('vx-c-cloud'); if (cc) cc.addEventListener('change', () => savePrefs({ cloud_consent: cc.checked }));
  }

  async function open() {
    const panel = $('vx-panel'); if (!panel) return;
    panel.classList.toggle('hidden');
    if (panel.classList.contains('hidden')) { stopListening(); window.speechSynthesis && window.speechSynthesis.cancel(); return; }
    try {
      caps = await call('/capabilities'); prefs = caps.prefs;
      $('vx-reply-lang').innerHTML = '<option value="auto">Reply in the language I speak</option>' + caps.reply_languages.map((c) => `<option value="${c}">${esc((caps.understands.find((l) => l.code === c) || {}).name || c)} — ${esc((caps.understands.find((l) => l.code === c) || {}).native || '')}</option>`).join('');
      $('vx-speak-lang').innerHTML = '<option value="">Browser method: language I will speak…</option>' + caps.understands.map((l) => `<option value="${esc(l.stt_locale)}">${esc(l.name)}</option>`).join('');
      $('vx-reply-lang').value = prefs.reply_language; $('vx-speak').checked = prefs.speak_replies; $('vx-confirm-all').checked = prefs.confirm_all;
      $('vx-langs').textContent = `Understands ${caps.understands.length} languages: ${caps.understands.map((l) => l.name).join(', ')}.`;
      renderProviders(); $('vx-text').focus();
    } catch (e) { say(esc(e.message), 'text-red-700'); }
  }

  function build() {
    if ($('vx-btn')) return;
    const btn = document.createElement('button');
    btn.id = 'vx-btn'; btn.type = 'button'; btn.title = 'Voice Assistant (Alt+Shift+V)';
    btn.className = 'fixed left-3 bottom-3 z-40 w-9 h-9 rounded-full bg-indigo-700 hover:bg-indigo-800 text-white shadow-lg flex items-center justify-center text-base';
    btn.textContent = '🎙';
    btn.addEventListener('click', open);
    const panel = document.createElement('div');
    panel.id = 'vx-panel';
    panel.className = 'hidden fixed left-3 bottom-14 z-40 w-[26rem] max-w-[94vw] max-h-[80vh] overflow-y-auto bg-white border border-slate-300 rounded-lg shadow-2xl text-xs';
    panel.innerHTML = `
      <div class="bg-indigo-800 text-white font-bold p-2 flex items-center justify-between rounded-t-lg"><span>Voice Assistant</span><button type="button" id="vx-close" class="px-1.5 hover:bg-indigo-600 rounded">✕</button></div>
      <div class="p-3 space-y-2">
        <div id="vx-log" class="space-y-1 max-h-44 overflow-y-auto text-[11px]"></div>
        <div id="vx-lang" class="text-[10px] text-slate-600"></div>
        <div class="flex items-center gap-1">
          <input id="vx-text" maxlength="400" placeholder="Say or type a command in any supported language…" class="flex-1 border border-slate-300 rounded p-1.5 bg-white">
          <button type="button" id="vx-mic" title="Speak" class="px-2 py-1.5 rounded bg-slate-700 text-white font-bold">🎙</button>
          <button type="button" id="vx-run" class="px-2 py-1.5 rounded bg-emerald-600 hover:bg-emerald-700 text-white font-bold">Run</button>
        </div>
        <div id="vx-confirm" class="hidden bg-amber-50 border border-amber-200 rounded p-1.5 flex items-center gap-2"><span class="flex-1 text-[11px]">Check the text above, then:</span><button type="button" id="vx-confirm-btn" class="px-2 py-1 rounded bg-amber-600 hover:bg-amber-700 text-white font-bold">Confirm &amp; run</button></div>
        <div id="vx-msg" class="text-[10px] text-slate-500"></div>
        <div class="border-t border-slate-200 pt-2 space-y-1">
          <select id="vx-reply-lang" class="w-full border border-slate-300 rounded p-1 bg-white"></select>
          <select id="vx-speak-lang" class="w-full border border-slate-300 rounded p-1 bg-white"></select>
          <label class="block"><input type="checkbox" id="vx-speak"> Speak replies aloud</label>
          <label class="block"><input type="checkbox" id="vx-confirm-all"> Always ask me to confirm before running</label>
        </div>
        <div id="vx-providers" class="border-t border-slate-200 pt-2"></div>
        <div id="vx-langs" class="text-[10px] text-slate-500 border-t border-slate-200 pt-2"></div>
        <div class="text-[10px] text-slate-500">Voice opens screens and reads answers. It never saves entries. Replies are short fixed sentences in your language; figures appear on screen.</div>
      </div>`;
    document.body.appendChild(btn); document.body.appendChild(panel);
    $('vx-close').addEventListener('click', open);
    $('vx-run').addEventListener('click', () => run($('vx-text').value, false));
    $('vx-text').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); run($('vx-text').value, false); } });
    $('vx-confirm-btn').addEventListener('click', () => run($('vx-text').value, true));
    $('vx-mic').addEventListener('click', toggleMic);
    $('vx-reply-lang').addEventListener('change', (e) => savePrefs({ reply_language: e.target.value }));
    $('vx-speak').addEventListener('change', (e) => savePrefs({ speak_replies: e.target.checked }));
    $('vx-confirm-all').addEventListener('change', (e) => savePrefs({ confirm_all: e.target.checked }));
    document.addEventListener('keydown', (e) => { if (e.altKey && e.shiftKey && (e.key === 'V' || e.key === 'v')) { e.preventDefault(); open(); } });
  }

  function boot() { try { build(); } catch (e) { /* never break the application */ } }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
