import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { PublicEventBrandingProvider } from "@/components/public/event-branding-context";
import { PublicEventNotice, type PublicEventNoticeProps } from "@/components/public/event-notice";
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
    createElement(PublicEventBrandingProvider, { branding }, createElement(PublicEventNotice, props)),
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
   * How many full-height elements each public file has today, counted in the
   * raw source (a className string, `cn(...)`, a template literal and a
   * comment all count, so no way of writing one hides it).
   *
   * Every one of these is a loading spinner, the page's own working frame, or
   * the notice itself. The two that are neither: `src/app/e/error.tsx` is the
   * boundary ABOVE the [slug] layout, where the branding is out of reach, and
   * one of complete-registration's four is TabletHandBack, the desk tablet's
   * own "registration complete" screen.
   *
   * A count that changes fails this test. Adding a spinner or a new page
   * frame: raise the number. Adding a full-page MESSAGE (not found, closed,
   * a dead link): do not, render it with <PublicEventNotice> so it keeps the
   * event's banner and footer. The first version of this sweep matched only a
   * padded, centred `className="..."` and missed three of the shapes the same
   * commit had just converted (review of 73355f9e).
   */
  const FULL_HEIGHT_ELEMENTS: Record<string, number> = {
    "src/app/e/[slug]/agenda/page.tsx": 2,
    "src/app/e/[slug]/complete-registration/page.tsx": 4,
    "src/app/e/[slug]/confirmation/page.tsx": 2,
    "src/app/e/[slug]/floor-plan/[token]/page.tsx": 1,
    "src/app/e/[slug]/forgot-password/page.tsx": 3,
    "src/app/e/[slug]/group/register/group-register-content.tsx": 3,
    "src/app/e/[slug]/login/page.tsx": 3,
    "src/app/e/[slug]/my-group/page.tsx": 2,
    "src/app/e/[slug]/my-registration/page.tsx": 2,
    "src/app/e/[slug]/page.tsx": 1,
    "src/app/e/[slug]/presenter-agreement/page.tsx": 3,
    "src/app/e/[slug]/register/[category]/page.tsx": 3,
    "src/app/e/[slug]/register/page.tsx": 4,
    "src/app/e/[slug]/reimbursement/[token]/page.tsx": 2,
    "src/app/e/[slug]/reset-password/page.tsx": 3,
    "src/app/e/[slug]/rsvp/[token]/page.tsx": 3,
    "src/app/e/[slug]/session/[sessionId]/page.tsx": 3,
    "src/app/e/[slug]/shared/[token]/page.tsx": 1,
    "src/app/e/[slug]/speaker-agreement/page.tsx": 3,
    "src/app/e/[slug]/speaker-form/[token]/page.tsx": 2,
    "src/app/e/[slug]/survey/page.tsx": 3,
    "src/app/e/[slug]/travel-grant/[token]/page.tsx": 2,
    "src/app/e/[slug]/verify-details/page.tsx": 3,
    "src/app/e/error.tsx": 1,
    "src/components/public/event-notice.tsx": 2,
    "src/components/public/exhibitor-floor-plan.tsx": 1,
    "src/components/public/shared-view/shell.tsx": 1,
    "src/components/public/submitter-register.tsx": 2,
  };

  const FULL_HEIGHT = /(?<![\w-])(?:min-h-screen|h-screen|min-h-dvh|h-dvh|min-h-svh|h-svh)(?![\w-])/g;

  const counted: Record<string, number> = {};
  for (const file of [...walk(join(root, "src/app/e")), ...walk(join(root, "src/components/public"))]) {
    const n = (readFileSync(file, "utf8").match(FULL_HEIGHT) ?? []).length;
    if (n > 0) counted[relative(root, file)] = n;
  }

  it("each public file has exactly the full-height elements it had", () => {
    expect(counted, "a new full-page message belongs in <PublicEventNotice>; see the comment above the table").toEqual(
      FULL_HEIGHT_ELEMENTS,
    );
  });

  it("counts every way of writing one", () => {
    const sample = [
      '<div className="min-h-screen flex">',
      'className={cn("min-h-screen", wide && "p-4")}',
      "className={`h-screen ${x}`}",
      '<main className="min-h-dvh">',
    ].join("\n");
    expect(sample.match(FULL_HEIGHT)).toHaveLength(4);
    // Not a full-height element: a longer class that merely contains the words.
    expect("max-h-screen-safe my-min-h-screen".match(FULL_HEIGHT)).toBeNull();
  });
});
