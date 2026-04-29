import path from "node:path";
import type { Page, Locator } from "@playwright/test";

const ROOT = path.resolve(__dirname, "../../docs/screenshots");

interface SnapOptions {
  /** Subdirectory under docs/screenshots (chapter name). */
  chapter: string;
  /** PNG filename without extension (kebab-case). */
  name: string;
  /**
   * Element to capture. Omit for full-page (page.screenshot fullPage:true).
   * Pass a locator (sheet, dialog, card) to crop to that element.
   */
  target?: Locator;
  /**
   * If true, capture the visible viewport only — useful for hero shots
   * that shouldn't include the long scroll tail. Defaults to full-page
   * for documentation completeness.
   */
  viewportOnly?: boolean;
  /**
   * Mask any locators (e.g. timestamps that change every run) with a
   * solid block so the PNG is reproducible.
   */
  mask?: Locator[];
}

/**
 * Capture one screenshot to docs/screenshots/{chapter}/{name}.png.
 *
 * Conventions:
 *   - chapter is one of: getting-started, speakers, sessions,
 *     registrations, accommodation, abstracts, finance, communications,
 *     settings, public, portals
 *   - name is kebab-case and stable across runs (so manual authors can
 *     reference it in markdown without rewriting on every refresh)
 */
export async function snap(page: Page, opts: SnapOptions): Promise<string> {
  const filePath = path.join(ROOT, opts.chapter, `${opts.name}.png`);

  // Suppress the dev-only "Compiled in X ms" toast and any Sonner toasts
  // that might be lingering from the previous interaction.
  await page.evaluate(() => {
    document.querySelectorAll('[data-sonner-toaster] li').forEach((el) => el.remove());
  });
  // Wait for any in-flight network so half-rendered cards don't leak in.
  await page.waitForLoadState("networkidle").catch(() => undefined);

  if (opts.target) {
    await opts.target.screenshot({ path: filePath, mask: opts.mask });
  } else {
    await page.screenshot({
      path: filePath,
      fullPage: !opts.viewportOnly,
      mask: opts.mask,
    });
  }
  return filePath;
}

/**
 * Mask the timestamp + duration cells of any table so screenshots are
 * deterministic. Returns the locator list (caller passes to `mask`).
 */
export function maskVolatile(page: Page): Locator[] {
  return [
    page.locator("[data-mask='timestamp']"),
    page.locator("[data-mask='duration']"),
    // Generic catchers for table cells whose content rolls over on every run
    page.locator("text=/^[0-9]+ minutes? ago/i"),
    page.locator("text=/^[0-9]+ seconds? ago/i"),
  ];
}
