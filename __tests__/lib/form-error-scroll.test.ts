/**
 * The public forms' "take me to what I missed" helper (Oct 26, 2026). The
 * suite runs without a DOM, so the page is a few stand-in elements with the
 * methods the helper calls; the real pages are checked in a browser.
 */
import { describe, it, expect, vi, beforeAll } from "vitest";

// The helper compares a field with the screen height.
beforeAll(() => {
  vi.stubGlobal("window", { innerHeight: 700 });
});
import { missingFieldsNotice, scrollToFirstFormError } from "@/lib/form-error-scroll";

type Fake = {
  textContent: string;
  attrs: Record<string, string>;
  visible: boolean;
  item?: { label: string; height?: number; scrollIntoView: ReturnType<typeof vi.fn> };
  scrollIntoView: ReturnType<typeof vi.fn>;
};

function message(text: string, opts: { label?: string; own?: string; visible?: boolean; height?: number } = {}): Fake {
  return {
    textContent: text,
    attrs: opts.own ? { "data-form-error": opts.own } : {},
    visible: opts.visible ?? true,
    item: opts.label ? { label: opts.label, height: opts.height, scrollIntoView: vi.fn() } : undefined,
    scrollIntoView: vi.fn(),
  };
}

function page(messages: Fake[]) {
  const asEl = (m: Fake) => ({
    textContent: m.textContent,
    getAttribute: (k: string) => m.attrs[k] ?? null,
    getClientRects: () => (m.visible ? [{}] : []),
    scrollIntoView: m.scrollIntoView,
    closest: () =>
      m.item
        ? {
            scrollIntoView: m.item.scrollIntoView,
            querySelector: () => ({ textContent: m.item!.label }),
            getBoundingClientRect: () => ({ height: m.item!.height ?? 80 }),
          }
        : null,
  });
  return { querySelectorAll: () => messages.map(asEl) } as unknown as ParentNode;
}

describe("scrollToFirstFormError", () => {
  it("scrolls the FIRST visible error's field into the middle and names every missing field", () => {
    const title = message("Title is required", { label: "Title *" });
    const country = message("Country is required", { label: "Country *" });
    const names = scrollToFirstFormError(page([title, country]));
    expect(title.item!.scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "center" });
    expect(country.item!.scrollIntoView).not.toHaveBeenCalled();
    expect(names).toEqual(["Title", "Country"]);
  });

  it("a field taller than the screen scrolls its MESSAGE into view, not the whole field", () => {
    const tall = message("Please choose a registration type", { label: "Registration type", height: 1200 });
    scrollToFirstFormError(page([tall]));
    expect(tall.scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "center" });
    expect(tall.item!.scrollIntoView).not.toHaveBeenCalled();
  });

  it("an error set outside a form field (the registration type) names itself", () => {
    const type = message("Please choose a registration type", { own: "Registration type" });
    expect(scrollToFirstFormError(page([type]))).toEqual(["Registration type"]);
    expect(type.scrollIntoView).toHaveBeenCalled();
  });

  it("skips empty and hidden messages, and does nothing when there are none", () => {
    const empty = message("", { label: "City" });
    const hidden = message("Hidden", { label: "Hidden", visible: false });
    expect(scrollToFirstFormError(page([empty, hidden]))).toEqual([]);
    expect(empty.item!.scrollIntoView).not.toHaveBeenCalled();
  });
});

describe("missingFieldsNotice", () => {
  it("names up to three fields, then counts the rest", () => {
    expect(missingFieldsNotice(["Country"])).toBe("Please fill in: Country");
    expect(missingFieldsNotice(["Title", "Country", "Role"])).toBe("Please fill in: Title, Country, Role");
    expect(missingFieldsNotice(["Title", "Country", "Role", "City", "Phone"])).toBe("Please fill in: Title, Country, Role and 2 more");
  });

  it("falls back to a general line when no field could be named", () => {
    expect(missingFieldsNotice([])).toBe("Please check the highlighted fields.");
  });
});
