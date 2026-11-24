/**
 * The confirmation page wears the sign-in pages' frame (owner, Nov 24, 2026:
 * "put logo on verify-email"). It stood alone with no logo, so someone arriving
 * from an email could not tell whose page it was.
 *
 * Source pins (the unit suite has no browser document); run for real in a
 * browser the same day.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
const shell = read("src/components/auth/portal-auth-shell.tsx");
const signInLayout = read("src/app/(auth)/layout.tsx");
const confirmLayout = read("src/app/verify-email/layout.tsx");
const confirmPage = read("src/app/verify-email/page.tsx");

describe("the frame around the signed-out account pages", () => {
  it.each([
    ["the sign-in pages", signInLayout],
    ["the confirmation page", confirmLayout],
  ])("%s wear the one shared frame, and build none of it themselves", (_name, layout) => {
    expect(layout).toContain("<PortalAuthShell>{children}</PortalAuthShell>");
    expect(layout).not.toContain("<AuthShell");
    expect(layout).not.toContain("loadPublicBrandForHost");
    expect(layout).not.toContain("tagline=");
  });

  it("shows the attendee-facing brand of the address it is opened on, never a name or logo of its own", () => {
    expect(shell).toContain('loadPublicBrandForHost((await headers()).get("host"))');
    expect(shell).toContain("brand={brand}");
    // Review of 671e728e6: the logo is DRAWN in auth-shell.tsx, so that file and the page are
    // read too, with comments taken out (one names the brand to explain a past incident).
    const code = (path: string) => read(path).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    for (const path of ["src/components/auth/portal-auth-shell.tsx", "src/components/auth/auth-shell.tsx", "src/app/verify-email/page.tsx", "src/app/verify-email/layout.tsx"]) {
      expect(code(path), path).not.toMatch(/Meeting Minds|MM Group|mmg|\.(png|svg|jpe?g|webp)\b/i);
    }
    // The one image in the frame is the brand's own.
    expect(read("src/components/auth/auth-shell.tsx")).toContain("<img src={brand.logo} alt={brand.name}");
  });

  it("the confirmation page says what it is in the tab", () => {
    expect(confirmLayout).toContain('title: "Confirm your email"');
  });

  it("the confirmation page no longer draws a full screen of its own inside the frame", () => {
    expect(confirmPage).not.toContain("min-h-screen");
    expect(confirmPage).not.toContain("bg-gradient-to-b");
    expect(confirmPage).toContain('<main className="w-full max-w-md">');
  });
});
