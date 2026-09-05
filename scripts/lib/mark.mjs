/**
 * The Commons mark, drawn with nothing but node.
 *
 * Three lights in the night: two people side by side, one below — the same
 * three dots the favicon, the web icons, the store icons and the splash
 * screens all carry, so every surface is recognisably one thing. PNGs are
 * encoded here with node's zlib, so there is no image dependency to install
 * and no binary in the repo that nobody can regenerate.
 */
import { deflateSync } from 'node:zlib';

const NIGHT = [0x08, 0x0d, 0x16];   // --top-bg, the night the landing page paints
const LIGHT = [0xff, 0xff, 0xff];

// ------------------------------------------------------------------ PNG

const CRC = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/**
 * rgba: a Uint8Array of width*height*4.
 *
 * `opaque` writes an RGB file with no alpha channel at all. App Store Connect
 * rejects a 1024 icon that merely *has* an alpha channel, fully opaque or not
 * (ITMS-90717), so the iOS icon and the splash screens are written this way.
 */
export function encodePng(width, height, rgba, { opaque = false } = {}) {
  const bpp = opaque ? 3 : 4;
  const raw = Buffer.alloc((width * bpp + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * bpp + 1);
    raw[row] = 0;
    if (!opaque) {
      Buffer.from(rgba.buffer, y * width * 4, width * 4).copy(raw, row + 1);
    } else {
      for (let x = 0; x < width; x += 1) {
        const i = (y * width + x) * 4;
        raw[row + 1 + x * 3] = rgba[i]; raw[row + 2 + x * 3] = rgba[i + 1]; raw[row + 3 + x * 3] = rgba[i + 2];
      }
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;                 // bit depth
  ihdr[9] = opaque ? 2 : 6;    // colour type: RGB or RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Width and height from a PNG's header — what the tests read back. */
export function pngSize(buf) {
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), colourType: buf[25] };
}

// ----------------------------------------------------------------- the mark

const CIRCLES = [
  { x: 0.344, y: 0.375, r: 0.125 },
  { x: 0.656, y: 0.375, r: 0.125 },
  { x: 0.500, y: 0.672, r: 0.125 },
];

/**
 * The mark on a plate.
 *
 *   shape    'rounded' (a rounded square), 'circle', or 'square' (opaque —
 *            iOS masks its own icons and rejects transparency)
 *   pad      inset the artwork, for launchers that crop up to 20% per edge
 *   plate    false draws the three lights alone on a transparent ground —
 *            an Android adaptive-icon foreground layer
 */
export function drawIcon(size, { pad = 0, shape = 'rounded', plate = true } = {}) {
  const px = new Uint8Array(size * size * 4);
  const radius = shape === 'rounded' ? size * 0.22 : shape === 'circle' ? size / 2 : 0;
  const inset = size * pad;
  const art = size - inset * 2;
  const S = 3; // 3x3 supersampling: cheap, and the edges matter at 48px

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let bg = 0, fg = 0;
      for (let sy = 0; sy < S; sy += 1) {
        for (let sx = 0; sx < S; sx += 1) {
          const px1 = x + (sx + 0.5) / S;
          const py1 = y + (sy + 0.5) / S;
          if (shape === 'circle') {
            if (Math.hypot(px1 - size / 2, py1 - size / 2) > radius) continue;
          } else if (shape === 'rounded') {
            const dx = Math.max(radius - px1, px1 - (size - radius), 0);
            const dy = Math.max(radius - py1, py1 - (size - radius), 0);
            if (Math.hypot(dx, dy) > radius) continue;
          }
          bg += 1;
          const u = (px1 - inset) / art;
          const v = (py1 - inset) / art;
          for (const c of CIRCLES) {
            if (Math.hypot(u - c.x, v - c.y) <= c.r) { fg += 1; break; }
          }
        }
      }
      const total = S * S;
      const i = (y * size + x) * 4;
      if (bg === 0) continue;
      const mix = fg / total;
      if (plate) {
        for (let ch = 0; ch < 3; ch += 1) px[i + ch] = Math.round(NIGHT[ch] * (1 - mix) + LIGHT[ch] * mix);
        px[i + 3] = Math.round((bg / total) * 255);
      } else {
        px[i] = LIGHT[0]; px[i + 1] = LIGHT[1]; px[i + 2] = LIGHT[2];
        px[i + 3] = Math.round(mix * 255);
      }
    }
  }
  return encodePng(size, size, px, { opaque: shape === 'square' });
}

/**
 * A splash screen: the night, and the three lights small in the middle.
 *
 * Only the region around the mark is supersampled; the rest is a flat fill,
 * which keeps a 2732×2732 splash under a second to draw.
 */
export function drawSplash(width, height) {
  const px = new Uint8Array(width * height * 4);
  for (let i = 0; i < px.length; i += 4) {
    px[i] = NIGHT[0]; px[i + 1] = NIGHT[1]; px[i + 2] = NIGHT[2]; px[i + 3] = 255;
  }
  const art = Math.min(width, height) * 0.22;
  const ox = (width - art) / 2;
  const oy = (height - art) / 2;
  const S = 3;
  const x0 = Math.max(0, Math.floor(ox)), x1 = Math.min(width, Math.ceil(ox + art));
  const y0 = Math.max(0, Math.floor(oy)), y1 = Math.min(height, Math.ceil(oy + art));
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      let fg = 0;
      for (let sy = 0; sy < S; sy += 1) {
        for (let sx = 0; sx < S; sx += 1) {
          const u = (x + (sx + 0.5) / S - ox) / art;
          const v = (y + (sy + 0.5) / S - oy) / art;
          for (const c of CIRCLES) {
            if (Math.hypot(u - c.x, v - c.y) <= c.r) { fg += 1; break; }
          }
        }
      }
      if (fg === 0) continue;
      const mix = fg / (S * S);
      const i = (y * width + x) * 4;
      for (let ch = 0; ch < 3; ch += 1) px[i + ch] = Math.round(NIGHT[ch] * (1 - mix) + LIGHT[ch] * mix);
    }
  }
  return encodePng(width, height, px, { opaque: true });
}

export const NIGHT_HEX = '#080D16';
