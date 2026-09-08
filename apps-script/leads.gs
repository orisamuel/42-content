/**
 * Channel 19 - שרת ניהול: לידים + פרסום/עריכת כתבות + יצירת תוכן ותמונות
 * =====================================================================
 * נפרס כ-Web app: Execute as Me | Who has access: Anyone
 *
 * סודות (Script Properties): GH_TOKEN, GEMINI_KEY
 * הגדרות לידים (Script Properties, נערכות מפאנל הניהול -> "לידים"):
 *   NOTIFY_EMAIL     - מייל שמקבל התראה על כל ליד (ריק = בלי)
 *   FORWARD_WEBHOOKS - כתובות https (מופרדות בשורה/פסיק) שכל ליד נשלח אליהן כ-JSON (CRM / Make / Zapier)
 * גישה לפאנל (Script Properties, נערכות מהפאנל -> "גישה"):
 *   GOOGLE_CLIENT_ID - OAuth Client ID (Web) לכפתור "כניסה עם גוגל"
 *   ALLOWED_DOMAIN   - דומיין ארגוני שנכנס אוטומטית (ברירת מחדל 42creative.co.il)
 *   ALLOWED_EMAILS   - חשבונות נוספים שמורשים (מופרדים בשורה/פסיק)
 *   (אין סיסמת גיבוי: הכניסה היא עם גוגל בלבד. ADMIN_PASSWORD ישן נמחק אוטומטית בבקשה הראשונה)
 * לקוחות וקמפיינים נרשמים בטאבים "לקוחות" ו"קמפיינים" בגיליון הראשי. לכל לקוח גיליון משלו,
 * לכל קמפיין טאב בגיליון של הלקוח; כל ליד נרשם גם בטאב הראשי "לידים".
 * הרשאות: אחרי הוספת שירות חדש (DriveApp, MailApp) בעל הסקריפט מריץ פעם אחת authorizeServices() בעורך.
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
  'כתבה', 'קמפיין', 'לקוח', 'עמוד',
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term',
  'סטטוס', 'הערות', 'מזהה ליד', 'מזהה קליק', 'כתובת מלאה', 'דגלים', 'העברה', 'יעד'
];
var STATUSES = ['חדש', 'בטיפול', 'נקבעה פגישה', 'נסגר', 'לא רלוונטי', 'כפול'];
/* עמודות מערכת - שדה מותאם בטופס לא יכול לדרוס אותן */
var SYSTEM_COLUMNS = HEADERS.filter(function (h) { return ['שם מלא', 'טלפון', 'דוא"ל', 'עיר'].indexOf(h) === -1; });
var STANDARD_FIELD_NAMES = ['fullname', 'phone', 'email', 'city', 'website'];
var SHEET_URL = 'https://docs.google.com/spreadsheets/d/' + SHEET_ID;
var ROUTING_CACHE_KEY = 'lead-routing-v1';

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
    if (props.getProperty('ADMIN_PASSWORD')) props.deleteProperty('ADMIN_PASSWORD'); // כניסה עם גוגל בלבד - סיסמת הגיבוי הישנה מוסרת

    /* פעולות ציבוריות - בלי התחברות */
    if (req.action === 'addLead') return addLead(req);
    if (req.action === 'ping') return jsonResponse({ success: true, message: 'pong' });
    if (req.action === 'getPublicConfig') return getPublicConfig(props);
    if (req.action === 'login') return login(req, props);

    /* כל השאר דורש התחברות: session שנוצר בכניסה עם חשבון גוגל מורשה */
    var user = authenticate(req, props);
    if (!user) return jsonResponse({ success: false, code: 'unauthorized', message: 'לא מחובר - יש להיכנס מחדש' });

    switch (req.action) {
      case 'logout':
        return logout(req);
      case 'checkAuth':
        return jsonResponse({ success: true, message: 'מחובר', email: user.email, name: user.name || '', via: user.via });
      case 'generateArticle':
        return generateArticle(req, props);
      case 'publishArticle':
        return saveArticle(req, props, false, user);
      case 'updateArticle':
        return saveArticle(req, props, true, user);
      case 'deleteArticle':
        return deleteArticle(req, props, user);
      case 'getArticles':
        return getArticles(props);
      case 'getArticle':
        return getArticle(req, props);
      case 'promoteArticle':
        return promoteArticle(req, props, user);
      case 'uploadImage':
        return uploadImage(req, props);
      case 'generateImage':
        return generateImageAction(req, props);
      case 'checkGitHub': {
        var chk = ghCheckToken(props.getProperty('GH_TOKEN'));
        return jsonResponse({ success: true, ok: chk.ok, message: chk.message, expires: chk.expires || '' });
      }
      case 'saveGitHubToken':
        return saveGitHubToken(req, props);
      case 'checkServices':
        return jsonResponse(Object.assign({ success: true, scriptUrl: SCRIPT_EDIT_URL }, checkServices()));
      case 'getAccessSettings':
        return getAccessSettings(props, user);
      case 'saveAccessSettings':
        return saveAccessSettings(req, props, user);
      case 'getClients':
        return jsonResponse(Object.assign({ success: true }, getRegistry(true)));
      case 'saveClient':
        return saveClient(req, user);
      case 'saveCampaign':
        return saveCampaign(req, user);
      case 'getLeadSettings':
        return getLeadSettings(props);
      case 'saveLeadSettings':
        return saveLeadSettings(req, props);
      case 'testLead':
        return testLead(req);
      case 'getRecentLeads':
        return getRecentLeads(req);
      case 'deleteTestLeads':
        return deleteTestLeads();
      default:
        return jsonResponse({ success: false, message: 'פעולה לא מוכרת' });
    }
  } catch (err) {
    return jsonResponse({ success: false, message: err.toString() });
  }
}

/* ---------- התחברות: גוגל (חשבון ארגוני / מורשים) + סיסמת גיבוי ---------- */
var DEFAULT_ALLOWED_DOMAIN = '42creative.co.il';
var SESSION_TTL_SEC = 21600; // 6 שעות - המקסימום של CacheService
var SCRIPT_EDIT_URL = 'https://script.google.com/d/1_zMcYV7qG2PVnFn7wTGPGXZXBViA9ezLzj_cKGfigMnruHAWC8QiEZvI/edit';

function allowedDomain(props) {
  return (props.getProperty('ALLOWED_DOMAIN') || DEFAULT_ALLOWED_DOMAIN).toLowerCase();
}

function allowedEmails(props) {
  return splitList((props.getProperty('ALLOWED_EMAILS') || '').toLowerCase());
}

function emailDomain(email) {
  email = String(email || '').toLowerCase();
  return email.slice(email.indexOf('@') + 1);
}

/** הגדרות שהמסך הנעול צריך לפני התחברות - בלי סודות */
function getPublicConfig(props) {
  return jsonResponse({
    success: true,
    googleClientId: props.getProperty('GOOGLE_CLIENT_ID') || '',
    allowedDomain: allowedDomain(props)
  });
}

function isAllowedUser(email, props) {
  email = String(email || '').toLowerCase();
  if (!email) return false;
  if (emailDomain(email) === allowedDomain(props)) return true;
  return allowedEmails(props).indexOf(email) > -1;
}

/** אימות ID token של גוגל מול tokeninfo: חתימה, תוקף, ושהוא הונפק לפאנל שלנו (aud = Client ID) */
function verifyGoogleIdToken(idToken, props) {
  var clientId = props.getProperty('GOOGLE_CLIENT_ID') || '';
  if (!clientId) return { ok: false, message: 'לא הוגדר Google Client ID בהגדרות הגישה' };
  var res = UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken), { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) return { ok: false, message: 'האסימון של גוגל לא תקף או פג - נסו להתחבר שוב' };
  var info = JSON.parse(res.getContentText());
  if (info.aud !== clientId) return { ok: false, message: 'האסימון לא הונפק לפאנל הזה (Client ID לא תואם)' };
  if (String(info.email_verified) !== 'true') return { ok: false, message: 'כתובת המייל בחשבון גוגל אינה מאומתת' };
  if (info.iss !== 'accounts.google.com' && info.iss !== 'https://accounts.google.com') return { ok: false, message: 'מנפיק לא מוכר' };
  return { ok: true, email: String(info.email).toLowerCase(), name: info.name || '', picture: info.picture || '', hd: info.hd || '' };
}

function createSession(user) {
  var token = Utilities.getUuid() + '-' + Utilities.getUuid();
  CacheService.getScriptCache().put('sess:' + token, JSON.stringify(user), SESSION_TTL_SEC);
  return token;
}

/** כניסה: אך ורק עם ID token של גוגל של חשבון מורשה (דומיין ארגוני או רשימת מורשים) */
function login(req, props) {
  if (!req.idToken) return jsonResponse({ success: false, message: 'הכניסה היא עם חשבון גוגל בלבד' });
  var v = verifyGoogleIdToken(String(req.idToken), props);
  if (!v.ok) return jsonResponse({ success: false, message: v.message });
  if (!isAllowedUser(v.email, props)) {
    return jsonResponse({
      success: false,
      message: 'החשבון ' + v.email + ' לא מורשה לפאנל. חשבון ארגוני של ' + allowedDomain(props) + ' נכנס אוטומטית; חשבון אחר צריך להתווסף לרשימת המורשים (הגדרות ← גישה).'
    });
  }
  var user = { email: v.email, name: v.name, picture: v.picture, via: 'google' };
  return jsonResponse({ success: true, session: createSession(user), email: user.email, name: user.name, picture: user.picture, via: 'google', expiresIn: SESSION_TTL_SEC });
}

/** מחזיר את המשתמש המחובר לפי session, אחרת null. אין שום מסלול כניסה אחר */
function authenticate(req, props) {
  if (!req.session) return null;
  var raw = CacheService.getScriptCache().get('sess:' + String(req.session));
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

function logout(req) {
  if (req.session) CacheService.getScriptCache().remove('sess:' + String(req.session));
  return jsonResponse({ success: true, message: 'התנתקת' });
}

/** שינוי הגדרות גישה: רק חשבון ארגוני */
function canManageAccess(user, props) {
  if (!user) return false;
  return emailDomain(user.email) === allowedDomain(props);
}

function getAccessSettings(props, user) {
  return jsonResponse({
    success: true,
    googleClientId: props.getProperty('GOOGLE_CLIENT_ID') || '',
    allowedDomain: allowedDomain(props),
    allowedEmails: allowedEmails(props).join('\n'),
    canManage: canManageAccess(user, props),
    via: user.via,
    origin: SITE_BASE.replace(/^(https?:\/\/[^\/]+).*$/, '$1')
  });
}

function saveAccessSettings(req, props, user) {
  if (!canManageAccess(user, props)) return jsonResponse({ success: false, message: 'רק חשבון ארגוני יכול לשנות הגדרות גישה' });
  var clientId = String(req.googleClientId || '').trim();
  if (clientId && !/^[\w-]+\.apps\.googleusercontent\.com$/.test(clientId)) {
    return jsonResponse({ success: false, message: 'Client ID לא תקין - צריך להיגמר ב-.apps.googleusercontent.com' });
  }
  var domain = String(req.allowedDomain || '').trim().toLowerCase().replace(/^@/, '');
  if (domain && !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) return jsonResponse({ success: false, message: 'דומיין לא תקין' });
  var emails = splitList(String(req.allowedEmails || '').toLowerCase());
  for (var i = 0; i < emails.length; i++) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emails[i])) return jsonResponse({ success: false, message: 'מייל לא תקין: ' + emails[i] });
  }
  props.setProperty('GOOGLE_CLIENT_ID', clientId);
  props.setProperty('ALLOWED_DOMAIN', domain || DEFAULT_ALLOWED_DOMAIN);
  props.setProperty('ALLOWED_EMAILS', emails.join('\n'));
  if (!clientId) return jsonResponse({ success: true, message: 'ההגדרות נשמרו, אבל בלי Client ID אף אחד לא יוכל להיכנס - מלאו אותו' });
  return jsonResponse({ success: true, message: 'הגדרות הגישה נשמרו' });
}

/** אילו שירותים כבר מורשים לסקריפט (בעל הסקריפט מאשר פעם אחת דרך authorizeServices בעורך) */
function checkServices() {
  var out = {};
  try { MailApp.getRemainingDailyQuota(); out.mail = { ok: true }; } catch (e) { out.mail = { ok: false, message: String(e) }; }
  try { DriveApp.getRootFolder().getName(); out.drive = { ok: true }; } catch (e) { out.drive = { ok: false, message: String(e) }; }
  try { SpreadsheetApp.openById(SHEET_ID).getName(); out.sheets = { ok: true }; } catch (e) { out.sheets = { ok: false, message: String(e) }; }
  return out;
}

/** להרצה ידנית פעם אחת בעורך (Run) - מבקש את כל ההרשאות שהסקריפט צריך */
function authorizeServices() {
  SpreadsheetApp.openById(SHEET_ID).getName();
  UrlFetchApp.fetch('https://api.github.com', { muteHttpExceptions: true });
  MailApp.getRemainingDailyQuota();
  DriveApp.getRootFolder().getName();
  Logger.log('כל השירותים מורשים');
}

/* ---------- עזרי GitHub ---------- */
var GH_LAST_ERROR = ''; // השגיאה האחרונה מ-GitHub, כדי שהודעות הכישלון בפאנל יגידו מה באמת קרה

function ghHeaders(token) {
  return {
    'Authorization': 'Bearer ' + token,
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28'
  };
}

/** רושם שגיאה קריאה מ-GitHub עם רמז לפי קוד התגובה, ומחזיר אותה */
function ghNoteError(res, what) {
  var code = res.getResponseCode();
  var msg = '';
  try { msg = JSON.parse(res.getContentText()).message || ''; } catch (e) { msg = ''; }
  var hint = code === 401 ? 'הטוקן של GitHub פקע או בוטל - הדביקו טוקן חדש בפאנל, בלוק "חיבור GitHub"'
    : code === 403 ? 'לטוקן אין הרשאת כתיבה לריפו (צריך Contents: Read and write) או שנגמרה מכסת הבקשות'
    : code === 404 ? 'הריפו או הקובץ לא נמצאו, או שהטוקן לא מורשה לריפו הזה'
    : code === 409 ? 'התנגשות עם קומיט אחר באותו רגע - נסו שוב'
    : code === 422 ? 'GitHub דחה את הבקשה (קובץ קיים או תוכן לא תקין)'
    : code >= 500 ? 'תקלה זמנית ב-GitHub - נסו שוב בעוד דקה' : '';
  GH_LAST_ERROR = what + ': GitHub ' + code + (msg ? ' (' + msg + ')' : '') + (hint ? ' - ' + hint : '');
  return GH_LAST_ERROR;
}

/** תוספת להודעת כישלון: פירוט השגיאה האחרונה מ-GitHub, אם יש */
function ghDetail() {
  return GH_LAST_ERROR ? ' [' + GH_LAST_ERROR + ']' : '';
}

function ghGetFile(token, path) {
  var res = UrlFetchApp.fetch('https://api.github.com/repos/' + REPO + '/contents/' + path, {
    headers: ghHeaders(token),
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) { ghNoteError(res, 'קריאת ' + path); return null; }
  return JSON.parse(res.getContentText());
}

function ghPutFile(token, path, base64Content, message, sha) {
  var payload = { message: message, content: base64Content };
  if (sha) payload.sha = sha;
  var url = 'https://api.github.com/repos/' + REPO + '/contents/' + path;
  var opts = {
    method: 'put',
    contentType: 'application/json',
    headers: ghHeaders(token),
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };
  var res = UrlFetchApp.fetch(url, opts);
  var code = res.getResponseCode();
  if (code === 409 || code >= 500) { // התנגשות עם קומיט מקביל (למשל של ה-RSS) או תקלה זמנית - ניסיון נוסף
    Utilities.sleep(1500);
    res = UrlFetchApp.fetch(url, opts);
    code = res.getResponseCode();
  }
  if (code >= 300) { ghNoteError(res, 'כתיבת ' + path); return false; }
  GH_LAST_ERROR = '';
  return true;
}

/** בדיקת הטוקן מול GitHub: חיבור לריפו + תאריך התפוגה (כותרת github-authentication-token-expiration) */
function ghCheckToken(token) {
  if (!token) return { ok: false, message: 'לא מוגדר טוקן GitHub - הדביקו טוקן בפאנל, בלוק "חיבור GitHub"' };
  var res = UrlFetchApp.fetch('https://api.github.com/repos/' + REPO, { headers: ghHeaders(token), muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) return { ok: false, message: ghNoteError(res, 'בדיקת הטוקן') };
  var expires = '';
  var headers = res.getAllHeaders();
  for (var k in headers) {
    if (String(k).toLowerCase() === 'github-authentication-token-expiration') expires = String(headers[k]);
  }
  var expNote = '';
  if (expires) {
    var d = new Date(expires.replace(' UTC', 'Z').replace(' ', 'T'));
    if (!isNaN(d)) {
      var days = Math.round((d.getTime() - new Date().getTime()) / 86400000);
      expNote = ' תוקף הטוקן עד ' + Utilities.formatDate(d, 'Asia/Jerusalem', 'dd/MM/yyyy') +
        (days <= 14 ? ' (עוד ' + days + ' ימים - כדאי לחדש!)' : ' (עוד ' + days + ' ימים)');
    } else {
      expNote = ' תוקף הטוקן: ' + expires;
    }
  } else {
    expNote = ' לטוקן אין תאריך תפוגה.';
  }
  return { ok: true, expires: expires, message: 'מחובר לריפו ' + REPO + '.' + expNote };
}

/** שמירת טוקן GitHub חדש מהפאנל - רק אחרי שנבדק שהוא עובד וקורא את קובץ הכתבות */
function saveGitHubToken(req, props) {
  var token = String((req && req.token) || '').trim();
  if (!/^(github_pat_|ghp_|gho_|ghs_)[A-Za-z0-9_]{20,}$/.test(token)) {
    return jsonResponse({ success: false, message: 'זה לא נראה כמו טוקן של GitHub (צריך להתחיל ב-github_pat_ או ghp_)' });
  }
  var check = ghCheckToken(token);
  if (!check.ok) return jsonResponse({ success: false, message: 'הטוקן לא עבד. ' + check.message });
  if (!ghGetFile(token, ARTICLES_PATH)) {
    return jsonResponse({ success: false, message: 'הטוקן מתחבר, אבל לא קורא את ' + ARTICLES_PATH + ' - בדקו שנבחר הריפו הנכון עם Contents' + ghDetail() });
  }
  props.setProperty('GH_TOKEN', token);
  clearRoutingCache();
  return jsonResponse({ success: true, message: 'הטוקן נשמר ועובד. ' + check.message, expires: check.expires });
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
  if (!manual) return jsonResponse({ success: false, message: 'קריאת הכתבות נכשלה' + ghDetail() });
  var rss = readJsonFile(token, RSS_PATH) || { articles: [] };

  var pick = function (type) {
    return function (a) {
      return {
        id: a.id, title: a.title, category: a.category, date: a.date, type: type,
        createdAt: a.createdAt || a.date || '',
        createdBy: a.createdBy || (type === 'rss' ? 'אוטומטי (RSS)' : ''),
        createdVia: a.createdVia || (type === 'rss' ? 'rss' : (a.promotedFrom ? 'promoted' : '')),
        updatedAt: a.updatedAt || '',
        updatedBy: a.updatedBy || '',
        imageSource: imageSourceOf(a.image),
        featured: Boolean(a.featured),
        lead: a.lead && a.lead.enabled ? { campaignId: a.lead.campaignId || '', clientId: a.lead.clientId || '', campaign: a.lead.campaign || '' } : null,
        url: SITE_BASE + '/articles/' + a.id + '.html'
      };
    };
  };
  return jsonResponse({
    success: true,
    articles: manual.articles.map(pick('manual')).concat(rss.articles.map(pick('rss')))
  });
}

/** מקור התמונה לפי הכתובת שלה - לתצוגה בטבלת הכתבות */
function imageSourceOf(url) {
  var u = String(url || '');
  if (!u) return 'אין';
  if (u.indexOf('/uploads/gen-') > -1) return 'AI';
  if (u.indexOf('/uploads/up-') > -1) return 'העלאה';
  if (u.indexOf('/uploads/perm-') > -1) return 'AI (מ-RSS)';
  if (u.indexOf('/rss-img/') > -1) return 'AI (RSS)';
  if (u.indexOf('/img/cat-') > -1) return 'ברירת מחדל';
  return 'קישור חיצוני';
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

function saveArticle(req, props, isUpdate, user) {
  var token = requireToken(props);
  var article = req.article;
  if (!article || !article.id || !article.title || !article.body) {
    return jsonResponse({ success: false, message: 'לכתבה חסרים שדות חובה (מזהה, כותרת, גוף)' });
  }
  if (!/^[a-zA-Z0-9-]+$/.test(article.id)) {
    return jsonResponse({ success: false, message: 'המזהה יכול להכיל רק אותיות באנגלית, מספרים ומקפים' });
  }

  var manual = readJsonFile(token, ARTICLES_PATH);
  if (!manual) return jsonResponse({ success: false, message: 'קריאת הכתבות מגיטהאב נכשלה' + ghDetail() });
  var rss = readJsonFile(token, RSS_PATH) || { articles: [], path: RSS_PATH, sha: null };

  var manualIdx = findIndexById(manual.articles, article.id);
  var rssIdx = findIndexById(rss.articles, article.id);

  if (isUpdate) {
    // מעדכנים בקובץ שבו הכתבה נמצאת - ידני או RSS
    var target = manualIdx !== -1 ? manual : (rssIdx !== -1 ? rss : null);
    var idx = manualIdx !== -1 ? manualIdx : rssIdx;
    if (!target) return jsonResponse({ success: false, message: 'הכתבה לעדכון לא נמצאה' });
    var prev = target.articles[idx];
    article.date = prev.date; // שומרים את תאריך הפרסום המקורי
    article.createdAt = prev.createdAt || prev.date || '';
    article.createdBy = prev.createdBy || '';
    article.createdVia = prev.createdVia || (target === rss ? 'rss' : (prev.promotedFrom ? 'promoted' : 'manual'));
    if (prev.promotedFrom) { article.promotedFrom = prev.promotedFrom; article.promotedAt = prev.promotedAt; article.promotedBy = prev.promotedBy; }
    article.updatedAt = new Date().toISOString();
    article.updatedBy = user ? user.email : '';
    target.articles[idx] = article;
    if (!writeJsonFile(token, target, 'עדכון כתבה: ' + article.title + ' (' + (user ? user.email : '') + ')')) {
      return jsonResponse({ success: false, message: 'השמירה לגיטהאב נכשלה' + ghDetail() });
    }
  } else {
    if (manualIdx !== -1 || rssIdx !== -1) {
      return jsonResponse({ success: false, message: 'כבר קיימת כתבה עם המזהה "' + article.id + '" - בחרו מזהה אחר' });
    }
    article.createdAt = new Date().toISOString();
    article.createdBy = user ? user.email : '';
    article.createdVia = req.origin === 'ai' ? 'ai' : 'manual';
    manual.articles.unshift(article);
    if (!writeJsonFile(token, manual, 'כתבה חדשה: ' + article.title + ' (' + (user ? user.email : '') + ')')) {
      return jsonResponse({ success: false, message: 'השמירה לגיטהאב נכשלה' + ghDetail() });
    }
  }

  clearRoutingCache();
  return jsonResponse({
    success: true,
    message: isUpdate ? 'הכתבה עודכנה' : 'הכתבה פורסמה',
    url: SITE_BASE + '/articles/' + article.id + '.html'
  });
}

/* ---------- הפיכת כתבת RSS לכתבה קבועה ---------- */
function promoteArticle(req, props, user) {
  var token = requireToken(props);
  if (!req.id) return jsonResponse({ success: false, message: 'חסר מזהה כתבה' });

  var rss = readJsonFile(token, RSS_PATH);
  if (!rss) return jsonResponse({ success: false, message: 'קריאת כתבות ה-RSS נכשלה' + ghDetail() });
  var rssIdx = findIndexById(rss.articles, req.id);
  if (rssIdx === -1) {
    return jsonResponse({ success: false, message: 'הכתבה אינה כתבת RSS (אולי היא כבר קבועה?)' });
  }

  var manual = readJsonFile(token, ARTICLES_PATH);
  if (!manual) return jsonResponse({ success: false, message: 'קריאת הכתבות הקבועות נכשלה' + ghDetail() });

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
  promoted.promotedBy = user ? user.email : '';
  promoted.createdAt = new Date().toISOString();
  promoted.createdBy = user ? user.email : '';
  promoted.createdVia = 'promoted';

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
    return jsonResponse({ success: false, message: 'השמירה לכתבות הקבועות נכשלה' + ghDetail() });
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

  clearRoutingCache();
  return jsonResponse({
    success: true,
    message: 'הכתבה הפכה לקבועה',
    id: newId,
    url: SITE_BASE + '/articles/' + newId + '.html'
  });
}

/* ---------- מחיקת כתבה קבועה (כתבות RSS מתחלפות לבד) ---------- */
function deleteArticle(req, props, user) {
  var token = requireToken(props);
  if (!req.id) return jsonResponse({ success: false, message: 'חסר מזהה כתבה' });
  var manual = readJsonFile(token, ARTICLES_PATH);
  if (!manual) return jsonResponse({ success: false, message: 'קריאת הכתבות נכשלה' + ghDetail() });
  var idx = findIndexById(manual.articles, req.id);
  if (idx === -1) return jsonResponse({ success: false, message: 'הכתבה לא נמצאה בכתבות הקבועות (כתבת RSS מתחלפת לבד בסבב היומי)' });
  var removed = manual.articles.splice(idx, 1)[0];
  if (!writeJsonFile(token, manual, 'מחיקת כתבה: ' + removed.title + ' (' + (user ? user.email : '') + ')')) {
    return jsonResponse({ success: false, message: 'המחיקה נכשלה' + ghDetail() });
  }
  clearRoutingCache();
  return jsonResponse({ success: true, message: 'הכתבה "' + removed.title + '" נמחקה. האתר ייבנה מחדש תוך כמה דקות.' });
}

/* ---------- העלאת תמונה ---------- */
function uploadImage(req, props) {
  var token = requireToken(props);
  if (!req.dataBase64) return jsonResponse({ success: false, message: 'לא התקבלה תמונה' });
  var ext = String(req.mimeType || '').indexOf('png') > -1 ? 'png' : 'jpg';
  var name = 'up-' + new Date().getTime() + '.' + ext;
  var ok = ghPutFile(token, 'assets/uploads/' + name, req.dataBase64, 'העלאת תמונה: ' + name);
  if (!ok) return jsonResponse({ success: false, message: 'העלאת התמונה לגיטהאב נכשלה' + ghDetail() });
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
  if (!ok) return jsonResponse({ success: false, message: 'שמירת התמונה לגיטהאב נכשלה' + ghDetail() });

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

  var system = 'אתה כותב תוכן בכיר במגזין דיגיטלי ישראלי בשם "Channel 19". כתוב כתבת מגזין בעברית רהוטה על הנושא שתקבל.\n' +
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

/* ---------- לקוחות וקמפיינים: רישום בטאבים "לקוחות" ו"קמפיינים" בגיליון הראשי ---------- */
var CLIENTS_TAB = 'לקוחות';
var CAMPAIGNS_TAB = 'קמפיינים';
var CLIENT_HEADERS = ['מזהה', 'שם', 'מזהה גיליון', 'קישור לגיליון', 'מיילים להתראה', 'webhooks', 'שותף עם', 'נוצר', 'נוצר על ידי'];
var CAMPAIGN_HEADERS = ['מזהה', 'מזהה לקוח', 'שם', 'טאב בגיליון', 'מיילים להתראה', 'webhooks', 'נוצר', 'נוצר על ידי'];
var CLIENT_ALL_TAB = 'כל הלידים';
var REGISTRY_CACHE_KEY = 'registry-v1';
var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function registrySheet(ss, name, headers) {
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.appendRow(headers);
    sh.getRange(1, 1, 1, headers.length).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

function readRegistryRows(sh, headers) {
  var lastRow = sh.getLastRow();
  if (lastRow < 2) return [];
  return sh.getRange(2, 1, lastRow - 1, headers.length).getValues().map(function (r) {
    var o = {};
    headers.forEach(function (h, i) { o[h] = String(r[i] == null ? '' : r[i]).trim(); });
    return o;
  }).filter(function (o) { return o['מזהה']; });
}

/** { clients: {id: {...}}, campaigns: {id: {...}} } - במטמון 5 דקות (fresh=true קורא מהגיליון) */
function getRegistry(fresh) {
  var cache = CacheService.getScriptCache();
  if (!fresh) {
    var cached = cache.get(REGISTRY_CACHE_KEY);
    if (cached) { try { return JSON.parse(cached); } catch (e) { /* נקרא מחדש */ } }
  }
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var clients = {};
  readRegistryRows(registrySheet(ss, CLIENTS_TAB, CLIENT_HEADERS), CLIENT_HEADERS).forEach(function (r) {
    clients[r['מזהה']] = {
      id: r['מזהה'], name: r['שם'], sheetId: r['מזהה גיליון'], sheetUrl: r['קישור לגיליון'],
      emails: splitList(r['מיילים להתראה']), webhooks: splitList(r['webhooks']), sharedWith: r['שותף עם'],
      createdAt: r['נוצר'], createdBy: r['נוצר על ידי']
    };
  });
  var campaigns = {};
  readRegistryRows(registrySheet(ss, CAMPAIGNS_TAB, CAMPAIGN_HEADERS), CAMPAIGN_HEADERS).forEach(function (r) {
    campaigns[r['מזהה']] = {
      id: r['מזהה'], clientId: r['מזהה לקוח'], name: r['שם'], tab: r['טאב בגיליון'] || r['שם'],
      emails: splitList(r['מיילים להתראה']), webhooks: splitList(r['webhooks']),
      createdAt: r['נוצר'], createdBy: r['נוצר על ידי']
    };
  });
  var reg = { clients: clients, campaigns: campaigns };
  try { cache.put(REGISTRY_CACHE_KEY, JSON.stringify(reg), 300); } catch (e) { /* גדול מדי למטמון - ייקרא כל פעם */ }
  return reg;
}

function clearRegistryCache() {
  try { CacheService.getScriptCache().remove(REGISTRY_CACHE_KEY); } catch (e) { /* לא קריטי */ }
}

function newId(prefix) {
  return prefix + '-' + new Date().getTime().toString(36);
}

function extractSheetId(v) {
  var str = String(v || '').trim();
  var m = str.match(/\/spreadsheets\/d\/([A-Za-z0-9_-]{20,})/);
  if (m) return m[1];
  return /^[A-Za-z0-9_-]{20,}$/.test(str) ? str : '';
}

function validateEmails(list) {
  for (var i = 0; i < list.length; i++) if (!EMAIL_RE.test(list[i])) return 'מייל לא תקין: ' + list[i];
  return '';
}

function validateHooks(list) {
  for (var i = 0; i < list.length; i++) if (!/^https:\/\/\S+$/.test(list[i])) return 'webhook לא תקין (חייב https): ' + list[i];
  return '';
}

/** יצירה/עדכון לקוח. בלי גיליון קיים - נוצר גיליון חדש בדרייב של בעל הסקריפט ומשותף עם המיילים שצוינו */
function saveClient(req, user) {
  var name = String(req.name || '').trim();
  if (!name) return jsonResponse({ success: false, message: 'חסר שם לקוח' });
  var emails = splitList(req.notifyEmail);
  var hooks = splitList(req.webhooks);
  var shareWith = splitList(req.shareWith);
  var bad = validateEmails(emails) || validateHooks(hooks) || validateEmails(shareWith);
  if (bad) return jsonResponse({ success: false, message: bad });

  var ss = SpreadsheetApp.openById(SHEET_ID);
  var sh = registrySheet(ss, CLIENTS_TAB, CLIENT_HEADERS);
  var rows = readRegistryRows(sh, CLIENT_HEADERS);
  var id = String(req.id || '').trim();
  var existing = null, rowIndex = -1;
  rows.forEach(function (r, k) { if (id && r['מזהה'] === id) { existing = r; rowIndex = k + 2; } });

  var sheetId = extractSheetId(req.sheetUrl) || (existing ? existing['מזהה גיליון'] : '');
  var created = false;
  if (!sheetId) {
    var clientSs = SpreadsheetApp.create('לידים - ' + name);
    sheetId = clientSs.getId();
    var first = clientSs.getSheets()[0];
    first.setName(CLIENT_ALL_TAB);
    first.appendRow(HEADERS);
    first.getRange(1, 1, 1, HEADERS.length).setFontWeight('bold');
    first.setFrozenRows(1);
    applyStatusValidation(first, HEADERS);
    created = true;
  } else {
    try { SpreadsheetApp.openById(sheetId).getName(); } catch (e) { return jsonResponse({ success: false, message: 'אין גישה לגיליון הזה: ' + sheetId }); }
  }
  var sheetUrl = 'https://docs.google.com/spreadsheets/d/' + sheetId;

  var shared = [], shareError = '';
  if (shareWith.length) {
    try {
      var file = DriveApp.getFileById(sheetId);
      shareWith.forEach(function (em) {
        try { file.addEditor(em); shared.push(em); } catch (e) { shareError = String(e); }
      });
    } catch (e) {
      shareError = 'אין הרשאת Drive לסקריפט - יש להריץ authorizeServices בעורך, או לשתף ידנית';
    }
  }
  var sharedAll = splitList((existing ? existing['שותף עם'] : '') + ' ' + shared.join(' '))
    .filter(function (x, k, arr) { return arr.indexOf(x) === k; });

  if (!id) id = newId('c');
  var row = [id, name, sheetId, sheetUrl, emails.join(', '), hooks.join(' '), sharedAll.join(', '),
    existing ? existing['נוצר'] : Utilities.formatDate(new Date(), 'Asia/Jerusalem', 'dd/MM/yyyy HH:mm'),
    existing ? existing['נוצר על ידי'] : (user ? user.email : '')];
  if (rowIndex > 0) sh.getRange(rowIndex, 1, 1, row.length).setValues([row]); else sh.appendRow(row);
  clearRegistryCache();

  var msg = created ? 'הלקוח נוצר ונפתח לו גיליון לידים חדש' : 'הלקוח נשמר';
  if (shared.length) msg += '. הגיליון שותף עם ' + shared.join(', ');
  if (shareError) msg += '. שיתוף לא הושלם: ' + shareError;
  return jsonResponse({ success: true, message: msg, id: id, sheetUrl: sheetUrl, shared: shared });
}

/** יצירה/עדכון קמפיין תחת לקוח. הטאב בגיליון של הלקוח נפתח מיד */
function saveCampaign(req, user) {
  var name = String(req.name || '').trim();
  var clientId = String(req.clientId || '').trim();
  if (!name || !clientId) return jsonResponse({ success: false, message: 'חסר שם קמפיין או לקוח' });
  var reg = getRegistry(true);
  var client = reg.clients[clientId];
  if (!client) return jsonResponse({ success: false, message: 'לקוח לא נמצא' });
  var emails = splitList(req.notifyEmail);
  var hooks = splitList(req.webhooks);
  var bad = validateEmails(emails) || validateHooks(hooks);
  if (bad) return jsonResponse({ success: false, message: bad });
  var tab = sanitizeTabName(req.tab || name) || 'קמפיין';

  var ss = SpreadsheetApp.openById(SHEET_ID);
  var sh = registrySheet(ss, CAMPAIGNS_TAB, CAMPAIGN_HEADERS);
  var rows = readRegistryRows(sh, CAMPAIGN_HEADERS);
  var id = String(req.id || '').trim();
  var existing = null, rowIndex = -1;
  rows.forEach(function (r, k) { if (id && r['מזהה'] === id) { existing = r; rowIndex = k + 2; } });
  if (!id) id = newId('k');

  try { ensureSheetIn(SpreadsheetApp.openById(client.sheetId), tab); }
  catch (e) { return jsonResponse({ success: false, message: 'לא ניתן לפתוח טאב בגיליון של הלקוח: ' + e }); }

  var row = [id, clientId, name, tab, emails.join(', '), hooks.join(' '),
    existing ? existing['נוצר'] : Utilities.formatDate(new Date(), 'Asia/Jerusalem', 'dd/MM/yyyy HH:mm'),
    existing ? existing['נוצר על ידי'] : (user ? user.email : '')];
  if (rowIndex > 0) sh.getRange(rowIndex, 1, 1, row.length).setValues([row]); else sh.appendRow(row);
  clearRegistryCache();
  return jsonResponse({
    success: true,
    message: 'הקמפיין נשמר. הלידים שלו ייכנסו לטאב "' + tab + '" בגיליון של ' + client.name + ' (וגם לטאב הראשי)',
    id: id, tab: tab, sheetUrl: client.sheetUrl
  });
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

  /* ניתוב: כתבה -> קמפיין -> לקוח (הגיליון של הלקוח). הקמפיין נקרא מ-data/articles.json, הלקוח מרישום הלקוחות */
  var routing = getLeadRouting(str(p.article));
  var forcedCampaign = '';
  if (p._campaignId && p._nonce && cache.get('testnonce:' + String(p._nonce))) forcedCampaign = String(p._campaignId); // ליד בדיקה לקמפיין מהפאנל
  var reg = getRegistry(false);
  var campaign = (forcedCampaign || routing.campaignId) ? reg.campaigns[forcedCampaign || routing.campaignId] : null;
  var client = campaign ? reg.clients[campaign.clientId] : null;
  if (campaign) row['קמפיין'] = campaign.name;
  if (client) row['לקוח'] = client.name;
  var legacyTab = (!client && routing.tab && routing.tab !== SHEET_NAME) ? routing.tab : '';
  row['יעד'] = client ? client.name + ' / ' + (campaign.tab || campaign.name) : (legacyTab || SHEET_NAME);

  /* שדות מותאמים של הטופס (למשל "תקציב" או "סוג נכס"): עמודה לפי הטקסט של השדה, רק לשדות שהוגדרו בכתבה */
  var extras = [];
  var extraHeaders = [];
  (routing.fields || []).forEach(function (f) {
    var v = str(p[f.name]);
    if (!v) return;
    var col = f.label;
    if (SYSTEM_COLUMNS.indexOf(col) > -1) col = col + ' (טופס)';
    if (row.hasOwnProperty(col) && row[col]) col = col + ' 2';
    row[col] = v;
    if (HEADERS.indexOf(col) === -1) extraHeaders.push(col);
    extras.push([f.label, v]);
  });

  /* כתיבה תחת נעילה - כמה לידים באותה שנייה לא דורסים זה את זה.
     כל ליד נרשם בטאב הראשי "לידים" (תמונה מלאה לסוכנות), ואם יש לקוח - גם בגיליון של הלקוח:
     בטאב "כל הלידים" ובטאב של הקמפיין */
  var lock = LockService.getScriptLock();
  var locked = lock.tryLock(15000);
  var targets = [];
  var writeErrors = [];
  var appendTo = function (ss, tabName) {
    var sheet = ensureSheetIn(ss, tabName);
    var headers = ensureHeaders(sheet, extraHeaders);
    sheet.appendRow(headers.map(function (h) { return row.hasOwnProperty(h) ? row[h] : ''; }));
    targets.push({ sheet: sheet, headers: headers, rowIndex: sheet.getLastRow() });
  };
  try {
    var master = SpreadsheetApp.openById(SHEET_ID);
    appendTo(master, SHEET_NAME);
    if (legacyTab) appendTo(master, legacyTab);
    if (client && client.sheetId) {
      try {
        var clientSs = SpreadsheetApp.openById(client.sheetId);
        appendTo(clientSs, CLIENT_ALL_TAB);
        appendTo(clientSs, campaign.tab || campaign.name);
      } catch (err) {
        writeErrors.push('הגיליון של הלקוח ' + client.name + ': ' + err);
      }
    }
  } finally {
    if (locked) lock.releaseLock();
  }

  cache.put('lead:' + leadId, '1', 3600);
  if (phone) cache.put('phone:' + phone, '1', 86400);

  /* העברה ל-webhooks (כלליים + של הכתבה) והתראה במייל (כללי + של הכתבה). כישלון שם לא מכשיל את הליד */
  var route = {
    emails: [].concat(client ? client.emails : [], campaign ? campaign.emails : [], routing.emails || []),
    webhooks: [].concat(client ? client.webhooks : [], campaign ? campaign.webhooks : [], routing.webhooks || [])
  };
  var forwarded = forwardLead(row, flags, route, extras);
  if (forwarded) {
    for (var k = 0; k < targets.length; k++) {
      var col = targets[k].headers.indexOf('העברה') + 1;
      if (col > 0) targets[k].sheet.getRange(targets[k].rowIndex, col).setValue(forwarded);
    }
  }
  var notified = notifyLead(row, flags, route, extras);

  var out = { success: true, message: 'הליד נקלט', leadId: leadId };
  if (writeErrors.length) out.warning = writeErrors.join(' | ');
  if (p.test) {
    out.routing = {
      tab: row['יעד'], client: client ? client.name : '', campaign: campaign ? campaign.name : '',
      clientSheetUrl: client ? client.sheetUrl : '', emails: notified, forwarded: forwarded, warning: out.warning || ''
    };
  }
  return jsonResponse(out);
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
  return ensureSheetIn(SpreadsheetApp.openById(SHEET_ID), name);
}

/** מחזיר טאב בגיליון הנתון, ויוצר אותו (עם כותרות) אם אינו קיים */
function ensureSheetIn(ss, name) {
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

/** משלים עמודות חסרות בשורת הכותרת (בסוף, בלי להזיז נתונים קיימים) ומחזיר את סדר הכותרות בפועל. extra = עמודות של שדות מותאמים */
function ensureHeaders(sheet, extra) {
  var lastCol = Math.max(sheet.getLastColumn(), 1);
  var current = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function (v) { return String(v).trim(); });
  while (current.length && !current[current.length - 1]) current.pop();
  var missing = HEADERS.concat(extra || []).filter(function (h, i, arr) { return current.indexOf(h) === -1 && arr.indexOf(h) === i; });
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
function extrasToObject(extras) {
  var o = {};
  (extras || []).forEach(function (e) { o[e[0]] = e[1]; });
  return o;
}

function leadPayload(row, flags, extras) {
  return {
    source: 'channel19',
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
    client: row['לקוח'] || '',
    page: row['עמוד'],
    pageUrl: row['כתובת מלאה'],
    utm_source: row['utm_source'],
    utm_medium: row['utm_medium'],
    utm_campaign: row['utm_campaign'],
    utm_content: row['utm_content'],
    utm_term: row['utm_term'],
    clickId: row['מזהה קליק'],
    sheetTab: row['יעד'] || '',
    extra: extrasToObject(extras),
    flags: flags,
    test: flags.indexOf('בדיקה') > -1
  };
}

function getForwardUrls() {
  var raw = PropertiesService.getScriptProperties().getProperty('FORWARD_WEBHOOKS') || '';
  return raw.split(/[\s,]+/).filter(function (u) { return /^https?:\/\/\S+$/.test(u); });
}

/** שולח את הליד לכל ה-webhooks במקביל ומחזיר סיכום קצר לעמודת "העברה" */
function forwardLead(row, flags, routing, extras) {
  var urls = getForwardUrls();
  if (routing && routing.webhooks) {
    routing.webhooks.forEach(function (u) { if (urls.indexOf(u) === -1) urls.push(u); });
  }
  if (!urls.length) return '';
  var body = JSON.stringify(leadPayload(row, flags, extras));
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
function notifyLead(row, flags, routing, extras) {
  var recipients = splitList(PropertiesService.getScriptProperties().getProperty('NOTIFY_EMAIL'));
  if (routing && routing.emails) {
    routing.emails.forEach(function (e) { if (recipients.indexOf(e) === -1) recipients.push(e); });
  }
  recipients = recipients.filter(function (e) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e); });
  if (!recipients.length) return 0;
  var to = recipients.join(',');
  try {
    var phone = String(row['טלפון'] || '').replace(/^'/, '');
    var subject = (flags.indexOf('בדיקה') > -1 ? '[בדיקה] ' : '') +
      'ליד חדש: ' + (row['שם מלא'] || phone) + (row['קמפיין'] ? ' - ' + row['קמפיין'] : '');
    var lines = [
      ['שם', row['שם מלא']], ['טלפון', phone], ['דוא"ל', row['דוא"ל']], ['עיר', row['עיר']],
      ['לקוח', row['לקוח']], ['קמפיין', row['קמפיין']], ['כתבה', row['כתבה']],
      ['מקור', [row['utm_source'], row['utm_medium'], row['utm_campaign']].filter(String).join(' / ')],
      ['זמן', row['תאריך'] + ' ' + row['שעה']], ['דגלים', row['דגלים']], ['טאב בגיליון', row['יעד']]
    ].concat(extras || []).filter(function (l) { return l[1]; });
    var html = '<div dir="rtl" style="font-family:Arial,sans-serif;font-size:15px">' +
      '<h2 style="margin:0 0 12px">ליד חדש מ-Channel 19</h2>' +
      '<table cellpadding="6" style="border-collapse:collapse">' +
      lines.map(function (l) {
        return '<tr><td style="color:#666">' + l[0] + '</td><td><b>' + escapeHtml(l[1]) + '</b></td></tr>';
      }).join('') +
      '</table>' +
      (phone ? '<p><a href="tel:' + phone + '">📞 התקשרו עכשיו</a> · <a href="https://wa.me/972' + phone.slice(1) + '">💬 וואטסאפ</a></p>' : '') +
      '<p style="color:#888;font-size:12px"><a href="' + SHEET_URL + '">לגיליון הלידים</a></p></div>';
    MailApp.sendEmail({ to: to, subject: subject, htmlBody: html, name: 'Channel 19 לידים' });
  } catch (err) { /* מייל שנפל לא מכשיל את הליד */ }
  return recipients.length;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
  });
}

/* ---------- ניתוב לידים לפי כתבה ---------- */
/** שם טאב חוקי בגיליון: בלי [ ] * ? / \ : ועד 60 תווים */
function sanitizeTabName(name) {
  return String(name || '').replace(/[\[\]\*\?\/\\:]/g, '-').replace(/\s+/g, ' ').trim().slice(0, 60);
}

function splitList(v) {
  return String(v || '').split(/[\s,;]+/).map(function (x) { return x.trim(); }).filter(Boolean);
}

/** שדות מותאמים שהוגדרו בטופס של הכתבה (מעבר לשם/טלפון/מייל/עיר): [{name, label}] */
function customFields(fields) {
  var out = [];
  (fields || []).forEach(function (f) {
    if (!f || !f.name || STANDARD_FIELD_NAMES.indexOf(f.name) > -1) return;
    var name = String(f.name).replace(/[^\w-]/g, '').slice(0, 40);
    if (!name) return;
    out.push({ name: name, label: String(f.label || name).trim().slice(0, 60) || name });
  });
  return out;
}

/**
 * מפת ניתוב לכל הכתבות: { articleId: { tab, emails[], webhooks[], fields[] } }.
 * נקראת מ-data/articles.json (דרך GitHub API - תמיד הגרסה העדכנית; בלי טוקן - מ-raw) ונשמרת במטמון ל-10 דקות.
 * הפאנל מנקה את המטמון בכל שמירת כתבה, כך שהגדרה חדשה תופסת מיד.
 */
function loadRoutingMap() {
  var cache = CacheService.getScriptCache();
  var cached = cache.get(ROUTING_CACHE_KEY);
  if (cached) {
    try { return JSON.parse(cached); } catch (e) { /* נטען מחדש */ }
  }
  var map = {};
  try {
    var token = PropertiesService.getScriptProperties().getProperty('GH_TOKEN');
    var articles = null;
    if (token) {
      var data = readJsonFile(token, ARTICLES_PATH);
      if (data) articles = data.articles;
    }
    if (!articles) {
      var res = UrlFetchApp.fetch('https://raw.githubusercontent.com/' + REPO + '/main/' + ARTICLES_PATH + '?t=' + new Date().getTime(), { muteHttpExceptions: true });
      if (res.getResponseCode() === 200) articles = JSON.parse(res.getContentText());
    }
    (articles || []).forEach(function (a) {
      if (!a || !a.id || !a.lead) return;
      var L = a.lead;
      map[a.id] = {
        tab: L.sheetTab ? (sanitizeTabName(L.sheetTab) || SHEET_NAME) : SHEET_NAME,
        campaignId: String(L.campaignId || ''),
        emails: splitList(L.notifyEmail),
        fields: customFields(L.fields),
        webhooks: splitList(L.webhooks).filter(function (u) { return /^https:\/\/\S+$/.test(u); })
      };
    });
    cache.put(ROUTING_CACHE_KEY, JSON.stringify(map), 600);
  } catch (err) { /* בלי ניתוב - הכול נרשם בטאב הראשי */ }
  return map;
}

/** ניתוב לליד לפי הכתבה. כתבה לא מוכרת - רק הטאב הראשי (כדי שאף אחד לא ייצר טאבים דרך הטופס) */
function getLeadRouting(articleId) {
  var r = articleId ? loadRoutingMap()[articleId] : null;
  if (!r) return { tab: SHEET_NAME, emails: [], webhooks: [], fields: [], campaignId: '' };
  return { tab: r.tab || SHEET_NAME, emails: r.emails || [], webhooks: r.webhooks || [], fields: r.fields || [], campaignId: r.campaignId || '' };
}

function clearRoutingCache() {
  try { CacheService.getScriptCache().remove(ROUTING_CACHE_KEY); } catch (e) { /* לא קריטי */ }
}

/* ---------- ניהול לידים מפאנל הניהול (עם סיסמה) ---------- */
function listTabs() {
  try {
    return SpreadsheetApp.openById(SHEET_ID).getSheets().map(function (sh) { return sh.getName(); })
      .filter(function (n) { return n !== CLIENTS_TAB && n !== CAMPAIGNS_TAB; });
  } catch (e) { return []; }
}

function getLeadSettings(props) {
  return jsonResponse({
    success: true,
    notifyEmail: props.getProperty('NOTIFY_EMAIL') || '',
    forwardWebhooks: getForwardUrls().join('\n'),
    sheetUrl: SHEET_URL,
    tabs: listTabs()
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

/** ליד בדיקה שעובר את כל השרשרת (טאבים, מייל, webhooks) ומסומן "בדיקה". עם article - לפי הניתוב של הכתבה */
function testLead(req) {
  clearRoutingCache(); // שהבדיקה תשתמש בהגדרות העדכניות של הכתבה והרישום
  clearRegistryCache();
  var nonce = Utilities.getUuid();
  CacheService.getScriptCache().put('testnonce:' + nonce, '1', 60);
  var res = addLead({
    leadId: 'test-' + new Date().getTime(),
    fullname: 'ליד בדיקה',
    phone: '0501234567',
    email: 'test@example.com',
    city: 'תל אביב',
    article: (req && req.article) || 'test',
    campaign: (req && req.campaign) || 'test',
    page: SITE_BASE + '/',
    pageUrl: SITE_BASE + '/?utm_source=test',
    utm_source: 'test',
    utm_medium: 'admin',
    utm_campaign: 'test-lead',
    test: true,
    _nonce: nonce,
    _campaignId: (req && req.campaignId) || ''
  });
  var data = JSON.parse(res.getContent());
  data.notifyEmail = PropertiesService.getScriptProperties().getProperty('NOTIFY_EMAIL') || '';
  data.sheetUrl = SHEET_URL;
  return jsonResponse(data);
}

function getRecentLeads(req) {
  var tab = sanitizeTabName((req && req.tab) || '');
  var ss, sheetUrl = SHEET_URL;
  if (req && req.clientId) {
    var client = getRegistry(false).clients[String(req.clientId)];
    if (!client) return jsonResponse({ success: false, message: 'לקוח לא נמצא' });
    ss = SpreadsheetApp.openById(client.sheetId);
    sheetUrl = client.sheetUrl;
    if (!tab) tab = CLIENT_ALL_TAB;
  } else {
    ss = SpreadsheetApp.openById(SHEET_ID);
    if (!tab) tab = SHEET_NAME;
  }
  var sheet = ss.getSheetByName(tab);
  if (!sheet) return jsonResponse({ success: false, message: 'אין טאב בשם "' + tab + '"' });
  var headers = ensureHeaders(sheet);
  var lastRow = sheet.getLastRow();
  var n = Math.min(Number((req && req.limit) || 20), 100);
  var base = { success: true, headers: headers, tab: tab, tabs: listTabs(), sheetUrl: sheetUrl };
  if (lastRow < 2) { base.rows = []; base.total = 0; return jsonResponse(base); }
  var start = Math.max(2, lastRow - n + 1);
  base.rows = sheet.getRange(start, 1, lastRow - start + 1, headers.length).getDisplayValues().reverse();
  base.total = lastRow - 1;
  return jsonResponse(base);
}

/** מוחק את השורות שמסומנות "בדיקה" בעמודת הדגלים - בגיליון הראשי ובגיליונות של כל הלקוחות */
function deleteTestLeadsIn(ss, label, acc) {
  ss.getSheets().forEach(function (sheet) {
    var lastRow = sheet.getLastRow();
    var lastCol = sheet.getLastColumn();
    if (lastRow < 2 || lastCol < 1) return;
    var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(String);
    var flagCol = headers.indexOf('דגלים');
    if (flagCol === -1) return;
    var flags = sheet.getRange(2, flagCol + 1, lastRow - 1, 1).getValues();
    var count = 0;
    for (var i = flags.length - 1; i >= 0; i--) { // מלמטה למעלה כדי שהאינדקסים לא יזוזו
      if (String(flags[i][0]).indexOf('בדיקה') > -1) { sheet.deleteRow(i + 2); count++; }
    }
    if (count) { acc.removed += count; acc.tabs.push(label + sheet.getName() + ' (' + count + ')'); }
  });
}

function deleteTestLeads() {
  var acc = { removed: 0, tabs: [] };
  deleteTestLeadsIn(SpreadsheetApp.openById(SHEET_ID), '', acc);
  var reg = getRegistry(true);
  Object.keys(reg.clients).forEach(function (id) {
    var c = reg.clients[id];
    try { deleteTestLeadsIn(SpreadsheetApp.openById(c.sheetId), c.name + ' / ', acc); } catch (e) { /* גיליון לא זמין */ }
  });
  return jsonResponse({ success: true, removed: acc.removed, message: acc.removed ? 'נמחקו ' + acc.removed + ' לידי בדיקה: ' + acc.tabs.join(', ') : 'לא נמצאו לידי בדיקה' });
}

/* ---------- עזרים ---------- */
function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
