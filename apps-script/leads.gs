/**
 * Channel 19 - שרת ניהול: לידים + פרסום/עריכת כתבות + יצירת תוכן ותמונות
 * =====================================================================
 * נפרס כ-Web app: Execute as Me | Who has access: Anyone
 *
 * סודות (Script Properties): GH_TOKEN, GEMINI_KEY
 * הגדרות לידים (Script Properties, נערכות מפאנל הניהול -> "לידים"):
 *   NOTIFY_EMAIL     - מיילים של הסוכנות (מופרדים בפסיק) שמקבלים את הלידים לפי התדירות שנבחרה (ריק = בלי)
 *   NOTIFY_MODE      - מתי נשלח מייל: weekly (ברירת מחדל: סיכום שבועי) | daily (סיכום יומי) | instant (על כל ליד) | off
 *   NOTIFY_DAY       - יום הסיכום השבועי (0 = ראשון ... 6 = שבת; ברירת מחדל 0)
 *   NOTIFY_HOUR      - שעת הסיכום (0-23; ברירת מחדל 8). הסיכום יוצא בשעה שאחריה (טריגר שעתי)
 *   NOTIFY_EMPTY     - '1' (ברירת מחדל) = לשלוח סיכום גם כשלא היו לידים, '0' = לדלג
 *   DIGEST_LAST:<general|clientId> - סוף התקופה האחרונה שסוכמה (ISO); DIGEST_LAST_RUN - יומן הריצה האחרונה (JSON)
 *   FORWARD_WEBHOOKS - כתובות https (מופרדות בשורה/פסיק) שכל ליד נשלח אליהן כ-JSON (CRM / Make / Zapier) - תמיד מיידית
 * סיכומים: טריגר שעתי (runLeadDigests) בודק אם הגיע המועד לפי ההגדרה הכללית ולפי התדירות של כל לקוח
 * (עמודה "תדירות מיילים" ברישום הלקוחות; ריק = כמו הכללי). לקוח "מיידי" מקבל כל ליד גם כשהכללי הוא סיכום.
 * הטריגר מותקן ב-authorizeServices (בעורך) או בשמירת ההגדרות מהפאנל (דורש הרשאת script.scriptapp במניפסט).
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

/* מתי נשלח מייל על לידים (ההגדרה הכללית NOTIFY_MODE, ו"תדירות מיילים" לכל לקוח) */
var NOTIFY_MODES = ['weekly', 'daily', 'instant', 'off'];
var NOTIFY_MODE_LABELS = { weekly: 'סיכום שבועי', daily: 'סיכום יומי', instant: 'מייל מיידי על כל ליד', off: 'בלי מיילים' };
var DAY_NAMES = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
var DIGEST_TRIGGER_FN = 'runLeadDigests';
var DIGEST_MAX_ROWS = 150; // מקסימום שורות לידים בגוף מייל הסיכום (השאר - בגיליון)

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
      case 'sendDigestNow':
        return sendDigestNow(req, props, user);
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
  out.triggers = digestTriggerStatus(); // טריגר שעתי לסיכומי הלידים (דורש script.scriptapp)
  return out;
}

/** מאפס את ההרשאה של בעל הסקריפט - להרצה בעורך כשגוגל אישרה רק חלק מההרשאות (למשל Drive לקריאה בלבד).
 *  אחרי ההרצה, ההפעלה הבאה של כל פונקציה תבקש את כל ההרשאות מחדש. עד האישור מחדש ה-web app לא פעיל - לאשר מיד. */
function resetAuthorization() {
  ScriptApp.invalidateAuth();
  Logger.log('ההרשאה אופסה - הריצו עכשיו authorizeServices ואשרו את כל ההרשאות (כולל Drive מלא)');
}

/** להרצה ידנית פעם אחת בעורך (Run) - מבקש את כל ההרשאות שהסקריפט צריך */
function authorizeServices() {
  SpreadsheetApp.openById(SHEET_ID).getName();
  UrlFetchApp.fetch('https://api.github.com', { muteHttpExceptions: true });
  MailApp.getRemainingDailyQuota();
  DriveApp.getRootFolder().getName();
  ScriptApp.getProjectTriggers(); // הרשאת טריגרים - לסיכומי הלידים
  var trig = installDigestTrigger();
  Logger.log('כל השירותים מורשים. ' + trig.message);
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
var CLIENT_HEADERS = ['מזהה', 'שם', 'מזהה גיליון', 'קישור לגיליון', 'מיילים להתראה', 'webhooks', 'שותף עם', 'נוצר', 'נוצר על ידי', 'תדירות מיילים'];
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
    return sh;
  }
  /* עמודות שנוספו לרישום (למשל "תדירות מיילים") מתווספות בסוף שורת הכותרת של רישום קיים */
  var current = sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), 1)).getValues()[0].map(function (v) { return String(v).trim(); });
  while (current.length && !current[current.length - 1]) current.pop();
  var missing = headers.filter(function (h) { return current.indexOf(h) === -1; });
  if (missing.length) sh.getRange(1, current.length + 1, 1, missing.length).setValues([missing]).setFontWeight('bold');
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
      createdAt: r['נוצר'], createdBy: r['נוצר על ידי'],
      notifyMode: normalizeMode(r['תדירות מיילים']) // '' = כמו ההגדרה הכללית
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
  /* תדירות המיילים של הלקוח ('' = כמו ההגדרה הכללית) - חלה על המיילים של הלקוח ושל הקמפיינים שלו */
  var hasMode = Object.prototype.hasOwnProperty.call(req, 'notifyMode');
  var reqMode = hasMode ? normalizeMode(req.notifyMode) : '';
  if (hasMode && String(req.notifyMode || '').trim() && !reqMode) return jsonResponse({ success: false, message: 'תדירות מיילים לא מוכרת: ' + req.notifyMode });

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
  var prevMode = existing ? normalizeMode(existing['תדירות מיילים']) : '';
  var notifyMode = hasMode ? reqMode : prevMode;
  var row = [id, name, sheetId, sheetUrl, emails.join(', '), hooks.join(' '), sharedAll.join(', '),
    existing ? existing['נוצר'] : Utilities.formatDate(new Date(), 'Asia/Jerusalem', 'dd/MM/yyyy HH:mm'),
    existing ? existing['נוצר על ידי'] : (user ? user.email : ''), notifyMode];
  if (rowIndex > 0) sh.getRange(rowIndex, 1, 1, row.length).setValues([row]); else sh.appendRow(row);
  clearRegistryCache();
  var generalMode = getNotifySettings().mode;
  noteModeChange(id, existing ? (prevMode || generalMode) : '', notifyMode || generalMode);

  var msg = created ? 'הלקוח נוצר ונפתח לו גיליון לידים חדש' : 'הלקוח נשמר';
  if (shared.length) msg += '. הגיליון שותף עם ' + shared.join(', ');
  if (shareError) msg += '. שיתוף לא הושלם: ' + shareError;
  msg += '. מיילים ללקוח: ' + NOTIFY_MODE_LABELS[notifyMode || generalMode] + (notifyMode ? '' : ' (לפי ההגדרה הכללית)');
  var out = { success: true, message: msg, id: id, sheetUrl: sheetUrl, shared: shared, notifyMode: notifyMode };
  if (isDigestMode(notifyMode || generalMode)) {
    var trig = installDigestTrigger();
    if (!trig.ok) out.warning = trig.message;
  }
  return jsonResponse(out);
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

  /* העברה ל-webhooks (כלליים + של הלקוח + של הקמפיין + של הכתבה) - תמיד מיידית. כישלון שם לא מכשיל את הליד */
  var route = {
    webhooks: [].concat(client ? client.webhooks : [], campaign ? campaign.webhooks : [], routing.webhooks || [])
  };
  var forwarded = forwardLead(row, flags, route, extras);
  if (forwarded) {
    for (var k = 0; k < targets.length; k++) {
      var col = targets[k].headers.indexOf('העברה') + 1;
      if (col > 0) targets[k].sheet.getRange(targets[k].rowIndex, col).setValue(forwarded);
    }
  }

  /* מייל: מיידי רק למי שהתדירות שלו "מייל מיידי על כל ליד" - הסוכנות (ומיילים ברמת כתבה) לפי ההגדרה הכללית,
     הלקוח והקמפיינים שלו לפי התדירות של הלקוח (ריק = כמו הכללי). כל השאר מקבלים את הליד בסיכום היומי/השבועי */
  var settings = getNotifySettings();
  var clientMode = client ? (client.notifyMode || settings.mode) : settings.mode;
  var instant = [];
  if (settings.mode === 'instant') instant = instant.concat(splitList(PropertiesService.getScriptProperties().getProperty('NOTIFY_EMAIL')), routing.emails || []);
  if (client && clientMode === 'instant') instant = instant.concat(client.emails || [], campaign ? campaign.emails : []);
  var notified = instant.length ? notifyLead(row, flags, instant, extras) : 0;

  var out = { success: true, message: 'הליד נקלט', leadId: leadId };
  if (writeErrors.length) out.warning = writeErrors.join(' | ');
  if (p.test) {
    out.routing = {
      tab: row['יעד'], client: client ? client.name : '', campaign: campaign ? campaign.name : '',
      clientSheetUrl: client ? client.sheetUrl : '', emails: notified, forwarded: forwarded, warning: out.warning || '',
      notifyMode: settings.mode, notifyModeLabel: NOTIFY_MODE_LABELS[settings.mode],
      clientMode: client ? clientMode : '', clientModeLabel: client ? NOTIFY_MODE_LABELS[clientMode] : ''
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

/** מייל מיידי על ליד חדש - לנמענים שהתדירות שלהם "מייל מיידי על כל ליד" - עם קישורי חיוג ווואטסאפ */
function notifyLead(row, flags, recipients, extras) {
  recipients = (recipients || []).filter(function (e, i, arr) { return EMAIL_RE.test(e) && arr.indexOf(e) === i; });
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

/* ---------- מתי נשלח מייל על לידים: מיידי / סיכום יומי / סיכום שבועי / בלי ---------- */
/** ההגדרה הכללית מ-Script Properties. ברירת מחדל: סיכום שבועי ביום ראשון בסביבות 08:00, נשלח גם כשאין לידים */
function getNotifySettings() {
  var props = PropertiesService.getScriptProperties();
  var day = parseInt(props.getProperty('NOTIFY_DAY'), 10);
  var hour = parseInt(props.getProperty('NOTIFY_HOUR'), 10);
  var empty = props.getProperty('NOTIFY_EMPTY');
  return {
    mode: normalizeMode(props.getProperty('NOTIFY_MODE')) || 'weekly',
    day: isNaN(day) || day < 0 || day > 6 ? 0 : day,
    hour: isNaN(hour) || hour < 0 || hour > 23 ? 8 : hour,
    empty: empty === null || empty === '' ? true : empty === '1'
  };
}

/** מפתח תדירות תקין ('' אם לא מוכר). מקבל גם מילים בעברית שנכתבו ידנית בעמודה "תדירות מיילים" ברישום הלקוחות */
function normalizeMode(v) {
  v = String(v || '').trim().toLowerCase();
  var he = { 'מיידי': 'instant', 'יומי': 'daily', 'שבועי': 'weekly', 'בלי': 'off', 'ללא': 'off', 'כבוי': 'off' };
  if (he[v]) return he[v];
  return NOTIFY_MODES.indexOf(v) > -1 ? v : '';
}

function isDigestMode(mode) { return mode === 'weekly' || mode === 'daily'; }
function pad2(n) { return (n < 10 ? '0' : '') + n; }

function describeSchedule(s) {
  if (s.mode === 'weekly') return 'סיכום שבועי בכל יום ' + DAY_NAMES[s.day] + ' בסביבות ' + pad2(s.hour) + ':00';
  if (s.mode === 'daily') return 'סיכום יומי בסביבות ' + pad2(s.hour) + ':00';
  if (s.mode === 'instant') return 'מייל מיידי על כל ליד';
  return 'בלי מיילים - הלידים נרשמים בגיליון ונשלחים ל-webhooks בלבד';
}

/** המועד האחרון (עד now) שבו הסיכום היה אמור לצאת: שבועי - היום והשעה שנבחרו, יומי - השעה שנבחרה. בשעון הסקריפט (ישראל) */
function lastScheduledTime(mode, s, now) {
  var t = new Date(now.getFullYear(), now.getMonth(), now.getDate(), s.hour, 0, 0, 0);
  if (mode === 'weekly') {
    t.setDate(t.getDate() - ((now.getDay() - s.day + 7) % 7));
    if (t > now) t.setDate(t.getDate() - 7);
  } else if (t > now) {
    t.setDate(t.getDate() - 1);
  }
  return t;
}

function nextScheduledTime(mode, s, now) {
  var t = lastScheduledTime(mode, s, now);
  t.setDate(t.getDate() + (mode === 'weekly' ? 7 : 1));
  return t;
}

function fmtDT(d) { return Utilities.formatDate(d, 'Asia/Jerusalem', 'dd/MM/yyyy HH:mm'); }

function fmtPeriod(start, end) {
  var tz = 'Asia/Jerusalem';
  var sd = Utilities.formatDate(start, tz, 'dd/MM/yyyy');
  if (sd === Utilities.formatDate(end, tz, 'dd/MM/yyyy')) return sd + ' ' + Utilities.formatDate(start, tz, 'HH:mm') + '-' + Utilities.formatDate(end, tz, 'HH:mm');
  return Utilities.formatDate(start, tz, 'dd/MM HH:mm') + ' - ' + Utilities.formatDate(end, tz, 'dd/MM/yyyy HH:mm');
}

/** כשקבוצה עוברת לתדירות סיכום (או שעדיין אין לה סימון תקופה) - התקופה מתחילה עכשיו והסיכום הראשון יוצא במועד הבא */
function noteModeChange(key, oldMode, newMode) {
  if (!isDigestMode(newMode)) return;
  var props = PropertiesService.getScriptProperties();
  if (!isDigestMode(oldMode) || !props.getProperty('DIGEST_LAST:' + key)) props.setProperty('DIGEST_LAST:' + key, new Date().toISOString());
}

/** קבוצות הסיכום: 'general' = מיילי הסוכנות (+ מיילים ברמת כתבה) לפי ההגדרה הכללית; לכל לקוח קבוצה לפי התדירות שלו */
function digestGroups(settings, reg) {
  var groups = [{ key: 'general', label: 'הסוכנות', mode: settings.mode }];
  Object.keys(reg.clients).forEach(function (id) {
    var c = reg.clients[id];
    groups.push({ key: id, label: c.name, mode: c.notifyMode || settings.mode, client: c });
  });
  return groups;
}

/** הנמענים של קבוצה. לכל נמען מסנן ללידים שרלוונטיים לו (null = כל הלידים) וקישור לגיליון שלו */
function groupRecipients(g, reg, routingMap) {
  var list = [];
  if (g.key === 'general') {
    splitList(PropertiesService.getScriptProperties().getProperty('NOTIFY_EMAIL')).forEach(function (e) {
      list.push({ email: e, filter: null, sheetUrl: SHEET_URL, scope: '' });
    });
    Object.keys(routingMap || {}).forEach(function (articleId) {
      (routingMap[articleId].emails || []).forEach(function (e) {
        list.push({ email: e, filter: function (r) { return r['כתבה'] === articleId; }, sheetUrl: '', scope: 'הכתבה ' + articleId });
      });
    });
    return list;
  }
  var c = g.client;
  (c.emails || []).forEach(function (e) {
    list.push({ email: e, filter: function (r) { return r['לקוח'] === c.name; }, sheetUrl: c.sheetUrl, scope: c.name });
  });
  Object.keys(reg.campaigns).forEach(function (kid) {
    var k = reg.campaigns[kid];
    if (k.clientId !== c.id) return;
    (k.emails || []).forEach(function (e) {
      list.push({ email: e, filter: function (r) { return r['לקוח'] === c.name && r['קמפיין'] === k.name; }, sheetUrl: c.sheetUrl, scope: c.name + ' / ' + k.name });
    });
  });
  return list;
}

/**
 * הטריגר השעתי (וגם "שליחת הסיכום עכשיו" עם force): לכל קבוצה בתדירות סיכום בודק אם הגיע המועד ועוד לא נשלח,
 * קורא פעם אחת את הלידים של התקופה מהטאב הראשי (בלי לידי בדיקה) ושולח לכל נמען את הלידים שלו.
 * קבוצה בלי סימון תקופה מקבלת סימון "עכשיו" ותסוכם במועד הבא (בלי force). הסימון מתקדם גם אם מייל בודד נכשל,
 * כדי שלא יישלחו כפילויות בכל שעה; הכישלון נרשם ביומן הריצה שמוצג בפאנל.
 */
function runLeadDigests(opts) {
  opts = opts || {};
  var force = Boolean(opts.force);
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return { skipped: 'ריצה אחרת של הסיכום עדיין פעילה - נסו שוב בעוד דקה', groups: [], errors: [], sent: 0, leads: 0 };
  var log = { at: new Date().toISOString(), force: force, groups: [], sent: 0, leads: 0, errors: [] };
  try {
    var props = PropertiesService.getScriptProperties();
    var settings = getNotifySettings();
    var now = new Date();
    var reg = getRegistry(true);
    var due = [];
    digestGroups(settings, reg).forEach(function (g) {
      if (!isDigestMode(g.mode)) return;
      var marker = props.getProperty('DIGEST_LAST:' + g.key);
      var lastSent = marker ? new Date(marker) : null;
      if (lastSent && isNaN(lastSent.getTime())) lastSent = null;
      var start;
      if (!lastSent) {
        if (!force) { props.setProperty('DIGEST_LAST:' + g.key, now.toISOString()); return; }
        start = new Date(now.getTime() - (g.mode === 'weekly' ? 7 : 1) * 86400000);
      } else {
        if (!force && lastSent >= lastScheduledTime(g.mode, settings, now)) return; // התקופה הנוכחית כבר סוכמה
        start = lastSent;
      }
      if (start >= now) return;
      due.push({ group: g, start: start });
    });
    if (!due.length) {
      log.note = force ? 'אין קבוצה בתדירות סיכום (ההגדרה הכללית או לקוח) שיש לה מה לשלוח' : 'עוד לא הגיע מועד הסיכום';
      return finishDigestLog(log);
    }
    var routingMap = due.some(function (d) { return d.group.key === 'general'; }) ? loadRoutingMap() : {};
    var earliest = due.reduce(function (m, d) { return d.start < m ? d.start : m; }, now);
    var leads = readLeadsBetween(earliest, now);
    due.forEach(function (d) {
      var g = d.group;
      var entry = { key: g.key, label: g.label, mode: g.mode, from: d.start.toISOString(), leads: 0, recipients: 0, emails: 0, skippedEmpty: 0 };
      try {
        var rows = leads.filter(function (r) { return r._ts >= d.start; });
        entry.leads = rows.length;
        var res = sendGroupDigest(g, groupRecipients(g, reg, routingMap), rows, d.start, now, settings);
        entry.recipients = res.recipients; entry.emails = res.emails; entry.skippedEmpty = res.skippedEmpty;
        if (res.failed.length) { entry.error = res.failed.join(' | ').slice(0, 300); log.errors.push(g.label + ': ' + entry.error); }
        log.sent += res.emails;
        log.leads += rows.length;
      } catch (e) {
        entry.error = String(e).slice(0, 300);
        log.errors.push(g.label + ': ' + entry.error);
      }
      props.setProperty('DIGEST_LAST:' + g.key, now.toISOString());
      log.groups.push(entry);
    });
    return finishDigestLog(log);
  } finally {
    lock.releaseLock();
  }
}

function finishDigestLog(log) {
  log.errors = log.errors.slice(0, 5);
  try { PropertiesService.getScriptProperties().setProperty('DIGEST_LAST_RUN', JSON.stringify(log)); } catch (e) { /* לא קריטי */ }
  return log;
}

/** שולח לכל נמען בקבוצה מייל אחד עם הלידים שלו (נמען שמופיע גם בלקוח וגם בקמפיין מקבל את האיחוד) */
function sendGroupDigest(g, recipients, rows, start, end, settings) {
  var byEmail = {};
  recipients.forEach(function (r) {
    if (!EMAIL_RE.test(r.email)) return;
    var key = r.email.toLowerCase();
    var cur = byEmail[key] || (byEmail[key] = { email: r.email, all: false, filters: [], sheetUrl: '', scopes: [] });
    if (r.filter) cur.filters.push(r.filter); else cur.all = true;
    if (!cur.sheetUrl && r.sheetUrl) cur.sheetUrl = r.sheetUrl;
    if (r.scope && cur.scopes.indexOf(r.scope) === -1) cur.scopes.push(r.scope);
  });
  var out = { recipients: 0, emails: 0, skippedEmpty: 0, failed: [] };
  Object.keys(byEmail).forEach(function (key) {
    var rec = byEmail[key];
    out.recipients++;
    var mine = rec.all ? rows : rows.filter(function (r) { return rec.filters.some(function (f) { return f(r); }); });
    if (!mine.length && !settings.empty) { out.skippedEmpty++; return; }
    var isAgency = g.key === 'general' && rec.all;
    var mail = buildDigestMail({
      mode: g.mode, rows: mine, start: start, end: end, sheetUrl: rec.sheetUrl, isAgency: isAgency,
      scope: isAgency ? '' : (rec.all ? g.label : rec.scopes.join(', '))
    });
    try {
      MailApp.sendEmail({ to: rec.email, subject: mail.subject, htmlBody: mail.html, name: 'Channel 19 לידים' });
      out.emails++;
    } catch (e) { out.failed.push(rec.email + ': ' + e); }
  });
  return out;
}

/** גוף מייל הסיכום: מספרים, פילוח (לסוכנות לפי לקוח וקמפיין, ללקוח לפי קמפיין) וטבלת הלידים מהחדש לישן */
function buildDigestMail(o) {
  var kind = o.mode === 'daily' ? 'יומי' : 'שבועי';
  var period = fmtPeriod(o.start, o.end);
  var n = o.rows.length;
  var title = 'סיכום לידים ' + kind + (o.scope ? ' - ' + o.scope : '');
  var subject = title + ': ' + (n ? n + ' לידים' : 'לא נכנסו לידים') + ' (' + period + ')';
  var newCount = o.rows.filter(function (r) { return String(r['סטטוס']) === 'חדש'; }).length;
  var dupCount = o.rows.filter(function (r) { return String(r['דגלים'] || '').indexOf('כפול') > -1; }).length;

  var breakdown = '';
  if (n) {
    var counts = {};
    o.rows.forEach(function (r) {
      var key = o.isAgency
        ? (r['לקוח'] || 'בלי לקוח') + (r['קמפיין'] ? ' / ' + r['קמפיין'] : (r['כתבה'] ? ' / ' + r['כתבה'] : ''))
        : (r['קמפיין'] || r['כתבה'] || 'כללי');
      counts[key] = (counts[key] || 0) + 1;
    });
    var keys = Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; });
    if (keys.length > 1 || o.isAgency) {
      breakdown = '<h3 style="margin:18px 0 6px;font-size:15px">' + (o.isAgency ? 'לפי לקוח וקמפיין' : 'לפי קמפיין') + '</h3>' +
        '<table cellpadding="6" style="border-collapse:collapse">' +
        keys.map(function (k) {
          return '<tr><td style="border-bottom:1px solid #eee">' + escapeHtml(k) + '</td><td style="border-bottom:1px solid #eee"><b>' + counts[k] + '</b></td></tr>';
        }).join('') + '</table>';
    }
  }

  var cols = o.isAgency
    ? ['תאריך', 'שעה', 'שם מלא', 'טלפון', 'עיר', 'לקוח', 'קמפיין', 'כתבה', 'utm_source', 'סטטוס']
    : ['תאריך', 'שעה', 'שם מלא', 'טלפון', 'דוא"ל', 'עיר', 'קמפיין', 'utm_source', 'סטטוס'];
  var shown = o.rows.slice().reverse().slice(0, DIGEST_MAX_ROWS);
  var th = '<th style="text-align:right;background:#f4f4f4;border-bottom:1px solid #ddd;white-space:nowrap">';
  var td = '<td style="border-bottom:1px solid #eee;white-space:nowrap">';
  var table = '<table cellpadding="5" style="border-collapse:collapse;font-size:13px"><tr>' +
    cols.map(function (c) { return th + escapeHtml(c) + '</th>'; }).join('') + '</tr>' +
    shown.map(function (r) {
      return '<tr>' + cols.map(function (c) {
        var v = String(r[c] == null ? '' : r[c]);
        if (c === 'טלפון') {
          v = v.replace(/^'/, '');
          if (/^0\d{8,9}$/.test(v)) return td + '<a href="tel:' + v + '">' + v + '</a> <a href="https://wa.me/972' + v.slice(1) + '" title="וואטסאפ">💬</a></td>';
        }
        return td + escapeHtml(v) + '</td>';
      }).join('') + '</tr>';
    }).join('') + '</table>' +
    (n > shown.length ? '<p style="color:#666">מוצגים ' + shown.length + ' הלידים האחרונים מתוך ' + n + ' - השאר בגיליון.</p>' : '');

  var html = '<div dir="rtl" style="font-family:Arial,sans-serif;font-size:15px;color:#222">' +
    (o.preview ? '<div style="background:#fff8e6;border:1px solid #f5d982;padding:8px 12px;border-radius:8px;margin-bottom:12px">תצוגה מקדימה - כך נראה הסיכום ה' + kind + ' של הסוכנות. נשלח רק אליכם ולא משנה את מועד הסיכום הבא.</div>' : '') +
    '<h2 style="margin:0 0 4px">' + escapeHtml(title) + '</h2>' +
    '<div style="color:#666;margin-bottom:14px">Channel 19 · ' + period + '</div>' +
    '<p style="font-size:18px;margin:0 0 6px"><b>' + n + '</b> לידים' +
    (n && newCount ? ', מתוכם <b>' + newCount + '</b> עדיין בסטטוס "חדש"' : '') +
    (dupCount ? ' (' + dupCount + ' סומנו כפולים)' : '') + '</p>' +
    (n ? breakdown + '<h3 style="margin:18px 0 6px;font-size:15px">הלידים</h3>' + table : '<p>לא נכנסו לידים בתקופה הזו.</p>') +
    (o.sheetUrl ? '<p style="margin-top:16px"><a href="' + o.sheetUrl + '">📊 לגיליון הלידים</a></p>' : '') +
    (o.isAgency ? '<p style="color:#888;font-size:12px">התדירות של המייל הזה (שבועי / יומי / על כל ליד) נקבעת בפאנל הניהול, מסך "לידים".</p>' : '') +
    '</div>';
  return { subject: subject, html: html };
}

/** הלידים מהטאב הראשי שנרשמו בין start (כולל) ל-end (לא כולל), מהישן לחדש, בלי לידי בדיקה. קורא מהסוף בקטעים - בלי לסרוק היסטוריה */
function readLeadsBetween(start, end) {
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) return [];
  var tz = ss.getSpreadsheetTimeZone() || 'Asia/Jerusalem';
  var headers = ensureHeaders(sheet);
  var dateCol = headers.indexOf('תאריך'), timeCol = headers.indexOf('שעה'), flagCol = headers.indexOf('דגלים');
  if (dateCol === -1) return [];
  var out = [];
  var top = sheet.getLastRow();
  var CHUNK = 400;
  var tolerance = start.getTime() - 86400000; // שורות מסודרות לפי זמן; יממה של סובלנות לשורות שהוזזו ידנית
  var done = false;
  while (top >= 2 && !done) {
    var from = Math.max(2, top - CHUNK + 1);
    var values = sheet.getRange(from, 1, top - from + 1, headers.length).getValues();
    for (var i = values.length - 1; i >= 0; i--) {
      var v = values[i];
      var ts = leadTimestamp(v[dateCol], timeCol > -1 ? v[timeCol] : '', tz);
      if (!ts) continue;
      if (ts.getTime() < tolerance) { done = true; break; }
      if (ts < start || ts >= end) continue;
      if (flagCol > -1 && String(v[flagCol] || '').indexOf('בדיקה') > -1) continue;
      var r = {};
      headers.forEach(function (h, k) { r[h] = v[k]; });
      r['תאריך'] = Utilities.formatDate(ts, 'Asia/Jerusalem', 'dd/MM/yyyy');
      r['שעה'] = Utilities.formatDate(ts, 'Asia/Jerusalem', 'HH:mm');
      r._ts = ts;
      out.push(r);
    }
    top = from - 1;
  }
  return out.reverse();
}

/** חותמת זמן של שורה מעמודות התאריך והשעה (טקסט dd/MM/yyyy ו-HH:mm כפי שנרשמו, או תאריך/שעה שהגיליון המיר) */
function leadTimestamp(dateVal, timeVal, tz) {
  var ds = dateVal instanceof Date ? Utilities.formatDate(dateVal, tz, 'dd/MM/yyyy') : String(dateVal || '').trim();
  var m = ds.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!m) return null;
  var tsStr = timeVal instanceof Date ? Utilities.formatDate(timeVal, tz, 'HH:mm') : String(timeVal || '').trim();
  var t = tsStr.match(/^(\d{1,2}):(\d{2})/);
  var d = new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]), t ? Number(t[1]) : 0, t ? Number(t[2]) : 0, 0, 0);
  return isNaN(d.getTime()) ? null : d;
}

/** מפאנל הניהול: preview - הסיכום של התקופה האחרונה למייל של המשתמש המחובר בלבד (בלי לשנות סימונים);
 *  אחרת - שליחה עכשיו לכל הנמענים של מה שהצטבר מאז הסיכום הקודם (התקופה הבאה מתחילה מעכשיו) */
function sendDigestNow(req, props, user) {
  if (req && req.preview) {
    if (!user || !EMAIL_RE.test(String(user.email || ''))) return jsonResponse({ success: false, message: 'אין כתובת מייל למשתמש המחובר' });
    var s = getNotifySettings();
    var mode = isDigestMode(s.mode) ? s.mode : 'weekly';
    var end = new Date();
    var start = new Date(end.getTime() - (mode === 'weekly' ? 7 : 1) * 86400000);
    var rows = readLeadsBetween(start, end);
    var mail = buildDigestMail({ mode: mode, rows: rows, start: start, end: end, scope: '', sheetUrl: SHEET_URL, isAgency: true, preview: true });
    MailApp.sendEmail({ to: user.email, subject: '[תצוגה מקדימה] ' + mail.subject, htmlBody: mail.html, name: 'Channel 19 לידים' });
    return jsonResponse({ success: true, message: 'תצוגה מקדימה של הסיכום (' + rows.length + ' לידים מ-' + fmtDT(start) + ') נשלחה ל-' + user.email });
  }
  var log = runLeadDigests({ force: true });
  if (log.skipped) return jsonResponse({ success: false, message: log.skipped });
  var parts = log.groups.map(function (g) {
    return g.label + ': ' + g.leads + ' לידים ל-' + g.emails + ' מיילים' + (g.skippedEmpty ? ' (' + g.skippedEmpty + ' נמענים בלי לידים דולגו)' : '') + (g.error ? ' - שגיאה: ' + g.error : '');
  });
  var msg = log.groups.length ? 'הסיכום נשלח. ' + parts.join(' | ') : (log.note || 'לא נשלח סיכום');
  return jsonResponse({ success: !log.errors.length, message: msg, log: log });
}

/** מתקין פעם אחת את הטריגר השעתי של הסיכומים (ומסיר כפילויות). דורש הרשאת script.scriptapp - אחרת מחזיר הנחיה */
function installDigestTrigger() {
  try {
    var existing = ScriptApp.getProjectTriggers().filter(function (t) { return t.getHandlerFunction() === DIGEST_TRIGGER_FN; });
    if (existing.length) {
      for (var i = 1; i < existing.length; i++) ScriptApp.deleteTrigger(existing[i]);
      return { ok: true, installed: true, message: 'הטריגר השעתי לסיכומי הלידים מותקן' };
    }
    ScriptApp.newTrigger(DIGEST_TRIGGER_FN).timeBased().everyHours(1).create();
    return { ok: true, installed: true, message: 'הטריגר השעתי לסיכומי הלידים הותקן' };
  } catch (e) {
    return {
      ok: false, installed: false,
      message: 'הסיכומים האוטומטיים עוד לא פעילים: לסקריפט חסרה הרשאת טריגרים. בעל הסקריפט פותח את העורך, מריץ פעם אחת את authorizeServices ומאשר את כל ההרשאות (' + e + ')'
    };
  }
}

function digestTriggerStatus() {
  try {
    var has = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === DIGEST_TRIGGER_FN; });
    return { ok: true, installed: has, message: has ? 'הטריגר השעתי לסיכומים מותקן' : 'הטריגר לסיכומים עוד לא הותקן - שמירת ההגדרות במסך "לידים" תתקין אותו' };
  } catch (e) {
    return { ok: false, installed: false, message: 'חסרה הרשאת טריגרים (script.scriptapp) - יש להריץ authorizeServices בעורך' };
  }
}

/** מצב הסיכומים לפאנל: הטריגר, תיאור התדירות, המועד הבא והריצה האחרונה */
function digestStatus(s) {
  var props = PropertiesService.getScriptProperties();
  var lastRun = null;
  try { lastRun = JSON.parse(props.getProperty('DIGEST_LAST_RUN') || 'null'); } catch (e) { lastRun = null; }
  var out = { trigger: digestTriggerStatus(), schedule: describeSchedule(s), lastSent: props.getProperty('DIGEST_LAST:general') || '', lastRun: lastRun, next: '', nextLabel: '' };
  if (isDigestMode(s.mode)) {
    var now = new Date();
    var marker = out.lastSent ? new Date(out.lastSent) : null;
    if (marker && !isNaN(marker.getTime()) && marker < lastScheduledTime(s.mode, s, now)) {
      out.next = now.toISOString();
      out.nextLabel = 'בשעה הקרובה (המועד עבר - יישלח בריצה הבאה של הטריגר השעתי)';
    } else {
      var next = nextScheduledTime(s.mode, s, now);
      out.next = next.toISOString();
      out.nextLabel = 'יום ' + DAY_NAMES[next.getDay()] + ' ' + Utilities.formatDate(next, 'Asia/Jerusalem', 'dd/MM') + ' בסביבות ' + pad2(s.hour) + ':00';
    }
    if (!out.trigger.installed) out.nextLabel += ' - בתנאי שהטריגר השעתי מותקן';
  }
  return out;
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
  var s = getNotifySettings();
  return jsonResponse({
    success: true,
    notifyEmail: props.getProperty('NOTIFY_EMAIL') || '',
    notifyMode: s.mode, notifyDay: s.day, notifyHour: s.hour, notifyEmpty: s.empty,
    modeLabels: NOTIFY_MODE_LABELS,
    forwardWebhooks: getForwardUrls().join('\n'),
    sheetUrl: SHEET_URL,
    scriptUrl: SCRIPT_EDIT_URL,
    tabs: listTabs(),
    digest: digestStatus(s)
  });
}

/** שמירת ההגדרות הכלליות: מיילי הסוכנות, מתי הם נשלחים (תדירות + יום + שעה), webhooks. מתקין את הטריגר השעתי אם צריך */
function saveLeadSettings(req, props) {
  var emails = splitList(req.notifyEmail);
  var badEmail = validateEmails(emails);
  if (badEmail) return jsonResponse({ success: false, message: badEmail });
  var urls = String(req.forwardWebhooks || '').split(/[\s,]+/).filter(Boolean);
  for (var i = 0; i < urls.length; i++) {
    if (!/^https:\/\/\S+$/.test(urls[i])) {
      return jsonResponse({ success: false, message: 'כתובת webhook לא תקינה (חייבת להתחיל ב-https://): ' + urls[i] });
    }
  }
  var prev = getNotifySettings();
  var mode = Object.prototype.hasOwnProperty.call(req, 'notifyMode') ? normalizeMode(req.notifyMode) : prev.mode;
  if (!mode) return jsonResponse({ success: false, message: 'תדירות לא מוכרת: ' + req.notifyMode });
  var day = parseInt(req.notifyDay, 10);
  var hour = parseInt(req.notifyHour, 10);
  props.setProperty('NOTIFY_EMAIL', emails.join(', '));
  props.setProperty('FORWARD_WEBHOOKS', urls.join('\n'));
  props.setProperty('NOTIFY_MODE', mode);
  props.setProperty('NOTIFY_DAY', String(isNaN(day) || day < 0 || day > 6 ? prev.day : day));
  props.setProperty('NOTIFY_HOUR', String(isNaN(hour) || hour < 0 || hour > 23 ? prev.hour : hour));
  if (Object.prototype.hasOwnProperty.call(req, 'notifyEmpty')) props.setProperty('NOTIFY_EMPTY', req.notifyEmpty && req.notifyEmpty !== '0' ? '1' : '0');
  noteModeChange('general', prev.mode, mode);

  var s = getNotifySettings();
  var out = { success: true, message: 'הגדרות הלידים נשמרו. ' + describeSchedule(s) + '.' };
  /* הטריגר השעתי נדרש כשההגדרה הכללית או לקוח כלשהו בתדירות סיכום */
  var reg = getRegistry(false);
  var needsTrigger = isDigestMode(mode) || Object.keys(reg.clients).some(function (id) { return isDigestMode(reg.clients[id].notifyMode || mode); });
  if (needsTrigger) {
    var trig = installDigestTrigger();
    if (!trig.ok) out.warning = trig.message;
  }
  out.digest = digestStatus(s);
  return jsonResponse(out);
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

/* ---------- ניקוי שאריות בדיקה - להרצה ידנית מהעורך בלבד (לא חשוף ב-doPost) ---------- */
function cleanupTestArtifacts() {
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var log = [];

  /* 1. טאבים ישנים (ניתוב לפי כתבה, בדיקות, טאב ברירת מחדל) - נמחקים רק אם ריקים */
  ['בדיקת-שדות', 'a-20260806-1534', 'a-20260908-1537', 'גיליון1', 'Sheet1'].forEach(function (name) {
    var sh = ss.getSheetByName(name);
    if (!sh) return;
    if (sh.getLastRow() <= 1) { ss.deleteSheet(sh); log.push('נמחק טאב ריק: ' + name); }
    else log.push('נשאר (יש בו ' + (sh.getLastRow() - 1) + ' שורות): ' + name);
  });

  /* 2. לקוחות וקמפיינים שנוצרו בבדיקות (על ידי סיסמת הגיבוי): מחיקת הרישום והעברת הקובץ לאשפה (ניתן לשחזור 30 יום) */
  var reg = getRegistry(true);
  var clientsSh = registrySheet(ss, CLIENTS_TAB, CLIENT_HEADERS);
  var campsSh = registrySheet(ss, CAMPAIGNS_TAB, CAMPAIGN_HEADERS);
  Object.keys(reg.clients).forEach(function (id) {
    var c = reg.clients[id];
    if (c.createdBy !== 'סיסמת גיבוי') return;
    var campRows = readRegistryRows(campsSh, CAMPAIGN_HEADERS);
    for (var i = campRows.length - 1; i >= 0; i--) {
      if (campRows[i]['מזהה לקוח'] === id) { campsSh.deleteRow(i + 2); log.push('נמחק קמפיין: ' + campRows[i]['שם']); }
    }
    try {
      var css = SpreadsheetApp.openById(c.sheetId);
      var hasData = css.getSheets().some(function (sh) { return sh.getLastRow() > 1; });
      if (!hasData) { DriveApp.getFileById(c.sheetId).setTrashed(true); log.push('הקובץ "' + css.getName() + '" הועבר לאשפה'); }
      else log.push('הקובץ של ' + c.name + ' נשאר - יש בו נתונים');
    } catch (e) { log.push('הקובץ של ' + c.name + ': ' + e); }
    var clientRows = readRegistryRows(clientsSh, CLIENT_HEADERS);
    for (var j = clientRows.length - 1; j >= 0; j--) {
      if (clientRows[j]['מזהה'] === id) { clientsSh.deleteRow(j + 2); log.push('נמחק לקוח: ' + c.name); }
    }
  });

  /* 3. קבצי לקוח שנותרו מבדיקה קודמת (הרישום שלהם כבר נמחק) - לאשפה אם ריקים */
  ['13Q9UWH9z3v51ENGoY2bnGzDC3rBh8wpxbTdNKSW0V8o'].forEach(function (fileId) {
    try {
      var f = DriveApp.getFileById(fileId);
      if (f.isTrashed()) { log.push('כבר באשפה: ' + f.getName()); return; }
      var s2 = SpreadsheetApp.openById(fileId);
      var hasData2 = s2.getSheets().some(function (sh) { return sh.getLastRow() > 1; });
      if (!hasData2) { f.setTrashed(true); log.push('הקובץ "' + f.getName() + '" הועבר לאשפה'); }
      else log.push('הקובץ ' + f.getName() + ' נשאר - יש בו נתונים');
    } catch (e) { log.push('קובץ ' + fileId + ': ' + e); }
  });

  clearRegistryCache();
  clearRoutingCache();
  Logger.log(log.length ? log.join('\n') : 'לא נמצאו שאריות בדיקה');
}

/* ---------- עזרים ---------- */
function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
