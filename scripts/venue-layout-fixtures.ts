/**
 * Writes generated venue layouts for the venue's own browser tests
 * (vendor/ehc-venue/tests/test_layout.py): every template plus the edge cases
 * the generator must handle. Run after any change to src/lib/venue/layout.ts:
 *
 *   npm run venue:fixtures
 *
 * __tests__/lib/venue-layout-fixtures.test.ts fails while these are stale.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { LAYOUT_FIXTURES } from "../src/lib/venue/layout-fixtures";
import { generateLayout } from "../src/lib/venue/layout";

const dir = path.join(process.cwd(), "vendor/ehc-venue/tests/fixtures/layouts");
mkdirSync(dir, { recursive: true });
for (const [name, rooms] of Object.entries(LAYOUT_FIXTURES)) {
  writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(generateLayout(rooms, { eventName: "Test Congress 2027" })) + "\n");
  console.log(`${name}: ${rooms.length} rooms`);
}
