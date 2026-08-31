/**
 * Commons desktop shell (Electron) — macOS and Windows.
 *
 * Commons is a community, so the desktop app is a window onto a shared server,
 * not a copy of one. Running the server inside the app would give every person
 * their own empty private community, which is the opposite of the point.
 *
 * So on first run it asks which Commons to join, remembers the answer, and
 * from then on opens straight into it.
 *
 * NOT BUILT OR RUN in the container this was written in — no Electron binary,
 * no macOS or Windows machine. Treat it as a reviewed starting point, not a
 * shipped app. See docs/apps.md.
 */
const { app, BrowserWindow, shell, dialog, Menu } = require('electron');
const { readFileSync, writeFileSync, mkdirSync } = require('node:fs');
const { join, dirname } = require('node:path');

const CONFIG = join(app.getPath('userData'), 'commons.json');

function readConfig() {
  try {
    return JSON.parse(readFileSync(CONFIG, 'utf8'));
  } catch {
    return {};
  }
}

function writeConfig(config) {
  mkdirSync(dirname(CONFIG), { recursive: true });
  writeFileSync(CONFIG, JSON.stringify(config, null, 2));
}

/** Only http(s), and never a file:// or app-internal scheme. */
function validServerUrl(raw) {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : null;
  } catch {
    return null;
  }
}

async function chooseServer(parent) {
  const fromEnv = validServerUrl(process.env.COMMONS_URL ?? '');
  if (fromEnv) return fromEnv;

  // A minimal, keyboard-reachable prompt. Electron has no text-input dialog,
  // so this is a tiny local page rather than a native box.
  const win = new BrowserWindow({
    width: 460, height: 260, parent, modal: Boolean(parent), resizable: false,
    webPreferences: { preload: join(__dirname, 'setup-preload.js') },
  });
  await win.loadFile(join(__dirname, 'setup.html'));
  return new Promise((resolve) => {
    const { ipcMain } = require('electron');
    ipcMain.once('commons:server', (_event, value) => {
      const origin = validServerUrl(value);
      win.close();
      resolve(origin);
    });
    win.on('closed', () => resolve(null));
  });
}

function createWindow(origin) {
  const win = new BrowserWindow({
    width: 1100,
    height: 820,
    minWidth: 380,
    backgroundColor: '#F5F5F2',
    title: 'Commons',
    webPreferences: {
      // The remote page gets no Node access whatsoever.
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  win.loadURL(origin);

  // Links to anywhere else open in the real browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(origin)) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  win.webContents.on('did-fail-load', (_e, code, description) => {
    dialog.showErrorBox('Cannot reach Commons', `${description} (${code})\n\n${origin}`);
  });

  return win;
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    { role: 'editMenu' },
    {
      label: 'Commons',
      submenu: [
        { role: 'reload' },
        { type: 'separator' },
        {
          label: 'Change server…',
          click: async () => {
            const origin = await chooseServer(BrowserWindow.getFocusedWindow());
            if (!origin) return;
            writeConfig({ ...readConfig(), server: origin });
            BrowserWindow.getAllWindows().forEach((w) => w.close());
            createWindow(origin);
          },
        },
      ],
    },
    { role: 'windowMenu' },
  ]));

  const config = readConfig();
  const origin = validServerUrl(config.server ?? '') ?? await chooseServer(null);
  if (!origin) return app.quit();
  writeConfig({ ...config, server: origin });
  createWindow(origin);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(origin);
  });
});

// On Windows and Linux, closing the last window closes the app. macOS does not.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
