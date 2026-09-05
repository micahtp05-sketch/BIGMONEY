import type { CapacitorConfig } from '@capacitor/cli';

/**
 * The native apps are windows onto one shared Commons, not a copy each.
 *
 * Running the server inside the app would give every person their own empty
 * private community, which is the opposite of the point. So the iPhone and
 * Android apps load the Commons you deployed, in a native shell, with the web
 * assets bundled for first paint. Set COMMONS_URL when you sync and it is
 * baked into both projects:
 *
 *   COMMONS_URL=https://commons.yourdomain.org npm run app:sync
 *
 * An http:// address (a laptop on the same wifi while developing) is allowed
 * and turns cleartext on for that build only. Never ship one.
 */
const url = (process.env.COMMONS_URL ?? 'https://commons.example.org').replace(/\/$/, '');
const cleartext = url.startsWith('http://');
const NIGHT = '#080D16';

const config: CapacitorConfig = {
  appId: 'org.commons.app',
  appName: 'Commons',
  webDir: 'public',
  server: { url, androidScheme: 'https', iosScheme: 'https', cleartext },
  ios: {
    contentInset: 'always',
    backgroundColor: NIGHT,
    // Service workers inside the app (the offline shell) need the domain to be
    // app-bound: `npm run app:sync` writes it into ios/App/App/Info.plist.
    limitsNavigationsToAppBoundDomains: true,
  },
  android: { allowMixedContent: false, backgroundColor: NIGHT },
  plugins: {
    SplashScreen: { backgroundColor: `${NIGHT}FF`, launchAutoHide: true, launchShowDuration: 600 },
    // "DARK" is the dark *background* style: light text on the night header.
    StatusBar: { style: 'DARK', backgroundColor: NIGHT },
  },
};

export default config;
