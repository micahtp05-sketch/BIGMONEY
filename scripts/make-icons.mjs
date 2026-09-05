/**
 * Draws the web app's icons into public/icons/.
 *
 * Generated from source, not committed as mystery binaries: the mark lives in
 * scripts/lib/mark.mjs and is shared with the native app icons
 * (scripts/app-assets.mjs), so a phone's home screen, a Mac's dock and the
 * browser tab all show the same three lights.
 *
 *   npm run icons
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { drawIcon } from './lib/mark.mjs';

const OUT = fileURLToPath(new URL('../public/icons/', import.meta.url));

mkdirSync(OUT, { recursive: true });
const files = [
  ['icon-192.png', drawIcon(192)],
  ['icon-512.png', drawIcon(512)],
  // Maskable icons get 20% padding so a launcher can crop to any shape.
  ['icon-maskable-512.png', drawIcon(512, { pad: 0.2 })],
  // iOS ignores transparency and does its own rounding, so this one is square.
  ['apple-touch-icon.png', drawIcon(180, { shape: 'square' })],
];
for (const [name, buf] of files) {
  writeFileSync(OUT + name, buf);
  console.log(`${name}  ${(buf.length / 1024).toFixed(1)} KB`);
}
