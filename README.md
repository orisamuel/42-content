# מגזין 42 - אתר תוכן

אתר תוכן סטטי בעברית (RTL) המתארח בחינם ב-GitHub Pages, עם עדכון אוטומטי מפידי RSS, ניסוח כתבות מחדש באמצעות Claude API, וטפסי איסוף לידים לגוגל שיטס.

**כתובת האתר:** https://orisamuel.github.io/42-content/

## איך זה עובד

```
פידי RSS (ynet, וואלה, מעריב...)
        │  כל 3 שעות (GitHub Actions)
        ▼
scripts/fetch-rss.mjs  ──►  ניסוח מחדש עם Claude  ──►  data/rss-articles.json
                                                              │
data/articles.json  (כתבות ידניות + לידים)  ──────────────────┤
                                                              ▼
                                            scripts/build.mjs  ──►  דפי HTML
                                                              │
                                                              ▼
                                                        GitHub Pages
```

## יצירת כתבה חדשה

**הדרך הקלה - עמוד הניהול:**

1. גלשו אל `https://orisamuel.github.io/42-content/admin/` מכל מחשב והקלידו את סיסמת הניהול
2. כתבו נושא ולחצו "✨ כתוב לי את הכתבה" - Gemini ימלא כותרת, כותרת משנה וגוף. אפשר כמובן גם לכתוב ידנית.
3. תמונה ראשית: "🎨 צור תמונה עם AI" (לפי הכותרת) / "📁 העלאה מהמחשב" / הדבקת קישור
4. ערכו במידת הצורך, הוסיפו טופס לידים בקליק אם רוצים, ולחצו "פרסום" - תקבלו קישור ישיר לכתבה
5. תוך 1-2 דקות הכתבה באוויר

**עריכת כתבה קיימת:** בפאנל הניהול - "טעינת רשימת הכתבות" ← בחירה ← "פתח לעריכה" ← "שמירת השינויים".

**תמונות וזכויות יוצרים:** כל כתבת RSS מקבלת אוטומטית תמונה שנוצרת עם Gemini (בלי תמונות מאתרי החדשות). אם היצירה נכשלת יש תמונת ברירת מחדל לכל קטגוריה (`assets/img/cat-*.jpg`). האתר מוגבל ל-`maxTotalArticles` כתבות (ברירת מחדל 20) - ה-RSS משלים את מה שהכתבות הידניות לא תופסות.

יצירת טוקן: GitHub → Settings → Developer settings → Fine-grained personal access tokens → Generate new token → בחרו את הריפו `42-content` → הרשאת **Contents: Read and write**.

**דרך חלופית:** עריכה ישירה של `data/articles.json` בגיטהאב (עמוד הניהול יודע גם להעתיק JSON מוכן ללוח).

## ניסוח מחדש (Gemini)

הניסוח מתבצע עם Gemini. המפתח מוגדר בשני מקומות:

- **בריפו (ל-GitHub Actions):** secret בשם `GEMINI_API_KEY`
- **מקומית (להרצות ידניות):** קובץ `.env` בתיקיית הפרויקט (לא עולה לגיט) עם השורה `GEMINI_API_KEY=...`

נתמך גם מפתח Claude (`ANTHROPIC_API_KEY`) - אם מוגדרים שניהם, Gemini קודם.

אופציונלי: להחלפת המודל, הוסיפו Repository Variable בשם `REWRITE_MODEL` (ברירת מחדל: `gemini-flash-latest`).

## חיבור טפסי הלידים לגוגל שיטס (חד-פעמי)

1. צרו גיליון Google Sheets חדש
2. Extensions → Apps Script → הדביקו את התוכן של `apps-script/leads.gs`
3. עדכנו בקוד את `SHEET_ID` (המחרוזת מכתובת הגיליון)
4. Deploy → New deployment → Web app → Execute as: **Me**, Who has access: **Anyone**
5. העתיקו את כתובת ה-Web app אל השדה `leadWebhook` בקובץ `data/site.json`

כל ליד נרשם בגיליון עם תאריך, פרטי הפונה, שם הכתבה, הקמפיין ופרמטרי UTM (לזיהוי מקור הקמפיין בטאבולה/אאוטבריין).

⚠️ אחרי כל שינוי בקוד ה-Apps Script חובה לבצע Deploy → Manage deployments → Edit → **New version** → Deploy.

## ניהול פידי ה-RSS

עריכת הרשימה בקובץ `data/site.json` תחת `feeds` - לכל פיד: שם, כתובת ה-RSS וקטגוריה. אפשר גם לכוון:

- `rssPerFeed` - כמה כתבות למשוך מכל פיד (ברירת מחדל 8)
- `maxRssArticles` - כמה כתבות RSS לשמור באתר בסך הכול (ברירת מחדל 36)

## פרסום (Taboola / Outbrain)

בכל עמוד כתבה יש אזור פרסום מוכן (`div#taboola-below-article-thumbnails`). כשתקבלו קוד widget מטאבולה - הדביקו אותו בתבנית `templates/layout.html` או בקובץ `scripts/build.mjs` (חפשו "אזור פרסום").

לקמפיינים: קשרו לכתובת כתבה עם פרמטרי UTM, למשל:
`https://orisamuel.github.io/42-content/articles/tax-refund-check-2026.html?utm_source=taboola&utm_campaign=tax1`

הפרמטרים נשמרים ומצורפים אוטומטית לכל ליד שנשלח.

## מבנה הפרויקט

| נתיב | תפקיד |
|---|---|
| `data/site.json` | הגדרות האתר: שם, קטגוריות, פידים, webhook לידים |
| `data/articles.json` | כתבות ידניות (כולל הגדרות טופס לידים) |
| `data/rss-articles.json` | כתבות RSS מנוסחות (נוצר אוטומטית - לא לערוך) |
| `templates/layout.html` | תבנית העמוד (header/footer) |
| `assets/` | עיצוב, סקריפטים, אייקונים |
| `content/pages/` | תוכן העמודים הסטטיים (אודות, פרטיות...) |
| `scripts/build.mjs` | מחולל הדפים |
| `scripts/fetch-rss.mjs` | משיכת RSS + ניסוח מחדש |
| `admin/` | עמוד ניהול ליצירת כתבות |
| `apps-script/leads.gs` | קוד צד-שרת ללידים (מודבק בגוגל) |

## הרצה מקומית

```bash
node scripts/fetch-rss.mjs   # משיכת תוכן טרי (אופציונלי)
node scripts/build.mjs       # בניית הדפים
```

ואז פתחו את `index.html` בדפדפן.
