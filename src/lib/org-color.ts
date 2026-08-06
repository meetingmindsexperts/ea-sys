/**
 * Organisation brand colour → CSS custom properties.
 *
 * Pure maths + palette construction, deliberately framework-free so BOTH
 * consumers share one implementation (the no-cross-caller-duplication rule):
 *   - the dashboard's client-side `OrgTheme`, which paints the full app chrome
 *   - the public `/e/[slug]` layout, which server-renders a brand-only subset
 *
 * They intentionally apply DIFFERENT subsets — see `buildBrandPalette`.
 */

/** Converts a hex colour (#rrggbb) to oklch components { L, C, H }. */
export function hexToOklchComponents(hex: string): { L: number; C: number; H: number } {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;

  const toLinear = (c: number) =>
    c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  const lr = toLinear(r);
  const lg = toLinear(g);
  const lb = toLinear(b);

  const l_ = 0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb;
  const m_ = 0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb;
  const s_ = 0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb;

  const l = Math.cbrt(l_);
  const m = Math.cbrt(m_);
  const s = Math.cbrt(s_);

  const L = 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s;
  const a = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s;
  const bOk = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s;

  const C = Math.sqrt(a * a + bOk * bOk);
  let H = (Math.atan2(bOk, a) * 180) / Math.PI;
  if (H < 0) H += 360;

  return { L, C, H };
}

export function oklch(L: number, C: number, H: number): string {
  return `oklch(${L.toFixed(3)} ${C.toFixed(3)} ${H.toFixed(1)})`;
}

/** A 6-digit hex colour is the only shape we'll act on. */
export const isBrandHex = (value: string | null | undefined): value is string =>
  !!value && /^#[0-9a-fA-F]{6}$/.test(value);

/**
 * FULL palette — dashboard only. Shifts backgrounds, borders, sidebar and
 * charts to the brand hue, which suits an app shell the operator lives in.
 */
export function buildPalette(L: number, C: number, H: number): Record<string, string> {
  return {
    "--primary": oklch(L, C, H),
    "--primary-foreground": oklch(1, 0, 0),
    "--ring": oklch(L, C, H),

    "--secondary": oklch(0.95, 0.015, H),
    "--secondary-foreground": oklch(0.25, 0.02, H),

    "--muted": oklch(0.96, 0.01, H),
    "--muted-foreground": oklch(0.5, 0.02, H),

    "--background": oklch(0.99, 0.002, H),
    "--foreground": oklch(0.2, 0.02, H),
    "--card-foreground": oklch(0.2, 0.02, H),
    "--popover-foreground": oklch(0.2, 0.02, H),

    "--border": oklch(0.9, 0.015, H),
    "--input": oklch(0.92, 0.01, H),

    "--sidebar": oklch(0.98, 0.005, H),
    "--sidebar-foreground": oklch(0.2, 0.02, H),
    "--sidebar-primary": oklch(L, C, H),
    "--sidebar-primary-foreground": oklch(1, 0, 0),
    "--sidebar-accent": oklch(0.94, 0.02, H),
    "--sidebar-accent-foreground": oklch(0.25, 0.02, H),
    "--sidebar-border": oklch(0.9, 0.015, H),
    "--sidebar-ring": oklch(L, C, H),

    "--gradient-start": oklch(L, C, H),
    "--gradient-end": oklch(L - 0.1, C - 0.025, H),

    "--chart-1": oklch(L, C, H),
    "--chart-2": oklch(0.75, 0.12, H),
    "--chart-4": oklch(0.55, 0.14, H),
  };
}

/**
 * BRAND-ONLY palette — public `/e/[slug]` pages.
 *
 * Deliberately narrower than the dashboard's. Public pages are read by
 * attendees, sponsors and finance departments on a white page, and tinting
 * `--background` / `--foreground` / `--border` to the brand hue would restyle
 * every card, table and rule on a surface where legibility matters more than
 * branding. So only the things that genuinely CARRY the brand move: buttons,
 * links, focus rings and gradients. `--accent` (the amber) is untouched — it's
 * a deliberate second colour, not the brand hue.
 *
 * `--muted-foreground` is included at very low chroma because it is the colour
 * of most secondary copy on those pages; leaving it neutral against a shifted
 * primary reads as an accident rather than a palette.
 */
export function buildBrandPalette(L: number, C: number, H: number): Record<string, string> {
  return {
    "--primary": oklch(L, C, H),
    "--primary-foreground": oklch(1, 0, 0),
    "--ring": oklch(L, C, H),
    "--secondary": oklch(0.95, 0.015, H),
    "--secondary-foreground": oklch(0.25, 0.02, H),
    "--muted-foreground": oklch(0.5, 0.02, H),
    "--gradient-start": oklch(L, C, H),
    "--gradient-end": oklch(L - 0.1, C - 0.025, H),
    // Convenience handles for pages that want the raw brand colour (tints,
    // custom accents) without re-deriving it.
    "--org": oklch(L, C, H),
    "--org-tint": oklch(0.96, Math.min(C, 0.04), H),
    "--org-edge": oklch(0.88, Math.min(C, 0.07), H),
  };
}

/** `:root { … }` CSS text for a brand colour, or "" when there's none/invalid. */
export function brandPaletteCss(primaryColor: string | null | undefined): string {
  if (!isBrandHex(primaryColor)) return "";
  const { L, C, H } = hexToOklchComponents(primaryColor);
  const decls = Object.entries(buildBrandPalette(L, C, H))
    .map(([prop, value]) => `${prop}:${value};`)
    .join("");
  return `:root{${decls}}`;
}
