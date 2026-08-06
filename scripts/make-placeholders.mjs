/**
 * make-placeholders.mjs - יצירה חד-פעמית של תמונות ברירת מחדל לקטגוריות
 * הרצה: node scripts/make-placeholders.mjs
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateImage } from './gen-image.mjs';

const ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

// טעינת .env
const envPath = join(ROOT_DIR, '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const PROMPTS = {
  news: 'Professional editorial stock photo: abstract newsroom concept, glowing globe and soft blue light, modern press atmosphere. Photorealistic, 16:9, no text, no logos, no faces.',
  economy: 'Professional editorial stock photo: upward financial growth concept, coins and subtle chart light trails on a desk, warm tones. Photorealistic, 16:9, no text, no logos, no faces.',
  consumer: 'Professional editorial stock photo: shopping cart with paper bags in soft studio light, clean commercial look. Photorealistic, 16:9, no text, no logos, no faces.',
  tech: 'Professional editorial stock photo: sleek circuit board with glowing blue traces, shallow depth of field, futuristic feel. Photorealistic, 16:9, no text, no logos, no faces.',
  lifestyle: 'Professional editorial stock photo: cozy morning scene with coffee, plant and sunlight on a bright table, relaxed vibe. Photorealistic, 16:9, no text, no logos, no faces.',
  sport: 'Professional editorial stock photo: stadium floodlights over green pitch at dusk, dramatic atmosphere, wide angle. Photorealistic, 16:9, no text, no logos, no faces.',
};

for (const [slug, prompt] of Object.entries(PROMPTS)) {
  process.stdout.write(`${slug}... `);
  const img = await generateImage(prompt);
  if (img) {
    writeFileSync(join(ROOT_DIR, 'assets/img', `cat-${slug}.jpg`), img.buffer);
    console.log(`✓ (${Math.round(img.buffer.length / 1024)}KB, ${img.ext})`);
  } else {
    console.log('✗ נכשל');
  }
}
