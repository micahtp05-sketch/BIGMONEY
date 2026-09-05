/**
 * One command to bring both native apps up to date.
 *
 *   COMMONS_URL=https://commons.yourdomain.org npm run app:sync
 *
 * 1. `npx cap sync` — copies public/ into both projects and bakes the resolved
 *    capacitor.config (with COMMONS_URL) into each.
 * 2. Writes that server's host into ios/App/App/Info.plist as an app-bound
 *    domain. Without it WKWebView will not run the service worker, so the
 *    offline shell would silently not exist inside the iPhone app.
 * 3. Draws the icons and splash screens (scripts/app-assets.mjs).
 *
 * Then: `npm run app:android` opens Android Studio, `npm run app:ios` opens
 * Xcode. Building and signing happen there — see docs/apps.md.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', env: process.env });
  if (r.status !== 0) process.exit(r.status ?? 1);
};

// 1. sync
run(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['cap', 'sync']);

// 2. app-bound domain, from the config Capacitor actually wrote into the project
const iosConfig = `${root}ios/App/App/capacitor.config.json`;
const plist = `${root}ios/App/App/Info.plist`;
if (existsSync(iosConfig) && existsSync(plist)) {
  const { server } = JSON.parse(readFileSync(iosConfig, 'utf8'));
  const host = new URL(server.url).hostname;
  const entry = `\t<key>WKAppBoundDomains</key>\n\t<array>\n\t\t<string>${host}</string>\n\t</array>\n`;
  let xml = readFileSync(plist, 'utf8');
  xml = xml.includes('<key>WKAppBoundDomains</key>')
    ? xml.replace(/\t<key>WKAppBoundDomains<\/key>\n\t<array>[\s\S]*?<\/array>\n/, entry)
    : xml.replace('\t<key>LSRequiresIPhoneOS</key>', entry + '\t<key>LSRequiresIPhoneOS</key>');
  writeFileSync(plist, xml);
  console.log(`[app:sync] iOS app-bound domain: ${host}`);
  if (host === 'commons.example.org') {
    console.log('[app:sync] that is the placeholder — set COMMONS_URL to your real address before you build');
  }
}

// 3. assets
run(process.execPath, [`${root}scripts/app-assets.mjs`]);

console.log('\n[app:sync] done. Next: npm run app:android (Android Studio) or npm run app:ios (Xcode).');
