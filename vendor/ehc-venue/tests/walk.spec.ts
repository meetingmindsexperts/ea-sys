/**
 * EA-SYS (venue hardening step 1, Oct 26, 2026): the venue's walking checks, in CI.
 *
 * The same checks as tests/test_layout.py, which needs Python Playwright and so never ran in CI: each layout
 * in tests/fixtures/layouts/ (written by `npm run venue:fixtures`) is loaded into the built test page as
 * window.EHC_LAYOUT and walked by tests/layout_verify.js: a random walk, pushing into every wall, every
 * doorway, every room-to-room route on each floor, the camera, and every hotspot, stairs and lifts included.
 * The page and its files are served from disk through request routing, so no server is needed.
 *
 *   npm run venue:build && npm run venue:walk
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";

const TESTS = __dirname;
const DIST = path.join(TESTS, "..", "dist");
const LAYOUTS = path.join(TESTS, "fixtures", "layouts");
const ORIGIN = "http://venue.test";

const MOCK = readFileSync(path.join(TESTS, "mock.js"), "utf8");
const VERIFY = readFileSync(path.join(TESTS, "layout_verify.js"), "utf8");
const TYPES: Record<string, string> = { ".html": "text/html", ".json": "application/json" };

interface Report {
  randomWalk: { penetrationViolations: number; outOfBounds: number; belowFloor: number };
  wallPush: { wallsCrossed: number };
  doors: { tested: number; failed: string[] };
  walkAllPairs: { failed: string[] };
  camera: { lensInsideGeometry: number; lensOutsideVenue: number; lensAboveCeiling: number };
  hotspots: { count: number; failed: string[] };
}

for (const file of readdirSync(LAYOUTS).filter((f) => f.endsWith(".json")).sort()) {
  const name = file.replace(/\.json$/, "");
  test(`walks ${name}`, async ({ page }) => {
    const layoutText = readFileSync(path.join(LAYOUTS, file), "utf8");
    const layout = JSON.parse(layoutText) as { zones: { id: string; name: string; kind: string }[] };
    // Errors only, as the Python test did: SwiftShader also warns about GPU stalls, which say nothing about a layout.
    const errors: string[] = [];
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      // Fonts come from Google and the app's /venue-fonts/ in production; the checks need neither.
      if (url.origin !== ORIGIN || url.pathname.startsWith("/venue-fonts/")) return route.fulfill({ status: 200, body: "", contentType: "text/css" });
      const local = path.join(DIST, path.normalize(url.pathname).replace(/^\/+/, ""));
      if (!local.startsWith(DIST)) return route.fulfill({ status: 404, body: "" });
      try {
        return await route.fulfill({ status: 200, body: readFileSync(local), contentType: TYPES[path.extname(local)] ?? "text/plain" });
      } catch {
        return route.fulfill({ status: 404, body: "" });
      }
    });
    await page.addInitScript(`window.EHC_LAYOUT=${layoutText};window.__MOCKCFG={sample:"ok",room:true,owner:true};${MOCK}`);
    await page.goto(`${ORIGIN}/test.html`);
    await page.waitForFunction(() => (window as unknown as { __EHC?: { ready: boolean } }).__EHC?.ready, undefined, { timeout: 60_000 });

    // The start sheet names this venue's own rooms, not EHC's ballroom.
    const intro = await page.evaluate(() => document.getElementById("startIntro")?.textContent ?? "");
    for (const z of layout.zones.filter((zone) => zone.kind !== "corridor")) expect(intro).toContain(z.name);
    expect(intro).not.toContain("ballroom");
    const zoneIds = await page.evaluate(() => (window as unknown as { __EHC: { ZONES: { id: string }[] } }).__EHC.ZONES.map((z) => z.id));
    expect(zoneIds).toEqual(layout.zones.map((z) => z.id));

    await page.evaluate(() => (window as unknown as { __EHC: { enter: () => void } }).__EHC.enter());
    await page.waitForTimeout(300);
    const rep = JSON.parse(await page.evaluate(VERIFY)) as Report;

    expect(rep.randomWalk, "random walk").toMatchObject({ penetrationViolations: 0, outOfBounds: 0, belowFloor: 0 });
    expect(rep.wallPush.wallsCrossed, "walls crossed").toBe(0);
    expect(rep.doors.failed, "doorways").toEqual([]);
    expect(rep.walkAllPairs.failed, "walk me there").toEqual([]);
    expect(rep.camera, "camera").toMatchObject({ lensInsideGeometry: 0, lensOutsideVenue: 0, lensAboveCeiling: 0 });
    expect(rep.hotspots.failed, "hotspots").toEqual([]);
    expect(errors, "console errors").toEqual([]);
  });
}
