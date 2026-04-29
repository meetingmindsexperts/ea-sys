# Documentation screenshots

Playwright specs that capture screenshots for the user manual. Output lands
under `docs/screenshots/{chapter}/{name}.png` (gitignored — commit only the
PNGs you actually reference in the manual).

## Run all chapters

```bash
npm run docs:screenshots
```

Boots a dev server on **port 3100** (dedicated, won't collide with your
`npm run dev` on 3000), syncs the test DB, runs the e2e seed, then captures
every spec under this directory.

## Run a single chapter

```bash
npm run docs:screenshots -- 02-speakers.spec.ts
```

## Interactive mode (pick + run individual tests)

```bash
npm run docs:screenshots:ui
```

## Conventions

- **Viewport:** 1440×900, deviceScaleFactor 2 → 2880×1800 retina PNGs
- **Reduced motion:** on (animations freeze mid-frame for clean shots)
- **Light mode:** forced (the manual is light-only)
- **One worker:** specs share the seeded DB; parallel runs would race
- **Naming:** `{chapter}/{NN-kebab-case}.png` so manual authors can
  reference them by stable filename across re-captures

## Adding a new screenshot

1. Pick the chapter (or add a new spec file `09-foo.spec.ts`)
2. Use the `snap()` helper:

```ts
import { snap, maskVolatile } from "./_helpers";

test("new screen", async ({ page }) => {
  await loginAs(page, "ADMIN");
  await page.goto("/some/route");
  await page.waitForLoadState("networkidle");
  await snap(page, {
    chapter: "02-speakers",
    name: "07-new-feature",
    mask: maskVolatile(page),  // hide timestamps
  });
});
```

3. Cropping to a single element (instead of full-page):

```ts
const sheet = page.getByRole("dialog");
await snap(page, { chapter: "02-speakers", name: "08-detail-sheet", target: sheet });
```

## Refresh cadence

Run after any UI change that touches a documented screen. The manual
references stable filenames, so re-running re-captures the same set.

If a spec fails, the dev server probably hasn't compiled the route yet —
the first run after a change can be slow. Re-run.
