/**
 * fetch-rss.mjs - משיכת פידים של RSS מאתרי חדשות וניסוח הכתבות מחדש
 *
 * - מושך את הפידים המוגדרים ב-data/site.json
 * - מנסח מחדש כותרת + תקציר + גוף באמצעות Gemini (GEMINI_API_KEY)
 *   או Claude (ANTHROPIC_API_KEY) - לפי המפתח שמוגדר
 * - בלי מפתח API: הכתבה נשמרת עם הניסוח המקורי + קרדיט למקור
 * - כתבות שכבר נוסחו נשמרות במטמון (data/rss-articles.json) ולא מנוסחות שוב
 *
 * הרצה: node scripts/fetch-rss.mjs
 * מפתחות נטענים גם מקובץ .env מקומי (לא עולה לגיט)
 * משתני סביבה: GEMINI_API_KEY / ANTHROPIC_API_KEY, REWRITE_MODEL (אופציונלי)
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

/* טעינת .env מקומי (אם קיים) - שורות בפורמט KEY=VALUE */
const envPath = join(ROOT_DIR, '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const site = JSON.parse(readFileSync(join(ROOT_DIR, 'data/site.json'), 'utf8'));

const GEMINI_KEY = process.env.GEMINI_API_KEY || '';
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';
const PROVIDER = GEMINI_KEY ? 'gemini' : ANTHROPIC_KEY ? 'claude' : '';
const MODEL = process.env.REWRITE_MODEL || (PROVIDER === 'gemini' ? 'gemini-flash-latest' : 'claude-opus-5');
const UA = 'Mozilla/5.0 (compatible; Magazine42Bot/1.0)';

/* ---------- עזרי טקסט ---------- */
function decodeEntities(s = '') {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&nbsp;', ' ')
    .replaceAll('&amp;', '&');
}

const unwrapCdata = (s = '') => {
  const m = s.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
  return m ? m[1] : s;
};

const stripTags = (s = '') => s.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

function tagContent(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
  return m ? unwrapCdata(m[1].trim()).trim() : '';
}

/* ---------- פרסינג RSS ---------- */
function parseRss(xml) {
  const items = [];
  const re = /<item[\s>][\s\S]*?<\/item>/gi;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const raw = m[0];
    const title = stripTags(decodeEntities(tagContent(raw, 'title')));
    const link = stripTags(decodeEntities(tagContent(raw, 'link')));
    const descRaw = decodeEntities(tagContent(raw, 'description'));
    const pubDate = tagContent(raw, 'pubDate');

    // תמונה: media:content / enclosure / img בתוך התיאור
    let image = '';
    const media = raw.match(/<(?:media:content|media:thumbnail|enclosure)[^>]*url=["']([^"']+)["']/i);
    if (media) image = decodeEntities(media[1]);
    if (!image) {
      const img = descRaw.match(/<img[^>]*src=["']([^"']+)["']/i);
      if (img) image = img[1];
    }
    if (image && !/^https?:\/\//.test(image)) image = '';

    const summary = stripTags(descRaw).slice(0, 500);
    if (!title || !link) continue;

    const d = new Date(pubDate);
    items.push({
      title,
      link,
      summary,
      image,
      date: isNaN(d) ? new Date().toISOString() : d.toISOString(),
    });
  }
  return items;
}

async function fetchFeed(feed) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(feed.url, {
      headers: { 'User-Agent': UA, Accept: 'application/rss+xml, application/xml, text/xml, */*' },
      signal: ctrl.signal,
      redirect: 'follow',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xml = await res.text();
    const items = parseRss(xml).slice(0, site.rssPerFeed || 8);
    console.log(`✓ ${feed.name}: ${items.length} כתבות`);
    return items.map((it) => ({
      ...it,
      sourceName: feed.name.split(' ')[0],
      category: feed.category,
    }));
  } catch (err) {
    console.warn(`✗ ${feed.name}: ${err.message}`);
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/* ---------- ניסוח מחדש עם Claude ---------- */
const REWRITE_SCHEMA = {
  type: 'object',
  properties: {
    articles: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          subtitle: { type: 'string' },
          body: { type: 'string' },
        },
        required: ['id', 'title', 'subtitle', 'body'],
        additionalProperties: false,
      },
    },
  },
  required: ['articles'],
  additionalProperties: false,
};

const SYSTEM_PROMPT = `אתה עורך חדשות ותיק במגזין דיגיטלי ישראלי. תפקידך לנסח מחדש ידיעות חדשותיות.

כללים מחייבים:
- הסתמך אך ורק על המידע שסופק (כותרת ותקציר). אסור להמציא עובדות, מספרים, שמות או ציטוטים שלא הופיעו במקור.
- כתוב בעברית תקנית, רהוטה וזורמת.
- הכותרת החדשה: מסקרנת ומזמינת קליק אך מדויקת עובדתית, שונה בניסוחה מהמקור. בלי קליקבייט שקרי.
- כותרת המשנה: משפט אחד או שניים שמרחיבים את הכותרת.
- הגוף: 2-3 פסקאות קצרות (מופרדות בשורה ריקה) שמספרות את הידיעה במילים שלך, על בסיס המידע הקיים בלבד. אם המידע דל - כתוב פסקה אחת בלבד ואל תמתח אותו.
- אל תזכיר את שם אתר המקור בגוף הטקסט.
- החזר עבור כל פריט את אותו id שקיבלת, ללא שינוי.`;

const userPrompt = (items) =>
  'נסח מחדש את הידיעות הבאות. עבור כל ידיעה החזר: id (ללא שינוי), title, subtitle, body.\n\n' +
  JSON.stringify(items.map((it) => ({ id: it.id, title: it.title, summary: it.summary })), null, 1);

async function postJson(url, headers, payload) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 180000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(`API ${res.status}: ${data?.error?.message || JSON.stringify(data).slice(0, 200)}`);
    return data;
  } finally {
    clearTimeout(timer);
  }
}

/* סכימת JSON בפורמט של Gemini (טיפוסים באותיות גדולות) */
const GEMINI_SCHEMA = {
  type: 'OBJECT',
  properties: {
    articles: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          id: { type: 'STRING' },
          title: { type: 'STRING' },
          subtitle: { type: 'STRING' },
          body: { type: 'STRING' },
        },
        required: ['id', 'title', 'subtitle', 'body'],
      },
    },
  },
  required: ['articles'],
};

async function rewriteBatchGemini(items) {
  const data = await postJson(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
    { 'x-goog-api-key': GEMINI_KEY },
    {
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [{ role: 'user', parts: [{ text: userPrompt(items) }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: GEMINI_SCHEMA,
        maxOutputTokens: 16384,
      },
    },
  );
  if (data.promptFeedback?.blockReason) throw new Error(`נחסם: ${data.promptFeedback.blockReason}`);
  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
  const parsed = JSON.parse(text);
  return new Map((parsed.articles || []).map((a) => [a.id, a]));
}

async function rewriteBatchClaude(items) {
  const data = await postJson(
    'https://api.anthropic.com/v1/messages',
    { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
    {
      model: MODEL,
      max_tokens: 8000,
      output_config: {
        effort: 'low',
        format: { type: 'json_schema', schema: REWRITE_SCHEMA },
      },
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt(items) }],
    },
  );
  if (data.stop_reason === 'refusal') throw new Error('הבקשה נדחתה על ידי המודל');
  const text = (data.content || []).find((b) => b.type === 'text')?.text || '';
  const parsed = JSON.parse(text);
  return new Map((parsed.articles || []).map((a) => [a.id, a]));
}

const rewriteBatch = PROVIDER === 'gemini' ? rewriteBatchGemini : rewriteBatchClaude;

/* ---------- ריצה ראשית ---------- */
const hash = (s) => createHash('sha1').update(s).digest('hex').slice(0, 12);

async function main() {
  // 1. משיכת כל הפידים במקביל
  const results = await Promise.all(site.feeds.map(fetchFeed));
  const fetched = results.flat();

  // מניעת כפילויות לפי קישור
  const byId = new Map();
  for (const it of fetched) {
    const id = 'r-' + hash(it.link);
    if (!byId.has(id)) byId.set(id, { ...it, id });
  }

  // 2. טעינת המטמון הקיים - כתבות שכבר נוסחו לא מנוסחות שוב
  const cachePath = join(ROOT_DIR, 'data/rss-articles.json');
  const cache = existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, 'utf8')) : [];
  const cacheMap = new Map(cache.map((a) => [a.id, a]));

  const newItems = [...byId.values()].filter((it) => !cacheMap.has(it.id));
  console.log(`\nסה"כ ${byId.size} כתבות בפידים, מתוכן ${newItems.length} חדשות`);

  // 3. ניסוח מחדש של הכתבות החדשות
  const rewrites = new Map();
  if (PROVIDER && newItems.length) {
    console.log(`מנסח מחדש באמצעות ${MODEL} (${PROVIDER})...`);
    const BATCH = 6;
    for (let i = 0; i < newItems.length; i += BATCH) {
      const batch = newItems.slice(i, i + BATCH);
      try {
        const map = await rewriteBatch(batch);
        map.forEach((v, k) => rewrites.set(k, v));
        console.log(`  ✓ נוסחו ${map.size}/${batch.length} (קבוצה ${Math.floor(i / BATCH) + 1})`);
      } catch (err) {
        console.warn(`  ✗ קבוצה ${Math.floor(i / BATCH) + 1} נכשלה: ${err.message}`);
      }
    }
  } else if (!PROVIDER) {
    console.log('אין GEMINI_API_KEY / ANTHROPIC_API_KEY - הכתבות יישמרו בניסוח המקורי.');
  }

  // 4. בניית רשומות הכתבות
  const newArticles = newItems.map((it) => {
    const rw = rewrites.get(it.id);
    return {
      id: it.id,
      title: rw?.title || it.title,
      subtitle: rw?.subtitle || (it.summary ? it.summary.slice(0, 160) : ''),
      category: it.category,
      image: it.image || '',
      author: 'מערכת 42',
      date: it.date,
      body: rw?.body || (it.summary || it.title),
      source: { name: it.sourceName, url: it.link },
      rewritten: Boolean(rw),
      lead: null,
    };
  });

  // 5. איחוד: כתבות מהמטמון שעדיין בפיד + חדשות, ממוין מהחדש לישן
  const merged = [
    ...newArticles,
    ...cache.filter((a) => byId.has(a.id)),
  ]
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .slice(0, site.maxRssArticles || 36);

  writeFileSync(cachePath, JSON.stringify(merged, null, 2));
  console.log(`\nנשמרו ${merged.length} כתבות RSS (${merged.filter((a) => a.rewritten).length} מנוסחות מחדש).`);
}

main().catch((err) => {
  console.error('שגיאה:', err);
  process.exit(1);
});
