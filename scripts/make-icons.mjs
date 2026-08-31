/**
 * Draw the Commons app icons.
 *
 * The installed app needs real PNGs — iOS home screens and Android launchers
 * will not take an SVG — so rather than commit opaque binaries with no source,
 * this draws them. Node's zlib is the only thing it needs, which keeps the
 * repo's no-dependencies rule intact.
 *
 *   npm run icons
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const OUT = fileURLToPath(new URL('../public/icons/', import.meta.url));

// ------------------------------------------------------------- PNG encoding

const CRC = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(data.length + 12);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** rgba: a Uint8Array of width*height*4. */
function encodePng(width, height, rgba) {
  // Each scanline is prefixed with its filter byte; filter 0 (none) is fine
  // for flat artwork and keeps this encoder to a dozen lines.
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------- the mark

const BRAND = [0x12, 0x55, 0x8f];   // --primary
const WHITE = [0xff, 0xff, 0xff];

/**
 * Three circles: two people side by side, one below. The same mark as the
 * favicon. `pad` insets the artwork for maskable icons, where launchers crop
 * up to 20% off every edge.
 */
function drawIcon(size, { pad = 0, rounded = true } = {}) {
  const px = new Uint8Array(size * size * 4);
  const radius = rounded ? size * 0.22 : 0;
  const inset = size * pad;
  const art = size - inset * 2;

  // Anti-aliasing by 3x3 supersampling — cheap, and the edges matter at 192px.
  const S = 3;
  const circles = [
    { x: 0.344, y: 0.375, r: 0.125 },
    { x: 0.656, y: 0.375, r: 0.125 },
    { x: 0.500, y: 0.672, r: 0.125 },
  ];

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let bg = 0, fg = 0;
      for (let sy = 0; sy < S; sy += 1) {
        for (let sx = 0; sx < S; sx += 1) {
          const px1 = x + (sx + 0.5) / S;
          const py1 = y + (sy + 0.5) / S;

          // Rounded-rectangle test for the background plate.
          const dx = Math.max(radius - px1, px1 - (size - radius), 0);
          const dy = Math.max(radius - py1, py1 - (size - radius), 0);
          if (Math.hypot(dx, dy) > radius) continue;
          bg += 1;

          const u = (px1 - inset) / art;
          const v = (py1 - inset) / art;
          for (const c of circles) {
            if (Math.hypot(u - c.x, v - c.y) <= c.r) { fg += 1; break; }
          }
        }
      }
      const total = S * S;
      const i = (y * size + x) * 4;
      if (bg === 0) continue;
      const mix = fg / total;
      for (let ch = 0; ch < 3; ch += 1) {
        px[i + ch] = Math.round(BRAND[ch] * (1 - mix) + WHITE[ch] * mix);
      }
      px[i + 3] = Math.round((bg / total) * 255);
    }
  }
  return encodePng(size, size, px);
}

mkdirSync(OUT, { recursive: true });
const files = [
  ['icon-192.png', drawIcon(192)],
  ['icon-512.png', drawIcon(512)],
  // Maskable icons get 20% padding so a launcher can crop to any shape.
  ['icon-maskable-512.png', drawIcon(512, { pad: 0.2 })],
  // iOS ignores transparency and does its own rounding, so this one is square.
  ['apple-touch-icon.png', drawIcon(180, { rounded: false })],
];
for (const [name, buf] of files) {
  writeFileSync(OUT + name, buf);
  console.log(`${name}  ${(buf.length / 1024).toFixed(1)} KB`);
}
