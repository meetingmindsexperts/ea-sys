"use client";

import { useEffect } from "react";
import { useOrgBranding } from "@/hooks/use-api";

/**
 * Converts a hex color (#rrggbb) to oklch components { L, C, H }.
 */
function hexToOklchComponents(hex: string): { L: number; C: number; H: number } {
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

function oklch(L: number, C: number, H: number): string {
  return `oklch(${L.toFixed(3)} ${C.toFixed(3)} ${H.toFixed(1)})`;
}

/**
 * All CSS variables that use the brand hue. Derived from globals.css :root.
 * Each entry maps a CSS variable name to an oklch(L, C) pair — the hue comes
 * from the org's brand color.
 */
function buildPalette(L: number, C: number, H: number): Record<string, string> {
  return {
    // Core primary
    "--primary": oklch(L, C, H),
    "--primary-foreground": oklch(1, 0, 0),
    "--ring": oklch(L, C, H),

    // Secondary (very light tint of brand)
    "--secondary": oklch(0.95, 0.015, H),
    "--secondary-foreground": oklch(0.25, 0.02, H),

    // Muted (subtle brand tint)
    "--muted": oklch(0.96, 0.01, H),
    "--muted-foreground": oklch(0.5, 0.02, H),

    // Background tints
    "--background": oklch(0.99, 0.002, H),
    "--foreground": oklch(0.2, 0.02, H),
    "--card-foreground": oklch(0.2, 0.02, H),
    "--popover-foreground": oklch(0.2, 0.02, H),

    // Border & input
    "--border": oklch(0.9, 0.015, H),
    "--input": oklch(0.92, 0.01, H),

    // Sidebar
    "--sidebar": oklch(0.98, 0.005, H),
    "--sidebar-foreground": oklch(0.2, 0.02, H),
    "--sidebar-primary": oklch(L, C, H),
    "--sidebar-primary-foreground": oklch(1, 0, 0),
    "--sidebar-accent": oklch(0.94, 0.02, H),
    "--sidebar-accent-foreground": oklch(0.25, 0.02, H),
    "--sidebar-border": oklch(0.9, 0.015, H),
    "--sidebar-ring": oklch(L, C, H),

    // Gradients
    "--gradient-start": oklch(L, C, H),
    "--gradient-end": oklch(L - 0.1, C - 0.025, H),

    // Charts (brand-tinted)
    "--chart-1": oklch(L, C, H),
    "--chart-2": oklch(0.75, 0.12, H),
    "--chart-4": oklch(0.55, 0.14, H),
  };
}

/**
 * Applies the organization's brand color as CSS custom property overrides
 * across the entire dashboard — primary, secondary, muted, border, sidebar,
 * gradients, and charts all shift to the brand hue.
 */
export function OrgTheme() {
  const { data: branding } = useOrgBranding();
  const primaryColor = branding?.primaryColor;

  useEffect(() => {
    const root = document.documentElement;
    const vars: string[] = [];

    if (primaryColor && /^#[0-9a-fA-F]{6}$/.test(primaryColor)) {
      const { L, C, H } = hexToOklchComponents(primaryColor);
      const palette = buildPalette(L, C, H);

      for (const [prop, value] of Object.entries(palette)) {
        root.style.setProperty(prop, value);
        vars.push(prop);
      }
    }

    return () => {
      // On cleanup or when color changes, remove all overrides
      for (const prop of vars) {
        root.style.removeProperty(prop);
      }
    };
  }, [primaryColor]);

  return null;
}
