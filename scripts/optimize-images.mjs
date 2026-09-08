/**
 * optimize-images.mjs - דחיסת תמונות ויצירת גרסאות WebP רספונסיביות
 * ----------------------------------------------------------------
 * לכל תמונת מקור (jpg/png/webp) בתיקיות assets/rss-img, assets/uploads, assets/img:
 *   1. JPEG רחב מ-1200px או כבד מ-300KB נדחס במקום (1200px, איכות 78) - פעם אחת בלבד
 *   2. נוצרות גרסאות <שם>-480.webp / -800.webp / -1200.webp (בלי הגדלה מעבר למקור)
 *   3. גרסאות של תמונות שכבר נמחקו מנוקות
 * הפעולה אידמפוטנטית: הרצה חוזרת על אותן תמונות לא משנה כלום.
 * דורש sharp (npm install). בלי sharp: מדלג עם הודעה והאתר נבנה עם התמונות המקוריות.
 * הרצה ידנית: node scripts/optimize-images.mjs
 */
import { readdirSync, readFileSync, existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
export const IMAGE_DIRS = ['assets/rss-img', 'assets/uploads', 'assets/img'];
export const WIDTHS = [480, 800, 1200];
const MAX_WIDTH = 1200;
const MAX_SOURCE_BYTES = 300 * 1024;
const JPEG_QUALITY = 78;
const WEBP_QUALITY = 76;
const SOURCE_RE = /\.(jpe?g|png|webp)$/i;
const VARIANT_RE = /-(480|800|1200)\.webp$/i;

async function loadSharp() {
  try {
    return (await import('sharp')).default;
  } catch {
    return null;
  }
}

export async function optimizeImages({ log = console.log } = {}) {
  const sharp = await loadSharp();
  if (!sharp) {
    log('⚠ sharp לא מותקן - מדלגים על אופטימיזציית תמונות (הריצו npm install)');
    return { skipped: true };
  }
  const stats = { variants: 0, compressed: 0, removed: 0, saved: 0 };

  for (const rel of IMAGE_DIRS) {
    const dir = join(ROOT_DIR, rel);
    if (!existsSync(dir)) continue;
    const files = readdirSync(dir);
    const sources = files.filter((f) => SOURCE_RE.test(f) && !VARIANT_RE.test(f));
    const stems = new Set(sources.map((f) => f.replace(SOURCE_RE, '')));

    // 1. ניקוי גרסאות יתומות (המקור שלהן נמחק, למשל כתבת RSS שיצאה מהאתר)
    for (const f of files) {
      if (VARIANT_RE.test(f) && !stems.has(f.replace(VARIANT_RE, ''))) {
        unlinkSync(join(dir, f));
        stats.removed++;
      }
    }

    // 2. עיבוד כל תמונת מקור
    for (const f of sources) {
      const full = join(dir, f);
      const stem = f.replace(SOURCE_RE, '');
      const isJpeg = /\.jpe?g$/i.test(f);
      const processed = WIDTHS.some((w) => existsSync(join(dir, `${stem}-${w}.webp`)));

      // עובדים על Buffer ולא על הנתיב: libvips משאיר קובץ קלט פתוח, וב-Windows אי אפשר לדרוס קובץ פתוח
      let input = readFileSync(full);
      let width = 0;
      try {
        ({ width = 0 } = await sharp(input, { failOn: 'none' }).metadata());
      } catch (err) {
        log(`  ✗ ${rel}/${f}: ${err.message}`);
        continue;
      }

      // 2a. דחיסת המקור במקום - רק בפעם הראשונה (לפני שנוצרו גרסאות), רק JPEG גדול או רחב
      const size = input.length;
      if (isJpeg && !processed && (width > MAX_WIDTH || size > MAX_SOURCE_BYTES)) {
        const buf = await sharp(input, { failOn: 'none' })
          .rotate()
          .resize({ width: MAX_WIDTH, withoutEnlargement: true })
          .jpeg({ quality: JPEG_QUALITY, mozjpeg: true, progressive: true })
          .toBuffer();
        if (buf.length < size) {
          writeFileSync(full, buf);
          input = buf;
          stats.saved += size - buf.length;
          stats.compressed++;
          width = Math.min(width, MAX_WIDTH);
        }
      }

      // 2b. גרסאות WebP - בלי הגדלה: רק רוחבים שאינם גדולים מהמקור (הקטן ביותר נוצר תמיד)
      for (const w of WIDTHS) {
        const out = join(dir, `${stem}-${w}.webp`);
        if (existsSync(out)) continue;
        if (w > width && w !== WIDTHS[0]) continue;
        await sharp(input, { failOn: 'none' })
          .rotate()
          .resize({ width: w, withoutEnlargement: true })
          .webp({ quality: WEBP_QUALITY })
          .toFile(out);
        stats.variants++;
      }
    }
  }

  log(`תמונות: ${stats.variants} גרסאות WebP נוצרו, ${stats.compressed} מקורות נדחסו (${(stats.saved / 1048576).toFixed(1)}MB נחסכו), ${stats.removed} גרסאות יתומות נוקו.`);
  return stats;
}

/* הרצה ישירה מהטרמינל */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await optimizeImages();
}
