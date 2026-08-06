/**
 * מגזין 42 - שרת ניהול: לידים + פרסום כתבות + יצירת תוכן
 * ========================================================
 * נפרס כ-Web app: Execute as Me | Who has access: Anyone
 *
 * סודות (Script Properties - בתפריט: Project Settings -> Script Properties):
 *   ADMIN_PASSWORD - סיסמת עמוד הניהול
 *   GH_TOKEN       - GitHub fine-grained token עם Contents: Read and write לריפו
 *   GEMINI_KEY     - מפתח Gemini ליצירת תוכן
 *
 * חשוב: אחרי כל שינוי בקוד יש לבצע Deploy -> Manage deployments ->
 * Edit -> New version -> Deploy (אחרת הכתובת החיה לא מתעדכנת!)
 */

var SHEET_ID = '1Vw1TM5Jg_WiQTxBFJCvveNm_Bn5pcgYLcu28egueMXY';
var SHEET_NAME = 'לידים';
var REPO = 'orisamuel/42-content';
var ARTICLES_PATH = 'data/articles.json';
var SITE_BASE = 'https://orisamuel.github.io/42-content';

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
        return publishArticle(req, props);
      case 'checkAuth':
        return jsonResponse({ success: true, message: 'הסיסמה תקינה' });
      default:
        return jsonResponse({ success: false, message: 'פעולה לא מוכרת' });
    }
  } catch (err) {
    return jsonResponse({ success: false, message: err.toString() });
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

  var res = UrlFetchApp.fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent', {
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

/* ---------- פרסום כתבה לגיטהאב ---------- */
function publishArticle(req, props) {
  var token = props.getProperty('GH_TOKEN');
  if (!token) return jsonResponse({ success: false, message: 'GH_TOKEN לא מוגדר ב-Script Properties' });

  var article = req.article;
  if (!article || !article.id || !article.title || !article.body) {
    return jsonResponse({ success: false, message: 'לכתבה חסרים שדות חובה (מזהה, כותרת, גוף)' });
  }
  if (!/^[a-zA-Z0-9-]+$/.test(article.id)) {
    return jsonResponse({ success: false, message: 'המזהה יכול להכיל רק אותיות באנגלית, מספרים ומקפים' });
  }

  var api = 'https://api.github.com/repos/' + REPO + '/contents/' + ARTICLES_PATH;
  var ghHeaders = {
    'Authorization': 'Bearer ' + token,
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28'
  };

  var getRes = UrlFetchApp.fetch(api, { headers: ghHeaders, muteHttpExceptions: true });
  if (getRes.getResponseCode() !== 200) {
    return jsonResponse({ success: false, message: 'קריאת הכתבות מגיטהאב נכשלה (' + getRes.getResponseCode() + ')' });
  }
  var fileData = JSON.parse(getRes.getContentText());
  var json = Utilities.newBlob(Utilities.base64Decode(fileData.content.replace(/\n/g, ''))).getDataAsString('UTF-8');
  var articles = JSON.parse(json);

  for (var i = 0; i < articles.length; i++) {
    if (articles[i].id === article.id) {
      return jsonResponse({ success: false, message: 'כבר קיימת כתבה עם המזהה "' + article.id + '" - בחרו מזהה אחר' });
    }
  }
  articles.unshift(article);

  var putRes = UrlFetchApp.fetch(api, {
    method: 'put',
    contentType: 'application/json',
    headers: ghHeaders,
    payload: JSON.stringify({
      message: 'כתבה חדשה: ' + article.title,
      content: Utilities.base64Encode(JSON.stringify(articles, null, 2), Utilities.Charset.UTF_8),
      sha: fileData.sha
    }),
    muteHttpExceptions: true
  });
  if (putRes.getResponseCode() >= 300) {
    return jsonResponse({ success: false, message: 'השמירה לגיטהאב נכשלה (' + putRes.getResponseCode() + ')' });
  }
  return jsonResponse({
    success: true,
    message: 'הכתבה פורסמה',
    url: SITE_BASE + '/articles/' + article.id + '.html'
  });
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
