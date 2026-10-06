# Themes

The app bootstraps its theme at runtime by swapping stylesheet links — no
rebuild, no bundler, CSP-safe (`style-src 'self'`).

## How it works

- `css/base.css` owns ALL structure and defines the default design tokens
  (CSS custom properties on `:root`).
- A theme file re-defines **only** those custom properties.
- `themes/themes.json` is the registry; `js/theme.js` loads the selected
  theme's stylesheet into `<link id="theme-link">`, persists the choice in
  `localStorage` (`cocono.theme`) and syncs the `theme-color` meta tag.
- Selection priority: `?theme=<id>` query param → saved choice → registry
  `default`.

## Adding a theme

1. Create `themes/<id>/theme.css` and override tokens, e.g.:

   ```css
   :root {
     color-scheme: light;
     --bg: #efeae2; --panel: #ffffff; --panel-raised: #f0f2f5;
     --text: #111b21; --muted: #667781;
     --accent: #00a884; --bubble-out: #d9fdd3; --bubble-text: #111b21;
   }
   ```

2. Add an entry to `themes/themes.json`:

   ```json
   { "id": "light", "label": "Light", "file": "light/theme.css",
     "colorScheme": "light", "themeColor": "#efeae2" }
   ```

3. Open `/?theme=light` to try it, then pick it in Settings → Theme.

## Token reference

| Token | Used for |
| ----- | -------- |
| `--bg` | app backdrop / chat wallpaper |
| `--panel` | sidebar, headers, composer, cards |
| `--panel-raised` | inputs, hover states, incoming bubbles |
| `--border` / `--divider` | separators |
| `--text` / `--muted` | primary / secondary text |
| `--accent` / `--accent-strong` / `--on-accent` | brand + buttons |
| `--bubble-in` / `--bubble-out` / `--bubble-text` | message bubbles |
| `--danger` / `--success` / `--warning` | status colors |
| `--dot-off/on/busy` | connection indicator |
| `--overlay` | settings drawer scrim |
| `--shadow` / `--radius-bubble` | elevation / radii |
