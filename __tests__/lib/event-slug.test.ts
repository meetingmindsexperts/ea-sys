/**
 * An event's web address (Nov 16, 2026): the Settings box saved a pasted name,
 * "Improving Outcomes in β-Thalassemia", and every link to the webinar broke.
 */
import { describe, it, expect } from "vitest";
import {
  cleanEventSlugInput,
  eventSlugFromName,
  isValidEventSlug,
  normalizeEventSlug,
  toAsciiLetters,
} from "@/lib/event-slug";
import { slugify } from "@/lib/utils";

describe("toAsciiLetters", () => {
  it("spells Greek letters out in English and keeps an upper-case one capitalised", () => {
    expect(toAsciiLetters("β-Thalassemia")).toBe("beta-Thalassemia");
    expect(toAsciiLetters("TNF-α and IL-6")).toBe("TNF-alpha and IL-6");
    expect(toAsciiLetters("Δ")).toBe("Delta");
    expect(toAsciiLetters("ς σ")).toBe("sigma sigma");
  });

  it("removes accents, including on Greek letters, and expands a few Latin letters", () => {
    expect(toAsciiLetters("Café Ménière")).toBe("Cafe Meniere");
    expect(toAsciiLetters("ά")).toBe("alpha");
    expect(toAsciiLetters("Straße Ærø")).toBe("Strasse AEro");
  });

  it("the micro sign is mu", () => {
    expect(toAsciiLetters("5 µg")).toBe("5 mug");
  });
});

describe("the slug box", () => {
  it("cleans as you type without trimming, so a hyphen can be typed", () => {
    expect(cleanEventSlugInput("heart ")).toBe("heart-");
    expect(cleanEventSlugInput("heart-")).toBe("heart-");
    expect(cleanEventSlugInput("a  b__c")).toBe("a-b-c");
    expect(cleanEventSlugInput("Q&A: 2026!")).toBe("QA-2026");
  });

  it("finishes the slug: no hyphen at either end, case kept as typed", () => {
    expect(normalizeEventSlug(" Improving Outcomes in β-Thalassemia ")).toBe("Improving-Outcomes-in-beta-Thalassemia");
    expect(normalizeEventSlug("MEHF2027")).toBe("MEHF2027");
    expect(normalizeEventSlug("--x--")).toBe("x");
    expect(normalizeEventSlug("مؤتمر")).toBe("");
    expect(normalizeEventSlug("a".repeat(250)).length).toBe(200);
  });

  it("one made from the name is lower case", () => {
    expect(eventSlugFromName("Improving Outcomes in β-Thalassemia")).toBe("improving-outcomes-in-beta-thalassemia");
    expect(eventSlugFromName("AβTC 2026")).toBe("abetatc-2026");
  });

  it("tells a broken saved slug from a good one", () => {
    expect(isValidEventSlug("Improving Outcomes in β-Thalassemia")).toBe(false);
    expect(isValidEventSlug("AβTC2026")).toBe(false);
    expect(isValidEventSlug("MEHF2027")).toBe(true);
    expect(isValidEventSlug("mm2026-w3")).toBe(true);
    expect(isValidEventSlug("x")).toBe(false);
  });
});

describe("slugify (event creation) spells Greek out instead of dropping it", () => {
  it("β-Thalassemia keeps its beta", () => {
    expect(slugify("Improving Outcomes in β-Thalassemia")).toBe("improving-outcomes-in-beta-thalassemia");
  });

  it("plain names are unchanged", () => {
    expect(slugify("Heart Failure Forum 2026")).toBe("heart-failure-forum-2026");
  });
});
