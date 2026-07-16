// Light/dark theme toggle. Follows the OS preference until the user picks a
// theme explicitly (only then is a choice persisted to this device). Pure
// CSS-variable switch — no reload needed (unlike the language toggle, which
// re-renders text).
const KEY = 'aero_theme';

export function currentTheme() {
  return document.documentElement.getAttribute('data-theme') || 'dark';
}

// Mirrors app.css's --bg values, for the PWA's browser-chrome color only.
const BG = { light: '#f5f7fb', dark: '#0c1220' };

// Applies a theme to the DOM/meta without persisting it — used at boot so an
// unvisited OS-preference page load never "locks in" a choice the user didn't
// make (a later OS-level light/dark switch should keep being honored).
function applyTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  const btn = document.getElementById('themeToggleBtn');
  if (btn) btn.innerHTML = iconFor(t === 'dark' ? 'light' : 'dark');
  const meta = document.getElementById('themeColorMeta');
  if (meta) meta.setAttribute('content', BG[t] || BG.dark);
}

// User-driven choice: persists to this device and applies immediately.
export function setTheme(t) {
  localStorage.setItem(KEY, t);
  applyTheme(t);
}

const SUN = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
  stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <circle cx="12" cy="12" r="4"/>
  <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/>
</svg>`;
const MOON = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
  stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
</svg>`;
// Button shows the icon of the mode it will SWITCH TO.
const iconFor = target => (target === 'dark' ? MOON : SUN);

// Call once at boot. The inline bootstrap script in each HTML file already
// sets the data-theme attribute before first paint (to avoid a flash); this
// just syncs the meta theme-color tag and toggle icon to match, and acts as
// the fallback if that script somehow didn't run. Deliberately does NOT
// write to localStorage — only setTheme() (user action) does that.
export function initTheme() {
  const saved = localStorage.getItem(KEY);
  const resolved = document.documentElement.getAttribute('data-theme')
    || saved || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  applyTheme(resolved);
}

// Mount a small icon button that flips the theme. Safe to call repeatedly
// (e.g. once per render pass) — it just recreates the button each time.
export function themeToggle(parent) {
  if (!parent) return null;
  const btn = document.createElement('button');
  btn.id = 'themeToggleBtn';
  btn.className = 'icon-btn';
  btn.type = 'button';
  btn.title = 'Toggle light / dark theme';
  btn.setAttribute('aria-label', 'Toggle light / dark theme');
  btn.innerHTML = iconFor(currentTheme() === 'dark' ? 'light' : 'dark');
  btn.onclick = () => setTheme(currentTheme() === 'dark' ? 'light' : 'dark');
  parent.appendChild(btn);
  return btn;
}
