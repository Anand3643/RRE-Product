/**
 * RRE Tally — multilingual voice: language data. DATA ONLY, no application logic.
 *
 * Two kinds of knowledge live here:
 *   LANGUAGES  every language the command understanding knows, with its script and voice locales.
 *   TERMS      accounting / navigation words per concept per language (native script and common romanised spellings).
 *              MARKERS are everyday words used only to tell languages apart (they carry no meaning).
 *
 * This is the list the assistant UNDERSTANDS. Which languages can be RECOGNISED from audio depends on the speech provider
 * (see stt.js) and is reported separately. The lists are extensible at runtime: registerLanguage(), addTerms(), loadExtensions().
 * Word lists are '|' separated. Matching rules are in nlu.js.
 */
const fs = require('fs');
const path = require('path');

const split = (s) => String(s || '').split('|').map((x) => x.trim()).filter(Boolean);

// script ids are keys of SCRIPT_RANGES below
const LANGUAGES = {
  en: { name: 'English', native: 'English', script: 'latin', tts: 'en-IN', stt: 'en-IN' },
  ta: { name: 'Tamil', native: 'தமிழ்', script: 'tamil', tts: 'ta-IN', stt: 'ta-IN' },
  hi: { name: 'Hindi', native: 'हिन्दी', script: 'devanagari', tts: 'hi-IN', stt: 'hi-IN' },
  te: { name: 'Telugu', native: 'తెలుగు', script: 'telugu', tts: 'te-IN', stt: 'te-IN' },
  ml: { name: 'Malayalam', native: 'മലയാളം', script: 'malayalam', tts: 'ml-IN', stt: 'ml-IN' },
  kn: { name: 'Kannada', native: 'ಕನ್ನಡ', script: 'kannada', tts: 'kn-IN', stt: 'kn-IN' },
  bn: { name: 'Bengali', native: 'বাংলা', script: 'bengali', tts: 'bn-IN', stt: 'bn-IN' },
  mr: { name: 'Marathi', native: 'मराठी', script: 'devanagari', tts: 'mr-IN', stt: 'mr-IN' },
  gu: { name: 'Gujarati', native: 'ગુજરાતી', script: 'gujarati', tts: 'gu-IN', stt: 'gu-IN' },
  pa: { name: 'Punjabi', native: 'ਪੰਜਾਬੀ', script: 'gurmukhi', tts: 'pa-IN', stt: 'pa-IN' },
  ur: { name: 'Urdu', native: 'اردو', script: 'arabic', tts: 'ur-PK', stt: 'ur-PK', rtl: true },
  ar: { name: 'Arabic', native: 'العربية', script: 'arabic', tts: 'ar-SA', stt: 'ar-SA', rtl: true },
  fr: { name: 'French', native: 'Français', script: 'latin', tts: 'fr-FR', stt: 'fr-FR' },
  de: { name: 'German', native: 'Deutsch', script: 'latin', tts: 'de-DE', stt: 'de-DE' },
  es: { name: 'Spanish', native: 'Español', script: 'latin', tts: 'es-ES', stt: 'es-ES' },
  zh: { name: 'Chinese', native: '中文', script: 'han', tts: 'zh-CN', stt: 'zh-CN' },
  ja: { name: 'Japanese', native: '日本語', script: 'kana', tts: 'ja-JP', stt: 'ja-JP' },
  ko: { name: 'Korean', native: '한국어', script: 'hangul', tts: 'ko-KR', stt: 'ko-KR' }
};

// Unicode ranges per script. Scripts with no registered language are reported as "recognised script, not supported".
const SCRIPT_RANGES = {
  latin: [[0x41, 0x5a], [0x61, 0x7a], [0xc0, 0x24f]],
  tamil: [[0x0b80, 0x0bff]], devanagari: [[0x0900, 0x097f]], telugu: [[0x0c00, 0x0c7f]], kannada: [[0x0c80, 0x0cff]],
  malayalam: [[0x0d00, 0x0d7f]], bengali: [[0x0980, 0x09ff]], gujarati: [[0x0a80, 0x0aff]], gurmukhi: [[0x0a00, 0x0a7f]],
  arabic: [[0x0600, 0x06ff], [0x0750, 0x077f], [0xfb50, 0xfdff], [0xfe70, 0xfeff]],
  han: [[0x4e00, 0x9fff], [0x3400, 0x4dbf]], kana: [[0x3040, 0x30ff]], hangul: [[0xac00, 0xd7af], [0x1100, 0x11ff], [0x3130, 0x318f]],
  thai: [[0x0e00, 0x0e7f]], hebrew: [[0x0590, 0x05ff]], cyrillic: [[0x0400, 0x04ff]], greek: [[0x0370, 0x03ff]], sinhala: [[0x0d80, 0x0dff]],
  myanmar: [[0x1000, 0x109f]], khmer: [[0x1780, 0x17ff]], ethiopic: [[0x1200, 0x137f]], georgian: [[0x10a0, 0x10ff]], armenian: [[0x0530, 0x058f]],
  tibetan: [[0x0f00, 0x0fff]], lao: [[0x0e80, 0x0eff]]
};
const SCRIPT_NAMES = { thai: 'Thai', hebrew: 'Hebrew', cyrillic: 'Cyrillic', greek: 'Greek', sinhala: 'Sinhala', myanmar: 'Burmese', khmer: 'Khmer', ethiopic: 'Ethiopic', georgian: 'Georgian', armenian: 'Armenian', tibetan: 'Tibetan', lao: 'Lao' };

// concept -> language -> words. The FIRST word of a language's list is the display name used when the assistant speaks about it.
const TERMS = {
  OPEN: { en: 'open|show|display|view|go to|launch|bring up|pull up|take me to', ta: 'திற|திறக்க|திறந்து|காட்டு|காண்பி|காட்டுங்க|பார்|kaattu|kaatunga|thira|thirandhu', hi: 'खोलो|खोलिए|खोल|दिखाओ|दिखाइए|दिखा|देखो|dikhao|dikhaiye|dikha|kholo|kholiye|dekho', te: 'తెరువు|తెరవండి|తెరు|చూపించు|చూపించండి|chupinchu|teruvu', ml: 'തുറക്കുക|തുറക്കൂ|തുറക്ക്|കാണിക്കുക|കാണിക്കൂ|kaanikku|thurakku|kaanikkuka', kn: 'ತೆರೆ|ತೆರೆಯಿರಿ|ತೋರಿಸು|ತೋರಿಸಿ|torisu|tereyiri', bn: 'খোলো|খুলুন|দেখাও|দেখান|kholo|dekhao', mr: 'उघडा|उघड|दाखवा|दाखव|ughda|dakhava', gu: 'ખોલો|ખોલ|બતાવો|બતાવ|batavo', pa: 'ਖੋਲ੍ਹੋ|ਖੋਲ੍ਹ|ਦਿਖਾਓ|ਦਿਖਾ|vikhao', ur: 'کھولو|کھولیں|کھولیے|دکھاؤ|دکھائیں|dikhao', ar: 'افتح|افتحي|اعرض|أظهر|أرني|عرض|اظهر', fr: 'ouvre|ouvrir|ouvrez|affiche|afficher|montre|montrer|voir', de: 'öffne|öffnen|zeige|zeig|anzeigen|zeigen|gehe zu', es: 'abre|abrir|abra|muestra|mostrar|muéstrame|ver|ir a', zh: '打开|开启|显示|查看|看看|展示', ja: '開いて|開く|開け|表示|見せて|見る', ko: '열어|열기|보여줘|보여주세요|표시|보기' },
  CREATE: { en: 'create|new|add|make|record|enter|post|raise', ta: 'உருவாக்கு|புதிய|சேர்|பதிவு|போடு|pudhu|puthu|pathivu|podu', hi: 'बनाओ|बनाइए|नया|नई|जोड़ो|दर्ज|banao|naya|nayi|jodo|darj', te: 'సృష్టించు|కొత్త|చేర్చు|నమోదు|kotha|kotta', ml: 'സൃഷ്ടിക്കുക|പുതിയ|ചേർക്കുക|രേഖപ്പെടുത്തുക|puthiya|cherkku', kn: 'ರಚಿಸಿ|ಹೊಸ|ಸೇರಿಸಿ|ದಾಖಲಿಸಿ|hosa|rachisi', bn: 'তৈরি|তৈরী|নতুন|যোগ|notun|toiri', mr: 'तयार करा|नवीन|जोडा|नोंद|navin', gu: 'બનાવો|નવું|ઉમેરો|નોંધ|navu|banavo', pa: 'ਬਣਾਓ|ਨਵਾਂ|ਨਵੀਂ|ਜੋੜੋ|navan', ur: 'بناؤ|بنائیں|نیا|نئی|شامل کرو|naya', ar: 'أنشئ|إنشاء|جديد|أضف|سجل|انشئ', fr: 'créer|crée|nouveau|nouvelle|ajouter|ajoute|enregistrer', de: 'erstelle|erstellen|neu|neue|neuen|hinzufügen|anlegen|buchen', es: 'crear|crea|nuevo|nueva|añadir|agregar|registrar', zh: '创建|新建|添加|录入|新增|记录', ja: '作成|作って|新規|追加|登録|記録', ko: '만들어|생성|새로|추가|입력|기록' },
  QUESTION: { en: 'how much|what is|what\'s|total|how many|tell me|what are', ta: 'எவ்வளவு|எவ்ளோ|எத்தனை|மொத்தம்|evlo|evvalavu|evalavu|ethana|ethanai|mothham', hi: 'कितना|कितनी|कितने|कुल|kitna|kitni|kitne|kul', te: 'ఎంత|ఎన్ని|మొత్తం|enta|enni|motham', ml: 'എത്ര|ആകെ|ethra|aake', kn: 'ಎಷ್ಟು|ಒಟ್ಟು|eshtu|ottu', bn: 'কত|মোট|koto', mr: 'किती|एकूण|kiti|ekun', gu: 'કેટલું|કેટલા|કુલ|ketlu|ketla', pa: 'ਕਿੰਨਾ|ਕਿੰਨੇ|ਕੁੱਲ|kinna|kinne', ur: 'کتنا|کتنی|کتنے|کل', ar: 'كم|ما هو|إجمالي|المجموع|اجمالي', fr: 'combien|quel est|quelle est|quelles sont|total', de: 'wie viel|wieviel|wie hoch|gesamt|wie viele|summe', es: 'cuánto|cuanto|cuántos|cuántas|total|cuál es', zh: '多少|总共|总额|合计', ja: 'いくら|合計|どれくらい|総額|いくつ', ko: '얼마|총|합계|몇' },
  LAST: { en: 'last|previous|prior', ta: 'கடந்த|சென்ற|முந்தைய|போன|kadantha|kadandha|senra|munthaiya', hi: 'पिछले|पिछला|पिछली|pichle|pichla|pichli', te: 'గత|gata|gatha', ml: 'കഴിഞ്ഞ|kazhinja', kn: 'ಕಳೆದ|ಹಿಂದಿನ|kalede|hindina', bn: 'গত|আগের|gato|ager', mr: 'गेल्या|मागील|gelya|magil', gu: 'ગયા|પાછલા|gaya|pachhla', pa: 'ਪਿਛਲੇ|ਪਿਛਲਾ|pichhle', ur: 'پچھلے|پچھلا', ar: 'الماضي|السابق|الماضية|السابقة', fr: 'dernier|dernière|précédent|passé', de: 'letzten|letzter|letzte|vorigen|vergangenen', es: 'pasado|pasada|anterior|último', zh: '上个|上月|上一个', ja: '先月|前月', ko: '지난|저번' },
  MONTH: { en: 'month|monthly', ta: 'மாதம்|மாத|maatham|matham', hi: 'महीना|महीने|माह|mahina|mahine|mahinay', te: 'నెల|nela', ml: 'മാസം|മാസത്തെ|masam|maasam', kn: 'ತಿಂಗಳು|ತಿಂಗಳ|thingalu|tingalu', bn: 'মাস|mas', mr: 'महिना|महिन्या|mahina', gu: 'મહિનો|મહિને|મહિના|mahino', pa: 'ਮਹੀਨਾ|ਮਹੀਨੇ', ur: 'مہینہ|مہینے', ar: 'شهر|الشهر', fr: 'mois', de: 'monat|monats', es: 'mes', zh: '月', ja: '月', ko: '달|월' },
  YEAR: { en: 'year|yearly|annual', ta: 'வருடம்|ஆண்டு|varusham|varudam|aandu', hi: 'साल|वर्ष|saal|varsh', te: 'సంవత్సరం|ఏడాది|samvatsaram|edadi', ml: 'വർഷം|varsham', kn: 'ವರ್ಷ|varsha', bn: 'বছর|bochor', mr: 'वर्ष|varsh', gu: 'વર્ષ', pa: 'ਸਾਲ', ur: 'سال', ar: 'سنة|عام|السنة', fr: 'année|an', de: 'jahr|jahres', es: 'año', zh: '年', ja: '年', ko: '년|올해' },
  TODAY: { en: 'today', ta: 'இன்று|இன்னிக்கு|indru|inniku|innaiku|innikku', hi: 'आज|aaj', te: 'ఈ రోజు|ఈరోజు|ఇవాళ|eroju|ivala', ml: 'ഇന്ന്|innu', kn: 'ಇಂದು|indu', bn: 'আজ', mr: 'आज', gu: 'આજે|aaje', pa: 'ਅੱਜ|ajj', ur: 'آج', ar: 'اليوم', fr: 'aujourd\'hui', de: 'heute', es: 'hoy', zh: '今天', ja: '今日|きょう', ko: '오늘' },
  YESTERDAY: { en: 'yesterday', ta: 'நேற்று|நேத்து|netru|nethu', hi: 'बीते कल|beete kal', te: 'నిన్న|ninna', ml: 'ഇന്നലെ|innale', kn: 'ನಿನ್ನೆ|ninne', bn: 'গতকাল|gotokal', mr: 'काल|kaal', gu: 'ગઈકાલે|ગઈકાલ|gaikale', pa: 'ਬੀਤੇ ਕੱਲ੍ਹ', ur: 'گزشتہ کل', ar: 'أمس|امس', fr: 'hier', de: 'gestern', es: 'ayer', zh: '昨天', ja: '昨日', ko: '어제' },
  SALES: { en: 'sales|sale|revenue|turnover', ta: 'விற்பனை|vilpanai|virpanai', hi: 'बिक्री|सेल|bikri|bikree', te: 'అమ్మకాలు|అమ్మకం|ammakalu|ammakam', ml: 'വിൽപ്പന|വില്പന|vilpana|vilppana', kn: 'ಮಾರಾಟ|maarata|marata', bn: 'বিক্রয়|বিক্রি|bikroy', mr: 'विक्री|vikri', gu: 'વેચાણ|vechan', pa: 'ਵਿਕਰੀ', ur: 'فروخت|بکری|farokht', ar: 'المبيعات|مبيعات|بيع', fr: 'ventes|vente|chiffre d\'affaires', de: 'verkäufe|umsatz|verkauf|vertrieb', es: 'ventas|venta|vendimos|vendido', zh: '销售额|销售|营业额', ja: '売上|売り上げ|販売', ko: '매출|판매' },
  PURCHASE: { en: 'purchase|purchases|buying|bought', ta: 'கொள்முதல்|வாங்கல்|kolmudhal|kolmuthal|vaangal', hi: 'खरीद|खरीदारी|kharid|kharidari|kharidi', te: 'కొనుగోలు|konugolu', ml: 'വാങ്ങൽ|പർച്ചേസ്|vangal', kn: 'ಖರೀದಿ|kharidi', bn: 'ক্রয়|কেনা|kroy', mr: 'खरेदी|kharedi', gu: 'ખરીદી', pa: 'ਖਰੀਦ', ur: 'خریداری|خرید|khareed', ar: 'المشتريات|مشتريات|شراء', fr: 'achats|achat', de: 'einkäufe|einkauf|bestellung', es: 'compras|compra', zh: '采购|购买|进货', ja: '仕入|購入', ko: '매입|구매|구입' },
  PAYMENT: { en: 'payment|payments|paid|pay', ta: 'செலுத்து|செலுத்தல்|கட்டணம்|selutthal|kattanam', hi: 'भुगतान|पेमेंट|bhugtan', te: 'చెల్లింపు|chellimpu', ml: 'പേയ്മെന്റ്|പണമടയ്ക്കൽ', kn: 'ಪಾವತಿ|pavati', bn: 'পেমেন্ট|প্রদান|পরিশোধ', mr: 'देयक|पेमेंट|deyak', gu: 'ચુકવણી|પેમેન્ટ|chukvani', pa: 'ਭੁਗਤਾਨ|ਅਦਾਇਗੀ', ur: 'ادائیگی|پیمنٹ|adaigi', ar: 'الدفع|دفع|مدفوعات|سداد', fr: 'paiement|paiements|règlement', de: 'zahlung|zahlungen|auszahlung', es: 'pago|pagos', zh: '付款|支付', ja: '支払|支払い', ko: '지급|결제|지불' },
  RECEIPT: { en: 'receipt|receipts|received', ta: 'ரசீது|பெறுதல்|raseedhu|raseed|peruthal', hi: 'रसीद|प्राप्ति|raseed|rasid|prapti', te: 'రసీదు|రశీదు|raseedu', ml: 'രസീത്|raseeth', kn: 'ರಸೀದಿ|rasidi', bn: 'রসিদ|প্রাপ্তি|rosid', mr: 'पावती|pavti|pavati', gu: 'રસીદ|પહોંચ', pa: 'ਰਸੀਦ', ur: 'رسید|raseed', ar: 'إيصال|ايصال|قبض', fr: 'reçu|encaissement|recette', de: 'quittung|einnahme|zahlungseingang', es: 'recibo|cobro|ingreso', zh: '收款|收据', ja: '領収書|入金|レシート', ko: '영수증|입금|수금' },
  CONTRA: { en: 'contra', hi: 'कॉन्ट्रा', ta: 'கான்ட்ரா' },
  JOURNAL: { en: 'journal', hi: 'जर्नल', ta: 'ஜர்னல்' },
  LEDGER: { en: 'ledger|ledgers|account', ta: 'பேரேடு|கணக்கேடு|perettu', hi: 'खाता-बही|खाताबही|खाता|बही|khata|bahi', te: 'ఖాతా|లెడ్జర్', ml: 'ലെഡ്ജർ|കണക്കുപുസ്തകം', kn: 'ಲೆಡ್ಜರ್|ಖಾತೆ', bn: 'খতিয়ান|লেজার|khotiyan', mr: 'खातेवही|खाते|khatevahi', gu: 'ખાતાવહી|ખાતું', pa: 'ਲੇਜਰ|ਖਾਤਾ', ur: 'کھاتہ|لیجر|khata', ar: 'دفتر الأستاذ|الأستاذ|حساب', fr: 'grand livre|registre|compte', de: 'hauptbuch|konto|kontenblatt', es: 'libro mayor|mayor|cuenta', zh: '总账|分类账|账簿', ja: '元帳|総勘定元帳|台帳', ko: '원장|장부|총계정원장' },
  STOCK: { en: 'stock|inventory|stocks', ta: 'இருப்பு|சரக்கு|சரக்குகள்|sarakku|irruppu', hi: 'स्टॉक|माल|भंडार|maal|bhandar', te: 'స్టాక్|సరుకు|నిల్వ|saruku|nilva', ml: 'സ്റ്റോക്ക്|ചരക്ക്|charakku', kn: 'ಸ್ಟಾಕ್|ದಾಸ್ತಾನು|dastaanu', bn: 'স্টক|মজুত|mojut', mr: 'साठा|स्टॉक|satha', gu: 'સ્ટોક|માલ|જથ્થો', pa: 'ਸਟਾਕ|ਮਾਲ', ur: 'اسٹاک|مال', ar: 'المخزون|مخزون|بضاعة', fr: 'stock|inventaire|stocks', de: 'lagerbestand|bestand|lager|inventar', es: 'inventario|existencias|stock', zh: '库存|存货', ja: '在庫|ストック', ko: '재고|스톡' },
  LOW: { en: 'low|short|running out|less|nearly', ta: 'குறைவான|குறைந்த|kuraivana|kuraindha|kuraivu', hi: 'कम|kam', te: 'తక్కువ|takkuva', ml: 'കുറഞ്ഞ|കുറവ്|kuranja|kuravu', kn: 'ಕಡಿಮೆ|kadime', bn: 'কম|kom', mr: 'कमी|kami', gu: 'ઓછું|ઓછો|ochhu', pa: 'ਘੱਟ|ghatt', ur: 'کم', ar: 'منخفض|منخفضة|قليل|أقل', fr: 'bas|faible|faibles', de: 'niedrig|niedrige|gering|knapp', es: 'bajo|bajas|baja|poco', zh: '不足|偏低|库存低|很少', ja: '少ない|低い|不足|少な', ko: '부족|낮은|적은|적음' },
  OUTSTANDING: { en: 'outstanding|outstandings|overdue|receivable|receivables|payable|payables|dues', ta: 'நிலுவை|பாக்கி|nilavai|niluvai|baaki|paakki', hi: 'बकाया|बाकी|baqaya|bakaya|baki', te: 'బకాయి|బాకీ|bakaayi|bakayi', ml: 'കുടിശ്ശിക|കുടിശിക|kudishika', kn: 'ಬಾಕಿ|baaki', bn: 'বকেয়া|bokeya', mr: 'थकबाकी|थकीत|thakbaki', gu: 'બાકી|baki', pa: 'ਬਕਾਇਆ|bakaya', ur: 'بقایا|baqaya', ar: 'مستحقات|مستحق|المتأخرات|غير مسدد', fr: 'impayés|impayé|créances|en attente|solde dû', de: 'offene posten|ausstehend|offene|offen', es: 'pendientes|pendiente|por cobrar|por pagar|adeudado', zh: '未付|未结|欠款|应收|应付|未收', ja: '未払い|未払|未収|未決済|売掛|買掛', ko: '미수금|미지급|미결제|외상|미수' },
  PROFIT: { en: 'profit|profits|earnings|margin', ta: 'லாபம்|இலாபம்|laabam|labam|laapam', hi: 'मुनाफ़ा|मुनाफा|लाभ|फायदा|munafa|labh|fayda', te: 'లాభం|labham', ml: 'ലാഭം|laabham|labham', kn: 'ಲಾಭ|laabha', bn: 'লাভ|মুনাফা|labh', mr: 'नफा|nafa', gu: 'નફો|nafo', pa: 'ਮੁਨਾਫ਼ਾ|ਮੁਨਾਫਾ|ਲਾਭ', ur: 'منافع|munafa', ar: 'الربح|ربح|أرباح', fr: 'bénéfice|profit|bénéfices', de: 'gewinn', es: 'ganancia|beneficio|utilidad|ganancias', zh: '利润|盈利', ja: '利益|儲け|純利益', ko: '이익|수익|순이익|이윤' },
  LOSS: { en: 'loss|losses', ta: 'நஷ்டம்|இழப்பு|nashtam|nastam|izhappu', hi: 'घाटा|नुकसान|ghata|nuksan', te: 'నష్టం', ml: 'നഷ്ടം', kn: 'ನಷ್ಟ|nashta', bn: 'ক্ষতি|লোকসান', mr: 'तोटा|tota', gu: 'નુકસાન|ખોટ|khot', pa: 'ਘਾਟਾ|ਨੁਕਸਾਨ', ur: 'نقصان|nuqsan', ar: 'خسارة|الخسارة', fr: 'perte|pertes', de: 'verlust', es: 'pérdida|pérdidas', zh: '亏损|损失', ja: '損失|赤字', ko: '손실|적자|손해' },
  BALANCE_SHEET: { en: 'balance sheet', ta: 'இருப்புநிலைக் குறிப்பு|இருப்பு நிலை|balance sheet', hi: 'बैलेंस शीट|तुलन पत्र|तुलन-पत्र', te: 'బ్యాలెన్స్ షీట్|ఆస్తి అప్పుల పట్టిక', ml: 'ബാലൻസ് ഷീറ്റ്', kn: 'ಬ್ಯಾಲೆನ್ಸ್ ಶೀಟ್', bn: 'ব্যালেন্স শিট|স্থিতিপত্র', mr: 'ताळेबंद|बॅलन्स शीट|talebandh', gu: 'સરવૈયું|બેલેન્સ શીટ|sarvaiyu', pa: 'ਬੈਲੇਂਸ ਸ਼ੀਟ', ur: 'بیلنس شیٹ', ar: 'الميزانية العمومية|الميزانية', fr: 'bilan', de: 'bilanz', es: 'balance general|balance', zh: '资产负债表', ja: '貸借対照表|バランスシート', ko: '재무상태표|대차대조표|밸런스시트' },
  TRIAL_BALANCE: { en: 'trial balance', hi: 'तलपट|ट्रायल बैलेंस', ta: 'trial balance', ar: 'ميزان المراجعة', fr: 'balance de vérification|balance générale', de: 'saldenliste|probebilanz', es: 'balance de comprobación', zh: '试算平衡表', ja: '試算表', ko: '시산표' },
  DAYBOOK: { en: 'day book|daybook|day-book', hi: 'रोज़नामचा|डे बुक', ar: 'دفتر اليومية', fr: 'journal du jour|livre journal', de: 'tagesbuch', es: 'libro diario', zh: '日记账', ja: '日記帳', ko: '일계표' },
  GST: { en: 'gst|tax', ta: 'ஜிஎஸ்டி', hi: 'जीएसटी', te: 'జీఎస్టీ', ml: 'ജിഎസ്ടി', kn: 'ಜಿಎಸ್ಟಿ', bn: 'জিএসটি', mr: 'जीएसटी', gu: 'જીએસટી', pa: 'ਜੀਐਸਟੀ', ur: 'جی ایس ٹی', ar: 'ضريبة القيمة المضافة|جي إس تي', fr: 'tva|gst', de: 'mehrwertsteuer|mwst', es: 'iva|gst', zh: '商品及服务税|消费税', ja: '消費税', ko: '부가세|부가가치세' },
  DEBIT: { en: 'debit', ta: 'பற்று|patru', hi: 'डेबिट|नामे|naame', te: 'డెబిట్', ml: 'ഡെബിറ്റ്', kn: 'ಡೆಬಿಟ್', bn: 'ডেবিট', mr: 'डेबिट|नावे|nave', gu: 'ડેબિટ|ઉધાર|udhar', pa: 'ਡੈਬਿਟ', ur: 'ڈیبٹ', ar: 'مدين', fr: 'débit', de: 'soll|lastschrift', es: 'débito|debe', zh: '借方|借记', ja: '借方|借記|デビット', ko: '차변|직불|데빗' },
  CREDIT: { en: 'credit', ta: 'வரவு|varavu', hi: 'क्रेडिट|जमा|jama', te: 'క్రెడిట్|జమ', ml: 'ക്രെഡിറ്റ്', kn: 'ಕ್ರೆಡಿಟ್', bn: 'ক্রেডিট', mr: 'क्रेडिट', gu: 'ક્રેડિટ', pa: 'ਕ੍ਰੈਡਿਟ', ur: 'کریڈٹ', ar: 'دائن', fr: 'crédit', de: 'haben|gutschrift', es: 'crédito|haber', zh: '贷方|贷记', ja: '貸方|貸記|クレジット', ko: '대변|신용|크레딧' },
  NOTE: { en: 'note|notes', ta: 'குறிப்பு', hi: 'नोट', ar: 'إشعار', fr: 'note|avoir', de: 'gutschrift', es: 'nota', zh: '通知单|票据', ja: 'ノート', ko: '노트' },
  VOUCHER: { en: 'voucher|vouchers|entry', ta: 'பற்றுச்சீட்டு|வவுச்சர்|vaucher', hi: 'वाउचर', te: 'వోచర్', ml: 'വൗച്ചർ', kn: 'ವೋಚರ್', bn: 'ভাউচার', mr: 'व्हाउचर', gu: 'વાઉચર', pa: 'ਵਾਊਚਰ', ur: 'واؤچر', ar: 'قسيمة|سند', fr: 'pièce comptable|bon|justificatif', de: 'buchungsbeleg|gutschein|beleg', es: 'comprobante|asiento|voucher', zh: '凭证', ja: '伝票|バウチャー', ko: '전표|바우처' },
  REPORT: { en: 'report|reports|statement', ta: 'அறிக்கை|arikkai', hi: 'रिपोर्ट|प्रतिवेदन', te: 'నివేదిక|రిపోర్ట్|nivedika', ml: 'റിപ്പോർട്ട്|റിപ്പോര്‍ട്ട്', kn: 'ವರದಿ|ರಿಪೋರ್ಟ್', bn: 'রিপোর্ট|প্রতিবেদন', mr: 'अहवाल|रिपोर्ट|ahaval', gu: 'અહેવાલ|રિપોર્ટ|ahevaal', pa: 'ਰਿਪੋਰਟ', ur: 'رپورٹ', ar: 'تقرير', fr: 'rapport', de: 'bericht|report', es: 'informe|reporte', zh: '报表|报告', ja: 'レポート|報告書|報告', ko: '보고서|리포트' },
  BANK: { en: 'bank|banking|reconciliation', ta: 'வங்கி|vangi', hi: 'बैंक', te: 'బ్యాంకు|బ్యాంక్|bankku', ml: 'ബാങ്ക്', kn: 'ಬ್ಯಾಂಕ್', bn: 'ব্যাংক|ব্যাঙ্ক', mr: 'बँक', gu: 'બેંક', pa: 'ਬੈਂਕ', ur: 'بینک', ar: 'البنك|بنك|مصرف', fr: 'banque', de: 'bank', es: 'banco', zh: '银行', ja: '銀行|バンク', ko: '은행|뱅크' },
  DASHBOARD: { en: 'dashboard|overview', ta: 'டாஷ்போர்டு', hi: 'डैशबोर्ड', ar: 'لوحة التحكم', fr: 'tableau de bord', de: 'dashboard|übersicht', es: 'panel|tablero', zh: '仪表板|仪表盘', ja: 'ダッシュボード', ko: '대시보드' },
  EXPENSE: { en: 'expense|expenses|cost|costs|spending', ta: 'செலவு|செலவுகள்|selavu|selavugal', hi: 'खर्च|खर्चा|kharch|kharcha', te: 'ఖర్చు|ఖర్చులు|kharchu', ml: 'ചെലവ്|ചെലവുകൾ|chelavu', kn: 'ಖರ್ಚು|kharchu', bn: 'খরচ|khoroch', mr: 'खर्च', gu: 'ખર્ચ|kharch', pa: 'ਖਰਚ|kharcha', ur: 'اخراجات|خرچ|kharcha', ar: 'مصروفات|مصاريف|مصروف', fr: 'dépenses|dépense|charges', de: 'ausgaben|kosten|aufwand', es: 'gastos|gasto', zh: '费用|支出|开支', ja: '経費|費用|支出', ko: '비용|지출|경비' },
  PRODUCTS: { en: 'products|items|goods', ta: 'பொருட்கள்|பொருள்|porutkal|porul', hi: 'उत्पाद|सामान|samaan|saman', te: 'ఉత్పత్తులు|వస్తువులు|vasthuvulu', ml: 'ഉൽപ്പന്നങ്ങൾ|സാധനങ്ങൾ', kn: 'ಉತ್ಪನ್ನಗಳು|ವಸ್ತುಗಳು', bn: 'পণ্য|পণ্যগুলো', mr: 'उत्पादने|वस्तू', gu: 'ઉત્પાદનો|વસ્તુઓ', pa: 'ਉਤਪਾਦ|ਸਮਾਨ', ur: 'مصنوعات|اشیاء', ar: 'المنتجات|منتجات', fr: 'produits|articles', de: 'produkte|artikel|waren', es: 'productos|artículos', zh: '产品|商品', ja: '商品|製品', ko: '제품|상품' }
};

// Words that carry no meaning but identify a language (used for romanised text, where script gives nothing away)
const MARKERS = {
  ta: 'pannu|pannunga|panni|panunga|enna|evlo|evvalavu|irukku|irukka|indha|intha|sollu|venum|vendum|seyyu|kudu|kodu|neenga|இப்போ|இந்த|என்ன|இருக்கு|பண்ணு|பண்ணுங்க|சொல்லு|வேணும்|காட்டு',
  hi: 'mein|hai|hain|kitna|kitni|kitne|dikhao|dikhaiye|karo|kijiye|batao|bataiye|kya|mujhe|humein|mera|meri|mere|ka|ki|ke|ko|है|हैं|में|का|की|के|को|मुझे|क्या|कितना|कितनी|कितने|दिखाओ|खोलो|बताओ|करो',
  te: 'chupinchu|chupinchandi|enta|enni|cheyyi|cheyandi|undi|kavali|ledu|ఉంది|కావాలి|ఏమిటి|చూపించు|చేయి|ఈ',
  ml: 'kaanikku|thurakku|ethra|aanu|undu|venam|cheyyu|ആണ്|ഉണ്ട്|വേണം|ഈ|എത്ര|കാണിക്കൂ',
  kn: 'torisu|tereyiri|eshtu|ide|beku|maadi|ಇದೆ|ಬೇಕು|ಈ|ಎಷ್ಟು|ತೋರಿಸು|ಮಾಡಿ',
  bn: 'dekhao|koto|ache|dao|koro|korun|আছে|কত|দেখাও|করো|এই|দাও',
  mr: 'dakhava|ughda|kiti|aahe|aahet|pahije|kara|आहे|आहेत|किती|दाखवा|उघडा|माझे|मला|काय|मध्ये|ची|चा|चे',
  gu: 'batavo|ketlu|chhe|joie|છે|કેટલું|બતાવો|મને|આ|માં',
  pa: 'vikhao|kinna|dasso|ਹੈ|ਕਿੰਨਾ|ਦਿਖਾਓ|ਮੈਨੂੰ|ਦਾ|ਦੀ|ਵਿੱਚ',
  ur: 'ہے|ہیں|کتنا|کتنی|کتنے|دکھاؤ|دکھائیں|کھولو|کا|کی|کے|میں|کو|مجھے|کیا',
  ar: 'هل|ما|كم|في|من|على|لي|أرني|اعرض|افتح|أظهر',
  fr: 'le|les|des|du|ouvre|ouvrir|affiche|afficher|montre|montrer|ventes|achats|mes|mon|quel|quelle|quelles|quels|combien|donne|dernier|dernière|mois|aujourd\'hui|hier|vous|plaît|je|veux|dans|sont',
  de: 'zeige|zeig|öffne|öffnen|der|die|das|den|dem|mein|meine|meinen|wie|viel|viele|hoch|letzten|diesen|dieses|monat|bitte|ist|sind|ich|möchte|für|und|alle',
  es: 'muestra|muéstrame|abre|abrir|el|los|las|del|mis|mi|cuánto|cuanto|cuántos|este|esta|ventas|compras|por|favor|quiero|dame|dime|mes|hoy|ayer|pasado|cuál|están',
  zh: '请|我|的|是|吗|呢|帮|给',
  ja: 'を|は|が|の|ください|お願い|です|ます|して',
  ko: '을|를|은|는|이|가|줘|주세요|입니다|해'
};

const registry = { languages: { ...LANGUAGES }, terms: JSON.parse(JSON.stringify(TERMS)), markers: { ...MARKERS }, scripts: { ...SCRIPT_RANGES } };

function registerLanguage(code, def) {
  if (!/^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(code)) throw new Error('Language code must look like "si" or "pt-BR".');
  if (!def || !def.name) throw new Error('A language needs a name.');
  const script = def.script || 'latin';
  if (!registry.scripts[script]) {
    if (!Array.isArray(def.script_ranges) || !def.script_ranges.length) throw new Error(`Unknown script "${script}": supply script_ranges as [[from, to], ...] code points.`);
    registry.scripts[script] = def.script_ranges;
  }
  registry.languages[code] = { name: def.name, native: def.native || def.name, script, tts: def.tts || code, stt: def.stt || code, rtl: !!def.rtl, custom: true };
}

function addTerms(concept, code, words) {
  if (!registry.languages[code]) throw new Error(`Unknown language "${code}": register it first.`);
  if (!registry.terms[concept]) registry.terms[concept] = {};
  const list = Array.isArray(words) ? words : split(words);
  registry.terms[concept][code] = [...new Set([...split(registry.terms[concept][code]), ...list])].join('|');
}

function addMarkers(code, words) {
  if (!registry.languages[code]) throw new Error(`Unknown language "${code}": register it first.`);
  registry.markers[code] = [...new Set([...split(registry.markers[code]), ...(Array.isArray(words) ? words : split(words))])].join('|');
}

/**
 * Loads extension files from a folder: each *.json is { languages: { code: {...} }, terms: { CONCEPT: { code: "w1|w2" } }, markers: { code: "w1|w2" } }.
 * A bad file is skipped and reported; it never stops the others or the application.
 */
function loadExtensions(dir) {
  const report = { loaded: [], errors: [] };
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch (e) { return report; }
  for (const f of files) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      for (const [code, def] of Object.entries(j.languages || {})) registerLanguage(code, def);
      for (const [concept, byLang] of Object.entries(j.terms || {})) for (const [code, w] of Object.entries(byLang)) addTerms(concept, code, w);
      for (const [code, w] of Object.entries(j.markers || {})) addMarkers(code, w);
      report.loaded.push(f);
    } catch (e) { report.errors.push(`${f}: ${e.message}`); }
  }
  return report;
}

module.exports = { registry, split, registerLanguage, addTerms, addMarkers, loadExtensions, SCRIPT_NAMES, LANGUAGES };
