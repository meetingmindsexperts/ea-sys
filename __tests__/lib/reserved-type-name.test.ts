/**
 * "Faculty" is a reserved registration type name (owner, Nov 12, 2026: "dont
 * allow Faculty reg type and mention it is reserved"). One rule,
 * `reservedTypeNameRefusal`, and every door that creates or renames an
 * ordinary type must ask it: a door that forgets is how an event gets a
 * delegate type called "Faculty" beside the system's own.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
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

  // Files that make a type and are deliberately NOT doors, each with why.
  const EXEMPT: Record<string, string> = {
    "src/lib/speaker-companion.ts": "makes the built-in Faculty type itself",
    "src/services/event-service.ts": "seeds from readDefaultRegistrationTypes, which drops the reserved name",
  };

  function sourceFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return sourceFiles(path);
      return /\.tsx?$/.test(entry.name) ? [path] : [];
    });
  }

  it("no other file under src/ or worker/ creates a registration type", () => {
    const creators = ["src", "worker"]
      .flatMap((root) => sourceFiles(join(process.cwd(), root)))
      .filter((path) => /ticketType\.(create|createMany|upsert)\(/.test(readFileSync(path, "utf8")))
      .map((path) => relative(process.cwd(), path).split("\\").join("/"))
      .sort();
    const known = [...DOORS.filter((d) => d !== "src/app/api/events/[eventId]/tickets/[ticketId]/route.ts" && d !== "src/lib/default-registration-types.ts"), ...Object.keys(EXEMPT)].sort();
    // A new file here must ask reservedTypeNameRefusal and join DOORS, or be exempt with a reason.
    expect(creators).toEqual(known);
  });
});
