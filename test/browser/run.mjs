/**
 * One command for every browser suite.
 *
 * Starts an in-memory Commons on a free port, seeds it with a day of activity
 * through the public API, runs the interface, install and cinematic checks
 * against it, and stops it. Exit code is non-zero if any suite fails, so this
 * is what CI runs and what `npm run test:all` ends with.
 *
 *   npm run test:e2e
 *
 * Needs a Chromium: `npx playwright install chromium` once, or set CHROMIUM to
 * an existing binary. Nothing here needs the network.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import webpush from 'web-push';

const root = fileURLToPath(new URL('../..', import.meta.url));
const NODE = process.execPath;

/** Ask the OS for a port nobody is using. */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function waitFor(url, ms = 20_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`server did not answer at ${url} within ${ms} ms`);
}

/** Run a script to completion, streaming its output; resolve with the exit code. */
function run(script, env) {
  return new Promise((resolve) => {
    const child = spawn(NODE, [script], { cwd: root, env: { ...process.env, ...env }, stdio: 'inherit' });
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

const port = await freePort();
const BASE = `http://127.0.0.1:${port}`;
console.log(`\n▶ starting Commons in memory on ${BASE}`);
const server = spawn(NODE, ['--experimental-strip-types', 'src/server.ts'], {
  cwd: root,
  env: {
    ...process.env,
    PORT: String(port),
    COMMUNITY_DATA: ':memory:',
    COMMUNITY_SIGNUPS_PER_HOUR: '1000',
    COMMUNITY_MODERATORS: 'commonsmod',
    LOG_LEVEL: 'warn',
    NODE_ENV: 'test',
    // Push is on, with a throwaway pair, so the notifications card renders its real states.
    ...(() => { const k = webpush.generateVAPIDKeys(); return { VAPID_PUBLIC_KEY: k.publicKey, VAPID_PRIVATE_KEY: k.privateKey, VAPID_SUBJECT: 'mailto:test@example.test' }; })(),
  },
  stdio: ['ignore', 'inherit', 'inherit'],
});
server.on('exit', (code) => { if (code !== null && code !== 0 && !stopping) { console.error(`server exited with ${code}`); process.exit(1); } });
let stopping = false;

const results = {};
try {
  await waitFor(`${BASE}/api/community/health`);
  console.log('▶ seeding a day of activity');
  const seeded = await run('scripts/seed-demo.mjs', { BASE });
  if (seeded !== 0) throw new Error('seeding failed');

  for (const [name, script] of [
    ['interface', 'test/browser/commons.ui.mjs'],
    ['install', 'test/browser/pwa.mjs'],
    ['cinematic', 'test/browser/cinematic.mjs'],
  ]) {
    console.log(`\n▶ ${name}: ${script}`);
    results[name] = await run(script, { BASE });
  }
} catch (error) {
  console.error(`\n${error.message}`);
  results.harness = 1;
} finally {
  stopping = true;
  server.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 300));
  if (server.exitCode === null) server.kill('SIGKILL');
}

const failed = Object.entries(results).filter(([, code]) => code !== 0).map(([n]) => n);
console.log(`\n${failed.length ? `FAILED: ${failed.join(', ')}` : 'ALL BROWSER SUITES PASSED'}`);
process.exit(failed.length ? 1 : 0);
