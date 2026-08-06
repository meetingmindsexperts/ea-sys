"use client";

import { useEffect } from "react";
import { useOrgBranding } from "@/hooks/use-api";
import { hexToOklchComponents, buildPalette, isBrandHex } from "@/lib/org-color";

/**
 * Applies the organization's brand color as CSS custom property overrides
 * across the entire dashboard — primary, secondary, muted, border, sidebar,
 * gradients, and charts all shift to the brand hue.
 *
 * The colour maths + palette live in `@/lib/org-color`, shared with the
 * public `/e/[slug]` layout so the two surfaces can't derive different
 * colours from the same hex. Public pages apply a NARROWER subset — see
 * `buildBrandPalette` for why.
 */
export function OrgTheme() {
  const { data: branding } = useOrgBranding();
  const primaryColor = branding?.primaryColor;

  useEffect(() => {
    const root = document.documentElement;
    const vars: string[] = [];

    if (isBrandHex(primaryColor)) {
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
