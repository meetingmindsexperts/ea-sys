/**
 * The abstract form's co-author handling (Nov 10, 2026, production warnings).
 *
 * The new and edit pages sent every co-author row as typed. A blank row, a row
 * with one name, or an organization past 255 characters made the server's
 * schema refuse the whole abstract with only "Invalid input". Now the inputs
 * carry the schema's own limits, blank rows are dropped, a half-filled row is
 * named before anything is sent, and a 400 shows its first field error.
 *
 * MUTATION TO VERIFY AGAINST: make prepareCoAuthorsForSubmit return every row
 * unchanged and the blank-row and one-name cases fail.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CO_AUTHOR_MAX_LENGTH,
  EMPTY_CO_AUTHOR,
  abstractErrorMessage,
  coAuthorSchema,
  coAuthorsSchema,
  prepareCoAuthorsForSubmit,
} from "@/lib/abstract-coauthors";

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");
const ABSTRACTS = "src/app/(dashboard)/events/[eventId]/abstracts";

describe("CO_AUTHOR_MAX_LENGTH", () => {
  it("is the limit the schema enforces, field by field", () => {
    const base = { firstName: "Jane", lastName: "Doe" };
    for (const [field, max] of Object.entries(CO_AUTHOR_MAX_LENGTH)) {
      expect(coAuthorSchema.safeParse({ ...base, [field]: "a".repeat(max) }).success, field).toBe(true);
      expect(coAuthorSchema.safeParse({ ...base, [field]: "a".repeat(max + 1) }).success, field).toBe(false);
    }
  });

  it("is what the form's text inputs use as maxLength", () => {
    const src = read("src/components/abstracts/co-author-fields.tsx");
    for (const field of ["firstName", "lastName", "jobTitle", "organization"]) {
      expect(src).toContain(`maxLength={CO_AUTHOR_MAX_LENGTH.${field}}`);
    }
  });
});

describe("prepareCoAuthorsForSubmit", () => {
  it("drops fully blank rows and keeps the rest, in a shape the server accepts", () => {
    const res = prepareCoAuthorsForSubmit([
      { ...EMPTY_CO_AUTHOR },
      { firstName: " Jane ", lastName: "Doe", jobTitle: "", organization: "Clinic", country: "" },
      { firstName: "  ", lastName: "", jobTitle: " ", organization: "", country: "" },
    ]);
    expect(res).toEqual({
      ok: true,
      coAuthors: [{ firstName: "Jane", lastName: "Doe", jobTitle: undefined, organization: "Clinic", country: undefined }],
    });
    expect(coAuthorsSchema.safeParse(res.ok ? res.coAuthors : null).success).toBe(true);
  });

  it("stops on a row with only one name, numbered as the form shows it", () => {
    const res = prepareCoAuthorsForSubmit([
      { ...EMPTY_CO_AUTHOR },
      { ...EMPTY_CO_AUTHOR, firstName: "Jane" },
    ]);
    expect(res).toEqual({ ok: false, message: "Co-author 2 needs both a first name and a last name" });
    expect(prepareCoAuthorsForSubmit([{ ...EMPTY_CO_AUTHOR, lastName: "Doe" }]).ok).toBe(false);
  });

  it("stops on a row with details but no name, instead of dropping what was typed", () => {
    const res = prepareCoAuthorsForSubmit([{ ...EMPTY_CO_AUTHOR, organization: "Clinic" }]);
    expect(res).toEqual({ ok: false, message: "Co-author 1 needs both a first name and a last name" });
  });

  it("accepts no rows", () => {
    expect(prepareCoAuthorsForSubmit([])).toEqual({ ok: true, coAuthors: [] });
  });
});

describe("abstractErrorMessage", () => {
  it("shows the first field error of a validation 400, with its field", () => {
    const body = {
      error: "Invalid input",
      details: { formErrors: [], fieldErrors: { coAuthors: ["Too big", "second"], title: ["Required"] } },
    };
    expect(abstractErrorMessage(body, "Failed")).toBe("Co-authors: Too big");
  });

  it("names a field it has no label for by its key", () => {
    expect(abstractErrorMessage({ error: "Invalid input", details: { fieldErrors: { status: ["Bad"] } } }, "Failed")).toBe("status: Bad");
  });

  it("keeps the server's message when there are no field errors", () => {
    expect(abstractErrorMessage({ error: "Abstract not found" }, "Failed")).toBe("Abstract not found");
    expect(abstractErrorMessage({ error: "Invalid input", details: { fieldErrors: {} } }, "Failed")).toBe("Invalid input");
    expect(abstractErrorMessage({ error: "Invalid input", details: { fieldErrors: { title: [] } } }, "Failed")).toBe("Invalid input");
  });

  it("falls back when the body is not usable", () => {
    expect(abstractErrorMessage({}, "Failed")).toBe("Failed");
    expect(abstractErrorMessage(null, "Failed")).toBe("Failed");
  });
});

describe("the two abstract forms", () => {
  const pages = [`${ABSTRACTS}/new/page.tsx`, `${ABSTRACTS}/[abstractId]/edit/page.tsx`];

  it("check co-authors before sending and read the field error from a 400", () => {
    for (const page of pages) {
      const src = read(page);
      expect(src, page).toContain("prepareCoAuthorsForSubmit(");
      expect(src, page).toContain("coAuthors: coAuthorCheck.coAuthors");
      expect(src, page).toContain("abstractErrorMessage(err,");
    }
  });

  it("edit page: every save goes through the co-author check", () => {
    const src = read(pages[1]);
    expect(src.match(/updateMutation\.mutate\(/g)).toHaveLength(1);
  });

  it("edit page: Delete Draft is offered only with abstracts.delete, and its failure shows the server's message", () => {
    const src = read(pages[1]);
    expect(src).toContain('useCan("abstracts.delete", eventId) === "allowed"');
    expect(src).toContain('status === "DRAFT" && canDeleteAbstracts && (');
    expect(src).not.toContain('onError: () => toast.error("Failed to delete abstract")');
    expect(src).toContain('throw new Error(err.error || "Failed to delete abstract")');
  });
});
