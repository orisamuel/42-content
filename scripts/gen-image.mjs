/**
 * gen-image.mjs - יצירת תמונות עם Gemini (משותף ל-fetch-rss ולסקריפטים)
 * מחזיר Buffer של התמונה + סיומת קובץ, או null בכישלון.
 */

const IMAGE_MODELS = [
  'gemini-3.1-flash-image-preview',
  'gemini-2.5-flash-image',
  'gemini-3-pro-image',
];

const KEY = () => process.env.GEMINI_API_KEY || '';

/**
 * @param {string} prompt תיאור התמונה
 * @returns {Promise<{buffer: Buffer, ext: string} | null>}
 */
export async function generateImage(prompt) {
  if (!KEY()) return null;

  for (const model of IMAGE_MODELS) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 120000);
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': KEY() },
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            generationConfig: {
              responseModalities: ['IMAGE'],
              imageConfig: { aspectRatio: '16:9' },
            },
          }),
          signal: ctrl.signal,
        },
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error?.message || `HTTP ${res.status}`);
      const parts = data.candidates?.[0]?.content?.parts || [];
      const img = parts.find((p) => p.inlineData?.data);
      if (!img) throw new Error('אין תמונה בתשובה');
      const mime = img.inlineData.mimeType || 'image/jpeg';
      const ext = mime.includes('png') ? 'png' : mime.includes('webp') ? 'webp' : 'jpg';
      return { buffer: Buffer.from(img.inlineData.data, 'base64'), ext };
    } catch (err) {
      const msg = String(err.message || err);
      // אם המודל לא תומך ב-imageConfig - ננסה שוב בלעדיו לפני שעוברים למודל הבא
      if (/imageConfig|aspect/i.test(msg)) {
        try {
          const res2 = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'x-goog-api-key': KEY() },
              body: JSON.stringify({
                contents: [{ role: 'user', parts: [{ text: prompt }] }],
                generationConfig: { responseModalities: ['IMAGE'] },
              }),
            },
          );
          const data2 = await res2.json();
          const parts2 = data2.candidates?.[0]?.content?.parts || [];
          const img2 = parts2.find((p) => p.inlineData?.data);
          if (img2) {
            const mime2 = img2.inlineData.mimeType || 'image/jpeg';
            const ext2 = mime2.includes('png') ? 'png' : 'jpg';
            return { buffer: Buffer.from(img2.inlineData.data, 'base64'), ext: ext2 };
          }
        } catch { /* ממשיכים למודל הבא */ }
      }
      console.warn(`  ✗ ${model}: ${msg.slice(0, 90)}`);
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

/** פרומפט לתמונת כתבה - כללי זהירות: בלי טקסט, בלי אנשים אמיתיים */
export function articleImagePrompt(title, category) {
  return `Editorial magazine cover photo for a news article. Topic (in Hebrew): "${title}". Category: ${category}.
Create a generic, symbolic, professional stock-photo style image representing the general theme only.
Strict rules: photorealistic, high quality, 16:9. NO text, NO letters, NO numbers, NO logos, NO flags,
NO recognizable faces, NO real people or politicians, NO graphic violence. Neutral and tasteful.`;
}
