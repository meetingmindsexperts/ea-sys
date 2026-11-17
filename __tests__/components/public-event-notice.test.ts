import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  PublicEventBrandingProvider,
  PublicEventNotice,
  type PublicEventNoticeProps,
} from "@/components/public/event-notice";
import type { PublicEventBranding } from "@/lib/public-event-branding";

/**
 * A public event page that has only a message to show keeps the event's frame
 * (Nov 17, 2026, owner: "if agenda is not live, can we show the event branding
 * header and footer"). About twenty pages each rendered their own bare card on
 * a blank screen; they now share `PublicEventNotice`, and the sweep at the
 * bottom fails the day a page writes its own again.
 */
const BRANDING: PublicEventBranding = {
  name: "Heart Failure 2027",
  startDate: "2027-01-15T05:00:00.000Z",
  endDate: "2027-01-17T14:00:00.000Z",
  timezone: "Asia/Dubai",
  venue: "Raffles Hotel",
  city: "Dubai",
  country: "United Arab Emirates",
  bannerImage: "/uploads/banner.jpg",
  bannerImageMobile: "/uploads/banner-mobile.jpg",
  footerHtml: '<p>Organised by <a href="https://example.com">us</a></p>',
  supportEmail: "help@example.com",
};

function render(props: PublicEventNoticeProps, branding: PublicEventBranding | null) {
  return renderToStaticMarkup(
    createElement(PublicEventBrandingProvider, { branding, children: createElement(PublicEventNotice, props) }),
  );
}

describe("PublicEventNotice", () => {
  it("frames the message with the event's banner, name, dates, place and footer", () => {
    const html = render({ title: "Agenda not live yet", description: "Please check back later." }, BRANDING);
    expect(html).toContain('src="/uploads/banner.jpg"');
    expect(html).toContain('srcSet="/uploads/banner-mobile.jpg"');
    expect(html).toContain("Heart Failure 2027");
    expect(html).toContain("January 15 – 17, 2027");
    expect(html).toContain("Raffles Hotel, Dubai, United Arab Emirates");
    expect(html).toContain("<h1");
    expect(html).toContain("Agenda not live yet");
    expect(html).toContain("Please check back later.");
    expect(html).toContain("Organised by");
    // Header first, footer last: the message sits between them.
    expect(html.indexOf("banner.jpg")).toBeLessThan(html.indexOf("Agenda not live yet"));
    expect(html.indexOf("Agenda not live yet")).toBeLessThan(html.indexOf("Organised by"));
  });

  it("stands alone on the brand stripe when there is no branding to show", () => {
    const html = render({ title: "Event not found" }, null);
    expect(html).toContain("Event not found");
    expect(html).toContain("bg-gradient-primary");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("prose");
  });

  it("uses the stripe for an event with no banner, and still names it", () => {
    const html = render({ title: "Registration Closed" }, { ...BRANDING, bannerImage: null, bannerImageMobile: null });
    expect(html).not.toContain("<img");
    expect(html).toContain("bg-gradient-primary");
    expect(html).toContain("Heart Failure 2027");
  });

  it("prefers the event the page loaded over the layout's", () => {
    const html = render(
      { title: "Registration Closed", event: { name: "Loaded By The Page", bannerImage: "/uploads/own.jpg" } },
      BRANDING,
    );
    expect(html).toContain("Loaded By The Page");
    expect(html).toContain('src="/uploads/own.jpg"');
    expect(html).not.toContain("Heart Failure 2027");
  });

  it("sanitises the footer: it is the organiser's HTML on a page anyone can open", () => {
    const html = render(
      { title: "X" },
      { ...BRANDING, footerHtml: '<p>Fine</p><script>alert(1)</script><img src=x onerror="alert(2)">' },
    );
    expect(html).toContain("Fine");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("onerror");
  });

  // /e/{slug}/register for an event that has ended: the form's API answers
  // "no such event" while the layout holds the event's branding.
  it("does not say 'Event not found' under the event's own banner", () => {
    const html = render({ title: "Event not found", tone: "error", missingEvent: true }, BRANDING);
    expect(html).not.toContain("Event not found");
    expect(html).toContain("This page is not available");
    expect(html).toContain("This part of Heart Failure 2027 is not open at the moment");
    expect(html).toContain('src="/uploads/banner.jpg"');
  });

  it("says 'Event not found' when there really is no event to show", () => {
    const html = render({ title: "Event not found", tone: "error", missingEvent: true }, null);
    expect(html).toContain("Event not found");
    expect(html).not.toContain("This page is not available");
  });

  it("keeps the page's own way out on a closed part of an event", () => {
    const html = render(
      { title: "Event not found", missingEvent: true, children: createElement("a", { href: "/login" }, "Back to sign in") },
      BRANDING,
    );
    expect(html).toContain("This page is not available");
    expect(html).toContain("Back to sign in");
  });

  it("renders the page's own links and buttons under the message", () => {
    const html = render(
      { title: "X", children: createElement("a", { href: "/e/demo" }, "Back to event") },
      BRANDING,
    );
    expect(html).toContain('href="/e/demo"');
    expect(html.indexOf("<h1")).toBeLessThan(html.indexOf("Back to event"));
  });
});

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".tsx")) out.push(p);
  }
  return out;
}

describe("no public event page writes its own full-page message", () => {
  const root = process.cwd();

  /**
   * A full-page card is a `min-h-screen` box that centres its content AND pads
   * it. The padding is what tells it from a loading spinner, which centres a
   * bare icon and is left alone.
   */
  const FULL_PAGE_CARD = /className="[^"]*\bmin-h-screen\b[^"]*"/g;
  const isCard = (cls: string) => /\bjustify-center\b/.test(cls) && /\bp[xy]?-\d/.test(cls);

  /** Deliberate, with the reason. Adding a line here is a decision, not a fix. */
  const ALLOWED: Record<string, string> = {
    "src/app/e/error.tsx": "the boundary ABOVE the [slug] layout: the branding provider is gone by then",
    "src/app/e/[slug]/complete-registration/page.tsx":
      "TabletHandBack, the desk tablet's own 'registration complete' screen with the event in its header",
    "src/components/public/event-notice.tsx": "the notice itself",
  };

  const offenders = [...walk(join(root, "src/app/e")), ...walk(join(root, "src/components/public"))]
    .map((file) => ({ rel: relative(root, file), src: readFileSync(file, "utf8") }))
    .flatMap(({ rel, src }) => (src.match(FULL_PAGE_CARD) ?? []).filter(isCard).map((cls) => ({ rel, cls })));

  it("finds the cards it is meant to find (the pattern still matches the allowed ones)", () => {
    const seen = new Set(offenders.map((o) => o.rel));
    expect(seen.has("src/app/e/error.tsx")).toBe(true);
    expect(seen.has("src/app/e/[slug]/complete-registration/page.tsx")).toBe(true);
  });

  it("every other page shows its message through PublicEventNotice", () => {
    const unexpected = offenders.filter((o) => !(o.rel in ALLOWED));
    expect(unexpected, "render the message with <PublicEventNotice> so it keeps the event's banner and footer").toEqual([]);
  });

  it("allows each exception exactly one card", () => {
    for (const rel of ["src/app/e/error.tsx", "src/app/e/[slug]/complete-registration/page.tsx"]) {
      expect(offenders.filter((o) => o.rel === rel)).toHaveLength(1);
    }
  });
});
