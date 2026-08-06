/**
 * build.mjs - מחולל האתר הסטטי של מגזין 42
 * קורא את data/*.json ומייצר: index.html, articles/*.html, category/*.html,
 * pages/*.html, sitemap.xml
 * הרצה: node scripts/build.mjs
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const readJSON = (p) => JSON.parse(readFileSync(join(ROOT_DIR, p), 'utf8'));

const site = readJSON('data/site.json');
const manualArticles = readJSON('data/articles.json');
const rssArticles = existsSync(join(ROOT_DIR, 'data/rss-articles.json'))
  ? readJSON('data/rss-articles.json')
  : [];

const layout = readFileSync(join(ROOT_DIR, 'templates/layout.html'), 'utf8');

/* ---------- עזרים ---------- */
const esc = (s = '') =>
  String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

const escAttr = esc;

const dateFmt = new Intl.DateTimeFormat('he-IL', {
  day: 'numeric', month: 'long', year: 'numeric',
  hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jerusalem',
});
const fmtDate = (iso) => {
  const d = new Date(iso);
  return isNaN(d) ? '' : dateFmt.format(d);
};

/** המרת מרקדאון מצומצם ל-HTML (כותרות, מודגש, קישורים, רשימות, ציטוטים, תמונות) */
function mdToHtml(md = '') {
  if (/^\s*</.test(md)) return md; // גוף שכבר נכתב כ-HTML עובר כמו שהוא

  const inline = (t) =>
    esc(t)
      .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
      .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g,
        '<a href="$2" target="_blank" rel="noopener nofollow">$1</a>');

  return md
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/)
    .map((block) => {
      const b = block.trim();
      if (!b) return '';
      if (b.startsWith('### ')) return `<h3>${inline(b.slice(4))}</h3>`;
      if (b.startsWith('## ')) return `<h2>${inline(b.slice(3))}</h2>`;
      if (b.startsWith('> ')) return `<blockquote>${inline(b.slice(2))}</blockquote>`;
      const img = b.match(/^!\[([^\]]*)\]\((https?:[^)\s]+)\)$/);
      if (img) return `<img src="${escAttr(img[2])}" alt="${escAttr(img[1])}" loading="lazy">`;
      if (b.split('\n').every((l) => l.trim().startsWith('- '))) {
        const items = b.split('\n').map((l) => `<li>${inline(l.trim().slice(2))}</li>`).join('');
        return `<ul>${items}</ul>`;
      }
      return `<p>${inline(b).replace(/\n/g, '<br>')}</p>`;
    })
    .filter(Boolean)
    .join('\n');
}

const catSlug = (name) => (site.categories.find((c) => c.name === name) || {}).slug || 'news';
const articleUrl = (a) => `articles/${a.id}.html`;

/* ---------- איחוד ומיון כתבות ---------- */
const seen = new Set();
const all = [...manualArticles, ...rssArticles]
  .filter((a) => a && a.id && a.title && !seen.has(a.id) && seen.add(a.id))
  .sort((a, b) => new Date(b.date) - new Date(a.date));

if (!all.length) {
  console.error('אין כתבות - בדקו את data/articles.json');
  process.exit(1);
}

const imgOf = (a) => a.image || `${site.baseUrl}/assets/img/cat-${catSlug(a.category)}.jpg`;

/* ---------- רכיבי HTML ---------- */
const navHtml = (root, activeCat = '') =>
  site.categories
    .map((c) =>
      `<a href="${root}category/${c.slug}.html"${c.name === activeCat ? ' class="active"' : ''}>${esc(c.name)}</a>`)
    .join('\n      ');

function renderPage({ title, description, content, root, headExtra = '', activeCat = '' }) {
  // החלפה באמצעות פונקציה כדי שתווי $ בתוכן לא יתפרשו כתבנית החלפה
  const fill = (tpl, key, val) => tpl.replaceAll(key, () => val);
  let html = layout;
  html = fill(html, '{{TITLE}}', esc(title));
  html = fill(html, '{{DESCRIPTION}}', escAttr(description || site.description));
  html = fill(html, '{{HEAD_EXTRA}}', headExtra);
  html = fill(html, '{{NAV}}', navHtml(root, activeCat));
  html = fill(html, '{{CONTENT}}', content);
  html = fill(html, '{{ROOT}}', root);
  html = fill(html, '{{TAGLINE}}', esc(site.tagline));
  html = fill(html, '{{YEAR}}', String(new Date().getFullYear()));
  html = fill(html, '{{LEAD_WEBHOOK}}', escAttr(site.leadWebhook || ''));
  return html;
}

const chip = (a) => `<span class="chip" data-cat="${escAttr(a.category)}">${esc(a.category)}</span>`;

const heroCard = (a, root) => `
<a class="card card-hero" href="${root}${articleUrl(a)}">
  <div class="card-img"><img src="${escAttr(imgOf(a))}" alt="${escAttr(a.title)}" fetchpriority="high"></div>
  <div class="card-body">
    ${chip(a)}
    <h2>${esc(a.title)}</h2>
    <p>${esc(a.subtitle || '')}</p>
  </div>
</a>`;

const sideCard = (a, root) => `
<a class="card card-side" href="${root}${articleUrl(a)}">
  <div class="card-img"><img src="${escAttr(imgOf(a))}" alt="${escAttr(a.title)}" loading="lazy"></div>
  <div class="card-body">
    ${chip(a)}
    <h3>${esc(a.title)}</h3>
  </div>
</a>`;

const gridCard = (a, root) => `
<a class="card card-grid" href="${root}${articleUrl(a)}">
  <div class="card-img"><img src="${escAttr(imgOf(a))}" alt="${escAttr(a.title)}" loading="lazy"></div>
  <div class="card-body">
    ${chip(a)}
    <h3>${esc(a.title)}</h3>
    <p>${esc(a.subtitle || '')}</p>
    <div class="card-meta"><span>${fmtDate(a.date)}</span></div>
  </div>
</a>`;

function leadFormHtml(a) {
  const lead = a.lead;
  if (!lead || !lead.enabled) return '';
  const fields = (lead.fields || [])
    .map((f) =>
      `<input type="${escAttr(f.type || 'text')}" name="${escAttr(f.name)}" placeholder="${escAttr(f.label)}"${f.required ? ' required' : ''} autocomplete="on">`)
    .join('\n      ');
  return `
<section class="lead-box" id="lead">
  <h3>${esc(lead.title || 'השאירו פרטים')}</h3>
  <p class="lead-sub">${esc(lead.subtitle || '')}</p>
  <form class="lead-form" data-article="${escAttr(a.id)}" data-campaign="${escAttr(lead.campaign || a.id)}">
    ${fields}
    <button type="submit">${esc(lead.buttonText || 'שליחה')}</button>
    <p class="lead-privacy">בלחיצה על הכפתור אני מאשר/ת קבלת פנייה בהתאם ל<a href="../pages/privacy.html">מדיניות הפרטיות</a></p>
  </form>
  <div class="lead-success">${esc(lead.successMessage || 'תודה! הפרטים התקבלו.')}</div>
  <div class="lead-error"></div>
</section>`;
}

const shareRow = `
<div class="share-row">
  <span>שיתוף:</span>
  <a href="#" class="share-btn" data-share="whatsapp" aria-label="שיתוף בוואטסאפ">💬</a>
  <a href="#" class="share-btn" data-share="facebook" aria-label="שיתוף בפייסבוק">f</a>
  <a href="#" class="share-btn" data-share="telegram" aria-label="שיתוף בטלגרם">✈️</a>
  <a href="#" class="share-btn" data-share="copy" aria-label="העתקת קישור">🔗</a>
</div>`;

/* ---------- דף הבית ---------- */
function buildIndex() {
  const featured = [...all.filter((a) => a.featured), ...all.filter((a) => !a.featured)];
  const [hero, side1, side2, ...rest] = featured;
  const latest = rest.slice(0, 12);
  const usedIds = new Set([hero, side1, side2, ...latest].filter(Boolean).map((a) => a.id));

  const catSections = site.categories
    .map((c) => {
      const items = all.filter((a) => a.category === c.name && !usedIds.has(a.id)).slice(0, 3);
      if (items.length < 2) return '';
      return `
<section class="section container">
  <div class="section-head">
    <h2>${esc(c.name)}</h2>
    <a href="category/${c.slug}.html">לכל הכתבות ←</a>
  </div>
  <div class="grid">${items.map((a) => gridCard(a, '')).join('')}</div>
</section>`;
    })
    .join('');

  const content = `
<section class="hero container">
  <div class="hero-grid">
    ${heroCard(hero, '')}
    <div class="hero-side">
      ${side1 ? sideCard(side1, '') : ''}
      ${side2 ? sideCard(side2, '') : ''}
    </div>
  </div>
</section>

<section class="section container">
  <div class="section-head"><h2>כתבות אחרונות</h2></div>
  <div class="grid">${latest.map((a) => gridCard(a, '')).join('')}</div>
</section>
${catSections}`;

  const head = `<link rel="canonical" href="${site.baseUrl}/">
<meta property="og:type" content="website">
<meta property="og:title" content="${escAttr(site.siteTitle)} - ${escAttr(site.tagline)}">
<meta property="og:description" content="${escAttr(site.description)}">
<meta property="og:image" content="${escAttr(imgOf(hero))}">`;

  writeFileSync(join(ROOT_DIR, 'index.html'),
    renderPage({
      title: `${site.siteTitle} - ${site.tagline}`,
      description: site.description,
      content, root: '', headExtra: head,
    }));
}

/* ---------- דפי כתבות ---------- */
function buildArticles() {
  const dir = join(ROOT_DIR, 'articles');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  for (const a of all) {
    const related = [
      ...all.filter((x) => x.id !== a.id && x.category === a.category),
      ...all.filter((x) => x.id !== a.id && x.category !== a.category),
    ].slice(0, 3);

    const jsonLd = {
      '@context': 'https://schema.org',
      '@type': 'NewsArticle',
      headline: a.title,
      description: a.subtitle || '',
      image: [imgOf(a)],
      datePublished: a.date,
      author: [{ '@type': 'Organization', name: a.author || site.siteTitle }],
      publisher: { '@type': 'Organization', name: site.siteTitle },
      mainEntityOfPage: `${site.baseUrl}/${articleUrl(a)}`,
    };

    const head = `<link rel="canonical" href="${site.baseUrl}/${articleUrl(a)}">
<meta property="og:type" content="article">
<meta property="og:title" content="${escAttr(a.title)}">
<meta property="og:description" content="${escAttr(a.subtitle || '')}">
<meta property="og:image" content="${escAttr(imgOf(a))}">
<meta property="og:url" content="${site.baseUrl}/${articleUrl(a)}">
<meta property="article:published_time" content="${escAttr(a.date)}">
<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>`;

    const content = `
<article class="article-wrap">
  <nav class="breadcrumb"><a href="../index.html">ראשי</a> › <a href="../category/${catSlug(a.category)}.html">${esc(a.category)}</a></nav>
  <header class="article-head">
    ${chip(a)}
    <h1>${esc(a.title)}</h1>
    <p class="subtitle">${esc(a.subtitle || '')}</p>
    <div class="article-meta">
      <span>✍️ ${esc(a.author || site.siteTitle)}</span>
      <span>🕐 ${fmtDate(a.date)}</span>
    </div>
  </header>
  <figure class="article-hero">
    <img src="${escAttr(imgOf(a))}" alt="${escAttr(a.title)}" fetchpriority="high">
  </figure>
  ${a.imageCredit ? `<p class="img-credit">צילום: ${esc(a.imageCredit)}</p>` : ''}
  <div class="article-body">
${mdToHtml(a.body || '')}
  </div>
  ${leadFormHtml(a)}
  ${shareRow}
  <!-- אזור פרסום: הדביקו כאן את קוד ה-widget של Taboola/Outbrain -->
  <div class="ad-slot" id="taboola-below-article-thumbnails">אזור פרסום</div>
</article>

<section class="related container">
  <div class="section-head"><h2>אולי יעניין אתכם</h2></div>
  <div class="grid">${related.map((r) => gridCard(r, '../')).join('')}</div>
</section>`;

    writeFileSync(join(dir, `${a.id}.html`),
      renderPage({
        title: `${a.title} | ${site.siteTitle}`,
        description: a.subtitle || a.title,
        content, root: '../', headExtra: head, activeCat: a.category,
      }));
  }
}

/* ---------- דפי קטגוריה ---------- */
function buildCategories() {
  const dir = join(ROOT_DIR, 'category');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  for (const c of site.categories) {
    const items = all.filter((a) => a.category === c.name);
    const content = `
<section class="section container">
  <div class="section-head"><h2>${esc(c.name)}</h2></div>
  ${items.length
    ? `<div class="grid">${items.map((a) => gridCard(a, '../')).join('')}</div>`
    : '<p style="padding:20px 0 40px;color:#6b7280">עדיין אין כתבות בקטגוריה זו - בקרוב!</p>'}
</section>`;
    writeFileSync(join(dir, `${c.slug}.html`),
      renderPage({
        title: `${c.name} | ${site.siteTitle}`,
        description: `כל הכתבות בנושא ${c.name} במגזין 42`,
        content, root: '../', activeCat: c.name,
        headExtra: `<link rel="canonical" href="${site.baseUrl}/category/${c.slug}.html">`,
      }));
  }
}

/* ---------- עמודים סטטיים ---------- */
function buildStaticPages() {
  const srcDir = join(ROOT_DIR, 'content/pages');
  const outDir = join(ROOT_DIR, 'pages');
  mkdirSync(outDir, { recursive: true });
  const titles = {
    'about.html': 'אודות',
    'privacy.html': 'מדיניות פרטיות',
    'terms.html': 'תנאי שימוש',
    'accessibility.html': 'הצהרת נגישות',
  };
  for (const f of readdirSync(srcDir)) {
    const fragment = readFileSync(join(srcDir, f), 'utf8');
    writeFileSync(join(outDir, f),
      renderPage({
        title: `${titles[f] || f} | ${site.siteTitle}`,
        description: site.description,
        content: `<div class="page-wrap">${fragment}</div>`,
        root: '../',
        headExtra: '<meta name="robots" content="noindex, follow">',
      }));
  }
}

/* ---------- sitemap ---------- */
function buildSitemap() {
  const urls = [
    `${site.baseUrl}/`,
    ...site.categories.map((c) => `${site.baseUrl}/category/${c.slug}.html`),
    ...all.map((a) => `${site.baseUrl}/${articleUrl(a)}`),
  ];
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url><loc>${u}</loc></url>`).join('\n')}
</urlset>
`;
  writeFileSync(join(ROOT_DIR, 'sitemap.xml'), xml);
}

/* ---------- הרצה ---------- */
buildIndex();
buildArticles();
buildCategories();
buildStaticPages();
buildSitemap();
console.log(`נבנו בהצלחה: דף בית, ${all.length} כתבות, ${site.categories.length} קטגוריות, עמודים סטטיים ו-sitemap.`);
