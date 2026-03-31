"use client";

import { useEffect } from "react";
import { useSession } from "next-auth/react";

/**
 * Converts a hex color (#rrggbb) to an oklch CSS value.
 * Uses a simplified sRGB→OKLCH conversion that's good enough for theming.
 */
function hexToOklch(hex: string): string {
  // Parse hex
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;

  // sRGB to linear
  const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  const lr = toLinear(r);
  const lg = toLinear(g);
  const lb = toLinear(b);

  // Linear sRGB to OKLab (via LMS)
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

  return `oklch(${L.toFixed(3)} ${C.toFixed(3)} ${H.toFixed(1)})`;
}

/**
 * Applies the organization's primary color as CSS custom property overrides.
 * This makes all existing Tailwind `bg-primary`, `text-primary`, etc. use the org color.
 */
export function OrgTheme() {
  const { data: session } = useSession();
  const primaryColor = session?.user?.organizationPrimaryColor;

  useEffect(() => {
    const root = document.documentElement;

    if (primaryColor && /^#[0-9a-fA-F]{6}$/.test(primaryColor)) {
      const oklch = hexToOklch(primaryColor);
      root.style.setProperty("--primary", oklch);
      root.style.setProperty("--ring", oklch);
    } else {
      // Reset to stylesheet defaults
      root.style.removeProperty("--primary");
      root.style.removeProperty("--ring");
    }

    return () => {
      root.style.removeProperty("--primary");
      root.style.removeProperty("--ring");
    };
  }, [primaryColor]);

  return null;
}
