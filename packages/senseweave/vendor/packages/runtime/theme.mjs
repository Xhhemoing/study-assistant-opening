/**
 * Map a host's few brand colours onto every --sw-* token, so an embedded block matches the host
 * without the host learning 30 token names. Returns plain CSS custom properties.
 */
export function themeTokens({accent, ink, muted, line, paper, soft, font} = {}) {
  const color = v =>
    typeof v === 'string' &&
    /^(#[0-9a-f]{3,8}|rgba?\([\d\s.,%]+\)|hsla?\([\d\s.,%deg]+\)|var\(--[\w-]+\)|[a-z]+)$/i.test(
      v.trim()
    )
      ? v.trim()
      : null;
  const t = {};
  const a = color(accent),
    i = color(ink),
    m = color(muted),
    l = color(line),
    p = color(paper),
    s = color(soft);
  const mix = (x, y, pct) => `color-mix(in srgb, ${x} ${pct}%, ${y})`;
  if (a)
    Object.assign(t, {
      '--sw-accent': a,
      '--sw-focus': a,
      '--sw-positive': a,
      '--sw-vector-1': a,
      '--sw-shape-fill': p ? mix(a, p, 35) : a
    });
  if (i) Object.assign(t, {'--sw-ink': i, '--sw-figure-ink': i, '--sw-summary': m ?? i});
  if (m) Object.assign(t, {'--sw-muted': m, '--sw-axis': m, '--sw-muted-line': m});
  if (l) Object.assign(t, {'--sw-line': l, '--sw-grid': l, '--sw-node-line': m ?? l});
  if (p) Object.assign(t, {'--sw-paper': p, '--sw-figure-bg': s ?? p});
  if (s) Object.assign(t, {'--sw-soft': s, '--sw-code-bg': s});
  if (typeof font === 'string' && font.length <= 300 && !/[;{}<>]/.test(font))
    t['--sw-font'] = font;
  return t;
}
