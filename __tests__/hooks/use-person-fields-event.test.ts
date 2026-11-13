import { describe, it, expect, vi } from "vitest";

// Only the pure address rule is tested; nothing is fetched or rendered.
vi.mock("next/navigation", () => ({ usePathname: () => "/" }));
vi.mock("@/hooks/use-api", () => ({ fetchApi: vi.fn() }));

import { eventOfPage } from "@/hooks/use-person-fields";

/**
 * Which event a page belongs to, from its address (step 2 of
 * docs/ORG_FIELDS_PLAN.md, the event part). The forms on an event's pages ask
 * what THAT EVENT asks; a page this rule gets wrong would follow the
 * organisation while its route follows the event (review of 5dd9cd5f).
 */
describe("eventOfPage", () => {
  it("a public page belongs to the event its address names by slug", () => {
    expect(eventOfPage("/e/hemnet2026/register/early-bird")).toBe("hemnet2026");
    expect(eventOfPage("/e/hemnet2026")).toBe("hemnet2026");
    expect(eventOfPage("/e/hemnet2026/my-group")).toBe("hemnet2026");
  });

  it("a dashboard page belongs to the event its address names by id", () => {
    expect(eventOfPage("/events/cmn2zf2ql001ln601ffqwsliz/check-in/desk")).toBe("cmn2zf2ql001ln601ffqwsliz");
    expect(eventOfPage("/events/cmn2zf2ql001ln601ffqwsliz/my-details")).toBe("cmn2zf2ql001ln601ffqwsliz");
  });

  it("the creation page is not an event, but an event whose SLUG is \"new\" is", () => {
    expect(eventOfPage("/events/new")).toBeNull();
    expect(eventOfPage("/e/new/register")).toBe("new");
  });

  it("pages that belong to no event have none", () => {
    for (const path of ["/", "/signup", "/my-account/details", "/settings", "/events", "/contacts", "/catalogue/e/x"]) {
      expect(eventOfPage(path)).toBeNull();
    }
  });

  it("hands back the slug as it is, not as the address encodes it (the caller encodes it once)", () => {
    expect(eventOfPage("/e/caf%C3%A9%202026/register")).toBe("café 2026");
    // A segment that does not decode is passed as it is, never thrown on.
    expect(eventOfPage("/e/bad%E0%A4%A/register")).toBe("bad%E0%A4%A");
  });
});
