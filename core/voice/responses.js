/**
 * RRE Tally — multilingual voice: short reply sentences per language.
 *
 * These are fixed phrases written for this assistant, not machine translation. The figures an answer contains are shown on
 * screen in the application's usual form; the reply sentence tells the user, in their language, what happened.
 * Phrases for languages other than English have not been reviewed by native speakers: treat them as a good first version.
 * A language without phrases falls back to English and the response says so.
 */
const { registry, split } = require('./lexicon');

const PHRASES = {
  en: { opening: 'Opening {target}.', answer: 'Here is what I found.', screen: 'Details are shown on screen.', notUnderstood: 'Sorry, I did not understand that. Please try again.', confirm: 'Please check what I heard, then confirm.', denied: 'Your role does not allow that.', clarify: 'Which voucher type do you mean?', unsupported: 'I recognised {script} text, but I cannot understand that language yet. Please use one of the supported languages.', fallback: 'Replying in English, because {language} replies are not available.' },
  ta: { opening: '{target} திறக்கிறேன்.', answer: 'இதோ முடிவு.', screen: 'விவரங்கள் திரையில் உள்ளன.', notUnderstood: 'மன்னிக்கவும், புரியவில்லை. மீண்டும் சொல்லுங்கள்.', confirm: 'நான் கேட்டதைச் சரிபார்த்து உறுதிப்படுத்துங்கள்.', denied: 'உங்கள் பங்குக்கு இது அனுமதிக்கப்படவில்லை.', clarify: 'எந்த வகை வவுச்சர்?' },
  hi: { opening: '{target} खोल रहा हूँ।', answer: 'यह रहा परिणाम।', screen: 'विवरण स्क्रीन पर दिखाए गए हैं।', notUnderstood: 'माफ़ कीजिए, मैं समझ नहीं पाया। कृपया दोबारा बोलें।', confirm: 'कृपया जो मैंने सुना उसे जाँचकर पुष्टि करें।', denied: 'आपकी भूमिका को इसकी अनुमति नहीं है।', clarify: 'कौन-सा वाउचर प्रकार?' },
  te: { opening: '{target} తెరుస్తున్నాను.', answer: 'ఇదిగో ఫలితం.', screen: 'వివరాలు స్క్రీన్‌పై ఉన్నాయి.', notUnderstood: 'క్షమించండి, నాకు అర్థం కాలేదు. దయచేసి మళ్లీ చెప్పండి.', confirm: 'నేను విన్నది సరిచూసి నిర్ధారించండి.', denied: 'మీ పాత్రకు ఇది అనుమతి లేదు.', clarify: 'ఏ రకమైన వోచర్?' },
  ml: { opening: '{target} തുറക്കുന്നു.', answer: 'ഇതാ ഫലം.', screen: 'വിവരങ്ങൾ സ്ക്രീനിൽ കാണിച്ചിരിക്കുന്നു.', notUnderstood: 'ക്ഷമിക്കണം, മനസ്സിലായില്ല. ദയവായി വീണ്ടും പറയൂ.', confirm: 'ഞാൻ കേട്ടത് പരിശോധിച്ച് സ്ഥിരീകരിക്കൂ.', denied: 'നിങ്ങളുടെ റോളിന് ഇതിന് അനുമതിയില്ല.', clarify: 'ഏത് തരം വൗച്ചർ?' },
  kn: { opening: '{target} ತೆರೆಯುತ್ತಿದ್ದೇನೆ.', answer: 'ಇಲ್ಲಿದೆ ಫಲಿತಾಂಶ.', screen: 'ವಿವರಗಳು ಪರದೆಯ ಮೇಲಿವೆ.', notUnderstood: 'ಕ್ಷಮಿಸಿ, ಅರ್ಥವಾಗಲಿಲ್ಲ. ದಯವಿಟ್ಟು ಮತ್ತೆ ಹೇಳಿ.', confirm: 'ನಾನು ಕೇಳಿದ್ದನ್ನು ಪರಿಶೀಲಿಸಿ ದೃಢೀಕರಿಸಿ.', denied: 'ನಿಮ್ಮ ಪಾತ್ರಕ್ಕೆ ಇದಕ್ಕೆ ಅನುಮತಿ ಇಲ್ಲ.', clarify: 'ಯಾವ ಬಗೆಯ ವೋಚರ್?' },
  bn: { opening: '{target} খুলছি।', answer: 'এই যে ফলাফল।', screen: 'বিস্তারিত স্ক্রিনে দেখানো হয়েছে।', notUnderstood: 'দুঃখিত, বুঝতে পারিনি। অনুগ্রহ করে আবার বলুন।', confirm: 'আমি যা শুনেছি তা যাচাই করে নিশ্চিত করুন।', denied: 'আপনার ভূমিকায় এটির অনুমতি নেই।', clarify: 'কোন ধরনের ভাউচার?' },
  mr: { opening: '{target} उघडत आहे.', answer: 'हा घ्या निकाल.', screen: 'तपशील स्क्रीनवर दाखवले आहेत.', notUnderstood: 'क्षमस्व, मला समजले नाही. कृपया पुन्हा सांगा.', confirm: 'मी जे ऐकले ते तपासून खात्री करा.', denied: 'तुमच्या भूमिकेला याची परवानगी नाही.', clarify: 'कोणत्या प्रकारचे व्हाउचर?' },
  gu: { opening: '{target} ખોલી રહ્યો છું.', answer: 'આ રહ્યું પરિણામ.', screen: 'વિગતો સ્ક્રીન પર બતાવી છે.', notUnderstood: 'માફ કરશો, હું સમજી શક્યો નથી. કૃપા કરીને ફરી કહો.', confirm: 'મેં જે સાંભળ્યું તે તપાસીને પુષ્ટિ કરો.', denied: 'તમારી ભૂમિકાને આની પરવાનગી નથી.', clarify: 'કયા પ્રકારનું વાઉચર?' },
  pa: { opening: '{target} ਖੋਲ੍ਹ ਰਿਹਾ ਹਾਂ।', answer: 'ਇਹ ਰਿਹਾ ਨਤੀਜਾ।', screen: 'ਵੇਰਵੇ ਸਕਰੀਨ \'ਤੇ ਦਿਖਾਏ ਗਏ ਹਨ।', notUnderstood: 'ਮਾਫ਼ ਕਰਨਾ, ਮੈਨੂੰ ਸਮਝ ਨਹੀਂ ਆਇਆ। ਕਿਰਪਾ ਕਰਕੇ ਦੁਬਾਰਾ ਬੋਲੋ।', confirm: 'ਜੋ ਮੈਂ ਸੁਣਿਆ ਉਸਨੂੰ ਜਾਂਚ ਕੇ ਪੁਸ਼ਟੀ ਕਰੋ।', denied: 'ਤੁਹਾਡੀ ਭੂਮਿਕਾ ਨੂੰ ਇਸਦੀ ਇਜਾਜ਼ਤ ਨਹੀਂ ਹੈ।', clarify: 'ਕਿਹੜੀ ਕਿਸਮ ਦਾ ਵਾਊਚਰ?' },
  ur: { opening: '{target} کھول رہا ہوں۔', answer: 'یہ رہا نتیجہ۔', screen: 'تفصیلات اسکرین پر دکھائی گئی ہیں۔', notUnderstood: 'معاف کیجیے، میں سمجھ نہیں سکا۔ براہِ کرم دوبارہ بولیں۔', confirm: 'جو میں نے سنا اسے جانچ کر تصدیق کریں۔', denied: 'آپ کے کردار کو اس کی اجازت نہیں ہے۔', clarify: 'کون سی قسم کا واؤچر؟' },
  ar: { opening: 'جارٍ فتح {target}.', answer: 'إليك النتيجة.', screen: 'التفاصيل معروضة على الشاشة.', notUnderstood: 'عذرًا، لم أفهم. يرجى المحاولة مرة أخرى.', confirm: 'يرجى مراجعة ما سمعته ثم التأكيد.', denied: 'صلاحيات دورك لا تسمح بذلك.', clarify: 'أي نوع من السندات تقصد؟' },
  fr: { opening: 'J\'ouvre {target}.', answer: 'Voici le résultat.', screen: 'Les détails sont affichés à l\'écran.', notUnderstood: 'Désolé, je n\'ai pas compris. Veuillez réessayer.', confirm: 'Vérifiez ce que j\'ai entendu, puis confirmez.', denied: 'Votre rôle ne permet pas cela.', clarify: 'Quel type de pièce ?' },
  de: { opening: 'Ich öffne {target}.', answer: 'Hier ist das Ergebnis.', screen: 'Die Details sind auf dem Bildschirm zu sehen.', notUnderstood: 'Entschuldigung, das habe ich nicht verstanden. Bitte versuchen Sie es erneut.', confirm: 'Bitte prüfen Sie, was ich gehört habe, und bestätigen Sie.', denied: 'Ihre Rolle erlaubt das nicht.', clarify: 'Welche Belegart meinen Sie?' },
  es: { opening: 'Abriendo {target}.', answer: 'Aquí está el resultado.', screen: 'Los detalles se muestran en pantalla.', notUnderstood: 'Lo siento, no entendí. Inténtalo de nuevo.', confirm: 'Revisa lo que escuché y confirma.', denied: 'Tu rol no permite eso.', clarify: '¿Qué tipo de comprobante?' },
  zh: { opening: '正在打开{target}。', answer: '结果如下。', screen: '详细信息显示在屏幕上。', notUnderstood: '抱歉，我没听懂，请再说一遍。', confirm: '请检查我听到的内容，然后确认。', denied: '您的角色没有此权限。', clarify: '请问是哪种凭证？' },
  ja: { opening: '{target}を開きます。', answer: '結果はこちらです。', screen: '詳細は画面に表示されています。', notUnderstood: 'すみません、聞き取れませんでした。もう一度お願いします。', confirm: '聞き取った内容を確認してから実行してください。', denied: 'あなたの権限ではできません。', clarify: 'どの伝票の種類ですか？' },
  ko: { opening: '{target}을(를) 엽니다.', answer: '결과는 다음과 같습니다.', screen: '자세한 내용은 화면에 표시됩니다.', notUnderstood: '죄송합니다, 이해하지 못했습니다. 다시 말씀해 주세요.', confirm: '제가 들은 내용을 확인한 뒤 확정해 주세요.', denied: '현재 역할로는 허용되지 않습니다.', clarify: '어떤 전표 유형인가요?' }
};

// Display names for places the assistant opens that have no word in the lexicon
const TITLE_NAMES = { 'Day Book': 'Day Book', 'Bills Outstandings': 'Bills Outstandings', 'Profit & Loss A/c': 'Profit & Loss A/c', 'Live Business Dashboard': 'Dashboard', 'Chart of Accounts': 'Chart of Accounts' };

/** Name of the thing being opened, in the reply language when the lexicon has a word for it. */
function targetName(intent, lang) {
  const byLang = registry.terms[intent.concept] && registry.terms[intent.concept][lang];
  const first = byLang ? split(byLang)[0] : null;
  const fallback = TITLE_NAMES[intent.title] || intent.title || intent.voucherType || '';
  if (!first) return fallback;
  if (intent.kind === 'create_voucher') return lang === 'en' ? fallback : first;
  return first;
}

/** Picks the reply language. `preferred` ('auto' or a code) wins when we have phrases for it. Always says when it had to fall back. */
function pickLanguage(detected, preferred) {
  const want = preferred && preferred !== 'auto' ? preferred : detected;
  if (want && PHRASES[want]) return { code: want, fellBackFrom: null };
  return { code: 'en', fellBackFrom: want || null };
}

function phrase(lang, key, vars = {}) {
  const t = (PHRASES[lang] && PHRASES[lang][key]) || PHRASES.en[key] || '';
  return t.replace(/\{(\w+)\}/g, (m, k) => (vars[k] == null ? m : vars[k]));
}

const supportedReplyLanguages = () => Object.keys(PHRASES).filter((c) => registry.languages[c]);

module.exports = { phrase, pickLanguage, targetName, supportedReplyLanguages, PHRASES };
