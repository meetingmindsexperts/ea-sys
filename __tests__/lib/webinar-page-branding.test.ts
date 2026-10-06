import { describe, it, expect } from "vitest";
import { readWebinarPageBranding } from "@/lib/webinar";
import { collectPanelists } from "@/components/webinar/panelists-card";

describe("readWebinarPageBranding", () => {
  it("reads the three attendee-page images", () => {
    expect(
      readWebinarPageBranding({
        webinar: { pageLogoUrl: "/uploads/l.png", pageBackgroundUrl: "/uploads/b.jpg", pageFooterImageUrl: "https://x/f.png" },
      }),
    ).toEqual({ logoUrl: "/uploads/l.png", backgroundUrl: "/uploads/b.jpg", footerImageUrl: "https://x/f.png" });
  });

  it("drops anything that is not an upload or https URL (written by a path without the route's validation)", () => {
    expect(
      readWebinarPageBranding({
        webinar: { pageLogoUrl: "http://tracker.example/p.gif", pageBackgroundUrl: "data:image/png;base64,AAAA", pageFooterImageUrl: 42 },
      }),
    ).toEqual({ logoUrl: null, backgroundUrl: null, footerImageUrl: null });
  });

  it("treats a cleared upload (empty string) and missing settings as none", () => {
    expect(readWebinarPageBranding({ webinar: { pageLogoUrl: "" } })).toEqual({ logoUrl: null, backgroundUrl: null, footerImageUrl: null });
    expect(readWebinarPageBranding(null)).toEqual({ logoUrl: null, backgroundUrl: null, footerImageUrl: null });
  });
});

describe("collectPanelists", () => {
  const sp = (id: string, role?: string) => ({ id, firstName: id, lastName: "X", role });
  it("lists session speakers first, then topic speakers not already listed", () => {
    const out = collectPanelists({
      speakers: [sp("a", "MODERATOR"), sp("b")],
      topics: [{ speakers: [sp("b"), sp("c")] }, { speakers: [sp("c"), sp("d")] }],
    });
    expect(out.map((p) => p.id)).toEqual(["a", "b", "c", "d"]);
    expect(out[0].role).toBe("MODERATOR");
  });
});
