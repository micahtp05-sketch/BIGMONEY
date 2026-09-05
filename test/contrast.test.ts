// Recomputes every text/ground ratio in the design (scratchpad SPEC.md §2, §4.3)
// straight from the hex values declared in public/commons.css, so there is one
// table, not two that drift. WCAG 2.x relative luminance. Body pairs must clear
// 7:1, small 600-weight labels 4.5:1, borders / rings / glyphs 3:1.
//
// Also guards §2.2 (the two dark blocks are identical), the §4 font floor
// (nothing under 14 px) and the ban on `outline: none`.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const CSS_PATH = new URL('../public/commons.css', import.meta.url);
const css = readFileSync(CSS_PATH, 'utf8');
const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');

// --------------------------------------------------------------- CSS reading

type Rule = { selector: string; body: string };

/** Top-level rules of a stylesheet body: `selector { body }`, brace-matched. */
function rulesOf(text: string): Rule[] {
  const out: Rule[] = [];
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf('{', i);
    if (open === -1) break;
    // The selector runs from the end of the previous rule (or a `;` / `}`) to this brace.
    let start = open - 1;
    while (start >= 0 && text[start] !== '}' && text[start] !== ';') start -= 1;
    const selector = text.slice(start + 1, open).trim();
    let depth = 1;
    let j = open + 1;
    while (j < text.length && depth > 0) {
      if (text[j] === '{') depth += 1;
      else if (text[j] === '}') depth -= 1;
      j += 1;
    }
    out.push({ selector, body: text.slice(open + 1, j - 1) });
    i = j;
  }
  return out;
}

const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

/** `--name: value` declarations inside one rule body (no nesting expected). */
function declarations(body: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of body.split(';')) {
    const colon = part.indexOf(':');
    if (colon === -1) continue;
    const prop = norm(part.slice(0, colon));
    const value = norm(part.slice(colon + 1));
    if (prop.startsWith('--') || prop === 'color-scheme') out.set(prop, value);
  }
  return out;
}

/** Only the declarations whose value is a plain 6-digit hex colour. */
function hexTokens(decls: Map<string, string>): Map<string, string> {
  const out = new Map<string, string>();
  for (const [k, v] of decls) if (/^#[0-9a-f]{6}$/i.test(v)) out.set(k, v.toUpperCase());
  return out;
}

const top = rulesOf(stripped);
const find = (rules: Rule[], selector: string) => rules.find((r) => norm(r.selector) === selector);

const rootRule = find(top, ':root');
const darkMedia = top.find((r) => /^@media\s*\(\s*prefers-color-scheme\s*:\s*dark\s*\)$/.test(norm(r.selector)));
const darkMediaRule = darkMedia ? find(rulesOf(darkMedia.body), ':root:not([data-theme="light"])') : undefined;
const darkAttrRule = find(top, ':root[data-theme="dark"]');

const rootDecls = rootRule ? declarations(rootRule.body) : new Map<string, string>();
const darkMediaDecls = darkMediaRule ? declarations(darkMediaRule.body) : new Map<string, string>();
const darkAttrDecls = darkAttrRule ? declarations(darkAttrRule.body) : new Map<string, string>();

const LIGHT = hexTokens(rootDecls);
const DARK = hexTokens(darkMediaDecls);

// ----------------------------------------------------------------- the maths

const hex = (h: string): number[] => {
  const s = h.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16));
};
const toHex = (rgb: number[]) => '#' + rgb.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('').toUpperCase();
const lin = (c: number) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const L = (h: string) => { const [r = 0, g = 0, b = 0] = hex(h); return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b); };
const ratio = (a: string, b: string) => { const x = L(a), y = L(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
/** `rgb` at alpha `a` composited over an opaque `ground`. */
const over = (rgb: number[], a: number, ground: string) => toHex(hex(ground).map((g, i) => (rgb[i] ?? 0) * a + g * (1 - a)));

// ------------------------------------------------------------ the pair list

type Theme = { name: string; tokens: Map<string, string>; grounds: [string, string][] };

/** Look a token up by its CSS name, failing the test loudly if it is not declared. */
function tok(theme: Theme, name: string): string {
  const v = theme.tokens.get(name);
  assert.ok(v, `${name} is not declared as a hex colour in the ${theme.name} block of public/commons.css`);
  return v;
}

/** A pair whose tokens may be missing: resolve inside the it() so a missing token is one clear failure. */
function pair(theme: Theme, label: string, fgName: string, bg: string | [string, string], floor: number) {
  const bgLabel = Array.isArray(bg) ? bg[0] : bg;
  it(`${theme.name}: ${label} (${fgName} on ${bgLabel}, floor ${floor})`, () => {
    const fg = tok(theme, fgName);
    const ground = Array.isArray(bg) ? bg[1] : tok(theme, bg);
    const r = ratio(fg, ground);
    assert.ok(r >= floor, `${theme.name}: ${label}: ${fg} on ${ground} is ${r.toFixed(2)}:1, floor ${floor}:1`);
  });
}

// Worst-case grounds (§2.3). Dark glow centre: rgba(30,58,110,.35) over the night ground.
const NIGHT = '#080D16';
const glow = over([30, 58, 110], 0.35, DARK.get('--bg') ?? NIGHT);
// Header sky under a text box: sprites at ZONE alpha. Hub halo .30 then hub core .85
// (help hub, cores at +45 per channel), or person halo .30 (NEAR) then core .60 (white).
// The brighter of the two is the bound; ambient.js caps every alpha at these ceilings.
const ZONE = 0.12;
const hubPix = over([195, 245, 255], 0.85 * ZONE, over([150, 200, 255], 0.30 * ZONE, NIGHT));
const personPix = over([255, 255, 255], 0.60 * ZONE, over([255, 247, 232], 0.30 * ZONE, NIGHT));
const skyWorst = L(hubPix) > L(personPix) ? hubPix : personPix;

const light: Theme = { name: 'LIGHT', tokens: LIGHT, grounds: [['--bg', '--bg'], ['--surface', '--surface'], ['--surface-2', '--surface-2']] };
const dark: Theme = { name: 'DARK', tokens: DARK, grounds: [['--bg', '--bg'], ['--surface', '--surface'], ['--surface-2', '--surface-2']] };

// ------------------------------------------------------------------- tests

describe('commons.css token blocks', () => {
  it('declares a top-level :root block with hex tokens', () => {
    assert.ok(rootRule, 'no top-level `:root {}` rule found in public/commons.css');
    assert.ok(LIGHT.size > 0, ':root declares no hex colour tokens');
  });

  it('declares the dark block under @media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) }', () => {
    assert.ok(darkMedia, 'no top-level `@media (prefers-color-scheme: dark)` block found');
    assert.ok(darkMediaRule, 'no `:root:not([data-theme="light"])` rule inside the dark media block');
    assert.ok(DARK.size > 0, 'the dark media block declares no hex colour tokens');
  });

  it('declares the dark block again as :root[data-theme="dark"]', () => {
    assert.ok(darkAttrRule, 'no top-level `:root[data-theme="dark"]` rule found');
  });

  it('the two dark blocks declare identical token sets with identical values (§2.2)', () => {
    assert.ok(darkMediaRule && darkAttrRule, 'both dark blocks must exist before they can be compared');
    const a = Object.fromEntries([...darkMediaDecls].sort());
    const b = Object.fromEntries([...darkAttrDecls].sort());
    assert.deepEqual(a, b, 'the media-query dark block and the [data-theme="dark"] block have drifted apart');
  });

  it('every dark token is also a light token (no theme-only token)', () => {
    for (const name of DARK.keys()) assert.ok(rootDecls.has(name), `${name} is declared in dark but not in :root`);
  });
});

describe('contrast: body and label pairs, both themes', () => {
  for (const theme of [light, dark]) {
    const grounds: [string, string | [string, string]][] = theme.grounds.map(([label, name]) => [label, name]);
    if (theme === dark) grounds.push(['glow-centre', ['glow-centre ' + glow, glow]]);
    for (const [gn, g] of grounds) {
      pair(theme, `ink on ${gn} (body)`, '--ink', g, 7);
      pair(theme, `muted on ${gn} (body)`, '--muted', g, 7);
      pair(theme, `border-strong on ${gn} (control border)`, '--border-strong', g, 3);
      pair(theme, `focus ring on ${gn}`, '--focus', g, 3);
      for (const k of ['--help', '--group', '--social', '--danger']) {
        const floor = gn === '--surface-2' ? 4.5 : 7; // surface-2 carries only 16–17 px 600 labels
        pair(theme, `${k.slice(2)} text on ${gn}`, k, g, floor);
      }
      pair(theme, `warnstar border/star on ${gn} (3:1)`, '--warnstar', g, 3);
    }
    pair(theme, 'warnink on warnbg (16 px body)', '--warnink', '--warnbg', 7);
    pair(theme, 'warnink on surface', '--warnink', '--surface', 7);
    pair(theme, 'warnstar border on warnbg (3:1)', '--warnstar', '--warnbg', 3);
    for (const k of ['help', 'group', 'social']) {
      pair(theme, `on-accent text on ${k} fill (button)`, '--on-accent', `--${k}`, 7);
      pair(theme, `on-accent text on ${k}-hover fill`, '--on-accent', `--${k}-hover`, 7);
    }
    pair(theme, 'primary button / toast / badge: bg text on ink fill', '--bg', '--ink', 7);
  }
});

describe(`contrast: the night header (sky worst pixel under text ${skyWorst}, glow centre ${glow})`, () => {
  const header = { name: 'HEADER (:root)', tokens: LIGHT, grounds: [] as [string, string][] };
  const sky: [string, string] = ['sky worst pixel ' + skyWorst, skyWorst];
  pair(header, 'top-ink on night', '--top-ink', '--top-bg', 7);
  pair(header, 'brand on night', '--top-brand', '--top-bg', 7);
  pair(header, 'top-ink on sky worst pixel', '--top-ink', sky, 7);
  pair(header, 'brand on sky worst pixel', '--top-brand', sky, 7);
  pair(header, 'top-muted (Sign out, 18 px 600) on night', '--top-muted', '--top-bg', 7);
  pair(header, 'top-muted on sky worst pixel', '--top-muted', sky, 7);
  pair(header, 'top-muted placeholder on search field', '--top-muted', '--top-field', 7);
  pair(header, 'top-ink on search field', '--top-ink', '--top-field', 7);
  pair(header, 'top-border on night (control border)', '--top-border', '--top-bg', 3);
  pair(header, 'top-border on search field', '--top-border', '--top-field', 3);
  pair(header, 'top-border on sky worst pixel', '--top-border', sky, 3);
  pair(header, 'focus-night ring on night', '--focus-night', '--top-bg', 3);
  pair(header, 'focus-night ring on sky worst pixel', '--focus-night', sky, 3);
  pair(header, 'night text on paper pill (Sign in)', '--top-bg', '--top-ink', 7);

  it('the sky worst pixel is the documented #202B35 (§2.3)', () => {
    assert.equal(skyWorst, '#202B35', `sky worst pixel computed as ${skyWorst}`);
  });
  it('the dark glow centre is the documented #101D35 (§2.3)', () => {
    assert.equal(glow, '#101D35', `glow centre computed as ${glow}`);
  });
});

describe('commons.css §4 floors', () => {
  it('has no font-size under 14 px (grep: font-size: ([0-9]|1[0-3])px, or a font: shorthand with one)', () => {
    const offenders: string[] = [];
    stripped.split('\n').forEach((line, i) => {
      const explicit = line.match(/font-size\s*:\s*(\d+(?:\.\d+)?)px/);
      if (explicit && Number(explicit[1]) < 14) offenders.push(`line ${i + 1}: ${line.trim()}`);
      const shorthand = line.match(/\bfont\s*:\s*([^;]+)/);
      if (shorthand) {
        const size = (shorthand[1] ?? '').match(/(?:^|\s)(\d+(?:\.\d+)?)px/);
        if (size && Number(size[1]) < 14) offenders.push(`line ${i + 1}: ${line.trim()}`);
      }
    });
    assert.deepEqual(offenders, [], `font sizes under 14 px:\n${offenders.join('\n')}`);
  });

  it('never uses outline: none', () => {
    const offenders: string[] = [];
    stripped.split('\n').forEach((line, i) => {
      if (/outline\s*:\s*none/.test(line)) offenders.push(`line ${i + 1}: ${line.trim()}`);
    });
    assert.deepEqual(offenders, [], `outline: none found:\n${offenders.join('\n')}`);
  });
});
