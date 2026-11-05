import { describe, expect, it } from "vitest";
import { exitLinkField, isHttpsLink, readOrgWebsite, resolveWebinarExitLink } from "@/lib/webinar-exit-link";

describe("webinar exit link (Nov 5, 2026)", () => {
  it("accepts only absolute https addresses", () => {
    expect(isHttpsLink("https://www.meetingmindsgroup.com")).toBe(true);
    expect(isHttpsLink("http://example.com")).toBe(false);
    expect(isHttpsLink("javascript:alert(1)")).toBe(false);
    expect(isHttpsLink("/uploads/x.png")).toBe(false);
    expect(isHttpsLink("www.example.com")).toBe(false);
    expect(isHttpsLink(`https://a.test/${"x".repeat(600)}`)).toBe(false);
  });

  it("the settings field takes an https address or an empty string to clear", () => {
    expect(exitLinkField.safeParse("").success).toBe(true);
    expect(exitLinkField.safeParse(" https://a.test ").data).toBe("https://a.test");
    expect(exitLinkField.safeParse("http://a.test").success).toBe(false);
  });

  it("the webinar's own link, else the organisation website, else no button", () => {
    const org = { website: "https://www.org.test" };
    expect(resolveWebinarExitLink({ orgSettings: org, eventSettings: { webinar: { exitUrl: "https://s.test/x" } } })).toEqual({
      url: "https://s.test/x",
      label: "Visit s.test",
    });
    expect(resolveWebinarExitLink({ orgSettings: org, eventSettings: { webinar: { exitUrl: "" } } })).toEqual({
      url: "https://www.org.test",
      label: "Visit org.test",
    });
    expect(resolveWebinarExitLink({ orgSettings: {}, eventSettings: { webinar: {} } })).toBeNull();
    expect(resolveWebinarExitLink({ orgSettings: null, eventSettings: null })).toBeNull();
  });

  it("re-checks what is stored: a non-https value written by another path never becomes a link", () => {
    expect(readOrgWebsite({ website: "javascript:alert(1)" })).toBeNull();
    expect(
      resolveWebinarExitLink({ orgSettings: { website: "http://org.test" }, eventSettings: { webinar: { exitUrl: "data:text/html,x" } } }),
    ).toBeNull();
  });
});
