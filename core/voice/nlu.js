/**
 * RRE Tally — multilingual voice: language identification and command understanding on TEXT.
 *
 * Input is a transcript from any speech provider (or typed text). Output is which language(s) were used, the accounting concepts
 * found, and the intent. It knows nothing about audio, screens or the database, so recognition, understanding and
 * actions stay independent. Rule-based and offline: it understands the words in lexicon.js and nothing else.
 */
const { registry, split } = require('./lexicon');

const LATIN = 'latin';

// ------------------------------------------------------------------ text helpers
const stripMarks = (s) => s.normalize('NFD').replace(/\p{M}/gu, '');
function normalise(text) {
  return String(text || '').normalize('NFKC').replace(/[​-‍⁠﻿]/g, '').toLowerCase().trim();
}

function scriptOf(ch) {
  const cp = ch.codePointAt(0);
  for (const [name, ranges] of Object.entries(registry.scripts)) for (const [a, b] of ranges) if (cp >= a && cp <= b) return name;
  return null;
}

/** Numeric value of a decimal digit in any script (Devanagari, Tamil, Arabic-Indic ...). */
function digitValue(ch) {
  if (!/^\p{Nd}$/u.test(ch)) return null;
  let steps = 0, cp = ch.codePointAt(0);
  while (steps < 9 && /^\p{Nd}$/u.test(String.fromCodePoint(cp - 1))) { cp--; steps++; }
  return steps;
}
function extractAmounts(text) {
  const out = [];
  for (const m of String(text).normalize('NFKC').matchAll(/\p{Nd}[\p{Nd},]*(?:\.\p{Nd}+)?/gu)) {
    const ascii = [...m[0]].map((c) => (c === ',' || c === '.' ? c : String(digitValue(c)))).join('').replace(/,/g, '');
    const n = Number(ascii);
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

function tokenise(norm) {
  return norm.split(/[^\p{L}\p{M}\p{N}']+/u).filter(Boolean);
}

// ------------------------------------------------------------------ word matching
const isLatinWord = (w) => /^[\p{Script=Latin}\s'\-]+$/u.test(w);

function buildIndex() {
  // concept -> [{ word, lang, script, latin }]
  const idx = {};
  for (const [concept, byLang] of Object.entries(registry.terms)) {
    idx[concept] = [];
    for (const [lang, list] of Object.entries(byLang)) {
      if (!registry.languages[lang]) continue;
      const script = registry.languages[lang].script;
      for (const w of split(list)) {
        const n = normalise(w);
        idx[concept].push({ word: n, lang, latin: isLatinWord(n), script });
      }
    }
  }
  return idx;
}

/** True if `word` occurs in the utterance. Strictness depends on the script so short words do not match inside others. */
function wordHits(word, latin, script, tokens, joined, norm) {
  if (latin) {
    const w = stripMarks(word);
    if (/\s|-/.test(w)) return ` ${joined} `.includes(` ${w} `);
    return tokens.some((t) => t === w || t === w + 's' || (w.length >= 5 && t.startsWith(w)));
  }
  if (script === 'han' || script === 'kana' || script === 'hangul') return norm.includes(word);
  if (/\s/.test(word)) return norm.includes(word);
  const dravidian = script === 'tamil' || script === 'telugu' || script === 'kannada' || script === 'malayalam';
  return tokens.some((t) => {
    const tt = script === 'arabic' ? t.replace(/^ال/, '').replace(/^[وب]/, (m, off) => (t.length > 3 ? '' : m)) : t;
    if (tt === word || t === word) return true;
    if (dravidian) return word.length >= 3 && t.includes(word);
    return word.length >= 2 && (tt.startsWith(word) || t.startsWith(word));
  });
}

// ------------------------------------------------------------------ language identification
const URDU_LETTERS = /[ٹڈڑںےھگچپژکیہ]/u;
const NATIVE_TOKEN = /[^\p{Script=Latin}\p{N}\s'\-.,?!]/u;

function identifyLanguages(norm, tokens, index) {
  const score = {};
  const add = (lang, w) => { score[lang] = (score[lang] || 0) + w; };
  const scriptCount = {};
  for (const ch of norm) { const s = scriptOf(ch); if (s && s !== LATIN) scriptCount[s] = (scriptCount[s] || 0) + 1; }
  const langsByScript = {};
  for (const [code, d] of Object.entries(registry.languages)) (langsByScript[d.script] = langsByScript[d.script] || []).push(code);

  // 1. script evidence (each non-Latin character counts toward the languages that use that script)
  const total = Object.values(scriptCount).reduce((a, b) => a + b, 0);
  const hasKana = !!scriptCount.kana;
  for (const [script, n] of Object.entries(scriptCount)) {
    let cands = langsByScript[script] || [];
    if (script === 'han') cands = hasKana ? ['ja'].filter((c) => registry.languages[c]) : (langsByScript.han || []);
    if (!cands.length) continue;
    // weight by share of characters, scaled to "token-like" units
    const units = Math.max(1, Math.round(n / 3));
    const share = units / cands.length;
    for (const c of cands) add(c, share);
  }
  // ja uses Han characters too: when kana is present, Han counts for Japanese
  if (hasKana && scriptCount.han && registry.languages.ja) add('ja', Math.max(1, Math.round(scriptCount.han / 3)));

  // 2. lexical evidence: markers and concept words
  const evidence = {};
  const hit = (lang, w, src) => { evidence[lang] = (evidence[lang] || 0) + w; };
  for (const [lang, list] of Object.entries(registry.markers)) {
    if (!registry.languages[lang]) continue;
    const d = registry.languages[lang];
    for (const w of split(list)) {
      const n = normalise(w);
      if (!n) continue;
      const latin = isLatinWord(n);
      if (d.script === 'han' || d.script === 'kana' || d.script === 'hangul') { if (norm.includes(n)) hit(lang, 0.5); continue; }
      if (latin) { if (tokens.includes(stripMarks(n))) hit(lang, 1); }
      else if (tokens.includes(n)) hit(lang, 1);
    }
  }
  const englishWords = new Set();
  for (const entries of Object.values(index)) for (const e of entries) if (e.lang === 'en') { englishWords.add(stripMarks(e.word)); for (const w of e.word.split(/\s+/)) englishWords.add(stripMarks(w)); }
  for (const concept of Object.keys(index)) {
    for (const e of index[concept]) {
      if (e.lang === 'en') continue;
      if (e.latin && englishWords.has(stripMarks(e.word))) continue; // shared loanword: do not attribute to another language
      if (wordHits(e.word, e.latin, e.script, tokens, tokens.join(' '), norm)) hit(e.lang, 1);
    }
  }
  // Latin-script languages need lexical evidence (script alone says nothing); Urdu vs Arabic also uses letters
  if (URDU_LETTERS.test(norm) && registry.languages.ur) hit('ur', 1.5);

  // 3. disambiguate scripts shared by several languages using the lexical evidence
  for (const [script, n] of Object.entries(scriptCount)) {
    const cands = (langsByScript[script] || []);
    if (cands.length < 2) continue;
    const best = cands.reduce((b, c) => ((evidence[c] || 0) > (evidence[b] || 0) ? c : b), cands[0]);
    const tie = cands.filter((c) => (evidence[c] || 0) === (evidence[best] || 0)).length > 1;
    const winner = tie ? (cands.includes('hi') ? 'hi' : cands.includes('ar') ? 'ar' : best) : best;
    const units = Math.max(1, Math.round(n / 3));
    for (const c of cands) delete score[c];
    score[winner] = (score[winner] || 0) + units;
  }
  for (const [lang, w] of Object.entries(evidence)) {
    const d = registry.languages[lang];
    if (d.script === LATIN || !scriptCount[d.script]) add(lang, w); // Latin lexical hits (romanised text)
    else if (!(langsByScript[d.script] || []).length) add(lang, w);
    else if ((langsByScript[d.script] || []).length === 1) add(lang, w);
  }
  // English: concept words found in English
  let enHits = 0;
  for (const concept of Object.keys(index)) for (const e of index[concept]) if (e.lang === 'en' && wordHits(e.word, true, LATIN, tokens, tokens.join(' '), norm)) enHits++;
  if (enHits) add('en', Math.min(enHits, 3) * 0.5);
  if (!Object.keys(score).length && /[a-z]/.test(norm)) add('en', 0.25);
  return { score, scriptCount, total };
}

function describeLanguages(norm, tokens, index) {
  const { score, scriptCount } = identifyLanguages(norm, tokens, index);
  // ties (e.g. a romanised word shared by Hindi, Bengali and Gujarati) go to the language with the most speakers first
  const PRIORITY = ['en', 'hi', 'ta', 'te', 'bn', 'mr', 'ml', 'kn', 'gu', 'pa', 'ur', 'ar', 'es', 'fr', 'de', 'zh', 'ja', 'ko'];
  const rank = (c) => { const i = PRIORITY.indexOf(c); return i < 0 ? 99 : i; };
  const entries = Object.entries(score).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1] || rank(a[0]) - rank(b[0]));
  const sum = entries.reduce((t, [, v]) => t + v, 0) || 1;
  const languages = entries.map(([code, v]) => ({ code, name: registry.languages[code].name, score: Math.round((v / sum) * 100) / 100 }));
  const nonEn = languages.filter((l) => l.code !== 'en');
  const primaryCode = nonEn.length && nonEn[0].score > 0 ? nonEn[0].code : (languages[0] ? languages[0].code : null);
  const supportedScripts = new Set(Object.values(registry.languages).map((l) => l.script));
  const unknownScripts = Object.keys(scriptCount).filter((s) => !supportedScripts.has(s));
  const primary = primaryCode ? { code: primaryCode, name: registry.languages[primaryCode].name, romanised: registry.languages[primaryCode].script !== LATIN && !scriptCount[registry.languages[primaryCode].script] } : null;
  return { languages, primary, mixed: languages.filter((l) => l.score >= 0.15).length > 1, unknownScripts };
}

// ------------------------------------------------------------------ concepts
function findConcepts(norm, tokens, index) {
  const joined = tokens.join(' ');
  const found = {};
  for (const [concept, entries] of Object.entries(index)) {
    for (const e of entries) {
      if (wordHits(e.word, e.latin, e.script, tokens, joined, norm)) { (found[concept] = found[concept] || []).push(e.word); }
    }
  }
  return found;
}

// ------------------------------------------------------------------ intent
const VOUCHER_TYPES = [['SALES', 'Sales'], ['PURCHASE', 'Purchase'], ['PAYMENT', 'Payment'], ['RECEIPT', 'Receipt'], ['CONTRA', 'Contra'], ['JOURNAL', 'Journal']];

function periodFrom(c) {
  if (c.YESTERDAY) return { key: 'yesterday', phrase: 'yesterday' };
  if (c.TODAY) return { key: 'today', phrase: 'today' };
  if (c.MONTH && c.LAST) return { key: 'last_month', phrase: 'last month' };
  if (c.YEAR && c.LAST) return { key: 'last_year', phrase: 'last year' };
  if (c.YEAR) return { key: 'this_year', phrase: 'this financial year' };
  if (c.MONTH) return { key: 'this_month', phrase: 'this month' };
  return null;
}

function decideIntent(c, amounts, period, context) {
  const has = (k) => !!c[k];
  const wantsView = has('OPEN') || has('REPORT');
  const asks = has('QUESTION');
  const noteVoucher = (has('DEBIT') || has('CREDIT')) && has('NOTE');

  if (has('CREATE')) {
    if (noteVoucher) return { kind: 'create_voucher', voucherType: has('DEBIT') ? 'Debit Note' : 'Credit Note', title: has('DEBIT') ? 'Create Debit Note' : 'Create Credit Note', sensitive: true, concept: has('DEBIT') ? 'DEBIT' : 'CREDIT' };
    const t = VOUCHER_TYPES.find(([k]) => has(k));
    if (t) return { kind: 'create_voucher', voucherType: t[1], title: `Create ${t[1]} Voucher`, sensitive: true, concept: t[0], amount: amounts[0] || null };
    if (has('VOUCHER')) return { kind: 'clarify', question: 'voucher_type' };
  }
  if (has('LOW') && has('STOCK')) return { kind: 'query', topic: 'low_stock', query: 'low stock items', concept: 'STOCK' };
  if (has('BALANCE_SHEET')) return { kind: 'navigate', title: 'Balance Sheet', concept: 'BALANCE_SHEET' };
  if (has('TRIAL_BALANCE')) return { kind: 'navigate', title: 'Trial Balance', concept: 'TRIAL_BALANCE' };
  if (has('DAYBOOK')) return { kind: 'navigate', title: 'Day Book', concept: 'DAYBOOK' };
  if (has('GST')) return { kind: 'navigate', title: 'GST Portal', concept: 'GST' };
  if (has('BANK')) return { kind: 'navigate', title: 'Bank Reconciliation', concept: 'BANK' };
  if (has('DASHBOARD')) return { kind: 'navigate', title: 'Live Business Dashboard', concept: 'DASHBOARD' };
  if (has('OUTSTANDING')) {
    if (asks && !has('OPEN')) return { kind: 'query', topic: 'overdue', query: 'which customers have overdue payments', concept: 'OUTSTANDING' };
    return { kind: 'navigate', title: 'Bills Outstandings', concept: 'OUTSTANDING' };
  }
  const p = period ? period.phrase : 'this month';
  if (!wantsView || asks) {
    if (has('SALES') && (asks || period)) return { kind: 'query', topic: 'sales', query: `total sales ${p}`, concept: 'SALES', period };
    if (has('PROFIT') || has('LOSS')) return { kind: 'query', topic: 'profit', query: `net profit ${p}`, concept: has('PROFIT') ? 'PROFIT' : 'LOSS', period };
    if (has('EXPENSE')) return { kind: 'query', topic: 'expenses', query: `expenses ${p}`, concept: 'EXPENSE', period };
  }
  if (has('PROFIT') || has('LOSS')) return { kind: 'navigate', title: 'Profit & Loss A/c', concept: has('PROFIT') ? 'PROFIT' : 'LOSS' };
  if (has('EXPENSE')) return { kind: 'navigate', title: 'Profit & Loss A/c', concept: 'EXPENSE' };
  if (has('STOCK')) return { kind: 'navigate', title: 'Stock Summary', concept: 'STOCK' };
  if (has('LEDGER')) return { kind: 'navigate', title: 'Chart of Accounts', concept: 'LEDGER' };
  if (has('SALES') || has('PURCHASE')) return { kind: 'navigate', title: 'Day Book', concept: has('SALES') ? 'SALES' : 'PURCHASE', note: 'register' };
  if (has('PAYMENT') || has('RECEIPT')) return { kind: 'navigate', title: 'Day Book', concept: has('PAYMENT') ? 'PAYMENT' : 'RECEIPT', note: 'register' };
  if (has('DEBIT') || has('CREDIT')) return { kind: 'navigate', title: 'Trial Balance', concept: has('DEBIT') ? 'DEBIT' : 'CREDIT' };
  // "and last month?" — only a period was said: repeat the previous question with the new period
  if (period && context && context.lastQuery) {
    const q = context.lastQuery;
    const phrase = period.phrase;
    const text = q.topic === 'sales' ? `total sales ${phrase}` : q.topic === 'profit' ? `net profit ${phrase}` : q.topic === 'expenses' ? `expenses ${phrase}` : null;
    if (text) return { kind: 'query', topic: q.topic, query: text, concept: q.concept, period, followUp: true };
  }
  return { kind: 'unknown' };
}

/** Understand one utterance. `context` (optional) is what the previous call returned, so follow-ups and language switches keep working. */
function interpret(text, context = null) {
  const original = String(text == null ? '' : text);
  if (original.length > 400) { const e = new Error('Please keep the command under 400 characters.'); e.status = 400; throw e; }
  const norm = normalise(original);
  const empty = { text: original, normalized: norm, languages: [], primary: null, mixed: false, supported: true, concepts: [], amounts: [], period: null, intent: { kind: 'unknown' }, confidence: 0 };
  if (!norm) return empty;
  const index = buildIndex();
  const tokens = tokenise(norm).map((t) => (isLatinWord(t) ? stripMarks(t) : t));
  const langs = describeLanguages(norm, tokens, index);
  const found = findConcepts(norm, tokens, index);
  const amounts = extractAmounts(original);
  const period = periodFrom(found);
  const intent = decideIntent(found, amounts, period, context);
  const conceptNames = Object.keys(found);

  // Text in a script we have no language for (Thai, Hebrew, Cyrillic ...) and nothing we can understand
  const supported = !(langs.unknownScripts.length && !conceptNames.length && !langs.languages.length);
  let confidence = 0;
  if (intent.kind !== 'unknown' && intent.kind !== 'clarify') confidence = conceptNames.length >= 3 ? 0.95 : conceptNames.length === 2 ? 0.85 : 0.65;
  else if (intent.kind === 'clarify') confidence = 0.5;
  else if (conceptNames.length) confidence = 0.3;

  // keep the conversation's language when this utterance carries no language evidence of its own (e.g. only a number or a name)
  const primary = langs.primary || (context && context.language ? { code: context.language, name: registry.languages[context.language]?.name, romanised: false } : null);
  return {
    text: original, normalized: norm, languages: langs.languages, primary, mixed: langs.mixed, supported,
    unsupported_scripts: langs.unknownScripts, concepts: conceptNames, matched: found, amounts, period, intent, confidence
  };
}

module.exports = { interpret, normalise, extractAmounts, tokenise, digitValue };
