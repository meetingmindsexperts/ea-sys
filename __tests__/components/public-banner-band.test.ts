import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  EventBannerBand,
  PUBLIC_BANNER_MAX_WIDTH_CLASS,
} from "@/components/public/event-banner";

/**
 * Every public page shows the branding banner through ONE band: natural
 * aspect, capped at 1400px, centred. By August 2026 the pages had drifted to
 * four different widths (1400 / 1120 / 1024 / uncapped) because each one
 * wrapped `<EventBanner>` by hand. The owner's rule (Sep 10, 2026) is one
 * width everywhere, so the wrapper moved into `EventBannerBand` and the sweep
 * below fails the day a page inlines its own wrapper again.
 */
const BAND_FILE = "src/components/public/event-banner.tsx";

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".tsx")) out.push(p);
  }
  return out;
}

const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("EventBannerBand", () => {
  const render = (props: Parameters<typeof EventBannerBand>[0]) =>
    renderToStaticMarkup(createElement(EventBannerBand, props));

  it("caps the banner at 1400px and centres it", () => {
    expect(PUBLIC_BANNER_MAX_WIDTH_CLASS).toBe("max-w-[1400px]");
    const html = render({ banner: "/uploads/banner.png", name: "Test 2026" });
    expect(html).toContain('class="max-w-[1400px] mx-auto"');
    expect(html).toContain('class="block w-full h-auto"');
    expect(html).toContain('src="/uploads/banner.png"');
    expect(html).toContain('alt="Test 2026"');
    expect(html.toLowerCase()).toContain('fetchpriority="high"');
  });

  it("renders nothing when the event has no banner", () => {
    expect(render({ banner: null, name: "Test 2026" })).toBe("");
    expect(render({ banner: "", bannerMobile: null, name: "Test 2026" })).toBe("");
  });

  it("serves the mobile banner below 576px and the desktop one above", () => {
    const html = render({
      banner: "/desktop.png",
      bannerMobile: "/mobile.png",
      name: "Test 2026",
    });
    expect(html).toContain('media="(max-width: 575.98px)"');
    expect(html).toContain('srcSet="/mobile.png"');
    expect(html).toContain('src="/desktop.png"');
  });

  it("keeps the outer strip full width and takes extra strip classes + children", () => {
    const html = render({
      banner: "/b.png",
      name: "X",
      className: "print:hidden",
      children: createElement("div", { className: "h-1 bg-gradient-primary" }),
    });
    expect(html).toContain('class="relative w-full bg-white print:hidden"');
    expect(html).toContain('class="h-1 bg-gradient-primary"');
  });
});

describe("every public page renders the banner through the band", () => {
  const root = process.cwd();
  const files = [
    ...walk(join(root, "src/app/e")),
    ...walk(join(root, "src/components/public")),
  ].filter((p) => relative(root, p) !== BAND_FILE);

  const bannerPages = files.filter((p) => /bannerImage/.test(readFileSync(p, "utf8")));

  it("finds the public pages that show a banner", () => {
    // A sanity floor so an emptied glob cannot pass vacuously.
    expect(bannerPages.length).toBeGreaterThanOrEqual(19);
  });

  it("never inlines <EventBanner> with a hand-rolled wrapper", () => {
    const offenders = bannerPages
      .filter((p) => /<EventBanner[\s>]/.test(stripComments(readFileSync(p, "utf8"))))
      .map((p) => relative(root, p));
    expect(offenders).toEqual([]);
  });

  it("imports the band wherever a banner is shown", () => {
    const missing = bannerPages
      .filter((p) => {
        const src = stripComments(readFileSync(p, "utf8"));
        // The webinar waiting room reads bannerImage as a poster, not a header;
        // it does not live under these directories, so nothing to exempt here.
        return !/EventBannerBand/.test(src);
      })
      .map((p) => relative(root, p));
    expect(missing).toEqual([]);
  });

  it("declares the width once, in the band file", () => {
    const band = stripComments(readFileSync(join(root, BAND_FILE), "utf8"));
    expect(band.match(/max-w-\[1400px\]/g)?.length).toBe(1);
    const elsewhere = files
      .filter((p) => /max-w-\[1400px\]/.test(stripComments(readFileSync(p, "utf8"))))
      .map((p) => relative(root, p));
    expect(elsewhere).toEqual([]);
  });
});
