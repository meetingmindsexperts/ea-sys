/**
 * A promo code typed on the public form and never applied is checked before
 * the registration is sent, never dropped (owner, Nov 16, 2026), and a check
 * that could not be made never costs someone their code (review of 73ef6416).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it, expect, vi } from "vitest";
import { promoStopMessages, resolveSubmitPromo, unappliedPromoCode, type PromoCheckOutcome } from "@/lib/promo-entry";

type Answer = { valid: boolean; code?: string; coveredBySponsor?: string | null; error?: string };
const accepted = (code: string): Answer => ({ valid: true, code });

describe("unappliedPromoCode", () => {
  it("a code typed and never checked is returned, trimmed", () => {
    expect(unappliedPromoCode("GCCHH26SEHA", true, null)).toBe("GCCHH26SEHA");
    expect(unappliedPromoCode("  SEHA ", true, null)).toBe("SEHA");
  });

  it("a code the check refused is still unapplied: it is checked again, not dropped", () => {
    expect(unappliedPromoCode("WRONG", true, { valid: false })).toBe("WRONG");
  });

  it("a code the check accepted needs nothing more, whatever its case", () => {
    expect(unappliedPromoCode("SEHA", true, accepted("SEHA"))).toBeNull();
    expect(unappliedPromoCode("seha ", true, accepted("SEHA"))).toBeNull();
  });

  it("an acceptance of a DIFFERENT code does not cover what is in the field", () => {
    // Typed on while SEHA's check was in flight: the field reads SEHA26.
    expect(unappliedPromoCode("SEHA26", true, accepted("SEHA"))).toBe("SEHA26");
    expect(unappliedPromoCode("SEHA26", true, { valid: true })).toBe("SEHA26");
  });

  it("an empty field is nothing to check", () => {
    expect(unappliedPromoCode("", true, null)).toBeNull();
    expect(unappliedPromoCode("   ", true, { valid: false })).toBeNull();
  });

  it("a field the form is not showing never blocks a submit the person cannot correct", () => {
    expect(unappliedPromoCode("LINKED", false, null)).toBeNull();
    expect(unappliedPromoCode("LINKED", false, { valid: false })).toBeNull();
  });
});

describe("resolveSubmitPromo", () => {
  const answered = (result: Answer): PromoCheckOutcome<Answer> => ({ kind: "answered", result });
  const never = vi.fn(async (): Promise<PromoCheckOutcome<Answer>> => {
    throw new Error("the check must not run");
  });

  it("no code: sends without one and checks nothing", async () => {
    expect(await resolveSubmitPromo({ typed: "", fieldShown: true, result: null, check: never })).toEqual({
      action: "send",
      code: undefined,
      result: null,
      judged: true,
    });
    expect(never).not.toHaveBeenCalled();
  });

  it("a code Apply already accepted: sent as it is, not checked again", async () => {
    const result = accepted("SEHA");
    expect(await resolveSubmitPromo({ typed: "SEHA", fieldShown: true, result, check: never })).toEqual({
      action: "send",
      code: "SEHA",
      result,
      judged: true,
    });
    expect(never).not.toHaveBeenCalled();
  });

  it("a typed code the server accepts rides the registration, with the server's answer", async () => {
    const result: Answer = { valid: true, code: "GCCHH26SEHA", coveredBySponsor: "SEHA" };
    const check = vi.fn(async () => answered(result));
    expect(await resolveSubmitPromo({ typed: " gcchh26seha ", fieldShown: true, result: null, check })).toEqual({
      action: "send",
      code: "GCCHH26SEHA",
      result,
      judged: true,
    });
    expect(check).toHaveBeenCalledWith("gcchh26seha");
  });

  it("a typed code the server refuses stops the submit", async () => {
    const result: Answer = { valid: false, error: "Promo code usage limit reached" };
    const out = await resolveSubmitPromo({ typed: "SEHA", fieldShown: true, result: null, check: async () => answered(result) });
    expect(out).toEqual({ action: "stop", code: "SEHA", result });
  });

  it("a refusal Apply already showed is checked again and still stops: the code is never dropped", async () => {
    const check = vi.fn(async () => answered({ valid: false }));
    const out = await resolveSubmitPromo({ typed: "WRONG", fieldShown: true, result: { valid: false }, check });
    expect(out.action).toBe("stop");
    expect(check).toHaveBeenCalledTimes(1);
  });

  it("a check that could not be made sends the typed code for the register route to judge", async () => {
    // Rate limited, offline, a server error, or overtaken by a newer check.
    const out = await resolveSubmitPromo({
      typed: "GCCHH26SEHA",
      fieldShown: true,
      result: { valid: false, error: "We could not check that code just now." },
      check: async () => ({ kind: "unchecked" }),
    });
    expect(out).toEqual({ action: "send", code: "GCCHH26SEHA", result: null, judged: false });
  });

  it("an answer for another code is not sent in place of what the person typed", async () => {
    const check = vi.fn(async () => answered(accepted("SEHA26")));
    const out = await resolveSubmitPromo({ typed: "SEHA26", fieldShown: true, result: accepted("SEHA"), check });
    expect(out).toMatchObject({ action: "send", code: "SEHA26" });
    expect(check).toHaveBeenCalledWith("SEHA26");
  });

  it("a hidden field checks nothing: an accepted answer is sent, anything else is not", async () => {
    const result = accepted("LINKED");
    expect(await resolveSubmitPromo({ typed: "LINKED", fieldShown: false, result, check: never })).toMatchObject({
      action: "send",
      code: "LINKED",
    });
    expect(await resolveSubmitPromo({ typed: "LINKED", fieldShown: false, result: { valid: false }, check: never })).toEqual({
      action: "send",
      code: undefined,
      result: null,
      judged: true,
    });
    expect(never).not.toHaveBeenCalled();
  });
});

describe("promoStopMessages", () => {
  it("an ordinary form offers to register without the code", () => {
    const words = promoStopMessages("SEHA", false);
    expect(words.toast).toContain("SEHA");
    expect(words.toast).toContain("clear the field");
    expect(words.notice).toContain("clear the field");
  });

  it("a sponsor link never offers it: that link cannot be registered without a code", () => {
    const words = promoStopMessages("SEHA", true);
    expect(words.toast).toContain("SEHA");
    expect(`${words.toast} ${words.notice}`).not.toMatch(/clear the field|without/i);
  });
});

const strip = (source: string) => source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
const read = (rel: string) => strip(readFileSync(path.resolve(__dirname, "../..", rel), "utf8"));

describe("the public registration form asks the rule", () => {
  const code = read("src/app/e/[slug]/register/[category]/page.tsx");
  const submit = code.slice(code.indexOf("async function onSubmit("), code.indexOf("async function applyPromo("));

  it("resolves the promo code before it sends the registration, and a stop returns", () => {
    const resolve = submit.indexOf("await resolveSubmitPromo({");
    const stop = submit.indexOf('if (submitPromo.action === "stop") {');
    const send = submit.indexOf("/register`");
    expect(resolve).toBeGreaterThan(-1);
    expect(stop).toBeGreaterThan(resolve);
    expect(send).toBeGreaterThan(stop);
    // The stop branch leaves the handler: nothing between it and its return sends.
    const branch = submit.slice(stop, submit.indexOf("const appliedPromo = submitPromo.result"));
    expect(branch).toMatch(/return;\s*}\s*$/);
    expect(branch).not.toContain("fetch(");
  });

  it("gives the rule the field's text, whether the field is on the page, and the last answer", () => {
    expect(submit).toMatch(/typed: promoCode,\s*fieldShown: promoFieldShown,\s*result: promoResult,/);
    expect(submit).toContain("return await applyPromo(code);");
  });

  it("sends the code the rule returned, never one read from the form's state", () => {
    expect(submit).toContain("promoCode: submitPromo.code,");
    expect(submit).not.toMatch(/promoCode: (promoResult|appliedPromo)/);
  });

  it("a sponsor link's own refusal waits for a code somebody judged", () => {
    expect(submit).toContain("if (sponsorCodeRequired && submitPromo.judged && !(appliedPromo?.valid && appliedPromo.coveredBySponsor)) {");
  });

  it("the check reports a failed request as unchecked, never as a refused code", () => {
    const check = code.slice(code.indexOf("async function applyPromo("), code.indexOf("const linkedPromo"));
    expect(check).toContain("const data = res.ok ? ((await res.json()) as PromoResult) : null;");
    expect(check).toMatch(/if \(!data\) \{[\s\S]*?return UNCHECKED;/);
    expect(check).toMatch(/catch \(err\) \{[\s\S]*?return UNCHECKED;/);
    expect(check).toContain('return { kind: "answered", result: data };');
  });

  it("the field the submit reads is the field the page renders, and a link's code is offered it", () => {
    expect(code).toContain("{promoBlockOffered && (");
    expect(code).toContain("{!promoFieldShown ? (");
    expect(code).toMatch(/const promoBlockOffered =[\s\S]{0,200}\|\| !!linkedPromo\);/);
    expect(code).toContain("const promoFieldShown = promoBlockOffered && (showPromoInput || sponsorCodeRequired);");
  });

  it("Enter in the code field applies the code instead of submitting the form", () => {
    const field = code.slice(code.indexOf('placeholder="Enter promo code"'));
    const handler = field.slice(field.indexOf("onKeyDown={"), field.indexOf("className="));
    expect(handler).toMatch(/if \(e\.key !== "Enter"\) return;\s*if \(e\.nativeEvent\.isComposing \|\| e\.keyCode === 229\) return;\s*e\.preventDefault\(\);/);
    expect(handler).toContain("void applyPromo(promoCode)");
  });
});

describe("the code check answers for the events the register route takes", () => {
  it("both look the event up by the same statuses, slug or id", () => {
    const where = 'allowIdFallback: true, statuses: ["PUBLISHED", "LIVE"]';
    const validate = read("src/app/api/public/events/[slug]/validate-promo/route.ts").replace(/\s+/g, " ");
    const register = read("src/app/api/public/events/[slug]/register/route.ts").replace(/\s+/g, " ").replace(/,\s*}/g, " }");
    expect(validate).toContain(where);
    expect(register).toContain(where);
    expect(validate).toContain('msg: "public/validate-promo:event-not-found"');
  });
});
