/**
 * "Faculty" is a reserved registration type name (owner, Nov 12, 2026: "dont
 * allow Faculty reg type and mention it is reserved"). One rule,
 * `reservedTypeNameRefusal`, and every door that creates or renames an
 * ordinary type must ask it: a door that forgets is how an event gets a
 * delegate type called "Faculty" beside the system's own.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { reservedTypeNameRefusal } from "@/lib/faculty-filter";
import { defaultRegistrationTypesSchema, readDefaultRegistrationTypes } from "@/lib/default-registration-types";

describe("reservedTypeNameRefusal", () => {
  it.each(["Faculty", "faculty", "FACULTY", "  Faculty  "])("refuses %j and says it is reserved", (name) => {
    const message = reservedTypeNameRefusal(name);
    expect(message).toContain("reserved name");
    expect(message).toContain("Speakers page");
    expect(message).not.toContain("—");
  });

  it.each(["Faculty (CME)", "Faculty.", "Speaker", "Physician", "", null, undefined])("allows %j", (name) => {
    expect(reservedTypeNameRefusal(name)).toBeNull();
  });
});

describe("the organisation's starting list", () => {
  it("cannot be saved with the reserved name", () => {
    const parsed = defaultRegistrationTypesSchema.safeParse(["Physician", "Faculty"]);
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toContain("reserved name");
  });

  it("a list saved before the rule still seeds its other names", () => {
    expect(readDefaultRegistrationTypes({ defaultRegistrationTypes: ["Physician", "Faculty", "Nurse"] })).toEqual(["Physician", "Nurse"]);
  });
});

describe("every door that creates or renames a registration type asks the rule", () => {
  const DOORS = [
    "src/app/api/events/[eventId]/tickets/route.ts",
    "src/app/api/events/[eventId]/tickets/[ticketId]/route.ts",
    "src/app/api/events/[eventId]/import/registrations/route.ts",
    "src/app/api/events/[eventId]/clone/route.ts",
    "src/lib/agent/tools/registrations.ts",
    "src/lib/default-registration-types.ts",
  ];
  it.each(DOORS)("%s", (file) => {
    expect(readFileSync(join(process.cwd(), file), "utf8")).toContain("reservedTypeNameRefusal(");
  });
});
