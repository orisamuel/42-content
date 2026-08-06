/**
 * מגזין 42 - שרת ניהול: לידים + פרסום/עריכת כתבות + יצירת תוכן ותמונות
 * =====================================================================
 * נפרס כ-Web app: Execute as Me | Who has access: Anyone
 *
 * סודות (Script Properties): ADMIN_PASSWORD, GH_TOKEN, GEMINI_KEY
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

var HEADERS = [
  'תאריך', 'שעה', 'שם מלא', 'טלפון', 'דוא"ל', 'עיר',
  'כתבה', 'קמפיין', 'עמוד',
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'
];

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
      case 'uploadImage':
        return uploadImage(req, props);
      case 'generateImage':
        return generateImageAction(req, props);
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

  var system = 'אתה כותב תוכן בכיר במגזין דיגיטלי ישראלי בשם "מגזין 42". כתוב כתבת מגזין בעברית רהוטה על הנושא שתקבל.\n' +
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
function addLead(p) {
  if (!p.fullname && !p.phone && !p.email) {
    return jsonResponse({ success: false, message: 'לא התקבלו פרטים' });
  }
  var sheet = ensureSheet(SHEET_NAME, HEADERS);
  var now = new Date();
  sheet.appendRow([
    Utilities.formatDate(now, 'Asia/Jerusalem', 'dd/MM/yyyy'),
    Utilities.formatDate(now, 'Asia/Jerusalem', 'HH:mm'),
    p.fullname || '',
    "'" + (p.phone || ''),
    p.email || '',
    p.city || '',
    p.article || '',
    p.campaign || '',
    p.page || '',
    p.utm_source || '',
    p.utm_medium || '',
    p.utm_campaign || '',
    p.utm_content || '',
    p.utm_term || ''
  ]);
  return jsonResponse({ success: true, message: 'הליד נקלט' });
}

/* ---------- עזרים ---------- */
function ensureSheet(name, headers) {
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.appendRow(headers);
    sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
