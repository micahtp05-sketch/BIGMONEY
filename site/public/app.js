// Theme toggle. The initial theme is applied by the inline script in <head>
// so the page never paints in the wrong palette first.

const STORAGE_KEY = 'theme';

function stored() {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null; // Private mode, blocked site data — fall back to system.
  }
}

function systemTheme() {
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function currentTheme() {
  return document.documentElement.dataset.theme || systemTheme();
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // Nothing to do — the choice just won't survive a reload.
  }
  for (const button of document.querySelectorAll('[data-theme-toggle]')) {
    button.setAttribute('aria-label', `Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`);
    button.textContent = theme === 'dark' ? '☀' : '☾';
  }
}

document.addEventListener('DOMContentLoaded', () => {
  applyTheme(currentTheme());

  for (const button of document.querySelectorAll('[data-theme-toggle]')) {
    button.addEventListener('click', () => {
      applyTheme(currentTheme() === 'dark' ? 'light' : 'dark');
    });
  }

  // Follow the system while the visitor hasn't made an explicit choice.
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (event) => {
    if (!stored()) applyTheme(event.matches ? 'dark' : 'light');
  });

  // Mark the current page in the nav.
  const here = location.pathname.replace(/\/index\.html$|\.html$/, '') || '/';
  for (const link of document.querySelectorAll('.nav a')) {
    const target = new URL(link.href).pathname.replace(/\/index\.html$|\.html$/, '') || '/';
    if (target === here) link.setAttribute('aria-current', 'page');
  }
});
