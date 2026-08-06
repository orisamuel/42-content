/**
 * מגזין 42 - קליטת לידים לגוגל שיטס
 * ===================================
 * התקנה (חד-פעמית):
 * 1. צרו גיליון Google Sheets חדש והעתיקו את ה-ID שלו
 *    (המחרוזת הארוכה בכתובת, בין /d/ לבין /edit)
 * 2. בגיליון: Extensions -> Apps Script, הדביקו את הקובץ הזה
 * 3. עדכנו את SHEET_ID למטה
 * 4. Deploy -> New deployment -> Web app:
 *      Execute as: Me | Who has access: Anyone
 * 5. העתיקו את כתובת ה-Web app שקיבלתם והדביקו אותה
 *    בשדה "leadWebhook" בקובץ data/site.json באתר
 *
 * חשוב: אחרי כל שינוי בקוד יש לבצע Deploy -> Manage deployments ->
 * Edit -> New version -> Deploy (עריכה בלבד לא מעדכנת את הכתובת החיה!)
 */

var SHEET_ID = 'PASTE_YOUR_SHEET_ID_HERE';
var SHEET_NAME = 'לידים';

var HEADERS = [
  'תאריך', 'שעה', 'שם מלא', 'טלפון', 'דוא"ל', 'עיר',
  'כתבה', 'קמפיין', 'עמוד',
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'
];

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
    "'" + (p.phone || ''), // גרש שומר על אפס מוביל בטלפון
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
function getSpreadsheet() {
  return SpreadsheetApp.openById(SHEET_ID);
}

function ensureSheet(name, headers) {
  var ss = getSpreadsheet();
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
