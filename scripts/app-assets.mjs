/**
 * Draws the native apps' icons and splash screens into android/ and ios/.
 *
 * Capacitor's templates ship placeholder art (a teal grid). This replaces it
 * with the Commons mark at every size each platform asks for, from the same
 * source as the web icons. Run by `npm run app:sync`; safe to re-run.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NIGHT_HEX, drawIcon, drawSplash } from './lib/mark.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const android = join(root, 'android/app/src/main/res');
const ios = join(root, 'ios/App/App/Assets.xcassets');

function write(path, buf) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, buf);
  return path.replace(root, '');
}

const written = [];

// ------------------------------------------------------------------ Android
if (existsSync(android)) {
  // Legacy launcher icons (a rounded square, a circle) and the adaptive
  // foreground layer (the lights alone, inset so the 66dp safe zone holds).
  const densities = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };
  for (const [d, size] of Object.entries(densities)) {
    written.push(write(join(android, `mipmap-${d}/ic_launcher.png`), drawIcon(size)));
    written.push(write(join(android, `mipmap-${d}/ic_launcher_round.png`), drawIcon(size, { shape: 'circle' })));
    written.push(write(join(android, `mipmap-${d}/ic_launcher_foreground.png`), drawIcon(Math.round(size * 2.25), { pad: 0.22, plate: false })));
  }
  // The adaptive background is a colour resource; the template's vector grid goes.
  written.push(write(join(android, 'values/ic_launcher_background.xml'),
    `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">${NIGHT_HEX}</color>\n</resources>\n`));
  written.push(write(join(android, 'drawable/ic_launcher_background.xml'),
    `<?xml version="1.0" encoding="utf-8"?>\n<vector xmlns:android="http://schemas.android.com/apk/res/android"\n    android:width="108dp" android:height="108dp" android:viewportWidth="108" android:viewportHeight="108">\n    <path android:fillColor="${NIGHT_HEX}" android:pathData="M0,0h108v108h-108z" />\n</vector>\n`));

  // Splash screens at the sizes the template shipped.
  const splashes = {
    'drawable': [480, 320],
    'drawable-land-mdpi': [480, 320], 'drawable-land-hdpi': [800, 480], 'drawable-land-xhdpi': [1280, 720],
    'drawable-land-xxhdpi': [1600, 960], 'drawable-land-xxxhdpi': [1920, 1280],
    'drawable-port-mdpi': [320, 480], 'drawable-port-hdpi': [480, 800], 'drawable-port-xhdpi': [720, 1280],
    'drawable-port-xxhdpi': [960, 1600], 'drawable-port-xxxhdpi': [1280, 1920],
  };
  for (const [dir, [w, h]] of Object.entries(splashes)) {
    written.push(write(join(android, `${dir}/splash.png`), drawSplash(w, h)));
  }
  // Android 12+ draws its own splash from the theme; give it the night too.
  const styles = join(android, 'values/styles.xml');
  let xml = readFileSync(styles, 'utf8');
  if (!xml.includes('windowSplashScreenBackground')) {
    xml = xml.replace(
      '<style name="AppTheme.NoActionBarLaunch" parent="Theme.SplashScreen">',
      `<style name="AppTheme.NoActionBarLaunch" parent="Theme.SplashScreen">\n        <item name="windowSplashScreenBackground">${NIGHT_HEX}</item>`,
    );
    writeFileSync(styles, xml);
    written.push(styles.replace(root, ''));
  }
}

// ---------------------------------------------------------------------- iOS
if (existsSync(ios)) {
  // One 1024 icon, opaque and square: iOS rounds it itself and rejects alpha.
  written.push(write(join(ios, 'AppIcon.appiconset/AppIcon-512@2x.png'), drawIcon(1024, { shape: 'square' })));
  const splash = drawSplash(2732, 2732);
  for (const name of ['splash-2732x2732.png', 'splash-2732x2732-1.png', 'splash-2732x2732-2.png']) {
    written.push(write(join(ios, `Splash.imageset/${name}`), splash));
  }
}

console.log(`${written.length} native asset(s) drawn`);
