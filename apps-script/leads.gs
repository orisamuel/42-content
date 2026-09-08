/**
 * Channel 18 - שרת ניהול: לידים + פרסום/עריכת כתבות + יצירת תוכן ותמונות
 * =====================================================================
 * נפרס כ-Web app: Execute as Me | Who has access: Anyone
 *
 * סודות (Script Properties): ADMIN_PASSWORD, GH_TOKEN, GEMINI_KEY
 * הגדרות לידים (Script Properties, נערכות מפאנל הניהול -> "לידים"):
 *   NOTIFY_EMAIL     - מייל שמקבל התראה על כל ליד (ריק = בלי)
 *   FORWARD_WEBHOOKS - כתובות https (מופרדות בשורה/פסיק) שכל ליד נשלח אליהן כ-JSON (CRM / Make / Zapier)
 *
 * חשוב: אחרי כל שינוי בקוד יש לבצע Deploy -> Manage deployments ->
 * Edit -> New version -> Deploy (אחרת הכתובת החיה לא מתעדכנת!)
 */

var SHEET_ID = '1Vw1TM5Jg_WiQTxBFJCvveNm_Bn5pcgYLcu28egueMXY';
var SHEET_NAME = 'לידים';
var REPO = 'orisamuel/42-content';
var ARTICLES_PATH = 'data/articles.json';
var RSS_PATH = 'data/rss-articles.json';
var SITE_BASE = 'https://orisamuel.github.io/42-content';
var TEXT_MODEL = 'gemini-flash-latest';
var IMAGE_MODELS = ['gemini-3.1-flash-image-preview', 'gemini-2.5-flash-image', 'gemini-3-pro-image'];

/* עמודות הגיליון. עמודות חדשות מתווספות בסוף אוטומטית לגיליון קיים (ensureHeaders) */
var HEADERS = [
  'תאריך', 'שעה', 'שם מלא', 'טלפון', 'דוא"ל', 'עיר',
  'כתבה', 'קמפיין', 'עמוד',
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term',
  'סטטוס', 'הערות', 'מזהה ליד', 'מזהה קליק', 'כתובת מלאה', 'דגלים', 'העברה'
];
var STATUSES = ['חדש', 'בטיפול', 'נקבעה פגישה', 'נסגר', 'לא רלוונטי', 'כפול'];
var SHEET_URL = 'https://docs.google.com/spreadsheets/d/' + SHEET_ID;

/* ---------- GET: לידים מהאתר (ללא סיסמה) ---------- */
function doGet(e) {
  var params = (e && e.parameter) || {};
  try {
    switch (params.action) {
      case 'addLead':
        return addLead(params);
      case 'ping':
        return jsonResponse({ success: true, message: 'pong' });
      default:
        return jsonResponse({ success: false, message: 'פעולה לא מוכרת' });
    }
  } catch (err) {
    return jsonResponse({ success: false, message: err.toString() });
  }
}

/* ---------- POST: פעולות ניהול (עם סיסמה) ---------- */
function doPost(e) {
  try {
    var req = JSON.parse((e && e.postData && e.postData.contents) || '{}');

    /* לידים מהאתר - ציבורי, בלי סיסמה (POST כ-text/plain כדי לעקוף preflight של CORS) */
    if (req.action === 'addLead') return addLead(req);
    if (req.action === 'ping') return jsonResponse({ success: true, message: 'pong' });

    var props = PropertiesService.getScriptProperties();
    var pass = props.getProperty('ADMIN_PASSWORD');
    if (!pass || req.password !== pass) {
      return jsonResponse({ success: false, message: 'סיסמת ניהול שגויה' });
    }
    switch (req.action) {
      case 'generateArticle':
        return generateArticle(req, props);
      case 'publishArticle':
        return saveArticle(req, props, false);
      case 'updateArticle':
        return saveArticle(req, props, true);
      case 'getArticles':
        return getArticles(props);
      case 'getArticle':
        return getArticle(req, props);
      case 'promoteArticle':
        return promoteArticle(req, props);
      case 'uploadImage':
        return uploadImage(req, props);
      case 'generateImage':
        return generateImageAction(req, props);
      case 'getLeadSettings':
        return getLeadSettings(props);
      case 'saveLeadSettings':
        return saveLeadSettings(req, props);
      case 'testLead':
        return testLead(req);
      case 'getRecentLeads':
        return getRecentLeads(req);
      case 'checkAuth':
        return jsonResponse({ success: true, message: 'הסיסמה תקינה' });
      default:
        return jsonResponse({ success: false, message: 'פעולה לא מוכרת' });
    }
  } catch (err) {
    return jsonResponse({ success: false, message: err.toString() });
  }
}

/* ---------- עזרי GitHub ---------- */
function ghHeaders(token) {
  return {
    'Authorization': 'Bearer ' + token,
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28'
  };
}

function ghGetFile(token, path) {
  var res = UrlFetchApp.fetch('https://api.github.com/repos/' + REPO + '/contents/' + path, {
    headers: ghHeaders(token),
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) return null;
  return JSON.parse(res.getContentText());
}

function ghPutFile(token, path, base64Content, message, sha) {
  var payload = { message: message, content: base64Content };
  if (sha) payload.sha = sha;
  var res = UrlFetchApp.fetch('https://api.github.com/repos/' + REPO + '/contents/' + path, {
    method: 'put',
    contentType: 'application/json',
    headers: ghHeaders(token),
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  return res.getResponseCode() < 300;
}

function readJsonFile(token, path) {
  var fileData = ghGetFile(token, path);
  if (!fileData) return null;
  var json = Utilities.newBlob(Utilities.base64Decode(fileData.content.replace(/\n/g, ''))).getDataAsString('UTF-8');
  return { articles: JSON.parse(json), sha: fileData.sha, path: path };
}

function writeJsonFile(token, data, message) {
  return ghPutFile(
    token,
    data.path,
    Utilities.base64Encode(JSON.stringify(data.articles, null, 2), Utilities.Charset.UTF_8),
    message,
    data.sha
  );
}

function requireToken(props) {
  var token = props.getProperty('GH_TOKEN');
  if (!token) throw new Error('GH_TOKEN לא מוגדר ב-Script Properties');
  return token;
}

/* ---------- רשימת כתבות ושליפה לעריכה (ידניות + RSS) ---------- */
function getArticles(props) {
  var token = requireToken(props);
  var manual = readJsonFile(token, ARTICLES_PATH);
  if (!manual) return jsonResponse({ success: false, message: 'קריאת הכתבות נכשלה' });
  var rss = readJsonFile(token, RSS_PATH) || { articles: [] };

  var pick = function (type) {
    return function (a) {
      return { id: a.id, title: a.title, category: a.category, date: a.date, type: type };
    };
  };
  return jsonResponse({
    success: true,
    articles: manual.articles.map(pick('manual')).concat(rss.articles.map(pick('rss')))
  });
}

function getArticle(req, props) {
  var token = requireToken(props);
  var files = [readJsonFile(token, ARTICLES_PATH), readJsonFile(token, RSS_PATH)];
  var types = ['manual', 'rss'];
  for (var f = 0; f < files.length; f++) {
    if (!files[f]) continue;
    for (var i = 0; i < files[f].articles.length; i++) {
      if (files[f].articles[i].id === req.id) {
        return jsonResponse({ success: true, article: files[f].articles[i], type: types[f] });
      }
    }
  }
  return jsonResponse({ success: false, message: 'כתבה לא נמצאה' });
}

/* ---------- פרסום / עדכון כתבה ---------- */
function findIndexById(articles, id) {
  for (var i = 0; i < articles.length; i++) {
    if (articles[i].id === id) return i;
  }
  return -1;
}

function saveArticle(req, props, isUpdate) {
  var token = requireToken(props);
  var article = req.article;
  if (!article || !article.id || !article.title || !article.body) {
    return jsonResponse({ success: false, message: 'לכתבה חסרים שדות חובה (מזהה, כותרת, גוף)' });
  }
  if (!/^[a-zA-Z0-9-]+$/.test(article.id)) {
    return jsonResponse({ success: false, message: 'המזהה יכול להכיל רק אותיות באנגלית, מספרים ומקפים' });
  }

  var manual = readJsonFile(token, ARTICLES_PATH);
  if (!manual) return jsonResponse({ success: false, message: 'קריאת הכתבות מגיטהאב נכשלה' });
  var rss = readJsonFile(token, RSS_PATH) || { articles: [], path: RSS_PATH, sha: null };

  var manualIdx = findIndexById(manual.articles, article.id);
  var rssIdx = findIndexById(rss.articles, article.id);

  if (isUpdate) {
    // מעדכנים בקובץ שבו הכתבה נמצאת - ידני או RSS
    var target = manualIdx !== -1 ? manual : (rssIdx !== -1 ? rss : null);
    var idx = manualIdx !== -1 ? manualIdx : rssIdx;
    if (!target) return jsonResponse({ success: false, message: 'הכתבה לעדכון לא נמצאה' });
    article.date = target.articles[idx].date; // שומרים את תאריך הפרסום המקורי
    article.updatedAt = new Date().toISOString();
    target.articles[idx] = article;
    if (!writeJsonFile(token, target, 'עדכון כתבה: ' + article.title)) {
      return jsonResponse({ success: false, message: 'השמירה לגיטהאב נכשלה' });
    }
  } else {
    if (manualIdx !== -1 || rssIdx !== -1) {
      return jsonResponse({ success: false, message: 'כבר קיימת כתבה עם המזהה "' + article.id + '" - בחרו מזהה אחר' });
    }
    manual.articles.unshift(article);
    if (!writeJsonFile(token, manual, 'כתבה חדשה: ' + article.title)) {
      return jsonResponse({ success: false, message: 'השמירה לגיטהאב נכשלה' });
    }
  }

  return jsonResponse({
    success: true,
    message: isUpdate ? 'הכתבה עודכנה' : 'הכתבה פורסמה',
    url: SITE_BASE + '/articles/' + article.id + '.html'
  });
}

/* ---------- הפיכת כתבת RSS לכתבה קבועה ---------- */
function promoteArticle(req, props) {
  var token = requireToken(props);
  if (!req.id) return jsonResponse({ success: false, message: 'חסר מזהה כתבה' });

  var rss = readJsonFile(token, RSS_PATH);
  if (!rss) return jsonResponse({ success: false, message: 'קריאת כתבות ה-RSS נכשלה' });
  var rssIdx = findIndexById(rss.articles, req.id);
  if (rssIdx === -1) {
    return jsonResponse({ success: false, message: 'הכתבה אינה כתבת RSS (אולי היא כבר קבועה?)' });
  }

  var manual = readJsonFile(token, ARTICLES_PATH);
  if (!manual) return jsonResponse({ success: false, message: 'קריאת הכתבות הקבועות נכשלה' });

  var article = rss.articles[rssIdx];

  /* מזהה חדש: לפי הכותרת אם אפשר, אחרת חתימת זמן. אנגלית/מספרים/מקפים בלבד */
  var base = String(req.newId || article.title || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  if (base.length < 3) {
    base = 'perm-' + Utilities.formatDate(new Date(), 'Asia/Jerusalem', 'yyyyMMdd-HHmm');
  }
  var newId = base;
  var n = 2;
  while (findIndexById(manual.articles, newId) !== -1) {
    newId = base + '-' + n;
    n++;
    if (n > 50) return jsonResponse({ success: false, message: 'לא הצלחנו לייצר מזהה פנוי' });
  }

  var promoted = {};
  for (var k in article) { if (article.hasOwnProperty(k)) promoted[k] = article[k]; }
  promoted.id = newId;
  promoted.promotedFrom = article.id;
  promoted.promotedAt = new Date().toISOString();

  /* התמונה יושבת ב-assets/rss-img ונמחקת בסבב הבא - מעתיקים אותה ל-uploads */
  if (promoted.image && promoted.image.indexOf('/assets/rss-img/') > -1) {
    var imgPath = 'assets/rss-img/' + article.id + '.jpg';
    var imgFile = ghGetFile(token, imgPath);
    if (imgFile && imgFile.content) {
      var newName = 'perm-' + new Date().getTime() + '.jpg';
      if (ghPutFile(token, 'assets/uploads/' + newName, imgFile.content.replace(/\n/g, ''), 'שמירת תמונה לכתבה קבועה: ' + newId)) {
        promoted.image = SITE_BASE + '/assets/uploads/' + newName;
      }
    }
  }

  /* 1. מוסיפים לכתבות הקבועות */
  manual.articles.unshift(promoted);
  if (!writeJsonFile(token, manual, 'כתבה קבועה: ' + promoted.title)) {
    return jsonResponse({ success: false, message: 'השמירה לכתבות הקבועות נכשלה' });
  }

  /* 2. מסירים מכתבות ה-RSS (קוראים מחדש - ה-sha התיישן) */
  var rss2 = readJsonFile(token, RSS_PATH);
  if (rss2) {
    var i2 = findIndexById(rss2.articles, article.id);
    if (i2 !== -1) {
      rss2.articles.splice(i2, 1);
      writeJsonFile(token, rss2, 'הסרת כתבה שהפכה לקבועה: ' + promoted.title);
    }
  }

  return jsonResponse({
    success: true,
    message: 'הכתבה הפכה לקבועה',
    id: newId,
    url: SITE_BASE + '/articles/' + newId + '.html'
  });
}

/* ---------- העלאת תמונה ---------- */
function uploadImage(req, props) {
  var token = requireToken(props);
  if (!req.dataBase64) return jsonResponse({ success: false, message: 'לא התקבלה תמונה' });
  var ext = String(req.mimeType || '').indexOf('png') > -1 ? 'png' : 'jpg';
  var name = 'up-' + new Date().getTime() + '.' + ext;
  var ok = ghPutFile(token, 'assets/uploads/' + name, req.dataBase64, 'העלאת תמונה: ' + name);
  if (!ok) return jsonResponse({ success: false, message: 'העלאת התמונה לגיטהאב נכשלה' });
  return jsonResponse({ success: true, url: SITE_BASE + '/assets/uploads/' + name });
}

/* ---------- יצירת תמונה עם Gemini ---------- */
function generateImageAction(req, props) {
  var key = props.getProperty('GEMINI_KEY');
  if (!key) return jsonResponse({ success: false, message: 'GEMINI_KEY לא מוגדר' });
  var token = requireToken(props);
  var subject = req.title || req.topic;
  if (!subject) return jsonResponse({ success: false, message: 'חסר נושא לתמונה (מלאו כותרת)' });

  var prompt = 'Editorial magazine cover photo for an article. Topic (in Hebrew): "' + subject + '". ' +
    (req.category ? 'Category: ' + req.category + '. ' : '') +
    'Create a generic, symbolic, professional stock-photo style image representing the general theme only. ' +
    'Strict rules: photorealistic, high quality, 16:9. NO text, NO letters, NO numbers, NO logos, NO flags, ' +
    'NO recognizable faces, NO real people or politicians, NO graphic violence. Neutral and tasteful.';

  var b64 = null;
  for (var m = 0; m < IMAGE_MODELS.length && !b64; m++) {
    b64 = tryImageModel(key, IMAGE_MODELS[m], prompt, true) || tryImageModel(key, IMAGE_MODELS[m], prompt, false);
  }
  if (!b64) return jsonResponse({ success: false, message: 'יצירת התמונה נכשלה - נסו שוב' });

  var name = 'gen-' + new Date().getTime() + '.jpg';
  var ok = ghPutFile(token, 'assets/uploads/' + name, b64, 'תמונת AI: ' + subject);
  if (!ok) return jsonResponse({ success: false, message: 'שמירת התמונה לגיטהאב נכשלה' });

  return jsonResponse({
    success: true,
    url: SITE_BASE + '/assets/uploads/' + name,
    preview: 'data:image/jpeg;base64,' + b64
  });
}

function tryImageModel(key, model, prompt, withAspect) {
  try {
    var genConfig = { responseModalities: ['IMAGE'] };
    if (withAspect) genConfig.imageConfig = { aspectRatio: '16:9' };
    var res = UrlFetchApp.fetch('https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent', {
      method: 'post',
      contentType: 'application/json',
      headers: { 'x-goog-api-key': key },
      payload: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: genConfig
      }),
      muteHttpExceptions: true
    });
    if (res.getResponseCode() !== 200) return null;
    var data = JSON.parse(res.getContentText());
    var parts = (((data.candidates || [])[0] || {}).content || {}).parts || [];
    for (var i = 0; i < parts.length; i++) {
      if (parts[i].inlineData && parts[i].inlineData.data) return parts[i].inlineData.data;
    }
    return null;
  } catch (err) {
    return null;
  }
}

/* ---------- יצירת תוכן עם Gemini ---------- */
function generateArticle(req, props) {
  var key = props.getProperty('GEMINI_KEY');
  if (!key) return jsonResponse({ success: false, message: 'GEMINI_KEY לא מוגדר ב-Script Properties' });
  if (!req.topic) return jsonResponse({ success: false, message: 'חסר נושא לכתבה' });

  var system = 'אתה כותב תוכן בכיר במגזין דיגיטלי ישראלי בשם "Channel 18". כתוב כתבת מגזין בעברית רהוטה על הנושא שתקבל.\n' +
    'כללים מחייבים:\n' +
    '- אל תמציא עובדות ספציפיות: בלי מספרים מדויקים, שמות של אנשים או חברות, מחקרים או ציטוטים פיקטיביים. ידע כללי ועצות מעשיות - כן.\n' +
    '- title: כותרת מסקרנת ומזמינה אך מדויקת.\n' +
    '- subtitle: משפט או שניים שמרחיבים את הכותרת.\n' +
    '- body: גוף של 500-700 מילים בפורמט הבא: פסקאות מופרדות בשורה ריקה, כותרות ביניים בשורה שמתחילה ב-"## ", אפשר רשימות בשורות שמתחילות ב-"- " והדגשות עם **טקסט מודגש**.\n' +
    '- סגנון מגזיני, ברור ופרקטי, פנייה לקוראים בגוף שני רבים.\n' +
    '- הקטגוריה באתר: ' + (req.category || 'כללי') + '.\n' +
    (req.leadOn ? '- בסוף הכתבה יופיע טופס השארת פרטים - סיים בפסקה קצרה שמובילה באופן טבעי להשארת פרטים.' : '');

  var payload = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts: [{ text: 'נושא הכתבה: ' + req.topic }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'OBJECT',
        properties: {
          title: { type: 'STRING' },
          subtitle: { type: 'STRING' },
          body: { type: 'STRING' }
        },
        required: ['title', 'subtitle', 'body']
      },
      maxOutputTokens: 8192
    }
  };

  var res = UrlFetchApp.fetch('https://generativelanguage.googleapis.com/v1beta/models/' + TEXT_MODEL + ':generateContent', {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-goog-api-key': key },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  var data = JSON.parse(res.getContentText());
  if (res.getResponseCode() !== 200) {
    return jsonResponse({ success: false, message: 'שגיאת Gemini: ' + ((data.error && data.error.message) || res.getResponseCode()) });
  }
  var parts = (((data.candidates || [])[0] || {}).content || {}).parts || [];
  var text = parts.map(function (p) { return p.text || ''; }).join('');
  var out = JSON.parse(text);
  if (!out.title || !out.body) return jsonResponse({ success: false, message: 'התקבלה תשובה חלקית מ-Gemini - נסו שוב' });
  return jsonResponse({ success: true, title: out.title, subtitle: out.subtitle || '', body: out.body });
}

/* ---------- לידים ---------- */
/**
 * קליטת ליד מהאתר. מגיע כ-POST JSON (ברירת מחדל) או כ-GET (תאימות לאחור).
 * שדות: fullname, phone, email, city, article, campaign, page, pageUrl, utm_*,
 *        tblci / ob_click_id / fbclid / gclid (מזהי קליק לקמפיינים),
 *        leadId  - מזהה ייחודי מהדפדפן: ניסיון חוזר עם אותו מזהה לא יוצר שורה כפולה,
 *        website - מלכודת בוטים: שדה נסתר שחייב להישאר ריק.
 */
function addLead(p) {
  p = p || {};
  if (p.website) return jsonResponse({ success: true, message: 'ok' }); // בוט מילא שדה נסתר - מתעלמים בשקט

  var phone = normalizePhone(p.phone);
  if (!p.fullname && !phone && !p.email) {
    return jsonResponse({ success: false, message: 'לא התקבלו פרטים' });
  }

  var cache = CacheService.getScriptCache();
  var leadId = String(p.leadId || '').replace(/[^\w-]/g, '').slice(0, 64) || Utilities.getUuid();
  if (cache.get('lead:' + leadId)) {
    return jsonResponse({ success: true, message: 'הליד כבר נקלט', leadId: leadId, duplicate: true });
  }

  var flags = [];
  if (p.phone && !phone) flags.push('טלפון לא תקין');
  var isDup = Boolean(phone && cache.get('phone:' + phone));
  if (isDup) flags.push('כפול (24 שעות)');
  if (p.test) flags.push('בדיקה');

  var now = new Date();
  var clickId = p.tblci || p.ob_click_id || p.fbclid || p.gclid || p.ttclid || '';
  var row = {
    'תאריך': Utilities.formatDate(now, 'Asia/Jerusalem', 'dd/MM/yyyy'),
    'שעה': Utilities.formatDate(now, 'Asia/Jerusalem', 'HH:mm'),
    'שם מלא': str(p.fullname),
    'טלפון': phone ? "'" + phone : str(p.phone),
    'דוא"ל': str(p.email),
    'עיר': str(p.city),
    'כתבה': str(p.article),
    'קמפיין': str(p.campaign),
    'עמוד': str(p.page),
    'utm_source': str(p.utm_source),
    'utm_medium': str(p.utm_medium),
    'utm_campaign': str(p.utm_campaign),
    'utm_content': str(p.utm_content),
    'utm_term': str(p.utm_term),
    'סטטוס': isDup ? 'כפול' : 'חדש',
    'הערות': '',
    'מזהה ליד': leadId,
    'מזהה קליק': str(clickId),
    'כתובת מלאה': str(p.pageUrl),
    'דגלים': flags.join(', '),
    'העברה': ''
  };

  /* כתיבה לגיליון תחת נעילה - כמה לידים באותה שנייה לא דורסים זה את זה */
  var lock = LockService.getScriptLock();
  var locked = lock.tryLock(15000);
  var sheet, headers, rowIndex;
  try {
    sheet = ensureSheet(SHEET_NAME);
    headers = ensureHeaders(sheet);
    sheet.appendRow(headers.map(function (h) { return row.hasOwnProperty(h) ? row[h] : ''; }));
    rowIndex = sheet.getLastRow();
  } finally {
    if (locked) lock.releaseLock();
  }

  cache.put('lead:' + leadId, '1', 3600);
  if (phone) cache.put('phone:' + phone, '1', 86400);

  /* העברה ל-webhooks חיצוניים (CRM / Make / Zapier) והתראה במייל. כישלון שם לא מכשיל את הליד */
  var forwarded = forwardLead(row, flags);
  if (forwarded) {
    var col = headers.indexOf('העברה') + 1;
    if (col > 0) sheet.getRange(rowIndex, col).setValue(forwarded);
  }
  notifyLead(row, flags);

  return jsonResponse({ success: true, message: 'הליד נקלט', leadId: leadId });
}

function str(v) { return v == null ? '' : String(v).slice(0, 500); }

/** נרמול טלפון ישראלי: 05XXXXXXXX / 07XXXXXXXX / 0XXXXXXXX (קווי). מחזיר '' אם לא תקין */
function normalizePhone(raw) {
  if (!raw) return '';
  var d = String(raw).replace(/\D/g, '');
  if (d.indexOf('972') === 0) d = '0' + d.slice(3);
  if (/^0[57]\d{8}$/.test(d) || /^0[23489]\d{7}$/.test(d)) return d;
  return '';
}

function ensureSheet(name) {
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.appendRow(HEADERS);
    sheet.getRange(1, 1, 1, HEADERS.length).setFontWeight('bold');
    sheet.setFrozenRows(1);
    applyStatusValidation(sheet, HEADERS);
  }
  return sheet;
}

/** משלים עמודות חסרות בשורת הכותרת (בסוף, בלי להזיז נתונים קיימים) ומחזיר את סדר הכותרות בפועל */
function ensureHeaders(sheet) {
  var lastCol = Math.max(sheet.getLastColumn(), 1);
  var current = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function (v) { return String(v).trim(); });
  while (current.length && !current[current.length - 1]) current.pop();
  var missing = HEADERS.filter(function (h) { return current.indexOf(h) === -1; });
  if (missing.length) {
    sheet.getRange(1, current.length + 1, 1, missing.length).setValues([missing]).setFontWeight('bold');
    current = current.concat(missing);
    applyStatusValidation(sheet, current);
  }
  return current;
}

/** רשימה נפתחת בעמודת הסטטוס - כדי שניהול הלידים בגיליון יהיה אחיד */
function applyStatusValidation(sheet, headers) {
  var col = headers.indexOf('סטטוס') + 1;
  if (col < 1) return;
  var rule = SpreadsheetApp.newDataValidation().requireValueInList(STATUSES, true).setAllowInvalid(true).build();
  sheet.getRange(2, col, Math.max(sheet.getMaxRows() - 1, 1), 1).setDataValidation(rule);
}

/** ה-JSON שנשלח ל-webhooks חיצוניים - מפתחות באנגלית כדי שכל CRM/אוטומציה יבינו */
function leadPayload(row, flags) {
  return {
    source: 'channel18',
    leadId: row['מזהה ליד'],
    receivedAt: new Date().toISOString(),
    date: row['תאריך'],
    time: row['שעה'],
    fullname: row['שם מלא'],
    phone: String(row['טלפון'] || '').replace(/^'/, ''),
    email: row['דוא"ל'],
    city: row['עיר'],
    article: row['כתבה'],
    campaign: row['קמפיין'],
    page: row['עמוד'],
    pageUrl: row['כתובת מלאה'],
    utm_source: row['utm_source'],
    utm_medium: row['utm_medium'],
    utm_campaign: row['utm_campaign'],
    utm_content: row['utm_content'],
    utm_term: row['utm_term'],
    clickId: row['מזהה קליק'],
    flags: flags,
    test: flags.indexOf('בדיקה') > -1
  };
}

function getForwardUrls() {
  var raw = PropertiesService.getScriptProperties().getProperty('FORWARD_WEBHOOKS') || '';
  return raw.split(/[\s,]+/).filter(function (u) { return /^https?:\/\/\S+$/.test(u); });
}

/** שולח את הליד לכל ה-webhooks במקביל ומחזיר סיכום קצר לעמודת "העברה" */
function forwardLead(row, flags) {
  var urls = getForwardUrls();
  if (!urls.length) return '';
  var body = JSON.stringify(leadPayload(row, flags));
  var requests = urls.map(function (u) {
    return { url: u, method: 'post', contentType: 'application/json', payload: body, muteHttpExceptions: true };
  });
  var results = [];
  try {
    var responses = UrlFetchApp.fetchAll(requests);
    for (var i = 0; i < responses.length; i++) {
      var code = responses[i].getResponseCode();
      results.push(hostOf(urls[i]) + ': ' + (code >= 200 && code < 300 ? 'נשלח' : 'שגיאה ' + code));
    }
  } catch (err) {
    results.push('שגיאה: ' + err);
  }
  return results.join(' | ');
}

function hostOf(url) {
  var m = String(url).match(/^https?:\/\/([^\/?#]+)/i);
  return m ? m[1] : url;
}

/** התראה במייל על ליד חדש (אם הוגדר NOTIFY_EMAIL) עם קישורי חיוג ווואטסאפ */
function notifyLead(row, flags) {
  var to = PropertiesService.getScriptProperties().getProperty('NOTIFY_EMAIL') || '';
  if (!to) return;
  try {
    var phone = String(row['טלפון'] || '').replace(/^'/, '');
    var subject = (flags.indexOf('בדיקה') > -1 ? '[בדיקה] ' : '') +
      'ליד חדש: ' + (row['שם מלא'] || phone) + (row['קמפיין'] ? ' - ' + row['קמפיין'] : '');
    var lines = [
      ['שם', row['שם מלא']], ['טלפון', phone], ['דוא"ל', row['דוא"ל']], ['עיר', row['עיר']],
      ['כתבה', row['כתבה']], ['קמפיין', row['קמפיין']],
      ['מקור', [row['utm_source'], row['utm_medium'], row['utm_campaign']].filter(String).join(' / ')],
      ['זמן', row['תאריך'] + ' ' + row['שעה']], ['דגלים', row['דגלים']]
    ].filter(function (l) { return l[1]; });
    var html = '<div dir="rtl" style="font-family:Arial,sans-serif;font-size:15px">' +
      '<h2 style="margin:0 0 12px">ליד חדש מ-Channel 18</h2>' +
      '<table cellpadding="6" style="border-collapse:collapse">' +
      lines.map(function (l) {
        return '<tr><td style="color:#666">' + l[0] + '</td><td><b>' + escapeHtml(l[1]) + '</b></td></tr>';
      }).join('') +
      '</table>' +
      (phone ? '<p><a href="tel:' + phone + '">📞 התקשרו עכשיו</a> · <a href="https://wa.me/972' + phone.slice(1) + '">💬 וואטסאפ</a></p>' : '') +
      '<p style="color:#888;font-size:12px"><a href="' + SHEET_URL + '">לגיליון הלידים</a></p></div>';
    MailApp.sendEmail({ to: to, subject: subject, htmlBody: html, name: 'Channel 18 לידים' });
  } catch (err) { /* מייל שנפל לא מכשיל את הליד */ }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
  });
}

/* ---------- ניהול לידים מפאנל הניהול (עם סיסמה) ---------- */
function getLeadSettings(props) {
  return jsonResponse({
    success: true,
    notifyEmail: props.getProperty('NOTIFY_EMAIL') || '',
    forwardWebhooks: getForwardUrls().join('\n'),
    sheetUrl: SHEET_URL
  });
}

function saveLeadSettings(req, props) {
  var email = String(req.notifyEmail || '').trim();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return jsonResponse({ success: false, message: 'כתובת המייל לא תקינה' });
  }
  var urls = String(req.forwardWebhooks || '').split(/[\s,]+/).filter(Boolean);
  for (var i = 0; i < urls.length; i++) {
    if (!/^https:\/\/\S+$/.test(urls[i])) {
      return jsonResponse({ success: false, message: 'כתובת webhook לא תקינה (חייבת להתחיל ב-https://): ' + urls[i] });
    }
  }
  props.setProperty('NOTIFY_EMAIL', email);
  props.setProperty('FORWARD_WEBHOOKS', urls.join('\n'));
  return jsonResponse({ success: true, message: 'הגדרות הלידים נשמרו' });
}

/** ליד בדיקה שעובר את כל השרשרת (גיליון, מייל, webhooks) ומסומן "בדיקה" */
function testLead(req) {
  var res = addLead({
    leadId: 'test-' + new Date().getTime(),
    fullname: 'ליד בדיקה',
    phone: '0501234567',
    email: 'test@example.com',
    city: 'תל אביב',
    article: 'test',
    campaign: (req && req.campaign) || 'test',
    page: SITE_BASE + '/',
    pageUrl: SITE_BASE + '/?utm_source=test',
    utm_source: 'test',
    utm_medium: 'admin',
    utm_campaign: 'test-lead',
    test: true
  });
  var data = JSON.parse(res.getContent());
  var sheet = ensureSheet(SHEET_NAME);
  var headers = ensureHeaders(sheet);
  var last = sheet.getRange(sheet.getLastRow(), 1, 1, headers.length).getValues()[0];
  var col = headers.indexOf('העברה');
  data.forwarded = col > -1 ? String(last[col] || '') : '';
  data.notifyEmail = PropertiesService.getScriptProperties().getProperty('NOTIFY_EMAIL') || '';
  data.sheetUrl = SHEET_URL;
  return jsonResponse(data);
}

function getRecentLeads(req) {
  var sheet = ensureSheet(SHEET_NAME);
  var headers = ensureHeaders(sheet);
  var lastRow = sheet.getLastRow();
  var n = Math.min(Number((req && req.limit) || 20), 100);
  if (lastRow < 2) return jsonResponse({ success: true, headers: headers, rows: [], total: 0, sheetUrl: SHEET_URL });
  var start = Math.max(2, lastRow - n + 1);
  var values = sheet.getRange(start, 1, lastRow - start + 1, headers.length).getDisplayValues();
  return jsonResponse({ success: true, headers: headers, rows: values.reverse(), total: lastRow - 1, sheetUrl: SHEET_URL });
}

/* ---------- עזרים ---------- */
function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
