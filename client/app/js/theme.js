// Theme loader: fetches the registry, swaps the theme stylesheet, persists
// the choice. Themes are data + a CSS file — adding one never touches code.

const STORAGE_KEY = 'cocono.theme';
const META_KEY = 'cocono.theme-meta'; // last resolved id (anti-FOUC hint)

export async function loadRegistry() {
  const res = await fetch('/themes/themes.json');
  if (!res.ok) throw new Error(`theme registry unavailable (HTTP ${res.status})`);
  const data = await res.json();
  if (!data?.themes?.length) throw new Error('theme registry is empty');
  return data;
}

export function savedTheme() {
  const url = new URL(location.href);
  return url.searchParams.get('theme') || localStorage.getItem(STORAGE_KEY) || null;
}

/** Apply a theme by id; unknown ids fall back to the registry default. */
export function applyTheme(registry, id) {
  const theme =
    registry.themes.find((t) => t.id === id) ??
    registry.themes.find((t) => t.id === registry.default) ??
    registry.themes[0];

  const link = document.getElementById('theme-link');
  link.href = `/themes/${theme.file}`;
  document.documentElement.style.colorScheme = theme.colorScheme ?? 'dark';

  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta && theme.themeColor) meta.content = theme.themeColor;

  localStorage.setItem(STORAGE_KEY, theme.id);
  return theme;
}

/** Populate a <select> with the registry and wire live switching. */
export function wireThemeSelect(selectEl, registry, currentId, onChange) {
  selectEl.textContent = '';
  for (const theme of registry.themes) {
    const opt = document.createElement('option');
    opt.value = theme.id;
    opt.textContent = `Theme: ${theme.label}`;
    opt.selected = theme.id === currentId;
    selectEl.appendChild(opt);
  }
  selectEl.onchange = () => {
    const theme = applyTheme(registry, selectEl.value);
    onChange?.(theme);
  };
}

/** Bootstrap: returns the applied theme (or null on hard failure). */
export async function initTheme() {
  try {
    const registry = await loadRegistry();
    const theme = applyTheme(registry, savedTheme() ?? registry.default);
    return { registry, theme };
  } catch (err) {
    // Static fallback already linked in index.html (dark) — keep running.
    console.warn('[cocono-app] theme bootstrap failed, using default link:', err);
    return { registry: null, theme: null };
  }
}
